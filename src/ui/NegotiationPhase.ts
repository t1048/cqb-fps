/** 突入前交渉フェーズの汎用 UI（モード別のシナリオは modes/PreAssaultNegotiation.ts）。 */

export interface NegotiationMeter {
  label: string;
  value: number;
  max: number;
  color: string;
  /** 値の表示（省略時は value/max） */
  text?: string;
}

export interface NegotiationOption {
  label: string;
  desc: string;
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

/**
 * 突入前の交渉画面。数字キー 1〜9 / クリックで選択、Enter で交渉を終えて突入（開始）。
 * 交渉は電話越しの想定で、ゲーム内の時間は進まない。
 */
export class NegotiationPhase {
  private readonly root = document.createElement('div');
  private readonly logEl = document.createElement('div');
  private readonly metersEl = document.createElement('div');
  private readonly optionsEl = document.createElement('div');
  private readonly finishBtn = document.createElement('button');
  private visible = false;
  private disposed = false;

  constructor(
    parent: HTMLElement,
    private readonly scenario: NegotiationScenario,
    private readonly onFinish: () => void,
  ) {
    this.root.style.cssText =
      'position:fixed;inset:0;z-index:15;display:none;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(8,12,18,0.9);color:#e6eef8;font:14px/1.5 sans-serif';
    const card = document.createElement('div');
    card.style.cssText =
      'width:100%;max-width:860px;max-height:94vh;overflow:auto;background:#111822;border:1px solid #354a63;border-radius:8px;padding:20px 24px;box-sizing:border-box;box-shadow:0 12px 36px rgba(0,0,0,.65)';
    const badge = document.createElement('div');
    badge.textContent = 'NEGOTIATION — 突入前交渉';
    badge.style.cssText = 'font:bold 11px monospace;letter-spacing:.14em;color:#f2c14e;margin-bottom:4px';
    const title = document.createElement('div');
    title.textContent = scenario.title;
    title.style.cssText = 'font:bold 22px sans-serif;color:#f4f8fc';
    const sub = document.createElement('div');
    sub.textContent = scenario.subtitle;
    sub.style.cssText = 'font:13px/1.6 sans-serif;color:#9fb4c8;margin:4px 0 14px';

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-wrap:wrap;gap:16px;align-items:stretch';
    const left = document.createElement('div');
    left.style.cssText = 'flex:1 1 360px;min-width:280px;display:flex;flex-direction:column;gap:10px';
    this.metersEl.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px';
    this.logEl.style.cssText =
      'flex:1;min-height:200px;max-height:320px;overflow:auto;background:#0b1118;border:1px solid #2a3c52;border-radius:6px;padding:10px 12px;font:13px/1.6 sans-serif';
    left.append(this.metersEl, this.logEl);
    this.optionsEl.style.cssText = 'flex:1 1 300px;min-width:260px;display:flex;flex-direction:column;gap:6px';
    body.append(left, this.optionsEl);

    const footer = document.createElement('div');
    footer.style.cssText = 'margin-top:16px;padding-top:12px;border-top:1px solid #263649;display:flex;justify-content:flex-end';
    this.finishBtn.type = 'button';
    this.finishBtn.style.cssText =
      'padding:11px 26px;font:bold 15px sans-serif;color:#0a121a;background:#f2c14e;border:none;border-radius:6px;cursor:pointer';
    this.finishBtn.addEventListener('click', this.finish);
    footer.appendChild(this.finishBtn);

    card.append(badge, title, sub, body, footer);
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
    const el = document.createElement('div');
    el.textContent = l.text;
    el.style.color = TONE_COLOR[l.tone];
    if (l.tone === 'me') el.style.paddingLeft = '0';
    this.logEl.appendChild(el);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private choose(i: number): void {
    const opt = this.scenario.options[i];
    if (!opt || this.scenario.isOver() || this.scenario.turnsLeft() <= 0 || opt.disabledReason() !== null) return;
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px dashed #2a3c52;margin:6px 0';
    this.logEl.appendChild(sep);
    for (const l of opt.run()) this.pushLine(l);
    if (this.scenario.isOver() || this.scenario.turnsLeft() <= 0) {
      const sep2 = document.createElement('div');
      sep2.style.cssText = 'border-top:1px solid #4a5a70;margin:8px 0 4px';
      this.logEl.appendChild(sep2);
      for (const s of this.scenario.summary()) this.pushLine({ text: s, tone: 'info' });
    }
    this.render();
  }

  private render(): void {
    this.metersEl.textContent = '';
    const meters = [
      ...this.scenario.meters(),
      { label: '残り交渉回数', value: this.scenario.turnsLeft(), max: Math.max(1, this.scenario.turnsLeft()), color: '#7ce2f0', text: String(this.scenario.turnsLeft()) },
    ];
    for (const m of meters) {
      const box = document.createElement('div');
      box.style.cssText = 'background:#16202c;border:1px solid #293b50;border-radius:6px;padding:6px 10px';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;font:12px sans-serif;color:#9cb4cc';
      const a = document.createElement('span');
      a.textContent = m.label;
      const b = document.createElement('span');
      b.textContent = m.text ?? `${Math.round(m.value)} / ${m.max}`;
      b.style.color = m.color;
      head.append(a, b);
      const track = document.createElement('div');
      track.style.cssText = 'height:5px;margin-top:4px;background:rgba(255,255,255,.1);border-radius:2px';
      const fill = document.createElement('div');
      fill.style.cssText = `height:100%;border-radius:2px;background:${m.color};width:${Math.max(0, Math.min(100, (m.value / m.max) * 100))}%`;
      track.appendChild(fill);
      box.append(head, track);
      this.metersEl.appendChild(box);
    }

    const over = this.scenario.isOver() || this.scenario.turnsLeft() <= 0;
    this.optionsEl.textContent = '';
    this.scenario.options.forEach((opt, i) => {
      const reason = over ? '交渉は終了した' : opt.disabledReason();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.disabled = reason !== null;
      btn.style.cssText =
        'text-align:left;padding:8px 10px;border-radius:5px;font:13px/1.45 sans-serif;' +
        (reason === null
          ? 'color:#e6eef8;background:#192534;border:1px solid #3d5672;cursor:pointer'
          : 'color:#6d7d8f;background:#141c26;border:1px solid #243244;cursor:default');
      const t = document.createElement('div');
      t.style.cssText = 'font-weight:bold';
      t.textContent = `${i + 1}. ${opt.label}`;
      const d = document.createElement('div');
      d.style.cssText = 'font-size:12px;opacity:.85';
      d.textContent = reason ?? opt.desc;
      btn.append(t, d);
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
    if (/^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      this.choose(Number(e.code.slice(5)) - 1);
    } else if (e.code === 'Enter') {
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
