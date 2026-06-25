"""Render multi-line promo copy (white, title bold) into top letterbox."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_BOLD = Path(r"C:\Windows\Fonts\msyhbd.ttc")
FONT_REG = Path(r"C:\Windows\Fonts\msyh.ttc")

WHITE = (255, 255, 255)

MARGIN_X_RATIO = 0.07
TITLE_BODY_GAP_RATIO = 0.5

BASE = Path(__file__).resolve().parent
DIR_9X16 = BASE / "9x16"
DIR_PUBLISH = BASE / "发图文"

# RGB all below this → letterbox black
BLACK_THRESH = 20


@dataclass(frozen=True)
class Line:
    text: str
    color: tuple[int, int, int]
    bold: bool = False


@dataclass(frozen=True)
class Figure:
    stem: str
    lines: list[Line]
    line_gap_ratio: float = 0.28
    pad_usage: float = 0.86
    min_letterbox_ratio: float = 0.14


def _is_black(px: tuple[int, int, int]) -> bool:
    return px[0] <= BLACK_THRESH and px[1] <= BLACK_THRESH and px[2] <= BLACK_THRESH


def find_content_top(img: Image.Image) -> int:
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    step = max(1, w // 48)
    for y in range(h):
        for x in range(0, w, step):
            if not _is_black(px[x, y]):
                return y
    return 0


def fit_font_size(
    draw: ImageDraw.ImageDraw,
    lines: list[Line],
    max_w: int,
    per_line_h: int,
    start_size: int,
) -> list[ImageFont.FreeTypeFont]:
    size = start_size
    while size > 10:
        fonts: list[ImageFont.FreeTypeFont] = []
        ok = True
        for line in lines:
            path = FONT_BOLD if line.bold else FONT_REG
            font = ImageFont.truetype(str(path), size)
            bbox = draw.textbbox((0, 0), line.text, font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            if tw > max_w or th > per_line_h:
                ok = False
                break
            fonts.append(font)
        if ok:
            return fonts
        size -= 1
    return [
        ImageFont.truetype(str(FONT_BOLD if ln.bold else FONT_REG), 10) for ln in lines
    ]


def ensure_letterbox(img: Image.Image, min_ratio: float = 0.14) -> tuple[Image.Image, int]:
    """If source has no top black bar, prepend one for copy overlay."""
    w, h = img.size
    content_top = find_content_top(img)
    min_h = int(h * min_ratio)
    if content_top >= min_h:
        return img, content_top
    pad = min_h - content_top
    canvas = Image.new("RGB", (w, h + pad), (0, 0, 0))
    canvas.paste(img, (0, pad))
    return canvas, min_h


def render_copy(
    src: Path,
    out: Path,
    lines: list[Line],
    *,
    line_gap_ratio: float = 0.28,
    pad_usage: float = 0.86,
    min_letterbox_ratio: float = 0.14,
) -> None:
    with Image.open(src) as raw:
        img = raw.convert("RGB")
    img, content_top = ensure_letterbox(img, min_letterbox_ratio)
    w, h = img.size
    pad_h = content_top if content_top > 0 else int(h * 0.14)

    # 重涂黑边，避免叠字 / 脏像素
    if content_top > 0:
        bar = Image.new("RGB", (w, content_top), (0, 0, 0))
        img.paste(bar, (0, 0))

    draw = ImageDraw.Draw(img)
    margin_x = int(w * MARGIN_X_RATIO)
    max_w = w - 2 * margin_x
    n = len(lines)
    per_line_h = max(28, int(pad_h * pad_usage / n))
    start_size = max(20, int(w * 0.038))
    if n >= 5:
        start_size = max(18, int(w * 0.034))
    line_gap = max(6, int(per_line_h * line_gap_ratio))
    title_extra = int(line_gap * TITLE_BODY_GAP_RATIO) if n > 1 else 0

    fonts = fit_font_size(draw, lines, max_w, per_line_h, start_size)
    heights: list[int] = []
    for line, font in zip(lines, fonts):
        bbox = draw.textbbox((0, 0), line.text, font=font)
        heights.append(bbox[3] - bbox[1])

    total_h = sum(heights) + line_gap * max(0, n - 1) + title_extra
    y = max(8, (content_top - total_h) // 2) if content_top > 0 else int(pad_h * 0.12)

    for i, (line, font, lh) in enumerate(zip(lines, fonts, heights)):
        bbox = draw.textbbox((0, 0), line.text, font=font)
        tw = bbox[2] - bbox[0]
        x = (w - tw) // 2 if i == 0 else margin_x
        draw.text((x, y), line.text, fill=line.color, font=font)
        y += lh + line_gap
        if i == 0 and n > 1:
            y += title_extra

    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "JPEG", quality=95, subsampling=0)
    print(f"saved: {out.name} ({content_top}px letterbox)")


FIGURES: list[Figure] = [
    Figure(
        "图00_官网落地",
        [
            Line("市面上叫「多 Agent」的产品很多", WHITE, bold=True),
            Line("多数其实是：多模型拼盘、写死的流程图、手动配几个「专家角色」", WHITE),
            Line("AgentCore 想做的不是这些。", WHITE),
            Line("CEO 看任务组队，该并行并行，该辩论辩论，该审查审查", WHITE),
            Line("后面 8 张图片，逐条展示给你看（内测中欢迎大家免费使用）。", WHITE),
        ],
        min_letterbox_ratio=0.22,
        line_gap_ratio=0.22,
        pad_usage=0.88,
    ),
    Figure(
        "图01_多方圆桌",
        [
            Line("很多 AI 是：你问一句，它答一句，答完就算交付。", WHITE, bold=True),
            Line("复杂方案呢？开工前先审一遍，过程中有人盯场，", WHITE),
            Line("交稿前还要多角色交叉看一遍——像项目组过会，不像一个人拍脑袋。", WHITE),
            Line("这是「多方圆桌」：不是聊天室里多开几个窗口，是有主持、有席次、有审查链。", WHITE),
        ],
        line_gap_ratio=0.26,
        pad_usage=0.86,
        min_letterbox_ratio=0.20,
    ),
    Figure(
        "图02_正反辩论",
        [
            Line("AI 直接给结论，你不知道它有没有想过反面", WHITE, bold=True),
            Line("这条是「故意有人跟你唱反调」。", WHITE),
            Line("正方立论、反方驳论、主持人收口——", WHITE),
            Line("不是抬杠，是把选项辩清楚再决策。", WHITE),
            Line("技术选型、方案取舍、风险争议，特别适合这一套。", WHITE),
        ],
        min_letterbox_ratio=0.20,
    ),
    Figure(
        "图03_全流程编排",
        [
            Line("项目一大，聊天框就扛不住了", WHITE, bold=True),
            Line("市场调研、方案辩论、设计架构……", WHITE),
            Line("谁先做、谁并行、谁等谁——不是你在对话里一步步催，", WHITE),
            Line("一张编排图里 CEO 自动排期。", WHITE),
            Line("你下的是目标，团队跑全流程——从调研到决策，不是聊到哪儿算哪儿。", WHITE),
        ],
        min_letterbox_ratio=0.22,
        line_gap_ratio=0.24,
    ),
    Figure(
        "图04_画布多轮",
        [
            Line("和 AI 聊了几十轮，还记不记得发生过什么？", WHITE, bold=True),
            Line("聊天记录是流水账——越翻越晕。", WHITE),
            Line("画布是脉络：每一轮对话占一格，", WHITE),
            Line("改过什么、哪轮派了团队，点进去还能看协作图。", WHITE),
            Line("从第一个问题到最终方案，一张图往回看，不用考古聊天记录。", WHITE),
        ],
        min_letterbox_ratio=0.22,
        line_gap_ratio=0.24,
    ),
    Figure(
        "图05_自动拆解",
        [
            Line("不只是一层派发：队员自己还能带队", WHITE, bold=True),
            Line("CEO 把大任务交给项目经理；任务再复杂，项目经理还能往下拆，", WHITE),
            Line("子 Agent 获权后再委派子 Agent，各自小队并行开工，", WHITE),
            Line("子队产出上卷、队长整合交付——像真公司分工", WHITE),
        ],
        min_letterbox_ratio=0.20,
        line_gap_ratio=0.26,
    ),
    Figure(
        "图06_CEO组队全景",
        [
            Line("答案就一张图：一个 CEO，按需组队。", WHITE, bold=True),
            Line("辩论、编排、拆解——到底是谁在调度？", WHITE),
            Line("其它多 Agent：预设几个角色，固定流程走一遍。", WHITE),
            Line("看任务编席——该谁上谁上，协作关系一张图摊开。", WHITE),
            Line("你下达目标，按需编排。", WHITE),
        ],
        min_letterbox_ratio=0.20,
        line_gap_ratio=0.24,
    ),
    Figure(
        "图07_工具箱",
        [
            Line("人和 AI 共用一套创作工作台。", WHITE, bold=True),
            Line("不止 MCP 和动作工具——文档、表格、画布等产物正在补齐。", WHITE),
            Line("Agent 写入，你随手改；同一文件，不是聊完就散。", WHITE),
        ],
        line_gap_ratio=0.28,
    ),
    Figure(
        "图08_手机云端并行",
        [
            Line("不限于电脑前。", WHITE, bold=True),
            Line("通勤、躺床上，一句话把任务扔给云端——", WHITE),
            Line("多个 Agent 并行开工，你可以锁屏、关 App、甚至关机；", WHITE),
            Line("跑完了推到你手机上。", WHITE),
            Line("你现在就能这么用。", WHITE),
        ],
        min_letterbox_ratio=0.22,
        line_gap_ratio=0.24,
    ),
]


def main() -> None:
    for fig in FIGURES:
        src = DIR_9X16 / f"{fig.stem}_9x16.jpg"
        out = DIR_PUBLISH / f"{fig.stem}_预览.jpg"
        if src.exists():
            render_copy(
                src,
                out,
                fig.lines,
                line_gap_ratio=fig.line_gap_ratio,
                pad_usage=fig.pad_usage,
                min_letterbox_ratio=fig.min_letterbox_ratio,
            )


if __name__ == "__main__":
    main()
