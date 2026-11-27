import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateAIProfiles,
  validateCrossReferences,
  validateGeneratorReferences,
  validateGeneratorTemplate,
  validateMap,
} from '../../src/core/DataLoader';
import type { MapData, RoomDef } from '../../src/core/types';
import { generateMap } from '../../src/world/generator';
import { hasFloorSupport, probeGround } from '../../src/world/Walk';
import { boxToAABB, WorldBuilder } from '../../src/world/WorldBuilder';
import { blockedAt } from '../../src/ai/EngageBehavior';
import { layoutStackSlots } from '../../src/ai/stackSlots';
import { createStubTextures } from '../e2e/helpers/headlessWorld';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadTemplate() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/generators/air_force_one.json'), 'utf8')) as unknown;
  return validateGeneratorTemplate(raw, 'air_force_one.json');
}

function loadProfiles() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/ai_profiles.json'), 'utf8')) as unknown;
  return validateAIProfiles(raw, 'ai_profiles.json');
}

function inRoomRect(r: RoomDef, x: number, z: number, pad = 0.05): boolean {
  return Math.abs(x - r.x) <= r.width / 2 + pad && Math.abs(z - r.z) <= r.depth / 2 + pad;
}

function onRoomBoundary(r: RoomDef, x: number, z: number, tol = 0.35): boolean {
  const dx = Math.abs(x - r.x);
  const dz = Math.abs(z - r.z);
  const onX = Math.abs(dx - r.width / 2) <= tol && dz <= r.depth / 2 + tol;
  const onZ = Math.abs(dz - r.depth / 2) <= tol && dx <= r.width / 2 + tol;
  return onX || onZ;
}

function verifyConnectivityFromMap(map: MapData): void {
  const parent = new Map<string, string>(map.rooms.map((r) => [r.id, r.id]));
  const find = (id: string): string => {
    let cur = id;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    let p = id;
    while (p !== cur) {
      const nxt = parent.get(p)!;
      parent.set(p, cur);
      p = nxt;
    }
    return cur;
  };
  const unite = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const d of map.doors) {
    const dy = d.y ?? 0;
    const matched = map.rooms.filter(
      (r) => Math.abs((r.floorY ?? 0) - dy) <= 0.45 && onRoomBoundary(r, d.x, d.z),
    );
    expect(matched.length, `door ${d.id} matched rooms`).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < matched.length; i++) unite(matched[0]!.id, matched[i]!.id);
  }

  for (const st of map.stairs) {
    const yawRad = (st.yaw * Math.PI) / 180;
    const fx = -Math.sin(yawRad);
    const fz = -Math.cos(yawRad);
    const reach = (st.steps * st.run) / 2 + 0.3;
    const lowX = st.x - fx * reach;
    const lowZ = st.z - fz * reach;
    const lowY = st.y ?? 0;
    const highX = st.x + fx * reach;
    const highZ = st.z + fz * reach;
    const highY = lowY + st.steps * st.rise;

    const lowRooms = map.rooms.filter(
      (r) => Math.abs((r.floorY ?? 0) - lowY) <= 0.45 && inRoomRect(r, lowX, lowZ, 0.25),
    );
    const highRooms = map.rooms.filter(
      (r) => Math.abs((r.floorY ?? 0) - highY) <= 0.45 && inRoomRect(r, highX, highZ, 0.25),
    );
    expect(lowRooms.length, `stair ${st.id} low rooms`).toBeGreaterThanOrEqual(1);
    expect(highRooms.length, `stair ${st.id} high rooms`).toBeGreaterThanOrEqual(1);
    for (const lr of lowRooms) {
      for (const hr of highRooms) unite(lr.id, hr.id);
    }
  }

  const spawnRoom = map.rooms.find(
    (r) => Math.abs((r.floorY ?? 0) - map.playerSpawn.y) <= 0.45 && inRoomRect(r, map.playerSpawn.x, map.playerSpawn.z),
  );
  expect(spawnRoom).toBeTruthy();
  const root = find(spawnRoom!.id);
  for (const r of map.rooms) {
    if (!r.outdoor) {
      expect(find(r.id), `room ${r.id} (${r.name}) reachable from spawn`).toBe(root);
    }
  }
}

describe('AircraftGenerator (air_force_one)', () => {
  it('validates template and cross-references across seeds 1..40', () => {
    const tpl = loadTemplate();
    expect(tpl.type).toBe('aircraft');
    const profiles = loadProfiles();
    validateGeneratorReferences(tpl, profiles);

    let sawLower = false;
    let sawNoLower = false;
    let sawOnePlatform = false;
    let sawTwoPlatforms = false;
    const indoorCounts = new Set<number>();

    for (let seed = 1; seed <= 40; seed++) {
      const raw = generateMap(tpl, seed, 'random_air_force_one', 2.18);
      const map = validateMap(raw, `air_force_one#${seed}`);
      validateCrossReferences(map, profiles);

      expect(map.motif).toBe('air_force_one');
      expect(map.playerSpawn.y).toBe(0);

      const indoor = map.rooms.filter((r) => !r.outdoor);
      expect(indoor.length).toBeGreaterThanOrEqual(12);
      indoorCounts.add(indoor.length);

      const suspects = map.entities.filter((e) => e.type === 'suspect');
      const civilians = map.entities.filter((e) => e.type === 'civilian');
      expect(suspects.length).toBeGreaterThanOrEqual(3);
      expect(civilians.length).toBeGreaterThanOrEqual(3);

      for (const st of map.stairs) {
        expect(Math.abs(st.steps * st.rise - 3.04)).toBeLessThanOrEqual(0.01);
      }

      const coverAABBs = map.covers.map((c) => boxToAABB(c));
      for (const e of map.entities) {
        const ey = e.y ?? 0;
        const room = indoor.find((r) => Math.abs((r.floorY ?? 0) - ey) <= 0.05 && inRoomRect(r, e.x, e.z, 0.05));
        expect(room, `entity ${e.id} inside indoor room at y=${ey}`).toBeTruthy();

        for (const a of coverAABBs) {
          if (a.max.y <= ey + 0.05 || a.min.y >= ey + 1.6) continue;
          const insideX = e.x >= a.min.x && e.x <= a.max.x;
          const insideZ = e.z >= a.min.z && e.z <= a.max.z;
          expect(insideX && insideZ, `entity ${e.id} not inside cover`).toBe(false);
        }
      }

      verifyConnectivityFromMap(map);

      const hasLower = indoor.some((r) => Math.abs((r.floorY ?? 0) - 0) < 0.1);
      if (hasLower) sawLower = true;
      else sawNoLower = true;

      const platforms = map.rooms.filter((r) => r.outdoor && (r.floorY ?? 0) > 1);
      if (platforms.length === 1) sawOnePlatform = true;
      if (platforms.length === 2) sawTwoPlatforms = true;
    }

    expect(sawLower).toBe(true);
    expect(sawNoLower).toBe(true);
    expect(sawOnePlatform).toBe(true);
    expect(sawTwoPlatforms).toBe(true);
    expect(indoorCounts.size).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic for identical seeds', () => {
    const tpl = loadTemplate();
    const a = generateMap(tpl, 17, 'random_air_force_one', 2.18);
    const b = generateMap(tpl, 17, 'random_air_force_one', 2.18);
    expect(a).toEqual(b);
  });

  it('builds WorldBuilder and provides walkable floor support at spawn and main deck', () => {
    const tpl = loadTemplate();
    for (const seed of [1, 7, 19]) {
      const map = validateMap(generateMap(tpl, seed, 'random_air_force_one', 2.18));
      const textures = createStubTextures();
      const world = new WorldBuilder(map, textures);
      try {
        const spawnSupport = probeGround(world.colliders, map.playerSpawn.x, map.playerSpawn.z, 0, 0.3, false);
        expect(spawnSupport).not.toBeNull();
        expect(Math.abs(spawnSupport! - 0)).toBeLessThan(0.05);

        const corridor = map.rooms.find((r) => !r.outdoor && Math.abs((r.floorY ?? 0) - 3.04) < 0.1 && r.id.startsWith('corridor'));
        expect(corridor).toBeTruthy();
        const mainSupport = probeGround(world.colliders, corridor!.x, corridor!.z, 3.04 + 0.05, 0.3, false);
        expect(mainSupport).not.toBeNull();
        expect(Math.abs(mainSupport! - 3.04)).toBeLessThan(0.05);
      } finally {
        world.dispose();
        textures.dispose();
      }
    }
  });

  it('keeps all 3-4 stack slots on the airstair platform without dropping to the apron', () => {
    const tpl = loadTemplate();
    for (const seed of [1, 7, 17, 19]) {
      const map = validateMap(generateMap(tpl, seed, 'random_air_force_one', 2.18));
      const textures = createStubTextures();
      const world = new WorldBuilder(map, textures);
      try {
        const plat = map.rooms.find((r) => r.id === 'airstair_fwd_platform');
        expect(plat).toBeTruthy();
        const door = map.doors.find((d) => d.id.includes('airstair_fwd_platform'));
        expect(door).toBeTruthy();
        const sillY = door!.y ?? 0;
        // タラップ踊り場側から機内へ向かう方向を算出
        const dx = door!.x - plat!.x;
        const dz = door!.z - plat!.z;
        const len = Math.hypot(dx, dz);
        const intoX = dx / len;
        const intoZ = dz / len;
        const axisX = -intoZ;
        const axisZ = intoX;

        const standable = (x: number, z: number): boolean =>
          !blockedAt(world.colliders, x, z, 0.3, sillY) && hasFloorSupport(world.colliders, x, z, sillY, 0.3, false);

        // 踊り場外（真下にエプロン y=0 がある空中位置）は立てないこと
        const offPlatX = plat!.x + axisX * (Math.max(plat!.width, plat!.depth) / 2 + 0.8);
        const offPlatZ = plat!.z + axisZ * (Math.max(plat!.width, plat!.depth) / 2 + 0.8);
        expect(hasFloorSupport(world.colliders, offPlatX, offPlatZ, sillY, 0.3, false)).toBe(false);

        for (const count of [3, 4]) {
          const slots = layoutStackSlots(
            { centerX: door!.x, centerZ: door!.z, intoX, intoZ, axisX, axisZ, width: door!.width ?? 1.2 },
            count,
            0.48,
            0.68,
            standable,
          );
          expect(slots).toHaveLength(count);
          for (const slot of slots) {
            expect(standable(slot.x, slot.z), `seed=${seed} count=${count} slot=(${slot.x},${slot.z})`).toBe(true);
            const g = probeGround(world.colliders, slot.x, slot.z, sillY, 0.3, false);
            expect(g).not.toBeNull();
            expect(Math.abs(g! - sillY)).toBeLessThan(0.25);
            expect(inRoomRect(plat!, slot.x, slot.z, 0.05)).toBe(true);
          }
        }
      } finally {
        world.dispose();
        textures.dispose();
      }
    }
  });
});
