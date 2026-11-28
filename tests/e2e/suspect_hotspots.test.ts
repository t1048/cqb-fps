import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareSuspectMode } from '../../src/modes/SuspectMode';
import { generateRealMap, makeSingleRoomMap, makeTwoDoorHouseMap } from './helpers/headlessWorld';
import { createSwatHarness, type SwatHarness } from './helpers/simDriver';
import { seedRandom } from './helpers/seededRandom';

const active: SwatHarness[] = [];
// SWAT の反応（撃たれた直後に突撃するか・どの対抗策を選ぶか）は乱数で分かれる。
// 乱数を固定し、狙った分岐（ホットスポットへの対抗策）を毎回同じに検証する
beforeEach(() => {
  seedRandom(1);
});
afterEach(() => {
  while (active.length) active.pop()!.dispose();
  vi.restoreAllMocks();
});

/** 南北 2 室 + 間仕切りの扉(door_mid)。SWAT は南室、プレイヤーは扉の向こう（北室） */
function dividerSetup(): SwatHarness {
  const h = createSwatHarness({
    map: makeTwoDoorHouseMap({ includeInteriorDivider: true }),
    spawns: [
      { x: -3, y: 0, z: 3.4 },
      { x: -1.5, y: 0, z: 3.4 },
      { x: 1.5, y: 0, z: 3.4 },
      { x: 3, y: 0, z: 3.4 },
    ],
    count: 4,
    playerPos: { x: 4.2, y: 0, z: -4.2 },
    startAssault: false,
  });
  active.push(h);
  return h;
}

/** 準備中にプレイヤーが扉を半開きにしておき、突入開始（SWAT は南室の掃討から始める） */
function openGap(h: SwatHarness): void {
  const door = h.hw.doorSystem.doors.find((d) => d.id === 'door_mid')!;
  door.command(25, true, 4, -4);
  h.step(1.5, 0.05);
  expect(door.angle).toBeGreaterThan(10);
  expect(door.angle).toBeLessThan(40);
  h.team.beginAssault();
  h.step(0.1, 0.05);
}

function shootThroughGap(h: SwatHarness, victimIndex = 1): void {
  const victim = h.team.hunters[victimIndex]!;
  h.player.moveTo(0.15, 0, -1.6);
  h.bus.emit('entityHit', {
    targetId: victim.id,
    shooter: 'player',
    damage: 8,
    pos: { x: victim.body.px, y: 1.2, z: victim.body.pz },
  });
}

describe('Suspect mode: SWAT learn from where they are shot (anti door-gap camping)', () => {
  it('records a hot spot at the door gap when an unaware officer is shot through it, and radios it', () => {
    const h = dividerSetup();
    openGap(h);
    // チームはプレイヤーを見ていない状態での不意打ち
    const victim = h.team.hunters[1]!;
    victim.body.setPosition(0.4, 3.6, 0);
    h.recorder.clear();
    shootThroughGap(h, 1);
    const spots = h.team.hotSpotMemory.spots;
    expect(spots).toHaveLength(1);
    expect(spots[0]!.portal?.kind).toBe('door');
    expect(spots[0]!.portal?.id).toBe('door_mid');
    expect(spots[0]!.hits).toBe(1);
    h.step(3, 0.05);
    const lines = h.recorder.of('allyRadio').map((e) => e.payload.voiceText);
    expect(lines.some((l) => /gap|door/i.test(l))).toBe(true);
  });

  it('does not learn from a face-to-face fight (the officer already saw the shooter)', () => {
    const h = dividerSetup();
    openGap(h);
    const victim = h.team.hunters[1]!;
    victim.sees = true;
    shootThroughGap(h, 1);
    expect(h.team.hotSpotMemory.spots).toHaveLength(0);
  });

  it('approaching a known hot spot triggers a countermeasure and pre-aims the gap instead of a naked peek', () => {
    const h = dividerSetup();
    openGap(h);
    h.team.hunters[1]!.body.setPosition(0.4, 3.6, 0);
    shootThroughGap(h, 1);
    // 隊員が扉に近づく
    for (const u of h.team.hunters) {
      if (u.alive) u.body.setPosition(u.body.px * 0.3, 3.2, 0);
    }
    let sawPreAim = false;
    let sawHold = false;
    for (let i = 0; i < 160; i++) {
      h.step(0.05, 0.05);
      for (const u of h.team.hunters) {
        if (u.alive && u.preAim) sawPreAim = true;
        if (u.alive && u.hotHold) sawHold = true;
      }
    }
    expect(h.team.hotSpotTacticLog.length).toBeGreaterThan(0);
    expect(sawPreAim).toBe(true);
    // 閃光・制圧・盾先行・挟撃のいずれかを選んだときは、待機でのぞき位置に出ない
    const tactic = h.team.hotSpotTacticLog[0]!;
    if (tactic !== 'slice') expect(sawHold).toBe(true);
  });

  it('a pre-aimed officer reacts to a target appearing in the aimed spot much faster', () => {
    const timeToEngage = (preAim: boolean): number => {
      const h = createSwatHarness({
        map: makeSingleRoomMap({ includeCover: false }),
        spawns: [{ x: 0, y: 0, z: 3 }],
        count: 1,
        playerPos: { x: 0, y: 0, z: -2.5 },
        startAssault: false,
      });
      active.push(h);
      h.team.reactionSec = 0.6;
      const hunter = h.team.hunters[0]!;
      hunter.body.faceToward(0, -2.5);
      h.team.beginAssault();
      hunter.setState('sweep');
      if (preAim) hunter.preAim = { pos: { x: 0, y: 0, z: -2.5 }, until: 99 };
      let t = 0;
      while (t < 3 && hunter.state !== 'engage') {
        h.team.reactionSec = 0.6; // 圧力による短縮を無効にして比較する
        h.step(0.05, 0.05);
        t += 0.05;
      }
      return t;
    };
    const plain = timeToEngage(false);
    const aimed = timeToEngage(true);
    expect(plain).toBeGreaterThan(0.5);
    expect(aimed).toBeLessThan(0.3);
  });

  it('officers pre-aim a merely half-open door they are about to cross (suspicious gap)', () => {
    const h = dividerSetup();
    openGap(h);
    // 近づいている隊員がいて、ドアが半開きのまま静止し続ける
    for (const u of h.team.hunters) u.body.setPosition(u.body.px * 0.3, 2.6, 0);
    let suspicious = false;
    for (let i = 0; i < 200 && !suspicious; i++) {
      h.step(0.05, 0.05);
      if (h.team.hotSpotMemory.spots.some((s) => s.suspicion && s.portal?.id === 'door_mid')) suspicious = true;
    }
    expect(suspicious).toBe(true);
  });

  it('stairwell: shot from the top landing, officers flash the stairwell before climbing', () => {
    const setup = prepareSuspectMode(generateRealMap('house_compact', 1));
    const stair = setup.map.stairs[0]!;
    const h = createSwatHarness({
      map: setup.map,
      spawns: setup.swatSpawns,
      count: 4,
      playerPos: { x: 30, y: 0, z: 30 },
      startAssault: false,
    });
    active.push(h);
    h.team.beginAssault();
    const low = h.hw.world.stairs.find((m) => m.id === stair.id)!;
    // 隊員は階段の下の踊り場へ。全員掃討状態にして接近させる
    h.team.hunters.forEach((u, i) => {
      u.body.setPosition(low.approachLow.x - 1.4 - i * 0.5, low.approachLow.z + (i % 2 ? 0.6 : -0.6), 0);
      u.setState('sweep');
    });
    h.step(3.5, 0.05);
    const victim = h.team.hunters[1]!;
    h.player.moveTo(low.approachHigh.x, low.topY, low.approachHigh.z);
    h.bus.emit('entityHit', {
      targetId: victim.id,
      shooter: 'player',
      damage: 6,
      pos: { x: victim.body.px, y: 1.2, z: victim.body.pz },
    });
    const spot = h.team.hotSpotMemory.spots[0];
    expect(spot).toBeDefined();
    expect(spot!.portal?.kind).toBe('stair');
    expect(spot!.portal?.id).toBe(stair.id);
    h.player.moveTo(30, 0, 30);
    h.recorder.clear();
    h.step(4, 0.05);
    expect(h.team.hotSpotTacticLog[0]).toBe('flash');
    expect(h.recorder.of('flashDetonated').some((e) => e.payload.thrower?.startsWith('swat_'))).toBe(true);
  });
});
