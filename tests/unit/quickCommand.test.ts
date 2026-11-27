import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ScoutIntel } from '../../src/ai/ScoutIntel';
import { pickQuickOrder, quickOrderInfo, recommendEntry } from '../../src/ai/squad/squadOrders';
import type { AllyUnit, SquadContext } from '../../src/ai/squad/squadTypes';
import { validateSquad } from '../../src/core/DataLoader';
import type { RoomDef } from '../../src/core/types';
import type { OrderContext } from '../../src/ui/CommandMenu';
import type { Door } from '../../src/world/Door';
import type { DoorTrapSystem } from '../../src/world/DoorTraps';

const cfg = validateSquad(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/squad.json'), 'utf-8')));

const rooms: RoomDef[] = [
  { id: 'hall', name: 'Hall', x: 0, z: 0, width: 6, depth: 4, floorY: 0 } as RoomDef,
  { id: 'target', name: 'Target Room', x: 0, z: -5, width: 6, depth: 6, floorY: 0 } as RoomDef,
];

function makeDoor(over: Partial<{ locked: boolean; angle: number }> = {}): Door {
  return {
    id: 'door_1',
    centerX: 0,
    centerZ: -2,
    sillY: 0,
    normalX: 0,
    normalZ: 1,
    axisX: 1,
    axisZ: 0,
    width: 1,
    angle: 0,
    locked: false,
    ...over,
  } as unknown as Door;
}

function makeAlly(door: Door | null, stacked: boolean, extra: Record<string, unknown> = {}): AllyUnit {
  return {
    id: 'ally_1',
    down: false,
    elementKey: 'alpha',
    order: stacked ? 'stack' : 'follow',
    phase: stacked ? 'stacking' : 'follow',
    door: stacked ? door : null,
    entryPortal: null,
    stackPos: stacked ? { x: 0.6, z: -1.3 } : null,
    body: { px: 0.6, pz: -1.3 },
    checkLeft: 0,
    disarmLeft: 0,
    disarmStarted: false,
    ...extra,
  } as unknown as AllyUnit;
}

function makeCtx(opts: {
  stacked?: boolean;
  door?: Door;
  flashes?: number;
  gas?: number;
  intel?: ScoutIntel;
  allyExtra?: Record<string, unknown>;
  traps?: Partial<DoorTrapSystem>;
  checked?: boolean;
}) {
  const door = opts.door ?? makeDoor();
  const intel = opts.intel ?? new ScoutIntel();
  const doorChecks = new Map<string, { locked: boolean; trapFound: boolean; time: number }>();
  if (opts.checked) doorChecks.set(door.id, { locked: door.locked, trapFound: false, time: 0 });
  const ctx = {
    cfg,
    rooms,
    colliders: [],
    intel,
    traps: (opts.traps as DoorTrapSystem | undefined) ?? null,
    doorChecks,
    flashesLeft: opts.flashes ?? 2,
    gasLeft: opts.gas ?? 1,
    allies: [makeAlly(door, opts.stacked ?? false, opts.allyExtra)],
    player: {
      position: new THREE.Vector3(0, 0, 0),
      getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, 0),
    },
  } as unknown as SquadContext;
  const orderCtx: OrderContext = {
    element: 'gold',
    door,
    areaTarget: null,
    groundPoint: null,
    restrainTarget: null,
    aimDir: { x: 0, z: -1 },
  };
  return { ctx, orderCtx, door, intel };
}

describe('Z クイック指示: ドアの 3 段階（スタック → チェック → オープン&クリア）', () => {
  it('Z#1: 整列していないドアでは「スタック」（突入しない）。未確認でもミラーは自動で行わない', () => {
    const { ctx, orderCtx } = makeCtx({ stacked: false });
    const info = quickOrderInfo(ctx, orderCtx);
    expect(info.order).toBe('stack');
    expect(info.stage).toBe('stack');
    expect(info.scouted).toBe(false);
    expect(info.busy).toBeNull();
    expect(pickQuickOrder(ctx, orderCtx)).toBe('stack');
  });

  it('Z#2: スタック済み・未チェックなら「チェック」', () => {
    const { ctx, orderCtx } = makeCtx({ stacked: true });
    const info = quickOrderInfo(ctx, orderCtx);
    expect(info).toMatchObject({ order: 'check', stage: 'check', checked: false, busy: null });
  });

  it('Z#3: チェック済みなら素の「オープン&クリア」（閃光・ガスは自動で使わない）。施錠なら breachClear', () => {
    const a = makeCtx({ stacked: true, checked: true });
    expect(quickOrderInfo(a.ctx, a.orderCtx)).toMatchObject({ order: 'clear', stage: 'entry', checked: true });
    const locked = makeDoor({ locked: true });
    const l = makeCtx({ stacked: true, door: locked, checked: true });
    expect(quickOrderInfo(l.ctx, { ...l.orderCtx, door: locked })).toMatchObject({ order: 'breachClear', stage: 'entry' });
  });

  it('チェック中・解除中・突入中は busy（Z を押しても何も発令しない）', () => {
    const c = makeCtx({ stacked: true, allyExtra: { checkLeft: 1 } });
    expect(quickOrderInfo(c.ctx, c.orderCtx)).toMatchObject({ busy: 'check' });
    const d = makeCtx({ stacked: true, allyExtra: { disarmLeft: 2, disarmStarted: true } });
    expect(quickOrderInfo(d.ctx, d.orderCtx)).toMatchObject({ busy: 'disarm' });
    const e = makeCtx({ stacked: true, allyExtra: { order: 'clear', phase: 'entering' } });
    expect(quickOrderInfo(e.ctx, e.orderCtx)).toMatchObject({ busy: 'entry' });
  });

  it('発見済みのトラップは trapKnown になる（Z#3 で解除してから開ける）', () => {
    const a = makeCtx({ stacked: true, checked: true, traps: { isDiscovered: () => true, isRigged: () => true } });
    expect(quickOrderInfo(a.ctx, a.orderCtx)).toMatchObject({ order: 'clear', trapKnown: true });
  });

  it('すでに開いているドアは段階を飛ばして clear', () => {
    const door = makeDoor({ angle: 90 });
    const a = makeCtx({ door });
    expect(quickOrderInfo(a.ctx, { ...a.orderCtx, door })).toMatchObject({ order: 'clear', stage: 'entry' });
  });
});

describe('Z クイック指示: 偵察結果は「推奨」のヒントのみ（自動発令しない）', () => {
  it('容疑者のみ → 推奨はガス突入。それでも Z#3 の発令は素の clear', () => {
    const intel = new ScoutIntel();
    intel.reportContact('target', { id: 's1', kind: 'suspect', armed: true, x: 1, y: 0, z: -6, time: 0 });
    const a = makeCtx({ intel, stacked: true, checked: true, flashes: 4, gas: 3 });
    const info = quickOrderInfo(a.ctx, a.orderCtx);
    expect(info).toMatchObject({ scouted: true, threats: 1, civilians: 0, recommend: 'gasClear', order: 'clear' });
  });

  it('容疑者 + 民間人 → 推奨は閃光クリア', () => {
    const intel = new ScoutIntel();
    intel.reportContact('target', { id: 's1', kind: 'suspect', armed: true, x: 1, y: 0, z: -6, time: 0 });
    intel.reportContact('target', { id: 'c1', kind: 'civilian', armed: false, x: 2, y: 0, z: -6, time: 0 });
    const a = makeCtx({ intel, stacked: true, checked: true });
    expect(quickOrderInfo(a.ctx, a.orderCtx)).toMatchObject({ threats: 1, civilians: 1, recommend: 'flashClear', order: 'clear' });
    expect(recommendEntry(2, 1)).toBe('flashClear');
    expect(recommendEntry(2, 0)).toBe('gasClear');
  });

  it('確認済み・空の部屋 / 民間人だけ → 推奨はオープン&クリア', () => {
    const intel = new ScoutIntel();
    intel.markScouted('target', 'ally');
    const a = makeCtx({ intel, stacked: true, checked: true });
    expect(quickOrderInfo(a.ctx, a.orderCtx)).toMatchObject({ scouted: true, threats: 0, recommend: 'clear' });
    intel.reportContact('target', { id: 'c1', kind: 'civilian', armed: false, x: 1, y: 0, z: -6, time: 0 });
    expect(quickOrderInfo(a.ctx, a.orderCtx).recommend).toBe('clear');
  });

  it('未確認の部屋は推奨なし', () => {
    const a = makeCtx({ stacked: true });
    expect(quickOrderInfo(a.ctx, a.orderCtx).recommend).toBeNull();
  });

  it('全開のドアで視線が通っていれば（視覚的に確認済み）空の部屋として推奨 clear', () => {
    const door = makeDoor({ angle: 90 });
    const a = makeCtx({ door });
    expect(quickOrderInfo(a.ctx, { ...a.orderCtx, door })).toMatchObject({ order: 'clear', scouted: true, threats: 0, recommend: 'clear' });
  });

  it('全開でも壁で視線が通らなければ未確認のまま', () => {
    const door = makeDoor({ angle: 90 });
    const a = makeCtx({ door });
    const blocked = {
      ...a.ctx,
      colliders: [{ kind: 'wall', aabb: { min: { x: -3, y: 0, z: -3.1 }, max: { x: 3, y: 3, z: -2.9 } } }],
    } as unknown as SquadContext;
    expect(quickOrderInfo(blocked, { ...a.orderCtx, door }).scouted).toBe(false);
  });

  it('エリア対象は素の clear（既知の脅威があっても閃光・ガスを自動で選ばない）', () => {
    const intel = new ScoutIntel();
    intel.reportContact('target', { id: 's1', kind: 'suspect', armed: true, x: 1, y: 0, z: -6, time: 0 });
    const a = makeCtx({ intel });
    const area: OrderContext = {
      ...a.orderCtx,
      door: null,
      areaTarget: { room: rooms[1]!, door: null, entryX: 0, entryY: 0, entryZ: -2, intoX: 0, intoZ: -1, axisX: 1, axisZ: 0, width: 1 } as unknown as OrderContext['areaTarget'],
    };
    expect(quickOrderInfo(a.ctx, area)).toMatchObject({ order: 'clear', recommend: 'gasClear', stage: null });
  });

  it('ドア以外の対象は従来どおり（床=移動 / 何もなし=待機 / 拘束対象=確保）', () => {
    const a = makeCtx({});
    const none: OrderContext = { ...a.orderCtx, door: null };
    expect(quickOrderInfo(a.ctx, none).order).toBe('hold');
    expect(quickOrderInfo(a.ctx, { ...none, groundPoint: { x: 0, y: 0, z: 0, dist: 3, yawRad: 0 } }).order).toBe('move');
    expect(
      quickOrderInfo(a.ctx, { ...none, restrainTarget: { id: 's', kind: 'suspect', label: 'x', x: 0, y: 0, z: 0 } }).order,
    ).toBe('restrain');
  });
});

describe('squad.json: ミラー確認の定義', () => {
  it('orderLabels に mirror があり、mirror 設定が読める', () => {
    expect(cfg.orderLabels.mirror).toBe('ミラー確認');
    expect(cfg.mirror.durationSec).toBe(4);
    expect(cfg.mirror.missChance).toBeCloseTo(0.35);
  });

  it('inventory / doorCheck / doorTrap / gasWaitSec が読める', () => {
    expect(cfg.inventory).toEqual({ flashbang: 4, gas: 3 });
    expect(cfg.gasWaitSec).toBeCloseTo(4.5);
    expect(cfg.doorCheck.durationSec).toBeGreaterThanOrEqual(1.5);
    expect(cfg.doorCheck.durationSec).toBeLessThanOrEqual(2);
    expect(cfg.doorTrap.maxCount).toBe(2);
    expect(cfg.orderLabels.check).toBe('ドアチェック');
    expect(cfg.orderLabels.disarm).toBe('トラップ解除');
  });
});
