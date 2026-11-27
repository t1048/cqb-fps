import type { Vec3 } from '../core/types';

/**
 * 容疑者モード: SWAT が拘束しに行く味方 NPC 容疑者の最小インターフェース（EntityManager が Suspect を包んで渡す）。
 * 投降(surrendered) → SWAT が手錠をかける(cuff) → 拘束済み(restrained)。プレイヤーが解放すれば戦線に復帰する。
 */
export interface RestrainTarget {
  readonly id: string;
  readonly px: number;
  readonly pz: number;
  readonly footY: number;
  readonly alive: boolean;
  /** 投降して拘束待ち（手錠はまだ） */
  readonly surrendered: boolean;
  /** 手錠をかけられた */
  readonly restrained: boolean;
  /** 偽装投降の確率 (0..1)。ai_profiles.json の fakeSurrenderChance */
  readonly fakeChance: number;
  /** 手錠をかけた。受理されたら true */
  cuff(): boolean;
  /** 偽装投降の反撃（拘束に来た隊員の位置へ）。受理されたら true */
  betray(at: Vec3): boolean;
}

/** 拘束にかかる時間(s)・拘束位置への接近距離(m) など */
export const CUFF_SEC = 3.5;
