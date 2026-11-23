/** 突入前交渉フェーズの汎用 UI（モード別のシナリオは modes/PreAssaultNegotiation.ts）。 */

export interface NegotiationMeter {
  label: string;
  value: number;
  max: number;
  color: string;
  /** 値の表示（省略時は value/max） */
  text?: string;
  /** メーターの意味（高い/低いと何が起きるか） */
  hint?: string;
}

/** 選択肢の効果（UI のチップ表示用） */
export interface NegotiationEffects {
  /** 得られるもの（緑） */
  gain?: string[];
  /** 支払うもの・副作用（赤） */
  cost?: string[];
  /** 失敗した場合の結果（成功判定がある選択肢のみ） */
  fail?: string[];
  /** 危険な結果の警告（交渉決裂など） */
  warn?: string;
}

export interface NegotiationOption {
  label: string;
  /** 一言アイコン（絵文字） */
  icon?: string;
  desc: string;
  /** 効果の一覧（現在の状況に応じて変わる） */
  effects?(): NegotiationEffects;
  /** 成功率 0〜1（null / 未定義 = 必ず成功） */
  chance?(): number | null;
  /** 選択不可の理由（null = 選択可） */
  disabledReason(): string | null;
  /** 実行して交渉ログに出す結果を返す */
  run(): NegotiationLine[];
}

export interface NegotiationLine {
  text: string;
  tone: 'me' | 'them' | 'good' | 'bad' | 'info';
}

export interface NegotiationScenario {
  title: string;
  subtitle: string;
  intro: NegotiationLine[];
  meters(): NegotiationMeter[];
  /** 残りターン */
  turnsLeft(): number;
  /** 交渉が強制終了したか（決裂など） */
  isOver(): boolean;
  options: NegotiationOption[];
  /** 終了ボタンの文言 */
  finishLabel: string;
  /** 結果サマリ（終了画面に表示） */
  summary(): string[];
}

const TONE_COLOR: Record<NegotiationLine['tone'], string> = {
  me: '#9fd8ff',
  them: '#ffd2a6',
  good: '#8fe38f',
  bad: '#ff7b7b',
  info: '#c7d6e6',
};

const STYLE_ID = 'negotiation-phase-style';
const CSS = `
.ngp-root{position:fixed;inset:0;z-index:15;display:none;align-items:center;justify-content:center;padding:2vh 2vw;box-sizing:border-box;background:rgba(6,10,16,.92);color:#e6eef8;font:16px/1.55 sans-serif}
.ngp-card{width:100%;max-width:1320px;max-height:96vh;overflow:auto;background:#111822;border:1px solid #3a5170;border-radius:10px;padding:24px 30px;box-sizing:border-box;box-shadow:0 14px 40px rgba(0,0,0,.7)}
.ngp-badge{font:bold 13px monospace;letter-spacing:.16em;color:#f2c14e;margin-bottom:4px}
.ngp-title{font:bold 30px sans-serif;color:#f4f8fc}
.ngp-sub{font:15px/1.65 sans-serif;color:#a9bed2;margin:6px 0 16px}
.ngp-meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:16px}
.ngp-meter{background:#16202c;border:1px solid #2d4159;border-radius:8px;padding:10px 14px}
.ngp-meter-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.ngp-meter-label{font:bold 15px sans-serif;color:#b8cbe0}
.ngp-meter-val{font:bold 22px sans-serif}
.ngp-meter-track{height:10px;margin-top:6px;background:rgba(255,255,255,.1);border-radius:5px;overflow:hidden}
.ngp-meter-fill{height:100%;border-radius:5px;transition:width .3s}
.ngp-meter-hint{font-size:12px;color:#8399b0;margin-top:5px;line-height:1.4}
.ngp-body{display:flex;flex-wrap:wrap;gap:18px;align-items:stretch}
.ngp-options{flex:3 1 560px;min-width:300px;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:10px;align-content:start}
.ngp-side{flex:2 1 340px;min-width:280px;display:flex;flex-direction:column;gap:8px}
.ngp-side-title{font:bold 14px sans-serif;color:#8fa6bf;letter-spacing:.08em}
.ngp-log{flex:1;min-height:260px;max-height:52vh;overflow:auto;background:#0b1118;border:1px solid #2a3c52;border-radius:8px;padding:12px 14px;font:15px/1.65 sans-serif}
.ngp-opt{text-align:left;padding:12px 14px;border-radius:8px;font:15px/1.5 sans-serif;color:#e6eef8;background:#192534;border:2px solid #3d5672;cursor:pointer;display:flex;flex-direction:column;gap:8px;transition:background .12s,border-color .12s,transform .12s}
.ngp-opt:not(:disabled):hover,.ngp-opt:not(:disabled):focus-visible{background:#213248;border-color:#7fb4ec;outline:none;transform:translateY(-1px)}
.ngp-opt:disabled{color:#6d7d8f;background:#121a24;border-color:#223143;cursor:default}
.ngp-opt-head{display:flex;align-items:center;gap:10px}
.ngp-key{flex:none;width:32px;height:32px;border-radius:6px;background:#f2c14e;color:#0a121a;font:bold 18px monospace;display:flex;align-items:center;justify-content:center}
.ngp-opt:disabled .ngp-key{background:#2a3646;color:#6d7d8f}
.ngp-opt-label{flex:1;font:bold 17px/1.35 sans-serif}
.ngp-chance{flex:none;font:bold 13px sans-serif;padding:3px 9px;border-radius:999px;white-space:nowrap}
.ngp-row{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.ngp-row-label{font:bold 12px sans-serif;color:#8ea3b9;margin-right:2px}
.ngp-chip{font:bold 13px/1.3 sans-serif;padding:3px 8px;border-radius:5px;white-space:nowrap}
.ngp-gain{background:rgba(92,214,125,.16);color:#8ff0a8;border:1px solid rgba(92,214,125,.45)}
.ngp-cost{background:rgba(255,110,110,.14);color:#ff9a9a;border:1px solid rgba(255,110,110,.45)}
.ngp-fail{background:rgba(255,110,110,.06);color:#d99090;border:1px dashed rgba(255,110,110,.4)}
.ngp-warn{font:bold 13px sans-serif;color:#ffd24d;background:rgba(255,200,60,.12);border:1px solid rgba(255,200,60,.5);border-radius:5px;padding:4px 8px}
.ngp-desc{font-size:13px;line-height:1.5;color:#9fb2c6}
.ngp-opt:disabled .ngp-chip,.ngp-opt:disabled .ngp-warn{opacity:.4}
.ngp-reason{font:bold 14px sans-serif;color:#c58a5a}
.ngp-footer{margin-top:18px;padding-top:14px;border-top:1px solid #263649;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.ngp-help{font-size:14px;color:#8399b0}
.ngp-finish{padding:14px 32px;font:bold 18px sans-serif;color:#0a121a;background:#f2c14e;border:none;border-radius:8px;cursor:pointer}
.ngp-finish:hover{background:#ffd36b}
@media (max-width:640px){.ngp-card{padding:16px}.ngp-title{font-size:22px}.ngp-options{grid-template-columns:1fr}}
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * 突入前の交渉画面。数字キー 1〜9 / クリックで選択、Enter で交渉を終えて突入（開始）。
 * 交渉は電話越しの想定で、ゲーム内の時間は進まない。
 */
export class NegotiationPhase {
  private readonly root = el('div', 'ngp-root');
  private readonly logEl = el('div', 'ngp-log');
  private readonly metersEl = el('div', 'ngp-meters');
  private readonly optionsEl = el('div', 'ngp-options');
  private readonly finishBtn = el('button', 'ngp-finish');
  private visible = false;
  private disposed = false;

  constructor(
    parent: HTMLElement,
    private readonly scenario: NegotiationScenario,
    private readonly onFinish: () => void,
  ) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const card = el('div', 'ngp-card');
    const body = el('div', 'ngp-body');
    const side = el('div', 'ngp-side');
    side.append(el('div', 'ngp-side-title', '通話ログ'), this.logEl);
    body.append(this.optionsEl, side);

    const footer = el('div', 'ngp-footer');
    footer.appendChild(el('div', 'ngp-help', '数字キー 1〜9 / クリックで選択 ・ 緑 = 得るもの　赤 = 失うもの　点線 = 失敗したとき'));
    this.finishBtn.type = 'button';
    this.finishBtn.addEventListener('click', this.finish);
    footer.appendChild(this.finishBtn);

    card.append(
      el('div', 'ngp-badge', 'NEGOTIATION — 突入前交渉'),
      el('div', 'ngp-title', scenario.title),
      el('div', 'ngp-sub', scenario.subtitle),
      this.metersEl,
      body,
      footer,
    );
    this.root.appendChild(card);
    parent.appendChild(this.root);
    for (const l of scenario.intro) this.pushLine(l);
    this.render();
  }

  show(): void {
    if (this.disposed || this.visible) return;
    this.visible = true;
    this.root.style.display = 'flex';
    window.addEventListener('keydown', this.onKey);
    this.finishBtn.focus();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.style.display = 'none';
    window.removeEventListener('keydown', this.onKey);
  }

  private pushLine(l: NegotiationLine): void {
    const line = document.createElement('div');
    line.textContent = l.text;
    line.style.color = TONE_COLOR[l.tone];
    if (l.tone === 'good' || l.tone === 'bad') line.style.fontWeight = 'bold';
    this.logEl.appendChild(line);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private choose(i: number): void {
    const opt = this.scenario.options[i];
    if (!opt || this.scenario.isOver() || this.scenario.turnsLeft() <= 0 || opt.disabledReason() !== null) return;
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px dashed #2a3c52;margin:8px 0';
    this.logEl.appendChild(sep);
    for (const l of opt.run()) this.pushLine(l);
    if (this.scenario.isOver() || this.scenario.turnsLeft() <= 0) {
      const sep2 = document.createElement('div');
      sep2.style.cssText = 'border-top:1px solid #4a5a70;margin:10px 0 6px';
      this.logEl.appendChild(sep2);
      for (const s of this.scenario.summary()) this.pushLine({ text: s, tone: 'info' });
    }
    this.render();
  }

  private renderMeters(): void {
    this.metersEl.textContent = '';
    const turns = this.scenario.turnsLeft();
    const meters: NegotiationMeter[] = [
      ...this.scenario.meters(),
      { label: '残り交渉回数', value: turns, max: 6, color: '#7ce2f0', text: `${turns} 回`, hint: '1 回選ぶごとに 1 減る' },
    ];
    for (const m of meters) {
      const box = el('div', 'ngp-meter');
      const head = el('div', 'ngp-meter-head');
      const val = el('span', 'ngp-meter-val', m.text ?? `${Math.round(m.value)} / ${m.max}`);
      val.style.color = m.color;
      head.append(el('span', 'ngp-meter-label', m.label), val);
      const track = el('div', 'ngp-meter-track');
      const fill = el('div', 'ngp-meter-fill');
      fill.style.background = m.color;
      fill.style.width = `${Math.max(0, Math.min(100, (m.value / m.max) * 100))}%`;
      track.appendChild(fill);
      box.append(head, track);
      if (m.hint) box.appendChild(el('div', 'ngp-meter-hint', m.hint));
      this.metersEl.appendChild(box);
    }
  }

  private chips(row: HTMLElement, items: string[] | undefined, cls: string, prefix: string): void {
    for (const t of items ?? []) row.appendChild(el('span', `ngp-chip ${cls}`, `${prefix}${t}`));
  }

  private render(): void {
    this.renderMeters();
    const over = this.scenario.isOver() || this.scenario.turnsLeft() <= 0;
    this.optionsEl.textContent = '';
    this.scenario.options.forEach((opt, i) => {
      const reason = over ? '交渉は終了した' : opt.disabledReason();
      const btn = el('button', 'ngp-opt');
      btn.type = 'button';
      btn.disabled = reason !== null;

      const head = el('div', 'ngp-opt-head');
      head.append(el('span', 'ngp-key', String(i + 1)), el('span', 'ngp-opt-label', `${opt.icon ? opt.icon + ' ' : ''}${opt.label}`));
      const chance = opt.chance?.() ?? null;
      const pill = el('span', 'ngp-chance', chance === null ? '確実' : `成功率 ${Math.round(chance * 100)}%`);
      const c = chance ?? 1;
      const pc = c >= 0.65 ? '#5cd67d' : c >= 0.4 ? '#f2c14e' : '#ff6b6b';
      pill.style.cssText = `color:${pc};background:${pc}22;border:1px solid ${pc}88`;
      head.appendChild(pill);
      btn.appendChild(head);

      const fx = opt.effects?.() ?? {};
      if ((fx.gain?.length ?? 0) + (fx.cost?.length ?? 0) > 0) {
        const row = el('div', 'ngp-row');
        if (chance !== null) row.appendChild(el('span', 'ngp-row-label', '成功時'));
        this.chips(row, fx.gain, 'ngp-gain', '▲ ');
        this.chips(row, fx.cost, 'ngp-cost', '▼ ');
        btn.appendChild(row);
      }
      if (fx.fail?.length) {
        const row = el('div', 'ngp-row');
        row.appendChild(el('span', 'ngp-row-label', '失敗時'));
        this.chips(row, fx.fail, 'ngp-fail', '');
        btn.appendChild(row);
      }
      if (fx.warn && reason === null) btn.appendChild(el('div', 'ngp-warn', `⚠ ${fx.warn}`));
      btn.appendChild(reason === null ? el('div', 'ngp-desc', opt.desc) : el('div', 'ngp-reason', `× ${reason}`));
      btn.addEventListener('click', () => this.choose(i));
      this.optionsEl.appendChild(btn);
    });
    this.finishBtn.textContent = `${this.scenario.finishLabel} (Enter)`;
  }

  private finish = (): void => {
    if (this.disposed || !this.visible) return;
    this.hide();
    this.onFinish();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (this.disposed || !this.visible || e.repeat) return;
    if (/^(Digit|Numpad)[1-9]$/.test(e.code)) {
      e.preventDefault();
      this.choose(Number(e.code.slice(-1)) - 1);
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      this.finish();
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
    this.finishBtn.removeEventListener('click', this.finish);
    this.root.remove();
  }
}
