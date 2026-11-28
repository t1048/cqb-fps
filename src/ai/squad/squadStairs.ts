import * as THREE from 'three';
import { t } from '../../core/i18n';
import type { Vec3 } from '../../core/types';
import type { StairMark } from '../../world/Walk';
import type { XZ } from '../EngageBehavior';
import {
  HOT_STAIR_FLASH,
  STAIR_ACK_DOWN,
  STAIR_ACK_UP,
  STAIR_CLEAR_DOWN,
  STAIR_CLEAR_UP,
  STAIR_MOVE_DOWN,
  STAIR_MOVE_UP,
  STAIR_STACK,
  pickRadio,
} from '../radioLines';
import { pathSegmentClear, stairEntry, stairExit, stairFloorY } from '../SquadRoute';
import { throwFlashbangAt } from './squadEntry';
import { isStandable, navigateTo } from './squadMovement';
import { ARRIVE_HYST, type AllyUnit, type SquadContext, type StairOp } from './squadTypes';

/**
 * 階段クリア（右クリックメニュー / Z で階段を見て指示）。
 *
 * 漫然と階段を昇降すると、上（下）の階口で待ち伏せる容疑者に頭から撃たれる（ファタルファネル）。
 * 階段クリアでは:
 *  1. 階段口にスタック（先頭は盾持ち優先）。先頭は出口へ、後続は出口の左右・頭上の吹き抜けへ、最後尾は後方へ照準
 *  2. （閃光＆階段クリア）出口の床へ閃光弾を投げ込み、炸裂を待つ
 *  3. 出口へ銃口を向けたまま、間隔を空けた縦列でゆっくり昇降（閃光後は速めに）
 *  4. 出口の先で扇状に展開し、前方・左右・後方を確保して報告
 */

/** スタック完了を待つ上限（秒）。全員が揃わなくても昇降へ移る */
export const STAIR_STACK_CAP_SEC = 6;
/** スタック位置の到着半径 */
const STAIR_SLOT_ARRIVE = 0.34;
/** 出口の確保位置の到着半径 */
const STAIR_EXIT_ARRIVE = 0.4;
/** 縦列の間隔: 前の隊員がこの距離（階段の進行方向）だけ進んだら次が発進する */
export const STAIR_FILE_GAP = 1.3;
/** 前の隊員が詰まっても次が発進するまでの秒 */
const STAIR_FILE_FAILSAFE_SEC = 2.6;
/** 素の階段クリアの昇降速度倍率（出口へ照準を置いたままゆっくり） */
export const STAIR_SLOW_SPEED_MUL = 0.55;
/** 閃光の炸裂後の昇降速度倍率（相手が目を潰されている間に押し込む） */
export const STAIR_FLASH_SPEED_MUL = 0.9;
/** 閃光の炸裂から昇降を始めるまでの余裕（秒） */
const STAIR_FLASH_SETTLE_SEC = 0.25;
/** 1 人あたりの昇降タイムアウト（秒）。詰まったらその場で確保扱いにする */
const STAIR_CLIMB_TIMEOUT_SEC = 16;
/** 昇降中の先頭の初弾（待ち伏せへの即応）: 拡散倍率と発数 */
const STAIR_PREAIM_SPREAD_MUL = 0.55;
const STAIR_PREAIM_SHOTS = 3;

const flashStartTmp = new THREE.Vector3();

/** 階段の水平進行方向（上りは下端→上端、下りは上端→下端）の単位ベクトル。 */
export function stairTravelDir(s: StairMark, up: boolean): XZ {
  const dx = up ? s.highX - s.lowX : s.lowX - s.highX;
  const dz = up ? s.highZ - s.lowZ : s.lowZ - s.highZ;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) {
    const ax = up ? s.approachHigh.x - s.approachLow.x : s.approachLow.x - s.approachHigh.x;
    const az = up ? s.approachHigh.z - s.approachLow.z : s.approachLow.z - s.approachHigh.z;
    const al = Math.hypot(ax, az) || 1;
    return { x: ax / al, z: az / al };
  }
  return { x: dx / len, z: dz / len };
}

/** 出口側の床高（上りは上階、下りは下階）。 */
export function stairExitFloorY(s: StairMark, up: boolean): number {
  return up ? s.topY : s.baseY;
}

function pickSlots(
  ctx: SquadContext,
  cands: readonly XZ[],
  n: number,
  y: number,
  from: XZ,
  fallback: (i: number) => XZ,
): XZ[] {
  const out: XZ[] = [];
  const taken = (p: XZ): boolean => out.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.6);
  for (const c of cands) {
    if (out.length >= n) break;
    if (taken(c)) continue;
    if (!isStandable(ctx, c.x, c.z, y)) continue;
    if (!pathSegmentClear(ctx.colliders, from, c, ctx.cfg.bodyRadius * 0.8, y)) continue;
    out.push(c);
  }
  for (let i = out.length; i < n; i++) out.push(fallback(i));
  return out;
}

/**
 * 階段口のスタック位置（先頭 = 進入点、後続はその後ろ。後ろが壁なら横へ）。
 * 進入点は階段の手前 0.45m（StairMark.approachLow / approachHigh）。
 */
export function computeStairStackSlots(ctx: SquadContext, s: StairMark, up: boolean, n: number): XZ[] {
  const e = stairEntry(s, up);
  const d = stairTravelDir(s, up);
  const px = -d.z;
  const pz = d.x;
  const y = stairFloorY(s, up);
  const cands: XZ[] = [{ x: e.x, z: e.z }];
  for (let i = 1; i <= 5; i++) {
    const back = 0.8 * i;
    cands.push({ x: e.x - d.x * back, z: e.z - d.z * back });
    for (const side of [1, -1]) {
      cands.push({ x: e.x - d.x * (back - 0.4) + px * side * 0.7, z: e.z - d.z * (back - 0.4) + pz * side * 0.7 });
    }
  }
  return pickSlots(ctx, cands, n, y, e, (i) => ({ x: e.x - d.x * 0.8 * i, z: e.z - d.z * 0.8 * i }));
}

/** 出口の確保位置（出口の先へ扇状に展開: 正面 → 左右 → 奥）。 */
export function computeStairExitSlots(ctx: SquadContext, s: StairMark, up: boolean, n: number): XZ[] {
  const e = stairExit(s, up);
  const d = stairTravelDir(s, up);
  const px = -d.z;
  const pz = d.x;
  const y = stairExitFloorY(s, up);
  const at = (fwd: number, lat: number): XZ => ({ x: e.x + d.x * fwd + px * lat, z: e.z + d.z * fwd + pz * lat });
  const cands: XZ[] = [
    at(1.1, 0),
    at(0.9, 0.95),
    at(0.9, -0.95),
    at(1.9, 0),
    at(0.3, 1.1),
    at(0.3, -1.1),
    at(1.9, 0.95),
    at(1.9, -0.95),
    at(2.7, 0),
    at(0.5, 0),
    at(1.2, 1.8),
    at(1.2, -1.8),
  ];
  return pickSlots(ctx, cands, n, y, e, () => ({ x: e.x, z: e.z }));
}

/** 出口の脅威点（先頭が照準を置く上階/下階の階段口の先）。 */
export function stairThreatPoint(s: StairMark, up: boolean): Vec3 {
  const e = stairExit(s, up);
  const d = stairTravelDir(s, up);
  return { x: e.x + d.x * 1.6, y: stairExitFloorY(s, up) + 1.25, z: e.z + d.z * 1.6 };
}

/** 縦列の k 番目が受け持つ照準点（0: 出口正面 / 1・2: 出口の左右 / 最後尾: 後方 / それ以外: 頭上の吹き抜け）。 */
export function stairSectorLook(s: StairMark, up: boolean, k: number, n: number, secured: boolean): Vec3 {
  const e = stairExit(s, up);
  const d = stairTravelDir(s, up);
  const px = -d.z;
  const pz = d.x;
  const y = stairExitFloorY(s, up) + 1.3;
  if (k === 0) {
    const fwd = secured ? 5 : 1.6;
    return { x: e.x + d.x * fwd, y, z: e.z + d.z * fwd };
  }
  if (k === 1 || k === 2) {
    const side = k === 1 ? 1 : -1;
    const lat = secured ? 5 : 1.8;
    const fwd = secured ? 0.6 : 0.8;
    return { x: e.x + d.x * fwd + px * side * lat, y, z: e.z + d.z * fwd + pz * side * lat };
  }
  if (secured || (k === n - 1 && n >= 4)) {
    // 出口側の床で階段穴の向こう（後方）: 吹き抜け越しの撃ち下ろし・背後を押さえる
    const back = secured ? 4 : 2.2;
    const lat = k % 2 === 0 ? 0.6 : -0.6;
    return { x: e.x - d.x * back + px * lat, y, z: e.z - d.z * back + pz * lat };
  }
  return { x: e.x - d.x * 1.4, y, z: e.z - d.z * 1.4 };
}

/** 階段の進入点→退出点の線分上での進み具合（m）。 */
export function stairProgress(s: StairMark, up: boolean, x: number, z: number): number {
  const a = stairEntry(s, up);
  const b = stairExit(s, up);
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const len = Math.hypot(vx, vz);
  if (len < 1e-6) return 0;
  return ((x - a.x) * vx + (z - a.z) * vz) / len;
}

/** 盾持ちを先頭に、残りは進入点に近い順。 */
function climbOrder(group: readonly AllyUnit[], s: StairMark, up: boolean): AllyUnit[] {
  const e = stairEntry(s, up);
  return [...group].sort((a, b) => {
    if (a.shielded !== b.shielded) return a.shielded ? -1 : 1;
    return Math.hypot(a.body.px - e.x, a.body.pz - e.z) - Math.hypot(b.body.px - e.x, b.body.pz - e.z);
  });
}

export type StairOrderMode = 'stack' | 'clear' | 'flash';

/** 階段クリアを発令する（指示の了解・メンバーの割り当て）。 */
export function beginStairOp(
  ctx: SquadContext,
  group: readonly AllyUnit[],
  stair: StairMark,
  up: boolean,
  mode: StairOrderMode,
): StairOp {
  const members = climbOrder(group, stair, up);
  const op: StairOp = {
    stair,
    up,
    flash: mode === 'flash',
    stackOnly: mode === 'stack',
    stage: 'stack',
    stageT: 0,
    elapsed: 0,
    members,
    stackSlots: computeStairStackSlots(ctx, stair, up, members.length),
    exitSlots: computeStairExitSlots(ctx, stair, up, members.length),
    tickedAt: -1,
    flashWait: -1,
    announced: false,
  };
  const order = mode === 'stack' ? 'stack' : mode === 'flash' ? 'stairFlashClear' : 'stairClear';
  members.forEach((ally, idx) => {
    ctx.resetUnitForOrder(ally, order);
    ally.roleIndex = idx;
    ally.groupSize = members.length;
    ally.stairOp = op;
    ally.stairStartT = -1;
    ally.phase = 'stair_stack';
    ally.progress = t('階段口へ移動', 'Moving to Stairs');
  });
  const lead = members[0];
  if (lead) {
    const [ja, en] = pickRadio(mode === 'stack' ? STAIR_STACK : up ? STAIR_ACK_UP : STAIR_ACK_DOWN);
    ctx.emitRadio(lead, ja, en);
  }
  return op;
}

function alive(op: StairOp): AllyUnit[] {
  return op.members.filter((m) => !m.down && m.stairOp === op);
}

function slotIndex(op: StairOp, ally: AllyUnit): number {
  return Math.max(0, op.members.indexOf(ally));
}

/** グループ単位の段階遷移（1 フレーム 1 回）。 */
function tickStairOp(ctx: SquadContext, op: StairOp, dt: number): void {
  if (op.tickedAt === ctx.simTime) return;
  op.tickedAt = ctx.simTime;
  op.stageT += dt;
  op.elapsed += dt;
  const live = alive(op);
  if (live.length === 0) return;

  if (op.stage === 'stack') {
    if (op.stackOnly) return;
    const ready = live.every((m) => m.phase === 'stair_stack' && m.settled);
    if (!ready && op.elapsed < STAIR_STACK_CAP_SEC) return;
    if (op.flash && ctx.flashesLeft > 0) {
      const thrower = live.find((m) => !m.shielded) ?? live[0]!;
      const target = stairExit(op.stair, op.up);
      const d = stairTravelDir(op.stair, op.up);
      const start = thrower.body.eye(flashStartTmp);
      start.x += d.x * 0.25;
      start.z += d.z * 0.25;
      throwFlashbangAt(ctx, thrower, start, {
        x: target.x + d.x * 1.1,
        y: stairExitFloorY(op.stair, op.up) + 0.08,
        z: target.z + d.z * 1.1,
      });
      const [ja, en] = pickRadio(HOT_STAIR_FLASH);
      ctx.emitRadio(thrower, ja, en);
      op.flashWait = Math.max(0.35, ctx.cfg.flashDelay) + STAIR_FLASH_SETTLE_SEC;
      op.stage = 'flash';
      op.stageT = 0;
      return;
    }
    op.flash = false;
    startClimb(ctx, op, live);
    return;
  }

  if (op.stage === 'flash') {
    if (op.stageT >= op.flashWait) startClimb(ctx, op, live);
    return;
  }

  if (op.stage === 'climb') {
    if (live.every((m) => m.phase === 'stair_secure')) {
      op.stage = 'secure';
      op.stageT = 0;
      if (!op.announced) {
        op.announced = true;
        const [ja, en] = pickRadio(op.up ? STAIR_CLEAR_UP : STAIR_CLEAR_DOWN);
        ctx.emitRadio(live[0]!, ja, en);
      }
    }
  }
}

function startClimb(ctx: SquadContext, op: StairOp, live: readonly AllyUnit[]): void {
  op.stage = 'climb';
  op.stageT = 0;
  for (const m of live) {
    m.phase = 'stair_climb';
    m.settled = false;
    m.stairStartT = -1;
  }
  const [ja, en] = pickRadio(op.up ? STAIR_MOVE_UP : STAIR_MOVE_DOWN);
  ctx.emitRadio(live[0]!, ja, en);
}

/** 縦列の k 番目が発進してよいか（前の生存メンバーが STAIR_FILE_GAP 進んだ / 確保済み / 詰まり）。 */
function fileGateOpen(ctx: SquadContext, op: StairOp, ally: AllyUnit): boolean {
  const idx = slotIndex(op, ally);
  for (let i = idx - 1; i >= 0; i--) {
    const prev = op.members[i]!;
    if (prev.down || prev.stairOp !== op) continue;
    if (prev.phase === 'stair_secure') return true;
    if (prev.stairStartT < 0) return false;
    if (ctx.simTime - prev.stairStartT >= STAIR_FILE_FAILSAFE_SEC) return true;
    const onExitFloor = Math.abs(prev.body.footY - stairExitFloorY(op.stair, op.up)) < 0.4;
    return onExitFloor || stairProgress(op.stair, op.up, prev.body.px, prev.body.pz) >= STAIR_FILE_GAP;
  }
  return true;
}

function aimAtLook(ally: AllyUnit, p: Vec3, dt: number, rate = Math.PI * 2): void {
  if (ally.engaging) return;
  ally.body.faceToward(p.x, p.z, rate * dt);
  ally.body.aimAt(p.x, p.y, p.z, dt, rate * dt);
}

function updateStackStage(ctx: SquadContext, ally: AllyUnit, op: StairOp, dt: number): void {
  const body = ally.body;
  const idx = slotIndex(op, ally);
  const slot = op.stackSlots[idx] ?? stairEntry(op.stair, op.up);
  const y = stairFloorY(op.stair, op.up);
  const d = Math.hypot(slot.x - body.px, slot.z - body.pz);
  const sameFloor = Math.abs(body.footY - y) < 0.4;
  if (ally.settled) {
    if (!sameFloor || d > STAIR_SLOT_ARRIVE + ARRIVE_HYST) ally.settled = false;
  } else if (sameFloor && d <= STAIR_SLOT_ARRIVE) {
    ally.settled = true;
  }
  if (!ally.settled) {
    ally.progress = t('階段口へ移動', 'Moving to Stairs');
    if (!ally.engaging) navigateTo(ctx, ally, slot.x, slot.z, y, dt, true, true);
    return;
  }
  ally.stalled = 0;
  ally.stuckStage = 0;
  ally.anchor = { x: body.px, z: body.pz };
  const n = op.members.length;
  aimAtLook(ally, idx === 0 ? stairThreatPoint(op.stair, op.up) : stairSectorLook(op.stair, op.up, idx, n, false), dt);
  if (op.stage === 'flash') ally.progress = t('閃光炸裂待ち', 'Waiting on the Bang');
  else if (op.stackOnly) ally.progress = t('階段口で待機', 'Holding at Stairs');
  else ally.progress = t('階段口スタック完了', 'Stacked at Stairs');
}

function updateClimbStage(ctx: SquadContext, ally: AllyUnit, op: StairOp, dt: number): void {
  const body = ally.body;
  const s = op.stair;
  const idx = slotIndex(op, ally);
  const n = op.members.length;
  const exitY = stairExitFloorY(s, op.up);
  const entryY = stairFloorY(s, op.up);
  const slot = op.exitSlots[idx] ?? stairExit(s, op.up);
  const look = idx === 0 ? stairThreatPoint(s, op.up) : stairSectorLook(s, op.up, idx, n, false);

  if (ally.stairStartT < 0) {
    if (!fileGateOpen(ctx, op, ally)) {
      ally.progress = t('縦列で発進待ち', 'Waiting in File');
      // 待機中もスタック位置を保つ
      const stackSlot = op.stackSlots[idx];
      if (stackSlot && Math.hypot(stackSlot.x - body.px, stackSlot.z - body.pz) > STAIR_SLOT_ARRIVE + ARRIVE_HYST && !ally.engaging) {
        navigateTo(ctx, ally, stackSlot.x, stackSlot.z, entryY, dt, true, true);
      } else {
        aimAtLook(ally, look, dt);
      }
      return;
    }
    ally.stairStartT = ctx.simTime;
    // 出口へ照準を置いたまま上る: 現れた相手への初弾を締める
    if (!ally.engageActive) ally.engage.armPreAim(STAIR_PREAIM_SHOTS, STAIR_PREAIM_SPREAD_MUL);
  }

  const onExitFloor = Math.abs(body.footY - exitY) < 0.4 && ally.activeStair === null;
  const dSlot = Math.hypot(slot.x - body.px, slot.z - body.pz);
  if (onExitFloor && dSlot <= STAIR_EXIT_ARRIVE) {
    ally.phase = 'stair_secure';
    ally.settled = true;
    ally.holdPos = { x: slot.x, y: exitY, z: slot.z };
    ally.progress = t('階段口確保', 'Landing Secured');
    return;
  }
  if (ctx.simTime - ally.stairStartT >= STAIR_CLIMB_TIMEOUT_SEC) {
    // 詰まった: その場で確保扱い（指示の流れを止めない）
    ally.phase = 'stair_secure';
    ally.settled = true;
    ally.holdPos = { x: body.px, y: body.footY, z: body.pz };
    return;
  }
  // 交戦中はその場で撃ち合う（漫然と前へ出続けない）
  if (ally.engaging) {
    ally.progress = t('階段で交戦', 'Contact on Stairs');
    return;
  }

  const speed = ally.combat.moveSpeed * (op.flash ? STAIR_FLASH_SPEED_MUL : STAIR_SLOW_SPEED_MUL);
  const entry = stairEntry(s, op.up);
  const onEntryFloor = Math.abs(body.footY - entryY) < 0.3;
  if (ally.activeStair === null && onEntryFloor) {
    // 進入点に着くまでは床を歩き、着いたらこの階段で昇降を始める（別の階段を選ばせない）
    const dEntry = Math.hypot(entry.x - body.px, entry.z - body.pz);
    if (dEntry > Math.max(0.3, ctx.cfg.stairArrive * 0.5)) {
      navigateTo(ctx, ally, entry.x, entry.z, entryY, dt, true, false, null, speed, false);
      aimAtLook(ally, look, dt);
      ally.progress = op.up ? t('階段下へ前進', 'Moving to the Stairs') : t('階段上へ前進', 'Moving to the Stairs');
      return;
    }
    ally.activeStair = { id: s.id, up: op.up };
    ally.stairPick = null;
  }
  navigateTo(ctx, ally, slot.x, slot.z, exitY, dt, true, false, null, speed);
  // 昇降中も銃口は出口へ（進行方向へは向けない）
  aimAtLook(ally, onExitFloor ? stairSectorLook(s, op.up, idx, n, true) : look, dt, Math.PI * 2.4);
  ally.progress = op.up ? t('階段を警戒前進（上り）', 'Clearing Stairs (Up)') : t('階段を警戒前進（下り）', 'Clearing Stairs (Down)');
}

function updateSecureStage(ctx: SquadContext, ally: AllyUnit, op: StairOp, dt: number): void {
  const body = ally.body;
  const idx = slotIndex(op, ally);
  const hp = ally.holdPos;
  if (hp && !ally.engaging) {
    const d = Math.hypot(hp.x - body.px, hp.z - body.pz);
    if (d > STAIR_EXIT_ARRIVE + ARRIVE_HYST || Math.abs(hp.y - body.footY) > 0.4) {
      navigateTo(ctx, ally, hp.x, hp.z, hp.y, dt, true, true);
      ally.progress = t('確保位置へ戻る', 'Returning to Position');
      return;
    }
  }
  ally.stalled = 0;
  ally.stuckStage = 0;
  ally.anchor = { x: body.px, z: body.pz };
  aimAtLook(ally, stairSectorLook(op.stair, op.up, idx, op.members.length, true), dt, Math.PI * 1.4);
  ally.progress = op.up ? t('階段上を確保・警戒', 'Holding Top of Stairs') : t('階段下を確保・警戒', 'Holding Bottom of Stairs');
}

/** stair_stack / stair_climb / stair_secure の隊員 1 名分の更新。 */
export function updateStairPhase(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const op = ally.stairOp;
  if (!op) {
    ally.phase = 'hold';
    ally.holdPos = { x: ally.body.px, y: ally.body.footY, z: ally.body.pz };
    ally.watchYaw = ally.body.yawRad;
    return;
  }
  tickStairOp(ctx, op, dt);
  if (ally.phase === 'stair_stack') {
    // グループが昇降に移ったのにまだスタック中（発令後に揃わなかった等）
    if (op.stage === 'climb' || op.stage === 'secure') ally.phase = 'stair_climb';
    else return updateStackStage(ctx, ally, op, dt);
  }
  if (ally.phase === 'stair_climb') return updateClimbStage(ctx, ally, op, dt);
  updateSecureStage(ctx, ally, op, dt);
}

/** その階段で作業中（スタックの昇降待ち以外）のメンバーがいるか（Z の多重発令防止）。 */
export function stairOpBusy(group: readonly AllyUnit[], stairId: string): boolean {
  return group.some(
    (a) =>
      !a.down &&
      a.stairOp !== null &&
      a.stairOp.stair.id === stairId &&
      !a.stairOp.stackOnly &&
      (a.stairOp.stage === 'stack' || a.stairOp.stage === 'flash' || a.stairOp.stage === 'climb'),
  );
}
