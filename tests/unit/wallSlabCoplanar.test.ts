import { describe, expect, it, vi } from 'vitest';
// 結合前のメッシュ名（wall / floor）で判定するため、静的バッチは無効化する
vi.mock('../../src/world/StaticBatcher', () => ({ batchStaticMeshes: () => {} }));
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { validateGeneratorTemplate, validateMap } from '../../src/core/DataLoader';
import { generateMap } from '../../src/world/generator';
import { pickStageVariant } from '../../src/world/generator/StageVariant';
import type { TextureLibrary } from '../../src/world/Materials';
import { WorldBuilder } from '../../src/world/WorldBuilder';

const stubTextures = (): TextureLibrary => {
  const t = new THREE.Texture();
  return { get: () => t, getDecal: () => t, getDerivedMaps: () => ({ bumpMap: t, roughnessMap: t }) } as unknown as TextureLibrary;
};

/**
 * 下階の壁の上端が上階の床スラブ上面と同じ高さにあると、壁の天端が床と同一平面になりちらつく。
 * B1→1F、1F→2F など階を問わず、上から見た床面に壁の天端が重ならないことを確かめる。
 */
describe('壁の天端と床スラブ上面の同一平面', () => {
  const stages = JSON.parse(readFileSync('public/data/stages.json', 'utf8')).stages as { id: string; generator?: string }[];
  for (const stage of stages.filter((s) => s.generator)) {
    it(`${stage.id}: どの階でも床面に壁の天端が重ならない`, () => {
      const levels = new Set<string>();
      let checked = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const picked = pickStageVariant(stage as never, seed);
        const tpl = validateGeneratorTemplate(JSON.parse(readFileSync(`public/data/generators/${picked.generator}.json`, 'utf8')));
        const map = validateMap(generateMap(tpl as never, seed, stage.id, 2.1, picked.motif));
        const world = new WorldBuilder(map, stubTextures());
        world.root.updateMatrixWorld(true);
        const meshes: THREE.Object3D[] = [];
        world.root.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) meshes.push(o);
        });
        for (const w of map.walls) {
          const top = (w.y ?? 0) + w.height;
          if (!map.floors.some((f) => Math.abs((f.y ?? 0) + f.height - top) < 0.03)) continue;
          levels.add(top.toFixed(2));
          const along = w.width >= w.depth;
          for (const u of [-0.47, 0.013, 0.46]) {
            for (const c of [-0.4, 0.013, 0.4]) {
              const x = w.x + (along ? u * w.width : c * w.width);
              const z = w.z + (along ? c * w.depth : u * w.depth);
              const hits = new THREE.Raycaster(new THREE.Vector3(x, top + 1, z), new THREE.Vector3(0, -1, 0), 0, 2).intersectObjects(meshes, false);
              if (!hits.length) continue;
              const y0 = hits[0]!.point.y;
              const kinds = new Set(
                hits.filter((h) => Math.abs(h.point.y - y0) < 0.03 && (h.face?.normal.y ?? 0) > 0.5).map((h) => h.object.name.split(':')[0]),
              );
              expect(kinds.has('wall') && kinds.size > 1, `seed ${seed} 壁 (${w.x}, ${w.z}) 上端 ${top}`).toBe(false);
              checked++;
            }
          }
        }
        world.dispose();
      }
      expect(checked).toBeGreaterThan(50);
      expect(levels.size).toBeGreaterThanOrEqual(2); // 地下→1F と 1F→2F の両方を含む
    });
  }
});
