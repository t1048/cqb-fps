import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import type { GameEventBus } from '../../../src/core/events';
import type {
  DoorConfig,
  DoorDef,
  GeneratorTemplate,
  MapData,
  RoomDef,
  WeaponDef,
  WindowDef,
} from '../../../src/core/types';
import { Door, type DoorSystem } from '../../../src/world/Door';
import type { TextureLibrary } from '../../../src/world/Materials';
import { WorldBuilder, type Collider } from '../../../src/world/WorldBuilder';
import { generateMap } from '../../../src/world/generator/index';
import { validateGeneratorTemplate } from '../../../src/core/DataLoader';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DATA_DIR = path.join(REPO_ROOT, 'public/data');

let cachedDoorCfg: DoorConfig | null = null;
let cachedWeapons: WeaponDef[] | null = null;

export function loadDoorConfig(): DoorConfig {
  if (!cachedDoorCfg) {
    cachedDoorCfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'doors.json'), 'utf8')) as DoorConfig;
  }
  return cachedDoorCfg;
}

export function loadWeaponsData(): WeaponDef[] {
  if (!cachedWeapons) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'weapons.json'), 'utf8')) as {
      weapons: WeaponDef[];
    };
    cachedWeapons = raw.weapons;
  }
  return cachedWeapons;
}

export function loadGeneratorTemplate(name: 'house_compact' | 'house' | 'embassy'): GeneratorTemplate {
  const filePath = path.join(DATA_DIR, 'generators', `${name}.json`);
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return validateGeneratorTemplate(raw, filePath);
}

export function generateRealMap(
  templateName: 'house_compact' | 'house' | 'embassy',
  seed: number,
): MapData {
  const tpl = loadGeneratorTemplate(templateName);
  const raw = generateMap(tpl, seed, `${templateName}_${seed}`, loadDoorConfig().height);
  return {
    ...raw,
    floors: raw.floors ?? [],
    stairs: raw.stairs ?? [],
    items: raw.items ?? [],
  };
}

/**
 * Headless TextureLibrary stub returning bare THREE.Texture instances (no DOM canvas/Image required).
 */
export function createStubTextures(): TextureLibrary {
  const tex = new THREE.Texture();
  return {
    get: () => tex,
    getDecal: () => tex,
    byMaterial: () => tex,
    bindPalette() {},
    palette: null,
    dispose: () => {
      tex.dispose();
    },
  } as unknown as TextureLibrary;
}

/**
 * Headless DoorSystem wrapping real `Door` instances and syncing their colliders into the shared list.
 */
export class HeadlessDoorSystem {
  readonly root = new THREE.Group();
  readonly doors: Door[] = [];

  constructor(
    defs: readonly DoorDef[],
    cfg: DoorConfig,
    storyClearance: number,
    colliders: Collider[],
    bus: GameEventBus,
  ) {
    for (const def of defs) {
      const door = new Door(def, cfg, storyClearance, bus);
      this.doors.push(door);
      this.root.add(door.root);
      for (const c of door.colliders) colliders.push(c);
    }
  }

  aimed(_maxRange?: number): Door | null {
    return null;
  }

  update(dt: number, playerX = 999, playerZ = 999, playerRadius = 0.35, playerY = 0): void {
    for (const d of this.doors) d.update(dt, playerX, playerZ, playerRadius, playerY);
  }

  dispose(): void {
    for (const d of this.doors) d.dispose();
    this.doors.length = 0;
  }
}

export interface HeadlessWorld {
  map: MapData;
  world: WorldBuilder;
  doors: DoorSystem;
  doorSystem: HeadlessDoorSystem;
  colliders: Collider[];
  bounds: { width: number; depth: number };
  textures: TextureLibrary;
  dispose(): void;
}

export function buildHeadlessWorld(map: MapData, bus: GameEventBus): HeadlessWorld {
  const textures = createStubTextures();
  const world = new WorldBuilder(map, textures);
  const colliders = world.colliders;
  const storyClearance = map.storyHeight ?? map.ceilingHeight;
  const doorSystem = new HeadlessDoorSystem(map.doors, loadDoorConfig(), storyClearance, colliders, bus);
  return {
    map,
    world,
    doors: doorSystem as unknown as DoorSystem,
    doorSystem,
    colliders,
    bounds: { width: map.floor.width, depth: map.floor.depth },
    textures,
    dispose() {
      doorSystem.dispose();
      world.dispose();
      textures.dispose();
    },
  };
}

/**
 * Synthetic 1-room arena (8m x 8m indoor room centered at origin, surrounded by outdoor yard).
 * South wall has a doorway at (0, 4). Optional cover box and optional exterior window.
 */
export function makeSingleRoomMap(opts?: {
  lockedDoor?: boolean;
  includeCover?: boolean;
  includeWindow?: boolean;
}): MapData {
  const locked = opts?.lockedDoor ?? false;
  const includeCover = opts?.includeCover ?? true;
  const includeWindow = opts?.includeWindow ?? false;

  const walls = [
    // North wall (z = -4)
    { x: 0, z: -4, width: 8.2, height: 3, depth: 0.2 },
    // West wall (x = -4)
    { x: -4, z: 0, width: 0.2, height: 3, depth: 8.2 },
    // East wall (x = 4): split if window enabled
    ...(includeWindow
      ? [
          { x: 4, z: -2.5, width: 0.2, height: 3, depth: 3.2 },
          { x: 4, z: 2.5, width: 0.2, height: 3, depth: 3.2 },
          { x: 4, z: 0, width: 0.2, height: 0.9, depth: 1.8, y: 0 },
          { x: 4, z: 0, width: 0.2, height: 0.8, depth: 1.8, y: 2.2 },
        ]
      : [{ x: 4, z: 0, width: 0.2, height: 3, depth: 8.2 }]),
    // South wall (z = 4) with 1.2m doorway centered at x = 0
    { x: -2.3, z: 4, width: 3.4, height: 3, depth: 0.2 },
    { x: 2.3, z: 4, width: 3.4, height: 3, depth: 0.2 },
    { x: 0, z: 4, width: 1.2, height: 0.82, depth: 0.2, y: 2.18 },
  ];

  const windows: WindowDef[] = includeWindow
    ? [{ x: 4, z: 0, yaw: 90, width: 1.8, height: 1.3, sill: 0.9, y: 0 }]
    : [];

  const rooms: RoomDef[] = [
    { id: 'room_main', name: 'リビング', x: 0, z: 0, width: 8, depth: 8, floorY: 0 },
    { id: 'yard_south', name: '前庭', x: 0, z: 8, width: 20, depth: 8, floorY: 0, outdoor: true },
  ];

  return {
    id: 'e2e_single_room',
    name: 'E2E Single Room',
    ceilingHeight: 3,
    floor: { width: 24, depth: 24 },
    playerSpawn: { x: 0, y: 0, z: -2, yaw: 180 },
    walls,
    doors: [{ id: 'door_south', x: 0, z: 4, yaw: 0, locked, maxAngle: 100, width: 1.2 }],
    covers: includeCover ? [{ x: -1.8, z: 0.5, width: 1.2, height: 1.2, depth: 0.6 }] : [],
    entities: [],
    rooms,
    floors: [],
    stairs: [],
    windows,
    items: [],
    allies: [],
  };
}

/**
 * Synthetic multi-door house with TWO distinct ground-floor exterior doors:
 * - South exterior door (`door_south`) at (0, 5)
 * - North exterior door (`door_north`) at (0, -5)
 * Plus an optional interior dividing wall with an open doorway (`door_mid`) for pincer flanking.
 */
export function makeTwoDoorHouseMap(opts?: {
  southLocked?: boolean;
  northLocked?: boolean;
  includeInteriorDivider?: boolean;
}): MapData {
  const southLocked = opts?.southLocked ?? false;
  const northLocked = opts?.northLocked ?? false;
  const divider = opts?.includeInteriorDivider ?? false;

  const walls = [
    // West & East exterior walls (x = -5, x = 5, z in [-5, 5])
    { x: -5, z: 0, width: 0.2, height: 3, depth: 10.2 },
    { x: 5, z: 0, width: 0.2, height: 3, depth: 10.2 },
    // South exterior wall (z = 5) with doorway at x = 0
    { x: -2.8, z: 5, width: 4.4, height: 3, depth: 0.2 },
    { x: 2.8, z: 5, width: 4.4, height: 3, depth: 0.2 },
    { x: 0, z: 5, width: 1.2, height: 0.82, depth: 0.2, y: 2.18 },
    // North exterior wall (z = -5) with doorway at x = 0
    { x: -2.8, z: -5, width: 4.4, height: 3, depth: 0.2 },
    { x: 2.8, z: -5, width: 4.4, height: 3, depth: 0.2 },
    { x: 0, z: -5, width: 1.2, height: 0.82, depth: 0.2, y: 2.18 },
    ...(divider
      ? [
          { x: -2.8, z: 0, width: 4.4, height: 3, depth: 0.2 },
          { x: 2.8, z: 0, width: 4.4, height: 3, depth: 0.2 },
          { x: 0, z: 0, width: 1.2, height: 0.82, depth: 0.2, y: 2.18 },
        ]
      : []),
  ];

  const doors: DoorDef[] = [
    { id: 'door_south', x: 0, z: 5, yaw: 0, locked: southLocked, maxAngle: 100, width: 1.2 },
    { id: 'door_north', x: 0, z: -5, yaw: 0, locked: northLocked, maxAngle: 100, width: 1.2 },
  ];
  if (divider) {
    doors.push({ id: 'door_mid', x: 0, z: 0, yaw: 0, locked: false, maxAngle: 100, width: 1.2 });
  }

  const rooms: RoomDef[] = divider
    ? [
        { id: 'room_south', name: '南室', x: 0, z: 2.5, width: 10, depth: 5, floorY: 0 },
        { id: 'room_north', name: '北室', x: 0, z: -2.5, width: 10, depth: 5, floorY: 0 },
        { id: 'yard_south', name: '南庭', x: 0, z: 9, width: 22, depth: 8, floorY: 0, outdoor: true },
        { id: 'yard_north', name: '北庭', x: 0, z: -9, width: 22, depth: 8, floorY: 0, outdoor: true },
      ]
    : [
        { id: 'room_hall', name: '大広間', x: 0, z: 0, width: 10, depth: 10, floorY: 0 },
        { id: 'yard_south', name: '南庭', x: 0, z: 9, width: 22, depth: 8, floorY: 0, outdoor: true },
        { id: 'yard_north', name: '北庭', x: 0, z: -9, width: 22, depth: 8, floorY: 0, outdoor: true },
      ];

  return {
    id: 'e2e_two_door_house',
    name: 'E2E Two-Door House',
    ceilingHeight: 3,
    floor: { width: 28, depth: 28 },
    playerSpawn: { x: 0, y: 0, z: 0, yaw: 0 },
    walls,
    doors,
    covers: [{ x: 2.2, z: 1.5, width: 1.2, height: 1.2, depth: 0.6 }],
    entities: [],
    rooms,
    floors: [],
    stairs: [],
    windows: [],
    items: [],
    allies: [],
  };
}

/**
 * Synthetic house with 1 exterior window on the East wall (x = 4, z = 0) for F5/F9/F10 testing.
 */
export function makeWindowedSiegeMap(lockedDoor = false): MapData {
  const base = makeSingleRoomMap({ lockedDoor, includeCover: false, includeWindow: true });
  return {
    ...base,
    id: 'e2e_windowed_siege',
    name: 'E2E Windowed Siege',
  };
}
