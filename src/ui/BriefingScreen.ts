import type { BriefingRange, MapData, StageEntry } from '../core/types';
import { motifById } from '../world/Motif';
import type { GameMode } from '../modes/SuspectMode';
import { collectFloorLevels, drawFloorPlan, floorLabelAt, resolveActiveFloor } from './Minimap';
import { getLocale, isEn, setLocale, t, tMotifLabel, tMotifSummary, tStageDesc, tStageName, tStageSize, tStageTagline } from '../core/i18n';
import { buildSeedShareUrl, copyToClipboard, KOFI_URL, type SeedShareInfo } from './shareLinks';
import {
  getEffectiveSuspectLoadout,
  getEffectiveSwatLoadout,
  getNextUnlockPreview,
  getProgression,
  getStageUnlockLevel,
  getSuspectUnlocks,
  getSwatUnlocks,
  isStageUnlocked,
  isSuspectModeUnlocked,
  isUnlockAll,
  updateSquadMemberLoadout,
  updateSuspectLoadout,
  updateSwatLoadout,
  xpProgressInLevel,
  type SquadMemberWeaponId,
  type SuspectAllyPolicy,
  type SuspectPrimaryWeaponId,
  type SuspectVestTier,
  type SwatPrimaryWeaponId,
  type SwatVestTier,
} from '../rules/Progression';

const PLAN_WIDTH = 560;
const PLAN_HEIGHT = 420;

const STYLE_ID = 'briefing-screen-style';
const CSS = `
.bfs-card{width:100%;max-width:1280px;max-height:96vh;overflow:auto;background:#111822;border:1px solid #3a5170;border-radius:10px;padding:24px 30px;box-shadow:0 14px 40px rgba(0,0,0,.7);box-sizing:border-box}
.bfs-topbar{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:10px}
.bfs-topbtn{display:inline-flex;align-items:center;gap:5px;padding:5px 11px;border-radius:6px;background:#192534;border:1px solid #354a63;color:#dce6f2;font:bold 12px sans-serif;cursor:pointer;transition:background .12s,border-color .12s}
.bfs-topbtn:hover{background:#23354b;border-color:#7fb4ec}
.bfs-setup{display:grid;grid-template-columns:minmax(260px,2fr) minmax(320px,3fr);gap:18px;padding-bottom:18px;margin-bottom:18px;border-bottom:1px solid #263649}
.bfs-step{display:flex;flex-direction:column;gap:8px}
.bfs-step-title{font:bold 15px sans-serif;color:#b8cbe0;letter-spacing:.04em}
.bfs-step-title b{display:inline-flex;width:22px;height:22px;align-items:center;justify-content:center;margin-right:6px;border-radius:50%;background:#f2c14e;color:#0a121a;font-size:13px}
.bfs-choices{display:grid;gap:8px}
.bfs-choice{text-align:left;padding:12px 14px;border-radius:8px;background:#192534;border:2px solid #34495f;color:#dce6f2;cursor:pointer;font:15px/1.4 sans-serif;display:flex;flex-direction:column;gap:4px;transition:background .12s,border-color .12s}
.bfs-choice:not(.active):hover,.bfs-choice:not(.active):focus-visible{background:#213248;border-color:#7fb4ec;outline:none}
.bfs-choice.active{cursor:default;color:#f4f8fc}
.bfs-choice.locked{opacity:.56;filter:grayscale(.45);cursor:default;border-style:dashed;border-color:#36475a;background:#131b26}
.bfs-choice.locked:hover{background:#131b26;border-color:#36475a}
.bfs-lock-badge{margin-left:auto;white-space:nowrap;font:bold 11px sans-serif;padding:2px 7px;border-radius:999px;background:rgba(242,193,78,.14);color:#f2c14e;border:1px solid rgba(242,193,78,.4)}
.bfs-prog{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:10px 14px;margin-bottom:14px;border-radius:8px;background:#141e2b;border:1px solid #2b415a}
.bfs-prog-lv{display:flex;align-items:center;gap:8px;white-space:nowrap}
.bfs-prog-tag{font:bold 11px monospace;letter-spacing:.1em;padding:2px 7px;border-radius:4px;color:#0a121a}
.bfs-prog-lvnum{font:bold 18px sans-serif;color:#f4f8fc}
.bfs-prog-barwrap{flex:1 1 180px;min-width:150px;display:flex;flex-direction:column;gap:4px}
.bfs-prog-track{height:7px;background:rgba(255,255,255,.1);border-radius:4px;overflow:hidden}
.bfs-prog-fill{height:100%;border-radius:4px}
.bfs-prog-xptxt{font:11px monospace;color:#9bb2c9}
.bfs-prog-next{flex:2 1 260px;font:12px/1.45 sans-serif;color:#c7d8ea;display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.bfs-prog-next-lbl{font-weight:bold;color:#f2c14e;white-space:nowrap}
.bfs-prog-chip{padding:2px 7px;border-radius:4px;background:rgba(242,193,78,.12);border:1px solid rgba(242,193,78,.32);color:#ffe79e;font-size:11px;white-space:nowrap}
.bfs-prog-sandbox{padding:2px 8px;border-radius:4px;background:rgba(92,214,125,.16);border:1px solid rgba(92,214,125,.45);color:#8ff0a8;font:bold 11px monospace}
.bfs-loadout{margin-bottom:16px;background:#141d29;border:1px solid #2b3f56;border-radius:8px;padding:10px 14px}
.bfs-loadout>summary{cursor:pointer;font:bold 14px sans-serif;color:#dce8f5;letter-spacing:.04em;list-style:none;display:flex;align-items:center;justify-content:space-between;user-select:none}
.bfs-loadout>summary::-webkit-details-marker{display:none}
.bfs-loadout-body{margin-top:12px;display:flex;flex-direction:column;gap:12px}
.bfs-lo-sec{display:flex;flex-direction:column;gap:6px}
.bfs-lo-title{font:bold 12px sans-serif;color:#9cb4cc;letter-spacing:.06em;display:flex;align-items:center;gap:8px}
.bfs-lo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px}
.bfs-lo-btn{text-align:left;padding:8px 10px;border-radius:6px;background:#192534;border:1.5px solid #34495f;color:#dce6f2;cursor:pointer;font:12px/1.35 sans-serif;display:flex;flex-direction:column;gap:2px;transition:background .12s,border-color .12s}
.bfs-lo-btn:not(.active):not(:disabled):hover{background:#22344a;border-color:#7fb4ec}
.bfs-lo-btn.active{border-color:#56c8d8;background:rgba(86,200,216,.16);color:#f4f8fc}
.bfs-lo-btn.active.suspect{border-color:#ff7b7b;background:rgba(255,123,123,.16)}
.bfs-lo-btn:disabled{opacity:.52;filter:grayscale(.45);cursor:default;border-style:dashed;border-color:#344456;background:#121923}
.bfs-lo-name{font:bold 13px sans-serif;display:flex;align-items:center;justify-content:space-between;gap:4px}
.bfs-lo-sub{font-size:11px;color:#93a8be}
.bfs-lo-lock{font:bold 11px sans-serif;color:#f2c14e}
.bfs-sq-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.bfs-sq-card{background:#111923;border:1px solid #2a3c52;border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.bfs-sq-card.locked{opacity:.58}
.bfs-sq-head{font:bold 12px monospace;color:#9fd8ff;display:flex;justify-content:space-between;align-items:center}
.bfs-sq-row{display:flex;align-items:center;justify-content:space-between;gap:6px;font:12px sans-serif;color:#b8cbe0}
.bfs-sq-sel{flex:1;min-width:0;padding:4px 6px;border-radius:4px;background:#192534;border:1px solid #3a516c;color:#e6eef8;font:12px sans-serif}
.bfs-sq-sel:disabled{opacity:.6;cursor:default}
.bfs-sq-cnt{display:inline-flex;align-items:center;gap:4px}
.bfs-sq-step{width:22px;height:22px;padding:0;border-radius:4px;background:#1d2b3c;border:1px solid #405874;color:#e6eef8;font:bold 12px monospace;cursor:pointer}
.bfs-sq-step:disabled{opacity:.4;cursor:default}
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
.bfs-seed button:hover{background:#24364d;border-color:#6ea3db}
.bfs-start{padding:15px 36px;font:bold 19px sans-serif;color:#0a121a;border:none;border-radius:8px;cursor:pointer;letter-spacing:.04em}
.bfs-kofi{display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:6px;border:1px solid rgba(255,118,115,.32);background:rgba(255,94,91,.08);color:rgba(255,204,202,.9);text-decoration:none;font:12px sans-serif;transition:background .12s,border-color .12s,color .12s}
.bfs-kofi:hover{background:rgba(255,94,91,.2);border-color:rgba(255,118,115,.7);color:#fff}
.bfs-toggle{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;padding:10px 12px;border-radius:8px;background:#192534;border:2px solid #34495f;color:#dce6f2;cursor:pointer;font:14px/1.4 sans-serif;transition:background .12s,border-color .12s}
.bfs-toggle:hover,.bfs-toggle:focus-visible{background:#213248;border-color:#ff9d9d;outline:none}
.bfs-toggle[aria-pressed="true"]{border-color:#ff7b7b;background:#ff7b7b22;box-shadow:0 0 0 1px #ff7b7b55 inset}
.bfs-toggle-badge{white-space:nowrap;font:bold 12px monospace;padding:2px 8px;border-radius:999px;background:#263649;color:#9fb2c6}
.bfs-toggle[aria-pressed="true"] .bfs-toggle-badge{background:#ff7b7b;color:#0a121a}
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
  /** タイトル画面へ戻るコールバック（指定時は右上に「タイトルへ」ボタンを表示） */
  onBackToTitle?: () => void;
  /** 設定モーダルを開くコールバック */
  onOpenSettings?: () => void;
  /** シード共有 URL 生成用情報 */
  seedShareInfo?: SeedShareInfo;
  /** ロードアウト変更時のコールバック */
  onLoadoutChange?: () => void;
}

function formatRange(range: BriefingRange | undefined): string {
  if (!range) return t('不明', 'Unknown');
  return range.min === range.max
    ? t(`${range.min}名`, `${range.min}`)
    : t(`${range.min}〜${range.max}名`, `${range.min}-${range.max}`);
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
  private readonly loadoutSlot = document.createElement('div');
  private modeSlot: HTMLElement | null = null;
  private readonly stageBtnCleanups: (() => void)[] = [];
  private visible = false;
  private disposed = false;
  private readonly onStart: () => void;
  private readonly mode: GameMode;
  private readonly onLoadoutChange?: () => void;

  constructor(parent: HTMLElement, map: MapData, options: BriefingScreenOptions) {
    this.onStart = options.onStart;
    this.mode = options.mode ?? 'swat';
    this.onLoadoutChange = options.onLoadoutChange;
    const suspectMode = this.mode === 'suspect';

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

    // 右上ユーティリティバー（言語切替・設定）
    const topbar = document.createElement('div');
    topbar.className = 'bfs-topbar';
    const langBtn = document.createElement('button');
    langBtn.type = 'button';
    langBtn.className = 'bfs-topbtn';
    langBtn.textContent = getLocale() === 'en' ? '🌐 日本語' : '🌐 English';
    const onLangClick = (): void => {
      if (this.disposed) return;
      setLocale(getLocale() === 'en' ? 'ja' : 'en');
    };
    langBtn.addEventListener('click', onLangClick);
    this.stageBtnCleanups.push(() => langBtn.removeEventListener('click', onLangClick));
    topbar.appendChild(langBtn);

    if (options.onBackToTitle) {
      const titleBtn = document.createElement('button');
      titleBtn.type = 'button';
      titleBtn.className = 'bfs-topbtn';
      titleBtn.dataset.action = 'title';
      titleBtn.textContent = t('← タイトルへ', '← Title');
      titleBtn.style.marginRight = 'auto';
      const onTitleClick = (): void => {
        if (this.disposed) return;
        options.onBackToTitle?.();
      };
      titleBtn.addEventListener('click', onTitleClick);
      this.stageBtnCleanups.push(() => titleBtn.removeEventListener('click', onTitleClick));
      topbar.prepend(titleBtn);
    }

    if (options.onOpenSettings) {
      const settingsBtn = document.createElement('button');
      settingsBtn.type = 'button';
      settingsBtn.className = 'bfs-topbtn';
      settingsBtn.textContent = t('⚙ 設定', '⚙ Settings');
      const onSettingsClick = (): void => {
        if (this.disposed) return;
        options.onOpenSettings?.();
      };
      settingsBtn.addEventListener('click', onSettingsClick);
      this.stageBtnCleanups.push(() => settingsBtn.removeEventListener('click', onSettingsClick));
      topbar.appendChild(settingsBtn);
    }
    card.appendChild(topbar);

    // 進行度バナー（現在モードの Lv・XP バー・次の解放プレビュー）
    card.appendChild(this.buildProgressionBanner(this.mode));

    // 上段: ミッション設定（① モード ② マップの広さ）
    const setup = document.createElement('div');
    setup.className = 'bfs-setup';
    if (options.onSelectMode) {
      this.modeSlot = this.buildModeStep(options.mode ?? 'swat', options.onSelectMode);
      setup.appendChild(this.modeSlot);
    } else {
      // モード・広さはタイトル画面で選ぶ。ここではシード（間取り）だけを扱う
      setup.style.gridTemplateColumns = '1fr';
    }

    this.stageSlot.className = 'bfs-step';
    const hasStageButtons = Boolean(options.stages && options.stages.length > 0 && options.onSelectStage);
    if (hasStageButtons) {
      this.renderStageButtons(options.stages!, options.currentStageId ?? map.id, options.onSelectStage!, options.onSelectMode ? 2 : 1);
    }
    if (map.seed !== undefined && options.onRegenerate) {
      this.stageSlot.appendChild(this.buildSeedRow(map.seed, options.onRegenerate, options.seedShareInfo));
    }
    if (options.stageSelector) this.stageSlot.appendChild(options.stageSelector);
    setup.appendChild(this.stageSlot);

    // ブリーフィング見出し
    const header = document.createElement('div');
    header.style.cssText = 'margin-bottom:14px';
    const badge = document.createElement('div');
    badge.textContent = suspectMode ? t('SUSPECT MODE — 籠城', 'SUSPECT MODE — BARRICADE') : 'MISSION BRIEFING';
    badge.style.cssText = `font:bold 13px monospace;letter-spacing:0.14em;color:${suspectMode ? '#ff7b7b' : '#56c8d8'};margin-bottom:2px`;
    const title = document.createElement('div');
    title.textContent = tStageName(map.id, map.name);
    title.style.cssText = 'font:bold 26px sans-serif;color:#f4f8fc';
    header.append(badge, title);
    if (map.motif) {
      const motif = motifById(map.motif);
      const chip = document.createElement('div');
      chip.textContent = t(`モチーフ: ${motif.label}`, `Facility: ${tMotifLabel(motif.id, motif.label)}`);
      chip.style.cssText = `margin-top:4px;font:bold 13px sans-serif;letter-spacing:.08em;color:${motif.accentCss}`;
      header.appendChild(chip);
    }

    // 2 カラム本体（左: 間取り図、右: インテル＆操作ガイド）
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start';

    // 左カラム: 間取り図
    const mapCol = document.createElement('div');
    mapCol.style.cssText = 'flex:3 1 480px;min-width:300px';

    const mapHeader = document.createElement('div');
    mapHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px';
    const mapLabel = document.createElement('div');
    mapLabel.textContent = t('建物間取り図（侵入前情報）', 'Building Floor Plan (Pre-Entry Intel)');
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
      ['#56c8d8', suspectMode ? t('あなたの潜伏位置', 'Your Holdout Position') : t('突入地点', 'Entry Point')],
      ['#d89b3c', suspectMode ? t('ドア（F 長押しで施錠）', 'Door (Hold F to Lock)') : t('ドア', 'Door')],
      ['#e05252', suspectMode ? t('施錠ドア（SWAT はブリーチが必要）', 'Locked Door (SWAT Must Breach)') : t('施錠ドア（G/指示でブリーチ）', 'Locked Door (G / Order to Breach)')],
      ['#967656', t('遮蔽物', 'Cover')],
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
      this.makeStatBox(suspectMode ? t('突入 SWAT', 'Incoming SWAT') : t('推定容疑者', 'Est. Suspects'), formatRange(map.briefing?.estimatedSuspects), '#ff7b7b'),
      this.makeStatBox(suspectMode ? t('人質・民間人', 'Hostages / Civilians') : t('推定人質・民間人', 'Est. Hostages / Civilians'), formatRange(map.briefing?.estimatedHostages), '#ffd24d'),
    );
    intelCol.appendChild(countsGrid);

    // 状況概要
    if (map.briefing?.summary) {
      const sumBox = document.createElement('div');
      sumBox.style.cssText =
        'background:#16202c;border:1px solid #293b50;border-radius:6px;padding:12px 14px';
      const sumTitle = document.createElement('div');
      sumTitle.textContent = t('状況概要', 'Situation Overview');
      sumTitle.style.cssText = 'font:bold 14px sans-serif;color:#9cb4cc;margin-bottom:6px';
      const sumText = document.createElement('div');
      sumText.textContent = suspectMode
        ? map.briefing.summary
        : tMotifSummary(map.motif, map.briefing.summary, map.seed ?? 0);
      sumText.style.cssText = 'font:15px/1.65 sans-serif;color:#dce6f2';
      sumBox.append(sumTitle, sumText);
      intelCol.appendChild(sumBox);
    }

    // 操作ガイド
    const ctrlBox = document.createElement('div');
    ctrlBox.style.cssText =
      'background:#16202c;border:1px solid #293b50;border-radius:6px;padding:12px 14px';
    const ctrlTitle = document.createElement('div');
    ctrlTitle.textContent = t('基本操作', 'Controls');
    ctrlTitle.style.cssText = 'font:bold 14px sans-serif;color:#9cb4cc;margin-bottom:6px';
    const ctrlList = document.createElement('div');
    ctrlList.style.cssText =
      'display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:14px/1.5 sans-serif;color:#c7d6e6';
    const controls: [string, string][] = suspectMode
      ? [
          ['WASD / Shift / C', t('移動 / 静音（足音小） / しゃがみ切替（発見されにくい）', 'Move / Silent Walk / Toggle Crouch (Harder to spot)')],
          ['Q / E', t('左右リーン', 'Lean Left / Right')],
          [t('左クリック / R', 'LMB / R'), t('射撃（改造フルオート拳銃） / リロード（予備弾は有限）', 'Fire (Auto Pistol) / Reload (Limited mags)')],
          [t('F / F 長押し', 'F / Hold F'), t('ドア開閉 / 閉じたドアを施錠・解錠', 'Open/Close Door / Lock or Unlock Closed Door')],
          [t('民間人に F 長押し', 'Hold F on Civilian'), t('人質を拘束して連れ回す（もう一度 F で解放）', 'Grab Hostage as Shield (Press F to release)')],
          [t('ホイール', 'Wheel'), t('ドア段階開閉', 'Incremental Door Open')],
          [t('Space / Space 長押し', 'Space / Hold Space'), t('準備完了（即突入） / 投降', 'Ready Up (Start Assault) / Surrender')],
          ['V', t('ライト（停電中に視界を確保。SWAT に位置がバレるが、暗視装置を照らすと目眩まし）', 'Flashlight (see in a blackout; gives you away, but dazzles SWAT night vision)')],
          [t('配電盤で F 長押し', 'Hold F at Breaker'), t('メインブレーカーを落とす / 上げる', 'Cut / Restore the Main Breaker')],
          ['M / ESC', t('マップ切替 / ポーズ・設定', 'Toggle Map / Pause & Settings')],
        ]
      : [
          ['WASD / Shift / C', t('移動 / 静音 / しゃがみ切替（Ctrl は不使用）', 'Move / Silent Walk / Toggle Crouch (No Ctrl)')],
          ['Q / E', t('左右リーン', 'Lean Left / Right')],
          [t('左 / 右クリック', 'LMB / RMB'), t('射撃（高精度） / 部隊指揮メニュー（保持）', 'Fire / Squad Command Menu (Hold)')],
          ['Z / X / T', t('クイック指示 / 隊員集合 / 指揮対象切替', 'Quick Order / Fall In / Switch Element')],
          ['Tab', t('突入モード切替（ダイナミック ⇔ ステルス）', 'Entry Style (Dynamic ⇔ Stealth)')],
          ['Space', t('警告コール（投降勧告）', 'Compliance Shout (Warning Call)')],
          [t('F / ホイール / G', 'F / Wheel / G'), t('開閉・拘束 / 段階開閉 / ブリーチ', 'Interact & Arrest / Peek Door / Breach')],
          ['1 / 2 / 3', t('主武器 / 非致死 / フラッシュ', 'Primary / Less-Lethal / Flashbang')],
          ['N', t('暗視装置（停電中は増幅して見える。ライトを浴びるとオートゲート減光＋光源周囲にハロー）', 'Night Vision (amplified view in a blackout; autogates with localized halo under bright light)')],
          [t('配電盤で F 長押し', 'Hold F at Breaker'), t('メインブレーカーを落とす / 上げる', 'Cut / Restore the Main Breaker')],
          [t('中クリック / 4', 'MMB / 4'), t('オプティワンド構え⇔武器（左クリック長押しでカメラ、しゃがみ+ドア前でドア下）', 'Optiwand ⇔ Weapon (Hold LMB: camera / Crouch at door: under-door)')],
          ['M / ESC', t('マップ切替 / ポーズ・設定', 'Toggle Map / Pause & Settings')],
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

    // フッター（控えめな Ko-fi + 突入開始ボタン）
    const footer = document.createElement('div');
    footer.style.cssText = 'margin-top:20px;padding-top:14px;border-top:1px solid #263649;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap';
    const footLeft = document.createElement('div');
    footLeft.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    const footHelp = document.createElement('div');
    footHelp.textContent = options.onSelectMode
      ? t('モードとマップの広さを選んだら、交渉フェーズへ進む', 'Select mode & map size, then proceed to negotiation')
      : t('間取りと人数を確認したら、交渉フェーズへ進む', 'Review the floor plan, then proceed to negotiation');
    footHelp.style.cssText = 'font-size:14px;color:#8399b0';
    const kofi = document.createElement('a');
    kofi.className = 'bfs-kofi';
    kofi.href = KOFI_URL;
    kofi.target = '_blank';
    kofi.rel = 'noopener noreferrer';
    kofi.textContent = t('☕ Ko-fi で応援', '☕ Support on Ko-fi');
    footLeft.append(footHelp, kofi);

    this.startBtn.type = 'button';
    this.startBtn.className = 'bfs-start';
    this.startBtn.textContent = t('交渉フェーズへ (Enter)', 'Proceed to Negotiation (Enter)');
    this.startBtn.style.background = suspectMode ? '#ff7b7b' : '#56c8d8';
    footer.appendChild(footLeft);
    this.startBtn.addEventListener('click', this.handleStart);
    footer.appendChild(this.startBtn);

    // ロードアウト選択パネル
    this.renderLoadoutPanel();

    card.append(setup, header, this.loadoutSlot, body, footer);
    this.root.appendChild(card);
    parent.appendChild(this.root);
  }

  private buildProgressionBanner(mode: GameMode): HTMLElement {
    const state = getProgression();
    const prog = state[mode];
    const xpInfo = xpProgressInLevel(prog.xp);
    const sandbox = isUnlockAll(state);
    const accent = mode === 'suspect' ? '#ff7b7b' : '#56c8d8';

    const bar = document.createElement('div');
    bar.className = 'bfs-prog';

    const lv = document.createElement('div');
    lv.className = 'bfs-prog-lv';
    const tag = document.createElement('span');
    tag.className = 'bfs-prog-tag';
    tag.style.background = accent;
    tag.textContent = mode === 'suspect' ? 'SUSPECT' : 'SWAT';
    const lvNum = document.createElement('span');
    lvNum.className = 'bfs-prog-lvnum';
    lvNum.textContent = `Lv.${prog.level}`;
    lv.append(tag, lvNum);
    if (sandbox) {
      const sb = document.createElement('span');
      sb.className = 'bfs-prog-sandbox';
      sb.textContent = t('SANDBOX 全解放', 'SANDBOX');
      lv.appendChild(sb);
    }

    const barWrap = document.createElement('div');
    barWrap.className = 'bfs-prog-barwrap';
    const track = document.createElement('div');
    track.className = 'bfs-prog-track';
    const fill = document.createElement('div');
    fill.className = 'bfs-prog-fill';
    fill.style.width = `${Math.round(xpInfo.ratio * 100)}%`;
    fill.style.background = accent;
    track.appendChild(fill);
    const xpTxt = document.createElement('div');
    xpTxt.className = 'bfs-prog-xptxt';
    xpTxt.textContent = xpInfo.isMax
      ? t(`MAX LEVEL · 総 XP ${prog.xp}`, `MAX LEVEL · Total XP ${prog.xp}`)
      : t(`XP ${xpInfo.current} / ${xpInfo.required} (次: Lv.${prog.level + 1})`, `XP ${xpInfo.current} / ${xpInfo.required} (Next: Lv.${prog.level + 1})`);
    barWrap.append(track, xpTxt);

    const nextBox = document.createElement('div');
    nextBox.className = 'bfs-prog-next';
    const nextItems = getNextUnlockPreview(mode, state);
    if (sandbox) {
      nextBox.textContent = t('サンドボックス有効: すべての装備・マップ・交渉カードが使用可能', 'Sandbox active: all gear, maps & negotiation cards unlocked');
    } else if (nextItems.length === 0) {
      nextBox.textContent = t('★ このモードの全要素を解放済み', '★ All unlocks completed for this mode');
    } else {
      const lbl = document.createElement('span');
      lbl.className = 'bfs-prog-next-lbl';
      lbl.textContent = t(`次の解放 (Lv.${prog.level + 1}):`, `Next (Lv.${prog.level + 1}):`);
      nextBox.appendChild(lbl);
      for (const item of nextItems.slice(0, 4)) {
        const chip = document.createElement('span');
        chip.className = 'bfs-prog-chip';
        chip.textContent = isEn() ? item.labelEn : item.labelJa;
        nextBox.appendChild(chip);
      }
      if (nextItems.length > 4) {
        const more = document.createElement('span');
        more.className = 'bfs-prog-chip';
        more.textContent = `+${nextItems.length - 4}`;
        nextBox.appendChild(more);
      }
    }

    bar.append(lv, barWrap, nextBox);
    return bar;
  }

  private renderLoadoutPanel(): void {
    this.loadoutSlot.textContent = '';
    const details = document.createElement('details');
    details.className = 'bfs-loadout';
    details.open = true;

    const summary = document.createElement('summary');
    summary.textContent =
      this.mode === 'suspect'
        ? t('🎒 ロードアウト & 仲間方針（クリックで開閉）', '🎒 Loadout & Crew Policy (Click to Toggle)')
        : t('🎒 ロードアウト & 分隊装備（クリックで開閉）', '🎒 Loadout & Squad Gear (Click to Toggle)');
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'bfs-loadout-body';
    if (this.mode === 'suspect') {
      this.buildSuspectLoadout(body);
    } else {
      this.buildSwatLoadout(body);
    }
    details.appendChild(body);
    this.loadoutSlot.appendChild(details);
  }

  private makeLoadoutBtn(
    opts: {
      name: string;
      sub: string;
      active: boolean;
      locked: boolean;
      lockLabel: string;
      suspectStyle?: boolean;
      onClick: () => void;
    },
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `bfs-lo-btn${opts.active ? (opts.suspectStyle ? ' active suspect' : ' active') : ''}`;
    b.disabled = opts.locked;
    const head = document.createElement('div');
    head.className = 'bfs-lo-name';
    head.appendChild(document.createTextNode(opts.locked ? `🔒 ${opts.name}` : opts.name));
    if (opts.active && !opts.locked) {
      const ck = document.createElement('span');
      ck.textContent = '✓';
      ck.style.color = opts.suspectStyle ? '#ff9a9a' : '#7ce2f0';
      head.appendChild(ck);
    }
    b.appendChild(head);
    const sub = document.createElement('div');
    sub.className = opts.locked ? 'bfs-lo-lock' : 'bfs-lo-sub';
    sub.textContent = opts.locked ? opts.lockLabel : opts.sub;
    b.appendChild(sub);
    if (!opts.locked) {
      b.addEventListener('click', () => {
        if (this.disposed) return;
        opts.onClick();
        this.renderLoadoutPanel();
        this.onLoadoutChange?.();
      });
    }
    return b;
  }

  private buildSwatLoadout(container: HTMLElement): void {
    const state = getProgression();
    const u = getSwatUnlocks(state);
    const lo = getEffectiveSwatLoadout(state);

    // 1. Primary weapon
    const wSec = document.createElement('div');
    wSec.className = 'bfs-lo-sec';
    const wTitle = document.createElement('div');
    wTitle.className = 'bfs-lo-title';
    wTitle.textContent = t('主武器 (Primary Weapon)', 'PRIMARY WEAPON');
    const wGrid = document.createElement('div');
    wGrid.className = 'bfs-lo-grid';
    const swatWeapons: { id: SwatPrimaryWeaponId; name: string; sub: string; reqLv: number }[] = [
      { id: 'rifle', name: t('カービン', 'Carbine'), sub: t('万能・高精度', 'Balanced & accurate'), reqLv: 1 },
      { id: 'smg', name: t('短機関銃 (SMG)', 'SMG'), sub: t('機動力 +12%・高連射', 'Speed +12%, high ROF'), reqLv: 2 },
      { id: 'suppressed_rifle', name: t('消音カービン', 'Suppressed Carbine'), sub: t('低騒音・警戒度上昇小', 'Low noise, low alert'), reqLv: 3 },
      { id: 'shotgun', name: t('ショットガン', 'Shotgun'), sub: t('近距離8散弾・高火力', '8-pellet CQB power'), reqLv: 4 },
    ];
    for (const w of swatWeapons) {
      wGrid.appendChild(
        this.makeLoadoutBtn({
          name: w.name,
          sub: w.sub,
          active: lo.primaryWeapon === w.id,
          locked: !u.weapons[w.id],
          lockLabel: t(`SWAT Lv.${w.reqLv} で解放`, `SWAT Lv.${w.reqLv}`),
          onClick: () => updateSwatLoadout({ primaryWeapon: w.id }),
        }),
      );
    }
    wSec.append(wTitle, wGrid);
    container.appendChild(wSec);

    // 2. Armor vest
    const vSec = document.createElement('div');
    vSec.className = 'bfs-lo-sec';
    const vTitle = document.createElement('div');
    vTitle.className = 'bfs-lo-title';
    vTitle.textContent = t('防弾ベスト (Armor Vest)', 'ARMOR VEST');
    const vGrid = document.createElement('div');
    vGrid.className = 'bfs-lo-grid';
    const swatVests: { id: SwatVestTier; name: string; sub: string; reqLv: number }[] = [
      { id: 'light', name: t('軽量ベスト', 'Light Vest'), sub: t('高速移動・静音', 'Fast & quiet'), reqLv: 2 },
      { id: 'standard', name: t('標準ベスト', 'Standard Vest'), sub: t('防御と機動の均衡', 'Balanced protection'), reqLv: 1 },
      { id: 'heavy', name: t('重装ベスト', 'Heavy Vest'), sub: t('高耐久・低速', 'Max armor, heavier'), reqLv: 4 },
    ];
    for (const v of swatVests) {
      vGrid.appendChild(
        this.makeLoadoutBtn({
          name: v.name,
          sub: v.sub,
          active: lo.vest === v.id,
          locked: !u.vests[v.id],
          lockLabel: t(`SWAT Lv.${v.reqLv} で解放`, `SWAT Lv.${v.reqLv}`),
          onClick: () => updateSwatLoadout({ vest: v.id }),
        }),
      );
    }
    vSec.append(vTitle, vGrid);
    container.appendChild(vSec);

    // 3. Squad customization (4 members)
    const sqSec = document.createElement('div');
    sqSec.className = 'bfs-lo-sec';
    const sqTitle = document.createElement('div');
    sqTitle.className = 'bfs-lo-title';
    sqTitle.textContent = t('分隊装備 (Squad Loadout — 4名)', 'SQUAD LOADOUT (4 MEMBERS)');
    if (!u.squadLoadoutCustom) {
      const lk = document.createElement('span');
      lk.className = 'bfs-lo-lock';
      lk.textContent = t('🔒 SWAT Lv.3 で解放（盾持ち隊員 & 個別装備）', '🔒 Unlocks at SWAT Lv.3 (Shield & Custom Gear)');
      sqTitle.appendChild(lk);
    } else if (!u.squadGadgetCustom) {
      const lk = document.createElement('span');
      lk.className = 'bfs-lo-lock';
      lk.textContent = t('🔒 ガジェット個別配分は SWAT Lv.4 で解放', '🔒 Custom Gadgets unlock at SWAT Lv.4');
      sqTitle.appendChild(lk);
    }
    const sqGrid = document.createElement('div');
    sqGrid.className = 'bfs-sq-grid';
    const callsigns = ['Alpha-1', 'Alpha-2', 'Bravo-1', 'Bravo-2'];
    const memberWeapons: { id: SquadMemberWeaponId; label: string; locked: boolean; reqLv: number }[] = [
      { id: 'rifle', label: t('カービン', 'Carbine'), locked: false, reqLv: 1 },
      { id: 'smg', label: t('短機関銃 (SMG)', 'SMG'), locked: !u.weapons.smg, reqLv: 2 },
      { id: 'suppressed_rifle', label: t('消音カービン', 'Suppressed'), locked: !u.weapons.suppressed_rifle, reqLv: 3 },
      { id: 'shotgun', label: t('ショットガン', 'Shotgun'), locked: !u.weapons.shotgun, reqLv: 4 },
      { id: 'pepperball', label: t('ペッパーボール', 'Pepperball'), locked: false, reqLv: 1 },
      { id: 'shield', label: t('防弾盾 + 拳銃', 'Ballistic Shield'), locked: !u.shieldMember, reqLv: 3 },
    ];
    const memberVests: { id: SwatVestTier; label: string; locked: boolean; reqLv: number }[] = [
      { id: 'light', label: t('軽量', 'Light'), locked: !u.vests.light, reqLv: 2 },
      { id: 'standard', label: t('標準', 'Standard'), locked: false, reqLv: 1 },
      { id: 'heavy', label: t('重装', 'Heavy'), locked: !u.vests.heavy, reqLv: 4 },
    ];

    for (let i = 0; i < 4; i++) {
      const m = lo.squad[i]!;
      const card = document.createElement('div');
      card.className = `bfs-sq-card${u.squadLoadoutCustom ? '' : ' locked'}`;
      const head = document.createElement('div');
      head.className = 'bfs-sq-head';
      head.textContent = `#${i + 1} ${callsigns[i]}`;
      card.appendChild(head);

      // Weapon select
      const wRow = document.createElement('div');
      wRow.className = 'bfs-sq-row';
      const wLbl = document.createElement('span');
      wLbl.textContent = t('武器', 'Wpn');
      const wSel = document.createElement('select');
      wSel.className = 'bfs-sq-sel';
      wSel.disabled = !u.squadLoadoutCustom;
      for (const opt of memberWeapons) {
        const o = document.createElement('option');
        o.value = opt.id;
        o.disabled = opt.locked;
        o.textContent = opt.locked ? `🔒 ${opt.label} (Lv.${opt.reqLv})` : opt.label;
        if (m.weapon === opt.id) o.selected = true;
        wSel.appendChild(o);
      }
      wSel.addEventListener('change', () => {
        updateSquadMemberLoadout(i, { weapon: wSel.value as SquadMemberWeaponId });
        this.renderLoadoutPanel();
        this.onLoadoutChange?.();
      });
      wRow.append(wLbl, wSel);
      card.appendChild(wRow);

      // Vest select
      const vRow = document.createElement('div');
      vRow.className = 'bfs-sq-row';
      const vLbl = document.createElement('span');
      vLbl.textContent = t('防弾', 'Vest');
      const vSel = document.createElement('select');
      vSel.className = 'bfs-sq-sel';
      vSel.disabled = !u.squadLoadoutCustom;
      for (const opt of memberVests) {
        const o = document.createElement('option');
        o.value = opt.id;
        o.disabled = opt.locked;
        o.textContent = opt.locked ? `🔒 ${opt.label} (Lv.${opt.reqLv})` : opt.label;
        if (m.vest === opt.id) o.selected = true;
        vSel.appendChild(o);
      }
      vSel.addEventListener('change', () => {
        updateSquadMemberLoadout(i, { vest: vSel.value as SwatVestTier });
        this.renderLoadoutPanel();
        this.onLoadoutChange?.();
      });
      vRow.append(vLbl, vSel);
      card.appendChild(vRow);

      // Gadget row (Flash / Gas)
      const gRow = document.createElement('div');
      gRow.className = 'bfs-sq-row';
      const makeStepper = (label: string, val: number, canEdit: boolean, onDelta: (d: number) => void): HTMLElement => {
        const wrap = document.createElement('span');
        wrap.className = 'bfs-sq-cnt';
        const lbl = document.createElement('span');
        lbl.textContent = `${label}:${val}`;
        const minus = document.createElement('button');
        minus.type = 'button';
        minus.className = 'bfs-sq-step';
        minus.textContent = '-';
        minus.disabled = !canEdit || val <= 0;
        minus.addEventListener('click', () => {
          onDelta(-1);
          this.renderLoadoutPanel();
          this.onLoadoutChange?.();
        });
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.className = 'bfs-sq-step';
        plus.textContent = '+';
        plus.disabled = !canEdit || val >= 4;
        plus.addEventListener('click', () => {
          onDelta(1);
          this.renderLoadoutPanel();
          this.onLoadoutChange?.();
        });
        wrap.append(lbl, minus, plus);
        return wrap;
      };
      gRow.append(
        makeStepper(t('閃光', 'FB'), m.flashbangs, u.squadGadgetCustom, (d) =>
          updateSquadMemberLoadout(i, { flashbangs: Math.max(0, Math.min(4, m.flashbangs + d)) }),
        ),
        makeStepper(t('ガス', 'CS'), m.gas, u.squadGadgetCustom && u.teargas, (d) =>
          updateSquadMemberLoadout(i, { gas: Math.max(0, Math.min(4, m.gas + d)) }),
        ),
      );
      card.appendChild(gRow);
      sqGrid.appendChild(card);
    }
    sqSec.append(sqTitle, sqGrid);
    container.appendChild(sqSec);
  }

  private buildSuspectLoadout(container: HTMLElement): void {
    const state = getProgression();
    const u = getSuspectUnlocks(state);
    const lo = getEffectiveSuspectLoadout(state);

    // 1. Primary weapon
    const wSec = document.createElement('div');
    wSec.className = 'bfs-lo-sec';
    const wTitle = document.createElement('div');
    wTitle.className = 'bfs-lo-title';
    wTitle.textContent = t('主武器 (Primary Weapon)', 'PRIMARY WEAPON');
    const wGrid = document.createElement('div');
    wGrid.className = 'bfs-lo-grid';
    const suspectWeaponsList: { id: SuspectPrimaryWeaponId; name: string; sub: string; reqLv: number }[] = [
      { id: 'machine_pistol', name: t('改造オート拳銃', 'Modded Auto Pistol'), sub: t('高機動・軽量', 'Agile & compact'), reqLv: 1 },
      { id: 'suspect_smg', name: t('密輸 SMG', 'Smuggled SMG'), sub: t('高連射・中距離対応', 'Fast ROF, mid-range'), reqLv: 2 },
      { id: 'suspect_shotgun', name: t('ソードオフ SG', 'Sawed-off Shotgun'), sub: t('近距離7散弾・室内制圧', '7-pellet room defense'), reqLv: 3 },
      { id: 'suspect_ar', name: t('軍用アサルトライフル', 'Military AR'), sub: t('高威力・中長距離', 'High damage, rifle range'), reqLv: 4 },
    ];
    for (const w of suspectWeaponsList) {
      wGrid.appendChild(
        this.makeLoadoutBtn({
          name: w.name,
          sub: w.sub,
          active: lo.primaryWeapon === w.id,
          locked: !u.weapons[w.id],
          lockLabel: t(`容疑者 Lv.${w.reqLv} で解放`, `Suspect Lv.${w.reqLv}`),
          suspectStyle: true,
          onClick: () => updateSuspectLoadout({ primaryWeapon: w.id }),
        }),
      );
    }
    wSec.append(wTitle, wGrid);
    container.appendChild(wSec);

    // 2. Armor vest
    const vSec = document.createElement('div');
    vSec.className = 'bfs-lo-sec';
    const vTitle = document.createElement('div');
    vTitle.className = 'bfs-lo-title';
    vTitle.textContent = t('防弾ベスト (Armor Vest)', 'ARMOR VEST');
    const vGrid = document.createElement('div');
    vGrid.className = 'bfs-lo-grid';
    const suspectVests: { id: SuspectVestTier; name: string; sub: string; reqLv: number }[] = [
      { id: 'none', name: t('ベストなし', 'No Vest'), sub: t('最軽量・交渉で後から入手可', 'Lightest; can trade later'), reqLv: 1 },
      { id: 'light', name: t('軽量ベスト', 'Light Vest'), sub: t('機動維持・軽防御', 'Light armor, agile'), reqLv: 2 },
      { id: 'standard', name: t('標準ベスト', 'Standard Vest'), sub: t('実用防御・やや重い', 'Solid defense'), reqLv: 2 },
      { id: 'heavy', name: t('重装ベスト', 'Heavy Vest'), sub: t('最大耐久・移動低下', 'Max durability, heavy'), reqLv: 4 },
    ];
    for (const v of suspectVests) {
      vGrid.appendChild(
        this.makeLoadoutBtn({
          name: v.name,
          sub: v.sub,
          active: lo.vest === v.id,
          locked: !u.vests[v.id],
          lockLabel: t(`容疑者 Lv.${v.reqLv} で解放`, `Suspect Lv.${v.reqLv}`),
          suspectStyle: true,
          onClick: () => updateSuspectLoadout({ vest: v.id }),
        }),
      );
    }
    vSec.append(vTitle, vGrid);
    container.appendChild(vSec);

    // 3. Ally policy
    const pSec = document.createElement('div');
    pSec.className = 'bfs-lo-sec';
    const pTitle = document.createElement('div');
    pTitle.className = 'bfs-lo-title';
    pTitle.textContent = t('仲間の行動方針 (Ally Policy)', 'ALLY POLICY');
    const pGrid = document.createElement('div');
    pGrid.className = 'bfs-lo-grid';
    const policies: { id: SuspectAllyPolicy; name: string; sub: string; reqLv: number }[] = [
      { id: 'balanced', name: t('バランス (標準)', 'Balanced'), sub: t('補強と迎撃をバランス良く実行', 'Balanced defense & fortify'), reqLv: 1 },
      { id: 'aggressive', name: t('攻撃重視', 'Aggressive'), sub: t('積極迎撃・武器改造を優先', 'Aggressive ambush & mods'), reqLv: 3 },
      { id: 'fortify', name: t('籠城・補強重視', 'Fortify'), sub: t('バリケード・トラップ設置を優先', 'Prioritize barricades & traps'), reqLv: 3 },
    ];
    for (const p of policies) {
      pGrid.appendChild(
        this.makeLoadoutBtn({
          name: p.name,
          sub: p.sub,
          active: lo.allyPolicy === p.id,
          locked: p.reqLv > 1 && !u.allyPolicyCustom,
          lockLabel: t(`容疑者 Lv.${p.reqLv} で解放`, `Suspect Lv.${p.reqLv}`),
          suspectStyle: true,
          onClick: () => updateSuspectLoadout({ allyPolicy: p.id }),
        }),
      );
    }
    pSec.append(pTitle, pGrid);
    container.appendChild(pSec);
  }

  private stepTitle(num: number, text: string): HTMLElement {
    const tEl = document.createElement('div');
    tEl.className = 'bfs-step-title';
    const b = document.createElement('b');
    b.textContent = String(num);
    tEl.append(b, document.createTextNode(text));
    return tEl;
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
    c.textContent = t('✓ 選択中', '✓ Selected');
    c.style.cssText = `color:#0a121a;background:${color}`;
    return c;
  }

  private renderStageButtons(
    stages: readonly StageEntry[],
    currentStageId: string,
    onSelectStage: (stageId: string) => void,
    stepNum: number,
  ): void {
    this.stageSlot.appendChild(this.stepTitle(stepNum, t('マップ（間取りは毎回ランダム）', 'Map (Procedural Layout)')));
    const grid = document.createElement('div');
    grid.className = 'bfs-choices';
    const cols = stages.length === 4 ? 2 : Math.min(stages.length, 3);
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    const color = '#f2c14e';
    const modeLabelJa = this.mode === 'suspect' ? '容疑者' : 'SWAT';
    const modeLabelEn = this.mode === 'suspect' ? 'Suspect' : 'SWAT';
    for (const stage of stages) {
      const active = stage.id === currentStageId;
      const locked = !isStageUnlocked(this.mode, stage.id);
      const reqLv = getStageUnlockLevel(stage.id);
      const btn = this.choiceButton(
        active,
        color,
        (b) => {
          b.dataset.stageId = stage.id;
          b.title = locked
            ? t(`${modeLabelJa} Lv.${reqLv} で解放`, `Unlocks at ${modeLabelEn} Lv.${reqLv}`)
            : tStageDesc(stage.id, stage.description ?? stage.name);
          if (locked) {
            b.classList.add('locked');
            b.disabled = true;
          }
          const head = document.createElement('div');
          head.className = 'bfs-choice-name';
          if (stage.size) {
            const sz = document.createElement('span');
            sz.className = 'bfs-size';
            sz.textContent = tStageSize(stage.id, stage.size);
            sz.style.color = locked ? '#6e7f92' : active ? color : '#cfe0f0';
            head.appendChild(sz);
          } else {
            head.appendChild(document.createTextNode(tStageName(stage.id, stage.name)));
          }
          if (locked) {
            const lk = document.createElement('span');
            lk.className = 'bfs-lock-badge';
            lk.textContent = t(`🔒 ${modeLabelJa} Lv.${reqLv} で解放`, `🔒 ${modeLabelEn} Lv.${reqLv}`);
            head.appendChild(lk);
          } else if (active) {
            head.appendChild(this.checkBadge(color));
          }
          b.appendChild(head);
          const desc = document.createElement('div');
          desc.className = 'bfs-choice-desc';
          desc.textContent = tStageTagline(stage.id, stage.tagline ?? stage.description ?? '');
          b.appendChild(desc);
        },
        () => {
          if (!locked) onSelectStage(stage.id);
        },
      );
      grid.appendChild(btn);
    }
    this.stageSlot.appendChild(grid);
  }

  private buildModeStep(mode: GameMode, onSelectMode: (mode: GameMode) => void): HTMLElement {
    const step = document.createElement('div');
    step.className = 'bfs-step';
    step.appendChild(this.stepTitle(1, t('モード', 'Mode')));
    const grid = document.createElement('div');
    grid.className = 'bfs-choices';
    const items: [GameMode, string, string, string][] = [
      ['swat', t('🛡 SWAT（突入側）', '🛡 SWAT (Assaulter)'), t('隊長として部隊を指揮。人質を救出し容疑者を制圧する', 'Lead your squad, rescue hostages, and neutralize threats'), '#56c8d8'],
      ['suspect', t('🔒 容疑者（籠城側）', '🔒 Suspect (Defender)'), t('立てこもり犯として突入してくる SWAT をしのぐ', 'Hold out against an incoming SWAT tactical raid'), '#ff7b7b'],
    ];
    const suspectUnlocked = isSuspectModeUnlocked();
    for (const [m, name, descText, color] of items) {
      const active = m === mode;
      const locked = m === 'suspect' && !suspectUnlocked;
      grid.appendChild(
        this.choiceButton(
          active,
          color,
          (b) => {
            b.dataset.mode = m;
            if (locked) {
              b.classList.add('locked');
              b.disabled = true;
            }
            const head = document.createElement('div');
            head.className = 'bfs-choice-name';
            head.textContent = name;
            if (locked) {
              const lk = document.createElement('span');
              lk.className = 'bfs-lock-badge';
              lk.textContent = t('🔒 SWAT Lv.2 で解放', '🔒 Unlocks at SWAT Lv.2');
              head.appendChild(lk);
            } else if (active) {
              head.appendChild(this.checkBadge(color));
            }
            const desc = document.createElement('div');
            desc.className = 'bfs-choice-desc';
            desc.textContent = descText;
            b.append(head, desc);
          },
          () => {
            if (!locked) onSelectMode(m);
          },
        ),
      );
    }
    step.appendChild(grid);
    return step;
  }

  private buildSeedRow(seed: number, onRegenerate: (seed?: number) => void, seedShareInfo?: SeedShareInfo): HTMLElement {
    const row = this.seedRow;
    row.className = 'bfs-seed';
    const reroll = document.createElement('button');
    reroll.type = 'button';
    reroll.className = 'bfs-reroll';
    reroll.textContent = t('🎲 同じ広さで別の間取りにする', '🎲 Reroll Floor Plan');
    const label = document.createElement('span');
    label.textContent = `SEED ${seed}`;
    label.style.cssText = 'font-family:monospace;color:#7ce2f0;margin-left:auto';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.placeholder = t('シード指定', 'Enter seed');
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = t('適用', 'Apply');

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

    if (seedShareInfo) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      const defaultText = t('📋 シードURLをコピー', '📋 Copy Seed URL');
      copyBtn.textContent = defaultText;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onCopy = (): void => {
        if (this.disposed) return;
        const url = buildSeedShareUrl(seedShareInfo);
        void copyToClipboard(url).then((ok) => {
          if (!ok || this.disposed) return;
          copyBtn.textContent = t('✓ コピー完了', '✓ Copied!');
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (!this.disposed) copyBtn.textContent = defaultText;
          }, 2000);
        });
      };
      copyBtn.addEventListener('click', onCopy);
      this.stageBtnCleanups.push(() => {
        copyBtn.removeEventListener('click', onCopy);
        if (timer) clearTimeout(timer);
      });
      row.appendChild(copyBtn);
    }
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
      if (
        e.target instanceof Node &&
        (this.stageSlot.contains(e.target) ||
          this.seedRow.contains(e.target) ||
          this.loadoutSlot.contains(e.target) ||
          Boolean(this.modeSlot?.contains(e.target)))
      ) {
        return;
      }
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
