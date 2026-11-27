import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { checkResultLine } from '../../src/ai/radioLines';
import { executeOrder } from '../../src/ai/squad/squadOrders';
import { rollTrapSpot, tickCheck, tickDisarm } from '../../src/ai/squad/squadScout';
import type { AllyUnit, SquadContext } from '../../src/ai/squad/squadTypes';
import { validateSquad } from '../../src/core/DataLoader';
import { createGameEventBus } from '../../src/core/events';
import type { OrderContext } from '../../src/ui/CommandMenu';
import type { Door, DoorSystem } from '../../src/world/Door';
import { DoorTrapSystem } from '../../src/world/DoorTraps';

const cfg = validateSquad(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/squad.json'), 'utf-8')));

function mockDoor(over: Record<string, unknown> = {}): Door {
  return {
    id: 'd1',
    centerX: 0,
    centerZ: -2,
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
    command: () => true,
    ...over,
  } as unknown as Door;
}

function setup(opts: { trapped?: boolean; locked?: boolean; rand?: number; flashes?: number; gas?: number } = {}) {
  const door = mockDoor({ locked: opts.locked ?? false });
  const bus = createGameEventBus();
  const detonations: string[] = [];
  bus.on('doorTrapDetonated', (e) => detonations.push(e.doorId));
  const traps = new DoorTrapSystem({
    doors: { doors: [door], getDoor: () => door } as unknown as DoorSystem,
    bus,
    colliders: [],
    cfg: cfg.doorTrap,
    swatPositions: () => [],
    suspectPositions: () => [],
    victims: () => [],
  });
  if (opts.trapped) traps.place(door);
  const radio: string[] = [];
  const ally = {
    id: 'ally_1',
    door,
    entryPortal: { door },
    checkLeft: 0,
    checkStarted: false,
    disarmLeft: 0,
    disarmStarted: false,
    progress: '',
    down: false,
    body: { setPose: vi.fn(), aimAt: vi.fn() },
  } as unknown as AllyUnit;
  const ctx = {
    cfg,
    traps,
    doorChecks: new Map(),
    trapSpotRolled: new Set<string>(),
    rand: () => opts.rand ?? 0,
    simTime: 3,
    ack: '',
    ackLeft: 0,
    flashesLeft: opts.flashes ?? 4,
    gasLeft: opts.gas ?? 3,
    allies: [ally],
    player: { position: new THREE.Vector3(0, 0, 0) },
    rooms: [],
    emitRadio: (_a: AllyUnit, ja: string) => radio.push(ja),
  } as unknown as SquadContext;
  return { ctx, ally, door, traps, radio, detonations };
}

function runTick(fn: (dt: number) => boolean, dt = 0.1, max = 400): number {
  let n = 0;
  while (n < max && fn(dt)) n++;
  return n * dt;
}

describe('ドアチェック（Z #2）: ドア際で 1.5〜2 秒しゃがんで施錠とトラップを確認', () => {
  it('所要時間 doorCheck.durationSec（1.5〜2 秒）・しゃがむ・結果を記録して報告する（床下カメラは使わない）', () => {
    const { ctx, ally, door } = setup({ trapped: false, locked: true });
    ally.checkLeft = cfg.doorCheck.durationSec;
    const sec = runTick((dt) => tickCheck(ctx, ally, dt));
    expect(sec).toBeGreaterThanOrEqual(1.5 - 0.15);
    expect(sec).toBeLessThanOrEqual(2 + 0.15);
    expect(ally.body.setPose).toHaveBeenCalledWith('crouch');
    expect(ctx.doorChecks.get(door.id)).toMatchObject({ locked: true, trapFound: false });
    expect(ctx.ack).toContain('施錠');
    expect(ctx.ack).toContain('トラップ無し');
    expect(ctx.ackLeft).toBeGreaterThan(0);
    // 先頭の確認は「ドアの下のカメラ」ではなくドア際（床から 0.95m 付近）に視線を置く
    const aims = (ally.body.aimAt as ReturnType<typeof vi.fn>).mock.calls;
    expect(aims.every((c) => (c[1] as number) > 0.5)).toBe(true);
  });

  it('トラップがあれば発見（detectChance 内）して報告し、発見済みとして記録する', () => {
    const { ctx, ally, door, traps, radio } = setup({ trapped: true, rand: 0.1 });
    ally.checkLeft = cfg.doorCheck.durationSec;
    runTick((dt) => tickCheck(ctx, ally, dt));
    expect(traps.isDiscovered(door.id)).toBe(true);
    expect(ctx.doorChecks.get(door.id)).toMatchObject({ trapFound: true, locked: false });
    expect(ctx.ack).toContain('トラップ有り');
    expect(radio.some((l) => l.includes('トラップ有り') && l.includes('未施錠'))).toBe(true);
  });

  it('detectChance を外れると見落とす（トラップ無しと報告される）', () => {
    const { ctx, ally, door, traps } = setup({ trapped: true, rand: 0.99 });
    ally.checkLeft = cfg.doorCheck.durationSec;
    runTick((dt) => tickCheck(ctx, ally, dt));
    expect(traps.isRigged(door.id)).toBe(true);
    expect(traps.isDiscovered(door.id)).toBe(false);
    expect(ctx.doorChecks.get(door.id)?.trapFound).toBe(false);
  });

  it('報告文: 施錠/未施錠 × トラップ有り/無し', () => {
    expect(checkResultLine(true, true)[0]).toMatch(/施錠.*トラップ有り/);
    expect(checkResultLine(false, false)[0]).toMatch(/未施錠.*トラップ無し/);
  });
});

describe('トラップ解除: 数秒かかり、小さな失敗確率で起爆する', () => {
  it('成功: disarmSec 秒後にトラップが消え、起爆しない', () => {
    const { ctx, ally, door, traps, detonations } = setup({ trapped: true, rand: 0.99 });
    traps.discover(door.id);
    ally.disarmLeft = cfg.doorTrap.disarmSec;
    const sec = runTick((dt) => tickDisarm(ctx, ally, dt));
    expect(sec).toBeGreaterThanOrEqual(cfg.doorTrap.disarmSec - 0.2);
    expect(traps.isRigged(door.id)).toBe(false);
    expect(detonations).toEqual([]);
    expect(traps.disarmed).toBe(1);
    expect(ctx.ack).toContain('解除');
  });

  it('失敗（failChance 内の乱数）: 起爆する', () => {
    const { ctx, ally, door, traps, detonations } = setup({ trapped: true, rand: 0 });
    traps.discover(door.id);
    ally.disarmLeft = cfg.doorTrap.disarmSec;
    runTick((dt) => tickDisarm(ctx, ally, dt));
    expect(detonations).toEqual([door.id]);
    expect(traps.isRigged(door.id)).toBe(false);
  });

  it('トラップが無ければ何もしない', () => {
    const { ctx, ally } = setup({ trapped: false });
    ally.disarmLeft = 3;
    expect(tickDisarm(ctx, ally, 0.1)).toBe(false);
    expect(ally.disarmLeft).toBe(0);
  });
});

describe('チェックなしで開けようとしたとき: 先頭が気付くことがある（1 ドア 1 回判定）', () => {
  it('spotChance 内なら発見して無線で知らせる / 外れたら見落とし、再判定しない', () => {
    const hit = setup({ trapped: true, rand: 0.1 });
    expect(rollTrapSpot(hit.ctx, hit.ally, hit.door)).toBe(true);
    expect(hit.traps.isDiscovered(hit.door.id)).toBe(true);
    expect(hit.radio.length).toBe(1);
    const miss = setup({ trapped: true, rand: 0.9 });
    expect(rollTrapSpot(miss.ctx, miss.ally, miss.door)).toBe(false);
    expect(miss.traps.isDiscovered(miss.door.id)).toBe(false);
    expect(rollTrapSpot(miss.ctx, miss.ally, miss.door)).toBe(false); // 再判定しない
    const none = setup({ trapped: false, rand: 0 });
    expect(rollTrapSpot(none.ctx, none.ally, none.door)).toBe(false);
  });
});

describe('閃光弾・CS ガスの携行数は有限（squad.json の inventory）', () => {
  const orderCtx = (door: Door): OrderContext => ({
    element: 'gold',
    door,
    areaTarget: null,
    groundPoint: null,
    restrainTarget: null,
    aimDir: { x: 0, z: -1 },
  });

  it('在庫 0 の flashClear / gasClear は発令されない（何も変わらず、理由を表示）', () => {
    const s = setup({ flashes: 0, gas: 0 });
    executeOrder(s.ctx, 'flashClear', orderCtx(s.door));
    expect(s.ctx.ack).toContain('閃光弾');
    s.ctx.ack = '';
    executeOrder(s.ctx, 'gasClear', orderCtx(s.door));
    expect(s.ctx.ack).toContain('ガス');
    expect(s.ctx.flashesLeft).toBe(0);
    expect(s.ctx.gasLeft).toBe(0);
  });

  it('未チェックの閉じたドアへの stack 指示は check に置き換わる（スタック＋ドアチェック）', () => {
    const s = setup({ trapped: true });
    s.ctx.announcedStacks = new Set();
    s.ctx.announcedRooms = new Set();
    try {
      executeOrder(s.ctx, 'stack', orderCtx(s.door));
    } catch {
      /* モック文脈ではスタック配置の後段が未対応。ack で置換だけ確認する */
    }
    expect(s.ctx.ack).toContain('ドアチェック');
  });

  it('check/disarm はドアが必要。解除対象が無ければ発令されない', () => {
    const s = setup({ trapped: true });
    executeOrder(s.ctx, 'disarm', orderCtx(s.door));
    expect(s.ctx.ack).toBe('解除できる確認済みのトラップがありません');
    executeOrder(s.ctx, 'check', { ...orderCtx(s.door), door: null });
    expect(s.ctx.ack).toBe('ドアを見て実行します');
  });

  it('初期値は inventory（フラッシュ 4 / ガス 3）', () => {
    expect(cfg.inventory.flashbang).toBe(4);
    expect(cfg.inventory.gas).toBe(3);
  });
});
