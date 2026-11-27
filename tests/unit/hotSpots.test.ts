import { describe, expect, it } from 'vitest';
import {
  HOT_SPOT_TTL_SEC,
  HotSpotMemory,
  chooseHotTactics,
  findShotPortal,
  type DoorLike,
  type HotTacticContext,
} from '../../src/ai/hotSpots';
import type { StairMark } from '../../src/world/Walk';

const door = (over: Partial<DoorLike> = {}): DoorLike => ({
  id: 'door_a',
  centerX: 0,
  centerZ: 0,
  sillY: 0,
  angle: 20,
  maxAngle: 100,
  locked: false,
  ...over,
});

describe('findShotPortal', () => {
  it('finds the half-open door the shot passed through', () => {
    const p = findShotPortal({ x: 0.2, y: 0, z: -3 }, { x: 0, y: 0, z: 3 }, [door()], [], []);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('door');
    expect(p!.id).toBe('door_a');
    expect(p!.partial).toBe(true);
  });

  it('ignores closed / locked doors and doors off the line of fire', () => {
    expect(findShotPortal({ x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 3 }, [door({ angle: 0 })], [], [])).toBeNull();
    expect(findShotPortal({ x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 3 }, [door({ locked: true })], [], [])).toBeNull();
    expect(findShotPortal({ x: 5, y: 0, z: -3 }, { x: 5, y: 0, z: 3 }, [door()], [], [])).toBeNull();
  });

  it('picks the portal closest to the shooter when several are on the line', () => {
    const near = door({ id: 'near', centerZ: -2 });
    const far = door({ id: 'far', centerZ: 2 });
    const p = findShotPortal({ x: 0, y: 0, z: -4 }, { x: 0, y: 0, z: 4 }, [far, near], [], []);
    expect(p!.id).toBe('near');
  });

  it('recognises an interior window opening', () => {
    const p = findShotPortal(
      { x: 0, y: 0, z: -3 },
      { x: 0, y: 0, z: 3 },
      [],
      [{ x: 0, z: 0, yaw: 0, width: 1.4, height: 1.1, sill: 0.9, interior: true }],
      [],
    );
    expect(p!.kind).toBe('window');
  });

  it('blames the stairwell when shot from another floor', () => {
    const stair: StairMark = {
      id: 'core_1F_2F',
      lowX: 0,
      lowZ: 0,
      lowY: 0.2,
      highX: 5,
      highZ: 0,
      highY: 3,
      baseY: 0,
      topY: 3,
      approachLow: { x: -0.6, z: 0 },
      approachHigh: { x: 5.6, z: 0 },
    };
    const p = findShotPortal({ x: 5.5, y: 3, z: 0 }, { x: 0, y: 0, z: 0.5 }, [], [], [stair]);
    expect(p!.kind).toBe('stair');
    expect(p!.id).toBe('core_1F_2F');
    // 射手は上階側 → 開口は上端
    expect(p!.pos.y).toBe(3);
  });
});

describe('HotSpotMemory', () => {
  it('merges repeated reports from the same gap and counts hits / downs', () => {
    const m = new HotSpotMemory();
    const portal = { kind: 'door' as const, id: 'door_a', pos: { x: 0, y: 0, z: 0 }, partial: true };
    const a = m.record({ x: 1, y: 0, z: 1 }, portal, 10, false);
    const b = m.record({ x: 1.4, y: 0, z: 1.2 }, portal, 20, true);
    expect(b).toBe(a);
    expect(m.spots).toHaveLength(1);
    expect(a.hits).toBe(2);
    expect(a.downs).toBe(1);
    expect(a.at).toBe(20);
  });

  it('keeps distinct gaps apart and forgets stale ones', () => {
    const m = new HotSpotMemory();
    m.record({ x: 0, y: 0, z: 0 }, null, 0, false);
    m.record({ x: 10, y: 0, z: 0 }, null, 100, false);
    expect(m.spots).toHaveLength(2);
    m.prune(HOT_SPOT_TTL_SEC + 5);
    expect(m.spots).toHaveLength(1);
    expect(m.spots[0]!.pos.x).toBe(10);
  });

  it('a suspicion (half-open door) does not count as a hit, and becomes real when shot from', () => {
    const m = new HotSpotMemory();
    const portal = { kind: 'door' as const, id: 'd', pos: { x: 0, y: 0, z: 0 }, partial: true };
    const s = m.record(portal.pos, portal, 1, false, true);
    expect(s.hits).toBe(0);
    expect(s.suspicion).toBe(true);
    const again = m.record({ x: 0.5, y: 0, z: 1 }, portal, 5, false);
    expect(again).toBe(s);
    expect(s.hits).toBe(1);
    expect(s.suspicion).toBe(false);
  });

  it('near() looks up by the portal position', () => {
    const m = new HotSpotMemory();
    m.record({ x: 3, y: 0, z: 3 }, { kind: 'door', id: 'd', pos: { x: 0, y: 0, z: 0 }, partial: false }, 0, false);
    expect(m.near({ x: 1, y: 0, z: 0 }, 3, 1)).not.toBeNull();
    expect(m.near({ x: 9, y: 0, z: 0 }, 3, 1)).toBeNull();
  });
});

describe('chooseHotTactics', () => {
  const base: HotTacticContext = {
    kind: 'door',
    pressure: 0.3,
    flashAvailable: true,
    gasAvailable: true,
    hasShield: true,
    hasAltRoute: true,
    hits: 1,
    downs: 0,
    treated: 0,
    suspicion: false,
  };

  it('never repeats the naked peek: the pre-aim slice is the weakest option once real hits exist', () => {
    const order = chooseHotTactics(base);
    expect(order[0]).not.toBe('slice');
    expect(order).toContain('slice');
  });

  it('flashes a stairwell first and sends the shield first when out of flashes', () => {
    expect(chooseHotTactics({ ...base, kind: 'stair' })[0]).toBe('flash');
    const noFlash = chooseHotTactics({ ...base, kind: 'stair', flashAvailable: false });
    expect(noFlash[0]).toBe('shield');
    expect(noFlash).not.toContain('gas');
    expect(noFlash).not.toContain('pincer');
  });

  it('only offers what the team can actually do', () => {
    const o = chooseHotTactics({ ...base, flashAvailable: false, gasAvailable: false, hasShield: false, hasAltRoute: false });
    expect(o).not.toContain('flash');
    expect(o).not.toContain('gas');
    expect(o).not.toContain('shield');
    expect(o).not.toContain('pincer');
    expect(o).toContain('suppress');
    expect(o).toContain('slice');
  });

  it('escalates to gas / pincer after repeated losses at the same gap', () => {
    const heavy = chooseHotTactics({ ...base, hits: 3, downs: 2, treated: 2, flashAvailable: false });
    expect(['gas', 'pincer']).toContain(heavy[0]);
  });

  it('treats a merely suspicious half-open door lightly', () => {
    const o = chooseHotTactics({ ...base, suspicion: true, pressure: 0.1 });
    expect(o[0]).toBe('shield');
    expect(o).not.toContain('gas');
    expect(o).not.toContain('suppress');
    expect(o).not.toContain('pincer');
    expect(chooseHotTactics({ ...base, suspicion: true, pressure: 0.1, hasShield: false })[0]).toBe('slice');
  });
});
