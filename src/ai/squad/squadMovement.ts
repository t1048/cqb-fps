import type { Collider } from '../../world/WorldBuilder';
import { hasFloorSupport, legacyZeroFallbackOf, nextFootY, probeGround, type StairMark } from '../../world/Walk';
import type { Door } from '../../world/Door';
import {
  distToSegment,
  pathSegmentClear,
  pickBestStair,
  squadRoute,
  STAIR_FLOOR_MATCH,
  stairEntry,
  stairRunPlan,
  stairRunTarget,
} from '../SquadRoute';
import { blockedAt, resolveOverlap, stepToward, type XZ } from '../EngageBehavior';
import type { HumanoidBody } from '../HumanoidBody';
import {
  ARRIVE_SLOW_DIST,
  DODGE_HOLD_SEC,
  FIXED_OVERLAP,
  FOLLOW_HEADING_MIN_SPEED,
  FOLLOW_HEADING_TAU,
  FOLLOW_ROW_GAP,
  LOOK_MIN_HOLD,
  MOVE_ACCEL,
  MOVE_DECEL,
  SKIPPED_DOOR_TTL,
  STAIR_PICK_INTERVAL,
  type AllyUnit,
  type SquadContext,
} from './squadTypes';

/** プレイヤーの移動方向を低域通過して追従隊形の基準向きを更新（速度 > 0.6 m/s の時のみ） */
export function updateFollowHeading(ctx: SquadContext, dt: number): void {
  const px = ctx.player.position.x;
  const pz = ctx.player.position.z;
  const dx = px - ctx.lastPlayerPos.x;
  const dz = pz - ctx.lastPlayerPos.z;
  ctx.lastPlayerPos.x = px;
  ctx.lastPlayerPos.z = pz;
  if (dt <= 1e-5) return;
  const dist = Math.hypot(dx, dz);
  if (dist / dt > FOLLOW_HEADING_MIN_SPEED && dist > 1e-4) {
    const ux = dx / dist;
    const uz = dz / dist;
    const k = 1 - Math.exp(-dt / FOLLOW_HEADING_TAU);
    const hx = ctx.followHeading.x + (ux - ctx.followHeading.x) * k;
    const hz = ctx.followHeading.z + (uz - ctx.followHeading.z) * k;
    const hl = Math.hypot(hx, hz);
    if (hl > 1e-4) {
      ctx.followHeading.x = hx / hl;
      ctx.followHeading.z = hz / hl;
    } else {
      ctx.followHeading.x = ux;
      ctx.followHeading.z = uz;
    }
  }
}

/** 視線ターゲット切替のチャタリング防止（最短 LOOK_MIN_HOLD 秒は現在キーを保持） */
export function holdLook(ally: AllyUnit, want: string, dt: number): string {
  if (!ally.lookKey) {
    ally.lookKey = want;
    ally.lookKeyT = 0;
    return want;
  }
  ally.lookKeyT += dt;
  if (want !== ally.lookKey && ally.lookKeyT >= LOOK_MIN_HOLD) {
    ally.lookKey = want;
    ally.lookKeyT = 0;
  }
  return ally.lookKey;
}

export function isStandable(ctx: SquadContext, x: number, z: number, y: number): boolean {
  if (blockedAt(ctx.colliders, x, z, ctx.cfg.bodyRadius, y)) return false;
  const legacy = legacyZeroFallbackOf(ctx.colliders);
  return legacy || hasFloorSupport(ctx.colliders, x, z, y, ctx.cfg.bodyRadius, false);
}

const navPassableScratch = new Set<Collider>();
const stairPassableScratch = new Set<Collider>();
const doorPathPtsScratch: XZ[] = [
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
];

export function passableUnlockedDoors(
  ctx: SquadContext,
  ally?: AllyUnit,
  excludeDoorId: string | null = null,
  out?: Set<Collider>,
): Set<Collider> {
  const set = out ?? new Set<Collider>();
  set.clear();
  for (const d of ctx.doors.doors) {
    if (d.id === excludeDoorId) continue;
    if (ally?.skippedDoors.has(d.id)) continue;
    if ((!d.locked || ctx.postClearActive) && d.angle < ctx.cfg.doorOpenAngle) {
      for (const c of d.colliders) set.add(c);
    }
  }
  return set;
}

/** 予定経路の直近セグメント上（近接）にある未開放ドアを優先選択する。 */
export function pickDoorOnPath(
  ctx: SquadContext,
  ally: AllyUnit,
  routeDest: XZ,
  excludeDoorId: string | null,
): Door | null {
  const body = ally.body;
  const pts = doorPathPtsScratch;
  pts[0]!.x = body.px;
  pts[0]!.z = body.pz;
  let ptCount = 1;
  if (ally.path.length > 0) {
    const limit = Math.min(ally.path.length, 3);
    for (let i = 0; i < limit; i++) {
      pts[ptCount]!.x = ally.path[i]!.x;
      pts[ptCount]!.z = ally.path[i]!.z;
      ptCount++;
    }
  } else {
    pts[1]!.x = routeDest.x;
    pts[1]!.z = routeDest.z;
    ptCount = 2;
  }

  let best: Door | null = null;
  let bestSegDist = 0.85;
  let bestAllyDist = Infinity;
  for (const door of ctx.doors.doors) {
    if (door.id === excludeDoorId) continue;
    if (ally.skippedDoors.has(door.id)) continue;
    if ((door.locked && !ctx.postClearActive) || door.angle >= ctx.cfg.doorOpenAngle) continue;
    if (Math.abs(door.sillY - body.footY) > 0.65) continue;
    const allyDist = Math.hypot(body.px - door.centerX, body.pz - door.centerZ);
    if (allyDist >= 1.35) continue;

    let segDist = Infinity;
    for (let i = 0; i < ptCount - 1; i++) {
      const d = distToSegment(door.centerX, door.centerZ, pts[i]!, pts[i + 1]!);
      if (d < segDist) segDist = d;
    }
    if (segDist > bestSegDist) continue;
    if (segDist < bestSegDist - 0.05 || (Math.abs(segDist - bestSegDist) <= 0.05 && allyDist < bestAllyDist)) {
      best = door;
      bestSegDist = segDist;
      bestAllyDist = allyDist;
    }
  }
  return best;
}

/** Stage2 停滞復帰: めり込み脱出、それでも抜けない場合は視線・経路が通る近傍の支持面付き自由点へ退避する。 */
export function recoverStuckAlly(
  ctx: SquadContext,
  ally: AllyUnit,
  goal: XZ,
  passable?: ReadonlySet<Collider>,
): void {
  const body = ally.body;
  const r = ctx.cfg.bodyRadius;
  if (resolveOverlap(body, ctx.colliders, r)) {
    ally.stalled = 0;
    ally.stuckStage = 0;
    ally.anchor = { x: body.px, z: body.pz };
    return;
  }
  const feet = body.footY;
  const origin: XZ = { x: body.px, z: body.pz };
  const legacy = legacyZeroFallbackOf(ctx.colliders);
  let best: XZ | null = null;
  let bestScore = Infinity;
  for (const dist of [0.35, 0.55, 0.8]) {
    for (let i = 0; i < 12; i++) {
      const ang = (i * Math.PI * 2) / 12;
      const nx = body.px + Math.cos(ang) * dist;
      const nz = body.pz + Math.sin(ang) * dist;
      if (!isStandable(ctx, nx, nz, feet)) continue;
      if (!pathSegmentClear(ctx.colliders, origin, { x: nx, z: nz }, r, feet, passable)) continue;
      const score = Math.hypot(nx - goal.x, nz - goal.z) + dist * 0.4;
      if (score < bestScore) {
        bestScore = score;
        best = { x: nx, z: nz };
      }
    }
    if (best) break;
  }
  if (best) {
    const support = probeGround(ctx.colliders, best.x, best.z, feet, r, legacy) ?? feet;
    body.setPosition(best.x, best.z, nextFootY(feet, support, 0.25));
  }
  ally.stalled = 0;
  ally.stuckStage = 0;
  ally.anchor = { x: body.px, z: body.pz };
}

export function navigateTo(
  ctx: SquadContext,
  ally: AllyUnit,
  goalX: number,
  goalZ: number,
  destY: number,
  dt: number,
  allowOpenUnlockedDoors: boolean,
  faceTravel: boolean,
  excludeDoorId: string | null = null,
  speedOverride?: number,
  decelAtGoal = true,
  stairLateralOffset = 0,
): void {
  const body = ally.body;
  ally.navThisFrame = true;
  const moveSpeed = speedOverride ?? ally.combat.moveSpeed;
  let routeDest: XZ = { x: goalX, z: goalZ };
  let onStairRun = false;
  let runStair: StairMark | null = null;
  let runUp = true;
  const sameFloor = Math.abs(destY - body.footY) <= 0.75;
  let passableReady = false;
  let passable: ReadonlySet<Collider> | undefined;
  const getPassable = (): ReadonlySet<Collider> | undefined => {
    if (!allowOpenUnlockedDoors) return undefined;
    if (!passableReady) {
      passableReady = true;
      passable = passableUnlockedDoors(ctx, ally, excludeDoorId, navPassableScratch);
    }
    return passable;
  };

  const arriveTol = Math.max(ctx.cfg.arriveDistance, 0.25);
  const atGoal = !ally.activeStair && sameFloor && Math.hypot(routeDest.x - body.px, routeDest.z - body.pz) <= arriveTol;
  if (atGoal || Math.hypot(body.px - ally.anchor.x, body.pz - ally.anchor.z) >= 0.1) {
    ally.anchor = { x: body.px, z: body.pz };
    ally.stalled = 0;
    ally.stuckStage = 0;
  } else {
    ally.stalled += dt;
    if (ally.stalled >= ctx.cfg.stuckResetSec && ally.stuckStage < 1) {
      ally.stuckStage = 1;
      ally.pathGoal = null;
      ally.path.length = 0;
      ally.stairPick = null;
      resolveOverlap(body, ctx.colliders, ctx.cfg.bodyRadius);
    } else if (ally.stalled >= ctx.cfg.stuckRecoverSec && ally.stuckStage < 2) {
      ally.stuckStage = 2;
      ally.activeStair = null;
      ally.stairPick = null;
      ally.pathGoal = null;
      ally.path.length = 0;
      recoverStuckAlly(ctx, ally, { x: goalX, z: goalZ }, getPassable());
    }
  }

  // 昇降判断（Squad / Suspect 共通の stairRunPlan）: 継続・退出・停滞放棄・階段途中の目的地への到達/進入
  let forcedStair: { stair: StairMark; up: boolean } | null = null;
  if (ctx.stairs.length > 0) {
    const plan = stairRunPlan({
      stairs: ctx.stairs,
      active: ally.activeStair,
      px: body.px,
      pz: body.pz,
      footY: body.footY,
      stalled: ally.stalled,
      stallResetSec: ctx.cfg.stairStallResetSec,
      exitRadius: ctx.cfg.stairExitRadius,
      arriveTol,
      dest: { x: goalX, z: goalZ, y: destY },
    });
    if (plan.kind === 'arrived') {
      // 階段途中の目的地に着いた: その場で止まる（行き過ぎて遠い床へ出ない）
      ally.activeStair = null;
      ally.stalled = 0;
      ally.stuckStage = 0;
      ally.anchor = { x: body.px, z: body.pz };
      ally.vel.x = 0;
      ally.vel.z = 0;
      return;
    }
    if (plan.kind === 'exit') {
      ally.activeStair = null;
    } else if (plan.kind === 'giveup') {
      // 停滞カウンタ（stalled / stuckStage）は戻さない: 段階的な停滞復帰（recoverStuckAlly）を必ず動かすため
      ally.activeStair = null;
    } else if (plan.kind === 'run' && plan.stair) {
      ally.activeStair = { id: plan.stair.id, up: plan.up ?? true };
      onStairRun = true;
      runStair = plan.stair;
      runUp = plan.up ?? true;
      routeDest = plan.target ?? routeDest;
    } else if (plan.kind === 'enter' && plan.stair) {
      forcedStair = { stair: plan.stair, up: plan.up ?? true };
    }
  }

  if (!onStairRun && (forcedStair || !sameFloor) && ctx.stairs.length > 0) {
    const up = forcedStair ? forcedStair.up : destY > body.footY;
    const stair =
      forcedStair?.stair ?? chooseStair(ctx, ally, up, dt, allowOpenUnlockedDoors, excludeDoorId, { x: goalX, z: goalZ, y: destY });
    const entry = stairEntry(stair, up);
    const onFlight =
      (up ? body.footY > stair.baseY + 0.35 : body.footY < stair.topY - 0.35) &&
      distToSegment(body.px, body.pz, stair.approachLow, stair.approachHigh) <= 1.0;
    const entryClear =
      Math.hypot(body.px - entry.x, body.pz - entry.z) <= ctx.cfg.stairArrive &&
      pathSegmentClear(ctx.colliders, { x: body.px, z: body.pz }, entry, ctx.cfg.bodyRadius, body.footY, getPassable());
    if (entryClear || onFlight) {
      ally.activeStair = { id: stair.id, up };
      ally.stairPick = null;
      onStairRun = true;
      runStair = stair;
      runUp = up;
      routeDest = stairRunTarget(stair, up, body.px, body.pz);
    } else {
      routeDest = entry;
    }
  }

  if (onStairRun) {
    let target = routeDest;
    if (stairLateralOffset !== 0 && runStair) {
      const dx = runUp ? runStair.highX - runStair.lowX : runStair.lowX - runStair.highX;
      const dz = runUp ? runStair.highZ - runStair.lowZ : runStair.lowZ - runStair.highZ;
      const len = Math.hypot(dx, dz);
      const distToEnd = Math.hypot(routeDest.x - body.px, routeDest.z - body.pz);
      // 出口直前（0.45m 以内）は中央へ収束させ、踊り場への抜けを確実にする
      if (len > 1e-4 && distToEnd > 0.45) {
        const px = -dz / len;
        const pz = dx / len;
        const clamped = Math.max(-0.24, Math.min(0.24, stairLateralOffset));
        target = { x: routeDest.x + px * clamped, z: routeDest.z + pz * clamped };
      }
    }
    if (!ally.engaging && faceTravel) body.faceToward(target.x, target.z, Math.PI * 1.8 * dt);
    const sd = smoothedStep(ally, target, moveSpeed, Infinity, dt);
    stepToward(body, ctx.colliders, target.x, target.z, sd, ctx.cfg.bodyRadius);
    return;
  }

  ally.retry -= dt;
  if (
    !ally.pathGoal ||
    Math.hypot(ally.pathGoal.x - routeDest.x, ally.pathGoal.z - routeDest.z) > 0.25 ||
    (!ally.path.length && ally.retry <= 0)
  ) {
    ally.path = squadRoute(
      { x: body.px, z: body.pz },
      routeDest,
      body.footY,
      ctx.colliders,
      ctx.bounds,
      ctx.cfg.bodyRadius,
      getPassable(),
    );
    ally.pathGoal = routeDest;
    ally.retry = 0.7;
  }

  if (allowOpenUnlockedDoors) {
    const door = pickDoorOnPath(ctx, ally, routeDest, excludeDoorId);
    if (door) {
      if (door.locked && ctx.postClearActive) door.locked = false;
      if (!door.isMoving) door.command(door.maxAngle, false, body.px, body.pz);
      if (ally.doorOpenTargetId === door.id) {
        ally.doorOpenTimer += dt;
      } else {
        ally.doorOpenTargetId = door.id;
        ally.doorOpenTimer = dt;
      }
      if (ally.doorOpenTimer >= ctx.cfg.doorOpenTimeoutSec) {
        ally.skippedDoors.set(door.id, SKIPPED_DOOR_TTL);
        ally.doorOpenTargetId = null;
        ally.doorOpenTimer = 0;
        ally.doorWait = 0;
        ally.pathGoal = null;
        ally.path.length = 0;
      } else {
        ally.doorWait = 0.15;
        return;
      }
    } else if (ally.doorOpenTargetId !== null) {
      ally.doorOpenTargetId = null;
      ally.doorOpenTimer = 0;
      ally.doorWait = 0;
    }
  }

  if (ally.doorWait > 0) {
    ally.vel.x = 0;
    ally.vel.z = 0;
    return;
  }

  const next = ally.path[0] ?? routeDest;
  const dNext = Math.hypot(next.x - body.px, next.z - body.pz);
  if (dNext < 0.08) {
    if (ally.path.length > 0) ally.path.shift();
    return;
  }

  if (!ally.engaging && faceTravel) {
    body.aimAt(next.x, body.footY + 1.4, next.z, dt, Math.PI * 2 * dt);
  }
  // 最終目標までの残り距離（経路長）。最終目標接近時のみ減速する
  let remainingToGoal = Infinity;
  if (decelAtGoal && Math.hypot(routeDest.x - goalX, routeDest.z - goalZ) < 0.05) {
    remainingToGoal = dNext;
    for (let i = 0; i + 1 < ally.path.length; i++) {
      remainingToGoal += Math.hypot(ally.path[i + 1]!.x - ally.path[i]!.x, ally.path[i + 1]!.z - ally.path[i]!.z);
    }
  }
  const before = dNext;
  const sd = smoothedStep(ally, next, moveSpeed, remainingToGoal, dt);
  stepToward(body, ctx.colliders, next.x, next.z, sd, ctx.cfg.bodyRadius);
  const remaining = Math.hypot(next.x - body.px, next.z - body.pz);
  if (remaining < 0.14 && ally.path.length > 0) {
    ally.path.shift();
  } else if (before - remaining < 0.001 && ally.stalled > 0.8) {
    ally.path.length = 0;
    ally.pathGoal = null;
  }
}

/**
 * 加減速付きの 1 フレーム移動量。vDes = dir * speed * min(1, 残距離/0.6)、
 * vel += clamp(vDes - vel, accel*dt)（加速 9 / 減速 12 m/s²）。移動量は vel の進行方向成分。
 */
export function smoothedStep(ally: AllyUnit, toward: XZ, speed: number, remainingToGoal: number, dt: number): number {
  const body = ally.body;
  const dx = toward.x - body.px;
  const dz = toward.z - body.pz;
  const d = Math.hypot(dx, dz);
  ally.navThisFrame = true;
  if (d < 1e-4) return 0;
  const ux = dx / d;
  const uz = dz / d;
  const desired = speed * Math.min(1, Math.max(0, remainingToGoal) / ARRIVE_SLOW_DIST);
  const vdx = ux * desired - ally.vel.x;
  const vdz = uz * desired - ally.vel.z;
  const dv = Math.hypot(vdx, vdz);
  const cur = Math.hypot(ally.vel.x, ally.vel.z);
  const maxDv = (desired < cur ? MOVE_DECEL : MOVE_ACCEL) * dt;
  const k = dv > maxDv ? maxDv / dv : 1;
  ally.vel.x += vdx * k;
  ally.vel.z += vdz * k;
  const along = ally.vel.x * ux + ally.vel.z * uz;
  // 停止直前に 0 速で張り付かないよう、最小でも 0.15 m/s は進める
  return Math.min(d, Math.max(along, Math.min(0.15, desired)) * dt);
}

export function computeFollowGoal(ctx: SquadContext, ally: AllyUnit): { x: number; y: number; z: number } {
  const p = ctx.player.position;
  // 隊形の基準向きはプレイヤー移動方向の低域通過（その場旋回で隊員が周回しない）
  const fx = ctx.followHeading.x;
  const fz = ctx.followHeading.z;
  const rx = -fz;
  const rz = fx;
  // 2 列縦隊: 偶数番は左・奇数番は右、2 名ごとに 1 列後ろへ（3 名以上でも追従位置が重ならない）
  const side = ally.index % 2 === 0 ? -1 : 1;
  const row = Math.floor(ally.index / 2);
  const back = ctx.cfg.followDistance + row * FOLLOW_ROW_GAP;

  const candidates: XZ[] = [
    {
      x: p.x - fx * back + rx * ctx.cfg.followLateral * side,
      z: p.z - fz * back + rz * ctx.cfg.followLateral * side,
    },
    {
      x: p.x - fx * (ctx.cfg.followDistance + ally.index * 0.85),
      z: p.z - fz * (ctx.cfg.followDistance + ally.index * 0.85),
    },
    {
      x: p.x + rx * ctx.cfg.followLateral * side,
      z: p.z + rz * ctx.cfg.followLateral * side,
    },
    { x: p.x - fx * 0.9, z: p.z - fz * 0.9 },
    { x: p.x - fx * 0.5, z: p.z - fz * 0.5 },
  ];
  for (const c of candidates) {
    if (isStandable(ctx, c.x, c.z, p.y)) {
      return { x: c.x, y: p.y, z: c.z };
    }
  }
  return { x: p.x, y: p.y, z: p.z };
}

export function computeMoveSlots(
  ctx: SquadContext,
  x: number,
  z: number,
  y: number,
  yawRad: number,
  count: number,
): XZ[] {
  if (count <= 1) return [{ x, z }];
  const rx = Math.cos(yawRad);
  const rz = -Math.sin(yawRad);
  const fx = -Math.sin(yawRad);
  const fz = -Math.cos(yawRad);
  // 指定点を先頭に横 2 名 × 後方へ列を重ねる。立てない枠は後方・中央へずらし、最後は重ならない後方列に置く
  const out: XZ[] = [];
  const taken = (c: XZ): boolean => out.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 0.6);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const side = i % 2 === 0 ? -1 : 1;
    const back = row * 0.85;
    const cands: XZ[] = [
      { x: x - fx * back + rx * 0.48 * side, z: z - fz * back + rz * 0.48 * side },
      { x: x - fx * (back + 0.4) + rx * 0.3 * side, z: z - fz * (back + 0.4) + rz * 0.3 * side },
      { x: x - fx * (back + 0.78), z: z - fz * (back + 0.78) },
      { x: x - fx * back, z: z - fz * back },
    ];
    const pick = cands.find((c) => !taken(c) && isStandable(ctx, c.x, c.z, y));
    out.push(pick ?? { x: x - fx * (0.78 * (i + 1)), z: z - fz * (0.78 * (i + 1)) });
  }
  return out;
}

/** 固定位置フェーズか（重なり 0.42m 未満のみ、下位順位側を押す） */
export function isFixedPositionPhase(ally: AllyUnit): boolean {
  if (ally.coverHold !== null && ally.settled) return true;
  switch (ally.phase) {
    case 'door_prep':
    case 'pieing':
    case 'c2_plant':
    case 'c2_standoff':
    case 'flash_wait':
    case 'gas_wait':
    case 'entering':
    case 'secured':
    case 'hold':
    case 'overwatch':
    case 'stair_secure':
      return true;
    case 'stair_stack':
    case 'stacking':
    case 'sweeping':
    case 'move':
    case 'follow':
      return ally.settled;
    default:
      return false;
  }
}

/** 歩行アニメの travel に加算せず押し出す（§3.4） */
export function nudgeBody(ctx: SquadContext, body: HumanoidBody, tx: number, tz: number, dist: number): boolean {
  const dx = tx - body.px;
  const dz = tz - body.pz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4 || dist <= 0) return false;
  const k = Math.min(1, dist / d);
  const nx = body.px + dx * k;
  const nz = body.pz + dz * k;
  if (isStandable(ctx, nx, nz, body.footY)) {
    body.setPosition(nx, nz, body.footY, false);
    return true;
  }
  if (isStandable(ctx, nx, body.pz, body.footY)) {
    body.setPosition(nx, body.pz, body.footY, false);
    return true;
  }
  if (isStandable(ctx, body.px, nz, body.footY)) {
    body.setPosition(body.px, nz, body.footY, false);
    return true;
  }
  return false;
}

export function applySeparation(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  // 階段昇降中は横方向への押し出しで側壁・手すりへ衝突するのを防ぐため無効化
  if (ally.activeStair !== null) return;
  const body = ally.body;
  const fixed = isFixedPositionPhase(ally);
  // 隊員同士の密集・重なり回避（§3.4）
  for (const other of ctx.allies) {
    if (other === ally || other.down || other.activeStair !== null || Math.abs(other.body.footY - body.footY) > 0.6) continue;
    const dx = body.px - other.body.px;
    const dz = body.pz - other.body.pz;
    const d = Math.hypot(dx, dz);
    if (d <= 1e-4) continue;
    if (fixed) {
      if (d >= FIXED_OVERLAP) continue;
      // 下位順位側のみを押す（同ポータルは entryOrder、それ以外は index）
      const samePortal = ally.entryPortal !== null && ally.entryPortal.id === other.entryPortal?.id;
      const allyRank = samePortal ? ally.entryOrder : ally.index;
      const otherRank = samePortal ? other.entryOrder : other.index;
      if (allyRank < otherRank) continue;
      const push = Math.min(ctx.cfg.moveSpeed * dt * 0.3, (FIXED_OVERLAP - d) * 0.5);
      nudgeBody(ctx, body, body.px + (dx / d) * push, body.pz + (dz / d) * push, push);
    } else if (d < ctx.cfg.personalSpace) {
      // 非固定位置フェーズは従来の 0.5 倍の強さ、countTravel=false
      const push = Math.min(ctx.cfg.moveSpeed * dt * 0.3, (ctx.cfg.personalSpace - d) * 0.25);
      nudgeBody(ctx, body, body.px + (dx / d) * push, body.pz + (dz / d) * push, push);
    }
  }

  // 待機・追従中にプレイヤーの射線前方に立っていたら自動で横へ避ける（0.6s 保持＋退避位置を記憶）
  if (ally.phase === 'follow' || ally.phase === 'hold' || ally.phase === 'secured') {
    if (Math.abs(ctx.player.position.y - body.footY) <= 0.6) {
      const p = ctx.player.position;
      const fx = -Math.sin(ctx.player.yawRad);
      const fz = -Math.cos(ctx.player.yawRad);
      const rx = Math.cos(ctx.player.yawRad);
      const rz = -Math.sin(ctx.player.yawRad);
      const vx = body.px - p.x;
      const vz = body.pz - p.z;
      const forwardDist = vx * fx + vz * fz;
      const lateralDist = vx * rx + vz * rz;
      if (forwardDist > 0.4 && forwardDist < 2.2 && Math.abs(lateralDist) < 0.45) {
        const side = lateralDist >= 0 ? 1 : -1;
        const shift = Math.min(0.55, Math.max(0.25, 0.65 - Math.abs(lateralDist)));
        const wantX = body.px + rx * side * shift;
        const wantZ = body.pz + rz * side * shift;
        const pos = isStandable(ctx, wantX, wantZ, body.footY)
          ? { x: wantX, z: wantZ }
          : isStandable(ctx, body.px - rx * side * shift, body.pz - rz * side * shift, body.footY)
            ? { x: body.px - rx * side * shift, z: body.pz - rz * side * shift }
            : { x: wantX, z: wantZ };
        if (!ally.dodge) {
          ally.dodge = { pos, left: DODGE_HOLD_SEC };
        } else {
          ally.dodge.left = DODGE_HOLD_SEC;
        }
      }
    }
    if (ally.dodge) {
      ally.dodge.left -= dt;
      const dx = ally.dodge.pos.x - body.px;
      const dz = ally.dodge.pos.z - body.pz;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.12) {
        const step = Math.min(dist, ctx.cfg.moveSpeed * dt * 0.7);
        nudgeBody(ctx, body, ally.dodge.pos.x, ally.dodge.pos.z, step);
      }
      if (ally.phase === 'follow') {
        ally.followGoal = { x: ally.dodge.pos.x, z: ally.dodge.pos.z };
      }
      if (ally.dodge.left <= 0) {
        ally.dodge = null;
      }
    }
  } else if (ally.dodge) {
    ally.dodge = null;
  }
}

/**
 * 現在階で使う階段を選ぶ（B1→1F→2F は 1 階ずつ）。到達判定は squadRoute を使うため一定間隔でだけ再計算する。
 * 現在階に接続する階段が無い場合は、従来どおり進入点が最も近い階段へ向かう。
 */
export function chooseStair(
  ctx: SquadContext,
  ally: AllyUnit,
  up: boolean,
  dt: number,
  allowOpenUnlockedDoors: boolean,
  excludeDoorId: string | null,
  dest: { x: number; z: number; y: number },
): StairMark {
  const body = ally.body;
  const cache = ally.stairPick;
  if (cache) cache.timer -= dt;
  if (cache && cache.up === up && Math.abs(cache.floorY - body.footY) <= STAIR_FLOOR_MATCH && cache.timer > 0) {
    const hit = ctx.stairs.find((m) => m.id === cache.id);
    if (hit) return hit;
  }
  const passable = allowOpenUnlockedDoors
    ? passableUnlockedDoors(ctx, ally, excludeDoorId, stairPassableScratch)
    : undefined;
  const choice = pickBestStair(
    ctx.stairs,
    { x: body.px, z: body.pz, footY: body.footY },
    up,
    ctx.colliders,
    ctx.bounds,
    ctx.cfg.bodyRadius,
    passable,
    dest,
  );
  let stair: StairMark;
  if (choice) {
    stair = choice.stair;
  } else {
    stair = ctx.stairs[0]!;
    let bestD = Infinity;
    for (const m of ctx.stairs) {
      const e = stairEntry(m, up);
      const d = Math.hypot(body.px - e.x, body.pz - e.z);
      if (d < bestD) {
        bestD = d;
        stair = m;
      }
    }
  }
  ally.stairPick = { up, floorY: body.footY, id: stair.id, timer: STAIR_PICK_INTERVAL };
  return stair;
}

export function approachSign(ctx: SquadContext, door: Door): number {
  const dx = ctx.player.position.x - door.centerX;
  const dz = ctx.player.position.z - door.centerZ;
  return dx * door.normalX + dz * door.normalZ >= 0 ? 1 : -1;
}
