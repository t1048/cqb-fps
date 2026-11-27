import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus, SuspectState, type GameEventBus } from '../../src/core/events';
import type { AIProfile, AllyDef, ArrestConfig, DoorConfig, RoomDef, SquadConfig, Vec3 } from '../../src/core/types';
import type { InputManager } from '../../src/core/InputManager';
import type { PlayerController } from '../../src/player/PlayerController';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import { Door, DoorSystem } from '../../src/world/Door';
import type { Collider } from '../../src/world/WorldBuilder';
import type { TextureLibrary } from '../../src/world/Materials';
import { EntityManager } from '../../src/ai/EntityManager';
import { SquadSystem } from '../../src/ai/Squad';
import type { EntryPlan } from '../../src/ai/cqbEntry';

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

const EMPTY_PROFILE = {
  id: 'hostile',
  initialMorale: 90,
  recoveryPerSec: 1,
  thresholds: { surrenderBelow: 20, hesitateBelow: 40 },
  modifiers: { warningCall: 15, flashbang: 35, breach: 20, nonlethalHit: 30, isolation: 10 },
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
  entryPlan: EntryPlan | null;
  entryPortal: { centerX: number; centerZ: number; intoX: number; intoZ: number; axisX: number; axisZ: number } | null;
  followGoal: { x: number; z: number } | null;
  body: { px: number; pz: number; footY: number; yawRad: number };
}

interface InternalSquad {
  allies: InternalAlly[];
  executeOrder: (order: string, ctx: Record<string, unknown>) => void;
}

function createTwoRoomHarness(allies?: AllyDef[], playerPos: Vec3 = { x: 0, y: 0, z: 6.5 }) {
  const bus: GameEventBus = createGameEventBus();
  const door = new Door({ id: 'd_entry', x: 0, z: 0, yaw: 0, locked: false, maxAngle: 95 }, DEFAULT_DOOR_CFG, 2.6, bus);
  // Divider wall at z=0 with 1.2m doorway centered at x=0, plus target room perimeter walls
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
    [EMPTY_PROFILE],
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
  );
  const internal = squad as unknown as InternalSquad;

  const tick = (dt = 0.05) => {
    doorSys.update(dt);
    entities.update(dt);
    squad.update(dt);
  };
  const step = (sec: number, dt = 0.05) => {
    const n = Math.ceil(sec / dt);
    for (let i = 0; i < n; i++) tick(dt);
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
  const cleanup = () => {
    squad.dispose();
    entities.dispose();
    door.dispose();
  };

  return { door, player, squad, internal, tick, step, issueDoorOrder, cleanup };
}

describe('SquadSystem CQB entry & motion smoothness (§6)', () => {
  let restoreDom: () => void;

  beforeEach(() => {
    restoreDom = installMinimalDom();
  });

  afterEach(() => {
    restoreDom();
  });

  it('stack -> clear: threshold crossing order matches entryOrder and lateral (u) sign never flips during entry', () => {
    const h = createTwoRoomHarness();
    try {
      h.issueDoorOrder('stack');
      // Wait for all 4 allies to settle on stack slots
      for (let i = 0; i < 160; i++) {
        h.tick(0.05);
        if (h.internal.allies.every((a) => a.phase === 'stacking' && a.settled)) break;
      }
      expect(h.internal.allies.every((a) => a.phase === 'stacking' && a.settled)).toBe(true);

      h.issueDoorOrder('clear');
      const allies = h.internal.allies;
      const portal = allies[0]!.entryPortal!;
      expect(portal).toBeTruthy();
      expect(allies.every((a) => a.entryPlan !== null)).toBe(true);

      const crossFrame = new Map<string, number>();
      let maxWrongSideU = 0;

      for (let frame = 0; frame < 240; frame++) {
        h.tick(0.05);
        for (const a of allies) {
          const dx = a.body.px - portal.centerX;
          const dz = a.body.pz - portal.centerZ;
          const u = dx * portal.axisX + dz * portal.axisZ;
          const v = dx * portal.intoX + dz * portal.intoZ;
          if (!crossFrame.has(a.id) && v > 0.35) {
            crossFrame.set(a.id, frame);
          }
          if (a.phase === 'entering' && v > 0.2 && a.entryPlan) {
            // u * side < 0 means crossed over to opposite side
            const wrongSide = -(u * a.entryPlan.side);
            if (wrongSide > maxWrongSideU) maxWrongSideU = wrongSide;
          }
        }
        if (allies.every((a) => a.phase === 'secured')) break;
      }

      // Every ally must have crossed the threshold
      expect(crossFrame.size).toBe(4);
      const byOrder = [...allies].sort((a, b) => a.entryOrder - b.entryOrder);
      const frames = byOrder.map((a) => crossFrame.get(a.id)!);
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i]!).toBeGreaterThan(frames[i - 1]!);
      }
      // Lateral (u) sign never flips during entry (allow tiny doorway center tolerance <= 0.1m)
      expect(maxWrongSideU).toBeLessThan(0.1);
    } finally {
      h.cleanup();
    }
  });

  it('after stack arrival until door_prep: total position drift per member < 0.05m (no shuffling)', () => {
    const h = createTwoRoomHarness();
    try {
      h.issueDoorOrder('stack');
      for (let i = 0; i < 160; i++) {
        h.tick(0.05);
        if (h.internal.allies.every((a) => a.phase === 'stacking' && a.settled)) break;
      }
      expect(h.internal.allies.every((a) => a.settled)).toBe(true);

      const prev = h.internal.allies.map((a) => ({ x: a.body.px, z: a.body.pz }));
      const drift = h.internal.allies.map(() => 0);

      // Hold stack for 2.0s before issuing clear
      for (let i = 0; i < 40; i++) {
        h.tick(0.05);
        h.internal.allies.forEach((a, idx) => {
          drift[idx]! += Math.hypot(a.body.px - prev[idx]!.x, a.body.pz - prev[idx]!.z);
          prev[idx] = { x: a.body.px, z: a.body.pz };
        });
      }

      for (const d of drift) {
        expect(d).toBeLessThan(0.05);
      }
    } finally {
      h.cleanup();
    }
  });

  it('yaw jitter: during 2s PoD hold, yaw direction sign reversals <= 2', () => {
    const h = createTwoRoomHarness();
    try {
      h.issueDoorOrder('stack');
      for (let i = 0; i < 160; i++) {
        h.tick(0.05);
        if (h.internal.allies.every((a) => a.phase === 'stacking' && a.settled)) break;
      }
      h.issueDoorOrder('clear');
      // Run until all 4 allies have settled into secured PoD hold
      for (let i = 0; i < 400; i++) {
        h.tick(0.05);
        if (h.internal.allies.every((a) => a.phase === 'secured' && a.settled)) break;
      }
      expect(h.internal.allies.every((a) => a.phase === 'secured' && a.settled)).toBe(true);
      // Let any initial secured turn settle briefly, then measure 2.0s hold
      h.step(0.7, 0.05);

      const allies = h.internal.allies;
      const prevYaw = allies.map((a) => a.body.yawRad);
      const prevSign = allies.map(() => 0);
      const reversals = allies.map(() => 0);

      for (let i = 0; i < 40; i++) {
        h.tick(0.05);
        allies.forEach((a, idx) => {
          const dy = Math.atan2(Math.sin(a.body.yawRad - prevYaw[idx]!), Math.cos(a.body.yawRad - prevYaw[idx]!));
          prevYaw[idx] = a.body.yawRad;
          if (Math.abs(dy) > 1e-4) {
            const s = dy > 0 ? 1 : -1;
            if (prevSign[idx] !== 0 && s !== prevSign[idx]) {
              reversals[idx]!++;
            }
            prevSign[idx] = s;
          }
        });
      }

      for (const r of reversals) {
        expect(r).toBeLessThanOrEqual(2);
      }
    } finally {
      h.cleanup();
    }
  });

  it('follow: player rotating 180° in place moves ally target < 0.6m in 0.3s', () => {
    const h = createTwoRoomHarness(
      [
        { id: 'ally_1', name: 'Miller', x: -0.75, z: 8.0, yaw: 0 },
        { id: 'ally_2', name: 'Cole', x: 0.75, z: 8.0, yaw: 0 },
      ],
      { x: 0, y: 0, z: 6.5 },
    );
    try {
      // Settle in follow formation behind player
      h.step(2.0, 0.05);
      const allies = h.internal.allies;
      expect(allies.every((a) => a.phase === 'follow' && a.followGoal !== null)).toBe(true);

      const beforeGoal = allies.map((a) => ({ x: a.followGoal!.x, z: a.followGoal!.z }));
      const beforePos = allies.map((a) => ({ x: a.body.px, z: a.body.pz }));

      // Rotate player 180° in place over 0.3s (6 frames @ 50ms)
      for (let i = 1; i <= 6; i++) {
        h.player.yawRad = (Math.PI * i) / 6;
        h.tick(0.05);
      }

      allies.forEach((a, idx) => {
        const goalShift = Math.hypot(a.followGoal!.x - beforeGoal[idx]!.x, a.followGoal!.z - beforeGoal[idx]!.z);
        const bodyShift = Math.hypot(a.body.px - beforePos[idx]!.x, a.body.pz - beforePos[idx]!.z);
        expect(goalShift).toBeLessThan(0.6);
        expect(bodyShift).toBeLessThan(0.6);
      });
    } finally {
      h.cleanup();
    }
  });
});
