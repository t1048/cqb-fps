import type {
  AllyDef,
  BoxDef,
  DoorDef,
  EntityDef,
  ItemDef,
  ModularSnap,
  OrthogonalRotation,
  PlayerSpawn,
  StairDef,
  WindowDef,
} from '../../core/types';
import type { LineAxis, Rect } from './Layout';
import type { Dir2, PlacedBuildingLayout, PlacedOpening, PlacedRoom, PlacedStairCore } from './SpatialSolver';

/**
 * 敷地の格子整数センタリングと 8 通りの直交変換（docs/design/modular-map-generator.md §2.1 / §3.2-4）。
 * L = R_rot ∘ M_x（M_x: (X,Z) → (-X,Z)、R_90: (X,Z) → (-Z,X)、R_180: (-X,-Z)、R_270: (Z,-X)）。
 * 平行移動は格子整数 (dX, dZ) × snap、写像は符号反転と成分交換だけなので浮動小数点で厳密（丸め誤差ゼロ）。
 * 方位は単位ベクトルを L で写して角度へ戻す（規約ごとの式は §3.2-4 の閉包写像規則）。
 */

export interface SiteFrame {
  rot: OrthogonalRotation;
  mirrorX: boolean;
  snap: number;
  /** 格子整数シフト量 */
  dX: number;
  dZ: number;
  /** 変換前（回転前）の敷地半幅・半奥行（格子整数） */
  halfW: number;
  halfD: number;
}

export const ROTATIONS: readonly OrthogonalRotation[] = [0, 90, 180, 270];

/** 外接矩形（メートル）と外周余白から、原点対称にする格子整数シフトと敷地半幅を求める。 */
export function computeSiteFrame(
  bounds: Rect,
  perimeterMargin: number,
  snap: number,
  rot: OrthogonalRotation,
  mirrorX: boolean,
): SiteFrame {
  const m = Math.ceil(perimeterMargin / snap - 1e-9);
  const xMin = Math.floor(bounds.x0 / snap + 1e-9) - m;
  const xMax = Math.ceil(bounds.x1 / snap - 1e-9) + m;
  const zMin = Math.floor(bounds.z0 / snap + 1e-9) - m;
  const zMax = Math.ceil(bounds.z1 / snap - 1e-9) + m;
  const dX = -Math.floor((xMin + xMax) / 2);
  const dZ = -Math.floor((zMin + zMax) / 2);
  return {
    rot,
    mirrorX,
    snap,
    dX,
    dZ,
    halfW: Math.max(Math.abs(xMin + dX), Math.abs(xMax + dX)),
    halfD: Math.max(Math.abs(zMin + dZ), Math.abs(zMax + dZ)),
  };
}

/** 平行移動なしの枠（写像の合成検査・ベクトル変換用）。 */
export function pureFrame(rot: OrthogonalRotation, mirrorX: boolean, snap: number): SiteFrame {
  return { rot, mirrorX, snap, dX: 0, dZ: 0, halfW: 0, halfD: 0 };
}

const nz = (v: number): number => (v === 0 ? 0 : v); // -0 → 0

/** 線形部分 L（ベクトル用。平行移動なし） */
export function mapVec(f: SiteFrame, x: number, z: number): Dir2 {
  const mx = f.mirrorX ? -x : x;
  switch (f.rot) {
    case 90:
      return { x: nz(-z), z: nz(mx) };
    case 180:
      return { x: nz(-mx), z: nz(-z) };
    case 270:
      return { x: nz(z), z: nz(-mx) };
    default:
      return { x: nz(mx), z: nz(z) };
  }
}

/** 点 p ↦ L(p + Δ·snap) */
export function mapPoint(f: SiteFrame, x: number, z: number): Dir2 {
  return mapVec(f, x + f.dX * f.snap, z + f.dZ * f.snap);
}

export function mapRect(f: SiteFrame, r: Rect): Rect {
  const a = mapPoint(f, r.x0, r.z0);
  const b = mapPoint(f, r.x1, r.z1);
  return { x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) };
}

/** 90° / 270° では X と Z の寸法が入れ替わる */
export function swapsAxes(f: SiteFrame): boolean {
  return f.rot === 90 || f.rot === 270;
}

/** 度を [0, 360) の整数へ正規化 */
export function normDeg(deg: number): number {
  return nz(((Math.round(deg) % 360) + 360) % 360);
}

const DEG = Math.PI / 180;
/** 基本方向の単位ベクトル成分は sin/cos の微小誤差を落として整数化する */
const clean = (v: number): number => (Math.abs(v - Math.round(v)) < 1e-12 ? Math.round(v) : v);

/** DoorDef.yaw（ヒンジ→ノブ有向接線 u = (cos, -sin)） */
export function mapDoorYaw(f: SiteFrame, yaw: number): number {
  const u = mapVec(f, clean(Math.cos(yaw * DEG)), clean(-Math.sin(yaw * DEG)));
  return normDeg(Math.atan2(-u.z, u.x) / DEG);
}

/** WindowDef.yaw（外向き法線 n = (sin, cos)） */
export function mapWindowYaw(f: SiteFrame, yaw: number): number {
  const n = mapVec(f, clean(Math.sin(yaw * DEG)), clean(Math.cos(yaw * DEG)));
  return normDeg(Math.atan2(n.x, n.z) / DEG);
}

/** StairDef / EntityDef / AllyDef / ItemDef の yaw（Three.js +Y 反時計回り。正面 f = (-sin, -cos)） */
export function mapCcwYaw(f: SiteFrame, yaw: number): number {
  const v = mapVec(f, clean(-Math.sin(yaw * DEG)), clean(-Math.cos(yaw * DEG)));
  return normDeg(Math.atan2(-v.x, -v.z) / DEG);
}

/** PlayerSpawn.yaw（時計回り方位。正面 v = (sin, -cos)） */
export function mapPlayerYaw(f: SiteFrame, yaw: number): number {
  const v = mapVec(f, clean(Math.sin(yaw * DEG)), clean(-Math.cos(yaw * DEG)));
  return normDeg(Math.atan2(v.x, -v.z) / DEG);
}

/** BoxDef.yaw 指定箱の yaw（接線 u = (cos, -sin) を写す。DoorDef と同じ式） */
export const mapBoxYaw = mapDoorYaw;

export function mapDoor(f: SiteFrame, d: DoorDef): DoorDef {
  const p = mapPoint(f, d.x, d.z);
  return { ...d, x: p.x, z: p.z, yaw: mapDoorYaw(f, d.yaw) };
}

export function mapWindow(f: SiteFrame, w: WindowDef): WindowDef {
  const p = mapPoint(f, w.x, w.z);
  return { ...w, x: p.x, z: p.z, yaw: mapWindowYaw(f, w.yaw) };
}

export function mapStair(f: SiteFrame, s: StairDef): StairDef {
  const p = mapPoint(f, s.x, s.z);
  return { ...s, x: p.x, z: p.z, yaw: mapCcwYaw(f, s.yaw) };
}

/** EntityDef / AllyDef / ItemDef（yaw 省略は 0 とみなして写す） */
export function mapFacing<T extends EntityDef | AllyDef | ItemDef>(f: SiteFrame, e: T): T {
  const p = mapPoint(f, e.x, e.z);
  return { ...e, x: p.x, z: p.z, yaw: mapCcwYaw(f, e.yaw ?? 0) };
}

export function mapSpawn(f: SiteFrame, sp: PlayerSpawn): PlayerSpawn {
  const p = mapPoint(f, sp.x, sp.z);
  return { ...sp, x: p.x, z: p.z, yaw: mapPlayerYaw(f, sp.yaw) };
}

/** 軸平行箱（yaw 省略）は 90°/270° で width と depth を交換、yaw 指定箱は yaw を写す */
export function mapBox(f: SiteFrame, b: BoxDef): BoxDef {
  const p = mapPoint(f, b.x, b.z);
  if (b.yaw === undefined) {
    const out: BoxDef = { ...b, x: p.x, z: p.z };
    if (swapsAxes(f)) {
      out.width = b.depth;
      out.depth = b.width;
    }
    return out;
  }
  return { ...b, x: p.x, z: p.z, yaw: mapBoxYaw(f, b.yaw) };
}

/** 変換後の敷地（原点対称）。map.floor の幅・奥行 */
export function lotSize(f: SiteFrame): { width: number; depth: number } {
  const w = 2 * f.halfW * f.snap;
  const d = 2 * f.halfD * f.snap;
  return swapsAxes(f) ? { width: d, depth: w } : { width: w, depth: d };
}

export function lotRectOf(f: SiteFrame): Rect {
  const { width, depth } = lotSize(f);
  return { x0: -width / 2, z0: -depth / 2, x1: width / 2, z1: depth / 2 };
}

function mapOpening(f: SiteFrame, o: PlacedOpening): PlacedOpening {
  // axis 'x' の線は z = c 一定で center は x 座標、axis 'z' は x = c 一定で center は z 座標
  const p = o.axis === 'x' ? mapPoint(f, o.center, o.c) : mapPoint(f, o.c, o.center);
  const axis: LineAxis = swapsAxes(f) ? (o.axis === 'x' ? 'z' : 'x') : o.axis;
  return { ...o, axis, c: axis === 'x' ? p.z : p.x, center: axis === 'x' ? p.x : p.z };
}

function mapRoom(f: SiteFrame, r: PlacedRoom): PlacedRoom {
  return { ...r, rect: mapRect(f, r.rect) };
}

function mapCore(f: SiteFrame, c: PlacedStairCore): PlacedStairCore {
  return {
    ...c,
    rect: mapRect(f, c.rect),
    inner: mapRect(f, c.inner),
    laneW: mapRect(f, c.laneW),
    laneMid: mapRect(f, c.laneMid),
    laneE: mapRect(f, c.laneE),
    flights: c.flights.map((fl) => ({ ...fl, def: mapStair(f, fl.def) })),
    holes: c.holes.map((h) => ({ ...h, rect: mapRect(f, h.rect), openDir: mapVec(f, h.openDir.x, h.openDir.z) })),
    landings: c.landings.map((l) => ({ ...l, rect: mapRect(f, l.rect) })),
    doorBlocked: c.doorBlocked.map((l) => ({ ...l, rect: mapRect(f, l.rect) })),
  };
}

/** 枠 f でレイアウト全体を写す（lotRect は f の原点対称敷地）。 */
export function transformLayoutWithFrame(layout: PlacedBuildingLayout, f: SiteFrame): PlacedBuildingLayout {
  return {
    ...layout,
    rooms: layout.rooms.map((r) => mapRoom(f, r)),
    openings: layout.openings.map((o) => mapOpening(f, o)),
    stairCores: layout.stairCores.map((c) => mapCore(f, c)),
    stairLinks: layout.stairLinks.map((l) => ({ ...l })),
    treeEdges: layout.treeEdges.map((e) => ({ ...e })),
    spawn: mapSpawn(f, layout.spawn),
    lotRect: lotRectOf(f),
    loopsAdded: layout.loopsAdded.map((l) => ({ ...l })),
    droppedModules: [...layout.droppedModules],
    transform: { rot: f.rot, mirrorX: f.mirrorX, dX: f.dX, dZ: f.dZ },
  };
}

/** 正準系の外接矩形（全室＋アプローチ） */
export function layoutBounds(layout: PlacedBuildingLayout): Rect {
  const rs = layout.rooms.map((r) => r.rect);
  const b = { ...(rs[0] as Rect) };
  for (const r of rs) {
    b.x0 = Math.min(b.x0, r.x0);
    b.z0 = Math.min(b.z0, r.z0);
    b.x1 = Math.max(b.x1, r.x1);
    b.z1 = Math.max(b.z1, r.z1);
  }
  return b;
}

/** 正準系で解決済みのレイアウトを、原点対称の敷地へ格子整数センタリングして 8 変換のいずれかを適用する。 */
export function applySiteTransform(
  layout: PlacedBuildingLayout,
  rot: OrthogonalRotation,
  mirrorX: boolean,
  snap: ModularSnap,
): PlacedBuildingLayout {
  const f = computeSiteFrame(layoutBounds(layout), layout.perimeterMargin, snap, rot, mirrorX);
  return transformLayoutWithFrame(layout, f);
}

/** 敷地変換の抽選（rotationsAllowed から 1 つ、mirrorAllowed なら 1/2 で反転） */
export function pickSiteTransform(
  rotationsAllowed: readonly OrthogonalRotation[],
  mirrorAllowed: boolean,
  next: () => number,
): { rot: OrthogonalRotation; mirrorX: boolean } {
  const rot = rotationsAllowed[Math.min(rotationsAllowed.length - 1, Math.floor(next() * rotationsAllowed.length))] ?? 0;
  return { rot, mirrorX: mirrorAllowed && next() < 0.5 };
}
