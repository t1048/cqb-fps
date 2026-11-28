import { afterEach, describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../src/core/events';
import * as ColliderIndex from '../../src/world/ColliderIndex';
import { HumanoidBody } from '../../src/ai/HumanoidBody';
import { AudioBridge, type AudioBridgeSink } from '../../src/core/AudioBridge';
import { radioVoiceProfile } from '../../src/core/Audio';
import { BriefingScreen } from '../../src/ui/BriefingScreen';
import type { Collider } from '../../src/world/WorldBuilder';
import { makeSingleRoomMap } from './helpers/headlessWorld';
import { installDomShim, restoreDomShim } from './helpers/domShim';
import { createHeadlessPlayer, createSwatHarness, type SwatHarness } from './helpers/simDriver';
import {
  emitContractEvent,
  loadOptionalModule,
  type BriefingOptionsWithM3,
  type ColliderIndexContract,
  type HumanoidBodyWithMuzzle,
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

describe('Tier 2 — M3 Boundary & Corner Cases (F10–F13)', () => {
  // =========================================================================
  // F10 Boundaries
  // =========================================================================
  describe('F10 Boundaries: Tear Gas (CS Gas) & Anti-Camping', () => {
    it('F10.B1: TearGas cloud dissipates completely after its duration expires', async () => {
      const mod = await loadOptionalModule<TearGasModule>('../../../src/weapons/TearGas');
      expect(mod, 'src/weapons/TearGas.ts must exist in M3').toBeDefined();
      const Ctor = (mod!.TearGas ?? mod!.default)!;
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 3 }],
          count: 1,
          startAssault: false,
        }),
      );
      const gas = new Ctor(h.hw.colliders, h.bus, 3.0);
      gas.throwFrom({ x: 0, y: 1.4, z: 3 }, { x: 0, y: 0.5, z: -2 }, 'swat_1', 0.2);
      // Advance 30 seconds — cloud must dissipate
      for (let i = 0; i < 600; i++) gas.update(0.05);
      const density = gas.sampleDensity?.({ x: 0, y: 1.0, z: 2.5 }) ?? gas.densityAt?.({ x: 0, y: 1.0, z: 2.5 }) ?? 0;
      expect(density).toBe(0);
      gas.dispose();
    });

    it('F10.B2: Player standing outside CS gas radius receives zero gas density', async () => {
      const mod = await loadOptionalModule<TearGasModule>('../../../src/weapons/TearGas');
      expect(mod, 'src/weapons/TearGas.ts must exist in M3').toBeDefined();
      const Ctor = (mod!.TearGas ?? mod!.default)!;
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 3 }],
          count: 1,
          startAssault: false,
        }),
      );
      const gas = new Ctor(h.hw.colliders, h.bus, 3.0);
      gas.throwFrom({ x: 0, y: 1.0, z: 0 }, { x: 0, y: 0, z: 0 }, 'swat_1', 0.1);
      for (let i = 0; i < 6; i++) gas.update(0.05);
      const farDensity = gas.sampleDensity?.({ x: 15, y: 1.0, z: 15 }) ?? gas.densityAt?.({ x: 15, y: 1.0, z: 15 }) ?? 0;
      expect(farDensity).toBe(0);
      gas.dispose();
    });

    it('F10.B3: TearGasEffect decays smoothly back to 0 when player exits gas cloud', async () => {
      const mod = await loadOptionalModule<TearGasEffectModule>('../../../src/player/TearGasEffect');
      expect(mod, 'src/player/TearGasEffect.ts must exist in M3').toBeDefined();
      const Ctor = (mod!.TearGasEffect ?? mod!.default)!;
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 5 }],
          count: 1,
          startAssault: false,
        }),
      );
      let exposure = 1.0;
      const effect = new Ctor(h.player, h.weapons, { exposureAt: () => exposure }, h.subtitle, h.bus);
      for (let i = 0; i < 40; i++) effect.update(0.05);
      // Leave cloud (exposure = 0)
      exposure = 0;
      for (let i = 0; i < 300; i++) {
        h.player.speedMultiplier = 1;
        h.weapons.extraSpread = 0;
        effect.update(0.05);
      }
      expect(h.player.speedMultiplier).toBeCloseTo(1.0, 2);
      expect(h.weapons.extraSpread).toBeCloseTo(0, 2);
      effect.dispose();
    });

    it('F10.B4: Dead player clears TearGasEffect immediately without coughing', async () => {
      const mod = await loadOptionalModule<TearGasEffectModule>('../../../src/player/TearGasEffect');
      expect(mod, 'src/player/TearGasEffect.ts must exist in M3').toBeDefined();
      const Ctor = (mod!.TearGasEffect ?? mod!.default)!;
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 5 }],
          count: 1,
          startAssault: false,
        }),
      );
      const effect = new Ctor(h.player, h.weapons, { exposureAt: () => 1.0 }, h.subtitle, h.bus);
      h.player.takeDamage(200);
      h.recorder.clear();
      for (let i = 0; i < 30; i++) effect.update(0.05);
      expect(h.recorder.count('playerCough')).toBe(0);
      effect.dispose();
    });

    it('F10.B5: Disposing TearGas clears active clouds and ignores subsequent update/throwFrom calls', async () => {
      const mod = await loadOptionalModule<TearGasModule>('../../../src/weapons/TearGas');
      expect(mod, 'src/weapons/TearGas.ts must exist in M3').toBeDefined();
      const Ctor = (mod!.TearGas ?? mod!.default)!;
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 3 }],
          count: 1,
          startAssault: false,
        }),
      );
      const gas = new Ctor(h.hw.colliders, h.bus, 3.0);
      gas.dispose();
      expect(() => {
        gas.throwFrom({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, 'swat_1', 0.1);
        gas.update(0.05);
      }).not.toThrow();
    });
  });

  // =========================================================================
  // F11 Boundaries
  // =========================================================================
  describe('F11 Boundaries: Tactical Laser & Flashlight Beams', () => {
    it('F11.B1: raycastColliders returns maxDist when no collider intersects the ray', () => {
      const idx = ColliderIndex as unknown as ColliderIndexContract;
      expect(typeof idx.raycastColliders).toBe('function');
      const d = idx.raycastColliders!([], { x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 15);
      expect(d).toBe(15);
    });

    it('F11.B2: raycastColliders ignores colliders strictly behind the ray origin', () => {
      const idx = ColliderIndex as unknown as ColliderIndexContract;
      expect(typeof idx.raycastColliders).toBe('function');
      const behindWall: Collider = {
        kind: 'wall',
        aabb: { min: { x: -2, y: 0, z: 2.0 }, max: { x: 2, y: 3, z: 2.2 } },
      };
      const d = idx.raycastColliders!([behindWall], { x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 12);
      expect(d).toBe(12);
    });

    it('F11.B3: raycastColliders handles maxDist <= 0 safely without NaN', () => {
      const idx = ColliderIndex as unknown as ColliderIndexContract;
      expect(typeof idx.raycastColliders).toBe('function');
      const d = idx.raycastColliders!([], { x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 0);
      expect(d).toBe(0);
    });

    it('F11.B4: Unarmed HumanoidBody.getMuzzlePose returns false cleanly', () => {
      const unarmed = new HumanoidBody(0, 0, 0, 0x4d6072, false, { role: 'civilian' }) as HumanoidBodyWithMuzzle;
      expect(typeof unarmed.getMuzzlePose).toBe('function');
      const o = { x: 0, y: 0, z: 0 };
      const d = { x: 0, y: 0, z: 0 };
      expect(unarmed.getMuzzlePose!(o, d)).toBe(false);
      unarmed.dispose();
    });

    it('F11.B5: Downed SWAT unit hides its laser/flashlight beam meshes', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 3 }],
          count: 1,
          startAssault: true,
        }),
      );
      h.step(0.2, 0.05);
      h.bus.emit('entityHit', { targetId: 'swat_1', shooter: 'player', damage: 200, pos: { x: 0, y: 1, z: 3 } });
      h.step(0.2, 0.05);
      // Verify getMuzzlePose or beam mesh visibility is turned off on dead SWAT
      const idx = ColliderIndex as unknown as ColliderIndexContract;
      expect(typeof idx.raycastColliders).toBe('function');
      let visibleBeams = 0;
      h.team.root.traverse((obj) => {
        const m = obj as import('three').Mesh;
        if (!m.isMesh) return;
        const mat = m.material as import('three').MeshBasicMaterial;
        if (mat && mat.isMeshBasicMaterial && mat.depthWrite === false && m.visible) visibleBeams++;
      });
      expect(visibleBeams).toBe(0);
    });
  });

  // =========================================================================
  // F12 Boundaries
  // =========================================================================
  describe('F12 Boundaries: Tactical Radio Chatter & Stack/C2 Audio', () => {
    it('F12.B1: swatFootstep routes to AudioBridge sink while SwatTeam.onNoise ignores it (no self-alert loop)', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -3 },
          startAssault: true,
        }),
      );
      const calls: string[] = [];
      const sink = new Proxy(
        {},
        {
          get: (_t, prop) => () => {
            calls.push(String(prop));
          },
        },
      ) as unknown as AudioBridgeSink;
      const bridge = new AudioBridge(h.bus, sink, h.player, h.hw.colliders);
      h.step(0.1, 0.05);
      emitContractEvent(h.bus, 'swatFootstep', { pos: { x: 0, y: 0, z: 6 }, heavy: true });
      h.step(0.1, 0.05);
      // AudioBridge MUST route swatFootstep to audio sink
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // SwatTeam MUST NOT set huntTarget to own footstep position
      expect(h.team.hunters[0]!.huntTarget).toBeNull();
      bridge.dispose();
    });

    it('F12.B2: Active AudioBridge routes M2/M3 events and stops routing all of them after dispose()', () => {
      const bus = createGameEventBus();
      const player = createHeadlessPlayer();
      let called = 0;
      const sink = new Proxy(
        {},
        {
          get: () => () => {
            called++;
          },
        },
      ) as unknown as AudioBridgeSink;
      const bridge = new AudioBridge(bus, sink, player, []);

      // Positive control BEFORE dispose: all 5 M2/M3 events must be routed
      emitContractEvent(bus, 'c2Beep', { pos: { x: 0, y: 0, z: 0 }, urgent: false });
      emitContractEvent(bus, 'c2Detonated', {
        doorId: 'd1',
        pos: { x: 0, y: 1, z: 0 },
        dir: { x: 0, y: 0, z: -1 },
        radius: 5,
      });
      emitContractEvent(bus, 'gasDetonated', { pos: { x: 0, y: 0, z: 0 }, radius: 4 });
      emitContractEvent(bus, 'playerCough', { pos: { x: 0, y: 0, z: 0 } });
      emitContractEvent(bus, 'swatFootstep', { pos: { x: 0, y: 0, z: 0 }, heavy: true });
      expect(called).toBeGreaterThanOrEqual(5);

      // After dispose: zero calls for any of the 5 events
      called = 0;
      bridge.dispose();
      emitContractEvent(bus, 'c2Beep', { pos: { x: 0, y: 0, z: 0 }, urgent: false });
      emitContractEvent(bus, 'c2Detonated', {
        doorId: 'd1',
        pos: { x: 0, y: 1, z: 0 },
        dir: { x: 0, y: 0, z: -1 },
        radius: 5,
      });
      emitContractEvent(bus, 'gasDetonated', { pos: { x: 0, y: 0, z: 0 }, radius: 4 });
      emitContractEvent(bus, 'playerCough', { pos: { x: 0, y: 0, z: 0 } });
      emitContractEvent(bus, 'swatFootstep', { pos: { x: 0, y: 0, z: 0 }, heavy: true });
      expect(called).toBe(0);
    });

    it('F12.B3: AudioBridge routes valid finite M2/M3 events and safely drops non-finite NaN/Infinity coordinates', () => {
      const bus = createGameEventBus();
      const player = createHeadlessPlayer();
      let called = 0;
      const sink = new Proxy(
        {},
        {
          get: () => () => {
            called++;
          },
        },
      ) as unknown as AudioBridgeSink;
      const bridge = new AudioBridge(bus, sink, player, []);

      // Positive control: finite coordinates route cleanly
      emitContractEvent(bus, 'c2Beep', { pos: { x: 1, y: 1, z: 1 }, urgent: true });
      emitContractEvent(bus, 'gasDetonated', { pos: { x: 1, y: 1, z: 1 }, radius: 4 });
      expect(called).toBeGreaterThanOrEqual(2);

      // Negative control: NaN / Infinity coordinates must NOT throw AND must NOT invoke sink
      called = 0;
      expect(() => {
        emitContractEvent(bus, 'c2Beep', { pos: { x: Number.NaN, y: 0, z: 0 }, urgent: true });
        emitContractEvent(bus, 'c2Detonated', {
          doorId: 'd1',
          pos: { x: Number.NaN, y: 0, z: 0 },
          dir: { x: 0, y: 0, z: -1 },
          radius: 4,
        });
        emitContractEvent(bus, 'gasDetonated', { pos: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 }, radius: 4 });
        emitContractEvent(bus, 'playerCough', { pos: { x: 0, y: Number.NEGATIVE_INFINITY, z: 0 } });
        emitContractEvent(bus, 'swatFootstep', { pos: { x: 0, y: 0, z: Number.NaN }, heavy: true });
      }).not.toThrow();
      expect(called).toBe(0);
      bridge.dispose();
    });

    it('F12.B4: SwatTeam emits swatFootstep only when moving (silent while stationary in staging)', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          startAssault: false,
        }),
      );
      h.step(2.0, 0.05);
      expect(h.recorder.count('swatFootstep')).toBe(0);
      // Also assert M3 swatFootstep is implemented when moving
      h.team.beginAssault();
      h.step(2.0, 0.05);
      expect(h.recorder.count('swatFootstep')).toBeGreaterThanOrEqual(1);
    });

    it('F12.B5: Cell-distinct radio voices assign different speechSynthesis pitch/rate per cell (Red vs Blue)', () => {
      const dom = installDomShim();
      const bus = createGameEventBus();
      const player = createHeadlessPlayer();
      const sink = new Proxy(
        {
          playAllyRadio(allyId: string, text: string) {
            const profile = radioVoiceProfile(allyId);
            const utter = new SpeechSynthesisUtterance(text);
            utter.pitch = profile.pitch;
            utter.rate = profile.rate;
            window.speechSynthesis.speak(utter);
          },
        },
        {
          get(target, prop) {
            if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
            return () => {};
          },
        },
      ) as unknown as AudioBridgeSink;
      const bridge = new AudioBridge(bus, sink, player, []);
      bus.emit('allyRadio', { allyId: 'swat_1', name: 'SWAT無線(傍受) Red-1', text: 'Red配置', voiceText: 'Red in position' });
      bus.emit('allyRadio', { allyId: 'swat_3', name: 'SWAT無線(傍受) Blue-1', text: 'Blue配置', voiceText: 'Blue in position' });
      expect(dom.speechLog.length).toBeGreaterThanOrEqual(2);
      const red = dom.speechLog[0]!;
      const blue = dom.speechLog[1]!;
      expect(red.pitch !== blue.pitch || red.rate !== blue.rate).toBe(true);
      bridge.dispose();
    });
  });

  // =========================================================================
  // F13 Boundaries: 増援ウェーブは廃止
  // =========================================================================
  describe('F13 Boundaries: Reinforcement Waves Removed', () => {
    it('F13.B1: SwatTeam exposes no reinforcement API and never grows past the initial team', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          startAssault: true,
        }),
      );
      const team = h.team as unknown as Record<string, unknown>;
      for (const key of ['hasPendingReinforcements', 'spawnReinforcements', 'checkReinforcements', 'reinforcementWavesSpawned']) {
        expect(key in team, key).toBe(false);
      }
      const before = h.team.total;
      h.step(10, 0.05);
      expect(h.team.total).toBe(before);
    });
  });
});
