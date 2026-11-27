// 开闭区间 [lower, upper] / (lower, upper) 等，对应原程序 Z（Z.cs）。
// 端点用精确有理数，边界可分别指定是否包含。

import { Rat } from './rational.js?v=126';

export class Interval {
  constructor(lower, lowerInclusive, upper, upperInclusive) {
    this.lower = Rat.of(lower);
    this.upper = Rat.of(upper);
    this.li = !!lowerInclusive;
    this.ui = !!upperInclusive;
  }

  get isEmpty() {
    if (this.lower.gt(this.upper)) return true;
    if (this.lower.equals(this.upper)) {
      // 端点相等：只有两端都包含时才非空
      return !(this.li && this.ui);
    }
    return false;
  }

  // 区间内整数集合，返回 {min, max}（BigInt）；空区间返回 null。对应 Z.Integers。
  integers() {
    if (this.isEmpty) return null;
    const min = this.li ? this.lower.ceil() : this.lower.floor() + 1n;
    const max = this.ui ? this.upper.floor() : this.upper.ceil() - 1n;
    if (min > max) return null;
    return { min, max };
  }

  // 是否包含某个有理数。对应 Z.A(value)。
  contains(value) {
    value = Rat.of(value);
    if (this.isEmpty) return false;
    const aboveLower = value.gt(this.lower) || (this.li && value.equals(this.lower));
    if (!aboveLower) return false;
    if (value.lt(this.upper)) return true;
    return this.ui && value.equals(this.upper);
  }

  // 区间交集，精确处理边界开闭。对应 Z.A(Z)。
  intersect(other) {
    const lower = this.lower.ge(other.lower) ? this.lower : other.lower;
    const upper = this.upper.le(other.upper) ? this.upper : other.upper;
    const li =
      (lower.equals(this.lower) ? this.li : true) &&
      (lower.equals(other.lower) ? other.li : true);
    const ui =
      (upper.equals(this.upper) ? this.ui : true) &&
      (upper.equals(other.upper) ? other.ui : true);
    return new Interval(lower, li, upper, ui);
  }

  toString() {
    return `${this.li ? '[' : '('}${this.lower}, ${this.upper}${this.ui ? ']' : ')'}`;
  }
}
