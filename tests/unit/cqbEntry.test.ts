import { describe, expect, it } from 'vitest';
import {
  assignStackSlots,
  computeEntryOrder,
  cqbPortalFromStackSlotPortal,
  cqbRoomFromRoomDef,
  planEntry,
  toPortalFrame,
  type CqbPortal,
  type CqbRoom,
  type XZ,
} from '../../src/ai/cqbEntry';
import { layoutStackSlots, type StackSlotPortal } from '../../src/ai/stackSlots';
import { HumanoidBody } from '../../src/ai/HumanoidBody';
import type { Vec3 } from '../../src/core/types';

// 南壁 (z=0) 中央のドア。屋内は +z。axis=+x。部屋は x∈[-3,3], z∈[0,6]
const SP: StackSlotPortal = { centerX: 0, centerZ: 0, intoX: 0, intoZ: 1, axisX: 1, axisZ: 0, width: 0.9 };
const portal: CqbPortal = cqbPortalFromStackSlotPortal(SP, 0);
const room: CqbRoom = cqbRoomFromRoomDef({ x: 0, z: 3, width: 6, depth: 6 });
const outsideStandable = (_x: number, z: number): boolean => z < -0.05;
const slots4 = layoutStackSlots(SP, 4, 0.35, 0.6, outsideStandable);

const segCross = (a: XZ, b: XZ, c: XZ, d: XZ): boolean => {
  const cr = (o: XZ, p: XZ, q: XZ): number => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  return cr(c, d, a) * cr(c, d, b) < 0 && cr(a, b, c) * cr(a, b, d) < 0;
};

const inRoom = (p: XZ): boolean =>
  Math.abs(p.x - room.x) <= room.width / 2 && Math.abs(p.z - room.z) <= room.depth / 2;

const openOpts = {
  isStandable: (p: Vec3) => inRoom(p),
  reachable: () => true,
};

describe('cqbEntry.assignStackSlots', () => {
  it('two members approaching from the left do not cross paths to reach L/R slots', () => {
    const slots = slots4.slice(0, 2);
    expect(toPortalFrame(portal, slots[0]!).u).toBeLessThan(0);
    expect(toPortalFrame(portal, slots[1]!).u).toBeGreaterThan(0);
    const members: XZ[] = [
      { x: -3, z: -1 },
      { x: -3.5, z: -2.5 },
    ];
    const a = assignStackSlots(members, slots, portal);
    expect(new Set(a).size).toBe(2);
    expect(a.every((j) => j >= 0)).toBe(true);
    expect(segCross(members[0]!, slots[a[0]!]!, members[1]!, slots[a[1]!]!)).toBe(false);
    // 前にいる者が近い左枠、後ろの者が右枠（追い越さない）
    expect(a).toEqual([0, 1]);
  });

  it('4 members pick the minimum-total-distance assignment', () => {
    // 各枠のすぐ近くに 1 人ずつ（順番はシャッフル）→ 最寄り枠が最小
    const order = [2, 0, 3, 1];
    const members: XZ[] = order.map((j) => ({ x: slots4[j]!.x + 0.12, z: slots4[j]!.z - 0.08 }));
    const a = assignStackSlots(members, slots4, portal);
    expect(a).toEqual(order);

    // 総二乗距離が全順列の最小と一致（ペナルティの掛からない配置）
    const far: XZ[] = [
      { x: -2.2, z: -3.4 },
      { x: 2.0, z: -3.0 },
      { x: -1.8, z: -4.6 },
      { x: 2.4, z: -4.2 },
    ];
    const got = assignStackSlots(far, slots4, portal);
    const cost = (perm: number[]): number =>
      perm.reduce((s, j, i) => s + (far[i]!.x - slots4[j]!.x) ** 2 + (far[i]!.z - slots4[j]!.z) ** 2, 0);
    let best = Infinity;
    const perm = (rest: number[], acc: number[]): void => {
      if (!rest.length) {
        best = Math.min(best, cost(acc));
        return;
      }
      rest.forEach((r, i) => perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, r]));
    };
    perm([0, 1, 2, 3], []);
    expect(cost(got)).toBeCloseTo(best, 6);
  });

  it('returns -1 for members without a slot', () => {
    const a = assignStackSlots([{ x: -1, z: -1 }, { x: 1, z: -1 }, { x: 0, z: -5 }], slots4.slice(0, 2), portal);
    expect(a.filter((j) => j === -1)).toHaveLength(1);
    expect(a[2]).toBe(-1);
  });
});

describe('cqbEntry.planEntry', () => {
  it('order is L0, R0, L1, R1', () => {
    const ranks = computeEntryOrder(portal, slots4);
    const seq = ranks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((r) => `${r.side < 0 ? 'L' : 'R'}${r.rank}`);
    expect(seq).toEqual(['L0', 'R0', 'L1', 'R1']);
    const plans = planEntry(portal, room, slots4, openOpts);
    expect(plans.map((p) => p.order).sort()).toEqual([0, 1, 2, 3]);
    plans.forEach((p, i) => expect(p.order).toBe(ranks[i]!.order));
  });

  it('side-locked: every waypoint lateral sign matches side (or ~0)', () => {
    const plans = planEntry(portal, room, slots4, openOpts);
    for (const [i, p] of plans.entries()) {
      expect(p.side).toBe(toPortalFrame(portal, slots4[i]!).u < 0 ? -1 : 1);
      for (const w of p.waypoints) {
        expect(toPortalFrame(portal, w).u * p.side).toBeGreaterThan(-0.05);
      }
      expect(p.waypoints[p.waypoints.length - 1]).toEqual(p.pod);
    }
  });

  it('PoDs are inside the room and rank0 hugs the entry wall (<= 1.2m)', () => {
    const plans = planEntry(portal, room, slots4, openOpts);
    for (const p of plans) {
      expect(inRoom(p.pod)).toBe(true);
      if (p.rank === 0) {
        expect(toPortalFrame(portal, p.pod).v).toBeLessThanOrEqual(1.2);
        // ボタンフック: 敷居点 + 壁沿い点 + PoD
        expect(p.waypoints).toHaveLength(3);
        // 視線は対角（反対サイド）の奥
        const look = toPortalFrame(portal, p.look);
        expect(look.u * p.side).toBeLessThan(0);
        expect(look.v).toBeGreaterThan(4);
      } else {
        expect(p.waypoints).toHaveLength(2);
      }
    }
    // PoD 同士は重ならない
    for (let i = 0; i < plans.length; i++) {
      for (let j = i + 1; j < plans.length; j++) {
        expect(Math.hypot(plans[i]!.pod.x - plans[j]!.pod.x, plans[i]!.pod.z - plans[j]!.pod.z)).toBeGreaterThan(0.5);
      }
    }
  });

  it('shrinks toward the door axis when the corner is not standable', () => {
    const plans = planEntry(portal, room, slots4, {
      isStandable: (p) => inRoom(p) && Math.abs(p.x) < 1.5,
      reachable: () => true,
    });
    for (const p of plans) {
      const { u } = toPortalFrame(portal, p.pod);
      expect(Math.abs(u)).toBeLessThan(1.5);
      expect(u * p.side).toBeGreaterThan(0);
    }
  });

  it('honors reachable() from the previous waypoint', () => {
    // 壁沿い点 → コーナー PoD の直線が通れない（u>1.6 へは到達不可）
    const plans = planEntry(portal, room, slots4, {
      isStandable: (p) => inRoom(p),
      reachable: (_a, b) => Math.abs(b.x) <= 1.6,
    });
    for (const p of plans) {
      for (const w of p.waypoints) expect(Math.abs(w.x)).toBeLessThanOrEqual(1.6 + 1e-9);
    }
  });

  it('uses fallbackPods when every candidate fails', () => {
    const fallbackPods: Vec3[] = [
      { x: -1, y: 0, z: 2 },
      { x: 1, y: 0, z: 2 },
      { x: -0.5, y: 0, z: 3 },
      { x: 0.5, y: 0, z: 3 },
    ];
    const plans = planEntry(portal, room, slots4, {
      isStandable: () => false,
      reachable: () => false,
      fallbackPods,
    });
    const used = plans.map((p) => fallbackPods.findIndex((f) => f.x === p.pod.x && f.z === p.pod.z));
    expect(used.every((i) => i >= 0)).toBe(true);
    expect(new Set(used).size).toBe(4);
  });

  it('narrow room (halfL < 0.5) skips the wall waypoint for rank0', () => {
    const narrow = cqbRoomFromRoomDef({ x: 0, z: 3, width: 2, depth: 6 }); // halfL = 1 - 0.65 = 0.35
    const plans = planEntry(portal, narrow, slots4, {
      isStandable: (p) => Math.abs(p.x) <= 1 && p.z >= 0 && p.z <= 6,
      reachable: () => true,
    });
    for (const p of plans) if (p.rank === 0) expect(p.waypoints).toHaveLength(2);
  });

  it('single-side stack becomes a file (ranks 0..n-1 on one side)', () => {
    const leftOnly = layoutStackSlots(SP, 3, 0.35, 0.6, (x, z) => z < -0.05 && x < 0);
    const ranks = computeEntryOrder(portal, leftOnly);
    expect(ranks.every((r) => r.side === -1)).toBe(true);
    expect(ranks.map((r) => r.rank).sort()).toEqual([0, 1, 2]);
    expect(ranks.map((r) => r.order).sort()).toEqual([0, 1, 2]);
  });
});

describe('HumanoidBody smoothing', () => {
  const yawOf = (b: HumanoidBody): number => b.yawRad;

  it('multiple faceToward calls in one frame share a 5*dt turn budget (and respect maxTurn)', () => {
    const b = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
    const dt = 1 / 60;
    b.tick(dt);
    const y0 = yawOf(b);
    for (let i = 0; i < 5; i++) b.faceToward(5, 0);
    expect(Math.abs(yawOf(b) - y0)).toBeLessThanOrEqual(5 * dt + 1e-9);
    b.tick(dt);
    const y1 = yawOf(b);
    b.faceToward(5, 0, 0.01);
    b.faceToward(5, 0, 0.01);
    expect(Math.abs(yawOf(b) - y1)).toBeLessThanOrEqual(0.02 + 1e-9);
    b.dispose();
  });

  it('aimAt head yaw is continuous across the 0.5 rad neck boundary', () => {
    const b = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
    const head = (b as unknown as { headPivot: { rotation: { y: number } } }).headPivot;
    // 体を回さないよう maxTurn=0 で、ターゲットを境界付近で掃引
    let prev: number | null = null;
    for (let a = 0.3; a <= 0.7; a += 0.01) {
      // yaw=0 の正面は -Z。bearing=a となる点。収束するまで繰り返す
      for (let k = 0; k < 60; k++) b.aimAt(-Math.sin(a) * 5, 1.5, -Math.cos(a) * 5, 0.05, 0);
      const h = head.rotation.y;
      if (prev !== null) expect(Math.abs(h - prev)).toBeLessThan(0.02);
      prev = h;
    }
    expect(prev).toBeCloseTo(0.5, 2);
    expect(Math.abs(b.yawRad)).toBeLessThan(1e-9);
    b.dispose();
  });

  it('setPosition(countTravel=false) and sub-deadzone travel do not drive the stride', () => {
    const b = new HumanoidBody(0, 0, 0, 0x2b3440, true, { role: 'ally' });
    const stride = (): number => (b as unknown as { stride: number }).stride;
    const dt = 1 / 60;
    b.tick(dt);
    for (let i = 0; i < 30; i++) {
      b.setPosition(b.px + 0.02, b.pz, undefined, false);
      b.tick(dt);
    }
    expect(stride()).toBe(0);
    for (let i = 0; i < 30; i++) {
      b.setPosition(b.px + 0.003, b.pz);
      b.tick(dt);
    }
    expect(stride()).toBe(0);
    for (let i = 0; i < 30; i++) {
      b.setPosition(b.px + 0.02, b.pz);
      b.tick(dt);
    }
    expect(stride()).toBeGreaterThan(0.3);
    b.dispose();
  });
});
