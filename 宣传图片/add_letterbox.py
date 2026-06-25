"""Add top/bottom black padding to reach 9:16 portrait canvas."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

SRC_DIR = Path(__file__).resolve().parent
OUT_DIR = SRC_DIR / "9x16"
SUFFIX = "_9x16"


def is_landscape(w: int, h: int) -> bool:
    return w >= h


def process_landscape(img: Image.Image) -> Image.Image:
    w, h = img.size
    canvas_w = w
    canvas_h = round(w * 16 / 9)
    canvas = Image.new("RGB", (canvas_w, canvas_h), (0, 0, 0))
    if h > canvas_h:
        scale = canvas_h / h
        new_w = round(w * scale)
        new_h = canvas_h
        resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        x = (canvas_w - new_w) // 2
        canvas.paste(resized, (x, 0))
        return canvas
    y = (canvas_h - h) // 2
    canvas.paste(img, (0, y))
    return canvas


def process_portrait(img: Image.Image) -> Image.Image:
    w, h = img.size
    target_h_at_w = w * 16 / 9

    if h <= target_h_at_w:
        canvas_w = w
        canvas_h = round(target_h_at_w)
        canvas = Image.new("RGB", (canvas_w, canvas_h), (0, 0, 0))
        y = (canvas_h - h) // 2
        canvas.paste(img, (0, y))
        return canvas

    # Taller than 9:16 at full width — scale uniformly to fit height, no side bars.
    canvas_h = round(target_h_at_w)
    scale = canvas_h / h
    new_w = round(w * scale)
    new_h = canvas_h
    canvas_w = new_w
    canvas = Image.new("RGB", (canvas_w, canvas_h), (0, 0, 0))
    resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    canvas.paste(resized, (0, 0))
    return canvas


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    for src in sorted(SRC_DIR.glob("图*.jpg")):
        if "_9x16" in src.name or src.name.endswith("_预览.jpg"):
            continue
        with Image.open(src) as img:
            rgb = img.convert("RGB")
            w, h = rgb.size
            out = process_landscape(rgb) if is_landscape(w, h) else process_portrait(rgb)
            out_path = OUT_DIR / f"{src.stem}{SUFFIX}.jpg"
            out.save(out_path, "JPEG", quality=95, subsampling=0)
            ow, oh = out.size
            mode = "landscape" if is_landscape(w, h) else "portrait"
            print(f"{src.name} ({w}x{h}, {mode}) -> {out_path.name} ({ow}x{oh})")


if __name__ == "__main__":
    main()
