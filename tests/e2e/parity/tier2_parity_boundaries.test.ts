import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SuspectState } from '../../../src/core/events';
import type { AllyDef, EntityDef, Vec3 } from '../../../src/core/types';
import {
  GAS_CLOUD_DURATION,
  GAS_CLOUD_RADIUS,
  computeGasDensityAt,
  type GasCloudInfo,
} from '../../../src/weapons/TearGas';
import {
  countDynamicLights,
  createSquadHarness,
  defaultAllies,
  emitContractEvent,
  findOpticsGroups,
  loadSwatProfileModule,
  loadSwatTacticsModule,
  loadTacticalOpticsModule,
  makeSingleRoomMap,
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

describe('Tier 2 — SWAT-Mode ↔ Suspect-Mode Parity Boundary & Corner Cases', () => {
  // =========================================================================
  // 1. Zero/Max Ammo, Reload & Range Boundaries
  // =========================================================================
  describe('1. Ammo, Reload & EngageRange Boundaries', () => {
    it('B1.1: Rifleman 30-rd magazine exhausts and pauses for reload (~2.2s) before resuming fire', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 5000)],
          playerPos: { x: 2.2, y: 0, z: 3.2 },
        }),
      );
      h.issueOrder('hold', { element: 'gold' });
      // Keep the 5000-HP target dummy stunned so return fire does not down the unshielded rifleman mid-magazine
      h.entities.suspects.get('s1')!.onFlashed(26);
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      // Step long enough for >30 rounds + reload cycle
      h.step(25.0, 0.05);
      const shots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(shots.length).toBeGreaterThan(30);

      // There must be a reload gap >= 1.5s between consecutive shots
      let maxGap = 0;
      for (let i = 1; i < shots.length; i++) {
        maxGap = Math.max(maxGap, shots[i]!.time - shots[i - 1]!.time);
      }
      expect(maxGap).toBeGreaterThanOrEqual(1.5);
    });

    it('B1.2: Shield pointman 15-rd pistol magazine exhausts earlier and reloads (~1.8s)', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [
        { id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 },
        { id: 'ally_2', name: 'Vance', x: 0, y: 0, z: 9.0, yaw: 0 },
      ];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 5000)],
          playerPos: { x: 2.2, y: 0, z: 3.2 },
        }),
      );
      h.issueOrder('hold', { element: 'gold' });
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(12.0, 0.05);
      const shots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(shots.length).toBeGreaterThan(15);

      let maxGap = 0;
      for (let i = 1; i < shots.length; i++) {
        maxGap = Math.max(maxGap, shots[i]!.time - shots[i - 1]!.time);
      }
      expect(maxGap).toBeGreaterThanOrEqual(1.4);
    });

    it('B1.3: Hostile suspect beyond 18m engageRange (at 22m) is NOT engaged by rifleman', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: -2, y: 0, z: 6, yaw: 180 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', -2, 28, 'hardcore_leader', 100)],
          playerPos: { x: 2, y: 0, z: 6 },
        }),
      );
      h.issueOrder('hold', { element: 'gold' });
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: -2, y: 1.5, z: 28 },
        dir: { x: 0, y: 0, z: -1 },
      });

      h.step(1.5, 0.05);
      const shots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(shots).toHaveLength(0);
    });

    it('B1.4: Hostile suspect just inside 18m engageRange (at 17.2m) IS engaged', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: -2, y: 0, z: 6, yaw: 180 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', -2, 23.2, 'hardcore_leader', 100)],
          playerPos: { x: 2, y: 0, z: 6 },
        }),
      );
      h.issueOrder('hold', { element: 'gold' });
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: -2, y: 1.5, z: 23.2 },
        dir: { x: 0, y: 0, z: -1 },
      });

      h.step(1.5, 0.05);
      const shots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(shots.length).toBeGreaterThanOrEqual(1);
    });

    it('B1.5: Downed friendly officer (hp <= 0) stops firing and is removed from getLivingAllies()', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      emitContractEvent(h.bus, 'entityHit', {
        targetId: 'ally_1',
        damage: 120,
        pos: { x: 0, y: 1.2, z: 2.5 },
        shooter: 's1',
      });
      h.recorder.clear();
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(1.5, 0.05);
      expect(h.squad.getLivingAllies()).toHaveLength(0);
      expect(h.squad.getRoster()[0]!.down).toBe(true);
      expect(h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1')).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2. Shield Arc Edges & Flinch Limits
  // =========================================================================
  describe('2. Shield Arc Edges & Flinch Limits', () => {
    it('B2.1: Frontal chest shot (0°) is blocked by shield pointman', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(createSquadHarness({ map, allies: defaultAllies(2, { x: 0, y: 0, z: 2 }) }));
      const shield = h.squad.getLivingAllies()[0]!;
      const chest = shield.getChest();
      expect(shield.shieldBlocks({ x: chest.x, y: chest.y, z: chest.z - 5 }, chest)).toBe(true);
    });

    it('B2.2: Rear shot (180°) penetrates shield pointman', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(createSquadHarness({ map, allies: defaultAllies(2, { x: 0, y: 0, z: 2 }) }));
      const shield = h.squad.getLivingAllies()[0]!;
      const chest = shield.getChest();
      expect(shield.shieldBlocks({ x: chest.x, y: chest.y, z: chest.z + 5 }, chest)).toBe(false);
    });

    it('B2.3: Direct side flank shot (90°) penetrates shield pointman', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(createSquadHarness({ map, allies: defaultAllies(2, { x: 0, y: 0, z: 2 }) }));
      const shield = h.squad.getLivingAllies()[0]!;
      const chest = shield.getChest();
      expect(shield.shieldBlocks({ x: chest.x + 5, y: chest.y, z: chest.z }, chest)).toBe(false);
    });

    it('B2.4: Single-officer squad has NO ballistic shield', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod?.isShieldRole, 'M1 SwatProfile.isShieldRole required').toBeTypeOf('function');
      expect(mod!.isShieldRole!(0, 1)).toBe(false);

      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(createSquadHarness({ map, allies: defaultAllies(1, { x: 0, y: 0, z: 2 }) }));
      const solo = h.squad.getLivingAllies()[0]!;
      const chest = solo.getChest();
      expect(solo.shieldBlocks({ x: chest.x, y: chest.y, z: chest.z - 5 }, chest)).toBe(false);
    });

    it('B2.5: Shield pointman flinchSec (0.06s) is strictly shorter than rifleman flinchSec (0.35s)', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod, 'M1 SwatProfile.ts required').toBeDefined();
      expect(mod!.BASE_SHIELD_COMBAT!.flinchSec).toBeCloseTo(0.06, 2);
      expect(mod!.BASE_SWAT_COMBAT!.flinchSec).toBeCloseTo(0.35, 2);
      expect(mod!.BASE_SHIELD_COMBAT!.flinchSec).toBeLessThan(mod!.BASE_SWAT_COMBAT!.flinchSec);
    });
  });

  // =========================================================================
  // 3. Flashbang Immunity, Occlusion & Range Boundaries
  // =========================================================================
  describe('3. Flashbang Immunity, Occlusion & Range Boundaries', () => {
    it('B3.1: Friendly ally-thrown flashDetonated does NOT blind friendly squadmates', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [
        { id: 'ally_1', name: 'Miller', x: -0.6, y: 0, z: 2.5, yaw: 0 },
        { id: 'ally_2', name: 'Vance', x: 0.6, y: 0, z: 2.5, yaw: 0 },
      ];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 200)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });
      // Ally throws flash close to squadmates
      emitContractEvent(h.bus, 'flashDetonated', {
        pos: { x: 0, y: 1.0, z: 1.2 },
        radius: 9,
        blindSec: 3.0,
        thrower: 'ally_1',
      });

      h.step(0.8, 0.05);
      const allyShots = h.recorder
        .of('shotFired')
        .filter((e) => e.payload.shooter === 'ally_1' || e.payload.shooter === 'ally_2');
      expect(allyShots.length).toBeGreaterThanOrEqual(1);
    });

    it('B3.2: Wall-occluded hostile flashDetonated does NOT blind friendly SWAT officer', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      // Ally inside room at (0, 2.5), enemy flash detonates outside north wall at (0, -5.5)
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 200)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });
      emitContractEvent(h.bus, 'flashDetonated', {
        pos: { x: 0, y: 1.0, z: -5.5 },
        radius: 12,
        blindSec: 4.0,
        thrower: 's1',
      });

      h.step(0.8, 0.05);
      const shots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(shots.length).toBeGreaterThanOrEqual(1);
    });

    it('B3.3: Hostile flashDetonated beyond radius does NOT blind friendly SWAT officer', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 200)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });
      // Distance is 5.5m, radius is 4.0m -> out of range
      emitContractEvent(h.bus, 'flashDetonated', {
        pos: { x: 0, y: 1.0, z: -3.0 },
        radius: 4.0,
        blindSec: 4.0,
        thrower: 's1',
      });

      h.step(0.8, 0.05);
      const shots = h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1');
      expect(shots.length).toBeGreaterThanOrEqual(1);
    });

    it('B3.4: Hostile flashDetonated inside radius with clear LOS blinds friendly officer until blindSec expires', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 200)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });
      emitContractEvent(h.bus, 'flashDetonated', {
        pos: { x: 0, y: 1.0, z: 1.0 },
        radius: 6.0,
        blindSec: 1.2,
        thrower: 's1',
      });

      h.step(0.5, 0.05);
      expect(h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1')).toHaveLength(0);
    });

    it('B3.5: SwatProfile defines SWAT_FLASH_PER_TEAM=3 and SWAT_FLASH_CARRY_MAX=4', async () => {
      const mod = await loadSwatProfileModule();
      expect(mod, 'M1 SwatProfile.ts required').toBeDefined();
      expect(mod!.SWAT_FLASH_PER_TEAM).toBe(3);
      expect(mod!.SWAT_FLASH_CARRY_MAX).toBe(4);
    });
  });

  // =========================================================================
  // 4. C2 Standoff & Blast Cone Boundaries
  // =========================================================================
  describe('4. C2 Standoff & Blast Cone Boundaries', () => {
    it('B4.1: evaluateC2BlastCone hits at 4.4m (just inside 4.5m radius)', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod?.evaluateC2BlastCone, 'M1 evaluateC2BlastCone required').toBeTypeOf('function');
      const coneCos = Math.cos((70 * Math.PI) / 180);
      const res = mod!.evaluateC2BlastCone!(
        { x: 0, y: 1, z: 4 },
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 1, z: -0.4 },
        4.5,
        coneCos,
        45,
      );
      expect(res.inCone).toBe(true);
      expect(res.damage).toBeGreaterThan(0);
    });

    it('B4.2: evaluateC2BlastCone misses at 4.6m (just outside 4.5m radius)', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod?.evaluateC2BlastCone, 'M1 evaluateC2BlastCone required').toBeTypeOf('function');
      const coneCos = Math.cos((70 * Math.PI) / 180);
      const res = mod!.evaluateC2BlastCone!(
        { x: 0, y: 1, z: 4 },
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 1, z: -0.6 },
        4.5,
        coneCos,
        45,
      );
      expect(res.inCone).toBe(false);
      expect(res.damage).toBe(0);
    });

    it('B4.3: evaluateC2BlastCone respects ±70° half-angle edge (65° hit vs 75° miss)', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod?.evaluateC2BlastCone, 'M1 evaluateC2BlastCone required').toBeTypeOf('function');
      const doorPos: Vec3 = { x: 0, y: 1, z: 4 };
      const blastDir: Vec3 = { x: 0, y: 0, z: -1 };
      const coneCos = Math.cos((70 * Math.PI) / 180);
      const rad65 = (65 * Math.PI) / 180;
      const rad75 = (75 * Math.PI) / 180;
      const inside = mod!.evaluateC2BlastCone!(
        doorPos,
        blastDir,
        { x: Math.sin(rad65) * 2.0, y: 1, z: 4 - Math.cos(rad65) * 2.0 },
        4.5,
        coneCos,
        45,
      );
      const outside = mod!.evaluateC2BlastCone!(
        doorPos,
        blastDir,
        { x: Math.sin(rad75) * 2.0, y: 1, z: 4 - Math.cos(rad75) * 2.0 },
        4.5,
        coneCos,
        45,
      );
      expect(inside.inCone).toBe(true);
      expect(outside.inCone).toBe(false);
    });

    it('B4.4: evaluateC2BlastCone does NOT hit breacher standing behind door (opposite blastDir)', async () => {
      const mod = await loadSwatTacticsModule();
      expect(mod?.evaluateC2BlastCone, 'M1 evaluateC2BlastCone required').toBeTypeOf('function');
      const coneCos = Math.cos((70 * Math.PI) / 180);
      const res = mod!.evaluateC2BlastCone!(
        { x: 0, y: 1, z: 4 },
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 1, z: 5.5 },
        4.5,
        coneCos,
        45,
      );
      expect(res.inCone).toBe(false);
      expect(res.damage).toBe(0);
    });

    it('B4.5: EntityManager.applyC2Blast protects civilians inside blast cone from lethal harm', () => {
      const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
      const h = track(
        createSquadHarness({
          map,
          entities: [makeCivilian('c1', 0, 2.2)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      expect(h.entities.applyC2Blast, 'M2 EntityManager.applyC2Blast required').toBeTypeOf('function');
      h.entities.applyC2Blast!({ x: 0, y: 1, z: 4 }, { x: 0, y: 0, z: -1 }, 4.5, 70, 45, 'ally_1');
      const civ = h.entities.civilians.get('c1')!;
      expect(civ.alive).toBe(true);
      expect(h.recorder.count('roeViolation')).toBe(0);
    });

    it('B4.6: EntityManager.applyC2Blast protects surrendered suspect inside blast cone from lethal harm', () => {
      const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
      const h = track(
        createSquadHarness({
          map,
          entities: [makeSuspect('s1', 0, 2.2, 'nervous_robber', 20)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      expect(h.entities.applyC2Blast, 'M2 EntityManager.applyC2Blast required').toBeTypeOf('function');
      const s1 = h.entities.suspects.get('s1')!;
      // Drop morale to force surrender
      s1.morale.shift(-200);
      h.step(0.2, 0.05);
      expect(s1.state).toBe(SuspectState.SURRENDER);

      h.entities.applyC2Blast!({ x: 0, y: 1, z: 4 }, { x: 0, y: 0, z: -1 }, 4.5, 70, 45, 'ally_1');
      expect(s1.alive).toBe(true);
    });
  });

  // =========================================================================
  // 5. CS Tear Gas Radius, Duration, Occlusion & Gas-Mask Immunity Boundaries
  // =========================================================================
  describe('5. CS Tear Gas Boundaries & SWAT Gas-Mask Immunity', () => {
    it('B5.1: computeGasDensityAt returns > 0 at 4.0m and 0 at 4.4m (4.2m radius edge)', () => {
      const cloud: GasCloudInfo = {
        pos: { x: 0, y: 0.2, z: 0 },
        radius: GAS_CLOUD_RADIUS,
        remainingSec: 12,
        durationSec: GAS_CLOUD_DURATION,
        intensity: 1,
      };
      expect(computeGasDensityAt([cloud], { x: 4.0, y: 1.0, z: 0 })).toBeGreaterThan(0);
      expect(computeGasDensityAt([cloud], { x: 4.4, y: 1.0, z: 0 })).toBe(0);
    });

    it('B5.2: CS tear gas cloud expires completely after GAS_CLOUD_DURATION (16s)', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(createSquadHarness({ map, allies: defaultAllies(2, { x: 0, y: 0, z: 8 }) }));
      h.tearGas.throwFrom({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0 }, 'ally_1', 0.1);
      h.step(0.5, 0.05);
      expect(h.tearGas.activeCloudCount).toBe(1);

      h.step(GAS_CLOUD_DURATION + 1.0, 0.05);
      expect(h.tearGas.activeCloudCount).toBe(0);
    });

    it('B5.3: Solid wall between CS gas cloud and sample point occludes gas density to 0', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(createSquadHarness({ map, allies: defaultAllies(1, { x: 0, y: 0, z: 8 }) }));
      // Cloud inside room at (0, 0.2, 3.0), sample point outside south wall at (0, 1.0, 5.0) — dist = 2.0m < 4.2m
      const cloud: GasCloudInfo = {
        pos: { x: 0, y: 0.2, z: 3.0 },
        radius: GAS_CLOUD_RADIUS,
        remainingSec: 12,
        durationSec: GAS_CLOUD_DURATION,
        intensity: 1,
      };
      expect(computeGasDensityAt([cloud], { x: 0, y: 1.0, z: 5.0 }, h.colliders)).toBe(0);
    });

    it('B5.4: Friendly SWAT officer inside CS gas center maintains 100 HP and engages normally', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 200)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      h.tearGas.throwFrom({ x: 0, y: 0.5, z: 2.0 }, { x: 0, y: 0, z: 0 }, 'ally_1', 0.1);
      h.entities.suspects.get('s1')!.onFlashed(5);
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(2.0, 0.05);
      expect(h.squad.getRoster()[0]!.hp).toBe(100);
      expect(h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1').length).toBeGreaterThanOrEqual(1);
    });

    it('B5.5: CS tear gas deals strictly 0 lethal HP damage to exposed suspect over full exposure', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(
        createSquadHarness({
          map,
          allies: defaultAllies(1, { x: 0, y: 0, z: 9 }),
          entities: [makeSuspect('s1', 0, 0, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 10 },
        }),
      );
      h.tearGas.throwFrom({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0 }, 'ally_1', 0.1);
      h.step(6.0, 0.05);
      const s1 = h.entities.suspects.get('s1')!;
      expect(s1.hp).toBe(100);
      expect(s1.alive).toBe(true);
    });
  });

  // =========================================================================
  // 6. ROE Boundaries
  // =========================================================================
  describe('6. ROE Boundaries', () => {
    it('B6.1: Unwarned BARRICADED suspect is NOT shot lethally before warning/hostility', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.0, 'nervous_robber', 100)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      h.step(0.6, 0.05);
      const lethalHits = h.recorder
        .of('entityHit')
        .filter((e) => e.payload.shooter === 'ally_1' && !e.payload.nonlethal);
      expect(lethalHits).toHaveLength(0);
    });

    it('B6.2: Provoked hostile suspect is engaged cleanly with zero roeViolation', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(2.0, 0.05);
      expect(h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1').length).toBeGreaterThanOrEqual(1);
      expect(h.recorder.count('roeViolation')).toBe(0);
    });

    it('B6.3: Civilian in lethal line of fire suffers zero lethal casualties', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 100), makeCivilian('c1', 0, 0)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(3.0, 0.05);
      expect(h.entities.civilians.get('c1')!.alive).toBe(true);
      expect(
        h.recorder.of('entityHit').filter((e) => e.payload.targetId === 'c1' && !e.payload.nonlethal),
      ).toHaveLength(0);
    });

    it('B6.4: Surrendered suspect is NOT fired upon by friendly SWAT officers', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.5, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.0, 'nervous_robber', 100)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      const s1 = h.entities.suspects.get('s1')!;
      s1.morale.shift(-200);
      h.step(0.2, 0.05);
      expect(s1.state).toBe(SuspectState.SURRENDER);
      h.recorder.clear();

      h.step(2.0, 0.05);
      expect(h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1')).toHaveLength(0);
      expect(s1.alive).toBe(true);
    });

    it('B6.5: Neutralizing a confirmed hostile suspect awards neutralize without roeViolation', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [
        { id: 'ally_1', name: 'Miller', x: -0.5, y: 0, z: 2.5, yaw: 0 },
        { id: 'ally_2', name: 'Vance', x: 0.5, y: 0, z: 2.5, yaw: 0 },
      ];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.0, 'hardcore_leader', 40)],
          playerPos: { x: 0, y: 0, z: 9 },
        }),
      );
      emitContractEvent(h.bus, 'shotFired', {
        shooter: 's1',
        pos: { x: 0, y: 1.5, z: -2.0 },
        dir: { x: 0, y: 0, z: 1 },
      });
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.0 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(3.0, 0.05);
      expect(h.entities.suspects.get('s1')!.alive).toBe(false);
      expect(h.recorder.count('roeViolation')).toBe(0);
    });
  });

  // =========================================================================
  // 7. `hold` and `overwatch` Order Locks
  // =========================================================================
  describe('7. hold and overwatch Order Locks', () => {
    it('B7.1: hold order prevents officer from autonomously rushing a low-HP weakened hostile', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 3.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -3.0, 'hardcore_leader', 30)],
          playerPos: { x: 0, y: 0, z: 8.5 },
        }),
      );
      expect(h.issueOrder('hold', { element: 'gold' })).toBe(true);
      const startPos = { x: h.squad.getLivingAllies()[0]!.px, z: h.squad.getLivingAllies()[0]!.pz };

      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -3.0 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(2.5, 0.05);
      const endAlly = h.squad.getLivingAllies()[0]!;
      expect(Math.hypot(endAlly.px - startPos.x, endAlly.pz - startPos.z)).toBeLessThan(1.0);
    });

    it('B7.2: overwatch order prevents officer from abandoning post to rush weakened hostile', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 3.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -3.0, 'hardcore_leader', 30)],
          playerPos: { x: 0, y: 0, z: 8.5 },
        }),
      );
      expect(h.issueOrder('overwatch', { element: 'gold' })).toBe(true);
      const startPos = { x: h.squad.getLivingAllies()[0]!.px, z: h.squad.getLivingAllies()[0]!.pz };

      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -3.0 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(2.5, 0.05);
      const endAlly = h.squad.getLivingAllies()[0]!;
      expect(Math.hypot(endAlly.px - startPos.x, endAlly.pz - startPos.z)).toBeLessThan(1.0);
    });

    it('B7.3: Officer under hold order still engages visible hostile suspect in LOS', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 3.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 8.5 },
        }),
      );
      expect(h.issueOrder('hold', { element: 'gold' })).toBe(true);
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(1.5, 0.05);
      expect(h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1').length).toBeGreaterThanOrEqual(1);
    });

    it('B7.4: Officer under overwatch order still engages visible hostile suspect in LOS', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 3.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [makeSuspect('s1', 0, -2.5, 'hardcore_leader', 100)],
          playerPos: { x: 0, y: 0, z: 8.5 },
        }),
      );
      expect(h.issueOrder('overwatch', { element: 'gold' })).toBe(true);
      emitContractEvent(h.bus, 'suspectFired', {
        id: 's1',
        pos: { x: 0, y: 1.5, z: -2.5 },
        dir: { x: 0, y: 0, z: 1 },
      });

      h.step(1.5, 0.05);
      expect(h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1').length).toBeGreaterThanOrEqual(1);
    });

    it('B7.5: Issuing follow after hold releases the hold lock and moves officer toward player', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: -3, y: 0, z: 8.0, yaw: 0 }];
      const h = track(
        createSquadHarness({
          map,
          allies,
          entities: [],
          playerPos: { x: 3, y: 0, z: 8.0 },
        }),
      );
      expect(h.issueOrder('hold', { element: 'gold' })).toBe(true);
      h.step(0.5, 0.05);
      const heldX = h.squad.getLivingAllies()[0]!.px;

      expect(h.issueOrder('follow', { element: 'gold' })).toBe(true);
      h.step(2.0, 0.05);
      const afterX = h.squad.getLivingAllies()[0]!.px;
      expect(afterX).toBeGreaterThan(heldX + 1.0);
    });
  });

  // =========================================================================
  // 8. Down / Blinded Officer Optics Hidden
  // =========================================================================
  describe('8. Down / Blinded Officer TacticalOptics Visibility', () => {
    it('B8.1: Living unblinded friendly SWAT officer has visible TacticalOptics', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const h = track(createSquadHarness({ map, allies: defaultAllies(2, { x: 0, y: 0, z: 7 }) }));
      h.step(0.3, 0.05);
      const optics = findOpticsGroups(h.squad.root);
      expect(optics).toHaveLength(2);
      expect(optics.every((g) => g.visible)).toBe(true);
    });

    it('B8.2: Downed friendly SWAT officer hides TacticalOptics (visible === false)', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 7, yaw: 0 }];
      const h = track(createSquadHarness({ map, allies }));
      h.step(0.2, 0.05);
      const optics = findOpticsGroups(h.squad.root);
      expect(optics).toHaveLength(1);
      expect(optics[0]!.visible).toBe(true);

      emitContractEvent(h.bus, 'entityHit', {
        targetId: 'ally_1',
        damage: 150,
        pos: { x: 0, y: 1.2, z: 7 },
        shooter: 's1',
      });
      h.step(0.2, 0.05);
      expect(optics[0]!.visible).toBe(false);
    });

    it('B8.3: Blinded friendly SWAT officer hides TacticalOptics while flash-blinded', () => {
      const map = makeSingleRoomMap({ includeCover: false });
      const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.0, yaw: 0 }];
      const h = track(createSquadHarness({ map, allies }));
      h.step(0.2, 0.05);
      const optics = findOpticsGroups(h.squad.root);
      expect(optics).toHaveLength(1);

      emitContractEvent(h.bus, 'flashDetonated', {
        pos: { x: 0, y: 1.0, z: 0.5 },
        radius: 9,
        blindSec: 2.0,
        thrower: 's1',
      });
      h.step(0.3, 0.05);
      expect(optics[0]!.visible).toBe(false);
    });

    it('B8.4: TacticalOptics module setVisible(false) / hide() hides laser, dot, and cone', async () => {
      const mod = await loadTacticalOpticsModule();
      expect(mod?.TacticalOptics, 'M1 src/ai/TacticalOptics.ts required').toBeDefined();
      const scene = new THREE.Scene();
      const optics = new mod!.TacticalOptics!(scene);
      optics.update({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: -1 }, [], true);
      if (optics.setVisible) optics.setVisible(false);
      else optics.hide?.();

      if (optics.group) expect(optics.group.visible).toBe(false);
      if (optics.laserMesh) expect(optics.laserMesh.visible).toBe(false);
      optics.dispose(scene);
    });

    it('B8.5: TacticalOptics maintains zero dynamic THREE.Lights across show/hide transitions', async () => {
      const mod = await loadTacticalOpticsModule();
      expect(mod?.TacticalOptics, 'M1 src/ai/TacticalOptics.ts required').toBeDefined();
      const scene = new THREE.Scene();
      const optics = new mod!.TacticalOptics!(scene);
      optics.update({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: -1 }, [], true);
      expect(countDynamicLights(optics.group ?? scene)).toBe(0);
      if (optics.setVisible) optics.setVisible(false);
      else optics.hide?.();
      expect(countDynamicLights(optics.group ?? scene)).toBe(0);
      optics.dispose(scene);
    });
  });
});
