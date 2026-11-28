import type { StageEntry } from '../core/types';
import type { RoE } from '../rules/RoE';
import type { ScoreEntry } from '../rules/ScoreBoard';
import type { GameMode, ResultReport } from '../modes/SuspectMode';
import {
  getStageUnlockLevel,
  isStageUnlocked,
  xpProgressInLevel,
  type ProgressionReward,
} from '../rules/Progression';
import { isEn, t, tRoeLabel, tStageDesc, tStageName } from '../core/i18n';
import { buildSeedShareUrl, copyToClipboard, KOFI_URL, type SeedShareInfo } from './shareLinks';

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
    line.textContent = `${tRoeLabel(e.kind, e.label)} ${fmtPts(e.points)}`;
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
  seedShareInfo?: SeedShareInfo;
  /** タイトル画面へ戻る（指定時はリトライの下にボタンを表示） */
  onBackToTitle?: () => void;
  /** 現在のゲームモード（ステージ解放判定に使用） */
  mode?: GameMode;
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

  /** report 指定時（容疑者モード）は RoE スコアの代わりにその内容を表示する。reward 指定時は XP・レベルアップ・新規解放を表示。 */
  show(failed = false, report?: ResultReport, reward?: ProgressionReward): void {
    if (this.el || this.disposed) return;
    const b = this.roe.board;
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.84);color:#fff;font:16px sans-serif;display:flex;align-items:center;justify-content:center;z-index:20';
    const panel = document.createElement('div');
    panel.style.cssText = 'min-width:420px;max-width:560px;max-height:90vh;overflow:auto;padding:24px 32px;background:#14181c;border:1px solid #556;border-radius:8px';

    const title = document.createElement('div');
    title.textContent = report ? report.title : failed ? 'MISSION FAILED' : 'MISSION COMPLETE';
    title.style.cssText = `font:bold 28px sans-serif;margin-bottom:8px;color:${report ? report.titleColor : failed ? '#ff6b6b' : '#7ce2f0'}`;
    panel.appendChild(title);

    const subText = report
      ? report.subtitle
      : failed
        ? t(
            '隊長が行動不能になりました。遮蔽物・リーン・隊員の先行突入を活用してください。',
            'Team Leader incapacitated. Use cover, leaning, and let your squad lead entries.',
          )
        : undefined;
    if (subText) {
      const good = report?.subtitleGood === true;
      const sub = document.createElement('div');
      sub.textContent = subText;
      sub.style.cssText = good
        ? 'font:13px/1.5 sans-serif;color:#c8f4d0;margin-bottom:12px;padding:8px 10px;background:rgba(30,110,60,0.3);border:1px solid #3a8a55;border-radius:4px'
        : 'font:13px/1.5 sans-serif;color:#ffb4b4;margin-bottom:12px;padding:8px 10px;background:rgba(140,30,30,0.3);border:1px solid #944;border-radius:4px';
      panel.appendChild(sub);
    }

    const summary = document.createElement('div');
    summary.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px';
    const score = document.createElement('div');
    score.textContent = report
      ? report.scoreText
      : b.maxPossibleScore > 0
        ? t(`総合スコア ${b.total} / ${b.maxPossibleScore}`, `Total Score ${b.total} / ${b.maxPossibleScore}`)
        : t(`総合スコア ${b.total}`, `Total Score ${b.total}`);
    score.style.cssText = 'font:bold 22px sans-serif';
    const rank = document.createElement('div');
    rank.textContent = report ? report.rankText : failed ? 'FAILED' : `RANK ${b.rank}`;
    rank.style.cssText = `font:bold 30px sans-serif;color:${report ? report.rankColor : failed ? '#ff6b6b' : '#ffd24d'}`;
    summary.append(score, rank);
    panel.appendChild(summary);

    if (reward) {
      panel.appendChild(this.buildProgressionBox(reward));
    }

    const stats: [string, string][] = report?.stats ?? [
      [t('クリアタイム', 'Clear Time'), fmtTime(this.roe.elapsed)],
      [t('逮捕', 'Arrests'), String(b.count('arrest'))],
      [t('証拠回収', 'Evidence Collected'), String(b.count('evidence'))],
      [t('無力化(正当防衛)', 'Neutralized (Authorized)'), String(b.count('neutralize'))],
      [t('民間人保護', 'Civilians Secured'), String(b.count('civilianSecured'))],
      [t('RoE違反', 'RoE Violations'), String(b.violations)],
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
    h.textContent = t('評価内訳', 'Score Breakdown');
    h.style.cssText = 'font:bold 16px sans-serif;margin:14px 0 4px;border-top:1px solid #445;padding-top:10px';
    panel.appendChild(h);
    const entries: { time: number; label: string; points: number; targetId?: string; kind?: string }[] = report?.entries ?? b.entries;
    if (entries.length === 0) {
      const none = document.createElement('div');
      none.textContent = t('(なし)', '(None)');
      panel.appendChild(none);
    }
    for (const e of entries) {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE + ';color:' + (e.points < 0 ? '#ff6b6b' : '#8fe38f');
      const a = document.createElement('span');
      const lbl = e.kind ? tRoeLabel(e.kind, e.label) : e.label;
      a.textContent = e.targetId ? `[${fmtTime(e.time)}] ${lbl} (${e.targetId})` : `[${fmtTime(e.time)}] ${lbl}`;
      const c = document.createElement('span');
      c.textContent = fmtPts(e.points);
      row.append(a, c);
      panel.appendChild(row);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t('リトライ (R / Enter)', 'Retry (R / Enter)');
    btn.style.cssText = 'margin-top:18px;width:100%;padding:10px;font:bold 16px sans-serif;cursor:pointer';
    btn.addEventListener('click', this.retry);
    this.cleanups.push(() => btn.removeEventListener('click', this.retry));
    panel.appendChild(btn);

    const onBackToTitle = this.options?.onBackToTitle;
    if (onBackToTitle) {
      const titleBtn = document.createElement('button');
      titleBtn.type = 'button';
      titleBtn.dataset.action = 'title';
      titleBtn.textContent = t('タイトルへ戻る（モード・広さを選び直す）', 'Back to Title (Change Mode / Map Size)');
      titleBtn.style.cssText = 'margin-top:8px;width:100%;padding:8px;font:14px sans-serif;cursor:pointer';
      const onTitle = (): void => {
        if (!this.disposed) onBackToTitle();
      };
      titleBtn.addEventListener('click', onTitle);
      this.cleanups.push(() => titleBtn.removeEventListener('click', onTitle));
      panel.appendChild(titleBtn);
    }

    // 共有・サポート行（控えめなシードコピー＆Ko-fi）
    const highRank =
      !failed &&
      ((!report && (b.rank === 'S' || b.rank === 'A')) ||
        (report?.subtitleGood === true && /S|A/.test(report.rankText)));
    const shareBar = document.createElement('div');
    shareBar.style.cssText =
      'margin-top:12px;padding-top:10px;border-top:1px solid #2b3540;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap';

    const seedInfo = this.options?.seedShareInfo;
    if (seedInfo) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      const defaultLabel = t(`📋 このシードをコピー (#${seedInfo.seed})`, `📋 Copy Seed URL (#${seedInfo.seed})`);
      copyBtn.textContent = defaultLabel;
      copyBtn.style.cssText =
        'padding:6px 11px;font:12px sans-serif;color:#cfe2f5;background:#1b2633;border:1px solid #3c526b;border-radius:5px;cursor:pointer';
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onCopy = (): void => {
        if (this.disposed) return;
        void copyToClipboard(buildSeedShareUrl(seedInfo)).then((ok) => {
          if (!ok || this.disposed) return;
          copyBtn.textContent = t('✓ シードURLをコピーしました', '✓ Seed URL Copied!');
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (!this.disposed) copyBtn.textContent = defaultLabel;
          }, 2200);
        });
      };
      copyBtn.addEventListener('click', onCopy);
      this.cleanups.push(() => {
        copyBtn.removeEventListener('click', onCopy);
        if (timer) clearTimeout(timer);
      });
      shareBar.appendChild(copyBtn);
    }

    const kofi = document.createElement('a');
    kofi.href = KOFI_URL;
    kofi.target = '_blank';
    kofi.rel = 'noopener noreferrer';
    kofi.textContent = highRank
      ? t('☕ お見事！Ko-fi で制作を応援', '☕ Great run! Support on Ko-fi')
      : t('☕ Ko-fi で応援', '☕ Support on Ko-fi');
    kofi.style.cssText = highRank
      ? 'padding:6px 12px;font:bold 12px sans-serif;color:#ffe6e5;background:rgba(255,94,91,0.18);border:1px solid rgba(255,118,115,0.65);border-radius:5px;text-decoration:none;margin-left:auto'
      : 'padding:6px 11px;font:12px sans-serif;color:rgba(255,204,202,0.88);background:rgba(255,94,91,0.08);border:1px solid rgba(255,118,115,0.32);border-radius:5px;text-decoration:none;margin-left:auto';
    shareBar.appendChild(kofi);
    panel.appendChild(shareBar);

    const stages = this.options?.stages;
    const onSelectStage = this.options?.onSelectStage;
    if (stages && stages.length > 1 && onSelectStage) {
      const stageSection = document.createElement('div');
      stageSection.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid #445';
      const stageTitle = document.createElement('div');
      stageTitle.textContent = t('ステージ選択', 'Select Stage');
      stageTitle.style.cssText = 'font:bold 13px sans-serif;color:#9cb4cc;margin-bottom:8px';
      const stageRow = document.createElement('div');
      stageRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
      const currentId = this.options?.currentStageId;
      const mode = this.options?.mode ?? 'swat';
      for (const stage of stages) {
        const active = stage.id === currentId;
        const locked = !isStageUnlocked(mode, stage.id);
        const reqLv = getStageUnlockLevel(stage.id);
        const sBtn = document.createElement('button');
        sBtn.type = 'button';
        const sName = tStageName(stage.id, stage.name);
        sBtn.textContent = locked
          ? `🔒 ${sName} (Lv.${reqLv})`
          : active
            ? `${sName} ${t('(現在)', '(Current)')}`
            : sName;
        sBtn.title = locked
          ? t(`${mode === 'suspect' ? '容疑者' : 'SWAT'} Lv.${reqLv} で解放`, `Unlocks at ${mode === 'suspect' ? 'Suspect' : 'SWAT'} Lv.${reqLv}`)
          : tStageDesc(stage.id, stage.description ?? stage.name);
        sBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
        sBtn.dataset.stageId = stage.id;
        sBtn.disabled = active || locked;
        sBtn.style.cssText = locked
          ? 'flex:1 1 auto;padding:7px 10px;font:13px sans-serif;color:#78889a;background:#141b24;border:1px dashed #324255;border-radius:4px;cursor:default;opacity:.65'
          : active
            ? 'flex:1 1 auto;padding:7px 10px;font:bold 13px sans-serif;color:#0a121a;background:#56c8d8;border:1px solid #56c8d8;border-radius:4px;cursor:default'
            : 'flex:1 1 auto;padding:7px 10px;font:13px sans-serif;color:#dce6f2;background:#1d2733;border:1px solid #445870;border-radius:4px;cursor:pointer';
        if (!active && !locked) {
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

  private buildProgressionBox(reward: ProgressionReward): HTMLElement {
    const box = document.createElement('div');
    const accent = reward.mode === 'suspect' ? '#ff7b7b' : '#56c8d8';
    box.style.cssText = `margin-bottom:14px;padding:12px 14px;background:#101924;border:1px solid ${reward.leveledUp ? '#ffd24d' : '#2d4159'};border-radius:7px`;

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px';
    const lvWrap = document.createElement('div');
    lvWrap.style.cssText = 'display:flex;align-items:center;gap:8px';
    const modeTag = document.createElement('span');
    modeTag.textContent = reward.mode === 'suspect' ? 'SUSPECT' : 'SWAT';
    modeTag.style.cssText = `font:bold 11px monospace;letter-spacing:.1em;padding:2px 6px;border-radius:3px;color:#0a121a;background:${accent}`;
    const lvText = document.createElement('span');
    lvText.textContent = reward.leveledUp ? `Lv.${reward.prevLevel} → Lv.${reward.newLevel}` : `Lv.${reward.newLevel}`;
    lvText.style.cssText = 'font:bold 16px sans-serif;color:#f4f8fc';
    lvWrap.append(modeTag, lvText);
    if (reward.leveledUp) {
      const badge = document.createElement('span');
      badge.textContent = '★ LEVEL UP!';
      badge.style.cssText =
        'font:bold 12px monospace;padding:2px 8px;border-radius:999px;background:#ffd24d;color:#0a121a;letter-spacing:.06em';
      lvWrap.appendChild(badge);
    }

    const xpGain = document.createElement('span');
    xpGain.textContent = `+${reward.xpGained} XP`;
    xpGain.style.cssText = 'font:bold 15px monospace;color:#8ff0a8';
    head.append(lvWrap, xpGain);
    box.appendChild(head);

    const prevProg = xpProgressInLevel(reward.prevXp);
    const newProg = xpProgressInLevel(reward.newXp);
    const startPct = reward.leveledUp ? 0 : Math.round(prevProg.ratio * 100);
    const endPct = Math.round(newProg.ratio * 100);

    const track = document.createElement('div');
    track.style.cssText = 'height:8px;background:rgba(255,255,255,.1);border-radius:4px;overflow:hidden';
    const fill = document.createElement('div');
    fill.style.cssText = `height:100%;width:${startPct}%;background:${reward.leveledUp ? '#ffd24d' : accent};border-radius:4px;transition:width .7s ease-out`;
    track.appendChild(fill);
    box.appendChild(track);
    requestAnimationFrame(() => {
      if (!this.disposed) fill.style.width = `${endPct}%`;
    });

    const sub = document.createElement('div');
    sub.style.cssText = 'margin-top:4px;font:12px monospace;color:#9bb2c9;display:flex;justify-content:space-between';
    sub.textContent = newProg.isMax
      ? t(`総 XP: ${reward.newXp} — MAX LEVEL`, `Total XP: ${reward.newXp} — MAX LEVEL`)
      : t(
          `次のレベルまで ${newProg.current} / ${newProg.required} XP (総 ${reward.newXp})`,
          `Next level: ${newProg.current} / ${newProg.required} XP (Total ${reward.newXp})`,
        );
    box.appendChild(sub);

    if (reward.unlockedItems.length > 0) {
      const unlockBox = document.createElement('div');
      unlockBox.style.cssText =
        'margin-top:10px;padding:8px 10px;background:rgba(255,210,77,.1);border:1px solid rgba(255,210,77,.45);border-radius:5px';
      const uTitle = document.createElement('div');
      uTitle.textContent = t('🔓 新規解放アイテム', '🔓 NEW UNLOCKS');
      uTitle.style.cssText = 'font:bold 12px sans-serif;color:#ffd24d;margin-bottom:5px;letter-spacing:.05em';
      unlockBox.appendChild(uTitle);
      const ul = document.createElement('div');
      ul.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px';
      for (const item of reward.unlockedItems) {
        const chip = document.createElement('span');
        chip.textContent = `✦ ${isEn() ? item.labelEn : item.labelJa}`;
        chip.style.cssText =
          'font:bold 12px sans-serif;padding:3px 8px;border-radius:4px;background:rgba(255,210,77,.18);color:#fff2bd;border:1px solid rgba(255,210,77,.4)';
        ul.appendChild(chip);
      }
      unlockBox.appendChild(ul);
      box.appendChild(unlockBox);
    }

    return box;
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
