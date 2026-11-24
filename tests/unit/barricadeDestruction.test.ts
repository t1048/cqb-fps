import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import type { RoomDef, WindowDef } from '../../src/core/types';
import { Fortify, type BarricadeHooks, type BarricadeInfo } from '../../src/modes/Fortify';
import {
  findObstructingBarricade,
  planWindowFlashThrow,
  SwatTeam,
} from '../../src/modes/SwatTeam';
import type { DoorSystem } from '../../src/world/Door';
import type { Collider } from '../../src/world/WorldBuilder';
import type { Flashbang } from '../../src/weapons/Flashbang';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { Subtitle } from '../../src/ui/Subtitle';
import type { InputManager } from '../../src/core/InputManager';
import type { Interaction } from '../../src/player/Interaction';
import type { PlayerController } from '../../src/player/PlayerController';
import type { TextureLibrary } from '../../src/world/Materials';

function makeBarricadeCollider(cx: number, cy: number, cz: number, hw = 0.76, hh = 0.66, hd = 0.13): Collider {
  return {
    kind: 'wall',
    aabb: {
      min: { x: cx - hw, y: cy - hh, z: cz - hd },
      max: { x: cx + hw, y: cy + hh, z: cz + hd },
    },
  };
}

describe('F9 — Active Window Barricade Destruction', () => {
  const origDocument = globalThis.document;

  beforeEach(() => {
    const stubDoc = {
      createElement: () => ({
        style: { cssText: '', display: '' },
        textContent: '',
        remove: vi.fn(),
      }),
      body: { appendChild: vi.fn() },
    };
    (globalThis as unknown as { document: typeof stubDoc }).document = stubDoc;
  });

  afterEach(() => {
    (globalThis as unknown as { document: Document }).document = origDocument;
  });

  it('findObstructingBarricade detects boarded window via nearFace LOS and rejects open LOS / wrong floor / same side / occluded', () => {
    const b: BarricadeInfo = {
      id: 'barricade_0',
      center: { x: 0, y: 1.5, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      floorY: 0,
      hp: 170,
      boarded: true,
    };
    const barCol = makeBarricadeCollider(0, 1.5, 0);

    // Hunter at +Z (0, 1.55, 4), target at -Z (0, 0, -4) -> direct LOS blocked by barCol, nearFace LOS clear!
    const found = findObstructingBarricade({ x: 0, y: 1.55, z: 4 }, 0, { x: 0, y: 0, z: -4 }, [b], [barCol]);
    expect(found).not.toBeNull();
    expect(found!.barricade.id).toBe('barricade_0');
    expect(found!.nearFace.z).toBeGreaterThan(0.13);

    // Direct LOS already open (no collider blocking) -> returns null
    expect(findObstructingBarricade({ x: 0, y: 1.55, z: 4 }, 0, { x: 0, y: 0, z: -4 }, [b], [])).toBeNull();

    // Same side of window -> returns null
    expect(findObstructingBarricade({ x: 0, y: 1.55, z: 4 }, 0, { x: 0, y: 0, z: 2 }, [b], [barCol])).toBeNull();

    // Different floor -> returns null
    expect(
      findObstructingBarricade({ x: 0, y: 4.75, z: 4 }, 3.2, { x: 0, y: 3.2, z: -4 }, [b], [barCol]),
    ).toBeNull();

    // Solid wall between hunter and barricade nearFace -> returns null
    const solidWall: Collider = {
      kind: 'wall',
      aabb: { min: { x: -4, y: 0, z: 1.8 }, max: { x: 4, y: 3, z: 2.2 } },
    };
    expect(
      findObstructingBarricade({ x: 0, y: 1.55, z: 4 }, 0, { x: 0, y: 0, z: -4 }, [b], [barCol, solidWall]),
    ).toBeNull();
  });

  it('Fortify.listBoarded returns exact BarricadeInfo for boarded windows and removes destroyed ones on bulletImpact', () => {
    const bus = createGameEventBus();
    const colliders: Collider[] = [];
    const windows: WindowDef[] = [
      { x: 0, z: 0, yaw: 0, width: 1.4, sill: 0.9, height: 1.2 },
      { x: 5, z: 0, yaw: 90, width: 1.4, sill: 0.9, height: 1.2 },
    ];
    let registeredHold: ((b: unknown, dt: number, sec: number) => void) | undefined;
    let registeredResolve: (() => unknown) | undefined;
    const interaction = {
      register: vi.fn((def: { resolve: () => unknown; onHold: (b: unknown, dt: number, sec: number) => void }) => {
        registeredResolve = def.resolve;
        registeredHold = def.onHold;
        return () => {};
      }),
    } as unknown as Interaction;

    const fortify = new Fortify({
      windows,
      colliders,
      scene: new THREE.Scene(),
      textures: { get: () => null } as unknown as TextureLibrary,
      player: { position: new THREE.Vector3(0, 0, 1.0), alive: true, yawRad: 0 } as unknown as PlayerController,
      input: {} as unknown as InputManager,
      interaction,
      doors: { doors: [] } as unknown as DoorSystem,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      bus,
      weapons: { addReserveMagazines: vi.fn() } as unknown as WeaponSystem,
      allies: () => [],
      civilians: () => [],
      entry: { x: 0, y: 0, z: 5 },
      isPrep: () => true,
      showGauge: vi.fn(),
      onCivilianKilled: vi.fn(),
    });

    expect(fortify.listBoarded()).toEqual([]);

    // Board the first window via interaction hold
    const aimed = registeredResolve!();
    expect(aimed).not.toBeNull();
    registeredHold!(aimed, 0.1, 2.5);

    const boarded = fortify.listBoarded();
    expect(boarded).toHaveLength(1);
    expect(boarded[0]!.id).toBe('barricade_0');
    expect(boarded[0]!.boarded).toBe(true);
    expect(boarded[0]!.hp).toBe(170);
    expect(boarded[0]!.center).toEqual({ x: 0, y: 1.5, z: 0 });
    expect(boarded[0]!.normal.x).toBeCloseTo(0, 5);
    expect(boarded[0]!.normal.z).toBeCloseTo(1, 5);

    // Shooting at barricade center destroys it via bulletImpact
    bus.emit('bulletImpact', { shooter: 'swat_1', pos: { x: 0, y: 1.5, z: 0.13 }, damage: 170 });
    expect(fortify.listBoarded()).toEqual([]);

    fortify.dispose();
  });

  it('SwatTeam shoots out obstructing window barricade, enabling planWindowFlashThrow, and respects civilian safety', () => {
    const bus = createGameEventBus();
    const barCol = makeBarricadeCollider(0, 1.5, 0);
    const colliders: Collider[] = [barCol];
    const windowDef: WindowDef = { x: 0, z: 0, yaw: 0, width: 1.4, sill: 0.9, height: 1.2 };
    let hp = 39; // 3 SWAT shots (13 dmg each) to break
    let boarded = true;

    const hooks: BarricadeHooks = {
      listBoarded: () =>
        boarded
          ? [{ id: 'barricade_0', center: { x: 0, y: 1.5, z: 0 }, normal: { x: 0, y: 0, z: 1 }, floorY: 0, hp, boarded }]
          : [],
    };
    const impacts: Array<{ y: number; damage: number }> = [];
    bus.on('bulletImpact', (e) => {
      impacts.push({ y: e.pos.y, damage: e.damage });
      if (!boarded) return;
      const a = barCol.aabb;
      const eps = 0.05;
      if (
        e.pos.x >= a.min.x - eps &&
        e.pos.x <= a.max.x + eps &&
        e.pos.y >= a.min.y - eps &&
        e.pos.y <= a.max.y + eps &&
        e.pos.z >= a.min.z - eps &&
        e.pos.z <= a.max.z + eps
      ) {
        hp -= e.damage;
        if (hp <= 0) {
          boarded = false;
          barCol.aabb.min.y = -1000;
          barCol.aabb.max.y = -999.99;
        }
      }
    });

    // While boarded, window flashbang throw is blocked
    expect(planWindowFlashThrow({ x: 0, y: 1.5, z: 3 }, { x: 0, y: 0, z: -2.5 }, [windowDef], colliders, 9.8)).toBeNull();

    const rooms: RoomDef[] = [{ id: 'r1', name: 'Room', x: 0, z: -3, width: 10, depth: 6, floorY: 0 }];
    const playerPos = new THREE.Vector3(0, 0, -3);
    const team = new SwatTeam({
      spawns: [{ x: 0, y: 0, z: 4 }],
      count: 1,
      player: {
        position: playerPos,
        alive: true,
        isCrouching: false,
        yawRad: 0,
        hp: 100,
        getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
        getBodyBounds: () => ({
          min: { x: playerPos.x - 0.3, y: playerPos.y, z: playerPos.z - 0.3 },
          max: { x: playerPos.x + 0.3, y: playerPos.y + 1.75, z: playerPos.z + 0.3 },
        }),
        takeDamage: vi.fn(() => 100),
      },
      colliders,
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [] } as unknown as DoorSystem,
      bounds: { width: 20, depth: 20 },
      stairs: [],
      rooms,
      windows: [windowDef],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    });
    team.attachBarricades(hooks);
    team.beginAssault();

    const hunter = team.hunters[0]!;
    hunter.huntTarget = { x: 0, y: 0, z: -3 };
    hunter.setState('hunt');

    // Step until SWAT shoots out the barricade
    for (let i = 0; i < 40 && boarded; i++) {
      team.update(0.05);
    }

    expect(boarded).toBe(false);
    expect(impacts.length).toBeGreaterThanOrEqual(3);
    // Verify hits landed on the window center (~1.5m), NOT +STAND_CHEST (~2.75m)!
    expect(impacts.some((imp) => imp.y > 0.8 && imp.y < 2.2)).toBe(true);

    // Now that barricade is destroyed, planWindowFlashThrow succeeds immediately
    const flashPlan = planWindowFlashThrow({ x: 0, y: 1.5, z: 3 }, { x: 0, y: 0, z: -2.5 }, [windowDef], colliders, 9.8);
    expect(flashPlan?.kind).toBe('window');

    team.dispose();
  });
});
