// ---- 게시판 알림 ----

function initBoardWatchSection({ channel, ntfyTopic, idSuffix }) {
  const bwUrlInput = document.getElementById(`bw-url-input${idSuffix}`);
  const bwAddBtn = document.getElementById(`bw-add-btn${idSuffix}`);
  const bwStatusEl = document.getElementById(`bw-status${idSuffix}`);
  const bwListEl = document.getElementById(`bw-list${idSuffix}`);
  const bwTopicValueEl = document.getElementById(`bw-topic-value${idSuffix}`);

  bwTopicValueEl.textContent = ntfyTopic;
  bwTopicValueEl.title = "클릭하면 복사돼요";
  bwTopicValueEl.addEventListener("click", () => {
    if (navigator.clipboard) navigator.clipboard.writeText(ntfyTopic).catch(() => {});
    setBwStatus("토픽 이름을 복사했어요.");
  });

  function setBwStatus(text, isError) {
    bwStatusEl.textContent = text || "";
    bwStatusEl.classList.toggle("error", Boolean(isError));
  }

  function renderBoardWatchList(list) {
    bwListEl.innerHTML = "";
    if (!list || !list.length) {
      const empty = document.createElement("div");
      empty.className = "bw-empty";
      empty.textContent = "아직 감시 중인 게시판이 없어요.";
      bwListEl.appendChild(empty);
      return;
    }
    for (const item of list) {
      const row = document.createElement("div");
      row.className = "bw-item";
      const info = document.createElement("div");
      info.className = "bw-item-info";
      const urlEl = document.createElement("div");
      urlEl.className = "bw-item-url";
      urlEl.textContent = item.url;
      const metaEl = document.createElement("div");
      metaEl.className = "bw-item-meta";
      const addedAt = item.addedAt ? new Date(item.addedAt).toLocaleString("ko-KR") : "";
      metaEl.textContent = addedAt ? `추가됨 · ${addedAt}` : "";
      info.appendChild(urlEl);
      info.appendChild(metaEl);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "bw-item-remove";
      removeBtn.textContent = "삭제";
      removeBtn.addEventListener("click", () => removeBoardWatch(item.id));

      row.appendChild(info);
      row.appendChild(removeBtn);
      bwListEl.appendChild(row);
    }
  }

  async function loadBoardWatchList() {
    try {
      const res = await fetch(`/api/boardwatch/list?channel=${encodeURIComponent(channel)}`);
      const data = await res.json();
      if (!data.ok) {
        setBwStatus(data.error || "목록을 불러오지 못했어요.", true);
        return;
      }
      renderBoardWatchList(data.list);
    } catch {
      setBwStatus("서버에 연결할 수 없었어요.", true);
    }
  }

  async function addBoardWatch() {
    const url = bwUrlInput.value.trim();
    if (!url) {
      setBwStatus("게시판 주소를 먼저 입력해주세요.", true);
      return;
    }
    bwAddBtn.disabled = true;
    setBwStatus("페이지를 확인하는 중…");
    try {
      const res = await fetch("/api/boardwatch/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, channel }),
      });
      const data = await res.json();
      if (!data.ok) {
        setBwStatus(data.error || "추가하지 못했어요.", true);
        return;
      }
      renderBoardWatchList(data.list);
      bwUrlInput.value = "";
      if (data.preview && data.preview.ok) {
        setBwStatus(`추가됐어요 · 목록에서 항목 ${data.preview.count}개를 찾았어요.`);
      } else {
        setBwStatus(`추가됐어요 · ${data.preview ? data.preview.error : "미리보기는 확인하지 못했어요."}`);
      }
    } catch {
      setBwStatus("서버에 연결할 수 없었어요.", true);
    } finally {
      bwAddBtn.disabled = false;
    }
  }

  async function removeBoardWatch(id) {
    try {
      const res = await fetch("/api/boardwatch/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, channel }),
      });
      const data = await res.json();
      if (!data.ok) {
        setBwStatus(data.error || "삭제하지 못했어요.", true);
        return;
      }
      renderBoardWatchList(data.list);
      setBwStatus("삭제했어요.");
    } catch {
      setBwStatus("서버에 연결할 수 없었어요.", true);
    }
  }

  bwAddBtn.addEventListener("click", addBoardWatch);
  bwUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBoardWatch();
  });

  loadBoardWatchList();
}

initBoardWatchSection({ channel: "default", ntfyTopic: "site-watch-alert-38c7bf5014", idSuffix: "" });

// ---- 유튜브 자막 ----

function fmtTime(sec, withMs) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return withMs ? `${base},${pad(ms % 1000, 3)}` : base;
}

function toSrt(segments) {
  return segments
    .map((seg, i) => `${i + 1}\n${fmtTime(seg.start, true)} --> ${fmtTime(seg.end, true)}\n${seg.text}\n`)
    .join("\n");
}

function toTxt(segments) {
  return segments.map((seg) => `[${fmtTime(seg.start)}] ${seg.text}`).join("\n");
}

function downloadFile(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initSubsBlock(block) {
  const mode = block.dataset.mode;
  const input = block.querySelector(".subs-input");
  const btn = block.querySelector(".subs-btn");
  const statusEl = block.querySelector(".subs-status");
  const progressEl = block.querySelector(".subs-progress");
  const barEl = block.querySelector(".subs-progress-bar");
  const resultEl = block.querySelector(".subs-result");
  const btnLabel = btn.textContent;

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("error", Boolean(isError));
  }

  function finish() {
    btn.disabled = false;
    btn.textContent = btnLabel;
    progressEl.hidden = true;
  }

  function renderResult(job) {
    const segments = job.segments || [];
    const fileBase = (job.title || "subtitles").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
    resultEl.innerHTML = "";

    const head = document.createElement("div");
    head.className = "subs-result-head";
    const info = document.createElement("div");
    info.style.minWidth = "0";
    const title = document.createElement("div");
    title.className = "subs-result-title";
    title.textContent = job.title || "";
    const meta = document.createElement("div");
    meta.className = "subs-result-meta";
    const cutoff = job.cutoff ? ` · ${new Date(job.cutoff).toLocaleTimeString("ko-KR")}까지` : "";
    meta.textContent = `${job.source} · ${segments.length}줄${cutoff}`;
    info.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "subs-actions";
    const mkBtn = (label, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "subs-action";
      b.textContent = label;
      b.addEventListener("click", onClick);
      actions.appendChild(b);
    };
    mkBtn("복사", () => {
      if (navigator.clipboard) navigator.clipboard.writeText(toTxt(segments)).catch(() => {});
      setStatus("자막을 복사했어요.");
    });
    mkBtn("TXT", () => downloadFile(`${fileBase}.txt`, toTxt(segments)));
    mkBtn("SRT", () => downloadFile(`${fileBase}.srt`, toSrt(segments)));
    head.append(info, actions);

    const lines = document.createElement("div");
    lines.className = "subs-lines";
    if (!segments.length) {
      lines.textContent = "인식된 말소리가 없어요.";
    }
    for (const seg of segments) {
      const row = document.createElement("div");
      row.className = "subs-line";
      const t = document.createElement("span");
      t.className = "subs-time mono";
      t.textContent = fmtTime(seg.start);
      const text = document.createElement("span");
      text.textContent = seg.text;
      row.append(t, text);
      lines.appendChild(row);
    }

    resultEl.append(head, lines);
    resultEl.hidden = false;
  }

  async function poll(id) {
    try {
      const res = await fetch(`/api/subs/status?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.ok) {
        setStatus(data.error || "작업 상태를 확인하지 못했어요.", true);
        finish();
        return;
      }
      const job = data.job;
      barEl.style.width = `${Math.round((job.progress || 0) * 100)}%`;
      if (job.status === "running") {
        setStatus([job.title, job.stage, job.note].filter(Boolean).join(" · "));
        setTimeout(() => poll(id), 2000);
        return;
      }
      finish();
      if (job.status === "error") {
        setStatus(job.error, true);
        return;
      }
      setStatus(job.note || "");
      renderResult(job);
    } catch {
      // 일시적인 연결 끊김은 다시 시도
      setTimeout(() => poll(id), 4000);
    }
  }

  async function start() {
    const url = input.value.trim();
    if (!url) {
      setStatus("유튜브 주소를 먼저 입력해주세요.", true);
      return;
    }
    btn.disabled = true;
    btn.textContent = "진행 중…";
    resultEl.hidden = true;
    barEl.style.width = "0";
    progressEl.hidden = false;
    setStatus("요청을 보내는 중…");
    try {
      const res = await fetch("/api/subs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, mode }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatus(data.error || "시작하지 못했어요.", true);
        finish();
        return;
      }
      poll(data.id);
    } catch {
      setStatus("서버에 연결할 수 없었어요.", true);
      finish();
    }
  }

  btn.addEventListener("click", start);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !btn.disabled) start();
  });
}

document.querySelectorAll(".subs-block").forEach(initSubsBlock);
