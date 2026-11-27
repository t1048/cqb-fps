import * as THREE from 'three';
import { t } from '../core/i18n';
import type { RoomDef, Vec3 } from '../core/types';
import { disposeObject } from '../core/dispose';
import type { AllyTarget, CombatContext } from '../ai/EngageBehavior';
import { blockedAtFiltered } from '../ai/SquadRoute';
import type { EntryMode, FriendlyPos } from '../ai/cqbEntry';
import {
  BASE_SHIELD_COMBAT,
  BASE_SWAT_COMBAT,
  BASE_SWAT_MOBILITY,
  SWAT_RUSH_LOW_HP,
  isShieldRole,
} from '../ai/SwatProfile';
import {
  C2_BLAST_RADIUS,
  C2_MIN_LOCKED_DOORS,
  C2_PRESSURE_THRESHOLD,
  assignCellPortals,
  buildStackSlotPortal,
  computeBallisticVelocity,
  computeC2Standoff,
  entryRouteDest,
  evaluateC2BlastCone,
  filterReachableExteriorEntries,
  findRoomDoors,
  isIndoorPoint,
  listExteriorEntries,
  planDoorwayFlashThrow,
  planFlashThrow,
  planPincerFlankGoal,
  planWallBankFlashThrow,
  planWindowFlashThrow,
  raycastWallXZ,
  selectPinningCell,
  shouldUseC2Breach,
  type C2BlastResult,
  type EntryPortal,
  type EntryRoute,
  type EntrySample,
  type FlankDoorSample,
  type FlashDoorSample,
  type FlashThrowPlan,
  type PincerFlankGoal,
  type PincerFlankParams,
  type PinningCellInfo,
} from '../ai/SwatTactics';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Door } from '../world/Door';
import type { BarricadeHooks, BarricadeInfo } from './Fortify';
import { SwatCoverage } from './swat/swatCoverage';
import { SwatEntryCoordinator } from './swat/swatEntryCoordinator';
import {
  assignSwatStackSlots,
  cellSizes,
  describePortalDirection,
  findObstructingBarricade,
  resolveSwatSpawns,
  shouldTriggerReinforcements,
  updateRoomStay,
} from './swat/swatHelpers';
import { SwatHunter } from './swat/SwatHunter';
import { SwatObstacles } from './swat/swatObstacles';
import { SwatRoutePlanner, type RoutePlan } from './swat/swatRoutePlanner';
import { SwatTacticsCoordinator } from './swat/swatTacticsCoordinator';
import {
  BARRICADE_SHOOT_RANGE,
  CELL_NAMES,
  NAMES,
  PRESSURE_PER_DOWN,
  PRESSURE_RAMP_SEC,
  RADIO_STAGGER_SEC,
  REINFORCEMENT_COOLDOWN_SEC,
  REINFORCEMENT_MAX_WAVES,
  REINFORCEMENT_MIN_HOLD_SEC,
  REINFORCEMENT_TRIGGER_KILLS,
  REINFORCEMENT_WAVE_SIZE,
  SEPARATION_DIST,
  SEPARATION_FIXED_DIST,
  SEPARATION_LOOSE_MUL,
  SEPARATION_SPEED,
  SHIELD_COMBAT,
  SWAT_COMBAT,
  SWAT_MOBILITY,
  VISION_FOV_DEG,
  type CoverCell,
  type HunterState,
  type ReinforcementCheck,
  type SwatSpawn,
  type SwatTeamDeps,
  type SwatTeamHost,
  type TrapHooks,
} from './swat/swatTypes';

export type { BarricadeHooks, BarricadeInfo };
export {
  C2_BLAST_RADIUS,
  C2_MIN_LOCKED_DOORS,
  C2_PRESSURE_THRESHOLD,
  assignCellPortals,
  buildStackSlotPortal,
  computeBallisticVelocity,
  computeC2Standoff,
  entryRouteDest,
  evaluateC2BlastCone,
  filterReachableExteriorEntries,
  findRoomDoors,
  isIndoorPoint,
  listExteriorEntries,
  planDoorwayFlashThrow,
  planFlashThrow,
  planPincerFlankGoal,
  planWallBankFlashThrow,
  planWindowFlashThrow,
  raycastWallXZ,
  selectPinningCell,
  shouldUseC2Breach,
};
export type {
  C2BlastResult,
  EntryPortal,
  EntryRoute,
  EntrySample,
  FlankDoorSample,
  FlashDoorSample,
  FlashThrowPlan,
  PincerFlankGoal,
  PincerFlankParams,
  PinningCellInfo,
};
export {
  BARRICADE_SHOOT_RANGE,
  PRESSURE_PER_DOWN,
  PRESSURE_RAMP_SEC,
  RADIO_STAGGER_SEC,
  REINFORCEMENT_COOLDOWN_SEC,
  REINFORCEMENT_MAX_WAVES,
  REINFORCEMENT_MIN_HOLD_SEC,
  REINFORCEMENT_TRIGGER_KILLS,
  REINFORCEMENT_WAVE_SIZE,
  SHIELD_COMBAT,
  SWAT_COMBAT,
  VISION_FOV_DEG,
  SwatHunter,
  assignSwatStackSlots,
  cellSizes,
  describePortalDirection,
  findObstructingBarricade,
  shouldTriggerReinforcements,
  updateRoomStay,
};
export type { CoverCell, HunterState, ReinforcementCheck, SwatSpawn, SwatTeamDeps, TrapHooks };

/**
 * 容疑者モードの敵 SWAT チーム。2 人 1 組で部屋を順に掃討し、音・目撃情報は無線で共有する。
 * 屋外からは外壁のドアを通って入り、施錠ドアはブリーチする。射線上に民間人がいると撃たない。
 */
export class SwatTeam implements SwatTeamHost {
  readonly root = new THREE.Group();
  readonly hunters: SwatHunter[] = [];
  private readonly rooms: RoomDef[];
  private readonly unsubs: (() => void)[] = [];
  private shieldHintShown = false;
  private radioCd = 0;
  private started = false;
  private disposed = false;
  /** 統計 */
  kills = 0;
  /** レーザー・ライト光芒（F11）のワークベクトル */
  private readonly muzzleOriginTmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly muzzleDirTmp: Vec3 = { x: 0, y: 0, z: -1 };
  /** 連携無線スタガーキュー（F12） */
  private readonly radioQueue: { hunter: SwatHunter; text: string; voice: string }[] = [];
  private radioSpeakGap = 0;
  private readonly livingTargetsBuf: AllyTarget[] = [];
  private readonly combatCtx: CombatContext;
  private readonly baseSpawns: readonly SwatSpawn[];
  private nextHunterId = 1;
  private nextCellIndex = 0;

  private readonly coverage: SwatCoverage;
  private readonly entry: SwatEntryCoordinator;
  private readonly obstacles: SwatObstacles;
  private readonly tactics: SwatTacticsCoordinator;
  private readonly routePlanner: SwatRoutePlanner;

  constructor(private readonly d: SwatTeamDeps) {
    this.root.name = 'swatTeam';
    Object.assign(SWAT_COMBAT, BASE_SWAT_COMBAT);
    Object.assign(SWAT_MOBILITY, BASE_SWAT_MOBILITY);
    Object.assign(SHIELD_COMBAT, BASE_SHIELD_COMBAT);
    this.rooms = d.rooms.filter((r) => !r.outdoor);
    this.baseSpawns = d.spawns.map((s) => ({ ...s }));
    const ctx: CombatContext = {
      player: d.player,
      colliders: d.colliders,
      playerDamage: (dmg, from, shooter) => {
        const hp = d.player.takeDamage(dmg);
        d.bus.emit('playerHit', { shooter, damage: dmg, from, hp });
      },
      doors: d.doors,
      bounds: d.bounds,
      stairs: d.stairs,
      rooms: d.rooms,
      allies: d.suspects,
    };
    this.combatCtx = ctx;
    this.routePlanner = new SwatRoutePlanner(d);

    const self = this;
    this.coverage = new SwatCoverage({
      d: this.d,
      rooms: this.rooms,
      hunters: this.hunters,
      get radioCd() {
        return self.radioCd;
      },
      get lastSightingAge() {
        return self.lastSightingAge;
      },
      portals: () => this.entry.portals(),
      doorById: (id) => this.doorById(id),
      planRoute: (from, goal, skip) => this.routePlanner.plan(from, goal, skip),
      radio: (h, text, voice, force) => this.radio(h, text, voice, force),
    });

    this.entry = new SwatEntryCoordinator({
      d: this.d,
      rooms: this.rooms,
      hunters: this.hunters,
      get currentPressure() {
        return self.currentPressure;
      },
      get radioSpeakGap() {
        return self.radioSpeakGap;
      },
      get radioQueueLength() {
        return self.radioQueue.length;
      },
      doorById: (id) => this.doorById(id),
      indoorRoomAt: (x, z, y) => this.coverage.indoorRoomAt(x, z, y),
      isDoorBeingBreached: (doorId, exclude) => this.isDoorBeingBreached(doorId, exclude),
      radio: (h, text, voice, force) => this.radio(h, text, voice, force),
      queueRadio: (h, text, voice) => this.queueRadio(h, text, voice),
      trimRadioQueueToOne: () => {
        while (this.radioQueue.length > 1) this.radioQueue.pop();
      },
    });

    this.obstacles = new SwatObstacles({
      d: this.d,
      hunters: this.hunters,
      get started() {
        return self.started;
      },
      get lastSighting() {
        return self.lastSighting;
      },
      doorById: (id) => this.doorById(id),
      civilianInLine: (from, to) => this.coverage.civilianInLine(from, to),
      coveredByHostage: (x, z) => this.coverage.coveredByHostage(x, z),
      canPlayerHear: (pos, range) => this.canPlayerHear(pos, range),
      firstAlive: () => this.firstAlive(),
      radio: (h, text, voice, force) => this.radio(h, text, voice, force),
      onBlastKill: (h) => {
        this.d.weapons.removeTarget(h);
        this.kills++;
        this.tactics.onManDown(h);
      },
    });

    this.tactics = new SwatTacticsCoordinator({
      d: this.d,
      root: this.root,
      rooms: this.rooms,
      hunters: this.hunters,
      combatCtx: this.combatCtx,
      baseSpawns: this.baseSpawns,
      teamHost: this,
      get started() {
        return self.started;
      },
      get disposed() {
        return self.disposed;
      },
      get kills() {
        return self.kills;
      },
      get aliveCount() {
        return self.aliveCount;
      },
      get radioCd() {
        return self.radioCd;
      },
      nextHunterId: () => this.nextHunterId++,
      nextCellIndex: () => this.nextCellIndex++,
      assignCells: () => this.assignCells(),
      portals: () => this.entry.portals(),
      reachablePortalLengths: (from) => this.entry.reachablePortalLengths(from),
      abortStacking: () => this.entry.abortStacking(),
      onDoorBreached: (by, doorId) => this.entry.onDoorBreached(by, doorId),
      disarmTrappedDoorOnC2: (door) => this.obstacles.disarmTrappedDoorOnC2(door),
      roomAt: (x, z, y) => this.coverage.roomAt(x, z, y),
      indoorRoomAt: (x, z, y) => this.coverage.indoorRoomAt(x, z, y),
      unclearedIndoorRoom: (h) => this.coverage.unclearedIndoorRoom(h),
      roomName: (pos) => this.coverage.roomName(pos),
      hostageShieldUp: () => this.coverage.hostageShieldUp(),
      coveredByHostage: (x, z) => this.coverage.coveredByHostage(x, z),
      canPlayerHear: (pos, range) => this.canPlayerHear(pos, range),
      firstAlive: () => this.firstAlive(),
      radio: (h, text, voice, force) => this.radio(h, text, voice, force),
      queueRadio: (h, text, voice) => this.queueRadio(h, text, voice),
    });

    const spawns = resolveSwatSpawns(d.spawns, d.count, d.colliders);
    for (let i = 0; i < spawns.length; i++) {
      const idNum = this.nextHunterId++;
      const h = new SwatHunter(
        `swat_${idNum}`,
        `Red-${i + 1}`,
        NAMES[(idNum - 1) % NAMES.length]!,
        spawns[i]!,
        this,
        ctx,
        d.bus,
        d.textures,
        isShieldRole(i, spawns.length),
      );
      this.hunters.push(h);
      this.root.add(h.body.group);
      this.root.add(h.optics.group);
      d.weapons.addTarget(h);
    }
    this.assignCells();
    // 建物の方を向いて待機
    const focus = this.rooms[0];
    if (focus) for (const h of this.hunters) h.body.faceToward(focus.x, focus.z);

    this.unsubs.push(
      d.bus.on('entityHit', (e) => {
        if (e.nonlethal || e.shooter.startsWith('swat_')) return;
        const h = this.hunters.find((x) => x.id === e.targetId);
        if (!h || !h.alive) return;
        const p = d.player.position;
        const from = { x: p.x, y: p.y, z: p.z };
        if (h.takeHit(e.damage, from)) {
          d.weapons.removeTarget(h);
          this.kills++;
          this.tactics.onManDown(h);
        } else {
          this.abortStacking();
          this.shareSighting(from);
          this.tactics.alertTeam(from, true, 30, h);
        }
      }),
      d.bus.on('bulletImpact', (e) => {
        // 盾持ちの正面に当たった弾（盾に止められた）: 初回だけ足元を狙うヒントを出す
        if (e.shooter !== 'player' || this.shieldHintShown) return;
        for (const h of this.hunters) {
          if (!h.alive || !h.shielded) continue;
          const b = h.body.getAABB();
          const m = 0.12;
          if (e.pos.x < b.min.x - m || e.pos.x > b.max.x + m || e.pos.z < b.min.z - m || e.pos.z > b.max.z + m || e.pos.y > b.max.y + m) continue;
          this.shieldHintShown = true;
          d.subtitle.show(
            t('防弾盾に弾かれた！ 腰より下を撃つか、側面・背後へ回り込め', 'Blocked by ballistic shield! Aim below the waist or flank around!'),
            2.6,
          );
          return;
        }
      }),
      d.bus.on('noise', (e) => this.tactics.onNoise(e.pos, e.radius, e.kind, e.source)),
      d.bus.on('playerBlinded', (e) => {
        if (e.duration > 0.3) this.triggerRush(e.pos, 'blind');
      }),
      d.bus.on('playerHit', (e) => {
        if (e.hp > 0 && e.hp <= SWAT_RUSH_LOW_HP) {
          const p = d.player.position;
          this.triggerRush({ x: p.x, y: p.y, z: p.z }, 'lowHp');
        }
      }),
      d.bus.on('flashDetonated', (e) => {
        if (e.thrower && e.thrower.startsWith('swat_')) return; // 自チームの閃光は目を背ける
        for (const h of this.hunters) {
          if (!h.alive) continue;
          const c = h.body.chestPos();
          const dist = Math.hypot(c.x - e.pos.x, c.y - e.pos.y, c.z - e.pos.z);
          if (dist > e.radius) continue;
          if (!hasLineOfSight(d.colliders, c, { x: e.pos.x, y: e.pos.y + 0.1, z: e.pos.z })) continue;
          h.onFlashed(e.blindSec * (1 - 0.6 * (dist / e.radius)));
        }
      }),
    );
  }

  /** 隊員をツーマン／スリーマンセルに組み、組ごとにコールサインを振る */
  private assignCells(): void {
    let i = 0;
    const sizes = cellSizes(this.hunters.length);
    sizes.forEach((size, c) => {
      const members = this.hunters.slice(i, i + size);
      const name = CELL_NAMES[c % CELL_NAMES.length]!;
      members.forEach((m, k) => {
        m.cell = members;
        m.cellIndex = c;
        m.cellName = name;
        m.callsign = `${name}-${k + 1}`;
      });
      i += size;
    });
    this.nextCellIndex = sizes.length;
  }

  // ---------- 公開プロパティ・ゲッター ----------

  get lastSighting(): Vec3 | null {
    return this.tactics.lastSighting;
  }
  set lastSighting(v: Vec3 | null) {
    this.tactics.lastSighting = v;
  }

  get reactionSec(): number {
    return this.tactics.reactionSec;
  }
  set reactionSec(v: number) {
    this.tactics.reactionSec = v;
  }

  get pepperShots(): number {
    return this.tactics.pepperShots;
  }
  set pepperShots(v: number) {
    this.tactics.pepperShots = v;
  }

  get trapsDisarmed(): number {
    return this.obstacles.trapsDisarmed;
  }
  set trapsDisarmed(v: number) {
    this.obstacles.trapsDisarmed = v;
  }

  get trapKills(): number {
    return this.obstacles.trapKills;
  }
  set trapKills(v: number) {
    this.obstacles.trapKills = v;
  }

  get playerCrouching(): boolean {
    return this.d.player.isCrouching;
  }

  get aliveCount(): number {
    return this.hunters.filter((h) => h.alive).length;
  }

  get total(): number {
    return this.hunters.length;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get currentPressure(): number {
    return this.tactics.currentPressure;
  }

  get lastSightingAge(): number {
    return this.tactics.lastSightingAge;
  }

  get reinforcementWavesSpawned(): number {
    return this.tactics.reinforcementWavesSpawned;
  }

  get hasPendingReinforcements(): boolean {
    return this.tactics.hasPendingReinforcements;
  }

  get clock(): number {
    return this.entry.clock;
  }

  /** 掃討の進捗（確認済みマス・クリア済み部屋・全マス）。 */
  get sweepProgress(): { seen: number; cleared: number; total: number; rooms: number } {
    return this.coverage.progress();
  }

  // ---------- 公開 Facade メソッド ----------

  checkReinforcements(holdLeftSec: number): boolean {
    return this.tactics.checkReinforcements(holdLeftSec);
  }

  spawnReinforcements(count = REINFORCEMENT_WAVE_SIZE): number {
    return this.tactics.spawnReinforcements(count);
  }

  withdraw(): boolean {
    return this.tactics.withdraw();
  }

  /** 生存中の隊員（味方容疑者の射撃対象） */
  livingTargets(): AllyTarget[] {
    this.livingTargetsBuf.length = 0;
    for (let i = 0; i < this.hunters.length; i++) {
      const h = this.hunters[i]!;
      if (h.alive) this.livingTargetsBuf.push(h.targetWrapper);
    }
    return this.livingTargetsBuf;
  }

  doorById(id: string): Door | null {
    return this.d.doors.doors.find((door) => door.id === id) ?? null;
  }

  routeFrom(
    x: number,
    z: number,
    y: number,
    goal: Vec3,
    preferPortalId?: string | null,
    mode: 'hold' | 'attack' = 'hold',
    blacklist?: { has(id: string): boolean },
    prevPhase?: EntryRoute['phase'] | null,
    prevEntryId?: string | null,
  ): EntryRoute {
    return this.entry.routeFrom(x, z, y, goal, preferPortalId, mode, blacklist, prevPhase, prevEntryId);
  }

  hasAlternateEntry(from: Vec3, exceptId: string, blacklist?: { has(id: string): boolean }): boolean {
    return this.entry.hasAlternateEntry(from, exceptId, blacklist);
  }

  beginAssault(): void {
    if (this.started) return;
    this.started = true;
    this.entry.beginAssault();
  }

  getEntryStyle(): EntryMode {
    return this.entry.getEntryStyle();
  }

  setEntryStyleOverride(mode: EntryMode | null): void {
    this.entry.setEntryStyleOverride(mode);
  }

  abortStacking(): void {
    this.entry.abortStacking();
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, 0.05);
    this.radioCd = Math.max(0, this.radioCd - dt);
    this.radioSpeakGap = Math.max(0, this.radioSpeakGap - dt);
    this.tactics.tickTimers(dt);
    this.routePlanner.tick(dt);
    this.coverage.tickTimers(dt);
    this.obstacles.tickTimers(dt);
    this.entry.tickClock(dt);

    if (this.radioSpeakGap <= 0 && this.radioQueue.length > 0) {
      const next = this.radioQueue.shift()!;
      const speaker = next.hunter.alive ? next.hunter : this.firstAlive();
      if (speaker) this.emitRadioNow(speaker, next.text, next.voice);
    }

    if (this.started) {
      this.tactics.updatePressure(dt);
      this.entry.updateEntryCoordination(dt);
      this.entry.updateEntryGroups(dt);
      this.tactics.updateAntiCamping(dt);
    }
    for (const h of this.hunters) h.update(dt);
    this.tactics.updatePincerRefresh();
    this.tactics.updateC2Blasts(dt);
    this.coverage.tickCoverage(dt, this.started);
    this.separate(dt);
    this.updateOptics();
    this.obstacles.watchTraps();
    this.coverage.flushPendingHunt();
  }

  /** F11: 生存中 SWAT の銃口レーザー・着弾点を更新する（フラッシュライト光芒は非表示、ローレディ時も非表示） */
  private updateOptics(): void {
    for (const h of this.hunters) {
      if (
        !h.alive ||
        h.state === 'staging' ||
        h.state === 'disarm' ||
        h.blindLeft > 0 ||
        h.body.getReadyPose() === 'low' ||
        !h.body.getMuzzlePose(this.muzzleOriginTmp, this.muzzleDirTmp)
      ) {
        h.optics.hide();
        continue;
      }
      h.optics.update(this.muzzleOriginTmp, this.muzzleDirTmp, this.d.colliders);
    }
  }

  /**
   * 隊員同士の重なりを解消する（§3.4 / §5-8）。
   * 固定位置フェーズ（スタック到着済み・パイ切り中・突入中）は重なり < 0.42m のときだけ下位順位側のみを押す。
   * それ以外は従来の 0.5 倍の強さ。押し出しは歩行アニメを出さない（countTravel=false）。
   */
  private separate(dt: number): void {
    const hs = this.hunters;
    const maxPush = SEPARATION_SPEED * dt;
    const isFixed = (h: SwatHunter): boolean =>
      (h.state === 'stack' && h.stackReady) || h.state === 'pie' || h.state === 'entry';
    for (let i = 0; i < hs.length; i++) {
      const a = hs[i]!;
      if (!a.alive || a.state === 'staging') continue;
      for (let j = i + 1; j < hs.length; j++) {
        const b = hs[j]!;
        if (!b.alive || b.state === 'staging') continue;
        if (Math.abs(a.body.footY - b.body.footY) > 0.6) continue;
        let dx = b.body.px - a.body.px;
        let dz = b.body.pz - a.body.pz;
        let d = Math.hypot(dx, dz);
        const fa = isFixed(a);
        const fb = isFixed(b);
        if (fa || fb) {
          if (d >= SEPARATION_FIXED_DIST) continue;
          if (d < 1e-4) {
            dx = Math.cos(i * 2.4);
            dz = Math.sin(i * 2.4);
            d = 1;
          }
          const push = Math.min(maxPush, SEPARATION_FIXED_DIST - Math.min(d, SEPARATION_FIXED_DIST));
          const ux = dx / d;
          const uz = dz / d;
          let aHigher = true;
          if (fa && !fb) aHigher = true;
          else if (!fa && fb) aHigher = false;
          else if (a.entryGroup && a.entryGroup === b.entryGroup) aHigher = a.entryOrder <= b.entryOrder;
          else aHigher = a.cellIndex <= b.cellIndex;
          if (aHigher) this.nudge(b, ux * push, uz * push);
          else this.nudge(a, -ux * push, -uz * push);
          continue;
        }
        if (d >= SEPARATION_DIST) continue;
        if (d < 1e-4) {
          // 完全一致: 序列で決まる方向へ分ける
          dx = Math.cos(i * 2.4);
          dz = Math.sin(i * 2.4);
          d = 1;
        }
        const push = Math.min(maxPush * SEPARATION_LOOSE_MUL, ((SEPARATION_DIST - Math.min(d, SEPARATION_DIST)) / 2) * SEPARATION_LOOSE_MUL);
        const ux = dx / d;
        const uz = dz / d;
        this.nudge(a, -ux * push, -uz * push);
        this.nudge(b, ux * push, uz * push);
      }
    }
  }

  private nudge(h: SwatHunter, dx: number, dz: number): void {
    const x = h.body.px + dx;
    const z = h.body.pz + dz;
    if (blockedAtFiltered(this.d.colliders, x, z, 0.3, h.body.footY)) return;
    h.body.setPosition(x, z, h.body.footY, false);
  }

  getMinimapStates(): { name: string; x: number; z: number; y: number; yawRad: number; down: boolean }[] {
    return this.hunters.map((h) => ({
      name: h.callsign,
      x: h.body.px,
      z: h.body.pz,
      y: h.body.footY,
      yawRad: h.body.yawRad,
      down: !h.alive,
    }));
  }

  // ---------- チーム連携・戦術委譲 ----------

  shareSighting(pos: Vec3): void {
    this.tactics.shareSighting(pos);
  }

  onContact(by: SwatHunter, pos: Vec3): void {
    this.tactics.onContact(by, pos);
  }

  triggerRush(pos: Vec3, reason: 'blind' | 'reload' | 'pepper' | 'lowHp'): boolean {
    return this.tactics.triggerRush(pos, reason);
  }

  onBreach(by: SwatHunter, door: Door): void {
    this.tactics.onBreach(by, door);
  }

  shouldUseC2(doorId: string): boolean {
    return this.tactics.shouldUseC2(doorId);
  }

  onC2PlantStart(by: SwatHunter, door: Door): void {
    this.tactics.onC2PlantStart(by, door);
  }

  emitC2Beep(door: Door, urgent: boolean): void {
    this.tactics.emitC2Beep(door, urgent);
  }

  detonateC2(by: SwatHunter, door: Door, side: number): void {
    this.tactics.detonateC2(by, door, side);
  }

  tryFlash(by: SwatHunter, target: Vec3): void {
    this.tactics.tryFlash(by, target);
  }

  suppress(by: SwatHunter, at: Vec3): void {
    this.tactics.suppress(by, at);
  }

  firePepper(by: SwatHunter, at: Vec3): void {
    this.tactics.firePepper(by, at);
  }

  // ---------- 掃討・カバレッジ委譲 ----------

  markEntryLookSector(h: SwatHunter, look: Vec3): void {
    this.coverage.markEntryLookSector(h, look);
  }

  markSeenAround(x: number, z: number, y: number, radius: number): void {
    this.coverage.markSeenAround(x, z, y, radius);
  }

  markBad(c: CoverCell): void {
    this.coverage.markBad(c);
  }

  pickCell(h: SwatHunter): CoverCell | null {
    return this.coverage.pickCell(h);
  }

  nextClearCell(h: SwatHunter): CoverCell | null {
    return this.coverage.nextClearCell(h);
  }

  markCleared(r: RoomDef, by: SwatHunter): void {
    this.coverage.markCleared(r, by);
  }

  markRoomAt(x: number, z: number, y: number): void {
    this.coverage.markRoomAt(x, z, y);
  }

  indoorRoomAt(x: number, z: number, y: number): RoomDef | null {
    return this.coverage.indoorRoomAt(x, z, y);
  }

  unclearedIndoorRoom(h: SwatHunter): RoomDef | null {
    return this.coverage.unclearedIndoorRoom(h);
  }

  sameIndoorRoom(x: number, z: number, y: number, goal: Vec3): boolean {
    return this.coverage.sameIndoorRoom(x, z, y, goal);
  }

  isDoorBeingBreached(doorId: string, exclude?: SwatHunter): boolean {
    return this.hunters.some((h) => h !== exclude && h.alive && h.state === 'breach' && h.breachDoorId === doorId);
  }

  /** 目標が施錠ドアの向こうか（歩いて届くか）。届かなければ最初に破るべき施錠ドアを返す */
  planRoute(from: Vec3, goal: Vec3, skip?: ReadonlySet<string>): RoutePlan {
    return this.routePlanner.plan(from, goal, skip);
  }

  findLockedDoor(h: SwatHunter, goal: Vec3, skip: ReadonlySet<string>): Door | null {
    let best: Door | null = null;
    let bestScore = Infinity;
    for (const door of this.d.doors.doors) {
      if (!door.locked || skip.has(door.id) || this.trapHeld(door) || this.isDoorBeingBreached(door.id, h)) continue;
      if (Math.abs(door.sillY - h.body.footY) > 0.75 && Math.abs(door.sillY - goal.y) > 0.75) continue;
      const dh = Math.hypot(door.centerX - h.body.px, door.centerZ - h.body.pz);
      if (dh > 22) continue;
      const score = dh + Math.hypot(door.centerX - goal.x, door.centerZ - goal.z);
      if (score < bestScore) {
        bestScore = score;
        best = door;
      }
    }
    return best;
  }

  coveredByHostage(x: number, z: number): boolean {
    return this.coverage.coveredByHostage(x, z);
  }

  civilianInLine(from: Vec3, to: Vec3): boolean {
    return this.coverage.civilianInLine(from, to);
  }

  friendlyInLine(shooter: SwatHunter, from: Vec3, to: Vec3): boolean {
    return this.coverage.friendlyInLine(shooter, from, to);
  }

  otherHunterPositions(exclude: SwatHunter): FriendlyPos[] {
    return this.coverage.otherHunterPositions(exclude);
  }

  // ---------- バリケード・トラップ委譲 ----------

  attachBarricades(hooks: BarricadeHooks): void {
    this.obstacles.attachBarricades(hooks);
  }

  tryShootBarricade(h: SwatHunter, dt: number): boolean {
    return this.obstacles.tryShootBarricade(h, dt);
  }

  attachTraps(traps: TrapHooks): void {
    this.obstacles.attachTraps(traps);
  }

  trapHeld(door: Door): boolean {
    return this.obstacles.trapHeld(door);
  }

  trapStillThere(door: Door): boolean {
    return this.obstacles.trapStillThere(door);
  }

  checkTraps(h: SwatHunter): void {
    this.obstacles.checkTraps(h);
  }

  abandonDisarm(door: Door): void {
    this.obstacles.abandonDisarm(door);
  }

  finishDisarm(h: SwatHunter, door: Door, success: boolean): void {
    this.obstacles.finishDisarm(h, door, success);
  }

  applyBlast(pos: Vec3, radius: number): void {
    this.obstacles.applyBlast(pos, radius);
  }

  // ---------- ユーティリティ・無線 ----------

  private firstAlive(): SwatHunter | undefined {
    return this.hunters.find((h) => h.alive);
  }

  private canPlayerHear(pos: Vec3, range: number): boolean {
    const p = this.d.player.position;
    return Math.hypot(p.x - pos.x, p.z - pos.z) <= range;
  }

  emitSwatFootstep(pos: Vec3, heavy: boolean): void {
    if (this.disposed) return;
    this.d.bus.emit('swatFootstep', { pos, heavy });
  }

  private emitRadioNow(h: SwatHunter, text: string, voice: string): void {
    this.radioCd = 3.5;
    this.radioSpeakGap = RADIO_STAGGER_SEC;
    const radioName = t('SWAT無線(傍受)', 'SWAT Radio (Intercepted)');
    this.d.bus.emit('allyRadio', { allyId: h.id, name: `${radioName} ${h.callsign}`, text, voiceText: voice });
  }

  private queueRadio(h: SwatHunter | undefined, text: string, voice: string): void {
    if (!h) return;
    if (this.radioSpeakGap <= 0 && this.radioQueue.length === 0) {
      this.emitRadioNow(h, text, voice);
    } else if (this.radioQueue.length < 4) {
      this.radioQueue.push({ hunter: h, text, voice });
    }
  }

  private radio(h: SwatHunter | undefined, text: string, voice: string, force = false): void {
    if (!h || (!force && this.radioCd > 0)) return;
    this.queueRadio(h, text, voice);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.tactics.dispose();
    this.radioQueue.length = 0;
    this.radioSpeakGap = 0;
    this.entry.dispose();
    for (const h of this.hunters) {
      this.d.weapons.removeTarget(h);
      h.dispose();
    }
    this.hunters.length = 0;
    disposeObject(this.root);
  }
}
