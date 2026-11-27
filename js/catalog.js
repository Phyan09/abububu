// 数据层：加载 catalog.json / battle-skill-rules.json，建立索引与查询。
// 对应原 App 的 TeamCatalog 与 Core 的数据模型。

import { Rat } from './rational.js?v=126';

// 六维枚举（顺序与原程序 A.A 一致）
export const Stat = {
  Hp: 0,
  PhysicalAttack: 1,
  MagicAttack: 2,
  PhysicalDefense: 3,
  MagicDefense: 4,
  Speed: 5,
};
export const STAT_NAMES = ['生命', '物攻', '魔攻', '物防', '魔防', '速度'];
// 四个战斗属性（可由伤害推断）
export const COMBAT_STATS = [
  Stat.PhysicalAttack,
  Stat.MagicAttack,
  Stat.PhysicalDefense,
  Stat.MagicDefense,
];

// 元素（系别）ID -> 名称（ID 7 不存在）
export const ELEMENT_NAMES = {
  1: '首领', 2: '普通', 3: '草', 4: '火', 5: '水', 6: '光',
  8: '地', 9: '冰', 10: '龙', 11: '电', 12: '毒', 13: '虫',
  14: '武', 15: '翼', 16: '萌', 17: '幽', 18: '恶', 19: '机械', 20: '幻',
};

// 关系分类，对应 g.A(adv, res)
export function relationKind(adv, res) {
  if (adv === 0 && res === 0) return 'Neutral';
  if (adv === 1 && res === 0) return 'SingleAdvantage';
  if (adv === 2 && res === 0) return 'DoubleAdvantage';
  if (adv === 0 && res === 1) return 'SingleResistance';
  if (adv === 0 && res === 2) return 'DoubleResistance';
  return 'MultipleOrMixed';
}

export class Catalog {
  constructor(raw, skillRules) {
    this.raw = raw;
    this.skillRules = skillRules;
    this.species = new Map(raw.Species.map((s) => [s.Id, s]));
    this.skills = new Map(raw.Skills.map((s) => [s.Id, s]));
    this.natures = new Map(raw.Natures.map((n) => [n.Id, n]));
    this.dice = new Map(raw.DiceEffects.map((d) => [d.Id, d]));
    this.weathers = new Map(raw.Weathers.map((w) => [w.Id, w]));
    this.bloods = new Map(raw.Bloods.map((b) => [b.Id, b]));
    this.singleAdvantage = Rat.fromDecimal(raw.SingleAdvantage); // 2.0
  }

  static async load(base = '.') {
    const [cat, rules] = await Promise.all([
      fetch(`${base}/data/catalog.json`).then((r) => r.json()),
      fetch(`${base}/data/battle-skill-rules.json`).then((r) => r.json()),
    ]);
    return new Catalog(cat, rules);
  }

  findSpecies(id) { return this.species.get(id); }

  // 合并 Wiki 增量精灵（新增 Id 直接加入；不覆盖已内置的 Id，保证基线稳定）。
  applyIncremental(speciesList) {
    for (const s of speciesList || []) {
      if (!this.species.has(s.Id)) this.species.set(s.Id, s);
    }
  }
  findSkill(id) { return this.skills.get(id); }
  findNature(id) { return this.natures.get(id); }
  findDice(id) { return id ? this.dice.get(id) : null; }
  findWeather(id) { return this.weathers.get(id); }
  skillRule(skillId) { return this.skillRules[String(skillId)]; }

  // 精灵可学技能（含等级），关联技能详情
  speciesSkills(species) {
    return (species.Skills || [])
      .map((ref) => ({ ref, skill: this.findSkill(ref.Id) }))
      .filter((x) => x.skill);
  }

  // 类型克制：攻击系对单个防御系的 1(克制)/-1(微弱)/0(普通)
  relation(attackElement, defenderElement) {
    const chart = this.raw.TypeRelations[String(attackElement)];
    if (!chart) return 0;
    return chart[String(defenderElement)] ?? 0;
  }

  // 类型倍率与关系分类。对应 App TypeFactor。
  typeFactor(attackElement, defenderElements, attackerDice, defenderDice,
    finalBonus = false, ignoreResistance = false) {
    const chart = this.raw.TypeRelations[String(attackElement)];
    if (!chart) throw new Error('未知的攻击系别');
    const rels = [...new Set(defenderElements)].map((d) => chart[String(d)] ?? 0);
    const advCount = rels.filter((r) => r === 1).length;
    const resCount = ignoreResistance ? 0 : rels.filter((r) => r === -1).length;
    const relation = relationKind(advCount, resCount);
    if (relation === 'Neutral') return { factor: new Rat(1n), relation };

    if (advCount > 0) {
      let adv = this.singleAdvantage;
      if (attackerDice && attackerDice.Id === 31 && finalBonus) adv = this.singleAdvantage;
      else if (attackerDice && attackerDice.Advantage != null) adv = Rat.fromDecimal(attackerDice.Advantage);
      if (!(adv.gt(1n))) throw new Error('克制倍率必须大于 1');
      // factor = 1 + n*(adv-1)
      const factor = new Rat(1n).add(adv.sub(1n).mul(new Rat(BigInt(advCount))));
      return { factor, relation };
    }

    // 微弱
    let res = Rat.fromDecimal('0.5');
    if (defenderDice && defenderDice.Resistance != null) res = Rat.fromDecimal(defenderDice.Resistance);
    if (!(res.gt(0n) && res.lt(1n))) throw new Error('微弱倍率必须在 (0,1)');
    const factor = resCount === 2 ? res.mul(res) : res;
    return { factor, relation };
  }
}
