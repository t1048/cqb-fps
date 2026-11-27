import { DEFAULT_ALLY_WOUNDS } from '../../core/DataLoader';
import * as THREE from 'three';
import type { GameEventBus } from '../../core/events';
import { SuspectState } from '../../core/events';
import { t } from '../../core/i18n';
import {
  CONTACT,
  COVER_CALL,
  LESS_LETHAL,
  RELOAD,
  RUSH_BY_REASON,
  flankLine,
  manDownLine,
  pickRadio,
} from '../radioLines';
import type { RoomDef, Vec3 } from '../../core/types';
import { hasLineOfSight } from '../../weapons/Flashbang';
import { collidersNear } from '../../world/ColliderIndex';
import type { AABB, Collider } from '../../world/WorldBuilder';
import { pathSegmentClear, squadRoute } from '../SquadRoute';
import { blockedAt, type AllyTarget, type XZ } from '../EngageBehavior';
import {
  computeCornerLean,
  computeStepOutPoint,
  cqbPortalFromStackSlotPortal,
  portalLeanToBodyLean,
  shouldUseLowReady,
  type FriendlyPos,
} from '../cqbEntry';
import { segmentHitsAABB } from '../HostageShield';
import {
  BASE_SHIELD_COMBAT,
  BASE_SHIELD_MOBILITY,
  BASE_SWAT_COMBAT,
  BASE_SWAT_MOBILITY,
  SWAT_FOOTSTEP_STRIDE_FAST,
  SWAT_FOOTSTEP_STRIDE_NORMAL,
  SWAT_PEPPER_INTERVAL,
  SWAT_PEPPER_RANGE,
  SWAT_READY_POSE,
  SWAT_RUSH_DURATION_SEC,
  SWAT_RUSH_LOW_HP,
  SWAT_RUSH_RADIUS,
  SWAT_RUSH_SPEED_MIN,
  SWAT_RUSH_TEAM_COOLDOWN,
  SWAT_SHIELD_RUSH_SPEED,
  SWAT_SUPPRESS_END_SEC,
  SWAT_SUPPRESS_INTERVAL,
  SWAT_SUPPRESS_START_SEC,
} from '../SwatProfile';
import {
  planPincerFlankGoal,
  selectPinningCell,
  type PinningCellInfo,
} from '../SwatTactics';
import {
  ENGAGE_LOST_SEC,
  PINCER_TEAM_COOLDOWN,
  STEP_OUT_TRIGGER_SEC,
  isOrderLockedForAutonomousMove,
  isPointInRoom,
  isRoomConfined,
  type AllyUnit,
  type SquadContext,
} from './squadTypes';
import { isStandable, navigateTo } from './squadMovement';
import { tryAutonomousFlash } from './squadEntry';

const hostileTargetsBuf: AllyTarget[] = [];
const combatFromTmp: Vec3 = { x: 0, y: 0, z: 0 };
const combatTargetChestTmp: Vec3 = { x: 0, y: 0, z: 0 };
const combatAabbTmp: AABB = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
const combatPlayerEyeTmp = new THREE.Vector3();
const roomCoverScratch: Collider[] = [];
const friendliesPool: FriendlyPos[] = [];
const friendliesScratch: FriendlyPos[] = [];
const muzzleSelfPosTmp: Vec3 = { x: 0, y: 0, z: 0 };

export function tryWarn(ctx: SquadContext, ally: AllyUnit): void {
  if (ally.warnCd > 0) return;
  const from = ally.body.chestPos(combatFromTmp);
  for (const s of ctx.entities.suspects.values()) {
    if (!s.alive || !ctx.cfg.warnStates.includes(s.state) || ctx.provoked.has(s.id)) continue;
    const c = s.body.chestPos(combatTargetChestTmp);
    if (Math.hypot(c.x - from.x, c.z - from.z) > ctx.cfg.engageRange) continue;
    if (!hasLineOfSight(ctx.colliders, from, c)) continue;
    const pEye = ctx.player.getEyePosition(combatPlayerEyeTmp);
    const playerCovering =
      ctx.player.alive &&
      Math.hypot(c.x - pEye.x, c.z - pEye.z) <= 10 &&
      hasLineOfSight(ctx.colliders, pEye, c)
        ? 1
        : 0;
    const totalCovering = ctx.countAlliesCovering(c, 10) + playerCovering;
    const pressure = 1 + ctx.cfg.presenceBonusPerAlly * Math.max(0, totalCovering - 1);
    s.onWarned({ x: ally.body.px, y: from.y, z: ally.body.pz }, pressure);
    ally.warnCd = ctx.cfg.warningInterval;
    ally.body.faceToward(s.body.px, s.body.pz);
    return;
  }
}

export function createAllyEngageBus(ctx: SquadContext, shielded: boolean): GameEventBus {
  const realBus = ctx.bus;
  const weaponId = shielded ? 'pistol' : 'rifle';
  return {
    emit(event: string, payload: Record<string, unknown>) {
      if (event === 'suspectFired') return;
      if (event === 'noise') {
        realBus.emit('noise', { ...(payload as Parameters<GameEventBus['emit']>[1] & object), source: 'ally' } as never);
        return;
      }
      if (event === 'entityHit') {
        realBus.emit('entityHit', { ...(payload as Parameters<GameEventBus['emit']>[1] & object), weaponId } as never);
        return;
      }
      realBus.emit(event as never, payload as never);
    },
    on: (event: never, fn: never) => realBus.on(event, fn),
    off: (event: never, fn: never) => realBus.off(event, fn),
    clear: () => {},
  } as unknown as GameEventBus;
}

export function hostileSuspectTargetsFor(ctx: SquadContext, ally: AllyUnit): readonly AllyTarget[] {
  const from = ally.body.chestPos(combatFromTmp);
  hostileTargetsBuf.length = 0;
  for (const s of ctx.entities.suspects.values()) {
    if (!s.alive) continue;
    if (
      s.state === SuspectState.SURRENDER ||
      s.state === SuspectState.ARRESTED ||
      s.state === SuspectState.DOWN ||
      s.state === SuspectState.NEGOTIATION ||
      s.state === SuspectState.HOSTAGE_SHIELD
    ) {
      continue;
    }
    const hostile = ctx.cfg.hostileStates.includes(s.state) || ctx.provoked.has(s.id);
    if (!hostile) continue;
    const chest = s.body.chestPos(combatTargetChestTmp);
    if (checkLineBlock(ctx, ally, from, chest, s.id) !== 'none') continue;
    const cached = ctx.entities.getSuspectTarget(s.id);
    if (cached) {
      hostileTargetsBuf.push(cached);
    }
  }
  return hostileTargetsBuf;
}

export function checkLineBlock(
  ctx: SquadContext,
  ally: AllyUnit,
  from: Vec3,
  to: Vec3,
  targetId: string,
): 'none' | 'civilian' | 'friendly' | 'otherSuspect' {
  if (segmentHitsAABB(ctx.player.getBodyBounds(), from, to)) return 'friendly';
  for (const other of ctx.allies) {
    if (other !== ally && !other.down && segmentHitsAABB(other.body.getAABB(combatAabbTmp), from, to)) return 'friendly';
  }
  for (const c of ctx.entities.civilians.values()) {
    if (c.alive && segmentHitsAABB(c.body.getAABB(combatAabbTmp), from, to)) return 'civilian';
  }
  for (const s of ctx.entities.suspects.values()) {
    if (s.id !== targetId && s.alive && segmentHitsAABB(s.body.getAABB(combatAabbTmp), from, to)) return 'otherSuspect';
  }
  return 'none';
}

export function lineBlockedByPerson(
  ctx: SquadContext,
  ally: AllyUnit,
  from: Vec3,
  to: Vec3,
  targetId: string,
): boolean {
  return checkLineBlock(ctx, ally, from, to, targetId) !== 'none';
}

export function findWallCoverInRoom(
  ctx: SquadContext,
  ally: AllyUnit,
  room: RoomDef,
  threatPos: Vec3,
): { hide: XZ; peek: XZ } | null {
  const floorY = room.floorY ?? 0;
  const rxMin = room.x - room.width / 2;
  const rxMax = room.x + room.width / 2;
  const rzMin = room.z - room.depth / 2;
  const rzMax = room.z + room.depth / 2;
  const insetX = room.width < 2.0 ? 0.25 : 0.35;
  const insetZ = room.depth < 2.0 ? 0.25 : 0.35;
  const inRoomStrict = (x: number, z: number): boolean =>
    x >= rxMin + insetX && x <= rxMax - insetX && z >= rzMin + insetZ && z <= rzMax - insetZ;

  const m = Math.max(0.45, ctx.cfg.bodyRadius + 0.12);
  const threatChest: Vec3 = { x: threatPos.x, y: threatPos.y + 1.35, z: threatPos.z };
  const near = collidersNear(ctx.colliders, rxMin - 0.6, rzMin - 0.6, rxMax + 0.6, rzMax + 0.6);
  roomCoverScratch.length = 0;
  for (let i = 0; i < near.length; i++) {
    const c = near[i]!;
    if (c.kind !== 'wall' && c.kind !== 'cover') continue;
    const a = c.aabb;
    if (a.min.y > floorY + 1.2 || a.max.y < floorY + 0.25) continue;
    if (a.max.x < rxMin - 0.6 || a.min.x > rxMax + 0.6 || a.max.z < rzMin - 0.6 || a.min.z > rzMax + 0.6) {
      continue;
    }
    roomCoverScratch.push(c);
  }

  const raw: XZ[] = [];
  const apx = ally.body.px;
  const apz = ally.body.pz;
  const pushRaw = (x: number, z: number): void => {
    if (!inRoomStrict(x, z)) return;
    if ((x - apx) * (x - apx) + (z - apz) * (z - apz) > 5.5 * 5.5) return;
    for (let i = 0; i < raw.length; i++) {
      const ex = raw[i]!;
      const dx = ex.x - x;
      const dz = ex.z - z;
      if (dx * dx + dz * dz < 0.12 * 0.12) return;
    }
    raw.push({ x, z });
  };

  for (let i = 0; i < roomCoverScratch.length; i++) {
    const a = roomCoverScratch[i]!.aabb;
    const cx = (a.min.x + a.max.x) / 2;
    const cz = (a.min.z + a.max.z) / 2;
    const x0 = cx;
    const x1 = Math.min(a.max.x, a.min.x + 0.25);
    const x2 = Math.min(a.max.x, a.min.x + m);
    const x3 = Math.max(a.min.x, a.max.x - 0.25);
    const x4 = Math.max(a.min.x, a.max.x - m);
    for (const x of [x0, x1, x2, x3, x4]) {
      pushRaw(x, a.min.z - m);
      pushRaw(x, a.max.z + m);
    }
    const z0 = cz;
    const z1 = Math.min(a.max.z, a.min.z + 0.25);
    const z2 = Math.min(a.max.z, a.min.z + m);
    const z3 = Math.max(a.min.z, a.max.z - 0.25);
    const z4 = Math.max(a.min.z, a.max.z - m);
    for (const z of [z0, z1, z2, z3, z4]) {
      pushRaw(a.min.x - m, z);
      pushRaw(a.max.x + m, z);
    }
    pushRaw(a.min.x - m, a.min.z - m);
    pushRaw(a.min.x - m, a.max.z + m);
    pushRaw(a.max.x + m, a.min.z - m);
    pushRaw(a.max.x + m, a.max.z + m);
  }

  const peekOffsets: readonly XZ[] = [
    { x: 0.55, z: 0 },
    { x: -0.55, z: 0 },
    { x: 0, z: 0.55 },
    { x: 0, z: -0.55 },
    { x: 0.85, z: 0 },
    { x: -0.85, z: 0 },
    { x: 0, z: 0.85 },
    { x: 0, z: -0.85 },
  ];

  const probePt: Vec3 = { x: 0, y: floorY + 1.35, z: 0 };
  const candidates: { hide: XZ; peek: XZ | null; score: number }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]!;
    const dist = Math.hypot(p.x - apx, p.z - apz);
    if (!isStandable(ctx, p.x, p.z, floorY)) continue;
    probePt.x = p.x;
    probePt.z = p.z;
    if (hasLineOfSight(ctx.colliders, threatChest, probePt)) continue;

    let peek: XZ | null = null;
    for (const off of peekOffsets) {
      const px = p.x + off.x;
      const pz = p.z + off.z;
      if (!inRoomStrict(px, pz) || !isStandable(ctx, px, pz, floorY)) continue;
      probePt.x = px;
      probePt.z = pz;
      if (hasLineOfSight(ctx.colliders, threatChest, probePt)) {
        peek = { x: px, z: pz };
        break;
      }
    }
    const crowded = ctx.allies.some(
      (a) =>
        a !== ally &&
        !a.down &&
        a.coverHold !== null &&
        Math.hypot(a.coverHold.hide.x - p.x, a.coverHold.hide.z - p.z) < 0.65,
    );
    const score = dist - (peek ? 4.0 : 0) + (crowded ? 1.5 : 0);
    candidates.push({ hide: p, peek, score });
  }

  candidates.sort((a, b) => a.score - b.score);
  const origin: XZ = { x: apx, z: apz };
  let routeChecks = 0;
  for (const cand of candidates) {
    if (pathSegmentClear(ctx.colliders, origin, cand.hide, ctx.cfg.bodyRadius, floorY)) {
      return { hide: cand.hide, peek: cand.peek ?? cand.hide };
    }
    if (routeChecks < 6) {
      routeChecks++;
      const route = squadRoute(origin, cand.hide, floorY, ctx.colliders, ctx.bounds, ctx.cfg.bodyRadius);
      if (route.length > 0 && route.every((pt) => isPointInRoom(pt.x, pt.z, floorY, room, 0.25))) {
        return { hide: cand.hide, peek: cand.peek ?? cand.hide };
      }
    }
  }

  const fb = ally.podPos ?? { x: apx, z: apz };
  return isPointInRoom(fb.x, fb.z, floorY, room, 0) ? { hide: fb, peek: fb } : null;
}

export function updateRoomCoverHold(ctx: SquadContext, ally: AllyUnit, dt: number): boolean {
  const room = ally.targetRoom;
  if (!room) return false;
  const floorY = room.floorY ?? 0;
  const from = ally.body.chestPos();
  const peekFrom: Vec3 | null = ally.coverHold
    ? { x: ally.coverHold.peek.x, y: floorY + 1.35, z: ally.coverHold.peek.z }
    : null;

  let best: { id: string; px: number; pz: number; footY: number } | null = null;
  let bestDist = ally.combat.engageRange;
  for (const s of ctx.entities.suspects.values()) {
    if (!s.alive) continue;
    if (
      s.state === SuspectState.SURRENDER ||
      s.state === SuspectState.ARRESTED ||
      s.state === SuspectState.DOWN ||
      s.state === SuspectState.NEGOTIATION
    ) {
      continue;
    }
    if (isPointInRoom(s.body.px, s.body.pz, s.body.footY, room)) continue;
    const c = s.body.chestPos();
    const d = Math.hypot(c.x - from.x, c.z - from.z);
    if (d > bestDist) continue;
    const seesDirect = hasLineOfSight(ctx.colliders, from, c);
    const seesPeek = !seesDirect && peekFrom !== null && hasLineOfSight(ctx.colliders, peekFrom, c);
    if (!seesDirect && !seesPeek) continue;
    bestDist = d;
    best = { id: s.id, px: s.body.px, pz: s.body.pz, footY: s.body.footY };
  }

  if (best) {
    const threatPos: Vec3 = { x: best.px, y: best.footY, z: best.pz };
    const needRecompute =
      !ally.coverHold ||
      ally.coverHold.suspectId !== best.id ||
      Math.hypot(threatPos.x - ally.coverHold.threatPos.x, threatPos.z - ally.coverHold.threatPos.z) > 1.5;
    if (needRecompute) {
      const spot = findWallCoverInRoom(ctx, ally, room, threatPos);
      if (!spot) return false;
      ally.coverHold = { suspectId: best.id, threatPos, hide: spot.hide, peek: spot.peek, lostSec: 0 };
    } else if (ally.coverHold) {
      ally.coverHold.threatPos = threatPos;
      ally.coverHold.lostSec = 0;
    }
  } else if (ally.coverHold) {
    const tracked = ctx.entities.suspects.get(ally.coverHold.suspectId);
    if (
      !tracked ||
      !tracked.alive ||
      tracked.state === SuspectState.SURRENDER ||
      tracked.state === SuspectState.ARRESTED ||
      tracked.state === SuspectState.DOWN ||
      tracked.state === SuspectState.NEGOTIATION ||
      isPointInRoom(tracked.body.px, tracked.body.pz, tracked.body.footY, room)
    ) {
      ally.coverHold = null;
      return false;
    }
    ally.coverHold.lostSec += dt;
    if (ally.coverHold.lostSec >= 5.0) {
      ally.coverHold = null;
      return false;
    }
  } else {
    return false;
  }

  const hold = ally.coverHold;
  if (!hold) return false;
  if (ally.phase === 'entering' && ally.entryCrossT < 0) {
    ally.entryCrossT = ctx.simTime;
  }
  ally.progress = t('壁カバー・投降勧告中', 'Cover / Calling Surrender');

  const dist = Math.hypot(hold.hide.x - ally.body.px, hold.hide.z - ally.body.pz);
  if (ally.settled) {
    if (dist > 0.35) ally.settled = false;
  } else if (dist <= 0.25) {
    ally.settled = true;
  }
  if (!ally.settled && isPointInRoom(hold.hide.x, hold.hide.z, floorY, room, 0.1)) {
    navigateTo(ctx, ally, hold.hide.x, hold.hide.z, floorY, dt, false, false, null, undefined, true);
  }

  if (!ally.engaging) {
    ally.body.aimAt(hold.threatPos.x, hold.threatPos.y + 1.35, hold.threatPos.z, dt, Math.PI * 2.0 * dt);
  }

  if (ally.warnCd <= 0) {
    const target = ctx.entities.suspects.get(hold.suspectId);
    if (
      target &&
      target.alive &&
      target.state !== SuspectState.SURRENDER &&
      target.state !== SuspectState.ARRESTED &&
      target.state !== SuspectState.DOWN &&
      target.state !== SuspectState.NEGOTIATION
    ) {
      const c = target.body.chestPos();
      const pEye = ctx.player.getEyePosition();
      const playerCovering =
        ctx.player.alive &&
        Math.hypot(c.x - pEye.x, c.z - pEye.z) <= 10 &&
        hasLineOfSight(ctx.colliders, pEye, c)
          ? 1
          : 0;
      const totalCovering = Math.max(1, ctx.countAlliesCovering(c, 10) + playerCovering);
      const pressure = 1 + ctx.cfg.presenceBonusPerAlly * Math.max(0, totalCovering - 1);
      target.onWarned({ x: ally.body.px, y: ally.body.footY + 1.35, z: ally.body.pz }, pressure);
      ally.warnCd = ctx.cfg.warningInterval;
      if (ctx.coverRadioCd <= 0) {
        ctx.coverRadioCd = 6.0;
        const [ja, en] = pickRadio(COVER_CALL);
        ctx.emitRadio(ally, ja, en);
      }
    }
  }

  return true;
}

export function syncAnchorConstraints(ally: AllyUnit): void {
  const anchored = ally.order === 'hold' || ally.order === 'overwatch';
  const confined = anchored || isRoomConfined(ally);
  const baseCombat = ally.shielded ? BASE_SHIELD_COMBAT : BASE_SWAT_COMBAT;
  const baseMob = ally.shielded ? BASE_SHIELD_MOBILITY : BASE_SWAT_MOBILITY;
  ally.combat.coverSearchRange = confined ? 0 : baseCombat.coverSearchRange;
  ally.mobility.repositionAfterLostSec = confined ? 9999 : baseMob.repositionAfterLostSec;
}

export function tryEngage(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const hadPepper = ally.pepperTarget !== null;
  ally.sees = false;
  ally.threat = null;
  ally.pepperTarget = null;
  ally.holdingFire = false;
  const from = ally.body.chestPos();

  let best: { id: string; x: number; z: number; footY: number; pos: Vec3; state: SuspectState } | null = null;
  let bestD = ally.combat.engageRange;
  for (const s of ctx.entities.suspects.values()) {
    if (!s.alive) continue;
    if (
      s.state === SuspectState.SURRENDER ||
      s.state === SuspectState.ARRESTED ||
      s.state === SuspectState.DOWN ||
      s.state === SuspectState.NEGOTIATION
    ) {
      continue;
    }
    const isHostageShield = s.state === SuspectState.HOSTAGE_SHIELD;
    const hostile = isHostageShield || ctx.cfg.hostileStates.includes(s.state) || ctx.provoked.has(s.id);
    if (!hostile) continue;
    const c = s.body.chestPos();
    const d = Math.hypot(c.x - from.x, c.z - from.z);
    if (d > bestD || !hasLineOfSight(ctx.colliders, from, c)) continue;
    bestD = d;
    best = { id: s.id, x: s.body.px, z: s.body.pz, footY: s.body.footY, pos: c, state: s.state };
  }

  if (best) {
    const wasEngaging = ally.engageActive;
    ally.known = { x: best.x, y: best.footY, z: best.z };
    ally.lostSec = 0;
    ally.pincerTarget = null;
    ally.body.setReadyPose(SWAT_READY_POSE);

    const block = checkLineBlock(ctx, ally, from, best.pos, best.id);
    if (best.state === SuspectState.HOSTAGE_SHIELD || block === 'civilian') {
      // 人質盾または民間人が射線上: 実弾は撃たず、ペッパーボール（非致死）で制圧する
      ally.holdingFire = true;
      ally.pepperTarget = { id: best.id, pos: best.pos };
      ally.body.aimAt(best.pos.x, best.pos.y, best.pos.z, dt);
    } else if (block === 'friendly' || block === 'otherSuspect') {
      ally.holdingFire = true;
      ally.body.aimAt(best.pos.x, best.pos.y, best.pos.z, dt);
    } else {
      ally.sees = true;
      ally.threat = { id: best.id, x: best.x, z: best.z, point: best.pos, isPlayer: false };
    }

    if (ally.pepperTarget && !hadPepper) {
      ally.pepperCd = Math.max(ally.pepperCd, best.state === SuspectState.HOSTAGE_SHIELD ? 0.25 : 0.65);
    }
    if (!wasEngaging) {
      syncAnchorConstraints(ally);
      ally.engageActive = true;
      ally.engage.enter(ally.known);
      if (ctx.contactRadioCd <= 0) {
        ctx.contactRadioCd = 6.0;
        const [ja, en] = pickRadio(CONTACT);
        ctx.emitRadio(ally, ja, en);
      }
      tryTriggerPincer(ctx, ally, ally.known);
    }
  } else if (ally.engageActive || ally.known) {
    ally.lostSec += dt;
  }

  ally.engaging = ally.sees || ally.pepperTarget !== null || ally.holdingFire;

  // 味方射線ブロックが一定時間続いたら左右へ半歩ステップアウトして射線を確保する
  if (ally.holdingFire && !ally.pepperTarget) {
    ally.holdingFireSec += dt;
    if (ally.holdingFireSec >= STEP_OUT_TRIGGER_SEC && best && !isOrderLockedForAutonomousMove(ally)) {
      if (!ally.stepOutPos) {
        ally.stepOutPos = computeStepOutPoint(
          { x: ally.body.px, y: ally.body.footY, z: ally.body.pz },
          best.pos,
          (p) => !blockedAt(ctx.colliders, p.x, p.z, ctx.cfg.bodyRadius, ally.body.footY),
          (p) => checkLineBlock(ctx, ally, { x: p.x, y: ally.body.footY + 1.25, z: p.z }, best.pos, best.id) === 'none',
        );
      }
      if (ally.stepOutPos) {
        const dStep = Math.hypot(ally.stepOutPos.x - ally.body.px, ally.stepOutPos.z - ally.body.pz);
        if (dStep > 0.22) {
          navigateTo(
            ctx,
            ally,
            ally.stepOutPos.x,
            ally.stepOutPos.z,
            ally.body.footY,
            dt,
            false,
            false,
            null,
            ally.combat.moveSpeed * 0.7,
            true,
          );
          ally.body.aimAt(best.pos.x, best.pos.y, best.pos.z, dt);
          return;
        }
      }
    }
  } else {
    ally.holdingFireSec = 0;
    ally.stepOutPos = null;
  }

  // ペッパーボール発射（HOSTAGE_SHIELD または民間人が射線上）
  if (!ally.sees && ally.pepperTarget && ally.pepperCd <= 0) {
    firePepper(ctx, ally, ally.pepperTarget);
  }

  // 突撃（ラッシュ）中は updateRush が射撃・移動を統合制御する
  if (ally.rushTimer > 0 && !isOrderLockedForAutonomousMove(ally)) {
    return;
  }

  if (!ally.engageActive) {
    if (!ally.sees && !ally.pepperTarget && ally.known) {
      if (ally.lostSec >= 0.6 && ally.lostSec <= SWAT_SUPPRESS_END_SEC) {
        tryAutonomousFlash(ctx, ally, ally.known);
      }
      if (ally.lostSec >= ENGAGE_LOST_SEC) {
        ally.known = null;
        ally.lostSec = 0;
      }
    }
    return;
  }

  syncAnchorConstraints(ally);
  ally.engage.update(dt, ally.known, ally.sees, ally.threat);

  // リロード開始の戦術無線コール
  const curLabel = ally.engage.label;
  if (curLabel === 'reload' && ally.prevEngageLabel !== 'reload') {
    const [reloadJa, reloadEn] = pickRadio(RELOAD);
    ctx.emitRadio(ally, reloadJa, reloadEn);
  }
  ally.prevEngageLabel = curLabel;

  // 視認喪失時の制圧射撃（ROE 安全: 民間人・味方が射線上のときは撃たない）＋自律フラッシュ
  if (
    !ally.sees &&
    !ally.pepperTarget &&
    ally.known &&
    ally.lostSec >= SWAT_SUPPRESS_START_SEC &&
    ally.lostSec <= SWAT_SUPPRESS_END_SEC
  ) {
    if (ally.lostSec >= 0.6) tryAutonomousFlash(ctx, ally, ally.known);
    if (ally.suppressCd <= 0 && ally.engage.ammoLeft > 0 && ally.engage.label !== 'reload') {
      const suppressAim: Vec3 = { x: ally.known.x, y: ally.known.y + 1.15, z: ally.known.z };
      if (!lineBlockedByPerson(ctx, ally, from, suppressAim, '')) {
        ally.suppressCd = SWAT_SUPPRESS_INTERVAL * (0.85 + Math.random() * 0.3);
        ally.body.faceToward(ally.known.x, ally.known.z);
        ally.engage.fireAt(null, ally.known);
      }
    }
  }

  if (!ally.sees && !ally.pepperTarget && ally.lostSec >= ENGAGE_LOST_SEC) {
    ally.engage.exit();
    ally.engageActive = false;
    ally.known = null;
    ally.lostSec = 0;
    ally.prevEngageLabel = '';
  }
}

export function firePepper(ctx: SquadContext, ally: AllyUnit, target: { id: string; pos: Vec3 }): void {
  const from = ally.body.chestPos();
  const dist = Math.hypot(target.pos.x - from.x, target.pos.z - from.z);
  if (dist > SWAT_PEPPER_RANGE) return;
  ally.pepperCd = SWAT_PEPPER_INTERVAL * (0.85 + Math.random() * 0.3);
  ally.lostSec = 0;
  ally.body.faceToward(target.pos.x, target.pos.z);
  ally.body.showMuzzleFlash(0.05);
  ctx.bus.emit('noise', { pos: from, radius: 14, kind: 'gunshot', source: 'ally' });
  ctx.bus.emit('entityHit', {
    targetId: target.id,
    shooter: ally.id,
    damage: 0,
    pos: target.pos,
    weaponId: 'pepperball',
    nonlethal: true,
    moraleScale: 1.0,
  });
  ctx.recentlyPeppered.set(target.id, 4.0);
  if (ctx.pepperRadioCd <= 0) {
    ctx.pepperRadioCd = 5.0;
    const [lessJa, lessEn] = pickRadio(LESS_LETHAL);
    ctx.emitRadio(ally, lessJa, lessEn);
  }
}

export function checkWeaknessRush(ctx: SquadContext): void {
  if (ctx.rushCd > 0) return;
  for (const s of ctx.entities.suspects.values()) {
    if (!s.alive) continue;
    if (
      s.state === SuspectState.SURRENDER ||
      s.state === SuspectState.ARRESTED ||
      s.state === SuspectState.DOWN ||
      s.state === SuspectState.NEGOTIATION ||
      s.state === SuspectState.HOSTAGE_SHIELD
    ) {
      continue;
    }
    const hostile = ctx.cfg.hostileStates.includes(s.state) || ctx.provoked.has(s.id);
    if (!hostile) continue;

    let reason: 'blind' | 'reload' | 'pepper' | 'lowHp' | null = null;
    if (s.isFlashed) reason = 'blind';
    else if (s.debugState === 'ENGAGE/reload') reason = 'reload';
    else if (ctx.recentlyPeppered.has(s.id)) reason = 'pepper';
    else if (s.hp > 0 && s.hp <= SWAT_RUSH_LOW_HP) reason = 'lowHp';
    if (!reason) continue;

    const pos: Vec3 = { x: s.body.px, y: s.body.footY, z: s.body.pz };
    if (triggerRush(ctx, pos, reason)) return;
  }
}

export function triggerRush(ctx: SquadContext, pos: Vec3, reason: 'blind' | 'reload' | 'pepper' | 'lowHp'): boolean {
  if (ctx.rushCd > 0) return false;
  const candidates = ctx.allies
    .filter(
      (a) =>
        !a.down &&
        a.blindLeft <= 0 &&
        !isOrderLockedForAutonomousMove(a) &&
        !(isRoomConfined(a) && !isPointInRoom(pos.x, pos.z, pos.y, a.targetRoom!)),
    )
    .map((a) => ({
      a,
      dist: Math.hypot(a.body.px - pos.x, a.body.pz - pos.z) + Math.abs(a.body.footY - pos.y) * 3,
    }))
    .filter((x) => x.dist <= SWAT_RUSH_RADIUS)
    .sort((x, y) => x.dist - y.dist)
    .slice(0, 3);
  if (candidates.length === 0) return false;

  for (const { a } of candidates) {
    a.rushTimer = SWAT_RUSH_DURATION_SEC;
    a.rushTarget = { ...pos };
    a.rushFireCd = 0;
    a.known = { ...pos };
    a.pincerTarget = null;
    a.body.setPose('stand');
  }
  ctx.rushCd = SWAT_RUSH_TEAM_COOLDOWN;
  const [ja, en] = pickRadio(RUSH_BY_REASON[reason]);
  ctx.emitRadio(candidates[0]!.a, ja, en);
  return true;
}

export function updateRush(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  ally.rushTimer -= dt;
  ally.rushFireCd = Math.max(0, ally.rushFireCd - dt);
  if (ally.rushTimer <= 0) {
    ally.rushTimer = 0;
    ally.rushTarget = null;
    return;
  }
  if (ally.flinchLeft > 0) return;
  if (ally.sees && ally.known) {
    ally.rushTarget = { ...ally.known };
  }
  const goal = ally.rushTarget;
  if (!goal) {
    ally.rushTimer = 0;
    return;
  }
  ally.progress = t('突撃制圧中', 'Rushing');
  const speed = ally.shielded ? SWAT_SHIELD_RUSH_SPEED : SWAT_RUSH_SPEED_MIN;
  const dist = Math.hypot(goal.x - ally.body.px, goal.z - ally.body.pz);
  if (dist > 1.4 || Math.abs(goal.y - ally.body.footY) > 0.6) {
    navigateTo(ctx, ally, goal.x, goal.z, goal.y, dt, true, !ally.sees, null, speed);
  }
  if (ally.sees && ally.threat) {
    ally.body.faceToward(ally.threat.x, ally.threat.z);
    if (ally.engage.ammoLeft <= 0) {
      ally.rushTimer = 0;
      ally.rushTarget = null;
      return;
    }
    if (ally.rushFireCd <= 0 && !ally.holdingFire) {
      ally.engage.fireAt(ally.threat, ally.known);
      ally.rushFireCd = ally.combat.fireInterval;
    }
  }
}

export function tryTriggerPincer(ctx: SquadContext, contactBy: AllyUnit, targetPos: Vec3): void {
  if (ctx.pincerCd > 0) return;
  const alpha = ctx.allies.filter((a) => !a.down && a.elementKey === 'alpha');
  const bravo = ctx.allies.filter((a) => !a.down && a.elementKey === 'bravo');
  if (alpha.length === 0 || bravo.length === 0) return;

  const avgPos = (grp: AllyUnit[]): Vec3 => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const a of grp) {
      x += a.body.px;
      y += a.body.footY;
      z += a.body.pz;
    }
    return { x: x / grp.length, y: y / grp.length, z: z / grp.length };
  };

  const cellInfos: PinningCellInfo[] = [
    {
      cellIndex: 0,
      aliveCount: alpha.length,
      hasShield: alpha.some((a) => a.shielded),
      engaged: alpha.some((a) => a.sees || a.engaging),
      center: avgPos(alpha),
    },
    {
      cellIndex: 1,
      aliveCount: bravo.length,
      hasShield: bravo.some((a) => a.shielded),
      engaged: bravo.some((a) => a.sees || a.engaging),
      center: avgPos(bravo),
    },
  ];
  const contactIdx = contactBy.elementKey === 'alpha' ? 0 : 1;
  const pinIdx = selectPinningCell(cellInfos, contactIdx, targetPos);
  const pinGroup = pinIdx === 0 ? alpha : bravo;
  const flankGroup = pinIdx === 0 ? bravo : alpha;
  const eligibleFlankers = flankGroup.filter(
    (a) =>
      !a.sees &&
      a.blindLeft <= 0 &&
      !isOrderLockedForAutonomousMove(a) &&
      !(isRoomConfined(a) && !isPointInRoom(targetPos.x, targetPos.z, targetPos.y, a.targetRoom!)),
  );
  if (eligibleFlankers.length === 0) return;

  const goal = planPincerFlankGoal({
    playerPos: targetPos,
    frontalPos: avgPos(pinGroup),
    flankerPos: avgPos(eligibleFlankers),
    rooms: ctx.rooms,
    doors: ctx.doors.doors,
    stairs: ctx.stairs,
    colliders: ctx.colliders,
  });
  if (!goal) return;

  for (const a of eligibleFlankers) {
    a.pincerTarget = { ...goal.target };
    a.pincerTimer = 10.0;
  }
  ctx.pincerCd = PINCER_TEAM_COOLDOWN;
  const [flankJa, flankEn] = flankLine('こちら', '別班');
  ctx.emitRadio(pinGroup[0]!, flankJa, flankEn);
}

export function updatePincerFlank(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const goal = ally.pincerTarget;
  if (!goal) return;
  ally.pincerTimer -= dt;
  ally.progress = t('挟撃回り込み中', 'Flanking');
  const d = Math.hypot(goal.x - ally.body.px, goal.z - ally.body.pz);
  if (ally.pincerTimer <= 0 || (d <= 1.2 && Math.abs(goal.y - ally.body.footY) < 0.6)) {
    ally.pincerTarget = null;
    return;
  }
  navigateTo(ctx, ally, goal.x, goal.z, goal.y, dt, true, true);
}

export function onFlashDetonated(
  ctx: SquadContext,
  e: { pos: Vec3; radius: number; blindSec: number; thrower?: string },
): void {
  // プレイヤー・味方 SWAT 投擲のフラッシュバンには白飛び耐性（フレンドリー免疫）
  if (
    e.thrower === 'player' ||
    e.thrower?.startsWith('ally_') ||
    ctx.allies.some((a) => a.id === e.thrower)
  ) {
    return;
  }
  const eye = new THREE.Vector3();
  for (const ally of ctx.allies) {
    if (ally.down) continue;
    ally.body.eye(eye);
    const dist = Math.hypot(e.pos.x - eye.x, e.pos.y - eye.y, e.pos.z - eye.z);
    if (dist > e.radius) continue;
    if (!hasLineOfSight(ctx.colliders, e.pos, eye)) continue;
    const blind = e.blindSec * (1 - 0.6 * (dist / e.radius));
    if (blind > 0) {
      ally.blindLeft = Math.max(ally.blindLeft, blind);
      ally.optics.hide();
    }
  }
}

export function updateMuzzleDiscipline(ctx: SquadContext, ally: AllyUnit): void {
  if (ally.sees || ally.pepperTarget) {
    ally.body.setReadyPose('high');
    return;
  }
  let count = 0;
  const pushFriendly = (x: number, y: number, z: number): void => {
    let slot = friendliesPool[count];
    if (!slot) {
      slot = { x: 0, y: 0, z: 0 };
      friendliesPool.push(slot);
    }
    slot.x = x;
    slot.y = y;
    slot.z = z;
    friendliesScratch[count++] = slot;
  };
  if (ctx.player.alive) {
    pushFriendly(ctx.player.position.x, ctx.player.position.y, ctx.player.position.z);
  }
  for (let i = 0; i < ctx.allies.length; i++) {
    const other = ctx.allies[i]!;
    if (other === ally || other.down) continue;
    pushFriendly(other.body.px, other.body.footY, other.body.pz);
  }
  friendliesScratch.length = count;

  const yaw = ally.body.yawRad;
  const wx = ally.body.px - Math.sin(yaw) * 0.55;
  const wz = ally.body.pz - Math.cos(yaw) * 0.55;
  const wallClose = blockedAt(ctx.colliders, wx, wz, 0.12, ally.body.footY);
  muzzleSelfPosTmp.x = ally.body.px;
  muzzleSelfPosTmp.y = ally.body.footY;
  muzzleSelfPosTmp.z = ally.body.pz;
  const low = shouldUseLowReady(muzzleSelfPosTmp, yaw, friendliesScratch, wallClose);
  ally.body.setReadyPose(low ? 'low' : 'high');
}

export function updateAllyLean(ctx: SquadContext, ally: AllyUnit): void {
  let lean = 0;
  if (ally.phase === 'pieing' && ally.entryPortal && ally.pieSteps.length > 0) {
    const idx = Math.min(ally.pieIdx, ally.pieSteps.length - 1);
    const step = ally.pieSteps[idx]!;
    lean = portalLeanToBodyLean(
      cqbPortalFromStackSlotPortal(ally.entryPortal, ally.entryPortal.sillY),
      ally.body.yawRad,
      step.portalLeanAxis,
    );
  } else if (ally.phase === 'door_prep' && ally.peekHold > 0 && ally.entryPortal) {
    const side: -1 | 1 = ally.entryPlan?.side ?? -1;
    const towardDoor: -1 | 1 = side === -1 ? 1 : -1;
    lean = portalLeanToBodyLean(
      cqbPortalFromStackSlotPortal(ally.entryPortal, ally.entryPortal.sillY),
      ally.body.yawRad,
      towardDoor,
    );
  } else if (
    (ally.phase === 'overwatch' || ally.phase === 'hold' || ally.phase === 'secured' || ally.engaging) &&
    Math.hypot(ally.vel.x, ally.vel.z) < 0.25
  ) {
    lean = computeCornerLean(
      { x: ally.body.px, y: ally.body.footY, z: ally.body.pz },
      ally.body.yawRad,
      (x, z) => blockedAt(ctx.colliders, x, z, 0.2, ally.body.footY),
    );
  }
  ally.body.setLean(lean);
}

export function updateAllyOptics(ctx: SquadContext, ally: AllyUnit): void {
  if (ally.down || ally.blindLeft > 0 || ally.body.getReadyPose() === 'low') {
    ally.optics.hide();
    return;
  }
  if (ally.body.getMuzzlePose(ctx.muzzleOriginTmp, ctx.muzzleDirTmp)) {
    ally.optics.update(ctx.muzzleOriginTmp, ctx.muzzleDirTmp, ctx.colliders);
  } else {
    ally.optics.hide();
  }
}

export function updateAllyFootstep(ctx: SquadContext, ally: AllyUnit): void {
  const moved = Math.hypot(ally.body.px - ally.lastStepX, ally.body.pz - ally.lastStepZ);
  ally.lastStepX = ally.body.px;
  ally.lastStepZ = ally.body.pz;
  if (moved <= 1e-4) return;
  ally.stepAccum += moved;
  const quiet = ally.stealthEntry || ally.phase === 'pieing';
  const isFast = !quiet && (ally.rushTimer > 0 || ally.phase === 'entering');
  const stride = isFast ? SWAT_FOOTSTEP_STRIDE_FAST : SWAT_FOOTSTEP_STRIDE_NORMAL;
  if (ally.stepAccum >= stride) {
    ally.stepAccum -= stride;
    const heavy =
      !quiet &&
      (ally.shielded ||
        ally.rushTimer > 0 ||
        ally.phase === 'stacking' ||
        ally.phase === 'door_prep' ||
        ally.phase === 'c2_plant' ||
        ally.phase === 'c2_standoff');
    ctx.bus.emit('swatFootstep', {
      pos: { x: ally.body.px, y: ally.body.footY, z: ally.body.pz },
      heavy,
    });
  }
}

/** 隊員が頭部へ被弾したか（命中点が身長の 82% 以上）。 */
export function isAllyHeadHit(ally: AllyUnit, hitY: number | undefined): boolean {
  return hitY !== undefined && hitY >= ally.body.footY + ally.body.height * 0.82;
}

export function onHit(ctx: SquadContext, id: string, damage: number, nonlethal: boolean, hitY?: number, shooter?: string): void {
  const ally = ctx.allies.find((a) => a.id === id);
  if (!ally || ally.down) return;
  if (nonlethal) {
    ally.flinchLeft = Math.max(ally.flinchLeft, 0.25);
    ally.body.setFlash(true);
    return;
  }
  const wc = ctx.cfg.wounds ?? DEFAULT_ALLY_WOUNDS;
  // 隊員同士・自傷では頭部倍率を掛けない（容疑者の弾のみ）。盾持ちは頭部が盾で守られるため対象外
  const fromHostile = shooter === undefined || !shooter.startsWith('ally_');
  if (fromHostile && !ally.shielded && isAllyHeadHit(ally, hitY)) {
    damage *= wc.headMultiplier;
  }
  ally.hp = Math.max(0, ally.hp - damage);
  // 負傷（HP が閾値未満）で移動速度低下。一度だけ適用（combat は隊員ごとの写し）
  if (!ally.wounded && ally.hp > 0 && ally.hp < ally.maxHp * wc.woundBelow) {
    ally.wounded = true;
    ally.combat.moveSpeed *= wc.speedMul;
  }
  if (ally.hp <= 0) {
    ally.down = true;
    ctx.bus.emit('allyDown', { allyId: ally.id });
    if (ally.engageActive) {
      ally.engage.exit();
      ally.engageActive = false;
    }
    ally.flinchLeft = 0;
    ally.blindLeft = 0;
    ally.rushTimer = 0;
    ally.optics.hide();
    ally.body.setFlash(false);
    ally.body.setShake(0);
    ally.body.setPose('down');
    ally.body.removeGun();
    const [downJa, downEn] = manDownLine(ally.name);
    ctx.emitRadio(ally, downJa, downEn);
    return;
  }
  const flinchSec = ally.rushTimer > 0 ? Math.min(ally.combat.flinchSec, 0.08) : ally.combat.flinchSec;
  ally.flinchLeft = Math.max(ally.flinchLeft, flinchSec);
  if (ally.flinchLeft > 0) ally.body.setFlash(true);
  if (ally.engageActive && ally.rushTimer <= 0) {
    syncAnchorConstraints(ally);
    ally.engage.onHit(ally.known);
  }
}
