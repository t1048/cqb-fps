import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProgressionCacheForTest,
  calculateMissionXp,
  getAllowedMotifsForStage,
  getEffectiveSuspectLoadout,
  getEffectiveSwatLoadout,
  getNextUnlockPreview,
  getProgression,
  getStageUnlockLevel,
  getSuspectUnlocks,
  getSwatUnlocks,
  isStageUnlocked,
  isSuspectModeUnlocked,
  isUnlockAll,
  LEVEL_XP_THRESHOLDS,
  levelForXp,
  LV1_SMALL_MOTIFS,
  PROGRESSION_STORAGE_KEY,
  recordMissionResult,
  resetProgression,
  setUnlockAll,
  subscribeProgression,
  updateSquadMemberLoadout,
  updateSuspectLoadout,
  updateSwatLoadout,
  xpProgressInLevel,
} from '../../src/rules/Progression';
import {
  calcSurvivalBonus,
  calcSuspectRank,
  computeSuspectScore,
  SUSPECT_SCORE_POINTS,
  SuspectScoreBoard,
} from '../../src/rules/SuspectScore';

function installMockStorage(search = ''): Map<string, string> {
  const store = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
  (globalThis as unknown as { window?: unknown }).window = {
    localStorage: mockLocalStorage,
    location: { origin: 'https://t1048.github.io', pathname: '/cqb-fps/', search },
  };
  return store;
}

describe('Progression (SWAT & Suspect independent Lv.1-5)', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installMockStorage();
    _resetProgressionCacheForTest();
  });

  afterEach(() => {
    _resetProgressionCacheForTest();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('starts at Lv.1 for both modes and persists XP/level independently to localStorage', () => {
    const initial = getProgression();
    expect(initial.swat.level).toBe(1);
    expect(initial.swat.xp).toBe(0);
    expect(initial.suspect.level).toBe(1);
    expect(initial.suspect.xp).toBe(0);
    expect(initial.unlockAll).toBe(false);
    expect(isSuspectModeUnlocked()).toBe(false);

    // 1st SWAT clear (D rank = 100 + 10 = 110 XP -> reaches Lv.2 at 100 XP)
    const r1 = recordMissionResult({ mode: 'swat', cleared: true, rank: 'D', score: 120, stageId: 'random_small' });
    expect(r1.xpGained).toBe(110);
    expect(r1.prevLevel).toBe(1);
    expect(r1.newLevel).toBe(2);
    expect(r1.leveledUp).toBe(true);
    expect(r1.unlockedItems.some((u) => u.id === 'mode:suspect')).toBe(true);

    // SWAT leveled up, Suspect remains Lv.1 / 0 XP, but Suspect mode is now unlocked
    expect(getProgression().swat.level).toBe(2);
    expect(getProgression().suspect.level).toBe(1);
    expect(getProgression().suspect.xp).toBe(0);
    expect(isSuspectModeUnlocked()).toBe(true);

    // Reload from localStorage cache-free
    _resetProgressionCacheForTest();
    const reloaded = getProgression();
    expect(store.has(PROGRESSION_STORAGE_KEY)).toBe(true);
    expect(reloaded.swat.xp).toBe(110);
    expect(reloaded.swat.level).toBe(2);
    expect(reloaded.swat.clears).toBe(1);
    expect(reloaded.swat.bestRank).toBe('D');
    expect(reloaded.suspect.level).toBe(1);
  });

  it('accumulates XP across clears and failures up to Lv.5', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(LEVEL_XP_THRESHOLDS[1])).toBe(2);
    expect(levelForXp(LEVEL_XP_THRESHOLDS[2])).toBe(3);
    expect(levelForXp(LEVEL_XP_THRESHOLDS[3])).toBe(4);
    expect(levelForXp(LEVEL_XP_THRESHOLDS[4])).toBe(5);
    expect(levelForXp(9999)).toBe(5);

    // Failure gives participation XP + capped score bonus
    expect(calculateMissionXp({ mode: 'swat', cleared: false, rank: 'D', score: 0 })).toBe(25);
    expect(calculateMissionXp({ mode: 'swat', cleared: false, rank: 'D', score: 250 })).toBe(35);
    expect(calculateMissionXp({ mode: 'swat', cleared: false, rank: 'D', score: 5000 })).toBe(45);

    // Clear with S rank on large map: 100 + 80 + 60 = 240 XP
    expect(calculateMissionXp({ mode: 'suspect', cleared: true, rank: 'S', score: 400, stageId: 'random_embassy' })).toBe(240);

    // Advance Suspect independently to Lv.5
    recordMissionResult({ mode: 'suspect', cleared: true, rank: 'S', score: 300, stageId: 'random_small' }); // 180 XP -> Lv.2
    recordMissionResult({ mode: 'suspect', cleared: true, rank: 'S', score: 300, stageId: 'random_small' }); // 360 XP -> Lv.3
    recordMissionResult({ mode: 'suspect', cleared: true, rank: 'S', score: 400, stageId: 'random_house' }); // 570 XP -> Lv.4
    const finalRes = recordMissionResult({ mode: 'suspect', cleared: true, rank: 'S', score: 500, stageId: 'random_embassy' }); // 810 XP -> Lv.5

    expect(finalRes.newLevel).toBe(5);
    expect(finalRes.nextLevelXp).toBeNull();
    expect(getProgression().suspect.level).toBe(5);
    expect(getProgression().suspect.bestRank).toBe('S');
    expect(getProgression().swat.level).toBe(1);

    const progBar = xpProgressInLevel(getProgression().suspect.xp);
    expect(progBar.isMax).toBe(true);
    expect(progBar.ratio).toBe(1);
    expect(getNextUnlockPreview('suspect')).toEqual([]);
  });

  it('supports unlockAll toggle, URL flag, subscribers, and resetProgression()', () => {
    let notifications = 0;
    const unsub = subscribeProgression(() => {
      notifications++;
    });

    recordMissionResult({ mode: 'swat', cleared: true, rank: 'A', score: 200 });
    expect(notifications).toBe(1);
    expect(isUnlockAll()).toBe(false);

    setUnlockAll(true);
    expect(notifications).toBe(2);
    expect(isUnlockAll()).toBe(true);
    expect(isSuspectModeUnlocked()).toBe(true);
    expect(isStageUnlocked('swat', 'random_embassy')).toBe(true);
    expect(getSwatUnlocks().weapons.shotgun).toBe(true);
    expect(getSuspectUnlocks().fortify.archOneWayBarricade).toBe(true);

    // Reset clears XP, levels, loadouts, and unlockAll
    resetProgression();
    expect(notifications).toBe(3);
    const afterReset = getProgression();
    expect(afterReset.unlockAll).toBe(false);
    expect(afterReset.swat.xp).toBe(0);
    expect(afterReset.swat.level).toBe(1);
    expect(afterReset.suspect.xp).toBe(0);
    expect(afterReset.suspect.level).toBe(1);
    expect(isSuspectModeUnlocked()).toBe(false);

    unsub();

    // Tolerates corrupted JSON in localStorage
    store.set(PROGRESSION_STORAGE_KEY, '{invalid-json');
    _resetProgressionCacheForTest();
    expect(getProgression().swat.level).toBe(1);
  });
});

describe('Map size, motif, weapon, vest, squad, negotiation, and fortify unlock gates', () => {
  beforeEach(() => {
    installMockStorage();
    _resetProgressionCacheForTest();
  });

  afterEach(() => {
    _resetProgressionCacheForTest();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('gates map sizes and small-map motifs by mode level', () => {
    expect(getStageUnlockLevel('random_small')).toBe(1);
    expect(getStageUnlockLevel('random_house')).toBe(3);
    expect(getStageUnlockLevel('random_embassy')).toBe(5);

    // Lv.1 SWAT: only random_small, restricted to residence & japanese_house
    expect(isStageUnlocked('swat', 'random_small')).toBe(true);
    expect(isStageUnlocked('swat', 'random_house')).toBe(false);
    expect(isStageUnlocked('swat', 'random_embassy')).toBe(false);
    expect(getAllowedMotifsForStage('swat', 'random_small')).toEqual(LV1_SMALL_MOTIFS);

    // Lv.2 SWAT: all small motifs unlocked, medium still locked
    recordMissionResult({ mode: 'swat', cleared: true, rank: 'D', score: 100 }); // 110 XP -> Lv.2
    expect(getAllowedMotifsForStage('swat', 'random_small')).toBeUndefined();
    expect(isStageUnlocked('swat', 'random_house')).toBe(false);

    // Lv.3 SWAT: random_house unlocked
    recordMissionResult({ mode: 'swat', cleared: true, rank: 'S', score: 300 }); // +180 = 290 XP -> Lv.3
    expect(isStageUnlocked('swat', 'random_house')).toBe(true);
    expect(isStageUnlocked('swat', 'random_embassy')).toBe(false);

    // Lv.5 SWAT: random_embassy unlocked
    recordMissionResult({ mode: 'swat', cleared: true, rank: 'S', score: 300, stageId: 'random_house' }); // +210 = 500 -> Lv.4
    recordMissionResult({ mode: 'swat', cleared: true, rank: 'S', score: 300, stageId: 'random_house' }); // +210 = 710 -> Lv.4
    recordMissionResult({ mode: 'swat', cleared: true, rank: 'D', score: 100 }); // +110 = 820 -> Lv.5
    expect(isStageUnlocked('swat', 'random_embassy')).toBe(true);
  });

  it('gates SWAT weapons, vests, stealth entry, gadgets, squad loadouts, and negotiation cards across Lv.1-5', () => {
    // Lv.1
    let u = getSwatUnlocks();
    expect(u.weapons).toEqual({ rifle: true, smg: false, suppressed_rifle: false, shotgun: false });
    expect(u.vests).toEqual({ light: false, standard: true, heavy: false });
    expect(u.stealthEntry).toBe(false);
    expect(u.teargas).toBe(false);
    expect(u.optiwand).toBe(false);
    expect(u.c2Breach).toBe(false);
    expect(u.shieldMember).toBe(false);
    expect(u.squadLoadoutCustom).toBe(false);
    expect(u.squadGadgetCustom).toBe(false);
    expect(u.negotiationCards).toEqual({
      trust: true,
      release_hostage: true,
      persuade_surrender: true,
      intel: false,
      ultimatum: false,
    });

    // Attempt to equip locked gear at Lv.1 -> effective loadout clamps to safe Lv.1 defaults
    updateSwatLoadout({ primaryWeapon: 'shotgun', vest: 'heavy' });
    updateSquadMemberLoadout(0, { weapon: 'shield', vest: 'heavy', flashbangs: 3, gas: 2 });
    let eff = getEffectiveSwatLoadout();
    expect(eff.primaryWeapon).toBe('rifle');
    expect(eff.vest).toBe('standard');
    expect(eff.squad[0]).toEqual({ weapon: 'rifle', vest: 'standard', flashbangs: 1, gas: 0 });

    // Lv.2: SMG, light vest, teargas, optiwand, intel card
    recordMissionResult({ mode: 'swat', cleared: true, rank: 'D', score: 100 }); // 110 XP -> Lv.2
    u = getSwatUnlocks();
    expect(u.weapons.smg).toBe(true);
    expect(u.vests.light).toBe(true);
    expect(u.teargas).toBe(true);
    expect(u.optiwand).toBe(true);
    expect(u.negotiationCards.intel).toBe(true);
    expect(u.stealthEntry).toBe(false);

    // Lv.3: stealth entry, suppressed_rifle, shieldMember, squadLoadoutCustom, ultimatum
    recordMissionResult({ mode: 'swat', cleared: true, rank: 'S', score: 300 }); // 290 XP -> Lv.3
    u = getSwatUnlocks();
    expect(u.stealthEntry).toBe(true);
    expect(u.c2Breach).toBe(true);
    expect(u.weapons.suppressed_rifle).toBe(true);
    expect(u.shieldMember).toBe(true);
    expect(u.squadLoadoutCustom).toBe(true);
    expect(u.squadGadgetCustom).toBe(false);
    expect(u.negotiationCards.ultimatum).toBe(true);

    eff = getEffectiveSwatLoadout();
    expect(eff.squad[0].weapon).toBe('shield');
    expect(eff.squad[0].vest).toBe('standard'); // heavy still locked until Lv.4
    expect(eff.squad[0].flashbangs).toBe(1); // gadget custom locked until Lv.4
    expect(eff.squad[0].gas).toBe(1);

    // Lv.4: shotgun, heavy vest, squadGadgetCustom
    recordMissionResult({ mode: 'swat', cleared: true, rank: 'S', score: 300, stageId: 'random_house' }); // 500 XP -> Lv.4
    u = getSwatUnlocks();
    expect(u.weapons.shotgun).toBe(true);
    expect(u.vests.heavy).toBe(true);
    expect(u.squadGadgetCustom).toBe(true);

    eff = getEffectiveSwatLoadout();
    expect(eff.primaryWeapon).toBe('shotgun');
    expect(eff.vest).toBe('heavy');
    expect(eff.squad[0]).toEqual({ weapon: 'shield', vest: 'heavy', flashbangs: 3, gas: 2 });
  });

  it('gates Suspect weapons, vests, ally policy, fortify options, and negotiation cards across Lv.1-5', () => {
    // Lv.1
    let u = getSuspectUnlocks();
    expect(u.weapons).toEqual({
      machine_pistol: true,
      suspect_smg: false,
      suspect_shotgun: false,
      suspect_ar: false,
    });
    expect(u.vests).toEqual({ none: true, light: false, standard: false, heavy: false });
    expect(u.allyPolicyCustom).toBe(false);
    expect(u.fortify).toEqual({
      doorLock: true,
      windowBarricade: false,
      doorTrap: false,
      archPlankBarricade: false,
      archOneWayBarricade: false,
    });
    expect(u.negotiationCards).toEqual({
      stall: true,
      supplies: true,
      trade_ammo: true,
      trade_medkit: true,
      trade_time: true,
      trade_vest: false,
      rally: false,
      threaten: false,
    });

    updateSuspectLoadout({ primaryWeapon: 'suspect_ar', vest: 'heavy', allyPolicy: 'fortify' });
    expect(getEffectiveSuspectLoadout()).toEqual({
      primaryWeapon: 'machine_pistol',
      vest: 'none',
      allyPolicy: 'balanced',
    });

    // Lv.2: suspect_smg, light/standard vest, windowBarricade, trade_vest, rally
    recordMissionResult({ mode: 'suspect', cleared: true, rank: 'D', score: 100 }); // 110 XP -> Lv.2
    u = getSuspectUnlocks();
    expect(u.weapons.suspect_smg).toBe(true);
    expect(u.vests.light).toBe(true);
    expect(u.vests.standard).toBe(true);
    expect(u.vests.heavy).toBe(false);
    expect(u.fortify.windowBarricade).toBe(true);
    expect(u.fortify.doorTrap).toBe(false);
    expect(u.negotiationCards.trade_vest).toBe(true);
    expect(u.negotiationCards.rally).toBe(true);

    // Lv.3: suspect_shotgun, doorTrap, allyPolicyCustom, threaten
    recordMissionResult({ mode: 'suspect', cleared: true, rank: 'S', score: 300 }); // 290 XP -> Lv.3
    u = getSuspectUnlocks();
    expect(u.weapons.suspect_shotgun).toBe(true);
    expect(u.fortify.doorTrap).toBe(true);
    expect(u.allyPolicyCustom).toBe(true);
    expect(u.negotiationCards.threaten).toBe(true);
    expect(getEffectiveSuspectLoadout().allyPolicy).toBe('fortify');

    // Lv.4: suspect_ar, heavy vest, archPlankBarricade
    recordMissionResult({ mode: 'suspect', cleared: true, rank: 'S', score: 300, stageId: 'random_house' }); // 500 XP -> Lv.4
    u = getSuspectUnlocks();
    expect(u.weapons.suspect_ar).toBe(true);
    expect(u.vests.heavy).toBe(true);
    expect(u.fortify.archPlankBarricade).toBe(true);
    expect(u.fortify.archOneWayBarricade).toBe(false);
    expect(getEffectiveSuspectLoadout()).toEqual({
      primaryWeapon: 'suspect_ar',
      vest: 'heavy',
      allyPolicy: 'fortify',
    });

    // Lv.5: archOneWayBarricade, random_embassy
    recordMissionResult({ mode: 'suspect', cleared: true, rank: 'S', score: 300, stageId: 'random_house' }); // 710 XP -> Lv.4
    recordMissionResult({ mode: 'suspect', cleared: true, rank: 'D', score: 100 }); // 820 XP -> Lv.5
    u = getSuspectUnlocks();
    expect(u.fortify.archOneWayBarricade).toBe(true);
    expect(u.stages.random_embassy).toBe(true);
  });
});

describe('SuspectScore calculation and rank thresholds', () => {
  it('computes survival bonus with 5s intervals capped at 60', () => {
    expect(calcSurvivalBonus(0)).toBe(0);
    expect(calcSurvivalBonus(4.9)).toBe(0);
    expect(calcSurvivalBonus(5)).toBe(1);
    expect(calcSurvivalBonus(125)).toBe(25);
    expect(calcSurvivalBonus(300)).toBe(60);
    expect(calcSurvivalBonus(999)).toBe(60);
  });

  it('enforces S/A/B/C/D rank thresholds (S requires victory and >= 0.8 ratio)', () => {
    expect(calcSuspectRank(400, 500, true)).toBe('S');
    expect(calcSuspectRank(400, 500, false)).toBe('A'); // Cannot get S without siege victory
    expect(calcSuspectRank(300, 500, false)).toBe('A'); // 0.60
    expect(calcSuspectRank(200, 500, false)).toBe('B'); // 0.40
    expect(calcSuspectRank(100, 500, false)).toBe('C'); // 0.20
    expect(calcSuspectRank(99, 500, false)).toBe('D'); // < 0.20
  });

  it('computes SuspectScoreSummary and matches SuspectScoreBoard accumulation', () => {
    const summary = computeSuspectScore({
      victory: true,
      swatNeutralized: 4,
      totalSwat: 4,
      survivalSec: 150, // +30
      hostagesUnharmed: 2,
      totalHostages: 2,
      hostagesKilled: 1, // -80
      trapHits: 2, // +80
    });

    const expectedTotal =
      SUSPECT_SCORE_POINTS.siegeVictory +
      4 * SUSPECT_SCORE_POINTS.swatNeutralized +
      2 * SUSPECT_SCORE_POINTS.trapHit +
      2 * SUSPECT_SCORE_POINTS.hostageUnharmed +
      30 +
      SUSPECT_SCORE_POINTS.hostageKilled;

    expect(summary.total).toBe(expectedTotal);
    expect(summary.maxPossibleScore).toBe(4 * 60 + 2 * 35 + 150 + 30); // 490
    expect(summary.rank).toBe('S');

    const board = new SuspectScoreBoard(4, 2);
    board.add('siegeVictory', 'siege', 150);
    for (let i = 0; i < 4; i++) board.add('swatNeutralized', `swat-${i}`, 30 + i * 20);
    board.add('trapHit', 'trap-1', 40);
    board.add('trapHit', 'trap-2', 80);
    board.add('hostageUnharmed', 'h-1', 150);
    board.add('hostageUnharmed', 'h-2', 150);
    board.addSurvivalBonus(150);
    board.add('hostageKilled', 'h-3', 90);

    expect(board.total).toBe(expectedTotal);
    expect(board.count('trapHit')).toBe(2);
    expect(board.count('swatNeutralized')).toBe(4);
    expect(board.rank).toBe('S');
  });
});

describe('Weapon filtering for slot-1 progression safety', () => {
  it('restricts primary weapons to only the selected weapon ID', async () => {
    const { swatWeapons, suspectWeapons } = await import('../../src/modes/SuspectMode');
    const mockDefs = [
      { id: 'rifle', name: 'カービン', category: 'primary', slot: 1, faction: 'swat' },
      { id: 'smg', name: 'SMG', category: 'primary', slot: 1, faction: 'swat' },
      { id: 'shotgun', name: 'ショットガン', category: 'primary', slot: 1, faction: 'swat' },
      { id: 'pepperball', name: 'ペッパー', category: 'nonlethal', slot: 2, faction: 'swat' },
      { id: 'machine_pistol', name: '拳銃', category: 'primary', slot: 1, faction: 'suspect', reserveMagazines: 3 },
      { id: 'suspect_shotgun', name: 'SG', category: 'primary', slot: 1, faction: 'suspect', reserveMagazines: 3 },
    ] as never;

    const swatList = swatWeapons(mockDefs, 'rifle');
    expect(swatList.filter((w) => w.category === 'primary').map((w) => w.id)).toEqual(['rifle']);
    expect(swatList.some((w) => w.id === 'pepperball')).toBe(true);

    const suspectList = suspectWeapons(mockDefs, 5, 'machine_pistol');
    expect(suspectList.map((w) => w.id)).toEqual(['machine_pistol']);
    expect(suspectList[0]!.reserveMagazines).toBe(5);
  });
});
