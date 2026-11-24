import type { BoxDef, DoorDef, GeneratedMapRaw, MotifId, RoomDef } from '../core/types';
import { normalizeSeed, Rng } from './generator/Rng';
import type { Rect } from './generator/Layout';
import { inset, rectsOverlap, round3, subtractRects } from './generator/Layout';
import { motifById, roleOf, type RoomRole } from './Motif';

/**
 * 生成済みの壁・扉・スポーンは動かさず、モチーフの小道具と
 * トイレ・メインホール・吹き抜け（二階床の開口と手すり）を足す。
 * 乱数はマップシードから独立したストリームなので、間取りの再現性は保つ。
 */

interface Spec {
  prop: string;
  width: number;
  depth: number;
  height: number;
  /** wall = 壁際、center = 部屋の中央寄り */
  place: 'wall' | 'center';
}

const HALL_NAME: Record<MotifId, string> = {
  hospital: 'メインホール',
  clubhouse: 'メインラウンジ',
  bank: '窓口ホール',
  office: 'ロビー',
  warehouse: '荷捌きホール',
  house: '座敷',
};

const TOILET_NAME: Record<MotifId, string> = {
  hospital: 'トイレ',
  clubhouse: '化粧室',
  bank: '化粧室',
  office: 'トイレ',
  warehouse: 'トイレ',
  house: 'トイレ',
};

const HALL_FLOOR: Record<MotifId, string> = {
  hospital: 'linoleum',
  clubhouse: 'carpet',
  bank: 'marble',
  office: 'carpet',
  warehouse: 'concrete',
  house: 'tatami',
};

const ROOM_PROPS: Record<MotifId, Partial<Record<RoomRole, Spec[]>>> = {
  hospital: {
    private: [
      { prop: 'hbed', width: 2.05, depth: 1.35, height: 0.85, place: 'wall' },
      { prop: 'curtain', width: 1.5, depth: 0.12, height: 2.05, place: 'wall' },
    ],
    work: [{ prop: 'medcab', width: 0.95, depth: 0.42, height: 1.75, place: 'wall' }],
    social: [
      { prop: 'stretcher', width: 1.9, depth: 0.72, height: 0.85, place: 'center' },
      { prop: 'ivstand', width: 0.42, depth: 0.42, height: 1.65, place: 'wall' },
      { prop: 'bench', width: 1.4, depth: 0.5, height: 0.85, place: 'wall' },
    ],
    service: [{ prop: 'shelf', width: 1.5, depth: 0.45, height: 1.8, place: 'wall' }],
  },
  clubhouse: {
    social: [
      { prop: 'piano', width: 1.45, depth: 0.7, height: 1.28, place: 'wall' },
      { prop: 'bar', width: 2.3, depth: 0.7, height: 1.05, place: 'wall' },
      { prop: 'sofa', width: 2.1, depth: 0.9, height: 0.85, place: 'wall' },
      { prop: 'table', width: 1.15, depth: 0.65, height: 0.48, place: 'center' },
    ],
    private: [{ prop: 'sofa', width: 1.8, depth: 0.85, height: 0.82, place: 'wall' }],
    secure: [{ prop: 'shelf', width: 1.3, depth: 0.42, height: 1.7, place: 'wall' }],
  },
  bank: {
    social: [
      { prop: 'teller', width: 2.6, depth: 0.75, height: 1.15, place: 'wall' },
      { prop: 'bench', width: 1.5, depth: 0.5, height: 0.82, place: 'wall' },
    ],
    secure: [{ prop: 'vault', width: 1.35, depth: 0.38, height: 2.05, place: 'wall' }],
    work: [
      { prop: 'desk', width: 1.45, depth: 0.7, height: 0.75, place: 'wall' },
      { prop: 'chair', width: 0.5, depth: 0.5, height: 0.9, place: 'center' },
    ],
  },
  office: {
    work: [
      { prop: 'desk', width: 1.5, depth: 0.72, height: 0.75, place: 'wall' },
      { prop: 'chair', width: 0.5, depth: 0.5, height: 0.9, place: 'center' },
      { prop: 'partition', width: 1.7, depth: 0.08, height: 1.45, place: 'center' },
    ],
    social: [
      { prop: 'table', width: 1.6, depth: 0.8, height: 0.74, place: 'center' },
      { prop: 'chair', width: 0.5, depth: 0.5, height: 0.9, place: 'wall' },
    ],
    private: [{ prop: 'desk', width: 1.4, depth: 0.7, height: 0.75, place: 'wall' }],
  },
  warehouse: {
    service: [
      { prop: 'shelf', width: 1.8, depth: 0.5, height: 1.9, place: 'wall' },
      { prop: 'pallet', width: 1.2, depth: 0.85, height: 0.16, place: 'center' },
      { prop: 'container', width: 1.35, depth: 0.95, height: 1.25, place: 'wall' },
    ],
    social: [
      { prop: 'container', width: 1.6, depth: 1.05, height: 1.35, place: 'wall' },
      { prop: 'pallet', width: 1.2, depth: 0.85, height: 0.16, place: 'center' },
    ],
    work: [{ prop: 'shelf', width: 1.6, depth: 0.48, height: 1.85, place: 'wall' }],
  },
  house: {
    social: [{ prop: 'low_table', width: 1.2, depth: 0.72, height: 0.35, place: 'center' }],
    outdoor: [{ prop: 'engawa', width: 2.2, depth: 0.72, height: 0.32, place: 'wall' }],
  },
};

function rectOf(r: RoomDef): Rect {
  return {
    x0: r.x - r.width / 2,
    z0: r.z - r.depth / 2,
    x1: r.x + r.width / 2,
    z1: r.z + r.depth / 2,
  };
}

function xzOf(b: BoxDef): Rect {
  const yaw = ((b.yaw ?? 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const hx = (b.width * c + b.depth * s) / 2;
  const hz = (b.width * s + b.depth * c) / 2;
  return { x0: b.x - hx, z0: b.z - hz, x1: b.x + hx, z1: b.z + hz };
}

function sameFloor(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.6;
}

function blocked(covers: readonly BoxDef[], box: BoxDef, map: GeneratedMapRaw, gap: number): boolean {
  const r = xzOf(box);
  const y = box.y ?? 0;
  const padded = { x0: r.x0 - gap, z0: r.z0 - gap, x1: r.x1 + gap, z1: r.z1 + gap };
  for (const c of covers) {
    if (!sameFloor(c.y ?? 0, y)) continue;
    if (rectsOverlap(padded, xzOf(c))) return true;
  }
  const doorR = Math.max(box.width, box.depth) < 0.9 ? 0.8 : 1.1;
  for (const d of map.doors) {
    if (!sameFloor(d.y ?? 0, y)) continue;
    if (Math.hypot(d.x - box.x, d.z - box.z) < doorR) return true;
  }
  const spawn = map.playerSpawn;
  if (sameFloor(spawn.y, y) && Math.hypot(spawn.x - box.x, spawn.z - box.z) < 1.7) return true;
  for (const a of map.allies) {
    if (sameFloor(a.y ?? 0, y) && Math.hypot(a.x - box.x, a.z - box.z) < 0.9) return true;
  }
  for (const e of map.entities) {
    if (sameFloor(e.y ?? 0, y) && Math.hypot(e.x - box.x, e.z - box.z) < 0.7) return true;
  }
  return false;
}

function inside(room: Rect, box: BoxDef, margin: number): boolean {
  const r = xzOf(box);
  return r.x0 >= room.x0 + margin && r.x1 <= room.x1 - margin && r.z0 >= room.z0 + margin && r.z1 <= room.z1 - margin;
}

function pushProp(covers: BoxDef[], map: GeneratedMapRaw, room: RoomDef, spec: Spec, x: number, z: number, yaw = 0): boolean {
  const box: BoxDef = {
    x: round3(x),
    z: round3(z),
    y: round3(room.floorY ?? 0),
    width: spec.width,
    depth: spec.depth,
    height: spec.height,
    yaw,
    prop: spec.prop,
  };
  if ((room.floorY ?? 0) === 0) delete box.y;
  if (!inside(rectOf(room), box, 0.04)) return false;
  if (blocked(covers, box, map, 0.18)) return false;
  covers.push(box);
  return true;
}

/**
 * 壁際へ置く。正面（ローカル +Z）が部屋の内側を向く。
 * 幅は壁に沿う長さ、奥行は壁から部屋へ出る厚み。
 */
function placeAgainstWall(covers: BoxDef[], map: GeneratedMapRaw, room: RoomDef, spec: Spec, rng: Rng): boolean {
  const rect = rectOf(room);
  const gap = 0.1;
  const options: { yaw: number; x: number; z: number; axis: 'x' | 'z' }[] = [
    { yaw: 0, x: 0, z: rect.z0 + spec.depth / 2 + gap, axis: 'x' },
    { yaw: 180, x: 0, z: rect.z1 - spec.depth / 2 - gap, axis: 'x' },
    { yaw: 90, x: rect.x0 + spec.depth / 2 + gap, z: 0, axis: 'z' },
    { yaw: 270, x: rect.x1 - spec.depth / 2 - gap, z: 0, axis: 'z' },
  ];
  for (let i = options.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = options[i]!;
    options[i] = options[j]!;
    options[j] = tmp;
  }
  for (const o of options) {
    const span = (o.axis === 'x' ? rect.x1 - rect.x0 : rect.z1 - rect.z0) - spec.width - 0.5;
    if (span < 0.05) continue;
    const along = (o.axis === 'x' ? rect.x0 : rect.z0) + spec.width / 2 + 0.25 + rng.next() * span;
    const x = o.axis === 'x' ? along : o.x;
    const z = o.axis === 'z' ? along : o.z;
    if (pushProp(covers, map, room, spec, x, z, o.yaw)) return true;
  }
  return false;
}

function placeCenter(covers: BoxDef[], map: GeneratedMapRaw, room: RoomDef, spec: Spec, rng: Rng): boolean {
  for (let i = 0; i < 6; i++) {
    const x = room.x + (rng.next() - 0.5) * Math.max(0.2, room.width - spec.width - 1.2);
    const z = room.z + (rng.next() - 0.5) * Math.max(0.2, room.depth - spec.depth - 1.2);
    if (pushProp(covers, map, room, spec, x, z, 0)) return true;
  }
  return placeAgainstWall(covers, map, room, spec, rng);
}

function countProp(covers: readonly BoxDef[], prop: string): number {
  return covers.reduce((n, c) => n + (c.prop === prop ? 1 : 0), 0);
}

function placeSpec(covers: BoxDef[], map: GeneratedMapRaw, room: RoomDef, spec: Spec, rng: Rng, limit: number): void {
  if (countProp(covers, spec.prop) >= limit) return;
  if (spec.place === 'center') placeCenter(covers, map, room, spec, rng);
  else placeAgainstWall(covers, map, room, spec, rng);
}

function isToiletId(id: string): boolean {
  return /(bath|toilet|restroom|washroom|wash_|ensuite)/.test(id);
}

function pickToilet(rooms: readonly RoomDef[], hall: RoomDef | undefined): RoomDef | undefined {
  const indoor = rooms.filter((r) => !r.outdoor && !r.id.includes('stair') && r !== hall);
  const named = indoor.find((r) => isToiletId(r.id));
  if (named) return named;
  const candidates = indoor.filter((r) => {
    const short = Math.min(r.width, r.depth);
    const long = Math.max(r.width, r.depth);
    return short >= 2.2 && long <= 8.5 && r.width * r.depth >= 6 && r.width * r.depth <= 40;
  });
  candidates.sort((a, b) => a.width * a.depth - b.width * b.depth);
  return candidates[0];
}

function doorSide(room: RoomDef, doors: readonly DoorDef[]): 'n' | 's' | 'e' | 'w' {
  const rect = rectOf(room);
  let best: 'n' | 's' | 'e' | 'w' = 's';
  let bestD = Infinity;
  for (const d of doors) {
    if (!sameFloor(d.y ?? 0, room.floorY ?? 0)) continue;
    const dist = [
      ['s', Math.abs(d.z - rect.z0)],
      ['n', Math.abs(d.z - rect.z1)],
      ['w', Math.abs(d.x - rect.x0)],
      ['e', Math.abs(d.x - rect.x1)],
    ] as const;
    for (const [side, dd] of dist) {
      if (dd < bestD && dd < 1.4) {
        bestD = dd;
        best = side;
      }
    }
  }
  return best;
}

function placeToiletFixtures(covers: BoxDef[], map: GeneratedMapRaw, room: RoomDef): void {
  const side = doorSide(room, map.doors);
  const rect = rectOf(room);
  const alongX = side === 'n' || side === 's';
  const far = side === 's' ? rect.z1 : side === 'n' ? rect.z0 : side === 'w' ? rect.x1 : rect.x0;
  const sign = side === 's' || side === 'w' ? -1 : 1;
  const yaw = alongX ? (side === 's' ? 180 : 0) : side === 'w' ? 90 : 270;
  const toilet: Spec = { prop: 'toilet', width: 0.48, depth: 0.7, height: 0.78, place: 'wall' };
  const sink: Spec = { prop: 'sink', width: 0.55, depth: 0.48, height: 0.85, place: 'wall' };
  const span = alongX ? room.width : room.depth;
  if (span >= 2.4 && Math.min(room.width, room.depth) >= 2.3) {
    const n = span >= 3.3 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const t = (i - (n - 1) / 2) * 0.95;
      const x = alongX ? room.x + t : far + sign * 0.42;
      const z = alongX ? far + sign * 0.42 : room.z + t;
      pushProp(covers, map, room, toilet, x, z, yaw);
      if (i < n - 1 || n === 1) {
        const stall: Spec = { prop: 'stall', width: 0.06, depth: 1.15, height: 1.85, place: 'wall' };
        const sx = alongX ? room.x + t + 0.48 : far + sign * 0.7;
        const sz = alongX ? far + sign * 0.7 : room.z + t + 0.48;
        pushProp(covers, map, room, stall, sx, sz, alongX ? 0 : 90);
      }
    }
  } else {
    const x = alongX ? room.x : far + sign * 0.45;
    const z = alongX ? far + sign * 0.45 : room.z;
    pushProp(covers, map, room, toilet, x, z, yaw);
  }
  const sinkSide = side === 'n' || side === 's' ? room.x - room.width / 2 + 0.4 : room.z - room.depth / 2 + 0.4;
  const sinkX = alongX ? sinkSide : room.x;
  const sinkZ = alongX ? room.z : sinkSide;
  if (!pushProp(covers, map, room, sink, sinkX, sinkZ, alongX ? 90 : 0)) {
    pushProp(covers, map, room, sink, room.x, room.z, 0);
  }
  if (!covers.some((c) => c.prop === 'toilet' && sameFloor(c.y ?? 0, room.floorY ?? 0) && Math.hypot(c.x - room.x, c.z - room.z) < Math.max(room.width, room.depth))) {
    const rect = rectOf(room);
    for (let i = 1; i <= 4 && !covers.some((c) => c.prop === 'toilet'); i++) {
      for (let j = 1; j <= 4; j++) {
        const x = rect.x0 + (room.width * i) / 5;
        const z = rect.z0 + (room.depth * j) / 5;
        if (pushProp(covers, map, room, toilet, x, z, 0)) break;
      }
    }
  }
}

function pickHall(rooms: readonly RoomDef[], doors: readonly DoorDef[]): RoomDef | undefined {
  const indoor = rooms.filter((r) => !r.outdoor && !r.id.includes('stair') && !isToiletId(r.id) && (r.floorY ?? 0) > -0.4 && (r.floorY ?? 0) < 1.2);
  let best: RoomDef | undefined;
  let bestScore = 12;
  for (const r of indoor) {
    const area = r.width * r.depth;
    if (area < 16 || Math.min(r.width, r.depth) < 3.2) continue;
    let doorsN = 0;
    const rect = rectOf(r);
    for (const d of doors) {
      if (!sameFloor(d.y ?? 0, r.floorY ?? 0)) continue;
      const onEdge =
        (Math.abs(d.z - rect.z0) < 1.3 || Math.abs(d.z - rect.z1) < 1.3 || Math.abs(d.x - rect.x0) < 1.3 || Math.abs(d.x - rect.x1) < 1.3) &&
        d.x >= rect.x0 - 0.6 &&
        d.x <= rect.x1 + 0.6 &&
        d.z >= rect.z0 - 0.6 &&
        d.z <= rect.z1 + 0.6;
      if (onEdge) doorsN++;
    }
    const hub = /(ldk|hall|lobby|reception|living|genkan)/.test(r.id) ? 8 : 0;
    const score = doorsN * 6 + area * 0.15 + hub;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/** 民家では浴室をトイレに書き換えず、物置や書斎など生活の間以外を選ぶ。 */
function pickHouseToilet(rooms: readonly RoomDef[], hall: RoomDef | undefined): RoomDef | undefined {
  const indoor = rooms.filter((r) => !r.outdoor && r !== hall && !r.id.includes('stair') && !r.id.startsWith('core'));
  const rank = (r: RoomDef): number => {
    if (/bath/.test(r.id)) return 80;
    if (/bedroom|ldk|living/.test(r.id)) return 40;
    if (/storage|garage|closet|kitchen/.test(r.id)) return 0;
    return 12;
  };
  const candidates = indoor.filter((r) => rank(r) < 40 && r.width * r.depth < 22);
  candidates.sort((a, b) => rank(a) - rank(b) || a.width * a.depth - b.width * b.depth);
  if (candidates[0]) return candidates[0];
  const fallback = indoor.filter((r) => rank(r) < 80);
  fallback.sort((a, b) => a.width * a.depth - b.width * b.depth);
  return fallback[0];
}

function placeColumns(covers: BoxDef[], map: GeneratedMapRaw, room: RoomDef, prop: 'column' | 'post' = 'column'): void {
  if (Math.min(room.width, room.depth) < (prop === 'post' ? 4.2 : 5.2)) return;
  const spec: Spec = prop === 'post'
    ? { prop: 'post', width: 0.18, depth: 0.18, height: 2.2, place: 'wall' }
    : { prop: 'column', width: 0.42, depth: 0.42, height: 2.12, place: 'wall' };
  const ix = room.width / 2 - 0.7;
  const iz = room.depth / 2 - 0.7;
  for (const x of [-ix, ix]) {
    for (const z of [-iz, iz]) {
      pushProp(covers, map, room, spec, room.x + x, room.z + z, 0);
    }
  }
}

/** 天井際の梁と吊り灯。歩行高さ（目線 1.6m）より上なので通路は塞がない。 */
function placeHallDress(covers: BoxDef[], room: RoomDef): void {
  const floorY = room.floorY ?? 0;
  const inset = 0.7;
  const spanX = room.width - inset * 2;
  const spanZ = room.depth - inset * 2;
  if (spanX > 2 && spanZ > 2) {
    const beamY = floorY + 2.08;
    const alongX: Spec = { prop: 'beam', width: round3(spanX), depth: 0.16, height: 0.18, place: 'center' };
    const alongZ: Spec = { prop: 'beam', width: 0.16, depth: round3(spanZ), height: 0.18, place: 'center' };
    const z0 = room.z - room.depth / 2 + inset;
    const z1 = room.z + room.depth / 2 - inset;
    const x0 = room.x - room.width / 2 + inset;
    const x1 = room.x + room.width / 2 - inset;
    pushHigh(covers, room, alongX, room.x, z0, beamY);
    pushHigh(covers, room, alongX, room.x, z1, beamY);
    pushHigh(covers, room, alongZ, x0, room.z, beamY);
    pushHigh(covers, room, alongZ, x1, room.z, beamY);
  }
  const lamp: Spec = { prop: 'lamp', width: 0.36, depth: 0.36, height: 0.7, place: 'center' };
  pushHigh(covers, room, lamp, room.x, room.z - room.depth * 0.18, floorY + 1.92);
  if (Math.min(room.width, room.depth) >= 5) {
    pushHigh(covers, room, lamp, room.x, room.z + room.depth * 0.18, floorY + 1.92);
  }
}

function pushHigh(covers: BoxDef[], room: RoomDef, spec: Spec, x: number, z: number, y: number): boolean {
  const box: BoxDef = {
    x: round3(x),
    z: round3(z),
    y: round3(y),
    width: spec.width,
    depth: spec.depth,
    height: spec.height,
    prop: spec.prop,
  };
  if (!inside(rectOf(room), box, 0.02)) return false;
  covers.push(box);
  return true;
}

function retile(floors: BoxDef[], room: RoomDef, material: string): void {
  const rect = rectOf(room);
  const y = room.floorY ?? 0;
  for (const f of floors) {
    const surface = (f.y ?? 0) + f.height;
    if (Math.abs(surface - y) > 0.35) continue;
    const cx = f.x;
    const cz = f.z;
    if (cx < rect.x0 || cx > rect.x1 || cz < rect.z0 || cz > rect.z1) continue;
    f.material = material;
  }
}

function carveAtrium(rooms: RoomDef[], floors: BoxDef[], covers: BoxDef[], map: GeneratedMapRaw, hall: RoomDef | undefined): void {
  const grounds = rooms.filter((r) => !r.outdoor && !r.id.includes('stair') && !r.id.startsWith('core') && (r.floorY ?? 0) > -0.4 && (r.floorY ?? 0) < 1.2 && r.width * r.depth >= 14);
  grounds.sort((a, b) => (b === hall ? 1 : 0) - (a === hall ? 1 : 0) || b.width * b.depth - a.width * a.depth);
  for (const ground of grounds) {
    if (carveOneAtrium(rooms, floors, covers, map, ground)) return;
  }
}

function carveOneAtrium(rooms: RoomDef[], floors: BoxDef[], covers: BoxDef[], map: GeneratedMapRaw, hall: RoomDef): boolean {
  const hallY = hall.floorY ?? 0;
  const upper = rooms.filter((r) => !r.outdoor && !r.id.includes('stair') && !r.id.startsWith('core') && (r.floorY ?? 0) > hallY + 2);
  if (upper.length === 0) return false;
  const hallRect = rectOf(hall);
  let best: { room: RoomDef; hole: Rect } | undefined;
  for (const r of upper) {
    const o = overlap(hallRect, rectOf(r));
    if (!o) continue;
    if (o.x1 - o.x0 < 3.2 || o.z1 - o.z0 < 3.2) continue;
    const hole = inset(o, 0.9);
    if (hole.x1 - hole.x0 < 1.6 || hole.z1 - hole.z0 < 1.6) continue;
    const area = (hole.x1 - hole.x0) * (hole.z1 - hole.z0);
    if (!best || area > (best.hole.x1 - best.hole.x0) * (best.hole.z1 - best.hole.z0)) best = { room: r, hole };
  }
  if (!best) return false;
  const hole = best.hole;
  const upY = best.room.floorY ?? 0;
  const keep: Rect[] = [];
  for (const st of map.stairs ?? []) {
    keep.push(xzOf({
      x: st.x,
      z: st.z,
      y: st.y ?? 0,
      width: st.width + 0.5,
      depth: st.steps * st.run + 0.5,
      height: 1,
      yaw: st.yaw,
    }));
  }
  for (const c of covers) if (sameFloor(c.y ?? 0, upY)) keep.push(xzOf(c));
  for (const e of map.entities) {
    if (!sameFloor(e.y ?? 0, upY)) continue;
    keep.push({ x0: e.x - 0.45, z0: e.z - 0.45, x1: e.x + 0.45, z1: e.z + 0.45 });
  }
  const voids = subtractRects(hole, keep).filter((v) => v.x1 - v.x0 >= 1.35 && v.z1 - v.z0 >= 1.35);
  if (voids.length === 0) return false;

  const next: BoxDef[] = [];
  for (const f of floors) {
    const surface = (f.y ?? 0) + f.height;
    if (Math.abs(surface - upY) > 0.35 || !rectsOverlap(xzOf(f), hole)) {
      next.push(f);
      continue;
    }
    const base: Rect = xzOf(f);
    for (const piece of subtractRects(base, voids)) {
      const w = piece.x1 - piece.x0;
      const d = piece.z1 - piece.z0;
      if (w < 0.18 || d < 0.18) continue;
      next.push({
        ...f,
        x: round3((piece.x0 + piece.x1) / 2),
        z: round3((piece.z0 + piece.z1) / 2),
        width: round3(w),
        depth: round3(d),
      });
    }
  }

  const railH = 1.05;
  const rails: { x: number; z: number; width: number; depth: number }[] = [
    { x: (hole.x0 + hole.x1) / 2, z: hole.z0 - 0.05, width: hole.x1 - hole.x0, depth: 0.08 },
    { x: (hole.x0 + hole.x1) / 2, z: hole.z1 + 0.05, width: hole.x1 - hole.x0, depth: 0.08 },
    { x: hole.x0 - 0.05, z: (hole.z0 + hole.z1) / 2, width: 0.08, depth: hole.z1 - hole.z0 },
    { x: hole.x1 + 0.05, z: (hole.z0 + hole.z1) / 2, width: 0.08, depth: hole.z1 - hole.z0 },
  ];
  const upperRect = rectOf(best.room);
  for (const rail of rails) {
    const box: BoxDef = {
      x: round3(rail.x),
      z: round3(rail.z),
      y: round3(upY),
      width: round3(rail.width),
      depth: round3(rail.depth),
      height: railH,
      prop: 'rail',
    };
    const foot = xzOf(box);
    const gallery =
      foot.x0 >= upperRect.x0 - 0.05 &&
      foot.x1 <= upperRect.x1 + 0.05 &&
      foot.z0 >= upperRect.z0 - 0.05 &&
      foot.z1 <= upperRect.z1 + 0.05;
    if (!gallery) continue;
    if (blocked(covers, box, map, 0)) continue;
    covers.push(box);
  }
  if (!covers.some((c) => c.prop === 'rail' && sameFloor(c.y ?? 0, upY))) return false;
  floors.splice(0, floors.length, ...next);
  return true;
}

function overlap(a: Rect, b: Rect): Rect | null {
  const r = {
    x0: Math.max(a.x0, b.x0),
    z0: Math.max(a.z0, b.z0),
    x1: Math.min(a.x1, b.x1),
    z1: Math.min(a.z1, b.z1),
  };
  return r.x1 - r.x0 > 0.2 && r.z1 - r.z0 > 0.2 ? r : null;
}

export function applyMotifScenes<T extends GeneratedMapRaw>(map: T): T {
  if (!map.motif || map.seed === undefined) return map;
  const motif = motifById(map.motif);
  const rng = new Rng((normalizeSeed(map.seed) ^ 0x51e11e) >>> 0);
  const covers = map.covers.map((c) => ({ ...c }));
  const rooms = map.rooms.map((r) => ({ ...r }));
  const floors = map.floors?.map((f) => ({ ...f }));

  const hall = pickHall(rooms, map.doors);
  if (hall) {
    hall.name = HALL_NAME[motif.id];
    if (floors) retile(floors, hall, HALL_FLOOR[motif.id]);
    placeColumns(covers, map, hall, motif.id === 'house' ? 'post' : 'column');
    placeHallDress(covers, hall);
  }
  const toilet = motif.id === 'house' ? pickHouseToilet(rooms, hall) : pickToilet(rooms, hall);
  if (toilet) {
    toilet.name = TOILET_NAME[motif.id];
    if (floors) retile(floors, toilet, 'tile');
    placeToiletFixtures(covers, map, toilet);
  }

  const limit: Record<string, number> = { bed: 3, hbed: 3, piano: 1, bar: 1, sofa: 2, teller: 1, vault: 1, stretcher: 1, medcab: 1, container: 2, shelf: 2, desk: 3, chair: 4, partition: 2, low_table: 3, engawa: 2 };
  for (const room of rooms) {
    if (room.id.includes('stair') || room === toilet) continue;
    if (room.outdoor && motif.id !== 'house') continue;
    const role = roleOf(room.id);
    const specs = ROOM_PROPS[motif.id][role] ?? [];
    for (const spec of specs) placeSpec(covers, map, room, spec, rng, limit[spec.prop] ?? 2);
  }
  if (hall && motif.id === 'clubhouse') {
    for (const spec of ROOM_PROPS.clubhouse.social ?? []) placeSpec(covers, map, hall, spec, rng, limit[spec.prop] ?? 1);
  }
  if (hall && motif.id === 'bank') {
    for (const spec of ROOM_PROPS.bank.social ?? []) placeSpec(covers, map, hall, spec, rng, limit[spec.prop] ?? 1);
  }
  if (hall && motif.id === 'warehouse') {
    for (const spec of ROOM_PROPS.warehouse.service ?? []) placeSpec(covers, map, hall, spec, rng, limit[spec.prop] ?? 2);
  }
  if (hall && motif.id === 'hospital') {
    placeSpec(covers, map, hall, { prop: 'stretcher', width: 1.9, depth: 0.72, height: 0.85, place: 'center' }, rng, 1);
  }
  if (hall && motif.id === 'office') {
    placeSpec(covers, map, hall, { prop: 'partition', width: 1.8, depth: 0.08, height: 1.45, place: 'center' }, rng, 2);
  }
  if (hall && motif.id === 'house') {
    placeSpec(covers, map, hall, { prop: 'low_table', width: 1.2, depth: 0.72, height: 0.35, place: 'center' }, rng, 2);
  }
  if (motif.id === 'house' && floors) {
    for (const room of rooms) if (room.outdoor) retile(floors, room, 'wood');
  }

  if (!covers.some((c) => c.prop === 'hbed') && motif.id === 'hospital') {
    const room = rooms.find((r) => !r.outdoor && r !== toilet && Math.min(r.width, r.depth) >= 2.6);
    if (room) placeSpec(covers, map, room, { prop: 'hbed', width: 2.0, depth: 1.3, height: 0.85, place: 'wall' }, rng, 1);
  }
  if (!covers.some((c) => c.prop === 'piano') && motif.id === 'clubhouse') {
    const room = hall ?? rooms.find((r) => !r.outdoor && Math.min(r.width, r.depth) >= 3);
    if (room) placeSpec(covers, map, room, { prop: 'piano', width: 1.45, depth: 0.7, height: 1.28, place: 'wall' }, rng, 1);
  }
  if (motif.id === 'house' && !covers.some((c) => c.prop === 'bed')) {
    const room = rooms.find((r) => !r.outdoor && r !== toilet && /bedroom|private/.test(r.id))
      ?? rooms.find((r) => !r.outdoor && r !== toilet && Math.min(r.width, r.depth) >= 2.4);
    if (room) placeSpec(covers, map, room, { prop: 'bed', width: 2.0, depth: 1.4, height: 0.6, place: 'wall' }, rng, 1);
  }

  if (floors && hall) carveAtrium(rooms, floors, covers, map, hall);

  return {
    ...map,
    rooms,
    covers,
    ...(floors ? { floors } : {}),
  };
}
