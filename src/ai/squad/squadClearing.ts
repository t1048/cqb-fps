import * as THREE from 'three';
import { CivilianState, SuspectState } from '../../core/events';
import { t } from '../../core/i18n';
import type { RoomDef } from '../../core/types';
import { hasLineOfSight } from '../../weapons/Flashbang';
import { squadRoute } from '../SquadRoute';
import { blockedAt, type XZ } from '../EngageBehavior';
import {
  COVERAGE_PERIOD,
  MAX_DT,
  SECURED_TURN_SEC,
  type AllyUnit,
  type Cell,
  type EntryPortal,
  type RestrainTask,
  type SquadContext,
} from './squadTypes';
import { navigateTo } from './squadMovement';
import { holdAtPod } from './squadEntry';

export function updateCoverage(ctx: SquadContext, dt: number): void {
  ctx.sampleTimer -= dt;
  if (ctx.sampleTimer <= 0) {
    ctx.sampleTimer += 0.1;
    const stages = ctx.doors.doors.map((d) => d.stage).join(',');
    if (stages !== ctx.doorStages) {
      for (const ally of ctx.allies) ally.skipped.clear();
      ctx.doorStages = stages;
    }
  }
  // 全セルの視線判定は大型マップで 1 回数十〜百 ms かかるため、まとめて行わず
  // COVERAGE_PERIOD 秒で一巡するよう毎フレーム dt に比例した分だけ処理する（スパイク防止）
  const total = ctx.coverage.length;
  if (total === 0) return;
  const chunk = Math.min(total, Math.ceil((total * Math.min(dt, MAX_DT)) / COVERAGE_PERIOD));
  const eye = ctx.player.getEyePosition();
  const observers = ctx.allies
    .filter((a) => !a.down)
    .map((a) => ({
      feet: a.body.footY,
      eye: a.body.eye(new THREE.Vector3()),
      dir: a.body.gaze(new THREE.Vector3()),
    }));
  for (let n = 0; n < chunk; n++) {
    if (ctx.coverageCursor >= total) ctx.coverageCursor = 0;
    const cell = ctx.coverage[ctx.coverageCursor++]!;
    const target = { x: cell.x, y: cell.y + 0.35, z: cell.z };
    cell.visible =
      Math.abs(ctx.player.position.y - cell.y) < 0.7 &&
      ctx.player.inCameraView(target) &&
      hasLineOfSight(ctx.colliders, eye, target);
    if (!cell.visible) {
      cell.visible = observers.some((a) => {
        if (Math.abs(a.feet - cell.y) > 0.7) return false;
        const dx = cell.x - a.eye.x;
        const dz = cell.z - a.eye.z;
        const hDist = Math.hypot(dx, dz);
        const fLen = Math.hypot(a.dir.x, a.dir.z) || 1;
        if (hDist > 0.2 && (dx * a.dir.x + dz * a.dir.z) < hDist * fLen * 0.45) return false;
        return hasLineOfSight(ctx.colliders, a.eye, target);
      });
    }
    cell.seen ||= cell.visible;
  }
}

/** 全脅威制圧後に呼び出し、残っている投降容疑者・民間人・証拠武器を隊員が自律確保する。 */
export function setPostClearActive(ctx: SquadContext, active: boolean): void {
  if (ctx.disposed) return;
  ctx.postClearActive = active;
  if (!active) return;
  const living = ctx.allies.filter((a) => !a.down);
  if (living.length === 0) return;
  if (!ctx.postClearAnnounced) {
    ctx.postClearAnnounced = true;
    ctx.emitRadio(
      living[0]!,
      '全脅威制圧。残余の拘束・人質確保・証拠品押収を実施する！',
      'All threats neutralized. Securing remaining targets and evidence.',
    );
  }
}

export function beginPostClearSweep(ctx: SquadContext): void {
  setPostClearActive(ctx, true);
}

export function updateSweeping(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const portal = ally.entryPortal;
  const room = ally.targetRoom;
  const body = ally.body;
  if (!portal || !room) {
    ally.phase = 'secured';
    return;
  }

  ally.sweepElapsed += dt;

  // 1. 室内に投降済み容疑者・保護可能な民間人・落ちた武器がいれば、確保を優先
  const task = findRoomRestrainTask(ctx, room, portal.sillY);
  if (task) {
    const mateBusy = ctx.allies.some((a) => a !== ally && !a.down && a.assignment === task.id);
    if (!mateBusy || ally.assignment === task.id) {
      performRestrainTask(ctx, ally, task, dt);
      return;
    } else {
      // 相棒が拘束中は後方から銃を向けて援護カバー
      ally.progress = t('拘束援護カバー', 'Covering Restraint');
      if (!ally.engaging) {
        body.aimAt(task.x, portal.sillY + 1.32, task.z, dt, Math.PI * 2 * dt);
      }
      return;
    }
  }
  ally.assignment = null;
  ally.holdTime = 0;

  // 2. 見落とし死角のクリアリング（2名いる場合は #1 のみが探索し #2 は PoD で扉・奥をカバー）
  const isSearcher = ally.roleIndex === 0 || ally.groupSize === 1;
  if (!isSearcher) {
    ally.progress = t('支配点で援護警戒', 'Holding Domination');
    // PoD 保持（静止）。タイムアウトで手前に止まった場合のみ PoD まで歩く
    if (!ally.engaging) holdAtPod(ctx, ally, portal, dt);
    if (!ally.engaging && ally.podLook) {
      body.aimAt(ally.podLook.x, ally.podLook.y, ally.podLook.z, dt, Math.PI * 1.6 * dt);
    }
    const mate =
      ctx.allies.find((a) => !a.down && a !== ally && a.targetRoom === room && a.entryPortal?.id === portal.id && a.roleIndex === 0) ??
      ctx.allies.find((a) => !a.down && a !== ally && a.targetRoom === room);
    if (!mate || mate.phase === 'secured' || ally.sweepElapsed > 7.5) {
      enterSecured(ctx, ally, room, portal);
    }
    return;
  }

  if (ally.sweepCell && (ally.sweepCell.seen || ally.stalled >= 2.2)) {
    if (ally.stalled >= 2.2) ally.skipped.add(ally.sweepCell);
    ally.sweepCell = null;
    ally.vantage = null;
    ally.stalled = 0;
  }

  if (!ally.sweepCell) {
    let best: Cell | null = null;
    let bestDist = Infinity;
    for (const c of ctx.coverage) {
      if (c.room !== room || c.seen || ally.skipped.has(c)) continue;
      const d = Math.hypot(c.x - body.px, c.z - body.pz);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    if (!best || ally.sweepElapsed > 7.5) {
      enterSecured(ctx, ally, room, portal);
      return;
    }
    ally.sweepCell = best;
    ally.vantage = findVantageForCell(ctx, ally, room, best);
    if (!ally.vantage) {
      ally.skipped.add(best);
      ally.sweepCell = null;
      return;
    }
  }

  const targetCell = ally.sweepCell;
  const eye = body.eye(new THREE.Vector3());
  if (hasLineOfSight(ctx.colliders, eye, { x: targetCell.x, y: targetCell.y + 0.35, z: targetCell.z })) {
    ally.progress = t('死角クリア中', 'Clearing Blind Spot');
    // 重要: 床(0.18m)ではなく常に胸〜目線高(1.38m)を向く！
    if (!ally.engaging) {
      body.aimAt(targetCell.x, targetCell.y + 1.38, targetCell.z, dt, Math.PI * 2.4 * dt);
    }
    return;
  }

  if (ally.vantage) {
    ally.progress = t('遮蔽裏へ展開中', 'Moving to Vantage');
    const d = Math.hypot(ally.vantage.x - body.px, ally.vantage.z - body.pz);
    if (d <= 0.25) {
      ally.skipped.add(targetCell);
      ally.sweepCell = null;
      ally.vantage = null;
    } else {
      navigateTo(ctx, ally, ally.vantage.x, ally.vantage.z, portal.sillY, dt, false, false);
      if (!ally.engaging) {
        body.aimAt(targetCell.x, targetCell.y + 1.38, targetCell.z, dt, Math.PI * 1.8 * dt);
      }
    }
  }
}

export function enterSecured(ctx: SquadContext, ally: AllyUnit, room: RoomDef, portal: EntryPortal): void {
  const wasSweepingSearcher = ally.phase === 'sweeping' && (ally.roleIndex === 0 || ally.groupSize === 1);
  ally.phase = 'secured';
  ally.sweepCell = null;
  ally.vantage = null;
  if (wasSweepingSearcher) {
    // 捜索役は自分の PoD に戻って保持する
    ally.settled = false;
    ally.podReturnT = 0;
  }
  const adjacent = (x: number, z: number, y: number) =>
    Math.abs(y - (room.floorY ?? 0)) < 0.5 &&
    Math.abs(x - room.x) <= room.width / 2 + 0.35 &&
    Math.abs(z - room.z) <= room.depth / 2 + 0.35;
  const exits = ctx.doors.doors.filter((d) => d !== portal.door && adjacent(d.centerX, d.centerZ, d.sillY));
  if (exits.length > 0 && !ally.securedLookSet) {
    // podLook の付け替えは 1 回だけ。0.6s かけて回す（faceToward の予算内）
    ally.securedLookSet = true;
    const targetExit = exits[ally.roleIndex % exits.length]!;
    ally.podLook = { x: targetExit.centerX, y: targetExit.sillY + 1.38, z: targetExit.centerZ };
    const b = ally.body;
    const bearing = Math.atan2(b.px - ally.podLook.x, b.pz - ally.podLook.z);
    const delta = Math.abs(Math.atan2(Math.sin(bearing - b.yawRad), Math.cos(bearing - b.yawRad)));
    ally.securedTurnRate = THREE.MathUtils.clamp(delta / SECURED_TURN_SEC, 1.0, 5.0);
  }
  const key = `${room.id}:${portal.id}`;
  if (!ctx.announcedRooms.has(key)) {
    ctx.announcedRooms.add(key);
    const extra = exits.length > 0 ? `（別扉${exits.length}か所あり）` : '';
    ctx.emitRadio(ally, `${room.name}、クリア！${extra}`, 'Room clear!');
  }
}

export function updateRestraining(ctx: SquadContext, ally: AllyUnit, dt: number): void {
  const task = resolveRestrainTaskById(ctx, ally.restrainTargetId, ally.body.px, ally.body.pz, ally.body.footY);
  if (!task) {
    ally.assignment = null;
    ally.holdTime = 0;
    ally.phase = 'hold';
    ally.holdPos = { x: ally.body.px, y: ally.body.footY, z: ally.body.pz };
    ally.watchYaw = ally.body.yawRad;
    ally.progress = t('確保完了・待機', 'Secured / Holding');
    return;
  }

  const mate = ctx.allies.find((a) => a !== ally && !a.down && a.order === 'restrain' && a.restrainTargetId === ally.restrainTargetId);
  if (mate && ally.roleIndex > mate.roleIndex) {
    // 2番手は周囲カバー位置で待機し対象周辺を警戒
    const dx = ally.body.px - task.x;
    const dz = ally.body.pz - task.z;
    const dist = Math.hypot(dx, dz) || 1;
    if (dist > 2.8) {
      const cx = task.x + (dx / dist) * 2.1;
      const cz = task.z + (dz / dist) * 2.1;
      navigateTo(ctx, ally, cx, cz, task.y, dt, true, true);
    }
    ally.progress = t('確保を援護カバー中', 'Covering Restraint');
    if (!ally.engaging) ally.body.aimAt(task.x, task.y + 1.35, task.z, dt, Math.PI * 2 * dt);
    return;
  }

  performRestrainTask(ctx, ally, task, dt);
}

export function performRestrainTask(ctx: SquadContext, ally: AllyUnit, task: RestrainTask, dt: number): void {
  const range =
    task.kind === 'suspect'
      ? ctx.arrestCfg.range
      : task.kind === 'civilian'
        ? ctx.arrestCfg.civilianRange
        : ctx.arrestCfg.evidenceRange;
  const holdNeed =
    task.kind === 'suspect'
      ? ctx.arrestCfg.holdSec
      : task.kind === 'civilian'
        ? ctx.arrestCfg.civilianHoldSec
        : ctx.arrestCfg.evidenceHoldSec;

  let goalX = task.x;
  let goalZ = task.z;
  if (task.kind === 'evidence' && blockedAt(ctx.colliders, goalX, goalZ, ctx.cfg.bodyRadius, task.y)) {
    const s = ctx.entities.suspects.get(task.id);
    if (s && !blockedAt(ctx.colliders, s.body.px, s.body.pz, ctx.cfg.bodyRadius, s.body.footY)) {
      goalX = s.body.px;
      goalZ = s.body.pz;
    }
  }

  const reach = Math.max(range * 0.95, 2.1);
  const d = Math.hypot(task.x - ally.body.px, task.z - ally.body.pz);
  const sameFloor = Math.abs(task.y - ally.body.footY) < 0.55;
  const stuckNear = sameFloor && d <= 3.0 && ally.stalled >= 1.4;
  if (!sameFloor || (d > reach && !stuckNear)) {
    ally.assignment = task.id;
    ally.holdTime = 0;
    ally.progress =
      task.kind === 'suspect'
        ? t('逮捕へ接近中', 'Moving to Arrest')
        : task.kind === 'civilian'
          ? t('保護へ接近中', 'Moving to Secure')
          : t('証拠回収へ接近中', 'Moving to Evidence');
    navigateTo(ctx, ally, goalX, goalZ, task.y, dt, true, true);
    return;
  }

  ally.assignment = task.id;
  ally.progress =
    task.kind === 'suspect'
      ? t('容疑者を拘束中', 'Restraining Suspect')
      : task.kind === 'civilian'
        ? t('民間人を保護中', 'Securing Civilian')
        : t('証拠武器を回収中', 'Securing Evidence');
  ally.body.aimAt(task.x, task.y + 0.9, task.z, dt, Math.PI * 3 * dt);
  ally.holdTime += dt;
  if (ally.holdTime < holdNeed) return;

  if (task.kind === 'suspect') {
    const s = ctx.entities.suspects.get(task.id);
    if (s && s.arrest()) {
      if (s.hasUncollectedEvidence) {
        const wp = s.body.getDroppedWeaponPos()!;
        s.collectEvidence();
        ctx.bus.emit('evidence', { targetId: s.id, pos: wp });
      }
      ctx.bus.emit('arrest', { targetId: s.id, evidenceCollected: s.evidenceCollected });
      ctx.emitRadio(ally, '容疑者を拘束、武器を押収した！', 'Suspect restrained, weapon secured.');
    }
  } else if (task.kind === 'civilian') {
    const c = ctx.entities.civilians.get(task.id);
    if (c && c.secure()) {
      ctx.emitRadio(ally, '民間人を安全に確保した！', 'Civilian is safe and secure.');
    }
  } else {
    const s = ctx.entities.suspects.get(task.id);
    const wp = s?.body.getDroppedWeaponPos();
    if (s && wp && s.hasUncollectedEvidence) {
      s.collectEvidence();
      ctx.bus.emit('evidence', { targetId: s.id, pos: wp });
      ctx.emitRadio(ally, '証拠の武器を回収した', 'Evidence secured.');
    }
  }
  ally.assignment = null;
  ally.restrainTargetId = null;
  ally.holdTime = 0;
}

export function isIdleForPostSweep(ctx: SquadContext, ally: AllyUnit): boolean {
  if (ctx.postClearActive) {
    return ally.phase !== 'restraining';
  }
  return ally.phase === 'follow' || ally.phase === 'secured' || ally.phase === 'hold';
}

export function assignPostClearTask(ctx: SquadContext, ally: AllyUnit): void {
  const id = findNearestActionableId(ctx, ally.body.px, ally.body.pz, ally.body.footY, true);
  if (!id) return;
  const alreadyTaken = ctx.allies.some((a) => a !== ally && !a.down && a.phase === 'restraining' && a.restrainTargetId === id);
  if (alreadyTaken) return;
  ally.order = 'restrain';
  ally.phase = 'restraining';
  ally.restrainTargetId = id;
  ally.roleIndex = 0;
  ally.groupSize = 1;
  ally.pathGoal = null;
  ally.path.length = 0;
}

export function findRoomRestrainTask(ctx: SquadContext, room: RoomDef, floorY: number): RestrainTask | null {
  const inRoom = (px: number, pz: number, py: number) =>
    Math.abs(py - floorY) < 0.6 && Math.abs(px - room.x) <= room.width / 2 && Math.abs(pz - room.z) <= room.depth / 2;

  for (const s of ctx.entities.suspects.values()) {
    if (s.state === SuspectState.SURRENDER && s.readyForArrest && inRoom(s.body.px, s.body.pz, s.body.footY)) {
      return { id: s.id, kind: 'suspect', x: s.body.px, y: s.body.footY, z: s.body.pz };
    }
  }
  for (const c of ctx.entities.civilians.values()) {
    if (!c.alive || c.state === CivilianState.SECURED || c.state === CivilianState.SHIELDED) continue;
    if (inRoom(c.body.px, c.body.pz, c.body.footY)) {
      if (c.state === CivilianState.IDLE || c.state === CivilianState.PANIC) c.onWarned();
      if (c.canSecure) return { id: c.id, kind: 'civilian', x: c.body.px, y: c.body.footY, z: c.body.pz };
    }
  }
  for (const s of ctx.entities.suspects.values()) {
    if (s.hasUncollectedEvidence) {
      const wp = s.body.getDroppedWeaponPos();
      if (wp && inRoom(wp.x, wp.z, s.body.footY)) {
        return { id: s.id, kind: 'evidence', x: wp.x, y: s.body.footY, z: wp.z };
      }
    }
  }
  return null;
}

export function findNearestActionableId(
  ctx: SquadContext,
  px: number,
  pz: number,
  py: number,
  includeIdleCivilians = false,
): string | null {
  let bestId: string | null = null;
  let bestScore = Infinity;
  const score = (x: number, y: number, z: number) => Math.hypot(x - px, z - pz) + Math.abs(y - py) * 3;

  for (const s of ctx.entities.suspects.values()) {
    if (s.state === SuspectState.SURRENDER && s.readyForArrest) {
      const sc = score(s.body.px, s.body.footY, s.body.pz);
      if (sc < bestScore) {
        bestScore = sc;
        bestId = s.id;
      }
    } else if (s.hasUncollectedEvidence) {
      const wp = s.body.getDroppedWeaponPos()!;
      const sc = score(wp.x, s.body.footY, wp.z);
      if (sc < bestScore) {
        bestScore = sc;
        bestId = s.id;
      }
    }
  }
  for (const c of ctx.entities.civilians.values()) {
    if (!c.canSecure) continue;
    if (!includeIdleCivilians && c.state !== CivilianState.COMPLY && !ctx.postClearActive) continue;
    const sc = score(c.body.px, c.body.footY, c.body.pz);
    if (sc < bestScore) {
      bestScore = sc;
      bestId = c.id;
    }
  }
  return bestId;
}

export function resolveRestrainTaskById(
  ctx: SquadContext,
  id: string | null,
  px: number,
  pz: number,
  py: number,
): RestrainTask | null {
  const check = (cid: string): RestrainTask | null => {
    const s = ctx.entities.suspects.get(cid);
    if (s) {
      if (s.state === SuspectState.SURRENDER && s.readyForArrest) {
        return { id: s.id, kind: 'suspect', x: s.body.px, y: s.body.footY, z: s.body.pz };
      }
      if (s.hasUncollectedEvidence) {
        const wp = s.body.getDroppedWeaponPos();
        if (wp) return { id: s.id, kind: 'evidence', x: wp.x, y: s.body.footY, z: wp.z };
      }
    }
    const c = ctx.entities.civilians.get(cid);
    if (c && c.canSecure) {
      return { id: c.id, kind: 'civilian', x: c.body.px, y: c.body.footY, z: c.body.pz };
    }
    return null;
  };

  if (id) {
    const hit = check(id);
    if (hit) return hit;
  }
  const nextId = findNearestActionableId(ctx, px, pz, py, ctx.postClearActive);
  return nextId ? check(nextId) : null;
}

export function findVantageForCell(ctx: SquadContext, ally: AllyUnit, room: RoomDef, cell: Cell): XZ | null {
  const candidates = ctx.coverage.filter(
    (c) =>
      c.room === room &&
      !blockedAt(ctx.colliders, c.x, c.z, ctx.cfg.bodyRadius, c.y) &&
      hasLineOfSight(ctx.colliders, { x: c.x, y: c.y + 1.55, z: c.z }, { x: cell.x, y: cell.y + 0.35, z: cell.z }),
  );
  candidates.sort((a, b) => Math.hypot(a.x - ally.body.px, a.z - ally.body.pz) - Math.hypot(b.x - ally.body.px, b.z - ally.body.pz));
  const nearby = candidates.slice(0, 8);
  const unknown = ctx.coverage.filter((c) => c.room === room && !c.seen);
  const ranked = nearby
    .map((c) => {
      const gain = unknown.reduce(
        (n, u) => n + Number(hasLineOfSight(ctx.colliders, { x: c.x, y: c.y + 1.55, z: c.z }, { x: u.x, y: u.y + 0.35, z: u.z })),
        0,
      );
      // 部屋中央へ出ていくより、壁沿いから死角を覗く位置を優先（中央からの距離ボーナス）
      const fromCenter = Math.min(4, Math.hypot(c.x - room.x, c.z - room.z));
      return { c, score: gain * (1 + 0.25 * fromCenter) + fromCenter * 0.5 };
    })
    .sort((a, b) => b.score - a.score);

  for (const { c } of ranked) {
    const path = squadRoute({ x: ally.body.px, z: ally.body.pz }, c, cell.y, ctx.colliders, ctx.bounds, ctx.cfg.bodyRadius);
    const end = path.at(-1);
    if (end && Math.hypot(end.x - c.x, end.z - c.z) < 0.35) return c;
  }
  return null;
}
