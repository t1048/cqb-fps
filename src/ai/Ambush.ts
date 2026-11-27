import type { AmbushParams, RoomDef, Vec3 } from '../core/types';
import type { NoiseKind } from '../core/events';
import { hasLineOfSight } from '../weapons/Flashbang';
import { collidersNear } from '../world/ColliderIndex';
import type { Collider } from '../world/WorldBuilder';
import { blockedAt } from './EngageBehavior';

/**
 * 待ち伏せ（ファタルファネル）用の純粋ヘルパ。
 * 容疑者が突入音を聞いたとき、室内の「入口が見渡せて、入口の外からは見えにくい」隅/遮蔽へ移動し、
 * 入口へ照準を置いて待つ。入ってきた者（プレイヤー/隊員）には極短の反応時間で初弾を撃つ。
 */

/** 待ち伏せのきっかけになる音（突入準備の物音）。銃声は調査/増援の既存挙動に任せる */
export const AMBUSH_TRIGGER_KINDS: readonly NoiseKind[] = ['door', 'breach', 'footstep', 'voice'];

/** 入口（ドア開口）の最小記述。Door からそのまま作れる */
export interface Doorway {
  id: string;
  x: number;
  z: number;
  /** 扉面の法線（XZ） */
  nx: number;
  nz: number;
  /** 扉に沿った単位ベクトル（XZ） */
  ax: number;
  az: number;
  sillY: number;
  width: number;
}

export interface AmbushSpot {
  x: number;
  z: number;
  /** 遮蔽の陰でしゃがんで待つか */
  crouch: boolean;
  /** 入口へ向ける照準点（床から 1.1m の開口中心） */
  aim: Vec3;
  doorwayId: string;
  score: number;
}

export interface RoomRect {
  x: number;
  z: number;
  width: number;
  depth: number;
  floorY: number;
}

export function roomRectOf(r: RoomDef): RoomRect {
  return { x: r.x, z: r.z, width: r.width, depth: r.depth, floorY: r.floorY ?? 0 };
}

export function pointInRoom(r: RoomRect, x: number, z: number, y: number, margin = 0): boolean {
  return (
    Math.abs(y - r.floorY) <= 0.75 &&
    Math.abs(x - r.x) <= r.width / 2 + margin &&
    Math.abs(z - r.z) <= r.depth / 2 + margin
  );
}

/** 部屋の縁にある（部屋の矩形から 0.9m 以内・外周付近の）入口だけを返す。 */
export function doorwaysOfRoom(doors: readonly Doorway[], room: RoomRect): Doorway[] {
  const out: Doorway[] = [];
  for (const d of doors) {
    if (Math.abs(d.sillY - room.floorY) > 0.75) continue;
    if (!pointInRoom(room, d.x, d.z, d.sillY, 0.9)) continue;
    // 縁判定: 矩形の内側へ 0.9m 以上入っている入口（部屋の中央付近）は除外
    const insideX = room.width / 2 - Math.abs(d.x - room.x);
    const insideZ = room.depth / 2 - Math.abs(d.z - room.z);
    if (Math.min(insideX, insideZ) > 0.9) continue;
    out.push(d);
  }
  return out;
}

/** 入口の法線のうち、部屋の内側を向いている符号付き方向（単位ベクトル）。 */
export function intoRoomDir(d: Doorway, room: RoomRect): { x: number; z: number } {
  const px = d.x + d.nx * 0.8;
  const pz = d.z + d.nz * 0.8;
  const mx = d.x - d.nx * 0.8;
  const mz = d.z - d.nz * 0.8;
  const inP = pointInRoom(room, px, pz, d.sillY, 0);
  const inM = pointInRoom(room, mx, mz, d.sillY, 0);
  if (inP && !inM) return { x: d.nx, z: d.nz };
  if (inM && !inP) return { x: -d.nx, z: -d.nz };
  // どちらも内側/外側（部屋の矩形が不正確）: 部屋中心に近い側
  const dp = Math.hypot(px - room.x, pz - room.z);
  const dm = Math.hypot(mx - room.x, mz - room.z);
  return dp <= dm ? { x: d.nx, z: d.nz } : { x: -d.nx, z: -d.nz };
}

/** 実際の待ち伏せ確率。攻撃性（0〜1）が高いほど選びやすい。 */
export function ambushProbability(params: AmbushParams, aggression: number): number {
  const k = 0.4 + 1.2 * Math.max(0, Math.min(1, aggression));
  return Math.max(0, Math.min(1, params.chance * k));
}

/** pre-aim 状態での反応時間（通常の反応時間より長くならない）。 */
export function ambushReactionSec(params: AmbushParams, baseReactionSec: number, preAimed: boolean): number {
  return preAimed ? Math.min(params.preAimReactionSec, baseReactionSec) : baseReactionSec;
}

/**
 * pre-aim 円錐の内側か。facing は待ち伏せ者の向き（単位 XZ）、from は待ち伏せ者の位置、target は入室者の位置。
 * coneDeg は全角。
 */
export function inPreAimCone(
  facing: { x: number; z: number },
  from: { x: number; z: number },
  target: { x: number; z: number },
  coneDeg: number,
): boolean {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) return true;
  const cos = (dx * facing.x + dz * facing.z) / d;
  return cos >= Math.cos((coneDeg / 2) * (Math.PI / 180));
}

const BODY_R = 0.3;
const STEP = 0.5;

export interface AmbushQuery {
  colliders: readonly Collider[];
  room: RoomRect;
  doorway: Doorway;
  /** 待ち伏せ者の現在位置（近い場所を好む） */
  from: { x: number; z: number };
  maxDist: number;
  /** 乱数（テスト用に差し替え可能）。同点の揺らぎにのみ使う */
  rand?: () => number;
}

/**
 * 室内から「入口が見渡せる」「入口の外から見えにくい」「壁際/遮蔽の隅」を優先して待ち伏せ位置を選ぶ。
 * 見つからなければ null。
 */
export function findAmbushSpot(q: AmbushQuery): AmbushSpot | null {
  const { colliders, room, doorway: d } = q;
  const rand = q.rand ?? Math.random;
  const into = intoRoomDir(d, room);
  const floor = room.floorY;
  const doorPt: Vec3 = { x: d.x, y: d.sillY + 1.1, z: d.z };
  // 入口の外 2m（廊下側）から見えるか＝入口を通すと見つかる位置か
  const outside: Vec3 = { x: d.x - into.x * 2.2, y: d.sillY + 1.5, z: d.z - into.z * 2.2 };

  const near = collidersNear(colliders, room.x - room.width / 2 - 1, room.z - room.depth / 2 - 1, room.x + room.width / 2 + 1, room.z + room.depth / 2 + 1);
  const covers = near.filter((c) => c.kind === 'cover' && c.aabb.max.y > floor + 0.5 && c.aabb.max.y < floor + 1.35 && c.aabb.min.y < floor + 0.4);

  let best: AmbushSpot | null = null;
  const x0 = room.x - room.width / 2 + 0.5;
  const x1 = room.x + room.width / 2 - 0.5;
  const z0 = room.z - room.depth / 2 + 0.5;
  const z1 = room.z + room.depth / 2 - 0.5;
  for (let x = x0; x <= x1 + 1e-6; x += STEP) {
    for (let z = z0; z <= z1 + 1e-6; z += STEP) {
      const distDoor = Math.hypot(x - d.x, z - d.z);
      if (distDoor < 1.6 || distDoor > q.maxDist) continue;
      const distSelf = Math.hypot(x - q.from.x, z - q.from.z);
      if (distSelf > Math.max(7, q.maxDist * 0.6)) continue;
      if (blockedAt(colliders, x, z, BODY_R, floor)) continue;
      // 近くの低い遮蔽（入口との間にあるもの）を探してしゃがみ待機できるか
      let crouch = false;
      for (const c of covers) {
        const a = c.aabb;
        const cx = Math.max(a.min.x, Math.min(x, a.max.x));
        const cz = Math.max(a.min.z, Math.min(z, a.max.z));
        if (Math.hypot(cx - x, cz - z) > 0.75) continue;
        // 遮蔽が自分と入口の間にある（入口方向へ寄っている）
        const toDoorX = d.x - x;
        const toDoorZ = d.z - z;
        const toCoverX = cx - x;
        const toCoverZ = cz - z;
        if (toDoorX * toCoverX + toDoorZ * toCoverZ > 0) {
          crouch = true;
          break;
        }
      }
      const eyeY = floor + (crouch ? 0.95 : 1.45);
      const eye: Vec3 = { x, y: eyeY, z };
      if (!hasLineOfSight(colliders, eye, doorPt)) continue;
      const hiddenFromOutside = !hasLineOfSight(colliders, outside, { x, y: floor + (crouch ? 0.8 : 1.2), z });
      const lat = Math.abs((x - d.x) * d.ax + (z - d.z) * d.az);
      const depth = (x - d.x) * into.x + (z - d.z) * into.z;
      // 壁際（隅）に接しているほど良い
      let wall = 0;
      for (const [ox, oz] of [
        [0.55, 0],
        [-0.55, 0],
        [0, 0.55],
        [0, -0.55],
      ] as const) {
        if (blockedAt(colliders, x + ox, z + oz, 0.1, floor)) wall++;
      }
      let score = 0;
      if (hiddenFromOutside) score += 4;
      if (lat >= 0.9) score += 1.5;
      if (depth >= 1.2 && depth <= 5.5) score += 1;
      score += Math.min(2, wall) * 0.75;
      if (crouch) score += 1.5;
      score -= distSelf * 0.22;
      score -= Math.abs(distDoor - 3.5) * 0.12;
      score += rand() * 0.05;
      if (!best || score > best.score) {
        best = { x, z, crouch, aim: doorPt, doorwayId: d.id, score };
      }
    }
  }
  return best;
}
