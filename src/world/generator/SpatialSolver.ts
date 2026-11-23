import type {
  ExteriorRequirement,
  ModularEdgeStyle,
  ModularFurnitureDef,
  ModularGeneratorTemplate,
  ModuleCategory,
  PlayerSpawn,
  RoofStyle,
  StairDef,
  StoryLevel,
  SubRoomSpec,
} from '../../core/types';
import {
  CirculationRules,
  FRONT_APPROACH_ID,
  OPENING_SIDE_PAD,
  RetryGeneration,
  levelLabel,
  type BuildingGraphPlan,
  type PlannedEdgeStyle,
  type PlannedModule,
  type StairCoreGeometry,
} from './GraphPlanner';
import {
  EPS,
  MAX_PLACEMENT_CANDIDATES_PER_MODULE,
  pickOpeningCenter,
  rectArea,
  rectsOverlap,
  sharedEdge,
  subtractRects,
  type Opening,
  type Rect,
  type SharedEdge,
} from './Layout';
import type { Rng } from './Rng';

/**
 * 空間ソルバー（docs/design/modular-map-generator.md §3.1 solveSpatialLayout / §3.2-1, 2）。
 * 正準座標系（南 +Z がアプローチ、1F の entry 南辺が z = 0）で、計画済みの全域木に沿って
 * モジュール矩形を格子スナップの辺接着で置き、包含・面積比率・非階段室存在を検査し、
 * サブ室分割（親辺・子木辺の再配線検証つき）、木開口、自然接触ペアからの閉路開口を確定する。
 * 再帰バックトラックはしない（各モジュール最大 MAX_PLACEMENT_CANDIDATES_PER_MODULE 候補）。
 * 不成立は RetryGeneration（WP-3 の試行ループが次の派生シードで作り直す）。
 */

export type RoomCategory = ModuleCategory | 'front_approach';
export type OpeningKind = 'front' | 'tree' | 'internal' | 'loop';

/** 方向（単位の基本ベクトル） */
export interface Dir2 {
  x: number;
  z: number;
}

export interface PlacedRoom {
  id: string;
  /** 計画上のモジュールインスタンス ID（サブ室は親モジュールの ID） */
  moduleId: string;
  moduleDefId: string;
  name: string;
  category: RoomCategory;
  level: StoryLevel;
  floorY: number;
  rect: Rect;
  outdoor: boolean;
  /** 最終 RoomDef の非窓開口次数が厳密に 1 */
  private: boolean;
  /** 実効の屋根様式（吹き抜けは 'double_height'） */
  roofStyle: RoofStyle;
  doubleHeight: boolean;
  spawnWeight: number;
  floorMaterial?: string;
  furniture: ModularFurnitureDef[];
  isSubRoom: boolean;
  exteriorRequirement: ExteriorRequirement;
  /** 階段コアの室なら `core<k>` */
  coreId?: string;
}

export interface PlacedOpening extends Opening {
  id: string;
  level: StoryLevel;
  floorY: number;
  roomA: string;
  roomB: string;
  style: ModularEdgeStyle;
  kind: OpeningKind;
  /** 開口端の壁余白（扉 door.margin / アーチ door.archMargin） */
  margin: number;
  /** 正面玄関扉と階段コアの木扉は常時不施錠 */
  alwaysUnlocked: boolean;
  /** 両開きドアか */
  double?: boolean;
}

const DOUBLE_DOOR_MODULE_IDS = new Set([
  'genkan',
  'security_lobby',
  'foyer',
  'ldk',
  'living',
  'reception_hall',
  'grand_hall',
  'conference',
  'ambassador_office',
  'consular',
]);

const DOUBLE_DOOR_CATEGORIES = new Set<RoomCategory>(['entry', 'living_hub']);

/** 両開きドアを優先適用する大型室の最小面積(m²) */
const DOUBLE_DOOR_MIN_ROOM_AREA = 48;

type DoorConfigWithDouble = ModularGeneratorTemplate['door'] & { doubleWidth?: number };

/** テンプレートの doubleWidth 設定を取得する（未設定なら undefined）。 */
export function templateDoubleDoorWidth(tpl: ModularGeneratorTemplate): number | undefined {
  const w = (tpl.door as DoorConfigWithDouble).doubleWidth;
  return typeof w === 'number' && Number.isFinite(w) && w > tpl.door.width + EPS ? w : undefined;
}

/** 玄関・大型共有室などの主要開口で両開きドアを優先するべきか判定する。 */
export function shouldPreferDoubleDoor(ra: PlacedRoom, rb: PlacedRoom, style: ModularEdgeStyle, kind: OpeningKind): boolean {
  if (style === 'arch') return false;
  if (kind === 'front') return true;
  if (ra.private || rb.private || ra.coreId !== undefined || rb.coreId !== undefined) return false;
  if (DOUBLE_DOOR_MODULE_IDS.has(ra.moduleDefId) || DOUBLE_DOOR_MODULE_IDS.has(rb.moduleDefId)) return true;
  if (DOUBLE_DOOR_CATEGORIES.has(ra.category) || DOUBLE_DOOR_CATEGORIES.has(rb.category)) return true;
  if (!ra.outdoor && rectArea(ra.rect) >= DOUBLE_DOOR_MIN_ROOM_AREA) return true;
  if (!rb.outdoor && rectArea(rb.rect) >= DOUBLE_DOOR_MIN_ROOM_AREA) return true;
  return false;
}

export interface PlacedStairFlight {
  id: string;
  def: StairDef;
  fromLevel: StoryLevel;
  toLevel: StoryLevel;
}

export interface StairHole {
  /** くり抜く床スラブの階 */
  level: StoryLevel;
  rect: Rect;
  /** 乗降接続辺の外向き方向（他の 3 辺は落下防止壁） */
  openDir: Dir2;
}

export interface LevelRect {
  level: StoryLevel;
  rect: Rect;
}

export interface PlacedStairCore {
  id: string;
  coreIndex: number;
  rect: Rect;
  inner: Rect;
  laneW: Rect;
  laneMid: Rect;
  laneE: Rect;
  flights: PlacedStairFlight[];
  holes: StairHole[];
  landings: LevelRect[];
  /** 扉を付けてはいけない室内側の領域（段・穴・仕切り・3 層時の 1F 北帯） */
  doorBlocked: LevelRect[];
  steps: number;
  rise: number;
  run: number;
  deltaHole: number;
  landingDepth: number;
}

export interface StairLink {
  coreId: string;
  flightId: string;
  lowerRoomId: string;
  upperRoomId: string;
}

export interface SiteTransformInfo {
  rot: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  /** 格子整数シフト量 */
  dX: number;
  dZ: number;
}

export interface PlacedBuildingLayout {
  templateId: string;
  profileId: string;
  levels: StoryLevel[];
  storyRise: number;
  snap: number;
  wallThickness: number;
  perimeterMargin: number;
  rooms: PlacedRoom[];
  openings: PlacedOpening[];
  stairCores: PlacedStairCore[];
  stairLinks: StairLink[];
  /** 実際に採用した全域木辺（モジュール ID。付け替え・脱落を反映。front_approach→entry と階段縦リンクを含む） */
  treeEdges: { a: string; b: string; style: PlannedEdgeStyle }[];
  approachRoomId: string;
  spawn: PlayerSpawn;
  /** 正準系では建物＋アプローチ＋外周余白の外接矩形、SiteTransform 後は原点対称の敷地 */
  lotRect: Rect;
  /** 階ごとに追加した閉路辺の数 */
  loopsAdded: { level: StoryLevel; count: number }[];
  /** 1F 屋内グラフのベッチ数 β1 */
  beta1F: number;
  droppedModules: string[];
  transform: SiteTransformInfo | null;
}

// ---------------------------------------------------------------- 小道具

/** 予定の親に貼れないとき試す別の親の数の上限 */
export const MAX_REPARENT_TRIES = 4;
export { OPENING_SIDE_PAD };

const ceilTo = (v: number, s: number): number => Math.ceil(v / s - 1e-9) * s;
const floorTo = (v: number, s: number): number => Math.floor(v / s + 1e-9) * s;
const roundTo = (v: number, s: number): number => Math.round(v / s) * s;

function snapRange(min: number, max: number, v: number, s: number): number {
  const lo = ceilTo(min, s);
  const hi = Math.max(lo, floorTo(max, s));
  return Math.min(hi, Math.max(lo, roundTo(v, s)));
}

function bbox(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const b = { ...rects[0] } as Rect;
  for (const r of rects) {
    b.x0 = Math.min(b.x0, r.x0);
    b.z0 = Math.min(b.z0, r.z0);
    b.x1 = Math.max(b.x1, r.x1);
    b.z1 = Math.max(b.z1, r.z1);
  }
  return b;
}

/** 0 < 隙間 < minGap の狭小な平行隙間があるか（角どうしの斜め隙間は対象外）。 */
export function hasNarrowGap(a: Rect, b: Rect, minGap: number): boolean {
  const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1);
  const dz = Math.max(a.z0 - b.z1, b.z0 - a.z1);
  if (dx > EPS && dz < -EPS) return dx < minGap - EPS;
  if (dz > EPS && dx < -EPS) return dz < minGap - EPS;
  return false;
}

/** r が cover（矩形和集合）に完全に含まれるか */
export function rectCoveredBy(r: Rect, cover: readonly Rect[]): boolean {
  return subtractRects(r, cover).length === 0;
}

/** 外周の露出長（同階の他室に接していない辺の長さ） */
function exposedLength(r: Rect, others: readonly Rect[], s: number): number {
  const strips: Rect[] = [
    { x0: r.x0, z0: r.z0 - s, x1: r.x1, z1: r.z0 },
    { x0: r.x0, z0: r.z1, x1: r.x1, z1: r.z1 + s },
    { x0: r.x0 - s, z0: r.z0, x1: r.x0, z1: r.z1 },
    { x0: r.x1, z0: r.z0, x1: r.x1 + s, z1: r.z1 },
  ];
  let len = 0;
  for (const st of strips) for (const p of subtractRects(st, others)) len += rectArea(p) / s;
  return len;
}

/** 区間列 a から [b0, b1] を差し引く */
export function subtractInterval(a: [number, number][], b0: number, b1: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [f0, f1] of a) {
    if (b1 <= f0 + EPS || b0 >= f1 - EPS) {
      out.push([f0, f1]);
      continue;
    }
    if (b0 > f0 + EPS) out.push([f0, b0]);
    if (b1 < f1 - EPS) out.push([b1, f1]);
  }
  return out;
}

// ---------------------------------------------------------------- 階段コア

export interface CoreParts {
  inner: Rect;
  laneW: Rect;
  laneMid: Rect;
  laneE: Rect;
  flights: { idSuffix: string; def: Omit<StairDef, 'id'>; fromLevel: StoryLevel; toLevel: StoryLevel }[];
  holes: StairHole[];
  landings: LevelRect[];
  doorBlocked: LevelRect[];
}

/**
 * 階段穴の非接続辺に立てる落下防止壁（厚さ t）の矩形（§3.2-3）。open 方向の辺は乗降口として開放し、
 * コア内壁面に一致する辺は既存の壁があるので立てない。ModularGenerator の壁生成と coreParts の doorBlocked・踊り場の共通の正本。
 */
export function stairHoleGuardRects(h: StairHole, inner: Rect, t: number): Rect[] {
  const H = h.rect;
  const out: Rect[] = [];
  if (!(h.openDir.z < 0) && Math.abs(H.z0 - inner.z0) > EPS) out.push({ x0: H.x0, z0: H.z0 - t, x1: H.x1, z1: H.z0 });
  if (!(h.openDir.z > 0) && Math.abs(H.z1 - inner.z1) > EPS) out.push({ x0: H.x0, z0: H.z1, x1: H.x1, z1: H.z1 + t });
  if (!(h.openDir.x < 0) && Math.abs(H.x0 - inner.x0) > EPS) out.push({ x0: H.x0 - t, z0: H.z0, x1: H.x0, z1: H.z1 });
  if (!(h.openDir.x > 0) && Math.abs(H.x1 - inner.x1) > EPS) out.push({ x0: H.x1, z0: H.z0, x1: H.x1 + t, z1: H.z1 });
  return out;
}

/**
 * コア外形矩形 R に対する局所幾何の配置（§3.2-3 の正準ドッグレッグ配置）。SpatialSolver と最小構成器（ModularGenerator）の共通の正本。
 * 落下防止壁は周囲に OPENING_SIDE_PAD を足して doorBlocked に含め（開口・扉回転域との非干渉）、踊り場からも除く（BL-01）。
 */
export function coreParts(R: Rect, g: StairCoreGeometry, storyRise: number): CoreParts {
  const X = (a: number): number => R.x0 + a;
  const Z = (b: number): number => R.z0 + b;
  const ix0 = X(g.laneW[0]);
  const ix1 = X(g.laneE[1]);
  const iz0 = Z(g.innerZ0);
  const iz1 = Z(g.innerZ1);
  const zF0 = Z(g.zF0);
  const zF1 = Z(g.zF1);
  const lane = (l: [number, number]): Rect => ({ x0: X(l[0]), z0: iz0, x1: X(l[1]), z1: iz1 });
  const laneW = lane(g.laneW);
  const laneMid = lane(g.laneMid);
  const laneE = lane(g.laneE);
  const inner: Rect = { x0: ix0, z0: iz0, x1: ix1, z1: iz1 };
  const d = g.deltaHole;
  const t = g.wallThickness;
  const flights: CoreParts['flights'] = [];
  const holes: StairHole[] = [];
  const landings: LevelRect[] = [];
  const doorBlocked: LevelRect[] = [];
  const band = (z0: number, z1: number): Rect => ({ x0: ix0, z0, x1: ix1, z1 });
  const mid: Rect = { x0: laneMid.x0, z0: zF0, x1: laneMid.x1, z1: zF1 };

  if (g.hasUpper) {
    // 西レーン 1F→2F（yaw 0 = -Z へ上る、上端 = zF0）
    flights.push({
      idSuffix: '1F_2F',
      def: { x: (laneW.x0 + laneW.x1) / 2, z: zF0 + g.flightLen / 2, yaw: 0, width: g.flightWidth, steps: g.steps, rise: g.rise, run: g.run, y: 0 },
      fromLevel: 0,
      toLevel: 1,
    });
    holes.push({ level: 1, rect: { x0: laneW.x0, z0: zF0, x1: laneW.x1, z1: zF1 + d }, openDir: { x: 0, z: -1 } });
    doorBlocked.push({ level: 0, rect: { x0: laneW.x0, z0: zF0, x1: laneW.x1, z1: zF0 + g.flightLen } });
    doorBlocked.push({ level: 1, rect: { x0: laneW.x0, z0: zF0, x1: laneW.x1, z1: zF1 + d } });
    doorBlocked.push({ level: 1, rect: mid });
    // 南踊り場は穴の南辺の落下防止壁（厚さ t）を除いた範囲
    landings.push({ level: 1, rect: band(iz0, zF0) }, { level: 1, rect: band(zF1 + d + t, iz1) });
  }
  if (g.hasBasement) {
    // 東レーン B1→1F（yaw 180 = +Z へ上る、上端 = zF1）
    flights.push({
      idSuffix: 'B1_1F',
      def: { x: (laneE.x0 + laneE.x1) / 2, z: zF1 - g.flightLen / 2, yaw: 180, width: g.flightWidth, steps: g.steps, rise: g.rise, run: g.run, y: -storyRise },
      fromLevel: -1,
      toLevel: 0,
    });
    holes.push({ level: 0, rect: { x0: laneE.x0, z0: zF0 - d, x1: laneE.x1, z1: zF1 }, openDir: { x: 0, z: 1 } });
    doorBlocked.push({ level: 0, rect: { x0: laneE.x0, z0: zF0 - d, x1: laneE.x1, z1: zF1 } });
    doorBlocked.push({ level: -1, rect: { x0: laneE.x0, z0: zF1 - g.flightLen, x1: laneE.x1, z1: zF1 } });
    doorBlocked.push({ level: -1, rect: mid });
    landings.push({ level: -1, rect: band(iz0, zF0) }, { level: -1, rect: band(zF1, iz1) });
  }
  doorBlocked.push({ level: 0, rect: mid });
  if (g.hasUpper && g.hasBasement) {
    // 3 層時の 1F 北帯は段と穴に挟まれ南踊り場と繋がらない → 扉を付けない
    doorBlocked.push({ level: 0, rect: band(iz0, zF0) });
    landings.push({ level: 0, rect: band(zF1, iz1) });
  } else {
    // 地下ありの 1F 北踊り場は穴の北辺の落下防止壁（厚さ t）を除いた範囲
    landings.push({ level: 0, rect: band(iz0, zF0 - (g.hasBasement ? d + t : 0)) }, { level: 0, rect: band(zF1, iz1) });
  }
  // 落下防止壁の周囲 OPENING_SIDE_PAD を扉禁止にする（壁端と開口・扉回転域の非干渉。ld が t/2 + OPENING_SIDE_PAD を見込むので
  // 残りの辺にも扉を置ける）
  const P = OPENING_SIDE_PAD;
  for (const h of holes) {
    for (const gr of stairHoleGuardRects(h, inner, t)) {
      doorBlocked.push({ level: h.level, rect: { x0: gr.x0 - P, z0: gr.z0 - P, x1: gr.x1 + P, z1: gr.z1 + P } });
    }
  }
  return { inner, laneW, laneMid, laneE, flights, holes, landings, doorBlocked };
}

/** コア室の辺上で扉を付けられる区間（室内側の奥行 depth の帯が doorBlocked と交わらない部分）。 */
export function coreEdgeIntervals(R: Rect, blocked: readonly Rect[], edge: SharedEdge, depth: number): [number, number][] {
  let free: [number, number][] = [[edge.lo, edge.hi]];
  let strip: Rect;
  if (edge.axis === 'x') {
    strip = Math.abs(edge.c - R.z0) < EPS ? { x0: R.x0, z0: R.z0, x1: R.x1, z1: R.z0 + depth } : { x0: R.x0, z0: R.z1 - depth, x1: R.x1, z1: R.z1 };
    for (const b of blocked) if (rectsOverlap(strip, b)) free = subtractInterval(free, b.x0, b.x1);
  } else {
    strip = Math.abs(edge.c - R.x0) < EPS ? { x0: R.x0, z0: R.z0, x1: R.x0 + depth, z1: R.z1 } : { x0: R.x1 - depth, z0: R.z0, x1: R.x1, z1: R.z1 };
    for (const b of blocked) if (rectsOverlap(strip, b)) free = subtractInterval(free, b.z0, b.z1);
  }
  return free;
}

// ---------------------------------------------------------------- 本体

interface Shape {
  rect: Rect;
  /** 階段コアの扉禁止領域（その階） */
  coreBlocked: Rect[] | null;
}

export function solveSpatialLayout(tpl: ModularGeneratorTemplate, plan: BuildingGraphPlan, rng: Rng): PlacedBuildingLayout {
  const s = tpl.snap;
  const t = tpl.wallThickness;
  const storyRise = plan.profile.storyRise;
  const floorYOf = (lv: StoryLevel): number => lv * storyRise;
  const rules = new CirculationRules(tpl);
  const g = plan.stairCore;
  const doorPassMin = tpl.door.width + t + 2 * tpl.door.margin;
  const archPassMin = tpl.door.width + t + 2 * tpl.door.archMargin;
  const needLen = (style: ModularEdgeStyle | 'stair'): number => (style === 'arch' ? archPassMin : doorPassMin);
  const accessDepth = tpl.door.width + t / 2;

  const placed = new Map<string, Rect>();
  const dropped = new Set<string>();
  const modById = new Map(plan.modules.map((m) => [m.id, m] as const));
  const coreRect = new Map<number, Rect>();
  const coreBlockedOf = (m: PlannedModule, R: Rect): Rect[] | null => {
    if (m.coreIndex === undefined || !g) return null;
    return coreParts(R, g, storyRise)
      .doorBlocked.filter((b) => b.level === m.level)
      .map((b) => b.rect);
  };
  const levelRects = (lv: StoryLevel): Rect[] => {
    const out: Rect[] = [];
    for (const [id, r] of placed) if ((modById.get(id) as PlannedModule).level === lv) out.push(r);
    return out;
  };

  /** 2 形状の共有辺のうち扉を置ける区間（コアは扉禁止領域を除く） */
  const usableEdges = (a: Shape, b: Shape): SharedEdge[] => {
    const e = sharedEdge(a.rect, b.rect);
    if (!e) return [];
    let iv: [number, number][] = [[e.lo, e.hi]];
    for (const sh of [a, b]) {
      if (!sh.coreBlocked) continue;
      const allowed = coreEdgeIntervals(sh.rect, sh.coreBlocked, e, accessDepth);
      const next: [number, number][] = [];
      for (const [p0, p1] of iv) {
        for (const [q0, q1] of allowed) {
          const lo = Math.max(p0, q0);
          const hi = Math.min(p1, q1);
          if (hi - lo > EPS) next.push([lo, hi]);
        }
      }
      iv = next;
    }
    return iv.map(([lo, hi]) => ({ axis: e.axis, c: e.c, lo, hi }));
  };
  const maxUsable = (a: Shape, b: Shape): number => usableEdges(a, b).reduce((m, e) => Math.max(m, e.hi - e.lo), 0);

  // 1F 確定後に使う集合
  const S1F: Rect[] = [];
  const F1F: Rect[] = [];
  const I1F: Rect[] = [];
  let levelSetsReady = false;
  const prepareLevelSets = (): void => {
    if (levelSetsReady) return;
    levelSetsReady = true;
    for (const [id, r] of placed) {
      const m = modById.get(id) as PlannedModule;
      if (m.level !== 0 || m.def.outdoor) continue;
      I1F.push(r);
      if (m.coreIndex !== undefined || (m.def.roofStyle === 'stackable' && !m.doubleHeight)) S1F.push(r);
      else if (m.def.roofStyle === 'flat_roof_only') F1F.push(r);
    }
  };

  const sampleSize = (m: PlannedModule, useMin: boolean): { w: number; d: number } => {
    if (m.coreIndex !== undefined && g) return { w: g.outerW, d: g.outerD };
    const { width, depth } = m.def;
    if (useMin) return { w: ceilTo(width.min, s), d: ceilTo(depth.min, s) };
    return { w: snapRange(width.min, width.max, rng.inRange(width), s), d: snapRange(depth.min, depth.max, rng.inRange(depth), s) };
  };

  const validCandidate = (m: PlannedModule, cand: Rect, parent: Shape, style: PlannedEdgeStyle): boolean => {
    const lv = m.level;
    const same = levelRects(lv);
    for (const r of same) {
      if (rectsOverlap(cand, r)) return false;
      if (hasNarrowGap(cand, r, tpl.minCourtGap)) return false;
    }
    if (lv === 0) {
      if (cand.z1 > EPS) return false;
      // 正面アプローチ帯（z >= 0、建物幅いっぱい）との狭小隙間を作らない
      if (cand.z1 < -EPS && cand.z1 > -tpl.minCourtGap + EPS) return false;
      if (m.def.exteriorRequirement === 'front_approach' && Math.abs(cand.z1) > EPS) return false;
      const b = bbox([...same, cand]) as Rect;
      if (b.x1 - b.x0 > tpl.maxFootprint.width + EPS || b.z1 - b.z0 > tpl.maxFootprint.depth + EPS) return false;
    } else if (lv === 1) {
      if (!rectCoveredBy(cand, m.def.outdoor ? [...S1F, ...F1F] : S1F)) return false;
    } else if (!rectCoveredBy(cand, I1F)) return false;
    const child: Shape = { rect: cand, coreBlocked: coreBlockedOf(m, cand) };
    return maxUsable(parent, child) >= needLen(style) - EPS;
  };

  /** 同階の既配置室（と上階・地下では支持側の 1F 室）の辺座標。整列位置の候補に使う */
  const alignCoords = (lv: StoryLevel): { xs: number[]; zs: number[] } => {
    const rs = [...levelRects(lv), ...(lv === 1 ? [...S1F, ...F1F] : lv === -1 ? I1F : [])];
    const xs = new Set<number>();
    const zs = new Set<number>();
    for (const r of rs) {
      xs.add(r.x0).add(r.x1);
      zs.add(r.z0).add(r.z1);
    }
    if (lv === 0) zs.add(0);
    return { xs: [...xs], zs: [...zs] };
  };

  /** 同階の室との接触長（閉路の材料が増える位置を優先する） */
  const contactLen = (c: Rect, lv: StoryLevel): number => {
    let len = 0;
    for (const r of levelRects(lv)) {
      const e = sharedEdge(c, r);
      if (e) len += e.hi - e.lo;
    }
    return len;
  };

  /**
   * 非 1F 階のコア群（その階の部屋が木で辿り着くコア番号）。2 コア時に同階の島を検出するのに使う。
   * parentOf は placeGlued より後に宣言されるが、呼び出しは配置ループ内（宣言後）なので参照できる。
   */
  const groupOf = (id: string): number | undefined => {
    let cur: string | undefined = id;
    for (let guard = 0; cur !== undefined && guard < 64; guard++) {
      const m = modById.get(cur);
      if (!m) return undefined;
      if (m.coreIndex !== undefined) return m.coreIndex;
      cur = parentOf.get(cur)?.id;
    }
    return undefined;
  };
  const groupOfParent = (P: Rect, lv: StoryLevel): number | undefined => {
    for (const [id, r] of placed) {
      if (r === P && (modById.get(id) as PlannedModule).level === lv) return groupOf(id);
    }
    return undefined;
  };
  const touchesOtherGroup = (c: Rect, lv: StoryLevel, group: number | undefined, need: number): boolean => {
    if (group === undefined || plan.coreCount < 2) return false;
    for (const [id, r] of placed) {
      const m = modById.get(id) as PlannedModule;
      if (m.level !== lv) continue;
      const g2 = groupOf(id);
      if (g2 === undefined || g2 === group) continue;
      const e = sharedEdge(c, r);
      if (e && e.hi - e.lo >= need - EPS) return true;
    }
    return false;
  };

  /**
   * 親の 4 辺に接着する候補を作って評価する。寸法の選択肢（抽選寸法・90° 回し・最小寸法・最小の 90° 回し）ごとに
   * 評価数を MAX_PLACEMENT_CANDIDATES_PER_MODULE / 選択肢数 で割り当て、整列位置（親の端・中央・既存室の辺）を先に評価する。
   */
  const placeGlued = (m: PlannedModule, parent: Shape, style: PlannedEdgeStyle): Rect | null => {
    const P = parent.rect;
    const need = needLen(style);
    const options: { w: number; d: number }[] = [];
    const pushOpt = (o: { w: number; d: number }): void => {
      if (!options.some((x) => x.w === o.w && x.d === o.d)) options.push(o);
    };
    const base = sampleSize(m, false);
    pushOpt(base);
    if (m.coreIndex === undefined) {
      pushOpt({ w: base.d, d: base.w });
      const mn = sampleSize(m, true);
      pushOpt(mn);
      pushOpt({ w: mn.d, d: mn.w });
    }
    const budget = Math.max(1, Math.floor(MAX_PLACEMENT_CANDIDATES_PER_MODULE / options.length));
    const { xs, zs } = alignCoords(m.level);
    for (const { w, d } of options) {
      const special: Rect[] = [];
      const general: Rect[] = [];
      // a0: 候補の始点座標（x0 または z0）の範囲 [lo, hi]
      const along = (p0: number, p1: number, size: number, coords: number[], make: (a: number) => Rect): void => {
        const lo = ceilTo(p0 - size + need, s);
        const hi = floorTo(p1 - need, s);
        if (hi < lo - EPS) return;
        const pref = new Set<number>([p0, p1 - size, roundTo((p0 + p1 - size) / 2, s)]);
        for (const c of coords) pref.add(c).add(c - size);
        for (const a of pref) if (a >= lo - EPS && a <= hi + EPS) special.push(make(roundTo(a, s)));
        for (let a = lo; a <= hi + EPS; a += s) if (!pref.has(roundTo(a, s))) general.push(make(roundTo(a, s)));
      };
      along(P.x0, P.x1, w, xs, (a) => ({ x0: a, z0: P.z0 - d, x1: a + w, z1: P.z0 })); // 北
      along(P.x0, P.x1, w, xs, (a) => ({ x0: a, z0: P.z1, x1: a + w, z1: P.z1 + d })); // 南
      along(P.z0, P.z1, d, zs, (a) => ({ x0: P.x0 - w, z0: a, x1: P.x0, z1: a + d })); // 西
      along(P.z0, P.z1, d, zs, (a) => ({ x0: P.x1, z0: a, x1: P.x1 + w, z1: a + d })); // 東
      rng.shuffle(special);
      rng.shuffle(general);
      let best: Rect | null = null;
      let bestScore = Infinity;
      for (const c of [...special, ...general].slice(0, budget)) {
        if (!validCandidate(m, c, parent, style)) continue;
        const contact = contactLen(c, m.level);
        let score: number;
        if (m.level === 0) {
          const b = bbox([...levelRects(0), c]) as Rect;
          score = (rectArea(b) * (1 + 0.3 * rng.next())) / (1 + 0.1 * contact);
        } else {
          score = rng.next() / (1 + 0.1 * contact);
          // 2 コア時: 別のコア由来の部屋群に扉が置けるほど接する位置を強く優先（同階が島に分かれないように）
          if (touchesOtherGroup(c, m.level, groupOfParent(parent.rect, m.level), need)) score *= 0.05;
        }
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (best) return best;
    }
    return null;
  };

  const drop = (m: PlannedModule, why: string): void => {
    if (m.required) throw new RetryGeneration(`${m.id}: ${why}`);
    dropped.add(m.id);
  };

  /** 実際に採用した木の親（予定の親に貼れないときは同階の別の親へ付け替える。入力の plan は書き換えない） */
  const parentOf = new Map<string, { id: string; style: PlannedEdgeStyle }>(
    plan.modules.map((m) => [m.id, { id: m.parentId, style: m.parentStyle }] as const),
  );

  // ---- 1) 辺接着配置（木の付け順 = 親が先）
  for (const m of plan.modules) {
    if (m.level !== 0) prepareLevelSets();
    if (m.coreIndex !== undefined && coreRect.has(m.coreIndex)) {
      const R = coreRect.get(m.coreIndex) as Rect;
      for (const r of levelRects(m.level)) if (rectsOverlap(R, r)) throw new RetryGeneration(`${m.id}: 階段コアが他室と重なります`);
      placed.set(m.id, R);
      continue;
    }
    if (m.parentId === FRONT_APPROACH_ID) {
      const { w, d } = sampleSize(m, false);
      const x0 = -floorTo(w / 2, s);
      placed.set(m.id, { x0, z0: -d, x1: x0 + w, z1: 0 });
      continue;
    }
    // 予定の親 → 同階の配置済みで規則上つなげる別の親（最大 MAX_REPARENT_TRIES 件）
    const parents: { pm: PlannedModule; style: PlannedEdgeStyle }[] = [];
    if (placed.has(m.parentId)) parents.push({ pm: modById.get(m.parentId) as PlannedModule, style: m.parentStyle });
    const alts: { pm: PlannedModule; style: PlannedEdgeStyle }[] = [];
    for (const x of plan.modules) {
      if (x.id === m.parentId || x.level !== m.level || !placed.has(x.id) || x.def.private) continue;
      const r = rules.rule(x.category, m.category);
      if (!r || (r.style === 'exterior_door' && !x.def.outdoor && !m.def.outdoor)) continue;
      alts.push({ pm: x, style: r.style });
    }
    parents.push(...rng.shuffle(alts).slice(0, MAX_REPARENT_TRIES));
    let R: Rect | null = null;
    for (const { pm, style } of parents) {
      const P = placed.get(pm.id) as Rect;
      R = placeGlued(m, { rect: P, coreBlocked: coreBlockedOf(pm, P) }, style);
      if (R) {
        parentOf.set(m.id, { id: pm.id, style });
        break;
      }
    }
    if (!R) {
      drop(m, placed.has(m.parentId) ? '辺接着の候補がありません' : '親モジュールが配置できませんでした');
      continue;
    }
    placed.set(m.id, R);
    if (m.coreIndex !== undefined) coreRect.set(m.coreIndex, R);
  }
  prepareLevelSets();

  const childrenOf = (id: string): PlannedModule[] => plan.modules.filter((x) => parentOf.get(x.id)?.id === id && placed.has(x.id));
  const isGeneral = (m: PlannedModule): boolean =>
    !m.def.outdoor && m.coreIndex === undefined && m.category !== 'corridor' && m.category !== 'entry';
  const levelIndoorArea = (lv: StoryLevel): number => {
    let a = 0;
    for (const [id, r] of placed) {
      const m = modById.get(id) as PlannedModule;
      if (m.level === lv && !m.def.outdoor) a += rectArea(r);
    }
    return a;
  };

  // ---- 2) 面積比率（超過は任意の葉を落として合わせる。不足は作り直し）
  const fitRatio = (lv: StoryLevel, base: number, range: { min: number; max: number }): void => {
    if (base <= EPS) throw new RetryGeneration(`${levelLabel(lv)}: 比率の基準面積が 0 です`);
    for (;;) {
      const ratio = levelIndoorArea(lv) / base;
      if (ratio < range.min - EPS) throw new RetryGeneration(`${levelLabel(lv)}: 面積比 ${ratio.toFixed(3)} < ${range.min}`);
      if (ratio <= range.max + EPS) return;
      const generals = plan.modules.filter((x) => x.level === lv && placed.has(x.id) && isGeneral(x));
      let bestId: string | null = null;
      let bestDist = Infinity;
      const mid = (range.min + range.max) / 2;
      for (const x of plan.modules) {
        if (x.level !== lv || !placed.has(x.id) || x.required || x.def.outdoor || childrenOf(x.id).length > 0) continue;
        if (isGeneral(x) && generals.length <= 1) continue;
        const after = (levelIndoorArea(lv) - rectArea(placed.get(x.id) as Rect)) / base;
        if (after < range.min - EPS) continue;
        const dist = Math.abs(after - mid);
        if (dist < bestDist) {
          bestDist = dist;
          bestId = x.id;
        }
      }
      if (!bestId) throw new RetryGeneration(`${levelLabel(lv)}: 面積比 ${ratio.toFixed(3)} > ${range.max}`);
      placed.delete(bestId);
      dropped.add(bestId);
    }
  };
  if (plan.levels.includes(1) && plan.profile.upperFloorRatio) {
    fitRatio(1, S1F.reduce((a, r) => a + rectArea(r), 0), plan.profile.upperFloorRatio);
  }
  if (plan.levels.includes(-1) && plan.profile.basementRatio) {
    fitRatio(-1, I1F.reduce((a, r) => a + rectArea(r), 0), plan.profile.basementRatio);
  }
  for (const lv of plan.levels) {
    if (lv === 0) continue;
    if (!plan.modules.some((x) => x.level === lv && placed.has(x.id) && isGeneral(x))) {
      throw new RetryGeneration(`${levelLabel(lv)}: 階段・廊下以外の屋内室がありません`);
    }
  }

  // ---- 3) 外周要件（any_exterior）
  for (const [id, r] of placed) {
    const m = modById.get(id) as PlannedModule;
    if (m.def.exteriorRequirement !== 'any_exterior') continue;
    const others = levelRects(m.level).filter((o) => o !== r);
    if (exposedLength(r, others, s) < doorPassMin - EPS) throw new RetryGeneration(`${id}: 外周に面していません`);
  }

  // ---- 4) 室の確定（アプローチ・コア・サブ室分割）
  const b1F = bbox(levelRects(0)) as Rect;
  const approachDepth = ceilTo(rng.inRange(tpl.site.approachDepth), s);
  const approach: PlacedRoom = {
    id: FRONT_APPROACH_ID,
    moduleId: FRONT_APPROACH_ID,
    moduleDefId: FRONT_APPROACH_ID,
    name: tpl.site.approachName,
    category: 'front_approach',
    level: 0,
    floorY: 0,
    rect: { x0: b1F.x0, z0: 0, x1: b1F.x1, z1: approachDepth },
    outdoor: true,
    private: false,
    roofStyle: 'open_sky',
    doubleHeight: false,
    spawnWeight: 0,
    furniture: tpl.site.approachFurniture,
    isSubRoom: false,
    exteriorRequirement: 'front_approach',
  };

  const roomsOf = new Map<string, PlacedRoom[]>();
  const shapeOf = (r: PlacedRoom): Shape => {
    if (!r.coreId) return { rect: r.rect, coreBlocked: null };
    const m = modById.get(r.moduleId) as PlannedModule;
    return { rect: r.rect, coreBlocked: coreBlockedOf(m, r.rect) };
  };
  const makeRoom = (m: PlannedModule, rect: Rect, sub?: SubRoomSpec): PlacedRoom => {
    const room: PlacedRoom = {
      id: sub ? `${m.id}_${sub.id}` : m.id,
      moduleId: m.id,
      moduleDefId: m.def.id,
      name: sub ? `${m.def.name} ${sub.name}` : m.def.name,
      category: m.category,
      level: m.level,
      floorY: floorYOf(m.level),
      rect,
      outdoor: m.def.outdoor,
      private: sub ? sub.private : m.def.private,
      roofStyle: m.doubleHeight ? 'double_height' : m.def.roofStyle,
      doubleHeight: m.doubleHeight,
      spawnWeight: sub ? sub.spawnWeight : m.def.spawnWeight,
      furniture: sub ? sub.furniture : m.def.furniture,
      isSubRoom: sub !== undefined,
      exteriorRequirement: m.def.exteriorRequirement,
    };
    const fm = sub?.floorMaterial ?? m.def.floorMaterial;
    if (fm !== undefined) room.floorMaterial = fm;
    if (m.coreIndex !== undefined) room.coreId = `core${m.coreIndex}`;
    return room;
  };
  for (const m of plan.modules) if (placed.has(m.id)) roomsOf.set(m.id, [makeRoom(m, placed.get(m.id) as Rect)]);

  /** 木辺の端（モジュール ID → 現在の候補室。分割済みなら非 private サブ室） */
  const endpointRooms = (id: string): PlacedRoom[] => {
    if (id === FRONT_APPROACH_ID) return [approach];
    const rs = roomsOf.get(id) ?? [];
    return rs.length > 1 ? rs.filter((r) => !r.private) : rs;
  };
  const incidentEdges = (m: PlannedModule): { other: string; style: ModularEdgeStyle }[] => {
    const out: { other: string; style: ModularEdgeStyle }[] = [];
    const p = parentOf.get(m.id) as { id: string; style: PlannedEdgeStyle };
    if (p.style !== 'stair') out.push({ other: p.id, style: p.style });
    for (const c of childrenOf(m.id)) {
      const cs = (parentOf.get(c.id) as { style: PlannedEdgeStyle }).style;
      if (cs !== 'stair') out.push({ other: c.id, style: cs });
    }
    return out;
  };
  const internalEdges: { a: PlacedRoom; b: PlacedRoom; style: ModularEdgeStyle }[] = [];

  for (const m of plan.modules) {
    if (!placed.has(m.id) || m.def.subRooms.length < 2 || m.def.private || m.def.outdoor || m.coreIndex !== undefined) continue;
    const R = placed.get(m.id) as Rect;
    const edges = incidentEdges(m);
    let accepted: { rooms: PlacedRoom[]; internal: { a: PlacedRoom; b: PlacedRoom; style: ModularEdgeStyle }[] } | null = null;
    for (const split of combSplits(R, m.def.subRooms, s, (st) => needLen(st), rng)) {
      const rooms = split.parts.map((p) => makeRoom(m, p.rect, p.spec));
      const open = rooms.filter((r) => !r.private);
      const ok = edges.every((e) =>
        endpointRooms(e.other).some((o) => open.some((r) => maxUsable(shapeOf(r), shapeOf(o)) >= needLen(e.style) - EPS)),
      );
      if (!ok) continue;
      const hub = rooms[split.hubIndex] as PlacedRoom;
      const internal: { a: PlacedRoom; b: PlacedRoom; style: ModularEdgeStyle }[] = [];
      rooms.forEach((r, j) => {
        if (j !== split.hubIndex) internal.push({ a: hub, b: r, style: (split.parts[j] as SplitPart).spec.connectStyle });
      });
      accepted = { rooms, internal };
      break;
    }
    if (accepted) {
      roomsOf.set(m.id, accepted.rooms);
      internalEdges.push(...accepted.internal);
    }
  }

  const rooms: PlacedRoom[] = [approach];
  for (const m of plan.modules) rooms.push(...(roomsOf.get(m.id) ?? []));
  const roomById = new Map(rooms.map((r) => [r.id, r] as const));
  const sameLevelRects = (lv: StoryLevel): Rect[] => rooms.filter((r) => r.level === lv).map((r) => r.rect);

  // ---- 5) 開口（正面扉 → 木辺 → サブ室内部 → 閉路）
  const openings: PlacedOpening[] = [];
  const connected = new Set<string>();
  const pairKey = (a: string, b: string): string => (a < b ? `${a}#${b}` : `${b}#${a}`);
  let exteriorDoors = 0;

  const doubleWidth = templateDoubleDoorWidth(tpl);
  const doublePassMin = doubleWidth !== undefined ? doubleWidth + t + 2 * tpl.door.margin : Infinity;

  const tryOpen = (ra: PlacedRoom, rb: PlacedRoom, style: ModularEdgeStyle, kind: OpeningKind, alwaysUnlocked: boolean): boolean => {
    const subs = usableEdges(shapeOf(ra), shapeOf(rb)).filter((e) => e.hi - e.lo >= needLen(style) - EPS);
    if (subs.length === 0) return false;
    rng.shuffle(subs);
    const lvRects = sameLevelRects(ra.level);
    const existing = openings.filter((o) => o.level === ra.level);
    const preferDouble = doubleWidth !== undefined && shouldPreferDoubleDoor(ra, rb, style, kind);
    for (const e of subs) {
      let width = tpl.door.width;
      let margin = tpl.door.margin;
      if (style === 'arch') {
        margin = tpl.door.archMargin;
        width = Math.min(tpl.door.archWidth, floorTo(e.hi - e.lo - t - 2 * margin, s));
        if (width < tpl.door.width - EPS) width = tpl.door.width;
      } else if (preferDouble && doubleWidth !== undefined && e.hi - e.lo >= doublePassMin - EPS) {
        const doubleCenter = pickOpeningCenter(rng, e, doubleWidth, margin, t, lvRects, existing, s);
        if (doubleCenter !== null) {
          openings.push({
            id: `op${openings.length}`,
            level: ra.level,
            floorY: ra.floorY,
            roomA: ra.id,
            roomB: rb.id,
            style,
            kind,
            margin,
            alwaysUnlocked,
            double: true,
            axis: e.axis,
            c: e.c,
            center: doubleCenter,
            width: doubleWidth,
          });
          connected.add(pairKey(ra.id, rb.id));
          if (style === 'exterior_door') exteriorDoors++;
          return true;
        }
      }
      const center = pickOpeningCenter(rng, e, width, margin, t, lvRects, existing, s);
      if (center === null) continue;
      openings.push({
        id: `op${openings.length}`,
        level: ra.level,
        floorY: ra.floorY,
        roomA: ra.id,
        roomB: rb.id,
        style,
        kind,
        margin,
        alwaysUnlocked,
        axis: e.axis,
        c: e.c,
        center,
        width,
      });
      connected.add(pairKey(ra.id, rb.id));
      if (style === 'exterior_door') exteriorDoors++;
      return true;
    }
    return false;
  };

  for (const m of plan.modules) {
    const par = parentOf.get(m.id) as { id: string; style: PlannedEdgeStyle };
    if (!placed.has(m.id) || par.style === 'stair') continue;
    const style = par.style;
    const kind: OpeningKind = par.id === FRONT_APPROACH_ID ? 'front' : 'tree';
    const pm = modById.get(par.id);
    const unlocked = kind === 'front' || m.coreIndex !== undefined || pm?.coreIndex !== undefined;
    const pairs: [PlacedRoom, PlacedRoom][] = [];
    for (const a of endpointRooms(par.id)) for (const b of endpointRooms(m.id)) pairs.push([a, b]);
    rng.shuffle(pairs);
    if (!pairs.some(([a, b]) => tryOpen(b, a, style, kind, unlocked))) throw new RetryGeneration(`${m.id}: 木辺の開口を置けません`);
  }
  for (const e of internalEdges) {
    if (!tryOpen(e.a, e.b, e.style, 'internal', false)) throw new RetryGeneration(`${e.a.moduleId}: サブ室間の開口を置けません`);
  }
  if (exteriorDoors > tpl.circulation.maxExteriorDoors) throw new RetryGeneration(`屋外扉 ${exteriorDoors} 枚が上限を超えます`);

  // 階段コアの行き止まり解消: 各階のコア室が開口を 1 つも持たない（2 コア時の 2F・B1 で木の子が付かなかった）ときは、
  // 同階の隣接室（private・アプローチ以外、規則あり）へ常時解錠の開口を足す。置けなければ作り直す
  for (const r of rooms) {
    if (!r.coreId || openings.some((o) => o.roomA === r.id || o.roomB === r.id)) continue;
    const nbrs = rooms.filter((o) => o !== r && o.level === r.level && !o.private && o.category !== 'front_approach');
    let ok = false;
    for (const o of rng.shuffle(nbrs)) {
      const rule = rules.rule(r.category as ModuleCategory, o.category as ModuleCategory);
      if (!rule || (rule.style === 'exterior_door' && !r.outdoor && !o.outdoor)) continue;
      if (rule.style === 'exterior_door' && exteriorDoors >= tpl.circulation.maxExteriorDoors) continue;
      if (tryOpen(r, o, rule.style, 'loop', true)) {
        ok = true;
        break;
      }
    }
    if (!ok) throw new RetryGeneration(`${r.id}: 階段コアに同階の開口を置けません（行き止まり）`);
  }

  // 閉路（自然接触ペア。private・アプローチは除外）
  const loopsAdded: { level: StoryLevel; count: number }[] = [];
  for (const lv of plan.levels) {
    const budget = lv === 0 ? plan.loopBudget1F : plan.loopBudgetOther;
    let added = 0;
    if (budget > 0) {
      const lvRooms = rooms.filter((r) => r.level === lv && !r.private && r.category !== 'front_approach');
      const cands: { a: PlacedRoom; b: PlacedRoom; style: ModularEdgeStyle; weight: number }[] = [];
      for (let i = 0; i < lvRooms.length; i++) {
        for (let j = i + 1; j < lvRooms.length; j++) {
          const a = lvRooms[i] as PlacedRoom;
          const b = lvRooms[j] as PlacedRoom;
          if (a.category === 'front_approach' || b.category === 'front_approach') continue;
          if (connected.has(pairKey(a.id, b.id))) continue;
          const r = rules.rule(a.category as ModuleCategory, b.category as ModuleCategory);
          if (!r) continue;
          if (r.style === 'exterior_door' && !a.outdoor && !b.outdoor) continue;
          if (maxUsable(shapeOf(a), shapeOf(b)) < needLen(r.style) - EPS) continue;
          cands.push({ a, b, style: r.style, weight: r.weight });
        }
      }
      while (added < budget && cands.length > 0) {
        const c = rng.weighted(cands, (x) => x.weight) as (typeof cands)[number];
        cands.splice(cands.indexOf(c), 1);
        if (c.style === 'exterior_door') {
          if (exteriorDoors >= tpl.circulation.maxExteriorDoors) continue;
          if (!rng.chance(tpl.circulation.secondaryExteriorDoorChance)) continue;
        }
        if (tryOpen(c.a, c.b, c.style, 'loop', false)) added++;
      }
    }
    loopsAdded.push({ level: lv, count: added });
  }

  // ---- 5b) 非 1F 階の同階連結: 2 コア時は各コアを根にした部分木が同じ階で島に分かれ得る（2F に上がった先が
  // 階段ごとに行き止まりになる）。実在の建物では同じ階の部屋は廊下で行き来できるので、島どうしの接触ペアに
  // 開口を足して 1 つの連結成分にする（同階が連結すれば 2 本の階段を介した上下階の周回路にもなる）。
  // 繋がらなければ作り直す
  const componentCount = (rs: readonly PlacedRoom[]): number => new Set(levelComponents(rs, openings).values()).size;
  /** 接触している島どうしに開口を足す。段階: 0 = 規則あり・private 除外 / 1 = private 含む / 2 = 規則未定義でも禁止でなければ通常扉 */
  const connectByContacts = (lvRooms: readonly PlacedRoom[]): void => {
    for (const stage of [0, 1, 2]) {
      if (componentCount(lvRooms) <= 1) return;
      const cands: { a: PlacedRoom; b: PlacedRoom; style: ModularEdgeStyle; weight: number }[] = [];
      for (let i = 0; i < lvRooms.length; i++) {
        for (let j = i + 1; j < lvRooms.length; j++) {
          const a = lvRooms[i] as PlacedRoom;
          const b = lvRooms[j] as PlacedRoom;
          if (stage === 0 && (a.private || b.private)) continue;
          const conn = bridgeStyle(a, b, stage === 2);
          if (!conn) continue;
          if (maxUsable(shapeOf(a), shapeOf(b)) < needLen(conn.style) - EPS) continue;
          cands.push({ a, b, ...conn });
        }
      }
      while (cands.length > 0) {
        const cur = levelComponents(lvRooms, openings);
        if (new Set(cur.values()).size <= 1) break;
        const bridging = cands.filter((c) => cur.get(c.a.id) !== cur.get(c.b.id));
        if (bridging.length === 0) break;
        const c = rng.weighted(bridging, (x) => x.weight) as (typeof cands)[number];
        cands.splice(cands.indexOf(c), 1);
        if (c.style === 'exterior_door' && exteriorDoors >= tpl.circulation.maxExteriorDoors) continue;
        // 同階の連結を担う通路なので施錠しない（行き止まりの島を作らない）
        tryOpen(c.a, c.b, c.style, 'loop', true);
      }
    }
  };
  /** 2 室を結ぶ開口様式（規則優先。lenient のときは規則未定義でも禁止でなければ通常扉 / 屋外側は屋外扉） */
  function bridgeStyle(a: PlacedRoom, b: PlacedRoom, lenient: boolean): { style: ModularEdgeStyle; weight: number } | null {
    const ca = a.category as ModuleCategory;
    const cb = b.category as ModuleCategory;
    const r = rules.rule(ca, cb);
    let style: ModularEdgeStyle;
    let weight: number;
    if (r) {
      style = r.style;
      weight = r.weight;
    } else {
      if (!lenient || rules.isForbidden(ca, cb)) return null;
      style = a.outdoor || b.outdoor ? 'exterior_door' : 'door';
      weight = 1;
    }
    if (style === 'exterior_door' && !a.outdoor && !b.outdoor) return null;
    return { style, weight };
  }

  /**
   * 接していない島の間に「渡り廊下」（テンプレートの corridor モジュール）を差し込む。2 室が x または z 方向に離れて
   * 向かい合い、対向区間が扉幅以上あるとき、その隙間を埋める矩形が同階の他室と重ならず支持床（2F は S_1F、B1 は I_1F）に
   * 収まれば採用し、両端に常時解錠の開口を置く。置けたら true
   */
  let bridgeSeq = 0;
  const insertBridge = (lv: StoryLevel, lvRooms: PlacedRoom[]): boolean => {
    const def = tpl.modules.find((d) => d.category === 'corridor' && !d.outdoor && d.allowedLevels.includes(lv));
    if (!def) return false;
    const support = lv === 1 ? S1F : I1F;
    const comp = levelComponents(lvRooms, openings);
    const minW = ceilTo(doorPassMin, s);
    const maxW = Math.max(minW, floorTo(def.width.min, s));
    const maxLen = def.depth.max;
    const cands: { rect: Rect; a: PlacedRoom; b: PlacedRoom; len: number }[] = [];
    for (const a of lvRooms) {
      for (const b of lvRooms) {
        if (a === b || comp.get(a.id) === comp.get(b.id) || a.outdoor || b.outdoor) continue;
        const A = a.rect;
        const B = b.rect;
        // x 方向: a の東辺 → b の西辺（z の対向区間に幅 w の廊下）
        const tryAxis = (gap0: number, gap1: number, lo: number, hi: number, make: (g0: number, g1: number, p0: number, p1: number) => Rect): void => {
          const len = gap1 - gap0;
          if (len < s - EPS || len > maxLen + EPS) return;
          const span = hi - lo;
          if (span < minW - EPS) return;
          const w = Math.min(maxW, floorTo(span, s));
          for (const p0 of new Set([roundTo(lo, s), roundTo(hi - w, s), roundTo((lo + hi - w) / 2, s)])) {
            if (p0 < lo - EPS || p0 + w > hi + EPS) continue;
            cands.push({ rect: make(gap0, gap1, p0, p0 + w), a, b, len });
          }
        };
        if (B.x0 >= A.x1 - EPS) {
          tryAxis(A.x1, B.x0, Math.max(A.z0, B.z0), Math.min(A.z1, B.z1), (g0, g1, p0, p1) => ({ x0: g0, z0: p0, x1: g1, z1: p1 }));
        }
        if (B.z0 >= A.z1 - EPS) {
          tryAxis(A.z1, B.z0, Math.max(A.x0, B.x0), Math.min(A.x1, B.x1), (g0, g1, p0, p1) => ({ x0: p0, z0: g0, x1: p1, z1: g1 }));
        }
      }
    }
    // 短い渡り廊下から試す（同じ長さは乱順）
    rng.shuffle(cands);
    cands.sort((x, y) => x.len - y.len);
    for (const c of cands) {
      if (!rectCoveredBy(c.rect, support)) continue;
      if (lvRooms.some((r) => r !== c.a && r !== c.b && (rectsOverlap(c.rect, r.rect) || hasNarrowGap(c.rect, r.rect, tpl.minCourtGap)))) continue;
      if (rooms.some((r) => r.level === lv && rectsOverlap(c.rect, r.rect))) continue;
      const id = `bridge_${levelLabel(lv)}_${bridgeSeq}`;
      const m: PlannedModule = {
        id,
        def,
        level: lv,
        category: def.category,
        doubleHeight: false,
        required: false,
        parentId: c.a.moduleId,
        parentStyle: 'door',
      };
      const room = makeRoom(m, c.rect);
      room.name = `渡り${def.name}`;
      const sa = bridgeStyle(room, c.a, true);
      const sb = bridgeStyle(room, c.b, true);
      if (!sa || !sb) continue;
      const before = openings.length;
      rooms.push(room);
      if (tryOpen(room, c.a, sa.style, 'loop', true) && tryOpen(room, c.b, sb.style, 'loop', true)) {
        bridgeSeq++;
        modById.set(id, m);
        roomById.set(id, room);
        lvRooms.push(room);
        return true;
      }
      rooms.pop();
      openings.length = before;
    }
    return false;
  };

  for (const lv of plan.levels) {
    if (lv === 0) continue;
    const lvRooms = rooms.filter((r) => r.level === lv);
    connectByContacts(lvRooms);
    for (let k = 0; k < 4 && componentCount(lvRooms) > 1; k++) {
      if (!insertBridge(lv, lvRooms)) break;
      connectByContacts(lvRooms);
    }
    if (componentCount(lvRooms) > 1) {
      throw new RetryGeneration(`${levelLabel(lv)}: 同じ階の部屋が島に分かれて連結できません`);
    }
  }

  // ---- 5c) 非 1F 階の閉路数（loopCountOther.min）。屋内室が 4 室以上の階だけ要求する（1F と同じ扱い）。
  // 階段コアが 2 つあり同階が連結済み（5b）なら、2 本の階段を介した上下階の周回路がその階を通るので満たしたとみなす
  if (tpl.circulation.loopCountOther.min > 0 && plan.coreCount < 2) {
    for (const lv of plan.levels) {
      if (lv === 0) continue;
      const v = rooms.filter((r) => r.level === lv && !r.outdoor).length;
      if (v < 4) continue;
      const beta = levelBetti(rooms, openings, lv);
      if (beta < tpl.circulation.loopCountOther.min) {
        throw new RetryGeneration(`${levelLabel(lv)} の閉路数 ${beta} < loopCountOther.min ${tpl.circulation.loopCountOther.min}`);
      }
    }
  }

  // ---- 6) 1F の閉路数 β1（施錠扉も蹴破りで通れるので物理到達辺に含める）
  const beta1F = levelBetti(rooms, openings, 0);
  const v1F = rooms.filter((r) => r.level === 0 && !r.outdoor).length;
  if (v1F >= 4 && beta1F < tpl.circulation.loopCount1F.min) {
    throw new RetryGeneration(`1F の閉路数 ${beta1F} < loopCount1F.min ${tpl.circulation.loopCount1F.min}`);
  }

  // ---- 7) 階段コア・縦リンク
  const stairCores: PlacedStairCore[] = [];
  const stairLinks: StairLink[] = [];
  if (g) {
    for (const [k, R] of coreRect) {
      const parts = coreParts(R, g, storyRise);
      const id = `core${k}`;
      const flights: PlacedStairFlight[] = parts.flights.map((f) => ({
        id: `${id}_${f.idSuffix}`,
        def: { id: `${id}_${f.idSuffix}`, ...f.def },
        fromLevel: f.fromLevel,
        toLevel: f.toLevel,
      }));
      stairCores.push({
        id,
        coreIndex: k,
        rect: { ...R },
        inner: parts.inner,
        laneW: parts.laneW,
        laneMid: parts.laneMid,
        laneE: parts.laneE,
        flights,
        holes: parts.holes,
        landings: parts.landings,
        doorBlocked: parts.doorBlocked,
        steps: g.steps,
        rise: g.rise,
        run: g.run,
        deltaHole: g.deltaHole,
        landingDepth: g.landingDepth,
      });
      for (const f of flights) {
        const lower = `${id}_${levelLabel(f.fromLevel)}`;
        const upper = `${id}_${levelLabel(f.toLevel)}`;
        if (!roomById.has(lower) || !roomById.has(upper)) throw new RetryGeneration(`${f.id}: 階段の上下の室がありません`);
        stairLinks.push({ coreId: id, flightId: f.id, lowerRoomId: lower, upperRoomId: upper });
      }
    }
  }

  // ---- 8) スポーン・敷地外接
  const front = openings.find((o) => o.kind === 'front') as PlacedOpening;
  const spawn: PlayerSpawn = { x: front.center, y: 0, z: Math.max(approachDepth / 2, approachDepth - tpl.site.spawnSetback), yaw: 0 };
  const all = bbox(rooms.map((r) => r.rect)) as Rect;
  const pm = ceilTo(tpl.site.perimeterMargin, s);
  const lotRect: Rect = { x0: all.x0 - pm, z0: all.z0 - pm, x1: all.x1 + pm, z1: all.z1 + pm };

  return {
    templateId: tpl.id,
    profileId: plan.profile.id,
    levels: [...plan.levels],
    storyRise,
    snap: s,
    wallThickness: t,
    perimeterMargin: tpl.site.perimeterMargin,
    rooms,
    openings,
    stairCores,
    stairLinks,
    treeEdges: plan.modules
      .filter((m) => placed.has(m.id))
      .map((m) => {
        const p = parentOf.get(m.id) as { id: string; style: PlannedEdgeStyle };
        return { a: p.id, b: m.id, style: p.style };
      }),
    approachRoomId: FRONT_APPROACH_ID,
    spawn,
    lotRect,
    loopsAdded,
    beta1F,
    droppedModules: [...dropped],
    transform: null,
  };
}

/** 同階の室（屋外テラス含む）の連結成分。室 ID → 成分代表 ID */
function levelComponents(lvRooms: readonly PlacedRoom[], openings: readonly PlacedOpening[]): Map<string, string> {
  const parent = new Map(lvRooms.map((r) => [r.id, r.id] as const));
  const find = (x: string): string => {
    let p = parent.get(x) as string;
    while (p !== x) {
      const g = parent.get(p) as string;
      parent.set(x, g);
      x = p;
      p = parent.get(x) as string;
    }
    return x;
  };
  for (const o of openings) {
    if (!parent.has(o.roomA) || !parent.has(o.roomB)) continue;
    const ra = find(o.roomA);
    const rb = find(o.roomB);
    if (ra !== rb) parent.set(ra, rb);
  }
  const out = new Map<string, string>();
  for (const r of lvRooms) out.set(r.id, find(r.id));
  return out;
}

/** 指定階の屋内室グラフのベッチ数 β1 = |E| - |V| + C */
export function levelBetti(rooms: readonly PlacedRoom[], openings: readonly PlacedOpening[], level: StoryLevel): number {
  const vs = rooms.filter((r) => r.level === level && !r.outdoor);
  const idx = new Map(vs.map((r, i) => [r.id, i] as const));
  const parent = vs.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number;
      i = parent[i] as number;
    }
    return i;
  };
  let e = 0;
  for (const o of openings) {
    const a = idx.get(o.roomA);
    const b = idx.get(o.roomB);
    if (a === undefined || b === undefined) continue;
    e++;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  let c = 0;
  for (let i = 0; i < vs.length; i++) if (find(i) === i) c++;
  return e - vs.length + c;
}

// ---------------------------------------------------------------- サブ室分割

interface SplitPart {
  spec: SubRoomSpec;
  rect: Rect;
}

interface SplitCandidate {
  parts: SplitPart[];
  hubIndex: number;
}

/**
 * 櫛形分割の候補（最大 4 通り）。最大 shareWeight の非 private サブ室を一辺沿いの帯（ハブ）にし、
 * 残りを直交方向に並べて全員をハブに接させる（private は内部葉 = 次数 1）。
 * 各サブ室の短辺は max(minSide, 開口に要る長さ) 以上、境界はすべて snap 格子上。
 */
function combSplits(
  R: Rect,
  specs: readonly SubRoomSpec[],
  s: number,
  need: (style: 'door' | 'arch') => number,
  rng: Rng,
): SplitCandidate[] {
  const hub = specs.filter((x) => !x.private).reduce<SubRoomSpec | null>((b, x) => (!b || x.shareWeight > b.shareWeight ? x : b), null);
  if (!hub || specs.length < 2) return [];
  const others = rng.shuffle(specs.filter((x) => x !== hub));
  const minSideOf = (x: SubRoomSpec): number => ceilTo(Math.max(x.minSide, need(x.connectStyle), need('door')), s);
  const total = specs.reduce((a, x) => a + x.shareWeight, 0);
  const sumO = others.reduce((a, x) => a + x.shareWeight, 0);
  const maxOtherMin = Math.max(...others.map(minSideOf));
  const out: SplitCandidate[] = [];
  for (const side of rng.shuffle(['N', 'S', 'E', 'W'] as const)) {
    const alongX = side === 'N' || side === 'S';
    const L = alongX ? R.x1 - R.x0 : R.z1 - R.z0;
    const Dp = alongX ? R.z1 - R.z0 : R.x1 - R.x0;
    const hubMin = minSideOf(hub);
    const hubDepth = Math.min(Math.max(roundTo((Dp * hub.shareWeight) / total, s), hubMin), Dp - maxOtherMin);
    if (hubDepth < hubMin - EPS || Dp - hubDepth < maxOtherMin - EPS) continue;
    const widths: number[] = [];
    let used = 0;
    let ok = true;
    for (let i = 0; i < others.length; i++) {
      const o = others[i] as SubRoomSpec;
      const restMin = others.slice(i + 1).reduce((a, x) => a + minSideOf(x), 0);
      let w = i === others.length - 1 ? L - used : Math.max(minSideOf(o), roundTo((L * o.shareWeight) / sumO, s));
      if (i < others.length - 1) w = Math.min(w, L - used - restMin);
      if (w < minSideOf(o) - EPS) {
        ok = false;
        break;
      }
      widths.push(w);
      used += w;
    }
    if (!ok) continue;
    const parts: SplitPart[] = [];
    let hubRect: Rect;
    let band: Rect;
    if (side === 'N') {
      hubRect = { x0: R.x0, z0: R.z0, x1: R.x1, z1: R.z0 + hubDepth };
      band = { x0: R.x0, z0: R.z0 + hubDepth, x1: R.x1, z1: R.z1 };
    } else if (side === 'S') {
      hubRect = { x0: R.x0, z0: R.z1 - hubDepth, x1: R.x1, z1: R.z1 };
      band = { x0: R.x0, z0: R.z0, x1: R.x1, z1: R.z1 - hubDepth };
    } else if (side === 'W') {
      hubRect = { x0: R.x0, z0: R.z0, x1: R.x0 + hubDepth, z1: R.z1 };
      band = { x0: R.x0 + hubDepth, z0: R.z0, x1: R.x1, z1: R.z1 };
    } else {
      hubRect = { x0: R.x1 - hubDepth, z0: R.z0, x1: R.x1, z1: R.z1 };
      band = { x0: R.x0, z0: R.z0, x1: R.x1 - hubDepth, z1: R.z1 };
    }
    parts.push({ spec: hub, rect: hubRect });
    let cur = alongX ? band.x0 : band.z0;
    others.forEach((o, i) => {
      const w = widths[i] as number;
      const rect = alongX ? { x0: cur, z0: band.z0, x1: cur + w, z1: band.z1 } : { x0: band.x0, z0: cur, x1: band.x1, z1: cur + w };
      parts.push({ spec: o, rect });
      cur += w;
    });
    out.push({ parts, hubIndex: 0 });
  }
  return out;
}
