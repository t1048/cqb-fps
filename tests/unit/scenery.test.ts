import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateGeneratorTemplate, validateMap } from '../../src/core/DataLoader';
import type { MotifId } from '../../src/core/types';
import { motifFromSeed, SEEDED_MOTIF_IDS } from '../../src/world/Motif';
import { buildScenery } from '../../src/world/Scenery';
import { generateMap } from '../../src/world/generator';
import * as THREE from 'three';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function template() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/generators/house_compact.json'), 'utf8')) as unknown;
  return validateGeneratorTemplate(raw, 'house_compact.json');
}

function mapFor(id: MotifId) {
  const seed = [...Array(400).keys()].find((s) => motifFromSeed(s).id === id);
  if (seed === undefined) throw new Error(id);
  return generateMap(template(), seed, 'random_small', 2.18);
}

const mat = () => new THREE.MeshStandardMaterial();

describe('motif scenery', () => {
  it('builds a bed and a piano from several parts', () => {
    const bed = buildScenery({ x: 0, z: 0, width: 2, height: 0.85, depth: 1.4, prop: 'hbed' }, mat);
    const piano = buildScenery({ x: 1, z: 1, width: 1.45, height: 1.28, depth: 0.7, prop: 'piano' }, mat);
    expect(bed).not.toBeNull();
    expect(piano).not.toBeNull();
    expect(bed!.children.length).toBeGreaterThan(6);
    expect(piano!.children.length).toBeGreaterThan(8);
    expect(buildScenery({ x: 0, z: 0, width: 1, height: 1, depth: 1, prop: 'car' }, mat)).toBeNull();
  });

  it('keeps prop ids through map validation', () => {
    const map = mapFor('hospital');
    const validated = validateMap(map);
    const props = validated.covers.map((c) => c.prop).filter((p): p is string => !!p);
    expect(props).toContain('toilet');
    expect(props).toContain('hbed');
    expect(props).toContain('lamp');
    expect(validated.rooms.some((r) => r.name.includes('トイレ') || r.name.includes('メインホール'))).toBe(true);
    expect(validated.playerSpawn).toEqual(map.playerSpawn);
    expect(validated.doors.map((d) => d.id).sort()).toEqual(map.doors.map((d) => d.id).sort());
  });

  it('places a signature prop for every motif without covering the spawn', () => {
    const want: Partial<Record<MotifId, string>> = {
      hospital: 'hbed',
      clubhouse: 'piano',
      bank: 'teller',
      office: 'desk',
      warehouse: 'shelf',
      embassy: 'banquet_table',
      japanese_house: 'bed',
    };
    for (const id of SEEDED_MOTIF_IDS) {
      const map = mapFor(id);
      if (id === 'residence') {
        expect(map.rooms.some((r) => /玄関|寝室|リビング|浴室/.test(r.name)), id).toBe(true);
        expect(map.covers.some((c) => c.prop === 'hbed' || c.prop === 'piano' || c.prop === 'lamp'), id).toBe(false);
      } else {
        expect(map.covers.some((c) => c.prop === want[id]), id).toBe(true);
        expect(map.covers.some((c) => c.prop === 'toilet'), id).toBe(true);
      }
      for (const c of map.covers) {
        const dx = c.x - map.playerSpawn.x;
        const dz = c.z - map.playerSpawn.z;
        if (Math.hypot(dx, dz) < 1.4 && Math.abs((c.y ?? 0) - map.playerSpawn.y) < 0.8) {
          throw new Error(`${id} prop ${c.prop} covers the spawn`);
        }
      }
    }
  });

  it('opens an upper-floor void with rails when the building has two stories', () => {
    const tpl = template();
    let found = false;
    for (let seed = 0; seed < 120 && !found; seed++) {
      const map = generateMap(tpl, seed, 'random_small', 2.18);
      if (map.motif === 'residence') continue;
      const upper = map.rooms.some((r) => !r.outdoor && (r.floorY ?? 0) > 2);
      if (!upper) continue;
      const rails = map.covers.filter((c) => c.prop === 'rail');
      // 吹き抜けは 1F/2F の重なり幅 (2 * ATRIUM_GALLERY_MIN + ATRIUM_HOLE_MIN_SIDE) や
      // ドア・階段とのクリアランス条件を満たす間取りでのみ開口される。
      if (rails.length === 0) continue;
      found = true;
      expect(rails.length).toBeGreaterThan(0);
      expect(map.stairs?.length ?? 0).toBeGreaterThan(0);
      const hall = map.rooms.find((r) => /ホール|ラウンジ|ロビー|座敷/.test(r.name));
      expect(hall).toBeTruthy();
    }
    expect(found).toBe(true);
  });

  it('never generates beam props and keeps stair cores and stairs clear of hall ceiling props', () => {
    const files = ['house_compact.json', 'house.json', 'embassy.json'] as const;
    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/generators', file), 'utf8')) as unknown;
      const tpl = validateGeneratorTemplate(raw, file);
      for (const seed of [0, 1, 2, 7, 13, 42]) {
        const map = generateMap(tpl, seed, 'random_house', 2.18, 'hospital');
        expect(map.covers.some((c) => c.prop === 'beam'), `${file} seed=${seed}`).toBe(false);
        for (const r of map.rooms) {
          if (r.id.startsWith('core')) {
            expect(/ホール|ラウンジ|ロビー|座敷/.test(r.name), `${file} seed=${seed} ${r.id}`).toBe(false);
          }
        }
        for (const c of map.covers) {
          if (c.prop !== 'lamp') continue;
          const cy = c.y ?? 0;
          for (const st of map.stairs ?? []) {
            const baseY = st.y ?? 0;
            if (Math.abs(baseY - cy) > 2.5 && Math.abs(baseY + st.steps * st.rise - cy) > 2.5) continue;
            const yawRad = ((st.yaw ?? 0) * Math.PI) / 180;
            const cos = Math.abs(Math.cos(yawRad));
            const sin = Math.abs(Math.sin(yawRad));
            const stLen = st.steps * st.run;
            const hx = (st.width * cos + stLen * sin) / 2;
            const hz = (st.width * sin + stLen * cos) / 2;
            const overlaps =
              c.x + c.width / 2 > st.x - hx &&
              c.x - c.width / 2 < st.x + hx &&
              c.z + c.depth / 2 > st.z - hz &&
              c.z - c.depth / 2 < st.z + hz;
            expect(overlaps, `${file} seed=${seed} lamp overlaps stair`).toBe(false);
          }
        }
      }
    }
  });
});
