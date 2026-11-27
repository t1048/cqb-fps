import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus, CivilianState, SuspectState, type GameEventBus } from '../../src/core/events';
import type { AIProfile, AllyDef, ArrestConfig, DoorConfig, EntityDef, RoomDef, SquadConfig, Vec3, WeaponDef } from '../../src/core/types';
import type { InputManager } from '../../src/core/InputManager';
import type { PlayerController } from '../../src/player/PlayerController';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import { Flashbang } from '../../src/weapons/Flashbang';
import { TearGas } from '../../src/weapons/TearGas';
import { FlashOverlay } from '../../src/ui/FlashOverlay';
import { Door, DoorSystem } from '../../src/world/Door';
import type { Collider } from '../../src/world/WorldBuilder';
import type { TextureLibrary } from '../../src/world/Materials';
import { EntityManager } from '../../src/ai/EntityManager';
import { SquadSystem } from '../../src/ai/Squad';
import {
  BASE_SHIELD_COMBAT,
  BASE_SWAT_COMBAT,
  SWAT_C2_FUSE_SEC,
  SWAT_C2_PLANT_SEC,
  SWAT_HP,
  SWAT_RADIO_STAGGER_SEC,
  SWAT_UNIFORM_COLOR,
} from '../../src/ai/SwatProfile';

// Minimal DOM stub for headless vitest node environment (EntityManager / CommandMenu / AIDebugLabel / FlashOverlay)
function installMinimalDom() {
  const g = globalThis as unknown as Record<string, unknown>;
  const makeEl = () => {
    const children: unknown[] = [];
    const el: Record<string, unknown> = {
      style: {} as Record<string, string>,
      className: '',
      textContent: '',
      innerHTML: '',
      children,
      appendChild(c: unknown) {
        children.push(c);
        return c;
      },
      append(...nodes: unknown[]) {
        children.push(...nodes);
      },
      replaceChildren(...nodes: unknown[]) {
        children.length = 0;
        children.push(...nodes);
      },
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() {
          return false;
        },
      },
      removeChild(c: unknown) {
        const i = children.indexOf(c);
        if (i >= 0) children.splice(i, 1);
        return c;
      },
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      querySelectorAll() {
        return [];
      },
      querySelector() {
        return null;
      },
      getContext() {
        return {
          clearRect() {},
          fillRect() {},
          fillText() {},
          measureText: (t: string) => ({ width: t.length * 8 }),
          beginPath() {},
          roundRect() {},
          fill() {},
          stroke() {},
          font: '',
          fillStyle: '',
          strokeStyle: '',
          textAlign: '',
          textBaseline: '',
        };
      },
    };
    return el;
  };
  const prevWin = g.window;
  const prevDoc = g.document;
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 720,
  };
  g.document = {
    createElement: () => makeEl(),
    body: makeEl(),
    head: makeEl(),
    getElementById: () => null,
  };
  return () => {
    g.window = prevWin;
    g.document = prevDoc;
  };
}

const DEFAULT_DOOR_CFG: DoorConfig = {
  height: 2.2,
  thickness: 0.08,
  peekAngle: 28,
  openSpeed: 120,
  knobSpeedMultiplier: 2.0,
  interactRange: 2.4,
  segmentLength: 0.25,
  noise: { slowRadius: 5, fastRadius: 12 },
  breach: { speedMultiplier: 5.5, noiseRadius: 24, moraleRadius: 6, moralePenalty: 20 },
};

const DEFAULT_SQUAD_CFG: SquadConfig = {
  moveSpeed: 2.35,
  bodyRadius: 0.3,
  arriveDistance: 0.4,
  followDistance: 1.5,
  followLateral: 0.75,
  stackOffset: 0.75,
  dominationDepth: 1.9,
  dominationLateral: 1.3,
  staggerSec: 0.28,
  personalSpace: 0.65,
  engageRange: 18,
  fireInterval: 0.2,
  damage: 13,
  warningInterval: 2.0,
  presenceBonusPerAlly: 0.25,
  flashDelay: 0.9,
  doorOpenAngle: 70,
  stairArrive: 0.85,
  stairExitRadius: 0.48,
  stairStallResetSec: 2.0,
  stuckResetSec: 1.2,
  stuckRecoverSec: 2.4,
  doorOpenTimeoutSec: 2.5,
  stackWaitTimeoutSec: 2.5,
  warnStates: [SuspectState.BARRICADED, SuspectState.ALERT, SuspectState.CONFRONTATION, SuspectState.HESITATE],
  hostileStates: [SuspectState.ENGAGE, SuspectState.HOSTAGE_SHIELD],
  elementLabels: { gold: 'GOLD', alpha: 'ALPHA', bravo: 'BRAVO' },
  inventory: { flashbang: 4, gas: 3 },
  gasWaitSec: 1.65,
  doorCheck: { durationSec: 1.7, detectChance: 0.9, spotChance: 0.35 },
  doorTrap: { maxCount: 2, baseChance: 0.55, alertBonusAt: 40, alertBonus: 1, minStartDist: 7, disarmSec: 5, failChance: 0.12, blastRadius: 4.2, blastDamage: 85, triggerDist: 3 },
  orderLabels: {
    follow: '追従',
    hold: '待機',
    move: '移動',
    overwatch: '警戒',
    stack: 'スタック',
    clear: 'クリア',
    flashClear: 'フラッシュ突入',
    breachClear: 'ブリーチ突入',
    c2Clear: 'C2爆破突入',
    gasClear: 'CSガス突入',
    pieDoor: 'ドア警戒',
    restrain: '確保',
  },
};

const DEFAULT_ARREST_CFG: ArrestConfig = {
  range: 2.2,
  holdSec: 0.5,
  civilianRange: 2.2,
  civilianHoldSec: 0.4,
  evidenceRange: 2.2,
  evidenceHoldSec: 0.4,
};

const FLASH_WEAPON_DEF: WeaponDef = {
  id: 'flashbang',
  name: 'M84 Flashbang',
  category: 'throwable',
  damage: 0,
  fireRate: 1.0,
  magazineSize: 0,
  reserveAmmo: 4,
  reloadTime: 0,
  range: 15,
  recoilKick: 0,
  spreadDeg: 0,
  noiseRadius: 20,
  throwable: {
    throwSpeed: 10,
    upwardBiasDeg: 18,
    gravity: 14,
    ballRadius: 0.06,
    restitution: 0.45,
    friction: 0.7,
    stopSpeed: 0.25,
    fuseTime: 1.2,
    effectRadius: 8,
    blindSec: 3.5,
  } as WeaponDef['throwable'],
};

const DEFAULT_MODIFIERS = {
  warningCall: 15,
  flashbang: 35,
  breach: 20,
  nonlethalHit: 30,
  isolation: 10,
};

const SUSPECT_PROFILE: AIProfile = {
  id: 'hostile',
  initialMorale: 90,
  recoveryPerSec: 1,
  thresholds: { surrenderBelow: 20, hesitateBelow: 40 },
  modifiers: DEFAULT_MODIFIERS,
  combat: {
    decisionSec: 0.5,
    alertCalmSec: 10,
    hesitateFireSec: 3,
    hesitateRetreatSpeed: 0.8,
    hesitateRetreatMax: 1.5,
    hesitateShakeDeg: 0,
    moveSpeed: 2.0,
    fireInterval: 0.4,
    shotsPerPeek: 3,
    magazineSize: 12,
    reloadSec: 2.2,
    coverSecMin: 1.0,
    coverSecMax: 1.6,
    peekSecMax: 1.5,
    engageRange: 18,
    coverSearchRange: 5,
    coverMargin: 0.45,
    crouchCoverMaxHeight: 1.5,
    flinchSec: 0.3,
    gunshotNoiseRadius: 35,
    shotDamage: 8,
    baseSpreadDeg: 4.0,
  },
} as unknown as AIProfile;

const CIV_PROFILE: AIProfile = {
  id: 'civ',
  initialMorale: 10,
  recoveryPerSec: 0,
  thresholds: { surrenderBelow: 50, hesitateBelow: 80 },
  modifiers: DEFAULT_MODIFIERS,
} as unknown as AIProfile;

function makeBoxCollider(x: number, y: number, z: number, w: number, h: number, d: number, kind: Collider['kind'] = 'wall'): Collider {
  return {
    kind,
    aabb: {
      min: { x: x - w / 2, y, z: z - d / 2 },
      max: { x: x + w / 2, y: y + h, z: z + d / 2 },
    },
  };
}

function makeFloor(width = 40, depth = 40): Collider {
  return makeBoxCollider(0, -0.2, 0, width, 0.2, depth, 'floor');
}

function makeStubPlayer(pos: Vec3 = { x: 0, y: 0, z: 8 }, yawRad = 0) {
  const position = new THREE.Vector3(pos.x, pos.y, pos.z);
  let hp = 100;
  return {
    position,
    yawRad,
    pitchRad: 0,
    alive: true,
    isCrouching: false,
    get hp() {
      return hp;
    },
    getEyePosition(out = new THREE.Vector3()) {
      return out.set(position.x, position.y + 1.6, position.z);
    },
    getBodyBounds() {
      return {
        min: { x: position.x - 0.3, y: position.y, z: position.z - 0.3 },
        max: { x: position.x + 0.3, y: position.y + 1.75, z: position.z + 0.3 },
      };
    },
    inCameraView() {
      return false;
    },
    takeDamage(dmg: number) {
      hp = Math.max(0, hp - dmg);
      return hp;
    },
  } as unknown as PlayerController & { hp: number };
}

function makeStubInput(): InputManager {
  return {
    isPointerLocked: false,
    suppressSquadShortcuts: false,
    isOrderMenuOpen: false,
    onOrderMenu: undefined,
    wasPressed: () => false,
    wasMousePressed: () => false,
    isDown: () => false,
  } as unknown as InputManager;
}

function makeStubWeapons(): WeaponSystem {
  const targets = new Set<unknown>();
  return {
    suppressFire: false,
    addTarget: (t: unknown) => targets.add(t),
    removeTarget: (t: unknown) => targets.delete(t),
  } as unknown as WeaponSystem;
}

function makeStubTextures(): TextureLibrary {
  return { get: () => undefined } as unknown as TextureLibrary;
}

function countDynamicLights(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((obj) => {
    if (
      obj instanceof THREE.PointLight ||
      obj instanceof THREE.SpotLight ||
      obj instanceof THREE.DirectionalLight
    ) {
      count++;
    }
  });
  return count;
}

interface HarnessOpts {
  allies?: AllyDef[];
  entities?: EntityDef[];
  rooms?: RoomDef[];
  colliders?: Collider[];
  doors?: Door[];
  playerPos?: Vec3;
  withGadgets?: boolean;
}

function createHarness(opts: HarnessOpts = {}) {
  const bus: GameEventBus = createGameEventBus();
  const colliders: Collider[] = [makeFloor(), ...(opts.colliders ?? [])];
  const doorsList: Door[] = opts.doors ?? [];
  for (const d of doorsList) {
    for (const c of d.colliders) colliders.push(c);
  }
  const doorSys = {
    doors: doorsList,
    update(dt: number) {
      for (const d of doorsList) d.update(dt);
    },
  } as unknown as DoorSystem;

  const player = makeStubPlayer(opts.playerPos ?? { x: 0, y: 0, z: 12 });
  const input = makeStubInput();
  const weapons = makeStubWeapons();
  const textures = makeStubTextures();
  const rooms: RoomDef[] = opts.rooms ?? [
    { id: 'room1', name: 'Room 1', x: 0, z: 0, width: 16, depth: 16, floorY: 0 },
  ];

  const overlay = new FlashOverlay(document.body as unknown as HTMLElement);
  const flashbang = opts.withGadgets !== false
    ? new Flashbang(player, input, colliders, [FLASH_WEAPON_DEF], bus, weapons, overlay, 3.0)
    : undefined;
  const tearGas = opts.withGadgets !== false ? new TearGas(colliders, bus, 3.0) : undefined;

  const entities = new EntityManager(
    opts.entities ?? [],
    [SUSPECT_PROFILE, CIV_PROFILE],
    weapons,
    colliders,
    { range: 12, angleDeg: 60, cooldown: 2 },
    bus,
    rooms,
    {
      cfg: {
        hearing: {
          occludedMultiplier: 0.65,
          unoccludedKinds: ['door', 'breach'],
          kinds: { footstep: 1, gunshot: 1, door: 1, breach: 1, flash: 1, voice: 1 },
        },
        vision: {
          fovDeg: 110,
          range: 18,
          alertFovDeg: 140,
          eyeHeight: 1.55,
          bodyPointDrop: 0.6,
          crouchRangeMultiplier: 0.7,
          alertReactionMultiplier: 0.6,
        },
      },
      player: player as never,
    },
    textures,
    { doors: doorSys, bounds: { width: 40, depth: 40 }, stairs: [] },
    false,
    tearGas ?? null,
  );

  const allyDefs: AllyDef[] = opts.allies ?? [
    { id: 'ally_1', name: 'Miller', x: -1.5, z: 5, yaw: 0 },
    { id: 'ally_2', name: 'Cole', x: 1.5, z: 5, yaw: 0 },
  ];

  const squad = new SquadSystem(
    allyDefs,
    DEFAULT_SQUAD_CFG,
    player,
    input,
    colliders,
    { width: 40, depth: 40 },
    [],
    doorSys,
    entities,
    bus,
    textures,
    weapons,
    { range: 8, blindSec: 3.5 },
    rooms,
    DEFAULT_ARREST_CFG,
    opts.withGadgets !== false ? { flashbang, tearGas, windows: [] } : undefined,
  );
  entities.attachSquad(squad, 0.25);

  const step = (sec: number, dt = 0.05) => {
    const steps = Math.ceil(sec / dt);
    for (let i = 0; i < steps; i++) {
      doorSys.update(dt);
      flashbang?.update(dt);
      tearGas?.update(dt);
      entities.update(dt);
      squad.update(dt);
    }
  };

  const cleanup = () => {
    squad.dispose();
    entities.dispose();
    flashbang?.dispose();
    tearGas?.dispose();
    overlay.dispose();
    for (const d of doorsList) d.dispose();
  };

  return { bus, colliders, doorSys, player, entities, squad, flashbang, tearGas, rooms, step, cleanup };
}

describe('SquadSystem M3 SWAT Parity', () => {
  let restoreDom: () => void;

  beforeEach(() => {
    restoreDom = installMinimalDom();
  });

  afterEach(() => {
    restoreDom();
  });

  it('F1/F6: spawns with SwatProfile stats, HP 100, SWAT_UNIFORM_COLOR, high ready pose, and shield pointman role', () => {
    const h = createHarness({
      allies: [
        { id: 'ally_1', name: 'Miller', x: -1, z: 4, yaw: 0 },
        { id: 'ally_2', name: 'Cole', x: 1, z: 4, yaw: 0 },
      ],
    });
    try {
      const roster = h.squad.getRoster();
      expect(roster).toHaveLength(2);
      expect(roster[0]!.hp).toBe(SWAT_HP);
      expect(roster[0]!.maxHp).toBe(SWAT_HP);
      expect(roster[1]!.hp).toBe(SWAT_HP);

      // Inspect internal ally profiles via runtime object
      const internalAllies = (h.squad as unknown as {
        allies: {
          shielded: boolean;
          combat: typeof BASE_SWAT_COMBAT;
          body: { hasShield: boolean; baseColor?: number; readyPose?: string };
        }[];
      }).allies;

      expect(internalAllies[0]!.shielded).toBe(true);
      expect(internalAllies[0]!.body.hasShield).toBe(true);
      expect(internalAllies[0]!.combat.moveSpeed).toBe(BASE_SHIELD_COMBAT.moveSpeed);
      expect(internalAllies[0]!.combat.fireInterval).toBe(BASE_SHIELD_COMBAT.fireInterval);
      expect(internalAllies[0]!.combat.shotDamage).toBe(BASE_SHIELD_COMBAT.shotDamage);
      expect(internalAllies[0]!.combat.magazineSize).toBe(BASE_SHIELD_COMBAT.magazineSize);
      expect(internalAllies[0]!.combat.flinchSec).toBe(BASE_SHIELD_COMBAT.flinchSec);

      expect(internalAllies[1]!.shielded).toBe(false);
      expect(internalAllies[1]!.body.hasShield).toBe(false);
      expect(internalAllies[1]!.combat.moveSpeed).toBe(BASE_SWAT_COMBAT.moveSpeed);
      expect(internalAllies[1]!.combat.fireInterval).toBe(BASE_SWAT_COMBAT.fireInterval);
      expect(internalAllies[1]!.combat.shotDamage).toBe(BASE_SWAT_COMBAT.shotDamage);
      expect(internalAllies[1]!.combat.magazineSize).toBe(BASE_SWAT_COMBAT.magazineSize);
      expect(internalAllies[1]!.combat.flinchSec).toBe(BASE_SWAT_COMBAT.flinchSec);

      // Uniform color and high ready pose
      expect((internalAllies[0]!.body as unknown as { baseColor: number }).baseColor).toBe(SWAT_UNIFORM_COLOR);
      expect((internalAllies[0]!.body as unknown as { readyPose: string }).readyPose).toBe('high');
      h.step(0.2);
      expect((internalAllies[1]!.body as unknown as { readyPose: string }).readyPose).toBe('high');
    } finally {
      h.cleanup();
    }
  });

  it('F2/F3: uses EngageBehavior for instant contact fire, ally noise source, no suspectFired leak, and clears setFlash(false) after flinch', () => {
    const h = createHarness({
      allies: [
        { id: 'ally_1', name: 'Miller', x: -1, z: 4, yaw: 0 },
        { id: 'ally_2', name: 'Cole', x: 1, z: 4, yaw: 0 },
      ],
      entities: [{ id: 's1', type: 'suspect', x: 0, z: -2, yaw: 180, profile: 'hostile', hp: 200 }],
    });
    try {
      const suspectFiredIds: string[] = [];
      const allyNoises: string[] = [];
      const allyHits: { weaponId?: string; damage: number }[] = [];
      const shotsFired: string[] = [];
      h.bus.on('suspectFired', (e) => suspectFiredIds.push(e.id));
      h.bus.on('noise', (e) => {
        if (e.kind === 'gunshot' && e.source === 'ally') allyNoises.push(e.source);
      });
      h.bus.on('entityHit', (e) => {
        if (e.shooter.startsWith('ally_')) allyHits.push({ weaponId: e.weaponId, damage: e.damage });
      });
      h.bus.on('shotFired', (e) => {
        if (e.shooter.startsWith('ally_')) shotsFired.push(e.shooter);
      });

      // Provoke suspect so squad engages immediately
      h.bus.emit('suspectFired', { id: 's1', pos: { x: 0, y: 1.2, z: -2 }, warned: true });
      h.step(0.5);

      expect(shotsFired.length).toBeGreaterThan(0);
      expect(allyNoises.length).toBeGreaterThan(0);
      // EngageBehavior bus adapter must suppress suspectFired for ally shooters
      expect(suspectFiredIds.filter((id) => id.startsWith('ally_'))).toHaveLength(0);
      if (allyHits.length > 0) {
        expect(['pistol', 'rifle']).toContain(allyHits[0]!.weaponId);
      }

      // Test flinch / setFlash(false) bug fix
      const internalAlly = (h.squad as unknown as {
        allies: { id: string; flinchLeft: number; body: { cloth: THREE.MeshStandardMaterial } }[];
      }).allies[1]!;
      h.bus.emit('entityHit', { targetId: 'ally_2', shooter: 's1', damage: 10, pos: { x: 1, y: 1.2, z: 4 } });
      expect(internalAlly.flinchLeft).toBeGreaterThan(0);
      h.step(0.5);
      expect(internalAlly.flinchLeft).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('F6: applies flash blind on enemy flashDetonated and grants immunity to player/ally thrown flashbangs', () => {
    const h = createHarness({
      allies: [{ id: 'ally_1', name: 'Miller', x: 0, z: 4, yaw: 0 }],
    });
    try {
      const internalAlly = (h.squad as unknown as {
        allies: { blindLeft: number; optics: { group: THREE.Group } }[];
      }).allies[0]!;

      // Friendly throws must NOT blind
      h.bus.emit('flashDetonated', { pos: { x: 0, y: 1.2, z: 3 }, radius: 8, blindSec: 3.0, thrower: 'player' });
      expect(internalAlly.blindLeft).toBe(0);

      h.bus.emit('flashDetonated', { pos: { x: 0, y: 1.2, z: 3 }, radius: 8, blindSec: 3.0, thrower: 'ally_1' });
      expect(internalAlly.blindLeft).toBe(0);

      // Enemy throw MUST blind and hide optics
      h.bus.emit('flashDetonated', { pos: { x: 0, y: 1.2, z: 3 }, radius: 8, blindSec: 2.0, thrower: 'suspect_1' });
      expect(internalAlly.blindLeft).toBeGreaterThan(0);
      h.step(0.1);
      expect(internalAlly.optics.group.visible).toBe(false);

      // Recovers after blind duration
      h.step(2.5);
      expect(internalAlly.blindLeft).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('F11: switches to nonlethal pepperball on HOSTAGE_SHIELD or when civilian blocks lethal LOS', () => {
    const h = createHarness({
      allies: [{ id: 'ally_1', name: 'Miller', x: 0, z: 6, yaw: 0 }],
      entities: [
        { id: 's1', type: 'suspect', x: 0, z: 0, yaw: 180, profile: 'hostile', hp: 100 },
        { id: 'c1', type: 'civilian', x: 0, z: 3, yaw: 0, profile: 'civ' },
      ],
    });
    try {
      const pepperHits: { weaponId?: string; nonlethal?: boolean; damage: number }[] = [];
      const lethalHits: number[] = [];
      h.bus.on('entityHit', (e) => {
        if (e.shooter !== 'ally_1') return;
        if (e.nonlethal) pepperHits.push({ weaponId: e.weaponId, nonlethal: e.nonlethal, damage: e.damage });
        else lethalHits.push(e.damage);
      });

      // Provoke suspect while civilian stands directly between ally and suspect
      h.bus.emit('suspectFired', { id: 's1', pos: { x: 0, y: 1.2, z: 0 }, warned: true });
      h.step(1.0);

      expect(lethalHits).toHaveLength(0);
      expect(pepperHits.length).toBeGreaterThan(0);
      expect(pepperHits[0]!.weaponId).toBe('pepperball');
      expect(pepperHits[0]!.damage).toBe(0);
      expect(h.entities.civilians.get('c1')!.alive).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('F4: triggers weakness rush on low-HP/flashed hostile suspect while respecting hold order lock', () => {
    const h = createHarness({
      allies: [
        { id: 'ally_1', name: 'Miller', x: -1, z: 6, yaw: 0 },
        { id: 'ally_2', name: 'Cole', x: 1, z: 6, yaw: 0 },
      ],
      entities: [{ id: 's1', type: 'suspect', x: 0, z: 0, yaw: 180, profile: 'hostile', hp: 30 }],
    });
    try {
      // Put ally_2 in hold order
      const internalAllies = (h.squad as unknown as {
        allies: { id: string; order: string; phase: string; rushTimer: number; body: { px: number; pz: number } }[];
      }).allies;
      internalAllies[1]!.order = 'hold';
      internalAllies[1]!.phase = 'hold';
      const holdStartX = internalAllies[1]!.body.px;
      const holdStartZ = internalAllies[1]!.body.pz;

      h.bus.emit('suspectFired', { id: 's1', pos: { x: 0, y: 1.2, z: 0 }, warned: true });
      h.step(0.6);

      // ally_1 rushes; ally_2 stays anchored in hold
      expect(internalAllies[0]!.rushTimer).toBeGreaterThan(0);
      expect(internalAllies[1]!.rushTimer).toBe(0);
      expect(Math.hypot(internalAllies[1]!.body.px - holdStartX, internalAllies[1]!.body.pz - holdStartZ)).toBeLessThan(0.5);
    } finally {
      h.cleanup();
    }
  });

  it('F5: fires ROE-safe suppressive bursts when LOS is lost after engagement', () => {
    // Wall blocks LOS after suspect moves behind it
    const wall = makeBoxCollider(3, 0, 2, 2.5, 2.6, 0.3, 'wall');
    const h = createHarness({
      allies: [{ id: 'ally_1', name: 'Miller', x: 0, z: 6, yaw: 0 }],
      entities: [{ id: 's1', type: 'suspect', x: 0, z: 0, yaw: 180, profile: 'hostile', hp: 200 }],
      colliders: [wall],
    });
    try {
      h.bus.emit('suspectFired', { id: 's1', pos: { x: 0, y: 1.2, z: 0 }, warned: true });
      h.step(0.25);

      // Move suspect behind wall so LOS is broken
      const s1 = h.entities.suspects.get('s1')!;
      s1.body.setPosition(3, 0, 0);

      let suppressShots = 0;
      h.bus.on('shotFired', (e) => {
        if (e.shooter === 'ally_1') suppressShots++;
      });

      h.step(1.5);
      expect(suppressShots).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it('F8: executes full C2 breach (plant, standoff, beep, breachExplosive, c2Detonated, blast cone) with zero dynamic lights and civilian/player safety', () => {
    const bus = createGameEventBus();
    const door = new Door(
      { id: 'd_lock', x: 0, z: 0, yaw: 0, locked: true, maxAngle: 95 },
      DEFAULT_DOOR_CFG,
      2.6,
      bus,
    );
    const h = createHarness({
      allies: [
        { id: 'ally_1', name: 'Miller', x: -0.6, z: 1.0, yaw: 0 },
        { id: 'ally_2', name: 'Cole', x: 0.6, z: 1.0, yaw: 0 },
      ],
      entities: [
        { id: 's_hostile', type: 'suspect', x: 0, z: -2.0, yaw: 0, profile: 'hostile', hp: 100 },
        { id: 'c_safe', type: 'civilian', x: 0.4, z: -1.8, yaw: 0, profile: 'civ' },
      ],
      doors: [door],
      rooms: [
        { id: 'hall', name: 'Hall', x: 0, z: 4, width: 10, depth: 8, floorY: 0 },
        { id: 'target', name: 'Target', x: 0, z: -4, width: 10, depth: 8, floorY: 0 },
      ],
      playerPos: { x: 0, y: 0, z: 2.5 },
    });
    try {
      const beeps: boolean[] = [];
      let detonatedCount = 0;
      h.bus.on('c2Beep', (e) => beeps.push(e.urgent));
      h.bus.on('c2Detonated', () => detonatedCount++);

      // Issue c2Clear directly via executeOrder
      (h.squad as unknown as {
        executeOrder: (o: string, ctx: Record<string, unknown>) => void;
      }).executeOrder('c2Clear', {
        element: 'gold',
        door,
        areaTarget: null,
        groundPoint: null,
        restrainTarget: null,
      });

      const hpBefore = h.entities.suspects.get('s_hostile')!.hp;
      // Step through stack + plant (0.8s) + fuse (1.8s) + blast
      h.step(SWAT_C2_PLANT_SEC + SWAT_C2_FUSE_SEC + 2.0);

      expect(beeps.length).toBeGreaterThanOrEqual(2);
      expect(beeps.some((u) => u === true)).toBe(true);
      expect(detonatedCount).toBe(1);
      expect(door.locked).toBe(false);
      expect(door.targetAngle).toBeGreaterThanOrEqual(80);
      // Hostile suspect behind door takes C2 blast damage
      expect(h.entities.suspects.get('s_hostile')!.hp).toBeLessThan(hpBefore);
      // Civilian and player are completely unharmed
      expect(h.entities.civilians.get('c_safe')!.alive).toBe(true);
      expect(h.player.hp).toBe(100);
      // Zero dynamic lights invariant!
      expect(countDynamicLights(h.squad.root)).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('F7/F9: deploys real Flashbang on flashClear and real TearGas on gasClear with SWAT gas-mask immunity', () => {
    const bus = createGameEventBus();
    const door = new Door(
      { id: 'd_open', x: 0, z: 0, yaw: 0, locked: false, maxAngle: 95 },
      DEFAULT_DOOR_CFG,
      2.6,
      bus,
    );
    door.angle = 90;
    door.targetAngle = 90;

    const h = createHarness({
      allies: [{ id: 'ally_1', name: 'Miller', x: -0.6, z: 1.0, yaw: 0 }],
      doors: [door],
      rooms: [
        { id: 'hall', name: 'Hall', x: 0, z: 4, width: 10, depth: 8, floorY: 0 },
        { id: 'target', name: 'Target', x: 0, z: -4, width: 10, depth: 8, floorY: 0 },
      ],
      playerPos: { x: 0, y: 0, z: 3 },
      withGadgets: true,
    });
    try {
      let flashDetonations = 0;
      let gasDetonations = 0;
      h.bus.on('flashDetonated', () => flashDetonations++);
      h.bus.on('gasDetonated', () => gasDetonations++);

      const exec = (o: string) =>
        (h.squad as unknown as { executeOrder: (o: string, ctx: Record<string, unknown>) => void }).executeOrder(o, {
          element: 'gold',
          door,
          areaTarget: null,
          groundPoint: null,
          restrainTarget: null,
        });

      exec('flashClear');
      h.step(2.0);
      expect(flashDetonations).toBeGreaterThanOrEqual(1);

      // Reset ally near door and issue gasClear
      const internalAlly = (h.squad as unknown as {
        allies: { hp: number; blindLeft: number; body: { setPosition: (x: number, z: number, y: number) => void } }[];
      }).allies[0]!;
      internalAlly.body.setPosition(-0.6, 1.0, 0);
      exec('gasClear');
      h.step(2.5);
      expect(gasDetonations).toBeGreaterThanOrEqual(1);
      // SWAT ally has gas-mask immunity (full HP, not blinded)
      expect(internalAlly.hp).toBe(SWAT_HP);
      expect(internalAlly.blindLeft).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('F10: keeps ALPHA and BRAVO on the ordered door on GOLD clear of a two-door room (no automatic split entry)', () => {
    const bus = createGameEventBus();
    const doorSouth = new Door(
      { id: 'd_south', x: 0, z: 4, yaw: 0, locked: false, maxAngle: 95 },
      DEFAULT_DOOR_CFG,
      2.6,
      bus,
    );
    const doorNorth = new Door(
      { id: 'd_north', x: 0, z: -4, yaw: 0, locked: false, maxAngle: 95 },
      DEFAULT_DOOR_CFG,
      2.6,
      bus,
    );
    const h = createHarness({
      allies: [
        { id: 'ally_1', name: 'Miller', x: -1, z: 6, yaw: 0 },
        { id: 'ally_2', name: 'Cole', x: 1, z: 6, yaw: 0 },
        { id: 'ally_3', name: 'Vance', x: -1, z: 7, yaw: 0 },
        { id: 'ally_4', name: 'Reed', x: 1, z: 7, yaw: 0 },
      ],
      doors: [doorSouth, doorNorth],
      rooms: [{ id: 'center', name: 'Center', x: 0, z: 0, width: 8, depth: 8, floorY: 0 }],
      playerPos: { x: 0, y: 0, z: 8 },
    });
    try {
      (h.squad as unknown as {
        executeOrder: (o: string, ctx: Record<string, unknown>) => void;
      }).executeOrder('clear', {
        element: 'gold',
        door: doorSouth,
        areaTarget: null,
        groundPoint: null,
        restrainTarget: null,
      });

      const internalAllies = (h.squad as unknown as {
        allies: { elementKey: string; entryPortal: { id: string } | null }[];
      }).allies;
      const alphaPortals = new Set(internalAllies.filter((a) => a.elementKey === 'alpha').map((a) => a.entryPortal?.id));
      const bravoPortals = new Set(internalAllies.filter((a) => a.elementKey === 'bravo').map((a) => a.entryPortal?.id));

      expect(alphaPortals).toEqual(new Set(['d_south']));
      expect(bravoPortals).toEqual(new Set(['d_south']));
    } finally {
      h.cleanup();
    }
  });

  it('F12/F13/F14: attaches zero-light TacticalOptics, emits swatFootstep, staggers allyRadio, and preserves tryWarn ROE', () => {
    const h = createHarness({
      allies: [
        { id: 'ally_1', name: 'Miller', x: -1, z: 5, yaw: 0 },
        { id: 'ally_2', name: 'Cole', x: 1, z: 5, yaw: 0 },
      ],
      entities: [{ id: 's_unwarned', type: 'suspect', x: 0, z: 1, yaw: 180, profile: 'hostile', hp: 100 }],
      playerPos: { x: 0, y: 0, z: 0 },
    });
    try {
      const footsteps: { heavy: boolean }[] = [];
      const radios: { t: number; text: string }[] = [];
      let simTime = 0;
      h.bus.on('swatFootstep', (e) => footsteps.push({ heavy: e.heavy }));
      h.bus.on('allyRadio', (e) => radios.push({ t: simTime, text: e.text }));

      // Zero dynamic lights in squad root
      expect(countDynamicLights(h.squad.root)).toBe(0);

      // Step so allies move toward player (emitting footsteps) and warn unprovoked suspect without shooting
      let lethalShots = 0;
      h.bus.on('entityHit', (e) => {
        if (e.shooter.startsWith('ally_') && !e.nonlethal) lethalShots++;
      });

      // Queue two radio messages back-to-back to verify radioQueue staggering
      const emitRadio = (h.squad as unknown as {
        emitRadio: (a: unknown, text: string, voice?: string) => void;
        allies: unknown[];
      });
      emitRadio.emitRadio(emitRadio.allies[0]!, 'First call', 'First');
      emitRadio.emitRadio(emitRadio.allies[1]!, 'Second call', 'Second');
      expect(radios).toHaveLength(1); // First emits immediately, second is queued

      // Give s_unwarned morale=22 (just above surrenderBelow=20) so tryWarn warns AND induces surrender
      h.entities.suspects.get('s_unwarned')!.morale.shift(-68);

      for (let i = 0; i < 40; i++) {
        simTime += 0.05;
        h.step(0.05, 0.05);
      }

      expect(radios.length).toBeGreaterThanOrEqual(2);
      expect(radios[1]!.t - radios[0]!.t).toBeGreaterThanOrEqual(SWAT_RADIO_STAGGER_SEC - 0.1);
      expect(footsteps.length).toBeGreaterThan(0);
      // Shielded ally (index 0) emits heavy footsteps
      expect(footsteps.some((f) => f.heavy)).toBe(true);
      // Unprovoked barricaded suspect was warned and entered HESITATE/SURRENDER rather than shot
      expect(h.entities.suspects.get('s_unwarned')!.warned).toBe(true);
      expect([SuspectState.HESITATE, SuspectState.SURRENDER]).toContain(h.entities.suspects.get('s_unwarned')!.state);
      expect(lethalShots).toBe(0);
      // Public API preservation
      expect(h.squad.getLivingAllies()).toHaveLength(2);
      expect(h.squad.getMinimapAllies()).toHaveLength(2);
      expect(h.squad.countAlliesCovering({ x: 0, y: 1.2, z: 1 }, 10)).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });
});
