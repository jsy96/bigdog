// 把 public/audio-data.js（全局 `const AUDIO_B64 = { ... }`）转换成合法 JSON
// public/audio-data.json。目的：前端改用 fetch 异步加载音频 base64 包，
// 不再用同步 <script src="audio-data.js"> 阻塞首屏解析。
//
// 运行：node scripts/convert-audio-data-to-json.mjs
// 由 tools/build_audio_data.mjs 重建 audio-data.js 后，重跑本脚本同步 json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'audio-data.js');
const OUT = path.join(ROOT, 'public', 'audio-data.json');

if (!fs.existsSync(SRC)) {
  console.error(`[err] 源文件不存在：${SRC}`);
  process.exit(1);
}

const code = fs.readFileSync(SRC, 'utf8');
// audio-data.js 形如：/* 注释 */ const AUDIO_B64 = { da: '...', ... };
// 用 Function 包裹执行后取回对象，避免 eval 污染全局。
const extract = new Function(`${code}\n return AUDIO_B64;`);
const obj = extract();

if (!obj || typeof obj !== 'object') {
  console.error('[err] 未能从 audio-data.js 提取 AUDIO_B64 对象');
  process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify(obj), 'utf8');

const keys = Object.keys(obj);
const inKB = (fs.statSync(SRC).size / 1024).toFixed(0);
const outKB = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`[ok] ${path.relative(ROOT, SRC)} (${inKB}KB) -> ${path.relative(ROOT, OUT)} (${outKB}KB)`);
console.log(`     ${keys.length} 个音色：${keys.join(', ')}`);
