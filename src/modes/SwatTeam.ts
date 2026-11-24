import * as THREE from 'three';
import type { GameEventBus, NoiseKind, NoiseSource } from '../core/events';
import type { CombatParams, MobilityParams, RoomDef, Vec3, WindowDef } from '../core/types';
import { disposeObject } from '../core/dispose';
import {
  EngageBehavior,
  SuspectNavigator,
  findNearestVisibleThreat,
  resolveFloorY,
  type AllyTarget,
  type CombatContext,
  type CombatThreat,
} from '../ai/EngageBehavior';
import { HumanoidBody } from '../ai/HumanoidBody';
import { noiseRayOriginY } from '../ai/Perception';
import { shieldBlocks } from '../ai/ShieldGuard';
import { blockedAtFiltered } from '../ai/SquadRoute';
import { layoutStackSlots } from '../ai/stackSlots';
import {
  BASE_SHIELD_COMBAT,
  BASE_SHIELD_MOBILITY,
  BASE_SWAT_COMBAT,
  BASE_SWAT_MOBILITY,
  SWAT_C2_BEEP_INTERVAL,
  SWAT_C2_FUSE_SEC,
  SWAT_C2_PLANT_SEC,
  SWAT_C2_URGENT_AT_SEC,
  SWAT_C2_URGENT_BEEP_INTERVAL,
  SWAT_FLASH_CARRY_MAX,
  SWAT_FLASH_MAX_DIST,
  SWAT_FLASH_MIN_DIST,
  SWAT_FLASH_PER_TEAM,
  SWAT_FOOTSTEP_STRIDE_FAST,
  SWAT_FOOTSTEP_STRIDE_NORMAL,
  SWAT_GAS_MAX_DIST,
  SWAT_GAS_MIN_DIST,
  SWAT_GAS_PER_TEAM,
  SWAT_HP,
  SWAT_PEPPER_INTERVAL,
  SWAT_PEPPER_RANGE,
  SWAT_RADIO_STAGGER_SEC,
  SWAT_READY_POSE,
  SWAT_RUSH_DURATION_SEC,
  SWAT_RUSH_LOW_HP,
  SWAT_RUSH_RADIUS,
  SWAT_RUSH_SPEED_MAX,
  SWAT_RUSH_SPEED_MIN,
  SWAT_RUSH_TEAM_COOLDOWN,
  SWAT_SHIELD_RUSH_SPEED,
  SWAT_SUPPRESS_END_SEC,
  SWAT_SUPPRESS_INTERVAL,
  SWAT_SUPPRESS_START_SEC,
  SWAT_UNIFORM_COLOR,
  cloneCombatProfile,
  cloneMobilityProfile,
  isShieldRole,
} from '../ai/SwatProfile';
import {
  C2_BLAST_RADIUS,
  C2_MIN_LOCKED_DOORS,
  C2_PRESSURE_THRESHOLD,
  assignCellPortals,
  buildStackSlotPortal,
  computeBallisticVelocity,
  computeC2Standoff,
  entryRouteDest,
  evaluateC2BlastCone,
  filterReachableExteriorEntries,
  findRoomDoors,
  isIndoorPoint,
  listExteriorEntries,
  planDoorwayFlashThrow,
  planFlashThrow,
  planPincerFlankGoal,
  planWallBankFlashThrow,
  planWindowFlashThrow,
  raycastWallXZ,
  selectPinningCell,
  shouldUseC2Breach,
  type C2BlastResult,
  type EntryPortal,
  type EntryRoute,
  type EntrySample,
  type FlankDoorSample,
  type FlashDoorSample,
  type FlashThrowPlan,
  type PincerFlankGoal,
  type PincerFlankParams,
  type PinningCellInfo,
} from '../ai/SwatTactics';
import { TacticalOptics } from '../ai/TacticalOptics';
import type { PlayerCombatReceiver } from '../ai/EntityManager';
import { hasLineOfSight, type Flashbang } from '../weapons/Flashbang';
import type { TearGas } from '../weapons/TearGas';
import type { HitTarget, WeaponSystem } from '../weapons/WeaponSystem';
import type { Door, DoorSystem } from '../world/Door';
import type { TextureLibrary } from '../world/Materials';
import type { StairMark } from '../world/Walk';
import type { Collider } from '../world/WorldBuilder';
import type { FlashOverlay } from '../ui/FlashOverlay';
import type { Subtitle } from '../ui/Subtitle';
import type { BarricadeHooks, BarricadeInfo } from './Fortify';

export type { BarricadeHooks, BarricadeInfo } from './Fortify';
export {
  C2_BLAST_RADIUS,
  C2_MIN_LOCKED_DOORS,
  C2_PRESSURE_THRESHOLD,
  assignCellPortals,
  buildStackSlotPortal,
  computeBallisticVelocity,
  computeC2Standoff,
  entryRouteDest,
  evaluateC2BlastCone,
  filterReachableExteriorEntries,
  findRoomDoors,
  isIndoorPoint,
  listExteriorEntries,
  planDoorwayFlashThrow,
  planFlashThrow,
  planPincerFlankGoal,
  planWallBankFlashThrow,
  planWindowFlashThrow,
  raycastWallXZ,
  selectPinningCell,
  shouldUseC2Breach,
};
export type {
  C2BlastResult,
  EntryPortal,
  EntryRoute,
  EntrySample,
  FlankDoorSample,
  FlashDoorSample,
  FlashThrowPlan,
  PincerFlankGoal,
  PincerFlankParams,
  PinningCellInfo,
};

/**
 * 容疑者モードの SWAT 戦闘パラメータ（基準値は SwatProfile.ts）。
 * 圧力（時間経過で SWAT が積極的になる）に応じて SwatTeam が毎秒書き換える（生成時に基準値へ戻す）。
 */
export const SWAT_COMBAT: CombatParams = cloneCombatProfile(BASE_SWAT_COMBAT);
const SWAT_MOBILITY: MobilityParams = cloneMobilityProfile(BASE_SWAT_MOBILITY);

/**
 * 盾持ち隊員（ポイントマン）: 防弾盾を構えてハンドガンで撃ちながら前進する。遮蔽には籠らず、見失えば即座に詰める。
 * 盾は脛より上の正面を完全に防ぐので、足元を撃つか側面・背後へ回り込むしか倒せない。圧力で SwatTeam が一部を書き換える。
 */
export const SHIELD_COMBAT: CombatParams = cloneCombatProfile(BASE_SHIELD_COMBAT);
const SHIELD_MOBILITY: Readonly<MobilityParams> = BASE_SHIELD_MOBILITY;

/** 突入開始から圧力が最大になるまでの秒数 */
export const PRESSURE_RAMP_SEC = 95;
/** 隊員が倒されるたびに残りが本気になる加算量 */
export const PRESSURE_PER_DOWN = 0.12;
/** 閃光弾の補充間隔(s)。圧力が高いほどクールダウンも短い */
const FLASH_REFILL_SEC = 45;
/** ドローン熱源探知: 隠れ続ける相手の大まかな位置を共有する間隔(s)と誤差半径(m)。圧力 0.3 以上で作動 */
const INTEL_INTERVAL_MIN = 16;
const INTEL_INTERVAL_MAX = 38;
const INTEL_ERROR_MAX = 7;
const INTEL_ERROR_MIN = 2.5;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const DEG2RAD = Math.PI / 180;
export const VISION_FOV_DEG = 120;
const VISION_RANGE = 16;
const VISION_RANGE_CROUCH = 11;
/** 視認してから反応して交戦に入るまで。圧力で短くなる（SwatTeam が更新） */
const BASE_REACTION_SEC = 0.35;
const HEARING_MUL = 1.0;
const OCCLUDED_MUL = 0.5;
const ENGAGE_LOST_SEC = 5;
const SWEEP_SPEED = 1.0;
const HUNT_SPEED = 1.05;
const FLASH_TEAM_CD = 14;
const SELF_NOISE_RADIUS = 3.2;
/** 多方向同時突入（F6）のスタック・カウントダウン設定 */
const STACK_OFFSET = 0.48;
const STACK_PERSONAL_SPACE = 0.68;
const STACK_TIMEOUT_SEC = 18;
const ENTRY_COUNTDOWN_SEC = 2.4;
/** 窓バリケード破壊（F9）設定 */
export const BARRICADE_SHOOT_RANGE = 14;
const BARRICADE_MIN_DIST = 1.0;
const BARRICADE_FACE_OFFSET = 0.18;
/** 掃討カバレッジ格子の間隔(m)・視認更新間隔(s)・視認距離(m)・視野角(°)・近接で無条件に確認済みとする距離(m) */
const COVER_CELL = 1.4;
const COVER_TICK = 0.18;
const COVER_RANGE = 11;
const COVER_FOV_DEG = 120;
const COVER_NEAR = 1.5;
const GOAL_TIMEOUT_SEC = 30;

/** 屋内を格子状に区切った 1 マス。視界に入ると seen になる（未視認 = まだクリアしていない場所） */
export interface CoverCell {
  x: number;
  y: number;
  z: number;
  room: string;
  seen: boolean;
  /** 到達できなかったマス（再捜索の周回までは対象にしない） */
  bad: boolean;
}
const RADIO_NAME = 'SWAT無線(傍受)';

export type HunterState = 'staging' | 'stack' | 'sweep' | 'hunt' | 'breach' | 'engage' | 'rush' | 'disarm' | 'down';

/** トラップに気付く距離と確率（一度トラップを見つけた後は警戒して上がる） */
const TRAP_SPOT_DIST = 2.1;
const TRAP_SPOT_CHANCE = 0.35;
const TRAP_SPOT_CHANCE_WARY = 0.65;
const DISARM_SEC_MIN = 7;
const DISARM_SEC_MAX = 12;
const DISARM_FAIL_CHANCE = 0.15;
const TRAP_TRIGGER_DIST = 2.8;

interface ShieldBody {
  readonly alive: boolean;
  readonly body: HumanoidBody;
  readonly shieldedBy?: string | null;
}

/** プレイヤーが抱えた人質の正面 ±この角度にいる隊員は発砲しない */
const HOSTAGE_COVER_DEG = 55;

export interface SwatSpawn {
  x: number;
  y: number;
  z: number;
}

export interface SwatTeamDeps {
  spawns: readonly SwatSpawn[];
  count: number;
  player: PlayerCombatReceiver & {
    isCrouching: boolean;
    readonly yawRad: number;
    readonly hp?: number;
    addViewKick?: (pitchRad: number, yawRad: number) => void;
  };
  colliders: readonly Collider[];
  bus: GameEventBus;
  weapons: WeaponSystem;
  doors: DoorSystem;
  bounds: { width: number; depth: number };
  stairs: readonly StairMark[];
  rooms: readonly RoomDef[];
  windows?: readonly WindowDef[];
  flashbang: Flashbang;
  tearGas?: Pick<TearGas, 'throwFrom'> & { readonly gravity?: number };
  flashOverlay?: Pick<FlashOverlay, 'trigger'>;
  subtitle: Subtitle;
  civilians: () => Iterable<ShieldBody>;
  textures?: TextureLibrary;
  /** 味方容疑者 NPC。未指定ならプレイヤーだけを狙う */
  suspects?: () => readonly AllyTarget[];
  /** 人質の盾が今有効か（人質が暴れている間は無効）。未指定なら常に有効 */
  shieldActive?: () => boolean;
  /** ペッパーボールの命中（プレイヤー本人 / 抱えた人質） */
  onPepper?: (target: 'player' | 'hostage') => void;
  /** 増援ウェーブ（F13）を有効にするか（既定 false） */
  reinforcements?: boolean;
}

/** ドアのブービートラップ（Fortify が実装） */
export interface TrapHooks {
  isTrapped(doorId: string): boolean;
  trappedDoorIds(): Iterable<string>;
  detonate(doorId: string): void;
  disarm(doorId: string): void;
}

/** 隊員同士がこれより近づいたら押し分ける（m）と、その最大速度（m/s） */
const SEPARATION_DIST = 0.7;
const SEPARATION_SPEED = 1.6;
/** 組（セル）ごとのコールサイン接頭辞 */
const CELL_NAMES = ['Red', 'Blue', 'Gold', 'Green'];

/**
 * 隊員数をツーマンセル／スリーマンセルに分ける。基本は 2 人組で、奇数なら 1 組だけ 3 人組。
 * 例: 3 → [3] / 4 → [2,2] / 5 → [2,3] / 6 → [2,2,2] / 7 → [2,2,3]
 */
export function cellSizes(n: number): number[] {
  if (n <= 0) return [];
  if (n <= 3) return [n];
  const sizes: number[] = [];
  let left = n;
  while (left > 0) {
    if (left === 3) {
      sizes.push(3);
      left = 0;
    } else {
      sizes.push(2);
      left -= 2;
    }
  }
  return sizes;
}
const NAMES = ['アルファ', 'ブラボー', 'チャーリー', 'デルタ', 'エコー', 'フォックス'];

// ---------- M3 定数・純粋ヘルパ（F10 / F11 / F12 / F13） ----------

const CAMP_GAS_THRESHOLD_SEC = 20;
const GAS_TEAM_CD = 24;

/** 同一室内での滞在秒数を更新する純粋ヘルパ（屋外または部屋移動で 0 リセット） */
export function updateRoomStay(
  prevRoomId: string | null,
  prevStaySec: number,
  curRoomId: string | null,
  dt: number,
): { roomId: string | null; staySec: number } {
  if (!curRoomId || curRoomId !== prevRoomId) {
    return { roomId: curRoomId, staySec: 0 };
  }
  return { roomId: curRoomId, staySec: prevStaySec + Math.max(0, dt) };
}

/** 連携無線の最小発話間隔（秒）。speechSynthesis の即時キャンセルを防ぐため >= 1.2s とする */
export const RADIO_STAGGER_SEC = SWAT_RADIO_STAGGER_SEC;

/** 建物中心に対する入口の方角ラベル（日英）を返す */
export function describePortalDirection(portalPos: Vec3, center: Vec3): { ja: string; en: string } {
  const dx = portalPos.x - center.x;
  const dz = portalPos.z - center.z;
  if (Math.abs(dz) >= Math.abs(dx)) {
    return dz < 0 ? { ja: '北ドア', en: 'north door' } : { ja: '南ドア', en: 'south door' };
  }
  return dx > 0 ? { ja: '東ドア', en: 'east door' } : { ja: '西ドア', en: 'west door' };
}

export const REINFORCEMENT_WAVE_SIZE = 2;
export const REINFORCEMENT_MAX_WAVES = 2;
export const REINFORCEMENT_MIN_HOLD_SEC = 30;
export const REINFORCEMENT_TRIGGER_KILLS = 2;
export const REINFORCEMENT_COOLDOWN_SEC = 18;

export interface ReinforcementCheck {
  enabled: boolean;
  started: boolean;
  wavesSpawned: number;
  maxWaves: number;
  aliveCount: number;
  killsSinceLastWave: number;
  holdLeftSec: number;
  cooldownSec: number;
}

/** 増援ウェーブを発生させるべきか判定する純粋関数 */
export function shouldTriggerReinforcements(c: ReinforcementCheck): boolean {
  if (!c.enabled || !c.started) return false;
  if (c.wavesSpawned >= c.maxWaves) return false;
  if (c.holdLeftSec < REINFORCEMENT_MIN_HOLD_SEC) return false;
  if (c.aliveCount === 0) return true;
  if (c.cooldownSec > 0) return false;
  return c.killsSinceLastWave >= REINFORCEMENT_TRIGGER_KILLS;
}

/** SWAT 隊員 1 名。部屋の掃討・音/目撃情報の追跡・施錠ドアのブリーチ・交戦を行う。 */
class SwatHunter implements HitTarget {
  readonly body: HumanoidBody;
  readonly nav: SuspectNavigator;
  readonly engage: EngageBehavior;
  hp = SWAT_HP;
  state: HunterState = 'staging';
  /** 所属する組（先頭ほど序列が上。生存者の先頭がその組のリーダー） */
  cell: SwatHunter[] = [this];
  cellIndex = 0;
  cellName = 'Red';
  callsign: string;
  /** 多方向同時突入（F6）の割り当て入口・スタック待機位置 */
  assignedPortal: EntryPortal | null = null;
  stackSlot: Vec3 | null = null;
  stackReady = false;
  /** 掃討中に向かっている未クリアのマス */
  goalCell: CoverCell | null = null;
  goalTime = 0;
  goalRoom = '';
  huntTarget: Vec3 | null = null;
  /** 挟撃（F7）の迂回目標へ向かっている途中か */
  huntingFlank = false;
  rushTarget: Vec3 | null = null;
  rushTimer = 0;
  rushFireCd = 0;
  rushFlinch = 0;
  known: Vec3 | null = null;
  sees = false;
  threat: CombatThreat | null = null;
  spotTimer = 0;
  lostSec = 0;
  stateTime = 0;
  blindLeft = 0;
  breachDoor: Door | null = null;
  get breachDoorId(): string | null {
    return this.breachDoor?.id ?? null;
  }
  breachApproach: Vec3 | null = null;
  breachWait = 0;
  breachMode: 'kick' | 'c2' = 'kick';
  c2Phase: 'approach' | 'plant' | 'standoff' = 'approach';
  c2Timer = 0;
  c2BeepTimer = 0;
  c2Side = 1;
  c2Standoff: Vec3 | null = null;
  /** 窓バリケード破壊（F9）のバースト管理 */
  barricadeCd = 0;
  barricadeBurst = 0;
  /** 民間人が射線上で実弾を撃てない脅威（ペッパーボールで撃つ） */
  pepperThreat: Vec3 | null = null;
  pepperCd = Math.random() * SWAT_PEPPER_INTERVAL;
  suppressCd = 0;
  readonly combat: CombatParams;
  disarmDoor: Door | null = null;
  disarmSec = 0;
  readonly checkedTraps = new Set<string>();
  private readonly skipDoors = new Set<string>();
  private blockedCount = 0;
  private blockedWindow = 0;
  private scanPhase = Math.random() * Math.PI * 2;
  private entryPhase: EntryRoute['phase'] | null = null;
  readonly optics = new TacticalOptics();
  private stepAccum = 0;
  private lastStepX: number;
  private lastStepZ: number;

  constructor(
    readonly id: string,
    callsign: string,
    readonly name: string,
    spawn: SwatSpawn,
    private readonly team: SwatTeam,
    private readonly ctx: CombatContext,
    bus: GameEventBus,
    textures?: TextureLibrary,
    readonly shielded = false,
  ) {
    this.callsign = callsign;
    this.lastStepX = spawn.x;
    this.lastStepZ = spawn.z;
    this.combat = shielded ? SHIELD_COMBAT : SWAT_COMBAT;
    this.body = new HumanoidBody(spawn.x, spawn.z, 0, SWAT_UNIFORM_COLOR, true, { role: 'ally', footY: spawn.y, textures, shield: shielded });
    this.body.ground = ctx.colliders;
    this.body.setReadyPose(SWAT_READY_POSE);
    this.nav = new SuspectNavigator(this.body, ctx);
    this.engage = new EngageBehavior(
      this.combat,
      id,
      this.body,
      bus,
      ctx,
      () => true,
      shielded ? SHIELD_MOBILITY : SWAT_MOBILITY,
      this.nav,
      {
        immediateFireOnEnter: true,
        immediateFireShots: 3,
        skipRetreatOnHit: () => this.shielded || this.team.currentPressure >= 0.6 || this.state === 'rush',
      },
    );
  }

  get alive(): boolean {
    return this.state !== 'down';
  }

  /** 組のリーダー（自分より序列が上の生存者の先頭）。自分がリーダーなら null */
  get leader(): SwatHunter | null {
    for (const m of this.cell) {
      if (m === this) return null;
      if (m.alive) return m;
    }
    return null;
  }

  /** リーダーに追従する生存隊員の中での自分の順番（0 起点）と人数 */
  private followerSlot(leader: SwatHunter): { slot: number; count: number } {
    let slot = 0;
    let count = 0;
    let passedLeader = false;
    for (const m of this.cell) {
      if (m === leader) {
        passedLeader = true;
        continue;
      }
      if (!passedLeader || !m.alive) continue;
      if (m === this) slot = count;
      count++;
    }
    return { slot, count };
  }

  getAABB() {
    return this.body.getAABB();
  }

  shieldBlocks(from: Vec3, hit: Vec3): boolean {
    return shieldBlocks(this.body, from, hit);
  }

  private clearBreachState(): void {
    this.breachDoor = null;
    this.breachApproach = null;
    this.breachWait = 0;
    this.breachMode = 'kick';
    this.c2Phase = 'approach';
    this.c2Timer = 0;
    this.c2BeepTimer = 0;
    this.c2Standoff = null;
  }

  setState(next: HunterState): void {
    if (this.state === 'down') return; // 倒れた隊員は二度と行動しない
    if (this.state === next) return;
    if (this.state === 'engage') this.engage.exit();
    if (this.state === 'rush') {
      this.body.setFlash(false);
      this.rushFlinch = 0;
    }
    if (this.state === 'stack') this.stackReady = false;
    if (this.state === 'hunt') this.huntingFlank = false;
    if (this.state === 'breach') {
      this.clearBreachState();
      this.body.setPose('stand');
    }
    this.state = next;
    this.stateTime = 0;
    if (!this.nav.onStair) this.nav.reset(); // 階段の途中では昇降状態を保持する
    if (next === 'engage') {
      this.body.setPose('stand');
      this.engage.enter(this.known);
    }
    if (next === 'rush') {
      this.body.setPose('stand');
      this.rushTimer = SWAT_RUSH_DURATION_SEC;
      this.rushFireCd = 0;
      this.rushFlinch = 0;
    }
    if (next === 'sweep') this.goalCell = null;
    if (next !== 'disarm' && this.disarmDoor) {
      this.team.abandonDisarm(this.disarmDoor);
      this.disarmDoor = null;
    }
  }

  /** 被弾。戻り値: 倒れたか */
  takeHit(amount: number, from: Vec3): boolean {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) {
      if (this.state === 'engage') this.engage.exit();
      this.clearBreachState();
      this.stackReady = false;
      this.state = 'down';
      this.optics.hide();
      this.body.setFlash(false);
      this.body.setShake(0);
      this.body.setPose('down');
      return true;
    }
    this.known = { x: from.x, y: resolveFloorY(from, this.ctx.rooms, 'gunshot'), z: from.z };
    this.body.faceToward(from.x, from.z);
    if (this.state === 'rush') {
      this.rushTarget = { ...this.known };
      this.rushFlinch = Math.min(this.combat.flinchSec, 0.08);
      if (this.rushFlinch > 0) this.body.setFlash(true);
      return false;
    }
    if (this.state !== 'engage') this.setState('engage');
    this.engage.onHit(this.known);
    return false;
  }

  onFlashed(sec: number): void {
    if (this.alive) this.blindLeft = Math.max(this.blindLeft, sec);
  }

  update(dt: number): void {
    this.body.tick(dt);
    if (!this.alive) return;
    this.stateTime += dt;
    this.blockedWindow = Math.max(0, this.blockedWindow - dt);
    if (this.blockedWindow <= 0) this.blockedCount = 0;
    if (this.state === 'staging') return;
    if (this.blindLeft > 0) {
      this.blindLeft = Math.max(0, this.blindLeft - dt);
      this.body.setPose('crouch');
      this.body.setShake(Math.sin(this.blindLeft * 26) * 0.12);
      if (this.blindLeft <= 0) {
        this.body.setShake(0);
        this.body.setPose('stand');
      }
      return;
    }
    this.sense(dt);
    if (this.state !== 'engage' && this.state !== 'rush' && this.state !== 'disarm' && this.state !== 'stack') this.team.checkTraps(this);
    switch (this.state) {
      case 'stack':
        this.updateStack(dt);
        break;
      case 'engage':
        this.updateEngage(dt);
        break;
      case 'rush':
        this.updateRush(dt);
        break;
      case 'hunt':
        this.updateHunt(dt);
        break;
      case 'breach':
        this.updateBreach(dt);
        break;
      case 'disarm':
        this.updateDisarm(dt);
        break;
      case 'sweep':
        this.updateSweep(dt);
        break;
    }
    const moved = Math.hypot(this.body.px - this.lastStepX, this.body.pz - this.lastStepZ);
    this.lastStepX = this.body.px;
    this.lastStepZ = this.body.pz;
    if (moved > 0.001 && moved < 1.5) {
      this.stepAccum += moved;
      const stride = this.state === 'rush' || this.state === 'stack' ? SWAT_FOOTSTEP_STRIDE_FAST : SWAT_FOOTSTEP_STRIDE_NORMAL;
      if (this.stepAccum >= stride) {
        this.stepAccum -= stride;
        const heavy = this.shielded || this.state === 'rush' || this.state === 'stack' || this.state === 'breach';
        this.team.emitSwatFootstep({ x: this.body.px, y: this.body.footY, z: this.body.pz }, heavy);
      }
    }
  }

  /** 多方向同時突入（F6）: 割り当てられた外壁ドアのスタック位置へ移動し、配置完了まで待機する。 */
  private updateStack(dt: number): void {
    const slot = this.stackSlot;
    const portal = this.assignedPortal;
    if (!slot || !portal) {
      this.setState('sweep');
      return;
    }
    if (!this.sees && !this.pepperThreat && this.team.tryShootBarricade(this, dt)) return;
    const door = this.team.doorById(portal.id);
    const dist = Math.hypot(this.body.px - slot.x, this.body.pz - slot.z);
    if (this.stackReady || dist <= 0.55) {
      this.stackReady = true;
      if (door) this.body.faceToward(door.centerX, door.centerZ, 5 * dt);
      return;
    }
    const res = this.nav.step(slot, this.combat.moveSpeed * 1.15, dt, {
      canOpenDoors: false,
      canUseStairs: false,
      faceTravel: true,
      arriveDist: 0.45,
    });
    if (res === 'arrived') {
      this.stackReady = true;
      if (door) this.body.faceToward(door.centerX, door.centerZ, 5 * dt);
    } else if (res === 'blocked') {
      const distOut = Math.hypot(this.body.px - portal.outside.x, this.body.pz - portal.outside.z);
      if (distOut <= 2.2) {
        this.stackReady = true;
        if (door) this.body.faceToward(door.centerX, door.centerZ, 5 * dt);
      }
    }
  }

  /** 視覚。交戦中以外は視野角・反応時間あり。民間人が射線上にいる場合は撃たない（位置は把握）。 */
  private sense(dt: number): void {
    this.sees = false;
    this.threat = null;
    this.pepperThreat = null;
    const p = this.ctx.player;
    if (p.alive === false) return;
    const engaged = this.state === 'engage' || this.state === 'rush';
    const range = engaged ? this.combat.engageRange : this.team.playerCrouching ? VISION_RANGE_CROUCH : VISION_RANGE;
    const eyeY = this.body.footY + 1.55;
    const threat = findNearestVisibleThreat(this.ctx, this.body.px, this.body.pz, eyeY, range);
    if (!threat) {
      this.spotTimer = Math.max(0, this.spotTimer - dt);
      return;
    }
    if (!engaged) {
      const dx = threat.x - this.body.px;
      const dz = threat.z - this.body.pz;
      const d = Math.hypot(dx, dz);
      const fx = -Math.sin(this.body.yawRad);
      const fz = -Math.cos(this.body.yawRad);
      if (d > 1.2 && (dx * fx + dz * fz) / d < Math.cos((VISION_FOV_DEG / 2) * DEG2RAD)) {
        this.spotTimer = Math.max(0, this.spotTimer - dt);
        return;
      }
      this.spotTimer += dt;
      if (this.spotTimer < this.team.reactionSec) return;
      this.spotTimer = 0;
      this.known = { x: threat.x, y: p.position.y, z: threat.z };
      this.team.onContact(this, this.known);
      if (this.state !== 'rush') this.setState('engage');
    }
    this.known = { x: threat.x, y: p.position.y, z: threat.z };
    this.team.shareSighting(this.known);
    const from = { x: this.body.px, y: eyeY, z: this.body.pz };
    if (this.team.civilianInLine(from, threat.point) || this.team.coveredByHostage(this.body.px, this.body.pz)) {
      // 人質・民間人が射線上: 実弾は撃たず、ペッパーボールで盾ごと制圧する
      if (threat.id === 'player') this.pepperThreat = threat.point;
      return;
    }
    this.sees = true;
    this.threat = threat;
  }

  private updateEngage(dt: number): void {
    if (this.sees) this.lostSec = 0;
    else this.lostSec += dt;
    const k = this.known ?? this.team.lastSighting;
    this.engage.update(dt, k, this.sees, this.threat);
    this.pepperCd = Math.max(0, this.pepperCd - dt);
    if (!this.sees && this.pepperThreat && this.pepperCd <= 0) {
      this.pepperCd = SWAT_PEPPER_INTERVAL * (0.8 + Math.random() * 0.5);
      this.lostSec = 0;
      this.body.faceToward(this.pepperThreat.x, this.pepperThreat.z);
      this.team.firePepper(this, this.pepperThreat);
    }
    // 見失った直後: 最後に見えた位置へ閃光を投げ込み、バリケード破壊や制圧射撃で顔出しを潰す
    this.suppressCd = Math.max(0, this.suppressCd - dt);
    if (!this.sees && !this.pepperThreat && k && this.lostSec >= SWAT_SUPPRESS_START_SEC && this.lostSec <= SWAT_SUPPRESS_END_SEC) {
      if (this.lostSec >= 0.6) this.team.tryFlash(this, k);
      if (!this.team.tryShootBarricade(this, dt) && this.suppressCd <= 0) {
        this.suppressCd = SWAT_SUPPRESS_INTERVAL * (0.8 + Math.random() * 0.5);
        this.team.suppress(this, k);
      }
    }
    if (!this.sees && this.lostSec >= ENGAGE_LOST_SEC) {
      this.huntTarget = k ? { ...k } : null;
      this.setState(this.huntTarget ? 'hunt' : 'sweep');
    }
  }

  /** 弱ったプレイヤーへの突撃: 遮蔽を捨てて高速で距離を詰め、視認すれば退避せず撃ちながら前進する。 */
  private updateRush(dt: number): void {
    this.rushTimer -= dt;
    if (this.rushTimer <= 0) {
      this.huntTarget = this.rushTarget ? { ...this.rushTarget } : null;
      this.setState(this.sees ? 'engage' : this.huntTarget ? 'hunt' : 'sweep');
      return;
    }
    if (this.rushFlinch > 0) {
      this.rushFlinch -= dt;
      if (this.rushFlinch <= 0) this.body.setFlash(false);
      return;
    }
    if (this.sees && this.known) {
      this.rushTarget = { ...this.known };
    } else if (this.team.lastSighting && this.team.lastSightingAge < 1.5) {
      this.rushTarget = { ...this.team.lastSighting };
    }
    const goal = this.rushTarget;
    if (!goal) {
      this.setState('sweep');
      return;
    }
    const speed = this.shielded ? SWAT_SHIELD_RUSH_SPEED : lerp(SWAT_RUSH_SPEED_MIN, SWAT_RUSH_SPEED_MAX, this.team.currentPressure);
    const route = this.team.routeFrom(this.body.px, this.body.pz, this.body.footY, goal, this.assignedPortal?.id);
    if (route.phase !== 'direct') {
      this.followEntry(route, dt, speed / this.combat.moveSpeed);
    } else {
      if (this.assignedPortal && isIndoorPoint(this.ctx.rooms ?? [], this.body.px, this.body.pz, this.body.footY)) {
        this.assignedPortal = null;
      }
      if (this.entryPhase) {
        this.entryPhase = null;
        this.nav.reset();
      }
      const res = this.nav.step(goal, speed, dt, {
        canOpenDoors: true,
        canUseStairs: true,
        faceTravel: !this.sees,
        arriveDist: 1.4,
      });
      if (res === 'blocked') {
        this.noteBlocked();
        if (this.tryBeginBreach(goal)) return;
      }
    }
    this.rushFireCd = Math.max(0, this.rushFireCd - dt);
    this.pepperCd = Math.max(0, this.pepperCd - dt);
    if (this.sees && this.threat) {
      this.body.faceToward(this.threat.x, this.threat.z);
      if (this.engage.ammoLeft <= 0) {
        this.setState('engage');
        return;
      }
      if (this.rushFireCd <= 0) {
        this.engage.fireAt(this.threat, this.known);
        this.rushFireCd = this.combat.fireInterval;
      }
    } else if (!this.sees && this.pepperThreat && this.pepperCd <= 0) {
      this.pepperCd = SWAT_PEPPER_INTERVAL * (0.8 + Math.random() * 0.5);
      this.body.faceToward(this.pepperThreat.x, this.pepperThreat.z);
      this.team.firePepper(this, this.pepperThreat);
    }
  }

  private updateHunt(dt: number): void {
    const t = this.huntTarget;
    if (!t) {
      this.setState('sweep');
      return;
    }
    if (!this.sees && !this.pepperThreat) this.team.tryShootBarricade(this, dt);
    const route = this.team.routeFrom(this.body.px, this.body.pz, this.body.footY, t, this.assignedPortal?.id);
    if (route.phase !== 'direct') {
      // 屋外から足音へ直進せず、入口ドアを経由してから追う
      this.followEntry(route, dt, HUNT_SPEED);
      if (this.stateTime > 45) {
        this.huntTarget = null;
        this.setState('sweep');
      }
      return;
    }
    if (this.assignedPortal && isIndoorPoint(this.ctx.rooms ?? [], this.body.px, this.body.pz, this.body.footY)) {
      this.assignedPortal = null;
    }
    if (this.entryPhase) {
      this.entryPhase = null;
      this.nav.reset();
    }
    this.team.tryFlash(this, t);
    const res = this.nav.step(t, this.combat.moveSpeed * HUNT_SPEED, dt, {
      canOpenDoors: true,
      canUseStairs: true,
      faceTravel: true,
      arriveDist: 1.4,
    });
    if (res === 'blocked') {
      this.noteBlocked();
      if (this.tryBeginBreach(t)) return;
    }
    if (res === 'arrived' && this.huntingFlank) {
      this.huntingFlank = false;
      if (this.team.lastSighting && this.team.lastSightingAge < 10) {
        this.huntTarget = { ...this.team.lastSighting };
        this.stateTime = 0;
        return;
      }
    }
    if (res !== 'moving' || this.stateTime > 30) {
      this.huntTarget = null;
      if (res === 'arrived') this.team.markRoomAt(this.body.px, this.body.pz, this.body.footY);
      this.setState('sweep');
    }
  }

  /** 屋外にいる間は入口の接近点→ドアの内側へ進み、施錠されていればそのドアをブリーチする。 */
  private followEntry(route: EntryRoute, dt: number, speedScale: number): void {
    if (this.entryPhase !== route.phase) {
      this.entryPhase = route.phase;
      this.nav.reset();
    }
    const door = route.entryId ? this.team.doorById(route.entryId) : null;
    if (door?.locked) {
      const near =
        Math.hypot(this.body.px - door.centerX, this.body.pz - door.centerZ) < 2.3 &&
        Math.abs(this.body.footY - door.sillY) < 0.85;
      if (near && this.tryBeginBreach(route.dest, door.id)) return;
    }
    const res = this.nav.step(route.dest, this.combat.moveSpeed * speedScale, dt, {
      canOpenDoors: true,
      canUseStairs: true,
      faceTravel: true,
      arriveDist: 0.55,
    });
    if (res === 'blocked') {
      this.noteBlocked();
      if (door) this.tryBeginBreach(route.dest, door.id);
    }
  }

  private updateSweep(dt: number): void {
    const leader = this.leader;
    if (leader && leader.state !== 'engage' && leader.state !== 'rush' && leader.state !== 'staging') {
      // ツーマン／スリーマンセル: リーダーの後方を追従する。3 人組の 2 名は左右後方に分かれ、背後を扇状に警戒する
      const { slot, count } = this.followerSlot(leader);
      const lyaw = leader.body.yawRad;
      const lfx = -Math.sin(lyaw);
      const lfz = -Math.cos(lyaw);
      const side = count > 1 ? (slot === 0 ? -1 : 1) : 0;
      const gx = leader.body.px - lfx * 1.1 + Math.cos(lyaw) * 0.6 * side;
      const gz = leader.body.pz - lfz * 1.1 - Math.sin(lyaw) * 0.6 * side;
      const goalClear = count > 1 && !blockedAtFiltered(this.ctx.colliders, gx, gz, 0.3, leader.body.footY);
      const goal = goalClear
        ? { x: gx, y: leader.body.footY, z: gz }
        : { x: leader.body.px, y: leader.body.footY, z: leader.body.pz };
      const dist = Math.hypot(leader.body.px - this.body.px, leader.body.pz - this.body.pz);
      const sameFloor = Math.abs(leader.body.footY - this.body.footY) < 0.75;
      const goalDist = Math.hypot(goal.x - this.body.px, goal.z - this.body.pz);
      if (dist > 1.9 + slot * 0.6 || !sameFloor || (goalClear && goalDist > 0.9)) {
        const fres = this.nav.step(
          goal,
          this.combat.moveSpeed * Math.min(1, SWEEP_SPEED * (dist > 4 ? 1.35 : 1)),
          dt,
          { canOpenDoors: true, canUseStairs: true, faceTravel: true, arriveDist: goalClear ? 0.6 : 1.7 },
        );
        if (fres === 'blocked') this.noteBlocked();
      } else {
        this.scanAround(dt, leader.body.yawRad + Math.PI * (count > 1 ? (side < 0 ? 0.65 : 1.35) : 0.9));
      }
      return;
    }
    if (leader && (leader.state === 'engage' || leader.state === 'rush') && leader.known) {
      // 相方が交戦/突撃中: 支援に向かう
      this.huntTarget = { ...leader.known };
      this.setState('hunt');
      return;
    }

    // 未クリア（視界に入っていない）マスを塗りつぶすように、最寄りの未視認マスへ次々と向かう
    if (!this.goalCell || this.goalCell.seen || this.goalCell.bad) {
      this.goalCell = this.team.pickCell(this);
      this.goalTime = 0;
      if (!this.goalCell) {
        this.scanAround(dt, this.body.yawRad);
        return;
      }
    }
    this.goalTime += dt;
    const cell = this.goalCell;
    const goal = { x: cell.x, y: cell.y, z: cell.z };
    if (this.goalTime > GOAL_TIMEOUT_SEC) {
      this.team.markBad(cell);
      this.goalCell = null;
      return;
    }
    if (!this.sees && !this.pepperThreat) this.team.tryShootBarricade(this, dt);
    const route = this.team.routeFrom(this.body.px, this.body.pz, this.body.footY, goal, this.assignedPortal?.id);
    if (route.phase !== 'direct') {
      this.followEntry(route, dt, SWEEP_SPEED);
      return;
    }
    if (this.assignedPortal && isIndoorPoint(this.ctx.rooms ?? [], this.body.px, this.body.pz, this.body.footY)) {
      this.assignedPortal = null;
    }
    if (this.entryPhase) {
      this.entryPhase = null;
      this.nav.reset();
    }
    const res = this.nav.step(goal, this.combat.moveSpeed * SWEEP_SPEED, dt, {
      canOpenDoors: true,
      canUseStairs: true,
      faceTravel: true,
      arriveDist: 0.9,
    });
    if (res === 'arrived') {
      this.team.markSeenAround(this.body.px, this.body.pz, this.body.footY, COVER_NEAR);
      cell.seen = true;
      this.goalCell = null;
    } else if (res === 'blocked') {
      this.noteBlocked();
      if (this.tryBeginBreach(goal)) return;
      this.team.markBad(cell);
      this.goalCell = null;
    }
  }

  /**
   * 経路探索の失敗が短時間に続き、かつ階段の途中（どの階の床にもいない）で止まっている場合の救済。
   * 最寄りの階段端（下階/上階の進入点）へ戻す。
   */
  noteBlocked(): void {
    this.blockedCount++;
    this.blockedWindow = 3;
    if (this.blockedCount < 3) return;
    this.blockedCount = 0;
    const fy = this.body.footY;
    for (const st of this.ctx.stairs ?? []) {
      if (fy < st.baseY + 0.2 || fy > st.topY - 0.2) continue;
      const minX = Math.min(st.lowX, st.highX) - 1.2;
      const maxX = Math.max(st.lowX, st.highX) + 1.2;
      const minZ = Math.min(st.lowZ, st.highZ) - 1.2;
      const maxZ = Math.max(st.lowZ, st.highZ) + 1.2;
      if (this.body.px < minX || this.body.px > maxX || this.body.pz < minZ || this.body.pz > maxZ) continue;
      const up = fy - st.baseY > st.topY - fy;
      const p = up ? st.approachHigh : st.approachLow;
      this.body.setPosition(p.x, p.z, up ? st.topY : st.baseY);
      this.nav.reset();
      return;
    }
  }

  private scanAround(dt: number, baseYaw: number): void {
    this.scanPhase += dt * 2.2;
    const yaw = baseYaw + Math.sin(this.scanPhase) * 1.5;
    this.body.faceToward(this.body.px - Math.sin(yaw), this.body.pz - Math.cos(yaw), 2.5 * dt);
  }

  /** 経路が施錠ドアで塞がれている場合、目標方向の施錠ドアへ向かってブリーチする。 */
  tryBeginBreach(goal: Vec3, preferId?: string): boolean {
    const preferred = preferId ? this.team.doorById(preferId) : null;
    const door =
      preferred &&
      preferred.locked &&
      !this.skipDoors.has(preferred.id) &&
      !this.team.trapHeld(preferred) &&
      !this.team.isDoorBeingBreached(preferred.id, this)
        ? preferred
        : this.team.findLockedDoor(this, goal, this.skipDoors);
    if (!door || this.team.isDoorBeingBreached(door.id, this)) return false;
    const side = (this.body.px - door.centerX) * door.normalX + (this.body.pz - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
    this.breachDoor = door;
    this.breachWait = 0;
    this.c2Side = side;
    this.breachMode = this.team.shouldUseC2(door.id) ? 'c2' : 'kick';
    this.c2Phase = 'approach';
    this.c2Timer = 0;
    this.c2BeepTimer = 0;
    this.c2Standoff = null;
    this.breachApproach = {
      x: door.centerX + door.normalX * side * 0.85,
      y: door.sillY,
      z: door.centerZ + door.normalZ * side * 0.85,
    };
    this.setState('breach');
    return true;
  }

  private updateBreach(dt: number): void {
    const door = this.breachDoor;
    const ap = this.breachApproach;
    if (!door || !ap) {
      this.clearBreachState();
      this.setState(this.huntTarget ? 'hunt' : 'sweep');
      return;
    }
    if (this.breachMode === 'c2') {
      this.updateC2Breach(dt, door, ap);
      return;
    }
    if (!door.locked) {
      this.clearBreachState();
      this.setState(this.huntTarget ? 'hunt' : 'sweep');
      return;
    }
    // ドア枠付近で接近点に届かない場合もあるため、ドア中心に十分近ければ到着とみなす
    const nearDoor =
      Math.abs(this.body.footY - door.sillY) < 0.75 &&
      Math.hypot(this.body.px - door.centerX, this.body.pz - door.centerZ) < 1.35;
    const res = nearDoor
      ? 'arrived'
      : this.nav.step(ap, this.combat.moveSpeed * HUNT_SPEED, dt, {
          canOpenDoors: true,
          canUseStairs: true,
          faceTravel: true,
          arriveDist: 0.7,
        });
    if (res === 'arrived') {
      this.breachWait += dt;
      this.body.faceToward(door.centerX, door.centerZ);
      if (this.breachWait < 0.6) return; // 構え
      const opened = door.breach(this.body.px, this.body.pz, 'swat');
      if (!opened) {
        this.breachWait = 0; // 同じドアでもう一蹴り
        return;
      }
      this.team.onBreach(this, door);
      this.clearBreachState();
      this.setState(this.huntTarget ? 'hunt' : 'sweep');
    } else if (res === 'blocked' || this.stateTime > 20) {
      this.skipDoors.add(door.id);
      this.clearBreachState();
      this.setState('sweep');
    }
  }

  /** C2 爆破ブリーチ（F8）: 接近 → しゃがみ設置 → 安全距離へ退避しつつ警告ビープ → 起爆。 */
  private updateC2Breach(dt: number, door: Door, ap: Vec3): void {
    const doorOpeningOrOpen =
      door.angle > 5 || (!door.locked && door.targetAngle >= door.maxAngle - 1) || (door.stage === 'open' && !door.isMoving);
    if ((this.c2Phase !== 'standoff' && !door.locked) || (this.c2Phase === 'standoff' && doorOpeningOrOpen)) {
      this.body.setPose('stand');
      this.clearBreachState();
      this.setState(this.huntTarget ? 'hunt' : 'sweep');
      return;
    }
    if (this.c2Phase === 'approach') {
      const nearDoor =
        Math.abs(this.body.footY - door.sillY) < 0.75 &&
        Math.hypot(this.body.px - door.centerX, this.body.pz - door.centerZ) < 1.35;
      const res = nearDoor
        ? 'arrived'
        : this.nav.step(ap, this.combat.moveSpeed * HUNT_SPEED, dt, {
            canOpenDoors: true,
            canUseStairs: true,
            faceTravel: true,
            arriveDist: 0.7,
          });
      if (res === 'arrived') {
        this.c2Phase = 'plant';
        this.c2Timer = 0;
        this.body.setPose('crouch');
        this.team.onC2PlantStart(this, door);
      } else if (res === 'blocked' || this.stateTime > 20) {
        this.skipDoors.add(door.id);
        this.clearBreachState();
        this.setState('sweep');
      }
      return;
    }
    if (this.c2Phase === 'plant') {
      this.body.faceToward(door.centerX, door.centerZ);
      this.body.setPose('crouch');
      this.c2Timer += dt;
      if (this.c2Timer >= SWAT_C2_PLANT_SEC) {
        this.body.setPose('stand');
        this.c2Standoff = computeC2Standoff(door, this.c2Side, this.ctx.colliders, {
          x: this.body.px,
          y: this.body.footY,
          z: this.body.pz,
        });
        this.c2Phase = 'standoff';
        this.c2Timer = 0;
        this.c2BeepTimer = 0;
        this.team.emitC2Beep(door, false);
      }
      return;
    }
    // 'standoff'
    const standoff = this.c2Standoff;
    if (standoff && Math.hypot(this.body.px - standoff.x, this.body.pz - standoff.z) > 0.35) {
      this.nav.step(standoff, this.combat.moveSpeed * HUNT_SPEED, dt, {
        canOpenDoors: false,
        canUseStairs: false,
        faceTravel: false,
        arriveDist: 0.35,
      });
    }
    this.body.faceToward(door.centerX, door.centerZ);
    this.c2Timer += dt;
    this.c2BeepTimer += dt;
    const urgent = this.c2Timer >= SWAT_C2_URGENT_AT_SEC;
    const interval = urgent ? SWAT_C2_URGENT_BEEP_INTERVAL : SWAT_C2_BEEP_INTERVAL;
    if (this.c2BeepTimer >= interval && this.c2Timer < SWAT_C2_FUSE_SEC) {
      this.c2BeepTimer = 0;
      this.team.emitC2Beep(door, urgent);
    }
    if (this.c2Timer >= SWAT_C2_FUSE_SEC) {
      this.team.detonateC2(this, door, this.c2Side);
      this.clearBreachState();
      this.setState(this.huntTarget ? 'hunt' : 'sweep');
    }
  }

  /** トラップに気付いた: その場でしゃがんで解除する（時間がかかる。失敗すると起爆） */
  beginDisarm(door: Door): void {
    this.setState('disarm');
    this.disarmDoor = door;
    this.disarmSec = DISARM_SEC_MIN + Math.random() * (DISARM_SEC_MAX - DISARM_SEC_MIN);
    this.body.setPose('crouch');
  }

  private updateDisarm(_dt: number): void {
    const door = this.disarmDoor;
    if (!door || !this.team.trapStillThere(door)) {
      this.disarmDoor = null;
      this.body.setPose('stand');
      this.setState('sweep');
      return;
    }
    this.body.faceToward(door.centerX, door.centerZ, 3 * _dt);
    this.body.setPose('crouch');
    if (this.stateTime < this.disarmSec) return;
    this.disarmDoor = null;
    this.body.setPose('stand');
    this.team.finishDisarm(this, door, Math.random() >= DISARM_FAIL_CHANCE);
    if (this.alive) this.setState('sweep');
  }

  dispose(): void {
    this.optics.dispose();
    this.body.dispose();
  }
}



/**
 * 容疑者モードの敵 SWAT チーム。2 人 1 組で部屋を順に掃討し、音・目撃情報は無線で共有する。
 * 屋外からは外壁のドアを通って入り、施錠ドアはブリーチする。射線上に民間人がいると撃たない。
 */
export class SwatTeam {
  readonly root = new THREE.Group();
  readonly hunters: SwatHunter[] = [];
  lastSighting: Vec3 | null = null;
  private readonly cleared = new Set<string>();
  private entryCache: EntryPortal[] | null = null;
  /** pickCell 中に hunt へ切り替えたい隊員（sweep 更新中の再入を避けるため次フレームで遷移） */
  private readonly pendingHunt = new Set<SwatHunter>();
  private cells: CoverCell[] | null = null;
  private coverCd = 0;
  private readonly rooms: RoomDef[];
  private readonly unsubs: (() => void)[] = [];
  private flashCd = 6;
  private droneCd = 0;
  private flashesLeft = SWAT_FLASH_PER_TEAM;
  private flashRefill = 0;
  private shieldHintShown = false;
  /** 突入開始からの秒数と圧力(0〜1)。倒された隊員の数でも上がる */
  private assaultSec = 0;
  private downBonus = 0;
  private pressure = 0;
  private pressureTick = 0;
  private pressureStep = 0;
  reactionSec = BASE_REACTION_SEC;
  private intelCd = 0;
  private contactCd = 0;
  private radioCd = 0;
  private rushCd = 0;
  private sightingAge = 0;
  private started = false;
  private readonly ray = new THREE.Ray();
  private readonly box = new THREE.Box3();
  private readonly hit = new THREE.Vector3();
  private disposed = false;
  /** 統計 */
  kills = 0;
  pepperShots = 0;
  trapsDisarmed = 0;
  trapKills = 0;
  private traps: TrapHooks | null = null;
  /** 解除のために一時施錠したドア → 元の施錠状態 */
  private readonly heldDoors = new Map<string, { wasLocked: boolean; by: SwatHunter | null }>();
  private trapsSeen = 0;
  /** 多方向同時突入（F6）の状態 */
  private entryPhase: 'idle' | 'stacking' | 'countdown' | 'entered' = 'idle';
  private entryStackElapsed = 0;
  private entryCountdown = 0;
  private readonly reportedStackCells = new Set<number>();
  /** 挟撃・ピンサー機動（F7）の状態 */
  private pinningCellIndex: number | null = null;
  private pincerTargetRoomId: string | null = null;
  private pincerRefreshCd = 0;
  private pincerRadioCd = 0;
  /** C2 爆破ブリーチ（F8）の状態・常設ライト（シェーダ再コンパイル防止のため追加/削除しない） */
  private readonly encounteredLockedDoors = new Set<string>();
  private readonly c2BlastLight = new THREE.PointLight(0xffb866, 0, 14, 2);
  private readonly c2Blasts: { mesh: THREE.Mesh; t: number }[] = [];
  /** 窓バリケード破壊（F9）フック */
  private barricades: BarricadeHooks | null = null;
  private barricadeRadioCd = 0;
  /** 催涙ガス・籠城監視（F10） */
  private playerRoomId: string | null = null;
  private playerRoomStaySec = 0;
  private gasCd = 8;
  private gasLeft = SWAT_GAS_PER_TEAM;
  /** レーザー・ライト光芒（F11）のワークベクトル */
  private readonly muzzleOriginTmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly muzzleDirTmp: Vec3 = { x: 0, y: 0, z: -1 };
  /** 連携無線スタガーキュー（F12） */
  private readonly radioQueue: { hunter: SwatHunter; text: string; voice: string }[] = [];
  private radioSpeakGap = 0;
  /** 増援ウェーブ（F13） */
  private readonly combatCtx: CombatContext;
  private readonly baseSpawns: readonly SwatSpawn[];
  private nextHunterId = 1;
  private nextCellIndex = 0;
  private readonly reinforcementsEnabled: boolean;
  private wavesSpawned = 0;
  private killsAtLastWave = 0;
  private waveCooldown = 0;
  private lastHoldLeft = Infinity;
  private lastReinforcementPortalId: string | null = null;

  constructor(private readonly d: SwatTeamDeps) {
    this.root.name = 'swatTeam';
    this.root.add(this.c2BlastLight);
    Object.assign(SWAT_COMBAT, BASE_SWAT_COMBAT);
    Object.assign(SWAT_MOBILITY, BASE_SWAT_MOBILITY);
    Object.assign(SHIELD_COMBAT, BASE_SHIELD_COMBAT);
    this.rooms = d.rooms.filter((r) => !r.outdoor);
    this.reinforcementsEnabled = Boolean(d.reinforcements);
    this.baseSpawns = d.spawns.map((s) => ({ ...s }));
    const ctx: CombatContext = {
      player: d.player,
      colliders: d.colliders,
      playerDamage: (dmg, from, shooter) => {
        const hp = d.player.takeDamage(dmg);
        d.bus.emit('playerHit', { shooter, damage: dmg, from, hp });
      },
      doors: d.doors,
      bounds: d.bounds,
      stairs: d.stairs,
      rooms: d.rooms,
      allies: d.suspects,
    };
    this.combatCtx = ctx;
    const spawns = this.resolveSpawns(d.spawns, d.count);
    for (let i = 0; i < spawns.length; i++) {
      const idNum = this.nextHunterId++;
      const h = new SwatHunter(
        `swat_${idNum}`,
        `Red-${i + 1}`,
        NAMES[(idNum - 1) % NAMES.length]!,
        spawns[i]!,
        this,
        ctx,
        d.bus,
        d.textures,
        isShieldRole(i, spawns.length),
      );
      this.hunters.push(h);
      this.root.add(h.body.group);
      this.root.add(h.optics.group);
      d.weapons.addTarget(h);
    }
    this.assignCells();
    // 建物の方を向いて待機
    const focus = this.rooms[0];
    if (focus) for (const h of this.hunters) h.body.faceToward(focus.x, focus.z);

    this.unsubs.push(
      d.bus.on('entityHit', (e) => {
        if (e.nonlethal || e.shooter.startsWith('swat_')) return;
        const h = this.hunters.find((x) => x.id === e.targetId);
        if (!h || !h.alive) return;
        const p = d.player.position;
        const from = { x: p.x, y: p.y, z: p.z };
        if (h.takeHit(e.damage, from)) {
          d.weapons.removeTarget(h);
          this.kills++;
          this.onManDown(h);
        } else {
          this.abortStacking();
          this.shareSighting(from);
          this.alertTeam(from, true, 30, h);
        }
      }),
      d.bus.on('bulletImpact', (e) => {
        // 盾持ちの正面に当たった弾（盾に止められた）: 初回だけ足元を狙うヒントを出す
        if (e.shooter !== 'player' || this.shieldHintShown) return;
        for (const h of this.hunters) {
          if (!h.alive || !h.shielded) continue;
          const b = h.body.getAABB();
          const m = 0.12;
          if (e.pos.x < b.min.x - m || e.pos.x > b.max.x + m || e.pos.z < b.min.z - m || e.pos.z > b.max.z + m || e.pos.y > b.max.y + m) continue;
          this.shieldHintShown = true;
          d.subtitle.show('防弾盾に弾かれた！ 腰より下を撃つか、側面・背後へ回り込め', 2.6);
          return;
        }
      }),
      d.bus.on('noise', (e) => this.onNoise(e.pos, e.radius, e.kind, e.source)),
      d.bus.on('playerBlinded', (e) => {
        if (e.duration > 0.3) this.triggerRush(e.pos, 'blind');
      }),
      d.bus.on('playerHit', (e) => {
        if (e.hp > 0 && e.hp <= SWAT_RUSH_LOW_HP) {
          const p = d.player.position;
          this.triggerRush({ x: p.x, y: p.y, z: p.z }, 'lowHp');
        }
      }),
      d.bus.on('flashDetonated', (e) => {
        if (e.thrower && e.thrower.startsWith('swat_')) return; // 自チームの閃光は目を背ける
        for (const h of this.hunters) {
          if (!h.alive) continue;
          const c = h.body.chestPos();
          const dist = Math.hypot(c.x - e.pos.x, c.y - e.pos.y, c.z - e.pos.z);
          if (dist > e.radius) continue;
          if (!hasLineOfSight(d.colliders, c, { x: e.pos.x, y: e.pos.y + 0.1, z: e.pos.z })) continue;
          h.onFlashed(e.blindSec * (1 - 0.6 * (dist / e.radius)));
        }
      }),
    );
  }

  /** 隊員をツーマン／スリーマンセルに組み、組ごとにコールサインを振る */
  private assignCells(): void {
    let i = 0;
    const sizes = cellSizes(this.hunters.length);
    sizes.forEach((size, c) => {
      const members = this.hunters.slice(i, i + size);
      const name = CELL_NAMES[c % CELL_NAMES.length]!;
      members.forEach((m, k) => {
        m.cell = members;
        m.cellIndex = c;
        m.cellName = name;
        m.callsign = `${name}-${k + 1}`;
      });
      i += size;
    });
    this.nextCellIndex = sizes.length;
  }

  get playerCrouching(): boolean {
    return this.d.player.isCrouching;
  }

  get aliveCount(): number {
    return this.hunters.filter((h) => h.alive).length;
  }

  get total(): number {
    return this.hunters.length;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get currentPressure(): number {
    return this.pressure;
  }

  get lastSightingAge(): number {
    return this.sightingAge;
  }

  get reinforcementWavesSpawned(): number {
    return this.wavesSpawned;
  }

  get hasPendingReinforcements(): boolean {
    return (
      this.reinforcementsEnabled &&
      this.wavesSpawned < REINFORCEMENT_MAX_WAVES &&
      this.lastHoldLeft >= REINFORCEMENT_MIN_HOLD_SEC
    );
  }

  /** 残り時間・撃破数に応じて増援ウェーブ（F13）の突入を判定・実行する */
  checkReinforcements(holdLeftSec: number): boolean {
    this.lastHoldLeft = holdLeftSec;
    const should = shouldTriggerReinforcements({
      enabled: this.reinforcementsEnabled,
      started: this.started,
      wavesSpawned: this.wavesSpawned,
      maxWaves: REINFORCEMENT_MAX_WAVES,
      aliveCount: this.aliveCount,
      killsSinceLastWave: this.kills - this.killsAtLastWave,
      holdLeftSec,
      cooldownSec: this.waveCooldown,
    });
    if (!should) return false;
    return this.spawnReinforcements() > 0;
  }

  /** 外周から新規 2 名セル（盾持ち＋ライフル）を増援として突入させる */
  spawnReinforcements(count = REINFORCEMENT_WAVE_SIZE): number {
    if (this.disposed || !this.reinforcementsEnabled || this.wavesSpawned >= REINFORCEMENT_MAX_WAVES || count <= 0) return 0;
    const anchor = this.baseSpawns[0] ?? { x: 0, y: 0, z: 0 };
    const reachable = filterReachableExteriorEntries(this.portals(), anchor, this.d.colliders, this.d.bounds);
    const refPos = this.lastSighting ?? this.d.player.position;
    let chosenPortal: EntryPortal | null = null;
    if (reachable.length > 0) {
      const fresh = reachable.filter((p) => p.id !== this.lastReinforcementPortalId);
      const pool = fresh.length > 0 ? fresh : reachable;
      chosenPortal = pool.reduce((best, p) => {
        const dBest = Math.hypot(best.outside.x - refPos.x, best.outside.z - refPos.z);
        const dCur = Math.hypot(p.outside.x - refPos.x, p.outside.z - refPos.z);
        return dCur > dBest ? p : best;
      }, pool[0]!);
      this.lastReinforcementPortalId = chosenPortal.id;
    }

    const spawns = chosenPortal
      ? this.resolveSpawns([chosenPortal.outside], count)
      : this.resolveSpawns(this.baseSpawns, count);
    const cellIdx = this.nextCellIndex++;
    const cellName = CELL_NAMES[cellIdx % CELL_NAMES.length]!;
    const members: SwatHunter[] = [];
    const focus = this.rooms[0];

    for (let k = 0; k < spawns.length; k++) {
      const idNum = this.nextHunterId++;
      const shielded = isShieldRole(k, spawns.length);
      const h = new SwatHunter(
        `swat_${idNum}`,
        `${cellName}-${k + 1}`,
        NAMES[(idNum - 1) % NAMES.length]!,
        spawns[k]!,
        this,
        this.combatCtx,
        this.d.bus,
        this.d.textures,
        shielded,
      );
      h.cell = members;
      h.cellIndex = cellIdx;
      h.cellName = cellName;
      h.assignedPortal = chosenPortal;
      members.push(h);
      this.hunters.push(h);
      this.root.add(h.body.group);
      this.root.add(h.optics.group);
      this.d.weapons.addTarget(h);
      if (focus) h.body.faceToward(focus.x, focus.z);
      if (this.started) {
        if (this.lastSighting) {
          h.huntTarget = { ...this.lastSighting };
          h.setState('hunt');
        } else {
          h.setState('sweep');
        }
      }
    }

    this.wavesSpawned++;
    this.killsAtLastWave = this.kills;
    this.waveCooldown = REINFORCEMENT_COOLDOWN_SEC;
    if (members[0]) {
      this.queueRadio(
        members[0],
        `増援 ${cellName}班、外周より突入する！`,
        `Reinforcements, ${cellName} team moving in!`,
      );
    }
    this.d.subtitle.show(`SWAT 増援（${cellName}班 ${members.length}名）が外周から突入した！`, 2.6);
    return members.length;
  }

  /** 交渉で突入班を 1 名下げる（最後尾の隊員を撤収）。成功で true */
  withdraw(): boolean {
    if (this.started || this.hunters.length <= 1) return false;
    const h = this.hunters.pop()!;
    this.assignCells(); // 人数が変わったので組み直す（4 → 3 なら 2+2 → 3 人組 1 つ）
    this.d.weapons.removeTarget(h);
    this.root.remove(h.body.group);
    this.root.remove(h.optics.group);
    h.dispose();
    return true;
  }

  /** 生存中の隊員（味方容疑者の射撃対象） */
  livingTargets(): AllyTarget[] {
    return this.hunters
      .filter((h) => h.alive)
      .map((h) => ({
        id: h.id,
        px: h.body.px,
        pz: h.body.pz,
        footY: h.body.footY,
        height: h.body.height,
        getEye: () => {
          const e = new THREE.Vector3();
          h.body.eye(e);
          return { x: e.x, y: e.y, z: e.z };
        },
        getChest: () => h.body.chestPos(),
        getAABB: () => h.body.getAABB(),
        shieldBlocks: (from, hit) => shieldBlocks(h.body, from, hit),
      }));
  }

  doorById(id: string): Door | null {
    return this.d.doors.doors.find((door) => door.id === id) ?? null;
  }

  /** 屋外なら入口ドア経由、屋内なら目標そのもの */
  routeFrom(x: number, z: number, y: number, goal: Vec3, preferPortalId?: string | null): EntryRoute {
    return entryRouteDest(this.d.rooms, this.portals(), { x, y, z }, goal, preferPortalId);
  }

  private portals(): EntryPortal[] {
    if (!this.entryCache) {
      this.entryCache = listExteriorEntries(
        this.d.rooms,
        this.d.doors.doors.map((door) => ({
          id: door.id,
          centerX: door.centerX,
          centerZ: door.centerZ,
          normalX: door.normalX,
          normalZ: door.normalZ,
          sillY: door.sillY,
        })),
      );
    }
    return this.entryCache;
  }

  /** 突入開始（F6: 複数の地上外壁ドアがあればセルごとに分散してスタック→カウントダウン同時突入） */
  beginAssault(): void {
    if (this.started) return;
    this.started = true;
    const living = this.hunters.filter((h) => h.alive);
    const anchor = living[0];
    if (!anchor || isIndoorPoint(this.d.rooms, anchor.body.px, anchor.body.pz, anchor.body.footY)) {
      this.entryPhase = 'entered';
      for (const h of living) h.setState('sweep');
      this.radio(anchor, '全隊、突入開始。容疑者は武装している、注意しろ。', 'All teams, go go go. Suspect is armed.');
      return;
    }

    const reachable = filterReachableExteriorEntries(
      this.portals(),
      { x: anchor.body.px, y: anchor.body.footY, z: anchor.body.pz },
      this.d.colliders,
      this.d.bounds,
    );
    if (reachable.length === 0) {
      this.entryPhase = 'entered';
      for (const h of living) h.setState('sweep');
      this.radio(anchor, '全隊、突入開始。容疑者は武装している、注意しろ。', 'All teams, go go go. Suspect is armed.');
      return;
    }

    // 生存セルごとにグループ化し、到達可能な外壁ドアを分散割り当てする
    const cellGroups = new Map<number, SwatHunter[]>();
    for (const h of living) {
      let grp = cellGroups.get(h.cellIndex);
      if (!grp) {
        grp = [];
        cellGroups.set(h.cellIndex, grp);
      }
      grp.push(h);
    }
    const orderedCells = [...cellGroups.entries()].sort((a, b) => a[0] - b[0]);
    const assignedPortals = assignCellPortals(orderedCells.length, reachable);

    // 単独隊員（1 名のみ）では同時突入の同期対象がいないため、スタック待機を省いて即座に突入する
    if (living.length <= 1) {
      const portal = assignedPortals[0] ?? null;
      for (const h of living) {
        h.assignedPortal = portal;
        h.stackSlot = null;
        h.stackReady = false;
        h.setState('sweep');
      }
      this.entryPhase = 'entered';
      this.radio(anchor, '全隊、突入開始。容疑者は武装している、注意しろ。', 'All teams, go go go. Suspect is armed.', true);
      return;
    }

    // 同じドアを共有するセル（house_compact など単一入口マップ）は合算して重ならないスタック位置を算出
    const byPortal = new Map<string, { portal: EntryPortal; members: SwatHunter[] }>();
    orderedCells.forEach(([, members], idx) => {
      const portal = assignedPortals[idx]!;
      let bucket = byPortal.get(portal.id);
      if (!bucket) {
        bucket = { portal, members: [] };
        byPortal.set(portal.id, bucket);
      }
      for (const m of members) bucket.members.push(m);
    });

    for (const { portal, members } of byPortal.values()) {
      const door = this.doorById(portal.id);
      const standable = (x: number, z: number): boolean => !blockedAtFiltered(this.d.colliders, x, z, 0.3, portal.sillY);
      const slots = door
        ? layoutStackSlots(
            buildStackSlotPortal(portal, door),
            members.length,
            STACK_OFFSET,
            STACK_PERSONAL_SPACE,
            standable,
          )
        : [];
      members.forEach((h, idx) => {
        const slot = slots[idx];
        h.assignedPortal = portal;
        h.stackSlot = slot ? { x: slot.x, y: portal.sillY, z: slot.z } : { ...portal.outside };
        h.stackReady = false;
        h.setState('stack');
      });
    }

    this.entryPhase = 'stacking';
    this.entryStackElapsed = 0;
    this.entryCountdown = 0;
    this.reportedStackCells.clear();
    if (reachable.length >= 2 && orderedCells.length >= 2) {
      this.radio(anchor, '全班、各入口へ展開してスタックしろ。', 'All teams, split to assigned entries and stack up.', true);
    } else {
      this.radio(anchor, '全班、正面ドア前にスタックしろ。', 'All teams, stack up on the front entry.', true);
    }
  }

  /** 多方向同時突入（F6）のスタック完了待ち・カウントダウン進行 */
  private updateEntryCoordination(dt: number): void {
    if (this.entryPhase !== 'stacking' && this.entryPhase !== 'countdown') return;
    const stacking = this.hunters.filter((h) => h.alive && h.state === 'stack');
    if (stacking.length === 0) {
      this.entryPhase = 'entered';
      return;
    }
    if (this.entryPhase === 'stacking') {
      this.entryStackElapsed += dt;
      // セルごとのスタック完了を無線報告
      const cellMap = new Map<number, SwatHunter[]>();
      for (const h of stacking) {
        let list = cellMap.get(h.cellIndex);
        if (!list) {
          list = [];
          cellMap.set(h.cellIndex, list);
        }
        list.push(h);
      }
      const mapCenter: Vec3 = this.rooms.length > 0
        ? {
            x: this.rooms.reduce((s, r) => s + r.x, 0) / this.rooms.length,
            y: 0,
            z: this.rooms.reduce((s, r) => s + r.z, 0) / this.rooms.length,
          }
        : { x: 0, y: 0, z: 0 };
      for (const [cellIdx, members] of cellMap) {
        if (this.reportedStackCells.has(cellIdx)) continue;
        if (members.every((m) => m.stackReady)) {
          this.reportedStackCells.add(cellIdx);
          const lead = members[0]!;
          const portalPos = lead.assignedPortal?.outside ?? { x: lead.body.px, y: lead.body.footY, z: lead.body.pz };
          const dir = describePortalDirection(portalPos, mapCenter);
          this.queueRadio(
            lead,
            `${lead.cellName}班、${dir.ja}配置完了。`,
            `${lead.cellName} team, set on ${dir.en}.`,
          );
        }
      }
      const allReady = stacking.every((h) => h.stackReady);
      if (allReady || this.entryStackElapsed >= STACK_TIMEOUT_SEC) {
        this.entryPhase = 'countdown';
        while (this.radioQueue.length > 1) this.radioQueue.pop();
        this.queueRadio(stacking[0], '全班配置完了。3、2、1、ブリーチ！', 'All teams set. 3, 2, 1, breach!');
        this.entryCountdown = Math.min(
          3.1,
          Math.max(ENTRY_COUNTDOWN_SEC, this.radioSpeakGap + this.radioQueue.length * RADIO_STAGGER_SEC + 0.15),
        );
      }
      return;
    }
    this.entryCountdown -= dt;
    if (this.entryCountdown <= 0) this.releaseStackedEntry();
  }

  /** カウントダウン完了: 全セルを一斉に突入（施錠ドアはブリーチ開始）させる */
  private releaseStackedEntry(): void {
    this.entryPhase = 'entered';
    for (const h of this.hunters) {
      if (!h.alive || h.state !== 'stack') continue;
      const portal = h.assignedPortal;
      if (!h.leader && portal) {
        const door = this.doorById(portal.id);
        if (door?.locked && !this.isDoorBeingBreached(door.id, h) && h.tryBeginBreach(portal.inside, door.id)) continue;
      }
      h.setState('sweep');
    }
  }

  /** スタック中に接敵・被弾・ラッシュが発生した場合は即座に待機を解除して交戦へ合流させる */
  abortStacking(): void {
    if (this.entryPhase !== 'stacking' && this.entryPhase !== 'countdown') return;
    this.entryPhase = 'entered';
    for (const h of this.hunters) {
      if (h.alive && h.state === 'stack') h.setState('sweep');
    }
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, 0.05);
    this.flashCd = Math.max(0, this.flashCd - dt);
    this.gasCd = Math.max(0, this.gasCd - dt);
    this.droneCd = Math.max(0, this.droneCd - dt);
    this.contactCd = Math.max(0, this.contactCd - dt);
    this.radioCd = Math.max(0, this.radioCd - dt);
    this.radioSpeakGap = Math.max(0, this.radioSpeakGap - dt);
    this.rushCd = Math.max(0, this.rushCd - dt);
    this.pincerRefreshCd = Math.max(0, this.pincerRefreshCd - dt);
    this.pincerRadioCd = Math.max(0, this.pincerRadioCd - dt);
    this.barricadeRadioCd = Math.max(0, this.barricadeRadioCd - dt);
    this.waveCooldown = Math.max(0, this.waveCooldown - dt);
    this.sightingAge += dt;

    if (this.radioSpeakGap <= 0 && this.radioQueue.length > 0) {
      const next = this.radioQueue.shift()!;
      const speaker = next.hunter.alive ? next.hunter : this.firstAlive();
      if (speaker) this.emitRadioNow(speaker, next.text, next.voice);
    }

    if (this.started) {
      this.updatePressure(dt);
      this.updateEntryCoordination(dt);
      this.updateAntiCamping(dt);
    }
    for (const h of this.hunters) h.update(dt);
    this.updatePincerRefresh();
    this.updateC2Blasts(dt);
    this.coverCd -= dt;
    if (this.started && this.coverCd <= 0) {
      this.coverCd = COVER_TICK;
      for (const h of this.hunters) if (h.alive && h.state !== 'staging' && h.blindLeft <= 0) this.scanCoverage(h);
    }
    this.separate(dt);
    this.updateOptics();
    this.watchTraps();
    for (const h of this.pendingHunt) if (h.alive && h.state === 'sweep' && h.huntTarget) h.setState('hunt');
    this.pendingHunt.clear();
  }

  /** F10: プレイヤーが同じ室内に一定時間以上籠り続けたら CS 催涙ガスを投げ込む */
  private updateAntiCamping(dt: number): void {
    const p = this.d.player.position;
    const room = this.roomAt(p.x, p.z, p.y);
    const next = updateRoomStay(this.playerRoomId, this.playerRoomStaySec, room?.id ?? null, dt);
    this.playerRoomId = next.roomId;
    this.playerRoomStaySec = next.staySec;

    if (!room || !this.d.tearGas || this.gasLeft <= 0 || this.gasCd > 0) return;
    const threshold = THREE.MathUtils.lerp(CAMP_GAS_THRESHOLD_SEC, CAMP_GAS_THRESHOLD_SEC - 4, this.pressure);
    if (this.playerRoomStaySec < threshold) return;
    if (this.hostageShieldUp()) return;

    if (this.tryThrowGas(room, { x: p.x, y: p.y, z: p.z })) {
      this.playerRoomStaySec = 0;
    }
  }

  private tryThrowGas(room: RoomDef, playerPos: Vec3): boolean {
    const gas = this.d.tearGas;
    if (!gas) return false;
    const targets: Vec3[] = [
      playerPos,
      { x: room.x, y: room.floorY ?? 0, z: room.z },
    ];
    for (const h of this.hunters) {
      if (
        !h.alive ||
        h.state === 'staging' ||
        h.state === 'disarm' ||
        h.state === 'breach' ||
        h.blindLeft > 0
      ) {
        continue;
      }
      if (Math.abs(h.body.footY - playerPos.y) > 0.85) continue;
      const origin: Vec3 = { x: h.body.px, y: h.body.footY + 1.35, z: h.body.pz };
      for (const target of targets) {
        const plan = planFlashThrow(
          origin,
          target,
          this.d.doors.doors,
          this.d.windows ?? [],
          this.d.colliders,
          gas.gravity ?? 9.8,
          SWAT_GAS_MIN_DIST,
          SWAT_GAS_MAX_DIST,
        );
        if (!plan) continue;
        gas.throwFrom(origin, plan.velocity, h.id, plan.fuse);
        this.gasLeft--;
        this.gasCd = THREE.MathUtils.lerp(GAS_TEAM_CD, GAS_TEAM_CD * 0.65, this.pressure);
        this.queueRadio(
          h,
          `${room.name}に籠もっている！ 催涙ガスを撃ち込む！`,
          'Suspect is dug in! Deploying CS gas!',
        );
        return true;
      }
    }
    return false;
  }

  /** F11: 生存中 SWAT の銃口レーザー・着弾点・フラッシュライト光芒を更新する */
  private updateOptics(): void {
    for (const h of this.hunters) {
      if (
        !h.alive ||
        h.state === 'staging' ||
        h.state === 'disarm' ||
        h.blindLeft > 0 ||
        !h.body.getMuzzlePose(this.muzzleOriginTmp, this.muzzleDirTmp)
      ) {
        h.optics.hide();
        continue;
      }
      h.optics.update(this.muzzleOriginTmp, this.muzzleDirTmp, this.d.colliders);
    }
  }

  /** プレイヤーが別の部屋へ移動したら、挟撃（F7）の迂回先を再計画する */
  private updatePincerRefresh(): void {
    if (this.pinningCellIndex === null || this.pincerRefreshCd > 0) return;
    const active = this.hunters.some((h) => h.alive && (h.state === 'engage' || h.state === 'rush')) || this.sightingAge < 6;
    if (!active) {
      this.pinningCellIndex = null;
      this.pincerTargetRoomId = null;
      return;
    }
    if (!this.lastSighting) return;
    const curRoomId = this.roomAt(this.lastSighting.x, this.lastSighting.z, this.lastSighting.y)?.id ?? null;
    if (curRoomId !== this.pincerTargetRoomId) {
      this.pincerRefreshCd = 2.5;
      this.alertTeam(this.lastSighting, true);
    }
  }

  /** C2 爆破の閃光と火球メッシュを減衰・破棄する（ライト自体は常設のまま intensity のみ制御） */
  private updateC2Blasts(dt: number): void {
    let flash = 0;
    for (let i = this.c2Blasts.length - 1; i >= 0; i--) {
      const b = this.c2Blasts[i]!;
      b.t += dt;
      if (b.t < 0.45) {
        const s = 1 + b.t * 5.2;
        b.mesh.scale.setScalar(s);
        (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - b.t / 0.45));
      } else {
        b.mesh.visible = false;
      }
      if (b.t < 0.5) flash = Math.max(flash, 65 * (1 - b.t / 0.5));
      if (b.t > 0.55) {
        this.root.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        this.c2Blasts.splice(i, 1);
      }
    }
    this.c2BlastLight.intensity = flash;
  }

  /**
   * 隊員同士の重なりを解消する（交戦時に同じ遮蔽・ピーク位置を選んで 1 点に重なるのを防ぐ）。
   * 押し出し先が壁・家具に掛かる場合は動かさない。
   */
  private separate(dt: number): void {
    const hs = this.hunters;
    const maxPush = SEPARATION_SPEED * dt;
    for (let i = 0; i < hs.length; i++) {
      const a = hs[i]!;
      if (!a.alive || a.state === 'staging') continue;
      for (let j = i + 1; j < hs.length; j++) {
        const b = hs[j]!;
        if (!b.alive || b.state === 'staging') continue;
        if (Math.abs(a.body.footY - b.body.footY) > 0.6) continue;
        let dx = b.body.px - a.body.px;
        let dz = b.body.pz - a.body.pz;
        let d = Math.hypot(dx, dz);
        if (d >= SEPARATION_DIST) continue;
        if (d < 1e-4) {
          // 完全一致: 序列で決まる方向へ分ける
          dx = Math.cos(i * 2.4);
          dz = Math.sin(i * 2.4);
          d = 1;
        }
        const push = Math.min(maxPush, (SEPARATION_DIST - Math.min(d, SEPARATION_DIST)) / 2);
        const ux = dx / d;
        const uz = dz / d;
        this.nudge(a, -ux * push, -uz * push);
        this.nudge(b, ux * push, uz * push);
      }
    }
  }

  private nudge(h: SwatHunter, dx: number, dz: number): void {
    const x = h.body.px + dx;
    const z = h.body.pz + dz;
    if (blockedAtFiltered(this.d.colliders, x, z, 0.3, h.body.footY)) return;
    h.body.setPosition(x, z, h.body.footY);
  }

  getMinimapStates(): { name: string; x: number; z: number; y: number; yawRad: number; down: boolean }[] {
    return this.hunters.map((h) => ({
      name: h.callsign,
      x: h.body.px,
      z: h.body.pz,
      y: h.body.footY,
      yawRad: h.body.yawRad,
      down: !h.alive,
    }));
  }

  // ---------- チーム連携 ----------

  shareSighting(pos: Vec3): void {
    this.lastSighting = { x: pos.x, y: pos.y, z: pos.z };
    this.sightingAge = 0;
  }

  /** 初回目撃: 警告を叫び、無線で全隊へ位置を通報する。 */
  onContact(by: SwatHunter, pos: Vec3): void {
    this.abortStacking();
    this.shareSighting(pos);
    if (this.contactCd <= 0) {
      this.contactCd = 6;
      const chest = by.body.chestPos();
      const dx = pos.x - by.body.px;
      const dz = pos.z - by.body.pz;
      const l = Math.hypot(dx, dz) || 1;
      this.d.bus.emit('warningCall', { pos: chest, dir: { x: dx / l, y: 0, z: dz / l } });
      if (this.canPlayerHear(chest, 18)) this.d.subtitle.show('SWAT「警察だ！武器を捨てろ！」', 2.0);
      this.radio(by, `容疑者を視認！${this.roomName(pos)}だ！`, 'Contact! Suspect spotted!', true);
    }
    this.alertTeam(pos, true, 30, by);
    if (this.d.player.hp !== undefined && this.d.player.hp > 0 && this.d.player.hp <= SWAT_RUSH_LOW_HP) {
      this.triggerRush(pos, 'lowHp');
    }
  }

  /** プレイヤーの隙（白飛び・リロード・ペッパー命中・低HP）を突いて近隣の隊員を一斉突撃させる。 */
  triggerRush(pos: Vec3, reason: 'blind' | 'reload' | 'pepper' | 'lowHp'): boolean {
    if (!this.started || this.rushCd > 0) return false;
    this.abortStacking();
    const candidates = this.hunters
      .filter((h) => h.alive && h.blindLeft <= 0 && h.state !== 'staging' && h.state !== 'breach' && h.state !== 'disarm')
      .map((h) => ({
        h,
        dist: Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) + Math.abs(h.body.footY - pos.y) * 3,
      }))
      .filter((x) => x.dist <= SWAT_RUSH_RADIUS)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);
    if (candidates.length === 0) return false;
    for (const { h } of candidates) {
      h.rushTarget = { x: pos.x, y: pos.y, z: pos.z };
      h.known = { x: pos.x, y: pos.y, z: pos.z };
      h.setState('rush');
    }
    this.rushCd = SWAT_RUSH_TEAM_COOLDOWN;
    this.shareSighting(pos);
    const lines: Record<'blind' | 'reload' | 'pepper' | 'lowHp', [string, string]> = {
      blind: ['フラッシュ命中！ 今だ、一気に詰めろ！', 'Flash hit! Push in now!'],
      reload: ['リロード音だ！ 撃ち切る前に突っ込め！', 'He is reloading! Move in!'],
      pepper: ['ペッパーが効いている、距離を詰めろ！', 'Pepper hit! Close the distance!'],
      lowHp: ['相手は負傷している！ 一気に制圧しろ！', 'Suspect is wounded! Press the attack!'],
    };
    const [ja, en] = lines[reason];
    this.radio(candidates[0]!.h, ja, en, true);
    return true;
  }

  /**
   * 位置情報を共有し、交戦中でない隊員を向かわせる。
   * visual=true かつ生存セルが 2 つ以上ある場合は F7（役割分担による挟撃・ピンサー機動）を起動し、
   * 正面班（盾持ち/接敵班）が正面から釘付けにし、別班を別ドア・別部屋・別階段ルートへ回り込ませる。
   */
  private alertTeam(pos: Vec3, visual: boolean, maxDist = 30, contactBy?: SwatHunter): void {
    if (visual) {
      this.abortStacking();
      const cellMap = new Map<number, SwatHunter[]>();
      for (const h of this.hunters) {
        if (!h.alive) continue;
        let grp = cellMap.get(h.cellIndex);
        if (!grp) {
          grp = [];
          cellMap.set(h.cellIndex, grp);
        }
        grp.push(h);
      }
      if (cellMap.size >= 2) {
        const cellInfos: PinningCellInfo[] = [];
        for (const [cellIndex, members] of cellMap) {
          let sx = 0;
          let sy = 0;
          let sz = 0;
          for (const m of members) {
            sx += m.body.px;
            sy += m.body.footY;
            sz += m.body.pz;
          }
          const n = members.length;
          cellInfos.push({
            cellIndex,
            aliveCount: n,
            hasShield: members.some((m) => m.shielded),
            engaged: members.some((m) => m.state === 'engage' || m.state === 'rush'),
            center: { x: sx / n, y: sy / n, z: sz / n },
          });
        }
        const preferredPin = contactBy?.cellIndex ?? this.pinningCellIndex ?? cellInfos[0]!.cellIndex;
        const pinIdx = selectPinningCell(cellInfos, preferredPin, pos);
        this.pinningCellIndex = pinIdx;
        const newRoomId = this.roomAt(pos.x, pos.z, pos.y)?.id ?? null;
        const roomChanged = newRoomId !== this.pincerTargetRoomId;
        this.pincerTargetRoomId = newRoomId;

        const pinInfo = cellInfos.find((c) => c.cellIndex === pinIdx)!;
        const doorSamples: FlankDoorSample[] = this.d.doors.doors.map((door) => ({
          id: door.id,
          centerX: door.centerX,
          centerZ: door.centerZ,
          normalX: door.normalX,
          normalZ: door.normalZ,
          sillY: door.sillY,
          locked: door.locked,
        }));
        const usedFlankDoors = new Set<string>();
        let flankSpeaker: SwatHunter | undefined;
        let flankAssigned = false;

        for (const [cellIndex, members] of cellMap) {
          if (cellIndex === pinIdx) {
            for (const h of members) {
              if (h.state === 'engage' || h.state === 'rush' || h.state === 'staging' || h.state === 'breach' || h.state === 'disarm') continue;
              h.huntTarget = { x: pos.x, y: pos.y, z: pos.z };
              h.huntingFlank = false;
              h.setState('hunt');
            }
            continue;
          }
          const lead = members[0]!;
          const flank = planPincerFlankGoal({
            playerPos: pos,
            frontalPos: pinInfo.center,
            flankerPos: { x: lead.body.px, y: lead.body.footY, z: lead.body.pz },
            rooms: this.rooms,
            doors: doorSamples,
            stairs: this.d.stairs,
            colliders: this.d.colliders,
            excludeDoorIds: usedFlankDoors,
          });
          if (flank?.doorId) usedFlankDoors.add(flank.doorId);
          for (const h of members) {
            if (h.state === 'engage' || h.state === 'rush' || h.state === 'staging' || h.state === 'breach' || h.state === 'disarm') continue;
            h.huntTarget = flank ? { ...flank.target } : { x: pos.x, y: pos.y, z: pos.z };
            h.huntingFlank = flank !== null;
            h.setState('hunt');
            if (flank) {
              flankAssigned = true;
              flankSpeaker = flankSpeaker ?? h;
            }
          }
        }
        if (flankAssigned && (roomChanged || this.pincerRadioCd <= 0)) {
          this.pincerRadioCd = 10;
          const pinMembers = cellMap.get(pinIdx)!;
          const pinName = pinMembers[0]!.cellName;
          const flankName = flankSpeaker!.cellName;
          this.radio(
            pinMembers[0],
            `${pinName}班は正面から釘付けにしろ！ ${flankName}班は裏へ回り込め！`,
            `${pinName} team, pin him down! ${flankName} team, flank around!`,
            true,
          );
        }
        return;
      }
    }

    for (const h of this.hunters) {
      if (!h.alive || h.state === 'engage' || h.state === 'rush' || h.state === 'staging' || h.state === 'breach' || h.state === 'disarm') continue;
      const d = Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) + Math.abs(h.body.footY - pos.y) * 3;
      if (!visual && d > maxDist) continue;
      if (h.leader && h.leader.alive && !visual) continue; // 音の調査は組のリーダーが判断
      h.huntTarget = { x: pos.x, y: pos.y, z: pos.z };
      h.huntingFlank = false;
      h.setState('hunt');
    }
  }

  private onNoise(pos: Vec3, radius: number, kind: NoiseKind, source?: NoiseSource): void {
    if (!this.started || source === 'suspect' || source === 'ally' || kind === 'flash') return;
    // 隊員自身のドア操作・ブリーチ音は無視する（プレイヤー由来の発砲・リロード・咳は近距離でも必ず拾う）
    const isPlayerReload = kind === 'reload' && source === 'player';
    const isPlayerNoise = source === 'player';
    if (kind !== 'gunshot' && !isPlayerNoise) {
      for (const h of this.hunters) {
        if (h.alive && Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) < SELF_NOISE_RADIUS) return;
      }
    }
    const rayY = noiseRayOriginY(pos, kind);
    const target = { x: pos.x, y: resolveFloorY(pos, this.d.rooms, kind), z: pos.z };
    let heard = false;
    for (const h of this.hunters) {
      if (!h.alive || h.state === 'staging') continue;
      const c = h.body.chestPos();
      const dist = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
      let r = radius * HEARING_MUL;
      if (dist > r) continue;
      if (kind !== 'gunshot' && kind !== 'breach' && !hasLineOfSight(this.d.colliders, { x: pos.x, y: rayY, z: pos.z }, c)) {
        r *= OCCLUDED_MUL;
        if (dist > r) continue;
      }
      heard = true;
      if (isPlayerNoise && h.state === 'stack') {
        h.huntTarget = target;
      }
      if (
        h.state === 'engage' ||
        h.state === 'rush' ||
        h.state === 'breach' ||
        h.state === 'stack' ||
        h.state === 'disarm'
      ) continue;
      if (h.huntingFlank) continue;
      if (h.leader && h.leader.alive) continue;
      h.huntTarget = target;
      h.setState('hunt');
    }
    if (heard && isPlayerReload) {
      this.triggerRush(target, 'reload');
      return;
    }
    if (heard && this.radioCd <= 0) {
      const lines: Record<string, [string, string]> = {
        gunshot: ['発砲音！音の方向へ前進する。', 'Shots fired, moving to the sound.'],
        footstep: ['足音を確認、調べる。', 'Footsteps, checking it out.'],
        door: ['ドアの音がした。確認に向かう。', 'Heard a door, moving to check.'],
        voice: ['咳き込む声が聞こえた！ 目標はその部屋だ！', 'Coughing heard! Suspect is in that room!'],
      };
      const line = lines[kind];
      if (line) this.radio(this.firstAlive(), line[0], line[1]);
    }
  }

  private onManDown(h: SwatHunter): void {
    const buddy = h.cell.find((x) => x !== h && x.alive);
    const speaker = buddy ?? this.firstAlive();
    this.downBonus += PRESSURE_PER_DOWN;
    this.applyPressure();
    if (this.aliveCount === 0) return;
    if (h.cellIndex === this.pinningCellIndex && !h.cell.some((m) => m.alive)) {
      this.pinningCellIndex = null;
    }
    this.radio(speaker, `${h.callsign} ダウン！ 隊員負傷、警戒しろ！`, `${h.callsign} is down! Officer down!`, true);
    // 組のリーダーが倒れたら次の序列の隊員が自動的にリーダーを引き継ぐ（leader ゲッター）。相方が全滅すれば単独行動
    const p = this.d.player.position;
    this.alertTeam({ x: p.x, y: p.y, z: p.z }, true);
  }

  onBreach(by: SwatHunter, door: Door): void {
    this.radio(by, 'ブリーチ！', 'Breaching!', true);
    // 突入前に閃光弾を投げ込む
    const side = (by.body.px - door.centerX) * door.normalX + (by.body.pz - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
    const target = {
      x: door.centerX - door.normalX * side * 2.6,
      y: door.sillY,
      z: door.centerZ - door.normalZ * side * 2.6,
    };
    if (this.flashesLeft > 0 && this.flashCd <= 4) this.throwFlash(by, target, 1.4);
  }

  // ---------- C2 爆破ブリーチ（F8） ----------

  /** 施錠ドア遭遇数を記録し、高圧力または 2 枚目以降の施錠ドアなら C2 爆破を選択する */
  shouldUseC2(doorId: string): boolean {
    this.encounteredLockedDoors.add(doorId);
    return shouldUseC2Breach(this.pressure, this.encounteredLockedDoors.size);
  }

  onC2PlantStart(by: SwatHunter, door: Door): void {
    this.radio(by, '施錠ドア確認、C2を設置する！ 下がれ！', 'Door is locked, planting C2! Stand back!', true);
    if (this.canPlayerHear({ x: door.centerX, y: door.sillY, z: door.centerZ }, 10)) {
      this.d.subtitle.show('ドアの向こうで C2 爆薬を設置している音がする…！', 2.0);
    }
  }

  emitC2Beep(door: Door, urgent: boolean): void {
    this.d.bus.emit('c2Beep', {
      pos: { x: door.centerX, y: door.sillY + 1.0, z: door.centerZ },
      urgent,
    });
  }

  /** C2 を起爆: ドアのトラップを安全に無力化し、高速爆破開放 + 反対側への指向性爆風・視界揺れ・スタンを与える */
  detonateC2(by: SwatHunter, door: Door, side: number): void {
    // プレイヤーのブービートラップが仕掛けてあれば遠隔起爆前に安全に無力化する
    if (this.traps?.isTrapped(door.id)) {
      this.traps.disarm(door.id);
      if (this.canPlayerHear({ x: door.centerX, y: door.sillY, z: door.centerZ }, 14)) {
        this.d.subtitle.show('C2の爆風でドアのブービートラップが吹き飛んだ！', 2.0);
      }
    }
    const opened = door.breachExplosive(by.body.px, by.body.pz);
    if (!opened) return;

    const blastDir: Vec3 = { x: -door.normalX * side, y: 0, z: -door.normalZ * side };
    const doorCenter: Vec3 = { x: door.centerX, y: door.sillY + 1.0, z: door.centerZ };
    // 扉コライダがまだ閉位置の同一フレームで自己遮蔽しないよう、爆風方向へ 0.25m オフセットする
    const blastOrigin: Vec3 = {
      x: doorCenter.x + blastDir.x * 0.25,
      y: doorCenter.y,
      z: doorCenter.z + blastDir.z * 0.25,
    };

    const fireball = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb85c, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    fireball.position.set(blastOrigin.x, blastOrigin.y, blastOrigin.z);
    this.root.add(fireball);
    this.c2Blasts.push({ mesh: fireball, t: 0 });
    this.c2BlastLight.position.set(blastOrigin.x, blastOrigin.y, blastOrigin.z);
    this.c2BlastLight.intensity = 65;

    this.d.bus.emit('c2Detonated', { doorId: door.id, pos: doorCenter, dir: blastDir, radius: C2_BLAST_RADIUS });
    this.radio(by, 'C2起爆！ 突入しろ！', 'Breach! Go, go, go!', true);

    let playerStunned = false;
    if (this.d.player.alive) {
      const eye = this.d.player.getEyePosition();
      const blast = evaluateC2BlastCone(blastOrigin, blastDir, eye);
      if (blast.dist < C2_BLAST_RADIUS * 1.6) {
        const shakeScale = blast.inCone ? 1.0 : 0.45;
        const k = (1 - blast.dist / (C2_BLAST_RADIUS * 1.6)) * shakeScale;
        this.d.player.addViewKick?.((0.08 + Math.random() * 0.06) * k, (Math.random() - 0.5) * 0.14 * k);
      }
      if (blast.inCone && hasLineOfSight(this.d.colliders, blastOrigin, eye)) {
        const hp = this.d.player.takeDamage(blast.damage);
        this.d.bus.emit('playerHit', { shooter: by.id, damage: blast.damage, from: blastOrigin, hp });
        const blindDur = 1.4 * blast.stunScale;
        this.d.flashOverlay?.trigger(0.45 * blast.stunScale, blindDur, 0.75 * blast.stunScale);
        this.d.bus.emit('playerBlinded', {
          duration: blindDur,
          pos: { x: this.d.player.position.x, y: this.d.player.position.y, z: this.d.player.position.z },
        });
        this.d.subtitle.show('C2爆破の爆風と衝撃波を受けた！', 2.0);
        playerStunned = true;
      }
    }
    if (!playerStunned && this.flashesLeft > 0 && this.flashCd <= 4) {
      const target = {
        x: door.centerX + blastDir.x * 2.6,
        y: door.sillY,
        z: door.centerZ + blastDir.z * 2.6,
      };
      this.throwFlash(by, target, 1.4);
    }
  }

  /** 追跡中、潜伏推定位置が近く直接視認できていなければ閃光弾を投げ込む（ドア枠・窓・壁バウンド含む）。 */
  tryFlash(by: SwatHunter, target: Vec3): void {
    if (this.flashCd > 0 || this.flashesLeft <= 0 || this.sightingAge > 12 || this.hostageShieldUp()) return; // 人質が巻き込まれるので投げない
    const d = Math.hypot(target.x - by.body.px, target.z - by.body.pz);
    if (d < 2.0 || d > SWAT_FLASH_MAX_DIST + 2 || Math.abs(target.y - by.body.footY) > 0.75) return;
    const from = by.body.chestPos();
    const origin = { x: from.x, y: from.y + 0.25, z: from.z };
    const plan = planFlashThrow(
      origin,
      target,
      this.d.doors.doors,
      this.d.windows ?? [],
      this.d.colliders,
      this.d.flashbang.gravity,
      SWAT_FLASH_MIN_DIST,
      SWAT_FLASH_MAX_DIST,
    );
    if (!plan) return;
    this.launchFlash(by, origin, plan.velocity, plan.fuse);
  }

  private throwFlash(by: SwatHunter, target: Vec3, fuse: number): void {
    const from = by.body.chestPos();
    const origin = { x: from.x, y: from.y + 0.25, z: from.z };
    const vel = computeBallisticVelocity(origin, { x: target.x, y: target.y + 0.3, z: target.z }, this.d.flashbang.gravity, 9, 0.35, 0.9);
    this.launchFlash(by, origin, vel, fuse);
  }

  private launchFlash(by: SwatHunter, origin: Vec3, velocity: Vec3, fuse: number): void {
    this.d.flashbang.throwFrom(origin, velocity, by.id, fuse);
    this.flashesLeft--;
    this.flashCd = lerp(FLASH_TEAM_CD, FLASH_TEAM_CD * 0.5, this.pressure);
    this.radio(by, 'フラッシュ投下！', 'Flashbang out!', true);
  }

  // ---------- 圧力（追い立て） ----------

  /** 圧力を進め、SWAT の積極性・閃光補充・ドローン探知を更新する */
  private updatePressure(dt: number): void {
    // 人質を盾にして立ち回っている間は SWAT も手が出しにくく、圧力の上昇が鈍る
    this.assaultSec += dt * (this.hostageShieldUp() ? 0.5 : 1);
    this.pressureTick -= dt;
    if (this.pressureTick <= 0) {
      this.pressureTick = 0.5;
      this.applyPressure();
    }
    this.flashRefill += dt;
    if (this.flashRefill >= FLASH_REFILL_SEC * lerp(1, 0.55, this.pressure)) {
      this.flashRefill = 0;
      if (this.flashesLeft < SWAT_FLASH_CARRY_MAX) this.flashesLeft++;
    }
    this.updateIntel(dt);
  }

  private applyPressure(): void {
    const t = Math.min(1, this.assaultSec / PRESSURE_RAMP_SEC + this.downBonus);
    this.pressure = t;
    this.reactionSec = lerp(BASE_REACTION_SEC, 0.16, t);
    const c = SWAT_COMBAT;
    const b = BASE_SWAT_COMBAT;
    c.coverSecMin = lerp(b.coverSecMin, 0.25, t);
    c.coverSecMax = lerp(b.coverSecMax, 0.65, t);
    c.fireInterval = lerp(b.fireInterval, 0.14, t);
    c.baseSpreadDeg = lerp(b.baseSpreadDeg, 2.0, t);
    c.shotsPerPeek = Math.round(lerp(b.shotsPerPeek, 6, t));
    c.peekSecMax = lerp(b.peekSecMax, 2.1, t);
    c.moveSpeed = lerp(b.moveSpeed, 2.75, t);
    c.flinchSec = lerp(b.flinchSec, 0.09, t);
    c.decisionSec = lerp(b.decisionSec, 0.5, t);
    const sc = SHIELD_COMBAT;
    const sb = BASE_SHIELD_COMBAT;
    sc.fireInterval = lerp(sb.fireInterval, 0.22, t);
    sc.baseSpreadDeg = lerp(sb.baseSpreadDeg, 1.8, t);
    sc.moveSpeed = lerp(sb.moveSpeed, 2.35, t);
    sc.flinchSec = lerp(sb.flinchSec, 0.05, t);
    sc.decisionSec = c.decisionSec;
    const m = SWAT_MOBILITY;
    const bm = BASE_SWAT_MOBILITY;
    m.repositionAfterLostSec = lerp(bm.repositionAfterLostSec, 0.5, t);
    m.flankChance = lerp(bm.flankChance, 0.85, t);
    const step = t >= 1 ? 4 : t >= 0.66 ? 3 : t >= 0.33 ? 2 : 1;
    if (step > this.pressureStep) {
      this.pressureStep = step;
      const lines: Record<number, [string, string]> = {
        2: ['時間をかけるな、距離を詰めろ！', 'Tighten up, push in!'],
        3: ['容疑者は追い詰められている。一気に制圧する！', 'He is cornered, press the attack!'],
        4: ['全員突っ込め！ 逃がすな！', 'All units, press! Do not let him breathe!'],
      };
      const line = lines[step];
      if (line) this.radio(this.firstAlive(), line[0], line[1], true);
    }
  }

  /** 人質を抱えていて盾が有効（暴れて崩れていない） */
  private hostageShieldUp(): boolean {
    return this.playerHoldsHostage() && (this.d.shieldActive?.() ?? true);
  }

  private playerHoldsHostage(): boolean {
    for (const c of this.d.civilians()) if (c.alive && c.shieldedBy === 'player') return true;
    return false;
  }

  /**
   * ドローン熱源探知: 圧力が上がると、誰も交戦していない間でも定期的にプレイヤーの大まかな位置が全隊に共有される。
   * 誤差は圧力が高いほど小さい。無線が傍受されるので、探知された側にも「来る」ことが分かる。
   */
  private updateIntel(dt: number): void {
    this.intelCd -= dt;
    if (this.pressure < 0.3 || this.intelCd > 0) return;
    if (this.hunters.some((h) => h.alive && (h.state === 'engage' || h.state === 'rush'))) return;
    this.intelCd = lerp(INTEL_INTERVAL_MAX, INTEL_INTERVAL_MIN, this.pressure);
    const p = this.d.player.position;
    const a = Math.random() * Math.PI * 2;
    const err = lerp(INTEL_ERROR_MAX, INTEL_ERROR_MIN, this.pressure) * Math.sqrt(Math.random());
    const guess = { x: p.x + Math.cos(a) * err, y: p.y, z: p.z + Math.sin(a) * err };
    let sent = false;
    for (const h of this.hunters) {
      if (
        !h.alive ||
        h.state === 'breach' ||
        h.state === 'disarm' ||
        h.state === 'staging' ||
        h.state === 'stack' ||
        h.state === 'rush'
      ) continue;
      if (h.leader && h.leader.alive) continue; // 組員はリーダーに追従する
      h.huntTarget = { ...guess };
      h.setState('hunt');
      sent = true;
    }
    if (sent) {
      this.shareSighting(guess);
      this.radio(
        this.firstAlive(),
        `ドローンが熱源を探知！ ${this.roomName(guess)}付近だ、包囲しろ！`,
        'Drone has a heat signature! Surround the area!',
        true,
      );
    }
  }

  /** 姿を見失った位置への制圧射撃。壁越しでも撃ち込むので窓のバリケードも削られる。人質が盾になっている向きには撃たない */
  suppress(by: SwatHunter, at: Vec3): void {
    if (by.engage.ammoLeft <= 0 || by.engage.label === 'reload' || by.engage.label === 'toCover') return;
    const d = Math.hypot(at.x - by.body.px, at.z - by.body.pz);
    if (d > by.combat.engageRange || Math.abs(at.y - by.body.footY) > 1.2) return;
    if (this.coveredByHostage(by.body.px, by.body.pz)) return;
    by.engage.fireAt(null, at);
  }

  // ---------- 部屋の掃討 ----------

  /** 屋内を格子に区切る（初回のみ）。壁・家具で塞がれたマスは除く */
  private coverCells(): CoverCell[] {
    if (this.cells) return this.cells;
    const out: CoverCell[] = [];
    for (const r of this.rooms) {
      const fy = r.floorY ?? 0;
      const nx = Math.max(1, Math.round((r.width - 0.8) / COVER_CELL));
      const nz = Math.max(1, Math.round((r.depth - 0.8) / COVER_CELL));
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const x = r.x - r.width / 2 + 0.4 + ((i + 0.5) * (r.width - 0.8)) / nx;
          const z = r.z - r.depth / 2 + 0.4 + ((j + 0.5) * (r.depth - 0.8)) / nz;
          if (blockedAtFiltered(this.d.colliders, x, z, 0.3, fy)) continue;
          out.push({ x, y: fy, z, room: r.id, seen: false, bad: false });
        }
      }
    }
    this.cells = out;
    return out;
  }

  /** 隊員の視界（視野角・距離・遮蔽）に入ったマスを確認済みにする */
  private scanCoverage(h: SwatHunter): void {
    const cells = this.coverCells();
    const eye = { x: h.body.px, y: h.body.footY + 1.5, z: h.body.pz };
    const fx = -Math.sin(h.body.yawRad);
    const fz = -Math.cos(h.body.yawRad);
    const cosHalf = Math.cos((COVER_FOV_DEG / 2) * DEG2RAD);
    const touched = new Set<string>();
    for (const c of cells) {
      if (c.seen || Math.abs(c.y - h.body.footY) > 0.9) continue;
      const dx = c.x - eye.x;
      const dz = c.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d > COVER_RANGE) continue;
      if (d > COVER_NEAR && (dx * fx + dz * fz) / d < cosHalf) continue;
      if (d > 0.6 && !hasLineOfSight(this.d.colliders, eye, { x: c.x, y: c.y + 1.0, z: c.z })) continue;
      c.seen = true;
      touched.add(c.room);
    }
    for (const id of touched) this.checkRoomClear(id, h);
  }

  /** 部屋の全マスを確認し終えたら「クリア」を無線で報告する */
  private checkRoomClear(roomId: string, by: SwatHunter): void {
    if (this.cleared.has(roomId)) return;
    const mine = this.coverCells().filter((c) => c.room === roomId);
    if (mine.some((c) => !c.seen && !c.bad)) return;
    const r = this.rooms.find((x) => x.id === roomId);
    if (r) this.markCleared(r, by);
  }

  markSeenAround(x: number, z: number, y: number, radius: number): void {
    for (const c of this.coverCells()) {
      if (Math.abs(c.y - y) < 0.9 && Math.hypot(c.x - x, c.z - z) <= radius) c.seen = true;
    }
  }

  markBad(c: CoverCell): void {
    c.bad = true;
  }

  /**
   * 次に向かう未クリアのマス。最寄りを優先し、他の隊員の目標とは離れた場所を選んで手分けする。
   * 全マスをクリアしたら再捜索（ドローンの熱源探知で大まかな位置を共有）。
   */
  pickCell(h: SwatHunter): CoverCell | null {
    let cell = this.nearestCell(h);
    if (cell) return cell;
    // 全区画クリア: 再捜索
    for (const c of this.coverCells()) c.seen = false;
    this.cleared.clear();
    if (this.coverCells().every((c) => c.bad)) for (const c of this.coverCells()) c.bad = false;
    if (this.droneCd <= 0) {
      this.droneCd = 30;
      const p = this.d.player.position;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 4;
      const guess = { x: p.x + Math.cos(a) * rr, y: p.y, z: p.z + Math.sin(a) * rr };
      this.radio(h, '全区画クリア、容疑者なし。ドローンが熱源を探知、その付近を再捜索する。', 'No suspect. Drone has a heat signature, moving.', true);
      for (const x of this.hunters) {
        if (!x.alive || x.state === 'engage' || x.state === 'rush' || x.state === 'breach' || (x.leader && x.leader.alive)) continue;
        x.huntTarget = { ...guess };
        if (x !== h) x.setState('hunt');
      }
      if (!h.leader || !h.leader.alive) {
        h.huntTarget = { ...guess };
        this.pendingHunt.add(h);
      }
    }
    cell = this.nearestCell(h);
    return cell;
  }

  private nearestCell(h: SwatHunter): CoverCell | null {
    const taken: CoverCell[] = [];
    for (const x of this.hunters) if (x !== h && x.alive && x.goalCell) taken.push(x.goalCell);
    let best: CoverCell | null = null;
    let bestScore = Infinity;
    for (const c of this.coverCells()) {
      if (c.seen || c.bad) continue;
      let score = Math.hypot(c.x - h.body.px, c.z - h.body.pz) + Math.abs(c.y - h.body.footY) * 6;
      if (h.goalRoom === c.room) score -= 3; // 今いる部屋を先に塗りつぶす
      for (const t of taken) if (Math.hypot(t.x - c.x, t.z - c.z) < 4 && Math.abs(t.y - c.y) < 0.9) score += 20;
      score += Math.random() * 1.2;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) h.goalRoom = best.room;
    return best;
  }

  markCleared(r: RoomDef, by: SwatHunter): void {
    if (this.cleared.has(r.id)) return;
    this.cleared.add(r.id);
    if (this.radioCd <= 0 && Math.random() < 0.45) this.radio(by, `${r.name}、クリア。`, 'Room clear.');
  }

  /** 追跡の到達地点周辺は確認済みとみなす */
  markRoomAt(x: number, z: number, y: number): void {
    this.markSeenAround(x, z, y, 2.5);
  }

  private roomAt(x: number, z: number, y: number): RoomDef | null {
    return (
      this.rooms.find(
        (r) => Math.abs((r.floorY ?? 0) - y) < 0.75 && Math.abs(x - r.x) <= r.width / 2 && Math.abs(z - r.z) <= r.depth / 2,
      ) ?? null
    );
  }

  private roomName(pos: Vec3): string {
    return this.roomAt(pos.x, pos.z, pos.y)?.name ?? '前方';
  }

  isDoorBeingBreached(doorId: string, exclude?: SwatHunter): boolean {
    return this.hunters.some((h) => h !== exclude && h.alive && h.state === 'breach' && h.breachDoorId === doorId);
  }

  findLockedDoor(h: SwatHunter, goal: Vec3, skip: ReadonlySet<string>): Door | null {
    let best: Door | null = null;
    let bestScore = Infinity;
    for (const door of this.d.doors.doors) {
      if (!door.locked || skip.has(door.id) || this.trapHeld(door) || this.isDoorBeingBreached(door.id, h)) continue;
      if (Math.abs(door.sillY - h.body.footY) > 0.75 && Math.abs(door.sillY - goal.y) > 0.75) continue;
      const dh = Math.hypot(door.centerX - h.body.px, door.centerZ - h.body.pz);
      if (dh > 22) continue;
      const score = dh + Math.hypot(door.centerX - goal.x, door.centerZ - goal.z);
      if (score < bestScore) {
        bestScore = score;
        best = door;
      }
    }
    return best;
  }

  /**
   * プレイヤーが人質を盾にしており、(x,z) がプレイヤー正面 ±HOSTAGE_COVER_DEG にある。
   * 人質の体は視界を開けるため前方の横にずらしてあるので、盾の扇は体の位置ではなく向いている正面で測る。
   */
  coveredByHostage(x: number, z: number): boolean {
    let holding = false;
    for (const c of this.d.civilians()) {
      if (c.alive && c.shieldedBy === 'player') {
        holding = true;
        break;
      }
    }
    if (!holding) return false;
    if (this.d.shieldActive && !this.d.shieldActive()) return false; // 人質が暴れて盾が崩れている
    const p = this.d.player.position;
    const yaw = this.d.player.yawRad;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const tx = x - p.x;
    const tz = z - p.z;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-3) return true;
    return (fx * tx + fz * tz) / tl >= Math.cos(HOSTAGE_COVER_DEG * DEG2RAD);
  }

  /** from→to の射線上に生存民間人の体がある */
  civilianInLine(from: Vec3, to: Vec3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    this.ray.origin.set(from.x, from.y, from.z);
    this.ray.direction.set(dx / len, dy / len, dz / len);
    for (const c of this.d.civilians()) {
      if (!c.alive) continue;
      const a = c.body.getAABB();
      this.box.min.set(a.min.x - 0.05, a.min.y, a.min.z - 0.05);
      this.box.max.set(a.max.x + 0.05, a.max.y, a.max.z + 0.05);
      if (this.ray.intersectBox(this.box, this.hit) && this.hit.distanceTo(this.ray.origin) < len - 0.2) return true;
    }
    return false;
  }

  // ---------- ペッパーボール ----------

  /** 盾持ちへのペッパーボール。命中はプレイヤー本人か抱えた人質（人質は暴れ、盾が崩れやすくなる） */
  firePepper(by: SwatHunter, at: Vec3): void {
    const eye = by.body.footY + 1.55;
    const from = { x: by.body.px, y: eye, z: by.body.pz };
    const dist = Math.hypot(at.x - from.x, at.z - from.z);
    if (dist > SWAT_PEPPER_RANGE) return;
    this.pepperShots++;
    this.d.bus.emit('noise', { pos: from, radius: 14, kind: 'gunshot', source: 'ally' });
    if (this.radioCd <= 0 && Math.random() < 0.3) this.radio(by, '人質がいる、実弾は撃つな！ ペッパーで制圧する！', 'Hostage in line, pepperball only!');
    const hitChance = Math.max(0.2, 0.75 - dist * 0.025);
    if (Math.random() >= hitChance) return;
    const holding = [...this.d.civilians()].some((c) => c.alive && c.shieldedBy === 'player');
    const target = holding && Math.random() < 0.22 ? 'hostage' : 'player';
    this.d.onPepper?.(target);
    if (target === 'player') {
      const p = this.d.player.position;
      this.triggerRush({ x: p.x, y: p.y, z: p.z }, 'pepper');
    }
  }

  // ---------- 窓バリケード破壊（F9） ----------

  attachBarricades(hooks: BarricadeHooks): void {
    this.barricades = hooks;
  }

  /**
   * 目標との射線を遮る板張り窓を検出し、安全な場合に 3 発バーストで撃ち抜く。
   * EngageBehavior.fireAt に CombatThreat.point = b.center を渡すことで STAND_CHEST 加算を防ぎ窓中心へ命中させる。
   */
  tryShootBarricade(h: SwatHunter, dt: number): boolean {
    if (!this.barricades) return false;
    h.barricadeCd = Math.max(0, h.barricadeCd - dt);
    if (h.barricadeCd > 0) return false;
    if (h.sees || h.pepperThreat || h.blindLeft > 0) return false;
    if (h.engage.ammoLeft <= 6 || h.engage.label === 'reload' || h.engage.label === 'toCover') return false;
    const refTarget =
      h.known ??
      h.huntTarget ??
      this.lastSighting ??
      (h.goalCell ? { x: h.goalCell.x, y: h.goalCell.y, z: h.goalCell.z } : null);
    if (!refTarget) return false;
    const boarded = this.barricades.listBoarded();
    if (boarded.length === 0) return false;
    const eye: Vec3 = { x: h.body.px, y: h.body.footY + 1.55, z: h.body.pz };
    const hit = findObstructingBarricade(eye, h.body.footY, refTarget, boarded, this.d.colliders);
    if (!hit) {
      h.barricadeBurst = 0;
      return false;
    }
    if (this.civilianInLine(eye, hit.nearFace) || this.coveredByHostage(h.body.px, h.body.pz)) return false;

    const b = hit.barricade;
    h.body.faceToward(b.center.x, b.center.z);
    h.engage.fireAt({ id: b.id, x: b.center.x, z: b.center.z, point: b.center, isPlayer: false }, null);
    if (h.barricadeBurst <= 0) h.barricadeBurst = 3;
    h.barricadeBurst--;
    h.barricadeCd = h.barricadeBurst > 0 ? Math.max(0.22, h.combat.fireInterval) : 1.1;
    if (this.barricadeRadioCd <= 0) {
      this.barricadeRadioCd = 12;
      this.radio(h, '窓にバリケードだ！ 撃ち抜いて射線を開く！', 'Window is boarded! Shooting it out!');
    }
    return true;
  }

  // ---------- ブービートラップ ----------

  attachTraps(t: TrapHooks): void {
    this.traps = t;
  }

  /** 解除のために押さえているドア（ブリーチ対象から外す） */
  trapHeld(door: Door): boolean {
    return this.heldDoors.has(door.id);
  }

  trapStillThere(door: Door): boolean {
    return !!this.traps?.isTrapped(door.id);
  }

  /** 隊員の近くの閉じた仕掛けドアに気付くか判定。気付けば解除を始める */
  checkTraps(h: SwatHunter): void {
    const t = this.traps;
    if (!t || !this.started || h.blindLeft > 0) return;
    for (const id of t.trappedDoorIds()) {
      const door = this.doorById(id);
      if (!door || door.angle > 2) continue;
      if (Math.abs(door.sillY - h.body.footY) > 0.75) continue;
      if (Math.hypot(door.centerX - h.body.px, door.centerZ - h.body.pz) > TRAP_SPOT_DIST) continue;
      const held = this.heldDoors.get(id);
      if (held) {
        if (held.by && held.by.alive && held.by.state === 'disarm') continue;
        held.by = h; // 前任者が解除を中断した: 引き継ぐ
        h.beginDisarm(door);
        return;
      }
      if (h.checkedTraps.has(id)) continue;
      h.checkedTraps.add(id);
      if (Math.random() >= (this.trapsSeen > 0 ? TRAP_SPOT_CHANCE_WARY : TRAP_SPOT_CHANCE)) continue;
      this.trapsSeen++;
      this.heldDoors.set(id, { wasLocked: door.locked, by: h });
      door.locked = true; // 解除が終わるまで誰も開けない
      h.beginDisarm(door);
      this.radio(h, 'ワイヤーだ！ ドアにブービートラップ！ 解除する、時間をくれ。', 'Tripwire! Door is rigged, stand by.', true);
      if (this.canPlayerHear({ x: door.centerX, y: door.sillY, z: door.centerZ }, 10)) this.d.subtitle.show('SWAT「トラップだ…慎重にいけ」— 解除に手間取っている', 2.0);
      return;
    }
  }

  abandonDisarm(door: Door): void {
    const held = this.heldDoors.get(door.id);
    if (held) held.by = null;
  }

  finishDisarm(h: SwatHunter, door: Door, success: boolean): void {
    const held = this.heldDoors.get(door.id);
    this.heldDoors.delete(door.id);
    door.locked = held?.wasLocked ?? false;
    if (success) {
      this.trapsDisarmed++;
      this.traps?.disarm(door.id);
      this.radio(h, 'トラップ解除完了。前進する。', 'Trap disarmed, moving.', true);
    } else {
      this.radio(h, 'しまった、解除に失敗——！', 'Oh no—', true);
      this.traps?.detonate(door.id);
    }
  }

  /** 毎フレーム: SWAT の近くで仕掛けドアが開いたら起爆 */
  private watchTraps(): void {
    const t = this.traps;
    if (!t || !this.started) return;
    for (const id of [...t.trappedDoorIds()]) {
      const door = this.doorById(id);
      if (!door || door.angle <= 2 || this.heldDoors.has(id)) continue;
      const near = this.hunters.some(
        (h) => h.alive && Math.abs(h.body.footY - door.sillY) < 0.9 && Math.hypot(h.body.px - door.centerX, h.body.pz - door.centerZ) < TRAP_TRIGGER_DIST,
      );
      if (near) t.detonate(id);
    }
  }

  /** トラップの爆発に巻き込まれた隊員の被害 */
  applyBlast(pos: Vec3, radius: number): void {
    let downed = 0;
    for (const h of this.hunters) {
      if (!h.alive) continue;
      const c = h.body.chestPos();
      const dist = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
      if (dist < radius && hasLineOfSight(this.d.colliders, pos, c)) {
        const dmg = Math.round(95 * (1 - 0.6 * (dist / radius)));
        if (h.takeHit(dmg, pos)) {
          this.d.weapons.removeTarget(h);
          this.kills++;
          this.trapKills++;
          downed++;
          this.onManDown(h);
        }
      } else if (dist < radius * 2.2) {
        h.onFlashed(2.2 * (1 - dist / (radius * 2.2)));
      }
    }
    const speaker = this.firstAlive();
    if (speaker) this.radio(speaker, downed > 0 ? '爆発物だ！ 負傷者多数！ ドアに気を付けろ！' : '爆発！ ブービートラップだ、全員ドアを警戒しろ！', 'IED! Watch the doors!', true);
    this.trapsSeen++; // 以後は警戒してトラップに気付きやすい
  }

  // ---------- ユーティリティ ----------

  private firstAlive(): SwatHunter | undefined {
    return this.hunters.find((h) => h.alive);
  }

  private canPlayerHear(pos: Vec3, range: number): boolean {
    const p = this.d.player.position;
    return Math.hypot(p.x - pos.x, p.z - pos.z) <= range;
  }

  emitSwatFootstep(pos: Vec3, heavy: boolean): void {
    if (this.disposed) return;
    this.d.bus.emit('swatFootstep', { pos, heavy });
  }

  private emitRadioNow(h: SwatHunter, text: string, voice: string): void {
    this.radioCd = 3.5;
    this.radioSpeakGap = RADIO_STAGGER_SEC;
    this.d.bus.emit('allyRadio', { allyId: h.id, name: `${RADIO_NAME} ${h.callsign}`, text, voiceText: voice });
  }

  private queueRadio(h: SwatHunter | undefined, text: string, voice: string): void {
    if (!h) return;
    if (this.radioSpeakGap <= 0 && this.radioQueue.length === 0) {
      this.emitRadioNow(h, text, voice);
    } else if (this.radioQueue.length < 4) {
      this.radioQueue.push({ hunter: h, text, voice });
    }
  }

  private radio(h: SwatHunter | undefined, text: string, voice: string, force = false): void {
    if (!h || (!force && this.radioCd > 0)) return;
    this.queueRadio(h, text, voice);
  }

  private resolveSpawns(base: readonly SwatSpawn[], count: number): SwatSpawn[] {
    const out: SwatSpawn[] = base.slice(0, count).map((s) => ({ ...s }));
    const anchor = base[0] ?? { x: 0, y: 0, z: 0 };
    const offsets: [number, number][] = [
      [0.9, 0],
      [-0.9, 0],
      [0, 0.9],
      [0, -0.9],
      [0.9, 0.9],
      [-0.9, -0.9],
      [0.9, -0.9],
      [-0.9, 0.9],
      [1.8, 0],
      [-1.8, 0],
      [0, 1.8],
      [0, -1.8],
    ];
    for (const [ox, oz] of offsets) {
      if (out.length >= count) break;
      const x = anchor.x + ox;
      const z = anchor.z + oz;
      if (blockedAtFiltered(this.d.colliders, x, z, 0.32, anchor.y)) continue;
      if (out.some((s) => Math.hypot(s.x - x, s.z - z) < 0.7)) continue;
      out.push({ x, y: anchor.y, z });
    }
    while (out.length < count) out.push({ ...anchor, x: anchor.x + out.length * 0.2 });
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.c2Blasts.length = 0;
    this.c2BlastLight.intensity = 0;
    this.radioQueue.length = 0;
    this.radioSpeakGap = 0;
    for (const h of this.hunters) {
      this.d.weapons.removeTarget(h);
      h.dispose();
    }
    this.hunters.length = 0;
    disposeObject(this.root);
  }
}



// ---------- M2 純粋ヘルパー: F9（窓バリケードの積極破壊） ----------

/**
 * 射線を塞いでいる板張り窓バリケードを検出する。
 * バリケード自身のコライダで自己遮蔽しないよう、手前面（nearFace = center + normal * side * 0.18）への LOS で判定する。
 */
export function findObstructingBarricade(
  fromEye: Vec3,
  fromFootY: number,
  targetPos: Vec3,
  barricades: readonly BarricadeInfo[],
  colliders: readonly Collider[],
  maxDist = BARRICADE_SHOOT_RANGE,
): { barricade: BarricadeInfo; nearFace: Vec3 } | null {
  if (barricades.length === 0) return null;
  if (hasLineOfSight(colliders, fromEye, { x: targetPos.x, y: targetPos.y + 1.1, z: targetPos.z })) return null;

  const toTargetX = targetPos.x - fromEye.x;
  const toTargetZ = targetPos.z - fromEye.z;
  const targetDist = Math.hypot(toTargetX, toTargetZ);

  let best: BarricadeInfo | null = null;
  let bestFace: Vec3 | null = null;
  let bestScore = Infinity;

  for (const b of barricades) {
    if (!b.boarded || b.hp <= 0) continue;
    if (Math.abs(b.floorY - fromFootY) > 1.2 || Math.abs(b.floorY - targetPos.y) > 1.2) continue;

    const toWinX = b.center.x - fromEye.x;
    const toWinZ = b.center.z - fromEye.z;
    const distToWin = Math.hypot(toWinX, toWinZ);
    if (distToWin < BARRICADE_MIN_DIST || distToWin > maxDist) continue;

    const side = (fromEye.x - b.center.x) * b.normal.x + (fromEye.z - b.center.z) * b.normal.z >= 0 ? 1 : -1;
    const targetDot = (targetPos.x - b.center.x) * b.normal.x + (targetPos.z - b.center.z) * b.normal.z;
    if (targetDot * side >= 0.2) continue; // 同じ側なら射線を遮っていない

    const distWinToTarget = Math.hypot(targetPos.x - b.center.x, targetPos.z - b.center.z);
    const aligned =
      targetDist > 0.5 && (toWinX * toTargetX + toWinZ * toTargetZ) / (distToWin * targetDist) >= 0.45;
    if (distWinToTarget > 7.5 && !aligned) continue;

    const nearFace: Vec3 = {
      x: b.center.x + b.normal.x * side * BARRICADE_FACE_OFFSET,
      y: b.center.y,
      z: b.center.z + b.normal.z * side * BARRICADE_FACE_OFFSET,
    };
    if (!hasLineOfSight(colliders, fromEye, nearFace)) continue;

    const score = distToWin + distWinToTarget * 0.6;
    if (score < bestScore) {
      bestScore = score;
      best = b;
      bestFace = nearFace;
    }
  }
  return best && bestFace ? { barricade: best, nearFace: bestFace } : null;
}


