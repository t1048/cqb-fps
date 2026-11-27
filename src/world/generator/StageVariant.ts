import type { MotifId, StageEntry } from '../../core/types';
import { normalizeSeed } from './Rng';

export interface PickedStageVariant {
  generator: string;
  /** 指定があればこのモチーフで飾る。undefined なら従来どおりシードから均等 */
  motif?: MotifId;
}

/** 生成器の乱数ストリームとは独立のハッシュ（salt で用途を分ける）。0 以上 1 未満。 */
function unit(seed: number, salt: number): number {
  let h = Math.imul(normalizeSeed(seed) ^ salt, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

function pickWeighted<T>(items: readonly (readonly [T, number])[], u: number): T | undefined {
  const pos = items.filter(([, w]) => w > 0);
  const total = pos.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return undefined;
  let acc = u * total;
  for (const [v, w] of pos) {
    acc -= w;
    if (acc < 0) return v;
  }
  return pos[pos.length - 1]![0];
}

/**
 * ステージの建物候補（variants）から、シードで生成器とモチーフを 1 つ決める。
 * 同じシードなら同じ結果。variants が無ければ stage.generator とシード由来のモチーフ。
 */
export function pickStageVariant(stage: StageEntry, seed: number): PickedStageVariant {
  const variants = stage.variants;
  if (!variants || variants.length === 0) return { generator: stage.generator };
  const v = pickWeighted(variants.map((x) => [x, x.weight] as const), unit(seed, 0x5bd1e995)) ?? variants[0]!;
  if (!v.motifs) return { generator: v.generator };
  const motif = pickWeighted(Object.entries(v.motifs) as [MotifId, number][], unit(seed, 0x27d4eb2f));
  return motif !== undefined ? { generator: v.generator, motif } : { generator: v.generator };
}
