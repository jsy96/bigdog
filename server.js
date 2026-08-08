// server.js — 大狗 Tap 前后端服务器（零依赖，仅用 Node.js 内置模块）
//
// 职责：
//   1. 静态文件服务（index.html / main.js / audio-data.js / Image / audio / docs …）
//   2. GET    /api/characters        扫描 Image 目录，返回全部形象（内置 + 自定义）
//   3. POST   /api/characters        上传自定义形象（JSON: {label, close, open}，值为 PNG dataURL）
//   4. DELETE /api/characters/:id    删除自定义形象（同时删除其图片文件）
//
// 启动：
//   node server.js            （默认端口 8000，可用 PORT 环境变量覆盖）
//   然后浏览器访问 http://localhost:8000/
//
// 设计原则：image 目录里有什么图片，就有什么形象——形象清单由扫描 Image 目录得出，
// 而不是硬编码。自定义形象上传后落盘到 Image 目录，下次扫描自动包含。

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = __dirname;
const IMAGE_DIR = path.join(ROOT, 'Image');
const META_FILE = path.join(IMAGE_DIR, 'characters.json');
const PORT = Number(process.env.PORT) || 8000;
const MAX_BODY = 12 * 1024 * 1024; // 单次请求体上限 12MB（两张 base64 PNG 足够）

// 内置形象的中文名文案与循环顺序。
// 仅决定 label 文案与展示顺序；某个内置形象是否存在仍取决于 Image 目录里有没有对应文件。
const BUILTIN_LABELS = {
  dagou: '大狗',
  dingdongji: '叮咚鸡',
  maodie: '哈基米',
  donghaidihuang: '帝皇',
};
const BUILTIN_STATIC_ORDER = ['dagou', 'dingdongji', 'maodie'];
const EMPEROR_PREFIX = 'donghaidihuang';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

// 配对规则：
//   {前缀}_close[_mouth].ext  +  {前缀}_open[_mouth].ext   → 静态双图形象
//   {前缀}_atlas.ext          +  {前缀}_icon.ext           → 精灵图动画形象（帝皇）
// 前缀用 .+? 非贪婪，能正确处理含下划线的前缀（如 custom_xxx_1、1_1）。
const PAIR_RE = /^(.+?)_(close|open)(?:_mouth)?\.(png|webp|jpe?g|gif)$/i;
const ATLAS_RE = /^(.+?)_atlas\.(webp|png|jpe?g|gif)$/i;
const ICON_RE = /^(.+?)_icon\.(webp|png|jpe?g|gif)$/i;
// 删除接口接收的形象 id：只允许字母、数字、下划线、短横线，排除 / \ .. 等路径穿越字符。
const SAFE_CHARACTER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- 元数据读写（characters.json 记录自定义形象的 id/label/文件名） ----------

async function readMeta() {
  try {
    const raw = await fsp.readFile(META_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const custom = Array.isArray(obj.custom) ? obj.custom : [];
    // 过滤掉结构不完整的条目
    return {
      custom: custom.filter((c) => c && c.id && c.close && c.open),
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { custom: [] };
    console.warn('[server] characters.json 解析失败，按空处理。', err.message);
    return { custom: [] };
  }
}

async function writeMeta(meta) {
  const tmp = `${META_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
  // 原子替换：写临时文件再 rename，避免并发或中途崩溃损坏清单。
  await fsp.rename(tmp, META_FILE);
}

// ---------- 扫描 Image 目录，构建形象清单 ----------

async function scanCharacters() {
  const meta = await readMeta();
  const labelById = new Map();
  for (const c of meta.custom) labelById.set(c.id, c.label);

  let files = [];
  try {
    files = await fsp.readdir(IMAGE_DIR);
  } catch (err) {
    console.warn('[server] Image 目录读取失败。', err.message);
    return [];
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

  // 1) 内置静态形象（按固定顺序）
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

  // 2) 帝皇精灵图动画（atlas 必须存在）
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

  // 3) 其余静态形象（用户上传的自定义 + 历史遗留），按 id 排序追加
  const rest = Object.keys(pairs)
    .filter((p) => !seen.has(p) && pairs[p].close && pairs[p].open)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const prefix of rest) {
    const p = pairs[prefix];
    result.push({
      id: prefix,
      label: labelById.get(prefix) || BUILTIN_LABELS[prefix] || prefix,
      type: 'static',
      icon: p.close,
      close: p.close,
      open: p.open,
      builtin: false,
    });
    seen.add(prefix);
  }

  return result;
}

// ---------- 创建 / 删除自定义形象 ----------

function sanitizeLabel(raw) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) s = '自定义';
  // 按字符（码点）截断前 6 个，避免把一个中文截成半个
  return Array.from(s).slice(0, 6).join('');
}

function dataUrlToBuffer(dataUrl) {
  if (typeof dataUrl !== 'string') throw new HttpError(400, 'invalid image');
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s.exec(dataUrl.trim());
  if (!m) throw new HttpError(400, 'invalid image data url');
  let buf;
  try {
    buf = Buffer.from(m[1], 'base64');
  } catch {
    throw new HttpError(400, 'invalid base64');
  }
  if (!buf || buf.length < 8) throw new HttpError(400, 'empty image');
  return buf;
}

async function createCustomCharacter({ label, closeBuf, openBuf }) {
  const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const closeName = `${id}_close.png`;
  const openName = `${id}_open.png`;
  await fsp.writeFile(path.join(IMAGE_DIR, closeName), closeBuf);
  await fsp.writeFile(path.join(IMAGE_DIR, openName), openBuf);

  const meta = await readMeta();
  const record = { id, label, close: closeName, open: openName };
  meta.custom.push(record);
  await writeMeta(meta);

  return {
    id,
    label,
    type: 'static',
    icon: `Image/${closeName}`,
    close: `Image/${closeName}`,
    open: `Image/${openName}`,
    builtin: false,
  };
}

async function safeUnlink(file) {
  try {
    await fsp.unlink(file);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

async function deleteCustomCharacter(id) {
  if (!SAFE_CHARACTER_ID_RE.test(id)) throw new HttpError(400, 'invalid id');
  if (BUILTIN_STATIC_ORDER.includes(id) || id === EMPEROR_PREFIX) {
    throw new HttpError(403, 'builtin character cannot be deleted');
  }

  const meta = await readMeta();
  const idx = meta.custom.findIndex((c) => c.id === id);
  if (idx >= 0) {
    const [entry] = meta.custom.splice(idx, 1);
    await safeUnlink(path.join(IMAGE_DIR, entry.close));
    await safeUnlink(path.join(IMAGE_DIR, entry.open));
    await writeMeta(meta);
    return;
  }

  // 兼容直接手动放进 Image/ 的配对图片（如 1_1_close.png / 1_1_open.png）：
  // 只要不是内置形象，也允许从面板里删除。
  const files = await fsp.readdir(IMAGE_DIR);
  const matched = [];
  for (const file of files) {
    const m = PAIR_RE.exec(file);
    if (m && m[1] === id) matched.push(file);
  }
  const hasClose = matched.some((file) => /_close(?:_mouth)?\./i.test(file));
  const hasOpen = matched.some((file) => /_open(?:_mouth)?\./i.test(file));
  if (!hasClose || !hasOpen) throw new HttpError(404, 'character not found');
  for (const file of matched) {
    await safeUnlink(path.join(IMAGE_DIR, file));
  }
}

// ---------- HTTP 工具 ----------

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
  });
  res.end(message);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejected = true;
        req.destroy();
        reject(new HttpError(413, 'request body too large'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (rejected) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}

// ---------- API 路由 ----------

async function handleApi(req, res, method, pathname) {
  if (pathname === '/api/characters' && method === 'GET') {
    const characters = await scanCharacters();
    sendJson(res, 200, { characters });
    return true;
  }

  if (pathname === '/api/characters' && method === 'POST') {
    const body = await readJsonBody(req);
    const label = sanitizeLabel(body.label);
    const closeBuf = dataUrlToBuffer(body.close);
    const openBuf = dataUrlToBuffer(body.open);
    const character = await createCustomCharacter({ label, closeBuf, openBuf });
    sendJson(res, 200, { character });
    return true;
  }

  const del = method === 'DELETE' ? /^\/api\/characters\/([^/]+)$/.exec(pathname) : null;
  if (del) {
    const id = decodeURIComponent(del[1]);
    await deleteCustomCharacter(id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ---------- 静态文件服务 ----------

async function serveStatic(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'bad request');
    return;
  }

  let filePath = path.normalize(path.join(ROOT, decoded));
  // 路径穿越防护：解析后的绝对路径必须仍在 ROOT 内
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    sendText(res, 403, 'forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendText(res, 404, 'not found');
    return;
  }

  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    try {
      stat = await fsp.stat(filePath);
    } catch {
      sendText(res, 404, 'not found');
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    // 静态资源用弱缓存：保证改代码后刷新立即生效，又不至于每次都重传大文件
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- 主请求处理 ----------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, method, pathname);
      if (!handled) sendJson(res, 404, { error: 'not found' });
      return;
    }
    await serveStatic(res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[server] 内部错误:', err);
    if (res.headersSent) {
      res.end();
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendJson(res, status, { error: err.message || 'error' });
    } else {
      sendText(res, status, err.message || 'error');
    }
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[server] 未捕获错误:', err);
    if (!res.headersSent) sendText(res, 500, 'internal error');
  });
});

server.listen(PORT, () => {
  console.log('========================================================');
  console.log('  大狗 Tap 前后端服务器已启动');
  console.log('  本地访问:  http://localhost:' + PORT + '/');
  console.log('  形象 API:  http://localhost:' + PORT + '/api/characters');
  console.log('  按 Ctrl+C 停止');
  console.log('========================================================');
});
