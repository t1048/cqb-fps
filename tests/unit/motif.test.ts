import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateGeneratorTemplate } from '../../src/core/DataLoader';
import type { GeneratedMapRaw, MotifId } from '../../src/core/types';
import { MOTIF_IDS } from '../../src/core/types';
import { dressWithMotif, motifFromSeed, roleOf, withMotifBias } from '../../src/world/Motif';
import { generateMap } from '../../src/world/generator';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function bareMap(): GeneratedMapRaw {
  return {
    id: 'random_small',
    name: '住宅',
    seed: 7,
    briefing: { summary: '元の概要', estimatedSuspects: { min: 1, max: 2 }, estimatedHostages: { min: 1, max: 1 } },
    ceilingHeight: 3,
    floor: { width: 20, depth: 16 },
    playerSpawn: { x: 0, y: 0, z: 6, yaw: 0 },
    allies: [],
    walls: [
      { x: 0, z: -4, width: 8, height: 3, depth: 0.2 },
      { x: 0, z: 0, width: 0.2, height: 3, depth: 4 },
    ],
    doors: [{ id: 'd', x: 0, z: -4, yaw: 0, locked: false, maxAngle: 90 }],
    windows: [],
    covers: [{ x: 1, z: 1, width: 2.1, height: 0.6, depth: 1.5 }],
    entities: [],
    rooms: [
      { id: 'bedroom_1F_0', name: '寝室', x: 0, z: 0, width: 6, depth: 5, floorY: 0 },
      { id: 'hall_1F_0', name: '廊下', x: 0, z: -3, width: 6, depth: 1.5, floorY: 0 },
    ],
    floors: [{ x: 0, z: 0, width: 6, height: 0.2, depth: 5, y: -0.2, material: 'wood' }],
    stairs: [],
    items: [],
  };
}

describe('map motifs', () => {
  it('derives a stable motif from the seed and covers every motif', () => {
    expect(motifFromSeed(101).id).toBe(motifFromSeed(101).id);
    const seen = new Set<MotifId>();
    for (let s = 0; s < 400; s++) seen.add(motifFromSeed(s).id);
    expect([...seen].sort()).toEqual([...MOTIF_IDS].sort());
  });

  it('renames rooms and retints surfaces without moving collision boxes', () => {
    const src = bareMap();
    const seed = [...Array(400).keys()].find((s) => motifFromSeed(s).id === 'hospital') ?? 0;
    const dressed = dressWithMotif(src, seed);
    expect(dressed.motif).toBe('hospital');
    expect(dressed.rooms.map((r) => r.name).join(',')).not.toBe('寝室,廊下');
    expect(dressed.walls[0]).toMatchObject({ x: 0, z: -4, width: 8, height: 3, depth: 0.2 });
    expect(dressed.walls[1]).toMatchObject({ x: 0, z: 0, width: 0.2, height: 3, depth: 4 });
    expect(dressed.covers[0]).toMatchObject({ x: 1, z: 1, width: 2.1, height: 0.6, depth: 1.5 });
    expect(dressed.doors[0]).toMatchObject({ x: 0, z: -4 });
    expect(dressed.playerSpawn).toEqual(src.playerSpawn);
    expect(dressed.floors?.[0]?.material).toBeTruthy();
    expect(dressed.walls[0]?.material).toBe('brick');
    expect(dressed.walls[1]?.material).toBe('panel');
    expect(dressed.briefing.summary).not.toBe('元の概要');
  });

  it('classifies room ids into motif roles', () => {
    expect(roleOf('bedroom_1F_0')).toBe('private');
    expect(roleOf('vault_B1_0')).toBe('secure');
    expect(roleOf('garage_1F_0')).toBe('service');
    expect(roleOf('ldk_1F_0')).toBe('social');
    expect(roleOf('genkan_1F_0')).toBe('circ');
  });

  it('biases module weights without changing furniture dimensions', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/generators/house_compact.json'), 'utf8')) as unknown;
    const tpl = validateGeneratorTemplate(raw, 'house_compact.json');
    if (tpl.type !== 'modular') throw new Error('expected modular');
    const hospital = withMotifBias(tpl, motifFromSeed(0));
    // 0 が病院とは限らないので、明示的に病院定義を使う
    const motif = motifFromSeed(
      [...Array(400).keys()].find((s) => motifFromSeed(s).id === 'hospital') ?? 0,
    );
    expect(motif.id).toBe('hospital');
    const biased = withMotifBias(tpl, motif);
    const wing = tpl.modules.find((m) => m.category === 'wing_private');
    const wingB = biased.modules.find((m) => m.id === wing?.id);
    expect(wingB && wing && wingB.weight).toBeGreaterThan(wing.weight);
    expect(wingB?.width).toEqual(wing?.width);
    expect(wingB?.furniture).toBe(wing?.furniture);
    expect(biased.modules).toHaveLength(tpl.modules.length);
    expect(hospital.modules.length).toBe(tpl.modules.length);
  });

  it('generates two motifs with different names from the same template', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/generators/house_compact.json'), 'utf8')) as unknown;
    const tpl = validateGeneratorTemplate(raw, 'house_compact.json');
    const seeds = MOTIF_IDS.map((id) => [...Array(400).keys()].find((s) => motifFromSeed(s).id === id)).filter((s): s is number => s !== undefined);
    expect(seeds.length).toBe(MOTIF_IDS.length);
    const a = generateMap(tpl, seeds[0]!, 'random_small', 2.18);
    const b = generateMap(tpl, seeds[1]!, 'random_small', 2.18);
    expect(a.motif).not.toBe(b.motif);
    expect(a.name).not.toBe(b.name);
    expect(a.doors.length).toBeGreaterThan(0);
    expect(b.rooms.length).toBeGreaterThan(2);
    expect(a.playerSpawn.x).toEqual(expect.any(Number));
    const matsA = new Set(a.floors?.map((f) => f.material));
    const matsB = new Set(b.floors?.map((f) => f.material));
    expect([...matsA].sort().join(',')).not.toBe([...matsB].sort().join(','));
  });

  it('keeps the house as its own motif with tatami, wood and domestic room names', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/generators/house_compact.json'), 'utf8')) as unknown;
    const tpl = validateGeneratorTemplate(raw, 'house_compact.json');
    const seed = [...Array(400).keys()].find((s) => motifFromSeed(s).id === 'house');
    expect(seed).toBeTypeOf('number');
    const map = generateMap(tpl, seed!, 'random_small', 2.18);
    expect(map.motif).toBe('house');
    expect(map.name.startsWith('民家')).toBe(true);
    const names = map.rooms.map((r) => r.name).join(',');
    expect(names).toMatch(/座敷|寝室/);
    expect(names).toMatch(/浴室|縁側|台所|廊下/);
    const floors = new Set(map.floors?.map((f) => f.material));
    expect(floors.has('tatami')).toBe(true);
    expect(floors.has('wood')).toBe(true);
    const props = map.covers.map((c) => c.prop);
    expect(props).not.toContain('hbed');
    expect(props).not.toContain('piano');
    expect(props).toContain('bed');
    expect(map.walls.some((w) => w.material === 'plaster')).toBe(true);
    expect(map.walls.some((w) => w.material === 'siding')).toBe(true);
  });

  it('draws the pre-motif plaster map without renaming rooms or adding theme props', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/generators/house_compact.json'), 'utf8')) as unknown;
    const tpl = validateGeneratorTemplate(raw, 'house_compact.json');
    const seed = [...Array(400).keys()].find((s) => motifFromSeed(s).id === 'plain');
    expect(seed).toBeTypeOf('number');
    const map = generateMap(tpl, seed!, 'random_small', 2.18);
    expect(map.motif).toBe('plain');
    expect(map.name.startsWith('簡素')).toBe(true);
    const names = map.rooms.map((r) => r.name).join(',');
    expect(names).toMatch(/玄関|寝室|リビング|浴室|廊下/);
    expect(names).not.toMatch(/病室|病棟|座敷|窓口|荷捌き/);
    expect(map.walls.every((w) => w.material === undefined)).toBe(true);
    const floors = new Set(map.floors?.map((f) => f.material));
    expect(floors.has('wood')).toBe(true);
    expect(floors.has('tatami') || floors.has('linoleum') || floors.has('marble') || floors.has('siding')).toBe(false);
    const props = map.covers.map((c) => c.prop);
    expect(props).not.toContain('hbed');
    expect(props).not.toContain('piano');
    expect(props).not.toContain('lamp');
    expect(props).not.toContain('column');
    expect(props).not.toContain('engawa');
    expect(map.briefing.summary).not.toMatch(/病棟|金庫|荷捌き|クラブ/);
  });
});
