/**
 * CQB 突入計画（純関数）。Squad（SWATモード）と SwatTeam（容疑者モード）で共有する。
 *
 * - assignStackSlots: 隊員 → スタック枠の割当（総移動距離の二乗和最小、ドア開口横切り・経路交差にペナルティ）
 * - planEntry: スタック枠ごとのサイド固定突入計画（side / rank / order / waypoints / PoD / look）
 *
 * 座標系（部屋座標）：ドア中心原点、u = axis 方向 lateral、v = into 方向 depth（屋外→屋内が +）。
 * three.js には依存しない。
 */
import type { RoomDef, Vec3 } from '../core/types';
import type { StackSlot, StackSlotPortal } from './stackSlots';

export interface XZ {
  x: number;
  z: number;
}

export interface CqbPortal {
  /** ドア中心。y は敷居（床）高さ */
  center: Vec3;
  /** 屋外→屋内の単位ベクトル */
  into: XZ;
  /** ドア開口に沿った単位ベクトル（スタック枠の lateral 符号の基準） */
  axis: XZ;
  width: number;
}

/** 部屋矩形（XZ 軸平行）。RoomDef から cqbRoomFromRoomDef() で変換する */
export interface CqbRoom {
  x: number;
  z: number;
  width: number;
  depth: number;
}

/** 突入スタイル: dynamic = 強行突入、stealth = 慎重（半開き・パイ切り・静音進入） */
export type EntryMode = 'dynamic' | 'stealth';

export interface EntryPlan {
  /** axis 方向の符号。スタック枠の lateral 符号と同じ（0 は左 = -1 扱い） */
  side: -1 | 1;
  /** サイド内の順位 (0=先頭) */
  rank: number;
  /** 全体の突入順 (0..n-1) */
  order: number;
  /** [敷居点, (先頭のみ)壁沿い点, PoD] */
  waypoints: Vec3[];
  pod: Vec3;
  /** PoD で保持する視線点 */
  look: Vec3;
  /** 敷居直後の自サイドハードコーナー視線点（ボタンフック中のコーナーチェック用） */
  hardCornerLook: Vec3;
}

export interface PlanEntryOptions {
  /** 点に立てるか（床・障害物の判定は呼び出し側） */
  isStandable(p: Vec3): boolean;
  /** a→b を歩いて到達できるか（直線 or 経路探索は呼び出し側） */
  reachable(a: Vec3, b: Vec3): boolean;
  /** 縮退が全滅したときに使う PoD 候補（例: Squad.computeDominationPoints の pos） */
  fallbackPods?: readonly Vec3[];
  /** 視線点の高さ（敷居高さからのオフセット）。既定 1.38 */
  lookHeight?: number;
  /** PoD 同士の最小間隔。既定 0.6 */
  minPodSeparation?: number;
}

export interface EntrySlotRank {
  side: -1 | 1;
  rank: number;
  order: number;
}

// ---------- 変換ヘルパ ----------

/** RoomDef → CqbRoom */
export function cqbRoomFromRoomDef(room: Pick<RoomDef, 'x' | 'z' | 'width' | 'depth'>): CqbRoom {
  return { x: room.x, z: room.z, width: room.width, depth: room.depth };
}

/**
 * layoutStackSlots() 用の StackSlotPortal（Squad の EntryPortal、SwatTactics.buildStackSlotPortal の戻り値）→ CqbPortal。
 * y は敷居高さ（Squad: portal.sillY / SwatTeam: EntryPortal.sillY）。
 */
export function cqbPortalFromStackSlotPortal(p: StackSlotPortal, y = 0): CqbPortal {
  const il = Math.hypot(p.intoX, p.intoZ) || 1;
  const al = Math.hypot(p.axisX, p.axisZ) || 1;
  return {
    center: { x: p.centerX, y, z: p.centerZ },
    into: { x: p.intoX / il, z: p.intoZ / il },
    axis: { x: p.axisX / al, z: p.axisZ / al },
    width: p.width,
  };
}

/** ワールド XZ → 部屋座標 (u, v) */
export function toPortalFrame(portal: CqbPortal, p: XZ): { u: number; v: number } {
  const dx = p.x - portal.center.x;
  const dz = p.z - portal.center.z;
  return {
    u: dx * portal.axis.x + dz * portal.axis.z,
    v: dx * portal.into.x + dz * portal.into.z,
  };
}

/** 部屋座標 (u, v) → ワールド（y は指定が無ければ敷居高さ） */
export function fromPortalFrame(portal: CqbPortal, u: number, v: number, y = portal.center.y): Vec3 {
  return {
    x: portal.center.x + portal.axis.x * u + portal.into.x * v,
    y,
    z: portal.center.z + portal.axis.z * u + portal.into.z * v,
  };
}

// ---------- 2.1 assignStackSlots ----------

const segIntersects = (a: XZ, b: XZ, c: XZ, d: XZ): boolean => {
  const cross = (o: XZ, p: XZ, q: XZ): number => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
};

/** 部屋座標の線分 (u0,v0)-(u1,v1) が矩形 [uMin,uMax]×[vMin,vMax] を通るか（Liang–Barsky） */
const segHitsRect = (
  u0: number, v0: number, u1: number, v1: number,
  uMin: number, uMax: number, vMin: number, vMax: number,
): boolean => {
  let t0 = 0;
  let t1 = 1;
  const du = u1 - u0;
  const dv = v1 - v0;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-du, u0 - uMin) && clip(du, uMax - u0) && clip(-dv, v0 - vMin) && clip(dv, vMax - v0) && t0 <= t1
  );
};

/** ドア開口前（|u| < width/2、外側 0.3m 以内）を横切る割当のペナルティ */
export const DOOR_CROSS_PENALTY = 4;
/** 2 人の移動線分が交差する割当のペナルティ（入れ替わり防止。二乗和最小だけでは交差が残る場合がある） */
export const PATH_CROSS_PENALTY = 4;

/**
 * 隊員の現在位置 → スタック枠の割当。返り値は members[i] → slot index（枠が足りない隊員は -1）。
 * n ≤ 7 は全探索で「総移動距離の二乗和 + ペナルティ」最小。同点時は辞書順（index 安定）。
 * portal を渡すとドア開口横切りペナルティ (+4) を加える。
 */
export function assignStackSlots(
  positions: readonly XZ[],
  slots: readonly StackSlot[],
  portal?: CqbPortal,
): number[] {
  const n = positions.length;
  const m = slots.length;
  const out = new Array<number>(n).fill(-1);
  if (n === 0 || m === 0) return out;

  const cost: number[][] = positions.map((p) =>
    slots.map((s) => {
      let c = (p.x - s.x) ** 2 + (p.z - s.z) ** 2;
      if (portal) {
        const a = toPortalFrame(portal, p);
        const b = toPortalFrame(portal, s);
        const hw = portal.width / 2;
        if (segHitsRect(a.u, a.v, b.u, b.v, -hw + 1e-3, hw - 1e-3, -0.3, 0)) c += DOOR_CROSS_PENALTY;
      }
      return c;
    }),
  );

  // 割当人数（枠が足りなければ先頭 n' 人のみではなく、全員を候補にして枠数ぶんを選ぶ）
  const k = Math.min(n, m);
  if (n > 7 || m > 9) {
    // 大人数は貪欲（コスト最小の組から確定）
    const pairs: { i: number; j: number; c: number }[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) pairs.push({ i, j, c: cost[i]![j]! });
    pairs.sort((a, b) => a.c - b.c || a.i - b.i || a.j - b.j);
    const usedS = new Set<number>();
    let assigned = 0;
    for (const { i, j } of pairs) {
      if (assigned >= k) break;
      if (out[i] !== -1 || usedS.has(j)) continue;
      out[i] = j;
      usedS.add(j);
      assigned++;
    }
    return out;
  }

  let best = Infinity;
  let bestAssign: number[] = out.slice();
  const cur = new Array<number>(n).fill(-1);
  const used = new Array<boolean>(m).fill(false);
  const crossPenalty = (i: number, j: number): number => {
    let pen = 0;
    for (let q = 0; q < i; q++) {
      const sj = cur[q]!;
      if (sj < 0) continue;
      if (segIntersects(positions[q]!, slots[sj]!, positions[i]!, slots[j]!)) pen += PATH_CROSS_PENALTY;
    }
    return pen;
  };
  const dfs = (i: number, acc: number, assigned: number): void => {
    if (acc >= best - 1e-9) return;
    if (i === n) {
      if (assigned < k) return;
      best = acc;
      bestAssign = cur.slice();
      return;
    }
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      used[j] = true;
      cur[i] = j;
      dfs(i + 1, acc + cost[i]![j]! + crossPenalty(i, j), assigned + 1);
      cur[i] = -1;
      used[j] = false;
    }
    // 枠が足りないときは「割当なし」も選べる（残り人数で枠を埋め切れる場合のみ）
    if (n - i - 1 >= k - assigned) dfs(i + 1, acc, assigned);
  };
  dfs(0, 0, 0);
  return bestAssign;
}

// ---------- 2.2 突入順 ----------

/**
 * 各スタック枠の side / rank / order（slot index 順）。
 * side = sign(lateral)（0 は左 = -1）、rank = 同サイド内で後退距離昇順、
 * order = rank 昇順 → 同 rank は左(-1)→右(+1) → slot index（= L0, R0, L1, R1 …）。
 */
export function computeEntryOrder(portal: CqbPortal, slots: readonly StackSlot[]): EntrySlotRank[] {
  const info = slots.map((s, index) => {
    const { u, v } = toPortalFrame(portal, s);
    const side: -1 | 1 = u > 1e-3 ? 1 : -1;
    return { index, side, back: -v, rank: 0, order: 0 };
  });
  for (const side of [-1, 1] as const) {
    const same = info.filter((s) => s.side === side).sort((a, b) => a.back - b.back || a.index - b.index);
    same.forEach((s, r) => {
      s.rank = r;
    });
  }
  const sorted = info.slice().sort((a, b) => a.rank - b.rank || a.side - b.side || a.index - b.index);
  sorted.forEach((s, o) => {
    s.order = o;
  });
  return info.map(({ side, rank, order }) => ({ side, rank, order }));
}

// ---------- 2.3 経路・PoD ----------

/** 原点 (cx,cz) から方向 (dx,dz) に進んで部屋矩形を出るまでの距離（出られない/外側なら 0） */
const rayExit = (room: CqbRoom, cx: number, cz: number, dx: number, dz: number): number => {
  let t = Infinity;
  const hx = room.width / 2;
  const hz = room.depth / 2;
  if (Math.abs(dx) > 1e-6) t = Math.min(t, ((dx > 0 ? room.x + hx : room.x - hx) - cx) / dx);
  if (Math.abs(dz) > 1e-6) t = Math.min(t, ((dz > 0 ? room.z + hz : room.z - hz) - cz) / dz);
  return Number.isFinite(t) ? Math.max(0, t) : 0;
};

const insideRoom = (room: CqbRoom, p: XZ, margin: number): boolean =>
  Math.abs(p.x - room.x) <= room.width / 2 - margin && Math.abs(p.z - room.z) <= room.depth / 2 - margin;

/** 入口壁沿いの自サイド有効半幅 halfL（壁までの距離 - 0.65、0..4.0） */
export function entryHalfWidth(portal: CqbPortal, room: CqbRoom, side: -1 | 1): number {
  // ドア中心は壁上にあるので、少し屋内側から axis 方向へレイを飛ばす
  const ox = portal.center.x + portal.into.x * 0.05;
  const oz = portal.center.z + portal.into.z * 0.05;
  const d = rayExit(room, ox, oz, portal.axis.x * side, portal.axis.z * side);
  return Math.max(0, Math.min(4.0, d - 0.65));
}

/** ドアから into 方向の部屋奥行き */
export function entryRoomDepth(portal: CqbPortal, room: CqbRoom): number {
  return rayExit(room, portal.center.x, portal.center.z, portal.into.x, portal.into.z);
}

/**
 * スタック枠ごとの突入計画（slot index 順）。
 * - 敷居点 v=0.55, u=side*min(0.18, width*0.2)
 * - rank0（ボタンフック）: 壁沿い点 v=0.75,u=side*min(halfL*0.6,1.4) → PoD v=0.9,u=side*halfL。look 対角奥
 * - rank1: PoD v=1.7,u=side*min(halfL*0.5,1.2)。look 奥壁の自サイド
 * - rank2+: PoD v=1.0+0.6*rank,u=side*0.6。look 正面奥
 * 各点は isStandable・reachable(前点,点)・部屋内を満たすまで u×0.8 / v±0.2 で縮退（最大6回）。
 * PoD が全滅したら fallbackPods（未使用で設計 PoD に最も近いもの）を使う。
 */
export function planEntry(
  portal: CqbPortal,
  room: CqbRoom,
  slots: readonly StackSlot[],
  opts: PlanEntryOptions,
): EntryPlan[] {
  const y = portal.center.y;
  const lookY = y + (opts.lookHeight ?? 1.38);
  const minSep = opts.minPodSeparation ?? 0.6;
  const ranks = computeEntryOrder(portal, slots);
  const depth = entryRoomDepth(portal, room);
  const halfBySide = { [-1]: entryHalfWidth(portal, room, -1), [1]: entryHalfWidth(portal, room, 1) } as Record<
    -1 | 1,
    number
  >;
  const fallbacks = (opts.fallbackPods ?? []).slice();
  const fallbackUsed = new Array<boolean>(fallbacks.length).fill(false);
  const pods: Vec3[] = [];
  const doorCenter = fromPortalFrame(portal, 0, 0);

  const valid = (p: Vec3, prev: Vec3, isPod: boolean, inRoomCheck: boolean): boolean => {
    if (inRoomCheck && !insideRoom(room, p, 0.3)) return false;
    if (isPod && pods.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < minSep)) return false;
    if (!opts.isStandable(p)) return false;
    return opts.reachable(prev, p);
  };

  /** 設計点 (u,v) を縮退しながら解決。全滅なら null */
  const resolve = (u: number, v: number, prev: Vec3, isPod: boolean, minV: number): Vec3 | null => {
    for (let k = 0; k <= 6; k++) {
      const uk = u * 0.8 ** k;
      const dvs = k === 0 ? [0] : [0, -0.2, 0.2];
      for (const dv of dvs) {
        const vk = Math.max(minV, v + dv);
        const p = fromPortalFrame(portal, uk, vk);
        if (valid(p, prev, isPod, vk > 0.3)) return p;
      }
    }
    return null;
  };

  // order 順に解決（PoD 間隔チェックは先に入る者を優先）
  const byOrder = ranks.map((r, index) => ({ ...r, index })).sort((a, b) => a.order - b.order);
  const plans = new Array<EntryPlan>(slots.length);
  for (const { side, rank, order, index } of byOrder) {
    const halfL = halfBySide[side];
    const halfOpp = halfBySide[(side === -1 ? 1 : -1) as -1 | 1];
    const waypoints: Vec3[] = [];

    // 敷居点（前点はドア中心。スタック枠からの直線はドア枠を跨ぐので使わない）
    const tu = side * Math.min(0.18, portal.width * 0.2);
    const thresh = resolve(tu, 0.55, doorCenter, false, 0.35) ?? fromPortalFrame(portal, 0, 0.55);
    waypoints.push(thresh);
    let prev = thresh;

    let podU: number;
    let podV: number;
    let look: Vec3;
    if (rank === 0) {
      if (halfL >= 0.5) {
        const wall = resolve(side * Math.min(halfL * 0.6, 1.4), 0.75, prev, false, 0.55);
        if (wall) {
          waypoints.push(wall);
          prev = wall;
        }
      }
      podU = side * halfL;
      podV = 0.9;
      look = fromPortalFrame(portal, -side * halfOpp * 0.6, Math.max(podV + 0.5, depth - 0.6), lookY);
    } else if (rank === 1) {
      podU = side * Math.min(halfL * 0.5, 1.2);
      podV = 1.7;
      look = fromPortalFrame(portal, side * halfL * 0.5, Math.max(podV + 0.5, depth - 0.5), lookY);
    } else {
      podU = side * 0.6;
      podV = 1.0 + 0.6 * rank;
      look = fromPortalFrame(portal, 0, Math.max(podV + 0.5, depth - 0.5), lookY);
    }

    let pod = resolve(podU, podV, prev, true, 0.6);
    if (!pod && prev !== thresh) pod = resolve(podU, podV, thresh, true, 0.6);
    if (!pod && fallbacks.length) {
      const want = fromPortalFrame(portal, podU, podV);
      let bi = -1;
      let bd = Infinity;
      fallbacks.forEach((f, i) => {
        if (fallbackUsed[i]) return;
        const d = Math.hypot(f.x - want.x, f.z - want.z);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      if (bi >= 0) {
        fallbackUsed[bi] = true;
        const f = fallbacks[bi]!;
        pod = { x: f.x, y: f.y ?? y, z: f.z };
      }
    }
    if (!pod) {
      // 最終手段: 最も縮退した設計点（検査無し）。呼び出し側のナビに任せる
      pod = fromPortalFrame(portal, podU * 0.8 ** 6, Math.max(0.6, Math.min(podV, depth - 0.4)));
    }
    pods.push(pod);
    waypoints.push(pod);
    // 自サイド入口脇のハードコーナー視線点（rank 0 は壁沿いコーナー、rank 1+ は最終 look と同じ）
    const hardCornerLook =
      rank === 0
        ? fromPortalFrame(portal, side * Math.max(halfL + 0.35, 1.2), 0.75, lookY)
        : look;
    plans[index] = { side, rank, order, waypoints, pod, look, hardCornerLook };
  }
  return plans;
}

// ---------- フェーズ1〜3 共有純関数（射線管理・後方警戒・パイ切り・角リーン） ----------

export interface FriendlyPos {
  x: number;
  y: number;
  z: number;
}

/**
 * マズルディシプリン判定: 銃口前方に味方・プレイヤーが重なるか、至近距離の壁がある場合にローレディを返す。
 * yawRad は HumanoidBody の規約（前方 = (-sin(yaw), -cos(yaw))）。
 */
export function shouldUseLowReady(
  pos: FriendlyPos,
  yawRad: number,
  friendlies: readonly FriendlyPos[],
  wallClose = false,
  maxDist = 2.6,
  halfWidth = 0.52,
): boolean {
  if (wallClose) return true;
  const fx = -Math.sin(yawRad);
  const fz = -Math.cos(yawRad);
  const rx = Math.cos(yawRad);
  const rz = -Math.sin(yawRad);
  for (const f of friendlies) {
    if (Math.abs(f.y - pos.y) > 0.75) continue;
    const dx = f.x - pos.x;
    const dz = f.z - pos.z;
    const fwd = dx * fx + dz * fz;
    if (fwd <= 0.15 || fwd > maxDist) continue;
    const lat = Math.abs(dx * rx + dz * rz);
    if (lat < halfWidth) return true;
  }
  return false;
}

/**
 * スタック・ドア準備中のセクター視線点を算出する。
 * - 先頭 (rank === 0): ドア開口部中央を注視
 * - 後続 (rank >= 1、最後尾含む): ドア開口の反対側エッジ〜斜め前方をカバー（ドアに背を向けない）
 */
export function computeStackLookPoint(
  portal: CqbPortal,
  _order: number,
  _groupSize: number,
  rank: number,
  side: -1 | 1,
  lookHeight = 1.38,
): Vec3 {
  const y = portal.center.y + lookHeight;
  if (rank === 0) {
    return fromPortalFrame(portal, 0, 0.25, y);
  }
  // 後続員はドア開口の反対側エッジ〜斜め前方をカバー
  return fromPortalFrame(portal, -side * Math.max(0.55, portal.width * 0.45), 0.15, y);
}

export interface PieStep {
  /** ドア外側の弧上の立ち位置 */
  pos: Vec3;
  /** 視線・照準点（室内奥を反対側から順にスライスする） */
  look: Vec3;
  /** ポート座標系での開口方向符号（+1 = +axis 側へ傾く, -1 = -axis 側へ傾く） */
  portalLeanAxis: -1 | 0 | 1;
}

export interface PlanDoorPieOptions {
  isStandable(p: Vec3): boolean;
  steps?: number;
  radius?: number;
  lookHeight?: number;
}

/**
 * ドア外周のスライシング・ザ・パイ（弧状移動＋視線スイープ）経路を生成する。
 * 開始サイド `side` (-1=左, +1=右) の外側約 62° から開口正面（〜反対側少し）へ弧を描いて移動し、
 * 各ステップで開口を通して室内の未視認角度を順に切る。
 */
export function planDoorPieArc(
  portal: CqbPortal,
  room: CqbRoom,
  side: -1 | 1,
  opts: PlanDoorPieOptions,
): PieStep[] {
  const steps = Math.max(2, opts.steps ?? 4);
  const baseRadius = opts.radius ?? 1.35;
  const lookY = portal.center.y + (opts.lookHeight ?? 1.38);
  const depth = Math.max(1.6, entryRoomDepth(portal, room));
  const lookDist = Math.min(4.6, Math.max(1.8, depth - 0.45));

  // 開始角（自サイド 62°）→ 終了角（正面〜わずかに反対側 -12°）
  const startDeg = side * 62;
  const endDeg = -side * 12;
  const out: PieStep[] = [];
  const radii = [baseRadius, Math.max(0.9, baseRadius - 0.35), Math.max(0.75, baseRadius - 0.55)];

  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0.5 : i / (steps - 1);
    const deg = startDeg + (endDeg - startDeg) * t;
    const rad = (deg * Math.PI) / 180;
    const sinA = Math.sin(rad);
    const cosA = Math.cos(rad);
    let chosen: Vec3 | null = null;
    for (const r of radii) {
      const cand = fromPortalFrame(portal, r * sinA, -r * cosA);
      if (opts.isStandable(cand)) {
        chosen = cand;
        break;
      }
    }
    if (!chosen) continue;
    // 立ち位置からドア中心を通るレイで室内奥の視線点を算出
    const dx = portal.center.x - chosen.x;
    const dz = portal.center.z - chosen.z;
    const dLen = Math.hypot(dx, dz) || 1;
    const look: Vec3 = {
      x: portal.center.x + (dx / dLen) * lookDist,
      y: lookY,
      z: portal.center.z + (dz / dLen) * lookDist,
    };
    const uPos = toPortalFrame(portal, chosen).u;
    const portalLeanAxis: -1 | 0 | 1 = Math.abs(uPos) > 0.18 ? (uPos > 0 ? -1 : 1) : 0;
    out.push({ pos: chosen, look, portalLeanAxis });
  }
  return out;
}

/**
 * ポート座標のリーン軸符号 (portalLeanAxis: -1 | 0 | 1) を、
 * 隊員の体向き yawRad に対するローカル左右リーン量 (-1=左, +1=右) へ変換する。
 */
export function portalLeanToBodyLean(portal: CqbPortal, yawRad: number, portalLeanAxis: -1 | 0 | 1): number {
  if (portalLeanAxis === 0) return 0;
  // HumanoidBody ローカル +X (右) = (cos(yaw), -sin(yaw))
  const rx = Math.cos(yawRad);
  const rz = -Math.sin(yawRad);
  const dot = portal.axis.x * portalLeanAxis * rx + portal.axis.z * portalLeanAxis * rz;
  return dot >= 0 ? 0.85 : -0.85;
}

/**
 * 味方が射線上にいるとき、左右どちらかに半歩ずれて射線を通せる位置を探す。
 */
export function computeStepOutPoint(
  pos: Vec3,
  target: Vec3,
  isStandable: (p: Vec3) => boolean,
  isClear: (p: Vec3) => boolean,
  offset = 0.78,
): Vec3 | null {
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.3) return null;
  // 射線に直交する単位ベクトル
  const px = -dz / len;
  const pz = dx / len;
  for (const dist of [offset, offset * 1.35]) {
    for (const sign of [1, -1] as const) {
      const cand: Vec3 = { x: pos.x + px * dist * sign, y: pos.y, z: pos.z + pz * dist * sign };
      if (isStandable(cand) && isClear(cand)) return cand;
    }
  }
  return null;
}

/**
 * 壁際・角待ち時の自動リーン方向を算出する。
 * 左右 0.52m に壁がある側を検出し、片側だけ壁で反対側が開けていれば壁から離れる方向へリーンする。
 */
export function computeCornerLean(
  pos: Vec3,
  yawRad: number,
  isBlocked: (x: number, z: number) => boolean,
  probeDist = 0.52,
): number {
  const rx = Math.cos(yawRad);
  const rz = -Math.sin(yawRad);
  const fx = -Math.sin(yawRad);
  const fz = -Math.cos(yawRad);
  const leftBlocked = isBlocked(pos.x - rx * probeDist, pos.z - rz * probeDist);
  const rightBlocked = isBlocked(pos.x + rx * probeDist, pos.z + rz * probeDist);
  if (leftBlocked === rightBlocked) return 0;
  // 壁から離れる側（開いている側）へ、さらに前方に抜けがあるときだけリーン
  const dir = leftBlocked ? 1 : -1;
  const openFwdBlocked = isBlocked(pos.x + rx * probeDist * dir + fx * 0.45, pos.z + rz * probeDist * dir + fz * 0.45);
  return openFwdBlocked ? 0 : dir * 0.8;
}

