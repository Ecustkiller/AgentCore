#!/usr/bin/env python3
"""Generate Android launcher icons from AgentCore orbit brand assets.

Source masters (repo root):
  assets/agentcore-icon-orbit-cropped.png  — full-bleed 1024 (adaptive fg + legacy)
  assets/agentcore-icon-orbit-rounded.png  — rounded 1024 (legacy round)

Outputs under apps/mobile/android/app/src/main/res/mipmap-*/:
  ic_launcher_foreground.png  — adaptive foreground (108dp canvas)
  ic_launcher.png             — legacy launcher
  ic_launcher_round.png       — legacy round launcher

Also prints the sampled adaptive background color (update
values/ic_launcher_background.xml if it drifts).

Usage (from repo root or apps/mobile):
  python apps/mobile/scripts/generate-android-launcher-icons.py
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from PIL import Image

# Density → size in px
# Adaptive foreground: 108dp; legacy launcher: 48dp
FOREGROUND_SIZES = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}
LAUNCHER_SIZES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

SCRIPT_DIR = Path(__file__).resolve().parent
MOBILE_DIR = SCRIPT_DIR.parent
REPO_ROOT = MOBILE_DIR.parent.parent
RES_DIR = MOBILE_DIR / "android" / "app" / "src" / "main" / "res"

CROPPED = REPO_ROOT / "assets" / "agentcore-icon-orbit-cropped.png"
ROUNDED = REPO_ROOT / "assets" / "agentcore-icon-orbit-rounded.png"


def _resize(src: Image.Image, size: int) -> Image.Image:
    return src.resize((size, size), Image.Resampling.LANCZOS)


def sample_background_hex(im: Image.Image) -> str:
    """Most common opaque dark pixel → #RRGGBB (corners dominate orbit masters)."""
    rgba = im.convert("RGBA")
    opaque: list[tuple[int, int, int]] = []
    for r, g, b, a in rgba.getdata():
        if a > 200:
            opaque.append((r, g, b))
    dark = [
        c
        for c in opaque
        if (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) < 40
    ]
    pool = dark or opaque
    (r, g, b), _ = Counter(pool).most_common(1)[0]
    return f"#{r:02X}{g:02X}{b:02X}"


def main() -> None:
    if not CROPPED.is_file():
        raise SystemExit(f"missing source: {CROPPED}")
    if not ROUNDED.is_file():
        raise SystemExit(f"missing source: {ROUNDED}")

    cropped = Image.open(CROPPED).convert("RGBA")
    rounded = Image.open(ROUNDED).convert("RGBA")
    bg = sample_background_hex(cropped)
    print(f"sampled adaptive background: {bg}")
    print(f"res dir: {RES_DIR}")

    for density, size in FOREGROUND_SIZES.items():
        out_dir = RES_DIR / f"mipmap-{density}"
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / "ic_launcher_foreground.png"
        _resize(cropped, size).save(path, format="PNG", optimize=True)
        print(f"  wrote {path.relative_to(MOBILE_DIR)} ({size}x{size})")

    for density, size in LAUNCHER_SIZES.items():
        out_dir = RES_DIR / f"mipmap-{density}"
        out_dir.mkdir(parents=True, exist_ok=True)
        legacy = out_dir / "ic_launcher.png"
        round_path = out_dir / "ic_launcher_round.png"
        _resize(cropped, size).save(legacy, format="PNG", optimize=True)
        _resize(rounded, size).save(round_path, format="PNG", optimize=True)
        print(f"  wrote {legacy.relative_to(MOBILE_DIR)} ({size}x{size})")
        print(f"  wrote {round_path.relative_to(MOBILE_DIR)} ({size}x{size})")

    color_xml = RES_DIR / "values" / "ic_launcher_background.xml"
    color_xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        f'    <color name="ic_launcher_background">{bg}</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )
    print(f"  wrote {color_xml.relative_to(MOBILE_DIR)} → {bg}")
    print("done.")


if __name__ == "__main__":
    main()
