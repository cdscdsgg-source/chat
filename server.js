const http = require("http");
const fs = require("fs");
const path = require("path");
const watch = require("./watch");

const PORT = process.env.PORT || 5173;
const PUBLIC_DIR = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const KEYWORD_GROUPS = {
  price: { label: "가격/할인", words: ["할인", "세일", "특가", "무료배송", "쿠폰", "가격"] },
  urgency: { label: "한정/마감", words: ["품절", "한정", "마감", "선착순", "오늘까지", "재입고", "매진"] },
  trust: { label: "후기/신뢰", words: ["후기", "리뷰", "인증", "베스트", "1위", "정품"] },
  fresh: { label: "신상/추천", words: ["신상", "추천", "인기", "핫딜", "이벤트"] },
};

const PHRASE_TEMPLATES = {
  price: (title) => [`${title} 가격 진짜 괜찮네요`, "이 가격이면 사야죠"],
  urgency: (title) => [`${title} 지금 아니면 놓치겠어요`, "마감 전에 얼른 담아야겠네요"],
  trust: (title) => [`후기 좋으면 믿고 가는 거죠`, `${title} 검증된 거면 안심되네요`],
  fresh: (title) => [`${title} 신상이라 더 궁금하네요`, "이거 인기 많을 것 같아요"],
  generic: (title) => [`${title} 어떤지 궁금하네요`, "설명 좀 더 자세히 알려주세요"],
};

function isPrivateHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getMeta(html, keys) {
  for (const key of keys) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, "i"),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) return decodeEntities(m[1]);
    }
  }
  return "";
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function analyzeUrl(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { ok: false, error: "올바른 URL 형식이 아니에요." };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "http/https 링크만 지원해요." };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, error: "내부/사설 주소는 분석할 수 없어요." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let html;
  try {
    const res = await fetch(parsed.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `페이지를 가져오지 못했어요 (HTTP ${res.status}).` };
    }
    html = await res.text();
  } catch (err) {
    return { ok: false, error: "페이지에 접속할 수 없었어요. 로그인 필요·차단·타임아웃일 수 있어요." };
  } finally {
    clearTimeout(timeout);
  }

  const title =
    getMeta(html, ["og:title", "twitter:title"]) ||
    (html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1].trim();
  const description = getMeta(html, ["og:description", "twitter:description", "description"]);
  const visibleText = stripHtml(html).slice(0, 20000);
  const haystack = `${title} ${description} ${visibleText}`;

  const foundKeywords = {};
  for (const [key, group] of Object.entries(KEYWORD_GROUPS)) {
    const matched = group.words.filter((w) => haystack.includes(w));
    if (matched.length) foundKeywords[key] = { label: group.label, matched };
  }

  const shortTitle = title ? title.slice(0, 24) : "이 상품";
  let phrases = [];
  for (const key of Object.keys(foundKeywords)) {
    phrases.push(...PHRASE_TEMPLATES[key](shortTitle));
  }
  if (!phrases.length) phrases = PHRASE_TEMPLATES.generic(shortTitle);
  phrases = [...new Set(phrases)].slice(0, 6);

  return {
    ok: true,
    title: title || "(제목을 찾지 못했어요)",
    description: description || "",
    keywords: foundKeywords,
    phrases,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/analyze") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { url } = JSON.parse(body || "{}");
        if (!url) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "url이 필요해요." }));
          return;
        }
        const result = await analyzeUrl(url);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "서버 오류가 발생했어요." }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/watch/start") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { url } = JSON.parse(body || "{}");
        if (!url) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "url이 필요해요." }));
          return;
        }
        const result = await watch.startWatch(url);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "서버 오류가 발생했어요." }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/watch/stop") {
    watch.stopWatch().then(() => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/watch/stream") {
    const added = watch.addClient(res);
    if (!added) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "진행 중인 감시가 없어요." }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    req.on("close", () => watch.removeClient(res));
    return;
  }

  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = filePath.split("?")[0];
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
