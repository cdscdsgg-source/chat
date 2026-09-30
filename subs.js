// 유튜브 자막 추출/생성.
// - 라이브 진행 중: 방송 시작부터 "요청한 시점"까지의 오디오 조각만 받아 음성 인식
// - 종료된 영상: 유튜브 자막(수동 한국어 > 원어 자동자막)이 있으면 그대로, 없으면 음성 인식
// 음성 인식은 Groq Whisper API(GROQ_API_KEY)를 쓰고, 키가 없으면 이 PC의 faster-whisper(whisper_local.py)로
// 대신한다. 오디오는 자막을 만든 뒤 바로 지운다.
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const BIN_DIR = path.join(os.tmpdir(), "ytsubs-bin");
const YTDLP_PATH = path.join(BIN_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const YTDLP_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/" +
  (process.platform === "win32" ? "yt-dlp.exe" : process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp_linux");
const YTDLP_MAX_AGE_MS = 24 * 3600 * 1000; // 유튜브가 자주 바뀌어서 하루마다 최신판으로 교체

const GROQ_MODEL = process.env.GROQ_MODEL || "whisper-large-v3";
const LOCAL_WHISPER_MODEL = process.env.LOCAL_WHISPER_MODEL || "small";
const WHISPER_PYTHON = process.env.WHISPER_PYTHON
  ? [process.env.WHISPER_PYTHON]
  : process.platform === "win32" ? ["py", "-3.11"] : ["python3"];
const CHUNK_SECONDS = 600;
const LIVE_MAX_SECONDS = Number(process.env.LIVE_MAX_SECONDS || 6 * 3600);
const JOB_TTL_MS = 3 * 3600 * 1000;

const jobs = new Map();

// 라이브는 같은 방송을 여러 번 요청하므로, 인식한 자막과 처리한 위치를 영상별로 저장해 두고
// 다음 요청 때는 그 뒤에 새로 방송된 부분만 인식한다.
const CACHE_DIR = path.join(__dirname, "subs-cache");

function loadLiveCache(videoId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${videoId}.json`), "utf-8"));
  } catch {
    return null;
  }
}

function saveLiveCache(videoId, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${videoId}.json`), JSON.stringify(data));
  } catch {}
}

// ---------- 도구 ----------

let ytdlpReady = null;
function ensureYtdlp() {
  if (!ytdlpReady) {
    ytdlpReady = (async () => {
      try {
        const st = fs.statSync(YTDLP_PATH);
        if (Date.now() - st.mtimeMs < YTDLP_MAX_AGE_MS) return;
      } catch {}
      fs.mkdirSync(BIN_DIR, { recursive: true });
      const res = await fetch(YTDLP_URL);
      if (!res.ok) throw new Error(`yt-dlp 다운로드 실패 (HTTP ${res.status})`);
      const tmp = `${YTDLP_PATH}.download`;
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, YTDLP_PATH);
    })().finally(() => {
      // 실패했거나 하루가 지나면 다음 요청 때 다시 확인
      setTimeout(() => (ytdlpReady = null), 60 * 1000);
    });
  }
  return ytdlpReady;
}

function run(bin, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || "");
        reject(err);
      } else resolve(String(stdout));
    });
  });
}

function cookieArgs(workDir) {
  // 유튜브가 서버 IP를 봇으로 막을 때를 대비해 cookies.txt 내용을 환경변수로 받을 수 있게 한다.
  if (!process.env.YTDLP_COOKIES) return [];
  const file = path.join(workDir, "cookies.txt");
  fs.writeFileSync(file, process.env.YTDLP_COOKIES);
  return ["--cookies", file];
}

function friendlyYtdlpError(err) {
  const msg = err.stderr || err.message || "";
  // 클라우드 서버(Render 등) IP는 유튜브가 막는다. 막힐 때 오류 문구가 여러 가지로 나온다.
  if (/confirm you.?re not a bot|Sign in to confirm|Failed to extract any player response/i.test(msg)) {
    return "유튜브가 이 서버의 접속을 막았어요. 자막 기능은 PC에서 start.bat으로 실행해서 사용해 주세요.";
  }
  if (/Private video|members-only|Join this channel/i.test(msg)) return "비공개/멤버십 영상이라 가져올 수 없어요.";
  if (/This live event will begin|Premieres in/i.test(msg)) return "아직 시작하지 않은 방송이에요.";
  if (/Video unavailable/i.test(msg)) return "영상을 찾을 수 없어요.";
  const last = msg.trim().split("\n").filter((l) => /ERROR/.test(l)).pop();
  return last ? last.replace(/^ERROR:\s*/, "") : "영상 정보를 가져오지 못했어요.";
}

// ---------- 유튜브 자막 ----------

function pickYoutubeSubs(info) {
  const manual = info.subtitles || {};
  const auto = info.automatic_captions || {};
  const json3 = (tracks) => (tracks || []).find((t) => t.ext === "json3");

  const ko = json3(manual.ko) || json3(Object.entries(manual).find(([k]) => k.startsWith("ko"))?.[1]);
  if (ko) return { kind: "유튜브 자막", url: ko.url };
  // "-orig"가 붙은 트랙이 영상 원래 언어의 자동 자막 (나머지는 기계 번역)
  const orig = Object.entries(auto).find(([k]) => k.endsWith("-orig"));
  if (orig && json3(orig[1])) return { kind: "유튜브 자동 자막", url: json3(orig[1]).url };
  // 한국어가 아닌 수동 자막만 있는 경우 (지난 라이브의 채팅 기록은 자막이 아니므로 제외)
  const other = Object.entries(manual).find(([k, t]) => k !== "live_chat" && json3(t));
  if (other) return { kind: `유튜브 자막 (${other[0]})`, url: json3(other[1]).url };
  return null;
}

async function fetchYoutubeSubs(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`자막을 가져오지 못했어요 (HTTP ${res.status})`);
  const data = await res.json();
  const segments = [];
  for (const ev of data.events || []) {
    const text = (ev.segs || []).map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    segments.push({ start, end: start + (ev.dDurationMs || 0) / 1000, text });
  }
  return segments;
}

// ---------- 오디오 ----------

// resumeSec부터 지금까지의 오디오를 받는다. 새로 방송된 부분이 없으면 { frags: 0 }.
async function downloadLiveUntilNow(info, file, job, resumeSec = 0) {
  const audio = (info.formats || []).filter((f) => f.vcodec === "none" && f.is_from_start && f.url);
  if (!audio.length) throw new Error("라이브 오디오를 찾지 못했어요.");
  // 음성 인식에는 저음질(보통 139, 48kbps)이면 충분하다
  const fmt = audio.find((f) => f.format_id === "139") || audio.sort((a, b) => (a.abr || 0) - (b.abr || 0))[0];
  const fragSec = fmt.target_duration || 1;

  const head = await fetch(fmt.url, { method: "HEAD" });
  const lastSeq = Number(head.headers.get("x-head-seqnum"));
  if (!Number.isFinite(lastSeq)) throw new Error("라이브 진행 위치를 알 수 없어요.");

  let resumeSeq = Math.floor(resumeSec / fragSec);
  let reset = false;
  if (resumeSeq > lastSeq + 1) {
    // 저장된 위치가 현재 방송보다 뒤라면 방송이 새로 시작된 것
    resumeSeq = 0;
    reset = true;
  }
  const maxFrags = Math.floor(LIVE_MAX_SECONDS / fragSec);
  const firstSeq = Math.max(resumeSeq, lastSeq + 1 - maxFrags);
  const total = lastSeq + 1 - firstSeq;
  job.offset = firstSeq * fragSec;
  if (firstSeq > resumeSeq) {
    const span = LIVE_MAX_SECONDS >= 3600 ? `${Math.round(LIVE_MAX_SECONDS / 3600)}시간` : `${Math.round(LIVE_MAX_SECONDS / 60)}분`;
    job.note = `방송이 길어서 최근 ${span} 분량만 처리해요.`;
  }
  if (total <= 0) return { frags: 0, reset };

  const fetchFrag = async (sq) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await fetch(`${fmt.url}&sq=${sq}`);
        if (r.ok) return Buffer.from(await r.arrayBuffer());
      } catch {}
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    return Buffer.alloc(0); // 한 조각이 빠져도 전체는 계속 진행
  };

  const fd = fs.openSync(file, "w");
  try {
    const BATCH = 16;
    for (let i = 0; i < total; i += BATCH) {
      const seqs = [];
      for (let sq = firstSeq + i; sq < Math.min(firstSeq + i + BATCH, lastSeq + 1); sq++) seqs.push(sq);
      for (const buf of await Promise.all(seqs.map(fetchFrag))) fs.writeSync(fd, buf);
      job.stage = `라이브 오디오 받는 중 (${Math.round((total * fragSec) / 60)}분 분량)`;
      job.progress = 0.4 * Math.min(1, (i + BATCH) / total);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { frags: total, reset };
}

async function downloadVodAudio(url, workDir, job) {
  job.stage = "영상 오디오 받는 중";
  await run(YTDLP_PATH, [
    ...cookieArgs(workDir),
    "--no-playlist", "--no-part", "--no-warnings", "-q",
    "-f", "139/bestaudio[ext=m4a]/bestaudio/worst",
    "-o", path.join(workDir, "audio.%(ext)s"),
    url,
  ]);
  const name = fs.readdirSync(workDir).find((f) => f.startsWith("audio."));
  if (!name) throw new Error("오디오를 받지 못했어요.");
  return path.join(workDir, name);
}

// 16kHz 모노 opus로 줄이고 10분 단위로 자른다 (Groq 파일 크기 제한 대응)
async function splitAudio(input, workDir) {
  const listFile = path.join(workDir, "chunks.csv");
  await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input, "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "libopus", "-b:a", "24k",
    "-f", "segment", "-segment_time", String(CHUNK_SECONDS), "-reset_timestamps", "1",
    "-segment_list", listFile, "-segment_list_type", "csv",
    path.join(workDir, "chunk%03d.ogg"),
  ]);
  return fs
    .readFileSync(listFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, start, end] = line.split(",");
      return { file: path.join(workDir, name), start: Number(start), end: Number(end) };
    });
}

// ---------- 음성 인식 (Groq) ----------

const HALLUCINATIONS = /^(시청해 ?주셔서 감사합니다|구독과 좋아요|MBC 뉴스|자막 제공)/;

async function transcribeChunk(chunk) {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(chunk.file)], { type: "audio/ogg" }), path.basename(chunk.file));
    form.append("model", GROQ_MODEL);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
    });
    if (res.ok) {
      const data = await res.json();
      return (data.segments || [])
        .filter((s) => !(s.no_speech_prob > 0.8 && s.avg_logprob < -0.7))
        .map((s) => ({ start: chunk.start + s.start, end: chunk.start + s.end, text: s.text.trim() }))
        .filter((s) => s.text && !HALLUCINATIONS.test(s.text));
    }
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const wait = Number(res.headers.get("retry-after")) || 10 * (attempt + 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 120) * 1000));
      continue;
    }
    if (res.status === 401) throw new Error("Groq API 키가 올바르지 않아요.");
    if (res.status === 429) throw new Error("Groq 무료 사용량 한도에 도달했어요. 잠시 후 다시 시도해 주세요.");
    throw new Error(`음성 인식 실패 (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
}

async function transcribeAll(chunks, job) {
  const results = new Array(chunks.length);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      results[i] = await transcribeChunk(chunks[i]);
      done++;
      job.stage = `음성 인식 중 (${done}/${chunks.length})`;
      job.progress = 0.5 + 0.5 * (done / chunks.length);
    }
  };
  job.stage = `음성 인식 중 (0/${chunks.length})`;
  await Promise.all([worker(), worker()]);
  return results.flat();
}

// ---------- 음성 인식 (로컬 faster-whisper) ----------

function transcribeLocal(chunks, job, onChunkDone) {
  return new Promise((resolve, reject) => {
    const [bin, ...pre] = WHISPER_PYTHON;
    const proc = spawn(bin, [...pre, path.join(__dirname, "whisper_local.py"), LOCAL_WHISPER_MODEL, ...chunks.map((c) => c.file)], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    job.segments = job.segments || []; // 인식되는 대로 화면에 보여주기 위해 바로 채운다
    job.stage = `PC에서 음성 인식 중 (0/${chunks.length}) · 처음엔 모델을 내려받아요`;
    let buf = "";
    let stderr = "";
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (data) => {
      buf += data;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.chunk_done != null) {
          const done = msg.chunk_done + 1;
          job.stage = `PC에서 음성 인식 중 (${done}/${chunks.length})`;
          job.progress = 0.5 + 0.5 * (done / chunks.length);
          if (onChunkDone) onChunkDone(chunks[msg.chunk_done]);
        } else if (!HALLUCINATIONS.test(msg.text)) {
          const offset = chunks[msg.chunk].start;
          job.segments.push({ start: offset + msg.start, end: offset + msg.end, text: msg.text });
          job.stage = `PC에서 음성 인식 중 (${msg.chunk}/${chunks.length}) · ${fmtClock(offset + msg.end)}까지`;
        }
      }
    });
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    proc.on("error", () =>
      reject(new Error("GROQ_API_KEY가 없고, 이 컴퓨터에서 음성 인식(Python 3.11 + faster-whisper)도 실행할 수 없어요."))
    );
    proc.on("close", (code) => {
      if (code === 0) return resolve(job.segments);
      const hint = /No module named 'faster_whisper'/.test(stderr)
        ? "faster-whisper가 설치돼 있지 않아요 (py -3.11 -m pip install faster-whisper)."
        : stderr.trim().split("\n").pop() || `종료 코드 ${code}`;
      reject(new Error(`PC 음성 인식 실패: ${hint}`));
    });
  });
}

function fmtClock(sec) {
  const t = Math.floor(sec);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

// ---------- 작업 ----------

function isYoutubeUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\.|^m\./, "");
    return ["youtube.com", "youtu.be", "music.youtube.com"].includes(h);
  } catch {
    return false;
  }
}

async function runJob(job) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytsubs-"));
  try {
    job.stage = "준비 중";
    await ensureYtdlp();

    job.stage = "영상 정보 확인 중";
    let info;
    try {
      const out = await run(YTDLP_PATH, [
        ...cookieArgs(workDir), "-J", "--no-playlist", "--no-warnings", "--live-from-start", job.url,
      ]);
      info = JSON.parse(out);
    } catch (err) {
      throw new Error(friendlyYtdlpError(err));
    }
    job.title = info.title || info.id;
    job.live = info.live_status === "is_live";
    if (info.live_status === "is_upcoming") throw new Error("아직 시작하지 않은 방송이에요.");
    if (job.mode === "live" && !job.live) job.note = "라이브가 아니라서 종료된 영상으로 처리해요.";
    if (job.mode === "vod" && job.live) job.note = "진행 중인 라이브라서 지금까지 방송된 부분을 처리해요.";

    if (!job.live) {
      const subs = pickYoutubeSubs(info);
      if (subs) {
        job.stage = `${subs.kind} 가져오는 중`;
        job.segments = await fetchYoutubeSubs(subs.url);
        job.source = subs.kind;
        return;
      }
    }

    const useGroq = Boolean(process.env.GROQ_API_KEY);
    job.source = useGroq ? "음성 인식 (Groq Whisper)" : "음성 인식 (PC Whisper)";

    let audioFile;
    let saveProgress = () => {};
    if (job.live) {
      job.cutoff = new Date().toISOString();
      const cache = loadLiveCache(info.id);
      let base = [];
      let resumeSec = 0;
      if (cache) {
        base = cache.segments || [];
        resumeSec = cache.processedUntil || 0;
        // 지난번 마지막 문장은 구간 끝에서 잘렸을 수 있으니 그 문장부터 다시 인식한다
        const last = base[base.length - 1];
        if (last && last.end > resumeSec - 3) {
          resumeSec = last.start;
          base = base.slice(0, -1);
        }
      }

      audioFile = path.join(workDir, "live.m4a");
      const got = await downloadLiveUntilNow(info, audioFile, job, resumeSec);
      if (got.reset) base = [];
      if (!got.frags) {
        job.segments = cache ? cache.segments : [];
        job.note = "지난번 이후 새로 방송된 부분이 없어요.";
        return;
      }
      if (base.length) job.note = `${fmtClock(resumeSec)}까지는 지난번에 인식한 자막을 쓰고, 그 뒤부터 인식해요.`;
      job.segments = base.slice();
      saveProgress = (until) =>
        saveLiveCache(info.id, { title: job.title, processedUntil: until, segments: job.segments });
    } else {
      audioFile = await downloadVodAudio(job.url, workDir, job);
    }

    job.stage = "오디오 변환 중";
    job.progress = 0.45;
    const chunks = await splitAudio(audioFile, workDir);
    fs.rmSync(audioFile, { force: true });
    if (job.offset) {
      for (const c of chunks) {
        c.start += job.offset;
        c.end += job.offset;
      }
    }
    if (useGroq) {
      job.segments = [...(job.segments || []), ...(await transcribeAll(chunks, job))];
    } else {
      // 청크 하나가 끝날 때마다 저장해서, 중간에 멈춰도 다음번엔 이어서 인식한다
      await transcribeLocal(chunks, job, (c) => saveProgress(c.end));
    }
    if (chunks.length) saveProgress(chunks[chunks.length - 1].end);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function startJob(url, mode) {
  if (!isYoutubeUrl(url)) return { ok: false, error: "유튜브 주소만 넣을 수 있어요." };
  const running = [...jobs.values()].find((j) => j.status === "running");
  if (running) return { ok: false, error: "다른 자막 작업이 진행 중이에요. 끝난 뒤 다시 시도해 주세요." };

  const job = {
    id: crypto.randomBytes(6).toString("hex"),
    url,
    mode,
    status: "running",
    stage: "대기 중",
    progress: 0,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  runJob(job)
    .then(() => {
      job.status = "done";
      job.stage = "완료";
      job.progress = 1;
    })
    .catch((err) => {
      job.status = "error";
      job.error = err.message || "알 수 없는 오류가 발생했어요.";
    });

  for (const [id, j] of jobs) if (Date.now() - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  return { ok: true, id: job.id };
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  const { url, createdAt, ...pub } = job;
  return pub;
}

module.exports = { startJob, getJob };
