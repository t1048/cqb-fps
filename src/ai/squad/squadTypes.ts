import type * as THREE from 'three';
import type { GameEventBus } from '../../core/events';
import type { InputManager } from '../../core/InputManager';
import type {
  ArrestConfig,
  CombatParams,
  MobilityParams,
  RoomDef,
  SquadConfig,
  SquadElement,
  SquadOrder,
  Vec3,
  WindowDef,
} from '../../core/types';
import type { PlayerController } from '../../player/PlayerController';
import type { HitTarget, WeaponSystem } from '../../weapons/WeaponSystem';
import type { Flashbang } from '../../weapons/Flashbang';
import type { TearGas } from '../../weapons/TearGas';
import type { Collider } from '../../world/WorldBuilder';
import type { StairMark } from '../../world/Walk';
import type { Door, DoorSystem } from '../../world/Door';
import type { AIDebugLabel } from '../../ui/AIDebugLabel';
import type { CommandMenu } from '../../ui/CommandMenu';
import type {
  AllyTarget,
  CombatThreat,
  EngageBehavior,
  SuspectNavigator,
  XZ,
} from '../EngageBehavior';
import type { StackSlot } from '../stackSlots';
import type { EntryMode, EntryPlan, PieStep } from '../cqbEntry';
import type { HumanoidBody } from '../HumanoidBody';
import type { EntityManager } from '../EntityManager';
import type { TacticalOptics } from '../TacticalOptics';
import type { FlankDoorSample, FlashDoorSample } from '../SwatTactics';
import type { ScoutIntel } from '../ScoutIntel';
import type { DoorTrapSystem } from '../../world/DoorTraps';

export const MAX_DT = 0.05;
/** 追従隊列の列間隔（m） */
export const FOLLOW_ROW_GAP = 0.9;
/** 交戦喪失後に通常戦術へ復帰する秒数 */
export const ENGAGE_LOST_SEC = 6.0;
/** 挟撃ピンサーのチームクールダウン（秒） */
export const PINCER_TEAM_COOLDOWN = 10.0;

/** 視認セル（クリアリング範囲）を全件判定し直す周期（秒）。セル数×視点数の視線判定になるため短すぎると大型マップで CPU を食い尽くす */
export const COVERAGE_PERIOD = 0.25;
/** 階段候補の到達判定（経路探索）をやり直す間隔（s） */
export const STAIR_PICK_INTERVAL = 1.0;
/** タイムアウトしたドアを一時的に通行不能扱いする時間（s） */
export const SKIPPED_DOOR_TTL = 4.0;

// ---- 動きの平滑化・CQB 突入（docs/design/swat-cqb-motion-overhaul.md §3/§4） ----
/** 加速度 (m/s²) */
export const MOVE_ACCEL = 9;
/** 減速度 (m/s²) */
export const MOVE_DECEL = 12;
/** 最終目標の手前でこの距離から減速する (m) */
export const ARRIVE_SLOW_DIST = 0.6;
/** arrive ヒステリシス: 停止は d<r、再始動は d>r+これ */
export const ARRIVE_HYST = 0.35;
/** 追従の再始動/停止距離 */
export const FOLLOW_START_DIST = 0.9;
export const FOLLOW_STOP_DIST = 0.4;
/** プレイヤー移動方向の低域通過時定数 / 更新する最低速度 */
export const FOLLOW_HEADING_TAU = 0.8;
export const FOLLOW_HEADING_MIN_SPEED = 0.6;
/** 隊形目標点の低域通過時定数 */
export const FOLLOW_GOAL_TAU = 0.3;
/** 視線ターゲット切替の最短保持 (s) */
export const LOOK_MIN_HOLD = 0.4;
/** スタック到着半径（layoutStackSlots の arrive と一致） */
export const STACK_ARRIVE = 0.34;
/** スタック中に「進めていない」とみなす停滞秒 */
export const STACK_STALL_WAIT = 0.8;
/** 突入順ゲートのフェイルセーフ (s) */
export const ENTRY_GATE_FAILSAFE = 2.5;
/** 突入経路の中間点 arrive / 最終点 arrive */
export const ENTRY_WP_ARRIVE = 0.3;
export const ENTRY_POD_ARRIVE = 0.28;
/** 突入タイムアウト / スタール */
export const ENTRY_TIMEOUT_SEC = 6.0;
export const ENTRY_STALL_SEC = 2.4;
/** 固定位置フェーズで押し合う重なり距離 */
export const FIXED_OVERLAP = 0.42;
/** PoD への戻り歩行を諦めるまでの累計秒 */
export const POD_RETURN_GIVEUP = 4.0;
/** プレイヤー射線からの退避保持秒 */
export const DODGE_HOLD_SEC = 0.6;
/** secured の視線付け替えにかける秒 */
export const SECURED_TURN_SEC = 0.6;

/** ステルス突入: ドア半開き(peekAngle)での確認保持時間(s) */
export const STEALTH_PEEK_HOLD_SEC = 0.65;
/** スライシング・ザ・パイ各ステップでの静止確認時間(s) */
export const PIE_STEP_HOLD_SEC = 0.32;
/** スライシング・ザ・パイの移動速度倍率 */
export const PIE_SPEED_MUL = 0.62;
/** ステルス突入時の室内進入速度倍率 */
export const STEALTH_ENTRY_SPEED_MUL = 0.74;
/** スライシング・ザ・パイ全体のタイムアウト(s) */
export const PIE_TIMEOUT_SEC = 6.5;
/** 味方射線ブロックが続いてステップアウトを発動する閾値(s) */
export const STEP_OUT_TRIGGER_SEC = 0.38;

/** 隊員番号 → チーム（前半 ALPHA / 後半 BRAVO）と表示用コールサイン */
export function assignElement(index: number, total: number): { elementKey: 'alpha' | 'bravo'; callsign: string } {
  const alphaSize = Math.ceil(total / 2);
  const isAlpha = index < alphaSize;
  const n = isAlpha ? index + 1 : index - alphaSize + 1;
  const team = isAlpha ? 'ALPHA' : 'BRAVO';
  const teamSize = isAlpha ? alphaSize : total - alphaSize;
  return { elementKey: isAlpha ? 'alpha' : 'bravo', callsign: teamSize > 1 ? `${team}-${n}` : team };
}

export interface Cell extends XZ {
  y: number;
  room: RoomDef;
  seen: boolean;
  visible: boolean;
}

export type TacticalPhase =
  | 'follow'
  | 'hold'
  | 'move'
  | 'overwatch'
  | 'stacking'
  | 'door_prep'
  | 'pieing'
  | 'c2_plant'
  | 'c2_standoff'
  | 'flash_wait'
  | 'gas_wait'
  | 'entering'
  | 'sweeping'
  | 'restraining'
  | 'secured';

export interface EntryPortal {
  id: string;
  centerX: number;
  centerZ: number;
  sillY: number;
  intoX: number;
  intoZ: number;
  axisX: number;
  axisZ: number;
  width: number;
  door: Door | null;
}

export interface AllyUnit extends HitTarget {
  name: string;
  /** 無線・HUD 表示用（例: ALPHA-1） */
  callsign: string;
  elementKey: 'alpha' | 'bravo';
  index: number;
  roleIndex: number;
  groupSize: number;
  shielded: boolean;
  combat: CombatParams;
  mobility: MobilityParams;
  body: HumanoidBody;
  nav: SuspectNavigator;
  engage: EngageBehavior;
  optics: TacticalOptics;
  order: SquadOrder;
  phase: TacticalPhase;
  holdPos: { x: number; y: number; z: number } | null;
  moveTarget: { x: number; y: number; z: number; yawRad: number } | null;
  watchYaw: number;
  approach: number;
  door: Door | null;
  entryPortal: EntryPortal | null;
  stackPos: XZ | null;
  podPos: XZ | null;
  podLook: Vec3 | null;
  targetRoom: RoomDef | null;
  entryDelay: number;
  phaseTimer: number;
  doorWait: number;
  flashed: boolean;
  gassed: boolean;
  path: XZ[];
  pathGoal: XZ | null;
  retry: number;
  entered: boolean;
  sweepCell: Cell | null;
  vantage: XZ | null;
  skipped: Set<Cell>;
  sweepElapsed: number;
  assignment: string | null;
  restrainTargetId: string | null;
  holdTime: number;
  fireCd: number;
  warnCd: number;
  hp: number;
  maxHp: number;
  /** 負傷（HP 低下）により移動速度を落としたか */
  wounded: boolean;
  down: boolean;
  engaging: boolean;
  engageActive: boolean;
  holdingFire: boolean;
  known: Vec3 | null;
  sees: boolean;
  threat: CombatThreat | null;
  lostSec: number;
  suppressCd: number;
  pepperTarget: { id: string; pos: Vec3 } | null;
  pepperCd: number;
  flinchLeft: number;
  blindLeft: number;
  rushTimer: number;
  rushTarget: Vec3 | null;
  rushFireCd: number;
  pincerTarget: Vec3 | null;
  pincerTimer: number;
  c2Timer: number;
  c2BeepTimer: number;
  c2Side: number;
  c2Standoff: Vec3 | null;
  c2IsLead: boolean;
  stepAccum: number;
  lastStepX: number;
  lastStepZ: number;
  prevEngageLabel: string;
  progress: string;
  stalled: number;
  stuckStage: 0 | 1 | 2;
  anchor: XZ;
  doorOpenTimer: number;
  doorOpenTargetId: string | null;
  skippedDoors: Map<string, number>;
  stackWaitTimer: number;
  /** 昇降中の階段（退出点に着くまで同じ階段を進み続ける） */
  activeStair: { id: string; up: boolean } | null;
  /** 階段選択のキャッシュ（経路探索を毎フレーム回さない） */
  stairPick: { up: boolean; floorY: number; id: string; timer: number } | null;
  vel: XZ;
  navThisFrame: boolean;
  settled: boolean;
  entryPlan: EntryPlan | null;
  entryOrder: number;
  slotIndex: number;
  entryWp: number;
  entryStartT: number;
  entryCrossT: number;
  entryGateWait: number;
  entryThreatLook: Vec3 | null;
  lookKey: string;
  lookKeyT: number;
  followGoal: XZ | null;
  idleLook: Vec3 | null;
  dodge: { pos: XZ; left: number } | null;
  securedLookSet: boolean;
  securedTurnRate: number;
  podReturnT: number;
  coverHold: { suspectId: string; threatPos: Vec3; hide: XZ; peek: XZ; lostSec: number } | null;
  /** 味方射線ブロックの継続秒（一定時間でステップアウト発動） */
  holdingFireSec: number;
  /** 味方射線回避のステップアウト目標位置 */
  stepOutPos: Vec3 | null;
  /** スライシング・ザ・パイ経路と進行状態 */
  pieSteps: PieStep[];
  pieIdx: number;
  pieHold: number;
  pieElapsed: number;
  /** ステルス突入時の半開き確認タイマー・完了フラグ */
  peekHold: number;
  peekDone: boolean;
  /** 今回の突入がステルスモード由来か（速度・足音に反映） */
  stealthEntry: boolean;
  sweepRetryCd: number;
  /** ミラー確認の残り秒（>0 の間、スタック位置で静止してドア下を確認する） */
  mirrorLeft: number;
  mirrorStarted: boolean;
  /** ドアチェック（施錠・トラップ確認）の残り秒（>0 の間、ドア際でしゃがんで確認する） */
  checkLeft: number;
  checkStarted: boolean;
  /** トラップ解除の残り秒 / 作業を始めたか */
  disarmLeft: number;
  disarmStarted: boolean;
  readonly targetWrapper: AllyTarget & { shieldBlocks(from: Vec3, hit: Vec3): boolean };
  label: AIDebugLabel;
}

/** ドアチェックの結果（先頭の隊員の申告。トラップを見落とすと false になり得る） */
export interface DoorCheckResult {
  locked: boolean;
  trapFound: boolean;
  time: number;
}

/** 同一ポータルにスタックするグループ（スタック待ち・突入順の共有状態） */
export interface PortalGroup {
  order: SquadOrder;
  portal: EntryPortal;
  room: RoomDef | null;
  /** スタック枠（slot index 順） */
  slots: StackSlot[];
  /** グループ全員が「待ち」（到着済み or 停滞）の累計秒 */
  waitT: number;
  /** スタック開始からの経過秒（ハードキャップ用） */
  elapsed: number;
  allSettled: boolean;
  /** 突入開始時に扉の開放状態で経路を一度だけ引き直したか */
  replanned: boolean;
}

export interface ThrownFlash {
  start: THREE.Vector3;
  end: THREE.Vector3;
  elapsed: number;
  flightSec: number;
  fuseSec: number;
  detonated: boolean;
  throwerId: string;
  mesh: THREE.Mesh;
}

export interface C2BlastFx {
  mesh: THREE.Mesh;
  t: number;
}

export interface SquadRosterEntry {
  id: string;
  name: string;
  callsign: string;
  hp: number;
  maxHp: number;
  down: boolean;
  orderLabel: string;
  statusText: string;
  selected: boolean;
}

export interface RestrainTask {
  id: string;
  kind: 'suspect' | 'civilian' | 'evidence';
  x: number;
  y: number;
  z: number;
}

/**
 * `SquadSystem` と `src/ai/squad/*` 各行動モジュール間で共有する状態・依存コンテキスト。
 * `SquadSystem` 自身がこれを実装する。
 */
export interface SquadContext {
  readonly cfg: SquadConfig;
  readonly player: PlayerController;
  readonly input: InputManager;
  readonly colliders: readonly Collider[];
  readonly bounds: { width: number; depth: number };
  readonly stairs: readonly StairMark[];
  readonly doors: DoorSystem;
  readonly entities: EntityManager;
  readonly bus: GameEventBus;
  readonly weapons: WeaponSystem;
  readonly flash: { range: number; blindSec: number };
  readonly rooms: readonly RoomDef[];
  readonly arrestCfg: ArrestConfig;
  readonly flashbang?: Flashbang;
  readonly tearGas?: TearGas;
  readonly windows: readonly WindowDef[];
  /** 偵察情報（オプティワンド/ミラーで確認した部屋・接触） */
  readonly intel: ScoutIntel;
  /** ドアのブービートラップ（SWAT モード。無ければ null） */
  readonly traps: DoorTrapSystem | null;
  /** ドアチェック済みのドア ID → 結果 */
  readonly doorChecks: Map<string, DoorCheckResult>;
  /** 開けようとして「気付き判定」を済ませたドア（1 ドア 1 回） */
  readonly trapSpotRolled: Set<string>;
  /** 乱数（テスト用に差し替え可能。未指定は Math.random） */
  rand?: () => number;

  readonly root: THREE.Group;
  readonly coverage: Cell[];
  readonly cellsByRoom: Map<string, Cell[]>;
  readonly allies: AllyUnit[];
  readonly provoked: Set<string>;
  readonly announcedRooms: Set<string>;
  readonly announcedStacks: Set<string>;
  readonly menu: CommandMenu;
  readonly thrownFlashes: ThrownFlash[];
  readonly flashGeo: THREE.CylinderGeometry;
  readonly flashMat: THREE.MeshStandardMaterial;
  readonly burstMesh: THREE.Mesh;
  readonly c2Blasts: C2BlastFx[];
  readonly recentlyPeppered: Map<string, number>;
  readonly radioQueue: { ally: AllyUnit; text: string; voiceText?: string }[];
  readonly muzzleOriginTmp: Vec3;
  readonly muzzleDirTmp: Vec3;
  readonly portalGroups: Map<string, PortalGroup>;

  sampleTimer: number;
  coverageCursor: number;
  doorStages: string;
  ack: string;
  ackLeft: number;
  selectedElement: SquadElement;
  postClearActive: boolean;
  postClearAnnounced: boolean;
  burstLife: number;
  flashesLeft: number;
  gasLeft: number;
  rushCd: number;
  pincerCd: number;
  contactRadioCd: number;
  pepperRadioCd: number;
  coverRadioCd: number;
  lockedDoorsEncountered: number;
  radioSpeakGap: number;
  simTime: number;
  followHeading: XZ;
  lastPlayerPos: XZ;
  entryMode: EntryMode;
  quickHintCache: string;
  quickHintTimer: number;
  disposed: boolean;

  emitRadio(ally: AllyUnit, text: string, voiceText?: string): void;
  resetUnitForOrder(ally: AllyUnit, order: SquadOrder): void;
  countAlliesCovering(point: Vec3, maxDist?: number): number;
}

export function activeTargets(ctx: SquadContext, element: SquadElement): AllyUnit[] {
  return ctx.allies.filter((a) => !a.down && (element === 'gold' || a.elementKey === element));
}

export function isOrderLockedForAutonomousMove(ally: AllyUnit): boolean {
  return (
    ally.order === 'hold' ||
    ally.order === 'overwatch' ||
    ally.phase === 'restraining' ||
    ally.phase === 'stacking' ||
    ally.phase === 'door_prep' ||
    ally.phase === 'pieing' ||
    ally.phase === 'c2_plant' ||
    ally.phase === 'c2_standoff' ||
    ally.phase === 'flash_wait' ||
    ally.phase === 'gas_wait'
  );
}

export function isPointInRoom(x: number, z: number, y: number, room: RoomDef, margin = 0.25): boolean {
  return (
    Math.abs(y - (room.floorY ?? 0)) < 0.75 &&
    Math.abs(x - room.x) <= room.width / 2 + margin &&
    Math.abs(z - room.z) <= room.depth / 2 + margin
  );
}

export function isRoomConfined(ally: AllyUnit): boolean {
  return (
    ally.targetRoom !== null &&
    (ally.phase === 'entering' || ally.phase === 'sweeping' || ally.phase === 'secured')
  );
}

export function flashDoorSamples(ctx: SquadContext): FlashDoorSample[] {
  return ctx.doors.doors.map((d) => ({
    id: d.id,
    centerX: d.centerX,
    centerZ: d.centerZ,
    normalX: d.normalX,
    normalZ: d.normalZ,
    sillY: d.sillY,
    width: d.width,
    height: d.height,
    angle: d.angle,
    locked: d.locked,
  }));
}

export function flankDoorSamples(ctx: SquadContext): FlankDoorSample[] {
  return ctx.doors.doors.map((d) => ({
    id: d.id,
    centerX: d.centerX,
    centerZ: d.centerZ,
    normalX: d.normalX,
    normalZ: d.normalZ,
    sillY: d.sillY,
    locked: d.locked,
  }));
}
