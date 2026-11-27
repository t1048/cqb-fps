import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { PlayerDoorWork } from '../../src/player/PlayerDoorWork';
import type { InteractProvider } from '../../src/player/Interaction';

const CHECK = { durationSec: 1.7, detectChance: 0.9, spotChance: 0.35 };
const TRAP = { disarmSec: 5, failChance: 0.12 } as never;

function setup(opts: { rigged?: boolean; rolls?: number[] } = {}) {
  const el = () => ({ style: {} as Record<string, string>, append: vi.fn(), appendChild: vi.fn(), remove: vi.fn(), textContent: '' });
  (globalThis as { document?: unknown }).document = { createElement: vi.fn(el), body: { appendChild: vi.fn() } };
  const door = {
    id: 'd1', centerX: 0, centerZ: 0, sillY: 0, normalX: 0, normalZ: 1, angle: 0, targetAngle: 0, locked: false,
    toggle: vi.fn(), stepStage: vi.fn(), breachExplosive: vi.fn(() => true),
  };
  let provider!: InteractProvider<typeof door>;
  const state = { rigged: opts.rigged ?? true, discovered: false };
  const traps = {
    isRigged: () => state.rigged,
    isDiscovered: () => state.rigged && state.discovered,
    discover: vi.fn(() => (state.discovered = true)),
    disarm: vi.fn(() => (state.rigged = false)),
    detonate: vi.fn(() => (state.rigged = false)),
    destroy: vi.fn(() => (state.rigged = false)),
  };
  const subtitle = { show: vi.fn() };
  const keys = { c2: false, c2Pressed: false };
  const events: string[] = [];
  const rolls = [...(opts.rolls ?? [])];
  const entities = { applyC2Blast: vi.fn() };
  const work = new PlayerDoorWork({
    player: { alive: true, position: { x: 0, y: 0, z: 1.2 } } as never,
    input: {
      isPointerLocked: true,
      isDown: (a: string) => a === 'c2' && keys.c2,
      wasPressed: (a: string) => {
        if (a === 'c2' && keys.c2Pressed) {
          keys.c2Pressed = false;
          return true;
        }
        return false;
      },
    } as never,
    interaction: { register: (p: InteractProvider<typeof door>) => ((provider = p), () => undefined) } as never,
    doors: { aimed: () => door } as never,
    traps: traps as never,
    entities: entities as never,
    bus: { emit: (n: string) => events.push(n) } as never,
    subtitle: subtitle as never,
    root: new THREE.Group(),
    check: CHECK,
    trap: TRAP,
    rand: () => rolls.shift() ?? 0.5,
  });
  const hold = (sec: number) => {
    provider.onPress?.(door);
    provider.onHold?.(door, 0.05, sec);
    provider.onRelease?.(door, sec);
  };
  return { work, door, traps, subtitle, keys, events, entities, provider: () => provider, hold };
}

describe('PlayerDoorWork（プレイヤー自身のドアチェック・罠解除・C2）', () => {
  let prevDoc: unknown;
  beforeEach(() => {
    prevDoc = (globalThis as { document?: unknown }).document;
  });
  afterEach(() => {
    (globalThis as { document?: unknown }).document = prevDoc;
  });

  it('F タップは通常の開閉、長押しは開閉しない', () => {
    const s = setup();
    s.hold(0.1);
    expect(s.door.toggle).toHaveBeenCalledTimes(1);
    s.hold(0.5);
    expect(s.door.toggle).toHaveBeenCalledTimes(1);
  });

  it('F 長押しでドアチェックを完了すると、確率で罠を発見する（見落としもある）', () => {
    const hit = setup({ rolls: [0.1] });
    hit.hold(0.25 + CHECK.durationSec + 0.01);
    expect(hit.traps.discover).toHaveBeenCalledWith('d1');
    const miss = setup({ rolls: [0.95] });
    miss.hold(0.25 + CHECK.durationSec + 0.01);
    expect(miss.traps.discover).not.toHaveBeenCalled();
  });

  it('発見済みの罠は F 長押しで解除でき、失敗すると起爆する', () => {
    const ok = setup({ rolls: [0.9] });
    ok.traps.discover();
    ok.hold(0.25 + 5 + 0.01);
    expect(ok.traps.disarm).toHaveBeenCalledWith('d1');
    const bad = setup({ rolls: [0.01] });
    bad.traps.discover();
    bad.hold(0.25 + 5 + 0.01);
    expect(bad.traps.detonate).toHaveBeenCalledWith('d1');
  });

  it('罠の解除を途中で離しても何も起きない', () => {
    const s = setup();
    s.traps.discover();
    s.hold(0.25 + 2);
    expect(s.traps.disarm).not.toHaveBeenCalled();
    expect(s.traps.detonate).not.toHaveBeenCalled();
  });

  it('B で C2 を設置すると信管のあと起爆し、罠ごとドアを吹き飛ばす（個数無制限）', () => {
    const s = setup();
    for (let n = 0; n < 2; n++) {
      s.door.breachExplosive.mockClear();
      s.keys.c2 = true;
      s.keys.c2Pressed = true;
      for (let i = 0; i < 20; i++) s.work.update(0.05); // 設置 0.8s
      s.keys.c2 = false;
      for (let i = 0; i < 60; i++) s.work.update(0.05); // 信管 1.8s
      expect(s.door.breachExplosive).toHaveBeenCalledTimes(1);
      expect(s.traps.destroy).toHaveBeenCalledWith('d1');
      expect(s.entities.applyC2Blast).toHaveBeenCalledTimes(n + 1);
    }
    expect(s.events).toContain('c2Detonated');
    expect(s.events).toContain('c2Beep');
  });

  it('設置の途中で B を離すと中断される', () => {
    const s = setup();
    s.keys.c2 = true;
    s.keys.c2Pressed = true;
    for (let i = 0; i < 6; i++) s.work.update(0.05);
    s.keys.c2 = false;
    for (let i = 0; i < 100; i++) s.work.update(0.05);
    expect(s.door.breachExplosive).not.toHaveBeenCalled();
  });
});
