const HYPE_WORDS = ["ㅋㅋ", "ㄷㄷ", "대박", "미쳤다", "실화", "개이득", "쩐다", "가즈아", "지린다", "사야겠다"];

const KEYWORD_GROUPS = {
  price: { label: "가격/할인", words: ["할인", "세일", "특가", "무료배송", "쿠폰", "가격"] },
  urgency: { label: "한정/마감", words: ["품절", "한정", "마감", "선착순", "재입고", "매진"] },
  trust: { label: "후기/신뢰", words: ["후기", "리뷰", "인증", "정품"] },
  hype: { label: "채팅 반응 폭주", words: HYPE_WORDS },
};

const PHRASE_TEMPLATES = {
  price: (title) => [`${title} 가격 진짜 괜찮네요`, "이 가격이면 사야죠"],
  urgency: (title) => [`${title} 지금 아니면 놓치겠어요`, "마감 전에 얼른 담아야겠네요"],
  trust: (title) => [`후기 좋으면 믿고 가는 거죠`, `${title} 검증된 거면 안심되네요`],
  hype: (title) => [`와 채팅 반응 진짜 뜨겁네요`, `${title} 다들 난리났네요 ㅋㅋ`],
  velocity: (title) => [`지금 채팅 속도 심상치 않은데요`, `${title} 분위기 지금이 딱이네요`],
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const POLL_MS = 4000;
const WINDOW_MS = 150000; // keep 2.5 minutes of history
const RATE_WINDOW_MS = 15000; // instantaneous rate window, for the display graph only
const CUE_EVERY_N_MESSAGES = 3;

let state = null; // single active watch at a time

function extractBroadcastId(targetUrl) {
  const m = targetUrl.match(/\/lives\/(\d+)/);
  return m ? m[1] : null;
}

function classifyMessage(text) {
  const hits = [];
  for (const [key, group] of Object.entries(KEYWORD_GROUPS)) {
    if (group.words.some((w) => text.includes(w))) hits.push(key);
  }
  return hits;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchTitle(targetUrl) {
  try {
    const res = await fetch(targetUrl, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" } });
    if (!res.ok) return "";
    const html = await res.text();
    const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
    return m ? decodeEntities(m[1]) : "";
  } catch {
    return "";
  }
}

function broadcastEvent(event) {
  if (!state) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of state.clients) {
    client.write(payload);
  }
}

function pickCueGroup(recentHits) {
  const counts = {};
  for (const hits of recentHits) {
    for (const h of hits) counts[h] = (counts[h] || 0) + 1;
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function emitCueForBatch(batch) {
  const group = pickCueGroup(batch.map((m) => m.hits));
  const templateKey = group || "velocity";
  const templates = PHRASE_TEMPLATES[templateKey] || PHRASE_TEMPLATES.velocity;
  const phrase = templates(state.shortTitle)[Math.floor(Math.random() * templates(state.shortTitle).length)];

  broadcastEvent({
    type: "cue",
    phrase,
    reason: group ? KEYWORD_GROUPS[group].label : "채팅 3건 누적",
    time: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
  });
}

function evaluateSignals() {
  if (!state) return;
  const now = Date.now();
  state.messages = state.messages.filter((m) => now - m.ts <= WINDOW_MS);

  const rateCount = state.messages.filter((m) => now - m.ts <= RATE_WINDOW_MS).length;
  const msgPerSec = rateCount / (RATE_WINDOW_MS / 1000);

  broadcastEvent({ type: "tick", msgPerSec: Number(msgPerSec.toFixed(1)), viewerCount: state.viewerCount });
}

async function pollComments() {
  if (!state) return;
  try {
    const res = await fetch(
      `https://apis.naver.com/live_commerce_web/viewer_api_web/v1/broadcast/${state.broadcastId}/recent-comments?next=${state.nextCursor}&size=30`,
      { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" } }
    );
    if (!res.ok) return;
    const data = await res.json();

    for (const item of data.list || []) {
      if (item.commentType !== "CHATTING" || !item.message) continue;
      const hits = classifyMessage(item.message);
      const ts = Date.parse(item.commentCreatedAt) || Date.now();
      const entry = { ts, nickname: item.nickname, message: item.message, hits };
      state.messages.push(entry);
      state.pendingBatch.push(entry);
      broadcastEvent({ type: "chat", nickname: item.nickname, message: item.message });
    }
    if (data.next != null) state.nextCursor = data.next;
  } catch {
    // transient network hiccup; try again next poll
  }

  while (state.pendingBatch.length >= CUE_EVERY_N_MESSAGES) {
    const batch = state.pendingBatch.splice(0, CUE_EVERY_N_MESSAGES);
    emitCueForBatch(batch);
  }

  evaluateSignals();
}

async function fetchViewerCount() {
  if (!state) return;
  try {
    const res = await fetch(
      `https://apis.naver.com/live_commerce_web/viewer_api_web/v3/broadcast/${state.broadcastId}/extras?extraCount=true`,
      { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" } }
    );
    if (!res.ok) return;
    const data = await res.json();
    if (data.extraCount && typeof data.extraCount.viewerCount === "number") {
      state.viewerCount = data.extraCount.viewerCount;
    }
  } catch {
    // ignore
  }
}

async function startWatch(targetUrl) {
  const broadcastId = extractBroadcastId(targetUrl);
  if (!broadcastId) {
    return { ok: false, error: "네이버 쇼핑라이브 링크(.../lives/숫자)만 지원해요." };
  }

  await stopWatch();

  const title = await fetchTitle(targetUrl);

  state = {
    broadcastId,
    url: targetUrl,
    title,
    shortTitle: title ? title.slice(0, 24) : "이 방송",
    viewerCount: null,
    nextCursor: 0,
    messages: [],
    pendingBatch: [],
    clients: new Set(),
    timer: null,
    viewerTimer: null,
  };

  // prime the cursor with existing history so we don't replay old comments as "new"
  try {
    const res = await fetch(
      `https://apis.naver.com/live_commerce_web/viewer_api_web/v1/broadcast/${broadcastId}/recent-comments?next=0&size=30`,
      { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" } }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.next != null) state.nextCursor = data.next;
    }
  } catch {
    await stopWatch();
    return { ok: false, error: "방송 채팅에 접속하지 못했어요. 링크를 확인해주세요." };
  }

  state.timer = setInterval(pollComments, POLL_MS);
  state.viewerTimer = setInterval(fetchViewerCount, 15000);
  fetchViewerCount();

  return { ok: true, broadcastId, title };
}

async function stopWatch() {
  if (!state) return;
  const prev = state;
  state = null;
  if (prev.timer) clearInterval(prev.timer);
  if (prev.viewerTimer) clearInterval(prev.viewerTimer);
  for (const client of prev.clients) {
    try {
      client.end();
    } catch {}
  }
}

function addClient(res) {
  if (!state) return false;
  state.clients.add(res);
  return true;
}

function removeClient(res) {
  if (!state) return;
  state.clients.delete(res);
}

function getStatus() {
  if (!state) return { active: false };
  return { active: true, url: state.url, title: state.title, broadcastId: state.broadcastId };
}

module.exports = { startWatch, stopWatch, addClient, removeClient, getStatus };
