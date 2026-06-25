"""One-time rename: mmexport* → fig{NN}_{slug}. Run from 宣传图片/."""
from __future__ import annotations

from pathlib import Path

BASE = Path(__file__).resolve().parent
DIR_9X16 = BASE / "9x16"

# old stem (mmexport….) → new basename without extension
MAP: dict[str, str] = {
    "mmexport1782107449483.": "fig00_landing",
    "mmexport1782107423947.": "fig01_debate_roundtable",
    "mmexport1782107427308.": "fig02_parallel_mobile",
    "mmexport1782107444478.": "fig03_debate_procon",
    "mmexport1782149710586.": "fig04_toolbox",
    "mmexport1782176236469.": "fig05_pipeline",
    "mmexport1782176377066.": "fig06_canvas",
    "mmexport1782199689956.": "fig07_decompose",
    "mmexport1782199738440.": "fig08_team_panorama",
}

PREVIEW_MAP: dict[str, str] = {
    "preview_landing_v2.jpg": "fig00_landing_preview.jpg",
    "preview_debate_v1.jpg": "fig01_debate_roundtable_preview.jpg",
    "preview_parallel_g1.jpg": "fig02_parallel_mobile_preview.jpg",
    "preview_debate_procon_h4.jpg": "fig03_debate_procon_preview.jpg",
    "preview_toolbox_j4.jpg": "fig04_toolbox_preview.jpg",
    "preview_pipeline_kc5.jpg": "fig05_pipeline_preview.jpg",
    "preview_canvas_la2.jpg": "fig06_canvas_preview.jpg",
    "preview_decompose_n1.jpg": "fig07_decompose_preview.jpg",
    "preview_team_pb.jpg": "fig08_team_panorama_preview.jpg",
}


def rename_if_exists(src: Path, dst: Path) -> None:
    if not src.exists():
        print(f"skip (missing): {src.name}")
        return
    if dst.exists():
        print(f"skip (exists): {dst.name}")
        return
    src.rename(dst)
    print(f"{src.name} -> {dst.name}")


def main() -> None:
    for old_stem, new_base in MAP.items():
        rename_if_exists(BASE / f"{old_stem}.jpg", BASE / f"{new_base}.jpg")
        rename_if_exists(DIR_9X16 / f"{old_stem}_9x16.jpg", DIR_9X16 / f"{new_base}_9x16.jpg")

    titled = DIR_9X16 / "titled"
    if titled.is_dir():
        for old_stem, new_base in MAP.items():
            old = titled / f"{old_stem}_9x16_titled.jpg"
            rename_if_exists(old, titled / f"{new_base}_9x16_titled.jpg")

    for old_name, new_name in PREVIEW_MAP.items():
        rename_if_exists(DIR_9X16 / old_name, DIR_9X16 / new_name)


if __name__ == "__main__":
    main()
