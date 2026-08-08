# 大狗 Tap（Dagou-Tap）

> 仿 Mikutap 的网页互动音乐玩具：点击 / 滑动屏幕，狗叫声会卡在节拍上，全屏几何特效随拍绽放。

纯前端单页应用，**无后端依赖、无第三方 SDK**。点按或拖动屏幕任意位置即可触发音效——三套音色（大狗叫 / 哈基米 / 叮咚鸡）的每个分区都被对准 A 小调五声音阶的固定音高，配合 128 BPM 的 C–G–Am–F 背景循环，自由演奏也不会刺耳。

> 独立纯前端网页：所有音色 / 形象直接解锁，演奏设置用浏览器 `localStorage` 本地持久化。

## 功能特性

- **节拍吸附**：输入量化到八分音符；快速滑动会补全线段跨过的所有分区并按顺序排队，同类音节只保留最新一个。
- **三套音色**（语义音节 `da / gou / jiao` 映射到不同采样），全部直接可用：
  - 大狗叫：`da / gou / jiao`
  - 哈基米：`ha / ji / mi`
  - 叮咚鸡：`dingdongji_ding / dingdongji_dong / dingdongji_ji`
- **音效与形象各自独立**：3 种音效（大狗叫 / 叮咚鸡 / 哈基米）只决定声音采样，4 种形象（大狗 / 叮咚鸡 / 哈基米 / 东海帝皇）只决定画面角色，互不关联。顶部「音乐」右侧有两个并排的内联按钮——「音效」循环切声音（含「关闭音效」一档）、「形象」循环切画面角色（含东海帝皇，透明帧动画，首次选择后按需加载图集）。
- **两种演奏模式**：
  - 普通模式：4 个固定音高分区（横屏左→右，竖屏上→下）。
  - 钢琴模式：一个八度白键，起始八度在 **C3–C6** 间切换——顶部「八度」按钮循环切换，也可用方向键 ←/→。
- **长按延音原位换调**：`jiao / mi` 长音循环中滑动只切 `playbackRate`，不重新播放开头。
- **演奏设置**：顶部有「钢琴」开关按钮和「八度」循环按钮（点击在 C3–C6 间切换，钢琴模式与起始八度保存在 `localStorage`）；强化节奏、显示网格固定开启、不可关闭。
- **键盘控制**：钢琴模式下用键盘行（QWE…/ASD…/ZXC…）弹奏，方向键 ←/→ 切换八度。
- 全屏几何特效（12 种）、节拍律动、张嘴动画、按键网格显示。

## 目录结构

```
index.html              入口页面（含全部样式与 DOM）
main.js                 核心逻辑：Web Audio 音频引擎、特效、交互、设置、本地存储
audio-data.js           九段音效的 base64 内嵌包（由 tools/build_audio_data.mjs 生成）
audio/                  九段源音频 wav
  da.wav gou.wav jiao.wav
  ha_new.wav ji_new.wav mi_new.wav
  dingdongji_ding.wav dingdongji_dong.wav dingdongji_ji.wav
Image/                  图片资源（角色闭嘴/张嘴图、帝皇图集）
docs/
  audio-pitch-harmony.md   音高变调与和声设计依据（乐理 + YIN 检测 + 倍率算法）
tools/                     开发与验证工具，不参与网页运行，发布可整体排除
  analyze_pitch.py            逐帧 YIN 音高检测 + 响度校准（需 Python + NumPy）
  find_piano_minimax.py       为超限的「样本 + 起始八度」搜索单一 minimax 锚点
  build_audio_data.mjs        从 audio/ 重建 audio-data.js 的 base64 包
  build_character_animation.mjs  把东海帝皇透明 PNG 序列压成精灵图 WebP
  verify_runtime_mapping.mjs  提取并执行 main.js 映射函数，对照分析报告回归
  verify_interaction_queue.mjs 验证滑动补全、节奏排队与长音换调
README.md                 项目说明（本文件）
.gitignore
```

## 运行

静态网页，二选一：

```bash
# 方式一：直接用浏览器打开 index.html
# 方式二：起一个本地静态服务器（推荐，避免 file:// 的个别限制）
uv run --no-project --with http.server python -m http.server 8000
# 然后访问 http://localhost:8000/
```

首次进入需点击一次以解锁音频（浏览器自动播放策略），之后即可演奏。

## 技术要点

- **音高变调**：用逐帧 YIN 检测每段原始语音的参考基频，再通过 Web Audio 的 `AudioBufferSourceNode.playbackRate` 把每个按键固定对准 **A 小调五声音阶（A–C–D–E–G）** 的某个音；同一按键在任何时间、任何背景下倍率完全一致。详见 `docs/audio-pitch-harmony.md`。
- **响度校准**：以 `da.wav` 的有效帧 RMS 为基准，为九段音频分别计算固定增益，叠加结果再经 `DynamicsCompressorNode` 防削波。
- **本地存储**：演奏设置通过一个本地适配器（`localToyAdapter`）以 `localStorage` 持久化，键名沿用历史命名。
- **节拍同步**：所有动画与律动按 Web Audio 时钟计算，不依赖 `setTimeout` 累积，长时间运行不漂移。

## 开发工具

`tools/` 下的脚本仅用于开发与验证，网页运行不依赖它们：

```bash
uv run --no-project --with numpy tools/analyze_pitch.py --write-wavs   # 音高与响度分析（写报告到 tools/tmp/）
uv run --no-project --with numpy tools/find_piano_minimax.py           # 钢琴模式 minimax 锚点搜索
node tools/build_audio_data.mjs                                        # 重建 audio-data.js
node tools/verify_runtime_mapping.mjs                                  # 运行时映射回归
node tools/verify_interaction_queue.mjs                                # 交互队列回归
```

音高分析依赖 Python 3 + NumPy（本机用 uv 管理），角色动画压缩依赖 Node.js + FFmpeg。所有报告与临时产物放在 `tools/tmp/`，生产页面不得依赖其中任何文件。
