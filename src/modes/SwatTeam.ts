import * as THREE from 'three';
import type { GameEventBus, NoiseKind, NoiseSource } from '../core/events';
import type { CombatParams, MobilityParams, RoomDef, Vec3 } from '../core/types';
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
import { shieldBlocks } from '../ai/ShieldGuard';
import { blockedAtFiltered } from '../ai/SquadRoute';
import type { PlayerCombatReceiver } from '../ai/EntityManager';
import { hasLineOfSight, type Flashbang } from '../weapons/Flashbang';
import type { HitTarget, WeaponSystem } from '../weapons/WeaponSystem';
import type { Door, DoorSystem } from '../world/Door';
import type { TextureLibrary } from '../world/Materials';
import type { StairMark } from '../world/Walk';
import type { Collider } from '../world/WorldBuilder';
import type { Subtitle } from '../ui/Subtitle';

/**
 * 容疑者モード専用の SWAT 戦闘パラメータ（EngageBehavior をこのモードだけで使う）。
 * 通常モードの容疑者プロファイルは変えない。開けた場所では危険だが、遮蔽と短いピークの隙で撃ち返せる強さ。
 */
const SWAT_COMBAT: CombatParams = {
  decisionSec: 0.95,
  alertCalmSec: 10,
  hesitateFireSec: 3,
  hesitateRetreatSpeed: 0.8,
  hesitateRetreatMax: 1.5,
  hesitateShakeDeg: 0,
  moveSpeed: 2.15,
  fireInterval: 0.28,
  shotsPerPeek: 3,
  magazineSize: 30,
  reloadSec: 2.2,
  coverSecMin: 0.9,
  coverSecMax: 1.8,
  peekSecMax: 1.4,
  engageRange: 18,
  coverSearchRange: 6,
  coverMargin: 0.45,
  crouchCoverMaxHeight: 1.5,
  flinchSec: 0.35,
  gunshotNoiseRadius: 40,
  shotDamage: 12,
  baseSpreadDeg: 5.2,
};

const SWAT_MOBILITY: MobilityParams = {
  canOpenDoors: true,
  canUseStairs: true,
  patrolChance: 0,
  patrolIntervalMin: 99,
  patrolIntervalMax: 99,
  patrolSpeedScale: 0.6,
  investigateChance: 1,
  investigateMaxDist: 40,
  investigateSpeedScale: 0.9,
  reinforceOnGunshot: true,
  repositionAfterLostSec: 1.6,
  flankChance: 0.5,
  guardHostageRoom: false,
};

/**
 * 盾持ち隊員（ポイントマン）: 防弾盾を構えてハンドガンで撃ちながら前進する。遮蔽には籠らず、見失えば即座に詰める。
 * 盾は脛より上の正面を完全に防ぐので、足元を撃つか側面・背後へ回り込むしか倒せない。圧力で SwatTeam が一部を書き換える。
 */
const SHIELD_COMBAT: CombatParams = {
  ...SWAT_COMBAT,
  moveSpeed: 1.75,
  fireInterval: 0.42,
  shotsPerPeek: 4,
  magazineSize: 15,
  reloadSec: 1.8,
  coverSecMin: 0.25,
  coverSecMax: 0.5,
  peekSecMax: 2.4,
  coverSearchRange: 0,
  shotDamage: 9,
  baseSpreadDeg: 3.8,
};
const SHIELD_MOBILITY: MobilityParams = {
  ...SWAT_MOBILITY,
  repositionAfterLostSec: 0.5,
  flankChance: 0,
};
const BASE_SHIELD_COMBAT: Readonly<CombatParams> = { ...SHIELD_COMBAT };

/**
 * 圧力（時間経過で SWAT が積極的になる）。SWAT_COMBAT / SWAT_MOBILITY は SwatTeam が毎秒書き換える（生成時に基準値へ戻す）。
 * 隠れて撃つだけの籠城を許さず、時間が経つほど遮蔽に籠る時間が短く・射撃が正確に・回り込みが速くなる。
 */
const BASE_COMBAT: Readonly<CombatParams> = { ...SWAT_COMBAT };
const BASE_MOBILITY: Readonly<MobilityParams> = { ...SWAT_MOBILITY };
/** 突入開始から圧力が最大になるまでの秒数 */
const PRESSURE_RAMP_SEC = 150;
/** 隊員が倒されるたびに残りが本気になる加算量 */
const PRESSURE_PER_DOWN = 0.1;
/** 閃光弾の補充間隔(s)。圧力が高いほどクールダウンも短い */
const FLASH_REFILL_SEC = 45;
const FLASH_CARRY_MAX = 4;
/** 姿を見失った直後、最後に見えた位置への制圧射撃（リーン撃ち・顔出し対策） */
const SUPPRESS_MIN_LOST = 0.35;
const SUPPRESS_MAX_LOST = 3.5;
const SUPPRESS_INTERVAL = 0.5;
/** ドローン熱源探知: 隠れ続ける相手の大まかな位置を共有する間隔(s)と誤差半径(m)。圧力 0.3 以上で作動 */
const INTEL_INTERVAL_MIN = 16;
const INTEL_INTERVAL_MAX = 38;
const INTEL_ERROR_MAX = 7;
const INTEL_ERROR_MIN = 2.5;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const DEG2RAD = Math.PI / 180;
/** ボディアーマー込み。改造拳銃（19 ダメージ）で約 6 発 */
const HP = 100;
const VISION_FOV_DEG = 86;
const VISION_RANGE = 16;
const VISION_RANGE_CROUCH = 11;
const REACTION_SEC = 0.7;
const HEARING_MUL = 1.0;
const OCCLUDED_MUL = 0.5;
const ENGAGE_LOST_SEC = 5;
const SWEEP_SPEED = 1.0;
const HUNT_SPEED = 1.05;
const FLASH_TEAM_CD = 14;
const FLASH_PER_TEAM = 3;
const FLASH_MIN_DIST = 3.2;
const FLASH_MAX_DIST = 9;
const SELF_NOISE_RADIUS = 3.2;
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

type HunterState = 'staging' | 'sweep' | 'hunt' | 'breach' | 'engage' | 'disarm' | 'down';

/** ペッパーボール（人質・民間人が射線上にいて実弾を撃てないとき） */
const PEPPER_INTERVAL = 0.42;
const PEPPER_RANGE = 20;
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
  player: PlayerCombatReceiver & { isCrouching: boolean; readonly yawRad: number };
  colliders: readonly Collider[];
  bus: GameEventBus;
  weapons: WeaponSystem;
  doors: DoorSystem;
  bounds: { width: number; depth: number };
  stairs: readonly StairMark[];
  rooms: readonly RoomDef[];
  flashbang: Flashbang;
  subtitle: Subtitle;
  civilians: () => Iterable<ShieldBody>;
  textures?: TextureLibrary;
  /** 味方容疑者 NPC。未指定ならプレイヤーだけを狙う */
  suspects?: () => readonly AllyTarget[];
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

/** SWAT 隊員 1 名。部屋の掃討・音/目撃情報の追跡・施錠ドアのブリーチ・交戦を行う。 */
class SwatHunter implements HitTarget {
  readonly body: HumanoidBody;
  readonly nav: SuspectNavigator;
  readonly engage: EngageBehavior;
  hp = HP;
  state: HunterState = 'staging';
  /** 所属する組（先頭ほど序列が上。生存者の先頭がその組のリーダー） */
  cell: SwatHunter[] = [this];
  callsign: string;
  /** 掃討中に向かっている未クリアのマス */
  goalCell: CoverCell | null = null;
  goalTime = 0;
  goalRoom = '';
  huntTarget: Vec3 | null = null;
  known: Vec3 | null = null;
  sees = false;
  threat: CombatThreat | null = null;
  spotTimer = 0;
  lostSec = 0;
  stateTime = 0;
  blindLeft = 0;
  breachDoor: Door | null = null;
  breachApproach: Vec3 | null = null;
  breachWait = 0;
  /** 民間人が射線上で実弾を撃てない脅威（ペッパーボールで撃つ） */
  pepperThreat: Vec3 | null = null;
  pepperCd = Math.random() * PEPPER_INTERVAL;
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
    this.combat = shielded ? SHIELD_COMBAT : SWAT_COMBAT;
    this.body = new HumanoidBody(spawn.x, spawn.z, 0, 0x2b3440, true, { role: 'ally', footY: spawn.y, textures, shield: shielded });
    this.body.ground = ctx.colliders;
    this.body.setReadyPose('high');
    this.nav = new SuspectNavigator(this.body, ctx);
    this.engage = new EngageBehavior(this.combat, id, this.body, bus, ctx, () => true, shielded ? SHIELD_MOBILITY : SWAT_MOBILITY, this.nav);
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

  setState(next: HunterState): void {
    if (this.state === 'down') return; // 倒れた隊員は二度と行動しない
    if (this.state === next) return;
    if (this.state === 'engage') this.engage.exit();
    this.state = next;
    this.stateTime = 0;
    if (!this.nav.onStair) this.nav.reset(); // 階段の途中では昇降状態を保持する
    if (next === 'engage') {
      this.body.setPose('stand');
      this.engage.enter(this.known);
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
      this.state = 'down';
      this.body.setFlash(false);
      this.body.setShake(0);
      this.body.setPose('down');
      return true;
    }
    this.known = { x: from.x, y: resolveFloorY(from, this.ctx.rooms, 'gunshot'), z: from.z };
    this.body.faceToward(from.x, from.z);
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
    if (this.state !== 'engage' && this.state !== 'disarm') this.team.checkTraps(this);
    switch (this.state) {
      case 'engage':
        this.updateEngage(dt);
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
  }

  /** 視覚。交戦中以外は視野角・反応時間あり。民間人が射線上にいる場合は撃たない（位置は把握）。 */
  private sense(dt: number): void {
    this.sees = false;
    this.threat = null;
    this.pepperThreat = null;
    const p = this.ctx.player;
    if (p.alive === false) return;
    const engaged = this.state === 'engage';
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
      if (this.spotTimer < REACTION_SEC) return;
      this.spotTimer = 0;
      this.known = { x: threat.x, y: p.position.y, z: threat.z };
      this.team.onContact(this, this.known);
      this.setState('engage');
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
      this.pepperCd = PEPPER_INTERVAL * (0.8 + Math.random() * 0.5);
      this.lostSec = 0;
      this.body.faceToward(this.pepperThreat.x, this.pepperThreat.z);
      this.team.firePepper(this, this.pepperThreat);
    }
    // 見失った直後: 最後に見えた位置へ閃光を投げ込み、制圧射撃で顔出しを潰す（遮蔽とリーンで安全に撃ち返させない）
    this.suppressCd = Math.max(0, this.suppressCd - dt);
    if (!this.sees && k && this.lostSec >= SUPPRESS_MIN_LOST && this.lostSec <= SUPPRESS_MAX_LOST) {
      if (this.lostSec >= 0.8) this.team.tryFlash(this, k);
      if (this.suppressCd <= 0) {
        this.suppressCd = SUPPRESS_INTERVAL * (0.8 + Math.random() * 0.5);
        this.team.suppress(this, k);
      }
    }
    if (!this.sees && this.lostSec >= ENGAGE_LOST_SEC) {
      this.huntTarget = k ? { ...k } : null;
      this.setState(this.huntTarget ? 'hunt' : 'sweep');
    }
  }

  private updateHunt(dt: number): void {
    const t = this.huntTarget;
    if (!t) {
      this.setState('sweep');
      return;
    }
    const route = this.team.routeFrom(this.body.px, this.body.pz, this.body.footY, t);
    if (route.phase !== 'direct') {
      // 屋外から足音へ直進せず、入口ドアを経由してから追う
      this.followEntry(route, dt, HUNT_SPEED);
      if (this.stateTime > 45) {
        this.huntTarget = null;
        this.setState('sweep');
      }
      return;
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
    if (leader && leader.state !== 'engage' && leader.state !== 'staging') {
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
    if (leader && leader.state === 'engage' && leader.known) {
      // 相方が交戦中: 支援に向かう
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
    const route = this.team.routeFrom(this.body.px, this.body.pz, this.body.footY, goal);
    if (route.phase !== 'direct') {
      this.followEntry(route, dt, SWEEP_SPEED);
      return;
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
  private tryBeginBreach(goal: Vec3, preferId?: string): boolean {
    const preferred = preferId ? this.team.doorById(preferId) : null;
    const door =
      preferred && preferred.locked && !this.skipDoors.has(preferred.id) && !this.team.trapHeld(preferred)
        ? preferred
        : this.team.findLockedDoor(this, goal, this.skipDoors);
    if (!door) return false;
    const side = (this.body.px - door.centerX) * door.normalX + (this.body.pz - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
    this.breachDoor = door;
    this.breachWait = 0;
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
    if (!door || !ap || !door.locked) {
      this.breachDoor = null;
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
      this.breachDoor = null;
      this.setState(this.huntTarget ? 'hunt' : 'sweep');
    } else if (res === 'blocked' || this.stateTime > 20) {
      this.skipDoors.add(door.id);
      this.breachDoor = null;
      this.setState('sweep');
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
    this.body.dispose();
  }
}

export interface EntrySample {
  id: string;
  centerX: number;
  centerZ: number;
  normalX: number;
  normalZ: number;
  sillY: number;
}

export interface EntryPortal {
  id: string;
  outside: Vec3;
  inside: Vec3;
  sillY: number;
}

export interface EntryRoute {
  dest: Vec3;
  entryId: string | null;
  /** direct = 目標そのもの。approach = 屋外側の入口。cross = ドアを抜けた屋内側 */
  phase: 'direct' | 'approach' | 'cross';
}

/** 屋内の部屋（outdoor 以外）にいるか。重なる場合は小さい部屋を優先する。 */
export function isIndoorPoint(rooms: readonly RoomDef[], x: number, z: number, y: number): boolean {
  let best: RoomDef | null = null;
  let bestArea = Infinity;
  for (const r of rooms) {
    if (r.outdoor) continue;
    if (Math.abs((r.floorY ?? 0) - y) > 0.75) continue;
    if (Math.abs(x - r.x) > r.width / 2 || Math.abs(z - r.z) > r.depth / 2) continue;
    const area = r.width * r.depth;
    if (area < bestArea) {
      bestArea = area;
      best = r;
    }
  }
  return best !== null;
}

const ENTRY_OFFSETS = [0.8, 1.25];

/** 片側だけ屋内のドア（外壁の入口）。室内ドアは除外する。 */
export function listExteriorEntries(rooms: readonly RoomDef[], doors: readonly EntrySample[]): EntryPortal[] {
  const out: EntryPortal[] = [];
  for (const door of doors) {
    for (const dist of ENTRY_OFFSETS) {
      const ax = door.centerX + door.normalX * dist;
      const az = door.centerZ + door.normalZ * dist;
      const bx = door.centerX - door.normalX * dist;
      const bz = door.centerZ - door.normalZ * dist;
      const aIn = isIndoorPoint(rooms, ax, az, door.sillY);
      const bIn = isIndoorPoint(rooms, bx, bz, door.sillY);
      if (aIn === bIn) continue;
      const inside = aIn ? { x: ax, y: door.sillY, z: az } : { x: bx, y: door.sillY, z: bz };
      const outside = aIn ? { x: bx, y: door.sillY, z: bz } : { x: ax, y: door.sillY, z: az };
      out.push({ id: door.id, outside, inside, sillY: door.sillY });
      break;
    }
  }
  return out;
}

function pickEntryPortal(entries: readonly EntryPortal[], from: Vec3, goal: Vec3): EntryPortal | null {
  const same = entries.filter((e) => Math.abs(e.sillY - from.y) < 1.1);
  const pool = same.length > 0 ? same : entries;
  let best: EntryPortal | null = null;
  let bestScore = Infinity;
  for (const e of pool) {
    const score =
      Math.hypot(e.outside.x - from.x, e.outside.z - from.z) +
      Math.hypot(e.inside.x - goal.x, e.inside.z - goal.z) +
      Math.abs(e.sillY - goal.y) * 4;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

/**
 * 屋外にいる隊員が屋内の音・部屋へ向かうとき、外壁ドアの進入点を返す。
 * 直線距離で壁の向こうに「着いた」ことにしない。屋内に入ってから本来の目標へ進む。
 */
export function entryRouteDest(
  rooms: readonly RoomDef[],
  entries: readonly EntryPortal[],
  from: Vec3,
  goal: Vec3,
): EntryRoute {
  if (isIndoorPoint(rooms, from.x, from.z, from.y) || !isIndoorPoint(rooms, goal.x, goal.z, goal.y)) {
    return { dest: goal, entryId: null, phase: 'direct' };
  }
  const portal = pickEntryPortal(entries, from, goal);
  if (!portal) return { dest: goal, entryId: null, phase: 'direct' };
  const dist = Math.hypot(portal.outside.x - from.x, portal.outside.z - from.z);
  if (dist > 1.15) return { dest: portal.outside, entryId: portal.id, phase: 'approach' };
  return { dest: portal.inside, entryId: portal.id, phase: 'cross' };
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
  private flashesLeft = FLASH_PER_TEAM;
  private flashRefill = 0;
  private shieldHintShown = false;
  /** 突入開始からの秒数と圧力(0〜1)。倒された隊員の数でも上がる */
  private assaultSec = 0;
  private downBonus = 0;
  private pressure = 0;
  private pressureTick = 0;
  private pressureStep = 0;
  private intelCd = 0;
  private contactCd = 0;
  private radioCd = 0;
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

  constructor(private readonly d: SwatTeamDeps) {
    this.root.name = 'swatTeam';
    Object.assign(SWAT_COMBAT, BASE_COMBAT);
    Object.assign(SWAT_MOBILITY, BASE_MOBILITY);
    Object.assign(SHIELD_COMBAT, BASE_SHIELD_COMBAT);
    this.rooms = d.rooms.filter((r) => !r.outdoor);
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
    const spawns = this.resolveSpawns(d.spawns, d.count);
    for (let i = 0; i < spawns.length; i++) {
      const h = new SwatHunter(
        `swat_${i + 1}`,
        `Red-${i + 1}`,
        NAMES[i % NAMES.length]!,
        spawns[i]!,
        this,
        ctx,
        d.bus,
        d.textures,
        i === 0 && spawns.length >= 2,
      );
      this.hunters.push(h);
      this.root.add(h.body.group);
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
          this.shareSighting(from);
          this.alertTeam(from, true);
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
          d.subtitle.show('防弾盾に弾かれた！ 足元を撃つか、側面・背後へ回り込め', 2.6);
          return;
        }
      }),
      d.bus.on('noise', (e) => this.onNoise(e.pos, e.radius, e.kind, e.source)),
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
    cellSizes(this.hunters.length).forEach((size, c) => {
      const members = this.hunters.slice(i, i + size);
      const name = CELL_NAMES[c % CELL_NAMES.length]!;
      members.forEach((m, k) => {
        m.cell = members;
        m.callsign = `${name}-${k + 1}`;
      });
      i += size;
    });
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

  /** 交渉で突入班を 1 名下げる（最後尾の隊員を撤収）。成功で true */
  withdraw(): boolean {
    if (this.started || this.hunters.length <= 1) return false;
    const h = this.hunters.pop()!;
    this.assignCells(); // 人数が変わったので組み直す（4 → 3 なら 2+2 → 3 人組 1 つ）
    this.d.weapons.removeTarget(h);
    this.root.remove(h.body.group);
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
  routeFrom(x: number, z: number, y: number, goal: Vec3): EntryRoute {
    return entryRouteDest(this.d.rooms, this.portals(), { x, y, z }, goal);
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

  /** 突入開始 */
  beginAssault(): void {
    if (this.started) return;
    this.started = true;
    for (const h of this.hunters) if (h.alive) h.setState('sweep');
    this.radio(this.hunters[0], '全隊、突入開始。容疑者は武装している、注意しろ。', 'All teams, go go go. Suspect is armed.');
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, 0.05);
    this.flashCd = Math.max(0, this.flashCd - dt);
    this.droneCd = Math.max(0, this.droneCd - dt);
    this.contactCd = Math.max(0, this.contactCd - dt);
    this.radioCd = Math.max(0, this.radioCd - dt);
    this.sightingAge += dt;
    if (this.started) this.updatePressure(dt);
    for (const h of this.hunters) h.update(dt);
    this.coverCd -= dt;
    if (this.started && this.coverCd <= 0) {
      this.coverCd = COVER_TICK;
      for (const h of this.hunters) if (h.alive && h.state !== 'staging' && h.blindLeft <= 0) this.scanCoverage(h);
    }
    this.separate(dt);
    this.watchTraps();
    for (const h of this.pendingHunt) if (h.alive && h.state === 'sweep' && h.huntTarget) h.setState('hunt');
    this.pendingHunt.clear();
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
    this.alertTeam(pos, true);
  }

  /** 位置情報を共有し、交戦中でない隊員を向かわせる。visual=false の場合は近い隊員のみ。 */
  private alertTeam(pos: Vec3, visual: boolean, maxDist = 30): void {
    for (const h of this.hunters) {
      if (!h.alive || h.state === 'engage' || h.state === 'staging' || h.state === 'breach') continue;
      const d = Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) + Math.abs(h.body.footY - pos.y) * 3;
      if (!visual && d > maxDist) continue;
      if (h.leader && h.leader.alive && !visual) continue; // 音の調査は組のリーダーが判断
      h.huntTarget = { x: pos.x, y: pos.y, z: pos.z };
      h.setState('hunt');
    }
  }

  private onNoise(pos: Vec3, radius: number, kind: NoiseKind, source?: NoiseSource): void {
    if (!this.started || source === 'suspect' || kind === 'flash') return;
    // 隊員自身のドア操作・ブリーチ音は無視する
    for (const h of this.hunters) {
      if (h.alive && Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) < SELF_NOISE_RADIUS && kind !== 'gunshot') return;
    }
    let heard = false;
    for (const h of this.hunters) {
      if (!h.alive || h.state === 'engage' || h.state === 'staging') continue;
      const c = h.body.chestPos();
      const dist = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
      let r = radius * HEARING_MUL;
      if (dist > r) continue;
      if (kind !== 'gunshot' && kind !== 'breach' && !hasLineOfSight(this.d.colliders, { x: pos.x, y: pos.y + 1, z: pos.z }, c)) {
        r *= OCCLUDED_MUL;
        if (dist > r) continue;
      }
      heard = true;
      const target = { x: pos.x, y: resolveFloorY(pos, this.d.rooms, kind), z: pos.z };
      if (h.leader && h.leader.alive) continue;
      if (h.state === 'breach') continue;
      h.huntTarget = target;
      h.setState('hunt');
    }
    if (heard && this.radioCd <= 0) {
      const lines: Record<string, [string, string]> = {
        gunshot: ['発砲音！音の方向へ前進する。', 'Shots fired, moving to the sound.'],
        footstep: ['足音を確認、調べる。', 'Footsteps, checking it out.'],
        door: ['ドアの音がした。確認に向かう。', 'Heard a door, moving to check.'],
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

  /** 追跡中、潜伏推定位置が近く直接視認できていなければ閃光弾を投げ込む。 */
  tryFlash(by: SwatHunter, target: Vec3): void {
    if (this.flashCd > 0 || this.flashesLeft <= 0 || this.sightingAge > 12 || this.hostageShieldUp()) return; // 人質が巻き込まれるので投げない
    const d = Math.hypot(target.x - by.body.px, target.z - by.body.pz);
    if (d < FLASH_MIN_DIST || d > FLASH_MAX_DIST || Math.abs(target.y - by.body.footY) > 0.75) return;
    const from = by.body.chestPos();
    const aim = { x: target.x, y: target.y + 0.4, z: target.z };
    if (!hasLineOfSight(this.d.colliders, from, aim)) return;
    this.throwFlash(by, target, 1.6);
  }

  private throwFlash(by: SwatHunter, target: Vec3, fuse: number): void {
    const from = by.body.chestPos();
    const origin = { x: from.x, y: from.y + 0.25, z: from.z };
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const dy = target.y + 0.3 - origin.y;
    const horiz = Math.hypot(dx, dz);
    const t = Math.max(0.35, Math.min(0.9, horiz / 9));
    const g = this.d.flashbang.gravity;
    this.d.flashbang.throwFrom(origin, { x: dx / t, y: (dy + 0.5 * g * t * t) / t, z: dz / t }, by.id, fuse);
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
      if (this.flashesLeft < FLASH_CARRY_MAX) this.flashesLeft++;
    }
    this.updateIntel(dt);
  }

  private applyPressure(): void {
    const t = Math.min(1, this.assaultSec / PRESSURE_RAMP_SEC + this.downBonus);
    this.pressure = t;
    const c = SWAT_COMBAT;
    const b = BASE_COMBAT;
    c.coverSecMin = lerp(b.coverSecMin, 0.35, t);
    c.coverSecMax = lerp(b.coverSecMax, 0.8, t);
    c.fireInterval = lerp(b.fireInterval, 0.2, t);
    c.baseSpreadDeg = lerp(b.baseSpreadDeg, 3.6, t);
    c.shotsPerPeek = Math.round(lerp(b.shotsPerPeek, 5, t));
    c.peekSecMax = lerp(b.peekSecMax, 2.1, t);
    c.moveSpeed = lerp(b.moveSpeed, 2.55, t);
    c.decisionSec = lerp(b.decisionSec, 0.5, t);
    const sc = SHIELD_COMBAT;
    const sb = BASE_SHIELD_COMBAT;
    sc.fireInterval = lerp(sb.fireInterval, 0.3, t);
    sc.baseSpreadDeg = lerp(sb.baseSpreadDeg, 2.8, t);
    sc.moveSpeed = lerp(sb.moveSpeed, 2.1, t);
    sc.decisionSec = c.decisionSec;
    const m = SWAT_MOBILITY;
    const bm = BASE_MOBILITY;
    m.repositionAfterLostSec = lerp(bm.repositionAfterLostSec, 0.6, t);
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
    if (this.hunters.some((h) => h.alive && h.state === 'engage')) return;
    this.intelCd = lerp(INTEL_INTERVAL_MAX, INTEL_INTERVAL_MIN, this.pressure);
    const p = this.d.player.position;
    const a = Math.random() * Math.PI * 2;
    const err = lerp(INTEL_ERROR_MAX, INTEL_ERROR_MIN, this.pressure) * Math.sqrt(Math.random());
    const guess = { x: p.x + Math.cos(a) * err, y: p.y, z: p.z + Math.sin(a) * err };
    let sent = false;
    for (const h of this.hunters) {
      if (!h.alive || h.state === 'breach' || h.state === 'disarm' || h.state === 'staging') continue;
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
        if (!x.alive || x.state === 'engage' || x.state === 'breach' || (x.leader && x.leader.alive)) continue;
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

  findLockedDoor(h: SwatHunter, goal: Vec3, skip: ReadonlySet<string>): Door | null {
    let best: Door | null = null;
    let bestScore = Infinity;
    for (const door of this.d.doors.doors) {
      if (!door.locked || skip.has(door.id) || this.trapHeld(door)) continue;
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
    if (dist > PEPPER_RANGE) return;
    this.pepperShots++;
    this.d.bus.emit('noise', { pos: from, radius: 14, kind: 'gunshot', source: 'ally' });
    if (this.radioCd <= 0 && Math.random() < 0.3) this.radio(by, '人質がいる、実弾は撃つな！ ペッパーで制圧する！', 'Hostage in line, pepperball only!');
    const hitChance = Math.max(0.2, 0.75 - dist * 0.025);
    if (Math.random() >= hitChance) return;
    const holding = [...this.d.civilians()].some((c) => c.alive && c.shieldedBy === 'player');
    this.d.onPepper?.(holding && Math.random() < 0.22 ? 'hostage' : 'player');
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

  private radio(h: SwatHunter | undefined, text: string, voice: string, force = false): void {
    if (!h || (!force && this.radioCd > 0)) return;
    this.radioCd = 3.5;
    this.d.bus.emit('allyRadio', { allyId: h.id, name: `${RADIO_NAME} ${h.callsign}`, text, voiceText: voice });
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
    for (const h of this.hunters) {
      this.d.weapons.removeTarget(h);
      h.dispose();
    }
    this.hunters.length = 0;
    disposeObject(this.root);
  }
}
