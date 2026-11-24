import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import type { RoomDef } from '../../src/core/types';
import {
  PRESSURE_PER_DOWN,
  PRESSURE_RAMP_SEC,
  SHIELD_COMBAT,
  SWAT_COMBAT,
  SwatTeam,
  VISION_FOV_DEG,
  type SwatTeamDeps,
} from '../../src/modes/SwatTeam';
import type { DoorSystem } from '../../src/world/Door';
import type { Flashbang } from '../../src/weapons/Flashbang';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { Subtitle } from '../../src/ui/Subtitle';

function makeTestSwatTeam(overrides: Partial<SwatTeamDeps> = {}) {
  const bus = createGameEventBus();
  const playerPos = new THREE.Vector3(0, 0, 0);
  const player = {
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
    takeDamage: vi.fn((dmg: number) => {
      player.hp = Math.max(0, player.hp - dmg);
      return player.hp;
    }),
  };
  const rooms: RoomDef[] = [
    { id: 'room_1', name: 'Living Room', x: 0, z: 0, width: 16, depth: 16, floorY: 0 },
  ];
  const flashbang = {
    gravity: 9.8,
    throwFrom: vi.fn(),
  } as unknown as Flashbang;
  const weapons = {
    addTarget: vi.fn(),
    removeTarget: vi.fn(),
  } as unknown as WeaponSystem;
  const doors = {
    doors: [],
  } as unknown as DoorSystem;
  const subtitle = {
    show: vi.fn(),
  } as unknown as Subtitle;

  const team = new SwatTeam({
    spawns: [
      { x: 0, y: 0, z: 6 },
      { x: 2, y: 0, z: 6 },
    ],
    count: 2,
    player,
    colliders: [],
    bus,
    weapons,
    doors,
    bounds: { width: 20, depth: 20 },
    stairs: [],
    rooms,
    windows: [],
    flashbang,
    subtitle,
    civilians: () => [],
    ...overrides,
  });

  return { team, bus, player, flashbang, subtitle };
}

describe('SwatTeam — F2 Flinch Ramp, F3 Vulnerability Rush, F4 Perception/Speed/Pressure', () => {
  it('F4 & F2: exposes boosted perception/pressure constants and ramps flinchSec, speed, and reactionSec cleanly', () => {
    expect(VISION_FOV_DEG).toBe(120);
    expect(PRESSURE_RAMP_SEC).toBe(95);
    expect(PRESSURE_PER_DOWN).toBe(0.12);

    const { team } = makeTestSwatTeam();
    // Initial reset state
    expect(SWAT_COMBAT.flinchSec).toBeCloseTo(0.35, 4);
    expect(SHIELD_COMBAT.flinchSec).toBeCloseTo(0.06, 4);
    expect(SWAT_COMBAT.moveSpeed).toBeCloseTo(2.35, 4);
    expect(SHIELD_COMBAT.moveSpeed).toBeCloseTo(1.95, 4);
    expect(team.reactionSec).toBeCloseTo(0.35, 4);

    team.beginAssault();
    // Advance full PRESSURE_RAMP_SEC (95s) in 0.05s steps
    for (let i = 0; i < 1920; i++) {
      team.update(0.05);
    }

    expect(team.currentPressure).toBeCloseTo(1, 3);
    expect(SWAT_COMBAT.flinchSec).toBeCloseTo(0.09, 3);
    expect(SHIELD_COMBAT.flinchSec).toBeCloseTo(0.05, 3);
    expect(SWAT_COMBAT.moveSpeed).toBeCloseTo(2.75, 3);
    expect(SHIELD_COMBAT.moveSpeed).toBeCloseTo(2.35, 3);
    expect(team.reactionSec).toBeCloseTo(0.16, 3);

    team.dispose();

    // New SwatTeam resets shared SWAT_COMBAT and SHIELD_COMBAT cleanly
    const { team: team2 } = makeTestSwatTeam();
    expect(SWAT_COMBAT.flinchSec).toBeCloseTo(0.35, 4);
    expect(SHIELD_COMBAT.flinchSec).toBeCloseTo(0.06, 4);
    expect(SWAT_COMBAT.moveSpeed).toBeCloseTo(2.35, 4);
    expect(SHIELD_COMBAT.moveSpeed).toBeCloseTo(1.95, 4);
    team2.dispose();
  });

  it('F3: triggers rush on playerBlinded, reload noise (even < 3.2m), pepper hit, and low HP <= 40', () => {
    // 1. playerBlinded trigger
    {
      const { team, bus } = makeTestSwatTeam();
      team.beginAssault();
      bus.emit('playerBlinded', { duration: 2.0, pos: { x: 0, y: 0, z: 0 } });
      expect(team.hunters.some((h) => h.state === 'rush')).toBe(true);
      team.dispose();
    }

    // 2. player reload noise trigger (even within SELF_NOISE_RADIUS 3.2m)
    {
      const { team, bus } = makeTestSwatTeam({
        spawns: [
          { x: 0, y: 0, z: 2.0 },
          { x: 2, y: 0, z: 2.0 },
        ],
      });
      team.beginAssault();
      bus.emit('noise', { pos: { x: 0, y: 1.0, z: 0 }, radius: 12, kind: 'reload', source: 'player' });
      expect(team.hunters.some((h) => h.state === 'rush')).toBe(true);
      team.dispose();
    }

    // 3. playerHit low HP trigger (hp <= 40 triggers rush; hp > 40 does not)
    {
      const { team, bus } = makeTestSwatTeam();
      team.beginAssault();
      bus.emit('playerHit', { shooter: 'swat_1', damage: 20, from: { x: 0, y: 0, z: 6 }, hp: 60 });
      expect(team.hunters.some((h) => h.state === 'rush')).toBe(false);

      bus.emit('playerHit', { shooter: 'swat_1', damage: 25, from: { x: 0, y: 0, z: 6 }, hp: 35 });
      expect(team.hunters.some((h) => h.state === 'rush')).toBe(true);
      team.dispose();
    }

    // 4. firePepper hitting player triggers rush
    {
      const onPepper = vi.fn();
      const { team } = makeTestSwatTeam({ onPepper });
      team.beginAssault();
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.0);
      team.firePepper(team.hunters[0]!, { x: 0, y: 1.1, z: 0 });
      spy.mockRestore();
      expect(onPepper).toHaveBeenCalledWith('player');
      expect(team.hunters.some((h) => h.state === 'rush')).toBe(true);
      team.dispose();
    }
  });

  it('F3 & F2: rushing hunter preserves rush state on hit and does not mutate shared SWAT_COMBAT.moveSpeed', () => {
    const { team, bus } = makeTestSwatTeam();
    team.beginAssault();

    const baseSwatSpeed = SWAT_COMBAT.moveSpeed;
    const baseShieldSpeed = SHIELD_COMBAT.moveSpeed;

    bus.emit('playerBlinded', { duration: 2.5, pos: { x: 0, y: 0, z: 0 } });
    const rusher = team.hunters[1]!; // rifleman (index 0 is shielded)
    expect(rusher.state).toBe('rush');

    // Step rush movement and verify shared combat configs were NOT mutated to rush speeds (2.7-2.9 / 2.35)
    team.update(0.05);
    expect(SWAT_COMBAT.moveSpeed).toBeCloseTo(baseSwatSpeed, 2);
    expect(SWAT_COMBAT.moveSpeed).toBeLessThan(2.5);
    expect(SHIELD_COMBAT.moveSpeed).toBeCloseTo(baseShieldSpeed, 2);
    expect(SHIELD_COMBAT.moveSpeed).toBeLessThan(2.1);

    // Hit the rushing hunter: must stay in 'rush' rather than demoting to 'engage'
    const killed = rusher.takeHit(15, { x: 0, y: 0, z: 0 });
    expect(killed).toBe(false);
    expect(rusher.state).toBe('rush');

    team.dispose();
  });
});
