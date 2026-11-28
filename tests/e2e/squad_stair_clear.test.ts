import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapData } from '../../src/core/types';
import type { StairMark } from '../../src/world/Walk';
import { stairExitFloorY } from '../../src/ai/squad/squadStairs';
import { blockedAt } from '../../src/ai/EngageBehavior';
import { createSquadHarness, generateRealMap, type SquadHarness } from './helpers/squadSimDriver';

/**
 * 階段クリア（他エリアのオープン&クリアと同じく、階段を見て指示する）。
 * 実際に生成した 2 階建ての家で、階段口スタック → 縦列で昇降 → 出口確保まで通す。
 */
const active: SquadHarness[] = [];
afterEach(() => {
  while (active.length > 0) active.pop()!.dispose();
  vi.restoreAllMocks();
});

/** 1F→2F の階段がある家のシードを探す */
function findHouseWithStair(): { map: MapData; stair: StairMark } {
  for (let seed = 1; seed < 80; seed++) {
    const map = generateRealMap('house', seed);
    const probe = createSquadHarness({ map, allies: [], entities: [] });
    const stair = probe.world.stairs.find((s) => Math.abs(s.baseY) < 0.1 && s.topY > 2);
    probe.dispose();
    if (stair) return { map, stair };
  }
  throw new Error('no two-story house with a stair found');
}

function setup(allyCount = 3) {
  const { map, stair } = findHouseWithStair();
  // 階段の手前（進入点の 2m 手前）に隊員とプレイヤーを置き、階段の中ほどを見る
  const dx = stair.highX - stair.lowX;
  const dz = stair.highZ - stair.lowZ;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  // 隊員は階段の手前に縦に、プレイヤーはその横（階段室の壁の内側）に置く
  const base = { x: stair.approachLow.x - ux * 0.9, z: stair.approachLow.z - uz * 0.9 };
  const allies = Array.from({ length: allyCount }, (_, i) => ({
    id: `ally_${i + 1}`,
    name: ['Miller', 'Vance', 'Cole', 'Reeves'][i]!,
    x: base.x - ux * 0.6 * i,
    y: 0,
    z: base.z - uz * 0.6 * i,
    yaw: 0,
  }));
  const h = createSquadHarness({
    map,
    allies,
    entities: [],
    playerPos: { x: stair.approachLow.x - ux * 2.2 - uz * 1.0, y: 0, z: stair.approachLow.z - uz * 2.2 + ux * 1.0 },
  });
  active.push(h);
  const stairOnWorld = h.world.stairs.find((s) => s.id === stair.id)!;
  const aimAtStair = (): void => {
    h.doors.setAimedDoor(null);
    h.player.aimAt({
      x: (stairOnWorld.lowX + stairOnWorld.highX) / 2,
      y: (stairOnWorld.baseY + stairOnWorld.topY) / 2 + 0.45,
      z: (stairOnWorld.lowZ + stairOnWorld.highZ) / 2,
    });
  };
  return { h, stair: stairOnWorld, aimAtStair };
}

describe('階段クリア（実機）', () => {
  it('階段を見ると照準対象が階段（上り）になり、メニューに階段クリアが出る', () => {
    const { h, stair, aimAtStair } = setup();
    aimAtStair();
    const ctx = h.squad.menu.resolveContext('gold');
    expect(ctx.stairTarget?.stair.id).toBe(stair.id);
    expect(ctx.stairTarget?.up).toBe(true);
  });

  it('階段クリア: 階段口でスタック → 縦列で上り → 上階の階段口を全員で確保（報告あり）', () => {
    const { h, stair, aimAtStair } = setup();
    aimAtStair();
    const ctx = h.squad.menu.resolveContext('gold');
    const radios: string[] = [];
    h.bus.on('allyRadio', (e) => radios.push(e.text));
    h.squad.executeOrder('stairClear', ctx);
    for (const a of h.squad.allies) {
      expect(a.order).toBe('stairClear');
      expect(a.phase).toBe('stair_stack');
    }

    // 昇降中は、先に出た隊員から間隔を空けて発進する（同時に段へ殺到しない）
    let sawFile = false;
    for (let i = 0; i < 400; i++) {
      h.step(0.1);
      const climbing = h.squad.allies.filter((a) => a.phase === 'stair_climb');
      const started = climbing.filter((a) => a.stairStartT >= 0).length;
      if (climbing.length >= 2 && started >= 1 && started < climbing.length) sawFile = true;
      if (h.squad.allies.every((a) => a.phase === 'stair_secure')) break;
    }
    expect(sawFile).toBe(true);
    const topY = stairExitFloorY(stair, true);
    for (const a of h.squad.allies) {
      expect(a.phase).toBe('stair_secure');
      expect(Math.abs(a.body.footY - topY)).toBeLessThan(0.4);
    }
    // 確保位置は重ならない（扇状に展開）
    const ps = h.squad.allies.map((a) => a.body);
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        expect(Math.hypot(ps[i]!.px - ps[j]!.px, ps[i]!.pz - ps[j]!.pz)).toBeGreaterThan(0.35);
      }
    }
    h.step(3); // 無線は間隔を空けて流れる
    expect(radios.some((r) => /階段上クリア|上の階口クリア/.test(r)), radios.join(' / ')).toBe(true);
  });

  it('フラッシュ＆階段クリア: 閃光弾を 1 発使い、炸裂してから上る', () => {
    const { h, aimAtStair } = setup(2);
    aimAtStair();
    const ctx = h.squad.menu.resolveContext('gold');
    const before = h.squad.getGear().flash;
    let detonatedAt = -1;
    let t = 0;
    h.bus.on('flashDetonated', () => {
      if (detonatedAt < 0) detonatedAt = t;
    });
    h.squad.executeOrder('stairFlashClear', ctx);
    let firstStartAt = -1;
    for (let i = 0; i < 400; i++) {
      h.step(0.1);
      t += 0.1;
      if (firstStartAt < 0 && h.squad.allies.some((a) => a.stairStartT >= 0)) firstStartAt = t;
      if (h.squad.allies.every((a) => a.phase === 'stair_secure')) break;
    }
    expect(h.squad.getGear().flash).toBe(before - 1);
    expect(detonatedAt).toBeGreaterThan(0);
    expect(firstStartAt).toBeGreaterThanOrEqual(detonatedAt);
    for (const a of h.squad.allies) expect(a.phase).toBe('stair_secure');
  });

  it('スタックのみ: 階段口で待機し、上らない', () => {
    const { h, stair, aimAtStair } = setup(2);
    aimAtStair();
    const ctx = h.squad.menu.resolveContext('gold');
    h.squad.executeOrder('stack', ctx);
    h.step(12);
    for (const a of h.squad.allies) {
      expect(a.phase).toBe('stair_stack');
      expect(Math.abs(a.body.footY - stair.baseY)).toBeLessThan(0.3);
    }
  });

  it('上階から見下ろすと照準対象は階段（下り）になる', () => {
    const { h, stair } = setup(1);
    const dx = stair.highX - stair.lowX;
    const dz = stair.highZ - stair.lowZ;
    const len = Math.hypot(dx, dz);
    h.player.position.set(stair.approachHigh.x + (dx / len) * 1.2, stair.topY, stair.approachHigh.z + (dz / len) * 1.2);
    h.player.aimAt({
      x: (stair.lowX + stair.highX) / 2,
      y: (stair.baseY + stair.topY) / 2 + 0.45,
      z: (stair.lowZ + stair.highZ) / 2,
    });
    const ctx = h.squad.menu.resolveContext('gold');
    expect(ctx.stairTarget?.stair.id).toBe(stair.id);
    expect(ctx.stairTarget?.up).toBe(false);
  });

  it('容疑者: 下の階の物音を聞くと、上階の階段口（上り切った所）へ照準を置いて待ち伏せる', () => {
    const { map, stair } = findHouseWithStair();
    const room = map.rooms.find(
      (r) =>
        !r.outdoor &&
        Math.abs((r.floorY ?? 0) - stair.topY) < 0.75 &&
        Math.abs(stair.approachHigh.x - r.x) <= r.width / 2 &&
        Math.abs(stair.approachHigh.z - r.z) <= r.depth / 2,
    );
    expect(room).toBeTruthy();
    const probe = createSquadHarness({ map, allies: [], entities: [] });
    // 上階の階段口から 2〜4m 離れた立てる位置
    let spot: { x: number; z: number } | null = null;
    for (let r = 2.5; r <= 4.5 && !spot; r += 0.5) {
      for (let k = 0; k < 16 && !spot; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = stair.approachHigh.x + Math.cos(a) * r;
        const z = stair.approachHigh.z + Math.sin(a) * r;
        if (Math.abs(x - room!.x) > room!.width / 2 - 0.4 || Math.abs(z - room!.z) > room!.depth / 2 - 0.4) continue;
        if (!blockedAt(probe.colliders, x, z, 0.35, stair.topY)) spot = { x, z };
      }
    }
    probe.dispose();
    expect(spot).toBeTruthy();
    const h = createSquadHarness({
      map,
      allies: [],
      entities: [{ id: 'sus_top', type: 'suspect', x: spot!.x, z: spot!.z, y: stair.topY, yaw: 0, profile: 'hardcore_leader', hp: 100 }],
      playerPos: { x: stair.approachLow.x, y: 0, z: stair.approachLow.z },
    });
    active.push(h);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const sus = h.entities.suspects.get('sus_top')!;
    sus.onHeardNoise({ x: stair.approachLow.x, y: 0, z: stair.approachLow.z }, 'footstep', 'player');
    const target = sus.ambushTarget;
    expect(target?.doorwayId).toBe(`stair:${stair.id}:top`);
    expect(Math.abs(target!.aim.y - (stair.topY + 1.1))).toBeLessThan(0.05);
  });
});
