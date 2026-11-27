import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  computeCornerLean,
  computeStackLookPoint,
  computeStepOutPoint,
  cqbPortalFromStackSlotPortal,
  cqbRoomFromRoomDef,
  planDoorPieArc,
  planEntry,
  portalLeanToBodyLean,
  shouldUseLowReady,
  toPortalFrame,
  type CqbPortal,
  type CqbRoom,
  type XZ,
} from '../../src/ai/cqbEntry';
import { layoutStackSlots, type StackSlotPortal } from '../../src/ai/stackSlots';
import { HumanoidBody } from '../../src/ai/HumanoidBody';
import { EntityManager } from '../../src/ai/EntityManager';
import { SquadSystem } from '../../src/ai/Squad';
import { createGameEventBus, SuspectState, type GameEventBus } from '../../src/core/events';
import type { AIProfile, AllyDef, ArrestConfig, RoomDef, SquadConfig, Vec3 } from '../../src/core/types';
import type { InputManager } from '../../src/core/InputManager';
import type { PlayerController } from '../../src/player/PlayerController';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { Flashbang } from '../../src/weapons/Flashbang';
import type { Subtitle } from '../../src/ui/Subtitle';
import { Door, type DoorConfig, type DoorSystem } from '../../src/world/Door';
import type { Collider } from '../../src/world/WorldBuilder';
import type { TextureLibrary } from '../../src/world/Materials';
import { SwatTeam, type SwatTeamDeps } from '../../src/modes/SwatTeam';

// 南壁 (z=0) 中央のドア。屋内は +z。axis=+x。部屋は x∈[-3,3], z∈[0,6]
const SP: StackSlotPortal = { centerX: 0, centerZ: 0, intoX: 0, intoZ: 1, axisX: 1, axisZ: 0, width: 0.9 };
const portal: CqbPortal = cqbPortalFromStackSlotPortal(SP, 0);
const room: CqbRoom = cqbRoomFromRoomDef({ x: 0, z: 3, width: 6, depth: 6 });
const outsideStandable = (_x: number, z: number): boolean => z < -0.05;
const slots4 = layoutStackSlots(SP, 4, 0.35, 0.6, outsideStandable);

const inRoom = (p: XZ): boolean =>
  Math.abs(p.x - room.x) <= room.width / 2 && Math.abs(p.z - room.z) <= room.depth / 2;

describe('HumanoidBody ready pose and lean', () => {
  it('sets and gets readyPose between low and high', () => {
    const body = new HumanoidBody(0, 0, 0, 0x334455, true);
    try {
      body.setReadyPose('low');
      expect(body.getReadyPose()).toBe('low');

      body.setReadyPose('high');
      expect(body.getReadyPose()).toBe('high');

      body.setReadyPose('low');
      expect(body.getReadyPose()).toBe('low');
    } finally {
      body.dispose();
    }
  });

  it('smoothly blends lean toward +1 and shifts chestPos to local right (+X when yaw=0)', () => {
    const body = new HumanoidBody(0, 0, 0, 0x334455, true);
    try {
      const baseChest = body.chestPos();
      expect(body.getLean()).toBe(0);

      body.setLean(1);
      body.tick(0.05);
      const afterOneTick = body.getLean();
      expect(afterOneTick).toBeGreaterThan(0);
      expect(afterOneTick).toBeLessThan(1);

      for (let i = 0; i < 30; i++) body.tick(0.05);
      expect(body.getLean()).toBeGreaterThan(0.99);

      const leanedChest = body.chestPos();
      expect(leanedChest.x).toBeGreaterThan(baseChest.x + 0.1);
      expect(leanedChest.z).toBeCloseTo(baseChest.z, 5);
    } finally {
      body.dispose();
    }
  });

  it('shifts chestPos to local left for setLean(-1) and decays lean back to 0 when pose is down', () => {
    const body = new HumanoidBody(0, 0, 0, 0x334455, true);
    try {
      const baseChest = body.chestPos();
      body.setLean(-1);
      for (let i = 0; i < 30; i++) body.tick(0.05);
      expect(body.getLean()).toBeLessThan(-0.99);

      const leanedChest = body.chestPos();
      expect(leanedChest.x).toBeLessThan(baseChest.x - 0.1);
      expect(leanedChest.z).toBeCloseTo(baseChest.z, 5);

      const leanBeforeDown = body.getLean();
      body.setPose('down');
      body.tick(0.05);
      expect(Math.abs(body.getLean())).toBeLessThan(Math.abs(leanBeforeDown));

      for (let i = 0; i < 40; i++) body.tick(0.05);
      expect(Math.abs(body.getLean())).toBeLessThan(0.01);
    } finally {
      body.dispose();
    }
  });
});

describe('shouldUseLowReady', () => {
  // yaw = 0 => forward = (0, -1), right = (1, 0)
  const selfPos = { x: 0, y: 0, z: 0 };

  it('returns true when a friendly is directly in front within 2.6m on the same floor', () => {
    expect(shouldUseLowReady(selfPos, 0, [{ x: 0, y: 0, z: -1.5 }])).toBe(true);
    expect(shouldUseLowReady(selfPos, 0, [{ x: 0.4, y: 0.2, z: -2.5 }])).toBe(true);
  });

  it('returns false when friendly is behind, far away, on a different floor, or off to the side', () => {
    // Behind
    expect(shouldUseLowReady(selfPos, 0, [{ x: 0, y: 0, z: 1.5 }])).toBe(false);
    // Far away (> 2.6m)
    expect(shouldUseLowReady(selfPos, 0, [{ x: 0, y: 0, z: -2.7 }])).toBe(false);
    // Different floor (|dy| > 0.75)
    expect(shouldUseLowReady(selfPos, 0, [{ x: 0, y: 0.8, z: -1.5 }])).toBe(false);
    expect(shouldUseLowReady(selfPos, 0, [{ x: 0, y: -0.8, z: -1.5 }])).toBe(false);
    // Off to the side (lat > 0.52)
    expect(shouldUseLowReady(selfPos, 0, [{ x: 0.55, y: 0, z: -1.5 }])).toBe(false);
    expect(shouldUseLowReady(selfPos, 0, [{ x: -0.6, y: 0, z: -1.5 }])).toBe(false);
  });

  it('returns true when wallClose is true even with no friendlies', () => {
    expect(shouldUseLowReady(selfPos, 0, [], true)).toBe(true);
  });
});

describe('computeStackLookPoint', () => {
  it('has rear-most member (order=3 of groupSize=4) look behind the portal (v < -2)', () => {
    const look = computeStackLookPoint(portal, 3, 4, 1, 1);
    const frame = toPortalFrame(portal, look);
    expect(frame.v).toBeLessThan(-2);
  });

  it('has point man (rank=0, order=0) look at the doorway (v >= 0)', () => {
    const look = computeStackLookPoint(portal, 0, 4, 0, -1);
    const frame = toPortalFrame(portal, look);
    expect(frame.v).toBeGreaterThanOrEqual(0);
    expect(frame.u).toBeCloseTo(0, 5);
  });
});

describe('planEntry hardCornerLook', () => {
  it('places rank=0 hardCornerLook on the unit own side near the entry wall', () => {
    const plans = planEntry(portal, room, slots4, {
      isStandable: (p: Vec3) => inRoom(p),
      reachable: () => true,
    });
    const rank0Plans = plans.filter((p) => p.rank === 0);
    expect(rank0Plans).toHaveLength(2);

    for (const plan of rank0Plans) {
      const frame = toPortalFrame(portal, plan.hardCornerLook);
      expect(Math.sign(frame.u)).toBe(plan.side);
      expect(frame.v).toBeGreaterThan(0);
      expect(frame.v).toBeLessThan(1.5);
    }
  });
});

describe('planDoorPieArc and portalLeanToBodyLean', () => {
  it('generates standable steps outside the doorway with look points inside the room sweeping monotonically', () => {
    for (const side of [-1, 1] as const) {
      const steps = planDoorPieArc(portal, room, side, {
        isStandable: (p) => outsideStandable(p.x, p.z),
        steps: 5,
      });
      expect(steps).toHaveLength(5);

      const lookUs: number[] = [];
      for (const step of steps) {
        expect(outsideStandable(step.pos.x, step.pos.z)).toBe(true);
        const posFrame = toPortalFrame(portal, step.pos);
        const lookFrame = toPortalFrame(portal, step.look);
        expect(posFrame.v).toBeLessThan(0);
        expect(lookFrame.v).toBeGreaterThan(0);
        lookUs.push(lookFrame.u);
      }

      // side=-1 starts from left (-u) so ray through door sweeps look.u from +u toward -u (decreasing).
      // side=+1 starts from right (+u) so ray through door sweeps look.u from -u toward +u (increasing).
      for (let i = 1; i < lookUs.length; i++) {
        if (side === -1) {
          expect(lookUs[i]!).toBeLessThan(lookUs[i - 1]!);
        } else {
          expect(lookUs[i]!).toBeGreaterThan(lookUs[i - 1]!);
        }
      }
    }
  });

  it('portalLeanToBodyLean returns non-zero lean when portalLeanAxis != 0 and 0 when 0', () => {
    expect(portalLeanToBodyLean(portal, 0, 0)).toBe(0);
    expect(portalLeanToBodyLean(portal, Math.PI, 0)).toBe(0);

    // portal.axis = (+1, 0); at yaw=0, body right = (+1, 0)
    const leanPos = portalLeanToBodyLean(portal, 0, 1);
    const leanNeg = portalLeanToBodyLean(portal, 0, -1);
    expect(leanPos).toBeGreaterThan(0);
    expect(leanNeg).toBeLessThan(0);

    // At yaw=PI (facing +Z, into the room), body right = (-1, 0), opposite to portal.axis
    expect(portalLeanToBodyLean(portal, Math.PI, 1)).toBeLessThan(0);
    expect(portalLeanToBodyLean(portal, Math.PI, -1)).toBeGreaterThan(0);
  });
});

describe('computeStepOutPoint', () => {
  it('finds a lateral standable and clear point perpendicular to the target vector', () => {
    const pos: Vec3 = { x: 0, y: 0, z: 0 };
    const target: Vec3 = { x: 0, y: 0, z: 5 };
    const pt = computeStepOutPoint(
      pos,
      target,
      () => true,
      (p) => p.x > 0, // force picking +X side
      0.78,
    );
    expect(pt).not.toBeNull();
    // Perpendicular to (0, 5) means dz = 0 and |dx| = offset
    const dx = pt!.x - pos.x;
    const dz = pt!.z - pos.z;
    expect(dx * (target.x - pos.x) + dz * (target.z - pos.z)).toBeCloseTo(0, 6);
    expect(Math.hypot(dx, dz)).toBeCloseTo(0.78, 5);
    expect(pt!.x).toBeGreaterThan(0);
  });

  it('returns null when both sides are blocked', () => {
    const pos: Vec3 = { x: 0, y: 0, z: 0 };
    const target: Vec3 = { x: 0, y: 0, z: 5 };

    expect(computeStepOutPoint(pos, target, () => false, () => true)).toBeNull();
    expect(computeStepOutPoint(pos, target, () => true, () => false)).toBeNull();
  });
});

describe('computeCornerLean', () => {
  const pos: Vec3 = { x: 0, y: 0, z: 0 };
  // yaw = 0 => right = (+1, 0), left = (-1, 0), forward = (0, -1)

  it('returns positive lean when wall is on the left and right-forward is open', () => {
    const lean = computeCornerLean(pos, 0, (x) => x < -0.3);
    expect(lean).toBeGreaterThan(0);
  });

  it('returns negative lean when wall is on the right and left-forward is open', () => {
    const lean = computeCornerLean(pos, 0, (x) => x > 0.3);
    expect(lean).toBeLessThan(0);
  });

  it('returns 0 when open on both sides or blocked on both sides', () => {
    expect(computeCornerLean(pos, 0, () => false)).toBe(0);
    expect(computeCornerLean(pos, 0, () => true)).toBe(0);
  });

  it('returns 0 when wall is on the left but right-forward is also blocked', () => {
    const lean = computeCornerLean(pos, 0, (x, z) => x < -0.3 || z < -0.2);
    expect(lean).toBe(0);
  });
});

// ============================================================================
// Integration tests (Phases 1–3) on SquadSystem and SwatTeam
// ============================================================================

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

const INTEGRATION_DOOR_CFG: DoorConfig = {
  thickness: 0.08,
  height: 2.2,
  peekAngle: 28,
  swingSpeed: 120,
  knobSpeedMultiplier: 2.0,
  segmentLength: 0.25,
  interactRange: 2.4,
  breach: { speedMultiplier: 5.5, noiseRadius: 24, effectRadius: 6 },
  noise: { slowRadius: 5, fastRadius: 12 },
};

const INTEGRATION_SQUAD_CFG: SquadConfig = {
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

const INTEGRATION_ARREST_CFG: ArrestConfig = {
  range: 2.2,
  holdSec: 0.5,
  civilianRange: 2.2,
  civilianHoldSec: 0.4,
  evidenceRange: 2.2,
  evidenceHoldSec: 0.4,
};

const INTEGRATION_EMPTY_PROFILE = {
  id: 'hostile',
  initialMorale: 90,
  recoveryPerSec: 1,
  thresholds: { surrenderBelow: 20, hesitateBelow: 40 },
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

function makeStubPlayer(pos: Vec3 = { x: 0, y: 0, z: 6.5 }, yawRad = 0) {
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
  } as unknown as PlayerController & { yawRad: number };
}

interface InternalAlly {
  id: string;
  phase: string;
  order: string;
  settled: boolean;
  entryOrder: number;
  body: HumanoidBody;
  optics: { group: THREE.Object3D };
}

interface InternalSquad {
  allies: InternalAlly[];
  executeOrder: (order: string, ctx: Record<string, unknown>) => void;
}

function createSquadHarness(allies?: AllyDef[], playerPos: Vec3 = { x: 0, y: 0, z: 6.5 }) {
  const bus: GameEventBus = createGameEventBus();
  const door = new Door({ id: 'd_entry', x: 0, z: 0, yaw: 0, locked: false, maxAngle: 95 }, INTEGRATION_DOOR_CFG, 2.6, bus);
  const colliders: Collider[] = [
    makeBoxCollider(0, -0.2, 0, 40, 0.2, 40, 'floor'),
    makeBoxCollider(-2.8, 0, 0, 4.4, 2.6, 0.2, 'wall'),
    makeBoxCollider(2.8, 0, 0, 4.4, 2.6, 0.2, 'wall'),
    makeBoxCollider(0, 0, -8, 10.2, 2.6, 0.2, 'wall'),
    makeBoxCollider(-5, 0, -4, 0.2, 2.6, 8, 'wall'),
    makeBoxCollider(5, 0, -4, 0.2, 2.6, 8, 'wall'),
    ...door.colliders,
  ];
  const doorSys = {
    doors: [door],
    update(dt: number) {
      door.update(dt);
    },
  } as unknown as DoorSystem;
  const player = makeStubPlayer(playerPos, 0);
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
  const rooms: RoomDef[] = [
    { id: 'hall', name: 'Hall', x: 0, z: 4, width: 10, depth: 8, floorY: 0 },
    { id: 'target', name: 'Target', x: 0, z: -4, width: 10, depth: 8, floorY: 0 },
  ];
  const entities = new EntityManager(
    [],
    [INTEGRATION_EMPTY_PROFILE],
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
    null,
  );
  const allyDefs: AllyDef[] = allies ?? [
    { id: 'ally_1', name: 'Miller', x: -1.6, z: 2.2, yaw: 0 },
    { id: 'ally_2', name: 'Cole', x: 1.6, z: 2.2, yaw: 0 },
    { id: 'ally_3', name: 'Vance', x: -1.8, z: 3.6, yaw: 0 },
    { id: 'ally_4', name: 'Reyes', x: 1.8, z: 3.6, yaw: 0 },
  ];
  const squad = new SquadSystem(
    allyDefs,
    INTEGRATION_SQUAD_CFG,
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
    INTEGRATION_ARREST_CFG,
  );
  const internal = squad as unknown as InternalSquad;

  const tick = (dt = 0.05) => {
    doorSys.update(dt);
    entities.update(dt);
    squad.update(dt);
  };
  const issueDoorOrder = (order: 'stack' | 'clear') => {
    internal.executeOrder(order, {
      element: 'gold',
      door,
      areaTarget: null,
      groundPoint: null,
      restrainTarget: null,
    });
  };
  const issueHoldOrder = () => {
    internal.executeOrder('hold', {
      element: 'gold',
      door: null,
      areaTarget: null,
      groundPoint: null,
      restrainTarget: null,
    });
  };
  const cleanup = () => {
    squad.dispose();
    entities.dispose();
    door.dispose();
  };

  return { door, player, squad, internal, tick, issueDoorOrder, issueHoldOrder, cleanup };
}

function makeSwatRoomHarness(count = 4) {
  const bus = createGameEventBus();
  const doorFront = new Door(
    { id: 'door_front', x: 0, z: 5, yaw: 0, width: 1.2, maxAngle: 90, locked: false },
    INTEGRATION_DOOR_CFG,
    2.8,
    bus,
  );
  const makeWall = (minX: number, maxX: number, minZ: number, maxZ: number): Collider => ({
    kind: 'wall',
    aabb: { min: { x: minX, y: 0, z: minZ }, max: { x: maxX, y: 3, z: maxZ } },
  });
  const colliders: Collider[] = [
    makeWall(-5.2, -0.65, 4.9, 5.1),
    makeWall(0.65, 5.2, 4.9, 5.1),
    makeWall(-5.2, 5.2, -5.1, -4.9),
    makeWall(-5.1, -4.9, -5.1, 5.1),
    makeWall(4.9, 5.1, -5.1, 5.1),
    ...doorFront.colliders,
  ];
  const rooms: RoomDef[] = [{ id: 'r1', name: 'Main Hall', x: 0, z: 0, width: 10, depth: 10, floorY: 0 }];
  const playerPos = new THREE.Vector3(50, 0, 50);
  const player = {
    position: playerPos,
    alive: true,
    isCrouching: false,
    yawRad: 0,
    hp: 100,
    getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
    getBodyBounds: () => ({
      min: { x: playerPos.x - 0.3, y: playerPos.y, z: playerPos.z - 0.3 },
      max: { x: playerPos.x + 0.3, y: playerPos.y + 1.75, z: playerPos.z + 0.3 },
    }),
    takeDamage: vi.fn(() => 100),
  };
  const spawns = [
    { x: -1.4, y: 0, z: 7.2 },
    { x: -1.4, y: 0, z: 8.1 },
    { x: 1.4, y: 0, z: 7.2 },
    { x: 1.4, y: 0, z: 8.1 },
  ].slice(0, count);

  const deps: SwatTeamDeps = {
    spawns,
    count,
    player,
    colliders,
    bus,
    weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
    doors: { doors: [doorFront] } as unknown as DoorSystem,
    bounds: { width: 28, depth: 28 },
    stairs: [],
    rooms,
    windows: [],
    flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
    subtitle: { show: vi.fn() } as unknown as Subtitle,
    civilians: () => [],
  };

  const team = new SwatTeam(deps);
  const step = (dt = 0.05) => {
    doorFront.update(dt, playerPos.x, playerPos.z, 0.35, playerPos.y);
    team.update(dt);
  };
  const cleanup = () => {
    team.dispose();
    doorFront.dispose();
  };
  return { team, doorFront, step, cleanup };
}

describe('SquadSystem entry mode toggle, stealth entry, and muzzle discipline (Phases 1–3)', () => {
  let restoreDom: () => void;

  beforeEach(() => {
    restoreDom = installMinimalDom();
  });

  afterEach(() => {
    restoreDom();
  });

  it('defaults to dynamic entry mode and toggles cleanly between stealth and dynamic', () => {
    const h = createSquadHarness();
    try {
      expect(h.squad.getEntryMode()).toBe('dynamic');
      expect(h.squad.toggleEntryMode()).toBe('stealth');
      expect(h.squad.getEntryMode()).toBe('stealth');
      expect(h.squad.toggleEntryMode()).toBe('dynamic');
      expect(h.squad.getEntryMode()).toBe('dynamic');
    } finally {
      h.cleanup();
    }
  });

  it('stealth stack -> clear opens door to peekAngle first, transitions through pieing with lean, then enters room', () => {
    const h = createSquadHarness();
    try {
      expect(h.squad.toggleEntryMode()).toBe('stealth');

      h.issueDoorOrder('stack');
      for (let i = 0; i < 160; i++) {
        h.tick(0.05);
        if (h.internal.allies.every((a) => a.phase === 'stacking' && a.settled)) break;
      }
      expect(h.internal.allies.every((a) => a.phase === 'stacking' && a.settled)).toBe(true);

      h.issueDoorOrder('clear');

      let firstPeekFrame = -1;
      let firstFullOpenFrame = -1;
      let peekHoldFrames = 0;
      let sawPieing = false;
      let pieFrame = -1;
      let maxPieLean = 0;
      let sawEntering = false;
      let enterFrame = -1;

      for (let frame = 0; frame < 600; frame++) {
        h.tick(0.05);
        const angle = h.door.angle;
        if (firstPeekFrame < 0 && angle >= h.door.peekAngle - 3) {
          firstPeekFrame = frame;
        }
        if (angle >= h.door.peekAngle - 3 && angle <= h.door.peekAngle + 3 && firstFullOpenFrame < 0) {
          peekHoldFrames++;
        }
        if (firstFullOpenFrame < 0 && angle >= h.door.maxAngle - 5) {
          firstFullOpenFrame = frame;
        }
        for (const a of h.internal.allies) {
          if (a.phase === 'pieing') {
            if (!sawPieing) pieFrame = frame;
            sawPieing = true;
            maxPieLean = Math.max(maxPieLean, Math.abs(a.body.getLean()));
          }
          if (a.phase === 'entering') {
            if (!sawEntering) enterFrame = frame;
            sawEntering = true;
          }
        }
        if (h.internal.allies.every((a) => a.phase === 'sweeping' || a.phase === 'secured')) {
          break;
        }
      }

      // Door cracked to peekAngle and held there before opening to maxAngle
      expect(firstPeekFrame).toBeGreaterThanOrEqual(0);
      expect(firstFullOpenFrame).toBeGreaterThan(firstPeekFrame);
      expect(peekHoldFrames).toBeGreaterThanOrEqual(2);

      // Lead ally sliced the pie with non-zero lean before entering
      expect(sawPieing).toBe(true);
      expect(maxPieLean).toBeGreaterThan(0.05);
      expect(sawEntering).toBe(true);
      expect(enterFrame).toBeGreaterThan(pieFrame);

      // Team finished entering and reached sweeping/secured inside the room
      expect(h.internal.allies.every((a) => a.phase === 'sweeping' || a.phase === 'secured')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('muzzle discipline: ally standing directly behind another ally drops to low ready and hides optics', () => {
    const h = createSquadHarness(
      [
        { id: 'ally_front', name: 'Miller', x: 0, z: 2.0, yaw: 0 },
        { id: 'ally_rear', name: 'Cole', x: 0, z: 3.2, yaw: 0 },
      ],
      { x: 12, y: 0, z: 12 },
    );
    try {
      h.issueHoldOrder();
      for (let i = 0; i < 15; i++) {
        h.tick(0.05);
      }

      const front = h.internal.allies.find((a) => a.id === 'ally_front')!;
      const rear = h.internal.allies.find((a) => a.id === 'ally_rear')!;

      expect(rear.body.getReadyPose()).toBe('low');
      expect(rear.optics.group.visible).toBe(false);

      // Front ally has a clear line of fire ahead and stays high ready
      expect(front.body.getReadyPose()).toBe('high');
    } finally {
      h.cleanup();
    }
  });
});

describe('SwatTeam stealth entry integration (Phases 1–3)', () => {
  it('with setEntryStyleOverride("stealth"), lead hunter enters pie, cracks door to peekAngle, leans, slices pie, then team enters entry', () => {
    const { team, doorFront, step, cleanup } = makeSwatRoomHarness(4);
    try {
      team.setEntryStyleOverride('stealth');
      team.beginAssault();
      expect(team.hunters.every((h) => h.state === 'stack')).toBe(true);

      for (const h of team.hunters) {
        const slot = h.stackSlot!;
        h.body.setPosition(slot.x, slot.z, slot.y, false);
      }

      let sawPieState = false;
      let firstPieFrame = -1;
      let firstPeekFrame = -1;
      let firstFullOpenFrame = -1;
      let peekHoldFrames = 0;
      let maxPieLean = 0;
      let sawAllEntry = false;
      let entryFrame = -1;

      for (let frame = 0; frame < 500; frame++) {
        step(0.05);
        const angle = doorFront.angle;
        if (firstPeekFrame < 0 && angle >= doorFront.peekAngle - 3) {
          firstPeekFrame = frame;
        }
        if (angle >= doorFront.peekAngle - 3 && angle <= doorFront.peekAngle + 3 && firstFullOpenFrame < 0) {
          peekHoldFrames++;
        }
        if (firstFullOpenFrame < 0 && angle >= doorFront.maxAngle - 5) {
          firstFullOpenFrame = frame;
        }

        const pieHunter = team.hunters.find((h) => h.state === 'pie');
        if (pieHunter) {
          if (!sawPieState) firstPieFrame = frame;
          sawPieState = true;
          maxPieLean = Math.max(maxPieLean, Math.abs(pieHunter.body.getLean()));
        }

        if (sawPieState && team.hunters.every((h) => h.state === 'entry')) {
          sawAllEntry = true;
          entryFrame = frame;
          break;
        }
      }

      expect(sawPieState).toBe(true);
      expect(firstPeekFrame).toBeGreaterThanOrEqual(0);
      expect(firstFullOpenFrame).toBeGreaterThan(firstPeekFrame);
      expect(peekHoldFrames).toBeGreaterThanOrEqual(2);
      expect(maxPieLean).toBeGreaterThan(0.05);
      expect(sawAllEntry).toBe(true);
      expect(entryFrame).toBeGreaterThan(firstPieFrame);
    } finally {
      cleanup();
    }
  });
});

