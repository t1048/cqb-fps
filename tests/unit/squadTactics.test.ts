import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SuspectState } from '../../src/core/events';
import type { RoomDef } from '../../src/core/types';
import { GAS_STALEMATE_SEC } from '../../src/ai/squad/squadGas';
import {
  GAS_WINDUP_SEC,
  TACTIC_MIN_COMMIT_SEC,
  createTeamTacticState,
  scoreGasFollowUp,
  scoreTactics,
  selectTactic,
  updateGasOperationUnit,
  updateTeamTactics,
  type TacticConsiderations,
} from '../../src/ai/squad/squadTactics';
import type { AllyUnit, SquadContext } from '../../src/ai/squad/squadTypes';

function cons(over: Partial<TacticConsiderations> = {}): TacticConsiderations {
  return {
    sinceContact: 0,
    flashAvailable: true,
    gasCandidate: false,
    gasLeftRatio: 1,
    teamHealth: 1,
    suspectsInTargetRoom: 0,
    ...over,
  };
}

function best(c: TacticConsiderations): string {
  const s = scoreTactics(c);
  return (Object.keys(s) as (keyof typeof s)[]).reduce((a, b) => (s[b] > s[a] ? b : a));
}

describe('team tactic utility scoring escalates step by step', () => {
  it('shoot → suppress → flash → gas → hold as the stalemate grows', () => {
    expect(best(cons({ sinceContact: 0.1 }))).toBe('engage');
    expect(best(cons({ sinceContact: 0.4 }))).toBe('suppress');
    expect(best(cons({ sinceContact: 1.5 }))).toBe('flash');
    expect(best(cons({ sinceContact: GAS_STALEMATE_SEC + 1, gasCandidate: true }))).toBe('gas');
    expect(best(cons({ sinceContact: GAS_STALEMATE_SEC + 1, gasCandidate: false }))).toBe('hold');
  });

  it('an injured team reaches for the flash sooner', () => {
    const healthy = scoreTactics(cons({ sinceContact: 0.8, teamHealth: 1 }));
    const hurt = scoreTactics(cons({ sinceContact: 0.8, teamHealth: 0.3 }));
    expect(hurt.flash).toBeGreaterThan(healthy.flash);
  });

  it('no flash available → stays on suppression', () => {
    expect(best(cons({ sinceContact: 1.5, flashAvailable: false }))).toBe('suppress');
  });

  it('gas score rises with more dug-in suspects and drops when cans run low', () => {
    const one = scoreTactics(cons({ sinceContact: 10, gasCandidate: true, suspectsInTargetRoom: 1 }));
    const three = scoreTactics(cons({ sinceContact: 10, gasCandidate: true, suspectsInTargetRoom: 3 }));
    const lastCan = scoreTactics(cons({ sinceContact: 10, gasCandidate: true, gasLeftRatio: 0.34 }));
    expect(three.gas).toBeGreaterThan(one.gas);
    expect(lastCan.gas).toBeLessThan(one.gas);
  });
});

describe('selectTactic hysteresis', () => {
  const scores = (o: Partial<Record<string, number>>) => ({ engage: 0, suppress: 0, flash: 0, gas: 0, hold: 0.3, ...o });

  it('keeps the current tactic until the minimum commit time passes', () => {
    expect(selectTactic('suppress', 0.2, scores({ suppress: 0.7, flash: 0.9 }))).toBe('suppress');
    expect(selectTactic('suppress', TACTIC_MIN_COMMIT_SEC, scores({ suppress: 0.7, flash: 0.9 }))).toBe('flash');
  });

  it('needs a clear margin to switch', () => {
    expect(selectTactic('suppress', 5, scores({ suppress: 0.7, flash: 0.75 }))).toBe('suppress');
  });

  it('switches at once when contact comes back or the current tactic becomes invalid', () => {
    expect(selectTactic('gas', 0.1, scores({ engage: 1, gas: 0.7 }))).toBe('engage');
    expect(selectTactic('flash', 0.1, scores({ flash: 0 }))).toBe('hold');
  });
});

describe('post-gas follow-up choice', () => {
  it('a healthy full team pushes in against a lone suspect', () => {
    const s = scoreGasFollowUp({ availableForPush: 4, teamHealth: 1, suspectsInRoom: 1, hasDoor: true });
    expect(s.push).toBeGreaterThan(s.contain);
  });

  it('a hurt team facing several suspects locks down the exits instead', () => {
    const s = scoreGasFollowUp({ availableForPush: 2, teamHealth: 0.5, suspectsInRoom: 2, hasDoor: true });
    expect(s.contain).toBeGreaterThan(s.push);
  });

  it('cannot push without a door or with a single officer', () => {
    expect(scoreGasFollowUp({ availableForPush: 4, teamHealth: 1, suspectsInRoom: 1, hasDoor: false }).push).toBe(0);
    expect(scoreGasFollowUp({ availableForPush: 1, teamHealth: 1, suspectsInRoom: 1, hasDoor: true }).push).toBe(0);
  });
});

// ───────── 作戦シーケンス（宣言 → 援護 → 投擲 → 出口封鎖 / 中止） ─────────

function makeAlly(id: string, x: number, z: number): AllyUnit {
  const body = {
    px: x,
    pz: z,
    footY: 0,
    eye: (out: THREE.Vector3) => out.set(x, 1.6, z),
    setPose: vi.fn(),
    aimAt: vi.fn(),
  };
  return {
    id,
    name: id,
    down: false,
    blindLeft: 0,
    engaging: false,
    hp: 100,
    maxHp: 100,
    order: 'follow',
    phase: 'follow',
    vel: { x: 0, z: 0 },
    progress: '',
    gasIntel: { suspectId: 's1', pos: { x: 0, y: 0, z: 0 }, t: 22 },
    body,
  } as unknown as AllyUnit;
}

function makeCtx() {
  const room: RoomDef = { id: 'bed', name: 'Bedroom', x: 0, z: 0, width: 4, depth: 4 };
  const thrower = makeAlly('a1', -7, 0);
  const buddy = makeAlly('a2', -8, 1);
  const suspect = { alive: true, state: SuspectState.BARRICADED };
  const throwFrom = vi.fn();
  const radio: string[] = [];
  const ctx = {
    simTime: 30,
    lastTeamContactT: 10,
    tactic: createTeamTacticState(),
    allies: [thrower, buddy],
    entities: { suspects: new Map([['s1', suspect]]), civilians: new Map() },
    tearGas: { gravity: 9.8, densityAt: () => 0, throwFrom },
    flashbang: undefined,
    flashesLeft: 0,
    flashCd: 0,
    gasLeft: 3,
    gasCd: 0,
    gasRetryCd: 0,
    cfg: { inventory: { gas: 3 } },
    player: { position: new THREE.Vector3(-12, 0, 0) },
    rooms: [room],
    doors: {
      doors: [
        {
          id: 'd1', centerX: -2, centerZ: 0, sillY: 0, normalX: 1, normalZ: 0,
          axisX: 0, axisZ: 1, width: 1, height: 2.1, angle: 90, locked: false,
        },
      ],
    },
    windows: [],
    colliders: [],
    emitRadio: (_a: AllyUnit, ja: string) => radio.push(ja),
  } as unknown as SquadContext;
  return { ctx, thrower, buddy, suspect, throwFrom, radio };
}

function step(ctx: SquadContext, sec: number, dt = 0.05): void {
  for (let t = 0; t < sec; t += dt) {
    (ctx as { simTime: number }).simTime += dt;
    updateTeamTactics(ctx, dt);
  }
}

describe('gas operation sequence', () => {
  it('announces and winds up before throwing, while a teammate covers the doorway', () => {
    const { ctx, thrower, buddy, throwFrom, radio } = makeCtx();
    // 突入に回せないようにする（射線ロック中）→ 投擲後は出口封鎖になる
    buddy.order = 'overwatch';
    step(ctx, 1.0);
    expect(ctx.tactic.current).toBe('gas');
    expect(ctx.tactic.op?.stage).toBe('windup');
    expect(radio.some((r) => r.includes('カバー') || r.includes('出入口'))).toBe(true);
    expect(throwFrom).not.toHaveBeenCalled();

    // 投擲者はその場で構え、仲間は出入口を見る
    expect(updateGasOperationUnit(ctx, thrower, 0.05)).toBe(true);
    buddy.order = 'follow';
    expect(updateGasOperationUnit(ctx, buddy, 0.05)).toBe(true);
    expect(buddy.progress).toContain('援護');
    buddy.order = 'overwatch';

    step(ctx, GAS_WINDUP_SEC + 0.1);
    expect(throwFrom).toHaveBeenCalledTimes(1);
    expect(ctx.gasLeft).toBe(2);
    // 1 名しか空いていない → 出口封鎖
    expect(ctx.tactic.op?.stage).toBe('contain');
  });

  it('aborts the throw if contact comes back during the windup', () => {
    const { ctx, buddy, throwFrom, radio } = makeCtx();
    step(ctx, 1.0);
    expect(ctx.tactic.op?.stage).toBe('windup');
    buddy.engaging = true;
    step(ctx, GAS_WINDUP_SEC + 0.2);
    expect(throwFrom).not.toHaveBeenCalled();
    expect(ctx.tactic.op).toBeNull();
    expect(ctx.gasLeft).toBe(3);
    expect(radio.some((r) => r.includes('中止'))).toBe(true);
  });

  it('does not start while the team is still trading fire', () => {
    const { ctx, throwFrom } = makeCtx();
    (ctx as { lastTeamContactT: number }).lastTeamContactT = 29;
    step(ctx, 1.0);
    expect(ctx.tactic.op).toBeNull();
    expect(throwFrom).not.toHaveBeenCalled();
  });
});
