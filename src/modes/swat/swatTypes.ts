import type { AimSettleParams, CombatParams, MobilityParams, RoomDef, Vec3, WindowDef } from '../../core/types';
import type { GameEventBus } from '../../core/events';
import type { AllyTarget } from '../../ai/EngageBehavior';
import type { HumanoidBody } from '../../ai/HumanoidBody';
import type { StackSlot } from '../../ai/stackSlots';
import type { RestrainTarget } from '../../ai/restrain';
import type { CqbPortal, EntryMode, EntryPlan, EntrySlotRank, FriendlyPos } from '../../ai/cqbEntry';
import {
  BASE_SHIELD_COMBAT,
  BASE_SHIELD_MOBILITY,
  BASE_SWAT_COMBAT,
  BASE_SWAT_MOBILITY,
  SWAT_RADIO_STAGGER_SEC,
  cloneCombatProfile,
  cloneMobilityProfile,
} from '../../ai/SwatProfile';
import type { EntryPortal, EntryRoute } from '../../ai/SwatTactics';
import type { PlayerCombatReceiver } from '../../ai/EntityManager';
import type { Flashbang } from '../../weapons/Flashbang';
import type { TearGas } from '../../weapons/TearGas';
import type { WeaponSystem } from '../../weapons/WeaponSystem';
import type { Door, DoorSystem } from '../../world/Door';
import type { TextureLibrary } from '../../world/Materials';
import type { StairMark } from '../../world/Walk';
import type { Collider } from '../../world/WorldBuilder';
import type { FlashOverlay } from '../../ui/FlashOverlay';
import type { Subtitle } from '../../ui/Subtitle';
import type { SwatHunter } from './SwatHunter';
import type { RoutePlan } from './swatRoutePlanner';

/**
 * 容疑者モードの SWAT 戦闘パラメータ（基準値は SwatProfile.ts）。
 * 圧力（時間経過で SWAT が積極的になる）に応じて SwatTeam が毎秒書き換える（生成時に基準値へ戻す）。
 */
export const SWAT_COMBAT: CombatParams = cloneCombatProfile(BASE_SWAT_COMBAT);
export const SWAT_MOBILITY: MobilityParams = cloneMobilityProfile(BASE_SWAT_MOBILITY);

/**
 * 盾持ち隊員（ポイントマン）: 防弾盾を構えてハンドガンで撃ちながら前進する。遮蔽には籠らず、見失えば即座に詰める。
 * 盾は脛より上の正面を完全に防ぐので、足元を撃つか側面・背後へ回り込むしか倒せない。圧力で SwatTeam が一部を書き換える。
 */
export const SHIELD_COMBAT: CombatParams = cloneCombatProfile(BASE_SHIELD_COMBAT);
export const SHIELD_MOBILITY: Readonly<MobilityParams> = BASE_SHIELD_MOBILITY;

/** 突入開始から圧力が最大になるまでの秒数 */
export const PRESSURE_RAMP_SEC = 95;
/** 隊員が倒されるたびに残りが本気になる加算量 */
export const PRESSURE_PER_DOWN = 0.12;
/** 閃光弾の補充間隔(s)。圧力が高いほどクールダウンも短い */
export const FLASH_REFILL_SEC = 45;

export const DEG2RAD = Math.PI / 180;
export const VISION_FOV_DEG = 120;
export const VISION_RANGE = 16;
export const VISION_RANGE_CROUCH = 11;
/** 視認してから反応して交戦に入るまで。圧力で短くなる（SwatTeam が更新） */
export const BASE_REACTION_SEC = 0.35;
export const HEARING_MUL = 1.0;
export const OCCLUDED_MUL = 0.5;
export const ENGAGE_LOST_SEC = 5;
export const SWEEP_SPEED = 1.0;
export const HUNT_SPEED = 1.05;
export const FLASH_TEAM_CD = 14;
export const SELF_NOISE_RADIUS = 3.2;
/** 多方向同時突入（F6）のスタック・カウントダウン設定 */
export const STACK_OFFSET = 0.48;
export const STACK_PERSONAL_SPACE = 0.68;
export const STACK_TIMEOUT_SEC = 18;
export const ENTRY_COUNTDOWN_SEC = 2.4;
/** 窓バリケード破壊（F9）設定 */
export const BARRICADE_SHOOT_RANGE = 14;
export const BARRICADE_MIN_DIST = 1.0;
export const BARRICADE_FACE_OFFSET = 0.18;
/** 掃討カバレッジ格子の間隔(m)・視認更新間隔(s)・視認距離(m)・視野角(°)・近接で無条件に確認済みとする距離(m) */
export const COVER_CELL = 1.4;
export const COVER_TICK = 0.18;
export const COVER_RANGE = 11;
export const COVER_FOV_DEG = 120;
export const COVER_NEAR = 1.5;
export const GOAL_TIMEOUT_SEC = 30;
/** 掃討目標マスが歩行中に seen になっても、選択後この秒数未満 / 残距離この m 未満なら維持する（U ターン抑制） */
export const GOAL_KEEP_SEC = 1.5;
export const GOAL_KEEP_DIST = 2.0;

/** CQB 突入（'entry'）: 順序ゲートの間隔・フェイルセーフ、PoD 保持、経路点の到着半径、タイムアウト */
export const ENTRY_STAGGER_SEC = 0.45;
export const ENTRY_FAILSAFE_SEC = 2.5;
export const ENTRY_POD_HOLD_SEC = 1.0;
export const ENTRY_WP_ARRIVE = 0.3;
export const ENTRY_TIMEOUT_SEC = 6;
/** 敷居を越えたとみなす屋内側の深さ(m) */
export const ENTRY_CROSS_DEPTH = 0.25;
/** PoD 保持中に seen にする視線扇（半角°・距離 m） */
export const ENTRY_LOOK_HALF_DEG = 50;
export const ENTRY_LOOK_RANGE = 8;
/** 扉が開ききるのを待つ上限(s)。超えたら今の角度で計画する */
export const ENTRY_DOOR_OPEN_WAIT = 3;
/** 味方射線ブロック時のステップアウト発動待機(s) */
export const FRIENDLY_STEP_OUT_SEC = 0.4;
/** ステルス突入: ドア半開き保持(s)・パイ切り各点停止(s)・パイ切り上限(s)・慎重移動速度倍率 */
export const PIE_PEEK_HOLD_SEC = 0.65;
export const PIE_STEP_HOLD_SEC = 0.3;
export const PIE_TIMEOUT_SEC = 6.0;
export const STEALTH_ENTRY_SPEED_MUL = 0.78;
/** スタック枠割当: 同セルが別サイドに分かれるペナルティ、セルの希望サイド（Red=左, Blue=右…）外れの 1 人あたりペナルティ */
export const STACK_CELL_SPLIT_PENALTY = 2;
export const STACK_SIDE_PREF_PENALTY = 1;

/** 非戦闘移動の加減速（SuspectNavigator.smooth の既定 = accel 9 / decel 12 / 減速開始 0.6m） */
export const NAV_SMOOTH = {} as const;
/** 中間経路点では減速しない */
export const NAV_SMOOTH_PASS = { slowRadius: 0 } as const;

/** 進行方向の低域通過（これ以上の速さで動いているときだけ更新）と時定数 */
export const HEADING_MIN_SPEED = 0.5;
export const HEADING_TAU = 0.5;
/** フォロワー隊形: リーダー後方・自サイドへのオフセット、追従開始/停止距離（slot ごとに加算） */
export const FOLLOW_BACK = 1.1;
export const FOLLOW_SIDE = 0.5;
export const FOLLOW_SIDE_3 = 0.6;
export const FOLLOW_START = 2.4;
export const FOLLOW_START_PER_SLOT = 0.6;
export const FOLLOW_STOP = 1.4;
export const FOLLOW_STOP_PER_SLOT = 0.4;
/** リーダー移動中に見る自サイド側のオフセット(rad) */
export const FOLLOW_WATCH_SIDE = 0.6;
/** 視線モード（進行方向 / 警戒方向 / 走査）の最短保持時間 */
export const LOOK_HOLD_SEC = 0.4;
/** scanAround: 振幅・角速度・静止してから走査を始めるまで */
export const SCAN_AMP = 0.9;
export const SCAN_RATE = 0.9;
export const SCAN_IDLE_SEC = 0.6;
/** 固定位置フェーズ（スタック到着済み・突入中）の隊員同士は、この距離未満の重なりだけ下位順位側を押す */
export const SEPARATION_FIXED_DIST = 0.42;
export const SEPARATION_LOOSE_MUL = 0.5;

/** トラップに気付く距離と確率（一度トラップを見つけた後は警戒して上がる） */
export const TRAP_SPOT_DIST = 2.1;
export const TRAP_SPOT_CHANCE = 0.35;
export const TRAP_SPOT_CHANCE_WARY = 0.65;
export const DISARM_SEC_MIN = 7;
export const DISARM_SEC_MAX = 12;
export const DISARM_FAIL_CHANCE = 0.15;
export const TRAP_TRIGGER_DIST = 2.8;

/** プレイヤーが抱えた人質の正面 ±この角度にいる隊員は発砲しない */
export const HOSTAGE_COVER_DEG = 55;

/** 隊員同士がこれより近づいたら押し分ける（m）と、その最大速度（m/s） */
export const SEPARATION_DIST = 0.7;
export const SEPARATION_SPEED = 1.6;
/** 組（セル）ごとのコールサイン接頭辞 */
export const CELL_NAMES = ['Red', 'Blue', 'Gold', 'Green'];
/** 行き詰まった入口を再選択から外す秒数 */
export const PORTAL_BLOCK_SEC = 8;
/** 入口までの経路長キャッシュ（位置は 2m 単位、数件だけ保持） */
export const ROUTE_CACHE_TTL = 1;
export const ROUTE_CACHE_MAX = 6;
export const ENTRY_WALK_RADIUS = 0.3;

/** 施錠ドアを考慮した経路計画: 結果キャッシュ秒・ドア判定半径(m)・歩行半径(m)・各隊員の再計画間隔(s)・ブリーチ失敗扉の除外秒・他隊員のブリーチ待ちの上限秒 */
export const ROUTE_PLAN_CACHE_SEC = 1.2;
export const ROUTE_PLAN_DOOR_RADIUS = 0.95;
export const ROUTE_WALK_RADIUS = 0.3;
export const ROUTE_CHECK_SEC = 1.0;
export const SKIP_DOOR_TTL_SEC = 25;
/** 同じ扉のブリーチを BREACH_RETRY_WINDOW_SEC 秒のうちに BREACH_RETRY_MAX 回より多く始め直したら、その扉をいったん諦める */
export const BREACH_RETRY_MAX = 3;
export const BREACH_RETRY_WINDOW_SEC = 40;
/** 届かなかった音源・目標を諦め済みとして覚える秒数と、同一視する半径(m) */
export const ABANDON_TTL_SEC = 20;
export const ABANDON_RADIUS = 3.5;
export const ROUTE_BREACH_WAIT_SEC = 10;

/** 停滞監視: 段階ごとに無進捗がこの秒数続いたら次の打開策（再計画 / 施錠ドアのブリーチ / ドローン / 直接押し込み）。最終段階は繰り返す */
export const STALL_LEVEL_SEC = [8, 14, 20, 28] as const;
/** 交戦・ブリーチなどで進行中とみなす間、無進捗秒をこの値で頭打ちにする */
export const STALL_BUSY_CAP_SEC = 4;

/**
 * 投降した味方容疑者の拘束（容疑者モード）: 手錠をかける隊員は無防備になる。
 * 接触（手錠を始める）距離・援護役が離れて見張る距離・拘束中の反応遅れ(s)・拘束役を割り当てる最大距離(m)
 * 偽装投降の反撃が起きる進行度の範囲（拘束時間に対する割合）
 */
export const RESTRAIN_REACH = 1.3;
export const RESTRAIN_COVER_DIST = 3.0;
export const RESTRAIN_REACT_PENALTY = 0.3;
export const RESTRAIN_MAX_DIST = 45;
export const RESTRAIN_FAKE_AT_MIN = 0.35;
export const RESTRAIN_FAKE_AT_SPAN = 0.45;
export const RESTRAIN_GIVEUP_SEC = 45;

/**
 * ホットスポット学習（見えない位置から撃たれた開口を全隊で共有し、裸でのぞかない）:
 * 近づいたとみなす距離(m) / 先行照準した隊員が地点に現れた相手へ反応する秒（通常は reactionSec）と、その半径(m)
 * 閃光・ガス・制圧射撃の待機秒 / 盾待ち・挟撃待ちの上限秒 / 前進（先行照準を維持）秒 / 同じ地点の再対策までの秒
 * 半開きドアを疑わしいとみなす静止秒・疑わしい地点を捨てる秒
 */
export const HOT_APPROACH_DIST = 7.5;
export const HOT_PREAIM_REACT_SEC = 0.15;
export const HOT_PREAIM_RADIUS = 2.8;
export const HOT_FLASH_WAIT_SEC = 2.4;
export const HOT_GAS_WAIT_SEC = 4.0;
export const HOT_SUPPRESS_SEC = 3.0;
export const HOT_SHIELD_MAX_SEC = 8;
export const HOT_PINCER_MAX_SEC = 14;
export const HOT_ADVANCE_SEC = 7;
export const HOT_REUSE_SEC = 25;
export const HOT_DOOR_STABLE_SEC = 1.0;
export const HOT_BLIND_TEAM_SEC = 1.2;
export const HOT_SUSPECT_NEAR = 4.5;

export const NAMES = ['アルファ', 'ブラボー', 'チャーリー', 'デルタ', 'エコー', 'フォックス'];

export const CAMP_GAS_THRESHOLD_SEC = 20;
export const GAS_TEAM_CD = 24;

/** 連携無線の最小発話間隔（秒）。speechSynthesis の即時キャンセルを防ぐため >= 1.2s とする */
export const RADIO_STAGGER_SEC = SWAT_RADIO_STAGGER_SEC;

/** 屋内を格子状に区切った 1 マス。視界に入ると seen になる（未視認 = まだクリアしていない場所） */
export interface CoverCell {
  x: number;
  y: number;
  z: number;
  room: string;
  seen: boolean;
  /** 到達できなかったマス（再捜索の周回までは対象にしない） */
  bad: boolean;
  /** マスの位置で indoorRoomAt が返す部屋（重なり部屋では小さい方）。同室判定に使う */
  zone?: string | null;
}

export type HunterState =
  | 'staging'
  | 'stack'
  | 'pie'
  | 'entry'
  | 'sweep'
  | 'hunt'
  | 'breach'
  | 'engage'
  | 'rush'
  | 'disarm'
  | 'restrain'
  | 'down';

/** 同じ入口に積んだ隊員の突入グループ（スタック枠・突入順・突入計画を共有） */
export interface EntryGroup {
  portal: EntryPortal;
  cqb: CqbPortal | null;
  room: RoomDef | null;
  slots: StackSlot[];
  /** members[i] は slots[i] の隊員 */
  members: SwatHunter[];
  ranks: EntrySlotRank[];
  plans: EntryPlan[] | null;
  phase: 'stacking' | 'breach' | 'pie' | 'entering' | 'done';
  entryStyle: EntryMode;
  breacher: SwatHunter | null;
  pieHunter: SwatHunter | null;
  /** 現フェーズの経過秒 */
  clock: number;
}

export interface ShieldBody {
  readonly alive: boolean;
  readonly body: HumanoidBody;
  readonly shieldedBy?: string | null;
}

export interface SwatSpawn {
  x: number;
  y: number;
  z: number;
}

export interface SwatTeamDeps {
  /** 敵 SWAT の照準の収束（ai_profiles.json の swatAimSettle） */
  aimSettle?: AimSettleParams;
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
  /** 投降・拘束済みの味方容疑者（SWAT が手錠をかけに行く）。未指定なら拘束しない */
  restrainables?: () => readonly RestrainTarget[];
  /** 人質の盾が今有効か（人質が暴れている間は無効）。未指定なら常に有効 */
  shieldActive?: () => boolean;
  /** ペッパーボールの命中（プレイヤー本人 / 抱えた人質） */
  onPepper?: (target: 'player' | 'hostage') => void;
}

/** ドアのブービートラップ（Fortify が実装） */
export interface TrapHooks {
  isTrapped(doorId: string): boolean;
  trappedDoorIds(): Iterable<string>;
  detonate(doorId: string): void;
  disarm(doorId: string): void;
}

/** 交渉の差し入れによる偵察情報（突入の瞬間にプレイヤーがいた部屋） */
export interface BreachIntel {
  roomId: string;
  x: number;
  y: number;
  z: number;
  name: string;
}

/** SwatHunter が親 SwatTeam に対して呼び出す契約インターフェース */
export interface SwatTeamHost {
  /** 偵察情報。無い・確認済みなら null */
  readonly breachIntel: BreachIntel | null;
  readonly currentPressure: number;
  readonly playerCrouching: boolean;
  readonly reactionSec: number;
  readonly lastSighting: Vec3 | null;
  readonly lastSightingAge: number;
  readonly clock: number;
  readonly aimSettle?: AimSettleParams;

  abandonDisarm(door: Door): void;
  checkTraps(h: SwatHunter): void;
  emitSwatFootstep(pos: Vec3, heavy: boolean): void;
  otherHunterPositions(exclude: SwatHunter): FriendlyPos[];
  tryShootBarricade(h: SwatHunter, dt: number): boolean;
  doorById(id: string): Door | null;
  markEntryLookSector(h: SwatHunter, look: Vec3): void;
  onContact(by: SwatHunter, pos: Vec3): void;
  shareSighting(pos: Vec3): void;
  civilianInLine(from: Vec3, to: Vec3): boolean;
  coveredByHostage(x: number, z: number): boolean;
  friendlyInLine(shooter: SwatHunter, from: Vec3, to: Vec3): boolean;
  firePepper(by: SwatHunter, at: Vec3): void;
  tryFlash(by: SwatHunter, target: Vec3): void;
  suppress(by: SwatHunter, at: Vec3): void;
  routeFrom(
    x: number,
    z: number,
    y: number,
    goal: Vec3,
    preferPortalId?: string | null,
    mode?: 'hold' | 'attack',
    blacklist?: { has(id: string): boolean },
    prevPhase?: EntryRoute['phase'] | null,
    prevEntryId?: string | null,
  ): EntryRoute;
  hasAlternateEntry(from: Vec3, exceptId: string, blacklist?: { has(id: string): boolean }): boolean;
  unclearedIndoorRoom(h: SwatHunter): RoomDef | null;
  indoorRoomAt(x: number, z: number, y: number): RoomDef | null;
  markRoomAt(x: number, z: number, y: number): void;
  pickCell(h: SwatHunter): CoverCell | null;
  nextClearCell(h: SwatHunter): CoverCell | null;
  markBad(c: CoverCell): void;
  markSeenAround(x: number, z: number, y: number, radius: number): void;
  sameIndoorRoom(x: number, z: number, y: number, goal: Vec3): boolean;
  planRoute(from: Vec3, goal: Vec3, skip?: ReadonlySet<string>): RoutePlan;
  trapHeld(door: Door): boolean;
  isDoorBeingBreached(doorId: string, exclude?: SwatHunter): boolean;
  findLockedDoor(h: SwatHunter, goal: Vec3, skip: ReadonlySet<string>): Door | null;
  shouldUseC2(doorId: string): boolean;
  onBreach(by: SwatHunter, door: Door): void;
  onC2PlantStart(by: SwatHunter, door: Door): void;
  /** 扉に途中まで付けた C2 の進み具合（秒）。未着手は 0 */
  c2PlantProgress(doorId: string): number;
  /** 設置を途中でやめた。進み具合を残す */
  saveC2PlantProgress(doorId: string, sec: number): void;
  /** 設置完了。時限・警告音・起爆はチームが受け持つ */
  armC2(by: SwatHunter, door: Door, side: number): void;
  /** 扉に時限の進んでいる C2 があるか */
  isC2Armed(doorId: string): boolean;
  emitC2Beep(door: Door, urgent: boolean): void;
  detonateC2(by: SwatHunter, door: Door, side: number): void;
  trapStillThere(door: Door): boolean;
  finishDisarm(h: SwatHunter, door: Door, success: boolean): void;
}
