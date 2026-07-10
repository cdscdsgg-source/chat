const urlInput = document.getElementById("url-input");
const analyzeBtn = document.getElementById("analyze-btn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const pageTitleEl = document.getElementById("page-title");
const pageDescEl = document.getElementById("page-desc");
const chipsEl = document.getElementById("chips");
const feedListEl = document.getElementById("feed-list");

function setStatus(text, isError) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function renderChips(keywords) {
  chipsEl.innerHTML = "";
  const entries = Object.entries(keywords || {});
  if (!entries.length) return;
  for (const [key, group] of entries) {
    const chip = document.createElement("span");
    chip.className = `chip ${key}`;
    chip.textContent = `${group.label} · ${group.matched.join(", ")}`;
    chipsEl.appendChild(chip);
  }
}

function addCueCard(phrase, { time, reason, prepend } = {}) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "cue-card";
  card.innerHTML =
    (time ? `<div class="cue-time mono">${time}</div>` : "") +
    `<div class="cue-phrase">"${phrase}"</div>` +
    (reason ? `<div class="cue-reason">${reason}</div>` : "") +
    `<div class="cue-copied">복사됨 · 채팅창에 붙여넣어보세요</div>`;
  card.addEventListener("click", () => {
    const copiedEl = card.querySelector(".cue-copied");
    if (navigator.clipboard) navigator.clipboard.writeText(phrase).catch(() => {});
    copiedEl.classList.add("show");
    setTimeout(() => copiedEl.classList.remove("show"), 1500);
  });
  if (prepend) feedListEl.prepend(card);
  else feedListEl.appendChild(card);

  const cards = feedListEl.querySelectorAll(".cue-card");
  if (cards.length > 30) cards[cards.length - 1].remove();
}

function renderPhrases(phrases) {
  feedListEl.innerHTML = "";
  for (const phrase of phrases) addCueCard(phrase);
}

async function analyze() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("링크를 먼저 입력해주세요.", true);
    return;
  }

  analyzeBtn.disabled = true;
  resultEl.hidden = true;
  setStatus("페이지 내용을 가져오는 중…");

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!data.ok) {
      setStatus(data.error || "분석에 실패했어요.", true);
      return;
    }

    pageTitleEl.textContent = data.title;
    pageDescEl.textContent = data.description || "설명을 찾지 못했어요.";
    renderChips(data.keywords);
    renderPhrases(data.phrases);
    resultEl.hidden = false;
    setStatus("");
  } catch (err) {
    setStatus("서버에 연결할 수 없었어요.", true);
  } finally {
    analyzeBtn.disabled = false;
  }
}

analyzeBtn.addEventListener("click", analyze);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") analyze();
});

// ---- 실시간 채팅 감시 ----

const watchBtn = document.getElementById("watch-btn");
const watchBody = document.getElementById("watch-body");
const watchCardEl = document.querySelector(".watch-card");
const watchRateEl = document.getElementById("watch-rate");
const watchViewersEl = document.getElementById("watch-viewers");
const watchCanvas = document.getElementById("watch-canvas");
const watchCtx = watchCanvas.getContext("2d");
const watchTickerEl = document.getElementById("watch-ticker");

const WATCH_HISTORY_LEN = 60;
const watchHistory = new Array(WATCH_HISTORY_LEN).fill(0);
let eventSource = null;
let watching = false;

function fitWatchCanvas() {
  const rect = watchCanvas.getBoundingClientRect();
  watchCanvas.width = rect.width;
  watchCanvas.height = rect.height;
}

function drawWatchSparkline() {
  const w = watchCanvas.width;
  const h = watchCanvas.height;
  if (!w || !h) return;
  watchCtx.clearRect(0, 0, w, h);

  const maxVal = Math.max(4, ...watchHistory);
  const stepX = w / (WATCH_HISTORY_LEN - 1);
  const yAt = (v) => h - (v / maxVal) * (h - 8) - 4;

  const grad = watchCtx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#52d6ff50");
  grad.addColorStop(1, "#52d6ff00");

  watchCtx.beginPath();
  watchHistory.forEach((v, i) => {
    const x = i * stepX, y = yAt(v);
    if (i === 0) watchCtx.moveTo(x, y);
    else watchCtx.lineTo(x, y);
  });
  watchCtx.lineTo((watchHistory.length - 1) * stepX, h);
  watchCtx.lineTo(0, h);
  watchCtx.closePath();
  watchCtx.fillStyle = grad;
  watchCtx.fill();

  watchCtx.beginPath();
  watchHistory.forEach((v, i) => {
    const x = i * stepX, y = yAt(v);
    if (i === 0) watchCtx.moveTo(x, y);
    else watchCtx.lineTo(x, y);
  });
  watchCtx.strokeStyle = "#52d6ff";
  watchCtx.lineWidth = 2;
  watchCtx.stroke();
}

function addTickerLine(nickname, message) {
  const line = document.createElement("div");
  line.className = "tick-item";
  line.innerHTML = `<b>${escapeHtml(nickname)}</b>${escapeHtml(message)}`;
  watchTickerEl.prepend(line);
  while (watchTickerEl.children.length > 12) {
    watchTickerEl.removeChild(watchTickerEl.lastChild);
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function flashWatchCard() {
  watchCardEl.classList.add("spike");
  setTimeout(() => watchCardEl.classList.remove("spike"), 900);
}

function connectStream() {
  eventSource = new EventSource("/api/watch/stream");
  eventSource.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }

    if (data.type === "tick") {
      watchHistory.push(data.msgPerSec);
      if (watchHistory.length > WATCH_HISTORY_LEN) watchHistory.shift();
      watchRateEl.textContent = `${data.msgPerSec.toFixed(1)} msg/s`;
      if (data.viewerCount != null) {
        watchViewersEl.textContent = `시청자 ${data.viewerCount.toLocaleString("ko-KR")}명`;
      }
      drawWatchSparkline();
    } else if (data.type === "chat") {
      addTickerLine(data.nickname, data.message);
    } else if (data.type === "cue") {
      addCueCard(data.phrase, { time: data.time, reason: `실시간 채팅 · ${data.reason}`, prepend: true });
      flashWatchCard();
    }
  };
  eventSource.onerror = () => {
    // connection dropped (e.g. watch stopped server-side); reflect stopped state
    if (watching) stopWatching(true);
  };
}

async function startWatching() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("먼저 링크를 입력해주세요.", true);
    return;
  }
  watchBtn.disabled = true;
  watchBtn.textContent = "연결 중…";

  try {
    const res = await fetch("/api/watch/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!data.ok) {
      setStatus(data.error || "감시를 시작하지 못했어요.", true);
      watchBtn.textContent = "감시 시작";
      return;
    }

    watching = true;
    watchHistory.fill(0);
    watchTickerEl.innerHTML = "";
    watchBody.hidden = false;
    fitWatchCanvas();
    watchBtn.textContent = "감시 중지";
    watchBtn.classList.add("active");
    connectStream();
  } catch (err) {
    setStatus("서버에 연결할 수 없었어요.", true);
    watchBtn.textContent = "감시 시작";
  } finally {
    watchBtn.disabled = false;
  }
}

async function stopWatching(silent) {
  watching = false;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  watchBtn.textContent = "감시 시작";
  watchBtn.classList.remove("active");
  if (!silent) {
    try {
      await fetch("/api/watch/stop", { method: "POST" });
    } catch {}
  }
}

watchBtn.addEventListener("click", () => {
  if (watching) stopWatching(false);
  else startWatching();
});

window.addEventListener("resize", () => {
  if (watching) fitWatchCanvas();
});
