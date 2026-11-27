import type {
  ArmorConfig,
  AllyWoundsConfig,
  DoorCheckConfig,
  DoorTrapConfig,
  SquadInventoryConfig,
  SuspectAlertConfig,
  AmbushParams,
  MirrorConfig,
  OptiwandConfig,
  WoundsConfig,
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
  AircraftBlockDef,
  AircraftBlockKind,
  AircraftGeneratorTemplate,
  AircraftRoomDef,
  AircraftSeatingDef,
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
  MotifId,
  StageEntry,
  StageVariant,
  StagesData,
  ThrowableDef,
  WeaponDef,
  WeaponsData,
} from './types';
import { MOTIF_IDS } from './types';
import { generateMap, pickStageVariant, verifyFallbackFeasibility } from '../world/generator';

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

  /** 省略可能な数値（省略時は fallback を返す。指定時は範囲検証する） */
  numOr(o: Record<string, unknown>, key: string, path: string, fallback: number, min = -Infinity, max = Infinity): number {
    return o[key] === undefined ? fallback : this.num(o, key, path, min, max);
  }

  /** 長さ n の数値タプル（省略時は fallback） */
  tupleOr<N extends number[]>(o: Record<string, unknown>, key: string, path: string, fallback: N, min: number, max: number): N {
    const v = o[key];
    if (v === undefined) return [...fallback] as N;
    const a = this.arr(v, `${path}.${key}`);
    if (a.length !== fallback.length) this.fail(`${path}.${key}`, `要素数 ${fallback.length} の配列が必要です`);
    return a.map((x, i) => {
      if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
        this.fail(`${path}.${key}[${i}]`, `範囲 ${min}〜${max} の有限数値が必要です`);
      }
      return x as number;
    }) as N;
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
  if (typeof o.prop === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(o.prop)) box.prop = o.prop;
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
  const motif = o.motif === undefined ? undefined : r.oneOf(o, 'motif', '', MOTIF_IDS);
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
    ...(motif !== undefined ? { motif } : {}),
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
  const raws = r.arr(o.stages, 'stages', 1);
  // 固定マップは廃止。generator の無いエントリ（古い stages.json のキャッシュ等）は読み飛ばす
  const legacy = raws.filter((d) => typeof d === 'object' && d !== null && (d as Record<string, unknown>).generator === undefined);
  if (legacy.length > 0) {
    console.warn(`[DataLoader] ${source}: generator の無い固定マップのステージ ${legacy.length} 件を無視します（固定マップは廃止）`);
  }
  const usable = raws.filter((d) => !legacy.includes(d));
  if (usable.length === 0) r.fail('stages', 'ランダム生成ステージ（generator 指定）が 1 件以上必要です');
  const stages: StageEntry[] = usable.map((d) => {
    const p = `stages[${raws.indexOf(d)}]`;
    const e = r.obj(d, p);
    const id = r.str(e, 'id', p);
    if (!STAGE_ID_RE.test(id)) {
      r.fail(`${p}.id`, '英数字・ハイフン・アンダースコアのみ使用できます');
    }
    const name = r.str(e, 'name', p);
    const generator = r.str(e, 'generator', p);
    if (!STAGE_ID_RE.test(generator)) r.fail(`${p}.generator`, '英数字・ハイフン・アンダースコアのみ使用できます');
    const entry: StageEntry = { id, name, generator };
    const desc = e.description;
    if (desc !== undefined) {
      if (typeof desc === 'string') {
        entry.description = desc;
      } else {
        r.fail(`${p}.description`, '文字列が必要です');
      }
    }
    for (const key of ['size', 'tagline'] as const) {
      const v = e[key];
      if (v === undefined) continue;
      if (typeof v === 'string') entry[key] = v;
      else r.fail(`${p}.${key}`, '文字列が必要です');
    }
    if (e.variants !== undefined) {
      entry.variants = r.arr(e.variants, `${p}.variants`, 1).map((vd, j) => {
        const vp = `${p}.variants[${j}]`;
        const ve = r.obj(vd, vp);
        const gen = r.str(ve, 'generator', vp);
        if (!STAGE_ID_RE.test(gen)) r.fail(`${vp}.generator`, '英数字・ハイフン・アンダースコアのみ使用できます');
        const variant: StageVariant = { generator: gen, weight: r.num(ve, 'weight', vp, 0) };
        if (ve.motifs !== undefined) {
          const mo = r.obj(ve.motifs, `${vp}.motifs`);
          const motifs: Partial<Record<MotifId, number>> = {};
          for (const [k, w] of Object.entries(mo)) {
            if (!(MOTIF_IDS as readonly string[]).includes(k)) r.fail(`${vp}.motifs.${k}`, '未知のモチーフ ID です');
            if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) r.fail(`${vp}.motifs.${k}`, '0 以上の数値が必要です');
            motifs[k as MotifId] = w as number;
          }
          if (!Object.values(motifs).some((w) => (w ?? 0) > 0)) r.fail(`${vp}.motifs`, '正の重みが 1 つ以上必要です');
          variant.motifs = motifs;
        }
        return variant;
      });
      if (!entry.variants.some((v) => v.weight > 0)) r.fail(`${p}.variants`, '正の重みが 1 つ以上必要です');
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
  const type = r.oneOf(o, 'type', '', ['house', 'modular', 'aircraft'] as const);
  if (type === 'modular') return validateModularTemplate(r, o);
  if (type === 'aircraft') return validateAircraftTemplate(r, o);
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

/** doors.json の扉リーフ高（モジュラー/航空機生成の扉開口高の一元契約）。>= 2.05m でなければ DataError。 */
export function modularDoorLeafHeight(doorConfig: DoorConfig | undefined): number {
  if (doorConfig === undefined) throw new DataError('doors', 'height', 'type "modular" / "aircraft" の生成には doors.json の設定が必要です');
  if (!(doorConfig.height >= MIN_HEADROOM)) {
    throw new DataError('doors', 'height', `扉高 ${doorConfig.height} は ${MIN_HEADROOM}m 以上が必要です`);
  }
  return doorConfig.height;
}

const verifiedModularTemplates = new WeakMap<ModularGeneratorTemplate, Set<number>>();

/**
 * モジュラーテンプレートの最小構成（フォールバック）成立検証（設計書 §3.2-5 / BC-11）。
 * 重み > 0 の全階層プロファイルで最小構成器を実行し、不成立なら DataError。
 * 同一テンプレート・扉高の組み合わせはセッション内で 1 回だけ検証する。
 */
export function verifyModularFallback(tpl: ModularGeneratorTemplate, doorLeafHeight: number): void {
  let heights = verifiedModularTemplates.get(tpl);
  if (heights?.has(doorLeafHeight)) return;
  // 不成立時は生成器側が DataError（FallbackInfeasibleError は DataError の派生）を直接送出する
  verifyFallbackFeasibility(tpl, doorLeafHeight);
  if (!heights) {
    heights = new Set<number>();
    verifiedModularTemplates.set(tpl, heights);
  }
  heights.add(doorLeafHeight);
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

const AIRCRAFT_ROOM_ID_RE = /^[a-z0-9_]+$/;
const AIRCRAFT_BLOCK_KINDS: readonly AircraftBlockKind[] = ['head', 'suite', 'entry', 'cabin'];

function parseAircraftRoom(r: Reader, v: unknown, path: string, doorPassMin: number): AircraftRoomDef {
  const e = r.obj(v, path);
  const id = r.str(e, 'id', path);
  if (!AIRCRAFT_ROOM_ID_RE.test(id)) r.fail(`${path}.id`, '英小文字・数字・アンダースコアのみ使用できます');
  const minCount = e.minCount === undefined ? 0 : int(r, e, 'minCount', path, 0, 10);
  const maxCount = e.maxCount === undefined ? 1 : int(r, e, 'maxCount', path, 1, 10);
  if (minCount > maxCount) r.fail(path, 'minCount は maxCount 以下である必要があります');
  let seating: AircraftSeatingDef | undefined;
  if (e.seating !== undefined) {
    const sp = `${path}.seating`;
    const se = r.obj(e.seating, sp);
    seating = {
      prop: r.str(se, 'prop', sp),
      width: r.num(se, 'width', sp, 0.1, 5),
      depth: r.num(se, 'depth', sp, 0.1, 5),
      height: r.num(se, 'height', sp, 0.1, 5),
      pitch: r.num(se, 'pitch', sp, 0.5, 10),
    };
  }
  const fm = optStr(r, e, 'floorMaterial', path);
  return {
    id,
    name: r.str(e, 'name', path),
    length: numRange(r, e, 'length', path, doorPassMin - DIM_TOL, 100),
    spawnWeight: r.num(e, 'spawnWeight', path, 0),
    ...(fm !== undefined ? { floorMaterial: fm } : {}),
    private: optBool(r, e, 'private', path, false),
    weight: e.weight === undefined ? 1 : r.num(e, 'weight', path, 0),
    minCount,
    maxCount,
    ...(seating !== undefined ? { seating } : {}),
    furniture: parseModularFurniture(r, e.furniture, `${path}.furniture`),
  };
}

function validateAircraftTemplate(r: Reader, o: Record<string, unknown>): AircraftGeneratorTemplate {
  const wallThickness = r.num(o, 'wallThickness', '', 0.1, 0.4);
  const slabThickness = r.num(o, 'slabThickness', '', 0.1, 0.4);
  const deckRise = r.num(o, 'deckRise', '', 2.8, 3.6);
  if (deckRise - slabThickness < MIN_STORY_CLEARANCE - DIM_TOL) {
    r.fail('deckRise', `deckRise - slabThickness = ${deckRise - slabThickness} は ${MIN_STORY_CLEARANCE}m 以上が必要です`);
  }
  const snapRaw = r.num(o, 'snap', '', 0, 1);
  if (snapRaw !== 0.25 && snapRaw !== 0.5) r.fail('snap', `0.25 | 0.5 のいずれかが必要です (現在 ${snapRaw})`);
  const snap: ModularSnap = snapRaw;
  const maxAttempts = int(r, o, 'maxAttempts', '', 1, 200);

  const dr = r.obj(o.door, 'door');
  const doorWidth = r.num(dr, 'width', 'door', MIN_DOOR_WIDTH, 3);
  const doorMargin = r.num(dr, 'margin', 'door', 0.15, 2);
  const door = {
    width: doorWidth,
    maxAngle: r.num(dr, 'maxAngle', 'door', 90, 130),
    margin: doorMargin,
    swingClearance: r.num(dr, 'swingClearance', 'door', 0.3, 5),
    lockedChance: r.num(dr, 'lockedChance', 'door', 0, 1),
    maxLocked: int(r, dr, 'maxLocked', 'door', 0, 50),
    extraDoorChance: r.num(dr, 'extraDoorChance', 'door', 0, 1),
  };
  const doorPassMin = doorWidth + wallThickness + 2 * doorMargin;

  const sr = r.obj(o.stairs, 'stairs');
  const stairRise = r.num(sr, 'rise', 'stairs', 0.12, 0.24);
  const steps = Math.round(deckRise / stairRise);
  if (Math.abs(steps * stairRise - deckRise) >= 1e-6 || steps > 40) {
    r.fail('stairs.rise', `deckRise=${deckRise} を整数段 (<=40) で割り切れません (rise=${stairRise})`);
  }
  const stairs = {
    rise: stairRise,
    run: r.num(sr, 'run', 'stairs', 0.24, 0.34),
    flightWidth: r.num(sr, 'flightWidth', 'stairs', 0.9, 2),
    landing: r.num(sr, 'landing', 'stairs', 1.0, 10),
    parapetHeight: r.num(sr, 'parapetHeight', 'stairs', MIN_PARAPET_HEIGHT, 2),
  };

  const fu = r.obj(o.fuselage, 'fuselage');
  const fuselageWidth = numRange(r, fu, 'width', 'fuselage', 1, 30);
  const fuselageLength = numRange(r, fu, 'length', 'fuselage', 10, 200);
  const corridorWidth = numRange(r, fu, 'corridorWidth', 'fuselage', doorPassMin - DIM_TOL, 10);
  if (fuselageWidth.min - corridorWidth.max - wallThickness < stairs.flightWidth + 1.2 - DIM_TOL) {
    r.fail('fuselage.width', '胴体最小幅が通路最大幅＋階段幅＋余白 1.2m に対して狭すぎます');
  }
  const fuselage = {
    width: fuselageWidth,
    length: fuselageLength,
    corridorWidth,
    corridorName: r.str(fu, 'corridorName', 'fuselage'),
    corridorSpawnWeight: r.num(fu, 'corridorSpawnWeight', 'fuselage', 0),
  };

  const as = r.obj(o.airstair, 'airstair');
  const airstair = {
    width: r.num(as, 'width', 'airstair', 0.8, 4),
    platformDepth: r.num(as, 'platformDepth', 'airstair', 1.0, 10),
    platformWidth: r.num(as, 'platformWidth', 'airstair', 1.5, 10),
    aftChance: r.num(as, 'aftChance', 'airstair', 0, 1),
  };

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
    margin: r.num(st, 'margin', 'site', 0, 50),
    spawnSetback: r.num(st, 'spawnSetback', 'site', 1, 50),
    allyLateralOffset: r.num(st, 'allyLateralOffset', 'site', 0.5, 10),
    allyBackOffset: r.num(st, 'allyBackOffset', 'site', 0.2, 10),
    approachName: r.str(st, 'approachName', 'site'),
  };

  const wn = r.obj(o.window, 'window');
  const winHeight = r.num(wn, 'height', 'window', 0.3, 1.2);
  const winSill = r.num(wn, 'sill', 'window', 0.2, 3);
  const winLimit = deckRise - slabThickness - 0.1;
  if (winSill + winHeight > winLimit + DIM_TOL) {
    r.fail('window', `sill + height = ${winSill + winHeight} が上限 ${winLimit} を超えます`);
  }
  const win = {
    chance: r.num(wn, 'chance', 'window', 0, 1),
    width: r.num(wn, 'width', 'window', 0.3, 1.2),
    height: winHeight,
    sill: winSill,
    spacing: r.num(wn, 'spacing', 'window', 0.5, 20),
    maxPerRoom: int(r, wn, 'maxPerRoom', 'window', 1, 20),
  };

  const ex = r.obj(o.exterior, 'exterior');
  const exterior = {
    wingSpan: r.num(ex, 'wingSpan', 'exterior', 1, 60),
    wingChord: r.num(ex, 'wingChord', 'exterior', 1, 40),
    finHeight: r.num(ex, 'finHeight', 'exterior', 1, 20),
    engines: r.bool(ex, 'engines', 'exterior'),
  };

  const md = r.obj(o.mainDeck, 'mainDeck');
  const blocks: AircraftBlockDef[] = r.arr(md.blocks, 'mainDeck.blocks', 1).map((d, i) => {
    const p = `mainDeck.blocks[${i}]`;
    const e = r.obj(d, p);
    const kind = r.oneOf(e, 'kind', p, AIRCRAFT_BLOCK_KINDS);
    const rooms = r.arr(e.rooms, `${p}.rooms`, 1).map((rd, j) => parseAircraftRoom(r, rd, `${p}.rooms[${j}]`, doorPassMin));
    r.uniqueIds(rooms, `${p}.rooms`);
    const blk: AircraftBlockDef = {
      id: r.str(e, 'id', p),
      kind,
      chance: r.num(e, 'chance', p, 0, 1),
      rooms,
      hostsUpperStair: optBool(r, e, 'hostsUpperStair', p, false),
      hostsLowerStair: optBool(r, e, 'hostsLowerStair', p, false),
    };
    if (kind === 'suite') {
      if (e.compartments === undefined) r.fail(`${p}.compartments`, 'suite ブロックには compartments が必要です');
      blk.compartments = intRange(r, e, 'compartments', p, 1, 6);
    } else if (e.compartments !== undefined) {
      blk.compartments = intRange(r, e, 'compartments', p, 1, 6);
    }
    return blk;
  });
  r.uniqueIds(blocks, 'mainDeck.blocks');
  if (!blocks.some((b) => b.kind === 'entry' && b.chance === 1)) {
    r.fail('mainDeck.blocks', 'chance=1 の entry ブロックが 1 つ以上必要です');
  }

  const ud = r.obj(o.upperDeck, 'upperDeck');
  const upperDeck = {
    chance: r.num(ud, 'chance', 'upperDeck', 0, 1),
    corridorName: r.str(ud, 'corridorName', 'upperDeck'),
    stairRoomName: r.str(ud, 'stairRoomName', 'upperDeck'),
    stairRoomUpperName: r.str(ud, 'stairRoomUpperName', 'upperDeck'),
    cockpit: parseAircraftRoom(r, ud.cockpit, 'upperDeck.cockpit', doorPassMin),
    forward: r.arr(ud.forward, 'upperDeck.forward', 1).map((rd, j) => parseAircraftRoom(r, rd, `upperDeck.forward[${j}]`, doorPassMin)),
    aft: r.arr(ud.aft, 'upperDeck.aft', 1).map((rd, j) => parseAircraftRoom(r, rd, `upperDeck.aft[${j}]`, doorPassMin)),
    aftChance: r.num(ud, 'aftChance', 'upperDeck', 0, 1),
  };

  const ld = r.obj(o.lowerDeck, 'lowerDeck');
  const lowerDeck = {
    chance: r.num(ld, 'chance', 'lowerDeck', 0, 1),
    stairRoomName: r.str(ld, 'stairRoomName', 'lowerDeck'),
    stairRoomLowerName: r.str(ld, 'stairRoomLowerName', 'lowerDeck'),
    passageName: r.str(ld, 'passageName', 'lowerDeck'),
    aftHold: r.arr(ld.aftHold, 'lowerDeck.aftHold', 1).map((rd, j) => parseAircraftRoom(r, rd, `lowerDeck.aftHold[${j}]`, doorPassMin)),
    foreHold: r.arr(ld.foreHold, 'lowerDeck.foreHold', 1).map((rd, j) => parseAircraftRoom(r, rd, `lowerDeck.foreHold[${j}]`, doorPassMin)),
    foreChance: r.num(ld, 'foreChance', 'lowerDeck', 0, 1),
    hatchChance: r.num(ld, 'hatchChance', 'lowerDeck', 0, 1),
  };

  const ent = r.obj(o.entities, 'entities');
  const suspectProfiles = r.arr(ent.suspectProfiles, 'entities.suspectProfiles', 1).map((d, i) => {
    const p = `entities.suspectProfiles[${i}]`;
    const e = r.obj(d, p);
    return { profile: r.str(e, 'profile', p), weight: r.num(e, 'weight', p, 0), max: int(r, e, 'max', p, 0, 40) };
  });
  const suspects = intRange(r, ent, 'suspects', 'entities', 1, 40);
  const sumMax = suspectProfiles.reduce((a, sp) => a + sp.max, 0);
  if (sumMax < suspects.max) r.fail('entities.suspectProfiles', `max の合計 ${sumMax} が suspects.max ${suspects.max} 未満です`);

  return {
    type: 'aircraft',
    id: r.str(o, 'id', ''),
    name: r.str(o, 'name', ''),
    summaries: strList(r, o.summaries, 'summaries', 1),
    wallThickness,
    slabThickness,
    deckRise,
    snap,
    maxAttempts,
    fuselage,
    stairs,
    airstair,
    site,
    door,
    window: win,
    exterior,
    furnitureGap: r.num(o, 'furnitureGap', '', 0, 3),
    wallClearance: r.num(o, 'wallClearance', '', 0, 3),
    mainDeck: { blocks },
    upperDeck,
    lowerDeck,
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

export const DEFAULT_AMBUSH: AmbushParams = {
  chance: 0.5,
  preAimReactionSec: 0.16,
  firstBurstSpreadMul: 0.45,
  maxDist: 14,
  holdSec: 25,
  firstBurstShots: 3,
  coneDeg: 70,
};

function readAmbush(r: Reader, e: Record<string, unknown>, p: string): AmbushParams {
  if (e.ambush === undefined) return { ...DEFAULT_AMBUSH };
  const ap = `${p}.ambush`;
  const a = r.obj(e.ambush, ap);
  const d = DEFAULT_AMBUSH;
  return {
    chance: r.numOr(a, 'chance', ap, d.chance, 0, 1),
    preAimReactionSec: r.numOr(a, 'preAimReactionSec', ap, d.preAimReactionSec, 0.02, 2),
    firstBurstSpreadMul: r.numOr(a, 'firstBurstSpreadMul', ap, d.firstBurstSpreadMul, 0.05, 2),
    maxDist: r.numOr(a, 'maxDist', ap, d.maxDist, 2, 60),
    holdSec: r.numOr(a, 'holdSec', ap, d.holdSec, 2, 300),
    firstBurstShots: Math.round(r.numOr(a, 'firstBurstShots', ap, d.firstBurstShots, 1, 10)),
    coneDeg: r.numOr(a, 'coneDeg', ap, d.coneDeg, 10, 180),
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
      ambush: type === 'suspect' ? readAmbush(r, e, p) : undefined,
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

export const DEFAULT_WOUNDS: WoundsConfig = {
  headMultiplier: 3.6,
  headBand: 0.28,
  lv1Below: 0.5,
  lv2Below: 0.25,
  speedMul: [0.75, 0.6],
  spreadAddDeg: [1.2, 2.6],
  swayDeg: [0.12, 0.3],
};

export const DEFAULT_OPTIWAND: OptiwandConfig = {
  deploySec: 0.4,
  reach: 0.6,
  wallClearance: 0.08,
  doorRange: 1.5,
  doorCamHeight: [0.05, 0.15],
  doorCamPastPlane: 0.05,
  yawLimitDeg: 80,
  pitchLimitDeg: [-5, 45],
  fovDeg: 78,
  viewRange: 14,
  spotSec: 0.3,
  scoutDwellSec: 1.2,
  noticeRange: 3,
  noticePerSec: 0.12,
  noticeUnderDoorMul: 0.4,
  viewWidthRatio: 0.35,
  renderSize: [320, 240],
};

function readWounds(r: Reader, o: Record<string, unknown>): WoundsConfig {
  if (o.wounds === undefined) return { ...DEFAULT_WOUNDS };
  const w = r.obj(o.wounds, 'wounds');
  const d = DEFAULT_WOUNDS;
  const lv1Below = r.numOr(w, 'lv1Below', 'wounds', d.lv1Below, 0, 1);
  const lv2Below = r.numOr(w, 'lv2Below', 'wounds', d.lv2Below, 0, 1);
  if (lv2Below > lv1Below) r.fail('wounds.lv2Below', 'lv1Below 以下である必要があります');
  return {
    headMultiplier: r.numOr(w, 'headMultiplier', 'wounds', d.headMultiplier, 1, 20),
    headBand: r.numOr(w, 'headBand', 'wounds', d.headBand, 0.05, 1),
    lv1Below,
    lv2Below,
    speedMul: r.tupleOr(w, 'speedMul', 'wounds', d.speedMul, 0.1, 1),
    spreadAddDeg: r.tupleOr(w, 'spreadAddDeg', 'wounds', d.spreadAddDeg, 0, 30),
    swayDeg: r.tupleOr(w, 'swayDeg', 'wounds', d.swayDeg, 0, 10),
  };
}

export const DEFAULT_ARMOR: ArmorConfig = {
  absorb: 0.6,
  minAbsorb: 0.35,
  swatIssue: 50,
  suspectVest: 50,
};

function readArmor(r: Reader, o: Record<string, unknown>): ArmorConfig {
  if (o.armor === undefined) return { ...DEFAULT_ARMOR };
  const a = r.obj(o.armor, 'armor');
  const d = DEFAULT_ARMOR;
  const absorb = r.numOr(a, 'absorb', 'armor', d.absorb, 0, 1);
  const minAbsorb = r.numOr(a, 'minAbsorb', 'armor', d.minAbsorb, 0, 1);
  if (minAbsorb > absorb) r.fail('armor.minAbsorb', 'absorb 以下である必要があります');
  return {
    absorb,
    minAbsorb,
    swatIssue: r.numOr(a, 'swatIssue', 'armor', d.swatIssue, 0, 500),
    suspectVest: r.numOr(a, 'suspectVest', 'armor', d.suspectVest, 0, 500),
  };
}

function readOptiwand(r: Reader, o: Record<string, unknown>): OptiwandConfig {
  if (o.optiwand === undefined) return { ...DEFAULT_OPTIWAND };
  const w = r.obj(o.optiwand, 'optiwand');
  const d = DEFAULT_OPTIWAND;
  const doorCamHeight = r.tupleOr(w, 'doorCamHeight', 'optiwand', d.doorCamHeight, 0.01, 1);
  if (doorCamHeight[0] > doorCamHeight[1]) r.fail('optiwand.doorCamHeight', 'min <= max が必要です');
  const pitchLimitDeg = r.tupleOr(w, 'pitchLimitDeg', 'optiwand', d.pitchLimitDeg, -89, 89);
  if (pitchLimitDeg[0] > pitchLimitDeg[1]) r.fail('optiwand.pitchLimitDeg', 'min <= max が必要です');
  return {
    deploySec: r.numOr(w, 'deploySec', 'optiwand', d.deploySec, 0, 5),
    reach: r.numOr(w, 'reach', 'optiwand', d.reach, 0.1, 3),
    wallClearance: r.numOr(w, 'wallClearance', 'optiwand', d.wallClearance, 0, 0.5),
    doorRange: r.numOr(w, 'doorRange', 'optiwand', d.doorRange, 0.3, 5),
    doorCamHeight,
    doorCamPastPlane: r.numOr(w, 'doorCamPastPlane', 'optiwand', d.doorCamPastPlane, 0, 0.5),
    yawLimitDeg: r.numOr(w, 'yawLimitDeg', 'optiwand', d.yawLimitDeg, 5, 170),
    pitchLimitDeg,
    fovDeg: r.numOr(w, 'fovDeg', 'optiwand', d.fovDeg, 20, 140),
    viewRange: r.numOr(w, 'viewRange', 'optiwand', d.viewRange, 2, 60),
    spotSec: r.numOr(w, 'spotSec', 'optiwand', d.spotSec, 0, 5),
    scoutDwellSec: r.numOr(w, 'scoutDwellSec', 'optiwand', d.scoutDwellSec, 0, 20),
    noticeRange: r.numOr(w, 'noticeRange', 'optiwand', d.noticeRange, 0, 20),
    noticePerSec: r.numOr(w, 'noticePerSec', 'optiwand', d.noticePerSec, 0, 5),
    noticeUnderDoorMul: r.numOr(w, 'noticeUnderDoorMul', 'optiwand', d.noticeUnderDoorMul, 0, 1),
    viewWidthRatio: r.numOr(w, 'viewWidthRatio', 'optiwand', d.viewWidthRatio, 0.1, 0.8),
    renderSize: r.tupleOr(w, 'renderSize', 'optiwand', d.renderSize, 64, 1024),
  };
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
    wounds: readWounds(r, o),
    armor: readArmor(r, o),
    optiwand: readOptiwand(r, o),
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
  'allyDown',
  'playerInjury',
  'civilianGassed',
];

/** roe.json に新項目が無い旧データでも読めるようにする既定値（careless play ペナルティ） */
const OPTIONAL_SCORE_DEFAULTS: Partial<Record<ScoreKind, { points: number; label: string }>> = {
  allyDown: { points: -40, label: '隊員が負傷・戦闘不能' },
  playerInjury: { points: -15, label: '被弾（負傷）' },
  civilianGassed: { points: -10, label: '民間人にCSガスを浴びせた（不適切なガス使用）' },
};

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
    const def = OPTIONAL_SCORE_DEFAULTS[k];
    points[k] = def && pts[k] === undefined ? def.points : r.num(pts, k, 'points');
    labels[k] = def && lbl[k] === undefined ? def.label : r.str(lbl, k, 'labels');
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

export const SQUAD_ORDERS: readonly SquadOrder[] = [
  'follow',
  'hold',
  'move',
  'overwatch',
  'stack',
  'clear',
  'flashClear',
  'breachClear',
  'c2Clear',
  'gasClear',
  'pieDoor',
  'restrain',
  'mirror',
  'check',
  'disarm',
] as const;

/** squad.json に新しい指示のラベルが無い旧データでも読めるようにする既定値 */
const OPTIONAL_ORDER_LABELS: Partial<Record<SquadOrder, string>> = {
  check: 'ドアチェック',
  disarm: 'トラップ解除',
};

export const DEFAULT_MIRROR: MirrorConfig = {
  durationSec: 4,
  missChance: 0.35,
  centerBandM: 1.1,
  halfFovDeg: 55,
  range: 12,
};

export const DEFAULT_ALLY_WOUNDS: AllyWoundsConfig = { headMultiplier: 2.2, woundBelow: 0.5, speedMul: 0.75 };

function readAllyWounds(r: Reader, o: Record<string, unknown>): AllyWoundsConfig {
  if (o.wounds === undefined) return { ...DEFAULT_ALLY_WOUNDS };
  const w = r.obj(o.wounds, 'wounds');
  const d = DEFAULT_ALLY_WOUNDS;
  return {
    headMultiplier: r.numOr(w, 'headMultiplier', 'wounds', d.headMultiplier, 1, 20),
    woundBelow: r.numOr(w, 'woundBelow', 'wounds', d.woundBelow, 0, 1),
    speedMul: r.numOr(w, 'speedMul', 'wounds', d.speedMul, 0.1, 1),
  };
}

export const DEFAULT_INVENTORY: SquadInventoryConfig = { flashbang: 4, gas: 3 };
export const DEFAULT_DOOR_CHECK: DoorCheckConfig = { durationSec: 1.7, detectChance: 0.9, spotChance: 0.35 };
export const DEFAULT_DOOR_TRAP: DoorTrapConfig = {
  maxCount: 2,
  baseChance: 0.55,
  alertBonusAt: 40,
  alertBonus: 1,
  minStartDist: 7,
  disarmSec: 5,
  failChance: 0.12,
  blastRadius: 4.2,
  blastDamage: 85,
  triggerDist: 3,
};

function readInventory(r: Reader, o: Record<string, unknown>): SquadInventoryConfig {
  if (o.inventory === undefined) return { ...DEFAULT_INVENTORY };
  const v = r.obj(o.inventory, 'inventory');
  const d = DEFAULT_INVENTORY;
  return {
    flashbang: Math.round(r.numOr(v, 'flashbang', 'inventory', d.flashbang, 0, 20)),
    gas: Math.round(r.numOr(v, 'gas', 'inventory', d.gas, 0, 20)),
  };
}

function readDoorCheck(r: Reader, o: Record<string, unknown>): DoorCheckConfig {
  if (o.doorCheck === undefined) return { ...DEFAULT_DOOR_CHECK };
  const v = r.obj(o.doorCheck, 'doorCheck');
  const d = DEFAULT_DOOR_CHECK;
  return {
    durationSec: r.numOr(v, 'durationSec', 'doorCheck', d.durationSec, 0.3, 15),
    detectChance: r.numOr(v, 'detectChance', 'doorCheck', d.detectChance, 0, 1),
    spotChance: r.numOr(v, 'spotChance', 'doorCheck', d.spotChance, 0, 1),
  };
}

function readDoorTrap(r: Reader, o: Record<string, unknown>): DoorTrapConfig {
  if (o.doorTrap === undefined) return { ...DEFAULT_DOOR_TRAP };
  const v = r.obj(o.doorTrap, 'doorTrap');
  const d = DEFAULT_DOOR_TRAP;
  const p = 'doorTrap';
  return {
    maxCount: Math.round(r.numOr(v, 'maxCount', p, d.maxCount, 0, 10)),
    baseChance: r.numOr(v, 'baseChance', p, d.baseChance, 0, 1),
    alertBonusAt: r.numOr(v, 'alertBonusAt', p, d.alertBonusAt, 0, 100),
    alertBonus: Math.round(r.numOr(v, 'alertBonus', p, d.alertBonus, 0, 10)),
    minStartDist: r.numOr(v, 'minStartDist', p, d.minStartDist, 0, 100),
    disarmSec: r.numOr(v, 'disarmSec', p, d.disarmSec, 0.5, 60),
    failChance: r.numOr(v, 'failChance', p, d.failChance, 0, 1),
    blastRadius: r.numOr(v, 'blastRadius', p, d.blastRadius, 0.5, 20),
    blastDamage: r.numOr(v, 'blastDamage', p, d.blastDamage, 0, 500),
    triggerDist: r.numOr(v, 'triggerDist', p, d.triggerDist, 0.5, 20),
  };
}

function readMirror(r: Reader, o: Record<string, unknown>): MirrorConfig {
  if (o.mirror === undefined) return { ...DEFAULT_MIRROR };
  const m = r.obj(o.mirror, 'mirror');
  const d = DEFAULT_MIRROR;
  return {
    durationSec: r.numOr(m, 'durationSec', 'mirror', d.durationSec, 0.5, 30),
    missChance: r.numOr(m, 'missChance', 'mirror', d.missChance, 0, 1),
    centerBandM: r.numOr(m, 'centerBandM', 'mirror', d.centerBandM, 0.1, 10),
    halfFovDeg: r.numOr(m, 'halfFovDeg', 'mirror', d.halfFovDeg, 5, 90),
    range: r.numOr(m, 'range', 'mirror', d.range, 2, 40),
  };
}

const SQUAD_ELEMENTS: readonly SquadElement[] = ['gold', 'alpha', 'bravo'] as const;

export function validateSquad(raw: unknown, source = 'squad'): SquadConfig {
  const r = new Reader(source);
  const o = r.obj(raw, '');
  const labelsRaw = r.obj(o.orderLabels, 'orderLabels');
  const orderLabels = {} as SquadConfig['orderLabels'];
  for (const key of SQUAD_ORDERS) {
    const dflt = OPTIONAL_ORDER_LABELS[key];
    orderLabels[key] = dflt !== undefined && labelsRaw[key] === undefined ? dflt : r.str(labelsRaw, key, 'orderLabels');
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
    mirror: readMirror(r, o),
    wounds: readAllyWounds(r, o),
    inventory: readInventory(r, o),
    gasWaitSec: r.numOr(o, 'gasWaitSec', '', 4.5, 0.5, 30),
    doorCheck: readDoorCheck(r, o),
    doorTrap: readDoorTrap(r, o),
    orderLabels,
    elementLabels,
  };
}

export const DEFAULT_SUSPECT_ALERT: SuspectAlertConfig = {
  gains: { flashbang: 20, gunshotBurst: 5, breach: 10, c2: 5, gas: 3, suspectDown: 10, doorOpen: 1, trapBlast: 12 },
  gunshotBurstGapSec: 1.0,
  doorOpenGapSec: 2.0,
  decayPerSec: 1,
  decayDelaySec: 10,
  hearNearM: 12,
  hearFarM: 40,
  farFactor: 0.35,
  otherFloorFactor: 0.5,
  tiers: { patrol: 30, ambush: 50, shield: 70, execute: 90 },
  effects: {
    patrolIntervalMul: 0.5,
    patrolChanceAdd: 0.25,
    investigateAdd: 0.25,
    ambushChanceMul: 1.7,
    hideChance: 0.6,
    shieldRange: 4.5,
    hostageRoomChance: 0.5,
    complianceMul: { patrol: 0.9, ambush: 0.75, shield: 0.6, execute: 0.45 },
  },
  baseline: { start: 0, tensionWeight: 0.45, ultimatum: 10, trustWeight: 0.15, brokenBonus: 20, max: 60 },
  execution: { sustainSec: 8, tensionMin: 60, repeatedFlashes: 3, countdownSec: 9, cooldownSec: 60, cancelBelow: 80, warnComplyChance: 0.4 },
};

/** ai_profiles.json の suspectAlert セクション（無ければ既定値）。 */
export function validateSuspectAlert(raw: unknown, source = 'ai_profiles'): SuspectAlertConfig {
  const d = DEFAULT_SUSPECT_ALERT;
  const root = new Reader(source).obj(raw, '');
  if (root.suspectAlert === undefined) return structuredClone(d);
  const r = new Reader(source);
  const o = r.obj(root.suspectAlert, 'suspectAlert');
  const sub = (key: string): Record<string, unknown> =>
    o[key] === undefined ? {} : r.obj(o[key], `suspectAlert.${key}`);
  const g = sub('gains');
  const tr = sub('tiers');
  const e = sub('effects');
  const cm = e.complianceMul === undefined ? {} : r.obj(e.complianceMul, 'suspectAlert.effects.complianceMul');
  const b = sub('baseline');
  const x = sub('execution');
  const gp = 'suspectAlert.gains';
  const tp = 'suspectAlert.tiers';
  const ep = 'suspectAlert.effects';
  const cp = 'suspectAlert.effects.complianceMul';
  const bp = 'suspectAlert.baseline';
  const xp = 'suspectAlert.execution';
  const cfg: SuspectAlertConfig = {
    gains: {
      flashbang: r.numOr(g, 'flashbang', gp, d.gains.flashbang, 0, 100),
      gunshotBurst: r.numOr(g, 'gunshotBurst', gp, d.gains.gunshotBurst, 0, 100),
      breach: r.numOr(g, 'breach', gp, d.gains.breach, 0, 100),
      c2: r.numOr(g, 'c2', gp, d.gains.c2, 0, 100),
      gas: r.numOr(g, 'gas', gp, d.gains.gas, 0, 100),
      suspectDown: r.numOr(g, 'suspectDown', gp, d.gains.suspectDown, 0, 100),
      doorOpen: r.numOr(g, 'doorOpen', gp, d.gains.doorOpen, 0, 100),
      trapBlast: r.numOr(g, 'trapBlast', gp, d.gains.trapBlast, 0, 100),
    },
    gunshotBurstGapSec: r.numOr(o, 'gunshotBurstGapSec', 'suspectAlert', d.gunshotBurstGapSec, 0.1, 30),
    doorOpenGapSec: r.numOr(o, 'doorOpenGapSec', 'suspectAlert', d.doorOpenGapSec, 0.1, 60),
    decayPerSec: r.numOr(o, 'decayPerSec', 'suspectAlert', d.decayPerSec, 0, 50),
    decayDelaySec: r.numOr(o, 'decayDelaySec', 'suspectAlert', d.decayDelaySec, 0, 300),
    hearNearM: r.numOr(o, 'hearNearM', 'suspectAlert', d.hearNearM, 0, 200),
    hearFarM: r.numOr(o, 'hearFarM', 'suspectAlert', d.hearFarM, 1, 400),
    farFactor: r.numOr(o, 'farFactor', 'suspectAlert', d.farFactor, 0, 1),
    otherFloorFactor: r.numOr(o, 'otherFloorFactor', 'suspectAlert', d.otherFloorFactor, 0, 1),
    tiers: {
      patrol: r.numOr(tr, 'patrol', tp, d.tiers.patrol, 0, 100),
      ambush: r.numOr(tr, 'ambush', tp, d.tiers.ambush, 0, 100),
      shield: r.numOr(tr, 'shield', tp, d.tiers.shield, 0, 100),
      execute: r.numOr(tr, 'execute', tp, d.tiers.execute, 0, 100),
    },
    effects: {
      patrolIntervalMul: r.numOr(e, 'patrolIntervalMul', ep, d.effects.patrolIntervalMul, 0.1, 2),
      patrolChanceAdd: r.numOr(e, 'patrolChanceAdd', ep, d.effects.patrolChanceAdd, 0, 1),
      investigateAdd: r.numOr(e, 'investigateAdd', ep, d.effects.investigateAdd, 0, 1),
      ambushChanceMul: r.numOr(e, 'ambushChanceMul', ep, d.effects.ambushChanceMul, 0, 5),
      hideChance: r.numOr(e, 'hideChance', ep, d.effects.hideChance, 0, 1),
      shieldRange: r.numOr(e, 'shieldRange', ep, d.effects.shieldRange, 0.5, 20),
      hostageRoomChance: r.numOr(e, 'hostageRoomChance', ep, d.effects.hostageRoomChance, 0, 1),
      complianceMul: {
        patrol: r.numOr(cm, 'patrol', cp, d.effects.complianceMul.patrol, 0.05, 2),
        ambush: r.numOr(cm, 'ambush', cp, d.effects.complianceMul.ambush, 0.05, 2),
        shield: r.numOr(cm, 'shield', cp, d.effects.complianceMul.shield, 0.05, 2),
        execute: r.numOr(cm, 'execute', cp, d.effects.complianceMul.execute, 0.05, 2),
      },
    },
    baseline: {
      start: r.numOr(b, 'start', bp, d.baseline.start, 0, 100),
      tensionWeight: r.numOr(b, 'tensionWeight', bp, d.baseline.tensionWeight, 0, 2),
      ultimatum: r.numOr(b, 'ultimatum', bp, d.baseline.ultimatum, 0, 100),
      trustWeight: r.numOr(b, 'trustWeight', bp, d.baseline.trustWeight, 0, 2),
      brokenBonus: r.numOr(b, 'brokenBonus', bp, d.baseline.brokenBonus, 0, 100),
      max: r.numOr(b, 'max', bp, d.baseline.max, 0, 100),
    },
    execution: {
      sustainSec: r.numOr(x, 'sustainSec', xp, d.execution.sustainSec, 0, 120),
      tensionMin: r.numOr(x, 'tensionMin', xp, d.execution.tensionMin, 0, 100),
      repeatedFlashes: Math.round(r.numOr(x, 'repeatedFlashes', xp, d.execution.repeatedFlashes, 1, 50)),
      countdownSec: r.numOr(x, 'countdownSec', xp, d.execution.countdownSec, 1, 120),
      cooldownSec: r.numOr(x, 'cooldownSec', xp, d.execution.cooldownSec, 0, 600),
      cancelBelow: r.numOr(x, 'cancelBelow', xp, d.execution.cancelBelow, 0, 100),
      warnComplyChance: r.numOr(x, 'warnComplyChance', xp, d.execution.warnComplyChance, 0, 1),
    },
  };
  const ti = cfg.tiers;
  if (!(ti.patrol <= ti.ambush && ti.ambush <= ti.shield && ti.shield <= ti.execute)) {
    r.fail('suspectAlert.tiers', 'patrol <= ambush <= shield <= execute の順で指定してください');
  }
  return cfg;
}

const jsonCache = new Map<string, Promise<unknown>>();
const staticConfigCache = new Map<string, Promise<unknown>>();
const templateCache = new Map<string, Promise<AnyGeneratorTemplate>>();

function fetchJson(url: string): Promise<unknown> {
  const cached = jsonCache.get(url);
  if (cached) return cached;
  const promise = (async (): Promise<unknown> => {
    let res: Response;
    try {
      // セッション初回は no-cache で再検証し、同一セッション内のリトライ・リロールではキャッシュを共有する
      res = await fetch(url, { cache: 'no-cache' });
    } catch (err) {
      throw new DataError(url, '', `取得に失敗しました: ${String(err)}`);
    }
    if (!res.ok) throw new DataError(url, '', `HTTP ${res.status} ${res.statusText}`);
    try {
      return await res.json();
    } catch (err) {
      throw new DataError(url, '', `JSON として解析できません: ${String(err)}`);
    }
  })().catch((err: unknown) => {
    jsonCache.delete(url);
    throw err;
  });
  jsonCache.set(url, promise);
  return promise;
}

function loadCachedStatic<T>(path: string, validate: (raw: unknown, source: string) => T): Promise<T> {
  const url = dataUrl(path);
  // 同じ JSON を別の検証関数で読む（ai_profiles.json → プロファイル / 警戒度設定）ため、キーに検証関数名を含める
  const key = `${url}#${validate.name}`;
  const hit = staticConfigCache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const promise = fetchJson(url)
    .then((raw) => validate(raw, url))
    .catch((err: unknown) => {
      staticConfigCache.delete(key);
      throw err;
    });
  staticConfigCache.set(key, promise);
  return promise;
}

function dataUrl(path: string): string {
  return `${import.meta.env.BASE_URL}data/${path}`;
}

export const DataLoader = {
  loadStages(): Promise<StageEntry[]> {
    return loadCachedStatic('stages.json', validateStages);
  },
  loadWeapons(): Promise<WeaponDef[]> {
    return loadCachedStatic('weapons.json', validateWeapons);
  },
  loadAIProfiles(): Promise<AIProfile[]> {
    return loadCachedStatic('ai_profiles.json', validateAIProfiles);
  },
  loadSuspectAlert(): Promise<SuspectAlertConfig> {
    return loadCachedStatic('ai_profiles.json', validateSuspectAlert);
  },
  loadPlayerConfig(): Promise<PlayerConfig> {
    return loadCachedStatic('player.json', validatePlayerConfig);
  },
  loadDoorConfig(): Promise<DoorConfig> {
    return loadCachedStatic('doors.json', validateDoorConfig);
  },
  loadPerception(): Promise<PerceptionConfig> {
    return loadCachedStatic('perception.json', validatePerception);
  },
  loadRoe(): Promise<RoeConfig> {
    return loadCachedStatic('roe.json', validateRoe);
  },
  loadSquad(): Promise<SquadConfig> {
    return loadCachedStatic('squad.json', validateSquad);
  },
  loadGeneratorTemplate(generatorId: string): Promise<AnyGeneratorTemplate> {
    if (!STAGE_ID_RE.test(generatorId)) {
      return Promise.reject(new DataError('generator', 'generatorId', `不正な生成器ID "${generatorId}" です`));
    }
    const cached = templateCache.get(generatorId);
    if (cached) return cached;
    const url = dataUrl(`generators/${generatorId}.json`);
    const promise = fetchJson(url)
      .then((raw) => validateGeneratorTemplate(raw, url))
      .catch((err: unknown) => {
        templateCache.delete(generatorId);
        throw err;
      });
    templateCache.set(generatorId, promise);
    return promise;
  },
  /**
   * ステージのマップを取得。generator テンプレートと seed から間取りを生成し、validateMap を通す。
   */
  async loadStageMap(
    stage: StageEntry,
    seed: number | undefined,
    profiles: AIProfile[],
    doorConfig?: DoorConfig,
  ): Promise<MapData> {
    if (seed === undefined || !Number.isFinite(seed)) {
      throw new DataError('map', 'seed', `ランダム生成ステージ "${stage.id}" には有限数値のシードが必要です (現在 ${String(seed)})`);
    }
    // 同じ規模の中の建物候補（住宅・銀行・機内など）をシードで 1 つ選ぶ
    const picked = pickStageVariant(stage, seed);
    const tpl = await DataLoader.loadGeneratorTemplate(picked.generator);
    validateGeneratorReferences(tpl, profiles);
    if (tpl.type === 'modular') {
      // 扉リーフ高は doors.json の height を一元契約として生成器へ渡す（§2.2）。
      const doorLeafHeight = modularDoorLeafHeight(doorConfig);
      verifyModularFallback(tpl, doorLeafHeight);
      return validateMap(generateMap(tpl, seed, stage.id, doorLeafHeight, picked.motif), `generator:${tpl.id}#${seed}`);
    }
    if (tpl.type === 'aircraft') {
      const doorLeafHeight = modularDoorLeafHeight(doorConfig);
      return validateMap(generateMap(tpl, seed, stage.id, doorLeafHeight), `generator:${tpl.id}#${seed}`);
    }
    return validateMap(generateMap(tpl, seed, stage.id, undefined, picked.motif), `generator:${tpl.id}#${seed}`);
  },
  /** 共通JSONを並列ロードし検証、続いてステージのマップを読み込み/生成。不正なら DataError を throw。 */
  async loadAll(stage: StageEntry, seed?: number): Promise<GameData> {
    const [player, doors, weapons, aiProfiles, roe, perception, squad, suspectAlert] = await Promise.all([
      DataLoader.loadPlayerConfig(),
      DataLoader.loadDoorConfig(),
      DataLoader.loadWeapons(),
      DataLoader.loadAIProfiles(),
      DataLoader.loadRoe(),
      DataLoader.loadPerception(),
      DataLoader.loadSquad(),
      DataLoader.loadSuspectAlert(),
    ]);
    const map = await DataLoader.loadStageMap(stage, seed, aiProfiles, doors);
    validateCrossReferences(map, aiProfiles);
    return { player, doors, map, weapons, aiProfiles, roe, perception, squad, suspectAlert };
  },
};
