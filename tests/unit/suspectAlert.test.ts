import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Civilian } from '../../src/ai/Civilian';
import { HostageThreat, type ThreatCivilianLike, type ThreatSuspectLike } from '../../src/ai/HostageThreat';
import { Suspect } from '../../src/ai/Suspect';
import {
  SuspectAlert,
  complianceMulOf,
  negotiationAlertBaseline,
  tierOf,
  type AlertSuspectLike,
} from '../../src/ai/SuspectAlert';
import { DEFAULT_SUSPECT_ALERT, validateAIProfiles, validateSuspectAlert } from '../../src/core/DataLoader';
import { CivilianState, SuspectState, createGameEventBus } from '../../src/core/events';
import type { AIProfile, RoomDef, SuspectAlertConfig } from '../../src/core/types';
import { buildSwatNegotiation } from '../../src/modes/PreAssaultNegotiation';

const dataDir = path.resolve(__dirname, '../../public/data');
const rawProfiles = JSON.parse(fs.readFileSync(path.join(dataDir, 'ai_profiles.json'), 'utf-8')) as unknown;
const profiles = validateAIProfiles(rawProfiles);
const cfg: SuspectAlertConfig = validateSuspectAlert(rawProfiles);

afterEach(() => vi.restoreAllMocks());

function fakeSuspect(x: number, z: number, footY = 0, state: SuspectState = SuspectState.BARRICADED, opening = false): AlertSuspectLike {
  return { alive: true, state, body: { px: x, pz: z, footY }, isOpeningDoor: opening };
}

describe('ai_profiles.json: suspectAlert 設定', () => {
  it('JSON の値が既定値と一致し、段階しきい値は昇順', () => {
    expect(cfg.gains.flashbang).toBe(20);
    expect(cfg.gains.gunshotBurst).toBe(5);
    expect(cfg.gains.breach).toBe(10);
    expect(cfg.gains.gas).toBe(3);
    expect(cfg.gains.suspectDown).toBe(10);
    expect(cfg.decayPerSec).toBe(1);
    expect(cfg.decayDelaySec).toBe(10);
    expect(cfg.tiers).toEqual({ patrol: 30, ambush: 50, shield: 70, execute: 90 });
    expect(cfg.execution.sustainSec).toBe(8);
    expect(cfg.execution.cooldownSec).toBe(60);
    expect(cfg).toEqual(DEFAULT_SUSPECT_ALERT);
  });

  it('セクションが無い旧データでも既定値で読める / 昇順でないと拒否される', () => {
    expect(validateSuspectAlert({ profiles: [] })).toEqual(DEFAULT_SUSPECT_ALERT);
    expect(() => validateSuspectAlert({ suspectAlert: { tiers: { patrol: 80, ambush: 50 } } })).toThrow();
  });
});

describe('SuspectAlert: 加算・減衰・ベースライン', () => {
  it('閃光弾で大きく上がる（距離・階で減衰）。聞こえる容疑者がいなければ上がらない', () => {
    const bus = createGameEventBus();
    const a = new SuspectAlert(cfg, () => [fakeSuspect(0, 0)], bus);
    bus.emit('flashDetonated', { pos: { x: 3, y: 0, z: 0 }, radius: 8, blindSec: 4 });
    expect(a.value).toBe(20);
    expect(a.flashCount).toBe(1);
    // 遠い（hearFarM 以上）→ farFactor
    const far = new SuspectAlert(cfg, () => [fakeSuspect(0, 0)], bus);
    bus.emit('flashDetonated', { pos: { x: 60, y: 0, z: 0 }, radius: 8, blindSec: 4 });
    expect(far.value).toBeCloseTo(20 * cfg.farFactor);
    // 別階のみ
    const other = new SuspectAlert(cfg, () => [fakeSuspect(0, 0, 3.5)], bus);
    bus.emit('flashDetonated', { pos: { x: 1, y: 0, z: 0 }, radius: 8, blindSec: 4 });
    expect(other.value).toBeCloseTo(20 * cfg.otherFloorFactor);
    // 容疑者がいない
    const none = new SuspectAlert(cfg, () => [], bus);
    bus.emit('flashDetonated', { pos: { x: 1, y: 0, z: 0 }, radius: 8, blindSec: 4 });
    expect(none.value).toBe(0);
    [a, far, other, none].forEach((x) => x.dispose());
  });

  it('銃声はバースト単位（連射中は 1 回だけ）。容疑者の銃声は数えない', () => {
    const bus = createGameEventBus();
    const a = new SuspectAlert(cfg, () => [fakeSuspect(0, 0)], bus);
    for (let i = 0; i < 6; i++) {
      bus.emit('noise', { pos: { x: 2, y: 1, z: 0 }, radius: 40, kind: 'gunshot', source: 'player' });
      a.update(0.1); // 0.6 秒の連射 < gunshotBurstGapSec
    }
    expect(a.value).toBe(5);
    a.update(2); // 間が空くと別のバースト
    bus.emit('noise', { pos: { x: 2, y: 1, z: 0 }, radius: 40, kind: 'gunshot', source: 'ally' });
    expect(a.value).toBe(10);
    bus.emit('noise', { pos: { x: 2, y: 1, z: 0 }, radius: 40, kind: 'gunshot', source: 'suspect' });
    a.update(2);
    bus.emit('noise', { pos: { x: 2, y: 1, z: 0 }, radius: 40, kind: 'gunshot', source: 'suspect' });
    expect(a.value).toBe(10);
    a.dispose();
  });

  it('ブリーチ +10 / C2 追加 +5 / ガス +3 / 容疑者の無力化 +10 / トラップ起爆 +12 / ドア開閉は微小', () => {
    const bus = createGameEventBus();
    const a = new SuspectAlert(cfg, () => [fakeSuspect(0, 0)], bus);
    bus.emit('doorBreached', { doorId: 'd', pos: { x: 1, y: 1, z: 0 }, radius: 4, dir: { x: 0, z: 1 } });
    expect(a.value).toBe(10);
    bus.emit('c2Detonated', { doorId: 'd', pos: { x: 1, y: 1, z: 0 }, dir: { x: 0, z: 1 }, radius: 5 });
    expect(a.value).toBe(15);
    bus.emit('gasDetonated', { pos: { x: 1, y: 1, z: 0 }, radius: 4 });
    expect(a.value).toBe(18);
    bus.emit('suspectStateChanged', { id: 's', from: SuspectState.ENGAGE, to: SuspectState.DOWN, morale: 0 });
    expect(a.value).toBe(28);
    bus.emit('doorTrapDetonated', { doorId: 'd', pos: { x: 1, y: 1, z: 0 } });
    expect(a.value).toBe(40);
    bus.emit('noise', { pos: { x: 1, y: 1, z: 0 }, radius: 10, kind: 'door', source: 'player' });
    expect(a.value).toBe(41);
    a.dispose();
  });

  it('容疑者自身がドアを開けている音では上がらない（巡回による自己増殖を避ける）', () => {
    const bus = createGameEventBus();
    const a = new SuspectAlert(cfg, () => [fakeSuspect(0, 0, 0, SuspectState.BARRICADED, true)], bus);
    bus.emit('noise', { pos: { x: 1, y: 1, z: 0 }, radius: 10, kind: 'door' });
    expect(a.value).toBe(0);
    a.dispose();
  });

  it('静かな時間が decayDelaySec 続くと 1/s で減衰し、ベースライン未満には下がらない', () => {
    const bus = createGameEventBus();
    const a = new SuspectAlert(cfg, () => [fakeSuspect(0, 0)], bus, 25);
    expect(a.value).toBe(25);
    bus.emit('flashDetonated', { pos: { x: 1, y: 0, z: 0 }, radius: 8, blindSec: 4 });
    bus.emit('flashDetonated', { pos: { x: 1, y: 0, z: 0 }, radius: 8, blindSec: 4 });
    expect(a.value).toBe(65);
    a.update(9.9);
    expect(a.value).toBe(65); // まだ静かな時間が足りない
    a.update(0.2 + 10);
    expect(a.value).toBeCloseTo(65 - 10.1, 0);
    a.update(100);
    expect(a.value).toBe(25); // ベースライン止まり
    // 新しい刺激で減衰がリセットされる
    bus.emit('gasDetonated', { pos: { x: 1, y: 1, z: 0 }, radius: 4 });
    const v = a.value;
    a.update(5);
    expect(a.value).toBe(v);
    a.dispose();
  });

  it('setBaseline: 値はベースライン未満にならない（交渉の結果）', () => {
    const a = new SuspectAlert(cfg, () => [], undefined, 0);
    a.setBaseline(40);
    expect(a.value).toBe(40);
    expect(a.baseline).toBe(40);
    a.setBaseline(10);
    expect(a.value).toBe(40);
    a.update(60);
    expect(a.value).toBe(10);
    expect(a.tier).toBe(0);
  });

  it('段階: 30 / 50 / 70 / 90 で 1〜4。90 以上が続く秒数を数える', () => {
    expect([0, 29, 30, 49, 50, 69, 70, 89, 90, 100].map((v) => tierOf(cfg, v))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    const a = new SuspectAlert(cfg, () => [], undefined, 95);
    a.update(3);
    expect(a.executeSustainSec).toBeCloseTo(3);
    a.setBaseline(0);
    expect(a.tier).toBe(4);
    expect(complianceMulOf(cfg, 4)).toBeLessThan(complianceMulOf(cfg, 2));
    expect(complianceMulOf(cfg, 0)).toBe(1);
  });
});

describe('交渉の結果 → 警戒度ベースライン', () => {
  const base = { tension: 45, trust: 10, ultimatums: 0, broken: false };

  it('最後通告・高い緊張で上がり、信頼構築・低い緊張で下がる', () => {
    const neutral = negotiationAlertBaseline(cfg, base);
    expect(neutral).toBeGreaterThan(0);
    expect(neutral).toBeLessThan(cfg.tiers.patrol);
    const ultimatum = negotiationAlertBaseline(cfg, { tension: 75, trust: 0, ultimatums: 1, broken: false });
    expect(ultimatum).toBeGreaterThanOrEqual(cfg.tiers.patrol);
    expect(ultimatum).toBeGreaterThan(neutral);
    const calm = negotiationAlertBaseline(cfg, { tension: 0, trust: 70, ultimatums: 0, broken: false });
    expect(calm).toBe(0);
    expect(negotiationAlertBaseline(cfg, { tension: 100, trust: 0, ultimatums: 2, broken: true })).toBe(cfg.baseline.max);
  });

  it('buildSwatNegotiation: 交渉の各手が onOutcome に反映され、メーターに警戒度予測が出る', () => {
    const outcomes: number[] = [];
    const scenario = buildSwatNegotiation({
      suspects: () => [],
      hostages: () => [],
      releaseHostage: () => undefined,
      executeHostage: () => undefined,
      roomName: () => 'Room',
      alertCfg: cfg,
      onOutcome: (_info, baseline) => outcomes.push(baseline),
      fatigue: () => 55,
      setFatigue: () => undefined,
      supplyFatigue: () => 15,
      siegeHour: () => 6,
      fatigueTier: () => 1,
    });
    const initial = outcomes[outcomes.length - 1]!;
    const meter = (): { label: string; value: number } | undefined => scenario.meters().find((m) => /警戒度予測|Forecast Alert/.test(m.label));
    expect(meter()?.value).toBe(initial);
    const [trustOpt, , , , ultimatum] = scenario.options;
    trustOpt!.run();
    trustOpt!.run();
    const afterTrust = outcomes[outcomes.length - 1]!;
    expect(afterTrust).toBeLessThan(initial);
    ultimatum!.run();
    const afterUlt = outcomes[outcomes.length - 1]!;
    expect(afterUlt).toBeGreaterThan(afterTrust);
    expect(meter()?.value).toBe(afterUlt);
  });
});

describe('Suspect: 警戒度の段階による挙動', () => {
  const base = profiles.find((p) => p.id === 'hardcore_leader')!;
  const roomDef: RoomDef = { id: 'target', name: 'Target', x: 0, z: -5, width: 8, depth: 8, floorY: 0 } as RoomDef;

  function setup(value: number, civilianPos: { x: number; z: number } | null) {
    const bus = createGameEventBus();
    const alert = new SuspectAlert(cfg, () => [], bus, value);
    const civProfile = profiles.find((p) => p.type === 'civilian')!;
    const civ = civilianPos
      ? new Civilian({ id: 'c1', type: 'civilian', x: civilianPos.x, z: civilianPos.z, yaw: 0, profile: civProfile.id }, civProfile, bus, [])
      : null;
    const profile: AIProfile = { ...base, mobility: { ...base.mobility!, guardHostageRoom: false }, ambush: undefined };
    const player = {
      position: new THREE.Vector3(0, 0, 4),
      alive: true,
      isCrouching: false,
      getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, 4),
      getBodyBounds: () => ({ min: { x: -0.3, y: 0, z: 3.7 }, max: { x: 0.3, y: 1.7, z: 4.3 } }),
      takeDamage: () => 100,
    };
    const s = new Suspect({ id: 's1', type: 'suspect', x: 0, z: -5, yaw: 0 }, profile, bus, {
      player,
      colliders: [],
      rooms: [roomDef],
      civilians: () => (civ ? [civ] : []),
      alert: () => alert,
    });
    return { s, civ, alert, bus };
  }

  it('警戒度 70 以上: 近くの民間人を自発的に人質（盾）に取る', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { s, civ } = setup(75, { x: 1.5, z: -5 });
    for (let i = 0; i < 80 && s.state !== SuspectState.HOSTAGE_SHIELD; i++) s.update(0.05);
    expect(s.state).toBe(SuspectState.HOSTAGE_SHIELD);
    expect(s.isHoldingHostage).toBe(true);
    for (let i = 0; i < 80 && civ!.state !== CivilianState.SHIELDED; i++) s.update(0.05);
    expect(civ!.shieldedBy).toBe('s1');
    s.dispose();
    civ!.dispose();
  });

  it('警戒度 70 未満（69）では盾にしない / 範囲外の民間人も盾にしない', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const low = setup(69, { x: 1.5, z: -5 });
    for (let i = 0; i < 80; i++) low.s.update(0.05);
    expect(low.s.state).not.toBe(SuspectState.HOSTAGE_SHIELD);
    const far = setup(80, { x: 6.5, z: -5 });
    for (let i = 0; i < 80; i++) far.s.update(0.05);
    expect(far.s.state).not.toBe(SuspectState.HOSTAGE_SHIELD);
    [low, far].forEach((x) => {
      x.s.dispose();
      x.civ!.dispose();
    });
  });

  it('警戒度が高いほど警告コールの士気低下が小さい（従いにくい）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const calm = setup(0, null);
    const tense = setup(95, null);
    const m0 = calm.s.morale.value;
    const m1 = tense.s.morale.value;
    calm.s.onWarned({ x: 0, y: 0, z: 4 });
    tense.s.onWarned({ x: 0, y: 0, z: 4 });
    const dropCalm = m0 - calm.s.morale.value;
    const dropTense = m1 - tense.s.morale.value;
    expect(dropCalm).toBeGreaterThan(0);
    expect(dropTense).toBeCloseTo(dropCalm * cfg.effects.complianceMul.execute, 5);
    expect(calm.s.warnCount).toBe(1);
    calm.s.dispose();
    tense.s.dispose();
  });

  it('警戒度 50 以上: 待ち伏せの確率が上がる（chance×ambushChanceMul）', () => {
    // 乱数 0.4: 基礎 chance=0.2×k だと外れるが、警戒度で倍率がかかると成立する
    const hostile: AIProfile = { ...base, aggression: 0.5, ambush: { ...base.ambush!, chance: 0.3, maxDist: 14 } };
    const probe = (value: number): boolean => {
      vi.spyOn(Math, 'random').mockReturnValue(0.45);
      const bus = createGameEventBus();
      const alert = new SuspectAlert(cfg, () => [], bus, value);
      const doorLike = { id: 'd1', centerX: 0, centerZ: -1, normalX: 0, normalZ: 1, axisX: 1, axisZ: 0, sillY: 0, width: 1 };
      const walls = [
        { kind: 'wall', aabb: { min: { x: -4.1, y: 0, z: -9.1 }, max: { x: 4.1, y: 3, z: -8.9 } } },
        { kind: 'wall', aabb: { min: { x: -4.1, y: 0, z: -9.1 }, max: { x: -3.9, y: 3, z: -0.9 } } },
        { kind: 'wall', aabb: { min: { x: 3.9, y: 0, z: -9.1 }, max: { x: 4.1, y: 3, z: -0.9 } } },
        { kind: 'wall', aabb: { min: { x: -4.1, y: 0, z: -1.1 }, max: { x: -0.5, y: 3, z: -0.9 } } },
        { kind: 'wall', aabb: { min: { x: 0.5, y: 0, z: -1.1 }, max: { x: 4.1, y: 3, z: -0.9 } } },
      ] as never;
      const player = {
        position: new THREE.Vector3(0, 0, 4),
        alive: true,
        isCrouching: false,
        getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, 4),
        getBodyBounds: () => ({ min: { x: -0.3, y: 0, z: 3.7 }, max: { x: 0.3, y: 1.7, z: 4.3 } }),
        takeDamage: () => 100,
      };
      const s = new Suspect({ id: 'amb', type: 'suspect', x: 2, z: -6, yaw: 0 }, hostile, bus, {
        player,
        colliders: walls,
        rooms: [roomDef],
        doors: { doors: [doorLike] } as never,
        alert: () => alert,
      });
      s.onHeardNoise({ x: 0, y: 1, z: 1.5 }, 'door', 'player');
      const r = s.isAmbushing;
      s.dispose();
      return r;
    };
    expect(probe(0)).toBe(false);
    expect(probe(60)).toBe(true);
  });
});

describe('HostageThreat: 人質処刑の脅迫（カウントダウンと阻止）', () => {
  const room: RoomDef = { id: 'hostage_room', name: 'Hostage Room', x: 0, z: -5, width: 6, depth: 6, floorY: 0 } as RoomDef;
  const warnState = { count: 0, surrenders: false };

  function makeWorld(opts: { value?: number; flashes?: number; tension?: number } = {}) {
    const bus = createGameEventBus();
    const alert = new SuspectAlert(cfg, () => [], bus, opts.value ?? 95);
    for (let i = 0; i < (opts.flashes ?? 0); i++) bus.emit('flashDetonated', { pos: { x: 0, y: 0, z: 0 }, radius: 8, blindSec: 4 });
    // flashCount だけ使うので、人工的に flashDetonated を数える（suspects が空なら値は増えない）
    const suspect = {
      id: 's1',
      alive: true,
      state: SuspectState.ENGAGE as SuspectState,
      body: { px: 0, pz: -5, footY: 0 },
      get warnCount() {
        return warnState.count;
      },
      isHoldingHostage: true,
      forceSurrender() {
        if (!warnState.surrenders) return false;
        this.state = SuspectState.SURRENDER;
        return true;
      },
    };
    const civilian = {
      id: 'c1',
      alive: true,
      evacuated: false,
      state: CivilianState.SHIELDED as CivilianState,
      body: { px: 0.5, pz: -5, footY: 0 },
    };
    const officers: { x: number; z: number; footY: number }[] = [{ x: 0, z: 8, footY: 0 }];
    const said: string[] = [];
    const executed: string[] = [];
    const events: { phase: string; reason?: string }[] = [];
    bus.on('hostageThreat', (e) => events.push({ phase: e.phase, reason: e.reason }));
    const threat = new HostageThreat({
      cfg,
      alert,
      suspects: () => [suspect as ThreatSuspectLike],
      civilians: () => [civilian as ThreatCivilianLike],
      rooms: [room],
      officers: () => officers,
      bus,
      say: (text) => said.push(text),
      execute: (cid) => {
        executed.push(cid);
        civilian.alive = false;
      },
      tensionHigh: () => (opts.tension ?? 80) >= cfg.execution.tensionMin,
      rand: () => 0,
    });
    return { threat, alert, suspect, civilian, officers, said, executed, events, bus };
  }

  function run(w: ReturnType<typeof makeWorld>, sec: number, step = 0.25): void {
    for (let t = 0; t < sec; t += step) {
      w.alert.update(step);
      w.threat.update(step);
    }
  }

  it('警戒度が 90 以上を sustainSec 保つまでは脅迫しない', () => {
    const w = makeWorld();
    run(w, cfg.execution.sustainSec - 1);
    expect(w.threat.isActive).toBe(false);
    run(w, 1.5);
    expect(w.threat.isActive).toBe(true);
    expect(w.events[0]).toMatchObject({ phase: 'start' });
    expect(w.said.length).toBe(1);
    expect(w.threat.pulse()).not.toBeNull();
  });

  it('緊張が低く閃光弾も少ないなら脅迫しない / 閃光弾を繰り返し使うと解禁', () => {
    const calm = makeWorld({ tension: 20 });
    run(calm, 30);
    expect(calm.threat.isActive).toBe(false);
    warnState.count = 0;
    const flashed = makeWorld({ tension: 20 });
    // suspects を空にしていても flashCount は増える
    for (let i = 0; i < cfg.execution.repeatedFlashes; i++) {
      flashed.bus.emit('flashDetonated', { pos: { x: 0, y: 0, z: 0 }, radius: 8, blindSec: 4 });
    }
    flashed.alert.setBaseline(95);
    run(flashed, cfg.execution.sustainSec + 1);
    expect(flashed.threat.isActive).toBe(true);
  });

  it('カウントダウンが尽きると人質が処刑される。その後 cooldown の間は再発しない', () => {
    const w = makeWorld();
    run(w, cfg.execution.sustainSec + 1);
    expect(w.threat.isActive).toBe(true);
    run(w, cfg.execution.countdownSec - 3);
    expect(w.executed).toEqual([]);
    run(w, 3);
    expect(w.executed).toEqual(['c1']);
    expect(w.events.map((e) => e.phase)).toEqual(['start', 'executed']);
    expect(w.threat.isActive).toBe(false);
    expect(w.threat.cooldownLeft).toBeGreaterThan(cfg.execution.cooldownSec - 3);
    // 別の人質がいても cooldown 中は新しい脅迫を始めない
    w.civilian.alive = true;
    w.civilian.state = CivilianState.SHIELDED;
    run(w, 30);
    expect(w.threat.isActive).toBe(false);
  });

  it('阻止: 隊員が人質のいる部屋に到達すると取りやめ（reached）', () => {
    const w = makeWorld();
    run(w, cfg.execution.sustainSec + 1);
    expect(w.threat.isActive).toBe(true);
    run(w, 3);
    w.officers.push({ x: 1, z: -3.5, footY: 0 }); // 部屋の中
    run(w, 0.5);
    expect(w.threat.isActive).toBe(false);
    expect(w.executed).toEqual([]);
    expect(w.events.at(-1)).toEqual({ phase: 'prevented', reason: 'reached' });
  });

  it('阻止: 警告コールで容疑者が従う（complied）。従わなければカウントダウンは続く', () => {
    warnState.surrenders = false;
    const w = makeWorld();
    run(w, cfg.execution.sustainSec + 1);
    warnState.count = 1;
    run(w, 0.5);
    expect(w.threat.isActive).toBe(true);
    warnState.surrenders = true;
    warnState.count = 2;
    run(w, 0.5);
    expect(w.threat.isActive).toBe(false);
    expect(w.events.at(-1)).toEqual({ phase: 'prevented', reason: 'complied' });
    expect(w.executed).toEqual([]);
    warnState.surrenders = false;
    warnState.count = 0;
  });

  it('阻止: 人質が確保される / 容疑者が制圧される（resolved）', () => {
    const resolved = makeWorld();
    run(resolved, cfg.execution.sustainSec + 1);
    resolved.civilian.state = CivilianState.SECURED;
    run(resolved, 0.5);
    expect(resolved.events.at(-1)).toEqual({ phase: 'prevented', reason: 'resolved' });
    expect(resolved.executed).toEqual([]);

    const downed = makeWorld();
    run(downed, cfg.execution.sustainSec + 1);
    downed.suspect.state = SuspectState.DOWN;
    downed.suspect.alive = false;
    run(downed, 0.5);
    expect(downed.events.at(-1)?.phase).toBe('prevented');
    expect(downed.executed).toEqual([]);
  });

  it('阻止: 警戒度が下がっていれば取りやめる（calmed）', () => {
    const w = makeWorld({ value: 95 });
    run(w, cfg.execution.sustainSec + 1);
    expect(w.threat.isActive).toBe(true);
    // ベースライン 0 にして長時間静かにすると cancelBelow を下回る
    w.alert.setBaseline(0);
    (w.alert as unknown as { v: number }).v = 70;
    run(w, 0.5);
    expect(w.events.at(-1)).toEqual({ phase: 'prevented', reason: 'calmed' });
    expect(w.executed).toEqual([]);
  });
});
