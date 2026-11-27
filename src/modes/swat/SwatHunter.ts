import * as THREE from 'three';
import type { GameEventBus } from '../../core/events';
import type { CombatParams, Vec3 } from '../../core/types';
import {
  EngageBehavior,
  SuspectNavigator,
  findNearestVisibleThreat,
  resolveFloorY,
  type AllyTarget,
  type CombatContext,
  type CombatThreat,
} from '../../ai/EngageBehavior';
import { HumanoidBody } from '../../ai/HumanoidBody';
import { shieldBlocks } from '../../ai/ShieldGuard';
import type { RestrainTarget } from '../../ai/restrain';
import { blockedAtFiltered } from '../../ai/SquadRoute';
import {
  computeCornerLean,
  computeStackLookPoint,
  computeStepOutPoint,
  cqbRoomFromRoomDef,
  fromPortalFrame,
  planDoorPieArc,
  portalLeanToBodyLean,
  shouldUseLowReady,
  toPortalFrame,
  type EntryPlan,
  type PieStep,
} from '../../ai/cqbEntry';
import {
  SWAT_C2_BEEP_INTERVAL,
  SWAT_C2_FUSE_SEC,
  SWAT_C2_PLANT_SEC,
  SWAT_C2_URGENT_AT_SEC,
  SWAT_C2_URGENT_BEEP_INTERVAL,
  SWAT_FOOTSTEP_STRIDE_FAST,
  SWAT_FOOTSTEP_STRIDE_NORMAL,
  SWAT_HP,
  SWAT_PEPPER_INTERVAL,
  SWAT_READY_POSE,
  SWAT_RUSH_DURATION_SEC,
  SWAT_RUSH_SPEED_MAX,
  SWAT_RUSH_SPEED_MIN,
  SWAT_SHIELD_RUSH_SPEED,
  SWAT_SUPPRESS_END_SEC,
  SWAT_SUPPRESS_INTERVAL,
  SWAT_SUPPRESS_START_SEC,
  SWAT_UNIFORM_COLOR,
} from '../../ai/SwatProfile';
import { computeC2Standoff, isIndoorPoint, type EntryPortal, type EntryRoute } from '../../ai/SwatTactics';
import { TacticalOptics } from '../../ai/TacticalOptics';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { HitTarget } from '../../weapons/WeaponSystem';
import type { Door } from '../../world/Door';
import type { TextureLibrary } from '../../world/Materials';
import type { AABB, Collider } from '../../world/WorldBuilder';
import { lerp } from './swatHelpers';
import {
  COVER_NEAR,
  DEG2RAD,
  DISARM_FAIL_CHANCE,
  DISARM_SEC_MAX,
  DISARM_SEC_MIN,
  ENGAGE_LOST_SEC,
  ENTRY_CROSS_DEPTH,
  ENTRY_FAILSAFE_SEC,
  ENTRY_POD_HOLD_SEC,
  ENTRY_STAGGER_SEC,
  ENTRY_TIMEOUT_SEC,
  ENTRY_WP_ARRIVE,
  FOLLOW_BACK,
  FOLLOW_SIDE,
  FOLLOW_SIDE_3,
  FOLLOW_START,
  FOLLOW_START_PER_SLOT,
  FOLLOW_STOP,
  FOLLOW_STOP_PER_SLOT,
  FOLLOW_WATCH_SIDE,
  FRIENDLY_STEP_OUT_SEC,
  GOAL_KEEP_DIST,
  GOAL_KEEP_SEC,
  GOAL_TIMEOUT_SEC,
  HEADING_MIN_SPEED,
  HEADING_TAU,
  HUNT_SPEED,
  LOOK_HOLD_SEC,
  NAV_SMOOTH,
  NAV_SMOOTH_PASS,
  PIE_PEEK_HOLD_SEC,
  PIE_STEP_HOLD_SEC,
  PIE_TIMEOUT_SEC,
  PORTAL_BLOCK_SEC,
  RESTRAIN_COVER_DIST,
  RESTRAIN_GIVEUP_SEC,
  RESTRAIN_REACH,
  RESTRAIN_REACT_PENALTY,
  ROUTE_BREACH_WAIT_SEC,
  ROUTE_CHECK_SEC,
  SKIP_DOOR_TTL_SEC,
  SCAN_AMP,
  SCAN_IDLE_SEC,
  SCAN_RATE,
  SHIELD_COMBAT,
  SHIELD_MOBILITY,
  STEALTH_ENTRY_SPEED_MUL,
  SWAT_COMBAT,
  SWAT_MOBILITY,
  SWEEP_SPEED,
  VISION_FOV_DEG,
  VISION_RANGE,
  VISION_RANGE_CROUCH,
  type CoverCell,
  type EntryGroup,
  type HunterState,
  type SwatSpawn,
  type SwatTeamHost,
} from './swatTypes';

/** SWAT 隊員 1 名。部屋の掃討・音/目撃情報の追跡・施錠ドアのブリーチ・交戦を行う。 */
export class SwatHunter implements HitTarget {
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
  /** 味方 SWAT が射線上にいて発砲を保留中 */
  holdingFriendlyFire = false;
  friendlyBlockSec = 0;
  private stepOutTarget: Vec3 | null = null;
  /** ステルス突入（'pie'）: 対象ドア・段階・弧ステップ */
  pieDoor: Door | null = null;
  piePhase: 'peek' | 'open' | 'arc' = 'peek';
  pieTimer = 0;
  pieSteps: PieStep[] = [];
  pieStepIdx = 0;
  pieStepHold = 0;
  pieDone = false;
  /** 視野内の脅威を反応時間まで追い続けている。このあいだは掃討で顔を逸らさない */
  private acquiring = false;
  pepperCd = Math.random() * SWAT_PEPPER_INTERVAL;
  suppressCd = 0;
  readonly combat: CombatParams;
  disarmDoor: Door | null = null;
  /** 投降した味方容疑者の拘束: 対象と役割（cuff = 手錠をかける / cover = 見張り） */
  restrainTarget: RestrainTarget | null = null;
  restrainRole: 'cuff' | 'cover' = 'cuff';
  disarmSec = 0;
  readonly checkedTraps = new Set<string>();
  private readonly skipDoors = new Set<string>();
  /** ブリーチに失敗した扉を再び候補に戻すまでの残り秒 */
  private readonly skipDoorLeft = new Map<string, number>();
  /** 経路計画（施錠ドア越しの目標）の再確認までの秒・他隊員のブリーチ待ちの累計秒 */
  private routeCheckCd = Math.random() * ROUTE_CHECK_SEC;
  private routeWaitSec = 0;
  /** 行き詰まった外壁入口 → 残り除外秒 */
  private readonly blockedPortals = new Map<string, number>();
  private blockedCount = 0;
  private blockedWindow = 0;
  private scanPhase = Math.random() * Math.PI * 2;
  private entryPhase: EntryRoute['phase'] | null = null;
  private entryRouteId: string | null = null;
  /** CQB 突入（'entry'）: 所属グループ・スタック枠 index・突入順・計画・進行状況 */
  entryGroup: EntryGroup | null = null;
  slotIndex = -1;
  entryOrder = 0;
  entryPlan: EntryPlan | null = null;
  entryWp = 0;
  entryHold = 0;
  /** 突入開始（ゲート通過）時刻（team.clock）。未発進は null */
  entryStartAt: number | null = null;
  entryCrossed = false;
  /** 進行方向の低域通過（単位ベクトル）と今フレームの移動速さ(m/s) */
  headX = 0;
  headZ = -1;
  moveSpeedEst = 0;
  /** 静止し続けている秒数（自分の更新内での移動のみで判定。押し出しは含まない） */
  stillTime = 0;
  private scanBaseYaw = 0;
  /** フォロワー隊形: 追従中か（ヒステリシス）、2 人組での自サイド（固定） */
  private following = false;
  formSide: -1 | 0 | 1 = 0;
  private lookMode: 'travel' | 'watch' | 'scan' = 'scan';
  private lookModeTime = 0;
  readonly optics = new TacticalOptics();
  private stepAccum = 0;
  private lastStepX: number;
  private lastStepZ: number;
  flashRetryCd = 0;
  readonly targetWrapper: AllyTarget;
  private readonly selfPosTmp: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    readonly id: string,
    callsign: string,
    readonly name: string,
    spawn: SwatSpawn,
    private readonly team: SwatTeamHost,
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
    const body = this.body;
    const eyeScratch = new THREE.Vector3();
    const chestScratch: Vec3 = { x: 0, y: 0, z: 0 };
    const aabbScratch: AABB = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    this.targetWrapper = {
      id,
      get px() {
        return body.px;
      },
      get pz() {
        return body.pz;
      },
      get footY() {
        return body.footY;
      },
      get height() {
        return body.height;
      },
      getEye: () => body.eye(eyeScratch),
      getChest: () => body.chestPos(chestScratch),
      getAABB: () => body.getAABB(aabbScratch),
      shieldBlocks: (from, hit) => shieldBlocks(body, from, hit),
    };
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
    if (this.state === 'engage') {
      this.engage.exit();
      this.holdingFriendlyFire = false;
      this.friendlyBlockSec = 0;
      this.stepOutTarget = null;
    }
    if (this.state === 'rush') {
      this.body.setFlash(false);
      this.rushFlinch = 0;
    }
    if (this.state === 'stack') this.stackReady = false;
    if (this.state === 'pie') {
      this.pieDoor = null;
      this.pieSteps = [];
      this.pieStepIdx = 0;
      this.pieStepHold = 0;
      this.pieTimer = 0;
    }
    if (this.state === 'hunt') this.huntingFlank = false;
    if (this.state === 'sweep') this.following = false;
    if (this.state === 'breach') {
      this.clearBreachState();
      this.body.setPose('stand');
    }
    this.body.setLean(0);
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
      this.holdingFriendlyFire = false;
      this.friendlyBlockSec = 0;
      this.stepOutTarget = null;
      this.pieDoor = null;
      this.state = 'down';
      this.optics.hide();
      this.body.setFlash(false);
      this.body.setShake(0);
      this.body.setLean(0);
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
    this.nav.beginFrame();
    const sx = this.body.px;
    const sz = this.body.pz;
    this.updateInner(dt);
    this.trackMotion(sx, sz, dt);
  }

  /** 進行方向を姿勢ヨーから初期化する（突入開始時など） */
  resetHeading(): void {
    this.headX = -Math.sin(this.body.yawRad);
    this.headZ = -Math.cos(this.body.yawRad);
    this.scanBaseYaw = this.body.yawRad;
  }

  /** 自分の更新内での移動から速さ・進行方向（低域通過）・静止時間を更新する */
  private trackMotion(sx: number, sz: number, dt: number): void {
    if (dt <= 0) return;
    const dx = this.body.px - sx;
    const dz = this.body.pz - sz;
    const d = Math.hypot(dx, dz);
    this.moveSpeedEst = d < 1.5 ? d / dt : 0;
    if (this.moveSpeedEst > HEADING_MIN_SPEED) {
      const k = 1 - Math.exp(-dt / HEADING_TAU);
      const hx = this.headX + (dx / d - this.headX) * k;
      const hz = this.headZ + (dz / d - this.headZ) * k;
      const l = Math.hypot(hx, hz);
      if (l > 1e-4) {
        this.headX = hx / l;
        this.headZ = hz / l;
      }
    }
    if (d > 0.004) {
      this.stillTime = 0;
      this.scanBaseYaw = this.body.yawRad;
    } else {
      this.stillTime += dt;
    }
  }

  /** 視線モードを最短保持時間 LOOK_HOLD_SEC 付きで切り替える */
  private switchLookMode(want: 'travel' | 'watch' | 'scan', dt: number): 'travel' | 'watch' | 'scan' {
    this.lookModeTime += dt;
    if (want !== this.lookMode && this.lookModeTime >= LOOK_HOLD_SEC) {
      this.lookMode = want;
      this.lookModeTime = 0;
    }
    return this.lookMode;
  }

  private updateInner(dt: number): void {
    this.stateTime += dt;
    this.flashRetryCd = Math.max(0, this.flashRetryCd - dt);
    this.blockedWindow = Math.max(0, this.blockedWindow - dt);
    if (this.blockedWindow <= 0) this.blockedCount = 0;
    this.tickBlockedPortals(dt);
    this.tickSkipDoors(dt);
    if (this.state === 'staging') return;
    if (this.blindLeft > 0) {
      this.blindLeft = Math.max(0, this.blindLeft - dt);
      this.body.setPose('crouch');
      this.body.setLean(0);
      this.body.setShake(Math.sin(this.blindLeft * 26) * 0.12);
      if (this.blindLeft <= 0) {
        this.body.setShake(0);
        this.body.setPose('stand');
      }
      return;
    }
    this.sense(dt);
    if (
      this.state !== 'engage' &&
      this.state !== 'rush' &&
      this.state !== 'disarm' &&
      this.state !== 'stack' &&
      this.state !== 'pie'
    ) {
      this.team.checkTraps(this);
    }
    switch (this.state) {
      case 'stack':
        this.updateStack(dt);
        break;
      case 'pie':
        this.updatePie(dt);
        break;
      case 'entry':
        this.updateEntry(dt);
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
      case 'restrain':
        this.updateRestrain(dt);
        break;
      case 'sweep':
        this.updateSweep(dt);
        break;
    }
    this.updateReadyPose();
    const moved = Math.hypot(this.body.px - this.lastStepX, this.body.pz - this.lastStepZ);
    this.lastStepX = this.body.px;
    this.lastStepZ = this.body.pz;
    if (moved > 0.001 && moved < 1.5) {
      this.stepAccum += moved;
      const stealthMove =
        this.state === 'pie' || (this.state === 'entry' && this.entryGroup?.entryStyle === 'stealth');
      const stride =
        this.state === 'rush' || this.state === 'stack'
          ? SWAT_FOOTSTEP_STRIDE_FAST
          : stealthMove
            ? SWAT_FOOTSTEP_STRIDE_NORMAL * 1.25
            : SWAT_FOOTSTEP_STRIDE_NORMAL;
      if (this.stepAccum >= stride) {
        this.stepAccum -= stride;
        const heavy =
          !stealthMove && (this.shielded || this.state === 'rush' || this.state === 'stack' || this.state === 'breach');
        this.team.emitSwatFootstep({ x: this.body.px, y: this.body.footY, z: this.body.pz }, heavy);
      }
    }
  }

  /** フェーズ 1A: マズルディシプリン（非視認時に味方・至近壁が前方にあればローレディ、脅威視認時はハイレディ） */
  private updateReadyPose(): void {
    if (this.sees || this.pepperThreat) {
      this.body.setReadyPose('high');
      return;
    }
    const fx = -Math.sin(this.body.yawRad);
    const fz = -Math.cos(this.body.yawRad);
    const wallClose = blockedAtFiltered(
      this.ctx.colliders,
      this.body.px + fx * 0.55,
      this.body.pz + fz * 0.55,
      0.18,
      this.body.footY,
    );
    this.selfPosTmp.x = this.body.px;
    this.selfPosTmp.y = this.body.footY;
    this.selfPosTmp.z = this.body.pz;
    const low = shouldUseLowReady(
      this.selfPosTmp,
      this.body.yawRad,
      this.team.otherHunterPositions(this),
      wallClose,
    );
    this.body.setReadyPose(low ? 'low' : 'high');
  }

  /** スタック待機中のセクター警戒方向を向く（3 名以上なら最後尾が後方警戒） */
  private faceStackSector(dt: number, door: Door | null): void {
    const group = this.entryGroup;
    if (group?.cqb) {
      const rankInfo = this.slotIndex >= 0 ? group.ranks[this.slotIndex] : undefined;
      const rank = rankInfo ? rankInfo.rank : this.entryOrder;
      const side: -1 | 1 = rankInfo ? rankInfo.side : this.formSide === 1 ? 1 : -1;
      const look = computeStackLookPoint(group.cqb, this.entryOrder, group.members.length, rank, side);
      this.body.faceToward(look.x, look.z, 5 * dt);
    } else if (door) {
      this.body.faceToward(door.centerX, door.centerZ, 5 * dt);
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
      this.faceStackSector(dt, door);
      return;
    }
    const res = this.nav.step(slot, this.combat.moveSpeed * 1.15, dt, {
      canOpenDoors: false,
      canUseStairs: false,
      faceTravel: true,
      arriveDist: 0.45,
      smooth: NAV_SMOOTH,
    });
    if (res === 'arrived') {
      this.stackReady = true;
      this.faceStackSector(dt, door);
    } else if (res === 'blocked') {
      const distOut = Math.hypot(this.body.px - portal.outside.x, this.body.pz - portal.outside.z);
      if (distOut <= 2.2) {
        this.stackReady = true;
        this.faceStackSector(dt, door);
      }
    }
  }

  /** フェーズ 2: ステルス突入の先頭員がドアを半開き→ゆっくり開放→外周パイ切りを行う */
  beginPie(group: EntryGroup, door: Door): void {
    this.entryGroup = group;
    this.pieDoor = door;
    this.pieDone = false;
    this.pieTimer = 0;
    this.pieStepIdx = 0;
    this.pieStepHold = 0;
    const rankInfo = this.slotIndex >= 0 ? group.ranks[this.slotIndex] : undefined;
    const side: -1 | 1 = rankInfo ? rankInfo.side : this.formSide === 1 ? 1 : -1;
    const passable = new Set<Collider>(door.colliders);
    this.pieSteps =
      group.cqb && group.room
        ? planDoorPieArc(group.cqb, cqbRoomFromRoomDef(group.room), side, {
            isStandable: (p) => !blockedAtFiltered(this.ctx.colliders, p.x, p.z, 0.3, p.y, passable),
          })
        : [];
    if (door.angle < door.peekAngle - 2) {
      this.piePhase = 'peek';
      door.command(door.peekAngle, false, this.body.px, this.body.pz);
    } else if (door.angle < 55) {
      this.piePhase = 'open';
      door.command(door.maxAngle, false, this.body.px, this.body.pz);
    } else {
      this.piePhase = 'arc';
    }
    this.setState('pie');
  }

  private updatePie(dt: number): void {
    const group = this.entryGroup;
    const door = this.pieDoor;
    if (!group || !door || !group.cqb || group.phase !== 'pie') {
      this.pieDone = true;
      this.body.setLean(0);
      return;
    }
    if (this.stateTime >= PIE_TIMEOUT_SEC) {
      this.pieDone = true;
      this.body.setLean(0);
      return;
    }
    const cqb = group.cqb;
    if (this.piePhase === 'peek') {
      const look = fromPortalFrame(cqb, 0, 1.8);
      this.body.faceToward(look.x, look.z, 5 * dt);
      const uPos = toPortalFrame(cqb, { x: this.body.px, z: this.body.pz }).u;
      const crackAxis: -1 | 0 | 1 = Math.abs(uPos) > 0.12 ? (uPos > 0 ? -1 : 1) : 0;
      this.body.setLean(portalLeanToBodyLean(cqb, this.body.yawRad, crackAxis));
      if (door.angle >= Math.min(door.peekAngle, door.maxAngle) - 3 || !door.isMoving) {
        this.pieTimer += dt;
        if (this.pieTimer >= PIE_PEEK_HOLD_SEC) {
          door.command(door.maxAngle, false, this.body.px, this.body.pz);
          this.piePhase = 'open';
          this.pieTimer = 0;
        }
      }
      return;
    }
    if (this.piePhase === 'open') {
      const look = fromPortalFrame(cqb, 0, 2.2);
      this.body.faceToward(look.x, look.z, 5 * dt);
      const uPos = toPortalFrame(cqb, { x: this.body.px, z: this.body.pz }).u;
      const crackAxis: -1 | 0 | 1 = Math.abs(uPos) > 0.12 ? (uPos > 0 ? -1 : 1) : 0;
      this.body.setLean(portalLeanToBodyLean(cqb, this.body.yawRad, crackAxis));
      this.pieTimer += dt;
      if (door.angle >= Math.min(55, door.maxAngle - 5) || this.pieTimer >= 1.8) {
        this.piePhase = 'arc';
        this.pieStepIdx = 0;
        this.pieStepHold = 0;
      }
      return;
    }
    // 'arc': planDoorPieArc の各点へ慎重に移動し、0.3s 停止して室内をスライスする
    if (this.pieStepIdx >= this.pieSteps.length) {
      this.pieDone = true;
      this.body.setLean(0);
      return;
    }
    const step = this.pieSteps[this.pieStepIdx]!;
    const dist = Math.hypot(step.pos.x - this.body.px, step.pos.z - this.body.pz);
    if (dist > 0.28) {
      const res = this.nav.step(step.pos, this.combat.moveSpeed * STEALTH_ENTRY_SPEED_MUL, dt, {
        canOpenDoors: false,
        canUseStairs: false,
        faceTravel: false,
        arriveDist: 0.25,
        smooth: NAV_SMOOTH,
      });
      this.body.faceToward(step.look.x, step.look.z, 5.5 * dt);
      this.body.setLean(portalLeanToBodyLean(cqb, this.body.yawRad, step.portalLeanAxis));
      if (res === 'blocked') {
        this.pieStepIdx++;
        this.pieStepHold = 0;
      }
    } else {
      this.body.faceToward(step.look.x, step.look.z, 5.5 * dt);
      this.body.setLean(portalLeanToBodyLean(cqb, this.body.yawRad, step.portalLeanAxis));
      this.pieStepHold += dt;
      if (this.pieStepHold >= PIE_STEP_HOLD_SEC) {
        this.pieStepIdx++;
        this.pieStepHold = 0;
      }
    }
  }

  /** CQB 突入（§5-2）: 順序ゲート通過 → サイド固定 waypoints 歩行 → PoD 1.0s 静止警戒 → sweep */
  private updateEntry(dt: number): void {
    const group = this.entryGroup;
    if (!group || group.phase === 'done') {
      this.setState('sweep');
      return;
    }
    if (group.phase === 'breach' || !group.plans) {
      this.body.faceToward(group.portal.inside.x, group.portal.inside.z, 5 * dt);
      return;
    }
    const plan = this.entryPlan;
    if (!plan || plan.waypoints.length === 0) {
      this.setState('sweep');
      return;
    }

    const now = this.team.clock;
    // 順序ゲート（§1-2）: 直前の生存順位者が敷居を越え、かつ stagger 秒経過（またはフェイルセーフ）で発進
    if (this.entryStartAt === null) {
      let pred: SwatHunter | null = null;
      for (const m of group.members) {
        if (!m.alive || m.entryOrder >= this.entryOrder) continue;
        if (!pred || m.entryOrder > pred.entryOrder) pred = m;
      }
      let canGo = false;
      if (!pred) {
        canGo = true;
      } else if (pred.state !== 'entry') {
        canGo = pred.entryStartAt === null || now - pred.entryStartAt >= ENTRY_STAGGER_SEC;
      } else if (pred.entryStartAt !== null) {
        const elapsed = now - pred.entryStartAt;
        canGo = (pred.entryCrossed && elapsed >= ENTRY_STAGGER_SEC) || elapsed >= ENTRY_FAILSAFE_SEC;
      }
      if (!canGo) {
        this.body.faceToward(group.portal.inside.x, group.portal.inside.z, 5 * dt);
        return;
      }
      this.entryStartAt = now;
    }

    // 敷居越え判定
    if (!this.entryCrossed && group.cqb) {
      const { v } = toPortalFrame(group.cqb, { x: this.body.px, z: this.body.pz });
      if (v >= ENTRY_CROSS_DEPTH) this.entryCrossed = true;
    }

    // タイムアウト救済
    if (this.entryWp < plan.waypoints.length && now - this.entryStartAt > ENTRY_TIMEOUT_SEC) {
      if (this.entryCrossed) {
        this.entryWp = plan.waypoints.length;
        this.entryHold = 0;
      } else {
        this.setState('sweep');
        return;
      }
    }

    // 経路 waypoints 歩行
    if (this.entryWp < plan.waypoints.length) {
      const wp = plan.waypoints[this.entryWp]!;
      const isLast = this.entryWp === plan.waypoints.length - 1;
      const speedMul = group.entryStyle === 'stealth' ? STEALTH_ENTRY_SPEED_MUL : 1.1;
      const res = this.nav.step(wp, this.combat.moveSpeed * speedMul, dt, {
        canOpenDoors: false,
        canUseStairs: false,
        faceTravel: false,
        arriveDist: ENTRY_WP_ARRIVE,
        smooth: isLast ? NAV_SMOOTH : NAV_SMOOTH_PASS,
      });
      // 敷居越え前はドア内の反対側コーナー、直後のボタンフック中は自サイドハードコーナー、PoD 接近・到着後は PoD の視線点を見る
      const lookPt =
        this.entryWp === 0 && !this.entryCrossed && group.cqb
          ? fromPortalFrame(group.cqb, -plan.side * 1.5, 2.5)
          : plan.rank === 0 && this.entryWp < plan.waypoints.length - 1
            ? plan.hardCornerLook
            : plan.look;
      this.body.faceToward(lookPt.x, lookPt.z, 5.5 * dt);
      if (res === 'arrived') {
        this.entryWp++;
        if (this.entryWp >= plan.waypoints.length) this.entryHold = 0;
      } else if (res === 'blocked') {
        if (isLast) {
          this.entryWp = plan.waypoints.length;
          this.entryHold = 0;
        } else {
          this.entryWp++;
        }
      }
      return;
    }

    // PoD 到着後: 1.0s 静止して look 方向を保持し、±50°・8m 扇のセルを seen にマーク → sweep
    this.body.faceToward(plan.look.x, plan.look.z, 4 * dt);
    const prevHold = this.entryHold;
    this.entryHold += dt;
    if (prevHold === 0 || Math.floor(prevHold / 0.25) !== Math.floor(this.entryHold / 0.25)) {
      this.team.markEntryLookSector(this, plan.look);
    }
    if (this.entryHold >= ENTRY_POD_HOLD_SEC) {
      this.assignedPortal = null;
      this.setState('sweep');
    }
  }

  /** 視覚。交戦中以外は視野角・反応時間あり。民間人・味方が射線上にいる場合は撃たない（位置は把握）。 */
  private sense(dt: number): void {
    this.sees = false;
    this.threat = null;
    this.pepperThreat = null;
    this.holdingFriendlyFire = false;
    this.acquiring = false;
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
      this.acquiring = true;
      this.spotTimer += dt;
      // 手錠をかけている最中は対象に正対して注意が割かれ、気付くのが遅れる
      // 手錠をかけている最中は対象に正対して注意が割かれ、気付くのが遅れる
      const react = this.team.reactionSec + (this.state === 'restrain' && this.restrainRole === 'cuff' ? RESTRAIN_REACT_PENALTY : 0);
      if (this.spotTimer < react) return;
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
    if (this.team.friendlyInLine(this, from, threat.point)) {
      // 味方 SWAT が射線上: 発砲を保留してステップアウトで射線を開く
      this.holdingFriendlyFire = true;
      return;
    }
    this.sees = true;
    this.threat = threat;
  }

  private updateEngage(dt: number): void {
    if (this.sees) this.lostSec = 0;
    else this.lostSec += dt;
    const k = this.known ?? this.team.lastSighting;

    // フェーズ 1A: 味方射線ブロックが 0.4s 以上続いたら横へステップアウトして射線を開く
    let steppingOut = false;
    if (this.holdingFriendlyFire) {
      this.friendlyBlockSec += dt;
      this.lostSec = Math.min(this.lostSec, 1.0);
      if (this.friendlyBlockSec >= FRIENDLY_STEP_OUT_SEC && k) {
        if (!this.stepOutTarget) {
          const targetPt: Vec3 = { x: k.x, y: k.y + 1.1, z: k.z };
          this.stepOutTarget = computeStepOutPoint(
            { x: this.body.px, y: this.body.footY, z: this.body.pz },
            k,
            (p) => !blockedAtFiltered(this.ctx.colliders, p.x, p.z, 0.3, p.y),
            (p) =>
              !this.team.friendlyInLine(this, { x: p.x, y: p.y + 1.55, z: p.z }, targetPt) &&
              hasLineOfSight(this.ctx.colliders, { x: p.x, y: p.y + 1.55, z: p.z }, targetPt),
          );
        }
        if (this.stepOutTarget) {
          steppingOut = true;
          const res = this.nav.step(this.stepOutTarget, this.combat.moveSpeed * 0.9, dt, {
            canOpenDoors: false,
            canUseStairs: false,
            faceTravel: false,
            arriveDist: 0.25,
            smooth: NAV_SMOOTH,
          });
          this.body.faceToward(k.x, k.z, 6 * dt);
          if (res === 'arrived' || res === 'blocked') this.stepOutTarget = null;
        }
      }
    } else {
      this.friendlyBlockSec = 0;
      this.stepOutTarget = null;
    }

    if (!steppingOut) {
      this.engage.update(dt, k, this.sees, this.threat);
    }

    // フェーズ 3: 交戦中の静止時のみ壁際自動リーン、移動時は直立
    if (!steppingOut && this.moveSpeedEst < 0.25) {
      const lean = computeCornerLean(
        { x: this.body.px, y: this.body.footY, z: this.body.pz },
        this.body.yawRad,
        (x, z) => blockedAtFiltered(this.ctx.colliders, x, z, 0.2, this.body.footY),
      );
      this.body.setLean(lean);
    } else {
      this.body.setLean(0);
    }

    this.pepperCd = Math.max(0, this.pepperCd - dt);
    if (!this.sees && this.pepperThreat && this.pepperCd <= 0) {
      this.pepperCd = SWAT_PEPPER_INTERVAL * (0.8 + Math.random() * 0.5);
      this.lostSec = 0;
      this.body.faceToward(this.pepperThreat.x, this.pepperThreat.z);
      this.team.firePepper(this, this.pepperThreat);
    }
    // 見失った直後: 最後に見えた位置へ閃光を投げ込み、バリケード破壊や制圧射撃で顔出しを潰す
    this.suppressCd = Math.max(0, this.suppressCd - dt);
    if (
      !this.sees &&
      !this.pepperThreat &&
      !this.holdingFriendlyFire &&
      k &&
      this.lostSec >= SWAT_SUPPRESS_START_SEC &&
      this.lostSec <= SWAT_SUPPRESS_END_SEC
    ) {
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
    const route = this.team.routeFrom(
      this.body.px,
      this.body.pz,
      this.body.footY,
      goal,
      this.assignedPortal?.id,
      'attack',
      this.blockedPortals,
      this.entryPhase,
      this.entryRouteId,
    );
    if (route.phase !== 'direct') {
      this.followEntry(route, dt, speed / this.combat.moveSpeed);
    } else {
      if (this.assignedPortal && isIndoorPoint(this.ctx.rooms ?? [], this.body.px, this.body.pz, this.body.footY)) {
        this.assignedPortal = null;
      }
      if (this.entryPhase) {
        this.entryPhase = null;
        this.entryRouteId = null;
        this.nav.reset();
      }
      if (!this.sees && this.checkBlockedRoute(goal, dt) === true) return;
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
    if (this.confineHuntToRoom(dt)) return;
    const t = this.huntTarget;
    if (!t) {
      this.setState('sweep');
      return;
    }
    if (!this.sees && !this.pepperThreat) this.team.tryShootBarricade(this, dt);
    const route = this.team.routeFrom(
      this.body.px,
      this.body.pz,
      this.body.footY,
      t,
      this.assignedPortal?.id,
      'attack',
      this.blockedPortals,
      this.entryPhase,
      this.entryRouteId,
    );
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
      this.entryRouteId = null;
      this.nav.reset();
    }
    this.team.tryFlash(this, t);
    const blockedRoute = this.checkBlockedRoute(t, dt);
    if (blockedRoute === true) return;
    if (blockedRoute === 'unreachable') {
      this.huntTarget = null;
      this.setState('sweep');
      return;
    }
    const res = this.nav.step(t, this.combat.moveSpeed * HUNT_SPEED, dt, {
      canOpenDoors: true,
      canUseStairs: true,
      faceTravel: true,
      arriveDist: 1.4,
      smooth: NAV_SMOOTH,
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

  /**
   * 未クリアの屋内にいるあいだは、隣室への迂回・追跡をしない。
   * 同じ部屋の中の目標へは扉を開けずに歩き、部屋の外が目標なら掃討に戻す。
   */
  private confineHuntToRoom(dt: number): boolean {
    const room = this.team.unclearedIndoorRoom(this);
    if (!room) return false;
    const target = this.huntTarget;
    const destId = target ? this.team.indoorRoomAt(target.x, target.z, target.y)?.id : null;
    if (this.huntingFlank || !target || destId !== room.id) {
      this.huntingFlank = false;
      this.huntTarget = null;
      this.setState('sweep');
      this.updateSweep(dt);
      return true;
    }
    if (!this.sees && !this.pepperThreat) this.team.tryShootBarricade(this, dt);
    const res = this.nav.step(target, this.combat.moveSpeed * HUNT_SPEED, dt, {
      canOpenDoors: false,
      canUseStairs: false,
      faceTravel: !this.acquiring,
      arriveDist: 1.4,
      smooth: NAV_SMOOTH,
    });
    if (res === 'blocked') this.noteBlocked();
    if (res !== 'moving' || this.stateTime > 30) {
      this.huntTarget = null;
      if (res === 'arrived') this.team.markRoomAt(this.body.px, this.body.pz, this.body.footY);
      this.setState('sweep');
    }
    return true;
  }

  /** 屋外にいる間は入口の接近点→ドアの内側へ進み、施錠されていればそのドアをブリーチする。 */
  private followEntry(route: EntryRoute, dt: number, speedScale: number): void {
    // 同じ入口での approach⇔cross 往復時は nav.reset() しない（§5-7）
    if (this.entryRouteId !== route.entryId) {
      this.entryRouteId = route.entryId;
      this.nav.reset();
    }
    this.entryPhase = route.phase;
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
      smooth: route.phase === 'approach' ? NAV_SMOOTH_PASS : NAV_SMOOTH,
    });
    if (res === 'blocked') {
      this.noteBlocked();
      this.noteEntryBlocked(route.entryId);
      if (door) this.tryBeginBreach(route.dest, door.id);
    }
  }

  /** 投降した味方容疑者の拘束に就く（cuff = 手錠をかける / cover = 見張る） */
  beginRestrain(target: RestrainTarget, role: 'cuff' | 'cover'): void {
    this.restrainTarget = target;
    this.restrainRole = role;
    this.huntTarget = null;
    this.setState('restrain');
  }

  endRestrain(): void {
    this.restrainTarget = null;
    this.body.setPose('stand');
    if (this.state === 'restrain') this.setState('sweep');
  }

  /** 至近距離の脅威（偽装投降の反撃など）へ即座に交戦する */
  engageFrom(pos: Vec3): void {
    if (!this.alive) return;
    this.known = { x: pos.x, y: pos.y, z: pos.z };
    this.body.setPose('stand');
    this.body.faceToward(pos.x, pos.z);
    this.team.shareSighting(this.known);
    this.setState('engage');
  }

  private updateRestrain(dt: number): void {
    const t = this.restrainTarget;
    if (!t || !t.alive || !t.surrendered || this.stateTime > RESTRAIN_GIVEUP_SEC) {
      this.endRestrain();
      return;
    }
    const dx = t.px - this.body.px;
    const dz = t.pz - this.body.pz;
    const dist = Math.hypot(dx, dz);
    const goal = { x: t.px, y: t.footY, z: t.pz };
    const want = this.restrainRole === 'cuff' ? RESTRAIN_REACH - 0.25 : RESTRAIN_COVER_DIST;
    if (dist > want || Math.abs(t.footY - this.body.footY) > 0.75) {
      if (this.checkBlockedRoute(goal, dt) === true) return;
      const res = this.nav.step(goal, this.combat.moveSpeed * HUNT_SPEED, dt, {
        canOpenDoors: true,
        canUseStairs: true,
        faceTravel: true,
        arriveDist: want,
        smooth: NAV_SMOOTH,
      });
      if (res === 'blocked') {
        this.noteBlocked();
        this.endRestrain();
      }
      return;
    }
    if (this.restrainRole === 'cuff') {
      // 対象に正対してかがみ込み、手錠をかける（進行は SwatRestraint が数える）
      this.body.faceToward(t.px, t.pz, 5 * dt);
      this.body.setPose('crouch');
    } else {
      // 援護役: 対象から外側（部屋の入口側）を向いて見張る
      const yaw = Math.atan2(dx, dz);
      this.scanAround(dt, yaw);
    }
  }

  /** 停滞時の再計画: 掃討目標・ブリーチ失敗扉・入口の除外・経路待ちをすべて引き直す */
  resetPlanning(): void {
    this.skipDoors.clear();
    this.skipDoorLeft.clear();
    this.blockedPortals.clear();
    this.routeWaitSec = 0;
    this.routeCheckCd = 0;
    this.goalCell = null;
    this.goalTime = 0;
    this.entryPhase = null;
    this.entryRouteId = null;
    this.huntingFlank = false;
    if (this.state === 'hunt') {
      this.huntTarget = null;
      this.setState('sweep');
    } else if (!this.nav.onStair) this.nav.reset();
  }

  private skipDoor(id: string): void {
    this.skipDoors.add(id);
    this.skipDoorLeft.set(id, SKIP_DOOR_TTL_SEC);
  }

  private tickSkipDoors(dt: number): void {
    if (this.skipDoorLeft.size === 0) return;
    for (const [id, left] of this.skipDoorLeft) {
      if (left - dt <= 0) {
        this.skipDoorLeft.delete(id);
        this.skipDoors.delete(id);
      } else this.skipDoorLeft.set(id, left - dt);
    }
  }

  /**
   * 目標が施錠ドアの向こうで、歩いては届かないとき、経路上で最初の施錠ドアをブリーチしに行く。
   * 戻り値 true = このフレームの移動は不要（ブリーチへ遷移した / 他隊員のブリーチ待ち）。
   * 'unreachable' = 施錠ドアを開けても届かない（呼び出し側が目標を諦める）。
   */
  private checkBlockedRoute(goal: Vec3, dt: number): boolean | 'unreachable' {
    this.routeCheckCd -= dt;
    if (this.routeCheckCd > 0) return this.routeWaitSec > 0 && this.routeWaitSec < ROUTE_BREACH_WAIT_SEC ? this.waitingForBreach(dt) : false;
    this.routeCheckCd = ROUTE_CHECK_SEC + Math.random() * 0.4;
    const plan = this.team.planRoute({ x: this.body.px, y: this.body.footY, z: this.body.pz }, goal, this.skipDoors);
    if (plan.reachable) {
      this.routeWaitSec = 0;
      return false;
    }
    if (!plan.door) return 'unreachable';
    if (this.team.isDoorBeingBreached(plan.door.id, this)) {
      // 別の隊員が蹴破っている最中: 近くで待つ（長すぎれば諦めて別の動きに戻る）
      this.routeWaitSec = Math.max(this.routeWaitSec, 0.01);
      return this.waitingForBreach(dt);
    }
    if (this.tryBeginBreach(goal, plan.door.id)) {
      this.routeWaitSec = 0;
      return true;
    }
    return false;
  }

  private waitingForBreach(dt: number): boolean {
    this.routeWaitSec += dt;
    if (this.routeWaitSec >= ROUTE_BREACH_WAIT_SEC) {
      this.routeWaitSec = 0;
      return false;
    }
    this.scanAround(dt, this.scanBaseYaw);
    return true;
  }

  private tickBlockedPortals(dt: number): void {
    if (this.blockedPortals.size === 0) return;
    for (const [id, left] of this.blockedPortals) {
      const next = left - dt;
      if (next <= 0) this.blockedPortals.delete(id);
      else this.blockedPortals.set(id, next);
    }
  }

  /** 到達できる別入口があるときだけ、行き詰まった入口をしばらく外す。 */
  private noteEntryBlocked(entryId: string | null): void {
    if (!entryId || this.blockedPortals.has(entryId)) return;
    const from = { x: this.body.px, y: this.body.footY, z: this.body.pz };
    if (!this.team.hasAlternateEntry(from, entryId, this.blockedPortals)) return;
    this.blockedPortals.set(entryId, PORTAL_BLOCK_SEC);
    this.entryPhase = null;
    this.entryRouteId = null;
    this.nav.reset();
  }

  private updateSweep(dt: number): void {
    const leader = this.leader;
    // §5-6: sweepUnclearedRoom はリーダー不在/ダウン時のみ適用し、フォロワーは隊形を維持する
    if (leader && leader.state !== 'engage' && leader.state !== 'rush' && leader.state !== 'staging') {
      // §5-5: リーダーの体ヨーではなく進行方向の低域通過を基準に後方・自サイドへ追従（ヒステリシス付き）
      const { slot, count } = this.followerSlot(leader);
      const lfx = leader.headX;
      const lfz = leader.headZ;
      const rx = -lfz;
      const rz = lfx;
      const side: -1 | 1 =
        count > 1 ? (slot === 0 ? -1 : 1) : this.formSide !== 0 ? this.formSide : this.cellIndex % 2 === 0 ? -1 : 1;
      const sideOff = count > 1 ? FOLLOW_SIDE_3 : FOLLOW_SIDE;
      const gx = leader.body.px - lfx * FOLLOW_BACK + rx * sideOff * side;
      const gz = leader.body.pz - lfz * FOLLOW_BACK + rz * sideOff * side;
      let goal: Vec3;
      if (!blockedAtFiltered(this.ctx.colliders, gx, gz, 0.3, leader.body.footY)) {
        goal = { x: gx, y: leader.body.footY, z: gz };
      } else {
        const bx = leader.body.px - lfx * FOLLOW_BACK;
        const bz = leader.body.pz - lfz * FOLLOW_BACK;
        goal = !blockedAtFiltered(this.ctx.colliders, bx, bz, 0.3, leader.body.footY)
          ? { x: bx, y: leader.body.footY, z: bz }
          : { x: leader.body.px, y: leader.body.footY, z: leader.body.pz };
      }
      const dist = Math.hypot(leader.body.px - this.body.px, leader.body.pz - this.body.pz);
      const sameFloor = Math.abs(leader.body.footY - this.body.footY) < 0.75;
      const startDist = FOLLOW_START + slot * FOLLOW_START_PER_SLOT;
      const stopDist = FOLLOW_STOP + slot * FOLLOW_STOP_PER_SLOT;
      if (!sameFloor || dist > startDist) this.following = true;
      else if (sameFloor && dist < stopDist) this.following = false;

      if (this.following) {
        const mode = this.switchLookMode('travel', dt);
        const fres = this.nav.step(
          goal,
          this.combat.moveSpeed * Math.min(1, SWEEP_SPEED * (dist > 4 ? 1.35 : 1)),
          dt,
          {
            canOpenDoors: true,
            canUseStairs: true,
            faceTravel: mode === 'travel',
            arriveDist: 0.45,
            restartDist: 0.35,
            smooth: NAV_SMOOTH,
          },
        );
        if (fres === 'arrived') this.following = false;
        else if (fres === 'blocked') this.noteBlocked();
      } else {
        const leaderYaw = Math.atan2(-lfx, -lfz);
        const leaderMoving = leader.moveSpeedEst > HEADING_MIN_SPEED;
        const mode = this.switchLookMode(leaderMoving ? 'watch' : 'scan', dt);
        if (mode === 'watch') {
          const watchYaw = leaderYaw + side * FOLLOW_WATCH_SIDE;
          this.body.faceToward(this.body.px - Math.sin(watchYaw), this.body.pz - Math.cos(watchYaw), 3.0 * dt);
        } else {
          const baseYaw = leaderYaw + Math.PI * (count > 1 ? (side < 0 ? 0.65 : 1.35) : 0.9);
          this.scanAround(dt, baseYaw);
        }
      }
      return;
    }
    if (leader && (leader.state === 'engage' || leader.state === 'rush') && leader.known) {
      // 相方が交戦/突撃中: 支援に向かう
      this.huntTarget = { ...leader.known };
      this.setState('hunt');
      return;
    }
    if (!leader && this.sweepUnclearedRoom(dt)) return;

    // 未クリア（視界に入っていない）マスを塗りつぶすように、最寄りの未視認マスへ次々と向かう
    // §5-4: 歩行中に seen になっても、選択後 GOAL_KEEP_SEC 未満または残距離 GOAL_KEEP_DIST 未満なら維持
    const keepGoal =
      this.goalCell &&
      !this.goalCell.bad &&
      (!this.goalCell.seen ||
        this.goalTime < GOAL_KEEP_SEC ||
        Math.hypot(this.goalCell.x - this.body.px, this.goalCell.z - this.body.pz) < GOAL_KEEP_DIST);
    if (!keepGoal) {
      this.goalCell = this.team.pickCell(this);
      this.goalTime = 0;
      if (!this.goalCell) {
        this.scanAround(dt, this.scanBaseYaw);
        return;
      }
    }
    this.goalTime += dt;
    const cell = this.goalCell!;
    const goal = { x: cell.x, y: cell.y, z: cell.z };
    if (this.goalTime > GOAL_TIMEOUT_SEC) {
      this.team.markBad(cell);
      this.goalCell = null;
      return;
    }
    if (!this.sees && !this.pepperThreat) this.team.tryShootBarricade(this, dt);
    const route = this.team.routeFrom(
      this.body.px,
      this.body.pz,
      this.body.footY,
      goal,
      this.assignedPortal?.id,
      'hold',
      this.blockedPortals,
      this.entryPhase,
      this.entryRouteId,
    );
    if (route.phase !== 'direct') {
      this.followEntry(route, dt, SWEEP_SPEED);
      return;
    }
    if (this.assignedPortal && isIndoorPoint(this.ctx.rooms ?? [], this.body.px, this.body.pz, this.body.footY)) {
      this.assignedPortal = null;
    }
    if (this.entryPhase) {
      this.entryPhase = null;
      this.entryRouteId = null;
      this.nav.reset();
    }
    const blockedRoute = this.checkBlockedRoute(goal, dt);
    if (blockedRoute === true) return;
    if (blockedRoute === 'unreachable') {
      this.team.markBad(cell);
      this.goalCell = null;
      return;
    }
    const res = this.nav.step(goal, this.combat.moveSpeed * SWEEP_SPEED, dt, {
      canOpenDoors: true,
      canUseStairs: true,
      faceTravel: true,
      arriveDist: 0.9,
      smooth: NAV_SMOOTH,
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

  /** 入った部屋に未確認マスが残っているあいだは、そのマスだけを歩き、扉は開けない。 */
  private sweepUnclearedRoom(dt: number): boolean {
    const room = this.team.unclearedIndoorRoom(this);
    if (!room) return false;
    this.huntingFlank = false;
    const keepRoomGoal =
      this.goalCell &&
      this.goalCell.room === room.id &&
      !this.goalCell.bad &&
      (!this.goalCell.seen ||
        this.goalTime < GOAL_KEEP_SEC ||
        Math.hypot(this.goalCell.x - this.body.px, this.goalCell.z - this.body.pz) < GOAL_KEEP_DIST);
    if (!keepRoomGoal) {
      this.goalCell = null;
    }
    if (!this.goalCell) {
      this.goalCell = this.team.nextClearCell(this);
      this.goalTime = 0;
      if (!this.goalCell) {
        if (!this.acquiring) this.scanAround(dt, this.scanBaseYaw);
        return true;
      }
    }
    this.goalTime += dt;
    const cell = this.goalCell;
    if (this.goalTime > GOAL_TIMEOUT_SEC) {
      this.team.markBad(cell);
      this.goalCell = null;
      return true;
    }
    if (!this.sees && !this.pepperThreat) this.team.tryShootBarricade(this, dt);
    const goal = { x: cell.x, y: cell.y, z: cell.z };
    const res = this.nav.step(goal, this.combat.moveSpeed * SWEEP_SPEED, dt, {
      canOpenDoors: false,
      canUseStairs: false,
      faceTravel: !this.acquiring,
      arriveDist: 0.9,
      smooth: NAV_SMOOTH,
    });
    if (res === 'arrived') {
      this.team.markSeenAround(this.body.px, this.body.pz, this.body.footY, COVER_NEAR);
      cell.seen = true;
      this.goalCell = null;
    } else if (res === 'blocked') {
      this.noteBlocked();
      this.team.markBad(cell);
      this.goalCell = null;
    }
    return true;
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
    // §3.3: 静止 SCAN_IDLE_SEC(0.6s) 以上のときのみ ±0.9rad・0.9rad/s で走査する
    if (this.stillTime < SCAN_IDLE_SEC) {
      this.scanPhase = 0;
      this.body.faceToward(this.body.px - Math.sin(baseYaw), this.body.pz - Math.cos(baseYaw), 2.5 * dt);
      return;
    }
    this.scanPhase += dt * SCAN_RATE;
    const yaw = baseYaw + Math.sin(this.scanPhase) * SCAN_AMP;
    this.body.faceToward(this.body.px - Math.sin(yaw), this.body.pz - Math.cos(yaw), 2.5 * dt);
  }

  /** 経路が施錠ドアで塞がれている場合、目標方向の施錠ドアへ向かってブリーチする。 */
  tryBeginBreach(goal: Vec3, preferId?: string): boolean {
    // 同じ部屋の中の点へは扉を蹴らない。入口ドアの指定（preferId）と、別室・屋外からの突入は従来どおり。
    if (!preferId && this.team.sameIndoorRoom(this.body.px, this.body.pz, this.body.footY, goal)) return false;
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
          smooth: NAV_SMOOTH,
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
      if (this.state === 'breach') {
        this.clearBreachState();
        this.setState(this.huntTarget ? 'hunt' : 'sweep');
      }
    } else if (res === 'blocked' || this.stateTime > 20) {
      this.skipDoor(door.id);
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
            smooth: NAV_SMOOTH,
          });
      if (res === 'arrived') {
        this.c2Phase = 'plant';
        this.c2Timer = 0;
        this.body.setPose('crouch');
        this.team.onC2PlantStart(this, door);
      } else if (res === 'blocked' || this.stateTime > 20) {
        this.skipDoor(door.id);
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
        smooth: NAV_SMOOTH,
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
      if (this.state === 'breach') {
        this.clearBreachState();
        this.setState(this.huntTarget ? 'hunt' : 'sweep');
      }
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
