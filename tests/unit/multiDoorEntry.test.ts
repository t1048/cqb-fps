import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import type { RoomDef } from '../../src/core/types';
import {
  assignCellPortals,
  buildStackSlotPortal,
  entryRouteDest,
  filterReachableExteriorEntries,
  SwatTeam,
  type EntryPortal,
  type SwatTeamDeps,
} from '../../src/modes/SwatTeam';
import { Door, type DoorConfig, type DoorSystem } from '../../src/world/Door';
import type { Collider } from '../../src/world/WorldBuilder';
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

function makeWall(minX: number, maxX: number, minZ: number, maxZ: number, minY = 0, maxY = 3): Collider {
  return { kind: 'wall', aabb: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } };
}

function makePortal(id: string, outX: number, outZ: number, inX: number, inZ: number, sillY = 0): EntryPortal {
  return {
    id,
    outside: { x: outX, y: sillY, z: outZ },
    inside: { x: inX, y: sillY, z: inZ },
    sillY,
  };
}

describe('F6 — Multi-Door Simultaneous Entry', () => {
  it('filters out 2F terrace portals (sillY mismatch) and enclosed courtyard portals (unreachable outdoors)', () => {
    const spawn = { x: 0, y: 0, z: 10 };
    const entries: EntryPortal[] = [
      makePortal('front_door', 0, 6, 0, 4, 0),
      makePortal('back_door', 0, -6, 0, -4, 0),
      makePortal('terrace_2f', 0, 6, 0, 4, 3.2),
      makePortal('courtyard_trapped', 12, 0, 10, 0, 0),
    ];
    // Fully enclose courtyard_trapped outside point (12, 0) with 4 walls so no outdoor path reaches it
    const colliders: Collider[] = [
      makeWall(10.5, 13.5, -1.5, -1.2),
      makeWall(10.5, 13.5, 1.2, 1.5),
      makeWall(10.5, 10.8, -1.5, 1.5),
      makeWall(13.2, 13.5, -1.5, 1.5),
    ];

    const reachable = filterReachableExteriorEntries(entries, spawn, colliders, { width: 32, depth: 32 });
    expect(reachable.map((p) => p.id)).toEqual(['front_door', 'back_door']);
  });

  it('assigns distinct spread portals to cells when >= 2 doors exist, and falls back cleanly on 1 or 0 doors', () => {
    const front = makePortal('front', 0, 8, 0, 6);
    const side = makePortal('side', 8, 0, 6, 0);
    const back = makePortal('back', 0, -8, 0, -6);

    // 2 cells, 3 doors -> Red gets nearest (front), Blue gets farthest (back)
    const twoCells = assignCellPortals(2, [front, side, back]);
    expect(twoCells.map((p) => p.id)).toEqual(['front', 'back']);

    // 3 cells, 3 doors -> Red, Blue, Gold all get distinct portals
    const threeCells = assignCellPortals(3, [front, side, back]);
    expect(new Set(threeCells.map((p) => p.id)).size).toBe(3);

    // Single-door fallback (house_compact)
    const singleDoor = assignCellPortals(2, [front]);
    expect(singleDoor.map((p) => p.id)).toEqual(['front', 'front']);

    // 0-door fallback
    expect(assignCellPortals(2, [])).toEqual([]);
  });

  it('orients buildStackSlotPortal into-vector from outside to inside and honors preferPortalId in entryRouteDest', () => {
    const portal = makePortal('back', 0, -8, 0, -6);
    const sp = buildStackSlotPortal(portal, { centerX: 0, centerZ: -7, axisX: 1, axisZ: 0, width: 1.0 });
    expect(sp.intoX).toBeCloseTo(0, 5);
    expect(sp.intoZ).toBeCloseTo(1, 5);

    const rooms: RoomDef[] = [{ id: 'r1', name: 'Main', x: 0, z: 0, width: 10, depth: 10, floorY: 0 }];
    const front = makePortal('front', 0, 6, 0, 4);
    const back = makePortal('back', 0, -6, 0, -4);
    // Standing near front (0, 8), normally picks front, but preferPortalId='back' overrides to back
    const route = entryRouteDest(rooms, [front, back], { x: 0, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 'back');
    expect(route.entryId).toBe('back');
    expect(route.phase).toBe('approach');
  });

  it('SwatTeam splits Red & Blue to distinct doors, stacks, counts down via radio, enters simultaneously, and aborts stack on contact', () => {
    const bus = createGameEventBus();
    const radios: string[] = [];
    bus.on('allyRadio', (e) => radios.push(e.text));

    const doorFront = new Door({ id: 'door_front', x: 0, z: 5, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const doorBack = new Door({ id: 'door_back', x: 0, z: -5, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const rooms: RoomDef[] = [{ id: 'r1', name: 'Main Hall', x: 0, z: 0, width: 10, depth: 10, floorY: 0 }];
    const playerPos = new THREE.Vector3(0, 0, 0);
    const player = {
      position: playerPos,
      alive: true,
      isCrouching: false,
      yawRad: 0,
      hp: 100,
      getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
      getBodyBounds: () => ({
        min: { x: -0.3, y: 0, z: -0.3 },
        max: { x: 0.3, y: 1.75, z: 0.3 },
      }),
      takeDamage: vi.fn(() => 100),
    };
    const deps: SwatTeamDeps = {
      spawns: [
        { x: -1, y: 0, z: 8 },
        { x: 1, y: 0, z: 8 },
        { x: -1, y: 0, z: 9 },
        { x: 1, y: 0, z: 9 },
      ],
      count: 4,
      player,
      colliders: [],
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [doorFront, doorBack] } as unknown as DoorSystem,
      bounds: { width: 28, depth: 28 },
      stairs: [],
      rooms,
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    };
    const team = new SwatTeam(deps);
    team.beginAssault();

    // All 4 hunters enter 'stack' state with Red & Blue assigned to different portals
    expect(team.hunters.every((h) => h.state === 'stack')).toBe(true);
    const redPortal = team.hunters[0]!.assignedPortal?.id;
    const bluePortal = team.hunters[2]!.assignedPortal?.id;
    expect(redPortal).toBeDefined();
    expect(bluePortal).toBeDefined();
    expect(redPortal).not.toBe(bluePortal);

    // Move all hunters directly onto their stack slots and advance time through countdown
    for (const h of team.hunters) {
      const slot = h.stackSlot!;
      h.body.setPosition(slot.x, slot.z, slot.y);
    }
    // Hide player far away so sense() doesn't trigger contact during countdown
    playerPos.set(50, 0, 50);

    for (let i = 0; i < 65; i++) team.update(0.05); // 3.25s > ENTRY_COUNTDOWN_SEC (2.4s)
    expect(radios.some((t) => t.includes('3、2、1、ブリーチ'))).toBe(true);
    expect(team.hunters.every((h) => h.state !== 'stack')).toBe(true);

    team.dispose();
    doorFront.dispose();
    doorBack.dispose();
  });

  it('SwatTeam aborts stacking immediately if a hunter takes damage during stack phase', () => {
    const bus = createGameEventBus();
    const doorFront = new Door({ id: 'door_front', x: 0, z: 5, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const rooms: RoomDef[] = [{ id: 'r1', name: 'Main Hall', x: 0, z: 0, width: 10, depth: 10, floorY: 0 }];
    const playerPos = new THREE.Vector3(0, 0, 0);
    const team = new SwatTeam({
      spawns: [
        { x: -1, y: 0, z: 12 },
        { x: 1, y: 0, z: 12 },
      ],
      count: 2,
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
      doors: { doors: [doorFront] } as unknown as DoorSystem,
      bounds: { width: 32, depth: 32 },
      stairs: [],
      rooms,
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    });

    team.beginAssault();
    expect(team.hunters.every((h) => h.state === 'stack')).toBe(true);

    // Player shoots hunter 0 while stacking -> hunter 0 engages, hunter 1 aborts stack and hunts
    bus.emit('entityHit', { targetId: team.hunters[0]!.id, shooter: 'player', damage: 20, pos: { x: -1, y: 1, z: 12 } });
    expect(team.hunters[0]!.state).toBe('engage');
    expect(team.hunters[1]!.state).not.toBe('stack');

    team.dispose();
    doorFront.dispose();
  });

  it('indoor footstep and door noise during F6 stack does NOT pull cell leaders out of stack', () => {
    const bus = createGameEventBus();
    const doorFront = new Door({ id: 'door_front', x: 0, z: 5, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const doorBack = new Door({ id: 'door_back', x: 0, z: -5, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const rooms: RoomDef[] = [{ id: 'r1', name: 'Main Hall', x: 0, z: 0, width: 10, depth: 10, floorY: 0 }];
    const playerPos = new THREE.Vector3(0, 0, 2);
    const team = new SwatTeam({
      spawns: [
        { x: -1, y: 0, z: 8 },
        { x: 1, y: 0, z: 8 },
        { x: -1, y: 0, z: 9 },
        { x: 1, y: 0, z: 9 },
      ],
      count: 4,
      player: {
        position: playerPos,
        alive: true,
        isCrouching: false,
        yawRad: 0,
        hp: 100,
        getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
        getBodyBounds: () => ({ min: { x: -0.3, y: 0, z: -0.3 }, max: { x: 0.3, y: 1.75, z: 0.3 } }),
        takeDamage: vi.fn(() => 100),
      },
      colliders: [],
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [doorFront, doorBack] } as unknown as DoorSystem,
      bounds: { width: 28, depth: 28 },
      stairs: [],
      rooms,
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    });

    team.beginAssault();
    expect(team.hunters.every((h) => h.state === 'stack')).toBe(true);

    // Emit indoor footstep & door noise well within hearing range
    bus.emit('noise', { pos: { x: 0, y: 0.1, z: 2 }, radius: 14, kind: 'footstep', source: 'player' });
    bus.emit('noise', { pos: { x: 0, y: 1.0, z: 3 }, radius: 16, kind: 'door', source: 'player' });

    // Cell leaders and followers must remain cleanly in 'stack'
    expect(team.hunters.every((h) => h.state === 'stack')).toBe(true);

    team.dispose();
    doorFront.dispose();
    doorBack.dispose();
  });
});
