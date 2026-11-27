import { Catalog, ELEMENT_NAMES, STAT_NAMES } from './catalog.js?v=126';
import { Rat } from './rational.js?v=126';
import { solve } from './solver.js?v=126';
import { predictEnemy } from './stats.js?v=126';
import { levelFactor, awakeningFactor, stabFactor } from './damage.js?v=126';
import { icon, shinyIcon } from './icons.js?v=126';
import { portraitUrl, shinyPortraitUrl, elementIconUrl, elementPickIconUrl, statIconUrl, imgTag } from './assets.js?v=126';
import { elementColor } from './element-colors.js?v=126';
import { initImageCache } from './img-store.js?v=126';
import { checkForUpdates, loadIncremental } from './wiki-update.js?v=126';
import {
  observationHealthBounds,
  intersectHealthBounds,
  shinyScale,
  shinyHpMult,
} from './health.js?v=126';

let catalog;
const STORAGE_KEY = 'roco-nature-pages-v1';

const state = { pages: [], activeId: null };
const $ = (id) => document.getElementById(id);
let pageSeq = 1;

// ---------- 页面模型 ----------
function newObservation(seq) {
  return {
    seq: seq || 1,
    direction: 'OwnAttacksTarget',
    channel: 'Physical',
    damage: '',
    critical: false,
    opposite: '',
    power: '',
    element: 2,
    ownElements: [],   // 我方系别（0~2 个）：决定本系判定 + 与目标的克制关系
    isNative: false,
    typeRel: 'neutral',
    weatherMult: '1',
    atkBonus: '0',
    defBonus: '0',
    powerBonus: '0',   // 技能威力固定加减（带符号整数，如 +20 / -10）
    // 骰子效果：只收属性增益类（原项目 DiceEffects 的 GradeBasisPoints）
    diceAtk: '0',
    diceDef: '0',
    mineAw: '',        // 我方觉醒星级（0-5）：我方当攻击方=极化、当防守方=钝化；对方永远 0 不填
    atkAwakening: '0',
    defAwakening: '0',
    panelOwnAtk: '',   // 我方攻击面板（测防御时用）
    panelOwnDef: '',   // 我方防御面板（测攻击时用）
    // 状态流·测生命专用（对齐原项目 RoundObservation 四字段）
    hpLoss: '',       // 累计掉血（生命比例分支配套）
    hpPercent: '',    // 生命值比例·回合结束
    hpFreeze: '',     // 冻结伤害
    hpStrong: '',     // 强击伤害
    hpEvil: '',       // 恶念交换回血
  };
}

// 我方系别（最多两个）
function ownElems(o) {
  const v = o && o.ownElements;
  return Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : [];
}

// 系别关系推导：技能系别 × 防守方系别 → 克制倍率；技能系别 ∈ 攻击方系别 → 本系
function relOf(o, sp) {
  const skill = Number(o.element);
  const own = ownElems(o);
  const spElems = sp && Array.isArray(sp.Elements) ? sp.Elements.map(Number) : [];
  const atkElems = o.direction === 'OwnAttacksTarget' ? own : spElems;
  const defElems = o.direction === 'OwnAttacksTarget' ? spElems : own;
  let factor = null, relation = null;
  if (skill && defElems.length) {
    try {
      const r = catalog.typeFactor(skill, defElems);
      factor = r.factor; relation = r.relation;
    } catch (e) { factor = null; }
  }
  if (factor == null) {
    // 退路：老的「手动勾选克制/本系」数据仍按原字段解析
    const legacy = o.typeRel === 'advantage' ? 'SingleAdvantage'
      : o.typeRel === 'resistance' ? 'SingleResistance' : 'Neutral';
    return {
      factor: legacy === 'SingleAdvantage' ? new Rat(2n) : legacy === 'SingleResistance' ? new Rat(1n, 2n) : new Rat(1n),
      relation: legacy, isNative: !!o.isNative, auto: false, atkElems, defElems,
    };
  }
  return { factor, relation, isNative: !!skill && atkElems.includes(skill), auto: true, atkElems, defElems };
}

// 自动关系的一行说明（克制倍率 + 本系）
function relLineText(o, rel, sp) {
  const skillName = ELEMENT_NAMES[Number(o.element)] || '—';
  const defNames = rel.defElems.map((e) => ELEMENT_NAMES[e]).filter(Boolean).join(' / ');
  if (!rel.auto) {
    return `选上「我方系别」后，克制与本系会自动算；现在按普通 ×1、非本系处理。`;
  }
  const f = rel.factor.toNumber();
  const relTxt = f === 1 ? '普通 ×1' : f > 1 ? `克制 ×${f}` : `微弱 ×${f}`;
  const awLv = atkAwOf(o);
  let stabTxt = '非本系 ×1';
  if (rel.isNative) {
    stabTxt = awLv > 0
      ? `本系 ×${stabFactor(true, awLv).toNumber().toFixed(2)}（攻击方 ${awLv} 星觉醒）`
      : '本系 ×1.25（攻击方未觉醒）';
  }
  return `${skillName} 打 ${defNames}：${relTxt}；${stabTxt}（自动判断，不用再手勾）`;
}

// 「我方觉醒」取值（测防御=攻击方，测攻击=防守方；对方那侧永远固定 0）
function mineAwakeOf(o) {
  if (!o) return '';
  const raw = String(o.mineAw ?? '').trim();
  if (/^[0-5]$/.test(raw)) return raw;
  return String(o.direction === 'OwnAttacksTarget' ? o.atkAwakening : o.defAwakening ?? '');
}
// 把我方觉醒星级摊到「攻击方/防守方觉醒」：我方是攻击方 → 极化等级；我方是防守方 → 钝化等级
function applyAw(o) {
  const raw = String(o.mineAw ?? '').trim();
  const v = /^[0-5]$/.test(raw) ? raw : '';
  if (!v) { o.atkAwakening = '0'; o.defAwakening = '0'; return; }
  if (o.direction === 'OwnAttacksTarget') { o.atkAwakening = v; o.defAwakening = '0'; }
  else if (o.direction === 'TargetAttacksOwn') { o.atkAwakening = '0'; o.defAwakening = v; }
  else { o.atkAwakening = '0'; o.defAwakening = '0'; }
}
// 我方觉醒星级的记忆：不分测试类型，全页最近一条填过的值（测攻击/测防御共用）
function awakeMemoryOf(p, excludeIdx = -1) {
  for (let i = p.observations.length - 1; i >= 0; i--) {
    if (i === excludeIdx) continue;
    const v = String(p.observations[i].mineAw ?? '').trim();
    if (/^[0-5]$/.test(v)) return v;
  }
  return '';
}

// 我方觉醒星级 → 自动落到「攻击方（极化）/ 防守方（钝化）」；对方永远 0
function atkAwOf(o) {
  if (!o || o.direction !== 'OwnAttacksTarget') return 0;
  return parseInt(mineAwakeOf(o), 10) || 0;
}
function defAwOf(o) {
  if (!o || o.direction !== 'TargetAttacksOwn') return 0;
  return parseInt(mineAwakeOf(o), 10) || 0;
}

// 「我的攻击面板 / 我的防御面板」按测试类型分开存，切类型时互不串值
function panelOf(o) {
  if (!o) return '';
  if (o.direction === 'OwnAttacksTarget') return String(o.panelOwnAtk ?? '');
  if (o.direction === 'TargetAttacksOwn') return String(o.panelOwnDef ?? '');
  return String(o.opposite ?? '');
}
function validAwake(v) {
  const raw = String(v ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 && n <= 5 ? raw : '';
}
// 同一计算器里、指定观测方式最近的一条（可按 idx 排除自身）
function latestOfDirection(p, dir, excludeIdx) {
  for (let i = p.observations.length - 1; i >= 0; i--) {
    if (i === excludeIdx) continue;
    if (p.observations[i].direction === dir) return p.observations[i];
  }
  return null;
}

function newPage() {
  return {
    id: `p${Date.now()}_${pageSeq++}`,
    name: '',
    speciesId: null,
    level: '',
    ownLevel: 60,
    hpModel: 'EncounterPlus22',
    isShiny: false,
    obsSeq: 0,          // 测试数据序号的单调计数器：删掉的号不再复用
    observations: [],
  };
}

// 长按加号：清空所有计算器，只保留一个没有任何输入的默认初始计算器。
function resetToSinglePage() {
  const p = newPage();
  state.pages = [p];
  state.activeId = p.id;
  save();
  renderPage();
}

// 该精灵是否支持异色计算：
// ① EnemyGroups 含“异色”（确实存在异色形态）；② 有 StrengthStage（数据库可做敌方预测）。
function speciesSupportsShiny(s) {
  if (!s) return false;
  const hasShinyGroup = (s.EnemyGroups || []).some((g) => String(g).includes('异色'));
  const stage = s.StrengthStage;
  const supported = stage === 1 || stage === 2 || stage === 3;
  return hasShinyGroup && supported;
}

function current() {
  return state.pages.find((p) => p.id === state.activeId) || state.pages[0];
}

function pageDisplayName(p, index) {
  if (p.name) return p.name;
  if (p.speciesId) {
    const s = catalog.findSpecies(p.speciesId);
    if (s) return s.Name;
  }
  return `计算器 ${index + 1}`;
}

// ---------- 持久化 ----------
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 忽略 */ }
}
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw && Array.isArray(raw.pages) && raw.pages.length) {
      // 一次性迁移：技能威力加成从百分比口径改为固定点数，旧百分比值无法换算，统一清零
      const needMigrate = !raw.powerFlatMigrated;
      state.pages = raw.pages.map((pg) => {
        if (pg.ownLevel == null || !(Number(pg.ownLevel) > 0)) pg.ownLevel = 60;
        // 旧存档的“理论面板（破盾后）”一律归到奇遇破盾前
        if (pg.hpModel !== 'EncounterPlus22') pg.hpModel = 'EncounterPlus22';
        let maxSeq = Number(pg.obsSeq) || 0;
        (pg.observations || []).forEach((o) => { maxSeq = Math.max(maxSeq, Number(o.seq) || 0); });
        pg.obsSeq = maxSeq;
        (pg.observations || []).forEach((o, i) => {
          if (!Number(o.seq)) o.seq = maxSeq ? (maxSeq + i + 1) : (i + 1);
          if (o.atkBonus == null) o.atkBonus = String((Number(o.atkGrade) || 0) * 50);
          if (o.defBonus == null) o.defBonus = String((Number(o.defGrade) || 0) * 50);
          if (needMigrate || o.powerBonus == null) o.powerBonus = '0';
          // 旧存档只有 opposite：按当时的方向归到「我方攻击面板 / 我方防御面板」
          if (o.panelOwnAtk == null) o.panelOwnAtk = o.direction === 'OwnAttacksTarget' ? String(o.opposite ?? '') : '';
          if (o.panelOwnDef == null) o.panelOwnDef = o.direction === 'TargetAttacksOwn' ? String(o.opposite ?? '') : '';
          // 旧的「攻击方/防守方觉醒」合并成单一「我方觉醒星级」
          if (o.mineAw == null) {
            const aw = o.direction === 'OwnAttacksTarget' ? o.atkAwakening : o.defAwakening;
            o.mineAw = String(aw ?? '').trim() === '' ? '' : String(aw);
          }
          applyAw(o);
          delete o.atkGrade;
          delete o.defGrade;
        });
        return pg;
      });
      state.activeId = raw.activeId && state.pages.some((p) => p.id === raw.activeId)
        ? raw.activeId : state.pages[0].id;
      if (needMigrate) { state.powerFlatMigrated = true; save(); }
      return;
    }
  } catch (e) { /* 忽略 */ }
  const p = newPage();
  state.pages = [p];
  state.activeId = p.id;
}

// ---------- 分段控件 ----------
// 骰子效果候选：不再手写清单，直接从 DiceEffects 数据里取「所有会改动面板攻/防/威力的骰子」，
// 数据新增词条时这里自动跟上，不会再漏。
function diceBp(d, i) { return Number((d.GradeBasisPoints || [])[i] || 0); }
function diceFlatPower(d) { return Number(d.FixedPower || 0) || 0; }
// 进攻方：物攻[0] / 魔攻[1] 有加成，或直接加威力（巧劲类）
function diceAffectsAttack(d) {
  return diceBp(d, 0) > 0 || diceBp(d, 1) > 0 || diceFlatPower(d) > 0;
}
// 防守方：物防[2] / 魔防[3] 有加成
function diceAffectsDefense(d) {
  return diceBp(d, 2) > 0 || diceBp(d, 3) > 0;
}
function diceIds(field) {
  const all = [...catalog.dice.values()].filter((d) =>
    (field === 'diceAtk' ? diceAffectsAttack(d) : diceAffectsDefense(d)));
  return [0].concat(all.map((d) => d.Id));
}
// 单个骰子的效果摘要（用来显示在按钮上）
function diceShort(d) {
  if (!d) return '无';
  const bp = [0, 1, 2, 3].map((i) => diceBp(d, i));
  const pct = (v) => `${Math.round(v / 100)}%`;
  const f = diceFlatPower(d);
  if (f) {
    const extra = [];
    if (bp[0]) extra.push(`物攻+${pct(bp[0])}`);
    if (bp[1]) extra.push(`魔攻+${pct(bp[1])}`);
    return `威力+${f}${extra.length ? ' ' + extra.join(' ') : ''}`;
  }
  const nonZero = bp.filter((v) => v > 0);
  if (nonZero.length === 4 && bp.every((v) => v === bp[0])) return `全属性+${pct(bp[0])}`;
  const parts = [];
  if (bp[0]) parts.push(`物攻+${pct(bp[0])}`);
  if (bp[1]) parts.push(`魔攻+${pct(bp[1])}`);
  if (bp[2]) parts.push(`物防+${pct(bp[2])}`);
  if (bp[3]) parts.push(`魔防+${pct(bp[3])}`);
  return parts.join(' ');
}
// 骰名以游戏内叫法为准（原数据里的旧名做一次映射，避免和游戏对不上）
const DICE_NAME_FIX = { 3: '强御' };
function diceLabel(id) {
  const num = Number(id);
  if (!num) return '无';
  if (DICE_NAME_FIX[num]) return DICE_NAME_FIX[num];
  const d = catalog.findDice(num);
  return d ? d.Name : `效果 ${num}`;
}

const diceCtx = { field: 'diceAtk', idx: 0 };

function openDiceModal(field, idx) {
  diceCtx.field = field; diceCtx.idx = idx;
  const ids = diceIds(field);
  $('diceModalTitle').textContent = field === 'diceAtk' ? '骰子效果 · 进攻方' : '骰子效果 · 防守方';
  const cur = String(current().observations[idx]?.[field] ?? '0');
  $('diceGrid').innerHTML = ids.map((id) => {
    const d = id ? catalog.findDice(id) : null;
    const label = id ? diceLabel(id) : '无';
    const desc = id === 0 ? '不加成' : (d && d.Description ? d.Description : '');
    return `<button type="button" class="dice-cell ${cur === String(id) ? 'active' : ''}" data-value="${id}">
      <span class="dc-name">${label}</span>
      <span class="dc-desc">${desc}</span>
    </button>`;
  }).join('');
  $('diceModal').hidden = false;
}

function dicePicker(field, value, label) {
  const id = String(value ?? '0');
  const d = Number(id) ? catalog.findDice(Number(id)) : null;
  const nm = diceLabel(id);
  const sh = d ? diceShort(d) : '';
  const txt = Number(id) ? (sh && sh !== nm ? `${nm}（${sh}）` : nm) : '无';
  return `<button type="button" class="dice-pick" data-act="pickDice" data-dfield="${field}">
    <span class="dp-label">${label}</span>
    <span class="dp-value ${Number(id) ? 'is-on' : ''}">${txt}</span>
    <svg class="dp-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>
  </button>`;
}

// 我方觉醒星级：单行，右边一个 0-5 的方形按钮，点击弹出选择框
// 默认空着等填：不继承历史、也不拿旧字段的 0 兜底
function awField(o) {
  const v = String(o.mineAw ?? '').trim();
  const has = v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 5;
  return `<div class="field aw-field aw-one">
      <span class="aw-one-label">我方觉醒星级<em class="aw-tag">精灵五星级后的觉醒等级</em></span>
      <button type="button" class="aw-num ${has ? 'is-on' : ''}" data-act="pickAw" data-field="mineAw">${has ? v : '0-5'}</button>
    </div>`;
}

// 某星级对应的本系 / 极化 / 钝化倍率（与 damage.js 的官方口径一致：1+0.45n，比值截断到 0.6~1.8）
function awakeRates(lv) {
  if (lv === '' || lv === null || lv === undefined) return null;
  const n = Number(lv);
  const up = Math.min(1.8, 1 + 0.45 * n);
  const down = Math.max(0.6, 1 / (1 + 0.45 * n));
  const f = (x) => (Math.round(x * 100) / 100).toFixed(2).replace(/0$/, '');
  return { stab: f(1.25 + 0.15 * n), up: f(up), down: f(down) };
}

const awCtx = { idx: null };

function openAwPickModal(idx) {
  awCtx.idx = idx;
  const o = current().observations[idx];
  const cur = String(o?.mineAw ?? '').trim();
  $('awPickGrid').innerHTML = [0, 1, 2, 3, 4, 5].map((lv) => {
    const r = awakeRates(lv);
    const on = cur !== '' && Number(cur) === lv;
    const capped = lv >= 2;
    const rows = lv === 0
      ? [['未觉醒', 0], ['不加成', 0]]
      : [
          [`本系倍率 ×${r.stab}`, 0],
          [`克制倍率 ×${r.up}`, 0],
          ...(capped ? [['（已封顶）', 1]] : []),
          [`钝化倍率 ×${r.down}`, 0],
          ...(capped ? [['（已封底）', 1]] : []),
        ];
    const sub = rows.map(([t, sm]) => `<span class="aw-line${sm ? ' aw-line-cap' : ''}">${t}</span>`).join('');
    return `<button type="button" class="aw-cell ${on ? 'active' : ''}" data-aw="${lv}">
      <span class="aw-cell-num">${lv}</span>
      <span class="aw-cell-sub">${sub}</span>
    </button>`;
  }).join('');
  $('awPickModal').hidden = false;
}

function closeAwPickModal() {
  $('awPickModal').hidden = true;
  awCtx.idx = null;
}

// 骰子给某项属性带来的倍率（basis points -> Rat）
function diceMult(id, statIdx) {
  const d = id && id !== '0' ? catalog.findDice(Number(id)) : null;
  if (!d || !d.GradeBasisPoints) return new Rat(1n);
  const bp = Number(d.GradeBasisPoints[statIdx] || 0);
  if (!bp) return new Rat(1n);
  return new Rat(BigInt(10000 + bp), 10000n);
}

function segmented(field, options, value) {
  const btns = options.map((o) =>
    `<button type="button" data-seg="${field}" data-value="${o.v}"
      class="${o.v === value ? 'active' : ''}">${o.label}</button>`).join('');
  return `<div class="segmented">${btns}</div>`;
}

// ---------- 目标精灵信息 ----------
function renderSpeciesMeta() {
  const p = current();
  const label = $('speciesLabel');
  const meta = $('speciesMeta');
  if (!p.speciesId) {
    label.textContent = '点击选择精灵';
    label.className = 'sp-placeholder';
    meta.hidden = true;
    return;
  }
  const s = catalog.findSpecies(p.speciesId);
  label.className = '';
  const picSrc = p.isShiny ? shinyPortraitUrl(s.Id, s.Portrait) : portraitUrl(s.Portrait, s.Id);
  label.innerHTML = `${imgTag(picSrc, 'pick-ico', s.Name)}<b>${s.Name}</b> ${s.Form || ''} <span class="species-elems">No.${s.Number}</span>`;
  const badges = s.Elements.map((e) => {
    const ic = elementIconUrl(e);
    return `<span class="elem-badge">${ic ? `<img src="${ic}" class="elem-ico" alt="">` : ''}${ELEMENT_NAMES[e] || e}</span>`;
  }).join('');
  const shinyBtn = speciesSupportsShiny(s)
    ? `<button type="button" class="shiny-toggle ${p.isShiny ? 'shiny-on' : 'shiny-off'}"
        data-act="shiny" role="switch" aria-checked="${p.isShiny}" aria-label="异色" title="异色">
        ${shinyIcon()}<span class="shiny-txt">异色</span></button>`
    : '';
  const races = (s.Race || []).map((r, i) =>
    `<div class="race-cell" data-stat="${i}"><img src="${statIconUrl(i)}" class="stat-ico" alt=""><span class="r-name">${STAT_NAMES[i]}</span><span class="r-val">${r}</span></div>`
  ).join('');
  meta.hidden = false;
  meta.innerHTML = `<div class="elem-row"><div class="elem-badges">${badges}</div>${shinyBtn}</div><div class="race-grid">${races}</div>`;
}

// 观测卡配色跟随目标精灵主系别（双属取第一个）。
// 把该系别 soft/base/deep 写入 CSS 变量；未选精灵时清除，回退到默认主题。
function applyObsTheme() {
  const card = $('obsCard');
  const p = current();
  const sp = p.speciesId ? catalog.findSpecies(p.speciesId) : null;
  if (!sp || !sp.Elements || !sp.Elements.length) {
    card.style.removeProperty('--accent');
    card.style.removeProperty('--accent-soft');
    card.style.removeProperty('--accent-deep');
    return;
  }
  const c = elementColor(sp.Elements[0]);
  card.style.setProperty('--accent', c.base);
  card.style.setProperty('--accent-soft', c.soft);
  card.style.setProperty('--accent-deep', c.deep);
}

// 系别选择弹窗的网格顺序（照搬图二，18 个，无首领；Id 7 不存在）
const ELEMENT_PICK_ORDER = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
let elementModalIdx = null;
let elementModalKind = 'element';   // 'element' = 技能系别（单选）｜'own' = 我方系别（最多两个）

// 打开系别选择弹窗（照搬图二：圆形图标网格）
function openElementModal(idx, kind = 'element') {
  elementModalIdx = idx;
  elementModalKind = kind;
  const o = current().observations[idx];
  const sel = kind === 'own' ? ownElems(o) : [Number(o.element)];
  const title = document.querySelector('.element-modal-title');
  if (title) title.textContent = kind === 'own' ? '我方系别（最多两个）' : '技能系别';
  const grid = ELEMENT_PICK_ORDER.map((id) => `
    <button type="button" class="elem-cell ${sel.includes(id) ? 'selected' : ''}"
      data-element-id="${id}" aria-label="${ELEMENT_NAMES[id]}" aria-pressed="${sel.includes(id)}">
      <span class="elem-badge">
        <img src="${elementPickIconUrl(id) || ''}" alt="${ELEMENT_NAMES[id]}">
      </span>
      <span class="elem-check" aria-hidden="true">✓</span>
    </button>`).join('');
  $('elementGrid').innerHTML = grid;
  $('elementGrid').classList.toggle('has-selection', sel.length > 0);
  $('elementModal').hidden = false;
}

function closeElementModal() {
  $('elementModal').hidden = true;
  elementModalIdx = null;
}

// 椭圆“计算”按钮的可用状态：已选精灵且至少有一条观测时可点击，否则置灰
function updateCalcBtn() {
  const p = current();
  $('calcBtn').disabled = !(p.speciesId && p.observations.length > 0);
}

function renderObservations() {
  const p = current();
  const wrap = $('obsList');
  // 重渲染前先记下哪些「高级修正」是展开的，重渲染后原样还原，避免填数据时被自动收起
  const openStates = [...wrap.querySelectorAll('details.advanced')].map((d) => d.open);
  $('obsEmpty').style.display = p.observations.length ? 'none' : 'block';
  updateCalcBtn();
  wrap.innerHTML = p.observations.map((o, i) => {
    const isHealth = o.direction === 'HealthState';
    // 三种观测方式放在同一个方框内，每项各自一个小方框以示区分
    const modes = [
      { v: 'OwnAttacksTarget', label: '我打它·测防御' },
      { v: 'TargetAttacksOwn', label: '它打我·测攻击' },
      { v: 'HealthState', label: '状态流·测生命' },
    ].map((m) => `<button type="button" class="mode-chip ${o.direction === m.v ? 'active' : ''}"
        data-seg="direction" data-value="${m.v}">${m.label}</button>`).join('');
    return `
    <div class="obs" data-idx="${i}">
      <div class="obs-head">
        <span class="obs-index"><span class="obs-tag"><em>测试数据</em><b>${o.seq || i + 1}</b></span></span>
        <button class="obs-del" data-act="del" data-idx="${i}">删除</button>
      </div>
      <div class="mode-box">${modes}</div>
      ${isHealth ? renderHealthBody(o, p) : renderDamageBody(o)}
    </div>`;
  }).join('');
  wrap.querySelectorAll('details.advanced').forEach((d, i) => { if (openStates[i]) d.open = true; });
}

// 计算单条状态流观测当前反推到的本体生命区间（用于首行实时展示）。
function computeHealthRange(o, isShiny) {
  const { bounds, errors } = observationHealthBounds(o, shinyScale(isShiny));
  if (errors.length) return { kind: 'error', text: errors[0] };
  const inter = intersectHealthBounds(bounds);
  if (!inter) return { kind: 'empty' };
  if (inter.conflict) return { kind: 'conflict', text: `区间互不相交（${inter.min} > ${inter.max}）` };
  return { kind: 'ok', min: inter.min, max: inter.max };
}

// 段数标识：普通龙骑士血条 = 2 个精灵生命，异色 = 3 个
function segTagHtml(isShiny) {
  return `<em class="hp-seg-tag ${isShiny ? 'is-shiny' : ''}">${isShiny ? '异色龙骑士（3 倍）' : '普通龙骑士（2 倍）'}</em>`;
}

// 当前精灵在选定等级下，非生命性格 / 生命性格 的破盾前实战生命（龙骑士血条，异色 3 倍 = 普通 1.5 倍）
function theoryHpPair(page, isShiny) {
  if (!page || !page.speciesId) return null;
  const sp = catalog.findSpecies(page.speciesId);
  if (!sp) return null;
  const lv = Number(page.level);
  if (!Number.isFinite(lv) || lv <= 0) return null; // 等级没填就别按 1 级硬算
  const vals = [...catalog.natures.values()].map((n) => Number(predictEnemy(sp, lv, n, page.hpModel).hp));
  const uniq = [...new Set(vals)].sort((a, b) => a - b);
  let low = uniq[0], mid = uniq.length === 3 ? uniq[1] : null, high = uniq[uniq.length - 1];
  if (isShiny) {
    low = Math.round(low * 1.5); high = Math.round(high * 1.5); // 3段/2段 = 1.5 倍显示血条
    if (mid != null) mid = Math.round(mid * 1.5);
  }
  return { low, mid, high };
}

// 范围条 HTML（renderHealthBody 与局部更新共用）：实测显示值 + 两种生命性格对照值
function hpRangeParts(range, isShiny, page) {
  const tag = segTagHtml(isShiny);
  const pair = theoryHpPair(page, isShiny);
  const natLine = `<div class="hp-natures">
      <span class="hp-nature-label">参考值</span>
      ${pair ? `
        <span class="hp-nature-pill hp-nature-down">−生命 <b>${pair.low}</b></span>
        ${pair.mid != null ? `<span class="hp-nature-pill hp-nature-mid">中性 <b>${pair.mid}</b></span>` : ''}
        <span class="hp-nature-pill hp-nature-up">+生命 <b>${pair.high}</b></span>`
      : `<span class="hp-nature-empty">先填目标精灵等级</span>`}
    </div>`;
  const wrap = (cls, valHtml) => ({
    cls,
    html: `<div class="hp-range-main">
      <span class="hp-range-label">生命值${tag}</span>
      <span class="hp-range-val">${valHtml}</span>
    </div>${natLine}`,
  });
  if (range.kind === 'ok') {
    const v = range.min === range.max ? `${range.min}` : `${range.min} ~ ${range.max}`;
    return wrap('hp-range hp-range-ok', v);
  }
  if (range.kind === 'error' || range.kind === 'conflict') {
    return wrap('hp-range hp-range-bad', range.text);
  }
  return wrap('hp-range', '<span class="hp-range-hint">填写下方数据后<br>显示当前实测值</span>');
}

// 局部刷新某张状态流卡片的范围条（原地更新，不重建输入框，避免失焦）。
function updateHpRange(card, o, isShiny, page) {
  const el = card.querySelector('.hp-range');
  if (!el) return;
  const parts = hpRangeParts(computeHealthRange(o, isShiny), isShiny, page);
  el.className = parts.cls;
  el.innerHTML = parts.html;
}

// 状态流·测生命：首行生命值数值范围，下方严格按图一竖排四字段。
function renderHealthBody(o, page) {
  const isShiny = page.isShiny;
  const parts = hpRangeParts(computeHealthRange(o, isShiny), isShiny, page);
  const rangeBar = `<div class="${parts.cls}">${parts.html}</div>`;
  // 区间与“该精灵三档理论生命”完全不重叠时，直接标出来，别让人以为区间就是答案
  let theoryNote = '';
  const rng = computeHealthRange(o, isShiny);
  const sp = page.speciesId ? catalog.findSpecies(page.speciesId) : null;
  if (sp && rng.kind === 'ok') {
    let vals = [...catalog.natures.values()]
      .map((n) => Number(predictEnemy(sp, page.level, n, page.hpModel).hp));
    vals = [...new Set(vals)].sort((a, b) => a - b);
    if (isShiny) vals = [...new Set(vals.map((v) => Math.round(v * 1.5)))].sort((a, b) => a - b);
    const lo = Number(rng.min), hi = Number(rng.max);
    if (!vals.some((v) => v >= lo && v <= hi)) {
      theoryNote = `<p class="hl-warn">该精灵 ${page.level} 级理论生命只有 ${vals.join(' / ')}，都不在 ${lo}~${hi} 内：这组数据与精灵/等级对不上。</p>`;
    }
  }

  // 图一竖排：标签在左、输入框在右
  const hlRow = (label, inner) =>
    `<div class="hl-row${inner.includes('hl-right') ? ' hl-row-top' : ''}"><span class="hl-label">${label}</span>${inner}</div>`;

  return `
  ${rangeBar}${theoryNote}
  <div class="hl-box">
    <div class="hl-box-tip">下面数据类型填一项即可</div>
    <div class="hl-group">
    ${hlRow('生命值比例<em class="hl-note-sub">回合结束</em>', `
      <span class="hl-inputs">
        <input data-field="hpLoss" type="number" inputmode="numeric" value="${o.hpLoss}" placeholder="累计掉血" class="hl-sub" />
        <span class="hl-pctwrap">
          <input data-field="hpPercent" type="text" inputmode="decimal" value="${o.hpPercent}" placeholder="剩余" />
          <em>%</em>
        </span>
      </span>`)}
    ${hlRow('冻结伤害', `
      <input data-field="hpFreeze" type="number" inputmode="numeric" value="${o.hpFreeze}" placeholder="冻结那一下的伤害值" />`)}
    ${hlRow('强击伤害', `
      <input data-field="hpStrong" type="number" inputmode="numeric" value="${o.hpStrong}" placeholder="强击扣除的生命值" />`)}
    ${hlRow('恶念交换回血', `
      <span class="hl-right">
        <input data-field="hpEvil" type="number" inputmode="numeric" value="${o.hpEvil}" placeholder="按本体生命，90%" />
        <em class="hl-note">在破盾后剩下10%生命时使用</em>
      </span>`)}
    </div>
  </div>`;
}

// 伤害观测（我打它 / 它打我）
function renderDamageBody(o) {
  const oppLabel = o.direction === 'OwnAttacksTarget' ? '我的攻击面板' : '我的防御面板';
  return `
  ${segmented('channel', [
    { v: 'Physical', label: '物理' },
    { v: 'Magic', label: '魔法' },
  ], o.channel)}
  ${(() => {
    const sp = current().speciesId ? catalog.findSpecies(current().speciesId) : null;
    const own = ownElems(o);
    const rel = relOf(o, sp);
    const chips = own.length
      ? own.map((id) => `<span class="own-chip"><img src="${elementIconUrl(id) || ''}" alt="">${ELEMENT_NAMES[id]}<i class="own-dot">✓</i></span>`).join('')
      : '<span class="own-empty">选择我方系别</span>';
    const label = o.direction === 'OwnAttacksTarget' ? '我方系别（攻击方）' : '我方系别（防守方）';
    return `
    <label class="field"><span>${label} · 最多两个，再点一次取消</span>
      <button type="button" class="element-pick-btn own-pick ${own.length ? 'has-sel' : ''}" data-act="pickOwnElems">${chips}${
        own.length ? `<span class="own-count">已选 ${own.length}/2</span>` : ''}</button>
    </label>
    <p class="rel-line ${rel.auto ? '' : 'rel-line-warn'}">${relLineText(o, rel, sp)}</p>`;
  })()}
  <div class="grid-2">
    <label class="field"><span>技能威力</span>
      <input data-field="power" type="number" inputmode="numeric" value="${o.power}" placeholder="如 35" />
    </label>
    <label class="field"><span>技能系别</span>
      <button type="button" class="element-pick-btn" data-act="pickElement">
        <img class="element-pick-ico" src="${elementIconUrl(o.element) || ''}" alt="">
        <span class="element-pick-name">${ELEMENT_NAMES[o.element] || ''}</span>
      </button>
    </label>
  </div>
  <div class="grid-2">
    <label class="field"><span>实际伤害值</span>
      <input data-field="damage" type="number" inputmode="numeric" value="${o.damage}" placeholder="实际掉血" />
    </label>
    <label class="field"><span>${oppLabel}</span>
      <input data-field="opposite" type="number" inputmode="numeric" value="${panelOf(o)}" placeholder="面板数值" />
    </label>
  </div>
  <div class="grid-2 crit-row">
    <label class="field"><span>天气威力倍率</span>
      <input data-field="weatherMult" type="number" step="0.01" value="${o.weatherMult}" />
    </label>
    <label class="crit-cell">
      <input data-field="critical" type="checkbox" ${o.critical ? 'checked' : ''} />
      <span>触发暴击（×2）</span>
    </label>
  </div>
  <details class="advanced">
    <summary>高级修正（骰子 / 觉醒 / 加成）</summary>
    <div class="dice-picks">
      ${dicePicker('diceAtk', o.diceAtk, '进攻方')}
      ${dicePicker('diceDef', o.diceDef, '防守方')}
    </div>
    <p class="dice-note">已收录全部会改面板攻防或威力的骰面（含巧劲 / 强力巧劲）；克制、抵抗、强击、生息这类不改面板的骰子不在这里选。</p>
    ${awField(o)}
    <p class="adv-divider">其他加成</p>
    <div class="grid-3">
      <label class="field"><span>其他攻击力加成（%）</span>
        <input data-field="atkBonus" type="number" inputmode="decimal" value="${o.atkBonus}" placeholder="0" min="-99" />
      </label>
      <label class="field"><span>其他防御力加成（%）</span>
        <input data-field="defBonus" type="number" inputmode="decimal" value="${o.defBonus}" placeholder="0" min="-99" />
      </label>
      <label class="field"><span>技能威力加成（±整数）</span>
        <input data-field="powerBonus" type="text" inputmode="numeric" pattern="[+-]?[0-9]*" value="${o.powerBonus ?? '0'}" placeholder="+20 / -10" />
        <em class="grid-note">攻击方威力加成</em>
      </label>
    </div>
    <p class="dice-note">骰子之外的增减益填这里：攻击/防御 100 表示 ×2；技能威力加成填带符号整数（+20 = 威力 +20 点，-10 = 威力 -10 点），与骰子固定威力一起直接加在技能威力上，不改变面板攻防。</p>
  </details>`;
}

// ---------- 把 UI 观测转成求解器 hit ----------
function buildHit(o, ownLevel, enemyLevel, sp) {
  // 攻击方等级决定伤害公式里的等级系数：我打它=我方等级，它打我=敌方等级
  const level = o.direction === 'OwnAttacksTarget' ? ownLevel : enemyLevel;
  if (o.direction === 'HealthState') return null;
  // 加成 -100% 会让倍率为 0（除零），直接判为无效输入
  const bonusNum = (v) => (String(v ?? '').trim() === '' ? 0 : Number(v));
  if (bonusNum(o.atkBonus) <= -100 || bonusNum(o.defBonus) <= -100) return null; // 状态流不走伤害逆向
  // 技能威力加成改为固定点数（带符号整数），与骰子固定威力一起加在基础威力上
  const pwFlat = signedIntOrNull(o.powerBonus);
  if (pwFlat === null) return null;
  const damage = bigIntOrNull(o.damage);
  const opposite = bigIntOrNull(panelOf(o) || 0);
  const base = bigIntOrNull(o.power);
  if (damage == null || opposite == null || base == null
    || damage <= 0n || opposite <= 0n || base <= 0n) return null;

  const ZERO = new Rat(0n), ONE = new Rat(1n);
  // 克制/本系：优先按「我方系别 + 技能系别 + 目标精灵系别」自动判定，旧数据回退到手填
  const rel = relOf(o, sp);
  const typeFactor = rel.factor;
  const isNative = rel.isNative;
  const stab = isNative ? new Rat(5n, 4n) : ONE;
  const weather = Rat.fromDecimal(o.weatherMult || '1');

  // 百分比加成 -> 倍率：1 + pct/100（100 即 ×2），保留两位小数精度
  const pctToMult = (v) => {
    const n = Math.round(Number(String(v ?? '').trim() === '' ? 0 : v) * 100);
    return new Rat(BigInt(10000 + n), 10000n);
  };
  // 骰子效果：物理看 物攻[0]/物防[2]，魔法看 魔攻[1]/魔防[3]
  const i0 = o.channel === 'Magic' ? 1 : 0;
  const i1 = o.channel === 'Magic' ? 3 : 2;
  const diceRatio = diceMult(o.diceAtk, i0).div(diceMult(o.diceDef, i1));
  const statBonus = pctToMult(o.atkBonus).div(pctToMult(o.defBonus)).mul(diceRatio);
  // 骰子里的固定威力（巧劲 +20 / 强力巧劲 +40）：直接加进技能威力
  const diceFlat = diceFlatPower(catalog.findDice(Number(o.diceAtk)) || {});
  // 固定威力合计（骰子固定威力 + 手动带符号加成），把基础威力减到 0 或以下属于无效输入
  const flatTotal = BigInt(diceFlat + pwFlat);
  if (base + flatTotal <= 0n) return null;

  const atkAw = atkAwOf(o);
  const defAw = defAwOf(o);
  const relation = rel.relation;
  const awakening = (atkAw || defAw)
    ? { attackerLevel: atkAw, defenderLevel: defAw, isNative, relation }
    : null;

  return {
    direction: o.direction,
    channel: o.channel,
    attackerLevel: level,
    damage,
    critical: o.critical,
    damageFraction: ONE,
    finalMult: ONE,
    knownOppositeAttribute: opposite,
    power: {
      kind: 'full',
      skillBase: new Rat(base),
      fixedAddition: new Rat(flatTotal),
      weather,
      statBonus,
      stab,
      typeFactor,
      isNative,
      awakening,
    },
  };
}

// ---------- 求解 ----------
const STATUS_TEXT = {
  Unique: '唯一确定', Multiple: '存在多个可能', Conflict: '冲突', MissingData: '数据不足',
};
const BADGE_ICON = {
  Unique: 'sparkle', Multiple: 'moon', Conflict: 'heart', MissingData: 'scroll',
};

// 性格按“增益面属性”分 6 类，同类同色；高区分度、明亮鲜艳
const NATURE_COLORS = ['#E23A2E', '#E07400', '#D4246B', '#7A3BD6', '#0A9E88', '#2277E0'];

const FIELD_LABELS = {
  power: '技能威力', damage: '实际伤害值', opposite: '面板值',
  hpLoss: '生命值比例·累计掉血', hpPercent: '生命值比例·剩余比例',
  hpFreeze: '冻结伤害', hpStrong: '强击伤害', hpEvil: '恶念交换回血',
  atkBonus: '攻击力加成（%）', defBonus: '防御力加成（%）', powerBonus: '技能威力加成（±整数）',
  atkAwakening: '攻击方觉醒星级', defAwakening: '防御方觉醒星级', weatherMult: '天气威力倍率',
  mineAw: '我方觉醒星级', ownElements: '我方系别', level: '奇遇精灵等级', ownLevel: '我方等级',
};

function isPosNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}
// 正整数（游戏内伤害/威力/面板都是整数；小数会让 BigInt 解析炸掉）
function isPosInteger(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return false;
  return Number(s) > 0;
}
// 安全 BigInt：非法（含小数/非数字）返回 null，不抛异常
function bigIntOrNull(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  return BigInt(s);
}
// 带符号整数（技能威力固定加减）：+20 / -10 / 0 / 20（无符号按正数）；空串按 0；非法返回 null
function signedIntOrNull(v) {
  const s = String(v ?? '').trim();
  if (s === '') return 0;
  if (!/^[+-]?\d+$/.test(s)) return null;
  return Number(s);
}

// 返回该条观测中缺填/非法的字段列表
function validateObservation(o) {
  if (o.direction === 'HealthState') {
    const fields = ['hpLoss', 'hpPercent', 'hpFreeze', 'hpStrong', 'hpEvil'];
    const filled = fields.filter((f) => String(o[f] ?? '').trim() !== '');
    if (!filled.length) return { fields, empty: true };
    return { fields: filled.filter((f) => !isPosNumber(o[f])), empty: false };
  }
  const bad = [];
  if (!ownElems(o).length) bad.push('ownElements');   // 空着会让克制/本系退回「普通·非本系」，静默算错
  if (!isPosInteger(o.power)) bad.push('power');
  if (!isPosInteger(o.damage)) bad.push('damage');
  if (!isPosInteger(panelOf(o))) bad.push('opposite');
  const badBonus = (v) => String(v ?? '').trim() !== '' && (!Number.isFinite(Number(v)) || Number(v) <= -100 || Number(v) > 1000);
  if (badBonus(o.atkBonus)) bad.push('atkBonus');
  if (badBonus(o.defBonus)) bad.push('defBonus');
  const pwFlat = signedIntOrNull(o.powerBonus);
  if (pwFlat === null || Math.abs(pwFlat) > 999) bad.push('powerBonus');
  if (String(o.mineAw ?? '') !== '' && (Number(o.mineAw) < 0 || Number(o.mineAw) > 5 || !Number.isInteger(Number(o.mineAw)))) bad.push('mineAw');
  const wm = String(o.weatherMult ?? '').trim();
  if (wm === '' || !isPosNumber(wm)) bad.push('weatherMult');   // 清空不再默默当 1
  return { fields: bad, empty: false };
}

function clearInvalidMarks() {
  document.querySelectorAll('.obs .invalid, #level.invalid').forEach((el) => el.classList.remove('invalid'));
  document.querySelectorAll('#level').forEach((el) => {
    const wrap = el.closest('.field');
    if (wrap) wrap.classList.remove('invalid');
  });
}

// 奇遇精灵等级必填：不填/非法时返回 true
function enemyLevelMissing(p) {
  const raw = String((p && p.level) ?? '').trim();
  if (raw === '') return true;
  const n = Number(raw);
  return !(Number.isInteger(n) && n > 0 && n <= 100);
}

// 点击“计算”时给缺填/非法项目加深红描边，返回问题清单
function markInvalid() {
  const p = current();
  const issues = [];
  clearInvalidMarks();
  if (enemyLevelMissing(p)) {
    const inp = $('level');
    if (inp) {
      inp.classList.add('invalid');
      const wrap = inp.closest('.field');
      if (wrap) wrap.classList.add('invalid');
    }
    issues.push({ idx: -1, fields: ['level'], empty: true, labels: ['奇遇精灵等级'] });
  }
  const own = String((p.ownLevel ?? '')).trim();
  if (!(Number(own) > 0 && Number(own) <= 100)) {
    const inp = $('ownLevel');
    if (inp) {
      inp.classList.add('invalid');
      const wrap = inp.closest('.field');
      if (wrap) wrap.classList.add('invalid');
    }
    issues.push({ idx: -1, fields: ['ownLevel'], empty: true, labels: ['我方等级'] });
  }
  p.observations.forEach((o, idx) => {
    // 觉醒先校验：对方固定 0，我方必须手填
    if (o.direction !== 'HealthState') {
      const raw = String(o.mineAw ?? '').trim();
      const n = Number(raw);
      const bad = raw === '' || !Number.isInteger(n) || n < 0 || n > 5;
      if (bad) {
        const card = document.querySelector(`.obs[data-idx="${idx}"]`);
        const input = card && card.querySelector('[data-field="mineAw"]');
        if (input) {
          input.classList.add('invalid');
          const wrap = input.closest('.field');
          if (wrap) wrap.classList.add('invalid');
        }
        issues.push({ idx, fields: ['mineAw'], empty: true, needAwaken: true, labels: ['我方觉醒星级'] });
        return;
      }
    }
    const v = validateObservation(o);
    if (!v.fields.length) return;
    const card = document.querySelector(`.obs[data-idx="${idx}"]`);
    if (card) {
      v.fields.forEach((f) => {
        // 我方系别不是 input，是一整块选择按钮
        const sel = f === 'ownElements' ? '[data-act="pickOwnElems"]' : `[data-field="${f}"]`;
        card.querySelectorAll(sel).forEach((el) => {
          el.classList.add('invalid');
          const wrap = el.closest('.field, .own-pick, .hl-inputs, .hl-row');
          if (wrap) wrap.classList.add('invalid');
        });
      });
    }
    issues.push({
      idx, fields: v.fields, empty: v.empty,
      labels: v.fields.map((f) => {
        const base = FIELD_LABELS[f] || f;
        if (f === 'powerBonus') return `${base}需为带符号整数（如 +20 / -10）`;
        return (f === 'atkBonus' || f === 'defBonus') ? `${base}需为有效数字且 > -100` : base;
      }),
    });
  });
  return issues;
}

// 点「计算」时若缺数据：滚到第一处缺失，并把那个输入框聚焦 + 闪一下
function focusFirstIssue(issues) {
  const first = issues && issues[0];
  const isTop = first && first.idx < 0;
  const card = document.querySelector(`.obs[data-idx="${first ? first.idx : 0}"]`);
  const anchor = isTop ? $('level') : card;
  const target = (anchor && anchor.closest('.card')) || card || document.getElementById('pickSpecies') || document.body;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // 只做视觉提示，不聚焦输入框（避免弹出软键盘挡住内容）
  const el = isTop ? $('level') : (card && (card.querySelector('[data-field].invalid') || card.querySelector('.invalid')));
  if (el) {
    setTimeout(() => {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2400);
    }, 420);
  }
  return !!card;
}

function runSolve(p) {
  if (!p.speciesId) return { kind: 'empty', msg: '请先选择目标精灵。' };

  // 伤害观测
  const hits = p.observations.map((o) => {
    const h = buildHit(o, p.ownLevel, p.level, p.speciesId ? catalog.findSpecies(p.speciesId) : null);
    if (h) { h.seq = o.seq; h.damageValue = Number(o.damage); }
    return h;
  }).filter(Boolean);

  // 状态流观测 -> 本体生命区间（四字段统一收集，含输入校验）
  const scale = shinyScale(p.isShiny);
  const healthList = [];
  const healthErrors = [];
  let healthSeq = null;
  for (const o of p.observations) {
    if (o.direction !== 'HealthState') continue;
    if (healthSeq == null) healthSeq = o.seq;
    const { bounds, errors } = observationHealthBounds(o, scale);
    if (errors.length) healthErrors.push(...errors);
    healthList.push(...bounds);
  }
  if (healthErrors.length) return { kind: 'empty', msg: `状态流输入有误：${[...new Set(healthErrors)].join('；')}` };
  const health = intersectHealthBounds(healthList);
  if (health && health.conflict) {
    return { kind: 'empty', msg: `多条状态流反推区间互不相交（${health.min} > ${health.max}），请核对数据。` };
  }

  if (hits.length === 0 && !health) {
    return { kind: 'empty', msg: '请完整填写至少一条观测（伤害观测需威力/伤害/面板值为正；状态流需填写下方任一数据）。' };
  }
  const res = solve({
    species: catalog.findSpecies(p.speciesId),
    level: p.level,
    hpModel: p.hpModel,
    natures: [...catalog.natures.values()],
    hits,
    healthBounds: health,
    hpScale: shinyHpMult(p.isShiny),
    healthSeq,
  });
  return { kind: 'ok', res, health };
}


// 该精灵在当前等级/生命模型下，某属性的理论区间（用于解释冲突）
function predRangeFor(stat) {
  const p = current();
  if (!p.speciesId) return null;
  const sp = catalog.findSpecies(p.speciesId);
  if (!sp) return null;
  const vals = [...catalog.natures.values()]
    .map((n) => predictEnemy(sp, p.level, n, p.hpModel).effective[stat])
    .filter((v) => v != null)
    .map(Number);
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

function recalc(issues) {
  try {
    recalcImpl(issues);
  } catch (err) {
    $('result').innerHTML = `<div class="calc-error">计算出错：${err.message}</div>`;
  }
}

function missingAwaken(p) {
  for (let i = 0; i < p.observations.length; i++) {
    const o = p.observations[i];
    if (o.direction === 'HealthState') continue;
    const raw = String(o.mineAw ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0 || n > 5) return { idx: i, field: 'mineAw' };
  }
  return null;
}

function recalcImpl(issues) {
  const p = current();
  const out = $('result');
  if (enemyLevelMissing(p)) {
    const inp = $('level');
    if (inp) {
      inp.classList.add('invalid');
      const wrap = inp.closest('.field');
      if (wrap) wrap.classList.add('invalid');
    }
    out.innerHTML = '<p class="hint invalid-hint">请补全标红的项目：奇遇精灵等级（1-100，面板与生命都由它决定）</p>';
    return;
  }
  const aw = missingAwaken(p);
  if (aw) {
    const card = document.querySelector(`.obs[data-idx="${aw.idx}"]`);
    const input = card && card.querySelector(`[data-field="${aw.field}"]`);
    if (input) {
      input.classList.add('invalid');
      const wrap = input.closest('.field');
      if (wrap) wrap.classList.add('invalid');
    }
    out.innerHTML = '<p class="hint invalid-hint">请选择我方精灵觉醒星级（0-5），对方奇遇精灵固定 0。</p>';
    return;
  }
  // 有必填项空着就先拦住：不拿空值算出一个「冲突」结论来误导人
  const blocked = issues || [];
  if (blocked.length) {
    out.innerHTML = `<p class="hint invalid-hint">请补全标红的项目：${blocked.map((x) => {
      if (x.idx < 0) return x.labels.join('、');
      const seq = (p.observations[x.idx] && p.observations[x.idx].seq) || x.idx + 1;
      return `测试数据 ${seq}（${x.empty && x.fields.every((f) => ['hpLoss', 'hpPercent', 'hpFreeze', 'hpStrong', 'hpEvil'].includes(f)) ? '四项状态数据都为空' : x.labels.join('、')}）`;
    }).join('；')}</p>`;
    return;
  }
  const r = runSolve(p);
  if (r.kind === 'empty') {
    const extra = (issues && issues.length)
      ? `<p class="hint invalid-hint">请补全标红的项目：${issues.map((x) =>
        `测试数据 ${(p.observations[x.idx] && p.observations[x.idx].seq) || x.idx + 1}（${x.empty ? '四项状态数据都为空' : x.labels.join('、')}）`).join('；')}</p>`
      : '';
    out.innerHTML = `<p class="hint">${r.msg}</p>${extra}`;
    return;
  }
  const res = r.res;
  // 性格胶囊按“增益面属性”分 6 色，同类同色；点开显示增益面/减益面
  const chips = res.candidates
    .map((c) => {
      const up = c.nature.Increased;
      const color = NATURE_COLORS[up] || '#B5762B';
      return `<button type="button" class="nature-chip" data-nid="${c.nature.Id}" style="--nc:${color}">${c.nature.Name}</button>`;
    }).join('');
  const rows = res.attributes.map((a) => {
    // 生命行按实战显示血量展示（异色 3 段 = 普通的 1.5 倍）
    const shownVals = (a.stat === 0 && p.isShiny)
      ? a.values.map((v) => String(Math.round(Number(v) * 1.5)))
      : a.values.map(String);
    // 没有候选性格时，把这条观测自己的区间亮出来，别显示成 “—”
    let extra = '';
    if (!shownVals.length) {
      if (a.stat === 0 && r.health) extra = `观测 ${r.health.min}~${r.health.max}`;
      else {
        const c = res.constraints && res.constraints.get(a.stat);
        if (c && c.integers) extra = `观测 ${c.integers.min}~${c.integers.max}`;
      }
    }
    const vals = shownVals.length ? shownVals.join(' / ') : (extra || '—');
    return `<tr><td>${STAT_NAMES[a.stat]}</td>
      <td><span class="pill ${a.status}">${STATUS_TEXT[a.status]}</span></td>
      <td>${vals}</td></tr>`;
  }).join('');
  // 被排除的性格按“原因”归并，避免同一句理由重复刷满整块
  const groups = [];
  for (const x of res.rejected) {
    const key = x.reasons.join('；');
    const g = groups.find((v) => v.key === key);
    if (g) g.names.push(x.nature.Name); else groups.push({ key, names: [x.nature.Name] });
  }
  let diag = '';
  const hpOnly = res.rejected.length > 0 && res.rejected.every((x) =>
    x.reasons.length === 1 && /^生命预测值 (\d+) 不在状态流区间/.test(x.reasons[0]));
  if (hpOnly) {
    // 全部性格只因生命值不符被排除：合并成一行，列出全部理论值，别再一人一行刷屏
    const hv = [...new Set(res.rejected.map((x) => x.reasons[0].match(/^生命预测值 (\d+)/)[1]))]
      .sort((a, b) => Number(a) - Number(b));
    const rng = res.rejected[0].reasons[0].match(/区间 (\d+)~(\d+)/);
    diag = `<li>另有 ${res.rejected.length} 个性情因生命值不符被排除（理论 ${hv.join(' / ')}，反推 ${
      rng ? `${rng[1]}~${rng[2]}` : '区间'}）</li>`;
  } else {
    diag = groups.slice(0, 3).map((g) => (g.names.length === 1
      ? `<li>${g.names[0]}：${g.key}</li>`
      : `<li>共 ${g.names.length} 个性格被同一原因排除：${g.key}</li>`)).join('');
  }
  // 多组观测各自都能对上、合起来却没有共同性格：直接点名是哪两组在打架，别让人以为是精灵算错了
  let crossNote = '';
  if (res.crossConflict && res.obsGroups && res.obsGroups.length >= 2) {
    const sp = catalog.findSpecies(p.speciesId);
    const natByName = new Map([...catalog.natures.values()].map((n) => [n.Name, n]));
    const DIR_TEXT = { OwnAttacksTarget: '我打它·测防御', TargetAttacksOwn: '它打我·测攻击', HealthState: '状态流·测生命' };
    const gLabel = (g) => `第${g.seq != null ? g.seq : '?'}组（${DIR_TEXT[g.direction] || '伤害观测'}${g.min != null ? `，观测 ${g.min}~${g.max}` : ''}）`;
    const predSet = (names, stat) => [...new Set(names.map((nm) => {
      const n = natByName.get(nm);
      const v = n ? predictEnemy(sp, p.level, n, p.hpModel).effective[stat] : null;
      return v == null ? null : Number(v);
    }).filter((v) => v != null))].sort((a, b) => a - b);
    // 找一组「互不相容」的对照：A 的性格算出来的 B 属性，和 B 的观测区间完全不搭
    let pairText = '';
    for (let i = 0; i < res.obsGroups.length && !pairText; i++) {
      for (let j = 0; j < res.obsGroups.length; j++) {
        if (i === j) continue;
        const A = res.obsGroups[i], B = res.obsGroups[j];
        if (A.stat == null || B.stat == null) continue;
        if (A.stat === B.stat) continue;
        const vals = predSet(A.allowed, B.stat);
        if (!vals.length) continue;
        const lo = Number(B.min), hi = Number(B.max);
        if (vals.some((v) => v >= lo && v <= hi)) continue; // 这一对其实兼容，换下一对
        // A 的性格 → B 属性应该是什么；再换算 B 那组的伤害/掉血
        if (B.direction === 'HealthState') {
          const obsB = p.observations.find((x) => x.seq === B.seq && x.direction === 'HealthState') || {};
          const pct = String(obsB.hpPercent || '').trim();
          const extra = /^\d+$/.test(pct)
            ? `（掉血该是 ${vals.map((v) => `${v - Math.round(v * Number(pct) / 100)}`).join(' / ')}、剩 ${pct}%）`
            : '';
          pairText = `<p>按第${A.seq}组那几个性格，生命是 <b>${vals.join(' / ')}</b>${extra}，而你第${B.seq}组反推出来的是 ${B.min}~${B.max}。</p>`;
        } else {
          const obsB = p.observations.find((x) => x.seq === B.seq && Number(x.damage) > 0) || {};
          const dmg = Number(obsB.damage);
          const attrMid = (lo + hi) / 2;
          const extra = dmg > 0
            ? `（这一击该打约 ${Math.round(dmg * vals[0] / attrMid)} 点，不是 ${dmg} 点）`
            : '';
          pairText = `<p>按第${A.seq}组那几个性格，${STAT_NAMES[B.stat]}只有 <b>${vals.join(' / ')}</b>${extra}，而你第${B.seq}组反推出来的是 ${B.min}~${B.max}。</p>`;
        }
        break;
      }
    }
    const lines = res.obsGroups.map((g) => {
      const vals = g.stat != null ? predSet(g.allowed, g.stat) : [];
      const names = g.allowed.length <= 6
        ? g.allowed.join('、')
        : `${g.allowed.slice(0, 4).join('、')} 等 ${g.allowed.length} 个`;
      return `<p>${gLabel(g)}单独看：只允许 <b>${names}</b>${vals.length === 1 ? `（这一档的${STAT_NAMES[g.stat]}都是 ${vals[0]}）` : ''}</p>`;
    }).join('');
    crossNote = `<div class="health-note">
      <b class="hn-title">${res.obsGroups.length} 组测试数据互相矛盾</b>
      ${lines}
      ${pairText}
      <p>这几组没有任何共同性格 —— 不是这只精灵算不出来，而是<b>其中至少一组数值记错了</b>。先按下面每条单独核对：状态流的「累计掉血」有没有填成当前剩余生命、伤害那组的威力/伤害是不是同一击、觉醒星级填的是攻方还是守方。改对或删掉错的那组，剩下那组马上恢复正常。</p>
    </div>`;
  }

  // 状态流反推与理论生命差距过大时，给出针对性的排查提示
  let healthNote = '';
  // 只有「状态流这一组自己就一个性格都对不上」时，才说它跟理论生命冲突；
  // 生命区间其实容得下 374、是别的属性在打架时，别冤枉状态流
  const healthGroup = (res.obsGroups || []).find((g) => g.direction === 'HealthState');
  const hpBad = healthGroup ? healthGroup.allowed.length === 0 : true;
  if (!res.crossConflict && res.natureStatus === 'Conflict' && r.health && hpBad) {
    const sp = catalog.findSpecies(p.speciesId);
    const vals = [...catalog.natures.values()]
      .map((n) => Number(predictEnemy(sp, p.level, n, p.hpModel).hp));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (p.isShiny) { lo = Math.round(lo * 1.5); hi = Math.round(hi * 1.5); }
    const tooSmall = r.health.max < lo;
    // 反查：这个冻结数值最像多少级的同种精灵——多半是「等级·敌方」填错了
    let implied = '';
    const mid = Math.round((Number(r.health.min) + Number(r.health.max)) / 2);
    let best = null;
    const raceHp = Number(sp.Race[0]);
    for (let L = 1; L <= 100; L++) {
      const rawBase = Math.round((raceHp / 50) * (L + 25));
      let hp = 2 * (rawBase + L + 10 + 22);
      if (p.isShiny) hp = Math.round(hp * 1.5);
      const d = Math.abs(hp - mid);
      if (!best || d < best.d) best = { L, hp, d };
    }
    // 只在「冻结伤害」这种精确输入下反查等级；比例读整误差大，容易误判
    const hasFreeze = String((p.observations.find((x) => String(x.hpFreeze || '').trim()) || {}).hpFreeze || '').trim() !== '';
    if (hasFreeze && best && best.d <= 8 && Math.abs(best.L - p.level) >= 2) {
      implied = `<p>这条数值反推的生命 <b>${mid}</b>，更像 <b>${best.L} 级</b>的${sp.Name}（中性性格约 ${best.hp}）：请核对“等级 · 敌方”是否填错。</p>`;
    }

    // 比例分支：给出「各候选生命值分别对应多少剩余比例」，把整数读数的误差讲清楚
    let percentHint = '';
    const lossTxt = String((p.observations.find((x) => String(x.hpLoss || '').trim()) || {}).hpLoss || '').trim();
    if (/^\d+$/.test(lossTxt)) {
      const lossN = Number(lossTxt);
      const uniq = [...new Set(vals)].sort((a, b) => a - b);
      const rows = uniq.map((hp) => `<b>${Math.round((1 - lossN / hp) * 1000) / 10}%</b> → ${hp}`).join('　');
      const halfWidth = Math.max(1, Math.round((Number(r.health.max) - Number(r.health.min)) / 2));
      percentHint = `<p>按累计掉血 ${lossN} 推算，各候选对应的剩余比例是：${rows}。游戏里比例按整数显示，±1% 的读整误差在这只精灵上约等于 ±${halfWidth} 点血；想一次定死，优先填“冻结伤害”这种一位不差的数值。</p>`;
    }

    healthNote = `<div class="health-note">
      <b class="hn-title">状态流反推对不上理论生命</b>
      <p>反推显示生命 ${r.health.min}~${r.health.max}，该精灵理论生命 ${lo}~${hi}。${
        tooSmall ? `反推值比该精灵实战最小生命还小，说明这个数字不是“100% 冻结”那一下的伤害。` : ''}</p>
      <p>冻结伤害按<b>实战里冻结条攒满 100% 时那一下的伤害</b>填，它等于该精灵的实战总生命值（本等级下应在 ${lo}~${hi} 之间）。如果填的是被护盾吃掉一部分后的数字、或冻结中断的扣血，反推就会偏小。</p>
      ${implied}
      ${percentHint}
    </div>`;
  }

  // 用于冲突解释：把这条观测的乘数摊开
  function formulaLine(stat) {
    const o = p.observations.find((x) => x.direction === 'OwnAttacksTarget' && Number(x.damage) > 0 && Number(x.power) > 0) || null;
    if (!o || o.direction !== 'OwnAttacksTarget') return '';
    const num = (v) => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
    const sp0 = p.speciesId ? catalog.findSpecies(p.speciesId) : null;
    const rel0 = relOf(o, sp0);
    const pw = num(o.power);
    const typeM = rel0.factor.toNumber();
    const atkM = 1 + num(o.atkBonus) / 100;
    const defM = 1 + num(o.defBonus) / 100;
    const pwFlat = signedIntOrNull(o.powerBonus) ?? 0;
    const wm = num(o.weatherMult) || 1;
    const rel = rel0.relation;
    const awLv = atkAwOf(o);
    const awDef = defAwOf(o);
    const aw = ((awLv || awDef) && rel !== 'Neutral')
      ? awakeningFactor({ attackerLevel: awLv, defenderLevel: awDef, relation: rel }).toNumber() : 1;
    const stab = !rel0.isNative ? 1 : ((awLv || awDef) ? stabFactor(true, awLv).toNumber() : 1.25);
    const lf = levelFactor(p.ownLevel).toNumber();
    const diceAtkM = diceMult(Number(o.diceAtk), 0).toNumber();
    const diceDefM = diceMult(Number(o.diceDef), 2).toNumber();
    const critM = o.critical ? 2 : 1;
    const base = (pw + pwFlat + diceFlatPower(catalog.findDice(Number(o.diceAtk)) || {})) * typeM * stab * wm * aw * lf;
    const panel = num(panelOf(o));
    const dmg = num(o.damage);
    if (!dmg) return '';
    const upM = (atkM * diceAtkM * critM) / (defM * diceDefM);
    return `本条乘数：威力 ${pw}${pwFlat ? ` + 威力加成 ${pwFlat}` : ''} × 系别 ${typeM} × 本系 ${stab.toFixed(2)} × 天气 ${wm} × 觉醒 ${aw.toFixed(2)} × 等级系数 ${lf.toFixed(3)} ≈ 有效威力 ${base.toFixed(1)}；攻击侧 攻击加成 ${atkM} × 骰子 ${diceAtkM} × 暴击 ${critM} ÷ 防守侧 ${(defM * diceDefM).toFixed(2)} = ${upM.toFixed(2)}；敌方${STAT_NAMES[stat]} ≈ 面板 ${panel} × ${upM.toFixed(2)} × ${base.toFixed(1)} ÷ 伤害 ${dmg} = <b>${(panel * upM * base / dmg).toFixed(1)}</b>`;
  }

  let emptyNote = '';
  if (res.emptyStats && res.emptyStats.length) {
    const x = res.emptyStats[0];
    const pr = predRangeFor(x.stat);
    const sp = catalog.findSpecies(p.speciesId);
    const nm = sp ? sp.Name : '该精灵';
    const cmp = pr
      ? `而 ${p.level} 级${nm}的${STAT_NAMES[x.stat]}应为 ${pr.min}~${pr.max}（随性格），相差约 ${(pr.min / ((x.lower + x.upper) / 2)).toFixed(1)} 倍`
      : '';
    emptyNote = `<div class="health-note">
      <b class="hn-title">这组数据和这只精灵对不上</b>
      <p>按当前等级/威力/面板/倍率，反推出的${STAT_NAMES[x.stat]}只能是 ${x.lower.toFixed(1)}~${x.upper.toFixed(1)}（还取不到整数）；${cmp}。</p>
      <p class="hn-formula">${formulaLine(x.stat)}</p>
      <p>差这么多，说明这一击不是这只精灵打出来的。常见原因：<b>敌方等级 / 我方等级填错</b>（敌方等级定面板，我方等级定伤害系数）、面板不是这一击的实际值、威力或伤害记错、暴击/克制/本系漏勾。</p>
    </div>`;
  }

  // 伤害观测与面板对不上时，给出人话解释（反推值 vs 该精灵应有的范围）
  let statNote = '';
  // 只解释真正对不上的那一组观测；别因为别的属性打架就把这条也判成「精灵打不出来」
  const badStatGroup = (res.obsGroups || []).find((g) => g.stat != null && g.stat !== 0 && g.allowed.length === 0);
  const statEntry = badStatGroup
    ? (res.conflictStats.find((x) => Number(x.stat) === Number(badStatGroup.stat)) || null)
    : ((res.obsGroups && res.obsGroups.length) ? null : (res.conflictStats || [])[0]);
  if (!res.crossConflict && !emptyNote && statEntry) {
    const c = statEntry;
    const sp = catalog.findSpecies(p.speciesId);
    const nm = sp ? sp.Name : '该精灵';
    const rng = c.min === c.max ? c.min : `${c.min}~${c.max}`;
    // 反查：是不是「本系技能」勾错了
    let stabHint = '';
    const lo = c.min === '' ? NaN : Number(c.min);
    const hi = c.max === '' ? NaN : Number(c.max);
    // 反推物防/魔防来自「我打它」，反推物攻/魔攻来自「它打我」：解释只认对应方向那一条
    const isDefStat = Number(c.stat) >= 3;
    const pickDir = (d) => p.observations.find((x) => x.direction === d && Number(x.damage) > 0 && Number(x.power) > 0);
    const cObs = isDefStat
      ? (pickDir('OwnAttacksTarget') || pickDir('TargetAttacksOwn'))
      : (pickDir('TargetAttacksOwn') || pickDir('OwnAttacksTarget'));
    const cRel = cObs ? relOf(cObs, sp) : null;
    if (cObs && cRel.isNative && Number.isFinite(lo) && Number.isFinite(hi)) {
      const noStab = [lo * 1.25, hi * 1.25];
      if (noStab[0] >= Number(c.predMin) && noStab[1] <= Number(c.predMax)) {
        stabHint = `<p>按<b>“这一击不是本系技能”</b>（不加 ×1.25）重算，反推的${STAT_NAMES[c.stat]}约为 ${noStab[0].toFixed(0)}~${noStab[1].toFixed(0)}，正好落在这只精灵 ${c.predMin}~${c.predMax} 的范围内——这一击很可能<b>不是本系技能</b>（你勾了 ×1.25，反推值被压低了 1/4）。</p>`;
      }
    }
    // 反查：如果只有「我的防御面板」填错，哪些性格能对上、该填多少
    let oppHint = '';
    if (cObs && cObs.direction === 'TargetAttacksOwn' && sp) {
      const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
      const pw = num(cObs.power), dmg = num(cObs.damage), opp = num(panelOf(cObs));
      const typeM = cRel.factor.toNumber();
      const stab = cRel.isNative ? 1.25 : 1;
      const wm = num(cObs.weatherMult) || 1;
      const atkM = 1 + num(cObs.atkBonus) / 100;
      const lf = levelFactor(p.level).toNumber();
      if (pw > 0 && dmg > 0 && opp > 0) {
        const base = pw * typeM * stab * wm * atkM * lf;
        const hitsByDef = [];
        for (const n of catalog.natures.values()) {
          const atk = predictEnemy(sp, p.level, n, p.hpModel).effective[c.stat];
          if (atk == null) continue;
          const defReq = Math.round(Number(atk) * base / dmg);
          if (Math.abs(defReq - opp) <= 4 && Math.abs(defReq - opp) >= 1) hitsByDef.push({ name: n.Name, defReq });
        }
        if (hitsByDef.length) {
          hitsByDef.sort((a, b) => Math.abs(a.defReq - opp) - Math.abs(b.defReq - opp));
          const nearestReq = hitsByDef[0].defReq;
          const sameReq = hitsByDef.filter((x) => x.defReq === nearestReq);
          const reqs = [...new Set(hitsByDef.map((x) => x.defReq))].sort((a, b) => Math.abs(a - opp) - Math.abs(b - opp));
          oppHint = `<p>如果其他项都填对了，那多半是<b>“我的防御面板”</b>填错：按你现在填的 ${opp}，这一击反推不出任何性格；改成 <b>${nearestReq}</b> 的话，就能对上 ${
            sameReq.slice(0, 6).map((x) => x.name).join('、')}${
            sameReq.length > 6 ? ` 等 ${sameReq.length} 个性格` : ''}（这一档共 ${sameReq.length} 个）。${
            reqs.length > 1 ? `另有 ${reqs.slice(1, 3).join(' / ')} 等取值对应别的性格。` : ''}</p>`;
        }
      }
    }

    // 反查：是不是「觉醒钝化」这一项不该生效（把反推区间按觉醒系数还原）
    let awHint = '';
    if (cObs && Number.isFinite(lo) && Number.isFinite(hi)) {
      const rel = cRel.relation;
      const awLv = atkAwOf(cObs);
      const awDef = defAwOf(cObs);
      const aw = ((awLv || awDef) && rel !== 'Neutral')
        ? awakeningFactor({ attackerLevel: awLv, defenderLevel: awDef, relation: rel }).toNumber() : 1;
      if (aw < 1) {
        const lo2 = lo * aw, hi2 = hi * aw;
        if (lo2 <= Number(c.predMax) && hi2 >= Number(c.predMin)) {
          // 按「不吃钝化」再筛一遍，直接给能对上的性格，别只丢一句提示
          const nat = [...catalog.natures.values()].filter((n) => {
            const v = predictEnemy(sp, p.level, n, p.hpModel).effective[c.stat];
            return v != null && Number(v) >= lo2 && Number(v) <= hi2;
          });
          awHint = `<p>把<b>「防守方觉醒」清零</b>（按这一击不吃钝化）重新反推，${STAT_NAMES[c.stat]}是 <b>${lo2.toFixed(0)}~${hi2.toFixed(0)}</b>${
            nat.length ? `，能对上 ${nat.slice(0, 6).map((n) => n.Name).join('、')}${nat.length > 6 ? ` 等 ${nat.length} 个` : ''}` : ''
          } —— 说明这一击很可能<b>没吃到 ${awDef} 星钝化</b>，或星级填反了（钝化要填在挨打的那一方）。</p>`;
        }
      }
    }

    // 口径分支：本系是否被觉醒重复强化、暴击是不是 ×2 —— 同一组数字换口径各推一次
    let branchHint = '';
    if (cObs && Number(c.stat) >= 3 && Number.isFinite(lo) && Number.isFinite(hi)) {
      const relB = cRel.relation;
      const awLvB = atkAwOf(cObs);
      const awDefB = defAwOf(cObs);
      const stabUsed = !cRel.isNative ? 1 : ((awLvB || awDefB) ? stabFactor(true, awLvB).toNumber() : 1.25);
      const critOn = !!cObs.critical;
      const pmin = Number(c.predMin), pmax = Number(c.predMax);
      if ((stabUsed !== 1.25 || critOn) && Number.isFinite(pmin) && Number.isFinite(pmax)) {
        const f1 = 1.25 / stabUsed;
        const f2 = critOn ? 0.75 : 1;
        const rows = [];
        if (stabUsed !== 1.25) rows.push({ label: '本系不随觉醒提升（仍是 ×1.25）', v: [lo * f1, hi * f1] });
        if (critOn) rows.push({ label: '暴击按 ×1.5 算', v: [lo * f2, hi * f2] });
        if (critOn && stabUsed !== 1.25) rows.push({ label: '两条都按低（本系 ×1.25 + 暴击 ×1.5）', v: [lo * f1 * f2, hi * f1 * f2] });
        const hit = rows.filter((r) => r.v[0] <= pmax + 2 && r.v[1] >= pmin - 2);
        branchHint = `<p><b>同一组数字换个口径再推一遍</b>：${
          rows.map((r) => `${r.label} → <b>${r.v[0].toFixed(0)}~${r.v[1].toFixed(0)}</b>`).join('；')
        }。${
          hit.length
            ? `其中「${hit[0].label}」基本落在这只精灵 ${c.predMin}~${c.predMax} 的范围里——说明这一击的加成口径和 App 默认不一样，按这一条就是对的。`
            : `这几条都还差得远，说明问题不在本系/暴击口径，而是威力、伤害或攻防面板本身有一个数字记错了。`
        }</p>`;
      }
    }

    statNote = `<div class="health-note">
      <b class="hn-title">这条观测和这只精灵对不上</b>
      <p>按你填的数值，反推出的敌方${STAT_NAMES[c.stat]}只能是 ${rng}；而 ${p.level} 级${nm}的${STAT_NAMES[c.stat]}应该是 ${c.predMin}~${c.predMax}（随性格）。</p>
      <p>两者差得太多，说明这一击不是这只精灵打出来的。最常见原因：<b>敌方等级或我方等级填错</b>（等级差几级，伤害系数就差几个百分点到几十个百分点）、攻击面板不是这一击的实际值、威力或伤害记错、暴击 / 克制 / 本系漏勾。</p>
      ${stabHint}
      ${awHint}
      ${branchHint}
      ${oppHint}
      <p class="hn-formula">${formulaLine(c.stat)}</p>
    </div>`;
  }

  // 严格无解：给出「最接近」的三个性格，避免第二组数据一填就只剩冲突
  let nearNote = '';
  if (res.natureStatus === 'Conflict' && res.nearest && res.nearest.length) {
    const items = res.nearest.map((x) => {
      const pct = Math.round(x.score * 1000) / 10;
      const color = NATURE_COLORS[x.nature.Increased] || '#B5762B';
      return `<span class="near-chip" style="--nc:${color}">${x.nature.Name}<i>偏差 ${pct}%</i></span>`;
    }).join('');
    nearNote = `<div class="near-box">
      <b class="near-title">严格匹配无解 · 最接近的三个性格</b>
      <div class="near-chips">${items}</div>
      <p>它们的预测值与你填的数据差得最少，但仍有偏差，<b>不能当作结论</b>。${
        res.crossConflict
          ? '先按上面提示改对（或删掉）其中一组数据，剩下的那组会立刻给出干净结果。'
          : '先核对：敌方等级、我方等级、我的防御面板、威力、本系 / 克制 / 暴击是否勾对。若这些都对得上，那就是这组观测里至少有一条不是这只精灵打出来的。'
      }</p>
    </div>`;
  }

  out.innerHTML = `
    <span class="badge ${res.natureStatus}">${icon(BADGE_ICON[res.natureStatus])}${STATUS_TEXT[res.natureStatus]}</span>
    ${res.candidates.length ? `<div class="nature-chips">${chips}</div>
      <div class="nature-detail" hidden></div>` : ''}
    ${crossNote}
    ${emptyNote}
    ${statNote}
    ${healthNote}
    ${nearNote}
    <table class="stat-table">
      <tr><th>属性</th><th>状态</th><th>推断值</th></tr>
      ${rows}
    </table>
    ${diag ? `<ul class="diag">${diag}</ul>` : ''}`;
}

// ---------- 底部页面栏 ----------
function renderTabs() {
  const scroller = $('tabScroller');
  scroller.innerHTML = state.pages.map((p, i) => {
    const name = pageDisplayName(p, i);
    const r = runSolve(p);
    const dot = r.kind === 'ok' && r.res.natureStatus === 'Unique' ? '<i class="dot"></i>' : '';
    return `<button class="tab ${p.id === state.activeId ? 'active' : ''}" data-page="${p.id}">
      ${dot}<span>${name}</span></button>`;
  }).join('');
  // 让激活项滚动到可见
  const activeEl = scroller.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function renderPage() {
  const p = current();
  $('level').value = p.level;
  $('ownLevel').value = p.ownLevel;
  $('hpModel').value = p.hpModel;
  renderSpeciesMeta();
  applyObsTheme();
  renderObservations();
  recalc();
  renderTabs();
}

// ---------- 精灵选择弹窗 ----------
function renderSpeciesList(filter = '') {
  const q = filter.trim().toLowerCase();
  const list = [...catalog.species.values()]
    .filter((s) => !q || s.Name.toLowerCase().includes(q) || String(s.Number) === q);
  $('speciesResults').innerHTML = list.map((s) => {
    const elemHtml = s.Elements.map((e) => {
      const u = elementIconUrl(e);
      return u ? `<img src="${u}" class="row-elem-ico" alt="${ELEMENT_NAMES[e] || e}">` : (ELEMENT_NAMES[e] || e);
    }).join('');
    return `<div class="species-row" data-id="${s.Id}">
      ${imgTag(portraitUrl(s.Portrait, s.Id), 'row-avatar', s.Name)}
      <span class="row-main"><b>${s.Name}</b> ${s.Form ? s.Form : ''} <span class="row-elems">${elemHtml}</span></span>
      <span class="num">No.${s.Number}</span>
    </div>`;
  }).join('') || '<p class="hint">无匹配结果</p>';
}

// ---------- 页面管理弹窗 ----------
let managingId = null;
function openPageModal(id) {
  managingId = id;
  const p = state.pages.find((x) => x.id === id);
  const idx = state.pages.indexOf(p);
  $('pageNameInput').value = p.name || pageDisplayName(p, idx);
  $('pageModal').hidden = false;
}

// ---------- 事件 ----------
function bind() {
  // 新增观测（必须先选择目标精灵）
  $('addObs').onclick = () => {
    const p = current();
    if (!p.speciesId) {
      $('needSpeciesModal').hidden = false;
      return;
    }
    // 命名规则：新编号 = 现有最大编号 + 1（删掉中间或末尾的，都用「剩下的最大号+1」）
    const seq = p.observations.reduce((m, x) => Math.max(m, Number(x.seq) || 0), 0) + 1;
    p.obsSeq = Math.max(Number(p.obsSeq) || 0, seq);
    const o = newObservation(seq);
    const last = p.observations[p.observations.length - 1];
    // 我方系别：跨「测攻击 / 测防御」通用，默认继承最近一条填过的
    for (let i = p.observations.length - 1; i >= 0; i--) {
      const oe = ownElems(p.observations[i]);
      if (oe.length) { o.ownElements = oe.slice(); break; }
    }
    if (last) {
      // 新的一条恒为「我打它·测防御」（= 卡片上第一个选项），不跟上一条交替
      o.direction = 'OwnAttacksTarget';
      // 同类型最近一条的记忆：骰子（进攻方/防守方各自）+ 我方觉醒 + 其他攻/防/威力加成
      const memObs = latestOfDirection(p, o.direction, -1);
      if (memObs) {
        // 骰子按方向独立记忆：测攻击 只看「我打它」那几条，测防御 只看「它打我」那几条
        o.diceAtk = memObs.diceAtk;
        o.diceDef = memObs.diceDef;
      }
      // 觉醒星级默认空（首次使用就是空框），之后按全页记忆继承，测攻击/测防御通用
      o.mineAw = awakeMemoryOf(p, -1);
      applyAw(o);
      // 面板值按类型各自继承：测攻击记「我方防御面板」、测防御记「我方攻击面板」
      const memAtk = latestOfDirection(p, 'OwnAttacksTarget', -1);
      const memDef = latestOfDirection(p, 'TargetAttacksOwn', -1);
      o.panelOwnAtk = String(memAtk && memAtk.panelOwnAtk != null ? memAtk.panelOwnAtk : '');
      o.panelOwnDef = String(memDef && memDef.panelOwnDef != null ? memDef.panelOwnDef : '');
      if (memObs) {
        o.atkBonus = memObs.atkBonus == null ? '0' : String(memObs.atkBonus);
        o.defBonus = memObs.defBonus == null ? '0' : String(memObs.defBonus);
        o.powerBonus = memObs.powerBonus == null ? '0' : String(memObs.powerBonus);
      }
    }
    p.observations.push(o);
    save(); renderObservations(); recalc();
  };
  $('needSpeciesOk').onclick = () => { $('needSpeciesModal').hidden = true; };

  // 骰子效果选择弹窗
  $('diceClose').onclick = () => { $('diceModal').hidden = true; };
  $('diceModal').addEventListener('click', (e) => {
    if (e.target === $('diceModal')) { $('diceModal').hidden = true; return; }
    const cell = e.target.closest('.dice-cell');
    if (!cell) return;
    const p = current();
    const o = p.observations[diceCtx.idx];
    if (!o) return;
    o[diceCtx.field] = cell.dataset.value;
    save(); renderObservations(); recalc();
    $('diceModal').hidden = true;
  });

  // 我方觉醒星级选择弹窗
  $('awPickClose').onclick = closeAwPickModal;
  $('awPickModal').addEventListener('click', (e) => {
    if (e.target === $('awPickModal')) { closeAwPickModal(); return; }
    const cell = e.target.closest('.aw-cell');
    if (!cell || awCtx.idx == null) return;
    const o = current().observations[awCtx.idx];
    if (!o) return;
    o.mineAw = cell.dataset.aw;
    applyAw(o);
    save(); closeAwPickModal(); renderObservations(); recalc();
  });

  // （觉醒星级改为弹窗选择，不再需要输入即校验的监听）

  // 椭圆“计算”按钮：点击手动刷新求解结果（自动计算仍保留）
  $('calcBtn').onclick = () => {
    const issues = markInvalid();
    recalc(issues);
    if (issues.length) focusFirstIssue(issues);
    else {
      const txt = $('result').innerText || '';
      if (!current().speciesId) { const sb = document.getElementById('pickSpecies'); if (sb) sb.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      else if (/请完整填写|请补全|请先填写/.test(txt)) {
        const card = document.querySelector('.obs');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    if (issues.some((x) => x.needAwaken)) $('awakenModal').hidden = false;
  };

  // 觉醒弹窗关闭
  $('awakenOk').onclick = () => { $('awakenModal').hidden = true; };
  $('awakenModal').addEventListener('click', (e) => { if (e.target === $('awakenModal')) $('awakenModal').hidden = true; });

  // 性格胶囊：点开/收起该性格的增益面与减益面
  $('result').addEventListener('click', (e) => {
    const chip = e.target.closest('.nature-chip');
    if (!chip) return;
    const box = $('result').querySelector('.nature-detail');
    if (!box) return;
    const nature = catalog.findNature(Number(chip.dataset.nid));
    if (!nature) return;
    if (chip.classList.contains('active')) {
      chip.classList.remove('active');
      box.hidden = true;
      return;
    }
    $('result').querySelectorAll('.nature-chip').forEach((el) => el.classList.remove('active'));
    chip.classList.add('active');
    box.hidden = false;
    box.innerHTML = `<span class="nd-name" style="--nc:${NATURE_COLORS[nature.Increased] || '#B5762B'}">${nature.Name}</span>
      <span class="nd-item"><em>增益面</em><b class="nd-up">+${STAT_NAMES[nature.Increased]}</b></span>
      <span class="nd-item"><em>减益面</em><b class="nd-down">-${STAT_NAMES[nature.Decreased]}</b></span>`;
  });

  // 观测点击（删除 / 分段 / 系别选择）
  $('obsList').addEventListener('click', (e) => {
    const p = current();
    const del = e.target.closest('[data-act="del"]');
    if (del) {
      p.observations.splice(Number(del.dataset.idx), 1);
      save(); renderObservations(); recalc(); renderTabs();
      return;
    }
    const pickEl = e.target.closest('[data-act="pickElement"]');
    if (pickEl) {
      const card = pickEl.closest('.obs');
      openElementModal(Number(card.dataset.idx), 'element');
      return;
    }
    const pickOwn = e.target.closest('[data-act="pickOwnElems"]');
    if (pickOwn) {
      const card = pickOwn.closest('.obs');
      openElementModal(Number(card.dataset.idx), 'own');
      return;
    }
    const pick = e.target.closest('[data-act="pickDice"]');
    if (pick) { openDiceModal(pick.dataset.dfield, Array.from(pick.closest('.obs').parentNode.children).indexOf(pick.closest('.obs'))); return; }
    const pickAw = e.target.closest('[data-act="pickAw"]');
    if (pickAw) { openAwPickModal(Number(pickAw.closest('.obs').dataset.idx)); return; }
    const seg = e.target.closest('[data-seg]');
    if (seg) {
      const card = seg.closest('.obs');
      const o = p.observations[Number(card.dataset.idx)];
      if (seg.dataset.seg === 'direction') {
        // 先取本卡旧方向下的我方觉醒，再改方向：优先用该类型历史记忆，没有就沿用本卡值
        const cur = validAwake(mineAwakeOf(o));
        const newDir = seg.dataset.value;
        const mem = awakeMemoryOf(p, Number(card.dataset.idx));
        // 星级是我方精灵自身的属性，切方向不丢：本卡已有值就沿用，没有才取全页记忆（不分攻防）
        const keep = cur || mem;
        o.direction = newDir;
        o.mineAw = keep || '';
        applyAw(o);
        // 面板值各归各位：切到测防御用「我方攻击面板」，切到测攻击用「我方防御面板」；
        // 该类型还没填过，就取最近一条同类型数据的记忆（不拿另一种类型的值来顶）
        const idx = Number(card.dataset.idx);
        const memPanel = latestOfDirection(p, newDir, idx);
        if (newDir === 'OwnAttacksTarget' && String(o.panelOwnAtk ?? '') === '') {
          o.panelOwnAtk = String(memPanel && memPanel.panelOwnAtk != null ? memPanel.panelOwnAtk : '');
        }
        if (newDir === 'TargetAttacksOwn' && String(o.panelOwnDef ?? '') === '') {
          o.panelOwnDef = String(memPanel && memPanel.panelOwnDef != null ? memPanel.panelOwnDef : '');
        }
        if (newDir === 'HealthState') { o.panelOwnAtk = ''; o.panelOwnDef = ''; }
        // 其他加成 + 骰子：按测试类型独立记忆，切方向就取最近一条同类型数据；
        // 没有同类型数据（排除本卡）则回到默认值，不拿另一种类型的值来顶
        if (newDir !== 'HealthState') {
          const memSame = latestOfDirection(p, newDir, idx);
          const pick = (v) => (v == null ? '0' : String(v));
          if (memSame) {
            o.atkBonus = pick(memSame.atkBonus);
            o.defBonus = pick(memSame.defBonus);
            o.powerBonus = pick(memSame.powerBonus);
            o.diceAtk = pick(memSame.diceAtk);
            o.diceDef = pick(memSame.diceDef);
          } else {
            o.atkBonus = '0'; o.defBonus = '0'; o.powerBonus = '0';
            o.diceAtk = '0'; o.diceDef = '0';
          }
        }
      } else {
        o[seg.dataset.seg] = seg.dataset.value;
      }
      save(); renderObservations(); recalc(); renderTabs();
    }
  });

  // 输入中即清除该项红框
  $('obsList').addEventListener('input', (e) => {
    const f = e.target.dataset.field;
    if (f == null) return;
    const card = e.target.closest('.obs');
    const o = card ? current().observations[Number(card.dataset.idx)] : null;
    if (o && e.target.type !== 'checkbox') {
      if (f === 'opposite') {
        if (o.direction === 'OwnAttacksTarget') o.panelOwnAtk = e.target.value;
        else if (o.direction === 'TargetAttacksOwn') o.panelOwnDef = e.target.value;
        else o.opposite = e.target.value;
      } else if (f !== 'mineAw') {
        o[f] = e.target.value;
      }
    }
    e.target.classList.remove('invalid');
    const wrap = e.target.closest('.field, .hl-inputs, .hl-row');
    if (wrap) wrap.classList.remove('invalid');
  });

  // 观测字段变化
  $('obsList').addEventListener('change', (e) => {
    const card = e.target.closest('.obs');
    if (!card) return;
    const field = e.target.dataset.field;
    if (field == null) return;
    const o = current().observations[Number(card.dataset.idx)];
    if (e.target.type === 'checkbox') o[field] = e.target.checked;
    else if (field === 'opposite') {
      if (o.direction === 'OwnAttacksTarget') o.panelOwnAtk = e.target.value;
      else if (o.direction === 'TargetAttacksOwn') o.panelOwnDef = e.target.value;
      else o.opposite = e.target.value;
    } else if (field !== 'mineAw') {
      o[field] = e.target.value;
    }
    save();
    if (o.direction === 'HealthState') updateHpRange(card, o, current().isShiny, current());
    recalc(); renderTabs();
  });

  $('ownLevel').onchange = (e) => {
    const n = parseInt(e.target.value, 10);
    current().ownLevel = Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 60;
    e.target.value = current().ownLevel;
    save(); recalc();
  };
  $('level').addEventListener('input', (e) => {
    e.target.classList.remove('invalid');
    const wrap = e.target.closest('.field');
    if (wrap) wrap.classList.remove('invalid');
  });
  $('level').onchange = (e) => {
    e.target.classList.remove('invalid');
    const w0 = e.target.closest('.field');
    if (w0) w0.classList.remove('invalid');
    current().level = parseInt(e.target.value, 10) || 0;
    save(); renderObservations(); recalc(); renderTabs();
  };
  $('hpModel').onchange = (e) => {
    current().hpModel = e.target.value; save(); recalc();
  };

  // 异色切换
  $('speciesMeta').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="shiny"]');
    if (!btn) return;
    const p = current();
    // 存在任一测试数据时，异色状态锁定：两个方向都不允许切换，弹窗拦截
    if (p.observations.length > 0) {
      $('shinyBlockText').textContent = p.isShiny
        ? '当前已存在异色测试数据，请删除所有数据后重试'
        : '当前已存在测试数据，请删除所有数据后重试';
      $('shinyBlockModal').hidden = false;
      return;
    }
    p.isShiny = !p.isShiny;
    // 异色会改变理论生命对照与冻结倍率，必须整卡重绘（含生命值范围条）
    save(); renderSpeciesMeta(); renderObservations(); recalc(); renderTabs();
  });
  // 拦截弹窗 OK：关闭且不改变异色状态
  $('shinyBlockOk').onclick = () => { $('shinyBlockModal').hidden = true; };

  // 系别选择弹窗：网格选择（技能系别单选 / 我方系别最多两个）
  $('elementGrid').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-element-id]');
    if (!cell || elementModalIdx == null) return;
    const o = current().observations[elementModalIdx];
    const id = Number(cell.dataset.elementId);
    if (elementModalKind === 'own') {
      const cur = ownElems(o);
      if (cur.includes(id)) {
        o.ownElements = cur.filter((x) => x !== id);
      } else {
        const next = cur.length >= 2 ? cur.slice(1) : cur.slice();
        next.push(id);
        o.ownElements = next;
      }
      // 多选模式不关闭弹窗：重建网格，让选中态与 o.ownElements 保持一致
      save(); renderObservations(); recalc();
      openElementModal(elementModalIdx, 'own');
      return;
    }
    o.element = id;
    save(); closeElementModal(); renderObservations(); recalc();
  });
  $('elementClose').onclick = closeElementModal;
  $('elementModal').addEventListener('click', (e) => {
    if (e.target === $('elementModal')) closeElementModal();
  });

  // 精灵选择
  $('pickSpecies').onclick = () => {
    $('speciesModal').hidden = false;
    $('speciesSearch').value = '';
    renderSpeciesList();
    setTimeout(() => $('speciesSearch').focus(), 60);
  };
  $('speciesClose').onclick = () => { $('speciesModal').hidden = true; };
  $('speciesSearch').oninput = (e) => renderSpeciesList(e.target.value);
  // 待新建计算器的目标精灵 Id（确认弹窗用）
  let pendingNewCalcSpecies = null;
  $('speciesResults').addEventListener('click', (e) => {
    const row = e.target.closest('.species-row');
    if (!row) return;
    const p = current();
    const targetId = Number(row.dataset.id);
    // 已有测试数据且切换到不同精灵：先询问是否新建计算器
    if (p.observations.length > 0 && targetId !== p.speciesId) {
      pendingNewCalcSpecies = targetId;
      $('newCalcModal').hidden = false;
      return;
    }
    p.speciesId = targetId;
    if (!speciesSupportsShiny(catalog.findSpecies(p.speciesId))) p.isShiny = false;
    $('speciesModal').hidden = true;
    save(); renderSpeciesMeta(); applyObsTheme(); recalc(); renderTabs();
  });

  // 创建：按目标精灵新建计算器并选中
  $('newCalcCreate').onclick = () => {
    const targetId = pendingNewCalcSpecies;
    pendingNewCalcSpecies = null;
    $('newCalcModal').hidden = true;
    $('speciesModal').hidden = true;
    if (targetId == null) return;
    const p = newPage();
    p.speciesId = targetId;
    if (!speciesSupportsShiny(catalog.findSpecies(targetId))) p.isShiny = false;
    state.pages.push(p);
    state.activeId = p.id;
    save(); renderPage();
  };

  // 取消：放弃本次切换，回到原计算器
  $('newCalcCancel').onclick = () => {
    pendingNewCalcSpecies = null;
    $('newCalcModal').hidden = true;
    $('speciesModal').hidden = true;
  };

  // 底部页面：切换 / 新增 / 长按管理
  let pressTimer = null; let longPressed = false;
  $('tabScroller').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-page]');
    if (tab && !longPressed) {
      state.activeId = tab.dataset.page;
      save(); renderPage();
    }
  });

  $('tabScroller').addEventListener('touchstart', (e) => {
    const tab = e.target.closest('[data-page]');
    if (!tab) return;
    longPressed = false;
    const id = tab.dataset.page;
    pressTimer = setTimeout(() => {
      longPressed = true;
      openPageModal(id);
    }, 550);
  }, { passive: true });
  $('tabScroller').addEventListener('touchend', () => { clearTimeout(pressTimer); });
  $('tabScroller').addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('[data-page]');
    if (tab) { e.preventDefault(); openPageModal(tab.dataset.page); }
  });

  // 右下角加号：短按新建计算器；长按清空所有计算器，只留一个初始计算器
  let addPressTimer = null;
  let addLongPressed = false;
  const addBtn = $('addPage');
  addBtn.addEventListener('touchstart', () => {
    addLongPressed = false;
    clearTimeout(addPressTimer);
    addPressTimer = setTimeout(() => {
      addLongPressed = true;
      resetToSinglePage();
    }, 600);
  }, { passive: true });
  addBtn.addEventListener('touchend', () => { clearTimeout(addPressTimer); });
  addBtn.addEventListener('touchmove', () => { clearTimeout(addPressTimer); }, { passive: true });
  addBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    addLongPressed = true;
    clearTimeout(addPressTimer);
    resetToSinglePage();
  });
  addBtn.onclick = () => {
    if (addLongPressed) { addLongPressed = false; return; }
    const p = newPage();
    state.pages.push(p);
    state.activeId = p.id;
    save(); renderPage();
  };

  // 页面管理
  $('pageClose').onclick = () => { $('pageModal').hidden = true; };
  $('pageNameInput').onchange = (e) => {
    const p = state.pages.find((x) => x.id === managingId);
    if (p) { p.name = e.target.value.trim(); save(); renderTabs(); }
  };
  $('pageDuplicate').onclick = () => {
    const src = state.pages.find((x) => x.id === managingId);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = `p${Date.now()}_${pageSeq++}`;
    copy.name = `${pageDisplayName(src, state.pages.indexOf(src))} 副本`;
    state.pages.splice(state.pages.indexOf(src) + 1, 0, copy);
    state.activeId = copy.id;
    $('pageModal').hidden = true;
    save(); renderPage();
  };
  $('pageDelete').onclick = () => {
    const idx = state.pages.findIndex((x) => x.id === managingId);
    if (idx < 0) return;
    state.pages.splice(idx, 1);
    if (state.pages.length === 0) {
      const p = newPage(); state.pages.push(p); state.activeId = p.id;
    } else if (state.activeId === managingId) {
      state.activeId = state.pages[Math.max(0, idx - 1)].id;
    }
    $('pageModal').hidden = true;
    save(); renderPage();
  };
}

// ---------- 检查更新 ----------
function showToast(html, kind) {
  const t = $('updateToast');
  t.className = `update-toast${kind ? ' ' + kind : ''}`;
  t.innerHTML = html;
  t.hidden = false;
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function bindUpdate() {
  const btn = $('checkUpdate');
  const modal = $('updateModal');
  const text = $('updateText');
  const sub = $('updateSub');
  const actions = $('updateActions');

  const closeModal = () => { modal.hidden = true; };

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('busy');
    showToast('正在联网核对 Wiki 图鉴…');
    let result = null;
    try {
      result = await checkForUpdates(
        catalog.raw.Species.map((s) => ({ Id: s.Id, Name: s.Name, Race: s.Race })),
        (msg) => showToast(msg),
      );
    } catch (e) {
      $('updateToast').hidden = true;
      text.textContent = '检查更新失败';
      sub.textContent = `${String(e.message || e)}，请检查网络后再试。`;
      actions.innerHTML = '<button class="btn-confirm" data-act="ok">OK</button>';
      modal.hidden = false;
      btn.disabled = false;
      btn.classList.remove('busy');
      return;
    }

    $('updateToast').hidden = true;
    const hasNew = result.newSpecies.length > 0;
    const hasRace = result.raceChanges.length > 0;
    if (!hasNew && !hasRace) {
      text.textContent = '当前已经是最新版本';
      sub.textContent = `图鉴与 Wiki 一致（检查时间：${fmtTime(result.updatedAt)}）`;
      actions.innerHTML = '<button class="btn-confirm" data-act="ok">OK</button>';
    } else {
      text.textContent = '官方图鉴出现了新的精灵或有精灵进行了种族值调整，需要更新重装该软件';
      sub.textContent = [
        hasNew ? `新增精灵 ${result.newSpecies.length} 只` : '',
        hasRace ? `种族值调整 ${result.raceChanges.length} 只` : '',
      ].filter(Boolean).join('，') + `（检查时间：${fmtTime(result.updatedAt)}）`;
      actions.innerHTML = '<button class="btn-confirm" data-act="go">更新</button>'
        + '<button class="btn-ghost" data-act="later">暂不</button>';
    }
    modal.hidden = false;
    btn.disabled = false;
    btn.classList.remove('busy');
  });

  actions.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'go') {
      closeModal();
      showToast(`<div class="ut-title">请安装最新版本</div>
        <div class="ut-sub">到原安装包来源下载最新「阿布布布」覆盖安装，装好后图鉴与种族值即为官方最新口径。</div>`, 'ok');
    } else {
      closeModal();
    }
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
}

// 软键盘唤起时让底部计算器管理栏原位留在屏幕底部（被键盘遮住），不做跟随上浮。
// 判定以「可视视口被键盘压掉的高度」为准：键盘收起后无论输入框是否仍有焦点，一律恢复显示。
function bindKeyboardGuard() {
  const bar = document.querySelector('.tabbar');
  if (!bar) return;
  const vv = window.visualViewport;
  const isField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  let ticking = false;

  // 基准高度：记录无键盘时的窗口高度（首次进入 / 收起键盘 / 旋屏时刷新）
  let baseH = window.innerHeight;
  let lastW = window.innerWidth;

  const keyboardOpen = () => {
    const gap = vv ? (window.innerHeight - (vv.height + (vv.offsetTop || 0))) : 0;
    if (gap > 120) return true;                 // visualViewport 被键盘压掉
    const focused = isField(document.activeElement);
    if (!focused) return false;
    // adjustResize 下 WebView 自身被压矮：聚焦且窗口高度明显低于基准 → 键盘在
    return window.innerHeight < baseH - 100;
  };

  const sync = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (window.innerWidth !== lastW) { lastW = window.innerWidth; baseH = window.innerHeight; }
      if (!isField(document.activeElement)) baseH = Math.max(baseH, window.innerHeight);
      bar.classList.toggle('kb-hidden', keyboardOpen());
    });
  };

  window.addEventListener('orientationchange', () => setTimeout(() => { baseH = window.innerHeight; lastW = window.innerWidth; sync(); }, 260));
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', () => setTimeout(sync, 120));
  window.addEventListener('resize', sync);
  if (vv) { vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync); }
  // 兜底：部分机型收键盘后不派发 resize，轮询一次可视高度，保证栏位一定回来
  setInterval(sync, 500);
}

// ---------- 启动 ----------
async function main() {
  catalog = await Catalog.load();
  // 初始化 Wiki 增量：先立绘缓存，再合并增量精灵到 catalog
  try {
    await initImageCache();
    const inc = loadIncremental();
    catalog.applyIncremental(inc.species);
  } catch (e) { /* 缓存不可用时不影响基础功能 */ }
  load();
  bind();
  bindUpdate();
  bindKeyboardGuard();
  // 填充静态魔法图标
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
  renderPage();
  if ('serviceWorker' in navigator) {
    // 立即触发一次更新检查；新 SW 接管后刷新一次，避免旧缓存挡住新版界面
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update()).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      try {
        if (sessionStorage.getItem('sw-reloaded')) return;
        sessionStorage.setItem('sw-reloaded', '1');
      } catch (e) { /* 忽略 */ }
      location.reload();
    });
  }
}
main();
