export type Locale = 'ja' | 'en';

export interface GameSettings {
  /** マウス感度倍率 (0.25 - 3.00, 既定 1.0) */
  mouseSensitivity: number;
  /** Y 軸反転 */
  invertY: boolean;
  /** マスター音量 (0.0 - 1.0, 既定 1.0) */
  masterVolume: number;
  /** ミュート */
  muted: boolean;
  /** アンビエントオクルージョン (GTAO) 有効 */
  aoEnabled: boolean;
  /** リアルタイムシャドウ有効 */
  shadowsEnabled: boolean;
  /** UI・無線字幕の表示言語 */
  language: Locale;
}

const STORAGE_KEY = 'cqb.settings.v1';

export function detectDefaultLocale(): Locale {
  if (
    typeof window !== 'undefined' &&
    typeof window.navigator !== 'undefined' &&
    typeof window.navigator.language === 'string'
  ) {
    return window.navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  }
  return 'ja';
}

export function createDefaultSettings(): GameSettings {
  return {
    mouseSensitivity: 1.0,
    invertY: false,
    masterVolume: 1.0,
    muted: false,
    aoEnabled: true,
    shadowsEnabled: true,
    language: detectDefaultLocale(),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}

function sanitize(raw: unknown, fallback: GameSettings): GameSettings {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const obj = raw as Record<string, unknown>;
  const mouseSensitivity =
    typeof obj.mouseSensitivity === 'number'
      ? Math.round(clamp(obj.mouseSensitivity, 0.25, 3.0) * 100) / 100
      : fallback.mouseSensitivity;
  const invertY = typeof obj.invertY === 'boolean' ? obj.invertY : fallback.invertY;
  const masterVolume =
    typeof obj.masterVolume === 'number'
      ? Math.round(clamp(obj.masterVolume, 0, 1) * 100) / 100
      : fallback.masterVolume;
  const muted = typeof obj.muted === 'boolean' ? obj.muted : fallback.muted;
  const aoEnabled = typeof obj.aoEnabled === 'boolean' ? obj.aoEnabled : fallback.aoEnabled;
  const shadowsEnabled = typeof obj.shadowsEnabled === 'boolean' ? obj.shadowsEnabled : fallback.shadowsEnabled;
  const language: Locale =
    obj.language === 'ja' || obj.language === 'en' ? obj.language : fallback.language;
  return { mouseSensitivity, invertY, masterVolume, muted, aoEnabled, shadowsEnabled, language };
}

type Listener = (settings: Readonly<GameSettings>, prev: Readonly<GameSettings>) => void;

let current: GameSettings | null = null;
const listeners = new Set<Listener>();

function loadFromStorage(): GameSettings {
  const defaults = createDefaultSettings();
  try {
    if (typeof window === 'undefined' || !window.localStorage) return defaults;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    return sanitize(JSON.parse(raw), defaults);
  } catch {
    return defaults;
  }
}

function saveToStorage(settings: GameSettings): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // プライベートモードやストレージ制限時はメモリ保持のみ
  }
}

function syncDocumentLang(lang: Locale): void {
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = lang;
    }
  } catch {
    // noop
  }
}

export function getSettings(): Readonly<GameSettings> {
  if (!current) {
    current = loadFromStorage();
    syncDocumentLang(current.language);
  }
  return current;
}

export function updateSettings(patch: Partial<GameSettings>): Readonly<GameSettings> {
  const prev = { ...getSettings() };
  const next = sanitize({ ...prev, ...patch }, createDefaultSettings());
  current = next;
  saveToStorage(next);
  if (next.language !== prev.language) {
    syncDocumentLang(next.language);
  }
  for (const fn of listeners) fn(next, prev);
  return next;
}

export function resetSettings(): Readonly<GameSettings> {
  const prev = { ...getSettings() };
  const defaults = createDefaultSettings();
  // 言語だけはリセットしても現在の選択を維持するほうが親切
  defaults.language = prev.language;
  current = defaults;
  saveToStorage(defaults);
  for (const fn of listeners) fn(defaults, prev);
  return defaults;
}

export function subscribeSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** テスト用: 内部キャッシュをクリアしてストレージから再読込させる */
export function _resetSettingsCacheForTest(): void {
  current = null;
  listeners.clear();
}
