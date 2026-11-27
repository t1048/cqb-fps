import { expect, vi } from 'vitest';
import { prepareSuspectMode } from '../../../src/modes/SuspectMode';
import type { MapData, RoomDef } from '../../../src/core/types';
import { blockedAtFiltered, reachableRouteLength } from '../../../src/ai/SquadRoute';
import { hasLineOfSight } from '../../../src/weapons/Flashbang';
import { generateRealMap } from './headlessWorld';
import { createSwatHarness, type SwatHarness } from './simDriver';

/**
 * 容疑者モードの「SWAT が止まらず進む」検証ハーネス。
 * 受け身の容疑者が、突入地点から最も遠い（扉でしか出入りできない）部屋に籠もり、
 * その部屋の扉をすべて施錠した状態で、SWAT が（ブリーチして）部屋を順に掃討し辿り着けるかを固定 dt で回す。
 */
export type Tpl = 'house_compact' | 'house' | 'embassy';

/** 決定論的なシード。単層 / B1 / 2F / 3 層・階段コア 1〜2 基を各ジェネレータで混ぜてある */
export const CASES: Record<Tpl, number[]> = {
  house_compact: [1, 3, 7, 10, 13, 17, 20, 30],
  house: [3, 9, 12, 16, 5, 24, 28, 31],
  embassy: [2, 4, 9, 12, 5, 10, 24, 33],
};
/** 容疑者の部屋に辿り着く（または視認する）までの許容秒数。小・中は 150 秒、大使館は 200 秒 */
export const CONTACT_LIMIT: Record<Tpl, number> = { house_compact: 150, house: 150, embassy: 200 };
export const HOLD_SEC = 240;
export const DT = 0.05;
/** 交戦・ブリーチ・突入手順の最中を除いて、進捗（確認済みマス・クリア部屋・解錠ドア）が止まってよい上限 */
export const STALL_WINDOW_SEC = 20;

const TRACE = !!process.env.PROGRESS_TRACE;

function doorsOfRoom(map: MapData, r: RoomDef): string[] {
  const fy = r.floorY ?? 0;
  return map.doors
    .filter((d) => {
      const sill = d.y ?? 0;
      return (
        Math.abs(sill - fy) < 1 &&
        Math.abs(d.x - r.x) <= r.width / 2 + 0.35 &&
        Math.abs(d.z - r.z) <= r.depth / 2 + 0.35 &&
        (Math.abs(Math.abs(d.x - r.x) - r.width / 2) < 0.6 || Math.abs(Math.abs(d.z - r.z) - r.depth / 2) < 0.6)
      );
    })
    .map((d) => d.id);
}

/** 外窓・室内窓口がある部屋は、窓越しの視線で扉を破らずに接触できてしまう */
function hasWindow(map: MapData, r: RoomDef): boolean {
  return (map.windows ?? []).some(
    (w) =>
      Math.abs((w.y ?? 0) - (r.floorY ?? 0)) < 1 &&
      Math.abs(w.x - r.x) <= r.width / 2 + 0.6 &&
      Math.abs(w.z - r.z) <= r.depth / 2 + 0.6,
  );
}

/** 階段室（吹き抜け）は上下階から丸見えになる */
function hasStairs(map: MapData, r: RoomDef): boolean {
  return map.stairs.some(
    (st) => Math.abs(st.x - r.x) <= r.width / 2 + 3 && Math.abs(st.z - r.z) <= r.depth / 2 + 3,
  );
}

const NO_DOORS = new Set<never>();
/** 部屋の外周 1m 外の屋内点へ、扉を通らずに歩いて出られない（= 出入りに必ず扉が要る）か */
function isSealed(h: SwatHarness, r: RoomDef, indoor: readonly RoomDef[]): boolean {
  const fy = r.floorY ?? 0;
  const from = { x: r.x, z: r.z };
  if (blockedAtFiltered(h.hw.colliders, from.x, from.z, 0.3, fy)) return false;
  const pts: { x: number; z: number }[] = [];
  for (let k = -2; k <= 2; k++) {
    const fx = (k / 2.5) * (r.width / 2);
    const fz = (k / 2.5) * (r.depth / 2);
    pts.push({ x: r.x + fx, z: r.z - r.depth / 2 - 1 }, { x: r.x + fx, z: r.z + r.depth / 2 + 1 });
    pts.push({ x: r.x - r.width / 2 - 1, z: r.z + fz }, { x: r.x + r.width / 2 + 1, z: r.z + fz });
  }
  for (const p of pts) {
    if (!indoor.some((o) => o !== r && Math.abs((o.floorY ?? 0) - fy) < 0.5 && Math.abs(p.x - o.x) < o.width / 2 && Math.abs(p.z - o.z) < o.depth / 2)) continue;
    if (reachableRouteLength(from, p, fy, h.hw.colliders, h.hw.bounds, 0.3, NO_DOORS) !== null) return false;
  }
  return true;
}

const eyeTmp = { x: 0, y: 0, z: 0 };
/** 生存中の隊員の誰かがプレイヤーを直接視認できる（同階・14m 以内・遮るものなし） */
function seesPlayer(h: SwatHarness): boolean {
  const pe = h.player.getEyePosition();
  for (const u of h.team.hunters) {
    if (!u.alive) continue;
    if (Math.abs(u.body.footY - h.player.position.y) > 1) continue;
    if (Math.hypot(u.body.px - pe.x, u.body.pz - pe.z) > 14) continue;
    eyeTmp.x = u.body.px;
    eyeTmp.y = u.body.footY + 1.5;
    eyeTmp.z = u.body.pz;
    if (hasLineOfSight(h.hw.colliders, eyeTmp, { x: pe.x, y: pe.y, z: pe.z })) return true;
  }
  return false;
}

export interface RunResult {
  seeSec: number | null;
  reachSec: number | null;
  breached: number;
  lockedAround: number;
  /** 0 = 封鎖・窓なし・階段室でない理想の籠城部屋、大きいほど条件が緩い */
  tier: number;
  longestStall: number;
  stallAt: number;
  floors: string;
  roomsTotal: number;
  roomsCleared: number;
  roomId: string;
}

export function runSuspectProgress(tpl: Tpl, seed: number): { result: RunResult; dispose: () => void } {
  const raw = generateRealMap(tpl, seed);
  const entry = raw.playerSpawn;
  const setup = prepareSuspectMode(raw);
  const map = setup.map;
  const indoor = map.rooms.filter((r) => !r.outdoor);
  const h = createSwatHarness({
    map,
    spawns: setup.swatSpawns,
    count: Math.max(2, Math.min(4, setup.swatCount)),
    playerHp: 1e9,
    startAssault: false,
  });
  // 籠城部屋: 突入地点から最も遠い（階が違えば更に遠い）。理想条件を満たす部屋が無ければ条件を緩める
  const ranked = indoor
    .filter((r) => doorsOfRoom(map, r).length > 0)
    .map((r) => ({ r, d: Math.hypot(r.x - entry.x, r.z - entry.z) + Math.abs((r.floorY ?? 0) - (entry.y ?? 0)) * 6 }))
    .sort((a, b) => b.d - a.d);
  let room: RoomDef | null = null;
  let tier = 0;
  const tiers: ((r: RoomDef) => boolean)[] = [
    (r) => !hasWindow(map, r) && !hasStairs(map, r) && isSealed(h, r, indoor),
    (r) => !hasStairs(map, r) && isSealed(h, r, indoor),
    (r) => isSealed(h, r, indoor),
    () => true,
  ];
  for (tier = 0; tier < tiers.length && !room; tier++) {
    room = ranked.find((x) => tiers[tier]!(x.r))?.r ?? null;
  }
  tier -= 1;
  if (!room) throw new Error(`no hideout in ${tpl}#${seed}`);
  const hide: RoomDef = room;
  const fy = hide.floorY ?? 0;
  outer: for (let r = 0; r < 3; r += 0.5) {
    for (let a = 0; a < 8; a++) {
      const x = hide.x + Math.cos((a * Math.PI) / 4) * r;
      const z = hide.z + Math.sin((a * Math.PI) / 4) * r;
      if (!blockedAtFiltered(h.hw.colliders, x, z, 0.35, fy)) {
        h.player.moveTo(x, fy, z);
        break outer;
      }
    }
  }
  h.player.isCrouching = true;
  const around = doorsOfRoom(map, hide);
  let lockedAround = 0;
  for (const door of h.hw.doorSystem.doors) {
    if (around.includes(door.id)) {
      door.locked = true;
      lockedAround++;
    }
  }
  h.team.beginAssault();
  let seeSec: number | null = null;
  let reachSec: number | null = null;
  let lastSig = -1;
  let lastChange = 0;
  let longestStall = 0;
  let stallAt = 0;
  let t = 0;
  while (t < HOLD_SEC) {
    h.step(DT, DT);
    t += DT;
    const p = h.team.sweepProgress;
    let unlocked = 0;
    for (const d of h.hw.doorSystem.doors) if (!d.locked) unlocked++;
    const sig = p.seen + p.cleared * 1000 + p.rooms * 100000 + unlocked * 1e7;
    const busy = h.team.hunters.some(
      (u) => u.alive && u.state !== 'sweep' && u.state !== 'hunt',
    );
    if (sig !== lastSig || busy) {
      lastSig = sig;
      lastChange = t;
    } else if (seeSec === null && t - lastChange > longestStall) {
      longestStall = t - lastChange;
      stallAt = lastChange;
    }
    if (TRACE && Math.round(t / DT) % 100 === 0) {
      console.log(
        `  t=${t.toFixed(0)} seen=${p.seen}/${p.total} clr=${p.cleared} swept=${p.rooms} ` +
          h.team.hunters
            .map((u) => `${u.callsign}:${u.alive ? u.state : 'X'}@${u.body.px.toFixed(0)},${u.body.footY.toFixed(0)},${u.body.pz.toFixed(0)}`)
            .join(' '),
      );
    }
    if (seeSec === null) {
      const engaged = h.team.hunters.some((u) => u.alive && (u.state === 'engage' || u.state === 'rush'));
      const fired = h.recorder.of('shotFired').some((e) => e.payload.shooter.startsWith('swat_'));
      if (engaged || fired || (Math.round(t / DT) % 4 === 0 && seesPlayer(h))) seeSec = t;
    }
    if (
      h.team.hunters.some(
        (u) =>
          u.alive &&
          Math.abs(u.body.footY - h.player.position.y) < 1 &&
          h.team.indoorRoomAt(u.body.px, u.body.pz, u.body.footY)?.id === hide.id,
      )
    ) {
      reachSec = t;
      if (seeSec === null) seeSec = t;
      break;
    }
    // 視認した時点で終える（以降は撃ち合いで、受け身の容疑者では意味のある進行測定にならない）
    if (seeSec !== null) break;
  }
  const p = h.team.sweepProgress;
  return {
    result: {
      seeSec,
      reachSec,
      breached: h.recorder.count('doorBreached'),
      lockedAround,
      tier,
      longestStall,
      stallAt,
      floors: [...new Set(indoor.map((r) => r.floorY ?? 0))].join('/'),
      roomsTotal: indoor.length,
      roomsCleared: p.cleared,
      roomId: hide.id,
    },
    dispose: () => h.dispose(),
  };
}

function mulberry32(a: number): () => number {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1 ケースぶんの検証。結果を集計用に返す（乱数は決定論的に固定。PROGRESS_RNG で変種を切り替え） */
export function checkSuspectProgress(tpl: Tpl, seed: number, variant = Number(process.env.PROGRESS_RNG ?? 0)): RunResult {
  const rng = mulberry32(seed * 7919 + variant * 104729 + tpl.length * 13);
  const spy = vi.spyOn(Math, 'random').mockImplementation(rng);
  let dispose = (): void => {};
  try {
    const run = runSuspectProgress(tpl, seed);
    const r = run.result;
    dispose = run.dispose;
    console.log(
      `[progress] ${tpl}#${seed} floors=${r.floors} tier=${r.tier} locked=${r.lockedAround} breached=${r.breached} ` +
        `see=${r.seeSec?.toFixed(1) ?? 'NONE'}s reach=${r.reachSec?.toFixed(1) ?? 'NONE'}s ` +
        `stall=${r.longestStall.toFixed(1)}s@${r.stallAt.toFixed(0)} cleared=${r.roomsCleared}/${r.roomsTotal} room=${r.roomId}`,
    );
    expect(r.lockedAround, 'hideout must have locked doors').toBeGreaterThan(0);
    expect(r.seeSec, 'SWAT never saw the player').not.toBeNull();
    expect(r.seeSec!, 'contact too late').toBeLessThan(CONTACT_LIMIT[tpl]);
    // 封鎖・窓なし・階段室でない部屋は、扉を破らない限り視認できない
    if (r.tier === 0) expect(r.breached, 'locked doors must be breached').toBeGreaterThan(0);
    expect(r.longestStall, `no progress for >${STALL_WINDOW_SEC}s (from ${r.stallAt.toFixed(0)}s)`).toBeLessThanOrEqual(
      STALL_WINDOW_SEC,
    );
    return r;
  } finally {
    dispose();
    spy.mockRestore();
  }
}
