import type { StageEntry } from '../core/types';
import type { RoE } from '../rules/RoE';
import type { ScoreEntry } from '../rules/ScoreBoard';

const ROW_STYLE = 'display:flex;justify-content:space-between;gap:24px;padding:2px 0';

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtPts(p: number): string {
  return p > 0 ? `+${p}` : String(p);
}

/** 画面右上の現在スコアと直近の加減点ログ。 */
export class ScoreHud {
  private readonly el = document.createElement('div');
  private readonly logEl = document.createElement('div');
  private readonly scoreEl = document.createElement('div');
  private readonly lines: HTMLElement[] = [];
  private disposed = false;

  constructor(parent: HTMLElement, private readonly roe: RoE, private readonly maxLines = 4) {
    this.el.style.cssText =
      'width:100%;padding:6px 10px;background:rgba(10,16,24,.72);border:1px solid rgba(110,145,180,.35);border-radius:5px;box-sizing:border-box;color:#fff;font:13px sans-serif;text-align:right;pointer-events:none;text-shadow:0 0 3px #000';
    this.scoreEl.style.cssText = 'font:bold 18px sans-serif';
    this.el.append(this.scoreEl, this.logEl);
    parent.appendChild(this.el);
    this.refresh();
    roe.onEntry = (e) => this.push(e);
  }

  private refresh(): void {
    this.scoreEl.textContent = `SCORE ${this.roe.board.total}`;
  }

  private push(e: ScoreEntry): void {
    if (this.disposed) return;
    const line = document.createElement('div');
    line.textContent = `${e.label} ${fmtPts(e.points)}`;
    line.style.color = e.points < 0 ? '#ff6b6b' : '#8fe38f';
    this.logEl.prepend(line);
    this.lines.unshift(line);
    while (this.lines.length > this.maxLines) this.lines.pop()?.remove();
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.el.remove();
    this.lines.length = 0;
  }
}

export interface ResultScreenOptions {
  stages?: readonly StageEntry[];
  currentStageId?: string;
  onSelectStage?: (stageId: string) => void;
}

/** ミッション終了時のリザルト画面。リトライボタン / R / Enter で onRetry、または別ステージへ切替。 */
export class ResultScreen {
  private el: HTMLElement | null = null;
  private stageSectionEl: HTMLElement | null = null;
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly parent: HTMLElement,
    private readonly roe: RoE,
    private readonly onRetry: () => void,
    private readonly options?: ResultScreenOptions,
  ) {}

  show(failed = false): void {
    if (this.el || this.disposed) return;
    const b = this.roe.board;
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.84);color:#fff;font:16px sans-serif;display:flex;align-items:center;justify-content:center;z-index:20';
    const panel = document.createElement('div');
    panel.style.cssText = 'min-width:420px;max-width:560px;max-height:90vh;overflow:auto;padding:24px 32px;background:#14181c;border:1px solid #556;border-radius:8px';

    const title = document.createElement('div');
    title.textContent = failed ? 'MISSION FAILED' : 'MISSION COMPLETE';
    title.style.cssText = `font:bold 28px sans-serif;margin-bottom:8px;color:${failed ? '#ff6b6b' : '#7ce2f0'}`;
    panel.appendChild(title);

    if (failed) {
      const sub = document.createElement('div');
      sub.textContent = '隊長が行動不能になりました。遮蔽物・リーン・隊員の先行突入を活用してください。';
      sub.style.cssText = 'font:13px/1.5 sans-serif;color:#ffb4b4;margin-bottom:12px;padding:8px 10px;background:rgba(140,30,30,0.3);border:1px solid #944;border-radius:4px';
      panel.appendChild(sub);
    }

    const summary = document.createElement('div');
    summary.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px';
    const score = document.createElement('div');
    score.textContent = b.maxPossibleScore > 0 ? `総合スコア ${b.total} / ${b.maxPossibleScore}` : `総合スコア ${b.total}`;
    score.style.cssText = 'font:bold 22px sans-serif';
    const rank = document.createElement('div');
    rank.textContent = failed ? 'FAILED' : `RANK ${b.rank}`;
    rank.style.cssText = `font:bold 30px sans-serif;color:${failed ? '#ff6b6b' : '#ffd24d'}`;
    summary.append(score, rank);
    panel.appendChild(summary);

    const stats: [string, string][] = [
      ['クリアタイム', fmtTime(this.roe.elapsed)],
      ['逮捕', String(b.count('arrest'))],
      ['証拠回収', String(b.count('evidence'))],
      ['無力化(正当防衛)', String(b.count('neutralize'))],
      ['民間人保護', String(b.count('civilianSecured'))],
      ['RoE違反', String(b.violations)],
    ];
    for (const [k, v] of stats) {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE;
      const a = document.createElement('span');
      a.textContent = k;
      const c = document.createElement('span');
      c.textContent = v;
      row.append(a, c);
      panel.appendChild(row);
    }

    const h = document.createElement('div');
    h.textContent = '評価内訳';
    h.style.cssText = 'font:bold 16px sans-serif;margin:14px 0 4px;border-top:1px solid #445;padding-top:10px';
    panel.appendChild(h);
    if (b.entries.length === 0) {
      const none = document.createElement('div');
      none.textContent = '(なし)';
      panel.appendChild(none);
    }
    for (const e of b.entries) {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE + ';color:' + (e.points < 0 ? '#ff6b6b' : '#8fe38f');
      const a = document.createElement('span');
      a.textContent = `[${fmtTime(e.time)}] ${e.label} (${e.targetId})`;
      const c = document.createElement('span');
      c.textContent = fmtPts(e.points);
      row.append(a, c);
      panel.appendChild(row);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'リトライ (R / Enter)';
    btn.style.cssText = 'margin-top:18px;width:100%;padding:10px;font:bold 16px sans-serif;cursor:pointer';
    btn.addEventListener('click', this.retry);
    this.cleanups.push(() => btn.removeEventListener('click', this.retry));
    panel.appendChild(btn);

    const stages = this.options?.stages;
    const onSelectStage = this.options?.onSelectStage;
    if (stages && stages.length > 1 && onSelectStage) {
      const stageSection = document.createElement('div');
      stageSection.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid #445';
      const stageTitle = document.createElement('div');
      stageTitle.textContent = 'ステージ選択';
      stageTitle.style.cssText = 'font:bold 13px sans-serif;color:#9cb4cc;margin-bottom:8px';
      const stageRow = document.createElement('div');
      stageRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
      const currentId = this.options?.currentStageId;
      for (const stage of stages) {
        const active = stage.id === currentId;
        const sBtn = document.createElement('button');
        sBtn.type = 'button';
        sBtn.textContent = active ? `${stage.name} (現在)` : stage.name;
        sBtn.title = stage.description ?? stage.name;
        sBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
        sBtn.dataset.stageId = stage.id;
        sBtn.disabled = active;
        sBtn.style.cssText = active
          ? 'flex:1 1 auto;padding:7px 10px;font:bold 13px sans-serif;color:#0a121a;background:#56c8d8;border:1px solid #56c8d8;border-radius:4px;cursor:default'
          : 'flex:1 1 auto;padding:7px 10px;font:13px sans-serif;color:#dce6f2;background:#1d2733;border:1px solid #445870;border-radius:4px;cursor:pointer';
        if (!active) {
          const onClick = (): void => {
            if (!this.disposed) onSelectStage(stage.id);
          };
          sBtn.addEventListener('click', onClick);
          this.cleanups.push(() => sBtn.removeEventListener('click', onClick));
        }
        stageRow.appendChild(sBtn);
      }
      stageSection.append(stageTitle, stageRow);
      panel.appendChild(stageSection);
      this.stageSectionEl = stageSection;
    }

    el.appendChild(panel);
    this.parent.appendChild(el);
    this.el = el;
    window.addEventListener('keydown', this.onKey);
    btn.focus();
  }

  private retry = (): void => {
    if (!this.disposed) this.onRetry();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (this.disposed || e.repeat) return;
    if (e.code === 'KeyR' || e.code === 'Enter') {
      if (e.code === 'Enter' && e.target instanceof Node && this.stageSectionEl?.contains(e.target)) return;
      e.preventDefault();
      this.retry();
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    window.removeEventListener('keydown', this.onKey);
    this.el?.remove();
    this.el = null;
    this.stageSectionEl = null;
  }
}
