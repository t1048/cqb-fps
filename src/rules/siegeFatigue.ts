/**
 * 籠城の消耗（0..100）から効果を求める純関数。設定は public/data/siege.json。
 * 段階 0（消耗 < tiers[0]）は効果なし。
 */
import type { SiegeAiFatigue, SiegePlayerFatigue } from '../core/types';

export type FatigueTier = 0 | 1 | 2;

/** v >= tiers[1] → 2、v >= tiers[0] → 1、他 0 */
export function fatigueTier(v: number, tiers: readonly [number, number]): FatigueTier {
  if (v >= tiers[1]) return 2;
  if (v >= tiers[0]) return 1;
  return 0;
}

export interface PlayerFatigueEffects {
  /** カメラの揺れの振幅（度。見た目だけ） */
  swayDeg: number;
  /** 射撃拡散の加算（度） */
  spreadAddDeg: number;
  /** 装填時間の倍率（>= 1） */
  reloadMul: number;
  /** 移動速度の倍率（<= 1） */
  speedMul: number;
}

export const NO_PLAYER_FATIGUE: PlayerFatigueEffects = { swayDeg: 0, spreadAddDeg: 0, reloadMul: 1, speedMul: 1 };

export function playerFatigueEffects(v: number, cfg: SiegePlayerFatigue): PlayerFatigueEffects {
  const tier = fatigueTier(v, cfg.tiers);
  if (tier === 0) return { ...NO_PLAYER_FATIGUE };
  const i = tier - 1;
  return {
    swayDeg: cfg.swayDeg[i],
    spreadAddDeg: cfg.spreadAddDeg[i],
    reloadMul: cfg.reloadMul[i],
    speedMul: cfg.speedMul[i],
  };
}

export interface AiFatigueEffects {
  /** 基本拡散の倍率（>= 1） */
  spreadMul: number;
  /** 反応時間への加算（秒） */
  reactionAddSec: number;
  /** 士気の変化量（<= 0） */
  moraleDelta: number;
}

/** n = clamp(v, 0, 100) / 100。 */
export function aiFatigueEffects(v: number, cfg: SiegeAiFatigue): AiFatigueEffects {
  const n = Math.min(100, Math.max(0, v)) / 100;
  return {
    spreadMul: 1 + cfg.spreadMulPerNorm * n,
    reactionAddSec: cfg.reactionAddSecAt100 * n,
    moraleDelta: -cfg.moralePenaltyAt100 * n,
  };
}
