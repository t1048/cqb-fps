import type {
  AllyDef,
  ArchitecturalModuleDef,
  BoxDef,
  DoorDef,
  EntityDef,
  GeneratedMapRaw,
  ModularEdgeStyle,
  ModularGeneratorTemplate,
  OrthogonalRotation,
  RoomDef,
  StairDef,
  StoryLevel,
  StoryProfileDef,
  WindowDef,
} from '../../core/types';
import { DataError } from '../../core/DataError';
import { missionRoster } from '../../rules/MissionRoster';
import {
  CirculationRules,
  FRONT_APPROACH_ID,
  MAX_PLANNED_MODULES,
  RetryGeneration,
  computeStairCoreGeometry,
  levelLabel,
  pickStoryProfile,
  planStoriesAndGraph,
  type PlannedEdgeStyle,
} from './GraphPlanner';
import {
  EPS,
  MAX_ENTITY_TRIES,
  MAX_FURNITURE_TRIES,
  buildWalls,
  inset,
  pickOpeningCenter,
  rectArea,
  rectsOverlap,
  round3,
  sharedEdge,
  subtractRects,
  type Opening,
  type Rect,
} from './Layout';
import { PlacementGrid } from './Placement';
import { Rng, normalizeSeed } from './Rng';
import {
  computeSiteFrame,
  layoutBounds,
  lotSize,
  mapBox,
  mapDoor,
  mapFacing,
  mapPoint,
  mapSpawn,
  mapStair,
  mapWindow,
  pickSiteTransform,
  swapsAxes,
  transformLayoutWithFrame,
  type SiteFrame,
} from './SiteTransform';
import {
  OPENING_SIDE_PAD,
  coreEdgeIntervals,
  coreParts,
  levelBetti,
  rectCoveredBy,
  shouldPreferDoubleDoor,
  solveSpatialLayout,
  stairHoleGuardRects,
  subtractInterval,
  templateDoubleDoorWidth,
  type PlacedBuildingLayout,
  type PlacedOpening,
  type PlacedRoom,
  type PlacedStairCore,
  type PlacedStairFlight,
  type RoomCategory,
  type StairLink,
} from './SpatialSolver';

/**
 * モジュラー統合コンパイラ（docs/design/modular-map-generator.md §3.1 generateModularMap / §3.2-3, 4, 5 / §8.2）。
 * - 通常試行: GraphPlanner → SpatialSolver（正準系）→ 本ファイルのコンパイル（壁・垂れ壁・扉・外窓・床スラブ・
 *   掃引後退付き 2 レーン階段・落下防止壁・家具・人物）→ SiteTransform の 8 変換で全データを写す。
 * - 最終試行（attempt === maxAttempts - 1）: 選択済みの階層プロファイルを降格せず、決定論的最小構成器
 *   buildSafeMinimalModularLayout の正準レイアウトを同じコンパイル工程に通す。
 * - verifyFallbackFeasibility: 重み > 0 の全プロファイルで最小構成器を実行し、不成立なら DataError
 *   （FallbackInfeasibleError は DataError の派生。DataError は依存のない core/DataError.ts にあり循環 import しない）。
 * Three.js は使わず、乱数は引数のシードからの Rng のみ（Math.random・時刻を参照しない）。
 */

/** 屋内家具の壁面からの内側余白(m)（壁厚の半分に足す） */
const INDOOR_FURNITURE_INSET = 0.04;
/** 屋外区画の家具の外周余白(m) */
const OUTDOOR_FURNITURE_INSET = 0.35;
/** 人物の配置域を壁面から離す余白(m)（clearance に足す） */
const ENTITY_WALL_PAD = 0.05;
/** 隊員・スポーンを屋外区画の外周から離す余白(m) */
const ALLY_EDGE_PAD = 0.5;
/** 隊員の初期位置の周囲に置く遮蔽物禁止域の半幅(m)（人体半径 0.30 + 余白 0.15。INV-11） */
const ALLY_KEEPOUT_HALF = 0.45;
/** 人質（民間人）を容疑者の近くに置くときの距離帯(m) */
const HOSTAGE_NEAR = { min: 1.2, max: 2.6 };
/** 人物の向きの揺らぎ(deg) */
const FACING_JITTER = 15;
/** フォールバック補填の室内格子点ピッチの下限(m)（§3.2-5: max(snap, 0.50)） */
const LATTICE_MIN_PITCH = 0.5;
/** 最小構成器の扉位置を決める固定シード（テンプレートごとに決定論的） */
const FALLBACK_LAYOUT_SEED = 0x2545f491;
/** verifyFallbackFeasibility の家具・人物の検証用シード */
const FALLBACK_VERIFY_SEED = 0x6c8e9cf5;
/** 階層プロファイル・敷地変換の抽選に使う派生シードの xor 値（試行ごとの派生シードと系列を分ける） */
const SELECTION_SEED_XOR = 0x51ed270b;
/**
 * SWAT 隊員 NPC。人数は missionRoster（プレイヤー込み合計 − 1）。
 * side はスポーン左右、back はさらに後方へのずらし（m）。
 */
const ALLY_SLOTS: readonly { id: string; name: string; side: number; back: number }[] = [
  { id: 'ally_miller', name: 'Miller', side: -1, back: 0 },
  { id: 'ally_cole', name: 'Cole', side: 1, back: 0 },
  { id: 'ally_reed', name: 'Reed', side: -2, back: 0.4 },
  { id: 'ally_diaz', name: 'Diaz', side: 2, back: 0.4 },
  { id: 'ally_park', name: 'Park', side: 0, back: 0.9 },
];

/**
 * フォールバック構成が不成立（verifyFallbackFeasibility / 最終試行）。DataError の派生なので
 * verifyFallbackFeasibility・generateMap の直接呼び出しでも `instanceof DataError` が成り立つ（§3.1 / BC-11）。
 */
export class FallbackInfeasibleError extends DataError {
  constructor(
    public readonly templateId: string,
    public readonly profileId: string,
    reason: string,
  ) {
    super(`generator:${templateId}`, `storyProfiles(${profileId})`, `template "${templateId}" profile "${profileId}": 最小構成が成立しません (${reason})`);
    this.name = 'FallbackInfeasibleError';
  }
}

// ---------------------------------------------------------------- メタデータ（検査用）

export interface ModularRoomMeta {
  moduleId: string;
  moduleDefId: string;
  category: RoomCategory;
  isPrivate: boolean;
  storyLevel: StoryLevel;
  floorY: number;
  outdoor: boolean;
  isSubRoom: boolean;
  roofStyle: string;
  doubleHeight: boolean;
  coreId?: string;
}

export interface ModularOpeningMeta {
  id: string;
  roomA: string;
  roomB: string;
  style: ModularEdgeStyle;
  kind: PlacedOpening['kind'];
  level: StoryLevel;
  floorY: number;
  /** 扉なら DoorDef.id（アーチは undefined） */
  doorId?: string;
  locked: boolean;
  alwaysUnlocked: boolean;
  /** 開口下端の階内高さ(m)（扉は min(doorLeafHeight, storyHeight)、アーチは archHeight） */
  lintelY: number;
  width: number;
  margin: number;
  /** 変換後の座標（axis 'x' は z = c 一定の線上で center が x） */
  axis: 'x' | 'z';
  c: number;
  center: number;
}

export interface ModularWindowMeta {
  roomId: string;
  level: StoryLevel;
  axis: 'x' | 'z';
  c: number;
  center: number;
  width: number;
}

export interface ModularGenerationMeta {
  roomMeta: Record<string, ModularRoomMeta>;
  usedFallback: boolean;
  attemptsUsed: number;
  selectedProfileId: string;
  appliedRotation: OrthogonalRotation;
  appliedMirrorX: boolean;
  /** 試行ごとの作り直し理由（RetryGeneration のメッセージ） */
  retryReasons: string[];
  storyRise: number;
  slabThickness: number;
  storyClearance: number;
  doorLintelY: number;
  archLintelY: number;
  openings: ModularOpeningMeta[];
  windows: ModularWindowMeta[];
  stairLinks: StairLink[];
  /** 落下防止壁（階段穴・テラス腰壁）。map.walls にも含まれる */
  guardWalls: BoxDef[];
  /** 変換後のレイアウト */
  layout: PlacedBuildingLayout;
  /** 正準系のレイアウト（変換前） */
  canonicalLayout: PlacedBuildingLayout;
  frame: SiteFrame;
}

export interface ModularGenerationResult {
  map: GeneratedMapRaw;
  meta: ModularGenerationMeta;
}

// ---------------------------------------------------------------- 小道具

const ceilTo = (v: number, s: number): number => Math.ceil(v / s - 1e-9) * s;
const floorTo = (v: number, s: number): number => Math.floor(v / s + 1e-9) * s;

function snapRange(min: number, max: number, v: number, s: number): number {
  const lo = ceilTo(min, s);
  const hi = Math.max(lo, floorTo(max, s));
  return Math.min(hi, Math.max(lo, Math.round(v / s) * s));
}

function bboxOf(rects: readonly Rect[]): Rect {
  const b = { ...rects[0] } as Rect;
  for (const r of rects) {
    b.x0 = Math.min(b.x0, r.x0);
    b.z0 = Math.min(b.z0, r.z0);
    b.x1 = Math.max(b.x1, r.x1);
    b.z1 = Math.max(b.z1, r.z1);
  }
  return b;
}

const floorYOf = (lv: StoryLevel, storyRise: number): number => lv * storyRise;

/** 開口線上の点（axis 'x' は (center, c)、'z' は (c, center)） */
function openingPoint(o: { axis: 'x' | 'z'; c: number; center: number }): { x: number; z: number } {
  return o.axis === 'x' ? { x: o.center, z: o.c } : { x: o.c, z: o.center };
}

/** 開口の両側（または片側）の奥行 depth・半幅 half の矩形 */
function openingStrip(o: { axis: 'x' | 'z'; c: number; center: number }, half: number, d0: number, d1: number): Rect {
  return o.axis === 'x'
    ? { x0: o.center - half, x1: o.center + half, z0: o.c + d0, z1: o.c + d1 }
    : { x0: o.c + d0, x1: o.c + d1, z0: o.center - half, z1: o.center + half };
}

// ---------------------------------------------------------------- コンパイル（正準系 → 8 変換）

interface CompileOptions {
  fallback: boolean;
  /** 家具・外窓を置かない（最小構成器の人物同時配置の保証用。keepOut が乱数に依存しない） */
  bare: boolean;
  attemptsUsed: number;
  retryReasons: string[];
}

interface CompileContext {
  tpl: ModularGeneratorTemplate;
  profile: StoryProfileDef;
  layout: PlacedBuildingLayout;
  frame: SiteFrame;
  doorLeafHeight: number;
  mapId: string;
  seed: number;
}

/** 正準系の敷地（変換後の原点対称敷地を逆写像した矩形） */
function canonicalLot(f: SiteFrame): Rect {
  const s = f.snap;
  return { x0: (-f.halfW - f.dX) * s, z0: (-f.halfD - f.dZ) * s, x1: (f.halfW - f.dX) * s, z1: (f.halfD - f.dZ) * s };
}

/** 正準系で壁・扉・窓・床・階段・家具・人物を作り、枠 frame で全データを写す。 */
function compileLayout(ctx: CompileContext, rng: Rng, opts: CompileOptions): ModularGenerationResult {
  const { tpl, profile, layout, frame } = ctx;
  const s = tpl.snap;
  const t = tpl.wallThickness;
  const rise = profile.storyRise;
  const slab = tpl.slabThickness;
  // 有効階高は 1 回だけ丸め、storyHeight・doorLintel・ceilingY で同じ値を使う（MN-07）
  const clear = round3(rise - slab);
  const doorLintel = Math.min(ctx.doorLeafHeight, clear);
  const archLintel = tpl.door.archHeight;
  const levels = [...layout.levels].sort((a, b) => a - b);
  const maxLevel = levels[levels.length - 1] as StoryLevel;
  const ceilingHeight = round3((maxLevel + 1) * rise - slab);
  const fy = (lv: StoryLevel): number => floorYOf(lv, rise);
  const rooms = layout.rooms;
  const roomById = new Map(rooms.map((r) => [r.id, r] as const));
  const indoorOf = (lv: StoryLevel): PlacedRoom[] => rooms.filter((r) => r.level === lv && !r.outdoor);
  const holesOf = (lv: StoryLevel): Rect[] => layout.stairCores.flatMap((c) => c.holes.filter((h) => h.level === lv).map((h) => h.rect));
  const grid = new PlacementGrid();
  const approach = roomById.get(layout.approachRoomId) as PlacedRoom;

  // ---- 開口（扉・アーチ）と施錠
  const lintelOf = (o: PlacedOpening): number => (o.style === 'arch' ? archLintel : doorLintel);
  const locked = new Set<string>();
  if (!opts.bare) {
    const lockable = rng.shuffle(layout.openings.filter((o) => o.style === 'door' && o.kind !== 'front' && !o.alwaysUnlocked));
    for (const o of lockable) {
      if (locked.size >= tpl.door.maxLocked) break;
      if (rng.chance(tpl.door.lockedChance)) locked.add(o.id);
    }
  }

  // 吹き抜け（1F の 2 層室）は 2F の壁矩形にも入れる（2F 階高ぶんの壁で囲う = 落下防止）
  const voidRects = levels.includes(1) ? rooms.filter((r) => r.level === 0 && r.doubleHeight && !r.outdoor).map((r) => r.rect) : [];
  const wallRectsOf = (lv: StoryLevel): Rect[] => [...indoorOf(lv).map((r) => r.rect), ...(lv === 1 ? voidRects : [])];

  // ---- 外窓（B1・階段コアは除く。同階の屋内室と共有しない外周区間のみ）
  const windowsCanon: { def: WindowDef; opening: Opening; roomId: string; level: StoryLevel }[] = [];
  if (!opts.bare && tpl.window.chance > 0) {
    for (const lv of levels) {
      if (lv < 0) continue;
      const lvRects = wallRectsOf(lv);
      for (const r of indoorOf(lv)) {
        if (r.coreId) continue;
        if (!rng.chance(tpl.window.chance)) continue;
        const R = r.rect;
        const edges: { axis: 'x' | 'z'; c: number; lo: number; hi: number; yaw: number }[] = [
          { axis: 'x', c: R.z1, lo: R.x0, hi: R.x1, yaw: 0 },
          { axis: 'x', c: R.z0, lo: R.x0, hi: R.x1, yaw: 180 },
          { axis: 'z', c: R.x1, lo: R.z0, hi: R.z1, yaw: 90 },
          { axis: 'z', c: R.x0, lo: R.z0, hi: R.z1, yaw: 270 },
        ];
        const existing: Opening[] = [...layout.openings.filter((o) => o.level === lv), ...windowsCanon.filter((w) => w.level === lv).map((w) => w.opening)];
        let done = false;
        for (const e of rng.shuffle(edges)) {
          if (done) break;
          let free: [number, number][] = [[e.lo, e.hi]];
          for (const o of lvRects) {
            if (o === R) continue;
            const sh = sharedEdge(R, o);
            if (sh && sh.axis === e.axis && Math.abs(sh.c - e.c) < EPS) free = subtractInterval(free, sh.lo, sh.hi);
          }
          for (const [lo, hi] of rng.shuffle(free)) {
            const maxW = floorTo(hi - lo - t - 2 * tpl.window.minMargin, s);
            if (maxW < tpl.window.width.min - EPS) continue;
            const width = round3(Math.min(maxW, Math.max(tpl.window.width.min, rng.inRange(tpl.window.width))));
            const center = pickOpeningCenter(rng, { axis: e.axis, c: e.c, lo, hi }, width, tpl.window.minMargin, t, lvRects, existing, s);
            if (center === null) continue;
            const opening: Opening = { axis: e.axis, c: e.c, center, width, window: { sill: tpl.window.sill, height: tpl.window.height } };
            const p = openingPoint(opening);
            const def: WindowDef = { x: p.x, z: p.z, yaw: e.yaw, width, height: tpl.window.height, sill: tpl.window.sill };
            if (fy(lv) !== 0) def.y = round3(fy(lv));
            windowsCanon.push({ def, opening, roomId: r.id, level: lv });
            // 室内側の大型遮蔽物禁止（外向き法線の逆側）
            const half = width / 2 + tpl.window.minMargin;
            const dep = tpl.window.keepOutDepth;
            const inward = e.yaw === 0 || e.yaw === 90 ? [-dep, 0] : [0, dep];
            grid.addKeepOut(openingStrip(opening, half, inward[0] as number, inward[1] as number), fy(lv));
            done = true;
            break;
          }
        }
      }
    }
  }

  // ---- 室内窓口（同階の屋内室どうしの仕切り壁。腰壁付きの素通し開口で、歩いては通れないが見通し・射線は通る）
  const interiorChance = tpl.window.interiorChance ?? 0;
  if (!opts.bare && interiorChance > 0) {
    const iw = tpl.window.interiorWidth ?? { min: 1.0, max: 1.6 };
    const sill = tpl.window.interiorSill ?? 1.0;
    const height = tpl.window.interiorHeight ?? 0.95;
    const maxPer = tpl.window.interiorMaxPerLevel ?? 3;
    for (const lv of levels) {
      const lvRects = wallRectsOf(lv);
      const cands = indoorOf(lv).filter((r) => !r.coreId && !r.private);
      const pairs: [PlacedRoom, PlacedRoom][] = [];
      for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) pairs.push([cands[i]!, cands[j]!]);
      let placed = 0;
      for (const [a, b] of rng.shuffle(pairs)) {
        if (placed >= maxPer) break;
        const sh = sharedEdge(a.rect, b.rect);
        if (!sh) continue;
        if (!rng.chance(interiorChance)) continue;
        const maxW = floorTo(sh.hi - sh.lo - t - 2 * tpl.window.minMargin, s);
        if (maxW < iw.min - EPS) continue;
        const width = round3(Math.min(maxW, Math.max(iw.min, rng.inRange(iw))));
        const existing: Opening[] = [...layout.openings.filter((o) => o.level === lv), ...windowsCanon.filter((w) => w.level === lv).map((w) => w.opening)];
        const center = pickOpeningCenter(rng, sh, width, tpl.window.minMargin, t, lvRects, existing, s);
        if (center === null) continue;
        const opening: Opening = { axis: sh.axis, c: sh.c, center, width, window: { sill, height } };
        const p = openingPoint(opening);
        const def: WindowDef = { x: p.x, z: p.z, yaw: sh.axis === 'x' ? 0 : 90, width, height, sill, interior: true };
        if (fy(lv) !== 0) def.y = round3(fy(lv));
        windowsCanon.push({ def, opening, roomId: a.id, level: lv });
        // 両側に大型遮蔽物を置かない（窓口の見通しを家具で塞がない）
        const dep = tpl.window.keepOutDepth;
        grid.addKeepOut(openingStrip(opening, width / 2 + tpl.window.minMargin, -dep, dep), fy(lv));
        placed++;
      }
    }
  }

  // ---- 壁（階層別。下に階がある階の壁は上階床上面まで、最上階は有効階高まで）
  const walls: BoxDef[] = [];
  for (const lv of levels) {
    const rects = wallRectsOf(lv);
    if (rects.length === 0) continue;
    const ops: Opening[] = [
      ...layout.openings.filter((o) => o.level === lv).map((o) => ({ axis: o.axis, c: o.c, center: o.center, width: o.width, lintelY: lintelOf(o) })),
      ...windowsCanon.filter((w) => w.level === lv).map((w) => w.opening),
    ];
    const height = levels.includes((lv + 1) as StoryLevel) ? rise : clear;
    walls.push(...buildWalls(rects, ops, t, height, fy(lv)));
  }

  // ---- 落下防止壁（階段穴の非接続辺・2F テラス外周）
  const guardWalls: BoxDef[] = [];
  const guard = (x0: number, z0: number, x1: number, z1: number, lv: StoryLevel): void => {
    if (x1 - x0 < EPS || z1 - z0 < EPS) return;
    const b: BoxDef = { x: (x0 + x1) / 2, z: (z0 + z1) / 2, width: x1 - x0, depth: z1 - z0, height: tpl.parapetHeight };
    if (fy(lv) !== 0) b.y = fy(lv);
    guardWalls.push(b);
  };
  // 階段穴の非接続辺（SpatialSolver.stairHoleGuardRects と同一の矩形。doorBlocked・踊り場もこの矩形を避けている。BL-01）
  for (const core of layout.stairCores) {
    for (const h of core.holes) for (const gr of stairHoleGuardRects(h, core.inner, t)) guard(gr.x0, gr.z0, gr.x1, gr.z1, h.level);
  }
  for (const terr of rooms.filter((r) => r.outdoor && r.level > 0)) {
    // 2F 屋内室・吹き抜けと共有する辺は通常の壁があるので開口扱いで抜く
    const shared: Opening[] = [];
    for (const o of wallRectsOf(terr.level)) {
      const sh = sharedEdge(terr.rect, o);
      if (sh) shared.push({ axis: sh.axis, c: sh.c, center: (sh.lo + sh.hi) / 2, width: sh.hi - sh.lo });
    }
    guardWalls.push(...buildWalls([terr.rect], shared, t, tpl.parapetHeight, fy(terr.level)));
  }
  walls.push(...guardWalls);

  // ---- 扉（doors.json の扉高に統一。上階は敷居高 y = floorY）
  type DoorDefWithDouble = DoorDef & { double?: boolean };
  const doors: DoorDef[] = [];
  const doorIdOf = new Map<string, string>();
  const doorIds = new Set<string>();
  for (const o of layout.openings) {
    if (o.style === 'arch') continue;
    const base = `door_${o.roomA}_${o.roomB}`;
    let id = base;
    for (let k = 2; doorIds.has(id); k++) id = `${base}_${k}`;
    doorIds.add(id);
    doorIdOf.set(o.id, id);
    const p = openingPoint(o);
    const flip = opts.bare ? false : rng.chance(0.5);
    const yaw = o.axis === 'x' ? (flip ? 180 : 0) : flip ? 270 : 90;
    const d: DoorDefWithDouble = { id, x: p.x, z: p.z, yaw, locked: locked.has(o.id), maxAngle: tpl.door.maxAngle, width: o.width };
    if (o.double) d.double = true;
    if (o.floorY !== 0) d.y = round3(o.floorY);
    doors.push(d);
  }

  // ---- keepOut（扉可動域・アーチ前後・階段コア・正面アプローチ）
  for (const o of layout.openings) {
    const swingW = o.double ? o.width / 2 : o.width;
    const reach = o.style === 'arch' ? tpl.door.archClearance : swingW + tpl.door.swingClearance;
    grid.addKeepOut(openingStrip(o, o.width / 2 + OPENING_SIDE_PAD, -reach, reach), o.floorY);
  }
  for (const core of layout.stairCores) for (const lv of levels) grid.addKeepOut(core.inner, fy(lv));
  const front = layout.openings.find((o) => o.kind === 'front') as PlacedOpening;
  const spawn = { ...layout.spawn, x: round3(layout.spawn.x), z: round3(layout.spawn.z) };
  grid.addKeepOut(
    {
      x0: spawn.x - tpl.site.approachKeepOutHalfWidth,
      x1: spawn.x + tpl.site.approachKeepOutHalfWidth,
      z0: front.c - (tpl.door.width + tpl.door.swingClearance),
      z1: approach.rect.z1,
    },
    0,
  );

  // ---- 床スラブ（上面 = 各階床。1F は敷地全面を屋外地盤＋屋内室で被覆、階段穴だけ抜く）
  const floors: BoxDef[] = [];
  const slabBox = (r: Rect, lv: StoryLevel, material: string): BoxDef => ({
    x: (r.x0 + r.x1) / 2,
    z: (r.z0 + r.z1) / 2,
    y: fy(lv) - slab,
    width: r.x1 - r.x0,
    depth: r.z1 - r.z0,
    height: slab,
    material,
  });
  const lot = canonicalLot(frame);
  const holes1F = holesOf(0);
  for (const piece of subtractRects(lot, [...indoorOf(0).map((r) => r.rect), ...holes1F])) floors.push(slabBox(piece, 0, 'concrete'));
  for (const lv of levels) {
    const holes = holesOf(lv);
    for (const r of rooms) {
      if (r.level !== lv || (lv === 0 && r.outdoor)) continue;
      const mat = r.floorMaterial ?? (r.outdoor ? 'concrete' : 'wood');
      for (const piece of subtractRects(r.rect, holes)) floors.push(slabBox(piece, lv, mat));
    }
  }

  // ---- 階段
  const stairs: StairDef[] = layout.stairCores.flatMap((c) => c.flights.map((f) => ({ ...f.def })));

  // ---- 隊員（スポーンの左右・後方。正準系の正面は -Z）。家具より先に決め、周囲を keepOut に登録する（INV-11 / BL-03）
  // 人数は屋内床面積の共通編成。SWAT モードはプレイヤー + この NPC、容疑者モードはこの合計が敵 SWAT になる。
  const ar = inset(approach.rect, ALLY_EDGE_PAD);
  const clampX = (x: number): number => Math.min(ar.x1, Math.max(ar.x0, x));
  const clampZ = (z: number): number => Math.min(ar.z1, Math.max(ar.z0, z));
  let indoorSq = 0;
  for (const r of rooms) if (!r.outdoor) indoorSq += rectArea(r.rect);
  const allyN = Math.max(0, missionRoster(indoorSq).swat - 1);
  const allies: AllyDef[] = [];
  for (const a of ALLY_SLOTS.slice(0, allyN)) {
    let x = round3(clampX(spawn.x + a.side * tpl.site.allyLateralOffset));
    let z = round3(clampZ(spawn.z + tpl.site.allyBackOffset + a.back));
    for (let guard = 0; allies.some((o) => Math.hypot(o.x - x, o.z - z) < 0.7) && guard < 6; guard++) {
      z = round3(clampZ(z + 0.45));
    }
    allies.push({ id: a.id, name: a.name, x, z, yaw: 0 });
  }
  for (const a of allies) {
    grid.addKeepOut({ x0: a.x - ALLY_KEEPOUT_HALF, z0: a.z - ALLY_KEEPOUT_HALF, x1: a.x + ALLY_KEEPOUT_HALF, z1: a.z + ALLY_KEEPOUT_HALF }, 0);
  }

  // ---- 家具（階層別 PlacementGrid、上限 MAX_FURNITURE_TRIES 回で当該家具のみスキップ）
  if (!opts.bare) {
    for (const r of rooms) {
      if (r.coreId) continue;
      const interior = inset(r.rect, r.outdoor ? OUTDOOR_FURNITURE_INSET : t / 2 + INDOOR_FURNITURE_INSET);
      if (interior.x1 <= interior.x0 || interior.z1 <= interior.z0) continue;
      for (const f of r.furniture) {
        if (!rng.chance(f.chance)) continue;
        const n = rng.intInRange(f.count);
        for (let k = 0; k < n; k++) grid.placeFurniture(rng, f, interior, tpl.furnitureGap, tpl.wallClearance, MAX_FURNITURE_TRIES, r.floorY);
      }
    }
  }

  // ---- 人物
  const entities = placeEntities(ctx, rng, grid, opts);

  // ---- 部屋
  const roomDefs: RoomDef[] = rooms.map((r) => {
    const def: RoomDef = {
      id: r.id,
      name: r.name,
      x: (r.rect.x0 + r.rect.x1) / 2,
      z: (r.rect.z0 + r.rect.z1) / 2,
      width: r.rect.x1 - r.rect.x0,
      depth: r.rect.z1 - r.rect.z0,
      floorY: round3(r.floorY),
    };
    if (r.outdoor) def.outdoor = true;
    else def.ceilingY = round3(r.floorY + (r.doubleHeight ? rise : 0) + clear);
    return def;
  });

  // ---- ブリーフィング
  const nS = entities.filter((e) => e.type === 'suspect').length;
  const nC = entities.length - nS;
  const u = tpl.entities.briefingUncertainty;
  const est = (n: number): { min: number; max: number } => ({ min: Math.max(0, n - rng.int(0, u)), max: n + rng.int(0, u) });
  const summary = rng.pick(tpl.summaries) ?? '';

  // ---- 8 変換（正準系の全データを L(p + Δ·snap) で写す）。連続乱数由来の値（人物・隊員・スポーン）は正準系で 1 回だけ
  // 丸め済み。変換後には丸めない（Math.round の正負非対称で写像 L(·) とずれ、壁中心だけの丸めで扉枠と隙間ができるため。BL-02）
  const sw = swapsAxes(frame);
  const map: GeneratedMapRaw = {
    id: ctx.mapId,
    name: tpl.name,
    seed: ctx.seed,
    briefing: { summary, estimatedSuspects: est(nS), estimatedHostages: est(nC) },
    ceilingHeight,
    storyHeight: round3(clear),
    floor: lotSize(frame),
    playerSpawn: mapSpawn(frame, spawn),
    allies: allies.map((a) => mapFacing(frame, a)),
    walls: walls.map((b) => mapBox(frame, b)),
    doors: doors.map((d) => mapDoor(frame, d)),
    windows: windowsCanon.map((w) => mapWindow(frame, w.def)),
    covers: grid.covers.map((b) => mapBox(frame, b)),
    entities: entities.map((e) => mapFacing(frame, e)),
    rooms: roomDefs.map((r) => {
      const p = mapPoint(frame, r.x, r.z);
      return { ...r, x: p.x, z: p.z, width: sw ? r.depth : r.width, depth: sw ? r.width : r.depth };
    }),
    floors: floors.map((b) => mapBox(frame, b)),
    stairs: stairs.map((st) => mapStair(frame, st)),
    items: [],
  };

  // ---- メタデータ
  const transformed = transformLayoutWithFrame(layout, frame);
  const roomMeta: Record<string, ModularRoomMeta> = {};
  for (const r of rooms) {
    const m: ModularRoomMeta = {
      moduleId: r.moduleId,
      moduleDefId: r.moduleDefId,
      category: r.category,
      isPrivate: r.private,
      storyLevel: r.level,
      floorY: r.floorY,
      outdoor: r.outdoor,
      isSubRoom: r.isSubRoom,
      roofStyle: r.roofStyle,
      doubleHeight: r.doubleHeight,
    };
    if (r.coreId) m.coreId = r.coreId;
    roomMeta[r.id] = m;
  }
  const openings: ModularOpeningMeta[] = transformed.openings.map((o) => {
    const m: ModularOpeningMeta = {
      id: o.id,
      roomA: o.roomA,
      roomB: o.roomB,
      style: o.style,
      kind: o.kind,
      level: o.level,
      floorY: o.floorY,
      locked: locked.has(o.id),
      alwaysUnlocked: o.alwaysUnlocked,
      lintelY: lintelOf(o),
      width: o.width,
      margin: o.margin,
      axis: o.axis,
      c: o.c,
      center: o.center,
    };
    const did = doorIdOf.get(o.id);
    if (did !== undefined) m.doorId = did;
    return m;
  });
  const windows: ModularWindowMeta[] = windowsCanon.map((w) => {
    const p = mapPoint(frame, w.def.x, w.def.z);
    const axis: 'x' | 'z' = sw ? (w.opening.axis === 'x' ? 'z' : 'x') : w.opening.axis;
    return { roomId: w.roomId, level: w.level, axis, c: axis === 'x' ? p.z : p.x, center: axis === 'x' ? p.x : p.z, width: w.def.width };
  });
  const meta: ModularGenerationMeta = {
    roomMeta,
    usedFallback: opts.fallback,
    attemptsUsed: opts.attemptsUsed,
    selectedProfileId: profile.id,
    appliedRotation: frame.rot,
    appliedMirrorX: frame.mirrorX,
    retryReasons: [...opts.retryReasons],
    storyRise: rise,
    slabThickness: slab,
    storyClearance: clear,
    doorLintelY: doorLintel,
    archLintelY: archLintel,
    openings,
    windows,
    stairLinks: layout.stairLinks.map((l) => ({ ...l })),
    guardWalls: guardWalls.map((b) => mapBox(frame, b)),
    layout: transformed,
    canonicalLayout: layout,
    frame,
  };
  return { map, meta };
}

// ---------------------------------------------------------------- 人物配置

interface SpawnRoom {
  room: PlacedRoom;
  it: Rect;
}

function placeEntities(ctx: CompileContext, rng: Rng, grid: PlacementGrid, opts: CompileOptions): EntityDef[] {
  const { tpl, layout } = ctx;
  const ec = tpl.entities;
  const t = tpl.wallThickness;
  const r = ec.clearance;
  const spawn = layout.spawn;
  const dist3 = (x: number, y: number, z: number): number => Math.hypot(x - spawn.x, y - spawn.y, z - spawn.z);
  const eligible = (room: PlacedRoom): boolean => !room.outdoor && !room.coreId && room.category !== 'entry';
  const toSpawnRoom = (room: PlacedRoom): SpawnRoom => ({ room, it: inset(room.rect, t / 2 + r + ENTITY_WALL_PAD) });
  const candidates = layout.rooms.filter((x) => eligible(x) && x.spawnWeight > 0).map(toSpawnRoom).filter((c) => c.it.x1 > c.it.x0 && c.it.z1 > c.it.z0);
  // テンプレートの min/max ではなく、完成間取りの屋内面積から両モード共通の人数を取る。
  let indoorSq = 0;
  for (const room of layout.rooms) if (!room.outdoor) indoorSq += rectArea(room.rect);
  const roster = missionRoster(indoorSq);
  const nSuspects = roster.suspects;
  const nCivilians = roster.hostages;

  const okAt = (x: number, z: number, floorY: number, list: readonly EntityDef[]): boolean =>
    dist3(x, floorY, z) >= ec.minSpawnDistance - EPS && grid.canStand(x, z, r, list, ec.minEntitySeparation, floorY);
  const openingsOf = (room: PlacedRoom): { x: number; z: number }[] =>
    layout.openings.filter((o) => o.roomA === room.id || o.roomB === room.id).map(openingPoint);
  const yawToward = (x: number, z: number, room: PlacedRoom): number => {
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (const p of openingsOf(room)) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return round3(rng.range(0, 360));
    const yaw = (Math.atan2(-(best.x - x), -(best.z - z)) * 180) / Math.PI;
    return round3(yaw + rng.range(-FACING_JITTER, FACING_JITTER));
  };
  const profileCounts = new Map<string, number>();
  const pickProfile = (): string | null => {
    const prof = rng.weighted(
      ec.suspectProfiles.filter((p) => (profileCounts.get(p.profile) ?? 0) < p.max),
      (p) => p.weight,
    );
    if (!prof) return null;
    profileCounts.set(prof.profile, (profileCounts.get(prof.profile) ?? 0) + 1);
    return prof.profile;
  };
  const make = (type: 'suspect' | 'civilian', list: EntityDef[], x: number, z: number, room: PlacedRoom, profile: string): EntityDef => {
    const n = list.filter((e) => e.type === type).length + 1;
    const e: EntityDef = { id: `${type}_${n}`, type, profile, x: round3(x), z: round3(z), yaw: type === 'suspect' ? yawToward(x, z, room) : round3(rng.range(0, 360)) };
    if (room.floorY !== 0) e.y = round3(room.floorY);
    return e;
  };

  // ---- 通常のランダム配置
  const entities: EntityDef[] = [];
  const occupancy = new Map<PlacedRoom, number>();
  const tryIn = (c: SpawnRoom, near?: { x: number; z: number }): { x: number; z: number } | null => {
    for (let i = 0; i < MAX_ENTITY_TRIES; i++) {
      let x: number;
      let z: number;
      if (near) {
        const ang = rng.range(0, Math.PI * 2);
        const dd = rng.range(HOSTAGE_NEAR.min, HOSTAGE_NEAR.max);
        x = near.x + Math.cos(ang) * dd;
        z = near.z + Math.sin(ang) * dd;
        if (x < c.it.x0 || x > c.it.x1 || z < c.it.z0 || z > c.it.z1) continue;
      } else {
        x = rng.range(c.it.x0, c.it.x1);
        z = rng.range(c.it.z0, c.it.z1);
      }
      if (!okAt(round3(x), round3(z), c.room.floorY, entities)) continue;
      return { x: round3(x), z: round3(z) };
    }
    return null;
  };
  const pickRoom = (exclude: Set<SpawnRoom>): SpawnRoom | undefined =>
    rng.weighted(
      candidates.filter((c) => !exclude.has(c)),
      (c) => c.room.spawnWeight / (1 + (occupancy.get(c.room) ?? 0)),
    );
  const suspectAt: { c: SpawnRoom; x: number; z: number }[] = [];
  if (!opts.bare) {
    for (let i = 0; i < nSuspects; i++) {
      const tried = new Set<SpawnRoom>();
      for (let k = 0; k < candidates.length; k++) {
        const c = pickRoom(tried);
        if (!c) break;
        tried.add(c);
        const pos = tryIn(c);
        if (!pos) continue;
        const prof = pickProfile();
        if (!prof) break;
        entities.push(make('suspect', entities, pos.x, pos.z, c.room, prof));
        occupancy.set(c.room, (occupancy.get(c.room) ?? 0) + 1);
        suspectAt.push({ c, ...pos });
        break;
      }
    }
    for (let i = 0; i < nCivilians; i++) {
      let pos: { x: number; z: number } | null = null;
      let at: SpawnRoom | undefined;
      if (suspectAt.length > 0 && rng.chance(ec.hostagePairChance)) {
        const sAt = rng.pick(suspectAt);
        if (sAt) {
          pos = tryIn(sAt.c, sAt);
          at = sAt.c;
        }
      }
      if (!pos) {
        const tried = new Set<SpawnRoom>();
        for (let k = 0; k < candidates.length && !pos; k++) {
          const c = pickRoom(tried);
          if (!c) break;
          tried.add(c);
          pos = tryIn(c);
          at = c;
        }
      }
      if (!pos || !at) continue;
      entities.push(make('civilian', entities, pos.x, pos.z, at.room, ec.civilianProfile));
      occupancy.set(at.room, (occupancy.get(at.room) ?? 0) + 1);
    }
  }
  const countOf = (list: readonly EntityDef[], type: string): number => list.filter((e) => e.type === type).length;
  if (!opts.bare && countOf(entities, 'suspect') >= nSuspects && countOf(entities, 'civilian') >= nCivilians) return entities;
  if (!opts.fallback) {
    throw new RetryGeneration(
      `人物を配置できません (容疑者 ${countOf(entities, 'suspect')}/${nSuspects}, 民間人 ${countOf(entities, 'civilian')}/${nCivilians})`,
    );
  }

  // ---- 最終試行の決定論的補填（室内格子点を playerSpawn から遠い順に走査し、全員同時に条件を満たす）
  profileCounts.clear();
  const pitch = Math.max(tpl.snap, LATTICE_MIN_PITCH);
  const pts: { x: number; z: number; d: number; room: PlacedRoom }[] = [];
  const latticeRooms = layout.rooms.filter(eligible).map(toSpawnRoom);
  for (const c of latticeRooms) {
    const { it } = c;
    if (it.x1 < it.x0 - EPS || it.z1 < it.z0 - EPS) continue;
    for (let x = ceilTo(it.x0, pitch); x <= it.x1 + EPS; x += pitch) {
      for (let z = ceilTo(it.z0, pitch); z <= it.z1 + EPS; z += pitch) {
        const px = round3(x);
        const pz = round3(z);
        pts.push({ x: px, z: pz, d: dist3(px, c.room.floorY, pz), room: c.room });
      }
    }
  }
  pts.sort((a, b) => b.d - a.d || a.x - b.x || a.z - b.z || a.room.floorY - b.room.floorY);
  const lattice: EntityDef[] = [];
  const takeOne = (type: 'suspect' | 'civilian'): boolean => {
    for (const p of pts) {
      if (!okAt(p.x, p.z, p.room.floorY, lattice)) continue;
      const prof = type === 'suspect' ? pickProfile() : ec.civilianProfile;
      if (prof === null) return false;
      lattice.push(make(type, lattice, p.x, p.z, p.room, prof));
      return true;
    }
    return false;
  };
  // 必須人数（min）を先に置く（乱数で決まる目標人数に依存しない同一の前置部分 = verify と同じ結果）
  for (let i = 0; i < ec.suspects.min; i++) if (!takeOne('suspect')) break;
  for (let i = 0; i < ec.civilians.min; i++) if (!takeOne('civilian')) break;
  if (countOf(lattice, 'suspect') < ec.suspects.min || countOf(lattice, 'civilian') < ec.civilians.min) {
    throw new FallbackInfeasibleError(
      tpl.id,
      ctx.profile.id,
      `人物の同時配置 (容疑者 ${countOf(lattice, 'suspect')}/${ec.suspects.min}, 民間人 ${countOf(lattice, 'civilian')}/${ec.civilians.min})`,
    );
  }
  for (let i = ec.suspects.min; i < nSuspects; i++) if (!takeOne('suspect')) break;
  for (let i = ec.civilians.min; i < nCivilians; i++) if (!takeOne('civilian')) break;
  return lattice;
}

// ---------------------------------------------------------------- 決定論的最小構成器

interface FbRoomSpec {
  id: string;
  def: ArchitecturalModuleDef;
  level: StoryLevel;
  rect: Rect;
  coreIndex?: number;
}

interface FbEdge {
  a: string;
  b: string;
  style: ModularEdgeStyle | 'stair';
}

const isGeneralDef = (d: ArchitecturalModuleDef): boolean =>
  !d.outdoor && d.category !== 'stair_core' && d.category !== 'corridor' && d.category !== 'entry';

function byWeightDesc(a: ArchitecturalModuleDef, b: ArchitecturalModuleDef): number {
  return b.weight - a.weight;
}

/**
 * 選択プロファイルを維持する決定論的最小構成（§3.2-5）。正準系（南 +Z がアプローチ）で、
 *   南端 front_approach → entry → 東西方向のハブ（corridor、無ければ fallbackModuleId）→
 *   ハブ北辺に沿って [西ウイング: fallbackModuleId × nW][stair_core（多層時）][東ウイング: 必須モジュール＋fallbackModuleId × nE]
 * を並べ、2F・B1 は「コア＋ハブ直上/直下の corridor＋西ウイング直上/直下の一般屋内室」（corridor が無い・規則が無い場合は
 * コア西辺へ一般屋内室を直結）を、面積比・包含が成立する幅で置く。扉位置は固定シードで決まる。
 * accept が与えられたときは、候補の中で accept を満たす最初のものを返す（人物の同時配置の検証に使う）。
 * 不成立なら FallbackInfeasibleError（DataError の派生）。
 */
export function buildSafeMinimalModularLayout(
  tpl: ModularGeneratorTemplate,
  profile: StoryProfileDef,
  accept?: (layout: PlacedBuildingLayout) => boolean,
): PlacedBuildingLayout {
  const fail = (why: string): never => {
    throw new FallbackInfeasibleError(tpl.id, profile.id, why);
  };
  const s = tpl.snap;
  const t = tpl.wallThickness;
  const levels = [...profile.levels].sort((a, b) => a - b);
  const multi = levels.length > 1;
  const hasUpper = levels.includes(1);
  const hasBasement = levels.includes(-1);
  const rise = profile.storyRise;
  const rules = new CirculationRules(tpl);
  const g = computeStairCoreGeometry(tpl, profile);
  const doorPassMin = tpl.door.width + t + 2 * tpl.door.margin;
  const archPassMin = tpl.door.width + t + 2 * tpl.door.archMargin;
  const needLen = (style: ModularEdgeStyle): number => (style === 'arch' ? archPassMin : doorPassMin);
  const styleOf = (a: ArchitecturalModuleDef, b: ArchitecturalModuleDef): ModularEdgeStyle | null => {
    const r = rules.rule(a.category, b.category);
    if (!r) return null;
    if (r.style === 'exterior_door' && !a.outdoor && !b.outdoor) return null;
    return r.style;
  };
  const allowedAt = (d: ArchitecturalModuleDef, lv: StoryLevel): boolean => d.allowedLevels.includes(lv) && !d.outdoor;
  const lo = (r: { min: number; max: number }): number => ceilTo(r.min, s);
  const hi = (r: { min: number; max: number }): number => Math.max(lo(r), floorTo(r.max, s));
  const mid = (r: { min: number; max: number }): number => snapRange(r.min, r.max, (r.min + r.max) / 2, s);

  const entryDef: ArchitecturalModuleDef =
    tpl.modules.filter((d) => d.category === 'entry' && allowedAt(d, 0)).sort(byWeightDesc)[0] ?? fail('1F に置ける屋内 entry がありません');
  const fb: ArchitecturalModuleDef =
    tpl.modules.find((d) => d.id === tpl.fallbackModuleId) ?? fail(`fallbackModuleId "${tpl.fallbackModuleId}" がありません`);
  const coreDef = multi
    ? tpl.modules.filter((d) => d.category === 'stair_core' && !d.outdoor && levels.every((lv) => d.allowedLevels.includes(lv))).sort(byWeightDesc)[0]
    : undefined;
  if (multi && (!coreDef || !g)) return fail('全階に置ける stair_core がありません');

  // 1F ハブ: entry と規則で結べる corridor（重み順）→ fallbackModuleId
  const hubCands = [
    ...tpl.modules.filter((d) => d.category === 'corridor' && allowedAt(d, 0)).sort(byWeightDesc),
    fb,
  ].filter((d) => styleOf(entryDef, d) !== null && (!multi || styleOf(d, coreDef as ArchitecturalModuleDef) !== null) && styleOf(d, fb) !== null);
  if (hubCands.length === 0) return fail('entry・stair_core・fallbackModuleId と規則で結べるハブ（corridor または fallbackModuleId）がありません');

  // 1F 東ウイングの必須モジュール（屋内・1F 可・ハブと規則あり。サブ室は単一室保持）
  const requiredEast = (hub: ArchitecturalModuleDef): ArchitecturalModuleDef[] => {
    const out: ArchitecturalModuleDef[] = [];
    for (const d of tpl.modules) {
      if (d.id === hub.id || d.category === 'entry' || d.category === 'stair_core' || !allowedAt(d, 0) || d.minCount <= 0) continue;
      if (styleOf(hub, d) === null) continue;
      const extra = d === fb ? 0 : d.minCount;
      for (let i = 0; i < extra; i++) out.push(d);
    }
    return out;
  };

  // 非 1F 階の一般屋内室の候補（必須 → fallback → 重み順）
  const generalFor = (lv: StoryLevel, parent: ArchitecturalModuleDef): ArchitecturalModuleDef[] => {
    const all = tpl.modules.filter((d) => isGeneralDef(d) && allowedAt(d, lv) && styleOf(parent, d) !== null);
    const rank = (d: ArchitecturalModuleDef): number => (d.minCount > 0 ? 0 : d === fb ? 1 : 2) + (d.private ? 0.5 : 0);
    return all.sort((a, b) => rank(a) - rank(b) || b.weight - a.weight);
  };
  const corridorFor = (lv: StoryLevel): ArchitecturalModuleDef[] =>
    tpl.modules
      .filter((d) => d.category === 'corridor' && allowedAt(d, lv) && styleOf(coreDef as ArchitecturalModuleDef, d) !== null)
      .sort(byWeightDesc);

  const sizeOpts = (d: ArchitecturalModuleDef): { w: number; d: number }[] => {
    const out: { w: number; d: number }[] = [];
    for (const [w, dd] of [
      [mid(d.width), mid(d.depth)],
      [lo(d.width), lo(d.depth)],
      [hi(d.width), hi(d.depth)],
    ] as [number, number][]) {
      if (!out.some((o) => o.w === w && o.d === dd)) out.push({ w, d: dd });
    }
    return out;
  };

  for (const hub of hubCands) {
    const hubStyleEntry = styleOf(entryDef, hub) as ModularEdgeStyle;
    const reqEast = requiredEast(hub);
    for (const fbSize of sizeOpts(fb)) {
      // 室数（entry・ハブ・ウイング・非 1F 階の corridor と一般室）が MAX_PLANNED_MODULES を超えない範囲で小さい構成から試す
      const reserved = 2 + reqEast.length + (hasUpper ? 2 : 0) + (hasBasement ? 2 : 0);
      for (let total = 1; total + reserved <= MAX_PLANNED_MODULES; total++) {
        for (let nW = 1; nW <= total; nW++) {
          const nE = total - nW;
          const built = tryBuild(hub, hubStyleEntry, reqEast, fbSize, nW, nE);
          if (built === null) continue;
          if (accept && !accept(built)) continue;
          return built;
        }
      }
    }
  }
  return fail('面積比・包含・寸法上限（maxFootprint）・人物の同時配置を満たす最小構成がありません');

  /** 1 候補の構成（不成立は null） */
  function tryBuild(
    hub: ArchitecturalModuleDef,
    hubStyleEntry: ModularEdgeStyle,
    reqEast: ArchitecturalModuleDef[],
    fbSize: { w: number; d: number },
    nW: number,
    nE: number,
  ): PlacedBuildingLayout | null {
    const specs: FbRoomSpec[] = [];
    const edges: FbEdge[] = [];
    const seq = new Map<string, number>();
    const newId = (d: ArchitecturalModuleDef, lv: StoryLevel): string => {
      const key = `${d.id}_${levelLabel(lv)}`;
      const n = seq.get(key) ?? 0;
      seq.set(key, n + 1);
      return `${key}_${n}`;
    };
    // ---- 1F
    const wE = Math.max(lo(entryDef.width), ceilTo(Math.max(doorPassMin, needLen(hubStyleEntry)), s));
    const dE = Math.max(lo(entryDef.depth), ceilTo(tpl.minCourtGap, s));
    const dH = Math.max(Math.min(lo(hub.width), lo(hub.depth)), ceilTo(tpl.minCourtGap, s));
    const zh1 = -dE;
    const zh0 = -dE - dH;
    const row: { def: ArchitecturalModuleDef; w: number; d: number; core?: boolean }[] = [];
    for (let i = 0; i < nW; i++) row.push({ def: fb, w: fbSize.w, d: fbSize.d });
    if (multi && g) row.push({ def: coreDef as ArchitecturalModuleDef, w: g.outerW, d: g.outerD, core: true });
    for (const d of reqEast) row.push({ def: d, w: lo(d.width), d: lo(d.depth) });
    for (let i = 0; i < nE; i++) row.push({ def: fb, w: fbSize.w, d: fbSize.d });
    const rowW = row.reduce((a, x) => a + x.w, 0);
    const hubW = Math.max(rowW, wE);
    const hx0 = -floorTo(hubW / 2, s);
    const hx1 = hx0 + hubW;
    const ex0 = -floorTo(wE / 2, s);
    if (ex0 < hx0 - EPS || ex0 + wE > hx1 + EPS) return null;
    const entryId = newId(entryDef, 0);
    specs.push({ id: entryId, def: entryDef, level: 0, rect: { x0: ex0, z0: -dE, x1: ex0 + wE, z1: 0 } });
    const hubId = newId(hub, 0);
    specs.push({ id: hubId, def: hub, level: 0, rect: { x0: hx0, z0: zh0, x1: hx1, z1: zh1 } });
    edges.push({ a: FRONT_APPROACH_ID, b: entryId, style: 'exterior_door' }, { a: entryId, b: hubId, style: hubStyleEntry });
    let cx = hx0 + Math.floor((hubW - rowW) / 2 / s + 1e-9) * s;
    let coreRect: Rect | null = null;
    const westRow: Rect[] = [];
    for (const it of row) {
      const style = styleOf(hub, it.def);
      if (style === null) return null;
      if (it.w < needLen(style) - EPS) return null;
      const rect: Rect = { x0: cx, z0: zh0 - it.d, x1: cx + it.w, z1: zh0 };
      cx += it.w;
      if (it.core) {
        coreRect = rect;
        specs.push({ id: `core0_${levelLabel(0)}`, def: it.def, level: 0, rect, coreIndex: 0 });
        edges.push({ a: hubId, b: `core0_${levelLabel(0)}`, style });
      } else {
        const id = newId(it.def, 0);
        specs.push({ id, def: it.def, level: 0, rect });
        edges.push({ a: hubId, b: id, style });
        if (!coreRect && it.def === fb) westRow.push(rect);
      }
    }
    const rects1F = specs.filter((x) => x.level === 0).map((x) => x.rect);
    const b1 = bboxOf(rects1F);
    if (b1.x1 - b1.x0 > tpl.maxFootprint.width + EPS || b1.z1 - b1.z0 > tpl.maxFootprint.depth + EPS) return null;
    const S1F = specs.filter((x) => x.level === 0 && (x.coreIndex !== undefined || x.def.roofStyle === 'stackable')).reduce((a, x) => a + rectArea(x.rect), 0);
    const I1F = rects1F.reduce((a, r) => a + rectArea(r), 0);

    // ---- 2F / B1
    const westX0 = westRow.length > 0 ? Math.min(...westRow.map((r) => r.x0)) : Infinity;
    const westD = fbSize.d;
    const upperLevels = levels.filter((lv) => lv !== 0);
    for (const lv of upperLevels) {
      if (!coreRect || !g) return null;
      const core = coreRect;
      const coreId = `core0_${levelLabel(lv)}`;
      specs.push({ id: coreId, def: coreDef as ArchitecturalModuleDef, level: lv, rect: core, coreIndex: 0 });
      edges.push({ a: `core0_${levelLabel(0)}`, b: coreId, style: 'stair' });
      const ratio = lv === 1 ? profile.upperFloorRatio : profile.basementRatio;
      const base = lv === 1 ? S1F : I1F;
      if (!ratio || base <= EPS) return null;
      const coreA = rectArea(core);
      const maxWU = core.x0 - westX0;
      const placedLv = tryUpper(lv, core, coreId, coreA, base, ratio, maxWU, westD, dH, zh0, hub);
      if (!placedLv) return null;
      specs.push(...placedLv.specs);
      edges.push(...placedLv.edges);
    }
    return assemble(specs, edges);
  }

  /** 非 1F 階（コア＋corridor＋一般室、または コア＋一般室）を面積比が成立する幅で置く */
  function tryUpper(
    lv: StoryLevel,
    core: Rect,
    coreId: string,
    coreA: number,
    base: number,
    ratio: { min: number; max: number },
    maxWU: number,
    westD: number,
    dH: number,
    zh0: number,
    hub: ArchitecturalModuleDef,
  ): { specs: FbRoomSpec[]; edges: FbEdge[] } | null {
    if (!(maxWU > EPS)) return null;
    const target = (ratio.min + ratio.max) / 2;
    const inRatio = (a: number): boolean => a / base >= ratio.min - EPS && a / base <= ratio.max + EPS;
    const coreW = core.x1 - core.x0;
    const uD = Math.min(westD, core.z1 - core.z0);
    const pickWidth = (minW: number, areaOf: (w: number) => number): number | null => {
      let best: number | null = null;
      let bestDist = Infinity;
      for (let w = ceilTo(minW, s); w <= maxWU + EPS; w += s) {
        const a = areaOf(w);
        if (!inRatio(a)) continue;
        const dd = Math.abs(a / base - target);
        if (dd < bestDist - 1e-12) {
          bestDist = dd;
          best = w;
        }
      }
      return best;
    };
    const coreDefLocal = coreDef as ArchitecturalModuleDef;
    // 戦略 A: ハブ直上/直下の corridor 経由（2F はハブが stackable のときのみ）
    if (lv === -1 || hub.roofStyle === 'stackable') {
      for (const corr of corridorFor(lv)) {
        for (const gen of generalFor(lv, corr)) {
          const st = styleOf(corr, gen) as ModularEdgeStyle;
          const cs = styleOf(coreDefLocal, corr) as ModularEdgeStyle;
          if (coreW < needLen(cs) - EPS) continue;
          const w = pickWidth(needLen(st), (ww) => coreA + (ww + coreW) * dH + ww * uD);
          if (w === null) continue;
          const corrId = `${corr.id}_${levelLabel(lv)}_0`;
          const genId = `${gen.id}_${levelLabel(lv)}_0`;
          return {
            specs: [
              { id: corrId, def: corr, level: lv, rect: { x0: core.x0 - w, z0: zh0, x1: core.x1, z1: zh0 + dH } },
              { id: genId, def: gen, level: lv, rect: { x0: core.x0 - w, z0: zh0 - uD, x1: core.x0, z1: zh0 } },
            ],
            edges: [
              { a: coreId, b: corrId, style: cs },
              { a: corrId, b: genId, style: st },
            ],
          };
        }
      }
    }
    // 戦略 B: コア西辺へ一般室を直結
    for (const gen of generalFor(lv, coreDefLocal)) {
      const st = styleOf(coreDefLocal, gen) as ModularEdgeStyle;
      const w = pickWidth(needLen(st), (ww) => coreA + ww * uD);
      if (w === null) continue;
      const genId = `${gen.id}_${levelLabel(lv)}_0`;
      return {
        specs: [{ id: genId, def: gen, level: lv, rect: { x0: core.x0 - w, z0: zh0 - uD, x1: core.x0, z1: zh0 } }],
        edges: [{ a: coreId, b: genId, style: st }],
      };
    }
    return null;
  }

  /** 室・開口・階段コア・アプローチ・スポーンを組み立てる（開口が置けなければ null） */
  function assemble(specs: FbRoomSpec[], edges: FbEdge[]): PlacedBuildingLayout | null {
    const rng = new Rng(FALLBACK_LAYOUT_SEED);
    const fyl = (lv: StoryLevel): number => floorYOf(lv, rise);
    const rooms: PlacedRoom[] = [];
    const b1F = bboxOf(specs.filter((x) => x.level === 0).map((x) => x.rect));
    const approachDepth = ceilTo(tpl.site.approachDepth.max, s);
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
    rooms.push(approach);
    for (const sp of specs) {
      const room: PlacedRoom = {
        id: sp.id,
        moduleId: sp.id,
        moduleDefId: sp.def.id,
        name: sp.def.name,
        category: sp.def.category,
        level: sp.level,
        floorY: fyl(sp.level),
        rect: sp.rect,
        outdoor: sp.def.outdoor,
        private: sp.def.private,
        roofStyle: sp.def.roofStyle,
        doubleHeight: false,
        spawnWeight: sp.def.spawnWeight,
        furniture: sp.def.furniture,
        isSubRoom: false,
        exteriorRequirement: sp.def.exteriorRequirement,
      };
      if (sp.def.floorMaterial !== undefined) room.floorMaterial = sp.def.floorMaterial;
      if (sp.coreIndex !== undefined) room.coreId = `core${sp.coreIndex}`;
      rooms.push(room);
    }
    const roomById = new Map(rooms.map((r) => [r.id, r] as const));

    // 階段コア
    const stairCores: PlacedStairCore[] = [];
    const stairLinks: StairLink[] = [];
    const coreRoom = rooms.find((r) => r.coreId === 'core0');
    let blockedOf = (_r: PlacedRoom): Rect[] | null => null;
    if (coreRoom && g) {
      const R = coreRoom.rect;
      const parts = coreParts(R, g, rise);
      const id = 'core0';
      const flights: PlacedStairFlight[] = parts.flights.map((f) => ({
        id: `${id}_${f.idSuffix}`,
        def: { id: `${id}_${f.idSuffix}`, ...f.def },
        fromLevel: f.fromLevel,
        toLevel: f.toLevel,
      }));
      stairCores.push({
        id,
        coreIndex: 0,
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
        if (!roomById.has(lower) || !roomById.has(upper)) return null;
        stairLinks.push({ coreId: id, flightId: f.id, lowerRoomId: lower, upperRoomId: upper });
      }
      blockedOf = (r: PlacedRoom): Rect[] | null => (r.coreId ? parts.doorBlocked.filter((b) => b.level === r.level).map((b) => b.rect) : null);
    }
    const accessDepth = tpl.door.width + t / 2;

    // 開口（木辺のみ。閉路は付けない）
    const doubleWidth = templateDoubleDoorWidth(tpl);
    const doublePassMin = doubleWidth !== undefined ? doubleWidth + t + 2 * tpl.door.margin : Infinity;
    const openings: PlacedOpening[] = [];
    for (const e of edges) {
      if (e.style === 'stair') continue;
      const ra = roomById.get(e.a) as PlacedRoom;
      const rb = roomById.get(e.b) as PlacedRoom;
      const sh = sharedEdge(ra.rect, rb.rect);
      if (!sh) return null;
      let iv: [number, number][] = [[sh.lo, sh.hi]];
      for (const r of [ra, rb]) {
        const bl = blockedOf(r);
        if (!bl) continue;
        const allowed = coreEdgeIntervals(r.rect, bl, sh, accessDepth);
        const next: [number, number][] = [];
        for (const [p0, p1] of iv) {
          for (const [q0, q1] of allowed) {
            const a = Math.max(p0, q0);
            const b = Math.min(p1, q1);
            if (b - a > EPS) next.push([a, b]);
          }
        }
        iv = next;
      }
      const style = e.style;
      const kind = e.a === FRONT_APPROACH_ID ? 'front' : 'tree';
      const preferDouble = doubleWidth !== undefined && shouldPreferDoubleDoor(rb, ra, style, kind);
      const lvRects = rooms.filter((r) => r.level === ra.level).map((r) => r.rect);
      const existing = openings.filter((o) => o.level === ra.level);
      let placed = false;
      for (const [a, b] of iv.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))) {
        if (b - a < needLen(style) - EPS) continue;
        let width = tpl.door.width;
        let margin = tpl.door.margin;
        if (style === 'arch') {
          margin = tpl.door.archMargin;
          width = Math.min(tpl.door.archWidth, floorTo(b - a - t - 2 * margin, s));
          if (width < tpl.door.width - EPS) width = tpl.door.width;
        } else if (preferDouble && doubleWidth !== undefined && b - a >= doublePassMin - EPS) {
          const doubleCenter = pickOpeningCenter(rng, { axis: sh.axis, c: sh.c, lo: a, hi: b }, doubleWidth, margin, t, lvRects, existing, s);
          if (doubleCenter !== null) {
            openings.push({
              id: `op${openings.length}`,
              level: ra.level,
              floorY: ra.floorY,
              roomA: rb.id,
              roomB: ra.id,
              style,
              kind,
              margin,
              alwaysUnlocked: kind === 'front' || ra.coreId !== undefined || rb.coreId !== undefined,
              double: true,
              axis: sh.axis,
              c: sh.c,
              center: doubleCenter,
              width: doubleWidth,
            });
            placed = true;
            break;
          }
        }
        const center = pickOpeningCenter(rng, { axis: sh.axis, c: sh.c, lo: a, hi: b }, width, margin, t, lvRects, existing, s);
        if (center === null) continue;
        openings.push({
          id: `op${openings.length}`,
          level: ra.level,
          floorY: ra.floorY,
          roomA: rb.id,
          roomB: ra.id,
          style,
          kind,
          margin,
          alwaysUnlocked: kind === 'front' || ra.coreId !== undefined || rb.coreId !== undefined,
          axis: sh.axis,
          c: sh.c,
          center,
          width,
        });
        placed = true;
        break;
      }
      if (!placed) return null;
    }

    // 包含・面積比・非階段室（構成の自己検査）
    const lvRooms = (lv: StoryLevel): PlacedRoom[] => rooms.filter((r) => r.level === lv && !r.outdoor);
    const S1F = lvRooms(0).filter((r) => r.coreId || r.roofStyle === 'stackable').map((r) => r.rect);
    const I1F = lvRooms(0).map((r) => r.rect);
    const area = (rs: readonly Rect[]): number => rs.reduce((a, r) => a + rectArea(r), 0);
    for (const lv of levels) {
      if (lv === 0) continue;
      const rs = lvRooms(lv);
      if (!rs.some((r) => !r.coreId && r.category !== 'corridor' && r.category !== 'entry')) return null;
      for (const r of rs) if (!rectCoveredBy(r.rect, lv === 1 ? S1F : I1F)) return null;
      const ratio = lv === 1 ? profile.upperFloorRatio : profile.basementRatio;
      const base = area(lv === 1 ? S1F : I1F);
      if (!ratio) return null;
      const q = area(rs.map((r) => r.rect)) / base;
      if (q < ratio.min - EPS || q > ratio.max + EPS) return null;
    }
    for (const lv of levels) {
      const rs = rooms.filter((r) => r.level === lv);
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rectsOverlap((rs[i] as PlacedRoom).rect, (rs[j] as PlacedRoom).rect)) return null;
    }

    const front = openings.find((o) => o.kind === 'front') as PlacedOpening;
    const spawn = { x: front.center, y: 0, z: Math.max(approachDepth / 2, approachDepth - tpl.site.spawnSetback), yaw: 0 };
    const all = bboxOf(rooms.map((r) => r.rect));
    const pm = ceilTo(tpl.site.perimeterMargin, s);
    const treeEdges: { a: string; b: string; style: PlannedEdgeStyle }[] = edges.map((e) => ({ a: e.a, b: e.b, style: e.style }));
    return {
      templateId: tpl.id,
      profileId: profile.id,
      levels: [...levels],
      storyRise: rise,
      snap: s,
      wallThickness: t,
      perimeterMargin: tpl.site.perimeterMargin,
      rooms,
      openings,
      stairCores,
      stairLinks,
      treeEdges,
      approachRoomId: FRONT_APPROACH_ID,
      spawn,
      lotRect: { x0: all.x0 - pm, z0: all.z0 - pm, x1: all.x1 + pm, z1: all.z1 + pm },
      loopsAdded: levels.map((lv) => ({ level: lv, count: 0 })),
      beta1F: levelBetti(rooms, openings, 0),
      droppedModules: [],
      transform: null,
    };
  }
}

// ---------------------------------------------------------------- 公開入口

const feasibilityCache = new WeakMap<ModularGeneratorTemplate, Set<number>>();

/** 最小構成器の人物同時配置（家具・外窓なし = keepOut が乱数に依存しない条件）の成立を確かめる */
function fallbackAccept(tpl: ModularGeneratorTemplate, profile: StoryProfileDef, doorLeafHeight: number): (layout: PlacedBuildingLayout) => boolean {
  return (layout) => {
    try {
      const frame = computeSiteFrame(layoutBounds(layout), layout.perimeterMargin, tpl.snap, 0, false);
      compileLayout({ tpl, profile, layout, frame, doorLeafHeight, mapId: '__verify__', seed: 0 }, new Rng(FALLBACK_VERIFY_SEED), {
        fallback: true,
        bare: true,
        attemptsUsed: 1,
        retryReasons: [],
      });
      return true;
    } catch (err) {
      if (err instanceof FallbackInfeasibleError) return false;
      throw err;
    }
  };
}

/** 最小構成（人物の同時配置まで成立するもの）を作る */
function safeMinimalFor(tpl: ModularGeneratorTemplate, profile: StoryProfileDef, doorLeafHeight: number): PlacedBuildingLayout {
  return buildSafeMinimalModularLayout(tpl, profile, fallbackAccept(tpl, profile, doorLeafHeight));
}

/**
 * 重み > 0 の全階層プロファイルで最小構成器を実際に実行し、面積比・包含・階段・人物の同時配置・変換後整合の
 * いずれかが成立しなければ DataError（派生クラス FallbackInfeasibleError）を直接送出する。結果はテンプレートごとに記憶する。
 */
export function verifyFallbackFeasibility(tpl: ModularGeneratorTemplate, doorLeafHeight: number): void {
  const done = feasibilityCache.get(tpl);
  if (done?.has(doorLeafHeight)) return;
  for (const profile of tpl.storyProfiles) {
    if (profile.weight <= 0) continue;
    const layout = safeMinimalFor(tpl, profile, doorLeafHeight);
    // 変換後整合: 許可された変換（先頭の回転・反転あり）でも同じ構成がコンパイルできること
    const frame = computeSiteFrame(layoutBounds(layout), layout.perimeterMargin, tpl.snap, tpl.site.rotationsAllowed[0] ?? 0, tpl.site.mirrorAllowed);
    compileLayout({ tpl, profile, layout, frame, doorLeafHeight, mapId: '__verify__', seed: 0 }, new Rng(FALLBACK_VERIFY_SEED), {
      fallback: true,
      bare: true,
      attemptsUsed: 1,
      retryReasons: [],
    });
  }
  const set = done ?? new Set<number>();
  set.add(doorLeafHeight);
  feasibilityCache.set(tpl, set);
}

/** 生成本体（検査用メタデータつき）。 */
export function generateModularMapWithMeta(
  tpl: ModularGeneratorTemplate,
  seed: number,
  mapId: string,
  doorLeafHeight: number,
): ModularGenerationResult {
  if (!(doorLeafHeight >= 2.05)) throw new Error(`[generator:${tpl.id}] doorLeafHeight ${doorLeafHeight} は 2.05m 以上が必要です`);
  verifyFallbackFeasibility(tpl, doorLeafHeight);
  const normSeed = normalizeSeed(seed);
  // 階層プロファイルと敷地変換は試行ループの前に 1 回だけ選ぶ（以後降格・変更しない）
  const sel = new Rng((normSeed ^ SELECTION_SEED_XOR) >>> 0);
  const profile = pickStoryProfile(tpl, sel);
  const { rot, mirrorX } = pickSiteTransform(tpl.site.rotationsAllowed, tpl.site.mirrorAllowed, () => sel.next());
  const reasons: string[] = [];
  for (let attempt = 0; attempt < tpl.maxAttempts; attempt++) {
    const rng = new Rng((normSeed + Math.imul(attempt, 0x9e3779b1)) >>> 0);
    const ctxOf = (layout: PlacedBuildingLayout): CompileContext => ({
      tpl,
      profile,
      layout,
      frame: computeSiteFrame(layoutBounds(layout), layout.perimeterMargin, tpl.snap, rot, mirrorX),
      doorLeafHeight,
      mapId,
      seed: normSeed,
    });
    if (attempt < tpl.maxAttempts - 1) {
      try {
        const plan = planStoriesAndGraph(tpl, profile, rng);
        const layout = solveSpatialLayout(tpl, plan, rng);
        return compileLayout(ctxOf(layout), rng, { fallback: false, bare: false, attemptsUsed: attempt + 1, retryReasons: reasons });
      } catch (err) {
        if (!(err instanceof RetryGeneration)) throw err;
        reasons.push(`#${attempt}: ${err.message}`);
        continue;
      }
    }
    // 最終試行: 選択プロファイルを維持した決定論的最小構成。家具が格子点補填を塞いだときは家具・外窓なしで
    // コンパイルし直す（その条件での人物同時配置は verifyFallbackFeasibility で検証済み）
    const layout = safeMinimalFor(tpl, profile, doorLeafHeight);
    const ctx = ctxOf(layout);
    const fbOpts = (bare: boolean): CompileOptions => ({ fallback: true, bare, attemptsUsed: attempt + 1, retryReasons: reasons });
    try {
      return compileLayout(ctx, rng, fbOpts(false));
    } catch (err) {
      if (!(err instanceof FallbackInfeasibleError)) throw err;
      return compileLayout(ctx, new Rng((normSeed + Math.imul(attempt, 0x9e3779b1)) >>> 0), fbOpts(true));
    }
  }
  throw new Error(`[generator:${tpl.id}] maxAttempts ${tpl.maxAttempts} が不正です`);
}

/** type "modular" の生成（validateMap 互換の生データ）。 */
export function generateModularMap(tpl: ModularGeneratorTemplate, seed: number, mapId: string, doorLeafHeight: number): GeneratedMapRaw {
  return generateModularMapWithMeta(tpl, seed, mapId, doorLeafHeight).map;
}

/** 検査用: 同じ正準レイアウトを任意の変換枠でコンパイルする（TST-10 の写像一致検査に使う）。 */
export function compileModularLayoutForTest(
  tpl: ModularGeneratorTemplate,
  profile: StoryProfileDef,
  layout: PlacedBuildingLayout,
  rot: OrthogonalRotation,
  mirrorX: boolean,
  seed: number,
  doorLeafHeight: number,
): ModularGenerationResult {
  const frame = computeSiteFrame(layoutBounds(layout), layout.perimeterMargin, tpl.snap, rot, mirrorX);
  return compileLayout({ tpl, profile, layout, frame, doorLeafHeight, mapId: 'test', seed: normalizeSeed(seed) }, new Rng(normalizeSeed(seed)), {
    fallback: false,
    bare: false,
    attemptsUsed: 1,
    retryReasons: [],
  });
}
