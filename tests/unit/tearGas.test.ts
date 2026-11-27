import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import { TearGas, computeGasDensityAt, GAS_CLOUD_DURATION } from '../../src/weapons/TearGas';
import { TearGasEffect } from '../../src/player/TearGasEffect';
import { PepperEffect } from '../../src/player/PepperEffect';
import { WeaponSystem } from '../../src/weapons/WeaponSystem';
import { SwatTeam, updateRoomStay, type SwatTeamDeps } from '../../src/modes/SwatTeam';
import type { Collider } from '../../src/world/WorldBuilder';
import type { RoomDef, WeaponDef } from '../../src/core/types';
import type { DoorSystem } from '../../src/world/Door';
import type { Flashbang } from '../../src/weapons/Flashbang';
import type { Subtitle } from '../../src/ui/Subtitle';
import type { PlayerController } from '../../src/player/PlayerController';
import type { InputManager } from '../../src/core/InputManager';

function makeWall(minX: number, minZ: number, maxX: number, maxZ: number, maxY = 2.8): Collider {
  return { kind: 'wall', aabb: { min: { x: minX, y: 0, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } };
}

function makeFloor(minX: number, minZ: number, maxX: number, maxZ: number, y = 0): Collider {
  return { kind: 'floor', aabb: { min: { x: minX, y: y - 0.1, z: minZ }, max: { x: maxX, y, z: maxZ } } };
}

function makeStubDom(): { restore: () => void; appended: unknown[] } {
  const prevDoc = (globalThis as { document?: unknown }).document;
  const appended: unknown[] = [];
  const createEl = () => ({
    style: {} as Record<string, string>,
    remove: vi.fn(),
  });
  (globalThis as { document?: unknown }).document = {
    createElement: vi.fn(createEl),
    body: {
      appendChild: vi.fn((el: unknown) => {
        appended.push(el);
        return el;
      }),
    },
  };
  return {
    appended,
    restore: () => {
      (globalThis as { document?: unknown }).document = prevDoc;
    },
  };
}

const PISTOL_DEF: WeaponDef = {
  id: 'pistol',
  name: '9mm Pistol',
  slot: 1,
  category: 'lethal',
  damage: 35,
  fireRate: 5,
  magazineSize: 15,
  reloadTime: 1.5,
  adsSpread: 1.0,
  moveSpreadPenalty: 1.5,
  recoilPerShot: 0.4,
  range: 40,
  noiseRadius: 20,
  moraleDamage: 20,
};

describe('F10 — Tear Gas (CS Gas) & Anti-Camping', () => {
  let dom: { restore: () => void; appended: unknown[] };

  beforeEach(() => {
    dom = makeStubDom();
  });

  afterEach(() => {
    dom.restore();
    vi.restoreAllMocks();
  });

  it('TearGas canister detonates after fuse, emits gasDetonated, creates cloud with zero lights, and expires cleanly', () => {
    const bus = createGameEventBus();
    const detonated: { pos: { x: number; y: number; z: number }; radius: number }[] = [];
    bus.on('gasDetonated', (e) => detonated.push(e));

    const colliders: Collider[] = [makeFloor(-20, -20, 20, 20, 0)];
    const gas = new TearGas(colliders, bus, 3.0);

    gas.throwFrom({ x: 0, y: 1.2, z: 0 }, { x: 2, y: 1, z: 0 }, 'swat_1', 0.5);
    expect(gas.activeCanisterCount).toBe(1);
    expect(gas.activeCloudCount).toBe(0);

    // Step past fuse (0.5s)
    for (let i = 0; i < 15; i++) gas.update(0.05);
    expect(detonated.length).toBe(1);
    expect(gas.activeCloudCount).toBe(1);

    const cloudPos = detonated[0]!.pos;
    expect(gas.isPointInGas({ x: cloudPos.x, y: cloudPos.y + 1.0, z: cloudPos.z })).toBe(true);
    expect(gas.exposureAt({ x: cloudPos.x, y: cloudPos.y + 1.0, z: cloudPos.z })).toBeGreaterThan(0);
    expect(gas.isPointInGas({ x: cloudPos.x + 10, y: cloudPos.y + 1.0, z: cloudPos.z })).toBe(false);

    // Verify ZERO Three.js lights and MeshBasicMaterial on cloud puffs
    let lightCount = 0;
    let basicPuffCount = 0;
    gas.root.traverse((obj) => {
      if (obj instanceof THREE.Light) lightCount++;
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshBasicMaterial) {
        expect(obj.material.transparent).toBe(true);
        expect(obj.material.depthWrite).toBe(false);
        basicPuffCount++;
      }
    });
    expect(lightCount).toBe(0);
    expect(basicPuffCount).toBeGreaterThanOrEqual(6);

    // Advance past cloud duration
    const steps = Math.ceil((GAS_CLOUD_DURATION + 1) / 0.05);
    for (let i = 0; i < steps; i++) gas.update(0.05);
    expect(gas.activeCloudCount).toBe(0);
    expect(gas.exposureAt({ x: cloudPos.x, y: cloudPos.y + 1.0, z: cloudPos.z })).toBe(0);

    gas.dispose();
  });

  it('部屋に投げ込んだガスは一定時間で部屋いっぱいに広がり、家具の裏にも回る（広すぎる部屋は上限まで）', () => {
    const bus = createGameEventBus();
    const room = (id: string, x: number, w: number): RoomDef => ({ id, name: id, x, z: 0, width: w, depth: 8 });
    const furniture: Collider = { kind: 'cover', aabb: { min: { x: 0.5, y: 0, z: -2 }, max: { x: 1.5, y: 1.8, z: 2 } } };
    const colliders: Collider[] = [makeFloor(-40, -20, 40, 20, 0), furniture];
    const gas = new TearGas(colliders, bus, 3.0, [room('small', 0, 10), room('huge', 100, 60)]);
    gas.throwFrom({ x: -4, y: 0.2, z: 0 }, { x: 0, y: 0, z: 0 }, 'p', 0.1);
    for (let i = 0; i < 4; i++) gas.update(0.05);
    // 起爆直後は遠い隅にまだ届かない
    expect(gas.exposureAt({ x: 4.5, y: 1.2, z: 2 })).toBe(0);
    for (let i = 0; i < 120; i++) gas.update(0.05);
    // 約 6 秒後: 4.2m 超の奥・家具の裏も満たされる
    expect(gas.exposureAt({ x: 4.5, y: 1.2, z: 2 })).toBeGreaterThan(0);
    expect(gas.exposureAt({ x: 2.5, y: 1.2, z: 0 })).toBeGreaterThan(0);
    // 部屋の外（壁の向こう）へは広がらない
    expect(gas.exposureAt({ x: 12, y: 1.2, z: 0 })).toBe(0);
    gas.dispose();

    const big = new TearGas(colliders, bus, 3.0, [room('huge', 0, 60)]);
    big.throwFrom({ x: 0, y: 0.2, z: 0 }, { x: 0, y: 0, z: 0 }, 'p', 0.1);
    for (let i = 0; i < 130; i++) big.update(0.05);
    expect(big.exposureAt({ x: 8, y: 1.2, z: 0 })).toBeGreaterThan(0);
    expect(big.exposureAt({ x: 20, y: 1.2, z: 0 })).toBe(0);
    big.dispose();
  });

  it('computeGasDensityAt respects radius, floor height band, and wall occlusion', () => {
    const cloud = {
      pos: { x: 0, y: 0.2, z: 0 },
      radius: 4.0,
      remainingSec: 10,
      durationSec: 16,
      intensity: 1,
    };
    const wall = makeWall(1.4, -5, 1.6, 5, 3);

    expect(computeGasDensityAt([cloud], { x: 0.5, y: 1.5, z: 0 }, [wall])).toBeGreaterThan(0.5);
    // Behind wall
    expect(computeGasDensityAt([cloud], { x: 2.5, y: 1.5, z: 0 }, [wall])).toBe(0);
    // Different floor
    expect(computeGasDensityAt([cloud], { x: 0, y: 3.5, z: 0 }, [wall])).toBe(0);
    // Outside radius
    expect(computeGasDensityAt([cloud], { x: -5, y: 1.5, z: 0 }, [wall])).toBe(0);
  });

  it('PepperEffect + TearGasEffect coordinate additively on extraSpread, multiplicatively on speedMultiplier, without clobbering canvas.style.filter', () => {
    const bus = createGameEventBus();
    const coughEvents: { pos: { x: number; y: number; z: number } }[] = [];
    const voiceNoises: { pos: { x: number; y: number; z: number }; radius: number; kind: string; source?: string }[] = [];
    bus.on('playerCough', (e) => coughEvents.push(e));
    bus.on('noise', (e) => {
      if (e.kind === 'voice') voiceNoises.push(e);
    });

    const playerPos = new THREE.Vector3(0, 0, 0);
    const playerMock = {
      alive: true,
      isMoving: false,
      position: playerPos,
      speedMultiplier: 1,
      yawRad: 0,
      pitchRad: 0,
      addViewKick: vi.fn(),
      getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
      getForward: (out = new THREE.Vector3()) => out.set(0, 0, -1),
    };
    const inputMock = {
      isOrderMenuOpen: false,
      isPointerLocked: false,
      wasPressed: () => false,
      isMouseDown: () => false,
    };
    const weapons = new WeaponSystem(
      playerMock as unknown as PlayerController,
      inputMock as unknown as InputManager,
      [],
      [PISTOL_DEF],
      bus,
    );
    const canvas = { style: { filter: '' } } as unknown as HTMLCanvasElement;
    const subtitle = { show: vi.fn() } as unknown as Subtitle;

    const pepper = new PepperEffect(playerMock as unknown as PlayerController, weapons, subtitle, canvas);
    let gasExposure = 1.0;
    const tearGasEffect = new TearGasEffect(
      playerMock,
      weapons,
      { exposureAt: () => gasExposure },
      subtitle,
      bus,
    );

    pepper.hit();
    pepper.hit(); // ~48% pepper

    // Run 20 frames (1.0s) in main.ts order: weapons.update -> pepper.update -> tearGasEffect.update
    for (let i = 0; i < 20; i++) {
      weapons.update(0.05);
      pepper.update(0.05);
      tearGasEffect.update(0.05);
    }

    const kp = pepper.amount / 100;
    const kg = tearGasEffect.amount / 100;
    expect(kp).toBeGreaterThan(0.2);
    expect(kg).toBeGreaterThan(0.4);

    // extraSpread is additive sum of pepper + gas
    expect(weapons.extraSpread).toBeCloseTo(kp * 6 + kg * 7.5, 4);
    // speedMultiplier is multiplicative product of both slowdowns
    expect(playerMock.speedMultiplier).toBeCloseTo((1 - 0.5 * kp) * (1 - 0.42 * kg), 4);
    // PepperEffect's canvas.style.filter is preserved, TearGasEffect uses its own overlay backdropFilter
    expect(canvas.style.filter).toContain('blur(');
    expect(tearGasEffect.overlayElement.style.backdropFilter).toContain('blur(');

    // Next frame: WeaponSystem.update reads accumulated extraSpread into spreadDeg before resetting
    weapons.update(0.05);
    expect(weapons.spreadDeg).toBeCloseTo(PISTOL_DEF.adsSpread + kp * 6 + kg * 7.5, 4);
    expect(weapons.extraSpread).toBe(0);

    // Coughing emitted playerCough + voice noise with source: 'player'
    expect(coughEvents.length).toBeGreaterThan(0);
    expect(voiceNoises.length).toBeGreaterThan(0);
    expect(voiceNoises[0]!.source).toBe('player');
    expect(voiceNoises[0]!.radius).toBe(16);

    // Leaving gas decays TearGasEffect back to 0
    gasExposure = 0;
    for (let i = 0; i < 150; i++) {
      weapons.update(0.05);
      tearGasEffect.update(0.05);
    }
    expect(tearGasEffect.amount).toBe(0);
    expect(tearGasEffect.overlayElement.style.backdropFilter).toBe('');

    pepper.dispose();
    tearGasEffect.dispose();
    weapons.dispose();
  });

  it('updateRoomStay accumulates time in same room and resets on room change or outdoors', () => {
    let st = updateRoomStay(null, 0, 'living', 1.0);
    expect(st).toEqual({ roomId: 'living', staySec: 0 });
    st = updateRoomStay(st.roomId, st.staySec, 'living', 12.5);
    expect(st).toEqual({ roomId: 'living', staySec: 12.5 });
    st = updateRoomStay(st.roomId, st.staySec, 'kitchen', 1.0);
    expect(st).toEqual({ roomId: 'kitchen', staySec: 0 });
    st = updateRoomStay(st.roomId, st.staySec, null, 1.0);
    expect(st).toEqual({ roomId: null, staySec: 0 });
  });

  it('SwatTeam throws CS gas when player camps in a room past threshold, and hears close player coughs', () => {
    const bus = createGameEventBus();
    const playerPos = new THREE.Vector3(0, 0, 0);
    const room: RoomDef = { id: 'living', name: 'リビング', x: 0, z: 0, width: 8, depth: 8, floorY: 0 };
    const throwFrom = vi.fn();
    const deps: SwatTeamDeps = {
      spawns: [{ x: 0, y: 0, z: 6 }],
      count: 2,
      player: {
        alive: true,
        isCrouching: false,
        yawRad: 0,
        position: playerPos,
        getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
        takeDamage: () => 100,
      },
      colliders: [makeFloor(-20, -20, 20, 20, 0)],
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [] } as unknown as DoorSystem,
      bounds: { width: 30, depth: 30 },
      stairs: [],
      rooms: [room],
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      tearGas: { gravity: 14, throwFrom },
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    };
    const team = new SwatTeam(deps);
    team.beginAssault();

    // Keep hunter at z=6 facing away so direct camping triggers gas throw
    for (let i = 0; i < 450; i++) {
      team.update(0.05); // 22.5s > 20s camp threshold
      if (throwFrom.mock.calls.length > 0) break;
    }
    expect(throwFrom).toHaveBeenCalled();

    // Test player cough within SELF_NOISE_RADIUS (3.2m) is NOT dropped
    const hunter = team.hunters[0]!;
    hunter.state = 'sweep';
    hunter.huntTarget = null;
    hunter.body.setPosition(0, 2.0, 0);
    bus.emit('noise', {
      pos: { x: 0, y: 1.2, z: 0.5 }, // 1.5m from hunter (< 3.2m SELF_NOISE_RADIUS)
      radius: 16,
      kind: 'voice',
      source: 'player',
    });
    expect(hunter.state).toBe('hunt');

    team.dispose();
  });
});
