/**
 * 分隊の自律 CS ガス判定（純粋関数）。
 *
 * ガスは「撃ち合いの最中に投げる」ものではなく、「閉じた部屋に籠った相手を燻り出す」ための手段。
 * - 案1: チーム全体の接触が途切れて膠着した（制圧射撃も終わった）後でだけ投げる
 * - 案2: 目標は屋内の部屋の中で、投擲者はその部屋の外にいること（地点ではなく部屋へ投げ込む）
 */
import { SuspectState } from '../../core/events';
import type { RoomDef, Vec3 } from '../../core/types';
import { SWAT_SUPPRESS_END_SEC } from '../SwatProfile';
import { FLASH_TEAM_COOLDOWN, isPointInRoom } from './squadTypes';

/** チーム全員の交戦（視認・ペッパー・射線待ち）が途切れてから、ガスを検討するまでの秒数。制圧射撃の終了より後 */
export const GAS_STALEMATE_SEC = SWAT_SUPPRESS_END_SEC + 1.5;
/** 最後に見た位置を「籠っている」と信じる上限秒数（古すぎる情報ではガスを撃ち込まない） */
export const GAS_INTEL_MAX_AGE_SEC = 25;
/** 目標地点のガス濃度がこれ以上なら追加で投げない */
export const GAS_EXISTING_DENSITY_SKIP = 0.2;
/** 閃光弾を投げてからこの秒数はガスを重ねない */
export const GAS_AFTER_FLASH_SEC = 5;

/** 籠っている（燻り出しが有効な）とみなす容疑者ステート。投降・交渉・人質盾・無力化済みは除外 */
const DUG_IN_STATES: ReadonlySet<SuspectState> = new Set([
  SuspectState.BARRICADED,
  SuspectState.ALERT,
  SuspectState.CONFRONTATION,
  SuspectState.HESITATE,
  SuspectState.ENGAGE,
]);

/** 隊員が最後に視認した敵の情報（known と違い、視認喪失後もしばらく保持する） */
export interface GasIntel {
  suspectId: string;
  pos: Vec3;
  /** 最後に視認した simTime */
  t: number;
}

export type GasBlockReason =
  | 'teamContact'
  | 'staleIntel'
  | 'notDugIn'
  | 'notInRoom'
  | 'sameRoom'
  | 'playerInRoom'
  | 'gasPresent'
  | 'recentFlash';

export interface GasDecisionInput {
  simTime: number;
  /** チームの誰かが最後に交戦していた simTime */
  lastTeamContactT: number;
  intel: GasIntel;
  /** intel の容疑者の現在ステート（死亡・不在なら null） */
  suspectState: SuspectState | null;
  /** 投擲者の足元 */
  throwerPos: Vec3;
  /** プレイヤーの足元（その部屋にいるならガスを撃ち込まない） */
  playerPos?: Vec3;
  rooms: readonly RoomDef[];
  /** 目標地点の現在のガス濃度 0..1 */
  gasDensityAtTarget: number;
  /** チームの閃光弾クールダウン残り秒 */
  flashCd: number;
}

/** ガスを投げ込む先の部屋（屋内の部屋のみ）。無ければ null */
export function gasTargetRoom(pos: Vec3, rooms: readonly RoomDef[]): RoomDef | null {
  for (const r of rooms) {
    if (r.outdoor) continue;
    if (isPointInRoom(pos.x, pos.z, pos.y, r, 0)) return r;
  }
  return null;
}

/** 自律ガスを投げてはいけない理由。投げてよければ null */
export function gasBlockReason(input: GasDecisionInput): GasBlockReason | null {
  const { simTime, intel } = input;
  // 案1: 撃ち合い・制圧射撃が続いているうちは投げない
  if (simTime - input.lastTeamContactT < GAS_STALEMATE_SEC) return 'teamContact';
  if (simTime - intel.t > GAS_INTEL_MAX_AGE_SEC) return 'staleIntel';
  if (input.suspectState === null || !DUG_IN_STATES.has(input.suspectState)) return 'notDugIn';
  // 案2: 屋内の部屋に籠った相手だけ。投擲者が同じ部屋にいるなら（自分も燻される）投げない
  const room = gasTargetRoom(intel.pos, input.rooms);
  if (!room) return 'notInRoom';
  if (isPointInRoom(input.throwerPos.x, input.throwerPos.z, input.throwerPos.y, room)) return 'sameRoom';
  const pp = input.playerPos;
  if (pp && isPointInRoom(pp.x, pp.z, pp.y, room)) return 'playerInRoom';
  if (input.gasDensityAtTarget >= GAS_EXISTING_DENSITY_SKIP) return 'gasPresent';
  if (input.flashCd > FLASH_TEAM_COOLDOWN - GAS_AFTER_FLASH_SEC) return 'recentFlash';
  return null;
}
