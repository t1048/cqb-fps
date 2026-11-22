import type { BoxDef } from '../../core/types';
import type { Rng } from './Rng';

/**
 * 間取り生成の汎用ジオメトリ。
 * 部屋は軸平行の矩形で敷き詰め、壁は「部屋の境界線」から自動生成する（＝建物タイプに依存しない）。
 */

export const EPS = 1e-4;
/** これより短い壁片（端材）は生成しない(m)。 */
export const MIN_WALL_PIECE = 0.02;
/** モジュール 1 個あたりの辺接着配置候補数の上限。 */
export const MAX_PLACEMENT_CANDIDATES_PER_MODULE = 64;
/** 家具 1 個あたりの配置試行回数の上限。 */
export const MAX_FURNITURE_TRIES = 24;
/** 人物 1 体あたりの配置試行回数の上限。 */
export const MAX_ENTITY_TRIES = 40;
/** 人物の足元高さを同一階層とみなす許容差(m)。最小階高 2.48m の半分未満。 */
export const LAYER_Y_TOLERANCE = 1.0;

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** 'x' = X 方向に延びる線（z = c 一定） / 'z' = Z 方向に延びる線（x = c 一定） */
export type LineAxis = 'x' | 'z';

export interface SharedEdge {
  axis: LineAxis;
  c: number;
  lo: number;
  hi: number;
}

/** 壁開口（ドア・アーチ・窓）。center は線方向の座標。 */
export interface Opening {
  axis: LineAxis;
  c: number;
  center: number;
  width: number;
  lintelY?: number;
  window?: { sill: number; height: number };
}

export const rectW = (r: Rect): number => r.x1 - r.x0;
export const rectD = (r: Rect): number => r.z1 - r.z0;
export const rectArea = (r: Rect): number => rectW(r) * rectD(r);

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.z0 < b.z1 - EPS && b.z0 < a.z1 - EPS;
}

export function rectContainsPoint(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

export function inset(r: Rect, m: number): Rect {
  return { x0: r.x0 + m, z0: r.z0 + m, x1: r.x1 - m, z1: r.z1 - m };
}

/**
 * 矩形差集合 base − ∪cutouts を互いに素な軸平行矩形列で返す。
 * X 座標スイープで帯に分け、帯ごとに Z 方向の残り区間を求め、Z 区間が同一の隣接帯を結合する
 * （出力矩形数 <= (2C+1)(C+1)、指数的な断片化を起こさない）。
 * 結果は x0 → z0 の昇順で決定的。base が退化（幅か奥行 <= EPS）なら []。
 */
export function subtractRects(base: Rect, cutouts: readonly Rect[]): Rect[] {
  if (base.x1 - base.x0 <= EPS || base.z1 - base.z0 <= EPS) return [];
  // base と正の面積で重なる部分だけを base 内へクリップ
  const cuts: Rect[] = [];
  for (const c of cutouts) {
    if (!rectsOverlap(base, c)) continue;
    cuts.push({
      x0: Math.max(base.x0, c.x0),
      z0: Math.max(base.z0, c.z0),
      x1: Math.min(base.x1, c.x1),
      z1: Math.min(base.z1, c.z1),
    });
  }
  if (cuts.length === 0) return [{ ...base }];

  const xs = [base.x0, base.x1];
  for (const c of cuts) xs.push(c.x0, c.x1);
  xs.sort((a, b) => a - b);
  const bx: number[] = [];
  for (const x of xs) if (bx.length === 0 || x - bx[bx.length - 1] > EPS) bx.push(x);
  // 端点の微小誤差で base 外に出ないよう両端を固定
  bx[0] = base.x0;
  bx[bx.length - 1] = base.x1;

  const out: Rect[] = [];
  // 直前の帯で未確定（右へ延長可能）の矩形: Z 区間キー → out 内の添字
  let open = new Map<string, number>();
  for (let i = 0; i + 1 < bx.length; i++) {
    const xa = bx[i];
    const xb = bx[i + 1];
    const mid = (xa + xb) / 2;
    // この帯を覆う cutout の Z 区間を結合
    const iv: [number, number][] = [];
    for (const c of cuts) if (c.x0 < mid && c.x1 > mid) iv.push([c.z0, c.z1]);
    iv.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of iv) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    // 補集合（残る Z 区間）
    const free: [number, number][] = [];
    let cursor = base.z0;
    for (const [a, b] of merged) {
      if (a - cursor > EPS) free.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (base.z1 - cursor > EPS) free.push([cursor, base.z1]);

    const next = new Map<string, number>();
    for (const [za, zb] of free) {
      const key = `${za}|${zb}`;
      const idx = open.get(key);
      if (idx !== undefined) {
        out[idx].x1 = xb;
        next.set(key, idx);
      } else {
        next.set(key, out.length);
        out.push({ x0: xa, z0: za, x1: xb, z1: zb });
      }
    }
    open = next;
  }
  out.sort((p, q) => p.x0 - q.x0 || p.z0 - q.z0);
  return out;
}

/** 2 部屋の共有辺（長さ > EPS）。接していなければ null。 */
export function sharedEdge(a: Rect, b: Rect): SharedEdge | null {
  const near = (p: number, q: number): boolean => Math.abs(p - q) < EPS;
  if (near(a.x1, b.x0) || near(b.x1, a.x0)) {
    const lo = Math.max(a.z0, b.z0);
    const hi = Math.min(a.z1, b.z1);
    if (hi - lo > EPS) return { axis: 'z', c: near(a.x1, b.x0) ? a.x1 : a.x0, lo, hi };
  }
  if (near(a.z1, b.z0) || near(b.z1, a.z0)) {
    const lo = Math.max(a.x0, b.x0);
    const hi = Math.min(a.x1, b.x1);
    if (hi - lo > EPS) return { axis: 'x', c: near(a.z1, b.z0) ? a.z1 : a.z0, lo, hi };
  }
  return null;
}

const lineKey = (axis: LineAxis, c: number): string => `${axis}:${c.toFixed(3)}`;

/** 線上の部屋コーナー座標（他の壁が接合する点）。 */
function cornersOnLine(rects: readonly Rect[], axis: LineAxis, c: number): number[] {
  const out: number[] = [];
  for (const r of rects) {
    if (axis === 'x') {
      if (Math.abs(r.z0 - c) < EPS || Math.abs(r.z1 - c) < EPS) out.push(r.x0, r.x1);
    } else if (Math.abs(r.x0 - c) < EPS || Math.abs(r.x1 - c) < EPS) {
      out.push(r.z0, r.z1);
    }
  }
  return out;
}

/**
 * 共有辺上に開口の中心位置を選ぶ。壁の接合点・既存開口から十分離れた位置のみ。
 * @param margin 接合点の壁面から開口端までの余白
 */
export function pickOpeningCenter(
  rng: Rng,
  edge: SharedEdge,
  width: number,
  margin: number,
  wallThickness: number,
  rects: readonly Rect[],
  existing: readonly Opening[],
  snap: number,
): number | null {
  const m = width / 2 + wallThickness / 2 + margin;
  // 禁止区間: 接合点 ±m、既存開口
  const blocked: [number, number][] = [];
  for (const k of cornersOnLine(rects, edge.axis, edge.c)) blocked.push([k - m, k + m]);
  for (const o of existing) {
    if (o.axis !== edge.axis || Math.abs(o.c - edge.c) > EPS) continue;
    const half = o.width / 2 + width / 2 + 0.3;
    blocked.push([o.center - half, o.center + half]);
  }
  // 可能区間 = [lo+m, hi-m] − blocked
  let free: [number, number][] = [[edge.lo + m, edge.hi - m]];
  for (const [b0, b1] of blocked) {
    const next: [number, number][] = [];
    for (const [f0, f1] of free) {
      if (b1 <= f0 || b0 >= f1) {
        next.push([f0, f1]);
        continue;
      }
      if (b0 > f0) next.push([f0, b0]);
      if (b1 < f1) next.push([b1, f1]);
    }
    free = next;
  }
  free = free.filter(([a, b]) => b - a >= -EPS);
  if (free.length === 0) return null;
  const seg = rng.weighted(free, ([a, b]) => b - a + 0.01);
  if (!seg) return null;
  const raw = rng.range(seg[0], Math.max(seg[0], seg[1]));
  // 丸め後も区間内に収める
  const snapped = Math.round(raw / snap) * snap;
  return snapped >= seg[0] - EPS && snapped <= seg[1] + EPS ? round3(snapped) : round3(raw);
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * 全部屋矩形の境界線から壁 BoxDef を生成する。
 * - 同一直線上の辺は結合（隣室同士の重複壁を作らない）
 * - T 字接合では接合側の壁を相手の表面で止め、L 字角は X 方向の壁で塞ぐ
 * - 十字接合では X 方向の壁を通し、Z 方向の壁を両側の表面で止める
 * - 開口位置で壁を分割する
 * - 窓以外の開口で lintelY が height 未満なら、開口上に垂れ壁を置く（height - lintelY > EPS）
 * @param baseY この階の床高さ(m)。出力 BoxDef.y = baseY + 階内の高さ（0 の箱は y を省略）。省略時 0
 */
export function buildWalls(
  rects: readonly Rect[],
  openings: readonly Opening[],
  t: number,
  height: number,
  baseY = 0,
): BoxDef[] {
  // baseY = 0 のときは既存出力と同一（床置きの壁は y を省略）にする。
  const withY = (box: BoxDef, localY: number): BoxDef => {
    const y = baseY + localY;
    if (y !== 0) box.y = y;
    return box;
  };
  const lines = new Map<string, { axis: LineAxis; c: number; iv: [number, number][] }>();
  const add = (axis: LineAxis, c: number, a: number, b: number): void => {
    const key = lineKey(axis, c);
    let line = lines.get(key);
    if (!line) {
      line = { axis, c, iv: [] };
      lines.set(key, line);
    }
    line.iv.push([a, b]);
  };
  for (const r of rects) {
    add('x', r.z0, r.x0, r.x1);
    add('x', r.z1, r.x0, r.x1);
    add('z', r.x0, r.z0, r.z1);
    add('z', r.x1, r.z0, r.z1);
  }
  // 区間の結合
  const segs: { axis: LineAxis; c: number; a: number; b: number }[] = [];
  for (const line of lines.values()) {
    line.iv.sort((p, q) => p[0] - q[0]);
    let cur: [number, number] | null = null;
    for (const iv of line.iv) {
      if (cur && iv[0] <= cur[1] + EPS) {
        cur[1] = Math.max(cur[1], iv[1]);
      } else {
        if (cur) segs.push({ axis: line.axis, c: line.c, a: cur[0], b: cur[1] });
        cur = [iv[0], iv[1]];
      }
    }
    if (cur) segs.push({ axis: line.axis, c: line.c, a: cur[0], b: cur[1] });
  }
  // 端点 (x=p, z=c) が Z 方向壁の内部を貫通しているか（= T 字の幹側）
  const insideZWall = (x: number, z: number): boolean =>
    segs.some((s) => s.axis === 'z' && Math.abs(s.c - x) < EPS && z > s.a + EPS && z < s.b - EPS);
  const touchesXWall = (x: number, z: number): boolean =>
    segs.some((s) => s.axis === 'x' && Math.abs(s.c - z) < EPS && x >= s.a - EPS && x <= s.b + EPS);

  const boxes: BoxDef[] = [];
  for (const s of segs) {
    let a = s.a;
    let b = s.b;
    if (s.axis === 'x') {
      a += insideZWall(a, s.c) ? t / 2 : -t / 2;
      b += insideZWall(b, s.c) ? -t / 2 : t / 2;
    } else {
      if (touchesXWall(s.c, a)) a += t / 2;
      if (touchesXWall(s.c, b)) b -= t / 2;
    }
    const lineOpenings = openings.filter(
      (o) => o.axis === s.axis && Math.abs(o.c - s.c) < EPS && o.center > s.a && o.center < s.b,
    );
    const gaps: [number, number][] = lineOpenings.map((o): [number, number] => [
      o.center - o.width / 2,
      o.center + o.width / 2,
    ]);
    if (s.axis === 'z') {
      for (const xWall of segs) {
        if (xWall.axis === 'x' && s.c > xWall.a + EPS && s.c < xWall.b - EPS
          && xWall.c > s.a + EPS && xWall.c < s.b - EPS) {
          gaps.push([xWall.c - t / 2, xWall.c + t / 2]);
        }
      }
    }
    gaps.sort(([p], [q]) => p - q);
    let cursor = a;
    const pieces: [number, number][] = [];
    for (const [lo, hi] of gaps) {
      if (lo > cursor) pieces.push([cursor, Math.min(lo, b)]);
      cursor = Math.max(cursor, hi);
    }
    if (b > cursor) pieces.push([cursor, b]);
    for (const [p0, p1] of pieces) {
      const len = p1 - p0;
      if (len < MIN_WALL_PIECE) continue;
      // 中心と長さを別々に丸めると、端が隣の壁や扉からずれる。
      const mid = (p0 + p1) / 2;
      boxes.push(
        withY(
          s.axis === 'x'
            ? { x: mid, z: s.c, width: len, height, depth: t }
            : { x: s.c, z: mid, width: t, height, depth: len },
          0,
        ),
      );
    }
    // ドア・アーチ垂れ壁、および窓開口の腰壁・垂れ壁を生成
    for (const o of lineOpenings) {
      const wLen = Math.min(o.width, b - a);
      if (wLen < 0.1) continue;
      if (!o.window) {
        // 垂れ壁: 端材判定で扉上に隙間を作らないよう EPS で判定する。
        const topH = o.lintelY === undefined ? 0 : height - o.lintelY;
        if (o.lintelY !== undefined && topH > EPS) {
          boxes.push(
            withY(
              s.axis === 'x'
                ? { x: o.center, z: s.c, width: wLen, height: topH, depth: t }
                : { x: s.c, z: o.center, width: t, height: topH, depth: wLen },
              o.lintelY,
            ),
          );
        }
        continue;
      }
      const win = o.window;
      if (win.sill > MIN_WALL_PIECE) {
        boxes.push(
          withY(
            s.axis === 'x'
              ? { x: o.center, z: s.c, width: wLen, height: win.sill, depth: t }
              : { x: s.c, z: o.center, width: t, height: win.sill, depth: wLen },
            0,
          ),
        );
      }
      const topStart = win.sill + win.height;
      const topH = height - topStart;
      if (topH > MIN_WALL_PIECE) {
        boxes.push(
          withY(
            s.axis === 'x'
              ? { x: o.center, z: s.c, width: wLen, height: topH, depth: t }
              : { x: s.c, z: o.center, width: t, height: topH, depth: wLen },
            topStart,
          ),
        );
      }
    }
  }
  return boxes;
}
