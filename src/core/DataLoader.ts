import type {
  ModularWindowConfigDef,
  CivilianParams,
  AIProfile,
  AIProfilesData,
  BoxDef,
  BriefingDef,
  BriefingRange,
  CombatParams,
  MobilityParams,
  ShieldParams,
  DoorConfig,
  DoorDef,
  AllyDef,
  EntityDef,
  ItemDef,
  StairDef,
  WindowDef,
  SquadConfig,
  FurnitureDef,
  GameData,
  HouseGeneratorTemplate,
  AnyGeneratorTemplate,
  ModularGeneratorTemplate,
  ModularFurnitureDef,
  StoryProfileDef,
  StoryLevel,
  ModuleCategory,
  ArchitecturalModuleDef,
  SubRoomSpec,
  AdjacencyRuleDef,
  OrthogonalRotation,
  ModularSnap,
  MapData,
  MoraleModifiers,
  MoveMode,
  NegotiationConfig,
  NumRange,
  PerceptionConfig,
  PlayerConfig,
  RoeConfig,
  RoomDef,
  RoomSlot,
  RoomTypeDef,
  ScoreKind,
  SpecialAreaDef,
  SquadElement,
  SquadOrder,
  StageEntry,
  StagesData,
  ThrowableDef,
  WeaponDef,
  WeaponsData,
} from './types';
import { generateMap, verifyFallbackFeasibility } from '../world/generator';

import { DataError } from './DataError';

/** JSON の取得失敗・検証失敗を表すエラー（定義は ./DataError。生成器と循環 import なしに共有するため独立ファイル）。 */
export { DataError };

class Reader {
  constructor(private readonly source: string) {}

  fail(path: string, detail: string): never {
    throw new DataError(this.source, path, detail);
  }

  obj(v: unknown, path: string): Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) this.fail(path, 'オブジェクトが必要です');
    return v as Record<string, unknown>;
  }

  arr(v: unknown, path: string, minLen = 0): unknown[] {
    if (!Array.isArray(v)) this.fail(path, '配列が必要です');
    if (v.length < minLen) this.fail(path, `要素数が ${minLen} 以上必要です (現在 ${v.length})`);
    return v;
  }

  str(o: Record<string, unknown>, key: string, path: string): string {
    const v = o[key];
    if (typeof v !== 'string' || v === '') this.fail(`${path}.${key}`, '空でない文字列が必要です');
    return v;
  }

  num(o: Record<string, unknown>, key: string, path: string, min = -Infinity, max = Infinity): number {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) this.fail(`${path}.${key}`, '有限の数値が必要です');
    if (v < min || v > max) this.fail(`${path}.${key}`, `値 ${v} は範囲 ${min}〜${max} 外です`);
    return v;
  }

  optNum(o: Record<string, unknown>, key: string, path: string, min = -Infinity, max = Infinity): number | undefined {
    return o[key] === undefined ? undefined : this.num(o, key, path, min, max);
  }

  bool(o: Record<string, unknown>, key: string, path: string): boolean {
    const v = o[key];
    if (typeof v !== 'boolean') this.fail(`${path}.${key}`, 'boolean が必要です');
    return v;
  }

  oneOf<T extends string>(o: Record<string, unknown>, key: string, path: string, allowed: readonly T[]): T {
    const v = o[key];
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      this.fail(`${path}.${key}`, `${allowed.join(' | ')} のいずれかが必要です`);
    }
    return v as T;
  }

  range(o: Record<string, unknown>, key: string, path: string): { min: number; max: number } {
    const r = this.obj(o[key], `${path}.${key}`);
    const p = `${path}.${key}`;
    const min = this.num(r, 'min', p, 0, 100);
    const max = this.num(r, 'max', p, 0, 100);
    if (min > max) this.fail(p, 'min は max 以下である必要があります');
    return { min, max };
  }

  uniqueIds(items: { id: string }[], path: string): void {
    const seen = new Set<string>();
    items.forEach((it, i) => {
      if (seen.has(it.id)) this.fail(`${path}[${i}].id`, `id "${it.id}" が重複しています`);
      seen.add(it.id);
    });
  }
}

function parseBox(r: Reader, v: unknown, path: string): BoxDef {
  const o = r.obj(v, path);
  const box: BoxDef = {
    x: r.num(o, 'x', path),
    z: r.num(o, 'z', path),
    width: r.num(o, 'width', path, 0.0001),
    height: r.num(o, 'height', path, 0.0001),
    depth: r.num(o, 'depth', path, 0.0001),
  };
  const yaw = r.optNum(o, 'yaw', path);
  if (yaw !== undefined) box.yaw = yaw;
  const y = r.optNum(o, 'y', path);
  if (y !== undefined) box.y = y;
  if (o.material !== undefined) box.material = r.str(o, 'material', path);
  return box;
}

function readBriefing(r: Reader, raw: unknown): BriefingDef | undefined {
  if (raw === undefined) return undefined;
  const b = r.obj(raw, 'briefing');
  const intRange = (key: string): BriefingRange => {
    const p = `briefing.${key}`;
    const rg = r.obj(b[key], p);
    const min = r.num(rg, 'min', p, 0);
    const max = r.num(rg, 'max', p, 0);
    if (!Number.isInteger(min)) r.fail(`${p}.min`, '整数が必要です');
    if (!Number.isInteger(max)) r.fail(`${p}.max`, '整数が必要です');
    if (min > max) r.fail(p, 'min は max 以下である必要があります');
    return { min, max };
  };
  let summary: string | undefined;
  if (b.summary !== undefined) {
    if (typeof b.summary !== 'string') r.fail('briefing.summary', '文字列が必要です');
    summary = b.summary;
  }
  const out: BriefingDef = {
    estimatedSuspects: intRange('estimatedSuspects'),
    estimatedHostages: intRange('estimatedHostages'),
  };
  if (summary !== undefined) out.summary = summary;
  return out;
}

/** validateMap 共通の最小有効天井高(m)。 */
const MIN_ROOM_CLEARANCE = 1.5;
/** 寸法の差で境界ちょうどの値を浮動小数点誤差で誤って拒否しないための許容差。 */
const DIM_TOL = 1e-9;

export function validateMap(raw: unknown, source = 'map'): MapData {
  const r = new Reader(source);
  const o = r.obj(raw, '');
  const spawn = r.obj(o.playerSpawn, 'playerSpawn');
  const floor = r.obj(o.floor, 'floor');
  const briefing = readBriefing(r, o.briefing);

  const doors: DoorDef[] = r.arr(o.doors, 'doors').map((d, i) => {
    const p = `doors[${i}]`;
    const e = r.obj(d, p);
    const door: DoorDef = {
      id: r.str(e, 'id', p),
      x: r.num(e, 'x', p),
      z: r.num(e, 'z', p),
      yaw: r.num(e, 'yaw', p),
      locked: r.bool(e, 'locked', p),
      maxAngle: r.num(e, 'maxAngle', p, 1, 180),
    };
    const w = r.optNum(e, 'width', p, 0.1);
    if (w !== undefined) door.width = w;
    const y = r.optNum(e, 'y', p);
    if (y !== undefined) door.y = y;
    if (e.double !== undefined) door.double = r.bool(e, 'double', p);
    return door;
  });
  r.uniqueIds(doors, 'doors');

  const entities: EntityDef[] = r.arr(o.entities, 'entities').map((d, i) => {
    const p = `entities[${i}]`;
    const e = r.obj(d, p);
    const ent: EntityDef = {
      id: r.str(e, 'id', p),
      type: r.oneOf(e, 'type', p, ['suspect', 'civilian'] as const),
      x: r.num(e, 'x', p),
      z: r.num(e, 'z', p),
    };
    if (e.profile !== undefined) ent.profile = r.str(e, 'profile', p);
    const hp = r.optNum(e, 'hp', p, 1);
    if (hp !== undefined) ent.hp = hp;
    const yaw = r.optNum(e, 'yaw', p);
    if (yaw !== undefined) ent.yaw = yaw;
    const y = r.optNum(e, 'y', p);
    if (y !== undefined) ent.y = y;
    return ent;
  });
  r.uniqueIds(entities, 'entities');

  const mapCeilingHeight = r.num(o, 'ceilingHeight', '', 1);
  const rooms: RoomDef[] = r.arr(o.rooms, 'rooms', 1).map((d, i) => {
    const p = `rooms[${i}]`;
    const e = r.obj(d, p);
    const room: RoomDef = {
      id: r.str(e, 'id', p),
      name: r.str(e, 'name', p),
      x: r.num(e, 'x', p),
      z: r.num(e, 'z', p),
      width: r.num(e, 'width', p, 0.0001),
      depth: r.num(e, 'depth', p, 0.0001),
    };
    const floorY = r.optNum(e, 'floorY', p);
    if (floorY !== undefined) room.floorY = floorY;
    if (e.outdoor !== undefined) room.outdoor = r.bool(e, 'outdoor', p);
    // ceilingY は絶対高さ（地下室では負になり得る）。有効天井高 = (ceilingY ?? ceilingHeight) - (floorY ?? 0)
    const ceilingY = r.optNum(e, 'ceilingY', p);
    if (ceilingY !== undefined) room.ceilingY = ceilingY;
    if (floorY !== undefined && floorY < 0 && room.outdoor !== true && ceilingY === undefined) {
      r.fail(`${p}.ceilingY`, '地下 (floorY < 0) の屋内室には ceilingY が必要です');
    }
    const clearance = (ceilingY ?? mapCeilingHeight) - (floorY ?? 0);
    if (clearance < MIN_ROOM_CLEARANCE - DIM_TOL) {
      r.fail(`${p}.ceilingY`, `有効天井高 ${clearance} が ${MIN_ROOM_CLEARANCE}m 未満です`);
    }
    return room;
  });
  r.uniqueIds(rooms, 'rooms');
  const seed = r.optNum(o, 'seed', '', 0, 0xffffffff);
  if (seed !== undefined && !Number.isInteger(seed)) r.fail('seed', '整数が必要です');
  const storyHeight = r.optNum(o, 'storyHeight', '', 1);
  const floors = o.floors === undefined ? [] : r.arr(o.floors, 'floors').map((w, i) => parseBox(r, w, `floors[${i}]`));
  const stairs = o.stairs === undefined ? [] : r.arr(o.stairs, 'stairs').map((d, i) => parseStair(r, d, i));
  const windows = o.windows === undefined ? [] : r.arr(o.windows, 'windows').map((d, i) => parseWindow(r, d, i));
  const items = o.items === undefined ? [] : r.arr(o.items, 'items').map((d, i) => parseItem(r, d, i));
  const allies = o.allies === undefined ? [] : r.arr(o.allies, 'allies').map((d, i) => parseAlly(r, d, i));
  r.uniqueIds(stairs, 'stairs');
  r.uniqueIds(items, 'items');
  r.uniqueIds(allies, 'allies');

  return {
    id: r.str(o, 'id', ''),
    name: r.str(o, 'name', ''),
    ...(briefing !== undefined ? { briefing } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(storyHeight !== undefined ? { storyHeight } : {}),
    ceilingHeight: mapCeilingHeight,
    floor: { width: r.num(floor, 'width', 'floor', 0.0001), depth: r.num(floor, 'depth', 'floor', 0.0001) },
    playerSpawn: {
      x: r.num(spawn, 'x', 'playerSpawn'),
      y: r.num(spawn, 'y', 'playerSpawn'),
      z: r.num(spawn, 'z', 'playerSpawn'),
      yaw: r.num(spawn, 'yaw', 'playerSpawn'),
    },
    walls: r.arr(o.walls, 'walls', 1).map((w, i) => parseBox(r, w, `walls[${i}]`)),
    doors,
    covers: r.arr(o.covers, 'covers').map((w, i) => parseBox(r, w, `covers[${i}]`)),
    entities,
    rooms,
    floors,
    stairs,
    windows,
    items,
    allies,
  };
}

const ITEM_KINDS = ['rifle', 'evidence', 'radio', 'flashbang', 'medkit'] as const;

function parseStair(r: Reader, v: unknown, i: number): StairDef {
  const p = `stairs[${i}]`;
  const e = r.obj(v, p);
  const stair: StairDef = {
    id: r.str(e, 'id', p),
    x: r.num(e, 'x', p),
    z: r.num(e, 'z', p),
    yaw: r.num(e, 'yaw', p),
    width: r.num(e, 'width', p, 0.4, 4),
    steps: r.num(e, 'steps', p, 2, 40),
    rise: r.num(e, 'rise', p, 0.05, 0.4),
    run: r.num(e, 'run', p, 0.15, 0.8),
  };
  if (!Number.isInteger(stair.steps)) r.fail(`${p}.steps`, '整数が必要です');
  const y = r.optNum(e, 'y', p);
  if (y !== undefined) stair.y = y;
  return stair;
}

function parseWindow(r: Reader, v: unknown, i: number): WindowDef {
  const p = `windows[${i}]`;
  const e = r.obj(v, p);
  const win: WindowDef = {
    x: r.num(e, 'x', p),
    z: r.num(e, 'z', p),
    yaw: r.num(e, 'yaw', p),
    width: r.num(e, 'width', p, 0.3, 4),
    height: r.num(e, 'height', p, 0.3, 2.5),
    sill: r.num(e, 'sill', p, 0, 2),
  };
  const y = r.optNum(e, 'y', p);
  if (y !== undefined) win.y = y;
  if (e.interior !== undefined) {
    if (typeof e.interior !== 'boolean') r.fail(`${p}.interior`, 'boolean が必要です');
    if (e.interior) win.interior = true;
  }
  return win;
}

function parseItem(r: Reader, v: unknown, i: number): ItemDef {
  const p = `items[${i}]`;
  const e = r.obj(v, p);
  const item: ItemDef = {
    id: r.str(e, 'id', p),
    kind: r.oneOf(e, 'kind', p, ITEM_KINDS),
    x: r.num(e, 'x', p),
    z: r.num(e, 'z', p),
  };
  const y = r.optNum(e, 'y', p);
  if (y !== undefined) item.y = y;
  const yaw = r.optNum(e, 'yaw', p);
  if (yaw !== undefined) item.yaw = yaw;
  return item;
}

function parseAlly(r: Reader, v: unknown, i: number): AllyDef {
  const p = `allies[${i}]`;
  const e = r.obj(v, p);
  const ally: AllyDef = {
    id: r.str(e, 'id', p),
    name: r.str(e, 'name', p),
    x: r.num(e, 'x', p),
    z: r.num(e, 'z', p),
  };
  const y = r.optNum(e, 'y', p);
  if (y !== undefined) ally.y = y;
  const yaw = r.optNum(e, 'yaw', p);
  if (yaw !== undefined) ally.yaw = yaw;
  return ally;
}

const STAGE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function validateStages(raw: unknown, source = 'stages'): StageEntry[] {
  const r = new Reader(source);
  const o = r.obj(raw, '') as Partial<StagesData>;
  const stages: StageEntry[] = r.arr(o.stages, 'stages', 1).map((d, i) => {
    const p = `stages[${i}]`;
    const e = r.obj(d, p);
    const id = r.str(e, 'id', p);
    if (!STAGE_ID_RE.test(id)) {
      r.fail(`${p}.id`, '英数字・ハイフン・アンダースコアのみ使用できます');
    }
    const name = r.str(e, 'name', p);
    const entry: StageEntry = { id, name };
    const desc = e.description;
    if (desc !== undefined) {
      if (typeof desc === 'string') {
        entry.description = desc;
      } else {
        r.fail(`${p}.description`, '文字列が必要です');
      }
    }
    if (e.generator !== undefined) {
      const gen = r.str(e, 'generator', p);
      if (!STAGE_ID_RE.test(gen)) r.fail(`${p}.generator`, '英数字・ハイフン・アンダースコアのみ使用できます');
      entry.generator = gen;
    }
    return entry;
  });
  r.uniqueIds(stages, 'stages');
  return stages;
}

// ---------- Generator templates ----------

function numRange(r: Reader, o: Record<string, unknown>, key: string, path: string, min = 0, max = Infinity): NumRange {
  const p = `${path}.${key}`;
  const g = r.obj(o[key], p);
  const lo = r.num(g, 'min', p, min, max);
  const hi = r.num(g, 'max', p, min, max);
  if (lo > hi) r.fail(p, 'min は max 以下である必要があります');
  return { min: lo, max: hi };
}

function intRange(r: Reader, o: Record<string, unknown>, key: string, path: string, min = 0, max = Infinity): NumRange {
  const rg = numRange(r, o, key, path, min, max);
  if (!Number.isInteger(rg.min) || !Number.isInteger(rg.max)) r.fail(`${path}.${key}`, '整数が必要です');
  return rg;
}

function strList(r: Reader, v: unknown, path: string, minLen = 0): string[] {
  return r.arr(v, path, minLen).map((s, i) => {
    if (typeof s !== 'string' || s === '') r.fail(`${path}[${i}]`, '空でない文字列が必要です');
    return s;
  });
}

function parseFurniture(r: Reader, v: unknown, path: string): FurnitureDef[] {
  return r.arr(v, path).map((d, i) => {
    const p = `${path}[${i}]`;
    const e = r.obj(d, p);
    const f: FurnitureDef = {
      id: r.str(e, 'id', p),
      width: r.num(e, 'width', p, 0.05, 20),
      depth: r.num(e, 'depth', p, 0.05, 20),
      height: r.num(e, 'height', p, 0.05, 5),
      place: r.oneOf(e, 'place', p, ['wall', 'corner', 'center'] as const),
      chance: r.num(e, 'chance', p, 0, 1),
    };
    if (e.count !== undefined) f.count = intRange(r, e, 'count', p, 0, 20);
    return f;
  });
}

function parseSpecialArea(r: Reader, o: Record<string, unknown>, key: string): SpecialAreaDef {
  const p = `special.${key}`;
  const e = r.obj(o[key], p);
  return {
    name: r.str(e, 'name', p),
    spawnWeight: r.num(e, 'spawnWeight', p, 0),
    furniture: parseFurniture(r, e.furniture, `${p}.furniture`),
  };
}

export function validateGeneratorTemplate(raw: unknown, source = 'generator'): AnyGeneratorTemplate {
  const r = new Reader(source);
  const o = r.obj(raw, '');
  const type = r.oneOf(o, 'type', '', ['house', 'modular'] as const);
  if (type === 'modular') return validateModularTemplate(r, o);
  return validateHouseTemplate(r, o);
}

function validateHouseTemplate(r: Reader, o: Record<string, unknown>): HouseGeneratorTemplate {

  const fp = r.obj(o.footprint, 'footprint');
  const hallway = r.obj(o.hallway, 'hallway');
  const side = r.obj(o.sideZone, 'sideZone');
  const back = r.obj(o.backZone, 'backZone');
  const genkan = r.obj(o.genkan, 'genkan');
  const nested = r.obj(o.nested, 'nested');
  const door = r.obj(o.door, 'door');
  const special = r.obj(o.special, 'special');
  const ent = r.obj(o.entities, 'entities');

  const layouts = r.arr(o.layouts, 'layouts', 1).map((d, i) => {
    const p = `layouts[${i}]`;
    const e = r.obj(d, p);
    return {
      id: r.oneOf(e, 'id', p, [
        'center_I',
        'center_T',
        'wing_L',
        'stepped_villa',
        'courtyard_U',
        'embassy_compound',
      ] as const),
      weight: r.num(e, 'weight', p, 0),
    };
  });
  if (!layouts.some((l) => l.weight > 0)) r.fail('layouts', '重み > 0 のレイアウトが 1 つ以上必要です');

  const roomTypes: RoomTypeDef[] = r.arr(o.roomTypes, 'roomTypes', 1).map((d, i) => {
    const p = `roomTypes[${i}]`;
    const e = r.obj(d, p);
    const slots = r.arr(e.slots, `${p}.slots`, 1).map((s, j) => {
      if (s !== 'side' && s !== 'back' && s !== 'nested') r.fail(`${p}.slots[${j}]`, 'side | back | nested のいずれかが必要です');
      return s as RoomSlot;
    });
    const minCount = r.num(e, 'minCount', p, 0, 40);
    const maxCount = r.num(e, 'maxCount', p, 0, 40);
    if (!Number.isInteger(minCount) || !Number.isInteger(maxCount)) r.fail(p, 'minCount / maxCount は整数が必要です');
    if (minCount > maxCount) r.fail(p, 'minCount は maxCount 以下である必要があります');
    const minArea = r.num(e, 'minArea', p, 0);
    const maxArea = r.num(e, 'maxArea', p, 0);
    if (minArea > maxArea) r.fail(p, 'minArea は maxArea 以下である必要があります');
    return {
      id: r.str(e, 'id', p),
      name: r.str(e, 'name', p),
      slots,
      minCount,
      maxCount,
      weight: r.num(e, 'weight', p, 0),
      minArea,
      maxArea,
      minSide: r.num(e, 'minSide', p, 0),
      prefer: r.oneOf(e, 'prefer', p, ['largest', 'smallest', 'front', 'back', 'any'] as const),
      private: r.bool(e, 'private', p),
      spawnWeight: r.num(e, 'spawnWeight', p, 0),
      furniture: parseFurniture(r, e.furniture, `${p}.furniture`),
    };
  });
  r.uniqueIds(roomTypes, 'roomTypes');
  const fallbackRoomType = r.str(o, 'fallbackRoomType', '');
  if (!roomTypes.some((t) => t.id === fallbackRoomType)) r.fail('fallbackRoomType', `roomTypes に "${fallbackRoomType}" が存在しません`);

  const doorWidth = r.num(door, 'width', 'door', 0.6, 3);
  const hallwayWidth = numRange(r, hallway, 'width', 'hallway', 0.8, 6);
  const doorMargin = r.num(door, 'margin', 'door', 0, 2);
  if (hallwayWidth.min < doorWidth + 0.2) r.fail('hallway.width.min', '玄関ドア幅 + 0.2m 以上が必要です');

  const suspectProfiles = r.arr(ent.suspectProfiles, 'entities.suspectProfiles', 1).map((d, i) => {
    const p = `entities.suspectProfiles[${i}]`;
    const e = r.obj(d, p);
    return { profile: r.str(e, 'profile', p), weight: r.num(e, 'weight', p, 0), max: r.num(e, 'max', p, 0) };
  });

  const windowChance = r.optNum(door, 'windowChance', 'door', 0, 1);

  return {
    type: 'house',
    id: r.str(o, 'id', ''),
    name: r.str(o, 'name', ''),
    summaries: strList(r, o.summaries, 'summaries', 1),
    ceilingHeight: r.num(o, 'ceilingHeight', '', 2, 6),
    wallThickness: r.num(o, 'wallThickness', '', 0.05, 1),
    snap: r.num(o, 'snap', '', 0.01, 1),
    maxAttempts: r.num(o, 'maxAttempts', '', 1, 200),
    footprint: { width: numRange(r, fp, 'width', 'footprint', 6, 80), depth: numRange(r, fp, 'depth', 'footprint', 6, 80) },
    porchDepth: numRange(r, o, 'porchDepth', '', 1.5, 20),
    layouts,
    hallway: { width: hallwayWidth, minLength: r.num(hallway, 'minLength', 'hallway', 1) },
    sideZone: {
      minWidth: r.num(side, 'minWidth', 'sideZone', 1.5),
      maxWidth: r.num(side, 'maxWidth', 'sideZone', 1.5),
      roomDepth: numRange(r, side, 'roomDepth', 'sideZone', doorWidth + 2 * doorMargin + 0.4, 30),
    },
    backZone: {
      depth: numRange(r, back, 'depth', 'backZone', 2, 30),
      roomCount: intRange(r, back, 'roomCount', 'backZone', 1, 10),
      minRoomWidth: r.num(back, 'minRoomWidth', 'backZone', 1.5),
    },
    genkan: {
      chance: r.num(genkan, 'chance', 'genkan', 0, 1),
      depth: numRange(r, genkan, 'depth', 'genkan', 1.2, 6),
      archChance: r.num(genkan, 'archChance', 'genkan', 0, 1),
    },
    nested: {
      chance: r.num(nested, 'chance', 'nested', 0, 1),
      minInnerWidth: r.num(nested, 'minInnerWidth', 'nested', 1.5),
      minOuterWidth: r.num(nested, 'minOuterWidth', 'nested', doorWidth + 2 * doorMargin + 0.3),
    },
    door: {
      width: doorWidth,
      maxAngle: r.num(door, 'maxAngle', 'door', 1, 180),
      margin: doorMargin,
      lockedChance: r.num(door, 'lockedChance', 'door', 0, 1),
      maxLocked: r.num(door, 'maxLocked', 'door', 0, 50),
      extraConnectChance: r.num(door, 'extraConnectChance', 'door', 0, 1),
      archChance: r.num(door, 'archChance', 'door', 0, 1),
      archWidth: r.num(door, 'archWidth', 'door', 0.6, 10),
      archRoomTypes: strList(r, door.archRoomTypes, 'door.archRoomTypes'),
      ...(windowChance !== undefined ? { windowChance } : {}),
    },
    furnitureGap: r.num(o, 'furnitureGap', '', 0, 3),
    wallClearance: r.num(o, 'wallClearance', '', 0, 3),
    special: {
      porch: parseSpecialArea(r, special, 'porch'),
      genkan: parseSpecialArea(r, special, 'genkan'),
      hallway: parseSpecialArea(r, special, 'hallway'),
    },
    roomTypes,
    fallbackRoomType,
    entities: {
      suspects: intRange(r, ent, 'suspects', 'entities', 1, 40),
      civilians: intRange(r, ent, 'civilians', 'entities', 0, 40),
      suspectProfiles,
      civilianProfile: r.str(ent, 'civilianProfile', 'entities'),
      minSpawnDistance: r.num(ent, 'minSpawnDistance', 'entities', 0),
      hostagePairChance: r.num(ent, 'hostagePairChance', 'entities', 0, 1),
      clearance: r.num(ent, 'clearance', 'entities', 0.1, 2),
      briefingUncertainty: r.num(ent, 'briefingUncertainty', 'entities', 0, 10),
    },
  };
}

// ---------- Modular generator template (docs/design/modular-map-generator.md §2.3, §8.1) ----------

/** 既存エンジンの物理・当たり判定から導出した閾値（根拠は設計書 §2.2 の 2 に集約）。 */
const MAX_MODULAR_STAIR_STEPS = 32;
const MIN_MODULAR_STAIR_STEPS = 8;
const MIN_HEADROOM = 2.05;
const MIN_STORY_CLEARANCE = 2.4;
const MIN_DOOR_WIDTH = 0.85;
const MIN_PARAPET_HEIGHT = 0.95;
const MIN_ROOM_INNER_SIDE = 0.9;
const MODULE_CATEGORIES: readonly ModuleCategory[] = [
  'entry',
  'stair_core',
  'corridor',
  'living_hub',
  'garage',
  'courtyard',
  'wing_private',
  'study_office',
  'basement_utility',
  'terrace',
];
const STORY_LEVELS: readonly StoryLevel[] = [-1, 0, 1];
const ORTHO_ROTATIONS: readonly OrthogonalRotation[] = [0, 90, 180, 270];

/** モジュラー階段の段数（設計書 §3.2-3）。 */
export function modularStairSteps(storyRise: number, targetRise: number): number {
  return Math.max(MIN_MODULAR_STAIR_STEPS, Math.ceil(storyRise / targetRise - DIM_TOL));
}

/** doors.json の扉リーフ高（モジュラー生成の扉開口高の一元契約）。>= 2.05m でなければ DataError。 */
export function modularDoorLeafHeight(doorConfig: DoorConfig | undefined): number {
  if (doorConfig === undefined) throw new DataError('doors', 'height', 'type "modular" の生成には doors.json の設定が必要です');
  if (!(doorConfig.height >= MIN_HEADROOM)) {
    throw new DataError('doors', 'height', `扉高 ${doorConfig.height} は ${MIN_HEADROOM}m 以上が必要です`);
  }
  return doorConfig.height;
}

/**
 * モジュラーテンプレートの最小構成（フォールバック）成立検証（設計書 §3.2-5 / BC-11）。
 * 重み > 0 の全階層プロファイルで最小構成器を実行し、不成立なら DataError。
 */
export function verifyModularFallback(tpl: ModularGeneratorTemplate, doorLeafHeight: number): void {
  // 不成立時は生成器側が DataError（FallbackInfeasibleError は DataError の派生）を直接送出する
  verifyFallbackFeasibility(tpl, doorLeafHeight);
}

function int(r: Reader, o: Record<string, unknown>, key: string, path: string, min: number, max: number): number {
  const v = r.num(o, key, path, min, max);
  if (!Number.isInteger(v)) r.fail(`${path}.${key}`, '整数が必要です');
  return v;
}

function optBool(r: Reader, o: Record<string, unknown>, key: string, path: string, fallback: boolean): boolean {
  return o[key] === undefined ? fallback : r.bool(o, key, path);
}

function optStr(r: Reader, o: Record<string, unknown>, key: string, path: string): string | undefined {
  return o[key] === undefined ? undefined : r.str(o, key, path);
}

function parseModularFurniture(r: Reader, v: unknown, path: string): ModularFurnitureDef[] {
  const list = r.arr(v, path).map((d, i) => {
    const p = `${path}[${i}]`;
    const e = r.obj(d, p);
    if (e.count === undefined) r.fail(`${p}.count`, 'count { min, max } が必要です');
    const f: ModularFurnitureDef = {
      id: r.str(e, 'id', p),
      width: r.num(e, 'width', p, 0.05, 20),
      depth: r.num(e, 'depth', p, 0.05, 20),
      height: r.num(e, 'height', p, 0.05, 5),
      place: r.oneOf(e, 'place', p, ['wall', 'corner', 'center'] as const),
      chance: r.num(e, 'chance', p, 0, 1),
      count: intRange(r, e, 'count', p, 1, 16),
    };
    return f;
  });
  r.uniqueIds(list, path);
  return list;
}

function parseLevels(r: Reader, v: unknown, path: string, requireGround: boolean): StoryLevel[] {
  const levels = r.arr(v, path, 1).map((x, i) => {
    if (typeof x !== 'number' || !(STORY_LEVELS as readonly number[]).includes(x)) r.fail(`${path}[${i}]`, '-1 | 0 | 1 のいずれかが必要です');
    return x as StoryLevel;
  });
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] === levels[i - 1]) r.fail(`${path}[${i}]`, `階層 ${levels[i]} が重複しています`);
    if (levels[i] < levels[i - 1]) r.fail(`${path}[${i}]`, '昇順である必要があります');
  }
  if (requireGround && !levels.includes(0)) r.fail(path, '1F (0) を含む必要があります');
  return levels;
}

function categoryOf(r: Reader, v: unknown, path: string): ModuleCategory {
  if (typeof v !== 'string' || !(MODULE_CATEGORIES as readonly string[]).includes(v)) {
    r.fail(path, `${MODULE_CATEGORIES.join(' | ')} のいずれかが必要です`);
  }
  return v as ModuleCategory;
}

/** ModuleCategory の無向対の正規化キー（§3.2-1）。 */
function edgeKey(a: ModuleCategory, b: ModuleCategory): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

function validateModularTemplate(r: Reader, o: Record<string, unknown>): ModularGeneratorTemplate {
  const wallThickness = r.num(o, 'wallThickness', '', 0.1, 0.5);
  const slabThickness = r.num(o, 'slabThickness', '', 0.08, 0.5);
  const parapetHeight = r.num(o, 'parapetHeight', '', MIN_PARAPET_HEIGHT, 1.5);
  const snapRaw = r.num(o, 'snap', '', 0, 1);
  if (snapRaw !== 0.25 && snapRaw !== 0.5) r.fail('snap', `0.25 | 0.5 のいずれかが必要です (現在 ${snapRaw})`);
  const snap: ModularSnap = snapRaw;

  // --- door（他の寸法下限の基準になるため先に読む）
  const dr = r.obj(o.door, 'door');
  const doorWidth = r.num(dr, 'width', 'door', MIN_DOOR_WIDTH, 3);
  const doubleWidth = r.optNum(dr, 'doubleWidth', 'door', Math.max(1.2, doorWidth), 4.0);
  const doorMargin = r.num(dr, 'margin', 'door', 0.15, 2);
  const archWidth = r.num(dr, 'archWidth', 'door', doorWidth, 10);
  const archHeight = r.num(dr, 'archHeight', 'door', MIN_HEADROOM, 10);
  const door = {
    width: doorWidth,
    ...(doubleWidth !== undefined ? { doubleWidth } : {}),
    maxAngle: r.num(dr, 'maxAngle', 'door', 90, 130),
    margin: doorMargin,
    swingClearance: r.num(dr, 'swingClearance', 'door', 0.3, 5),
    lockedChance: r.num(dr, 'lockedChance', 'door', 0, 1),
    maxLocked: int(r, dr, 'maxLocked', 'door', 0, 50),
    archWidth,
    archHeight,
    archMargin: r.num(dr, 'archMargin', 'door', 0.1, 2),
    archClearance: r.num(dr, 'archClearance', 'door', 0.8, 5),
  };
  const doorPassMin = doorWidth + wallThickness + 2 * doorMargin;

  // --- stairCore
  const sc = r.obj(o.stairCore, 'stairCore');
  const stairCore = {
    flightWidth: r.num(sc, 'flightWidth', 'stairCore', 0.95, 2),
    targetRise: r.num(sc, 'targetRise', 'stairCore', 0.15, 0.24),
    treadRun: r.num(sc, 'treadRun', 'stairCore', 0.24, 0.34),
    landingDepth: r.num(sc, 'landingDepth', 'stairCore', Math.max(1.35, doorPassMin) - DIM_TOL, 20),
    laneGap: r.num(sc, 'laneGap', 'stairCore', wallThickness, 5),
    hallSideWidth: r.num(sc, 'hallSideWidth', 'stairCore', Math.max(1.1, doorWidth + 2 * doorMargin) - DIM_TOL, 10),
    keepOutMargin: r.num(sc, 'keepOutMargin', 'stairCore', 1, 10),
    count: intRange(r, sc, 'count', 'stairCore', 1, 2),
  };

  // --- storyProfiles
  const storyProfiles: StoryProfileDef[] = r.arr(o.storyProfiles, 'storyProfiles', 1).map((d, i) => {
    const p = `storyProfiles[${i}]`;
    const e = r.obj(d, p);
    const levels = parseLevels(r, e.levels, `${p}.levels`, true);
    const storyRise = r.num(e, 'storyRise', p, 0.1, 10);
    if (storyRise - slabThickness < MIN_STORY_CLEARANCE - DIM_TOL) {
      r.fail(`${p}.storyRise`, `storyRise - slabThickness = ${storyRise - slabThickness} は ${MIN_STORY_CLEARANCE}m 以上が必要です`);
    }
    const steps = modularStairSteps(storyRise, stairCore.targetRise);
    if (steps > MAX_MODULAR_STAIR_STEPS) {
      r.fail(`${p}.storyRise`, `階段段数 ${steps} が上限 ${MAX_MODULAR_STAIR_STEPS} を超えます (storyRise / stairCore.targetRise)`);
    }
    const prof: StoryProfileDef = { id: r.str(e, 'id', p), weight: r.num(e, 'weight', p, 0), levels, storyRise };
    const hasUpper = levels.includes(1);
    const hasBasement = levels.includes(-1);
    if (hasUpper || e.upperFloorRatio !== undefined) {
      if (e.upperFloorRatio === undefined) r.fail(`${p}.upperFloorRatio`, '2F (1) を含むプロファイルには必須です');
      prof.upperFloorRatio = numRange(r, e, 'upperFloorRatio', p, 0.2, 0.9);
    }
    if (hasUpper || e.roofTerraceChance !== undefined) {
      if (e.roofTerraceChance === undefined) r.fail(`${p}.roofTerraceChance`, '2F (1) を含むプロファイルには必須です');
      prof.roofTerraceChance = r.num(e, 'roofTerraceChance', p, 0, 1);
    }
    if (hasBasement || e.basementRatio !== undefined) {
      if (e.basementRatio === undefined) r.fail(`${p}.basementRatio`, 'B1 (-1) を含むプロファイルには必須です');
      prof.basementRatio = numRange(r, e, 'basementRatio', p, 0.15, 0.85);
    }
    return prof;
  });
  if (storyProfiles.length > 4) r.fail('storyProfiles', `要素数は 4 以下が必要です (現在 ${storyProfiles.length})`);
  r.uniqueIds(storyProfiles, 'storyProfiles');
  if (!storyProfiles.some((sp) => sp.weight > 0)) r.fail('storyProfiles', '重み > 0 のプロファイルが 1 つ以上必要です');
  const activeProfiles = storyProfiles.filter((sp) => sp.weight > 0);

  // 断面整合（正重みプロファイル）
  storyProfiles.forEach((sp, i) => {
    if (sp.weight <= 0) return;
    const clearance = sp.storyRise - slabThickness;
    if (archHeight > clearance + DIM_TOL) {
      r.fail('door.archHeight', `archHeight ${archHeight} が storyProfiles[${i}] の有効階高 ${clearance} を超えます`);
    }
  });

  // --- window
  const wn = r.obj(o.window, 'window');
  const win = {
    chance: r.num(wn, 'chance', 'window', 0, 1),
    width: numRange(r, wn, 'width', 'window', 0.6, 3.6),
    height: r.num(wn, 'height', 'window', 0.4, 5),
    sill: r.num(wn, 'sill', 'window', 0.2, 5),
    minMargin: r.num(wn, 'minMargin', 'window', 0.25, 5),
    keepOutDepth: r.num(wn, 'keepOutDepth', 'window', 0.4, 5),
  } as ModularWindowConfigDef;
  const interiorChance = r.optNum(wn, 'interiorChance', 'window', 0, 1);
  if (interiorChance !== undefined && interiorChance > 0) {
    win.interiorChance = interiorChance;
    win.interiorWidth = wn.interiorWidth === undefined ? { min: 1.0, max: 1.6 } : numRange(r, wn, 'interiorWidth', 'window', 0.6, 3.6);
    win.interiorSill = r.optNum(wn, 'interiorSill', 'window', 0.6, 1.4) ?? 1.0;
    win.interiorHeight = r.optNum(wn, 'interiorHeight', 'window', 0.4, 2) ?? 0.95;
    win.interiorMaxPerLevel = r.optNum(wn, 'interiorMaxPerLevel', 'window', 0, 20) ?? 3;
  }
  storyProfiles.forEach((sp, i) => {
    if (sp.weight <= 0) return;
    const limit = sp.storyRise - slabThickness - 0.1;
    if (win.sill + win.height > limit + DIM_TOL) {
      r.fail('window', `sill + height = ${win.sill + win.height} が storyProfiles[${i}] の上限 ${limit} を超えます`);
    }
    if (win.interiorChance && win.interiorSill! + win.interiorHeight! > limit + DIM_TOL) {
      r.fail('window', `interiorSill + interiorHeight = ${win.interiorSill! + win.interiorHeight!} が storyProfiles[${i}] の上限 ${limit} を超えます`);
    }
  });

  // --- site
  const st = r.obj(o.site, 'site');
  const rotationsAllowed = r.arr(st.rotationsAllowed, 'site.rotationsAllowed', 1).map((x, i) => {
    if (typeof x !== 'number' || !(ORTHO_ROTATIONS as readonly number[]).includes(x)) {
      r.fail(`site.rotationsAllowed[${i}]`, '0 | 90 | 180 | 270 のいずれかが必要です');
    }
    return x as OrthogonalRotation;
  });
  if (rotationsAllowed.length > 4) r.fail('site.rotationsAllowed', '要素数は 4 以下が必要です');
  if (new Set(rotationsAllowed).size !== rotationsAllowed.length) r.fail('site.rotationsAllowed', '重複があります');
  const site = {
    rotationsAllowed,
    mirrorAllowed: r.bool(st, 'mirrorAllowed', 'site'),
    approachDepth: numRange(r, st, 'approachDepth', 'site', 3.5, 50),
    perimeterMargin: r.num(st, 'perimeterMargin', 'site', 1.5, 50),
    spawnSetback: r.num(st, 'spawnSetback', 'site', 1, 50),
    allyLateralOffset: r.num(st, 'allyLateralOffset', 'site', 0.7, 10),
    allyBackOffset: r.num(st, 'allyBackOffset', 'site', 0.4, 10),
    approachKeepOutHalfWidth: r.num(st, 'approachKeepOutHalfWidth', 'site', 1.8, 20),
    approachFurniture: parseModularFurniture(r, st.approachFurniture, 'site.approachFurniture'),
    approachName: r.str(st, 'approachName', 'site'),
  };

  // --- circulation
  const ci = r.obj(o.circulation, 'circulation');
  const allowedEdges: AdjacencyRuleDef[] = r.arr(ci.allowedEdges, 'circulation.allowedEdges', 1).map((d, i) => {
    const p = `circulation.allowedEdges[${i}]`;
    const e = r.obj(d, p);
    return {
      from: categoryOf(r, e.from, `${p}.from`),
      to: categoryOf(r, e.to, `${p}.to`),
      style: r.oneOf(e, 'style', p, ['door', 'arch', 'exterior_door'] as const),
      weight: r.num(e, 'weight', p, 0),
    };
  });
  if (allowedEdges.length > 128) r.fail('circulation.allowedEdges', '要素数は 128 以下が必要です');
  const forbiddenEdges = r.arr(ci.forbiddenEdges, 'circulation.forbiddenEdges').map((d, i): [ModuleCategory, ModuleCategory] => {
    const p = `circulation.forbiddenEdges[${i}]`;
    const pair = r.arr(d, p, 2);
    if (pair.length !== 2) r.fail(p, '[from, to] の 2 要素が必要です');
    return [categoryOf(r, pair[0], `${p}[0]`), categoryOf(r, pair[1], `${p}[1]`)];
  });
  if (forbiddenEdges.length > 128) r.fail('circulation.forbiddenEdges', '要素数は 128 以下が必要です');
  const allowedKeys = new Set(allowedEdges.map((e) => edgeKey(e.from, e.to)));
  forbiddenEdges.forEach(([a, b], i) => {
    if (allowedKeys.has(edgeKey(a, b))) {
      r.fail(`circulation.forbiddenEdges[${i}]`, `"${edgeKey(a, b)}" が allowedEdges と重複しています`);
    }
  });
  const circulation = {
    allowedEdges,
    forbiddenEdges,
    loopCount1F: intRange(r, ci, 'loopCount1F', 'circulation', 0, 8),
    loopCountOther: intRange(r, ci, 'loopCountOther', 'circulation', 0, 6),
    extraDoorChance: r.num(ci, 'extraDoorChance', 'circulation', 0, 1),
    secondaryExteriorDoorChance: r.num(ci, 'secondaryExteriorDoorChance', 'circulation', 0, 1),
    maxExteriorDoors: int(r, ci, 'maxExteriorDoors', 'circulation', 1, 8),
  };

  // --- modules
  const minShortSide = Math.max(1.6, 2 * wallThickness + MIN_ROOM_INNER_SIDE);
  const subRoomMinSide = Math.max(1.6, doorPassMin) - DIM_TOL;
  const modules: ArchitecturalModuleDef[] = r.arr(o.modules, 'modules', 1).map((d, i) => {
    const p = `modules[${i}]`;
    const e = r.obj(d, p);
    const category = categoryOf(r, e.category, `${p}.category`);
    const minCount = int(r, e, 'minCount', p, 0, 8);
    const maxCount = int(r, e, 'maxCount', p, 1, 12);
    if (minCount > maxCount) r.fail(p, 'minCount は maxCount 以下である必要があります');
    const width = numRange(r, e, 'width', p, 0.5, 80);
    const depth = numRange(r, e, 'depth', p, 0.5, 80);
    const roofStyle = r.oneOf(e, 'roofStyle', p, ['stackable', 'flat_roof_only', 'double_height', 'open_sky'] as const);
    const doubleHeightChance = r.num(e, 'doubleHeightChance', p, 0, 1);
    if (doubleHeightChance > 0 && (roofStyle !== 'stackable' || category === 'entry')) {
      r.fail(`${p}.doubleHeightChance`, 'roofStyle が stackable かつ category が entry 以外のときのみ 0 より大きくできます');
    }
    const outdoor = optBool(r, e, 'outdoor', p, false);
    const isPrivate = optBool(r, e, 'private', p, false);
    const spawnWeight = r.num(e, 'spawnWeight', p, 0);
    if (spawnWeight > 0 && (category === 'entry' || outdoor)) {
      r.fail(`${p}.spawnWeight`, 'entry または outdoor のモジュールは 0 が必要です');
    }
    const allowedLevels = parseLevels(r, e.allowedLevels, `${p}.allowedLevels`, false);
    if (outdoor && allowedLevels.includes(-1)) r.fail(`${p}.allowedLevels`, '屋外モジュールは B1 (-1) に置けません');
    if (!outdoor) {
      const shortSide = Math.min(width.min, depth.min);
      const longSide = Math.max(width.min, depth.min);
      if (shortSide < minShortSide - DIM_TOL) r.fail(p, `短辺の最小 ${shortSide} が ${minShortSide}m 未満です`);
      if (longSide < doorPassMin - DIM_TOL) {
        r.fail(p, `長辺の最小 ${longSide} が ${doorPassMin}m (door.width + wallThickness + 2 * door.margin) 未満です`);
      }
    }
    const subRooms: SubRoomSpec[] =
      e.subRooms === undefined
        ? []
        : r.arr(e.subRooms, `${p}.subRooms`).map((sd, j) => {
            const sp = `${p}.subRooms[${j}]`;
            const se = r.obj(sd, sp);
            const sub: SubRoomSpec = {
              id: r.str(se, 'id', sp),
              name: r.str(se, 'name', sp),
              shareWeight: r.num(se, 'shareWeight', sp, 0.15, 1),
              minSide: r.num(se, 'minSide', sp, subRoomMinSide, 80),
              private: r.bool(se, 'private', sp),
              connectStyle: r.oneOf(se, 'connectStyle', sp, ['door', 'arch'] as const),
              spawnWeight: r.num(se, 'spawnWeight', sp, 0),
              furniture: parseModularFurniture(r, se.furniture, `${sp}.furniture`),
            };
            const fm = optStr(r, se, 'floorMaterial', sp);
            if (fm !== undefined) sub.floorMaterial = fm;
            return sub;
          });
    if (subRooms.length > 6) r.fail(`${p}.subRooms`, '要素数は 6 以下が必要です');
    r.uniqueIds(subRooms, `${p}.subRooms`);
    if (outdoor && subRooms.length > 0) r.fail(`${p}.subRooms`, '屋外モジュールはサブ室を持てません');
    const mod: ArchitecturalModuleDef = {
      id: r.str(e, 'id', p),
      name: r.str(e, 'name', p),
      category,
      allowedLevels,
      minCount,
      maxCount,
      weight: r.num(e, 'weight', p, 0),
      width,
      depth,
      exteriorRequirement: r.oneOf(e, 'exteriorRequirement', p, ['front_approach', 'any_exterior', 'interior_ok'] as const),
      roofStyle,
      doubleHeightChance,
      outdoor,
      private: isPrivate,
      spawnWeight,
      furniture: parseModularFurniture(r, e.furniture, `${p}.furniture`),
      subRooms,
    };
    const fm = optStr(r, e, 'floorMaterial', p);
    if (fm !== undefined) mod.floorMaterial = fm;
    return mod;
  });
  if (modules.length > 32) r.fail('modules', `要素数は 32 以下が必要です (現在 ${modules.length})`);
  r.uniqueIds(modules, 'modules');

  // カテゴリ存在（正重みプロファイルで必要なもの）
  const hasModule = (pred: (m: ArchitecturalModuleDef) => boolean): boolean => modules.some(pred);
  if (!hasModule((m) => m.category === 'entry' && m.allowedLevels.includes(0) && !m.outdoor)) {
    r.fail('modules', '1F (0) に置ける屋内の entry モジュールが必要です');
  }
  activeProfiles.forEach((sp) => {
    if (sp.levels.length < 2) return;
    if (!hasModule((m) => m.category === 'stair_core' && !m.outdoor && sp.levels.every((lv) => m.allowedLevels.includes(lv)))) {
      r.fail('modules', `プロファイル "${sp.id}" の全階層 [${sp.levels.join(',')}] に置ける stair_core モジュールが必要です`);
    }
    for (const lv of sp.levels) {
      if (lv === 0) continue;
      const ok = hasModule(
        (m) => !m.outdoor && m.category !== 'stair_core' && m.category !== 'corridor' && m.allowedLevels.includes(lv),
      );
      if (!ok) r.fail('modules', `プロファイル "${sp.id}" の階層 ${lv} に置ける一般屋内モジュール（stair_core・corridor 以外）が必要です`);
    }
  });

  const fallbackModuleId = r.str(o, 'fallbackModuleId', '');
  const fb = modules.find((m) => m.id === fallbackModuleId);
  if (!fb) r.fail('fallbackModuleId', `modules に "${fallbackModuleId}" が存在しません`);
  if (fb.roofStyle !== 'stackable' || fb.outdoor || fb.private || fb.subRooms.length > 0 || !fb.allowedLevels.includes(0)) {
    r.fail('fallbackModuleId', 'stackable・屋内・非 private・subRooms なし・1F (0) 配置可のモジュールが必要です');
  }

  // --- entities
  const ent = r.obj(o.entities, 'entities');
  const suspectProfiles = r.arr(ent.suspectProfiles, 'entities.suspectProfiles', 1).map((d, i) => {
    const p = `entities.suspectProfiles[${i}]`;
    const e = r.obj(d, p);
    return { profile: r.str(e, 'profile', p), weight: r.num(e, 'weight', p, 0), max: int(r, e, 'max', p, 0, 40) };
  });
  const suspects = intRange(r, ent, 'suspects', 'entities', 1, 40);
  const sumMax = suspectProfiles.reduce((a, sp) => a + sp.max, 0);
  if (sumMax < suspects.max) r.fail('entities.suspectProfiles', `max の合計 ${sumMax} が suspects.max ${suspects.max} 未満です`);

  const fpRaw = r.obj(o.maxFootprint, 'maxFootprint');
  return {
    type: 'modular',
    id: r.str(o, 'id', ''),
    name: r.str(o, 'name', ''),
    summaries: strList(r, o.summaries, 'summaries', 1),
    wallThickness,
    slabThickness,
    parapetHeight,
    snap,
    minCourtGap: r.num(o, 'minCourtGap', '', 1.5, 50),
    maxAttempts: int(r, o, 'maxAttempts', '', 1, 200),
    target1FArea: numRange(r, o, 'target1FArea', '', 1, 10000),
    maxFootprint: {
      width: r.num(fpRaw, 'width', 'maxFootprint', 1, 200),
      depth: r.num(fpRaw, 'depth', 'maxFootprint', 1, 200),
    },
    storyProfiles,
    stairCore,
    site,
    circulation,
    door,
    window: win,
    furnitureGap: r.num(o, 'furnitureGap', '', 0, 3),
    wallClearance: r.num(o, 'wallClearance', '', 0, 3),
    modules,
    fallbackModuleId,
    entities: {
      suspects,
      civilians: intRange(r, ent, 'civilians', 'entities', 0, 40),
      suspectProfiles,
      civilianProfile: r.str(ent, 'civilianProfile', 'entities'),
      minSpawnDistance: r.num(ent, 'minSpawnDistance', 'entities', 0),
      hostagePairChance: r.num(ent, 'hostagePairChance', 'entities', 0, 1),
      clearance: r.num(ent, 'clearance', 'entities', 0.1, 2),
      briefingUncertainty: r.num(ent, 'briefingUncertainty', 'entities', 0, 10),
      minEntitySeparation: r.num(ent, 'minEntitySeparation', 'entities', 0.1, 20),
    },
  };
}

/** 生成テンプレートが参照する ai_profiles の存在確認。 */
export function validateGeneratorReferences(tpl: AnyGeneratorTemplate, profiles: AIProfile[]): void {
  const ids = new Set(profiles.map((p) => p.id));
  const src = `generator:${tpl.id}`;
  tpl.entities.suspectProfiles.forEach((p, i) => {
    if (!ids.has(p.profile)) throw new DataError(src, `entities.suspectProfiles[${i}].profile`, `ai_profiles.json に "${p.profile}" が存在しません`);
  });
  if (!ids.has(tpl.entities.civilianProfile)) {
    throw new DataError(src, 'entities.civilianProfile', `ai_profiles.json に "${tpl.entities.civilianProfile}" が存在しません`);
  }
}

export function validateWeapons(raw: unknown, source = 'weapons'): WeaponDef[] {
  const r = new Reader(source);
  const o = r.obj(raw, '') as Partial<WeaponsData>;
  const weapons: WeaponDef[] = r.arr(o.weapons, 'weapons', 1).map((d, i) => {
    const p = `weapons[${i}]`;
    const e = r.obj(d, p);
    const category = r.oneOf(e, 'category', p, ['primary', 'nonlethal', 'throwable'] as const);
    let throwable: ThrowableDef | undefined;
    if (category === 'throwable') {
      const tp = `${p}.throwable`;
      const t = r.obj(e.throwable, tp);
      throwable = {
        throwSpeed: r.num(t, 'throwSpeed', tp, 0.1),
        upwardBiasDeg: r.num(t, 'upwardBiasDeg', tp, 0, 60),
        gravity: r.num(t, 'gravity', tp, 0),
        restitution: r.num(t, 'restitution', tp, 0, 1),
        friction: r.num(t, 'friction', tp, 0, 1),
        fuseTime: r.num(t, 'fuseTime', tp, 0.1),
        ballRadius: r.num(t, 'ballRadius', tp, 0.005, 0.5),
        stopSpeed: r.num(t, 'stopSpeed', tp, 0),
        blindMaxSec: r.num(t, 'blindMaxSec', tp, 0),
        falloffMin: r.num(t, 'falloffMin', tp, 0, 1),
        behindFactor: r.num(t, 'behindFactor', tp, 0, 1),
        afterglowSec: r.num(t, 'afterglowSec', tp, 0),
        afterglowOpacity: r.num(t, 'afterglowOpacity', tp, 0, 1),
      };
    }
    return {
      id: r.str(e, 'id', p),
      name: r.str(e, 'name', p),
      category,
      ...(throwable ? { throwable } : {}),
      slot: r.num(e, 'slot', p, 1, 4),
      damage: r.num(e, 'damage', p, 0),
      fireRate: r.num(e, 'fireRate', p, 0.0001),
      magazineSize: r.num(e, 'magazineSize', p, 1),
      reloadTime: r.num(e, 'reloadTime', p, 0),
      range: r.num(e, 'range', p, 0.1),
      hipSpread: r.num(e, 'hipSpread', p, 0),
      adsSpread: r.num(e, 'adsSpread', p, 0),
      adsMoveSpeedMultiplier: r.num(e, 'adsMoveSpeedMultiplier', p, 0, 1),
      moveSpreadPenalty: r.num(e, 'moveSpreadPenalty', p, 0),
      recoilPitch: r.num(e, 'recoilPitch', p, 0),
      recoilYawRange: r.num(e, 'recoilYawRange', p, 0),
      recoilRecovery: r.num(e, 'recoilRecovery', p, 0),
      moraleDamage: r.num(e, 'moraleDamage', p, 0, 100),
      noiseRadius: r.num(e, 'noiseRadius', p, 0),
      ...(e.faction !== undefined ? { faction: r.oneOf(e, 'faction', p, ['swat', 'suspect'] as const) } : {}),
      ...(e.reserveMagazines !== undefined ? { reserveMagazines: r.num(e, 'reserveMagazines', p, 0, 99) } : {}),
    };
  });
  r.uniqueIds(weapons, 'weapons');
  return weapons;
}

function readCombat(r: Reader, e: Record<string, unknown>, p: string, required: boolean): CombatParams | undefined {
  if (e.combat === undefined) {
    if (required) r.fail(`${p}.combat`, 'suspect プロファイルには combat が必要です');
    return undefined;
  }
  const c = r.obj(e.combat, `${p}.combat`);
  const cp = `${p}.combat`;
  const n = (k: string, min = 0, max = Infinity): number => r.num(c, k, cp, min, max);
  const params: CombatParams = {
    decisionSec: n('decisionSec'),
    alertCalmSec: n('alertCalmSec', 0.1),
    hesitateFireSec: n('hesitateFireSec', 0.1),
    hesitateRetreatSpeed: n('hesitateRetreatSpeed'),
    hesitateRetreatMax: n('hesitateRetreatMax'),
    hesitateShakeDeg: n('hesitateShakeDeg', 0, 45),
    moveSpeed: n('moveSpeed', 0.1, 20),
    fireInterval: n('fireInterval', 0.05),
    shotsPerPeek: n('shotsPerPeek', 1),
    magazineSize: n('magazineSize', 1),
    reloadSec: n('reloadSec'),
    coverSecMin: n('coverSecMin'),
    coverSecMax: n('coverSecMax'),
    peekSecMax: n('peekSecMax', 0.1),
    engageRange: n('engageRange', 1),
    coverSearchRange: n('coverSearchRange'),
    coverMargin: n('coverMargin', 0.3, 3),
    crouchCoverMaxHeight: n('crouchCoverMaxHeight'),
    flinchSec: n('flinchSec'),
    gunshotNoiseRadius: n('gunshotNoiseRadius'),
    shotDamage: n('shotDamage', 0, 200),
    baseSpreadDeg: n('baseSpreadDeg', 0, 45),
  };
  const fakeChance = r.optNum(c, 'fakeSurrenderChance', cp, 0, 1);
  if (fakeChance !== undefined) params.fakeSurrenderChance = fakeChance;
  const fakeSec = r.optNum(c, 'fakeSurrenderSec', cp, 0.5, 60);
  if (fakeSec !== undefined) params.fakeSurrenderSec = fakeSec;
  if (params.coverSecMin > params.coverSecMax) r.fail(cp, 'coverSecMin は coverSecMax 以下である必要があります');
  return params;
}

function readShield(r: Reader, e: Record<string, unknown>, p: string): ShieldParams | undefined {
  if (e.shield === undefined) return undefined;
  const sp = `${p}.shield`;
  const c = r.obj(e.shield, sp);
  const n = (k: string, min = 0, max = Infinity): number => r.num(c, k, sp, min, max);
  return {
    moraleBelow: n('moraleBelow', 0, 100),
    civilianRange: n('civilianRange', 0.5),
    playerRange: n('playerRange', 1),
    escapeSearch: n('escapeSearch', 0.5),
    escapeMinGain: n('escapeMinGain', 0.1),
    checkIntervalSec: n('checkIntervalSec', 0.05),
    retrySec: n('retrySec'),
    grabMaxSec: n('grabMaxSec', 0.5),
    grabRange: n('grabRange', 0.3),
    holdDistance: n('holdDistance', 0.3, 2),
    headOffset: n('headOffset', 0, 1),
    pivotDegPerSec: n('pivotDegPerSec', 1, 720),
    backAwayRange: n('backAwayRange'),
    backAwaySpeed: n('backAwaySpeed', 0, 10),
    hostageRadius: n('hostageRadius', 0.1, 1),
  };
}

function readMobility(r: Reader, e: Record<string, unknown>, p: string, required: boolean): MobilityParams | undefined {
  if (e.mobility === undefined) {
    if (required) r.fail(`${p}.mobility`, 'suspect プロファイルには mobility が必要です');
    return undefined;
  }
  const mp = `${p}.mobility`;
  const m = r.obj(e.mobility, mp);
  const patrolIntervalMin = r.num(m, 'patrolIntervalMin', mp, 0.5, 120);
  const patrolIntervalMax = r.num(m, 'patrolIntervalMax', mp, 0.5, 180);
  if (patrolIntervalMin > patrolIntervalMax) {
    r.fail(mp, 'patrolIntervalMin は patrolIntervalMax 以下である必要があります');
  }
  return {
    canOpenDoors: r.bool(m, 'canOpenDoors', mp),
    canUseStairs: r.bool(m, 'canUseStairs', mp),
    patrolChance: r.num(m, 'patrolChance', mp, 0, 1),
    patrolIntervalMin,
    patrolIntervalMax,
    patrolSpeedScale: r.num(m, 'patrolSpeedScale', mp, 0.1, 1.5),
    investigateChance: r.num(m, 'investigateChance', mp, 0, 1),
    investigateMaxDist: r.num(m, 'investigateMaxDist', mp, 0, 100),
    investigateSpeedScale: r.num(m, 'investigateSpeedScale', mp, 0.1, 1.5),
    reinforceOnGunshot: r.bool(m, 'reinforceOnGunshot', mp),
    repositionAfterLostSec: r.num(m, 'repositionAfterLostSec', mp, 0.5, 30),
    flankChance: r.num(m, 'flankChance', mp, 0, 1),
    guardHostageRoom: r.bool(m, 'guardHostageRoom', mp),
  };
}

function readCivilian(r: Reader, e: Record<string, unknown>, p: string, required: boolean): CivilianParams | undefined {
  if (e.civilian === undefined) {
    if (required) r.fail(p, 'type=civilian には civilian ブロックが必要です');
    return undefined;
  }
  const cp = `${p}.civilian`;
  const c = r.obj(e.civilian, cp);
  return {
    gunshotHearScale: r.num(c, 'gunshotHearScale', cp, 0, 10),
    occludedScale: r.num(c, 'occludedScale', cp, 0, 1),
    panicFleeSpeed: r.num(c, 'panicFleeSpeed', cp, 0, 10),
    panicFleeSec: r.num(c, 'panicFleeSec', cp, 0, 30),
    securedTint: r.num(c, 'securedTint', cp, 0, 0xffffff),
  };
}

export function validateAIProfiles(raw: unknown, source = 'ai_profiles'): AIProfile[] {
  const r = new Reader(source);
  const o = r.obj(raw, '') as Partial<AIProfilesData>;
  const profiles: AIProfile[] = r.arr(o.profiles, 'profiles', 1).map((d, i) => {
    const p = `profiles[${i}]`;
    const e = r.obj(d, p);
    const type = r.oneOf(e, 'type', p, ['suspect', 'civilian'] as const);
    const th = r.obj(e.thresholds, `${p}.thresholds`);
    const mo = r.obj(e.modifiers, `${p}.modifiers`);
    const mp = `${p}.modifiers`;
    const surrenderBelow = r.num(th, 'surrenderBelow', `${p}.thresholds`, 0, 100);
    const hesitateBelow = r.num(th, 'hesitateBelow', `${p}.thresholds`, 0, 100);
    if (surrenderBelow > hesitateBelow) {
      r.fail(`${p}.thresholds`, 'surrenderBelow は hesitateBelow 以下である必要があります');
    }
    const modifiers: MoraleModifiers = {
      warningCall: r.range(mo, 'warningCall', mp),
      flashbang: r.range(mo, 'flashbang', mp),
      nonlethalHit: r.range(mo, 'nonlethalHit', mp),
      breach: r.num(mo, 'breach', mp, 0, 100),
      isolation: r.num(mo, 'isolation', mp, 0, 100),
    };
    return {
      id: r.str(e, 'id', p),
      name: r.str(e, 'name', p),
      type,
      initialMorale: r.num(e, 'initialMorale', p, 0, 100),
      moraleRecovery: r.num(e, 'moraleRecovery', p, 0),
      aggression: r.num(e, 'aggression', p, 0, 1),
      reactionTime: r.num(e, 'reactionTime', p, 0),
      hearingMultiplier: r.num(e, 'hearingMultiplier', p, 0),
      thresholds: { surrenderBelow, hesitateBelow },
      modifiers,
      combat: readCombat(r, e, p, type === 'suspect'),
      shield: type === 'suspect' ? readShield(r, e, p) : undefined,
      mobility: type === 'suspect' ? readMobility(r, e, p, true) : undefined,
      civilian: type === 'civilian' ? readCivilian(r, e, p, true) : undefined,
    };
  });
  r.uniqueIds(profiles, 'profiles');
  return profiles;
}

/** マップ内の entity.profile が ai_profiles に存在するか等の相互参照チェック。 */
export function validateCrossReferences(map: MapData, profiles: AIProfile[]): void {
  const ids = new Set(profiles.map((p) => p.id));
  map.entities.forEach((e, i) => {
    if (e.profile !== undefined && !ids.has(e.profile)) {
      throw new DataError(`map:${map.id}`, `entities[${i}].profile`, `ai_profiles.json に "${e.profile}" が存在しません`);
    }
  });
}

export function validatePlayerConfig(raw: unknown, source = 'player'): PlayerConfig {
  const r = new Reader(source);
  const o = r.obj(raw, '');
  const modes: MoveMode[] = ['run', 'quiet', 'crouch'];
  const perMode = (parent: Record<string, unknown>, key: string, path: string, min: number, max: number) => {
    const m = r.obj(parent[key], `${path}.${key}`);
    const out = {} as Record<MoveMode, number>;
    for (const k of modes) out[k] = r.num(m, k, `${path}.${key}`, min, max);
    return out;
  };
  const standEyeHeight = r.num(o, 'standEyeHeight', '', 0.5, 3);
  const crouchEyeHeight = r.num(o, 'crouchEyeHeight', '', 0.3, 3);
  if (crouchEyeHeight > standEyeHeight) r.fail('crouchEyeHeight', 'standEyeHeight 以下である必要があります');
  const fs = r.obj(o.footstep, 'footstep');
  const lean = r.obj(o.lean, 'lean');
  const w = r.obj(o.warning, 'warning');
  const ar = r.obj(o.arrest, 'arrest');
  return {
    maxHp: r.num(o, 'maxHp', '', 1, 1000),
    adsFovDeg: r.num(o, 'adsFovDeg', '', 20, 110),
    adsLerpSpeed: r.num(o, 'adsLerpSpeed', '', 1, 60),
    arrest: {
      range: r.num(ar, 'range', 'arrest', 0.3, 20),
      coneDeg: r.num(ar, 'coneDeg', 'arrest', 1, 360),
      holdSec: r.num(ar, 'holdSec', 'arrest', 0.1, 30),
      evidenceRange: r.num(ar, 'evidenceRange', 'arrest', 0.3, 20),
      evidenceHoldSec: r.num(ar, 'evidenceHoldSec', 'arrest', 0.05, 30),
      arrestText: r.str(ar, 'arrestText', 'arrest'),
      evidenceText: r.str(ar, 'evidenceText', 'arrest'),
      civilianRange: r.num(ar, 'civilianRange', 'arrest', 0.3, 20),
      civilianHoldSec: r.num(ar, 'civilianHoldSec', 'arrest', 0.1, 30),
      civilianText: r.str(ar, 'civilianText', 'arrest'),
      ...(ar.radioReportChance !== undefined
        ? { radioReportChance: r.num(ar, 'radioReportChance', 'arrest', 0, 1) }
        : {}),
    },
    warning: {
      range: r.num(w, 'range', 'warning', 1, 100),
      coneDeg: r.num(w, 'coneDeg', 'warning', 1, 360),
      cooldown: r.num(w, 'cooldown', 'warning', 0, 30),
      subtitleSec: r.num(w, 'subtitleSec', 'warning', 0.1, 30),
      text: r.str(w, 'text', 'warning'),
      noiseRadius: r.num(w, 'noiseRadius', 'warning', 0, 200),
    },
    radius: r.num(o, 'radius', '', 0.05, 2),
    standEyeHeight,
    crouchEyeHeight,
    eyeHeightLerpSpeed: r.num(o, 'eyeHeightLerpSpeed', '', 0.1, 100),
    mouseSensitivity: r.num(o, 'mouseSensitivity', '', 0.00001, 0.1),
    maxPitchDeg: r.num(o, 'maxPitchDeg', '', 1, 89.9),
    lean: {
      maxOffset: r.num(lean, 'maxOffset', 'lean', 0, 2),
      maxRollDeg: r.num(lean, 'maxRollDeg', 'lean', 0, 45),
      lerpSpeed: r.num(lean, 'lerpSpeed', 'lean', 0.1, 100),
      headRadius: r.num(lean, 'headRadius', 'lean', 0, 1),
    },
    speeds: perMode(o, 'speeds', '', 0, 30),
    footstep: {
      interval: perMode(fs, 'interval', 'footstep', 0.05, 10),
      radius: perMode(fs, 'radius', 'footstep', 0, 200),
    },
  };
}

export function validateDoorConfig(raw: unknown, source = 'doors'): DoorConfig {
  const r = new Reader(source);
  const o = r.obj(raw, '');
  const n = r.obj(o.noise, 'noise');
  const b = r.obj(o.breach, 'breach');
  const frameThickness = r.optNum(o, 'frameThickness', '', 0.01, 0.2);
  const frameDepth = r.optNum(o, 'frameDepth', '', 0.05, 0.6);
  const casingWidth = r.optNum(o, 'casingWidth', '', 0.01, 0.25);
  const casingDepth = r.optNum(o, 'casingDepth', '', 0.005, 0.1);
  const handleHeight = r.optNum(o, 'handleHeight', '', 0.5, 1.5);
  return {
    peekAngle: r.num(o, 'peekAngle', '', 5, 60),
    thickness: r.num(o, 'thickness', '', 0.01, 0.3),
    height: r.num(o, 'height', '', 0.5, 10),
    ...(frameThickness !== undefined ? { frameThickness } : {}),
    ...(frameDepth !== undefined ? { frameDepth } : {}),
    ...(casingWidth !== undefined ? { casingWidth } : {}),
    ...(casingDepth !== undefined ? { casingDepth } : {}),
    ...(handleHeight !== undefined ? { handleHeight } : {}),
    segmentLength: r.num(o, 'segmentLength', '', 0.02, 0.5),
    swingSpeed: r.num(o, 'swingSpeed', '', 1, 720),
    knobSpeedMultiplier: r.num(o, 'knobSpeedMultiplier', '', 1, 20),
    knobZone: r.num(o, 'knobZone', '', 0, 1),
    interactRange: r.num(o, 'interactRange', '', 0.3, 10),
    wheelStepThreshold: r.num(o, 'wheelStepThreshold', '', 1, 10000),
    noise: { slowRadius: r.num(n, 'slowRadius', 'noise', 0, 200), fastRadius: r.num(n, 'fastRadius', 'noise', 0, 200) },
    breach: {
      speedMultiplier: r.num(b, 'speedMultiplier', 'breach', 1, 50),
      noiseRadius: r.num(b, 'noiseRadius', 'breach', 0, 200),
      effectRadius: r.num(b, 'effectRadius', 'breach', 0, 50),
    },
  };
}

const SCORE_KINDS: readonly ScoreKind[] = [
  'arrest',
  'civilianSecured',
  'evidence',
  'neutralize',
  'fireWithoutWarning',
  'fireOnSurrendered',
  'civilianHit',
  'nonlethalCivilianHit',
  'friendlyFire',
];

export function validatePerception(raw: unknown, source = 'perception'): PerceptionConfig {
  const r = new Reader(source);
  const o = r.obj(raw, '');
  const h = r.obj(o.hearing, 'hearing');
  const v = r.obj(o.vision, 'vision');
  const ks = r.obj(h.kinds, 'hearing.kinds');
  const kinds: Record<string, number> = {};
  for (const k of Object.keys(ks)) kinds[k] = r.num(ks, k, 'hearing.kinds', 0);
  return {
    hearing: {
      occludedMultiplier: r.num(h, 'occludedMultiplier', 'hearing', 0, 1),
      unoccludedKinds: r.arr(h.unoccludedKinds, 'hearing.unoccludedKinds').map((k, i): string => {
        if (typeof k !== 'string') return r.fail(`hearing.unoccludedKinds[${i}]`, '文字列が必要です');
        return k;
      }),
      kinds,
    },
    vision: {
      fovDeg: r.num(v, 'fovDeg', 'vision', 1, 360),
      range: r.num(v, 'range', 'vision', 0),
      alertFovDeg: r.num(v, 'alertFovDeg', 'vision', 1, 360),
      eyeHeight: r.num(v, 'eyeHeight', 'vision', 0),
      bodyPointDrop: r.num(v, 'bodyPointDrop', 'vision', 0),
      crouchRangeMultiplier: r.num(v, 'crouchRangeMultiplier', 'vision', 0, 1),
      alertReactionMultiplier: r.num(v, 'alertReactionMultiplier', 'vision', 0, 1),
    },
  };
}

export function validateRoe(raw: unknown, source = 'roe'): RoeConfig {
  const r = new Reader(source);
  const o = r.obj(raw, '');
  const pts = r.obj(o.points, 'points');
  const lbl = r.obj(o.labels, 'labels');
  const points = {} as Record<ScoreKind, number>;
  const labels = {} as Record<ScoreKind, string>;
  for (const k of SCORE_KINDS) {
    points[k] = r.num(pts, k, 'points');
    labels[k] = r.str(lbl, k, 'labels');
  }
  const hostileStates: string[] = [];
  r.arr(o.hostileStates, 'hostileStates').forEach((v, i) => {
    if (typeof v !== 'string') return r.fail(`hostileStates[${i}]`, '文字列が必要です');
    hostileStates.push(v);
  });
  const ranks = r.arr(o.ranks, 'ranks', 1).map((d, i) => {
    const p = `ranks[${i}]`;
    const e = r.obj(d, p);
    const minScore = r.num(e, 'minScore', p);
    const minRatio = r.optNum(e, 'minRatio', p, -Infinity, 1);
    const label = r.str(e, 'label', p);
    return minRatio !== undefined ? { minScore, minRatio, label } : { minScore, label };
  });
  for (let i = 1; i < ranks.length; i++) {
    const prev = ranks[i - 1];
    const cur = ranks[i];
    if (prev && cur && prev.minScore <= cur.minScore) r.fail('ranks', 'minScore は降順で指定してください');
    if (prev && cur && prev.minRatio !== undefined && cur.minRatio !== undefined && prev.minRatio <= cur.minRatio) {
      r.fail('ranks', 'minRatio は降順で指定してください');
    }
  }
  return { points, labels, violationOncePerTarget: r.bool(o, 'violationOncePerTarget', ''), hostileStates, ranks };
}

function range2(r: Reader, o: Record<string, unknown>, key: string, path: string): { min: number; max: number } {
  const e = r.obj(o[key], `${path}.${key}`);
  const min = r.num(e, 'min', `${path}.${key}`, 0, 100);
  const max = r.num(e, 'max', `${path}.${key}`, 0, 100);
  if (min > max) r.fail(`${path}.${key}`, 'min <= max にしてください');
  return { min, max };
}

function strArr(r: Reader, v: unknown, path: string): string[] {
  return r.arr(v, path).map((x, i): string => (typeof x === 'string' ? x : r.fail(`${path}[${i}]`, '文字列が必要です')));
}

export function validateNegotiation(raw: unknown, source = 'negotiation'): NegotiationConfig {
  const r = new Reader(source);
  const o = r.obj(raw, '');
  const to = r.obj(o.timeout, 'timeout');
  const demands: Record<string, string> = {};
  const dm = r.obj(o.demands, 'demands');
  for (const k of Object.keys(dm)) demands[k] = r.str(dm, k, 'demands');
  const tx = r.obj(o.text, 'text');
  const text = {} as NegotiationConfig['text'];
  for (const k of ['hintIdle', 'hintReady', 'hintShield', 'cancel', 'surrender', 'release', 'fire', 'worsen', 'interrupted', 'locked'] as const) {
    text[k] = r.str(tx, k, 'text');
  }
  const choices = r.arr(o.choices, 'choices', 1).map((d, i) => {
    const p = `choices[${i}]`;
    const e = r.obj(d, p);
    const ch = r.obj(e.chance, `${p}.chance`);
    const cp = `${p}.chance`;
    const cMin = r.num(ch, 'min', cp, 0, 1);
    const cMax = r.num(ch, 'max', cp, 0, 1);
    if (cMin > cMax) r.fail(cp, 'min <= max にしてください');
    return {
      id: r.str(e, 'id', p),
      label: r.str(e, 'label', p),
      key: r.str(e, 'key', p),
      playerLine: r.str(e, 'playerLine', p),
      chance: {
        base: r.num(ch, 'base', cp, 0, 1),
        aggressionWeight: r.num(ch, 'aggressionWeight', cp, 0, 2),
        moraleWeight: r.num(ch, 'moraleWeight', cp, 0, 2),
        trustBonus: r.num(ch, 'trustBonus', cp, 0, 1),
        min: cMin,
        max: cMax,
      },
      successMorale: range2(r, e, 'successMorale', p),
      failMorale: range2(r, e, 'failMorale', p),
      fireChanceOnFail: r.num(e, 'fireChanceOnFail', p, 0, 1),
      trustGain: r.num(e, 'trustGain', p, 0, 10),
      revealDemand: r.bool(e, 'revealDemand', p),
      successLine: r.str(e, 'successLine', p),
      failLine: r.str(e, 'failLine', p),
    };
  });
  const keys = new Set<string>();
  for (const c of choices) {
    if (keys.has(c.key)) r.fail('choices', `キー ${c.key} が重複しています`);
    keys.add(c.key);
  }
  return {
    range: r.num(o, 'range', '', 0.5, 100),
    abortRangeMultiplier: r.num(o, 'abortRangeMultiplier', '', 1, 10),
    coneDeg: r.num(o, 'coneDeg', '', 1, 360),
    allowedStates: strArr(r, o.allowedStates, 'allowedStates'),
    blockers: strArr(r, o.blockers, 'blockers'),
    directSightStates: strArr(r, o.directSightStates, 'directSightStates'),
    timeoutSec: r.num(o, 'timeoutSec', '', 1, 600),
    choiceCooldownSec: r.num(o, 'choiceCooldownSec', '', 0, 30),
    maxFails: r.num(o, 'maxFails', '', 1, 20),
    trustMax: r.num(o, 'trustMax', '', 0, 20),
    shieldReleaseBelow: r.num(o, 'shieldReleaseBelow', '', 0, 100),
    lockoutSec: r.num(o, 'lockoutSec', '', 0, 120),
    resultHoldSec: r.num(o, 'resultHoldSec', '', 0, 30),
    timeout: {
      moraleRise: range2(r, to, 'moraleRise', 'timeout'),
      fireChance: r.num(to, 'fireChance', 'timeout', 0, 1),
      shieldFireChance: r.num(to, 'shieldFireChance', 'timeout', 0, 1),
    },
    cancelKey: r.str(o, 'cancelKey', ''),
    demands,
    defaultDemand: r.str(o, 'defaultDemand', ''),
    text,
    choices,
  };
}

const SQUAD_ORDERS: readonly SquadOrder[] = [
  'follow',
  'hold',
  'move',
  'overwatch',
  'stack',
  'clear',
  'flashClear',
  'breachClear',
  'pieDoor',
  'restrain',
] as const;

const SQUAD_ELEMENTS: readonly SquadElement[] = ['gold', 'alpha', 'bravo'] as const;

export function validateSquad(raw: unknown, source = 'squad'): SquadConfig {
  const r = new Reader(source);
  const o = r.obj(raw, '');
  const labelsRaw = r.obj(o.orderLabels, 'orderLabels');
  const orderLabels = {} as SquadConfig['orderLabels'];
  for (const key of SQUAD_ORDERS) {
    orderLabels[key] = r.str(labelsRaw, key, 'orderLabels');
  }
  const elementsRaw = r.obj(o.elementLabels, 'elementLabels');
  const elementLabels = {} as SquadConfig['elementLabels'];
  for (const key of SQUAD_ELEMENTS) {
    elementLabels[key] = r.str(elementsRaw, key, 'elementLabels');
  }
  const states = (key: string): string[] => {
    const out: string[] = [];
    r.arr(o[key], key, 1).forEach((v, i) => {
      if (typeof v !== 'string' || v === '') r.fail(`${key}[${i}]`, '空でない文字列が必要です');
      else out.push(v);
    });
    return out;
  };
  const stuckResetSec = r.num(o, 'stuckResetSec', '', 0.3, 10);
  const stuckRecoverSec = r.num(o, 'stuckRecoverSec', '', 0.5, 20);
  if (stuckRecoverSec < stuckResetSec) {
    r.fail('stuckRecoverSec', 'stuckResetSec 以上である必要があります');
  }
  return {
    moveSpeed: r.num(o, 'moveSpeed', '', 0.2, 8),
    followDistance: r.num(o, 'followDistance', '', 0.4, 6),
    followLateral: r.num(o, 'followLateral', '', 0, 3),
    stackOffset: r.num(o, 'stackOffset', '', 0.1, 2),
    clearDepth: r.num(o, 'clearDepth', '', 0.5, 8),
    clearLateral: r.num(o, 'clearLateral', '', 0.2, 4),
    staggerSec: r.num(o, 'staggerSec', '', 0, 3),
    dominationDepth: r.num(o, 'dominationDepth', '', 0.5, 8),
    dominationLateral: r.num(o, 'dominationLateral', '', 0.2, 5),
    presenceBonusPerAlly: r.num(o, 'presenceBonusPerAlly', '', 0, 2),
    personalSpace: r.num(o, 'personalSpace', '', 0.2, 3),
    arriveDistance: r.num(o, 'arriveDistance', '', 0.05, 1.5),
    engageRange: r.num(o, 'engageRange', '', 1, 40),
    fireInterval: r.num(o, 'fireInterval', '', 0.05, 3),
    damage: r.num(o, 'damage', '', 0, 100),
    warningInterval: r.num(o, 'warningInterval', '', 0.5, 20),
    flashDelay: r.num(o, 'flashDelay', '', 0, 5),
    bodyRadius: r.num(o, 'bodyRadius', '', 0.15, 0.6),
    eyeHeight: r.num(o, 'eyeHeight', '', 0.8, 2),
    doorOpenAngle: r.num(o, 'doorOpenAngle', '', 10, 100),
    stairArrive: r.num(o, 'stairArrive', '', 0.2, 2),
    stuckResetSec,
    stuckRecoverSec,
    stairStallResetSec: r.num(o, 'stairStallResetSec', '', 0.4, 10),
    stairExitRadius: r.num(o, 'stairExitRadius', '', 0.2, 1.5),
    stackWaitTimeoutSec: r.num(o, 'stackWaitTimeoutSec', '', 1, 30),
    doorOpenTimeoutSec: r.num(o, 'doorOpenTimeoutSec', '', 0.5, 15),
    hostileStates: states('hostileStates'),
    warnStates: states('warnStates'),
    hint: r.str(o, 'hint', ''),
    orderLabels,
    elementLabels,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new DataError(url, '', `取得に失敗しました: ${String(err)}`);
  }
  if (!res.ok) throw new DataError(url, '', `HTTP ${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch (err) {
    throw new DataError(url, '', `JSON として解析できません: ${String(err)}`);
  }
}

function dataUrl(path: string): string {
  return `${import.meta.env.BASE_URL}data/${path}`;
}

export const DataLoader = {
  async loadStages(): Promise<StageEntry[]> {
    const url = dataUrl('stages.json');
    return validateStages(await fetchJson(url), url);
  },
  async loadMap(mapId: string): Promise<MapData> {
    if (!STAGE_ID_RE.test(mapId)) {
      throw new DataError('map', 'mapId', `不正なステージID "${mapId}" です（英数字・ハイフン・アンダースコアのみ使用できます）`);
    }
    const url = dataUrl(`maps/${mapId}.json`);
    return validateMap(await fetchJson(url), url);
  },
  async loadWeapons(): Promise<WeaponDef[]> {
    const url = dataUrl('weapons.json');
    return validateWeapons(await fetchJson(url), url);
  },
  async loadAIProfiles(): Promise<AIProfile[]> {
    const url = dataUrl('ai_profiles.json');
    return validateAIProfiles(await fetchJson(url), url);
  },
  async loadPlayerConfig(): Promise<PlayerConfig> {
    const url = dataUrl('player.json');
    return validatePlayerConfig(await fetchJson(url), url);
  },
  async loadDoorConfig(): Promise<DoorConfig> {
    const url = dataUrl('doors.json');
    return validateDoorConfig(await fetchJson(url), url);
  },
  async loadPerception(): Promise<PerceptionConfig> {
    const url = dataUrl('perception.json');
    return validatePerception(await fetchJson(url), url);
  },
  async loadNegotiation(): Promise<NegotiationConfig> {
    const url = dataUrl('negotiation.json');
    return validateNegotiation(await fetchJson(url), url);
  },
  async loadRoe(): Promise<RoeConfig> {
    const url = dataUrl('roe.json');
    return validateRoe(await fetchJson(url), url);
  },
  async loadSquad(): Promise<SquadConfig> {
    const url = dataUrl('squad.json');
    return validateSquad(await fetchJson(url), url);
  },
  async loadGeneratorTemplate(generatorId: string): Promise<AnyGeneratorTemplate> {
    if (!STAGE_ID_RE.test(generatorId)) {
      throw new DataError('generator', 'generatorId', `不正な生成器ID "${generatorId}" です`);
    }
    const url = dataUrl(`generators/${generatorId}.json`);
    return validateGeneratorTemplate(await fetchJson(url), url);
  },
  /**
   * ステージのマップを取得。generator 指定ステージは seed から間取りを生成し、固定マップと同じ validateMap を通す。
   */
  async loadStageMap(
    stage: StageEntry,
    seed: number | undefined,
    profiles: AIProfile[],
    doorConfig?: DoorConfig,
  ): Promise<MapData> {
    if (stage.generator === undefined) return DataLoader.loadMap(stage.id);
    if (seed === undefined || !Number.isFinite(seed)) {
      throw new DataError('map', 'seed', `ランダム生成ステージ "${stage.id}" には有限数値のシードが必要です (現在 ${String(seed)})`);
    }
    const tpl = await DataLoader.loadGeneratorTemplate(stage.generator);
    validateGeneratorReferences(tpl, profiles);
    if (tpl.type === 'modular') {
      // 扉リーフ高は doors.json の height を一元契約として生成器へ渡す（§2.2）。
      const doorLeafHeight = modularDoorLeafHeight(doorConfig);
      verifyModularFallback(tpl, doorLeafHeight);
      return validateMap(generateMap(tpl, seed, stage.id, doorLeafHeight), `generator:${tpl.id}#${seed}`);
    }
    return validateMap(generateMap(tpl, seed, stage.id), `generator:${tpl.id}#${seed}`);
  },
  /** 共通JSONを並列ロードし検証、続いてステージのマップを読み込み/生成。不正なら DataError を throw。 */
  async loadAll(stage: StageEntry, seed?: number): Promise<GameData> {
    const [player, doors, weapons, aiProfiles, roe, perception, negotiation, squad] = await Promise.all([
      DataLoader.loadPlayerConfig(),
      DataLoader.loadDoorConfig(),
      DataLoader.loadWeapons(),
      DataLoader.loadAIProfiles(),
      DataLoader.loadRoe(),
      DataLoader.loadPerception(),
      DataLoader.loadNegotiation(),
      DataLoader.loadSquad(),
    ]);
    const map = await DataLoader.loadStageMap(stage, seed, aiProfiles, doors);
    validateCrossReferences(map, aiProfiles);
    return { player, doors, map, weapons, aiProfiles, roe, perception, negotiation, squad };
  },
};
