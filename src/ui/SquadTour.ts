import { t } from '../core/i18n';

/**
 * 初回プレイ時だけ出す「Z キーで仲間に指示」ツアー（SWAT モード）。
 * 画面下の「Z : 〜」表示の真上に吹き出しを出し、Z を押すたびに次の段階へ進む。
 * それ以外の操作は後から覚えればよいので、ここでは Z（と呼び戻しの X）だけ教える。
 */
const STYLE_ID = 'squad-tour-style';
const CSS = `
.sqt-tip{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:12;width:min(460px,90vw);box-sizing:border-box;background:rgba(18,38,60,.94);border:2px solid #8fd3ff;border-radius:10px;padding:12px 16px;color:#eaf4ff;font:15px/1.6 sans-serif;pointer-events:none;box-shadow:0 10px 30px rgba(0,0,0,.55);transition:opacity .4s}
.sqt-tip::after{content:'';position:absolute;bottom:-10px;left:50%;margin-left:-9px;border:9px solid transparent;border-top-color:#8fd3ff;border-bottom:0}
.sqt-step{font:bold 12px monospace;letter-spacing:.1em;color:#8fd3ff;margin-bottom:2px}
.sqt-title{font:bold 17px sans-serif;margin-bottom:2px}
.sqt-tip kbd{display:inline-block;min-width:1.4em;padding:0 6px;margin:0 2px;font:bold 15px monospace;text-align:center;color:#0a121a;background:#ffe28a;border-radius:4px}
.sqt-sub{font-size:13px;color:#a9bfd6;margin-top:4px}
.sqt-pulse{animation:sqt-pulse 1.4s ease-in-out infinite}
@keyframes sqt-pulse{0%,100%{box-shadow:0 0 0 0 rgba(143,211,255,.6)}50%{box-shadow:0 0 0 8px rgba(143,211,255,0)}}
`;

const STEP_COUNT = 3;

function getStep(index: number): { title: string; body: string; sub?: string } {
  const steps: { title: string; body: string; sub?: string }[] = [
    {
      title: t('仲間への指示は <kbd>Z</kbd>（まず確認が大事）', 'Command your squad with <kbd>Z</kbd> (recon first)'),
      body: t(
        '見ている場所に合わせて、下の「Z : ○○」の指示を仲間が実行します。ドアに近づいて、ドアを見ながら <kbd>Z</kbd> を押してみよう。未確認のドアでは仲間がミラーで確認してから突入します。',
        'Your squad executes the context action shown at the bottom ("Z : ..."). Walk up to a door, look at it, and press <kbd>Z</kbd>. On unscouted doors your squad mirrors under the door first, then enters.',
      ),
      sub: t(
        '<kbd>4</kbd> オプティワンドで自分で確認すると、ミラーを省いて閃光突入などにすぐ移れます（ミラーは見落とすことも）',
        'Scout yourself with the <kbd>4</kbd> Optiwand to skip the mirror and go straight to flash entry (the mirror can miss contacts)',
      ),
    },
    {
      title: t('いいね！ 続けて <kbd>Z</kbd> で次の行動', 'Nice! Press <kbd>Z</kbd> again for the next step'),
      body: t(
        '確認中にもう一度 <kbd>Z</kbd> を押すと打ち切って素のクリアで突入しますが、待ち伏せされると大きな被害が出ます。',
        'Pressing <kbd>Z</kbd> again mid-mirror skips it for a plain, unflashed entry, and ambushes hurt.',
      ),
    },
    {
      title: t('これで指揮はバッチリ', 'You have got the basics!'),
      body: t(
        '仲間を呼び戻すときは <kbd>X</kbd>。ほかの操作は、慣れてから少しずつで大丈夫です。',
        'Press <kbd>X</kbd> to recall your squad. You can pick up the rest of the controls as you go.',
      ),
    },
  ];
  return steps[index]!;
}

/** 最終段階を表示しておく秒数 */
const LAST_STEP_SEC = 6;

export class SquadTour {
  private readonly root = document.createElement('div');
  private step = 0;
  private lastTimer = 0;
  private finished = false;

  constructor(
    parent: HTMLElement,
    private readonly onDone: () => void,
  ) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.root.className = 'sqt-tip sqt-pulse';
    this.root.style.display = 'none';
    parent.appendChild(this.root);
    this.render();
  }

  get done(): boolean {
    return this.finished;
  }

  setVisible(v: boolean): void {
    if (this.finished) return;
    if (v) this.render();
    this.root.style.display = v ? 'block' : 'none';
  }

  /** 毎フレーム。zPressed: このフレームで Z（クイック指示）が押されたか。 */
  update(dt: number, zPressed: boolean): void {
    if (this.finished) return;
    if (this.step < STEP_COUNT - 1) {
      if (zPressed) {
        this.step++;
        if (this.step === STEP_COUNT - 1) {
          this.lastTimer = LAST_STEP_SEC;
          this.root.classList.remove('sqt-pulse');
          // 最後まで見せたら既読（途中でページを閉じても最低限は覚えている）
          this.onDone();
        }
        this.render();
      }
      return;
    }
    this.lastTimer -= dt;
    if (this.lastTimer <= 0.4) this.root.style.opacity = String(Math.max(0, this.lastTimer / 0.4));
    if (this.lastTimer <= 0) this.finish();
  }

  /** ミッション終了時など。表示済みなら既読にして片付ける。 */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.root.remove();
    this.onDone();
  }

  dispose(): void {
    this.finished = true;
    this.root.remove();
  }

  private render(): void {
    const s = getStep(this.step);
    this.root.innerHTML =
      `<div class="sqt-step">TUTORIAL ${this.step + 1}/${STEP_COUNT}</div>` +
      `<div class="sqt-title">${s.title}</div><div>${s.body}</div>` +
      (s.sub ? `<div class="sqt-sub">${s.sub}</div>` : '');
  }
}
