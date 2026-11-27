import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus, SuspectState } from '../../src/core/events';
import type { AIProfile, EntityDef } from '../../src/core/types';
import type { InputManager } from '../../src/core/InputManager';
import { Suspect } from '../../src/ai/Suspect';
import { Interaction } from '../../src/player/Interaction';
import type { Collider } from '../../src/world/WorldBuilder';
import {
  ALLY_DOWN_MORALE,
  FREE_ALLY_HOLD_SEC,
  SuspectAllyDirector,
  relativeDirection,
  type AllyDirectorTeam,
} from '../../src/modes/SuspectAllies';

function profile(over: Partial<AIProfile> = {}): AIProfile {
  return {
    id: 'ally',
    role: 'suspect',
    initialMorale: 55,
    moraleRecovery: 0,
    reactionTime: 0.25,
    thresholds: { hesitateBelow: 50, surrenderBelow: 25 },
    modifiers: { warningCall: 15, flashbang: 30, nonlethalHit: 25, breach: 20, isolation: 10 },
    fakeSurrenderChance: 0,
    combat: {
      decisionSec: 0.4,
      alertCalmSec: 8,
      hesitateFireSec: 4,
      hesitateRetreatDist: 1.5,
      moveSpeed: 2.4,
      fireInterval: 0.35,
      shotsPerPeek: 3,
      magazineSize: 15,
      reloadSec: 2.0,
      coverSearchRange: 6,
      coverDistance: 1.5,
      peekSecMax: 1.2,
      flinchSec: 0.4,
      engageRange: 16,
      shotDamage: 12,
      gunshotNoiseRadius: 30,
      baseSpreadDeg: 3.0,
      fakeSurrenderChance: 0.35,
      fakeSurrenderSec: 9,
    },
    ...over,
  };
}

function makeAlly(x: number, z: number, id = 'a1'): Suspect {
  const def: EntityDef = { id, type: 'suspect', x, z, hp: 100, profile: 'ally' };
  return new Suspect(def, profile(), createGameEventBus(), null, undefined, 2, true);
}

/** 手錠をかけられた（ARRESTED）状態にする */
function arrest(s: Suspect): void {
  expect(s.forceSurrender()).toBe(true);
  for (let i = 0; i < 25; i++) s.update(0.05);
  expect(s.arrest()).toBe(true);
  expect(s.state).toBe(SuspectState.ARRESTED);
}

interface FakeInput {
  input: InputManager;
  press(): void;
  release(): void;
  endFrame(): void;
}

function fakeInput(): FakeInput {
  let down = false;
  let pressed = false;
  const input = {
    isPointerLocked: true,
    consumeWheel: () => 0,
    isDown: (k: string) => k === 'interact' && down,
    wasPressed: (k: string) => k === 'interact' && pressed,
  } as unknown as InputManager;
  return {
    input,
    press() {
      down = true;
      pressed = true;
    },
    release() {
      down = false;
    },
    endFrame() {
      pressed = false;
    },
  };
}

function setup(allies: Suspect[], colliders: Collider[] = []) {
  const bus = createGameEventBus();
  const noises: { kind: string; source?: string }[] = [];
  bus.on('noise', (e) => noises.push({ kind: e.kind, source: e.source }));
  const fi = fakeInput();
  const interaction = new Interaction(fi.input, 100);
  const subtitle = { show: vi.fn() };
  const gauge = vi.fn();
  const downListeners: ((pos: { x: number; y: number; z: number }, byPlayer: boolean) => void)[] = [];
  const team: AllyDirectorTeam = {
    hunters: [],
    onOfficerDown: (cb) => {
      downListeners.push(cb);
      return () => downListeners.splice(downListeners.indexOf(cb), 1);
    },
  };
  const player = {
    alive: true,
    yawRad: 0,
    position: new THREE.Vector3(0, 0, 0),
    getEyePosition: () => new THREE.Vector3(0, 1.6, 0),
  };
  const director = new SuspectAllyDirector({
    suspects: () => allies,
    player,
    interaction,
    subtitle,
    bus,
    team,
    colliders,
    showGauge: gauge,
  });
  const frame = (dt = 0.05): void => {
    interaction.update(dt);
    director.update(dt);
    fi.endFrame();
  };
  return { director, interaction, fi, subtitle, gauge, noises, frame, downListeners, player, team };
}

describe('Suspect allies: free a restrained accomplice (hold F ~3s)', () => {
  it('Suspect.freeFromRestraint: only works on cuffed allies, lowers morale, rejoins the fight, cannot fake again', () => {
    const a = makeAlly(1, 0);
    expect(a.freeFromRestraint()).toBe(false); // まだ拘束されていない
    arrest(a);
    a.morale.shift(100);
    expect(a.isRestrained).toBe(true);
    expect(a.freeFromRestraint()).toBe(true);
    expect(a.state).toBe(SuspectState.ENGAGE);
    expect(a.isRestrained).toBe(false);
    // 降伏しきい値の少し上まで下がっている（もう一押しで折れる）
    expect(a.morale.value).toBeGreaterThan(25);
    expect(a.morale.value).toBeLessThan(40);
    expect(a.freeFromRestraint()).toBe(false);
  });

  it('shows a hint only for a cuffed ally within reach, and frees it after holding F for 3 seconds', () => {
    const a = makeAlly(1, 0);
    arrest(a);
    const t = setup([a]);
    t.frame();
    expect(t.interaction.getInteractTarget()?.providerId).toBe('freeAlly');
    expect(t.interaction.getInteractTarget()?.label).toMatch(/3/);
    t.fi.press();
    let elapsed = 0;
    while (elapsed < FREE_ALLY_HOLD_SEC - 0.2) {
      t.frame();
      elapsed += 0.05;
      expect(a.state).toBe(SuspectState.ARRESTED);
    }
    expect(t.gauge).toHaveBeenCalled();
    for (let i = 0; i < 8; i++) t.frame();
    expect(a.state).toBe(SuspectState.ENGAGE);
    expect(t.subtitle.show).toHaveBeenCalled();
    // 手錠の金属音が近くの隊員に聞こえる
    expect(t.noises.some((n) => n.source === 'player')).toBe(true);
  });

  it('releasing F early cancels; far or free allies offer no interaction', () => {
    const a = makeAlly(1, 0);
    arrest(a);
    const t = setup([a]);
    t.frame();
    t.fi.press();
    for (let i = 0; i < 20; i++) t.frame();
    t.fi.release();
    t.frame();
    expect(a.state).toBe(SuspectState.ARRESTED);

    const far = makeAlly(15, 0, 'far');
    arrest(far);
    const t2 = setup([far]);
    t2.frame();
    expect(t2.interaction.getInteractTarget()).toBeNull();

    const free = makeAlly(1, 0, 'free');
    const t3 = setup([free]);
    t3.frame();
    expect(t3.interaction.getInteractTarget()).toBeNull();
  });
});

describe('Suspect allies: morale link', () => {
  it('downing an officer within earshot raises the morale of allies nearby (and not far ones)', () => {
    const near = makeAlly(4, 0, 'near');
    const far = makeAlly(60, 0, 'far');
    near.morale.shift(-20);
    far.morale.shift(-20);
    const nearBefore = near.morale.value;
    const farBefore = far.morale.value;
    const t = setup([near, far]);
    for (const cb of t.downListeners) cb({ x: 6, y: 0, z: 0 }, true);
    expect(near.morale.value).toBeCloseTo(nearBefore + ALLY_DOWN_MORALE, 5);
    expect(far.morale.value).toBe(farBefore);
  });

  it('an ally who can see the player nearby recovers nerve over time (less likely to surrender), up to a ceiling', () => {
    const a = makeAlly(3, 0);
    a.morale.shift(-25);
    const before = a.morale.value;
    const t = setup([a]);
    for (let i = 0; i < 80; i++) t.frame();
    expect(a.morale.value).toBeGreaterThan(before + 3);
    for (let i = 0; i < 2000; i++) t.frame();
    expect(a.morale.value).toBeLessThanOrEqual(a.profile.initialMorale + 18 + 1);
  });

  it('surrendered / cuffed allies are not boosted', () => {
    const a = makeAlly(3, 0);
    arrest(a);
    const before = a.morale.value;
    const t = setup([a]);
    for (const cb of t.downListeners) cb({ x: 3, y: 0, z: 0 }, true);
    for (let i = 0; i < 40; i++) t.frame();
    expect(a.morale.value).toBe(before);
  });
});

describe('Suspect allies: callouts', () => {
  it('relativeDirection names the side relative to where the player faces', () => {
    // yaw 0: 前方は -z、右は +x
    expect(relativeDirection(0, 0, -10).ja).toBe('正面');
    expect(relativeDirection(0, 10, 0).en).toBe('on your right');
    expect(relativeDirection(0, -10, 0).en).toBe('on your left');
    expect(relativeDirection(0, 0, 10).en).toBe('behind you');
  });

  it('an ally that sees SWAT the player cannot see calls it out (rate limited); stays quiet when the player sees it too', () => {
    const wall: Collider = { aabb: { min: { x: 2.8, y: 0, z: -3 }, max: { x: 3.2, y: 3, z: -1 } }, kind: 'wall' };
    const mk = (colliders: Collider[]) => {
      const a = makeAlly(0, -4);
      const t = setup([a], colliders);
      (t.team.hunters as unknown as unknown[]).push({
        alive: true,
        body: { px: 6, pz: -4, footY: 0, chestPos: () => ({ x: 6, y: 1.2, z: -4 }) },
      });
      return t;
    };
    const hidden = mk([wall]);
    for (let i = 0; i < 100; i++) hidden.frame();
    expect(hidden.subtitle.show).toHaveBeenCalledTimes(1);
    const msg = String(hidden.subtitle.show.mock.calls[0]![0]);
    expect(msg).toMatch(/SWAT/);
    expect(msg).toMatch(/右|right/);
    for (let i = 0; i < 100; i++) hidden.frame(); // 5 秒: 間隔 14 秒以内なので 2 回目は出ない
    expect(hidden.subtitle.show).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 300; i++) hidden.frame(); // 15 秒以上経つと再び知らせる
    expect(hidden.subtitle.show.mock.calls.length).toBeGreaterThanOrEqual(2);

    const visible = mk([]);
    for (let i = 0; i < 100; i++) visible.frame();
    expect(visible.subtitle.show).not.toHaveBeenCalled();
  });
});
