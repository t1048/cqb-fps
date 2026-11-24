import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import { AudioBridge, type AudioBridgeSink } from '../../src/core/AudioBridge';
import type { RoomDef } from '../../src/core/types';
import {
  C2_BLAST_RADIUS,
  computeC2Standoff,
  evaluateC2BlastCone,
  shouldUseC2Breach,
  SwatTeam,
  type TrapHooks,
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

describe('F8 — C2 Explosive Breaching', () => {
  it('Door.breachExplosive unlocks immediately, swings faster than kick, and emits doorBreached away from breacher', () => {
    const bus = createGameEventBus();
    const breached: Array<{ doorId: string; dir: { x: number; y: number; z: number } }> = [];
    const noises: string[] = [];
    bus.on('doorBreached', (e) => breached.push({ doorId: e.doorId, dir: e.dir }));
    bus.on('noise', (e) => noises.push(e.kind));

    const door = new Door({ id: 'd_c2', x: 0, z: 0, yaw: 0, maxAngle: 90, locked: true }, DOOR_CFG, 2.8, bus);
    expect(door.locked).toBe(true);

    // Breacher stands at +Z (0, 2); door swings toward -Z
    const ok = door.breachExplosive(0, 2);
    expect(ok).toBe(true);
    expect(door.locked).toBe(false);
    expect(breached).toHaveLength(1);
    expect(breached[0]!.doorId).toBe('d_c2');
    expect(breached[0]!.dir.z).toBeCloseTo(-1, 4);
    expect(noises).toHaveLength(0); // Avoids duplicate kick noise; C2 emits c2Detonated

    // Advance 0.1s (two 0.05s steps, matching Door.update's 0.05s dt clamp) -> 720 deg/s * 0.1s = 72 deg
    door.update(0.05, 0, 10, 0.35);
    door.update(0.05, 0, 10, 0.35);
    expect(door.angle).toBeGreaterThanOrEqual(70);

    // Once fully open and stationary, returns false
    door.update(0.2, 0, 10, 0.35);
    expect(door.breachExplosive(0, 2)).toBe(false);

    door.dispose();
    expect(door.breachExplosive(0, 2)).toBe(false);
  });

  it('shouldUseC2Breach, computeC2Standoff, and evaluateC2BlastCone satisfy all thresholds and directional invariants', () => {
    expect(shouldUseC2Breach(0, 1)).toBe(false);
    expect(shouldUseC2Breach(0.39, 1)).toBe(false);
    expect(shouldUseC2Breach(0.4, 1)).toBe(true);
    expect(shouldUseC2Breach(0.1, 2)).toBe(true);
    expect(shouldUseC2Breach(0.8, 3)).toBe(true);

    // Standoff in open corridor chooses 2.6m on breacher side
    const sample = { id: 'd1', centerX: 0, centerZ: 0, normalX: 0, normalZ: 1, sillY: 0 };
    const open = computeC2Standoff(sample, 1, [], { x: 0, y: 0, z: 0.85 });
    expect(open.z).toBeCloseTo(2.6, 3);

    // Wall behind at z = 2.0 clamps standoff closer
    const wallBehind: Collider = {
      kind: 'wall',
      aabb: { min: { x: -5, y: 0, z: 2.0 }, max: { x: 5, y: 3, z: 2.5 } },
    };
    const clamped = computeC2Standoff(sample, 1, [wallBehind], { x: 0, y: 0, z: 0.85 });
    expect(clamped.z).toBeLessThan(2.0);
    expect(clamped.z).toBeGreaterThanOrEqual(1.3);

    // Blast cone: directly in front takes high damage/stun; closer > farther; behind/side/out-of-range/other-floor take 0
    const origin = { x: 0, y: 1, z: -0.25 };
    const dir = { x: 0, y: 0, z: -1 };
    const near = evaluateC2BlastCone(origin, dir, { x: 0, y: 1.5, z: -1.2 });
    const far = evaluateC2BlastCone(origin, dir, { x: 0, y: 1.5, z: -3.5 });
    const behind = evaluateC2BlastCone(origin, dir, { x: 0, y: 1.5, z: 1.5 });
    const side = evaluateC2BlastCone(origin, dir, { x: 3.0, y: 1.5, z: -0.3 });
    const outOfRange = evaluateC2BlastCone(origin, dir, { x: 0, y: 1.5, z: -(C2_BLAST_RADIUS + 2) });
    const upperFloor = evaluateC2BlastCone(origin, dir, { x: 0, y: 4.0, z: -1.2 });

    expect(near.inCone).toBe(true);
    expect(far.inCone).toBe(true);
    expect(near.damage).toBeGreaterThan(far.damage);
    expect(near.stunScale).toBeGreaterThan(far.stunScale);
    expect(behind.inCone).toBe(false);
    expect(behind.damage).toBe(0);
    expect(side.inCone).toBe(false);
    expect(outOfRange.inCone).toBe(false);
    expect(upperFloor.inCone).toBe(false);
  });

  it('AudioBridge routes c2Beep and c2Detonated to playC2Beep, playC2Blast, and LOS-gated triggerEarRinging', () => {
    const bus = createGameEventBus();
    const audio: AudioBridgeSink = {
      playFootstep: vi.fn(),
      playDoorCreak: vi.fn(),
      playBreach: vi.fn(),
      playGunshot: vi.fn(),
      playFlashbang: vi.fn(),
      playC2Beep: vi.fn(),
      playC2Blast: vi.fn(),
      playWarningCall: vi.fn(),
      playRadioReport: vi.fn(),
      playAllyRadio: vi.fn(),
      triggerEarRinging: vi.fn(),
      updateListener: vi.fn(),
    };
    const eye = new THREE.Vector3(0, 1.6, -2.0);
    const bridge = new AudioBridge(bus, audio, { getEyePosition: (out = new THREE.Vector3()) => out.copy(eye) }, []);

    bus.emit('c2Beep', { pos: { x: 0, y: 1, z: 0 }, urgent: true });
    expect(audio.playC2Beep).toHaveBeenCalledWith({ x: 0, y: 1, z: 0 }, true);

    // Blast side (-Z): player at (0, 1.6, -2) receives blast + ear ringing
    bus.emit('c2Detonated', { doorId: 'd1', pos: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, radius: 4.5 });
    expect(audio.playC2Blast).toHaveBeenCalledTimes(1);
    expect(audio.triggerEarRinging).toHaveBeenCalledTimes(1);

    // Safe side (+Z): player at (0, 1.6, +2) hears blast but does NOT get ear ringing
    eye.set(0, 1.6, 2.0);
    bus.emit('c2Detonated', { doorId: 'd1', pos: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, radius: 4.5 });
    expect(audio.playC2Blast).toHaveBeenCalledTimes(2);
    expect(audio.triggerEarRinging).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  it('SwatTeam runs full C2 plant -> standoff beeps -> detonation, safely disarms door trap, and damages/stuns player behind door', () => {
    const bus = createGameEventBus();
    const beeps: boolean[] = [];
    const detonations: string[] = [];
    bus.on('c2Beep', (e) => beeps.push(e.urgent));
    bus.on('c2Detonated', (e) => detonations.push(e.doorId));

    const door1 = new Door({ id: 'door_1', x: 0, z: 0, yaw: 0, maxAngle: 90, locked: true }, DOOR_CFG, 2.8, bus);
    const door2 = new Door({ id: 'door_2', x: 0, z: 0, yaw: 0, maxAngle: 90, locked: true }, DOOR_CFG, 2.8, bus);
    const rooms: RoomDef[] = [{ id: 'r1', name: 'Room', x: 0, z: -4, width: 10, depth: 8, floorY: 0 }];
    const playerPos = new THREE.Vector3(0, 0, -1.5);
    const addViewKick = vi.fn();
    const flashTrigger = vi.fn();
    const player = {
      position: playerPos,
      alive: true,
      isCrouching: false,
      yawRad: 0,
      hp: 100,
      addViewKick,
      getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
      getBodyBounds: () => ({
        min: { x: playerPos.x - 0.3, y: playerPos.y, z: playerPos.z - 0.3 },
        max: { x: playerPos.x + 0.3, y: playerPos.y + 1.75, z: playerPos.z + 0.3 },
      }),
      takeDamage: vi.fn((dmg: number) => {
        player.hp = Math.max(0, player.hp - dmg);
        return player.hp;
      }),
    };

    const trapped = new Set<string>(['door_2']);
    const traps: TrapHooks = {
      isTrapped: (id) => trapped.has(id),
      trappedDoorIds: () => trapped.keys(),
      disarm: vi.fn((id: string) => {
        trapped.delete(id);
      }),
      detonate: vi.fn(),
    };

    const team = new SwatTeam({
      spawns: [{ x: 0, y: 0, z: 0.9 }],
      count: 1,
      player,
      colliders: [...door2.colliders], // Include door2's own closed collider to prove 0.25m blastOrigin offset avoids self-occlusion!
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [door1, door2] } as unknown as DoorSystem,
      bounds: { width: 20, depth: 20 },
      stairs: [],
      rooms,
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      flashOverlay: { trigger: flashTrigger },
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    });
    team.attachTraps(traps);

    // 1st locked door at low pressure -> kick; 2nd locked door -> C2
    expect(team.shouldUseC2('door_1')).toBe(false);
    const hunter = team.hunters[0]!;
    hunter.state = 'sweep';
    expect(hunter.tryBeginBreach({ x: 0, y: 0, z: -2 }, 'door_2')).toBe(true);
    expect(hunter.breachMode).toBe('c2');

    // Advance through plant (0.8s) + standoff fuse (1.8s) = 2.6s
    for (let i = 0; i < 60; i++) team.update(0.05);

    expect(beeps.length).toBeGreaterThanOrEqual(4);
    expect(beeps.some((u) => u === false)).toBe(true);
    expect(beeps.some((u) => u === true)).toBe(true);
    expect(detonations).toEqual(['door_2']);
    expect(door2.locked).toBe(false);
    // Booby trap was safely disarmed, never detonated on breacher
    expect(traps.disarm).toHaveBeenCalledWith('door_2');
    expect(traps.detonate).not.toHaveBeenCalled();
    expect(hunter.alive).toBe(true);
    // Player behind door took blast damage, view kick, and flash stun
    expect(player.takeDamage).toHaveBeenCalled();
    expect(player.hp).toBeLessThan(100);
    expect(addViewKick).toHaveBeenCalled();
    expect(flashTrigger).toHaveBeenCalled();

    team.dispose();
    door1.dispose();
    door2.dispose();
  });

  it('prevents duplicate/concurrent C2 breach and double detonation on the same locked door', () => {
    const bus = createGameEventBus();
    const doorBreachedEvents: string[] = [];
    const detonations: string[] = [];
    bus.on('doorBreached', (e) => doorBreachedEvents.push(e.doorId));
    bus.on('c2Detonated', (e) => detonations.push(e.doorId));

    // Part A: Door.breachExplosive called twice on the same tick (before Door.update runs) -> only 1 succeeds
    const sameTickDoor = new Door({ id: 'd_same_tick', x: 0, z: 0, yaw: 0, maxAngle: 90, locked: true }, DOOR_CFG, 2.8, bus);
    expect(sameTickDoor.breachExplosive(0, 2)).toBe(true);
    expect(sameTickDoor.breachExplosive(0, 2)).toBe(false);
    expect(doorBreachedEvents).toEqual(['d_same_tick']);
    sameTickDoor.dispose();

    // Defensive check: non-positive radius at dist === 0 returns zero (no NaN)
    const zeroRadius = evaluateC2BlastCone({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, 0);
    expect(zeroRadius).toEqual({ inCone: false, dist: 0, falloff: 0, damage: 0, stunScale: 0 });

    // Part B: Two cells sharing a single locked exterior door on releaseStackedEntry -> only ONE breacher & ONE c2Detonated
    const sharedDoor = new Door({ id: 'shared_door', x: 0, z: 5, yaw: 0, maxAngle: 90, locked: true }, DOOR_CFG, 2.8, bus);
    const rooms: RoomDef[] = [{ id: 'r1', name: 'Main Hall', x: 0, z: 0, width: 10, depth: 10, floorY: 0 }];
    const playerPos = new THREE.Vector3(50, 0, 50); // far away so sense() does not abort stack
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
        getBodyBounds: () => ({ min: { x: 49.7, y: 0, z: 49.7 }, max: { x: 50.3, y: 1.75, z: 50.3 } }),
        takeDamage: vi.fn(() => 100),
      },
      colliders: [],
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [sharedDoor] } as unknown as DoorSystem,
      bounds: { width: 28, depth: 28 },
      stairs: [],
      rooms,
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    });

    // Pre-register a prior locked door so shared_door triggers C2 mode (2nd locked door)
    expect(team.shouldUseC2('prior_door')).toBe(false);
    team.beginAssault();

    // Place all 4 hunters on their stack slots at shared_door and advance past ENTRY_COUNTDOWN_SEC
    for (const h of team.hunters) {
      const slot = h.stackSlot!;
      h.body.setPosition(slot.x, slot.z, slot.y);
    }
    for (let i = 0; i < 65; i++) team.update(0.05);

    // At most ONE hunter should be breaching shared_door at a time
    const breachers = team.hunters.filter((h) => h.state === 'breach' && h.breachDoorId === 'shared_door');
    expect(breachers.length).toBeLessThanOrEqual(1);

    // Advance enough time for C2 approach + plant + standoff detonation
    for (let i = 0; i < 120; i++) team.update(0.05);

    expect(detonations).toEqual(['shared_door']);
    expect(sharedDoor.locked).toBe(false);

    team.dispose();
    sharedDoor.dispose();
  });
});
