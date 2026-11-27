// 状态流·测生命：由回合结束生命比例 / 冻结伤害 / 强击伤害 / 恶念交换回血
// 反推本体生命 H 的整数区间。对应原项目 BattleCalculation.BuildHealth + Core 的 X / Y / H / h。
//
// 冻结：游戏里冻结条攒满 100% 那一下的伤害，就等于该精灵的实战总生命值
//（实战：404 → 乐乐鲨41级、468/470 → 深蓝鲸42级），所以 1:1 直接使用。
//   - 生命比例 / 强击 / 恶念：直接对应本体 H。
//
// 四类输入（各自独立给出一个本体 H 的整数区间，多条取交集）：
//   ① 生命比例：r = 100(H-L)/H，游戏 Ceiling 显示 p，精度 e=10^-places
//   ② 冻结伤害：A 就是 H（1:1），H ∈ [A-8, A+8]
//   ③ 强击伤害：b = A/2，FixedFloor 下 b ≤ 0.3H < b+1，两端再放宽 1
//   ④ 恶念交换：破盾后总血量 = 本体精灵生命 spirit（×1，不再是 2H/3H），
//      回血量 b = 0.9·spirit。先反推 spirit 区间，再乘血条段数（普通 2 / 异色 3）换算回
//      「实战总血量」单位，才能和冻结/强击/比例的区间取交集。

import { Rat } from './rational.js?v=126';

const HUNDRED = new Rat(100n);
const TEN = new Rat(10n);
const STRONG_RATIO = new Rat(3n, 10n);   // 强击对应本体 30%
const EVIL_RATIO = new Rat(9n, 10n);     // 恶念交换对应本体 90%
const STRONG_MULT = 2n;                   // 强击 AfterRoundingMultiplier
// 显示取整容差：游戏内数字可能 ±1 抖动，反推时会按比例放大到生命值上
const FREEZE_TOL = 5n;   // 严格模式：只吸收公式本身的 ±6 误差，不能跨过一整级（一级约 8~9 点）
const STRONG_TOL = 4n;
const EVIL_TOL = 2n;

// 血条分段数（对应原项目 num5 = EnemyIsShiny ? 3 : 2）：
// 普通奇遇 2 段、异色 3 段，每段都等于本体生命 H；异色总有效血量 = 3H，是普通 2H 的 1.5 倍。
export function shinyScale(isShiny) {
  return isShiny ? 3n : 2n;
}

// 异色实战显示血条总值相对普通的倍率：3 段 / 2 段 = 1.5 倍。
export function shinyHpMult(isShiny) {
  return isShiny ? new Rat(3n, 2n) : new Rat(1n);
}

// 正整数向上取整除法 ceil(x / s)，对应原项目 E.a()：(x + s - 1) / s。
function ceilDiv(x, s) {
  return (x + s - 1n) / s;
}

// 解析正整数输入（非空、纯数字、大于 0），否则抛中文 Error。
function parsePositiveInt(text, label) {
  const s = String(text).trim();
  if (s === '' || !/^\d+$/.test(s)) throw new Error(`请填写${label}（正整数）`);
  const v = BigInt(s);
  if (v <= 0n) throw new Error(`${label}需大于 0`);
  return v;
}

// 解析输入百分比的小数位数（与原项目一致：看小数点后的字符数）。
export function decimalPlaces(percentStr) {
  const s = String(percentStr).trim();
  return s.includes('.') ? s.split('.')[1].length : 0;
}

// ① 生命比例 + 累计掉血 -> 总血量整数区间。
export function healthBounds(loss, percentStr) {
  const s = String(percentStr).trim();
  if (s === '' || Number.isNaN(Number(s))) throw new Error('请填写剩余生命比例');
  const p = Rat.fromDecimal(s);
  if (p.lt(new Rat(0n)) || p.gt(HUNDRED)) throw new Error('生命比例需在 0~100 之间');

  const L = new Rat(parsePositiveInt(loss, '累计掉血'));

  if (p.equals(HUNDRED)) throw new Error('剩余比例为 100% 时尚未掉血，无法推断生命性格');
  if (p.equals(new Rat(0n))) {
    throw new Error('剩余比例为 0% 时无法可靠反推，请在尚未清空血条时记录');
  }

  const places = decimalPlaces(s);
  const e = new Rat(1n, 10n ** BigInt(places));

  // 游戏里比例是整数显示：真实失去比例落在 (100-p-1, 100-p+1) 区间内
  //（±1 个百分点，两头都留，正向校验 |掉血 - H×失血比例| ≤ 1%×H 等价于此）
  const lossHigh = HUNDRED.sub(p).add(new Rat(1n)); // 100 - p + 1
  const lossLow = HUNDRED.sub(p).sub(new Rat(1n));  // 100 - p - 1
  if (lossLow.lt(new Rat(0n)) || lossLow.equals(new Rat(0n))) throw new Error('剩余比例过低，反推不可靠');
  const upperReal = HUNDRED.mul(L).div(lossLow);    // 失血比例最小 → H 最大
  const lowerReal = HUNDRED.mul(L).div(lossHigh);   // 失血比例最大 → H 最小

  // 血量与掉血都是整数，再各留 1 点取整余量，避免把只差 1~2 点的真实值判成冲突
  const max = upperReal.floor() + 1n;
  const min = lowerReal.floor();
  if (min > max) throw new Error('该观测自相矛盾，请核对掉血与比例');
  return { min, max };
}

// ② 冻结伤害：冻结条攒满 100% 那一下的伤害 = 该精灵的实战总生命值（1:1）。
// 实测：苞米仔43级 冻结400、深蓝鲸43级 570、乐乐鲨41级 404。
export function freezeBounds(text, scale) {
  const A = parsePositiveInt(text, '冻结伤害');
  return { min: A - FREEZE_TOL, max: A + FREEZE_TOL };
}

// ③ 强击伤害：A 必须为偶数，b=A/2，b ≤ 0.3H < b+1，两端放宽 1。
export function strongBounds(text) {
  const A = parsePositiveInt(text, '强击伤害');
  if (A % STRONG_MULT !== 0n) {
    throw new Error('强击扣除的生命值需为偶数，请核对游戏内数值后重填');
  }
  const b = A / STRONG_MULT;
  // H ≥ b/0.3 = 10b/3；H < 10(b+1)/3
  const minRaw = new Rat(b).div(STRONG_RATIO).ceil();
  const maxRaw = new Rat(b + 1n).div(STRONG_RATIO).ceil() - 1n;
  return { min: minRaw - STRONG_TOL, max: maxRaw + STRONG_TOL };
}

// 恶念交换回血：b-1 < 0.9·spirit ≤ b；segments = 破盾前血条段数（2 或 3）。
export function evilBounds(text, segments) {
  const b = parsePositiveInt(text, '恶念交换回血');
  const seg = segments || 2n;
  // spirit ≤ 10b/9；spirit > 10(b-1)/9
  const maxSpirit = new Rat(b).div(EVIL_RATIO).floor();
  const minSpirit = new Rat(b - 1n).div(EVIL_RATIO).floor() + 1n;
  // 换算回实战总血量单位；容差保持在总血量 ±EVIL_TOL
  return { min: minSpirit * seg - EVIL_TOL, max: maxSpirit * seg + EVIL_TOL };
}

// 从一条状态流观测收集所有已填字段的区间。
// scale 保留为兼容参数（冻结 1:1，不再按血条段数换算）。
// 返回 { bounds: [{min,max}], errors: [中文说明] }。
export function observationHealthBounds(o, scale) {
  const bounds = [];
  const errors = [];

  const hasPercent = String(o.hpPercent).trim() !== '';
  const hasLoss = String(o.hpLoss).trim() !== '';
  if (hasPercent || hasLoss) {
    if (!hasPercent) errors.push('生命比例分支缺少剩余生命比例');
    else if (!hasLoss) errors.push('生命比例分支缺少累计掉血');
    else {
      try { bounds.push(healthBounds(o.hpLoss, o.hpPercent)); }
      catch (e) { errors.push(e.message); }
    }
  }

  const extra = [
    ['hpFreeze', (v) => freezeBounds(v, scale)],
    ['hpStrong', strongBounds],
    ['hpEvil', (v) => evilBounds(v, scale)],
  ];
  for (const [key, fn] of extra) {
    if (String(o[key] ?? '').trim() === '') continue;
    try { bounds.push(fn(o[key])); } catch (e) { errors.push(e.message); }
  }

  return { bounds, errors };
}

// 多个区间取交集；无有效区间时返回 null。
export function intersectHealthBounds(list) {
  const valid = list.filter(Boolean);
  if (valid.length === 0) return null;
  let { min, max } = valid[0];
  for (const b of valid.slice(1)) {
    if (b.min > min) min = b.min;
    if (b.max < max) max = b.max;
  }
  return min > max ? { min, max, conflict: true } : { min, max };
}
