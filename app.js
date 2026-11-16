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
