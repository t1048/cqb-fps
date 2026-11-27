const MAX_DT = 0.05;

/** 画面下部の字幕（警告コール等）。表示時間は dt 基準。 */
export class Subtitle {
  private readonly wrap = document.createElement('div');
  private readonly el = document.createElement('div');
  private remaining = 0;
  private disposed = false;

  constructor(parent: HTMLElement) {
    // 左下の分隊パネル・右下の弾数/無線と重ならないよう、左右に余白を取った帯の中央へ置く。
    // ドア操作プロンプト（画面高さ 66%・高さ約 30px）の直下に積む。
    this.wrap.style.cssText =
      'position:fixed;left:min(440px,32vw);right:min(372px,26vw);top:calc(66% + 44px);display:flex;justify-content:center;pointer-events:none;z-index:5';
    this.el.style.cssText =
      'max-width:100%;box-sizing:border-box;text-align:center;padding:6px 16px;background:rgba(0,0,0,.65);color:#fff;font:bold 18px/1.35 sans-serif;border-radius:4px;display:none';
    this.wrap.appendChild(this.el);
    parent.appendChild(this.wrap);
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
    this.wrap.remove();
  }
}
