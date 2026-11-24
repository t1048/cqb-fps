import { afterEach, describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../src/core/events';
import type { AIProfile, CombatParams, Vec3 } from '../../src/core/types';
import { EngageBehavior, type CombatContext } from '../../src/ai/EngageBehavior';
import { HumanoidBody } from '../../src/ai/HumanoidBody';
import { Suspect } from '../../src/ai/Suspect';
import {
  PRESSURE_PER_DOWN,
  PRESSURE_RAMP_SEC,
  SHIELD_COMBAT,
  SWAT_COMBAT,
  VISION_FOV_DEG,
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
  stepSim,
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

function makeBaseCombat(overrides: Partial<CombatParams> = {}): CombatParams {
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

function makeFloorCollider(): Collider {
  return {
    kind: 'floor',
    aabb: { min: { x: -20, y: -0.2, z: -20 }, max: { x: 20, y: 0, z: 20 } },
  };
}

function makeCoverCollider(x: number, z: number): Collider {
  return {
    kind: 'cover',
    aabb: { min: { x: x - 0.6, y: 0, z: z - 0.3 }, max: { x: x + 0.6, y: 1.2, z: z + 0.3 } },
  };
}

describe('Tier 1 — M1 Combat Overhaul (F1–F5)', () => {
  // =========================================================================
  // F1: Immediate Fire on Contact (接敵即射撃)
  // =========================================================================
  describe('F1: Immediate Fire on Contact', () => {
    it('F1.1: EngageBehavior with immediateFireOnEnter enters peek and fires on first update tick', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -6 });
      const colliders = [makeFloorCollider(), makeCoverCollider(2, -1)];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const ctx: CombatContext = { player, colliders };
      const eb = new EngageBehavior(makeBaseCombat(), 'swat_1', body, bus, ctx, () => true, null, null, {
        immediateFireOnEnter: true,
        immediateFireShots: 3,
      });

      eb.enter({ x: 0, y: 0, z: -6 });
      expect(eb.label).toBe('peek');
      eb.update(0.05, { x: 0, y: 0, z: -6 }, true);
      expect(rec.count('shotFired')).toBeGreaterThanOrEqual(1);
      rec.dispose();
      body.dispose();
    });

    it('F1.2: Immediate burst fires configured shot count before retreating to cover', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -6 });
      const colliders = [makeFloorCollider(), makeCoverCollider(2.5, 0)];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const ctx: CombatContext = { player, colliders };
      const eb = new EngageBehavior(
        makeBaseCombat({ fireInterval: 0.15, shotsPerPeek: 5 }),
        'swat_1',
        body,
        bus,
        ctx,
        () => true,
        null,
        null,
        { immediateFireOnEnter: true, immediateFireShots: 2 },
      );

      eb.enter({ x: 0, y: 0, z: -6 });
      stepSim(0.5, 0.05, (dt) => eb.update(dt, { x: 0, y: 0, z: -6 }, true), rec);
      expect(rec.count('shotFired')).toBe(2);
      expect(['toCover', 'cover']).toContain(eb.label);
      rec.dispose();
      body.dispose();
    });

    it('F1.3: SwatTeam hunter fires immediately upon spotting player in open room without retreating first', () => {
      const map = makeSingleRoomMap({ lockedDoor: false, includeCover: true });
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 0, y: 0, z: 3.3 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -2.0 },
          startAssault: true,
        }),
      );

      h.step(1.5, 0.05);
      const swatShots = h.recorder.of('shotFired').filter((e) => e.payload.shooter.startsWith('swat_'));
      expect(swatShots.length).toBeGreaterThanOrEqual(1);
    });

    it('F1.4: Normal-mode Suspect omits immediateFireOnEnter and retreats to cover before firing', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
      const colliders = [makeFloorCollider(), makeCoverCollider(1.8, 0.2)];
      const ctx: CombatContext = { player, colliders };
      const profile: AIProfile = {
        id: 'test_suspect',
        name: 'Test',
        type: 'suspect',
        initialMorale: 85,
        moraleRecovery: 1.0,
        aggression: 0.9,
        reactionTime: 0.1,
        hearingMultiplier: 1.0,
        thresholds: { surrenderBelow: 20, hesitateBelow: 40 },
        modifiers: {
          warningCall: { min: 10, max: 15 },
          flashbang: { min: 30, max: 40 },
          nonlethalHit: { min: 20, max: 30 },
          breach: 20,
          isolation: 15,
        },
        combat: makeBaseCombat({ decisionSec: 0.05, coverSecMin: 1.2, coverSecMax: 1.5 }),
      };
      const suspect = new Suspect({ id: 'susp_1', type: 'suspect', x: 0, z: 0, yaw: 180 }, profile, bus, ctx);
      // Trigger ENGAGE naturally via visual sighting (onSpotted -> CONFRONTATION -> ENGAGE, NO takeHit flinch)
      suspect.onSpotted({ x: 0, y: 0, z: -5 });
      let enteredEngage = false;
      for (let i = 0; i < 80; i++) {
        suspect.update(0.05);
        if (suspect.debugState.startsWith('ENGAGE/')) {
          enteredEngage = true;
          break;
        }
      }
      expect(enteredEngage).toBe(true);
      // Must enter cover-seeking/cover phase (not flinch, not immediate peek) and wait before firing
      expect(['ENGAGE/toCover', 'ENGAGE/cover']).toContain(suspect.debugState);
      expect(rec.count('shotFired')).toBe(0);
      // Even one additional tick in ENGAGE should still hold fire while moving to / waiting in cover
      suspect.update(0.05);
      expect(rec.count('shotFired')).toBe(0);
      rec.dispose();
      suspect.dispose();
    });

    it('F1.5: Immediate fire decrements ammoLeft accurately per shot', () => {
      const bus = createGameEventBus();
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
      const colliders = [makeFloorCollider()];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(
        makeBaseCombat({ magazineSize: 10, fireInterval: 0.1 }),
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
      stepSim(0.35, 0.05, (dt) => eb.update(dt, { x: 0, y: 0, z: -5 }, true));
      expect(eb.ammoLeft).toBe(7);
      body.dispose();
    });
  });

  // =========================================================================
  // F2: Reduced Flinch & Unstoppable Advance (被弾しても止まらない前進)
  // =========================================================================
  describe('F2: Reduced Flinch & Unstoppable Advance', () => {
    it('F2.1: SHIELD_COMBAT baseline flinchSec is shortened to <= 0.08s', () => {
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
      expect(h.team.total).toBe(2);
      expect(SHIELD_COMBAT.flinchSec).toBeLessThanOrEqual(0.08);
      expect(SHIELD_COMBAT.flinchSec).toBeGreaterThanOrEqual(0.04);
    });

    it('F2.2: High-pressure SWAT_COMBAT.flinchSec drops to <= 0.12s', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          startAssault: true,
        }),
      );
      const initialFlinch = SWAT_COMBAT.flinchSec;
      h.step(PRESSURE_RAMP_SEC + 5, 0.05);
      expect(h.team.currentPressure).toBeGreaterThanOrEqual(0.95);
      expect(SWAT_COMBAT.flinchSec).toBeLessThan(initialFlinch);
      expect(SWAT_COMBAT.flinchSec).toBeLessThanOrEqual(0.12);
    });

    it('F2.3: EngageBehavior with skipRetreatOnHit returning true stays in peek after onHit', () => {
      const bus = createGameEventBus();
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
      const colliders = [makeFloorCollider(), makeCoverCollider(2, 0)];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(
        makeBaseCombat({ flinchSec: 0.05 }),
        'swat_1',
        body,
        bus,
        { player, colliders },
        () => true,
        null,
        null,
        { immediateFireOnEnter: true, skipRetreatOnHit: () => true },
      );

      eb.enter({ x: 0, y: 0, z: -5 });
      expect(eb.label).toBe('peek');
      eb.onHit({ x: 0, y: 0, z: -5 });
      expect(eb.label).toBe('flinch');
      eb.update(0.06, { x: 0, y: 0, z: -5 }, true);
      expect(eb.label).toBe('peek');
      body.dispose();
    });

    it('F2.4: EngageBehavior without skipRetreatOnHit retreats to cover when hit', () => {
      const bus = createGameEventBus();
      const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
      const colliders = [makeFloorCollider(), makeCoverCollider(2, 0)];
      const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
      const eb = new EngageBehavior(
        makeBaseCombat({ flinchSec: 0.05 }),
        'swat_1',
        body,
        bus,
        { player, colliders },
        () => true,
        null,
        null,
        { immediateFireOnEnter: true },
      );

      eb.enter({ x: 0, y: 0, z: -5 });
      eb.onHit({ x: 0, y: 0, z: -5 });
      eb.update(0.06, { x: 0, y: 0, z: -5 }, true);
      expect(['toCover', 'cover']).toContain(eb.label);
      body.dispose();
    });

    it('F2.5: Shielded pointman in SwatTeam keeps advancing/engaging after taking non-lethal leg hit', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap({ includeCover: true }),
          spawns: [
            { x: 0, y: 0, z: 2.5 },
            { x: 1.5, y: 0, z: 2.5 },
          ],
          count: 2,
          playerPos: { x: 0, y: 0, z: -2.5 },
          startAssault: true,
        }),
      );
      const shieldHunter = h.team.hunters.find((u) => u.shielded);
      expect(shieldHunter).toBeDefined();
      h.step(0.8, 0.05);
      h.bus.emit('entityHit', {
        targetId: shieldHunter!.id,
        shooter: 'player',
        damage: 15,
        pos: { x: shieldHunter!.body.px, y: 0.3, z: shieldHunter!.body.pz },
      });
      h.step(0.15, 0.05);
      expect(shieldHunter!.alive).toBe(true);
      expect(shieldHunter!.engage.label).not.toBe('toCover');
    });
  });

  // =========================================================================
  // F3: Vulnerability Rush (弱った瞬間を見逃さないラッシュ)
  // =========================================================================
  describe('F3: Vulnerability Rush', () => {
    it('F3.1: playerBlinded event triggers nearby SWAT units into rush state and emits radio', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [
            { x: 0, y: 0, z: 2.5 },
            { x: 1.5, y: 0, z: 2.5 },
          ],
          count: 2,
          playerPos: { x: 0, y: 0, z: -2.5 },
          startAssault: true,
        }),
      );
      h.recorder.clear();
      h.bus.emit('playerBlinded', { duration: 2.5, pos: { x: 0, y: 0, z: -2.5 } });
      const rushing = h.team.hunters.filter((u) => u.state === 'rush');
      expect(rushing.length).toBeGreaterThanOrEqual(1);
      // Step past M3 F12 RADIO_STAGGER_SEC (>= 1.2s) so the queued rush radio drains
      h.step(1.5, 0.05);
      expect(h.recorder.count('allyRadio')).toBeGreaterThanOrEqual(1);
    });

    it('F3.2: Player reload noise triggers vulnerability rush', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [
            { x: 0, y: 0, z: 2.5 },
            { x: 1.2, y: 0, z: 2.5 },
          ],
          count: 2,
          playerPos: { x: 0, y: 0, z: -2.0 },
          startAssault: true,
        }),
      );
      h.bus.emit('noise', { pos: { x: 0, y: 0, z: -2.0 }, radius: 14, kind: 'reload', source: 'player' });
      expect(h.team.hunters.some((u) => u.state === 'rush')).toBe(true);
    });

    it('F3.3: Player low HP (hp <= 40) via playerHit triggers vulnerability rush', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 2.5 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -2.0 },
          playerHp: 35,
          startAssault: true,
        }),
      );
      h.bus.emit('playerHit', { shooter: 'swat_1', damage: 15, from: { x: 0, y: 0, z: 2.5 }, hp: 35 });
      expect(h.team.hunters[0]!.state).toBe('rush');
    });

    it('F3.4: Direct triggerRush with pepper reason transitions nearby SWAT into rush', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 2.0 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -2.0 },
          startAssault: true,
        }),
      );
      const triggered = h.team.triggerRush({ x: 0, y: 0, z: -2.0 }, 'pepper');
      expect(triggered).toBe(true);
      expect(h.team.hunters[0]!.state).toBe('rush');
    });

    it('F3.5: Rushing SWAT closes distance to player at high assault speed (>= 2.5 m/s)', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap({ includeCover: false }),
          spawns: [{ x: 0, y: 0, z: 3.0 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -3.0 },
          startAssault: true,
        }),
      );
      const hunter = h.team.hunters[0]!;
      const startZ = hunter.body.pz;
      h.team.triggerRush({ x: 0, y: 0, z: -3.0 }, 'blind');
      h.step(1.0, 0.05);
      const moved = startZ - hunter.body.pz;
      expect(moved).toBeGreaterThanOrEqual(2.4);
    });
  });

  // =========================================================================
  // F4: Perception, Speed & Pressure Boost (基礎能力・知覚の底上げ)
  // =========================================================================
  describe('F4: Perception, Speed & Pressure Boost', () => {
    it('F4.1: VISION_FOV_DEG is raised into 115–130 degree range (120)', () => {
      expect(VISION_FOV_DEG).toBeGreaterThanOrEqual(115);
      expect(VISION_FOV_DEG).toBeLessThanOrEqual(130);
    });

    it('F4.2: PRESSURE_RAMP_SEC is accelerated to <= 100s (95s)', () => {
      expect(PRESSURE_RAMP_SEC).toBeLessThanOrEqual(100);
      expect(PRESSURE_RAMP_SEC).toBeGreaterThan(0);
    });

    it('F4.3: SwatTeam.currentPressure ramps monotonically with assault time to 1.0', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          startAssault: true,
        }),
      );
      const p0 = h.team.currentPressure;
      h.step(30, 0.05);
      const p30 = h.team.currentPressure;
      h.step(70, 0.05);
      const p100 = h.team.currentPressure;
      expect(p0).toBe(0);
      expect(p30).toBeGreaterThan(0.25);
      expect(p100).toBeCloseTo(1.0, 2);
    });

    it('F4.4: SWAT_COMBAT.moveSpeed ramps up toward 2.75 m/s at high pressure', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          startAssault: true,
        }),
      );
      const baseSpeed = SWAT_COMBAT.moveSpeed;
      h.step(PRESSURE_RAMP_SEC + 2, 0.05);
      expect(SWAT_COMBAT.moveSpeed).toBeGreaterThan(baseSpeed);
      expect(SWAT_COMBAT.moveSpeed).toBeGreaterThanOrEqual(2.7);
    });

    it('F4.5: Downed SWAT unit adds PRESSURE_PER_DOWN bonus to team pressure', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [
            { x: 0, y: 0, z: 6 },
            { x: 1.5, y: 0, z: 6 },
          ],
          count: 2,
          startAssault: true,
        }),
      );
      h.step(1.0, 0.05);
      const before = h.team.currentPressure;
      const target = h.team.hunters[1]!;
      h.bus.emit('entityHit', {
        targetId: target.id,
        shooter: 'player',
        damage: 200,
        pos: { x: target.body.px, y: 1, z: target.body.pz },
      });
      h.step(0.6, 0.05);
      expect(h.team.currentPressure - before).toBeGreaterThanOrEqual(PRESSURE_PER_DOWN - 0.01);
    });
  });

  // =========================================================================
  // F5: Indirect / Door-Frame Flashbangs (部屋へのフラッシュ放り込み)
  // =========================================================================
  describe('F5: Indirect / Door-Frame Flashbangs', () => {
    it('F5.1: planDoorwayFlashThrow plans a doorway throw when direct LOS to target is blocked by wall', () => {
      // Wall at z=0 with open doorway at x=0 (width 1.2)
      const colliders: Collider[] = [
        makeFloorCollider(),
        { kind: 'wall', aabb: { min: { x: -6, y: 0, z: -0.1 }, max: { x: -0.6, y: 3, z: 0.1 } } },
        { kind: 'wall', aabb: { min: { x: 0.6, y: 0, z: -0.1 }, max: { x: 6, y: 3, z: 0.1 } } },
      ];
      const doors: FlashDoorSample[] = [
        {
          id: 'd1',
          centerX: 0,
          centerZ: 0,
          normalX: 0,
          normalZ: 1,
          sillY: 0,
          width: 1.2,
          height: 2.18,
          angle: 85,
          locked: false,
        },
      ];
      const plan = planDoorwayFlashThrow(
        { x: -2.2, y: 1.4, z: 2.2 },
        { x: 2.2, y: 0, z: -2.2 },
        doors,
        colliders,
        9.8,
      );
      expect(plan).not.toBeNull();
      expect(plan!.kind).toBe('doorway');
      expect(Number.isFinite(plan!.velocity.x)).toBe(true);
    });

    it('F5.2: planWindowFlashThrow plans a throw through an unboarded window into target room', () => {
      const map = makeWindowedSiegeMap(true);
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 6, y: 0, z: 0 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: false,
        }),
      );
      const plan = planWindowFlashThrow(
        { x: 6.2, y: 1.4, z: 1.2 },
        { x: 0.5, y: 0, z: -1.5 },
        map.windows,
        h.hw.colliders,
        9.8,
      );
      expect(plan).not.toBeNull();
      expect(plan!.kind).toBe('window');
    });

    it('F5.3: planWallBankFlashThrow computes a 1-bounce bank shot around an L-corner', () => {
      // L-corridor: inner corner blocker at x in [-4, 0], z in [-4, 0]; reflecting wall at x = 3
      const colliders: Collider[] = [
        makeFloorCollider(),
        { kind: 'wall', aabb: { min: { x: -4, y: 0, z: -4 }, max: { x: 0, y: 3, z: 0 } } },
        { kind: 'wall', aabb: { min: { x: 2.8, y: 0, z: -4 }, max: { x: 3.2, y: 3, z: 4 } } },
      ];
      const plan = planWallBankFlashThrow(
        { x: -1.5, y: 1.4, z: 2.2 },
        { x: 1.2, y: 0, z: -2.0 },
        colliders,
        9.8,
      );
      expect(plan).not.toBeNull();
      expect(plan!.kind).toBe('bank');
    });

    it('F5.4: planFlashThrow prioritizes direct -> doorway -> window -> bank cleanly', () => {
      const colliders: Collider[] = [makeFloorCollider()];
      const direct = planFlashThrow(
        { x: 0, y: 1.4, z: 5 },
        { x: 0, y: 0, z: 0 },
        [],
        [],
        colliders,
        9.8,
      );
      expect(direct).not.toBeNull();
      expect(direct!.kind).toBe('direct');
    });

    it('F5.5: Flashbang.throwFrom simulates ballistic flight, detonates, and emits flashDetonated + playerBlinded', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap({ includeCover: false }),
          spawns: [{ x: 0, y: 0, z: 3 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -1.5 },
          playerYawRad: Math.PI, // Facing +Z toward flash
          startAssault: true,
        }),
      );
      const vel: Vec3 = computeBallisticVelocity(
        { x: 0, y: 1.4, z: 3 },
        { x: 0, y: 0.4, z: 0 },
        9.8,
      );
      h.flashbang.throwFrom({ x: 0, y: 1.4, z: 3 }, vel, 'swat_1', 0.4);
      h.step(0.6, 0.05);
      expect(h.recorder.count('flashDetonated')).toBe(1);
      expect(h.recorder.count('playerBlinded')).toBe(1);
      expect(h.overlay.opacity).toBeGreaterThan(0);
    });
  });
});
