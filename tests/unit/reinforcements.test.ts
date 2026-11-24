import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import {
  SwatTeam,
  REINFORCEMENT_MAX_WAVES,
  REINFORCEMENT_MIN_HOLD_SEC,
  REINFORCEMENT_TRIGGER_KILLS,
  shouldTriggerReinforcements,
  type SwatTeamDeps,
} from '../../src/modes/SwatTeam';
import { SuspectMission, parseReinforcements, SUSPECT_MODE } from '../../src/modes/SuspectMode';
import { BriefingScreen } from '../../src/ui/BriefingScreen';
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

function makeSwatTeam(reinforcements: boolean, count = 2) {
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
    reinforcements,
  };
  const team = new SwatTeam(deps);
  return { team, bus, addTarget, removeTarget };
}

describe('F13 — Reinforcement Waves Option', () => {
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

  it('parseReinforcements and shouldTriggerReinforcements pure helpers behave deterministically', () => {
    expect(parseReinforcements('1')).toBe(true);
    expect(parseReinforcements('true')).toBe(true);
    expect(parseReinforcements('0')).toBe(false);
    expect(parseReinforcements(null)).toBe(false);
    expect(parseReinforcements(undefined)).toBe(false);

    const base = {
      enabled: true,
      started: true,
      wavesSpawned: 0,
      maxWaves: REINFORCEMENT_MAX_WAVES,
      aliveCount: 2,
      killsSinceLastWave: REINFORCEMENT_TRIGGER_KILLS,
      holdLeftSec: 120,
      cooldownSec: 0,
    };
    expect(shouldTriggerReinforcements(base)).toBe(true);
    expect(shouldTriggerReinforcements({ ...base, enabled: false })).toBe(false);
    expect(shouldTriggerReinforcements({ ...base, started: false })).toBe(false);
    expect(shouldTriggerReinforcements({ ...base, wavesSpawned: REINFORCEMENT_MAX_WAVES })).toBe(false);
    expect(shouldTriggerReinforcements({ ...base, holdLeftSec: REINFORCEMENT_MIN_HOLD_SEC - 1 })).toBe(false);
    expect(shouldTriggerReinforcements({ ...base, cooldownSec: 5 })).toBe(false);
    expect(shouldTriggerReinforcements({ ...base, killsSinceLastWave: 1 })).toBe(false);
    // Squad wiped with time left triggers immediately even during cooldown
    expect(shouldTriggerReinforcements({ ...base, aliveCount: 0, killsSinceLastWave: 0, cooldownSec: 15 })).toBe(true);
  });

  it('SwatTeam.spawnReinforcements spawns 2-man exterior cell (1 shield + 1 rifle), preserves existing callsigns, and cleans up on dispose', () => {
    const off = makeSwatTeam(false, 2);
    expect(off.team.hasPendingReinforcements).toBe(false);
    off.team.beginAssault();
    expect(off.team.checkReinforcements(120)).toBe(false);
    expect(off.team.total).toBe(2);
    off.team.dispose();

    const on = makeSwatTeam(true, 4);
    expect(on.team.hasPendingReinforcements).toBe(true);
    const initialCallsigns = on.team.hunters.map((h) => h.callsign);
    expect(initialCallsigns).toEqual(['Red-1', 'Red-2', 'Blue-1', 'Blue-2']);

    on.team.beginAssault();
    const spawned = on.team.spawnReinforcements();
    expect(spawned).toBe(2);
    expect(on.team.total).toBe(6);
    expect(on.team.aliveCount).toBe(6);
    expect(on.team.reinforcementWavesSpawned).toBe(1);

    // Existing callsigns preserved; new wave gets Gold cell with 1 shielded + 1 rifleman
    expect(on.team.hunters.slice(0, 4).map((h) => h.callsign)).toEqual(initialCallsigns);
    const wave1 = on.team.hunters.slice(4);
    expect(wave1[0]!.callsign).toBe('Gold-1');
    expect(wave1[0]!.shielded).toBe(true);
    expect(wave1[1]!.callsign).toBe('Gold-2');
    expect(wave1[1]!.shielded).toBe(false);
    expect(on.addTarget).toHaveBeenCalledTimes(6);

    // Exhaust max waves
    on.team.spawnReinforcements();
    expect(on.team.reinforcementWavesSpawned).toBe(REINFORCEMENT_MAX_WAVES);
    expect(on.team.hasPendingReinforcements).toBe(false);
    expect(on.team.checkReinforcements(120)).toBe(false);

    on.team.dispose();
    expect(on.removeTarget).toHaveBeenCalledTimes(8);
  });

  it('SuspectMission gates repelled conclusion on pending reinforcement waves', () => {
    const { team, bus } = makeSwatTeam(true, 2);
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

    // Advance past prepSec to begin assault
    for (let i = 0; i < Math.ceil((SUSPECT_MODE.prepSec + 0.5) / 0.05); i++) {
      mission.update(0.05);
    }
    expect(team.hasStarted).toBe(true);

    // Kill all initial SWAT -> Wave 1 spawns instead of concluding 'repelled'
    for (const h of [...team.hunters]) {
      bus.emit('entityHit', { targetId: h.id, shooter: 'player', damage: 999, pos: { x: 0, y: 1, z: 0 } });
    }
    expect(team.aliveCount).toBe(0);
    mission.update(0.05);
    expect(team.reinforcementWavesSpawned).toBe(1);
    expect(team.aliveCount).toBe(2);
    expect(onEnd).not.toHaveBeenCalled();

    // Kill Wave 1 -> Wave 2 spawns
    for (const h of [...team.hunters]) {
      if (h.alive) bus.emit('entityHit', { targetId: h.id, shooter: 'player', damage: 999, pos: { x: 0, y: 1, z: 0 } });
    }
    mission.update(0.05);
    expect(team.reinforcementWavesSpawned).toBe(2);
    expect(team.aliveCount).toBe(2);
    expect(team.hasPendingReinforcements).toBe(false);

    // Kill Wave 2 -> now repelled triggers and finishes after 2.0s delay
    for (const h of [...team.hunters]) {
      if (h.alive) bus.emit('entityHit', { targetId: h.id, shooter: 'player', damage: 999, pos: { x: 0, y: 1, z: 0 } });
    }
    for (let i = 0; i < 45; i++) mission.update(0.05);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]![1]).toBe(false); // failed = false (repelled victory)

    mission.dispose();
    team.dispose();
  });

  it('BriefingScreen renders reinforcements toggle only in suspect mode and invokes callback on click', () => {
    const map: MapData = {
      id: 'test_map',
      name: 'Test House',
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

    const onToggle = vi.fn();
    const suspectScreen = new BriefingScreen(body as unknown as HTMLElement, map, {
      onStart: vi.fn(),
      mode: 'suspect',
      onSelectMode: vi.fn(),
      reinforcements: false,
      onToggleReinforcements: onToggle,
    });
    suspectScreen.show();

    const toggleBtn = findInTree(body, (e) => e.dataset?.option === 'reinforcements');
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn!.getAttribute('aria-pressed')).toBe('false');
    toggleBtn!.click();
    expect(onToggle).toHaveBeenCalledWith(true);
    suspectScreen.dispose();

    // Normal SWAT mode should NOT render reinforcements toggle
    body.children.length = 0;
    const swatScreen = new BriefingScreen(body as unknown as HTMLElement, map, {
      onStart: vi.fn(),
      mode: 'swat',
      onSelectMode: vi.fn(),
      reinforcements: false,
      onToggleReinforcements: vi.fn(),
    });
    swatScreen.show();
    expect(findInTree(body, (e) => e.dataset?.option === 'reinforcements')).toBeNull();
    swatScreen.dispose();
  });
});
