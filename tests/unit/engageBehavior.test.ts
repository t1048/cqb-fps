import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { EngageBehavior, resolveFloorY, type CombatContext, type CombatThreat } from '../../src/ai/EngageBehavior';
import type { HumanoidBody } from '../../src/ai/HumanoidBody';
import { createGameEventBus } from '../../src/core/events';
import type { CombatParams, Vec3 } from '../../src/core/types';
import type { Collider } from '../../src/world/WorldBuilder';

function makeCombatParams(overrides: Partial<CombatParams> = {}): CombatParams {
  return {
    decisionSec: 0.7,
    alertCalmSec: 10,
    hesitateFireSec: 3,
    hesitateRetreatSpeed: 0.8,
    hesitateRetreatMax: 1.5,
    hesitateShakeDeg: 0,
    moveSpeed: 2.35,
    fireInterval: 0.2,
    shotsPerPeek: 5,
    magazineSize: 30,
    reloadSec: 2.0,
    coverSecMin: 0.9,
    coverSecMax: 1.8,
    peekSecMax: 1.8,
    engageRange: 18,
    coverSearchRange: 6,
    coverMargin: 0.45,
    crouchCoverMaxHeight: 1.5,
    flinchSec: 0.35,
    gunshotNoiseRadius: 40,
    shotDamage: 13,
    baseSpreadDeg: 2.0,
    ...overrides,
  };
}

function makeStubBody(x = 0, z = 0, footY = 0) {
  const stub = {
    px: x,
    pz: z,
    footY,
    yawRad: 0,
    ground: [] as readonly Collider[],
    setPosition: vi.fn((nx: number, nz: number, ny?: number) => {
      stub.px = nx;
      stub.pz = nz;
      if (ny !== undefined) stub.footY = ny;
    }),
    faceToward: vi.fn(),
    setFlash: vi.fn(),
    setPose: vi.fn(),
    showMuzzleFlash: vi.fn(),
  };
  return stub;
}

function makeContext(playerPos: Vec3, colliders: Collider[] = []): CombatContext {
  return {
    player: {
      position: new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z),
      alive: true,
      getEyePosition: (out: THREE.Vector3) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
      getBodyBounds: () => ({
        min: { x: playerPos.x - 0.3, y: playerPos.y, z: playerPos.z - 0.3 },
        max: { x: playerPos.x + 0.3, y: playerPos.y + 1.75, z: playerPos.z + 0.3 },
      }),
      takeDamage: () => 87,
    },
    colliders,
    playerDamage: vi.fn(),
  };
}

function makeThreat(pos: Vec3): CombatThreat {
  return {
    id: 'player',
    x: pos.x,
    z: pos.z,
    point: { x: pos.x, y: pos.y + 1.15, z: pos.z },
    isPlayer: true,
  };
}

describe('EngageBehavior — F1 Immediate Fire on Contact & F2 Reduced Flinch / No-Retreat', () => {
  it('preserves default normal-mode Suspect behavior (no immediate fire on enter, retreats on hit)', () => {
    const bus = createGameEventBus();
    const shots: string[] = [];
    bus.on('shotFired', (e) => shots.push(e.shooter));

    const playerPos = { x: 0, y: 0, z: 6 };
    const body = makeStubBody(0, 0, 0);
    const combat = makeCombatParams();
    const engage = new EngageBehavior(
      combat,
      'suspect_1',
      body as unknown as HumanoidBody,
      bus,
      makeContext(playerPos),
      () => true,
    );

    engage.enter(playerPos);
    expect(engage.label).toBe('cover');
    engage.update(0.016, playerPos, true, makeThreat(playerPos));
    expect(shots.length).toBe(0);

    // onHit without skipRetreatOnHit applies flinch and retreats
    engage.onHit(playerPos);
    expect(engage.label).toBe('flinch');
    engage.update(0.36, playerPos, true, makeThreat(playerPos));
    expect(engage.label).toBe('cover');
  });

  it('F1: fires an immediate capped burst on enter when immediateFireOnEnter is enabled and target is visible & in range', () => {
    const bus = createGameEventBus();
    const shots: string[] = [];
    bus.on('shotFired', (e) => shots.push(e.shooter));

    const playerPos = { x: 0, y: 0, z: 6 };
    const body = makeStubBody(0, 0, 0);
    const combat = makeCombatParams({ shotsPerPeek: 6, fireInterval: 0.2 });
    const engage = new EngageBehavior(
      combat,
      'swat_1',
      body as unknown as HumanoidBody,
      bus,
      makeContext(playerPos),
      () => true,
      null,
      null,
      { immediateFireOnEnter: true, immediateFireShots: 3 },
    );

    engage.enter(playerPos);
    expect(engage.label).toBe('peek');

    // First frame fires shot #1 immediately
    engage.update(0.016, playerPos, true, makeThreat(playerPos));
    expect(shots.length).toBe(1);

    // Step fireInterval for shot #2 and shot #3
    engage.update(0.21, playerPos, true, makeThreat(playerPos));
    expect(shots.length).toBe(2);
    engage.update(0.21, playerPos, true, makeThreat(playerPos));
    expect(shots.length).toBe(3);

    // After 3 shots (capped below shotsPerPeek=6), transitions to retreat/cover
    expect(engage.label).toBe('cover');
  });

  it('F1: falls back to retreat without firing when blocked by wall, out of range, or sees === false (hostage in line)', () => {
    const bus = createGameEventBus();
    const shots: string[] = [];
    bus.on('shotFired', (e) => shots.push(e.shooter));

    const playerPos = { x: 0, y: 0, z: 6 };
    const wall: Collider = {
      kind: 'wall',
      aabb: { min: { x: -2, y: 0, z: 2.8 }, max: { x: 2, y: 3, z: 3.2 } },
    };

    // 1. Wall blocks LOS on enter
    const blockedEngage = new EngageBehavior(
      makeCombatParams(),
      'swat_blocked',
      makeStubBody(0, 0, 0) as unknown as HumanoidBody,
      bus,
      makeContext(playerPos, [wall]),
      () => true,
      null,
      null,
      { immediateFireOnEnter: true, immediateFireShots: 3 },
    );
    blockedEngage.enter(playerPos);
    expect(blockedEngage.label).toBe('cover');
    blockedEngage.update(0.016, playerPos, true, makeThreat(playerPos));
    expect(shots.length).toBe(0);

    // 2. Out of range on enter
    const farPos = { x: 0, y: 0, z: 25 };
    const farEngage = new EngageBehavior(
      makeCombatParams({ engageRange: 18 }),
      'swat_far',
      makeStubBody(0, 0, 0) as unknown as HumanoidBody,
      bus,
      makeContext(farPos),
      () => true,
      null,
      null,
      { immediateFireOnEnter: true, immediateFireShots: 3 },
    );
    farEngage.enter(farPos);
    expect(farEngage.label).toBe('cover');

    // 3. Visible on enter, but sees === false on update (e.g. civilian/hostage in line)
    const hostageEngage = new EngageBehavior(
      makeCombatParams(),
      'swat_hostage',
      makeStubBody(0, 0, 0) as unknown as HumanoidBody,
      bus,
      makeContext(playerPos),
      () => true,
      null,
      null,
      { immediateFireOnEnter: true, immediateFireShots: 3 },
    );
    hostageEngage.enter(playerPos);
    expect(hostageEngage.label).toBe('peek');
    hostageEngage.update(0.016, playerPos, false, null);
    expect(shots.length).toBe(0);
    expect(hostageEngage.label).toBe('cover');
  });

  it('F2: skipRetreatOnHit keeps current phase and respects dynamic flinchSec', () => {
    const bus = createGameEventBus();
    const playerPos = { x: 0, y: 0, z: 6 };
    const body = makeStubBody(0, 0, 0);
    const combat = makeCombatParams({ flinchSec: 0.06 });
    let skipRetreat = true;

    const engage = new EngageBehavior(
      combat,
      'swat_shield',
      body as unknown as HumanoidBody,
      bus,
      makeContext(playerPos),
      () => true,
      null,
      null,
      {
        immediateFireOnEnter: true,
        immediateFireShots: 3,
        skipRetreatOnHit: () => skipRetreat,
      },
    );

    engage.enter(playerPos);
    expect(engage.label).toBe('peek');

    // Hit with skipRetreat = true: brief 0.06s flinch, then stays in peek
    engage.onHit(playerPos);
    expect(engage.label).toBe('flinch');
    engage.update(0.03, playerPos, true, makeThreat(playerPos));
    expect(engage.label).toBe('flinch');
    engage.update(0.04, playerPos, true, makeThreat(playerPos));
    expect(engage.label).toBe('peek');

    // Dynamically change flinchSec and toggle skipRetreat = false -> retreats to cover
    combat.flinchSec = 0.09;
    skipRetreat = false;
    engage.onHit(playerPos);
    expect(engage.label).toBe('flinch');
    engage.update(0.1, playerPos, true, makeThreat(playerPos));
    expect(engage.label).toBe('cover');
  });

  it('resolveFloorY treats reload noise consistently with gunshot/voice when rooms are absent', () => {
    expect(resolveFloorY({ x: 1, y: 1.0, z: 2 }, undefined, 'reload')).toBe(0);
    expect(resolveFloorY({ x: 1, y: 4.2, z: 2 }, [], 'reload')).toBeCloseTo(3.2, 5);
  });
});
