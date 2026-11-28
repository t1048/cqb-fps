import * as THREE from 'three';
import type { InputManager } from '../core/InputManager';
import type { GameEventBus } from '../core/events';
import type { WeaponDef } from '../core/types';
import type { PlayerController } from '../player/PlayerController';
import type { AABB, Collider } from '../world/WorldBuilder';
import { raycastColliders } from '../world/ColliderIndex';

const DEG2RAD = Math.PI / 180;
const MAX_DT = 0.05;
const PLAYER_ID = 'player';

/** 弾が当たる対象（標的ダミー・容疑者など）。箱は毎回問い合わせる（移動に追従）。 */
export interface HitTarget {
  id: string;
  getAABB(): AABB;
  /** 盾持ち: from から撃たれた弾が hit で盾に止められるか（足元・側面・背後は止まらない） */
  shieldBlocks?(from: { x: number; y: number; z: number }, hit: { x: number; y: number; z: number }): boolean;
}

export interface ShotResult {
  /** 命中点（壁・標的・最大射程の終点） */
  point: THREE.Vector3;
  /** 命中した標的 id（壁やミス時は null） */
  targetId: string | null;
  distance: number;
  /** 盾持ちの盾に止められた（ダメージなし） */
  shielded?: boolean;
}

/**
 * hitscan 射撃: 左クリック押下中に連射。
 * 拡散 = (ADS ? adsSpread : hipSpread) + (移動中 ? moveSpreadPenalty : 0)  ※停止で精度回復(ストッピング)
 * 反動 = 発射ごとに視点を上へ(+左右ランダム)キックし、蓄積分を recoilRecovery[度/秒] で元の照準へ戻す。
 * 全パラメータは weapons.json 駆動。
 */
export class WeaponSystem {
  private current: WeaponDef;
  /** 武器定義の写し（改造で要素を差し替える） */
  private readonly weapons: WeaponDef[];
  private readonly ammo = new Map<string, number>();
  /** 予備弾数（reserveMagazines 指定の武器のみ。未登録 = 無限） */
  private readonly reserve = new Map<string, number>();
  private cooldown = 0;
  private reloadLeft = 0;
  private reloadTotal = 0;
  private reloadEmpty = false;
  private recoilPitch = 0; // 蓄積した上向きキック（ラジアン）
  private recoilYaw = 0; // 蓄積した横キック（ラジアン、符号付き）
  /** 外部要因の拡散加算（度。ペッパーボールで目が開けられない等） */
  extraSpread = 0;
  private currentSpread = 0; // 直近の有効拡散（度、HUD/検証用）
  private readonly targets = new Set<HitTarget>();
  private readonly origin = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly box = new THREE.Box3();
  private readonly hitPoint = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly quat = new THREE.Quaternion();
  private disposed = false;
  /** true の間は発射・リロードを無効化（フラッシュバン構え中など）。 */
  suppressFire = false;
  /** 別の装備（オプティワンド等）が射撃・リロードを塞いでいるか。フラッシュバンの suppressFire とは独立 */
  externalFireBlock = false;

  /** 救急処置中（MedkitUse が設定）。suppressFire・externalFireBlock とは別の旗 */
  healBlock = false;

  private get fireBlocked(): boolean {
    return this.suppressFire || this.externalFireBlock || this.healBlock;
  }

  constructor(
    private readonly player: PlayerController,
    private readonly input: InputManager,
    private readonly colliders: readonly Collider[],
    weapons: readonly WeaponDef[],
    private readonly bus: GameEventBus,
  ) {
    this.weapons = [...weapons];
    const first = weapons.find((w) => w.category !== 'throwable');
    if (!first) throw new Error('[WeaponSystem] no fireable weapon defined in weapons.json');
    this.current = first;
    for (const w of weapons) {
      this.ammo.set(w.id, w.magazineSize);
      if (w.reserveMagazines !== undefined) this.reserve.set(w.id, w.reserveMagazines * w.magazineSize);
    }
  }

  /** 現在武器の予備弾数（無限なら null） */
  get reserveAmmo(): number | null {
    return this.reserve.get(this.current.id) ?? null;
  }

  /** 武器を改造する（容疑者モードの籠城準備）。定義は共有なので写しに差し替える。 */
  upgradeWeapons(patch: (w: WeaponDef) => Partial<WeaponDef> | null): void {
    const list = this.weapons;
    for (let i = 0; i < list.length; i++) {
      const w = list[i]!;
      const p = patch(w);
      if (!p) continue;
      const next = { ...w, ...p };
      list[i] = next;
      if (this.current === w) this.current = next;
    }
  }

  /** 予備弾を追加（有限弾数の主武器すべてに magazines 本分）。 */
  addReserveMagazines(magazines: number): void {
    for (const w of this.weapons) {
      const r = this.reserve.get(w.id);
      if (r !== undefined) this.reserve.set(w.id, r + magazines * w.magazineSize);
    }
  }

  private canReload(w: WeaponDef): boolean {
    const r = this.reserve.get(w.id);
    return r === undefined || r > 0;
  }

  get weapon(): WeaponDef {
    return this.current;
  }
  get isReloading(): boolean {
    return this.reloadLeft > 0;
  }
  /** リロード進捗 0..1（リロード中でなければ null）。一人称モーション用。 */
  get reloadProgress(): number | null {
    if (this.reloadLeft <= 0 || this.reloadTotal <= 0) return null;
    return 1 - this.reloadLeft / this.reloadTotal;
  }
  /** 弾倉が空の状態から始めたリロードか */
  get reloadFromEmpty(): boolean {
    return this.reloadEmpty;
  }
  private startReload(w: WeaponDef): void {
    const reloadSec = w.reloadTime * (this.player.reloadTimeMul ?? 1);
    this.reloadLeft = reloadSec;
    this.reloadTotal = reloadSec;
    this.reloadEmpty = this.ammoInMagazine === 0;
    const p = this.player.position;
    this.bus.emit('noise', {
      pos: { x: p.x, y: p.y + 1.0, z: p.z },
      radius: 12,
      kind: 'reload',
      source: 'player',
    });
  }
  get ammoInMagazine(): number {
    return this.ammo.get(this.current.id) ?? 0;
  }
  /** 現在の有効拡散（度） */
  get spreadDeg(): number {
    return this.currentSpread;
  }

  addTarget(t: HitTarget): void {
    this.targets.add(t);
  }
  removeTarget(t: HitTarget): void {
    this.targets.delete(t);
  }

  /** 現在の状態での拡散（度）。基本精度は旧ADS同等、移動中は moveSpreadPenalty が加算される。 */
  computeSpread(): number {
    const w = this.current;
    return w.adsSpread + (this.player.isMoving ? w.moveSpreadPenalty : 0) + this.extraSpread + (this.player.woundSpreadAdd ?? 0) + (this.player.fatigueSpreadAdd ?? 0);
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    if (!this.player.alive) {
      this.player.speedMultiplier = 1;
      this.extraSpread = 0;
      return;
    }
    const dt = Math.min(rawDt, MAX_DT);
    const w = this.current;

    if (!this.input.isOrderMenuOpen) this.handleSlotSwitch();
    this.player.speedMultiplier = 1;

    this.currentSpread = this.computeSpread();

    // リロード
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0;
        const r = this.reserve.get(w.id);
        if (r === undefined) {
          this.ammo.set(w.id, w.magazineSize);
        } else {
          const take = Math.min(r, w.magazineSize - this.ammoInMagazine);
          this.reserve.set(w.id, r - take);
          this.ammo.set(w.id, this.ammoInMagazine + take);
        }
      }
    } else if (!this.fireBlocked && this.input.wasPressed('reload') && this.ammoInMagazine < w.magazineSize && this.canReload(w)) {
      this.startReload(w);
    }

    // 連射
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (!this.fireBlocked && this.input.isPointerLocked && this.input.isMouseDown(0) && this.reloadLeft <= 0 && this.cooldown <= 0) {
      if (this.ammoInMagazine > 0) {
        this.fire();
        this.cooldown = 1 / w.fireRate;
      } else if (this.canReload(w)) {
        this.startReload(w); // 弾切れで自動リロード
      }
    }

    this.recoverRecoil(dt);
    // PepperEffect / TearGasEffect が次フレーム向けに += 加算できるようフレーム末でリセット
    this.extraSpread = 0;
  }

  /** 1発発射（視点方向 + 拡散）。テストや外部からも呼べる。 */
  fire(): ShotResult {
    const w = this.current;
    this.ammo.set(w.id, Math.max(0, this.ammoInMagazine - 1));

    const spread = this.computeSpread();
    this.currentSpread = spread;
    this.player.getEyePosition(this.origin);
    this.computeShotDirection(spread);
    const result = this.trace(this.origin, this.dir, w.range);

    const pos = { x: this.origin.x, y: this.origin.y, z: this.origin.z };
    this.bus.emit('shotFired', { shooter: PLAYER_ID, pos });
    this.bus.emit('noise', { pos, radius: w.noiseRadius, kind: 'gunshot' });
    if (result.targetId === null && result.distance < w.range - 1e-3 && w.damage > 0) {
      this.bus.emit('bulletImpact', { shooter: PLAYER_ID, pos: { x: result.point.x, y: result.point.y, z: result.point.z }, damage: w.damage });
    }
    if (result.targetId !== null) {
      this.bus.emit('entityHit', {
        targetId: result.targetId,
        shooter: PLAYER_ID,
        damage: w.damage,
        pos: { x: result.point.x, y: result.point.y, z: result.point.z },
        weaponId: w.id,
        ...(w.category === 'nonlethal' ? { nonlethal: true, moraleScale: w.moraleDamage / 50 } : {}),
      });
    }

    this.applyRecoil();
    return result;
  }

  /** origin から dir へ最大 range までのレイを壁/遮蔽物/標的に対して判定し、最も近い命中を返す。 */
  trace(origin: THREE.Vector3, dir: THREE.Vector3, range: number): ShotResult {
    this.ray.origin.copy(origin);
    this.ray.direction.copy(dir);
    let best = raycastColliders(this.colliders, origin, dir, range);
    let bestId: string | null = null;
    let shielded = false;
    for (const t of this.targets) {
      const d = this.rayDistance(t.getAABB());
      if (d !== null && d < best) {
        if (t.shieldBlocks) {
          this.ray.at(d, this.hitPoint);
          if (t.shieldBlocks(origin, this.hitPoint)) {
            best = d;
            bestId = null;
            shielded = true;
            continue;
          }
        }
        best = d;
        bestId = t.id;
        shielded = false;
      }
    }
    this.ray.at(best, this.hitPoint);
    return { point: this.hitPoint.clone(), targetId: bestId, distance: best, ...(shielded ? { shielded: true } : {}) };
  }

  private rayDistance(a: AABB): number | null {
    this.box.min.set(a.min.x, a.min.y, a.min.z);
    this.box.max.set(a.max.x, a.max.y, a.max.z);
    const hit = this.ray.intersectBox(this.box, this.hitPoint);
    return hit ? this.hitPoint.distanceTo(this.ray.origin) : null;
  }

  /** 視点方向を中心に、円錐(半角=spread度)内へ一様ランダムに散らす。 */
  private computeShotDirection(spreadDeg: number): void {
    this.euler.set(this.player.pitchRad, this.player.yawRad, 0, 'YXZ');
    this.quat.setFromEuler(this.euler);
    const angle = Math.acos(1 - Math.random() * (1 - Math.cos(spreadDeg * DEG2RAD)));
    const around = Math.random() * Math.PI * 2;
    this.dir
      .set(Math.sin(angle) * Math.cos(around), Math.sin(angle) * Math.sin(around), -Math.cos(angle))
      .applyQuaternion(this.quat)
      .normalize();
  }

  private applyRecoil(): void {
    const w = this.current;
    const pitch = w.recoilPitch * DEG2RAD * 0.75;
    const yaw = (Math.random() * 2 - 1) * w.recoilYawRange * DEG2RAD * 0.75;
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    this.player.addViewKick(pitch, yaw);
  }

  /** 蓄積反動を recoilRecovery[度/秒] で 0 へ戻す（dt 基準）。 */
  private recoverRecoil(dt: number): void {
    if (this.recoilPitch === 0 && this.recoilYaw === 0) return;
    const step = this.current.recoilRecovery * DEG2RAD * dt;
    const mag = Math.hypot(this.recoilPitch, this.recoilYaw);
    if (mag <= step) {
      this.player.addViewKick(-this.recoilPitch, -this.recoilYaw);
      this.recoilPitch = 0;
      this.recoilYaw = 0;
      return;
    }
    const k = step / mag;
    const dp = this.recoilPitch * k;
    const dy = this.recoilYaw * k;
    this.recoilPitch -= dp;
    this.recoilYaw -= dy;
    this.player.addViewKick(-dp, -dy);
  }

  /** 数字キー: 同スロットに複数あれば順番に切替。リロード中は不可。 */
  private handleSlotSwitch(): void {
    if (this.reloadLeft > 0) return;
    for (let slot = 1; slot <= 3; slot++) {
      if (!this.input.wasPressed(`slot${slot}`)) continue;
      const list = this.weapons.filter((x) => x.slot === slot && x.category !== 'throwable');
      if (list.length === 0) return;
      const idx = list.findIndex((x) => x.id === this.current.id);
      this.current = list[(idx + 1) % list.length];
      this.cooldown = 0;
      return;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.player.speedMultiplier = 1;
    this.extraSpread = 0;
    this.targets.clear();
    this.ammo.clear();
  }
}
