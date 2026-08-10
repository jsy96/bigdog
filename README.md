# 大狗 Tap（Dagou-Tap）

> 仿 Mikutap 的网页互动音乐玩具：点击 / 滑动屏幕，狗叫声会卡在节拍上，全屏几何特效随拍绽放。

前后端一体的网页应用，支持两种部署方式：**本地 Node 服务器**（`server.js`，零依赖）或 **Vercel**（自定义形象存 Vercel Blob）。点按或拖动屏幕任意位置即可触发音效——三套音色（大狗叫 / 哈基米 / 叮咚鸡）的每个分区都被对准 A 小调五声音阶的固定音高，配合 128 BPM 的 C–G–Am–F 背景循环，自由演奏也不会刺耳。

> 后端负责静态文件服务、扫描 `Image/` 目录生成形象清单、自定义形象上传（本地落盘 `Image/`，Vercel 落 Vercel Blob）；演奏设置与当前形象选择仍用浏览器 `localStorage` 本地持久化。

## 功能特性

- **节拍吸附**：输入量化到八分音符；快速滑动会补全线段跨过的所有分区并按顺序排队，同类音节只保留最新一个。
- **三套音色**（语义音节 `da / gou / jiao` 映射到不同采样），全部直接可用：
  - 大狗叫：`da / gou / jiao`
  - 哈基米：`ha / ji / mi`
  - 叮咚鸡：`dingdongji_ding / dingdongji_dong / dingdongji_ji`
- **音效与形象各自独立**：3 种音效（大狗叫 / 叮咚鸡 / 哈基米）只决定声音采样，形象只决定画面角色，互不关联。顶部「音乐」右侧有两个并排的内联按钮——「音效」循环切声音（含「关闭音效」一档）、「形象」循环切画面角色。形象选择会保存在 `localStorage`，刷新不丢。
- **Image 目录自动形象**：`server.js` 会扫描 `Image/`，凡是存在成对图片 `{id}_close.png` + `{id}_open.png`（也兼容 `{id}_close_mouth.png` + `{id}_open_mouth.png`）就会自动成为一个形象；`{id}_atlas.webp` + `{id}_icon.webp` 会成为动画形象（当前用于东海帝皇）。
- **自定义形象落盘**：点「形象」按钮旁的「+」打开面板，上传「闭嘴」「张嘴」两张图即可生成自己的形象；图片经 canvas 压缩成 PNG dataURL 后上传到后端，后端保存为 `Image/custom_xxx_close.png` 与 `Image/custom_xxx_open.png`，并写入 `Image/characters.json` 保存显示名。保存后刷新、重启服务器都会自动加载。
- **两种演奏模式**：
  - 普通模式：4 个固定音高分区（横屏左→右，竖屏上→下）。
  - 钢琴模式：一个八度白键，起始八度在 **C3–C6** 间切换——顶部「八度」按钮循环切换，也可用方向键 ←/→。
- **长按延音原位换调**：`jiao / mi` 长音循环中滑动只切 `playbackRate`，不重新播放开头。
- **演奏设置**：顶部有「钢琴」开关按钮和「八度」循环按钮（点击在 C3–C6 间切换，钢琴模式与起始八度保存在 `localStorage`）；强化节奏、显示网格固定开启、不可关闭。
- **键盘控制**：钢琴模式下用键盘行（QWE…/ASD…/ZXC…）弹奏，方向键 ←/→ 切换八度。
- 全屏几何特效（12 种）、节拍律动、张嘴动画、按键网格显示。
- **版本标识**：界面右下角低调显示当前版本号 `v1.0.260810`（半透明灰、`pointer-events:none` 不挡互动；改版本直接编辑 `public/index.html` 里 `.version-tag` 的文本）。

## 目录结构

```
public/                 前端静态站点根（Vercel 标准静态目录；本地 server 也从此目录服务）
  index.html            入口页面（含全部样式与 DOM）
  main.js               核心前端逻辑：Web Audio 音频引擎、特效、交互、设置、形象上传
  audio-data.json       九段音效的 MP3 base64 包（前端 fetch 异步加载；由 scripts/build-audio-data-json.py 从 audio-data.js 压缩转换，~50KB）
  audio-data.js         同一份数据的 JS 源（convert 输入；已 .vercelignore，不上传到 Vercel）
  Image/                图片资源（角色闭嘴/张嘴图、帝皇图集等）
    dagou_close_mouth.webp dagou_open_mouth.webp
    dingdongji_close_mouth.webp dingdongji_open_mouth.webp
    maodie_close_mouth.webp maodie_open_mouth.webp
    donghaidihuang_atlas.webp donghaidihuang_icon.webp
    characters.json     自定义形象显示名清单（本地后端自动维护）
api/                    Vercel Serverless Functions（characters.js GET/POST，characters/[id].js DELETE）
lib/blob-storage.cjs    Vercel Blob 封装：自定义形象的图片与元数据读写（@vercel/blob 为 ESM，用 dynamic import 加载）
scripts/
  server.js             本地后端服务器：静态服务、Image 扫描、形象上传 / 删除 API（零依赖，仅 Node 内置模块）
  build-builtin-characters.mjs  构建脚本：扫描 public/Image/ 生成 data/builtin-characters.json
  convert-png-to-webp.py     一次性脚本：核心角色 PNG → WebP（首屏体积优化，uv + Pillow 运行）
  compress-atlas.py          一次性脚本：重压动画形象图集 *_atlas.webp（手机端切形象提速；默认 dry-run 探测各质量体积，--apply --quality N 写入并备份原图为 *.orig.webp）
  build-audio-data-json.py  把 public/audio-data.js（WAV）压缩转成 audio-data.json（MP3，前端 fetch 异步加载；内置 YIN 音准校验）
data/builtin-characters.json  构建产物：内置形象清单，供 Vercel GET 只读（由 build 生成，已 .gitignore）
audio/                  九段源音频 wav（前端不引用，仅用于重建 audio-data.js；已 .vercelignore）
  da.wav gou.wav jiao.wav
  ha_new.wav ji_new.wav mi_new.wav
  dingdongji_ding.wav dingdongji_dong.wav dingdongji_ji.wav
docs/
  audio-pitch-harmony.md   音高变调与和声设计依据（乐理 + YIN 检测 + 倍率算法）
tools/                     开发与验证工具，不参与网页运行（已 .vercelignore）
  analyze_pitch.py            逐帧 YIN 音高检测 + 响度校准（需 Python + NumPy）
  find_piano_minimax.py       为超限的「样本 + 起始八度」搜索单一 minimax 锚点
  build_audio_data.mjs        从 audio/ 重建 public/audio-data.js 的 base64 包
  build_character_animation.mjs  把东海帝皇透明 PNG 序列压成精灵图 WebP
  build_animation_from_mp4.mjs   把 MP4 循环动画转成 public/Image/{id}_atlas.webp / public/Image/{id}_icon.webp
  verify_runtime_mapping.mjs  提取并执行 main.js 映射函数，对照分析报告回归
  verify_interaction_queue.mjs 验证滑动补全、节奏排队与长音换调
start.bat               Windows 启动脚本（英文输出，跑 scripts/server.js）
提示词.txt                AI 绘图提示词：照此生成符合要求的"闭嘴/张嘴"双图，用于自定义形象
vercel.json             Vercel 部署配置（buildCommand + functions.includeFiles + 静态资源长期缓存头）
package.json            npm 依赖（@vercel/blob）与脚本（build / dev）；不含 start 脚本，避免 Vercel 误判为 Node server
.vercelignore           Vercel 上传排除清单（tools/、audio/、docs/、本地脚本），减小部署体积
README.md               项目说明（本文件）
.gitignore
```

## 本地运行

需要 Node.js v18+（只用内置模块，无需 `npm install`）。

```bash
# 方式一：Windows 双击 start.bat
# 如果 8000 被占用，start.bat 会自动尝试 8001、8002 ...，并在窗口里显示实际访问地址。

# 方式二：命令行启动
node scripts/server.js
# 然后访问 http://localhost:8000/

# 可选：改端口
PORT=8011 node scripts/server.js
```

首次进入需点击一次以解锁音频（浏览器自动播放策略），之后即可演奏。

## 部署到 Vercel

本项目可一键部署到 Vercel：`public/` 下的静态前端（`index.html` / `main.js` / `audio-data.js` / `Image`）走 Vercel 静态 CDN，API 由 `api/` 下的 Serverless Functions 提供。

### 与本地部署的差异

| | 本地 `server.js` | Vercel |
|---|---|---|
| 静态文件 | `scripts/server.js` 服务 `public/` | Vercel 静态 CDN（`public/`） |
| 内置形象清单 | 启动时扫描 `Image/` | **构建期**生成 `data/builtin-characters.json`（`npm run build`），函数只读 |
| 自定义形象存储 | 写入 `Image/` + `characters.json` | **Vercel Blob**（图片 + 元数据，无文件系统） |
| 形象 API 实现 | `server.js` 内联 | `api/characters.js` / `api/characters/[id].js` |

API 路径与返回结构完全一致，前端 `main.js` 无需任何改动。

### 部署步骤

1. 把项目推到 GitHub，在 Vercel 导入该仓库（或用 `vercel` CLI）。
2. Vercel 自动按 `vercel.json` 处理：运行 `npm run build` 生成内置清单，`api/` 作为函数，`public/` 作为静态站点。
3. **启用自定义形象上传（可选但推荐）**：在 Vercel 项目里创建一个 **Blob Store**（Dashboard → Storage → Create → Blob）并连接到项目，Vercel 会自动注入环境变量 `BLOB_READ_WRITE_TOKEN`。
   - 不配 Blob 也能部署成功：页面正常游玩、内置形象与三套音色全部可用，只是「+ 上传自定义形象」会返回 503。
4. 部署完成后访问 Vercel 分配的域名即可。

### Vercel 上的注意事项

- **请求体大小**：Vercel Hobby 计划单个请求体上限约 **4.5 MB**（两张 base64 PNG 合计）。网页已把上传图压缩到约 360px 宽，通常远低于此；若仍超限会收到错误提示，请换更小的图。
- **构建期排除 `custom_`**：构建脚本跳过 `public/Image/` 里 `custom_` 前缀的图片——自定义形象在线上只来自 Blob，不来自仓库。本地的 `public/Image/custom_*` 测试图不会出现在线上清单。
- **本地开发仍用 `server.js`**：`npm run dev` 跑本地服务器（写 `Image/`）；Vercel 函数（写 Blob）只在部署后生效。
- **部署体积优化**：`.vercelignore` 排除 `tools/`（含大量临时帧）、`audio/`（源 wav，前端用 base64 内嵌包不引用）、`docs/` 及本地脚本（`server.js` / `start.bat` / `1git.bat`），减小上传体积；`audio-data.js` 也已排除（前端改用 `audio-data.json`，js 仅作 convert 源）。`scripts/` 必须保留——构建期要跑 build 脚本。
- **首屏性能优化**：① 核心角色图（大狗 / 叮咚鸡 / 哈基米 + 1_1 / 2_2）由 PNG 转 WebP，约 4.9 MB → 310 KB；② 音频由 WAV（base64 764KB）压成 MP3（base64 ~50KB，省 93%）存 `audio-data.json`，`main.js` 页面加载即 `fetch` 异步获取（`<link rel="preload" as="fetch">` 提前发起），不再用同步 `<script>` 阻塞首屏；MP3 解码波形与原 WAV 相似度 >99%，音高不变；`main.js` 同样 `preload` 并行下载；③ `vercel.json` 为 `Image/*` 与 `*.js` 设 `immutable` 长缓存（`index.html` 走 `must-revalidate` 保证更新即时生效），二次访问近瞬开；④ **动画图集压缩**：三个动画形象图集（doubao / doubao2 / 帝皇，各 4320×4626 / 108 帧）由 `scripts/compress-atlas.py` 统一重压到 WebP q=60——doubao 系列 6.7 MB → 2.3 MB（省 65%，手机端切到 doubao 形象从下载 3.5 MB 降到 1.1 MB），帝皇原图已是高压缩态、收益小（2.0→1.8 MB）；图集重压后 `main.js` 给 atlas URL 附 `ATLAS_CACHE_BUSTER` 版本号击穿 immutable 旧缓存；⑤ **形象清单 API 缓存**：`GET /api/characters` 由 `no-store` 改为 SWR（`max-age=60, s-maxage=600, stale-while-revalidate=86400`），首屏命中 CDN、不再每次等 Serverless 冷启动，前端 fetch 同步改 `cache: 'default'`。

## 后端 API

本地由 `server.js` 提供，Vercel 由 `api/` 下的 Serverless Functions 提供，接口路径与返回结构一致：

- `GET /api/characters`：返回当前全部形象（内置 + 自定义）。本地扫描 `Image/`；Vercel 读构建期清单 + Blob。
- `POST /api/characters`：上传自定义形象，JSON body 为 `{ "label": "名称", "close": "data:image/png;base64,...", "open": "data:image/png;base64,..." }`。本地落盘 `Image/`；Vercel 存 Blob。
- `DELETE /api/characters/:id`：删除自定义形象。本地删 `Image/` 文件与 `characters.json` 记录；Vercel 删 Blob。

## Image 目录形象规则

静态双图形象：

```text
Image/{id}_close.png + Image/{id}_open.png
Image/{id}_close_mouth.png + Image/{id}_open_mouth.png
```

精灵图动画形象（WebP）：

```text
Image/{id}_atlas.webp
Image/{id}_icon.webp   # 可选，用作顶部形象按钮图标；没有时使用 atlas 本身
```

`{id}_atlas.webp` 需要是 12×9 排列的 108 帧透明 WebP 精灵图；当前前端按每帧 `360×514` 读取，因此 atlas 总尺寸应为 `4320×4626`。

后端启动后会按上述规则扫描。只要把配对图片放进 `Image/`，刷新页面后「形象」按钮就能循环到该形象；当前已有 `1_1_close.png` / `1_1_open.png` 与 `2_2_close.png` / `2_2_open.png` 会自动显示为形象。

## 自定义形象

内置形象之外，可上传自己的图做成新形象：

1. 通过 `node scripts/server.js` 或 `start.bat` 打开服务，访问 `http://localhost:8000/`。
2. 点击顶部「形象」按钮右侧的「**+**」，打开「添加自定义形象」面板。
3. 点「闭嘴」槽选一张图、点「张嘴」槽选一张图（两个槽可任意顺序选；保存时会自动把张嘴图对齐到闭嘴图尺寸，保证张嘴动画不跳）。
4. 点中间预览区可切换查看张嘴效果，确认无误后填名称（≤6 字），点「保存并使用」。
5. 后端会把两张图保存进 `Image/`，并把名称记录到 `Image/characters.json`；刷新、重启服务器都不丢。
6. 再次打开「+」面板，下方「已添加的自定义形象」里点 × 可删除该自定义形象。

> 制作图片要求：两张图**尺寸完全相同、画面严格对齐**（除嘴巴外一个像素都不能动）。**白色背景会自动抠除变透明**（只去与图片边缘连通的背景白，角色内部的白色如白肚皮不受影响），因此白底图也能直接用；当然透明背景 PNG 效果最佳。最稳的做法是先画好闭嘴图，再在其基础上只改嘴巴。完整规格、可直接复制的 AI 绘图 Prompt 与验收清单见根目录 **`提示词.txt`**。

注意：网页会自动压缩上传图片到约 360px 宽；请勿上传超大原图，后端单次请求体上限为 12MB。

## 技术要点

- **音高变调**：用逐帧 YIN 检测每段原始语音的参考基频，再通过 Web Audio 的 `AudioBufferSourceNode.playbackRate` 把每个按键固定对准 **A 小调五声音阶（A–C–D–E–G）** 的某个音；同一按键在任何时间、任何背景下倍率完全一致。详见 `docs/audio-pitch-harmony.md`。
- **响度校准**：以 `da.wav` 的有效帧 RMS 为基准，为九段音频分别计算固定增益，叠加结果再经 `DynamicsCompressorNode` 防削波。
- **形象加载**：前端启动时请求 `/api/characters`，由后端扫描 `Image/` 生成清单；后端不可用时回退到内置形象，方便直接打开页面做基础演奏。
- **本地存储**：演奏设置通过一个本地适配器（`localToyAdapter`）以 `localStorage` 持久化，键名沿用历史命名；当前形象选择使用 `dagou-selected-character-v1`，自定义图片本身由后端保存在 `Image/`。
- **节拍同步**：所有动画与律动按 Web Audio 时钟计算，不依赖 `setTimeout` 累积，长时间运行不漂移。

## 开发工具

`tools/` 下的脚本仅用于开发与验证，网页运行不依赖它们：

```bash
uv run --no-project --with numpy tools/analyze_pitch.py --write-wavs   # 音高与响度分析（写报告到 tools/tmp/）
uv run --no-project --with numpy tools/find_piano_minimax.py           # 钢琴模式 minimax 锚点搜索
node tools/build_audio_data.mjs                                        # 重建 audio-data.js
node tools/build_animation_from_mp4.mjs --input "Image/生成东海帝皇Q版赛马娘循环动画.mp4" --id doubao  # MP4 转动画 WebP
node tools/verify_runtime_mapping.mjs                                  # 运行时映射回归
node tools/verify_interaction_queue.mjs                                # 交互队列回归

# 核心角色图 PNG → WebP（一次性首屏体积优化，需 uv + Pillow；转换后同步改 index.html / main.js 引用并重跑 npm run build）
uv run --no-project --with Pillow scripts/convert-png-to-webp.py

# 重压动画形象图集 *_atlas.webp（手机端切形象提速；先 dry-run 看各质量体积，再 --apply --quality 60 写入，原图备份为 *.orig.webp；重压后改 main.js 的 ATLAS_CACHE_BUSTER 击穿 immutable 旧缓存）
uv run --no-project --with Pillow scripts/compress-atlas.py
uv run --no-project --with Pillow scripts/compress-atlas.py --apply --quality 60

# 把 audio-data.js（WAV）压成 audio-data.json（MP3），前端 fetch 异步加载（重建音频后重跑：先 build_audio_data.mjs 再本脚本）
uv run --no-project --with numpy scripts/build-audio-data-json.py
```

音高分析依赖 Python 3 + NumPy（本机用 uv 管理），角色动画压缩依赖 Node.js + FFmpeg，音频 WAV→MP3 压缩依赖 ffmpeg + NumPy（脚本内置 YIN 音准校验）。所有报告与临时产物放在 `tools/tmp/`，生产页面不得依赖其中任何文件。
