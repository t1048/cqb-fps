import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/core/Audio';
import {
  extractEnglishQuote,
  extractSpokenQuote,
  heatForLine,
  phoneProsody,
  phoneSpeechBudgetMs,
  utterancesForLines,
} from '../../src/core/phoneVoice';

describe('negotiation phone voice', () => {
  it('extracts the quoted line and leaves narration out', () => {
    expect(extractSpokenQuote('犯人「もう我慢ならねえ！」 — 銃声が響いた')).toBe('もう我慢ならねえ！');
    expect(extractSpokenQuote('Suspect: "I\'ve had enough!" — A gunshot rings out.')).toBe("I've had enough!");
    expect(extractSpokenQuote('緊張 +15')).toBeNull();
    expect(extractEnglishQuote('交渉人「こちらは警察だ」')).toBeNull();
    expect(extractEnglishQuote('Negotiator: "Let\'s talk first."')).toBe("Let's talk first.");
  });

  it('speaks the english voice even when the subtitle is japanese', () => {
    expect(heatForLine('suspect', 'Who is this?! Come any closer and I shoot the hostages!')).toBe('shout');
    expect(heatForLine('suspect', "...Alright. Don't try anything funny.")).toBe('strained');
    expect(heatForLine('suspect', "Don't push your luck. Nobody's leaving.")).toBe('raised');
    expect(heatForLine('negotiator', '...Understood, it takes time to arrange. Hold tight.')).toBe('steady');
    expect(heatForLine('negotiator', 'Cut it out!')).toBe('raised');

    const swat = utterancesForLines(
      [
        {
          text: '犯人「誰だ！ 近づいたら人質を撃つぞ！」',
          tone: 'them',
          voice: 'Who is this?! Come any closer and I shoot the hostages!',
        },
        { text: '状況: 人質 2 名', tone: 'info' },
        {
          text: '仲間「おい、切り札を手放してどうする……」',
          tone: 'bad',
          voice: 'Hey, why are you giving up our leverage...?',
        },
      ],
      { me: 'negotiator', them: 'suspect' },
    );
    expect(swat).toEqual([
      {
        role: 'suspect',
        text: 'Who is this?! Come any closer and I shoot the hostages!',
        heat: 'shout',
      },
    ]);

    const suspectMode = utterancesForLines(
      [
        {
          text: 'あなた「人質を 1 人解放する」',
          tone: 'me',
          voice: "I'll release one hostage. In return, give me Body Armor.",
        },
        {
          text: '交渉人「……わかった、手配に時間がかかる。少し待ってくれ」',
          tone: 'them',
          voice: '...Understood, it takes time to arrange. Hold tight.',
        },
      ],
      { me: 'suspect', them: 'negotiator' },
    );
    expect(suspectMode.map((u) => u.role)).toEqual(['suspect', 'negotiator']);
    expect(suspectMode[0]!.heat).toBe('raised');
    expect(suspectMode[1]!.heat).toBe('steady');
    expect(suspectMode.every((u) => !/[\u3040-\u30ff\u4e00-\u9faf]/.test(u.text))).toBe(true);
  });

  it('does not read a japanese subtitle that has no english line', () => {
    expect(
      utterancesForLines(
        [{ text: '交渉人「こちらは警察だ。建物は完全に包囲されている」', tone: 'them' }],
        { me: 'suspect', them: 'negotiator' },
      ),
    ).toEqual([]);
  });

  it('keeps the negotiator calmer and slower than an agitated suspect', () => {
    const calm = phoneProsody('negotiator', 'steady');
    const firm = phoneProsody('negotiator', 'raised');
    const strained = phoneProsody('suspect', 'strained');
    const raised = phoneProsody('suspect', 'raised');
    const shout = phoneProsody('suspect', 'shout');

    for (const p of [calm, firm, strained, raised, shout]) {
      expect(p.pitch).toBeGreaterThanOrEqual(0.75);
      expect(p.pitch).toBeLessThanOrEqual(1.5);
      expect(p.rate).toBeGreaterThanOrEqual(0.8);
      expect(p.rate).toBeLessThanOrEqual(1.45);
      expect(p.volume).toBeGreaterThan(0);
      expect(p.volume).toBeLessThanOrEqual(1);
    }
    expect(calm.pitch).toBeLessThan(raised.pitch);
    expect(calm.rate).toBeLessThan(raised.rate);
    expect(calm.volume).toBeLessThan(raised.volume);
    expect(firm.rate).toBeGreaterThan(calm.rate);
    expect(firm.pitch).toBeLessThan(shout.pitch);
    expect(strained.rate).toBeLessThan(raised.rate);
    expect(shout.pitch).toBeGreaterThanOrEqual(1.3);
    expect(shout.rate).toBeGreaterThanOrEqual(1.25);
    expect(shout.volume).toBeGreaterThanOrEqual(0.9);

    const short = phoneSpeechBudgetMs('Hold tight.', 1);
    const long = phoneSpeechBudgetMs(
      'The building is completely surrounded. Come out in 10 minutes or we breach.',
      0.94,
    );
    expect(short).toBeGreaterThanOrEqual(2800);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(22000);
  });
});

describe('AudioEngine phone line', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses an english voice even when a japanese voice is installed', () => {
    const spoken: { lang: string; text: string; voiceLang?: string; pitch: number; rate: number }[] = [];
    class FakeUtterance {
      lang = '';
      voice: { lang: string } | null = null;
      pitch = 1;
      rate = 1;
      volume = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('window', {
      speechSynthesis: {
        getVoices: () => [
          { lang: 'ja-JP', name: 'Japanese' },
          { lang: 'en-US', name: 'English' },
        ],
        cancel: () => {},
        speak: (u: FakeUtterance) => {
          spoken.push({ lang: u.lang, text: u.text, voiceLang: u.voice?.lang, pitch: u.pitch, rate: u.rate });
          u.onend?.();
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    });

    const audio = new AudioEngine();
    audio.playPhoneLine('negotiator', 'This is the police. The building is surrounded. Let\'s talk first.', 'steady');
    audio.playPhoneLine('suspect', 'Who is this?! Come any closer and I shoot the hostages!', 'shout');
    audio.cancelPhoneLine();
    audio.dispose();

    expect(spoken.map((u) => u.lang)).toEqual(['en-US', 'en-US']);
    expect(spoken.map((u) => u.voiceLang)).toEqual(['en-US', 'en-US']);
    expect(spoken[0]!.pitch).toBeLessThan(spoken[1]!.pitch);
    expect(spoken[0]!.rate).toBeLessThan(spoken[1]!.rate);
    expect(spoken[1]!.text).toContain('Who is this?!');
  });
});
