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
 * allowedMotifs が指定された場合、許可されたモチーフに絞り込んで選択する（未指定時は従来と完全同一）。
 */
export function pickStageVariant(
  stage: StageEntry,
  seed: number,
  allowedMotifs?: readonly string[],
): PickedStageVariant {
  const filter = allowedMotifs && allowedMotifs.length > 0 ? new Set(allowedMotifs) : null;
  const variants = stage.variants;
  if (!variants || variants.length === 0) {
    if (filter) {
      const motif = pickWeighted(
        allowedMotifs!.map((m) => [m as MotifId, 1] as const),
        unit(seed, 0x27d4eb2f),
      );
      return motif !== undefined ? { generator: stage.generator, motif } : { generator: stage.generator };
    }
    return { generator: stage.generator };
  }
  const eligibleVariants = filter
    ? variants.filter((x) =>
        x.motifs ? Object.keys(x.motifs).some((m) => filter.has(m)) : filter.has(x.generator),
      )
    : variants;
  const pool = eligibleVariants.length > 0 ? eligibleVariants : variants;
  const v = pickWeighted(pool.map((x) => [x, x.weight] as const), unit(seed, 0x5bd1e995)) ?? pool[0]!;
  if (!v.motifs) return { generator: v.generator };
  const allEntries = Object.entries(v.motifs) as [MotifId, number][];
  const entries = filter ? allEntries.filter(([m]) => filter.has(m)) : allEntries;
  const motif =
    entries.length > 0
      ? pickWeighted(entries, unit(seed, 0x27d4eb2f))
      : filter
        ? pickWeighted(
            allowedMotifs!.map((m) => [m as MotifId, 1] as const),
            unit(seed, 0x27d4eb2f),
          )
        : undefined;
  return motif !== undefined ? { generator: v.generator, motif } : { generator: v.generator };
}
