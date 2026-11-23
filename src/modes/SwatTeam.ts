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
const SWEEP_SPEED = 0.8;
const HUNT_SPEED = 1.05;
const FLASH_TEAM_CD = 14;
const FLASH_PER_TEAM = 3;
const FLASH_MIN_DIST = 3.2;
const FLASH_MAX_DIST = 9;
const SELF_NOISE_RADIUS = 3.2;
const ROOM_STAND_SEC = 1.1;
const RADIO_NAME = 'SWAT無線(傍受)';

type HunterState = 'staging' | 'sweep' | 'hunt' | 'breach' | 'engage' | 'down';

interface ShieldBody {
  readonly alive: boolean;
  readonly body: HumanoidBody;
  readonly shieldedBy?: string | null;
}

/** プレイヤーが抱えた人質の正面 ±この角度にいる隊員は発砲しない */
const HOSTAGE_COVER_DEG = 40;

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
}

const CALLSIGNS = ['Red-1', 'Red-2', 'Blue-1', 'Blue-2', 'Gold-1', 'Gold-2'];
const NAMES = ['アルファ', 'ブラボー', 'チャーリー', 'デルタ', 'エコー', 'フォックス'];

/** SWAT 隊員 1 名。部屋の掃討・音/目撃情報の追跡・施錠ドアのブリーチ・交戦を行う。 */
class SwatHunter implements HitTarget {
  readonly body: HumanoidBody;
  readonly nav: SuspectNavigator;
  readonly engage: EngageBehavior;
  hp = HP;
  state: HunterState = 'staging';
  leader: SwatHunter | null = null;
  targetRoom: RoomDef | null = null;
  huntTarget: Vec3 | null = null;
  known: Vec3 | null = null;
  sees = false;
  threat: CombatThreat | null = null;
  spotTimer = 0;
  lostSec = 0;
  stateTime = 0;
  roomStand = 0;
  blindLeft = 0;
  breachDoor: Door | null = null;
  breachApproach: Vec3 | null = null;
  breachWait = 0;
  private readonly skipDoors = new Set<string>();
  private blockedCount = 0;
  private blockedWindow = 0;
  private scanPhase = Math.random() * Math.PI * 2;
  private entryPhase: EntryRoute['phase'] | null = null;

  constructor(
    readonly id: string,
    readonly callsign: string,
    readonly name: string,
    spawn: SwatSpawn,
    private readonly team: SwatTeam,
    private readonly ctx: CombatContext,
    bus: GameEventBus,
    textures?: TextureLibrary,
  ) {
    this.body = new HumanoidBody(spawn.x, spawn.z, 0, 0x2b3440, true, { role: 'ally', footY: spawn.y, textures });
    this.body.ground = ctx.colliders;
    this.body.setReadyPose('high');
    this.nav = new SuspectNavigator(this.body, ctx);
    this.engage = new EngageBehavior(SWAT_COMBAT, id, this.body, bus, ctx, () => true, SWAT_MOBILITY, this.nav);
  }

  get alive(): boolean {
    return this.state !== 'down';
  }

  getAABB() {
    return this.body.getAABB();
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
    if (next === 'sweep') this.targetRoom = null;
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
      case 'sweep':
        this.updateSweep(dt);
        break;
    }
  }

  /** 視覚。交戦中以外は視野角・反応時間あり。民間人が射線上にいる場合は撃たない（位置は把握）。 */
  private sense(dt: number): void {
    this.sees = false;
    this.threat = null;
    const p = this.ctx.player;
    if (p.alive === false) return;
    const engaged = this.state === 'engage';
    const range = engaged ? SWAT_COMBAT.engageRange : this.team.playerCrouching ? VISION_RANGE_CROUCH : VISION_RANGE;
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
    if (this.team.civilianInLine(from, threat.point) || this.team.coveredByHostage(this.body.px, this.body.pz)) return; // 人質が射線上: 発砲しない
    this.sees = true;
    this.threat = threat;
  }

  private updateEngage(dt: number): void {
    if (this.sees) this.lostSec = 0;
    else this.lostSec += dt;
    const k = this.known ?? this.team.lastSighting;
    this.engage.update(dt, k, this.sees, this.threat);
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
    const res = this.nav.step(t, SWAT_COMBAT.moveSpeed * HUNT_SPEED, dt, {
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
    const res = this.nav.step(route.dest, SWAT_COMBAT.moveSpeed * speedScale, dt, {
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
    const leader = this.leader && this.leader.alive ? this.leader : null;
    if (leader && leader.state !== 'engage' && leader.state !== 'staging') {
      // 2 人 1 組: 相方（リーダー）の後方を追従する
      const dist = Math.hypot(leader.body.px - this.body.px, leader.body.pz - this.body.pz);
      const sameFloor = Math.abs(leader.body.footY - this.body.footY) < 0.75;
      if (dist > 1.9 || !sameFloor) {
        const fres = this.nav.step(
          { x: leader.body.px, y: leader.body.footY, z: leader.body.pz },
          SWAT_COMBAT.moveSpeed * Math.min(1, SWEEP_SPEED * (dist > 4 ? 1.35 : 1)),
          dt,
          { canOpenDoors: true, canUseStairs: true, faceTravel: true, arriveDist: 1.7 },
        );
        if (fres === 'blocked') this.noteBlocked();
      } else {
        this.scanAround(dt, leader.body.yawRad + Math.PI * 0.9);
      }
      return;
    }
    if (leader && leader.state === 'engage' && leader.known) {
      // 相方が交戦中: 支援に向かう
      this.huntTarget = { ...leader.known };
      this.setState('hunt');
      return;
    }

    if (!this.targetRoom) {
      this.targetRoom = this.team.pickRoom(this);
      this.roomStand = 0;
      if (!this.targetRoom) {
        this.scanAround(dt, this.body.yawRad);
        return;
      }
    }
    const r = this.targetRoom;
    const fy = r.floorY ?? 0;
    const inRoom =
      Math.abs(this.body.footY - fy) < 0.7 &&
      Math.abs(this.body.px - r.x) < r.width / 2 - 0.3 &&
      Math.abs(this.body.pz - r.z) < r.depth / 2 - 0.3;
    if (inRoom) {
      this.roomStand += dt;
      this.scanAround(dt, this.body.yawRad);
      if (this.roomStand >= ROOM_STAND_SEC) {
        this.team.markCleared(r, this);
        this.targetRoom = null;
      }
      return;
    }
    const goal = this.team.roomPoint(r);
    const route = this.team.routeFrom(this.body.px, this.body.pz, this.body.footY, goal);
    if (route.phase !== 'direct') {
      this.followEntry(route, dt, SWEEP_SPEED);
      return;
    }
    if (this.entryPhase) {
      this.entryPhase = null;
      this.nav.reset();
    }
    const res = this.nav.step(goal, SWAT_COMBAT.moveSpeed * SWEEP_SPEED, dt, {
      canOpenDoors: true,
      canUseStairs: true,
      faceTravel: true,
      arriveDist: 0.9,
    });
    if (res === 'arrived') {
      this.roomStand += dt;
      if (this.roomStand >= ROOM_STAND_SEC) {
        this.team.markCleared(r, this);
        this.targetRoom = null;
      }
    } else if (res === 'blocked') {
      this.noteBlocked();
      if (this.tryBeginBreach(goal)) return;
      this.team.markUnreachable(r);
      this.targetRoom = null;
    } else if (this.stateTime > 40) {
      this.team.markUnreachable(r);
      this.targetRoom = null;
      this.stateTime = 0;
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
      preferred && preferred.locked && !this.skipDoors.has(preferred.id)
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
      : this.nav.step(ap, SWAT_COMBAT.moveSpeed * HUNT_SPEED, dt, {
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
  /** pickRoom 中に hunt へ切り替えたい隊員（sweep 更新中の再入を避けるため次フレームで遷移） */
  private readonly pendingHunt = new Set<SwatHunter>();
  private readonly unreachable = new Set<string>();
  private readonly rooms: RoomDef[];
  private readonly unsubs: (() => void)[] = [];
  private flashCd = 6;
  private droneCd = 0;
  private flashesLeft = FLASH_PER_TEAM;
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

  constructor(private readonly d: SwatTeamDeps) {
    this.root.name = 'swatTeam';
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
        CALLSIGNS[i % CALLSIGNS.length]!,
        NAMES[i % NAMES.length]!,
        spawns[i]!,
        this,
        ctx,
        d.bus,
        d.textures,
      );
      if (i % 2 === 1) h.leader = this.hunters[i - 1] ?? null;
      this.hunters.push(h);
      this.root.add(h.body.group);
      d.weapons.addTarget(h);
    }
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
    for (const x of this.hunters) if (x.leader === h) x.leader = null;
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
    for (const h of this.hunters) h.update(dt);
    for (const h of this.pendingHunt) if (h.alive && h.state === 'sweep' && h.huntTarget) h.setState('hunt');
    this.pendingHunt.clear();
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
    const buddy = this.hunters.find((x) => x.alive && (x.leader === h || h.leader === x));
    const speaker = buddy ?? this.firstAlive();
    if (this.aliveCount === 0) return;
    this.radio(speaker, `${h.callsign} ダウン！ 隊員負傷、警戒しろ！`, `${h.callsign} is down! Officer down!`, true);
    // 相方を失った隊員は独立して行動
    for (const x of this.hunters) if (x.leader === h) x.leader = null;
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
    if (this.flashCd > 0 || this.flashesLeft <= 0 || this.sightingAge > 12) return;
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
    this.flashCd = FLASH_TEAM_CD;
    this.radio(by, 'フラッシュ投下！', 'Flashbang out!', true);
  }

  // ---------- 部屋の掃討 ----------

  pickRoom(h: SwatHunter): RoomDef | null {
    const taken = new Set(this.hunters.filter((x) => x !== h && x.alive && x.targetRoom).map((x) => x.targetRoom!.id));
    let pool = this.rooms.filter((r) => !this.cleared.has(r.id) && !this.unreachable.has(r.id));
    if (pool.length === 0) {
      // 全室掃討済み: 再捜索。ドローンの熱源探知で大まかな位置（±4m）を全隊に共有する
      this.cleared.clear();
      if (this.unreachable.size >= this.rooms.length) this.unreachable.clear();
      pool = this.rooms.filter((r) => !this.unreachable.has(r.id));
      if (this.droneCd > 0) return this.nearestRoom(h, pool);
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
      if (h.huntTarget && (!h.leader || !h.leader.alive)) {
        h.huntTarget = { ...guess };
        this.pendingHunt.add(h);
      }
    }
    return this.nearestRoom(h, pool, taken);
  }

  private nearestRoom(h: SwatHunter, pool: readonly RoomDef[], taken: ReadonlySet<string> = new Set()): RoomDef | null {
    let best: RoomDef | null = null;
    let bestScore = Infinity;
    for (const r of pool) {
      const fy = r.floorY ?? 0;
      let score = Math.hypot(r.x - h.body.px, r.z - h.body.pz) + Math.abs(fy - h.body.footY) * 6;
      if (taken.has(r.id)) score += 25;
      score += Math.random() * 3;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best;
  }

  roomPoint(r: RoomDef): Vec3 {
    const fy = r.floorY ?? 0;
    if (!blockedAtFiltered(this.d.colliders, r.x, r.z, 0.3, fy)) return { x: r.x, y: fy, z: r.z };
    for (const [ox, oz] of [
      [0.25, 0],
      [-0.25, 0],
      [0, 0.25],
      [0, -0.25],
    ] as const) {
      const x = r.x + ox * r.width;
      const z = r.z + oz * r.depth;
      if (!blockedAtFiltered(this.d.colliders, x, z, 0.3, fy)) return { x, y: fy, z };
    }
    return { x: r.x, y: fy, z: r.z };
  }

  markCleared(r: RoomDef, by: SwatHunter): void {
    if (this.cleared.has(r.id)) return;
    this.cleared.add(r.id);
    if (this.radioCd <= 0 && Math.random() < 0.45) this.radio(by, `${r.name}、クリア。`, 'Room clear.');
  }

  markUnreachable(r: RoomDef): void {
    this.unreachable.add(r.id);
  }

  markRoomAt(x: number, z: number, y: number): void {
    const r = this.roomAt(x, z, y);
    if (r) this.cleared.add(r.id);
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
      if (!door.locked || skip.has(door.id)) continue;
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
