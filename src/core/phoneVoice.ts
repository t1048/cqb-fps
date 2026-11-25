/** 突入前交渉の通話ボイス。引用・役・熱量と、TTS に渡す話速・音高。 */

export type CallRole = 'negotiator' | 'suspect';
export type CallHeat = 'steady' | 'strained' | 'raised' | 'shout';

export interface CallCast {
  me: CallRole;
  them: CallRole;
}

export interface DialogueLine {
  text: string;
  tone: 'me' | 'them' | 'good' | 'bad' | 'info';
  /** 表示言語に関係なく読み上げる英語台詞 */
  voice?: string;
}

export interface PhoneUtterance {
  role: CallRole;
  text: string;
  heat: CallHeat;
}

export interface PhoneProsody {
  pitch: number;
  rate: number;
  volume: number;
  baseHz: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 「」または "..." の中だけ。地の文や話者名は含めない。 */
export function extractSpokenQuote(text: string): string | null {
  const ja = /「([^」]+)」/.exec(text);
  if (ja?.[1]?.trim()) return ja[1].trim();
  const en = /"([^"]+)"/.exec(text);
  if (en?.[1]?.trim()) return en[1].trim();
  return null;
}

/** 英語の "..." だけ。日本語 UI の字幕を英語 TTS に読ませない。 */
export function extractEnglishQuote(text: string): string | null {
  const en = /"([^"]+)"/.exec(text);
  const quote = en?.[1]?.trim();
  return quote || null;
}

/**
 * 容疑者は ! で叫び、先頭の間で言いよどむ。それ以外は語気を荒げる。
 * 交渉人は低く落ち着き、! があるときだけ少し強める。
 */
export function heatForLine(role: CallRole, quote: string): CallHeat {
  const excited = /[！!]/.test(quote);
  if (role === 'negotiator') return excited ? 'raised' : 'steady';
  if (excited) return 'shout';
  if (/^(?:…|\.\.\.)/.test(quote)) return 'strained';
  return 'raised';
}

/**
 * me / them の英語台詞だけ。`voice` を優先し、無ければ英文の引用を使う。
 * 結果行や仲間のセリフ、日本語だけの字幕は読まない。
 */
export function utterancesForLines(lines: readonly DialogueLine[], cast: CallCast): PhoneUtterance[] {
  const out: PhoneUtterance[] = [];
  for (const line of lines) {
    if (line.tone !== 'me' && line.tone !== 'them') continue;
    const quote = line.voice?.trim() || extractEnglishQuote(line.text);
    if (!quote) continue;
    const role = cast[line.tone];
    out.push({ role, text: quote, heat: heatForLine(role, quote) });
  }
  return out;
}

/** 英語 TTS に渡す話速・音高・音量。プロシージャル声の基本周波数も同じ表。 */
export function phoneProsody(role: CallRole, heat: CallHeat): PhoneProsody {
  if (role === 'negotiator') {
    if (heat === 'raised' || heat === 'shout') {
      return { pitch: 0.96, rate: 1.05, volume: 0.62, baseHz: 128 };
    }
    return { pitch: 0.9, rate: 0.94, volume: 0.55, baseHz: 116 };
  }
  if (heat === 'shout') return { pitch: 1.38, rate: 1.32, volume: 0.98, baseHz: 188 };
  if (heat === 'strained') return { pitch: 1.05, rate: 1.02, volume: 0.72, baseHz: 146 };
  return { pitch: 1.18, rate: 1.2, volume: 0.84, baseHz: 164 };
}

/** 読みの長さ。日本語は文字数、英語は語数を音節の目安にする。 */
export function phoneSyllableCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 3;
  const script = trimmed.match(/[\u3040-\u30ff\u4e00-\u9faf]/g);
  const compactLen = trimmed.replace(/\s/g, '').length;
  if (script && script.length >= compactLen * 0.4) return clamp(script.length, 2, 16);
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return clamp(Math.max(words, Math.round(compactLen / 4)), 2, 16);
}

/** onend が来ない環境でも次の台詞に進むまでの上限。英語の読みを途中で切らない。 */
export function phoneSpeechBudgetMs(text: string, rate: number): number {
  const chars = Math.max(1, text.trim().length);
  const seconds = chars / 12 / clamp(rate, 0.5, 2);
  return clamp(Math.round(seconds * 1000 + 1600), 2800, 22000);
}
