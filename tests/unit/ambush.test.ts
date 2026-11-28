import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  ambushProbability,
  ambushReactionSec,
  doorwaysOfRoom,
  findAmbushSpot,
  inPreAimCone,
  intoRoomDir,
  type Doorway,
  type RoomRect,
} from '../../src/ai/Ambush';
import { Perception } from '../../src/ai/Perception';
import { EngageBehavior, type CombatContext } from '../../src/ai/EngageBehavior';
import { HumanoidBody } from '../../src/ai/HumanoidBody';
import { Suspect } from '../../src/ai/Suspect';
import { validateAIProfiles, validatePerception, DEFAULT_AMBUSH } from '../../src/core/DataLoader';
import { SuspectState, createGameEventBus } from '../../src/core/events';
import type { AIProfile, AmbushParams, CombatParams, RoomDef } from '../../src/core/types';
import { hasLineOfSight } from '../../src/weapons/Flashbang';
import type { DoorSystem } from '../../src/world/Door';
import type { Collider } from '../../src/world/WorldBuilder';

const dataDir = path.resolve(__dirname, '../../public/data');
const profiles = validateAIProfiles(JSON.parse(fs.readFileSync(path.join(dataDir, 'ai_profiles.json'), 'utf-8')));
const perceptionCfg = validatePerception(JSON.parse(fs.readFileSync(path.join(dataDir, 'perception.json'), 'utf-8')));

function box(minX: number, minZ: number, maxX: number, maxZ: number, kind: Collider['kind'] = 'wall'): Collider {
  return { kind, aabb: { min: { x: minX, y: 0, z: minZ }, max: { x: maxX, y: 3, z: maxZ } } };
}

/** 6x6 の部屋（x∈[-3,3], z∈[-8,-2]）。手前（z=-2）の壁の中央 1m が出入口。 */
function roomWalls(): Collider[] {
  return [
    box(-3.1, -2.1, -0.5, -1.9), // 手前壁 左
    box(0.5, -2.1, 3.1, -1.9), // 手前壁 右
    box(-3.1, -8.1, 3.1, -7.9), // 奥壁
    box(-3.1, -8.1, -2.9, -1.9), // 左壁
    box(2.9, -8.1, 3.1, -1.9), // 右壁
  ];
}

const room: RoomRect = { x: 0, z: -5, width: 6, depth: 6, floorY: 0 };
const doorway: Doorway = { id: 'd1', x: 0, z: -2, nx: 0, nz: 1, ax: 1, az: 0, sillY: 0, width: 1 };

describe('待ち伏せの純粋ヘルパ', () => {
  const params: AmbushParams = { ...DEFAULT_AMBUSH, chance: 0.5, preAimReactionSec: 0.16 };

  it('pre-aim 状態の反応時間は通常の反応時間より長くならず、極端に短い', () => {
    expect(ambushReactionSec(params, 0.7, true)).toBeCloseTo(0.16);
    expect(ambushReactionSec(params, 0.7, false)).toBeCloseTo(0.7);
    expect(ambushReactionSec(params, 0.1, true)).toBeCloseTo(0.1);
    expect(ambushReactionSec(params, 0.7, true)).toBeLessThan(0.7 / 3);
  });

  it('攻撃性が高いほど待ち伏せを選びやすい（0〜1 にクランプ）', () => {
    expect(ambushProbability(params, 1)).toBeGreaterThan(ambushProbability(params, 0));
    expect(ambushProbability({ ...params, chance: 1 }, 1)).toBe(1);
    expect(ambushProbability({ ...params, chance: 0 }, 1)).toBe(0);
  });

  it('pre-aim 円錐: 正面の入室者は内側、真横は外側', () => {
    const facing = { x: 0, z: -1 };
    expect(inPreAimCone(facing, { x: 0, z: 0 }, { x: 0.5, z: -4 }, 70)).toBe(true);
    expect(inPreAimCone(facing, { x: 0, z: 0 }, { x: 4, z: -0.5 }, 70)).toBe(false);
    expect(inPreAimCone(facing, { x: 0, z: 0 }, { x: 0, z: 3 }, 70)).toBe(false);
  });

  it('入口は部屋の縁にあるものだけ、内側方向は部屋の中を向く', () => {
    const inner: Doorway = { ...doorway, id: 'mid', x: 0, z: -5 };
    const found = doorwaysOfRoom([doorway, inner], room);
    expect(found.map((d) => d.id)).toEqual(['d1']);
    const into = intoRoomDir(doorway, room);
    expect(into).toEqual({ x: -0, z: -1 }); // 部屋は -Z 側
  });

  it('待ち伏せ位置: 入口が見渡せ、入口の外からは見えにくい壁際の隅', () => {
    const colliders = roomWalls();
    const spot = findAmbushSpot({ colliders, room, doorway, from: { x: 2, z: -6 }, maxDist: 14, rand: () => 0 });
    expect(spot).not.toBeNull();
    const s = spot!;
    // 入口との間に視線が通る
    const eyeY = s.crouch ? 0.95 : 1.45;
    expect(hasLineOfSight(colliders, { x: s.x, y: eyeY, z: s.z }, { x: 0, y: 1.1, z: -2 })).toBe(true);
    // 入口の外（廊下側）から入口越しに見えない = 入口の真正面ではなく脇に寄っている
    expect(hasLineOfSight(colliders, { x: 0, y: 1.5, z: 0.2 }, { x: s.x, y: 1.2, z: s.z })).toBe(false);
    expect(Math.abs(s.x)).toBeGreaterThanOrEqual(0.9);
    expect(Math.hypot(s.x - doorway.x, s.z - doorway.z)).toBeGreaterThanOrEqual(1.6);
    expect(s.aim.z).toBeCloseTo(-2);
  });

  it('入口が見渡せる位置が無ければ null', () => {
    // 入口を完全に塞ぐ（開口を壁で埋める）
    const colliders = [...roomWalls(), box(-0.6, -2.1, 0.6, -1.9)];
    expect(findAmbushSpot({ colliders, room, doorway, from: { x: 2, z: -6 }, maxDist: 14 })).toBeNull();
  });
});

describe('Perception: pre-aim 状態の反応時間短縮', () => {
  function fakeSuspect(ambushReady: boolean) {
    const spotted: { x: number; z: number }[] = [];
    const s = {
      id: 'amb',
      state: SuspectState.ALERT,
      canPerceive: true,
      profile: { reactionTime: 0.7 },
      fatigueReactionAddSec: 0,
      // 部屋の奥 (0,-6) から入口方向 (-Z ではなく +Z) を向く: yawRad=π で前方 = (0, +1)
      body: { px: 0, pz: -6, footY: 0, yawRad: Math.PI },
      isAmbushReady: ambushReady,
      ambushCone: { coneDeg: 70, maxDist: 14 },
      ambushReactionSec: 0.16,
      onSpotted: (p: { x: number; z: number }) => spotted.push(p),
    };
    return { s, spotted };
  }

  function run(ambushReady: boolean, playerZ: number, sec: number) {
    const { s, spotted } = fakeSuspect(ambushReady);
    const bus = createGameEventBus();
    const player = {
      position: new THREE.Vector3(0, 0, playerZ),
      isCrouching: false,
      alive: true,
      getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, playerZ),
    };
    const perception = new Perception(perceptionCfg, () => [s as unknown as Suspect], [], player, bus);
    let t = 0;
    let firstSpotAt = -1;
    while (t < sec) {
      perception.update(0.02);
      t += 0.02;
      if (spotted.length > 0 && firstSpotAt < 0) firstSpotAt = t;
    }
    perception.dispose();
    return firstSpotAt;
  }

  it('待ち伏せ中は入室者を 0.16s 前後で撃ち始め、通常は reactionTime×alertMultiplier(0.42s) 掛かる', () => {
    const fast = run(true, -2.5, 2);
    const normal = run(false, -2.5, 2);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThanOrEqual(0.2);
    expect(normal).toBeGreaterThanOrEqual(0.4);
    expect(normal).toBeGreaterThan(fast * 2);
  });

  it('入室者がプレイヤーでなく隊員でも同様に短縮される（入口の先頭は隊員）', () => {
    const { s, spotted } = fakeSuspect(true);
    const bus = createGameEventBus();
    const player = {
      position: new THREE.Vector3(0, 0, 30),
      isCrouching: false,
      alive: false,
      getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, 30),
    };
    const perception = new Perception(perceptionCfg, () => [s as unknown as Suspect], [], player, bus);
    perception.attachAllies(() => [
      {
        id: 'ally_1',
        px: 0.3,
        pz: -2.6,
        footY: 0,
        height: 1.8,
        getEye: () => ({ x: 0.3, y: 1.6, z: -2.6 }),
        getChest: () => ({ x: 0.3, y: 1.2, z: -2.6 }),
        getAABB: () => ({ min: { x: 0, y: 0, z: -2.9 }, max: { x: 0.6, y: 1.8, z: -2.3 } }),
      },
    ]);
    let t = 0;
    while (t < 0.3 && spotted.length === 0) {
      perception.update(0.02);
      t += 0.02;
    }
    perception.dispose();
    expect(spotted).toHaveLength(1);
    expect(t).toBeLessThanOrEqual(0.2);
  });

  it('pre-aim 円錐の外（背後）では短縮されない', () => {
    // 容疑者は +Z を向いている。プレイヤーが奥側(-Z)の背後 (z=-12) にいると円錐外だが視野角で見えない → 不発
    expect(run(true, -12, 1.5)).toBe(-1);
  });
});

describe('Suspect: 待ち伏せ（ファタルファネル）', () => {
  afterEach(() => vi.restoreAllMocks());

  const base = profiles.find((p) => p.id === 'hardcore_leader')!;
  const roomDef: RoomDef = { id: 'target', name: 'Target', x: 0, z: -5, width: 6, depth: 6, floorY: 0 } as RoomDef;
  const doorLike = { id: 'd1', centerX: 0, centerZ: -2, normalX: 0, normalZ: 1, axisX: 1, axisZ: 0, sillY: 0, width: 1 };

  function make(ambox: Partial<AmbushParams> | null) {
    const profile: AIProfile = {
      ...base,
      aggression: 1,
      mobility: undefined,
      ambush: ambox === null ? undefined : { ...DEFAULT_AMBUSH, chance: 1, ...ambox },
    };
    const bus = createGameEventBus();
    const colliders = roomWalls();
    const player = {
      position: new THREE.Vector3(0, 0, 0),
      alive: true,
      isCrouching: false,
      getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, 0),
      getBodyBounds: () => ({ min: { x: -0.3, y: 0, z: -0.3 }, max: { x: 0.3, y: 1.7, z: 0.3 } }),
      takeDamage: () => 100,
    };
    const ctx = {
      player,
      colliders,
      rooms: [roomDef],
      doors: { doors: [doorLike] } as unknown as DoorSystem,
    };
    const s = new Suspect({ id: 'amb_1', type: 'suspect', x: 2, z: -6, yaw: 0 }, profile, bus, ctx);
    return { s, bus };
  }

  it('室外の扉音で、攻撃的な容疑者は待ち伏せ位置へ移動して照準を置く', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { s } = make({});
    s.onHeardNoise({ x: 0, y: 1, z: 0.5 }, 'door', 'player');
    expect(s.state).toBe(SuspectState.ALERT);
    expect(s.isAmbushing).toBe(true);
    for (let i = 0; i < 200 && !s.isAmbushReady; i++) s.update(0.05);
    expect(s.isAmbushReady).toBe(true);
    const spot = s.ambushTarget!;
    expect(Math.hypot(s.body.px - spot.x, s.body.pz - spot.z)).toBeLessThan(0.2);
    s.dispose();
  });

  it('待ち伏せ成立中に入室者を視認すると、CONFRONTATION を飛ばして即 ENGAGE', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { s } = make({});
    s.onHeardNoise({ x: 0, y: 1, z: 0.5 }, 'breach', 'player');
    for (let i = 0; i < 200 && !s.isAmbushReady; i++) s.update(0.05);
    s.onSpotted({ x: 0, y: 0, z: -2.5 });
    expect(s.state).toBe(SuspectState.ENGAGE);
    s.dispose();
  });

  it('待ち伏せでない容疑者の発見は従来どおり CONFRONTATION、警告にも従来どおり反応する', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { s } = make(null);
    s.onHeardNoise({ x: 0, y: 1, z: 0.5 }, 'door', 'player');
    expect(s.isAmbushing).toBe(false);
    s.onSpotted({ x: 0, y: 0, z: -2.5 });
    expect(s.state).toBe(SuspectState.CONFRONTATION);
    const { s: s2 } = make(null);
    s2.onHeardNoise({ x: 0, y: 1, z: 0.5 }, 'door', 'player');
    s2.onWarned({ x: 0, y: 0, z: 0 });
    expect(s2.state).not.toBe(SuspectState.ALERT);
    s.dispose();
    s2.dispose();
  });

  it('確率に外れる／すでに室内の物音／銃声では待ち伏せしない', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const { s } = make({ chance: 0.3 });
    s.onHeardNoise({ x: 0, y: 1, z: 0.5 }, 'door', 'player');
    expect(s.isAmbushing).toBe(false);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { s: s2 } = make({});
    s2.onHeardNoise({ x: 0, y: 1, z: -5 }, 'footstep', 'player'); // 室内
    expect(s2.isAmbushing).toBe(false);
    const { s: s3 } = make({});
    s3.onHeardNoise({ x: 0, y: 1, z: 0.5 }, 'gunshot', 'player');
    expect(s3.isAmbushing).toBe(false);
    s.dispose();
    s2.dispose();
    s3.dispose();
  });

  it('フラッシュバンで視界を失うと待ち伏せが崩れる', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { s } = make({});
    s.onHeardNoise({ x: 0, y: 1, z: 0.5 }, 'door', 'player');
    for (let i = 0; i < 200 && !s.isAmbushReady; i++) s.update(0.05);
    s.onFlashed(3);
    expect(s.isAmbushing).toBe(false);
    expect(s.isAmbushReady).toBe(false);
    s.dispose();
  });

  it('初弾バーストの拡散は firstBurstSpreadMul 倍に絞られる', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { s } = make({ firstBurstSpreadMul: 0.1, firstBurstShots: 3 });
    s.onHeardNoise({ x: 0, y: 1, z: 0.5 }, 'door', 'player');
    for (let i = 0; i < 200 && !s.isAmbushReady; i++) s.update(0.05);
    s.onSpotted({ x: 0, y: 0, z: -2.5 });
    expect(s.state).toBe(SuspectState.ENGAGE);
    expect(s.debugState).toContain('ENGAGE');
    s.dispose();
  });
});

describe('EngageBehavior: pre-aim 初弾バースト', () => {
  /** 10m 先のプレイヤーへ 3 発の初弾を撃ち、命中数を数える（拡散 8° の相手）。 */
  function hitsInFirstBurst(arm: boolean, spreadMul: number): number {
    const combat = { ...(profiles.find((p) => p.id === "hardcore_leader")!.combat as CombatParams), baseSpreadDeg: 8, fireInterval: 0.05, shotsPerPeek: 3, magazineSize: 30, engageRange: 25, shotDamage: 10 };
    const bus = createGameEventBus();
    const body = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'suspect' });
    let hits = 0;
    const player = {
      position: new THREE.Vector3(0, 0, -10),
      alive: true,
      getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, -10),
      getBodyBounds: () => ({ min: { x: -0.3, y: 0, z: -10.3 }, max: { x: 0.3, y: 1.7, z: -9.7 } }),
    };
    const ctx: CombatContext = {
      player,
      colliders: [],
      playerDamage: () => {
        hits++;
      },
    };
    const eb = new EngageBehavior(combat, 'amb', body, bus, ctx, () => true);
    const known = { x: 0, y: 0, z: -10 };
    const threat = { id: 'player', x: 0, z: -10, point: { x: 0, y: 1.3, z: -10 }, isPlayer: true };
    if (arm) eb.armPreAim(3, spreadMul);
    eb.enter(known);
    for (let i = 0; i < 40; i++) eb.update(0.05, known, true, threat);
    return hits;
  }

  it('armPreAim すると遮蔽に退かず即射撃し、初弾バーストは精度が上がる', () => {
    let tight = 0;
    let loose = 0;
    for (let i = 0; i < 40; i++) {
      tight += hitsInFirstBurst(true, 0.05);
      loose += hitsInFirstBurst(true, 1);
    }
    expect(tight).toBeGreaterThan(loose * 1.5);
    expect(tight).toBeGreaterThanOrEqual(100); // 3 発 × 40 試行のうちほぼ全弾
  });
});
