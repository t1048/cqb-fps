import type { GameEventBus } from '../core/events';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Collider } from '../world/WorldBuilder';
import { stepToward } from './EngageBehavior';
import { CivilianState } from '../core/events';
import type { AIProfile, EntityDef } from '../core/types';
import type { HitTarget } from '../weapons/WeaponSystem';
import type { AABB } from '../world/WorldBuilder';
import { HumanoidBody } from './HumanoidBody';
import { noiseRayOriginY } from './Perception';
import type { TextureLibrary } from '../world/Materials';

const CIVILIAN_COLOR = 0xb7a895;
const DEFAULT_HP = 100;

/**
 * 民間人 FSM（MVP_SPEC §3）: IDLE → PANIC → COMPLY → SHIELDED → SECURED。
 *  - IDLE→PANIC: 閃光(flashDetonated: 半径内+視線) / 銃声(noise gunshot: 聴取半径内)。刺激源から panicFleeSec だけ逃げ、うずくまる。
 *  - IDLE/PANIC→COMPLY: 警告コール（伏せる）。
 *  - →SHIELDED: 容疑者に保持された(beginShield)。解放(endShield)で COMPLY に戻る。
 *  - COMPLY→SECURED: プレイヤーの拘束/保護アクション(secure)。SECURED への遷移は civilianStateChanged で通知され、
 *    RoE が「無傷なら civilianSecured +30」を付与する（被弾済みは付与されない）。
 * パラメータは profile.civilian（JSON）。
 */
export class Civilian implements HitTarget {
  readonly id: string;
  readonly body: HumanoidBody;
  state: CivilianState = CivilianState.IDLE;
  morale: number;
  hp: number;
  /** 盾にしている容疑者の id（state=SHIELDED の間のみ非 null） */
  shieldedBy: string | null = null;
  private fleeFrom: { x: number; z: number } | null = null;
  private fleeTimer = 0;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    def: EntityDef,
    readonly profile: AIProfile,
    private readonly bus: GameEventBus,
    private readonly colliders: readonly Collider[] = [],
    textures?: TextureLibrary,
  ) {
    this.id = def.id;
    this.morale = profile.initialMorale;
    this.hp = def.hp ?? DEFAULT_HP;
    this.body = new HumanoidBody(def.x, def.z, def.yaw ?? 0, CIVILIAN_COLOR, false, {
      role: 'civilian',
      footY: def.y ?? 0,
      textures,
    });
    this.unsubs.push(
      bus.on('flashDetonated', (e) => {
        if (!this.canPanic) return;
        const c = this.body.chestPos();
        if (Math.hypot(c.x - e.pos.x, c.y - e.pos.y, c.z - e.pos.z) > e.radius) return;
        const from = { x: e.pos.x, y: noiseRayOriginY(e.pos, 'flash'), z: e.pos.z };
        if (!hasLineOfSight(this.colliders, from, c)) return;
        this.panic(e.pos.x, e.pos.z);
      }),
      bus.on('noise', (e) => {
        if (e.kind !== 'gunshot' || !this.canPanic) return;
        const cp = this.profile.civilian;
        if (!cp) return;
        // Perception と同一の 3D 距離（足元 footY 基準）で判定し、別階の銃声を水平距離だけで拾わない
        const dist = Math.hypot(this.body.px - e.pos.x, this.body.footY - e.pos.y, this.body.pz - e.pos.z);
        let r = e.radius * this.profile.hearingMultiplier * cp.gunshotHearScale;
        if (dist > r) return;
        const from = { x: e.pos.x, y: noiseRayOriginY(e.pos, e.kind), z: e.pos.z };
        if (!hasLineOfSight(this.colliders, from, this.body.chestPos())) {
          r *= cp.occludedScale;
          if (dist > r) return;
        }
        this.panic(e.pos.x, e.pos.z);
      }),
    );
  }

  getAABB(): AABB {
    return this.body.getAABB();
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  /** PANIC に入れるのは IDLE のみ（COMPLY 以降は伏せ済み/保持中/保護済み）。 */
  private get canPanic(): boolean {
    return this.alive && this.state === CivilianState.IDLE;
  }

  private setState(to: CivilianState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.bus.emit('civilianStateChanged', { id: this.id, from, to });
  }

  private panic(x: number, z: number): void {
    this.fleeFrom = { x, z };
    this.fleeTimer = this.profile.civilian?.panicFleeSec ?? 0;
    this.body.setPose('stand');
    this.setState(CivilianState.PANIC);
  }

  /** PANIC の逃走→うずくまり。dt は呼び出し側で clamp 済みの秒。 */
  update(dt: number): void {
    this.body.tick(dt);
    if (!this.alive || this.state !== CivilianState.PANIC || !this.fleeFrom) return;
    const cp = this.profile.civilian;
    if (this.fleeTimer > 0 && cp) {
      this.fleeTimer -= dt;
      const dx = this.body.px - this.fleeFrom.x;
      const dz = this.body.pz - this.fleeFrom.z;
      const d = Math.hypot(dx, dz) || 1;
      this.body.faceToward(this.body.px + dx / d, this.body.pz + dz / d);
      stepToward(this.body, this.colliders, this.body.px + dx / d, this.body.pz + dz / d, cp.panicFleeSpeed * dt);
      if (this.fleeTimer <= 0) this.body.setPose('crouch');
    }
  }

  /** 警告コール: IDLE/PANIC → COMPLY（伏せる）。盾保持中・保護済みは対象外。 */
  onWarned(): void {
    if (!this.alive) return;
    if (this.state !== CivilianState.IDLE && this.state !== CivilianState.PANIC) return;
    const m = this.profile.modifiers.warningCall;
    this.morale = Math.max(0, this.morale - (m.min + Math.random() * (m.max - m.min)));
    this.fleeFrom = null;
    this.body.setPose('kneel');
    this.setState(CivilianState.COMPLY);
  }

  /** 容疑者が人質盾として掴めるか（生存・未保持・SECURED 以外）。 */
  get canBeShielded(): boolean {
    return this.alive && !this.shieldedBy && this.state !== CivilianState.SECURED;
  }

  /** 容疑者に盾として保持された（立たされる）。IDLE/PANIC/COMPLY → SHIELDED。 */
  beginShield(by: string): void {
    if (!this.canBeShielded) return;
    this.shieldedBy = by;
    this.fleeFrom = null;
    this.body.setPose('stand');
    this.setState(CivilianState.SHIELDED);
  }

  /** 解放された（その場にしゃがむ）。SHIELDED → COMPLY。 */
  endShield(): void {
    this.shieldedBy = null;
    if (!this.alive || this.state !== CivilianState.SHIELDED) return;
    this.body.setPose('kneel');
    this.setState(CivilianState.COMPLY);
  }

  /** プレイヤー・隊員が確保・保護できるか（生存中・人質盾にされておらず・未確保）。 */
  get canSecure(): boolean {
    return this.alive && !this.shieldedBy && this.state !== CivilianState.SECURED;
  }

  /** → SECURED（警告前でも直接確保可能）。成功で true。 */
  secure(): boolean {
    if (!this.canSecure) return false;
    this.fleeFrom = null;
    this.body.setPose('kneel');
    this.body.setRestrained(true);
    const t = this.profile.civilian?.securedTint;
    if (t !== undefined) this.body.setTint(t);
    this.setState(CivilianState.SECURED);
    return true;
  }

  /** 交渉で解放され建物外へ退避した（SECURED 扱い・非表示）。 */
  evacuated = false;

  evacuate(): boolean {
    if (!this.alive || this.shieldedBy || this.evacuated) return false;
    this.secure();
    this.evacuated = true;
    this.body.group.visible = false;
    this.body.setPosition(this.body.px, this.body.pz, this.body.footY - 50);
    return true;
  }

  damage(amount: number): boolean {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp > 0) return false;
    this.body.setPose('down');
    return true;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.body.dispose();
  }
}
