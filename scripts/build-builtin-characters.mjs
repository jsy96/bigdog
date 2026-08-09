// scripts/build-builtin-characters.mjs
// 构建脚本：扫描 Image/ 目录，生成 data/builtin-characters.json。
// Vercel 部署时由 buildCommand 触发；GET /api/characters 读取此清单作为内置形象（只读）。
//
// 与 server.js 的 scanCharacters 逻辑一致，但有两点差异：
//   1. 跳过 custom_ 前缀 —— 自定义形象在线上由 Vercel Blob 提供，不来自文件系统。
//   2. 不读取 Image/characters.json —— 避免本地测试的 custom 记录污染线上内置清单。
//
// 用法：node scripts/build-builtin-characters.mjs

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IMAGE_DIR = path.join(ROOT, 'Image');
const OUT_FILE = path.join(ROOT, 'data', 'builtin-characters.json');

// 内置形象的中文名文案与循环顺序（与 server.js 保持一致）。
const BUILTIN_LABELS = {
  dagou: '大狗',
  dingdongji: '叮咚鸡',
  maodie: '哈基米',
  donghaidihuang: '帝皇',
};
const BUILTIN_STATIC_ORDER = ['dagou', 'dingdongji', 'maodie'];
const EMPEROR_PREFIX = 'donghaidihuang';

const PAIR_RE = /^(.+?)_(close|open)(?:_mouth)?\.(png|webp|jpe?g|gif)$/i;
const ATLAS_RE = /^(.+?)_atlas\.(webp|png|jpe?g|gif)$/i;
const ICON_RE = /^(.+?)_icon\.(webp|png|jpe?g|gif)$/i;

// custom_ 前缀保留给用户上传（Vercel Blob），仓库自带的内置清单里不含它。
const isCustomPrefix = (p) => /^custom_/i.test(p);

const sortAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function main() {
  let files = [];
  try {
    files = await fsp.readdir(IMAGE_DIR);
  } catch (err) {
    console.error('[build] Image 目录读取失败：', err.message);
    process.exit(1);
  }

  const pairs = {};      // 前缀 -> { close, open }
  const animations = {}; // 前缀 -> { atlas, icon }
  for (const f of files) {
    let m;
    if ((m = PAIR_RE.exec(f))) {
      const [, prefix, kind] = m;
      pairs[prefix] = pairs[prefix] || {};
      pairs[prefix][kind] = `Image/${f}`;
    } else if ((m = ATLAS_RE.exec(f))) {
      const [, prefix] = m;
      animations[prefix] = animations[prefix] || {};
      animations[prefix].atlas = `Image/${f}`;
    } else if ((m = ICON_RE.exec(f))) {
      const [, prefix] = m;
      animations[prefix] = animations[prefix] || {};
      animations[prefix].icon = `Image/${f}`;
    }
  }

  const result = [];
  const seen = new Set();

  // 1) 内置静态形象（固定顺序）
  for (const prefix of BUILTIN_STATIC_ORDER) {
    const p = pairs[prefix];
    if (p && p.close && p.open) {
      result.push({
        id: prefix,
        label: BUILTIN_LABELS[prefix] || prefix,
        type: 'static',
        icon: p.close,
        close: p.close,
        open: p.open,
        builtin: true,
      });
      seen.add(prefix);
    }
  }

  // 2) 内置帝皇精灵图动画
  const emp = animations[EMPEROR_PREFIX];
  if (emp && emp.atlas) {
    result.push({
      id: EMPEROR_PREFIX,
      label: BUILTIN_LABELS[EMPEROR_PREFIX] || '帝皇',
      type: 'animation',
      icon: emp.icon || emp.atlas,
      atlas: emp.atlas,
      builtin: true,
    });
    seen.add(EMPEROR_PREFIX);
  }

  // 3) 其余动画形象（仓库自带，跳过 custom_）
  for (const prefix of Object.keys(animations)
    .filter((p) => !seen.has(p) && animations[p].atlas && !isCustomPrefix(p))
    .sort(sortAsc)) {
    const a = animations[prefix];
    result.push({
      id: prefix,
      label: BUILTIN_LABELS[prefix] || prefix,
      type: 'animation',
      icon: a.icon || a.atlas,
      atlas: a.atlas,
      builtin: false,
    });
    seen.add(prefix);
  }

  // 4) 其余静态形象（仓库自带，跳过 custom_）
  for (const prefix of Object.keys(pairs)
    .filter((p) => !seen.has(p) && pairs[p].close && pairs[p].open && !isCustomPrefix(p))
    .sort(sortAsc)) {
    const p = pairs[prefix];
    result.push({
      id: prefix,
      label: BUILTIN_LABELS[prefix] || prefix,
      type: 'static',
      icon: p.close,
      close: p.close,
      open: p.open,
      builtin: false,
    });
    seen.add(prefix);
  }

  await fsp.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fsp.writeFile(OUT_FILE, JSON.stringify({ characters: result }, null, 2), 'utf8');

  console.log(`[build] 已生成 ${path.relative(ROOT, OUT_FILE)}，共 ${result.length} 个内置形象：`);
  for (const c of result) console.log(`  - ${c.label} (${c.id}, ${c.type})`);
}

main().catch((err) => {
  console.error('[build] 失败：', err);
  process.exit(1);
});
