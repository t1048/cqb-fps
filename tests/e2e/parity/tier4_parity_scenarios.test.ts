import { afterEach, describe, expect, it } from 'vitest';
import { SuspectState } from '../../../src/core/events';
import type { AllyDef, EntityDef } from '../../../src/core/types';
import { applyMissionRoster, indoorFloorArea, missionRoster } from '../../../src/rules/MissionRoster';
import { SWAT_COMBAT, SHIELD_COMBAT } from '../../../src/modes/SwatTeam';
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

describe('Tier 4 — Real-World Raid & Head-to-Head Parity Scenarios', () => {
  it('Scenario 1: Multi-room barricaded house raid (house_compact seed 101) — full squad entry, clearing, zero civilian harm, zero dynamic lights', () => {
    const map = applyMissionRoster(generateRealMap('house_compact', 101));
    const h = track(createSquadHarness({ map }));

    expect(h.squad.count).toBeGreaterThanOrEqual(2);
    // Find nearest door to player spawn and order full-squad clear
    let nearestDoor = h.doors.doors[0]!;
    let bestDist = Infinity;
    for (const d of h.doors.doors) {
      const dist = Math.hypot(d.centerX - h.player.position.x, d.centerZ - h.player.position.z);
      if (dist < bestDist) {
        bestDist = dist;
        nearestDoor = d;
      }
    }
    expect(nearestDoor).toBeDefined();
    expect(h.issueOrder('clear', { element: 'gold', door: nearestDoor })).toBe(true);

    h.step(12.0, 0.05);

    // Every living officer has TacticalOptics, navy uniform, zero dynamic lights
    expect(hasClothColor(h.squad.root, 0x2b3440)).toBe(true);
    expect(findOpticsGroups(h.squad.root).length).toBe(h.squad.count);
    expect(countDynamicLights(h.squad.root)).toBe(0);
    expect(countDynamicLights(h.tearGas.root)).toBe(0);
    expect(h.recorder.count('swatFootstep')).toBeGreaterThanOrEqual(1);

    // Zero civilian casualties and zero ROE violations
    for (const civ of h.entities.civilians.values()) {
      expect(civ.alive).toBe(true);
    }
    expect(h.recorder.count('roeViolation')).toBe(0);
  });

  it('Scenario 2: Locked-door C2 explosive breach + organic hostage shield rescue', () => {
    const map = makeTwoDoorHouseMap({ southLocked: true, northLocked: true, includeInteriorDivider: true });
    const allies = defaultAllies(4, { x: 0, y: 0, z: 7.2 });
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [
          makeSuspect('s_door', -0.4, 3.0, 'hardcore_leader', 100),
          // Cornered suspect in back north room NW corner (isolated behind closed door_mid during C2 breach)
          makeSuspect('s_hostage', -4.2, -4.2, 'nervous_robber', 100),
          makeCivilian('c_hostage', -3.6, -3.6),
        ],
        playerPos: { x: 0, y: 0, z: 9.5 },
      }),
    );

    const doorSouth = h.doors.findById('door_south')!;
    const doorMid = h.doors.findById('door_mid')!;
    expect(doorSouth.locked).toBe(true);
    expect(h.issueOrder('c2Clear', { element: 'gold', door: doorSouth })).toBe(true);

    // Step until C2 detonates on south door
    h.step(6.0, 0.05);
    expect(h.recorder.count('c2Beep')).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
    expect(doorSouth.locked).toBe(false);
    expect(h.entities.suspects.get('s_door')!.hp).toBeLessThan(100);

    // Back-room suspect was isolated behind interior divider and must NOT have been arrested during C2 phase
    const sHostage = h.entities.suspects.get('s_hostage')!;
    expect(sHostage.alive).toBe(true);
    expect(sHostage.state).not.toBe(SuspectState.ARRESTED);

    // Organically push cornered suspect into HOSTAGE_SHIELD with morale in [25, 45)
    sHostage.adjustMorale(35 - sHostage.morale.value);
    sHostage.takeHit(5, { x: -1.5, y: 1.4, z: -1.5 });
    h.step(0.6, 0.05);
    expect(sHostage.state).toBe(SuspectState.HOSTAGE_SHIELD);

    // Advance player into south room and order gold element to clear interior door into hostage room
    h.player.moveTo(0, 0, 2.0);
    expect(h.issueOrder('clear', { element: 'gold', door: doorMid })).toBe(true);
    emitContractEvent(h.bus, 'suspectFired', {
      id: 's_hostage',
      pos: { x: -4.2, y: 1.5, z: -4.2 },
      dir: { x: 0.7, y: 0, z: 0.7 },
    });

    h.step(6.0, 0.05);

    // Civilian survives unharmed while pepperball engages hostage-taker
    expect(h.entities.civilians.get('c_hostage')!.alive).toBe(true);
    const pepperHits = h.recorder
      .of('entityHit')
      .filter((e) => e.payload.shooter.startsWith('ally_') && e.payload.nonlethal === true);
    expect(pepperHits.length).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('roeViolation')).toBe(0);
  });

  it('Scenario 3: Two-door house CS tear gas flush + ALPHA/BRAVO pincer flank', () => {
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
        entities: [makeSuspect('s1', 0, 1.5, 'hardcore_leader', 100)],
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
      pos: { x: 0, y: 1.5, z: 1.5 },
      dir: { x: 0, y: 0, z: 1 },
    });

    h.step(12.0, 0.05);

    expect(h.recorder.count('gasDetonated')).toBeGreaterThanOrEqual(1);
    expect(h.audioSink.of('playGasHiss').length).toBeGreaterThanOrEqual(1);
    expect(southDoor.stage).not.toBe('closed');
    expect(northDoor.stage).not.toBe('closed');
    // All friendly officers immune to CS gas (no gas-induced deaths)
    const livingCount = h.squad.getLivingAllies().length;
    expect(livingCount).toBeGreaterThanOrEqual(2);
    // Suspect engaged by crossfire
    expect(h.entities.suspects.get('s1')!.hp).toBeLessThan(100);
  });

  it('Scenario 4: Full-squad ROE & arrest/evidence lifecycle + post-clear sweep', () => {
    const map = makeSingleRoomMap({ includeCover: false });
    const allies: AllyDef[] = [
      { id: 'ally_1', name: 'Miller', x: -0.8, y: 0, z: 2.2, yaw: 0 },
      { id: 'ally_2', name: 'Vance', x: 0.8, y: 0, z: 2.2, yaw: 0 },
    ];
    const h = track(
      createSquadHarness({
        map,
        allies,
        entities: [
          makeSuspect('s_hostile', -1.2, -2.0, 'hardcore_leader', 40),
          makeSuspect('s_surrender', 1.2, -1.5, 'nervous_robber', 100),
        ],
        playerPos: { x: 0, y: 0, z: 8.5 },
      }),
    );

    // Hostile suspect opens fire, nervous suspect surrenders
    emitContractEvent(h.bus, 'shotFired', {
      shooter: 's_hostile',
      pos: { x: -1.2, y: 1.5, z: -2.0 },
      dir: { x: 0, y: 0, z: 1 },
    });
    emitContractEvent(h.bus, 'suspectFired', {
      id: 's_hostile',
      pos: { x: -1.2, y: 1.5, z: -2.0 },
      dir: { x: 0, y: 0, z: 1 },
    });
    const sSurr = h.entities.suspects.get('s_surrender')!;
    sSurr.morale.shift(-200);

    h.step(3.0, 0.05);
    expect(h.entities.suspects.get('s_hostile')!.alive).toBe(false);
    expect(sSurr.state).toBe(SuspectState.SURRENDER);
    expect(sSurr.alive).toBe(true);

    // Trigger post-clear autonomous sweep to restrain surrendered suspect & collect evidence
    h.squad.beginPostClearSweep();
    h.step(10.0, 0.05);

    expect(h.recorder.count('arrest')).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('evidence')).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('roeViolation')).toBe(0);
  });

  it('Scenario 5: Multi-room house raid (house seed 202) — squad order progression, enemy contact, civilian safety, optics & clean disposal', () => {
    const map = applyMissionRoster(generateRealMap('house', 202));
    const h = track(createSquadHarness({ map }));

    expect(h.squad.count).toBeGreaterThanOrEqual(4);
    expect(h.doors.doors.length).toBeGreaterThanOrEqual(2);

    // Find nearest exterior door to player spawn and order ALPHA to stack + GOLD to flashClear
    let nearestDoor = h.doors.doors[0]!;
    let bestDist = Infinity;
    for (const d of h.doors.doors) {
      const dist = Math.hypot(d.centerX - h.player.position.x, d.centerZ - h.player.position.z);
      if (dist < bestDist) {
        bestDist = dist;
        nearestDoor = d;
      }
    }
    expect(h.issueOrder('stack', { element: 'alpha', door: nearestDoor })).toBe(true);
    h.step(3.0, 0.05);

    expect(h.issueOrder('flashClear', { element: 'gold', door: nearestDoor })).toBe(true);
    h.step(12.0, 0.05);

    // Full SWAT-mode parity invariants on large multi-room house
    expect(hasClothColor(h.squad.root, 0x2b3440)).toBe(true);
    expect(findOpticsGroups(h.squad.root).length).toBe(h.squad.count);
    expect(countDynamicLights(h.squad.root)).toBe(0);
    expect(countDynamicLights(h.tearGas.root)).toBe(0);
    expect(h.recorder.count('swatFootstep')).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('allyRadio')).toBeGreaterThanOrEqual(1);

    // Zero civilian casualties and zero ROE violations throughout multi-room raid
    for (const civ of h.entities.civilians.values()) {
      expect(civ.alive).toBe(true);
    }
    expect(h.recorder.count('roeViolation')).toBe(0);
  });

  it('Scenario 6: Head-to-head SWAT-mode vs Suspect-mode parity on identical generated house_compact (seed 101)', async () => {
    const profileMod = await loadSwatProfileModule();
    expect(profileMod, 'M1 SwatProfile.ts required').toBeDefined();

    const baseMap = applyMissionRoster(generateRealMap('house_compact', 101));
    const rosterSpec = missionRoster(indoorFloorArea(baseMap.rooms));
    // In SWAT mode, total officers = player (1) + squad allies; in Suspect mode, total officers = SwatTeam count
    const squadAllyCount = baseMap.allies?.length ?? 4;
    expect(squadAllyCount + 1).toBeGreaterThanOrEqual(rosterSpec.swat);

    const pair = track(createParityPair({ map: baseMap, officerCount: squadAllyCount }));
    pair.squadHarness.step(0.4, 0.05);
    pair.swatHarness.step(0.4, 0.05);

    // Identical HP & alive count
    const squadRoster = pair.squadHarness.squad.getRoster();
    expect(squadRoster).toHaveLength(squadAllyCount);
    expect(squadRoster.every((r) => r.hp === profileMod!.SWAT_HP && r.maxHp === profileMod!.SWAT_HP)).toBe(true);
    expect(pair.swatHarness.team.aliveCount).toBe(squadAllyCount);

    // Identical dark navy SWAT uniform color (0x2b3440)
    expect(hasClothColor(pair.squadHarness.squad.root, profileMod!.SWAT_UNIFORM_COLOR!)).toBe(true);
    expect(hasClothColor(pair.swatHarness.team.root, profileMod!.SWAT_UNIFORM_COLOR!)).toBe(true);

    // Identical shield role assignment (index 0 shielded along actual yawRad, index 1+ rifleman)
    const livingAllies = pair.squadHarness.squad.getLivingAllies();
    const minimapAllies = pair.squadHarness.squad.getMinimapAllies();
    const chest0 = livingAllies[0]!.getChest();
    const fx0 = -Math.sin(minimapAllies[0]!.yawRad);
    const fz0 = -Math.cos(minimapAllies[0]!.yawRad);
    expect(livingAllies[0]!.shieldBlocks({ x: chest0.x + fx0 * 4, y: chest0.y, z: chest0.z + fz0 * 4 }, chest0)).toBe(true);
    expect(livingAllies[0]!.shieldBlocks({ x: chest0.x - fx0 * 4, y: chest0.y, z: chest0.z - fz0 * 4 }, chest0)).toBe(false);

    const chest1 = livingAllies[1]!.getChest();
    const fx1 = -Math.sin(minimapAllies[1]!.yawRad);
    const fz1 = -Math.cos(minimapAllies[1]!.yawRad);
    expect(livingAllies[1]!.shieldBlocks({ x: chest1.x + fx1 * 4, y: chest1.y, z: chest1.z + fz1 * 4 }, chest1)).toBe(false);

    // Identical TacticalOptics presence & zero dynamic lights
    const squadOptics = findOpticsGroups(pair.squadHarness.squad.root);
    const swatOptics = findOpticsGroups(pair.swatHarness.team.root);
    expect(squadOptics).toHaveLength(squadAllyCount);
    expect(swatOptics).toHaveLength(squadAllyCount);
    for (const g of [...squadOptics, ...swatOptics]) {
      expect(countDynamicLights(g)).toBe(0);
    }
  });

  it('Scenario 7: Head-to-head SWAT-mode vs Suspect-mode tactical capability parity on house (seed 303)', async () => {
    const [profileMod, tacticsMod] = await Promise.all([loadSwatProfileModule(), loadSwatTacticsModule()]);
    expect(profileMod, 'M1 SwatProfile.ts required').toBeDefined();
    expect(tacticsMod, 'M1 SwatTactics.ts required').toBeDefined();

    const baseMap = applyMissionRoster(generateRealMap('house', 303));
    const pair = track(createParityPair({ map: baseMap, officerCount: 4, startAssault: true }));
    pair.squadHarness.step(0.5, 0.05);
    pair.swatHarness.step(0.5, 0.05);

    // Both modes share exact weapon/combat baselines
    expect(profileMod!.BASE_SWAT_COMBAT!.magazineSize).toBe(SWAT_COMBAT.magazineSize);
    expect(profileMod!.BASE_SWAT_COMBAT!.engageRange).toBe(SWAT_COMBAT.engageRange);
    expect(profileMod!.BASE_SHIELD_COMBAT!.magazineSize).toBe(SHIELD_COMBAT.magazineSize);
    expect(profileMod!.BASE_SHIELD_COMBAT!.coverSearchRange).toBe(SHIELD_COMBAT.coverSearchRange);

    // Both modes have real Flashbang & TearGas wired and zero dynamic lights
    expect(pair.squadHarness.flashbang).toBeDefined();
    expect(pair.squadHarness.tearGas).toBeDefined();
    expect(pair.swatHarness.flashbang).toBeDefined();
    // Both modes render TacticalOptics on all 4 officers with zero dynamic lights and dark navy uniforms
    const squadOptics = findOpticsGroups(pair.squadHarness.squad.root);
    const swatOptics = findOpticsGroups(pair.swatHarness.team.root);
    expect(squadOptics).toHaveLength(4);
    expect(swatOptics).toHaveLength(4);
    for (const g of [...squadOptics, ...swatOptics]) {
      expect(countDynamicLights(g)).toBe(0);
    }
    expect(hasClothColor(pair.squadHarness.squad.root, 0x2b3440)).toBe(true);
    expect(hasClothColor(pair.swatHarness.team.root, 0x2b3440)).toBe(true);

    // Shared tactical planners work on the real generated map's doors & colliders
    const roomDoors = tacticsMod!.findRoomDoors!(baseMap.rooms[0], pair.squadHarness.doors.doors);
    expect(Array.isArray(roomDoors)).toBe(true);
  });
});
