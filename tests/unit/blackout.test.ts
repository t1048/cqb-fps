import { describe, expect, it, vi } from 'vitest';
import { PowerGrid } from '../../src/rules/Power';
import {
  BCSM_SKIP_MUL,
  BCSM_STEPS,
  bcsmStage,
  buildSuspectNegotiation,
  buildSwatNegotiation,
  type NegotiationPowerCtl,
} from '../../src/modes/PreAssaultNegotiation';
import { findPanelPlacement } from '../../src/world/BreakerPanel';
import type { Collider } from '../../src/world/WorldBuilder';
import type { Suspect } from '../../src/ai/Suspect';
import type { Civilian } from '../../src/ai/Civilian';
import type { RoomDef } from '../../src/core/types';

describe('PowerGrid: 外部の供給 × 配電盤', () => {
  it('両方が入っているときだけ通電し、変化したときだけ通知する', () => {
    const p = new PowerGrid();
    const seen: boolean[] = [];
    p.onChange((c) => seen.push(c.on));
    expect(p.on).toBe(true);
    p.setBreaker(false, 'suspect');
    expect(p.on).toBe(false);
    // 停電中にさらに外部を止めても通知は出ない
    p.setUtility(false, 'negotiation');
    // 外部が止まっている間は、ブレーカーを上げても戻らない
    p.setBreaker(true, 'swat');
    expect(p.on).toBe(false);
    p.setUtility(true, 'restore');
    expect(p.on).toBe(true);
    expect(seen).toEqual([false, true]);
  });
});

/** 交渉用の最小の容疑者・人質 */
const fakeSuspect = (id: string, morale = 40): Suspect =>
  ({
    id,
    alive: true,
    state: 'BARRICADED',
    morale: { value: morale },
    body: { px: 0, pz: 0, footY: 0 },
    adjustMorale: () => undefined,
    forceSurrender: () => true,
  }) as unknown as Suspect;

function powerCtl(): NegotiationPowerCtl & { grid: PowerGrid; blackout: boolean; breachBlackout(): boolean; setBreachBlackout(v: boolean): void } {
  const grid = new PowerGrid();
  const ctl = {
    grid,
    blackout: false,
    isOn: () => grid.on,
    utilityOn: () => grid.utility,
    cutUtility: () => grid.setUtility(false, 'negotiation'),
    restoreUtility: () => grid.setUtility(true, 'restore'),
    panelRoom: () => 'Kitchen',
    breachBlackout: () => ctl.blackout,
    setBreachBlackout: (v: boolean) => {
      ctl.blackout = v;
    },
  };
  return ctl;
}

function swatScenario(hostageCount = 2) {
  const hostages: Civilian[] = Array.from({ length: hostageCount }, (_, i) => ({ id: `h${i}` }) as unknown as Civilian);
  const power = powerCtl();
  let fatigue = 40;
  let planted = false;
  const scenario = buildSwatNegotiation({
    suspects: () => [fakeSuspect('s1')],
    hostages: () => hostages,
    releaseHostage: (c) => hostages.splice(hostages.indexOf(c), 1),
    executeHostage: () => undefined,
    roomName: () => 'Room',
    fatigue: () => fatigue,
    setFatigue: (v) => {
      fatigue = Math.min(100, v);
    },
    supplyFatigue: () => 15,
    siegeHour: () => 6,
    fatigueTier: () => 1,
    power,
    bug: {
      plant: () => {
        planted = true;
        return 'Living';
      },
      planted: () => planted,
    },
  });
  const opt = (icon: string) => scenario.options.find((o) => o.icon === icon)!;
  return { scenario, power, hostages, opt, fatigue: () => fatigue };
}

describe('SWAT 交渉: 行動変化の階段（BCSM）', () => {
  it('信頼の値から段階が決まる', () => {
    expect(bcsmStage(0)).toBe(0);
    expect(bcsmStage(BCSM_STEPS[2]!.at)).toBe(2);
    expect(bcsmStage(100)).toBe(BCSM_STEPS.length - 1);
  });

  it('段階を飛ばした要求は成功率が下がり、傾聴で段階を上げると戻る', () => {
    const { scenario, opt } = swatScenario();
    const release = opt('🧍');
    expect(release.requires?.()?.met).toBe(false);
    const skipped = release.chance!()!;
    // 傾聴を重ねて「信頼関係」へ
    for (let i = 0; i < 3; i++) opt('👂').run();
    expect(scenario.ladder!().index).toBeGreaterThanOrEqual(2);
    expect(release.requires?.()?.met).toBe(true);
    expect(release.chance!()!).toBeGreaterThan(skipped / BCSM_SKIP_MUL - 0.3);
    expect(release.chance!()!).toBeGreaterThan(skipped);
  });

  it('傾聴の伸びは繰り返すほど鈍る', () => {
    const { opt } = swatScenario();
    const gainOf = () => Number(/\+(\d+)/.exec(opt('👂').effects!().gain![1]!)![1]);
    const first = gainOf();
    opt('👂').run();
    opt('👂').run();
    expect(gainOf()).toBeLessThan(first);
  });
});

describe('SWAT 交渉: 電源と盗聴器', () => {
  it('電気を止めると消耗が上がり、電気と人質の取引が選べるようになる', () => {
    const { power, opt, fatigue } = swatScenario();
    const trade = opt('💡');
    expect(trade.disabledReason()).not.toBeNull();
    const before = fatigue();
    opt('🔌').run();
    expect(power.grid.on).toBe(false);
    expect(fatigue()).toBe(before + 15);
    expect(trade.disabledReason()).toBeNull();
    expect(opt('🔌').disabledReason()).not.toBeNull();
  });

  it('電気と引き換えの解放が成功すると、人質が減って電気が戻る', () => {
    const { power, hostages, opt } = swatScenario();
    opt('🔌').run();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    opt('💡').run();
    spy.mockRestore();
    expect(hostages.length).toBe(1);
    expect(power.grid.on).toBe(true);
  });

  it('突入プランの停電は、電気が通っているときだけ切り替えられる', () => {
    const { scenario, power, opt } = swatScenario();
    const tg = scenario.plan!.toggles![0]!;
    expect(tg.disabledReason()).toBeNull();
    tg.set(true);
    expect(power.blackout).toBe(true);
    opt('🔌').run();
    expect(tg.disabledReason()).not.toBeNull();
  });

  it('スローフォンは 1 回だけ。成功すると盗聴器が仕掛かる', () => {
    const { scenario, opt } = swatScenario();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    opt('📞').run();
    spy.mockRestore();
    expect(opt('📞').disabledReason()).not.toBeNull();
    expect(scenario.plan!.items().some((it) => it.icon === '📞' && it.tone === 'good')).toBe(true);
  });

  it('選択肢はグループの順に並び、10 個までに収まる（数字キー 1〜0）', () => {
    const { scenario } = swatScenario();
    const order = scenario.groups!.map((g) => g.id);
    const idx = scenario.options.map((o) => order.indexOf(o.group ?? ''));
    expect(idx.every((v) => v >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(scenario.options.length).toBeLessThanOrEqual(10);
  });
});

describe('容疑者側の交渉: SWAT の電源遮断', () => {
  it('忍耐が半分を切ると SWAT が電気を止め、電気を戻せと要求できる', () => {
    const power = powerCtl();
    let chance = -1;
    let fatigue = 30;
    const scenario = buildSuspectNegotiation({
      hostages: () => [],
      releaseHostage: () => undefined,
      addPrep: () => undefined,
      breakdown: () => undefined,
      prepSec: () => 60,
      giveArmor: () => undefined,
      hasArmor: () => false,
      vestSpec: () => ({ durability: 1, absorbPct: 50, speedMul: 0.9, footstepRadiusMul: 1.2, leanSpeedMul: 0.8 }),
      giveMagazines: () => undefined,
      giveMedkit: () => undefined,
      medkitSpec: () => ({ holdSec: 3, heal: 40, tradeCount: 1 }),
      withdrawSwat: () => false,
      swatCount: () => 4,
      allies: () => [],
      fatigue: () => fatigue,
      setFatigue: (v) => {
        fatigue = v;
      },
      supplyFatigue: () => 10,
      siegeHour: () => 6,
      fatigueTier: () => 0,
      markScouted: () => undefined,
      power,
      setBreachBlackoutChance: (p) => {
        chance = p;
      },
    });
    const start = chance;
    expect(start).toBeGreaterThan(0);
    const demand = scenario.options.find((o) => o.icon === '💡')!;
    expect(demand.disabledReason()).not.toBeNull();
    const stall = scenario.options.find((o) => o.icon === '⏳')!;
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99); // 時間稼ぎを失敗させて忍耐を削る
    const lines = [...stall.run(), ...stall.run()];
    spy.mockRestore();
    expect(power.grid.on).toBe(false);
    expect(fatigue).toBe(40);
    expect(lines.some((l) => /電気が止められた|power was cut/.test(l.text))).toBe(true);
    expect(demand.disabledReason()).toBeNull();
    // 停電中は「突入と同時に停電」の確率は 0
    expect(chance).toBe(0);
  });
});

describe('配電盤の設置場所', () => {
  it('壁があってドアから離れた室内側の面に付く', () => {
    const room: RoomDef = { id: 'k', name: 'キッチン', x: 0, z: 0, width: 6, depth: 4, floorY: 0 };
    const wall = (minX: number, maxX: number, minZ: number, maxZ: number): Collider => ({
      kind: 'wall',
      aabb: { min: { x: minX, y: 0, z: minZ }, max: { x: maxX, y: 3, z: maxZ } },
    });
    const colliders = [wall(-3.1, -2.9, -2, 2), wall(2.9, 3.1, -2, 2), wall(-3, 3, -2.1, -1.9), wall(-3, 3, 1.9, 2.1)];
    // 西の壁の真ん中にドア
    const p = findPanelPlacement({
      rooms: [room],
      doors: [{ id: 'd', x: -3, z: 0, yaw: 90, locked: false, maxAngle: 90 }],
      windows: [],
      colliders,
    });
    expect(p).not.toBeNull();
    expect(Math.hypot(p!.x + 3, p!.z)).toBeGreaterThan(1);
    // 面は壁の室内側で、法線は部屋の中心を向く
    expect(p!.nx * (0 - p!.x) + p!.nz * (0 - p!.z)).toBeGreaterThan(0);
    expect(p!.y).toBeCloseTo(1.45);
  });

  it('屋内の部屋が無ければ置かない', () => {
    const room: RoomDef = { id: 'y', name: 'Yard', x: 0, z: 0, width: 10, depth: 10, outdoor: true };
    expect(findPanelPlacement({ rooms: [room], doors: [], windows: [], colliders: [] })).toBeNull();
  });
});
