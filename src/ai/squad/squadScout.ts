import * as THREE from 'three';
import { SuspectState } from '../../core/events';
import { t } from '../../core/i18n';
import type { MirrorConfig, RoomDef, Vec3 } from '../../core/types';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { Door } from '../../world/Door';
import type { Collider } from '../../world/WorldBuilder';
import { contactCallout } from '../../player/optiwandGeometry';
import { MIRROR_START, pickRadio } from '../radioLines';
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

/** ミラー確認の開始（スタック位置に着いてから経過を数える）。 */
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
  const armed = res.seen.filter((c) => c.kind === 'suspect' && c.armed).length;
  const unarmed = res.seen.filter((c) => c.kind === 'suspect' && !c.armed).length;
  const civilians = res.seen.filter((c) => c.kind === 'civilian').length;
  const [ja, en] = contactCallout(armed, unarmed, civilians, { ja: 'ミラー確認: ', en: 'Mirror check: ' });
  ctx.emitRadio(ally, ja, en);
  ctx.bus.emit('scoutReport', { roomId: room?.id ?? null, suspects: armed + unarmed, armed, civilians, source: 'ally' });
}
