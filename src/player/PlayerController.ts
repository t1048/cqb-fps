import * as THREE from 'three';
import { getSettings } from '../core/Settings';
import type { InputManager } from '../core/InputManager';
import type { GameEventBus } from '../core/events';
import type { MapData, MoveMode, PlayerConfig } from '../core/types';
import type { AABB, Collider } from '../world/WorldBuilder';
import { legacyZeroFallbackOf, nextFootY, probeGround, STEP_HEIGHT } from '../world/Walk';

const DEG2RAD = Math.PI / 180;
const MAX_DT = 0.05;

/**
 * 一人称移動: PointerLock 視点、WASD、Shift 静音、C しゃがみ、AABB 壁スライディング衝突。
 * 座標は足元基準 (pos.y = 床高さ)。カメラは毎フレーム目線位置へ更新する。
 */
export class PlayerController {
  /** 足元位置（ワールド座標） */
  readonly position = new THREE.Vector3();
  private yaw: number;
  private pitch = 0;
  private eyeHeight: number;
  private crouching = false;
  private mode: MoveMode = 'run';
  private stepTimer = 0;
  private moving = false;
  private leanOffset = 0; // 現在の横オフセット（右が正, m）
  private readonly eyeWorld = new THREE.Vector3();
  private verticalVelocity = 0;
  /** 直前に有効な支持面の上にいた足元位置（無支持時の安全側復帰先） */
  private readonly lastValidPos = new THREE.Vector3();
  /** true = 旧固定マップ（無支持を地面 y=0 とみなす）。false = 無支持領域への進入を拒否する */
  private readonly legacyGround: boolean;
  private disposed = false;
  private hpValue: number;
  private readonly baseFov: number;
  /** 移動速度倍率（ADS 等で WeaponSystem が設定。1=等倍） */
  speedMultiplier = 1;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly input: InputManager,
    private readonly colliders: readonly Collider[],
    private readonly config: PlayerConfig,
    private readonly bus: GameEventBus,
    map: MapData,
  ) {
    const sp = map.playerSpawn;
    this.position.set(sp.x, sp.y, sp.z);
    this.lastValidPos.copy(this.position);
    this.legacyGround = legacyZeroFallbackOf(colliders);
    this.yaw = -sp.yaw * DEG2RAD; // yaw 0 = -Z
    this.eyeHeight = config.standEyeHeight;
    this.hpValue = config.maxHp;
    this.baseFov = camera.fov;
    this.camera.rotation.order = 'YXZ';
    this.applyCamera();
  }

  get hp(): number {
    return this.hpValue;
  }

  get maxHp(): number {
    return this.config.maxHp;
  }

  get alive(): boolean {
    return this.hpValue > 0;
  }

  /** 防弾チョッキの耐久値（0 = 未装着）。被弾の 60% を耐久が尽きるまで肩代わりする */
  armor = 0;

  takeDamage(amount: number): number {
    if (this.disposed || this.hpValue <= 0 || amount <= 0) return this.hpValue;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, amount * 0.6);
      this.armor -= absorbed;
      amount -= absorbed;
    }
    this.hpValue = Math.max(0, this.hpValue - amount);
    return this.hpValue;
  }

  setFovBlend(adsBlend: number): void {
    const t = Math.max(0, Math.min(1, adsBlend));
    const next = this.baseFov + (this.config.adsFovDeg - this.baseFov) * t;
    if (Math.abs(this.camera.fov - next) > 0.01) {
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
    }
  }

  inCameraView(point: {x:number;y:number;z:number}): boolean {
    const p = new THREE.Vector3(point.x,point.y,point.z).project(this.camera);
    return Math.max(Math.abs(p.x),Math.abs(p.y),Math.abs(p.z)) <= 1;
  }

  get isCrouching(): boolean {
    return this.crouching;
  }
  getBodyBounds(): AABB {
    const p = this.position;
    const eye = this.getEyePosition(this.eyeWorld);
    const r = this.config.radius;
    return {
      min: { x: Math.min(p.x, eye.x) - r, y: p.y, z: Math.min(p.z, eye.z) - r },
      max: { x: Math.max(p.x, eye.x) + r, y: eye.y + this.config.lean.headRadius, z: Math.max(p.z, eye.z) + r },
    };
  }
  get moveMode(): MoveMode {
    return this.mode;
  }
  get isMoving(): boolean {
    return this.moving;
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    if (!this.alive) {
      this.input.consumeMouseDelta();
      this.moving = false;
      this.applyCamera();
      return;
    }
    const dt = Math.min(rawDt, MAX_DT);
    const cfg = this.config;

    // 視点
    const md = this.input.consumeMouseDelta();
    const settings = getSettings();
    const sens = cfg.mouseSensitivity * settings.mouseSensitivity;
    const ySign = settings.invertY ? -1 : 1;
    this.yaw -= md.x * sens;
    const maxPitch = cfg.maxPitchDeg * DEG2RAD;
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch - md.y * sens * ySign));

    // しゃがみ（押している間）
    this.crouching = this.input.isDown('crouch');

    // 入力方向（ローカル: x=右, z=前）
    const fwd = (this.input.isDown('moveForward') ? 1 : 0) - (this.input.isDown('moveBackward') ? 1 : 0);
    const right = (this.input.isDown('moveRight') ? 1 : 0) - (this.input.isDown('moveLeft') ? 1 : 0);
    this.mode = this.crouching ? 'crouch' : this.input.isDown('walk') ? 'quiet' : 'run';

    const len = Math.hypot(fwd, right);
    this.moving = len > 0;
    if (this.moving) {
      const speed = cfg.speeds[this.mode] * this.speedMultiplier;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // forward = (-sin, -cos), right = (cos, -sin)
      const vx = ((right * cos - fwd * sin) / len) * speed;
      const vz = ((-right * sin - fwd * cos) / len) * speed;
      this.moveWithCollision(vx * dt, vz * dt);
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = cfg.footstep.interval[this.mode];
        this.bus.emit('noise', {
          pos: { x: this.position.x, y: this.position.y, z: this.position.z },
          radius: cfg.footstep.radius[this.mode],
          kind: 'footstep',
          source: 'player',
        });
      }
    } else {
      this.stepTimer = 0; // 停止後の最初の一歩で即座に音が出る
    }
    this.applyFooting(dt);

    // 目線高さ補間（dt 基準・指数減衰）
    const target = this.crouching ? cfg.crouchEyeHeight : cfg.standEyeHeight;
    this.eyeHeight += (target - this.eyeHeight) * (1 - Math.exp(-cfg.eyeHeightLerpSpeed * dt));
    // リーン（Q=左 / E=右、同時押しは相殺）
    const leanDir = (this.input.isDown('leanRight') ? 1 : 0) - (this.input.isDown('leanLeft') ? 1 : 0);
    let leanTarget = 0;
    if (leanDir !== 0) {
      const limit = this.leanClearance(leanDir, cfg.lean.maxOffset);
      leanTarget = leanDir * limit;
    }
    this.leanOffset += (leanTarget - this.leanOffset) * (1 - Math.exp(-cfg.lean.lerpSpeed * dt));
    // 補間中に壁へ近づいた場合も、現在位置を許容量内へ押し戻す（壁越しに覗かせない）
    if (this.leanOffset !== 0) {
      const dir = Math.sign(this.leanOffset);
      const lim = this.leanClearance(dir, Math.abs(this.leanOffset));
      if (Math.abs(this.leanOffset) > lim) this.leanOffset = dir * lim;
    }
    this.applyCamera();
  }

  /** 視点の向き（ラジアン）。射撃方向の算出用。 */
  get yawRad(): number {
    return this.yaw;
  }
  get pitchRad(): number {
    return this.pitch;
  }

  /** リコイル等による視点の相対回転（ラジアン）。ピッチは上限内にクランプ。 */
  addViewKick(pitchRad: number, yawRad: number): void {
    const maxPitch = this.config.maxPitchDeg * DEG2RAD;
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch + pitchRad));
    this.yaw += yawRad;
  }

  /** リーン込みの目線位置（射撃原点用）。毎回カメラと同じ値を返す。 */
  getEyePosition(out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    return out.set(
      this.position.x + rx * this.leanOffset,
      this.position.y + this.eyeHeight,
      this.position.z + rz * this.leanOffset,
    );
  }

  /** 現在のリーン量（-1=左 〜 1=右、正規化） */
  get leanAmount(): number {
    return this.config.lean.maxOffset > 0 ? this.leanOffset / this.config.lean.maxOffset : 0;
  }

  /**
   * 体の中心(目線高さ)から右方向 dir(±1) へ最大 want[m] まで頭を出せる距離を返す。
   * 壁/遮蔽物の AABB へのレイキャスト(XZ スラブ法)で、頭半径分のクリアランスを確保する。
   */
  private leanClearance(dir: number, want: number): number {
    const eyeY = this.position.y + this.eyeHeight;
    const ox = this.position.x;
    const oz = this.position.z;
    const dx = Math.cos(this.yaw) * dir;
    const dz = -Math.sin(this.yaw) * dir;
    const margin = this.config.lean.headRadius;
    let maxT = want + margin;
    for (const c of this.colliders) {
      const a = c.aabb;
      if (eyeY < a.min.y || eyeY > a.max.y) continue;
      let t0 = 0;
      let t1 = maxT;
      let hit = true;
      for (const [o, d, mn, mx] of [
        [ox, dx, a.min.x, a.max.x],
        [oz, dz, a.min.z, a.max.z],
      ] as const) {
        if (Math.abs(d) < 1e-9) {
          if (o < mn || o > mx) hit = false;
        } else {
          let ta = (mn - o) / d;
          let tb = (mx - o) / d;
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
        }
      }
      if (hit && t0 <= t1) maxT = Math.min(maxT, t0);
    }
    return Math.max(0, Math.min(want, maxT - margin));
  }

  /**
   * 位置を変更（サブステップ分割で高速時のすり抜け防止）。円(XZ) vs AABB の押し出しでスライドする。
   * 支持面の無い位置（敷地外・地下の空隙）へは進入せず、X 単独 / Z 単独で支持がある軸だけスライドする。
   */
  private moveWithCollision(dx: number, dz: number): void {
    const r = this.config.radius;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (r * 0.5)));
    const sx = dx / steps;
    const sz = dz / steps;
    const p = this.position;
    for (let i = 0; i < steps; i++) {
      const ox = p.x;
      const oy = p.y;
      const oz = p.z;
      p.x += sx;
      p.z += sz;
      const s1 = probeGround(this.colliders, p.x, p.z, p.y, r, this.legacyGround);
      if (s1 !== null && s1 > p.y) p.y = s1;
      this.resolve(r);
      const s2 = probeGround(this.colliders, p.x, p.z, p.y, r, this.legacyGround);
      if (s2 !== null && s2 > p.y) p.y = s2;
      if (this.legacyGround || this.supported()) continue;
      let ok = false;
      for (const [ax, az] of [
        [sx, 0],
        [0, sz],
      ] as const) {
        if (ax === 0 && az === 0) continue;
        p.x = ox + ax;
        p.y = oy;
        p.z = oz + az;
        const sa1 = probeGround(this.colliders, p.x, p.z, p.y, r, this.legacyGround);
        if (sa1 !== null && sa1 > p.y) p.y = sa1;
        this.resolve(r);
        const sa2 = probeGround(this.colliders, p.x, p.z, p.y, r, this.legacyGround);
        if (sa2 !== null && sa2 > p.y) p.y = sa2;
        if (this.supported()) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        p.x = ox;
        p.y = oy;
        p.z = oz;
      }
    }
  }

  /** 現在の足元 (x,z) に実 floor / stair の支持面があるか。 */
  private supported(): boolean {
    const p = this.position;
    return probeGround(this.colliders, p.x, p.z, p.y, this.config.radius, false) !== null;
  }

  private resolve(r: number): void {
    const p = this.position;
    for (let pass = 0; pass < 3; pass++) {
      let pushed = false;
      for (const c of this.colliders) {
        const a = c.aabb;
        // 高さが重ならないコライダは無視（足元〜頭頂）
        if (a.max.y <= p.y + STEP_HEIGHT || a.min.y >= p.y + this.config.standEyeHeight) continue;
        const cx = Math.max(a.min.x, Math.min(p.x, a.max.x));
        const cz = Math.max(a.min.z, Math.min(p.z, a.max.z));
        const ox = p.x - cx;
        const oz = p.z - cz;
        const d2 = ox * ox + oz * oz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          p.x = cx + (ox / d) * r;
          p.z = cz + (oz / d) * r;
        } else {
          // 中心が AABB 内部: 最短の面から押し出す
          const l = p.x - a.min.x;
          const rt = a.max.x - p.x;
          const f = p.z - a.min.z;
          const b = a.max.z - p.z;
          const m = Math.min(l, rt, f, b);
          if (m === l) p.x = a.min.x - r;
          else if (m === rt) p.x = a.max.x + r;
          else if (m === f) p.z = a.min.z - r;
          else p.z = a.max.z + r;
        }
        pushed = true;
      }
      if (!pushed) break;
    }
  }

  /** 段差へ乗せ、支持が無ければ重力で落とす。支持面は floor / stair の上面。 */
  private applyFooting(dt: number): void {
    const p = this.position;
    const probed = probeGround(this.colliders, p.x, p.z, p.y, this.config.radius, this.legacyGround);
    if (probed === null) {
      // 押し出し等で無支持へ出た: 落下を続けず直前の有効支持位置へ戻す
      p.copy(this.lastValidPos);
      this.verticalVelocity = 0;
      return;
    }
    const support = probed;
    if (support + 0.02 >= p.y) {
      p.y = nextFootY(p.y, support, STEP_HEIGHT);
      this.verticalVelocity = 0;
      this.lastValidPos.copy(p);
      return;
    }
    this.verticalVelocity = Math.max(-12, this.verticalVelocity - 22 * dt);
    p.y += this.verticalVelocity * dt;
    if (p.y <= support) {
      p.y = support;
      this.verticalVelocity = 0;
      this.lastValidPos.copy(p);
    }
  }

  private applyCamera(): void {
    this.camera.position.copy(this.getEyePosition(this.eyeWorld));
    const roll = -this.leanAmount * this.config.lean.maxRollDeg * DEG2RAD; // 右リーンで右へ傾く
    this.camera.rotation.set(this.pitch, this.yaw, roll);
  }

  dispose(): void {
    this.disposed = true;
  }
}
