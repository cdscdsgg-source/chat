const GITHUB_API = "https://api.github.com";
const REPO = process.env.GITHUB_REPO || "cdscdsgg-source/chat";
const BRANCH = process.env.GITHUB_BRANCH || "master";
const FILE_PATH = "board-watcher/site-watches.json";

function token() {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error("서버에 GITHUB_TOKEN이 설정되어 있지 않아요.");
  return t;
}

async function githubRequest(path, options = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return res;
}

async function getWatchList() {
  const res = await githubRequest(`/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`);
  if (res.status === 404) {
    return { list: [], sha: null };
  }
  if (!res.ok) {
    throw new Error(`GitHub 조회 실패 (HTTP ${res.status})`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { list: content.trim() ? JSON.parse(content) : [], sha: data.sha };
}

async function saveWatchList(list, sha, message) {
  const content = Buffer.from(JSON.stringify(list, null, 2) + "\n", "utf-8").toString("base64");
  const body = { message, content, branch: BRANCH };
  if (sha) body.sha = sha;
  const res = await githubRequest(`/repos/${REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 저장 실패 (HTTP ${res.status}): ${text}`);
  }
  return res.json();
}

module.exports = { getWatchList, saveWatchList };
