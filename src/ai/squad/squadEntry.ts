import * as THREE from 'three';
import { SuspectState } from '../../core/events';
import { t } from '../../core/i18n';
import {
  BREACH_IN,
  C2_DETONATE,
  C2_PLANT,
  CHECK_FROM_DOOR,
  CRACK_DOOR,
  DOOR_LOCKED,
  FLASH,
  FLASH_GO,
  GAS,
  GAS_GO,
  MOVE_IN,
  QUIET_ENTRY,
  STACKED_READY,
  pickRadio,
} from '../radioLines';
import type { RoomDef, SquadOrder, Vec3 } from '../../core/types';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { Door } from '../../world/Door';
import type { Collider } from '../../world/WorldBuilder';
import { pathSegmentClear } from '../SquadRoute';
import { blockedAt, type XZ } from '../EngageBehavior';
import { layoutStackSlots, type StackSlot } from '../stackSlots';
import {
  assignStackSlots,
  computeEntryOrder,
  computeStackLookPoint,
  cqbPortalFromStackSlotPortal,
  cqbRoomFromRoomDef,
  entryHalfWidth,
  entryRoomDepth,
  fromPortalFrame,
  planDoorPieArc,
  planEntry,
  type EntryPlan,
} from '../cqbEntry';
import {
  SWAT_C2_BEEP_INTERVAL,
  SWAT_C2_BLAST_HALF_ANGLE_DEG,
  SWAT_C2_BLAST_RADIUS,
  SWAT_C2_FUSE_SEC,
  SWAT_C2_MAX_DAMAGE,
  SWAT_C2_PLANT_SEC,
  SWAT_C2_URGENT_AT_SEC,
  SWAT_C2_URGENT_BEEP_INTERVAL,
  SWAT_FLASH_MAX_DIST,
  SWAT_FLASH_MIN_DIST,
  SWAT_GAS_MAX_DIST,
  SWAT_GAS_MIN_DIST,
} from '../SwatProfile';
import {
  computeBallisticVelocity,
  computeC2Standoff,
  planFlashThrow,
  shouldUseC2Breach,
} from '../SwatTactics';
import {
  ARRIVE_HYST,
  ENTRY_GATE_FAILSAFE,
  ENTRY_POD_ARRIVE,
  ENTRY_STALL_SEC,
  ENTRY_TIMEOUT_SEC,
  ENTRY_WP_ARRIVE,
  FLASH_TEAM_COOLDOWN,
  GAS_TEAM_COOLDOWN,
  PIE_SPEED_MUL,
  PIE_STEP_HOLD_SEC,
  PIE_TIMEOUT_SEC,
  POD_RETURN_GIVEUP,
  STACK_ARRIVE,
  STACK_STALL_WAIT,
  STEALTH_ENTRY_SPEED_MUL,
  STEALTH_PEEK_HOLD_SEC,
  type AllyUnit,
  type EntryPortal,
  type SquadContext,
  type TacticalPhase,
} from './squadTypes';
import { holdLook, isStandable, navigateTo, passableUnlockedDoors } from './squadMovement';

const C2_FIREBALL_GEO = new THREE.SphereGeometry(1, 10, 8);
C2_FIREBALL_GEO.userData.shared = true;
const planPassableScratch = new Set<Collider>();
const domPassableScratch = new Set<Collider>();
const throwEyeTmp = new THREE.Vector3();

export function assignPortalGroup(
  ctx: SquadContext,
  group: AllyUnit[],
  portal: EntryPortal,
  room: RoomDef | null,
  order: SquadOrder,
): AllyUnit {
  const n = group.length;
  if (room) ctx.announcedRooms.delete(`${room.id}:${portal.id}`);
  ctx.announcedStacks.delete(portal.id);
  const cqbPortal = cqbPortalFromStackSlotPortal(portal, portal.sillY);
  const PRE_ENTRY: readonly TacticalPhase[] = ['stacking', 'door_prep', 'c2_plant', 'c2_standoff', 'flash_wait', 'gas_wait'];
  const prevGroup = ctx.portalGroups.get(portal.id);

  // 同ポータルで既にスタック中の役割があれば常に保持（order==='stack' の再発行や直接 clear でも）
  const keepRoles =
    !!prevGroup &&
    prevGroup.slots.length === n &&
    group.every(
      (u) =>
        u.entryPortal?.id === portal.id &&
        u.groupSize === n &&
        u.stackPos !== null &&
        u.slotIndex >= 0 &&
        PRE_ENTRY.includes(u.phase),
    ) &&
    new Set(group.map((u) => u.slotIndex)).size === n;

  let slots: StackSlot[];
  const slotOf = new Map<AllyUnit, number>();
  const saved = new Map<AllyUnit, Pick<AllyUnit, 'stackPos' | 'entryPlan' | 'entryOrder' | 'podPos' | 'podLook' | 'entryThreatLook'>>();
  if (keepRoles) {
    slots = prevGroup!.slots;
    for (const u of group) {
      slotOf.set(u, u.slotIndex);
      saved.set(u, {
        stackPos: u.stackPos,
        entryPlan: u.entryPlan,
        entryOrder: u.entryOrder,
        podPos: u.podPos,
        podLook: u.podLook,
        entryThreatLook: u.entryThreatLook,
      });
    }
  } else {
    slots = computeStackSlots(ctx, portal, n);
    // 総移動距離最小・ドア開口横切り/経路交差ペナルティで枠を割当（距離ソートの貪欲割当は交差を生む）
    const assign = assignStackSlots(
      group.map((u) => ({ x: u.body.px, z: u.body.pz })),
      slots,
      cqbPortal,
    );
    group.forEach((u, i) => slotOf.set(u, assign[i] ?? -1));
  }

  const ranks = computeEntryOrder(cqbPortal, slots);
  const plans = keepRoles ? null : room ? planPortalEntry(ctx, portal, room, slots) : null;
  // 突入順 = スタック順（L0, R0, L1, R1 …）。枠を取れなかった隊員は最後尾
  let extra = slots.length;
  const orderOf = new Map<AllyUnit, number>();
  for (const u of group) {
    const si = slotOf.get(u) ?? -1;
    orderOf.set(u, si >= 0 ? (ranks[si]?.order ?? extra++) : extra++);
  }
  const sorted = [...group].sort((a, b) => orderOf.get(a)! - orderOf.get(b)!);

  ctx.portalGroups.set(portal.id, {
    order,
    portal,
    room,
    slots,
    waitT: 0,
    elapsed: 0,
    allSettled: false,
    replanned: false,
  });

  sorted.forEach((ally, roleIdx) => {
    ctx.resetUnitForOrder(ally, order);
    const si = slotOf.get(ally) ?? -1;
    ally.roleIndex = roleIdx;
    ally.entryOrder = roleIdx;
    ally.slotIndex = si;
    ally.groupSize = sorted.length;
    ally.entryPortal = portal;
    ally.door = portal.door;
    ally.targetRoom = room;
    const keep = saved.get(ally);
    if (keep) {
      ally.stackPos = keep.stackPos;
      ally.entryPlan = keep.entryPlan;
      ally.podPos = keep.podPos;
      ally.podLook = keep.podLook;
      ally.entryThreatLook = keep.entryThreatLook;
    } else {
      const slot = si >= 0 ? slots[si] : undefined;
      ally.stackPos = slot
        ? { x: slot.x, z: slot.z }
        : {
            x: portal.centerX - portal.intoX * (1.15 + roleIdx * 0.9),
            z: portal.centerZ - portal.intoZ * (1.15 + roleIdx * 0.9),
          };
      applyEntryPlan(ally, portal, room, si >= 0 && plans ? (plans[si] ?? null) : null);
    }
    ally.entryDelay = 0;

    const alreadyNearDoor =
      ally.stackPos !== null &&
      Math.abs(ally.body.footY - portal.sillY) < 0.65 &&
      Math.hypot(ally.body.px - ally.stackPos.x, ally.body.pz - ally.stackPos.z) <= 1.25;

    if (
      order !== 'stack' &&
      alreadyNearDoor &&
      sorted.every((u) => {
        const s = slots[slotOf.get(u) ?? -1];
        return Math.hypot(u.body.px - (s?.x ?? portal.centerX), u.body.pz - (s?.z ?? portal.centerZ)) <= 1.25;
      })
    ) {
      ally.phase = 'door_prep';
      ally.progress =
        roleIdx === 0
          ? portal.door && portal.door.angle < ctx.cfg.doorOpenAngle
            ? t('ドア開放準備', 'Prepping Door')
            : t('突入準備', 'Prepping Entry')
          : t('突入待機', 'Standing By');
    } else {
      ally.phase = 'stacking';
      ally.progress = t('スタック位置へ移動', 'Moving to Stack');
    }
  });
  return sorted[0]!;
}

/** planEntry（cqbEntry）で枠ごとのサイド固定突入計画を作る。既存の支配点計算をフォールバック PoD に使う */
export function planPortalEntry(
  ctx: SquadContext,
  portal: EntryPortal,
  room: RoomDef,
  slots: readonly StackSlot[],
): EntryPlan[] {
  const y = portal.sillY;
  const fallbackPods = computeDominationPoints(ctx, portal, room, slots.length).map((p) => ({ x: p.pos.x, y, z: p.pos.z }));
  const passable = passableUnlockedDoors(ctx, undefined, null, planPassableScratch);
  const r = ctx.cfg.bodyRadius;
  return planEntry(cqbPortalFromStackSlotPortal(portal, y), cqbRoomFromRoomDef(room), slots, {
    isStandable: (p) => isStandable(ctx, p.x, p.z, y),
    reachable: (a, b) => pathSegmentClear(ctx.colliders, a, b, r, y, passable),
    fallbackPods,
  });
}

/** 突入計画を隊員に反映（PoD・視線・敷居までの警戒点） */
export function applyEntryPlan(ally: AllyUnit, portal: EntryPortal, room: RoomDef | null, plan: EntryPlan | null): void {
  ally.entryPlan = plan;
  ally.podPos = plan ? { x: plan.pod.x, z: plan.pod.z } : null;
  ally.podLook = plan ? plan.look : null;
  ally.entryThreatLook = null;
  if (plan && room) {
    // 敷居点までは「ドア内の自サイド反対側コーナー」（最初に脅威が見える方向）を見る
    const cp = cqbPortalFromStackSlotPortal(portal, portal.sillY);
    const cr = cqbRoomFromRoomDef(room);
    const opp = (plan.side === -1 ? 1 : -1) as -1 | 1;
    const halfOpp = entryHalfWidth(cp, cr, opp);
    const depth = entryRoomDepth(cp, cr);
    ally.entryThreatLook = fromPortalFrame(
      cp,
      opp * Math.max(0.6, halfOpp),
      Math.max(1.2, Math.min(depth - 0.6, 3.0)),
      portal.sillY + 1.38,
    );
  }
}

/**
 * 突入開始時（扉が開いた状態）に一度だけ経路・PoD を引き直す。side/rank/order（＝役割）は凍結のまま。
 * 開いた扉板が入口壁沿いに来るなど、スタック時点では分からない障害を反映する。
 */
export function replanGroupOnRelease(ctx: SquadContext, portal: EntryPortal): void {
  const g = ctx.portalGroups.get(portal.id);
  if (!g || g.replanned) return;
  g.replanned = true;
  if (!g.room) return;
  const members = ctx.allies.filter((u) => u.entryPortal?.id === portal.id && u.order === g.order && u.slotIndex >= 0);
  if (members.length === 0 || members.some((u) => u.entryStartT >= 0)) return;
  const plans = planPortalEntry(ctx, portal, g.room, g.slots);
  for (const u of members) {
    const p = plans[u.slotIndex];
    const prev = u.entryPlan;
    if (!p || (prev && (p.side !== prev.side || p.rank !== prev.rank))) continue;
    applyEntryPlan(u, portal, g.room, p);
  }
}

/** スタック中グループの一斉 door_prep 遷移（グループ単位のタイムアウト） */
export function updatePortalGroups(ctx: SquadContext, dt: number): void {
  for (const [id, g] of ctx.portalGroups) {
    const members = ctx.allies.filter((u) => u.entryPortal?.id === id && u.order === g.order);
    if (members.length === 0) {
      ctx.portalGroups.delete(id);
      continue;
    }
    const stacking = members.filter((u) => !u.down && u.phase === 'stacking');
    if (stacking.length === 0) continue;
    const settledAt = (u: AllyUnit): boolean => u.settled && Math.abs(u.body.footY - g.portal.sillY) < 0.4;
    g.allSettled = stacking.every(settledAt);
    if (g.order === 'stack') {
      if (g.allSettled && !ctx.announcedStacks.has(id)) {
        ctx.announcedStacks.add(id);
        const [ja, en] = pickRadio(STACKED_READY);
        ctx.emitRadio(stacking[0]!, ja, en);
      }
      continue;
    }
    g.elapsed += dt;
    // 「グループ全員が待っている」（到着済み or 進めていない）時間だけを数える。歩いて向かっている者がいれば待つ
    if (stacking.every((u) => settledAt(u) || u.stalled >= STACK_STALL_WAIT || u.blindLeft > 0)) g.waitT += dt;
    const hardCap = Math.max(20, ctx.cfg.stackWaitTimeoutSec * 4);
    if (g.allSettled || g.waitT >= ctx.cfg.stackWaitTimeoutSec || g.elapsed >= hardCap) {
      // door_prep への遷移はグループ一斉（早着者が個別に突入しない）
      for (const u of stacking) {
        u.phase = 'door_prep';
        u.phaseTimer = 0;
        u.stackWaitTimer = 0;
      }
    }
  }
}

/** スタック枠への移動と到着ヒステリシス（到着済みなら true、移動中なら false） */
export function updateStackSettle(ctx: SquadContext, ally: AllyUnit, portal: EntryPortal, slot: XZ, dt: number): boolean {
  const body = ally.body;
  const d = Math.hypot(slot.x - body.px, slot.z - body.pz);
  const sameFloor = Math.abs(body.footY - portal.sillY) < 0.4;
  if (ally.settled) {
    if (!sameFloor || d > STACK_ARRIVE + ARRIVE_HYST) ally.settled = false;
  } else if (sameFloor && d <= STACK_ARRIVE) {
    ally.settled = true;
  }
  if (ally.settled) {
    ally.stalled = 0;
    ally.stuckStage = 0;
    ally.anchor = { x: body.px, z: body.pz };
    return true;
  }
  // 対象ポータルの扉は開けず、道中にある未施錠の途中ドアのみ開放して進む
  navigateTo(ctx, ally, slot.x, slot.z, portal.sillY, dt, true, true, portal.door?.id ?? null);
  return false;
}

/**
 * 突入順ゲート（§1-2）: 順番 k は「直前の生存メンバー (k-1) が敷居を越えた」かつ
 * 「k-1 の開始から staggerSec 経過」で発進。k-1 開始から ENTRY_GATE_FAILSAFE (2.5s) でフェイルセーフ開放。
 */
export function entryGateOpen(ctx: SquadContext, ally: AllyUnit): boolean {
  if (ally.entryOrder <= 0 || !ally.entryPortal) return true;
  const pid = ally.entryPortal.id;
  let prev: AllyUnit | null = null;
  for (const u of ctx.allies) {
    if (u === ally || u.down || u.entryPortal?.id !== pid || u.order !== ally.order) continue;
    if (u.entryOrder < ally.entryOrder && (!prev || u.entryOrder > prev.entryOrder)) {
      prev = u;
    }
  }
  if (!prev) return true;
  if (prev.phase === 'sweeping' || prev.phase === 'secured' || prev.phase === 'restraining') {
    return prev.entryStartT < 0 || ctx.simTime - prev.entryStartT >= ctx.cfg.staggerSec;
  }
  if (prev.entryStartT >= 0) {
    if (ctx.simTime - prev.entryStartT >= ENTRY_GATE_FAILSAFE) return true;
    return prev.entryCrossT >= 0 && ctx.simTime - prev.entryStartT >= ctx.cfg.staggerSec;
  }
  if (prev.phase !== 'entering' && ally.entryGateWait >= ENTRY_GATE_FAILSAFE) return true;
  return false;
}

/** PoD 保持（到着済みは静止、離れていれば戻る。戻れない場合は POD_RETURN_GIVEUP で諦めて静止） */
export function holdAtPod(ctx: SquadContext, ally: AllyUnit, portal: EntryPortal, dt: number): void {
  const pod = ally.podPos;
  if (!pod) {
    ally.settled = true;
    return;
  }
  const body = ally.body;
  const d = Math.hypot(pod.x - body.px, pod.z - body.pz);
  const sameFloor = Math.abs(body.footY - portal.sillY) < 0.4;
  if (ally.settled) {
    if (!sameFloor || d > ENTRY_POD_ARRIVE + ARRIVE_HYST) {
      ally.settled = false;
      ally.podReturnT = 0;
    }
  } else if (sameFloor && d <= ENTRY_POD_ARRIVE) {
    ally.settled = true;
  }
  if (ally.settled) {
    ally.stalled = 0;
    ally.stuckStage = 0;
    ally.anchor = { x: body.px, z: body.pz };
    return;
  }
  ally.podReturnT += dt;
  if (ally.podReturnT >= POD_RETURN_GIVEUP || ally.stalled >= ENTRY_STALL_SEC) {
    ally.settled = true;
    return;
  }
  navigateTo(ctx, ally, pod.x, pod.z, portal.sillY, dt, false, false);
}

export function computeStackSlots(ctx: SquadContext, portal: EntryPortal, count: number): XZ[] {
  return layoutStackSlots(portal, count, ctx.cfg.stackOffset, ctx.cfg.personalSpace, (x, z) =>
    isStandable(ctx, x, z, portal.sillY),
  );
}

export function computeDominationPoints(
  ctx: SquadContext,
  portal: EntryPortal,
  room: RoomDef,
  count: number,
): { pos: XZ; look: Vec3 }[] {
  const intoX = portal.intoX;
  const intoZ = portal.intoZ;
  const latX = portal.axisX;
  const latZ = portal.axisZ;
  const thresh: XZ = { x: portal.centerX + intoX * 0.65, z: portal.centerZ + intoZ * 0.65 };
  const passable = passableUnlockedDoors(ctx, undefined, null, domPassableScratch);

  const chosen: XZ[] = [];
  const CORNER_PAIRS: [number, number][] = [
    [ctx.cfg.dominationDepth, ctx.cfg.dominationLateral],
    [1.7, 1.55],
    [1.4, 1.15],
    [1.1, 0.85],
    [0.85, 0.45],
  ];
  // 3・4 番手: 1・2 番手のコーナーより扉寄り・内側の壁沿い（入口に固まらず、射線も被らない位置）
  const INNER_PAIRS: [number, number][] = [
    [ctx.cfg.dominationDepth * 0.55, ctx.cfg.dominationLateral * 0.45],
    [1.6, 0.6],
    [1.25, 0.95],
    [2.1, 0.3],
    [1.0, 0.5],
  ];
  const pickCorner = (side: -1 | 1, pairs: readonly [number, number][] = CORNER_PAIRS): { pos: XZ; look: Vec3 } | null => {
    for (const [d, l] of pairs) {
      const px = portal.centerX + intoX * d + latX * (side * l);
      const pz = portal.centerZ + intoZ * d + latZ * (side * l);
      if (chosen.some((c) => Math.hypot(c.x - px, c.z - pz) < 0.75)) continue;
      if (
        Math.abs(px - room.x) > room.width / 2 - 0.36 ||
        Math.abs(pz - room.z) > room.depth / 2 - 0.36
      ) {
        continue;
      }
      if (!isStandable(ctx, px, pz, portal.sillY)) continue;
      if (pathSegmentClear(ctx.colliders, thresh, { x: px, z: pz }, ctx.cfg.bodyRadius, portal.sillY, passable)) {
        chosen.push({ x: px, z: pz });
        return {
          pos: { x: px, z: pz },
          look: {
            x: px + intoX * 1.6 + latX * (side * 0.8),
            y: portal.sillY + 1.38,
            z: pz + intoZ * 1.6 + latZ * (side * 0.8),
          },
        };
      }
    }
    return null;
  };

  const pickFallbackPos = (cands: readonly XZ[], lastResort: XZ): XZ => {
    for (const c of cands) {
      if (isStandable(ctx, c.x, c.z, portal.sillY)) return c;
    }
    return lastResort;
  };

  const left = pickCorner(-1);
  const right = pickCorner(1);
  const roomCenter: XZ = { x: room.x, z: room.z };
  const safeThresh = pickFallbackPos([thresh, roomCenter], thresh);
  if (count <= 1) {
    return [left ?? right ?? { pos: safeThresh, look: { x: room.x, y: portal.sillY + 1.38, z: room.z } }];
  }
  const p1 = left ?? right ?? { pos: safeThresh, look: { x: room.x, y: portal.sillY + 1.38, z: room.z } };
  const deepThresh: XZ = { x: thresh.x + intoX * 0.7, z: thresh.z + intoZ * 0.7 };
  const p2Fallback = pickFallbackPos([deepThresh, roomCenter, safeThresh], safeThresh);
  const p2 = right ?? left ?? { pos: p2Fallback, look: { x: room.x, y: portal.sillY + 1.38, z: room.z } };
  const out = [p1, p2];
  // 3 名以上: 残りは左右交互に内側の壁沿いへ。取れなければ扉正面の奥へ間隔を空けて並べる
  for (let i = 2; i < count; i++) {
    const side: -1 | 1 = i % 2 === 0 ? -1 : 1;
    const inner = pickCorner(side, INNER_PAIRS) ?? pickCorner(side === -1 ? 1 : -1, INNER_PAIRS);
    if (inner) {
      out.push(inner);
      continue;
    }
    const depth = 1.4 + (i - 1) * 0.75;
    const fb = pickFallbackPos(
      [{ x: portal.centerX + intoX * depth, z: portal.centerZ + intoZ * depth }, roomCenter],
      safeThresh,
    );
    out.push({ pos: fb, look: { x: room.x, y: portal.sillY + 1.38, z: room.z } });
  }
  return out;
}

export function findRoomAcrossDoor(ctx: SquadContext, door: Door, approach: number): RoomDef | null {
  const x = door.centerX - door.normalX * approach * 0.75;
  const z = door.centerZ - door.normalZ * approach * 0.75;
  return (
    ctx.rooms.find(
      (r) =>
        Math.abs((r.floorY ?? 0) - door.sillY) < 0.45 &&
        Math.abs(x - r.x) <= r.width / 2 &&
        Math.abs(z - r.z) <= r.depth / 2,
    ) ?? null
  );
}

export function throwFlashbangIntoRoom(ctx: SquadContext, thrower: AllyUnit, portal: EntryPortal): void {
  const intoX = portal.intoX;
  const intoZ = portal.intoZ;
  const start = thrower.body.eye(new THREE.Vector3());
  start.x += intoX * 0.25;
  start.z += intoZ * 0.25;

  let landX = portal.centerX + intoX * 1.4;
  let landZ = portal.centerZ + intoZ * 1.4;
  const doorMid = { x: portal.centerX + intoX * 0.35, y: portal.sillY + 1.15, z: portal.centerZ + intoZ * 0.35 };
  for (const d of [2.5, 1.9, 1.4, 1.0]) {
    const tx = portal.centerX + intoX * d;
    const tz = portal.centerZ + intoZ * d;
    if (
      !blockedAt(ctx.colliders, tx, tz, 0.2, portal.sillY) &&
      hasLineOfSight(ctx.colliders, doorMid, { x: tx, y: portal.sillY + 0.3, z: tz })
    ) {
      landX = tx;
      landZ = tz;
      break;
    }
  }

  const target: Vec3 = { x: landX, y: portal.sillY + 0.08, z: landZ };
  const fuseSec = Math.max(0.35, ctx.cfg.flashDelay);

  if (ctx.flashbang) {
    const origin: Vec3 = { x: start.x, y: start.y, z: start.z };
    const plan = planFlashThrow(
      origin,
      target,
      ctx.doors.doors,
      ctx.windows,
      ctx.colliders,
      ctx.flashbang.gravity,
      0.4,
      SWAT_FLASH_MAX_DIST,
    );
    const velocity =
      plan?.velocity ?? computeBallisticVelocity(origin, target, ctx.flashbang.gravity, 9, 0.22, 0.72);
    ctx.flashbang.throwFrom(origin, velocity, thrower.id, fuseSec);
    ctx.flashesLeft = Math.max(0, ctx.flashesLeft - 1);
    return;
  }

  // Legacy fallback when gadgets.flashbang is omitted
  const end = new THREE.Vector3(target.x, target.y, target.z);
  const mesh = new THREE.Mesh(ctx.flashGeo, ctx.flashMat);
  mesh.position.copy(start);
  ctx.root.add(mesh);

  ctx.thrownFlashes.push({
    start,
    end,
    elapsed: 0,
    flightSec: fuseSec * 0.78,
    fuseSec,
    detonated: false,
    throwerId: thrower.id,
    mesh,
  });
}

export function throwGasIntoRoom(ctx: SquadContext, thrower: AllyUnit, portal: EntryPortal): void {
  if (!ctx.tearGas) return;
  const intoX = portal.intoX;
  const intoZ = portal.intoZ;
  const start = thrower.body.eye(throwEyeTmp);
  const sx = start.x + intoX * 0.25;
  const sz = start.z + intoZ * 0.25;

  let landX = portal.centerX + intoX * 1.8;
  let landZ = portal.centerZ + intoZ * 1.8;
  const doorMid = { x: portal.centerX + intoX * 0.35, y: portal.sillY + 1.15, z: portal.centerZ + intoZ * 0.35 };
  for (const d of [2.8, 2.0, 1.4, 1.0]) {
    const tx = portal.centerX + intoX * d;
    const tz = portal.centerZ + intoZ * d;
    if (
      !blockedAt(ctx.colliders, tx, tz, 0.2, portal.sillY) &&
      hasLineOfSight(ctx.colliders, doorMid, { x: tx, y: portal.sillY + 0.3, z: tz })
    ) {
      landX = tx;
      landZ = tz;
      break;
    }
  }
  const origin: Vec3 = { x: sx, y: start.y, z: sz };
  const target: Vec3 = { x: landX, y: portal.sillY + 0.08, z: landZ };
  const plan = planFlashThrow(
    origin,
    target,
    ctx.doors.doors,
    ctx.windows,
    ctx.colliders,
    ctx.tearGas.gravity,
    0.4,
    SWAT_GAS_MAX_DIST,
  );
  const velocity =
    plan?.velocity ?? computeBallisticVelocity(origin, target, ctx.tearGas.gravity, 9, 0.25, 0.75);
  ctx.tearGas.throwFrom(origin, velocity, thrower.id, plan?.fuse ?? 1.5);
  ctx.gasLeft = Math.max(0, ctx.gasLeft - 1);
  const [gasJa, gasEn] = pickRadio(GAS);
  ctx.emitRadio(thrower, gasJa, gasEn);
}

export function tryAutonomousFlash(ctx: SquadContext, ally: AllyUnit, targetPos: Vec3): boolean {
  if (!ctx.flashbang || ctx.flashesLeft <= 0 || ctx.flashCd > 0 || ally.flashRetryCd > 0) return false;
  for (const s of ctx.entities.suspects.values()) {
    if (
      s.alive &&
      s.state === SuspectState.HOSTAGE_SHIELD &&
      Math.hypot(s.body.px - targetPos.x, s.body.pz - targetPos.z) < 5
    ) {
      return false;
    }
  }
  const eye = ally.body.eye(throwEyeTmp);
  const origin: Vec3 = { x: eye.x, y: eye.y, z: eye.z };
  const plan = planFlashThrow(
    origin,
    targetPos,
    ctx.doors.doors,
    ctx.windows,
    ctx.colliders,
    ctx.flashbang.gravity,
    SWAT_FLASH_MIN_DIST,
    SWAT_FLASH_MAX_DIST,
  );
  if (!plan) {
    ally.flashRetryCd = 0.35;
    return false;
  }
  ctx.flashbang.throwFrom(origin, plan.velocity, ally.id, plan.fuse);
  ctx.flashesLeft--;
  ctx.flashCd = FLASH_TEAM_COOLDOWN;
  const [flashJa, flashEn] = pickRadio(FLASH);
  ctx.emitRadio(ally, flashJa, flashEn);
  return true;
}

export function tryAutonomousGas(ctx: SquadContext): void {
  if (!ctx.tearGas || ctx.gasLeft <= 0 || ctx.gasCd > 0 || ctx.gasRetryCd > 0) return;
  let attempted = false;
  for (const ally of ctx.allies) {
    if (ally.down || ally.blindLeft > 0 || ally.sees) continue;
    if (!ally.known || ally.lostSec < 2.2) continue;
    attempted = true;
    const eye = ally.body.eye(throwEyeTmp);
    const origin: Vec3 = { x: eye.x, y: eye.y, z: eye.z };
    const plan = planFlashThrow(
      origin,
      ally.known,
      ctx.doors.doors,
      ctx.windows,
      ctx.colliders,
      ctx.tearGas.gravity,
      SWAT_GAS_MIN_DIST,
      SWAT_GAS_MAX_DIST,
    );
    if (!plan) continue;
    ctx.tearGas.throwFrom(origin, plan.velocity, ally.id, plan.fuse);
    ctx.gasLeft--;
    ctx.gasCd = GAS_TEAM_COOLDOWN;
    const [flushJa, flushEn] = pickRadio(GAS);
    ctx.emitRadio(ally, flushJa, flushEn);
    return;
  }
  if (attempted) {
    ctx.gasRetryCd = 0.5;
  }
}

export function beginC2Sequence(ctx: SquadContext, lead: AllyUnit, portal: EntryPortal, door: Door): void {
  const side =
    (lead.body.px - door.centerX) * door.normalX + (lead.body.pz - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
  lead.phase = 'c2_plant';
  lead.c2Timer = 0;
  lead.c2BeepTimer = 0;
  lead.c2Side = side;
  lead.c2Standoff = null;
  lead.c2IsLead = true;
  lead.body.setPose('crouch');
  lead.progress = t('C2爆薬設置中', 'Planting C2');
  const [plantJa, plantEn] = pickRadio(C2_PLANT);
  ctx.emitRadio(lead, plantJa, plantEn);

  // 同じポータルの仲間も安全な退避距離へ下がる
  for (const u of ctx.allies) {
    if (u === lead || u.down || u.entryPortal?.id !== portal.id) continue;
    if (u.phase === 'door_prep' || u.phase === 'stacking') {
      u.phase = 'c2_standoff';
      u.c2IsLead = false;
      u.c2Side = side;
      u.c2Standoff = computeC2Standoff(door, side, ctx.colliders, {
        x: u.body.px,
        y: u.body.footY,
        z: u.body.pz,
      });
      u.progress = t('C2起爆退避中', 'C2 Standoff');
    }
  }
}

export function detonateC2(ctx: SquadContext, lead: AllyUnit, portal: EntryPortal, door: Door): void {
  const side = lead.c2Side;
  door.breachExplosive(lead.body.px, lead.body.pz);
  const blastDir: Vec3 = { x: -door.normalX * side, y: 0, z: -door.normalZ * side };
  const doorCenter: Vec3 = { x: door.centerX, y: door.sillY + 1.0, z: door.centerZ };

  ctx.bus.emit('c2Detonated', {
    doorId: door.id,
    pos: doorCenter,
    dir: blastDir,
    radius: SWAT_C2_BLAST_RADIUS,
  });
  ctx.bus.emit('noise', {
    pos: doorCenter,
    radius: 42,
    kind: 'breach',
    source: 'ally',
  });

  // 動的ライトは一切使わず、共有単位球ジオメトリ＋MeshBasicMaterial の火球メッシュのみで爆破 VFX を描画
  const fireMat = new THREE.MeshBasicMaterial({
    color: 0xffaa44,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const fireMesh = new THREE.Mesh(C2_FIREBALL_GEO, fireMat);
  fireMesh.scale.setScalar(0.45);
  fireMesh.position.set(
    doorCenter.x + blastDir.x * 0.45,
    doorCenter.y,
    doorCenter.z + blastDir.z * 0.45,
  );
  ctx.root.add(fireMesh);
  ctx.c2Blasts.push({ mesh: fireMesh, t: 0 });

  // 爆風コーン内の敵対容疑者へダメージ/スタン/士気ショック（民間人・投降者・プレイヤー・味方は保護）
  ctx.entities.applyC2Blast(
    doorCenter,
    blastDir,
    SWAT_C2_BLAST_RADIUS,
    SWAT_C2_BLAST_HALF_ANGLE_DEG,
    SWAT_C2_MAX_DAMAGE,
    lead.id,
  );

  const [detJa, detEn] = pickRadio(C2_DETONATE);
  ctx.emitRadio(lead, detJa, detEn);
  for (const u of ctx.allies) {
    if (u.down || u.entryPortal?.id !== portal.id) continue;
    if (u.phase === 'c2_standoff' || u.phase === 'c2_plant' || u.phase === 'door_prep') {
      u.c2IsLead = false;
      u.c2Standoff = null;
      u.phase = 'entering';
      u.phaseTimer = 0;
    }
  }
}

export function updateC2Blasts(ctx: SquadContext, dt: number): void {
  for (let i = ctx.c2Blasts.length - 1; i >= 0; i--) {
    const b = ctx.c2Blasts[i]!;
    b.t += dt;
    if (b.t < 0.45) {
      const s = 0.45 * (1 + b.t * 5.2);
      b.mesh.scale.setScalar(s);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - b.t / 0.45));
    } else {
      b.mesh.visible = false;
    }
    if (b.t > 0.55) {
      ctx.root.remove(b.mesh);
      (b.mesh.material as THREE.Material).dispose();
      ctx.c2Blasts.splice(i, 1);
    }
  }
}

export function updateThrownFlashes(ctx: SquadContext, dt: number): void {
  for (let i = ctx.thrownFlashes.length - 1; i >= 0; i--) {
    const f = ctx.thrownFlashes[i]!;
    f.elapsed += dt;
    const u = Math.min(1, f.elapsed / f.flightSec);
    f.mesh.position.lerpVectors(f.start, f.end, u);
    f.mesh.position.y += Math.sin(u * Math.PI) * 0.55;
    f.mesh.rotation.x += dt * 10;
    f.mesh.rotation.z += dt * 7;

    if (f.elapsed >= f.fuseSec && !f.detonated) {
      f.detonated = true;
      const pos: Vec3 = { x: f.end.x, y: f.end.y + 0.2, z: f.end.z };
      ctx.bus.emit('flashDetonated', {
        pos,
        radius: ctx.flash.range,
        blindSec: ctx.flash.blindSec,
        thrower: f.throwerId,
      });
      ctx.bus.emit('noise', { pos, radius: 18, kind: 'flash', source: 'ally' });
      ctx.burstMesh.position.set(pos.x, pos.y, pos.z);
      ctx.burstMesh.visible = true;
      ctx.burstLife = 0.35;
      ctx.root.remove(f.mesh);
      ctx.thrownFlashes.splice(i, 1);
    }
  }
}

export function updateStackingPhase(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const portal = ally.entryPortal;
  const slot = ally.stackPos;
  if (!portal || !slot) {
    ally.phase = 'hold';
    return;
  }
  if (!updateStackSettle(ctx, ally, portal, slot, dt)) {
    ally.stackWaitTimer = 0;
    ally.progress = t('スタック位置へ移動', 'Moving to Stack');
    return;
  }
  if (!ally.engaging) {
    const stackLook = computeStackLookPoint(
      cqbPortalFromStackSlotPortal(portal, portal.sillY),
      ally.entryOrder,
      ally.groupSize,
      ally.entryPlan?.rank ?? ally.roleIndex,
      ally.entryPlan?.side ?? -1,
    );
    ally.body.aimAt(stackLook.x, stackLook.y, stackLook.z, dt, Math.PI * 2 * dt);
  }
  // door_prep への遷移はグループ単位（updatePortalGroups）。個人のタイムアウトで先走らない
  const g = ctx.portalGroups.get(portal.id);
  ally.stackWaitTimer = g?.waitT ?? 0;
  ally.progress = g?.allSettled ? t('スタック完了', 'Stacked Up') : t('味方整列待ち', 'Waiting on Team');
}

export function updateDoorPrepPhase(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const portal = ally.entryPortal;
  if (!portal) {
    ally.phase = 'hold';
    return;
  }
  const body = ally.body;
  const door = portal.door;
  const cqbPortal = cqbPortalFromStackSlotPortal(portal, portal.sillY);
  const isDoorLead =
    ally.roleIndex === 0 ||
    !ctx.allies.some(
      (u) => !u.down && u.entryPortal?.id === portal.id && u.phase === 'door_prep' && u.roleIndex < ally.roleIndex,
    );
  const settledAtSlot = ally.stackPos ? updateStackSettle(ctx, ally, portal, ally.stackPos, dt) : true;
  if (!ally.engaging && settledAtSlot) {
    const stackLook = computeStackLookPoint(
      cqbPortal,
      ally.entryOrder,
      ally.groupSize,
      ally.entryPlan?.rank ?? ally.roleIndex,
      ally.entryPlan?.side ?? -1,
    );
    body.aimAt(stackLook.x, stackLook.y, stackLook.z, dt, Math.PI * 2 * dt);
  }

  const useStealth = ally.order === 'pieDoor' || (ally.order === 'clear' && ctx.entryMode === 'stealth');

  if (door) {
    if (ally.order === 'pieDoor' && door.locked) {
      ally.progress = t('施錠のため開けません', 'Door Locked');
      if (isDoorLead) {
        const [lockJa, lockEn] = pickRadio(DOOR_LOCKED);
        ctx.emitRadio(ally, lockJa, lockEn);
      }
      ally.phase = 'hold';
      ally.watchYaw = ally.body.yawRad;
      return;
    }

    // C2 爆破ブリーチ（c2Clear 指示、または施錠ドアへの breachClear）
    if (
      isDoorLead &&
      !door.isMoving &&
      door.angle < ctx.cfg.doorOpenAngle &&
      (ally.order === 'c2Clear' ||
        (ally.order === 'breachClear' &&
          door.locked &&
          (shouldUseC2Breach(0.5, ++ctx.lockedDoorsEncountered) || door.locked)))
    ) {
      beginC2Sequence(ctx, ally, portal, door);
      return;
    }

    // ステルス／pieDoor: まず peekAngle（半開き）まで静かに開けて内部を覗き確認
    if (useStealth && !door.locked && !ally.peekDone && door.angle < ctx.cfg.doorOpenAngle) {
      const peekReadyAngle = Math.max(8, door.peekAngle - 2);
      if (isDoorLead) {
        if (door.angle < peekReadyAngle && !door.isMoving) {
          door.command(door.peekAngle, false, body.px, body.pz);
          const [crackJa, crackEn] = pickRadio(CRACK_DOOR);
          ctx.emitRadio(ally, crackJa, crackEn);
        }
        if (door.angle >= peekReadyAngle) {
          ally.peekHold += dt;
          if (!ally.engaging) {
            body.aimAt(
              portal.centerX + portal.intoX * 2.4,
              portal.sillY + 1.38,
              portal.centerZ + portal.intoZ * 2.4,
              dt,
              Math.PI * 2 * dt,
            );
          }
          if (ally.peekHold >= STEALTH_PEEK_HOLD_SEC) {
            for (const u of ctx.allies) {
              if (!u.down && u.entryPortal?.id === portal.id) u.peekDone = true;
            }
            door.command(door.maxAngle, false, body.px, body.pz);
          }
        }
        ally.progress = t('扉半開き確認中', 'Peeking Door');
      } else {
        ally.progress = t('扉開放援護中', 'Covering Door');
      }
      return;
    }

    if (isDoorLead && !door.isMoving && door.angle < ctx.cfg.doorOpenAngle) {
      if (ally.order === 'breachClear' || door.locked) {
        door.breach(body.px, body.pz, 'swat');
      } else {
        door.command(door.maxAngle, !useStealth, body.px, body.pz);
      }
    }

    if (door.angle < ctx.cfg.doorOpenAngle) {
      ally.progress = door.locked ? t('ブリーチ準備', 'Prepping Breach') : t('ドア開放中', 'Opening Door');
      return;
    }
  }

  // ステルスモードの clear または pieDoor: 先頭がドア外周をスライシング・ザ・パイ
  if (useStealth) {
    const someonePieing = ctx.allies.some(
      (u) => !u.down && u.entryPortal?.id === portal.id && u.phase === 'pieing',
    );
    if (someonePieing) {
      ally.progress = t('パイ切り援護中', 'Covering Pie');
      return;
    }
    if (isDoorLead && ally.targetRoom) {
      const side: -1 | 1 = ally.entryPlan?.side ?? -1;
      const steps = planDoorPieArc(cqbPortal, cqbRoomFromRoomDef(ally.targetRoom), side, {
        isStandable: (p) => !blockedAt(ctx.colliders, p.x, p.z, ctx.cfg.bodyRadius, portal.sillY),
      });
      if (steps.length > 0) {
        ally.pieSteps = steps;
        ally.pieIdx = 0;
        ally.pieHold = 0;
        ally.pieElapsed = 0;
        ally.stealthEntry = ally.order === 'clear';
        ally.phase = 'pieing';
        const [pieJa, pieEn] = pickRadio(CHECK_FROM_DOOR);
        ctx.emitRadio(ally, pieJa, pieEn);
        return;
      }
    }
    if (ally.order === 'pieDoor') {
      ally.progress = t('ドア外から警戒中', 'Covering Threshold');
      if (!ally.engaging) {
        const lookSide = ally.roleIndex === 0 ? -0.9 : 0.9;
        body.aimAt(
          portal.centerX + portal.intoX * 2.8 + portal.axisX * lookSide,
          portal.sillY + 1.35,
          portal.centerZ + portal.intoZ * 2.8 + portal.axisZ * lookSide,
          dt,
          Math.PI * 2 * dt,
        );
      }
      return;
    }
  }

  if (ally.order === 'flashClear' && !ally.flashed) {
    const thrower =
      ctx.allies.find(
        (u) => !u.down && u.entryPortal?.id === portal.id && u.order === 'flashClear' && (u.groupSize > 1 ? u.roleIndex === 1 : u.roleIndex === 0),
      ) ?? ally;
    throwFlashbangIntoRoom(ctx, thrower, portal);
    for (const u of ctx.allies) {
      if (!u.down && u.entryPortal?.id === portal.id && u.order === 'flashClear') {
        u.flashed = true;
        u.phase = 'flash_wait';
        u.phaseTimer = ctx.cfg.flashDelay + 0.08;
        u.progress = t('閃光弾投擲・退避', 'Throwing Flashbang');
      }
    }
    return;
  }

  if (ally.order === 'gasClear' && !ally.gassed) {
    const thrower =
      ctx.allies.find(
        (u) => !u.down && u.entryPortal?.id === portal.id && u.order === 'gasClear' && (u.groupSize > 1 ? u.roleIndex === 1 : u.roleIndex === 0),
      ) ?? ally;
    throwGasIntoRoom(ctx, thrower, portal);
    for (const u of ctx.allies) {
      if (!u.down && u.entryPortal?.id === portal.id && u.order === 'gasClear') {
        u.gassed = true;
        u.phase = 'gas_wait';
        u.phaseTimer = 1.65;
        u.progress = t('CSガス投入・待機', 'Deploying CS Gas');
      }
    }
    return;
  }

  ally.stealthEntry = useStealth && ally.order === 'clear';
  ally.phase = 'entering';
  ally.phaseTimer = 0;
  if (isDoorLead) {
    const [goJa, goEn] = pickRadio(ally.order === 'breachClear' ? BREACH_IN : MOVE_IN);
    ctx.emitRadio(ally, goJa, goEn);
  }
}

export function updatePieingPhase(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const portal = ally.entryPortal;
  const body = ally.body;
  if (!portal || ally.pieSteps.length === 0) {
    ally.phase = ally.order === 'pieDoor' ? 'door_prep' : 'entering';
    ally.phaseTimer = 0;
    return;
  }
  ally.pieElapsed += dt;
  // パイ切り中に敵を視認したら室外からそのまま交戦（Limited Penetration）
  if (ally.engaging) {
    ally.progress = t('室外から交戦中', 'Engaging from Threshold');
    return;
  }
  const idx = Math.min(ally.pieIdx, ally.pieSteps.length - 1);
  const step = ally.pieSteps[idx]!;
  const d = Math.hypot(step.pos.x - body.px, step.pos.z - body.pz);
  if (d > 0.26) {
    ally.progress = t('スライシング・ザ・パイ', 'Slicing the Pie');
    navigateTo(
      ctx,
      ally,
      step.pos.x,
      step.pos.z,
      portal.sillY,
      dt,
      false,
      false,
      null,
      ally.combat.moveSpeed * PIE_SPEED_MUL,
      true,
    );
    body.aimAt(step.look.x, step.look.y, step.look.z, dt, Math.PI * 2.2 * dt);
  } else {
    body.aimAt(step.look.x, step.look.y, step.look.z, dt, Math.PI * 2.2 * dt);
    ally.pieHold += dt;
    ally.progress =
      ally.pieIdx >= ally.pieSteps.length
        ? t('ドア外から警戒中', 'Covering Threshold')
        : t('クリア角確認中', 'Checking Angles');
    if (ally.pieIdx < ally.pieSteps.length && ally.pieHold >= PIE_STEP_HOLD_SEC) {
      ally.pieIdx++;
      ally.pieHold = 0;
    }
  }
  if (ally.pieIdx >= ally.pieSteps.length || ally.pieElapsed >= PIE_TIMEOUT_SEC) {
    if (ally.order === 'pieDoor') {
      ally.progress = t('ドア外から警戒中', 'Covering Threshold');
      return;
    }
    // パイ切り完了: グループ全員をステルス進入（entering）へ移行
    for (const u of ctx.allies) {
      if (!u.down && u.entryPortal?.id === portal.id && (u.phase === 'door_prep' || u.phase === 'pieing')) {
        u.stealthEntry = true;
        u.phase = 'entering';
        u.phaseTimer = 0;
      }
    }
    const [quietJa, quietEn] = pickRadio(QUIET_ENTRY);
    ctx.emitRadio(ally, quietJa, quietEn);
  }
}

export function updateC2PlantPhase(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const portal = ally.entryPortal;
  const door = portal?.door;
  const body = ally.body;
  if (!portal || !door) {
    body.setPose('stand');
    ally.phase = 'entering';
    return;
  }
  if (door.angle >= ctx.cfg.doorOpenAngle) {
    body.setPose('stand');
    ally.phase = 'entering';
    ally.phaseTimer = 0;
    return;
  }
  body.faceToward(door.centerX, door.centerZ);
  body.setPose('crouch');
  ally.progress = t('C2爆薬設置中', 'Planting C2');
  ally.c2Timer += dt;
  if (ally.c2Timer >= SWAT_C2_PLANT_SEC) {
    body.setPose('stand');
    ally.c2Standoff = computeC2Standoff(door, ally.c2Side, ctx.colliders, {
      x: body.px,
      y: body.footY,
      z: body.pz,
    });
    ally.phase = 'c2_standoff';
    ally.c2Timer = 0;
    ally.c2BeepTimer = 0;
    ctx.bus.emit('c2Beep', {
      pos: { x: door.centerX, y: door.sillY + 1.0, z: door.centerZ },
      urgent: false,
    });
  }
}

export function updateC2StandoffPhase(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const portal = ally.entryPortal;
  const door = portal?.door;
  const body = ally.body;
  if (!portal || !door) {
    ally.phase = 'entering';
    return;
  }
  if (ally.c2Standoff && Math.hypot(body.px - ally.c2Standoff.x, body.pz - ally.c2Standoff.z) > 0.35) {
    navigateTo(ctx, ally, ally.c2Standoff.x, ally.c2Standoff.z, portal.sillY, dt, false, false);
  }
  if (!ally.engaging) {
    body.aimAt(door.centerX, door.sillY + 1.38, door.centerZ, dt, Math.PI * 2 * dt);
  }
  ally.progress = t('C2起爆退避中', 'C2 Standoff');
  if (!ally.c2IsLead) {
    if (door.angle >= ctx.cfg.doorOpenAngle) {
      ally.phase = 'entering';
      ally.phaseTimer = 0;
    }
    return;
  }
  ally.c2Timer += dt;
  ally.c2BeepTimer += dt;
  const urgent = ally.c2Timer >= SWAT_C2_URGENT_AT_SEC;
  const interval = urgent ? SWAT_C2_URGENT_BEEP_INTERVAL : SWAT_C2_BEEP_INTERVAL;
  if (ally.c2BeepTimer >= interval && ally.c2Timer < SWAT_C2_FUSE_SEC) {
    ally.c2BeepTimer = 0;
    ctx.bus.emit('c2Beep', {
      pos: { x: door.centerX, y: door.sillY + 1.0, z: door.centerZ },
      urgent,
    });
  }
  if (ally.c2Timer >= SWAT_C2_FUSE_SEC) {
    detonateC2(ctx, ally, portal, door);
  }
}

export function updateFlashWaitPhase(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const portal = ally.entryPortal;
  if (portal && !ally.engaging) {
    ally.body.aimAt(portal.centerX, portal.sillY + 1.38, portal.centerZ, dt, Math.PI * 2 * dt);
  }
  ally.phaseTimer -= dt;
  ally.progress = t('閃光起爆待ち', 'Waiting for Flash');
  if (ally.phaseTimer <= 0) {
    ally.phase = 'entering';
    ally.phaseTimer = 0;
    if (ally.roleIndex === 0) {
      const [ja, en] = pickRadio(FLASH_GO);
      ctx.emitRadio(ally, ja, en);
    }
  }
}

export function updateGasWaitPhase(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const portal = ally.entryPortal;
  if (portal && !ally.engaging) {
    ally.body.aimAt(portal.centerX, portal.sillY + 1.38, portal.centerZ, dt, Math.PI * 2 * dt);
  }
  ally.phaseTimer -= dt;
  ally.progress = t('CSガス展開待ち', 'Waiting for Gas');
  if (ally.phaseTimer <= 0) {
    ally.phase = 'entering';
    ally.phaseTimer = 0;
    if (ally.roleIndex === 0) {
      const [ja, en] = pickRadio(GAS_GO);
      ctx.emitRadio(ally, ja, en);
    }
  }
}

export function updateEnteringPhase(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const portal = ally.entryPortal;
  const body = ally.body;
  if (!portal) {
    ally.phase = 'hold';
    return;
  }
  // 突入順ゲート: 順番 k は「k-1 が敷居を越えた」かつ「k-1 の開始から stagger 秒」で発進（フェイルセーフ 2.5s）
  // C2 起爆後・閃光/ガス待ち明けの一斉 entering もここを通るので同じ順序になる
  if (ally.entryStartT < 0) {
    if (!entryGateOpen(ctx, ally)) {
      ally.entryGateWait += dt;
      ally.progress = t(`${ally.entryOrder + 1}番手突入待ち`, `Entry #${ally.entryOrder + 1} Standby`);
      if (!ally.engaging) {
        body.aimAt(portal.centerX, portal.sillY + 1.38, portal.centerZ, dt, Math.PI * 2 * dt);
      }
      return;
    }
    replanGroupOnRelease(ctx, portal);
    ally.entryStartT = ctx.simTime;
    ally.phaseTimer = 0;
    ally.entryWp = 0;
    ally.stalled = 0;
    ally.stuckStage = 0;
    ally.anchor = { x: body.px, z: body.pz };
    ally.settled = false;
  }

  ally.phaseTimer += dt;
  const beyond =
    (body.px - portal.centerX) * portal.intoX + (body.pz - portal.centerZ) * portal.intoZ;
  if (beyond > 0.35 && !ally.entered) {
    ally.entered = true;
    ally.entryCrossT = ctx.simTime;
  }

  const plan = ally.entryPlan;
  const wps: XZ[] = plan
    ? plan.waypoints
    : [
        { x: portal.centerX + portal.intoX * 0.72, z: portal.centerZ + portal.intoZ * 0.72 },
        ally.podPos ?? { x: portal.centerX + portal.intoX * 1.4, z: portal.centerZ + portal.intoZ * 1.4 },
      ];
  // waypoint を順に（中間点 arrive 0.3。敷居点は奥行きで追い越していれば通過扱い）
  while (ally.entryWp < wps.length - 1) {
    const w = wps[ally.entryWp]!;
    const wBeyond = (w.x - portal.centerX) * portal.intoX + (w.z - portal.centerZ) * portal.intoZ;
    if (
      Math.hypot(w.x - body.px, w.z - body.pz) <= ENTRY_WP_ARRIVE ||
      (ally.entryWp === 0 && ally.entered && beyond > wBeyond + 0.1)
    ) {
      ally.entryWp++;
    } else {
      break;
    }
  }
  const isLast = ally.entryWp >= wps.length - 1;
  const dest = wps[Math.min(ally.entryWp, wps.length - 1)]!;
  const d = Math.hypot(dest.x - body.px, dest.z - body.pz);
  const timedOut = ally.phaseTimer >= ENTRY_TIMEOUT_SEC || ally.stalled >= ENTRY_STALL_SEC;
  if (!(isLast && d <= ENTRY_POD_ARRIVE) && !timedOut) {
    ally.progress = t('室内に突入展開', 'Making Entry');
    const entrySpeed = ally.stealthEntry ? ally.combat.moveSpeed * STEALTH_ENTRY_SPEED_MUL : undefined;
    navigateTo(ctx, ally, dest.x, dest.z, portal.sillY, dt, false, false, null, entrySpeed, isLast);
    if (!ally.engaging) {
      // 敷居までは自サイド反対側のコーナー、rank0 は壁沿い移動中にハードコーナー、以降は PoD 保持視線
      const wantKey = !ally.entered
        ? 'threat'
        : plan && plan.rank === 0 && ally.entryWp < wps.length - 1
          ? 'corner'
          : 'pod';
      const key = holdLook(ally, wantKey, dt);
      const look =
        (key === 'threat'
          ? ally.entryThreatLook
          : key === 'corner'
            ? plan?.hardCornerLook
            : ally.podLook) ??
        ally.podLook ?? {
          x: dest.x + portal.intoX * 1.5,
          y: portal.sillY + 1.38,
          z: dest.z + portal.intoZ * 1.5,
        };
      body.aimAt(look.x, look.y, look.z, dt, Math.PI * 2.2 * dt);
    }
    return;
  }

  // 後続のゲートが詰まらないよう、敷居を越えずに終わっても越境扱いにする
  if (ally.entryCrossT < 0) ally.entryCrossT = ctx.simTime;
  ally.phase = 'sweeping';
  ally.sweepElapsed = 0;
  ally.stalled = 0;
  ally.podReturnT = 0;
  // タイムアウト時もその場で捜索に移らず、可能なら PoD 保持へ（updateSweeping の holdAtPod）
  ally.settled = isLast && d <= ENTRY_POD_ARRIVE;
}
