// 영상 자막 추출기 — 옆 패널
// 실시간 받아쓰기: 지금 탭의 소리를 16kHz로 받아, 말이 끊기는 지점에서 8~20초씩 잘라
//   PC 프로그램(YouTubeSubtitle, http://127.0.0.1:5180~)의 /api/clip 으로 보내 인식한다.
// 처음부터 지금까지: 유튜브 주소를 PC 프로그램의 /api/subs/start 로 보내 전체 자막을 받는다.

const PORTS = [5180, 5181, 5182, 5183, 5184];
const RATE = 16000;
const MIN_CLIP_SEC = 8; // 이만큼 모이면 말이 끊기는 곳에서 자른다
const MAX_CLIP_SEC = 20; // 끊기는 곳이 없어도 이만큼이면 자른다
const SILENCE_RMS = 0.01;
const SILENCE_SEC = 0.4;

const $ = (id) => document.getElementById(id);

// ---------- 공통 ----------

let base = null; // PC 프로그램 주소

async function findServer() {
  for (const port of PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
      const data = await res.json();
      if (data.app === "yt-subtitle") {
        base = `http://127.0.0.1:${port}`;
        return data;
      }
    } catch {}
  }
  base = null;
  return null;
}

async function refreshConnection() {
  const info = await findServer();
  const conn = $("conn");
  conn.classList.toggle("ok", Boolean(info));
  conn.classList.toggle("bad", !info);
  $("conn-text").textContent = info
    ? `PC 프로그램 연결됨${info.engine === "groq" ? " · Groq" : ""}`
    : "PC 프로그램이 꺼져 있어요";
  return info;
}

function needServerMessage() {
  return "PC 프로그램(YouTubeSubtitle.exe)을 먼저 실행해 주세요.";
}

function setStatus(el, text, isError) {
  el.textContent = text || "";
  el.classList.toggle("error", Boolean(isError));
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

function fmtOffset(sec, withMs) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const s = `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}`;
  return withMs ? `${s},${pad(ms % 1000, 3)}` : s;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function safeName(s) {
  return (s || "subtitles").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
}

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toSrt(lines) {
  return lines
    .map((l, i) => `${i + 1}\n${fmtOffset(l.start, true)} --> ${fmtOffset(l.end, true)}\n${l.text}\n`)
    .join("\n");
}

// lines: [{ start, end, text, label }] — label은 화면/TXT에 보이는 시각
function renderLines(container, lines, emptyText) {
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 8;
  container.innerHTML = "";
  if (!lines.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }
  for (const l of lines) {
    const row = document.createElement("div");
    row.className = "line";
    const t = document.createElement("span");
    t.className = "time";
    t.textContent = l.label;
    const text = document.createElement("span");
    text.textContent = l.text;
    row.append(t, text);
    container.appendChild(row);
  }
  if (atBottom) container.scrollTop = container.scrollHeight;
}

// ---------- 지금 탭 ----------

let currentTab = null;

async function refreshTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  $("tab-title").textContent = tab ? tab.title || tab.url : "-";
  $("full-btn").disabled = !isYoutube(tab && tab.url);
  if (!isYoutube(tab && tab.url) && !fullRunning) {
    setStatus($("full-status"), "유튜브 영상 탭에서만 쓸 수 있어요.");
  } else if (!fullRunning) {
    setStatus($("full-status"), "");
  }
}

function isYoutube(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, "");
    return (host === "youtube.com" && /^\/(watch|live\/|shorts\/|@)/.test(u.pathname)) || host === "youtu.be";
  } catch {
    return false;
  }
}

chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((id, change) => {
  if (currentTab && id === currentTab.id && (change.title || change.url)) refreshTab();
});

// ---------- 탭 전환 (실시간 / 처음부터) ----------

for (const btn of document.querySelectorAll(".mode")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".mode")) {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      $(`pane-${b.dataset.pane}`).hidden = !on;
    }
  });
}

// ---------- 실시간 받아쓰기 ----------

const live = {
  lines: [], // { start, end, text, label }
  title: "",
  running: false,
  stream: null,
  audio: null,
  ctx: null,
  startedAt: 0, // 캡처 시작 시각(ms)
  samples: [], // 아직 보내지 않은 0.1초 조각들
  sampleBase: 0, // samples[0]의 시작 위치(샘플 수, 캡처 시작 기준)
  silentRun: 0, // 끝에서부터 연속으로 조용한 시간(초)
  queue: [],
  sending: false,
};

async function saveLive() {
  try {
    await chrome.storage.local.set({ live: { lines: live.lines, title: live.title } });
  } catch {}
}

async function loadLive() {
  try {
    const { live: saved } = await chrome.storage.local.get("live");
    if (saved && saved.lines) {
      live.lines = saved.lines;
      live.title = saved.title || "";
    }
  } catch {}
  renderLive();
}

function renderLive() {
  $("live-count").textContent = `${live.lines.length}줄`;
  renderLines($("live-lines"), live.lines, "아직 받아쓴 내용이 없어요.");
}

function encodeWav(float32) {
  const buf = new ArrayBuffer(44 + float32.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + float32.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 모노
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, float32.length * 2, true);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function onFrame(frame) {
  live.samples.push(frame);
  live.silentRun = rms(frame) < SILENCE_RMS ? live.silentRun + frame.length / RATE : 0;
  const sec = live.samples.length * 0.1;
  if ((sec >= MIN_CLIP_SEC && live.silentRun >= SILENCE_SEC) || sec >= MAX_CLIP_SEC) cutClip();
}

function cutClip() {
  if (!live.samples.length) return;
  const total = live.samples.reduce((n, f) => n + f.length, 0);
  const pcm = new Float32Array(total);
  let o = 0;
  for (const f of live.samples) {
    pcm.set(f, o);
    o += f.length;
  }
  const startSec = live.sampleBase / RATE;
  live.sampleBase += total;
  live.samples = [];
  live.silentRun = 0;
  // 거의 무음인 조각은 보내지 않는다 (Whisper가 없는 말을 지어내기 쉽다)
  if (total < RATE || rms(pcm) < SILENCE_RMS / 2) return;
  live.queue.push({ wav: encodeWav(pcm), startSec, startedAt: live.startedAt });
  pumpQueue();
}

async function pumpQueue() {
  if (live.sending) return;
  live.sending = true;
  while (live.queue.length) {
    const clip = live.queue[0];
    updateLiveStatus();
    try {
      if (!base && !(await findServer())) throw new Error(needServerMessage());
      const res = await fetch(`${base}/api/clip`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: clip.wav,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "음성 인식에 실패했어요.");
      for (const s of data.segments) {
        const start = clip.startSec + s.start;
        live.lines.push({
          start,
          end: clip.startSec + s.end,
          text: s.text,
          label: fmtClock(clip.startedAt + start * 1000),
        });
      }
      live.queue.shift();
      renderLive();
      saveLive();
    } catch (err) {
      clip.tries = (clip.tries || 0) + 1;
      const offline = !(await refreshConnection());
      if (!offline && clip.tries >= 3) {
        // 프로그램은 켜져 있는데 이 조각만 계속 실패하면 건너뛴다
        live.queue.shift();
        setStatus($("live-status"), `한 구간을 인식하지 못해 건너뛰었어요: ${err.message}`, true);
        continue;
      }
      setStatus($("live-status"), `${offline ? needServerMessage() : err.message} 잠시 후 다시 시도해요.`, true);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  live.sending = false;
  updateLiveStatus();
}

function updateLiveStatus() {
  if (!live.running && !live.queue.length) {
    if (live.stream) setStatus($("live-status"), "멈췄어요.");
    return;
  }
  const waiting = live.queue.length;
  const head = live.running ? "받아쓰는 중" : "남은 소리 인식 중";
  setStatus($("live-status"), waiting > 1 ? `${head} · 인식 대기 ${waiting}개 (PC가 따라잡는 중)` : `${head}…`);
}

// 탭 소리 캡처용 ID. 패널에서 먼저 시도하고, 안 되면 백그라운드에 부탁한다.
async function getStreamId(tabId) {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (panelErr) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "getStreamId", tabId });
    } catch {
      // 백그라운드가 옛날 버전이면 이 메시지를 받을 곳이 없다 (패널 파일만 새로 읽힌 상태)
      throw new Error(
        "확장 프로그램이 업데이트됐어요. chrome://extensions 에서 '영상 자막 추출기'의 새로고침(↻)을 누르고, 영상 탭에서 아이콘을 다시 눌러 주세요."
      );
    }
    if (res && res.id) return res.id;
    const detail = (res && res.error) || panelErr.message || String(panelErr);
    const err = new Error(
      `이 탭의 소리를 가져올 권한이 없어요. 영상이 나오는 이 탭에서 툴바의 확장 아이콘을 눌러 패널을 연 뒤 다시 시작해 주세요. (${detail})`
    );
    throw err;
  }
}

async function startLive() {
  const btn = $("live-btn");
  btn.disabled = true;
  try {
    if (!(await refreshConnection())) throw new Error(needServerMessage());
    await refreshTab();
    if (!currentTab) throw new Error("탭을 찾지 못했어요.");

    const streamId = await getStreamId(currentTab.id);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });

    // 캡처하면 탭 소리가 꺼지므로 패널에서 다시 들려준다
    const audio = new Audio();
    audio.srcObject = stream;
    audio.play().catch(() => {});

    const ctx = new AudioContext({ sampleRate: RATE });
    await ctx.audioWorklet.addModule("capture-worklet.js");
    const node = new AudioWorkletNode(ctx, "capture");
    node.port.onmessage = (e) => onFrame(e.data);
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(ctx.destination); // 출력은 무음이지만 연결해야 처리가 돈다

    if (live.title !== currentTab.title && live.lines.length) {
      live.lines.push({ start: 0, end: 0, text: `── ${currentTab.title} ──`, label: fmtClock(Date.now()) });
    }
    Object.assign(live, {
      running: true,
      stream,
      audio,
      ctx,
      title: currentTab.title,
      startedAt: Date.now(),
      samples: [],
      sampleBase: 0,
      silentRun: 0,
    });
    stream.getAudioTracks()[0].addEventListener("ended", () => stopLive());
    btn.textContent = "받아쓰기 중지";
    btn.classList.add("recording");
    updateLiveStatus();
    renderLive();
  } catch (err) {
    setStatus($("live-status"), err.message || String(err), true);
  } finally {
    btn.disabled = false;
  }
}

function stopLive() {
  if (!live.running) return;
  live.running = false;
  cutClip(); // 남은 소리도 인식한다
  for (const t of live.stream.getTracks()) t.stop();
  live.audio.srcObject = null;
  live.ctx.close();
  const btn = $("live-btn");
  btn.textContent = "받아쓰기 시작";
  btn.classList.remove("recording");
  if (!live.queue.length) setStatus($("live-status"), "멈췄어요.");
}

$("live-btn").addEventListener("click", () => (live.running ? stopLive() : startLive()));

function liveTxt() {
  return live.lines.map((l) => `[${l.label}] ${l.text}`).join("\n");
}

for (const b of document.querySelectorAll("#pane-live .actions button")) {
  b.addEventListener("click", () => {
    const name = `${safeName(live.title)}_${new Date().toISOString().slice(0, 10)}`;
    if (b.dataset.act === "copy") {
      navigator.clipboard.writeText(liveTxt()).then(() => setStatus($("live-status"), "복사했어요."));
    } else if (b.dataset.act === "txt") {
      download(`${name}.txt`, liveTxt());
    } else if (b.dataset.act === "srt") {
      download(`${name}.srt`, toSrt(live.lines.filter((l) => l.end > l.start)));
    } else if (b.dataset.act === "clear") {
      if (live.lines.length && !confirm("받아쓴 내용을 모두 지울까요?")) return;
      live.lines = [];
      renderLive();
      saveLive();
    }
  });
}

// ---------- 처음부터 지금까지 (유튜브) ----------

let fullRunning = false;
let fullJob = null;

function renderFull() {
  const segs = (fullJob && fullJob.segments) || [];
  $("full-count").textContent = `${segs.length}줄${fullJob && fullJob.source ? ` · ${fullJob.source}` : ""}`;
  renderLines(
    $("full-lines"),
    segs.map((s) => ({ ...s, label: fmtOffset(s.start) })),
    fullRunning ? "인식 중이에요…" : "유튜브 탭에서 버튼을 눌러주세요."
  );
}

async function startFull() {
  const btn = $("full-btn");
  const statusEl = $("full-status");
  if (!(await refreshConnection())) return setStatus(statusEl, needServerMessage(), true);
  await refreshTab();
  if (!currentTab || !isYoutube(currentTab.url)) return setStatus(statusEl, "유튜브 영상 탭에서만 쓸 수 있어요.", true);

  fullRunning = true;
  fullJob = null;
  btn.disabled = true;
  btn.textContent = "가져오는 중…";
  $("full-progress").hidden = false;
  $("full-bar").style.width = "0";
  setStatus(statusEl, "요청을 보내는 중…");
  renderFull();
  try {
    const res = await fetch(`${base}/api/subs/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentTab.url, mode: "live" }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "시작하지 못했어요.");
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await (await fetch(`${base}/api/subs/status?id=${data.id}`)).json();
      if (!st.ok) throw new Error(st.error);
      fullJob = st.job;
      $("full-bar").style.width = `${Math.round((fullJob.progress || 0) * 100)}%`;
      renderFull();
      if (fullJob.status === "running") {
        setStatus(statusEl, [fullJob.stage, fullJob.note].filter(Boolean).join(" · "));
        continue;
      }
      if (fullJob.status === "error") throw new Error(fullJob.error);
      setStatus(statusEl, fullJob.note || "완료됐어요.");
      break;
    }
  } catch (err) {
    setStatus(statusEl, err.message || "실패했어요.", true);
  } finally {
    fullRunning = false;
    btn.disabled = false;
    btn.textContent = "자막 가져오기";
    $("full-progress").hidden = true;
    renderFull();
  }
}

$("full-btn").addEventListener("click", startFull);

for (const b of document.querySelectorAll("#pane-full .actions button")) {
  b.addEventListener("click", () => {
    const segs = (fullJob && fullJob.segments) || [];
    const txt = segs.map((s) => `[${fmtOffset(s.start)}] ${s.text}`).join("\n");
    const name = safeName(fullJob && fullJob.title);
    if (b.dataset.act === "copy") navigator.clipboard.writeText(txt).then(() => setStatus($("full-status"), "복사했어요."));
    else if (b.dataset.act === "txt") download(`${name}.txt`, txt);
    else if (b.dataset.act === "srt") download(`${name}.srt`, toSrt(segs));
  });
}

// ---------- 시작 ----------

refreshConnection();
setInterval(() => {
  if (!live.sending) refreshConnection();
}, 10000);
refreshTab();
loadLive();
