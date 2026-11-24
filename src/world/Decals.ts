import * as THREE from 'three';
import type { BoxDef, MapData, RoomDef } from '../core/types';
import type { TextureLibrary } from './Materials';
import { motifById, type DecalKind, type MotifDef } from './Motif';
import { Rng } from './generator/Rng';

const MAX_DECALS = 72;

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
  if (!map.motif || map.seed === undefined) return;
  const motif = motifById(map.motif);
  const rng = new Rng((map.seed ^ 0x51edec01) >>> 0);
  const mats = new Map<DecalKind, THREE.MeshStandardMaterial>();
  const matOf = (kind: DecalKind): THREE.MeshStandardMaterial => {
    const hit = mats.get(kind);
    if (hit) return hit;
    const m = new THREE.MeshStandardMaterial({
      map: textures.getDecal(kind),
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    mats.set(kind, m);
    keep(m);
    return m;
  };

  let placed = 0;
  const rooms = map.rooms.filter((r) => !r.outdoor && r.width > 1.8 && r.depth > 1.8);
  for (const room of rooms) {
    if (placed >= MAX_DECALS) break;
    if (rng.chance(0.8)) {
      addFloorDecal(root, room, motif, rng, matOf);
      placed++;
    }
    if (placed < MAX_DECALS && rng.chance(0.72)) {
      addWallDecal(root, room, motif, rng, matOf);
      placed++;
    }
  }
  addFacadeSign(root, map, motif, matOf);
}

function pickKind(motif: MotifDef, rng: Rng): DecalKind {
  return rng.pick(motif.decals) ?? motif.decals[0] ?? 'scuff';
}

function addFloorDecal(
  root: THREE.Object3D,
  room: RoomDef,
  motif: MotifDef,
  rng: Rng,
  matOf: (kind: DecalKind) => THREE.Material,
): void {
  const kind = pickKind(motif, rng);
  const w = 0.55 + rng.next() * 0.9;
  const d = kind === 'stripe' || kind === 'hazard' ? 0.28 : 0.45 + rng.next() * 0.7;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), matOf(kind));
  const ix = room.width / 2 - 0.7;
  const iz = room.depth / 2 - 0.7;
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = rng.next() * Math.PI * 2;
  mesh.position.set(
    room.x + (rng.next() - 0.5) * Math.max(0.2, ix * 1.2),
    (room.floorY ?? 0) + 0.025,
    room.z + (rng.next() - 0.5) * Math.max(0.2, iz * 1.2),
  );
  mesh.name = 'decal';
  root.add(mesh);
}

function addWallDecal(
  root: THREE.Object3D,
  room: RoomDef,
  motif: MotifDef,
  rng: Rng,
  matOf: (kind: DecalKind) => THREE.Material,
): void {
  const kind = pickKind(motif, rng);
  const wide = kind === 'stripe' || kind === 'hazard' || kind === 'sign' || kind === 'poster';
  const w = wide ? 0.9 + rng.next() * 0.6 : 0.55 + rng.next() * 0.35;
  const h = kind === 'stripe' || kind === 'hazard' ? 0.22 : 0.7 + rng.next() * 0.35;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), matOf(kind));
  const side = rng.int(0, 3);
  const y = (room.floorY ?? 0) + (kind === 'stripe' || kind === 'hazard' ? 0.35 : 1.35);
  const along = (rng.next() - 0.5) * (side < 2 ? room.width : room.depth) * 0.55;
  const inset = 0.08;
  if (side === 0) {
    mesh.position.set(room.x + along, y, room.z - room.depth / 2 + inset);
  } else if (side === 1) {
    mesh.position.set(room.x + along, y, room.z + room.depth / 2 - inset);
    mesh.rotation.y = Math.PI;
  } else if (side === 2) {
    mesh.position.set(room.x - room.width / 2 + inset, y, room.z + along);
    mesh.rotation.y = Math.PI / 2;
  } else {
    mesh.position.set(room.x + room.width / 2 - inset, y, room.z + along);
    mesh.rotation.y = -Math.PI / 2;
  }
  mesh.name = 'decal';
  root.add(mesh);
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
