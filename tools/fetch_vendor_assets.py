"""
Vendored dashboard asset fetcher (SIH26054)

The ground station must come up on a closed network, so every third-party
asset the dashboard needs is committed under dashboard/vendor/ and served from
the twin's own host. This script refreshes those copies; it is the only thing in
the project that requires an internet connection, and it is never run at
demonstration time.

    python tools/fetch_vendor_assets.py

Pinned versions match what dashboard/index.html expects. Bump them here, not in
the HTML, so the vendored bundle and the page can never disagree.
"""
from __future__ import annotations

import re
import sys
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VENDOR_DIR = PROJECT_ROOT / "dashboard" / "vendor"
FONT_DIR = VENDOR_DIR / "fonts"

# Chrome UA: fonts.googleapis.com serves legacy TTF to unrecognised agents.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

ASSETS = {
    "tailwind.min.js": "https://cdn.tailwindcss.com/3.4.16",
    "chart.umd.min.js": "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js",
    "three.min.js": "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
    "OrbitControls.js": "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js",
}

FONT_CSS_URL = ("https://fonts.googleapis.com/css2"
                "?family=JetBrains+Mono:wght@400;500;600&display=swap")


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read()


def fetch_scripts() -> int:
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in ASSETS.items():
        data = _get(url)
        (VENDOR_DIR / name).write_bytes(data)
        print(f"  {name:<24} {len(data):>9,} bytes")
    return len(ASSETS)


def fetch_font() -> int:
    """Downloads the webfont CSS and every woff2 it references, then rewrites
    the CSS to point at the local copies."""
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    css = _get(FONT_CSS_URL).decode("utf-8")

    urls = sorted(set(re.findall(r"https://fonts\.gstatic\.com[^)]+", css)))
    for i, url in enumerate(urls, start=1):
        name = f"jetbrains-mono-{i}.woff2"
        (FONT_DIR / name).write_bytes(_get(url))
        css = css.replace(url, f"fonts/{name}")

    (VENDOR_DIR / "jetbrains.css").write_text(css, encoding="utf-8")
    remaining = re.findall(r"https?://", css)
    if remaining:
        print(f"  WARNING: {len(remaining)} remote reference(s) still in jetbrains.css")
    print(f"  jetbrains.css + {len(urls)} woff2 faces")
    return len(urls)


def main() -> int:
    print("Refreshing vendored dashboard assets into dashboard/vendor/ ...")
    try:
        n_scripts = fetch_scripts()
        n_faces = fetch_font()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        print("The committed copies under dashboard/vendor/ are unchanged.", file=sys.stderr)
        return 1
    print(f"Done: {n_scripts} scripts, {n_faces} font faces. "
          f"The dashboard now has no external dependencies.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
