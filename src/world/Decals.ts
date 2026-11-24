import * as THREE from 'three';
import type { BoxDef, MapData, RoomDef } from '../core/types';
import type { TextureLibrary } from './Materials';
import { motifById, type DecalKind, type MotifDef } from './Motif';
import { Rng } from './generator/Rng';

const MAX_DECALS = 36;

const FLOOR_KINDS: ReadonlySet<DecalKind> = new Set(['blood', 'dirt', 'scuff', 'hazard', 'stripe']);
const WALL_KINDS: ReadonlySet<DecalKind> = new Set([
  'poster', 'graffiti', 'sign', 'vault', 'medcross', 'stripe', 'hazard', 'scuff',
]);

/**
 * 部屋の床と壁にモチーフ用デカールを貼る。コライダは足さない。
 * テクスチャは TextureLibrary にキャッシュし、種類ごとにマテリアルを共有する。
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
  const matOfFloor = (kind: DecalKind): THREE.MeshStandardMaterial => {
    const hit = floorMats.get(kind);
    if (hit) return hit;
    const m = new THREE.MeshStandardMaterial({
      map: textures.getDecal(kind),
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
    const m = new THREE.MeshStandardMaterial({
      map: textures.getDecal(kind),
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
      if (addFloorDecal(root, room, map, motif, rng, matOfFloor)) placed++;
    }
    if (placed < MAX_DECALS && rng.chance(0.5)) {
      if (addWallDecal(root, room, map, motif, rng, matOfWall)) placed++;
    }
  }
  addFacadeSign(root, map, motif, matOfWall);
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
  root: THREE.Object3D,
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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), matOf(kind));
  const ix = room.width / 2 - 0.7;
  const iz = room.depth / 2 - 0.7;
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = rng.next() * Math.PI * 2;
  const px = room.x + (rng.next() - 0.5) * Math.max(0.2, ix * 1.2);
  const pz = room.z + (rng.next() - 0.5) * Math.max(0.2, iz * 1.2);
  const spawn = map.playerSpawn;
  if (Math.hypot(px - spawn.x, pz - spawn.z) < 1.5) return false;
  mesh.position.set(px, (room.floorY ?? 0) + 0.025, pz);
  mesh.name = 'decal';
  root.add(mesh);
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
  root: THREE.Object3D,
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

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), matOf(kind));
    const gap = 0.015;
    if (side === 0) {
      mesh.position.set(cx, y, wall.z + wall.depth / 2 + gap);
    } else if (side === 1) {
      mesh.position.set(cx, y, wall.z - wall.depth / 2 - gap);
      mesh.rotation.y = Math.PI;
    } else if (side === 2) {
      mesh.position.set(wall.x + wall.width / 2 + gap, y, cz);
      mesh.rotation.y = Math.PI / 2;
    } else {
      mesh.position.set(wall.x - wall.width / 2 - gap, y, cz);
      mesh.rotation.y = -Math.PI / 2;
    }
    mesh.name = 'decal';
    root.add(mesh);
    return true;
  }
  return false;
}

/** 突入側から見える外壁に、モチーフ名の看板を 1 枚だけ貼る。 */
function addFacadeSign(
  root: THREE.Object3D,
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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.62), matOf('sign'));
  const y = (best.y ?? 0) + Math.min(best.height - 0.4, 2.35);
  const gap = 0.06;
  if (thinX) {
    const sign = spawn.x >= best.x ? 1 : -1;
    mesh.position.set(best.x + sign * (best.width / 2 + gap), y, best.z);
    mesh.rotation.y = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    const sign = spawn.z >= best.z ? 1 : -1;
    mesh.position.set(best.x, y, best.z + sign * (best.depth / 2 + gap));
    mesh.rotation.y = sign > 0 ? 0 : Math.PI;
  }
  mesh.name = 'decal-sign';
  root.add(mesh);
}