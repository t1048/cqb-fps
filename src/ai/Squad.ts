import { ScoutIntel } from './ScoutIntel';
import { refreshScoutIntel } from './squad/squadScout';
import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import { t } from '../core/i18n';
import type { InputManager } from '../core/InputManager';
import type {
  AllyDef,
  ArrestConfig,
  RoomDef,
  SquadConfig,
  SquadElement,
  SquadOrder,
  Vec3,
  WindowDef,
} from '../core/types';
import type { PlayerController } from '../player/PlayerController';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import { hasLineOfSight, type Flashbang } from '../weapons/Flashbang';
import type { TearGas } from '../weapons/TearGas';
import type { BlastVictim, DoorTrapSystem } from '../world/DoorTraps';
import type { AABB, Collider } from '../world/WorldBuilder';
import type { StairMark } from '../world/Walk';
import type { TextureLibrary } from '../world/Materials';
import type { DoorSystem } from '../world/Door';
import { AIDebugLabel } from '../ui/AIDebugLabel';
import { CommandMenu, type OrderContext } from '../ui/CommandMenu';
import type { FloorPlanAllyState, FloorPlanWaypoint } from '../ui/Minimap';
import {
  pickBestStair,
  SQUAD_GOAL_TOLERANCE,
  stairEntry,
  stairExit,
  stairExitReached,
  stairFloorY,
  stairRunTarget,
  reachableRouteLength,
  type StairChoice,
} from './SquadRoute';
import {
  EngageBehavior,
  SuspectNavigator,
  blockedAt,
  type AllyTarget,
  type CombatContext,
  type XZ,
} from './EngageBehavior';
import type { EntryMode } from './cqbEntry';
import { shieldBlocks } from './ShieldGuard';
import { HumanoidBody } from './HumanoidBody';
import type { EntityManager } from './EntityManager';
import {
  BASE_SHIELD_COMBAT,
  BASE_SHIELD_MOBILITY,
  BASE_SWAT_COMBAT,
  BASE_SWAT_MOBILITY,
  SWAT_HP,
  SWAT_READY_POSE,
  SWAT_UNIFORM_COLOR,
  cloneCombatProfile,
  cloneMobilityProfile,
  isShieldRole,
} from './SwatProfile';
import { TacticalOptics } from './TacticalOptics';
import {
  ARRIVE_HYST,
  FOLLOW_GOAL_TAU,
  FOLLOW_START_DIST,
  FOLLOW_STOP_DIST,
  MAX_DT,
  MOVE_DECEL,
  assignElement,
  isOrderLockedForAutonomousMove,
  isRoomConfined,
  type AllyUnit,
  type C2BlastFx,
  type Cell,
  type DoorCheckResult,
  type PortalGroup,
  type SquadContext,
  type SquadRosterEntry,
  type ThrownFlash,
} from './squad/squadTypes';
import {
  applySeparation,
  computeFollowGoal,
  holdLook,
  navigateTo,
  updateFollowHeading,
} from './squad/squadMovement';
import {
  holdAtPod,
  updateC2Blasts,
  updateC2PlantPhase,
  updateC2StandoffPhase,
  updateDoorPrepPhase,
  updateEnteringPhase,
  updateFlashWaitPhase,
  updateGasWaitPhase,
  updatePieingPhase,
  updatePortalGroups,
  updateStackingPhase,
  updateThrownFlashes,
} from './squad/squadEntry';
import {
  assignPostClearTask,
  beginPostClearSweep as beginPostClearSweepImpl,
  isIdleForPostSweep,
  setPostClearActive as setPostClearActiveImpl,
  updateCoverage,
  updateRestraining,
  updateSweeping,
} from './squad/squadClearing';
import {
  checkWeaknessRush,
  createAllyEngageBus,
  hostileSuspectTargetsFor,
  onFlashDetonated,
  onHit,
  tryEngage,
  tryWarn,
  updateAllyFootstep,
  updateAllyLean,
  updateAllyOptics,
  updateMuzzleDiscipline,
  updatePincerFlank,
  updateRoomCoverHold,
  updateRush,
} from './squad/squadCombat';
import {
  elementLabelText,
  emitRadio as emitRadioImpl,
  emitRadioNow,
  executeOrder as executeOrderImpl,
  getRoster as getRosterImpl,
  handleShortcuts,
  hudText as hudTextImpl,
  quickOrderHint as quickOrderHintImpl,
  resetUnitForOrder as resetUnitForOrderImpl,
  stateText,
  toggleEntryMode as toggleEntryModeImpl,
  updateMarkers,
} from './squad/squadOrders';

export {
  SQUAD_GOAL_TOLERANCE,
  stairEntry,
  stairExit,
  stairFloorY,
  stairExitReached,
  reachableRouteLength,
  pickBestStair,
  stairRunTarget,
  type StairChoice,
  assignElement,
  type Cell,
  type SquadRosterEntry,
};

/**
 * CQB 分隊AI + 隊長指揮システム（Facade）。
 * - 指示系統: GOLD(全員) / ALPHA(Miller) / BRAVO(Cole)
 * - 容疑者モード SWAT 隊員と同一の装備・コンディション・戦術・光学・音響パリティを共有
 * - 各戦術ロジックは `src/ai/squad/*` へ責務分割し、本クラスは状態保持と委譲を担う
 */
export class SquadSystem implements SquadContext {
  readonly coverage: Cell[] = [];
  readonly cellsByRoom = new Map<string, Cell[]>();
  sampleTimer = 0;
  /** 視認セル判定の巡回位置（毎フレーム一部ずつ処理する） */
  coverageCursor = 0;
  doorStages = '';
  ack = '';
  ackLeft = 0;
  selectedElement: SquadElement = 'gold';
  postClearActive = false;
  postClearAnnounced = false;

  readonly root = new THREE.Group();
  readonly allies: AllyUnit[] = [];
  readonly provoked = new Set<string>();
  readonly announcedRooms = new Set<string>();
  readonly announcedStacks = new Set<string>();
  private readonly unsubs: (() => void)[] = [];
  private readonly livingAlliesBuf: (AllyTarget & { shieldBlocks(from: Vec3, hit: Vec3): boolean })[] = [];
  private readonly coverEyeTmp = new THREE.Vector3();
  private readonly sightGazeTmp = new THREE.Vector3();
  private readonly labelChestTmp: Vec3 = { x: 0, y: 0, z: 0 };
  readonly menu: CommandMenu;

  readonly thrownFlashes: ThrownFlash[] = [];
  readonly flashGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.13, 10);
  readonly flashMat = new THREE.MeshStandardMaterial({ color: 0x3b4d6b, roughness: 0.55 });
  readonly burstMesh: THREE.Mesh;
  burstLife = 0;
  readonly c2Blasts: C2BlastFx[] = [];
  readonly flashbang?: Flashbang;
  readonly tearGas?: TearGas;
  readonly windows: readonly WindowDef[];
  readonly intel: ScoutIntel;
  readonly traps: DoorTrapSystem | null;
  readonly doorChecks = new Map<string, DoorCheckResult>();
  readonly trapSpotRolled = new Set<string>();
  rand?: () => number;
  private intelTimer = 0;

  /** 分隊の閃光弾・CS ガスの残数（squad.json の inventory から。補充なし） */
  /** 隊員数に応じて増やした初期携行数 */
  readonly inventory: { flashbang: number; gas: number };
  flashesLeft = 0;
  gasLeft = 0;
  rushCd = 0;
  pincerCd = 0;
  contactRadioCd = 0;
  pepperRadioCd = 0;
  coverRadioCd = 0;
  lockedDoorsEncountered = 0;
  readonly recentlyPeppered = new Map<string, number>();
  readonly radioQueue: { ally: AllyUnit; text: string; voiceText?: string }[] = [];
  radioSpeakGap = 0;
  readonly muzzleOriginTmp: Vec3 = { x: 0, y: 0, z: 0 };
  readonly muzzleDirTmp: Vec3 = { x: 0, y: 0, z: -1 };
  simTime = 0;
  followHeading: XZ = { x: 0, z: -1 };
  lastPlayerPos: XZ = { x: 0, z: 0 };
  readonly portalGroups = new Map<string, PortalGroup>();
  /** 突入モード: dynamic = ダイナミック強行突入, stealth = ステルス慎重突入（Tab 切替） */
  entryMode: EntryMode = 'dynamic';
  quickHintCache = '';
  quickHintTimer = 0;
  disposed = false;

  constructor(
    defs: readonly AllyDef[],
    readonly cfg: SquadConfig,
    readonly player: PlayerController,
    readonly input: InputManager,
    readonly colliders: readonly Collider[],
    readonly bounds: { width: number; depth: number },
    readonly stairs: readonly StairMark[],
    readonly doors: DoorSystem,
    readonly entities: EntityManager,
    readonly bus: GameEventBus,
    textures: TextureLibrary,
    readonly weapons: WeaponSystem,
    readonly flash: { range: number; blindSec: number },
    readonly rooms: readonly RoomDef[],
    readonly arrestCfg: ArrestConfig,
    gadgets?: {
      flashbang?: Flashbang;
      tearGas?: TearGas;
      windows?: readonly WindowDef[];
      intel?: ScoutIntel;
      traps?: DoorTrapSystem | null;
    },
  ) {
    this.intel = gadgets?.intel ?? new ScoutIntel();
    this.traps = gadgets?.traps ?? null;
    this.inventory = scaleInventory(cfg.inventory, defs.length);
    this.flashesLeft = this.inventory.flashbang;
    this.gasLeft = this.inventory.gas;
    this.flashbang = gadgets?.flashbang;
    this.tearGas = gadgets?.tearGas;
    this.windows = gadgets?.windows ?? [];
    if (defs.length > 0) {
      for (const room of this.rooms) {
        if (room.outdoor) continue;
        const y = room.floorY ?? 0;
        const roomCells: Cell[] = [];
        for (let x = room.x - room.width / 2 + 0.25; x < room.x + room.width / 2; x += 0.5) {
          for (let z = room.z - room.depth / 2 + 0.25; z < room.z + room.depth / 2; z += 0.5) {
            if (!blockedAt(this.colliders, x, z, 0.04, y)) {
              const cell: Cell = { x, z, y, room, seen: false, visible: false };
              this.coverage.push(cell);
              roomCells.push(cell);
            }
          }
        }
        this.cellsByRoom.set(room.id, roomCells);
      }
    }

    this.root.name = 'squad';
    const yaw0 = Number.isFinite(player.yawRad) ? player.yawRad : 0;
    this.followHeading = { x: -Math.sin(yaw0), z: -Math.cos(yaw0) };
    this.lastPlayerPos = { x: player.position.x, z: player.position.z };
    this.menu = new CommandMenu(cfg, player, doors, colliders, entities, rooms);
    this.menu.setGearProvider({
      gear: () => ({ flash: this.flashesLeft, gas: this.gasLeft }),
      trapKnown: (doorId) => this.traps?.isDiscovered(doorId) === true,
    });
    this.root.add(this.menu.root);

    this.input.onOrderMenu = (event, value) => {
      this.menu.handleMenuEvent(event, value, this.selectedElement, (order, ctx) => {
        this.executeOrder(order, ctx);
      });
    };
    this.unsubs.push(() => {
      this.input.onOrderMenu = undefined;
    });

    defs.forEach((def, index) => {
      const shielded = isShieldRole(index, defs.length);
      const combat = cloneCombatProfile(shielded ? BASE_SHIELD_COMBAT : BASE_SWAT_COMBAT);
      const mobility = cloneMobilityProfile(shielded ? BASE_SHIELD_MOBILITY : BASE_SWAT_MOBILITY);
      const body = new HumanoidBody(def.x, def.z, def.yaw ?? 0, SWAT_UNIFORM_COLOR, true, {
        role: 'ally',
        footY: def.y ?? 0,
        textures,
        shield: shielded,
      });
      body.ground = this.colliders;
      body.setReadyPose(SWAT_READY_POSE);
      const label = new AIDebugLabel();
      const optics = new TacticalOptics();
      // 隊員を前半 ALPHA / 後半 BRAVO の 2 チームに均等分割（4 名なら 2+2、3 名なら 2+1）
      const { elementKey, callsign } = assignElement(index, defs.length);

      const allyCtx: CombatContext = {
        player: this.player,
        colliders: this.colliders,
        doors: this.doors,
        bounds: this.bounds,
        stairs: this.stairs,
        rooms: this.rooms,
        ignorePlayer: true,
        allies: () => hostileSuspectTargetsFor(this, ally),
      };
      const nav = new SuspectNavigator(body, allyCtx);
      const engageBus = createAllyEngageBus(this, shielded);
      const eyeScratch = new THREE.Vector3();
      const chestScratch: Vec3 = { x: 0, y: 0, z: 0 };
      const aabbScratch: AABB = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
      const targetWrapper: AllyTarget & { shieldBlocks(from: Vec3, hit: Vec3): boolean } = {
        id: def.id,
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
      const ally: AllyUnit = {
        id: def.id,
        name: def.name,
        callsign,
        elementKey,
        index,
        roleIndex: index,
        groupSize: defs.length,
        shielded,
        combat,
        mobility,
        body,
        nav,
        engage: null as unknown as EngageBehavior,
        optics,
        order: 'follow',
        phase: 'follow',
        holdPos: null,
        moveTarget: null,
        watchYaw: (def.yaw ?? 0) * (Math.PI / 180),
        approach: 1,
        door: null,
        entryPortal: null,
        stackPos: null,
        podPos: null,
        podLook: null,
        targetRoom: null,
        entryDelay: 0,
        phaseTimer: 0,
        doorWait: 0,
        flashed: false,
        gassed: false,
        path: [],
        pathGoal: null,
        retry: 0,
        entered: false,
        sweepCell: null,
        vantage: null,
        skipped: new Set(),
        sweepElapsed: 0,
        assignment: null,
        restrainTargetId: null,
        holdTime: 0,
        fireCd: 0,
        warnCd: 0,
        hp: SWAT_HP,
        maxHp: SWAT_HP,
        wounded: false,
        down: false,
        engaging: false,
        engageActive: false,
        holdingFire: false,
        known: null,
        sees: false,
        threat: null,
        lostSec: 0,
        suppressCd: 0,
        pepperTarget: null,
        pepperCd: 0,
        flinchLeft: 0,
        blindLeft: 0,
        rushTimer: 0,
        rushTarget: null,
        rushFireCd: 0,
        pincerTarget: null,
        pincerTimer: 0,
        c2Timer: 0,
        c2BeepTimer: 0,
        c2Side: 1,
        c2Standoff: null,
        c2IsLead: false,
        stepAccum: 0,
        lastStepX: body.px,
        lastStepZ: body.pz,
        prevEngageLabel: '',
        progress: t('追従中', 'Following'),
        stalled: 0,
        stuckStage: 0,
        anchor: { x: body.px, z: body.pz },
        doorOpenTimer: 0,
        doorOpenTargetId: null,
        skippedDoors: new Map(),
        stackWaitTimer: 0,
        activeStair: null,
        stairPick: null,
        vel: { x: 0, z: 0 },
        navThisFrame: false,
        settled: false,
        entryPlan: null,
        entryOrder: index,
        slotIndex: -1,
        entryWp: 0,
        entryStartT: -1,
        entryCrossT: -1,
        entryGateWait: 0,
        entryThreatLook: null,
        lookKey: '',
        lookKeyT: 0,
        followGoal: null,
        idleLook: null,
        dodge: null,
        securedLookSet: false,
        securedTurnRate: Math.PI * 1.4,
        podReturnT: 0,
        coverHold: null,
        holdingFireSec: 0,
        stepOutPos: null,
        pieSteps: [],
        pieIdx: 0,
        pieHold: 0,
        pieElapsed: 0,
        peekHold: 0,
        peekDone: false,
        stealthEntry: false,
        sweepRetryCd: 0,
        mirrorLeft: 0,
        mirrorStarted: false,
        checkLeft: 0,
        checkStarted: false,
        disarmLeft: 0,
        disarmStarted: false,
        targetWrapper,
        label,
        getAABB: () => body.getAABB(),
        shieldBlocks: (from, hit) => shieldBlocks(body, from, hit),
      };
      ally.engage = new EngageBehavior(
        combat,
        def.id,
        body,
        engageBus,
        allyCtx,
        () => true,
        mobility,
        nav,
        {
          immediateFireOnEnter: true,
          immediateFireShots: 3,
          skipRetreatOnHit: () =>
            ally.shielded ||
            ally.rushTimer > 0 ||
            ally.order === 'hold' ||
            ally.order === 'overwatch' ||
            isRoomConfined(ally),
        },
      );
      this.allies.push(ally);
      this.root.add(body.group, label.sprite, optics.group);
      this.weapons.addTarget(ally);
    });

    const burstGeo = new THREE.SphereGeometry(0.45, 10, 8);
    const burstMat = new THREE.MeshBasicMaterial({ color: 0xfff8dc, transparent: true, opacity: 0.9, depthWrite: false });
    this.burstMesh = new THREE.Mesh(burstGeo, burstMat);
    this.burstMesh.visible = false;
    this.root.add(this.burstMesh);

    this.unsubs.push(
      bus.on('entityHit', (e) => onHit(this, e.targetId, e.damage, e.nonlethal === true, e.pos.y, e.shooter)),
      bus.on('suspectFired', (e) => {
        this.provoked.add(e.id);
        for (const ally of this.allies) {
          if (ally.down || ally.blindLeft > 0 || ally.sees) continue;
          const d = Math.hypot(ally.body.px - e.pos.x, ally.body.pz - e.pos.z);
          if (d <= ally.combat.engageRange) {
            ally.known = { x: e.pos.x, y: Math.max(0, e.pos.y - 1.2), z: e.pos.z };
            if (!ally.engageActive) ally.lostSec = Math.max(ally.lostSec, 0.4);
          }
        }
      }),
      bus.on('flashDetonated', (e) => onFlashDetonated(this, e)),
    );
  }

  get count(): number {
    return this.allies.length;
  }

  get currentElement(): SquadElement {
    return this.selectedElement;
  }

  get elementLabel(): string {
    return elementLabelText(this.cfg, this.selectedElement);
  }

  /** 交渉等を含め、指定点へ視線が通り威圧距離内にいる生存隊員数（チーム数値優位計算用）。 */
  countAlliesCovering(point: Vec3, maxDist = 10): number {
    let n = 0;
    const eye = this.coverEyeTmp;
    for (const a of this.allies) {
      if (a.down) continue;
      a.body.eye(eye);
      const d = Math.hypot(point.x - eye.x, point.z - eye.z);
      if (d <= maxDist && Math.abs(point.y - eye.y) < 2.2 && hasLineOfSight(this.colliders, eye, point)) {
        n++;
      }
    }
    return n;
  }

  /**
   * ミニマップ用: いずれかの生存隊員の視界（前方コーン＋視線）に point が入っているか。
   * 判定は制圧セルの可視判定（squadClearing）と同じ前方コーン（cos≒0.45）に揃える。
   */
  allySeesPoint(point: Vec3, maxDist = 30): boolean {
    const eye = this.coverEyeTmp;
    const dir = this.sightGazeTmp;
    for (const a of this.allies) {
      if (a.down || a.blindLeft > 0) continue;
      a.body.eye(eye);
      const dx = point.x - eye.x;
      const dz = point.z - eye.z;
      const hDist = Math.hypot(dx, dz);
      if (hDist > maxDist || Math.abs(point.y - eye.y) > 2.2) continue;
      a.body.gaze(dir);
      const fLen = Math.hypot(dir.x, dir.z) || 1;
      if (hDist > 0.5 && dx * dir.x + dz * dir.z < hDist * fLen * 0.45) continue;
      if (hasLineOfSight(this.colliders, eye, point)) return true;
    }
    return false;
  }

  /** 視線が通る生存隊員の情報一覧（敵AI知覚・射撃ターゲット用）。 */
  getLivingAllies(): readonly {
    id: string;
    px: number;
    pz: number;
    footY: number;
    height: number;
    getEye(): Vec3;
    getChest(): Vec3;
    getAABB(): ReturnType<HumanoidBody['getAABB']>;
    shieldBlocks(from: Vec3, hit: Vec3): boolean;
  }[] {
    this.livingAlliesBuf.length = 0;
    for (let i = 0; i < this.allies.length; i++) {
      const a = this.allies[i]!;
      if (!a.down) this.livingAlliesBuf.push(a.targetWrapper);
    }
    return this.livingAlliesBuf;
  }

  getRoster(): SquadRosterEntry[] {
    return getRosterImpl(this);
  }

  /** HUD 用: 分隊の携行数（残り / 初期） */
  getGear(): { flash: number; flashMax: number; gas: number; gasMax: number } {
    return {
      flash: this.flashesLeft,
      flashMax: this.inventory.flashbang,
      gas: this.gasLeft,
      gasMax: this.inventory.gas,
    };
  }

  /** ブービートラップの爆風を受ける隊員（生存中） */
  trapVictims(): BlastVictim[] {
    const out: BlastVictim[] = [];
    for (const a of this.allies) {
      if (a.down) continue;
      out.push({
        chest: () => {
          const c = a.body.chestPos(this.labelChestTmp);
          return { x: c.x, y: c.y, z: c.z };
        },
        hurt: (dmg) => {
          onHit(this, a.id, dmg, false, undefined, 'trap');
          a.blindLeft = Math.max(a.blindLeft, 0.8);
        },
      });
    }
    return out;
  }

  getMinimapAllies(): FloorPlanAllyState[] {
    return this.allies.map((a) => ({
      name: a.name,
      x: a.body.px,
      z: a.body.pz,
      y: a.body.footY,
      yawRad: a.body.yawRad,
      down: a.down,
    }));
  }

  getMinimapWaypoints(): FloorPlanWaypoint[] {
    const out: FloorPlanWaypoint[] = [];
    for (const a of this.allies) {
      if (a.down || a.order !== 'move' || !a.moveTarget) continue;
      out.push({
        label: a.callsign.slice(0, 1),
        x: a.moveTarget.x,
        z: a.moveTarget.z,
        y: a.moveTarget.y,
        color: a.elementKey === 'alpha' ? '#56c8d8' : '#6be08b',
      });
    }
    return out;
  }

  hudText(): string {
    return hudTextImpl(this);
  }

  /** 全脅威制圧後に呼び出し、残っている投降容疑者・民間人・証拠武器を隊員が自律確保する。 */
  setPostClearActive(active: boolean): void {
    setPostClearActiveImpl(this, active);
  }

  beginPostClearSweep(): void {
    beginPostClearSweepImpl(this);
  }

  getEntryMode(): EntryMode {
    return this.entryMode;
  }

  setEntryMode(mode: EntryMode): void {
    this.entryMode = mode;
  }

  toggleEntryMode(): EntryMode {
    return toggleEntryModeImpl(this);
  }

  /** 画面下部に出す「Z : 〜〜」の文言。指示不可の状況では空文字。 */
  quickOrderHint(dt: number): string {
    return quickOrderHintImpl(this, dt);
  }

  executeOrder(order: SquadOrder, ctx: OrderContext): void {
    executeOrderImpl(this, order, ctx);
  }

  emitRadio(ally: AllyUnit, text: string, voiceText?: string): void {
    emitRadioImpl(this, ally, text, voiceText);
  }

  resetUnitForOrder(ally: AllyUnit, order: SquadOrder): void {
    resetUnitForOrderImpl(ally, order);
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);

    handleShortcuts(this);
    updateCoverage(this, dt);
    updateThrownFlashes(this, dt);
    updateC2Blasts(this, dt);
    updateMarkers(this);
    this.simTime += dt;
    updateFollowHeading(this, dt);
    updatePortalGroups(this, dt);
    this.intelTimer -= dt;
    if (this.intelTimer <= 0) {
      this.intelTimer = 0.5;
      refreshScoutIntel(this);
    }

    this.ackLeft = Math.max(0, this.ackLeft - dt);
    this.rushCd = Math.max(0, this.rushCd - dt);
    this.pincerCd = Math.max(0, this.pincerCd - dt);
    this.contactRadioCd = Math.max(0, this.contactRadioCd - dt);
    this.pepperRadioCd = Math.max(0, this.pepperRadioCd - dt);
    this.coverRadioCd = Math.max(0, this.coverRadioCd - dt);
    for (const [id, left] of this.recentlyPeppered) {
      if (left - dt <= 0) this.recentlyPeppered.delete(id);
      else this.recentlyPeppered.set(id, left - dt);
    }
    this.radioSpeakGap = Math.max(0, this.radioSpeakGap - dt);
    if (this.radioSpeakGap <= 0 && this.radioQueue.length > 0) {
      const next = this.radioQueue.shift()!;
      emitRadioNow(this, next.ally, next.text, next.voiceText);
    }

    if (this.burstLife > 0) {
      this.burstLife -= dt;
      const mat = this.burstMesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, this.burstLife / 0.35);
      this.burstMesh.scale.setScalar(1 + (1 - Math.max(0, this.burstLife / 0.35)) * 1.4);
      this.burstMesh.visible = this.burstLife > 0;
    }

    for (const ally of this.allies) {
      ally.body.tick(dt);
      ally.navThisFrame = false;
      ally.fireCd = Math.max(0, ally.fireCd - dt);
      ally.warnCd = Math.max(0, ally.warnCd - dt);
      ally.doorWait = Math.max(0, ally.doorWait - dt);
      ally.suppressCd = Math.max(0, ally.suppressCd - dt);
      ally.pepperCd = Math.max(0, ally.pepperCd - dt);
      ally.sweepRetryCd = Math.max(0, ally.sweepRetryCd - dt);
      for (const [doorId, left] of ally.skippedDoors) {
        if (left - dt <= 0) ally.skippedDoors.delete(doorId);
        else ally.skippedDoors.set(doorId, left - dt);
      }
      if (!ally.down) {
        if (ally.flinchLeft > 0) {
          ally.flinchLeft = Math.max(0, ally.flinchLeft - dt);
          if (ally.flinchLeft <= 0) ally.body.setFlash(false);
        }
        if (ally.blindLeft > 0) {
          ally.vel.x = 0;
          ally.vel.z = 0;
          ally.blindLeft = Math.max(0, ally.blindLeft - dt);
          ally.body.setPose('crouch');
          ally.body.setShake(Math.sin(ally.blindLeft * 26) * 0.12);
          ally.optics.hide();
          if (ally.blindLeft <= 0) {
            ally.body.setShake(0);
            ally.body.setPose('stand');
          }
        } else {
          if (this.postClearActive && isIdleForPostSweep(this, ally)) {
            assignPostClearTask(this, ally);
          }
          tryEngage(this, ally, dt);
          if (!ally.engaging) tryWarn(this, ally);
          this.updateAllyTactics(ally, dt);
          if (!ally.navThisFrame) {
            const spd = Math.hypot(ally.vel.x, ally.vel.z);
            if (spd > 1e-4) {
              const next = Math.max(0, spd - MOVE_DECEL * dt);
              const k = next / spd;
              ally.vel.x *= k;
              ally.vel.z *= k;
            } else {
              ally.vel.x = 0;
              ally.vel.z = 0;
            }
          }
          applySeparation(this, ally, dt);
          updateMuzzleDiscipline(this, ally);
          updateAllyLean(this, ally);
          updateAllyOptics(this, ally);
          updateAllyFootstep(this, ally);
        }
      } else {
        ally.vel.x = 0;
        ally.vel.z = 0;
        ally.body.setLean(0);
        ally.optics.hide();
      }
      const c = ally.body.chestPos(this.labelChestTmp);
      ally.label.sprite.position.set(c.x, ally.body.footY + ally.body.height + 0.28, c.z);
      const distance = this.player.position.distanceTo(ally.body.group.position);
      const labelWidth = Math.min(0.78, Math.max(0.32, distance * 0.085));
      ally.label.sprite.scale.set(labelWidth, labelWidth / 4, 1);
      ally.label.set(`${ally.name} ${stateText(ally)}`, ally.down ? '#888888' : '#9fd0ff');
    }

    checkWeaknessRush(this);
  }

  private updateAllyTactics(ally: AllyUnit, dt: number): void {
    const body = ally.body;
    body.setReadyPose(SWAT_READY_POSE);

    // 弱点トリガーによる突撃（ラッシュ）中
    if (ally.rushTimer > 0 && !isOrderLockedForAutonomousMove(ally)) {
      updateRush(this, ally, dt);
      return;
    }

    // 挟撃（ピンサー機動）の迂回移動中
    if (ally.pincerTarget && !ally.sees && !isOrderLockedForAutonomousMove(ally)) {
      updatePincerFlank(this, ally, dt);
      return;
    }

    // EngageBehavior が遮蔽移動・ピーク・再配置中のときは追従移動と競合させない
    if (
      ally.engageActive &&
      !isOrderLockedForAutonomousMove(ally) &&
      !isRoomConfined(ally) &&
      (ally.phase === 'follow' || ally.phase === 'move' || ally.phase === 'secured') &&
      (ally.engage.label === 'toCover' ||
        ally.engage.label === 'toPeek' ||
        ally.engage.label === 'advance' ||
        ally.engage.label === 'flank')
    ) {
      return;
    }

    if (
      isRoomConfined(ally) &&
      (ally.phase === 'sweeping' || ally.phase === 'secured' || (ally.phase === 'entering' && ally.entered))
    ) {
      if (updateRoomCoverHold(this, ally, dt)) return;
    } else if (ally.coverHold) {
      ally.coverHold = null;
    }

    switch (ally.phase) {
      case 'follow': {
        const raw = computeFollowGoal(this, ally);
        // 目標点の低域通過（プレイヤーの微小移動・隊形候補の切替で目標が跳ばない）。大きく離れたら即追従
        const fg = ally.followGoal;
        if (!fg || Math.hypot(raw.x - fg.x, raw.z - fg.z) > 3.0 || Math.abs(raw.y - body.footY) > 0.75) {
          ally.followGoal = { x: raw.x, z: raw.z };
        } else {
          const k = 1 - Math.exp(-dt / FOLLOW_GOAL_TAU);
          fg.x += (raw.x - fg.x) * k;
          fg.z += (raw.z - fg.z) * k;
        }
        const goal = ally.followGoal!;
        if (ally.dodge) {
          // プレイヤー射線から退避中は退避位置を保持（applySeparation が移動を担当）
          ally.progress = t('射線退避', 'Clearing Line of Fire');
          return;
        }
        const dist = Math.hypot(goal.x - body.px, goal.z - body.pz);
        const sameFloor = Math.abs(raw.y - body.footY) < 0.4;
        // ヒステリシス: 停止 0.4 / 再始動 0.9
        if (ally.settled) {
          if (dist > FOLLOW_START_DIST || !sameFloor) ally.settled = false;
        } else if (dist <= FOLLOW_STOP_DIST && sameFloor) {
          ally.settled = true;
          ally.idleLook = null;
        }
        if (ally.settled) {
          ally.stalled = 0;
          ally.stuckStage = 0;
          ally.anchor = { x: body.px, z: body.pz };
          ally.progress = t('隊列待機', 'Holding Formation');
          if (!ally.idleLook) {
            // 停止中の視線: 2名以上なら最後尾は後方警戒（360°セキュリティ）、前方はプレイヤー向き±0.42 に固定
            let aliveCount = 0;
            let lastAlive: AllyUnit | null = null;
            for (let i = 0; i < this.allies.length; i++) {
              const a = this.allies[i]!;
              if (!a.down) {
                aliveCount++;
                lastAlive = a;
              }
            }
            const isRearGuard = aliveCount >= 2 && lastAlive === ally;
            const sideAngle = isRearGuard
              ? this.player.yawRad + Math.PI
              : this.player.yawRad + (ally.index % 2 === 0 ? 0.42 : -0.42);
            ally.idleLook = {
              x: body.px - Math.sin(sideAngle) * 4,
              y: body.footY + 1.45,
              z: body.pz - Math.cos(sideAngle) * 4,
            };
          }
          const mode = holdLook(ally, 'idle', dt);
          if (!ally.engaging && mode === 'idle') {
            body.aimAt(ally.idleLook.x, ally.idleLook.y, ally.idleLook.z, dt, Math.PI * 1.6 * dt);
          }
        } else {
          const mode = holdLook(ally, 'travel', dt);
          navigateTo(this, ally, goal.x, goal.z, raw.y, dt, true, mode === 'travel');
          if (mode !== 'travel' && ally.idleLook && !ally.engaging) {
            body.aimAt(ally.idleLook.x, ally.idleLook.y, ally.idleLook.z, dt, Math.PI * 1.6 * dt);
          }
          ally.progress = t('追従中', 'Following');
        }
        return;
      }

      case 'hold': {
        ally.progress = t('現在地警戒', 'Holding Position');
        if (!ally.engaging) {
          const lx = body.px - Math.sin(ally.watchYaw) * 4;
          const lz = body.pz - Math.cos(ally.watchYaw) * 4;
          body.aimAt(lx, body.footY + 1.42, lz, dt, Math.PI * 1.4 * dt);
        }
        return;
      }

      case 'overwatch': {
        ally.progress = t('射線ロック中', 'Holding Security');
        if (!ally.engaging) {
          const lx = body.px - Math.sin(ally.watchYaw) * 6;
          const lz = body.pz - Math.cos(ally.watchYaw) * 6;
          body.aimAt(lx, body.footY + 1.42, lz, dt, Math.PI * 2 * dt);
        }
        return;
      }

      case 'move': {
        const mt = ally.moveTarget;
        if (!mt) {
          ally.phase = 'hold';
          return;
        }
        const d = Math.hypot(mt.x - body.px, mt.z - body.pz);
        const sameFloor = Math.abs(mt.y - body.footY) < 0.4;
        if (ally.settled) {
          if (!sameFloor || d > this.cfg.arriveDistance + ARRIVE_HYST) ally.settled = false;
        } else if (sameFloor && d <= this.cfg.arriveDistance) {
          ally.settled = true;
        }
        if (!ally.settled) {
          ally.progress = t('指定位置へ移動中', 'Moving to Position');
          navigateTo(this, ally, mt.x, mt.z, mt.y, dt, true, true);
        } else {
          ally.progress = t('指定位置で警戒中', 'Covering Position');
          if (!ally.engaging) {
            const lx = body.px - Math.sin(ally.watchYaw) * 5;
            const lz = body.pz - Math.cos(ally.watchYaw) * 5;
            body.aimAt(lx, body.footY + 1.42, lz, dt, Math.PI * 1.6 * dt);
          }
        }
        return;
      }

      case 'stacking':
        updateStackingPhase(this, ally, dt);
        return;

      case 'door_prep':
        updateDoorPrepPhase(this, ally, dt);
        return;

      case 'pieing':
        updatePieingPhase(this, ally, dt);
        return;

      case 'c2_plant':
        updateC2PlantPhase(this, ally, dt);
        return;

      case 'c2_standoff':
        updateC2StandoffPhase(this, ally, dt);
        return;

      case 'flash_wait':
        updateFlashWaitPhase(this, ally, dt);
        return;

      case 'gas_wait':
        updateGasWaitPhase(this, ally, dt);
        return;

      case 'entering':
        updateEnteringPhase(this, ally, dt);
        return;

      case 'sweeping':
        updateSweeping(this, ally, dt);
        return;

      case 'restraining':
        updateRestraining(this, ally, dt);
        return;

      case 'secured': {
        ally.progress = t('室確保・警戒中', 'Room Secured');
        // 位置は PoD 固定（離れていれば戻る。静止中は分離力もほぼ無効）
        const portal = ally.entryPortal;
        if (!ally.engaging && portal) holdAtPod(this, ally, portal, dt);
        if (!ally.engaging && ally.podLook) {
          body.aimAt(ally.podLook.x, ally.podLook.y, ally.podLook.z, dt, ally.securedTurnRate * dt);
        }
        return;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.menu.dispose();
    for (const f of this.thrownFlashes) this.root.remove(f.mesh);
    this.thrownFlashes.length = 0;
    for (const b of this.c2Blasts) {
      this.root.remove(b.mesh);
      (b.mesh.material as THREE.Material).dispose();
    }
    this.c2Blasts.length = 0;
    this.livingAlliesBuf.length = 0;
    this.cellsByRoom.clear();
    this.radioQueue.length = 0;
    this.radioSpeakGap = 0;
    this.flashGeo.dispose();
    this.flashMat.dispose();
    for (const ally of this.allies) {
      if (ally.engageActive) {
        ally.engage.exit();
        ally.engageActive = false;
      }
      this.weapons.removeTarget(ally);
      ally.optics.dispose();
      ally.label.dispose();
      ally.body.dispose();
    }
    this.allies.length = 0;
    this.burstMesh.geometry.dispose();
    const mat = this.burstMesh.material;
    if (mat instanceof THREE.Material) mat.dispose();
    this.root.removeFromParent();
  }
}

/** squad.json の inventory は 4 人編成の基準数。人数が増えた分だけ比例して増やす（減らさない）。 */
export const INVENTORY_BASE_MEMBERS = 4;
export function scaleInventory(
  inv: { flashbang: number; gas: number },
  members: number,
): { flashbang: number; gas: number } {
  const k = Math.max(1, members / INVENTORY_BASE_MEMBERS);
  return { flashbang: Math.ceil(inv.flashbang * k), gas: Math.ceil(inv.gas * k) };
}
