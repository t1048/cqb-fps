import type { GameEventBus } from '../core/events';
import { SuspectState } from '../core/events';
import type { AIProfile, RoomDef, Vec3 } from '../core/types';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Collider } from '../world/WorldBuilder';

export type MoraleSource = 'warningCall' | 'flashbang' | 'nonlethalHit' | 'breach' | 'isolation';

/** 士気 0〜100。減少量は profile.modifiers（JSON）。自然回復は初期値まで。 */
export class Morale {
  value: number;

  constructor(private readonly profile: AIProfile) {
    this.value = clamp(profile.initialMorale);
  }

  /** 低下を適用。scale は武器倍率等（既定 1）。戻り値: 実際の低下量 */
  apply(source: MoraleSource, scale = 1): number {
    const m = this.profile.modifiers[source];
    const base = typeof m === 'number' ? m : m.min + Math.random() * (m.max - m.min);
    const amount = base * scale;
    const before = this.value;
    this.value = clamp(this.value - amount);
    return before - this.value;
  }

  /** 符号付きの増減（正=上昇/硬化、負=低下）。交渉用。 */
  shift(delta: number): void {
    this.value = clamp(this.value + delta);
  }

  /** 自然回復（/秒、初期士気が上限）。 */
  recover(dt: number): void {
    const cap = this.profile.initialMorale;
    if (this.value >= cap) return;
    this.value = Math.min(cap, this.value + this.profile.moraleRecovery * dt);
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** MoraleSystem が操作する容疑者の最小 IF（循環参照回避）。 */
export interface MoraleActor {
  readonly id: string;
  readonly state: SuspectState;
  readonly morale: Morale;
  readonly body: { chestPos(): Vec3; px: number; pz: number; footY: number };
  onFlashed?(seconds: number): void;
}

/**
 * イベント購読による士気変動。
 * - flashDetonated: 効果半径内 + 視線あり
 * - doorBreached: 半径内 + 扉の内側方向 + 視線あり
 * - suspectStateChanged(ARRESTED/DOWN): 同室の他の生存容疑者へ孤立ボーナス
 * 警告コールは視野角判定を EntityManager が行い Suspect.onWarned 経由で適用する。
 * 非致死性命中(nonlethalHit)は T3-7 が `Morale.apply('nonlethalHit')` を呼ぶ。
 */
export class MoraleSystem {
  private readonly unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(
    bus: GameEventBus,
    private readonly actors: () => Iterable<MoraleActor>,
    private readonly colliders: readonly Collider[],
    private readonly rooms: readonly RoomDef[],
  ) {
    this.unsubs.push(
      bus.on('flashDetonated', (e) => {
        for (const a of this.active()) {
          const c = a.body.chestPos();
          const dist = Math.hypot(c.x - e.pos.x, c.y - e.pos.y, c.z - e.pos.z);
          if (dist > e.radius) continue;
          if (!hasLineOfSight(this.colliders, e.pos, c)) continue;
          a.morale.apply('flashbang');
          const falloff = e.radius > 0 ? 1 - dist / e.radius : 0;
          a.onFlashed?.(e.blindSec * Math.max(0.25, falloff));
        }
      }),
      bus.on('doorBreached', (e) => {
        for (const a of this.active()) {
          const c = a.body.chestPos();
          const dx = c.x - e.pos.x;
          const dz = c.z - e.pos.z;
          if (Math.hypot(dx, dz) > e.radius) continue;
          if (dx * e.dir.x + dz * e.dir.z <= 0) continue; // 室内側のみ
          if (!hasLineOfSight(this.colliders, e.pos, c)) continue;
          a.morale.apply('breach');
        }
      }),
      bus.on('suspectStateChanged', (e) => {
        if (e.to !== SuspectState.ARRESTED && e.to !== SuspectState.DOWN) return;
        let src: MoraleActor | undefined;
        for (const a of this.actors()) if (a.id === e.id) src = a;
        if (!src) return;
        const room = this.roomOf(src.body.px, src.body.pz, src.body.footY);
        if (!room) return;
        for (const a of this.active()) {
          if (a.id === e.id || this.roomOf(a.body.px, a.body.pz, a.body.footY) !== room) continue;
          a.morale.apply('isolation');
        }
      }),
    );
  }

  private *active(): Generator<MoraleActor> {
    for (const a of this.actors()) {
      if (a.state !== SuspectState.DOWN && a.state !== SuspectState.ARRESTED) yield a;
    }
  }

  private roomOf(x: number, z: number, footY: number): string | null {
    let best: { id: string; area: number } | null = null;
    for (const r of this.rooms) {
      if (Math.abs(footY - (r.floorY ?? 0)) > 1.25) continue;
      if (Math.abs(x - r.x) > r.width / 2 || Math.abs(z - r.z) > r.depth / 2) continue;
      const area = r.width * r.depth;
      if (!best || area < best.area) best = { id: r.id, area };
    }
    return best?.id ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }
}
