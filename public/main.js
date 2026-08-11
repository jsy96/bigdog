'use strict';
/* ============================================================
 * 大狗Tap —— 仿 Mikutap：点击/拖动屏幕，狗叫会卡在节拍上
 * 背景音轨：Web Audio 实时合成的劲爆鼓组 + 洗脑和弦循环
 * 视觉（仿 Mikutap）：
 *   · 全屏几何特效，以屏幕正中心为原点铺满全屏
 *   · 新特效叠在旧特效之上，旧特效随即退场
 *   · 固定米白背景；限定调色板：主色黄 + 次色灰（极少点缀色）
 *   · 特效带常驻动效（旋转 / 漂浮 / 环绕 / 波动）并随节拍轻微脉动（只做大小/形状变化，不变色）
 * ============================================================ */

/* ---------- 节奏常量 ---------- */
const BPM = 128;          // 激情劲爆的速度
const SPB = 60 / BPM;     // 每拍秒数
const S16 = SPB / 4;      // 16 分音符（调度步长）
const S8  = SPB / 2;      // 8 分音符（点击量化的最小节奏点）
const MASTER_GAIN = 0.85;
const PIANO_OCTAVE_MIN = 3;
const PIANO_OCTAVE_MAX = 6;
const PIANO_DEFAULT_OCTAVE_START = 4;
const OCTAVE_CYCLE = Object.freeze(
  Array.from(
    { length: PIANO_OCTAVE_MAX - PIANO_OCTAVE_MIN + 1 },
    (_, i) => PIANO_OCTAVE_MIN + i,
  ),
);
const DEFAULT_PERFORMANCE_SETTINGS = Object.freeze({
  pianoMode: false,
  pianoOctaveStart: PIANO_DEFAULT_OCTAVE_START,
  rhythmSnap: true,
  showGrid: true,
});

/* ---------- 全局状态 ---------- */
let ctx = null;           // AudioContext
let master = null;        // 总线增益
let bgmBus = null;        // 循环音乐总线
let sfxBus = null;        // 狗叫音效总线
let noiseBuf = null;      // 白噪声（鼓组用）
let started = false;
let bgmMuted = false;
let sfxMuted = false;
const performanceSettings = { ...DEFAULT_PERFORMANCE_SETTINGS };
let performanceSettingsSaving = false;
let pendingPianoOctaveCloudValue = null;
let pianoOctaveCloudWriteRunning = false;

let startTime = 0;        // 第 0 步对应的 audio 时间
let nextNoteTime = 0;     // 调度器下一个音符时间
let stepCount = 0;        // 16 分步进计数（0..63 循环 = 4 小节）

const SFX_SAMPLE_SETS = Object.freeze({
  dagou: Object.freeze({ da: 'da', gou: 'gou', jiao: 'jiao' }),
  hajimi: Object.freeze({ da: 'ha', gou: 'ji', jiao: 'mi' }),
  dingdong: Object.freeze({
    da: 'dingdongji_ding',
    gou: 'dingdongji_dong',
    jiao: 'dingdongji_ji',
  }),
});
// 顶部音效按钮：每种音效的显示名与循环顺序。
const SFX_LABEL = Object.freeze({
  dagou: 'da-gou-jiao',
  dingdong: 'ding-dong-ji',
  hajimi: 'ha-ji-mi',
});
const SFX_CYCLE_ORDER = Object.freeze(['dagou', 'dingdong', 'hajimi', 'mute']);
// 顶部形象按钮：形象的小图、显示名与循环顺序。
// 这些表初始为空，启动时由 loadCharactersFromServer() 从后端（扫描 Image 目录）填充，
// 自定义形象上传成功后由 registerCharacterEntry() 追加。
const CHARACTER_SET_ICON = {};
const CHARACTER_SET_LABEL = {};
const CHARACTER_SET_CYCLE = [];
// 形象与音效解耦：形象按角色 id 索引。
// 每条记录字段：{ id, label, type:'static'|'animation', icon, close, open, atlas?, builtin }
// type:'animation' 使用精灵图动画（无静态图集）；builtin:false 为用户上传的自定义形象。
const CHARACTER_IMAGE_SETS = {};

// 服务器不可用时的兜底形象（直接 file:// 打开 / 后端未启动时仍可基本游玩）。
// 正常通过后端访问时，loadCharactersFromServer 会用 Image 目录扫描结果整体覆盖。
const BUILTIN_FALLBACK_CHARACTERS = [
  { id: 'dagou', label: '大狗', type: 'static', icon: 'Image/dagou_close_mouth.webp', close: 'Image/dagou_close_mouth.webp', open: 'Image/dagou_open_mouth.webp', builtin: true },
  { id: 'dingdongji', label: '叮咚鸡', type: 'static', icon: 'Image/dingdongji_close_mouth.webp', close: 'Image/dingdongji_close_mouth.webp', open: 'Image/dingdongji_open_mouth.webp', builtin: true },
  { id: 'maodie', label: '哈基米', type: 'static', icon: 'Image/maodie_close_mouth.webp', close: 'Image/maodie_close_mouth.webp', open: 'Image/maodie_open_mouth.webp', builtin: true },
  { id: 'donghaidihuang', label: '帝皇', type: 'animation', icon: 'Image/donghaidihuang_icon.webp', atlas: 'Image/donghaidihuang_atlas.webp', builtin: true },
];

// 当前形象是否为精灵图动画形象（取代旧的 id === 'emperor' 硬编码判断）。
function isAnimationCharacter(id) {
  return CHARACTER_IMAGE_SETS[id]?.type === 'animation';
}

/* ---------- 形象清单：由后端扫描 Image 目录驱动，自定义形象落盘到 Image 目录。 ---------- */
const SELECTED_CHARACTER_STORE_KEY = 'dagou-selected-character-v1';
const CUSTOM_CHARACTER_MAX_WIDTH = 360; // 上传压缩目标宽度（px），与内置形象同量级

// 用一份完整的形象清单整体覆盖运行时形象表（清空旧键后重建）。
function populateCharacters(list) {
  for (const k of Object.keys(CHARACTER_IMAGE_SETS)) delete CHARACTER_IMAGE_SETS[k];
  for (const k of Object.keys(CHARACTER_SET_ICON)) delete CHARACTER_SET_ICON[k];
  for (const k of Object.keys(CHARACTER_SET_LABEL)) delete CHARACTER_SET_LABEL[k];
  CHARACTER_SET_CYCLE.length = 0;
  for (const c of list) {
    if (!c || !c.id) continue;
    CHARACTER_IMAGE_SETS[c.id] = { ...c, alt: c.label };
    CHARACTER_SET_ICON[c.id] = c.icon || c.close;
    CHARACTER_SET_LABEL[c.id] = c.label;
    CHARACTER_SET_CYCLE.push(c.id);
  }
}

// 从后端拉取形象清单（后端扫描 Image 目录得出）。失败则回退内置兜底形象。
async function loadCharactersFromServer() {
  try {
    // 尊重服务端 Cache-Control：浏览器短缓存 + CDN 缓存，首屏不再每次走 serverless 冷启动。
    // 自定义形象上传成功后由 registerCharacterEntry 即时更新内存，不依赖重新 fetch。
    const res = await fetch('/api/characters', { cache: 'default' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data.characters) ? data.characters : [];
    if (!list.length) throw new Error('empty character list');
    populateCharacters(list);
    return true;
  } catch (err) {
    console.warn('[大狗Tap] 后端形象清单加载失败，回退内置形象。', err);
    populateCharacters(BUILTIN_FALLBACK_CHARACTERS);
    return false;
  }
}

// 把一条自定义形象注册进运行时形象表（上传成功后调用），使其出现在切换循环里。
function registerCharacterEntry(entry) {
  CHARACTER_IMAGE_SETS[entry.id] = { ...entry, alt: entry.label };
  CHARACTER_SET_ICON[entry.id] = entry.icon || entry.close;
  CHARACTER_SET_LABEL[entry.id] = entry.label;
  if (!CHARACTER_SET_CYCLE.includes(entry.id)) CHARACTER_SET_CYCLE.push(entry.id);
}

// 从运行时形象表移除一条（删除成功后调用）。
function removeCharacterEntry(id) {
  delete CHARACTER_IMAGE_SETS[id];
  delete CHARACTER_SET_ICON[id];
  delete CHARACTER_SET_LABEL[id];
  const idx = CHARACTER_SET_CYCLE.indexOf(id);
  if (idx >= 0) CHARACTER_SET_CYCLE.splice(idx, 1);
}

function persistSelectedCharacter() {
  try {
    window.localStorage.setItem(SELECTED_CHARACTER_STORE_KEY, selectedCharacterId);
  } catch (error) {
    console.warn('[大狗Tap] 形象选择保存失败。', error);
  }
}

function restoreSelectedCharacter() {
  try {
    let saved = window.localStorage.getItem(SELECTED_CHARACTER_STORE_KEY);
    // 兼容旧版本：旧代码把东海帝皇保存为 emperor，新后端扫描 id 为 donghaidihuang。
    if (saved === 'emperor') saved = 'donghaidihuang';
    if (saved && CHARACTER_SET_CYCLE.includes(saved)) selectedCharacterId = saved;
  } catch (error) {
    console.warn('[大狗Tap] 形象选择读取失败。', error);
  }
}
// 当前动画形象的精灵图 atlas 地址（帝皇由后端形象清单提供，兜底为内置帝皇图集）。
// 附带全局版本号做缓存击穿：atlas 文件更新（如体积压缩）后，旧浏览器 / CDN 缓存会因
// URL 变化重新拉取新文件，避免 vercel.json 里 Image/* 的 immutable 长缓存锁死旧版本。
const ATLAS_CACHE_BUSTER = 'v=20260810-atlas60';
function currentAnimationAtlasUrl() {
  const url = CHARACTER_IMAGE_SETS[selectedCharacterId]?.atlas
    || 'Image/donghaidihuang_atlas.webp';
  return url + (url.includes('?') ? '&' : '?') + ATLAS_CACHE_BUSTER;
}
const HAJIMI_ANIMATION_BEATS = 9;
const HAJIMI_FRAMES_PER_BEAT = 12;
const HAJIMI_ATLAS_COLUMNS = 12;
const HAJIMI_ATLAS_FRAME_WIDTH = 360;
const HAJIMI_ATLAS_FRAME_HEIGHT = 514;
const HAJIMI_ANIMATION_FRAME_COUNT =
  HAJIMI_ANIMATION_BEATS * HAJIMI_FRAMES_PER_BEAT;
const RUNTIME_SAMPLE_NAMES = Object.freeze(
  [...new Set(Object.values(SFX_SAMPLE_SETS).flatMap(Object.values))]
);
const buffers = {};       // 解码后的音效样本
const sustainLoops = {};  // 从原样本中实时构建的 WSOLA 延音纹理
let selectedSfxId = 'hajimi';
let selectedCharacterId = 'maodie';
let hajimiAnimationReady = false;
let hajimiAnimationRequested = false;
let hajimiAnimationAtlasUrl = '';
let hajimiAnimationFrame = -1;
let hajimiAnimationEpochBeat = 0;

// 每条纹理由多个波形相似的语音帧重叠生成。帧位置按黄金分割序列变化，
// 再在目标附近寻找相关度最高的波形，避免固定短片段形成可辨识的循环节。
const SUSTAIN_REGIONS = {
  da: {
    enabled: false,
    regionStart: 0.065, regionEnd: 0.168,
    frame: 0.052, overlap: 0.026, search: 0.007,
    wrapBlend: 0.040, textureDuration: 7.31, seed: 0.17,
  },
  gou: {
    enabled: false,
    regionStart: 0.055, regionEnd: 0.140,
    frame: 0.048, overlap: 0.024, search: 0.006,
    wrapBlend: 0.036, textureDuration: 7.73, seed: 0.43,
  },
  jiao: {
    enabled: true,
    regionStart: 0.125, regionEnd: 0.290,
    frame: 0.100, overlap: 0.050, search: 0.012,
    wrapBlend: 0.040, textureDuration: 12.37, seed: 0.71,
    preferFrameEntry: true,
  },
  mi: {
    enabled: true,
    regionStart: 0.245, regionEnd: 0.345,
    frame: 0.070, overlap: 0.035, search: 0.008,
    wrapBlend: 0.028, textureDuration: 12.11, seed: 0.29,
    preferFrameEntry: true,
  },
  dingdongji_ji: {
    enabled: true,
    regionStart: 0.120, regionEnd: 0.310,
    frame: 0.100, overlap: 0.050, search: 0.012,
    wrapBlend: 0.040, textureDuration: 11.83, seed: 0.53,
    preferFrameEntry: true,
  },
};
const SUSTAIN_CLAIM_LEAD = 0.008; // 提前声明长音，避免多指延音短暂重叠
const RELEASE_SCHEDULE_LEAD = 0.006;
const EMERGENCY_FADE = 0.018;

const liveVoices = new Set();
let voiceSerial = 0;
let activeSustainVoice = null;
let mouthVoice = null;

let cols = 4, rows = 3;   // 分区网格（纯逻辑分区，无可见格子）
let zones = [];           // 每个分区的音色配置

let mouthTimer = 0;       // 闭嘴定时器
let mouthPopped = false;  // 狗是否处于"叫"的弹起状态（弹簧目标值）
let barkPop = 0;          // 叫弹跳的当前量 0..1（欠阻尼弹簧，可过冲）
let barkPopVel = 0;       // 弹簧速度（每次触发新声音时施加冲量）
const BARK_KICK = 5.2;    // 单次触发给弹簧的冲量（果断起跳）
const BARK_KICK_MAX = 9;  // 连打时冲量累积上限，防止爆炸
let holding = false;      // 是否正在长按延音（驱动 Q 弹成长 / 变红 / 抖动）
let holdLevel = 0;        // 长按累积程度 0..1（缓慢增长、松手快速回落）
let jellyScale = 1;       // 果冻层当前缩放（欠阻尼弹簧，带 Q 弹过冲）
let jellyVel = 0;         // 弹簧速度
let lastTick = 0;         // 上一帧时间（求 dt 用）
const INPUT_LOOKAHEAD = 0.12;
const INPUT_QUEUE_LOOKAHEAD = 0.03;
const inputQueue = [];     // 滑动经过的分区按进入顺序排到连续八分音符
const inputVisualTimers = new Set();
let inputSerial = 0;
let lastCommittedInputTime = -Infinity;
const pointers = new Map();// pointerId -> { zone, voice, pendingEntryId, lastX, lastY }
const CONTROLS_IDLE_MS = 2000;
const CONTROLS_HOVER_IDLE_MS = 250;
// 本地持久化键名（沿用历史命名）：替代 b站 Toy 云端存储，保存演奏设置。
const TOY_CLOUD_KEYS = Object.freeze({
  sfxUnlocked: 'dagou_sfx_unlocked_v1',
  settingsSeen: 'dagou_settings_seen_v1',
  dingdongNewSeen: 'dagou_dingdong_new_seen_v1',
  hajimiNewSeen: 'dagou_hajimi_new_seen_v1',
  pianoMode: 'dagou_piano_mode_v1',
  octaveSwitching: 'dagou_octave_switching_v1',
  pianoOctaveStart: 'dagou_piano_octave_start_v1',
  rhythmSnap: 'dagou_rhythm_snap_v1',
  showGrid: 'dagou_show_grid_v1',
});
const TOY_CLOUD_KEY_LIST = Object.freeze(Object.values(TOY_CLOUD_KEYS));
const VIDEO_UNLOCK_ITEM_IDS = new Set(['dingdong', 'hajimi']);
let controlsIdleTimer = 0;

/* 本地设置存储：替代 b站 Toy SDK 的云端读写。所有键沿用 TOY_CLOUD_KEYS，
   读取时 sfxUnlocked 固定为 '1'（方案 A：直接全部解锁，无看视频解锁流程）。 */
const LOCAL_SETTINGS_STORE_KEY = 'dagou-tap-local-settings-v1';

function readLocalSettings() {
  try {
    const raw = window.localStorage.getItem(LOCAL_SETTINGS_STORE_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === 'object' ? data : {};
  } catch (error) {
    console.warn('[大狗Tap] 本地设置读取失败。', error);
    return {};
  }
}

function writeLocalSettings(patch) {
  try {
    const next = { ...readLocalSettings(), ...patch };
    window.localStorage.setItem(LOCAL_SETTINGS_STORE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('[大狗Tap] 本地设置保存失败。', error);
  }
}

/* 本地适配器：提供与原 Toy SDK 一致的 getCloudStorage / setCloudStorage 接口，
   使上层 initializeToyCloudState 等逻辑无需改动即改用本地存储。 */
const localToyAdapter = Object.freeze({
  async getCloudStorage() {
    const stored = readLocalSettings();
    const result = {};
    for (const key of TOY_CLOUD_KEY_LIST) {
      result[key] = Object.prototype.hasOwnProperty.call(stored, key)
        ? stored[key]
        : null;
    }
    result[TOY_CLOUD_KEYS.sfxUnlocked] = '1';
    return result;
  },
  async setCloudStorage(items) {
    writeLocalSettings(items || {});
  },
});

/* ---------- DOM ---------- */
const stage     = document.getElementById('stage');
const fxCanvas  = document.getElementById('fx');
const dogEl     = document.getElementById('dog');
const dogInner  = document.getElementById('dog-inner');
const dogJelly  = document.getElementById('dog-jelly');
const dogCloseImage = document.getElementById('dog-close');
const dogOpenImage = document.getElementById('dog-open');
const dogAnimationCanvas = document.getElementById('dog-animation');
const dogAnimationAtlas = document.getElementById('dog-animation-atlas');
const dogAnimation2d = dogAnimationCanvas.getContext('2d', { alpha: true });
const overlay   = document.getElementById('overlay');
const keyGrid   = document.getElementById('key-grid');
const flashLayer = document.getElementById('zoneflash');
const subEl     = overlay.querySelector('.sub');
const fx2d      = fxCanvas.getContext('2d');
const topControls = document.getElementById('top-controls');
const topControlsButtons = [...topControls.querySelectorAll('button')];
const musicToggle = document.getElementById('music-toggle');
const sfxSetButton = document.getElementById('sfx-set-toggle');
const octaveToggleButton = document.getElementById('octave-toggle');
const characterSetButton = document.getElementById('character-set-toggle');
const characterSetIcon = document.getElementById('character-set-icon');
const characterAddButton = document.getElementById('character-add-toggle');
const ccmModal = document.getElementById('custom-character-modal');
const ccmSlotClose = document.getElementById('ccm-slot-close');
const ccmSlotOpen = document.getElementById('ccm-slot-open');
const ccmFileInputClose = document.getElementById('ccm-file-close');
const ccmFileInputOpen = document.getElementById('ccm-file-open');
const ccmPreview = document.getElementById('ccm-preview');
const ccmNameInput = document.getElementById('ccm-name');
const ccmConfirm = document.getElementById('ccm-confirm');
const ccmCancel = document.getElementById('ccm-cancel');
const ccmExisting = document.getElementById('ccm-existing');
const ccmExistingList = document.getElementById('ccm-existing-list');
const sfxSetLabel = document.getElementById('sfx-set-label');
const sfxSetMuteIcon = document.getElementById('sfx-set-mute-icon');
const performanceSettingButtons = [
  ...document.querySelectorAll('[data-setting]'),
];
const toyNotice = document.getElementById('toy-notice');
const reduceUiMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* 顶部控件改为常驻显示，不再闲置隐藏。
   这三个函数保留为空实现，避免改动散落各处的调用点。 */
function showControls() {}
function hideControlsUntilIdle() {}
function accelerateControlsReveal() {}

function setBusMuted(bus, muted) {
  if (!ctx || !bus) return;
  const now = ctx.currentTime;
  bus.gain.cancelScheduledValues(now);
  bus.gain.setTargetAtTime(muted ? 0 : 1, now, 0.015);
}

function updateMuteButton(button, muted, label) {
  const action = muted ? '开启' : '关闭';
  button.classList.toggle('is-muted', muted);
  button.setAttribute('aria-pressed', String(muted));
  button.setAttribute('aria-label', `${action}${label}`);
  button.title = `${action}${label}`;
}

function toggleMusic() {
  bgmMuted = !bgmMuted;
  setBusMuted(bgmBus, bgmMuted);
  updateMuteButton(musicToggle, bgmMuted, '音乐');
}

function setRhythmScale(element, pulse, amount) {
  element.style.setProperty(
    '--rhythm-scale',
    (1 + pulse * amount).toFixed(4)
  );
}

function updateUiRhythm(beatPosition) {
  const pulse = (!Number.isFinite(beatPosition) || reduceUiMotion)
    ? 0
    : Math.pow(1 - (((beatPosition % 1) + 1) % 1), 4.5);
  // 所有顶部按钮都随节拍跳动；背景音乐静音时音乐按钮不跳。
  for (const button of topControlsButtons) {
    const suppress = button === musicToggle && bgmMuted;
    setRhythmScale(button, suppress ? 0 : pulse, 0.075);
  }
}

for (const button of topControls.querySelectorAll('button')) {
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('pointermove', (event) => event.stopPropagation());
  button.addEventListener('pointerup', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => event.stopPropagation());
}
musicToggle.addEventListener('click', toggleMusic);

/* ---------- 设置面板与 Toy 云状态 ---------- */
let toyNoticeTimer = 0;
const toyCloudState = {
  toy: null,
  initialized: false,
  environmentAvailable: false,
  cloudReadable: false,
  sfxUnlocked: true,
  settingsSeen: false,
  newSeen: {
    dingdong: false,
    hajimi: false,
  },
  locallyChanged: {
    settingsSeen: false,
    dingdong: false,
    hajimi: false,
  },
};
const PERFORMANCE_SETTING_KEYS = Object.freeze({
  pianoMode: TOY_CLOUD_KEYS.pianoMode,
});

function showToyNotice(message, isError = false) {
  clearTimeout(toyNoticeTimer);
  toyNotice.textContent = message;
  toyNotice.classList.toggle('is-error', isError);
  toyNotice.classList.add('is-visible');
  toyNotice.setAttribute('aria-hidden', 'false');
  toyNoticeTimer = setTimeout(() => {
    toyNotice.classList.remove('is-visible');
    toyNotice.setAttribute('aria-hidden', 'true');
  }, 4800);
}

function clearQueuedPerformanceInput() {
  inputQueue.length = 0;
  lastCommittedInputTime = -Infinity;
  clearInputVisualTimers();
  for (const state of pointers.values()) state.pendingEntryId = null;
}

function settleActivePerformanceInput() {
  clearQueuedPerformanceInput();
  for (const inputId of [...pointers.keys()]) endInput(inputId, true);
}

function normalizePianoOctaveStart(value) {
  const octave = Number(value);
  return Number.isInteger(octave) &&
    octave >= PIANO_OCTAVE_MIN &&
    octave <= PIANO_OCTAVE_MAX
    ? octave
    : PIANO_DEFAULT_OCTAVE_START;
}

function effectivePianoOctaveStart(settings = performanceSettings) {
  return settings.pianoMode
    ? normalizePianoOctaveStart(settings.pianoOctaveStart)
    : PIANO_DEFAULT_OCTAVE_START;
}

function octaveControlsEnabled(settings = performanceSettings) {
  return settings.pianoMode;
}


function renderKeyGrid() {
  keyGrid.style.setProperty('--key-grid-cols', String(cols));
  keyGrid.style.setProperty('--key-grid-rows', String(rows));
  keyGrid.classList.toggle('is-visible', performanceSettings.showGrid);

  const fragment = document.createDocumentFragment();
  for (const zone of zones) {
    const cell = document.createElement('div');
    cell.className = 'key-grid-cell';
    cell.dataset.sample = zone.sample;
    if (zone.note) cell.dataset.note = zone.note;
    fragment.appendChild(cell);
  }
  keyGrid.replaceChildren(fragment);
}

function applyPerformanceSettings(previousSettings) {
  if (
    previousSettings &&
    previousSettings.rhythmSnap !== performanceSettings.rhythmSnap
  ) {
    // 切换量化方式时丢弃尚未发声的旧队列，避免旧模式的声音滞后冒出。
    clearQueuedPerformanceInput();
  }

  const scaleChanged = previousSettings && (
    previousSettings.pianoMode !== performanceSettings.pianoMode ||
    effectivePianoOctaveStart(previousSettings) !== effectivePianoOctaveStart()
  );
  if (scaleChanged) settleActivePerformanceInput();

  if (
    zones.length === 0 ||
    !previousSettings ||
    previousSettings.pianoMode !== performanceSettings.pianoMode ||
    effectivePianoOctaveStart(previousSettings) !== effectivePianoOctaveStart()
  ) {
    buildGrid();
  } else {
    renderKeyGrid();
  }
}

function replacePerformanceSettings(nextSettings) {
  const previousSettings = { ...performanceSettings };
  for (const key of Object.keys(PERFORMANCE_SETTING_KEYS)) {
    performanceSettings[key] = nextSettings[key] === true;
  }
  performanceSettings.pianoOctaveStart = normalizePianoOctaveStart(
    nextSettings.pianoOctaveStart,
  );
  applyPerformanceSettings(previousSettings);
}

function resetPerformanceSettingsToDefaults() {
  replacePerformanceSettings(DEFAULT_PERFORMANCE_SETTINGS);
}

function markToyCloudUnavailable(state = toyCloudState) {
  state.cloudReadable = false;
  renderToyCloudState();
}

function readCloudPerformanceSettings(cloud) {
  const settings = { ...DEFAULT_PERFORMANCE_SETTINGS };
  for (const [settingName, cloudKey] of Object.entries(PERFORMANCE_SETTING_KEYS)) {
    const value = cloud[cloudKey];
    if (value === '1') settings[settingName] = true;
    else if (value === '0') settings[settingName] = false;
  }
  const cloudOctaveStart = Number(cloud[TOY_CLOUD_KEYS.pianoOctaveStart]);
  const validCloudOctaveStart = Number.isInteger(cloudOctaveStart) &&
    cloudOctaveStart >= PIANO_OCTAVE_MIN &&
    cloudOctaveStart <= PIANO_OCTAVE_MAX;
  settings.pianoOctaveStart = validCloudOctaveStart
    ? cloudOctaveStart
    : PIANO_DEFAULT_OCTAVE_START;
  return settings;
}

function renderPerformanceSettings() {
  for (const button of performanceSettingButtons) {
    const settingName = button.dataset.setting;
    const isActive = performanceSettings[settingName] === true;
    button.setAttribute('aria-checked', String(isActive));
    button.classList.toggle('is-active', isActive);
    button.disabled = !toyCloudState.initialized || performanceSettingsSaving;
  }
  updateOctaveButton();
}

function renderToyCloudState() {
  updateSfxSetButton();
  updateCharacterSetButton();
  renderPerformanceSettings();
}

// b站 Toy SDK 已移除：环境始终可用，直接返回本地存储适配器。
function detectToyEnvironment() {
  return localToyAdapter;
}

async function initializeToyCloudState() {
  const toy = await detectToyEnvironment();
  if (!toy) {
    toyCloudState.initialized = true;
    resetPerformanceSettingsToDefaults();
    renderToyCloudState();
    return toyCloudState;
  }

  toyCloudState.toy = toy;
  toyCloudState.environmentAvailable = true;

  try {
    const cloud = await toy.getCloudStorage(TOY_CLOUD_KEY_LIST);
    if (!cloud || typeof cloud !== 'object') {
      throw new Error('Toy 云存储返回值无效');
    }
    toyCloudState.cloudReadable = true;
    toyCloudState.sfxUnlocked = true;
    replacePerformanceSettings(readCloudPerformanceSettings(cloud));

    if (!toyCloudState.locallyChanged.settingsSeen) {
      toyCloudState.settingsSeen =
        cloud[TOY_CLOUD_KEYS.settingsSeen] === '1';
    }
    if (!toyCloudState.locallyChanged.dingdong) {
      toyCloudState.newSeen.dingdong =
        cloud[TOY_CLOUD_KEYS.dingdongNewSeen] === '1';
    }
    if (!toyCloudState.locallyChanged.hajimi) {
      toyCloudState.newSeen.hajimi =
        cloud[TOY_CLOUD_KEYS.hajimiNewSeen] === '1';
    }
  } catch (error) {
    // 读取不可用时，三个演奏设置也必须整体保持默认值。
    toyCloudState.cloudReadable = false;
    resetPerformanceSettingsToDefaults();
    console.warn('[大狗Tap] Toy 云状态读取失败。', error);
  }

  toyCloudState.initialized = true;
  renderToyCloudState();
  return toyCloudState;
}

function persistSeenState(items) {
  void toyStateReady.then(async (state) => {
    if (!state.environmentAvailable || !state.cloudReadable || !state.toy) return;

    try {
      await state.toy.setCloudStorage(items);
    } catch (error) {
      markToyCloudUnavailable(state);
      console.warn('[大狗Tap] 提醒状态写入失败。', error);
      showToyNotice(
        '状态保存失败，请确认已登录哔哩哔哩后刷新重试。',
        true
      );
    }
  });
}


function markSfxNewSeen(sfxId) {
  if (!VIDEO_UNLOCK_ITEM_IDS.has(sfxId) || toyCloudState.newSeen[sfxId]) return;
  toyCloudState.newSeen[sfxId] = true;
  toyCloudState.locallyChanged[sfxId] = true;
  renderToyCloudState();
  const key = sfxId === 'dingdong'
    ? TOY_CLOUD_KEYS.dingdongNewSeen
    : TOY_CLOUD_KEYS.hajimiNewSeen;
  persistSeenState({ [key]: '1' });
}

function markAllSfxNewSeen() {
  const items = {};
  for (const sfxId of VIDEO_UNLOCK_ITEM_IDS) {
    if (toyCloudState.newSeen[sfxId]) continue;
    toyCloudState.newSeen[sfxId] = true;
    toyCloudState.locallyChanged[sfxId] = true;
    const key = sfxId === 'dingdong'
      ? TOY_CLOUD_KEYS.dingdongNewSeen
      : TOY_CLOUD_KEYS.hajimiNewSeen;
    items[key] = '1';
  }

  if (Object.keys(items).length === 0) return;
  renderToyCloudState();
  persistSeenState(items);
}


function getAudioBeatPosition() {
  return started && ctx && startTime > 0 && ctx.currentTime >= startTime
    ? (ctx.currentTime - startTime) / SPB
    : null;
}

function alignHajimiAnimationToBeat() {
  const beatPosition = getAudioBeatPosition();
  hajimiAnimationEpochBeat = Number.isFinite(beatPosition)
    ? Math.ceil(beatPosition - 0.03)
    : 0;
  hajimiAnimationFrame = -1;
}

function renderHajimiAnimationFrame(beatPosition) {
  if (!hajimiAnimationReady) return;
  const relativeBeat = Number.isFinite(beatPosition)
    ? beatPosition - hajimiAnimationEpochBeat
    : 0;
  const loopBeat = relativeBeat > 0
    ? relativeBeat % HAJIMI_ANIMATION_BEATS
    : 0;
  const frameIndex = Math.min(
    HAJIMI_ANIMATION_FRAME_COUNT - 1,
    Math.floor(loopBeat * HAJIMI_FRAMES_PER_BEAT)
  );
  if (frameIndex === hajimiAnimationFrame) return;
  hajimiAnimationFrame = frameIndex;

  const sourceX =
    (frameIndex % HAJIMI_ATLAS_COLUMNS) * HAJIMI_ATLAS_FRAME_WIDTH;
  const sourceY =
    Math.floor(frameIndex / HAJIMI_ATLAS_COLUMNS) * HAJIMI_ATLAS_FRAME_HEIGHT;
  dogAnimation2d.clearRect(
    0,
    0,
    HAJIMI_ATLAS_FRAME_WIDTH,
    HAJIMI_ATLAS_FRAME_HEIGHT
  );
  dogAnimation2d.drawImage(
    dogAnimationAtlas,
    sourceX,
    sourceY,
    HAJIMI_ATLAS_FRAME_WIDTH,
    HAJIMI_ATLAS_FRAME_HEIGHT,
    0,
    0,
    HAJIMI_ATLAS_FRAME_WIDTH,
    HAJIMI_ATLAS_FRAME_HEIGHT
  );
}

function applyCharacterVisibility() {
  const isAnimation = isAnimationCharacter(selectedCharacterId);
  const showAnimation = isAnimation && hajimiAnimationReady;
  // 动画形象一选中就进入动画显示模式，立即隐藏底层静态图；
  // 否则 atlas 加载期间会短暂露出默认 maodie_close_mouth.png。
  dogInner.classList.toggle('is-emperor-animation', isAnimation);
  dogAnimationCanvas.setAttribute('aria-hidden', String(!showAnimation));

  // 哈基米（maodie）与自定义形象（builtin:false）两张图轮廓/透明区域不一致，需互斥可见，
  // 避免透明背景叠加时下层闭嘴图透出造成重影；其余内置形象用通用透明度切换。
  const isExclusiveMouth = selectedCharacterId === 'maodie'
    || CHARACTER_IMAGE_SETS[selectedCharacterId]?.builtin === false;
  dogInner.classList.toggle('is-hajimi', !isAnimation && isExclusiveMouth);

  if (isAnimation) {
    dogCloseImage.alt = '';
  } else {
    const set = CHARACTER_IMAGE_SETS[selectedCharacterId]
      ?? CHARACTER_IMAGE_SETS.maodie
      ?? CHARACTER_IMAGE_SETS.dagou;
    if (set) {
      dogCloseImage.src = set.close;
      dogCloseImage.alt = set.alt;
      dogOpenImage.src = set.open;
    }
  }

  if (showAnimation) renderHajimiAnimationFrame(getAudioBeatPosition());
}

function ensureHajimiAnimationLoaded() {
  const atlasUrl = currentAnimationAtlasUrl();
  if (hajimiAnimationReady && hajimiAnimationAtlasUrl === atlasUrl) return;
  if (hajimiAnimationRequested && hajimiAnimationAtlasUrl === atlasUrl) return;
  hajimiAnimationReady = false;
  hajimiAnimationRequested = true;
  hajimiAnimationAtlasUrl = atlasUrl;
  hajimiAnimationFrame = -1;
  dogAnimationAtlas.src = atlasUrl;
}

function updateSfxSetButton() {
  if (!sfxSetButton) return;
  const muted = sfxMuted;
  if (sfxSetMuteIcon) sfxSetMuteIcon.style.display = muted ? '' : 'none';
  const label = muted ? '关闭音效' : (SFX_LABEL[selectedSfxId] ?? 'ha-ji-mi');
  if (sfxSetLabel) sfxSetLabel.textContent = label;
  sfxSetButton.classList.toggle('is-muted', muted);
  sfxSetButton.setAttribute('aria-label', muted ? '开启音效' : `切换音效，当前${label}`);
}

function currentSfxKey() {
  return sfxMuted ? 'mute' : selectedSfxId;
}

function applySfxKey(key) {
  if (key === 'mute') {
    if (!sfxMuted) {
      sfxMuted = true;
      setBusMuted(sfxBus, true);
      dogInner.classList.remove('bark-image');
    }
  } else {
    selectedSfxId = SFX_SAMPLE_SETS[key] ? key : 'hajimi';
    if (sfxMuted) {
      sfxMuted = false;
      setBusMuted(sfxBus, false);
      if (mouthVoice) dogInner.classList.add('bark-image');
    }
  }
  updateSfxSetButton();
}

// 顶部音效按钮：点击在 da-gou-jiao → ding-dong-ji → ha-ji-mi → 关闭音效 之间循环。
function cycleSfx() {
  const order = SFX_CYCLE_ORDER;
  const idx = order.indexOf(currentSfxKey());
  const next = order[(idx + 1) % order.length];
  applySfxKey(next);
  if (next !== 'mute') markSfxNewSeen(next);
}

// 顶部形象按钮：在所有形象（内置 + 自定义）间循环切换，只改画面角色、不改音效。
function cycleCharacterSet() {
  if (!CHARACTER_SET_CYCLE.length) return;
  const idx = CHARACTER_SET_CYCLE.indexOf(selectedCharacterId);
  const next = CHARACTER_SET_CYCLE[(idx + 1) % CHARACTER_SET_CYCLE.length];
  selectedCharacterId = next;
  if (isAnimationCharacter(next)) {
    alignHajimiAnimationToBeat();
    ensureHajimiAnimationLoaded();
    if (!hajimiAnimationReady) showToyNotice('正在加载动画形象…');
  }
  applyCharacterVisibility();
  updateCharacterSetButton();
  persistSelectedCharacter();
}

// 顶部形象按钮文字/图标同步当前形象（含自定义形象的小图与显示名）。
function updateCharacterSetButton() {
  if (!characterSetButton) return;
  const icon = CHARACTER_SET_ICON[selectedCharacterId] ?? CHARACTER_SET_ICON.maodie;
  const label = CHARACTER_SET_LABEL[selectedCharacterId] ?? '哈基米';
  if (characterSetIcon) characterSetIcon.src = icon;
  characterSetButton.setAttribute('aria-label', `切换形象，当前${label}`);
}

/* ---------- 自定义形象编辑器：顶部「+」按钮打开弹层，上传双图 → 预览 → 存储 → 切换。 ---------- */

// 把用户选的图片文件缩放到目标宽度（或强制目标尺寸）后输出 PNG dataURL。
// 张嘴帧会以闭嘴帧尺寸强制对齐，保证两帧切换不跳动。
function compressCharacterImage(file, targetWidth, targetHeight) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      let w;
      let h;
      if (targetWidth && targetHeight) {
        w = targetWidth;
        h = targetHeight; // 张嘴帧对齐闭嘴帧
      } else {
        const scale = Math.min(1, CUSTOM_CHARACTER_MAX_WIDTH / probe.naturalWidth);
        w = Math.max(1, Math.round(probe.naturalWidth * scale));
        h = Math.max(1, Math.round(probe.naturalHeight * scale));
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const c2d = canvas.getContext('2d');
      c2d.clearRect(0, 0, w, h);
      c2d.drawImage(probe, 0, 0, w, h);
      URL.revokeObjectURL(objectUrl);
      // 去白底：把白色背景改成透明，便于角色在彩色背景上显示。
      removeWhiteBackground(c2d, w, h);
      try {
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: w, height: h });
      } catch (err) {
        reject(err);
      }
    };
    probe.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片读取失败'));
    };
    probe.src = objectUrl;
  });
}

// 去白底：从图片四边做 flood fill，把与边缘连通的"近白"像素改为透明。
// 只去背景白，不误伤被角色包围的白色部位（如白肚皮）；用栈迭代避免递归栈溢出。
const WHITE_BG_THRESHOLD = 240; // RGB 三通道均 >= 此值视为白（容忍 JPEG 压缩噪点）
function removeWhiteBackground(c2d, w, h) {
  const imageData = c2d.getImageData(0, 0, w, h);
  const data = imageData.data;
  const isWhitish = (offset) =>
    data[offset] >= WHITE_BG_THRESHOLD &&
    data[offset + 1] >= WHITE_BG_THRESHOLD &&
    data[offset + 2] >= WHITE_BG_THRESHOLD;
  const visited = new Uint8Array(w * h);
  const stack = [];
  const seed = (x, y) => {
    if (isWhitish((y * w + x) * 4)) stack.push(x, y);
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    const p = y * w + x;
    if (visited[p]) continue;
    visited[p] = 1;
    if (!isWhitish(p * 4)) continue;
    data[p * 4 + 3] = 0; // 改为透明
    if (x > 0 && !visited[p - 1]) stack.push(x - 1, y);
    if (x < w - 1 && !visited[p + 1]) stack.push(x + 1, y);
    if (y > 0 && !visited[p - w]) stack.push(x, y - 1);
    if (y < h - 1 && !visited[p + w]) stack.push(x, y + 1);
  }
  c2d.putImageData(imageData, 0, 0);
}

// 把已有的 dataURL 图片重绘到指定尺寸，输出新 dataURL；保存时用它把张嘴帧对齐到闭嘴帧。
function resizeDataUrl(dataUrl, width, height) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const c2d = canvas.getContext('2d');
      c2d.clearRect(0, 0, width, height);
      c2d.drawImage(probe, 0, 0, width, height);
      try {
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(err);
      }
    };
    probe.onerror = () => reject(new Error('图片缩放失败'));
    probe.src = dataUrl;
  });
}

// 弹层编辑态：slot 标记当前正在选哪一帧；closeImg/openImg 为压缩后的两帧。
const customEditorState = { slot: null, closeImg: null, openImg: null };

function refreshCustomEditorSlots() {
  for (const slot of ['close', 'open']) {
    const btn = slot === 'close' ? ccmSlotClose : ccmSlotOpen;
    const img = btn.querySelector('.ccm-slot-img');
    const data = customEditorState[`${slot}Img`];
    if (data) {
      img.src = data.dataUrl;
      btn.classList.add('is-filled');
    } else {
      img.removeAttribute('src');
      btn.classList.remove('is-filled');
    }
  }
  refreshCustomEditorPreview();
}

function refreshCustomEditorPreview() {
  const { closeImg, openImg } = customEditorState;
  const closeI = ccmPreview.querySelector('.ccm-preview-close');
  const openI = ccmPreview.querySelector('.ccm-preview-open');
  const ready = !!(closeImg && openImg);
  if (ready) {
    closeI.src = closeImg.dataUrl;
    openI.src = openImg.dataUrl;
    ccmPreview.classList.add('has-img');
  } else {
    closeI.removeAttribute('src');
    openI.removeAttribute('src');
    ccmPreview.classList.remove('has-img', 'is-open');
  }
  ccmConfirm.disabled = !ready;
  ccmConfirm.classList.toggle('is-ready', ready);
}

// 槽位用 <label for="ccm-file-xxx"> 原生触发各自隐藏的 file input，
// 无需 JS click()，连续选择闭嘴/张嘴两帧稳定可靠。
async function onCustomFileChange(event) {
  const input = event.currentTarget;
  const file = input.files && input.files[0];
  if (!file) return;
  const slot = input === ccmFileInputClose ? 'close' : 'open';
  try {
    // 每帧各自按最大宽度独立压缩；保存时再把张嘴帧对齐到闭嘴帧尺寸。
    const result = await compressCharacterImage(file, null, null);
    customEditorState[`${slot}Img`] = result;
    refreshCustomEditorSlots();
  } catch (err) {
    console.warn('[大狗Tap] 自定义形象图片处理失败。', err);
    showToyNotice('图片读取失败，换一张试试。', true);
  }
}

function refreshCustomExistingList() {
  // 自定义形象 = 后端清单里 builtin:false 的条目（运行时存在 CHARACTER_IMAGE_SETS）。
  const list = Object.values(CHARACTER_IMAGE_SETS)
    .filter((c) => c.builtin === false)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  ccmExistingList.replaceChildren();
  if (!list.length) {
    ccmExisting.style.display = 'none';
    return;
  }
  ccmExisting.style.display = '';
  for (const entry of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ccm-existing-item';
    item.setAttribute('aria-label', `删除自定义形象 ${entry.label}`);
    const thumb = document.createElement('img');
    thumb.src = entry.close;
    thumb.alt = '';
    const tag = document.createElement('span');
    tag.textContent = `× ${entry.label}`;
    item.append(thumb, tag);
    item.addEventListener('click', () => removeCustomCharacter(entry.id));
    ccmExistingList.append(item);
  }
}

async function removeCustomCharacter(id) {
  try {
    const res = await fetch(`/api/characters/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    console.warn('[大狗Tap] 自定义形象删除失败。', error);
    showToyNotice('删除失败：服务器未启动或网络错误。', true);
    return;
  }
  removeCharacterEntry(id);
  if (selectedCharacterId === id) {
    selectedCharacterId = 'dagou';
    persistSelectedCharacter();
    applyCharacterVisibility();
    updateCharacterSetButton();
  }
  refreshCustomExistingList();
  showToyNotice('已删除该自定义形象。');
}

async function confirmCustomCharacter() {
  const { closeImg, openImg } = customEditorState;
  if (!closeImg || !openImg || ccmConfirm.disabled) return;
  const label = ((ccmNameInput.value || '').trim() || '自定义').slice(0, 6);
  // 张嘴帧强制对齐到闭嘴帧尺寸，保证两帧切换不跳动。
  let openDataUrl = openImg.dataUrl;
  if (openImg.width !== closeImg.width || openImg.height !== closeImg.height) {
    try {
      openDataUrl = await resizeDataUrl(openImg.dataUrl, closeImg.width, closeImg.height);
    } catch (err) {
      console.warn('[大狗Tap] 自定义形象张嘴帧对齐失败。', err);
      showToyNotice('张嘴图处理失败，换一张试试。', true);
      return;
    }
  }
  ccmConfirm.disabled = true;
  try {
    // 上传到后端：压缩后的 PNG dataURL 由服务端解码落盘到 Image 目录，刷新或重开都会自动加载。
    const res = await fetch('/api/characters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, close: closeImg.dataUrl, open: openDataUrl }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const entry = data.character;
    if (!entry || !entry.id) throw new Error('bad server response');
    registerCharacterEntry(entry);
    selectedCharacterId = entry.id;
    persistSelectedCharacter();
    applyCharacterVisibility();
    updateCharacterSetButton();
    closeCustomCharacterModal();
    showToyNotice(`已添加并切换到形象「${label}」。`);
  } catch (error) {
    console.warn('[大狗Tap] 自定义形象上传失败。', error);
    showToyNotice('保存失败：服务器未启动或网络错误。', true);
  } finally {
    // 确认按钮可用性交回 refreshCustomEditorPreview（按两帧是否就绪控制）
    refreshCustomEditorPreview();
  }
}

function openCustomCharacterModal() {
  customEditorState.slot = null;
  customEditorState.closeImg = null;
  customEditorState.openImg = null;
  ccmNameInput.value = '';
  refreshCustomEditorSlots();
  refreshCustomExistingList();
  ccmModal.classList.add('is-open');
  ccmModal.setAttribute('aria-hidden', 'false');
}

function closeCustomCharacterModal() {
  ccmModal.classList.remove('is-open');
  ccmModal.setAttribute('aria-hidden', 'true');
}

function resolveSfxSample(sample, sfxId = selectedSfxId) {
  return SFX_SAMPLE_SETS[sfxId]?.[sample] ?? sample;
}

renderToyCloudState();
const toyStateReady = initializeToyCloudState();

// 形象由后端 Image 目录驱动：先拉取形象清单，再恢复上次的形象选择，最后同步显示。
// 异步进行：fetch 期间页面已显示（遮罩层之下），形象到位后立即刷新画面。
initCharacters();

async function initCharacters() {
  await loadCharactersFromServer();
  restoreSelectedCharacter();
  if (isAnimationCharacter(selectedCharacterId)) {
    alignHajimiAnimationToBeat();
    ensureHajimiAnimationLoaded();
  }
  applyCharacterVisibility();
  updateCharacterSetButton();
}

dogAnimationAtlas.addEventListener('load', () => {
  hajimiAnimationReady = true;
  hajimiAnimationRequested = false;
  if (isAnimationCharacter(selectedCharacterId)) alignHajimiAnimationToBeat();
  applyCharacterVisibility();
});
dogAnimationAtlas.addEventListener('error', () => {
  const wasWaitingForAnimation = isAnimationCharacter(selectedCharacterId);
  hajimiAnimationReady = false;
  hajimiAnimationRequested = false;
  hajimiAnimationAtlasUrl = '';
  dogAnimationAtlas.removeAttribute('src');
  // 动画形象加载失败时回退到哈基米原皮形象，避免画面空白。
  if (wasWaitingForAnimation) {
    selectedCharacterId = 'maodie';
    showToyNotice('动画形象加载失败，已切换为哈基米形象。', true);
  }
  applyCharacterVisibility();
});

async function handlePerformanceSettingClick(button) {
  if (performanceSettingsSaving) return;
  const settingName = button.dataset.setting;
  const cloudKey = PERFORMANCE_SETTING_KEYS[settingName];
  if (!cloudKey) return;

  const state = await toyStateReady;
  const nextValue = !performanceSettings[settingName];
  if (!state.environmentAvailable || !state.cloudReadable || !state.toy) {
    replacePerformanceSettings({
      ...performanceSettings,
      [settingName]: nextValue,
    });
    renderToyCloudState();
    showToyNotice('云存储不可用，本次设置仅在当前页面有效。');
    return;
  }

  performanceSettingsSaving = true;
  renderPerformanceSettings();
  try {
    await state.toy.setCloudStorage({
      [cloudKey]: nextValue ? '1' : '0',
    });
    replacePerformanceSettings({
      ...performanceSettings,
      [settingName]: nextValue,
    });
  } catch (error) {
    // 写入失败后降级为本地会话设置，保留用户刚刚选择的值。
    markToyCloudUnavailable(state);
    replacePerformanceSettings({
      ...performanceSettings,
      [settingName]: nextValue,
    });
    console.warn('[大狗Tap] 演奏设置写入失败。', error);
    showToyNotice('云存储不可用，本次设置仅在当前页面有效。');
  } finally {
    performanceSettingsSaving = false;
    renderToyCloudState();
  }
}

for (const button of performanceSettingButtons) {
  button.addEventListener('click', () => {
    void handlePerformanceSettingClick(button);
  });
}

async function flushPianoOctaveCloudWrite() {
  const state = await toyStateReady;
  if (!state.environmentAvailable || !state.cloudReadable || !state.toy) {
    pendingPianoOctaveCloudValue = null;
    pianoOctaveCloudWriteRunning = false;
    return;
  }

  while (pendingPianoOctaveCloudValue !== null) {
    const octave = pendingPianoOctaveCloudValue;
    pendingPianoOctaveCloudValue = null;
    try {
      await state.toy.setCloudStorage({
        [TOY_CLOUD_KEYS.pianoOctaveStart]: String(octave),
      });
    } catch (error) {
      pendingPianoOctaveCloudValue = null;
      markToyCloudUnavailable(state);
      console.warn('[大狗Tap] 八度档位写入失败。', error);
      showToyNotice('云存储不可用，本次八度仅在当前页面有效。');
      break;
    }
  }

  pianoOctaveCloudWriteRunning = false;
  renderToyCloudState();
}

function queuePianoOctaveCloudWrite(octave) {
  pendingPianoOctaveCloudValue = normalizePianoOctaveStart(octave);
  if (pianoOctaveCloudWriteRunning) return;
  pianoOctaveCloudWriteRunning = true;
  void flushPianoOctaveCloudWrite();
}

function shiftPianoOctave(direction) {
  if (!octaveControlsEnabled()) return false;
  const currentOctave = normalizePianoOctaveStart(
    performanceSettings.pianoOctaveStart,
  );
  const targetOctave = currentOctave + direction;
  if (targetOctave < PIANO_OCTAVE_MIN || targetOctave > PIANO_OCTAVE_MAX) {
    updateOctaveButton();
    return true;
  }

  const previousSettings = { ...performanceSettings };
  performanceSettings.pianoOctaveStart = targetOctave;
  applyPerformanceSettings(previousSettings);
  renderToyCloudState();
  queuePianoOctaveCloudWrite(targetOctave);
  return true;
}

// 顶部八度按钮：点击在 C3–C6 之间循环切换起始八度。
function cyclePianoOctave() {
  if (!performanceSettings.pianoMode) return;
  const current = normalizePianoOctaveStart(performanceSettings.pianoOctaveStart);
  const idx = OCTAVE_CYCLE.indexOf(current);
  const next = OCTAVE_CYCLE[(idx + 1) % OCTAVE_CYCLE.length];
  const previousSettings = { ...performanceSettings };
  performanceSettings.pianoOctaveStart = next;
  applyPerformanceSettings(previousSettings);
  renderToyCloudState();
  queuePianoOctaveCloudWrite(next);
}

function updateOctaveButton() {
  if (!octaveToggleButton) return;
  // 始终显示当前选中的起始八度（pianoOctaveStart），钢琴按钮只控制启用/禁用，
  // 不因钢琴模式开关而在 C4(默认) 与记忆值之间跳变。
  const octave = normalizePianoOctaveStart(performanceSettings.pianoOctaveStart);
  const label = octaveToggleButton.querySelector('#octave-toggle-label');
  if (label) label.textContent = `C${octave}`;
  octaveToggleButton.disabled = !performanceSettings.pianoMode;
  octaveToggleButton.setAttribute('aria-label', `切换八度，当前 C${octave}`);
}

/* 三套音效都保留 da / gou / jiao 的语义位置，只替换实际播放采样。 */
sfxSetButton.addEventListener('click', cycleSfx);
characterSetButton.addEventListener('click', cycleCharacterSet);
characterAddButton.addEventListener('click', openCustomCharacterModal);
ccmFileInputClose.addEventListener('change', onCustomFileChange);
ccmFileInputOpen.addEventListener('change', onCustomFileChange);
// 打开文件框前清空 value，使"重复选同一文件 / 替换已选图"也能触发 change。
ccmFileInputClose.addEventListener('click', (e) => { e.target.value = ''; });
ccmFileInputOpen.addEventListener('click', (e) => { e.target.value = ''; });
ccmPreview.addEventListener('click', () => {
  if (ccmPreview.classList.contains('has-img')) ccmPreview.classList.toggle('is-open');
});
ccmConfirm.addEventListener('click', confirmCustomCharacter);
ccmCancel.addEventListener('click', closeCustomCharacterModal);
// 弹层在 #stage 内，必须阻断 pointerdown 冒泡，否则会被舞台的 pointerdown
// 处理（preventDefault + setPointerCapture）抢走指针，导致槽位/按钮点不动并误播音效。
ccmModal.addEventListener('pointerdown', (event) => event.stopPropagation());
ccmModal.addEventListener('click', (event) => {
  if (event.target === ccmModal) closeCustomCharacterModal();
});
octaveToggleButton.addEventListener('click', cyclePianoOctave);

/* ---------- 和弦走向：C - G - Am - F（简单洗脑） ---------- */
const CHORDS = [
  { bass: 65.41, notes: [261.63, 329.63, 392.00, 523.25] }, // C
  { bass: 49.00, notes: [196.00, 246.94, 293.66, 392.00] }, // G
  { bass: 55.00, notes: [220.00, 261.63, 329.63, 440.00] }, // Am
  { bass: 43.65, notes: [174.61, 220.00, 261.63, 349.23] }, // F
];
const HAT_VEL = [0.34, 0.16, 0.42, 0.16];

// tools/analyze_pitch.py 实测所得：高能量、高置信度有声帧 MIDI 的加权中位数。
// 每段原音音高不一致，因此每个按键都从各自锚点反推固定目标音的 playbackRate。
const BARK_SOURCE_MIDI = Object.freeze({
  da: 71.1950846771,
  gou: 65.5950930881,
  jiao: 71.1226079346,
  ha: 72.6652936920031,
  ji: 67.55506219280217,
  mi: 65.47641325112846,
  dingdongji_ding: 68.72369809072657,
  dingdongji_dong: 68.20736701647688,
  dingdongji_ji: 69.48535473104747,
});

// ha_new 的 A5 跨度较大；普通模式使用全四档复测后的 minimax 补偿锚点。
// 钢琴模式仍使用上方实测锚点，避免影响 C4–C5 的既有校准。
const BARK_NORMAL_SOURCE_MIDI = Object.freeze({
  ha: 72.732,
});

// 极端钢琴八度复测若出现稳定的整体偏差，只允许按“样本 + 起始八度”
// 修正一个共同锚点；同一八度内八个白键仍严格保持十二平均律间隔。
const BARK_PIANO_SOURCE_MIDI = Object.freeze({
  // One minimax anchor per sample + octave keeps broad detector drift from
  // turning into eight hand-tuned key values. C6 mi remains intentionally
  // direct-pitched: a single anchor improves its extrema but cannot erase the
  // non-uniform high-register analysis error.
  mi: Object.freeze({
    5: 65.60141325112846,
    6: 65.17172575112846,
  }),
  dingdongji_ding: Object.freeze({
    3: 68.49322934072657,
    6: 68.86822934072657,
  }),
  dingdongji_ji: Object.freeze({
    6: 69.64941723104747,
  }),
});

// 固定 A 小调五声音阶（A–C–D–E–G）。大狗叫与叮咚鸡的第三档是最接近
// 原声的音；哈基米移除旧最低档、将原前三档后移，因此第四档最接近原声。
const BARK_TARGET_MIDI = Object.freeze({
  da: Object.freeze([79, 76, 72, 69]),    // G5, E5, C5, A4
  gou: Object.freeze([72, 69, 67, 64]),   // C5, A4, G4, E4
  jiao: Object.freeze([79, 76, 72, 69]),  // G5, E5, C5, A4
  ha: Object.freeze([81, 79, 76, 72]),    // A5, G5, E5, C5
  ji: Object.freeze([74, 72, 69, 67]),    // D5, C5, A4, G4
  mi: Object.freeze([72, 69, 67, 64]),    // C5, A4, G4, E4
  dingdongji_ding: Object.freeze([74, 72, 69, 67]), // D5, C5, A4, G4
  dingdongji_dong: Object.freeze([74, 72, 69, 67]), // D5, C5, A4, G4
  dingdongji_ji: Object.freeze([74, 72, 69, 67]),   // D5, C5, A4, G4
});

// 20 ms 有声帧门限 RMS，以 da.wav 为响度基准。Web Audio 使用浮点链路，
// 较大的音色补偿会先经过现有 DynamicsCompressor，再输出到设备。
const SFX_SAMPLE_GAIN = Object.freeze({
  da: 1.0000000000,
  gou: 1.012898017161218,
  jiao: 0.953577156471302,
  ha: 1.283378415934229,
  ji: 1.4777851484035351,
  mi: 1.4846115949156913,
  dingdongji_ding: 2.5889190244772604,
  dingdongji_dong: 2.3637451111911507,
  dingdongji_ji: 2.3501763429894065,
});

// 钢琴模式按起始八度动态生成 C 大调白键；第八键以高音 C 闭合完整八度。
const PIANO_SCALE_INTERVALS = Object.freeze([0, 2, 4, 5, 7, 9, 11, 12]);
const PIANO_SCALE_NOTES = Object.freeze(['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C']);
const PIANO_SCALE_SOLFEGE = Object.freeze(['do', 're', 'mi', 'fa', 'sol', 'la', 'si', 'do']);

function buildPianoScale(octaveStart = PIANO_DEFAULT_OCTAVE_START) {
  const octave = normalizePianoOctaveStart(octaveStart);
  const baseMidi = (octave + 1) * 12;
  return PIANO_SCALE_INTERVALS.map((interval, index) => Object.freeze({
    midi: baseMidi + interval,
    note: `${PIANO_SCALE_NOTES[index]}${index === 7 ? octave + 1 : octave}`,
    solfege: PIANO_SCALE_SOLFEGE[index],
  }));
}
const PIANO_KEYBOARD_ROWS = Object.freeze([
  Object.freeze(['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI']),
  Object.freeze(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK']),
  Object.freeze(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma']),
]);
const PIANO_KEYBOARD_SAMPLES = Object.freeze(['da', 'gou', 'jiao']);

/* ============================================================
 * 主色调色板（全页面只用这几支颜色）
 * ==========================================================*/
const C = {
  cream: '#fff2dc',   // 背景 · 米白（固定不变）
  amber: '#ffb400',   // 主色 · 黄
  gray:  '#87837e',   // 次要 · 灰
  coral: '#ff5a5f',   // 点缀（少量）
  teal:  '#16c2a3',   // 点缀（少量）
  blue:  '#3e7bfa',   // 点缀（少量）
};
const ACCENTS = [C.coral, C.teal, C.blue];

/* 形状取色：约 62% 主色黄，28% 灰，10% 点缀色 */
function pickColor(rng) {
  const r = rng();
  if (r < 0.62) return C.amber;
  if (r < 0.9) return C.gray;
  return ACCENTS[(rng() * ACCENTS.length) | 0];
}

/* ---------- 12 个全屏特效（均以屏幕正中心为原点，铺满全屏） ---------- */
const EFFECTS = [
  'rings',    // 同心环爆发
  'poly',     // 多边形绽放
  'spiral',   // 螺旋弹珠
  'rays',     // 放射光芒
  'confetti', // 几何纸屑
  'zigzag',   // 折线穿越
  'pop',      // 弹性几何雨
  'cross',    // 巨大十字
  'orbit',    // 环绕轨道
  'wave',     // 波浪丝带
  'stars',    // 星星弹跳
  'grid',     // 旋转线栅
];

/* ============================================================
 * 音频初始化
 * ==========================================================*/
function initAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  bgmBus = ctx.createGain();
  bgmBus.gain.value = bgmMuted ? 0 : 1;
  sfxBus = ctx.createGain();
  sfxBus.gain.value = sfxMuted ? 0 : 1;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 24;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  bgmBus.connect(master);
  sfxBus.connect(master);
  master.connect(comp);
  comp.connect(ctx.destination);

  // 1 秒白噪声
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function primeAudioOutputForIOS() {
  if (!ctx) return;
  try {
    const gain = ctx.createGain();
    const source = ctx.createBufferSource();
    const sampleRate = ctx.sampleRate || 44100;
    const duration = 0.06;
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(sampleRate * duration)), sampleRate);
    const now = ctx.currentTime || 0;
    source.buffer = buffer;
    gain.gain.setValueAtTime(0.00001, now);
    source.connect(gain);
    gain.connect(ctx.destination);
    source.onended = () => {
      try { source.disconnect(); } catch (_) { /* 节点可能已断开 */ }
      try { gain.disconnect(); } catch (_) { /* 节点可能已断开 */ }
    };
    source.start(now);
    source.stop(now + duration);
  } catch (error) {
    console.warn('[大狗Tap] iOS 音频通道预解锁失败。', error);
  }
}

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// 异步加载音频 base64 包（audio-data.json）。页面初始化时即 prefetch，
// 用户首次点击进入 start() -> loadSamples 时 await 同一个 promise，通常早已就绪。
let audioB64Promise = null;
function ensureAudioB64() {
  if (!audioB64Promise) {
    audioB64Promise = fetch('audio-data.json?v=20260810-m4a', { cache: 'force-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`audio-data.json HTTP ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        audioB64Promise = null; // 失败重置，允许下次交互重试
        throw err;
      });
  }
  return audioB64Promise;
}

function waitWithTimeout(promise, timeoutMs, label) {
  let timer = 0;
  return new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isLikelyIOSWebKit() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const touchPoints = navigator.maxTouchPoints || 0;
  return (
    /iP(?:hone|ad|od)/.test(platform) ||
    (/MacIntel/.test(platform) && touchPoints > 1) ||
    (/iP(?:hone|ad|od)/.test(ua))
  ) && /WebKit/i.test(ua);
}

// iOS Safari 的 decodeAudioData Promise 形式对部分格式不稳定；并行解码多个
// AAC/M4A 片段也可能让其中一个回调永久不返回，导致卡在「狗叫加载中」。回调形式
// 加硬超时后，至少能失败重试；iOS 再配合串行解码，避免 WebKit 并发解码队列卡死。
function decodeAudioDataCompat(ctx, arrayBuffer, label) {
  return waitWithTimeout(
    new Promise((resolve, reject) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      try {
        ctx.decodeAudioData(arrayBuffer, done, fail);
      } catch (error) {
        fail(error);
      }
    }),
    8000,
    `decodeAudioData(${label})`,
  );
}

function decodeSampleFromB64(name, encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error(`Missing embedded audio sample: ${name}`);
  }
  // decodeAudioData 会 detach 传入的 ArrayBuffer，每个样本必须独立转换。
  return decodeAudioDataCompat(ctx, b64ToArrayBuffer(encoded), name).then((buf) => {
    buffers[name] = buf;
  });
}

function clearDecodedSamples() {
  for (const key of Object.keys(buffers)) delete buffers[key];
  for (const key of Object.keys(sustainLoops)) delete sustainLoops[key];
  sustainTexturesBuilding = false;
}

async function resumeAudioContext(label = 'AudioContext.resume') {
  if (!ctx || ctx.state !== 'suspended') return true;
  try {
    await waitWithTimeout(ctx.resume(), 1800, label);
    return true;
  } catch (error) {
    // iOS WebKit 偶尔会让 resume() 的 promise 长时间不 settle，但同一手势里
    // 启动静音 source 后音频通道可能已经被放行；调用方会按最终 state 决定继续或重建。
    console.warn('[大狗Tap] AudioContext resume 未及时完成。', error);
    return false;
  }
}

async function closeAudioContextQuietly() {
  if (!ctx) return;
  const oldCtx = ctx;
  ctx = null;
  master = null;
  bgmBus = null;
  sfxBus = null;
  noiseBuf = null;
  try {
    if (oldCtx.state !== 'closed') {
      await waitWithTimeout(oldCtx.close(), 1200, 'AudioContext.close');
    }
  } catch (_) {
    // iOS 有时在失败的解码队列后 close 也会拒绝或挂起；下次点击重新创建即可。
  }
}

// 并行解码全部音效样本（在 start() 用户手势内创建的 ctx 上执行）。
// 桌面 / Android 继续并行，iOS WebKit 串行，规避移动 Safari 偶发永不回调。
async function loadSamples() {
  const AUDIO_B64 = await ensureAudioB64();
  if (isLikelyIOSWebKit()) {
    for (const name of RUNTIME_SAMPLE_NAMES) {
      await decodeSampleFromB64(name, AUDIO_B64[name]);
    }
    return;
  }

  await Promise.all(
    RUNTIME_SAMPLE_NAMES.map((name) => decodeSampleFromB64(name, AUDIO_B64[name])),
  );
}

// 延音纹理（WSOLA）构建是 CPU 密集的同步操作，每条纹理要合成 ~12 秒波形。
// 不放入启动关键路径：start() 解码完即隐藏遮罩，纹理在后台分片构建，
// 每构建一条让出一帧主线程，避免连续阻塞影响首屏交互。
// 构建未完成时 playPressVoice 走 !sustain 降级路径播放原音，不会报错。
let sustainTexturesBuilding = false;
function buildSustainTexturesAsync() {
  if (sustainTexturesBuilding) return;
  sustainTexturesBuilding = true;
  const names = RUNTIME_SAMPLE_NAMES.filter((n) => SUSTAIN_REGIONS[n]?.enabled);
  let i = 0;
  const tick = () => {
    if (i >= names.length) return;
    const n = names[i++];
    if (buffers[n] && !sustainLoops[n]) {
      sustainLoops[n] = buildSustainTexture(buffers[n], SUSTAIN_REGIONS[n]);
    }
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
}

function monoMix(source) {
  const mono = new Float32Array(source.length);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const data = source.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i];
  }
  const scale = 1 / source.numberOfChannels;
  for (let i = 0; i < mono.length; i++) mono[i] *= scale;
  return mono;
}

function bestWsolaStart(
  input,
  output,
  outputStart,
  overlapFrames,
  regionMin,
  regionMax,
  target,
  searchFrames,
  previousStart
) {
  const candidateStep = 8;
  const compareStep = 4;
  const lo = Math.max(regionMin, target - searchFrames);
  const hi = Math.min(regionMax, target + searchFrames);
  let bestStart = Math.max(regionMin, Math.min(regionMax, target));
  let bestScore = -Infinity;

  for (let start = lo; start <= hi; start += candidateStep) {
    let dot = 0, energyOut = 0, energyIn = 0;
    for (let i = 0; i < overlapFrames; i += compareStep) {
      const a = output[outputStart + i];
      const b = input[start + i];
      dot += a * b;
      energyOut += a * a;
      energyIn += b * b;
    }

    if (energyOut < 1e-9 || energyIn < 1e-9) continue;
    let score = dot / Math.sqrt(energyOut * energyIn);

    // 相关度接近时偏向不同位置，减少连续使用同一组声带周期。
    const distance = Math.abs(start - previousStart);
    if (distance < overlapFrames * 0.18) score -= 0.06;
    score -= Math.abs(Math.log(Math.sqrt(energyIn / energyOut))) * 0.04;

    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return bestStart;
}

/* WSOLA 风格的延音纹理：
 * 1. 在稳定元音区内以低差异序列选择不同帧；
 * 2. 用波形相关度微调每一帧的相位；
 * 3. 用 raised-cosine 重叠相加，得到数秒长且无短周期的纹理；
 * 4. 记录每次淡化结束的位置，松手时可从那里逐采样接回原音。 */
function buildSustainTexture(source, region) {
  const sr = source.sampleRate;
  const regionMin = Math.max(0, Math.round(region.regionStart * sr));
  const regionEnd = Math.min(source.length, Math.round(region.regionEnd * sr));
  const frameFrames = Math.round(region.frame * sr);
  const overlapFrames = Math.round(region.overlap * sr);
  const hopFrames = frameFrames - overlapFrames;
  const searchFrames = Math.round(region.search * sr);
  const wrapFrames = Math.round(region.wrapBlend * sr);
  const regionMax = regionEnd - frameFrames;

  if (
    regionMin >= regionMax ||
    overlapFrames <= 1 ||
    hopFrames <= 1 ||
    wrapFrames >= frameFrames
  ) {
    throw new Error('Invalid sustain region');
  }

  const requestedFrames = Math.ceil(region.textureDuration * sr);
  const workingLength = requestedFrames + frameFrames + wrapFrames;
  const channels = Array.from(
    { length: source.numberOfChannels },
    () => new Float32Array(workingLength)
  );
  const inputMono = monoMix(source);
  const outputMono = new Float32Array(workingLength);
  const releaseFrames = [];

  // 第一帧从稳定区后段进入，第二帧固定到最晚安全位置，
  // 让原始起音自然走到成熟元音后再交给纹理。
  const entryStart = regionMax;
  const firstStart = Math.max(regionMin, entryStart - overlapFrames);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    channels[ch].set(
      source.getChannelData(ch).subarray(firstStart, firstStart + frameFrames),
      0
    );
  }
  outputMono.set(
    inputMono.subarray(firstStart, firstStart + frameFrames),
    0
  );

  let previousStart = firstStart;
  let lastFilled = frameFrames;
  for (
    let step = 1, outputStart = hopFrames;
    outputStart + frameFrames <= workingLength;
    step++, outputStart += hopFrames
  ) {
    let candidateStart;
    if (step === 1) {
      candidateStart = entryStart;
    } else {
      const golden = (region.seed + step * 0.618033988749895) % 1;
      let target = Math.round(regionMin + golden * (regionMax - regionMin));

      // 若目标仍贴着上一帧，移到稳定区的另一侧再做相关搜索。
      if (Math.abs(target - previousStart) < overlapFrames * 0.2) {
        const span = regionMax - regionMin;
        target = Math.round(
          regionMin + ((target - regionMin + span * 0.47) % span)
        );
      }

      candidateStart = bestWsolaStart(
        inputMono,
        outputMono,
        outputStart,
        overlapFrames,
        regionMin,
        regionMax,
        target,
        searchFrames,
        previousStart
      );
    }

    for (let i = 0; i < overlapFrames; i++) {
      const p = i / (overlapFrames - 1);
      const mix = 0.5 - 0.5 * Math.cos(Math.PI * p);
      outputMono[outputStart + i] =
        outputMono[outputStart + i] * (1 - mix) +
        inputMono[candidateStart + i] * mix;

      for (let ch = 0; ch < source.numberOfChannels; ch++) {
        const output = channels[ch];
        const input = source.getChannelData(ch);
        output[outputStart + i] =
          output[outputStart + i] * (1 - mix) +
          input[candidateStart + i] * mix;
      }
    }

    outputMono.set(
      inputMono.subarray(
        candidateStart + overlapFrames,
        candidateStart + frameFrames
      ),
      outputStart + overlapFrames
    );
    for (let ch = 0; ch < source.numberOfChannels; ch++) {
      channels[ch].set(
        source.getChannelData(ch).subarray(
          candidateStart + overlapFrames,
          candidateStart + frameFrames
        ),
        outputStart + overlapFrames
      );
    }

    releaseFrames.push({
      textureFrame: outputStart + overlapFrames,
      sourceFrame: candidateStart + overlapFrames,
    });
    previousStart = candidateStart;
    lastFilled = outputStart + frameFrames;
  }

  // 环形淡化只在数秒至十余秒纹理的最外层发生；
  // 日常听到的是内部不断变化的 WSOLA 帧，不再是几十毫秒短循环。
  const textureFrames = lastFilled - wrapFrames;
  const loopBuffer = ctx.createBuffer(
    source.numberOfChannels,
    textureFrames,
    sr
  );
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const input = channels[ch];
    const output = loopBuffer.getChannelData(ch);
    output.set(input.subarray(0, textureFrames));
    for (let i = 0; i < wrapFrames; i++) {
      const p = i / (wrapFrames - 1);
      const mix = 0.5 - 0.5 * Math.cos(Math.PI * p);
      const tail = input[textureFrames + i];
      const head = input[i];
      output[i] = tail * (1 - mix) + head * mix;
    }
  }

  const validReleaseFrames = releaseFrames.filter(
    point =>
      point.textureFrame >= wrapFrames &&
      point.textureFrame < textureFrames
  );
  if (wrapFrames < hopFrames) {
    validReleaseFrames.push({
      textureFrame: wrapFrames,
      sourceFrame: firstStart + wrapFrames,
    });
    validReleaseFrames.sort((a, b) => a.textureFrame - b.textureFrame);
  }
  const attackPoint = region.preferFrameEntry
    ? validReleaseFrames.find(point => point.textureFrame >= frameFrames)
    : validReleaseFrames[0];
  if (!attackPoint) throw new Error('Sustain texture has no release points');

  return {
    buffer: loopBuffer,
    attackOffset: attackPoint.textureFrame / sr,
    tailOffset: attackPoint.sourceFrame / sr,
    releasePoints: validReleaseFrames.map(point => ({
      textureOffset: point.textureFrame / sr,
      sourceOffset: point.sourceFrame / sr,
    })),
  };
}

/* ============================================================
 * 鼓组 / 贝斯 / 和弦 合成音色
 * ==========================================================*/
function kick(t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
  g.gain.setValueAtTime(0.95, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  o.connect(g); g.connect(bgmBus);
  o.start(t); o.stop(t + 0.26);
}

function snare(t, vol = 0.5) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  n.connect(f); f.connect(g); g.connect(bgmBus);
  n.start(t); n.stop(t + 0.18);
  // 军鼓腔体
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(240, t);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(vol * 0.5, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(g2); g2.connect(bgmBus);
  o.start(t); o.stop(t + 0.1);
}

function hat(t, vol, decay) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  n.connect(f); f.connect(g); g.connect(bgmBus);
  n.start(t); n.stop(t + decay + 0.02);
}

function crash(t) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 5000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
  n.connect(f); f.connect(g); g.connect(bgmBus);
  n.start(t); n.stop(t + 1.3);
}

function stab(t, freqs) {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(2600, t);
  f.frequency.exponentialRampToValueAtTime(600, t + 0.28);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  f.connect(g); g.connect(bgmBus);
  for (const fr of freqs) {
    for (const det of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fr;
      o.detune.value = det;
      o.connect(f);
      o.start(t); o.stop(t + 0.3);
    }
  }
}

function bass(t, fr, vol) {
  const o = ctx.createOscillator(); o.type = 'square';
  o.frequency.value = fr * 2;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + S8 * 0.9);
  o.connect(f); f.connect(g); g.connect(bgmBus);
  o.start(t); o.stop(t + S8);
}

/* ============================================================
 * 循环音轨调度器（lookahead 模式）
 * ==========================================================*/
function scheduleStep(s, t) {
  const bar = (s / 16) | 0;   // 第几小节 0..3
  const pos = s % 16;         // 小节内 16 分位置
  const ch = CHORDS[bar];

  if (bar === 0 && pos === 0) crash(t);            // 循环开头镲片
  if (pos % 4 === 0) kick(t);                      // 四踩地板鼓
  if (pos === 4 || pos === 12) snare(t);           // 2、4 拍军鼓
  if (bar === 3 && pos === 14) snare(t, 0.3);      // 末尾加花
  hat(t, HAT_VEL[pos % 4], pos === 14 ? 0.12 : 0.04);
  if (pos % 4 === 2) stab(t, ch.notes);            // 反拍和弦刺
  if (pos % 2 === 0) bass(t, ch.bass, pos % 4 === 0 ? 0.4 : 0.26);
}

function scheduler() {
  const horizon = ctx.currentTime + INPUT_LOOKAHEAD;
  while (nextNoteTime < horizon) {
    scheduleStep(stepCount, nextNoteTime);
    nextNoteTime += S16;
    stepCount = (stepCount + 1) % 64;
  }
  scheduleQueuedInputs(ctx.currentTime + INPUT_QUEUE_LOOKAHEAD);
}

/* ============================================================
 * 点击量化：下一个 8 分节奏点
 * ==========================================================*/
function quantize(unit) {
  const now = ctx.currentTime;
  const k = Math.ceil((now + 0.02 - startTime) / unit);
  let t = startTime + k * unit;
  if (t < now) t += unit;
  return t;
}

function barkPlaybackRate(sample, pitchTier, fixedTargetMidi, pianoOctaveStart) {
  const octaveReference = Number.isFinite(fixedTargetMidi)
    ? BARK_PIANO_SOURCE_MIDI[sample]?.[
        normalizePianoOctaveStart(pianoOctaveStart)
      ]
    : undefined;
  const sourceMidi = Number.isFinite(fixedTargetMidi)
    ? (octaveReference ?? BARK_SOURCE_MIDI[sample])
    : (BARK_NORMAL_SOURCE_MIDI[sample] ?? BARK_SOURCE_MIDI[sample]);
  const targetMidi = Number.isFinite(fixedTargetMidi)
    ? fixedTargetMidi
    : BARK_TARGET_MIDI[sample]?.[pitchTier];
  if (!Number.isFinite(sourceMidi) || !Number.isFinite(targetMidi)) {
    throw new Error(`No fixed pitch target for ${sample}, tier ${pitchTier}`);
  }
  return Math.pow(2, (targetMidi - sourceMidi) / 12);
}

function safeStop(source, when = ctx.currentTime) {
  if (!source) return;
  try { source.stop(when); } catch (_) { /* 已经结束或尚未启动均可忽略 */ }
}

function cleanupVoice(voice) {
  if (!voice || voice.cleaned) return;
  voice.cleaned = true;
  clearTimeout(voice.cleanupTimer);
  liveVoices.delete(voice);

  if (activeSustainVoice === voice) activeSustainVoice = null;
  if (mouthVoice === voice) unlockMouth(voice, 0);

  for (const node of [
    voice.drySource, voice.dryGain,
    voice.loopSource, voice.loopGain,
    voice.tailSource, voice.tailGain,
  ]) {
    if (!node) continue;
    try { node.disconnect(); } catch (_) { /* 节点可能已断开 */ }
  }
}

function createTailSource(voice, boundary, sourceOffset) {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = voice.sourceBuffer;
  source.playbackRate.setValueAtTime(voice.rate, boundary);
  gain.gain.setValueAtTime(voice.sampleGain, boundary);
  source.connect(gain);
  gain.connect(sfxBus);
  source.start(boundary, sourceOffset);

  voice.tailSource = source;
  voice.tailGain = gain;
  voice.tailEndAt =
    boundary + (voice.sourceBuffer.duration - sourceOffset) / voice.rate;
  source.onended = () => cleanupVoice(voice);
}

function playPressVoice(name, rate, when) {
  const sourceBuffer = buffers[name];
  const sustain = sustainLoops[name];
  const sampleGain = SFX_SAMPLE_GAIN[name] ?? 1;

  // 前两个音节只走原始一次性播放；第三音节可进入延音纹理。
  if (!sustain) {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = sourceBuffer;
    source.playbackRate.setValueAtTime(rate, when);
    gain.gain.setValueAtTime(sampleGain, when);
    source.connect(gain);
    gain.connect(sfxBus);
    source.onended = () => {
      try { source.disconnect(); } catch (_) { /* 节点可能已断开 */ }
      try { gain.disconnect(); } catch (_) { /* 节点可能已断开 */ }
    };
    source.start(when);
    return null;
  }

  const handoffAt = when + sustain.tailOffset / rate;

  // 完整原音始终先启动；短按只需取消未来的静音事件即可保持原效果。
  const drySource = ctx.createBufferSource();
  const dryGain = ctx.createGain();
  drySource.buffer = sourceBuffer;
  drySource.playbackRate.setValueAtTime(rate, when);
  dryGain.gain.setValueAtTime(sampleGain, when);
  dryGain.gain.setValueAtTime(0, handoffAt);
  drySource.connect(dryGain);
  dryGain.connect(sfxBus);

  // 延音源从原音尾段起点开始，起音源在同一采样时刻静音。
  const loopSource = ctx.createBufferSource();
  const loopGain = ctx.createGain();
  loopSource.buffer = sustain.buffer;
  loopSource.loop = true;
  loopSource.playbackRate.setValueAtTime(rate, handoffAt);
  loopGain.gain.setValueAtTime(sampleGain, handoffAt);
  loopSource.connect(loopGain);
  loopGain.connect(sfxBus);

  const voice = {
    id: ++voiceSerial,
    name,
    rate,
    sampleGain,
    when,
    handoffAt,
    visualEndAt: when + 0.28,
    sourceBuffer,
    sustain,
    drySource,
    dryGain,
    loopSource,
    loopGain,
    tailSource: null,
    tailGain: null,
    tailEndAt: 0,
    rateTimeline: [{ time: handoffAt, rate }],
    held: true,
    claimed: false,
    released: false,
    stopped: false,
    cleaned: false,
    mode: 'pending',
    cleanupTimer: 0,
  };

  liveVoices.add(voice);
  drySource.onended = () => {
    if (voice.mode === 'short') cleanupVoice(voice);
  };

  drySource.start(when);
  loopSource.start(handoffAt, sustain.attackOffset);
  return voice;
}

function texturePositionAt(voice, now) {
  const start = voice.handoffAt;
  if (now <= start) return voice.sustain.attackOffset;

  let position = voice.sustain.attackOffset;
  let cursor = start;
  let rate = voice.rateTimeline[0].rate;
  for (let i = 1; i < voice.rateTimeline.length; i++) {
    const event = voice.rateTimeline[i];
    if (event.time >= now) break;
    position += (event.time - cursor) * rate;
    cursor = event.time;
    rate = event.rate;
  }
  return position + (now - cursor) * rate;
}

function textureRateAt(voice, now) {
  let rate = voice.rateTimeline[0].rate;
  for (let i = 1; i < voice.rateTimeline.length; i++) {
    const event = voice.rateTimeline[i];
    if (event.time > now) break;
    rate = event.rate;
  }
  return rate;
}

function isRetunableSustainVoice(voice) {
  return Boolean(
    voice &&
    (
      voice.name === 'jiao' ||
      voice.name === 'mi' ||
      voice.name === 'dingdongji_ji'
    ) &&
    voice.mode === 'sustain' &&
    voice.held &&
    !voice.released &&
    !voice.stopped &&
    !voice.cleaned
  );
}

function retuneSustainVoice(voice, rate, when = ctx.currentTime) {
  if (!isRetunableSustainVoice(voice)) return false;

  const now = ctx.currentTime;
  const changeAt = Math.max(now, voice.handoffAt, when);
  const playbackRate = voice.loopSource.playbackRate;
  playbackRate.cancelScheduledValues(changeAt);
  playbackRate.setValueAtTime(rate, changeAt);

  // 记录精确的变速时间；队列预调度不会让音高提前改变，收尾也能正确积分纹理位置。
  voice.rateTimeline = voice.rateTimeline.filter(event => event.time < changeAt);
  voice.rateTimeline.push({ time: changeAt, rate });
  voice.rate = rate;
  return true;
}

function nextTextureRelease(voice, now) {
  const sustain = voice.sustain;
  const duration = sustain.buffer.duration;
  const absolutePosition = texturePositionAt(voice, now);
  const rate = textureRateAt(voice, now);
  const minimumPosition =
    absolutePosition + RELEASE_SCHEDULE_LEAD * rate;
  let best = null;

  for (const point of sustain.releasePoints) {
    const turns = Math.max(
      0,
      Math.ceil((minimumPosition - point.textureOffset) / duration - 1e-7)
    );
    const targetPosition = point.textureOffset + turns * duration;
    if (!best || targetPosition < best.targetPosition) {
      best = { ...point, targetPosition };
    }
  }

  if (!best) throw new Error('Sustain texture has no release point');
  return {
    boundary: now + (best.targetPosition - absolutePosition) / rate,
    sourceOffset: best.sourceOffset,
  };
}

function claimSustainVoice(voice) {
  if (!voice || !voice.held || voice.released || voice.claimed) return;

  const previous = activeSustainVoice;
  if (previous && previous !== voice) releaseVoice(previous, true);

  voice.claimed = true;
  voice.mode = 'sustain';
  activeSustainVoice = voice;
  lockMouth(voice);
}

function updateSustainClaims(audioNow) {
  const due = [];
  for (const voice of liveVoices) {
    if (
      voice.held &&
      !voice.released &&
      !voice.claimed &&
      audioNow + SUSTAIN_CLAIM_LEAD >= voice.handoffAt
    ) {
      due.push(voice);
    }
  }

  // 同一帧有多个候选时，最后触发的指针取得唯一长音。
  due.sort((a, b) => a.id - b.id);
  for (const voice of due) claimSustainVoice(voice);
}

function releaseVoice(voice, musical = true) {
  if (!voice || voice.released || voice.stopped || voice.cleaned) return;

  const now = ctx.currentTime;
  voice.held = false;
  voice.released = true;

  if (activeSustainVoice === voice) activeSustainVoice = null;

  if (!musical) {
    forceStopVoice(voice);
    return;
  }

  // 在自然接管点之前松手：让完整原音继续，短按路径与原版一致。
  if (now < voice.handoffAt) {
    voice.mode = 'short';
    voice.dryGain.gain.cancelScheduledValues(now);
    voice.dryGain.gain.setValueAtTime(voice.sampleGain, now);
    safeStop(voice.loopSource, now);

    if (mouthVoice === voice) {
      const remainMs = Math.max(0, (voice.visualEndAt - now) * 1000);
      unlockMouth(voice, remainMs);
    }
    return;
  }

  voice.mode = 'tail';
  const releaseRate = textureRateAt(voice, now);
  voice.loopSource.playbackRate.cancelScheduledValues(now);
  voice.loopSource.playbackRate.setValueAtTime(releaseRate, now);
  voice.rateTimeline = voice.rateTimeline.filter(event => event.time <= now);
  voice.rate = releaseRate;
  const release = nextTextureRelease(voice, now);

  // 在最近的 WSOLA 淡化结束点接回与该帧对应的原音尾段。
  voice.loopGain.gain.setValueAtTime(0, release.boundary);
  safeStop(voice.loopSource, release.boundary + 0.01);
  createTailSource(voice, release.boundary, release.sourceOffset);

  const remainMs = Math.max(0, (voice.tailEndAt - now) * 1000);
  if (mouthVoice === voice) unlockMouth(voice, remainMs);
  else openMouth(remainMs);
}

function fadeGain(gainNode, now, stopAt) {
  if (!gainNode) return;
  const param = gainNode.gain;
  const value = Math.max(0, param.value);
  param.cancelScheduledValues(now);
  param.setValueAtTime(value, now);
  param.linearRampToValueAtTime(0, stopAt);
}

function forceStopVoice(voice) {
  if (!voice || voice.stopped || voice.cleaned) return;

  const now = ctx.currentTime;
  const stopAt = now + EMERGENCY_FADE;
  voice.held = false;
  voice.released = true;
  voice.stopped = true;
  voice.mode = 'stopped';

  if (activeSustainVoice === voice) activeSustainVoice = null;
  fadeGain(voice.dryGain, now, stopAt);
  fadeGain(voice.loopGain, now, stopAt);
  fadeGain(voice.tailGain, now, stopAt);
  safeStop(voice.drySource, stopAt);
  safeStop(voice.loopSource, stopAt);
  safeStop(voice.tailSource, stopAt);

  if (mouthVoice === voice) unlockMouth(voice, EMERGENCY_FADE * 1000);
  voice.cleanupTimer = setTimeout(
    () => cleanupVoice(voice),
    (EMERGENCY_FADE + 0.05) * 1000
  );
}

/* ============================================================
 * 分区（纯逻辑，无可见格子）
 * ==========================================================*/
function buildGrid() {
  const { width, height } = getStageMetrics();
  const landscape = width >= height;
  const pianoScale = performanceSettings.pianoMode
    ? buildPianoScale(effectivePianoOctaveStart())
    : null;
  cols = landscape ? (performanceSettings.pianoMode ? 8 : 4) : 3;
  rows = landscape ? 3 : (performanceSettings.pianoMode ? 8 : 4);

  zones = [];
  if (landscape) {
    // 横屏：纵向依次 da / gou / jiao；钢琴模式横向 do 到高音 do。
    const rowMap = [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pianoKey = pianoScale?.[c] ?? null;
        zones.push({
          sample: rowMap[r].n,
          syllable: rowMap[r].s,
          pitchTier: c,
          targetMidi: pianoKey?.midi,
          pianoOctaveStart: pianoKey ? effectivePianoOctaveStart() : undefined,
          note: pianoKey?.note,
          solfege: pianoKey?.solfege,
        });
      }
    }
  } else {
    // 竖屏：横向依次 da / gou / jiao；钢琴模式纵向从高音 do 降到 do。
    const colMap = [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pianoIndex = performanceSettings.pianoMode
          ? pianoScale.length - 1 - r
          : r;
        const pianoKey = pianoScale?.[pianoIndex] ?? null;
        zones.push({
          sample: colMap[c].n,
          syllable: colMap[c].s,
          pitchTier: pianoIndex,
          targetMidi: pianoKey?.midi,
          pianoOctaveStart: pianoKey ? effectivePianoOctaveStart() : undefined,
          note: pianoKey?.note,
          solfege: pianoKey?.solfege,
        });
      }
    }
  }

  if (typeof renderKeyGrid === 'function') renderKeyGrid();
}

function zoneIndex(x, y) {
  const { width, height, left, top } = getStageMetrics();
  const localX = x - left;
  const localY = y - top;
  const c = Math.min(cols - 1, Math.max(0, Math.floor(localX / width * cols)));
  const r = Math.min(rows - 1, Math.max(0, Math.floor(localY / height * rows)));
  return r * cols + c;
}

function pianoKeyboardBinding(code) {
  for (let rowIndex = 0; rowIndex < PIANO_KEYBOARD_ROWS.length; rowIndex++) {
    const pitchTier = PIANO_KEYBOARD_ROWS[rowIndex].indexOf(code);
    if (pitchTier >= 0) {
      return { sample: PIANO_KEYBOARD_SAMPLES[rowIndex], pitchTier };
    }
  }
  return null;
}

function pianoZoneIndexForCode(code) {
  if (!performanceSettings.pianoMode) return -1;
  const binding = pianoKeyboardBinding(code);
  if (!binding) return -1;
  return zones.findIndex(
    zone => zone.sample === binding.sample && zone.pitchTier === binding.pitchTier
  );
}

/* 返回一条指针线段实际穿过的全部格子，避免快速移动时浏览器只上报首尾格。 */
function zonesAlongSegment(x0, y0, x1, y1) {
  const { width, height, left, top } = getStageMetrics();
  const dx = x1 - x0;
  const dy = y1 - y0;
  const times = [0, 1];

  if (Math.abs(dx) > 1e-7) {
    for (let c = 1; c < cols; c++) {
      const t = (left + width * c / cols - x0) / dx;
      if (t > 0 && t < 1) times.push(t);
    }
  }
  if (Math.abs(dy) > 1e-7) {
    for (let r = 1; r < rows; r++) {
      const t = (top + height * r / rows - y0) / dy;
      if (t > 0 && t < 1) times.push(t);
    }
  }

  times.sort((a, b) => a - b);
  const uniqueTimes = times.filter(
    (t, i) => i === 0 || Math.abs(t - times[i - 1]) > 1e-7
  );
  const result = [];
  const appendAt = (t) => {
    const zi = zoneIndex(x0 + dx * t, y0 + dy * t);
    if (result[result.length - 1] !== zi) result.push(zi);
  };

  appendAt(0);
  for (let i = 1; i < uniqueTimes.length; i++) {
    appendAt((uniqueTimes[i - 1] + uniqueTimes[i]) / 2);
  }
  appendAt(1);
  return result;
}

/* ============================================================
 * 工具：随机数 / 缓动 / 颜色 / 路径
 * ==========================================================*/
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = t => t * t * (3 - 2 * t);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutBack = t => { const c = 1.70158, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
const easeOutElastic = t =>
  t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;

function tracePoly(g, x, y, r, sides, rot) {
  g.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
}

function traceStar(g, x, y, r, points, rot) {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 ? r * 0.46 : r;
    const a = rot + (i * Math.PI) / points;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
}

/* 画一个小几何体（特效的基本粒子） */
function drawPiece(g, kind, color, x, y, r, rot) {
  if (r <= 0) return;
  g.save();
  g.translate(x, y);
  g.rotate(rot || 0);
  switch (kind) {
    case 'circle':
      g.fillStyle = color;
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
      break;
    case 'ring':
      g.strokeStyle = color;
      g.lineWidth = Math.max(2, r * 0.3);
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.stroke();
      break;
    case 'square':
      g.fillStyle = color;
      g.fillRect(-r, -r, r * 2, r * 2);
      break;
    case 'triangle':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.2, 3, -Math.PI / 2); g.fill();
      break;
    case 'diamond':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.15, 4, 0); g.fill();
      break;
    case 'hexagon':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.1, 6, 0); g.fill();
      break;
    case 'star':
      g.fillStyle = color;
      traceStar(g, 0, 0, r * 1.25, 5, -Math.PI / 2); g.fill();
      break;
    case 'cross': {
      g.fillStyle = color;
      const w = r * 0.62;
      g.fillRect(-r, -w / 2, r * 2, w);
      g.fillRect(-w / 2, -r, w, r * 2);
      break;
    }
  }
  g.restore();
}

/* ============================================================
 * 全屏特效引擎（仿 Mikutap）
 *  - 每次触发生成一个全屏特效实例，叠在旧特效之上
 *  - 旧特效播放退场动画后移除
 *  - 页面背景平滑过渡到新特效的落幕背景色
 * ==========================================================*/
const FX_IN = 0.55;    // 入场时长（秒）
const FX_OUT = 0.4;    // 退场时长（秒）

let fxW = 0, fxH = 0;  // 画布尺寸（CSS 像素）
let fxList = [];       // 活跃特效（数组顺序 = 叠放顺序）
let beatP = 0;         // 节拍脉冲 0..1（tick 每帧更新）

function nowSec() { return ctx ? ctx.currentTime : performance.now() / 1000; }
const prog = (t, delay, dur = FX_IN) => clamp01((t - delay) / dur);
const cx0 = () => fxW / 2, cy0 = () => fxH / 2;   // 网页容器正中心

function getStageMetrics() {
  const rect = stage.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width || stage.clientWidth || 1),
    height: Math.max(1, rect.height || stage.clientHeight || 1),
    left: rect.left,
    top: rect.top,
  };
}

function fxResize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const { width, height } = getStageMetrics();
  fxW = width;
  fxH = height;
  const sceneUnit = fxW >= fxH ? fxH / 2 : fxW / 1.5;
  stage.style.setProperty('--scene-unit', `${sceneUnit}px`);
  fxCanvas.width = Math.round(fxW * dpr);
  fxCanvas.height = Math.round(fxH * dpr);
  fxCanvas.style.width = fxW + 'px';
  fxCanvas.style.height = fxH + 'px';
  fx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 活跃特效重新对齐网页容器正中心
  for (const e of fxList) { e.cx = cx0(); e.cy = cy0(); }
}

/* ---------- 各特效的随机参数预生成（出生即定型，之后纯函数绘制） ----------
 * 中心化特效最大直径 ≈ 0.85~0.92 倍屏幕短边；
 * 零散小元件（纸屑 / 星星 / 几何雨）则随机散布全屏任意位置 */
const BUILD = {
  rings(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 7; i++) inst.shapes.push({
      delay: i * 0.05,
      rEnd: minD * (0.13 + rng() * 0.29),   // 最大直径 ≈ 0.84 短边
      w: 5 + rng() * 9,
      color: pickColor(rng),
    });
    inst.dotR = minD * 0.07;
  },
  poly(inst, rng) {
    const sides = 3 + (rng() * 5 | 0);
    const minD = Math.min(fxW, fxH);
    [[0.46, C.amber, 0], [0.3, C.gray, 0.09], [0.17, C.amber, 0.18]].forEach(([s, color, d], i) =>
      inst.shapes.push({
        sides, delay: d, color,
        rEnd: minD * s,                       // 最大直径 ≈ 0.92 短边
        w: minD * (0.034 - i * 0.007),
      }));
  },
  spiral(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 36; i++) inst.shapes.push({
      ang: i * 0.55,
      rad: 6 + i * minD * 0.0125,             // 最大直径 ≈ 0.88 短边
      size: minD * (0.009 + i * 0.0008),
      delay: i * 0.018,
      color: pickColor(rng),
    });
  },
  rays(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const n = 13 + (rng() * 4 | 0);
    inst.r0 = minD * 0.06;
    for (let i = 0; i < n; i++) inst.shapes.push({
      ang: (i / n) * 2 * Math.PI + rng() * 0.15,
      w: 0.09 + rng() * 0.13,
      len: minD * (0.36 + rng() * 0.1),       // 最大直径 ≈ 0.92 短边
      delay: rng() * 0.12,
      color: rng() < 0.12 ? ACCENTS[(rng() * 3) | 0] : (i % 2 ? C.gray : C.amber),
    });
  },
  confetti(inst, rng) {
    const maxD = Math.hypot(fxW, fxH);
    const minD = Math.min(fxW, fxH);
    const kinds = ['square', 'circle', 'triangle', 'diamond'];
    for (let i = 0; i < 30; i++) inst.shapes.push({
      ang: rng() * 2 * Math.PI,
      dist: maxD * (0.12 + rng() * 0.46),
      size: minD * (0.026 + rng() * 0.05),
      spin: inst.dir * (1 + rng() * 2) * 2.2,
      delay: rng() * 0.18,
      kind: kinds[(rng() * 4) | 0],
      color: pickColor(rng),
    });
  },
  zigzag(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const horiz = rng() < 0.5;
    const n = 5 + (rng() * 3 | 0);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      if (horiz) pts.push({
        x: -fxW * 0.08 + f * fxW * 1.16,
        y: fxH * (i % 2 ? 0.72 + rng() * 0.14 : 0.14 + rng() * 0.14),
      });
      else pts.push({
        x: fxW * (i % 2 ? 0.7 + rng() * 0.16 : 0.14 + rng() * 0.16),
        y: -fxH * 0.08 + f * fxH * 1.16,
      });
    }
    const lens = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      lens.push(l); total += l;
    }
    inst.shapes.push({ pts, lens, total, w: minD * (0.026 + rng() * 0.024), color: C.amber });
  },
  pop(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const kinds = ['circle', 'square', 'ring', 'triangle', 'hexagon'];
    for (let i = 0; i < 16; i++) inst.shapes.push({
      x: fxW * (0.06 + rng() * 0.88),
      y: fxH * (0.06 + rng() * 0.88),
      size: minD * (0.036 + rng() * 0.06),
      delay: rng() * 0.28,
      rot: rng() * Math.PI,
      kind: kinds[(rng() * kinds.length) | 0],
      color: pickColor(rng),
    });
  },
  cross(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const size = minD * (0.6 + rng() * 0.25);   // 臂长 0.6~0.85 短边
    inst.shapes.push({
      size,
      w: size * (0.14 + rng() * 0.08),
      color: rng() < 0.2 ? ACCENTS[(rng() * 3) | 0] : C.amber,
    });
  },
  orbit(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const kinds = ['circle', 'square', 'triangle', 'ring'];
    const n = 10;
    for (let i = 0; i < n; i++) inst.shapes.push({
      ang0: (i / n) * 2 * Math.PI,
      rad: minD * (0.18 + rng() * 0.24),        // 轨道直径 ≤ 0.84 短边
      speed: inst.dir * (0.45 + rng() * 0.5),
      size: minD * (0.026 + rng() * 0.032),
      delay: rng() * 0.15,
      kind: kinds[i % 4],
      color: pickColor(rng),
    });
    inst.coreR = minD * 0.055;
  },
  wave(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 4; i++) inst.shapes.push({
      y0: fxH * (0.14 + i * 0.24) + (rng() - 0.5) * fxH * 0.08,
      amp: minD * (0.03 + rng() * 0.05),
      wl: fxW * (0.45 + rng() * 0.4),
      speed: inst.dir * (1 + rng() * 1.2),
      th: minD * (0.07 + rng() * 0.06),
      side: i % 2 ? 1 : -1,
      delay: i * 0.08,
      color: rng() < 0.12 ? ACCENTS[(rng() * 3) | 0] : (i % 2 ? C.gray : C.amber),
    });
  },
  stars(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 12; i++) inst.shapes.push({
      x: fxW * (0.07 + rng() * 0.86),
      y: fxH * (0.07 + rng() * 0.86),
      r: minD * (0.034 + rng() * 0.055),
      delay: rng() * 0.25,
      rot: rng() * Math.PI,
      color: pickColor(rng),
    });
  },
  grid(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const n = 11;
    const radius = minD * (0.4 + rng() * 0.04);   // 直径 0.8~0.88 短边
    const lines = [];
    for (let i = 0; i < n; i++) lines.push({
      y: (i - (n - 1) / 2) * (radius * 2 / n),
      w: 4.5 + ((i * 7) % 3) * 4,
      delay: i * 0.045,
      color: i % 2 ? C.gray : C.amber,
    });
    inst.shapes.push({ radius, lines });
  },
};

/* ---------- 各特效的绘制（t = 出生至今秒数，fade = 退场透明度） ----------
 * beatP 为节拍脉冲：所有特效随节拍轻微缩放 / 增粗（颜色固定不随节拍变化） */
const DRAW = {
  /* 同心环爆发：圆环扩张后呼吸胀缩，随节拍增粗（律动只做运动，不变色） */
  rings(g, inst, t, fade) {
    const minD = Math.min(fxW, fxH);
    inst.shapes.forEach((s, i) => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const r = k * s.rEnd * (1 + 0.04 * Math.sin(t * 1.4 + i)) + beatP * minD * 0.012;
      g.globalAlpha = (1 - k * 0.5) * fade;
      g.strokeStyle = s.color;
      g.lineWidth = s.w * (1 + beatP * 0.5);
      g.beginPath(); g.arc(inst.cx, inst.cy, r, 0, 7); g.stroke();
    });
    const dk = easeOutBack(prog(t, 0));
    if (dk > 0) {
      g.globalAlpha = fade;
      g.fillStyle = C.amber;
      g.beginPath(); g.arc(inst.cx, inst.cy, inst.dotR * dk * (1 + beatP * 0.2), 0, 7); g.fill();
    }
  },

  /* 多边形绽放：三层多边形描边放大并旋转，随节拍胀缩 */
  poly(g, inst, t, fade) {
    const minD = Math.min(fxW, fxH);
    inst.shapes.forEach((s, i) => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const r = k * s.rEnd * (1 + beatP * 0.035 + 0.03 * Math.sin(t * 1.1 + i * 1.9));
      const rot = inst.rot0 + inst.dir * (1 - k) * 1.3 + t * 0.18 * inst.dir;
      g.globalAlpha = (1 - k * 0.3) * fade;
      g.strokeStyle = s.color;
      g.lineWidth = s.w * (1 + beatP * 0.4) + beatP * minD * 0.0015;
      tracePoly(g, inst.cx, inst.cy, r, s.sides, rot);
      g.stroke();
    });
  },

  /* 螺旋弹珠：圆点沿螺旋线依次弹出，整体旋转，随节拍跳动 */
  spiral(g, inst, t, fade) {
    const rot = inst.rot0 + t * 0.45 * inst.dir + beatP * 0.05 * inst.dir;
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const a = s.ang + rot;
      const r = s.rad * k * (1 + beatP * 0.04) + Math.sin(t * 1.5 + i * 0.5) * 4;
      const x = inst.cx + Math.cos(a) * r;
      const y = inst.cy + Math.sin(a) * r;
      const sz = s.size * k * (1 + beatP * 0.25);
      g.globalAlpha = fade;
      drawPiece(g, i % 6 === 5 ? 'square' : 'circle', s.color, x, y, sz, a);
    });
  },

  /* 放射光芒：楔形光刃旋出，缓慢自转，随节拍伸长 */
  rays(g, inst, t, fade) {
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay, 0.5));
      if (k <= 0) continue;
      const rot = inst.rot0 + inst.dir * (1 - k) * 0.8 + t * 0.14 * inst.dir;
      const len = s.len * k * (1 + beatP * 0.09);
      const a = s.ang + rot;
      g.globalAlpha = 0.88 * fade;
      g.fillStyle = s.color;
      g.beginPath();
      g.moveTo(inst.cx, inst.cy);
      g.arc(inst.cx, inst.cy, inst.r0 + len, a - s.w, a + s.w);
      g.closePath(); g.fill();
    }
  },

  /* 几何纸屑：小几何体从中心炸开，漂浮 + 随节拍颠簸 */
  confetti(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const x = inst.cx + Math.cos(s.ang) * s.dist * k * (1 + beatP * 0.025);
      const y = inst.cy + Math.sin(s.ang) * s.dist * k * (1 + beatP * 0.025)
        + Math.sin(t * 2.2 + i * 1.3) * 6;
      const sz = s.size * k * (1 + beatP * 0.18);
      const rot = s.spin * k + t * 0.6 * inst.dir;
      g.globalAlpha = fade;
      drawPiece(g, s.kind, s.color, x, y, sz, rot);
    });
  },

  /* 折线穿越：粗折线横扫全屏（带灰色重影），端点圆点随节拍猛跳 */
  zigzag(g, inst, t, fade) {
    const s = inst.shapes[0];
    const k = easeOutCubic(prog(t, 0, 0.6));
    if (k <= 0) return;
    g.save();
    g.translate(0, Math.sin(t * 1.6) * 7);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // 灰色重影
    g.save();
    g.translate(0, s.w * 2.1);
    g.globalAlpha = 0.4 * fade;
    g.strokeStyle = C.gray;
    g.lineWidth = s.w * (1 + beatP * 0.2);
    strokePartial(g, s.pts, s.lens, k * s.total);
    g.stroke();
    g.restore();
    // 主折线
    g.globalAlpha = fade;
    g.strokeStyle = s.color;
    g.lineWidth = s.w * (1 + beatP * 0.3);
    const tip = strokePartial(g, s.pts, s.lens, k * s.total);
    g.stroke();
    g.fillStyle = C.gray;
    g.beginPath(); g.arc(tip.x, tip.y, s.w * (1.1 + beatP * 0.45), 0, 7); g.fill();
    g.restore();
  },

  /* 弹性几何雨：几何体在随机位置 Q 弹冒出，浮动 + 随节拍缩放 */
  pop(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const y = s.y + Math.sin(t * 2 + i * 1.7) * 7;
      const sz = s.size * k * (1 + beatP * 0.2);
      g.globalAlpha = 0.96 * fade;
      drawPiece(g, s.kind, s.color, s.x, y, sz, s.rot + t * 0.4 * inst.dir + beatP * 0.08 * inst.dir);
    });
  },

  /* 巨大十字：横竖两臂依次弹出并旋转定格，随节拍轻微胀缩 */
  cross(g, inst, t, fade) {
    const s = inst.shapes[0];
    const k1 = easeOutBack(prog(t, 0));
    const k2 = easeOutBack(prog(t, 0.13));
    if (k1 <= 0) return;
    g.save();
    g.translate(inst.cx, inst.cy);
    g.rotate(inst.rot0 + inst.dir * (1 - k1) * 1.6 + Math.sin(t * 1.3) * 0.07 + beatP * 0.02 * inst.dir);
    const pulse = 1 + beatP * 0.12;
    g.scale(pulse, pulse);
    const L = s.size / 2, w = s.w / 2;
    g.globalAlpha = fade;
    g.fillStyle = s.color;
    g.fillRect(-L * k1, -w, L * 2 * k1, w * 2);
    if (k2 > 0) g.fillRect(-w, -L * k2, w * 2, L * 2 * k2);
    g.globalAlpha = 0.6 * fade;
    g.strokeStyle = C.gray;
    g.lineWidth = Math.max(2, s.w * 0.28);
    g.beginPath(); g.arc(0, 0, s.size * 0.68 * k1 * (1 + beatP * 0.08), 0, 7); g.stroke();
    g.restore();
  },

  /* 环绕轨道：几何体沿轨道持续环绕中心公转，轨道随节拍收缩膨胀 */
  orbit(g, inst, t, fade) {
    inst.shapes.forEach(s => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const a = s.ang0 + t * s.speed + inst.dir * (1 - k) * 1.8;
      const R = s.rad * k * (1 + beatP * 0.09);
      const x = inst.cx + Math.cos(a) * R;
      const y = inst.cy + Math.sin(a) * R;
      g.globalAlpha = fade;
      drawPiece(g, s.kind, s.color, x, y, s.size * (0.6 + 0.4 * k) * (1 + beatP * 0.15), t * 1.2 * inst.dir);
    });
    const ck = easeOutBack(prog(t, 0));
    if (ck > 0) {
      g.globalAlpha = fade;
      drawPiece(g, 'circle', C.amber, inst.cx, inst.cy,
        inst.coreR * ck * (1 + beatP * 0.2), 0);
    }
  },

  /* 波浪丝带：四条波浪带交替滑入，持续起伏，振幅随节拍加大 */
  wave(g, inst, t, fade) {
    const step = Math.max(14, fxW / 28);
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay, 0.6));
      if (k <= 0) continue;
      const off = (1 - k) * (fxW + 120) * s.side;
      const amp = s.amp * (0.6 + 0.4 * k) * (1 + beatP * 0.3);
      g.globalAlpha = 0.9 * fade;
      g.fillStyle = s.color;
      g.beginPath();
      for (let x = -60; x <= fxW + 60; x += step) {
        const y = s.y0 + Math.sin((x / s.wl) * Math.PI * 2 + t * s.speed) * amp;
        x === -60 ? g.moveTo(x + off, y) : g.lineTo(x + off, y);
      }
      for (let x = fxW + 60; x >= -60; x -= step) {
        const y = s.y0 + s.th * (1 + beatP * 0.12)
          + Math.sin((x / s.wl) * Math.PI * 2 + t * s.speed + 0.9) * amp;
        g.lineTo(x + off, y);
      }
      g.closePath(); g.fill();
    }
  },

  /* 星星弹跳：星星弹性冒出并闪烁自转，随节拍闪烁加剧 */
  stars(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutElastic(prog(t, s.delay));
      if (k <= 0) return;
      const tw = 1 + 0.15 * Math.sin(t * 3.2 + i * 2.1) + beatP * 0.18;
      g.globalAlpha = 0.97 * fade;
      drawPiece(g, 'star', s.color, s.x, s.y, s.r * k * tw, s.rot + t * 0.7 * inst.dir);
    });
  },

  /* 旋转线栅：圆形视窗内平行线逐条展开，整体旋转，随节拍胀缩增粗 */
  grid(g, inst, t, fade) {
    const s = inst.shapes[0];
    const R = s.radius * (1 + beatP * 0.06 + 0.03 * Math.sin(t * 1.3));
    g.save();
    g.translate(inst.cx, inst.cy);
    g.rotate(inst.rot0 + t * 0.22 * inst.dir + beatP * 0.025 * inst.dir);
    g.beginPath(); g.arc(0, 0, R, 0, 7); g.clip();
    for (const ln of s.lines) {
      const k = easeOutCubic(prog(t, ln.delay));
      if (k <= 0) continue;
      g.globalAlpha = 0.92 * fade;
      g.strokeStyle = ln.color;
      g.lineWidth = ln.w * (1 + beatP * 0.35);
      g.beginPath();
      g.moveTo(-R * k, ln.y);
      g.lineTo(R * k, ln.y);
      g.stroke();
    }
    g.restore();
    const ok = easeOutBack(prog(t, 0));
    if (ok > 0) {
      g.globalAlpha = fade;
      g.strokeStyle = C.amber;
      g.lineWidth = 6 * (1 + beatP * 0.35);
      g.beginPath(); g.arc(inst.cx, inst.cy, R * ok, 0, 7); g.stroke();
    }
  },
};

/* 折线按可见长度部分描边，返回当前端点 */
function strokePartial(g, pts, lens, vis) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = lens[i - 1];
    if (acc + seg <= vis) {
      g.lineTo(pts[i].x, pts[i].y);
      acc += seg;
    } else {
      const f = seg > 0 ? (vis - acc) / seg : 0;
      const tx = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f;
      const ty = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f;
      g.lineTo(tx, ty);
      return { x: tx, y: ty };
    }
  }
  return pts[pts.length - 1];
}

/* 生成一个全屏特效实例（原点固定在屏幕正中心） */
function buildEffect(type) {
  const rng = mulberry32((Math.random() * 1e9) | 0);
  const inst = {
    type,
    cx: cx0(), cy: cy0(),
    t0: 0, state: 'in', outT0: 0,
    rot0: rng() * Math.PI * 2,
    dir: rng() < 0.5 ? -1 : 1,
    shapes: [],
  };
  BUILD[type](inst, rng);
  return inst;
}

/* 触发全屏特效：新特效叠上，旧特效退场 */
function spawnEffect(zi, when) {
  const type = EFFECTS[zi % EFFECTS.length];
  const now = nowSec();

  for (const e of fxList) {
    if (e.state !== 'out') { e.state = 'out'; e.outT0 = now; }
  }
  while (fxList.length > 6) fxList.shift();   // 快速连打时兜底清理

  const inst = buildEffect(type);
  inst.t0 = Math.min(when, now + 0.05);       // 尽量贴节拍，最多延迟 50ms
  fxList.push(inst);
}

/* 每帧绘制：固定米白背景 → 各特效（按叠放顺序） */
function fxFrame(now) {
  fx2d.clearRect(0, 0, fxW, fxH);

  for (let i = fxList.length - 1; i >= 0; i--) {
    const inst = fxList[i];
    let outK = 0;
    if (inst.state === 'out') {
      outK = clamp01((now - inst.outT0) / FX_OUT);
      if (outK >= 1) { fxList.splice(i, 1); continue; }   // 退场完毕，移除
    }
    const t = now - inst.t0;
    if (t < 0) continue;                                  // 等待节拍点

    // 常驻特效整体随节拍呼吸；退场特效整体淡出 + 缩小
    const fade = 1 - smooth(outK);
    const sc = inst.state === 'out' ? 1 - 0.22 * outK : 1 + beatP * 0.02;
    fx2d.save();
    fx2d.translate(inst.cx, inst.cy);
    fx2d.scale(sc, sc);
    fx2d.translate(-inst.cx, -inst.cy);
    DRAW[inst.type](fx2d, inst, t, fade);
    fx2d.restore();
  }
}

/* ---------- 张嘴 / 闭嘴（JS 弹簧驱动，快速果断带 Q 弹） ---------- */
function openMouth(holdMs) {
  mouthPopped = true;
  dogInner.classList.toggle('bark-image', !sfxMuted);
  clearTimeout(mouthTimer);
  mouthTimer = setTimeout(() => {
    if (!mouthVoice) {
      mouthPopped = false;
      dogInner.classList.remove('bark-image');
    }
  }, holdMs);
}

function lockMouth(voice) {
  mouthVoice = voice;
  clearTimeout(mouthTimer);
  mouthPopped = true;
  dogInner.classList.toggle('bark-image', !sfxMuted);
  holding = true;   // 开始长按果冻动画（变大 / 变红 / 高频抖动）
}

function unlockMouth(voice, holdMs) {
  if (mouthVoice !== voice) return;
  mouthVoice = null;
  holding = false;  // 松手：果冻动画 Q 弹回落
  openMouth(holdMs);
}

/* ============================================================
 * 激活分区（点击或拖动经过）
 * ==========================================================*/
/* 分区按钮闪光：被激活的分区短暂显示半透明白色再淡出 */
function flashZone(zi) {
  const r = (zi / cols) | 0, c = zi % cols;
  const el = document.createElement('div');
  el.className = 'zone-flash';
  el.style.left   = `calc(${c * 100 / cols}% + 3px)`;
  el.style.top    = `calc(${r * 100 / rows}% + 3px)`;
  el.style.width  = `calc(${100 / cols}% - 6px)`;
  el.style.height = `calc(${100 / rows}% - 6px)`;
  el.addEventListener('animationend', () => el.remove());
  flashLayer.appendChild(el);
}

function reflowQueuedInputTimes() {
  if (!performanceSettings.rhythmSnap) {
    const now = ctx?.currentTime ?? 0;
    for (const entry of inputQueue) entry.when = now;
    return;
  }

  let when = quantize(S8);
  if (Number.isFinite(lastCommittedInputTime)) {
    when = Math.max(when, lastCommittedInputTime + S8);
  }
  for (const entry of inputQueue) {
    entry.when = when;
    when += S8;
  }
}

function removeQueuedSample(sample) {
  // 自由节奏下每次输入都必须发声，不能用吸附模式的同音节去重规则。
  if (!performanceSettings.rhythmSnap) return;
  for (let i = inputQueue.length - 1; i >= 0; i--) {
    const entry = inputQueue[i];
    if (entry.sample !== sample) continue;

    inputQueue.splice(i, 1);
    const state = pointers.get(entry.pointerId);
    if (state && state.pendingEntryId === entry.id) {
      state.pendingEntryId = null;
    }
  }
}

function enqueueActivation(zi, pointerId) {
  hideControlsUntilIdle();
  const z = zones[zi];
  removeQueuedSample(z.sample);
  const entry = {
    id: ++inputSerial,
    kind: 'press',
    pointerId,
    zone: zi,
    sample: z.sample,
    audioSample: resolveSfxSample(z.sample),
    pitchTier: z.pitchTier,
    targetMidi: z.targetMidi,
    pianoOctaveStart: z.pianoOctaveStart,
    when: 0,
  };
  inputQueue.push(entry);
  reflowQueuedInputTimes();
  flashZone(zi);
  return entry;
}

function enqueueSustainRetune(zi, pointerId, voice) {
  hideControlsUntilIdle();
  const z = zones[zi];
  removeQueuedSample(z.sample);
  const entry = {
    id: ++inputSerial,
    kind: 'sustain-retune',
    pointerId,
    zone: zi,
    sample: z.sample,
    audioSample: voice?.name ?? resolveSfxSample(z.sample),
    pitchTier: z.pitchTier,
    targetMidi: z.targetMidi,
    pianoOctaveStart: z.pianoOctaveStart,
    voice,
    when: 0,
  };
  inputQueue.push(entry);
  reflowQueuedInputTimes();
  flashZone(zi);
  return entry;
}

function commitUnsnappedInput(entry) {
  if (performanceSettings.rhythmSnap) return;
  const queuedIndex = inputQueue.indexOf(entry);
  if (queuedIndex >= 0) inputQueue.splice(queuedIndex, 1);
  entry.when = ctx.currentTime;
  lastCommittedInputTime = entry.when;
  playQueuedInput(entry);
}

function scheduleActivationVisual(zi, when) {
  const waitMs = Math.max(0, (when - ctx.currentTime) * 1000);
  const timer = setTimeout(() => {
    inputVisualTimers.delete(timer);
    openMouth(280);
    barkPopVel = Math.min(barkPopVel + BARK_KICK, BARK_KICK_MAX);
    spawnEffect(zi, ctx.currentTime);
  }, waitMs);
  inputVisualTimers.add(timer);
}

function playQueuedInput(entry) {
  const audioSample = entry.audioSample ?? resolveSfxSample(entry.sample);
  const rate = barkPlaybackRate(
    audioSample,
    entry.pitchTier,
    entry.targetMidi,
    entry.pianoOctaveStart,
  );
  if (entry.kind === 'sustain-retune') {
    if (retuneSustainVoice(entry.voice, rate, entry.when)) {
      scheduleActivationVisual(entry.zone, entry.when);
    }
    return;
  }

  const state = pointers.get(entry.pointerId);
  const stillHeld =
    state &&
    state.zone === entry.zone &&
    state.pendingEntryId === entry.id;
  const voice = playPressVoice(audioSample, rate, entry.when);

  if (stillHeld) {
    state.pendingEntryId = null;
    state.voice = voice;
  } else if (voice) {
    // 已滑过或已松手的 jiao 只保留短音，不进入未来的长音循环。
    releaseVoice(voice, true);
  }
  scheduleActivationVisual(entry.zone, entry.when);
}

function scheduleQueuedInputs(horizon) {
  while (inputQueue.length && inputQueue[0].when < horizon) {
    const entry = inputQueue.shift();
    lastCommittedInputTime = entry.when;
    playQueuedInput(entry);
  }
}

function cancelQueuedInputs(pointerId) {
  for (let i = inputQueue.length - 1; i >= 0; i--) {
    if (inputQueue[i].pointerId === pointerId) inputQueue.splice(i, 1);
  }
  reflowQueuedInputTimes();
}

function clearInputVisualTimers() {
  for (const timer of inputVisualTimers) clearTimeout(timer);
  inputVisualTimers.clear();
}

/* ============================================================
 * 节拍动画循环：大狗律动（压缩 + 晃动）+ 长按果冻动画 + 全屏特效
 * ==========================================================*/
function tick() {
  requestAnimationFrame(tick);
  const now = nowSec();
  const dt = Math.min(0.05, Math.max(0.001, now - lastTick));
  lastTick = now;
  const uiBeatPosition = getAudioBeatPosition();
  updateUiRhythm(uiBeatPosition);
  if (isAnimationCharacter(selectedCharacterId) && hajimiAnimationReady) {
    renderHajimiAnimationFrame(uiBeatPosition);
  }

  if (started && ctx) {
    const t = ctx.currentTime;
    updateSustainClaims(t);
    const phase = (((t - startTime) / SPB) % 1 + 1) % 1;  // 当前拍内相位 0..1
    beatP = Math.pow(1 - phase, 2.4);                      // 拍头强、迅速衰减

    // 大狗律动：拍头向上跳 + 上下压缩（压扁拉伸），叠加两拍一周期的左右晃动
    const sway = Math.sin(((t - startTime) / (SPB * 2)) * Math.PI * 2);
    dogEl.style.transform =
      `translate(${(sway * 5).toFixed(2)}px, ${(-9 * beatP).toFixed(2)}px)` +
      ` rotate(${(sway * 2.4).toFixed(2)}deg)` +
      ` scale(${(1 + 0.06 * beatP).toFixed(4)}, ${(1 - 0.05 * beatP).toFixed(4)})`;
  }

  /* ---------- 叫弹跳弹簧 ----------
   * 高刚度(320) + 低阻尼(13)：约 90ms 快速冲起、带过冲后果断定住；
   * 张嘴期间维持弹起，闭嘴快速弹回；每次队列发声时注入冲量，
   * 嘴张着也会重新弹一下。 */
  const popTarget = mouthPopped ? 1 : 0;
  barkPopVel += (popTarget - barkPop) * 320 * dt;
  barkPopVel *= Math.exp(-13 * dt);
  barkPopVel = Math.max(-10, Math.min(10, barkPopVel));
  barkPop += barkPopVel * dt;
  dogInner.style.transform =
    `scale(${(1 + 0.17 * barkPop).toFixed(4)}) rotate(${(-3.5 * barkPop).toFixed(2)}deg)`;

  /* ---------- 长按果冻动画 ----------
   * holdLevel 缓慢累积（约 1.1s 时间常数），松手后快速回落；
   * 缩放走欠阻尼弹簧，起步和收尾都带 Q 弹过冲；
   * 抖动为 ~19Hz 高频，幅度随 holdLevel 增大并封顶。 */
  const holdTarget = holding ? 1 : 0;
  const tau = holding ? 1.1 : 0.22;
  holdLevel += (holdTarget - holdLevel) * (1 - Math.exp(-dt / tau));

  const scaleTarget = 1 + 0.16 * holdLevel;                // 逐渐变大（最大 1.16，弹簧过冲略超）
  jellyVel += (scaleTarget - jellyScale) * 55 * dt;
  jellyVel *= Math.exp(-7 * dt);
  jellyScale += jellyVel * dt;

  const amp = 6 * holdLevel;                               // 抖动幅度渐大，封顶 6px
  const jx = (Math.sin(now * 120) + Math.sin(now * 197 + 1.7) * 0.6) * amp * 0.55;
  const jy = (Math.cos(now * 128 + 0.6) + Math.sin(now * 233 + 3.1) * 0.6) * amp * 0.55;
  const jr = (Math.sin(now * 108 + 2.2) + Math.sin(now * 181) * 0.5) * 2.4 * holdLevel;
  dogJelly.style.transform =
    `translate(${jx.toFixed(2)}px, ${jy.toFixed(2)}px)` +
    ` rotate(${jr.toFixed(2)}deg) scale(${jellyScale.toFixed(4)})`;

  // 颜色逐渐变红（黄色图 hue-rotate 负角度 → 红，辅以饱和提升）
  if (holdLevel > 0.004) {
    dogJelly.style.filter =
      `hue-rotate(${(-42 * holdLevel).toFixed(1)}deg)` +
      ` saturate(${(1 + 0.7 * holdLevel).toFixed(3)})` +
      ` brightness(${(1 + 0.04 * holdLevel).toFixed(3)})`;
  } else {
    dogJelly.style.filter = '';
  }

  fxFrame(now);
}

/* ============================================================
 * 指针交互：跨格补全 + 节奏队列；jiao 长音在原纹理上直接切换音高
 * ==========================================================*/
function retuneHeldJiao(pointerId, state, zi) {
  const z = zones[zi];
  if (!z || z.sample !== 'jiao' || !state.voice) return false;
  if (!isRetunableSustainVoice(state.voice)) return false;

  state.zone = zi;
  state.pendingEntryId = null;
  const entry = enqueueSustainRetune(zi, pointerId, state.voice);
  commitUnsnappedInput(entry);
  return true;
}

function enterZone(pointerId, state, zi) {
  if (zi === state.zone) return;
  if (retuneHeldJiao(pointerId, state, zi)) return;

  if (state.voice) {
    releaseVoice(state.voice, true);
    state.voice = null;
  }

  state.zone = zi;
  const entry = enqueueActivation(zi, pointerId);
  state.pendingEntryId = entry.id;
  commitUnsnappedInput(entry);
}

function createInputState(lastX = 0, lastY = 0) {
  return {
    zone: -1,
    voice: null,
    pendingEntryId: null,
    lastX,
    lastY,
  };
}

function beginZoneInput(inputId, zi, lastX = 0, lastY = 0) {
  const state = createInputState(lastX, lastY);
  // 指针和实体键盘共用同一个分区进入、排队、发声与视觉反馈入口。
  pointers.set(inputId, state);
  enterZone(inputId, state, zi);
  return state;
}

function tryActivate(pointerId, x, y, state) {
  if (!state) {
    // 自由节奏会在 enterZone 内立即播放，先注册状态才能正确接管 jiao 长音。
    return beginZoneInput(pointerId, zoneIndex(x, y), x, y);
  }

  for (const zi of zonesAlongSegment(state.lastX, state.lastY, x, y)) {
    enterZone(pointerId, state, zi);
  }
  state.lastX = x;
  state.lastY = y;
  return state;
}

stage.addEventListener('pointerdown', (e) => {
  const deferStartToIOSTouchEnd = isLikelyIOSWebKit() && (!started || !buffers.da);
  if (!deferStartToIOSTouchEnd) e.preventDefault();
  if (!started || !buffers.da) {
    pointers.set(e.pointerId, createInputState(e.clientX, e.clientY));
    hideControlsUntilIdle();
    if (!deferStartToIOSTouchEnd) start();
    return;
  }
  try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 某些旧浏览器不支持 */ }
  pointers.set(
    e.pointerId,
    tryActivate(e.pointerId, e.clientX, e.clientY, null)
  );
}, { passive: false });

function shouldIgnoreStartFallback(event) {
  const target = event.target;
  return Boolean(
    target &&
    target.closest &&
    target.closest('button, input, label, textarea, select, #custom-character-modal')
  );
}

function startFromLegacyTouchGesture(event) {
  if ((started && buffers.da) || shouldIgnoreStartFallback(event)) return;
  hideControlsUntilIdle();
  start();
}

function startFromIOSTouchEnd(event) {
  if (!isLikelyIOSWebKit() || (started && buffers.da) || shouldIgnoreStartFallback(event)) return;
  event.preventDefault();
  hideControlsUntilIdle();
  start();
}

stage.addEventListener('touchend', startFromIOSTouchEnd, { passive: false });

if (!window.PointerEvent) {
  stage.addEventListener('touchstart', startFromLegacyTouchGesture, { passive: true });
  stage.addEventListener('click', startFromLegacyTouchGesture);
}

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  if (!started || !buffers.da) return;
  e.preventDefault();
  pointers.set(
    e.pointerId,
    tryActivate(
      e.pointerId,
      e.clientX,
      e.clientY,
      pointers.get(e.pointerId)
    )
  );
}, { passive: false });

function endInput(inputId, musical) {
  const state = pointers.get(inputId);
  if (state && state.voice) {
    if (musical) releaseVoice(state.voice, true);
    else forceStopVoice(state.voice);
  }
  if (!musical) cancelQueuedInputs(inputId);
  pointers.delete(inputId);
  if (pointers.size === 0) hideControlsUntilIdle();
}

function endPointer(e, musical) {
  endInput(e.pointerId, musical);
  try {
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  } catch (_) { /* 指针捕获可能已经自动释放 */ }
}

window.addEventListener('pointerup', (e) => endPointer(e, true));
window.addEventListener('pointercancel', (e) => endPointer(e, false));

function keyboardInputBlocked() {
  return ccmModal.classList.contains('is-open');
}

function handlePianoKeyDown(event) {
  if (keyboardInputBlocked()) return;
  if (
    event.repeat ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  ) return;

  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    if (!octaveControlsEnabled()) return;
    event.preventDefault();
    shiftPianoOctave(event.code === 'ArrowLeft' ? -1 : 1);
    return;
  }

  const zi = pianoZoneIndexForCode(event.code);
  if (zi < 0) return;

  const inputId = `keyboard:${event.code}`;
  if (pointers.has(inputId)) return;
  event.preventDefault();

  if (!started || !buffers.da) {
    pointers.set(inputId, createInputState());
    hideControlsUntilIdle();
    start();
    return;
  }
  beginZoneInput(inputId, zi);
}

function handlePianoKeyUp(event) {
  if (!pianoKeyboardBinding(event.code)) return;
  const inputId = `keyboard:${event.code}`;
  if (!pointers.has(inputId)) return;
  event.preventDefault();
  endInput(inputId, true);
}

window.addEventListener('keydown', handlePianoKeyDown);
window.addEventListener('keyup', handlePianoKeyUp);
window.addEventListener('blur', () => {
  inputQueue.length = 0;
  clearInputVisualTimers();
  pointers.clear();
  for (const voice of [...liveVoices]) forceStopVoice(voice);
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

/* ============================================================
 * 启动
 * ==========================================================*/
async function start() {
  if (started) return;
  started = true;
  hideControlsUntilIdle();
  subEl.textContent = '狗 叫 加 载 中 …';

  try {
    // 正式 AudioContext 必须在用户手势内创建（iOS 严格要求，否则即使 resume 也静音）。
    initAudio();
    // 一次真实 source.start() 和 resume 都必须在用户手势的同步调用段内触发。
    // iOS 先看到可播放节点再 resume 更稳，避免只 resume 时上下文仍保持 suspended。
    primeAudioOutputForIOS();
    const resumePromise = resumeAudioContext('AudioContext.resume');
    // 并行/串行解码样本：iOS WebKit 串行，其他浏览器并行。
    await loadSamples();
    const resumed = await resumePromise;
    if (!resumed && ctx && ctx.state === 'suspended') {
      console.warn('[大狗Tap] AudioContext 仍未运行，清理后等待下一次点击重建。');
      showToyNotice('iPhone 音频未解锁，请再点一次屏幕。');
      clearDecodedSamples();
      pointers.clear();
      await closeAudioContextQuietly();
      started = false;
      subEl.textContent = '点 击 任 意 位 置 开 始';
      return;
    }

    startTime = ctx.currentTime + 0.12;
    nextNoteTime = startTime;
    lastCommittedInputTime = -Infinity;
    inputQueue.length = 0;
    stepCount = 0;
    setInterval(scheduler, 25);

    overlay.classList.add('hide');
    // 延音纹理在遮罩隐藏后后台构建，不阻塞首屏进入（见 buildSustainTexturesAsync）。
    buildSustainTexturesAsync();
  } catch (err) {
    // 解码失败（或 iOS 对该格式不兼容）时给出可见错误，而不是静默卡在加载界面。
    console.error('[大狗Tap] 音频加载失败', err);
    showToyNotice('音频加载失败，点屏幕重试：' + (err && err.message ? err.message : err), true);
    clearDecodedSamples();
    await closeAudioContextQuietly();
    started = false; // 允许再次点击重试
  }
}

let resizeTimer = 0;
function handleLayoutResize() {
  fxResize();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildGrid, 150);
}
window.addEventListener('resize', handleLayoutResize);
if (window.ResizeObserver) {
  const stageResizeObserver = new ResizeObserver(handleLayoutResize);
  stageResizeObserver.observe(stage);
}

// 页面加载即 prefetch 音频 base64 包（audio-data.json），用户点击开始时通常已就绪。
// 注意：不能在用户手势之前用 AudioContext/OfflineAudioContext 解码——iOS 会冻结
// 非手势创建的 Web Audio context，decodeAudioData 的 promise 永不 resolve 导致卡死。
// 解码只能在 start() 用户手势内进行（见 loadSamples）。
ensureAudioB64();

buildGrid();
fxResize();
updateMuteButton(musicToggle, bgmMuted, '音乐');
updateSfxSetButton();
showControls();
requestAnimationFrame(tick);
