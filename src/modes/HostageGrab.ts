import type { Civilian } from '../ai/Civilian';
import { blockedAtFiltered } from '../ai/SquadRoute';
import type { EntityManager } from '../ai/EntityManager';
import { CivilianState } from '../core/events';
import type { Interaction } from '../player/Interaction';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { PlayerController } from '../player/PlayerController';
import type { Subtitle } from '../ui/Subtitle';
import type { Collider } from '../world/WorldBuilder';

const GRAB_RANGE = 1.9;
const GRAB_CONE_COS = Math.cos((70 / 2) * (Math.PI / 180));
const GRAB_HOLD_SEC = 0.6;
/** 人質を抱えている間の移動速度倍率 */
const CARRY_SPEED = 0.72;
/** 人質の位置: 前方 FORWARD m の正面（拘束中の人質には自分の弾が当たらない＝肩越しに撃つ扱い） */
const FORWARD = 0.45;
const SIDE = 0;

/**
 * 容疑者モード: 民間人を人質として拘束し連れ回す（人間の盾）。
 * F 長押しで拘束、拘束中に F で解放。拘束中は移動が遅くなり、人質は常に前方左に立たされる。
 * SWAT は射線上に民間人がいると発砲しないため、正面からの撃ち合いを避けられる（側面・背後は無防備）。
 */
export class HostageGrab {
  private held: Civilian | null = null;
  private readonly unreg: () => void;

  constructor(
    private readonly player: PlayerController,
    private readonly entities: EntityManager,
    private readonly colliders: readonly Collider[],
    private readonly subtitle: Subtitle,
    private readonly weapons: WeaponSystem,
    interaction: Interaction,
    private readonly onProgress: (label: string, ratio: number) => void,
    /** ドアを狙っている間は F をドア操作に譲る */
    private readonly aimingDoor: () => boolean,
  ) {
    this.unreg = interaction.register<Civilian>({
      id: 'hostageGrab',
      // ドア操作より優先（人質を抱えている間の F は解放に使う）
      priority: 300,
      resolve: () => (this.held ? (this.aimingDoor() ? null : this.held) : this.findTarget()),
      label: (c) => (c === this.held ? 'F: 人質を解放' : 'F 長押し: 人質を拘束して連れ回す'),
      onPress: (c) => {
        if (c === this.held) this.release('人質を解放した');
      },
      onHold: (c, _dt, sec) => {
        if (this.held || c === this.held) return;
        this.onProgress('人質を拘束中...', sec / GRAB_HOLD_SEC);
        if (sec >= GRAB_HOLD_SEC) this.grab(c);
      },
    });
  }

  get holding(): Civilian | null {
    return this.held;
  }

  private findTarget(): Civilian | null {
    if (!this.player.alive) return null;
    const eye = this.player.getEyePosition();
    const yaw = this.player.yawRad;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let best: Civilian | null = null;
    let bestD = GRAB_RANGE;
    for (const c of this.entities.civilians.values()) {
      if (!c.canBeShielded || c.evacuated || c.state === CivilianState.SECURED) continue;
      if (Math.abs(c.body.footY - this.player.position.y) > 0.8) continue;
      const dx = c.body.px - eye.x;
      const dz = c.body.pz - eye.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      if (d > 0.3 && (dx * fx + dz * fz) / d < GRAB_CONE_COS) continue;
      best = c;
      bestD = d;
    }
    return best;
  }

  private grab(c: Civilian): void {
    c.beginShield('player');
    if (c.shieldedBy !== 'player') return;
    this.held = c;
    this.weapons.removeTarget(c);
    this.subtitle.show('容疑者「動くな！来い！」— 人質を拘束した', 1.8);
  }

  release(msg?: string): void {
    const c = this.held;
    if (!c) return;
    this.held = null;
    c.endShield();
    if (c.alive) this.weapons.addTarget(c);
    if (msg) this.subtitle.show(msg, 1.4);
  }

  /** WeaponSystem.update の後に呼ぶ（speedMultiplier を上書きするため）。 */
  update(): void {
    const c = this.held;
    if (!c) return;
    if (!c.alive || !this.player.alive) {
      this.held = null;
      if (!c.alive) this.subtitle.show('人質が死亡した', 1.6);
      else {
        c.endShield();
        this.weapons.addTarget(c);
      }
      return;
    }
    this.player.speedMultiplier *= CARRY_SPEED;
    const p = this.player.position;
    const yaw = this.player.yawRad;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // 左 = 前方を反時計回りに 90°
    const lx = fz;
    const lz = -fx;
    // 前方の空きに立たせる。家具等で塞がれていても常に正面（最小距離）には置く
    let placed = false;
    for (const f of [FORWARD, FORWARD * 0.7]) {
      const x = p.x + fx * f + lx * SIDE;
      const z = p.z + fz * f + lz * SIDE;
      if (!blockedAtFiltered(this.colliders, x, z, 0.2, p.y)) {
        c.body.setPosition(x, z, p.y);
        placed = true;
        break;
      }
    }
    if (!placed) c.body.setPosition(p.x + fx * 0.22, p.z + fz * 0.22, p.y);
    c.body.faceToward(c.body.px + fx, c.body.pz + fz);
  }

  dispose(): void {
    this.release();
    this.unreg();
  }
}
