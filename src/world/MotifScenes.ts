import type { BoxDef, DoorDef, GeneratedMapRaw, MotifId, RoomDef, StairDef } from '../core/types';
import { normalizeSeed, Rng } from './generator/Rng';
import type { Rect } from './generator/Layout';
import { inset, rectsOverlap, round3, sharedEdge, subtractRects } from './generator/Layout';
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

export const ATRIUM_GALLERY_TARGET = 1.8;
export const ATRIUM_GALLERY_MIN = 1.65;
export const ATRIUM_HOLE_MIN_SIDE = 2.4;
export const ATRIUM_MAX_AREA_RATIO = 0.4;
export const ATRIUM_VOID_MIN_SIDE = 2.0;
export const ATRIUM_SNAP = 0.25;
export const ATRIUM_DOOR_CLEAR_MARGIN = 0.45;

const HALL_NAME: Record<MotifId, string> = {
  hospital: 'メインホール',
  clubhouse: 'メインラウンジ',
  bank: '窓口ホール',
  office: 'ロビー',
  warehouse: '荷捌きホール',
  embassy: 'レセプションホール',
  residence: 'リビング',
  japanese_house: '座敷',
  air_force_one: '会議室',
};

const TOILET_NAME: Record<MotifId, string> = {
  hospital: 'トイレ',
  clubhouse: '化粧室',
  bank: '化粧室',
  office: 'トイレ',
  warehouse: 'トイレ',
  embassy: '化粧室',
  residence: 'トイレ',
  japanese_house: 'トイレ',
  air_force_one: '化粧室',
};

const HALL_FLOOR: Record<MotifId, string> = {
  hospital: 'linoleum',
  clubhouse: 'carpet',
  bank: 'marble',
  office: 'carpet',
  warehouse: 'concrete',
  embassy: 'marble',
  residence: 'wood',
  japanese_house: 'tatami',
  air_force_one: 'carpet',
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
    circ: [{ prop: 'planter', width: 0.7, depth: 0.7, height: 0.55, place: 'wall' }],
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
  embassy: {
    social: [
      { prop: 'banquet_table', width: 2.2, depth: 0.95, height: 0.78, place: 'center' },
      { prop: 'bench', width: 1.5, depth: 0.52, height: 0.82, place: 'wall' },
    ],
    work: [
      { prop: 'desk', width: 1.55, depth: 0.75, height: 0.76, place: 'wall' },
      { prop: 'chair', width: 0.5, depth: 0.5, height: 0.9, place: 'center' },
    ],
    secure: [
      { prop: 'vault', width: 1.35, depth: 0.38, height: 2.05, place: 'wall' },
      { prop: 'shelf', width: 1.5, depth: 0.45, height: 1.85, place: 'wall' },
    ],
    private: [
      { prop: 'sofa', width: 1.95, depth: 0.85, height: 0.84, place: 'wall' },
      { prop: 'desk', width: 1.45, depth: 0.7, height: 0.76, place: 'wall' },
    ],
    circ: [
      { prop: 'bench', width: 1.45, depth: 0.5, height: 0.82, place: 'wall' },
      { prop: 'planter', width: 0.75, depth: 0.75, height: 0.65, place: 'wall' },
    ],
    outdoor: [
      { prop: 'planter', width: 0.85, depth: 0.85, height: 0.75, place: 'wall' },
      { prop: 'bench', width: 1.5, depth: 0.55, height: 0.82, place: 'wall' },
    ],
  },
  residence: {},
  japanese_house: {
    social: [{ prop: 'low_table', width: 1.2, depth: 0.72, height: 0.35, place: 'center' }],
    outdoor: [
      { prop: 'engawa', width: 2.2, depth: 0.72, height: 0.32, place: 'wall' },
      { prop: 'planter', width: 0.7, depth: 0.7, height: 0.55, place: 'wall' },
    ],
  },
  air_force_one: {},
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

interface FloorRect {
  y: number;
  rect: Rect;
}

const openingKeepOutsCache = new WeakMap<GeneratedMapRaw, FloorRect[]>();

/** 隣接部屋の共有辺で壁に覆われていない幅 0.8m 以上の区間（アーチ・連絡口）の前後を禁止矩形にする。 */
function buildOpeningKeepOuts(map: GeneratedMapRaw): FloorRect[] {
  const cached = openingKeepOutsCache.get(map);
  if (cached) return cached;
  const out: FloorRect[] = [];
  const rooms = map.rooms;
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i]!;
      const b = rooms[j]!;
      const y = a.floorY ?? 0;
      if (!sameFloor(y, b.floorY ?? 0)) continue;
      const edge = sharedEdge(rectOf(a), rectOf(b));
      if (!edge) continue;
      const covered: [number, number][] = [];
      for (const w of map.walls) {
        // 床面から立つ壁（腰壁を含む）だけが通行を塞ぐ。垂れ壁（lintel）は開口として扱わない。
        if (!sameFloor(w.y ?? 0, y)) continue;
        const wr = xzOf(w);
        if (edge.axis === 'x') {
          if (wr.z0 - 0.06 <= edge.c && edge.c <= wr.z1 + 0.06) {
            const lo = Math.max(edge.lo, wr.x0);
            const hi = Math.min(edge.hi, wr.x1);
            if (hi > lo) covered.push([lo, hi]);
          }
        } else if (wr.x0 - 0.06 <= edge.c && edge.c <= wr.x1 + 0.06) {
          const lo = Math.max(edge.lo, wr.z0);
          const hi = Math.min(edge.hi, wr.z1);
          if (hi > lo) covered.push([lo, hi]);
        }
      }
      // 扉の開口は doorKeepRect で別途保護するので、アーチ検出からは除く。
      for (const d of map.doors) {
        if (!sameFloor(d.y ?? 0, y)) continue;
        const along = edge.axis === 'x' ? d.x : d.z;
        const perp = edge.axis === 'x' ? d.z : d.x;
        if (Math.abs(perp - edge.c) < 0.7 && along > edge.lo && along < edge.hi) {
          const half = (d.width ?? 1.2) / 2;
          covered.push([along - half, along + half]);
        }
      }
      const free = subtractIntervals([[edge.lo, edge.hi]], covered);
      for (const [f0, f1] of free) {
        if (f1 - f0 < 0.8) continue;
        out.push({
          y,
          rect: edge.axis === 'x'
            ? { x0: f0 - 0.25, z0: edge.c - 1.25, x1: f1 + 0.25, z1: edge.c + 1.25 }
            : { x0: edge.c - 1.25, z0: f0 - 0.25, x1: edge.c + 1.25, z1: f1 + 0.25 },
        });
      }
    }
  }
  openingKeepOutsCache.set(map, out);
  return out;
}

/** 階段フットプリントを進行方向前後 +1.1m・幅方向 +0.35m 広げた乗降口保護矩形。 */
function stairKeepRect(st: StairDef): Rect {
  const base = xzOf({ x: st.x, z: st.z, y: st.y ?? 0, width: st.width, depth: st.steps * st.run, height: 1, yaw: st.yaw });
  const yawRad = ((st.yaw ?? 0) * Math.PI) / 180;
  const runX = Math.abs(Math.sin(yawRad));
  const runZ = Math.abs(Math.cos(yawRad));
  const ex = 1.1 * runX + 0.35 * runZ;
  const ez = 1.1 * runZ + 0.35 * runX;
  return { x0: base.x0 - ex, z0: base.z0 - ez, x1: base.x1 + ex, z1: base.z1 + ez };
}

function blocked(covers: readonly BoxDef[], box: BoxDef, map: GeneratedMapRaw, gap: number): boolean {
  const r = xzOf(box);
  const y = box.y ?? 0;
  const padded = { x0: r.x0 - gap, z0: r.z0 - gap, x1: r.x1 + gap, z1: r.z1 + gap };
  for (const c of covers) {
    if (!sameFloor(c.y ?? 0, y)) continue;
    if (rectsOverlap(padded, xzOf(c))) return true;
  }
  for (const d of map.doors) {
    if (!sameFloor(d.y ?? 0, y)) continue;
    if (rectsOverlap(r, doorKeepRect(d))) return true;
  }
  for (const k of buildOpeningKeepOuts(map)) {
    if (!sameFloor(k.y, y)) continue;
    if (rectsOverlap(r, k.rect)) return true;
  }
  for (const st of map.stairs ?? []) {
    const baseY = st.y ?? 0;
    if (!sameFloor(baseY, y) && !sameFloor(baseY + st.steps * st.rise, y)) continue;
    if (rectsOverlap(r, stairKeepRect(st))) return true;
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

function pushProp(covers: BoxDef[], map: GeneratedMapRaw, room: RoomDef, spec: Spec, x: number, z: number, yaw = 0, gap = 0.65): boolean {
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
  if (blocked(covers, box, map, gap)) return false;
  covers.push(box);
  return true;
}

/**
 * 壁際へ置く。正面（ローカル +Z）が部屋の内側を向く。
 * 幅は壁に沿う長さ、奥行は壁から部屋へ出る厚み。
 */
/** 候補の背面（部屋の辺）に実際に床面から立つ壁があり、その壁片が候補中心を覆うか。 */
function hasBackingWall(map: GeneratedMapRaw, room: RoomDef, box: BoxDef, side: 's' | 'n' | 'w' | 'e'): boolean {
  const rect = rectOf(room);
  const y = box.y ?? 0;
  for (const w of map.walls) {
    if (!sameFloor(w.y ?? 0, y)) continue;
    const wr = xzOf(w);
    if (side === 's' || side === 'n') {
      const c = side === 's' ? rect.z0 : rect.z1;
      if (wr.z0 - 0.25 <= c && c <= wr.z1 + 0.25 && wr.x0 - 0.05 <= box.x && box.x <= wr.x1 + 0.05) return true;
    } else {
      const c = side === 'w' ? rect.x0 : rect.x1;
      if (wr.x0 - 0.25 <= c && c <= wr.x1 + 0.25 && wr.z0 - 0.05 <= box.z && box.z <= wr.z1 + 0.05) return true;
    }
  }
  return false;
}

function placeAgainstWall(covers: BoxDef[], map: GeneratedMapRaw, room: RoomDef, spec: Spec, rng: Rng): boolean {
  const rect = rectOf(room);
  const gap = 0.1;
  const options: { yaw: number; x: number; z: number; axis: 'x' | 'z'; side: 's' | 'n' | 'w' | 'e' }[] = [
    { yaw: 0, x: 0, z: rect.z0 + spec.depth / 2 + gap, axis: 'x', side: 's' },
    { yaw: 180, x: 0, z: rect.z1 - spec.depth / 2 - gap, axis: 'x', side: 'n' },
    { yaw: 90, x: rect.x0 + spec.depth / 2 + gap, z: 0, axis: 'z', side: 'w' },
    { yaw: 270, x: rect.x1 - spec.depth / 2 - gap, z: 0, axis: 'z', side: 'e' },
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
    const candidate: BoxDef = { x, z, y: room.floorY ?? 0, width: spec.width, depth: spec.depth, height: spec.height, yaw: o.yaw, prop: spec.prop };
    if (!hasBackingWall(map, room, candidate, o.side)) continue;
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
        // stall は便器に隣接させる設計のため、家具間ギャップだけ例外で 0.05 を許可する（扉・開口・階段の保護は不変）。
        pushProp(covers, map, room, stall, sx, sz, alongX ? 0 : 90, 0.05);
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

type Interval = [number, number];

function subtractIntervals(base: readonly Interval[], cuts: readonly Interval[]): Interval[] {
  let free: Interval[] = base.map(([a, b]): Interval => [a, b]).filter(([a, b]) => b - a > 1e-9);
  for (const [c0, c1] of cuts) {
    const next: Interval[] = [];
    for (const [f0, f1] of free) {
      if (c1 <= f0 || c0 >= f1) { next.push([f0, f1]); continue; }
      if (c0 > f0) next.push([f0, Math.min(c0, f1)]);
      if (c1 < f1) next.push([Math.max(c1, f0), f1]);
    }
    free = next.filter(([a, b]) => b - a > 1e-9);
  }
  free.sort((a, b) => a[0] - b[0]);
  return free;
}

function doorKeepRect(d: DoorDef): Rect {
  const width = d.width ?? 1.2;
  const leaf = d.double ? width / 2 : width;
  const reach = leaf + ATRIUM_DOOR_CLEAR_MARGIN;
  const along = width / 2 + 0.3;
  const yaw = ((d.yaw % 180) + 180) % 180;
  const wallAlongX = yaw < 45 || yaw > 135;
  return wallAlongX
    ? { x0: d.x - along, z0: d.z - reach, x1: d.x + along, z1: d.z + reach }
    : { x0: d.x - reach, z0: d.z - along, x1: d.x + reach, z1: d.z + along };
}

function carveOneAtrium(rooms: RoomDef[], floors: BoxDef[], covers: BoxDef[], map: GeneratedMapRaw, hall: RoomDef): boolean {
  const hallY = hall.floorY ?? 0;
  const upper = rooms.filter((r) => !r.outdoor && !r.id.includes('stair') && !r.id.startsWith('core') && (r.floorY ?? 0) > hallY + 2);
  if (upper.length === 0) return false;
  const hallRect = rectOf(hall);
  const minOverlap = 2 * ATRIUM_GALLERY_MIN + ATRIUM_HOLE_MIN_SIDE;
  interface Candidate { room: RoomDef; hole: Rect; upperRect: Rect; upY: number }
  const candidates: Candidate[] = [];
  for (const r of upper) {
    const upperRect = rectOf(r);
    const o = overlap(hallRect, upperRect);
    if (!o || o.x1 - o.x0 < minOverlap || o.z1 - o.z0 < minOverlap) continue;
    let hole: Rect | undefined;
    let g = ATRIUM_GALLERY_TARGET;
    for (;;) {
      const cand = inset(o, g);
      if (cand.x1 - cand.x0 >= ATRIUM_HOLE_MIN_SIDE && cand.z1 - cand.z0 >= ATRIUM_HOLE_MIN_SIDE) { hole = cand; break; }
      if (g <= ATRIUM_GALLERY_MIN + 1e-9) break;
      g = Math.max(ATRIUM_GALLERY_MIN, g - ATRIUM_SNAP);
    }
    if (!hole) continue;
    const roomArea = r.width * r.depth;
    let rejected = false;
    while ((hole.x1 - hole.x0) * (hole.z1 - hole.z0) > ATRIUM_MAX_AREA_RATIO * roomArea) {
      hole = inset(hole, ATRIUM_SNAP / 2);
      if (hole.x1 - hole.x0 < ATRIUM_HOLE_MIN_SIDE || hole.z1 - hole.z0 < ATRIUM_HOLE_MIN_SIDE) { rejected = true; break; }
    }
    if (rejected) continue;
    candidates.push({ room: r, hole, upperRect, upY: r.floorY ?? 0 });
  }
  if (candidates.length === 0) return false;

  interface Attempt { cand: Candidate; hole: Rect; voidRect: Rect; keep: Rect[]; doorKeeps: Rect[]; stairKeeps: Rect[]; coverKeeps: { rect: Rect; height: number }[] }
  const attempts: Attempt[] = [];
  for (const cand of candidates) {
    const { hole, upY } = cand;
    const keep: Rect[] = [];
    const stairKeeps: Rect[] = [];
    for (const st of map.stairs ?? []) {
      const rect = xzOf({ x: st.x, z: st.z, y: st.y ?? 0, width: st.width + 0.5, depth: st.steps * st.run + 0.5, height: 1, yaw: st.yaw });
      stairKeeps.push(rect); keep.push(rect);
    }
    const coverKeeps: { rect: Rect; height: number }[] = [];
    for (const c of covers) if (sameFloor(c.y ?? 0, upY)) { const rect = xzOf(c); coverKeeps.push({ rect, height: c.height }); keep.push(rect); }
    const doorKeeps: Rect[] = [];
    for (const d of map.doors) {
      if (!sameFloor(d.y ?? 0, upY)) continue;
      const rect = doorKeepRect(d); doorKeeps.push(rect); keep.push(rect);
    }
    const spawn = map.playerSpawn;
    if (sameFloor(spawn.y, upY)) keep.push({ x0: spawn.x - 1.0, z0: spawn.z - 1.0, x1: spawn.x + 1.0, z1: spawn.z + 1.0 });
    for (const a of map.allies) if (sameFloor(a.y ?? 0, upY)) keep.push({ x0: a.x - 0.9, z0: a.z - 0.9, x1: a.x + 0.9, z1: a.z + 0.9 });
    for (const e of map.entities) if (sameFloor(e.y ?? 0, upY)) keep.push({ x0: e.x - 0.6, z0: e.z - 0.6, x1: e.x + 0.6, z1: e.z + 0.6 });
    const voids = subtractRects(hole, keep).filter((v) => v.x1 - v.x0 >= ATRIUM_VOID_MIN_SIDE && v.z1 - v.z0 >= ATRIUM_VOID_MIN_SIDE);
    if (voids.length === 0) continue;
    let voidRect = voids[0]!;
    for (const v of voids) if ((v.x1 - v.x0) * (v.z1 - v.z0) > (voidRect.x1 - voidRect.x0) * (voidRect.z1 - voidRect.z0)) voidRect = v;
    attempts.push({ cand, hole, voidRect, keep, doorKeeps, stairKeeps, coverKeeps });
  }
  attempts.sort((a, b) => (b.voidRect.x1 - b.voidRect.x0) * (b.voidRect.z1 - b.voidRect.z0) - (a.voidRect.x1 - a.voidRect.x0) * (a.voidRect.z1 - a.voidRect.z0) || a.voidRect.x0 - b.voidRect.x0 || a.voidRect.z0 - b.voidRect.z0);

  for (const att of attempts) {
    const { hole, voidRect, doorKeeps, stairKeeps, coverKeeps } = att;
    const { upperRect, upY } = att.cand;
    const next: BoxDef[] = [];
    for (const f of floors) {
      const surface = (f.y ?? 0) + f.height;
      if (Math.abs(surface - upY) > 0.35 || !rectsOverlap(xzOf(f), hole)) { next.push(f); continue; }
      const base: Rect = xzOf(f);
      for (const piece of subtractRects(base, [voidRect])) {
        const w = piece.x1 - piece.x0; const d = piece.z1 - piece.z0;
        if (w < 0.18 || d < 0.18) continue;
        next.push({ ...f, x: round3((piece.x0 + piece.x1) / 2), z: round3((piece.z0 + piece.z1) / 2), width: round3(w), depth: round3(d) });
      }
    }
    const floorRects: Rect[] = [];
    for (const f of next) if (Math.abs((f.y ?? 0) + f.height - upY) <= 0.35) floorRects.push(xzOf(f));

    interface Edge { axis: 'x' | 'z'; coord: number; lo: number; hi: number; band: Rect; outward: -1 | 1 }
    const v = voidRect;
    const edges: Edge[] = [
      { axis: 'x', coord: v.z0, lo: v.x0, hi: v.x1, band: { x0: v.x0, z0: v.z0 - 0.3, x1: v.x1, z1: v.z0 }, outward: -1 },
      { axis: 'x', coord: v.z1, lo: v.x0, hi: v.x1, band: { x0: v.x0, z0: v.z1, x1: v.x1, z1: v.z1 + 0.3 }, outward: 1 },
      { axis: 'z', coord: v.x0, lo: v.z0, hi: v.z1, band: { x0: v.x0 - 0.3, z0: v.z0, x1: v.x0, z1: v.z1 }, outward: -1 },
      { axis: 'z', coord: v.x1, lo: v.z0, hi: v.z1, band: { x0: v.x1, z0: v.z0, x1: v.x1 + 0.3, z1: v.z1 }, outward: 1 },
    ];
    const pending: BoxDef[] = [];
    let failed = false;
    let hasRequired = false;
    for (const edge of edges) {
      if (!floorRects.some((fr) => rectsOverlap(fr, edge.band))) continue;
      hasRequired = true;
      const cutsFor = (rects: readonly Rect[], pad: number): Interval[] => {
        const out: Interval[] = [];
        for (const k of rects) {
          if (edge.axis === 'x') {
            if (k.z0 > edge.coord + 0.15 || k.z1 < edge.coord - 0.15) continue;
            const lo = Math.max(edge.lo, k.x0 - pad); const hi = Math.min(edge.hi, k.x1 + pad);
            if (hi > lo) out.push([lo, hi]);
          } else {
            if (k.x0 > edge.coord + 0.15 || k.x1 < edge.coord - 0.15) continue;
            const lo = Math.max(edge.lo, k.z0 - pad); const hi = Math.min(edge.hi, k.z1 + pad);
            if (hi > lo) out.push([lo, hi]);
          }
        }
        return out;
      };
      const passage: Interval[] = [...cutsFor(doorKeeps, 0.1), ...cutsFor(stairKeeps, 0)];
      const tallRects = coverKeeps.filter((c) => c.height >= 0.9).map((c) => c.rect);
      const remaining = subtractIntervals([[edge.lo, edge.hi]], passage);
      const railIntervals = subtractIntervals(remaining, cutsFor(tallRects, 0));
      for (const [a, b] of railIntervals) {
        if (b - a < 0.5) continue;
        const ea = a <= edge.lo + 1e-9 ? a - 0.08 : a;
        const eb = b >= edge.hi - 1e-9 ? b + 0.08 : b;
        const mid = (ea + eb) / 2; const len = eb - ea;
        const box: BoxDef = edge.axis === 'x'
          ? { x: round3(mid), z: round3(edge.coord + edge.outward * 0.05), y: round3(upY), width: round3(len), depth: 0.08, height: 1.05, prop: 'rail' }
          : { x: round3(edge.coord + edge.outward * 0.05), z: round3(mid), y: round3(upY), width: 0.08, depth: round3(len), height: 1.05, prop: 'rail' };
        const foot = xzOf(box);
        if (foot.x0 < upperRect.x0 - 0.06 || foot.x1 > upperRect.x1 + 0.06 || foot.z0 < upperRect.z0 - 0.06 || foot.z1 > upperRect.z1 + 0.06) { failed = true; break; }
        if (doorKeeps.some((k) => rectsOverlap(foot, k))) { failed = true; break; }
        if (covers.some((c) => sameFloor(c.y ?? 0, upY) && rectsOverlap(foot, xzOf(c)))) { failed = true; break; }
        pending.push(box);
      }
      if (failed) break;
    }
    if (failed || !hasRequired) continue;
    floors.splice(0, floors.length, ...next);
    for (const box of pending) covers.push(box);
    return true;
  }
  return false;
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
  // 民家は生成器の自然な部屋名と家具のまま。階段・壁・扉のコリジョンは生成器側が既に持つ。
  if (!map.motif || map.motif === 'residence' || map.seed === undefined) return map;
  const motif = motifById(map.motif);
  buildOpeningKeepOuts(map);
  const rng = new Rng((normalizeSeed(map.seed) ^ 0x51e11e) >>> 0);
  const covers = map.covers.map((c) => ({ ...c }));
  const rooms = map.rooms.map((r) => ({ ...r }));
  const floors = map.floors?.map((f) => ({ ...f }));

  const hall = pickHall(rooms, map.doors);
  if (hall) {
    hall.name = HALL_NAME[motif.id];
    if (floors) retile(floors, hall, HALL_FLOOR[motif.id]);
    placeColumns(covers, map, hall, motif.id === 'japanese_house' ? 'post' : 'column');
    placeHallDress(covers, hall);
  }
  const toilet = motif.id === 'japanese_house' ? pickHouseToilet(rooms, hall) : pickToilet(rooms, hall);
  if (toilet) {
    toilet.name = TOILET_NAME[motif.id];
    if (floors) retile(floors, toilet, 'tile');
    placeToiletFixtures(covers, map, toilet);
  }

  const limit: Record<string, number> = { bed: 3, hbed: 3, piano: 1, bar: 1, sofa: 2, teller: 1, vault: 1, stretcher: 1, medcab: 1, container: 2, shelf: 2, desk: 3, chair: 4, partition: 2, low_table: 3, engawa: 2, planter: 2, banquet_table: 2, bench: 3 };
  for (const room of rooms) {
    if (room.id.includes('stair') || room === toilet) continue;
    if (room.outdoor && motif.id !== 'japanese_house' && motif.id !== 'embassy') continue;
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
  if (hall && motif.id === 'embassy') {
    for (const spec of ROOM_PROPS.embassy.social ?? []) placeSpec(covers, map, hall, spec, rng, limit[spec.prop] ?? 2);
  }
  if (hall && motif.id === 'japanese_house') {
    placeSpec(covers, map, hall, { prop: 'low_table', width: 1.2, depth: 0.72, height: 0.35, place: 'center' }, rng, 2);
  }
  if (motif.id === 'japanese_house' && floors) {
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
  if (motif.id === 'embassy' && !covers.some((c) => c.prop === 'banquet_table')) {
    const room = hall ?? rooms.find((r) => !r.outdoor && r !== toilet && Math.min(r.width, r.depth) >= 3);
    if (room) placeSpec(covers, map, room, { prop: 'banquet_table', width: 2.2, depth: 0.95, height: 0.78, place: 'center' }, rng, 1);
  }
  if (motif.id === 'japanese_house' && !covers.some((c) => c.prop === 'bed')) {
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
