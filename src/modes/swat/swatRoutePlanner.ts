import type { Vec3 } from '../../core/types';
import {
  STAIR_FLOOR_MATCH,
  distToSegment,
  reachableRouteLength,
  squadRoute,
  stairEntry,
  stairExit,
  stairFloorY,
} from '../../ai/SquadRoute';
import type { Door } from '../../world/Door';
import type { Collider } from '../../world/WorldBuilder';
import { ROUTE_PLAN_CACHE_SEC, ROUTE_PLAN_DOOR_RADIUS, ROUTE_WALK_RADIUS, type SwatTeamDeps } from './swatTypes';

/** 経路計画の結果: reachable=施錠ドアを開けずに歩いて届く / door=届かないとき最初に破るべき施錠ドア */
export interface RoutePlan {
  reachable: boolean;
  door: Door | null;
  /** 階をまたぐときに使う階段 id（情報用） */
  stairId: string | null;
}

interface Leg {
  /** 施錠ドアを開けずに届く場合の経路長 */
  len: number | null;
  /** 施錠ドアを無視すれば届く場合、最初に塞いでいる施錠ドア */
  door: Door | null;
  /** 施錠ドアを無視しても届かない */
  hopeless: boolean;
}

/**
 * 施錠ドアを考慮した経路計画（全隊共有）。
 * ナビゲータ（SuspectNavigator）は施錠ドアを壁として扱うため、目標が施錠ドアの向こうにあると
 * 「近づけるところまで歩いて止まる / 外周を回る」だけで誰もブリーチしない。ここでは
 *  1) 施錠ドアを壁として届くか、2) 施錠ドアを素通しにすれば届くか、を階段込みで調べ、
 * 届かないなら経路上で最初に当たる施錠ドアを返す。
 */
export class SwatRoutePlanner {
  private readonly cache = new Map<string, { at: number; plan: RoutePlan }>();
  private clock = 0;
  private readonly openSet = new Set<Collider>();
  private readonly allSet = new Set<Collider>();

  constructor(private readonly d: SwatTeamDeps) {}

  tick(dt: number): void {
    this.clock += dt;
    if (this.cache.size > 64) {
      for (const [k, v] of this.cache) if (this.clock - v.at > ROUTE_PLAN_CACHE_SEC) this.cache.delete(k);
      if (this.cache.size > 128) this.cache.clear();
    }
  }

  plan(from: Vec3, goal: Vec3, skip?: ReadonlySet<string>): RoutePlan {
    const key = `${Math.round(from.x / 1.5)}:${Math.round(from.z / 1.5)}:${Math.round(from.y * 2)}>${Math.round(goal.x / 1.5)}:${Math.round(goal.z / 1.5)}:${Math.round(goal.y * 2)}|${skip ? [...skip].join(',') : ''}`;
    const hit = this.cache.get(key);
    if (hit && this.clock - hit.at < ROUTE_PLAN_CACHE_SEC) return hit.plan;
    const plan = this.compute(from, goal, skip);
    this.cache.set(key, { at: this.clock, plan });
    return plan;
  }

  private rebuildSets(): void {
    this.openSet.clear();
    this.allSet.clear();
    for (const door of this.d.doors.doors) {
      for (const c of door.colliders) {
        this.allSet.add(c);
        if (!door.locked) this.openSet.add(c);
      }
    }
  }

  private leg(a: Vec3, b: Vec3, y: number, skip?: ReadonlySet<string>): Leg {
    const colliders = this.d.colliders;
    const len = reachableRouteLength({ x: a.x, z: a.z }, { x: b.x, z: b.z }, y, colliders, this.d.bounds, ROUTE_WALK_RADIUS, this.openSet);
    if (len !== null) return { len, door: null, hopeless: false };
    const ghostLen = reachableRouteLength({ x: a.x, z: a.z }, { x: b.x, z: b.z }, y, colliders, this.d.bounds, ROUTE_WALK_RADIUS, this.allSet);
    if (ghostLen === null) return { len: null, door: null, hopeless: true };
    const path = squadRoute({ x: a.x, z: a.z }, { x: b.x, z: b.z }, y, colliders, this.d.bounds, ROUTE_WALK_RADIUS, this.allSet);
    let bestDoor: Door | null = null;
    let bestPos = Infinity;
    const pts = [{ x: a.x, z: a.z }, ...path];
    for (const door of this.d.doors.doors) {
      if (!door.locked || skip?.has(door.id) || Math.abs(door.sillY - y) > 0.85) continue;
      for (let i = 0; i + 1 < pts.length; i++) {
        const dist = distToSegment(door.centerX, door.centerZ, pts[i]!, pts[i + 1]!);
        if (dist > ROUTE_PLAN_DOOR_RADIUS) continue;
        const along = i + Math.min(1, dist / 4);
        if (along < bestPos) {
          bestPos = along;
          bestDoor = door;
        }
        break;
      }
    }
    return { len: null, door: bestDoor, hopeless: bestDoor === null };
  }

  private compute(from: Vec3, goal: Vec3, skip?: ReadonlySet<string>): RoutePlan {
    this.rebuildSets();
    const sameFloor = Math.abs(goal.y - from.y) <= 0.75;
    if (sameFloor) {
      const l = this.leg(from, goal, from.y, skip);
      return { reachable: l.len !== null, door: l.door, stairId: null };
    }
    const up = goal.y > from.y;
    let bestOk: { len: number; id: string } | null = null;
    let bestDoor: { door: Door; dist: number; id: string } | null = null;
    let anyLeg1 = false;
    for (const s of this.d.stairs) {
      if (Math.abs(stairFloorY(s, up) - from.y) > STAIR_FLOOR_MATCH) continue;
      const exitY = up ? s.topY : s.baseY;
      // 目標階へ直通でない階段は、目標に近い方向へ進めるもののみ中継点として許す
      const direct = Math.abs(exitY - goal.y) <= STAIR_FLOOR_MATCH;
      if (!direct && (up ? exitY > goal.y + 0.5 : exitY < goal.y - 0.5)) continue;
      const entry = stairEntry(s, up);
      const exit = stairExit(s, up);
      const l1 = this.leg(from, { x: entry.x, y: from.y, z: entry.z }, from.y, skip);
      if (l1.len === null) {
        if (l1.door) {
          const dist = Math.hypot(l1.door.centerX - from.x, l1.door.centerZ - from.z);
          if (!bestDoor || dist < bestDoor.dist) bestDoor = { door: l1.door, dist, id: s.id };
        }
        continue;
      }
      anyLeg1 = true;
      let total = l1.len;
      if (direct) {
        const l2 = this.leg({ x: exit.x, y: exitY, z: exit.z }, goal, exitY, skip);
        // 上階側の施錠ドアは上階に着いてから再計画する（ここでは到達可能として扱う）
        if (l2.len !== null) total += l2.len;
        else if (l2.hopeless && !l2.door) continue;
      }
      if (!bestOk || total < bestOk.len) bestOk = { len: total, id: s.id };
    }
    if (bestOk) return { reachable: true, door: null, stairId: bestOk.id };
    if (bestDoor) return { reachable: false, door: bestDoor.door, stairId: bestDoor.id };
    return { reachable: anyLeg1, door: null, stairId: null };
  }
}
