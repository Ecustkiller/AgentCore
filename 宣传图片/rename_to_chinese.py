"""Rename fig* English basenames → 图NN_中文. Run from 宣传图片/."""
from __future__ import annotations

from pathlib import Path

BASE = Path(__file__).resolve().parent
DIR_9X16 = BASE / "9x16"

MAP: dict[str, str] = {
    "fig00_landing": "图00_官网落地",
    "fig01_debate_roundtable": "图01_多方圆桌",
    "fig02_debate_procon": "图02_正反辩论",
    "fig03_pipeline": "图03_全流程编排",
    "fig04_canvas": "图04_画布多轮",
    "fig05_decompose": "图05_自动拆解",
    "fig06_team_panorama": "图06_CEO组队全景",
    "fig07_toolbox": "图07_工具箱",
    "fig08_parallel_mobile": "图08_手机云端并行",
}


def rename_if_exists(src: Path, dst: Path) -> None:
    if not src.exists():
        print(f"skip (missing): {src.name}")
        return
    if dst.exists() and src.resolve() != dst.resolve():
        print(f"skip (exists): {dst.name}")
        return
    src.rename(dst)
    print(f"{src.name} -> {dst.name}")


def main() -> None:
    for old, new in MAP.items():
        rename_if_exists(BASE / f"{old}.jpg", BASE / f"{new}.jpg")
        rename_if_exists(DIR_9X16 / f"{old}_9x16.jpg", DIR_9X16 / f"{new}_9x16.jpg")
        rename_if_exists(BASE / "发图文" / f"{old}_预览.jpg", BASE / "发图文" / f"{new}_预览.jpg")

    titled = DIR_9X16 / "titled"
    if titled.is_dir():
        for old, new in MAP.items():
            rename_if_exists(
                titled / f"{old}_9x16_titled.jpg",
                titled / f"{new}_9x16_titled.jpg",
            )


if __name__ == "__main__":
    main()
