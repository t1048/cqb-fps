import type { GameEventBus } from '../core/events';
import type { ShieldParams, Vec3 } from '../core/types';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { AABB, Collider } from '../world/WorldBuilder';
import { blockedAt, stepToward, type CombatContext, type ShieldHostage, type XZ } from './EngageBehavior';
import type { HumanoidBody } from './HumanoidBody';

const DEG = Math.PI / 180;
const ESCAPE_DIRS = 16;
const ESCAPE_STEP = 0.25;
const FALLBACK_EYE_Y = 1.6;
const HEAD_R = 0.14;

/** 線分 p0→p1 が AABB と交差するか（スラブ法）。射線が盾(民間人)に遮られるかの判定に使う。 */
export function segmentHitsAABB(a: AABB, p0: Vec3, p1: Vec3): boolean {
  let tMin = 0;
  let tMax = 1;
  const axes: [keyof Vec3, number, number][] = [
    ['x', a.min.x, a.max.x],
    ['y', a.min.y, a.max.y],
    ['z', a.min.z, a.max.z],
  ];
  for (const [k, lo, hi] of axes) {
    const d = p1[k] - p0[k];
    if (Math.abs(d) < 1e-9) {
      if (p0[k] < lo || p0[k] > hi) return false;
      continue;
    }
    let t1 = (lo - p0[k]) / d;
    let t2 = (hi - p0[k]) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}

/**
 * 脱出路判定: from から、プレイヤー(player)から離れる方向へ直進路（壁/遮蔽物/ドアに遮られない）があり、
 * その途中で「現在位置よりプレイヤーから minGain 以上遠ざかれる」点に到達できるなら脱出路あり。
 * 壁際・角に追い詰められている（=脱出路なし）場合に false。
 */
export function hasEscapeRoute(
  colliders: readonly Collider[],
  from: XZ,
  player: XZ,
  p: Pick<ShieldParams, 'escapeSearch' | 'escapeMinGain'>,
  feetY = 0,
): boolean {
  const d0 = Math.hypot(from.x - player.x, from.z - player.z);
  for (let i = 0; i < ESCAPE_DIRS; i++) {
    const a = (i / ESCAPE_DIRS) * Math.PI * 2;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    for (let l = ESCAPE_STEP; l <= p.escapeSearch + 1e-6; l += ESCAPE_STEP) {
      const x = from.x + dx * l;
      const z = from.z + dz * l;
      if (blockedAt(colliders, x, z, 0.3, feetY)) break;
      if (Math.hypot(x - player.x, z - player.z) - d0 >= p.escapeMinGain) return true;
    }
  }
  return false;
}

type Phase = 'grab' | 'hold';

/**
 * HOSTAGE_SHIELD 中の行動（MVP_SPEC §3）。
 *  1. grab: 民間人へ接近して掴む（grabMaxSec 超過/民間人喪失で中止）
 *  2. hold: 民間人を自分とプレイヤーの間（前面）に保持。プレイヤーの動きに合わせて盾が回り込む（pivotDegPerSec で上限）。
 *     容疑者は盾から headOffset 横にずれて立つため、頭が盾の脇から出る＝側面から安全に狙える角度が存在する。
 *     プレイヤーが backAwayRange 以内なら銃を向けたまま後退して威嚇（壁で止まる）。
 * 射線ブロックは物理的な当たり判定で成立する: 盾の民間人は WeaponSystem の標的(AABB)なので、正面射撃は民間人に命中し
 * entityHit→RoE civilianHit(-100)。容疑者の身体は盾の背後でレイが先に民間人へ当たる。
 * このクラスは発砲しない（プレイヤー被弾は仕様未定義のためスコープ外・脅しのみ）。
 */
export class HostageShieldBehavior {
  phase: Phase = 'grab';
  private hostage: ShieldHostage | null = null;
  private timer = 0;
  private theta = 0; // 容疑者→盾の向き。方向ベクトル = (sin, cos)
  private side = 1;
  /** 最新の頭の露出（デバッグ表示用） */
  headExposed = false;

  constructor(
    private readonly p: ShieldParams,
    private readonly id: string,
    private readonly body: HumanoidBody,
    private readonly bus: GameEventBus,
    private readonly ctx: CombatContext,
  ) {}

  get target(): ShieldHostage | null {
    return this.hostage;
  }

  get label(): string {
    return this.phase === 'hold' ? `hold:${this.headExposed ? 'head' : 'cover'}` : 'grab';
  }

  /** 盾にできる最寄りの民間人（生存・未保持・未保護・近距離・直進路あり）。 */
  findCandidate(): ShieldHostage | null {
    if (!this.ctx.civilians) return null;
    let best: ShieldHostage | null = null;
    let bestD = this.p.civilianRange;
    for (const c of this.ctx.civilians()) {
      if (!c.canBeShielded) continue;
      const d = Math.hypot(c.body.px - this.body.px, c.body.pz - this.body.pz);
      if (d > bestD || !this.pathClear(c.body.px, c.body.pz)) continue;
      bestD = d;
      best = c;
    }
    return best;
  }

  /** 民間人を指定して grab 開始（ステート遷移の直前に呼ぶ）。 */
  begin(h: ShieldHostage): void {
    this.hostage = h;
    this.phase = 'grab';
    this.timer = 0;
  }

  /** 戻り値: false の場合は盾を維持できない（呼び出し側が ENGAGE/SURRENDER へ遷移させる）。 */
  update(dt: number, known: XZ | null, moveSpeed: number): boolean {
    const h = this.hostage;
    if (!h || !h.alive) return false;
    if (known) this.body.faceToward(known.x, known.z);
    if (this.phase === 'grab') {
      if (!h.canBeShielded) return false;
      this.timer += dt;
      if (this.timer > this.p.grabMaxSec) return false;
      const dx = h.body.px - this.body.px;
      const dz = h.body.pz - this.body.pz;
      if (Math.hypot(dx, dz) > this.p.grabRange) {
        stepToward(this.body, this.ctx.colliders, h.body.px, h.body.pz, moveSpeed * dt);
        return true;
      }
      return this.grip(h);
    }
    this.hold(h, dt, known);
    this.updateExposure(h);
    return true;
  }

  /** 状態を抜けた（降伏/被弾/DOWN/民間人死亡など）: 民間人を解放。 */
  release(): void {
    const h = this.hostage;
    if (!h) return;
    const wasHolding = this.phase === 'hold';
    if (h.shieldedBy === this.id) h.endShield();
    if (wasHolding) this.bus.emit('hostageShield', { suspectId: this.id, civilianId: h.id, active: false });
    this.hostage = null;
    this.phase = 'grab';
    this.headExposed = false;
  }

  /**
   * プレイヤー視点(eye)から容疑者の頭（中心＋左右の端）のいずれかへ射線が盾/壁に遮られず通るか。
   * 頭の端は eye→頭 に直交する水平方向に頭半径ぶんずらした点。
   */
  private updateExposure(h: ShieldHostage): void {
    const eye = this.ctx.player.getEyePosition();
    const from = { x: eye.x, y: eye.y || FALLBACK_EYE_Y, z: eye.z };
    const hx = this.body.px;
    const hz = this.body.pz;
    const dx = hx - from.x;
    const dz = hz - from.z;
    const l = Math.hypot(dx, dz) || 1;
    const px = (-dz / l) * HEAD_R;
    const pz = (dx / l) * HEAD_R;
    const y = this.body.height + HEAD_R;
    const box = h.body.getAABB();
    this.headExposed = [-1, 0, 1].some((k) => {
      const head = { x: hx + px * k, y, z: hz + pz * k };
      return hasLineOfSight(this.ctx.colliders, from, head) && !segmentHitsAABB(box, from, head);
    });
  }

  private grip(h: ShieldHostage): boolean {
    if (!h.canBeShielded) return false;
    this.phase = 'hold';
    this.theta = Math.atan2(h.body.px - this.body.px, h.body.pz - this.body.pz);
    this.side = this.chooseSide();
    h.beginShield(this.id);
    this.placeHostage(h, this.theta);
    this.bus.emit('hostageShield', { suspectId: this.id, civilianId: h.id, active: true });
    return true;
  }

  /** 頭を出す側: 容疑者の立ち位置が壁に埋まらない側を選ぶ（右優先）。 */
  private chooseSide(): number {
    for (const s of [1, -1]) {
      const v = { x: Math.cos(this.theta) * s * this.p.headOffset, z: -Math.sin(this.theta) * s * this.p.headOffset };
      if (!blockedAt(this.ctx.colliders, this.body.px + v.x, this.body.pz + v.z, 0.3, this.body.footY)) return s;
    }
    return 1;
  }

  /** 盾の中心座標 = 容疑者 + 前方*holdDistance - 横*side*headOffset（容疑者が横にずれて頭が脇から出る）。 */
  private hostagePos(theta: number): XZ {
    const ux = Math.sin(theta);
    const uz = Math.cos(theta);
    const vx = Math.cos(theta);
    const vz = -Math.sin(theta);
    const k = this.side * this.p.headOffset;
    return { x: this.body.px + ux * this.p.holdDistance - vx * k, z: this.body.pz + uz * this.p.holdDistance - vz * k };
  }

  private placeHostage(h: ShieldHostage, theta: number): boolean {
    const pos = this.hostagePos(theta);
    if (blockedAt(this.ctx.colliders, pos.x, pos.z, this.p.hostageRadius, this.body.footY)) return false;
    h.body.setPosition(pos.x, pos.z, this.body.footY);
    const f = this.known ?? null;
    if (f) h.body.faceToward(f.x, f.z);
    return true;
  }

  private known: XZ | null = null;

  private hold(h: ShieldHostage, dt: number, known: XZ | null): void {
    this.known = known;
    if (known) {
      // 盾をプレイヤー方向へ（角速度上限付きで）回り込ませる
      const target = Math.atan2(known.x - this.body.px, known.z - this.body.pz);
      let diff = target - this.theta;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const maxStep = this.p.pivotDegPerSec * DEG * dt;
      const next = this.theta + Math.max(-maxStep, Math.min(maxStep, diff));
      const prev = this.theta;
      this.theta = next;
      if (!this.placeHostage(h, next)) this.theta = prev; // 壁に埋まるなら回り込まない

      // 後退威嚇: プレイヤーが近いほど盾ごと下がる（壁で止まる）
      const dx = this.body.px - known.x;
      const dz = this.body.pz - known.z;
      const dist = Math.hypot(dx, dz);
      if (dist < this.p.backAwayRange && dist > 1e-3) {
        const step = this.p.backAwaySpeed * dt;
        const x0 = this.body.px;
        const z0 = this.body.pz;
        stepToward(this.body, this.ctx.colliders, x0 + (dx / dist) * step, z0 + (dz / dist) * step, step);
        if (!this.placeHostage(h, this.theta)) this.body.setPosition(x0, z0); // 盾が壁に当たるなら後退しない
        this.placeHostage(h, this.theta);
      }
    }
  }

  private pathClear(x1: number, z1: number): boolean {
    const x0 = this.body.px;
    const z0 = this.body.pz;
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(d / ESCAPE_STEP));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (blockedAt(this.ctx.colliders, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, 0.3, this.body.footY)) return false;
    }
    return true;
  }
}
