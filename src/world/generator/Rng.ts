import type { NumRange } from '../../core/types';

/** シード付き擬似乱数（mulberry32）。同じシードなら同じ間取りを再現する。 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  inRange(r: NumRange): number {
    return this.range(r.min, r.max);
  }

  /** min〜max の整数（両端含む） */
  int(min: number, max: number): number {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (hi <= lo) return lo;
    return Math.min(hi, lo + Math.floor(this.next() * (hi - lo + 1)));
  }

  intInRange(r: NumRange): number {
    return this.int(r.min, r.max);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(this.next() * items.length)];
  }

  weighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined {
    let total = 0;
    for (const it of items) total += Math.max(0, weight(it));
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, weight(it));
      if (r < 0) return it;
    }
    return items[items.length - 1];
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }
}

/** UI・URL から受け取るシードの正規化（32bit 符号なし整数）。 */
export function normalizeSeed(value: number): number {
  return Math.abs(Math.trunc(value)) >>> 0;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}
