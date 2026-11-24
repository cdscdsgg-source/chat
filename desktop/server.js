// 포터블 PC 프로그램용 서버. 빌드하면 <프로그램 폴더>\app\server.js 로 들어간다.
//   <프로그램 폴더>\
//     유튜브자막.exe        launcher.cs — 이 서버를 창 없이 띄우고 트레이 아이콘을 보여준다
//     groq-key.txt          (선택) Groq API 키
//     app\                  이 파일, subs.js, whisper_local.py, 화면 파일
//     runtime\              node.exe, python\, bin\(ffmpeg, yt-dlp), models\small\
//     data\                 라이브 자막 저장(subs-cache), 로그
const fs = require("fs");
const http = require("http");
const path = require("path");
const { exec } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, "runtime");
const DATA = path.join(ROOT, "data");
const APP_DIR = __dirname;
const PORTS = [5180, 5181, 5182, 5183, 5184];

fs.mkdirSync(DATA, { recursive: true });
process.env.FFMPEG_PATH = path.join(RUNTIME, "bin", "ffmpeg.exe");
process.env.YTDLP_PATH = path.join(RUNTIME, "bin", "yt-dlp.exe");
process.env.WHISPER_PYTHON = path.join(RUNTIME, "python", "python.exe");
process.env.LOCAL_WHISPER_MODEL = path.join(RUNTIME, "models", "small");
process.env.SUBS_CACHE_DIR = path.join(DATA, "subs-cache");
process.env.HF_HUB_OFFLINE = "1"; // 모델은 같이 들어 있으니 인터넷에서 받지 않는다
try {
  const key = fs.readFileSync(path.join(ROOT, "groq-key.txt"), "utf-8").trim();
  if (key) process.env.GROQ_API_KEY = key;
} catch {}

const subs = require("./subs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const MAX_CLIP_BYTES = 8 * 1024 * 1024; // 16kHz 모노 WAV 4분 분량

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];

  // 이 프로그램 화면과 크롬 확장에서 온 요청만 받는다 (아무 웹사이트나 이 PC의 프로그램을 쓰지 못하게)
  const origin = req.headers.origin;
  if (origin) {
    const own = origin === `http://127.0.0.1:${server.address().port}`;
    const extension = origin.startsWith("chrome-extension://");
    if (!own && !extension) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    if (extension) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    }
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && pathname === "/api/ping") {
    return sendJson(res, 200, { ok: true, app: "yt-subtitle", engine: process.env.GROQ_API_KEY ? "groq" : "local" });
  }

  // 크롬 확장의 실시간 받아쓰기: 탭 소리 조각(WAV)을 받아 바로 인식한다
  if (req.method === "POST" && pathname === "/api/clip") {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_CLIP_BYTES) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      try {
        const segments = await subs.transcribeClip(Buffer.concat(chunks));
        sendJson(res, 200, { ok: true, segments });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message || "음성 인식에 실패했어요." });
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/subs/start") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let result;
      try {
        const { url, mode } = JSON.parse(body || "{}");
        result = url ? subs.startJob(String(url).trim(), mode === "live" ? "live" : "vod") : { ok: false, error: "url이 필요해요." };
      } catch {
        result = { ok: false, error: "잘못된 요청이에요." };
      }
      sendJson(res, 200, result);
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/subs/status") {
    const id = new URL(req.url, "http://x").searchParams.get("id");
    const job = id && subs.getJob(id);
    return sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: "작업을 찾을 수 없어요. 프로그램이 다시 시작됐을 수 있어요." });
  }

  const file = path.join(APP_DIR, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(APP_DIR) || !MIME[path.extname(file)]) {
    res.writeHead(404);
    return res.end("Not found");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] });
    res.end(data);
  });
});

function openBrowser(url) {
  exec(`start "" "${url}"`);
}

function listen(i) {
  const port = PORTS[i];
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && i + 1 < PORTS.length) return listen(i + 1);
    console.error(err);
    process.exit(1);
  });
  // 이 PC 안에서만 접속되게 127.0.0.1에만 연다
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    fs.writeFileSync(path.join(DATA, "port.txt"), String(port));
    console.log(`listening ${url}`);
    if (!process.env.NO_BROWSER) openBrowser(url);
  });
}

function quit() {
  subs.shutdown();
  process.exit(0);
}

// 런처가 stdin을 닫으면(트레이에서 종료, 또는 런처가 죽었을 때) 같이 끝난다
process.stdin.on("end", quit);
process.stdin.on("error", quit);
process.stdin.resume();
process.on("SIGINT", quit);

listen(0);
