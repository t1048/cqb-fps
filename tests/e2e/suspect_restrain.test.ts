import { afterEach, describe, expect, it } from 'vitest';
import type { RestrainTarget } from '../../src/ai/restrain';
import { CUFF_SEC } from '../../src/ai/restrain';
import { makeSingleRoomMap } from './helpers/headlessWorld';
import { createSwatHarness, type SwatHarness } from './helpers/simDriver';

const active: SwatHarness[] = [];
afterEach(() => {
  while (active.length) active.pop()!.dispose();
});

interface FakeAlly extends RestrainTarget {
  state: 'surrender' | 'cuffed' | 'fight';
  cuffCalls: number;
  betrayAt: { x: number; y: number; z: number } | null;
}

function fakeAlly(x: number, z: number, fakeChance: number): FakeAlly {
  const a: FakeAlly = {
    id: 'ally_1',
    px: x,
    pz: z,
    footY: 0,
    state: 'surrender',
    cuffCalls: 0,
    betrayAt: null,
    get alive() {
      return true;
    },
    get surrendered() {
      return a.state === 'surrender';
    },
    get restrained() {
      return a.state === 'cuffed';
    },
    fakeChance,
    cuff() {
      a.cuffCalls++;
      a.state = 'cuffed';
      return true;
    },
    betray(at) {
      a.betrayAt = { ...at };
      a.state = 'fight';
      return true;
    },
  };
  return a;
}

/** 突入済みの 1 部屋（8m 四方）。SWAT 2 名は扉の内側、プレイヤーは遠くの外（視界に入らない）。味方は部屋の奥で投降している */
function setup(fakeChance: number): { h: SwatHarness; ally: FakeAlly } {
  const ally = fakeAlly(2.4, -2.6, fakeChance);
  const h = createSwatHarness({
    map: makeSingleRoomMap({ includeCover: false }),
    spawns: [
      { x: -1.2, y: 0, z: 2.6 },
      { x: 1.2, y: 0, z: 2.6 },
    ],
    count: 2,
    playerPos: { x: 0, y: 0, z: 40 },
    restrainables: () => [ally],
    startAssault: true,
  });
  active.push(h);
  return { h, ally };
}

describe('Suspect mode: SWAT restrain surrendered allied suspects', () => {
  it('sends one officer to cuff (about 3.5s, vulnerable) while the partner covers, and radios it', () => {
    const { h, ally } = setup(0);
    let sawCuffer = false;
    let sawCover = false;
    let maxActive = 0;
    for (let i = 0; i < 40 * 20 && ally.state === 'surrender'; i++) {
      h.step(0.05, 0.05);
      const states = h.team.hunters.filter((u) => u.state === 'restrain');
      if (states.some((u) => u.restrainRole === 'cuff')) sawCuffer = true;
      if (states.some((u) => u.restrainRole === 'cover')) sawCover = true;
      maxActive = Math.max(maxActive, h.team.restraintStats.active);
    }
    expect(ally.state).toBe('cuffed');
    expect(ally.cuffCalls).toBe(1);
    expect(sawCuffer).toBe(true);
    expect(sawCover).toBe(true);
    expect(maxActive).toBe(1);
    const lines = h.recorder.of('allyRadio').map((e) => e.payload.voiceText);
    expect(lines.some((l) => /restrain/i.test(l))).toBe(true);
    // 拘束は CUFF_SEC かけて行う（接触後すぐ終わらない）
    expect(h.team.restraintStats.cuffed).toBe(1);
  });

  it('cuffing takes CUFF_SEC of contact time', () => {
    const { h, ally } = setup(0);
    let reachedAt = -1;
    let t = 0;
    while (t < 40 && ally.state === 'surrender') {
      h.step(0.05, 0.05);
      t += 0.05;
      const cuffer = h.team.hunters.find((u) => u.state === 'restrain' && u.restrainRole === 'cuff');
      if (reachedAt < 0 && cuffer && Math.hypot(cuffer.body.px - ally.px, cuffer.body.pz - ally.pz) <= 1.3) reachedAt = t;
    }
    expect(reachedAt).toBeGreaterThan(0);
    expect(t - reachedAt).toBeGreaterThanOrEqual(CUFF_SEC - 0.2);
  });

  it('a fake surrender (fakeSurrenderChance=1) turns on the cuffing officer instead of being cuffed', () => {
    const { h, ally } = setup(1);
    for (let i = 0; i < 40 * 20 && ally.state === 'surrender'; i++) h.step(0.05, 0.05);
    expect(ally.state).toBe('fight');
    expect(ally.cuffCalls).toBe(0);
    expect(ally.betrayAt).not.toBeNull();
    expect(h.team.restraintStats.betrayed).toBe(1);
    // 拘束役・援護役とも即座に交戦へ
    h.step(0.1, 0.05);
    expect(h.team.hunters.every((u) => u.state === 'engage')).toBe(true);
    expect(h.recorder.of('allyRadio').some((e) => /fake/i.test(e.payload.voiceText))).toBe(true);
  });

  it('does not start cuffing while the team is engaged with a threat', () => {
    const { h, ally } = setup(0);
    const first = h.team.hunters[0]!;
    first.known = { x: 0, y: 0, z: 30 };
    first.setState('engage');
    h.step(2, 0.05);
    expect(ally.state).toBe('surrender');
    expect(h.team.hunters.some((u) => u.state === 'restrain')).toBe(false);
  });
});
