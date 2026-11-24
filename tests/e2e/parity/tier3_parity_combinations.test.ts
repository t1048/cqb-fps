import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SuspectState } from '../../../src/core/events';
import type { AllyDef, EntityDef } from '../../../src/core/types';
import { applyMissionRoster } from '../../../src/rules/MissionRoster';
import { SWAT_COMBAT, SHIELD_COMBAT } from '../../../src/modes/SwatTeam';
import { hasLineOfSight } from '../../../src/weapons/Flashbang';
import {
  countDynamicLights,
  createParityPair,
  createSquadHarness,
  defaultAllies,
  emitContractEvent,
  findOpticsGroups,
  generateRealMap,
  hasClothColor,
  loadSwatProfileModule,
  loadSwatTacticsModule,
  loadTacticalOpticsModule,
  makeSingleRoomMap,
  makeTwoDoorHouseMap,
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

describe('Tier 3 — Cross-Feature Parity Combinations', () => {
  it('C1: C2 explosive breach on locked door + blast cone damage + squad entry engagement', () => {
    const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
    const allies = defaultAllies(4, { x: 0, y: 0, z: 6.2 });
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [makeSuspect('s1', 0, 1.8, 'hardcore_leader', 100)],
        playerPos: { x: 0, y: 0, z: 9.0 },
      }),
    );
    const door = h.doors.findById('door_south')!;
    expect(h.issueOrder('c2Clear', { element: 'gold', door })).toBe(true);

    h.step(12.0, 0.05);
    expect(h.recorder.count('c2Beep')).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
    expect(door.locked).toBe(false);
    // Officers should have entered past door (z < 4)
    const enteredCount = h.squad.getLivingAllies().filter((a) => a.pz < 3.8).length;
    expect(enteredCount).toBeGreaterThanOrEqual(1);
    expect(h.entities.suspects.get('s1')!.hp).toBeLessThan(100);
  });

  it('C2: C2 breach + follow-up flashbang + weakness-triggered rush on stunned/damaged hostile', () => {
    const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
    const allies = defaultAllies(4, { x: 0, y: 0, z: 6.0 });
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [makeSuspect('s1', 0, 1.5, 'hardcore_leader', 80)],
        playerPos: { x: 0, y: 0, z: 9.0 },
      }),
    );
    const door = h.doors.findById('door_south')!;
    expect(h.issueOrder('c2Clear', { element: 'gold', door })).toBe(true);
    // Detonate follow-up friendly flash inside room after breach starts
    h.step(3.5, 0.05);
    h.flashbang.throwFrom({ x: 0, y: 1.4, z: 5.0 }, { x: 0, y: 2.0, z: -5.5 }, 'ally_1', 0.8);
    emitContractEvent(h.bus, 'suspectFired', {
      id: 's1',
      pos: { x: 0, y: 1.5, z: 1.5 },
      dir: { x: 0, y: 0, z: 1 },
    });

    h.step(8.0, 0.05);
    expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('flashDetonated')).toBeGreaterThanOrEqual(1);
    // Friendly officers are not blinded by ally flash and neutralize or heavily wound s1
    expect(h.entities.suspects.get('s1')!.hp).toBeLessThan(80);
  });

  it('C3: CS tear gas flush-out (gasClear) + ALPHA/BRAVO two-door pincer + instant-fire engagement', () => {
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
        entities: [makeSuspect('s1', 0, 1.0, 'hardcore_leader', 100)],
        playerPos: { x: 0, y: 0, z: 9.5 },
      }),
    );
    const southDoor = h.doors.findById('door_south')!;
    const northDoor = h.doors.findById('door_north')!;

    expect(h.issueOrder('gasClear', { element: 'alpha', door: southDoor })).toBe(true);
    // Position player on north exterior side so approachSign assigns BRAVO the reachable north exterior
    h.player.moveTo(0, 0, -8);
    expect(h.issueOrder('clear', { element: 'bravo', door: northDoor })).toBe(true);
    h.player.moveTo(0, 0, 9.5);
    emitContractEvent(h.bus, 'suspectFired', {
      id: 's1',
      pos: { x: 0, y: 1.5, z: 1.0 },
      dir: { x: 0, y: 0, z: 1 },
    });

    h.step(10.0, 0.05);
    expect(h.recorder.count('gasDetonated')).toBeGreaterThanOrEqual(1);
    expect(southDoor.stage).not.toBe('closed');
    expect(northDoor.stage).not.toBe('closed');
    const allyShots = h.recorder.of('shotFired').filter((e) => e.payload.shooter.startsWith('ally_'));
    expect(allyShots.length).toBeGreaterThanOrEqual(1);
  });

  it('C4: CS tear gas cloud + SWAT gas-mask immunity + suspect morale drop & flush', () => {
    const map = makeSingleRoomMap({ includeCover: false });
    const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 0, y: 0, z: 2.2, yaw: 0 }];
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [makeSuspect('s1', 0, 0, 'hardcore_leader', 100)],
        playerPos: { x: 0, y: 0, z: 9.0 },
      }),
    );
    expect(h.entities.setTearGas, 'M2 EntityManager.setTearGas required').toBeTypeOf('function');
    const s1 = h.entities.suspects.get('s1')!;
    const startMorale = s1.morale.value;

    h.tearGas.throwFrom({ x: 0, y: 0.6, z: 0.5 }, { x: 0, y: 0, z: 0 }, 'ally_1', 0.1);
    h.step(5.0, 0.05);

    expect(s1.morale.value).toBeLessThan(startMorale);
    expect(h.squad.getRoster()[0]!.hp).toBe(100);
    expect(h.squad.getRoster()[0]!.down).toBe(false);
  });

  it('C5: Shield pointman frontal pin + rifleman flank + pepperball fallback on organic HOSTAGE_SHIELD', () => {
    const map = makeSingleRoomMap({ includeCover: false });
    const allies: AllyDef[] = [
      { id: 'ally_1', name: 'Miller', x: -1.0, y: 0, z: 0.5, yaw: 0 },
      { id: 'ally_2', name: 'Vance', x: -0.2, y: 0, z: 1.0, yaw: 0 },
    ];
    const h = track(
      createSquadHarness({
        map,
        allies,
        // Corner nervous_robber against NW walls (x=-4, z=-4) with civilian directly in front on LOS
        entities: [makeSuspect('s1', -3.2, -3.2, 'nervous_robber', 100), makeCivilian('c1', -2.7, -2.7)],
        playerPos: { x: 1.5, y: 0, z: 1.0 },
      }),
    );
    const s1 = h.entities.suspects.get('s1')!;
    s1.adjustMorale(-20);
    s1.takeHit(5, { x: -1.0, y: 1.4, z: 0.5 });

    // Organically enter HOSTAGE_SHIELD
    h.step(0.15, 0.05);
    expect(s1.state).toBe(SuspectState.HOSTAGE_SHIELD);

    h.step(3.0, 0.05);
    // Shield pointman blocks frontal shots along actual yawRad and is vulnerable from the rear
    const shield = h.squad.getLivingAllies().find((a) => a.id === 'ally_1')!;
    const shieldMinimap = h.squad.getMinimapAllies()[0]!;
    const fx = -Math.sin(shieldMinimap.yawRad);
    const fz = -Math.cos(shieldMinimap.yawRad);
    const chest = shield.getChest();
    expect(shield.shieldBlocks({ x: chest.x + fx * 4, y: chest.y, z: chest.z + fz * 4 }, chest)).toBe(true);
    expect(shield.shieldBlocks({ x: chest.x - fx * 4, y: chest.y, z: chest.z - fz * 4 }, chest)).toBe(false);
    // Pepperball deployed, civilian survives
    expect(h.entities.civilians.get('c1')!.alive).toBe(true);
    const pepperHits = h.recorder
      .of('entityHit')
      .filter((e) => e.payload.shooter.startsWith('ally_') && e.payload.nonlethal === true);
    expect(pepperHits.length).toBeGreaterThanOrEqual(1);
  });

  it('C6: Shield pointman frontal block + rifleman instant-fire neutralization of hostile', () => {
    const map = makeSingleRoomMap({ includeCover: false });
    const allies: AllyDef[] = [
      { id: 'ally_1', name: 'Miller', x: -0.4, y: 0, z: 2.2, yaw: 0 },
      { id: 'ally_2', name: 'Vance', x: 0.8, y: 0, z: 2.5, yaw: 0 },
    ];
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [makeSuspect('s1', 0, -2.2, 'hardcore_leader', 100)],
        playerPos: { x: 0, y: 0, z: 9.0 },
      }),
    );
    emitContractEvent(h.bus, 'suspectFired', {
      id: 's1',
      pos: { x: 0, y: 1.5, z: -2.2 },
      dir: { x: 0, y: 0, z: 1 },
    });

    h.step(3.5, 0.05);
    expect(h.entities.suspects.get('s1')!.alive).toBe(false);
    expect(h.recorder.count('roeViolation')).toBe(0);
  });

  it('C7: Mode-switch SWAT↔Suspect uniform, HP, optics & zero-light parity on house_compact seed 101', () => {
    const pair = track(createParityPair({ template: 'house_compact', seed: 101, officerCount: 4 }));
    pair.squadHarness.step(0.3, 0.05);
    pair.swatHarness.step(0.3, 0.05);

    expect(hasClothColor(pair.squadHarness.squad.root, 0x2b3440)).toBe(true);
    expect(hasClothColor(pair.swatHarness.team.root, 0x2b3440)).toBe(true);

    const squadOptics = findOpticsGroups(pair.squadHarness.squad.root);
    const swatOptics = findOpticsGroups(pair.swatHarness.team.root);
    expect(squadOptics).toHaveLength(4);
    expect(swatOptics).toHaveLength(4);

    for (const g of [...squadOptics, ...swatOptics]) {
      expect(countDynamicLights(g)).toBe(0);
    }

    const roster = pair.squadHarness.squad.getRoster();
    expect(roster.every((r) => r.hp === 100 && r.maxHp === 100)).toBe(true);
    expect(pair.swatHarness.team.aliveCount).toBe(4);
  });

  it('C8: Mode-switch SWAT↔Suspect roster, shield-role & weapon-profile parity on house seed 202', async () => {
    const profileMod = await loadSwatProfileModule();
    expect(profileMod, 'M1 SwatProfile.ts required').toBeDefined();

    const baseMap = applyMissionRoster(generateRealMap('house', 202));
    const pair = track(createParityPair({ map: baseMap, officerCount: 4 }));
    pair.squadHarness.step(0.3, 0.05);
    pair.swatHarness.step(0.3, 0.05);

    // Shield role assignment matches across modes
    const livingAllies = pair.squadHarness.squad.getLivingAllies();
    expect(livingAllies).toHaveLength(4);
    expect(profileMod!.isShieldRole!(0, 4)).toBe(true);
    expect(profileMod!.isShieldRole!(1, 4)).toBe(false);
    // Base combat profiles match SwatTeam
    expect(profileMod!.BASE_SWAT_COMBAT!.shotDamage).toBe(SWAT_COMBAT.shotDamage);
    expect(profileMod!.BASE_SHIELD_COMBAT!.shotDamage).toBe(SHIELD_COMBAT.shotDamage);
    expect(hasClothColor(pair.squadHarness.squad.root, profileMod!.SWAT_UNIFORM_COLOR!)).toBe(true);
  });

  it('C9: Multi-officer combat audiovisuals: TacticalOptics (0 lights) + swatFootstep + staggered allyRadio + AudioBridge', () => {
    const map = makeSingleRoomMap({ lockedDoor: false, includeCover: false });
    const allies = defaultAllies(4, { x: 0, y: 0, z: 6.5 });
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [makeSuspect('s1', 0, -2.0, 'hardcore_leader', 100)],
        playerPos: { x: 0, y: 0, z: 9.0 },
      }),
    );
    const door = h.doors.findById('door_south')!;
    h.issueOrder('stack', { element: 'alpha', door });
    h.issueOrder('clear', { element: 'gold', door });
    h.step(6.0, 0.05);

    expect(findOpticsGroups(h.squad.root)).toHaveLength(4);
    expect(countDynamicLights(h.squad.root)).toBe(0);
    expect(h.recorder.count('swatFootstep')).toBeGreaterThanOrEqual(1);
    expect(h.audioSink.of('playSwatFootstep').length).toBeGreaterThanOrEqual(1);

    const radios = h.recorder.of('allyRadio');
    expect(radios.length).toBeGreaterThanOrEqual(2);
    expect(h.audioSink.of('playAllyRadio').length).toBe(radios.length);
    for (let i = 1; i < radios.length; i++) {
      expect(radios[i]!.time - radios[i - 1]!.time).toBeGreaterThanOrEqual(1.1);
    }
  });

  it('C10: Suppressive fire on lost LOS + reload cycle without violating civilian ROE', () => {
    const map = makeSingleRoomMap({ includeCover: true });
    // Add full-height interior partition wall so retreating behind it genuinely breaks eye-level LOS
    map.walls.push({ x: -1.8, z: -0.5, width: 2.4, depth: 0.3, height: 3.0 });
    const allies: AllyDef[] = [{ id: 'ally_1', name: 'Miller', x: 1.5, y: 0, z: 2.5, yaw: 0 }];
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [
          makeSuspect('s1', 0.8, -1.5, 'hardcore_leader', 300),
          makeCivilian('c1', -2.5, 2.0),
        ],
        playerPos: { x: 1.5, y: 0, z: 3.0 },
      }),
    );
    h.issueOrder('hold', { element: 'gold' });
    emitContractEvent(h.bus, 'suspectFired', {
      id: 's1',
      pos: { x: 0.8, y: 1.5, z: -1.5 },
      dir: { x: 0, y: 0, z: 1 },
    });

    h.step(0.6, 0.05);
    // Suspect breaks eye-level LOS behind full-height interior wall
    const s1 = h.entities.suspects.get('s1')!;
    s1.body.setPosition(-2.5, -2.2);
    const allyChest = h.squad.getLivingAllies()[0]!.getChest();
    const suspectEye = { x: s1.body.px, y: 1.5, z: s1.body.pz };
    expect(hasLineOfSight(h.colliders, { x: allyChest.x, y: 1.5, z: allyChest.z }, suspectEye)).toBe(false);
    h.recorder.clear();

    h.step(2.5, 0.05);
    expect(h.recorder.of('shotFired').filter((e) => e.payload.shooter === 'ally_1').length).toBeGreaterThanOrEqual(1);
    expect(h.entities.civilians.get('c1')!.alive).toBe(true);
    expect(h.recorder.count('roeViolation')).toBe(0);
  });

  it('C11: Indirect flashClear + friendly-thrower immunity + immediate entry & neutralization', () => {
    const map = makeSingleRoomMap({ lockedDoor: false, includeCover: false });
    const allies = defaultAllies(2, { x: 0, y: 0, z: 5.6 });
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [makeSuspect('s1', 0, -1.5, 'hardcore_leader', 100)],
        playerPos: { x: 0, y: 0, z: 8.5 },
      }),
    );
    const door = h.doors.findById('door_south')!;
    expect(h.issueOrder('flashClear', { element: 'gold', door })).toBe(true);

    h.step(9.0, 0.05);
    const flashes = h.recorder.of('flashDetonated');
    expect(flashes.length).toBeGreaterThanOrEqual(1);
    expect(typeof flashes[0]!.payload.thrower).toBe('string');
    expect(flashes[0]!.payload.thrower).toMatch(/^ally_/);
    // Squad entered room after flash without blinding themselves
    const entered = h.squad.getLivingAllies().filter((a) => a.pz < 3.8);
    expect(entered.length).toBeGreaterThanOrEqual(1);
  });

  it('C12: Independent element commands — ALPHA holds outside while BRAVO clears through north door', () => {
    const map = makeTwoDoorHouseMap({ southLocked: false, northLocked: false });
    const allies: AllyDef[] = [
      { id: 'ally_1', name: 'Miller', x: -0.6, y: 0, z: 7.0, yaw: 0 },
      { id: 'ally_2', name: 'Vance', x: 0.6, y: 0, z: 7.0, yaw: 0 },
      { id: 'ally_3', name: 'Cole', x: -0.6, y: 0, z: -6.5, yaw: 180 },
      { id: 'ally_4', name: 'Reeves', x: 0.6, y: 0, z: -6.5, yaw: 180 },
    ];
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [makeSuspect('s1', 0, -2.0, 'hardcore_leader', 100)],
        playerPos: { x: 0, y: 0, z: 9.5 },
      }),
    );
    const northDoor = h.doors.findById('door_north')!;
    expect(h.issueOrder('hold', { element: 'alpha' })).toBe(true);
    // Position player on north exterior side so approachSign assigns BRAVO the reachable north exterior
    h.player.moveTo(0, 0, -8);
    expect(h.issueOrder('clear', { element: 'bravo', door: northDoor })).toBe(true);
    h.player.moveTo(0, 0, 9.5);

    h.step(5.5, 0.05);
    // ALPHA remains near z=7 outside south wall, while BRAVO opens north door
    const alpha1 = h.squad.getLivingAllies().find((a) => a.id === 'ally_1')!;
    expect(alpha1.pz).toBeGreaterThan(5.5);
    expect(northDoor.stage).not.toBe('closed');
  });

  it('C13: C2 breach with civilian and hostile suspect inside room protects civilian while damaging hostile', () => {
    const map = makeSingleRoomMap({ lockedDoor: true, includeCover: false });
    const allies = defaultAllies(2, { x: 0, y: 0, z: 6.0 });
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [
          makeSuspect('s1', -0.5, 2.0, 'hardcore_leader', 100),
          makeCivilian('c1', 0.6, 2.2),
        ],
        playerPos: { x: 0, y: 0, z: 8.5 },
      }),
    );
    const door = h.doors.findById('door_south')!;
    expect(h.issueOrder('c2Clear', { element: 'gold', door })).toBe(true);

    h.step(10.0, 0.05);
    expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
    expect(h.entities.civilians.get('c1')!.alive).toBe(true);
    expect(h.entities.suspects.get('s1')!.hp).toBeLessThan(100);
    expect(h.recorder.count('roeViolation')).toBe(0);
  });

  it('C14: Shared M1 modules (SwatProfile + SwatTactics + TacticalOptics) integrate cleanly with zero dynamic lights', async () => {
    const [profileMod, tacticsMod, opticsMod] = await Promise.all([
      loadSwatProfileModule(),
      loadSwatTacticsModule(),
      loadTacticalOpticsModule(),
    ]);
    expect(profileMod, 'M1 SwatProfile.ts required').toBeDefined();
    expect(tacticsMod, 'M1 SwatTactics.ts required').toBeDefined();
    expect(opticsMod?.TacticalOptics, 'M1 TacticalOptics.ts required').toBeDefined();

    // Blast cone uses canonical profile constants
    const coneCos = Math.cos((profileMod!.SWAT_C2_BLAST_HALF_ANGLE_DEG! * Math.PI) / 180);
    const blast = tacticsMod!.evaluateC2BlastCone!(
      { x: 0, y: 1, z: 4 },
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 1, z: 2 },
      profileMod!.SWAT_C2_BLAST_RADIUS!,
      coneCos,
      profileMod!.SWAT_C2_MAX_DAMAGE!,
    );
    expect(blast.inCone).toBe(true);
    expect(blast.damage).toBeGreaterThan(0);

    const scene = new THREE.Scene();
    const optics = new opticsMod!.TacticalOptics!(scene);
    optics.update({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: -1 }, [], true);
    expect(countDynamicLights(optics.group ?? scene)).toBe(0);
    optics.dispose(scene);
  });
});
