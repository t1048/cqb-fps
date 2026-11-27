import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { validatePlayerConfig } from '../../src/core/DataLoader';
import { createGameEventBus } from '../../src/core/events';
import { InputManager } from '../../src/core/InputManager';
import type { MapData } from '../../src/core/types';
import { FreeLook, chooseWandViewMode, type WandDoor } from '../../src/player/optiwandGeometry';
import { PlayerController } from '../../src/player/PlayerController';

const playerCfg = validatePlayerConfig(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/player.json'), 'utf-8')),
);
const DEG = Math.PI / 180;

type Handler = (e: unknown) => void;

/** node 環境用の最小 window / document スタブ。発火したイベントを手動で配送する。 */
function stubDom() {
  const handlers = new Map<string, Handler[]>();
  const element = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestPointerLock: vi.fn(),
  };
  const doc = { pointerLockElement: element as unknown, addEventListener: vi.fn(), removeEventListener: vi.fn(), exitPointerLock: vi.fn() };
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', doc);
  const fire = (type: string, e: Record<string, unknown>) => {
    const ev = { preventDefault: vi.fn(), ...e };
    for (const fn of handlers.get(type) ?? []) fn(ev);
    return ev;
  };
  return { element, doc, fire };
}

describe('中クリック（ホイール押し込み）の入力', () => {
  let dom: ReturnType<typeof stubDom>;
  let input: InputManager;
  beforeEach(() => {
    dom = stubDom();
    input = new InputManager(dom.element as unknown as HTMLElement);
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('押した瞬間のフレームだけ wasMousePressed(1) が true になる', () => {
    expect(input.wasMousePressed(1)).toBe(false);
    dom.fire('mousedown', { button: 1 });
    expect(input.wasMousePressed(1)).toBe(true);
    expect(input.isMouseDown(1)).toBe(true);
    input.endFrame();
    expect(input.wasMousePressed(1)).toBe(false);
    expect(input.isMouseDown(1)).toBe(true);
    dom.fire('mouseup', { button: 1 });
    expect(input.isMouseDown(1)).toBe(false);
  });

  it('左・右ボタンでは中クリック扱いにならない', () => {
    dom.fire('mousedown', { button: 0 });
    dom.fire('mouseup', { button: 0 });
    expect(input.wasMousePressed(1)).toBe(false);
  });

  it('ポインタロック中はブラウザのオートスクロールを抑止する（mousedown / auxclick）', () => {
    const down = dom.fire('mousedown', { button: 1 });
    expect(down.preventDefault).toHaveBeenCalled();
    const aux = dom.fire('auxclick', { button: 1 });
    expect(aux.preventDefault).toHaveBeenCalled();
    const auxLeft = dom.fire('auxclick', { button: 2 });
    expect(auxLeft.preventDefault).not.toHaveBeenCalled();
  });

  it('ポインタ非ロック中は中クリックを記録せず、既定動作も止めない', () => {
    dom.doc.pointerLockElement = null;
    const down = dom.fire('mousedown', { button: 1 });
    expect(down.preventDefault).not.toHaveBeenCalled();
    expect(input.wasMousePressed(1)).toBe(false);
  });

  it('ホイール回転（ドア段階開閉用）は中クリックと独立に蓄積される', () => {
    dom.fire('wheel', { deltaY: 100 });
    expect(input.wasMousePressed(1)).toBe(false);
    expect(input.consumeWheel()).toBe(100);
  });
});

describe('C しゃがみのトグル', () => {
  function makePlayer() {
    const pressed = new Set<string>();
    const input = {
      consumeMouseDelta: () => ({ x: 0, y: 0 }),
      isDown: () => false,
      wasPressed: (a: string) => pressed.has(a),
    };
    const map = { playerSpawn: { x: 0, y: 0, z: 0, yaw: 0 } } as unknown as MapData;
    const p = new PlayerController(
      new THREE.PerspectiveCamera(),
      input as never,
      [],
      playerCfg,
      createGameEventBus(),
      map,
    );
    const tap = () => {
      pressed.add('crouch');
      p.update(0.016);
      pressed.delete('crouch');
      p.update(0.016); // 離している間は姿勢が保たれる
    };
    return { p, tap };
  }

  it('1 回押すとしゃがみ、もう 1 回で立ち（押し続けは不要）', () => {
    const { p, tap } = makePlayer();
    expect(p.isCrouching).toBe(false);
    tap();
    expect(p.isCrouching).toBe(true);
    expect(p.moveMode).toBe('crouch');
    tap();
    expect(p.isCrouching).toBe(false);
    expect(p.moveMode).toBe('run');
  });

  it('stanceLocked 中（ワンド展開中）は切り替わらない', () => {
    const { p, tap } = makePlayer();
    tap();
    p.stanceLocked = true;
    tap();
    expect(p.isCrouching).toBe(true);
    p.stanceLocked = false;
    tap();
    expect(p.isCrouching).toBe(false);
  });
});

describe('オプティワンド左クリック長押しの視点モード', () => {
  const cfg = playerCfg.optiwand;
  const door: WandDoor = {
    id: 'd',
    centerX: 0,
    centerZ: -1,
    normalX: 0,
    normalZ: 1,
    axisX: 1,
    axisZ: 0,
    width: 0.9,
    sillY: 0,
    angle: 0,
    peekAngle: 20,
  };
  const eye = { x: 0, z: 0 };

  it('しゃがみ + ドアの前だけドア下カメラ', () => {
    expect(chooseWandViewMode(true, door, eye, cfg)).toBe('door');
  });
  it('立っていればドアの前でも前方カメラ', () => {
    expect(chooseWandViewMode(false, door, eye, cfg)).toBe('free');
  });
  it('ドアを狙っていない・遠い・全開のドアは前方カメラ', () => {
    expect(chooseWandViewMode(true, null, eye, cfg)).toBe('free');
    expect(chooseWandViewMode(true, door, { x: 0, z: 6 }, cfg)).toBe('free');
    expect(chooseWandViewMode(true, { ...door, angle: 90 }, eye, cfg)).toBe('free');
  });

  it('FreeLook: 開始時の向きを基準に首振りし、範囲でクランプされる', () => {
    const look = new FreeLook(80 * DEG, -60 * DEG, 60 * DEG);
    look.start(1.2, 0.1);
    expect(look.yaw).toBeCloseTo(1.2);
    expect(look.pitch).toBeCloseTo(0.1);
    look.pan(0.2, 0); // 右へ振ると yaw は減る（プレイヤーの視点と同じ符号）
    expect(look.yaw).toBeCloseTo(1.0);
    look.pan(10, 10);
    expect(look.yaw).toBeCloseTo(1.2 - 80 * DEG);
    expect(look.pitch).toBeCloseTo(-60 * DEG);
    look.pan(-100, -100);
    expect(look.yaw).toBeCloseTo(1.2 + 80 * DEG);
    expect(look.pitch).toBeCloseTo(60 * DEG);
    look.start(0, 0); // 再展開で首振りはリセット
    expect(look.yaw).toBe(0);
    expect(look.pitch).toBe(0);
  });
});
