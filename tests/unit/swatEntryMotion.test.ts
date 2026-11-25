import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import type { RoomDef } from '../../src/core/types';
import { cqbPortalFromStackSlotPortal, toPortalFrame } from '../../src/ai/cqbEntry';
import {
  assignSwatStackSlots,
  buildStackSlotPortal,
  SwatTeam,
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
  swingSpeed: 120,
  knobSpeedMultiplier: 2,
  segmentLength: 0.35,
  interactRange: 2.2,
  breach: { speedMultiplier: 6, noiseRadius: 18, effectRadius: 5 },
  noise: { slowRadius: 5, fastRadius: 10 },
};

function makeWall(minX: number, maxX: number, minZ: number, maxZ: number, minY = 0, maxY = 3): Collider {
  return { kind: 'wall', aabb: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } };
}

/** 10m×10m の部屋（x∈[-5,5], z∈[-5,5]）、南壁 z=5 の中央に幅 1.2m のドア開口（x∈[-0.6,0.6]） */
function makeSingleDoorRoomHarness(opts?: { count?: number; spawns?: { x: number; y: number; z: number }[]; locked?: boolean }) {
  const bus = createGameEventBus();
  const radios: string[] = [];
  bus.on('allyRadio', (e) => radios.push(e.text));

  const doorFront = new Door(
    { id: 'door_front', x: 0, z: 5, yaw: 0, width: 1.2, maxAngle: 90, locked: opts?.locked ?? false },
    DOOR_CFG,
    2.8,
    bus,
  );
  const walls: Collider[] = [
    // 南壁（ドア開口 x∈[-0.65, 0.65] を空ける）
    makeWall(-5.2, -0.65, 4.9, 5.1),
    makeWall(0.65, 5.2, 4.9, 5.1),
    // 北壁
    makeWall(-5.2, 5.2, -5.1, -4.9),
    // 西壁・東壁
    makeWall(-5.1, -4.9, -5.1, 5.1),
    makeWall(4.9, 5.1, -5.1, 5.1),
  ];
  const colliders: Collider[] = [...walls, ...doorFront.colliders];
  const rooms: RoomDef[] = [{ id: 'r1', name: 'Main Hall', x: 0, z: 0, width: 10, depth: 10, floorY: 0 }];
  // プレイヤーは屋外遠くに退避して接敵で中断されないようにする
  const playerPos = new THREE.Vector3(50, 0, 50);
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
    takeDamage: vi.fn(() => 100),
  };

  const count = opts?.count ?? 4;
  const spawns =
    opts?.spawns ??
    [
      { x: -1.4, y: 0, z: 7.2 },
      { x: -1.4, y: 0, z: 8.1 },
      { x: 1.4, y: 0, z: 7.2 },
      { x: 1.4, y: 0, z: 8.1 },
    ].slice(0, count);

  const deps: SwatTeamDeps = {
    spawns,
    count,
    player,
    colliders,
    bus,
    weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
    doors: { doors: [doorFront] } as unknown as DoorSystem,
    bounds: { width: 28, depth: 28 },
    stairs: [],
    rooms,
    windows: [],
    flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
    subtitle: { show: vi.fn() } as unknown as Subtitle,
    civilians: () => [],
  };

  const team = new SwatTeam(deps);
  const step = (dt = 0.05) => {
    doorFront.update(dt, playerPos.x, playerPos.z, 0.35, playerPos.y);
    team.update(dt);
  };
  const cleanup = () => {
    team.dispose();
    doorFront.dispose();
  };
  return { team, doorFront, bus, radios, playerPos, rooms, step, cleanup };
}

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

describe('SwatTeam CQB Entry & Motion Overhaul (§5 / §6)', () => {
  it('1 door, 4 hunters: enters "entry" state after release, crosses threshold in entryOrder with no lateral sign flips', () => {
    const { team, doorFront, step, cleanup } = makeSingleDoorRoomHarness({ count: 4 });
    team.beginAssault();
    expect(team.hunters.every((h) => h.state === 'stack')).toBe(true);

    // スタック枠に直接配置してカウントダウンを進める
    for (const h of team.hunters) {
      const slot = h.stackSlot!;
      h.body.setPosition(slot.x, slot.z, slot.y, false);
    }

    const portal = team.hunters[0]!.assignedPortal!;
    const cqb = cqbPortalFromStackSlotPortal(buildStackSlotPortal(portal, doorFront), portal.sillY);

    // 解放されるまで進める
    let released = false;
    for (let i = 0; i < 80; i++) {
      step(0.05);
      if (team.hunters.every((h) => h.state === 'entry')) {
        released = true;
        break;
      }
    }
    expect(released).toBe(true);

    // 各隊員の敷居越えフレームと、敷居越え後の lateral(u) 符号反転を記録
    const crossFrame = new Map<string, number>();
    const lateralFlips = new Map<string, number>();
    for (const h of team.hunters) lateralFlips.set(h.id, 0);

    for (let f = 0; f < 220; f++) {
      step(0.05);
      for (const h of team.hunters) {
        const { u, v } = toPortalFrame(cqb, { x: h.body.px, z: h.body.pz });
        if (!crossFrame.has(h.id) && v >= 0.25) {
          crossFrame.set(h.id, f);
        }
        // entry 中に自サイドと逆側（閾値 0.15m 超）へ越境していないか
        if (h.state === 'entry' && h.entryPlan) {
          if (u * h.entryPlan.side < -0.15) {
            lateralFlips.set(h.id, (lateralFlips.get(h.id) ?? 0) + 1);
          }
        }
      }
      if (team.hunters.every((h) => h.state !== 'entry')) break;
    }

    // 全員が敷居を越えたこと
    expect(crossFrame.size).toBe(4);
    // 敷居越え順序が entryOrder と単調一致すること
    const byOrder = team.hunters.slice().sort((a, b) => a.entryOrder - b.entryOrder);
    for (let i = 1; i < byOrder.length; i++) {
      const prevF = crossFrame.get(byOrder[i - 1]!.id)!;
      const curF = crossFrame.get(byOrder[i]!.id)!;
      expect(curF).toBeGreaterThanOrEqual(prevF);
    }
    // 突入中に lateral 符号反転（サイド交差）が無いこと
    for (const h of team.hunters) {
      expect(lateralFlips.get(h.id)).toBe(0);
    }

    cleanup();
  });

  it('each hunter reaches within 0.5m of PoD and holds still for ~1.0s before transitioning to sweep', () => {
    const { team, step, cleanup } = makeSingleDoorRoomHarness({ count: 4 });
    team.beginAssault();
    for (const h of team.hunters) {
      const slot = h.stackSlot!;
      h.body.setPosition(slot.x, slot.z, slot.y, false);
    }

    const podDistAtHoldStart = new Map<string, number>();
    const holdStartPos = new Map<string, { x: number; z: number }>();
    const holdMaxDrift = new Map<string, number>();
    const holdDuration = new Map<string, number>();
    const finishedEntry = new Set<string>();

    for (let f = 0; f < 300; f++) {
      step(0.05);
      for (const h of team.hunters) {
        if (h.state === 'entry' && h.entryPlan && h.entryWp >= h.entryPlan.waypoints.length) {
          if (!podDistAtHoldStart.has(h.id)) {
            const pod = h.entryPlan.pod;
            podDistAtHoldStart.set(h.id, Math.hypot(h.body.px - pod.x, h.body.pz - pod.z));
            holdStartPos.set(h.id, { x: h.body.px, z: h.body.pz });
            holdMaxDrift.set(h.id, 0);
            holdDuration.set(h.id, 0);
          } else {
            const s = holdStartPos.get(h.id)!;
            const drift = Math.hypot(h.body.px - s.x, h.body.pz - s.z);
            holdMaxDrift.set(h.id, Math.max(holdMaxDrift.get(h.id)!, drift));
            holdDuration.set(h.id, (holdDuration.get(h.id) ?? 0) + 0.05);
          }
        } else if (podDistAtHoldStart.has(h.id) && h.state === 'sweep') {
          finishedEntry.add(h.id);
        }
      }
      if (finishedEntry.size === 4) break;
    }

    expect(finishedEntry.size).toBe(4);
    for (const h of team.hunters) {
      expect(podDistAtHoldStart.get(h.id)!).toBeLessThanOrEqual(0.5);
      // PoD 保持中はほぼ静止（ドリフト < 0.05m）、約 1.0s 保持
      expect(holdMaxDrift.get(h.id)!).toBeLessThan(0.05);
      expect(holdDuration.get(h.id)!).toBeGreaterThanOrEqual(0.9);
      expect(holdDuration.get(h.id)!).toBeLessThanOrEqual(1.25);
    }

    cleanup();
  });

  it('does NOT mark the room cleared while hunters are stacked outside the door', () => {
    const { team, doorFront, radios, step, cleanup } = makeSingleDoorRoomHarness({ count: 4 });
    // ドアを開けた状態でも屋外スタック中は部屋クリア扱いにならないことを検証
    doorFront.command(doorFront.maxAngle, true, 0, 7);
    for (let i = 0; i < 25; i++) doorFront.update(0.05, 50, 50, 0.35, 0);

    team.beginAssault();
    // 3 人だけ枠に置き、1 人を遠くに置いてスタック待機状態を継続させる
    for (let i = 0; i < 3; i++) {
      const h = team.hunters[i]!;
      const slot = h.stackSlot!;
      h.body.setPosition(slot.x, slot.z, slot.y, false);
    }
    team.hunters[3]!.body.setPosition(0, 12, 0, false);

    // 数秒間スタック状態を更新（scanCoverage が何回も走る）
    for (let i = 0; i < 40; i++) {
      // 4 人目を戻し続けてスタック待機を維持
      team.hunters[3]!.body.setPosition(0, 12, 0, false);
      team.hunters[3]!.stackReady = false;
      step(0.05);
    }

    expect(team.hunters.every((h) => h.state === 'stack')).toBe(true);
    expect(radios.some((t) => t.includes('クリア'))).toBe(false);
    // 仮に 1 人を屋内中心に置いたとき、まだ未クリアの部屋として検出されること
    const probe = team.hunters[0]!;
    probe.body.setPosition(0, 0, 0, false);
    expect(team.unclearedIndoorRoom(probe)?.id).toBe('r1');

    cleanup();
  });

  it('stopped follower in sweep state has low yaw sign-reversal count (<= 2 over 2s)', () => {
    const { team, step, cleanup } = makeSingleDoorRoomHarness({
      count: 2,
      spawns: [
        { x: 0, y: 0, z: 0 },
        { x: -0.5, y: 0, z: 1.1 },
      ],
    });
    team.beginAssault();
    // 屋内スポーンなので即 sweep。全セルを seen にしてリーダーを静止させる
    const leader = team.hunters[0]!;
    const follower = team.hunters[1]!;
    team.markSeenAround(0, 0, 0, 20);
    leader.body.setPosition(0, 0, 0, false);
    follower.body.setPosition(-0.5, 1.1, 0, false);

    // リーダーを静止させた状態で 1 秒落ち着かせ、その後 2 秒間の停止中フォロワーの yaw 符号反転回数を計測
    const tickStopped = () => {
      leader.body.setPosition(0, 0, 0, false);
      step(0.05);
      leader.body.setPosition(0, 0, 0, false);
    };
    for (let i = 0; i < 20; i++) tickStopped();

    let prevYaw = follower.body.yawRad;
    let prevSign = 0;
    let reversals = 0;
    const startX = follower.body.px;
    const startZ = follower.body.pz;
    let maxDrift = 0;

    for (let i = 0; i < 40; i++) {
      tickStopped();
      const dy = wrapAngle(follower.body.yawRad - prevYaw);
      const sign = Math.abs(dy) > 1e-3 ? Math.sign(dy) : 0;
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) reversals++;
      if (sign !== 0) prevSign = sign;
      prevYaw = follower.body.yawRad;
      maxDrift = Math.max(maxDrift, Math.hypot(follower.body.px - startX, follower.body.pz - startZ));
    }

    expect(reversals).toBeLessThanOrEqual(2);
    expect(maxDrift).toBeLessThan(0.05);

    cleanup();
  });

  it('assignSwatStackSlots keeps same-cell pairs on the same side when possible', () => {
    const portal = {
      center: { x: 0, y: 0, z: 5 },
      into: { x: 0, z: -1 },
      axis: { x: 1, z: 0 },
      width: 1.2,
    };
    const slots = [
      { x: -0.9, z: 5.5, side: -1 as const, depth: 0 },
      { x: 0.9, z: 5.5, side: 1 as const, depth: 0 },
      { x: -1.6, z: 5.5, side: -1 as const, depth: 1 },
      { x: 1.6, z: 5.5, side: 1 as const, depth: 1 },
    ];
    // 全員中央付近に並んでいる状態: Red(0,0) が左(-1)、Blue(1,1) が右(+1) に分かれること
    const positions = [
      { x: -0.2, z: 7.0 },
      { x: 0.1, z: 7.5 },
      { x: -0.1, z: 7.5 },
      { x: 0.2, z: 7.0 },
    ];
    const cellKeys = [0, 0, 1, 1];
    const assign = assignSwatStackSlots(positions, cellKeys, slots, portal);
    expect(slots[assign[0]!]!.side).toBe(-1);
    expect(slots[assign[1]!]!.side).toBe(-1);
    expect(slots[assign[2]!]!.side).toBe(1);
    expect(slots[assign[3]!]!.side).toBe(1);
  });
});
