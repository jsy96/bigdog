// lib/blob-storage.cjs
// Vercel Blob 存储封装：自定义形象（图片 + 元数据）全部存放在 Vercel Blob。
//
// @vercel/blob 是 ESM-only 包，这里用 dynamic import 加载，保持本文件为 CommonJS
// （与 server.js 一致，且无需在 package.json 设置 "type":"module"）。
//
// 自定义形象存储结构（每个形象独立一组 blob，互不干扰，无需维护单一索引文件）：
//   custom/<id>_close.png   闭嘴图（public，前端可直接 <img src>）
//   custom/<id>_open.png    张嘴图（public）
//   custom/<id>.json        元数据 {id,label,type,icon,close,open,builtin}（public，GET 时聚合）

let _blobMod = null;
async function blob() {
  if (!_blobMod) _blobMod = await import('@vercel/blob');
  return _blobMod;
}

const CUSTOM_PREFIX = 'custom/';

function ensureToken() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    const err = new Error('BLOB_READ_WRITE_TOKEN is not configured');
    err.status = 503;
    throw err;
  }
}

// 列出全部自定义形象：枚举 custom/ 下的 .json 元数据并逐个读取解析（处理分页）。
async function listCustomCharacters() {
  ensureToken();
  const { list } = await blob();

  let blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: CUSTOM_PREFIX, cursor });
    blobs = blobs.concat(page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  const metaBlobs = blobs.filter((b) => b.pathname.endsWith('.json'));
  const entries = await Promise.all(
    metaBlobs.map(async (b) => {
      try {
        const res = await fetch(b.url);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    })
  );
  return entries.filter(Boolean).filter((c) => c && c.id && c.close && c.open);
}

// 上传一个自定义形象（闭嘴 + 张嘴 + 元数据），返回前端可直接使用的 character 对象。
// id 含时间戳，前端按 id 排序即近似按上传时间。
async function uploadCustomCharacter({ label, closeBuf, openBuf }) {
  ensureToken();
  const { put } = await blob();
  const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const [closeRes, openRes] = await Promise.all([
    put(`${CUSTOM_PREFIX}${id}_close.png`, closeBuf, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'image/png',
    }),
    put(`${CUSTOM_PREFIX}${id}_open.png`, openBuf, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'image/png',
    }),
  ]);

  const character = {
    id,
    label,
    type: 'static',
    icon: closeRes.url,
    close: closeRes.url,
    open: openRes.url,
    builtin: false,
  };

  await put(`${CUSTOM_PREFIX}${id}.json`, JSON.stringify(character), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });

  return character;
}

// 删除一个自定义形象：删除其元数据与两张图片。
async function deleteCustomCharacter(id) {
  ensureToken();
  const { list, del } = await blob();
  const { blobs } = await list({ prefix: `${CUSTOM_PREFIX}${id}` });
  if (!blobs || !blobs.length) {
    const err = new Error('character not found');
    err.status = 404;
    throw err;
  }
  await del(blobs.map((b) => b.url));
}

module.exports = {
  listCustomCharacters,
  uploadCustomCharacter,
  deleteCustomCharacter,
};
