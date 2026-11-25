import type { PlayerController } from './PlayerController';
import type { Subtitle } from '../ui/Subtitle';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import { t } from '../core/i18n';

/** 1 発あたりの蓄積と毎秒の減衰 */
const PER_HIT = 24;
const DECAY_PER_SEC = 8;

/**
 * 容疑者モード: SWAT のペッパーボールを浴びた状態。
 * 目が開けられない（乳白琥珀色の霞オーバーレイ。WebGL キャンバスへの blur フィルタは使わず opacity のみで軽量合成）、
 * 咳き込んで足が止まり、照準が揺れて拡散が増す。
 * WeaponSystem / HostageGrab の後に update する（speedMultiplier を掛け合わせるため）。
 */
export class PepperEffect {
  private level = 0;
  private readonly el = document.createElement('div');
  private coughCd = 0;
  private shown = 0;

  constructor(
    private readonly player: PlayerController,
    private readonly weapons: WeaponSystem,
    private readonly subtitle: Subtitle,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.el.style.cssText =
      'position:fixed;inset:0;z-index:4;pointer-events:none;opacity:0;display:none;' +
      'background:' +
      'radial-gradient(circle at 50% 48%, rgba(255,215,155,.46) 0%, rgba(255,165,75,.55) 36%, rgba(225,95,25,.74) 70%, rgba(135,28,10,.92) 100%),' +
      'radial-gradient(circle at 35% 40%, rgba(255,235,190,.24) 0%, rgba(255,150,60,0) 55%)';
    document.body.appendChild(this.el);
  }

  get amount(): number {
    return this.level;
  }

  hit(): void {
    if (!this.player.alive) return;
    const first = this.level < 5;
    this.level = Math.min(100, this.level + PER_HIT);
    this.player.addViewKick(0.01, (Math.random() - 0.5) * 0.05);
    if (first) this.subtitle.show(t('胡椒だ。目がやられた', 'Pepper. Can\'t see.'), 1.4);
  }

  update(rawDt: number): void {
    const dt = Math.min(rawDt, 0.05);
    if (!this.player.alive) this.level = 0;
    if (this.level <= 0) {
      if (this.shown !== 0) {
        this.shown = 0;
        this.el.style.opacity = '0';
        this.el.style.display = 'none';
        this.canvas.style.filter = '';
      }
      return;
    }
    this.level = Math.max(0, this.level - DECAY_PER_SEC * dt);
    const k = this.level / 100;
    if (k > 0) {
      this.weapons.extraSpread += k * 6;
      this.player.speedMultiplier *= 1 - 0.5 * k;
      this.player.addViewKick((Math.random() - 0.5) * 0.01 * k, (Math.random() - 0.5) * 0.016 * k);
      this.coughCd -= dt;
      if (k > 0.45 && this.coughCd <= 0) {
        this.coughCd = 2.5 + Math.random() * 2;
        this.subtitle.show(t('ゴホッ、ゴホッ…！ 目が開けられない', "*Cough, cough*...! I can't open my eyes!"), 1.0);
        this.player.addViewKick(0.025 * k, (Math.random() - 0.5) * 0.04);
      }
    }
    // 粗い8段階量子化＋小半径（<=3.5px）に抑え、毎フレームのコンポジタ再構築と多段ガウスぼかしを回避
    const step = k > 0 ? Math.max(1, Math.round(k * 8)) : 0;
    if (step !== this.shown) {
      const wasZero = this.shown === 0;
      this.shown = step;
      if (step > 0) {
        if (wasZero) this.el.style.display = 'block';
        const s = step / 8;
        this.el.style.opacity = String(Math.min(0.9, s * 1.05));
        this.canvas.style.filter = `blur(${(s * 3.5).toFixed(1)}px)`;
      } else {
        this.el.style.opacity = '0';
        this.el.style.display = 'none';
        this.canvas.style.filter = '';
      }
    }
  }

  dispose(): void {
    this.el.remove();
    if (this.canvas.style.filter) this.canvas.style.filter = '';
    this.weapons.extraSpread = 0;
  }
}
