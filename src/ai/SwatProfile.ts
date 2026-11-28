import type { CombatParams, MobilityParams } from '../core/types';

/**
 * 共通 SWAT 隊員プロファイル（ライフルマン / 盾持ちポイントマン）。
 * 容疑者モード（SwatTeam）と SWAT モード（Squad）の双方で単一の真実源として参照する。
 * 実行時の圧力カーブ等で書き換える場合は cloneCombatProfile / cloneMobilityProfile で複製すること。
 */
export const BASE_SWAT_COMBAT: Readonly<CombatParams> = Object.freeze({
  decisionSec: 0.7,
  alertCalmSec: 10,
  hesitateFireSec: 3,
  hesitateRetreatSpeed: 0.8,
  hesitateRetreatMax: 1.5,
  hesitateShakeDeg: 0,
  moveSpeed: 2.35,
  fireInterval: 0.2,
  shotsPerPeek: 4,
  magazineSize: 30,
  reloadSec: 2.2,
  coverSecMin: 0.9,
  coverSecMax: 1.8,
  peekSecMax: 1.4,
  engageRange: 18,
  coverSearchRange: 6,
  coverMargin: 0.45,
  crouchCoverMaxHeight: 1.5,
  flinchSec: 0.35,
  gunshotNoiseRadius: 40,
  shotDamage: 13,
  baseSpreadDeg: 3.2,
});

export const BASE_SWAT_MOBILITY: Readonly<MobilityParams> = Object.freeze({
  canOpenDoors: true,
  canUseStairs: true,
  patrolChance: 0,
  patrolIntervalMin: 99,
  patrolIntervalMax: 99,
  patrolSpeedScale: 0.6,
  investigateChance: 1,
  investigateMaxDist: 40,
  investigateSpeedScale: 0.9,
  reinforceOnGunshot: true,
  repositionAfterLostSec: 2.6,
  flankChance: 0.5,
  guardHostageRoom: false,
});

/**
 * 盾持ち隊員（ポイントマン）の基準プロファイル。
 * 防弾盾を構えてハンドガンで撃ちながら前進し、遮蔽には籠らず見失えば即座に詰める。
 */
export const BASE_SHIELD_COMBAT: Readonly<CombatParams> = Object.freeze({
  ...BASE_SWAT_COMBAT,
  moveSpeed: 1.95,
  fireInterval: 0.32,
  shotsPerPeek: 5,
  magazineSize: 15,
  reloadSec: 1.8,
  coverSecMin: 0.25,
  coverSecMax: 0.5,
  peekSecMax: 2.4,
  coverSearchRange: 0,
  flinchSec: 0.06,
  shotDamage: 9,
  baseSpreadDeg: 2.6,
});

export const BASE_SHIELD_MOBILITY: Readonly<MobilityParams> = Object.freeze({
  ...BASE_SWAT_MOBILITY,
  repositionAfterLostSec: 0.5,
  flankChance: 0,
});

/** 不変テンプレートから変更可能な CombatParams 複製を生成する。 */
export function cloneCombatProfile(base: Readonly<CombatParams>): CombatParams {
  return { ...base };
}

/** 不変テンプレートから変更可能な MobilityParams 複製を生成する。 */
export function cloneMobilityProfile(base: Readonly<MobilityParams>): MobilityParams {
  return { ...base };
}

/** 2 名以上の編成において先頭（index === 0）を盾持ちポイントマンとする。 */
export function isShieldRole(index: number, total: number): boolean {
  return index === 0 && total >= 2;
}

// ---------- 共通 SWAT コンディション・戦術・演出定数 ----------

export const SWAT_HP = 100;
export const SWAT_UNIFORM_COLOR = 0x2b3440;
export const SWAT_READY_POSE = 'high' as const;

export const SWAT_PEPPER_INTERVAL = 0.42;
export const SWAT_PEPPER_RANGE = 20;

export const SWAT_RUSH_LOW_HP = 40;
export const SWAT_RUSH_RADIUS = 7;
export const SWAT_RUSH_DURATION_SEC = 3.0;
export const SWAT_RUSH_TEAM_COOLDOWN = 14.0;
export const SWAT_RUSH_SPEED_MIN = 2.25;
export const SWAT_RUSH_SPEED_MAX = 2.45;
export const SWAT_SHIELD_RUSH_SPEED = 2.15;

export const SWAT_SUPPRESS_START_SEC = 0.35;
export const SWAT_SUPPRESS_END_SEC = 3.5;
export const SWAT_SUPPRESS_INTERVAL = 0.5;

export const SWAT_C2_PLANT_SEC = 0.8;
export const SWAT_C2_FUSE_SEC = 1.8;
export const SWAT_C2_URGENT_AT_SEC = 1.1;
export const SWAT_C2_BEEP_INTERVAL = 0.45;
export const SWAT_C2_URGENT_BEEP_INTERVAL = 0.2;
export const SWAT_C2_BLAST_RADIUS = 4.5;
export const SWAT_C2_BLAST_HALF_ANGLE_DEG = 70;
export const SWAT_C2_MAX_DAMAGE = 45;

export const SWAT_FLASH_PER_TEAM = 3;
export const SWAT_FLASH_CARRY_MAX = 4;
export const SWAT_FLASH_MIN_DIST = 3.2;
export const SWAT_FLASH_MAX_DIST = 9;

export const SWAT_GAS_PER_TEAM = 3;
export const SWAT_GAS_MIN_DIST = 2.0;
export const SWAT_GAS_MAX_DIST = 13.0;

export const SWAT_RADIO_STAGGER_SEC = 1.25;

export const SWAT_FOOTSTEP_STRIDE_FAST = 0.85;
export const SWAT_FOOTSTEP_STRIDE_NORMAL = 1.05;
