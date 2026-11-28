import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../src/core/events';
import * as ColliderIndex from '../../src/world/ColliderIndex';
import { HumanoidBody } from '../../src/ai/HumanoidBody';
import { AudioBridge, type AudioBridgeSink } from '../../src/core/AudioBridge';
import { BriefingScreen } from '../../src/ui/BriefingScreen';
import { SuspectMission } from '../../src/modes/SuspectMode';
import { Interaction } from '../../src/player/Interaction';
import type { EntityManager } from '../../src/ai/EntityManager';
import type { PlayerController } from '../../src/player/PlayerController';
import type { Collider } from '../../src/world/WorldBuilder';
import { makeSingleRoomMap, makeTwoDoorHouseMap } from './helpers/headlessWorld';
import { installDomShim, restoreDomShim } from './helpers/domShim';
import {
  createHeadlessInput,
  createHeadlessPlayer,
  createSwatHarness,
  type SwatHarness,
} from './helpers/simDriver';
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

function countLightsInGraph(root: THREE.Object3D): number {
  let lights = 0;
  root.traverse((obj) => {
    if ((obj as THREE.Light).isLight) lights++;
  });
  return lights;
}

describe('Tier 1 — M3 Pressure, Visuals, Audio (F10–F13)', () => {
  // =========================================================================
  // F10: Tear Gas (CS Gas) & Anti-Camping (催涙ガスによる強制あぶり出し)
  // =========================================================================
  describe('F10: Tear Gas (CS Gas) & Anti-Camping', () => {
    it('F10.1: src/weapons/TearGas.ts module exists and exports TearGas class', async () => {
      const mod = await loadOptionalModule<TearGasModule>('../../../src/weapons/TearGas');
      expect(mod, 'src/weapons/TearGas.ts must exist in M3').toBeDefined();
      const Ctor = mod!.TearGas ?? mod!.default;
      expect(typeof Ctor).toBe('function');
    });

    it('F10.2: src/player/TearGasEffect.ts module exists and exports TearGasEffect class', async () => {
      const mod = await loadOptionalModule<TearGasEffectModule>('../../../src/player/TearGasEffect');
      expect(mod, 'src/player/TearGasEffect.ts must exist in M3').toBeDefined();
      const Ctor = mod!.TearGasEffect ?? mod!.default;
      expect(typeof Ctor).toBe('function');
    });

    it('F10.3: TearGas canister detonates after fuse and emits gasDetonated event', async () => {
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
      gas.throwFrom({ x: 0, y: 1.4, z: 3 }, { x: 0, y: 1, z: -4 }, 'swat_1', 0.4);
      for (let i = 0; i < 20; i++) gas.update(0.05);
      expect(h.recorder.count('gasDetonated')).toBeGreaterThanOrEqual(1);
      gas.dispose();
    });

    it('F10.4: TearGasEffect degrades player speed, increases weapon spread, and emits playerCough + voice noise', async () => {
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
      // Simulate sustained exposure inside CS gas cloud
      for (let i = 0; i < 60; i++) {
        h.player.speedMultiplier = 1;
        h.weapons.extraSpread = 0;
        effect.update(0.05);
      }
      expect(h.player.speedMultiplier).toBeLessThan(1.0);
      expect(h.weapons.extraSpread).toBeGreaterThan(0);
      const coughs = h.recorder.count('playerCough');
      const voiceNoises = h.recorder.of('noise').filter((e) => e.payload.kind === 'voice' && e.payload.source === 'player');
      expect(coughs + voiceNoises.length).toBeGreaterThanOrEqual(1);
      effect.dispose();
    });

    it('F10.5: Prolonged player camping in a single room triggers SWAT CS gas deployment', async () => {
      const mod = await loadOptionalModule<TearGasModule>('../../../src/weapons/TearGas');
      expect(mod, 'src/weapons/TearGas.ts must exist in M3').toBeDefined();
      const Ctor = (mod!.TearGas ?? mod!.default)!;
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap({ lockedDoor: false }),
          spawns: [{ x: 0, y: 0, z: 6.5 }],
          count: 1,
          playerPos: { x: 0, y: 0, z: -2.5 },
          startAssault: true,
          tearGasFactory: (colliders, bus, ceilingHeight) => new Ctor(colliders, bus, ceilingHeight),
        }),
      );
      // Emit periodic player noise while remaining stationary (camping) in room_main
      for (let i = 0; i < 7; i++) {
        h.bus.emit('noise', { pos: { x: 0, y: 0, z: -2.5 }, radius: 18, kind: 'voice', source: 'player' });
        h.step(5.0, 0.05);
        if (h.recorder.count('gasDetonated') > 0) break;
      }
      expect(
        h.recorder.count('gasDetonated'),
        'SWAT must deploy CS gas (gasDetonated) when player camps in a single room',
      ).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // F11: Tactical Laser & Flashlight Beams (タクティカルレーザー／フラッシュライトの光芒)
  // =========================================================================
  describe('F11: Tactical Laser & Flashlight Beams', () => {
    it('F11.1: ColliderIndex exports raycastColliders(colliders, origin, dir, maxDist)', () => {
      const idx = ColliderIndex as unknown as ColliderIndexContract;
      expect(typeof idx.raycastColliders, 'ColliderIndex.raycastColliders must be exported in M3').toBe('function');
      const wall: Collider = {
        kind: 'wall',
        aabb: { min: { x: -2, y: 0, z: -5.1 }, max: { x: 2, y: 3, z: -4.9 } },
      };
      const dist = idx.raycastColliders!([wall], { x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 20);
      expect(dist).toBeCloseTo(4.9, 1);
    });

    it('F11.2: HumanoidBody exposes getMuzzlePose(outOrigin, outDir) returning valid unit forward vector', () => {
      const body = new HumanoidBody(1, 2, 0, 0x2b3440, true, { role: 'ally' }) as HumanoidBodyWithMuzzle;
      expect(typeof body.getMuzzlePose, 'HumanoidBody.getMuzzlePose must be implemented in M3').toBe('function');
      const origin = { x: 0, y: 0, z: 0 };
      const dir = { x: 0, y: 0, z: 0 };
      const ok = body.getMuzzlePose!(origin, dir);
      expect(ok).toBe(true);
      expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1.0, 2);
      body.dispose();
    });

    it('F11.3: SwatTeam attaches additive MeshBasicMaterial (depthWrite: false) laser/flashlight meshes', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 3 }],
          count: 1,
          startAssault: true,
        }),
      );
      h.step(0.2, 0.05);
      let additiveBeams = 0;
      h.team.root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.MeshBasicMaterial;
        if (mat && mat.isMeshBasicMaterial && mat.blending === THREE.AdditiveBlending && mat.depthWrite === false) {
          additiveBeams++;
        }
      });
      expect(additiveBeams, 'SWAT units must render additive MeshBasicMaterial laser/flashlight beams').toBeGreaterThanOrEqual(1);
    });

    it('F11.4: SwatTeam tactical beams add ZERO per-unit or dynamic Three.js Light instances across simulation and squad scaling', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [
            { x: 0, y: 0, z: 3 },
            { x: 1.5, y: 0, z: 3 },
          ],
          count: 2,
          startAssault: true,
        }),
      );
      const lightsBefore = countLightsInGraph(h.team.root);
      expect(lightsBefore).toBeLessThanOrEqual(1);
      h.step(0.5, 0.05);
      const lightsAfter = countLightsInGraph(h.team.root);
      // Pre-allocated c2BlastLight (<= 1) is allowed, but zero dynamic lights may be added/removed
      expect(lightsAfter).toBe(lightsBefore);
      expect(lightsAfter).toBeLessThanOrEqual(1);
      // Zero lights on any hunter body.group
      for (const u of h.team.hunters) {
        expect(countLightsInGraph(u.body.group)).toBe(0);
      }
      // Scaling squad from 2 -> 4 hunters must not add any Three.js lights
      const h4 = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [
            { x: -1.5, y: 0, z: 3 },
            { x: -0.5, y: 0, z: 3 },
            { x: 0.5, y: 0, z: 3 },
            { x: 1.5, y: 0, z: 3 },
          ],
          count: 4,
          startAssault: true,
        }),
      );
      h4.step(0.2, 0.05);
      expect(countLightsInGraph(h4.team.root)).toBe(lightsBefore);
      // Additive MeshBasicMaterial laser/flashlight cone meshes must exist
      let additiveBeams = 0;
      h.team.root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.MeshBasicMaterial;
        if (mat && mat.isMeshBasicMaterial && mat.blending === THREE.AdditiveBlending && mat.depthWrite === false) {
          additiveBeams++;
        }
      });
      expect(additiveBeams).toBeGreaterThanOrEqual(1);
    });

    it('F11.5: raycastColliders clips to nearest wall when multiple walls lie along the beam', () => {
      const idx = ColliderIndex as unknown as ColliderIndexContract;
      expect(typeof idx.raycastColliders).toBe('function');
      const nearWall: Collider = {
        kind: 'wall',
        aabb: { min: { x: -2, y: 0, z: -3.1 }, max: { x: 2, y: 3, z: -2.9 } },
      };
      const farWall: Collider = {
        kind: 'wall',
        aabb: { min: { x: -2, y: 0, z: -8.1 }, max: { x: 2, y: 3, z: -7.9 } },
      };
      const dist = idx.raycastColliders!([farWall, nearWall], { x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 20);
      expect(dist).toBeCloseTo(2.9, 1);
    });
  });

  // =========================================================================
  // F12: Tactical Radio Chatter & Stack/C2 Audio (戦術無線とスタック音の強化)
  // =========================================================================
  describe('F12: Tactical Radio Chatter & Stack/C2 Audio', () => {
    function createSpyAudioSink() {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const sink: Record<string, (...args: unknown[]) => void> = {
        playFootstep: (...args) => calls.push({ method: 'playFootstep', args }),
        playDoorCreak: (...args) => calls.push({ method: 'playDoorCreak', args }),
        playBreach: (...args) => calls.push({ method: 'playBreach', args }),
        playGunshot: (...args) => calls.push({ method: 'playGunshot', args }),
        playFlashbang: (...args) => calls.push({ method: 'playFlashbang', args }),
        playWarningCall: (...args) => calls.push({ method: 'playWarningCall', args }),
        playRadioReport: (...args) => calls.push({ method: 'playRadioReport', args }),
        playAllyRadio: (...args) => calls.push({ method: 'playAllyRadio', args }),
        triggerEarRinging: (...args) => calls.push({ method: 'triggerEarRinging', args }),
        updateListener: (...args) => calls.push({ method: 'updateListener', args }),
        // M3 procedural SFX hooks
        playC2Beep: (...args) => calls.push({ method: 'playC2Beep', args }),
        playC2Blast: (...args) => calls.push({ method: 'playC2Blast', args }),
        playGasHiss: (...args) => calls.push({ method: 'playGasHiss', args }),
        playCough: (...args) => calls.push({ method: 'playCough', args }),
        playSwatFootstep: (...args) => calls.push({ method: 'playSwatFootstep', args }),
      };
      return { sink: sink as unknown as AudioBridgeSink, calls };
    }

    it('F12.1: AudioBridge routes swatFootstep event to spatial footstep SFX', () => {
      const bus = createGameEventBus();
      const player = createHeadlessPlayer({ x: 0, y: 0, z: 0 });
      const { sink, calls } = createSpyAudioSink();
      const bridge = new AudioBridge(bus, sink, player, []);
      emitContractEvent(bus, 'swatFootstep', { pos: { x: 2, y: 0, z: 0 }, heavy: true });
      const matched = calls.some((c) => c.method === 'playSwatFootstep' || c.method === 'playFootstep');
      expect(matched, 'AudioBridge must subscribe to swatFootstep in M3').toBe(true);
      bridge.dispose();
    });

    it('F12.2: AudioBridge routes c2Beep and c2Detonated events to C2 audio methods', () => {
      const bus = createGameEventBus();
      const player = createHeadlessPlayer({ x: 0, y: 0, z: 0 });
      const { sink, calls } = createSpyAudioSink();
      const bridge = new AudioBridge(bus, sink, player, []);
      emitContractEvent(bus, 'c2Beep', { pos: { x: 2, y: 1, z: 0 }, urgent: true });
      emitContractEvent(bus, 'c2Detonated', { doorId: 'd1', pos: { x: 2, y: 1, z: 0 }, dir: { x: -1, y: 0, z: 0 }, radius: 5 });
      expect(calls.some((c) => c.method === 'playC2Beep')).toBe(true);
      expect(calls.some((c) => c.method === 'playC2Blast' || c.method === 'playBreach')).toBe(true);
      bridge.dispose();
    });

    it('F12.3: AudioBridge routes gasDetonated and playerCough events to procedural SFX', () => {
      const bus = createGameEventBus();
      const player = createHeadlessPlayer({ x: 0, y: 0, z: 0 });
      const { sink, calls } = createSpyAudioSink();
      const bridge = new AudioBridge(bus, sink, player, []);
      emitContractEvent(bus, 'gasDetonated', { pos: { x: 1, y: 0.5, z: 0 }, radius: 4 });
      emitContractEvent(bus, 'playerCough', { pos: { x: 0, y: 1.5, z: 0 } });
      expect(calls.some((c) => c.method === 'playGasHiss')).toBe(true);
      expect(calls.some((c) => c.method === 'playCough')).toBe(true);
      bridge.dispose();
    });

    it('F12.4: Moving SWAT units emit swatFootstep events while sweeping/advancing', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6.5 }],
          count: 1,
          startAssault: true,
        }),
      );
      h.step(3.0, 0.05);
      expect(h.recorder.count('swatFootstep'), 'Moving SWAT units must emit swatFootstep in M3').toBeGreaterThanOrEqual(1);
    });

    it('F12.5: Multi-cell radio callouts stagger by >= 1.2s and avoid overlapping spam', () => {
      const map = makeTwoDoorHouseMap();
      const h = track(
        createSwatHarness({
          map,
          spawns: [
            { x: -1, y: 0, z: 7 },
            { x: 1, y: 0, z: 7 },
            { x: -1, y: 0, z: -7 },
            { x: 1, y: 0, z: -7 },
          ],
          count: 4,
          startAssault: true,
        }),
      );
      h.step(8.0, 0.05);
      const radios = h.recorder.of('allyRadio');
      expect(radios.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < radios.length; i++) {
        const gap = radios[i]!.time - radios[i - 1]!.time;
        expect(gap).toBeGreaterThanOrEqual(1.15);
      }
    });
  });

  // =========================================================================
  // F13: 増援ウェーブは廃止（容疑者モードは最初の突入班だけと戦う）
  // =========================================================================
  describe('F13: Reinforcement Waves Removed', () => {
    it('F13.1: BriefingScreen in Suspect Mode renders no reinforcements toggle', () => {
      const dom = installDomShim();
      const map = makeSingleRoomMap();
      const screen = new BriefingScreen(dom.document.body as unknown as HTMLElement, map, { onStart: () => {}, mode: 'suspect' });
      const toggles = dom.document.body.findAll((el) => /増援|reinforce|wave/i.test(el.textContent));
      expect(toggles.length).toBe(0);
      screen.dispose();
    });

    it('F13.2: SuspectMission ends with repelled as soon as the initial SWAT team is down', () => {
      const h = track(
        createSwatHarness({
          map: makeSingleRoomMap(),
          spawns: [{ x: 0, y: 0, z: 6 }],
          count: 1,
          startAssault: true,
        }),
      );
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
      h.bus.emit('entityHit', { targetId: 'swat_1', shooter: 'player', damage: 200, pos: { x: 0, y: 1, z: 6 } });
      for (let i = 0; i < 60; i++) {
        h.step(0.05, 0.05);
        mission.update(0.05);
      }
      expect(h.team.total).toBe(1);
      expect(ended).toBe(true);
      mission.dispose();
    });
  });
});
