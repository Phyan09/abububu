// 面板养成、性格倍率、敌方野生预测。对应原程序 F.cs / B.cs。

import { Rat } from './rational.js?v=126';
import { Stat } from './catalog.js?v=126';

// 性格倍率常量（来自 App TeamNature）
const NATURE_INCREASE = new Rat(1n, 10n);   // 增强 +10%
const NATURE_DECREASE = new Rat(1n, 10n);   // 削弱 -10%
const INCREASE_PER_STAR = new Rat(1n, 50n); // 每突破星 +2%
const WILD_HP_SEGMENTS = 2; // 普通龙骑士血条 = 2 个精灵生命，异色 = 3 个（hpScale 1.5 补）

// 单个属性的性格倍率。对应 B.A(stat, star)。
export function natureMultiplier(nature, stat, star = 0) {
  if (stat === nature.Increased) {
    return new Rat(1n)
      .add(NATURE_INCREASE)
      .add(INCREASE_PER_STAR.mul(new Rat(BigInt(star))));
  }
  if (stat === nature.Decreased) return new Rat(1n).sub(NATURE_DECREASE);
  return new Rat(1n);
}

// 单个属性面板。对应 F.A(...)（F.cs 15-24）。
// race 种族值；talent 该属性天赋；growth 养成加点；isHp 是否生命。
export function calcPanelStat(race, level, talent, natureMult, growth, isHp) {
  const divisor = isHp ? 50n : 100n;
  const levelAdd = isHp ? 25n : 50n;
  // base = ((race + talent/2) / divisor) * (level + levelAdd)
  const base = new Rat(BigInt(race) * 2n + BigInt(talent), 2n)
    .div(new Rat(divisor))
    .mul(new Rat(BigInt(level) + levelAdd));
  const constant = isHp ? BigInt(level) * 10n : 10n;
  // panel = halfUp( (halfUp(base) + constant) * natureMult ) + growth
  const inner = base.halfUp() + constant;
  return new Rat(inner).mul(natureMult).halfUp() + BigInt(growth);
}

// 特殊修正精灵（F.cs 75-103）
const SPECIAL_IDS = new Set([3012, 3036, 3452, 3453, 3495, 3742]);
function specialAdjust(id, stat, value) {
  if (SPECIAL_IDS.has(id) && stat <= Stat.MagicAttack) {
    return new Rat(4n, 5n).mul(new Rat(value)).halfUp();
  }
  return value;
}

// 敌方野生精灵的等级系数（F.cs 48-73）。
function strengthCoefficient(strengthStage, stat) {
  const isDefense = stat === Stat.PhysicalDefense || stat === Stat.MagicDefense;
  switch (strengthStage) {
    case 1: return isDefense ? new Rat(276n, 100n) : new Rat(28n, 10n);
    case 2: return isDefense ? new Rat(19552n, 10000n) : new Rat(24n, 10n);
    case 3: return isDefense ? new Rat(138n, 100n) : new Rat(2n, 1n);
    default: throw new Error('不支持的强度阶段');
  }
}

// 敌方野生预测。对应 F.A(species, level, nature, hpModel)（F.cs 105-142）。
// hpModel: 'EncounterPlus22' | 'TheoreticalPanel'
// 返回 { theory: BigInt[6], hp: BigInt, effective: (BigInt|null)[] }
export function predictEnemy(species, level, nature, hpModel = 'EncounterPlus22') {
  const theory = [];
  for (let stat = 0; stat < 6; stat++) {
    const mult = natureMultiplier(nature, stat, 0);
    theory.push(calcPanelStat(species.Race[stat], level, 0, mult, 0, stat === Stat.Hp));
  }

  const panelHp = theory[Stat.Hp];
  let hp;
  if (hpModel === 'EncounterPlus22') {
    // 奇遇「破盾前」：冻结点那一下打的是**龙骑士**，不是它身后的精灵。
    //   白板面板 = round((种族/50)×(等级+25)) + 等级 + 10      （不含个体、不含性格）
    //   精灵生命 = round(白板 × 性格修正) + 22
    //   普通龙骑士 = 2 × 精灵生命；异色龙骑士 = 3 × 精灵生命（这里先算普通 2 倍，异色由 hpScale 3/2 补）
    // 出处：S5 赛季实测公式（小翼龙 42 级白板 140 → 精灵 162 → 龙骑士 324；减生命 296、加生命 352；
    //   异色 486 / 444 / 528），并与本机实测 小翼龙41=320、苞米仔43=400、乐乐鲨41=404、深蓝鲸43=520~522 全部吻合。
    // 龙骑士没有个体值，所以这条公式里不含天赋项。
    const rawBase = new Rat(BigInt(species.Race[Stat.Hp]) * 2n, 2n)
      .div(new Rat(50n))
      .mul(new Rat(BigInt(level) + 25n));
    const base = rawBase.halfUp();
    const whiteboard = base + BigInt(level) + 10n;
    const spirit = new Rat(whiteboard).mul(natureMultiplier(nature, Stat.Hp, 0)).halfUp() + 22n;
    hp = spirit * BigInt(WILD_HP_SEGMENTS);
  } else {
    hp = panelHp;
  }
  hp = specialAdjust(species.Id, Stat.Hp, hp);

  const effective = [];
  const isEncounter = hpModel === 'EncounterPlus22';
  for (let stat = 0; stat < 6; stat++) {
    if (stat === Stat.Hp) { effective.push(hp); continue; }
    if (stat === Stat.Speed) { effective.push(null); continue; }
    if (isEncounter) {
      // 奇遇（破盾前）精灵：生命走 +22 口径，四维走原项目「强度系数」口径。
      //   四维 = 强度系数 × (理论面板 + 11)，理论面板 = (种族/100)×(等级+50) + 10（已乘性格修正）
      //   强度系数（F.cs 48-73）：1 星强度 攻2.8/防2.76、2 星 攻2.4/防1.9552、3 星 攻2.0/防1.38
      // 实测闭环：43 级奇遇可爱猿（stage1）物防理论面板 90 → 2.76×(90+11)=278.76 → 279，
      //   与「5★固执罗隐 地刺 暴击 2615」反推 279.1 吻合（胆小：速度+、物攻−、物防中性）。
      const stage = species.StrengthStage;
      if (stage === 1 || stage === 2 || stage === 3) {
        const coeff = strengthCoefficient(stage, stat);
        const value = coeff.mul(new Rat(theory[stat] + 11n)).halfUp();
        effective.push(specialAdjust(species.Id, stat, value));
      } else {
        effective.push(theory[stat]);
      }
      continue;
    }
    const stage = species.StrengthStage;
    if (stage === 1 || stage === 2 || stage === 3) {
      const coeff = strengthCoefficient(stage, stat);
      let value = coeff.mul(new Rat(theory[stat] + 11n)).halfUp();
      value = specialAdjust(species.Id, stat, value);
      effective.push(value);
    } else {
      effective.push(null);
    }
  }
  return { theory, hp, effective };
}

// 完整养成面板（己方精灵）。config: { talents:[6], stars, growth:[6] }
export function calcFullPanel(species, level, nature, config) {
  const out = [];
  for (let stat = 0; stat < 6; stat++) {
    const mult = natureMultiplier(nature, stat, config.stars || 0);
    out.push(calcPanelStat(
      species.Race[stat], level,
      config.talents[stat], mult, config.growth[stat] || 0,
      stat === Stat.Hp));
  }
  return out;
}
