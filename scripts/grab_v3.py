#!/usr/bin/env python3
"""
grab_v3.py <thread_url> <staging_dir>

Superset of grab_v2.py that also handles:
- Google Drive (via gdown)
- OneDrive / 1drv.ms (via Playwright)
- ux.getuploader.com (via Playwright — Cloudflare JS challenge)

Everything else (MediaFire, Mega, Dropbox) works the same as v2.
"""

import fcntl
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

BASE = os.environ.get('BULKGRAB_BASE', '/home/maxh/bulkgrab')
SEEN_FILE = os.path.join(BASE, 'seen_urls.txt')
SEEN_LOCK = os.path.join(BASE, 'seen.lock')
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
THROTTLE = float(os.environ.get('THROTTLE', '0.4'))
VENV_PY = os.environ.get('VENV_PY', '/home/maxh/workspace/MugenBattle/.venv/bin/python')
VENV_GDOWN = os.environ.get('VENV_GDOWN', '/home/maxh/workspace/MugenBattle/.venv/bin/gdown')

TOOL_HASHES = {
    '6zvgfcdcoi393m5', '64k1cjviqg5cv92', '7t19la352uugtic', 'b1q936sdg24gpaf',
    'y31wj8objmc8v65', 'jf3i5z12c9zo9g5', '6r96tdsyg7ribil', 'u30u1za2akg51m3',
    '3g962n268f6j7aw', '4jwsqfss01566uv', 'wl9uo5iql1qksr6', '57crlu5lyft0zc0',
    'ky4k8yo2f2aqktp', 'dw5r9orsp4fviap', '9q8ebhntodbyvu9', '3yp2ff7v3fbdbxj',
    'c95zzx4t1lw4vjc',
}

URL_PATTERNS = [
    re.compile(r'https?://[^"<>\s\']+\.(?:rar|zip|7z)(?:/file|\b)?[^"<>\s\']*', re.IGNORECASE),
    re.compile(r'https?://mega\.nz/(?:file|#!)[^"<>\s\']+'),
    re.compile(r'https?://(?:www\.)?mediafire\.com/(?:\?|download\.php\?)[A-Za-z0-9]+'),
    re.compile(r'https?://(?:www\.)?(?:dl\.)?dropbox(?:usercontent)?\.com/[^"<>\s\']+'),
    re.compile(r'https?://drive\.google\.com/[^"<>\s\']+'),
    re.compile(r'https?://(?:1drv\.ms|onedrive\.live\.com)/[^"<>\s\']+'),
    re.compile(r'https?://u[ux]?\.getuploader\.com/[^"<>\s\']+'),
]

MAX_URLS = int(os.environ.get('MAX_URLS', '0'))


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


def looks_ok(out_path):
    if not os.path.exists(out_path):
        return False
    size = os.path.getsize(out_path)
    if size < 2048:
        return False
    with open(out_path, 'rb') as f:
        head = f.read(200)
    if head.startswith(b'<!DOCTYPE') or head.startswith(b'<html'):
        return False
    return True


def curl_download(url, out_path):
    if os.path.exists(out_path) and os.path.getsize(out_path) > 2048:
        return True
    try:
        subprocess.run(
            ['curl', '-sL', '-A', UA, '--max-time', '300', '-o', out_path, url],
            timeout=360,
        )
        if not looks_ok(out_path):
            if os.path.exists(out_path):
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
    if curl_download(direct, out):
        log(staging, f'[ok] mf {url} -> {out}')
        return True
    log(staging, f'[fail] mf {url}')
    return False


def handle_mega(url, staging):
    out_dir = os.path.join(staging, 'mega')
    os.makedirs(out_dir, exist_ok=True)
    # Use start_new_session so we can kill the whole subprocess group on timeout
    try:
        proc = subprocess.Popen(
            ['megadl', '--no-progress', '--path', out_dir, url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            rc = proc.wait(timeout=180)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(proc.pid), 9)
            log(staging, f'[fail] mega timeout {url}')
            return False
        if rc == 0:
            log(staging, f'[ok] mega {url}')
            return True
        log(staging, f'[fail] mega {url} rc={rc}')
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
    if curl_download(dl_url, out):
        log(staging, f'[ok] dropbox {url} -> {out}')
        return True
    log(staging, f'[fail] dropbox {url}')
    return False


def extract_gdrive_id(url):
    m = re.search(r'/file/d/([A-Za-z0-9_-]+)', url)
    if m:
        return m.group(1)
    m = re.search(r'[?&]id=([A-Za-z0-9_-]+)', url)
    if m:
        return m.group(1)
    m = re.search(r'/folders/([A-Za-z0-9_-]+)', url)
    if m:
        return 'FOLDER:' + m.group(1)
    return None


def handle_gdrive(url, staging, idx):
    file_id = extract_gdrive_id(url)
    if not file_id:
        log(staging, f'[skip] gdrive bad url: {url}')
        return False
    if file_id.startswith('FOLDER:'):
        folder_id = file_id[len('FOLDER:'):]
        out_dir = os.path.join(staging, 'gdrive', f'{idx}_folder_{folder_id}')
        os.makedirs(out_dir, exist_ok=True)
        try:
            result = subprocess.run(
                [VENV_GDOWN, '--folder', '-O', out_dir, f'https://drive.google.com/drive/folders/{folder_id}'],
                capture_output=True, timeout=900, text=True,
            )
            if result.returncode == 0:
                log(staging, f'[ok] gdrive-folder {url} -> {out_dir}')
                return True
            log(staging, f'[fail] gdrive-folder {url} rc={result.returncode}')
            return False
        except Exception as e:
            log(staging, f'[fail] gdrive-folder {url}: {e}')
            return False
    # Single file: try gdown, then fall back to Playwright
    out = os.path.join(staging, 'gdrive', f'{idx}_{file_id}.bin')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        result = subprocess.run(
            [VENV_GDOWN, '-O', out, f'https://drive.google.com/uc?id={file_id}'],
            capture_output=True, timeout=600, text=True,
        )
        if result.returncode == 0 and looks_ok(out):
            log(staging, f'[ok] gdrive {url} -> {out}')
            return True
        if os.path.exists(out):
            os.unlink(out)
    except Exception:
        pass
    # Playwright fallback: render the preview page, click download button
    try:
        _, _, ctx = _get_playwright_ctx()
    except Exception as e:
        log(staging, f'[fail] gdrive pw init {url}: {e}')
        return False
    page = ctx.new_page()
    try:
        page.goto(f'https://drive.google.com/file/d/{file_id}/view', timeout=30000)
        try:
            page.wait_for_load_state('networkidle', timeout=10000)
        except Exception:
            pass
        # Click the "..." menu or download button
        dl_btn = page.query_selector('div[aria-label="Download"], [data-tooltip="Download"], [aria-label*="Download"]')
        if not dl_btn:
            log(staging, f'[fail] gdrive pw no-btn {url}')
            return False
        with page.expect_download(timeout=45000) as dl_info:
            dl_btn.click()
        download = dl_info.value
        fname = safe_name(download.suggested_filename or f'gd_{idx}.bin', f'gd_{idx}.bin')
        out2 = os.path.join(staging, 'gdrive', f'{idx}_{fname}')
        download.save_as(out2)
        if looks_ok(out2):
            log(staging, f'[ok] gdrive-pw {url} -> {out2}')
            return True
        if os.path.exists(out2):
            os.unlink(out2)
        return False
    except Exception as e:
        log(staging, f'[fail] gdrive-pw {url}: {type(e).__name__}')
        return False
    finally:
        try:
            page.close()
        except Exception:
            pass


_playwright_ctx = None

def _get_playwright_ctx():
    """Lazy-start a single Playwright browser/context for all browser downloads in this process."""
    global _playwright_ctx
    if _playwright_ctx is not None:
        return _playwright_ctx
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(
        accept_downloads=True,
        user_agent=UA,
    )
    _playwright_ctx = (pw, browser, ctx)
    return _playwright_ctx


def _close_playwright_ctx():
    global _playwright_ctx
    if _playwright_ctx is None:
        return
    pw, browser, ctx = _playwright_ctx
    try:
        ctx.close()
        browser.close()
        pw.stop()
    except Exception:
        pass
    _playwright_ctx = None


def handle_playwright_download(url, out_dir, idx, staging, host_tag):
    """Generic: load URL, expect a download (either auto-triggered or via submit button)."""
    try:
        _, _, ctx = _get_playwright_ctx()
    except Exception as e:
        log(staging, f'[fail] {host_tag} playwright init: {e}')
        return False
    os.makedirs(out_dir, exist_ok=True)
    page = ctx.new_page()
    try:
        page.goto(url, timeout=30000)
        try:
            page.wait_for_load_state('networkidle', timeout=15000)
        except Exception:
            pass
        download = None
        # Common: getuploader.com has <input type=submit name=yes>
        submit = page.query_selector('input[type="submit"][name="yes"]')
        if submit:
            with page.expect_download(timeout=30000) as dl_info:
                submit.click()
            download = dl_info.value
        else:
            # Look for a download link (common on OneDrive after JS redirect)
            # OneDrive 1drv.ms short URLs redirect to a full onedrive page with a Download button.
            dl_button = page.query_selector('button[data-automationid="downloadButton"], button[aria-label*="Download"], a[aria-label*="Download"]')
            if dl_button:
                with page.expect_download(timeout=30000) as dl_info:
                    dl_button.click()
                download = dl_info.value
            else:
                # Maybe the page IS the download (autotrigger)
                try:
                    with page.expect_download(timeout=5000) as dl_info:
                        pass
                    download = dl_info.value
                except Exception:
                    pass
        if download is None:
            log(staging, f'[fail] {host_tag} no download trigger: {url}')
            return False
        fname = safe_name(download.suggested_filename or f'{host_tag}_{idx}.bin', f'{host_tag}_{idx}.bin')
        out = os.path.join(out_dir, f'{idx}_{fname}')
        download.save_as(out)
        if not looks_ok(out):
            if os.path.exists(out):
                os.unlink(out)
            log(staging, f'[fail] {host_tag} bogus download: {url}')
            return False
        log(staging, f'[ok] {host_tag} {url} -> {out}')
        return True
    except Exception as e:
        log(staging, f'[fail] {host_tag} {url}: {type(e).__name__}: {str(e)[:200]}')
        return False
    finally:
        try:
            page.close()
        except Exception:
            pass


def handle_getuploader(url, staging, idx):
    return handle_playwright_download(url, os.path.join(staging, 'uploader'), idx, staging, 'upl')


def handle_onedrive(url, staging, idx):
    return handle_playwright_download(url, os.path.join(staging, 'onedrive'), idx, staging, 'od')


def main():
    if len(sys.argv) != 3:
        print('usage: grab_v3.py <thread_url> <staging_dir>', file=sys.stderr)
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
    if MAX_URLS and len(urls) > MAX_URLS:
        urls = urls[:MAX_URLS]
        log(staging, f'[cap] limiting to first {MAX_URLS}')
    ok = 0
    skipped_seen = 0
    try:
        for idx, url in enumerate(urls, start=1):
            if not mark_seen(url):
                skipped_seen += 1
                continue
            try:
                if 'mediafire.com' in url.lower():
                    success = handle_mediafire(url, staging, idx)
                elif 'mega.nz' in url.lower():
                    success = handle_mega(url, staging)
                elif 'dropbox' in url.lower():
                    success = handle_dropbox(url, staging, idx)
                elif 'drive.google.com' in url.lower():
                    success = handle_gdrive(url, staging, idx)
                elif 'onedrive.live.com' in url.lower() or '1drv.ms' in url.lower():
                    success = handle_onedrive(url, staging, idx)
                elif 'getuploader.com' in url.lower():
                    success = handle_getuploader(url, staging, idx)
                else:
                    success = False
                if success:
                    ok += 1
            except Exception as e:
                log(staging, f'[err] {url}: {e}')
            time.sleep(THROTTLE)
    finally:
        _close_playwright_ctx()
    log(staging, f'[done] ok={ok} skipped_seen={skipped_seen} total_urls={len(urls)}')
    open(os.path.join(staging, 'DONE'), 'w').close()


if __name__ == '__main__':
    main()
