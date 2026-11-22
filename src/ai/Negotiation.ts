import type { GameEventBus, NegotiationResult } from '../core/events';
import { SuspectState } from '../core/events';
import type { NegotiationChoiceDef, NegotiationConfig, Vec3 } from '../core/types';
import type { Collider } from '../world/WorldBuilder';
import { segmentHitsAABB } from './HostageShield';
import type { Suspect } from './Suspect';

export type ContactKind = 'door' | 'cover' | 'shield';

export interface ContactInfo {
  suspect: Suspect;
  kind: ContactKind;
  dist: number;
}

/**
 * 交渉の開始可否判定（MVP_SPEC §3 NEGOTIATION の発生条件）。
 *  - 状態が cfg.allowedStates、水平距離 ≦ range、視線コーン内、再交渉ロック中でない
 *  - 人質盾（directSightStates かつ盾保持中）なら遮蔽不問
 *  - それ以外は、目→胸の線分が cfg.blockers（door/cover）にのみ遮られている（壁に遮られる/素通しは不可）
 * 該当しなければ null。
 */
export function judgeContact(
  cfg: NegotiationConfig,
  colliders: readonly Collider[],
  eye: Vec3,
  yawRad: number,
  s: Suspect,
): ContactInfo | null {
  if (!s.alive || s.negotiationLocked || !cfg.allowedStates.includes(s.state)) return null;
  const c = s.body.chestPos();
  const dx = c.x - eye.x;
  const dz = c.z - eye.z;
  const dist = Math.hypot(dx, dz);
  if (dist > cfg.range) return null;
  const fx = -Math.sin(yawRad);
  const fz = -Math.cos(yawRad);
  if (dist > 0.01 && (dx * fx + dz * fz) / dist < Math.cos((cfg.coneDeg / 2) * (Math.PI / 180))) return null;
  if (cfg.directSightStates.includes(s.state) && s.isHoldingHostage) return { suspect: s, kind: 'shield', dist };
  let door = false;
  let cover = false;
  for (const col of colliders) {
    if (!segmentHitsAABB(col.aabb, eye, c)) continue;
    if (!cfg.blockers.includes(col.kind)) return null; // 壁など許可外の遮蔽
    if (col.kind === 'door') door = true;
    else cover = true;
  }
  if (!door && !cover) return null; // 素通し（遮蔽越しではない）
  return { suspect: s, kind: door ? 'door' : 'cover', dist };
}

export interface ChoiceOutcome {
  /** 画面ログに出す行（成否の台詞） */
  lines: string[];
  success: boolean;
  /** 交渉が終了したか */
  ended: NegotiationResult | null;
}

export interface SessionView {
  suspectId: string;
  remainingSec: number;
  totalSec: number;
  cooldownSec: number;
  trust: number;
  trustMax: number;
  fails: number;
  maxFails: number;
  /** 0〜100（容疑者の士気=動揺度の逆。UI では低いほど投降に近い） */
  morale: number;
  hostage: boolean;
  demandKnown: boolean;
}

const rand = (r: { min: number; max: number }): number => r.min + Math.random() * (r.max - r.min);
const clamp01 = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * 1 回の交渉セッション。容疑者を NEGOTIATION ステートへ移し、選択肢で士気・状態を変化させる。
 * 成功 → 士気低下（閾値未満で投降／人質盾なら shieldReleaseBelow 未満で人質解放＋投降）。
 * 失敗 → 士気上昇（硬化）・失敗回数加算、確率 or maxFails 到達で発砲。
 * 時間切れ → 士気上昇＋確率で発砲、さもなくば悪化（敵対化）。
 * 被弾・フラッシュ等による外部からの状態変化/士気低下も毎フレーム検知して終了する。
 */
export class NegotiationSession {
  private remaining: number;
  private cooldown = 0;
  private trust = 0;
  private fails = 0;
  private demandKnown = false;
  private ended: NegotiationResult | null = null;
  readonly hadHostage: boolean;

  constructor(
    private readonly cfg: NegotiationConfig,
    readonly suspect: Suspect,
    private readonly bus: GameEventBus,
  ) {
    this.remaining = cfg.timeoutSec;
    this.hadHostage = suspect.negotiatingWithHostage;
    this.bus.emit('negotiation', { suspectId: suspect.id, phase: 'start', morale: suspect.morale.value });
  }

  get result(): NegotiationResult | null {
    return this.ended;
  }

  view(): SessionView {
    return {
      suspectId: this.suspect.id,
      remainingSec: this.remaining,
      totalSec: this.cfg.timeoutSec,
      cooldownSec: this.cooldown,
      trust: this.trust,
      trustMax: this.cfg.trustMax,
      fails: this.fails,
      maxFails: this.cfg.maxFails,
      morale: this.suspect.morale.value,
      hostage: this.suspect.negotiatingWithHostage,
      demandKnown: this.demandKnown,
    };
  }

  /** 毎フレーム。終了したら結果を返す（以後 update/choose は無効）。 */
  update(rawDt: number): NegotiationResult | null {
    if (this.ended) return this.ended;
    const dt = Math.min(rawDt, 0.05);
    const s = this.suspect;
    if (s.state !== SuspectState.NEGOTIATION) return this.finish('interrupted', false); // 被弾/外部要因で遷移済み
    if (s.morale.value < s.profile.thresholds.surrenderBelow) return this.finish(s.negotiatingWithHostage ? 'release' : 'surrender');
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.remaining -= dt;
    if (this.remaining <= 0) {
      s.morale.shift(rand(this.cfg.timeout.moraleRise));
      const p = s.negotiatingWithHostage ? this.cfg.timeout.shieldFireChance : this.cfg.timeout.fireChance;
      return this.finish(Math.random() < p ? 'fire' : 'worsen');
    }
    return null;
  }

  /** 選択肢の成功率（0〜1）。 */
  chance(c: NegotiationChoiceDef): number {
    const k = c.chance;
    const v =
      k.base +
      this.trust * k.trustBonus -
      this.suspect.profile.aggression * k.aggressionWeight -
      (this.suspect.morale.value / 100) * k.moraleWeight;
    return clamp01(v, k.min, k.max);
  }

  /** 選択肢を実行。クールダウン中/終了後は null。 */
  choose(id: string): ChoiceOutcome | null {
    if (this.ended || this.cooldown > 0) return null;
    const c = this.cfg.choices.find((x) => x.id === id);
    if (!c || this.suspect.state !== SuspectState.NEGOTIATION) return null;
    this.cooldown = this.cfg.choiceCooldownSec;
    const s = this.suspect;
    const success = Math.random() < this.chance(c);
    const lines: string[] = [];
    let end: NegotiationResult | null = null;
    if (success) {
      s.morale.shift(-rand(c.successMorale));
      this.trust = Math.min(this.cfg.trustMax, this.trust + c.trustGain);
      if (c.successLine) lines.push(c.successLine);
      if (c.revealDemand) {
        this.demandKnown = true;
        lines.push(this.cfg.demands[s.profile.id] ?? this.cfg.defaultDemand);
      }
      const inShield = s.negotiatingWithHostage;
      const threshold = inShield ? this.cfg.shieldReleaseBelow : s.profile.thresholds.surrenderBelow;
      if (s.morale.value < threshold) end = inShield ? 'release' : 'surrender';
    } else {
      s.morale.shift(rand(c.failMorale));
      this.fails++;
      if (c.failLine) lines.push(c.failLine);
      if (Math.random() < c.fireChanceOnFail || this.fails >= this.cfg.maxFails) end = 'fire';
    }
    this.bus.emit('negotiation', { suspectId: s.id, phase: 'choice', choiceId: id, success, morale: s.morale.value });
    if (end) this.finish(end);
    return { lines, success, ended: this.ended };
  }

  /** プレイヤー側の中断（無線を下ろす/離れる/切断）。 */
  abort(): void {
    this.finish('abort');
  }

  private finish(result: NegotiationResult, apply = true): NegotiationResult {
    if (this.ended) return this.ended;
    this.ended = result;
    if (apply) this.suspect.endNegotiation(result, this.cfg.lockoutSec);
    this.bus.emit('negotiation', { suspectId: this.suspect.id, phase: 'end', result, morale: this.suspect.morale.value });
    return result;
  }
}
