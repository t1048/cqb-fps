import * as THREE from 'three';
import type { Civilian } from '../ai/Civilian';
import type { Suspect } from '../ai/Suspect';
import type { GameEventBus } from '../core/events';
import { SuspectState } from '../core/events';
import { getLocale, isEn, t } from '../core/i18n';
import type { Vec3, WindowDef } from '../core/types';
import type { InputManager } from '../core/InputManager';
import type { Interaction } from '../player/Interaction';
import type { PlayerController } from '../player/PlayerController';
import type { Subtitle } from '../ui/Subtitle';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import { invalidateColliderIndex } from '../world/ColliderIndex';
import type { Door, DoorSystem } from '../world/Door';
import type { TextureLibrary } from '../world/Materials';
import type { Collider } from '../world/WorldBuilder';
import type { SuspectLoadout } from './SuspectLoadout';

const DEG = Math.PI / 180;
/** 窓を板で塞ぐのに要する長押し秒数（プレイヤー） */
const BOARD_SEC = 2.4;
/** 板を外す長押し秒数 */
const UNBOARD_SEC = 1.2;
/** しゃがみ + F 長押しでドアにトラップを仕掛ける秒数 */
const TRAP_SEC = 2.0;
const WINDOW_REACH = 1.7;
/** 仲間 1 人あたりの準備作業量（/秒）。武器改造 = 16、トラップ 1 個 = 9 */
const ALLY_WORK_RATE = 1;
const COST_UPGRADE = 16;
const COST_TRAP = 9;
const BASE_TRAPS = 2;
/** 仲間が準備中に製作するトラップ数の既定値 */
const BASE_CRAFTED_TRAPS = 2;
/** 爆発の致傷半径（m） */
export const TRAP_BLAST_RADIUS = 3.4;
const DISABLED_Y = -1000;
/** バリケードの基本耐久（改造拳銃 19 で約 9 発、SWAT 12 で約 14 発）。持ち込んだ補強材の倍率を掛ける */
const BARRICADE_HP = 170;

/** SWAT が窓バリケードを認識・破壊するための読み取り専用スナップショット */
export interface BarricadeInfo {
  id: string;
  center: Vec3;
  normal: Vec3;
  floorY: number;
  hp: number;
  boarded: boolean;
}

/** SwatTeam に渡すバリケード問い合わせフック */
export interface BarricadeHooks {
  listBoarded(): BarricadeInfo[];
}

interface Barricade {
  id: string;
  def: WindowDef;
  collider: Collider;
  /** 有効時の AABB */
  on: Collider['aabb'];
  mesh: THREE.Group;
  built: boolean;
  boarded: boolean;
  hp: number;
  /** 被弾で剥がれ落ちる板（裏板は壊れるまで残り、視線を通さない） */
  planks: THREE.Mesh[];
  floorY: number;
  cx: number;
  cy: number;
  cz: number;
  /** 窓面の法線（水平単位ベクトル） */
  normal: Vec3;
  /** 開口の向き（窓の面に沿う方向） */
  alongX: boolean;
}

export interface DoorTrap {
  doorId: string;
  mesh: THREE.Group;
}

/** SwatTeam が爆発に巻き込まれた隊員へ被害を与えるためのフック */
export interface BlastReceiver {
  applyBlast(pos: Vec3, radius: number): void;
}

type PrepTask = { kind: 'upgrade' } | { kind: 'trap' };

export interface FortifyDeps {
  windows: readonly WindowDef[];
  colliders: Collider[];
  scene: THREE.Object3D;
  textures: TextureLibrary;
  player: PlayerController;
  input: InputManager;
  interaction: Interaction;
  doors: DoorSystem;
  subtitle: Subtitle;
  bus: GameEventBus;
  weapons: WeaponSystem;
  /** 味方容疑者 NPC */
  allies: () => Iterable<Suspect>;
  civilians: () => Iterable<Civilian>;
  /** SWAT の突入地点（窓の補強はここに近い順） */
  entry: Vec3;
  /** 突入前（準備中）か */
  isPrep: () => boolean;
  showGauge: (label: string, ratio: number) => void;
  /** 民間人が爆発で死亡した（減点用） */
  onCivilianKilled: (c: Civilian) => void;
  /** 建物の規模に応じた持ち込み装備（未指定 = 小さな民家相当の従来値） */
  loadout?: Pick<SuspectLoadout, 'trapKits' | 'craftedTraps' | 'barricadeHpMul'>;
}

/**
 * 容疑者モードの籠城準備。
 * - 窓（外窓・室内の窓口）を板で塞ぐ: 視線・射線を遮る（F 長押し。もう一度で外す）。自動では張られない（自分で張る）
 * - ドアにブービートラップ（しゃがみ + F 長押し）: SWAT が開ける / ブリーチすると爆発。SWAT は気付けば解除に時間を取られる
 * - 時間を稼ぐと仲間が武器を改造（全員の武器が強化）し、トラップの部材も増える
 */
export class Fortify {
  readonly root = new THREE.Group();
  private readonly barricades: Barricade[] = [];
  private boardedCountNum = 0;
  private boardedCache: BarricadeInfo[] = [];
  private boardedDirty = false;
  private readonly traps = new Map<string, DoorTrap>();
  private trapKits: number;
  /** 窓バリケード 1 枚の最大耐久（BARRICADE_HP × 補強材倍率） */
  private readonly barricadeHp: number;
  private readonly tasks: PrepTask[] = [];
  private work = 0;
  private upgraded = false;
  private receiver: BlastReceiver | null = null;
  private readonly el = document.createElement('div');
  private lastText = '';
  private lastStatusSig = '';
  private holdDone = false;
  private readonly blasts: { mesh: THREE.Mesh; t: number }[] = [];
  private readonly unsubs: (() => void)[] = [];
  private readonly unitBoxGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly blastGeo = new THREE.SphereGeometry(1, 10, 8);
  private readonly eye = new THREE.Vector3();
  private readonly woodMat: THREE.MeshStandardMaterial;
  private readonly backMat: THREE.MeshStandardMaterial;
  private readonly trapMat = new THREE.MeshStandardMaterial({ color: 0x3a3a2a, roughness: 0.7 });
  private readonly ledMat = new THREE.MeshBasicMaterial({ color: 0xff3020 });

  constructor(private readonly d: FortifyDeps) {
    this.root.name = 'fortify';
    d.scene.add(this.root);
    this.woodMat = new THREE.MeshStandardMaterial({ map: d.textures.get('wood'), color: 0x9a7a52, roughness: 0.85 });
    this.backMat = new THREE.MeshStandardMaterial({ map: d.textures.get('wood'), color: 0x6e5236, roughness: 0.9 });
    this.trapKits = d.loadout?.trapKits ?? BASE_TRAPS;
    this.barricadeHp = Math.round(BARRICADE_HP * (d.loadout?.barricadeHpMul ?? 1));
    for (let i = 0; i < d.windows.length; i++) this.barricades.push(this.makeBarricade(d.windows[i]!, i));
    // 仲間の準備: 武器改造 → トラップ部材（窓のバリケードは自分で張る。自動では張らない）
    this.tasks.push({ kind: 'upgrade' });
    const crafted = d.loadout?.craftedTraps ?? BASE_CRAFTED_TRAPS;
    for (let i = 0; i < crafted; i++) this.tasks.push({ kind: 'trap' });

    this.el.style.cssText =
      'position:fixed;left:50%;top:52px;transform:translateX(-50%);z-index:6;pointer-events:none;padding:4px 12px;' +
      'background:rgba(0,0,0,.55);border:1px solid rgba(255,210,120,.45);border-radius:4px;color:#ffe9c2;font:12px sans-serif;' +
      'text-align:center;max-width:calc(100vw - 32px);box-sizing:border-box;display:none';
    document.body.appendChild(this.el);

    this.unsubs.push(
      d.bus.on('bulletImpact', (e) => this.onBulletImpact(e.pos, e.damage)),
      d.interaction.register<Barricade>({
        id: 'barricade',
        priority: 240,
        resolve: () => (this.d.player.alive ? this.aimedWindow() : null),
        label: (b) => {
          const pct = Math.max(0, Math.round((b.hp / this.barricadeHp) * 100));
          if (b.boarded) {
            return t(`窓: F 長押しで板を外す（耐久 ${pct}%）`, `Window: Hold F to Remove Boards (HP ${pct}%)`);
          }
          return b.def.interior
            ? t('窓口: F 長押しで板を打ち付ける（射線を塞ぐ）', 'Interior Window: Hold F to Board Up (Block LOS)')
            : t('窓: F 長押しで板を打ち付ける（射線を塞ぐ）', 'Window: Hold F to Board Up (Block LOS)');
        },
        onPress: () => {
          this.holdDone = false;
        },
        onHold: (b, _dt, sec) => {
          if (this.holdDone) return;
          const need = b.boarded ? UNBOARD_SEC : BOARD_SEC;
          this.d.showGauge(b.boarded ? t('板を外している...', 'Removing boards...') : t('板を打ち付けている...', 'Boarding up...'), sec / need);
          if (sec >= need) {
            this.holdDone = true;
            this.setBoarded(b, !b.boarded);
            this.d.subtitle.show(
              b.boarded
                ? t('窓を板で塞いだ — この窓越しには撃てない・見えない', 'Window boarded up — blocks sightlines and gunfire')
                : t('板を外した', 'Boards removed'),
              1.6,
            );
            this.d.bus.emit('noise', { pos: { x: b.cx, y: b.floorY, z: b.cz }, radius: 9, kind: 'door', source: 'suspect' });
          }
        },
        onRelease: () => {
          this.holdDone = false;
        },
      }),
    );
  }

  attachReceiver(r: BlastReceiver): void {
    this.receiver = r;
  }

  get trapsLeft(): number {
    return this.trapKits;
  }

  get boardedCount(): number {
    return this.boardedCountNum;
  }

  get windowCount(): number {
    return this.barricades.length;
  }

  get weaponUpgraded(): boolean {
    return this.upgraded;
  }

  isTrapped(doorId: string): boolean {
    return this.traps.has(doorId);
  }

  trappedDoorIds(): IterableIterator<string> {
    return this.traps.keys();
  }

  /** 現在板張りされている窓バリケードの一覧を返す（SwatTeam の積極破壊用） */
  listBoarded(): BarricadeInfo[] {
    if (this.boardedDirty) {
      this.boardedDirty = false;
      this.boardedCache = this.barricades
        .filter((b) => b.boarded)
        .map((b) => ({
          id: b.id,
          center: { x: b.cx, y: b.cy, z: b.cz },
          normal: { ...b.normal },
          floorY: b.floorY,
          hp: b.hp,
          boarded: b.boarded,
        }));
    }
    return this.boardedCache;
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? 'block' : 'none';
  }

  // ---------- 窓 ----------

  private makeBarricade(def: WindowDef, idx: number): Barricade {
    const floorY = def.y ?? 0;
    const cy = floorY + def.sill + def.height / 2;
    const alongX = Math.abs(Math.cos(def.yaw * DEG)) > 0.5;
    const normal: Vec3 = { x: -Math.sin(def.yaw * DEG), y: 0, z: Math.cos(def.yaw * DEG) };
    const hw = def.width / 2 + 0.06;
    const hd = 0.13;
    const hh = def.height / 2 + 0.06;
    const on = {
      min: { x: def.x - (alongX ? hw : hd), y: cy - hh, z: def.z - (alongX ? hd : hw) },
      max: { x: def.x + (alongX ? hw : hd), y: cy + hh, z: def.z + (alongX ? hd : hw) },
    };
    // 無効時は同じ XZ 範囲のまま地下深くへ逃がす（空間索引の登録範囲を変えない）
    const collider: Collider = {
      kind: 'wall',
      aabb: { min: { ...on.min, y: DISABLED_Y }, max: { ...on.max, y: DISABLED_Y + 0.01 } },
    };
    this.d.colliders.push(collider);
    const mesh = new THREE.Group();
    mesh.position.set(def.x, cy, def.z);
    mesh.rotation.y = def.yaw * DEG;
    mesh.visible = false;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    this.root.add(mesh);
    return {
      id: `barricade_${idx}`,
      def,
      collider,
      on,
      mesh,
      built: false,
      boarded: false,
      hp: 0,
      planks: [],
      floorY,
      cx: def.x,
      cy,
      cz: def.z,
      normal,
      alongX,
    };
  }

  /** 初回板張り時にのみ共有単位 BoxGeometry で板メッシュ群を生成する（未封鎖の窓はメッシュ 0）。 */
  private buildBarricadeMeshes(b: Barricade): void {
    b.built = true;
    const def = b.def;
    const coverW = def.width + 0.2;
    const coverH = def.height + 0.16;
    const planks = Math.max(3, Math.ceil(coverH / 0.16));
    const pitch = coverH / planks;
    for (const side of [-1, 1]) {
      const back = new THREE.Mesh(this.unitBoxGeo, this.backMat);
      back.position.set(0, 0, side * 0.095);
      back.scale.set(coverW, coverH, 0.02);
      back.userData.noShadow = true;
      back.castShadow = false;
      back.receiveShadow = true;
      back.updateMatrix();
      back.matrixAutoUpdate = false;
      b.mesh.add(back);
      for (let i = 0; i < planks; i++) {
        const m = new THREE.Mesh(this.unitBoxGeo, this.woodMat);
        const y = -coverH / 2 + pitch * (i + 0.5);
        m.position.set((Math.random() - 0.5) * 0.04, y, side * 0.115);
        m.rotation.z = (Math.random() - 0.5) * 0.025;
        m.scale.set(coverW + 0.04 + Math.random() * 0.06, pitch + 0.025, 0.03);
        m.userData.noShadow = true;
        m.castShadow = false;
        m.receiveShadow = true;
        m.updateMatrix();
        m.matrixAutoUpdate = false;
        b.mesh.add(m);
        b.planks.push(m);
      }
      const brace = new THREE.Mesh(this.unitBoxGeo, this.woodMat);
      brace.position.set(0, 0, side * 0.14);
      brace.rotation.z = Math.atan2(def.height, def.width) * (side > 0 ? 1 : -1);
      brace.scale.set(Math.hypot(def.width, def.height) * 0.95, 0.12, 0.03);
      brace.userData.noShadow = true;
      brace.castShadow = false;
      brace.receiveShadow = true;
      brace.updateMatrix();
      brace.matrixAutoUpdate = false;
      b.mesh.add(brace);
    }
  }

  private setBoarded(b: Barricade, v: boolean): void {
    if (v && !b.built) this.buildBarricadeMeshes(b);
    if (b.boarded !== v) {
      this.boardedCountNum += v ? 1 : -1;
    }
    b.boarded = v;
    b.mesh.visible = v;
    b.hp = v ? this.barricadeHp : 0;
    this.boardedDirty = true;
    for (const p of b.planks) p.visible = true;
    const a = b.collider.aabb;
    if (v) {
      a.min.y = b.on.min.y;
      a.max.y = b.on.max.y;
    } else {
      a.min.y = DISABLED_Y;
      a.max.y = DISABLED_Y + 0.01;
    }
  }

  /** 弾がバリケードに当たった: 耐久を削り、板が剥がれていく。0 で破られて視線・射線が通る */
  private onBulletImpact(pos: Vec3, damage: number): void {
    const eps = 0.05;
    for (const b of this.barricades) {
      if (!b.boarded) continue;
      const a = b.collider.aabb;
      if (pos.x < a.min.x - eps || pos.x > a.max.x + eps || pos.y < a.min.y - eps || pos.y > a.max.y + eps || pos.z < a.min.z - eps || pos.z > a.max.z + eps) continue;
      b.hp -= damage;
      if (b.hp <= 0) {
        this.setBoarded(b, false);
        this.d.bus.emit('noise', { pos: { x: b.cx, y: b.floorY, z: b.cz }, radius: 14, kind: 'door', source: 'suspect' });
        const p = this.d.player.position;
        if (Math.hypot(p.x - b.cx, p.z - b.cz) < 14) {
          this.d.subtitle.show(
            b.def.interior
              ? t('窓口のバリケードが撃ち破られた！', 'Interior window barricade shot through!')
              : t('窓のバリケードが撃ち破られた！', 'Window barricade shot through!'),
            1.6,
          );
        }
        return;
      }
      this.boardedDirty = true;
      // 残り耐久に応じて表板を剥がす（裏板は残るので視線は通らない）
      const keep = Math.ceil((b.hp / this.barricadeHp) * b.planks.length);
      const visible = b.planks.filter((m) => m.visible);
      while (visible.length > keep) {
        const i = Math.floor(Math.random() * visible.length);
        visible[i]!.visible = false;
        visible.splice(i, 1);
      }
      return;
    }
  }

  private aimedWindow(): Barricade | null {
    const p = this.d.player.position;
    const yaw = this.d.player.yawRad;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let best: Barricade | null = null;
    let bestD = WINDOW_REACH;
    for (const b of this.barricades) {
      if (Math.abs(p.y - b.floorY) > 0.8) continue;
      // 窓面までの距離（面に沿う方向は半幅まで許容）
      const dx = b.cx - p.x;
      const dz = b.cz - p.z;
      const along = b.alongX ? Math.abs(dx) : Math.abs(dz);
      const across = b.alongX ? Math.abs(dz) : Math.abs(dx);
      if (along > b.def.width / 2 + 0.4) continue;
      if (across > bestD) continue;
      const l = Math.hypot(dx, dz);
      if (l > 0.3 && (dx * fx + dz * fz) / l < 0.35) continue;
      best = b;
      bestD = across;
    }
    return best;
  }

  // ---------- ドアトラップ ----------

  /** SuspectMission のドア操作から呼ぶ: しゃがみ姿勢（C トグル）で F 長押し中か */
  wantsTrap(): boolean {
    return this.d.player.isCrouching;
  }

  /** 戻り値: 処理した（ゲージ表示中/設置完了）なら true */
  holdTrap(door: Door, sec: number): boolean {
    if (this.traps.has(door.id)) {
      this.d.showGauge(t('トラップ設置済み（SWAT が開けると爆発）', 'Trap already set (detonates when SWAT opens)'), 1);
      return true;
    }
    if (this.trapKits <= 0) {
      this.d.showGauge(t('トラップの部材がない（時間を稼ぐと仲間が作る）', 'No trap kits left (allies craft more if you buy time)'), 0);
      return true;
    }
    if (door.angle > 1 || door.targetAngle > 1) {
      this.d.showGauge(t('閉じたドアにしか仕掛けられない', 'Door must be closed to set trap'), 0);
      return true;
    }
    this.d.showGauge(t('ブービートラップを仕掛けている...', 'Rigging booby trap...'), sec / TRAP_SEC);
    if (sec >= TRAP_SEC) this.placeTrap(door);
    return true;
  }

  private placeTrap(door: Door): void {
    this.trapKits--;
    const g = new THREE.Group();
    const p = this.d.player.position;
    // プレイヤーがいる側（内側）のノブ付近に爆薬と赤 LED
    const side = (p.x - door.centerX) * door.normalX + (p.z - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
    g.position.set(door.centerX + door.normalX * side * 0.09, door.sillY + 0.95, door.centerZ + door.normalZ * side * 0.09);
    const box = new THREE.Mesh(this.unitBoxGeo, this.trapMat);
    box.scale.set(0.16, 0.12, 0.07);
    box.userData.noShadow = true;
    box.castShadow = false;
    box.updateMatrix();
    box.matrixAutoUpdate = false;
    g.add(box);
    const led = new THREE.Mesh(this.blastGeo, this.ledMat);
    led.position.set(0.05, 0.04, 0.04);
    led.scale.setScalar(0.014);
    led.userData.noShadow = true;
    led.castShadow = false;
    led.updateMatrix();
    led.matrixAutoUpdate = false;
    g.add(led);
    g.rotation.y = Math.atan2(door.normalX, door.normalZ);
    g.updateMatrix();
    g.matrixAutoUpdate = false;
    this.root.add(g);
    this.traps.set(door.id, { doorId: door.id, mesh: g });
    this.d.subtitle.show(
      t(
        `ドアにブービートラップを仕掛けた（残り部材 ${this.trapKits}）— SWAT が開けると爆発する`,
        `Booby trap rigged on door (${this.trapKits} kits left) — detonates when SWAT opens`,
      ),
      2.2,
    );
  }

  /** SWAT が解除に成功した */
  disarm(doorId: string): void {
    const t = this.traps.get(doorId);
    if (!t) return;
    this.traps.delete(doorId);
    this.root.remove(t.mesh);
  }

  /** トラップを起爆（SWAT が開けた / 解除失敗） */
  detonate(doorId: string): void {
    const t = this.traps.get(doorId);
    const door = this.d.doors.doors.find((x) => x.id === doorId);
    if (!t || !door) return;
    this.disarm(doorId);
    if (door.locked || door.angle < 1) door.breach(door.centerX + door.normalX, door.centerZ + door.normalZ, 'suspect');
    this.explode({ x: door.centerX, y: door.sillY, z: door.centerZ });
  }

  private explode(pos: Vec3): void {
    const r = TRAP_BLAST_RADIUS;
    const center = { x: pos.x, y: pos.y + 1, z: pos.z };
    // 見た目: 火球（動的ライトは使わず共有単位球＋MeshBasicMaterial のみで描画）
    const mesh = new THREE.Mesh(
      this.blastGeo,
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    mesh.position.set(center.x, center.y, center.z);
    mesh.scale.setScalar(0.2);
    this.root.add(mesh);
    this.blasts.push({ mesh, t: 0 });
    this.d.bus.emit('noise', { pos, radius: 45, kind: 'breach', source: 'suspect' });

    // 巻き込み: SWAT（SwatTeam 側で処理）・プレイヤー・民間人
    this.receiver?.applyBlast(center, r);
    const pl = this.d.player;
    if (pl.alive) {
      const e = pl.getEyePosition(this.eye);
      const dist = Math.hypot(e.x - center.x, e.y - center.y, e.z - center.z);
      if (dist < r * 1.8) pl.addViewKick((Math.random() * 0.06 + 0.03) * (1 - dist / (r * 1.8)), (Math.random() - 0.5) * 0.08);
      if (dist < r && hasLineOfSight(this.d.colliders, center, { x: e.x, y: e.y - 0.4, z: e.z })) {
        const dmg = Math.round(75 * (1 - 0.6 * (dist / r)));
        const hp = pl.takeDamage(dmg);
        this.d.bus.emit('playerHit', { shooter: 'trap', damage: dmg, from: pos, hp });
        this.d.subtitle.show(t('自分のトラップの爆風に巻き込まれた！', 'Caught in your own trap blast!'), 1.6);
      }
    }
    for (const c of this.d.civilians()) {
      if (!c.alive || c.evacuated) continue;
      const ch = c.body.chestPos();
      const dist = Math.hypot(ch.x - center.x, ch.y - center.y, ch.z - center.z);
      if (dist >= r || !hasLineOfSight(this.d.colliders, center, ch)) continue;
      if (c.damage(Math.round(110 * (1 - 0.6 * (dist / r))))) {
        this.d.weapons.removeTarget(c);
        this.d.onCivilianKilled(c);
      }
    }
  }

  // ---------- 更新 ----------

  update(rawDt: number): void {
    const dt = Math.min(rawDt, 0.05);
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i]!;
      b.t += dt;
      const k = b.t / 0.45;
      b.mesh.scale.setScalar(0.2 + 2.6 * Math.min(1, k));
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k));
      if (b.t > 0.65) {
        this.root.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        this.blasts.splice(i, 1);
      }
    }
    if (this.d.isPrep()) this.updatePrep(dt);
    this.renderStatus();
  }

  private countActiveAllies(): number {
    let count = 0;
    for (const s of this.d.allies()) {
      if (s.alive && s.state !== SuspectState.SURRENDER && s.state !== SuspectState.ARRESTED) count++;
    }
    return count;
  }

  private activeAllies(): Suspect[] {
    const out: Suspect[] = [];
    for (const s of this.d.allies()) {
      if (s.alive && s.state !== SuspectState.SURRENDER && s.state !== SuspectState.ARRESTED) out.push(s);
    }
    return out;
  }

  private updatePrep(dt: number): void {
    const allyCount = this.countActiveAllies();
    if (allyCount === 0) return;
    const task = this.tasks[0];
    if (!task) return;
    this.work += allyCount * ALLY_WORK_RATE * dt;
    const cost = task.kind === 'upgrade' ? COST_UPGRADE : COST_TRAP;
    if (this.work < cost) return;
    this.work -= cost;
    this.tasks.shift();
    if (task.kind === 'upgrade') {
      this.applyUpgrade(this.activeAllies());
    } else {
      this.trapKits++;
      this.d.subtitle.show(
        t(
          `仲間「トラップをもう 1 個こしらえた」（部材 ${this.trapKits}）`,
          `Ally: "Rigged up another trap kit!" (${this.trapKits} kits)`,
        ),
        1.6,
      );
    }
  }

  private applyUpgrade(allies: readonly Suspect[]): void {
    if (this.upgraded) return;
    this.upgraded = true;
    for (const s of allies) s.upgradeWeapon(1.3, 0.7);
    this.d.weapons.upgradeWeapons((w) =>
      w.faction === 'suspect'
        ? {
            name: `${w.name}${t('（改）', ' (Mod)')}`,
            damage: Math.round(w.damage * 1.25),
            magazineSize: Math.round(w.magazineSize * 1.4),
            adsSpread: w.adsSpread * 0.65,
            hipSpread: w.hipSpread * 0.65,
            moveSpreadPenalty: w.moveSpreadPenalty * 0.75,
            recoilPitch: w.recoilPitch * 0.7,
            recoilYawRange: w.recoilYawRange * 0.7,
          }
        : null,
    );
    this.d.subtitle.show(
      t(
        '仲間「全員の銃を改造した！ 精度も威力も上がったぞ」— 武器アップグレード',
        'Ally: "Modified all our guns! Better accuracy and firepower!" — Weapons Upgraded',
      ),
      2.4,
    );
  }

  private renderStatus(): void {
    const prep = this.d.isPrep();
    const allies = prep ? this.countActiveAllies() : 0;
    const task = prep ? this.tasks[0] : undefined;
    const pct =
      prep && allies > 0 && task
        ? Math.round((this.work / (task.kind === 'upgrade' ? COST_UPGRADE : COST_TRAP)) * 100)
        : -1;
    const sig = `${getLocale()}|${prep ? 1 : 0}|${this.boardedCountNum}|${this.trapKits}|${this.traps.size}|${this.upgraded ? 1 : 0}|${allies}|${task?.kind ?? ''}|${pct}`;
    if (sig === this.lastStatusSig) return;
    this.lastStatusSig = sig;

    const en = isEn();
    let text = en
      ? `Windows Boarded: ${this.boardedCountNum}/${this.barricades.length}  |  Trap Kits: ${this.trapKits} (Set: ${this.traps.size})  |  Weapon Mod: ${this.upgraded ? 'Done' : 'Pending'}`
      : `窓の封鎖 ${this.boardedCountNum}/${this.barricades.length}　｜　トラップ部材 ${this.trapKits}（設置 ${this.traps.size}）　｜　武器改造 ${this.upgraded ? '済' : '未'}`;
    if (prep) {
      if (allies > 0 && task) {
        if (en) {
          const whatEn = task.kind === 'upgrade' ? 'modding weapons' : 'crafting trap kit';
          text = `${allies} ${allies === 1 ? 'Ally' : 'Allies'} ${whatEn} (${pct}%)  |  ${text}`;
        } else {
          const whatJa = task.kind === 'upgrade' ? '武器を改造中' : 'トラップを製作中';
          text = `仲間 ${allies} 名が${whatJa} ${pct}%　｜　${text}`;
        }
      }
      text += en
        ? '  |  Hold F at Window: Board / Crouch (C) + Hold F at Door: Trap'
        : '　｜　窓の前で F 長押し: 板 / しゃがみ+F 長押し（ドア）: トラップ';
    }
    if (text !== this.lastText) {
      this.lastText = text;
      this.el.textContent = text;
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    let removedCollider = false;
    for (const b of this.barricades) {
      const idx = this.d.colliders.indexOf(b.collider);
      if (idx >= 0) {
        this.d.colliders.splice(idx, 1);
        removedCollider = true;
      }
    }
    if (removedCollider) invalidateColliderIndex(this.d.colliders);
    for (const b of this.blasts) (b.mesh.material as THREE.Material).dispose();
    this.blasts.length = 0;
    this.traps.clear();
    this.el.remove();
    this.d.scene.remove(this.root);
    this.unitBoxGeo.dispose();
    this.blastGeo.dispose();
    this.woodMat.dispose();
    this.backMat.dispose();
    this.trapMat.dispose();
    this.ledMat.dispose();
  }
}
