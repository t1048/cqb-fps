import * as THREE from 'three';
import { SuspectState } from '../../core/events';
import { t } from '../../core/i18n';
import type { MirrorConfig, RoomDef, Vec3 } from '../../core/types';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { Door } from '../../world/Door';
import { SAFE_DISARM_PEEK_DEG } from '../../world/DoorTraps';
import type { Collider } from '../../world/WorldBuilder';
import { contactCallout } from '../../player/optiwandGeometry';
import {
  CHECK_START,
  DISARM_START,
  MIRROR_START,
  TRAP_CLEAR,
  TRAP_FAIL,
  TRAP_SPOT,
  checkResultLine,
  pickRadio,
} from '../radioLines';
import type { ScoutContact } from '../ScoutIntel';
import { findRoomAcrossDoor } from './squadEntry';
import { approachSign } from './squadMovement';
import type { AllyUnit, EntryPortal, SquadContext } from './squadTypes';

const DEG2RAD = Math.PI / 180;
const eyeTmp = new THREE.Vector3();

/** プレイヤーから見てドアの向こう側の部屋。 */
export function roomBehindDoor(ctx: SquadContext, door: Door): RoomDef | null {
  return findRoomAcrossDoor(ctx, door, approachSign(ctx, door));
}

export interface DoorKnowledge {
  room: RoomDef | null;
  /** 向こう側の状況を把握しているか（ワンド/ミラーで確認済み、または開口越しに視線が通っている） */
  scouted: boolean;
  /** 既知の脅威（武装容疑者） */
  threats: ScoutContact[];
}

/**
 * ドアの向こう側について、隊が持っている情報。
 * - ScoutIntel に確認済みフラグがある（オプティワンド/ミラー）
 * - もしくはドアが十分開いていて、プレイヤーの目線から室内中央へ視線が通る（視覚的に確認できている）
 */
export function doorKnowledge(ctx: SquadContext, door: Door): DoorKnowledge {
  const room = roomBehindDoor(ctx, door);
  if (!room) return { room: null, scouted: false, threats: [] };
  const threats = ctx.intel.threatsIn(room.id);
  if (ctx.intel.isScouted(room.id)) return { room, scouted: true, threats };
  if (door.angle >= ctx.cfg.doorOpenAngle) {
    const eye = ctx.player.getEyePosition(eyeTmp);
    const center: Vec3 = { x: room.x, y: (room.floorY ?? 0) + 1.2, z: room.z };
    if (hasLineOfSight(ctx.colliders, { x: eye.x, y: eye.y, z: eye.z }, center)) return { room, scouted: true, threats };
  }
  return { room, scouted: false, threats };
}

/** 突入隊員の初期視線を、既知の脅威位置へ向ける（pre-aim）。 */
export function applyScoutPreAim(ctx: SquadContext, group: readonly AllyUnit[], portal: EntryPortal, room: RoomDef | null): void {
  if (!room) return;
  const threats = ctx.intel.threatsIn(room.id);
  if (threats.length === 0) return;
  let best = threats[0]!;
  let bd = Infinity;
  for (const c of threats) {
    const d = Math.hypot(c.x - portal.centerX, c.z - portal.centerZ);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  for (const a of group) {
    a.entryThreatLook = { x: best.x, y: best.y + 1.3, z: best.z };
  }
}

/** 戦闘不能・投降・拘束された対象を intel から掃除し、投降者は非武装に更新する。 */
export function refreshScoutIntel(ctx: SquadContext): void {
  const intel = ctx.intel;
  if (intel.all().length === 0) return;
  intel.prune((c) => {
    if (c.kind === 'suspect') {
      const s = ctx.entities.suspects.get(c.id);
      return !!s && s.state !== SuspectState.DOWN && s.state !== SuspectState.ARRESTED;
    }
    const civ = ctx.entities.civilians.get(c.id);
    return !!civ && civ.alive && !civ.evacuated;
  });
  for (const c of intel.all()) {
    if (c.kind !== 'suspect' || !c.armed) continue;
    const s = ctx.entities.suspects.get(c.id);
    if (s && s.state === SuspectState.SURRENDER) c.armed = false;
  }
}

export interface MirrorCandidate {
  id: string;
  kind: 'suspect' | 'civilian';
  armed: boolean;
  /** 胸の位置 */
  chest: Vec3;
}

export interface MirrorScanInput {
  doorCenter: { x: number; z: number };
  /** 部屋の内側（向こう側）へ向かう単位ベクトル */
  far: { x: number; z: number };
  sillY: number;
  candidates: readonly MirrorCandidate[];
  cfg: MirrorConfig;
  colliders: readonly Collider[];
  rand?: () => number;
}

export interface MirrorScanResult {
  seen: MirrorCandidate[];
  missed: MirrorCandidate[];
}

/**
 * 隊員のミラー確認。固定視野（ドア中心から向こう側へ halfFovDeg）内・視線が通る接触を拾うが、
 * 視線中心線（ドア中心から far 方向の直線）から centerBandM より外れた接触は missChance で見落とす。
 * プレイヤー自身のワンドは首振りできるため、見落としのない手動確認の方が確実。
 */
export function scanMirrorContacts(inp: MirrorScanInput): MirrorScanResult {
  const rand = inp.rand ?? Math.random;
  const seen: MirrorCandidate[] = [];
  const missed: MirrorCandidate[] = [];
  const tip: Vec3 = {
    x: inp.doorCenter.x + inp.far.x * 0.1,
    y: inp.sillY + 0.1,
    z: inp.doorCenter.z + inp.far.z * 0.1,
  };
  const cosHalf = Math.cos(inp.cfg.halfFovDeg * DEG2RAD);
  for (const c of inp.candidates) {
    const dx = c.chest.x - inp.doorCenter.x;
    const dz = c.chest.z - inp.doorCenter.z;
    const dist = Math.hypot(dx, dz);
    if (dist > inp.cfg.range) continue;
    const along = dx * inp.far.x + dz * inp.far.z;
    if (along <= 0.05) continue;
    if (dist > 0.01 && along / dist < cosHalf) continue;
    if (!hasLineOfSight(inp.colliders, tip, c.chest)) continue;
    const lateral = Math.abs(dx * -inp.far.z + dz * inp.far.x);
    if (lateral > inp.cfg.centerBandM && rand() < inp.cfg.missChance) {
      missed.push(c);
      continue;
    }
    seen.push(c);
  }
  return { seen, missed };
}

/** ミラー確認の開始（スタック位置に着いてから経過を数える）。右クリックメニューから選んだときだけ行う。 */
export function startMirror(ctx: SquadContext, ally: AllyUnit): void {
  ally.mirrorLeft = ctx.cfg.mirror.durationSec;
  ally.mirrorStarted = false;
}

/** スタック位置に着いている隊員のミラー確認を進める。確認が終われば報告して false を返す。 */
export function tickMirror(ctx: SquadContext, ally: AllyUnit, dt: number): boolean {
  if (ally.mirrorLeft <= 0) return false;
  const door = ally.door;
  if (!door) {
    ally.mirrorLeft = 0;
    return false;
  }
  if (!ally.mirrorStarted) {
    ally.mirrorStarted = true;
    const [ja, en] = pickRadio(MIRROR_START);
    ctx.emitRadio(ally, ja, en);
  }
  ally.mirrorLeft = Math.max(0, ally.mirrorLeft - dt);
  ally.body.setPose('crouch');
  ally.body.aimAt(door.centerX, door.sillY + 0.15, door.centerZ, dt, Math.PI * 2 * dt);
  ally.progress = t('ミラー確認中', 'Mirroring Door');
  if (ally.mirrorLeft > 0) return true;
  ally.body.setPose('stand');
  resolveMirror(ctx, ally, door);
  return false;
}

function roll(ctx: SquadContext): number {
  return (ctx.rand ?? Math.random)();
}

/** ドアチェックの開始（スタック位置に着いてから経過を数える）。先頭の 1 名がドア際で確認する。 */
export function startCheck(ctx: SquadContext, ally: AllyUnit): void {
  ally.checkLeft = ctx.cfg.doorCheck.durationSec;
  ally.checkStarted = false;
}

/**
 * ドアチェックの進行。ドア際でしゃがんで施錠とブービートラップ用ワイヤを確認する（床下カメラは使わない）。
 * 終わると「施錠/未施錠」「トラップ有り/無し」を報告し、結果を ctx.doorChecks に記録する。確認中は true。
 * トラップは detectChance の確率で発見する（見落とすと「トラップ無し」と報告される）。
 */
export function tickCheck(ctx: SquadContext, ally: AllyUnit, dt: number): boolean {
  if (ally.checkLeft <= 0) return false;
  const door = ally.door;
  if (!door) {
    ally.checkLeft = 0;
    return false;
  }
  if (!ally.checkStarted) {
    ally.checkStarted = true;
    const [ja, en] = pickRadio(CHECK_START);
    ctx.emitRadio(ally, ja, en);
  }
  ally.checkLeft = Math.max(0, ally.checkLeft - dt);
  ally.body.setPose('crouch');
  ally.body.aimAt(door.centerX + door.axisX * door.width * 0.35, door.sillY + 0.95, door.centerZ + door.axisZ * door.width * 0.35, dt, Math.PI * 2 * dt);
  ally.progress = t('ドアチェック中（施錠・トラップ）', 'Checking Door (Lock & Trap)');
  if (ally.checkLeft > 0) return true;
  ally.checkStarted = false;
  ally.body.setPose('stand');
  const rigged = ctx.traps?.isRigged(door.id) === true;
  const found = rigged && (ctx.traps?.isDiscovered(door.id) === true || roll(ctx) < ctx.cfg.doorCheck.detectChance);
  if (found) ctx.traps?.discover(door.id);
  ctx.doorChecks.set(door.id, { locked: door.locked, trapFound: found, time: ctx.simTime });
  const [ja, en] = checkResultLine(door.locked, found);
  ctx.emitRadio(ally, ja, en);
  ctx.ack = t(
    `ドアチェック: ${door.locked ? '施錠' : '未施錠'} / ${found ? 'トラップ有り' : 'トラップ無し'}`,
    `Door check: ${door.locked ? 'Locked' : 'Unlocked'} / ${found ? 'Trap found' : 'No trap'}`,
  );
  ctx.ackLeft = 3.5;
  return false;
}

/** 確認済みのトラップの解除を始める（スタック位置に着いてから経過を数える）。 */
export function startDisarm(ctx: SquadContext, ally: AllyUnit): void {
  ally.disarmLeft = ctx.cfg.doorTrap.disarmSec;
  ally.disarmStarted = false;
}

/** 施錠ドアのキーピック解錠を始める（スタック位置に着いてから経過を数える）。 */
export function startLockpick(ally: AllyUnit, durationSec = 3.0): void {
  ally.lockpickLeft = durationSec;
  ally.lockpickStarted = false;
}

/**
 * 隊員による施錠ドアのキーピック解錠（静かに解錠・約 3 秒）。作業中は true。
 * 完了時に door.locked = false として無音で開錠する。
 */
export function tickLockpick(ctx: SquadContext, ally: AllyUnit, dt: number): boolean {
  const door = ally.door ?? ally.entryPortal?.door ?? null;
  if (!door || !door.locked) {
    ally.lockpickLeft = 0;
    ally.lockpickStarted = false;
    return false;
  }
  if (!ally.lockpickStarted) {
    ally.lockpickStarted = true;
    if (ally.lockpickLeft <= 0) ally.lockpickLeft = 3.0;
    ctx.emitRadio(ally, 'キーピックで静かに解錠する', 'Picking the lock quietly');
  }
  ally.lockpickLeft = Math.max(0, ally.lockpickLeft - dt);
  ally.body.setPose('crouch');
  ally.body.aimAt(
    door.centerX + door.axisX * door.width * 0.35,
    door.sillY + 0.95,
    door.centerZ + door.axisZ * door.width * 0.35,
    dt,
    Math.PI * 2 * dt,
  );
  ally.progress = t('キーピックで解錠中', 'Lockpicking Door');
  if (ally.lockpickLeft > 0) return true;
  ally.lockpickStarted = false;
  ally.body.setPose('stand');
  door.locked = false;
  ctx.emitRadio(ally, '解錠した。ドアは開く', 'Lock picked, door is clear');
  ctx.ack = t('キーピックで解錠した', 'Door lockpicked');
  ctx.ackLeft = 2.2;
  return false;
}

/**
 * トラップ解除の進行（先頭の隊員が扉をわずかに開いて隙間のワイヤーを切断する）。作業中は true。
 * 終了時に failChance で失敗（起爆）。成功ならトラップは除去される。
 * 未発見の仕掛けに「気付いた」ときの処理もここ（door_prep から）で共有する。
 */
export function tickDisarm(ctx: SquadContext, ally: AllyUnit, dt: number): boolean {
  const door = ally.door ?? ally.entryPortal?.door ?? null;
  if (!door || !ctx.traps?.isRigged(door.id)) {
    ally.disarmLeft = 0;
    ally.disarmStarted = false;
    return false;
  }
  if (!ally.disarmStarted) {
    ally.disarmStarted = true;
    if (ally.disarmLeft <= 0) ally.disarmLeft = ctx.cfg.doorTrap.disarmSec;
    const [ja, en] = pickRadio(DISARM_START);
    ctx.emitRadio(ally, ja, en);
  }
  if (!ctx.traps.isDisarming?.(door.id)) {
    ctx.traps.beginDisarm?.(door.id);
    if (door.locked) door.locked = false;
    if (door.angle < SAFE_DISARM_PEEK_DEG - 1 && door.targetAngle < SAFE_DISARM_PEEK_DEG - 1) {
      door.command?.(SAFE_DISARM_PEEK_DEG, false, ally.body.px, ally.body.pz);
    }
  }
  ally.disarmLeft = Math.max(0, ally.disarmLeft - dt);
  ally.body.setPose('crouch');
  ally.body.aimAt(door.centerX + door.axisX * door.width * 0.35, door.sillY + 0.95, door.centerZ + door.axisZ * door.width * 0.35, dt, Math.PI * 2 * dt);
  ally.progress = t('扉を少し開いてワイヤー切断中', 'Cracking Door & Cutting Wire');
  if (ally.disarmLeft > 0) return true;
  ally.disarmStarted = false;
  ally.body.setPose('stand');
  if (roll(ctx) < ctx.cfg.doorTrap.failChance) {
    ctx.traps.endDisarm?.(door.id);
    const [ja, en] = pickRadio(TRAP_FAIL);
    ctx.emitRadio(ally, ja, en);
    ctx.traps.detonate(door.id);
  } else {
    ctx.traps.disarm(door.id);
    const [ja, en] = pickRadio(TRAP_CLEAR);
    ctx.emitRadio(ally, ja, en);
    ctx.ack = t('ワイヤーを切断し、トラップを解除した', 'Tripwire cut — trap disarmed');
    ctx.ackLeft = 2.5;
  }
  return false;
}

/** 開けようとした先頭の隊員が、チェックなしでも仕掛けに気付くことがある（1 ドア 1 回判定）。気付いたら true。 */
export function rollTrapSpot(ctx: SquadContext, ally: AllyUnit, door: Door): boolean {
  if (!ctx.traps?.isRigged(door.id) || ctx.trapSpotRolled.has(door.id)) return false;
  ctx.trapSpotRolled.add(door.id);
  if (roll(ctx) >= ctx.cfg.doorCheck.spotChance) return false;
  ctx.traps.discover(door.id);
  const [ja, en] = pickRadio(TRAP_SPOT);
  ctx.emitRadio(ally, ja, en);
  return true;
}

function resolveMirror(ctx: SquadContext, ally: AllyUnit, door: Door): void {
  const side = (ally.body.px - door.centerX) * door.normalX + (ally.body.pz - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
  const far = { x: -side * door.normalX, z: -side * door.normalZ };
  const room = findRoomAcrossDoor(ctx, door, side);
  const candidates: MirrorCandidate[] = [];
  const chest = { x: 0, y: 0, z: 0 };
  const inRoom = (x: number, z: number, y: number): boolean =>
    !!room &&
    Math.abs((room.floorY ?? 0) - y) <= 0.75 &&
    Math.abs(x - room.x) <= room.width / 2 &&
    Math.abs(z - room.z) <= room.depth / 2;
  for (const [id, s] of ctx.entities.suspects) {
    if (s.friendly || s.state === SuspectState.DOWN || s.state === SuspectState.ARRESTED) continue;
    if (!inRoom(s.body.px, s.body.pz, s.body.footY)) continue;
    const c = s.body.chestPos(chest);
    candidates.push({ id, kind: 'suspect', armed: s.state !== SuspectState.SURRENDER, chest: { x: c.x, y: c.y, z: c.z } });
  }
  for (const [id, civ] of ctx.entities.civilians) {
    if (!civ.alive || civ.evacuated) continue;
    if (!inRoom(civ.body.px, civ.body.pz, civ.body.footY)) continue;
    const c = civ.body.chestPos(chest);
    candidates.push({ id, kind: 'civilian', armed: false, chest: { x: c.x, y: c.y, z: c.z } });
  }
  const res = scanMirrorContacts({
    doorCenter: { x: door.centerX, z: door.centerZ },
    far,
    sillY: door.sillY,
    candidates,
    cfg: ctx.cfg.mirror,
    colliders: ctx.colliders,
  });
  if (room) {
    ctx.intel.markScouted(room.id, 'ally');
    for (const c of res.seen) {
      ctx.intel.reportContact(
        room.id,
        { id: c.id, kind: c.kind, armed: c.armed, x: c.chest.x, y: c.chest.y - 1.2, z: c.chest.z, time: ctx.simTime },
        'ally',
      );
    }
  }
  // ワンド映像（Optiwand の隊員映像中継）で途中発見して登録済みの接触も含めて報告する
  const known = new Map<string, { kind: 'suspect' | 'civilian'; armed: boolean }>();
  for (const c of res.seen) known.set(c.id, c);
  if (room) for (const c of ctx.intel.contactsIn(room.id)) if (!known.has(c.id)) known.set(c.id, c);
  const all = [...known.values()];
  const armed = all.filter((c) => c.kind === 'suspect' && c.armed).length;
  const unarmed = all.filter((c) => c.kind === 'suspect' && !c.armed).length;
  const civilians = all.filter((c) => c.kind === 'civilian').length;
  const [ja, en] = contactCallout(armed, unarmed, civilians, { ja: 'ミラー確認: ', en: 'Mirror check: ' });
  ctx.emitRadio(ally, ja, en);
  ctx.bus.emit('scoutReport', { roomId: room?.id ?? null, suspects: armed + unarmed, armed, civilians, source: 'ally' });
}
