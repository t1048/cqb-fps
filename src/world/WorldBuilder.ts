import * as THREE from 'three';
import type { BoxDef, MapData, StairDef } from '../core/types';
import { disposeObject } from '../core/dispose';
import type { TextureLibrary, TextureName } from './Materials';
import { buildItem, buildWindow } from './Props';
import { isLegacyGroundMap, registerGroundPolicy, type StairMark } from './Walk';
import { subtractRects, type Rect } from './generator/Layout';
import { RoomLightPool, type LightSpot } from './RoomLightPool';
import { batchStaticMeshes } from './StaticBatcher';

/** 静的メッシュ統合の空間セル（m）。大きいほどドローコールが減り、小さいほどカリングが効く。 */
const STATIC_BATCH_CELL = 16;

/** XZ 平面 + 高さ範囲の軸平行ボックス（衝突判定用）。ワールド座標。 */
export interface AABB {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export type ColliderKind = 'wall' | 'cover' | 'door' | 'floor' | 'stair' | 'ceiling';

export interface Collider {
  kind: ColliderKind;
  aabb: AABB;
  /**
   * 動くコライダ（ドア板）が取り得る XZ 範囲の保守的な外接矩形。
   * 空間索引（ColliderIndex）はこれがあればこの範囲で登録し、無い動的コライダは常に候補へ含める。
   */
  sweep?: { minX: number; minZ: number; maxX: number; maxZ: number };
}

const DEG2RAD = Math.PI / 180;
const TEXTURE_TILE_METERS = 2;
/** 固定・旧マップの屋外地盤コライダの厚さ（上面 y=0）。 */
const GROUND_THICKNESS = 0.22;
/** 天井スラブの厚さと、部屋矩形からのはみ出し量。 */
const CEILING_THICKNESS = 0.22;
const CEILING_OVERHANG = 0.16;
/** 直上の床スラブとみなす、スラブ底面と天井下面の高さ差の上限（m）。 */
const UPPER_SLAB_TOLERANCE = 0.35;
/** 上階の屋内室とみなす床高の範囲（天井下面から上方向, m）。 */
const UPPER_ROOM_ABOVE_CEIL = 0.6;
/** これより細い重なり（天井のはみ出し端など）は天井の切り欠きとして扱わない（m）。 */
const MIN_CUT = 0.05;
/** 階段の進入・退出点を段の外側へ置く距離（m）。 */
const STAIR_APPROACH = 0.45;

function aabbRect(a: AABB): Rect {
  return { x0: a.min.x, z0: a.min.z, x1: a.max.x, z1: a.max.z };
}

/** 同じ向きの面で、部材の境界をまたいでも模様の位相と縮尺をそろえる。 */
function alignBoxTexture(geometry: THREE.BoxGeometry, x: number, y: number, z: number, yaw: number): void {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const localX = x * Math.cos(yaw) - z * Math.sin(yaw);
  const localZ = x * Math.sin(yaw) + z * Math.cos(yaw);
  for (let i = 0; i < position.count; i++) {
    const px = localX + position.getX(i);
    const py = y + position.getY(i);
    const pz = localZ + position.getZ(i);
    const horizontal = Math.abs(normal.getY(i)) > 0.5;
    const u = Math.abs(normal.getX(i)) > 0.5 ? pz : px;
    uv.setXY(i, u / TEXTURE_TILE_METERS, (horizontal ? -pz : py) / TEXTURE_TILE_METERS);
  }
}

/** BoxDef（yaw 回転・底面 y 込み）を内包するワールド AABB。回転箱は外接 AABB で近似。 */
export function boxToAABB(def: BoxDef): AABB {
  const yaw = (def.yaw ?? 0) * DEG2RAD;
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const hx = (def.width * c + def.depth * s) / 2;
  const hz = (def.width * s + def.depth * c) / 2;
  const y0 = def.y ?? 0;
  return {
    min: { x: def.x - hx, y: y0, z: def.z - hz },
    max: { x: def.x + hx, y: y0 + def.height, z: def.z + hz },
  };
}

/**
 * MapData から壁・床・天井・遮蔽物・階段・窓・置物を生成する。
 * 床と階段の上面は歩行支持面（kind floor / stair）。
 */
export class WorldBuilder {
  readonly root = new THREE.Group();
  readonly colliders: Collider[] = [];
  readonly stairs: StairMark[] = [];
  private readonly materials: THREE.Material[] = [];
  private disposed = false;
  private housingGeo?: THREE.BoxGeometry;
  private housingMat?: THREE.MeshStandardMaterial;
  private diffuserGeo?: THREE.BoxGeometry;
  private diffuserMat?: THREE.MeshBasicMaterial;
  /** 部屋照明。全室分の PointLight を常時置くとフラグメントシェーダが室数ぶん重くなるため、近傍だけに割り当てる。 */
  lights!: RoomLightPool;

  constructor(
    private readonly map: MapData,
    private readonly textures: TextureLibrary,
  ) {
    this.root.name = `world:${map.id}`;
    this.buildFloorAndCeiling();
    this.buildBoxes(map.walls, 'wall', 'plaster', 0xc8c0b0);
    this.buildBoxes(map.covers, 'cover', 'wood', 0x8b5a2b);
    this.buildBoxes(map.floors, 'floor', 'wood', 0x8a6844);
    this.buildStairs();
    for (const w of map.windows) this.root.add(buildWindow(w, textures));
    for (const item of map.items) this.root.add(buildItem(item, textures));
    this.buildLights();
    // 静的ジオメトリを統合してドローコールを削減する（コライダは別管理なので見た目だけに影響）
    batchStaticMeshes(this.root, { cellSize: STATIC_BATCH_CELL });
  }

  /** 毎フレーム: カメラ近傍の部屋へ照明を割り当てる。 */
  update(dt: number, eye: { x: number; y: number; z: number }): void {
    this.lights.update(dt, eye);
  }

  private material(name: TextureName, color: number, doubleSide = false): THREE.MeshStandardMaterial {
    const map = this.textures.get(name);
    const m = new THREE.MeshStandardMaterial({
      map,
      color,
      roughness: name === 'metal' ? 0.4 : 0.86,
      metalness: name === 'metal' ? 0.35 : 0.02,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
    this.materials.push(m);
    return m;
  }

  private buildFloorAndCeiling(): void {
    const map = this.map;
    const { width, depth } = map.floor;
    const hasBasement = map.rooms.some((r) => (r.floorY ?? 0) < 0);
    registerGroundPolicy(this.colliders, isLegacyGroundMap(map));

    if (!hasBasement) {
      const groundHoles: Rect[] = [];
      for (const f of map.floors) {
        const a = boxToAABB(f);
        if (a.min.y > 0.05 || a.max.y < -0.05) continue;
        groundHoles.push(aabbRect(a));
      }
      const groundRects = subtractRects(
        { x0: -width / 2, z0: -depth / 2, x1: width / 2, z1: depth / 2 },
        groundHoles,
      );
      const groundMat = this.material('concrete', 0x555c64);
      for (const gr of groundRects) {
        const gw = gr.x1 - gr.x0;
        const gd = gr.z1 - gr.z0;
        if (gw < 0.02 || gd < 0.02) continue;
        const gx = (gr.x0 + gr.x1) / 2;
        const gz = (gr.z0 + gr.z1) / 2;
        const plane = new THREE.PlaneGeometry(gw, gd);
        const { position, uv } = plane.attributes;
        for (let i = 0; i < position.count; i++) {
          uv.setXY(i, (gx + position.getX(i)) / TEXTURE_TILE_METERS, (gz + position.getY(i)) / TEXTURE_TILE_METERS);
        }
        const ground = new THREE.Mesh(plane, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(gx, 0, gz);
        ground.name = 'floor';
        this.root.add(ground);
      }
      // 屋外地盤（上面 y=0）のスラブが無い固定・旧マップは、敷地範囲に実 floor コライダを登録する
      const hasGroundSlab = map.floors.some((f) => Math.abs((f.y ?? 0) + f.height) < 1e-3);
      if (!hasGroundSlab) {
        this.colliders.push({
          kind: 'floor',
          aabb: {
            min: { x: -width / 2, y: -GROUND_THICKNESS, z: -depth / 2 },
            max: { x: width / 2, y: 0, z: depth / 2 },
          },
        });
      }
    }
    // 地下室ありでは y=0 の全面地面を置かず、map.floors（階段穴を抜いた 1F スラブ）に委ねる

    const tileIds = ['genkan', 'foyer', 'entry', 'kitchen', 'bathroom', 'bath', 'washroom', 'toilet', 'lobby', 'reception'];
    const addIndoorFloors = map.floors.length === 0;
    const ceilMat = this.material('plaster', 0xd5d0c6, true);
    const roofMat = this.material('concrete', 0x383e46);
    const placedCeilings = new Map<number, Rect[]>();
    const placedRoofs = new Map<number, Rect[]>();

    for (const room of map.rooms) {
      if (room.outdoor) continue;
      const floorY = room.floorY ?? 0;

      if (addIndoorFloors) {
        const isTile = tileIds.some((k) => room.id.includes(k));
        const slabGeo = new THREE.BoxGeometry(room.width, 0.02, room.depth);
        alignBoxTexture(slabGeo, room.x, floorY + 0.01, room.z, 0);
        const slab = new THREE.Mesh(slabGeo, this.material(isTile ? 'tile' : 'wood', isTile ? 0xa5abb0 : 0x987450));
        slab.position.set(room.x, floorY + 0.01, room.z);
        slab.name = `floor:${room.id}`;
        this.root.add(slab);
      }

      const fallbackCeilY =
        map.ceilingHeight > floorY + 0.5
          ? map.ceilingHeight
          : floorY + (map.storyHeight ?? map.ceilingHeight);
      const ceilY = room.ceilingY ?? fallbackCeilY;
      // 室の高さ範囲の途中に上階の床スラブがある（固定マップの 1F 室が建物天井まで届く）場合は従来どおり天井を作らない
      const hasMidSlab = map.floors.some((f) => {
        const fy = f.y ?? 0;
        return (
          fy >= floorY + 1.5 &&
          fy < ceilY - UPPER_SLAB_TOLERANCE &&
          Math.abs(room.x - f.x) <= f.width / 2 &&
          Math.abs(room.z - f.z) <= f.depth / 2
        );
      });
      if (hasMidSlab) continue;

      const levelKey = Math.round(ceilY * 100);
      const base: Rect = {
        x0: room.x - room.width / 2 - CEILING_OVERHANG,
        z0: room.z - room.depth / 2 - CEILING_OVERHANG,
        x1: room.x + room.width / 2 + CEILING_OVERHANG,
        z1: room.z + room.depth / 2 + CEILING_OVERHANG,
      };
      const cutouts = this.ceilingCutouts(base, floorY, ceilY);
      const prevCeils = placedCeilings.get(levelKey) ?? [];
      for (const piece of subtractRects(base, [...cutouts, ...prevCeils])) {
        if (piece.x1 - piece.x0 < 0.02 || piece.z1 - piece.z0 < 0.02) continue;
        this.addCeilingMesh(room.id, piece, ceilY, ceilMat);
        prevCeils.push(piece);
      }
      placedCeilings.set(levelKey, prevCeils);

      const roofBase: Rect = {
        x0: base.x0 - 0.04,
        z0: base.z0 - 0.04,
        x1: base.x1 + 0.04,
        z1: base.z1 + 0.04,
      };
      const roofCutouts = this.ceilingCutouts(roofBase, floorY, ceilY);
      const prevRoofs = placedRoofs.get(levelKey) ?? [];
      for (const piece of subtractRects(roofBase, [...roofCutouts, ...prevRoofs])) {
        if (piece.x1 - piece.x0 < 0.02 || piece.z1 - piece.z0 < 0.02) continue;
        this.addRoofMesh(room.id, piece, ceilY, roofMat);
        prevRoofs.push(piece);
      }
      placedRoofs.set(levelKey, prevRoofs);
    }
  }

  /**
   * 天井から差し引く矩形: 直上の床スラブ、上階の屋内室、天井を貫通する階段。
   * 階段穴・吹き抜けを残余天井で塞がない（上階室と階段の範囲は天井を作らず、上階スラブの穴がそのまま開口になる）。
   */
  private ceilingCutouts(base: Rect, floorY: number, ceilY: number): Rect[] {
    const map = this.map;
    const raw: Rect[] = [];
    for (const f of map.floors) {
      if (Math.abs((f.y ?? 0) - ceilY) <= UPPER_SLAB_TOLERANCE) raw.push(aabbRect(boxToAABB(f)));
    }
    for (const u of map.rooms) {
      if (u.outdoor) continue;
      const uy = u.floorY ?? 0;
      if (uy <= floorY + 1.5 || uy < ceilY - 0.05 || uy > ceilY + UPPER_ROOM_ABOVE_CEIL) continue;
      raw.push({ x0: u.x - u.width / 2, z0: u.z - u.depth / 2, x1: u.x + u.width / 2, z1: u.z + u.depth / 2 });
    }
    for (const st of map.stairs) {
      const lo = st.y ?? 0;
      const hi = lo + st.steps * st.rise;
      if (lo >= ceilY || hi <= ceilY + 0.01) continue;
      raw.push(aabbRect(boxToAABB({ x: st.x, z: st.z, width: st.width, depth: st.steps * st.run, height: 1, yaw: st.yaw })));
    }
    // はみ出し端の細い重なりは切り欠きにしない（固定マップの天井形状を変えない）
    return raw.filter((c) => {
      const w = Math.min(base.x1, c.x1) - Math.max(base.x0, c.x0);
      const d = Math.min(base.z1, c.z1) - Math.max(base.z0, c.z0);
      return w >= MIN_CUT && d >= MIN_CUT;
    });
  }

  private addCeilingMesh(roomId: string, r: Rect, ceilY: number, mat: THREE.Material): void {
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    if (w < 0.01 || d < 0.01) return;
    const ceilDef: BoxDef = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, y: ceilY, width: w, height: CEILING_THICKNESS, depth: d };
    const ceilGeo = new THREE.BoxGeometry(ceilDef.width, ceilDef.height, ceilDef.depth);
    alignBoxTexture(ceilGeo, ceilDef.x, ceilY + ceilDef.height / 2, ceilDef.z, 0);
    const ceilMesh = new THREE.Mesh(ceilGeo, mat);
    ceilMesh.position.set(ceilDef.x, ceilY + ceilDef.height / 2, ceilDef.z);
    ceilMesh.name = `ceiling:${roomId}`;
    this.root.add(ceilMesh);
    this.colliders.push({ kind: 'ceiling', aabb: boxToAABB(ceilDef) });
  }

  private addRoofMesh(roomId: string, r: Rect, ceilY: number, mat: THREE.Material): void {
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    if (w < 0.01 || d < 0.01) return;
    const rx = (r.x0 + r.x1) / 2;
    const rz = (r.z0 + r.z1) / 2;
    const roofGeo = new THREE.BoxGeometry(w, 0.08, d);
    alignBoxTexture(roofGeo, rx, ceilY + CEILING_THICKNESS + 0.04, rz, 0);
    const roofMesh = new THREE.Mesh(roofGeo, mat);
    roofMesh.position.set(rx, ceilY + CEILING_THICKNESS + 0.04, rz);
    roofMesh.name = `roof:${roomId}`;
    this.root.add(roofMesh);
  }

  private buildBoxes(defs: readonly BoxDef[], kind: ColliderKind, fallback: TextureName, color: number): void {
    for (const def of defs) {
      const names: readonly TextureName[] = ['camo', 'fabric', 'metal', 'wood', 'tile', 'carpet', 'plaster', 'concrete', 'brick', 'skin', 'glass'];
      const safe = names.find((n) => n === def.material) ?? fallback;
      const geometry = new THREE.BoxGeometry(def.width, def.height, def.depth);
      const y = (def.y ?? 0) + def.height / 2;
      const yaw = (def.yaw ?? 0) * DEG2RAD;
      if (kind === 'wall' || kind === 'floor') alignBoxTexture(geometry, def.x, y, def.z, yaw);
      const mesh = new THREE.Mesh(geometry, this.material(safe, kind === 'cover' && def.material ? 0xb7b2a9 : color));
      mesh.position.set(def.x, y, def.z);
      mesh.rotation.y = yaw;
      mesh.name = kind;
      if (kind === 'cover' && def.material) {
        const detail = (w: number, h: number, d: number, x: number, y: number, z: number, tint: number) => {
          const trim = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), this.material(safe, tint));
          trim.position.set(x,y,z);
          mesh.add(trim);
        };
        if (safe === 'metal') {
          const count = Math.max(2, Math.round(def.height / 0.36));
          const row = def.height / count;
          for (let i = 0; i < count; i++) {
            const center = -def.height / 2 + (i + 0.5) * row;
            detail(def.width * 0.92, row * 0.92, 0.018, 0, center, def.depth / 2, 0x9a9e99);
            detail(0.16, 0.023, 0.032, 0, center + row * 0.23, def.depth / 2 + 0.016, 0x555957);
          }
        } else if (safe === 'fabric') {
          detail(def.width * 0.96, 0.13, def.depth * 0.93, 0, def.height / 2 - 0.045, 0, 0xb1af9e);
          detail(def.width, 0.28, def.depth * 0.16, 0, def.height / 2 + 0.06, -def.depth * 0.41, 0x989186);
        } else if (safe === 'wood') {
          for (const side of [-1,1]) {
            detail(def.width + 0.015, 0.067, def.depth + 0.015, 0, side * (def.height / 2 - 0.07), 0, 0xb8a489);
          }
        }
      }
      this.root.add(mesh);
      this.colliders.push({ kind, aabb: boxToAABB(def) });
    }
  }

  private buildStairs(): void {
    for (const def of this.map.stairs) this.addStair(def);
  }

  private addStair(def: StairDef): void {
    const yaw = def.yaw * DEG2RAD;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const base = def.y ?? 0;
    const total = def.steps * def.run;
    const wood = this.material('wood', 0x7a5432);
    let low = { x: def.x, z: def.z, y: base };
    let high = { x: def.x, z: def.z, y: base };
    for (let i = 0; i < def.steps; i++) {
      const t = -total / 2 + def.run * (i + 0.5);
      const cx = def.x + fx * t;
      const cz = def.z + fz * t;
      const top = base + def.rise * (i + 1);
      const height = def.rise * (i + 1);
      const box: BoxDef = { x: cx, z: cz, y: base, width: def.width, height, depth: def.run, yaw: def.yaw };
      const geometry = new THREE.BoxGeometry(def.width, height, def.run);
      alignBoxTexture(geometry, cx, base + height / 2, cz, yaw);
      const mesh = new THREE.Mesh(geometry, wood);
      mesh.position.set(cx, base + height / 2, cz);
      mesh.rotation.y = yaw;
      mesh.name = 'stair';
      this.root.add(mesh);
      this.colliders.push({ kind: 'stair', aabb: boxToAABB(box) });
      if (i === 0) low = { x: cx, z: cz, y: top };
      if (i === def.steps - 1) high = { x: cx, z: cz, y: top };
    }
    const railLength = Math.hypot(high.x - low.x, high.y - low.y, high.z - low.z);
    if (railLength > 0) {
      const railHeight = 0.82;
      const railMat = this.material('metal', 0x6b645c);
      const geometry = new THREE.BoxGeometry(0.032, 0.032, railLength);
      const postGeo = new THREE.BoxGeometry(0.028, railHeight, 0.028);
      for (const side of [-1, 1]) {
        const ox = rx * side * (def.width / 2);
        const oz = rz * side * (def.width / 2);
        const rail = new THREE.Mesh(geometry, railMat);
        rail.position.set((low.x + high.x) / 2 + ox, (low.y + high.y) / 2 + railHeight, (low.z + high.z) / 2 + oz);
        rail.lookAt(high.x + ox, high.y + railHeight, high.z + oz);
        rail.name = 'rail';
        this.root.add(rail);
        for (const t of [0, 0.5, 1]) {
          const post = new THREE.Mesh(postGeo, railMat);
          post.position.set(
            low.x + (high.x - low.x) * t + ox,
            low.y + (high.y - low.y) * t + railHeight / 2,
            low.z + (high.z - low.z) * t + oz,
          );
          post.name = 'rail-post';
          this.root.add(post);
        }
      }
    }
    const reach = total / 2 + STAIR_APPROACH;
    this.stairs.push({
      id: def.id,
      lowX: low.x,
      lowZ: low.z,
      lowY: low.y,
      highX: high.x,
      highZ: high.z,
      highY: high.y,
      baseY: base,
      topY: high.y,
      approachLow: { x: def.x - fx * reach, z: def.z - fz * reach },
      approachHigh: { x: def.x + fx * reach, z: def.z + fz * reach },
    });
  }

  private buildLights(): void {
    this.root.add(new THREE.HemisphereLight(0xfff4e4, 0x3a4038, 1.05));
    const sun = new THREE.DirectionalLight(0xfff1d6, 0.75);
    sun.position.set(12, 24, 10);
    this.root.add(sun);
    const story = this.map.storyHeight ?? this.map.ceilingHeight;
    const spots: LightSpot[] = [];
    for (const room of this.map.rooms) {
      const floorY = room.floorY ?? 0;
      if (room.outdoor) {
        spots.push({
          x: room.x, y: floorY + 4.8, z: room.z,
          color: 0xdce8f8, intensity: 6.5, distance: Math.max(room.width, room.depth) * 1.9, decay: 1.2,
        });
        continue;
      }
      const roomCeilY =
        room.ceilingY ??
        (this.map.ceilingHeight > floorY + 0.5 ? this.map.ceilingHeight : floorY + story);
      const lightY = Math.min(floorY + story, roomCeilY) - 0.35;
      spots.push({
        x: room.x, y: lightY, z: room.z,
        color: 0xfff2d8, intensity: 5.5, distance: Math.max(room.width, room.depth) * 1.6, decay: 1.4,
      });
      const housing = new THREE.Mesh(this.housingGeo ??= new THREE.BoxGeometry(1.05, 0.09, 0.27), this.housingMat ??= this.material('metal', 0x74767a));
      housing.position.set(room.x, lightY + 0.24, room.z);
      const diffuser = new THREE.Mesh(this.diffuserGeo ??= new THREE.BoxGeometry(0.94, 0.028, 0.2),
        this.diffuserMat ??= new THREE.MeshBasicMaterial({ color: 0xffebcc }));
      diffuser.position.y = -0.054;
      housing.add(diffuser);
      this.root.add(housing);
    }
    this.lights = new RoomLightPool(spots, this.root);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.colliders.length = 0;
    this.stairs.length = 0;
    disposeObject(this.root);
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}
