// api/characters/[id].js
// Vercel Serverless Function：DELETE /api/characters/:id 删除自定义形象（Vercel Blob）。

const storage = require('../../lib/blob-storage.cjs');

// 只允许字母/数字/下划线/短横线，排除 / \ .. 等路径穿越字符。
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const BUILTIN_IDS = new Set(['dagou', 'dingdongji', 'maodie', 'donghaidihuang']);

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).end(body);
}

module.exports = async (req, res) => {
  if (req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const id = decodeURIComponent(String(req.query.id || ''));
  if (!SAFE_ID_RE.test(id)) {
    sendJson(res, 400, { error: 'invalid id' });
    return;
  }
  if (BUILTIN_IDS.has(id)) {
    sendJson(res, 403, { error: 'builtin character cannot be deleted' });
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    sendJson(res, 503, { error: '删除不可用：未配置 Vercel Blob 存储' });
    return;
  }

  try {
    await storage.deleteCustomCharacter(id);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[api/characters/:id] 内部错误:', err);
    sendJson(res, status, { error: err.message || 'error' });
  }
};
