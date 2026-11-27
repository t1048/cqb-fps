import { tRoomName } from '../../core/i18n';
import type { RoomDef, Vec3 } from '../../core/types';
import {
  HOT_KICK,
  HOT_PREAIM,
  HOT_SHIELD,
  HOT_SPOT_DOOR,
  HOT_SPOT_OPEN,
  HOT_SPOT_STAIR,
  HOT_SPOT_WINDOW,
  HOT_STAIR_FLASH,
  HOT_SUPPRESS,
  pickRadio,
  voiceRoom,
} from '../../ai/radioLines';
import {
  HotSpotMemory,
  chooseHotTactics,
  findShotPortal,
  type HotPortal,
  type HotSpot,
  type HotTactic,
} from '../../ai/hotSpots';
import { planPincerFlankGoal, type EntryPortal, type PincerFlankGoal } from '../../ai/SwatTactics';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { Door } from '../../world/Door';
import type { SwatHunter } from './SwatHunter';
import {
  HOT_ADVANCE_SEC,
  HOT_APPROACH_DIST,
  HOT_BLIND_TEAM_SEC,
  HOT_DOOR_STABLE_SEC,
  HOT_FLASH_WAIT_SEC,
  HOT_GAS_WAIT_SEC,
  HOT_PINCER_MAX_SEC,
  HOT_REUSE_SEC,
  HOT_SHIELD_MAX_SEC,
  HOT_SUSPECT_NEAR,
  HOT_SUPPRESS_SEC,
  type SwatTeamDeps,
} from './swatTypes';

export interface SwatHotSpotHost {
  readonly d: SwatTeamDeps;
  readonly rooms: readonly RoomDef[];
  readonly hunters: readonly SwatHunter[];
  readonly clock: number;
  readonly currentPressure: number;
  readonly lastSightingAge: number;
  doorById(id: string): Door | null;
  portals(): EntryPortal[];
  roomName(pos: Vec3): string;
  flashAvailable(): boolean;
  gasAvailable(): boolean;
  throwFlashAtSpot(by: SwatHunter, target: Vec3): boolean;
  throwGasAtSpot(by: SwatHunter, target: Vec3): boolean;
  suppress(by: SwatHunter, at: Vec3): void;
  radio(h: SwatHunter | undefined, text: string, voice: string, force?: boolean): void;
  queueRadio(h: SwatHunter | undefined, text: string, voice: string): void;
}

interface Run {
  spot: HotSpot;
  tactic: HotTactic;
  phase: 'wait' | 'advance';
  t: number;
  actor: SwatHunter | null;
  /** 先頭を行く盾持ち（shield 戦術） */
  lead: SwatHunter | null;
  suppressCd: number;
  flankers: SwatHunter[];
}

const BUSY_STATES = new Set(['engage', 'rush', 'breach', 'disarm', 'restrain', 'staging', 'stack', 'pie', 'entry', 'down']);

/**
 * ホットスポット学習の実行（容疑者モード）。
 * 見えない位置から隊員が撃たれると射手の推定位置と射線が通った開口を記録して無線で共有し、
 * 近づく隊員には毎回「裸で覗く」代わりに対策（閃光 / ガス / 制圧射撃 / 盾先頭 / パイ切り先行照準 / 挟撃）を取らせる。
 * 半開きのドアも疑わしい開口として扱い、隊員は隙間へ先行照準を向ける。
 */
export class SwatHotSpotCoordinator {
  readonly memory = new HotSpotMemory();
  private readonly runs = new Map<number, Run>();
  private scanCd = 0;
  private readonly doorStable = new Map<string, number>();
  /** 統計・テスト用: 実施した対策の累計 */
  readonly tacticLog: HotTactic[] = [];

  constructor(private readonly host: SwatHotSpotHost) {}

  /**
   * 隊員が撃たれた。チームが目視していない位置からなら、地点として記録し無線で共有する。
   * victimSaw: 被弾時に被弾者自身が射手を見ていたか（正面からの撃ち合いは学習対象外）
   */
  onOfficerShot(victim: SwatHunter, shooter: Vec3, downed: boolean, victimSaw: boolean): HotSpot | null {
    const teamSaw = this.host.lastSightingAge < HOT_BLIND_TEAM_SEC;
    if (victimSaw || teamSaw) return null;
    const err = 0.45;
    const pos = {
      x: shooter.x + (Math.random() - 0.5) * err,
      y: shooter.y,
      z: shooter.z + (Math.random() - 0.5) * err,
    };
    const portal = findShotPortal(
      shooter,
      { x: victim.body.px, y: victim.body.footY, z: victim.body.pz },
      this.host.d.doors.doors,
      this.host.d.windows ?? [],
      this.host.d.stairs,
    );
    const spot = this.memory.record(pos, portal, this.host.clock, downed);
    this.announce(spot, victim);
    return spot;
  }

  private announce(spot: HotSpot, by: SwatHunter): void {
    const room = this.host.roomName(spot.pos);
    const kind = spot.portal?.kind;
    const pool = kind === 'door' ? HOT_SPOT_DOOR : kind === 'stair' ? HOT_SPOT_STAIR : kind === 'window' ? HOT_SPOT_WINDOW : HOT_SPOT_OPEN;
    const [ja, en] = pickRadio(pool, { room: tRoomName(room), roomEn: voiceRoom(room) });
    const speaker = by.alive ? by : this.host.hunters.find((h) => h.alive);
    this.host.radio(speaker, ja, en, true);
  }

  /** 全隊の近づく先に対策を実行する。毎フレーム呼ぶ */
  update(dt: number): void {
    const now = this.host.clock;
    this.memory.prune(now);
    this.scanCd -= dt;
    if (this.scanCd <= 0) {
      this.scanCd = 0.5;
      this.scanSuspiciousDoors(0.5);
    }
    for (const spot of this.memory.active(now)) {
      const run = this.runs.get(spot.id);
      if (run) this.advanceRun(run, dt);
      else if (now >= spot.readyAt) this.tryStart(spot);
    }
    for (const [id, run] of this.runs) {
      if (!this.memory.spots.includes(run.spot)) {
        this.endRun(run);
        this.runs.delete(id);
      }
    }
  }

  /** 先頭の地点の代表位置（階段は射手側の端点、開口が無ければ射手位置） */
  private refOf(spot: HotSpot): Vec3 {
    return spot.portal?.pos ?? spot.pos;
  }

  private approachers(spot: HotSpot): SwatHunter[] {
    const ref = this.refOf(spot);
    const out: SwatHunter[] = [];
    for (const h of this.host.hunters) {
      if (!h.alive || BUSY_STATES.has(h.state)) continue;
      const dx = h.body.px - ref.x;
      const dz = h.body.pz - ref.z;
      const dist = Math.hypot(dx, dz);
      if (dist > HOT_APPROACH_DIST) continue;
      if (spot.portal?.kind === 'stair') {
        // 階段: 射手のいる側の端点の水平圏内、上下どちらの階でも近づく者は対象
        if (Math.abs(h.body.footY - ref.y) > 4.5) continue;
      } else {
        if (Math.abs(h.body.footY - ref.y) > 1.3) continue;
        const eye = { x: h.body.px, y: h.body.footY + 1.5, z: h.body.pz };
        if (!hasLineOfSight(this.host.d.colliders, eye, { x: ref.x, y: ref.y + 1.0, z: ref.z })) continue;
      }
      out.push(h);
    }
    return out;
  }

  private tryStart(spot: HotSpot): void {
    const group = this.approachers(spot);
    if (group.length === 0) return;
    const ref = this.refOf(spot);
    const nearest = [...group].sort(
      (a, b) => Math.hypot(a.body.px - ref.x, a.body.pz - ref.z) - Math.hypot(b.body.px - ref.x, b.body.pz - ref.z),
    )[0]!;
    const kind = spot.portal?.kind ?? 'none';
    const lead = group.find((h) => h.shielded) ?? null;
    const flank = this.planFlank(spot, group);
    const order = chooseHotTactics({
      kind,
      pressure: this.host.currentPressure,
      flashAvailable: this.host.flashAvailable(),
      gasAvailable: this.host.gasAvailable(),
      hasShield: lead !== null,
      hasAltRoute: flank !== null,
      hits: spot.hits,
      downs: spot.downs,
      treated: spot.treated,
      suspicion: spot.suspicion,
    });
    const target = this.targetOf(spot);
    for (const tactic of order) {
      const run: Run = { spot, tactic, phase: 'wait', t: 0, actor: nearest, lead, suppressCd: 0, flankers: [] };
      let ok = false;
      switch (tactic) {
        case 'flash': {
          // 一番遠い（= 投げられる距離にいる）隊員から順に試す
          const cands = [...group].sort(
            (a, b) => Math.hypot(b.body.px - ref.x, b.body.pz - ref.z) - Math.hypot(a.body.px - ref.x, a.body.pz - ref.z),
          );
          for (const c of cands) {
            if (this.host.throwFlashAtSpot(c, target)) {
              run.actor = c;
              ok = true;
              break;
            }
          }
          if (ok && kind === 'stair') {
            const [ja, en] = pickRadio(HOT_STAIR_FLASH);
            this.host.queueRadio(run.actor!, ja, en);
          }
          break;
        }
        case 'gas':
          for (const c of group) {
            if (this.host.throwGasAtSpot(c, target)) {
              run.actor = c;
              ok = true;
              break;
            }
          }
          break;
        case 'suppress': {
          ok = true;
          const [ja, en] = pickRadio(HOT_SUPPRESS);
          this.host.queueRadio(nearest, ja, en);
          break;
        }
        case 'shield': {
          ok = lead !== null;
          if (ok) {
            const [ja, en] = pickRadio(HOT_SHIELD);
            this.host.queueRadio(lead!, ja, en);
          }
          break;
        }
        case 'pincer':
          if (flank) {
            ok = this.dispatchFlank(run, flank);
          }
          break;
        case 'slice': {
          ok = true;
          run.phase = 'advance';
          const [ja, en] = pickRadio(HOT_PREAIM);
          this.host.queueRadio(nearest, ja, en);
          this.maybeKick(spot, nearest);
          break;
        }
      }
      if (!ok) continue;
      this.runs.set(spot.id, run);
      this.tacticLog.push(tactic);
      return;
    }
  }

  /** 対策の狙い先: 階段は射手側の端点から少し階段の内側、ほかは射手の推定位置 */
  private targetOf(spot: HotSpot): Vec3 {
    if (spot.portal?.kind === 'stair') {
      const stair = this.host.d.stairs.find((s) => s.id === spot.portal!.id);
      if (stair) {
        const high = Math.abs(spot.portal.pos.y - stair.topY) < 0.6;
        const from = high ? stair.approachHigh : stair.approachLow;
        const to = high ? stair.approachLow : stair.approachHigh;
        const len = Math.hypot(to.x - from.x, to.z - from.z) || 1;
        return {
          x: from.x + ((to.x - from.x) / len) * 0.8,
          y: high ? stair.topY : stair.baseY,
          z: from.z + ((to.z - from.z) / len) * 0.8,
        };
      }
    }
    return { ...spot.pos };
  }

  private planFlank(spot: HotSpot, group: readonly SwatHunter[]): PincerFlankGoal | null {
    const others = this.host.hunters.filter((h) => h.alive && !group.includes(h) && !BUSY_STATES.has(h.state));
    if (others.length === 0) return null;
    const lead = others[0]!;
    let sx = 0;
    let sz = 0;
    for (const g of group) {
      sx += g.body.px;
      sz += g.body.pz;
    }
    const flankerPos = { x: lead.body.px, y: lead.body.footY, z: lead.body.pz };
    return planPincerFlankGoal({
      playerPos: spot.pos,
      frontalPos: { x: sx / group.length, y: group[0]!.body.footY, z: sz / group.length },
      flankerPos,
      rooms: this.host.rooms,
      doors: this.host.d.doors.doors,
      stairs: this.host.d.stairs,
      colliders: this.host.d.colliders,
      excludeDoorIds: new Set(spot.portal?.id ? [spot.portal.id] : []),
      bounds: this.host.d.bounds,
      entries: this.host.portals(),
    });
  }

  private dispatchFlank(run: Run, flank: PincerFlankGoal): boolean {
    const group = new Set(this.approachers(run.spot));
    const others = this.host.hunters.filter((h) => h.alive && !group.has(h) && !BUSY_STATES.has(h.state));
    if (others.length === 0) return false;
    for (const h of others) {
      h.huntTarget = { ...flank.target };
      h.huntingFlank = true;
      h.setState('hunt');
      run.flankers.push(h);
    }
    return true;
  }

  /** 半開きのドアを蹴り開ける（スライスの最寄り隊員が近いとき） */
  private maybeKick(spot: HotSpot, by: SwatHunter): void {
    const p = spot.portal;
    if (!p || p.kind !== 'door' || !p.partial || !p.id) return;
    const door = this.host.doorById(p.id);
    if (!door || door.locked || door.isMoving) return;
    if (Math.hypot(by.body.px - door.centerX, by.body.pz - door.centerZ) > 3.4) return;
    if (Math.random() > 0.55) return;
    door.command(door.maxAngle, true, by.body.px, by.body.pz);
    const [ja, en] = pickRadio(HOT_KICK);
    this.host.queueRadio(by, ja, en);
  }

  private advanceRun(run: Run, dt: number): void {
    run.t += dt;
    const now = this.host.clock;
    const group = this.approachers(run.spot);
    const aim = run.spot.pos;
    for (const h of group) h.preAim = { pos: aim, until: now + 2.5 };
    if (run.phase === 'wait') {
      const waitFor =
        run.tactic === 'flash'
          ? HOT_FLASH_WAIT_SEC
          : run.tactic === 'gas'
            ? HOT_GAS_WAIT_SEC
            : run.tactic === 'suppress'
              ? HOT_SUPPRESS_SEC
              : run.tactic === 'shield'
                ? HOT_SHIELD_MAX_SEC
                : HOT_PINCER_MAX_SEC;
      // 待機中: 対策が効くまで、先頭以外は開口の前に出ない（盾持ち・投擲者・制圧射撃役は動いてよい）
      for (const h of group) {
        if (run.tactic === 'shield' && h === run.lead) continue;
        if (run.flankers.includes(h)) continue; // 迂回役は止めない
        h.hotHold = { until: now + 0.4, aim };
      }
      if (run.tactic === 'suppress') {
        run.suppressCd -= dt;
        if (run.suppressCd <= 0) {
          run.suppressCd = 0.45;
          const shooter = group[Math.floor(run.t / 0.45) % Math.max(1, group.length)];
          if (shooter) {
            shooter.body.faceToward(aim.x, aim.z);
            this.host.suppress(shooter, aim);
          }
        }
      }
      let done = run.t >= waitFor;
      if (run.tactic === 'shield' && run.lead) {
        const ref = this.refOf(run.spot);
        if (!run.lead.alive || Math.hypot(run.lead.body.px - ref.x, run.lead.body.pz - ref.z) < 1.8) done = true;
      }
      if (run.tactic === 'pincer') {
        const alive = run.flankers.filter((f) => f.alive);
        if (alive.length === 0 || alive.some((f) => Math.hypot(f.body.px - aim.x, f.body.pz - aim.z) < 7)) done = true;
      }
      if (done) {
        run.phase = 'advance';
        run.t = 0;
      }
      return;
    }
    // advance: 先行照準を保ったまま前進（盾持ちが先頭なら他は盾が開口を通るまで待つ）
    if (run.tactic === 'shield' && run.lead?.alive && run.t < 3) {
      const ref = this.refOf(run.spot);
      if (Math.hypot(run.lead.body.px - ref.x, run.lead.body.pz - ref.z) > 1.0 || run.t < 1.2) {
        for (const h of group) if (h !== run.lead) h.hotHold = { until: now + 0.4, aim };
      }
    }
    if (run.t >= HOT_ADVANCE_SEC) this.endRun(run);
  }

  private endRun(run: Run): void {
    run.spot.treated++;
    run.spot.readyAt = this.host.clock + HOT_REUSE_SEC;
    this.runs.delete(run.spot.id);
  }

  /** 半開きのドアを疑わしい開口として記録する（撃たれてはいない） */
  private scanSuspiciousDoors(dt: number): void {
    const now = this.host.clock;
    for (const door of this.host.d.doors.doors) {
      const partial = !door.locked && door.angle >= 4 && door.angle <= door.maxAngle * 0.55 && !door.isMoving;
      if (!partial) {
        this.doorStable.delete(door.id);
        // 開ききった / 閉じたドアの「疑わしいだけ」の地点は捨てる
        const i = this.memory.spots.findIndex((s) => s.suspicion && s.portal?.kind === 'door' && s.portal.id === door.id);
        if (i >= 0 && !door.isMoving) this.memory.spots.splice(i, 1);
        continue;
      }
      const stable = (this.doorStable.get(door.id) ?? 0) + dt;
      this.doorStable.set(door.id, stable);
      if (stable < HOT_DOOR_STABLE_SEC) continue;
      if (this.memory.spots.some((s) => s.portal?.kind === 'door' && s.portal.id === door.id)) continue;
      // 近づく隊員がいるときだけ疑う
      const pos = { x: door.centerX, y: door.sillY, z: door.centerZ };
      const nearHunter = this.host.hunters.some(
        (h) =>
          h.alive &&
          !BUSY_STATES.has(h.state) &&
          Math.abs(h.body.footY - door.sillY) < 1.3 &&
          Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) < HOT_APPROACH_DIST &&
          // 半開きの扉板は開口の中心を隠すので、至近なら視線がなくても近づいているとみなす
          (Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) < HOT_SUSPECT_NEAR ||
            hasLineOfSight(this.host.d.colliders, { x: h.body.px, y: h.body.footY + 1.5, z: h.body.pz }, { x: pos.x, y: pos.y + 1, z: pos.z })),
      );
      if (!nearHunter) continue;
      const portal: HotPortal = { kind: 'door', id: door.id, pos, partial: true };
      this.memory.record(pos, portal, now, false, true);
    }
  }

  /** 部屋が未クリアの隊員が停止する必要があるか（SwatHunter の判定補助）。 */
  isHolding(h: SwatHunter): boolean {
    return h.hotHold !== null && h.hotHold.until > this.host.clock;
  }

  dispose(): void {
    this.runs.clear();
    this.memory.spots.length = 0;
  }
}
