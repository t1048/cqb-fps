const MAX_DT = 0.05;

/** 画面下部の字幕（警告コール等）。表示時間は dt 基準。 */
export class Subtitle {
  private readonly el = document.createElement('div');
  private remaining = 0;
  private disposed = false;

  constructor(parent: HTMLElement) {
    this.el.style.cssText =
      'position:fixed;left:50%;bottom:18%;transform:translateX(-50%);padding:6px 16px;background:rgba(0,0,0,.65);color:#fff;font:bold 20px sans-serif;border-radius:4px;pointer-events:none;display:none;z-index:5';
    parent.appendChild(this.el);
  }

  show(text: string, sec: number): void {
    this.el.textContent = text;
    this.el.style.display = 'block';
    this.remaining = sec;
  }

  update(rawDt: number): void {
    if (this.disposed || this.remaining <= 0) return;
    this.remaining -= Math.min(rawDt, MAX_DT);
    if (this.remaining <= 0) this.el.style.display = 'none';
  }

  dispose(): void {
    this.disposed = true;
    this.el.remove();
  }
}
