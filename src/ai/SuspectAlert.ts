import type { GameEventBus, NoiseKind, NoiseSource } from '../core/events';
import { SuspectState } from '../core/events';
import type { SuspectAlertConfig, Vec3 } from '../core/types';

/**
 * 容疑者側の「警戒度」（SWAT モードのみ）。0〜100 の単一値。
 *
 * 上がる: 閃光弾（大）・銃声（バースト単位）・ブリーチ/C2・CS ガス（小）・容疑者の無力化・ドア開閉音（微小）・トラップ起爆。
 * 下がる: 静かな時間が decayDelaySec 続くと decayPerSec/s で減衰。ただし交渉のベースライン未満には下がらない。
 * 段階（tiers）: 巡回活発 → 待ち伏せ/遮蔽 → 人質を盾に → 人質処刑の脅迫（HostageThreat）。
 */

/** 0=平静 1=巡回活発(patrol) 2=待ち伏せ/遮蔽(ambush) 3=人質を盾に(shield) 4=処刑の脅迫が起こり得る(execute) */
export type AlertTier = 0 | 1 | 2 | 3 | 4;

/** 容疑者 AI が参照する読み取り専用ビュー */
export interface AlertView {
  readonly value: number;
  readonly tier: AlertTier;
  readonly cfg: SuspectAlertConfig;
}

/** 警戒度が距離・階の影響を受けるための、容疑者の最小記述 */
export interface AlertSuspectLike {
  readonly alive: boolean;
  readonly state: SuspectState;
  readonly body: { px: number; pz: number; footY: number };
  readonly isOpeningDoor?: boolean;
}

export type AlertGainKind = keyof SuspectAlertConfig['gains'];

export interface NegotiationAlertInfo {
  /** 犯人の緊張 0〜100 */
  tension: number;
  /** 信頼 0〜100 */
  trust: number;
  /** 最後通告を使った回数 */
  ultimatums: number;
  /** 交渉決裂（人質殺害など） */
  broken: boolean;
}

/** 交渉の結果から、突入時の警戒度ベースライン（これ未満には下がらない）を求める。 */
export function negotiationAlertBaseline(cfg: SuspectAlertConfig, info: NegotiationAlertInfo): number {
  const b = cfg.baseline;
  const raw =
    b.start + info.tension * b.tensionWeight + info.ultimatums * b.ultimatum - info.trust * b.trustWeight + (info.broken ? b.brokenBonus : 0);
  return Math.round(Math.max(0, Math.min(b.max, raw)));
}

export function tierOf(cfg: SuspectAlertConfig, value: number): AlertTier {
  const t = cfg.tiers;
  if (value >= t.execute) return 4;
  if (value >= t.shield) return 3;
  if (value >= t.ambush) return 2;
  if (value >= t.patrol) return 1;
  return 0;
}

/** 警告コールの士気低下倍率（段階が高いほど従いにくい＝小さくなる）。 */
export function complianceMulOf(cfg: SuspectAlertConfig, tier: AlertTier): number {
  const c = cfg.effects.complianceMul;
  if (tier >= 4) return c.execute;
  if (tier === 3) return c.shield;
  if (tier === 2) return c.ambush;
  if (tier === 1) return c.patrol;
  return 1;
}

export class SuspectAlert implements AlertView {
  private v: number;
  private base: number;
  private quietSec = 0;
  private executeSec = 0;
  private lastGunT = -Infinity;
  private lastDoorT = -Infinity;
  private t = 0;
  /** 閃光弾の起爆回数（処刑の脅迫の解禁条件に使う） */
  flashCount = 0;
  private readonly unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(
    readonly cfg: SuspectAlertConfig,
    private readonly suspects: () => Iterable<AlertSuspectLike>,
    bus?: GameEventBus,
    baseline = 0,
  ) {
    this.base = clamp(baseline);
    this.v = this.base;
    if (bus) this.attach(bus);
  }

  get value(): number {
    return this.v;
  }

  get baseline(): number {
    return this.base;
  }

  get tier(): AlertTier {
    return tierOf(this.cfg, this.v);
  }

  /** 警戒度が execute 段階以上のまま続いている秒数 */
  get executeSustainSec(): number {
    return this.executeSec;
  }

  /** 交渉の結果を反映する。値はベースライン未満にならない（交渉前なので現在値もそこへ合わせる）。 */
  setBaseline(b: number): void {
    this.base = clamp(b);
    this.v = Math.max(this.v, this.base);
  }

  /** 加算（factor: 距離・階などの減衰係数 0〜1）。 */
  add(kind: AlertGainKind, factor = 1): number {
    const g = this.cfg.gains[kind] * Math.max(0, Math.min(1, factor));
    if (g <= 0) return 0;
    const before = this.v;
    this.v = clamp(this.v + g);
    this.quietSec = 0;
    return this.v - before;
  }

  /** 音源 pos が容疑者にどれだけ届くか（0〜1）。生存容疑者が居なければ 0。 */
  hearFactor(pos: Vec3): number {
    const c = this.cfg;
    let best = 0;
    for (const s of this.suspects()) {
      if (!s.alive || s.state === SuspectState.ARRESTED) continue;
      const d = Math.hypot(s.body.px - pos.x, s.body.pz - pos.z);
      let f: number;
      if (d <= c.hearNearM) f = 1;
      else if (d >= c.hearFarM) f = c.farFactor;
      else f = 1 - (1 - c.farFactor) * ((d - c.hearNearM) / (c.hearFarM - c.hearNearM));
      if (Math.abs(s.body.footY - pos.y) > 1.5) f *= c.otherFloorFactor;
      if (f > best) best = f;
    }
    return best;
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.t += dt;
    this.quietSec += dt;
    if (this.quietSec > this.cfg.decayDelaySec && this.v > this.base) {
      this.v = Math.max(this.base, this.v - this.cfg.decayPerSec * dt);
    }
    if (this.v >= this.cfg.tiers.execute) this.executeSec += dt;
    else this.executeSec = 0;
  }

  private attach(bus: GameEventBus): void {
    this.unsubs.push(
      bus.on('flashDetonated', (e) => {
        this.flashCount++;
        this.add('flashbang', this.hearFactor(e.pos));
      }),
      bus.on('noise', (e) => this.onNoise(e.pos, e.kind, e.source)),
      bus.on('doorBreached', (e) => this.add('breach', this.hearFactor(e.pos))),
      bus.on('c2Detonated', (e) => this.add('c2', this.hearFactor(e.pos))),
      bus.on('gasDetonated', (e) => this.add('gas', this.hearFactor(e.pos))),
      bus.on('doorTrapDetonated', (e) => this.add('trapBlast', this.hearFactor(e.pos))),
      bus.on('suspectStateChanged', (e) => {
        if (e.to === SuspectState.DOWN) this.add('suspectDown');
      }),
    );
  }

  private onNoise(pos: Vec3, kind: NoiseKind, source?: NoiseSource): void {
    if (source === 'suspect') return;
    if (kind === 'gunshot') {
      const isNewBurst = this.t - this.lastGunT >= this.cfg.gunshotBurstGapSec;
      this.lastGunT = this.t;
      if (isNewBurst) this.add('gunshotBurst', this.hearFactor(pos));
    } else if (kind === 'door') {
      if (this.t - this.lastDoorT < this.cfg.doorOpenGapSec) return;
      // 容疑者自身がドアを開けている音は数えない（巡回の増加 → 警戒度の自己増殖を避ける）
      for (const s of this.suspects()) if (s.isOpeningDoor) return;
      this.lastDoorT = this.t;
      this.add('doorOpen', this.hearFactor(pos));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}
