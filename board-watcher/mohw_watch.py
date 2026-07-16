import json
import re
import sys
import time
import urllib.request
from pathlib import Path

RETRY_ATTEMPTS = 4
RETRY_DELAY_SECONDS = 5

NTFY_TOPIC = "mohw-board-alert-e9d27a85c9"
NTFY_URL = "https://ntfy.sh/"

HERE = Path(__file__).parent

BOARDS = [
    {
        "name": "보건복지부 보도자료",
        "list_url": "https://www.mohw.go.kr/board.es?mid=a10503010100&bid=0027",
        "view_url": "https://www.mohw.go.kr/board.es?mid=a10503010100&bid=0027&act=view&list_no={no}",
        "state_file": HERE / "mohw_press_release_state.txt",
    },
    {
        "name": "보건복지부 보도설명",
        "list_url": "https://www.mohw.go.kr/board.es?mid=a10504000000&bid=0030",
        "view_url": "https://www.mohw.go.kr/board.es?mid=a10504000000&bid=0030&act=view&list_no={no}",
        "state_file": HERE / "mohw_press_explain_state.txt",
    },
]

ROW_SPLIT_PATTERN = re.compile(r'(?=<tr>\s*\n\s*<td class="m_hidden" data-label="번호">)')
ROW_ITEM_PATTERN = re.compile(
    r'list_no=(\d+)&amp;tag=&amp;nPage=\d+"\s*class="txt_title">(.*?)</a>', re.DOTALL
)
TAG_PATTERN = re.compile(r"<[^>]+>")
DEPT_PATTERN = re.compile(r'data-label="담당부서">([^<]*)</td>')


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


def _fetch_rows_once(list_url):
    req = urllib.request.Request(list_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    rows = []
    for block in ROW_SPLIT_PATTERN.split(html):
        m = ROW_ITEM_PATTERN.search(block)
        if not m:
            continue
        no = int(m.group(1))
        title = TAG_PATTERN.sub("", m.group(2)).replace("새글", "").strip()
        dept_m = DEPT_PATTERN.search(block)
        dept = dept_m.group(1).strip() if dept_m else ""
        rows.append((no, title, dept))
    return rows


def fetch_rows(list_url):
    return with_retries(_fetch_rows_once, list_url)


def read_last_seen(state_file):
    if not state_file.exists():
        return None
    text = state_file.read_text().strip()
    return int(text) if text else None


def write_last_seen(state_file, value):
    state_file.write_text(str(value))


def _notify_once(board_name, title, dept, view_url):
    payload = {
        "topic": NTFY_TOPIC,
        "title": f"{board_name} 새글",
        "message": f"{title} ({dept})" if dept else title,
        "click": view_url,
    }
    req = urllib.request.Request(
        NTFY_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def notify(board_name, title, dept, view_url):
    with_retries(_notify_once, board_name, title, dept, view_url)


def process_board(board):
    try:
        rows = fetch_rows(board["list_url"])
    except Exception as exc:
        print(f"[{board['name']}] fetch failed, skipping this run: {exc}", file=sys.stderr)
        return

    if not rows:
        print(f"[{board['name']}] no rows parsed, skipping this run", file=sys.stderr)
        return

    state_file = board["state_file"]
    max_no_seen = max(no for no, _, _ in rows)
    last_seen = read_last_seen(state_file)

    if last_seen is None:
        # First run: establish a baseline without notifying about the existing backlog.
        write_last_seen(state_file, max_no_seen)
        print(f"[{board['name']}] baseline set to {max_no_seen}")
        return

    new_posts = sorted((no, title, dept) for no, title, dept in rows if no > last_seen)

    if not new_posts:
        write_last_seen(state_file, max(max_no_seen, last_seen))
        return

    notified_up_to = last_seen
    for no, title, dept in new_posts:
        view_url = board["view_url"].format(no=no)
        try:
            notify(board["name"], title, dept, view_url)
        except Exception as exc:
            print(f"[{board['name']}] giving up on notifying {no} this run: {exc}", file=sys.stderr)
            break
        print(f"[{board['name']}] notified: {no} {title}")
        notified_up_to = no

    if notified_up_to > last_seen:
        # Only advance past what we actually managed to notify about, so
        # anything that failed (and everything after it) gets retried next run.
        write_last_seen(state_file, notified_up_to)


def main():
    for board in BOARDS:
        process_board(board)


if __name__ == "__main__":
    main()
