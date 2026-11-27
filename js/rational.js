// 精确有理数：BigInt 分子 / 分母，对应原程序 a.E（E.cs）。
// 全程不使用浮点参与计算，避免误差；toNumber 仅用于界面展示。

function bigGcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

export class Rat {
  constructor(numerator, denominator = 1n) {
    numerator = BigInt(numerator);
    denominator = BigInt(denominator);
    if (denominator === 0n) throw new Error('分母不能为 0');
    // 分母归一为正
    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }
    // 自动约分
    const g = bigGcd(numerator, denominator);
    this.n = numerator / g;
    this.d = denominator / g;
  }

  static of(n, d) {
    if (n instanceof Rat) return n;
    return new Rat(n, d);
  }

  // 从十进制字符串/数字精确构造（如 2.5 -> 5/2，0.4 -> 2/5），不经过浮点。
  static fromDecimal(text) {
    if (text instanceof Rat) return text;
    let s = String(text).trim();
    let neg = false;
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    let [intPart, fracPart = ''] = s.split('.');
    const digits = (intPart === '' ? '0' : intPart) + fracPart;
    const numerator = BigInt(digits) * (neg ? -1n : 1n);
    const denominator = 10n ** BigInt(fracPart.length);
    return new Rat(numerator, denominator);
  }

  add(o) {
    o = Rat.of(o);
    return new Rat(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o) {
    o = Rat.of(o);
    return new Rat(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o) {
    o = Rat.of(o);
    return new Rat(this.n * o.n, this.d * o.d);
  }
  div(o) {
    o = Rat.of(o);
    return new Rat(this.n * o.d, this.d * o.n);
  }
  neg() {
    return new Rat(-this.n, this.d);
  }

  // 向负无穷取整（对应 E.A()）
  floor() {
    const q = this.n / this.d; // BigInt 向零取整
    const r = this.n % this.d;
    return r < 0n ? q - 1n : q;
  }

  // 向上取整（对应 E.a()）
  ceil() {
    const q = this.n / this.d;
    const r = this.n % this.d;
    return r > 0n ? q + 1n : q;
  }

  // 四舍五入 half-up（对应 E.B()）：+1/2 后 floor
  halfUp() {
    return this.add(new Rat(1n, 2n)).floor();
  }

  compareTo(o) {
    o = Rat.of(o);
    const lhs = this.n * o.d;
    const rhs = o.n * this.d;
    if (lhs < rhs) return -1;
    if (lhs > rhs) return 1;
    return 0;
  }
  equals(o) {
    o = Rat.of(o);
    return this.n === o.n && this.d === o.d;
  }
  lt(o) { return this.compareTo(o) < 0; }
  gt(o) { return this.compareTo(o) > 0; }
  le(o) { return this.compareTo(o) <= 0; }
  ge(o) { return this.compareTo(o) >= 0; }

  get isInteger() { return this.d === 1n; }

  // 仅用于展示，不参与计算
  toNumber() {
    return Number(this.n) / Number(this.d);
  }
  toString() {
    return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`;
  }
}

// 常用常量
export const RAT_ZERO = new Rat(0n);
export const RAT_ONE = new Rat(1n);
