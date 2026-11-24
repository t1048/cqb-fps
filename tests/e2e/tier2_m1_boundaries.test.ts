import { afterEach, describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../src/core/events';
import type { CombatParams } from '../../src/core/types';
import { EngageBehavior } from '../../src/ai/EngageBehavior';
import { HumanoidBody } from '../../src/ai/HumanoidBody';
import {
  PRESSURE_RAMP_SEC,
  SHIELD_COMBAT,
  SWAT_COMBAT,
  computeBallisticVelocity,
  planDoorwayFlashThrow,
  planFlashThrow,
  planWallBankFlashThrow,
  planWindowFlashThrow,
  type FlashDoorSample,
} from '../../src/modes/SwatTeam';
import type { Collider } from '../../src/world/WorldBuilder';
import { makeSingleRoomMap, makeWindowedSiegeMap } from './helpers/headlessWorld';
import {
  EventRecorder,
  createHeadlessPlayer,
  createSwatHarness,
  type SwatHarness,
} from './helpers/simDriver';

const activeHarnesses: SwatHarness[] = [];
afterEach(() => {
  while (activeHarnesses.length > 0) {
    activeHarnesses.pop()!.dispose();
  }
});

function track(h: SwatHarness): SwatHarness {
  activeHarnesses.push(h);
  return h;
}

function makeCombat(overrides: Partial<CombatParams> = {}): CombatParams {
  return {
    decisionSec: 0.5,
    alertCalmSec: 10,
    hesitateFireSec: 3,
    hesitateRetreatSpeed: 0.8,
    hesitateRetreatMax: 1.5,
    hesitateShakeDeg: 0,
    moveSpeed: 2.35,
    fireInterval: 0.2,
    shotsPerPeek: 4,
    magazineSize: 30,
    reloadSec: 2.0,
    coverSecMin: 1.0,
    coverSecMax: 1.5,
    peekSecMax: 1.4,
    engageRange: 18,
    coverSearchRange: 6,
    coverMargin: 0.45,
    crouchCoverMaxHeight: 1.5,
    flinchSec: 0.35,
    gunshotNoiseRadius: 40,
    shotDamage: 12,
    baseSpreadDeg: 2.0,
    ...overrides,
  };
}

function makeFloor(): Collider {
  return { kind: 'floor', aabb: { min: { x: -20, y: -0.2, z: -20 }, max: { x: 20, y: 0, z: 20 } } };
}

function makeWall(minX: number, maxX: number, minZ: number, maxZ: number): Collider {
  return { kind: 'wall', aabb: { min: { x: minX, y: 0, z: minZ }, max: { x: maxX, y: 3, z: maxZ } } };
}

describe('Tier 2 — M1 Boundary & Corner Cases (F1–F5)', () => {
  // =========================================================================
  // F1 Boundaries
  // =========================================================================
  describe('F1 Boundaries: Immediate Fire on Contact', () => {
    it('F1.B1: Does NOT immediate-fire when solid wall blocks LOS on enter', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -6 });
      const colliders = [makeFloor(), makeWall(-4, 4, -3.1, -2.9)];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(makeCombat(), 'swat_1', body, bus, { player, colliders }, () => true, null, null, {
        immediateFireOnEnter: true,
        immediateFireShots: 3,
      });
      eb.enter({ x: 0, y: 0, z: -6 });
      expect(eb.label).not.toBe('peek');
      eb.update(0.05, { x: 0, y: 0, z: -6 }, false);
      expect(rec.count('shotFired')).toBe(0);
      rec.dispose();
      body.dispose();
    });

    it('F1.B2: Does NOT immediate-fire when target is beyond engageRange', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -25 });
      const colliders = [makeFloor()];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(
        makeCombat({ engageRange: 10 }),
        'swat_1',
        body,
        bus,
        { player, colliders },
        () => true,
        null,
        null,
        { immediateFireOnEnter: true, immediateFireShots: 3 },
      );
      eb.enter({ x: 0, y: 0, z: -25 });
      eb.update(0.05, { x: 0, y: 0, z: -25 }, true);
      expect(rec.count('shotFired')).toBe(0);
      rec.dispose();
      body.dispose();
    });

    it('F1.B3: Does NOT immediate-fire when magazine is empty (ammo === 0)', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
      const colliders = [makeFloor()];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(
        makeCombat({ magazineSize: 0 }),
        'swat_1',
        body,
        bus,
        { player, colliders },
        () => true,
        null,
        null,
        { immediateFireOnEnter: true, immediateFireShots: 3 },
      );
      eb.enter({ x: 0, y: 0, z: -5 });
      eb.update(0.05, { x: 0, y: 0, z: -5 }, true);
      expect(rec.count('shotFired')).toBe(0);
      rec.dispose();
      body.dispose();
    });

    it('F1.B4: Does NOT immediate-fire when known position is null', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
      const colliders = [makeFloor()];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(makeCombat(), 'swat_1', body, bus, { player, colliders }, () => true, null, null, {
        immediateFireOnEnter: true,
        immediateFireShots: 3,
      });
      eb.enter(null);
      eb.update(0.05, null, false);
      expect(rec.count('shotFired')).toBe(0);
      rec.dispose();
      body.dispose();
    });

    it('F1.B5: Aborts immediate burst and retreats if LOS is lost mid-burst', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
      const colliders = [makeFloor(), { kind: 'cover' as const, aabb: { min: { x: 2, y: 0, z: -0.3 }, max: { x: 3.2, y: 1.2, z: 0.3 } } }];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(
        makeCombat({ fireInterval: 0.2 }),
        'swat_1',
        body,
        bus,
        { player, colliders },
        () => true,
        null,
        null,
        { immediateFireOnEnter: true, immediateFireShots: 4 },
      );
      eb.enter({ x: 0, y: 0, z: -5 });
      eb.update(0.05, { x: 0, y: 0, z: -5 }, true);
      expect(rec.count('shotFired')).toBe(1);
      // Lose sight on next tick
      eb.update(0.05, { x: 0, y: 0, z: -5 }, false);
      expect(['toCover', 'cover']).toContain(eb.label);
      rec.dispose();
      body.dispose();
    });
  });

  // =========================================================================
  // F2 Boundaries
  // =========================================================================
  describe('F2 Boundaries: Reduced Flinch & Unstoppable Advance', () => {
    it('F2.B1: Zero flinchSec recovers immediately without entering flinch state', () => {
      const bus = createGameEventBus();
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(
        makeCombat({ flinchSec: 0 }),
        'swat_1',
        body,
        bus,
        { player, colliders: [makeFloor()] },
        () => true,
        null,
        null,
        { immediateFireOnEnter: true, skipRetreatOnHit: () => true },
      );
      eb.enter({ x: 0, y: 0, z: -5 });
      eb.onHit({ x: 0, y: 0, z: -5 });
      expect(eb.label).toBe('peek');
      body.dispose();
    });

    it('F2.B2: Module-level SWAT_COMBAT and SHIELD_COMBAT reset cleanly on new SwatTeam instantiation', () => {
      const h1 = createSwatHarness({
        map: makeSingleRoomMap(),
        spawns: [{ x: 0, y: 0, z: 6 }],
        count: 1,
        startAssault: true,
      });
      h1.step(PRESSURE_RAMP_SEC + 5, 0.05);
      const maxPressureFlinch = SWAT_COMBAT.flinchSec;
      h1.dispose();

      const h2 = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          startAssault: false,
        }),
      );
      expect(SWAT_COMBAT.flinchSec).toBeGreaterThan(maxPressureFlinch);
      expect(SHIELD_COMBAT.flinchSec).toBeCloseTo(0.06, 2);
      expect(h2.team.currentPressure).toBe(0);
    });

    it('F2.B3: Non-lethal entityHit events are ignored by SwatTeam damage/kill logic', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 3 }],
          count: 1,
          startAssault: true,
        }),
      );
      const u = h.team.hunters[0]!;
      const startHp = u.hp;
      h.bus.emit('entityHit', {
        targetId: u.id,
        shooter: 'player',
        damage: 0,
        pos: { x: 0, y: 1, z: 3 },
        nonlethal: true,
      });
      expect(u.hp).toBe(startHp);
      expect(u.alive).toBe(true);
    });

    it('F2.B4: Friendly-fire entityHit from another swat_ unit does not damage SWAT hunter', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
          ],
          count: 2,
          startAssault: true,
        }),
      );
      const u = h.team.hunters[0]!;
      const startHp = u.hp;
      h.bus.emit('entityHit', {
        targetId: u.id,
        shooter: 'swat_2',
        damage: 50,
        pos: { x: 0, y: 1, z: 3 },
      });
      expect(u.hp).toBe(startHp);
    });

    it('F2.B5: Dynamic skipRetreatOnHit callback flips behavior when condition changes from false to true', () => {
      let allowSkip = false;
      const bus = createGameEventBus();
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
      const colliders = [makeFloor(), { kind: 'cover' as const, aabb: { min: { x: 2, y: 0, z: -0.3 }, max: { x: 3.2, y: 1.2, z: 0.3 } } }];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(
        makeCombat({ flinchSec: 0.05 }),
        'swat_1',
        body,
        bus,
        { player, colliders },
        () => true,
        null,
        null,
        { immediateFireOnEnter: true, skipRetreatOnHit: () => allowSkip },
      );

      eb.enter({ x: 0, y: 0, z: -5 });
      eb.onHit({ x: 0, y: 0, z: -5 });
      eb.update(0.06, { x: 0, y: 0, z: -5 }, true);
      expect(['toCover', 'cover']).toContain(eb.label);

      allowSkip = true;
      eb.enter({ x: 0, y: 0, z: -5 });
      eb.onHit({ x: 0, y: 0, z: -5 });
      eb.update(0.06, { x: 0, y: 0, z: -5 }, true);
      expect(eb.label).toBe('peek');
      body.dispose();
    });
  });

  // =========================================================================
  // F3 Boundaries
  // =========================================================================
  describe('F3 Boundaries: Vulnerability Rush', () => {
    it('F3.B1: triggerRush returns false before beginAssault() is called', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 2 }],
          count: 1,
          startAssault: false,
        }),
      );
      expect(h.team.triggerRush({ x: 0, y: 0, z: -2 }, 'blind')).toBe(false);
      expect(h.team.hunters[0]!.state).toBe('staging');
    });

    it('F3.B2: triggerRush enforces team cooldown (6.0s) and rejects immediate re-trigger', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 2 }],
          count: 1,
          startAssault: true,
        }),
      );
      expect(h.team.triggerRush({ x: 0, y: 0, z: -2 }, 'reload')).toBe(true);
      expect(h.team.triggerRush({ x: 0, y: 0, z: -2 }, 'blind')).toBe(false);
      h.step(6.2, 0.05);
      expect(h.team.triggerRush({ x: 0, y: 0, z: -2 }, 'lowHp')).toBe(true);
    });

    it('F3.B3: triggerRush ignores SWAT units beyond RUSH_RADIUS (14m)', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 11 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -8 },
          startAssault: true,
        }),
      );
      // Distance is 19m > 14m
      expect(h.team.triggerRush({ x: 0, y: 0, z: -8 }, 'blind')).toBe(false);
      expect(h.team.hunters[0]!.state).not.toBe('rush');
    });

    it('F3.B4: playerBlinded with tiny duration (<= 0.3s) does NOT trigger rush', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 2 }],
          count: 1,
          startAssault: true,
        }),
      );
      h.bus.emit('playerBlinded', { duration: 0.25, pos: { x: 0, y: 0, z: -2 } });
      expect(h.team.hunters[0]!.state).not.toBe('rush');
    });

    it('F3.B5: playerHit with hp > 40 or hp === 0 does NOT trigger rush', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 2 }],
          count: 1,
          startAssault: true,
        }),
      );
      h.bus.emit('playerHit', { shooter: 'swat_1', damage: 10, from: { x: 0, y: 0, z: 2 }, hp: 41 });
      expect(h.team.hunters[0]!.state).not.toBe('rush');
      h.bus.emit('playerHit', { shooter: 'swat_1', damage: 50, from: { x: 0, y: 0, z: 2 }, hp: 0 });
      expect(h.team.hunters[0]!.state).not.toBe('rush');
    });
  });

  // =========================================================================
  // F4 Boundaries
  // =========================================================================
  describe('F4 Boundaries: Perception, Speed & Pressure Boost', () => {
    it('F4.B1: Pressure stays at 0 before beginAssault() even after long update time', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          startAssault: false,
        }),
      );
      h.step(30, 0.05);
      expect(h.team.currentPressure).toBe(0);
    });

    it('F4.B2: Pressure clamps strictly at 1.0 even after 2x PRESSURE_RAMP_SEC and multiple casualties', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [
            { x: 0, y: 0, z: 6 },
            { x: 1, y: 0, z: 6 },
            { x: 2, y: 0, z: 6 },
          ],
          count: 3,
          startAssault: true,
        }),
      );
      h.bus.emit('entityHit', { targetId: 'swat_2', shooter: 'player', damage: 200, pos: { x: 1, y: 1, z: 6 } });
      h.bus.emit('entityHit', { targetId: 'swat_3', shooter: 'player', damage: 200, pos: { x: 2, y: 1, z: 6 } });
      h.step(PRESSURE_RAMP_SEC * 2, 0.05);
      expect(h.team.currentPressure).toBeLessThanOrEqual(1.0);
      expect(h.team.currentPressure).toBeCloseTo(1.0, 4);
    });

    it('F4.B3: SWAT hunter spots player inside 120-degree FOV (50deg) after acquisition time but not outside (70deg, 180deg)', () => {
      const checkAngle = (deg: number): boolean => {
        const rad = (deg * Math.PI) / 180;
        const dist = 3.0;
        const px = Math.sin(rad) * dist;
        const pz = -Math.cos(rad) * dist;
        const h = track(
          createSwatHarness({
            map: makeSingleRoomMap({ includeCover: false }),
            spawns: [{ x: 0, y: 0, z: 0 }],
            count: 1,
            playerPos: { x: px, y: 0, z: pz },
            startAssault: false,
          }),
        );
        // Keep hunter gaze fixed toward -Z (0 deg reference) while stepping past vision acquisition latency (0.35s)
        const hunter = h.team.hunters[0]!;
        h.team.beginAssault();
        for (let i = 0; i < 10; i++) {
          hunter.body.faceToward(hunter.body.px, hunter.body.pz - 10);
          h.step(0.05, 0.05);
        }
        return hunter.sees;
      };

      expect(checkAngle(50)).toBe(true);
      expect(checkAngle(70)).toBe(false);
      expect(checkAngle(180)).toBe(false);
    });

    it('F4.B4: SwatTeam.withdraw() succeeds during prep and fails once assault has started', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [
            { x: 0, y: 0, z: 6 },
            { x: 1, y: 0, z: 6 },
          ],
          count: 2,
          startAssault: false,
        }),
      );
      expect(h.team.withdraw()).toBe(true);
      expect(h.team.total).toBe(1);
      // Cannot withdraw last remaining SWAT
      expect(h.team.withdraw()).toBe(false);
      h.team.beginAssault();
      expect(h.team.withdraw()).toBe(false);
    });

    it('F4.B5: Large rawDt spikes are clamped cleanly without NaN positions or pressure', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          startAssault: true,
        }),
      );
      h.team.update(10.0); // huge dt spike
      const u = h.team.hunters[0]!;
      expect(Number.isFinite(u.body.px)).toBe(true);
      expect(Number.isFinite(u.body.pz)).toBe(true);
      expect(Number.isFinite(h.team.currentPressure)).toBe(true);
      expect(h.team.currentPressure).toBeLessThan(0.1);
    });
  });

  // =========================================================================
  // F5 Boundaries
  // =========================================================================
  describe('F5 Boundaries: Indirect / Door-Frame Flashbangs', () => {
    it('F5.B1: planDoorwayFlashThrow returns null when door is locked or closed (angle < 25)', () => {
      const colliders = [makeFloor()];
      const closedDoor: FlashDoorSample = {
        id: 'd1',
        centerX: 0,
        centerZ: 0,
        normalX: 0,
        normalZ: 1,
        sillY: 0,
        width: 1.2,
        height: 2.18,
        angle: 10,
        locked: false,
      };
      const lockedDoor: FlashDoorSample = { ...closedDoor, angle: 90, locked: true };
      expect(
        planDoorwayFlashThrow({ x: 0, y: 1.4, z: 2.5 }, { x: 0, y: 0, z: -2.5 }, [closedDoor], colliders, 9.8),
      ).toBeNull();
      expect(
        planDoorwayFlashThrow({ x: 0, y: 1.4, z: 2.5 }, { x: 0, y: 0, z: -2.5 }, [lockedDoor], colliders, 9.8),
      ).toBeNull();
    });

    it('F5.B2: planDoorwayFlashThrow returns null when origin and target are on the SAME side of the door', () => {
      const colliders = [makeFloor()];
      const openDoor: FlashDoorSample = {
        id: 'd1',
        centerX: 0,
        centerZ: 0,
        normalX: 0,
        normalZ: 1,
        sillY: 0,
        width: 1.2,
        height: 2.18,
        angle: 90,
        locked: false,
      };
      const plan = planDoorwayFlashThrow(
        { x: -1.5, y: 1.4, z: 2.0 },
        { x: 1.5, y: 0, z: 2.0 },
        [openDoor],
        colliders,
        9.8,
      );
      expect(plan).toBeNull();
    });

    it('F5.B3: planWindowFlashThrow returns null when window is blocked by a barricade collider', () => {
      const map = makeWindowedSiegeMap(true);
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 6, y: 0, z: 0 }],
          count: 1,
          startAssault: false,
        }),
      );
      // Add solid plank collider blocking the window opening at x=4, z=0
      const blockedColliders: Collider[] = [
        ...h.hw.colliders,
        { kind: 'cover', aabb: { min: { x: 3.85, y: 0.85, z: -1.0 }, max: { x: 4.15, y: 2.25, z: 1.0 } } },
      ];
      const plan = planWindowFlashThrow(
        { x: 6.2, y: 1.4, z: 1.2 },
        { x: 0.5, y: 0, z: -1.5 },
        map.windows,
        blockedColliders,
        9.8,
      );
      expect(plan).toBeNull();
    });

    it('F5.B4: planWallBankFlashThrow returns null in open field with no reflecting walls', () => {
      const plan = planWallBankFlashThrow(
        { x: 0, y: 1.4, z: 3 },
        { x: 0, y: 0, z: -3 },
        [makeFloor()],
        9.8,
      );
      expect(plan).toBeNull();
    });

    it('F5.B5: planFlashThrow returns null when target is too close (< minDirectDist) and no indirect path exists', () => {
      const plan = planFlashThrow(
        { x: 0, y: 1.4, z: 1.0 },
        { x: 0, y: 0, z: 0 },
        [],
        [],
        [makeFloor()],
        9.8,
        3.2,
        9.0,
      );
      expect(plan).toBeNull();
      // Also verify computeBallisticVelocity handles zero horizontal distance cleanly (no NaN)
      const v = computeBallisticVelocity({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0.4, z: 0 }, 9.8);
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.y)).toBe(true);
      expect(Number.isFinite(v.z)).toBe(true);
    });
  });
});
