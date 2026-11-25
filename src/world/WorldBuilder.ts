import * as THREE from 'three';
import type { BoxDef, MapData, StairDef } from '../core/types';
import { disposeObject } from '../core/dispose';
import type { TextureLibrary, TextureName } from './Materials';
import { addMotifDecals } from './Decals';
import { buildScenery } from './Scenery';
import { motifById, type MotifDef } from './Motif';
import { buildItem, buildWindow } from './Props';
import { isLegacyGroundMap, registerGroundPolicy, type StairMark } from './Walk';
import { subtractRects, type Rect } from './generator/Layout';
import { RoomLightPool, type LightSpot } from './RoomLightPool';
import { batchStaticMeshes } from './StaticBatcher';

/** 太陽の影を描く範囲（カメラ中心の半径 m） */
const SUN_SHADOW_HALF = 28;
const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.38).normalize();

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

const KNOWN_BOX_TEXTURES: ReadonlySet<string> = new Set<TextureName>([
  'camo', 'fabric', 'metal', 'wood', 'tile', 'carpet', 'plaster', 'concrete', 'brick', 'skin', 'glass',
  'marble', 'linoleum', 'panel', 'siding', 'corrugated', 'ceiling', 'linen', 'tatami',
]);

/**
 * MapData から壁・床・天井・遮蔽物・階段・窓・置物を生成する。
 * 床と階段の上面は歩行支持面（kind floor / stair）。
 */
export class WorldBuilder {
  readonly root = new THREE.Group();
  readonly colliders: Collider[] = [];
  readonly stairs: StairMark[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly materialCache = new Map<string, THREE.MeshStandardMaterial>();
  private readonly diffuserCache = new Map<number, THREE.MeshBasicMaterial>();
  private disposed = false;
  private housingGeo?: THREE.BoxGeometry;
  private housingMat?: THREE.MeshStandardMaterial;
  private diffuserGeo?: THREE.BoxGeometry;
  /** 部屋照明。全室分の PointLight を常時置くとフラグメントシェーダが室数ぶん重くなるため、近傍だけに割り当てる。 */
  lights!: RoomLightPool;
  private sun!: THREE.DirectionalLight;
  private readonly motif: MotifDef | null;

  constructor(
    private readonly map: MapData,
    private readonly textures: TextureLibrary,
  ) {
    this.motif = map.motif && map.motif !== 'residence' ? motifById(map.motif) : null;
    this.root.name = `world:${map.id}`;
    this.buildFloorAndCeiling();
    this.buildBoxes(map.walls, 'wall', this.motif?.interiorTex ?? 'plaster', 0xc8c0b0);
    this.buildCovers();
    this.buildBoxes(map.floors, 'floor', this.motif?.groundTex ?? 'wood', 0x8a6844);
    this.buildStairs();
    const propPool = new Map<string, THREE.MeshStandardMaterial>();
    for (const w of map.windows) this.root.add(buildWindow(w, textures, propPool));
    for (const item of map.items) this.root.add(buildItem(item, textures, propPool));
    for (const m of propPool.values()) this.materials.push(m);
    if (this.motif) addMotifDecals(this.root, map, textures, (m) => this.materials.push(m));
    this.buildLights();
    // 静的ジオメトリを統合してドローコールを削減する（コライダは別管理なので見た目だけに影響）
    batchStaticMeshes(this.root, { cellSize: STATIC_BATCH_CELL });
    // 動的に位置が変わる太陽・点光源を除き、残った全静的オブジェクトのローカル行列更新を凍結する
    this.root.traverse((obj) => {
      if (obj === this.root || obj === this.sun || obj === this.sun.target || (obj as THREE.Light).isLight) return;
      obj.updateMatrix();
      obj.matrixAutoUpdate = false;
    });
  }

  /** 毎フレーム: カメラ近傍の部屋へ照明を割り当てる。 */
  update(dt: number, eye: { x: number; y: number; z: number }): void {
    this.lights.update(dt, eye);
    // 影の範囲をカメラに追従（テクセル単位にスナップしてちらつきを防ぐ）
    const texel = (SUN_SHADOW_HALF * 2) / this.sun.shadow.mapSize.x;
    const cx = Math.round(eye.x / texel) * texel;
    const cz = Math.round(eye.z / texel) * texel;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + SUN_DIR.x * 50, SUN_DIR.y * 50, cz + SUN_DIR.z * 50);
  }

  /** フルカラーの手続きテクスチャは白で乗算し、木・金属だけモチーフの tint を使う。 */
  private colorFor(name: TextureName, fallback: number): number {
    if (!this.motif) return fallback;
    return this.motif.tint[name] ?? 0xffffff;
  }

  private material(name: TextureName, color: number, doubleSide = false, opacity = 1): THREE.MeshStandardMaterial {
    const cacheKey = `${name}|${color}|${doubleSide ? 1 : 0}|${opacity}`;
    const hit = this.materialCache.get(cacheKey);
    if (hit) return hit;
    const map = this.textures.get(name) as THREE.CanvasTexture | undefined;
    const themed = this.motif !== null;
    const metal = name === 'metal' || name === 'corrugated';
    const baseRoughness = themed ? (name === 'marble' ? 0.32 : name === 'carpet' || name === 'linen' ? 0.94 : metal ? 0.42 : 0.84) : metal ? 0.4 : 0.86;
    // ガラス系以外は同一 canvas 派生の bump / roughness で肌理を出す（派生は TextureLibrary がキャッシュ・解放する）
    const textured = Boolean(map) && name !== 'glass' && name !== 'frostedGlass';
    const derived = textured && map ? this.textures.getDerivedMaps(map) : null;
    const m = new THREE.MeshStandardMaterial({
      ...(map ? { map } : {}),
      color,
      roughness: derived ? Math.max(0.05, baseRoughness - 0.05) : baseRoughness,
      metalness: themed ? (name === 'marble' ? 0.14 : metal ? 0.48 : 0.02) : metal ? 0.35 : 0.02,
      side: doubleSide || opacity < 1 ? THREE.DoubleSide : THREE.FrontSide,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
      ...(derived ? { bumpMap: derived.bumpMap, bumpScale: 0.02, roughnessMap: derived.roughnessMap } : {}),
    });
    this.materialCache.set(cacheKey, m);
    this.materials.push(m);
    return m;
  }

  /** 種類の分かる小道具は部品メッシュ、それ以外の遮蔽物は従来の箱。当たりはどちらも箱。 */
  private buildCovers(): void {
    const plain: BoxDef[] = [];
    for (const def of this.map.covers) {
      const group = buildScenery(def, (name, color, opacity) => this.material(name, color, opacity !== undefined && opacity < 1, opacity ?? 1));
      if (!group) {
        plain.push(def);
        continue;
      }
      group.userData.noShadow = true;
      group.traverse((obj) => {
        obj.castShadow = false;
        obj.receiveShadow = true;
        obj.userData.noShadow = true;
      });
      this.root.add(group);
      this.colliders.push({ kind: 'cover', aabb: boxToAABB(def) });
    }
    this.buildBoxes(plain, 'cover', 'wood', 0x8b5a2b);
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
      const groundName = this.motif?.groundTex ?? 'concrete';
      const groundMat = this.material(groundName, this.colorFor(groundName, 0x555c64));
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
    const ceilName = this.motif?.ceilingTex ?? 'plaster';
    const roofName = this.motif?.roofTex ?? 'concrete';
    const ceilMat = this.material(ceilName, this.colorFor(ceilName, 0xd5d0c6), true);
    const roofMat = this.material(roofName, this.colorFor(roofName, 0x383e46));
    const placedCeilings = new Map<number, Rect[]>();
    const placedRoofs = new Map<number, Rect[]>();

    for (const room of map.rooms) {
      if (room.outdoor) continue;
      const floorY = room.floorY ?? 0;

      if (addIndoorFloors) {
        const isTile = tileIds.some((k) => room.id.includes(k));
        const slabGeo = new THREE.BoxGeometry(room.width, 0.02, room.depth);
        alignBoxTexture(slabGeo, room.x, floorY + 0.01, room.z, 0);
        const floorName: TextureName = this.motif ? (isTile ? 'tile' : this.motif.floorTex.private) : isTile ? 'tile' : 'wood';
        const slab = new THREE.Mesh(slabGeo, this.material(floorName, this.colorFor(floorName, isTile ? 0xa5abb0 : 0x987450)));
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
      const safe = def.material !== undefined && KNOWN_BOX_TEXTURES.has(def.material) ? (def.material as TextureName) : fallback;
      const geometry = new THREE.BoxGeometry(def.width, def.height, def.depth);
      const y = (def.y ?? 0) + def.height / 2;
      const yaw = (def.yaw ?? 0) * DEG2RAD;
      if (kind === 'wall' || kind === 'floor') alignBoxTexture(geometry, def.x, y, def.z, yaw);
      const baseColor = kind === 'cover' && def.material ? 0xb7b2a9 : color;
      const mesh = new THREE.Mesh(geometry, this.material(safe, this.colorFor(safe, baseColor)));
      mesh.position.set(def.x, y, def.z);
      mesh.rotation.y = yaw;
      mesh.name = kind;
      if (kind === 'cover' && def.material) {
        const detail = (w: number, h: number, d: number, x: number, y: number, z: number, tint: number) => {
          const trim = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), this.material(safe, tint));
          trim.position.set(x,y,z);
          mesh.add(trim);
        };
        const hi = this.motif ? 0xf2f2f2 : 0xb1af9e;
        const mid = this.motif ? 0xd0d0d0 : 0x989186;
        if (safe === 'metal' || safe === 'corrugated') {
          const count = Math.max(2, Math.round(def.height / 0.36));
          const row = def.height / count;
          for (let i = 0; i < count; i++) {
            const center = -def.height / 2 + (i + 0.5) * row;
            detail(def.width * 0.92, row * 0.92, 0.018, 0, center, def.depth / 2, this.colorFor(safe, 0x9a9e99));
            detail(0.16, 0.023, 0.032, 0, center + row * 0.23, def.depth / 2 + 0.016, this.colorFor(safe, 0x555957));
          }
        } else if (safe === 'fabric' || safe === 'linen') {
          detail(def.width * 0.96, 0.13, def.depth * 0.93, 0, def.height / 2 - 0.045, 0, hi);
          detail(def.width, 0.28, def.depth * 0.16, 0, def.height / 2 + 0.06, -def.depth * 0.41, mid);
        } else if (safe === 'wood' || safe === 'siding') {
          for (const side of [-1,1]) {
            detail(def.width + 0.015, 0.067, def.depth + 0.015, 0, side * (def.height / 2 - 0.07), 0, this.colorFor('wood', 0xb8a489));
          }
        } else if (safe === 'marble') {
          detail(def.width * 0.96, 0.06, def.depth * 0.96, 0, def.height / 2 - 0.04, 0, 0xffffff);
          detail(def.width * 0.9, 0.04, def.depth * 0.08, 0, def.height / 2 - 0.02, def.depth * 0.42, 0xf4f1ea);
        } else if (safe === 'concrete') {
          detail(def.width * 0.92, 0.05, def.depth * 0.04, 0, 0, def.depth / 2, 0xffffff);
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
    const stairName = this.motif?.stairTex ?? 'wood';
    const wood = this.material(stairName, this.colorFor(stairName, 0x7a5432));
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
      const railMat = this.material('metal', this.colorFor('metal', 0x6b645c));
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
    // 環境光は控えめにして、部屋照明の減衰と影で奥行きを作る
    const atm = this.motif?.atmosphere;
    this.root.add(new THREE.HemisphereLight(atm?.hemiSky ?? 0xb8c6dc, atm?.hemiGround ?? 0x2a2620, atm?.hemiIntensity ?? 0.5));
    // 太陽は影付き: 屋外と窓から差す光だけが明るくなり、屋内は部屋照明が主になる
    const sun = new THREE.DirectionalLight(atm?.sunColor ?? 0xffe6c4, atm?.sunIntensity ?? 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -SUN_SHADOW_HALF;
    cam.right = SUN_SHADOW_HALF;
    cam.top = SUN_SHADOW_HALF;
    cam.bottom = -SUN_SHADOW_HALF;
    cam.near = 1;
    cam.far = 120;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.04;
    this.root.add(sun, sun.target);
    this.sun = sun;
    const story = this.map.storyHeight ?? this.map.ceilingHeight;
    const spots: LightSpot[] = [];
    // 部屋ごとに色温度を少し振る（白熱灯寄り / 蛍光灯寄り）
    const tints = atm?.roomLights ?? [0xffd9a8, 0xffe6c4, 0xf2f0ea, 0xffdcb4, 0xe6eef8];
    const roomIntensity = atm?.roomIntensity ?? 11;
    this.map.rooms.forEach((room, idx) => {
      const floorY = room.floorY ?? 0;
      if (room.outdoor) {
        spots.push({
          x: room.x, y: floorY + 4.8, z: room.z,
          color: 0xc8d8f0, intensity: 7, distance: Math.max(room.width, room.depth) * 1.9, decay: 1.3,
        });
        return;
      }
      const roomCeilY =
        room.ceilingY ??
        (this.map.ceilingHeight > floorY + 0.5 ? this.map.ceilingHeight : floorY + story);
      const lightY = Math.min(floorY + story, roomCeilY) - 0.35;
      spots.push({
        x: room.x, y: lightY, z: room.z,
        color: tints[idx % tints.length]!, intensity: roomIntensity, distance: Math.max(room.width, room.depth) * 2.1, decay: 1.7,
      });
      const housing = new THREE.Mesh(this.housingGeo ??= new THREE.BoxGeometry(1.05, 0.09, 0.27), this.housingMat ??= this.material('metal', this.colorFor('metal', 0x74767a)));
      housing.position.set(room.x, lightY + 0.24, room.z);
      const tint = tints[idx % tints.length] ?? 0xffebcc;
      const dimmed = (((tint >> 16) & 255) * 0.82 << 16) | (((tint >> 8) & 255) * 0.82 << 8) | ((tint & 255) * 0.82);
      let diffuserMat = this.diffuserCache.get(dimmed);
      if (!diffuserMat) {
        diffuserMat = new THREE.MeshBasicMaterial({ color: dimmed });
        this.diffuserCache.set(dimmed, diffuserMat);
        this.materials.push(diffuserMat);
      }
      const diffuser = new THREE.Mesh(this.diffuserGeo ??= new THREE.BoxGeometry(0.94, 0.028, 0.2), diffuserMat);
      diffuser.position.y = -0.054;
      housing.add(diffuser);
      this.root.add(housing);
    });
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
    this.materialCache.clear();
    this.diffuserCache.clear();
  }
}
