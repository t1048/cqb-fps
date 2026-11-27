import * as THREE from 'three';
import type { InputManager } from '../core/InputManager';
import type { GameEventBus } from '../core/events';
import type { ThrowableDef, Vec3, WeaponDef } from '../core/types';
import { disposeObject } from '../core/dispose';
import type { PlayerController } from '../player/PlayerController';
import type { FlashOverlay } from '../ui/FlashOverlay';
import type { AABB, Collider } from '../world/WorldBuilder';
import type { WeaponSystem } from './WeaponSystem';
import type { TearGas } from './TearGas';
import { collidersNear, someColliderAlongSegment } from '../world/ColliderIndex';

const DEG2RAD = Math.PI / 180;
const MAX_DT = 0.05;
/** 1 サブステップの最大移動距離を球半径のこの倍率に抑える（トンネリング防止） */
const SUBSTEP_RADIUS_RATIO = 0.8;
const MAX_SUBSTEPS = 60;
/** 接地中の転がり減速係数 = (1 - friction) * この値 [1/s] */
const ROLL_DRAG_SCALE = 4;
/** 視線判定: 視線方向との内積がこれ以上なら正面、-これ以下なら背後（間は線形補間） */
const FRONT_DOT = 0.5;
const BLIND_EPS = 1e-3;
const BURST_SEC = 0.25;
const SPAWN_FORWARD = 0.4;
/** 最下のコライダ底面からこの深さに、マップ外落下を止める下限面を置く（m） */
const FLOOR_GUARD_DEPTH = 2.0;

interface Grenade {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  fuse: number;
  resting: boolean;
  mesh: THREE.Mesh;
  /** 投擲者 id（'player' または AI の id） */
  thrower: string;
}

interface Burst {
  mesh: THREE.Mesh;
  life: number;
}

/** 線分 a→b が colliders（壁・遮蔽物・ドア板）に遮られるか。AI の視線判定からも利用可。 */
export function hasLineOfSight(colliders: readonly Collider[], a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return !someColliderAlongSegment(colliders, a.x, a.z, b.x, b.z, (c) => segmentHitsAABB(a, dx, dy, dz, c.aabb));
}

/** スラブ法。視線判定の最内ループなので配列を確保せず軸ごとに展開している。 */
function segmentHitsAABB(o: Vec3, dx: number, dy: number, dz: number, box: AABB): boolean {
  let t0 = 0;
  let t1 = 1;
  // X
  if (Math.abs(dx) < 1e-9) {
    if (o.x < box.min.x || o.x > box.max.x) return false;
  } else {
    const inv = 1 / dx;
    let ta = (box.min.x - o.x) * inv;
    let tb = (box.max.x - o.x) * inv;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  // Y
  if (Math.abs(dy) < 1e-9) {
    if (o.y < box.min.y || o.y > box.max.y) return false;
  } else {
    const inv = 1 / dy;
    let ta = (box.min.y - o.y) * inv;
    let tb = (box.max.y - o.y) * inv;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  // Z
  if (Math.abs(dz) < 1e-9) {
    if (o.z < box.min.z || o.z > box.max.z) return false;
  } else {
    const inv = 1 / dz;
    let ta = (box.min.z - o.z) * inv;
    let tb = (box.max.z - o.z) * inv;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * フラッシュバン: `4` で構え/解除、左クリックで投擲。
 * 球と壁/床/天井/遮蔽物/ドア板(共有 colliders)のバウンド物理（サブステップ・dt 基準）→ 遅延起爆 →
 * プレイヤーへの視線判定(遮蔽)・距離・向きによる白飛び＋残光。`flashDetonated` / `noise(kind:'flash')` を発行。
 * 効果の AI への適用は T3 が flashDetonated を購読し hasLineOfSight で判定する。全パラメータは weapons.json。
 */
export class Flashbang {
  readonly root = new THREE.Group();
  private readonly def: WeaponDef;
  private readonly cfg: ThrowableDef;
  private lowestY: number | null = null;
  private readonly grenades: Grenade[] = [];
  private readonly bursts: Burst[] = [];
  private readonly geo: THREE.CylinderGeometry;
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly burstGeo: THREE.SphereGeometry;
  private count: number;
  private readonly gasDef: WeaponDef | null;
  private gasCount: number;
  /** 構え中の投擲物。flash=フラッシュバン / gas=CS ガス */
  private mode: 'flash' | 'gas' = 'flash';
  private cooldown = 0;
  private isEquipped = false;
  private prevMouse = true; // 構え直後のクリック持ち越しで即投擲しない
  private disposed = false;
  private readonly eye = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor(
    private readonly player: PlayerController,
    private readonly input: InputManager,
    private readonly colliders: readonly Collider[],
    weapons: readonly WeaponDef[],
    private readonly bus: GameEventBus,
    private readonly weaponSystem: WeaponSystem,
    private readonly overlay: FlashOverlay,
    private readonly ceilingHeight: number,
    private readonly tearGas?: TearGas,
  ) {
    const def = weapons.find((w) => w.category === 'throwable' && w.id === 'flashbang');
    if (!def || !def.throwable) throw new Error('[Flashbang] weapons.json に throwable な "flashbang" 定義がありません');
    this.def = def;
    this.cfg = def.throwable;
    this.count = def.magazineSize;
    const gas = weapons.find((w) => w.category === 'throwable' && w.id === 'teargas');
    this.gasDef = tearGas && gas?.throwable ? gas : null;
    this.gasCount = this.gasDef ? this.gasDef.magazineSize : 0;
    this.geo = new THREE.CylinderGeometry(this.cfg.ballRadius, this.cfg.ballRadius, this.cfg.ballRadius * 3, 10);
    this.mat = new THREE.MeshStandardMaterial({ color: 0x2d3a52, roughness: 0.6 });
    this.burstGeo = new THREE.SphereGeometry(1, 12, 8);
  }

  get equipped(): boolean {
    return this.isEquipped;
  }
  get remaining(): number {
    return this.mode === 'gas' ? this.gasCount : this.count;
  }

  /** 所持数を設定（容疑者モードでは 0 = 所持なし） */
  setCount(n: number): void {
    this.count = Math.max(0, Math.floor(n));
    if (this.count === 0 && this.gasCount === 0 && this.isEquipped) this.setEquipped(false);
  }

  /** CS ガスの所持数を設定（容疑者モードでは 0 = 所持なし） */
  setGasCount(n: number): void {
    this.gasCount = this.gasDef ? Math.max(0, Math.floor(n)) : 0;
    if (this.count === 0 && this.gasCount === 0 && this.isEquipped) this.setEquipped(false);
  }
  /** 構え中（または次に構える）投擲物の定義 */
  get weapon(): WeaponDef {
    return this.mode === 'gas' && this.gasDef ? this.gasDef : this.def;
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    this.cooldown = Math.max(0, this.cooldown - dt);

    // 構え切替: 3 でトグル、1〜2 で通常武器へ戻る（指揮メニュー展開中は抑止）
    if (!this.input.isOrderMenuOpen) {
      if (this.input.wasPressed('slot3')) this.cycleThrowable();
      else if (this.input.wasPressed('slot1') || this.input.wasPressed('slot2') || this.input.wasPressed('slot4') || this.input.wasMousePressed(1)) {
        this.setEquipped(false);
      }
    }

    const mouse = this.input.isPointerLocked && this.input.isMouseDown(0);
    if (this.isEquipped && mouse && !this.prevMouse && this.cooldown <= 0 && this.remaining > 0) this.throwGrenade();
    this.prevMouse = mouse;

    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      this.simulate(g, dt);
      g.mesh.position.copy(g.pos);
      if (g.fuse <= 0) {
        this.detonate(g);
        this.root.remove(g.mesh);
        this.grenades.splice(i, 1);
      }
    }

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dt;
      const k = Math.max(0, b.life / BURST_SEC);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = k;
      b.mesh.scale.setScalar(0.3 + (1 - k) * 1.2);
      if (b.life <= 0) {
        this.root.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        this.bursts.splice(i, 1);
      }
    }

    this.overlay.update(dt);
  }

  /** 3 キー: 解除 → フラッシュバン → CS ガス → 解除。所持数 0 のものは飛ばす */
  private cycleThrowable(): void {
    const order: Array<'flash' | 'gas'> = [];
    if (this.count > 0) order.push('flash');
    if (this.gasCount > 0) order.push('gas');
    if (!this.isEquipped) {
      if (order.length === 0) return;
      this.mode = order[0]!;
      this.setEquipped(true);
      return;
    }
    const i = order.indexOf(this.mode);
    const next = order[i + 1];
    if (next) {
      this.mode = next;
      this.prevMouse = true;
    } else {
      this.setEquipped(false);
    }
  }

  private setEquipped(on: boolean): void {
    this.isEquipped = on;
    this.weaponSystem.suppressFire = on;
    this.prevMouse = true;
  }

  private throwGrenade(): void {
    const gas = this.mode === 'gas' && this.gasDef?.throwable && this.tearGas ? this.gasDef : null;
    if (this.mode === 'gas' && !gas) return;
    if (gas ? this.gasCount <= 0 : this.count <= 0) return;
    const c = gas ? gas.throwable! : this.cfg;
    if (gas) this.gasCount--;
    else this.count--;
    this.cooldown = 1 / (gas ?? this.def).fireRate;

    this.player.getEyePosition(this.eye);
    const pitch = this.player.pitchRad + c.upwardBiasDeg * DEG2RAD;
    const yaw = this.player.yawRad;
    this.fwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();

    // 目の前が壁の場合は壁にめり込まないよう目線位置から開始
    const pos = this.eye.clone().addScaledVector(this.fwd, SPAWN_FORWARD);
    if (!hasLineOfSight(this.colliders, this.eye, pos)) pos.copy(this.eye);

    if (gas) {
      const v = this.fwd.clone().multiplyScalar(c.throwSpeed);
      this.tearGas!.throwFrom({ x: pos.x, y: pos.y, z: pos.z }, { x: v.x, y: v.y, z: v.z }, 'player', c.fuseTime);
      return;
    }

    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.position.copy(pos);
    this.root.add(mesh);
    this.grenades.push({
      pos,
      vel: this.fwd.clone().multiplyScalar(c.throwSpeed),
      fuse: c.fuseTime,
      resting: false,
      mesh,
      thrower: 'player',
    });
  }

  /**
   * AI（容疑者モードの SWAT 等）による投擲。プレイヤー投擲と同じバウンド物理・起爆・白飛び判定を使う。
   * 所持数は消費しない（投擲者側で管理）。
   */
  throwFrom(origin: Vec3, velocity: Vec3, thrower: string, fuseSec = this.cfg.fuseTime): void {
    if (this.disposed) return;
    const pos = new THREE.Vector3(origin.x, origin.y, origin.z);
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.position.copy(pos);
    this.root.add(mesh);
    this.grenades.push({
      pos,
      vel: new THREE.Vector3(velocity.x, velocity.y, velocity.z),
      fuse: fuseSec,
      resting: false,
      mesh,
      thrower,
    });
  }

  /** 投擲物の重力加速度（AI の弾道計算用） */
  get gravity(): number {
    return this.cfg.gravity;
  }

  // ---------- 物理 ----------

  private simulate(g: Grenade, dt: number): void {
    if (g.resting) return;
    const c = this.cfg;
    const dist = g.vel.length() * dt + 0.5 * c.gravity * dt * dt;
    const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dist / (c.ballRadius * SUBSTEP_RADIUS_RATIO))));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      g.vel.y -= c.gravity * h;
      g.pos.addScaledVector(g.vel, h);
      const grounded = this.collide(g);
      if (grounded) {
        const drag = Math.exp(-(1 - c.friction) * ROLL_DRAG_SCALE * h);
        g.vel.x *= drag;
        g.vel.z *= drag;
        if (g.vel.length() < c.stopSpeed) {
          g.vel.set(0, 0, 0);
          g.resting = true;
          return;
        }
      }
    }
  }

  private contact(g: Grenade, nx: number, ny: number, nz: number): boolean {
    const c = this.cfg;
    const vn = g.vel.x * nx + g.vel.y * ny + g.vel.z * nz;
    if (vn >= 0) return ny > 0.7;
    const impact = -vn;
    // 法線成分を反射（反発係数）。小さな衝撃は反発させず接地扱いにする
    const bounce = impact > c.stopSpeed ? 1 + c.restitution : 1;
    g.vel.x -= bounce * vn * nx;
    g.vel.y -= bounce * vn * ny;
    g.vel.z -= bounce * vn * nz;
    if (impact > c.stopSpeed) {
      // 接線方向は摩擦で減衰（衝突ごとに一度だけ）
      const vt = g.vel.x * nx + g.vel.y * ny + g.vel.z * nz;
      const tx = g.vel.x - vt * nx;
      const ty = g.vel.y - vt * ny;
      const tz = g.vel.z - vt * nz;
      g.vel.set(vt * nx + tx * c.friction, vt * ny + ty * c.friction, vt * nz + tz * c.friction);
    }
    return ny > 0.7;
  }

  /** 共有コライダの最下面（地下スラブ含む。初回計算後はキャッシュ）。コライダが無ければ 0。 */
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

  /** 床・天井・colliders との球衝突を解決。接地(上向き法線に接触)なら true。 */
  private collide(g: Grenade): boolean {
    const r = this.cfg.ballRadius;
    let grounded = false;
    const p = g.pos;

    // 地面は共有 floor / stair コライダで受ける（y=0 固定クランプは使わない）。マップ外落下の下限ガードのみ
    const floorGuard = this.lowestColliderY() - FLOOR_GUARD_DEPTH;
    if (p.y < floorGuard + r) {
      p.y = floorGuard + r;
      if (this.contact(g, 0, 1, 0)) grounded = true;
    }
    const top = Math.max(this.ceilingHeight + 8, 14) - r;
    if (p.y > top) {
      p.y = top;
      this.contact(g, 0, -1, 0);
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
        // 中心が箱内部: 最小貫通軸で押し出す（配列確保なし）
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
      if (this.contact(g, dx, dy, dz)) grounded = true;
    }
    return grounded;
  }

  // ---------- 起爆 ----------

  private detonate(g: Grenade): void {
    const c = this.cfg;
    const pos: Vec3 = { x: g.pos.x, y: g.pos.y, z: g.pos.z };
    const radius = this.def.range;
    this.bus.emit('flashDetonated', { pos, radius, blindSec: c.blindMaxSec, thrower: g.thrower });
    this.bus.emit('noise', { pos, radius: this.def.noiseRadius, kind: 'flash' });
    this.applyToPlayer(pos, radius);

    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false });
    const mesh = new THREE.Mesh(this.burstGeo, mat);
    mesh.position.copy(g.pos);
    this.root.add(mesh);
    this.bursts.push({ mesh, life: BURST_SEC });
  }

  /** 視線(遮蔽)・距離・向きから白飛び時間を算出して画面効果を発動。 */
  private applyToPlayer(pos: Vec3, radius: number): number {
    const c = this.cfg;
    this.player.getEyePosition(this.eye);
    const to = new THREE.Vector3(pos.x - this.eye.x, pos.y - this.eye.y, pos.z - this.eye.z);
    const d = to.length();
    if (d > radius) return 0;
    // 床スレスレの起爆点で床面に潰れないよう少し持ち上げて判定
    const target = { x: pos.x, y: pos.y + 0.1, z: pos.z };
    if (!hasLineOfSight(this.colliders, this.eye, target)) return 0;

    const distF = 1 - (1 - c.falloffMin) * Math.min(1, d / radius);
    let facingF = 1;
    if (d > 1e-4) {
      const yaw = this.player.yawRad;
      const pitch = this.player.pitchRad;
      this.fwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      const dot = this.fwd.dot(to.divideScalar(d));
      const t = Math.max(0, Math.min(1, (dot + FRONT_DOT) / (2 * FRONT_DOT)));
      facingF = c.behindFactor + (1 - c.behindFactor) * t;
    }
    const blind = c.blindMaxSec * distF * facingF;
    if (blind <= BLIND_EPS) return 0;
    this.overlay.trigger(blind, c.afterglowSec * (blind / c.blindMaxSec), c.afterglowOpacity);
    const p = this.player.position;
    this.bus.emit('playerBlinded', { duration: blind, pos: { x: p.x, y: p.y, z: p.z } });
    return blind;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.weaponSystem.suppressFire = false;
    for (const b of this.bursts) (b.mesh.material as THREE.Material).dispose();
    this.bursts.length = 0;
    this.grenades.length = 0;
    this.geo.dispose();
    this.mat.dispose();
    this.burstGeo.dispose();
    disposeObject(this.root);
  }
}
