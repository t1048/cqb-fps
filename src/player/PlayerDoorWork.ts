import * as THREE from 'three';
import type { EntityManager } from '../ai/EntityManager';
import {
  SWAT_C2_BLAST_HALF_ANGLE_DEG,
  SWAT_C2_BLAST_RADIUS,
  SWAT_C2_FUSE_SEC,
  SWAT_C2_MAX_DAMAGE,
  SWAT_C2_PLANT_SEC,
} from '../ai/SwatProfile';
import { t } from '../core/i18n';
import type { GameEventBus } from '../core/events';
import type { DoorCheckConfig, DoorTrapConfig, Vec3 } from '../core/types';
import type { InputManager } from '../core/InputManager';
import type { Subtitle } from '../ui/Subtitle';
import type { Door, DoorSystem } from '../world/Door';
import { SAFE_DISARM_MAX_DEG, SAFE_DISARM_PEEK_DEG, type DoorTrapSystem } from '../world/DoorTraps';
import type { Interaction } from './Interaction';
import type { PlayerController } from './PlayerController';

/** ドア操作（F）の優先度。ドア開閉(200)の上、逮捕などの人対象(300〜)の下 */
const DOOR_WORK_PRIORITY = 210;
/** F をこの秒数より短く離したら通常の開閉（タップ） */
const TAP_SEC = 0.25;
/** ドアチェック・罠解除・C2 設置の対象にできる距離(m) */
const WORK_RANGE = 2.4;
const C2_RANGE = 2.6;
const URGENT_AT_SEC = 1.1;
const BEEP_INTERVAL = 0.45;
const URGENT_BEEP_INTERVAL = 0.2;
const FIREBALL_GEO = new THREE.SphereGeometry(1, 10, 8);

export interface PlayerDoorWorkDeps {
  player: PlayerController;
  input: InputManager;
  interaction: Interaction;
  doors: DoorSystem;
  traps: DoorTrapSystem;
  entities: EntityManager;
  bus: GameEventBus;
  subtitle: Subtitle;
  root: THREE.Object3D;
  check: DoorCheckConfig;
  trap: DoorTrapConfig;
  rand?: () => number;
  /** C2 爆破ブリーチが解放済みか（未指定は true） */
  allowC2?: boolean;
  /** キーピック解錠の所要秒数（未指定は 3.0 秒） */
  lockpickSec?: number;
}

interface PlantedC2 {
  door: Door;
  /** 設置時にプレイヤーがいた側（1 / -1）。爆風は反対側へ向かう */
  side: number;
  fuse: number;
  beepT: number;
}

/**
 * プレイヤー自身によるドア作業（SWAT モード）。分隊・SWAT AI と同じ手段をそろえる。
 *  - F 長押し（閉じたドア）: ドアチェック（施錠と罠を確認。見落とすこともある）→ 罠が見つかっていれば解除
 *  - F タップ: 通常の開閉（従来どおり）
 *  - B: C2 爆薬の設置（無制限）。設置から数秒で起爆し、ドアを吹き飛ばして罠も無力化する
 * 罠は閉じたドアが開いたときに近くの SWAT 側全員（プレイヤー含む）を巻き込む。
 */
export class PlayerDoorWork {
  private readonly unreg: () => void;
  private readonly checked = new Map<string, { locked: boolean; trapFound: boolean }>();
  private readonly gaugeEl = document.createElement('div');
  private readonly gaugeBar = document.createElement('div');
  private readonly gaugeTxt = document.createElement('div');
  private gaugeValue = -1;
  private gaugeText = '';
  private workKind: 'check' | 'disarm' | 'lockpick' | 'c2' | null = null;
  private lastWorkKind: 'check' | 'disarm' | 'lockpick' | 'c2' | null = null;
  private done = false;
  /** 現在ワイヤー切断解除中のドア（安全ピーク角度まで開いている間も解決を維持する） */
  private disarmingDoor: Door | null = null;
  private planting: { door: Door; side: number; sec: number } | null = null;
  private readonly planted: PlantedC2[] = [];
  private readonly blasts: { mesh: THREE.Mesh; t: number }[] = [];
  private disposed = false;

  constructor(private readonly d: PlayerDoorWorkDeps) {
    this.gaugeEl.style.cssText =
      'position:fixed;left:50%;top:58%;transform:translateX(-50%);width:220px;text-align:center;color:#fff;font:bold 14px sans-serif;pointer-events:none;display:none;z-index:5';
    const track = document.createElement('div');
    track.style.cssText = 'height:8px;margin-top:4px;background:rgba(0,0,0,.6);border:1px solid #fff';
    this.gaugeBar.style.cssText = 'height:100%;width:0;background:#fb4';
    track.appendChild(this.gaugeBar);
    this.gaugeEl.append(this.gaugeTxt, track);
    document.body.appendChild(this.gaugeEl);

    this.unreg = d.interaction.register<Door>({
      id: 'doorWork',
      priority: DOOR_WORK_PRIORITY,
      resolve: () => this.resolveClosedDoor(WORK_RANGE),
      label: (door) => this.label(door),
      onPress: () => {
        this.done = false;
      },
      onHold: (door, _dt, sec) => this.hold(door, sec),
      onRelease: (door, sec) => {
        if (this.disarmingDoor === door) {
          this.cancelDisarm(door);
        }
        if (!this.done && sec < TAP_SEC && !door.locked) {
          door.toggle(true, this.d.player.position.x, this.d.player.position.z);
        }
        this.done = false;
      },
      onWheel: (door, steps) => {
        const n = Math.min(Math.abs(steps), 2);
        for (let i = 0; i < n; i++) door.stepStage(steps < 0 ? 1 : -1, true, this.d.player.position.x, this.d.player.position.z);
      },
    });
  }

  private rand(): number {
    return (this.d.rand ?? Math.random)();
  }

  private get c2Allowed(): boolean {
    return this.d.allowC2 !== false;
  }

  private cancelDisarm(door: Door): void {
    this.disarmingDoor = null;
    if (this.d.traps.isDisarming?.(door.id)) {
      this.d.traps.endDisarm?.(door.id);
      if (door.angle > 0.5 || door.targetAngle > 0.5) {
        door.command?.(0, false, this.d.player.position.x, this.d.player.position.z);
      }
    }
  }

  private resolveClosedDoor(range: number): Door | null {
    if (this.disposed || !this.d.player.alive) return null;
    const door = this.d.doors.aimed(range);
    if (!door) return null;
    if (this.disarmingDoor === door && door.angle <= SAFE_DISARM_MAX_DEG && door.targetAngle <= SAFE_DISARM_MAX_DEG) {
      return door;
    }
    if (door.angle > 1 || door.targetAngle > 1) return null;
    return door;
  }

  private label(door: Door): string {
    const c2Hint = this.c2Allowed ? t(' / B C2', ' / B C2') : '';
    if (this.d.traps.isDiscovered(door.id)) {
      return this.c2Allowed
        ? t('罠あり！ F 長押し: 扉を少し開いてワイヤー切断 / B: C2 で吹き飛ばす', 'Trap! Hold F: Crack door & cut wire / B: Blow with C2')
        : t('罠あり！ F 長押し: 扉を少し開いてワイヤー切断', 'Trap! Hold F: Crack door & cut wire');
    }
    if (door.locked) {
      if (this.checked.get(door.id)?.locked) {
        return t(`ドア: 施錠 (F 長押し キーピック解錠 / G 蹴破り${c2Hint})`, `Door: Locked (Hold F Lockpick / G Kick${c2Hint})`);
      }
      return t(`ドア: 施錠 (G 蹴破り / F 長押し チェック→キーピック${c2Hint})`, `Door: Locked (G Kick / Hold F Check→Lockpick${c2Hint})`);
    }
    return t(`ドア: F 開閉 / F 長押し ドアチェック(罠・施錠)${c2Hint}`, `Door: F Open / Hold F Check (Trap & Lock)${c2Hint}`);
  }

  private hold(door: Door, sec: number): void {
    if (sec < TAP_SEC || this.done) return;
    const work = sec - TAP_SEC;
    if (this.d.traps.isDiscovered(door.id)) {
      if (this.disarmingDoor !== door) {
        this.disarmingDoor = door;
        this.d.traps.beginDisarm?.(door.id);
        if (door.locked) door.locked = false;
        door.command?.(SAFE_DISARM_PEEK_DEG, false, this.d.player.position.x, this.d.player.position.z);
      }
      const need = this.d.trap.disarmSec;
      this.workKind = 'disarm';
      this.showGauge(t('扉を少し開いてワイヤーを切断中...', 'Cracking door & cutting tripwire...'), work / need);
      if (work < need) return;
      this.done = true;
      this.disarmingDoor = null;
      if (this.rand() < this.d.trap.failChance) {
        this.d.traps.endDisarm?.(door.id);
        this.d.subtitle.show(t('しまった、起爆した！', 'Damn, it blew!'), 1.6);
        this.d.traps.detonate(door.id);
      } else {
        this.d.traps.disarm(door.id);
        this.d.subtitle.show(t('ワイヤーを切断し、罠を解除した', 'Tripwire cut — trap disarmed'), 2.0);
      }
      return;
    }
    // チェック済みの施錠ドア（未発見/未設置）: キーピックで静かに解錠
    if (door.locked && this.checked.get(door.id)?.locked) {
      const need = this.d.lockpickSec ?? 3.0;
      this.workKind = 'lockpick';
      this.showGauge(t('キーピックで静かに解錠中...', 'Lockpicking door quietly...'), work / need);
      if (work < need) return;
      this.done = true;
      door.locked = false;
      this.checked.set(door.id, { locked: false, trapFound: false });
      this.d.subtitle.show(t('キーピックで解錠した', 'Door lockpicked'), 2.0);
      return;
    }
    const need = this.d.check.durationSec;
    this.workKind = 'check';
    this.showGauge(t('ドアチェック中（施錠・罠）...', 'Checking door (lock & trap)...'), work / need);
    if (work < need) return;
    this.done = true;
    const rigged = this.d.traps.isRigged(door.id);
    const found = rigged && this.rand() < this.d.check.detectChance;
    if (found) this.d.traps.discover(door.id);
    this.checked.set(door.id, { locked: door.locked, trapFound: found });
    this.d.subtitle.show(
      t(
        `ドアチェック: ${door.locked ? '施錠' : '未施錠'} / ${found ? '罠あり！' : '罠は見当たらない'}`,
        `Door check: ${door.locked ? 'Locked' : 'Unlocked'} / ${found ? 'Trapped!' : 'No trap seen'}`,
      ),
      3.0,
    );
  }

  private showGauge(text: string, value: number): void {
    this.gaugeValue = Math.max(0, Math.min(1, value));
    this.gaugeText = text;
  }

  /** 今フレーム実行中の作業種別（ドアチェック / 罠解除 / キーピック / C2 設置）。 */
  get activeWork(): 'check' | 'disarm' | 'lockpick' | 'c2' | null {
    return this.lastWorkKind;
  }

  /** 毎フレーム: ゲージ表示 / C2 の設置・信管・爆発演出 */
  update(dt: number): void {
    if (this.disposed) return;
    if (this.disarmingDoor && this.workKind !== 'disarm') {
      this.cancelDisarm(this.disarmingDoor);
    }
    this.updateC2(dt);
    this.lastWorkKind = this.planting ? 'c2' : this.workKind;
    this.workKind = null;
    if (this.gaugeValue >= 0) {
      this.gaugeEl.style.display = 'block';
      this.gaugeTxt.textContent = this.gaugeText;
      this.gaugeBar.style.width = `${Math.round(this.gaugeValue * 100)}%`;
    } else {
      this.gaugeEl.style.display = 'none';
    }
    this.gaugeValue = -1; // 次フレームも保持されていなければ消える
  }

  private updateC2(dt: number): void {
    const p = this.d.player;
    const pl = this.planting;
    if (pl) {
      // 設置中: 対象のドアから離れる・ドアが開く・B を離す で中断
      const near = Math.hypot(p.position.x - pl.door.centerX, p.position.z - pl.door.centerZ) <= C2_RANGE + 0.6;
      if (!this.d.input.isDown('c2') || !near || pl.door.angle > 1 || !p.alive) {
        this.planting = null;
      } else {
        pl.sec += dt;
        this.showGauge(t('C2 爆薬を設置中...', 'Planting C2...'), pl.sec / SWAT_C2_PLANT_SEC);
        if (pl.sec >= SWAT_C2_PLANT_SEC) {
          this.planting = null;
          this.planted.push({ door: pl.door, side: pl.side, fuse: SWAT_C2_FUSE_SEC, beepT: 0 });
          this.d.subtitle.show(t('C2 設置！ 離れろ！', 'C2 set! Clear out!'), 1.8);
          this.emitBeep(pl.door, false);
        }
      }
    } else if (this.c2Allowed && this.d.input.isPointerLocked && this.d.input.wasPressed('c2')) {
      const door = this.resolveClosedDoor(C2_RANGE);
      if (door && !this.planted.some((c) => c.door === door)) {
        const side = (p.position.x - door.centerX) * door.normalX + (p.position.z - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
        this.planting = { door, side, sec: 0 };
      }
    }

    for (let i = this.planted.length - 1; i >= 0; i--) {
      const c = this.planted[i]!;
      if (c.door.angle > 5 || c.door.targetAngle > 5) {
        this.planted.splice(i, 1); // 先に開けられた/蹴破られた
        continue;
      }
      c.fuse -= dt;
      c.beepT += dt;
      const urgent = c.fuse <= URGENT_AT_SEC;
      if (c.beepT >= (urgent ? URGENT_BEEP_INTERVAL : BEEP_INTERVAL)) {
        c.beepT = 0;
        this.emitBeep(c.door, urgent);
      }
      if (c.fuse <= 0) {
        this.planted.splice(i, 1);
        this.detonate(c);
      }
    }

    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i]!;
      b.t += dt;
      if (b.t < 0.45) {
        b.mesh.scale.setScalar(0.45 * (1 + b.t * 5.2));
        (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - b.t / 0.45));
      } else {
        b.mesh.visible = false;
      }
      if (b.t > 0.55) {
        this.d.root.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        this.blasts.splice(i, 1);
      }
    }
  }

  private emitBeep(door: Door, urgent: boolean): void {
    this.d.bus.emit('c2Beep', { pos: { x: door.centerX, y: door.sillY + 1.0, z: door.centerZ }, urgent });
  }

  private detonate(c: PlantedC2): void {
    const door = c.door;
    const p = this.d.player.position;
    // C2 の爆風はドアのブービートラップを安全に吹き飛ばす
    this.d.traps.destroy(door.id);
    door.breachExplosive(p.x, p.z);
    const dir: Vec3 = { x: -door.normalX * c.side, y: 0, z: -door.normalZ * c.side };
    const center: Vec3 = { x: door.centerX, y: door.sillY + 1.0, z: door.centerZ };
    this.d.bus.emit('c2Detonated', { doorId: door.id, pos: center, dir, radius: SWAT_C2_BLAST_RADIUS });
    this.d.bus.emit('noise', { pos: center, radius: 42, kind: 'breach', source: 'ally' });
    const mesh = new THREE.Mesh(
      FIREBALL_GEO,
      new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    mesh.scale.setScalar(0.45);
    mesh.position.set(center.x + dir.x * 0.45, center.y, center.z + dir.z * 0.45);
    this.d.root.add(mesh);
    this.blasts.push({ mesh, t: 0 });
    // 爆風コーン内の敵対容疑者へダメージ/スタン（民間人・投降者・味方は保護）
    this.d.entities.applyC2Blast(center, dir, SWAT_C2_BLAST_RADIUS, SWAT_C2_BLAST_HALF_ANGLE_DEG, SWAT_C2_MAX_DAMAGE, 'player');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unreg();
    for (const b of this.blasts) {
      this.d.root.remove(b.mesh);
      (b.mesh.material as THREE.Material).dispose();
    }
    this.blasts.length = 0;
    this.planted.length = 0;
    this.gaugeEl.remove();
  }
}
