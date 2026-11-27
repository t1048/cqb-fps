import type { WoundsConfig } from '../core/types';

/** 負傷レベル: 0=健常 / 1=負傷(HP < lv1Below) / 2=重傷(HP < lv2Below)。HP 0 は死亡で別扱い。 */
export type WoundLevel = 0 | 1 | 2;

export function woundLevelOf(hp: number, maxHp: number, w: WoundsConfig): WoundLevel {
  if (maxHp <= 0 || hp <= 0) return 0;
  const ratio = hp / maxHp;
  if (ratio < w.lv2Below) return 2;
  if (ratio < w.lv1Below) return 1;
  return 0;
}

/**
 * 頭部命中か。基準は「頭頂/目線の高さ」で、そこから band(m) 以内の高さへの命中を頭部とみなす。
 * プレイヤーは目線高さ、隊員は身長×0.9 付近を headRefY に渡す。
 */
export function isHeadHit(hitY: number | undefined, headRefY: number, band: number): boolean {
  return hitY !== undefined && Number.isFinite(hitY) && hitY >= headRefY - band;
}

/** 被弾ダメージに頭部倍率を適用する。 */
export function applyHeadMultiplier(damage: number, head: boolean, multiplier: number): number {
  return head ? damage * multiplier : damage;
}
