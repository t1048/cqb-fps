import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import type { WeaponDef } from '../../src/core/types';
import type { InputManager } from '../../src/core/Input';
import type { PlayerController } from '../../src/player/PlayerController';
import type { FlashOverlay } from '../../src/ui/FlashOverlay';
import { Flashbang } from '../../src/weapons/Flashbang';
import { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { Collider } from '../../src/world/WorldBuilder';

const FLASH_WEAPON_DEF: WeaponDef = {
  id: 'flashbang',
  name: 'Flashbang',
  category: 'throwable',
  fireMode: 'semi',
  damage: 0,
  rpm: 60,
  magazineSize: 2,
  reloadTime: 0,
  hipSpread: 0,
  adsSpread: 0,
  moveSpreadPenalty: 0,
  recoilPitch: 0,
  recoilYaw: 0,
  adsSpeedMultiplier: 1,
  range: 15,
  noiseRadius: 30,
  throwable: {
    fuseTime: 1.5,
    throwSpeed: 10,
    gravity: 9.8,
    restitution: 0.45,
    friction: 0.7,
    stopSpeed: 0.5,
    ballRadius: 0.05,
    effectRadius: 8,
    blindMaxSec: 3.5,
    afterglowSec: 2.0,
    afterglowOpacity: 0.4,
    behindFactor: 0.25,
    falloffMin: 0.2,
  },
};

const PISTOL_DEF: WeaponDef = {
  id: 'pistol',
  name: 'Service Pistol',
  category: 'pistol',
  fireMode: 'semi',
  damage: 25,
  fireRate: 5,
  magazineSize: 2,
  reloadTime: 1.5,
  hipSpread: 1.5,
  adsSpread: 0.8,
  moveSpreadPenalty: 1.0,
  recoilPitch: 1.5,
  recoilYaw: 0.4,
  adsSpeedMultiplier: 0.75,
  range: 35,
  noiseRadius: 32,
};

function makeMockPlayer(x = 0, y = 0, z = 0) {
  const position = new THREE.Vector3(x, y, z);
  return {
    position,
    alive: true,
    isMoving: false,
    yawRad: 0,
    pitchRad: 0,
    speedMultiplier: 1,
    getEyePosition: (out = new THREE.Vector3()) => out.set(position.x, position.y + 1.6, position.z),
    addViewKick: vi.fn(),
  };
}

function makeMockInput() {
  const pressed = new Set<string>();
  let mouseDown = false;
  return {
    pressed,
    setMouseDown(v: boolean) {
      mouseDown = v;
    },
    isMouseDown: () => mouseDown,
    wasMousePressed: () => false,
    wasPressed: (action: string) => {
      if (pressed.has(action)) {
        pressed.delete(action);
        return true;
      }
      return false;
    },
    isDown: () => false,
    isPointerLocked: () => true,
  };
}

describe('F3 Event & Weapon Wiring — Flashbang.playerBlinded & WeaponSystem reload noise', () => {
  it('Flashbang emits playerBlinded with player foot position when player has LOS within radius', () => {
    const bus = createGameEventBus();
    const blinded: { duration: number; pos: { x: number; y: number; z: number } }[] = [];
    bus.on('playerBlinded', (e) => blinded.push(e));

    const player = makeMockPlayer(2, 0, 5);
    const input = makeMockInput();
    const overlay = { trigger: vi.fn(), update: vi.fn() };
    const ws = { suppressFire: false } as unknown as WeaponSystem;

    const fb = new Flashbang(
      player as unknown as PlayerController,
      input as unknown as InputManager,
      [],
      [FLASH_WEAPON_DEF],
      bus,
      ws,
      overlay as unknown as FlashOverlay,
      3.0,
    );

    // Detonate 2m in front of player (yaw=0 looks toward -Z)
    fb.throwFrom({ x: 2, y: 0.5, z: 3 }, { x: 0, y: 0, z: 0 }, 'swat_1', 0.01);
    fb.update(0.05);

    expect(blinded.length).toBe(1);
    expect(blinded[0]!.duration).toBeGreaterThan(1.0);
    expect(blinded[0]!.pos).toEqual({ x: 2, y: 0, z: 5 });
    expect(overlay.trigger).toHaveBeenCalledTimes(1);
    fb.dispose();
  });

  it('Flashbang does NOT emit playerBlinded when blocked by a wall or outside radius', () => {
    const bus = createGameEventBus();
    const blinded: unknown[] = [];
    bus.on('playerBlinded', (e) => blinded.push(e));

    const player = makeMockPlayer(0, 0, 5);
    const input = makeMockInput();
    const overlay = { trigger: vi.fn(), update: vi.fn() };
    const ws = { suppressFire: false } as unknown as WeaponSystem;
    const wall: Collider = {
      kind: 'wall',
      aabb: { min: { x: -3, y: 0, z: 3.5 }, max: { x: 3, y: 3, z: 4.0 } },
    };

    const fb = new Flashbang(
      player as unknown as PlayerController,
      input as unknown as InputManager,
      [wall],
      [FLASH_WEAPON_DEF],
      bus,
      ws,
      overlay as unknown as FlashOverlay,
      3.0,
    );

    // Behind wall
    fb.throwFrom({ x: 0, y: 0.5, z: 2.0 }, { x: 0, y: 0, z: 0 }, 'swat_1', 0.01);
    fb.update(0.05);
    expect(blinded.length).toBe(0);

    // Far away (outside 8m effectRadius)
    fb.throwFrom({ x: 0, y: 0.5, z: 20.0 }, { x: 0, y: 0, z: 0 }, 'swat_1', 0.01);
    fb.update(0.05);
    expect(blinded.length).toBe(0);
    fb.dispose();
  });

  it('WeaponSystem emits noise(kind: reload, source: player, radius: 12) on manual and auto reload', () => {
    const bus = createGameEventBus();
    const noises: { kind: string; source?: string; radius: number; pos: { x: number; y: number; z: number } }[] = [];
    bus.on('noise', (e) => noises.push(e));

    const player = makeMockPlayer(3, 0, 4);
    const input = makeMockInput();
    const ws = new WeaponSystem(
      player as unknown as PlayerController,
      input as unknown as InputManager,
      [],
      [PISTOL_DEF],
      bus,
    );

    // Fire 1 shot so magazine is below max (1/2)
    input.setMouseDown(true);
    ws.update(0.016);
    input.setMouseDown(false);
    expect(ws.ammoInMagazine).toBe(1);

    // Trigger manual reload
    input.pressed.add('reload');
    ws.update(0.016);

    const reloadNoises = noises.filter((n) => n.kind === 'reload');
    expect(reloadNoises.length).toBe(1);
    expect(reloadNoises[0]).toEqual({
      kind: 'reload',
      source: 'player',
      radius: 12,
      pos: { x: 3, y: 1.0, z: 4 },
    });

    // Finish reload (WeaponSystem clamps rawDt to MAX_DT=0.05s), empty magazine, then pull trigger on empty
    for (let i = 0; i < 32; i++) ws.update(0.05);
    expect(ws.ammoInMagazine).toBe(2);
    for (let i = 0; i < 2; i++) {
      input.setMouseDown(true);
      ws.update(0.016);
      input.setMouseDown(false);
      for (let j = 0; j < 6; j++) ws.update(0.05);
    }
    expect(ws.ammoInMagazine).toBe(0);

    // Pull trigger on empty magazine -> auto-reload
    input.setMouseDown(true);
    ws.update(0.016);
    input.setMouseDown(false);

    const allReloadNoises = noises.filter((n) => n.kind === 'reload');
    expect(allReloadNoises.length).toBe(2);
    expect(allReloadNoises[1]!.source).toBe('player');
    ws.dispose();
  });
});
