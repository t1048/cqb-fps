import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../src/core/events';
import { cellSizes, listExteriorEntries } from '../../src/modes/SwatTeam';
import { Door } from '../../src/world/Door';
import { Fortify } from '../../src/modes/Fortify';
import { Interaction } from '../../src/player/Interaction';
import { hasLineOfSight } from '../../src/weapons/Flashbang';
import type { PlayerController } from '../../src/player/PlayerController';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import {
  generateRealMap,
  loadDoorConfig,
  makeSingleRoomMap,
  makeTwoDoorHouseMap,
  makeWindowedSiegeMap,
} from './helpers/headlessWorld';
import {
  EventRecorder,
  createHeadlessInput,
  createSwatHarness,
  type SwatHarness,
} from './helpers/simDriver';
import type {
  BarricadeHooks,
  BarricadeInfo,
  DoorWithExplosive,
  FortifyWithBarricades,
  SwatTeamWithM2M3,
} from './helpers/contracts';

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

describe('Tier 1 — M2 Tactical Overhaul (F6–F9)', () => {
  // =========================================================================
  // F6: Multi-Door Simultaneous Entry (多方向同時突入)
  // =========================================================================
  describe('F6: Multi-Door Simultaneous Entry', () => {
    it('F6.1: 4-man SWAT team splits into two cells (Red + Blue) with distinct callsigns', () => {
      expect(cellSizes(4)).toEqual([2, 2]);
      const h = track(
        createSwatHarness({
          map: makeTwoDoorHouseMap(),
          spawns: [
            { x: -1, y: 0, z: 8 },
            { x: 1, y: 0, z: 8 },
            { x: -1, y: 0, z: -8 },
            { x: 1, y: 0, z: -8 },
          ],
          count: 4,
          startAssault: false,
        }),
      );
      const prefixes = new Set(h.team.hunters.map((u) => u.callsign.split('-')[0]));
      expect(prefixes.has('Red')).toBe(true);
      expect(prefixes.has('Blue')).toBe(true);
    });

    it('F6.2: Multi-door house exposes >= 2 exterior entry portals for cell distribution', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 8 },
            { x: 1, y: 0, z: 8 },
            { x: 0, y: 0, z: 9 },
            { x: 1, y: 0, z: 9 },
          ],
          count: 4,
          startAssault: false,
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
      expect(entries.length).toBe(2);
    });

    it('F6.3: Red and Blue cells diverge toward distinct exterior doors (South and North) on beginAssault', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: -1, y: 0, z: 8 },
            { x: 1, y: 0, z: 8 },
            { x: -2, y: 0, z: 8 },
            { x: 2, y: 0, z: 8 },
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: true,
        }),
      );
      h.step(8.0, 0.05);
      const red = h.team.hunters.filter((u) => u.callsign.startsWith('Red'));
      const blue = h.team.hunters.filter((u) => u.callsign.startsWith('Blue'));
      const redAvgZ = red.reduce((s, u) => s + u.body.pz, 0) / red.length;
      const blueAvgZ = blue.reduce((s, u) => s + u.body.pz, 0) / blue.length;
      // Red and Blue should approach/enter from opposite sides (distinct Z positions)
      expect(Math.abs(redAvgZ - blueAvgZ)).toBeGreaterThan(2.5);
    });

    it('F6.4: Simultaneous multi-door entry emits coordinated radio callouts during stack/breach', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: -0.8, y: 0, z: 7 },
            { x: 0.8, y: 0, z: 7 },
            { x: -0.8, y: 0, z: -7 },
            { x: 0.8, y: 0, z: -7 },
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: true,
        }),
      );
      h.step(6.0, 0.05);
      const radios = h.recorder.of('allyRadio');
      expect(radios.length).toBeGreaterThanOrEqual(2);
      const hasCoordText = radios.some(
        (r) =>
          /スタック|配置|カウント|3.*2.*1|ブリーチ|突入|Red|Blue/i.test(r.payload.text) ||
          /stack|breach|3.*2.*1|entry|go/i.test(r.payload.voiceText ?? ''),
      );
      expect(hasCoordText).toBe(true);
    });

    it('F6.5: Single-door compact map falls back gracefully and enters through the sole exterior door', () => {
      const map = generateRealMap('house_compact', 42);
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: map.playerSpawn.x, y: map.playerSpawn.y, z: map.playerSpawn.z },
            { x: map.playerSpawn.x + 0.9, y: map.playerSpawn.y, z: map.playerSpawn.z },
            { x: map.playerSpawn.x - 0.9, y: map.playerSpawn.y, z: map.playerSpawn.z },
            { x: map.playerSpawn.x, y: map.playerSpawn.y, z: map.playerSpawn.z + 0.9 },
          ],
          count: 4,
          startAssault: true,
        }),
      );
      h.step(5.0, 0.05);
      expect(h.team.aliveCount).toBe(4);
      // Hunters must actively move (not stuck in staging)
      expect(h.team.hunters.every((u) => u.state !== 'staging')).toBe(true);
    });
  });

  // =========================================================================
  // F7: Role-Split Pincer Flanking (役割分担による挟撃・ピンサー機動)
  // =========================================================================
  describe('F7: Role-Split Pincer Flanking', () => {
    it('F7.1: When Red engages player from South, Blue starting on the SAME South side routes toward North flank', () => {
      const map = makeTwoDoorHouseMap({ includeInteriorDivider: false });
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3.2 }, // Red-1 (shield) inside south
            { x: 1.0, y: 0, z: 3.2 }, // Red-2 inside south
            { x: -1.2, y: 0, z: 6.5 }, // Blue-1 ALSO on South side initially
            { x: 1.2, y: 0, z: 6.5 }, // Blue-2 ALSO on South side initially
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 0.2 },
          startAssault: true,
        }),
      );
      const blueInitZ = h.team.hunters.filter((u) => u.callsign.startsWith('Blue'))[0]!.body.pz;
      expect(blueInitZ).toBeGreaterThan(5.0);
      h.step(6.0, 0.05);
      const blue = h.team.hunters.filter((u) => u.callsign.startsWith('Blue'));
      // Red engages player (firing shots) while Blue actively routes northward away from shared South spawn
      expect(h.recorder.count('shotFired')).toBeGreaterThanOrEqual(1);
      expect(blue[0]!.body.pz).toBeLessThan(blueInitZ - 2.0);
    });

    it('F7.2: Engaging frontal cell fires shots while flanking cell maneuvers through alternate doorway', () => {
      const map = makeTwoDoorHouseMap({ includeInteriorDivider: true });
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3.5 },
            { x: 1.0, y: 0, z: 3.5 },
            { x: 0, y: 0, z: -6.5 },
            { x: 1.0, y: 0, z: -6.5 },
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 1.2 },
          startAssault: true,
        }),
      );
      const blueStartZ = h.team.hunters[2]!.body.pz;
      h.step(4.5, 0.05);
      const redShots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'swat_1' || e.payload.shooter === 'swat_2');
      expect(redShots.length).toBeGreaterThanOrEqual(1);
      // Blue moves closer to the house/player from the north side
      expect(h.team.hunters[2]!.body.pz).toBeGreaterThan(blueStartZ + 1.0);
    });

    it('F7.3: Pincer flanker radio callout announces flanking maneuver when secondary cell takes flank role', () => {
      const map = makeTwoDoorHouseMap({ includeInteriorDivider: false });
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3.2 },
            { x: 1.0, y: 0, z: 3.2 },
            { x: 0, y: 0, z: -6.5 },
            { x: 1.0, y: 0, z: -6.5 },
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: true,
        }),
      );
      h.step(4.0, 0.05);
      const radios = h.recorder.of('allyRadio');
      const hasFlankRadio = radios.some(
        (r) =>
          /回り込|裏取り|挟撃|ピンサー|別ルート|正面|釘付け/i.test(r.payload.text) ||
          /flank|pincer|pin|behind/i.test(r.payload.voiceText ?? ''),
      );
      expect(hasFlankRadio).toBe(true);
    });

    it('F7.4: Shielded pointman in engaging cell advances frontally to pin player', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3.5 },
            { x: 1.2, y: 0, z: 3.5 },
            { x: 0, y: 0, z: -6.5 },
            { x: 1.2, y: 0, z: -6.5 },
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: true,
        }),
      );
      const shield = h.team.hunters.find((u) => u.shielded)!;
      const startDist = Math.hypot(shield.body.px, shield.body.pz);
      h.step(2.5, 0.05);
      const endDist = Math.hypot(shield.body.px, shield.body.pz);
      expect(endDist).toBeLessThan(startDist);
    });

    it('F7.5: When engaging Red cell is eliminated, flanking Blue cell transitions to direct engagement', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 3.0 },
            { x: 1.0, y: 0, z: 3.0 },
            { x: 0, y: 0, z: -3.0 },
            { x: 1.0, y: 0, z: -3.0 },
          ],
          count: 4,
          playerPos: { x: 0, y: 0, z: 0 },
          startAssault: true,
        }),
      );
      h.step(0.6, 0.05);
      // Eliminate Red cell
      h.bus.emit('entityHit', { targetId: 'swat_1', shooter: 'player', damage: 200, pos: { x: 0, y: 1, z: 3 } });
      h.bus.emit('entityHit', { targetId: 'swat_2', shooter: 'player', damage: 200, pos: { x: 1, y: 1, z: 3 } });
      h.step(1.5, 0.05);
      const blueActive = h.team.hunters
        .filter((u) => u.callsign.startsWith('Blue'))
        .some((u) => u.state === 'engage' || u.state === 'rush' || u.state === 'hunt');
      expect(blueActive).toBe(true);
    });
  });

  // =========================================================================
  // F8: C2 Explosive Breaching (C2爆破ブリーチ)
  // =========================================================================
  describe('F8: C2 Explosive Breaching', () => {
    it('F8.1: Door.breachExplosive unlocks a locked door, emits doorBreached, and swings open rapidly', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const door = new Door(
        { id: 'door_c2', x: 0, z: 0, yaw: 0, locked: true, maxAngle: 100, width: 1.2 },
        loadDoorConfig(),
        3.0,
        bus,
      ) as DoorWithExplosive;

      expect(typeof door.breachExplosive, 'Door.breachExplosive must be implemented in M2').toBe('function');
      const ok = door.breachExplosive!(0, 1.5);
      expect(ok).toBe(true);
      expect(door.locked).toBe(false);
      expect(rec.count('doorBreached')).toBe(1);
      // High-speed swing (speedMultiplier = 8; Door.update clamps dt to 0.05s, so step 3 ticks)
      for (let i = 0; i < 3; i++) door.update(0.05, 0, 5, 0.35, 0);
      expect(door.angle).toBeGreaterThan(50);
      rec.dispose();
      door.dispose();
    });

    it('F8.2: High-pressure SWAT uses C2 explosive breach on locked door and emits c2Beep + c2Detonated', () => {
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
          playerPos: { x: 0, y: 0, z: -2.0 },
          startAssault: false,
        }),
      );
      // Satisfy PROJECT.md:45 high-pressure C2 precondition (pressure >= 0.4) before breaching locked door_south
      for (const id of ['swat_2', 'swat_3', 'swat_4', 'swat_5']) {
        h.bus.emit('entityHit', { targetId: id, shooter: 'player', damage: 200, pos: { x: 1, y: 1, z: 6 } });
      }
      h.team.beginAssault();
      h.step(55, 0.05);
      expect(h.recorder.count('c2Beep')).toBeGreaterThanOrEqual(1);
      expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
      expect(h.hw.doorSystem.doors[0]!.locked).toBe(false);
    });

    it('F8.3: Player camping directly behind a C2-breached door takes directional blast damage and view kick', () => {
      const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 6.0 },
            { x: 1.0, y: 0, z: 6.0 },
            { x: -1.0, y: 0, z: 6.0 },
            { x: 2.0, y: 0, z: 6.0 },
            { x: -2.0, y: 0, z: 6.0 },
          ],
          count: 5,
          // Player waiting directly behind door_south at (0, 3.0)
          playerPos: { x: 0, y: 0, z: 3.0 },
          startAssault: false,
        }),
      );
      // Down 4 SWAT to push pressure >= 0.4 immediately for C2 breach per PROJECT.md:45
      for (const id of ['swat_2', 'swat_3', 'swat_4', 'swat_5']) {
        h.bus.emit('entityHit', { targetId: id, shooter: 'player', damage: 200, pos: { x: 1, y: 1, z: 6 } });
      }
      h.team.beginAssault();
      // Also make noise inside to pull SWAT directly to the locked door
      h.bus.emit('noise', { pos: { x: 0, y: 0, z: 2.0 }, radius: 30, kind: 'gunshot', source: 'player' });
      h.step(60, 0.05);
      expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
      expect(h.player.hp).toBeLessThan(100);
      expect(h.player.viewKicks.length).toBeGreaterThanOrEqual(1);
    });

    it('F8.4: C2 detonation stuns nearby player via FlashOverlay', () => {
      const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: 0, y: 0, z: 6.0 },
            { x: 1.0, y: 0, z: 6.0 },
            { x: -1.0, y: 0, z: 6.0 },
            { x: 2.0, y: 0, z: 6.0 },
            { x: -2.0, y: 0, z: 6.0 },
            { x: 0, y: 0, z: 7.0 },
          ],
          count: 6,
          playerPos: { x: 0, y: 0, z: 3.0 },
          startAssault: false,
        }),
      );
      for (const id of ['swat_3', 'swat_4', 'swat_5', 'swat_6']) {
        h.bus.emit('entityHit', { targetId: id, shooter: 'player', damage: 200, pos: { x: 1, y: 1, z: 6 } });
      }
      h.team.beginAssault();
      let sawOverlay = false;
      for (let i = 0; i < 1200; i++) {
        h.step(0.05, 0.05);
        if (h.recorder.count('c2Detonated') > 0 && h.overlay.opacity > 0) {
          sawOverlay = true;
          break;
        }
      }
      expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
      expect(sawOverlay).toBe(true);
    });

    it('F8.5: C2 detonation emits doorBreached with inward normal direction vector', () => {
      const bus = createGameEventBus();
      const rec = new EventRecorder(bus);
      const door = new Door(
        { id: 'door_dir', x: 0, z: 4, yaw: 0, locked: true, maxAngle: 100, width: 1.2 },
        loadDoorConfig(),
        3.0,
        bus,
      ) as DoorWithExplosive;
      expect(typeof door.breachExplosive).toBe('function');
      door.breachExplosive!(0, 5.5); // from +Z side, should blast toward -Z
      const ev = rec.of('doorBreached')[0];
      expect(ev).toBeDefined();
      expect(ev!.payload.dir.z).toBeLessThan(0);
      rec.dispose();
      door.dispose();
    });
  });

  // =========================================================================
  // F9: Active Window Barricade Destruction (窓バリケードの積極破壊)
  // =========================================================================
  describe('F9: Active Window Barricade Destruction', () => {
    it('F9.1: Fortify exposes listBoarded() contract returning BarricadeInfo[]', () => {
      const map = makeWindowedSiegeMap(false);
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 6, y: 0, z: 0 }],
          count: 1,
          startAssault: false,
        }),
      );
      const scene = new THREE.Scene();
      const interaction = new Interaction(createHeadlessInput(), 100);
      const fortify = new Fortify({
        windows: map.windows,
        colliders: h.hw.colliders,
        scene,
        textures: h.hw.textures,
        player: h.player as unknown as PlayerController,
        input: createHeadlessInput(),
        interaction,
        doors: h.hw.doors,
        subtitle: h.subtitle,
        bus: h.bus,
        weapons: h.weapons as unknown as WeaponSystem,
        allies: () => [],
        civilians: () => [],
        entry: { x: 0, y: 0, z: 6 },
        isPrep: () => true,
        showGauge: () => {},
        onCivilianKilled: () => {},
      }) as FortifyWithBarricades;

      expect(typeof fortify.listBoarded, 'Fortify.listBoarded() must be implemented in M2').toBe('function');
      expect(Array.isArray(fortify.listBoarded!())).toBe(true);
      fortify.dispose();
    });

    it('F9.2: SwatTeam exposes attachBarricades(hooks) contract method', () => {
      const h = track(
        createSwatHarness({
          map: makeWindowedSiegeMap(false),
          spawns: [{ x: 6, y: 0, z: 0 }],
          count: 1,
          startAssault: false,
        }),
      );
      const team = h.team as SwatTeamWithM2M3;
      expect(typeof team.attachBarricades, 'SwatTeam.attachBarricades() must be implemented in M2').toBe('function');
    });

    it('F9.3: SWAT fires at LOS-blocking boarded window when barricades are attached', () => {
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

      const barricade: BarricadeInfo = {
        id: 'win_0',
        center: { x: 4, y: 1.55, z: 0 },
        normal: { x: 1, y: 0, z: 0 },
        floorY: 0,
        hp: 170,
        boarded: true,
      };
      const plankCol = {
        kind: 'wall' as const,
        aabb: { min: { x: 3.87, y: 0.84, z: -0.96 }, max: { x: 4.13, y: 2.26, z: 0.96 } },
      };
      h.hw.colliders.push(plankCol);
      const hooks: BarricadeHooks = {
        listBoarded: () => (barricade.boarded ? [barricade] : []),
      };
      team.attachBarricades!(hooks);
      // Give SWAT player location inside the room so window blocks LOS
      h.bus.emit('noise', { pos: { x: 0, y: 0, z: 0 }, radius: 20, kind: 'gunshot', source: 'player' });
      h.step(3.5, 0.05);

      const impacts = h.recorder.of('bulletImpact').filter((e) => e.payload.shooter.startsWith('swat_'));
      expect(impacts.length).toBeGreaterThanOrEqual(1);
    });

    it('F9.4: Repeated SWAT bulletImpact hits reduce barricade HP and break the window open', () => {
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

      const plankCol = {
        kind: 'wall' as const,
        aabb: { min: { x: 3.87, y: 0.84, z: -0.96 }, max: { x: 4.13, y: 2.26, z: 0.96 } },
      };
      h.hw.colliders.push(plankCol);
      let hp = 40;
      const hooks: BarricadeHooks = {
        listBoarded: () =>
          hp > 0
            ? [{ id: 'win_0', center: { x: 4, y: 1.55, z: 0 }, normal: { x: 1, y: 0, z: 0 }, floorY: 0, hp, boarded: true }]
            : [],
      };
      h.bus.on('bulletImpact', (e) => {
        if (Math.hypot(e.pos.x - 4, e.pos.z - 0) < 1.2) {
          hp = Math.max(0, hp - e.damage);
          if (hp <= 0) {
            plankCol.aabb.min.y = -1000;
            plankCol.aabb.max.y = -999.99;
          }
        }
      });
      team.attachBarricades!(hooks);
      h.bus.emit('noise', { pos: { x: 0, y: 0, z: 0 }, radius: 20, kind: 'gunshot', source: 'player' });
      h.step(5.0, 0.05);
      expect(hp).toBe(0);
    });

    it('F9.5: Boarding a window via Fortify blocks LOS and breaking it via bulletImpact restores LOS', () => {
      const map = makeWindowedSiegeMap(true);
      const h = track(
        createSwatHarness({
          map,
          spawns: [{ x: 6.5, y: 0, z: 0 }],
          count: 1,
          // Stand inside facing East (+X -> yaw = -PI/2) within reach of the East window at (4, 0)
          playerPos: { x: 2.8, y: 0, z: 0 },
          playerYawRad: -Math.PI / 2,
          startAssault: false,
        }),
      );
      let firstPress = true;
      const holdInput = {
        isPointerLocked: true,
        isOrderMenuOpen: false,
        wasMousePressed: () => false,
        wasPressed: (k: string) => {
          if (k === 'interact' && firstPress) {
            firstPress = false;
            return true;
          }
          return false;
        },
        isDown: (k: string) => k === 'interact',
        isMouseDown: () => false,
        consumeWheel: () => 0,
        endFrame: () => {},
      } as unknown as import('../../src/core/InputManager').InputManager;

      const scene = new THREE.Scene();
      const interaction = new Interaction(holdInput, 100);
      const fortify = new Fortify({
        windows: map.windows,
        colliders: h.hw.colliders,
        scene,
        textures: h.hw.textures,
        player: h.player as unknown as PlayerController,
        input: holdInput,
        interaction,
        doors: h.hw.doors,
        subtitle: h.subtitle,
        bus: h.bus,
        weapons: h.weapons as unknown as WeaponSystem,
        allies: () => [],
        civilians: () => [],
        entry: { x: 0, y: 0, z: 6 },
        isPrep: () => true,
        showGauge: () => {},
        onCivilianKilled: () => {},
      }) as FortifyWithBarricades;

      // Initially unboarded -> LOS is clear through window
      expect(hasLineOfSight(h.hw.colliders, { x: 6.0, y: 1.5, z: 0 }, { x: 0, y: 1.5, z: 0 })).toBe(true);

      // Hold interact to board the East window
      for (let i = 0; i < 60; i++) interaction.update(0.05);
      expect(typeof fortify.listBoarded).toBe('function');
      expect(fortify.listBoarded!().length).toBe(1);
      // Boarded window must block LOS
      expect(hasLineOfSight(h.hw.colliders, { x: 6.0, y: 1.5, z: 0 }, { x: 0, y: 1.5, z: 0 })).toBe(false);

      // Destroy barricade via bulletImpact hits
      const boarded = fortify.listBoarded!()[0]!;
      for (let i = 0; i < 15 && fortify.listBoarded!().length > 0; i++) {
        h.bus.emit('bulletImpact', { pos: boarded.center, damage: 25, shooter: 'swat_1' });
      }
      expect(fortify.listBoarded!().length).toBe(0);
      // Breaking barricade restores LOS through the window opening
      expect(hasLineOfSight(h.hw.colliders, { x: 6.0, y: 1.5, z: 0 }, { x: 0, y: 1.5, z: 0 })).toBe(true);
      fortify.dispose();
    });
  });
});
