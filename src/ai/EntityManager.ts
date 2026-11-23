import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import { disposeObject } from '../core/dispose';
import type { AIProfile, EntityDef, PerceptionConfig, RoomDef, Vec3, WarningConfig } from '../core/types';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { AABB, Collider } from '../world/WorldBuilder';
import type { AllyTarget, CombatTarget } from './EngageBehavior';
import { Civilian } from './Civilian';
import { Suspect } from './Suspect';
import { Perception, type PerceptionTarget } from './Perception';
import { MoraleSystem } from './Morale';
import { AIDebugLabel } from '../ui/AIDebugLabel';
import type { DoorSystem } from '../world/Door';
import type { TextureLibrary } from '../world/Materials';
import type { StairMark } from '../world/Walk';

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
  ) {
    this.friendlySuspects = friendlySuspects;
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
        this.root.add(s.body.group);
        weapons.addTarget(s);
        const label = new AIDebugLabel();
        label.sprite.visible = this.debugVisible;
        this.labels.set(s.id, label);
        this.root.add(label.sprite);
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
    );
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

  /** 生存中の容疑者を、SWAT の射撃対象（AllyTarget）として返す */
  livingSuspectTargets(): AllyTarget[] {
    const out: AllyTarget[] = [];
    for (const s of this.suspects.values()) {
      if (!s.alive) continue;
      const b = s.body;
      out.push({
        id: s.id,
        px: b.px,
        pz: b.pz,
        footY: b.footY,
        height: b.height,
        getEye: () => {
          const e = b.eye(new THREE.Vector3());
          return { x: e.x, y: e.y, z: e.z };
        },
        getChest: () => b.chestPos(),
        getAABB: () => b.getAABB(),
      });
    }
    return out;
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

  /** 士気回復・FSM 更新・デバッグ表示更新（F3 で表示切替）。 */
  update(rawDt: number): void {
    const dt = Math.min(rawDt, 0.05);
    this.perception?.update(dt);
    for (const c of this.civilians.values()) c.update(dt);
    for (const s of this.suspects.values()) {
      s.update(dt);
      const label = this.labels.get(s.id);
      if (!label) continue;
      label.sprite.visible = this.debugVisible;
      if (!this.debugVisible) continue;
      label.sprite.position.set(s.body.px, s.body.footY + s.body.height + 0.35, s.body.pz);
      label.set(`${s.debugState} M:${Math.round(s.morale.value)}`, s.alive ? '#ffffff' : '#999999');
    }
  }

  private applyWarning(pos: Vec3, dir: Vec3): void {
    const cfg = this.warning;
    const cosHalf = Math.cos((cfg.coneDeg / 2) * (Math.PI / 180));
    const hl = Math.hypot(dir.x, dir.z) || 1;
    const test = (b: { chestPos(): Vec3; px: number; pz: number }): boolean => {
      const c = b.chestPos();
      const dx = c.x - pos.x;
      const dz = c.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > cfg.range) return false;
      if (dist > 0.01 && (dx * dir.x + dz * dir.z) / (dist * hl) < cosHalf) return false;
      return hasLineOfSight(this.colliders, pos, c);
    };
    for (const s of this.suspects.values()) {
      if (s.alive && test(s.body)) {
        const alliesCovering = this.squad?.countAlliesCovering(s.body.chestPos(), 10) ?? 0;
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
    this.civilians.clear();
    disposeObject(this.root);
  }
}
