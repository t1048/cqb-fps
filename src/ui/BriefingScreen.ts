import type { BriefingRange, MapData, StageEntry } from '../core/types';
import type { GameMode } from '../modes/SuspectMode';
import { collectFloorLevels, drawFloorPlan, floorLabelAt, resolveActiveFloor } from './Minimap';

const PLAN_WIDTH = 440;
const PLAN_HEIGHT = 340;

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

    this.root.style.cssText =
      'position:fixed;inset:0;z-index:15;pointer-events:auto;background:rgba(8,12,18,0.9);color:#e6eef8;font:14px/1.5 sans-serif;display:none;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';

    const card = document.createElement('div');
    card.style.cssText =
      'width:100%;max-width:880px;max-height:92vh;overflow:auto;background:#111822;border:1px solid #354a63;border-radius:8px;padding:22px 26px;box-shadow:0 12px 36px rgba(0,0,0,0.65);box-sizing:border-box';

    // ヘッダー
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid #263649;padding-bottom:14px;margin-bottom:18px';

    const titleWrap = document.createElement('div');
    const badge = document.createElement('div');
    badge.textContent = suspectMode ? 'SUSPECT MODE — 籠城' : 'MISSION BRIEFING';
    badge.style.cssText = `font:bold 11px monospace;letter-spacing:0.14em;color:${suspectMode ? '#ff7b7b' : '#56c8d8'};margin-bottom:4px`;
    const title = document.createElement('div');
    title.textContent = map.name;
    title.style.cssText = 'font:bold 24px sans-serif;color:#f4f8fc';
    titleWrap.append(badge, title);
    if (options.onSelectMode) titleWrap.appendChild(this.buildModeRow(options.mode ?? 'swat', options.onSelectMode));

    this.stageSlot.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px';
    if (options.stages && options.stages.length > 0 && options.onSelectStage) {
      this.renderStageButtons(options.stages, options.currentStageId ?? map.id, options.onSelectStage);
    }
    if (options.stageSelector) this.stageSlot.appendChild(options.stageSelector);
    header.append(titleWrap, this.stageSlot);

    // 2 カラム本体（左: 間取り図、右: インテル＆操作ガイド）
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start';

    // 左カラム: 間取り図
    const mapCol = document.createElement('div');
    mapCol.style.cssText = 'flex:1 1 420px;min-width:300px';

    const mapHeader = document.createElement('div');
    mapHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px';
    const mapLabel = document.createElement('div');
    mapLabel.textContent = '建物間取り図（侵入前情報）';
    mapLabel.style.cssText = 'font:bold 12px sans-serif;color:#9cb4cc;letter-spacing:0.04em';
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
            ? 'padding:3px 10px;font:bold 11px monospace;color:#0a121a;background:#56c8d8;border:1px solid #56c8d8;border-radius:4px;cursor:default'
            : 'padding:3px 10px;font:11px monospace;color:#cfe0f0;background:#192534;border:1px solid #354a63;border-radius:4px;cursor:pointer';
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
      'display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font:12px sans-serif;color:#9fb4c8';
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
    if (map.seed !== undefined && options.onRegenerate) {
      mapCol.appendChild(this.buildSeedRow(map.seed, options.onRegenerate));
    }

    // 右カラム: インテル＆操作
    const intelCol = document.createElement('div');
    intelCol.style.cssText = 'flex:1 1 280px;min-width:260px;display:flex;flex-direction:column;gap:14px';

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
      sumTitle.style.cssText = 'font:bold 12px sans-serif;color:#9cb4cc;margin-bottom:6px';
      const sumText = document.createElement('div');
      sumText.textContent = map.briefing.summary;
      sumText.style.cssText = 'font:13px/1.6 sans-serif;color:#dce6f2';
      sumBox.append(sumTitle, sumText);
      intelCol.appendChild(sumBox);
    }

    // 操作ガイド
    const ctrlBox = document.createElement('div');
    ctrlBox.style.cssText =
      'background:#16202c;border:1px solid #293b50;border-radius:6px;padding:12px 14px';
    const ctrlTitle = document.createElement('div');
    ctrlTitle.textContent = '基本操作';
    ctrlTitle.style.cssText = 'font:bold 12px sans-serif;color:#9cb4cc;margin-bottom:6px';
    const ctrlList = document.createElement('div');
    ctrlList.style.cssText =
      'display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font:12px/1.45 sans-serif;color:#c7d6e6';
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
    footer.style.cssText = 'margin-top:20px;padding-top:14px;border-top:1px solid #263649;display:flex;justify-content:flex-end';
    this.startBtn.type = 'button';
    this.startBtn.textContent = '交渉フェーズへ (Enter)';
    this.startBtn.style.cssText = `padding:11px 28px;font:bold 16px sans-serif;color:#0a121a;background:${suspectMode ? '#ff7b7b' : '#56c8d8'};border:none;border-radius:6px;cursor:pointer;letter-spacing:0.04em`;
    this.startBtn.addEventListener('click', this.handleStart);
    footer.appendChild(this.startBtn);

    card.append(header, body, footer);
    this.root.appendChild(card);
    parent.appendChild(this.root);
  }

  private renderStageButtons(
    stages: readonly StageEntry[],
    currentStageId: string,
    onSelectStage: (stageId: string) => void,
  ): void {
    const label = document.createElement('span');
    label.textContent = 'STAGE:';
    label.style.cssText = 'font:bold 11px monospace;letter-spacing:0.08em;color:#8aa4be;margin-right:2px';
    this.stageSlot.appendChild(label);

    for (const stage of stages) {
      const active = stage.id === currentStageId;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = stage.name;
      btn.title = stage.description ?? stage.name;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.dataset.stageId = stage.id;
      btn.disabled = active;
      btn.style.cssText = active
        ? 'padding:6px 12px;font:bold 12px sans-serif;color:#0a121a;background:#56c8d8;border:1px solid #56c8d8;border-radius:4px;cursor:default'
        : 'padding:6px 12px;font:12px sans-serif;color:#d6e4f0;background:#192534;border:1px solid #354a63;border-radius:4px;cursor:pointer';
      if (!active) {
        const onClick = (): void => {
          if (this.disposed || !this.visible) return;
          onSelectStage(stage.id);
        };
        btn.addEventListener('click', onClick);
        this.stageBtnCleanups.push(() => btn.removeEventListener('click', onClick));
      }
      this.stageSlot.appendChild(btn);
    }
  }

  private buildModeRow(mode: GameMode, onSelectMode: (mode: GameMode) => void): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px';
    const label = document.createElement('span');
    label.textContent = 'MODE:';
    label.style.cssText = 'font:bold 11px monospace;letter-spacing:0.08em;color:#8aa4be;margin-right:2px';
    row.appendChild(label);
    const items: [GameMode, string, string][] = [
      ['swat', 'SWAT（突入）', '#56c8d8'],
      ['suspect', '容疑者（籠城 vs SWAT）', '#ff7b7b'],
    ];
    for (const [m, text, color] of items) {
      const active = m === mode;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.dataset.mode = m;
      btn.disabled = active;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.style.cssText = active
        ? `padding:6px 12px;font:bold 12px sans-serif;color:#0a121a;background:${color};border:1px solid ${color};border-radius:4px;cursor:default`
        : 'padding:6px 12px;font:12px sans-serif;color:#d6e4f0;background:#192534;border:1px solid #354a63;border-radius:4px;cursor:pointer';
      if (!active) {
        const onClick = (): void => {
          if (this.disposed || !this.visible) return;
          onSelectMode(m);
        };
        btn.addEventListener('click', onClick);
        this.stageBtnCleanups.push(() => btn.removeEventListener('click', onClick));
      }
      row.appendChild(btn);
    }
    return row;
  }

  private buildSeedRow(seed: number, onRegenerate: (seed?: number) => void): HTMLElement {
    const row = this.seedRow;
    row.style.cssText =
      'display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;padding:8px 10px;background:#16202c;border:1px solid #293b50;border-radius:6px;font:12px sans-serif;color:#9fb4c8';
    const label = document.createElement('span');
    label.textContent = `ランダム間取り SEED: ${seed}`;
    label.style.cssText = 'font-family:monospace;color:#7ce2f0;margin-right:auto';
    const btnCss =
      'padding:5px 10px;font:12px sans-serif;color:#d6e4f0;background:#192534;border:1px solid #354a63;border-radius:4px;cursor:pointer';
    const reroll = document.createElement('button');
    reroll.type = 'button';
    reroll.textContent = '別の間取りを生成';
    reroll.style.cssText = btnCss;
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.placeholder = 'シード指定';
    input.style.cssText =
      'width:110px;padding:5px 6px;font:12px monospace;color:#e6eef8;background:#0b1118;border:1px solid #354a63;border-radius:4px';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = '適用';
    apply.style.cssText = btnCss;

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
    row.append(label, reroll, input, apply);
    return row;
  }

  private makeStatBox(label: string, value: string, valueColor: string): HTMLElement {
    const box = document.createElement('div');
    box.style.cssText =
      'background:#16202c;border:1px solid #293b50;border-radius:6px;padding:10px 12px';
    const lbl = document.createElement('div');
    lbl.textContent = label;
    lbl.style.cssText = 'font:11px sans-serif;color:#9cb4cc;margin-bottom:4px';
    const val = document.createElement('div');
    val.textContent = value;
    val.style.cssText = `font:bold 20px sans-serif;color:${valueColor}`;
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
