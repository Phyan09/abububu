// 威力构成、正向伤害、逆向属性区间。对应 P.cs / S.cs / N.cs / G.cs。

import { Rat } from './rational.js?v=126';
import { Interval } from './interval.js?v=126';

// 伤害等级系数：(45*level + 1000)/4100。对应 p.A(level)。
export function levelFactor(level) {
  return new Rat(45n * BigInt(level) + 1000n, 4100n);
}

// 命中前攻防等级倍率。对应 N.A()。
// 入参为四个 Rat：攻击升/降、防御升/降
export function gradeFactor({ atkUp, atkDown, defUp, defDown }) {
  const zero = new Rat(0n);
  const num = new Rat(1n)
    .add(atkUp.sub(atkDown).gt(zero) ? atkUp.sub(atkDown) : zero)
    .add(defDown.sub(defUp).gt(zero) ? defDown.sub(defUp) : zero);
  const den = new Rat(1n)
    .add(atkDown.sub(atkUp).gt(zero) ? atkDown.sub(atkUp) : zero)
    .add(defUp.sub(defDown).gt(zero) ? defUp.sub(defDown) : zero);
  return num.div(den);
}

// 觉醒总倍率 g.A(G)。对应 G.cs 262-302。
export function awakeningFactor(aw) {
  if (!aw) return new Rat(1n);
  const { attackerLevel: al, defenderLevel: dl, relation } = aw;
  if (al === 0 && dl === 0) return new Rat(1n);
  if (relation === 'Neutral') return new Rat(1n);
  // 官方口径：极化(克制)/钝化(抵抗) 每星 45%，两侧同时存在时按 (1+我方极化)/(1+敌方钝化) 取比值，
  // 比值上限 1.8（克制 200%→360%）、下限 0.6（抵抗 50%→30%）。对应 NGA 实测对照表。
  const num = new Rat(1n).add(new Rat(9n * BigInt(al), 20n));   // 1 + 0.45*al
  const den = new Rat(1n).add(new Rat(9n * BigInt(dl), 20n));   // 1 + 0.45*dl
  let v = num.div(den);
  const cap = new Rat(9n, 5n);
  const floor = new Rat(3n, 5n);
  if (v.gt(cap)) v = cap;
  if (v.lt(floor)) v = floor;
  return v;
}

// 本系 STAB（含觉醒等级）：g.A(isNative, level)。对应 G.cs 252-260。
export function stabFactor(isNative, attackerAwakeningLevel = 0) {
  if (!isNative) return new Rat(1n);
  return new Rat(5n, 4n).add(new Rat(3n * BigInt(attackerAwakeningLevel), 20n));
}

// 计算威力构成。对应 P.cs p.A(n)。
// power.kind === 'full'：完整威力
function buildFullPower(power) {
  const aw = power.awakening;
  const awFactor = awakeningFactor(aw);
  const base = power.skillBase.add(power.fixedAddition);
  const stab = aw
    ? stabFactor(power.isNative, aw.attackerLevel)
    : power.stab;
  const grade = power.statBonus || gradeFactor(power.beforeHitGrades);
  const effective = base
    .mul(power.weather)
    .mul(grade)
    .mul(stab)
    .mul(power.typeFactor)
    .mul(awFactor);
  return { effective, base, grade, stab, awFactor };
}

// 显示威力的随机浮动区间。对应 S.A(displayed)。
function displayPowerRange(displayed) {
  const step = new Rat(1n, 16777216n);
  let lo = new Rat(1n);
  let hi = new Rat(1n);
  for (let i = 0; i < 9; i++) {
    lo = lo.mul(new Rat(1n).sub(step));
    hi = hi.mul(new Rat(1n).add(step));
  }
  return new Interval(
    new Rat(BigInt(displayed)).div(hi), true,
    new Rat(BigInt(displayed) + 1n).div(lo), false);
}

// 正向伤害。对应 P.cs p.A(...) 467-479。
export function dealDamage(attack, defense, power, level, critical,
  damageFraction, finalMult = new Rat(1n)) {
  const lf = levelFactor(level);
  const crit = critical ? new Rat(2n) : new Rat(1n);
  return Rat.of(attack)
    .mul(power)
    .mul(lf)
    .mul(crit)
    .mul(damageFraction)
    .mul(finalMult)
    .div(Rat.of(defense))
    .floor();
}

// 逆向：把一次伤害观测转成目标属性区间。
// 对应 P.cs p.A(o)（完整威力）与 S.A(o)（显示威力）。
// 返回 { status, attribute, interval, ratio, reasons }
export function invertHit(hit) {
  const reasons = [];
  const attribute = targetAttribute(hit.direction, hit.channel);
  if (hit.damage <= 0n) {
    return { status: hit.damage === 0n ? 'Excluded' : 'Conflict', attribute, interval: null, reasons: ['伤害必须为正'] };
  }

  let powerRange;
  let e4;
  if (hit.power.kind === 'display') {
    const range = displayPowerRange(hit.power.displayed);
    const awFactor = awakeningFactor(hit.power.awakening);
    const lf = levelFactor(hit.attackerLevel);
    const cf = hit.critical ? new Rat(2n) : new Rat(1n);
    const e5 = lf.mul(cf).mul(hit.damageFraction).mul(awFactor).mul(hit.finalMult);
    const e6 = range.lower.mul(e5);
    const e7 = range.upper.mul(e5);
    powerRange = range;
    const ratio = new Interval(
      new Rat(hit.damage).div(e7), range.upperInclusive,
      new Rat(hit.damage + 1n).div(e6), false);
    return finalize(ratio, hit, attribute, reasons, e6, e7, powerRange);
  }

  // 完整威力
  const built = buildFullPower(hit.power);
  const lf = levelFactor(hit.attackerLevel);
  const cf = hit.critical ? new Rat(2n) : new Rat(1n);
  const e4all = built.effective.mul(lf).mul(cf)
    .mul(hit.damageFraction).mul(hit.finalMult);
  const ratio = new Interval(
    new Rat(hit.damage).div(e4all), true,
    new Rat(hit.damage + 1n).div(e4all), false);
  return finalize(ratio, hit, attribute, reasons, e4all, e4all, null);
}

// 结合已知对侧属性，得到目标属性区间
function finalize(ratio, hit, attribute, reasons, e6, e7, powerRange) {
  if (hit.knownOppositeAttribute == null) {
    return { status: 'MissingInput', attribute, interval: null, ratio, reasons: ['缺少对侧已知属性'], powerRange };
  }
  const opp = Rat.of(hit.knownOppositeAttribute);
  if (opp.le(0n)) return { status: 'Conflict', attribute, interval: null, reasons: ['对侧属性必须为正'] };

  let interval;
  if (hit.direction === 'OwnAttacksTarget') {
    // 我打对方：求对方防御。P.cs A(opp, e4, damage)
    if (hit.power.kind === 'display') {
      interval = new Interval(
        opp.mul(e6).div(new Rat(hit.damage + 1n)), false,
        opp.mul(e7).div(new Rat(hit.damage)), true);
    } else {
      interval = new Interval(
        opp.mul(e6).div(new Rat(hit.damage + 1n)), false,
        opp.mul(e6).div(new Rat(hit.damage)), true);
    }
  } else {
    // 对方打我：求对方攻击。P.cs a(opp, e4, damage)
    interval = new Interval(
      new Rat(hit.damage).mul(opp).div(e6), true,
      new Rat(hit.damage + 1n).mul(opp).div(e6), false);
  }
  return { status: 'Used', attribute, interval, ratio, reasons, powerRange };
}

// 方向 + 物理/魔法 -> 目标属性
export function targetAttribute(direction, channel) {
  const physical = channel === 'Physical';
  if (direction === 'OwnAttacksTarget') {
    return physical ? 3 : 4; // 物防/魔防
  }
  return physical ? 1 : 2; // 物攻/魔攻
}
