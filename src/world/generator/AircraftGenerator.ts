import type {
  AircraftBlockDef,
  AircraftRoomDef,
  AircraftSeatingDef,
  AllyDef,
  BoxDef,
  DoorDef,
  EntityDef,
  GeneratedMapRaw,
  ModularFurnitureDef,
  NumRange,
  RoomDef,
  StairDef,
  WindowDef,
} from '../../core/types';
import { missionRoster } from '../../rules/MissionRoster';
import { RetryGeneration } from './GraphPlanner';
import { EPS, MAX_ENTITY_TRIES, MAX_FURNITURE_TRIES, buildWalls, inset, rectArea, rectsOverlap, round3, subtractRects, type LineAxis, type Opening, type Rect } from './Layout';
import { ALLY_SLOTS } from './ModularGenerator';
import { PlacementGrid } from './Placement';
import { Rng } from './Rng';
import {
  computeSiteFrame,
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
} from './SiteTransform';
import { OPENING_SIDE_PAD } from './SpatialSolver';

type DeckLevel = 'L' | 'M' | 'U';

interface InternalRoom {
  id: string;
  name: string;
  level: DeckLevel;
  floorY: number;
  rect: Rect;
  outdoor: boolean;
  spawnWeight: number;
  floorMaterial?: string;
  private: boolean;
  isStair: boolean;
  isCorridor: boolean;
  seating?: AircraftSeatingDef;
  furniture: readonly ModularFurnitureDef[];
}

interface InternalOpening extends Opening {
  id: string;
  level: DeckLevel;
  floorY: number;
  roomA: string;
  roomB: string;
  exterior: boolean;
  locked: boolean;
}

interface PlannedSegment {
  block: AircraftBlockDef;
  isSuite: boolean;
  compartments: {
    def?: AircraftRoomDef;
    stair?: 'up' | 'down';
    length: number;
  }[];
  /** head / entry / cabin の単一室 */
  singleDef?: AircraftRoomDef;
  length: number;
}

const HOSTAGE_NEAR = { min: 1.2, max: 2.6 };
const FACING_JITTER = 15;
const ENTITY_WALL_PAD = 0.05;
const INDOOR_FURNITURE_INSET = 0.04;
const ALLY_EDGE_PAD = 0.5;
const ALLY_KEEPOUT_HALF = 0.45;

const ceilTo = (v: number, s: number): number => round3(Math.ceil(v / s - 1e-9) * s);
const floorTo = (v: number, s: number): number => round3(Math.floor(v / s + 1e-9) * s);
const snapTo = (v: number, s: number): number => round3(Math.round(v / s) * s);

function snapLen(rng: Rng, r: NumRange, s: number): number {
  const lo = ceilTo(r.min, s);
  const hi = floorTo(r.max, s);
  if (hi <= lo) return round3(lo);
  const v = snapTo(rng.inRange(r), s);
  return round3(Math.min(hi, Math.max(lo, v)));
}

function boxFromBounds(x0: number, x1: number, z0: number, z1: number, y: number, height: number, material: string): BoxDef {
  const b: BoxDef = {
    x: round3((x0 + x1) / 2),
    z: round3((z0 + z1) / 2),
    width: round3(x1 - x0),
    depth: round3(z1 - z0),
    height: round3(height),
    material,
  };
  if (y !== 0) b.y = round3(y);
  return b;
}

function openingPoint(o: { axis: LineAxis; c: number; center: number }): { x: number; z: number } {
  return o.axis === 'x' ? { x: o.center, z: o.c } : { x: o.c, z: o.center };
}

function openingStrip(o: { axis: LineAxis; c: number; center: number }, half: number, d0: number, d1: number): Rect {
  return o.axis === 'x'
    ? { x0: o.center - half, x1: o.center + half, z0: o.c + d0, z1: o.c + d1 }
    : { x0: o.c + d0, x1: o.c + d1, z0: o.center - half, z1: o.center + half };
}

/**
 * 大統領専用機（Air Force One 風ジャンボ機）のランダム間取りを生成する。
 * 最大 3 デッキ（下部貨物室 L / メインデッキ M / 上部操縦室・通信デッキ U）と
 * 前後タラップ・胴体下ハッチ・主翼・エンジン・尾翼を格子スナップ単位で構築する。
 */
export function generateAircraft(
  tpl: import('../../core/types').AircraftGeneratorTemplate,
  seed: number,
  mapId: string,
  doorLeafHeight: number,
): GeneratedMapRaw {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < tpl.maxAttempts; attempt++) {
    const rng = new Rng((seed + Math.imul(attempt, 0x9e3779b1)) >>> 0);
    const isLastAttempt = attempt === tpl.maxAttempts - 1;
    try {
      return buildOnce(tpl, rng, seed, mapId, doorLeafHeight, isLastAttempt);
    } catch (err) {
      if (!(err instanceof RetryGeneration)) throw err;
      lastError = err;
    }
  }
  throw new Error(
    `[generator:${tpl.id}] seed=${seed}: ${tpl.maxAttempts} 回の試行で航空機マップを生成できませんでした (${lastError instanceof Error ? lastError.message : String(lastError)})`,
  );
}

function buildOnce(
  tpl: import('../../core/types').AircraftGeneratorTemplate,
  rng: Rng,
  seed: number,
  mapId: string,
  doorLeafHeight: number,
  isLastAttempt: boolean,
): GeneratedMapRaw {
  const t = tpl.wallThickness;
  const s = tpl.snap;
  const H = tpl.deckRise;
  const slab = tpl.slabThickness;
  const clear = round3(H - slab);
  const lintel = round3(Math.min(doorLeafHeight, clear));
  const fw = tpl.stairs.flightWidth;
  const steps = Math.round(H / tpl.stairs.rise);
  const stairRise = round3(H / steps);
  const stairRun = tpl.stairs.run;
  const flightLen = round3(steps * stairRun);
  const landing = tpl.stairs.landing;
  const Ls = ceilTo(flightLen + 2 * landing, s);

  const deckY: Record<DeckLevel, number> = { L: 0, M: H, U: round3(2 * H) };

  // 1. Picks
  const W = snapLen(rng, tpl.fuselage.width, s);
  const half = round3(W / 2);
  const cw = snapLen(rng, tpl.fuselage.corridorWidth, s);
  const S: 1 | -1 = rng.chance(0.5) ? 1 : -1;
  const cz0 = S === 1 ? round3(half - cw) : -half;
  const cz1 = S === 1 ? half : round3(-half + cw);
  const pz0 = S === 1 ? -half : round3(-half + cw);
  const pz1 = S === 1 ? round3(half - cw) : half;
  const stripBoundary = S === 1 ? cz0 : cz1;
  const corridorCenterZ = round3((cz0 + cz1) / 2);

  let upperOn = rng.chance(tpl.upperDeck.chance);
  let lowerOn = rng.chance(tpl.lowerDeck.chance);
  const aftWanted = rng.chance(tpl.airstair.aftChance);

  // 2. Main blocks
  const usedRoomCounts = new Map<string, number>();
  const segments: PlannedSegment[] = [];
  for (const block of tpl.mainDeck.blocks) {
    if (!rng.chance(block.chance)) continue;
    if (block.kind === 'suite') {
      const targetN = rng.intInRange(block.compartments!);
      const picked: AircraftRoomDef[] = [];
      for (const def of block.rooms) {
        const cur = usedRoomCounts.get(def.id) ?? 0;
        const need = Math.min(def.minCount, def.maxCount - cur);
        for (let k = 0; k < need && picked.length < targetN; k++) {
          picked.push(def);
          usedRoomCounts.set(def.id, (usedRoomCounts.get(def.id) ?? 0) + 1);
        }
      }
      while (picked.length < targetN) {
        const avail = block.rooms.filter((r) => (usedRoomCounts.get(r.id) ?? 0) < r.maxCount);
        const nextDef = rng.weighted(avail, (r) => r.weight);
        if (!nextDef) break;
        picked.push(nextDef);
        usedRoomCounts.set(nextDef.id, (usedRoomCounts.get(nextDef.id) ?? 0) + 1);
      }
      rng.shuffle(picked);
      const comps: PlannedSegment['compartments'] = picked.map((def) => ({
        def,
        length: snapLen(rng, def.length, s),
      }));
      if (block.hostsUpperStair && upperOn) {
        comps.push({ stair: 'up', length: Ls });
      }
      if (block.hostsLowerStair && lowerOn) {
        comps.unshift({ stair: 'down', length: Ls });
      }
      if (comps.length === 0) continue;
      segments.push({ block, isSuite: true, compartments: comps, length: 0 });
    } else {
      const def = rng.weighted(block.rooms, (r) => r.weight);
      if (!def) continue;
      segments.push({
        block,
        isSuite: false,
        compartments: [],
        singleDef: def,
        length: snapLen(rng, def.length, s),
      });
    }
  }

  if (!segments.some((seg) => seg.block.hostsUpperStair)) upperOn = false;
  if (!segments.some((seg) => seg.block.hostsLowerStair)) lowerOn = false;

  const totalLength = (): number => {
    let sum = 0;
    for (const seg of segments) {
      if (seg.isSuite) {
        for (const c of seg.compartments) sum += c.length;
      } else {
        sum += seg.length;
      }
    }
    return round3(sum);
  };

  // 3. Length fit
  while (totalLength() > tpl.fuselage.length.max + EPS) {
    let bestSlack = 0;
    let bestTarget: { kind: 'comp'; comp: PlannedSegment['compartments'][number] } | { kind: 'seg'; seg: PlannedSegment } | null = null;
    for (const seg of segments) {
      if (seg.isSuite) {
        for (const c of seg.compartments) {
          if (c.stair || !c.def) continue;
          const minL = ceilTo(c.def.length.min, s);
          const slack = round3(c.length - minL);
          if (slack >= s - EPS && slack > bestSlack) {
            bestSlack = slack;
            bestTarget = { kind: 'comp', comp: c };
          }
        }
      } else if (seg.singleDef) {
        const minL = ceilTo(seg.singleDef.length.min, s);
        const slack = round3(seg.length - minL);
        if (slack >= s - EPS && slack > bestSlack) {
          bestSlack = slack;
          bestTarget = { kind: 'seg', seg };
        }
      }
    }
    if (bestTarget) {
      if (bestTarget.kind === 'comp') bestTarget.comp.length = round3(bestTarget.comp.length - s);
      else bestTarget.seg.length = round3(bestTarget.seg.length - s);
      continue;
    }
    let dropped = false;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      if (seg.block.chance < 1 && !seg.block.hostsUpperStair && !seg.block.hostsLowerStair) {
        segments.splice(i, 1);
        dropped = true;
        break;
      }
    }
    if (!dropped) throw new RetryGeneration('胴体全長が上限を超えています');
  }

  const L = totalLength();
  if (L <= 0) throw new RetryGeneration('胴体全長が 0 です');

  // 4. Main layout (merge consecutive suite blocks into one suite run)
  const rooms: InternalRoom[] = [];
  const openings: InternalOpening[] = [];
  const grid = new PlacementGrid();
  const idCounts = new Map<string, number>();
  const nextRoomId = (defId: string, lv: DeckLevel): string => {
    const key = `${defId}_${lv}`;
    const idx = idCounts.get(key) ?? 0;
    idCounts.set(key, idx + 1);
    return `${key}_${idx}`;
  };
  let openingSeq = 0;
  const addDoor = (
    level: DeckLevel,
    axis: LineAxis,
    c: number,
    center: number,
    roomA: string,
    roomB: string,
    exterior = false,
  ): InternalOpening => {
    const op: InternalOpening = {
      id: `op_${openingSeq++}`,
      level,
      floorY: deckY[level],
      axis,
      c: round3(c),
      center: round3(center),
      width: tpl.door.width,
      roomA,
      roomB,
      exterior,
      locked: false,
    };
    openings.push(op);
    return op;
  };

  const pickCenterIn = (lo: number, hi: number, width: number): number | null => {
    const m = width / 2 + t / 2 + tpl.door.margin;
    const a = lo + m;
    const b = hi - m;
    if (b < a - EPS) return null;
    if (b - a < EPS) return round3((a + b) / 2);
    const raw = rng.range(a, b);
    return round3(Math.min(b, Math.max(a, snapTo(raw, s))));
  };

  interface MainUnit {
    kind: 'full' | 'suite_run';
    x0: number;
    x1: number;
    room?: InternalRoom;
    corridor?: InternalRoom;
    comps: InternalRoom[];
  }
  const mainUnits: MainUnit[] = [];
  let cursorX = 0;
  let fwdEntryRoom: InternalRoom | null = null;
  let aftEntryRoom: InternalRoom | null = null;
  let stairUpRect: Rect | null = null;
  let stairDownRect: Rect | null = null;

  for (let i = 0; i < segments.length; ) {
    const seg = segments[i]!;
    if (!seg.isSuite) {
      const def = seg.singleDef!;
      const x0 = cursorX;
      const x1 = round3(x0 + seg.length);
      cursorX = x1;
      const rm: InternalRoom = {
        id: nextRoomId(def.id, 'M'),
        name: def.name,
        level: 'M',
        floorY: deckY.M,
        rect: { x0, z0: -half, x1, z1: half },
        outdoor: false,
        spawnWeight: def.spawnWeight,
        floorMaterial: def.floorMaterial,
        private: def.private,
        isStair: false,
        isCorridor: false,
        seating: def.seating,
        furniture: def.furniture,
      };
      rooms.push(rm);
      mainUnits.push({ kind: 'full', x0, x1, room: rm, comps: [] });
      if (seg.block.kind === 'entry') {
        if (!fwdEntryRoom) fwdEntryRoom = rm;
        aftEntryRoom = rm;
      }
      i++;
    } else {
      const runStart = cursorX;
      const comps: InternalRoom[] = [];
      let compX = runStart;
      while (i < segments.length && segments[i]!.isSuite) {
        const sSeg = segments[i]!;
        for (const comp of sSeg.compartments) {
          const cx0 = compX;
          const cx1 = round3(cx0 + comp.length);
          compX = cx1;
          const rect: Rect = { x0: cx0, z0: pz0, x1: cx1, z1: pz1 };
          if (comp.stair === 'up') {
            stairUpRect = rect;
            const rm: InternalRoom = {
              id: 'stair_up_M',
              name: tpl.upperDeck.stairRoomName,
              level: 'M',
              floorY: deckY.M,
              rect,
              outdoor: false,
              spawnWeight: 0,
              floorMaterial: 'carpet',
              private: false,
              isStair: true,
              isCorridor: false,
              furniture: [],
            };
            rooms.push(rm);
            comps.push(rm);
          } else if (comp.stair === 'down') {
            stairDownRect = rect;
            const rm: InternalRoom = {
              id: 'stair_down_M',
              name: tpl.lowerDeck.stairRoomName,
              level: 'M',
              floorY: deckY.M,
              rect,
              outdoor: false,
              spawnWeight: 0,
              floorMaterial: 'carpet',
              private: false,
              isStair: true,
              isCorridor: false,
              furniture: [],
            };
            rooms.push(rm);
            comps.push(rm);
          } else {
            const def = comp.def!;
            const rm: InternalRoom = {
              id: nextRoomId(def.id, 'M'),
              name: def.name,
              level: 'M',
              floorY: deckY.M,
              rect,
              outdoor: false,
              spawnWeight: def.spawnWeight,
              floorMaterial: def.floorMaterial,
              private: def.private,
              isStair: false,
              isCorridor: false,
              seating: def.seating,
              furniture: def.furniture,
            };
            rooms.push(rm);
            comps.push(rm);
          }
        }
        i++;
      }
      cursorX = compX;
      const corr: InternalRoom = {
        id: nextRoomId('corridor', 'M'),
        name: tpl.fuselage.corridorName,
        level: 'M',
        floorY: deckY.M,
        rect: { x0: runStart, z0: cz0, x1: compX, z1: cz1 },
        outdoor: false,
        spawnWeight: tpl.fuselage.corridorSpawnWeight,
        floorMaterial: 'carpet',
        private: false,
        isStair: false,
        isCorridor: true,
        furniture: [],
      };
      rooms.push(corr);
      mainUnits.push({ kind: 'suite_run', x0: runStart, x1: compX, corridor: corr, comps });
    }
  }
  if (!fwdEntryRoom) throw new RetryGeneration('前方入口ブロックがありません');
  if (aftEntryRoom === fwdEntryRoom) aftEntryRoom = null;

  // 5. Main openings
  for (let i = 0; i < mainUnits.length; i++) {
    const u = mainUnits[i]!;
    if (u.kind === 'suite_run' && u.corridor) {
      for (const comp of u.comps) {
        const cx = pickCenterIn(comp.rect.x0, comp.rect.x1, tpl.door.width);
        if (cx === null) throw new RetryGeneration(`区画 ${comp.id} に扉を配置できません`);
        addDoor('M', 'x', stripBoundary, cx, comp.id, u.corridor.id);
      }
      for (let j = 0; j + 1 < u.comps.length; j++) {
        const a = u.comps[j]!;
        const b = u.comps[j + 1]!;
        if (a.private || b.private || a.isStair || b.isStair) continue;
        if (!rng.chance(tpl.door.extraDoorChance)) continue;
        const cz = pickCenterIn(pz0, pz1, tpl.door.width);
        if (cz !== null) addDoor('M', 'z', a.rect.x1, cz, a.id, b.id);
      }
    }
    if (i + 1 < mainUnits.length) {
      const next = mainUnits[i + 1]!;
      const wallX = u.x1;
      if (u.kind === 'full' && next.kind === 'full') {
        addDoor('M', 'z', wallX, 0, u.room!.id, next.room!.id);
      } else if (u.kind === 'full' && next.kind === 'suite_run') {
        addDoor('M', 'z', wallX, corridorCenterZ, u.room!.id, next.corridor!.id);
        const adjComp = next.comps[0];
        if (adjComp && !adjComp.private && !adjComp.isStair && rng.chance(tpl.door.extraDoorChance)) {
          const cz = pickCenterIn(pz0, pz1, tpl.door.width);
          if (cz !== null) addDoor('M', 'z', wallX, cz, u.room!.id, adjComp.id);
        }
      } else if (u.kind === 'suite_run' && next.kind === 'full') {
        addDoor('M', 'z', wallX, corridorCenterZ, u.corridor!.id, next.room!.id);
        const adjComp = u.comps[u.comps.length - 1];
        if (adjComp && !adjComp.private && !adjComp.isStair && rng.chance(tpl.door.extraDoorChance)) {
          const cz = pickCenterIn(pz0, pz1, tpl.door.width);
          if (cz !== null) addDoor('M', 'z', wallX, cz, adjComp.id, next.room!.id);
        }
      }
    }
  }

  // 6. Upper deck
  let upperEndX = 0;
  if (upperOn && stairUpRect) {
    const sx0 = stairUpRect.x0;
    const sx1 = stairUpRect.x1;
    let Lc = snapLen(rng, tpl.upperDeck.cockpit.length, s);
    const g = round3(sx0 - Lc);
    if (g < 3) Lc = sx0;
    if (Lc < 3) throw new RetryGeneration('操縦室長さが不足しています');

    const cockpitDef = tpl.upperDeck.cockpit;
    const cockpit: InternalRoom = {
      id: nextRoomId(cockpitDef.id, 'U'),
      name: cockpitDef.name,
      level: 'U',
      floorY: deckY.U,
      rect: { x0: 0, z0: -half, x1: Lc, z1: half },
      outdoor: false,
      spawnWeight: cockpitDef.spawnWeight,
      floorMaterial: cockpitDef.floorMaterial,
      private: cockpitDef.private,
      isStair: false,
      isCorridor: false,
      seating: cockpitDef.seating,
      furniture: cockpitDef.furniture,
    };
    rooms.push(cockpit);

    const upperComps: InternalRoom[] = [];
    if (sx0 > Lc + EPS) {
      const fwdSpan = round3(sx0 - Lc);
      if (fwdSpan <= 6.5 + EPS) {
        const def = rng.weighted(tpl.upperDeck.forward, (r) => r.weight)!;
        const rm: InternalRoom = {
          id: nextRoomId(def.id, 'U'),
          name: def.name,
          level: 'U',
          floorY: deckY.U,
          rect: { x0: Lc, z0: pz0, x1: sx0, z1: pz1 },
          outdoor: false,
          spawnWeight: def.spawnWeight,
          floorMaterial: def.floorMaterial,
          private: def.private,
          isStair: false,
          isCorridor: false,
          seating: def.seating,
          furniture: def.furniture,
        };
        rooms.push(rm);
        upperComps.push(rm);
      } else {
        const splitMin = round3(Lc + 3);
        const splitMax = round3(sx0 - 3);
        const split = round3(Math.min(splitMax, Math.max(splitMin, snapTo(rng.range(splitMin, splitMax), s))));
        const firstDef = rng.weighted(tpl.upperDeck.forward, (r) => r.weight)!;
        const remainPool = tpl.upperDeck.forward.filter((r) => r.id !== firstDef.id);
        const secondDef = rng.weighted(remainPool.length > 0 ? remainPool : tpl.upperDeck.forward, (r) => r.weight)!;
        for (const [def, rx0, rx1] of [
          [firstDef, Lc, split],
          [secondDef, split, sx0],
        ] as const) {
          const rm: InternalRoom = {
            id: nextRoomId(def.id, 'U'),
            name: def.name,
            level: 'U',
            floorY: deckY.U,
            rect: { x0: rx0, z0: pz0, x1: rx1, z1: pz1 },
            outdoor: false,
            spawnWeight: def.spawnWeight,
            floorMaterial: def.floorMaterial,
            private: def.private,
            isStair: false,
            isCorridor: false,
            seating: def.seating,
            furniture: def.furniture,
          };
          rooms.push(rm);
          upperComps.push(rm);
        }
      }
    }

    const stairUpU: InternalRoom = {
      id: 'stair_up_U',
      name: tpl.upperDeck.stairRoomUpperName,
      level: 'U',
      floorY: deckY.U,
      rect: { ...stairUpRect },
      outdoor: false,
      spawnWeight: 0,
      floorMaterial: 'carpet',
      private: false,
      isStair: true,
      isCorridor: false,
      furniture: [],
    };
    rooms.push(stairUpU);
    upperComps.push(stairUpU);

    let Ux1 = sx1;
    if (rng.chance(tpl.upperDeck.aftChance)) {
      const aftDef = rng.weighted(tpl.upperDeck.aft, (r) => r.weight);
      if (aftDef) {
        const La = snapLen(rng, aftDef.length, s);
        if (sx1 + La <= L - 7) {
          Ux1 = round3(sx1 + La);
          const rm: InternalRoom = {
            id: nextRoomId(aftDef.id, 'U'),
            name: aftDef.name,
            level: 'U',
            floorY: deckY.U,
            rect: { x0: sx1, z0: pz0, x1: Ux1, z1: pz1 },
            outdoor: false,
            spawnWeight: aftDef.spawnWeight,
            floorMaterial: aftDef.floorMaterial,
            private: aftDef.private,
            isStair: false,
            isCorridor: false,
            seating: aftDef.seating,
            furniture: aftDef.furniture,
          };
          rooms.push(rm);
          upperComps.push(rm);
        }
      }
    }
    upperEndX = Ux1;

    const corrU: InternalRoom = {
      id: nextRoomId('corridor', 'U'),
      name: tpl.upperDeck.corridorName,
      level: 'U',
      floorY: deckY.U,
      rect: { x0: Lc, z0: cz0, x1: Ux1, z1: cz1 },
      outdoor: false,
      spawnWeight: tpl.fuselage.corridorSpawnWeight,
      floorMaterial: 'carpet',
      private: false,
      isStair: false,
      isCorridor: true,
      furniture: [],
    };
    rooms.push(corrU);

    addDoor('U', 'z', Lc, corridorCenterZ, cockpit.id, corrU.id);
    for (const comp of upperComps) {
      const cx = pickCenterIn(comp.rect.x0, comp.rect.x1, tpl.door.width);
      if (cx === null) throw new RetryGeneration(`上部区画 ${comp.id} に扉を配置できません`);
      addDoor('U', 'x', stripBoundary, cx, comp.id, corrU.id);
    }
    const firstFwd = upperComps[0];
    if (firstFwd && !firstFwd.isStair && !firstFwd.private && rng.chance(tpl.door.extraDoorChance)) {
      const cz = pickCenterIn(pz0, pz1, tpl.door.width);
      if (cz !== null) addDoor('U', 'z', Lc, cz, cockpit.id, firstFwd.id);
    }
  } else {
    upperOn = false;
  }

  // 7. Lower deck
  const lowerRoomRects: Rect[] = [];
  let lowerHoldForHatch: InternalRoom | null = null;
  if (lowerOn && stairDownRect) {
    const sx0 = stairDownRect.x0;
    const sx1 = stairDownRect.x1;
    const stairDownL: InternalRoom = {
      id: 'stair_down_L',
      name: tpl.lowerDeck.stairRoomLowerName,
      level: 'L',
      floorY: deckY.L,
      rect: { ...stairDownRect },
      outdoor: false,
      spawnWeight: 0,
      floorMaterial: 'carpet',
      private: false,
      isStair: true,
      isCorridor: false,
      furniture: [],
    };
    const corrL: InternalRoom = {
      id: nextRoomId('corridor', 'L'),
      name: tpl.lowerDeck.passageName,
      level: 'L',
      floorY: deckY.L,
      rect: { x0: sx0, z0: cz0, x1: sx1, z1: cz1 },
      outdoor: false,
      spawnWeight: tpl.fuselage.corridorSpawnWeight,
      floorMaterial: 'metal',
      private: false,
      isStair: false,
      isCorridor: true,
      furniture: [],
    };
    rooms.push(stairDownL, corrL);
    lowerRoomRects.push(stairDownL.rect, corrL.rect);

    const stairDoorX = pickCenterIn(sx0, sx1, tpl.door.width);
    if (stairDoorX === null) throw new RetryGeneration('下部階段室に扉を配置できません');
    addDoor('L', 'x', stripBoundary, stairDoorX, stairDownL.id, corrL.id);

    let aftHold: InternalRoom | null = null;
    const aftDef = rng.weighted(tpl.lowerDeck.aftHold, (r) => r.weight);
    if (aftDef) {
      const La = snapLen(rng, aftDef.length, s);
      const ax1 = floorTo(Math.min(sx1 + La, L - 1), s);
      if (ax1 - sx1 >= 4 - EPS) {
        aftHold = {
          id: nextRoomId(aftDef.id, 'L'),
          name: aftDef.name,
          level: 'L',
          floorY: deckY.L,
          rect: { x0: sx1, z0: -half, x1: ax1, z1: half },
          outdoor: false,
          spawnWeight: aftDef.spawnWeight,
          floorMaterial: aftDef.floorMaterial,
          private: aftDef.private,
          isStair: false,
          isCorridor: false,
          seating: aftDef.seating,
          furniture: aftDef.furniture,
        };
        rooms.push(aftHold);
        lowerRoomRects.push(aftHold.rect);
        addDoor('L', 'z', sx1, corridorCenterZ, corrL.id, aftHold.id);
      }
    }

    let foreHold: InternalRoom | null = null;
    if (rng.chance(tpl.lowerDeck.foreChance)) {
      const foreDef = rng.weighted(tpl.lowerDeck.foreHold, (r) => r.weight);
      if (foreDef) {
        const Lf = snapLen(rng, foreDef.length, s);
        const fx0 = ceilTo(Math.max(sx0 - Lf, 1), s);
        if (sx0 - fx0 >= 4 - EPS) {
          foreHold = {
            id: nextRoomId(foreDef.id, 'L'),
            name: foreDef.name,
            level: 'L',
            floorY: deckY.L,
            rect: { x0: fx0, z0: -half, x1: sx0, z1: half },
            outdoor: false,
            spawnWeight: foreDef.spawnWeight,
            floorMaterial: foreDef.floorMaterial,
            private: foreDef.private,
            isStair: false,
            isCorridor: false,
            seating: foreDef.seating,
            furniture: foreDef.furniture,
          };
          rooms.push(foreHold);
          lowerRoomRects.push(foreHold.rect);
          addDoor('L', 'z', sx0, corridorCenterZ, foreHold.id, corrL.id);
        }
      }
    }
    lowerHoldForHatch = aftHold ?? foreHold;
  } else {
    lowerOn = false;
  }

  // 8. Stair links
  const stairs: StairDef[] = [];
  const guardWalls: BoxDef[] = [];
  const holesByLevel: Record<DeckLevel, Rect[]> = { L: [], M: [], U: [] };
  const stairLinks: { a: string; b: string }[] = [];

  const addStairLink = (id: string, R: Rect, lowerY: number, upperY: number, upperLevel: DeckLevel): void => {
    const flightZ0 = S === 1 ? round3(-half + t / 2) : round3(half - t / 2 - fw);
    const flightZ1 = S === 1 ? round3(flightZ0 + fw) : round3(half - t / 2);
    const zi = S === 1 ? flightZ1 : flightZ0;
    const zc = round3((flightZ0 + flightZ1) / 2);
    const fx1 = round3(R.x1 - landing);
    const fx0 = round3(fx1 - flightLen);
    const st: StairDef = {
      id,
      x: round3((fx0 + fx1) / 2),
      z: zc,
      yaw: 90,
      width: fw,
      steps,
      rise: stairRise,
      run: stairRun,
    };
    if (lowerY !== 0) st.y = round3(lowerY);
    stairs.push(st);

    const hole: Rect =
      S === 1 ? { x0: fx0, z0: -half, x1: fx1, z1: zi } : { x0: fx0, z0: zi, x1: fx1, z1: half };
    holesByLevel[upperLevel].push(hole);

    // Guard walls on upper level
    const longGuard =
      S === 1
        ? boxFromBounds(fx0, round3(fx1 + t), zi, round3(zi + t), upperY, tpl.stairs.parapetHeight, 'panel')
        : boxFromBounds(fx0, round3(fx1 + t), round3(zi - t), zi, upperY, tpl.stairs.parapetHeight, 'panel');
    const lowEndGuard = boxFromBounds(fx1, round3(fx1 + t), flightZ0, flightZ1, upperY, tpl.stairs.parapetHeight, 'panel');
    guardWalls.push(longGuard, lowEndGuard);

    // Keep-outs for furniture & entity placement
    grid.addKeepOut(
      {
        x0: Math.max(R.x0, round3(fx0 - 1)),
        x1: Math.min(R.x1, round3(fx1 + 1)),
        z0: round3(flightZ0 - 0.3),
        z1: round3(flightZ1 + 0.3),
      },
      lowerY,
    );
    grid.addKeepOut(
      {
        x0: round3(hole.x0 - 0.3),
        x1: round3(hole.x1 + 0.3),
        z0: round3(hole.z0 - 0.3),
        z1: round3(hole.z1 + 0.3),
      },
      upperY,
    );
    grid.addKeepOut(
      {
        x0: round3(fx0 - 1),
        x1: fx0,
        z0: flightZ0,
        z1: flightZ1,
      },
      upperY,
    );
  };

  if (upperOn && stairUpRect) {
    addStairLink('stair_up', stairUpRect, deckY.M, deckY.U, 'U');
    stairLinks.push({ a: 'stair_up_M', b: 'stair_up_U' });
  }
  if (lowerOn && stairDownRect) {
    addStairLink('stair_down', stairDownRect, deckY.L, deckY.M, 'M');
    stairLinks.push({ a: 'stair_down_M', b: 'stair_down_L' });
  }

  // 9. Exterior doors, wings, airstairs, belly hatch
  const pw = tpl.airstair.platformWidth;
  const pd = tpl.airstair.platformDepth;
  const aw = tpl.airstair.width;
  const fwdDoorX = snapTo((fwdEntryRoom.rect.x0 + fwdEntryRoom.rect.x1) / 2, s);
  const platformSlabs: BoxDef[] = [];
  const airstairDecor: BoxDef[] = [];
  const airstairFootprints: Rect[] = [];
  const airstairLinks: { platformId: string }[] = [];
  const airstairDoorXs: number[] = [];

  const addAirstair = (stairId: string, platformId: string, platformName: string, entryRoomId: string, doorX: number): void => {
    addDoor('M', 'x', half, doorX, entryRoomId, platformId, true);
    const platRect: Rect = {
      x0: round3(doorX - pw / 2),
      z0: half,
      x1: round3(doorX + pw / 2),
      z1: round3(half + pd),
    };
    rooms.push({
      id: platformId,
      name: platformName,
      level: 'M',
      floorY: deckY.M,
      rect: platRect,
      outdoor: true,
      spawnWeight: 0,
      private: false,
      isStair: false,
      isCorridor: false,
      furniture: [],
    });
    platformSlabs.push(boxFromBounds(platRect.x0, platRect.x1, platRect.z0, platRect.z1, round3(H - slab), slab, 'metal'));
    stairs.push({
      id: stairId,
      x: doorX,
      z: round3(half + pd + flightLen / 2),
      yaw: 0,
      width: aw,
      steps,
      rise: stairRise,
      run: stairRun,
    });
    // Platform guard rails
    const zRailStart = round3(half + t / 2);
    const zRailEnd = round3(half + pd);
    const railH = tpl.stairs.parapetHeight;
    guardWalls.push(
      boxFromBounds(platRect.x0, round3(platRect.x0 + 0.1), zRailStart, zRailEnd, deckY.M, railH, 'metal'),
      boxFromBounds(round3(platRect.x1 - 0.1), platRect.x1, zRailStart, zRailEnd, deckY.M, railH, 'metal'),
      boxFromBounds(round3(platRect.x0 + 0.1), round3(doorX - aw / 2), round3(zRailEnd - 0.1), zRailEnd, deckY.M, railH, 'metal'),
      boxFromBounds(round3(doorX + aw / 2), round3(platRect.x1 - 0.1), round3(zRailEnd - 0.1), zRailEnd, deckY.M, railH, 'metal'),
    );
    // Support column box under platform
    airstairDecor.push(boxFromBounds(platRect.x0, platRect.x1, zRailStart, zRailEnd, 0, clear, 'metal'));
    airstairFootprints.push({
      x0: platRect.x0,
      x1: platRect.x1,
      z0: half,
      z1: round3(half + pd + flightLen),
    });
    airstairLinks.push({ platformId });
    airstairDoorXs.push(doorX);
  };

  addAirstair('airstair_fwd', 'airstair_fwd_platform', '前方タラップ上', fwdEntryRoom.id, fwdDoorX);

  // Wings (computed before aft airstair)
  const wingBoxes: BoxDef[] = [];
  const wingXRanges: [number, number][] = [];
  const xw = snapTo(Math.max(0.42 * L, fwdDoorX + pw / 2 + 3), s);
  const span = tpl.exterior.wingSpan;
  const chord = tpl.exterior.wingChord;
  for (let k = 0; k < 3; k++) {
    const wx0 = round3(xw + 2.5 * k);
    const wx1 = round3(wx0 + chord * (1 - 0.25 * k));
    const wz0 = round3(k === 0 ? half + t / 2 : half + (k * span) / 3);
    const wz1 = round3(half + ((k + 1) * span) / 3);
    const wy = round3(2.3 + 0.15 * k);
    wingXRanges.push([wx0, wx1]);
    wingBoxes.push(
      boxFromBounds(wx0, wx1, wz0, wz1, wy, 0.45, 'metal'),
      boxFromBounds(wx0, wx1, -wz1, -wz0, wy, 0.45, 'metal'),
    );
  }

  if (aftWanted && aftEntryRoom) {
    const aftDoorX = snapTo((aftEntryRoom.rect.x0 + aftEntryRoom.rect.x1) / 2, s);
    const pLo = aftDoorX - pw / 2 - 1;
    const pHi = aftDoorX + pw / 2 + 1;
    const overlapsWing = wingXRanges.some(([wx0, wx1]) => pLo < wx1 && wx0 < pHi);
    if (!overlapsWing) {
      addAirstair('airstair_aft', 'airstair_aft_platform', '後方タラップ上', aftEntryRoom.id, aftDoorX);
    }
  }

  let hatchRect: Rect | null = null;
  if (lowerOn && lowerHoldForHatch && rng.chance(tpl.lowerDeck.hatchChance)) {
    for (let k = 0; k < 8; k++) {
      const hx = pickCenterIn(lowerHoldForHatch.rect.x0, lowerHoldForHatch.rect.x1, tpl.door.width);
      if (hx === null) break;
      if (airstairDoorXs.some((dx) => Math.abs(hx - dx) < pw / 2 + 2)) continue;
      addDoor('L', 'x', half, hx, lowerHoldForHatch.id, 'apron_approach', true);
      hatchRect = { x0: round3(hx - 1.5), x1: round3(hx + 1.5), z0: half, z1: round3(half + 2.5) };
      break;
    }
  }

  // 10. Spawn and allies
  const spawn = {
    x: fwdDoorX,
    y: 0,
    z: round3(half + pd + flightLen + tpl.site.spawnSetback),
    yaw: 0,
  };
  let indoorSq = 0;
  for (const r of rooms) if (!r.outdoor) indoorSq += rectArea(r.rect);
  const allyN = Math.max(0, missionRoster(indoorSq).swat - 1);
  const allies: AllyDef[] = [];
  for (const a of ALLY_SLOTS.slice(0, allyN)) {
    const ax = round3(spawn.x + a.side * tpl.site.allyLateralOffset);
    let az = round3(spawn.z + tpl.site.allyBackOffset + a.back);
    for (let g = 0; allies.some((o) => Math.hypot(o.x - ax, o.z - az) < 0.7) && g < 6; g++) {
      az = round3(az + 0.45);
    }
    allies.push({ id: a.id, name: a.name, x: ax, z: az, yaw: 0 });
  }

  // 11. Lot & Apron
  const lotBounds: Rect = {
    x0: -4.5 - tpl.site.margin,
    z0: -(half + span + tpl.site.margin),
    x1: L + 3 + tpl.site.margin,
    z1: Math.max(half + span, spawn.z + 3) + tpl.site.margin,
  };
  const { rot, mirrorX } = pickSiteTransform(tpl.site.rotationsAllowed, tpl.site.mirrorAllowed, () => rng.next());
  const frame = computeSiteFrame(lotBounds, 0, s, rot, mirrorX);
  const lot: Rect = {
    x0: round3((-frame.halfW - frame.dX) * s),
    z0: round3((-frame.halfD - frame.dZ) * s),
    x1: round3((frame.halfW - frame.dX) * s),
    z1: round3((frame.halfD - frame.dZ) * s),
  };
  const apronRect: Rect = { x0: lot.x0, z0: half, x1: lot.x1, z1: lot.z1 };
  const ar = inset(apronRect, ALLY_EDGE_PAD);
  for (const a of allies) {
    a.x = round3(Math.min(ar.x1, Math.max(ar.x0, a.x)));
    a.z = round3(Math.min(ar.z1, Math.max(ar.z0, a.z)));
    grid.addKeepOut({ x0: a.x - ALLY_KEEPOUT_HALF, z0: a.z - ALLY_KEEPOUT_HALF, x1: a.x + ALLY_KEEPOUT_HALF, z1: a.z + ALLY_KEEPOUT_HALF }, 0);
  }
  rooms.push({
    id: 'apron_approach',
    name: tpl.site.approachName,
    level: 'L',
    floorY: 0,
    rect: apronRect,
    outdoor: true,
    spawnWeight: 0,
    private: false,
    isStair: false,
    isCorridor: false,
    furniture: [],
  });

  // 12. Locks
  let lockedCount = 0;
  for (const op of rng.shuffle(openings.filter((o) => !o.exterior))) {
    if (lockedCount >= tpl.door.maxLocked) break;
    if (rng.chance(tpl.door.lockedChance)) {
      op.locked = true;
      lockedCount++;
    }
  }

  // 13. Windows (levels M and U only)
  const windows: WindowDef[] = [];
  const windowOpeningsByLevel: Record<DeckLevel, Opening[]> = { L: [], M: [], U: [] };
  if (tpl.window.chance > 0) {
    const ww = tpl.window.width;
    const wm = ww / 2 + t / 2 + tpl.door.margin;
    for (const r of rooms) {
      if (r.outdoor || r.isStair || (r.level !== 'M' && r.level !== 'U')) continue;
      const sides: { z: number; yaw: number }[] = [];
      if (Math.abs(r.rect.z1 - half) < EPS) sides.push({ z: half, yaw: 0 });
      if (Math.abs(r.rect.z0 - -half) < EPS) sides.push({ z: -half, yaw: 180 });
      if (sides.length === 0 || !rng.chance(tpl.window.chance)) continue;
      const len = r.rect.x1 - r.rect.x0;
      const k = Math.min(tpl.window.maxPerRoom, Math.max(1, Math.floor((len - 1) / tpl.window.spacing)));
      for (const side of sides) {
        for (let idx = 0; idx < k; idx++) {
          const cx = snapTo(r.rect.x0 + (len * (idx + 1)) / (k + 1), s);
          if (cx < r.rect.x0 + wm - EPS || cx > r.rect.x1 - wm + EPS) continue;
          const clash =
            openings.some((o) => o.level === r.level && o.axis === 'x' && Math.abs(o.c - side.z) < EPS && Math.abs(o.center - cx) < o.width / 2 + ww / 2 + 0.3) ||
            windowOpeningsByLevel[r.level].some((o) => Math.abs(o.c - side.z) < EPS && Math.abs(o.center - cx) < o.width / 2 + ww / 2 + 0.3);
          if (clash) continue;
          const op: Opening = { axis: 'x', c: side.z, center: cx, width: ww, window: { sill: tpl.window.sill, height: tpl.window.height } };
          windowOpeningsByLevel[r.level].push(op);
          windows.push({
            x: cx,
            z: side.z,
            yaw: side.yaw,
            width: ww,
            height: tpl.window.height,
            sill: tpl.window.sill,
            y: r.floorY,
          });
        }
      }
    }
  }

  // 14. Walls
  const fuselageRect: Rect = { x0: 0, z0: -half, x1: L, z1: half };
  const voidRects = subtractRects(fuselageRect, lowerRoomRects);
  const walls: BoxDef[] = [];
  const wallMaxX: Record<DeckLevel, number> = { L, M: L, U: upperEndX };
  const isOuterSkin = (b: BoxDef, maxX: number): boolean => {
    if (b.depth <= b.width + EPS) {
      return Math.abs(Math.abs(b.z) - half) < 0.25;
    }
    return Math.abs(b.x) < 0.25 || Math.abs(b.x - maxX) < 0.25;
  };
  for (const lv of ['L', 'M', 'U'] as const) {
    if (lv === 'U' && !upperOn) continue;
    const lvRects = lv === 'L' ? [...lowerRoomRects, ...voidRects] : rooms.filter((r) => !r.outdoor && r.level === lv).map((r) => r.rect);
    if (lvRects.length === 0) continue;
    const ops: Opening[] = [
      ...openings.filter((o) => o.level === lv).map((o) => ({ axis: o.axis, c: o.c, center: o.center, width: o.width, lintelY: lintel })),
      ...windowOpeningsByLevel[lv],
    ];
    const built = buildWalls(lvRects, ops, t, clear, deckY[lv]);
    const maxX = wallMaxX[lv];
    for (const w of built) {
      w.material = isOuterSkin(w, maxX) ? 'metal' : 'panel';
      walls.push(w);
    }
  }
  walls.push(...guardWalls);

  // 15. Floors
  const floors: BoxDef[] = [];
  const addSlab = (r: Rect, floorY: number, material: string): void => {
    const b: BoxDef = {
      x: round3((r.x0 + r.x1) / 2),
      z: round3((r.z0 + r.z1) / 2),
      y: round3(floorY - slab),
      width: round3(r.x1 - r.x0),
      depth: round3(r.z1 - r.z0),
      height: slab,
      material,
    };
    floors.push(b);
  };
  for (const piece of subtractRects(lot, lowerRoomRects)) {
    addSlab(piece, 0, 'concrete');
  }
  for (const r of rooms) {
    if (r.outdoor) continue;
    const mat = r.floorMaterial ?? 'carpet';
    for (const piece of subtractRects(r.rect, holesByLevel[r.level])) {
      addSlab(piece, r.floorY, mat);
    }
  }
  floors.push(...platformSlabs);

  // 16. Exterior decor covers (all plain metal)
  const coversBeforeProps: BoxDef[] = [
    // Nose steps
    boxFromBounds(-1.6, round3(-t / 2), round3(-(W - 0.8) / 2), round3((W - 0.8) / 2), 0.8, 4.6, 'metal'),
    boxFromBounds(-3.0, -1.6, round3(-(W - 2.2) / 2), round3((W - 2.2) / 2), 1.4, 3.4, 'metal'),
    boxFromBounds(-4.0, -3.0, round3(-(W - 3.6) / 2), round3((W - 3.6) / 2), 2.1, 2.0, 'metal'),
    // Tail cone
    boxFromBounds(round3(L + t / 2), round3(L + 2.5), round3(-(W - 2) / 2), round3((W - 2) / 2), 2.0, 3.5, 'metal'),
    // Vertical fin
    boxFromBounds(round3(L - 7), round3(L - 1), -0.25, 0.25, round3(H + clear + 0.3), tpl.exterior.finHeight, 'metal'),
    // Horizontal stabilizers
    boxFromBounds(round3(L - 6), round3(L - 2), round3(half + t / 2), round3(half + 8), 5.0, 0.35, 'metal'),
    boxFromBounds(round3(L - 6), round3(L - 2), round3(-(half + 8)), round3(-(half + t / 2)), 5.0, 0.35, 'metal'),
    ...wingBoxes,
    ...airstairDecor,
  ];
  if (tpl.exterior.engines) {
    const spawnZone: Rect = { x0: spawn.x - 3, z0: spawn.z - 3, x1: spawn.x + 3, z1: spawn.z + 3 };
    for (const frac of [0.33, 0.66]) {
      const k = Math.min(2, Math.floor(frac * 3));
      const segFront = round3(xw + 2.5 * k);
      const ex0 = round3(segFront - 2.0);
      const ex1 = round3(ex0 + 4.5);
      for (const side of [1, -1] as const) {
        const zc = round3(side * (half + span * frac));
        const ez0 = round3(zc - 1.1);
        const ez1 = round3(zc + 1.1);
        const expanded: Rect = { x0: ex0 - 1.5, z0: ez0 - 1.5, x1: ex1 + 1.5, z1: ez1 + 1.5 };
        if (rectsOverlap(expanded, spawnZone)) continue;
        if (airstairFootprints.some((fp) => rectsOverlap(expanded, fp))) continue;
        if (hatchRect && rectsOverlap(expanded, hatchRect)) continue;
        coversBeforeProps.push(boxFromBounds(ex0, ex1, ez0, ez1, 0.7, 1.6, 'metal'));
      }
    }
  }

  // 17. Furniture & Door keep-outs
  for (const o of openings) {
    const reach = tpl.door.width + tpl.door.swingClearance;
    grid.addKeepOut(openingStrip(o, o.width / 2 + OPENING_SIDE_PAD, -reach, reach), o.floorY);
  }
  for (const r of rooms) {
    if (r.outdoor || r.isStair || r.isCorridor) continue;
    const interior = inset(r.rect, t / 2 + INDOOR_FURNITURE_INSET);
    if (interior.x1 <= interior.x0 || interior.z1 <= interior.z0) continue;
    if (r.seating) {
      const sp = r.seating;
      for (let x = round3(interior.x0 + 1.75); x + sp.depth <= interior.x1 - 1.75 + EPS; x = round3(x + sp.pitch)) {
        const x1 = round3(x + sp.depth);
        const seatRects: Rect[] = [
          { x0: x, z0: round3(interior.z0), x1, z1: round3(interior.z0 + sp.width) },
          { x0: x, z0: round3(interior.z1 - sp.width), x1, z1: round3(interior.z1) },
        ];
        for (const sr of seatRects) {
          grid.placeBox(
            sr,
            {
              x: round3((sr.x0 + sr.x1) / 2),
              z: round3((sr.z0 + sr.z1) / 2),
              width: sp.width,
              depth: sp.depth,
              height: sp.height,
              yaw: 270,
              prop: sp.prop,
            },
            r.floorY,
            0,
          );
        }
      }
    }
    for (const f of r.furniture) {
      if (!rng.chance(f.chance)) continue;
      const n = rng.intInRange(f.count);
      for (let k = 0; k < n; k++) {
        grid.placeFurniture(rng, f, interior, tpl.furnitureGap, tpl.wallClearance, MAX_FURNITURE_TRIES, r.floorY);
      }
    }
  }

  // 18. Entities
  const entities = placeAircraftEntities(tpl, rng, grid, rooms, openings, fwdEntryRoom, spawn, indoorSq, isLastAttempt);

  // 19. RoomDefs (unique display names)
  const nameTotals = new Map<string, number>();
  for (const r of rooms) nameTotals.set(r.name, (nameTotals.get(r.name) ?? 0) + 1);
  const nameSeen = new Map<string, number>();
  const roomDefs: RoomDef[] = rooms.map((r) => {
    const n = (nameSeen.get(r.name) ?? 0) + 1;
    nameSeen.set(r.name, n);
    const displayName = (nameTotals.get(r.name) ?? 0) > 1 ? `${r.name}${n}` : r.name;
    const def: RoomDef = {
      id: r.id,
      name: displayName,
      x: round3((r.rect.x0 + r.rect.x1) / 2),
      z: round3((r.rect.z0 + r.rect.z1) / 2),
      width: round3(r.rect.x1 - r.rect.x0),
      depth: round3(r.rect.z1 - r.rect.z0),
      floorY: r.floorY,
    };
    if (r.outdoor) def.outdoor = true;
    else def.ceilingY = round3(r.floorY + clear);
    return def;
  });

  // 20. Reachability check (every indoor room connected to apron_approach)
  const parent = new Map<string, string>(rooms.map((r) => [r.id, r.id]));
  const find = (id: string): string => {
    let cur = id;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    let p = id;
    while (p !== cur) {
      const nxt = parent.get(p)!;
      parent.set(p, cur);
      p = nxt;
    }
    return cur;
  };
  const unite = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const o of openings) unite(o.roomA, o.roomB);
  for (const sl of stairLinks) unite(sl.a, sl.b);
  for (const al of airstairLinks) unite(al.platformId, 'apron_approach');

  const apronRoot = find('apron_approach');
  for (const r of rooms) {
    if (!r.outdoor && find(r.id) !== apronRoot) {
      throw new RetryGeneration(`区画 ${r.id} が駐機場エプロンから到達不能です`);
    }
  }

  // Doors
  const doorIds = new Set<string>();
  const doors: DoorDef[] = openings.map((o) => {
    const base = `door_${o.roomA}_${o.roomB}`;
    let id = base;
    for (let k = 2; doorIds.has(id); k++) id = `${base}_${k}`;
    doorIds.add(id);
    const p = openingPoint(o);
    const flip = rng.chance(0.5);
    const yaw = o.axis === 'x' ? (flip ? 180 : 0) : flip ? 270 : 90;
    const d: DoorDef = {
      id,
      x: p.x,
      z: p.z,
      yaw,
      locked: o.locked,
      maxAngle: tpl.door.maxAngle,
      width: o.width,
    };
    if (o.floorY !== 0) d.y = o.floorY;
    return d;
  });

  // 21. Briefing + SiteTransform output
  const nS = entities.filter((e) => e.type === 'suspect').length;
  const nC = entities.length - nS;
  const u = tpl.entities.briefingUncertainty;
  const est = (n: number): { min: number; max: number } => ({ min: Math.max(0, n - rng.int(0, u)), max: n + rng.int(0, u) });
  const summary = rng.pick(tpl.summaries) ?? tpl.summaries[0]!;
  const sw = swapsAxes(frame);
  const allCovers = [...coversBeforeProps, ...grid.covers];

  return {
    id: mapId,
    name: tpl.name,
    motif: 'air_force_one',
    seed,
    briefing: { summary, estimatedSuspects: est(nS), estimatedHostages: est(nC) },
    ceilingHeight: round3((upperOn ? 2 * H : H) + clear),
    storyHeight: clear,
    floor: lotSize(frame),
    playerSpawn: mapSpawn(frame, spawn),
    allies: allies.map((a) => mapFacing(frame, a)),
    walls: walls.map((b) => mapBox(frame, b)),
    doors: doors.map((d) => mapDoor(frame, d)),
    windows: windows.map((w) => mapWindow(frame, w)),
    covers: allCovers.map((b) => mapBox(frame, b)),
    entities: entities.map((e) => mapFacing(frame, e)),
    rooms: roomDefs.map((r) => {
      const p = mapPoint(frame, r.x, r.z);
      return { ...r, x: p.x, z: p.z, width: sw ? r.depth : r.width, depth: sw ? r.width : r.depth };
    }),
    floors: floors.map((b) => mapBox(frame, b)),
    stairs: stairs.map((st) => mapStair(frame, st)),
    items: [],
  };
}

function placeAircraftEntities(
  tpl: import('../../core/types').AircraftGeneratorTemplate,
  rng: Rng,
  grid: PlacementGrid,
  rooms: readonly InternalRoom[],
  openings: readonly InternalOpening[],
  fwdEntryRoom: InternalRoom,
  spawn: { x: number; y: number; z: number },
  indoorSq: number,
  isLastAttempt: boolean,
): EntityDef[] {
  const ec = tpl.entities;
  const t = tpl.wallThickness;
  const r = ec.clearance;
  const dist3 = (x: number, y: number, z: number): number => Math.hypot(x - spawn.x, y - spawn.y, z - spawn.z);

  interface SpawnRoom {
    room: InternalRoom;
    it: Rect;
  }
  const candidates: SpawnRoom[] = rooms
    .filter((rm) => !rm.outdoor && !rm.isStair && rm !== fwdEntryRoom && rm.spawnWeight > 0)
    .map((room) => ({ room, it: inset(room.rect, t / 2 + r + ENTITY_WALL_PAD) }))
    .filter((c) => c.it.x1 > c.it.x0 && c.it.z1 > c.it.z0);

  const roster = missionRoster(indoorSq);
  const nSuspects = roster.suspects;
  const nCivilians = roster.hostages;

  const okAt = (x: number, z: number, floorY: number, list: readonly EntityDef[]): boolean =>
    dist3(x, floorY, z) >= ec.minSpawnDistance - EPS && grid.canStand(x, z, r, list, ec.minEntitySeparation, floorY);

  const openingsOf = (room: InternalRoom): { x: number; z: number }[] =>
    openings.filter((o) => o.roomA === room.id || o.roomB === room.id).map(openingPoint);

  const yawToward = (x: number, z: number, room: InternalRoom): number => {
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

  const make = (type: 'suspect' | 'civilian', list: EntityDef[], x: number, z: number, room: InternalRoom, profile: string): EntityDef => {
    const n = list.filter((e) => e.type === type).length + 1;
    const e: EntityDef = {
      id: `${type}_${n}`,
      type,
      profile,
      x: round3(x),
      z: round3(z),
      yaw: type === 'suspect' ? yawToward(x, z, room) : round3(rng.range(0, 360)),
    };
    if (room.floorY !== 0) e.y = round3(room.floorY);
    return e;
  };

  const entities: EntityDef[] = [];
  const occupancy = new Map<InternalRoom, number>();
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

  const sCount = entities.filter((e) => e.type === 'suspect').length;
  const cCount = entities.length - sCount;
  if (sCount >= nSuspects && cCount >= nCivilians) return entities;
  if (isLastAttempt && sCount >= 1) return entities;
  throw new RetryGeneration(`人物を配置できません (容疑者 ${sCount}/${nSuspects}, 民間人 ${cCount}/${nCivilians})`);
}
