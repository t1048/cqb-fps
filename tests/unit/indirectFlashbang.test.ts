import { describe, expect, it } from 'vitest';
import type { WindowDef } from '../../src/core/types';
import {
  computeBallisticVelocity,
  planDoorwayFlashThrow,
  planFlashThrow,
  planWallBankFlashThrow,
  planWindowFlashThrow,
  raycastWallXZ,
  type FlashDoorSample,
} from '../../src/modes/SwatTeam';
import type { Collider } from '../../src/world/WorldBuilder';

function wall(minX: number, maxX: number, minZ: number, maxZ: number, minY = 0, maxY = 3): Collider {
  return {
    kind: 'wall',
    aabb: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } },
  };
}

describe('F5 Indirect / Door-Frame / Window / 1-Bounce Wall-Bank Flashbang Helpers', () => {
  it('computeBallisticVelocity hits target exactly under gravity', () => {
    const origin = { x: 0, y: 1.4, z: 0 };
    const target = { x: 4.5, y: 1.05, z: 0 };
    const g = 9.8;
    const speed = 9.0;
    const v = computeBallisticVelocity(origin, target, g, speed, 0.2, 0.95);
    const t = 4.5 / speed; // 0.5s
    expect(origin.x + v.x * t).toBeCloseTo(target.x, 5);
    expect(origin.y + v.y * t - 0.5 * g * t * t).toBeCloseTo(target.y, 5);
    expect(origin.z + v.z * t).toBeCloseTo(target.z, 5);
  });

  it('planDoorwayFlashThrow throws through an open doorway below the lintel and rejects closed/locked doors', () => {
    // Wall along z = 0 with a 1m doorway opening at x in [-0.5, 0.5]
    const colliders: Collider[] = [
      wall(-6, -0.5, -0.1, 0.1),
      wall(0.5, 6, -0.1, 0.1),
      // Lintel above 2.18m
      wall(-0.5, 0.5, -0.1, 0.1, 2.18, 3.0),
    ];
    const origin = { x: -2.0, y: 1.4, z: 3.0 };
    const target = { x: 2.2, y: 0, z: -2.5 }; // behind the solid wall (no direct LOS)

    const openDoor: FlashDoorSample = {
      id: 'd1',
      centerX: 0,
      centerZ: 0,
      normalX: 0,
      normalZ: 1,
      sillY: 0,
      width: 1.0,
      height: 2.18,
      angle: 75,
      locked: false,
    };

    const plan = planDoorwayFlashThrow(origin, target, [openDoor], colliders, 9.8);
    expect(plan).not.toBeNull();
    expect(plan!.kind).toBe('doorway');
    expect(plan!.aimPoint.y).toBeLessThan(openDoor.height);
    expect(plan!.aimPoint.y).toBeCloseTo(1.05, 3);

    // Closed door (angle < 25) is rejected
    expect(planDoorwayFlashThrow(origin, target, [{ ...openDoor, angle: 10 }], colliders, 9.8)).toBeNull();
    // Locked door is rejected
    expect(planDoorwayFlashThrow(origin, target, [{ ...openDoor, locked: true }], colliders, 9.8)).toBeNull();
  });

  it('planWindowFlashThrow throws through an unboarded window and rejects a boarded window', () => {
    // Wall along z = 0 with window opening at x in [-0.7, 0.7], y in [0.9, 2.1]
    const baseWalls: Collider[] = [
      wall(-6, -0.7, -0.1, 0.1),
      wall(0.7, 6, -0.1, 0.1),
      wall(-0.7, 0.7, -0.1, 0.1, 0, 0.9),
      wall(-0.7, 0.7, -0.1, 0.1, 2.1, 3.0),
    ];
    const win: WindowDef = { x: 0, z: 0, yaw: 0, width: 1.4, height: 1.2, sill: 0.9, y: 0 };
    const origin = { x: -1.5, y: 1.4, z: 3.0 };
    const target = { x: 1.5, y: 0, z: -2.5 };

    // Unboarded window succeeds
    const plan = planWindowFlashThrow(origin, target, [win], baseWalls, 9.8);
    expect(plan).not.toBeNull();
    expect(plan!.kind).toBe('window');
    expect(plan!.aimPoint.y).toBeCloseTo(1.5, 3);

    // Boarded window (Fortify adds a wall collider covering the opening) is rejected
    const boardedBoard = wall(-0.7, 0.7, -0.05, 0.05, 0.9, 2.1);
    const blockedPlan = planWindowFlashThrow(origin, target, [win], [...baseWalls, boardedBoard], 9.8);
    expect(blockedPlan).toBeNull();
  });

  it('raycastWallXZ and planWallBankFlashThrow compute a 1-bounce bank around an L-corner', () => {
    // L-corridor:
    // - Divider wall blocks direct LOS between origin (0, 1.4, 3) and target (4, 0, 3) at x = 2, z in [1, 5]
    // - Far back wall at z = -0.2 (spanning x in [-2, 7]) reflects a throw angled toward (x=2, z=0) around the corner to target
    const colliders: Collider[] = [
      wall(1.8, 2.2, 1.0, 5.5),
      wall(-2.0, 7.0, -0.4, -0.2),
    ];
    const origin = { x: 0, y: 1.4, z: 2.5 };
    const target = { x: 4.0, y: 0, z: 2.5 };

    const hit = raycastWallXZ(colliders, origin, 0, -1, 10);
    expect(hit).not.toBeNull();
    expect(hit!.nx).toBe(0);
    expect(hit!.nz).toBe(1);

    const bank = planWallBankFlashThrow(origin, target, colliders, 9.8, 9);
    expect(bank).not.toBeNull();
    expect(bank!.kind).toBe('bank');
    expect(bank!.aimPoint.z).toBeGreaterThan(-0.2);
    expect(bank!.velocity.z).toBeLessThan(0); // thrown toward back wall
  });

  it('planFlashThrow prioritizes direct > doorway > window > bank', () => {
    const origin = { x: 0, y: 1.4, z: 4.0 };
    const target = { x: 0, y: 0, z: -1.0 };
    // Clear LOS -> direct
    const direct = planFlashThrow(origin, target, [], [], [], 9.8);
    expect(direct?.kind).toBe('direct');
  });
});
