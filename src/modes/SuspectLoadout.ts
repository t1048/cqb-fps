/**
 * 容疑者モードの持ち込み装備。屋内床面積（MissionRoster.indoorFloorArea と同じ尺度）だけから決める。
 *
 * 大きな建物を占拠する一味ほど、長い籠城に備えて弾薬・トラップ部材・補強材・救急キットを多く持ち込んでいる。
 * 小さな民家（〜400㎡）は従来と同じ装備で、そこから面積に比例して増やし、上限で頭打ちにする。
 *
 * 予備マガジン = clamp(3 + round((面積 - 400) / 200), 3, 10)
 *   小 300〜600㎡ ≒ 3〜4 本、中 600〜1450㎡ ≒ 4〜8 本、大 1100〜2050㎡ ≒ 7〜10 本
 * トラップ部材 = clamp(2 + round((面積 - 400) / 320), 2, 6)   開始時に手元にある数
 * 製作トラップ = clamp(2 + round((面積 - 400) / 600), 2, 4)   準備中に仲間が追加で作る数
 * 救急キット   = clamp(round((面積 - 400) / 550), 0, 3)        交渉で増やせる分とは別の初期所持
 * 補強材倍率   = clamp(1 + (面積 - 400) / 2200, 1, 1.75)       窓バリケードの耐久倍率（合板の重ね張り・鉄板）
 */
import type { SuspectAllyPolicy, SuspectPrimaryWeaponId, SuspectVestTier } from '../rules/Progression';

export const LOADOUT_BASE_SQ_M = 400;

export interface SuspectLoadoutOptions {
  primaryWeapon?: SuspectPrimaryWeaponId;
  vest?: SuspectVestTier;
  allyPolicy?: SuspectAllyPolicy;
}

export interface SuspectLoadout {
  /** 主武器の予備マガジン本数（weapons.json の reserveMagazines を置き換える） */
  reserveMagazines: number;
  /** 開始時のトラップ部材 */
  trapKits: number;
  /** 準備中に仲間が製作するトラップの数 */
  craftedTraps: number;
  /** 開始時の救急キット */
  medkits: number;
  /** 窓バリケードの耐久倍率 */
  barricadeHpMul: number;
  /** 選択された容疑者プライマリ武器 ID（ロードアウト指定時のみ設定） */
  primaryWeapon?: SuspectPrimaryWeaponId;
  /** 選択された防弾ベスト種別（ロードアウト指定時のみ設定） */
  vest?: SuspectVestTier;
  /** 選択された仲間の方針（ロードアウト指定時のみ設定） */
  allyPolicy?: SuspectAllyPolicy;
  /** 方針に応じた仲間の準備作業速度倍率（ロードアウト指定時のみ設定） */
  allyWorkRateMul?: number;
}

/** 仲間の方針に応じた準備作業速度倍率（Fortify の武器改造・トラップ製作速度） */
export function allyWorkRateForPolicy(policy: SuspectAllyPolicy): number {
  if (policy === 'fortify') return 1.45;
  if (policy === 'aggressive') return 0.75;
  return 1.0;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function suspectLoadout(indoorSqMeters: number, opts?: SuspectLoadoutOptions): SuspectLoadout {
  const extra = Math.max(0, indoorSqMeters - LOADOUT_BASE_SQ_M);
  const base: SuspectLoadout = {
    reserveMagazines: clamp(3 + Math.round(extra / 200), 3, 10),
    trapKits: clamp(2 + Math.round(extra / 320), 2, 6),
    craftedTraps: clamp(2 + Math.round(extra / 600), 2, 4),
    medkits: clamp(Math.round(extra / 550), 0, 3),
    barricadeHpMul: Math.round(clamp(1 + extra / 2200, 1, 1.75) * 100) / 100,
  };
  if (!opts) return base;
  const allyPolicy: SuspectAllyPolicy = opts.allyPolicy ?? 'balanced';
  const craftedTraps = allyPolicy === 'fortify' ? base.craftedTraps + 1 : base.craftedTraps;
  const barricadeHpMul =
    allyPolicy === 'fortify' ? Math.round(clamp(base.barricadeHpMul * 1.15, 1, 2.0) * 100) / 100 : base.barricadeHpMul;
  return {
    ...base,
    craftedTraps,
    barricadeHpMul,
    primaryWeapon: opts.primaryWeapon ?? 'machine_pistol',
    vest: opts.vest ?? 'none',
    allyPolicy,
    allyWorkRateMul: allyWorkRateForPolicy(allyPolicy),
  };
}
