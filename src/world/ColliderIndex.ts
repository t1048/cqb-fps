import type { Vec3 } from '../core/types';
import type { AABB, Collider } from './WorldBuilder';

/**
 * コライダ配列の XZ 一様グリッド空間索引。
 *
 * 経路探索（A* の格子判定・視線スムージング）や接地判定は 1 回あたり全コライダを総当たりしていたため、
 * 大型マップ（数千コライダ）では 1 回の経路探索で数億回の AABB 判定になり、SWAT/容疑者 AI の再探索のたびに
 * 数百 ms〜数秒のフリーズを起こしていた。近傍セルのコライダだけを返すことで判定コストを局所化する。
 *
 * - 静的コライダ（壁・床・遮蔽物・階段・天井）はセルに登録する。
 * - ドア板は開閉で AABB がその場で書き換わるため、可動範囲（Collider.sweep）で登録する。
 *   sweep を持たない動的コライダは索引に入れず常に候補へ含める。
 * - 配列の長さが変わったら（ドア追加・dispose 等）次回クエリで自動的に再構築する。
 *
 * 返す候補配列は内部で使い回すため、次のクエリ呼び出し前に使い切ること（入れ子で呼ばない）。
 */

const CELL = 2;
/** セル登録時の外側マージン（m）。境界ちょうどに接するコライダや DDA の角通過でも取りこぼさない */
const REG_EPS = 1e-3;
/** これ未満のコライダ数なら索引を作らず総当たりのほうが速い */
const MIN_INDEXED = 48;

interface Index {
  length: number;
  first: Collider | undefined;
  last: Collider | undefined;
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** セルごとの静的コライダ番号 */
  cells: Uint32Array[];
  dynamic: Collider[];
  stamp: Uint32Array;
  epoch: number;
  out: Collider[];
}

const indices = new WeakMap<readonly Collider[], Index>();
const EMPTY = new Uint32Array(0);

/** コライダ配列をインプレース変更した際に明示的に空間索引キャッシュを破棄する。 */
export function invalidateColliderIndex(colliders: readonly Collider[]): void {
  indices.delete(colliders);
}

/** 索引に登録する XZ 範囲。動的で可動範囲が不明なものは null（常に候補）。 */
function rectOf(c: Collider): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  if (c.sweep) return c.sweep;
  if (c.kind === 'door') return null;
  const a = c.aabb;
  return { minX: a.min.x, minZ: a.min.z, maxX: a.max.x, maxZ: a.max.z };
}

function build(colliders: readonly Collider[]): Index {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const dynamic: Collider[] = [];
  for (const c of colliders) {
    const r = rectOf(c);
    if (!r) {
      dynamic.push(c);
      continue;
    }
    if (r.minX < minX) minX = r.minX;
    if (r.minZ < minZ) minZ = r.minZ;
    if (r.maxX > maxX) maxX = r.maxX;
    if (r.maxZ > maxZ) maxZ = r.maxZ;
  }
  if (!Number.isFinite(minX)) {
    minX = minZ = 0;
    maxX = maxZ = 0;
  }
  const cols = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL) + 1);
  const lists: number[][] = new Array(cols * rows);
  for (let i = 0; i < colliders.length; i++) {
    const r = rectOf(colliders[i]!);
    if (!r) continue;
    const x0 = Math.max(0, Math.floor((r.minX - REG_EPS - minX) / CELL));
    const x1 = Math.min(cols - 1, Math.floor((r.maxX + REG_EPS - minX) / CELL));
    const z0 = Math.max(0, Math.floor((r.minZ - REG_EPS - minZ) / CELL));
    const z1 = Math.min(rows - 1, Math.floor((r.maxZ + REG_EPS - minZ) / CELL));
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const id = gz * cols + gx;
        (lists[id] ??= []).push(i);
      }
    }
  }
  const cells: Uint32Array[] = new Array(cols * rows);
  for (let i = 0; i < cells.length; i++) {
    const l = lists[i];
    cells[i] = l ? Uint32Array.from(l) : EMPTY;
  }
  return {
    length: colliders.length,
    first: colliders[0],
    last: colliders[colliders.length - 1],
    minX,
    minZ,
    cols,
    rows,
    cells,
    dynamic,
    stamp: new Uint32Array(colliders.length),
    epoch: 0,
    out: [],
  };
}

function indexOf(colliders: readonly Collider[]): Index {
  let idx = indices.get(colliders);
  if (
    !idx ||
    idx.length !== colliders.length ||
    idx.first !== colliders[0] ||
    idx.last !== colliders[colliders.length - 1]
  ) {
    idx = build(colliders);
    indices.set(colliders, idx);
  }
  return idx;
}

function nextEpoch(idx: Index): number {
  let epoch = ++idx.epoch;
  if (epoch >= 0xffffffff) {
    idx.stamp.fill(0);
    idx.epoch = epoch = 1;
  }
  return epoch;
}

/**
 * XZ 矩形 [minX,maxX]×[minZ,maxZ] と重なり得るコライダ候補（近傍セル＋可動範囲不明の動的コライダ）。
 * 少数配列ではそのまま colliders を返す。結果は内部バッファの使い回しなので保持しないこと。
 */
export function collidersNear(
  colliders: readonly Collider[],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): readonly Collider[] {
  if (colliders.length < MIN_INDEXED) return colliders;
  const idx = indexOf(colliders);
  const out = idx.out;
  out.length = 0;
  const x0 = Math.max(0, Math.floor((minX - idx.minX) / CELL));
  const x1 = Math.min(idx.cols - 1, Math.floor((maxX - idx.minX) / CELL));
  const z0 = Math.max(0, Math.floor((minZ - idx.minZ) / CELL));
  const z1 = Math.min(idx.rows - 1, Math.floor((maxZ - idx.minZ) / CELL));
  if (x0 <= x1 && z0 <= z1) {
    if (x0 === x1 && z0 === z1) {
      // 単一セル: 重複が起きないので stamp 不要
      const cell: Uint32Array = idx.cells[z0 * idx.cols + x0]!;
      for (let k = 0; k < cell.length; k++) out.push(colliders[cell[k]!]!);
    } else {
      const epoch = nextEpoch(idx);
      const stamp = idx.stamp;
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cell: Uint32Array = idx.cells[gz * idx.cols + gx]!;
          for (let k = 0; k < cell.length; k++) {
            const i = cell[k]!;
            if (stamp[i] === epoch) continue;
            stamp[i] = epoch;
            out.push(colliders[i]!);
          }
        }
      }
    }
  }
  for (const d of idx.dynamic) out.push(d);
  return out;
}

/**
 * 線分 a→b（XZ 投影）が通過するセルのコライダだけに test を適用し、どれかが true なら true（早期終了）。
 * 長い視線でも外接矩形全体ではなく通過セルのみを調べる（Amanatides–Woo の格子 DDA）。
 * 各コライダは高々 1 回だけ test される。test 内から索引クエリを呼ばないこと。
 */
export function someColliderAlongSegment(
  colliders: readonly Collider[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  test: (c: Collider) => boolean,
): boolean {
  if (colliders.length < MIN_INDEXED) {
    for (const c of colliders) if (test(c)) return true;
    return false;
  }
  const idx = indexOf(colliders);
  const epoch = nextEpoch(idx);
  const { stamp, cells, cols, rows } = idx;
  const visit = (gx: number, gz: number): boolean => {
    if (gx < 0 || gx >= cols || gz < 0 || gz >= rows) return false;
    const cell: Uint32Array = cells[gz * cols + gx]!;
    for (let k = 0; k < cell.length; k++) {
      const i = cell[k]!;
      if (stamp[i] === epoch) continue;
      stamp[i] = epoch;
      if (test(colliders[i]!)) return true;
    }
    return false;
  };
  const fx = (ax - idx.minX) / CELL;
  const fz = (az - idx.minZ) / CELL;
  const tx = (bx - idx.minX) / CELL;
  const tz = (bz - idx.minZ) / CELL;
  let gx = Math.floor(fx);
  let gz = Math.floor(fz);
  const ex = Math.floor(tx);
  const ez = Math.floor(tz);
  const dx = tx - fx;
  const dz = tz - fz;
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = sx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaZ = sz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = sx > 0 ? (gx + 1 - fx) / dx : sx < 0 ? (fx - gx) / -dx : Infinity;
  let tMaxZ = sz > 0 ? (gz + 1 - fz) / dz : sz < 0 ? (fz - gz) / -dz : Infinity;
  if (visit(gx, gz)) return true;
  let steps = Math.abs(ex - gx) + Math.abs(ez - gz);
  while (steps-- > 0) {
    if (tMaxX < tMaxZ) {
      gx += sx;
      tMaxX += tDeltaX;
    } else {
      gz += sz;
      tMaxZ += tDeltaZ;
    }
    if (visit(gx, gz)) return true;
  }
  // 浮動小数誤差で終点セルを外した場合の保険（stamp で重複は除外される）
  if (visit(ex, ez)) return true;
  for (const d of idx.dynamic) if (test(d)) return true;
  return false;
}

/**
 * 3D レイ（origin + t * dir, 0 <= t <= maxT）と AABB の最近交点距離 t を返す。
 * 交差しない場合は Infinity。始点が箱内部にある場合は 0 を返す。
 */
export function rayHitAABB(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  box: AABB,
): number {
  let t0 = 0;
  let t1 = maxT;

  if (Math.abs(dx) < 1e-9) {
    if (ox < box.min.x || ox > box.max.x) return Infinity;
  } else {
    const inv = 1 / dx;
    let ta = (box.min.x - ox) * inv;
    let tb = (box.max.x - ox) * inv;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }

  if (Math.abs(dy) < 1e-9) {
    if (oy < box.min.y || oy > box.max.y) return Infinity;
  } else {
    const inv = 1 / dy;
    let ta = (box.min.y - oy) * inv;
    let tb = (box.max.y - oy) * inv;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }

  if (Math.abs(dz) < 1e-9) {
    if (oz < box.min.z || oz > box.max.z) return Infinity;
  } else {
    const inv = 1 / dz;
    let ta = (box.min.z - oz) * inv;
    let tb = (box.max.z - oz) * inv;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }

  return t0;
}

/**
 * 空間索引（XZ グリッド DDA）を用いて、レイ origin + t * normalize(dir) が
 * colliders に最初に当たる距離 t（[0, maxDist]）を返す。非衝突時は maxDist。
 * 動的ドア（sweep または dynamic）や軸平行・垂直レイにも対応する。
 */
export function raycastColliders(
  colliders: readonly Collider[],
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  accept?: (c: Collider) => boolean,
): number {
  if (!Number.isFinite(maxDist) || maxDist <= 0) return 0;
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;
  if (
    !Number.isFinite(ox) ||
    !Number.isFinite(oy) ||
    !Number.isFinite(oz) ||
    !Number.isFinite(dir.x) ||
    !Number.isFinite(dir.y) ||
    !Number.isFinite(dir.z)
  ) {
    return maxDist;
  }
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-9) return maxDist;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;

  if (colliders.length < MIN_INDEXED) {
    let best = maxDist;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i]!;
      if (accept && !accept(c)) continue;
      const t = rayHitAABB(ox, oy, oz, dx, dy, dz, best, c.aabb);
      if (t < best) best = t;
    }
    return best;
  }

  const idx = indexOf(colliders);
  let best = maxDist;
  for (let i = 0; i < idx.dynamic.length; i++) {
    const c = idx.dynamic[i]!;
    if (accept && !accept(c)) continue;
    const t = rayHitAABB(ox, oy, oz, dx, dy, dz, best, c.aabb);
    if (t < best) best = t;
  }
  if (best <= 0) return 0;

  const epoch = nextEpoch(idx);
  const { stamp, cells, cols, rows } = idx;
  const visit = (cx: number, cz: number): void => {
    if (cx < 0 || cx >= cols || cz < 0 || cz >= rows) return;
    const cell: Uint32Array = cells[cz * cols + cx]!;
    for (let k = 0; k < cell.length; k++) {
      const i = cell[k]!;
      if (stamp[i] === epoch) continue;
      stamp[i] = epoch;
      const c = colliders[i]!;
      if (accept && !accept(c)) continue;
      const t = rayHitAABB(ox, oy, oz, dx, dy, dz, best, c.aabb);
      if (t < best) best = t;
    }
  };

  let gx = Math.floor((ox - idx.minX) / CELL);
  let gz = Math.floor((oz - idx.minZ) / CELL);
  const ex = Math.floor((ox + dx * best - idx.minX) / CELL);
  const ez = Math.floor((oz + dz * best - idx.minZ) / CELL);
  const sx = Math.abs(dx) >= 1e-9 ? (dx > 0 ? 1 : -1) : 0;
  const sz = Math.abs(dz) >= 1e-9 ? (dz > 0 ? 1 : -1) : 0;
  const tDeltaX = sx !== 0 ? CELL / Math.abs(dx) : Infinity;
  const tDeltaZ = sz !== 0 ? CELL / Math.abs(dz) : Infinity;
  let tMaxX = sx !== 0 ? (idx.minX + (sx > 0 ? gx + 1 : gx) * CELL - ox) / dx : Infinity;
  let tMaxZ = sz !== 0 ? (idx.minZ + (sz > 0 ? gz + 1 : gz) * CELL - oz) / dz : Infinity;

  visit(gx, gz);
  let steps = Math.abs(ex - gx) + Math.abs(ez - gz);
  while (steps-- > 0) {
    const tNext = Math.min(tMaxX, tMaxZ);
    if (tNext >= best) break;
    if (tMaxX < tMaxZ) {
      gx += sx;
      tMaxX += tDeltaX;
    } else {
      gz += sz;
      tMaxZ += tDeltaZ;
    }
    visit(gx, gz);
  }
  if (Math.min(tMaxX, tMaxZ) < best) {
    visit(ex, ez);
  }
  return best;
}

/**
 * 水平方向の壁（kind==='wall'）に対する空間索引付き最寄りレイキャスト。
 * 外向き単位法線 (nx, nz) と交点を返す（総当たり版 raycastWallXZ と完全一致）。
 */
export function raycastWallCollidersXZ(
  colliders: readonly Collider[],
  origin: Vec3,
  dirX: number,
  dirZ: number,
  maxDist: number,
): { dist: number; point: Vec3; nx: number; nz: number } | null {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6 || maxDist <= 1e-4) return null;
  const dx = dirX / len;
  const dz = dirZ / len;
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;

  let bestDist = maxDist;
  let bestNx = 0;
  let bestNz = 0;
  let hit = false;

  const testWall = (c: Collider): void => {
    if (c.kind !== 'wall') return;
    const a = c.aabb;
    if (oy < a.min.y || oy > a.max.y) return;
    let txMin: number;
    let txMax: number;
    if (Math.abs(dx) < 1e-8) {
      if (ox < a.min.x || ox > a.max.x) return;
      txMin = -Infinity;
      txMax = Infinity;
    } else {
      const t1 = (a.min.x - ox) / dx;
      const t2 = (a.max.x - ox) / dx;
      txMin = t1 < t2 ? t1 : t2;
      txMax = t1 > t2 ? t1 : t2;
    }
    let tzMin: number;
    let tzMax: number;
    if (Math.abs(dz) < 1e-8) {
      if (oz < a.min.z || oz > a.max.z) return;
      tzMin = -Infinity;
      tzMax = Infinity;
    } else {
      const t1 = (a.min.z - oz) / dz;
      const t2 = (a.max.z - oz) / dz;
      tzMin = t1 < t2 ? t1 : t2;
      tzMax = t1 > t2 ? t1 : t2;
    }
    const tMin = txMin > tzMin ? txMin : tzMin;
    const tMax = txMax < tzMax ? txMax : tzMax;
    if (tMax < (tMin > 0 ? tMin : 0) || tMin <= 1e-4 || tMin >= bestDist) return;
    bestDist = tMin;
    if (txMin > tzMin) {
      bestNx = dx > 0 ? -1 : 1;
      bestNz = 0;
    } else {
      bestNx = 0;
      bestNz = dz > 0 ? -1 : 1;
    }
    hit = true;
  };

  if (colliders.length < MIN_INDEXED) {
    for (let i = 0; i < colliders.length; i++) testWall(colliders[i]!);
  } else {
    const idx = indexOf(colliders);
    for (let i = 0; i < idx.dynamic.length; i++) testWall(idx.dynamic[i]!);
    const epoch = nextEpoch(idx);
    const { stamp, cells, cols, rows } = idx;
    const visit = (cx: number, cz: number): void => {
      if (cx < 0 || cx >= cols || cz < 0 || cz >= rows) return;
      const cell: Uint32Array = cells[cz * cols + cx]!;
      for (let k = 0; k < cell.length; k++) {
        const i = cell[k]!;
        if (stamp[i] === epoch) continue;
        stamp[i] = epoch;
        testWall(colliders[i]!);
      }
    };

    let gx = Math.floor((ox - idx.minX) / CELL);
    let gz = Math.floor((oz - idx.minZ) / CELL);
    const ex = Math.floor((ox + dx * bestDist - idx.minX) / CELL);
    const ez = Math.floor((oz + dz * bestDist - idx.minZ) / CELL);
    const sx = Math.abs(dx) >= 1e-8 ? (dx > 0 ? 1 : -1) : 0;
    const sz = Math.abs(dz) >= 1e-8 ? (dz > 0 ? 1 : -1) : 0;
    const tDeltaX = sx !== 0 ? CELL / Math.abs(dx) : Infinity;
    const tDeltaZ = sz !== 0 ? CELL / Math.abs(dz) : Infinity;
    let tMaxX = sx !== 0 ? (idx.minX + (sx > 0 ? gx + 1 : gx) * CELL - ox) / dx : Infinity;
    let tMaxZ = sz !== 0 ? (idx.minZ + (sz > 0 ? gz + 1 : gz) * CELL - oz) / dz : Infinity;

    visit(gx, gz);
    let steps = Math.abs(ex - gx) + Math.abs(ez - gz);
    while (steps-- > 0) {
      const tNext = Math.min(tMaxX, tMaxZ);
      if (tNext > bestDist + REG_EPS) break;
      if (tMaxX < tMaxZ) {
        gx += sx;
        tMaxX += tDeltaX;
      } else {
        gz += sz;
        tMaxZ += tDeltaZ;
      }
      visit(gx, gz);
    }
    if (Math.min(tMaxX, tMaxZ) <= bestDist + REG_EPS) {
      visit(ex, ez);
    }
  }

  if (!hit) return null;
  return {
    dist: bestDist,
    point: { x: ox + dx * bestDist, y: oy, z: oz + dz * bestDist },
    nx: bestNx,
    nz: bestNz,
  };
}
