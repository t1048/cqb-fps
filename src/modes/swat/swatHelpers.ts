import type { Vec3 } from '../../core/types';
import { blockedAtFiltered } from '../../ai/SquadRoute';
import type { StackSlot } from '../../ai/stackSlots';
import { assignStackSlots, computeEntryOrder, type CqbPortal } from '../../ai/cqbEntry';
import { listExteriorEntries } from '../../ai/SwatTactics';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { Collider } from '../../world/WorldBuilder';
import type { BarricadeInfo } from '../Fortify';
import {
  BARRICADE_FACE_OFFSET,
  BARRICADE_MIN_DIST,
  BARRICADE_SHOOT_RANGE,
  STACK_CELL_SPLIT_PENALTY,
  STACK_SIDE_PREF_PENALTY,
  type SwatSpawn,
} from './swatTypes';

export { listExteriorEntries };

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * スタック枠割当（設計 §5-1）。各隊員のサイド（左=-1 / 右=+1。computeEntryOrder の side）を全列挙し、
 * サイド内の枠は assignStackSlots（二乗距離最小 + ドア開口横切り/経路交差ペナルティ）で決める。
 * 評価 = 二乗距離 + 同セルが左右に分かれる +2（セルごと）+ セルの希望サイド外れ（Red=左, Blue=右, … 1 人 +1）。
 * 返り値: positions[i] → slot index（-1 = 枠なし）。n > 10 や portal 無しは assignStackSlots のみ。
 */
export function assignSwatStackSlots(
  positions: readonly { x: number; z: number }[],
  cellKeys: readonly number[],
  slots: readonly StackSlot[],
  portal: CqbPortal | null,
): number[] {
  const n = positions.length;
  const fallback = (): number[] => assignStackSlots(positions, slots, portal ?? undefined);
  if (!portal || n === 0 || n > 10 || slots.length < n) return fallback();
  const ranks = computeEntryOrder(portal, slots);
  const sideSlots: Record<-1 | 1, number[]> = { [-1]: [], [1]: [] } as Record<-1 | 1, number[]>;
  ranks.forEach((r, j) => sideSlots[r.side].push(j));
  const cells: number[] = [];
  for (const k of cellKeys) if (!cells.includes(k)) cells.push(k);
  const want = (i: number): -1 | 1 => (cells.indexOf(cellKeys[i]!) % 2 === 0 ? -1 : 1);
  const exact = slots.length === n;
  let best: number[] | null = null;
  let bestCost = Infinity;
  for (let mask = 0; mask < 1 << n; mask++) {
    const bySide: Record<-1 | 1, number[]> = { [-1]: [], [1]: [] } as Record<-1 | 1, number[]>;
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const side: -1 | 1 = mask & (1 << i) ? 1 : -1;
      bySide[side].push(i);
      if (side !== want(i)) cost += STACK_SIDE_PREF_PENALTY;
    }
    const fits = (s: -1 | 1): boolean =>
      exact ? bySide[s].length === sideSlots[s].length : bySide[s].length <= sideSlots[s].length;
    if (!fits(-1) || !fits(1)) continue;
    for (const k of cells) {
      const sides = new Set<number>();
      for (let i = 0; i < n; i++) if (cellKeys[i] === k) sides.add(mask & (1 << i) ? 1 : -1);
      if (sides.size > 1) cost += STACK_CELL_SPLIT_PENALTY;
    }
    if (cost >= bestCost) continue;
    const out = new Array<number>(n).fill(-1);
    for (const side of [-1, 1] as const) {
      const mem = bySide[side];
      if (mem.length === 0) continue;
      const ss = sideSlots[side];
      const local = assignStackSlots(
        mem.map((i) => positions[i]!),
        ss.map((j) => slots[j]!),
        portal,
      );
      local.forEach((lj, li) => {
        const i = mem[li]!;
        const j = lj >= 0 ? ss[lj]! : -1;
        out[i] = j;
        if (j >= 0) cost += (positions[i]!.x - slots[j]!.x) ** 2 + (positions[i]!.z - slots[j]!.z) ** 2;
      });
    }
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = out;
    }
  }
  return best ?? fallback();
}

/**
 * 隊員数をツーマンセル／スリーマンセルに分ける。基本は 2 人組で、奇数なら 1 組だけ 3 人組。
 * 例: 3 → [3] / 4 → [2,2] / 5 → [2,3] / 6 → [2,2,2] / 7 → [2,2,3]
 */
export function cellSizes(n: number): number[] {
  if (n <= 0) return [];
  if (n <= 3) return [n];
  const sizes: number[] = [];
  let left = n;
  while (left > 0) {
    if (left === 3) {
      sizes.push(3);
      left = 0;
    } else {
      sizes.push(2);
      left -= 2;
    }
  }
  return sizes;
}

/** 同一室内での滞在秒数を更新する純粋ヘルパ（屋外または部屋移動で 0 リセット） */
export function updateRoomStay(
  prevRoomId: string | null,
  prevStaySec: number,
  curRoomId: string | null,
  dt: number,
): { roomId: string | null; staySec: number } {
  if (!curRoomId || curRoomId !== prevRoomId) {
    return { roomId: curRoomId, staySec: 0 };
  }
  return { roomId: curRoomId, staySec: prevStaySec + Math.max(0, dt) };
}

/** 撃ち合いが途切れてから籠り時間の計測を再開するまでの秒数 */
export const CAMP_FIREFIGHT_GRACE_SEC = 6;

/**
 * 籠り時間に加算する秒数。撃ち合い中（隊員がプレイヤーを視認している、またはプレイヤーが最近撃った）は
 * 「籠っている」のではなく「交戦している」ので計測を止める（0 を返す。部屋の滞在記録自体は保持）。
 */
export function campStayDt(dt: number, sinceFirefightSec: number): number {
  return sinceFirefightSec < CAMP_FIREFIGHT_GRACE_SEC ? 0 : dt;
}

/** 建物中心に対する入口の方角ラベル（日英）を返す */
export function describePortalDirection(portalPos: Vec3, center: Vec3): { ja: string; en: string } {
  const dx = portalPos.x - center.x;
  const dz = portalPos.z - center.z;
  if (Math.abs(dz) >= Math.abs(dx)) {
    return dz < 0 ? { ja: '北ドア', en: 'north door' } : { ja: '南ドア', en: 'south door' };
  }
  return dx > 0 ? { ja: '東ドア', en: 'east door' } : { ja: '西ドア', en: 'west door' };
}

/**
 * 射線を塞いでいる板張り窓バリケードを検出する。
 * バリケード自身のコライダで自己遮蔽しないよう、手前面（nearFace = center + normal * side * 0.18）への LOS で判定する。
 */
export function findObstructingBarricade(
  fromEye: Vec3,
  fromFootY: number,
  targetPos: Vec3,
  barricades: readonly BarricadeInfo[],
  colliders: readonly Collider[],
  maxDist = BARRICADE_SHOOT_RANGE,
): { barricade: BarricadeInfo; nearFace: Vec3 } | null {
  if (barricades.length === 0) return null;
  if (hasLineOfSight(colliders, fromEye, { x: targetPos.x, y: targetPos.y + 1.1, z: targetPos.z })) return null;

  const toTargetX = targetPos.x - fromEye.x;
  const toTargetZ = targetPos.z - fromEye.z;
  const targetDist = Math.hypot(toTargetX, toTargetZ);

  let best: BarricadeInfo | null = null;
  let bestFace: Vec3 | null = null;
  let bestScore = Infinity;

  for (const b of barricades) {
    if (!b.boarded || b.hp <= 0) continue;
    if (Math.abs(b.floorY - fromFootY) > 1.2 || Math.abs(b.floorY - targetPos.y) > 1.2) continue;

    const toWinX = b.center.x - fromEye.x;
    const toWinZ = b.center.z - fromEye.z;
    const distToWin = Math.hypot(toWinX, toWinZ);
    if (distToWin < BARRICADE_MIN_DIST || distToWin > maxDist) continue;

    const side = (fromEye.x - b.center.x) * b.normal.x + (fromEye.z - b.center.z) * b.normal.z >= 0 ? 1 : -1;
    const targetDot = (targetPos.x - b.center.x) * b.normal.x + (targetPos.z - b.center.z) * b.normal.z;
    if (targetDot * side >= 0.2) continue; // 同じ側なら射線を遮っていない

    const distWinToTarget = Math.hypot(targetPos.x - b.center.x, targetPos.z - b.center.z);
    const aligned =
      targetDist > 0.5 && (toWinX * toTargetX + toWinZ * toTargetZ) / (distToWin * targetDist) >= 0.45;
    if (distWinToTarget > 7.5 && !aligned) continue;

    const nearFace: Vec3 = {
      x: b.center.x + b.normal.x * side * BARRICADE_FACE_OFFSET,
      y: b.center.y,
      z: b.center.z + b.normal.z * side * BARRICADE_FACE_OFFSET,
    };
    if (!hasLineOfSight(colliders, fromEye, nearFace)) continue;

    const score = distToWin + distWinToTarget * 0.6;
    if (score < bestScore) {
      bestScore = score;
      best = b;
      bestFace = nearFace;
    }
  }
  return best && bestFace ? { barricade: best, nearFace: bestFace } : null;
}

/** スポーン座標列から必要人数分の非重複・非衝突スポーン位置を解決する */
export function resolveSwatSpawns(
  base: readonly SwatSpawn[],
  count: number,
  colliders: readonly Collider[],
): SwatSpawn[] {
  const out: SwatSpawn[] = base.slice(0, count).map((s) => ({ ...s }));
  const anchor = base[0] ?? { x: 0, y: 0, z: 0 };
  const offsets: [number, number][] = [
    [0.9, 0],
    [-0.9, 0],
    [0, 0.9],
    [0, -0.9],
    [0.9, 0.9],
    [-0.9, -0.9],
    [0.9, -0.9],
    [-0.9, 0.9],
    [1.8, 0],
    [-1.8, 0],
    [0, 1.8],
    [0, -1.8],
  ];
  for (const [ox, oz] of offsets) {
    if (out.length >= count) break;
    const x = anchor.x + ox;
    const z = anchor.z + oz;
    if (blockedAtFiltered(colliders, x, z, 0.32, anchor.y)) continue;
    if (out.some((s) => Math.hypot(s.x - x, s.z - z) < 0.7)) continue;
    out.push({ x, y: anchor.y, z });
  }
  while (out.length < count) out.push({ ...anchor, x: anchor.x + out.length * 0.2 });
  return out;
}
