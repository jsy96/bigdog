// api/characters.js
// Vercel Serverless Function：
//   GET  /api/characters  列出全部形象（内置只读清单 + Vercel Blob 自定义）
//   POST /api/characters  上传自定义形象（JSON: {label, close, open}，值为 PNG dataURL）
//
// 内置形象来自构建期生成的 data/builtin-characters.json（只读，由 scripts/build-builtin-characters.mjs 产出）；
// 自定义形象来自 Vercel Blob。未配置 Blob 时降级：仅返回内置形象，基础游玩不受影响。

const fs = require('node:fs');
const path = require('node:path');
const storage = require('../lib/blob-storage.cjs');

// Vercel 打包后函数的工作目录与源码相对位置可能不同，列出多个候选路径逐一尝试。
const BUILTIN_CANDIDATES = [
  path.join(process.cwd(), 'data', 'builtin-characters.json'),
  path.join(__dirname, '..', 'data', 'builtin-characters.json'),
];

function readBuiltin() {
  for (const file of BUILTIN_CANDIDATES) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw);
      if (Array.isArray(obj.characters)) return obj.characters;
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  console.warn('[api/characters] 内置清单读取失败（已尝试所有候选路径）');
  return [];
}

// cacheControl：GET 形象清单可被 CDN/浏览器短缓存（首屏加速）；
// POST 上传与错误响应默认 no-store，避免被中间缓存误存。
function sendJson(res, status, obj, cacheControl = 'no-store') {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  // @vercel/node 给的 res 是原生 Node ServerResponse，没有 Express 的 res.status()；
  // 必须用 res.writeHead(status, headers) 设状态码与响应头（与 server.js 一致）。
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
    'Content-Length': body.length,
  });
  res.end(body);
}

function sanitizeLabel(raw) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) s = '自定义';
  // 按字符（码点）截断前 6 个，避免把一个中文截成半个
  return Array.from(s).slice(0, 6).join('');
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s.exec(String(dataUrl).trim());
  if (!m) {
    const e = new Error('invalid image data url');
    e.status = 400;
    throw e;
  }
  const buf = Buffer.from(m[1], 'base64');
  if (!buf || buf.length < 8) {
    const e = new Error('empty image');
    e.status = 400;
    throw e;
  }
  return buf;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error('invalid json');
    e.status = 400;
    throw e;
  }
}

module.exports = async (req, res) => {
  const method = req.method;

  try {
    if (method === 'GET') {
      const builtin = readBuiltin();
      let custom = [];
      if (process.env.BLOB_READ_WRITE_TOKEN) {
        try {
          custom = await storage.listCustomCharacters();
        } catch (err) {
          console.warn('[api/characters] 读取自定义形象失败：', err.message);
        }
      }
      custom.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      // 形象清单低频变更：浏览器 max-age=60s 缓存，CDN s-maxage=600s 缓存，
      // 过期后允许返回旧值并后台刷新（SWR）。首屏通常命中 CDN，不再等 serverless 冷启动。
      sendJson(
        res,
        200,
        { characters: [...builtin, ...custom] },
        'public, max-age=60, s-maxage=600, stale-while-revalidate=86400',
      );
      return;
    }

    if (method === 'POST') {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        sendJson(res, 503, { error: '上传不可用：未配置 Vercel Blob 存储' });
        return;
      }
      const body = await readJsonBody(req);
      const label = sanitizeLabel(body.label);
      const closeBuf = dataUrlToBuffer(body.close);
      const openBuf = dataUrlToBuffer(body.open);
      const character = await storage.uploadCustomCharacter({ label, closeBuf, openBuf });
      sendJson(res, 200, { character });
      return;
    }

    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[api/characters] 内部错误:', err);
    sendJson(res, status, { error: err.message || 'error' });
  }
};
