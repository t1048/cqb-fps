import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateGeneratorTemplate, validateMap } from '../../src/core/DataLoader';
import type { MotifId } from '../../src/core/types';
import { MOTIF_IDS } from '../../src/core/types';
import { motifFromSeed } from '../../src/world/Motif';
import { buildScenery } from '../../src/world/Scenery';
import { generateMap } from '../../src/world/generator';
import * as THREE from 'three';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function template() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/generators/house_compact.json'), 'utf8')) as unknown;
  return validateGeneratorTemplate(raw, 'house_compact.json');
}

function mapFor(id: MotifId) {
  const seed = [...Array(240).keys()].find((s) => motifFromSeed(s).id === id);
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
    const want: Record<MotifId, string> = {
      hospital: 'hbed',
      clubhouse: 'piano',
      bank: 'teller',
      office: 'desk',
      warehouse: 'shelf',
      house: 'bed',
    };
    for (const id of MOTIF_IDS) {
      const map = mapFor(id);
      expect(map.covers.some((c) => c.prop === want[id]), id).toBe(true);
      expect(map.covers.some((c) => c.prop === 'toilet'), id).toBe(true);
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
    for (let seed = 0; seed < 60 && !found; seed++) {
      const map = generateMap(tpl, seed, 'random_small', 2.18);
      const upper = map.rooms.some((r) => !r.outdoor && (r.floorY ?? 0) > 2);
      if (!upper) continue;
      found = true;
      const rails = map.covers.filter((c) => c.prop === 'rail');
      expect(rails.length).toBeGreaterThan(0);
      expect(map.stairs?.length ?? 0).toBeGreaterThan(0);
      const hall = map.rooms.find((r) => /ホール|ラウンジ|ロビー|座敷/.test(r.name));
      expect(hall).toBeTruthy();
    }
    expect(found).toBe(true);
  });
});
