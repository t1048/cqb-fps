import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import type { RoomDef } from '../../src/core/types';
import { SwatTeam, type SwatTeamDeps } from '../../src/modes/SwatTeam';
import type { DoorSystem } from '../../src/world/Door';
import type { Flashbang } from '../../src/weapons/Flashbang';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { Subtitle } from '../../src/ui/Subtitle';

function makeHarness(overrides: Partial<SwatTeamDeps> = {}, playerYawRad = 0) {
  const bus = createGameEventBus();
  // プレイヤーは (0, 0, -2)、SWAT は (0, 0, 3) で北 (-z) を向いて対面する
  // yawRad = 0 は -z 方向（SWAT に背を向けている）
  const playerPos = new THREE.Vector3(0, 0, -2);
  let surrendering = false;
  let surrendered = false;
  const player = {
    position: playerPos,
    alive: true,
    isCrouching: false,
    yawRad: playerYawRad,
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
  const flashbang = { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang;
  const weapons = { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem;
  const doors = { doors: [] } as unknown as DoorSystem;
  const subtitle = { show: vi.fn() } as unknown as Subtitle;
  const onPepper = vi.fn();

  const team = new SwatTeam({
    spawns: [{ x: 0, y: 0, z: 3 }],
    count: 1,
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
    onPepper,
    isPlayerSurrendering: () => surrendering,
    isPlayerSurrendered: () => surrendered,
    ...overrides,
  });

  return {
    team,
    bus,
    player,
    subtitle,
    onPepper,
    setSurrendering: (v: boolean) => {
      surrendering = v;
    },
    setSurrendered: (v: boolean) => {
      surrendered = v;
    },
  };
}

describe('Suspect mode SWAT RoE, compliance challenge, and anti-chase tactics', () => {
  it('challenges a non-hostile player instead of shooting live rounds immediately', () => {
    const { team, player } = makeHarness();
    team.beginAssault();
    // 2 秒間進めても未発砲・銃口を向けていないプレイヤーは撃たれない
    for (let i = 0; i < 40; i++) team.update(0.05);
    expect(team.playerHostile).toBe(false);
    expect(team.hunters[0]!.state).toBe('challenge');
    expect(player.takeDamage).not.toHaveBeenCalled();
    team.dispose();
  });

  it('uses less-lethal pepperball if a non-hostile player ignores compliance calls past grace period', () => {
    const { team, player } = makeHarness();
    team.beginAssault();
    // 勧告猶予 3.5s を超えて 5.0s 経過させる
    for (let i = 0; i < 100; i++) team.update(0.05);
    expect(team.playerHostile).toBe(false);
    expect(team.hunters[0]!.state).toBe('challenge');
    expect(team.pepperShots).toBeGreaterThanOrEqual(1);
    expect(player.takeDamage).not.toHaveBeenCalled();
    team.dispose();
  });

  it('engages with live fire when the player shoots or aims continuously at the officer', () => {
    // 1. 発砲で即敵対確定 → engage へ
    {
      const { team, bus } = makeHarness();
      team.beginAssault();
      for (let i = 0; i < 20; i++) team.update(0.05);
      expect(team.hunters[0]!.state).toBe('challenge');

      bus.emit('shotFired', { shooter: 'player', pos: { x: 0, y: 1.5, z: -2 } });
      for (let i = 0; i < 10; i++) team.update(0.05);
      expect(team.playerHostile).toBe(true);
      expect(team.hunters[0]!.state).toBe('engage');
      team.dispose();
    }

    // 2. 銃口を隊員（+z 方向 = yawRad = Math.PI）へ 1.2s 以上向け続けると敵対確定
    {
      const { team } = makeHarness({}, Math.PI);
      team.beginAssault();
      for (let i = 0; i < 45; i++) team.update(0.05);
      expect(team.playerHostile).toBe(true);
      expect(team.hunters[0]!.state).toBe('engage');
      team.dispose();
    }
  });

  it('holds fire immediately when a hostile player starts surrendering (Space hold)', () => {
    const { team, bus, player, setSurrendering } = makeHarness();
    team.beginAssault();
    bus.emit('shotFired', { shooter: 'player', pos: { x: 0, y: 1.5, z: -2 } });
    for (let i = 0; i < 15; i++) team.update(0.05);
    expect(team.hunters[0]!.state).toBe('engage');

    // 投降開始: 以降のダメージは 0、状態は challenge に戻る
    player.takeDamage.mockClear();
    setSurrendering(true);
    for (let i = 0; i < 30; i++) team.update(0.05);
    expect(team.hunters[0]!.state).toBe('challenge');
    expect(player.takeDamage).not.toHaveBeenCalled();
    team.dispose();
  });

  it('moves in to arrest without firing once player surrender is complete', () => {
    const { team, player, setSurrendered } = makeHarness();
    team.beginAssault();
    for (let i = 0; i < 15; i++) team.update(0.05);
    const startDist = Math.hypot(team.hunters[0]!.body.px - player.position.x, team.hunters[0]!.body.pz - player.position.z);

    setSurrendered(true);
    for (let i = 0; i < 40; i++) team.update(0.05);
    const endDist = Math.hypot(team.hunters[0]!.body.px - player.position.x, team.hunters[0]!.body.pz - player.position.z);
    expect(endDist).toBeLessThan(startDist);
    expect(player.takeDamage).not.toHaveBeenCalled();
    team.dispose();
  });

  it('does not skip uncleared rooms via omniscient watchPursuit after 15s without contact', () => {
    const rooms: RoomDef[] = [
      { id: 'room_entry', name: 'Entry', x: 0, z: 0, width: 10, depth: 10, floorY: 0 },
      { id: 'room_back', name: 'Back Room', x: 0, z: -14, width: 10, depth: 10, floorY: 0 },
    ];
    // プレイヤーは奥の部屋（壁で隔離されて見えない）
    const wall = {
      kind: 'wall' as const,
      aabb: { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 3, z: -5.5 } },
    };
    const { team, player } = makeHarness({
      rooms,
      colliders: [wall],
      spawns: [{ x: 0, y: 0, z: 3 }],
    });
    player.position.set(0, 0, -14);
    team.beginAssault();
    // 20 秒経過しても未クリア部屋が残っているため、watchPursuit が強制 hunt を飛ばさない
    for (let i = 0; i < 400; i++) team.update(0.05);
    expect(team.hunters[0]!.state).not.toBe('hunt');
    team.dispose();
  });
});
