import { getSettings, subscribeSettings } from '../core/Settings';

/**
 * タイトル画面の音: 緊張感のある BGM、パトカーのサイレン、遠くのヘリ、無線の交信、街の環境音。
 * すべて Web Audio で合成する（音声ファイルは使わない）。
 * ブラウザの自動再生制限があるため、最初のクリック / キー入力で鳴り始める。
 * 銃声はゲーム本編と同じ AudioEngine が鳴らす。
 */

const BPM = 96;
const BEAT = 60 / BPM;
const STEP = BEAT / 4; // 16 分
const LOOKAHEAD_SEC = 0.25;
const SCHED_MS = 40;

const midiHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

// D マイナー。1 小節 = 16 ステップ。ベースは 8 分の刻み（-1 = 休符）
const BASS_BARS: number[][] = [
  [38, -1, 38, 38, -1, 38, 41, -1, 38, -1, 38, 38, -1, 36, -1, 33],
  [38, -1, 38, 38, -1, 38, 41, -1, 43, -1, 41, 38, -1, 36, -1, 36],
  [34, -1, 34, 34, -1, 34, 38, -1, 34, -1, 34, 34, -1, 36, -1, 38],
  [33, -1, 33, 33, -1, 33, 36, -1, 37, -1, 37, 37, -1, 40, -1, 37],
];
// 2 小節ごとのパッド（Dm / Bb / Gm / A）
const PAD_CHORDS: number[][] = [
  [50, 53, 57],
  [46, 50, 53],
  [43, 46, 50],
  [45, 49, 52],
];
const KICK = [1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0];
const SNARE = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1];

interface Siren {
  lfo: OscillatorNode;
  depth: GainNode;
  base: number;
  mode: 'wail' | 'yelp';
  nextSwitch: number;
}

export class TitleAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly sirens: Siren[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextStepTime = 0;
  private step = 0;
  private nextChatter = 0;
  private disposed = false;
  private readonly unsubSettings: () => void;
  /** 鳴り始めたとき（UI の「クリックで音声 ON」表示を消す） */
  onStarted: (() => void) | null = null;

  constructor() {
    window.addEventListener('pointerdown', this.onGesture, true);
    window.addEventListener('keydown', this.onGesture, true);
    window.addEventListener('touchstart', this.onGesture, true);
    this.unsubSettings = subscribeSettings(() => this.applyVolume());
  }

  get started(): boolean {
    return this.ctx !== null;
  }

  private readonly onGesture = (): void => {
    this.start();
  };

  private detachGesture(): void {
    window.removeEventListener('pointerdown', this.onGesture, true);
    window.removeEventListener('keydown', this.onGesture, true);
    window.removeEventListener('touchstart', this.onGesture, true);
  }

  private targetVolume(): number {
    const s = getSettings();
    return s.muted ? 0 : 0.75 * s.masterVolume;
  }

  private applyVolume(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.targetVolume(), this.ctx.currentTime, 0.08);
  }

  start(): void {
    if (this.disposed || this.ctx) return;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    this.detachGesture();
    this.ctx = ctx;
    void ctx.resume().catch(() => {});

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.setTargetAtTime(this.targetVolume(), ctx.currentTime, 0.9); // フェードイン
    this.master.connect(comp).connect(ctx.destination);
    this.music = ctx.createGain();
    this.music.gain.value = 0.55;
    this.music.connect(this.master);

    // 2 秒分のホワイトノイズ（環境音・打楽器・無線の素材）
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.buildAmbience();
    this.buildSirens();
    this.buildDrone();

    this.nextStepTime = ctx.currentTime + 0.3;
    this.nextChatter = ctx.currentTime + 2.5;
    this.timer = setInterval(this.schedule, SCHED_MS);
    this.onStarted?.();
  }

  // ---------- 常時鳴っている音 ----------

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random();
    src.start();
    this.sources.push(src);
    return src;
  }

  private buildAmbience(): void {
    const ctx = this.ctx!;
    // 街のざわめき・風
    const rumble = this.loopNoise();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const g = ctx.createGain();
    g.gain.value = 0.16;
    rumble.connect(lp).connect(g).connect(this.master!);

    // 上空を旋回するヘリ（ローターの断続音）
    const heli = this.loopNoise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = 520;
    const chop = ctx.createGain();
    chop.gain.value = 0;
    const rotor = ctx.createOscillator();
    rotor.type = 'square';
    rotor.frequency.value = 15.5;
    const rotorDepth = ctx.createGain();
    rotorDepth.gain.value = 0.5;
    rotor.connect(rotorDepth).connect(chop.gain);
    const offset = ctx.createConstantSource();
    offset.offset.value = 0.5;
    offset.connect(chop.gain);
    const heliGain = ctx.createGain();
    heliGain.gain.value = 0.11;
    // ゆっくり近づいたり離れたりする
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.045;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 0.06;
    swell.connect(swellDepth).connect(heliGain.gain);
    const pan = ctx.createStereoPanner();
    const panLfo = ctx.createOscillator();
    panLfo.frequency.value = 0.03;
    const panDepth = ctx.createGain();
    panDepth.gain.value = 0.7;
    panLfo.connect(panDepth).connect(pan.pan);
    heli.connect(bp).connect(chop).connect(heliGain).connect(pan).connect(this.master!);
    for (const o of [rotor, offset, swell, panLfo]) {
      o.start();
      this.sources.push(o);
    }
  }

  private buildSirens(): void {
    const ctx = this.ctx!;
    const make = (panPos: number, gain: number, cutoff: number, base: number, mode: Siren['mode'], delay: number): void => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = base;
      const lfo = ctx.createOscillator();
      lfo.type = 'triangle';
      const depth = ctx.createGain();
      lfo.connect(depth).connect(osc.frequency);
      // ホーンの鳴りを帯域通過で、距離感をローパスで
      const horn = ctx.createBiquadFilter();
      horn.type = 'bandpass';
      horn.frequency.value = 1150;
      horn.Q.value = 0.9;
      const far = ctx.createBiquadFilter();
      far.type = 'lowpass';
      far.frequency.value = cutoff;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(gain, ctx.currentTime + delay, 1.2);
      const p = ctx.createStereoPanner();
      p.pan.value = panPos;
      osc.connect(horn).connect(far).connect(g).connect(p).connect(this.master!);
      osc.start(ctx.currentTime + delay);
      lfo.start(ctx.currentTime + delay);
      this.sources.push(osc, lfo);
      const s: Siren = { lfo, depth, base, mode, nextSwitch: ctx.currentTime + delay + 6 + Math.random() * 6 };
      this.setSirenMode(s, mode, ctx.currentTime);
      this.sirens.push(s);
    };
    make(-0.65, 0.05, 2600, 980, 'wail', 0);
    make(0.7, 0.045, 2300, 1040, 'yelp', 1.7);
    make(0.15, 0.025, 1100, 900, 'wail', 3.4); // 遠くから駆けつける応援
  }

  private setSirenMode(s: Siren, mode: Siren['mode'], at: number): void {
    s.mode = mode;
    // wail: 約 4 秒周期の大きなうねり / yelp: 速い上下
    s.lfo.frequency.setTargetAtTime(mode === 'wail' ? 0.24 : 3.1, at, 0.15);
    s.depth.gain.setTargetAtTime(mode === 'wail' ? s.base * 0.42 : s.base * 0.3, at, 0.15);
  }

  private buildDrone(): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    lp.Q.value = 3;
    const cutLfo = ctx.createOscillator();
    cutLfo.frequency.value = 0.07;
    const cutDepth = ctx.createGain();
    cutDepth.gain.value = 70;
    cutLfo.connect(cutDepth).connect(lp.frequency);
    const g = ctx.createGain();
    g.gain.value = 0.16;
    lp.connect(g).connect(this.music!);
    for (const [hz, det] of [
      [midiHz(26), 0],
      [midiHz(26), 9],
      [midiHz(33), -6],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      o.detune.value = det;
      o.connect(lp);
      o.start();
      this.sources.push(o);
    }
    cutLfo.start();
    this.sources.push(cutLfo);
  }

  // ---------- 拍に合わせて鳴らす音 ----------

  private readonly schedule = (): void => {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    while (this.nextStepTime < ctx.currentTime + LOOKAHEAD_SEC) {
      this.playStep(this.step, this.nextStepTime);
      this.nextStepTime += STEP;
      this.step++;
    }
    for (const s of this.sirens) {
      if (ctx.currentTime >= s.nextSwitch) {
        this.setSirenMode(s, s.mode === 'wail' ? 'yelp' : 'wail', ctx.currentTime);
        s.nextSwitch = ctx.currentTime + (s.mode === 'yelp' ? 3 + Math.random() * 3 : 7 + Math.random() * 7);
      }
    }
    if (ctx.currentTime >= this.nextChatter) {
      this.radioChatter(ctx.currentTime + 0.05);
      this.nextChatter = ctx.currentTime + 6 + Math.random() * 7;
    }
  };

  private playStep(step: number, t: number): void {
    const inBar = step % 16;
    const bar = Math.floor(step / 16);
    // 最初の 2 小節はドローンとベースだけ → 打楽器が入る
    const section = bar % 16;
    const drums = bar >= 2;
    const full = bar >= 4 && section !== 15;

    const bassNote = BASS_BARS[bar % BASS_BARS.length]![inBar]!;
    if (bassNote >= 0) this.bass(midiHz(bassNote), t, inBar % 4 === 0 ? 1 : 0.75);
    if (drums && KICK[inBar]) this.kick(t);
    if (full && SNARE[inBar]) this.snare(t, inBar === 15 ? 0.5 : 1);
    if (drums) this.hat(t, inBar % 4 === 2 ? 1 : 0.45);
    if (inBar === 0 && bar % 2 === 0) {
      this.pad(PAD_CHORDS[(bar / 2) % PAD_CHORDS.length]!, t, BEAT * 8);
    }
    // 16 小節ごとの締め: 上昇するノイズ
    if (section === 15 && inBar === 0) this.riser(t, BEAT * 4);
  }

  private bass(hz: number, t: number, vel: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = hz;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(180, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + STEP * 1.8);
    o.connect(f).connect(g).connect(this.music!);
    o.start(t);
    o.stop(t + STEP * 2);
  }

  private kick(t: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(this.music!);
    o.start(t);
    o.stop(t + 0.35);
  }

  private noiseHit(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }

  private snare(t: number, vel: number): void {
    this.noiseHit(t, 0.2, 'bandpass', 1900, 0.8, 0.5 * vel, this.music!);
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(this.music!);
    o.start(t);
    o.stop(t + 0.14);
  }

  private hat(t: number, vel: number): void {
    this.noiseHit(t, 0.045, 'highpass', 7500, 0.7, 0.12 * vel, this.music!);
  }

  private pad(notes: number[], t: number, dur: number): void {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(500, t);
    f.frequency.linearRampToValueAtTime(1300, t + dur * 0.5);
    f.frequency.linearRampToValueAtTime(600, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.8);
    g.gain.setValueAtTime(0.05, t + dur - 0.6);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    f.connect(g).connect(this.music!);
    for (const n of notes) {
      for (const det of [-8, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiHz(n);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    }
  }

  private riser(t: number, dur: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2.5;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(6000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + dur * 0.95);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.music!);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** 警察無線: 開始ビープ → 帯域を絞った「声」の断片 → スケルチ */
  private radioChatter(t: number): void {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0.45;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 1.2 - 0.6;
    out.connect(p).connect(this.master!);

    const beep = ctx.createOscillator();
    beep.frequency.value = 1320;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.08, t);
    bg.gain.setValueAtTime(0.0001, t + 0.09);
    beep.connect(bg).connect(out);
    beep.start(t);
    beep.stop(t + 0.1);

    // 音節ごとに音程と音量が揺れる、こもった声
    const syll = 5 + Math.floor(Math.random() * 7);
    let at = t + 0.16;
    for (let i = 0; i < syll; i++) {
      const d = 0.08 + Math.random() * 0.14;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 700 + Math.random() * 1400;
      f1.Q.value = 4;
      const voice = ctx.createOscillator();
      voice.type = 'sawtooth';
      voice.frequency.value = 110 + Math.random() * 60;
      const vf = ctx.createBiquadFilter();
      vf.type = 'bandpass';
      vf.frequency.value = 1000 + Math.random() * 800;
      vf.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + d);
      src.connect(f1).connect(g);
      voice.connect(vf).connect(g);
      g.connect(out);
      src.start(at, Math.random());
      src.stop(at + d + 0.02);
      voice.start(at);
      voice.stop(at + d + 0.02);
      at += d + (Math.random() < 0.25 ? 0.18 : 0.03);
    }
    this.noiseHit(at, 0.12, 'highpass', 2500, 0.5, 0.06, out);
  }

  /** 画面を離れるとき: 短くフェードアウトしてから止める */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachGesture();
    this.unsubSettings();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
    setTimeout(() => {
      for (const s of this.sources) {
        try {
          s.stop();
        } catch {
          // 停止済み
        }
      }
      void ctx.close().catch(() => {});
    }, 700);
  }
}
