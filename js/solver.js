// 性格区间求解器。对应原程序 D.cs / d（单场景模型，覆盖核心使用场景）。
// 把多次伤害观测转成属性约束，再对每个候选性格正向预测并筛选。

import { Rat } from './rational.js?v=126';
import { invertHit } from './damage.js?v=126';
import { predictEnemy } from './stats.js?v=126';
import { Stat, COMBAT_STATS, STAT_NAMES } from './catalog.js?v=126';

// 主求解入口。
// input: { species, level, hpModel, natures, hits: [伤害观测...], healthBounds: 总血量区间|null, hpScale: 异色血条倍率 }
export function solve(input) {
  const { species, level, hpModel, natures, hits, healthBounds } = input;
  // 状态流反推用的是「实战显示血条总值」；异色的总值是普通的 1.5 倍
  const hpScale = input.hpScale || new Rat(1n);

  // 1) 每次伤害观测逆向为属性区间
  const inverted = hits.map((h) => invertHit(h));
  const hasUsed = inverted.some((r) => r.status === 'Used');
  const hasConflict = inverted.some((r) => r.status === 'Conflict');
  const healthConflict = !!(healthBounds && healthBounds.conflict);

  // 2) 四个战斗属性分别求区间交集
  const constraints = new Map();
  for (const stat of COMBAT_STATS) {
    const rel = inverted.filter((r) => r.status === 'Used' && r.attribute === stat);
    if (rel.length === 0) { constraints.set(stat, null); continue; }
    const interval = rel.slice(1).reduce((acc, r) => acc.intersect(r.interval), rel[0].interval);
    const integers = interval.isEmpty ? null : interval.integers();
    constraints.set(stat, { interval, integers });
  }
  const emptyStats = [...constraints.entries()]
    .filter(([, c]) => c && c.integers === null)
    .map(([stat, c]) => ({ stat, lower: c.interval.lower.toNumber(), upper: c.interval.upper.toNumber() }));
  const emptyConstraint = emptyStats.length > 0;

  // 2b) 每组观测「单独」能对上哪些性格：多组数据一起填却全灭时，用来指出是哪两组在打架
  const obsGroups = [];
  const perNature = new Map(); // 缓存：同一性格的预测只算一次
  const predictOf = (nature) => {
    let p = perNature.get(nature.Id);
    if (!p) { p = predictEnemy(species, level, nature, hpModel); perNature.set(nature.Id, p); }
    return p;
  };
  const allowedBy = (stat, ints) => natures.filter((n) => {
    const v = predictOf(n).effective[stat];
    return v != null && inIntegers(ints, v);
  }).map((n) => n.Name);
  inverted.forEach((r, i) => {
    const h = hits[i] || {};
    const g = {
      idx: i,
      seq: h.seq != null ? h.seq : i + 1,
      direction: h.direction || null,
      stat: r.attribute != null ? r.attribute : null,
      min: null, max: null, allowed: [],
    };
    if (r.status === 'Used' && r.interval) {
      const ints = r.interval.isEmpty ? null : r.interval.integers();
      if (ints) {
        g.min = String(ints.min); g.max = String(ints.max);
        g.allowed = allowedBy(r.attribute, ints);
      }
    }
    obsGroups.push(g);
  });
  if (healthBounds && !healthBounds.conflict) {
    const ints = { min: healthBounds.min, max: healthBounds.max };
    const allowed = natures.filter((n) => {
      const hp = predictOf(n).effective[Stat.Hp];
      if (hp == null) return false;
      const shown = hpScale.mul(new Rat(hp)).halfUp();
      return shown >= ints.min && shown <= ints.max;
    }).map((n) => n.Name);
    obsGroups.push({
      idx: null, seq: input.healthSeq != null ? input.healthSeq : null, direction: 'HealthState',
      stat: Stat.Hp, min: String(ints.min), max: String(ints.max), allowed,
    });
  }
  // 按「测试数据」编号排好，解释时先说第 1 组
  obsGroups.sort((a, b) => (a.seq == null ? 99 : a.seq) - (b.seq == null ? 99 : b.seq));

  // 3) 遍历候选性格，正向预测并筛选
  const candidates = [];
  const rejected = [];
  const predRange = new Map();
  for (const nature of natures) {
    const prediction = predictEnemy(species, level, nature, hpModel);
    const failReasons = [];
    const unchecked = [];
    for (const stat of COMBAT_STATS) {
      const v = prediction.effective[stat];
      if (v == null) continue;
      const cur = predRange.get(stat) || { min: v, max: v };
      predRange.set(stat, { min: v < cur.min ? v : cur.min, max: v > cur.max ? v : cur.max });
    }
    for (const stat of COMBAT_STATS) {
      const c = constraints.get(stat);
      if (!c) continue;
      const value = prediction.effective[stat];
      if (value == null) { unchecked.push(stat); continue; }
      if (c.integers == null) { failReasons.push(`${STAT_NAMES[stat]}观测区间为空（数值不可能成立）`); continue; }
      if (!inIntegers(c.integers, value)) {
        failReasons.push(`${STAT_NAMES[stat]}预测值 ${value} 不在观测区间 ${c.integers.min}~${c.integers.max}`);
      }
    }
    // 状态流：总血量需落在反推区间
    if (healthBounds && !healthBounds.conflict) {
      const hp = prediction.effective[Stat.Hp];
      const hpShown = hp == null ? null : hpScale.mul(new Rat(hp)).halfUp();
      if (hpShown != null && !(hpShown >= healthBounds.min && hpShown <= healthBounds.max)) {
        failReasons.push(`生命预测值 ${hpShown} 不在状态流区间 ${healthBounds.min}~${healthBounds.max}`);
      }
    }
    if (failReasons.length === 0) candidates.push({ nature, prediction, unchecked });
    else rejected.push({ nature, reasons: failReasons });
  }

  // 4) 性格总体状态
  const hasHealthInput = !!(healthBounds && !healthBounds.conflict);
  const hasAnyInput = hasUsed || hasHealthInput;
  // 多组观测「各自都能对上」却没有共同性格 —— 说明是几组数据互相打架，不是这只精灵的问题
  const usableGroups = obsGroups.filter((g) => g.allowed && g.allowed.length > 0);
  const crossConflict = candidates.length === 0 && usableGroups.length >= 2
    && obsGroups.every((g) => g.allowed && g.allowed.length > 0);
  let natureStatus;
  if (hasConflict || healthConflict || emptyConstraint || (hasAnyInput && candidates.length === 0)) {
    natureStatus = 'Conflict';
  } else if (!hasAnyInput) {
    natureStatus = 'MissingData';
  } else if (candidates.length === 1) {
    natureStatus = 'Unique';
  } else {
    natureStatus = 'Multiple';
  }

  // 4b) 严格无解时，仍按「离观测最接近」给三个候选，避免第二组数据一填就彻底算不出
  let nearest = [];
  if (natureStatus === 'Conflict' && hasAnyInput) {
    const scored = [];
    for (const nature of natures) {
      const prediction = predictEnemy(species, level, nature, hpModel);
      let score = 0;
      for (const stat of COMBAT_STATS) {
        const c = constraints.get(stat);
        const value = prediction.effective[stat];
        if (!c || !c.integers || value == null) continue;
        if (value < c.integers.min) score += Number(c.integers.min - value) / Number(value);
        else if (value > c.integers.max) score += Number(value - c.integers.max) / Number(value);
      }
      if (healthBounds && !healthBounds.conflict) {
        const hp = prediction.effective[Stat.Hp];
        const hpShown = hp == null ? null : hpScale.mul(new Rat(hp)).halfUp();
        if (hpShown != null) {
          if (hpShown < healthBounds.min) score += Number(healthBounds.min - hpShown) / Number(hpShown);
          else if (hpShown > healthBounds.max) score += Number(hpShown - healthBounds.max) / Number(hpShown);
        }
      }
      scored.push({ nature, prediction, score });
    }
    scored.sort((a, b) => a.score - b.score);
    nearest = scored.slice(0, 3);
  }

  // 5) 六维属性状态
  const attributes = [];
  for (let stat = 0; stat < 6; stat++) {
    if (stat === Stat.Speed) {
      attributes.push({ stat, status: 'MissingData', values: [], note: '速度无法由伤害推断' });
      continue;
    }
    const values = [...new Set(candidates.map((c) => c.prediction.effective[stat]))];
    let status;
    if (stat === Stat.Hp) {
      if (healthConflict) status = 'Conflict';
      else status = values.length === 0 ? 'MissingData' : values.length === 1 ? 'Unique' : 'Multiple';
    } else {
      const c = constraints.get(stat);
      if (!c) status = 'MissingData';
      else if (values.length === 0) status = 'Conflict';
      else if (values.length === 1) status = 'Unique';
      else status = 'Multiple';
    }
    attributes.push({ stat, status, values: values.filter((v) => v != null) });
  }

  // 冲突属性：观测区间 vs 该精灵实际预测范围（用于给出人话解释）
  const conflictStats = [];
  for (const stat of COMBAT_STATS) {
    const c = constraints.get(stat);
    if (!c || !c.integers) continue;
    const st = attributes.find((x) => x.stat === stat);
    if (!st || st.status !== 'Conflict') continue;
    const p = predRange.get(stat);
    conflictStats.push({
      stat,
      min: String(c.integers.min), max: String(c.integers.max),
      predMin: p ? String(p.min) : null, predMax: p ? String(p.max) : null,
    });
  }

  return {
    natureStatus,
    emptyStats,
    conflictStats,
    candidates,
    rejected,
    constraints,
    attributes,
    inverted,
    nearest,
    obsGroups,
    crossConflict,
  };
}

function inIntegers(bounds, value) {
  return value >= bounds.min && value <= bounds.max;
}
