import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import { SuspectState } from '../core/events';
import { disposeObject } from '../core/dispose';
import type { AIProfile, EntityDef, PerceptionConfig, RoomDef, Vec3, WarningConfig } from '../core/types';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { AABB, Collider } from '../world/WorldBuilder';
import type { AllyTarget, CombatTarget } from './EngageBehavior';
import { Civilian } from './Civilian';
import { Suspect, type GasSample } from './Suspect';
import { Perception, type PerceptionTarget } from './Perception';
import { MoraleSystem } from './Morale';
import { AIDebugLabel } from '../ui/AIDebugLabel';
import type { DoorSystem } from '../world/Door';
import type { TextureLibrary } from '../world/Materials';
import type { StairMark } from '../world/Walk';
import { evaluateC2BlastCone } from './SwatTactics';
import { SWAT_C2_BLAST_HALF_ANGLE_DEG, SWAT_C2_BLAST_RADIUS, SWAT_C2_MAX_DAMAGE } from './SwatProfile';

/** CS ガス濃度サンプリングの軽量構造型（TearGas が構造的に満たす） */
export interface GasField {
  exposureAt(pos: THREE.Vector3): number;
}

export interface SquadCoordinator {
  getLivingAllies(): readonly AllyTarget[];
  countAlliesCovering(point: Vec3, maxDist: number): number;
}

export interface PlayerCombatReceiver extends PerceptionTarget, CombatTarget {
  takeDamage(amount: number): number;
  getBodyBounds(): AABB;
  readonly alive: boolean;
}

/**
 * マップJSONの suspect / civilian エンティティを生成・管理する。
 * warningCall を購読し、距離・視野角・視線(LOS)を満たす対象に警告を適用。entityHit でダメージ適用。
 */
export class EntityManager {
  readonly root = new THREE.Group();
  readonly suspects = new Map<string, Suspect>();
  readonly civilians = new Map<string, Civilian>();
  private readonly unsubs: (() => void)[] = [];
  private readonly moraleSystem: MoraleSystem;
  private readonly labels = new Map<string, AIDebugLabel>();
  private debugVisible = false;
  private readonly perception: Perception | null = null;
  private squad: SquadCoordinator | null = null;
  private hostileTargets: (() => readonly AllyTarget[]) | null = null;
  private presenceBonusPerAlly = 0.25;
  private disposed = false;
  /** 容疑者モード: 残した容疑者 NPC はプレイヤーの味方で、SWAT を撃つ */
  private readonly friendlySuspects: boolean;
  private tearGas: GasField | null = null;
  private readonly gasProbe = new THREE.Vector3();
  private readonly chestTmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly recentGasClouds: { pos: Vec3; radius: number; remainingSec: number }[] = [];
  private readonly suspectTargets = new Map<string, AllyTarget>();
  private readonly livingSuspectsBuf: AllyTarget[] = [];
  private readonly gasCache = new Map<string, { cd: number; origin: Vec3 | null; sample: GasSample }>();

  constructor(
    defs: readonly EntityDef[],
    profiles: readonly AIProfile[],
    private readonly weapons: WeaponSystem,
    private readonly colliders: readonly Collider[],
    private readonly warning: WarningConfig,
    private readonly bus: GameEventBus,
    rooms: readonly RoomDef[] = [],
    private readonly playerCtx?: { cfg: PerceptionConfig; player: PlayerCombatReceiver },
    textures?: TextureLibrary,
    nav?: { doors: DoorSystem; bounds: { width: number; depth: number }; stairs: readonly StairMark[] },
    friendlySuspects = false,
    tearGas: GasField | null = null,
  ) {
    this.friendlySuspects = friendlySuspects;
    this.tearGas = tearGas;
    this.root.name = 'entities';
    for (const def of defs) {
      if (def.type !== 'suspect' && def.type !== 'civilian') continue;
      const profile = profiles.find((p) => p.id === def.profile);
      if (!profile) throw new Error(`entity ${def.id}: profile "${def.profile ?? ''}" がありません`);
      if (def.type === 'suspect') {
        const s = new Suspect(
          def,
          profile,
          bus,
          playerCtx
            ? {
                player: playerCtx.player,
                colliders,
                civilians: () => this.civilians.values(),
                allies: () =>
                  friendlySuspects ? (this.hostileTargets?.() ?? []) : (this.squad?.getLivingAllies() ?? []),
                ignorePlayer: friendlySuspects,
                countCoveringAllies: (pt, maxD) => this.squad?.countAlliesCovering(pt, maxD) ?? 0,
                playerDamage: (dmg, from, shooter) => {
                  const hp = playerCtx.player.takeDamage(dmg);
                  this.bus.emit('playerHit', { shooter, damage: dmg, from, hp });
                },
                doors: nav?.doors,
                bounds: nav?.bounds,
                stairs: nav?.stairs,
                rooms,
              }
            : null,
          textures,
          warning.cooldown,
          friendlySuspects,
        );
        this.suspects.set(s.id, s);
        const b = s.body;
        const eyeScratch = new THREE.Vector3();
        const chestScratch: Vec3 = { x: 0, y: 0, z: 0 };
        const aabbScratch: AABB = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
        this.suspectTargets.set(s.id, {
          id: s.id,
          get px() {
            return b.px;
          },
          get pz() {
            return b.pz;
          },
          get footY() {
            return b.footY;
          },
          get height() {
            return b.height;
          },
          getEye: () => b.eye(eyeScratch),
          getChest: () => b.chestPos(chestScratch),
          getAABB: () => b.getAABB(aabbScratch),
        });
        this.root.add(s.body.group);
        weapons.addTarget(s);
      } else {
        const c = new Civilian(def, profile, bus, colliders, textures);
        this.civilians.set(c.id, c);
        this.root.add(c.body.group);
        weapons.addTarget(c);
      }
    }
    if (playerCtx) {
      this.perception = new Perception(
        playerCtx.cfg,
        () => this.suspects.values(),
        colliders,
        playerCtx.player,
        bus,
        friendlySuspects,
      );
    }
    this.moraleSystem = new MoraleSystem(bus, () => this.suspects.values(), colliders, rooms);
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'F3') return;
      e.preventDefault();
      this.debugVisible = !this.debugVisible;
      if (this.debugVisible) {
        for (const s of this.suspects.values()) {
          if (!this.labels.has(s.id)) {
            const label = new AIDebugLabel();
            this.labels.set(s.id, label);
            this.root.add(label.sprite);
          }
        }
      }
      for (const label of this.labels.values()) {
        label.sprite.visible = this.debugVisible;
      }
    };
    window.addEventListener('keydown', onKey);
    this.unsubs.push(
      () => window.removeEventListener('keydown', onKey),
      bus.on('warningCall', (e) => this.applyWarning(e.pos, e.dir)),
      bus.on('entityHit', (e) => {
        const s = this.suspects.get(e.targetId);
        if (s) {
          const shooterPos = this.resolveShooterPos(e.shooter, e.pos);
          if (e.nonlethal) {
            s.takeNonlethalHit(shooterPos, e.moraleScale); // 致死ダメージなし
            return;
          }
          if (s.takeHit(e.damage, shooterPos)) weapons.removeTarget(s);
          return;
        }
        const c = this.civilians.get(e.targetId);
        if (c && !e.nonlethal && c.damage(e.damage)) weapons.removeTarget(c);
      }),
      bus.on('gasDetonated', (e) => {
        this.recentGasClouds.push({ pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z }, radius: e.radius, remainingSec: 18 });
      }),
    );
  }

  /** CS 催涙ガスシステムを接続する（null で解除） */
  setTearGas(tg: GasField | null): void {
    this.tearGas = tg;
  }

  /** SquadSystem 生成後に呼び出し、敵AIが味方隊員を視認・射撃できるようにする。 */
  attachSquad(squad: SquadCoordinator, presenceBonusPerAlly: number): void {
    this.squad = squad;
    this.presenceBonusPerAlly = presenceBonusPerAlly;
    // 容疑者モードでは知覚対象は SWAT（attachHostileTargets）。通常モードの分隊は上書きしない
    if (!this.friendlySuspects) this.perception?.attachAllies(() => squad.getLivingAllies());
  }

  /** 容疑者モード: 味方 NPC が狙う SWAT 隊員を渡す */
  attachHostileTargets(fn: () => readonly AllyTarget[]): void {
    this.hostileTargets = fn;
    this.perception?.attachAllies(fn);
  }

  /**
   * C2 爆破ブリーチの指向性ブラストを適用する。
   * - 爆風コーン内＋LOS のある敵対・籠城容疑者にダメージ・怯み・士気ショックを与える。
   * - 民間人および投降済み(SURRENDER)・拘束済み(ARRESTED)の容疑者には致死ダメージを与えない（RoE 保護）。
   */
  applyC2Blast(
    doorPos: Vec3,
    blastDir: Vec3,
    radius = SWAT_C2_BLAST_RADIUS,
    halfAngleDeg = SWAT_C2_BLAST_HALF_ANGLE_DEG,
    maxDamage = SWAT_C2_MAX_DAMAGE,
    _sourceId = 'c2',
  ): { damagedIds: string[]; stunnedIds: string[]; killedIds: string[] } {
    const damagedIds: string[] = [];
    const stunnedIds: string[] = [];
    const killedIds: string[] = [];
    if (
      !Number.isFinite(radius) ||
      radius <= 0 ||
      !Number.isFinite(halfAngleDeg) ||
      halfAngleDeg <= 0 ||
      !Number.isFinite(maxDamage) ||
      maxDamage < 0 ||
      !Number.isFinite(doorPos.x) ||
      !Number.isFinite(doorPos.y) ||
      !Number.isFinite(doorPos.z) ||
      !Number.isFinite(blastDir.x) ||
      !Number.isFinite(blastDir.z)
    ) {
      return { damagedIds, stunnedIds, killedIds };
    }

    const dirLen = Math.hypot(blastDir.x, blastDir.z);
    if (!Number.isFinite(dirLen) || dirLen <= 1e-6) {
      return { damagedIds, stunnedIds, killedIds };
    }
    const normDir: Vec3 = { x: blastDir.x / dirLen, y: 0, z: blastDir.z / dirLen };
    // ドア面自身のコライダーによる自己遮蔽を避けるため爆風側へ 0.25m オフセット
    const blastOrigin: Vec3 = {
      x: doorPos.x + normDir.x * 0.25,
      y: doorPos.y,
      z: doorPos.z + normDir.z * 0.25,
    };
    const coneCos = Math.cos(halfAngleDeg * (Math.PI / 180));

    for (const s of this.suspects.values()) {
      if (!s.alive) continue;
      // 投降済み・拘束済みの容疑者は致死被害から保護する
      if (s.state === SuspectState.SURRENDER || s.state === SuspectState.ARRESTED) continue;
      const chest = s.body.chestPos();
      const blast = evaluateC2BlastCone(blastOrigin, normDir, chest, radius, coneCos, maxDamage);
      if (!blast.inCone) continue;
      if (!hasLineOfSight(this.colliders, blastOrigin, chest)) continue;
      // 士気ショックを先に適用し、生存時に降伏しきい値を下回っていればクリーンに投降させる
      s.morale.apply('breach', Math.max(0.5, blast.stunScale));
      s.onFlashed(1.4 * blast.stunScale);
      stunnedIds.push(s.id);
      if (blast.damage > 0) {
        const died = s.takeHit(blast.damage, blastOrigin);
        damagedIds.push(s.id);
        if (died) {
          this.weapons.removeTarget(s);
          killedIds.push(s.id);
        }
      }
    }
    // 民間人には一切ダメージを与えない（RoE 保証）
    return { damagedIds, stunnedIds, killedIds };
  }

  /** 個別の容疑者 AllyTarget ラッパーを返す（キャッシュ済み） */
  getSuspectTarget(id: string): AllyTarget | undefined {
    return this.suspectTargets.get(id);
  }

  /** 生存中の容疑者を、SWAT の射撃対象（AllyTarget）として返す */
  livingSuspectTargets(): AllyTarget[] {
    this.livingSuspectsBuf.length = 0;
    for (const s of this.suspects.values()) {
      if (!s.alive) continue;
      const t = this.suspectTargets.get(s.id);
      if (t) this.livingSuspectsBuf.push(t);
    }
    return this.livingSuspectsBuf;
  }

  private resolveShooterPos(shooter: string, fallback: Vec3): Vec3 {
    if (shooter === 'player' && this.playerCtx) {
      const p = this.playerCtx.player.position;
      return { x: p.x, y: p.y, z: p.z };
    }
    const ally = this.squad?.getLivingAllies().find((a) => a.id === shooter);
    if (ally) return { x: ally.px, y: ally.footY, z: ally.pz };
    const hostile = this.hostileTargets?.().find((a) => a.id === shooter);
    if (hostile) return { x: hostile.px, y: hostile.footY, z: hostile.pz };
    return fallback;
  }

  private sampleGasAt(suspectId: string, pos: Vec3, dt: number): GasSample | undefined {
    const tg = this.tearGas;
    if (!tg) return undefined;
    let entry = this.gasCache.get(suspectId);
    if (!entry) {
      entry = { cd: 0, origin: null, sample: { density: 0, origin: null } };
      this.gasCache.set(suspectId, entry);
    }
    const density = tg.exposureAt(this.gasProbe.set(pos.x, pos.y, pos.z));
    if (density <= 0) {
      entry.cd = 0;
      entry.origin = null;
      entry.sample.density = 0;
      entry.sample.origin = null;
      return entry.sample;
    }

    if (entry.cd > 0) {
      entry.cd -= dt;
      entry.sample.density = density;
      entry.sample.origin = entry.origin;
      return entry.sample;
    }

    entry.cd = 0.25;
    // 有限差分勾配で高濃度方向（ガス雲中心側）を推定
    const h = 0.75;
    const gx =
      tg.exposureAt(this.gasProbe.set(pos.x + h, pos.y, pos.z)) -
      tg.exposureAt(this.gasProbe.set(pos.x - h, pos.y, pos.z));
    const gz =
      tg.exposureAt(this.gasProbe.set(pos.x, pos.y, pos.z + h)) -
      tg.exposureAt(this.gasProbe.set(pos.x, pos.y, pos.z - h));
    const gLen = Math.hypot(gx, gz);
    if (gLen > 1e-4) {
      entry.origin = { x: pos.x + (gx / gLen) * 2.5, y: pos.y, z: pos.z + (gz / gLen) * 2.5 };
      entry.sample.density = density;
      entry.sample.origin = entry.origin;
      return entry.sample;
    }

    // 雲中心付近など勾配が平坦な場合は直近の gasDetonated 座標へフォールバック
    let bestOrigin: Vec3 | null = null;
    let bestDist = Infinity;
    for (const c of this.recentGasClouds) {
      if (Math.abs(pos.y - c.pos.y) > 2.6) continue;
      const d = Math.hypot(pos.x - c.pos.x, pos.z - c.pos.z);
      if (d <= c.radius + 1.5 && d < bestDist) {
        bestDist = d;
        bestOrigin = c.pos;
      }
    }
    entry.origin = bestOrigin;
    entry.sample.density = density;
    entry.sample.origin = bestOrigin;
    return entry.sample;
  }

  /** 士気回復・FSM 更新・デバッグ表示更新（F3 で表示切替）。 */
  update(rawDt: number): void {
    const dt = Math.min(rawDt, 0.05);
    for (let i = this.recentGasClouds.length - 1; i >= 0; i--) {
      const c = this.recentGasClouds[i]!;
      c.remainingSec -= dt;
      if (c.remainingSec <= 0) this.recentGasClouds.splice(i, 1);
    }
    this.perception?.update(dt);
    for (const c of this.civilians.values()) c.update(dt);
    const hasGas = this.tearGas !== null;
    for (const s of this.suspects.values()) {
      const gas =
        hasGas && s.alive && s.state !== SuspectState.ARRESTED && s.state !== SuspectState.SURRENDER
          ? this.sampleGasAt(s.id, s.body.chestPos(this.chestTmp), dt)
          : undefined;
      s.update(dt, gas);
      if (!this.debugVisible) continue;
      const label = this.labels.get(s.id);
      if (!label) continue;
      label.sprite.position.set(s.body.px, s.body.footY + s.body.height + 0.35, s.body.pz);
      label.set(`${s.debugState} M:${Math.round(s.morale.value)}`, s.alive ? '#ffffff' : '#999999');
    }
  }

  private applyWarning(pos: Vec3, dir: Vec3): void {
    const cfg = this.warning;
    const cosHalf = Math.cos((cfg.coneDeg / 2) * (Math.PI / 180));
    const hl = Math.hypot(dir.x, dir.z) || 1;
    const test = (b: { chestPos(out?: Vec3): Vec3; px: number; pz: number }): boolean => {
      const c = b.chestPos(this.chestTmp);
      const dx = c.x - pos.x;
      const dz = c.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > cfg.range) return false;
      if (dist > 0.01 && (dx * dir.x + dz * dir.z) / (dist * hl) < cosHalf) return false;
      return hasLineOfSight(this.colliders, pos, c);
    };
    for (const s of this.suspects.values()) {
      if (s.alive && test(s.body)) {
        const alliesCovering = this.squad?.countAlliesCovering(s.body.chestPos(this.chestTmp), 10) ?? 0;
        const pressure = 1 + this.presenceBonusPerAlly * alliesCovering;
        s.onWarned(pos, pressure);
      }
    }
    for (const c of this.civilians.values()) if (c.alive && test(c.body)) c.onWarned();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.moraleSystem.dispose();
    this.perception?.dispose();
    for (const l of this.labels.values()) l.dispose();
    this.labels.clear();
    for (const s of this.suspects.values()) {
      this.weapons.removeTarget(s);
      s.dispose();
    }
    for (const c of this.civilians.values()) {
      this.weapons.removeTarget(c);
      c.dispose();
    }
    this.suspects.clear();
    this.suspectTargets.clear();
    this.livingSuspectsBuf.length = 0;
    this.gasCache.clear();
    this.civilians.clear();
    disposeObject(this.root);
  }
}
