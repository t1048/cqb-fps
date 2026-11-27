import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import type { RoomDef, Vec3 } from '../core/types';
import { disposeObject } from '../core/dispose';
import type { Collider } from '../world/WorldBuilder';
import { collidersNear } from '../world/ColliderIndex';
import { hasLineOfSight } from './Flashbang';

const MAX_DT = 0.05;
const SUBSTEP_RADIUS_RATIO = 0.8;
const MAX_SUBSTEPS = 60;
const ROLL_DRAG_SCALE = 4;
const FLOOR_GUARD_DEPTH = 2.0;

const GRAVITY = 14;
const BALL_RADIUS = 0.06;
const RESTITUTION = 0.35;
const FRICTION = 0.65;
const STOP_SPEED = 0.25;
const DEFAULT_FUSE = 1.6;

export const GAS_CLOUD_RADIUS = 4.2;
export const GAS_CLOUD_DURATION = 16.0;
const GAS_CLOUD_FADE_IN = 1.2;
const GAS_CLOUD_FADE_OUT = 3.0;
const GAS_VERTICAL_BAND = 2.4;
const CENTER_BASE_OPACITY = 0.28;
const RING_BASE_OPACITY = 0.2;
/** 部屋に投げ込まれたガスが部屋いっぱいに広がるまでの秒数（分隊の「満ちるまで待つ」時間に合わせる） */
export const GAS_FILL_SEC = 4.5;
/** 部屋いっぱいに広がるときの最大半径(m)。これより広い部屋は一定の広さまでしか満ちない */
export const GAS_FILL_MAX_RADIUS = 9;
/** 起爆直後の広がり半径(m) */
const GAS_START_RADIUS = 1.6;

/** ガスが満ちる部屋の矩形（XZ） */
export interface GasRoomRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface GasCloudInfo {
  pos: Vec3;
  /** 現在の広がり半径。部屋内のガスは時間とともに fill 半径まで増える */
  radius: number;
  /** 起爆した部屋（屋内）。ある場合は部屋の中を家具に遮られず満たす */
  room?: GasRoomRect;
  remainingSec: number;
  durationSec: number;
  intensity: number;
}

interface GasCanister {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  fuse: number;
  resting: boolean;
  mesh: THREE.Mesh;
  thrower: string;
}

interface PuffSpec {
  mesh: THREE.Mesh;
  baseOffset: THREE.Vector3;
  baseScale: number;
  phase: number;
  speed: number;
}

interface GasCloud extends GasCloudInfo {
  /** 部屋いっぱいに広がったときの半径（部屋なしは radius と同じ） */
  fillRadius: number;
  elapsedSec: number;
  group: THREE.Group;
  centerMat: THREE.MeshBasicMaterial;
  ringMat: THREE.MeshBasicMaterial;
  puffs: PuffSpec[];
}

function pointInRoom(room: GasRoomRect, p: Vec3): boolean {
  return p.x >= room.minX && p.x <= room.maxX && p.z >= room.minZ && p.z <= room.maxZ;
}

/** 部屋の内側は現在の広がり半径、部屋の外へ漏れる分は従来の半径（開いたドア越し・壁で遮蔽）に抑える */
function roomRadius(c: GasCloudInfo, p: Vec3): number {
  return c.room && pointInRoom(c.room, p) ? c.radius : Math.min(c.radius, GAS_CLOUD_RADIUS);
}

/**
 * 指定座標における CS 催涙ガス濃度（0..1）を計算する純粋関数。
 * 水平距離・フロア帯域・壁遮蔽（colliders 指定時）を考慮し、最も濃い雲の値を返す。
 */
export function computeGasDensityAt(
  clouds: readonly GasCloudInfo[],
  point: Vec3,
  colliders?: readonly Collider[],
): number {
  if (clouds.length === 0) return 0;
  let peak = 0;
  for (let i = 0; i < clouds.length; i++) {
    const c = clouds[i]!;
    if (c.remainingSec <= 0 || c.intensity <= 0 || c.radius <= 0) continue;
    const dy = Math.abs(point.y - c.pos.y);
    if (dy > GAS_VERTICAL_BAND) continue;
    const dist = Math.hypot(point.x - c.pos.x, point.z - c.pos.z);
    const r = c.room ? roomRadius(c, point) : c.radius;
    if (dist > r) continue;
    if (c.room && pointInRoom(c.room, point)) {
      // 部屋の中は家具・遮蔽物に関係なくガスが回る（壁・ドアで区切られた部屋が満たされる）
      const inRoom = 1 - 0.35 * (dist / Math.max(c.radius, 0.1));
      const v = Math.max(0, Math.min(1, c.intensity * inRoom));
      if (v > peak) peak = v;
      continue;
    }
    if (colliders && colliders.length > 0) {
      const origin: Vec3 = { x: c.pos.x, y: c.pos.y + 0.35, z: c.pos.z };
      if (!hasLineOfSight(colliders, origin, point)) continue;
    }
    const radial = 1 - 0.55 * (dist / r);
    const val = Math.max(0, Math.min(1, c.intensity * radial));
    if (val > peak) peak = val;
  }
  return peak;
}

/**
 * 投擲型 CS 催涙ガス弾（容疑者モードの籠城崩しギミック）。
 * サブステップ球 vs AABB 物理でバウンド・転がり、起爆後に持続的な半透明ガス雲を生成する。
 * 動的ライトは一切使用せず、MeshBasicMaterial（depthWrite: false）のみで描画する。
 */
export class TearGas {
  readonly root = new THREE.Group();
  private readonly canisterGeo = new THREE.CylinderGeometry(0.036, 0.036, 0.13, 10);
  private readonly canisterMat = new THREE.MeshLambertMaterial({ color: 0x55624a });
  private readonly puffGeo = new THREE.SphereGeometry(1, 10, 8);
  private readonly canisters: GasCanister[] = [];
  private readonly clouds: GasCloud[] = [];
  private lowestY: number | null = null;
  private disposed = false;

  constructor(
    private readonly colliders: readonly Collider[],
    private readonly bus: GameEventBus,
    private readonly ceilingHeight: number,
    private readonly rooms: readonly RoomDef[] = [],
  ) {
    this.root.name = 'tearGas';
  }

  /** 投擲物の重力加速度（AI の弾道計算用） */
  get gravity(): number {
    return GRAVITY;
  }

  get activeCloudCount(): number {
    return this.clouds.length;
  }

  get activeCanisterCount(): number {
    return this.canisters.length;
  }

  throwFrom(origin: Vec3, velocity: Vec3, thrower: string, fuseSec = DEFAULT_FUSE): void {
    if (this.disposed) return;
    const pos = new THREE.Vector3(origin.x, origin.y, origin.z);
    const mesh = new THREE.Mesh(this.canisterGeo, this.canisterMat);
    mesh.position.copy(pos);
    this.root.add(mesh);
    this.canisters.push({
      pos,
      vel: new THREE.Vector3(velocity.x, velocity.y, velocity.z),
      fuse: fuseSec,
      resting: false,
      mesh,
      thrower,
    });
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);

    for (let i = this.canisters.length - 1; i >= 0; i--) {
      const c = this.canisters[i]!;
      this.simulate(c, dt);
      c.mesh.position.copy(c.pos);
      if (!c.resting) {
        c.mesh.rotation.x += dt * 7;
        c.mesh.rotation.z += dt * 4;
      }
      c.fuse -= dt;
      if (c.fuse <= 0) {
        this.root.remove(c.mesh);
        this.canisters.splice(i, 1);
        this.detonate(c);
      }
    }

    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const cl = this.clouds[i]!;
      cl.elapsedSec += dt;
      cl.remainingSec -= dt;
      if (cl.remainingSec <= 0) {
        this.removeCloud(cl);
        this.clouds.splice(i, 1);
        continue;
      }
      const fadeIn = Math.min(1, cl.elapsedSec / GAS_CLOUD_FADE_IN);
      const fadeOut = Math.min(1, cl.remainingSec / GAS_CLOUD_FADE_OUT);
      cl.intensity = Math.max(0, Math.min(1, fadeIn * fadeOut));
      const spread = Math.min(1, cl.elapsedSec / GAS_FILL_SEC);
      if (cl.room) cl.radius = GAS_START_RADIUS + (cl.fillRadius - GAS_START_RADIUS) * (1 - (1 - spread) * (1 - spread));
      cl.centerMat.opacity = CENTER_BASE_OPACITY * cl.intensity;
      cl.ringMat.opacity = RING_BASE_OPACITY * cl.intensity;
      const grow = cl.room ? 0.3 + 0.7 * (1 - (1 - spread) * (1 - spread)) : 0.45 + 0.55 * fadeIn;
      for (let j = 0; j < cl.puffs.length; j++) {
        const pf = cl.puffs[j]!;
        const driftX = Math.sin(cl.elapsedSec * pf.speed + pf.phase) * 0.28;
        const driftY = Math.cos(cl.elapsedSec * pf.speed * 0.7 + pf.phase) * 0.14;
        const driftZ = Math.cos(cl.elapsedSec * pf.speed * 0.85 + pf.phase) * 0.28;
        pf.mesh.position.set(
          pf.baseOffset.x * grow + driftX,
          pf.baseOffset.y * grow + driftY,
          pf.baseOffset.z * grow + driftZ,
        );
        const s = pf.baseScale * grow;
        pf.mesh.scale.set(s * 1.15, s * 0.82, s * 1.15);
      }
    }
  }

  /** 指定座標のガス露出度（0..1） */
  exposureAt(pos: Vec3): number {
    return computeGasDensityAt(this.clouds, pos, this.colliders);
  }

  /** exposureAt のエイリアス */
  densityAt(pos: Vec3): number {
    return this.exposureAt(pos);
  }

  /** 指定座標が有効な CS ガス雲内にあるか */
  isPointInGas(pos: Vec3): boolean {
    return this.exposureAt(pos) > 0;
  }

  // ---------- 物理 ----------

  private simulate(c: GasCanister, dt: number): void {
    if (c.resting) return;
    const dist = c.vel.length() * dt + 0.5 * GRAVITY * dt * dt;
    const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dist / (BALL_RADIUS * SUBSTEP_RADIUS_RATIO))));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      c.vel.y -= GRAVITY * h;
      c.pos.addScaledVector(c.vel, h);
      const grounded = this.collide(c);
      if (grounded) {
        const drag = Math.exp(-(1 - FRICTION) * ROLL_DRAG_SCALE * h);
        c.vel.x *= drag;
        c.vel.z *= drag;
        if (c.vel.length() < STOP_SPEED) {
          c.vel.set(0, 0, 0);
          c.resting = true;
          return;
        }
      }
    }
  }

  private contact(c: GasCanister, nx: number, ny: number, nz: number): boolean {
    const vn = c.vel.x * nx + c.vel.y * ny + c.vel.z * nz;
    if (vn >= 0) return ny > 0.7;
    const impact = -vn;
    const bounce = impact > STOP_SPEED ? 1 + RESTITUTION : 1;
    c.vel.x -= bounce * vn * nx;
    c.vel.y -= bounce * vn * ny;
    c.vel.z -= bounce * vn * nz;
    if (impact > STOP_SPEED) {
      const vt = c.vel.x * nx + c.vel.y * ny + c.vel.z * nz;
      const tx = c.vel.x - vt * nx;
      const ty = c.vel.y - vt * ny;
      const tz = c.vel.z - vt * nz;
      c.vel.set(vt * nx + tx * FRICTION, vt * ny + ty * FRICTION, vt * nz + tz * FRICTION);
    }
    return ny > 0.7;
  }

  private lowestColliderY(): number {
    if (this.lowestY !== null) return this.lowestY;
    let min = Infinity;
    for (const c of this.colliders) {
      if (c.aabb.max.y <= -500) continue;
      if (c.aabb.min.y < min) min = c.aabb.min.y;
    }
    this.lowestY = Number.isFinite(min) ? Math.min(min, 0) : 0;
    return this.lowestY;
  }

  private collide(c: GasCanister): boolean {
    const r = BALL_RADIUS;
    let grounded = false;
    const p = c.pos;

    const floorGuard = this.lowestColliderY() - FLOOR_GUARD_DEPTH;
    if (p.y < floorGuard + r) {
      p.y = floorGuard + r;
      if (this.contact(c, 0, 1, 0)) grounded = true;
    }
    const top = Math.max(this.ceilingHeight + 8, 14) - r;
    if (p.y > top) {
      p.y = top;
      this.contact(c, 0, -1, 0);
    }

    const near = collidersNear(this.colliders, p.x - r - 0.05, p.z - r - 0.05, p.x + r + 0.05, p.z + r + 0.05);
    for (let i = 0; i < near.length; i++) {
      const a = near[i]!.aabb;
      if (p.x < a.min.x - r || p.x > a.max.x + r || p.y < a.min.y - r || p.y > a.max.y + r) continue;
      if (p.z < a.min.z - r || p.z > a.max.z + r) continue;
      const qx = Math.max(a.min.x, Math.min(a.max.x, p.x));
      const qy = Math.max(a.min.y, Math.min(a.max.y, p.y));
      const qz = Math.max(a.min.z, Math.min(a.max.z, p.z));
      let dx = p.x - qx;
      let dy = p.y - qy;
      let dz = p.z - qz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r * r) continue;
      let pen: number;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        dx /= d;
        dy /= d;
        dz /= d;
        pen = r - d;
      } else {
        let bestDist = p.x - a.min.x;
        dx = -1;
        dy = 0;
        dz = 0;
        const dMaxX = a.max.x - p.x;
        if (dMaxX < bestDist) {
          bestDist = dMaxX;
          dx = 1;
        }
        const dMinY = p.y - a.min.y;
        if (dMinY < bestDist) {
          bestDist = dMinY;
          dx = 0;
          dy = -1;
        }
        const dMaxY = a.max.y - p.y;
        if (dMaxY < bestDist) {
          bestDist = dMaxY;
          dx = 0;
          dy = 1;
        }
        const dMinZ = p.z - a.min.z;
        if (dMinZ < bestDist) {
          bestDist = dMinZ;
          dx = 0;
          dy = 0;
          dz = -1;
        }
        const dMaxZ = a.max.z - p.z;
        if (dMaxZ < bestDist) {
          bestDist = dMaxZ;
          dx = 0;
          dy = 0;
          dz = 1;
        }
        pen = bestDist + r;
      }
      p.x += dx * pen;
      p.y += dy * pen;
      p.z += dz * pen;
      if (this.contact(c, dx, dy, dz)) grounded = true;
    }
    return grounded;
  }

  // ---------- 起爆・ガス雲 ----------

  private detonate(c: GasCanister): void {
    const pos: Vec3 = { x: c.pos.x, y: c.pos.y, z: c.pos.z };
    const group = new THREE.Group();
    group.position.set(pos.x, pos.y, pos.z);
    group.frustumCulled = false;

    const centerMat = new THREE.MeshBasicMaterial({
      color: 0xa8b868,
      transparent: true,
      opacity: CENTER_BASE_OPACITY * 0.3,
      depthWrite: false,
    });
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x90a656,
      transparent: true,
      opacity: RING_BASE_OPACITY * 0.3,
      depthWrite: false,
    });

    const roomInfo = this.findRoom(pos);
    const puffs: PuffSpec[] = [];
    const puffCount = roomInfo ? 16 : 8;
    for (let i = 0; i < puffCount; i++) {
      const ang = (i / puffCount) * Math.PI * 2;
      let ring = i === 0 ? 0 : GAS_CLOUD_RADIUS * (0.28 + (i % 3) * 0.16);
      let ox = Math.cos(ang) * ring;
      let oz = Math.sin(ang) * ring;
      if (roomInfo && i > 0) {
        // 部屋の矩形いっぱいに散らす（部屋の外へはみ出さないよう clamp）
        ring = roomInfo.fillRadius * (0.25 + (i % 4) * 0.2);
        ox = Math.cos(ang) * ring;
        oz = Math.sin(ang) * ring;
        const r = roomInfo.room;
        ox = Math.max(r.minX - pos.x + 0.4, Math.min(r.maxX - pos.x - 0.4, ox));
        oz = Math.max(r.minZ - pos.z + 0.4, Math.min(r.maxZ - pos.z - 0.4, oz));
      }
      const baseOffset = new THREE.Vector3(ox, 0.55 + (i % 3) * 0.32, oz);
      const baseScale = roomInfo ? (i === 0 ? 2.2 : 1.8 + (i % 2) * 0.4) : i === 0 ? 1.85 : 1.35 + (i % 2) * 0.35;
      const mesh = new THREE.Mesh(this.puffGeo, i === 0 ? centerMat : ringMat);
      mesh.position.copy(baseOffset).multiplyScalar(0.45);
      mesh.scale.setScalar(baseScale * 0.45);
      mesh.frustumCulled = true;
      group.add(mesh);
      puffs.push({
        mesh,
        baseOffset,
        baseScale,
        phase: i * 1.13,
        speed: 0.65 + (i % 3) * 0.22,
      });
    }

    this.root.add(group);
    const fillRadius = roomInfo ? roomInfo.fillRadius : GAS_CLOUD_RADIUS;
    this.clouds.push({
      pos,
      ...(roomInfo ? { room: roomInfo.room } : {}),
      fillRadius,
      radius: roomInfo ? GAS_START_RADIUS : GAS_CLOUD_RADIUS,
      remainingSec: GAS_CLOUD_DURATION,
      durationSec: GAS_CLOUD_DURATION,
      elapsedSec: 0,
      intensity: 0.35,
      group,
      centerMat,
      ringMat,
      puffs,
    });

    this.bus.emit('gasDetonated', { pos, radius: fillRadius });
  }

  /** 起爆点を含む屋内の部屋（同じ階・最小面積）と、最も遠い角までの広がり半径（上限あり）。なければ null */
  private findRoom(pos: Vec3): { room: GasRoomRect; fillRadius: number } | null {
    let best: RoomDef | null = null;
    for (const r of this.rooms) {
      if (r.outdoor) continue;
      if (Math.abs((r.floorY ?? 0) - pos.y) > 1.6) continue;
      if (Math.abs(pos.x - r.x) > r.width / 2 || Math.abs(pos.z - r.z) > r.depth / 2) continue;
      if (!best || r.width * r.depth < best.width * best.depth) best = r;
    }
    if (!best) return null;
    const room: GasRoomRect = {
      minX: best.x - best.width / 2,
      maxX: best.x + best.width / 2,
      minZ: best.z - best.depth / 2,
      maxZ: best.z + best.depth / 2,
    };
    const far = Math.hypot(Math.max(pos.x - room.minX, room.maxX - pos.x), Math.max(pos.z - room.minZ, room.maxZ - pos.z));
    return { room, fillRadius: Math.min(GAS_FILL_MAX_RADIUS, Math.max(GAS_CLOUD_RADIUS, far + 0.3)) };
  }

  private removeCloud(cl: GasCloud): void {
    this.root.remove(cl.group);
    cl.centerMat.dispose();
    cl.ringMat.dispose();
    cl.puffs.length = 0;
  }

  clear(): void {
    for (const c of this.canisters) this.root.remove(c.mesh);
    this.canisters.length = 0;
    for (const cl of this.clouds) this.removeCloud(cl);
    this.clouds.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.canisterGeo.dispose();
    this.canisterMat.dispose();
    this.puffGeo.dispose();
    disposeObject(this.root);
  }
}
