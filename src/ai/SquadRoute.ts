import { hasFloorSupport, legacyZeroFallbackOf, STEP_HEIGHT, type StairMark } from '../world/Walk';
import type { Collider } from '../world/WorldBuilder';
import type { XZ } from './EngageBehavior';
import { collidersNear } from '../world/ColliderIndex';

const GRID = 0.2;
const MAX_EXPANSIONS = 70000;
/** string-pulling で 1 アンカーから視線検査する最大先読み点数（格子 0.2m 換算で約 12m） */
const SMOOTH_LOOKAHEAD = 60;
/** 狭隘部（ドア枠・狭い廊下）で格子位相が壁を跨いで全閉塞しないための微小マージン（m） */
const NARROW_PASSAGE_MARGIN = 0.04;
/** squadRoute の部分経路末尾と階段進入点の許容距離（これ以内かつ直線通行可なら到達可能） */
export const SQUAD_GOAL_TOLERANCE = 0.75;
/** 階段の接続床高と現在の足元高を同じ階とみなす差の上限（m） */
export const STAIR_FLOOR_MATCH = 0.55;
/** 階段退出点の既定許容半径（m）・高さ差（m） */
const DEFAULT_STAIR_EXIT_RADIUS = 0.48;
const STAIR_EXIT_Y = 0.16;
/** 進捗判定の退出: 全長からの余裕（m）・退出側床高の許容差（m）・中心線からの横ずれ上限（m） */
const STAIR_EXIT_PROGRESS_EPS = 0.05;
const STAIR_EXIT_Y_PROGRESS = 0.2;
const STAIR_EXIT_LATERAL = 1.0;
/** 目的地が階段の途中にあるとみなす条件: 中心線からの水平距離（m）・上下端からの高さ余裕（m） */
const STAIR_DEST_LATERAL = 0.9;
const STAIR_DEST_Y_MARGIN = 0.2;
/** 途中到達: 進捗差（m）と足元高との差（m） */
const STAIR_DEST_ARRIVE_ALONG = 0.3;
const STAIR_DEST_ARRIVE_Y = 0.5;
/** 段の上にいるとみなす中心線からの横距離（m）。階段幅の半分（約 0.93m）＋体の半径（0.3m）: 段の縁に足が掛かっている位置も含める */
const STAIR_ON_FLIGHT_LATERAL = 1.25;
/**
 * 段の上での昇降再開を見送る、向かう側の床高との差（m）。呼び出し側（Squad / Suspect の移動）が
 * 「同じ階」とみなす高さ差（0.75m）と揃える: その範囲なら床の通常経路で降り切れる（昇り切れる）。
 * ここで昇降を再開すると、端の数段を横切る経路を踏むたびに階段の奥へ押し戻され、昇降口で往復し続ける。
 */
const STAIR_RESUME_END_EPS = 0.75;
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
  for (const c of collidersNear(colliders, x - r, z - r, x + r, z + r)) {
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
  if (!legacyZeroFallbackOf(colliders) && !hasFloorSupport(colliders, x, z, feetY, r, false)) {
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

/** f 値の最小ヒープ（id と f を並列配列で保持し、要素ごとのオブジェクト確保を避ける） */
class MinHeap {
  private ids: number[] = [];
  private fs: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  clear(): void {
    this.ids.length = 0;
    this.fs.length = 0;
  }

  push(id: number, f: number): void {
    const ids = this.ids;
    const fs = this.fs;
    let i = ids.length;
    ids.push(id);
    fs.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pf = fs[p]!;
      if (pf <= f) break;
      ids[i] = ids[p]!;
      fs[i] = pf;
      i = p;
    }
    ids[i] = id;
    fs[i] = f;
  }

  /** 最小要素の id を取り出す（空でないことは呼び出し側で保証） */
  pop(): number {
    const ids = this.ids;
    const fs = this.fs;
    const top = ids[0]!;
    const lastId = ids.pop()!;
    const lastF = fs.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        let c = l;
        if (r < n && fs[r]! < fs[l]!) c = r;
        if (fs[c]! >= lastF) break;
        ids[i] = ids[c]!;
        fs[i] = fs[c]!;
        i = c;
      }
      ids[i] = lastId;
      fs[i] = lastF;
    }
    return top;
  }
}

const DIR_X = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const DIR_Z = [0, 0, 1, -1, 1, -1, 1, -1] as const;
const DIR_COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2] as const;

/** squadRoute の作業バッファ（呼び出しをまたいで再利用。各配列は世代番号 gen と一致する要素だけ有効） */
const pool = {
  size: 0,
  gen: 0,
  parent: new Int32Array(0),
  gScore: new Float32Array(0),
  seen: new Uint32Array(0),
  closed: new Uint32Array(0),
  blockGen: new Uint32Array(0),
  blockVal: new Int8Array(0),
};
const searchHeap = new MinHeap();

function beginSearch(total: number): number {
  if (total > pool.size) {
    pool.size = total;
    pool.parent = new Int32Array(total);
    pool.gScore = new Float32Array(total);
    pool.seen = new Uint32Array(total);
    pool.closed = new Uint32Array(total);
    pool.blockGen = new Uint32Array(total);
    pool.blockVal = new Int8Array(total);
    pool.gen = 0;
  }
  pool.gen++;
  if (pool.gen >= 0xffffffff) {
    pool.seen.fill(0);
    pool.closed.fill(0);
    pool.blockGen.fill(0);
    pool.gen = 1;
  }
  return pool.gen;
}

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

  // 作業バッファはモジュール共有（世代番号で無効化）し、呼び出しごとの巨大配列確保・fill を避ける
  const gen = beginSearch(total);
  const { parent, gScore, seen, closed, blockGen, blockVal } = pool;
  const gOf = (id: number): number => (seen[id] === gen ? gScore[id]! : Infinity);
  const visit = (id: number, g: number, from: number): void => {
    seen[id] = gen;
    gScore[id] = g;
    parent[id] = from;
  };
  const isClosed = (id: number): boolean => closed[id] === gen;

  const point = (gx: number, gz: number): XZ => ({ x: ox + gx * GRID, z: oz + gz * GRID });
  const isBlocked = (gx: number, gz: number): boolean => {
    if (gx < 0 || gx >= cols || gz < 0 || gz >= rows) return true;
    const id = gz * cols + gx;
    if (blockGen[id] === gen) return blockVal[id]! < 0;
    const px = ox + gx * GRID;
    const pz = oz + gz * GRID;
    const bad =
      Math.abs(px) > halfW ||
      Math.abs(pz) > halfD ||
      blockedAtFiltered(colliders, px, pz, gridRadius, feet, passableDoors);
    blockGen[id] = gen;
    blockVal[id] = bad ? -1 : 1;
    return bad;
  };

  visit(origin, 0, origin);
  const heap = searchHeap;
  heap.clear();
  const startBlocked = isBlocked(startGx, startGz);
  if (!startBlocked) {
    const h0 = Math.hypot(start.x - goal.x, start.z - goal.z) / GRID;
    heap.push(origin, h0);
  } else {
    // 開始点が壁際・ドア枠等でブロックされている場合、近傍の自由格子からシードする
    closed[origin] = gen;
    for (let ring = 1; ring <= 4 && heap.size === 0; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const gx = startGx + dx;
          const gz = startGz + dz;
          if (isBlocked(gx, gz)) continue;
          const id = gz * cols + gx;
          const cost = Math.hypot(dx, dz);
          visit(id, cost, origin);
          const h = Math.hypot(ox + gx * GRID - goal.x, oz + gz * GRID - goal.z) / GRID;
          heap.push(id, cost + h);
        }
      }
    }
    if (heap.size === 0) {
      closed[origin] = 0;
      const h0 = Math.hypot(start.x - goal.x, start.z - goal.z) / GRID;
      heap.push(origin, h0);
    }
  }

  let best = origin;
  let bestDist = startBlocked ? Infinity : Math.hypot(start.x - goal.x, start.z - goal.z);
  let expanded = 0;

  while (heap.size > 0 && expanded < MAX_EXPANSIONS) {
    const cur = heap.pop();
    if (isClosed(cur)) continue;
    closed[cur] = gen;
    expanded++;

    const cx = cur % cols;
    const cz = (cur - cx) / cols;
    const cpx = ox + cx * GRID;
    const cpz = oz + cz * GRID;
    const dGoal = Math.hypot(cpx - goal.x, cpz - goal.z);
    if (dGoal < bestDist) {
      bestDist = dGoal;
      best = cur;
    }
    if (dGoal <= GRID * 0.8) {
      best = cur;
      break;
    }

    const gCur = gScore[cur]!;
    for (let k = 0; k < 8; k++) {
      const dx = DIR_X[k]!;
      const dz = DIR_Z[k]!;
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
      const nid = nz * cols + nx;
      if (isClosed(nid)) continue;
      if (isBlocked(nx, nz)) continue;
      if (dx !== 0 && dz !== 0) {
        if (isBlocked(cx + dx, cz) || isBlocked(cx, cz + dz)) continue;
      }
      const ng = gCur + DIR_COST[k]!;
      if (ng < gOf(nid)) {
        visit(nid, ng, cur);
        const h = Math.hypot(ox + nx * GRID - goal.x, oz + nz * GRID - goal.z) / GRID;
        heap.push(nid, ng + h);
      }
    }
  }

  const raw: XZ[] = [];
  for (let id = best; id !== origin && seen[id] === gen; id = parent[id]!) {
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
    // 先読みは SMOOTH_LOOKAHEAD 点までに制限（長大な経路で O(n^2) の線分検査になるのを防ぐ）
    for (let j = Math.min(raw.length - 1, idx + SMOOTH_LOOKAHEAD); j > idx; j--) {
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

/**
 * 階段を昇り切った（降り切った）か。次のどちらかで真。
 * (1) 退出点へ水平 exitRadius 以内かつ退出側の床高 ±STAIR_EXIT_Y（従来判定）。
 * (2) 進入点→退出点の線分上の進捗が全長 - STAIR_EXIT_PROGRESS_EPS 以上、足元高が退出側の床高 ±STAIR_EXIT_Y_PROGRESS 以内、
 *     かつ中心線からの横ずれが STAIR_EXIT_LATERAL 以内（ガード壁・ドアで退出点の小円から押し出されても到達とみなす）。
 * byProgress=false なら (1) のみ。
 */
export function stairExitReached(
  s: StairMark,
  up: boolean,
  px: number,
  pz: number,
  footY: number,
  exitRadius = DEFAULT_STAIR_EXIT_RADIUS,
  byProgress = true,
): boolean {
  const e = stairExit(s, up);
  const exitY = up ? s.topY : s.baseY;
  if (Math.hypot(px - e.x, pz - e.z) <= exitRadius && Math.abs(footY - exitY) <= STAIR_EXIT_Y) return true;
  if (!byProgress || Math.abs(footY - exitY) > STAIR_EXIT_Y_PROGRESS) return false;
  const a = stairEntry(s, up);
  const vx = e.x - a.x;
  const vz = e.z - a.z;
  const len = Math.hypot(vx, vz);
  if (len < 1e-6) return false;
  const along = ((px - a.x) * vx + (pz - a.z) * vz) / len;
  return along >= len - STAIR_EXIT_PROGRESS_EPS && distToSegment(px, pz, a, e) <= STAIR_EXIT_LATERAL;
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

/** 目的地が載っている階段（途中の高さ）と、その中心線上の投影。 */
export interface StairDestHit {
  stair: StairMark;
  /** approachLow を起点にした dest の中心線上の進捗（m） */
  along: number;
  /** approachLow→approachHigh の長さ（m） */
  len: number;
}

/**
 * dest が階段の途中にあるか。中心線への水平距離が STAIR_DEST_LATERAL 以内で、
 * dest.y が (baseY + 余裕, topY - 余裕) の範囲に入る階段を返す（誰の目的地かは問わない）。
 */
export function findDestStair(stairs: readonly StairMark[], dest: { x: number; z: number; y: number }): StairDestHit | null {
  let best: StairDestHit | null = null;
  let bestDist = Infinity;
  for (const s of stairs) {
    if (!(dest.y > s.baseY + STAIR_DEST_Y_MARGIN && dest.y < s.topY - STAIR_DEST_Y_MARGIN)) continue;
    const d = distToSegment(dest.x, dest.z, s.approachLow, s.approachHigh);
    if (d > STAIR_DEST_LATERAL || d >= bestDist) continue;
    const vx = s.approachHigh.x - s.approachLow.x;
    const vz = s.approachHigh.z - s.approachLow.z;
    const len = Math.hypot(vx, vz);
    if (len < 1e-6) continue;
    const along = ((dest.x - s.approachLow.x) * vx + (dest.z - s.approachLow.z) * vz) / len;
    best = { stair: s, along: Math.min(len, Math.max(0, along)), len };
    bestDist = d;
  }
  return best;
}

export type StairRunKind =
  /** 階段に関与しない（通常の経路探索へ） */
  | 'none'
  /** 昇降を続ける（target へ向かう。stair/up を activeStair に設定する） */
  | 'run'
  /** 目的地が載る階段の進入側の床にいる（進入点へ歩き、着いたら activeStair を設定する） */
  | 'enter'
  /** 退出した（activeStair を解除） */
  | 'exit'
  /** 停滞で今の昇降をやめる（activeStair のみ解除。停滞カウンタは触らない） */
  | 'giveup'
  /** 階段途中の目的地に着いた（activeStair を解除して停止） */
  | 'arrived';

export interface StairRunPlan {
  kind: StairRunKind;
  stair?: StairMark;
  up?: boolean;
  target?: XZ;
}

export interface StairRunInput {
  stairs: readonly StairMark[];
  active: { id: string; up: boolean } | null;
  px: number;
  pz: number;
  footY: number;
  /** 現在の停滞秒数（呼び出し側が持つ。この関数は変更しない） */
  stalled: number;
  stallResetSec: number;
  exitRadius: number;
  /** 階段途中の目的地への到達許容（水平 m） */
  arriveTol: number;
  dest: { x: number; z: number; y: number };
}

const STAIR_PLAN_NONE: StairRunPlan = { kind: 'none' };

/**
 * 昇降まわりの判断を 1 か所にまとめた共通関数（Squad / Suspect 共用）。
 * 昇降中の継続・退出・停滞放棄に加え、目的地が階段の途中にある場合の「途中で止まる」到達判定と進入を扱う。
 * 停滞放棄では stalled を戻さない（呼び出し側の段階的な停滞復帰を妨げないため）。
 */
export function stairRunPlan(inp: StairRunInput): StairRunPlan {
  const { stairs, active, px, pz, footY, dest } = inp;
  const hit = findDestStair(stairs, dest);

  if (active) {
    const s = stairs.find((m) => m.id === active.id);
    if (!s) return { kind: 'exit' };
    // 目的地がこの階段の途中にあるときは、退出判定より到達判定を優先する（遠い床まで行き過ぎない）
    const midHere = hit && hit.stair.id === s.id ? hit : null;
    if (midHere) {
      const mid = midStairPlan(midHere, px, pz, footY, inp);
      if (mid) return mid;
    } else if (stairExitReached(s, active.up, px, pz, footY, inp.exitRadius)) {
      return { kind: 'exit' };
    }
    if (inp.stalled >= inp.stallResetSec) return { kind: 'giveup' };
    if (midHere) return midRunPlan(midHere, px, pz, footY, dest);
    return { kind: 'run', stair: s, up: active.up, target: stairRunTarget(s, active.up, px, pz) };
  }

  // 自分が段の上にいて、目的地が足元より上下にあるなら、chooseStair を通さず今の階段で昇降を再開する
  // （放棄後に pickBestStair の候補が床高で外れる／隣レーンの階段が選ばれるのを防ぐ）。足元と同高の途中目的地は下の mid 処理へ
  for (const m of stairs) {
    if (hit && hit.stair === m) continue;
    if (
      footY > m.baseY + 0.1 &&
      footY < m.topY - 0.1 &&
      distToSegment(px, pz, m.approachLow, m.approachHigh) <= STAIR_ON_FLIGHT_LATERAL &&
      Math.abs(dest.y - footY) > STAIR_DEST_Y_MARGIN &&
      Math.abs(footY - (dest.y > footY ? m.topY : m.baseY)) > STAIR_RESUME_END_EPS &&
      !(hit && Math.abs(dest.y - footY) <= STAIR_DEST_ARRIVE_Y)
    ) {
      const up = dest.y > footY;
      return { kind: 'run', stair: m, up, target: stairRunTarget(m, up, px, pz) };
    }
  }

  if (!hit) return STAIR_PLAN_NONE;
  const s = hit.stair;
  const arrived = midStairPlan(hit, px, pz, footY, inp);
  if (arrived) return arrived;
  const onFlight =
    footY > s.baseY + 0.1 &&
    footY < s.topY - 0.1 &&
    distToSegment(px, pz, s.approachLow, s.approachHigh) <= STAIR_ON_FLIGHT_LATERAL;
  if (onFlight) return midRunPlan(hit, px, pz, footY, dest);
  const dLow = Math.abs(footY - s.baseY);
  const dHigh = Math.abs(footY - s.topY);
  if (dLow > STAIR_FLOOR_MATCH && dHigh > STAIR_FLOOR_MATCH) return STAIR_PLAN_NONE;
  return { kind: 'enter', stair: s, up: dLow <= dHigh };
}

/** 階段途中の目的地に着いたか（進捗差 or 水平距離、かつ足元高が近い）。 */
function midStairPlan(hit: StairDestHit, px: number, pz: number, footY: number, inp: StairRunInput): StairRunPlan | null {
  const { dest } = inp;
  if (Math.abs(footY - dest.y) > STAIR_DEST_ARRIVE_Y) return null;
  const s = hit.stair;
  // 中心線から離れた位置（踊り場の横・隣の部屋）では到達とみなさない
  if (distToSegment(px, pz, s.approachLow, s.approachHigh) > STAIR_ON_FLIGHT_LATERAL) return null;
  const vx = s.approachHigh.x - s.approachLow.x;
  const vz = s.approachHigh.z - s.approachLow.z;
  const along = ((px - s.approachLow.x) * vx + (pz - s.approachLow.z) * vz) / hit.len;
  if (Math.abs(along - hit.along) <= STAIR_DEST_ARRIVE_ALONG || Math.hypot(dest.x - px, dest.z - pz) <= inp.arriveTol) {
    return { kind: 'arrived' };
  }
  return null;
}

/** 階段途中の目的地へ向かう昇降目標: 中心線上で目的地の進捗へ向かう（STAIR_LOOKAHEAD 先まで。行き過ぎない）。 */
function midRunPlan(hit: StairDestHit, px: number, pz: number, footY: number, dest: { y: number }): StairRunPlan {
  const s = hit.stair;
  const vx = s.approachHigh.x - s.approachLow.x;
  const vz = s.approachHigh.z - s.approachLow.z;
  const along = ((px - s.approachLow.x) * vx + (pz - s.approachLow.z) * vz) / hit.len;
  const diff = hit.along - along;
  const t = Math.min(hit.len, Math.max(0, along + Math.max(-STAIR_LOOKAHEAD, Math.min(STAIR_LOOKAHEAD, diff))));
  return {
    kind: 'run',
    stair: s,
    up: dest.y > footY,
    target: { x: s.approachLow.x + (vx / hit.len) * t, z: s.approachLow.z + (vz / hit.len) * t },
  };
}
