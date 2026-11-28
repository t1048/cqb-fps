import type { GameMode } from '../modes/SuspectMode';

export const KOFI_URL = 'https://ko-fi.com/t1048';

export interface SeedShareInfo {
  stage: string;
  seed: number;
  mode: GameMode;
}

/** 現在のシード・ステージ・モードを再現する共有 URL を生成する */
export function buildSeedShareUrl(info: SeedShareInfo): string {
  const base =
    typeof window !== 'undefined' && window.location
      ? `${window.location.origin}${window.location.pathname}`
      : 'https://t1048.github.io/cqb-fps/';
  const params = new URLSearchParams();
  params.set('stage', info.stage);
  params.set('seed', String(info.seed));
  if (info.mode === 'suspect') params.set('mode', 'suspect');
  return `${base}?${params.toString()}`;
}

/** クリップボードにテキストをコピーする（フォールバック付き） */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // フォールバックへ
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
