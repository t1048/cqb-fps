import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import type { WeaponDef, WindowDef } from '../../src/core/types';
import type { InputManager } from '../../src/core/InputManager';
import { Fortify } from '../../src/modes/Fortify';
import { suspectLoadout } from '../../src/modes/SuspectLoadout';
import { suspectWeapons } from '../../src/modes/SuspectMode';
import type { Interaction } from '../../src/player/Interaction';
import type { PlayerController } from '../../src/player/PlayerController';
import type { Subtitle } from '../../src/ui/Subtitle';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { DoorSystem } from '../../src/world/Door';
import type { TextureLibrary } from '../../src/world/Materials';
import type { Collider } from '../../src/world/WorldBuilder';

describe('容疑者モードの持ち込み装備（建物の規模で増える）', () => {
  it('小さな民家は従来どおり、面積が広いほど弾薬・トラップ・救急キット・補強材が増え、上限で止まる', () => {
    const small = suspectLoadout(350);
    expect(small).toEqual({ reserveMagazines: 3, trapKits: 2, craftedTraps: 2, medkits: 0, barricadeHpMul: 1 });

    const medium = suspectLoadout(1000);
    const large = suspectLoadout(1700);
    expect(medium.reserveMagazines).toBe(6);
    expect(large.reserveMagazines).toBeGreaterThan(medium.reserveMagazines);
    expect(large.trapKits).toBeGreaterThan(medium.trapKits);
    expect(medium.trapKits).toBeGreaterThan(small.trapKits);
    expect(large.craftedTraps).toBeGreaterThanOrEqual(medium.craftedTraps);
    expect(medium.medkits).toBeGreaterThanOrEqual(1);
    expect(large.medkits).toBeGreaterThan(medium.medkits);
    expect(large.barricadeHpMul).toBeGreaterThan(medium.barricadeHpMul);
    expect(medium.barricadeHpMul).toBeGreaterThan(1);

    expect(suspectLoadout(100000)).toEqual({ reserveMagazines: 10, trapKits: 6, craftedTraps: 4, medkits: 3, barricadeHpMul: 1.75 });
    // 面積に対して単調非減少
    let prev = suspectLoadout(0);
    for (let a = 0; a <= 3000; a += 25) {
      const cur = suspectLoadout(a);
      expect(cur.reserveMagazines).toBeGreaterThanOrEqual(prev.reserveMagazines);
      expect(cur.trapKits).toBeGreaterThanOrEqual(prev.trapKits);
      expect(cur.medkits).toBeGreaterThanOrEqual(prev.medkits);
      expect(cur.barricadeHpMul).toBeGreaterThanOrEqual(prev.barricadeHpMul);
      prev = cur;
    }
  });

  it('suspectWeapons は有限弾数の武器の予備マガジンだけを置き換え、元の定義は変えない', () => {
    const pistol = { id: 'machine_pistol', category: 'primary', faction: 'suspect', magazineSize: 15, reserveMagazines: 3 } as WeaponDef;
    const defs = [pistol, { id: 'm4', category: 'primary', magazineSize: 30 } as WeaponDef];
    expect(suspectWeapons(defs)[0]).toBe(pistol);
    const out = suspectWeapons(defs, 8);
    expect(out).toHaveLength(1);
    expect(out[0]!.reserveMagazines).toBe(8);
    expect(pistol.reserveMagazines).toBe(3);
  });
});

describe('Fortify は持ち込み装備のトラップ部材・製作数・補強材倍率を使う', () => {
  const origDocument = globalThis.document;
  beforeEach(() => {
    const stubDoc = {
      createElement: () => ({ style: { cssText: '', display: '' }, textContent: '', remove: vi.fn() }),
      body: { appendChild: vi.fn() },
    };
    (globalThis as unknown as { document: typeof stubDoc }).document = stubDoc;
  });
  afterEach(() => {
    (globalThis as unknown as { document: Document }).document = origDocument;
  });

  function make(loadout?: { trapKits: number; craftedTraps: number; barricadeHpMul: number }) {
    let resolve: (() => unknown) | undefined;
    let hold: ((b: unknown, dt: number, sec: number) => void) | undefined;
    const interaction = {
      register: vi.fn((def: { resolve: () => unknown; onHold: (b: unknown, dt: number, sec: number) => void }) => {
        resolve = def.resolve;
        hold = def.onHold;
        return () => {};
      }),
    } as unknown as Interaction;
    const windows: WindowDef[] = [{ x: 0, z: 0, yaw: 0, width: 1.4, sill: 0.9, height: 1.2 }];
    const fortify = new Fortify({
      windows,
      colliders: [] as Collider[],
      scene: new THREE.Scene(),
      textures: { get: () => null } as unknown as TextureLibrary,
      player: { position: new THREE.Vector3(0, 0, 1.0), alive: true, yawRad: 0 } as unknown as PlayerController,
      input: {} as unknown as InputManager,
      interaction,
      doors: { doors: [] } as unknown as DoorSystem,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      bus: createGameEventBus(),
      weapons: {} as unknown as WeaponSystem,
      allies: () => [],
      civilians: () => [],
      entry: { x: 0, y: 0, z: 5 },
      isPrep: () => true,
      showGauge: vi.fn(),
      onCivilianKilled: vi.fn(),
      loadout,
    });
    const b = resolve!();
    hold!(b, 0.1, 2.5);
    return fortify;
  }

  it('未指定なら従来値、指定すれば部材と板の耐久が増える', () => {
    const base = make();
    expect(base.trapsLeft).toBe(2);
    expect(base.listBoarded()[0]!.hp).toBe(170);
    base.dispose();

    const big = make({ trapKits: 5, craftedTraps: 4, barricadeHpMul: 1.5 });
    expect(big.trapsLeft).toBe(5);
    expect(big.listBoarded()[0]!.hp).toBe(255);
    big.dispose();
  });
});
