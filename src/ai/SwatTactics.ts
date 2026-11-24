import type { RoomDef, Vec3, WindowDef } from '../core/types';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { StairMark } from '../world/Walk';
import type { Collider } from '../world/WorldBuilder';
import { blockedAtFiltered, reachableRouteLength } from './SquadRoute';
import type { StackSlotPortal } from './stackSlots';
import {
  SWAT_C2_BLAST_HALF_ANGLE_DEG,
  SWAT_C2_BLAST_RADIUS,
  SWAT_C2_MAX_DAMAGE,
  SWAT_FLASH_MAX_DIST,
  SWAT_FLASH_MIN_DIST,
} from './SwatProfile';

const DEG2RAD = Math.PI / 180;

// ---------- 入口・ポータル判定 ----------

export interface EntrySample {
  id: string;
  centerX: number;
  centerZ: number;
  normalX: number;
  normalZ: number;
  sillY: number;
}

export interface EntryPortal {
  id: string;
  outside: Vec3;
  inside: Vec3;
  sillY: number;
}

export interface EntryRoute {
  dest: Vec3;
  entryId: string | null;
  /** direct = 目標そのもの。approach = 屋外側の入口。cross = ドアを抜けた屋内側 */
  phase: 'direct' | 'approach' | 'cross';
}

/** 屋内の部屋（outdoor 以外）にいるか。重なる場合は小さい部屋を優先する。 */
export function isIndoorPoint(rooms: readonly RoomDef[], x: number, z: number, y: number): boolean {
  let best: RoomDef | null = null;
  let bestArea = Infinity;
  for (const r of rooms) {
    if (r.outdoor) continue;
    if (Math.abs((r.floorY ?? 0) - y) > 0.75) continue;
    if (Math.abs(x - r.x) > r.width / 2 || Math.abs(z - r.z) > r.depth / 2) continue;
    const area = r.width * r.depth;
    if (area < bestArea) {
      bestArea = area;
      best = r;
    }
  }
  return best !== null;
}

const ENTRY_OFFSETS = [0.8, 1.25];

/** 片側だけ屋内のドア（外壁の入口）。室内ドアは除外する。 */
export function listExteriorEntries(rooms: readonly RoomDef[], doors: readonly EntrySample[]): EntryPortal[] {
  const out: EntryPortal[] = [];
  for (const door of doors) {
    for (const dist of ENTRY_OFFSETS) {
      const ax = door.centerX + door.normalX * dist;
      const az = door.centerZ + door.normalZ * dist;
      const bx = door.centerX - door.normalX * dist;
      const bz = door.centerZ - door.normalZ * dist;
      const aIn = isIndoorPoint(rooms, ax, az, door.sillY);
      const bIn = isIndoorPoint(rooms, bx, bz, door.sillY);
      if (aIn === bIn) continue;
      const inside = aIn ? { x: ax, y: door.sillY, z: az } : { x: bx, y: door.sillY, z: bz };
      const outside = aIn ? { x: bx, y: door.sillY, z: bz } : { x: ax, y: door.sillY, z: az };
      out.push({ id: door.id, outside, inside, sillY: door.sillY });
      break;
    }
  }
  return out;
}

function pickEntryPortal(entries: readonly EntryPortal[], from: Vec3, goal: Vec3): EntryPortal | null {
  const same = entries.filter((e) => Math.abs(e.sillY - from.y) < 1.1);
  const pool = same.length > 0 ? same : entries;
  let best: EntryPortal | null = null;
  let bestScore = Infinity;
  for (const e of pool) {
    const score =
      Math.hypot(e.outside.x - from.x, e.outside.z - from.z) +
      Math.hypot(e.inside.x - goal.x, e.inside.z - goal.z) +
      Math.abs(e.sillY - goal.y) * 4;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

/**
 * 屋外にいる隊員が屋内の音・部屋へ向かうとき、外壁ドアの進入点を返す。
 * 直線距離で壁の向こうに「着いた」ことにしない。屋内に入ってから本来の目標へ進む。
 */
export function entryRouteDest(
  rooms: readonly RoomDef[],
  entries: readonly EntryPortal[],
  from: Vec3,
  goal: Vec3,
  preferPortalId?: string | null,
): EntryRoute {
  if (isIndoorPoint(rooms, from.x, from.z, from.y) || !isIndoorPoint(rooms, goal.x, goal.z, goal.y)) {
    return { dest: goal, entryId: null, phase: 'direct' };
  }
  const preferred = preferPortalId
    ? entries.find((e) => e.id === preferPortalId && Math.abs(e.sillY - from.y) < 1.1) ?? null
    : null;
  const portal = preferred ?? pickEntryPortal(entries, from, goal);
  if (!portal) return { dest: goal, entryId: null, phase: 'direct' };
  const dist = Math.hypot(portal.outside.x - from.x, portal.outside.z - from.z);
  if (dist > 1.15) return { dest: portal.outside, entryId: portal.id, phase: 'approach' };
  return { dest: portal.inside, entryId: portal.id, phase: 'cross' };
}

// ---------- 間接フラッシュバン・催涙ガス投擲（ドア枠・窓・1バウンド壁反射） ----------

export interface FlashDoorSample {
  id: string;
  centerX: number;
  centerZ: number;
  normalX: number;
  normalZ: number;
  sillY: number;
  width: number;
  height: number;
  angle: number;
  locked: boolean;
}

export interface FlashThrowPlan {
  velocity: Vec3;
  aimPoint: Vec3;
  fuse: number;
  kind: 'direct' | 'doorway' | 'window' | 'bank';
}

const FLASH_BANK_RESTITUTION = 0.45;
const FLASH_BANK_FRICTION = 0.7;
const FLASH_BANK_FAN_DEG = [-65, -50, -35, -20, -10, 10, 20, 35, 50, 65] as const;

/** origin から target へ重力下で到達する初速ベクトルを算出する。 */
export function computeBallisticVelocity(
  origin: Vec3,
  target: Vec3,
  gravity: number,
  speed = 9,
  minT = 0.2,
  maxT = 0.95,
): Vec3 {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const t = Math.max(minT, Math.min(maxT, Math.hypot(dx, dz) / speed));
  return {
    x: dx / t,
    y: (dy + 0.5 * gravity * t * t) / t,
    z: dz / t,
  };
}

/** 開いているドア開口部（鴨居より下）を通して別室の目標側へ投げ込む軌道を計画する。 */
export function planDoorwayFlashThrow(
  origin: Vec3,
  target: Vec3,
  doors: readonly FlashDoorSample[],
  colliders: readonly Collider[],
  gravity: number,
  maxDist = 9,
): FlashThrowPlan | null {
  let bestScore = Infinity;
  let bestPortal: Vec3 | null = null;
  for (const door of doors) {
    if (door.locked || door.angle < 25) continue;
    if (Math.abs(door.sillY - target.y) > 0.85) continue;
    const distToDoor = Math.hypot(door.centerX - origin.x, door.centerZ - origin.z);
    if (distToDoor < 1.0 || distToDoor > maxDist) continue;
    const distDoorToTarget = Math.hypot(target.x - door.centerX, target.z - door.centerZ);
    if (distDoorToTarget > 8.0) continue;
    const side = (origin.x - door.centerX) * door.normalX + (origin.z - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
    const targetDot = (target.x - door.centerX) * door.normalX + (target.z - door.centerZ) * door.normalZ;
    if (targetDot * side >= 0.3) continue;
    const portalY = door.sillY + Math.min(1.05, Math.max(0.5, door.height - 0.35));
    const portalPt: Vec3 = { x: door.centerX, y: portalY, z: door.centerZ };
    const inPt: Vec3 = {
      x: door.centerX - door.normalX * side * 1.8,
      y: door.sillY + 0.7,
      z: door.centerZ - door.normalZ * side * 1.8,
    };
    if (!hasLineOfSight(colliders, origin, portalPt)) continue;
    if (!hasLineOfSight(colliders, portalPt, inPt)) continue;
    const score = distToDoor + distDoorToTarget;
    if (score < bestScore) {
      bestScore = score;
      bestPortal = portalPt;
    }
  }
  if (!bestPortal) return null;
  return {
    velocity: computeBallisticVelocity(origin, bestPortal, gravity, 9.5, 0.18, 0.75),
    aimPoint: bestPortal,
    fuse: 1.5,
    kind: 'doorway',
  };
}

/** バリケードされていない窓開口部を通して室内へ投げ込む軌道を計画する。 */
export function planWindowFlashThrow(
  origin: Vec3,
  target: Vec3,
  windows: readonly WindowDef[],
  colliders: readonly Collider[],
  gravity: number,
  maxDist = 9,
): FlashThrowPlan | null {
  let bestScore = Infinity;
  let bestWin: Vec3 | null = null;
  for (const w of windows) {
    const floorY = w.y ?? 0;
    if (Math.abs(floorY - target.y) > 0.85) continue;
    const distToWin = Math.hypot(w.x - origin.x, w.z - origin.z);
    if (distToWin < 1.0 || distToWin > maxDist) continue;
    const distWinToTarget = Math.hypot(target.x - w.x, target.z - w.z);
    if (distWinToTarget > 8.0) continue;
    const nx = -Math.sin(w.yaw * DEG2RAD);
    const nz = Math.cos(w.yaw * DEG2RAD);
    const side = (origin.x - w.x) * nx + (origin.z - w.z) * nz >= 0 ? 1 : -1;
    const targetDot = (target.x - w.x) * nx + (target.z - w.z) * nz;
    if (targetDot * side >= 0.3) continue;
    const winPt: Vec3 = { x: w.x, y: floorY + w.sill + w.height * 0.5, z: w.z };
    const inPt: Vec3 = {
      x: w.x - nx * side * 1.6,
      y: floorY + Math.max(0.6, w.sill),
      z: w.z - nz * side * 1.6,
    };
    if (!hasLineOfSight(colliders, origin, winPt)) continue;
    if (!hasLineOfSight(colliders, winPt, inPt)) continue;
    const score = distToWin + distWinToTarget;
    if (score < bestScore) {
      bestScore = score;
      bestWin = winPt;
    }
  }
  if (!bestWin) return null;
  return {
    velocity: computeBallisticVelocity(origin, bestWin, gravity, 10.0, 0.18, 0.75),
    aimPoint: bestWin,
    fuse: 1.5,
    kind: 'window',
  };
}

/** 水平方向の壁（kind==='wall'）に対する最寄りレイキャスト。外向き単位法線 (nx, nz) を返す。 */
export function raycastWallXZ(
  colliders: readonly Collider[],
  origin: Vec3,
  dirX: number,
  dirZ: number,
  maxDist: number,
): { dist: number; point: Vec3; nx: number; nz: number } | null {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6) return null;
  const dx = dirX / len;
  const dz = dirZ / len;
  let bestDist = maxDist;
  let bestNx = 0;
  let bestNz = 0;
  let hit = false;
  for (const c of colliders) {
    if (c.kind !== 'wall') continue;
    const a = c.aabb;
    if (origin.y < a.min.y || origin.y > a.max.y) continue;
    let txMin: number;
    let txMax: number;
    if (Math.abs(dx) < 1e-8) {
      if (origin.x < a.min.x || origin.x > a.max.x) continue;
      txMin = -Infinity;
      txMax = Infinity;
    } else {
      const t1 = (a.min.x - origin.x) / dx;
      const t2 = (a.max.x - origin.x) / dx;
      txMin = Math.min(t1, t2);
      txMax = Math.max(t1, t2);
    }
    let tzMin: number;
    let tzMax: number;
    if (Math.abs(dz) < 1e-8) {
      if (origin.z < a.min.z || origin.z > a.max.z) continue;
      tzMin = -Infinity;
      tzMax = Infinity;
    } else {
      const t1 = (a.min.z - origin.z) / dz;
      const t2 = (a.max.z - origin.z) / dz;
      tzMin = Math.min(t1, t2);
      tzMax = Math.max(t1, t2);
    }
    const tMin = Math.max(txMin, tzMin);
    const tMax = Math.min(txMax, tzMax);
    if (tMax < Math.max(0, tMin) || tMin <= 1e-4 || tMin >= bestDist) continue;
    bestDist = tMin;
    if (txMin > tzMin) {
      bestNx = dx > 0 ? -1 : 1;
      bestNz = 0;
    } else {
      bestNx = 0;
      bestNz = dz > 0 ? -1 : 1;
    }
    hit = true;
  }
  if (!hit) return null;
  return {
    dist: bestDist,
    point: { x: origin.x + dx * bestDist, y: origin.y, z: origin.z + dz * bestDist },
    nx: bestNx,
    nz: bestNz,
  };
}

/** 1 バウンド壁反射で曲がり角・隣接室の目標へフラッシュバンを送り込む軌道を計画する。 */
export function planWallBankFlashThrow(
  origin: Vec3,
  target: Vec3,
  colliders: readonly Collider[],
  gravity: number,
  maxDist = 9,
): FlashThrowPlan | null {
  const baseAngle = Math.atan2(target.z - origin.z, target.x - origin.x);
  let bestScore = -Infinity;
  let bestPoint: Vec3 | null = null;
  const targetAim: Vec3 = { x: target.x, y: target.y + 0.6, z: target.z };

  for (const deg of FLASH_BANK_FAN_DEG) {
    const ang = baseAngle + deg * DEG2RAD;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const hit = raycastWallXZ(colliders, origin, dx, dz, maxDist);
    if (!hit || hit.dist < 1.2) continue;
    const vn = dx * hit.nx + dz * hit.nz;
    if (vn >= -0.25) continue;
    const tx = dx - vn * hit.nx;
    const tz = dz - vn * hit.nz;
    const rx = -FLASH_BANK_RESTITUTION * vn * hit.nx + FLASH_BANK_FRICTION * tx;
    const rz = -FLASH_BANK_RESTITUTION * vn * hit.nz + FLASH_BANK_FRICTION * tz;
    const rLen = Math.hypot(rx, rz);
    if (rLen < 1e-4) continue;
    const bPt: Vec3 = {
      x: hit.point.x + hit.nx * 0.12,
      y: target.y + 1.0,
      z: hit.point.z + hit.nz * 0.12,
    };
    const toTx = target.x - bPt.x;
    const toTz = target.z - bPt.z;
    const distAfter = Math.hypot(toTx, toTz);
    if (distAfter < 0.8 || distAfter > 7.5) continue;
    const dot = (rx * toTx + rz * toTz) / (rLen * distAfter);
    if (dot < 0.78) continue;
    if (!hasLineOfSight(colliders, origin, bPt)) continue;
    if (!hasLineOfSight(colliders, bPt, targetAim)) continue;
    const score = dot - distAfter * 0.04;
    if (score > bestScore) {
      bestScore = score;
      bestPoint = bPt;
    }
  }
  if (!bestPoint) return null;
  return {
    velocity: computeBallisticVelocity(origin, bestPoint, gravity, 11.0, 0.15, 0.75),
    aimPoint: bestPoint,
    fuse: 1.5,
    kind: 'bank',
  };
}

/** 直投 → ドア枠 → 窓 → 1バウンド壁反射の優先順でフラッシュバン投擲を計画する。 */
export function planFlashThrow(
  origin: Vec3,
  target: Vec3,
  doors: readonly FlashDoorSample[],
  windows: readonly WindowDef[],
  colliders: readonly Collider[],
  gravity: number,
  minDirectDist = SWAT_FLASH_MIN_DIST,
  maxDist = SWAT_FLASH_MAX_DIST,
): FlashThrowPlan | null {
  const horiz = Math.hypot(target.x - origin.x, target.z - origin.z);
  const directAim: Vec3 = { x: target.x, y: target.y + 0.4, z: target.z };
  if (horiz >= minDirectDist && horiz <= maxDist && hasLineOfSight(colliders, origin, directAim)) {
    return {
      velocity: computeBallisticVelocity(origin, { x: target.x, y: target.y + 0.3, z: target.z }, gravity, 9, 0.35, 0.9),
      aimPoint: directAim,
      fuse: 1.6,
      kind: 'direct',
    };
  }
  const doorway = planDoorwayFlashThrow(origin, target, doors, colliders, gravity, maxDist);
  if (doorway) return doorway;
  const win = planWindowFlashThrow(origin, target, windows, colliders, gravity, maxDist);
  if (win) return win;
  return planWallBankFlashThrow(origin, target, colliders, gravity, maxDist);
}

// ---------- 多方向同時突入（F6） ----------

/**
 * 地上階の高度一致（sillY）と屋外からの実経路到達可能性（reachableRouteLength, passable=undefined）で
 * 真に外周から歩いて到達できる入口ポータルだけを抽出し、スポーンからの経路長昇順で返す。
 */
export function filterReachableExteriorEntries(
  entries: readonly EntryPortal[],
  spawn: Vec3,
  colliders: readonly Collider[],
  bounds: { width: number; depth: number },
  radius = 0.35,
): EntryPortal[] {
  const scored: { portal: EntryPortal; len: number }[] = [];
  for (const e of entries) {
    if (Math.abs(e.sillY - spawn.y) >= 1.1) continue;
    const len = reachableRouteLength(
      { x: spawn.x, z: spawn.z },
      { x: e.outside.x, z: e.outside.z },
      spawn.y,
      colliders,
      bounds,
      radius,
    );
    if (len === null) continue;
    scored.push({ portal: e, len });
  }
  scored.sort((a, b) => a.len - b.len || a.portal.id.localeCompare(b.portal.id));
  return scored.map((s) => s.portal);
}

/**
 * セル数と到達可能な外壁ポータル一覧から、各セルの担当ポータルを決定する。
 * - 0 入口: []（スタックをスキップ）
 * - 1 入口: 全セルを同一入口へ（house_compact 等のフォールバック）
 * - 2 入口以上: Red(0) に最寄り入口、後続セルには既割り当て入口からの最小距離が最大になる入口を貪欲に割り当てる。
 */
export function assignCellPortals(cellCount: number, reachablePortals: readonly EntryPortal[]): EntryPortal[] {
  if (cellCount <= 0 || reachablePortals.length === 0) return [];
  if (reachablePortals.length === 1) {
    return Array.from({ length: cellCount }, () => reachablePortals[0]!);
  }
  const assigned: EntryPortal[] = [reachablePortals[0]!];
  const used = new Set<string>([reachablePortals[0]!.id]);
  for (let c = 1; c < cellCount; c++) {
    const candidates = reachablePortals.filter((p) => !used.has(p.id));
    if (candidates.length === 0) {
      assigned.push(reachablePortals[c % reachablePortals.length]!);
      continue;
    }
    let best = candidates[0]!;
    let bestMinDist = -1;
    for (const cand of candidates) {
      let minDist = Infinity;
      for (const a of assigned) {
        const d = Math.hypot(cand.outside.x - a.outside.x, cand.outside.z - a.outside.z);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        best = cand;
      }
    }
    assigned.push(best);
    used.add(best.id);
  }
  return assigned;
}

/** EntryPortal と Door ジオメトリから layoutStackSlots() 用の StackSlotPortal を組み立てる（into は屋外→屋内）。 */
export function buildStackSlotPortal(
  portal: EntryPortal,
  door: { centerX: number; centerZ: number; axisX: number; axisZ: number; width: number },
): StackSlotPortal {
  const dx = portal.inside.x - portal.outside.x;
  const dz = portal.inside.z - portal.outside.z;
  const len = Math.hypot(dx, dz) || 1;
  return {
    centerX: door.centerX,
    centerZ: door.centerZ,
    intoX: dx / len,
    intoZ: dz / len,
    axisX: door.axisX,
    axisZ: door.axisZ,
    width: door.width,
  };
}

// ---------- 役割分担による挟撃・ピンサー機動（F7） ----------

export interface PinningCellInfo {
  cellIndex: number;
  aliveCount: number;
  hasShield: boolean;
  engaged: boolean;
  center: Vec3;
}

export interface FlankDoorSample {
  id: string;
  centerX: number;
  centerZ: number;
  normalX: number;
  normalZ: number;
  sillY: number;
  locked: boolean;
}

export interface PincerFlankParams {
  playerPos: Vec3;
  frontalPos: Vec3;
  flankerPos: Vec3;
  rooms: readonly RoomDef[];
  doors: readonly FlankDoorSample[];
  stairs: readonly StairMark[];
  colliders: readonly Collider[];
  excludeDoorIds?: ReadonlySet<string>;
}

export interface PincerFlankGoal {
  target: Vec3;
  kind: 'altDoor' | 'oppositeRoom' | 'altFloorStair' | 'lateral';
  doorId?: string;
  roomId?: string;
}

/** 正面で釘付け役（ピンニング班）を担うセルを選ぶ。近距離または交戦中の盾持ちセルを最優先し、次点で接敵セル。 */
export function selectPinningCell(
  cells: readonly PinningCellInfo[],
  contactCellIndex: number,
  targetPos: Vec3,
): number {
  const alive = cells.filter((c) => c.aliveCount > 0);
  if (alive.length === 0) return contactCellIndex;
  const shieldCell = alive.find(
    (c) =>
      c.hasShield &&
      (c.engaged ||
        (Math.abs(c.center.y - targetPos.y) < 1.1 &&
          Math.hypot(c.center.x - targetPos.x, c.center.z - targetPos.z) <= 12)),
  );
  if (shieldCell) return shieldCell.cellIndex;
  if (alive.some((c) => c.cellIndex === contactCellIndex)) return contactCellIndex;
  let nearest = alive[0]!;
  let nearestDist = Infinity;
  for (const c of alive) {
    const d = Math.hypot(c.center.x - targetPos.x, c.center.z - targetPos.z) + Math.abs(c.center.y - targetPos.y) * 3;
    if (d < nearestDist) {
      nearestDist = d;
      nearest = c;
    }
  }
  return nearest.cellIndex;
}

function pointInRoom(room: RoomDef, x: number, z: number): boolean {
  return Math.abs(x - room.x) <= room.width / 2 && Math.abs(z - room.z) <= room.depth / 2;
}

/** 指定した部屋（同フロア）に接している全ドアを返す。 */
export function findRoomDoors(room: RoomDef, doors: readonly FlankDoorSample[]): FlankDoorSample[] {
  const fy = room.floorY ?? 0;
  const out: FlankDoorSample[] = [];
  for (const d of doors) {
    if (Math.abs(d.sillY - fy) >= 0.75) continue;
    const ax = d.centerX + d.normalX * 0.85;
    const az = d.centerZ + d.normalZ * 0.85;
    const bx = d.centerX - d.normalX * 0.85;
    const bz = d.centerZ - d.normalZ * 0.85;
    if (pointInRoom(room, ax, az) || pointInRoom(room, bx, bz)) out.push(d);
  }
  return out;
}

/**
 * 挟撃（ピンサー機動）の迂回目標を優先順に算出する:
 * 1. 目標の部屋へ通じる「正面班から最も遠い別ドア」
 * 2. 正面班と反対側の隣接室内部屋（行き止まり部屋対策）
 * 3. 別フロア階段アプローチ（正面班から最も遠い階段）
 * 4. 屋外・単室マップ用の側面/背面フォールバック
 */
export function planPincerFlankGoal(params: PincerFlankParams): PincerFlankGoal | null {
  const { playerPos, frontalPos, flankerPos, rooms, doors, stairs, colliders, excludeDoorIds } = params;
  const indoorRooms = rooms.filter((r) => !r.outdoor);
  const playerRoom =
    indoorRooms.find((r) => Math.abs((r.floorY ?? 0) - playerPos.y) < 0.75 && pointInRoom(r, playerPos.x, playerPos.z)) ?? null;

  const fdx = frontalPos.x - playerPos.x;
  const fdz = frontalPos.z - playerPos.z;
  const fLen = Math.hypot(fdx, fdz) || 1;
  const fDirX = fdx / fLen;
  const fDirZ = fdz / fLen;
  const flankerIndoor = isIndoorPoint(indoorRooms, flankerPos.x, flankerPos.z, flankerPos.y);

  // Priority 1: Alternate door into playerRoom
  if (playerRoom) {
    const roomDoors = findRoomDoors(playerRoom, doors);
    if (roomDoors.length >= 2) {
      let closestFrontalId = roomDoors[0]!.id;
      let closestFrontalDist = Infinity;
      for (const d of roomDoors) {
        const df = Math.hypot(d.centerX - frontalPos.x, d.centerZ - frontalPos.z);
        if (df < closestFrontalDist) {
          closestFrontalDist = df;
          closestFrontalId = d.id;
        }
      }
      let bestDoor: FlankDoorSample | null = null;
      let bestScore = -Infinity;
      for (const d of roomDoors) {
        if (d.id === closestFrontalId) continue;
        if (excludeDoorIds?.has(d.id)) continue;
        const df = Math.hypot(d.centerX - frontalPos.x, d.centerZ - frontalPos.z);
        const ddx = d.centerX - playerPos.x;
        const ddz = d.centerZ - playerPos.z;
        const dLen = Math.hypot(ddx, ddz) || 1;
        const dot = (ddx * fDirX + ddz * fDirZ) / dLen;
        // 反対側が屋内なら屋内迂回ルートとして加点
        const ax = d.centerX + d.normalX * 0.85;
        const az = d.centerZ + d.normalZ * 0.85;
        const bx = d.centerX - d.normalX * 0.85;
        const bz = d.centerZ - d.normalZ * 0.85;
        const aIn = pointInRoom(playerRoom, ax, az);
        const outX = aIn ? bx : ax;
        const outZ = aIn ? bz : az;
        const oppIndoor = isIndoorPoint(indoorRooms, outX, outZ, d.sillY);
        const score = df + (1 - dot) * 4 + (flankerIndoor && oppIndoor ? 3 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestDoor = d;
        }
      }
      if (bestDoor) {
        const ax = bestDoor.centerX + bestDoor.normalX * 0.75;
        const az = bestDoor.centerZ + bestDoor.normalZ * 0.75;
        const bx = bestDoor.centerX - bestDoor.normalX * 0.75;
        const bz = bestDoor.centerZ - bestDoor.normalZ * 0.75;
        const aIn = pointInRoom(playerRoom, ax, az);
        const approachX = aIn ? bx : ax;
        const approachZ = aIn ? bz : az;
        const insideX = aIn ? bestDoor.centerX + bestDoor.normalX * 0.5 : bestDoor.centerX - bestDoor.normalX * 0.5;
        const insideZ = aIn ? bestDoor.centerZ + bestDoor.normalZ * 0.5 : bestDoor.centerZ - bestDoor.normalZ * 0.5;
        const useApproach = !blockedAtFiltered(colliders, approachX, approachZ, 0.3, bestDoor.sillY);
        return {
          target: { x: useApproach ? approachX : insideX, y: bestDoor.sillY, z: useApproach ? approachZ : insideZ },
          kind: 'altDoor',
          doorId: bestDoor.id,
        };
      }
    }
  }

  // Priority 2: Opposite adjacent indoor room on the same floor
  let bestRoom: RoomDef | null = null;
  let bestRoomScore = -Infinity;
  for (const r of indoorRooms) {
    if (playerRoom && r.id === playerRoom.id) continue;
    const fy = r.floorY ?? 0;
    if (Math.abs(fy - playerPos.y) >= 0.75) continue;
    const distP = Math.hypot(r.x - playerPos.x, r.z - playerPos.z);
    if (distP < 2.5 || distP > 16) continue;
    const rdx = r.x - playerPos.x;
    const rdz = r.z - playerPos.z;
    const dot = (rdx * fDirX + rdz * fDirZ) / distP;
    const distF = Math.hypot(r.x - frontalPos.x, r.z - frontalPos.z);
    const score = distF + (dot < 0.3 ? (1 - dot) * 5 : -4) - distP * 0.25;
    if (score > bestRoomScore) {
      bestRoomScore = score;
      bestRoom = r;
    }
  }
  if (bestRoom) {
    return {
      target: { x: bestRoom.x, y: bestRoom.floorY ?? 0, z: bestRoom.z },
      kind: 'oppositeRoom',
      roomId: bestRoom.id,
    };
  }

  // Priority 3: Alternate floor stair approach
  if (stairs.length > 0) {
    let bestStairTarget: Vec3 | null = null;
    let bestStairDist = -1;
    for (const st of stairs) {
      const touchesLow = Math.abs(st.baseY - playerPos.y) < 0.75;
      const touchesHigh = Math.abs(st.topY - playerPos.y) < 0.75;
      if (!touchesLow && !touchesHigh) continue;
      const pt = touchesLow ? st.approachLow : st.approachHigh;
      const y = touchesLow ? st.baseY : st.topY;
      const df = Math.hypot(pt.x - frontalPos.x, pt.z - frontalPos.z);
      if (df > bestStairDist) {
        bestStairDist = df;
        bestStairTarget = { x: pt.x, y, z: pt.z };
      }
    }
    if (bestStairTarget) {
      return { target: bestStairTarget, kind: 'altFloorStair' };
    }
  }

  // Priority 4: Lateral / rear fallback (outdoor or single-room map)
  const baseAngle = Math.atan2(fDirZ, fDirX);
  for (const deg of [90, -90, 135, -135, 180]) {
    const ang = baseAngle + deg * DEG2RAD;
    const tx = playerPos.x + Math.cos(ang) * 4.5;
    const tz = playerPos.z + Math.sin(ang) * 4.5;
    if (!blockedAtFiltered(colliders, tx, tz, 0.32, playerPos.y)) {
      return { target: { x: tx, y: playerPos.y, z: tz }, kind: 'lateral' };
    }
  }
  return null;
}

// ---------- C2 爆破ブリーチ（F8） ----------

export const C2_PRESSURE_THRESHOLD = 0.4;
export const C2_MIN_LOCKED_DOORS = 2;
export const C2_BLAST_RADIUS = SWAT_C2_BLAST_RADIUS;

/** 圧力が閾値以上、または 2 枚目以降の施錠ドアなら C2 爆破ブリーチを使用する。 */
export function shouldUseC2Breach(pressure: number, lockedDoorsEncountered: number): boolean {
  return pressure >= C2_PRESSURE_THRESHOLD || lockedDoorsEncountered >= C2_MIN_LOCKED_DOORS;
}

/** C2 起爆時の安全な退避位置をドア法線のブリーチャー側（side）へ探索する。 */
export function computeC2Standoff(
  door: EntrySample,
  side: number,
  colliders: readonly Collider[],
  fallback: Vec3,
): Vec3 {
  const latX = -door.normalZ;
  const latZ = door.normalX;
  for (const back of [2.6, 2.2, 1.8, 1.4]) {
    for (const lat of [0, 0.55, -0.55]) {
      const x = door.centerX + door.normalX * side * back + latX * lat;
      const z = door.centerZ + door.normalZ * side * back + latZ * lat;
      if (!blockedAtFiltered(colliders, x, z, 0.32, door.sillY)) {
        return { x, y: door.sillY, z };
      }
    }
  }
  return { ...fallback };
}

export interface C2BlastResult {
  inCone: boolean;
  dist: number;
  falloff: number;
  damage: number;
  stunScale: number;
}

/** C2 の指向性爆風コーン判定（ドアの反対側のみ致傷・スタン）。 */
export function evaluateC2BlastCone(
  blastOrigin: Vec3,
  blastDir: Vec3,
  targetPos: Vec3,
  radius = C2_BLAST_RADIUS,
  coneCos = Math.cos(SWAT_C2_BLAST_HALF_ANGLE_DEG * DEG2RAD),
  maxDamage = SWAT_C2_MAX_DAMAGE,
): C2BlastResult {
  const dx = targetPos.x - blastOrigin.x;
  const dy = targetPos.y - blastOrigin.y;
  const dz = targetPos.z - blastOrigin.z;
  const dist = Math.hypot(dx, dy, dz);
  if (radius <= 0 || dist > radius || Math.abs(dy) > 2.2) {
    return { inCone: false, dist, falloff: 0, damage: 0, stunScale: 0 };
  }
  const horiz = Math.hypot(dx, dz);
  const dot = horiz > 0.25 ? (dx * blastDir.x + dz * blastDir.z) / horiz : 1;
  if (dot < coneCos) {
    return { inCone: false, dist, falloff: 0, damage: 0, stunScale: 0 };
  }
  const falloff = Math.max(0, Math.min(1, 1 - (dist / radius) * 0.72));
  const damage = Math.round(maxDamage * falloff);
  const stunScale = Math.max(0.25, falloff);
  return { inCone: true, dist, falloff, damage, stunScale };
}
