# -*- coding: utf-8 -*-
# 压缩角色动画精灵图集（public/Image/*_atlas.webp）。
# 这些图集是 4320x4626 的 108 帧动画，原始体积 2~3.5MB，是手机端切到动画形象时
# 白屏等待的主因。本脚本通过降低 WebP 质量重压，帧尺寸/网格布局保持不变，
# 因此 main.js 里的 HAJIMI_ATLAS_FRAME_WIDTH/HEIGHT 等常量无需改动。
#
# 用法（本机 uv 管理 Python，Pillow 即时引入）：
#   探测各质量体积（不写文件）：
#       uv run --no-project --with Pillow scripts/compress-atlas.py
#   实际压缩（原图备份为 *.orig.webp，可回滚）：
#       uv run --no-project --with Pillow scripts/compress-atlas.py --apply --quality 60
#
# 备份策略：首次 --apply 时把原图复制为 xxx.orig.webp；再次运行不覆盖备份。
import argparse
import shutil
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image

IMG_DIR = Path(__file__).resolve().parent.parent / "public" / "Image"
METHOD = 6  # WebP 压缩努力 0-6，6 最慢但压缩率最高（一次性压缩无所谓耗时）
PROBE_QUALITIES = (80, 70, 60, 50, 40)


def probe(im: Image.Image) -> dict:
    """对每个候选 quality 重压到内存，返回 {quality: byte_size}。"""
    result = {}
    for q in PROBE_QUALITIES:
        buf = BytesIO()
        im.save(buf, "WEBP", quality=q, method=METHOD)
        result[q] = buf.tell()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="压缩 *_atlas.webp 精灵图集")
    parser.add_argument("--apply", action="store_true", help="实际写入文件（默认仅探测）")
    parser.add_argument("--quality", type=int, default=60, help="--apply 时使用的 WebP 质量")
    args = parser.parse_args()

    if not IMG_DIR.is_dir():
        print(f"[err] 目录不存在：{IMG_DIR}")
        return 1

    atlases = sorted(IMG_DIR.glob("*_atlas.webp"))
    if not atlases:
        print(f"[err] 未找到 *_atlas.webp：{IMG_DIR}")
        return 1

    print(f"IMG_DIR = {IMG_DIR}")
    total_before = 0
    for p in atlases:
        im = Image.open(p)
        if im.mode != "RGBA":
            im = im.convert("RGBA")
        before = p.stat().st_size
        total_before += before
        sizes = probe(im)
        print(f"\n[{p.name}]  {im.size[0]}x{im.size[1]}  当前 {before / 1024:6.0f}KB")
        for q, sz in sizes.items():
            mark = "  <-- apply" if (args.apply and q == args.quality) else ""
            print(f"    q={q:<3d} -> {sz / 1024:6.0f}KB  ({sz / before * 100:4.0f}%){mark}")

    if not args.apply:
        print(f"\n合计当前 {total_before / 1024:6.0f}KB（dry-run，未写文件）。")
        print("确认目标质量后，加 --apply --quality N 实际压缩。")
        return 0

    print(f"\n应用 quality={args.quality} 压缩 ...")
    total_after = 0
    for p in atlases:
        backup = p.parent / (p.stem + ".orig.webp")
        if not backup.exists():
            shutil.copy2(p, backup)
            print(f"[backup] {backup.name}")
        im = Image.open(p)
        if im.mode != "RGBA":
            im = im.convert("RGBA")
        tmp = p.parent / (p.stem + ".new.webp")
        im.save(tmp, "WEBP", quality=args.quality, method=METHOD)
        before = p.stat().st_size
        after = tmp.stat().st_size
        total_after += after
        shutil.move(str(tmp), str(p))
        print(f"[ok]   {p.name:30s} {before / 1024:7.0f}KB -> {after / 1024:6.0f}KB "
              f"({after / before * 100:4.0f}%)")

    print(f"\n合计 {total_before / 1024:7.0f}KB -> {total_after / 1024:6.0f}KB "
          f"({total_after / total_before * 100:4.0f}%)")
    print("原图已备份为 *.orig.webp；回滚时覆盖回去即可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
