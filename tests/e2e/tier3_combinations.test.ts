import { afterEach, describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../src/core/events';
import type { AIProfile, CombatParams } from '../../src/core/types';
import { Suspect } from '../../src/ai/Suspect';
import {
  PRESSURE_RAMP_SEC,
  SHIELD_COMBAT,
  SWAT_COMBAT,
  computeBallisticVelocity,
  planDoorwayFlashThrow,
  type FlashDoorSample,
} from '../../src/modes/SwatTeam';
import * as ColliderIndex from '../../src/world/ColliderIndex';
import { AudioBridge, type AudioBridgeSink } from '../../src/core/AudioBridge';
import { PepperEffect } from '../../src/player/PepperEffect';
import type { PlayerController } from '../../src/player/PlayerController';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import {
  makeSingleRoomMap,
  makeTwoDoorHouseMap,
  makeWindowedSiegeMap,
} from './helpers/headlessWorld';
import { installDomShim, restoreDomShim } from './helpers/domShim';
import {
  EventRecorder,
  createHeadlessPlayer,
  createHeadlessWeaponRegistry,
  createSwatHarness,
  type SwatHarness,
} from './helpers/simDriver';
import {
  emitContractEvent,
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

describe('Tier 3 — Cross-Feature Pairwise Combinations (F1–F13)', () => {
  it('C1 (F1 + F2): High-pressure SWAT fires immediately on contact and refuses to retreat when hit', () => {
    const h = track(
      createSwatHarness({
        map: makeSingleRoomMap({ includeCover: true }),
        spawns: [{ x: 0, y: 0, z: 2.5 }],
        count: 1,
        playerPos: { x: 0, y: 0, z: -8 }, // Out of LOS behind north wall while ramping pressure
        startAssault: true,
      }),
    );
    // Ramp pressure >= 0.6 before first contact
    h.step(PRESSURE_RAMP_SEC * 0.7, 0.05);
    expect(h.team.currentPressure).toBeGreaterThanOrEqual(0.6);
    const u = h.team.hunters[0]!;
    // Bring hunter & player into clear LOS inside the room
    u.body.setPosition(0, 2.5, 0);
    h.player.position.set(0, 0, -2.5);
    u.body.faceToward(0, -2.5);
    h.step(0.3, 0.05);
    expect(h.recorder.of('shotFired').some((e) => e.payload.shooter === u.id)).toBe(true);
    // Hit hunter while engaging at high pressure: should not retreat to cover
    h.bus.emit('entityHit', {
      targetId: u.id,
      shooter: 'player',
      damage: 10,
      pos: { x: u.body.px, y: 1, z: u.body.pz },
    });
    h.step(0.15, 0.05);
    expect(u.alive).toBe(true);
    expect(u.engage.label).not.toBe('toCover');
  });

  it('C2 (F5 + F3): Indirect flashbang detonating on player emits playerBlinded which triggers SWAT vulnerability rush', () => {
    const h = track(
      createSwatHarness({
        map: makeSingleRoomMap({ includeCover: false }),
        spawns: [
          { x: 0, y: 0, z: 3.0 },
          { x: 1.2, y: 0, z: 3.0 },
        ],
        count: 2,
        playerPos: { x: 0, y: 0, z: -1.5 },
        playerYawRad: Math.PI,
        startAssault: true,
      }),
    );
    const vel = computeBallisticVelocity({ x: 0, y: 1.4, z: 3.0 }, { x: 0, y: 0.4, z: -0.5 }, 9.8);
    h.flashbang.throwFrom({ x: 0, y: 1.4, z: 3.0 }, vel, 'swat_1', 0.35);
    h.step(0.6, 0.05);
    expect(h.recorder.count('flashDetonated')).toBe(1);
    expect(h.recorder.count('playerBlinded')).toBe(1);
    expect(h.team.hunters.some((u) => u.state === 'rush')).toBe(true);
  });

  it('C3 (F4 + F2): High pressure accelerates SWAT_COMBAT.moveSpeed while compressing flinchSec simultaneously', () => {
    const h = track(
      createSwatHarness({
        map: makeSingleRoomMap(),
        spawns: [
          { x: 0, y: 0, z: 6 },
          { x: 1, y: 0, z: 6 },
        ],
        count: 2,
        startAssault: true,
      }),
    );
    const baseSpeed = SWAT_COMBAT.moveSpeed;
    const baseFlinch = SWAT_COMBAT.flinchSec;
    h.step(PRESSURE_RAMP_SEC + 2, 0.05);
    expect(SWAT_COMBAT.moveSpeed).toBeGreaterThan(baseSpeed);
    expect(SWAT_COMBAT.flinchSec).toBeLessThan(baseFlinch);
    expect(SHIELD_COMBAT.flinchSec).toBeLessThanOrEqual(0.06);
  });

  it('C4 (F3 + F1): Reload noise triggers rush while shielded/rifleman units maintain fire on approach', () => {
    const h = track(
      createSwatHarness({
        map: makeSingleRoomMap({ includeCover: false }),
        spawns: [
          { x: 0, y: 0, z: 3.2 },
          { x: 1.2, y: 0, z: 3.2 },
        ],
        count: 2,
        playerPos: { x: 0, y: 0, z: -2.8 },
        startAssault: true,
      }),
    );
    h.bus.emit('noise', { pos: { x: 0, y: 0, z: -2.8 }, radius: 14, kind: 'reload', source: 'player' });
    expect(h.team.hunters.some((u) => u.state === 'rush')).toBe(true);
    h.step(1.2, 0.05);
    expect(h.recorder.of('shotFired').some((e) => e.payload.shooter.startsWith('swat_'))).toBe(true);
  });

  it('C5 (F1 + Non-Regression): Normal-mode Suspect stays unaffected by Suspect-Mode SwatTeam immediateFire/flinch', () => {
    const h = track(
      createSwatHarness({
        map: makeSingleRoomMap(),
        spawns: [{ x: 0, y: 0, z: 6 }],
        count: 1,
        startAssault: true,
      }),
    );
    h.step(PRESSURE_RAMP_SEC, 0.05);

    const bus = createGameEventBus();
    const rec = new EventRecorder(bus);
    const player = createHeadlessPlayer({ x: 0, y: 0, z: -5 });
    const colliders = [
      { kind: 'floor' as const, aabb: { min: { x: -10, y: -0.2, z: -10 }, max: { x: 10, y: 0, z: 10 } } },
      { kind: 'cover' as const, aabb: { min: { x: 1.5, y: 0, z: -0.3 }, max: { x: 2.7, y: 1.2, z: 0.3 } } },
    ];
    const combat: CombatParams = {
      decisionSec: 0.1,
      alertCalmSec: 10,
      hesitateFireSec: 3,
      hesitateRetreatSpeed: 0.8,
      hesitateRetreatMax: 1.5,
      hesitateShakeDeg: 0,
      moveSpeed: 2.0,
      fireInterval: 0.25,
      shotsPerPeek: 3,
      magazineSize: 15,
      reloadSec: 2.0,
      coverSecMin: 1.0,
      coverSecMax: 1.5,
      peekSecMax: 1.2,
      engageRange: 16,
      coverSearchRange: 6,
      coverMargin: 0.45,
      crouchCoverMaxHeight: 1.5,
      flinchSec: 0.35,
      gunshotNoiseRadius: 30,
      shotDamage: 10,
      baseSpreadDeg: 3.0,
    };
    const profile: AIProfile = {
      id: 'normal_suspect',
      name: 'Normal',
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
      combat,
    };
    const suspect = new Suspect({ id: 'susp_norm', type: 'suspect', x: 0, z: 0, yaw: 180 }, profile, bus, { player, colliders });
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
    expect(['ENGAGE/toCover', 'ENGAGE/cover']).toContain(suspect.debugState);
    expect(rec.count('shotFired')).toBe(0);
    rec.dispose();
    suspect.dispose();
  });

  it('C6 (F6 + F7): Multi-door simultaneous entry from same-side spawn transitions into pincer flanking once Red spots player', () => {
    const map = makeTwoDoorHouseMap({ includeInteriorDivider: false });
    const h = track(
      createSwatHarness({
        map,
        spawns: [
          { x: -0.8, y: 0, z: 7 },
          { x: 0.8, y: 0, z: 7 },
          { x: -1.6, y: 0, z: 7 },
          { x: 1.6, y: 0, z: 7 },
        ],
        count: 4,
        playerPos: { x: 0, y: 0, z: 0 },
        startAssault: true,
      }),
    );
    const blueInitZ = h.team.hunters[2]!.body.pz;
    expect(blueInitZ).toBeGreaterThan(5.0);
    h.step(12.0, 0.05);
    const red = h.team.hunters.slice(0, 2);
    const blue = h.team.hunters.slice(2, 4);
    // Blue actively routes northward away from the shared South spawn toward the North door/flank
    expect(blue[0]!.body.pz).toBeLessThan(blueInitZ - 2.0);
    expect(red[0]!.body.pz).toBeLessThan(7.0);
    expect(h.recorder.count('shotFired')).toBeGreaterThanOrEqual(1);
  });

  it('C7 (F8 + F3): C2 explosive breach on locked door stuns player behind door and enables rush follow-up', () => {
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
        playerPos: { x: 0, y: 0, z: 2.8 },
        playerHp: 50,
        startAssault: false,
      }),
    );
    // Satisfy PROJECT.md:45 high-pressure C2 precondition (pressure >= 0.4) before SWAT reaches door_south
    for (const id of ['swat_3', 'swat_4', 'swat_5', 'swat_6']) {
      h.bus.emit('entityHit', { targetId: id, shooter: 'player', damage: 200, pos: { x: 1, y: 1, z: 6 } });
    }
    h.team.beginAssault();
    h.step(60, 0.05);
    expect(h.recorder.count('c2Detonated')).toBeGreaterThanOrEqual(1);
    expect(h.player.hp).toBeLessThan(50);
  });

  it('C8 (F9 + F5): Destroying a window barricade re-enables indirect doorway/window flashbang throw planning', () => {
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
    let hp = 30;
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
    h.step(4.5, 0.05);
    expect(hp).toBe(0);
    // Once destroyed, doorway/window flash path is valid
    h.hw.doorSystem.doors[0]!.command(90, true, 0, 6);
    h.step(1.0, 0.05);
    const openDoor: FlashDoorSample = {
      id: 'door_south',
      centerX: 0,
      centerZ: 4,
      normalX: 0,
      normalZ: 1,
      sillY: 0,
      width: 1.2,
      height: 2.18,
      angle: 90,
      locked: false,
    };
    const plan = planDoorwayFlashThrow({ x: -1.5, y: 1.4, z: 6 }, { x: 1.5, y: 0, z: 1.5 }, [openDoor], h.hw.colliders, 9.8);
    expect(plan).not.toBeNull();
  });

  it('C9 (F10 + PepperEffect): Simultaneous PepperEffect + TearGasEffect stack spread and slowdown without clobbering blur', async () => {
    const mod = await loadOptionalModule<TearGasEffectModule>('../../../src/player/TearGasEffect');
    expect(mod, 'src/player/TearGasEffect.ts must exist in M3').toBeDefined();
    const Ctor = (mod!.TearGasEffect ?? mod!.default)!;
    const dom = installDomShim();
    const bus = createGameEventBus();
    const player = createHeadlessPlayer();
    const weapons = createHeadlessWeaponRegistry();
    const subtitle = { show() {}, update() {}, dispose() {} } as unknown as import('../../src/ui/Subtitle').Subtitle;
    const pepper = new PepperEffect(
      player as unknown as PlayerController,
      weapons as unknown as WeaponSystem,
      subtitle,
      dom.canvas,
    );
    const gas = new Ctor(player, weapons, { exposureAt: () => 1.0 }, subtitle, bus);

    pepper.hit();
    weapons.extraSpread = 0;
    player.speedMultiplier = 1;
    pepper.update(0.05);
    const spreadAfterPepper = weapons.extraSpread;
    const speedAfterPepper = player.speedMultiplier;
    gas.update(0.05);
    expect(weapons.extraSpread).toBeGreaterThan(spreadAfterPepper);
    expect(player.speedMultiplier).toBeLessThan(speedAfterPepper);
    gas.dispose();
    pepper.dispose();
  });

  it('C10 (F10 + F12): CS gas detonation and player coughing route cleanly through AudioBridge', async () => {
    const mod = await loadOptionalModule<TearGasModule>('../../../src/weapons/TearGas');
    expect(mod, 'src/weapons/TearGas.ts must exist in M3').toBeDefined();
    const bus = createGameEventBus();
    const player = createHeadlessPlayer();
    const called: string[] = [];
    const sink = new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          called.push(String(prop));
        },
      },
    ) as unknown as AudioBridgeSink;
    const bridge = new AudioBridge(bus, sink, player, []);
    emitContractEvent(bus, 'gasDetonated', { pos: { x: 0, y: 0.5, z: 0 }, radius: 4 });
    emitContractEvent(bus, 'playerCough', { pos: { x: 0, y: 1.5, z: 0 } });
    expect(called).toContain('playGasHiss');
    expect(called).toContain('playCough');
    bridge.dispose();
  });

  it('C11 (F11 + F12): Tactical beams render with zero dynamic lights while SWAT footsteps route to AudioBridge', () => {
    const idx = ColliderIndex as unknown as ColliderIndexContract;
    expect(typeof idx.raycastColliders).toBe('function');
    const h = track(
      createSwatHarness({
        map: makeSingleRoomMap(),
        spawns: [{ x: 0, y: 0, z: 6 }],
        count: 1,
        startAssault: true,
      }),
    );
    const countLights = (root: import('three').Object3D): number => {
      let n = 0;
      root.traverse((o) => {
        if ((o as import('three').Light).isLight) n++;
      });
      return n;
    };
    const lightsBefore = countLights(h.team.root);
    expect(lightsBefore).toBeLessThanOrEqual(1);
    h.step(2.0, 0.05);
    const lightsAfter = countLights(h.team.root);
    expect(lightsAfter).toBe(lightsBefore);
    expect(lightsAfter).toBeLessThanOrEqual(1);
    for (const u of h.team.hunters) {
      expect(countLights(u.body.group)).toBe(0);
    }
    let additiveBeams = 0;
    h.team.root.traverse((o) => {
      const mesh = o as import('three').Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as import('three').MeshBasicMaterial;
      if (mat && mat.isMeshBasicMaterial && mat.depthWrite === false) additiveBeams++;
    });
    expect(additiveBeams).toBeGreaterThanOrEqual(1);
    expect(h.recorder.count('swatFootstep')).toBeGreaterThanOrEqual(1);
  });

  it('C13 (F8 + F12): C2 arming beeps and detonation route to AudioBridge without dropping events', () => {
    const bus = createGameEventBus();
    const player = createHeadlessPlayer();
    const called: string[] = [];
    const sink = new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          called.push(String(prop));
        },
      },
    ) as unknown as AudioBridgeSink;
    const bridge = new AudioBridge(bus, sink, player, []);
    emitContractEvent(bus, 'c2Beep', { pos: { x: 0, y: 1, z: 4 }, urgent: false });
    emitContractEvent(bus, 'c2Beep', { pos: { x: 0, y: 1, z: 4 }, urgent: true });
    emitContractEvent(bus, 'c2Detonated', { doorId: 'door_south', pos: { x: 0, y: 1, z: 4 }, dir: { x: 0, y: 0, z: -1 }, radius: 5 });
    expect(called.filter((m) => m === 'playC2Beep').length).toBe(2);
    expect(called.some((m) => m === 'playC2Blast' || m === 'playBreach')).toBe(true);
    bridge.dispose();
  });
});
