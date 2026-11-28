import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import * as SwatTeamModule from '../../src/modes/SwatTeam';
import { SwatTeam, type SwatTeamDeps } from '../../src/modes/SwatTeam';
import * as SuspectModeModule from '../../src/modes/SuspectMode';
import { SuspectMission, SUSPECT_MODE } from '../../src/modes/SuspectMode';
import { BriefingScreen } from '../../src/ui/BriefingScreen';
import { buildSeedShareUrl } from '../../src/ui/shareLinks';
import type { MapData, RoomDef } from '../../src/core/types';
import type { DoorSystem } from '../../src/world/Door';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { Flashbang } from '../../src/weapons/Flashbang';
import type { Subtitle } from '../../src/ui/Subtitle';
import type { PlayerController } from '../../src/player/PlayerController';
import type { EntityManager } from '../../src/ai/EntityManager';
import type { InputManager } from '../../src/core/InputManager';
import type { Interaction } from '../../src/player/Interaction';

interface FakeElement {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  type?: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  children: FakeElement[];
  listeners: Record<string, Array<(e?: unknown) => void>>;
  append: (...nodes: FakeElement[]) => void;
  prepend: (...nodes: FakeElement[]) => void;
  appendChild: (node: FakeElement) => FakeElement;
  remove: () => void;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  addEventListener: (ev: string, fn: (e?: unknown) => void) => void;
  removeEventListener: (ev: string, fn: (e?: unknown) => void) => void;
  focus: () => void;
  contains: (target: unknown) => boolean;
  getContext: () => null;
  click: () => void;
}

function makeFakeElement(tag: string): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    listeners: {},
    append(...nodes: FakeElement[]) {
      for (const n of nodes) el.children.push(n);
    },
    prepend(...nodes: FakeElement[]) {
      el.children.unshift(...nodes);
    },
    appendChild(node: FakeElement) {
      el.children.push(node);
      return node;
    },
    remove: vi.fn(),
    setAttribute(k: string, v: string) {
      el.attributes[k] = v;
    },
    getAttribute(k: string) {
      return el.attributes[k] ?? null;
    },
    addEventListener(ev: string, fn: (e?: unknown) => void) {
      (el.listeners[ev] ??= []).push(fn);
    },
    removeEventListener(ev: string, fn: (e?: unknown) => void) {
      const list = el.listeners[ev];
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    focus: vi.fn(),
    contains(target: unknown): boolean {
      if (target === el) return true;
      return el.children.some((c) => c.contains(target));
    },
    getContext: () => null,
    click() {
      for (const fn of [...(el.listeners['click'] ?? [])]) fn();
    },
  };
  return el;
}

function findInTree(root: FakeElement, pred: (e: FakeElement) => boolean): FakeElement | null {
  if (pred(root)) return root;
  for (const c of root.children ?? []) {
    const found = findInTree(c, pred);
    if (found) return found;
  }
  return null;
}

function makeSwatTeam(count = 2) {
  const bus = createGameEventBus();
  const addTarget = vi.fn();
  const removeTarget = vi.fn();
  const playerPos = new THREE.Vector3(0, 0, 0);
  const rooms: RoomDef[] = [{ id: 'living', name: 'リビング', x: 0, z: 0, width: 8, depth: 8, floorY: 0 }];
  const deps: SwatTeamDeps = {
    spawns: [{ x: 0, y: 0, z: 8 }],
    count,
    player: {
      alive: true,
      isCrouching: false,
      yawRad: 0,
      position: playerPos,
      getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
      takeDamage: () => 100,
    },
    colliders: [{ kind: 'floor', aabb: { min: { x: -30, y: -0.1, z: -30 }, max: { x: 30, y: 0, z: 30 } } }],
    bus,
    weapons: { addTarget, removeTarget } as unknown as WeaponSystem,
    doors: { doors: [] } as unknown as DoorSystem,
    bounds: { width: 40, depth: 40 },
    stairs: [],
    rooms,
    windows: [],
    flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
    subtitle: { show: vi.fn() } as unknown as Subtitle,
    civilians: () => [],
  };
  const team = new SwatTeam(deps);
  return { team, bus, addTarget, removeTarget };
}

const TEST_MAP: MapData = {
  id: 'test_map',
  name: 'Test House',
  seed: 4242,
  ceilingHeight: 2.8,
  floor: { width: 20, depth: 20 },
  walls: [],
  doors: [],
  windows: [],
  rooms: [{ id: 'r1', name: 'リビング', x: 0, z: 0, width: 8, depth: 8, floorY: 0 }],
  stairs: [],
  floors: [0],
  props: [],
  playerSpawn: { x: 0, y: 0, z: 0, yaw: 0 },
  allies: [],
  suspects: [],
  civilians: [],
};

/** 容疑者モードの「増援ウェーブ」は廃止した。SWAT は最初の突入班だけで戦う。 */
describe('容疑者モード: 増援ウェーブの廃止', () => {
  let prevDoc: unknown;
  let prevWin: unknown;
  let body: FakeElement;

  beforeEach(() => {
    prevDoc = (globalThis as { document?: unknown }).document;
    prevWin = (globalThis as { window?: unknown }).window;
    const head = makeFakeElement('head');
    body = makeFakeElement('body');
    (globalThis as { document?: unknown }).document = {
      head,
      body,
      getElementById: () => null,
      createElement: (tag: string) => makeFakeElement(tag),
      createTextNode: (text: string) => ({ textContent: text }),
    };
    (globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    (globalThis as { document?: unknown }).document = prevDoc;
    (globalThis as { window?: unknown }).window = prevWin;
    vi.restoreAllMocks();
  });

  it('増援の API・定数が残っていない', () => {
    const team = makeSwatTeam(2).team;
    for (const key of ['hasPendingReinforcements', 'reinforcementWavesSpawned', 'spawnReinforcements', 'checkReinforcements']) {
      expect(key in team, key).toBe(false);
    }
    for (const key of Object.keys(SwatTeamModule)) expect(key).not.toMatch(/REINFORCEMENT|Reinforcement/);
    expect('parseReinforcements' in SuspectModeModule).toBe(false);
    team.dispose();
  });

  it('突入班を全滅させれば増援を待たずに撃退で終わる', () => {
    const { team, bus } = makeSwatTeam(2);
    const onEnd = vi.fn();
    const mission = new SuspectMission(
      team,
      { alive: true, position: new THREE.Vector3(0, 0, 0) } as unknown as PlayerController,
      { civilians: new Map(), suspects: new Map() } as unknown as EntityManager,
      { doors: [] } as unknown as DoorSystem,
      { wasPressed: () => false, isDown: () => false } as unknown as InputManager,
      { show: vi.fn() } as unknown as Subtitle,
      bus,
      { register: vi.fn(() => () => {}), setPrompt: vi.fn(), clearPrompt: vi.fn() } as unknown as Interaction,
      onEnd,
    );
    for (let i = 0; i < Math.ceil((SUSPECT_MODE.prepSec + 0.5) / 0.05); i++) mission.update(0.05);
    expect(team.hasStarted).toBe(true);

    for (const h of [...team.hunters]) {
      bus.emit('entityHit', { targetId: h.id, shooter: 'player', damage: 999, pos: { x: 0, y: 1, z: 0 } });
    }
    expect(team.aliveCount).toBe(0);
    for (let i = 0; i < 45; i++) mission.update(0.05);
    expect(team.total).toBe(2); // 誰も追加されない
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]![1]).toBe(false); // 撃退 = 勝利

    mission.dispose();
    team.dispose();
  });

  it('ブリーフィングに増援トグルが無く、タイトルへ戻るボタンとシード行がある', () => {
    const onBack = vi.fn();
    const screen = new BriefingScreen(body as unknown as HTMLElement, TEST_MAP, {
      onStart: vi.fn(),
      mode: 'suspect',
      onRegenerate: vi.fn(),
      onBackToTitle: onBack,
    });
    screen.show();
    expect(findInTree(body, (e) => e.dataset?.option === 'reinforcements')).toBeNull();
    expect(findInTree(body, (e) => /増援|reinforce/i.test(e.textContent))).toBeNull();
    // モード・広さはタイトルで選ぶので、ブリーフィングには出さない
    expect(findInTree(body, (e) => e.dataset?.mode !== undefined)).toBeNull();
    expect(findInTree(body, (e) => e.dataset?.stageId !== undefined)).toBeNull();
    expect(findInTree(body, (e) => e.textContent === 'SEED 4242')).not.toBeNull();
    const back = findInTree(body, (e) => e.dataset?.action === 'title');
    expect(back).not.toBeNull();
    back!.click();
    expect(onBack).toHaveBeenCalledTimes(1);
    screen.dispose();
  });

  it('共有 URL に waves パラメータを付けない', () => {
    expect(buildSeedShareUrl({ stage: 'random_embassy', seed: 999, mode: 'suspect' })).toBe(
      'https://t1048.github.io/cqb-fps/?stage=random_embassy&seed=999&mode=suspect',
    );
  });
});
