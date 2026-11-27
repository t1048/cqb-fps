import type { GameEventBus, NoiseKind, NoiseSource } from '../core/events';
import { SuspectState, type NegotiationResult } from '../core/events';
import type { AIProfile, CombatParams, EntityDef, MobilityParams, RoomDef, Vec3 } from '../core/types';
import type { HitTarget } from '../weapons/WeaponSystem';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { AABB } from '../world/WorldBuilder';
import {
  EngageBehavior,
  SuspectNavigator,
  findAlertCover,
  findNearestVisibleThreat,
  resolveFloorY,
  stepToward,
  type CombatContext,
  type CombatThreat,
  type XZ,
} from './EngageBehavior';
import { blockedAtFiltered } from './SquadRoute';
import {
  AMBUSH_TRIGGER_KINDS,
  ambushProbability,
  doorwaysOfRoom,
  findAmbushSpot,
  pointInRoom,
  roomRectOf,
  type AmbushSpot,
  type Doorway,
} from './Ambush';
import { HostageShieldBehavior, hasEscapeRoute } from './HostageShield';
import { HumanoidBody } from './HumanoidBody';
import type { TextureLibrary } from '../world/Materials';
import { Morale } from './Morale';
import { StateMachine } from './StateMachine';

const SUSPECT_COLOR = 0x937969;
const ARRESTED_COLOR = 0x3060b0;
/** 解放された味方の復帰時士気: 降伏しきい値 + この値（ほぼ折れる寸前で戦線に戻る） */
const FREED_MORALE_MARGIN = 6;
const DEFAULT_HP = 100;
const MAX_DT = 0.05;

const GAS_BUILD_PER_SEC = 55;
const GAS_DECAY_PER_SEC = 18;
const GAS_MAX_SPREAD_PENALTY = 7.5;
const GAS_MAX_SLOWDOWN = 0.42;
const GAS_COUGH_THRESHOLD = 0.3;
const GAS_COUGH_NOISE_RADIUS = 16;
const GAS_MORALE_DRAIN_PER_SEC = 14;
const GAS_FLUSH_THRESHOLD = 0.2;

/** 容疑者位置における CS 催涙ガスサンプル */
export interface GasSample {
  /** 現在位置のガス濃度 (0..1) */
  density: number;
  /** ガス雲中心または高濃度方向の推定座標（あぶり出し退避用、不明時は null） */
  origin: Vec3 | null;
}

/**
 * 容疑者。ステート名は MVP_SPEC §3 の enum、遷移基盤は汎用 StateMachine、士気は Morale。
 * 知覚(T3-2)で BARRICADED→ALERT→CONFRONTATION、士気(T3-3)で以下に遷移する（閾値は profile.thresholds）:
 *  - 士気 < surrenderBelow → SURRENDER（警告/フラッシュ/ブリーチ/孤立いずれの低下でも）
 *  - CONFRONTATION で profile.combat.decisionSec 後に士気を再計算: < hesitateBelow → HESITATE、それ以外 → ENGAGE
 *  - BARRICADED/ALERT/ENGAGE で士気が低下し < hesitateBelow → HESITATE（放置 hesitateFireSec で ENGAGE）
 *  - 被弾（発砲を受けた）→ ENGAGE（士気 < surrenderBelow なら SURRENDER）。警告を受けた BARRICADED/ALERT → CONFRONTATION
 *  - ALERT は alertCalmSec 何も無ければ BARRICADED へ復帰
 * ENGAGE の遮蔽退避/ピーク撃ち/リロードは EngageBehavior。
 */
export class Suspect implements HitTarget {
  readonly id: string;
  readonly body: HumanoidBody;
  readonly morale: Morale;
  private readonly fsm: StateMachine<SuspectState>;
  private readonly engage: EngageBehavior | null;
  private readonly combat: CombatParams | null;
  private readonly mobility: MobilityParams | null;
  private readonly nav: SuspectNavigator | null;
  private readonly shield: HostageShieldBehavior | null;
  private shieldCheckT = 0;
  private shieldCd = 0;
  hp: number;
  evidenceCollected = false;
  /** 警告コールを受けたか（RoE: 警告前発砲の判定用） */
  warned = false;
  /** 最後に把握したプレイヤー位置（視認/警告/被弾/音で更新） */
  private known: Vec3 | null = null;
  private sees = false;
  private visibleThreat: CombatThreat | null = null;
  private alertTimer = 0;
  private heardAt: Vec3 | null = null;
  private alertCover: XZ | null = null;
  private alertMoveTarget: Vec3 | null = null;
  private alertMoveMode: 'investigate' | 'reinforce' | null = null;
  private alertMoveElapsed = 0;
  private patrolTimer = 0;
  private patrolTarget: Vec3 | null = null;
  private patrolElapsed = 0;
  private prevMorale: number;
  private hesitateRetreated = 0;
  private unwatchedSurrenderSec = 0;
  private fakeSurrenderChecked = false;
  /** 交渉開始前のステート（中断時の復帰先） */
  private negoPrev: SuspectState | null = null;
  /** 決裂後に再交渉できない残り秒 */
  private negoLock = 0;
  /** フラッシュバンで視界を失っている残り秒。この間は視認も発砲もしない。 */
  private blindLeft = 0;
  private warningLeft = 0;
  /** ガス補正前の基準移動速度・基準拡散角（upgradeWeapon でも基準拡散角を更新） */
  private readonly baseMoveSpeed: number;
  private baseSpreadDeg: number;
  /** CS 催涙ガス露出度 (0..100、完全非致死) */
  private gasLevel = 0;
  private gasCoughCd = 0;
  private gasFlushTarget: Vec3 | null = null;
  private gasFlushElapsed = 0;
  /** 待ち伏せ（ファタルファネル）: 目標位置 / 到着済みか / 経過秒 / 再抽選までのクールダウン */
  private ambushSpot: AmbushSpot | null = null;
  private ambushReady = false;
  private ambushElapsed = 0;
  private ambushRollCd = 0;

  constructor(
    def: EntityDef,
    readonly profile: AIProfile,
    private readonly bus: GameEventBus,
    private readonly ctx: CombatContext | null = null,
    textures?: TextureLibrary,
    private readonly warningCooldown = 2,
    /** 容疑者モードの味方。プレイヤーを撃たず、SWAT と戦う */
    readonly friendly = false,
  ) {
    this.id = def.id;
    this.morale = new Morale(profile);
    this.prevMorale = this.morale.value;
    this.hp = def.hp ?? DEFAULT_HP;
    this.body = new HumanoidBody(def.x, def.z, def.yaw ?? 0, SUSPECT_COLOR, true, {
      role: 'suspect',
      footY: def.y ?? 0,
      textures,
    });
    this.combat = profile.combat ? { ...profile.combat } : null; // 個体ごとの写し（籠城準備の武器改造・CSガス補正で書き換える）
    this.baseMoveSpeed = this.combat?.moveSpeed ?? 0;
    this.baseSpreadDeg = this.combat?.baseSpreadDeg ?? 0;
    this.mobility = profile.mobility ?? null;
    this.nav = ctx ? new SuspectNavigator(this.body, ctx) : null;
    if (this.mobility) {
      this.patrolTimer = this.nextPatrolInterval();
    }
    this.engage =
      this.combat && ctx
        ? new EngageBehavior(this.combat, this.id, this.body, bus, ctx, () => this.warned, this.mobility, this.nav)
        : null;
    this.shield =
      profile.shield && this.combat && ctx?.civilians
        ? new HostageShieldBehavior(profile.shield, this.id, this.body, bus, ctx)
        : null;
    this.fsm = new StateMachine<SuspectState>(
      {
        [SuspectState.BARRICADED]: {
          enter: () => {
            this.patrolTarget = null;
            this.patrolElapsed = 0;
            this.nav?.reset();
            if (this.mobility) this.patrolTimer = this.nextPatrolInterval();
          },
          update: (dt) => this.updateBarricaded(dt),
          exit: () => {
            this.patrolTarget = null;
            this.patrolElapsed = 0;
            this.nav?.reset();
          },
        },
        [SuspectState.ALERT]: {
          enter: () => {
            this.alertTimer = 0;
            this.body.setReadyPose('high');
          },
          update: (dt) => this.updateAlert(dt),
          exit: () => {
            this.alertMoveTarget = null;
            this.alertMoveMode = null;
            this.alertMoveElapsed = 0;
            this.alertCover = null;
            this.clearAmbush();
            this.nav?.reset();
          },
        },
        [SuspectState.CONFRONTATION]: { update: () => this.updateConfrontation() },
        [SuspectState.HESITATE]: {
          enter: () => (this.hesitateRetreated = 0),
          update: (dt) => this.updateHesitate(dt),
          exit: () => this.body.setShake(0),
        },
        [SuspectState.SURRENDER]: {
          enter: () => {
            this.body.setFlash(false);
            this.body.setShake(0);
            this.body.setPose('kneel');
            this.unwatchedSurrenderSec = 0;
          },
        },
        [SuspectState.ENGAGE]: {
          enter: () => {
            this.body.setPose('stand');
            this.body.setReadyPose('high');
            this.engage?.enter(this.known);
          },
          update: (dt) => this.engage?.update(dt, this.known, this.sees, this.visibleThreat),
          exit: () => this.engage?.exit(),
        },
        [SuspectState.HOSTAGE_SHIELD]: {
          enter: () => this.clearMobilityMovement(),
          update: (dt) => this.updateShield(dt),
          // 交渉へ移る場合は人質を保持したまま（交渉成功時にのみ解放する）
          exit: (to) => {
            if (to !== SuspectState.NEGOTIATION) this.shield?.release();
          },
        },
        [SuspectState.NEGOTIATION]: {
          enter: () => this.clearMobilityMovement(),
          update: (dt) => this.updateNegotiation(dt),
          exit: (to) => {
            if (to !== SuspectState.HOSTAGE_SHIELD) this.shield?.release();
          },
        },
        [SuspectState.ARRESTED]: {
          enter: () => {
            this.body.setPose('kneel');
            this.body.setRestrained(true);
            this.body.setTint(ARRESTED_COLOR);
          },
        },
        [SuspectState.DOWN]: {
          enter: () => {
            this.body.setFlash(false);
            this.body.setShake(0);
            this.body.setPose('down');
          },
        },
      },
      SuspectState.BARRICADED,
      (from, to) => {
        if (from !== null) this.bus.emit('suspectStateChanged', { id: this.id, from, to, morale: this.morale.value });
      },
    );
  }

  get state(): SuspectState {
    return this.fsm.state;
  }

  /** デバッグ表示用（ENGAGE はサブフェーズ付き） */
  get debugState(): string {
    if (this.state === SuspectState.HOSTAGE_SHIELD && this.shield) return `SHIELD/${this.shield.label}`;
    return this.state === SuspectState.ENGAGE && this.engage ? `ENGAGE/${this.engage.label}` : this.state;
  }

  /** CS 催涙ガスの蓄積露出度 (0..100) */
  get gasExposure(): number {
    return this.gasLevel;
  }

  /** CS 催涙ガスで咳き込んでいるか */
  get isCoughing(): boolean {
    return this.gasLevel / 100 > GAS_COUGH_THRESHOLD;
  }

  /** フラッシュ/C2 等で視界喪失・怯み中か */
  get isFlashed(): boolean {
    return this.blindLeft > 0;
  }

  /** 現在の実効移動速度（ガス補正後） */
  get currentMoveSpeed(): number {
    return this.combat?.moveSpeed ?? 0;
  }

  /** 現在の実効拡散角（度、ガス補正後） */
  get currentSpreadDeg(): number {
    return this.combat?.baseSpreadDeg ?? 0;
  }

  /** 毎フレーム更新（士気の低下検知→遷移、自然回復、CSガス反応、FSM）。終端ステートでは回復しない。 */
  update(rawDt: number, gas?: GasSample): void {
    const dt = Math.min(rawDt, MAX_DT);
    this.body.tick(dt);
    this.warningLeft = Math.max(0, this.warningLeft - dt);
    this.blindLeft = Math.max(0, this.blindLeft - dt);
    this.ambushRollCd = Math.max(0, this.ambushRollCd - dt);
    const density = Math.max(0, Math.min(1, gas?.density ?? 0));
    const st = this.fsm.state;
    if (st === SuspectState.DOWN || st === SuspectState.ARRESTED) {
      this.gasLevel = Math.max(0, this.gasLevel - GAS_DECAY_PER_SEC * dt);
      this.gasFlushTarget = null;
      this.gasFlushElapsed = 0;
      this.syncGasCombatParams();
      return;
    }
    if (st === SuspectState.SURRENDER) {
      this.gasLevel = Math.max(0, this.gasLevel - GAS_DECAY_PER_SEC * dt);
      this.gasFlushTarget = null;
      this.gasFlushElapsed = 0;
      this.syncGasCombatParams();
      this.fsm.update(dt);
      this.checkFakeSurrender(dt);
      return;
    }
    if (density > 0) {
      this.gasLevel = Math.min(100, this.gasLevel + GAS_BUILD_PER_SEC * density * dt);
    } else {
      this.gasLevel = Math.max(0, this.gasLevel - GAS_DECAY_PER_SEC * dt);
    }
    this.syncGasCombatParams();
    const gasK = this.gasLevel / 100;
    if (density > 0) {
      // 完全非致死: HP は一切減らさず士気低下のみで投降・あぶり出しを促す
      this.morale.shift(-GAS_MORALE_DRAIN_PER_SEC * Math.max(0.35, density) * dt);
    }
    this.gasCoughCd = Math.max(0, this.gasCoughCd - dt);
    if (gasK > GAS_COUGH_THRESHOLD && this.gasCoughCd <= 0) {
      this.gasCoughCd = 2.4 + Math.random() * 1.4;
      this.bus.emit('noise', {
        pos: this.body.chestPos(),
        radius: GAS_COUGH_NOISE_RADIUS,
        kind: 'voice',
        source: 'suspect',
      });
    }
    if (
      this.morale.value < this.prevMorale - 1e-6 ||
      (density > 0 && this.managed && this.morale.value < this.profile.thresholds.surrenderBelow)
    ) {
      this.evaluateDrop();
    }
    this.negoLock = Math.max(0, this.negoLock - dt);
    if (
      this.state !== SuspectState.SURRENDER &&
      this.state !== SuspectState.NEGOTIATION &&
      density <= 0 &&
      this.gasLevel <= 0
    ) {
      this.morale.recover(dt);
    }
    this.prevMorale = this.morale.value;
    if (this.state === SuspectState.SURRENDER) {
      this.gasFlushTarget = null;
      this.gasFlushElapsed = 0;
      return;
    }
    this.senseTarget();
    this.checkShieldEntry(dt);
    const flushing = this.updateGasFlush(dt, density, gasK, gas?.origin ?? null);
    if (!flushing) {
      this.fsm.update(dt);
    }
    if (this.blindLeft > 0 && this.managed) {
      this.body.setPose('crouch');
      this.body.setShake(Math.sin(this.blindLeft * 28) * 0.12);
    } else if (gasK > GAS_COUGH_THRESHOLD && this.managed && this.state !== SuspectState.HESITATE) {
      this.body.setShake(Math.sin(this.gasLevel * 0.45 + this.gasCoughCd * 18) * 0.06 * gasK);
    } else if (this.managed && this.state !== SuspectState.HESITATE) {
      this.body.setShake(0);
    }
  }

  private syncGasCombatParams(): void {
    if (!this.combat) return;
    const k = this.gasLevel / 100;
    this.combat.moveSpeed = this.baseMoveSpeed * (1 - GAS_MAX_SLOWDOWN * k);
    this.combat.baseSpreadDeg = this.baseSpreadDeg + k * GAS_MAX_SPREAD_PENALTY;
  }

  private updateGasFlush(dt: number, density: number, gasK: number, origin: Vec3 | null): boolean {
    if (this.blindLeft > 0 || !this.managed || this.state === SuspectState.HOSTAGE_SHIELD) {
      return false;
    }
    if (density > 0 && gasK >= GAS_FLUSH_THRESHOLD && !this.gasFlushTarget) {
      this.gasFlushTarget = this.pickGasEscapePoint(origin);
      this.gasFlushElapsed = 0;
      this.nav?.reset();
      if (this.gasFlushTarget && this.state === SuspectState.BARRICADED) {
        this.setState(SuspectState.ALERT);
      }
    }
    if (!this.gasFlushTarget) return false;
    if (density <= 0) {
      this.gasFlushTarget = null;
      this.gasFlushElapsed = 0;
      this.nav?.reset();
      return false;
    }
    this.gasFlushElapsed += dt;
    const speed = Math.max(0.8, this.combat?.moveSpeed ?? 1.8);
    if (this.nav) {
      const res = this.nav.step(this.gasFlushTarget, speed, dt, {
        canOpenDoors: true,
        canUseStairs: !!this.mobility?.canUseStairs,
        faceTravel: true,
        arriveDist: 0.7,
      });
      if (res !== 'moving' || this.gasFlushElapsed >= 5.0) {
        this.gasFlushTarget = null;
        this.gasFlushElapsed = 0;
        this.nav.reset();
      }
    } else {
      stepToward(this.body, this.ctx?.colliders ?? [], this.gasFlushTarget.x, this.gasFlushTarget.z, speed * dt);
      this.body.faceToward(this.gasFlushTarget.x, this.gasFlushTarget.z);
      const dist = Math.hypot(this.gasFlushTarget.x - this.body.px, this.gasFlushTarget.z - this.body.pz);
      if (dist <= 0.7 || this.gasFlushElapsed >= 5.0) {
        this.gasFlushTarget = null;
        this.gasFlushElapsed = 0;
      }
    }
    return true;
  }

  private pickGasEscapePoint(origin: Vec3 | null): Vec3 | null {
    const px = this.body.px;
    const pz = this.body.pz;
    const fy = this.body.footY;
    const colliders = this.ctx?.colliders ?? [];
    const rooms = this.ctx?.rooms;
    if (rooms && rooms.length > 0) {
      const cur = this.currentRoom();
      const refX = origin?.x ?? px;
      const refZ = origin?.z ?? pz;
      const minSafeDist = origin ? 4.5 : 3.0;
      let best: { pt: Vec3; dist: number } | null = null;
      for (const r of rooms) {
        if (r.outdoor) continue;
        const rfy = r.floorY ?? 0;
        if (!this.mobility?.canUseStairs && Math.abs(rfy - fy) > 0.65) continue;
        if (cur && r.id === cur.id) continue;
        if (Math.hypot(r.x - refX, r.z - refZ) < minSafeDist) continue;
        if (blockedAtFiltered(colliders, r.x, r.z, 0.3, rfy)) continue;
        const dist = Math.hypot(r.x - px, r.z - pz);
        if (!best || dist < best.dist) {
          best = { pt: { x: r.x, y: rfy, z: r.z }, dist };
        }
      }
      if (best) return best.pt;
    }

    let awayAngle = this.body.yawRad + Math.PI;
    if (origin) {
      const dx = px - origin.x;
      const dz = pz - origin.z;
      if (Math.hypot(dx, dz) > 0.05) {
        awayAngle = Math.atan2(dx, dz);
      }
    }
    const offsets = [0, 0.6, -0.6, 1.2, -1.2, 2.0, -2.0, Math.PI];
    const dists = [4.8, 3.6, 2.4];
    for (const d of dists) {
      for (const off of offsets) {
        const a = awayAngle + off;
        const tx = px + Math.sin(a) * d;
        const tz = pz + Math.cos(a) * d;
        if (this.ctx?.bounds) {
          if (Math.abs(tx) > this.ctx.bounds.width / 2 - 0.5 || Math.abs(tz) > this.ctx.bounds.depth / 2 - 0.5) {
            continue;
          }
        }
        if (!blockedAtFiltered(colliders, tx, tz, 0.3, fy)) {
          return { x: tx, y: fy, z: tz };
        }
      }
    }
    return null;
  }

  /** 突入前交渉の結果を反映する: 士気の増減（正 = 強気） */
  adjustMorale(delta: number): void {
    if (!this.managed) return;
    this.morale.shift(delta);
    this.prevMorale = this.morale.value;
  }

  /** 容疑者モードの籠城準備: 武器を改造（与ダメージ倍率・拡散倍率）。EngageBehavior は同じ参数オブジェクトを参照する */
  upgradeWeapon(damageMul: number, spreadMul: number): void {
    if (!this.combat) return;
    this.combat.shotDamage = Math.round(this.combat.shotDamage * damageMul);
    this.baseSpreadDeg *= spreadMul;
    this.syncGasCombatParams();
  }

  /** 突入前交渉で説得に応じた: その場で投降（拘束待ち） */
  forceSurrender(): boolean {
    if (!this.managed) return false;
    this.setState(SuspectState.SURRENDER);
    return true;
  }

  /** フラッシュ直撃。士気低下は MoraleSystem が行い、こちらは視界喪失。 */
  onFlashed(seconds: number): void {
    if (!this.alive || !Number.isFinite(seconds) || seconds <= 0) return;
    this.blindLeft = Math.max(this.blindLeft, seconds);
    this.clearAmbush(); // 閃光で視界を失うと待ち伏せは崩れる
  }

  getAABB(): AABB {
    return this.body.getAABB();
  }

  get alive(): boolean {
    return this.state !== SuspectState.DOWN;
  }

  private setState(to: SuspectState): void {
    this.fsm.transition(to);
  }

  /** 管理対象の（士気で遷移する）ステートか */
  private get managed(): boolean {
    const st = this.state;
    return (
      st === SuspectState.BARRICADED ||
      st === SuspectState.ALERT ||
      st === SuspectState.CONFRONTATION ||
      st === SuspectState.HESITATE ||
      st === SuspectState.ENGAGE ||
      st === SuspectState.HOSTAGE_SHIELD
    );
  }

  /** 警告を受けた（pos=警告者位置、pressureScale=味方数値優位による威圧倍率）。 */
  onWarned(pos: Vec3, pressureScale = 1): void {
    if (this.alive) this.warned = true;
    if (!this.managed || this.warningLeft > 0) return;
    this.warningLeft = this.warningCooldown;
    this.morale.apply('warningCall', pressureScale);
    this.known = { x: pos.x, y: resolveFloorY(pos, this.ctx?.rooms, 'voice'), z: pos.z };
    this.body.faceToward(pos.x, pos.z);
    if (this.state === SuspectState.BARRICADED || this.state === SuspectState.ALERT) {
      this.setState(SuspectState.CONFRONTATION);
    }
    this.evaluateDrop();
    this.prevMorale = this.morale.value;
  }

  /** 士気低下後の遷移判定（MVP_SPEC §3 の発生条件）。 */
  private evaluateDrop(): void {
    if (!this.managed) return;
    const th = this.profile.thresholds;
    const st = this.state;
    if (this.morale.value < th.surrenderBelow) {
      this.setState(SuspectState.SURRENDER);
    } else if (
      this.morale.value < th.hesitateBelow &&
      (st === SuspectState.BARRICADED || st === SuspectState.ALERT || st === SuspectState.ENGAGE)
    ) {
      this.setState(SuspectState.HESITATE);
    }
  }

  private nextPatrolInterval(): number {
    const m = this.mobility;
    if (!m) return 15;
    return m.patrolIntervalMin + Math.random() * Math.max(0, m.patrolIntervalMax - m.patrolIntervalMin);
  }

  private clearMobilityMovement(): void {
    this.patrolTarget = null;
    this.patrolElapsed = 0;
    this.alertMoveTarget = null;
    this.alertMoveMode = null;
    this.alertMoveElapsed = 0;
    this.alertCover = null;
    this.nav?.reset();
  }

  private currentRoom(): RoomDef | null {
    const rooms = this.ctx?.rooms;
    if (!rooms) return null;
    const px = this.body.px;
    const pz = this.body.pz;
    const fy = this.body.footY;
    return (
      rooms.find(
        (r) =>
          Math.abs((r.floorY ?? 0) - fy) <= 0.65 &&
          Math.abs(px - r.x) <= r.width / 2 &&
          Math.abs(pz - r.z) <= r.depth / 2,
      ) ?? null
    );
  }

  /** 同室に未保護の生存民間人がいるか（人質室防衛優先判定）。 */
  private hasUnsecuredCivilianInSameRoom(): boolean {
    if (!this.ctx?.civilians) return false;
    const room = this.currentRoom();
    if (!room) return false;
    const fy = room.floorY ?? 0;
    for (const c of this.ctx.civilians()) {
      if (!c.canBeShielded) continue;
      if (
        Math.abs(c.body.footY - fy) <= 0.65 &&
        Math.abs(c.body.px - room.x) <= room.width / 2 &&
        Math.abs(c.body.pz - room.z) <= room.depth / 2
      ) {
        return true;
      }
    }
    return false;
  }

  private pickPatrolPoint(): Vec3 | null {
    const rooms = this.ctx?.rooms;
    const mob = this.mobility;
    if (!rooms || rooms.length === 0 || !mob || !this.ctx) return null;
    const cur = this.currentRoom();
    const candidates = rooms.filter((r) => {
      if (r.outdoor) return false;
      if (!mob.canUseStairs && Math.abs((r.floorY ?? 0) - this.body.footY) > 0.65) return false;
      return !cur || r.id !== cur.id;
    });
    const pool = candidates.length > 0 ? candidates : cur ? [cur] : [];
    if (pool.length === 0) return null;
    // シャッフル気味に最大 4 部屋試す
    for (let attempt = 0; attempt < Math.min(4, pool.length); attempt++) {
      const r = pool[Math.floor(Math.random() * pool.length)]!;
      const fy = r.floorY ?? 0;
      const marginX = Math.max(0, r.width / 2 - 0.6);
      const marginZ = Math.max(0, r.depth / 2 - 0.6);
      const tx = r.x + (Math.random() * 2 - 1) * marginX * 0.5;
      const tz = r.z + (Math.random() * 2 - 1) * marginZ * 0.5;
      if (!blockedAtFiltered(this.ctx.colliders, tx, tz, 0.3, fy)) {
        return { x: tx, y: fy, z: tz };
      }
      if (!blockedAtFiltered(this.ctx.colliders, r.x, r.z, 0.3, fy)) {
        return { x: r.x, y: fy, z: r.z };
      }
    }
    return null;
  }

  /** BARRICADED: プロファイルに応じた部屋間巡回（非敵対ステート内で完結）。 */
  private updateBarricaded(dt: number): void {
    const mob = this.mobility;
    if (!mob || !this.combat || !this.nav || this.blindLeft > 0) return;
    if (mob.guardHostageRoom && this.hasUnsecuredCivilianInSameRoom()) {
      this.patrolTarget = null;
      return;
    }
    if (!this.patrolTarget) {
      this.patrolTimer -= dt;
      if (this.patrolTimer > 0) return;
      this.patrolTimer = this.nextPatrolInterval();
      if (Math.random() > mob.patrolChance) return;
      const pt = this.pickPatrolPoint();
      if (!pt) return;
      this.patrolTarget = pt;
      this.patrolElapsed = 0;
      this.nav.reset();
      return;
    }

    this.patrolElapsed += dt;
    const res = this.nav.step(this.patrolTarget, this.combat.moveSpeed * mob.patrolSpeedScale, dt, {
      canOpenDoors: mob.canOpenDoors,
      canUseStairs: mob.canUseStairs,
      faceTravel: true,
      arriveDist: 0.7,
    });
    if (res !== 'moving' || this.patrolElapsed >= 20) {
      this.patrolTarget = null;
      this.patrolElapsed = 0;
      this.patrolTimer = this.nextPatrolInterval();
      this.nav.reset();
    }
  }

  /** 待ち伏せ中か（移動中・待機中どちらも） */
  get isAmbushing(): boolean {
    return this.ambushSpot !== null;
  }

  /** 位置に着き、入口へ照準を置いて待っているか（pre-aim 状態） */
  get isAmbushReady(): boolean {
    return this.ambushSpot !== null && this.ambushReady && this.state === SuspectState.ALERT && this.blindLeft <= 0;
  }

  /** pre-aim 状態の反応時間（秒）。非待ち伏せ時は profile.reactionTime */
  get ambushReactionSec(): number {
    return this.profile.ambush?.preAimReactionSec ?? this.profile.reactionTime;
  }

  /** pre-aim 円錐の半角 cos と有効距離（Perception が参照） */
  get ambushCone(): { coneDeg: number; maxDist: number } {
    const a = this.profile.ambush;
    return { coneDeg: a?.coneDeg ?? 70, maxDist: a?.maxDist ?? 14 };
  }

  /** 待ち伏せ位置（デバッグ・テスト用） */
  get ambushTarget(): AmbushSpot | null {
    return this.ambushSpot;
  }

  private clearAmbush(): void {
    if (!this.ambushSpot) return;
    this.ambushSpot = null;
    this.ambushReady = false;
    this.ambushElapsed = 0;
    if (this.managed && this.state !== SuspectState.HESITATE && this.blindLeft <= 0) this.body.setPose('stand');
  }

  /** 室内の入口方向へ待ち伏せる位置を決める。成功したら true（既存の調査移動・遮蔽退避は行わない）。 */
  private tryBeginAmbush(pos: Vec3, kind: NoiseKind, source?: NoiseSource): boolean {
    const params = this.profile.ambush;
    if (!params || !this.ctx || !this.combat || this.friendly || source === 'suspect') return false;
    if (this.blindLeft > 0 || this.gasLevel / 100 > GAS_COUGH_THRESHOLD) return false;
    if (!AMBUSH_TRIGGER_KINDS.includes(kind)) return false;
    if (this.ambushSpot) {
      // 待ち伏せ継続中: 新しい物音で待機時間を延長する
      this.ambushElapsed = Math.max(0, this.ambushElapsed - 2);
      return true;
    }
    if (this.ambushRollCd > 0) return false;
    const room = this.currentRoom();
    const doors = this.ctx.doors?.doors;
    if (!room || !doors || doors.length === 0) return false;
    const rect = roomRectOf(room);
    if (pointInRoom(rect, pos.x, pos.z, resolveFloorY(pos, this.ctx.rooms, kind), 0)) return false; // すでに室内
    const dist = Math.hypot(pos.x - this.body.px, pos.z - this.body.pz);
    if (dist > params.maxDist * 1.6) return false;
    // 乱数は 1 つの物音エピソードにつき一度だけ（足音ごとの再抽選で確率が上振れしない）
    this.ambushRollCd = 8;
    if (Math.random() >= ambushProbability(params, this.profile.aggression)) return false;

    const cand: Doorway[] = doorwaysOfRoom(
      doors.map((d) => ({
        id: d.id,
        x: d.centerX,
        z: d.centerZ,
        nx: d.normalX,
        nz: d.normalZ,
        ax: d.axisX,
        az: d.axisZ,
        sillY: d.sillY,
        width: d.width,
      })),
      rect,
    );
    if (cand.length === 0) return false;
    cand.sort((a, b) => Math.hypot(a.x - pos.x, a.z - pos.z) - Math.hypot(b.x - pos.x, b.z - pos.z));
    const entry = cand[0]!;
    if (Math.hypot(entry.x - pos.x, entry.z - pos.z) > params.maxDist) return false;
    const spot = findAmbushSpot({
      colliders: this.ctx.colliders,
      room: rect,
      doorway: entry,
      from: { x: this.body.px, z: this.body.pz },
      maxDist: params.maxDist,
    });
    if (!spot) return false;
    this.ambushSpot = spot;
    this.ambushReady = false;
    this.ambushElapsed = 0;
    this.alertMoveTarget = null;
    this.alertMoveMode = null;
    this.alertCover = null;
    this.nav?.reset();
    return true;
  }

  /** ALERT 中の待ち伏せ行動。処理した（通常の ALERT 挙動をスキップする）なら true。 */
  private updateAmbush(dt: number): boolean {
    const spot = this.ambushSpot;
    const params = this.profile.ambush;
    if (!spot || !params || !this.combat || !this.ctx) return false;
    if (this.blindLeft > 0 || this.gasLevel / 100 > GAS_COUGH_THRESHOLD) {
      this.clearAmbush();
      return false;
    }
    this.ambushElapsed += dt;
    if (this.ambushElapsed >= params.holdSec) {
      this.clearAmbush();
      return false;
    }
    this.alertTimer = 0; // 待ち伏せ中は ALERT の自然鎮静を止める
    const d = Math.hypot(spot.x - this.body.px, spot.z - this.body.pz);
    if (!this.ambushReady) {
      if (d > 0.14) {
        this.body.faceToward(spot.x, spot.z);
        stepToward(this.body, this.ctx.colliders, spot.x, spot.z, this.combat.moveSpeed * 0.8 * dt);
        return true;
      }
      this.ambushReady = true;
      this.body.setPose(spot.crouch ? 'crouch' : 'stand');
      this.body.setReadyPose('high');
    }
    this.body.aimAt(spot.aim.x, spot.aim.y, spot.aim.z, dt, Math.PI * 3 * dt);
    return true;
  }

  private updateAlert(dt: number): void {
    if (this.ambushSpot && this.updateAmbush(dt)) return;
    if (this.alertMoveTarget && this.combat && this.mobility && this.nav && this.blindLeft <= 0) {
      this.alertMoveElapsed += dt;
      const speedScale =
        this.alertMoveMode === 'reinforce'
          ? Math.min(1.0, this.mobility.investigateSpeedScale * 1.1)
          : this.mobility.investigateSpeedScale;
      const res = this.nav.step(this.alertMoveTarget, this.combat.moveSpeed * speedScale, dt, {
        canOpenDoors: this.mobility.canOpenDoors,
        canUseStairs: this.mobility.canUseStairs,
        faceTravel: true,
        arriveDist: 1.6,
      });
      if (res !== 'moving' || this.alertMoveElapsed >= 16) {
        this.alertMoveTarget = null;
        this.alertMoveMode = null;
        this.alertMoveElapsed = 0;
        this.nav.reset();
      }
      return;
    }

    this.alertTimer += dt;
    if (this.alertCover && this.ctx && this.combat) {
      const d = Math.hypot(this.alertCover.x - this.body.px, this.alertCover.z - this.body.pz);
      if (d > 0.14) {
        stepToward(this.body, this.ctx.colliders, this.alertCover.x, this.alertCover.z, this.combat.moveSpeed * 0.75 * dt);
      } else {
        this.alertCover = null;
      }
    }
    if (this.heardAt) {
      const dx = this.heardAt.x - this.body.px;
      const dz = this.heardAt.z - this.body.pz;
      if (Math.hypot(dx, dz) > 0.05) {
        const scan = Math.max(0, this.alertTimer - this.profile.reactionTime * 2);
        const bearing = Math.atan2(dx, dz) + Math.sin(scan * 1.5) * 0.45;
        this.body.faceToward(this.body.px + Math.sin(bearing), this.body.pz + Math.cos(bearing));
      }
    }
    if (this.combat && this.alertTimer >= this.combat.alertCalmSec) {
      this.heardAt = null;
      this.alertCover = null;
      this.body.setReadyPose('low');
      this.setState(SuspectState.BARRICADED);
    }
  }

  /** CONFRONTATION: decisionSec 経過で士気を再計算して次行動を分岐。 */
  private updateConfrontation(): void {
    if (this.known) this.body.faceToward(this.known.x, this.known.z);
    if (!this.combat || this.fsm.timeInState < this.combat.decisionSec) return;
    const th = this.profile.thresholds;
    if (this.morale.value < th.surrenderBelow) this.setState(SuspectState.SURRENDER);
    else if (this.morale.value < th.hesitateBelow) this.setState(SuspectState.HESITATE);
    else this.setState(SuspectState.ENGAGE);
  }

  /** HESITATE: 銃を構えたまま震えて後退。放置すると ENGAGE へ戻る。 */
  private updateHesitate(dt: number): void {
    if (!this.combat) return;
    const c = this.combat;
    if (this.known) {
      this.body.faceToward(this.known.x, this.known.z);
      if (this.ctx && this.hesitateRetreated < c.hesitateRetreatMax) {
        const dx = this.body.px - this.known.x;
        const dz = this.body.pz - this.known.z;
        const l = Math.hypot(dx, dz) || 1;
        const step = c.hesitateRetreatSpeed * dt;
        const x0 = this.body.px;
        const z0 = this.body.pz;
        stepToward(this.body, this.ctx.colliders, x0 + (dx / l) * step, z0 + (dz / l) * step, step);
        this.hesitateRetreated += Math.hypot(this.body.px - x0, this.body.pz - z0);
      }
    }
    const shake = Math.sin(this.fsm.timeInState * 40) * c.hesitateShakeDeg * (Math.PI / 180);
    this.body.setShake(shake);
    if (this.fsm.timeInState >= c.hesitateFireSec) this.setState(SuspectState.ENGAGE);
  }

  /** 交戦系ステートではプレイヤー・味方隊員の視認を毎フレーム更新。 */
  private senseTarget(): void {
    this.sees = false;
    this.visibleThreat = null;
    if (this.blindLeft > 0) return;
    const st = this.state;
    if (!this.ctx || !this.combat) return;
    if (
      st !== SuspectState.CONFRONTATION &&
      st !== SuspectState.HESITATE &&
      st !== SuspectState.ENGAGE &&
      st !== SuspectState.HOSTAGE_SHIELD
    ) {
      return;
    }
    const eyeY = this.body.footY + (st === SuspectState.ENGAGE ? 1.45 : 1.55);
    const threat = findNearestVisibleThreat(this.ctx, this.body.px, this.body.pz, eyeY, this.combat.engageRange);
    if (threat) {
      this.sees = true;
      this.visibleThreat = threat;
      this.known = { x: threat.x, y: resolveFloorY(threat.point, this.ctx.rooms, 'gunshot'), z: threat.z };
    }
  }

  /** 投降後に誰も視線を向けていない時間が続くと、強硬犯が一度だけ武器を拾い直して反撃することがある。 */
  private checkFakeSurrender(dt: number): void {
    const chance = this.combat?.fakeSurrenderChance ?? 0;
    const waitSec = this.combat?.fakeSurrenderSec ?? 9;
    if (this.fakeSurrenderChecked || chance <= 0 || !this.ctx) return;
    if (this.evidenceCollected || this.body.getDroppedWeaponPos() === null) return;

    const chest = this.body.chestPos();
    let watched = false;
    if (this.ctx.player.alive !== false) {
      const pEye = this.ctx.player.getEyePosition();
      const d = Math.hypot(chest.x - pEye.x, chest.z - pEye.z);
      if (d <= 14 && hasLineOfSight(this.ctx.colliders, pEye, chest)) watched = true;
    }
    if (!watched && (this.ctx.countCoveringAllies?.(chest, 12) ?? 0) > 0) {
      watched = true;
    }

    if (watched) {
      this.unwatchedSurrenderSec = 0;
      return;
    }
    this.unwatchedSurrenderSec += dt;
    if (this.unwatchedSurrenderSec < waitSec) return;

    this.fakeSurrenderChecked = true;
    if (Math.random() < chance) {
      this.morale.shift(Math.max(15, this.profile.thresholds.hesitateBelow + 12 - this.morale.value));
      this.prevMorale = this.morale.value;
      this.setState(SuspectState.ENGAGE);
    }
  }

  /**
   * HOSTAGE_SHIELD 発動判定（MVP_SPEC §3）。CONFRONTATION(決断後)/HESITATE/ENGAGE から、すべて満たすと遷移:
   *  - 高ストレス: 士気 < shield.moraleBelow（surrenderBelow 未満は降伏が優先）
   *  - 近距離に民間人: shield.civilianRange 内で直進路がある生存・未保持の民間人
   *  - プレイヤーを把握しており shield.playerRange 内
   *  - 脱出路なし: プレイヤーから離れる直進路が escapeMinGain 以上確保できない（壁際/角）
   */
  private checkShieldEntry(dt: number): void {
    const sh = this.profile.shield;
    if (!this.shield || !sh || !this.ctx || !this.known) return;
    this.shieldCd = Math.max(0, this.shieldCd - dt);
    this.shieldCheckT -= dt;
    if (this.shieldCheckT > 0 || this.shieldCd > 0) return;
    this.shieldCheckT = sh.checkIntervalSec;
    const st = this.state;
    const eligible =
      st === SuspectState.HESITATE ||
      st === SuspectState.ENGAGE ||
      (st === SuspectState.CONFRONTATION && !!this.combat && this.fsm.timeInState >= this.combat.decisionSec);
    if (!eligible) return;
    const m = this.morale.value;
    if (m >= sh.moraleBelow || m < this.profile.thresholds.surrenderBelow) return;
    const k = this.known;
    if (Math.hypot(k.x - this.body.px, k.z - this.body.pz) > sh.playerRange) return;
    const civ = this.shield.findCandidate();
    if (!civ) return;
    if (hasEscapeRoute(this.ctx.colliders, { x: this.body.px, z: this.body.pz }, k, sh, this.body.footY)) return;
    this.shield.begin(civ);
    this.setState(SuspectState.HOSTAGE_SHIELD);
  }

  /** HOSTAGE_SHIELD 中。保持不能（民間人死亡/掴み失敗）なら ENGAGE（敵対）へ。 */
  private updateShield(dt: number): void {
    if (!this.shield || !this.combat) return;
    if (this.shield.update(dt, this.known, this.combat.moveSpeed)) return;
    this.shieldCd = this.profile.shield?.retrySec ?? 0;
    this.setState(SuspectState.ENGAGE);
  }

  /** 交渉中。盾を保持していれば保持を継続（プレイヤー位置に合わせて回り込む）。保持不能なら ENGAGE。 */
  private updateNegotiation(dt: number): void {
    if (this.negoPrev === SuspectState.HOSTAGE_SHIELD && this.shield?.target && this.combat) {
      if (this.shield.update(dt, this.known, this.combat.moveSpeed)) return;
      this.shieldCd = this.profile.shield?.retrySec ?? 0;
      this.setState(SuspectState.ENGAGE);
      return;
    }
    if (this.known) this.body.faceToward(this.known.x, this.known.z);
  }

  /** 人質を保持している/掴みに行っている（盾ステート中、または盾からの交渉中）。 */
  get isHoldingHostage(): boolean {
    return (this.state === SuspectState.HOSTAGE_SHIELD || this.negotiatingWithHostage) && !!this.shield?.target;
  }

  /** 交渉中か（人質を保持している/保持しようとしているか） */
  get negotiatingWithHostage(): boolean {
    return this.state === SuspectState.NEGOTIATION && this.negoPrev === SuspectState.HOSTAGE_SHIELD && !!this.shield?.target;
  }

  /** 交渉ロック中（決裂直後）か */
  get negotiationLocked(): boolean {
    return this.negoLock > 0;
  }

  /** 交渉を開始（声が届く＝プレイヤー位置を把握）。from が許可外/ロック中なら false。 */
  beginNegotiation(player: Vec3, allowed: readonly string[]): boolean {
    if (!this.alive || this.negoLock > 0 || !allowed.includes(this.state)) return false;
    this.negoPrev = this.state;
    this.known = { x: player.x, y: player.y, z: player.z };
    this.setState(SuspectState.NEGOTIATION);
    return true;
  }

  /** 交渉中のプレイヤー位置更新（無線は声が届く距離＝常に把握）。 */
  updateNegotiationTarget(player: Vec3): void {
    if (this.state === SuspectState.NEGOTIATION) this.known = { x: player.x, y: player.y, z: player.z };
  }

  /**
   * 交渉の結末を適用。surrender/release → 人質解放＋投降。fire → 発砲（shotFired/suspectFired/noise）後に敵対化。
   * worsen → 敵対化（盾保持中は盾に復帰）。abort → 元のステートへ復帰。決裂系は lockoutSec の再交渉ロック。
   * NEGOTIATION 以外（被弾/士気低下/DOWN などで既に遷移済み）なら何もしない。
   */
  endNegotiation(result: NegotiationResult, lockoutSec: number): void {
    if (this.state !== SuspectState.NEGOTIATION) return;
    const prev = this.negoPrev;
    this.negoPrev = null;
    const holding = prev === SuspectState.HOSTAGE_SHIELD && !!this.shield?.target;
    if (result === 'surrender' || result === 'release') {
      this.setState(SuspectState.SURRENDER);
      return;
    }
    if (result === 'fire') {
      if (this.engage) {
        this.engage.fireAt(this.visibleThreat, this.known);
      } else {
        const chest = this.body.chestPos();
        const pos = { x: chest.x, y: chest.y, z: chest.z };
        this.body.showMuzzleFlash(0.06);
        this.bus.emit('suspectFired', { id: this.id, pos, warned: this.warned });
        this.bus.emit('shotFired', { shooter: this.id, pos });
        this.bus.emit('noise', { pos, radius: this.combat?.gunshotNoiseRadius ?? 40, kind: 'gunshot', source: 'suspect' });
      }
    }
    if (result === 'fire' || result === 'worsen') this.negoLock = lockoutSec;
    if (result === 'abort' || result === 'interrupted') {
      this.setState(prev ?? SuspectState.BARRICADED);
    } else if (holding) {
      this.setState(SuspectState.HOSTAGE_SHIELD);
    } else {
      this.setState(SuspectState.ENGAGE);
    }
    this.evaluateDrop();
    this.prevMorale = this.morale.value;
  }

  /** 知覚の対象か（未発見/警戒中のみ。それ以外のステートは戦闘系ステートが管理） */
  get canPerceive(): boolean {
    return this.state === SuspectState.BARRICADED || this.state === SuspectState.ALERT;
  }

  /** ENGAGE 中に音イベントで known を更新できるか */
  get canUpdateKnownFromNoise(): boolean {
    return this.state === SuspectState.ENGAGE;
  }

  /** 容疑者自身が今まさにドアを開閉中か（無限 ALERT 連鎖防止用） */
  get isOpeningDoor(): boolean {
    return this.nav?.isOpeningDoor ?? false;
  }

  /** 音を聴いた。BARRICADED→ALERT（ALERT 中は継続タイマーをリセット）。プロファイルに応じて調査移動または増援合流。 */
  onHeardNoise(pos: Vec3, kind: NoiseKind, _source?: NoiseSource): void {
    if (!this.canPerceive) return;
    const floorY = resolveFloorY(pos, this.ctx?.rooms, kind);
    const target: Vec3 = { x: pos.x, y: floorY, z: pos.z };
    this.heardAt = target;
    this.alertTimer = 0;

    if (this.tryBeginAmbush(pos, kind, _source)) {
      this.setState(SuspectState.ALERT);
      return;
    }

    const mob = this.mobility;
    const guardRoom = Boolean(mob?.guardHostageRoom && this.hasUnsecuredCivilianInSameRoom());
    const dist = Math.hypot(pos.x - this.body.px, pos.z - this.body.pz);
    const diffFloor = Math.abs(floorY - this.body.footY) > 0.75;
    const canReachFloor = !diffFloor || Boolean(mob?.canUseStairs);

    if (mob && this.nav && !guardRoom && canReachFloor) {
      if (mob.reinforceOnGunshot && (kind === 'gunshot' || kind === 'breach') && dist <= mob.investigateMaxDist * 1.4) {
        this.alertMoveTarget = target;
        this.alertMoveMode = 'reinforce';
        this.alertMoveElapsed = 0;
        this.alertCover = null;
        this.nav.reset();
      } else if (dist <= mob.investigateMaxDist && Math.random() < mob.investigateChance) {
        this.alertMoveTarget = target;
        this.alertMoveMode = 'investigate';
        this.alertMoveElapsed = 0;
        this.alertCover = null;
        this.nav.reset();
      }
    }

    if (!this.alertMoveTarget && this.ctx && !this.alertCover) {
      this.alertCover = findAlertCover(this.ctx.colliders, this.body.px, this.body.pz, this.body.footY, { x: pos.x, z: pos.z });
    }
    this.setState(SuspectState.ALERT);
  }

  /** ENGAGE 中の視認喪失時に音イベントで最終把握位置(known)を更新する。 */
  onEngageNoise(pos: Vec3, kind: NoiseKind): void {
    if (this.state !== SuspectState.ENGAGE || this.sees) return;
    this.known = { x: pos.x, y: resolveFloorY(pos, this.ctx?.rooms, kind), z: pos.z };
  }

  /** プレイヤーを視認した。→CONFRONTATION */
  onSpotted(pos: Vec3): void {
    if (!this.canPerceive || this.blindLeft > 0) return;
    this.body.faceToward(pos.x, pos.z);
    this.known = { x: pos.x, y: pos.y, z: pos.z };
    const params = this.profile.ambush;
    if (this.isAmbushReady && params && this.morale.value >= this.profile.thresholds.hesitateBelow) {
      // 待ち伏せ成立: 警告の応酬（CONFRONTATION）を飛ばして即交戦し、初弾バーストは狙いが締まる
      this.engage?.armPreAim(params.firstBurstShots, params.firstBurstSpreadMul);
      this.setState(SuspectState.ENGAGE);
      return;
    }
    this.setState(SuspectState.CONFRONTATION);
  }

  /** 証拠品（落とした武器）が未回収のまま残っているか（投降・拘束後・無力化後いずれも対象） */
  get hasUncollectedEvidence(): boolean {
    return (
      !this.evidenceCollected &&
      (this.state === SuspectState.SURRENDER ||
        this.state === SuspectState.ARRESTED ||
        this.state === SuspectState.DOWN) &&
      this.body.getDroppedWeaponPos() !== null
    );
  }

  /** 証拠（落とした武器）を回収 */
  collectEvidence(): void {
    this.evidenceCollected = true;
    this.body.removeGun();
  }

  /** 偽装投降の確率（ai_profiles.json の fakeSurrenderChance）。容疑者モードの拘束判定が使う */
  get fakeSurrenderChance(): number {
    return this.combat?.fakeSurrenderChance ?? 0;
  }

  /** 拘束済み（手錠）か */
  get isRestrained(): boolean {
    return this.state === SuspectState.ARRESTED;
  }

  /**
   * 容疑者モード専用: 偽装投降の反撃。拘束に来た隊員の至近で武器を拾い直し、不意に撃つ（投降状態のみ・1 度きり）。
   * 続けて通常の交戦へ移る。
   */
  fakeSurrenderAttack(at: Vec3): boolean {
    if (!this.friendly || this.state !== SuspectState.SURRENDER) return false;
    this.fakeSurrenderChecked = true;
    this.known = { x: at.x, y: at.y, z: at.z };
    this.body.faceToward(at.x, at.z);
    this.morale.shift(Math.max(15, this.profile.thresholds.hesitateBelow + 12 - this.morale.value));
    this.prevMorale = this.morale.value;
    this.setState(SuspectState.ENGAGE);
    this.engage?.fireAt(null, this.known);
    return true;
  }

  /**
   * 容疑者モード専用: プレイヤーが拘束(ARRESTED)の味方を解放した。士気は降伏しきい値の少し上まで下がった状態で
   * 戦線に復帰し、まず遮蔽へ退避してから戦う（偽装投降の再抽選はしない）。
   */
  freeFromRestraint(): boolean {
    if (!this.friendly || this.state !== SuspectState.ARRESTED) return false;
    this.body.setRestrained(false);
    this.body.setTint(SUSPECT_COLOR);
    this.fakeSurrenderChecked = true;
    this.unwatchedSurrenderSec = 0;
    const th = this.profile.thresholds;
    this.morale.shift(th.surrenderBelow + FREED_MORALE_MARGIN - this.morale.value);
    this.prevMorale = this.morale.value;
    this.setState(SuspectState.ENGAGE);
    return true;
  }

  /** 拘束完了（SURRENDER のみ受理）。戻り値: 受理したか */
  get readyForArrest(): boolean {
    return this.state === SuspectState.SURRENDER && this.fsm.timeInState >= 0.8;
  }

  arrest(): boolean {
    if (!this.readyForArrest) return false;
    this.setState(SuspectState.ARRESTED);
    return true;
  }

  /**
   * 被弾（プレイヤーの射撃）。0 で DOWN。戻り値: 倒れたか。
   * 生存時は発砲を受けたとして ENGAGE へ（士気 < surrenderBelow なら SURRENDER）。ENGAGE 中は怯んで遮蔽へ退避。
   * SURRENDER / ARRESTED はダメージのみ（反応なし）。
   */
  takeHit(amount: number, shooterPos?: Vec3): boolean {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) {
      this.setState(SuspectState.DOWN);
      return true;
    }
    if (this.friendly) {
      // プレイヤーの流れ弾では仲間を敵に回さない。SWAT からの被弾だけ交戦に入る。
      const player = this.ctx?.player.position;
      const fromPlayer =
        !!shooterPos &&
        !!player &&
        Math.hypot(shooterPos.x - player.x, shooterPos.z - player.z) < 0.75 &&
        Math.abs(shooterPos.y - player.y) < 1.2;
      if (!fromPlayer && shooterPos && (this.managed || this.state === SuspectState.NEGOTIATION)) {
        this.known = { x: shooterPos.x, y: resolveFloorY(shooterPos, this.ctx?.rooms), z: shooterPos.z };
        this.body.faceToward(shooterPos.x, shooterPos.z);
        if (this.morale.value < this.profile.thresholds.surrenderBelow) {
          this.setState(SuspectState.SURRENDER);
        } else {
          this.setState(SuspectState.ENGAGE);
          this.engage?.onHit(this.known);
        }
      }
      return false;
    }
    if (!this.managed && this.state !== SuspectState.NEGOTIATION) return false;
    const at = shooterPos ?? this.ctx?.player.position;
    if (at) {
      this.known = { x: at.x, y: resolveFloorY(at, this.ctx?.rooms), z: at.z };
      this.body.faceToward(at.x, at.z);
    }
    if (this.morale.value < this.profile.thresholds.surrenderBelow) {
      this.setState(SuspectState.SURRENDER);
    } else {
      this.setState(SuspectState.ENGAGE);
      this.engage?.onHit(this.known);
    }
    return false;
  }

  /**
   * 非致死性命中（T3-7/T3-8）。HP は減らさず、士気を `nonlethalHit`(ai_profiles.json) × moraleScale 分下げて強制怯み。
   * 士気が降伏しきい値未満なら SURRENDER、それ以外は ENGAGE＋怯み(takeHit と同じ)。NEGOTIATION 中も中断する。
   * 終端・投降(SURRENDER/ARRESTED/DOWN)では何もしない。
   */
  takeNonlethalHit(shooterPos?: Vec3, moraleScale = 1): void {
    if (!this.alive || (!this.managed && this.state !== SuspectState.NEGOTIATION)) return;
    this.morale.apply('nonlethalHit', moraleScale);
    this.prevMorale = this.morale.value;
    const at = shooterPos ?? this.ctx?.player.position;
    if (at) {
      this.known = { x: at.x, y: resolveFloorY(at, this.ctx?.rooms), z: at.z };
      this.body.faceToward(at.x, at.z);
    }
    if (this.morale.value < this.profile.thresholds.surrenderBelow) {
      this.setState(SuspectState.SURRENDER);
      return;
    }
    if (this.state !== SuspectState.ENGAGE) this.setState(SuspectState.ENGAGE);
    this.engage?.onHit(this.known);
  }

  dispose(): void {
    this.body.dispose();
  }
}
