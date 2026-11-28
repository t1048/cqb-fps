import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { validateGeneratorTemplate, validateMap } from '../../src/core/DataLoader';
import type { MapData, RoomDef } from '../../src/core/types';
import { generateMap } from '../../src/world/generator';
import { pickStageVariant } from '../../src/world/generator/StageVariant';
import type { TextureLibrary } from '../../src/world/Materials';
import { WorldBuilder } from '../../src/world/WorldBuilder';

/** テクスチャ名ごとに別の Texture を返すスタブ。統合後のメッシュでも材質名を map.name で引ける。 */
function namedTextures(): TextureLibrary {
  const cache = new Map<string, THREE.Texture>();
  const named = (n: string): THREE.Texture => {
    let t = cache.get(n);
    if (!t) {
      t = new THREE.Texture();
      t.name = n;
      cache.set(n, t);
    }
    return t;
  };
  return {
    get: (n: string) => named(n),
    getDecal: (k: string) => named(`decal:${k}`),
    getDerivedMaps: () => ({ bumpMap: named('bump'), roughnessMap: named('rough') }),
  } as unknown as TextureLibrary;
}

function loadMap(stageId: string, wantMotif: string, needBasement: boolean): MapData {
  const stages = JSON.parse(readFileSync('public/data/stages.json', 'utf8')).stages as { id: string; generator: string }[];
  const stage = stages.find((s) => s.id === stageId)!;
  for (let seed = 1; seed < 600; seed++) {
    const picked = pickStageVariant(stage as never, seed);
    if (picked.motif !== wantMotif) continue;
    const tpl = validateGeneratorTemplate(JSON.parse(readFileSync(`public/data/generators/${picked.generator}.json`, 'utf8')));
    const map = validateMap(generateMap(tpl as never, seed, stageId, 2.1, picked.motif));
    if (!needBasement || map.rooms.some((r) => (r.floorY ?? 0) < 0)) return map;
  }
  throw new Error(`no ${wantMotif} map`);
}

function surfaceAt(world: WorldBuilder, from: THREE.Vector3, dir: THREE.Vector3): string | undefined {
  world.root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(from, dir.normalize(), 0, 30);
  const meshes: THREE.Object3D[] = [];
  world.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.MeshStandardMaterial).map) meshes.push(m);
  });
  const hit = ray.intersectObjects(meshes, false)[0];
  return ((hit?.object as THREE.Mesh | undefined)?.material as THREE.MeshStandardMaterial | undefined)?.map?.name;
}

const center = (r: RoomDef, dy: number): THREE.Vector3 => new THREE.Vector3(r.x, (r.floorY ?? 0) + dy, r.z);

describe('部屋ごとの内装', () => {
  for (const motif of ['japanese_house', 'residence', 'office']) {
    it(`${motif}: 地下室の天井は上階の床材（畳・絨毯・板張り）ではない`, () => {
      const stage = motif === 'office' ? 'random_house' : 'random_small';
      let map: MapData;
      try {
        map = loadMap(stage, motif, true);
      } catch {
        map = loadMap('random_small', motif, true);
      }
      const world = new WorldBuilder(map, namedTextures());
      const basement = map.rooms.filter((r) => !r.outdoor && (r.floorY ?? 0) < 0 && !r.id.startsWith('core'));
      expect(basement.length).toBeGreaterThan(0);
      for (const r of basement) {
        // 照明器具（部屋中央）を避けて少し外した位置から真上を見る
        const ceil = surfaceAt(world, center(r, 1.5).add(new THREE.Vector3(Math.min(1, r.width / 4), 0, Math.min(1, r.depth / 4))), new THREE.Vector3(0, 1, 0));
        expect(ceil, `${r.id} の天井`).toBeDefined();
        expect(['tatami', 'carpet', 'wood', 'marble', 'linoleum']).not.toContain(ceil);
        // 地下の壁は外装（サイディング・レンガ等）にならない
        for (const d of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)]) {
          const wall = surfaceAt(world, center(r, 1.2), d);
          if (wall === undefined) continue;
          if (['metal', 'wood', 'fabric', 'linen'].includes(wall)) continue; // 家具・扉
          expect(['siding', 'brick'], `${r.id} の壁`).not.toContain(wall);
        }
      }
      world.dispose();
    });
  }

  it('外壁の室内側には外装材ではなく内装材を貼る', () => {
    const map = loadMap('random_small', 'japanese_house', false);
    const world = new WorldBuilder(map, namedTextures());
    let checked = 0;
    for (const r of map.rooms.filter((x) => !x.outdoor && (x.floorY ?? 0) === 0)) {
      for (const d of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)]) {
        const tex = surfaceAt(world, center(r, 1.7), d);
        if (tex === undefined) continue;
        checked++;
        expect(tex, `${r.id}`).not.toBe('siding');
      }
    }
    expect(checked).toBeGreaterThan(4);
    world.dispose();
  });
  it('地下の壁の天端が 1F 床面と同一平面に重ならない（床のちらつき防止）', () => {
    const map = loadMap('random_small', 'clubhouse', true);
    const world = new WorldBuilder(map, namedTextures());
    world.root.updateMatrixWorld(true);
    const meshes: THREE.Object3D[] = [];
    world.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.MeshStandardMaterial).map) meshes.push(m);
    });
    const tops = map.walls.filter((w) => Math.abs((w.y ?? 0) + w.height) < 0.02 && (w.y ?? 0) < -1);
    const slabs = map.floors.filter((f) => Math.abs((f.y ?? 0) + f.height) < 0.02);
    let checked = 0;
    for (const w of tops) {
      const under = slabs.some((f) => Math.abs(w.x - f.x) < f.width / 2 - 0.3 && Math.abs(w.z - f.z) < f.depth / 2 - 0.3);
      if (!under) continue;
      const ray = new THREE.Raycaster(new THREE.Vector3(w.x, 1, w.z), new THREE.Vector3(0, -1, 0), 0, 2);
      const atFloor = ray.intersectObjects(meshes, false).filter((h) => Math.abs(h.point.y) < 0.005);
      const names = new Set(atFloor.map((h) => ((h.object as THREE.Mesh).material as THREE.MeshStandardMaterial).map?.name));
      expect(names.size, `壁 (${w.x}, ${w.z}) の天端`).toBeLessThanOrEqual(1);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    world.dispose();
  });
});
