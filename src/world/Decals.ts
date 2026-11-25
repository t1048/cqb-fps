import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoxDef, MapData, RoomDef } from '../core/types';
import type { TextureLibrary } from './Materials';
import { motifById, type DecalKind, type MotifDef } from './Motif';
import { Rng } from './generator/Rng';

const MAX_DECALS = 36;

const FLOOR_KINDS: ReadonlySet<DecalKind> = new Set(['blood', 'dirt', 'scuff', 'hazard', 'stripe']);
const WALL_KINDS: ReadonlySet<DecalKind> = new Set([
  'poster', 'graffiti', 'sign', 'vault', 'medcross', 'stripe', 'hazard', 'scuff',
]);

interface DecalBucket {
  geos: THREE.BufferGeometry[];
  hasSign: boolean;
}

const _pos = new THREE.Vector3();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _mat4 = new THREE.Matrix4();

function addBakedDecal(
  buckets: Map<THREE.Material, DecalBucket>,
  mat: THREE.Material,
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
  isSign = false,
): void {
  const geo = new THREE.PlaneGeometry(w, h);
  _pos.set(x, y, z);
  _euler.set(rx, ry, rz);
  _quat.setFromEuler(_euler);
  _mat4.compose(_pos, _quat, _one);
  geo.applyMatrix4(_mat4);
  let bucket = buckets.get(mat);
  if (!bucket) {
    bucket = { geos: [], hasSign: false };
    buckets.set(mat, bucket);
  }
  bucket.geos.push(geo);
  if (isSign) bucket.hasSign = true;
}

/**
 * 部屋の床と壁にモチーフ用デカールを貼る。コライダは足さない。
 * テクスチャは TextureLibrary にキャッシュし、種類ごとにマテリアル・メッシュを共有統合する。
 */
export function addMotifDecals(
  root: THREE.Object3D,
  map: MapData,
  textures: TextureLibrary,
  keep: (material: THREE.Material) => void,
): void {
  if (!map.motif || map.motif === 'residence' || map.seed === undefined) return;
  const motif = motifById(map.motif);
  const rng = new Rng((map.seed ^ 0x51edec01) >>> 0);
  const floorMats = new Map<DecalKind, THREE.MeshStandardMaterial>();
  const wallMats = new Map<DecalKind, THREE.MeshStandardMaterial>();
  const buckets = new Map<THREE.Material, DecalBucket>();

  const matOfFloor = (kind: DecalKind): THREE.MeshStandardMaterial => {
    const hit = floorMats.get(kind);
    if (hit) return hit;
    const decalMap = textures.getDecal(kind) as THREE.CanvasTexture | undefined;
    const m = new THREE.MeshStandardMaterial({
      ...(decalMap ? { map: decalMap } : {}),
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    floorMats.set(kind, m);
    keep(m);
    return m;
  };
  const matOfWall = (kind: DecalKind): THREE.MeshStandardMaterial => {
    const hit = wallMats.get(kind);
    if (hit) return hit;
    const decalMap = textures.getDecal(kind) as THREE.CanvasTexture | undefined;
    const m = new THREE.MeshStandardMaterial({
      ...(decalMap ? { map: decalMap } : {}),
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    wallMats.set(kind, m);
    keep(m);
    return m;
  };

  let placed = 0;
  const rooms = map.rooms.filter((r) => !r.outdoor && r.width > 1.8 && r.depth > 1.8);
  for (const room of rooms) {
    if (placed >= MAX_DECALS) break;
    if (rng.chance(0.45)) {
      if (addFloorDecal(buckets, room, map, motif, rng, matOfFloor)) placed++;
    }
    if (placed < MAX_DECALS && rng.chance(0.5)) {
      if (addWallDecal(buckets, room, map, motif, rng, matOfWall)) placed++;
    }
  }
  addFacadeSign(buckets, map, motif, matOfWall);

  for (const [mat, bucket] of buckets) {
    let geo: THREE.BufferGeometry | null;
    if (bucket.geos.length === 1) {
      geo = bucket.geos[0]!;
    } else {
      geo = mergeGeometries(bucket.geos, false);
      for (const g of bucket.geos) g.dispose();
    }
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = bucket.hasSign ? 'decal-sign' : 'decal';
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
  }
}

function pickFloorKind(motif: MotifDef, rng: Rng): DecalKind | undefined {
  const pool = motif.decals.filter((k) => FLOOR_KINDS.has(k));
  if (pool.length === 0) return undefined;
  return rng.pick(pool) ?? pool[0];
}

function pickWallKind(motif: MotifDef, rng: Rng): DecalKind | undefined {
  const pool = motif.decals.filter((k) => WALL_KINDS.has(k));
  if (pool.length === 0) return undefined;
  return rng.pick(pool) ?? pool[0];
}

function addFloorDecal(
  buckets: Map<THREE.Material, DecalBucket>,
  room: RoomDef,
  map: MapData,
  motif: MotifDef,
  rng: Rng,
  matOf: (kind: DecalKind) => THREE.Material,
): boolean {
  const kind = pickFloorKind(motif, rng);
  if (!kind) return false;
  const w = 0.4 + rng.next() * 0.5;
  const d = kind === 'stripe' || kind === 'hazard' ? 0.25 + rng.next() * 0.45 : 0.25 + rng.next() * 0.45;
  const ix = room.width / 2 - 0.7;
  const iz = room.depth / 2 - 0.7;
  const rz = rng.next() * Math.PI * 2;
  const px = room.x + (rng.next() - 0.5) * Math.max(0.2, ix * 1.2);
  const pz = room.z + (rng.next() - 0.5) * Math.max(0.2, iz * 1.2);
  const spawn = map.playerSpawn;
  if (Math.hypot(px - spawn.x, pz - spawn.z) < 1.5) return false;
  addBakedDecal(buckets, matOf(kind), w, d, px, (room.floorY ?? 0) + 0.025, pz, -Math.PI / 2, 0, rz);
  return true;
}

function facePlane(side: number, room: RoomDef): number {
  if (side === 0) return room.z - room.depth / 2;
  if (side === 1) return room.z + room.depth / 2;
  if (side === 2) return room.x - room.width / 2;
  return room.x + room.width / 2;
}

function distToFacePlane(wall: BoxDef, faceZ: number, axis: 'x' | 'z'): number {
  const lo = (axis === 'z' ? wall.z : wall.x) - (axis === 'z' ? wall.depth : wall.width) / 2;
  const hi = (axis === 'z' ? wall.z : wall.x) + (axis === 'z' ? wall.depth : wall.width) / 2;
  if (faceZ >= lo && faceZ <= hi) return 0;
  return Math.min(Math.abs(faceZ - lo), Math.abs(faceZ - hi));
}

function findWallAlongFace(
  walls: readonly BoxDef[],
  side: number,
  room: RoomDef,
  cx: number,
  cz: number,
  y: number,
  h: number,
  w: number,
): BoxDef | undefined {
  const face = facePlane(side, room);
  const axis: 'x' | 'z' = side < 2 ? 'x' : 'z';
  const along = side < 2 ? cx : cz;
  const marginH = w / 2 + 0.4;
  const y0 = y - h / 2;
  const y1 = y + h / 2;
  for (const wall of walls) {
    if (distToFacePlane(wall, face, axis === 'x' ? 'z' : 'x') > 0.35) continue;
    const wy = wall.y ?? 0;
    if (wy + wall.height < y0 || wy > y1) continue;
    const spanLo = (axis === 'x' ? wall.x : wall.z) - (axis === 'x' ? wall.width : wall.depth) / 2;
    const spanHi = (axis === 'x' ? wall.x : wall.z) + (axis === 'x' ? wall.width : wall.depth) / 2;
    if (spanHi < along - marginH || spanLo > along + marginH) continue;
    return wall;
  }
  return undefined;
}

function openingOverlapsDecal(
  map: MapData,
  side: number,
  room: RoomDef,
  cx: number,
  cz: number,
  y: number,
  w: number,
  h: number,
): boolean {
  const margin = w / 2 + 0.35;
  const along = side < 2 ? cx : cz;
  const cross = side < 2 ? cz : cx;
  const face = facePlane(side, room);
  const y0 = y - h / 2;
  const y1 = y + h / 2;
  const floorY = room.floorY ?? 0;

  const nearFace = (ox: number, oz: number): boolean => {
    const d = side < 2 ? Math.abs(oz - face) : Math.abs(ox - face);
    return d < 0.5;
  };

  for (const win of map.windows) {
    if (!nearFace(win.x, win.z)) continue;
    const walong = side < 2 ? win.x : win.z;
    if (Math.abs(walong - along) > margin) continue;
    const base = win.y ?? floorY;
    const wsill = base + win.sill;
    const wtop = wsill + win.height;
    if (wtop >= y0 && wsill <= y1) return true;
  }

  for (const door of map.doors) {
    if (!nearFace(door.x, door.z)) continue;
    const dalong = side < 2 ? door.x : door.z;
    if (Math.abs(dalong - along) > margin) continue;
    const base = door.y ?? floorY;
    const dtop = base + 2.1;
    if (dtop >= y0 && base <= y1) return true;
  }

  void cross;
  return false;
}

function addWallDecal(
  buckets: Map<THREE.Material, DecalBucket>,
  room: RoomDef,
  map: MapData,
  motif: MotifDef,
  rng: Rng,
  matOf: (kind: DecalKind) => THREE.Material,
): boolean {
  const kind = pickWallKind(motif, rng);
  if (!kind) return false;
  const wide = kind === 'stripe' || kind === 'hazard' || kind === 'sign' || kind === 'poster';
  const w = wide ? 0.7 + rng.next() * 0.4 : 0.55 + rng.next() * 0.35;
  const h = kind === 'stripe' || kind === 'hazard' ? 0.22 : 0.7 + rng.next() * 0.35;

  for (let attempt = 0; attempt < 3; attempt++) {
    const side = rng.int(0, 3);
    const y = (room.floorY ?? 0) + (kind === 'stripe' || kind === 'hazard' ? 0.35 : 1.35);
    const along = (rng.next() - 0.5) * (side < 2 ? room.width : room.depth) * 0.55;
    let cx = room.x;
    let cz = room.z;
    if (side === 0 || side === 1) cx += along;
    else cz += along;

    const wall = findWallAlongFace(map.walls, side, room, cx, cz, y, h, w);
    if (!wall) continue;
    if (openingOverlapsDecal(map, side, room, cx, cz, y, w, h)) continue;

    const gap = 0.015;
    if (side === 0) {
      addBakedDecal(buckets, matOf(kind), w, h, cx, y, wall.z + wall.depth / 2 + gap, 0, 0, 0);
    } else if (side === 1) {
      addBakedDecal(buckets, matOf(kind), w, h, cx, y, wall.z - wall.depth / 2 - gap, 0, Math.PI, 0);
    } else if (side === 2) {
      addBakedDecal(buckets, matOf(kind), w, h, wall.x + wall.width / 2 + gap, y, cz, 0, Math.PI / 2, 0);
    } else {
      addBakedDecal(buckets, matOf(kind), w, h, wall.x - wall.width / 2 - gap, y, cz, 0, -Math.PI / 2, 0);
    }
    return true;
  }
  return false;
}

/** 突入側から見える外壁に、モチーフ名の看板を 1 枚だけ貼る。 */
function addFacadeSign(
  buckets: Map<THREE.Material, DecalBucket>,
  map: MapData,
  motif: MotifDef,
  matOf: (kind: DecalKind) => THREE.Material,
): void {
  const spawn = map.playerSpawn;
  let best: BoxDef | undefined;
  let bestD = Infinity;
  for (const w of map.walls) {
    if (w.material !== motif.exteriorTex) continue;
    if (w.height < 1.6) continue;
    const d = Math.hypot(w.x - spawn.x, w.z - spawn.z);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  if (!best || bestD > 28) return;
  const thinX = best.width < best.depth;
  const y = (best.y ?? 0) + Math.min(best.height - 0.4, 2.35);
  const gap = 0.06;
  if (thinX) {
    const sign = spawn.x >= best.x ? 1 : -1;
    addBakedDecal(
      buckets,
      matOf('sign'),
      1.7,
      0.62,
      best.x + sign * (best.width / 2 + gap),
      y,
      best.z,
      0,
      sign > 0 ? Math.PI / 2 : -Math.PI / 2,
      0,
      true,
    );
  } else {
    const sign = spawn.z >= best.z ? 1 : -1;
    addBakedDecal(
      buckets,
      matOf('sign'),
      1.7,
      0.62,
      best.x,
      y,
      best.z + sign * (best.depth / 2 + gap),
      0,
      sign > 0 ? 0 : Math.PI,
      0,
      true,
    );
  }
}