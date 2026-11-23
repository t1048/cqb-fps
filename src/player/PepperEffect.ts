import type { PlayerController } from './PlayerController';
import type { Subtitle } from '../ui/Subtitle';
import type { WeaponSystem } from '../weapons/WeaponSystem';

/** 1 発あたりの蓄積と毎秒の減衰 */
const PER_HIT = 24;
const DECAY_PER_SEC = 8;

/**
 * 容疑者モード: SWAT のペッパーボールを浴びた状態。
 * 目が開けられない（橙色のにじみ・ぼかし）、咳き込んで足が止まり、照準が揺れて拡散が増す。
 * WeaponSystem / HostageGrab の後に update する（speedMultiplier を掛け合わせるため）。
 */
export class PepperEffect {
  private level = 0;
  private readonly el = document.createElement('div');
  private coughCd = 0;
  private shown = -1;

  constructor(
    private readonly player: PlayerController,
    private readonly weapons: WeaponSystem,
    private readonly subtitle: Subtitle,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.el.style.cssText =
      'position:fixed;inset:0;z-index:4;pointer-events:none;opacity:0;' +
      'background:radial-gradient(ellipse at center, rgba(255,140,40,.15) 0%, rgba(230,90,20,.55) 55%, rgba(150,30,10,.9) 100%)';
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
    if (first) this.subtitle.show('ペッパーボールを浴びた！ 目が…！', 1.4);
  }

  update(rawDt: number): void {
    const dt = Math.min(rawDt, 0.05);
    if (!this.player.alive) this.level = 0;
    this.level = Math.max(0, this.level - DECAY_PER_SEC * dt);
    const k = this.level / 100;
    this.weapons.extraSpread = k * 6;
    if (k > 0) {
      this.player.speedMultiplier *= 1 - 0.5 * k;
      this.player.addViewKick((Math.random() - 0.5) * 0.01 * k, (Math.random() - 0.5) * 0.016 * k);
      this.coughCd -= dt;
      if (k > 0.45 && this.coughCd <= 0) {
        this.coughCd = 2.5 + Math.random() * 2;
        this.subtitle.show('ゴホッ、ゴホッ…！ 目が開けられない', 1.0);
        this.player.addViewKick(0.025 * k, (Math.random() - 0.5) * 0.04);
      }
    }
    const step = Math.round(k * 40);
    if (step !== this.shown) {
      this.shown = step;
      this.el.style.opacity = String(Math.min(0.92, k * 1.1));
      this.canvas.style.filter = step > 0 ? `blur(${(k * 5).toFixed(1)}px)` : '';
    }
  }

  dispose(): void {
    this.el.remove();
    this.canvas.style.filter = '';
    this.weapons.extraSpread = 0;
  }
}
