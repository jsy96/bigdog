#!/usr/bin/env node

// Convert an MP4 character animation into the runtime WebP atlas format.
//
// Output format expected by main.js:
//   Image/{id}_atlas.webp  -> 12 x 9 sprite atlas, 108 frames total
//   Image/{id}_icon.webp   -> 128 x 128 button icon
//
// Default behavior matches the Doubao / generated Teio workflow:
//   - sample 108 frames at 12 fps
//   - keep the right half of the video
//   - remove gray checkerboard background baked into the MP4
//   - center the character on 360 x 514 transparent frames
//   - tile frames into a single 4320 x 4626 lossless WebP atlas

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(toolsDir);
const imageDir = path.join(projectRoot, 'Image');
const tmpRoot = path.join(toolsDir, 'tmp');
const args = process.argv.slice(2);

function readArgument(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? '' : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function usage() {
  return `用法：
  node tools/build_animation_from_mp4.mjs --input <mp4路径> --id <形象id>

常用示例：
  node tools/build_animation_from_mp4.mjs ^
    --input "Image/生成东海帝皇Q版赛马娘循环动画.mp4" ^
    --id doubao

参数：
  --input <file>             必填，源 MP4 文件
  --id <id>                  必填，输出 Image/{id}_atlas.webp / Image/{id}_icon.webp
  --output <file>            可选，自定义 atlas 输出路径
  --icon-output <file>       可选，自定义 icon 输出路径
  --work-dir <dir>           可选，中间 PNG 帧输出目录，默认 tools/tmp/mp4_animation_<id>
  --source-fps <n>           可选，抽帧 fps，默认 12
  --frames <n>               可选，输出帧数，默认 108
  --tile-cols <n>            可选，atlas 列数，默认 12
  --tile-rows <n>            可选，atlas 行数，默认 9
  --frame-width <n>          可选，单帧画布宽，默认 360
  --frame-height <n>         可选，单帧画布高，默认 514
  --scale-width <n>          可选，角色缩放目标宽，默认 320
  --scale-height <n>         可选，角色缩放目标高，默认 360
  --crop <mode>              可选，right-half | left-half | full，默认 right-half
  --key <mode>               可选，gray-checker | blue | none，默认 gray-checker
  --blue-key-color <hex>     可选，blue 抠色颜色，默认 0x98cdfb
  --blue-similarity <n>      可选，blue 抠色范围，默认 0.22
  --blue-blend <n>           可选，blue 边缘柔化，默认 0.08
  --keep-frames              可选，保留中间 PNG 帧；默认也会保留，便于检查
  --help                     显示帮助

说明：
  - 输出 atlas 总尺寸 = frame-width * tile-cols by frame-height * tile-rows。
  - 当前前端按每帧 360 x 514、12 x 9、108 帧读取；默认参数不要随意改。
  - gray-checker 抠背景适用于视频里烘进灰白透明棋盘格的情况。
`;
}

if (hasFlag('--help') || !args.length) {
  console.log(usage());
  process.exit(hasFlag('--help') ? 0 : 1);
}

const input = path.resolve(readArgument('--input'));
const id = readArgument('--id').trim();
if (!input || !fs.existsSync(input)) {
  throw new Error(`缺少或找不到 --input 文件：${input || '(empty)'}`);
}
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
  throw new Error('--id 只能包含字母、数字、下划线、短横线，且必须以字母或数字开头');
}

const sourceFps = Number(readArgument('--source-fps', '12'));
const frames = Number(readArgument('--frames', '108'));
const tileCols = Number(readArgument('--tile-cols', '12'));
const tileRows = Number(readArgument('--tile-rows', '9'));
const frameWidth = Number(readArgument('--frame-width', '360'));
const frameHeight = Number(readArgument('--frame-height', '514'));
const scaleWidth = Number(readArgument('--scale-width', '320'));
const scaleHeight = Number(readArgument('--scale-height', '360'));
const cropMode = readArgument('--crop', 'right-half');
const keyMode = readArgument('--key', 'gray-checker');

for (const [name, value] of Object.entries({
  sourceFps, frames, tileCols, tileRows, frameWidth, frameHeight, scaleWidth, scaleHeight,
})) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数`);
}
if (frames !== tileCols * tileRows) {
  throw new Error(`frames 必须等于 tile-cols * tile-rows：${frames} !== ${tileCols} * ${tileRows}`);
}
if (!['right-half', 'left-half', 'full'].includes(cropMode)) {
  throw new Error('--crop 只支持 right-half / left-half / full');
}
if (!['gray-checker', 'blue', 'none'].includes(keyMode)) {
  throw new Error('--key 只支持 gray-checker / blue / none');
}

const outputFile = path.resolve(readArgument('--output', path.join(imageDir, `${id}_atlas.webp`)));
const iconOutputFile = path.resolve(readArgument('--icon-output', path.join(imageDir, `${id}_icon.webp`)));
const workDir = path.resolve(readArgument('--work-dir', path.join(tmpRoot, `mp4_animation_${id}`)));

function run(command, commandArgs, label) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} 失败，退出码：${result.status}`);
}

function capture(command, commandArgs, label) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${label} 失败，退出码：${result.status}\n${detail}`);
  }
  return result.stdout.trim();
}

function cropFilter(mode) {
  if (mode === 'right-half') return 'crop=iw/2:ih:iw/2:0';
  if (mode === 'left-half') return 'crop=iw/2:ih:0:0';
  return 'null';
}

function keyFilter(mode) {
  if (mode === 'none') return 'format=rgba';
  if (mode === 'blue') {
    const color = readArgument('--blue-key-color', '0x98cdfb');
    const similarity = readArgument('--blue-similarity', '0.22');
    const blend = readArgument('--blue-blend', '0.08');
    return `chromakey=${color}:${similarity}:${blend},format=rgba`;
  }
  // Remove low-saturation gray checkerboard pixels baked into many "transparent" MP4 exports.
  // Condition summary:
  //   - RGB channel spread < 26  => gray / low saturation
  //   - max RGB between 105 and 235 => avoid pure black/white parts and colored character pixels
  return "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(max(max(r(X,Y),g(X,Y)),b(X,Y))-min(min(r(X,Y),g(X,Y)),b(X,Y)),26)*gt(max(max(r(X,Y),g(X,Y)),b(X,Y)),105)*lt(max(max(r(X,Y),g(X,Y)),b(X,Y)),235),0,255)'";
}

fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.mkdirSync(path.dirname(iconOutputFile), { recursive: true });

console.log(`输入：${input}`);
console.log(`形象 id：${id}`);
console.log(`中间帧目录：${workDir}`);
console.log(`输出 atlas：${outputFile}`);
console.log(`输出 icon：${iconOutputFile}`);

const framePattern = path.join(workDir, 'frame_%03d.png');
const vfExtract = [
  `fps=${sourceFps}`,
  cropFilter(cropMode),
  keyFilter(keyMode),
  `scale=${scaleWidth}:${scaleHeight}:force_original_aspect_ratio=decrease:flags=lanczos`,
  `pad=${frameWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
  'format=rgba',
].filter((part) => part && part !== 'null').join(',');

run('ffmpeg', [
  '-y',
  '-hide_banner',
  '-loglevel', 'error',
  '-i', input,
  '-vf', vfExtract,
  '-frames:v', String(frames),
  '-start_number', '0',
  framePattern,
], '抽帧 / 裁剪 / 抠背景');

const firstFrame = path.join(workDir, 'frame_000.png');
const lastFrame = path.join(workDir, `frame_${String(frames - 1).padStart(3, '0')}.png`);
if (!fs.existsSync(firstFrame) || !fs.existsSync(lastFrame)) {
  throw new Error(`序列帧不完整：未找到 ${firstFrame} 或 ${lastFrame}`);
}

run('ffmpeg', [
  '-y',
  '-hide_banner',
  '-loglevel', 'error',
  '-framerate', String(sourceFps),
  '-start_number', '0',
  '-i', framePattern,
  '-vf', `format=bgra,tile=${tileCols}x${tileRows}:nb_frames=${frames}:padding=0:margin=0`,
  '-frames:v', '1',
  '-c:v', 'libwebp',
  '-lossless', '1',
  '-quality', '100',
  '-preset', 'drawing',
  outputFile,
], '合成 atlas WebP');

run('ffmpeg', [
  '-y',
  '-hide_banner',
  '-loglevel', 'error',
  '-i', firstFrame,
  '-vf', 'scale=128:128:force_original_aspect_ratio=decrease:flags=lanczos,pad=128:128:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=bgra',
  '-frames:v', '1',
  '-c:v', 'libwebp',
  '-lossless', '0',
  '-quality', '82',
  '-preset', 'icon',
  iconOutputFile,
], '生成 icon WebP');

const atlasInfo = capture('ffprobe', [
  '-v', 'error',
  '-show_entries', 'stream=width,height,pix_fmt',
  '-of', 'default=nw=1',
  outputFile,
], '读取 atlas 信息');
const iconInfo = capture('ffprobe', [
  '-v', 'error',
  '-show_entries', 'stream=width,height,pix_fmt',
  '-of', 'default=nw=1',
  iconOutputFile,
], '读取 icon 信息');

const outputStat = fs.statSync(outputFile);
const iconStat = fs.statSync(iconOutputFile);
console.log('完成。');
console.log(`atlas: ${outputFile} (${(outputStat.size / 1024 / 1024).toFixed(2)} MiB)`);
console.log(atlasInfo);
console.log(`icon: ${iconOutputFile} (${(iconStat.size / 1024).toFixed(1)} KiB)`);
console.log(iconInfo);
console.log(`中间 PNG 帧：${workDir}`);
console.log(`刷新页面后后端会自动读取 Image/${id}_atlas.webp。`);
