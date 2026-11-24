import { afterEach, describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../src/core/events';
import { listExteriorEntries } from '../../src/modes/SwatTeam';
import { Door } from '../../src/world/Door';
import {
  loadDoorConfig,
  makeSingleRoomMap,
  makeTwoDoorHouseMap,
  makeWindowedSiegeMap,
} from './helpers/headlessWorld';
import { EventRecorder, createSwatHarness, type SwatHarness } from './helpers/simDriver';
import type { BarricadeHooks, DoorWithExplosive, SwatTeamWithM2M3 } from './helpers/contracts';

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

describe('Tier 2 — M2 Boundary & Corner Cases (F6–F9)', () => {
  // =========================================================================
  // F6 Boundaries
  // =========================================================================
  describe('F6 Boundaries: Multi-Door Simultaneous Entry', () => {
    it('F6.B1: Upper-floor exterior doors (sillY > 0.5) are excluded from ground-floor exterior entry assignment', () => {
      const map = makeTwoDoorHouseMap();
      // Move door_north to 2nd floor (y = 3.0)
      map.doors[1]!.y = 3.0;
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 8 },
            { x: 1, y: 0, z: 8 },
            { x: 2, y: 0, z: 8 },
            { x: 3, y: 0, z: 8 },
          ],
          count: 4,
          startAssault: true,
        }),
      );
      const entries = listExteriorEntries(
        map.rooms,
        h.hw.doorSystem.doors.map((d) => ({
          id: d.id,
          centerX: d.centerX,
          centerZ: d.centerZ,
          normalX: d.normalX,
          normalZ: d.normalZ,
          sillY: d.sillY,
        })),
      );
      const groundEntries = entries.filter((e) => Math.abs(e.sillY) <= 0.5);
      expect(groundEntries.length).toBe(1);
      h.step(3.0, 0.05);
      // All hunters must still advance toward the ground-floor door without getting stuck
      expect(h.team.hunters.every((u) => Number.isFinite(u.body.px) && Number.isFinite(u.body.pz))).toBe(true);
    });

    it('F6.B2: Single-man SWAT team (count = 1) on multi-door map enters cleanly without waiting for another cell', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 0, y: 0, z: 7.5 }],
          count: 1,
          startAssault: true,
        }),
      );
      const startZ = h.team.hunters[0]!.body.pz;
      h.step(3.0, 0.05);
      expect(h.team.hunters[0]!.body.pz).toBeLessThan(startZ - 1.5);
    });

    it('F6.B3: If one cell is eliminated before simultaneous entry completes, surviving cell still breaches/enters', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 8 },
            { x: 1, y: 0, z: 8 },
            { x: 0, y: 0, z: -8 },
            { x: 1, y: 0, z: -8 },
          ],
          count: 4,
          startAssault: true,
        }),
      );
      // Kill Blue cell immediately
      h.bus.emit('entityHit', { targetId: 'swat_3', shooter: 'player', damage: 200, pos: { x: 0, y: 1, z: -8 } });
      h.bus.emit('entityHit', { targetId: 'swat_4', shooter: 'player', damage: 200, pos: { x: 1, y: 1, z: -8 } });
      h.step(6.0, 0.05);
      // Red cell must enter the building (z < 5) and not deadlock waiting for dead Blue cell
      const redInside = h.team.hunters.slice(0, 2).some((u) => u.body.pz < 4.5);
      expect(redInside).toBe(true);
    });

    it('F6.B4: 6-man SWAT team (3 cells) on 2-door map assigns all cells without out-of-bounds crash', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: -1, y: 0, z: 8 },
            { x: 1, y: 0, z: 8 },
            { x: -1, y: 0, z: 9 },
            { x: 1, y: 0, z: 9 },
            { x: -1, y: 0, z: 10 },
            { x: 1, y: 0, z: 10 },
          ],
          count: 6,
          startAssault: true,
        }),
      );
      h.step(4.0, 0.05);
      expect(h.team.aliveCount).toBe(6);
      expect(h.team.hunters.every((u) => Number.isFinite(u.body.px))).toBe(true);
    });

    it('F6.B5: Map with zero exterior doors does not throw during beginAssault or update', () => {
      const map = makeSingleRoomMap();
      map.doors = [];
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 2 },
            { x: 1, y: 0, z: 2 },
            { x: -1, y: 0, z: 2 },
            { x: 0, y: 0, z: 1 },
          ],
          count: 4,
          startAssault: true,
        }),
      );
      expect(() => h.step(2.0, 0.05)).not.toThrow();
    });
  });

  // =========================================================================
  // F7 Boundaries
  // =========================================================================
  describe('F7 Boundaries: Role-Split Pincer Flanking', () => {
    it('F7.B1: Single-cell team (2 SWAT) never stalls waiting for a nonexistent flank cell', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
          ],
          count: 2,
          playerPos: { x: 0, y: 0, z: -2 },
          startAssault: true,
        }),
      );
      h.step(2.0, 0.05);
      expect(h.recorder.count('shotFired')).toBeGreaterThanOrEqual(1);
    });

    it('F7.B2: Pincer flanker does not get stuck when alternate door is locked (breaches or reroutes)', () => {
      const map = makeTwoDoorHouseMap({ northLocked: true });
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3.0 },
            { x: 1, y: 0, z: 3.0 },
            { x: 0, y: 0, z: -6.5 },
            { x: 1, y: 0, z: -6.5 },
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: true,
        }),
      );
      h.step(10.0, 0.05);
      const northDoor = h.hw.doorSystem.doors.find((d) => d.id === 'door_north')!;
      const blueMovedIn = h.team.hunters.slice(2).some((u) => u.body.pz > -4.8);
      expect(!northDoor.locked || blueMovedIn).toBe(true);
    });

    it('F7.B3: When player moves to a new room, flanker updates target instead of camping stale coordinates', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3.2 },
            { x: 1, y: 0, z: 3.2 },
            { x: 0, y: 0, z: -6.0 },
            { x: 1, y: 0, z: -6.0 },
          ],
          count: 4,
          playerPos: { x: -3, y: 0, z: 0 },
          playerHp: 1000,
          startAssault: true,
        }),
      );
      h.step(1.5, 0.05);
      h.player.moveTo(3, 0, -1);
      h.bus.emit('noise', { pos: { x: 3, y: 0, z: -1 }, radius: 20, kind: 'gunshot', source: 'player' });
      h.step(3.0, 0.05);
      expect(h.team.lastSighting).not.toBeNull();
      expect(h.team.lastSighting!.x).toBeGreaterThan(0);
    });

    it('F7.B4: Dead player stops pincer combat cleanly without throwing', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
            { x: 0, y: 0, z: -3 },
            { x: 1, y: 0, z: -3 },
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: true,
        }),
      );
      h.player.takeDamage(200);
      expect(h.player.alive).toBe(false);
      expect(() => h.step(2.0, 0.05)).not.toThrow();
    });

    it('F7.B5: Blinded flanker pauses flanking until flash blindness expires', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
            { x: 0, y: 0, z: -3 },
            { x: 1, y: 0, z: -3 },
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: true,
        }),
      );
      h.bus.emit('flashDetonated', { pos: { x: 0, y: 0.5, z: -3 }, radius: 6, blindSec: 3, thrower: 'player' });
      expect(h.team.hunters[2]!.blindLeft).toBeGreaterThan(0);
      const posBefore = { x: h.team.hunters[2]!.body.px, z: h.team.hunters[2]!.body.pz };
      h.step(0.4, 0.05);
      const moved = Math.hypot(h.team.hunters[2]!.body.px - posBefore.x, h.team.hunters[2]!.body.pz - posBefore.z);
      expect(moved).toBeLessThan(0.35);
    });
  });

  // =========================================================================
  // F8 Boundaries
  // =========================================================================
  describe('F8 Boundaries: C2 Explosive Breaching', () => {
    it('F8.B1: Door.breachExplosive on an already-open door is safe and does not produce NaN angle', () => {
      const bus = createGameEventBus();
      const door = new Door(
        { id: 'd_open', x: 0, z: 0, yaw: 0, locked: false, maxAngle: 100, width: 1.2 },
        loadDoorConfig(),
        3.0,
        bus,
      ) as DoorWithExplosive;
      expect(typeof door.breachExplosive).toBe('function');
      door.angle = 90;
      door.targetAngle = 90;
      door.breachExplosive!(0, 1.5);
      door.update(0.05, 0, 5, 0.35, 0);
      expect(Number.isFinite(door.angle)).toBe(true);
      expect(door.angle).toBeLessThanOrEqual(door.maxAngle + 0.01);
      door.dispose();
    });

    it('F8.B2: Player standing far outside C2 blast radius takes zero blast damage', () => {
      const map = makeSingleRoomMap({ lockedDoor: true });
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 6.0 },
            { x: 1.2, y: 0, z: 6.0 },
            { x: -1.2, y: 0, z: 6.0 },
            { x: 2.4, y: 0, z: 6.0 },
            { x: -2.4, y: 0, z: 6.0 },
          ],
          count: 5,
          // Player far away at north wall (z = -3.2, > 7m from door_south at z = 4)
          playerPos: { x: 0, y: 0, z: -3.2 },
          startAssault: false,
        }),
      );
      for (const id of ['swat_2', 'swat_3', 'swat_4', 'swat_5']) {
        h.bus.emit('entityHit', { targetId: id, shooter: 'player', damage: 200, pos: { x: 1, y: 1, z: 6 } });
      }
      h.team.beginAssault();
      h.step(55, 0.05);
      expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
      const blastHits = h.recorder.of('playerHit').filter((e) => e.payload.shooter === 'c2' || /c2|breach/i.test(e.payload.shooter));
      expect(blastHits.length).toBe(0);
    });

    it('F8.B3: Door.breachExplosive on a double door unlocks and swings both leaves cleanly', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const door = new Door(
        { id: 'd_double', x: 0, z: 0, yaw: 0, locked: true, maxAngle: 100, width: 2.0, double: true },
        loadDoorConfig(),
        3.0,
        bus,
      ) as DoorWithExplosive;
      expect(typeof door.breachExplosive).toBe('function');
      expect(door.breachExplosive!(0, 1.5)).toBe(true);
      expect(door.locked).toBe(false);
      expect(rec.count('doorBreached')).toBe(1);
      rec.dispose();
      door.dispose();
    });

    it('F8.B4: Killing SWAT unit mid-C2-arming cancels detonation cleanly (no phantom explosion)', () => {
      const map = makeSingleRoomMap({ lockedDoor: true });
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 5.5 },
            { x: 1.2, y: 0, z: 6.0 },
            { x: -1.2, y: 0, z: 6.0 },
            { x: 2.4, y: 0, z: 6.0 },
            { x: -2.4, y: 0, z: 6.0 },
          ],
          count: 5,
          playerPos: { x: 0, y: 0, z: -2.0 },
          startAssault: false,
        }),
      );
      for (const id of ['swat_2', 'swat_3', 'swat_4', 'swat_5']) {
        h.bus.emit('entityHit', { targetId: id, shooter: 'player', damage: 200, pos: { x: 1, y: 1, z: 6 } });
      }
      h.team.beginAssault();
      // Wait for first c2Beep, then kill the breacher
      let sawBeep = false;
      for (let i = 0; i < 1200; i++) {
        h.step(0.05, 0.05);
        if (h.recorder.count('c2Beep') > 0) {
          sawBeep = true;
          h.bus.emit('entityHit', {
            targetId: 'swat_1',
            shooter: 'player',
            damage: 200,
            pos: { x: h.team.hunters[0]!.body.px, y: 1, z: h.team.hunters[0]!.body.pz },
          });
          break;
        }
      }
      expect(sawBeep).toBe(true);
      h.step(5.0, 0.05);
      expect(h.recorder.count('c2Detonated')).toBe(0);
    });

    it('F8.B5: C2 breach on a booby-trapped door handles trap interaction without throwing or infinite recursion', () => {
      const map = makeSingleRoomMap({ lockedDoor: true });
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 0, y: 0, z: 6.0 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -2.5 },
          startAssault: true,
        }),
      );
      let trapped = true;
      let trapResolved = false;
      h.team.attachTraps({
        isTrapped: (id) => trapped && id === 'door_south',
        trappedDoorIds: () => (trapped ? ['door_south'] : []),
        detonate: () => {
          trapped = false;
          trapResolved = true;
        },
        disarm: () => {
          trapped = false;
          trapResolved = true;
        },
      });
      expect(() => h.step(60, 0.05)).not.toThrow();
      const door = h.hw.doorSystem.doors[0]!;
      expect(door.locked).toBe(false);
      expect(trapped).toBe(false);
      expect(trapResolved).toBe(true);
      expect(h.recorder.count('c2Detonated') + h.recorder.count('doorBreached')).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // F9 Boundaries
  // =========================================================================
  describe('F9 Boundaries: Active Window Barricade Destruction', () => {
    it('F9.B1: SWAT does NOT shoot windows when listBoarded() returns empty array', () => {
      const map = makeWindowedSiegeMap(true);
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 6.5, y: 0, z: 0 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -3.5 },
          startAssault: true,
        }),
      );
      const team = h.team as SwatTeamWithM2M3;
      expect(typeof team.attachBarricades).toBe('function');
      team.attachBarricades!({ listBoarded: () => [] });
      h.step(2.0, 0.05);
      const impacts = h.recorder.of('bulletImpact').filter((e) => e.payload.shooter.startsWith('swat_'));
      expect(impacts.length).toBe(0);
    });

    it('F9.B2: SWAT does NOT shoot a boarded window on a different floor (floorY mismatch)', () => {
      const map = makeWindowedSiegeMap(true);
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 6.5, y: 0, z: 0 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -3.5 },
          startAssault: true,
        }),
      );
      const team = h.team as SwatTeamWithM2M3;
      expect(typeof team.attachBarricades).toBe('function');
      const hooks: BarricadeHooks = {
        listBoarded: () => [
          { id: 'win_2f', center: { x: 4, y: 4.55, z: 0 }, normal: { x: 1, y: 0, z: 0 }, floorY: 3.0, hp: 170, boarded: true },
        ],
      };
      team.attachBarricades!(hooks);
      h.step(2.0, 0.05);
      const impacts = h.recorder.of('bulletImpact').filter((e) => e.payload.shooter.startsWith('swat_'));
      expect(impacts.length).toBe(0);
    });

    it('F9.B3: SWAT ignores boarded windows out of engagement range (> 20m)', () => {
      const map = makeWindowedSiegeMap(true);
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 6.5, y: 0, z: 0 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -3.5 },
          startAssault: true,
        }),
      );
      const team = h.team as SwatTeamWithM2M3;
      expect(typeof team.attachBarricades).toBe('function');
      team.attachBarricades!({
        listBoarded: () => [
          { id: 'win_far', center: { x: 50, y: 1.5, z: 50 }, normal: { x: 1, y: 0, z: 0 }, floorY: 0, hp: 170, boarded: true },
        ],
      });
      h.step(2.0, 0.05);
      const impacts = h.recorder.of('bulletImpact').filter((e) => e.payload.shooter.startsWith('swat_'));
      expect(impacts.length).toBe(0);
    });

    it('F9.B4: SWAT stops shooting a barricade once its hp drops to 0 / boarded becomes false', () => {
      const map = makeWindowedSiegeMap(true);
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 6.5, y: 0, z: 0 }],
          count: 1,
          playerPos: { x: 2.5, y: 0, z: -3.5 },
          startAssault: true,
        }),
      );
      const team = h.team as SwatTeamWithM2M3;
      expect(typeof team.attachBarricades).toBe('function');
      const plankCol = {
        kind: 'wall' as const,
        aabb: { min: { x: 3.87, y: 0.84, z: -0.96 }, max: { x: 4.13, y: 2.26, z: 0.96 } },
      };
      h.hw.colliders.push(plankCol);
      let boarded = true;
      team.attachBarricades!({
        listBoarded: () =>
          boarded
            ? [{ id: 'win_0', center: { x: 4, y: 1.55, z: 0 }, normal: { x: 1, y: 0, z: 0 }, floorY: 0, hp: 20, boarded: true }]
            : [],
      });
      h.bus.on('bulletImpact', () => {
        boarded = false;
        plankCol.aabb.min.y = -1000;
        plankCol.aabb.max.y = -999.99;
      });
      h.bus.emit('noise', { pos: { x: 0, y: 0, z: 0 }, radius: 20, kind: 'gunshot', source: 'player' });
      h.step(2.0, 0.05);
      const countAtBreak = h.recorder.of('bulletImpact').length;
      h.step(2.0, 0.05);
      expect(h.recorder.of('bulletImpact').length).toBe(countAtBreak);
    });

    it('F9.B5: Blinded SWAT does NOT shoot window barricades while flash-blinded', () => {
      const map = makeWindowedSiegeMap(true);
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 6.5, y: 0, z: 0 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: true,
        }),
      );
      const team = h.team as SwatTeamWithM2M3;
      expect(typeof team.attachBarricades).toBe('function');
      team.attachBarricades!({
        listBoarded: () => [
          { id: 'win_0', center: { x: 4, y: 1.55, z: 0 }, normal: { x: 1, y: 0, z: 0 }, floorY: 0, hp: 170, boarded: true },
        ],
      });
      h.bus.emit('flashDetonated', { pos: { x: 6.5, y: 0.5, z: 0 }, radius: 6, blindSec: 4, thrower: 'player' });
      h.step(1.5, 0.05);
      const impacts = h.recorder.of('bulletImpact').filter((e) => e.payload.shooter.startsWith('swat_'));
      expect(impacts.length).toBe(0);
    });
  });
});
