import * as THREE from 'three';
import type { Civilian } from '../ai/Civilian';
import type { Suspect } from '../ai/Suspect';
import type { GameEventBus } from '../core/events';
import { SuspectState } from '../core/events';
import { getLocale, isEn, t } from '../core/i18n';
import type { RoomDef, Vec3, WindowDef } from '../core/types';
import type { InputManager } from '../core/InputManager';
import type { Interaction } from '../player/Interaction';
import type { PlayerController } from '../player/PlayerController';
import type { FortifyUnlocks } from '../rules/Progression';
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
/** ドアなし開口（アーチ）にバリケードを設置する長押し秒数 */
const ARCH_BOARD_SEC = 2.6;
/** 板を外す長押し秒数 */
const UNBOARD_SEC = 1.2;
/** しゃがみ + F 長押しでドアにトラップを仕掛ける秒数 */
const TRAP_SEC = 2.0;
const WINDOW_REACH = 1.7;
const ARCH_REACH = 2.0;
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
/** 窓バリケードの基本耐久（改造拳銃 19 で約 9 発、SWAT 12 で約 14 発）。持ち込んだ補強材の倍率を掛ける */
const BARRICADE_HP = 170;
/** アーチ完全板張りバリケードの基本耐久 */
const ARCH_FULL_HP = 240;
/** アーチ一方通行バリケードの基本耐久 */
const ARCH_ONE_WAY_HP = 180;

export type { FortifyUnlocks };

export type BarricadeKind = 'window' | 'arch_full' | 'arch_one_way';
export type ArchBarricadeMode = 'full' | 'one_way';

/** ドアなし開口部（アーチ）の定義 */
export interface ArchDef {
  x: number;
  z: number;
  /** 度数。0 = 開口が X 軸方向（壁が X 方向）、90 = Z 方向 */
  yaw: number;
  width: number;
  height: number;
  /** 床の高さ(m)。省略時 0 */
  y?: number;
}

/** SWAT が窓・アーチバリケードを認識・破壊するための読み取り専用スナップショット */
export interface BarricadeInfo {
  id: string;
  center: Vec3;
  normal: Vec3;
  floorY: number;
  hp: number;
  boarded: boolean;
  /** 省略時は 'window'（既存テストとの互換用） */
  kind?: BarricadeKind;
  /** 開口幅(m) */
  width?: number;
  /** 開口高さ(m) */
  height?: number;
  /** バリケードのワールド AABB（SWAT の経路・一方通行判定用） */
  aabb?: { min: Vec3; max: Vec3 };
}

/** SwatTeam に渡すバリケード問い合わせフック */
export interface BarricadeHooks {
  listBoarded(): BarricadeInfo[];
  /** SWAT が蹴り/ブリーチ等でバリケードへダメージを与える（破壊したら true） */
  damageBarricade?(id: string, damage: number, bySwat?: boolean): boolean;
}

/**
 * 隣接する屋内部屋どうしの共有境界から、ドアも窓も壁も無い「ドアなし開口部（アーチ）」を自動検出する。
 * Fortify が自身のバリケードコライダを colliders へ追加する前に呼ぶこと。
 */
export function detectArchOpenings(
  rooms: readonly RoomDef[],
  colliders: readonly Collider[],
  doors: readonly Door[],
  windows: readonly WindowDef[],
): ArchDef[] {
  const indoor = rooms.filter((r) => !r.outdoor);
  const out: ArchDef[] = [];
  for (let i = 0; i < indoor.length; i++) {
    const a = indoor[i]!;
    const aFloor = a.floorY ?? 0;
    const aMinX = a.x - a.width / 2;
    const aMaxX = a.x + a.width / 2;
    const aMinZ = a.z - a.depth / 2;
    const aMaxZ = a.z + a.depth / 2;
    for (let j = i + 1; j < indoor.length; j++) {
      const b = indoor[j]!;
      const bFloor = b.floorY ?? 0;
      if (Math.abs(aFloor - bFloor) > 0.15) continue;
      const floorY = (aFloor + bFloor) / 2;
      const bMinX = b.x - b.width / 2;
      const bMaxX = b.x + b.width / 2;
      const bMinZ = b.z - b.depth / 2;
      const bMaxZ = b.z + b.depth / 2;

      let alongX = false;
      let c = 0;
      let lo = 0;
      let hi = 0;
      if (Math.abs(aMaxZ - bMinZ) < 0.08) {
        alongX = true;
        c = (aMaxZ + bMinZ) / 2;
        lo = Math.max(aMinX, bMinX);
        hi = Math.min(aMaxX, bMaxX);
      } else if (Math.abs(bMaxZ - aMinZ) < 0.08) {
        alongX = true;
        c = (bMaxZ + aMinZ) / 2;
        lo = Math.max(aMinX, bMinX);
        hi = Math.min(aMaxX, bMaxX);
      } else if (Math.abs(aMaxX - bMinX) < 0.08) {
        alongX = false;
        c = (aMaxX + bMinX) / 2;
        lo = Math.max(aMinZ, bMinZ);
        hi = Math.min(aMaxZ, bMaxZ);
      } else if (Math.abs(bMaxX - aMinX) < 0.08) {
        alongX = false;
        c = (bMaxX + aMinX) / 2;
        lo = Math.max(aMinZ, bMinZ);
        hi = Math.min(aMaxZ, bMaxZ);
      } else {
        continue;
      }
      if (hi - lo < 0.85) continue;

      // 境界線上の腰〜胸高にある壁区間を収集（開口上の垂れ壁 lintel は除外される）
      const blocked: [number, number][] = [];
      for (const col of colliders) {
        if (col.kind !== 'wall') continue;
        const ca = col.aabb;
        if (ca.min.y >= floorY + 1.8 || ca.max.y <= floorY + 0.3) continue;
        if (alongX) {
          if (ca.min.z > c + 0.22 || ca.max.z < c - 0.22) continue;
          if (ca.max.x <= lo || ca.min.x >= hi) continue;
          blocked.push([Math.max(lo, ca.min.x), Math.min(hi, ca.max.x)]);
        } else {
          if (ca.min.x > c + 0.22 || ca.max.x < c - 0.22) continue;
          if (ca.max.z <= lo || ca.min.z >= hi) continue;
          blocked.push([Math.max(lo, ca.min.z), Math.min(hi, ca.max.z)]);
        }
      }
      blocked.sort((u, v) => u[0] - v[0]);
      const gaps: [number, number][] = [];
      let cur = lo;
      for (const [s, e] of blocked) {
        if (s > cur + 0.05) gaps.push([cur, s]);
        if (e > cur) cur = e;
      }
      if (hi > cur + 0.05) gaps.push([cur, hi]);

      for (const [g0, g1] of gaps) {
        const width = g1 - g0;
        if (width < 0.85 || width > 4.2) continue;
        const mid = (g0 + g1) / 2;
        const cx = alongX ? mid : c;
        const cz = alongX ? c : mid;
        const overlapDist = Math.max(0.7, width / 2 + 0.2);
        const hasDoor = doors.some(
          (d) => Math.abs(d.sillY - floorY) < 0.45 && Math.hypot(d.centerX - cx, d.centerZ - cz) < overlapDist,
        );
        if (hasDoor) continue;
        const hasWindow = windows.some(
          (w) => Math.abs((w.y ?? 0) - floorY) < 0.45 && Math.hypot(w.x - cx, w.z - cz) < overlapDist,
        );
        if (hasWindow) continue;
        const dup = out.some(
          (o) => Math.abs((o.y ?? 0) - floorY) < 0.4 && Math.hypot(o.x - cx, o.z - cz) < 0.5,
        );
        if (dup) continue;

        // 開口上部の垂れ壁（lintel）があればその下端を高さにする
        let height = 2.25;
        for (const col of colliders) {
          if (col.kind !== 'wall') continue;
          const ca = col.aabb;
          if (ca.min.y < floorY + 1.8 || ca.min.y > floorY + 3.0) continue;
          if (cx >= ca.min.x - 0.1 && cx <= ca.max.x + 0.1 && cz >= ca.min.z - 0.1 && cz <= ca.max.z + 0.1) {
            height = Math.min(height, ca.min.y - floorY);
          }
        }
        out.push({ x: cx, z: cz, y: floorY, yaw: alongX ? 0 : 90, width, height });
      }
    }
  }
  return out;
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

interface ArchBarricade {
  id: string;
  def: ArchDef;
  collider: Collider;
  on: Collider['aabb'];
  mesh: THREE.Group;
  fullGroup: THREE.Group | null;
  oneWayGroup: THREE.Group | null;
  fullPlanks: THREE.Mesh[];
  oneWaySlats: THREE.Mesh[];
  mode: ArchBarricadeMode | null;
  hp: number;
  maxHp: number;
  floorY: number;
  cx: number;
  cy: number;
  cz: number;
  normal: Vec3;
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
  /** 進行度による補強アンロック（未指定 = 全機能有効で既存テストと完全互換） */
  unlocks?: Partial<FortifyUnlocks>;
  /** 部屋定義（ドアなしアーチ開口の自動検出に使用） */
  rooms?: readonly RoomDef[];
  /** 明示的なアーチ開口定義（テスト・特殊マップ用） */
  arches?: readonly ArchDef[];
}

/**
 * 容疑者モードの籠城準備。
 * - 窓（外窓・室内の窓口）を板で塞ぐ（Lv.2+）: 視線・射線を遮る（F 長押し。もう一度で外す）。自動では張られない（自分で張る）
 * - ドアにブービートラップ（Lv.3+、しゃがみ + F 長押し）: SWAT が開ける / ブリーチすると爆発。SWAT は気付けば解除に時間を取られる
 * - ドアなし開口（アーチ）のバリケード:
 *   - Lv.4+: 板張りバリケード（全員の視線・移動を遮断。SWAT は射撃または蹴りで破壊可能）
 *   - Lv.5+: 一方通行バリケード（容疑者プレイヤー＆味方は自由に通過可、SWAT は阻止され破壊/ブリーチが必要）
 * - 時間を稼ぐと仲間が武器を改造（全員の武器が強化）し、トラップの部材も増える
 */
export class Fortify {
  readonly root = new THREE.Group();
  private readonly barricades: Barricade[] = [];
  private readonly arches: ArchBarricade[] = [];
  private boardedCountNum = 0;
  private archBoardedCountNum = 0;
  private boardedCache: BarricadeInfo[] = [];
  private boardedDirty = false;
  private readonly traps = new Map<string, DoorTrap>();
  private trapKits: number;
  /** 窓バリケード 1 枚の最大耐久（BARRICADE_HP × 補強材倍率） */
  private readonly barricadeHp: number;
  private readonly archFullHp: number;
  private readonly archOneWayHp: number;
  private readonly canWindowBarricade: boolean;
  private readonly canDoorTrap: boolean;
  private readonly canArchPlank: boolean;
  private readonly canArchOneWay: boolean;
  private selectedArchMode: ArchBarricadeMode = 'full';
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
  private readonly oneWayFrameMat = new THREE.MeshStandardMaterial({ color: 0x3b444b, roughness: 0.65, metalness: 0.25 });
  private readonly oneWaySlatMat = new THREE.MeshStandardMaterial({
    color: 0x4b7088,
    roughness: 0.45,
    transparent: true,
    opacity: 0.68,
  });
  private readonly oneWayHazardMat = new THREE.MeshStandardMaterial({ color: 0xe6a82e, roughness: 0.5 });
  private readonly trapMat = new THREE.MeshStandardMaterial({ color: 0x3a3a2a, roughness: 0.7 });
  private readonly ledMat = new THREE.MeshBasicMaterial({ color: 0xff3020 });

  constructor(private readonly d: FortifyDeps) {
    this.root.name = 'fortify';
    d.scene.add(this.root);
    this.woodMat = new THREE.MeshStandardMaterial({ map: d.textures.get('wood'), color: 0x9a7a52, roughness: 0.85 });
    this.backMat = new THREE.MeshStandardMaterial({ map: d.textures.get('wood'), color: 0x6e5236, roughness: 0.9 });
    this.canWindowBarricade = d.unlocks?.windowBarricade ?? true;
    this.canDoorTrap = d.unlocks?.doorTrap ?? true;
    this.canArchPlank = d.unlocks?.archPlankBarricade ?? true;
    this.canArchOneWay = d.unlocks?.archOneWayBarricade ?? true;
    if (!this.canArchPlank && this.canArchOneWay) this.selectedArchMode = 'one_way';
    this.trapKits = this.canDoorTrap ? (d.loadout?.trapKits ?? BASE_TRAPS) : 0;
    const hpMul = d.loadout?.barricadeHpMul ?? 1;
    this.barricadeHp = Math.round(BARRICADE_HP * hpMul);
    this.archFullHp = Math.round(ARCH_FULL_HP * hpMul);
    this.archOneWayHp = Math.round(ARCH_ONE_WAY_HP * hpMul);

    // アーチ開口検出は自身のコライダを colliders へ追加する前に行う
    const archDefs: ArchDef[] = d.arches
      ? [...d.arches]
      : d.rooms
        ? detectArchOpenings(d.rooms, d.colliders, d.doors.doors, d.windows)
        : [];
    for (let i = 0; i < d.windows.length; i++) this.barricades.push(this.makeBarricade(d.windows[i]!, i));
    for (let i = 0; i < archDefs.length; i++) this.arches.push(this.makeArchBarricade(archDefs[i]!, i));

    // 仲間の準備: 武器改造 → トラップ部材（トラップ解放時のみ製作）
    this.tasks.push({ kind: 'upgrade' });
    if (this.canDoorTrap) {
      const crafted = d.loadout?.craftedTraps ?? BASE_CRAFTED_TRAPS;
      for (let i = 0; i < crafted; i++) this.tasks.push({ kind: 'trap' });
    }

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
        resolve: () => (this.canWindowBarricade && this.d.player.alive ? this.aimedWindow() : null),
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

    if (this.arches.length > 0) {
      this.unsubs.push(
        d.interaction.register<ArchBarricade>({
          id: 'archBarricade',
          priority: 235,
          resolve: () => ((this.canArchPlank || this.canArchOneWay) && this.d.player.alive ? this.aimedArch() : null),
          label: (a) => {
            if (a.mode) {
              const pct = Math.max(0, Math.round((a.hp / Math.max(1, a.maxHp)) * 100));
              if (a.mode === 'one_way') {
                return t(
                  `一方通行バリケード: F 長押しで撤去（耐久 ${pct}%・味方は通過可）`,
                  `One-Way Barricade: Hold F to Remove (HP ${pct}% — Suspects Pass)`,
                );
              }
              return t(
                `板張りバリケード: F 長押しで撤去（耐久 ${pct}%）`,
                `Full-Plank Barricade: Hold F to Remove (HP ${pct}%)`,
              );
            }
            const mode = this.effectiveArchMode();
            if (this.canArchPlank && this.canArchOneWay) {
              return mode === 'one_way'
                ? t(
                    '開口部: F 長押しで【一方通行バリケード】設置（味方通過可・SWAT阻止） / ホイールで切替',
                    'Archway: Hold F for [One-Way Barricade] (Suspects Pass, Blocks SWAT) / Wheel: Switch',
                  )
                : t(
                    '開口部: F 長押しで【板張りバリケード】設置（視線・移動遮断） / ホイール or C+F で一方通行',
                    'Archway: Hold F for [Full-Plank Barricade] (Blocks Sight & Move) / Wheel or C+F: One-Way',
                  );
            }
            if (mode === 'one_way') {
              return t(
                '開口部: F 長押しで一方通行バリケードを設置（味方は通過可・SWAT阻止）',
                'Archway: Hold F to Place One-Way Barricade (Suspects Pass, Blocks SWAT)',
              );
            }
            return t(
              '開口部: F 長押しで板張りバリケードを設置（視線・移動を遮断）',
              'Archway: Hold F to Place Full-Plank Barricade (Blocks Sight & Movement)',
            );
          },
          onPress: () => {
            this.holdDone = false;
          },
          onWheel: (a, steps) => {
            if (a.mode || steps === 0 || !this.canArchPlank || !this.canArchOneWay) return;
            this.selectedArchMode = this.selectedArchMode === 'full' ? 'one_way' : 'full';
          },
          onHold: (a, _dt, sec) => {
            if (this.holdDone) return;
            const removing = a.mode !== null;
            const targetMode = this.effectiveArchMode();
            const need = removing ? UNBOARD_SEC : ARCH_BOARD_SEC;
            const label = removing
              ? t('バリケードを撤去している...', 'Removing barricade...')
              : targetMode === 'one_way'
                ? t('一方通行バリケードを設置している...', 'Placing one-way barricade...')
                : t('板張りバリケードを設置している...', 'Placing full-plank barricade...');
            this.d.showGauge(label, sec / need);
            if (sec >= need) {
              this.holdDone = true;
              this.setArchMode(a, removing ? null : targetMode);
              this.d.subtitle.show(
                removing
                  ? t('開口部のバリケードを撤去した', 'Archway barricade removed')
                  : targetMode === 'one_way'
                    ? t(
                        '一方通行バリケードを設置した — 容疑者側は通過可能、SWAT は破壊が必要',
                        'One-way barricade placed — suspects pass freely, SWAT must breach',
                      )
                    : t(
                        '板張りバリケードを設置した — 視線と通路を完全に遮断',
                        'Full-plank barricade placed — blocks sightlines and movement',
                      ),
                1.8,
              );
              this.d.bus.emit('noise', { pos: { x: a.cx, y: a.floorY, z: a.cz }, radius: 10, kind: 'door', source: 'suspect' });
            }
          },
          onRelease: () => {
            this.holdDone = false;
          },
        }),
      );
    }
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

  get archCount(): number {
    return this.arches.length;
  }

  get archBoardedCount(): number {
    return this.archBoardedCountNum;
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

  /** 現在板張りされている窓・アーチバリケードの一覧を返す（SwatTeam の破壊・ブリーチ用） */
  listBoarded(): BarricadeInfo[] {
    if (this.boardedDirty) {
      this.boardedDirty = false;
      const out: BarricadeInfo[] = [];
      for (const b of this.barricades) {
        if (!b.boarded) continue;
        out.push({
          id: b.id,
          center: { x: b.cx, y: b.cy, z: b.cz },
          normal: { ...b.normal },
          floorY: b.floorY,
          hp: b.hp,
          boarded: b.boarded,
          kind: 'window',
          width: b.def.width,
          height: b.def.height,
          aabb: { min: { ...b.on.min }, max: { ...b.on.max } },
        });
      }
      for (const a of this.arches) {
        if (!a.mode) continue;
        out.push({
          id: a.id,
          center: { x: a.cx, y: a.cy, z: a.cz },
          normal: { ...a.normal },
          floorY: a.floorY,
          hp: a.hp,
          boarded: true,
          kind: a.mode === 'one_way' ? 'arch_one_way' : 'arch_full',
          width: a.def.width,
          height: a.def.height,
          aabb: { min: { ...a.on.min }, max: { ...a.on.max } },
        });
      }
      this.boardedCache = out;
    }
    return this.boardedCache;
  }

  /** SWAT 等の蹴り/ブリーチでバリケードにダメージを与える（破壊したら true） */
  damageBarricade(id: string, damage: number, _bySwat = true): boolean {
    const win = this.barricades.find((b) => b.id === id);
    if (win && win.boarded) {
      return this.applyWindowDamage(win, damage);
    }
    const arch = this.arches.find((a) => a.id === id);
    if (arch && arch.mode) {
      return this.applyArchDamage(arch, damage);
    }
    return false;
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
      this.applyWindowDamage(b, damage);
      return;
    }
    for (const arch of this.arches) {
      if (arch.mode !== 'full') continue;
      const a = arch.collider.aabb;
      if (pos.x < a.min.x - eps || pos.x > a.max.x + eps || pos.y < a.min.y - eps || pos.y > a.max.y + eps || pos.z < a.min.z - eps || pos.z > a.max.z + eps) continue;
      this.applyArchDamage(arch, damage);
      return;
    }
  }

  private applyWindowDamage(b: Barricade, damage: number): boolean {
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
      return true;
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
    return false;
  }

  private applyArchDamage(arch: ArchBarricade, damage: number): boolean {
    const prevMode = arch.mode;
    arch.hp -= damage;
    if (arch.hp <= 0) {
      this.setArchMode(arch, null);
      this.d.bus.emit('noise', { pos: { x: arch.cx, y: arch.floorY, z: arch.cz }, radius: 16, kind: 'breach', source: 'ally' });
      const p = this.d.player.position;
      if (Math.hypot(p.x - arch.cx, p.z - arch.cz) < 16) {
        this.d.subtitle.show(
          prevMode === 'one_way'
            ? t('一方通行バリケードが突破された！', 'One-way barricade breached!')
            : t('開口部の板張りバリケードが破壊された！', 'Archway barricade destroyed!'),
          1.8,
        );
      }
      return true;
    }
    this.boardedDirty = true;
    this.d.bus.emit('noise', { pos: { x: arch.cx, y: arch.floorY, z: arch.cz }, radius: 12, kind: 'door', source: 'ally' });
    const pieces = prevMode === 'one_way' ? arch.oneWaySlats : arch.fullPlanks;
    if (pieces.length > 0 && arch.maxHp > 0) {
      const keep = Math.ceil((arch.hp / arch.maxHp) * pieces.length);
      const visible = pieces.filter((m) => m.visible);
      while (visible.length > keep) {
        const i = Math.floor(Math.random() * visible.length);
        visible[i]!.visible = false;
        visible.splice(i, 1);
      }
    }
    return false;
  }

  // ---------- ドアなし開口（アーチ）バリケード ----------

  private effectiveArchMode(): ArchBarricadeMode {
    if (this.canArchOneWay && this.d.player.isCrouching) return 'one_way';
    if (this.selectedArchMode === 'one_way' && this.canArchOneWay) return 'one_way';
    if (this.canArchPlank) return 'full';
    return 'one_way';
  }

  private makeArchBarricade(def: ArchDef, idx: number): ArchBarricade {
    const floorY = def.y ?? 0;
    const cy = floorY + def.height / 2;
    const alongX = Math.abs(Math.cos(def.yaw * DEG)) > 0.5;
    const normal: Vec3 = { x: -Math.sin(def.yaw * DEG), y: 0, z: Math.cos(def.yaw * DEG) };
    const hw = def.width / 2 + 0.04;
    const hd = 0.14;
    const on = {
      min: { x: def.x - (alongX ? hw : hd), y: floorY, z: def.z - (alongX ? hd : hw) },
      max: { x: def.x + (alongX ? hw : hd), y: floorY + def.height, z: def.z + (alongX ? hd : hw) },
    };
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
      id: `arch_barricade_${idx}`,
      def,
      collider,
      on,
      mesh,
      fullGroup: null,
      oneWayGroup: null,
      fullPlanks: [],
      oneWaySlats: [],
      mode: null,
      hp: 0,
      maxHp: this.archFullHp,
      floorY,
      cx: def.x,
      cy,
      cz: def.z,
      normal,
      alongX,
    };
  }

  private buildArchFullMeshes(a: ArchBarricade): void {
    const g = new THREE.Group();
    const coverW = a.def.width + 0.12;
    const coverH = a.def.height;
    const planks = Math.max(5, Math.ceil(coverH / 0.22));
    const pitch = coverH / planks;
    for (const side of [-1, 1]) {
      const back = new THREE.Mesh(this.unitBoxGeo, this.backMat);
      back.position.set(0, 0, side * 0.085);
      back.scale.set(coverW, coverH, 0.025);
      back.userData.noShadow = true;
      back.castShadow = false;
      back.receiveShadow = true;
      back.updateMatrix();
      back.matrixAutoUpdate = false;
      g.add(back);
      for (let i = 0; i < planks; i++) {
        const m = new THREE.Mesh(this.unitBoxGeo, this.woodMat);
        const y = -coverH / 2 + pitch * (i + 0.5);
        m.position.set((Math.random() - 0.5) * 0.03, y, side * 0.11);
        m.rotation.z = (Math.random() - 0.5) * 0.02;
        m.scale.set(coverW + 0.04, pitch * 0.92, 0.032);
        m.userData.noShadow = true;
        m.castShadow = false;
        m.receiveShadow = true;
        m.updateMatrix();
        m.matrixAutoUpdate = false;
        g.add(m);
        a.fullPlanks.push(m);
      }
      const brace = new THREE.Mesh(this.unitBoxGeo, this.woodMat);
      brace.position.set(0, 0, side * 0.135);
      brace.rotation.z = Math.atan2(coverH, coverW) * (side > 0 ? 1 : -1);
      brace.scale.set(Math.hypot(coverW, coverH) * 0.92, 0.13, 0.03);
      brace.userData.noShadow = true;
      brace.castShadow = false;
      brace.receiveShadow = true;
      brace.updateMatrix();
      brace.matrixAutoUpdate = false;
      g.add(brace);
    }
    g.visible = false;
    g.updateMatrix();
    g.matrixAutoUpdate = false;
    a.mesh.add(g);
    a.fullGroup = g;
  }

  private buildArchOneWayMeshes(a: ArchBarricade): void {
    const g = new THREE.Group();
    const w = a.def.width;
    const h = a.def.height;
    // 左右ポスト＋上部ヘッダー＋ハザードバー（一方通行の視覚的識別）
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(this.unitBoxGeo, this.oneWayFrameMat);
      post.position.set(side * (w / 2 - 0.04), 0, 0);
      post.scale.set(0.08, h, 0.16);
      post.userData.noShadow = true;
      post.castShadow = false;
      post.receiveShadow = true;
      post.updateMatrix();
      post.matrixAutoUpdate = false;
      g.add(post);
    }
    const header = new THREE.Mesh(this.unitBoxGeo, this.oneWayHazardMat);
    header.position.set(0, h / 2 - 0.08, 0);
    header.scale.set(w, 0.12, 0.18);
    header.userData.noShadow = true;
    header.castShadow = false;
    header.receiveShadow = true;
    header.updateMatrix();
    header.matrixAutoUpdate = false;
    g.add(header);
    // 縦スラット（容疑者はすり抜け可能・SWAT を阻止する半透明タクティカルバリア）
    const slats = Math.max(4, Math.ceil(w / 0.24));
    const sw = (w - 0.16) / slats;
    for (let i = 0; i < slats; i++) {
      const slat = new THREE.Mesh(this.unitBoxGeo, this.oneWaySlatMat);
      const x = -(w - 0.16) / 2 + sw * (i + 0.5);
      slat.position.set(x, -0.04, 0);
      slat.scale.set(sw * 0.78, h - 0.16, 0.03);
      slat.userData.noShadow = true;
      slat.castShadow = false;
      slat.receiveShadow = true;
      slat.updateMatrix();
      slat.matrixAutoUpdate = false;
      g.add(slat);
      a.oneWaySlats.push(slat);
    }
    g.visible = false;
    g.updateMatrix();
    g.matrixAutoUpdate = false;
    a.mesh.add(g);
    a.oneWayGroup = g;
  }

  private setArchMode(a: ArchBarricade, mode: ArchBarricadeMode | null): void {
    const wasActive = a.mode !== null;
    const isActive = mode !== null;
    if (wasActive !== isActive) {
      this.archBoardedCountNum += isActive ? 1 : -1;
    }
    if (mode === 'full' && !a.fullGroup) this.buildArchFullMeshes(a);
    if (mode === 'one_way' && !a.oneWayGroup) this.buildArchOneWayMeshes(a);
    a.mode = mode;
    a.mesh.visible = isActive;
    if (a.fullGroup) a.fullGroup.visible = mode === 'full';
    if (a.oneWayGroup) a.oneWayGroup.visible = mode === 'one_way';
    for (const p of a.fullPlanks) p.visible = true;
    for (const s of a.oneWaySlats) s.visible = true;
    a.maxHp = mode === 'one_way' ? this.archOneWayHp : this.archFullHp;
    a.hp = isActive ? a.maxHp : 0;
    this.boardedDirty = true;

    // full のみ実 wall コライダを有効化。one_way はプレイヤー・味方容疑者が自由通過できるよう無効化し、SWAT 側で阻止する
    const col = a.collider.aabb;
    if (mode === 'full') {
      col.min.y = a.on.min.y;
      col.max.y = a.on.max.y;
    } else {
      col.min.y = DISABLED_Y;
      col.max.y = DISABLED_Y + 0.01;
    }
  }

  private aimedArch(): ArchBarricade | null {
    const p = this.d.player.position;
    const yaw = this.d.player.yawRad;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let best: ArchBarricade | null = null;
    let bestD = ARCH_REACH;
    for (const a of this.arches) {
      if (Math.abs(p.y - a.floorY) > 0.8) continue;
      const dx = a.cx - p.x;
      const dz = a.cz - p.z;
      const along = a.alongX ? Math.abs(dx) : Math.abs(dz);
      const across = a.alongX ? Math.abs(dz) : Math.abs(dx);
      if (along > a.def.width / 2 + 0.45) continue;
      if (across > bestD) continue;
      const l = Math.hypot(dx, dz);
      if (l > 0.35 && (dx * fx + dz * fz) / l < 0.3) continue;
      best = a;
      bestD = across;
    }
    return best;
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

  /** SuspectMission のドア操作から呼ぶ: トラップ解放済みかつしゃがみ姿勢（C トグル）か */
  wantsTrap(): boolean {
    return this.canDoorTrap && this.d.player.isCrouching;
  }

  /** 戻り値: 処理した（ゲージ表示中/設置完了）なら true */
  holdTrap(door: Door, sec: number): boolean {
    if (!this.canDoorTrap) {
      this.d.showGauge(t('ブービートラップは Lv.3 で解放', 'Booby traps unlock at Lv.3'), 0);
      return true;
    }
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
    const sig = `${getLocale()}|${prep ? 1 : 0}|${this.boardedCountNum}|${this.archBoardedCountNum}|${this.trapKits}|${this.traps.size}|${this.upgraded ? 1 : 0}|${allies}|${task?.kind ?? ''}|${pct}`;
    if (sig === this.lastStatusSig) return;
    this.lastStatusSig = sig;

    const en = isEn();
    const parts: string[] = [];
    if (this.canWindowBarricade) {
      parts.push(
        en
          ? `Windows Boarded: ${this.boardedCountNum}/${this.barricades.length}`
          : `窓の封鎖 ${this.boardedCountNum}/${this.barricades.length}`,
      );
    }
    if ((this.canArchPlank || this.canArchOneWay) && this.arches.length > 0) {
      parts.push(
        en
          ? `Archways: ${this.archBoardedCountNum}/${this.arches.length}`
          : `開口封鎖 ${this.archBoardedCountNum}/${this.arches.length}`,
      );
    }
    if (this.canDoorTrap) {
      parts.push(
        en
          ? `Trap Kits: ${this.trapKits} (Set: ${this.traps.size})`
          : `トラップ部材 ${this.trapKits}（設置 ${this.traps.size}）`,
      );
    }
    parts.push(en ? `Weapon Mod: ${this.upgraded ? 'Done' : 'Pending'}` : `武器改造 ${this.upgraded ? '済' : '未'}`);
    let text = parts.join(en ? '  |  ' : '　｜　');
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
      const hints: string[] = [];
      if (this.canWindowBarricade) hints.push(en ? 'Hold F at Window: Board' : '窓の前で F 長押し: 板');
      if (this.canDoorTrap) hints.push(en ? 'Crouch (C) + Hold F at Door: Trap' : 'しゃがみ+F 長押し（ドア）: トラップ');
      if ((this.canArchPlank || this.canArchOneWay) && this.arches.length > 0) {
        hints.push(
          this.canArchOneWay
            ? en
              ? 'Hold F at Arch: Barricade (Wheel: One-Way)'
              : '開口部で F 長押し: バリケード（ホイールで一方通行）'
            : en
              ? 'Hold F at Arch: Plank Barricade'
              : '開口部で F 長押し: 板張り',
        );
      }
      if (hints.length > 0) {
        text += (en ? '  |  ' : '　｜　') + hints.join(' / ');
      }
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
    for (const a of this.arches) {
      const idx = this.d.colliders.indexOf(a.collider);
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
    this.oneWayFrameMat.dispose();
    this.oneWaySlatMat.dispose();
    this.oneWayHazardMat.dispose();
    this.trapMat.dispose();
    this.ledMat.dispose();
  }
}
