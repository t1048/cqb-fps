import { getSettings, resetSettings, subscribeSettings, updateSettings, type GameSettings, type Locale } from '../core/Settings';
import { t } from '../core/i18n';
import { buildSeedShareUrl, copyToClipboard, KOFI_URL, type SeedShareInfo } from './shareLinks';

export type PauseMenuMode = 'pause' | 'settings';

export interface PauseMenuOptions {
  onResume: () => void;
  onRetry: () => void;
  onBackToBriefing: () => void;
  onCloseSettings?: () => void;
  seedInfo?: SeedShareInfo;
}

const STYLE_ID = 'cqb-pause-menu-style';

const CSS = `
.cqb-pause-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(8, 12, 18, 0.72);
  backdrop-filter: blur(6px);
  color: #eef3f8;
  font-family: 'Hiragino Sans', 'Yu Gothic UI', 'Segoe UI', system-ui, sans-serif;
  user-select: none;
}
.cqb-pause-backdrop.open {
  display: flex;
}
.cqb-pause-card {
  width: min(460px, 100%);
  max-height: 92vh;
  overflow-y: auto;
  background: linear-gradient(180deg, rgba(18, 25, 36, 0.96), rgba(12, 17, 25, 0.98));
  border: 1px solid rgba(148, 180, 214, 0.24);
  border-radius: 10px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
  padding: 20px 22px 16px;
}
.cqb-pause-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.cqb-pause-title {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #f4f8fc;
}
.cqb-pause-sub {
  font-size: 11px;
  letter-spacing: 0.06em;
  color: rgba(200, 218, 236, 0.65);
}
.cqb-pause-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}
.cqb-pause-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #eef3f8;
  font: inherit;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, transform 0.08s;
}
.cqb-pause-btn:hover {
  background: rgba(255, 255, 255, 0.13);
  border-color: rgba(255, 255, 255, 0.32);
}
.cqb-pause-btn.primary {
  background: linear-gradient(180deg, #2d73b8, #1f5a94);
  border-color: rgba(130, 195, 255, 0.55);
  color: #fff;
}
.cqb-pause-btn.primary:hover {
  background: linear-gradient(180deg, #3784cf, #2669aa);
}
.cqb-pause-row-btns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.cqb-pause-section {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.cqb-pause-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.cqb-pause-section-title {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(176, 206, 236, 0.78);
}
.cqb-pause-reset {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 4px;
  color: rgba(220, 232, 245, 0.72);
  font: inherit;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
.cqb-pause-reset:hover {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.35);
}
.cqb-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  font-size: 13px;
}
.cqb-setting-label {
  color: rgba(235, 242, 249, 0.9);
  white-space: nowrap;
}
.cqb-setting-ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 205px;
  justify-content: flex-end;
}
.cqb-setting-range {
  width: 130px;
  accent-color: #4aa3ff;
  cursor: pointer;
}
.cqb-setting-val {
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: #9ed0ff;
  font-weight: 700;
}
.cqb-toggle-btn {
  padding: 4px 10px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(230, 238, 246, 0.85);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.cqb-toggle-btn.active {
  background: rgba(58, 138, 214, 0.35);
  border-color: rgba(110, 188, 255, 0.75);
  color: #fff;
}
.cqb-toggle-btn.warn {
  background: rgba(214, 72, 72, 0.32);
  border-color: rgba(255, 120, 120, 0.7);
  color: #ffd7d7;
}
.cqb-seg {
  display: inline-flex;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 5px;
  overflow: hidden;
}
.cqb-seg button {
  padding: 4px 11px;
  border: none;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(220, 232, 244, 0.75);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.cqb-seg button.active {
  background: #2b73b8;
  color: #fff;
}
.cqb-pause-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;
}
.cqb-foot-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(220, 232, 244, 0.8);
  text-decoration: none;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.cqb-foot-link:hover {
  background: rgba(255, 255, 255, 0.11);
  color: #fff;
}
.cqb-foot-link.kofi {
  border-color: rgba(255, 118, 115, 0.35);
  color: rgba(255, 198, 196, 0.9);
}
.cqb-foot-link.kofi:hover {
  background: rgba(255, 94, 91, 0.2);
  border-color: rgba(255, 118, 115, 0.7);
  color: #fff;
}
`;

export class PauseMenu {
  private readonly root: HTMLDivElement;
  private readonly opts: PauseMenuOptions;
  private mode: PauseMenuMode = 'pause';
  private visible = false;
  private unsubSettings: (() => void) | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly titleEl: HTMLHeadingElement;
  private readonly subEl: HTMLSpanElement;
  private readonly pauseActionsEl: HTMLDivElement;
  private readonly settingsCloseEl: HTMLDivElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly retryBtn: HTMLButtonElement;
  private readonly briefingBtn: HTMLButtonElement;
  private readonly closeSettingsBtn: HTMLButtonElement;

  private readonly settingsHeadingEl: HTMLSpanElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly sensLabelEl: HTMLSpanElement;
  private readonly sensInput: HTMLInputElement;
  private readonly sensValEl: HTMLSpanElement;
  private readonly invertLabelEl: HTMLSpanElement;
  private readonly invertBtn: HTMLButtonElement;
  private readonly volLabelEl: HTMLSpanElement;
  private readonly volInput: HTMLInputElement;
  private readonly volValEl: HTMLSpanElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly aoLabelEl: HTMLSpanElement;
  private readonly aoBtn: HTMLButtonElement;
  private readonly shadowLabelEl: HTMLSpanElement;
  private readonly shadowBtn: HTMLButtonElement;
  private readonly langLabelEl: HTMLSpanElement;
  private readonly langJaBtn: HTMLButtonElement;
  private readonly langEnBtn: HTMLButtonElement;

  private readonly footEl: HTMLDivElement;
  private readonly copySeedBtn: HTMLButtonElement | null = null;
  private readonly kofiLink: HTMLAnchorElement;

  constructor(container: HTMLElement, opts: PauseMenuOptions) {
    this.opts = opts;
    this.injectStyle();

    this.root = document.createElement('div');
    this.root.className = 'cqb-pause-backdrop';
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === this.root && this.mode === 'settings') {
        this.closeSettings();
      }
    });

    const card = document.createElement('div');
    card.className = 'cqb-pause-card';
    this.root.appendChild(card);

    // Header
    const head = document.createElement('div');
    head.className = 'cqb-pause-head';
    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'cqb-pause-title';
    this.subEl = document.createElement('span');
    this.subEl.className = 'cqb-pause-sub';
    head.append(this.titleEl, this.subEl);
    card.appendChild(head);

    // Pause actions
    this.pauseActionsEl = document.createElement('div');
    this.pauseActionsEl.className = 'cqb-pause-actions';
    this.resumeBtn = document.createElement('button');
    this.resumeBtn.type = 'button';
    this.resumeBtn.className = 'cqb-pause-btn primary';
    this.resumeBtn.addEventListener('click', () => this.opts.onResume());

    const rowBtns = document.createElement('div');
    rowBtns.className = 'cqb-pause-row-btns';
    this.retryBtn = document.createElement('button');
    this.retryBtn.type = 'button';
    this.retryBtn.className = 'cqb-pause-btn';
    this.retryBtn.addEventListener('click', () => this.opts.onRetry());

    this.briefingBtn = document.createElement('button');
    this.briefingBtn.type = 'button';
    this.briefingBtn.className = 'cqb-pause-btn';
    this.briefingBtn.addEventListener('click', () => this.opts.onBackToBriefing());

    rowBtns.append(this.retryBtn, this.briefingBtn);
    this.pauseActionsEl.append(this.resumeBtn, rowBtns);
    card.appendChild(this.pauseActionsEl);

    // Settings section
    const sec = document.createElement('div');
    sec.className = 'cqb-pause-section';
    const secHead = document.createElement('div');
    secHead.className = 'cqb-pause-section-head';
    this.settingsHeadingEl = document.createElement('span');
    this.settingsHeadingEl.className = 'cqb-pause-section-title';
    this.resetBtn = document.createElement('button');
    this.resetBtn.type = 'button';
    this.resetBtn.className = 'cqb-pause-reset';
    this.resetBtn.addEventListener('click', () => resetSettings());
    secHead.append(this.settingsHeadingEl, this.resetBtn);
    sec.appendChild(secHead);

    // Mouse sensitivity
    const sensRow = this.makeRow();
    this.sensLabelEl = sensRow.label;
    this.sensInput = document.createElement('input');
    this.sensInput.type = 'range';
    this.sensInput.className = 'cqb-setting-range';
    this.sensInput.min = '0.25';
    this.sensInput.max = '3.00';
    this.sensInput.step = '0.05';
    this.sensInput.addEventListener('input', () => {
      updateSettings({ mouseSensitivity: Number(this.sensInput.value) });
    });
    this.sensValEl = document.createElement('span');
    this.sensValEl.className = 'cqb-setting-val';
    sensRow.ctrl.append(this.sensInput, this.sensValEl);
    sec.appendChild(sensRow.row);

    // Invert Y
    const invertRow = this.makeRow();
    this.invertLabelEl = invertRow.label;
    this.invertBtn = document.createElement('button');
    this.invertBtn.type = 'button';
    this.invertBtn.className = 'cqb-toggle-btn';
    this.invertBtn.addEventListener('click', () => {
      updateSettings({ invertY: !getSettings().invertY });
    });
    invertRow.ctrl.append(this.invertBtn);
    sec.appendChild(invertRow.row);

    // Volume + Mute
    const volRow = this.makeRow();
    this.volLabelEl = volRow.label;
    this.volInput = document.createElement('input');
    this.volInput.type = 'range';
    this.volInput.className = 'cqb-setting-range';
    this.volInput.min = '0';
    this.volInput.max = '100';
    this.volInput.step = '5';
    this.volInput.addEventListener('input', () => {
      const val = Number(this.volInput.value) / 100;
      updateSettings({ masterVolume: val, muted: val <= 0 ? true : false });
    });
    this.volValEl = document.createElement('span');
    this.volValEl.className = 'cqb-setting-val';
    this.muteBtn = document.createElement('button');
    this.muteBtn.type = 'button';
    this.muteBtn.className = 'cqb-toggle-btn';
    this.muteBtn.addEventListener('click', () => {
      updateSettings({ muted: !getSettings().muted });
    });
    volRow.ctrl.append(this.volInput, this.volValEl, this.muteBtn);
    sec.appendChild(volRow.row);

    // AO
    const aoRow = this.makeRow();
    this.aoLabelEl = aoRow.label;
    this.aoBtn = document.createElement('button');
    this.aoBtn.type = 'button';
    this.aoBtn.className = 'cqb-toggle-btn';
    this.aoBtn.addEventListener('click', () => {
      updateSettings({ aoEnabled: !getSettings().aoEnabled });
    });
    aoRow.ctrl.append(this.aoBtn);
    sec.appendChild(aoRow.row);

    // Shadows
    const shadowRow = this.makeRow();
    this.shadowLabelEl = shadowRow.label;
    this.shadowBtn = document.createElement('button');
    this.shadowBtn.type = 'button';
    this.shadowBtn.className = 'cqb-toggle-btn';
    this.shadowBtn.addEventListener('click', () => {
      updateSettings({ shadowsEnabled: !getSettings().shadowsEnabled });
    });
    shadowRow.ctrl.append(this.shadowBtn);
    sec.appendChild(shadowRow.row);

    // Language
    const langRow = this.makeRow();
    this.langLabelEl = langRow.label;
    const seg = document.createElement('div');
    seg.className = 'cqb-seg';
    this.langJaBtn = document.createElement('button');
    this.langJaBtn.type = 'button';
    this.langJaBtn.textContent = '日本語';
    this.langJaBtn.addEventListener('click', () => this.selectLang('ja'));
    this.langEnBtn = document.createElement('button');
    this.langEnBtn.type = 'button';
    this.langEnBtn.textContent = 'English';
    this.langEnBtn.addEventListener('click', () => this.selectLang('en'));
    seg.append(this.langJaBtn, this.langEnBtn);
    langRow.ctrl.append(seg);
    sec.appendChild(langRow.row);

    card.appendChild(sec);

    // Settings-only close button
    this.settingsCloseEl = document.createElement('div');
    this.settingsCloseEl.className = 'cqb-pause-actions';
    this.closeSettingsBtn = document.createElement('button');
    this.closeSettingsBtn.type = 'button';
    this.closeSettingsBtn.className = 'cqb-pause-btn primary';
    this.closeSettingsBtn.addEventListener('click', () => this.closeSettings());
    this.settingsCloseEl.appendChild(this.closeSettingsBtn);
    card.appendChild(this.settingsCloseEl);

    // Footer (Seed copy + subtle Ko-fi)
    this.footEl = document.createElement('div');
    this.footEl.className = 'cqb-pause-foot';
    if (opts.seedInfo) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cqb-foot-link';
      btn.addEventListener('click', () => {
        if (!this.opts.seedInfo) return;
        const url = buildSeedShareUrl(this.opts.seedInfo);
        void copyToClipboard(url).then((ok) => {
          if (!ok || !this.copySeedBtn) return;
          this.copySeedBtn.textContent = t('✓ シードURLをコピーしました', '✓ Seed URL Copied');
          if (this.copyTimer) clearTimeout(this.copyTimer);
          this.copyTimer = setTimeout(() => this.syncTexts(), 2000);
        });
      });
      this.copySeedBtn = btn;
      this.footEl.appendChild(btn);
    } else {
      this.footEl.appendChild(document.createElement('span'));
    }

    this.kofiLink = document.createElement('a');
    this.kofiLink.className = 'cqb-foot-link kofi';
    this.kofiLink.href = KOFI_URL;
    this.kofiLink.target = '_blank';
    this.kofiLink.rel = 'noopener noreferrer';
    this.footEl.appendChild(this.kofiLink);
    card.appendChild(this.footEl);

    container.appendChild(this.root);

    this.unsubSettings = subscribeSettings((s) => this.syncUI(s));
    this.syncUI(getSettings());
  }

  private selectLang(lang: Locale): void {
    updateSettings({ language: lang });
  }

  private makeRow(): { row: HTMLDivElement; label: HTMLSpanElement; ctrl: HTMLDivElement } {
    const row = document.createElement('div');
    row.className = 'cqb-setting-row';
    const label = document.createElement('span');
    label.className = 'cqb-setting-label';
    const ctrl = document.createElement('div');
    ctrl.className = 'cqb-setting-ctrl';
    row.append(label, ctrl);
    return { row, label, ctrl };
  }

  private injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  get isOpen(): boolean {
    return this.visible;
  }

  get currentMode(): PauseMenuMode {
    return this.mode;
  }

  open(mode: PauseMenuMode = 'pause'): void {
    this.mode = mode;
    this.visible = true;
    this.root.classList.add('open');
    this.syncUI(getSettings());
  }

  hide(): void {
    this.visible = false;
    this.root.classList.remove('open');
  }

  private closeSettings(): void {
    this.hide();
    this.opts.onCloseSettings?.();
  }

  private syncTexts(): void {
    const isPause = this.mode === 'pause';
    this.titleEl.textContent = isPause ? t('一時停止', 'PAUSED') : t('設定', 'SETTINGS');
    this.subEl.textContent = isPause ? 'ESC / P' : t('自動保存', 'Auto-saved');
    this.pauseActionsEl.style.display = isPause ? 'flex' : 'none';
    this.settingsCloseEl.style.display = isPause ? 'none' : 'flex';

    this.resumeBtn.textContent = t('▶ ゲームを再開', '▶ Resume');
    this.retryBtn.textContent = t('↻ リトライ', '↻ Retry');
    this.briefingBtn.textContent = t('☰ ブリーフィング', '☰ Briefing');
    this.closeSettingsBtn.textContent = t('閉じる', 'Close');

    this.settingsHeadingEl.textContent = t('基本設定', 'Settings');
    this.resetBtn.textContent = t('初期値', 'Reset');
    this.sensLabelEl.textContent = t('マウス感度', 'Mouse Sensitivity');
    this.invertLabelEl.textContent = t('Y軸反転', 'Invert Y-Axis');
    this.volLabelEl.textContent = t('マスター音量', 'Master Volume');
    this.aoLabelEl.textContent = t('アンビエントオクルージョン (AO)', 'Ambient Occlusion (AO)');
    this.shadowLabelEl.textContent = t('リアルタイム影', 'Shadows');
    this.langLabelEl.textContent = t('言語 / Language', 'Language');

    if (this.copySeedBtn && this.opts.seedInfo) {
      this.copySeedBtn.textContent = t(
        `📋 シードをコピー (#${this.opts.seedInfo.seed})`,
        `📋 Copy Seed (#${this.opts.seedInfo.seed})`,
      );
    }
    this.kofiLink.textContent = t('☕ Ko-fi で支援', '☕ Support on Ko-fi');
  }

  private syncUI(s: Readonly<GameSettings>): void {
    this.syncTexts();

    this.sensInput.value = s.mouseSensitivity.toFixed(2);
    this.sensValEl.textContent = `${s.mouseSensitivity.toFixed(2)}x`;

    this.invertBtn.textContent = s.invertY ? 'ON' : 'OFF';
    this.invertBtn.className = `cqb-toggle-btn${s.invertY ? ' active' : ''}`;

    const volPct = Math.round(s.masterVolume * 100);
    this.volInput.value = String(volPct);
    this.volValEl.textContent = `${volPct}%`;

    this.muteBtn.textContent = s.muted ? t('🔇 ミュート中', '🔇 Muted') : t('🔊 音声あり', '🔊 Sound');
    this.muteBtn.className = `cqb-toggle-btn${s.muted ? ' warn' : ' active'}`;

    this.aoBtn.textContent = s.aoEnabled ? 'ON' : 'OFF';
    this.aoBtn.className = `cqb-toggle-btn${s.aoEnabled ? ' active' : ''}`;

    this.shadowBtn.textContent = s.shadowsEnabled ? 'ON' : 'OFF';
    this.shadowBtn.className = `cqb-toggle-btn${s.shadowsEnabled ? ' active' : ''}`;

    this.langJaBtn.className = s.language === 'ja' ? 'active' : '';
    this.langEnBtn.className = s.language === 'en' ? 'active' : '';
  }

  dispose(): void {
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.unsubSettings?.();
    this.unsubSettings = null;
    this.root.remove();
  }
}
