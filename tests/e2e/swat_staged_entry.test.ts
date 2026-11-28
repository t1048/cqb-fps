import { afterEach, describe, expect, it } from 'vitest';
import type { EntityDef } from '../../src/core/types';
import {
  createSquadHarness,
  defaultAllies,
  makeSingleRoomMap,
  type SquadHarness,
} from './helpers/squadSimDriver';

/**
 * SWAT モードの段階的な Z: スタック → チェック → オープン&クリア。
 * ドアのブービートラップ・ガス待機・在庫の消費を実際の SquadSystem で通す。
 */
const active: SquadHarness[] = [];
afterEach(() => {
  while (active.length > 0) active.pop()!.dispose();
});
function track(h: SquadHarness): SquadHarness {
  active.push(h);
  return h;
}

function makeSuspect(id: string, x: number, z: number): EntityDef {
  return { id, type: 'suspect', x, z, y: 0, yaw: 0, profile: 'hardcore_leader', hp: 100 };
}

function setup(opts: { trapped?: boolean; entities?: EntityDef[]; locked?: boolean } = {}) {
  const map = makeSingleRoomMap({ lockedDoor: opts.locked ?? false, includeCover: false });
  const h = track(
    createSquadHarness({
      map,
      allies: defaultAllies(2, { x: 0, y: 0, z: 6.5 }),
      entities: opts.entities ?? [],
      playerPos: { x: 0, y: 0, z: 8.5 },
      trapDoorIds: opts.trapped ? ['door_south'] : [],
    }),
  );
  const door = h.doors.findById('door_south')!;
  const aim = (): void => {
    h.doors.setAimedDoor(door);
    h.player.aimAt({ x: door.centerX, y: door.sillY + 1.1, z: door.centerZ });
  };
  const pressZ = (): void => {
    aim();
    h.input.pressAction('quickOrder');
    h.step(0.1);
  };
  return { h, door, aim, pressZ };
}

describe('Z の段階（実機）', () => {
  // 閉じた未チェックのドアへのスタックは、そのままドアチェック（罠・施錠）も行う（ddabde7）。
  // そのため Z は「Z#1 スタック＆チェック → Z#2 （罠があれば解除してから）オープン&クリア」の 2 段階。
  it('Z#1 スタック＆チェック（突入しない・トラップを発見して報告）→ Z#2 解除してオープン&クリア（起爆しない）', () => {
    const { h, door, aim, pressZ } = setup({ trapped: true });
    h.squad.rand = () => 0; // チェックは必ず発見
    let blasts = 0;
    h.bus.on('doorTrapDetonated', () => blasts++);

    aim();
    expect(h.squad.quickOrderHint(1)).toContain('スタック＆ドアチェック');

    // Z#1: スタック＆チェック。まだドアは開けない
    pressZ();
    for (const a of h.squad.allies) expect(a.order).toBe('stack');
    h.step(1);
    expect(door.angle).toBe(0);
    h.step(9);
    const res = h.squad.doorChecks.get(door.id);
    expect(res).toBeDefined();
    expect(res!.trapFound).toBe(true);
    expect(res!.locked).toBe(false);
    expect(h.traps!.isDiscovered(door.id)).toBe(true);
    for (const a of h.squad.allies) expect(a.checkLeft).toBe(0);
    expect(door.angle).toBe(0);
    expect(h.squad.quickOrderHint(1)).toContain('オープン&クリア');
    expect(h.squad.quickOrderHint(1)).toContain('罠発見');

    // Z#2: オープン&クリア。確認済みのトラップを先に解除してから開ける（解除は数秒かかる）
    h.squad.rand = () => 0.99; // 解除は成功
    pressZ();
    h.step(2);
    expect(door.angle).toBeLessThan(5); // 解除作業中はまだ開けない
    expect(h.traps!.isRigged(door.id)).toBe(true);
    h.step(10);
    expect(h.traps!.isRigged(door.id)).toBe(false);
    expect(h.traps!.disarmed).toBe(1);
    expect(blasts).toBe(0);
    expect(door.angle).toBeGreaterThan(30);
  });

  it('チェックを飛ばして（メニューから直接）開けると、気付かなければ未発見のトラップが起爆する', () => {
    const { h, door, aim } = setup({ trapped: true });
    h.squad.rand = () => 0.99; // 気付き判定に失敗
    let blasts = 0;
    h.bus.on('doorTrapDetonated', () => blasts++);
    aim();
    expect(h.issueOrder('clear', { door })).toBe(true);
    h.step(14);
    expect(blasts).toBe(1);
    expect(h.traps!.isRigged(door.id)).toBe(false);
    expect(h.traps!.detonated).toBe(1);
  });

  it('チェックなしでも先頭が気付くことがある（spotChance）。気付けば解除してから開ける', () => {
    const { h, door, aim } = setup({ trapped: true });
    h.squad.rand = () => 0.1; // 気付く → 解除の失敗判定 0.1 < failChance(0.12) は起爆するので、解除用に後で切り替える
    let blasts = 0;
    h.bus.on('doorTrapDetonated', () => blasts++);
    aim();
    h.issueOrder('clear', { door });
    h.step(1.5);
    expect(h.traps!.isDiscovered(door.id)).toBe(true);
    h.squad.rand = () => 0.99;
    h.step(14);
    expect(blasts).toBe(0);
    expect(h.traps!.disarmed).toBe(1);
  });

  it('トラップなしのドアでも Z の段階は同じ。スタック時のチェックは「トラップ無し」を報告する', () => {
    const { h, door, pressZ } = setup({ trapped: false, locked: true });
    pressZ();
    h.step(10);
    expect(door.angle).toBe(0);
    expect(h.squad.doorChecks.get(door.id)).toMatchObject({ trapFound: false, locked: true });
    expect(h.squad.quickOrderHint(1)).toContain('強行突入');
  });
});

describe('ガス突入 / 閃光の在庫（実機）', () => {
  it('ガス突入: 投入後 gasWaitSec（約 4.5 秒）待ってから入る。ガスを 1 つ消費する', () => {
    const { h, door, aim } = setup();
    expect(h.squad.gasLeft).toBe(3);
    aim();
    h.issueOrder('gasClear', { door });
    let waitStart = -1;
    let t = 0;
    for (; t < 30; t += 0.05) {
      h.step(0.05);
      if (waitStart < 0 && h.squad.allies.some((a) => a.phase === 'gas_wait')) waitStart = t;
      if (waitStart >= 0 && !h.squad.allies.some((a) => a.phase === 'gas_wait')) break;
    }
    expect(waitStart).toBeGreaterThanOrEqual(0);
    const waited = t - waitStart;
    expect(waited).toBeGreaterThanOrEqual(h.squad.cfg.gasWaitSec - 0.3);
    expect(waited).toBeLessThanOrEqual(h.squad.cfg.gasWaitSec + 0.6);
    expect(h.squad.gasLeft).toBe(2);
  });

  it('在庫が尽きた閃光/ガスは発令できない（在庫も変わらない）', () => {
    const { h, door, aim } = setup();
    h.squad.flashesLeft = 0;
    h.squad.gasLeft = 0;
    aim();
    h.issueOrder('flashClear', { door });
    h.issueOrder('gasClear', { door });
    h.step(3);
    for (const a of h.squad.allies) expect(['flashClear', 'gasClear']).not.toContain(a.order);
    expect(h.squad.flashesLeft).toBe(0);
    expect(h.squad.gasLeft).toBe(0);
  });

  it('分隊の閃光弾は補充されない（時間が経っても増えない）', () => {
    const { h } = setup();
    expect(h.squad.flashesLeft).toBe(4);
    h.squad.flashesLeft = 1;
    h.step(120, 0.1);
    expect(h.squad.flashesLeft).toBe(1);
  });
});

describe('民間人へのガス', () => {
  it('ガスを浴びた民間人は行動不能になり、RoE の減点（civilianGassed -10）が付く。容疑者だけの部屋では付かない', () => {
    const civ: EntityDef = { id: 'c1', type: 'civilian', x: 0.3, z: 0, y: 0, yaw: 0, profile: 'frightened_civilian' };
    const { h } = setup({ entities: [civ, makeSuspect('s1', -2.5, -2)] });
    h.tearGas.throwFrom({ x: 0.3, y: 0.4, z: 0.2 }, { x: 0, y: 0, z: 0 }, 'ally_1', 0.4);
    h.step(10);
    const c = h.entities.civilians.get('c1')!;
    expect(c.gassed).toBe(true);
    expect(c.alive).toBe(true);
    const viol = h.recorder.of('roeViolation').filter((e) => (e.payload as { kind: string }).kind === 'civilianGassed');
    expect(viol.length).toBe(1);
    expect((viol[0]!.payload as { points: number }).points).toBe(-10);
  });

  it('民間人がいなければガスで減点されない', () => {
    const { h } = setup({ entities: [makeSuspect('s1', 0, 0)] });
    h.tearGas.throwFrom({ x: 0.3, y: 0.4, z: 0.2 }, { x: 0, y: 0, z: 0 }, 'ally_1', 0.4);
    h.step(10);
    expect(h.recorder.of('roeViolation').filter((e) => (e.payload as { kind: string }).kind === 'civilianGassed').length).toBe(0);
  });
});
