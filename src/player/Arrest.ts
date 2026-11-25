import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import { t } from '../core/i18n';
import type { ArrestConfig } from '../core/types';
import type { EntityManager } from '../ai/EntityManager';
import type { Civilian } from '../ai/Civilian';
import type { Suspect } from '../ai/Suspect';
import type { Interaction } from './Interaction';
import type { PlayerController } from './PlayerController';

const ARREST_PRIORITY = 300; // 逮捕(300) > ドア(200)（警告コールは Space キー独立）
const CIVILIAN_PRIORITY = 310; // 民間人保護（容疑者拘束 300 より上、証拠回収 320 より下）
const EVIDENCE_PRIORITY = 320; // 武器が足元に近い時は先に回収（確保してから拘束）

/**
 * 現行犯逮捕（F 長押し→ゲージ→arrest）と証拠回収（落とした武器、evidence）。
 * SURRENDER 以外の容疑者は拘束不可。ゲージは dt 基準（Interaction が 0.05 でクランプ済み）。
 */
export class Arrest {
  private readonly unregs: (() => void)[] = [];
  private readonly eye = new THREE.Vector3();
  private readonly el = document.createElement('div');
  private readonly bar = document.createElement('div');
  private readonly txt = document.createElement('div');
  private holdProgress = -1; // <0: 今フレーム保持なし
  private shown = false;
  private lastPct = -1;
  private lastTxt = '';
  private disposed = false;

  constructor(
    private readonly cfg: ArrestConfig,
    private readonly player: PlayerController,
    private readonly entities: EntityManager,
    private readonly bus: GameEventBus,
    interaction: Interaction,
  ) {
    this.el.style.cssText =
      'position:fixed;left:50%;top:58%;transform:translateX(-50%);width:200px;text-align:center;color:#fff;font:bold 14px sans-serif;pointer-events:none;display:none;z-index:5';
    const track = document.createElement('div');
    track.style.cssText = 'height:8px;margin-top:4px;background:rgba(0,0,0,.6);border:1px solid #fff';
    this.bar.style.cssText = 'height:100%;width:0;background:#4af';
    track.appendChild(this.bar);
    this.el.append(this.txt, track);
    document.body.appendChild(this.el);

    const arrestLabel = (): string => t(this.cfg.arrestText, 'Hold F: Restrain Suspect');
    const civilianLabel = (): string => t(this.cfg.civilianText, 'Hold F: Secure Civilian');
    const evidenceLabel = (): string => t(this.cfg.evidenceText, 'Hold F: Bag Evidence');

    this.unregs.push(
      interaction.register<Suspect>({
        id: 'arrest',
        priority: ARREST_PRIORITY,
        resolve: () => this.findArrestTarget(),
        label: arrestLabel,
        onHold: (s, _dt, sec) => this.progress(sec, this.cfg.holdSec, arrestLabel(), () => this.doArrest(s)),
        onRelease: () => undefined,
      }),
      interaction.register<Civilian>({
        id: 'secureCivilian',
        priority: CIVILIAN_PRIORITY,
        resolve: () => this.findCivilianTarget(),
        label: civilianLabel,
        onHold: (c, _dt, sec) => this.progress(sec, this.cfg.civilianHoldSec, civilianLabel(), () => this.doSecure(c)),
        onRelease: () => undefined,
      }),
      interaction.register<Suspect>({
        id: 'evidence',
        priority: EVIDENCE_PRIORITY,
        resolve: () => this.findEvidenceTarget(),
        label: evidenceLabel,
        onHold: (s, _dt, sec) => this.progress(sec, this.cfg.evidenceHoldSec, evidenceLabel(), () => this.doEvidence(s)),
      }),
    );
  }

  private progress(sec: number, need: number, text: string, done: () => void): void {
    if (text !== this.lastTxt) {
      this.lastTxt = text;
      this.txt.textContent = text;
    }
    this.holdProgress = Math.min(1, sec / need);
    if (sec >= need) {
      this.holdProgress = -1;
      done();
    }
  }

  private inView(x: number, z: number, maxDist: number): boolean {
    this.player.getEyePosition(this.eye);
    const dx = x - this.eye.x;
    const dz = z - this.eye.z;
    const dist = Math.hypot(dx, dz);
    if (dist > maxDist) return false;
    if (dist < 0.85) return true;
    const fx = -Math.sin(this.player.yawRad);
    const fz = -Math.cos(this.player.yawRad);
    return (dx * fx + dz * fz) / dist >= Math.cos((this.cfg.coneDeg / 2) * (Math.PI / 180));
  }

  /** 最も近い SURRENDER 容疑者（距離・視野内） */
  private findArrestTarget(): Suspect | null {
    if (this.disposed) return null;
    let best: Suspect | null = null;
    let bd = Infinity;
    for (const s of this.entities.suspects.values()) {
      if (!s.readyForArrest) continue;
      if (!this.inView(s.body.px, s.body.pz, this.cfg.range)) continue;
      const d = Math.hypot(s.body.px - this.eye.x, s.body.pz - this.eye.z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  /** 最も近い COMPLY の民間人（距離・視野内） */
  private findCivilianTarget(): Civilian | null {
    if (this.disposed) return null;
    let best: Civilian | null = null;
    let bd = Infinity;
    for (const c of this.entities.civilians.values()) {
      if (!c.canSecure) continue;
      if (!this.inView(c.body.px, c.body.pz, this.cfg.civilianRange)) continue;
      const d = Math.hypot(c.body.px - this.eye.x, c.body.pz - this.eye.z);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  private doSecure(c: Civilian): void {
    c.secure(); // civilianStateChanged(→SECURED) を RoE が購読して +30（無傷時）
  }

  /** 武器を落とした未回収の容疑者（投降・逮捕・無力化後）で、武器が近いもの */
  private findEvidenceTarget(): Suspect | null {
    if (this.disposed) return null;
    let best: Suspect | null = null;
    let bd = Infinity;
    for (const s of this.entities.suspects.values()) {
      if (!s.hasUncollectedEvidence) continue;
      const w = s.body.getDroppedWeaponPos()!;
      if (!this.inView(w.x, w.z, this.cfg.evidenceRange)) continue;
      const d = Math.hypot(w.x - this.eye.x, w.z - this.eye.z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  private doArrest(s: Suspect): void {
    if (!s.arrest()) return;
    this.bus.emit('arrest', { targetId: s.id, evidenceCollected: s.evidenceCollected });
  }

  private doEvidence(s: Suspect): void {
    const pos = s.body.getDroppedWeaponPos();
    if (!pos || s.evidenceCollected) return;
    s.collectEvidence();
    this.bus.emit('evidence', { targetId: s.id, pos });
  }

  /** Interaction.update の後に呼ぶ。ゲージ表示を反映 */
  update(_rawDt: number): void {
    if (this.disposed) return;
    if (this.holdProgress >= 0) {
      if (!this.shown) {
        this.shown = true;
        this.el.style.display = 'block';
      }
      const pct = Math.round(this.holdProgress * 100);
      if (pct !== this.lastPct) {
        this.lastPct = pct;
        this.bar.style.width = `${pct}%`;
      }
    } else if (this.shown) {
      this.shown = false;
      this.lastPct = -1;
      this.el.style.display = 'none';
    }
    this.holdProgress = -1;
  }

  dispose(): void {
    this.disposed = true;
    for (const u of this.unregs) u();
    this.unregs.length = 0;
    this.el.remove();
  }
}
