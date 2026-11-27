/**
 * 分隊のチーム戦術ディレクター（Utility AI）。
 *
 * 隊員ごとに毎フレーム「投げられるなら投げる」をやめ、チーム単位で手段を採点して段階的に強める:
 *   射撃 → 制圧射撃 → 閃光弾 → (膠着が続けば) CS ガス → 突入 or 出口封鎖
 * 一度選んだ手段は最低保持時間と切替マージン（ヒステリシス）で簡単には切り替えない。
 *
 * CS ガスは「宣言 → 援護 → 投擲 → その後の行動」の一連の作戦（GasOperation）として実行する:
 *   1. windup: 投擲者が遮蔽（敵から射線が通らない位置）でしゃがみ「ガスを投げる、カバー！」。他は出入口を見張る。
 *      構え中にチームの誰かが接触したら中止。
 *   2. 投擲後: 採点で「マスクを着けて突入（gasClear の突入フロー）」か「出口封鎖（出てきた相手を待つ）」を選ぶ。
 */
import * as THREE from 'three';
import { SuspectState } from '../../core/events';
import { t } from '../../core/i18n';
import type { RoomDef, Vec3 } from '../../core/types';
import type { Door } from '../../world/Door';
import { GAS_CLOUD_DURATION } from '../../weapons/TearGas';
import { GAS, GAS_ABORT, GAS_CONTAIN, GAS_COVER, GAS_PUSH, pickRadio } from '../radioLines';
import { SWAT_GAS_MAX_DIST, SWAT_GAS_MIN_DIST, SWAT_SUPPRESS_END_SEC, SWAT_SUPPRESS_START_SEC } from '../SwatProfile';
import { findRoomDoors, planFlashThrow } from '../SwatTactics';
import { assignPortalGroup } from './squadEntry';
import { GAS_STALEMATE_SEC, gasBlockReason, gasTargetRoom, type GasIntel } from './squadGas';
import {
  GAS_TEAM_COOLDOWN,
  flankDoorSamples,
  isPointInRoom,
  type AllyUnit,
  type EntryPortal,
  type SquadContext,
} from './squadTypes';

// ───────────────────────── Utility 採点（純粋関数） ─────────────────────────

export type TeamTactic = 'engage' | 'suppress' | 'flash' | 'gas' | 'hold';
export const TEAM_TACTICS: readonly TeamTactic[] = ['engage', 'suppress', 'flash', 'gas', 'hold'];

export interface TacticConsiderations {
  /** チームの最終交戦からの経過秒 */
  sinceContact: number;
  /** 閃光弾が使える（残数・クールダウン・人質盾なし） */
  flashAvailable: boolean;
  /** ガスの投擲条件（膠着・部屋・民間人・既存ガス等）を満たす投擲者と目標がいる */
  gasCandidate: boolean;
  /** ガス残数 / 初期数 0..1 */
  gasLeftRatio: number;
  /** 生存隊員の平均 HP 比 0..1 */
  teamHealth: number;
  /** ガス目標の部屋に籠っている（と分かっている）容疑者数 */
  suspectsInTargetRoom: number;
}

/** 手段を切り替えるのに必要な点差 */
export const TACTIC_SWITCH_MARGIN = 0.1;
/** 手段を選んでから最低これだけは保持する秒数（無効化した場合を除く） */
export const TACTIC_MIN_COMMIT_SEC = 0.75;

function ramp(x: number, a: number, b: number): number {
  if (b <= a) return x >= b ? 1 : 0;
  return Math.max(0, Math.min(1, (x - a) / (b - a)));
}

export function scoreTactics(c: TacticConsiderations): Record<TeamTactic, number> {
  const s = c.sinceContact;
  const hurt = 1 - Math.max(0, Math.min(1, c.teamHealth));
  const inSuppressWindow = s >= SWAT_SUPPRESS_START_SEC && s <= SWAT_SUPPRESS_END_SEC;
  return {
    // 接触中は撃ち合いが最優先（反射的に切り替える）
    engage: s < SWAT_SUPPRESS_START_SEC ? 1 : 0,
    // 見失った直後は最後に見た位置へ制圧射撃
    suppress: inSuppressWindow ? 0.7 : 0,
    // 制圧が効かず相手が出てこない → 閃光弾。被害が出ているほど早く投げる
    flash:
      c.flashAvailable && s >= 0.6 && s <= SWAT_SUPPRESS_END_SEC
        ? 0.6 + 0.25 * ramp(s, 0.6, 1.5) + 0.15 * hurt
        : 0,
    // 膠着が続き、籠った相手がいる → ガス。長引くほど・相手が多いほど・被害が大きいほど上がり、残数が少ないほど控える
    gas: c.gasCandidate
      ? 0.6 +
        0.15 * ramp(s, GAS_STALEMATE_SEC, GAS_STALEMATE_SEC + 10) +
        0.1 * (Math.min(3, Math.max(0, c.suspectsInTargetRoom)) / 3) +
        0.1 * hurt -
        0.1 * (1 - Math.max(0, Math.min(1, c.gasLeftRatio)))
      : 0,
    // 何もしない（警戒・待機）の基準点
    hold: 0.3,
  };
}

/**
 * ヒステリシス付きで次の手段を選ぶ。
 * - 現在の手段が無効（0 点）になったら即切替
 * - 接触（engage）は反射なので即切替
 * - それ以外は最低保持時間を過ぎ、かつマージン以上の点差があるときだけ切り替える
 */
export function selectTactic(
  current: TeamTactic,
  heldSec: number,
  scores: Record<TeamTactic, number>,
): TeamTactic {
  let best: TeamTactic = current;
  let bestScore = -Infinity;
  for (const k of TEAM_TACTICS) {
    if (scores[k] > bestScore) {
      bestScore = scores[k];
      best = k;
    }
  }
  if (best === current) return current;
  const cur = scores[current];
  if (cur <= 0 || best === 'engage') return best;
  if (heldSec < TACTIC_MIN_COMMIT_SEC) return current;
  return bestScore > cur + TACTIC_SWITCH_MARGIN ? best : current;
}

export type GasFollowUp = 'push' | 'contain';

export interface GasFollowUpConsiderations {
  /** 突入に回せる隊員数（ホールド/オーバーウォッチ指示中・突入中でない） */
  availableForPush: number;
  teamHealth: number;
  suspectsInRoom: number;
  /** 部屋にドアがある（スタックして突入できる） */
  hasDoor: boolean;
}

/** ガス投擲後の行動の採点。健康で人数がいて相手が少なければ突入、そうでなければ出口封鎖 */
export function scoreGasFollowUp(c: GasFollowUpConsiderations): Record<GasFollowUp, number> {
  const n = Math.max(0, c.suspectsInRoom);
  return {
    push:
      c.hasDoor && c.availableForPush >= 2
        ? 0.4 + 0.3 * Math.max(0, Math.min(1, c.teamHealth)) + 0.1 * (Math.min(4, c.availableForPush) / 4) - 0.15 * Math.max(0, n - 1)
        : 0,
    contain: 0.5 + (n >= 2 ? 0.1 : 0),
  };
}

// ───────────────────────── ディレクター（ctx を操作） ─────────────────────────

/** 投擲者が構える秒数（「ガス投げる、カバー！」→ 投擲） */
export const GAS_WINDUP_SEC = 0.8;
/** 出口封鎖を続ける秒数（ガス雲の持続時間程度） */
export const GAS_CONTAIN_SEC = Math.min(14, GAS_CLOUD_DURATION);
/** 構え中止後、次にガスを検討するまでの秒数 */
export const GAS_ABORT_RETRY_SEC = 3.0;
/** 出入口警戒に加わる、出口からの最大距離(m) */
const WATCH_MAX_DIST = 20;
/** 突入に回す隊員の、ドアからの最大距離(m) */
const PUSH_MAX_DIST = 16;
const EVAL_INTERVAL = 0.25;

export interface GasOperation {
  stage: 'windup' | 'contain';
  throwerId: string;
  suspectId: string;
  target: Vec3;
  room: RoomDef;
  /** 部屋の出入口（ドア中心、目線の高さ） */
  exits: Vec3[];
  exitDoors: Door[];
  timer: number;
  origin: Vec3;
  velocity: Vec3;
  fuse: number;
}

export interface TeamTacticState {
  current: TeamTactic;
  heldSec: number;
  evalTimer: number;
  scores: Record<TeamTactic, number>;
  op: GasOperation | null;
}

export function createTeamTacticState(): TeamTacticState {
  return {
    current: 'hold',
    heldSec: 0,
    evalTimer: 0,
    scores: { engage: 0, suppress: 0, flash: 0, gas: 0, hold: 0.3 },
    op: null,
  };
}

/** 隊員の ID → ユニット */
function allyById(ctx: SquadContext, id: string): AllyUnit | undefined {
  return ctx.allies.find((a) => a.id === id);
}

function teamHealth(ctx: SquadContext): number {
  let sum = 0;
  let n = 0;
  for (const a of ctx.allies) {
    if (a.down) continue;
    sum += a.maxHp > 0 ? a.hp / a.maxHp : 0;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function hostageShieldUp(ctx: SquadContext): boolean {
  for (const s of ctx.entities.suspects.values()) {
    if (s.alive && s.state === SuspectState.HOSTAGE_SHIELD) return true;
  }
  return false;
}

/** 部屋に籠っていると分かっている（隊員の視認記録がある）生存容疑者の数 */
function knownSuspectsInRoom(ctx: SquadContext, room: RoomDef): number {
  const ids = new Set<string>();
  for (const a of ctx.allies) {
    const g = a.gasIntel;
    if (!g || ctx.simTime - g.t > 30) continue;
    const s = ctx.entities.suspects.get(g.suspectId);
    if (!s || !s.alive) continue;
    if (isPointInRoom(g.pos.x, g.pos.z, g.pos.y, room, 0)) ids.add(g.suspectId);
  }
  return ids.size;
}

/** 民間人（生存・未避難）が pos の近く（同じ階）にいるか */
function civilianNear(ctx: SquadContext, pos: Vec3, dist: number): boolean {
  for (const c of ctx.entities.civilians.values()) {
    if (!c.alive || c.evacuated) continue;
    if (Math.abs(c.body.footY - pos.y) > 1.5) continue;
    if (Math.hypot(c.body.px - pos.x, c.body.pz - pos.z) <= dist) return true;
  }
  return false;
}

/** 自律ガス投擲を控える、民間人との距離(m) */
const AUTONOMOUS_GAS_CIVILIAN_SAFE_DIST = 6;

interface GasCandidate {
  ally: AllyUnit;
  intel: GasIntel;
  room: RoomDef;
  origin: Vec3;
  velocity: Vec3;
  fuse: number;
}

const eyeTmp = new THREE.Vector3();

/** ガスを投げられる隊員と目標を探す（無ければ null） */
function findGasCandidate(ctx: SquadContext): GasCandidate | null {
  const gas = ctx.tearGas;
  if (!gas || ctx.gasLeft <= 0 || ctx.gasCd > 0 || ctx.gasRetryCd > 0) return null;
  if (ctx.simTime - ctx.lastTeamContactT < GAS_STALEMATE_SEC) return null;
  const playerPos: Vec3 = { x: ctx.player.position.x, y: ctx.player.position.y, z: ctx.player.position.z };
  let attempted = false;
  for (const ally of ctx.allies) {
    if (ally.down || ally.blindLeft > 0 || ally.engaging) continue;
    const intel = ally.gasIntel;
    if (!intel) continue;
    const suspect = ctx.entities.suspects.get(intel.suspectId);
    const blocked = gasBlockReason({
      simTime: ctx.simTime,
      lastTeamContactT: ctx.lastTeamContactT,
      intel,
      suspectState: suspect && suspect.alive ? suspect.state : null,
      throwerPos: { x: ally.body.px, y: ally.body.footY, z: ally.body.pz },
      playerPos,
      rooms: ctx.rooms,
      gasDensityAtTarget: gas.densityAt({ x: intel.pos.x, y: intel.pos.y + 1.0, z: intel.pos.z }),
      flashCd: ctx.flashCd,
    });
    if (blocked) continue;
    // 民間人が近くにいる（ガスで行動不能・減点になる）なら、自律ではガスを撃ち込まない
    if (civilianNear(ctx, intel.pos, AUTONOMOUS_GAS_CIVILIAN_SAFE_DIST)) continue;
    const room = gasTargetRoom(intel.pos, ctx.rooms);
    if (!room) continue;
    attempted = true;
    const eye = ally.body.eye(eyeTmp);
    const origin: Vec3 = { x: eye.x, y: eye.y, z: eye.z };
    const plan = planFlashThrow(
      origin,
      intel.pos,
      ctx.doors.doors,
      ctx.windows,
      ctx.colliders,
      gas.gravity,
      SWAT_GAS_MIN_DIST,
      SWAT_GAS_MAX_DIST,
    );
    if (!plan) continue;
    return { ally, intel, room, origin, velocity: plan.velocity, fuse: plan.fuse };
  }
  if (attempted) ctx.gasRetryCd = 0.5;
  return null;
}

function roomExitDoors(ctx: SquadContext, room: RoomDef): Door[] {
  const ids = new Set(findRoomDoors(room, flankDoorSamples(ctx)).map((d) => d.id));
  return ctx.doors.doors.filter((d) => ids.has(d.id));
}

function startGasOperation(ctx: SquadContext, c: GasCandidate): void {
  const exitDoors = roomExitDoors(ctx, c.room);
  ctx.tactic.op = {
    stage: 'windup',
    throwerId: c.ally.id,
    suspectId: c.intel.suspectId,
    target: { ...c.intel.pos },
    room: c.room,
    exits: exitDoors.map((d) => ({ x: d.centerX, y: d.sillY + 1.3, z: d.centerZ })),
    exitDoors,
    timer: GAS_WINDUP_SEC,
    origin: c.origin,
    velocity: c.velocity,
    fuse: c.fuse,
  };
  c.ally.body.setPose('crouch');
  const [ja, en] = pickRadio(GAS_COVER);
  ctx.emitRadio(c.ally, ja, en);
}

function endGasOperation(ctx: SquadContext): void {
  const op = ctx.tactic.op;
  if (!op) return;
  const thrower = allyById(ctx, op.throwerId);
  if (thrower && !thrower.down && thrower.blindLeft <= 0) thrower.body.setPose('stand');
  ctx.tactic.op = null;
}

/** プレイヤーの指示など、外部要因で作戦を打ち切る */
export function cancelGasOperation(ctx: SquadContext): void {
  endGasOperation(ctx);
}

/** 突入に回せる隊員（ホールド/オーバーウォッチ指示中・突入フロー中・遠すぎる隊員は除外） */
function pushGroup(ctx: SquadContext, door: Door): AllyUnit[] {
  return ctx.allies.filter(
    (a) =>
      !a.down &&
      a.blindLeft <= 0 &&
      a.order !== 'hold' &&
      a.order !== 'overwatch' &&
      a.order !== 'restrain' &&
      (a.phase === 'follow' || a.phase === 'hold' || a.phase === 'secured' || a.phase === 'move') &&
      Math.abs(a.body.footY - door.sillY) < 1.2 &&
      Math.hypot(a.body.px - door.centerX, a.body.pz - door.centerZ) <= PUSH_MAX_DIST,
  );
}

/** ドアから部屋へ向かう EntryPortal（部屋の外側から入る向き） */
function portalIntoRoom(door: Door, room: RoomDef): EntryPortal {
  const fy = room.floorY ?? 0;
  const inside = isPointInRoom(door.centerX + door.normalX * 0.85, door.centerZ + door.normalZ * 0.85, fy, room, 0);
  const sign = inside ? 1 : -1;
  return {
    id: door.id,
    centerX: door.centerX,
    centerZ: door.centerZ,
    sillY: door.sillY,
    intoX: door.normalX * sign,
    intoZ: door.normalZ * sign,
    axisX: door.axisX,
    axisZ: door.axisZ,
    width: door.width,
    door,
  };
}

function throwAndFollowUp(ctx: SquadContext, op: GasOperation, thrower: AllyUnit): void {
  const gas = ctx.tearGas;
  if (!gas) {
    endGasOperation(ctx);
    return;
  }
  gas.throwFrom(op.origin, op.velocity, thrower.id, op.fuse);
  ctx.gasLeft = Math.max(0, ctx.gasLeft - 1);
  ctx.gasCd = GAS_TEAM_COOLDOWN;
  const [gasJa, gasEn] = pickRadio(GAS);
  ctx.emitRadio(thrower, gasJa, gasEn);
  thrower.body.setPose('stand');

  // 投擲後の行動を採点で選ぶ: 突入（最寄りのドアから gasClear の突入フロー）か出口封鎖
  let pushDoor: Door | null = null;
  let group: AllyUnit[] = [];
  let bestD = Infinity;
  for (const d of op.exitDoors) {
    if (d.locked) continue;
    const g = pushGroup(ctx, d);
    if (g.length === 0) continue;
    const dist = Math.hypot(thrower.body.px - d.centerX, thrower.body.pz - d.centerZ);
    if (g.length > group.length || (g.length === group.length && dist < bestD)) {
      pushDoor = d;
      group = g;
      bestD = dist;
    }
  }
  const follow = scoreGasFollowUp({
    availableForPush: group.length,
    teamHealth: teamHealth(ctx),
    suspectsInRoom: knownSuspectsInRoom(ctx, op.room),
    hasDoor: pushDoor !== null,
  });

  if (pushDoor && follow.push > follow.contain) {
    const portal = portalIntoRoom(pushDoor, op.room);
    const lead = assignPortalGroup(ctx, group, portal, op.room, 'gasClear');
    // ガスはもう入っている: ドア前で 2 本目を投げず、スタック中にガスが回るのを待ってそのまま突入する
    for (const u of group) u.gassed = true;
    const [ja, en] = pickRadio(GAS_PUSH);
    ctx.emitRadio(lead, ja, en);
    endGasOperation(ctx);
    return;
  }

  op.stage = 'contain';
  op.timer = GAS_CONTAIN_SEC;
  const [ja, en] = pickRadio(GAS_CONTAIN);
  ctx.emitRadio(thrower, ja, en);
}

function updateGasOperation(ctx: SquadContext, op: GasOperation, dt: number): void {
  const thrower = allyById(ctx, op.throwerId);
  const suspect = ctx.entities.suspects.get(op.suspectId);
  const suspectDone =
    !suspect ||
    !suspect.alive ||
    suspect.state === SuspectState.SURRENDER ||
    suspect.state === SuspectState.ARRESTED ||
    suspect.state === SuspectState.DOWN;

  if (op.stage === 'windup') {
    if (!thrower || thrower.down || thrower.blindLeft > 0 || suspectDone) {
      endGasOperation(ctx);
      return;
    }
    // 構え中に接触したら中止して撃ち合いに戻る
    if (ctx.allies.some((a) => !a.down && a.engaging)) {
      const [ja, en] = pickRadio(GAS_ABORT);
      ctx.emitRadio(thrower, ja, en);
      ctx.gasRetryCd = GAS_ABORT_RETRY_SEC;
      endGasOperation(ctx);
      return;
    }
    op.timer -= dt;
    if (op.timer <= 0) throwAndFollowUp(ctx, op, thrower);
    return;
  }

  // contain: 燻り出された相手が投降・確保・無力化されたか、時間切れで解除
  op.timer -= dt;
  if (op.timer <= 0 || suspectDone) endGasOperation(ctx);
}

/**
 * チーム戦術を更新する（Squad.update から毎フレーム呼ぶ。採点は 0.25 秒ごと）。
 */
export function updateTeamTactics(ctx: SquadContext, dt: number): void {
  const st = ctx.tactic;
  st.heldSec += dt;
  if (st.op) {
    updateGasOperation(ctx, st.op, dt);
    // 構え中は作戦にコミットしている（採点し直さない）
    if (st.op?.stage === 'windup') return;
  }
  st.evalTimer -= dt;
  if (st.evalTimer > 0) return;
  st.evalTimer = EVAL_INTERVAL;

  const candidate = st.op ? null : findGasCandidate(ctx);
  const cfgGas = ctx.cfg.inventory.gas;
  const scores = scoreTactics({
    sinceContact: ctx.simTime - ctx.lastTeamContactT,
    flashAvailable: !!ctx.flashbang && ctx.flashesLeft > 0 && ctx.flashCd <= 0 && !hostageShieldUp(ctx),
    gasCandidate: candidate !== null,
    gasLeftRatio: cfgGas > 0 ? ctx.gasLeft / cfgGas : 0,
    teamHealth: teamHealth(ctx),
    suspectsInTargetRoom: candidate ? knownSuspectsInRoom(ctx, candidate.room) : 0,
  });
  st.scores = scores;
  const next = selectTactic(st.current, st.heldSec, scores);
  if (next !== st.current) {
    st.current = next;
    st.heldSec = 0;
  }
  if (st.current === 'gas' && candidate && !st.op) startGasOperation(ctx, candidate);
}

/** 自律閃光弾を投げてよい手段が選ばれているか */
export function tacticAllowsFlash(ctx: SquadContext): boolean {
  return ctx.tactic.current === 'flash';
}

/**
 * ガス作戦中の隊員の個別行動。投擲者は構え、手の空いた隊員は部屋の出入口を見張る。
 * 移動を止めて処理したら true（呼び出し側は以降の戦術処理をしない）。
 */
export function updateGasOperationUnit(ctx: SquadContext, ally: AllyUnit, dt: number): boolean {
  const op = ctx.tactic.op;
  if (!op || ally.down) return false;
  const body = ally.body;
  if (op.stage === 'windup' && ally.id === op.throwerId) {
    ally.vel.x = 0;
    ally.vel.z = 0;
    body.setPose('crouch');
    body.aimAt(op.target.x, op.target.y + 1.2, op.target.z, dt, Math.PI * 2 * dt);
    ally.progress = t('CSガス投擲準備', 'Prepping CS Gas');
    return true;
  }
  if (ally.engaging || op.exits.length === 0) return false;
  // 追従・待機・確保済みの隊員だけが見張りに加わる（突入中・移動指示中・射線ロック中は邪魔しない）
  if (ally.phase !== 'follow' && ally.phase !== 'hold' && ally.phase !== 'secured') return false;
  if (ally.order === 'overwatch') return false;
  let exit: Vec3 | null = null;
  let bestD = WATCH_MAX_DIST;
  for (const e of op.exits) {
    if (Math.abs(e.y - 1.3 - body.footY) > 1.2) continue;
    const d = Math.hypot(e.x - body.px, e.z - body.pz);
    if (d < bestD) {
      bestD = d;
      exit = e;
    }
  }
  if (!exit) return false;
  ally.vel.x = 0;
  ally.vel.z = 0;
  body.aimAt(exit.x, exit.y, exit.z, dt, Math.PI * 1.6 * dt);
  ally.progress =
    op.stage === 'windup' ? t('ガス投擲援護', 'Covering Gas Throw') : t('出口封鎖・燻り出し待ち', 'Covering Exits');
  return true;
}
