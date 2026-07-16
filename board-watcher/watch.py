import json
import re
import sys
import time
import urllib.request
from pathlib import Path

RETRY_ATTEMPTS = 4
RETRY_DELAY_SECONDS = 5

BOARD_URL = "http://w.todaysppc.com/mbbs/bbs.php?id=free"
VIEW_URL = "http://w.todaysppc.com/mbbs/view.php?id=free&page=1&no={no}"
TARGET_AUTHOR = "가을타타타"
NTFY_TOPIC = "gaeultatata-alert-c7e75b1ffb"
NTFY_URL = "https://ntfy.sh/"
STATE_FILE = Path(__file__).parent / "state.txt"

ROW_PATTERN = re.compile(
    r"<td class=small height=25>(\d+)</td>.*?"
    r"<a href=\"/mbbs/view\.php\?id=free&page=1&no=\1&ct=[^\"]*\"\s*>\s*"
    r"<font class=listoff_subject>([^<]+)</a>.*?"
    r"<font class=list_name><span[^>]*>([^<]*)</span>",
    re.DOTALL,
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


def _fetch_rows_once():
    req = urllib.request.Request(BOARD_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("euc-kr", errors="replace")
    rows = []
    for no, title, author in ROW_PATTERN.findall(html):
        rows.append((int(no), title.strip(), author.strip()))
    return rows


def fetch_rows():
    return with_retries(_fetch_rows_once)


def read_last_seen():
    if not STATE_FILE.exists():
        return None
    text = STATE_FILE.read_text().strip()
    return int(text) if text else None


def write_last_seen(value):
    STATE_FILE.write_text(str(value))


def _notify_once(no, title):
    payload = {
        "topic": NTFY_TOPIC,
        "title": f"{TARGET_AUTHOR} 새글",
        "message": title,
        "click": VIEW_URL.format(no=no),
    }
    req = urllib.request.Request(
        NTFY_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def notify(no, title):
    with_retries(_notify_once, no, title)


def main():
    try:
        rows = fetch_rows()
    except Exception as exc:
        print(f"fetch failed, skipping this run: {exc}", file=sys.stderr)
        return

    if not rows:
        print("no rows parsed, skipping this run", file=sys.stderr)
        return

    max_no_seen = max(no for no, _, _ in rows)
    last_seen = read_last_seen()

    if last_seen is None:
        # First run: establish a baseline without notifying about the existing backlog.
        write_last_seen(max_no_seen)
        print(f"baseline set to {max_no_seen}")
        return

    new_posts = sorted(
        (no, title) for no, title, author in rows
        if author == TARGET_AUTHOR and no > last_seen
    )

    if not new_posts:
        write_last_seen(max(max_no_seen, last_seen))
        return

    notified_up_to = last_seen
    for no, title in new_posts:
        try:
            notify(no, title)
        except Exception as exc:
            print(f"giving up on notifying {no} this run: {exc}", file=sys.stderr)
            break
        print(f"notified: {no} {title}")
        notified_up_to = no

    if notified_up_to > last_seen:
        # Only advance past what we actually managed to notify about, so
        # anything that failed (and everything after it) gets retried next run.
        write_last_seen(notified_up_to)


if __name__ == "__main__":
    main()
