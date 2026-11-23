import type { AllyDef, EntityDef, MapData, PlayerSpawn, RoomDef } from '../core/types';

/**
 * 両モード共通の編成。屋内床面積（outdoor 以外の width×depth 合計。階層も足す）だけから決める。
 * 容疑者と SWAT の合計には、そのモードのプレイヤーを含む。NPC は合計から 1 を引いた数。
 * 人質にプレイヤーは含まない。モードごとに別の上乗せはしない。
 *
 * 容疑者 = clamp(round(面積 / 160) + 1, 3, 7)
 *   160㎡あたり 1 人。+1 はプレイヤー枠。最低 3、上限 7（容疑者モードの NPC は最大 6）。
 * SWAT   = clamp(3 + round(面積 / 500), 4, 6)
 *   小さいマップは 4。広いほど増やし、上限 6。
 * 人質   = clamp(round(面積 / 150), 3, 8)
 *   スモールでも最低 3（以前のコンパクト住宅は 1〜2 人だった）。
 */
export const ROSTER_SUSPECT_SQ_M = 160;
export const ROSTER_SUSPECT_MIN = 3;
export const ROSTER_SUSPECT_MAX = 7;
export const ROSTER_SWAT_SQ_M = 500;
export const ROSTER_SWAT_BASE = 3;
export const ROSTER_SWAT_MIN = 4;
export const ROSTER_SWAT_MAX = 6;
export const ROSTER_HOSTAGE_SQ_M = 150;
export const ROSTER_HOSTAGE_MIN = 3;
export const ROSTER_HOSTAGE_MAX = 8;

export interface MissionRoster {
  /** プレイヤーを含む容疑者の合計 */
  suspects: number;
  /** プレイヤーを含む SWAT の合計 */
  swat: number;
  /** 人質。両モードで同じ */
  hostages: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** outdoor を除く部屋の床面積合計（㎡）。重なる階層も足す。 */
export function indoorFloorArea(rooms: readonly RoomDef[]): number {
  let area = 0;
  for (const r of rooms) if (!r.outdoor) area += r.width * r.depth;
  return area;
}

export function missionRoster(indoorSqMeters: number): MissionRoster {
  const area = Math.max(0, indoorSqMeters);
  return {
    suspects: clamp(Math.round(area / ROSTER_SUSPECT_SQ_M) + 1, ROSTER_SUSPECT_MIN, ROSTER_SUSPECT_MAX),
    swat: clamp(ROSTER_SWAT_BASE + Math.round(area / ROSTER_SWAT_SQ_M), ROSTER_SWAT_MIN, ROSTER_SWAT_MAX),
    hostages: clamp(Math.round(area / ROSTER_HOSTAGE_SQ_M), ROSTER_HOSTAGE_MIN, ROSTER_HOSTAGE_MAX),
  };
}

const ALLY_EXTRAS: readonly { id: string; name: string }[] = [
  { id: 'ally_reed', name: 'Reed' },
  { id: 'ally_diaz', name: 'Diaz' },
  { id: 'ally_park', name: 'Park' },
  { id: 'ally_nguyen', name: 'Nguyen' },
  { id: 'ally_okada', name: 'Okada' },
];

const ALLY_OFFSETS: readonly [number, number][] = [
  [-1.2, 0],
  [1.2, 0],
  [-2.4, 0.5],
  [2.4, 0.5],
  [0, 1.0],
  [-1.2, 1.0],
  [1.2, 1.0],
  [0, 1.7],
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function tooClose(a: { x: number; z: number; y?: number }, b: { x: number; z: number; y?: number }, dist: number): boolean {
  if (Math.abs((a.y ?? 0) - (b.y ?? 0)) > 1.2) return false;
  return Math.hypot(a.x - b.x, a.z - b.z) < dist;
}

/** 部屋の内側に立つ候補。既に人がいる点は除く。 */
function freeSpots(rooms: readonly RoomDef[], taken: readonly { x: number; z: number; y?: number }[]): { x: number; z: number; y: number }[] {
  const spots: { x: number; z: number; y: number }[] = [];
  for (const r of rooms) {
    if (r.outdoor) continue;
    const y = r.floorY ?? 0;
    const x0 = r.x - r.width / 2 + 0.7;
    const x1 = r.x + r.width / 2 - 0.7;
    const z0 = r.z - r.depth / 2 + 0.7;
    const z1 = r.z + r.depth / 2 - 0.7;
    const xs = x1 < x0 ? [r.x] : [];
    const zs = z1 < z0 ? [r.z] : [];
    if (xs.length === 0) for (let x = x0; x <= x1 + 1e-6; x += 1.15) xs.push(x);
    if (zs.length === 0) for (let z = z0; z <= z1 + 1e-6; z += 1.15) zs.push(z);
    for (const x of xs) {
      for (const z of zs) {
        const spot = { x: round2(x), z: round2(z), y };
        if (taken.some((p) => tooClose(p, spot, 1.05))) continue;
        spots.push(spot);
      }
    }
  }
  return spots;
}

function farthestSpot(
  spots: { x: number; z: number; y: number }[],
  from: readonly { x: number; z: number; y?: number }[],
): { x: number; z: number; y: number } | null {
  let best: { x: number; z: number; y: number } | null = null;
  let bestD = -1;
  for (const s of spots) {
    let minD = from.length === 0 ? Math.hypot(s.x, s.z) : Infinity;
    for (const p of from) {
      const d = Math.abs((p.y ?? 0) - s.y) > 1.2 ? Math.hypot(s.x - p.x, s.z - p.z) + 6 : Math.hypot(s.x - p.x, s.z - p.z);
      if (d < minD) minD = d;
    }
    if (minD > bestD) {
      bestD = minD;
      best = s;
    }
  }
  return best;
}

/** 広げて n 人残す。同距離は id 順。 */
function spreadPick<T extends { id: string; x: number; z: number; y?: number }>(items: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  if (items.length <= n) return [...items];
  const pool = [...items].sort((a, b) => a.id.localeCompare(b.id));
  let start = pool[0]!;
  for (const p of pool) {
    const dp = p.x * p.x + p.z * p.z;
    const ds = start.x * start.x + start.z * start.z;
    if (dp > ds || (dp === ds && p.id < start.id)) start = p;
  }
  const chosen: T[] = [start];
  const rest = pool.filter((p) => p.id !== start.id);
  while (chosen.length < n && rest.length > 0) {
    let bestI = 0;
    let bestD = -1;
    for (let i = 0; i < rest.length; i++) {
      const p = rest[i]!;
      let minD = Infinity;
      for (const c of chosen) minD = Math.min(minD, Math.hypot(p.x - c.x, p.z - c.z));
      if (minD > bestD + 1e-6 || (Math.abs(minD - bestD) <= 1e-6 && p.id < rest[bestI]!.id)) {
        bestD = minD;
        bestI = i;
      }
    }
    chosen.push(rest.splice(bestI, 1)[0]!);
  }
  return chosen;
}

function nextId(prefix: string, used: Set<string>): string {
  for (let i = 1; i < 200; i++) {
    const id = `${prefix}_${i}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}_x`;
}

function resizePeople(
  current: readonly EntityDef[],
  n: number,
  type: 'suspect' | 'civilian',
  rooms: readonly RoomDef[],
  others: readonly EntityDef[],
): EntityDef[] {
  const kept = spreadPick(current, n);
  if (kept.length >= n) return kept;
  const used = new Set<string>([...kept, ...others].map((e) => e.id));
  const taken: { x: number; z: number; y?: number }[] = [...kept, ...others];
  const fallbackProfile = type === 'suspect' ? 'nervous_robber' : 'frightened_civilian';
  const template = kept[0] ?? current[0];
  while (kept.length < n) {
    const spots = freeSpots(rooms, taken);
    const spot = farthestSpot(spots, kept.length > 0 ? kept : taken);
    const base = spot ?? {
      x: round2((template?.x ?? 0) + 0.8 * (kept.length + 1)),
      z: template?.z ?? 0,
      y: template?.y ?? 0,
    };
    const id = nextId(type, used);
    used.add(id);
    const e: EntityDef = {
      id,
      type,
      profile: template?.profile ?? fallbackProfile,
      x: base.x,
      z: base.z,
      yaw: template?.yaw ?? 0,
    };
    if (Math.abs(base.y) > 1e-4) e.y = base.y;
    kept.push(e);
    taken.push(e);
  }
  return kept;
}

function resizeAllies(allies: readonly AllyDef[], n: number, spawn: PlayerSpawn): AllyDef[] {
  if (allies.length === n) return [...allies];
  if (allies.length > n) return allies.slice(0, n);
  const out = [...allies];
  const used = new Set(out.map((a) => a.id));
  const anchor: { x: number; z: number; y?: number; yaw?: number } = out[0] ?? { x: spawn.x, z: spawn.z, y: spawn.y, yaw: spawn.yaw };
  let extra = 0;
  for (const off of ALLY_OFFSETS) {
    if (out.length >= n) break;
    const spot = { x: round2(anchor.x + off[0]), z: round2(anchor.z + off[1]), y: anchor.y };
    if (out.some((a) => tooClose(a, spot, 0.7))) continue;
    const name = ALLY_EXTRAS[extra] ?? { id: `ally_extra_${extra}`, name: `Officer ${extra + 1}` };
    extra++;
    let id = name.id;
    while (used.has(id)) id = `${id}_b`;
    used.add(id);
    const ally: AllyDef = { id, name: name.name, x: spot.x, z: spot.z, yaw: anchor.yaw ?? spawn.yaw ?? 0 };
    if (anchor.y !== undefined) ally.y = anchor.y;
    out.push(ally);
  }
  while (out.length < n) {
    const ally: AllyDef = {
      id: nextId('ally', used),
      name: `Officer ${out.length + 1}`,
      x: round2(anchor.x + out.length * 0.4),
      z: round2(anchor.z + 0.4),
      yaw: spawn.yaw ?? 0,
    };
    used.add(ally.id);
    if (anchor.y !== undefined) ally.y = anchor.y;
    out.push(ally);
  }
  return out;
}

/**
 * マップ上の容疑者・人質・SWAT 隊員（プレイヤー枠を除く NPC）を missionRoster に合わせる。
 * 多い側は間引き、足りない側は屋内の空き、または入口付近に足す。両モードはこの結果を共有する。
 */
export function applyMissionRoster(map: MapData): MapData {
  const roster = missionRoster(indoorFloorArea(map.rooms));
  const suspects = map.entities.filter((e) => e.type === 'suspect');
  const civilians = map.entities.filter((e) => e.type === 'civilian');
  const nextSuspects = resizePeople(suspects, roster.suspects, 'suspect', map.rooms, civilians);
  const nextCivilians = resizePeople(civilians, roster.hostages, 'civilian', map.rooms, nextSuspects);
  const allies = resizeAllies(map.allies, Math.max(0, roster.swat - 1), map.playerSpawn);
  return {
    ...map,
    entities: [...nextSuspects, ...nextCivilians],
    allies,
    briefing: map.briefing
      ? {
          ...map.briefing,
          estimatedSuspects: { min: roster.suspects, max: roster.suspects },
          estimatedHostages: { min: roster.hostages, max: roster.hostages },
        }
      : map.briefing,
  };
}
