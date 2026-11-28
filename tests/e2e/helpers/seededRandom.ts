import { vi } from 'vitest';

/** mulberry32: 小さく速い決定論的な擬似乱数 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Math.random を決定論的な乱数に差し替える（戻すには vi.restoreAllMocks() か返り値の mockRestore()）。
 * AI の判断（突撃するか・どの戦術を選ぶか等）が乱数で分岐するシナリオを、実行ごとに揺らさないために使う。
 */
export function seedRandom(seed: number): { mockRestore(): void } {
  return vi.spyOn(Math, 'random').mockImplementation(mulberry32(seed));
}
