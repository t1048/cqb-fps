import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { raycastColliders } from '../../src/world/ColliderIndex';
import { HumanoidBody } from '../../src/ai/HumanoidBody';
import { SwatTeam, type SwatTeamDeps } from '../../src/modes/SwatTeam';
import { createGameEventBus } from '../../src/core/events';
import type { Collider } from '../../src/world/WorldBuilder';
import type { DoorSystem } from '../../src/world/Door';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { Flashbang } from '../../src/weapons/Flashbang';
import type { Subtitle } from '../../src/ui/Subtitle';

function boxCollider(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  kind: Collider['kind'] = 'wall',
): Collider {
  return { kind, aabb: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } };
}

describe('F11 — Tactical Laser & Flashlight Beams', () => {
  it('raycastColliders returns exact nearest hit in both brute-force (<48) and indexed DDA (>=48) modes', () => {
    const nearWall = boxCollider(-2, 0, -5.2, 2, 3, -5.0);
    const farWall = boxCollider(-2, 0, -10.2, 2, 3, -10.0);
    const behindWall = boxCollider(-2, 0, 3.0, 2, 3, 3.2);

    // Brute-force path (< 48 colliders)
    const small = [farWall, nearWall, behindWall];
    expect(raycastColliders(small, { x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, 20)).toBeCloseTo(5.0, 5);
    expect(raycastColliders(small, { x: 0, y: 1.5, z: 0 }, { x: 1, y: 0, z: 0 }, 15)).toBe(15);
    expect(raycastColliders(small, { x: 0, y: 4.5, z: 0 }, { x: 0, y: 0, z: -1 }, 20)).toBe(20);

    // Indexed DDA path (>= 48 colliders)
    const many: Collider[] = [...small];
    for (let i = 0; i < 60; i++) {
      many.push(boxCollider(20 + i * 2, 0, 20, 21 + i * 2, 3, 21));
    }
    expect(raycastColliders(many, { x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, 20)).toBeCloseTo(5.0, 5);
    expect(raycastColliders(many, { x: 0, y: 1.5, z: 0 }, { x: 1, y: 0, z: 0 }, 15)).toBe(15);
  });

  it('raycastColliders handles edge cases: maxDist <= 0, zero dir, vertical ray, inside AABB, and dynamic door sweep', () => {
    const floor = boxCollider(-5, -0.2, -5, 5, 0, 5, 'floor');
    const door: Collider = {
      kind: 'door',
      aabb: { min: { x: -1, y: 0, z: -4.1 }, max: { x: 1, y: 2.2, z: -3.9 } },
      sweep: { minX: -1.2, minZ: -5.2, maxX: 1.2, maxZ: -3.8 },
    };
    const colliders: Collider[] = [floor, door];
    for (let i = 0; i < 50; i++) {
      colliders.push(boxCollider(30 + i * 2, 0, 30, 31 + i * 2, 3, 31));
    }

    expect(raycastColliders(colliders, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 0)).toBe(0);
    expect(raycastColliders(colliders, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, 10)).toBe(10);
    // Purely vertical ray hitting floor
    expect(raycastColliders(colliders, { x: 0, y: 2.0, z: 0 }, { x: 0, y: -1, z: 0 }, 10)).toBeCloseTo(2.0, 5);
    // Starting inside AABB returns 0
    expect(raycastColliders(colliders, { x: 0, y: 1.0, z: -4.0 }, { x: 0, y: 0, z: -1 }, 10)).toBe(0);
    // Closed door clips at z = -3.9 (distance 3.9)
    expect(raycastColliders(colliders, { x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 12)).toBeCloseTo(3.9, 5);

    // Swing door open in-place -> ray passes through!
    door.aabb.min.x = 0.85;
    door.aabb.max.x = 1.05;
    door.aabb.min.z = -5.0;
    door.aabb.max.z = -4.0;
    expect(raycastColliders(colliders, { x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 12)).toBe(12);
  });

  it('HumanoidBody.getMuzzlePose returns world muzzle origin and unit -Z forward, and false when unarmed/down/kneel', () => {
    const armed = new HumanoidBody(2, 3, 0, 0x2b3440, true, { role: 'ally', footY: 0 });
    const origin = { x: 0, y: 0, z: 0 };
    const dir = { x: 0, y: 0, z: 0 };

    expect(armed.getMuzzlePose(origin, dir)).toBe(true);
    expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 5);
    expect(dir.z).toBeLessThan(-0.9);
    expect(origin.y).toBeGreaterThan(0.8);

    // Rotated 90 deg CCW around Y: local -Z maps to world -X
    const rotated = new HumanoidBody(0, 0, 90, 0x2b3440, true, { role: 'ally', footY: 0 });
    expect(rotated.getMuzzlePose(origin, dir)).toBe(true);
    expect(dir.x).toBeLessThan(-0.9);
    expect(Math.abs(dir.z)).toBeLessThan(0.15);

    // Downed & kneeling return false
    armed.setPose('kneel');
    expect(armed.getMuzzlePose(origin, dir)).toBe(false);
    armed.setPose('down');
    expect(armed.getMuzzlePose(origin, dir)).toBe(false);

    // Unarmed returns false
    const unarmed = new HumanoidBody(0, 0, 0, 0x2b3440, false, { role: 'civilian', footY: 0 });
    expect(unarmed.getMuzzlePose(origin, dir)).toBe(false);

    armed.dispose();
    rotated.dispose();
    unarmed.dispose();
  });

  it('SwatTeam renders additive MeshBasicMaterial laser/flashlight optics with ZERO dynamic lights, clips to walls, and hides on death', () => {
    const bus = createGameEventBus();
    const wall = boxCollider(-5, 0, -3.2, 5, 3, -3.0);
    const playerPos = new THREE.Vector3(20, 0, 20);
    const deps: SwatTeamDeps = {
      spawns: [{ x: 0, y: 0, z: 2 }],
      count: 2,
      player: {
        alive: true,
        isCrouching: false,
        yawRad: 0,
        position: playerPos,
        getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
        takeDamage: () => 100,
      },
      colliders: [boxCollider(-30, -0.1, -30, 30, 0, 30, 'floor'), wall],
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [] } as unknown as DoorSystem,
      bounds: { width: 40, depth: 40 },
      stairs: [],
      rooms: [{ id: 'r1', name: '部屋', x: 0, z: -2, width: 8, depth: 8, floorY: 0 }],
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    };
    const team = new SwatTeam(deps);

    // Only the pre-allocated c2BlastLight should exist in team.root (zero lights added for optics)
    let lightCount = 0;
    const opticsGroups: THREE.Group[] = [];
    team.root.traverse((obj) => {
      if (obj instanceof THREE.Light) lightCount++;
      if (obj instanceof THREE.Group && obj.name === 'tacticalOptics') opticsGroups.push(obj);
    });
    expect(lightCount).toBe(1);
    expect(opticsGroups.length).toBe(2);

    // All optics meshes must strictly use additive transparent MeshBasicMaterial with depthWrite: false
    for (const grp of opticsGroups) {
      expect(grp.visible).toBe(false); // Hidden while staging
      grp.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          expect(child.material).toBeInstanceOf(THREE.MeshBasicMaterial);
          const mat = child.material as THREE.MeshBasicMaterial;
          expect(mat.transparent).toBe(true);
          expect(mat.blending).toBe(THREE.AdditiveBlending);
          expect(mat.depthWrite).toBe(false);
        }
      });
    }

    team.beginAssault();
    team.update(0.05);
    expect(opticsGroups.some((g) => g.visible)).toBe(true);

    // Point first hunter directly at the wall at z = -3.0 from z = 2.0 (distance ~5m)
    const h0 = team.hunters[0]!;
    h0.body.setPosition(0, 2, 0);
    h0.body.group.rotation.y = 0;
    h0.state = 'sweep';
    team.update(0.05);
    expect(h0.optics.group.visible).toBe(true);
    expect(h0.optics.laserMesh.scale.z).toBeLessThanOrEqual(5.2);
    expect(h0.optics.dotMesh.visible).toBe(true);

    // Kill hunter -> optics hide immediately
    h0.takeHit(999, { x: 0, y: 1, z: 0 });
    expect(h0.optics.group.visible).toBe(false);

    team.dispose();
  });
});
