#!/usr/bin/env python3
"""
grab_v2.py <thread_url> <staging_dir>

Improvements over grab.sh:
- Global URL dedup via <BASE>/seen_urls.txt (flock-protected)
- Polite throttling (0.4s between URL fetches) — avoids MFFA rate limiting
- Retry with exponential backoff on page fetch failure
- Skip-if-file-exists (resume support)
- Handles URL-encoded slugs (é etc.)
- Filters MUGEN-tools sidebar URLs by pattern
- No per-thread cap — rely on global dedup
"""

import fcntl
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

BASE = os.environ.get('BULKGRAB_BASE', '/home/maxh/bulkgrab')
SEEN_FILE = os.path.join(BASE, 'seen_urls.txt')
SEEN_LOCK = os.path.join(BASE, 'seen.lock')
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
THROTTLE = float(os.environ.get('THROTTLE', '0.4'))

TOOL_HASHES = {
    '6zvgfcdcoi393m5', '64k1cjviqg5cv92', '7t19la352uugtic', 'b1q936sdg24gpaf',
    'y31wj8objmc8v65', 'jf3i5z12c9zo9g5', '6r96tdsyg7ribil', 'u30u1za2akg51m3',
    '3g962n268f6j7aw', '4jwsqfss01566uv', 'wl9uo5iql1qksr6', '57crlu5lyft0zc0',
    'ky4k8yo2f2aqktp', 'dw5r9orsp4fviap', '9q8ebhntodbyvu9', '3yp2ff7v3fbdbxj',
    'c95zzx4t1lw4vjc',
}

URL_PATTERNS = [
    re.compile(r'https?://[^"<> \']+\.(rar|zip|7z)(?:/file|\b)?[^"<> \']*', re.IGNORECASE),
    re.compile(r'https?://mega\.nz/(?:file|#!)[^"<> \']+'),
    re.compile(r'https?://(?:www\.)?mediafire\.com/(?:\?|download\.php\?)[A-Za-z0-9]+'),
    re.compile(r'https?://(?:www\.)?(?:dl\.)?dropbox(?:usercontent)?\.com/[^"<> \']+'),
]


def log(staging, msg):
    with open(os.path.join(staging, 'grab.log'), 'a') as f:
        f.write(msg + '\n')
    print(msg, flush=True)


def fetch(url, retries=3):
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=45) as resp:
                return resp.read().decode('utf-8', errors='replace')
        except Exception as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise last_err


def scrape_thread(thread_url, staging):
    urls = set()
    try:
        html = fetch(thread_url)
    except Exception as e:
        log(staging, f'[ERR] page1 fetch failed: {e}')
        return []
    page_nums = re.findall(r'data-page="(\d+)"', html)
    last_page = max([int(x) for x in page_nums] + [1])
    log(staging, f'[thread] {thread_url} pages={last_page}')
    for page in range(1, last_page + 1):
        if page == 1:
            page_html = html
        else:
            try:
                page_html = fetch(thread_url.rstrip('/') + f'/page/{page}/')
            except Exception as e:
                log(staging, f'[warn] page {page} fetch failed: {e}')
                continue
        for pat in URL_PATTERNS:
            for m in pat.finditer(page_html):
                u = m.group(0).replace('&amp;', '&')
                if any(h in u for h in TOOL_HASHES):
                    continue
                urls.add(u)
        time.sleep(THROTTLE)
    return sorted(urls)


def mark_seen(url):
    os.makedirs(BASE, exist_ok=True)
    with open(SEEN_LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        seen = set()
        if os.path.exists(SEEN_FILE):
            with open(SEEN_FILE) as f:
                seen = set(line.strip() for line in f)
        if url in seen:
            return False
        with open(SEEN_FILE, 'a') as f:
            f.write(url + '\n')
        return True


def mediafire_direct(landing_url):
    try:
        html = fetch(landing_url)
    except Exception:
        return None
    m = re.search(r'https://download\d+\.mediafire\.com/[^"\']+', html)
    return m.group(0) if m else None


def safe_name(s, fallback):
    s = urllib.parse.unquote(s)
    s = re.sub(r'[^A-Za-z0-9._-]', '_', s)
    return s[:120] or fallback


def download(url, out_path):
    if os.path.exists(out_path) and os.path.getsize(out_path) > 2048:
        return True
    try:
        result = subprocess.run(
            ['curl', '-sL', '-A', UA, '--max-time', '300', '-o', out_path, url],
            timeout=360,
        )
        if result.returncode != 0:
            return False
        size = os.path.getsize(out_path) if os.path.exists(out_path) else 0
        if size < 2048:
            os.unlink(out_path)
            return False
        with open(out_path, 'rb') as f:
            head = f.read(200)
        if head.startswith(b'<!DOCTYPE') or head.startswith(b'<html'):
            os.unlink(out_path)
            return False
        return True
    except Exception:
        if os.path.exists(out_path):
            os.unlink(out_path)
        return False


def handle_mediafire(url, staging, idx):
    direct = mediafire_direct(url)
    if not direct:
        log(staging, f'[skip] mf no direct: {url}')
        return False
    fname = safe_name(os.path.basename(direct.split('?')[0]), f'mf_{idx}.bin')
    out = os.path.join(staging, 'mf', f'{idx}_{fname}')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if download(direct, out):
        log(staging, f'[ok] mf {url} -> {out}')
        return True
    log(staging, f'[fail] mf {url}')
    return False


def handle_mega(url, staging):
    out_dir = os.path.join(staging, 'mega')
    os.makedirs(out_dir, exist_ok=True)
    try:
        result = subprocess.run(
            ['megadl', '--no-progress', '--path', out_dir, url],
            capture_output=True, timeout=600, text=True,
        )
        if result.returncode == 0:
            log(staging, f'[ok] mega {url}')
            return True
        log(staging, f'[fail] mega {url} rc={result.returncode}')
        return False
    except Exception as e:
        log(staging, f'[fail] mega {url}: {e}')
        return False


def handle_dropbox(url, staging, idx):
    if '?dl=0' in url:
        dl_url = url.replace('?dl=0', '?dl=1')
    elif '?' in url and 'dl=' not in url:
        dl_url = url + '&dl=1'
    elif '?' not in url:
        dl_url = url + '?dl=1'
    else:
        dl_url = url
    fname = safe_name(os.path.basename(dl_url.split('?')[0]), f'db_{idx}.bin')
    out = os.path.join(staging, 'dropbox', f'{idx}_{fname}')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if download(dl_url, out):
        log(staging, f'[ok] dropbox {url} -> {out}')
        return True
    log(staging, f'[fail] dropbox {url}')
    return False


def main():
    if len(sys.argv) != 3:
        print('usage: grab_v2.py <thread_url> <staging_dir>', file=sys.stderr)
        sys.exit(2)
    thread_url = sys.argv[1]
    staging = sys.argv[2]
    os.makedirs(staging, exist_ok=True)
    open(os.path.join(staging, 'grab.log'), 'w').close()
    urls = scrape_thread(thread_url, staging)
    with open(os.path.join(staging, 'urls.txt'), 'w') as f:
        for u in urls:
            f.write(u + '\n')
    log(staging, f'[urls] {len(urls)} unique on this thread')
    ok = 0
    skipped_seen = 0
    for idx, url in enumerate(urls, start=1):
        if not mark_seen(url):
            skipped_seen += 1
            continue
        try:
            if 'mediafire.com' in url:
                success = handle_mediafire(url, staging, idx)
            elif 'mega.nz' in url:
                success = handle_mega(url, staging)
            elif 'dropbox' in url:
                success = handle_dropbox(url, staging, idx)
            else:
                success = False
            if success:
                ok += 1
        except Exception as e:
            log(staging, f'[err] {url}: {e}')
        time.sleep(THROTTLE)
    log(staging, f'[done] ok={ok} skipped_seen={skipped_seen} total_urls={len(urls)}')
    open(os.path.join(staging, 'DONE'), 'w').close()


if __name__ == '__main__':
    main()
