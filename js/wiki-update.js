// 从 biligame Wiki 检查并导入新精灵：数值 + 立绘，与内置 catalog 兼容合并。
//
// 数据源说明（已核实）：
//  - 原作者 GitHub 仓库仅发布 EXE、不提供源码与结构化数据，无法增量拉取；
//  - 可持续的公开数据源是 Wiki 的 MediaWiki 模块「模块:Pets/data/Catalog」。
//  - 网络请求在安卓端经 CapacitorHttp 走原生层，绕过浏览器 CORS。
//  - 立绘真实哈希路径无法由文件名推断，须经 imageinfo API 解析。

import {
  downloadAndCache, portraitKey, shinyKey,
} from './img-store.js?v=126';

const WIKI = 'https://wiki.biligame.com/nrc';
const CATALOG_TITLE = '模块:Pets/data/Catalog';
const INC_KEY = 'roco-wiki-incremental-v1';

// 元素中文名（去“系”）-> 内部元素 Id
const ELEM = {
  首领: 1, 普通: 2, 草: 3, 火: 4, 水: 5, 光: 6, 地: 8, 冰: 9,
  龙: 10, 电: 11, 毒: 12, 虫: 13, 武: 14, 翼: 15, 萌: 16,
  幽: 17, 恶: 18, 机械: 19, 幻: 20,
};

// ---------- Lua table 解析（括号配对，正确处理嵌套与字符串） ----------
function matchBlock(s, bracePos) {
  let depth = 0, i = bracePos, inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') inStr = !inStr;
    else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return -1;
}

// 块内顶层字段（相对块自身，深度 1）的值起始位置；找不到返回 -1。
function fieldPos(block, key) {
  let depth = 0, inStr = false, i = 0;
  const pat = key + '=';
  while (i < block.length) {
    const c = block[i];
    if (c === '"') inStr = !inStr;
    else if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 1 && block.startsWith(pat, i)) return i + pat.length;
    }
    i++;
  }
  return -1;
}

function valueAt(block, pos) {
  if (pos < 0) return null;
  if (block[pos] === '"') {
    const e = block.indexOf('"', pos + 1);
    return block.slice(pos + 1, e);
  }
  if (block[pos] === '{') {
    const e = matchBlock(block, pos);
    return e < 0 ? null : block.slice(pos, e + 1);
  }
  const m = block.slice(pos).match(/^[\w.]+/);
  return m ? m[0] : null;
}

// 解析主 Catalog raw，返回内部结构的精灵数组。
export function parseCatalog(raw) {
  const out = [];
  const re = /pet_(\d+)=\{/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const petId = Number(m[1]);           // 用 pet_x 的键作 Id：同一精灵的不同形态各有独立 Id
    const bp = m.index + m[0].length - 1;
    const end = matchBlock(raw, bp);
    if (end < 0) continue;
    const blk = raw.slice(bp, end + 1);

    const imgPos = fieldPos(blk, 'image');
    const img = valueAt(blk, imgPos);
    if (!img) continue;
    const head = valueAt(img, fieldPos(img, 'head'));
    if (!/PetAvatar_(\d+)/.test(head || '')) continue;

    const g = (k) => valueAt(blk, fieldPos(blk, k));
    const name = g('name');
    const number = g('number');
    const relation = g('relation_key');
    const hasShiny = g('has_shiny') === 'true';
    const stageRaw = g('stage');
    const illustration = valueAt(img, fieldPos(img, 'illustration'));
    const shinyFile = valueAt(img, fieldPos(img, 'shiny'));
    const statsTbl = g('stats');

    const race = {};
    const sr = /(\w+)=(\d+)/g;
    let sm;
    while ((sm = sr.exec(statsTbl || '')) !== null) race[sm[1]] = Number(sm[2]);

    const elements = [];
    for (const part of (relation || '').split('|')) {
      const p = part.replace('系', '');
      if (ELEM[p] != null && !elements.includes(ELEM[p])) elements.push(ELEM[p]);
    }

    const stage = stageRaw != null && /^\d+$/.test(stageRaw) ? Number(stageRaw) : null;
    out.push({
      Id: petId,
      Number: number != null && /^\d+$/.test(number) ? Number(number) : null,
      Name: name,
      elements,
      race: [race.hp, race.atk, race.spa, race.def, race.spd, race.spe],
      stage,
      hasShiny,
      illustration,
      shinyFile,
    });
  }
  return out;
}

// ---------- 增量数据持久化 ----------
export function loadIncremental() {
  try {
    const raw = JSON.parse(localStorage.getItem(INC_KEY));
    if (raw && Array.isArray(raw.species)) return raw;
  } catch (e) { /* 忽略 */ }
  return { species: [], racePatch: {}, lastCheck: null };
}

function saveIncremental(data) {
  localStorage.setItem(INC_KEY, JSON.stringify(data));
}

// 把解析出的 Wiki 行转成内部 Species 结构。
function toSpecies(w) {
  return {
    Id: w.Id,
    Number: w.Number,
    Name: w.Name,
    Form: '',
    Elements: w.elements,
    Portrait: '__wiki__',       // 占位，实际立绘走 img-store
    IsFinalStage: true,
    IsCatchableInitial: true,
    EnemyGroups: w.hasShiny ? ['异色'] : [],
    StrengthStage: w.stage,
    Race: w.race,
    Skills: [],
    Passive: '',
    PassiveDescription: '',
    _wiki: true,
  };
}

// ---------- imageinfo：批量解析真实图片 URL ----------
async function resolveImageUrls(fileNames) {
  const result = {};
  const batchSize = 40;
  for (let i = 0; i < fileNames.length; i += batchSize) {
    const batch = fileNames.slice(i, i + batchSize);
    const titles = batch.map((f) => `File:${f}`).join('|');
    const url = `${WIKI}/api.php?action=query&format=json&prop=imageinfo&iiprop=url&titles=${encodeURIComponent(titles)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`imageinfo 请求失败 HTTP ${resp.status}`);
    const json = await resp.json();
    const pages = json.query && json.query.pages ? json.query.pages : {};
    // title(规范化) -> realUrl
    const titleToUrl = {};
    for (const key of Object.keys(pages)) {
      const p = pages[key];
      if (p.imageinfo && p.imageinfo[0] && p.imageinfo[0].url) {
        titleToUrl[p.title] = p.imageinfo[0].url;
      }
    }
    // normalized: from -> to
    const norm = {};
    const normList = (json.query && json.query.normalized) || [];
    for (const n of normList) norm[n.from] = n.to;
    for (const f of batch) {
      const from = `File:${f}`;
      const canonical = norm[from] || from;
      if (titleToUrl[canonical]) result[f] = titleToUrl[canonical];
    }
  }
  return result;
}

// ---------- 主流程：只做联网核对，不自动改数据 ----------
// 同名的不同形态种族值不同，因此不按 Id 硬对，而是按「名字 → 种族值集合」整体比对，
// 只有内置里某个形态的种族值在 Wiki 全集中找不到，才算官方调整。
export async function checkForUpdates(builtinSpecies, onProgress) {
  const list = Array.isArray(builtinSpecies) ? builtinSpecies : [];
  const inc = loadIncremental();
  const knownIds = new Set(list.map((s) => s.Id));
  const knownNames = new Set(list.map((s) => s.Name));
  for (const s of inc.species) { knownIds.add(s.Id); knownNames.add(s.Name); }

  onProgress('正在联网核对 Wiki 图鉴…');
  const rawUrl = `${WIKI}/index.php?title=${encodeURIComponent(CATALOG_TITLE)}&action=raw`;
  const resp = await fetch(rawUrl);
  if (!resp.ok) throw new Error(`无法连接 Wiki（HTTP ${resp.status}）`);
  const raw = await resp.text();

  onProgress('正在比对图鉴数据…');
  const parsed = parseCatalog(raw);
  const key = (r) => (r || []).join(',');

  // ① 新精灵：Id 与名字都不在库里的（排除蛋/果实、数据不全的）
  const isEgg = (n) => /的蛋|的果实|蛋$/.test(n || '');
  const newSpecies = parsed
    .filter((w) => !knownIds.has(w.Id) && !knownNames.has(w.Name) && !isEgg(w.Name)
      && w.race.every((x) => x != null) && w.elements.length)
    .map((w) => ({ Id: w.Id, Name: w.Name, shiny: w.hasShiny }));

  // ② 种族值调整：按名字汇总所有形态的种族值集合再比
  const wikiByName = new Map();
  for (const w of parsed) {
    if (!w.Name || !w.race.every((x) => x != null)) continue;
    if (!wikiByName.has(w.Name)) wikiByName.set(w.Name, new Set());
    wikiByName.get(w.Name).add(key(w.race));
  }
  const baseByName = new Map();
  for (const sp of list) {
    if (!sp || !sp.Name || !Array.isArray(sp.Race) || sp.Race.length !== 6) continue;
    if (!baseByName.has(sp.Name)) baseByName.set(sp.Name, new Set());
    baseByName.get(sp.Name).add(key(sp.Race));
  }
  const raceChanges = [];
  for (const [name, baseSet] of baseByName) {
    const wikiSet = wikiByName.get(name);
    if (!wikiSet) continue;                       // Wiki 里没有这只，视作未收录，不报调整
    const missing = [...baseSet].filter((r) => !wikiSet.has(r));
    if (!missing.length) continue;
    raceChanges.push({ Name: name, forms: missing.length, wikiForms: wikiSet.size });
  }

  delete inc.racePatch;
  inc.lastCheck = Date.now();
  saveIncremental(inc);
  return { newSpecies, raceChanges, updatedAt: inc.lastCheck };
}
