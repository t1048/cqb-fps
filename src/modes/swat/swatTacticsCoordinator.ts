import * as THREE from 'three';
import type { NoiseKind, NoiseSource } from '../../core/events';
import { t } from '../../core/i18n';
import {
  BREACH_CALL,
  C2_DETONATE,
  C2_PLANT,
  FLASH,
  LESS_LETHAL,
  NOISE_BY_KIND,
  PRESS_BY_STEP,
  RUSH_BY_REASON,
  contactInRoom,
  dugInGasLine,
  flankLine,
  manDownLine,
  pickRadio,
  reinforceLine,
} from '../../ai/radioLines';
import type { RoomDef, Vec3 } from '../../core/types';
import { resolveFloorY, type CombatContext } from '../../ai/EngageBehavior';
import { noiseRayOriginY } from '../../ai/Perception';
import {
  BASE_SHIELD_COMBAT,
  BASE_SWAT_COMBAT,
  BASE_SWAT_MOBILITY,
  SWAT_FLASH_CARRY_MAX,
  SWAT_FLASH_MAX_DIST,
  SWAT_FLASH_MIN_DIST,
  SWAT_FLASH_PER_TEAM,
  SWAT_GAS_MAX_DIST,
  SWAT_GAS_MIN_DIST,
  SWAT_GAS_PER_TEAM,
  SWAT_PEPPER_RANGE,
  SWAT_RUSH_LOW_HP,
  SWAT_RUSH_RADIUS,
  SWAT_RUSH_TEAM_COOLDOWN,
  isShieldRole,
} from '../../ai/SwatProfile';
import {
  C2_BLAST_RADIUS,
  computeBallisticVelocity,
  evaluateC2BlastCone,
  filterReachableExteriorEntries,
  isIndoorPoint,
  planFlashThrow,
  planPincerFlankGoal,
  selectPinningCell,
  shouldUseC2Breach,
  type EntryPortal,
  type EntryReach,
  type PinningCellInfo,
} from '../../ai/SwatTactics';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { Door } from '../../world/Door';
import { lerp, resolveSwatSpawns, shouldTriggerReinforcements, updateRoomStay } from './swatHelpers';
import { SwatHunter } from './SwatHunter';
import {
  BASE_REACTION_SEC,
  CAMP_GAS_THRESHOLD_SEC,
  CELL_NAMES,
  FLASH_REFILL_SEC,
  FLASH_TEAM_CD,
  GAS_TEAM_CD,
  HEARING_MUL,
  NAMES,
  OCCLUDED_MUL,
  PRESSURE_PER_DOWN,
  PRESSURE_RAMP_SEC,
  REINFORCEMENT_COOLDOWN_SEC,
  REINFORCEMENT_MAX_WAVES,
  REINFORCEMENT_MIN_HOLD_SEC,
  REINFORCEMENT_WAVE_SIZE,
  SELF_NOISE_RADIUS,
  SHIELD_COMBAT,
  SWAT_COMBAT,
  SWAT_MOBILITY,
  type SwatSpawn,
  type SwatTeamDeps,
  type SwatTeamHost,
} from './swatTypes';

const C2_FIREBALL_GEO = new THREE.SphereGeometry(1, 10, 8);
C2_FIREBALL_GEO.userData.shared = true;

export interface SwatTacticsHost {
  readonly d: SwatTeamDeps;
  readonly root: THREE.Group;
  readonly rooms: readonly RoomDef[];
  readonly hunters: SwatHunter[];
  readonly combatCtx: CombatContext;
  readonly baseSpawns: readonly SwatSpawn[];
  readonly teamHost: SwatTeamHost;
  readonly started: boolean;
  readonly disposed: boolean;
  readonly kills: number;
  readonly aliveCount: number;
  readonly radioCd: number;
  nextHunterId(): number;
  nextCellIndex(): number;
  assignCells(): void;
  portals(): EntryPortal[];
  reachablePortalLengths?(from: Vec3): readonly EntryReach[];
  abortStacking(): void;
  onDoorBreached(by: SwatHunter, doorId: string): void;
  disarmTrappedDoorOnC2(door: Door): void;
  roomAt(x: number, z: number, y: number): RoomDef | null;
  indoorRoomAt(x: number, z: number, y: number): RoomDef | null;
  unclearedIndoorRoom(h: SwatHunter): RoomDef | null;
  roomName(pos: Vec3): string;
  hostageShieldUp(): boolean;
  coveredByHostage(x: number, z: number): boolean;
  canPlayerHear(pos: Vec3, range: number): boolean;
  firstAlive(): SwatHunter | undefined;
  radio(h: SwatHunter | undefined, text: string, voice: string, force?: boolean): void;
  queueRadio(h: SwatHunter | undefined, text: string, voice: string): void;
}

/** チーム連携・C2・フラッシュ/ガス/ペッパー・圧力/インテル・挟撃・増援を担当するコーディネータ */
export class SwatTacticsCoordinator {
  lastSighting: Vec3 | null = null;
  private sightingAge = 0;
  private flashCd = 6;
  private flashesLeft = SWAT_FLASH_PER_TEAM;
  private flashRefill = 0;
  /** 突入開始からの秒数と圧力(0〜1)。倒された隊員の数でも上がる */
  private assaultSec = 0;
  private downBonus = 0;
  private pressure = 0;
  private pressureTick = 0;
  private pressureStep = 0;
  reactionSec = BASE_REACTION_SEC;
  private contactCd = 0;
  private rushCd = 0;
  /** 挟撃・ピンサー機動（F7）の状態 */
  private pinningCellIndex: number | null = null;
  private pincerTargetRoomId: string | null = null;
  private pincerRefreshCd = 0;
  private pincerPlanCd = 0;
  private pincerRadioCd = 0;
  /** C2 爆破ブリーチ（F8）の状態・常設ライト（visible=false でフラグメントシェーダへの PointLight 混入と再コンパイルを両方防止） */
  private readonly encounteredLockedDoors = new Set<string>();
  readonly c2BlastLight = new THREE.PointLight(0xffb866, 0, 14, 2);
  private readonly c2Blasts: { mesh: THREE.Mesh; t: number }[] = [];
  /** 催涙ガス・籠城監視（F10） */
  private playerRoomId: string | null = null;
  private playerRoomStaySec = 0;
  private gasCd = 8;
  private gasRetryCd = 0;
  private gasLeft = SWAT_GAS_PER_TEAM;
  /** 統計 */
  pepperShots = 0;
  /** 増援ウェーブ（F13） */
  private readonly reinforcementsEnabled: boolean;
  private wavesSpawned = 0;
  private killsAtLastWave = 0;
  private waveCooldown = 0;
  private lastHoldLeft = Infinity;
  private lastReinforcementPortalId: string | null = null;
  private readonly chestScratch: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly rayOriginScratch: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(private readonly host: SwatTacticsHost) {
    this.reinforcementsEnabled = Boolean(host.d.reinforcements);
    this.c2BlastLight.visible = false;
    this.host.root.add(this.c2BlastLight);
  }

  get currentPressure(): number {
    return this.pressure;
  }

  get lastSightingAge(): number {
    return this.sightingAge;
  }

  get reinforcementWavesSpawned(): number {
    return this.wavesSpawned;
  }

  get hasPendingReinforcements(): boolean {
    return (
      this.reinforcementsEnabled &&
      this.wavesSpawned < REINFORCEMENT_MAX_WAVES &&
      this.lastHoldLeft >= REINFORCEMENT_MIN_HOLD_SEC
    );
  }

  tickTimers(dt: number): void {
    this.flashCd = Math.max(0, this.flashCd - dt);
    this.gasCd = Math.max(0, this.gasCd - dt);
    this.gasRetryCd = Math.max(0, this.gasRetryCd - dt);
    this.contactCd = Math.max(0, this.contactCd - dt);
    this.rushCd = Math.max(0, this.rushCd - dt);
    this.pincerRefreshCd = Math.max(0, this.pincerRefreshCd - dt);
    this.pincerPlanCd = Math.max(0, this.pincerPlanCd - dt);
    this.pincerRadioCd = Math.max(0, this.pincerRadioCd - dt);
    this.waveCooldown = Math.max(0, this.waveCooldown - dt);
    this.sightingAge += dt;
  }

  // ---------- 増援・撤収 ----------

  /** 残り時間・撃破数に応じて増援ウェーブ（F13）の突入を判定・実行する */
  checkReinforcements(holdLeftSec: number): boolean {
    this.lastHoldLeft = holdLeftSec;
    const should = shouldTriggerReinforcements({
      enabled: this.reinforcementsEnabled,
      started: this.host.started,
      wavesSpawned: this.wavesSpawned,
      maxWaves: REINFORCEMENT_MAX_WAVES,
      aliveCount: this.host.aliveCount,
      killsSinceLastWave: this.host.kills - this.killsAtLastWave,
      holdLeftSec,
      cooldownSec: this.waveCooldown,
    });
    if (!should) return false;
    return this.spawnReinforcements() > 0;
  }

  /** 外周から新規 2 名セル（盾持ち＋ライフル）を増援として突入させる */
  spawnReinforcements(count = REINFORCEMENT_WAVE_SIZE): number {
    if (this.host.disposed || !this.reinforcementsEnabled || this.wavesSpawned >= REINFORCEMENT_MAX_WAVES || count <= 0) return 0;
    const anchor = this.host.baseSpawns[0] ?? { x: 0, y: 0, z: 0 };
    const reachable = filterReachableExteriorEntries(this.host.portals(), anchor, this.host.d.colliders, this.host.d.bounds);
    const refPos = this.lastSighting ?? this.host.d.player.position;
    let chosenPortal: EntryPortal | null = null;
    if (reachable.length > 0) {
      const fresh = reachable.filter((p) => p.id !== this.lastReinforcementPortalId);
      const pool = fresh.length > 0 ? fresh : reachable;
      chosenPortal = pool.reduce((best, p) => {
        const dBest = Math.hypot(best.outside.x - refPos.x, best.outside.z - refPos.z);
        const dCur = Math.hypot(p.outside.x - refPos.x, p.outside.z - refPos.z);
        return dCur > dBest ? p : best;
      }, pool[0]!);
      this.lastReinforcementPortalId = chosenPortal.id;
    }

    const spawns = chosenPortal
      ? resolveSwatSpawns([chosenPortal.outside], count, this.host.d.colliders)
      : resolveSwatSpawns(this.host.baseSpawns, count, this.host.d.colliders);
    const cellIdx = this.host.nextCellIndex();
    const cellName = CELL_NAMES[cellIdx % CELL_NAMES.length]!;
    const members: SwatHunter[] = [];
    const focus = this.host.rooms[0];

    for (let k = 0; k < spawns.length; k++) {
      const idNum = this.host.nextHunterId();
      const shielded = isShieldRole(k, spawns.length);
      const h = new SwatHunter(
        `swat_${idNum}`,
        `${cellName}-${k + 1}`,
        NAMES[(idNum - 1) % NAMES.length]!,
        spawns[k]!,
        this.host.teamHost,
        this.host.combatCtx,
        this.host.d.bus,
        this.host.d.textures,
        shielded,
      );
      h.cell = members;
      h.cellIndex = cellIdx;
      h.cellName = cellName;
      h.assignedPortal = chosenPortal;
      members.push(h);
      this.host.hunters.push(h);
      this.host.root.add(h.body.group);
      this.host.root.add(h.optics.group);
      this.host.d.weapons.addTarget(h);
      if (focus) h.body.faceToward(focus.x, focus.z);
      if (this.host.started) {
        if (this.lastSighting) {
          h.huntTarget = { ...this.lastSighting };
          h.setState('hunt');
        } else {
          h.setState('sweep');
        }
      }
    }

    this.wavesSpawned++;
    this.killsAtLastWave = this.host.kills;
    this.waveCooldown = REINFORCEMENT_COOLDOWN_SEC;
    if (members[0]) {
      const [reJa, reEn] = reinforceLine(cellName);
      this.host.queueRadio(members[0], reJa, reEn);
    }
    this.host.d.subtitle.show(
      t(
        `SWAT 増援（${cellName}班 ${members.length}名）が外周から突入した！`,
        `SWAT reinforcements (${cellName} team, ${members.length} units) breached from the perimeter!`,
      ),
      2.6,
    );
    return members.length;
  }

  /** 交渉で突入班を 1 名下げる（最後尾の隊員を撤収）。成功で true */
  withdraw(): boolean {
    if (this.host.started || this.host.hunters.length <= 1) return false;
    const h = this.host.hunters.pop()!;
    this.host.assignCells(); // 人数が変わったので組み直す（4 → 3 なら 2+2 → 3 人組 1 つ）
    this.host.d.weapons.removeTarget(h);
    this.host.root.remove(h.body.group);
    this.host.root.remove(h.optics.group);
    h.dispose();
    return true;
  }

  // ---------- チーム連携 ----------

  shareSighting(pos: Vec3): void {
    this.lastSighting = { x: pos.x, y: pos.y, z: pos.z };
    this.sightingAge = 0;
  }

  /** 初回目撃: 警告を叫び、無線で全隊へ位置を通報する。 */
  onContact(by: SwatHunter, pos: Vec3): void {
    this.host.abortStacking();
    this.shareSighting(pos);
    if (this.contactCd <= 0) {
      this.contactCd = 6;
      const chest = by.body.chestPos();
      const dx = pos.x - by.body.px;
      const dz = pos.z - by.body.pz;
      const l = Math.hypot(dx, dz) || 1;
      this.host.d.bus.emit('warningCall', { pos: chest, dir: { x: dx / l, y: 0, z: dz / l } });
      if (this.host.canPlayerHear(chest, 18)) {
        this.host.d.subtitle.show(t('SWAT「警察だ！武器を捨てろ！」', 'SWAT: "Police! Drop your weapon!"'), 2.0);
      }
      const room = this.host.roomName(pos);
      const [contactJa, contactEn] = contactInRoom(room);
      this.host.radio(by, contactJa, contactEn, true);
    }
    this.alertTeam(pos, true, 30, by);
    if (this.host.d.player.hp !== undefined && this.host.d.player.hp > 0 && this.host.d.player.hp <= SWAT_RUSH_LOW_HP) {
      this.triggerRush(pos, 'lowHp');
    }
  }

  /** プレイヤーの隙（白飛び・リロード・ペッパー命中・低HP）を突いて近隣の隊員を一斉突撃させる。 */
  triggerRush(pos: Vec3, reason: 'blind' | 'reload' | 'pepper' | 'lowHp'): boolean {
    if (!this.host.started || this.rushCd > 0) return false;
    this.host.abortStacking();
    const candidates = this.host.hunters
      .filter((h) => h.alive && h.blindLeft <= 0 && h.state !== 'staging' && h.state !== 'breach' && h.state !== 'disarm')
      .map((h) => ({
        h,
        dist: Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) + Math.abs(h.body.footY - pos.y) * 3,
      }))
      .filter((x) => x.dist <= SWAT_RUSH_RADIUS)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);
    if (candidates.length === 0) return false;
    for (const { h } of candidates) {
      h.rushTarget = { x: pos.x, y: pos.y, z: pos.z };
      h.known = { x: pos.x, y: pos.y, z: pos.z };
      h.setState('rush');
    }
    this.rushCd = SWAT_RUSH_TEAM_COOLDOWN;
    this.shareSighting(pos);
    const [ja, en] = pickRadio(RUSH_BY_REASON[reason]);
    this.host.radio(candidates[0]!.h, ja, en, true);
    return true;
  }

  /**
   * 位置情報を共有し、交戦中でない隊員を向かわせる。
   * visual=true かつ生存セルが 2 つ以上ある場合は F7（役割分担による挟撃・ピンサー機動）を起動し、
   * 正面班（盾持ち/接敵班）が正面から釘付けにし、別班を別ドア・別部屋・別階段ルートへ回り込ませる。
   */
  alertTeam(pos: Vec3, visual: boolean, maxDist = 30, contactBy?: SwatHunter): void {
    if (visual) {
      this.host.abortStacking();
      const cellMap = new Map<number, SwatHunter[]>();
      for (const h of this.host.hunters) {
        if (!h.alive) continue;
        let grp = cellMap.get(h.cellIndex);
        if (!grp) {
          grp = [];
          cellMap.set(h.cellIndex, grp);
        }
        grp.push(h);
      }
      if (cellMap.size >= 2) {
        const cellInfos: PinningCellInfo[] = [];
        for (const [cellIndex, members] of cellMap) {
          let sx = 0;
          let sy = 0;
          let sz = 0;
          for (const m of members) {
            sx += m.body.px;
            sy += m.body.footY;
            sz += m.body.pz;
          }
          const n = members.length;
          cellInfos.push({
            cellIndex,
            aliveCount: n,
            hasShield: members.some((m) => m.shielded),
            engaged: members.some((m) => m.state === 'engage' || m.state === 'rush'),
            center: { x: sx / n, y: sy / n, z: sz / n },
          });
        }
        const prevPin = this.pinningCellIndex;
        const preferredPin = contactBy?.cellIndex ?? prevPin ?? cellInfos[0]!.cellIndex;
        const pinIdx = selectPinningCell(cellInfos, preferredPin, pos);
        this.pinningCellIndex = pinIdx;
        const newRoomId = this.host.roomAt(pos.x, pos.z, pos.y)?.id ?? null;
        const roomChanged = newRoomId !== this.pincerTargetRoomId;
        this.pincerTargetRoomId = newRoomId;

        let activeFlanking = false;
        if (!roomChanged && pinIdx === prevPin && this.pincerPlanCd > 0) {
          for (const [cellIndex, members] of cellMap) {
            if (cellIndex === pinIdx) continue;
            if (members.some((m) => m.huntingFlank && m.huntTarget !== null)) {
              activeFlanking = true;
              break;
            }
          }
        }
        if (activeFlanking) {
          const pinMembers = cellMap.get(pinIdx);
          if (pinMembers) {
            for (const h of pinMembers) {
              if (h.state === 'engage' || h.state === 'rush' || h.state === 'staging' || h.state === 'breach' || h.state === 'disarm') continue;
              const target = { x: pos.x, y: pos.y, z: pos.z };
              if (this.holdUnclearedRoom(h, target, false)) continue;
              h.huntTarget = target;
              h.huntingFlank = false;
              h.setState('hunt');
            }
          }
          return;
        }

        this.pincerPlanCd = 1.0;
        const pinInfo = cellInfos.find((c) => c.cellIndex === pinIdx)!;
        const portals = this.host.portals();
        const usedFlankDoors = new Set<string>();
        let flankSpeaker: SwatHunter | undefined;
        let flankAssigned = false;

        for (const [cellIndex, members] of cellMap) {
          if (cellIndex === pinIdx) {
            for (const h of members) {
              if (h.state === 'engage' || h.state === 'rush' || h.state === 'staging' || h.state === 'breach' || h.state === 'disarm') continue;
              const target = { x: pos.x, y: pos.y, z: pos.z };
              if (this.holdUnclearedRoom(h, target, false)) continue;
              h.huntTarget = target;
              h.huntingFlank = false;
              h.setState('hunt');
            }
            continue;
          }
          const lead = members[0]!;
          const flankerPos = { x: lead.body.px, y: lead.body.footY, z: lead.body.pz };
          const flankerIndoor = isIndoorPoint(this.host.rooms, flankerPos.x, flankerPos.z, flankerPos.y);
          const flank = planPincerFlankGoal({
            playerPos: pos,
            frontalPos: pinInfo.center,
            flankerPos,
            rooms: this.host.rooms,
            doors: this.host.d.doors.doors,
            stairs: this.host.d.stairs,
            colliders: this.host.d.colliders,
            excludeDoorIds: usedFlankDoors,
            bounds: this.host.d.bounds,
            entries: portals,
            entryLengths: !flankerIndoor ? this.host.reachablePortalLengths?.(flankerPos) : undefined,
          });
          if (flank?.doorId) usedFlankDoors.add(flank.doorId);
          for (const h of members) {
            if (h.state === 'engage' || h.state === 'rush' || h.state === 'staging' || h.state === 'breach' || h.state === 'disarm') continue;
            const target = flank ? { ...flank.target } : { x: pos.x, y: pos.y, z: pos.z };
            if (this.holdUnclearedRoom(h, target, flank !== null)) continue;
            h.huntTarget = target;
            h.huntingFlank = flank !== null;
            h.setState('hunt');
            if (flank) {
              flankAssigned = true;
              flankSpeaker = flankSpeaker ?? h;
            }
          }
        }
        if (flankAssigned && (roomChanged || this.pincerRadioCd <= 0)) {
          this.pincerRadioCd = 10;
          const pinMembers = cellMap.get(pinIdx)!;
          const pinName = pinMembers[0]!.cellName;
          const flankName = flankSpeaker!.cellName;
          const [flankJa, flankEn] = flankLine(`${pinName}班`, `${flankName}班`);
          this.host.radio(pinMembers[0], flankJa, flankEn, true);
        }
        return;
      }
    }

    for (const h of this.host.hunters) {
      if (!h.alive || h.state === 'engage' || h.state === 'rush' || h.state === 'staging' || h.state === 'breach' || h.state === 'disarm') continue;
      const d = Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) + Math.abs(h.body.footY - pos.y) * 3;
      if (!visual && d > maxDist) continue;
      if (h.leader && h.leader.alive && !visual) continue; // 音の調査は組のリーダーが判断
      const target = { x: pos.x, y: pos.y, z: pos.z };
      if (this.holdUnclearedRoom(h, target, false)) continue;
      h.huntTarget = target;
      h.huntingFlank = false;
      h.setState('hunt');
    }
  }

  /**
   * 未クリアの屋内にいる隊員を、隣室や迂回先の扉へ送り出さない。
   * 同じ部屋の中の目標（正面からの釘付け）はそのまま追わせる。
   */
  private holdUnclearedRoom(h: SwatHunter, target: Vec3, flanking: boolean): boolean {
    const room = this.host.unclearedIndoorRoom(h);
    if (!room) return false;
    const dest = this.host.indoorRoomAt(target.x, target.z, target.y);
    if (!flanking && dest?.id === room.id) return false;
    h.huntingFlank = false;
    h.huntTarget = null;
    if (h.state !== 'sweep') h.setState('sweep');
    return true;
  }

  onNoise(pos: Vec3, radius: number, kind: NoiseKind, source?: NoiseSource): void {
    if (!this.host.started || source === 'suspect' || source === 'ally' || kind === 'flash') return;
    // 隊員自身のドア操作・ブリーチ音は無視する（プレイヤー由来の発砲・リロード・咳は近距離でも必ず拾う）
    const isPlayerReload = kind === 'reload' && source === 'player';
    const isPlayerNoise = source === 'player';
    if (kind !== 'gunshot' && !isPlayerNoise) {
      for (const h of this.host.hunters) {
        if (h.alive && Math.hypot(h.body.px - pos.x, h.body.pz - pos.z) < SELF_NOISE_RADIUS) return;
      }
    }
    const rayY = noiseRayOriginY(pos, kind);
    this.rayOriginScratch.x = pos.x;
    this.rayOriginScratch.y = rayY;
    this.rayOriginScratch.z = pos.z;
    const target = { x: pos.x, y: resolveFloorY(pos, this.host.d.rooms, kind), z: pos.z };
    let heard = false;
    for (const h of this.host.hunters) {
      if (!h.alive || h.state === 'staging') continue;
      const c = h.body.chestPos(this.chestScratch);
      const dist = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
      let r = radius * HEARING_MUL;
      if (dist > r) continue;
      if (kind !== 'gunshot' && kind !== 'breach' && !hasLineOfSight(this.host.d.colliders, this.rayOriginScratch, c)) {
        r *= OCCLUDED_MUL;
        if (dist > r) continue;
      }
      heard = true;
      if (isPlayerNoise && h.state === 'stack') {
        h.huntTarget = target;
      }
      if (
        h.state === 'engage' ||
        h.state === 'rush' ||
        h.state === 'breach' ||
        h.state === 'stack' ||
        h.state === 'pie' ||
        h.state === 'entry' ||
        h.state === 'disarm' ||
        h.state === 'restrain'
      ) continue;
      if (h.huntingFlank) continue;
      if (h.leader && h.leader.alive) continue;
      if (this.holdUnclearedRoom(h, target, false)) continue;
      h.huntTarget = target;
      h.setState('hunt');
    }
    if (heard && isPlayerReload) {
      this.triggerRush(target, 'reload');
      return;
    }
    if (heard && this.host.radioCd <= 0) {
      const noisePool = NOISE_BY_KIND[kind];
      if (noisePool) {
        const [noiseJa, noiseEn] = pickRadio(noisePool);
        this.host.radio(this.host.firstAlive(), noiseJa, noiseEn);
      }
    }
  }

  onManDown(h: SwatHunter): void {
    const buddy = h.cell.find((x) => x !== h && x.alive);
    const speaker = buddy ?? this.host.firstAlive();
    this.downBonus += PRESSURE_PER_DOWN;
    this.applyPressure();
    if (this.host.aliveCount === 0) return;
    if (h.cellIndex === this.pinningCellIndex && !h.cell.some((m) => m.alive)) {
      this.pinningCellIndex = null;
    }
    const [downJa, downEn] = manDownLine(h.callsign);
    this.host.radio(speaker, downJa, downEn, true);
    // 組のリーダーが倒れたら次の序列の隊員が自動的にリーダーを引き継ぐ（leader ゲッター）。相方が全滅すれば単独行動
    const p = this.host.d.player.position;
    this.alertTeam({ x: p.x, y: p.y, z: p.z }, true);
  }

  onBreach(by: SwatHunter, door: Door): void {
    const [breachJa, breachEn] = pickRadio(BREACH_CALL);
    this.host.radio(by, breachJa, breachEn, true);
    // 突入前に閃光弾を投げ込む
    const side = (by.body.px - door.centerX) * door.normalX + (by.body.pz - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
    const target = {
      x: door.centerX - door.normalX * side * 2.6,
      y: door.sillY,
      z: door.centerZ - door.normalZ * side * 2.6,
    };
    if (this.flashesLeft > 0 && this.flashCd <= 4) this.throwFlash(by, target, 1.4);
    this.host.onDoorBreached(by, door.id);
  }

  /** プレイヤーが別の部屋へ移動したら、挟撃（F7）の迂回先を再計画する */
  updatePincerRefresh(): void {
    if (this.pinningCellIndex === null || this.pincerRefreshCd > 0) return;
    const active = this.host.hunters.some((h) => h.alive && (h.state === 'engage' || h.state === 'rush')) || this.sightingAge < 6;
    if (!active) {
      this.pinningCellIndex = null;
      this.pincerTargetRoomId = null;
      return;
    }
    if (!this.lastSighting) return;
    const curRoomId = this.host.roomAt(this.lastSighting.x, this.lastSighting.z, this.lastSighting.y)?.id ?? null;
    if (curRoomId !== this.pincerTargetRoomId) {
      this.pincerRefreshCd = 2.5;
      this.alertTeam(this.lastSighting, true);
    }
  }

  // ---------- C2 爆破ブリーチ（F8） ----------

  /** 施錠ドア遭遇数を記録し、高圧力または 2 枚目以降の施錠ドアなら C2 爆破を選択する */
  shouldUseC2(doorId: string): boolean {
    this.encounteredLockedDoors.add(doorId);
    return shouldUseC2Breach(this.pressure, this.encounteredLockedDoors.size);
  }

  onC2PlantStart(by: SwatHunter, door: Door): void {
    const [plantJa, plantEn] = pickRadio(C2_PLANT);
    this.host.radio(by, plantJa, plantEn, true);
    if (this.host.canPlayerHear({ x: door.centerX, y: door.sillY, z: door.centerZ }, 10)) {
      this.host.d.subtitle.show(
        t('ドアの向こうで C2 爆薬を設置している音がする…！', 'You hear C2 explosives being planted on the other side of the door...!'),
        2.0,
      );
    }
  }

  emitC2Beep(door: Door, urgent: boolean): void {
    this.host.d.bus.emit('c2Beep', {
      pos: { x: door.centerX, y: door.sillY + 1.0, z: door.centerZ },
      urgent,
    });
  }

  /** C2 を起爆: ドアのトラップを安全に無力化し、高速爆破開放 + 反対側への指向性爆風・視界揺れ・スタンを与える */
  detonateC2(by: SwatHunter, door: Door, side: number): void {
    // プレイヤーのブービートラップが仕掛けてあれば遠隔起爆前に安全に無力化する
    this.host.disarmTrappedDoorOnC2(door);
    const opened = door.breachExplosive(by.body.px, by.body.pz);
    if (!opened) return;

    const blastDir: Vec3 = { x: -door.normalX * side, y: 0, z: -door.normalZ * side };
    const doorCenter: Vec3 = { x: door.centerX, y: door.sillY + 1.0, z: door.centerZ };
    // 扉コライダがまだ閉位置の同一フレームで自己遮蔽しないよう、爆風方向へ 0.25m オフセットする
    const blastOrigin: Vec3 = {
      x: doorCenter.x + blastDir.x * 0.25,
      y: doorCenter.y,
      z: doorCenter.z + blastDir.z * 0.25,
    };

    const fireball = new THREE.Mesh(
      C2_FIREBALL_GEO,
      new THREE.MeshBasicMaterial({
        color: 0xffb85c,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    fireball.scale.setScalar(0.45);
    fireball.position.set(blastOrigin.x, blastOrigin.y, blastOrigin.z);
    this.host.root.add(fireball);
    this.c2Blasts.push({ mesh: fireball, t: 0 });
    this.c2BlastLight.position.set(blastOrigin.x, blastOrigin.y, blastOrigin.z);

    this.host.d.bus.emit('c2Detonated', { doorId: door.id, pos: doorCenter, dir: blastDir, radius: C2_BLAST_RADIUS });
    const [detJa, detEn] = pickRadio(C2_DETONATE);
    this.host.radio(by, detJa, detEn, true);

    let playerStunned = false;
    if (this.host.d.player.alive) {
      const eye = this.host.d.player.getEyePosition();
      const blast = evaluateC2BlastCone(blastOrigin, blastDir, eye);
      if (blast.dist < C2_BLAST_RADIUS * 1.6) {
        const shakeScale = blast.inCone ? 1.0 : 0.45;
        const k = (1 - blast.dist / (C2_BLAST_RADIUS * 1.6)) * shakeScale;
        this.host.d.player.addViewKick?.((0.08 + Math.random() * 0.06) * k, (Math.random() - 0.5) * 0.14 * k);
      }
      if (blast.inCone && hasLineOfSight(this.host.d.colliders, blastOrigin, eye)) {
        const hp = this.host.d.player.takeDamage(blast.damage);
        this.host.d.bus.emit('playerHit', { shooter: by.id, damage: blast.damage, from: blastOrigin, hp });
        const blindDur = 1.4 * blast.stunScale;
        this.host.d.flashOverlay?.trigger(0.45 * blast.stunScale, blindDur, 0.75 * blast.stunScale);
        this.host.d.bus.emit('playerBlinded', {
          duration: blindDur,
          pos: { x: this.host.d.player.position.x, y: this.host.d.player.position.y, z: this.host.d.player.position.z },
        });
        this.host.d.subtitle.show(t('C2爆破の爆風と衝撃波を受けた！', 'Hit by the C2 blast and shockwave!'), 2.0);
        playerStunned = true;
      }
    }
    if (!playerStunned && this.flashesLeft > 0 && this.flashCd <= 4) {
      const target = {
        x: door.centerX + blastDir.x * 2.6,
        y: door.sillY,
        z: door.centerZ + blastDir.z * 2.6,
      };
      this.throwFlash(by, target, 1.4);
    }
    this.host.onDoorBreached(by, door.id);
  }

  /** C2 爆破の火球メッシュを減衰・破棄する（共有ジオメトリは破棄せず、常設ライトも visible=false のまま維持） */
  updateC2Blasts(dt: number): void {
    for (let i = this.c2Blasts.length - 1; i >= 0; i--) {
      const b = this.c2Blasts[i]!;
      b.t += dt;
      if (b.t < 0.45) {
        const s = 0.45 * (1 + b.t * 5.2);
        b.mesh.scale.setScalar(s);
        (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - b.t / 0.45));
      } else {
        b.mesh.visible = false;
      }
      if (b.t > 0.55) {
        this.host.root.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        this.c2Blasts.splice(i, 1);
      }
    }
  }

  // ---------- 閃光弾・催涙ガス・ペッパー ----------

  /** 追跡中、潜伏推定位置が近く直接視認できていなければ閃光弾を投げ込む（ドア枠・窓・壁バウンド含む）。 */
  tryFlash(by: SwatHunter, target: Vec3): void {
    if (by.flashRetryCd > 0 || this.flashCd > 0 || this.flashesLeft <= 0 || this.sightingAge > 12 || this.host.hostageShieldUp()) return; // 人質が巻き込まれるので投げない
    const d = Math.hypot(target.x - by.body.px, target.z - by.body.pz);
    if (d < 2.0 || d > SWAT_FLASH_MAX_DIST + 2 || Math.abs(target.y - by.body.footY) > 0.75) return;
    const from = by.body.chestPos(this.chestScratch);
    const origin = { x: from.x, y: from.y + 0.25, z: from.z };
    const plan = planFlashThrow(
      origin,
      target,
      this.host.d.doors.doors,
      this.host.d.windows ?? [],
      this.host.d.colliders,
      this.host.d.flashbang.gravity,
      SWAT_FLASH_MIN_DIST,
      SWAT_FLASH_MAX_DIST,
    );
    if (!plan) {
      by.flashRetryCd = 0.35;
      return;
    }
    this.launchFlash(by, origin, plan.velocity, plan.fuse);
  }

  /** ホットスポット対策用: 追跡条件（目撃の鮮度など）に縛られず、指定地点へ閃光を投げ込めるか */
  flashAvailable(): boolean {
    return this.flashesLeft > 0 && this.flashCd <= 3 && !this.host.hostageShieldUp();
  }

  /** 指定地点（階段室・ドア隙間の先）へ閃光を投げる。間接投擲（ドア枠・窓・壁バウンド）が計画できなければ直射の弾道で投げる */
  throwFlashAtSpot(by: SwatHunter, target: Vec3): boolean {
    if (!this.flashAvailable()) return false;
    const from = by.body.chestPos(this.chestScratch);
    const origin = { x: from.x, y: from.y + 0.25, z: from.z };
    const d = Math.hypot(target.x - origin.x, target.z - origin.z);
    if (d < 1.8 || d > SWAT_FLASH_MAX_DIST + 2) return false;
    const plan = planFlashThrow(
      origin,
      target,
      this.host.d.doors.doors,
      this.host.d.windows ?? [],
      this.host.d.colliders,
      this.host.d.flashbang.gravity,
      Math.min(SWAT_FLASH_MIN_DIST, 2.2),
      SWAT_FLASH_MAX_DIST,
    );
    if (plan) {
      this.launchFlash(by, origin, plan.velocity, plan.fuse);
      return true;
    }
    // 階段室など: 目標高さを狙って山なりに投げる（天井・壁で跳ねる）
    if (Math.abs(target.y - origin.y) > 4) return false;
    this.throwFlash(by, target, 1.5);
    return true;
  }

  gasAvailable(): boolean {
    return !!this.host.d.tearGas && this.gasLeft > 0 && this.gasCd <= 0 && !this.host.hostageShieldUp();
  }

  /** 指定地点へ催涙ガスを投げ込む（planFlashThrow の間接投擲を使う） */
  throwGasAtSpot(by: SwatHunter, target: Vec3): boolean {
    const gas = this.host.d.tearGas;
    if (!gas || !this.gasAvailable()) return false;
    const origin: Vec3 = { x: by.body.px, y: by.body.footY + 1.35, z: by.body.pz };
    const plan = planFlashThrow(
      origin,
      target,
      this.host.d.doors.doors,
      this.host.d.windows ?? [],
      this.host.d.colliders,
      gas.gravity ?? 9.8,
      SWAT_GAS_MIN_DIST,
      SWAT_GAS_MAX_DIST,
    );
    if (!plan) return false;
    gas.throwFrom(origin, plan.velocity, by.id, plan.fuse);
    this.gasLeft--;
    this.gasCd = THREE.MathUtils.lerp(GAS_TEAM_CD, GAS_TEAM_CD * 0.65, this.pressure);
    const [gasJa, gasEn] = dugInGasLine(this.host.roomName(target));
    this.host.queueRadio(by, gasJa, gasEn);
    return true;
  }

  throwFlash(by: SwatHunter, target: Vec3, fuse: number): void {
    const from = by.body.chestPos(this.chestScratch);
    const origin = { x: from.x, y: from.y + 0.25, z: from.z };
    const vel = computeBallisticVelocity(origin, { x: target.x, y: target.y + 0.3, z: target.z }, this.host.d.flashbang.gravity, 9, 0.35, 0.9);
    this.launchFlash(by, origin, vel, fuse);
  }

  launchFlash(by: SwatHunter, origin: Vec3, velocity: Vec3, fuse: number): void {
    this.host.d.flashbang.throwFrom(origin, velocity, by.id, fuse);
    this.flashesLeft--;
    this.flashCd = lerp(FLASH_TEAM_CD, FLASH_TEAM_CD * 0.5, this.pressure);
    const [flashJa, flashEn] = pickRadio(FLASH);
    this.host.radio(by, flashJa, flashEn, true);
  }

  /** F10: プレイヤーが同じ室内に一定時間以上籠り続けたら CS 催涙ガスを投げ込む */
  updateAntiCamping(dt: number): void {
    const p = this.host.d.player.position;
    const room = this.host.roomAt(p.x, p.z, p.y);
    const next = updateRoomStay(this.playerRoomId, this.playerRoomStaySec, room?.id ?? null, dt);
    this.playerRoomId = next.roomId;
    this.playerRoomStaySec = next.staySec;

    if (!room || !this.host.d.tearGas || this.gasLeft <= 0 || this.gasCd > 0 || this.gasRetryCd > 0) return;
    const threshold = THREE.MathUtils.lerp(CAMP_GAS_THRESHOLD_SEC, CAMP_GAS_THRESHOLD_SEC - 4, this.pressure);
    if (this.playerRoomStaySec < threshold) return;
    if (this.host.hostageShieldUp()) return;

    if (this.tryThrowGas(room, { x: p.x, y: p.y, z: p.z })) {
      this.playerRoomStaySec = 0;
    } else {
      this.gasRetryCd = 0.5;
    }
  }

  tryThrowGas(room: RoomDef, playerPos: Vec3): boolean {
    const gas = this.host.d.tearGas;
    if (!gas) return false;
    const targets: Vec3[] = [
      playerPos,
      { x: room.x, y: room.floorY ?? 0, z: room.z },
    ];
    for (const h of this.host.hunters) {
      if (
        !h.alive ||
        h.state === 'staging' ||
        h.state === 'disarm' ||
        h.state === 'breach' ||
        h.blindLeft > 0
      ) {
        continue;
      }
      if (Math.abs(h.body.footY - playerPos.y) > 0.85) continue;
      const origin: Vec3 = { x: h.body.px, y: h.body.footY + 1.35, z: h.body.pz };
      for (const target of targets) {
        const plan = planFlashThrow(
          origin,
          target,
          this.host.d.doors.doors,
          this.host.d.windows ?? [],
          this.host.d.colliders,
          gas.gravity ?? 9.8,
          SWAT_GAS_MIN_DIST,
          SWAT_GAS_MAX_DIST,
        );
        if (!plan) continue;
        gas.throwFrom(origin, plan.velocity, h.id, plan.fuse);
        this.gasLeft--;
        this.gasCd = THREE.MathUtils.lerp(GAS_TEAM_CD, GAS_TEAM_CD * 0.65, this.pressure);
        const [gasJa, gasEn] = dugInGasLine(room.name);
        this.host.queueRadio(h, gasJa, gasEn);
        return true;
      }
    }
    return false;
  }

  /** 盾持ちへのペッパーボール。命中はプレイヤー本人か抱えた人質（人質は暴れ、盾が崩れやすくなる） */
  firePepper(by: SwatHunter, at: Vec3): void {
    const eye = by.body.footY + 1.55;
    const from = { x: by.body.px, y: eye, z: by.body.pz };
    const dist = Math.hypot(at.x - from.x, at.z - from.z);
    if (dist > SWAT_PEPPER_RANGE) return;
    this.pepperShots++;
    this.host.d.bus.emit('noise', { pos: from, radius: 14, kind: 'gunshot', source: 'ally' });
    if (this.host.radioCd <= 0 && Math.random() < 0.3) {
      const [lessJa, lessEn] = pickRadio(LESS_LETHAL);
      this.host.radio(by, lessJa, lessEn);
    }
    const hitChance = Math.max(0.2, 0.75 - dist * 0.025);
    if (Math.random() >= hitChance) return;
    let holding = false;
    for (const c of this.host.d.civilians()) {
      if (c.alive && c.shieldedBy === 'player') {
        holding = true;
        break;
      }
    }
    const target = holding && Math.random() < 0.22 ? 'hostage' : 'player';
    this.host.d.onPepper?.(target);
    if (target === 'player') {
      const p = this.host.d.player.position;
      this.triggerRush({ x: p.x, y: p.y, z: p.z }, 'pepper');
    }
  }

  // ---------- 圧力・インテル・制圧 ----------

  /** 圧力を進め、SWAT の積極性・閃光補充・ドローン探知を更新する */
  updatePressure(dt: number): void {
    // 人質を盾にして立ち回っている間は SWAT も手が出しにくく、圧力の上昇が鈍る
    this.assaultSec += dt * (this.host.hostageShieldUp() ? 0.5 : 1);
    this.pressureTick -= dt;
    if (this.pressureTick <= 0) {
      this.pressureTick = 0.5;
      this.applyPressure();
    }
    this.flashRefill += dt;
    if (this.flashRefill >= FLASH_REFILL_SEC * lerp(1, 0.55, this.pressure)) {
      this.flashRefill = 0;
      if (this.flashesLeft < SWAT_FLASH_CARRY_MAX) this.flashesLeft++;
    }
  }

  applyPressure(): void {
    const p = Math.min(1, this.assaultSec / PRESSURE_RAMP_SEC + this.downBonus);
    this.pressure = p;
    this.reactionSec = lerp(BASE_REACTION_SEC, 0.16, p);
    const c = SWAT_COMBAT;
    const b = BASE_SWAT_COMBAT;
    c.coverSecMin = lerp(b.coverSecMin, 0.25, p);
    c.coverSecMax = lerp(b.coverSecMax, 0.65, p);
    c.fireInterval = lerp(b.fireInterval, 0.14, p);
    c.baseSpreadDeg = lerp(b.baseSpreadDeg, 2.0, p);
    c.shotsPerPeek = Math.round(lerp(b.shotsPerPeek, 6, p));
    c.peekSecMax = lerp(b.peekSecMax, 2.1, p);
    c.moveSpeed = lerp(b.moveSpeed, 2.75, p);
    c.flinchSec = lerp(b.flinchSec, 0.09, p);
    c.decisionSec = lerp(b.decisionSec, 0.5, p);
    const sc = SHIELD_COMBAT;
    const sb = BASE_SHIELD_COMBAT;
    sc.fireInterval = lerp(sb.fireInterval, 0.22, p);
    sc.baseSpreadDeg = lerp(sb.baseSpreadDeg, 1.8, p);
    sc.moveSpeed = lerp(sb.moveSpeed, 2.35, p);
    sc.flinchSec = lerp(sb.flinchSec, 0.05, p);
    sc.decisionSec = c.decisionSec;
    const m = SWAT_MOBILITY;
    const bm = BASE_SWAT_MOBILITY;
    m.repositionAfterLostSec = lerp(bm.repositionAfterLostSec, 0.5, p);
    m.flankChance = lerp(bm.flankChance, 0.85, p);
    const step = p >= 1 ? 4 : p >= 0.66 ? 3 : p >= 0.33 ? 2 : 1;
    if (step > this.pressureStep) {
      this.pressureStep = step;
      const pressPool = PRESS_BY_STEP[step];
      if (pressPool) {
        const [pressJa, pressEn] = pickRadio(pressPool);
        this.host.radio(this.host.firstAlive(), pressJa, pressEn, true);
      }
    }
  }

  /** 姿を見失った位置への制圧射撃。壁越しでも撃ち込むので窓のバリケードも削られる。人質が盾になっている向きには撃たない */
  suppress(by: SwatHunter, at: Vec3): void {
    if (by.engage.ammoLeft <= 0 || by.engage.label === 'reload' || by.engage.label === 'toCover') return;
    const d = Math.hypot(at.x - by.body.px, at.z - by.body.pz);
    if (d > by.combat.engageRange || Math.abs(at.y - by.body.footY) > 1.2) return;
    if (this.host.coveredByHostage(by.body.px, by.body.pz)) return;
    by.engage.fireAt(null, at);
  }

  dispose(): void {
    for (const b of this.c2Blasts) {
      this.host.root.remove(b.mesh);
      (b.mesh.material as THREE.Material).dispose();
    }
    this.c2Blasts.length = 0;
    this.c2BlastLight.intensity = 0;
    this.c2BlastLight.visible = false;
  }
}
