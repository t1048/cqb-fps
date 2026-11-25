import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus, SuspectState, type GameEventBus } from '../../src/core/events';
import type { AIProfile, AllyDef, ArrestConfig, EntityDef, RoomDef, SquadConfig, Vec3 } from '../../src/core/types';
import type { InputManager } from '../../src/core/InputManager';
import type { PlayerController } from '../../src/player/PlayerController';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { DoorSystem } from '../../src/world/Door';
import type { Collider } from '../../src/world/WorldBuilder';
import type { TextureLibrary } from '../../src/world/Materials';
import { EntityManager } from '../../src/ai/EntityManager';
import { SquadSystem } from '../../src/ai/Squad';
import { CommandMenu, type AreaClearTarget } from '../../src/ui/CommandMenu';
import { hasLineOfSight } from '../../src/weapons/Flashbang';

function installMinimalDom() {
  const g = globalThis as unknown as Record<string, unknown>;
  const makeEl = () => {
    const children: unknown[] = [];
    const el: Record<string, unknown> = {
      style: {} as Record<string, string>,
      className: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
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
        contains: () => false,
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
      querySelectorAll: () => [],
      querySelector: () => null,
      getContext: () => ({
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
      }),
    };
    return el;
  };
  const prevWin = g.window;
  const prevDoc = g.document;
  g.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 720 };
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
  warningInterval: 1.5,
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

const SUSPECT_PROFILE: AIProfile = {
  id: 'suspect_std',
  initialMorale: 80,
  moraleRecovery: 0.5,
  thresholds: { surrenderBelow: 20, hesitateBelow: 55 },
  modifiers: { warningCall: 15, flashbang: 35, breach: 20, nonlethalHit: 30, isolation: 10 },
} as unknown as AIProfile;

function makeBoxCollider(
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  kind: Collider['kind'] = 'wall',
): Collider {
  return {
    kind,
    aabb: {
      min: { x: x - w / 2, y, z: z - d / 2 },
      max: { x: x + w / 2, y: y + h, z: z + d / 2 },
    },
  };
}

function makeStubPlayer(pos: Vec3 = { x: 0, y: 0, z: 3.5 }, yawRad = 0) {
  const position = new THREE.Vector3(pos.x, pos.y, pos.z);
  return {
    position,
    yawRad,
    pitchRad: 0,
    alive: true,
    isCrouching: false,
    get hp() {
      return 100;
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
    inCameraView: () => false,
    takeDamage: () => 100,
  } as unknown as PlayerController & { yawRad: number; pitchRad: number };
}

interface InternalAlly {
  id: string;
  phase: string;
  order: string;
  entered: boolean;
  settled: boolean;
  rushTimer: number;
  pincerTarget: Vec3 | null;
  coverHold: { suspectId: string; threatPos: Vec3; hide: { x: number; z: number }; peek: { x: number; z: number }; lostSec: number } | null;
  body: { px: number; pz: number; footY: number; yawRad: number; chestPos: () => Vec3 };
}

interface InternalSquad {
  allies: InternalAlly[];
  executeOrder: (order: string, ctx: Record<string, unknown>) => void;
}

/**
 * 3 consecutive rooms connected by open archways (no doors):
 * Room A: x∈[-4, 4], z∈[0, 6]   (center 0, 3)
 * Room B: x∈[-4, 4], z∈[-6, 0]  (center 0, -3)
 * Room C: x∈[-4, 4], z∈[-12, -6] (center 0, -9)
 * Archways at z=0 and z=-6, opening x∈[-0.8, 0.8].
 */
function createThreeOpenRoomsHarness(opts?: {
  suspects?: EntityDef[];
  allies?: AllyDef[];
  playerPos?: Vec3;
  playerYaw?: number;
}) {
  const bus: GameEventBus = createGameEventBus();
  const rooms: RoomDef[] = [
    { id: 'room_a', name: 'Room A', x: 0, z: 3, width: 8, depth: 6, floorY: 0 },
    { id: 'room_b', name: 'Room B', x: 0, z: -3, width: 8, depth: 6, floorY: 0 },
    { id: 'room_c', name: 'Room C', x: 0, z: -9, width: 8, depth: 6, floorY: 0 },
  ];
  const colliders: Collider[] = [
    makeBoxCollider(0, -0.2, -3, 20, 0.2, 30, 'floor'),
    // Outer perimeter
    makeBoxCollider(-4, 0, -3, 0.2, 2.8, 18.2, 'wall'),
    makeBoxCollider(4, 0, -3, 0.2, 2.8, 18.2, 'wall'),
    makeBoxCollider(0, 0, 6, 8.2, 2.8, 0.2, 'wall'),
    makeBoxCollider(0, 0, -12, 8.2, 2.8, 0.2, 'wall'),
    // Divider A <-> B at z=0 with 1.6m open archway x∈[-0.8, 0.8]
    makeBoxCollider(-2.4, 0, 0, 3.2, 2.8, 0.2, 'wall'),
    makeBoxCollider(2.4, 0, 0, 3.2, 2.8, 0.2, 'wall'),
    // Divider B <-> C at z=-6 with 1.6m open archway x∈[-0.8, 0.8]
    makeBoxCollider(-2.4, 0, -6, 3.2, 2.8, 0.2, 'wall'),
    makeBoxCollider(2.4, 0, -6, 3.2, 2.8, 0.2, 'wall'),
  ];
  const doorSys = {
    doors: [],
    aimed: () => null,
    update() {},
  } as unknown as DoorSystem;
  const player = makeStubPlayer(opts?.playerPos ?? { x: 0, y: 0, z: 3.5 }, opts?.playerYaw ?? 0);
  const input = {
    isPointerLocked: false,
    suppressSquadShortcuts: false,
    isOrderMenuOpen: false,
    onOrderMenu: undefined,
    wasPressed: () => false,
    isDown: () => false,
  } as unknown as InputManager;
  const weapons = {
    suppressFire: false,
    addTarget() {},
    removeTarget() {},
  } as unknown as WeaponSystem;
  const textures = { get: () => undefined } as unknown as TextureLibrary;
  const entities = new EntityManager(
    opts?.suspects ?? [],
    [SUSPECT_PROFILE],
    weapons,
    colliders,
    { range: 12, angleDeg: 60, cooldown: 1.0 },
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
    { doors: doorSys, bounds: { width: 20, depth: 30 }, stairs: [] },
    false,
    null,
  );
  const allyDefs: AllyDef[] = opts?.allies ?? [
    { id: 'ally_1', name: 'Miller', x: -1.4, z: 1.5, yaw: 0 },
    { id: 'ally_2', name: 'Cole', x: 1.4, z: 1.5, yaw: 0 },
    { id: 'ally_3', name: 'Vance', x: -1.6, z: 2.8, yaw: 0 },
    { id: 'ally_4', name: 'Reyes', x: 1.6, z: 2.8, yaw: 0 },
  ];
  const squad = new SquadSystem(
    allyDefs,
    DEFAULT_SQUAD_CFG,
    player,
    input,
    colliders,
    { width: 20, depth: 30 },
    [],
    doorSys,
    entities,
    bus,
    textures,
    weapons,
    { range: 8, blindSec: 3.5 },
    rooms,
    DEFAULT_ARREST_CFG,
  );
  const menu = new CommandMenu(DEFAULT_SQUAD_CFG, player, doorSys, colliders, entities, rooms);
  const internal = squad as unknown as InternalSquad;

  const areaTargetForRoomB: AreaClearTarget = {
    room: rooms[1]!,
    entryX: 0,
    entryY: 0,
    entryZ: 0,
    intoX: 0,
    intoZ: -1,
    axisX: 1,
    axisZ: 0,
    width: 1.6,
    door: null,
  };

  const tick = (dt = 0.05) => {
    entities.update(dt);
    squad.update(dt);
  };

  return {
    rooms,
    colliders,
    player,
    entities,
    squad,
    menu,
    internal,
    areaTargetForRoomB,
    tick,
    dispose() {
      menu.dispose();
      squad.dispose();
    },
  };
}

describe('open-area one-room clearing and wall-cover warning', () => {
  let restoreDom: () => void;

  beforeEach(() => {
    restoreDom = installMinimalDom();
  });
  afterEach(() => {
    restoreDom();
  });

  it('CommandMenu.findAreaTarget selects immediate adjacent Room B even when aiming near the archway jamb toward Room C', () => {
    // Player in Room A aiming through Room B toward Room C center (0, -6)
    const h = createThreeOpenRoomsHarness({ playerPos: { x: 0, y: 0, z: 2.5 }, playerYaw: 0 });
    try {
      // 1. Straight through center of archway A->B into Room C
      const ctxCenter = h.menu.resolveContext('gold');
      expect(ctxCenter.areaTarget?.room.id).toBe('room_b');

      // 2. Slightly off-center so ray grazes Room B's left jamb (x=-0.60 at z=0, < bodyRadius from -0.8)
      // while passing cleanly through center of archway B->C (x=0 at z=-6)
      h.player.position.set(-0.85, 0, 2.5);
      // dir = (0.85, -8.5) normalized => -sin(yaw) > 0 => yaw < 0
      h.player.yawRad = -Math.atan2(0.85, 8.5);
      const ctxJamb = h.menu.resolveContext('gold');
      expect(ctxJamb.areaTarget?.room.id).toBe('room_b');

      // 3. Mirror on right jamb (x=+0.60 at z=0) toward Room C center (0, -6)
      h.player.position.set(0.85, 0, 2.5);
      h.player.yawRad = Math.atan2(0.85, 8.5);
      const ctxRightJamb = h.menu.resolveContext('gold');
      expect(ctxRightJamb.areaTarget?.room.id).toBe('room_b');
    } finally {
      h.dispose();
    }
  });

  it('clears only Room B and reaches secured without any ally entering Room C', () => {
    const h = createThreeOpenRoomsHarness();
    try {
      h.internal.executeOrder('clear', {
        element: 'gold',
        door: null,
        areaTarget: h.areaTargetForRoomB,
        groundPoint: null,
        restrainTarget: null,
        aimDir: { x: 0, z: -1 },
      });

      let everEnteredRoomC = false;
      for (let i = 0; i < 400; i++) {
        h.tick(0.05);
        for (const ally of h.internal.allies) {
          if (ally.body.pz < -6.1) everEnteredRoomC = true;
        }
      }

      expect(everEnteredRoomC).toBe(false);
      for (const ally of h.internal.allies) {
        expect(ally.phase).toBe('secured');
        expect(ally.body.pz).toBeLessThanOrEqual(0.25);
        expect(ally.body.pz).toBeGreaterThanOrEqual(-6.1);
        expect(Math.abs(ally.body.px)).toBeLessThanOrEqual(4.1);
      }
    } finally {
      h.dispose();
    }
  });

  it('when an unwarned BARRICADED suspect is visible in Room C, allies stay in Room B, take wall cover, and warn for surrender', () => {
    const h = createThreeOpenRoomsHarness({
      suspects: [{ id: 's_next', type: 'suspect', profile: 'suspect_std', x: 0, z: -8.5, yaw: 180 }],
    });
    try {
      const suspect = h.entities.suspects.get('s_next')!;
      const initialMorale = suspect.morale.value;

      h.internal.executeOrder('clear', {
        element: 'gold',
        door: null,
        areaTarget: h.areaTargetForRoomB,
        groundPoint: null,
        restrainTarget: null,
        aimDir: { x: 0, z: -1 },
      });

      let everEnteredRoomC = false;
      let everRushed = false;
      let everPincered = false;
      let tookWallCoverInRoomB = false;

      for (let i = 0; i < 360; i++) {
        h.tick(0.05);
        const sChest = suspect.body.chestPos();
        for (const ally of h.internal.allies) {
          if (ally.body.pz < -6.1) everEnteredRoomC = true;
          if (ally.rushTimer > 0) everRushed = true;
          if (ally.pincerTarget !== null) everPincered = true;
          if (
            ally.coverHold !== null &&
            ally.body.pz <= 0.1 &&
            ally.body.pz >= -6.0 &&
            !hasLineOfSight(h.colliders, sChest, ally.body.chestPos())
          ) {
            tookWallCoverInRoomB = true;
          }
        }
      }

      expect(everEnteredRoomC).toBe(false);
      expect(everRushed).toBe(false);
      expect(everPincered).toBe(false);
      expect(tookWallCoverInRoomB).toBe(true);
      expect(suspect.warned).toBe(true);
      expect(suspect.morale.value).toBeLessThan(initialMorale);
      expect([SuspectState.HESITATE, SuspectState.SURRENDER, SuspectState.CONFRONTATION]).toContain(suspect.state);
    } finally {
      h.dispose();
    }
  });

  it('when a hostile low-HP ENGAGE suspect is visible in Room C, allies do not rush/pincer/chase into Room C and instead take wall cover and warn', () => {
    const h = createThreeOpenRoomsHarness({
      suspects: [{ id: 's_hostile', type: 'suspect', profile: 'suspect_std', hp: 40, x: 1.8, z: -8.5, yaw: 180 }],
    });
    try {
      const suspect = h.entities.suspects.get('s_hostile')!;
      // Force ENGAGE state with low HP (<= SWAT_RUSH_LOW_HP) that would normally trigger rush + pincer
      (suspect as unknown as { setState: (s: SuspectState) => void }).setState(SuspectState.ENGAGE);
      const initialMorale = suspect.morale.value;

      h.internal.executeOrder('clear', {
        element: 'gold',
        door: null,
        areaTarget: h.areaTargetForRoomB,
        groundPoint: null,
        restrainTarget: null,
        aimDir: { x: 0, z: -1 },
      });

      let everEnteredRoomC = false;
      let everRushed = false;
      let everPincered = false;
      let tookWallCoverInRoomB = false;

      for (let i = 0; i < 320; i++) {
        h.tick(0.05);
        const sChest = suspect.body.chestPos();
        for (const ally of h.internal.allies) {
          if (ally.body.pz < -6.1) everEnteredRoomC = true;
          if (ally.rushTimer > 0) everRushed = true;
          if (ally.pincerTarget !== null) everPincered = true;
          if (
            ally.coverHold !== null &&
            ally.body.pz <= 0.1 &&
            ally.body.pz >= -6.0 &&
            !hasLineOfSight(h.colliders, sChest, ally.body.chestPos())
          ) {
            tookWallCoverInRoomB = true;
          }
        }
      }

      expect(everEnteredRoomC).toBe(false);
      expect(everRushed).toBe(false);
      expect(everPincered).toBe(false);
      expect(tookWallCoverInRoomB).toBe(true);
      expect(suspect.warned).toBe(true);
      expect(suspect.morale.value).toBeLessThan(initialMorale);
    } finally {
      h.dispose();
    }
  });
});
