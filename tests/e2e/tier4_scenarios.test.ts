import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PRESSURE_RAMP_SEC,
  SWAT_COMBAT,
  computeBallisticVelocity,
} from '../../src/modes/SwatTeam';
import { SuspectMission, prepareSuspectMode, type ResultReport } from '../../src/modes/SuspectMode';
import { Interaction } from '../../src/player/Interaction';
import { PepperEffect } from '../../src/player/PepperEffect';
import { AudioBridge, type AudioBridgeSink } from '../../src/core/AudioBridge';
import * as ColliderIndex from '../../src/world/ColliderIndex';
import type { EntityManager } from '../../src/ai/EntityManager';
import type { PlayerController } from '../../src/player/PlayerController';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import {
  generateRealMap,
  makeSingleRoomMap,
  makeTwoDoorHouseMap,
  makeWindowedSiegeMap,
} from './helpers/headlessWorld';
import { restoreDomShim } from './helpers/domShim';
import {
  createHeadlessInput,
  createSwatHarness,
  type SwatHarness,
} from './helpers/simDriver';
import {
  loadOptionalModule,
  type ColliderIndexContract,
  type SwatTeamWithM2M3,
  type TearGasEffectModule,
  type TearGasModule,
} from './helpers/contracts';

const activeHarnesses: SwatHarness[] = [];
afterEach(() => {
  while (activeHarnesses.length > 0) {
    activeHarnesses.pop()!.dispose();
  }
  restoreDomShim();
});

function track(h: SwatHarness): SwatHarness {
  activeHarnesses.push(h);
  return h;
}

describe('Tier 4 — Real-World Suspect Mode Application Scenarios (8 Scenarios)', () => {
  it('Scenario 1 (M1): High-Pressure Contact & Vulnerability Rush Siege', () => {
    const h = track(
      createSwatHarness({
        map: makeSingleRoomMap({ includeCover: true }),
        spawns: [
          { x: 0, y: 0, z: 2.8 },
          { x: 1.4, y: 0, z: 2.8 },
        ],
        count: 2,
        playerPos: { x: 0, y: 0, z: -2.5 },
        playerYawRad: Math.PI,
        startAssault: true,
      }),
    );

    // 1. Immediate fire on contact
    h.step(1.2, 0.05);
    expect(h.recorder.of('shotFired').some((e) => e.payload.shooter.startsWith('swat_'))).toBe(true);

    // 2. Player hits shielded pointman -> stays aggressive (no cover retreat)
    const shield = h.team.hunters.find((u) => u.shielded)!;
    h.bus.emit('entityHit', {
      targetId: shield.id,
      shooter: 'player',
      damage: 15,
      pos: { x: shield.body.px, y: 0.3, z: shield.body.pz },
    });
    h.step(0.2, 0.05);
    expect(shield.alive).toBe(true);
    expect(shield.engage.label).not.toBe('toCover');

    // 3. SWAT throws flashbang -> player blinded -> triggers coordinated vulnerability rush
    const vel = computeBallisticVelocity({ x: 1.4, y: 1.4, z: 2.8 }, { x: 0, y: 0.4, z: -1.0 }, 9.8);
    h.flashbang.throwFrom({ x: 1.4, y: 1.4, z: 2.8 }, vel, 'swat_2', 0.35);
    h.step(0.6, 0.05);
    expect(h.recorder.count('flashDetonated')).toBe(1);
    expect(h.recorder.count('playerBlinded')).toBe(1);
    expect(h.team.hunters.some((u) => u.state === 'rush')).toBe(true);
  });

  it('Scenario 2 (M1): Real Generated Map (house_compact) Full Suspect Mode Lifecycle to Repelled Win', () => {
    const rawMap = generateRealMap('house_compact', 101);
    const setup = prepareSuspectMode(rawMap);
    const h = track(
      createSwatHarness({
        map: setup.map,
        spawns: setup.swatSpawns,
        count: Math.max(2, Math.min(4, setup.swatCount)),
        playerPos: setup.map.playerSpawn,
        startAssault: false,
      }),
    );

    let resultReport: ResultReport | null = null;
    let resultFailed: boolean | null = null;
    const interaction = new Interaction(createHeadlessInput(), 100);
    const entities = { civilians: new Map(), suspects: new Map() } as unknown as EntityManager;
    const mission = new SuspectMission(
      h.team,
      h.player as unknown as PlayerController,
      entities,
      h.hw.doors,
      createHeadlessInput(),
      h.subtitle,
      h.bus,
      interaction,
      (report, failed) => {
        resultReport = report;
        resultFailed = failed;
      },
    );

    // Begin assault and ramp pressure
    h.team.beginAssault();
    for (let i = 0; i < 60; i++) {
      h.step(0.05, 0.05);
      mission.update(0.05);
    }
    expect(h.team.hasStarted).toBe(true);
    expect(h.team.currentPressure).toBeGreaterThan(0);

    // Eliminate all SWAT units -> mission concludes with repelled victory
    for (const u of [...h.team.hunters]) {
      h.bus.emit('entityHit', {
        targetId: u.id,
        shooter: 'player',
        damage: 250,
        pos: { x: u.body.px, y: 1, z: u.body.pz },
      });
    }
    for (let i = 0; i < 80; i++) {
      h.step(0.05, 0.05);
      mission.update(0.05);
      if (resultReport) break;
    }

    expect(h.team.aliveCount).toBe(0);
    expect(resultReport).not.toBeNull();
    expect(resultFailed).toBe(false);
    mission.dispose();
  });

  it('Scenario 3 (F6 + F8 + F12): Multi-Door House Siege with Simultaneous Stack, Radio Countdown & C2 Breach', () => {
    const map = makeTwoDoorHouseMap({ southLocked: true, northLocked: true });
    const h = track(
      createSwatHarness({
        map,
        spawns: [
          { x: -0.8, y: 0, z: 7.5 },
          { x: 0.8, y: 0, z: 7.5 },
          { x: -0.8, y: 0, z: -7.5 },
          { x: 0.8, y: 0, z: -7.5 },
        ],
        count: 4,
        playerPos: { x: 0, y: 0, z: 3.5 },
        startAssault: true,
      }),
    );

    h.step(60, 0.05);
    expect(h.recorder.count('c2Beep')).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('allyRadio')).toBeGreaterThanOrEqual(2);
    expect(h.hw.doorSystem.doors.find((d) => d.id === 'door_south')!.locked).toBe(false);
  });

  it('Scenario 4 (F9 + F10 + F5): Fortified-Window Holdout Broken by Barricade Destruction & CS Gas', async () => {
    const gasMod = await loadOptionalModule<TearGasModule>('../../../src/weapons/TearGas');
    expect(gasMod, 'src/weapons/TearGas.ts must exist in M3').toBeDefined();
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
    team.attachBarricades!({
      listBoarded: () =>
        hp > 0
          ? [{ id: 'win_0', center: { x: 4, y: 1.55, z: 0 }, normal: { x: 1, y: 0, z: 0 }, floorY: 0, hp, boarded: true }]
          : [],
    });
    h.bus.on('bulletImpact', (e) => {
      if (Math.hypot(e.pos.x - 4, e.pos.z) < 1.2) {
        hp = Math.max(0, hp - e.damage);
        if (hp <= 0) {
          plankCol.aabb.min.y = -1000;
          plankCol.aabb.max.y = -999.99;
        }
      }
    });
    h.bus.emit('noise', { pos: { x: 0, y: 0, z: 0 }, radius: 20, kind: 'gunshot', source: 'player' });
    h.step(5.0, 0.05);
    expect(hp).toBe(0);

    // Follow up with CS gas canister through breached window
    const GasCtor = (gasMod!.TearGas ?? gasMod!.default)!;
    const gas = new GasCtor(h.hw.colliders, h.bus, 3.0);
    gas.throwFrom({ x: 5.5, y: 1.5, z: 0 }, { x: -7, y: 1, z: 0 }, 'swat_1', 0.4);
    for (let i = 0; i < 15; i++) gas.update(0.05);
    expect(h.recorder.count('gasDetonated')).toBeGreaterThanOrEqual(1);
    gas.dispose();
  });

  it('Scenario 5 (F1 + F2 + F3 + F7): Low-HP / Reload Vulnerability Rush Under Pincer Flank', () => {
    const map = makeTwoDoorHouseMap({ includeInteriorDivider: false });
    const h = track(
      createSwatHarness({
        map,
        spawns: [
          { x: 0, y: 0, z: 3.2 },
          { x: 1.0, y: 0, z: 3.2 },
          { x: -1.2, y: 0, z: 6.5 },
          { x: 1.2, y: 0, z: 6.5 },
        ],
        count: 4,
        playerPos: { x: 0, y: 0, z: 0 },
        playerHp: 38,
        startAssault: true,
      }),
    );

    const blueInitZ = h.team.hunters[2]!.body.pz;
    expect(blueInitZ).toBeGreaterThan(5.0);
    h.step(2.5, 0.05);
    // Player reloads while pinned by Red from South and flanked by Blue
    h.bus.emit('noise', { pos: { x: 0, y: 0, z: 0 }, radius: 14, kind: 'reload', source: 'player' });
    let sawRush = false;
    for (let i = 0; i < 80; i++) {
      h.step(0.05, 0.05);
      if (h.team.hunters.some((u) => u.state === 'rush')) sawRush = true;
    }
    expect(h.recorder.count('shotFired')).toBeGreaterThanOrEqual(1);
    expect(sawRush).toBe(true);
    // Blue actively moved northward from the shared South spawn toward the flank
    expect(h.team.hunters[2]!.body.pz).toBeLessThan(blueInitZ - 1.5);
  });

  it('Scenario 6 (F13 + F4 + F6): Reinforcement Wave Survival vs. Repelled Victory Gate', () => {
    const h = track(
      createSwatHarness({
        map: makeTwoDoorHouseMap(),
        spawns: [
          { x: 0, y: 0, z: 7 },
          { x: 1, y: 0, z: 7 },
        ],
        count: 2,
        startAssault: true,
        reinforcements: true,
        urlSearch: '?mode=suspect&waves=1',
      }),
    );
    const team = h.team as SwatTeamWithM2M3;
    expect(team.hasPendingReinforcements).toBe(true);

    let ended = false;
    const interaction = new Interaction(createHeadlessInput(), 100);
    const entities = { civilians: new Map(), suspects: new Map() } as unknown as EntityManager;
    const mission = new SuspectMission(
      h.team,
      h.player as unknown as PlayerController,
      entities,
      h.hw.doors,
      createHeadlessInput(),
      h.subtitle,
      h.bus,
      interaction,
      () => {
        ended = true;
      },
    );

    // Wipe wave 1
    for (const u of [...h.team.hunters]) {
      h.bus.emit('entityHit', { targetId: u.id, shooter: 'player', damage: 250, pos: { x: u.body.px, y: 1, z: u.body.pz } });
    }
    for (let i = 0; i < 60; i++) {
      h.step(0.05, 0.05);
      mission.update(0.05);
    }
    // Must spawn wave 2 instead of ending prematurely
    expect(ended).toBe(false);
    expect(h.team.aliveCount).toBeGreaterThanOrEqual(2);

    // Wipe remaining waves until no pending reinforcements -> repelled victory unlocks
    for (let guard = 0; guard < 5 && !ended; guard++) {
      for (const u of [...h.team.hunters]) {
        if (u.alive) {
          h.bus.emit('entityHit', { targetId: u.id, shooter: 'player', damage: 250, pos: { x: u.body.px, y: 1, z: u.body.pz } });
        }
      }
      for (let i = 0; i < 80; i++) {
        h.step(0.05, 0.05);
        mission.update(0.05);
        if (ended) break;
      }
    }
    expect(ended).toBe(true);
    mission.dispose();
  });

  it('Scenario 7 (F11 + F12 + F1): Dark Corridor Approach with Clipped Laser/Flashlight Beams & Tactical Audio', () => {
    const idx = ColliderIndex as unknown as ColliderIndexContract;
    expect(typeof idx.raycastColliders).toBe('function');

    const h = track(
      createSwatHarness({
        map: makeSingleRoomMap({ includeCover: false }),
        spawns: [{ x: 0, y: 0, z: 6.5 }],
        count: 1,
        playerPos: { x: 0, y: 0, z: -2.5 },
        startAssault: true,
      }),
    );

    const audioCalls: string[] = [];
    const sink = new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          audioCalls.push(String(prop));
        },
      },
    ) as unknown as AudioBridgeSink;
    const bridge = new AudioBridge(h.bus, sink, h.player, h.hw.colliders);

    const countLights = (root: THREE.Object3D): number => {
      let n = 0;
      root.traverse((obj) => {
        if ((obj as THREE.Light).isLight) n++;
      });
      return n;
    };
    const lightsBefore = countLights(h.team.root);
    expect(lightsBefore).toBeLessThanOrEqual(1);

    h.step(4.5, 0.05);
    // 1. Zero dynamic Three.js lights added by SWAT beams (<=1 pre-allocated c2BlastLight allowed, 0 on body.group)
    const lightsAfter = countLights(h.team.root);
    expect(lightsAfter).toBe(lightsBefore);
    expect(lightsAfter).toBeLessThanOrEqual(1);
    for (const u of h.team.hunters) {
      expect(countLights(u.body.group)).toBe(0);
    }
    let additiveBeams = 0;
    h.team.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        const mat = mesh.material as THREE.MeshBasicMaterial;
        if (mat && mat.isMeshBasicMaterial && mat.blending === THREE.AdditiveBlending && mat.depthWrite === false) {
          additiveBeams++;
        }
      }
    });
    expect(additiveBeams).toBeGreaterThanOrEqual(1);
    // 2. Heavy footsteps emitted and routed to audio without self-alert loop
    expect(h.recorder.count('swatFootstep')).toBeGreaterThanOrEqual(1);
    expect(audioCalls.some((m) => m === 'playSwatFootstep' || m === 'playFootstep')).toBe(true);
    bridge.dispose();
  });

  it('Scenario 8 (F10 + F3 + PepperEffect): Dual-Status Pepper + CS Gas Holdout Degradation & Recovery', async () => {
    const effMod = await loadOptionalModule<TearGasEffectModule>('../../../src/player/TearGasEffect');
    expect(effMod, 'src/player/TearGasEffect.ts must exist in M3').toBeDefined();
    const GasEffCtor = (effMod!.TearGasEffect ?? effMod!.default)!;

    const h = track(
      createSwatHarness({
        map: makeSingleRoomMap(),
        spawns: [{ x: 0, y: 0, z: 3.0 }],
        count: 1,
        playerPos: { x: 0, y: 0, z: -1.5 },
        startAssault: true,
      }),
    );
    const pepper = new PepperEffect(
      h.player as unknown as PlayerController,
      h.weapons as unknown as WeaponSystem,
      h.subtitle,
      h.dom.canvas,
    );
    let exposure = 1.0;
    const gasEffect = new GasEffCtor(h.player, h.weapons, { exposureAt: () => exposure }, h.subtitle, h.bus);

    // Apply both pepper hit and CS gas exposure simultaneously
    pepper.hit();
    pepper.hit();
    for (let i = 0; i < 40; i++) {
      h.player.speedMultiplier = 1;
      h.weapons.extraSpread = 0;
      pepper.update(0.05);
      gasEffect.update(0.05);
    }
    expect(h.player.speedMultiplier).toBeLessThan(0.75);
    expect(h.weapons.extraSpread).toBeGreaterThan(2.0);
    expect(h.dom.canvas.style.filter).toContain('blur');

    // Leave gas cloud & wait for both pepper and gas to decay cleanly
    exposure = 0;
    for (let i = 0; i < 400; i++) {
      h.player.speedMultiplier = 1;
      h.weapons.extraSpread = 0;
      pepper.update(0.05);
      gasEffect.update(0.05);
    }
    expect(h.player.speedMultiplier).toBeCloseTo(1.0, 2);
    expect(h.weapons.extraSpread).toBeCloseTo(0, 2);
    expect(SWAT_COMBAT.flinchSec).toBeGreaterThan(0);
    expect(PRESSURE_RAMP_SEC).toBeLessThanOrEqual(100);

    gasEffect.dispose();
    pepper.dispose();
  });
});
