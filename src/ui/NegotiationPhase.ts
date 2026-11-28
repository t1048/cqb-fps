/** 突入前交渉フェーズの汎用 UI（モード別のシナリオは modes/PreAssaultNegotiation.ts）。 */
import { t } from '../core/i18n';


export interface NegotiationMeter {
  label: string;
  value: number;
  max: number;
  color: string;
  /** 値の表示（省略時は value/max） */
  text?: string;
  /** メーターの意味（高い/低いと何が起きるか） */
  hint?: string;
  /** true = 上段の大きなゲージではなく、状況ストリップの小さなチップで出す */
  compact?: boolean;
}

/** 選択肢の前提条件（BCSM の段階など）。満たさないと成功率が下がる */
export interface NegotiationRequirement {
  label: string;
  met: boolean;
  /** 満たしていないときの説明（例: 段階不足で成功率が下がる） */
  note?: string;
}

/** 選択肢のまとまり（対話・要求・圧力など） */
export interface NegotiationGroup {
  id: string;
  label: string;
  hint?: string;
}

/** 段階表示（行動変化の階段モデル） */
export interface NegotiationLadder {
  title: string;
  steps: { label: string; hint: string }[];
  /** 現在の段階（0 始まり） */
  index: number;
  /** 次の段階までの進み具合 0..1 */
  progress: number;
  note: string;
}

export interface NegotiationPlanItem {
  icon: string;
  label: string;
  value: string;
  tone: 'good' | 'bad' | 'info' | 'warn';
}

/** 突入プランの切り替え（交渉のターンを使わない） */
export interface NegotiationPlanToggle {
  /** 表示するキー（例: B） */
  key: string;
  /** KeyboardEvent.code（例: KeyB） */
  code: string;
  label: string;
  /** ON にしたときに起きること */
  effects(): { gain: string[]; cost: string[] };
  on(): boolean;
  set(v: boolean): void;
  disabledReason(): string | null;
}

/** 突入プラン欄: 交渉の結果が突入にどう効くかをまとめて見せる */
export interface NegotiationPlan {
  title: string;
  items(): NegotiationPlanItem[];
  toggles?: NegotiationPlanToggle[];
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
  /** NegotiationScenario.groups の id（選択肢をまとめて表示する） */
  group?: string;
  /** 前提条件（満たさないと成功率が下がる。選択は可能） */
  requires?(): NegotiationRequirement | null;
  /** 一言アイコン（絵文字） */
  icon?: string;
  desc: string;
  /** 効果の一覧（現在の状況に応じて変わる） */
  effects?(): NegotiationEffects;
  /** 成功率 0〜1（null / 未定義 = 必ず成功） */
  chance?(): number | null;
  /** 選択不可の理由（null = 選択可） */
  disabledReason(): string | null;
  /** 進行度によるロック理由（指定時はグレーアウト + 🔒 表示し選択不可・オート交渉スキップ） */
  lockedReason?: string;
  /** 実行して交渉ログに出す結果を返す */
  run(): NegotiationLine[];
}

export interface NegotiationLine {
  text: string;
  tone: 'me' | 'them' | 'good' | 'bad' | 'info';
  /** 決裂・人質殺害など見込みに無い重大結果（オート交渉の結果ポップアップに原文を出す） */
  critical?: boolean;
}

export interface NegotiationScenario {
  title: string;
  subtitle: string;
  intro: NegotiationLine[];
  meters(): NegotiationMeter[];
  /** 残りターン */
  turnsLeft(): number;
  /** 交渉回数の上限（残り回数の表示用） */
  maxTurns: number;
  /** 選択肢のまとまり（表示順）。未指定なら 1 つの一覧 */
  groups?: NegotiationGroup[];
  /** 段階表示（SWAT モードの BCSM） */
  ladder?(): NegotiationLadder;
  /** 突入プラン欄 */
  plan?: NegotiationPlan;
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

const PLAN_TONE: Record<NegotiationPlanItem['tone'], string> = {
  good: '#8ff0a8',
  bad: '#ff9a9a',
  warn: '#ffd24d',
  info: '#c7d6e6',
};

const STYLE_ID = 'negotiation-phase-style';
/** オート交渉で進める手数（全ターンは使わず「交渉した感」だけ出す） */
const AUTO_ROUNDS = 3;
/** 選択肢の番号キー（10 個目は 0） */
const keyLabel = (i: number): string => (i === 9 ? '0' : String(i + 1));
const CSS = `
.ngp-root{position:fixed;inset:0;z-index:15;display:none;align-items:center;justify-content:center;padding:2vh 2vw;box-sizing:border-box;background:rgba(6,10,16,.92);color:#e6eef8;font:16px/1.55 sans-serif}
.ngp-card{width:100%;max-width:1360px;max-height:96vh;display:flex;flex-direction:column;overflow:hidden;background:#111822;border:1px solid #3a5170;border-radius:10px;padding:20px 26px;box-sizing:border-box;box-shadow:0 14px 40px rgba(0,0,0,.7)}
.ngp-badge{font:bold 13px monospace;letter-spacing:.16em;color:#f2c14e;margin-bottom:2px}
.ngp-title{font:bold 26px sans-serif;color:#f4f8fc}
.ngp-sub{font:14px/1.6 sans-serif;color:#a9bed2;margin:4px 0 12px}
.ngp-top{flex:none;display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8px}
.ngp-meters{display:contents}
.ngp-meter{flex:1 1 220px;background:#16202c;border:1px solid #2d4159;border-radius:8px;padding:9px 13px}
.ngp-meter-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.ngp-meter-label{font:bold 14px sans-serif;color:#b8cbe0}
.ngp-meter-val{font:bold 21px sans-serif}
.ngp-meter-track{height:9px;margin-top:5px;background:rgba(255,255,255,.1);border-radius:5px;overflow:hidden}
.ngp-meter-fill{height:100%;border-radius:5px;transition:width .3s}
.ngp-meter-hint{font-size:12px;color:#8399b0;margin-top:4px;line-height:1.4}
.ngp-ladder{flex:2 1 420px;background:#16202c;border:1px solid #2d4159;border-radius:8px;padding:9px 13px}
.ngp-ladder-steps{display:flex;align-items:flex-end;gap:4px;margin-top:6px}
.ngp-step{flex:1;border-radius:5px 5px 2px 2px;padding:4px 4px;text-align:center;font:bold 12px/1.25 sans-serif;color:#6f8399;background:#1c2938;border:1px solid #2b3d52;position:relative;overflow:hidden}
.ngp-step-fill{position:absolute;left:0;bottom:0;height:3px;background:#7ce2f0;transition:width .3s}
.ngp-step.done{color:#0a121a;background:#5fb8c4;border-color:#7ce2f0}
.ngp-step.cur{color:#eaffff;background:#244a58;border-color:#7ce2f0;box-shadow:0 0 0 1px #7ce2f0 inset}
.ngp-ladder-note{font-size:12px;color:#8399b0;margin-top:5px;line-height:1.4}
.ngp-strip{flex:none;display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.ngp-stat{display:flex;align-items:center;gap:6px;background:#141d28;border:1px solid #283a4f;border-radius:999px;padding:3px 11px;font:13px sans-serif;color:#a9bed2;cursor:help}
.ngp-stat b{font:bold 14px sans-serif}
.ngp-pips{display:inline-flex;gap:3px}
.ngp-pip{width:8px;height:8px;border-radius:50%;background:#7ce2f0}
.ngp-pip.used{background:#2a3a4c}
.ngp-body{flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-wrap:nowrap;gap:16px;align-items:stretch}
.ngp-options{flex:3 1 560px;min-width:0;max-height:100%;overflow:auto;padding-right:6px;display:flex;flex-direction:column;gap:10px}
.ngp-group-head{display:flex;align-items:baseline;gap:10px;margin:2px 0 -2px;padding-bottom:3px;border-bottom:1px solid #263649}
.ngp-group-label{font:bold 14px sans-serif;letter-spacing:.06em;color:#f2c14e}
.ngp-group-hint{font-size:12px;color:#7d92a8}
.ngp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}
.ngp-side{flex:2 1 340px;min-width:0;max-height:100%;min-height:0;display:flex;flex-direction:column;gap:8px}
.ngp-side-title{font:bold 14px sans-serif;color:#8fa6bf;letter-spacing:.08em}
.ngp-plan{background:#141f2b;border:1px solid #3a5170;border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.ngp-plan-item{display:flex;gap:8px;align-items:baseline;font:14px/1.45 sans-serif}
.ngp-plan-icon{flex:none;width:20px;text-align:center}
.ngp-plan-label{flex:none;color:#8fa6bf;min-width:5.5em}
.ngp-plan-val{flex:1;font-weight:bold}
.ngp-toggle{display:flex;flex-direction:column;gap:5px;text-align:left;padding:8px 10px;border-radius:7px;background:#1a2736;border:2px solid #3d5672;color:#e6eef8;cursor:pointer;font:14px/1.45 sans-serif}
.ngp-toggle:not(:disabled):hover,.ngp-toggle:not(:disabled):focus-visible{border-color:#7fb4ec;outline:none}
.ngp-toggle.on{border-color:#8fd3ff;background:#1d3550}
.ngp-toggle:disabled{color:#6d7d8f;cursor:default;background:#121a24;border-color:#223143}
.ngp-toggle-head{display:flex;align-items:center;gap:8px;font-weight:bold}
.ngp-switch{flex:none;width:34px;height:18px;border-radius:9px;background:#2a3646;position:relative;transition:background .15s}
.ngp-switch::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#9fb2c6;transition:left .15s,background .15s}
.ngp-toggle.on .ngp-switch{background:#3b87b8}
.ngp-toggle.on .ngp-switch::after{left:18px;background:#eaf4ff}
.ngp-log{flex:1 1 120px;min-height:120px;overflow:auto;background:#0b1118;border:1px solid #2a3c52;border-radius:8px;padding:10px 12px;font:14px/1.6 sans-serif}
.ngp-opt{text-align:left;padding:10px 12px;border-radius:8px;font:14px/1.5 sans-serif;color:#e6eef8;background:#192534;border:2px solid #3d5672;cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:background .12s,border-color .12s,transform .12s}
.ngp-opt:not(:disabled):hover,.ngp-opt:not(:disabled):focus-visible{background:#213248;border-color:#7fb4ec;outline:none;transform:translateY(-1px)}
.ngp-opt:disabled{color:#6d7d8f;background:#121a24;border-color:#223143;cursor:default}
.ngp-opt.ngp-locked{opacity:.58;filter:grayscale(.45);border-style:dashed;border-color:#3a4a5e}
.ngp-locked-reason{font:bold 12px sans-serif;color:#f2c14e;background:rgba(242,193,78,.1);border:1px solid rgba(242,193,78,.35);border-radius:5px;padding:3px 7px;display:inline-flex;align-items:center;gap:5px;align-self:flex-start}
.ngp-opt.gated:not(:disabled){border-style:dashed;border-color:#8a6a3a}
.ngp-opt-head{display:flex;align-items:center;gap:8px}
.ngp-key{flex:none;width:28px;height:28px;border-radius:6px;background:#f2c14e;color:#0a121a;font:bold 16px monospace;display:flex;align-items:center;justify-content:center}
.ngp-opt:disabled .ngp-key{background:#2a3646;color:#6d7d8f}
.ngp-opt-label{flex:1;font:bold 16px/1.3 sans-serif}
.ngp-chance{flex:none;font:bold 12px sans-serif;padding:2px 8px;border-radius:999px;white-space:nowrap}
.ngp-req{font:bold 12px sans-serif;padding:2px 8px;border-radius:5px;align-self:flex-start}
.ngp-req.met{color:#9fe7f0;background:rgba(124,226,240,.1);border:1px solid rgba(124,226,240,.35)}
.ngp-req.unmet{color:#ffc27a;background:rgba(255,170,80,.12);border:1px solid rgba(255,170,80,.5)}
.ngp-row{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.ngp-row-label{font:bold 11px sans-serif;color:#8ea3b9;margin-right:2px}
.ngp-chip{font:bold 12px/1.3 sans-serif;padding:2px 7px;border-radius:5px;white-space:nowrap}
.ngp-gain{background:rgba(92,214,125,.16);color:#8ff0a8;border:1px solid rgba(92,214,125,.45)}
.ngp-cost{background:rgba(255,110,110,.14);color:#ff9a9a;border:1px solid rgba(255,110,110,.45)}
.ngp-fail{background:rgba(255,110,110,.06);color:#d99090;border:1px dashed rgba(255,110,110,.4)}
.ngp-warn{font:bold 12px sans-serif;color:#ffd24d;background:rgba(255,200,60,.12);border:1px solid rgba(255,200,60,.5);border-radius:5px;padding:3px 8px}
.ngp-desc{font-size:12px;line-height:1.5;color:#8ea3b9;display:none}
.ngp-opt:not(:disabled):hover .ngp-desc,.ngp-opt:not(:disabled):focus-visible .ngp-desc,.ngp-root.ngp-detail .ngp-desc{display:block}
.ngp-opt:disabled .ngp-chip,.ngp-opt:disabled .ngp-warn{opacity:.4}
.ngp-reason{font:bold 13px sans-serif;color:#c58a5a}
.ngp-footer{flex:none;margin-top:14px;padding-top:12px;border-top:1px solid #263649;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.ngp-help{font-size:13px;color:#8399b0}
.ngp-detail-btn{margin-left:8px;padding:2px 10px;font:12px sans-serif;color:#cfe3f6;background:transparent;border:1px solid #3d5672;border-radius:999px;cursor:pointer}
.ngp-finish{padding:13px 30px;font:bold 18px sans-serif;color:#0a121a;background:#f2c14e;border:none;border-radius:8px;cursor:pointer}
.ngp-finish:hover{background:#ffd36b}
.ngp-actions{display:flex;gap:10px;flex-wrap:wrap}
.ngp-auto{padding:13px 22px;font:bold 18px sans-serif;color:#e6eef8;background:#2a4562;border:2px solid #5d8dbd;border-radius:8px;cursor:pointer}
.ngp-auto:hover{background:#34587d}
.ngp-actions.ngp-coached{position:relative}
.ngp-auto.ngp-coach{animation:ngp-pulse 1.4s ease-in-out infinite;border-color:#8fd3ff}
.ngp-tip{position:absolute;right:0;bottom:calc(100% + 14px);width:min(420px,86vw);background:#1d3550;border:2px solid #8fd3ff;border-radius:10px;padding:14px 16px;font:15px/1.6 sans-serif;color:#eaf4ff;box-shadow:0 10px 30px rgba(0,0,0,.6);animation:ngp-rise .3s ease-out}
.ngp-tip::after{content:'';position:absolute;bottom:-10px;left:60px;border:9px solid transparent;border-top-color:#8fd3ff;border-bottom:0}
.ngp-tip-title{font:bold 16px sans-serif;color:#8fd3ff;margin-bottom:4px}
.ngp-tip b{color:#ffe28a}
.ngp-tip-close{margin-top:8px;padding:4px 12px;font:13px sans-serif;color:#cfe3f6;background:transparent;border:1px solid #5d8dbd;border-radius:6px;cursor:pointer}
@keyframes ngp-pulse{0%,100%{box-shadow:0 0 0 0 rgba(143,211,255,.7)}50%{box-shadow:0 0 0 10px rgba(143,211,255,0)}}
.ngp-pop{position:fixed;inset:0;z-index:16;display:flex;align-items:center;justify-content:center;background:rgba(4,7,12,.7);animation:ngp-fade .18s ease-out}
.ngp-pop-card{width:min(560px,92vw);max-height:90vh;overflow:auto;background:#121b26;border:1px solid #4b6a8e;border-radius:12px;padding:22px 26px;box-shadow:0 18px 50px rgba(0,0,0,.75);animation:ngp-rise .25s ease-out}
.ngp-pop-title{font:bold 24px sans-serif;color:#f4f8fc;margin-bottom:4px}
.ngp-pop-sub{font:14px sans-serif;color:#9fb2c6;margin-bottom:14px}
.ngp-pop-sec{font:bold 13px sans-serif;letter-spacing:.08em;margin:12px 0 6px}
.ngp-pop-item{font:15px/1.5 sans-serif;padding:7px 10px;border-radius:6px;margin-bottom:5px;opacity:0;animation:ngp-in .3s ease-out forwards}
.ngp-pop-good{background:rgba(92,214,125,.13);color:#9af2b2;border-left:3px solid #5cd67d}
.ngp-pop-bad{background:rgba(255,110,110,.12);color:#ffaaaa;border-left:3px solid #ff6e6e}
.ngp-pop-none{font:14px sans-serif;color:#7d8fa3;margin-bottom:5px}
.ngp-pop-go{margin-top:16px;width:100%;padding:14px;font:bold 19px sans-serif;color:#0a121a;background:#f2c14e;border:none;border-radius:8px;cursor:pointer}
.ngp-pop-go:hover{background:#ffd36b}
@keyframes ngp-fade{from{opacity:0}to{opacity:1}}
@keyframes ngp-rise{from{transform:translateY(16px) scale(.97);opacity:0}to{transform:none;opacity:1}}
@keyframes ngp-in{from{transform:translateX(-8px);opacity:0}to{transform:none;opacity:1}}
@media (max-width:900px),(max-height:560px){.ngp-card{overflow:auto}.ngp-body{flex:none;flex-wrap:wrap;overflow:visible}.ngp-options,.ngp-side{max-height:none;overflow:visible}.ngp-log{max-height:40vh}}
@media (max-width:640px){.ngp-card{padding:14px}.ngp-title{font-size:21px}.ngp-grid{grid-template-columns:1fr}.ngp-step{font-size:10px}}
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * 突入前の交渉画面。数字キー 1〜9・0 / クリックで選択、Enter で交渉を終えて突入（開始）。
 * 交渉は電話越しの想定で、ゲーム内の時間は進まない。
 *
 * 画面構成（情報が多いので役割ごとに分ける）:
 * - 上段: 決裂に直結する主ゲージ ＋ 段階（BCSM の階段）
 * - 状況ストリップ: 消耗・人質・残り回数などの小さなチップ（ホバーで説明）
 * - 左: 選択肢を「対話 / 要求 / 圧力」などのまとまりで表示。説明文はホバー / フォーカス時だけ出す
 * - 右: 突入プラン（交渉の結果が突入にどう効くか）と通話ログ
 */
export class NegotiationPhase {
  private readonly root = el('div', 'ngp-root');
  private readonly logEl = el('div', 'ngp-log');
  private readonly topEl = el('div', 'ngp-top');
  private readonly stripEl = el('div', 'ngp-strip');
  private readonly optionsEl = el('div', 'ngp-options');
  private readonly planEl = el('div', 'ngp-plan');
  private readonly finishBtn = el('button', 'ngp-finish');
  private readonly autoBtn = el('button', 'ngp-auto', t('⚡ オート交渉 (A)', '⚡ Auto-Negotiate (A)'));
  private readonly detailBtn = el('button', 'ngp-detail-btn');
  private readonly actionsEl = el('div', 'ngp-actions');
  private popup: HTMLElement | null = null;
  private tip: HTMLElement | null = null;
  private onTipDone: (() => void) | null = null;
  private lastLines: NegotiationLine[] = [];
  private visible = false;
  private disposed = false;
  private detail = false;

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
    if (scenario.plan) side.append(el('div', 'ngp-side-title', scenario.plan.title), this.planEl);
    side.append(el('div', 'ngp-side-title', t('通話ログ', 'CALL LOG')), this.logEl);
    body.append(this.optionsEl, side);

    const footer = el('div', 'ngp-footer');
    const help = el(
      'div',
      'ngp-help',
      t(
        '数字キー / クリックで選択 ・ 緑 = 得るもの　赤 = 失うもの　点線 = 失敗したとき',
        'Number keys / Click to choose · Green = Gain · Red = Cost · Dashed = On Fail',
      ),
    );
    this.detailBtn.type = 'button';
    this.detailBtn.addEventListener('click', this.toggleDetail);
    help.appendChild(this.detailBtn);
    footer.appendChild(help);
    this.finishBtn.type = 'button';
    this.finishBtn.addEventListener('click', this.finish);
    this.autoBtn.type = 'button';
    this.autoBtn.title = t(
      '交渉をおまかせで数手進め、結果だけ見てすぐ突入する',
      'Automatically run a few negotiation turns and jump straight into the breach',
    );
    this.autoBtn.addEventListener('click', this.auto);
    this.actionsEl.append(this.autoBtn, this.finishBtn);
    footer.appendChild(this.actionsEl);

    card.append(
      el('div', 'ngp-badge', t('NEGOTIATION — 突入前交渉', 'NEGOTIATION — PRE-ASSAULT')),
      el('div', 'ngp-title', scenario.title),
      el('div', 'ngp-sub', scenario.subtitle),
      this.topEl,
      this.stripEl,
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
    (this.tip ? this.autoBtn : this.finishBtn).focus();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.style.display = 'none';
    window.removeEventListener('keydown', this.onKey);
  }

  /**
   * 初回向けの吹き出し: 「交渉はオートで OK」とオート交渉ボタンを指し示す。
   * オート交渉・突入・閉じるのいずれかで消え、onDone が 1 回だけ呼ばれる。
   */
  showFirstTimeTip(onDone: () => void): void {
    if (this.disposed || this.tip) return;
    this.onTipDone = onDone;
    const tip = el('div', 'ngp-tip');
    const body = el('div', '');
    body.innerHTML = t(
      '交渉は <b>⚡ オート交渉 (A)</b> におまかせで大丈夫。良さそうな手を自動で選び、結果を見てそのまま突入できます。<br>慣れてきたら、右の <b>突入プラン</b> を見ながら自分で選んでみてください。',
      'You can let <b>⚡ Auto-Negotiate (A)</b> handle this for now. It picks sensible moves automatically and lets you breach right away.<br>Once you are comfortable, choose options yourself while watching the <b>Breach Plan</b> on the right.',
    );
    const close = el('button', 'ngp-tip-close', t('閉じる', 'Close'));
    close.type = 'button';
    close.addEventListener('click', () => this.dismissTip());
    tip.append(el('div', 'ngp-tip-title', t('💡 はじめての方へ', '💡 First-Time Tip')), body, close);
    this.actionsEl.classList.add('ngp-coached');
    this.actionsEl.appendChild(tip);
    this.autoBtn.classList.add('ngp-coach');
    this.tip = tip;
    if (this.visible) this.autoBtn.focus();
  }

  private dismissTip(): void {
    if (!this.tip) return;
    this.tip.remove();
    this.tip = null;
    this.autoBtn.classList.remove('ngp-coach');
    this.actionsEl.classList.remove('ngp-coached');
    const done = this.onTipDone;
    this.onTipDone = null;
    done?.();
  }

  private toggleDetail = (): void => {
    this.detail = !this.detail;
    this.root.classList.toggle('ngp-detail', this.detail);
    this.render();
  };

  private pushLine(l: NegotiationLine): void {
    const line = document.createElement('div');
    line.textContent = l.text;
    line.style.color = TONE_COLOR[l.tone];
    if (l.tone === 'good' || l.tone === 'bad') line.style.fontWeight = 'bold';
    this.logEl.appendChild(line);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private get over(): boolean {
    return this.scenario.isOver() || this.scenario.turnsLeft() <= 0;
  }

  private choose(i: number): void {
    const opt = this.scenario.options[i];
    if (!opt || opt.lockedReason || this.over || opt.disabledReason() !== null) return;
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px dashed #2a3c52;margin:8px 0';
    this.logEl.appendChild(sep);
    this.lastLines = opt.run();
    for (const l of this.lastLines) this.pushLine(l);
    if (this.over) {
      const sep2 = document.createElement('div');
      sep2.style.cssText = 'border-top:1px solid #4a5a70;margin:10px 0 6px';
      this.logEl.appendChild(sep2);
      for (const s of this.scenario.summary()) this.pushLine({ text: s, tone: 'info' });
    }
    this.render();
  }

  private toggle(tg: NegotiationPlanToggle): void {
    if (tg.disabledReason() !== null) return;
    tg.set(!tg.on());
    this.pushLine({
      text: tg.on() ? t(`突入プラン: ${tg.label} を ON`, `Breach plan: ${tg.label} ON`) : t(`突入プラン: ${tg.label} を OFF`, `Breach plan: ${tg.label} OFF`),
      tone: 'info',
    });
    this.render();
  }

  private renderTop(): void {
    this.topEl.textContent = '';
    this.stripEl.textContent = '';
    for (const m of this.scenario.meters()) {
      if (m.compact) {
        const chip = el('span', 'ngp-stat');
        chip.title = m.hint ?? '';
        const v = el('b', '', m.text ?? `${Math.round(m.value)} / ${m.max}`);
        v.style.color = m.color;
        chip.append(el('span', '', m.label), v);
        this.stripEl.appendChild(chip);
        continue;
      }
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
      this.topEl.appendChild(box);
    }
    const ladder = this.scenario.ladder?.();
    if (ladder) {
      const box = el('div', 'ngp-ladder');
      const head = el('div', 'ngp-meter-head');
      const cur = ladder.steps[ladder.index];
      const val = el('span', 'ngp-meter-val', cur?.label ?? '');
      val.style.color = '#7ce2f0';
      head.append(el('span', 'ngp-meter-label', ladder.title), val);
      const steps = el('div', 'ngp-ladder-steps');
      ladder.steps.forEach((s, i) => {
        const st = el('div', `ngp-step${i < ladder.index ? ' done' : i === ladder.index ? ' cur' : ''}`, s.label);
        st.title = s.hint;
        // 階段らしく段ごとに高さを上げる
        st.style.paddingTop = `${4 + i * 4}px`;
        if (i === ladder.index + 1) {
          const f = el('div', 'ngp-step-fill');
          f.style.width = `${Math.round(ladder.progress * 100)}%`;
          st.appendChild(f);
        }
        steps.appendChild(st);
      });
      box.append(head, steps, el('div', 'ngp-ladder-note', ladder.note));
      this.topEl.appendChild(box);
    }
    // 残り回数はピップで
    const turns = this.scenario.turnsLeft();
    const max = this.scenario.maxTurns;
    const chip = el('span', 'ngp-stat');
    chip.title = t('1 回選ぶごとに 1 減る（突入プランの切替は回数を使わない）', 'Each action uses one turn (breach-plan toggles are free)');
    const pips = el('span', 'ngp-pips');
    for (let i = 0; i < max; i++) pips.appendChild(el('span', `ngp-pip${i < turns ? '' : ' used'}`));
    chip.append(el('span', '', t('残り交渉回数', 'Turns')), pips, el('b', '', `${turns}/${max}`));
    this.stripEl.appendChild(chip);
  }

  private renderPlan(): void {
    const plan = this.scenario.plan;
    if (!plan) return;
    this.planEl.textContent = '';
    for (const it of plan.items()) {
      const row = el('div', 'ngp-plan-item');
      const v = el('span', 'ngp-plan-val', it.value);
      v.style.color = PLAN_TONE[it.tone];
      row.append(el('span', 'ngp-plan-icon', it.icon), el('span', 'ngp-plan-label', it.label), v);
      this.planEl.appendChild(row);
    }
    for (const tg of plan.toggles ?? []) {
      const reason = tg.disabledReason();
      const btn = el('button', `ngp-toggle${tg.on() && reason === null ? ' on' : ''}`);
      btn.type = 'button';
      btn.disabled = reason !== null;
      const head = el('div', 'ngp-toggle-head');
      head.append(el('span', 'ngp-switch'), el('span', '', `${tg.label} (${tg.key})`));
      btn.appendChild(head);
      if (reason !== null) {
        btn.appendChild(el('div', 'ngp-reason', `× ${reason}`));
      } else {
        const fx = tg.effects();
        const row = el('div', 'ngp-row');
        this.chips(row, fx.gain, 'ngp-gain', '▲ ');
        this.chips(row, fx.cost, 'ngp-cost', '▼ ');
        btn.appendChild(row);
      }
      btn.addEventListener('click', () => this.toggle(tg));
      this.planEl.appendChild(btn);
    }
  }

  private chips(row: HTMLElement, items: string[] | undefined, cls: string, prefix: string): void {
    for (const item of items ?? []) row.appendChild(el('span', `ngp-chip ${cls}`, `${prefix}${item}`));
  }

  private renderOption(opt: NegotiationOption, i: number): HTMLButtonElement {
    const locked = Boolean(opt.lockedReason);
    const reason = locked ? null : this.over ? t('交渉は終了した', 'Negotiation ended') : opt.disabledReason();
    const req = opt.requires?.() ?? null;
    const btn = el('button', `ngp-opt${locked ? ' ngp-locked' : req && !req.met ? ' gated' : ''}`);
    btn.type = 'button';
    btn.disabled = locked || reason !== null;

    const head = el('div', 'ngp-opt-head');
    head.append(
      el('span', 'ngp-key', locked ? '🔒' : keyLabel(i)),
      el('span', 'ngp-opt-label', `${opt.icon ? opt.icon + ' ' : ''}${opt.label}`),
    );
    if (locked) {
      head.appendChild(el('span', 'ngp-locked-reason', opt.lockedReason!));
      btn.appendChild(head);
      btn.title = opt.lockedReason ?? '';
      return btn;
    }
    const chance = opt.chance?.() ?? null;
    const pill = el(
      'span',
      'ngp-chance',
      chance === null
        ? t('確実', 'Guaranteed')
        : t(`成功率 ${Math.round(chance * 100)}%`, `${Math.round(chance * 100)}% Chance`),
    );
    const c = chance ?? 1;
    const pc = c >= 0.65 ? '#5cd67d' : c >= 0.4 ? '#f2c14e' : '#ff6b6b';
    pill.style.cssText = `color:${pc};background:${pc}22;border:1px solid ${pc}88`;
    head.appendChild(pill);
    btn.appendChild(head);
    if (req && !locked && reason === null) {
      btn.appendChild(
        el('span', `ngp-req ${req.met ? 'met' : 'unmet'}`, req.met ? `✓ ${req.label}` : `⚠ ${req.label}${req.note ? ' — ' + req.note : ''}`),
      );
    }

    const fx = opt.effects?.() ?? {};
    if ((fx.gain?.length ?? 0) + (fx.cost?.length ?? 0) > 0) {
      const row = el('div', 'ngp-row');
      if (chance !== null) row.appendChild(el('span', 'ngp-row-label', t('成功時', 'On Success')));
      this.chips(row, fx.gain, 'ngp-gain', '▲ ');
      this.chips(row, fx.cost, 'ngp-cost', '▼ ');
      btn.appendChild(row);
    }
    if (fx.fail?.length) {
      const row = el('div', 'ngp-row');
      row.appendChild(el('span', 'ngp-row-label', t('失敗時', 'On Fail')));
      this.chips(row, fx.fail, 'ngp-fail', '');
      btn.appendChild(row);
    }
    if (fx.warn && !locked && reason === null) btn.appendChild(el('div', 'ngp-warn', `⚠ ${fx.warn}`));
    if (locked) {
      btn.appendChild(el('div', 'ngp-locked-reason', `🔒 ${opt.lockedReason}`));
    } else {
      btn.appendChild(reason === null ? el('div', 'ngp-desc', opt.desc) : el('div', 'ngp-reason', `× ${reason}`));
    }
    btn.title = opt.desc;
    btn.addEventListener('click', () => this.choose(i));
    return btn;
  }

  private render(): void {
    this.renderTop();
    this.renderPlan();
    this.optionsEl.textContent = '';
    const groups = this.scenario.groups ?? [];
    const opts = this.scenario.options;
    const placed = new Set<number>();
    const section = (g: NegotiationGroup | null, idx: number[]): void => {
      if (idx.length === 0) return;
      if (g) {
        const head = el('div', 'ngp-group-head');
        head.appendChild(el('span', 'ngp-group-label', g.label));
        if (g.hint) head.appendChild(el('span', 'ngp-group-hint', g.hint));
        this.optionsEl.appendChild(head);
      }
      const grid = el('div', 'ngp-grid');
      for (const i of idx) {
        grid.appendChild(this.renderOption(opts[i]!, i));
        placed.add(i);
      }
      this.optionsEl.appendChild(grid);
    };
    for (const g of groups) section(g, opts.flatMap((o, i) => (o.group === g.id ? [i] : [])));
    section(null, opts.flatMap((_, i) => (placed.has(i) ? [] : [i])));
    this.detailBtn.textContent = this.detail ? t('説明を隠す', 'Hide details') : t('説明を常に表示', 'Always show details');
    this.finishBtn.textContent = `${this.scenario.finishLabel} (Enter)`;
  }

  /**
   * オート交渉: 決裂の危険がない選択肢から成功率重視でランダムに数手選び、
   * 得たもの / 失ったものをポップアップで見せてそのまま突入できるようにする。
   */
  private auto = (): void => {
    if (this.disposed || !this.visible || this.popup) return;
    this.dismissTip();
    const good: string[] = [];
    const bad: string[] = [];
    const rounds = Math.min(AUTO_ROUNDS, this.scenario.turnsLeft());
    const used = new Set<number>();
    for (let r = 0; r < rounds; r++) {
      if (this.over) break;
      const pick = this.pickAuto(used);
      if (pick < 0) break;
      const opt = this.scenario.options[pick]!;
      // 実行前の効果見込み（実行後は状況が変わるので先に取る）
      const fx = opt.effects?.() ?? {};
      const chance = opt.chance?.() ?? null;
      const before = this.logEl.childElementCount;
      this.choose(pick);
      if (this.logEl.childElementCount === before) break;
      used.add(pick);
      const name = `${opt.icon ? opt.icon + ' ' : ''}${opt.label}`;
      const lines = this.lastLines;
      const failed = chance !== null && lines.some((l) => l.tone === 'bad') && !lines.some((l) => l.tone === 'good');
      const colon = t('：', ': ');
      if (failed) {
        bad.push(
          t(
            `${name} — 失敗${fx.fail?.length ? '：' + fx.fail.join(' / ') : ''}`,
            `${name} — Failed${fx.fail?.length ? ': ' + fx.fail.join(' / ') : ''}`,
          ),
        );
      } else {
        if (fx.gain?.length) good.push(`${name}${colon}${fx.gain.join(' / ')}`);
        if (fx.cost?.length) bad.push(`${name}${colon}${fx.cost.join(' / ')}`);
      }
      // 決裂など、見込みに無い重大な結果は原文で
      for (const l of lines) if (l.critical) bad.push(l.text);
    }
    this.showPopup(good, bad);
  };

  private pickAuto(used: ReadonlySet<number>): number {
    const all: { i: number; w: number; c: number }[] = [];
    this.scenario.options.forEach((opt, i) => {
      if (opt.lockedReason || opt.disabledReason() !== null) return;
      const fx = opt.effects?.() ?? {};
      if (fx.warn) return; // 決裂リスクのある手は避ける
      const c = opt.chance?.() ?? 1;
      // 成功しやすく得るものが多い手ほど選ばれやすい。同じ手の連打は避ける
      const w = c * c * (1 + 0.25 * (fx.gain?.length ?? 0)) * (used.has(i) ? 0.3 : 1);
      all.push({ i, w, c });
    });
    // 分の悪い賭け（成功率 35% 未満）は他に手が無いときだけ
    const sane = all.filter((x) => x.c >= 0.35);
    const cands = sane.length > 0 ? sane : all;
    if (cands.length === 0) return -1;
    let r = Math.random() * cands.reduce((a, b) => a + b.w, 0);
    for (const c of cands) {
      r -= c.w;
      if (r <= 0) return c.i;
    }
    return cands[cands.length - 1]!.i;
  }

  private showPopup(good: string[], bad: string[]): void {
    const pop = el('div', 'ngp-pop');
    const card = el('div', 'ngp-pop-card');
    card.append(
      el('div', 'ngp-pop-title', t('📞 交渉結果', '📞 Negotiation Results')),
      el('div', 'ngp-pop-sub', t('おまかせで交渉を進めた。', 'Auto-negotiation completed.')),
    );
    let delay = 0;
    const section = (title: string, color: string, items: string[], cls: string, none: string): void => {
      const h = el('div', 'ngp-pop-sec', title);
      h.style.color = color;
      card.appendChild(h);
      if (items.length === 0) card.appendChild(el('div', 'ngp-pop-none', none));
      for (const item of items) {
        const it = el('div', `ngp-pop-item ${cls}`, item);
        it.style.animationDelay = `${(delay += 0.12)}s`;
        card.appendChild(it);
      }
    };
    section(t('▲ 得たもの', '▲ Gained'), '#8ff0a8', good, 'ngp-pop-good', t('特になし', 'None'));
    section(t('▼ デメリット', '▼ Drawbacks'), '#ff9a9a', bad, 'ngp-pop-bad', t('特になし', 'None'));
    const plan = this.scenario.plan;
    if (plan) {
      const items = plan.items().map((it) => `${it.icon} ${it.label}: ${it.value}`);
      section(`📋 ${plan.title}`, '#8fd3ff', items, 'ngp-pop-good', t('特になし', 'None'));
    }
    const go = el('button', 'ngp-pop-go', `${this.scenario.finishLabel} (Enter)`);
    go.type = 'button';
    go.addEventListener('click', this.finish);
    card.appendChild(go);
    pop.appendChild(card);
    this.root.appendChild(pop);
    this.popup = pop;
    go.focus();
  }

  private finish = (): void => {
    if (this.disposed || !this.visible) return;
    this.popup?.remove();
    this.popup = null;
    this.dismissTip();
    this.hide();
    this.onFinish();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (this.disposed || !this.visible || e.repeat) return;
    if (e.code === 'KeyA' && !this.popup) {
      e.preventDefault();
      this.auto();
    } else if (/^(Digit|Numpad)[0-9]$/.test(e.code) && !this.popup) {
      e.preventDefault();
      const n = Number(e.code.slice(-1));
      this.choose(n === 0 ? 9 : n - 1);
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      this.finish();
    } else if (!this.popup) {
      const tg = this.scenario.plan?.toggles?.find((x) => x.code === e.code);
      if (tg) {
        e.preventDefault();
        this.toggle(tg);
      }
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
    this.finishBtn.removeEventListener('click', this.finish);
    this.autoBtn.removeEventListener('click', this.auto);
    this.detailBtn.removeEventListener('click', this.toggleDetail);
    this.root.remove();
  }
}
