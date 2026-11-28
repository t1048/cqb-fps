import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createGameEventBus, type GameEventBus } from '../../../src/core/events';
import type {
  AIProfile,
  AllyDef,
  CombatParams,
  DoorConfig,
  DoorDef,
  EntityDef,
  MapData,
  MobilityParams,
  PerceptionConfig,
  PlayerConfig,
  RoeConfig,
  SquadConfig,
  SquadElement,
  SquadOrder,
  Vec3,
  WindowDef,
} from '../../../src/core/types';
import type { InputManager, OrderMenuEvent } from '../../../src/core/InputManager';
import {
  validateAIProfiles,
  validatePerception,
  validatePlayerConfig,
  validateRoe,
  validateSquad,
} from '../../../src/core/DataLoader';
import { AudioBridge, type AudioBridgeSink } from '../../../src/core/AudioBridge';
import type { PlayerController } from '../../../src/player/PlayerController';
import type { WeaponSystem } from '../../../src/weapons/WeaponSystem';
import { Flashbang } from '../../../src/weapons/Flashbang';
import { TearGas } from '../../../src/weapons/TearGas';
import { FlashOverlay } from '../../../src/ui/FlashOverlay';
import { Subtitle } from '../../../src/ui/Subtitle';
import { EntityManager } from '../../../src/ai/EntityManager';
import { SquadSystem } from '../../../src/ai/Squad';
import { RoE } from '../../../src/rules/RoE';
import { Door, type DoorSystem } from '../../../src/world/Door';
import { DoorTrapSystem } from '../../../src/world/DoorTraps';
import { WorldBuilder, type Collider } from '../../../src/world/WorldBuilder';
import type { SwatSpawn } from '../../../src/modes/SwatTeam';
import { installDomShim, restoreDomShim, type DomShimHandle, type FakeElement } from './domShim';
import {
  buildHeadlessWorld,
  createStubTextures,
  generateRealMap,
  loadDoorConfig,
  loadWeaponsData,
  makeSingleRoomMap,
  makeTwoDoorHouseMap,
  makeWindowedSiegeMap,
  type HeadlessWorld,
} from './headlessWorld';
import {
  EventRecorder,
  createHeadlessPlayer,
  createHeadlessWeaponRegistry,
  createSwatHarness,
  stepSim,
  type HeadlessPlayer,
  type HeadlessWeaponRegistry,
  type SwatHarness,
} from './simDriver';
import { emitContractEvent, loadOptionalModule, onContractEvent } from './contracts';

export {
  installDomShim,
  restoreDomShim,
  buildHeadlessWorld,
  generateRealMap,
  loadDoorConfig,
  loadWeaponsData,
  makeSingleRoomMap,
  makeTwoDoorHouseMap,
  makeWindowedSiegeMap,
  EventRecorder,
  stepSim,
  createHeadlessWeaponRegistry,
  createSwatHarness,
  loadOptionalModule,
  onContractEvent,
  emitContractEvent,
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DATA_DIR = path.join(REPO_ROOT, 'public/data');

// ---------- Narrow M1–M3 Contract Types (PROJECT.md § Interface Contracts) ----------

export type ParitySquadOrder = SquadOrder | 'c2Clear' | 'gasClear';

export interface SwatProfileModuleContract {
  BASE_SWAT_COMBAT?: Readonly<CombatParams>;
  BASE_SHIELD_COMBAT?: Readonly<CombatParams>;
  BASE_SWAT_MOBILITY?: Readonly<MobilityParams>;
  BASE_SHIELD_MOBILITY?: Readonly<MobilityParams>;
  SWAT_HP?: number;
  SWAT_UNIFORM_COLOR?: number;
  SWAT_READY_POSE?: 'high' | 'low';
  SWAT_PEPPER_INTERVAL?: number;
  SWAT_PEPPER_RANGE?: number;
  SWAT_RUSH_RADIUS?: number;
  SWAT_RUSH_DURATION_SEC?: number;
  SWAT_RUSH_TEAM_COOLDOWN?: number;
  SWAT_RUSH_SPEED_MIN?: number;
  SWAT_RUSH_SPEED_MAX?: number;
  SWAT_SHIELD_RUSH_SPEED?: number;
  SWAT_SUPPRESS_INTERVAL?: number;
  SWAT_SUPPRESS_START_SEC?: number;
  SWAT_SUPPRESS_END_SEC?: number;
  SWAT_C2_PLANT_SEC?: number;
  SWAT_C2_FUSE_SEC?: number;
  SWAT_C2_BLAST_RADIUS?: number;
  SWAT_C2_BLAST_HALF_ANGLE_DEG?: number;
  SWAT_C2_MAX_DAMAGE?: number;
  SWAT_FLASH_PER_TEAM?: number;
  SWAT_FLASH_CARRY_MAX?: number;
  SWAT_GAS_PER_TEAM?: number;
  SWAT_RADIO_STAGGER_SEC?: number;
  SWAT_FOOTSTEP_STRIDE_FAST?: number;
  SWAT_FOOTSTEP_STRIDE_NORMAL?: number;
  isShieldRole?: (index: number, total: number) => boolean;
  cloneCombatProfile?: (base: Readonly<CombatParams>) => CombatParams;
  cloneMobilityProfile?: (base: Readonly<MobilityParams>) => MobilityParams;
}

export interface TacticalOpticsInstance {
  readonly group?: THREE.Group;
  readonly laserMesh?: THREE.Mesh;
  readonly dotMesh?: THREE.Mesh;
  readonly coneMesh?: THREE.Mesh;
  update(origin: Vec3, dir: Vec3, colliders: readonly Collider[], visible?: boolean): void;
  setVisible?(v: boolean): void;
  hide?(): void;
  dispose(scene?: THREE.Scene): void;
}

export interface TacticalOpticsModuleContract {
  TacticalOptics?: new (scene?: THREE.Scene) => TacticalOpticsInstance;
}

export interface SwatTacticsModuleContract {
  computeBallisticVelocity?: (
    origin: Vec3,
    target: Vec3,
    gravity: number,
    speed?: number,
    minT?: number,
    maxT?: number,
  ) => Vec3;
  planDoorwayFlashThrow?: (...args: unknown[]) => unknown;
  planWindowFlashThrow?: (...args: unknown[]) => unknown;
  planWallBankFlashThrow?: (...args: unknown[]) => unknown;
  planFlashThrow?: (...args: unknown[]) => unknown;
  computeC2Standoff?: (...args: unknown[]) => unknown;
  evaluateC2BlastCone?: (
    doorPos: Vec3,
    blastDir: Vec3,
    targetPos: Vec3,
    radius?: number,
    coneCos?: number,
    maxDamage?: number,
  ) => { inCone: boolean; damage: number; dist: number; falloff: number; stunScale: number };
  shouldUseC2Breach?: (...args: unknown[]) => boolean;
  findRoomDoors?: (...args: unknown[]) => unknown;
  selectPinningCell?: (...args: unknown[]) => unknown;
  planPincerFlankGoal?: (...args: unknown[]) => unknown;
  assignCellPortals?: (...args: unknown[]) => unknown;
  filterReachableExteriorEntries?: (...args: unknown[]) => unknown;
}

export interface EntityManagerWithM2 extends EntityManager {
  setTearGas?: (tg: TearGas | null) => void;
  applyC2Blast?: (
    doorPos: Vec3,
    blastDir: Vec3,
    radius: number,
    halfAngleDeg: number,
    maxDamage: number,
    sourceId: string,
  ) => void;
}

export interface SquadSystemWithParity extends SquadSystem {
  issueOrder?: (
    order: ParitySquadOrder,
    opts?: { element?: SquadElement; door?: Door | null; targetPos?: Vec3 | null },
  ) => boolean | void;
}

export async function loadSwatProfileModule(): Promise<SwatProfileModuleContract | undefined> {
  return loadOptionalModule<SwatProfileModuleContract>('../../../src/ai/SwatProfile');
}

export async function loadTacticalOpticsModule(): Promise<TacticalOpticsModuleContract | undefined> {
  return loadOptionalModule<TacticalOpticsModuleContract>('../../../src/ai/TacticalOptics');
}

export async function loadSwatTacticsModule(): Promise<SwatTacticsModuleContract | undefined> {
  return loadOptionalModule<SwatTacticsModuleContract>('../../../src/ai/SwatTactics');
}

// ---------- Real JSON Config Loaders (public/data/) ----------

let cachedProfiles: AIProfile[] | null = null;
let cachedPlayerCfg: PlayerConfig | null = null;
let cachedPerceptionCfg: PerceptionConfig | null = null;
let cachedRoeCfg: RoeConfig | null = null;

export function loadRawSquadJson(): Record<string, unknown> {
  const filePath = path.join(DATA_DIR, 'squad.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

export function loadSquadConfig(): SquadConfig {
  const filePath = path.join(DATA_DIR, 'squad.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  return validateSquad(raw, filePath);
}

export function loadAIProfiles(): AIProfile[] {
  if (!cachedProfiles) {
    const filePath = path.join(DATA_DIR, 'ai_profiles.json');
    cachedProfiles = validateAIProfiles(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath);
  }
  return cachedProfiles;
}

export function loadPlayerConfig(): PlayerConfig {
  if (!cachedPlayerCfg) {
    const filePath = path.join(DATA_DIR, 'player.json');
    cachedPlayerCfg = validatePlayerConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath);
  }
  return cachedPlayerCfg;
}

export function loadPerceptionConfig(): PerceptionConfig {
  if (!cachedPerceptionCfg) {
    const filePath = path.join(DATA_DIR, 'perception.json');
    cachedPerceptionCfg = validatePerception(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath);
  }
  return cachedPerceptionCfg;
}

export function loadRoeConfig(): RoeConfig {
  if (!cachedRoeCfg) {
    const filePath = path.join(DATA_DIR, 'roe.json');
    cachedRoeCfg = validateRoe(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath);
  }
  return cachedRoeCfg;
}

// ---------- Aimable DoorSystem ----------

export class AimableDoorSystem {
  readonly root = new THREE.Group();
  readonly doors: Door[] = [];
  private aimedDoor: Door | null = null;

  constructor(
    defs: readonly DoorDef[],
    cfg: DoorConfig,
    storyClearance: number,
    colliders: Collider[],
    bus: GameEventBus,
  ) {
    for (const def of defs) {
      const door = new Door(def, cfg, storyClearance, bus);
      this.doors.push(door);
      this.root.add(door.root);
      for (const c of door.colliders) colliders.push(c);
    }
  }

  setAimedDoor(door: Door | null): void {
    this.aimedDoor = door;
  }

  aimed(_maxRange?: number): Door | null {
    return this.aimedDoor;
  }

  findById(id: string): Door | undefined {
    return this.doors.find((d) => d.id === id);
  }

  /** DoorSystem 互換（DoorTrapSystem が参照） */
  getDoor(id: string): Door | undefined {
    return this.findById(id);
  }

  update(dt: number, playerX = 999, playerZ = 999, playerRadius = 0.35, playerY = 0): void {
    for (const d of this.doors) d.update(dt, playerX, playerZ, playerRadius, playerY);
  }

  dispose(): void {
    this.aimedDoor = null;
    for (const d of this.doors) d.dispose();
    this.doors.length = 0;
  }
}

// ---------- Extended Headless Player & Input ----------

export interface SquadHeadlessPlayer extends HeadlessPlayer {
  getForward(out?: THREE.Vector3): THREE.Vector3;
  getHorizontalForward(out?: THREE.Vector3): THREE.Vector3;
  inCameraView(target: Vec3): boolean;
  aimAt(target: Vec3): void;
}

export function createSquadHeadlessPlayer(
  pos: Vec3 = { x: 0, y: 0, z: 7 },
  opts?: { hp?: number; yawRad?: number; pitchRad?: number; isCrouching?: boolean },
): SquadHeadlessPlayer {
  const base = createHeadlessPlayer(pos, opts);
  if (opts?.pitchRad !== undefined) base.pitchRad = opts.pitchRad;
  const eyeTmp = new THREE.Vector3();
  const fwdTmp = new THREE.Vector3();
  const extended: SquadHeadlessPlayer = Object.assign(base, {
    getForward(out = new THREE.Vector3()): THREE.Vector3 {
      const cp = Math.cos(extended.pitchRad);
      return out
        .set(-Math.sin(extended.yawRad) * cp, Math.sin(extended.pitchRad), -Math.cos(extended.yawRad) * cp)
        .normalize();
    },
    getHorizontalForward(out = new THREE.Vector3()): THREE.Vector3 {
      return out.set(-Math.sin(extended.yawRad), 0, -Math.cos(extended.yawRad)).normalize();
    },
    inCameraView(target: Vec3): boolean {
      const eye = extended.getEyePosition(eyeTmp);
      const fwd = extended.getForward(fwdTmp);
      const dx = target.x - eye.x;
      const dy = target.y - eye.y;
      const dz = target.z - eye.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) return true;
      const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / len;
      return dot > 0.5;
    },
    aimAt(target: Vec3): void {
      const eye = extended.getEyePosition(new THREE.Vector3());
      const dx = target.x - eye.x;
      const dy = target.y - eye.y;
      const dz = target.z - eye.z;
      const horiz = Math.hypot(dx, dz);
      extended.yawRad = Math.atan2(-dx, -dz);
      extended.pitchRad = Math.atan2(dy, Math.max(1e-4, horiz));
    },
  });
  return extended;
}

export interface SquadHeadlessInput extends InputManager {
  isPointerLocked: boolean;
  isOrderMenuOpen: boolean;
  suppressSquadShortcuts: boolean;
  onOrderMenu?: (event: OrderMenuEvent, value: number) => void;
  pressAction(action: string): void;
  setDown(action: string, isDown: boolean): void;
}

export function createSquadHeadlessInput(): SquadHeadlessInput {
  const pressed = new Set<string>();
  const down = new Set<string>();
  const input = {
    isPointerLocked: true,
    isOrderMenuOpen: false,
    suppressSquadShortcuts: false,
    onOrderMenu: undefined as ((event: OrderMenuEvent, value: number) => void) | undefined,
    wasMousePressed: () => false,
    wasPressed(k: string) {
      return pressed.has(k);
    },
    isDown(k: string) {
      return down.has(k);
    },
    isMouseDown() {
      return false;
    },
    consumeWheel() {
      return 0;
    },
    endFrame() {
      pressed.clear();
    },
    pressAction(action: string) {
      pressed.add(action);
    },
    setDown(action: string, value: boolean) {
      if (value) down.add(action);
      else down.delete(action);
    },
  };
  return input as unknown as SquadHeadlessInput;
}

// ---------- AudioBridge Spy Sink ----------

export interface AudioCallRecord {
  method: keyof AudioBridgeSink;
  args: unknown[];
}

export interface SpyAudioSink extends AudioBridgeSink {
  readonly calls: AudioCallRecord[];
  of(method: keyof AudioBridgeSink): AudioCallRecord[];
  clear(): void;
}

export function createSpyAudioSink(): SpyAudioSink {
  const calls: AudioCallRecord[] = [];
  const rec = (method: keyof AudioBridgeSink) => (...args: unknown[]) => {
    calls.push({ method, args });
  };
  return {
    calls,
    of(method) {
      return calls.filter((c) => c.method === method);
    },
    clear() {
      calls.length = 0;
    },
    playFootstep: rec('playFootstep'),
    playDoorCreak: rec('playDoorCreak'),
    playBreach: rec('playBreach'),
    playGunshot: rec('playGunshot'),
    playFlashbang: rec('playFlashbang'),
    playC2Beep: rec('playC2Beep'),
    playC2Blast: rec('playC2Blast'),
    playSwatFootstep: rec('playSwatFootstep'),
    playGasHiss: rec('playGasHiss'),
    playCough: rec('playCough'),
    playWarningCall: rec('playWarningCall'),
    playRadioReport: rec('playRadioReport'),
    playAllyRadio: rec('playAllyRadio'),
    triggerEarRinging: rec('triggerEarRinging'),
    updateListener: rec('updateListener'),
  };
}

// ---------- Scene Graph Inspection Helpers ----------

export function countDynamicLights(root: THREE.Object3D): number {
  let lights = 0;
  root.traverse((obj) => {
    if ((obj as THREE.Light).isLight) lights++;
  });
  return lights;
}

export function findOpticsGroups(root: THREE.Object3D): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if (obj.name === 'tacticalOptics') found.push(obj);
  });
  return found;
}

export function findClothColors(root: THREE.Object3D): number[] {
  const colors = new Set<number>();
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m instanceof THREE.MeshStandardMaterial) {
          colors.add(m.color.getHex());
        }
      }
    }
  });
  return [...colors];
}

export function hasClothColor(root: THREE.Object3D, hex: number): boolean {
  return findClothColors(root).includes(hex);
}

// ---------- Order Menu Label Matchers (Opaque-Box CommandMenu Driving) ----------

/** CommandMenu の 1 行あたりのマウス移動量（offsetPx / 28 が選択行） */
const MENU_ROW_PX = 28;

const ORDER_MENU_PATTERNS: Record<ParitySquadOrder, RegExp> = {
  stack: /スタック/,
  clear: /オープン|突入＆クリア|突入クリア/,
  flashClear: /フラッシュ|閃光/,
  // 「C2＆クリア（爆破ブリーチ突入）」に誤マッチしないよう強行突入のみで判定する
  breachClear: /強行突入/,
  c2Clear: /C2|爆破/i,
  gasClear: /ガス|催涙|CS/i,
  pieDoor: /扉開放|開放警戒/,
  move: /指定位置/,
  overwatch: /ロック|警戒方向/,
  hold: /現在位置で待機|現在位置待機/,
  follow: /追従/,
  restrain: /確保/,
  mirror: /ミラー確認/,
  check: /ドアチェック/,
  disarm: /トラップ解除/,
  stairClear: /^階段クリア/,
  stairFlashClear: /フラッシュ＆階段クリア/,
};

// ---------- SquadHarness ----------

export interface SquadHarnessOptions {
  map: MapData;
  allies?: readonly AllyDef[];
  entities?: readonly EntityDef[];
  playerPos?: Vec3;
  playerHp?: number;
  playerYawRad?: number;
  squadCfgOverrides?: Partial<SquadConfig>;
  urlSearch?: string;
  /** SWAT モードのドア・ブービートラップを仕掛けるドア ID */
  trapDoorIds?: readonly string[];
}

export interface SquadHarness {
  dom: DomShimHandle;
  bus: GameEventBus;
  recorder: EventRecorder;
  map: MapData;
  world: WorldBuilder;
  doors: AimableDoorSystem;
  colliders: Collider[];
  player: SquadHeadlessPlayer;
  input: SquadHeadlessInput;
  weapons: HeadlessWeaponRegistry;
  overlay: FlashOverlay;
  subtitle: Subtitle;
  audioSink: SpyAudioSink;
  audioBridge: AudioBridge;
  roe: RoE;
  entities: EntityManagerWithM2;
  flashbang: Flashbang;
  tearGas: TearGas;
  squad: SquadSystemWithParity;
  /** ドアのブービートラップ（trapDoorIds 指定時のみ） */
  traps: DoorTrapSystem | null;
  selectElement(el: SquadElement): void;
  issueOrder(
    order: ParitySquadOrder,
    opts?: { element?: SquadElement; door?: Door; targetPos?: Vec3 },
  ): boolean;
  step(totalSec: number, dt?: number): void;
  dispose(): void;
}

export function defaultAllies(count = 4, origin: Vec3 = { x: 0, y: 0, z: 7 }): AllyDef[] {
  const names = ['Miller', 'Vance', 'Cole', 'Reeves', 'Hayes', 'Grant'];
  const out: AllyDef[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const side = i % 2 === 0 ? -0.75 : 0.75;
    out.push({
      id: `ally_${i + 1}`,
      name: names[i] ?? `Officer${i + 1}`,
      x: origin.x + side,
      y: origin.y,
      z: origin.z + row * 1.1,
      yaw: 0,
    });
  }
  return out;
}

export function createSquadHarness(opts: SquadHarnessOptions): SquadHarness {
  const dom = installDomShim(opts.urlSearch ?? '');
  const bus = createGameEventBus();
  const recorder = new EventRecorder(bus);

  const map: MapData = {
    ...opts.map,
    entities: opts.entities ? [...opts.entities] : [...opts.map.entities],
    allies: opts.allies ? [...opts.allies] : [...(opts.map.allies ?? [])],
  };

  const textures = createStubTextures();
  const world = new WorldBuilder(map, textures);
  const colliders = world.colliders;
  const storyClearance = map.storyHeight ?? map.ceilingHeight;
  const doors = new AimableDoorSystem(map.doors, loadDoorConfig(), storyClearance, colliders, bus);

  const player = createSquadHeadlessPlayer(opts.playerPos ?? map.playerSpawn, {
    hp: opts.playerHp ?? 100,
    yawRad: opts.playerYawRad ?? 0,
  });
  const input = createSquadHeadlessInput();
  const weapons = createHeadlessWeaponRegistry();
  const overlay = new FlashOverlay(dom.document.body as unknown as HTMLElement);
  const subtitle = new Subtitle(dom.document.body as unknown as HTMLElement);
  const audioSink = createSpyAudioSink();
  const audioBridge = new AudioBridge(bus, audioSink, player, colliders);

  const playerCfg = loadPlayerConfig();
  const perceptionCfg = loadPerceptionConfig();
  const roeCfg = loadRoeConfig();
  const squadCfg: SquadConfig = {
    ...loadSquadConfig(),
    ...(opts.squadCfgOverrides ?? {}),
  };
  const profiles = loadAIProfiles();

  // RoE MUST be constructed before EntityManager so entityHit listener order matches production.
  const roe = new RoE(roeCfg, bus);

  const entities = new EntityManager(
    map.entities,
    profiles,
    weapons as unknown as WeaponSystem,
    colliders,
    playerCfg.warning,
    bus,
    map.rooms,
    { cfg: perceptionCfg, player },
    textures,
    {
      doors: doors as unknown as DoorSystem,
      bounds: { width: map.floor.width, depth: map.floor.depth },
      stairs: world.stairs,
    },
    false,
  ) as EntityManagerWithM2;
  roe.attach(entities);

  const weaponsData = loadWeaponsData();
  const flashbang = new Flashbang(
    player as unknown as PlayerController,
    input as unknown as InputManager,
    colliders,
    weaponsData,
    bus,
    weapons as unknown as WeaponSystem,
    overlay,
    map.ceilingHeight,
  );
  flashbang.setCount(4);

  const tearGas = new TearGas(colliders, bus, map.ceilingHeight);
  entities.setTearGas?.(tearGas);

  const flashDef = weaponsData.find((w) => w.kind === 'flashbang');
  const flashParams = {
    range: flashDef?.range ?? 9,
    blindSec: flashDef?.blindSec ?? 4.5,
  };

  // Pass optional M2/M3 trailing deps (flashbang, tearGas, windows) cleanly via extended ctor type.
  type SquadCtorWithParity = new (
    defs: readonly AllyDef[],
    cfg: SquadConfig,
    player: PlayerController,
    input: InputManager,
    colliders: readonly Collider[],
    bounds: { width: number; depth: number },
    stairs: readonly (typeof world.stairs)[number][],
    doors: DoorSystem,
    entities: EntityManager,
    bus: GameEventBus,
    textures: typeof textures,
    weapons: WeaponSystem,
    flash: { range: number; blindSec: number },
    rooms: readonly (typeof map.rooms)[number][],
    arrestCfg: typeof playerCfg.arrest,
    extras?: {
      flashbang?: Flashbang;
      tearGas?: TearGas;
      windows?: readonly WindowDef[];
      traps?: DoorTrapSystem | null;
    },
  ) => SquadSystemWithParity;

  const SquadCtor = SquadSystem as unknown as SquadCtorWithParity;
  let squadRef: SquadSystemWithParity | null = null;
  const traps =
    opts.trapDoorIds && opts.trapDoorIds.length > 0
      ? new DoorTrapSystem({
          doors: doors as unknown as DoorSystem,
          bus,
          colliders,
          cfg: squadCfg.doorTrap,
          swatPositions: () => [
            { x: player.position.x, z: player.position.z, footY: player.position.y },
            ...(squadRef?.allies ?? []).filter((a) => !a.down).map((a) => ({ x: a.body.px, z: a.body.pz, footY: a.body.footY })),
          ],
          suspectPositions: () => [],
          victims: () => [],
        })
      : null;
  for (const id of opts.trapDoorIds ?? []) {
    const d = doors.getDoor(id);
    if (d) traps?.place(d);
  }
  const allyDefs = opts.allies ?? (map.allies && map.allies.length > 0 ? map.allies : defaultAllies(4));

  const squad = new SquadCtor(
    allyDefs,
    squadCfg,
    player as unknown as PlayerController,
    input as unknown as InputManager,
    colliders,
    { width: map.floor.width, depth: map.floor.depth },
    world.stairs,
    doors as unknown as DoorSystem,
    entities,
    bus,
    textures,
    weapons as unknown as WeaponSystem,
    flashParams,
    map.rooms,
    playerCfg.arrest,
    {
      flashbang,
      tearGas,
      windows: map.windows,
      traps,
    },
  );
  squadRef = squad;

  entities.attachSquad(squad, squadCfg.presenceBonusPerAlly);

  const selectElement = (el: SquadElement): void => {
    for (let guard = 0; guard < 6 && squad.currentElement !== el; guard++) {
      input.pressAction('cycleElement');
      squad.update(0.01);
      input.endFrame();
    }
  };

  const issueOrder = (
    order: ParitySquadOrder,
    orderOpts?: { element?: SquadElement; door?: Door; targetPos?: Vec3 },
  ): boolean => {
    if (orderOpts?.element) {
      selectElement(orderOpts.element);
    }

    if (orderOpts?.door) {
      doors.setAimedDoor(orderOpts.door);
      player.aimAt({ x: orderOpts.door.centerX, y: orderOpts.door.sillY + 1.1, z: orderOpts.door.centerZ });
    } else if (orderOpts?.targetPos) {
      doors.setAimedDoor(null);
      player.aimAt(orderOpts.targetPos);
    }

    if (typeof squad.issueOrder === 'function') {
      const res = squad.issueOrder(order, {
        element: orderOpts?.element ?? squad.currentElement,
        door: orderOpts?.door ?? doors.aimed(10),
        targetPos: orderOpts?.targetPos ?? null,
      });
      return res !== false;
    }

    if (!input.onOrderMenu) return false;
    input.onOrderMenu('open', 0);

    // メニューは番号を持たず、開いた直後は「キャンセル」行が選択されている。
    // マウス上下（28px/行）で目的の行まで動かして confirm する（実機の操作と同じ）。
    const rows = dom.document.querySelectorAll('.cqb-cmd-row') as FakeElement[];
    const pattern = ORDER_MENU_PATTERNS[order];
    const activeIdx = rows.findIndex((row) => row.classList.contains('active'));
    const targetIdx = rows.findIndex((row) => !row.classList.contains('disabled') && pattern.test(row.textContent));

    if (activeIdx < 0 || targetIdx < 0) {
      input.onOrderMenu('cancel', 0);
      return false;
    }

    input.onOrderMenu('move', (targetIdx - activeIdx) * MENU_ROW_PX);
    input.onOrderMenu('confirm', 0);
    return true;
  };

  return {
    dom,
    bus,
    recorder,
    map,
    world,
    doors,
    colliders,
    player,
    input,
    weapons,
    overlay,
    subtitle,
    audioSink,
    audioBridge,
    roe,
    entities,
    flashbang,
    tearGas,
    squad,
    traps,
    selectElement,
    issueOrder,
    step(totalSec: number, dt = 0.05) {
      stepSim(
        totalSec,
        dt,
        (stepDt) => {
          doors.update(stepDt, player.position.x, player.position.z, 0.35, player.position.y);
          flashbang.update(stepDt);
          tearGas.update(stepDt);
          entities.update(stepDt);
          traps?.update(stepDt);
          squad.update(stepDt);
          roe.update(stepDt);
          subtitle.update(stepDt);
          input.endFrame();
        },
        recorder,
      );
    },
    dispose() {
      squad.dispose();
      traps?.dispose();
      entities.dispose();
      roe.dispose();
      audioBridge.dispose();
      tearGas.dispose();
      flashbang.dispose();
      overlay.dispose();
      subtitle.dispose();
      recorder.dispose();
      doors.dispose();
      world.dispose();
      textures.dispose();
      restoreDomShim();
    },
  };
}

// ---------- Head-to-Head Parity Pair (SWAT Mode ↔ Suspect Mode) ----------

export interface ParityPair {
  map: MapData;
  squadHarness: SquadHarness;
  swatHarness: SwatHarness;
  dispose(): void;
}

export function createParityPair(opts: {
  map?: MapData;
  template?: 'house_compact' | 'house' | 'embassy';
  seed?: number;
  officerCount?: number;
  squadOrigin?: Vec3;
  startAssault?: boolean;
}): ParityPair {
  const map = opts.map ?? generateRealMap(opts.template ?? 'house_compact', opts.seed ?? 101);
  const count = opts.officerCount ?? Math.max(4, map.allies?.length ?? 4);
  const origin = opts.squadOrigin ?? map.playerSpawn;

  const allies: AllyDef[] =
    map.allies && map.allies.length >= count
      ? map.allies.slice(0, count)
      : defaultAllies(count, origin);

  const spawns: SwatSpawn[] = allies.map((a) => ({
    x: a.x,
    y: a.y ?? 0,
    z: a.z,
  }));

  const squadHarness = createSquadHarness({
    map,
    allies,
    playerPos: { x: origin.x, y: origin.y, z: origin.z + 1.8 },
  });

  const swatHarness = createSwatHarness({
    map,
    spawns,
    count,
    playerPos: { x: 0, y: 0, z: 0 },
    startAssault: opts.startAssault ?? false,
  });

  return {
    map,
    squadHarness,
    swatHarness,
    dispose() {
      swatHarness.dispose();
      squadHarness.dispose();
    },
  };
}
