const MAX_DT = 0.05;

/**
 * フラッシュバンの画面効果（DOM 全画面オーバーレイ）。
 * 白飛び(whiteSec, 不透明度1) → 残光(afterglowSec, afterglowOpacity から 0 へ線形減衰)。すべて dt 基準。
 */
export class FlashOverlay {
  private readonly el = document.createElement('div');
  private white = 0;
  private glow = 0;
  private glowTotal = 0;
  private glowOpacity = 0;
  private lastOpacity = '';
  private disposed = false;

  constructor(container: HTMLElement) {
    this.el.style.cssText =
      'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:8;display:none';
    container.appendChild(this.el);
  }

  /** 現在の不透明度 0〜1（検証用） */
  get opacity(): number {
    if (this.white > 0) return 1;
    return this.glowTotal > 0 ? this.glowOpacity * (this.glow / this.glowTotal) : 0;
  }

  /** 効果を発動。進行中の効果とは長い方・強い方で合成する。 */
  trigger(whiteSec: number, afterglowSec: number, afterglowOpacity: number): void {
    if (this.disposed) return;
    this.white = Math.max(this.white, whiteSec);
    if (afterglowSec > 0) {
      this.glow = afterglowSec;
      this.glowTotal = afterglowSec;
      this.glowOpacity = afterglowOpacity;
    }
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    if (this.white > 0) {
      this.white = Math.max(0, this.white - dt);
    } else if (this.glow > 0) {
      this.glow = Math.max(0, this.glow - dt);
    }
    const o = this.opacity;
    const s = o.toFixed(3);
    if (s !== this.lastOpacity) {
      this.lastOpacity = s;
      this.el.style.opacity = s;
      this.el.style.display = o > 0 ? 'block' : 'none';
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.el.remove();
  }
}
