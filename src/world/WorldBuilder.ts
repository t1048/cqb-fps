import * as THREE from 'three';
import type { BoxDef, MapData, RoomDef, StairDef } from '../core/types';
import { disposeObject } from '../core/dispose';
import type { TextureLibrary, TextureName } from './Materials';
import { addMotifDecals } from './Decals';
import { buildScenery } from './Scenery';
import { motifById, roleOf, type MotifDef } from './Motif';
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

/** 壁面の向こう側を調べるときに面から離す距離（m）。壁厚の半分より小さい部屋の取りこぼしを防ぐ。 */
const FACE_PROBE = 0.08;
/** 床スラブ下面の天井板を各辺へ広げる量（m）。スラブ継ぎ目の光漏れ防止。 */
const SLAB_SEAM_PAD = 0.03;
/** 天井板をスラブ下面から下げる量（m）。継ぎ目のスラブ側面との深度競合（破線状のちらつき）を防ぐ。 */
const SLAB_UNDER_DROP = 0.012;
/** これより低い床高の室を地下階として扱う（m）。 */
const BASEMENT_EPS = -0.05;
/** 水回りとみなす部屋名（モチーフの便所・浴室名。id に wet 語を含まない室の差し替え先も拾う）。 */
const WET_NAME = /(トイレ|化粧室|浴室|風呂|洗面|脱衣)/;

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
    // 機内は外板・内装パネルを生成器が個別に決めているので従来どおり 1 箱 1 材質
    if (map.motif === 'air_force_one') this.buildBoxes(map.walls, 'wall', this.motif?.interiorTex ?? 'plaster', 0xc8c0b0);
    else this.buildRoomAwareWalls();
    this.buildCovers();
    if (map.motif === 'air_force_one') this.buildBoxes(map.floors, 'floor', this.motif?.groundTex ?? 'wood', 0x8a6844);
    else this.buildFloorSlabs();
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
        this.addCeilingMesh(room.id, piece, ceilY, this.isBasement(room) ? this.basementCeilingMat() : ceilMat);
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

  // ---- 部屋ごとの内装（壁面・天井面を、その面が向いている部屋で決める）

  private isBasement(room: RoomDef): boolean {
    return !room.outdoor && (room.floorY ?? 0) < BASEMENT_EPS;
  }

  private roomCeilY(room: RoomDef): number {
    const floorY = room.floorY ?? 0;
    const story = this.map.storyHeight ?? this.map.ceilingHeight;
    return room.ceilingY ?? (this.map.ceilingHeight > floorY + 0.5 ? this.map.ceilingHeight : floorY + story);
  }

  /** 点 (x, y, z) を含む屋内室（最小面積優先）。屋外室・敷地外は null。 */
  private indoorRoomAt(x: number, y: number, z: number): RoomDef | null {
    let best: RoomDef | null = null;
    let bestArea = Infinity;
    for (const r of this.map.rooms) {
      if (r.outdoor) continue;
      const floorY = r.floorY ?? 0;
      if (y < floorY - 0.05 || y > this.roomCeilY(r) + 0.05) continue;
      if (Math.abs(x - r.x) > r.width / 2 || Math.abs(z - r.z) > r.depth / 2) continue;
      const area = r.width * r.depth;
      if (area < bestArea) {
        bestArea = area;
        best = r;
      }
    }
    return best;
  }

  /** スラブ底面を天井とする屋内室（平面で重なり、天井高が底面付近）。地下室優先。 */
  private roomUnderSlab(def: BoxDef, bottomY: number): RoomDef | null {
    const a = boxToAABB(def);
    let best: RoomDef | null = null;
    for (const r of this.map.rooms) {
      if (r.outdoor) continue;
      if (Math.abs(this.roomCeilY(r) - bottomY) > UPPER_SLAB_TOLERANCE) continue;
      const ox = Math.min(a.max.x, r.x + r.width / 2) - Math.max(a.min.x, r.x - r.width / 2);
      const oz = Math.min(a.max.z, r.z + r.depth / 2) - Math.max(a.min.z, r.z - r.depth / 2);
      if (ox <= 0.05 || oz <= 0.05) continue;
      if (!best || this.isBasement(r)) best = r;
    }
    return best;
  }

  private interiorWallTex(room: RoomDef): TextureName {
    if (this.isBasement(room)) return this.motif?.basementWallTex ?? 'concrete';
    const role = roleOf(room.id) === 'wet' || WET_NAME.test(room.name ?? '') ? 'wet' : roleOf(room.id);
    const byRole = this.motif?.wallTex?.[role];
    if (byRole) return byRole;
    if (role === 'wet') return 'tile';
    return this.motif?.interiorTex ?? 'plaster';
  }

  /** 壁面の外側の点が属する空間で面の材質を決める。屋内室 → 室の内装、地中 → コンクリート、それ以外 → 外装。 */
  private wallFaceTex(x: number, y: number, z: number, exterior: TextureName): TextureName {
    const room = this.indoorRoomAt(x, y, z);
    if (room) return this.interiorWallTex(room);
    if (y < BASEMENT_EPS) return 'concrete';
    return exterior;
  }

  private surfaceMat(name: TextureName, fallback: number): THREE.MeshStandardMaterial {
    return this.material(name, this.colorFor(name, fallback));
  }

  private basementCeilingMat(doubleSide = true): THREE.MeshStandardMaterial {
    const name = this.motif?.basementCeilingTex ?? 'concrete';
    return this.material(name, this.colorFor(name, 0x8a8c8e), doubleSide);
  }

  /**
   * BoxGeometry の 6 面（+x, -x, +y, -y, +z, -z）を材質ごとのメッシュに分けて追加する。
   * 静的バッチは単一材質メッシュしか統合しないため、面グループを使わず index を分割する。
   */
  private addBoxFaces(geometry: THREE.BoxGeometry, mats: readonly THREE.Material[], x: number, y: number, z: number, yaw: number, name: string): void {
    const index = geometry.index;
    const byMat = new Map<THREE.Material, number[]>();
    for (const g of geometry.groups) {
      const m = mats[g.materialIndex ?? 0] ?? mats[0]!;
      let arr = byMat.get(m);
      if (!arr) byMat.set(m, (arr = []));
      for (let i = g.start; i < g.start + g.count; i++) arr.push(index ? index.getX(i) : i);
    }
    const parts = [...byMat];
    parts.forEach(([mat, idx], k) => {
      const geo = k === parts.length - 1 ? geometry : geometry.clone();
      geo.setIndex(idx);
      geo.clearGroups();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = yaw;
      mesh.name = name;
      this.root.add(mesh);
    });
  }

  /**
   * 壁は表と裏で別の部屋に面するので、面ごとに隣の部屋の内装を貼る。
   * 複数の部屋にまたがる長い壁は、見た目だけ部屋境界で分割する（当たりは元の箱 1 個）。
   */
  private buildRoomAwareWalls(): void {
    const exteriorName = this.motif?.exteriorTex ?? 'plaster';
    for (const def of this.map.walls) {
      this.colliders.push({ kind: 'wall', aabb: boxToAABB(def) });
      const yaw = (def.yaw ?? 0) * DEG2RAD;
      const y0 = def.y ?? 0;
      const yMid = y0 + def.height / 2;
      // 明示材質が外装以外（ガード・特殊壁など）でも、面の向こうの部屋で決め直す。天端・底面は元の材質
      const capName: TextureName = def.material !== undefined && KNOWN_BOX_TEXTURES.has(def.material) ? (def.material as TextureName) : this.motif?.interiorTex ?? 'plaster';
      const capMat = this.surfaceMat(capName, 0xc8c0b0);
      const rotated = Math.abs(Math.sin(yaw)) > 1e-3 && Math.abs(Math.cos(yaw)) > 1e-3;
      if (rotated) {
        const geometry = new THREE.BoxGeometry(def.width, def.height, def.depth);
        alignBoxTexture(geometry, def.x, yMid, def.z, yaw);
        this.addBoxFaces(geometry, [capMat], def.x, yMid, def.z, yaw, 'wall');
        continue;
      }
      // 90° 回転は寸法を入れ替えた軸平行箱として扱う
      const swap = Math.abs(Math.sin(yaw)) > 0.5;
      const w = swap ? def.depth : def.width;
      const d = swap ? def.width : def.depth;
      const alongX = w >= d;
      const lo = alongX ? def.x - w / 2 : def.z - d / 2;
      const hi = alongX ? def.x + w / 2 : def.z + d / 2;
      const crossC = alongX ? def.z : def.x;
      const crossHalf = (alongX ? d : w) / 2;
      // 分割位置: 壁の両側に接する部屋の、壁方向の端
      const cuts = new Set<number>([lo, hi]);
      for (const r of this.map.rooms) {
        const fy = r.floorY ?? 0;
        if (fy > y0 + def.height - 0.05 || (r.outdoor ? fy + 3 : this.roomCeilY(r)) < y0 + 0.05) continue;
        const rc = alongX ? r.z : r.x;
        const rh = (alongX ? r.depth : r.width) / 2;
        if (rc - rh > crossC + crossHalf + FACE_PROBE * 2 || rc + rh < crossC - crossHalf - FACE_PROBE * 2) continue;
        for (const e of alongX ? [r.x - r.width / 2, r.x + r.width / 2] : [r.z - r.depth / 2, r.z + r.depth / 2]) {
          if (e > lo + 0.02 && e < hi - 0.02) cuts.add(e);
        }
      }
      const edges = [...cuts].sort((a, b) => a - b);
      const exterior = exteriorName;
      type Seg = { a: number; b: number; pos: TextureName; neg: TextureName };
      const segs: Seg[] = [];
      for (let i = 0; i + 1 < edges.length; i++) {
        const a = edges[i]!;
        const b = edges[i + 1]!;
        const m = (a + b) / 2;
        const pc = crossC + crossHalf + FACE_PROBE;
        const nc = crossC - crossHalf - FACE_PROBE;
        const pos = alongX ? this.wallFaceTex(m, yMid, pc, exterior) : this.wallFaceTex(pc, yMid, m, exterior);
        const neg = alongX ? this.wallFaceTex(m, yMid, nc, exterior) : this.wallFaceTex(nc, yMid, m, exterior);
        const last = segs[segs.length - 1];
        if (last && last.pos === pos && last.neg === neg) last.b = b;
        else segs.push({ a, b, pos, neg });
      }
      for (const [k, sg] of segs.entries()) {
        const len = sg.b - sg.a;
        const mid = (sg.a + sg.b) / 2;
        const cx = alongX ? mid : def.x;
        const cz = alongX ? def.z : mid;
        const sw = alongX ? len : w;
        const sd = alongX ? d : len;
        // 端面（短辺）は外側の点で決める。分割の内側の端面は隣の区間に隠れるので天端と同じでよい
        const endTex = (sign: number): THREE.Material => {
          const isEnd = sign < 0 ? k === 0 : k === segs.length - 1;
          if (!isEnd) return capMat;
          const p = (sign < 0 ? sg.a : sg.b) + sign * FACE_PROBE;
          const tex = alongX ? this.wallFaceTex(p, yMid, crossC, exterior) : this.wallFaceTex(crossC, yMid, p, exterior);
          return this.surfaceMat(tex, 0xc8c0b0);
        };
        const posMat = this.surfaceMat(sg.pos, 0xc8c0b0);
        const negMat = this.surfaceMat(sg.neg, 0xc8c0b0);
        // BoxGeometry の面順: +x, -x, +y, -y, +z, -z
        const mats = alongX
          ? [endTex(1), endTex(-1), capMat, capMat, posMat, negMat]
          : [posMat, negMat, capMat, capMat, endTex(1), endTex(-1)];
        const geometry = new THREE.BoxGeometry(sw, def.height, sd);
        alignBoxTexture(geometry, cx, yMid, cz, 0);
        this.addBoxFaces(geometry, mats, cx, yMid, cz, 0, 'wall');
      }
    }
  }

  /**
   * 床スラブは上面だけが床材。下面・側面は下の部屋の天井として見えるため、下の室の天井材にする
   * （1F の畳・絨毯が地下室や 1F の天井に貼られて見えるのを防ぐ）。
   */
  private buildFloorSlabs(): void {
    const ceilName = this.motif?.ceilingTex ?? 'plaster';
    const ceilMat = this.material(ceilName, this.colorFor(ceilName, 0xd5d0c6));
    const fallbackName = this.motif?.groundTex ?? 'wood';
    for (const def of this.map.floors) {
      this.colliders.push({ kind: 'floor', aabb: boxToAABB(def) });
      const name = def.material !== undefined && KNOWN_BOX_TEXTURES.has(def.material) ? (def.material as TextureName) : fallbackName;
      const topMat = this.material(name, this.colorFor(name, 0x8a6844));
      const yaw = (def.yaw ?? 0) * DEG2RAD;
      const y0 = def.y ?? 0;
      const below = this.roomUnderSlab(def, y0);
      const underMat = below ? (this.isBasement(below) ? this.basementCeilingMat(false) : ceilMat) : topMat;
      const geometry = new THREE.BoxGeometry(def.width, def.height, def.depth);
      alignBoxTexture(geometry, def.x, y0 + def.height / 2, def.z, yaw);
      this.addBoxFaces(geometry, [underMat, underMat, topMat, underMat, underMat, underMat], def.x, y0 + def.height / 2, def.z, yaw, 'floor');
      if (below) {
        // 隣り合うスラブの継ぎ目から上階の光が漏れないよう、下面だけ少し広げた天井板を重ねる。
        // UV はワールド座標基準なので、同材質の重なりは継ぎ目として見えない（見た目のみ、当たりなし）
        const a = boxToAABB(def);
        const w = a.max.x - a.min.x + SLAB_SEAM_PAD * 2;
        const d = a.max.z - a.min.z + SLAB_SEAM_PAD * 2;
        const cx = (a.min.x + a.max.x) / 2;
        const cz = (a.min.z + a.max.z) / 2;
        const plane = new THREE.PlaneGeometry(w, d);
        plane.rotateX(Math.PI / 2); // 下向き
        const { position, uv } = plane.attributes;
        for (let i = 0; i < position.count; i++) {
          uv.setXY(i, (cx + position.getX(i)) / TEXTURE_TILE_METERS, -(cz + position.getZ(i)) / TEXTURE_TILE_METERS);
        }
        const under = new THREE.Mesh(plane, underMat);
        under.position.set(cx, y0 - SLAB_UNDER_DROP, cz);
        under.name = 'ceiling-under';
        this.root.add(under);
      }
    }
  }

  private buildBoxes(defs: readonly BoxDef[], kind: ColliderKind, fallback: TextureName, color: number): void {
    for (const def of defs) {
      const safe = def.material !== undefined && KNOWN_BOX_TEXTURES.has(def.material) ? (def.material as TextureName) : fallback;
      const geometry = new THREE.BoxGeometry(def.width, def.height, def.depth);
      const y = (def.y ?? 0) + def.height / 2;
      const yaw = (def.yaw ?? 0) * DEG2RAD;
      const largeCover = kind === 'cover' && Math.max(def.width, def.depth, def.height) > 2.4;
      if (kind === 'wall' || kind === 'floor' || largeCover) alignBoxTexture(geometry, def.x, y, def.z, yaw);
      const baseColor = kind === 'cover' && def.material ? 0xb7b2a9 : color;
      const mesh = new THREE.Mesh(geometry, this.material(safe, this.colorFor(safe, baseColor)));
      mesh.position.set(def.x, y, def.z);
      mesh.rotation.y = yaw;
      mesh.name = kind;
      if (kind === 'cover' && def.material && !largeCover) {
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
