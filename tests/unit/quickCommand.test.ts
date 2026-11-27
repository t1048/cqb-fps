import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ScoutIntel } from '../../src/ai/ScoutIntel';
import { pickQuickOrder, quickOrderInfo } from '../../src/ai/squad/squadOrders';
import type { AllyUnit, SquadContext } from '../../src/ai/squad/squadTypes';
import { validateSquad } from '../../src/core/DataLoader';
import type { RoomDef } from '../../src/core/types';
import type { OrderContext } from '../../src/ui/CommandMenu';
import type { Door } from '../../src/world/Door';

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

function makeAlly(door: Door | null, stacked: boolean): AllyUnit {
  return {
    id: 'ally_1',
    down: false,
    elementKey: 'alpha',
    order: stacked ? 'stack' : 'follow',
    door: stacked ? door : null,
    stackPos: stacked ? { x: 0.6, z: -1.3 } : null,
    body: { px: 0.6, pz: -1.3 },
  } as unknown as AllyUnit;
}

function makeCtx(opts: { stacked?: boolean; door?: Door; flashes?: number; gas?: number; intel?: ScoutIntel }) {
  const door = opts.door ?? makeDoor();
  const intel = opts.intel ?? new ScoutIntel();
  const ctx = {
    cfg,
    rooms,
    colliders: [],
    intel,
    flashesLeft: opts.flashes ?? 2,
    gasLeft: opts.gas ?? 1,
    allies: [makeAlly(door, opts.stacked ?? false)],
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

describe('Z クイック指示: 偵察状況による分岐', () => {
  it('未確認のドア: 1 回の Z でミラー確認（→自動突入）。整列済みかどうかに依らない', () => {
    for (const stacked of [false, true]) {
      const { ctx, orderCtx } = makeCtx({ stacked });
      const info = quickOrderInfo(ctx, orderCtx);
      expect(info.order).toBe('mirror');
      expect(info.mirrorFirst).toBe(true);
      expect(info.scouted).toBe(false);
      expect(pickQuickOrder(ctx, orderCtx)).toBe('mirror');
    }
  });

  it('ミラー確認中にもう一度 Z: 確認を打ち切って素の clear（施錠なら breachClear）', () => {
    const a = makeCtx({ stacked: true });
    (a.ctx.allies[0] as unknown as { mirrorLeft: number }).mirrorLeft = 2;
    const info = quickOrderInfo(a.ctx, a.orderCtx);
    expect(info).toMatchObject({ order: 'clear', mirroring: true, mirrorFirst: false });
    const locked = makeDoor({ locked: true });
    const l = makeCtx({ stacked: true, door: locked });
    (l.ctx.allies[0] as unknown as { mirrorLeft: number }).mirrorLeft = 2;
    expect(quickOrderInfo(l.ctx, { ...l.orderCtx, door: locked }).order).toBe('breachClear');
  });

  it('確認済み・既知の脅威あり: 即座に（ミラーなしで）閃光クリア（閃光切れならガス、両方切れなら clear）', () => {
    const intel = new ScoutIntel();
    intel.reportContact('target', { id: 's1', kind: 'suspect', armed: true, x: 1, y: 0, z: -6, time: 0 });
    const a = makeCtx({ intel, flashes: 2 });
    const info = quickOrderInfo(a.ctx, a.orderCtx);
    expect(info.order).toBe('flashClear');
    expect(info.scouted).toBe(true);
    expect(info.threats).toBe(1);
    expect(info.mirrorFirst).toBe(false);
    expect(quickOrderInfo(makeCtx({ intel, flashes: 0, gas: 1 }).ctx, a.orderCtx).order).toBe('gasClear');
    expect(quickOrderInfo(makeCtx({ intel, flashes: 0, gas: 0 }).ctx, a.orderCtx).order).toBe('clear');
  });

  it('確認済み・空の部屋: 静かな clear（閃光を使わない）', () => {
    const intel = new ScoutIntel();
    intel.markScouted('target', 'ally');
    const a = makeCtx({ intel });
    expect(quickOrderInfo(a.ctx, a.orderCtx)).toMatchObject({ order: 'clear', scouted: true, threats: 0 });
    // 民間人だけの部屋でも閃光は使わない
    intel.reportContact('target', { id: 'c1', kind: 'civilian', armed: false, x: 1, y: 0, z: -6, time: 0 });
    expect(quickOrderInfo(a.ctx, a.orderCtx).order).toBe('clear');
  });

  it('既知の脅威でも施錠ドアは breachClear（蹴破り）', () => {
    const intel = new ScoutIntel();
    intel.reportContact('target', { id: 's1', kind: 'suspect', armed: true, x: 1, y: 0, z: -6, time: 0 });
    const door = makeDoor({ locked: true });
    const a = makeCtx({ intel, door });
    expect(quickOrderInfo(a.ctx, { ...a.orderCtx, door }).order).toBe('breachClear');
  });

  it('全開のドアで視線が通っていれば（視覚的に確認済み）空の部屋として clear', () => {
    const door = makeDoor({ angle: 90 });
    const a = makeCtx({ door });
    const info = quickOrderInfo(a.ctx, { ...a.orderCtx, door });
    expect(info).toMatchObject({ order: 'clear', scouted: true, threats: 0 });
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
});
