import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SuspectState } from '../../../src/core/events';
import type { AllyDef, EntityDef, Vec3 } from '../../../src/core/types';
import { SWAT_COMBAT, SHIELD_COMBAT } from '../../../src/modes/SwatTeam';
import { hasLineOfSight } from '../../../src/weapons/Flashbang';
import { GAS_CLOUD_RADIUS } from '../../../src/weapons/TearGas';
import {
  countDynamicLights,
  createParityPair,
  createSquadHarness,
  defaultAllies,
  emitContractEvent,
  findOpticsGroups,
  hasClothColor,
  loadRawSquadJson,
  loadSquadConfig,
  loadSwatProfileModule,
  loadSwatTacticsModule,
  loadTacticalOpticsModule,
  makeSingleRoomMap,
  makeTwoDoorHouseMap,
  makeWindowedSiegeMap,
  type ParityPair,
  type SquadHarness,
} from '../helpers/squadSimDriver';

const activeHarnesses: Array<{ dispose(): void }> = [];
afterEach(() => {
  while (activeHarnesses.length > 0) {
    activeHarnesses.pop()!.dispose();
  }
});

function track<T extends { dispose(): void }>(h: T): T {
  activeHarnesses.push(h);
  return h;
}

function makeSuspect(id: string, x: number, z: number, profile = 'hardcore_leader', hp = 100): EntityDef {
  return { id, type: 'suspect', x, z, y: 0, yaw: 0, profile, hp };
}

function makeCivilian(id: string, x: number, z: number): EntityDef {
  return { id, type: 'civilian', x, z, y: 0, yaw: 0, profile: 'frightened_civilian' };
}

describe('Tier 1 — SWAT-Mode ↔ Suspect-Mode Parity Feature Coverage (F1–F14)', () => {
  // =========================================================================
  // Area 1 (F1): Shared SWAT Officer Profile, Condition & Uniform Parity
  // =========================================================================
  describe('Area 1 (F1): Shared SWAT Profile, Condition & Uniform', () => {
    it('F1.1: SwatProfile.ts SSOT module exists and exports immutable Rifleman & Shield profiles matching SwatTeam', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod, 'M1 src/ai/SwatProfile.ts is required').toBeDefined();
      expect(mod!.BASE_SWAT_COMBAT).toBeDefined();
      expect(mod!.BASE_SHIELD_COMBAT).toBeDefined();
      expect(mod!.BASE_SWAT_MOBILITY).toBeDefined();
      expect(mod!.BASE_SHIELD_MOBILITY).toBeDefined();

      expect(mod!.BASE_SWAT_COMBAT!.fireInterval).toBeCloseTo(0.2, 2);
      expect(mod!.BASE_SWAT_COMBAT!.shotDamage).toBe(13);
      expect(mod!.BASE_SWAT_COMBAT!.magazineSize).toBe(30);
      expect(mod!.BASE_SWAT_COMBAT!.reloadSec).toBeCloseTo(2.2, 2);
      expect(mod!.BASE_SWAT_COMBAT!.engageRange).toBe(18);
      expect(mod!.BASE_SWAT_COMBAT!.gunshotNoiseRadius).toBe(40);
      expect(mod!.BASE_SWAT_COMBAT!.flinchSec).toBeCloseTo(0.35, 2);

      expect(mod!.BASE_SHIELD_COMBAT!.fireInterval).toBeCloseTo(0.32, 2);
      expect(mod!.BASE_SHIELD_COMBAT!.shotDamage).toBe(9);
      expect(mod!.BASE_SHIELD_COMBAT!.magazineSize).toBe(15);
      expect(mod!.BASE_SHIELD_COMBAT!.coverSearchRange).toBe(0);
      expect(mod!.BASE_SHIELD_COMBAT!.flinchSec).toBeCloseTo(0.06, 2);
    });

    it('F1.2: SwatProfile constants match canonical SWAT_HP=100, uniform=0x2b3440, readyPose=high', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod, 'M1 src/ai/SwatProfile.ts is required').toBeDefined();
      expect(mod!.SWAT_HP).toBe(100);
      expect(mod!.SWAT_UNIFORM_COLOR).toBe(0x2b3440);
      expect(mod!.SWAT_READY_POSE).toBe('high');
      expect(mod!.SWAT_RADIO_STAGGER_SEC).toBeCloseTo(1.25, 2);
      expect(mod!.SWAT_C2_BLAST_RADIUS).toBeCloseTo(4.5, 2);
      expect(mod!.SWAT_C2_BLAST_HALF_ANGLE_DEG).toBe(70);
      expect(mod!.SWAT_C2_MAX_DAMAGE).toBe(45);
    });

    it('F1.3: isShieldRole assigns shield only to index 0 when squad has >= 2 officers', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod?.isShieldRole, 'M1 SwatProfile.isShieldRole is required').toBeTypeOf('function');
      expect(mod!.isShieldRole!(0, 4)).toBe(true);
      expect(mod!.isShieldRole!(1, 4)).toBe(false);
      expect(mod!.isShieldRole!(0, 2)).toBe(true);
      expect(mod!.isShieldRole!(0, 1)).toBe(false);
    });

    it('F1.4: Friendly SquadSystem officers wear dark navy SWAT uniform 0x2b3440 (matching SwatTeam, not old 0x8ea878)', () => {
      const pair: ParityPair = track(createParityPair({ map: makeSingleRoomMap(), officerCount: 4 }));
      expect(hasClothColor(pair.swatHarness.team.root, 0x2b3440)).toBe(true);
      expect(hasClothColor(pair.squadHarness.squad.root, 0x2b3440)).toBe(true);
      expect(hasClothColor(pair.squadHarness.squad.root, 0x8ea878)).toBe(false);
    });

    it('F1.5: All friendly SWAT squad officers spawn with HP 100 and identical condition to Suspect-mode SWAT', () => {
      const pair = track(createParityPair({ map: makeSingleRoomMap(), officerCount: 4 }));
      const roster = pair.squadHarness.squad.getRoster();
      expect(roster).toHaveLength(4);
      for (const entry of roster) {
        expect(entry.hp).toBe(100);
        expect(entry.maxHp).toBe(100);
        expect(entry.down).toBe(false);
      }
      expect(pair.swatHarness.team.aliveCount).toBe(4);
    });

    it('F1.6: SwatProfile cloneCombatProfile / cloneMobilityProfile return isolated mutable copies', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod?.cloneCombatProfile, 'M1 cloneCombatProfile required').toBeTypeOf('function');
      expect(mod?.cloneMobilityProfile, 'M1 cloneMobilityProfile required').toBeTypeOf('function');
      const copy = mod!.cloneCombatProfile!(mod!.BASE_SWAT_COMBAT!);
      copy.fireInterval = 9.99;
      expect(mod!.BASE_SWAT_COMBAT!.fireInterval).toBeCloseTo(0.2, 2);
      expect(SWAT_COMBAT.magazineSize).toBe(30);
      expect(SHIELD_COMBAT.magazineSize).toBe(15);
    });
  });

  // =========================================================================
  // Area 2 (F2, F3, F6): Instant Fire, Real Ballistics, Flinch & Flash Stun
  // =========================================================================
  describe('Area 2 (F2, F3, F6): Instant Fire, Ballistics, Reload & Flash Stun', () => {
    it('F2.1: Friendly SWAT officer opens fire promptly on hostile contact with 40m gunshot noise radius', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5)],
          playerPos: { x: 0, y: 0, z: 8 },
        }),
      );
      // Suspect fires first so suspect is confirmed hostile (provoked)
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(0.6, 0.05);
      const allyShots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(allyShots.length).toBeGreaterThanOrEqual(1);

      const gunshotNoises = h.recorder
        .of('noise')
        .filter((e) => e.payload.kind === 'gunshot' && e.payload.source === 'ally');
      expect(gunshotNoises.length).toBeGreaterThanOrEqual(1);
      expect(gunshotNoises[0]!.payload.radius).toBe(40);
    });

    it('F2.2: Friendly SWAT shots use real ballistic raycasts emitting bulletImpact on wall hits', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [
        { id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.8, yaw: 0 },
        { id: 'ally_2', name: 'Vance', x: 1.0, y: 0, z: 2.8, yaw: 0 },
      ];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -3.4, 'hardcore_leader', 400)],
          playerPos: { x: 0, y: 0, z: 8 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -3.4 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(3.0, 0.05);
      const impacts = h.recorder.of('bulletImpact');
      expect(impacts.length).toBeGreaterThan(0);
    });

    it('F2.3: Friendly SWAT rifleman fires at ~0.20s cadence with 13 damage per hit (matching SWAT_COMBAT)', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      // Single officer is rifleman (isShieldRole(0, 1) === false)
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 500)],
          playerPos: { x: 0, y: 0, z: 8 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(1.2, 0.05);
      const hits = h.recorder
        .of('entityHit')
        .filter((e) => e.payload.shooter === 'ally_1' && e.payload.targetId === 's1' && !e.payload.nonlethal);
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits[0]!.payload.damage).toBe(13);
    });

    it('F2.4: Friendly SWAT officers engage hostile suspects up to 18m range (engageRange parity)', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      // Open yard south of house: place officer at z=6 and hostile suspect at z=23 (17m apart, > old 16m, <= 18m)
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: -2, y: 0, z: 6, yaw: 180 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', -2, 23, 'hardcore_leader', 100)],
          playerPos: { x: 2, y: 0, z: 6 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: -2, y: 1.5, z: 23 },
        dir: { x: 0, y: 0, z: -1 },
      });

      h.step(1.5, 0.05);
      const allyShots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(allyShots.length).toBeGreaterThanOrEqual(1);
    });

    it('F3.1: Friendly SWAT officer flinch does not permanently lock out firing and clears flash state cleanly', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 300)],
          playerPos: { x: 0, y: 0, z: 8 },
        }),
      );
      // Hit ally once (non-lethal) to trigger flinch
      emitContractEvent(h.bus, 'entityHit', {
        targetId: 'ally_1',
        damage: 15,
        pos: { x: 0, y: 1.2, z: 2.0 },
        shooter: 's1',
      });
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(1.5, 0.05);
      const shots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(shots.length).toBeGreaterThanOrEqual(2);
    });

    it('F6.1: Enemy/player flashDetonated blinds friendly SWAT officer temporarily and then clears after blindSec', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 300)],
          playerPos: { x: 2.2, y: 0, z: 3.2 },
        }),
      );
      h.issueOrder('hold', { element: 'gold' });
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });
      // Detonate a non-friendly flash right in front of ally_1
      emitContractEvent(h.bus, 'flashDetonated', {
        pos: { x: 0, y: 1.0, z: 0.5 },
        radius: 9,
        blindSec: 1.5,
        thrower: 's1',
      });

      h.step(0.6, 0.05);
      const shotsWhileBlind = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(shotsWhileBlind.length).toBe(0);

      // After blindSec elapses, officer recovers and engages
      h.step(2.0, 0.05);
      const shotsAfterRecovery = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(shotsAfterRecovery.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Area 3 (F11): Shield Pointman & Pepperball Fallback
  // =========================================================================
  describe('Area 3 (F11): Shield Pointman & Pepperball Fallback', () => {
    it('F11.1: First officer in >=2 officer squad carries a ballistic shield blocking frontal chest shots', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies = defaultAllies(2, { x: 0, y: 0, z: 2.0 });
      const h = track(createSquadHarness({ map, allies, playerPos: { x: 0, y: 0, z: 8 } }));
      const living = h.squad.getLivingAllies();
      expect(living).toHaveLength(2);

      const shieldAlly = living[0]!;
      const rifleAlly = living[1]!;
      const chest = shieldAlly.getChest();
      // Front of yaw=0 is -Z direction
      const frontOrigin: Vec3 = { x: chest.x, y: chest.y, z: chest.z - 4 };
      expect(shieldAlly.shieldBlocks(frontOrigin, chest)).toBe(true);

      const rifleChest = rifleAlly.getChest();
      const rifleFront: Vec3 = { x: rifleChest.x, y: rifleChest.y, z: rifleChest.z - 4 };
      expect(rifleAlly.shieldBlocks(rifleFront, rifleChest)).toBe(false);
    });

    it('F11.2: Shield pointman fires pistol rounds (9 dmg) matching BASE_SHIELD_COMBAT', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [
        { id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.0, yaw: 0 },
        // Place second ally behind exterior wall so only shield pointman has LOS
        { id: 'ally_2', name: 'Vance', x: 0, y: 0, z: 8.5, yaw: 0 },
      ];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 300)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(1.5, 0.05);
      const shieldHits = h.recorder
        .of('entityHit')
        .filter((e) => e.payload.shooter === 'ally_1' && e.payload.targetId === 's1' && !e.payload.nonlethal);
      expect(shieldHits.length).toBeGreaterThanOrEqual(1);
      expect(shieldHits[0]!.payload.damage).toBe(9);
    });

    it('F11.3: SwatProfile defines pepperball constants (interval 0.42s, range 20m)', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod, 'M1 src/ai/SwatProfile.ts is required').toBeDefined();
      expect(mod!.SWAT_PEPPER_INTERVAL).toBeCloseTo(0.42, 2);
      expect(mod!.SWAT_PEPPER_RANGE).toBe(20);
    });

    it('F11.4: Friendly SWAT switches to nonlethal pepperball when a civilian blocks lethal LOS to hostile suspect', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [
            makeSuspect('s1', 0, -2.5, 'hardcore_leader', 100),
            // Civilian standing directly between ally_1 and s1
            makeCivilian('c1', 0, 0.0),
          ],
          playerPos: { x: 2.2, y: 0, z: 3.2 },
        }),
      );
      h.issueOrder('hold', { element: 'gold' });
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(2.0, 0.05);
      const civLethalHits = h.recorder
        .of('entityHit')
        .filter((e) => e.payload.targetId === 'c1' && !e.payload.nonlethal);
      expect(civLethalHits).toHaveLength(0);

      const pepperHits = h.recorder
        .of('entityHit')
        .filter((e) => e.payload.shooter === 'ally_1' && e.payload.targetId === 's1' && e.payload.nonlethal === true);
      expect(pepperHits.length).toBeGreaterThanOrEqual(1);
    });

    it('F11.5: Friendly SWAT uses nonlethal pepperball on organic HOSTAGE_SHIELD suspect without harming civilian', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: -1.0, y: 0, z: 0.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          // Corner nervous_robber against NW walls (x=-4, z=-4) with civilian directly in front on LOS
          entities: [
            makeSuspect('s1', -3.2, -3.2, 'nervous_robber', 100),
            makeCivilian('c1', -2.7, -2.7),
          ],
          playerPos: { x: 2.2, y: 0, z: 3.2 },
        }),
      );
      h.issueOrder('hold', { element: 'gold' });
      const s1 = h.entities.suspects.get('s1')!;
      // Lower morale into [surrenderBelow=25, shield.moraleBelow=45) and provoke engagement organically
      s1.adjustMorale(-20);
      s1.takeHit(5, { x: -1.0, y: 1.4, z: 0.5 });

      // Step briefly so checkShieldEntry organically transitions cornered suspect into HOSTAGE_SHIELD
      h.step(0.15, 0.05);
      expect(s1.state).toBe(SuspectState.HOSTAGE_SHIELD);

      h.step(2.5, 0.05);
      const civ = h.entities.civilians.get('c1')!;
      expect(civ.alive).toBe(true);
      const nonlethalHits = h.recorder
        .of('entityHit')
        .filter((e) => e.payload.shooter === 'ally_1' && e.payload.nonlethal === true);
      expect(nonlethalHits.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Area 4 (F7): Real Flashbang.throwFrom() & Indirect Flash Throw Planning
  // =========================================================================
  describe('Area 4 (F7): Real Flashbang & Indirect Throw Planning', () => {
    it('F7.1: SwatTactics.ts exports computeBallisticVelocity and all indirect flash throw planners', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod, 'M1 src/ai/SwatTactics.ts is required').toBeDefined();
      expect(mod!.computeBallisticVelocity).toBeTypeOf('function');
      expect(mod!.planDoorwayFlashThrow).toBeTypeOf('function');
      expect(mod!.planWindowFlashThrow).toBeTypeOf('function');
      expect(mod!.planWallBankFlashThrow).toBeTypeOf('function');
      expect(mod!.planFlashThrow).toBeTypeOf('function');
    });

    it('F7.2: computeBallisticVelocity lands projectile at target under gravity', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod?.computeBallisticVelocity, 'M1 computeBallisticVelocity required').toBeTypeOf('function');
      const origin: Vec3 = { x: 0, y: 1.4, z: 6 };
      const target: Vec3 = { x: 0, y: 0.2, z: 0 };
      const g = 14;
      const speed = 9;
      const distXZ = Math.hypot(target.x - origin.x, target.z - origin.z);
      const t = Math.max(0.2, Math.min(0.95, distXZ / speed));
      const v = mod!.computeBallisticVelocity!(origin, target, g, speed, 0.2, 0.95);
      const endX = origin.x + v.x * t;
      const endY = origin.y + v.y * t - 0.5 * g * t * t;
      const endZ = origin.z + v.z * t;
      expect(endX).toBeCloseTo(target.x, 3);
      expect(endY).toBeCloseTo(target.y, 3);
      expect(endZ).toBeCloseTo(target.z, 3);
    });

    it('F7.3: flashClear order uses real Flashbang physics (emits flashDetonated from real projectile)', () => {
      const map = makeSingleRoomMap({ lockedDoor: false, includeCover: false });
      const allies = defaultAllies(2, { x: 0, y: 0, z: 5.5 });
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.0, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 7.5 },
        }),
      );
      const door = h.doors.findById('door_south')!;
      const issued = h.issueOrder('flashClear', { element: 'gold', door });
      expect(issued).toBe(true);

      h.step(8.0, 0.05);
      const flashes = h.recorder.of('flashDetonated');
      expect(flashes.length).toBeGreaterThanOrEqual(1);
      // Real Flashbang.throwFrom produces a valid thrower id (ally_*) and detonates inside the room (z < 4)
      expect(typeof flashes[0]!.payload.thrower).toBe('string');
      expect(flashes[0]!.payload.thrower).toMatch(/^ally_/);
      expect(flashes[0]!.payload.pos.z).toBeLessThan(4.0);
    });

    it('F7.4: planWindowFlashThrow plans a valid trajectory through an exterior window', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod?.planWindowFlashThrow, 'M1 planWindowFlashThrow required').toBeTypeOf('function');
      const map = makeWindowedSiegeMap(false);
      const h = track(createSquadHarness({ map, allies: defaultAllies(2, { x: 6, y: 0, z: 0 }) }));
      const plan = mod!.planWindowFlashThrow!(
        { x: 6.2, y: 1.5, z: 0 },
        { x: 0, y: 0.5, z: 0 },
        map.windows,
        h.colliders,
        14,
      );
      expect(plan).not.toBeNull();
    });

    it('F7.5: Friendly SWAT never throws a flashbang or CS gas on its own (only on player orders), even against a barricaded/engaged hostile', () => {
      const map = makeSingleRoomMap({ lockedDoor: false, includeCover: true });
      const allies: AllyDef[] = [
        { id: 'ally_1', name: 'Miller', x: -0.6, y: 0, z: 5.0, yaw: 0 },
        { id: 'ally_2', name: 'Vance', x: 0.6, y: 0, z: 5.0, yaw: 0 },
      ];
      const h = track(
        createSquadHarness({
          map,
          allies,
          // s1 is occluded behind the full-height south wall (x in [-4, -0.6], z = 4) and <= 6m from officers
          entities: [makeSuspect('s1', -2.0, 0.5, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 5.0 },
        }),
      );
      // Open unlocked door cleanly and provoke suspect
      const door = h.doors.findById('door_south')!;
      door.toggle(true, 0, 6);
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: -2.0, y: 1.5, z: 0.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      // 膠着が続いても（旧仕様ではここで自律投擲していた）プレイヤーの指示なしでは投げない
      h.step(30.0, 0.05);
      expect(h.recorder.of('flashDetonated').length).toBe(0);
      expect(h.recorder.count('gasDetonated')).toBe(0);
    });
  });

  // =========================================================================
  // Area 5 (F8): C2 Explosive Breaching
  // =========================================================================
  describe('Area 5 (F8): C2 Explosive Breaching', () => {
    it('F8.1: SwatTactics exports computeC2Standoff, evaluateC2BlastCone, shouldUseC2Breach', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod, 'M1 src/ai/SwatTactics.ts is required').toBeDefined();
      expect(mod!.computeC2Standoff).toBeTypeOf('function');
      expect(mod!.evaluateC2BlastCone).toBeTypeOf('function');
      expect(mod!.shouldUseC2Breach).toBeTypeOf('function');
    });

    it('F8.2: evaluateC2BlastCone applies up to 45 damage inside 4.5m / ±70° cone', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod?.evaluateC2BlastCone, 'M1 evaluateC2BlastCone required').toBeTypeOf('function');
      const doorPos: Vec3 = { x: 0, y: 1.0, z: 4 };
      const blastDir: Vec3 = { x: 0, y: 0, z: -1 };
      const coneCos = Math.cos((70 * Math.PI) / 180);
      const closeRes = mod!.evaluateC2BlastCone!(doorPos, blastDir, { x: 0, y: 1.0, z: 3.0 }, 4.5, coneCos, 45);
      expect(closeRes.inCone).toBe(true);
      expect(closeRes.damage).toBeGreaterThan(20);
      expect(closeRes.damage).toBeLessThanOrEqual(45);
    });

    it('F8.3: EntityManager exposes applyC2Blast that damages hostile suspect in blast cone', () => {
      const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
      const h = track(
        createSquadHarness({
          map,
          allies: defaultAllies(2, { x: 0, y: 0, z: 7 }),
          entities: [makeSuspect('s1', 0, 2.2, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      expect(h.entities.applyC2Blast, 'M2 EntityManager.applyC2Blast is required').toBeTypeOf('function');
      const s1 = h.entities.suspects.get('s1')!;
      const beforeHp = s1.hp;

      h.entities.applyC2Blast!({ x: 0, y: 1.0, z: 4 }, { x: 0, y: 0, z: -1 }, 4.5, 70, 45, 'ally_1');
      expect(s1.hp).toBeLessThan(beforeHp);
    });

    it('F8.4: c2Clear order is available on a locked door and triggers c2Beep + c2Detonated + explosive breach', () => {
      const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
      const allies = defaultAllies(2, { x: 0, y: 0, z: 6.0 });
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, 1.8, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 8.5 },
        }),
      );
      const door = h.doors.findById('door_south')!;
      expect(door.locked).toBe(true);

      const issued = h.issueOrder('c2Clear', { element: 'gold', door });
      expect(issued, 'M2/M3 c2Clear order must be selectable on door').toBe(true);

      h.step(10.0, 0.05);
      expect(h.recorder.count('c2Beep')).toBeGreaterThanOrEqual(1);
      expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
      expect(door.locked).toBe(false);
    });

    it('F8.5: C2 detonation routes playC2Beep and playC2Blast through AudioBridge', () => {
      const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
      const allies = defaultAllies(2, { x: 0, y: 0, z: 6.0 });
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, 1.8, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 8.5 },
        }),
      );
      const door = h.doors.findById('door_south')!;
      expect(h.issueOrder('c2Clear', { element: 'gold', door })).toBe(true);

      h.step(10.0, 0.05);
      expect(h.audioSink.of('playC2Beep').length).toBeGreaterThanOrEqual(1);
      expect(h.audioSink.of('playC2Blast').length).toBeGreaterThanOrEqual(1);
    });

    it('F8.6: C2 detonation stuns and damages hostile suspect behind breached door', () => {
      const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
      const allies = defaultAllies(2, { x: 0, y: 0, z: 6.0 });
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, 2.0, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 8.5 },
        }),
      );
      const door = h.doors.findById('door_south')!;
      expect(h.issueOrder('c2Clear', { element: 'gold', door })).toBe(true);

      h.step(10.0, 0.05);
      const s1 = h.entities.suspects.get('s1')!;
      expect(s1.hp).toBeLessThan(100);
    });
  });

  // =========================================================================
  // Area 6 (F9): CS Tear Gas Flush-Out in SWAT Mode
  // =========================================================================
  describe('Area 6 (F9): CS Tear Gas Flush-Out & Gas-Mask Immunity', () => {
    it('F9.1: EntityManager exposes setTearGas hook for SWAT-mode CS gas sampling', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(createSquadHarness({ map, entities: [makeSuspect('s1', 0, 0)] }));
      expect(h.entities.setTearGas, 'M2 EntityManager.setTearGas is required').toBeTypeOf('function');
    });

    it('F9.2: gasClear order is selectable on door and deploys real CS tear gas emitting gasDetonated', () => {
      const map = makeSingleRoomMap({ lockedDoor: false, includeCover: false });
      const allies = defaultAllies(2, { x: 0, y: 0, z: 5.8 });
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -1.5, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 8.0 },
        }),
      );
      const door = h.doors.findById('door_south')!;
      const issued = h.issueOrder('gasClear', { element: 'gold', door });
      expect(issued, 'M2/M3 gasClear order must be selectable on door').toBe(true);

      h.step(9.0, 0.05);
      expect(h.recorder.count('gasDetonated')).toBeGreaterThanOrEqual(1);
      expect(h.tearGas.activeCloudCount).toBeGreaterThanOrEqual(1);
      expect(h.audioSink.of('playGasHiss').length).toBeGreaterThanOrEqual(1);
    });

    it('F9.3: Suspect exposed to CS tear gas cloud loses morale and moves/flushes without lethal damage', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(
        createSquadHarness({
          map,
          allies: defaultAllies(2, { x: 0, y: 0, z: 9 }),
          entities: [makeSuspect('s1', 0, 0, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 10 },
        }),
      );
      expect(h.entities.setTearGas, 'M2 EntityManager.setTearGas is required').toBeTypeOf('function');
      const s1 = h.entities.suspects.get('s1')!;
      const startMorale = s1.morale.value;
      const startX = s1.body.px;
      const startZ = s1.body.pz;

      // Detonate gas right at suspect's position
      h.tearGas.throwFrom({ x: 0, y: 0.8, z: 0.5 }, { x: 0, y: 0.5, z: -0.5 }, 'ally_1', 0.2);
      h.step(5.0, 0.05);

      expect(s1.hp).toBe(100);
      expect(s1.morale.value).toBeLessThan(startMorale);
      const movedDist = Math.hypot(s1.body.px - startX, s1.body.pz - startZ);
      expect(movedDist).toBeGreaterThan(0.3);
    });

    it('F9.4: Friendly SWAT officers are immune to CS tear gas (gas masks: full HP, no cough/slow)', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      h.tearGas.throwFrom({ x: 0, y: 0.8, z: 0 }, { x: 0, y: 0, z: 0 }, 'ally_1', 0.1);
      h.step(4.0, 0.05);

      expect(h.tearGas.activeCloudCount).toBeGreaterThanOrEqual(1);
      const roster = h.squad.getRoster();
      expect(roster[0]!.hp).toBe(100);
      expect(roster[0]!.down).toBe(false);
    });

    it('F9.5: CS tear gas cloud has canonical radius 4.2m and zero dynamic lights', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(createSquadHarness({ map, allies: defaultAllies(2, { x: 0, y: 0, z: 8 }) }));
      h.tearGas.throwFrom({ x: 0, y: 0.8, z: 0 }, { x: 0, y: 0, z: 0 }, 'ally_1', 0.1);
      h.step(1.0, 0.05);

      const evs = h.recorder.of('gasDetonated');
      expect(evs).toHaveLength(1);
      expect(evs[0]!.payload.radius).toBeCloseTo(GAS_CLOUD_RADIUS, 2);
      expect(countDynamicLights(h.tearGas.root)).toBe(0);
    });
  });

  // =========================================================================
  // Area 7 (F4, F5, F10): Weakness Rush, Suppression & Pincer Flanking
  // =========================================================================
  describe('Area 7 (F4, F5, F10): Weakness Rush, Suppressive Fire & Pincer Flanking', () => {
    it('F4.1: SwatProfile defines weakness-triggered rush constants (14m, 5.5s, 2.7-2.9 m/s, 2.35 shield)', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod, 'M1 src/ai/SwatProfile.ts is required').toBeDefined();
      expect(mod!.SWAT_RUSH_RADIUS).toBe(14);
      expect(mod!.SWAT_RUSH_DURATION_SEC).toBeCloseTo(5.5, 2);
      expect(mod!.SWAT_RUSH_TEAM_COOLDOWN).toBeCloseTo(6.0, 2);
      expect(mod!.SWAT_RUSH_SPEED_MIN).toBeCloseTo(2.7, 2);
      expect(mod!.SWAT_SHIELD_RUSH_SPEED).toBeCloseTo(2.35, 2);
    });

    it('F4.2: Friendly SWAT rushes weakened (low-HP <= 40) hostile suspect and closes distance', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 3.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          // Low-HP hostile suspect inside rush radius (6m away)
          entities: [makeSuspect('s1', 0, -3.0, 'hardcore_leader', 40)],
          // Keep player inside room behind officer so follow mode does not pull officer backward south
          playerPos: { x: 0, y: 0, z: 3.5 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -3.0 },
        dir: { x: 0, y: 0, z: 1 },
      });

      const startZ = h.squad.getLivingAllies()[0]!.pz;
      let minZ = startZ;
      for (let i = 0; i < 20; i++) {
        h.step(0.1, 0.05);
        const cur = h.squad.getLivingAllies()[0];
        if (cur) minZ = Math.min(minZ, cur.pz);
      }
      expect(minZ).toBeLessThan(startZ - 1.0);
    });

    it('F5.1: SwatProfile defines suppressive fire window (0.35s–3.5s, 0.5s interval)', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod, 'M1 src/ai/SwatProfile.ts is required').toBeDefined();
      expect(mod!.SWAT_SUPPRESS_START_SEC).toBeCloseTo(0.35, 2);
      expect(mod!.SWAT_SUPPRESS_END_SEC).toBeCloseTo(3.5, 2);
      expect(mod!.SWAT_SUPPRESS_INTERVAL).toBeCloseTo(0.5, 2);
    });

    it('F5.2: Friendly SWAT fires suppressive bursts at last known hostile position after LOS is broken', () => {
      const map = makeSingleRoomMap({ includeCover: true });
      // Add full-height interior partition wall so retreating behind it genuinely breaks eye-level LOS
      map.walls.push({ x: -1.8, z: -0.5, width: 2.4, depth: 0.3, height: 3.0 });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 1.5, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0.5, -1.5, 'hardcore_leader', 250)],
          playerPos: { x: 1.5, y: 0, z: 3.0 },
        }),
      );
      h.issueOrder('hold', { element: 'gold' });
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0.5, y: 1.5, z: -1.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      // Establish contact
      h.step(0.6, 0.05);
      // Break eye-level LOS by moving suspect behind the full-height interior wall
      const s1 = h.entities.suspects.get('s1')!;
      s1.body.setPosition(-2.5, -2.2);
      const allyChest = h.squad.getLivingAllies()[0]!.getChest();
      const suspectEye = { x: s1.body.px, y: 1.5, z: s1.body.pz };
      expect(hasLineOfSight(h.colliders, { x: allyChest.x, y: 1.5, z: allyChest.z }, suspectEye)).toBe(false);
      h.recorder.clear();

      // Within 0.35–3.5s lost-LOS window, officer should fire suppressive rounds
      h.step(2.0, 0.05);
      const suppressShots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(suppressShots.length).toBeGreaterThanOrEqual(1);
    });

    it('F10.1: SwatTactics exports multi-door and pincer planners (selectPinningCell, planPincerFlankGoal, assignCellPortals)', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod, 'M1 src/ai/SwatTactics.ts is required').toBeDefined();
      expect(mod!.findRoomDoors).toBeTypeOf('function');
      expect(mod!.selectPinningCell).toBeTypeOf('function');
      expect(mod!.planPincerFlankGoal).toBeTypeOf('function');
      expect(mod!.assignCellPortals).toBeTypeOf('function');
      expect(mod!.filterReachableExteriorEntries).toBeTypeOf('function');
    });

    it('F10.2: ALPHA and BRAVO elements can be assigned independent doors on a two-door house', () => {
      const map = makeTwoDoorHouseMap({ southLocked: false, northLocked: false });
      const allies: AllyDef[] = [
        { id: 'ally_1', name: 'Miller', x: -0.6, y: 0, z: 6.5, yaw: 0 },
        { id: 'ally_2', name: 'Vance', x: 0.6, y: 0, z: 6.5, yaw: 0 },
        { id: 'ally_3', name: 'Cole', x: -0.6, y: 0, z: -6.5, yaw: 180 },
        { id: 'ally_4', name: 'Reeves', x: 0.6, y: 0, z: -6.5, yaw: 180 },
      ];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, 0, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      const southDoor = h.doors.findById('door_south')!;
      const northDoor = h.doors.findById('door_north')!;

      expect(h.issueOrder('clear', { element: 'alpha', door: southDoor })).toBe(true);
      // Position player on north exterior side so approachSign assigns BRAVO the reachable north exterior
      h.player.moveTo(0, 0, -8);
      expect(h.issueOrder('clear', { element: 'bravo', door: northDoor })).toBe(true);
      h.player.moveTo(0, 0, 9);

      h.step(5.0, 0.05);
      // Both doors should be opened/breached by their respective elements
      expect(southDoor.stage).not.toBe('closed');
      expect(northDoor.stage).not.toBe('closed');
    });
  });

  // =========================================================================
  // Area 8 (F12, F13, F14): Optics, Footsteps, Radio Queue, Schema & ROE
  // =========================================================================
  describe('Area 8 (F12, F13, F14): TacticalOptics, Footsteps, Radio, Schema & ROE', () => {
    it('F12.1: TacticalOptics.ts module exists and renders laser/dot/cone with zero dynamic lights', async () => {
      const mod = await loadTacticalOpticsModule();
      expect(mod?.TacticalOptics, 'M1 src/ai/TacticalOptics.ts is required').toBeDefined();
      const scene = new THREE.Scene();
      const optics = new mod!.TacticalOptics!(scene);
      optics.update({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: -1 }, [], true);

      const container = optics.group ?? scene;
      expect(countDynamicLights(container)).toBe(0);
      optics.dispose(scene);
    });

    it('F12.2: Every friendly SWAT officer in SquadSystem has a TacticalOptics rig with zero dynamic lights', () => {
      const map = makeSingleRoomMap();
      const h = track(createSquadHarness({ map, allies: defaultAllies(4, { x: 0, y: 0, z: 7 }) }));
      h.step(0.3, 0.05);

      const opticsGroups = findOpticsGroups(h.squad.root);
      expect(opticsGroups.length).toBe(4);
      expect(countDynamicLights(h.squad.root)).toBe(0);
    });

    it('F13.1: Moving friendly SWAT officers emit swatFootstep events routed to AudioBridge', () => {
      const map = makeSingleRoomMap();
      const h = track(
        createSquadHarness({
          map,
          allies: defaultAllies(2, { x: 0, y: 0, z: 8 }),
          playerPos: { x: 0, y: 0, z: 5 },
        }),
      );
      // Issue move order forward so officers stride
      h.issueOrder('move', { element: 'gold', targetPos: { x: 0, y: 0, z: 5.5 } });
      h.step(3.0, 0.05);

      const steps = h.recorder.of('swatFootstep');
      expect(steps.length).toBeGreaterThanOrEqual(1);
      expect(h.audioSink.of('playSwatFootstep').length).toBeGreaterThanOrEqual(1);
    });

    it('F13.2: Rapid multi-officer tactical callouts are staggered by ~1.25s (SWAT_RADIO_STAGGER_SEC)', () => {
      const map = makeSingleRoomMap({ lockedDoor: false, includeCover: false });
      const allies = defaultAllies(4, { x: 0, y: 0, z: 6.0 });
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.0, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 8.5 },
        }),
      );
      const door = h.doors.findById('door_south')!;
      h.issueOrder('stack', { element: 'alpha', door });
      h.issueOrder('clear', { element: 'gold', door });
      h.step(6.0, 0.05);

      const radios = h.recorder.of('allyRadio');
      expect(radios.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < radios.length; i++) {
        const gap = radios[i]!.time - radios[i - 1]!.time;
        expect(gap).toBeGreaterThanOrEqual(1.1);
      }
    });

    it('F14.1: public/data/squad.json includes c2Clear and gasClear orderLabels and aligned engageRange=18', () => {
      const raw = loadRawSquadJson();
      const labels = raw.orderLabels as Record<string, unknown>;
      expect(typeof labels.c2Clear, 'M2 squad.json orderLabels.c2Clear required').toBe('string');
      expect(typeof labels.gasClear, 'M2 squad.json orderLabels.gasClear required').toBe('string');
      const cfg = loadSquadConfig();
      expect(cfg.engageRange).toBe(18);
    });

    it('F14.2: Friendly SWAT preserves ROE by warning unwarned non-hostile suspect instead of shooting', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          // Nervous suspect starts BARRICADED and unwarned
          entities: [makeSuspect('s1', 0, -1.5, 'nervous_robber', 100)],
          playerPos: { x: 0, y: 0, z: 8.5 },
        }),
      );
      const s1 = h.entities.suspects.get('s1')!;
      const startMorale = s1.morale.value;
      h.step(1.0, 0.05);

      expect(s1.warned).toBe(true);
      expect(s1.morale.value).toBeLessThan(startMorale);
      const lethalHits = h.recorder
        .of('entityHit')
        .filter((e) => e.payload.targetId === 's1' && !e.payload.nonlethal);
      expect(lethalHits).toHaveLength(0);
      expect(h.recorder.count('roeViolation')).toBe(0);
    });
  });
});
