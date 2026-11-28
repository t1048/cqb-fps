import * as THREE from 'three';
import { createGameEventBus, type GameEventBus } from '../../../src/core/events';
import type { MapData, Vec3 } from '../../../src/core/types';
import type { InputManager } from '../../../src/core/InputManager';
import type { PlayerController } from '../../../src/player/PlayerController';
import type { HitTarget, WeaponSystem } from '../../../src/weapons/WeaponSystem';
import { Flashbang } from '../../../src/weapons/Flashbang';
import { FlashOverlay } from '../../../src/ui/FlashOverlay';
import { Subtitle } from '../../../src/ui/Subtitle';
import { SwatTeam, type SwatSpawn, type SwatTeamDeps } from '../../../src/modes/SwatTeam';
import type { AABB, Collider } from '../../../src/world/WorldBuilder';
import { installDomShim, restoreDomShim, type DomShimHandle } from './domShim';
import { buildHeadlessWorld, loadWeaponsData, type HeadlessWorld } from './headlessWorld';
import { onContractEvent, type AllGameEvents, type SwatTeamDepsWithM3, type TearGasInstance } from './contracts';

export interface RecordedEvent<K extends keyof AllGameEvents = keyof AllGameEvents> {
  event: K;
  payload: AllGameEvents[K];
  time: number;
}

const ALL_TRACKED_EVENTS: ReadonlyArray<keyof AllGameEvents> = [
  'noise',
  'warningCall',
  'flashDetonated',
  'doorBreached',
  'shotFired',
  'bulletImpact',
  'suspectFired',
  'entityHit',
  'civilianStateChanged',
  'hostageShield',
  'suspectStateChanged',
  'evidence',
  'arrest',
  'roeViolation',
  'playerHit',
  'playerBlinded',
  'allyRadio',
  // Upcoming M2/M3 events
  'c2Beep',
  'c2Detonated',
  'gasDetonated',
  'playerCough',
  'swatFootstep',
];

export class EventRecorder {
  readonly events: RecordedEvent[] = [];
  private readonly unsubs: Array<() => void> = [];
  time = 0;

  constructor(bus: GameEventBus) {
    for (const ev of ALL_TRACKED_EVENTS) {
      this.unsubs.push(
        onContractEvent(bus, ev, (payload) => {
          this.events.push({ event: ev, payload, time: this.time });
        }),
      );
    }
  }

  of<K extends keyof AllGameEvents>(event: K): RecordedEvent<K>[] {
    return this.events.filter((e) => e.event === event) as RecordedEvent<K>[];
  }

  count(event: keyof AllGameEvents): number {
    return this.events.filter((e) => e.event === event).length;
  }

  clear(): void {
    this.events.length = 0;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }
}

export interface HeadlessPlayer {
  readonly position: THREE.Vector3;
  hp: number;
  maxHp: number;
  alive: boolean;
  yawRad: number;
  pitchRad: number;
  isCrouching: boolean;
  speedMultiplier: number;
  viewKicks: Array<{ pitch: number; yaw: number }>;
  getEyePosition(out?: THREE.Vector3): THREE.Vector3;
  getBodyBounds(): AABB;
  takeDamage(amount: number): number;
  addViewKick(pitch: number, yaw: number): void;
  moveTo(x: number, y: number, z: number): void;
}

export function createHeadlessPlayer(
  pos: Vec3 = { x: 0, y: 0, z: -2 },
  opts?: { hp?: number; yawRad?: number; isCrouching?: boolean },
): HeadlessPlayer {
  const position = new THREE.Vector3(pos.x, pos.y, pos.z);
  const player: HeadlessPlayer = {
    position,
    hp: opts?.hp ?? 100,
    maxHp: 100,
    alive: true,
    yawRad: opts?.yawRad ?? 0,
    pitchRad: 0,
    isCrouching: opts?.isCrouching ?? false,
    speedMultiplier: 1,
    viewKicks: [],
    getEyePosition(out = new THREE.Vector3()) {
      return out.set(position.x, position.y + (player.isCrouching ? 1.05 : 1.6), position.z);
    },
    getBodyBounds(): AABB {
      const h = player.isCrouching ? 1.15 : 1.75;
      return {
        min: { x: position.x - 0.28, y: position.y, z: position.z - 0.28 },
        max: { x: position.x + 0.28, y: position.y + h, z: position.z + 0.28 },
      };
    },
    takeDamage(amount: number): number {
      if (!player.alive) return player.hp;
      player.hp = Math.max(0, player.hp - amount);
      if (player.hp <= 0) player.alive = false;
      return player.hp;
    },
    addViewKick(pitch: number, yaw: number) {
      player.viewKicks.push({ pitch, yaw });
    },
    moveTo(x: number, y: number, z: number) {
      position.set(x, y, z);
    },
  };
  return player;
}

export interface HeadlessWeaponRegistry {
  readonly targets: Set<HitTarget>;
  extraSpread: number;
  suppressFire: boolean;
  addTarget(t: HitTarget): void;
  removeTarget(t: HitTarget): void;
  update(dt: number): void;
}

export function createHeadlessWeaponRegistry(): HeadlessWeaponRegistry {
  const targets = new Set<HitTarget>();
  return {
    targets,
    extraSpread: 0,
    suppressFire: false,
    addTarget(t: HitTarget) {
      targets.add(t);
    },
    removeTarget(t: HitTarget) {
      targets.delete(t);
    },
    update(_dt: number) {
      // Mirrors WeaponSystem.update frame reset contract
    },
  };
}

export function createHeadlessInput(): InputManager {
  const pressed = new Set<string>();
  const down = new Set<string>();
  return {
    isPointerLocked: false,
    isOrderMenuOpen: false,
    wasPressed: (k: string) => pressed.has(k),
    wasMousePressed: () => false,
    isDown: (k: string) => down.has(k),
    isMouseDown: () => false,
    consumeWheel: () => 0,
    endFrame: () => pressed.clear(),
  } as unknown as InputManager;
}

export function stepSim(
  totalSec: number,
  dt: number,
  tick: (stepDt: number, elapsed: number) => void,
  recorder?: EventRecorder,
): void {
  const steps = Math.max(1, Math.round(totalSec / dt));
  let elapsed = 0;
  for (let i = 0; i < steps; i++) {
    const stepDt = Math.min(dt, totalSec - elapsed);
    if (stepDt <= 1e-9) break;
    elapsed += stepDt;
    if (recorder) recorder.time += stepDt;
    tick(stepDt, elapsed);
  }
}

export interface SwatHarness {
  dom: DomShimHandle;
  bus: GameEventBus;
  recorder: EventRecorder;
  hw: HeadlessWorld;
  player: HeadlessPlayer;
  weapons: HeadlessWeaponRegistry;
  overlay: FlashOverlay;
  subtitle: Subtitle;
  flashbang: Flashbang;
  tearGas?: TearGasInstance;
  team: SwatTeam;
  pepperHits: Array<'player' | 'hostage'>;
  step(totalSec: number, dt?: number): void;
  dispose(): void;
}

export function createSwatHarness(opts: {
  map: MapData;
  spawns: readonly SwatSpawn[];
  count?: number;
  playerPos?: Vec3;
  playerHp?: number;
  playerYawRad?: number;
  startAssault?: boolean;
  tearGas?: TearGasInstance;
  tearGasFactory?: (colliders: readonly Collider[], bus: GameEventBus, ceilingHeight: number) => TearGasInstance;
  urlSearch?: string;
  /** 味方容疑者（SWAT の射撃対象）と、拘束対象（投降・拘束済み） */
  suspects?: SwatTeamDeps['suspects'];
  restrainables?: SwatTeamDeps['restrainables'];
}): SwatHarness {
  const dom = installDomShim(opts.urlSearch ?? '');
  const bus = createGameEventBus();
  const recorder = new EventRecorder(bus);
  const hw = buildHeadlessWorld(opts.map, bus);
  const player = createHeadlessPlayer(opts.playerPos ?? opts.map.playerSpawn, {
    hp: opts.playerHp ?? 100,
    yawRad: opts.playerYawRad ?? 0,
  });
  const weapons = createHeadlessWeaponRegistry();
  const input = createHeadlessInput();
  const overlay = new FlashOverlay(dom.document.body as unknown as HTMLElement);
  const subtitle = new Subtitle(dom.document.body as unknown as HTMLElement);
  const flashbang = new Flashbang(
    player as unknown as PlayerController,
    input,
    hw.colliders,
    loadWeaponsData(),
    bus,
    weapons as unknown as WeaponSystem,
    overlay,
    opts.map.ceilingHeight,
  );
  flashbang.setCount(0);

  const tearGas = opts.tearGas ?? opts.tearGasFactory?.(hw.colliders, bus, opts.map.ceilingHeight);
  const pepperHits: Array<'player' | 'hostage'> = [];
  const deps: SwatTeamDepsWithM3 = {
    spawns: opts.spawns,
    count: opts.count ?? opts.spawns.length,
    player,
    colliders: hw.colliders,
    bus,
    weapons: weapons as unknown as WeaponSystem,
    doors: hw.doors,
    bounds: hw.bounds,
    stairs: hw.world.stairs,
    rooms: opts.map.rooms,
    windows: opts.map.windows,
    flashbang,
    subtitle,
    civilians: () => [],
    textures: hw.textures,
    onPepper: (target) => pepperHits.push(target),
    flashOverlay: overlay,
    tearGas,
    suspects: opts.suspects,
    restrainables: opts.restrainables,
  };

  const team = new SwatTeam(deps);
  if (opts.startAssault) team.beginAssault();

  return {
    dom,
    bus,
    recorder,
    hw,
    player,
    weapons,
    overlay,
    subtitle,
    flashbang,
    tearGas,
    team,
    pepperHits,
    step(totalSec: number, dt = 0.05) {
      stepSim(
        totalSec,
        dt,
        (stepDt) => {
          hw.doorSystem.update(stepDt, player.position.x, player.position.z, 0.35, player.position.y);
          flashbang.update(stepDt);
          tearGas?.update(stepDt);
          team.update(stepDt);
          subtitle.update(stepDt);
        },
        recorder,
      );
    },
    dispose() {
      team.dispose();
      tearGas?.dispose();
      flashbang.dispose();
      overlay.dispose();
      subtitle.dispose();
      recorder.dispose();
      hw.dispose();
      restoreDomShim();
    },
  };
}
