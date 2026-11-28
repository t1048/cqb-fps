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
      title: t('仲間への指示は <kbd>Z</kbd>（段階を踏んで進める）', 'Command your squad with <kbd>Z</kbd> (step by step)'),
      body: t(
        'ドアに近づいて、ドアを見ながら <kbd>Z</kbd> を押すと、まず仲間が扉脇に<b>スタック</b>します（まだ入りません）。続けて <kbd>Z</kbd> で<b>ドアチェック</b>（施錠・ブービートラップの確認）、もう一度で<b>オープン&クリア</b>です。',
        'Look at a door and press <kbd>Z</kbd>: your squad <b>stacks</b> on it (no entry yet). Press <kbd>Z</kbd> again to <b>check the door</b> (lock & booby trap), then once more to <b>open & clear</b>.',
      ),
      sub: t(
        '確認せずに開けると未発見のトラップが爆発することも。<kbd>4</kbd>／中クリックのオプティワンド（左クリック長押しで映像） / 右クリックの「ミラー確認」で部屋の中を先に見ておくと、画面下に「推奨」が出ます',
        'Opening without a check can set off an undiscovered trap. Scout with the <kbd>4</kbd>/MMB Optiwand (hold LMB for the view) or the right-click "Mirror" to get a recommendation at the bottom of the screen',
      ),
    },
    {
      title: t('いいね！ 閃光・ガスは<b>右クリックメニュー</b>から', 'Nice! Flash & gas come from the <b>right-click menu</b>'),
      body: t(
        '容疑者だけの部屋は <b>ガス突入</b>（CS を満たしてから入る）、人質・民間人がいる部屋は <b>閃光クリア</b>。空の部屋は素のオープン&クリアで十分です。数に限りがあり、閃光は容疑者全員の<b>警戒度</b>を大きく上げます。',
        "Suspects only: <b>Gas & Clear</b> (let the CS fill the room first). Hostages or civilians inside: <b>Flash & Clear</b>. Empty room: plain Open & Clear. Supplies are limited, and flashbangs sharply raise every suspect's <b>alert level</b>.",
      ),
    },
    {
      title: t('これで指揮はバッチリ', 'You have got the basics!'),
      body: t(
        '仲間を呼び戻すときは <kbd>X</kbd>。ほかの操作は、慣れてから少しずつで大丈夫です。',
        'Press <kbd>X</kbd> to recall your squad. You can pick up the rest of the controls as you go.',
      ),
      sub: t(
        '階段は上（下）の階口で待ち伏せられやすい場所です。連れて上がらず、<b>階段を見て</b> <kbd>Z</kbd>（階段クリア）で上らせましょう',
        'Stairs are a favorite ambush spot. Instead of leading the squad up, <b>look at the stairs</b> and press <kbd>Z</kbd> (Clear Stairs)',
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
