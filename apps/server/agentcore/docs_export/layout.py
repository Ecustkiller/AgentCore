"""Layout presets shared by the deterministic document exporters (docx / pdf).

首行缩进两字是中文正式文书的通例，放到技术文档上却很怪；Markdown 本身不带
「这是不是公文」的信号。所以档位由调用方（工具入参 / 导出菜单 / HTTP）显式给出，
转换器**不**看正文内容猜——没有任何内容启发式。一级标题居中不在档位内：Word
大标题居中是通例，两个档位都开。

两档共用：A4、小四正文、标题黑色、正文/列表 1.5 倍行距。official 另开两端对齐、
公文页边距、页码「— n —」——仍是通例，不是 GB/T 9704 红头。PDF 跟同一把尺子
（字号 / 页边距 / 行高 / 页码），不做第二套视觉。
"""

from __future__ import annotations

from typing import Final, Literal

DocLayout = Literal["standard", "official"]

LAYOUT_STANDARD: Final[DocLayout] = "standard"
LAYOUT_OFFICIAL: Final[DocLayout] = "official"

DOC_LAYOUTS: Final[tuple[DocLayout, ...]] = (LAYOUT_STANDARD, LAYOUT_OFFICIAL)

# 中文公文通例：正文首行缩进两个字符（随字号走，不是固定磅值）。
FIRST_LINE_INDENT_CHARS: Final[int] = 2

# 正文/列表行距（倍数）。标题、代码保持紧凑，不吃这一档。表格单元格跟正文同一倍数。
LINE_SPACING_MULTIPLE: Final[float] = 1.5
# 1.5 倍之后段后 6pt 会偏松；3pt 只作段间气口。
BODY_SPACE_AFTER_PT: Final[int] = 3

# 小四。诉讼/公文三号是另一档字号，改它会动版心——两档都钉小四。
BODY_PT: Final[int] = 12
HEADING_PT: Final[dict[int, int]] = {1: 22, 2: 18, 3: 16, 4: 14}
CODE_PT: Final[int] = 10
# 页码跟正文同一字号，正式文书不像网页页脚。
PAGE_NUMBER_PT: Final[int] = BODY_PT

# 标题黑色（不是产品 UI 深灰）。
HEADING_COLOR_RGB: Final[tuple[int, int, int]] = (0, 0, 0)

# A4。python-docx 默认 Letter，中文交付件必须显式钉死。
A4_WIDTH_CM: Final[float] = 21.0
A4_HEIGHT_CM: Final[float] = 29.7

# (top, bottom, left, right) cm。standard ≈ Word 默认；official ≈ 公文版心通例。
STANDARD_MARGINS_CM: Final[tuple[float, float, float, float]] = (2.54, 2.54, 3.17, 3.17)
OFFICIAL_MARGINS_CM: Final[tuple[float, float, float, float]] = (3.7, 3.5, 2.8, 2.6)

# 图宽略小于版心，避免顶到边。
IMAGE_WIDTH_PAD_CM: Final[float] = 0.1

# official 页脚距纸边：落在下页边距内，页码在版心下沿附近，不是贴底 1.27cm。
OFFICIAL_FOOTER_DISTANCE_CM: Final[float] = 2.0

LANG_LATIN: Final[str] = "en-US"
LANG_EAST_ASIA: Final[str] = "zh-CN"

# 工具 schema 复用同一段措辞，两个导出器口径一致。版式细则在转换器，不进每轮按钮。
LAYOUT_PARAM_DESCRIPTION: Final[str] = (
    "standard=技术文档（默认）；official=中文正式文书排版。"
)

LAYOUT_INVALID_MESSAGE: Final[str] = (
    f"layout 须为 {' / '.join(DOC_LAYOUTS)}（留空 = {LAYOUT_STANDARD}）。"
)


def parse_layout(value: object) -> DocLayout | None:
    """Map a caller-supplied layout token to a preset; ``None`` when unrecognized.

    Empty / missing → ``standard``（现状默认）。未知取值返回 ``None``，由调用方明确
    报错——静默降级会让用户以为拿到了公文排版。
    """
    token = str(value or "").strip().lower()
    if not token:
        return LAYOUT_STANDARD
    if token == LAYOUT_OFFICIAL:
        return LAYOUT_OFFICIAL
    if token == LAYOUT_STANDARD:
        return LAYOUT_STANDARD
    return None


def margins_cm(layout: DocLayout) -> tuple[float, float, float, float]:
    """``(top, bottom, left, right)`` centimetres for ``layout``."""
    return OFFICIAL_MARGINS_CM if layout == LAYOUT_OFFICIAL else STANDARD_MARGINS_CM


def content_width_cm(layout: DocLayout) -> float:
    """Usable width between left and right margins."""
    _top, _bottom, left, right = margins_cm(layout)
    return A4_WIDTH_CM - left - right


def image_width_cm(layout: DocLayout) -> float:
    """Embedded image width: 版心减去一点边，永不顶格。"""
    return max(content_width_cm(layout) - IMAGE_WIDTH_PAD_CM, 1.0)


def first_line_indent_mm(font_size_pt: float) -> float:
    """Two CJK ems in millimetres (PDF user units when ``unit=mm``)."""
    return FIRST_LINE_INDENT_CHARS * font_size_pt * 25.4 / 72


def line_height_mm(font_size_pt: float) -> float:
    """1.5× line height in millimetres."""
    return font_size_pt * LINE_SPACING_MULTIPLE * 25.4 / 72
