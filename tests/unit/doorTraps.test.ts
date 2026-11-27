import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGameEventBus } from '../../src/core/events';
import { validateSquad } from '../../src/core/DataLoader';
import type { DoorTrapConfig } from '../../src/core/types';
import type { Door, DoorSystem } from '../../src/world/Door';
import { DoorTrapSystem, applyTrapBlast, rigCount, type BlastVictim } from '../../src/world/DoorTraps';

const squadCfg = validateSquad(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/squad.json'), 'utf-8')));
const cfg: DoorTrapConfig = squadCfg.doorTrap;

function mockDoor(id: string, x: number, z: number, over: Record<string, unknown> = {}) {
  const door = {
    id,
    centerX: x,
    centerZ: z,
    sillY: 0,
    width: 1,
    normalX: 0,
    normalZ: 1,
    axisX: 1,
    axisZ: 0,
    angle: 0,
    targetAngle: 0,
    maxAngle: 90,
    locked: false,
    command: vi.fn(function (this: { angle: number; targetAngle: number }, deg: number) {
      this.targetAngle = deg;
      this.angle = deg;
      return true;
    }),
    ...over,
  };
  return door as unknown as Door & { command: ReturnType<typeof vi.fn> };
}

function makeSystem(doors: Door[], opts: { swat?: { x: number; z: number; footY: number }[]; suspects?: { x: number; z: number; footY: number }[]; victims?: BlastVictim[] } = {}) {
  const bus = createGameEventBus();
  const doorSys = { doors, getDoor: (id: string) => doors.find((d) => d.id === id) } as unknown as DoorSystem;
  const blasts: unknown[] = [];
  bus.on('doorTrapDetonated', (e) => blasts.push(e));
  const noises: unknown[] = [];
  bus.on('noise', (e) => noises.push(e));
  const sys = new DoorTrapSystem({
    doors: doorSys,
    bus,
    colliders: [],
    cfg,
    swatPositions: () => opts.swat ?? [],
    suspectPositions: () => opts.suspects ?? [],
    victims: () => opts.victims ?? [],
  });
  return { sys, blasts, noises, bus };
}

describe('squad.json: doorTrap 設定', () => {
  it('0〜2 個・チェックの確率などが data 駆動', () => {
    expect(cfg.maxCount).toBe(2);
    expect(cfg.disarmSec).toBeGreaterThanOrEqual(3);
    expect(cfg.failChance).toBeGreaterThan(0);
    expect(cfg.failChance).toBeLessThan(0.5);
    expect(squadCfg.doorCheck.detectChance).toBeGreaterThan(0.5);
  });
});

describe('rigCount: 交渉結果に応じた設置数', () => {
  it('0〜maxCount。交渉が荒れる（ベースライン高）と増える', () => {
    expect(rigCount(cfg, 0, () => 0.99)).toBe(0);
    expect(rigCount(cfg, 0, () => 0.1)).toBe(1);
    expect(rigCount(cfg, cfg.alertBonusAt, () => 0.99)).toBe(cfg.alertBonus);
    expect(rigCount(cfg, cfg.alertBonusAt, () => 0.1)).toBe(Math.min(cfg.maxCount, 1 + cfg.alertBonus));
    expect(rigCount(cfg, 100, () => 0.1)).toBeLessThanOrEqual(cfg.maxCount);
    // 乱数・ベースラインの全域で 0〜maxCount
    for (const b of [0, 20, 40, 60, 100]) for (const r of [0, 0.3, 0.6, 0.99]) {
      const n = rigCount(cfg, b, () => r);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(cfg.maxCount);
    }
  });
});

describe('DoorTrapSystem', () => {
  it('rig: 開始位置に近いドアには仕掛けない / 数を超えて仕掛けない', () => {
    const near = mockDoor('near', 1, 0);
    const far1 = mockDoor('far1', 20, 0);
    const far2 = mockDoor('far2', 0, 20);
    const { sys } = makeSystem([near, far1, far2]);
    const ids = sys.rig(5, { x: 0, y: 0, z: 0 }, () => 0);
    expect(ids.sort()).toEqual(['far1', 'far2']);
    expect(sys.isRigged('near')).toBe(false);
    expect(sys.count).toBe(2);
    sys.dispose();
  });

  it('SWAT 側が近くでトラップ付きドアを開けると起爆する（爆風・騒音・イベント・ドアが開く）', () => {
    const door = mockDoor('d1', 10, 0);
    const hurt: number[] = [];
    const victim: BlastVictim = { chest: () => ({ x: 11, y: 1.2, z: 0 }), hurt: (d) => hurt.push(d) };
    const farVictim: BlastVictim = { chest: () => ({ x: 30, y: 1.2, z: 0 }), hurt: (d) => hurt.push(-d) };
    const { sys, blasts, noises } = makeSystem([door], { swat: [{ x: 11, z: 0, footY: 0 }], victims: [victim, farVictim] });
    sys.place(door);
    sys.update(0.05); // まだ閉じている
    expect(blasts.length).toBe(0);
    door.angle = 30;
    door.targetAngle = 30;
    sys.update(0.05);
    expect(blasts.length).toBe(1);
    expect(sys.isRigged('d1')).toBe(false);
    expect(hurt.length).toBe(1);
    expect(hurt[0]).toBeGreaterThan(0);
    expect(hurt[0]).toBeLessThanOrEqual(cfg.blastDamage);
    expect(noises.some((n) => (n as { kind: string }).kind === 'breach')).toBe(true);
    expect(sys.detonated).toBe(1);
    sys.dispose();
  });

  it('SWAT 側が近くにいない / 容疑者が自分で開けた場合は起爆しない', () => {
    const door = mockDoor('d1', 10, 0, { angle: 30, targetAngle: 30 });
    const a = makeSystem([door], { swat: [{ x: 40, z: 0, footY: 0 }] });
    a.sys.place(door);
    a.sys.update(0.05);
    expect(a.blasts.length).toBe(0);
    const b = makeSystem([door], { swat: [{ x: 11, z: 0, footY: 0 }], suspects: [{ x: 10.5, z: 0, footY: 0 }] });
    b.sys.place(door);
    b.sys.update(0.05);
    expect(b.blasts.length).toBe(0);
    a.sys.dispose();
    b.sys.dispose();
  });

  it('閉じたまま起爆（解除失敗）するとドアが吹き飛んで開く', () => {
    const door = mockDoor('d1', 10, 0, { locked: true });
    const { sys, blasts } = makeSystem([door], { swat: [{ x: 11, z: 0, footY: 0 }] });
    sys.place(door);
    sys.detonate('d1');
    expect(blasts.length).toBe(1);
    expect(door.locked).toBe(false);
    expect(door.command).toHaveBeenCalled();
    sys.dispose();
  });

  it('発見 / 解除 / C2 破壊: 解除・破壊すると起爆しない', () => {
    const d1 = mockDoor('d1', 10, 0);
    const d2 = mockDoor('d2', 20, 0);
    const { sys, blasts } = makeSystem([d1, d2], { swat: [{ x: 11, z: 0, footY: 0 }, { x: 21, z: 0, footY: 0 }] });
    sys.place(d1);
    sys.place(d2);
    expect(sys.isDiscovered('d1')).toBe(false);
    expect(sys.discover('d1')).toBe(true);
    expect(sys.isDiscovered('d1')).toBe(true);
    expect(sys.discover('nope')).toBe(false);
    expect(sys.disarm('d1')).toBe(true);
    expect(sys.disarmed).toBe(1);
    expect(sys.destroy('d2')).toBe(true);
    d1.angle = 40;
    d1.targetAngle = 40;
    d2.angle = 40;
    d2.targetAngle = 40;
    sys.update(0.05);
    expect(blasts.length).toBe(0);
    expect(sys.count).toBe(0);
    sys.dispose();
  });
});

describe('applyTrapBlast: 距離減衰・遮蔽', () => {
  it('近いほど大きなダメージ。半径外は無傷', () => {
    const got = new Map<string, number>();
    const v = (id: string, x: number): BlastVictim => ({ chest: () => ({ x, y: 1, z: 0 }), hurt: (d) => got.set(id, d) });
    const n = applyTrapBlast([], { x: 0, y: 1, z: 0 }, 4, 80, [v('near', 0.5), v('mid', 2.5), v('out', 5)]);
    expect(n).toBe(2);
    expect(got.get('near')!).toBeGreaterThan(got.get('mid')!);
    expect(got.has('out')).toBe(false);
  });

  it('壁で遮られた相手には届かない', () => {
    const wall = { kind: 'wall', aabb: { min: { x: 1, y: 0, z: -2 }, max: { x: 1.2, y: 3, z: 2 } } } as never;
    let hit = false;
    applyTrapBlast([wall], { x: 0, y: 1, z: 0 }, 4, 80, [{ chest: () => ({ x: 2, y: 1, z: 0 }), hurt: () => (hit = true) }]);
    expect(hit).toBe(false);
  });
});
