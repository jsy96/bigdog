# -*- coding: utf-8 -*-
# 可重复运行的脚本：扫描 public/Image/，把所有「非 custom」的静态形象 PNG 配对
# （{前缀}_close[_mouth].png + {前缀}_open[_mouth].png）转为 WebP。
# 已存在同名 .webp 的跳过（幂等）；custom_ 前缀保留给用户上传，不转换。
# 用途：缩小前端首屏与切换形象时的图片体积。
# 运行：uv run --no-project --with Pillow scripts/convert-png-to-webp.py
# 转换后需删除对应 .png（避免 build 脚本扫描到两种格式产生歧义），并重跑 npm run build。
import re
import sys
from pathlib import Path

from PIL import Image

IMG_DIR = Path(__file__).resolve().parent.parent / "public" / "Image"

QUALITY = 85  # 视觉无损级别；卡通/角色图 85 已无明显差异
METHOD = 6   # WebP 压缩预设 0-6，6 最慢但压缩率最高（一次性转换无所谓耗时）

# 与 build-builtin-characters.mjs / server.js 的 PAIR_RE 保持一致
PAIR_RE = re.compile(r'^(.+?)_(close|open)(?:_mouth)?\.(png|jpe?g|gif)$', re.IGNORECASE)


def main() -> int:
    if not IMG_DIR.is_dir():
        print(f"[err] Image 目录不存在：{IMG_DIR}")
        return 1

    files = [p.name for p in IMG_DIR.iterdir() if p.is_file()]
    pairs = {}
    for name in files:
        m = PAIR_RE.match(name)
        if not m:
            continue
        if name.lower().startswith("custom_"):
            continue  # 自定义形象（用户上传），不转换
        prefix, kind = m.group(1), m.group(2).lower()
        pairs.setdefault(prefix, {})[kind] = name

    print(f"IMG_DIR = {IMG_DIR}")
    converted = 0
    skipped = 0
    for prefix in sorted(pairs):
        kinds = pairs[prefix]
        if not ("close" in kinds and "open" in kinds):
            print(f"[skip] {prefix}: close/open 配对不完整")
            continue
        for kind in ("close", "open"):
            src = IMG_DIR / kinds[kind]
            dst = src.with_suffix(".webp")
            if dst.exists():
                print(f"[skip] {dst.name} 已存在")
                skipped += 1
                continue
            im = Image.open(src)
            if im.mode != "RGBA":
                im = im.convert("RGBA")  # 保留透明通道
            im.save(dst, "WEBP", quality=QUALITY, method=METHOD)
            before = src.stat().st_size / 1024
            after = dst.stat().st_size / 1024
            print(f"[ok]   {src.name:32s} {before:7.0f}KB -> {after:6.0f}KB ({after / before * 100:4.0f}%)")
            converted += 1

    print(f"\n转换 {converted} 个，跳过 {skipped} 个")
    if converted:
        print("提示：请删除已转换的 .png 源文件，并重跑 `npm run build`。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
