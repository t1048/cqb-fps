import type { BriefingRange, MapData, StageEntry } from '../core/types';
import type { GameMode } from '../modes/SuspectMode';
import { collectFloorLevels, drawFloorPlan, floorLabelAt, resolveActiveFloor } from './Minimap';

const PLAN_WIDTH = 560;
const PLAN_HEIGHT = 420;

const STYLE_ID = 'briefing-screen-style';
const CSS = `
.bfs-card{width:100%;max-width:1280px;max-height:96vh;overflow:auto;background:#111822;border:1px solid #3a5170;border-radius:10px;padding:24px 30px;box-shadow:0 14px 40px rgba(0,0,0,.7);box-sizing:border-box}
.bfs-setup{display:grid;grid-template-columns:minmax(260px,2fr) minmax(320px,3fr);gap:18px;padding-bottom:18px;margin-bottom:18px;border-bottom:1px solid #263649}
.bfs-step{display:flex;flex-direction:column;gap:8px}
.bfs-step-title{font:bold 15px sans-serif;color:#b8cbe0;letter-spacing:.04em}
.bfs-step-title b{display:inline-flex;width:22px;height:22px;align-items:center;justify-content:center;margin-right:6px;border-radius:50%;background:#f2c14e;color:#0a121a;font-size:13px}
.bfs-choices{display:grid;gap:8px}
.bfs-choice{text-align:left;padding:12px 14px;border-radius:8px;background:#192534;border:2px solid #34495f;color:#dce6f2;cursor:pointer;font:15px/1.4 sans-serif;display:flex;flex-direction:column;gap:4px;transition:background .12s,border-color .12s}
.bfs-choice:not(.active):hover,.bfs-choice:not(.active):focus-visible{background:#213248;border-color:#7fb4ec;outline:none}
.bfs-choice.active{cursor:default;color:#f4f8fc}
.bfs-choice-name{font:bold 18px sans-serif;display:flex;align-items:center;gap:8px}
.bfs-choice-desc{font-size:13px;color:#9fb2c6}
.bfs-choice.active .bfs-choice-desc{color:#c9d8e8}
.bfs-check{margin-left:auto;white-space:nowrap;font:bold 12px sans-serif;padding:2px 8px;border-radius:999px}
.bfs-size{font:bold 34px/1 sans-serif;margin-bottom:2px}
.bfs-reroll{padding:10px 16px;font:bold 15px sans-serif;color:#e6eef8;background:#1d2b3c;border:2px solid #4a6787;border-radius:8px;cursor:pointer}
.bfs-reroll:hover{background:#26384e;border-color:#7fb4ec}
.bfs-seed{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font:13px sans-serif;color:#8399b0}
.bfs-seed input{width:110px;padding:6px 8px;font:13px monospace;color:#e6eef8;background:#0b1118;border:1px solid #354a63;border-radius:5px}
.bfs-seed button{padding:6px 10px;font:13px sans-serif;color:#d6e4f0;background:#192534;border:1px solid #354a63;border-radius:5px;cursor:pointer}
.bfs-start{padding:15px 36px;font:bold 19px sans-serif;color:#0a121a;border:none;border-radius:8px;cursor:pointer;letter-spacing:.04em}
@media (max-width:760px){.bfs-setup{grid-template-columns:1fr}.bfs-card{padding:16px}.bfs-check{font-size:0;padding:2px 6px}.bfs-check::first-letter{font-size:12px}}
`;

export interface BriefingScreenOptions {
  /** 突入開始ボタン / Enter 押下時のコールバック */
  onStart: () => void;
  /** T4-4 等のステージ選択 UI を差し込むための任意要素 */
  stageSelector?: HTMLElement;
  /** ステージ一覧（指定時は stageSlot にステージ選択ボタンを描画） */
  stages?: readonly StageEntry[];
  /** 現在選択中のステージ ID */
  currentStageId?: string;
  /** 別ステージ選択時のコールバック */
  onSelectStage?: (stageId: string) => void;
  /** ランダム生成ステージの再生成（seed 省略 = 新しいランダムシード）。map.seed がある場合のみ UI を表示 */
  onRegenerate?: (seed?: number) => void;
  /** 現在のゲームモード */
  mode?: GameMode;
  /** モード切替（指定時はモード選択ボタンを表示） */
  onSelectMode?: (mode: GameMode) => void;
}

function formatRange(range: BriefingRange | undefined): string {
  if (!range) return '不明';
  return range.min === range.max ? `${range.min}名` : `${range.min}〜${range.max}名`;
}

/**
 * 突入前ブリーフィング画面。
 * マップの 2D 間取り図・推定容疑者数・推定人質数・状況概要・基本操作を表示し、
 * 「突入開始 (Enter)」でミッションを開始する。
 * stageSlot を公開しており、後続タスク(T4-4)でステージ選択 UI を無改造で差し込み可能。
 */
export class BriefingScreen {
  private readonly root = document.createElement('div');
  private readonly startBtn = document.createElement('button');
  /** T4-4 ステージ選択 UI 用の差し込みコンテナ */
  readonly stageSlot = document.createElement('div');
  /** ランダム生成ステージのシード表示・再生成 UI */
  private readonly seedRow = document.createElement('div');
  private readonly stageBtnCleanups: (() => void)[] = [];
  private visible = false;
  private disposed = false;
  private readonly onStart: () => void;

  constructor(parent: HTMLElement, map: MapData, options: BriefingScreenOptions) {
    this.onStart = options.onStart;
    const suspectMode = options.mode === 'suspect';

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.root.style.cssText =
      'position:fixed;inset:0;z-index:15;pointer-events:auto;background:rgba(6,10,16,0.92);color:#e6eef8;font:15px/1.55 sans-serif;display:none;align-items:center;justify-content:center;padding:2vh 2vw;box-sizing:border-box';

    const card = document.createElement('div');
    card.className = 'bfs-card';

    // 上段: ミッション設定（① モード ② マップの広さ）
    const setup = document.createElement('div');
    setup.className = 'bfs-setup';
    if (options.onSelectMode) setup.appendChild(this.buildModeStep(options.mode ?? 'swat', options.onSelectMode));

    this.stageSlot.className = 'bfs-step';
    if (options.stages && options.stages.length > 0 && options.onSelectStage) {
      this.renderStageButtons(options.stages, options.currentStageId ?? map.id, options.onSelectStage, options.onSelectMode ? 2 : 1);
      if (map.seed !== undefined && options.onRegenerate) this.stageSlot.appendChild(this.buildSeedRow(map.seed, options.onRegenerate));
    }
    if (options.stageSelector) this.stageSlot.appendChild(options.stageSelector);
    setup.appendChild(this.stageSlot);

    // ブリーフィング見出し
    const header = document.createElement('div');
    header.style.cssText = 'margin-bottom:14px';
    const badge = document.createElement('div');
    badge.textContent = suspectMode ? 'SUSPECT MODE — 籠城' : 'MISSION BRIEFING';
    badge.style.cssText = `font:bold 13px monospace;letter-spacing:0.14em;color:${suspectMode ? '#ff7b7b' : '#56c8d8'};margin-bottom:2px`;
    const title = document.createElement('div');
    title.textContent = map.name;
    title.style.cssText = 'font:bold 26px sans-serif;color:#f4f8fc';
    header.append(badge, title);

    // 2 カラム本体（左: 間取り図、右: インテル＆操作ガイド）
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start';

    // 左カラム: 間取り図
    const mapCol = document.createElement('div');
    mapCol.style.cssText = 'flex:3 1 480px;min-width:300px';

    const mapHeader = document.createElement('div');
    mapHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px';
    const mapLabel = document.createElement('div');
    mapLabel.textContent = '建物間取り図（侵入前情報）';
    mapLabel.style.cssText = 'font:bold 14px sans-serif;color:#9cb4cc;letter-spacing:0.04em';
    mapHeader.appendChild(mapLabel);

    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText =
      'background:#0b1118;border:1px solid #2a3c52;border-radius:6px;padding:8px;display:flex;justify-content:center';
    const canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(PLAN_WIDTH * dpr);
    canvas.height = Math.round(PLAN_HEIGHT * dpr);
    canvas.style.cssText = `display:block;width:100%;max-width:${PLAN_WIDTH}px;height:auto;aspect-ratio:${PLAN_WIDTH}/${PLAN_HEIGHT}`;
    const ctx = canvas.getContext('2d');
    // 昇順（B1 / 1F / 2F）。初期選択は 1F（y=0 に最も近い階）。タブとミニマップは同じ階層・表示名を使う
    const floorLevels = collectFloorLevels(map);
    let selectedFloor = floorLevels.length > 1 ? resolveActiveFloor(0, floorLevels).floorY : undefined;
    const renderPlan = (): void => {
      if (!ctx) return;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFloorPlan(ctx, map, {
        width: PLAN_WIDTH,
        height: PLAN_HEIGHT,
        padding: 24,
        showRoomLabels: true,
        showSpawn: selectedFloor === undefined || Math.abs(selectedFloor - map.playerSpawn.y) < 1.5,
        compact: false,
        floorY: selectedFloor,
      });
      ctx.restore();
    };
    renderPlan();
    if (floorLevels.length > 1) {
      const tabs = document.createElement('div');
      tabs.style.cssText = 'display:flex;gap:4px';
      const tabBtns: HTMLButtonElement[] = [];
      const updateTabStyles = (): void => {
        tabBtns.forEach((b, idx) => {
          const active = floorLevels[idx] === selectedFloor;
          b.style.cssText = active
            ? 'padding:5px 14px;font:bold 14px monospace;color:#0a121a;background:#56c8d8;border:1px solid #56c8d8;border-radius:5px;cursor:default'
            : 'padding:5px 14px;font:14px monospace;color:#cfe0f0;background:#192534;border:1px solid #354a63;border-radius:5px;cursor:pointer';
        });
      };
      floorLevels.forEach((fy, idx) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = floorLabelAt(idx, floorLevels);
        const onClick = (): void => {
          if (this.disposed || selectedFloor === fy) return;
          selectedFloor = fy;
          updateTabStyles();
          renderPlan();
        };
        b.addEventListener('click', onClick);
        this.stageBtnCleanups.push(() => b.removeEventListener('click', onClick));
        tabBtns.push(b);
        tabs.appendChild(b);
      });
      updateTabStyles();
      mapHeader.appendChild(tabs);
    }
    canvasWrap.appendChild(canvas);

    // 凡例
    const legend = document.createElement('div');
    legend.style.cssText =
      'display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font:13px sans-serif;color:#9fb4c8';
    const legendItems: [string, string][] = [
      ['#56c8d8', suspectMode ? 'あなたの潜伏位置' : '突入地点'],
      ['#d89b3c', suspectMode ? 'ドア（F 長押しで施錠）' : 'ドア'],
      ['#e05252', suspectMode ? '施錠ドア（SWAT はブリーチが必要）' : '施錠ドア（G/指示でブリーチ）'],
      ['#967656', '遮蔽物'],
    ];
    for (const [color, text] of legendItems) {
      const item = document.createElement('span');
      item.style.cssText = 'display:inline-flex;align-items:center;gap:5px';
      const dot = document.createElement('span');
      dot.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:2px;background:${color}`;
      const lbl = document.createElement('span');
      lbl.textContent = text;
      item.append(dot, lbl);
      legend.appendChild(item);
    }
    mapCol.append(mapHeader, canvasWrap, legend);

    // 右カラム: インテル＆操作
    const intelCol = document.createElement('div');
    intelCol.style.cssText = 'flex:2 1 320px;min-width:260px;display:flex;flex-direction:column;gap:14px';

    // 推定人数
    const countsGrid = document.createElement('div');
    countsGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px';
    countsGrid.append(
      this.makeStatBox(suspectMode ? '突入 SWAT' : '推定容疑者', formatRange(map.briefing?.estimatedSuspects), '#ff7b7b'),
      this.makeStatBox(suspectMode ? '人質・民間人' : '推定人質・民間人', formatRange(map.briefing?.estimatedHostages), '#ffd24d'),
    );
    intelCol.appendChild(countsGrid);

    // 状況概要
    if (map.briefing?.summary) {
      const sumBox = document.createElement('div');
      sumBox.style.cssText =
        'background:#16202c;border:1px solid #293b50;border-radius:6px;padding:12px 14px';
      const sumTitle = document.createElement('div');
      sumTitle.textContent = '状況概要';
      sumTitle.style.cssText = 'font:bold 14px sans-serif;color:#9cb4cc;margin-bottom:6px';
      const sumText = document.createElement('div');
      sumText.textContent = map.briefing.summary;
      sumText.style.cssText = 'font:15px/1.65 sans-serif;color:#dce6f2';
      sumBox.append(sumTitle, sumText);
      intelCol.appendChild(sumBox);
    }

    // 操作ガイド
    const ctrlBox = document.createElement('div');
    ctrlBox.style.cssText =
      'background:#16202c;border:1px solid #293b50;border-radius:6px;padding:12px 14px';
    const ctrlTitle = document.createElement('div');
    ctrlTitle.textContent = '基本操作';
    ctrlTitle.style.cssText = 'font:bold 14px sans-serif;color:#9cb4cc;margin-bottom:6px';
    const ctrlList = document.createElement('div');
    ctrlList.style.cssText =
      'display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:14px/1.5 sans-serif;color:#c7d6e6';
    const controls: [string, string][] = suspectMode
      ? [
          ['WASD / Shift / C', '移動 / 静音（足音小） / しゃがみ（発見されにくい）'],
          ['Q / E', '左右リーン'],
          ['左クリック / R', '射撃（改造フルオート拳銃） / リロード（予備弾は有限）'],
          ['F / F 長押し', 'ドア開閉 / 閉じたドアを施錠・解錠'],
          ['民間人に F 長押し', '人質を拘束して連れ回す（もう一度 F で解放）'],
          ['ホイール', 'ドア段階開閉'],
          ['Space / Space 長押し', '準備完了（即突入） / 投降'],
          ['M', 'ミニマップ表示切替'],
        ]
      : [
      ['WASD / Shift / C', '移動 / 静音 / しゃがみ（Ctrl は不使用）'],
      ['Q / E', '左右リーン'],
      ['左 / 右クリック', '射撃（高精度） / 部隊指揮メニュー（保持）'],
      ['Z / X / T', 'クイック指示 / 隊員集合 / 指揮対象切替'],
      ['Tab', '部隊指揮メニュー（予備キー）'],
      ['Space', '警告コール（投降勧告）'],
      ['F / ホイール / G', '開閉・拘束 / 段階開閉 / ブリーチ'],
      ['1 / 2 / 4', '主武器 / 非致死 / フラッシュ'],
      ['M', 'ミニマップ表示切替'],
        ];
    for (const [k, desc] of controls) {
      const kEl = document.createElement('span');
      kEl.textContent = k;
      kEl.style.cssText = 'font-family:monospace;color:#7ce2f0;white-space:nowrap';
      const dEl = document.createElement('span');
      dEl.textContent = desc;
      ctrlList.append(kEl, dEl);
    }
    ctrlBox.append(ctrlTitle, ctrlList);
    intelCol.appendChild(ctrlBox);

    body.append(mapCol, intelCol);

    // フッター（突入開始ボタン）
    const footer = document.createElement('div');
    footer.style.cssText = 'margin-top:20px;padding-top:14px;border-top:1px solid #263649;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap';
    const footHelp = document.createElement('div');
    footHelp.textContent = 'モードとマップの広さを選んだら、交渉フェーズへ進む';
    footHelp.style.cssText = 'font-size:14px;color:#8399b0';
    this.startBtn.type = 'button';
    this.startBtn.className = 'bfs-start';
    this.startBtn.textContent = '交渉フェーズへ (Enter)';
    this.startBtn.style.background = suspectMode ? '#ff7b7b' : '#56c8d8';
    footer.appendChild(footHelp);
    this.startBtn.addEventListener('click', this.handleStart);
    footer.appendChild(this.startBtn);

    card.append(setup, header, body, footer);
    this.root.appendChild(card);
    parent.appendChild(this.root);
  }

  private stepTitle(num: number, text: string): HTMLElement {
    const t = document.createElement('div');
    t.className = 'bfs-step-title';
    const b = document.createElement('b');
    b.textContent = String(num);
    t.append(b, document.createTextNode(text));
    return t;
  }

  /** 選択カード（選択中はハイライトして押せない） */
  private choiceButton(active: boolean, color: string, build: (btn: HTMLButtonElement) => void, onSelect: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = active ? 'bfs-choice active' : 'bfs-choice';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (active) {
      btn.style.borderColor = color;
      btn.style.background = `${color}22`;
      btn.style.boxShadow = `0 0 0 1px ${color}55 inset`;
    }
    build(btn);
    if (!active) {
      const onClick = (): void => {
        if (this.disposed || !this.visible) return;
        onSelect();
      };
      btn.addEventListener('click', onClick);
      this.stageBtnCleanups.push(() => btn.removeEventListener('click', onClick));
    }
    return btn;
  }

  private checkBadge(color: string): HTMLElement {
    const c = document.createElement('span');
    c.className = 'bfs-check';
    c.textContent = '✓ 選択中';
    c.style.cssText = `color:#0a121a;background:${color}`;
    return c;
  }

  private renderStageButtons(
    stages: readonly StageEntry[],
    currentStageId: string,
    onSelectStage: (stageId: string) => void,
    stepNum: number,
  ): void {
    this.stageSlot.appendChild(this.stepTitle(stepNum, 'マップの広さ（間取りは毎回ランダム）'));
    const grid = document.createElement('div');
    grid.className = 'bfs-choices';
    grid.style.gridTemplateColumns = `repeat(${Math.min(stages.length, 3)}, minmax(0, 1fr))`;
    const color = '#f2c14e';
    for (const stage of stages) {
      const active = stage.id === currentStageId;
      const btn = this.choiceButton(
        active,
        color,
        (b) => {
          b.dataset.stageId = stage.id;
          b.title = stage.description ?? stage.name;
          const head = document.createElement('div');
          head.className = 'bfs-choice-name';
          if (stage.size) {
            const sz = document.createElement('span');
            sz.className = 'bfs-size';
            sz.textContent = stage.size;
            sz.style.color = active ? color : '#cfe0f0';
            head.appendChild(sz);
          } else {
            head.appendChild(document.createTextNode(stage.name));
          }
          if (active) head.appendChild(this.checkBadge(color));
          b.appendChild(head);
          const desc = document.createElement('div');
          desc.className = 'bfs-choice-desc';
          desc.textContent = stage.tagline ?? stage.description ?? '';
          b.appendChild(desc);
        },
        () => onSelectStage(stage.id),
      );
      grid.appendChild(btn);
    }
    this.stageSlot.appendChild(grid);
  }

  private buildModeStep(mode: GameMode, onSelectMode: (mode: GameMode) => void): HTMLElement {
    const step = document.createElement('div');
    step.className = 'bfs-step';
    step.appendChild(this.stepTitle(1, 'モード'));
    const grid = document.createElement('div');
    grid.className = 'bfs-choices';
    const items: [GameMode, string, string, string][] = [
      ['swat', '🛡 SWAT（突入側）', '隊長として部隊を指揮。人質を救出し容疑者を制圧する', '#56c8d8'],
      ['suspect', '🔒 容疑者（籠城側）', '立てこもり犯として突入してくる SWAT をしのぐ', '#ff7b7b'],
    ];
    for (const [m, name, descText, color] of items) {
      const active = m === mode;
      grid.appendChild(
        this.choiceButton(
          active,
          color,
          (b) => {
            b.dataset.mode = m;
            const head = document.createElement('div');
            head.className = 'bfs-choice-name';
            head.textContent = name;
            if (active) head.appendChild(this.checkBadge(color));
            const desc = document.createElement('div');
            desc.className = 'bfs-choice-desc';
            desc.textContent = descText;
            b.append(head, desc);
          },
          () => onSelectMode(m),
        ),
      );
    }
    step.appendChild(grid);
    return step;
  }

  private buildSeedRow(seed: number, onRegenerate: (seed?: number) => void): HTMLElement {
    const row = this.seedRow;
    row.className = 'bfs-seed';
    const reroll = document.createElement('button');
    reroll.type = 'button';
    reroll.className = 'bfs-reroll';
    reroll.textContent = '🎲 同じ広さで別の間取りにする';
    const label = document.createElement('span');
    label.textContent = `SEED ${seed}`;
    label.style.cssText = 'font-family:monospace;color:#7ce2f0;margin-left:auto';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.placeholder = 'シード指定';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = '適用';

    const onReroll = (): void => {
      if (this.disposed || !this.visible) return;
      onRegenerate();
    };
    const onApply = (): void => {
      if (this.disposed || !this.visible) return;
      const v = input.value.trim();
      if (!/^\d{1,10}$/.test(v)) {
        input.style.borderColor = '#e05252';
        return;
      }
      onRegenerate(Number(v));
    };
    const onInputKey = (e: KeyboardEvent): void => {
      if (e.code === 'Enter') {
        e.preventDefault();
        onApply();
      }
    };
    reroll.addEventListener('click', onReroll);
    apply.addEventListener('click', onApply);
    input.addEventListener('keydown', onInputKey);
    this.stageBtnCleanups.push(() => {
      reroll.removeEventListener('click', onReroll);
      apply.removeEventListener('click', onApply);
      input.removeEventListener('keydown', onInputKey);
    });
    row.append(reroll, label, input, apply);
    return row;
  }

  private makeStatBox(label: string, value: string, valueColor: string): HTMLElement {
    const box = document.createElement('div');
    box.style.cssText =
      'background:#16202c;border:1px solid #293b50;border-radius:6px;padding:10px 12px';
    const lbl = document.createElement('div');
    lbl.textContent = label;
    lbl.style.cssText = 'font:13px sans-serif;color:#9cb4cc;margin-bottom:4px';
    const val = document.createElement('div');
    val.textContent = value;
    val.style.cssText = `font:bold 24px sans-serif;color:${valueColor}`;
    box.append(lbl, val);
    return box;
  }

  show(): void {
    if (this.disposed || this.visible) return;
    this.visible = true;
    this.root.style.display = 'flex';
    window.addEventListener('keydown', this.onKeyDown);
    this.startBtn.focus();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.style.display = 'none';
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private handleStart = (): void => {
    if (this.disposed || !this.visible) return;
    this.onStart();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || !this.visible || e.repeat) return;
    if (e.code === 'Enter') {
      if (e.target instanceof Node && (this.stageSlot.contains(e.target) || this.seedRow.contains(e.target))) return;
      e.preventDefault();
      this.handleStart();
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
    for (const cleanup of this.stageBtnCleanups) cleanup();
    this.stageBtnCleanups.length = 0;
    this.startBtn.removeEventListener('click', this.handleStart);
    this.root.remove();
  }
}
