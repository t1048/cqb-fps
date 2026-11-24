import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import type { RoomDef } from '../../src/core/types';
import {
  findRoomDoors,
  planPincerFlankGoal,
  selectPinningCell,
  SwatTeam,
  type FlankDoorSample,
  type PinningCellInfo,
} from '../../src/modes/SwatTeam';
import { Door, type DoorConfig, type DoorSystem } from '../../src/world/Door';
import type { StairMark } from '../../src/world/Walk';
import type { Flashbang } from '../../src/weapons/Flashbang';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { Subtitle } from '../../src/ui/Subtitle';

const DOOR_CFG: DoorConfig = {
  thickness: 0.05,
  height: 2.1,
  peekAngle: 22,
  swingSpeed: 90,
  knobSpeedMultiplier: 2,
  segmentLength: 0.35,
  interactRange: 2.2,
  breach: { speedMultiplier: 6, noiseRadius: 18, effectRadius: 5 },
  noise: { slowRadius: 5, fastRadius: 10 },
};

describe('F7 — Role-Split Pincer Flanking', () => {
  it('selectPinningCell prefers nearby/engaged shielded cell, falls back to contact cell, and excludes dead cells', () => {
    const cells: PinningCellInfo[] = [
      { cellIndex: 0, aliveCount: 2, hasShield: true, engaged: false, center: { x: 0, y: 0, z: 6 } },
      { cellIndex: 1, aliveCount: 2, hasShield: false, engaged: true, center: { x: 8, y: 0, z: 0 } },
    ];
    // Shielded cell 0 is within 12m on same floor -> chosen as pinning cell even if cell 1 made contact
    expect(selectPinningCell(cells, 1, { x: 0, y: 0, z: 0 })).toBe(0);

    // If shielded cell is dead, falls back to contact cell 1
    const deadShield: PinningCellInfo[] = [
      { cellIndex: 0, aliveCount: 0, hasShield: true, engaged: false, center: { x: 0, y: 0, z: 6 } },
      { cellIndex: 1, aliveCount: 2, hasShield: false, engaged: true, center: { x: 8, y: 0, z: 0 } },
    ];
    expect(selectPinningCell(deadShield, 1, { x: 0, y: 0, z: 0 })).toBe(1);
  });

  it('findRoomDoors returns only same-floor doors touching the room', () => {
    const room: RoomDef = { id: 'r1', name: 'Center', x: 0, z: 0, width: 8, depth: 8, floorY: 0 };
    const doors: FlankDoorSample[] = [
      { id: 'north', centerX: 0, centerZ: -4, normalX: 0, normalZ: 1, sillY: 0, locked: false },
      { id: 'south', centerX: 0, centerZ: 4, normalX: 0, normalZ: 1, sillY: 0, locked: false },
      { id: 'upstairs', centerX: 0, centerZ: -4, normalX: 0, normalZ: 1, sillY: 3.2, locked: false },
      { id: 'far', centerX: 20, centerZ: 20, normalX: 1, normalZ: 0, sillY: 0, locked: false },
    ];
    expect(findRoomDoors(room, doors).map((d) => d.id)).toEqual(['north', 'south']);
  });

  it('planPincerFlankGoal selects alternate door farthest from frontal cell, supports excludeDoorIds, and falls back to opposite room / stair', () => {
    const rooms: RoomDef[] = [
      { id: 'center', name: 'Center', x: 0, z: 0, width: 8, depth: 8, floorY: 0 },
      { id: 'north_room', name: 'North', x: 0, z: -8, width: 8, depth: 8, floorY: 0 },
      { id: 'east_room', name: 'East', x: 8, z: 0, width: 8, depth: 8, floorY: 0 },
    ];
    const doors: FlankDoorSample[] = [
      { id: 'south_door', centerX: 0, centerZ: 4, normalX: 0, normalZ: 1, sillY: 0, locked: false },
      { id: 'north_door', centerX: 0, centerZ: -4, normalX: 0, normalZ: 1, sillY: 0, locked: false },
      { id: 'east_door', centerX: 4, centerZ: 0, normalX: 1, normalZ: 0, sillY: 0, locked: false },
    ];

    // Priority 1: Frontal cell is at south (0, 6); Blue picks north_door (farthest & opposite)
    const p1 = planPincerFlankGoal({
      playerPos: { x: 0, y: 0, z: 0 },
      frontalPos: { x: 0, y: 0, z: 6 },
      flankerPos: { x: 6, y: 0, z: 0 },
      rooms,
      doors,
      stairs: [],
      colliders: [],
    });
    expect(p1?.kind).toBe('altDoor');
    expect(p1?.doorId).toBe('north_door');

    // Excluding north_door for a 3rd cell (Gold) routes to east_door (never frontal south_door)
    const p1b = planPincerFlankGoal({
      playerPos: { x: 0, y: 0, z: 0 },
      frontalPos: { x: 0, y: 0, z: 6 },
      flankerPos: { x: 6, y: 0, z: 0 },
      rooms,
      doors,
      stairs: [],
      colliders: [],
      excludeDoorIds: new Set(['north_door']),
    });
    expect(p1b?.kind).toBe('altDoor');
    expect(p1b?.doorId).toBe('east_door');

    // Priority 2: Dead-end room with only 1 door -> falls back to opposite adjacent room (north_room)
    const p2 = planPincerFlankGoal({
      playerPos: { x: 0, y: 0, z: 0 },
      frontalPos: { x: 0, y: 0, z: 6 },
      flankerPos: { x: 6, y: 0, z: 0 },
      rooms,
      doors: [doors[0]!],
      stairs: [],
      colliders: [],
    });
    expect(p2?.kind).toBe('oppositeRoom');
    expect(p2?.roomId).toBe('north_room');

    // Priority 3: Single room on floor with stairs -> falls back to stair landing farthest from frontal cell
    const stairs: StairMark[] = [
      {
        baseY: 0,
        topY: 3.2,
        lowX: 0,
        lowZ: 4,
        highX: 0,
        highZ: 7,
        approachLow: { x: 0, z: 3.5 },
        approachHigh: { x: 0, z: 7.5 },
      },
      {
        baseY: 0,
        topY: 3.2,
        lowX: 0,
        lowZ: -4,
        highX: 0,
        highZ: -7,
        approachLow: { x: 0, z: -3.5 },
        approachHigh: { x: 0, z: -7.5 },
      },
    ];
    const p3 = planPincerFlankGoal({
      playerPos: { x: 0, y: 0, z: 0 },
      frontalPos: { x: 0, y: 0, z: 6 },
      flankerPos: { x: 0, y: 3.2, z: -6 },
      rooms: [rooms[0]!],
      doors: [doors[0]!],
      stairs,
      colliders: [],
    });
    expect(p3?.kind).toBe('altFloorStair');
    expect(p3?.target.z).toBeLessThan(0);
  });

  it('SwatTeam assigns distinct flank huntTarget to Blue cell when Red makes contact, and degrades cleanly for 1 cell', () => {
    const bus = createGameEventBus();
    const rooms: RoomDef[] = [
      { id: 'center', name: 'Center', x: 0, z: 0, width: 8, depth: 8, floorY: 0 },
      { id: 'north', name: 'North', x: 0, z: -8, width: 8, depth: 8, floorY: 0 },
    ];
    const southDoor = new Door({ id: 'south_door', x: 0, z: 4, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const northDoor = new Door({ id: 'north_door', x: 0, z: -4, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const playerPos = new THREE.Vector3(0, 0, 0);

    const team = new SwatTeam({
      spawns: [
        { x: 0, y: 0, z: 3 },
        { x: 1, y: 0, z: 3 },
        { x: -3, y: 0, z: -6 },
        { x: -2, y: 0, z: -6 },
      ],
      count: 4,
      player: {
        position: playerPos,
        alive: true,
        isCrouching: false,
        yawRad: 0,
        hp: 100,
        getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, 0),
        getBodyBounds: () => ({ min: { x: -0.3, y: 0, z: -0.3 }, max: { x: 0.3, y: 1.75, z: 0.3 } }),
        takeDamage: vi.fn(() => 100),
      },
      colliders: [],
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [southDoor, northDoor] } as unknown as DoorSystem,
      bounds: { width: 24, depth: 24 },
      stairs: [],
      rooms,
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    });

    team.beginAssault();
    const red1 = team.hunters[0]!;
    const red2 = team.hunters[1]!;
    const blue1 = team.hunters[2]!;
    const blue2 = team.hunters[3]!;
    red1.setState('engage');
    team.onContact(red1, { x: 0, y: 0, z: 0 });

    // Red-2 supports frontally at playerPos (0, 0, 0); Blue-1 & Blue-2 flank toward north_door (z around -4.75)
    expect(red2.state).toBe('hunt');
    expect(red2.huntingFlank).toBe(false);
    expect(red2.huntTarget?.z).toBeCloseTo(0, 2);

    expect(blue1.state).toBe('hunt');
    expect(blue1.huntingFlank).toBe(true);
    expect(blue1.huntTarget?.z).toBeLessThan(-3);
    expect(blue2.huntingFlank).toBe(true);
    expect(blue2.huntTarget?.z).toBeLessThan(-3);

    team.dispose();
    southDoor.dispose();
    northDoor.dispose();
  });

  it('gunshot noise during an active pincer engagement does NOT overwrite the flanking cell leader huntTarget', () => {
    const bus = createGameEventBus();
    const rooms: RoomDef[] = [
      { id: 'center', name: 'Center', x: 0, z: 0, width: 8, depth: 8, floorY: 0 },
      { id: 'north', name: 'North', x: 0, z: -8, width: 8, depth: 8, floorY: 0 },
    ];
    const southDoor = new Door({ id: 'south_door', x: 0, z: 4, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const northDoor = new Door({ id: 'north_door', x: 0, z: -4, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const playerPos = new THREE.Vector3(0, 0, 0);

    const team = new SwatTeam({
      spawns: [
        { x: 0, y: 0, z: 3 },
        { x: 1, y: 0, z: 3 },
        { x: -3, y: 0, z: -6 },
        { x: -2, y: 0, z: -6 },
      ],
      count: 4,
      player: {
        position: playerPos,
        alive: true,
        isCrouching: false,
        yawRad: 0,
        hp: 100,
        getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, 0),
        getBodyBounds: () => ({ min: { x: -0.3, y: 0, z: -0.3 }, max: { x: 0.3, y: 1.75, z: 0.3 } }),
        takeDamage: vi.fn(() => 100),
      },
      colliders: [],
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [southDoor, northDoor] } as unknown as DoorSystem,
      bounds: { width: 24, depth: 24 },
      stairs: [],
      rooms,
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    });

    team.beginAssault();
    const red1 = team.hunters[0]!;
    const blue1 = team.hunters[2]!;
    red1.setState('engage');
    team.onContact(red1, { x: 0, y: 0, z: 0 });

    expect(blue1.state).toBe('hunt');
    expect(blue1.huntingFlank).toBe(true);
    const flankTargetBefore = { ...blue1.huntTarget! };
    expect(flankTargetBefore.z).toBeLessThan(-3);

    // Fire gunshots from both player and frontal ally -> must NOT overwrite Blue-1's flank target
    bus.emit('noise', { pos: { x: 0, y: 1.4, z: 0 }, radius: 40, kind: 'gunshot', source: 'player' });
    bus.emit('noise', { pos: { x: 0, y: 1.4, z: 3 }, radius: 40, kind: 'gunshot', source: 'ally' });

    expect(blue1.huntingFlank).toBe(true);
    expect(blue1.state).toBe('hunt');
    expect(blue1.huntTarget).toEqual(flankTargetBefore);

    team.dispose();
    southDoor.dispose();
    northDoor.dispose();
  });
});
