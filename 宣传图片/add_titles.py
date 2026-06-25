"""Draw titles into the top black letterbox of 9:16 promo images."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SRC_DIR = Path(__file__).resolve().parent / "9x16"
OUT_DIR = SRC_DIR / "titled"
FONT_BOLD = Path(r"C:\Windows\Fonts\msyhbd.ttc")
FONT_REG = Path(r"C:\Windows\Fonts\msyh.ttc")

TITLES: dict[str, str] = {
    "图00_官网落地": "协作，是更高级的智能",
    "图01_多方圆桌": "多方圆桌 · 多视角协作",
    "图02_手机云端并行": "云端并行 · 团队替你跑",
    "图03_正反辩论": "结构化正反辩论",
    "图04_工具箱": "工具箱 · 能力中心",
    "图05_全流程编排": "一次任务 · 全流程编排",
    "图06_画布多轮": "画布可视化协作",
    "图07_自动拆解": "自动拆解 · 小队并行",
    "图08_CEO组队全景": "不只是 Agent，是团队",
}

BRAND = "AgentCore"


def find_content_top(img: Image.Image) -> int:
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    step = max(1, w // 40)
    for y in range(h):
        for x in range(0, w, step):
            if px[x, y] != (0, 0, 0):
                return y
    return h


def fit_font(
    draw: ImageDraw.ImageDraw,
    text: str,
    font_path: Path,
    max_w: int,
    max_h: int,
    start_size: int,
) -> ImageFont.FreeTypeFont:
    size = start_size
    while size > 12:
        font = ImageFont.truetype(str(font_path), size)
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        if tw <= max_w and th <= max_h:
            return font
        size -= 2
    return ImageFont.truetype(str(font_path), 12)


def add_title(img: Image.Image, title: str) -> Image.Image:
    out = img.copy()
    draw = ImageDraw.Draw(out)
    w, h = out.size
    content_top = find_content_top(out)
    pad_h = content_top if content_top > 0 else int(h * 0.14)

    title_max_w = int(w * 0.9)
    title_max_h = int(pad_h * 0.55) if content_top > 0 else int(pad_h * 0.5)
    brand_max_h = int(pad_h * 0.28)

    start = max(28, int(w * 0.055))
    title_font = fit_font(draw, title, FONT_BOLD, title_max_w, title_max_h, start)
    brand_font = fit_font(draw, BRAND, FONT_REG, title_max_w, brand_max_h, max(18, start // 2))

    tb = draw.textbbox((0, 0), title, font=title_font)
    bb = draw.textbbox((0, 0), BRAND, font=brand_font)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    bw, bh = bb[2] - bb[0], bb[3] - bb[1]
    gap = max(6, pad_h // 20)
    block_h = th + gap + bh

    if content_top > 0:
        y0 = (content_top - block_h) // 2
    else:
        y0 = int(pad_h * 0.25)
        overlay_h = pad_h + int(h * 0.02)
        overlay = Image.new("RGBA", (w, overlay_h), (0, 0, 0, 180))
        out.paste(overlay, (0, 0), overlay)
        draw = ImageDraw.Draw(out)

    tx = (w - tw) // 2
    bx = (w - bw) // 2
    draw.text((tx, y0), title, fill=(255, 255, 255), font=title_font)
    draw.text((bx, y0 + th + gap), BRAND, fill=(160, 160, 160), font=brand_font)
    return out


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    for src in sorted(SRC_DIR.glob("图*_9x16.jpg")):
        if src.name.endswith("_预览.jpg") or src.name.endswith("_titled.jpg"):
            continue
        stem = src.stem.removesuffix("_9x16")
        title = TITLES.get(stem)
        if not title:
            print(f"skip (no title): {src.name}")
            continue
        with Image.open(src) as img:
            out = add_title(img.convert("RGB"), title)
            out_path = OUT_DIR / f"{stem}_9x16_titled.jpg"
            out.save(out_path, "JPEG", quality=95, subsampling=0)
            print(f"{src.name} -> {out_path.name} | {title}")


if __name__ == "__main__":
    main()
