import hashlib
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urljoin, urlparse, parse_qs, urlencode

RETRY_ATTEMPTS = 4
RETRY_DELAY_SECONDS = 5

NTFY_TOPIC = "site-watch-alert-38c7bf5014"
NTFY_URL = "https://ntfy.sh/"

HERE = Path(__file__).parent
WATCHES_FILE = HERE / "site-watches.json"
STATE_DIR = HERE / "state-cache" / "generic"

MAX_SEEN_PER_BOARD = 500
MIN_GROUP_SIZE = 4
MIN_TEXT_LEN = 4
SKIP_TEXT = {"다음", "이전", "처음", "마지막", "next", "prev", "list", "목록"}

ANCHOR_PATTERN = re.compile(r'<a\s+[^>]*href=["\']([^"\'#][^"\']*)["\'][^>]*>(.*?)</a>', re.DOTALL | re.IGNORECASE)
TAG_PATTERN = re.compile(r"<[^>]+>")
CHARSET_PATTERN = re.compile(rb'charset=["\']?([a-zA-Z0-9_-]+)', re.IGNORECASE)

# Board/detail-page links almost always carry one of these markers (view/read
# action, or a numeric post id param) — plain navigation/menu links usually
# don't, which keeps site-wide nav out of the candidate pool.
DETAIL_LINK_HINT = re.compile(
    r"(?:view|read|detail|article|post)|(?:[?&](?:no|seq|idx|id|num|wr_id|list_no|seq_no|content_no|docid|artid)=)",
    re.IGNORECASE,
)

# Many Korean government sites are built on eGovFrame (전자정부 표준프레임워크),
# whose board module renders each list row as a plain-looking
# href="javascript:fn_egov_select('NTT_ID');" link — no real href, so the
# generic href-pattern heuristic below can't see it (and can pick up
# something unrelated, like attachment download links, as a false positive
# instead). Detect this convention specifically and reconstruct the real
# detail-page URL from the page's own JS and the board URL's own query params.
EGOV_SELECT_LINK_PATTERN = re.compile(
    r"href=[\"']javascript:fn_egov_select\('([^']+)'\);?[\"'][^>]*>(.*?)</a>",
    re.DOTALL | re.IGNORECASE,
)
EGOV_ACTION_PATH_PATTERN = re.compile(
    r"function\s+fn_egov_select\s*\([^)]*\)\s*\{.*?\.action\s*=\s*\"([^\";]+)", re.DOTALL
)


def with_retries(func, *args, **kwargs):
    last_exc = None
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            return func(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
            print(f"attempt {attempt}/{RETRY_ATTEMPTS} failed: {exc}", file=sys.stderr)
            if attempt < RETRY_ATTEMPTS:
                time.sleep(RETRY_DELAY_SECONDS)
    raise last_exc


def _fetch_html_once(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        content_type = resp.headers.get("Content-Type", "")
    charset_m = re.search(r"charset=([a-zA-Z0-9_-]+)", content_type, re.IGNORECASE)
    charset = charset_m.group(1) if charset_m else None
    if not charset:
        meta_m = CHARSET_PATTERN.search(raw[:4096])
        charset = meta_m.group(1).decode("ascii") if meta_m else "utf-8"
    try:
        return raw.decode(charset, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def fetch_html(url):
    return with_retries(_fetch_html_once, url)


ENTITIES = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " ",
}
ENTITY_PATTERN = re.compile("|".join(re.escape(k) for k in ENTITIES))


def decode_entities(s):
    return ENTITY_PATTERN.sub(lambda m: ENTITIES[m.group(0)], s)


def normalize_pattern(href):
    return re.sub(r"\d+", "#", href)


def extract_egov_select_items(html, base_url):
    action_m = EGOV_ACTION_PATH_PATTERN.search(html)
    if not action_m:
        return []
    parsed_base = urlparse(base_url)
    qs = parse_qs(parsed_base.query)
    bbs_id = qs.get("bbsId", [None])[0]
    if not bbs_id:
        return []
    menu_no = qs.get("menuNo", [None])[0]
    detail_base = urljoin(base_url, action_m.group(1))

    items = []
    for m in EGOV_SELECT_LINK_PATTERN.finditer(html):
        ntt_id = m.group(1)
        title = decode_entities(TAG_PATTERN.sub("", m.group(2)).strip())
        if len(title) < MIN_TEXT_LEN:
            continue
        params = {"searchBbsId1": bbs_id, "searchNttId1": ntt_id}
        if menu_no:
            params["menuNo"] = menu_no
        items.append((f"{detail_base}?{urlencode(params)}", title))
    return items


def extract_items(html, base_url):
    egov_items = extract_egov_select_items(html, base_url)
    if egov_items:
        return egov_items

    groups = {}
    for m in ANCHOR_PATTERN.finditer(html):
        raw_href = decode_entities(m.group(1))
        text = decode_entities(TAG_PATTERN.sub("", m.group(2)).strip())
        if len(text) < MIN_TEXT_LEN or text.lower() in SKIP_TEXT:
            continue
        if not DETAIL_LINK_HINT.search(raw_href):
            continue
        abs_href = urljoin(base_url, raw_href)
        key = normalize_pattern(abs_href)
        groups.setdefault(key, []).append((abs_href, text))

    best = None
    for items in groups.values():
        if len(items) < MIN_GROUP_SIZE:
            continue
        if best is None or len(items) > len(best):
            best = items
    return best or []


def state_file_for(entry_id):
    return STATE_DIR / f"{entry_id}.json"


def read_seen(entry_id):
    f = state_file_for(entry_id)
    if not f.exists():
        return None
    try:
        return set(json.loads(f.read_text()).get("seen", []))
    except Exception:
        return None


def write_seen(entry_id, seen_hrefs):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    capped = list(seen_hrefs)[-MAX_SEEN_PER_BOARD:]
    state_file_for(entry_id).write_text(json.dumps({"seen": capped}, ensure_ascii=False, indent=2))


def _notify_once(url, title):
    payload = {
        "topic": NTFY_TOPIC,
        "title": "새 글 알림",
        "message": title,
        "click": url,
    }
    req = urllib.request.Request(
        NTFY_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def notify(url, title):
    with_retries(_notify_once, url, title)


def process_board(entry):
    entry_id = entry["id"]
    board_url = entry["url"]

    try:
        html = fetch_html(board_url)
    except Exception as exc:
        print(f"[{entry_id}] fetch failed, skipping this run: {exc}", file=sys.stderr)
        return

    items = extract_items(html, board_url)
    if not items:
        print(f"[{entry_id}] no list pattern detected, skipping this run", file=sys.stderr)
        return

    seen = read_seen(entry_id)
    current_hrefs = [href for href, _ in items]

    if seen is None:
        # First run for this board: establish a baseline without notifying about the backlog.
        write_seen(entry_id, current_hrefs)
        print(f"[{entry_id}] baseline set with {len(current_hrefs)} items")
        return

    new_items = [(href, text) for href, text in items if href not in seen]
    if not new_items:
        write_seen(entry_id, list(dict.fromkeys(current_hrefs + list(seen))))
        return

    notified_hrefs = []
    for href, text in reversed(new_items):  # oldest-looking new item first
        try:
            notify(href, text)
        except Exception as exc:
            print(f"[{entry_id}] giving up on notifying {href} this run: {exc}", file=sys.stderr)
            break
        print(f"[{entry_id}] notified: {text} {href}")
        notified_hrefs.append(href)

    if notified_hrefs:
        updated_seen = list(dict.fromkeys(current_hrefs + notified_hrefs + list(seen)))
        write_seen(entry_id, updated_seen)


def main():
    if not WATCHES_FILE.exists():
        print("no site-watches.json found, nothing to do")
        return
    try:
        entries = json.loads(WATCHES_FILE.read_text())
    except Exception as exc:
        print(f"failed to parse site-watches.json: {exc}", file=sys.stderr)
        return

    for entry in entries:
        process_board(entry)


if __name__ == "__main__":
    main()
