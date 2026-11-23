/**
 * 初回プレイ判定（ブラウザごと）。localStorage が使えない環境では毎回「初回」扱いにならないよう、
 * 同一ページ内ではメモリ上のフラグでも既読を保持する。
 */
export type FirstRunKey = 'negotiation' | 'squad';

const PREFIX = 'cqb.tour.';
const VERSION = '.v1';
const memory = new Set<FirstRunKey>();

export function isFirstRun(key: FirstRunKey): boolean {
  if (memory.has(key)) return false;
  try {
    return window.localStorage.getItem(PREFIX + key + VERSION) === null;
  } catch {
    return true;
  }
}

export function markSeen(key: FirstRunKey): void {
  memory.add(key);
  try {
    window.localStorage.setItem(PREFIX + key + VERSION, '1');
  } catch {
    // ストレージ不可（プライベートモード等）はメモリ上の既読のみ
  }
}
