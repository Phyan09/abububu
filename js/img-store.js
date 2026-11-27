// 增量精灵立绘的本地缓存（IndexedDB 存 Blob，容量大、WebView 原生支持）。
// 启动时把已缓存 Blob 转成 objectURL 放入内存 map，供渲染同步查询。

const DB_NAME = 'roco-img-cache';
const STORE = 'images';
const DB_VERSION = 1;

// 内存中的 objectURL：key -> url（key 形如 portrait:<Id> / shiny:<Id>）
const urlMap = new Map();

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

// 写入一张图片 Blob
export async function putImage(key, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put({ key, blob, updatedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getBlob(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllKeys() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// 应用启动时调用：把所有缓存图片转成 objectURL，填充内存 map。
// 返回缓存键数量。
export async function initImageCache() {
  const db = await openDB();
  const all = await new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  for (const rec of all) {
    if (urlMap.has(rec.key)) continue;
    urlMap.set(rec.key, URL.createObjectURL(rec.blob));
  }
  return urlMap.size;
}

// 同步查询缓存的 objectURL（渲染时用）。
export function cachedURL(key) {
  return urlMap.get(key) || '';
}

// 下载并缓存一张图片（fetch 拿 Blob）。成功后更新内存 map。
export async function downloadAndCache(key, realUrl) {
  const resp = await fetch(realUrl);
  if (!resp.ok) throw new Error(`图片下载失败 HTTP ${resp.status}`);
  const blob = await resp.blob();
  await putImage(key, blob);
  if (urlMap.has(key)) URL.revokeObjectURL(urlMap.get(key));
  urlMap.set(key, URL.createObjectURL(blob));
  return blob;
}

export function portraitKey(id) { return `portrait:${Number(id)}`; }
export function shinyKey(id) { return `shiny:${Number(id)}`; }
