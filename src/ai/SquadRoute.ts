import { legacyZeroFallbackOf, probeGround, STEP_HEIGHT, type StairMark } from '../world/Walk';
import type { Collider } from '../world/WorldBuilder';
import type { XZ } from './EngageBehavior';

const GRID = 0.2;
const MAX_EXPANSIONS = 70000;
/** 狭隘部（ドア枠・狭い廊下）で格子位相が壁を跨いで全閉塞しないための微小マージン（m） */
const NARROW_PASSAGE_MARGIN = 0.04;
/** squadRoute の部分経路末尾と階段進入点の許容距離（これ以内かつ直線通行可なら到達可能） */
export const SQUAD_GOAL_TOLERANCE = 0.75;
/** 階段の接続床高と現在の足元高を同じ階とみなす差の上限（m） */
export const STAIR_FLOOR_MATCH = 0.55;
/** 階段退出点の既定許容半径（m）・高さ差（m） */
const DEFAULT_STAIR_EXIT_RADIUS = 0.48;
const STAIR_EXIT_Y = 0.16;
/** 昇降中に中心線上で先読みする距離（m） */
const STAIR_LOOKAHEAD = 0.35;

type Bounds = { width: number; depth: number };

/**
 * passableDoors に含まれるコライダを除き、歩行高さ帯の壁・遮蔽物・施錠ドアと干渉するか判定する。
 * 非レガシーマップ（floors / B1 付き）では床支持面が無い点も通行不能とみなす。
 */
export function blockedAtFiltered(
  colliders: readonly Collider[],
  x: number,
  z: number,
  r: number,
  feetY: number,
  passableDoors?: ReadonlySet<Collider>,
): boolean {
  const r2 = r * r;
  for (const c of colliders) {
    if (passableDoors?.has(c)) continue;
    const a = c.aabb;
    if (a.max.y <= feetY + STEP_HEIGHT) continue;
    if (a.min.y >= feetY + 1.6) continue;
    const cx = Math.max(a.min.x, Math.min(x, a.max.x));
    const cz = Math.max(a.min.z, Math.min(z, a.max.z));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < r2) return true;
  }
  if (!legacyZeroFallbackOf(colliders) && probeGround(colliders, x, z, feetY, r, false) === null) {
    return true;
  }
  return false;
}

/** 線分 a -> b が半径 r の移動体にとって通行可能かサンプリング検証する。 */
export function pathSegmentClear(
  colliders: readonly Collider[],
  a: XZ,
  b: XZ,
  radius: number,
  feetY: number,
  passableDoors?: ReadonlySet<Collider>,
): boolean {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(d / 0.16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (blockedAtFiltered(colliders, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, radius, feetY, passableDoors)) {
      return false;
    }
  }
  return true;
}

interface HeapItem {
  id: number;
  f: number;
}

class MinHeap {
  private readonly data: HeapItem[] = [];

  get size(): number {
    return this.data.length;
  }

  push(item: HeapItem): void {
    const d = this.data;
    d.push(item);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p]!.f <= d[i]!.f) break;
      const tmp = d[p]!;
      d[p] = d[i]!;
      d[i] = tmp;
      i = p;
    }
  }

  pop(): HeapItem | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0]!;
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      const n = d.length;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let small = i;
        if (l < n && d[l]!.f < d[small]!.f) small = l;
        if (r < n && d[r]!.f < d[small]!.f) small = r;
        if (small === i) break;
        const tmp = d[i]!;
        d[i] = d[small]!;
        d[small] = tmp;
        i = small;
      }
    }
    return top;
  }
}

const DIRS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * 現在階での8近傍 A* 経路探索 + 視線スムージング（string-pulling）。
 * passableDoors を渡すと未施錠の閉じた扉を通行可能として経路を引き、道中で自動開放できる。
 */
export function squadRoute(
  start: XZ,
  goal: XZ,
  feet: number,
  colliders: readonly Collider[],
  bounds: Bounds,
  radius: number,
  passableDoors?: ReadonlySet<Collider>,
): XZ[] {
  if (Math.hypot(goal.x - start.x, goal.z - start.z) < 0.1) return [];
  if (
    !blockedAtFiltered(colliders, goal.x, goal.z, radius, feet, passableDoors) &&
    pathSegmentClear(colliders, start, goal, radius, feet, passableDoors)
  ) {
    return [{ x: goal.x, z: goal.z }];
  }

  const gridRadius = Math.max(0.18, radius - NARROW_PASSAGE_MARGIN);
  const cols = Math.ceil(bounds.width / GRID) + 3;
  const rows = Math.ceil(bounds.depth / GRID) + 3;
  const halfW = bounds.width / 2 - gridRadius;
  const halfD = bounds.depth / 2 - gridRadius;

  const sx = Math.floor((start.x + bounds.width / 2) / GRID);
  const sz = Math.floor((start.z + bounds.depth / 2) / GRID);
  const ox = start.x - sx * GRID;
  const oz = start.z - sz * GRID;

  const startGx = Math.max(0, Math.min(cols - 1, Math.round((start.x - ox) / GRID)));
  const startGz = Math.max(0, Math.min(rows - 1, Math.round((start.z - oz) / GRID)));
  const total = cols * rows;
  const origin = startGz * cols + startGx;

  const parent = new Int32Array(total).fill(-1);
  const gScore = new Float32Array(total).fill(Infinity);
  const closed = new Uint8Array(total);
  const blockedCache = new Int8Array(total); // 0=unknown, 1=free, -1=blocked

  const point = (gx: number, gz: number): XZ => ({ x: ox + gx * GRID, z: oz + gz * GRID });
  const isBlocked = (gx: number, gz: number): boolean => {
    if (gx < 0 || gx >= cols || gz < 0 || gz >= rows) return true;
    const id = gz * cols + gx;
    const cached = blockedCache[id]!;
    if (cached !== 0) return cached < 0;
    const p = point(gx, gz);
    const bad =
      Math.abs(p.x) > halfW ||
      Math.abs(p.z) > halfD ||
      blockedAtFiltered(colliders, p.x, p.z, gridRadius, feet, passableDoors);
    blockedCache[id] = bad ? -1 : 1;
    return bad;
  };

  parent[origin] = origin;
  gScore[origin] = 0;
  const heap = new MinHeap();
  const startBlocked = isBlocked(startGx, startGz);
  if (!startBlocked) {
    const h0 = Math.hypot(start.x - goal.x, start.z - goal.z) / GRID;
    heap.push({ id: origin, f: h0 });
  } else {
    // 開始点が壁際・ドア枠等でブロックされている場合、近傍の自由格子からシードする
    closed[origin] = 1;
    for (let ring = 1; ring <= 4 && heap.size === 0; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const gx = startGx + dx;
          const gz = startGz + dz;
          if (isBlocked(gx, gz)) continue;
          const id = gz * cols + gx;
          const cost = Math.hypot(dx, dz);
          gScore[id] = cost;
          parent[id] = origin;
          const p = point(gx, gz);
          const h = Math.hypot(p.x - goal.x, p.z - goal.z) / GRID;
          heap.push({ id, f: cost + h });
        }
      }
    }
    if (heap.size === 0) {
      closed[origin] = 0;
      const h0 = Math.hypot(start.x - goal.x, start.z - goal.z) / GRID;
      heap.push({ id: origin, f: h0 });
    }
  }

  let best = origin;
  let bestDist = startBlocked ? Infinity : Math.hypot(start.x - goal.x, start.z - goal.z);
  let expanded = 0;

  while (heap.size > 0 && expanded < MAX_EXPANSIONS) {
    const item = heap.pop()!;
    const cur = item.id;
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;

    const cx = cur % cols;
    const cz = Math.floor(cur / cols);
    const cp = point(cx, cz);
    const dGoal = Math.hypot(cp.x - goal.x, cp.z - goal.z);
    if (dGoal < bestDist) {
      bestDist = dGoal;
      best = cur;
    }
    if (dGoal <= GRID * 0.8) {
      best = cur;
      break;
    }

    const gCur = gScore[cur]!;
    for (const [dx, dz, cost] of DIRS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
      const nid = nz * cols + nx;
      if (closed[nid]) continue;
      if (isBlocked(nx, nz)) continue;
      if (dx !== 0 && dz !== 0) {
        if (isBlocked(cx + dx, cz) || isBlocked(cx, cz + dz)) continue;
      }
      const ng = gCur + cost;
      if (ng < gScore[nid]!) {
        gScore[nid] = ng;
        parent[nid] = cur;
        const np = point(nx, nz);
        const h = Math.hypot(np.x - goal.x, np.z - goal.z) / GRID;
        heap.push({ id: nid, f: ng + h });
      }
    }
  }

  const raw: XZ[] = [];
  for (let id = best; id !== origin && id >= 0; id = parent[id]!) {
    raw.push(point(id % cols, Math.floor(id / cols)));
  }
  raw.reverse();
  if (!blockedAtFiltered(colliders, goal.x, goal.z, radius, feet, passableDoors) && bestDist <= GRID * 1.4) {
    raw.push({ x: goal.x, z: goal.z });
  }
  if (raw.length <= 1) return raw;

  // String-pulling: 視線が通る最遠のウェイポイントへショートカット
  const smoothed: XZ[] = [];
  let anchor = start;
  let idx = 0;
  if (startBlocked) {
    const first = raw[0]!;
    smoothed.push(first);
    anchor = first;
    idx = 1;
  }
  while (idx < raw.length) {
    let far = idx;
    for (let j = raw.length - 1; j > idx; j--) {
      if (pathSegmentClear(colliders, anchor, raw[j]!, radius, feet, passableDoors)) {
        far = j;
        break;
      }
    }
    const chosen = raw[far]!;
    smoothed.push(chosen);
    anchor = chosen;
    idx = far + 1;
  }
  return smoothed;
}

// ---------- 共通階段ナビゲーション純粋関数群（Squad / Suspect 共用） ----------

/** 昇降方向の進入点（上りは下端手前、下りは上端奥）。 */
export function stairEntry(s: StairMark, up: boolean): XZ {
  return up ? s.approachLow : s.approachHigh;
}

/** 昇降方向の退出点（上りは上端奥、下りは下端手前）。 */
export function stairExit(s: StairMark, up: boolean): XZ {
  return up ? s.approachHigh : s.approachLow;
}

/** 昇降方向で階段に乗る側の床高（上りは下階、下りは上階）。 */
export function stairFloorY(s: StairMark, up: boolean): number {
  return up ? s.baseY : s.topY;
}

/** 退出点へ水平 exitRadius 以内かつ退出側の床高 ±STAIR_EXIT_Y に着いたか。 */
export function stairExitReached(
  s: StairMark,
  up: boolean,
  px: number,
  pz: number,
  footY: number,
  exitRadius = DEFAULT_STAIR_EXIT_RADIUS,
): boolean {
  const e = stairExit(s, up);
  return Math.hypot(px - e.x, pz - e.z) <= exitRadius && Math.abs(footY - (up ? s.topY : s.baseY)) <= STAIR_EXIT_Y;
}

export interface StairChoice {
  stair: StairMark;
  /** 進入点まで実際に歩いて届く（部分経路でない）か */
  reachable: boolean;
  /** 経路ポリラインの総長（到達不能時は直線距離） */
  length: number;
}

/**
 * from から to まで歩いて届くときの経路総長。届かなければ null。
 * squadRoute は到達不能でも最近傍点までの部分経路を返すため、末尾が to から SQUAD_GOAL_TOLERANCE 以内かつ
 * 末尾→to が直線で通れる場合だけ到達とみなす。
 */
export function reachableRouteLength(
  from: XZ,
  to: XZ,
  footY: number,
  colliders: readonly Collider[],
  bounds: Bounds,
  radius: number,
  passable?: ReadonlySet<Collider>,
): number | null {
  if (Math.hypot(to.x - from.x, to.z - from.z) < 0.1) {
    return blockedAtFiltered(colliders, to.x, to.z, radius, footY, passable) ? null : 0;
  }
  const route = squadRoute(from, to, footY, colliders, bounds, radius, passable);
  const last = route[route.length - 1];
  if (
    !last ||
    Math.hypot(last.x - to.x, last.z - to.z) > SQUAD_GOAL_TOLERANCE ||
    !pathSegmentClear(colliders, last, to, radius, footY, passable)
  ) {
    return null;
  }
  let total = 0;
  let px = from.x;
  let pz = from.z;
  for (const q of route) {
    total += Math.hypot(q.x - px, q.z - pz);
    px = q.x;
    pz = q.z;
  }
  return total + Math.hypot(to.x - px, to.z - pz);
}

/**
 * 現在階から使える階段（接続床高が現在階に一致）の中で、進入点まで歩いて届く最短のものを選ぶ（部分経路は除外）。
 * dest が退出側の階にあるときは、退出点から dest まで届く階段を優先し、その経路長も合算する
 * （2 コアで上階が分かれていても目的地へ通じるコアを選ぶ）。全候補が届かないときは進入点の直線距離最短を返す。
 * 現在階の候補が無ければ null。
 */
export function pickBestStair(
  stairs: readonly StairMark[],
  from: { x: number; z: number; footY: number },
  up: boolean,
  colliders: readonly Collider[],
  bounds: Bounds,
  radius: number,
  passable?: ReadonlySet<Collider>,
  dest?: { x: number; z: number; y: number },
): StairChoice | null {
  let best: StairChoice | null = null;
  let bestThrough = false;
  let nearest: StairChoice | null = null;
  for (const s of stairs) {
    if (Math.abs(stairFloorY(s, up) - from.footY) > STAIR_FLOOR_MATCH) continue;
    const entry = stairEntry(s, up);
    const straight = Math.hypot(entry.x - from.x, entry.z - from.z);
    if (!nearest || straight < nearest.length) nearest = { stair: s, reachable: false, length: straight };
    const toEntry = reachableRouteLength({ x: from.x, z: from.z }, entry, from.footY, colliders, bounds, radius, passable);
    if (toEntry === null) continue;
    let length = toEntry;
    let through = false;
    const exitY = up ? s.topY : s.baseY;
    if (dest && Math.abs(dest.y - exitY) <= STAIR_FLOOR_MATCH) {
      const fromExit = reachableRouteLength(stairExit(s, up), dest, exitY, colliders, bounds, radius, passable);
      if (fromExit !== null) {
        through = true;
        length += fromExit;
      }
    }
    if (!best || (through && !bestThrough) || (through === bestThrough && length < best.length)) {
      best = { stair: s, reachable: true, length };
      bestThrough = through;
    }
  }
  return best ?? nearest;
}

/** 昇降中の目標点: 段の中心線上で現在位置より STAIR_LOOKAHEAD 先（横ずれを中心線へ戻し、穴の縁・側壁に当たらない）。 */
export function stairRunTarget(s: StairMark, up: boolean, px: number, pz: number): XZ {
  const a = stairEntry(s, up);
  const b = stairExit(s, up);
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const len = Math.hypot(vx, vz);
  if (len < 1e-6) return b;
  const along = ((px - a.x) * vx + (pz - a.z) * vz) / len;
  const t = Math.min(len, Math.max(0, along) + STAIR_LOOKAHEAD);
  return { x: a.x + (vx / len) * t, z: a.z + (vz / len) * t };
}

/** 点 p と線分 a-b の水平距離。 */
export function distToSegment(px: number, pz: number, a: XZ, b: XZ): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - a.x) * vx + (pz - a.z) * vz) / l2)) : 0;
  return Math.hypot(px - (a.x + vx * t), pz - (a.z + vz * t));
}
