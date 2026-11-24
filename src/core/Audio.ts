import type { Vec3 } from './types';

type AudioContextCtor = typeof AudioContext;

interface WindowWithWebkitAudio extends Window {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
}

interface LegacyAudioListener {
  setPosition?: (x: number, y: number, z: number) => void;
  setOrientation?: (
    x: number,
    y: number,
    z: number,
    xUp: number,
    yUp: number,
    zUp: number,
  ) => void;
}

interface LegacyPannerNode {
  setPosition?: (x: number, y: number, z: number) => void;
}

interface ReadyAudioContext {
  ctx: AudioContext;
  masterLowpass: BiquadFilterNode;
  noiseBuffer: AudioBuffer;
}

const UNLOCK_EVENTS = ['pointerdown', 'click', 'keydown'] as const;
const MAX_DT = 0.05;
const EPSILON = 0.0001;
const NOMINAL_LOWPASS_HZ = 20000;
const NOMINAL_MASTER_GAIN = 1.0;
const TINNITUS_FREQ_HZ = 4500;
const MAX_TINNITUS_GAIN = 0.12;
const NOISE_BUFFER_SEC = 2.0;

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

const CELL_VOICE_PROFILES: readonly { pitch: number; rate: number; baseHz: number }[] = [
  { pitch: 0.86, rate: 1.14, baseHz: 126 }, // Red
  { pitch: 1.04, rate: 1.2, baseHz: 158 }, // Blue
  { pitch: 0.94, rate: 1.16, baseHz: 142 }, // Gold
  { pitch: 0.78, rate: 1.12, baseHz: 118 }, // Green
];

/**
 * 隊員 ID またはセル名（Red/Blue/Gold/Green, swat_N）から無線ボイスの音高・話速・基本周波数を決定する。
 */
export function radioVoiceProfile(allyId: string): { pitch: number; rate: number; baseHz: number } {
  if (allyId === 'ally_miller') return { pitch: 0.85, rate: 1.15, baseHz: 128 };
  if (allyId === 'ally_cole') return { pitch: 1.05, rate: 1.2, baseHz: 162 };

  const cellMatch = /(?:^|[_-\s])(red|blue|gold|green)(?:$|[_-\s0-9])/i.exec(allyId);
  if (cellMatch) {
    const map: Record<string, number> = { red: 0, blue: 1, gold: 2, green: 3 };
    const idx = map[cellMatch[1]!.toLowerCase()] ?? 0;
    return { ...CELL_VOICE_PROFILES[idx]! };
  }

  const swatMatch = /^swat_(\d+)$/i.exec(allyId);
  if (swatMatch) {
    const n = Math.max(0, parseInt(swatMatch[1]!, 10) - 1);
    const base = CELL_VOICE_PROFILES[Math.floor(n / 2) % CELL_VOICE_PROFILES.length]!;
    const member = n % 2;
    return {
      pitch: clamp(Number((base.pitch + member * 0.04).toFixed(3)), 0.75, 1.3),
      rate: clamp(Number((base.rate + member * 0.02).toFixed(3)), 0.95, 1.35),
      baseHz: base.baseHz + member * 8,
    };
  }

  let hash = 0;
  for (let i = 0; i < allyId.length; i++) {
    hash = (hash * 31 + allyId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % CELL_VOICE_PROFILES.length;
  return { ...CELL_VOICE_PROFILES[idx]! };
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function normalizeVec3(v: Vec3, fallback: Vec3): Vec3 {
  if (!isFiniteVec3(v)) return { ...fallback };
  const len = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(len) || len <= 1e-6) return { ...fallback };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Pure Web Audio API procedural sound engine (zero external audio files).
 *
 * - Defers AudioContext creation/resume until a user gesture via `unlock()`.
 * - Guards headless / non-browser environments without throwing.
 * - Routes spatialized SFX through `PannerNode` -> `masterLowpass` -> `masterGain` -> `destination`.
 * - Supports flashbang ear-ringing (master lowpass/gain dip + direct tinnitus sine).
 * - `dispose()` is idempotent and releases all gesture listeners, active nodes, and AudioContext.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterLowpass: BiquadFilterNode | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private unlocked = false;
  private disposed = false;
  private listenersAttached = false;

  private readonly activeCleanups = new Set<() => void>();

  // Cached listener pose (applied immediately when AudioContext unlocks)
  private listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private listenerForward: Vec3 = { x: 0, y: 0, z: -1 };
  private listenerUp: Vec3 = { x: 0, y: 1, z: 0 };

  // Flashbang ear-ringing state
  private ringingElapsed = 0;
  private ringingDuration = 0;
  private ringingIntensity = 0;
  private tinnitusOsc: OscillatorNode | null = null;
  private tinnitusGain: GainNode | null = null;
  private radioSeq = 0;
  private stopAllyRadioEffect: (() => void) | null = null;

  private readonly handleGestureUnlock = (): void => {
    this.unlock();
  };

  constructor() {
    this.attachUnlockListeners();
  }

  public get isUnlocked(): boolean {
    return this.unlocked && !this.disposed;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Lazily creates and/or resumes the AudioContext. Safe to call from user gesture handlers
   * or manually. No-ops gracefully in headless/non-browser environments or after `dispose()`.
   */
  public unlock(): void {
    if (this.disposed) return;

    if (!this.ctx) {
      const Ctor = this.resolveAudioContextCtor();
      if (!Ctor) {
        this.detachUnlockListeners();
        return;
      }

      let ctx: AudioContext;
      try {
        ctx = new Ctor();
      } catch {
        return;
      }

      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = NOMINAL_LOWPASS_HZ;
      lowpass.Q.value = 0.707;

      const gain = ctx.createGain();
      gain.gain.value = NOMINAL_MASTER_GAIN;

      lowpass.connect(gain);
      gain.connect(ctx.destination);

      this.ctx = ctx;
      this.masterLowpass = lowpass;
      this.masterGain = gain;
      this.noiseBuffer = this.createNoiseBuffer(ctx);

      this.applyListenerToContext(ctx);
    }

    if (this.ctx.state === 'running') {
      this.onContextRunning();
      return;
    }

    if (this.ctx.state === 'suspended') {
      try {
        const resumeResult = this.ctx.resume();
        if (resumeResult && typeof resumeResult.then === 'function') {
          resumeResult
            .then(() => {
              if (!this.disposed && this.ctx && this.ctx.state === 'running') {
                this.onContextRunning();
              }
            })
            .catch(() => {
              // Autoplay blocked or context closed; keep gesture listeners attached until next gesture.
            });
        }
      } catch {
        // Ignore resume errors in restricted environments.
      }
    }
  }

  /** Updates 3D AudioListener position and orientation (Three.js right-handed coordinates). */
  public updateListener(pos: Vec3, forward: Vec3, up: Vec3): void {
    if (this.disposed) return;
    if (isFiniteVec3(pos)) {
      this.listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    }
    this.listenerForward = normalizeVec3(forward, { x: 0, y: 0, z: -1 });
    this.listenerUp = normalizeVec3(up, { x: 0, y: 1, z: 0 });
    if (this.ctx) {
      this.applyListenerToContext(this.ctx);
    }
  }

  /**
   * Frame-rate independent update (dt clamped to 0.05s).
   * Smoothly recovers master lowpass, master gain, and tinnitus tone from flash ear-ringing.
   */
  public update(dt: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const clampedDt = Math.min(dt, MAX_DT);
    if (this.ringingDuration <= 0) return;

    this.ringingElapsed += clampedDt;
    if (this.ringingElapsed >= this.ringingDuration) {
      this.ringingElapsed = 0;
      this.ringingDuration = 0;
      this.ringingIntensity = 0;
      this.restoreMasterBus();
      this.stopTinnitus();
      return;
    }

    this.applyEarRingingParams();
  }

  /**
   * Procedural footstep: soft low-frequency thump + short filtered scuff noise.
   * Volume and spatial falloff scale with `radius` (e.g. run=12m vs quiet/crouch=3m).
   */
  public playFootstep(pos: Vec3, radius: number): void {
    if (!isFiniteVec3(pos) || !Number.isFinite(radius)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const intensity = clamp((radius - 2) / 10, 0.18, 1.0);
    const panner = this.createPanner(ctx, pos, Math.max(radius, 3));

    // Low heel thump
    const thumpDur = 0.055 + intensity * 0.045;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95 + intensity * 35, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + thumpDur);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(EPSILON, now);
    oscGain.gain.linearRampToValueAtTime(0.18 * intensity, now + 0.005);
    oscGain.gain.exponentialRampToValueAtTime(EPSILON, now + thumpDur);

    osc.connect(oscGain);
    oscGain.connect(panner);

    // Filtered shoe-floor scuff noise
    const scuffDur = 0.04 + intensity * 0.04;
    const noise = this.createNoiseSource(ctx, noiseBuffer);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900 + intensity * 600, now);
    filter.Q.value = 1.4;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(EPSILON, now);
    noiseGain.gain.linearRampToValueAtTime(0.14 * intensity, now + 0.004);
    noiseGain.gain.exponentialRampToValueAtTime(EPSILON, now + scuffDur);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(panner);

    this.registerVoice([osc, noise], [osc, oscGain, noise, filter, noiseGain, panner]);

    osc.start(now);
    osc.stop(now + thumpDur + 0.01);
    noise.start(now, this.randomNoiseOffset(scuffDur), scuffDur + 0.01);
  }

  /**
   * Procedural wood/hinge door creak using FM pitch-swept bandpass oscillator + friction noise.
   * Pitch, duration, and volume scale with `radius` (e.g. slow=4m vs fast/knob=9m).
   */
  public playDoorCreak(pos: Vec3, radius: number): void {
    if (!isFiniteVec3(pos) || !Number.isFinite(radius)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const speed = clamp((radius - 3) / 7, 0.15, 1.0);
    const duration = 0.28 - speed * 0.11;
    const panner = this.createPanner(ctx, pos, Math.max(radius, 4));

    // FM-modulated hinge creak
    const carrier = ctx.createOscillator();
    carrier.type = 'sawtooth';
    const baseFreq = 230 + speed * 140;
    carrier.frequency.setValueAtTime(baseFreq, now);
    carrier.frequency.exponentialRampToValueAtTime(baseFreq * 1.28, now + duration * 0.45);
    carrier.frequency.exponentialRampToValueAtTime(baseFreq * 0.88, now + duration);

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(22 + speed * 24, now);

    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(42 + speed * 36, now);

    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const creakFilter = ctx.createBiquadFilter();
    creakFilter.type = 'bandpass';
    creakFilter.frequency.setValueAtTime(680 + speed * 420, now);
    creakFilter.Q.value = 4.2;

    const creakGain = ctx.createGain();
    const creakPeak = 0.11 + speed * 0.13;
    creakGain.gain.setValueAtTime(EPSILON, now);
    creakGain.gain.linearRampToValueAtTime(creakPeak, now + 0.02);
    creakGain.gain.exponentialRampToValueAtTime(EPSILON, now + duration);

    carrier.connect(creakFilter);
    creakFilter.connect(creakGain);
    creakGain.connect(panner);

    // Subtle wood friction noise
    const noise = this.createNoiseSource(ctx, noiseBuffer);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1100 + speed * 500, now);
    noiseFilter.Q.value = 2.0;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(EPSILON, now);
    noiseGain.gain.linearRampToValueAtTime(0.05 + speed * 0.07, now + 0.015);
    noiseGain.gain.exponentialRampToValueAtTime(EPSILON, now + duration);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(panner);

    this.registerVoice(
      [carrier, mod, noise],
      [carrier, mod, modGain, creakFilter, creakGain, noise, noiseFilter, noiseGain, panner],
    );

    carrier.start(now);
    carrier.stop(now + duration + 0.01);
    mod.start(now);
    mod.stop(now + duration + 0.01);
    noise.start(now, this.randomNoiseOffset(duration), duration + 0.01);
  }

  /**
   * 一人称リロードの機械音（自分の手元なので非空間化）。
   * - `out`: 弾倉リリース（軽いクリック＋擦れ）
   * - `in`: 弾倉を叩き込む（低めの打撃＋金属クリック）
   * - `rack`: チャージングハンドル（2 段のスライド音）
   * - `click`: 弾倉の無い装備の装填音
   */
  public playReload(kind: 'out' | 'in' | 'rack' | 'click'): void {
    const ready = this.getReadyContext();
    if (!ready) return;
    const { ctx, masterLowpass, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.55;
    out.connect(masterLowpass);
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [out];
    const click = (t: number, freq: number, gain: number, dur: number): void => {
      const n = this.createNoiseSource(ctx, noiseBuffer);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = 3.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(EPSILON, now + t);
      g.gain.linearRampToValueAtTime(gain, now + t + 0.002);
      g.gain.exponentialRampToValueAtTime(EPSILON, now + t + dur);
      n.connect(f);
      f.connect(g);
      g.connect(out);
      n.start(now + t, this.randomNoiseOffset(dur), dur + 0.01);
      sources.push(n);
      nodes.push(n, f, g);
    };
    const thump = (t: number, freq: number, gain: number, dur: number): void => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(freq, now + t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.5, now + t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(EPSILON, now + t);
      g.gain.linearRampToValueAtTime(gain, now + t + 0.003);
      g.gain.exponentialRampToValueAtTime(EPSILON, now + t + dur);
      o.connect(g);
      g.connect(out);
      o.start(now + t);
      o.stop(now + t + dur + 0.01);
      sources.push(o);
      nodes.push(o, g);
    };
    if (kind === 'out') {
      click(0, 3200, 0.22, 0.03);
      click(0.03, 1400, 0.08, 0.09);
    } else if (kind === 'in') {
      thump(0, 180, 0.2, 0.07);
      click(0, 2400, 0.3, 0.035);
      click(0.04, 4200, 0.16, 0.02);
    } else if (kind === 'rack') {
      click(0, 1800, 0.18, 0.06);
      click(0.12, 2600, 0.3, 0.04);
      thump(0.12, 240, 0.1, 0.05);
    } else {
      click(0, 2800, 0.2, 0.03);
      click(0.06, 1600, 0.1, 0.05);
    }
    this.registerVoice(sources, nodes);
  }

  /**
   * Radius-differentiated procedural gunshot:
   * - `radius >= 25` (rifle=40 / smg=30): sharp transient crack + low punch + decaying tail.
   * - `10 <= radius < 25` (pepperball=15): pneumatic pop/thump.
   * - `radius < 10` (taser=6): brief high-frequency electric buzz/zap.
   */
  public playGunshot(pos: Vec3, radius: number): void {
    if (!isFiniteVec3(pos) || !Number.isFinite(radius)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    if (radius >= 25) {
      this.playFirearmShot(ready, pos, radius);
    } else if (radius >= 10) {
      this.playPneumaticShot(ready, pos, radius);
    } else {
      this.playTaserZap(ready, pos, radius);
    }
  }

  /**
   * Procedural heavy door kick / breach: deep sub-bass thump + wood splinter noise burst.
   */
  public playBreach(pos: Vec3, radius: number): void {
    if (!isFiniteVec3(pos) || !Number.isFinite(radius)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, Math.max(radius, 12));

    // Deep sub-bass door kick thump
    const thumpDur = 0.2;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(125, now);
    sub.frequency.exponentialRampToValueAtTime(32, now + thumpDur);

    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(EPSILON, now);
    subGain.gain.linearRampToValueAtTime(0.75, now + 0.004);
    subGain.gain.exponentialRampToValueAtTime(EPSILON, now + thumpDur);

    sub.connect(subGain);
    subGain.connect(panner);

    // Wood splinter noise body
    const splinterDur = 0.26;
    const splinter = this.createNoiseSource(ctx, noiseBuffer);
    const splinterFilter = ctx.createBiquadFilter();
    splinterFilter.type = 'bandpass';
    splinterFilter.frequency.setValueAtTime(980, now);
    splinterFilter.frequency.exponentialRampToValueAtTime(360, now + splinterDur);
    splinterFilter.Q.value = 1.2;

    const splinterGain = ctx.createGain();
    splinterGain.gain.setValueAtTime(EPSILON, now);
    splinterGain.gain.linearRampToValueAtTime(0.6, now + 0.005);
    splinterGain.gain.exponentialRampToValueAtTime(EPSILON, now + splinterDur);

    splinter.connect(splinterFilter);
    splinterFilter.connect(splinterGain);
    splinterGain.connect(panner);

    // Sharp lock/frame snap
    const snapDur = 0.085;
    const snap = this.createNoiseSource(ctx, noiseBuffer);
    const snapFilter = ctx.createBiquadFilter();
    snapFilter.type = 'highpass';
    snapFilter.frequency.setValueAtTime(1850, now);

    const snapGain = ctx.createGain();
    snapGain.gain.setValueAtTime(EPSILON, now);
    snapGain.gain.linearRampToValueAtTime(0.36, now + 0.002);
    snapGain.gain.exponentialRampToValueAtTime(EPSILON, now + snapDur);

    snap.connect(snapFilter);
    snapFilter.connect(snapGain);
    snapGain.connect(panner);

    this.registerVoice(
      [sub, splinter, snap],
      [
        sub,
        subGain,
        splinter,
        splinterFilter,
        splinterGain,
        snap,
        snapFilter,
        snapGain,
        panner,
      ],
    );

    sub.start(now);
    sub.stop(now + thumpDur + 0.01);
    splinter.start(now, this.randomNoiseOffset(splinterDur), splinterDur + 0.01);
    snap.start(now, this.randomNoiseOffset(snapDur), snapDur + 0.01);
  }

  /**
   * Procedural flashbang detonation: intense concussive bang (sharp impulse + decaying boom).
   */
  public playFlashbang(pos: Vec3, radius: number): void {
    if (!isFiniteVec3(pos) || !Number.isFinite(radius)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, Math.max(radius, 30));

    // Sharp impulse crack
    const crackDur = 0.065;
    const crack = this.createNoiseSource(ctx, noiseBuffer);
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'highpass';
    crackFilter.frequency.setValueAtTime(1100, now);

    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(EPSILON, now);
    crackGain.gain.linearRampToValueAtTime(0.85, now + 0.0015);
    crackGain.gain.exponentialRampToValueAtTime(EPSILON, now + crackDur);

    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(panner);

    // Wide-spectrum decaying concussive boom
    const boomDur = 0.65;
    const boom = this.createNoiseSource(ctx, noiseBuffer);
    const boomFilter = ctx.createBiquadFilter();
    boomFilter.type = 'lowpass';
    boomFilter.frequency.setValueAtTime(3600, now);
    boomFilter.frequency.exponentialRampToValueAtTime(180, now + boomDur);

    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(EPSILON, now);
    boomGain.gain.linearRampToValueAtTime(0.7, now + 0.004);
    boomGain.gain.exponentialRampToValueAtTime(EPSILON, now + boomDur);

    boom.connect(boomFilter);
    boomFilter.connect(boomGain);
    boomGain.connect(panner);

    // Concussive sub pressure punch
    const punchDur = 0.34;
    const punch = ctx.createOscillator();
    punch.type = 'sine';
    punch.frequency.setValueAtTime(145, now);
    punch.frequency.exponentialRampToValueAtTime(28, now + punchDur);

    const punchGain = ctx.createGain();
    punchGain.gain.setValueAtTime(EPSILON, now);
    punchGain.gain.linearRampToValueAtTime(0.75, now + 0.003);
    punchGain.gain.exponentialRampToValueAtTime(EPSILON, now + punchDur);

    punch.connect(punchGain);
    punchGain.connect(panner);

    this.registerVoice(
      [crack, boom, punch],
      [
        crack,
        crackFilter,
        crackGain,
        boom,
        boomFilter,
        boomGain,
        punch,
        punchGain,
        panner,
      ],
    );

    crack.start(now, this.randomNoiseOffset(crackDur), crackDur + 0.01);
    boom.start(now, this.randomNoiseOffset(boomDur), boomDur + 0.01);
    punch.start(now);
    punch.stop(now + punchDur + 0.01);
  }

  /**
   * Procedural C2 charge arming beep (high-pitched tactical electronic pulse).
   * `urgent = true` shifts pitch upward and sharpens attack for imminent detonation.
   */
  public playC2Beep(pos: Vec3, urgent: boolean): void {
    if (!isFiniteVec3(pos)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const { ctx } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, 18);

    const dur = urgent ? 0.045 : 0.055;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(urgent ? 2650 : 1850, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(EPSILON, now);
    gain.gain.linearRampToValueAtTime(urgent ? 0.3 : 0.22, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(EPSILON, now + dur);

    osc.connect(gain);
    gain.connect(panner);

    this.registerVoice([osc], [osc, gain, panner]);

    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  /**
   * Procedural C2 breaching blast: deep sub-bass shockwave + concussive lowpass boom + wood/frame debris crack.
   */
  public playC2Blast(pos: Vec3, radius: number): void {
    if (!isFiniteVec3(pos) || !Number.isFinite(radius)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, Math.max(radius, 35));

    // Sub-bass shockwave
    const subDur = 0.45;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(140, now);
    sub.frequency.exponentialRampToValueAtTime(24, now + subDur);

    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(EPSILON, now);
    subGain.gain.linearRampToValueAtTime(0.85, now + 0.003);
    subGain.gain.exponentialRampToValueAtTime(EPSILON, now + subDur);

    sub.connect(subGain);
    subGain.connect(panner);

    // Concussive blast body
    const boomDur = 0.72;
    const boom = this.createNoiseSource(ctx, noiseBuffer);

    const boomFilter = ctx.createBiquadFilter();
    boomFilter.type = 'lowpass';
    boomFilter.frequency.setValueAtTime(3000, now);
    boomFilter.frequency.exponentialRampToValueAtTime(140, now + boomDur);

    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(EPSILON, now);
    boomGain.gain.linearRampToValueAtTime(0.78, now + 0.004);
    boomGain.gain.exponentialRampToValueAtTime(EPSILON, now + boomDur);

    boom.connect(boomFilter);
    boomFilter.connect(boomGain);
    boomGain.connect(panner);

    // Door frame / wood debris crack
    const crackDur = 0.18;
    const crack = this.createNoiseSource(ctx, noiseBuffer);

    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'highpass';
    crackFilter.frequency.setValueAtTime(1300, now);

    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(EPSILON, now);
    crackGain.gain.linearRampToValueAtTime(0.52, now + 0.002);
    crackGain.gain.exponentialRampToValueAtTime(EPSILON, now + crackDur);

    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(panner);

    this.registerVoice(
      [sub, boom, crack],
      [sub, subGain, boom, boomFilter, boomGain, crack, crackFilter, crackGain, panner],
    );

    sub.start(now);
    sub.stop(now + subDur + 0.01);
    boom.start(now, this.randomNoiseOffset(boomDur), boomDur + 0.01);
    crack.start(now, this.randomNoiseOffset(crackDur), crackDur + 0.01);
  }

  /**
   * Procedural heavy tactical SWAT boot footstep:
   * - Deeper low-end boot impact + sole scuff + optional heavy gear rattle.
   */
  public playSwatFootstep(pos: Vec3, heavy: boolean): void {
    if (!isFiniteVec3(pos)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, heavy ? 16 : 12);

    const thumpDur = heavy ? 0.095 : 0.075;
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(heavy ? 78 : 86, now);
    thump.frequency.exponentialRampToValueAtTime(heavy ? 30 : 36, now + thumpDur);

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(EPSILON, now);
    thumpGain.gain.linearRampToValueAtTime(heavy ? 0.3 : 0.22, now + 0.006);
    thumpGain.gain.exponentialRampToValueAtTime(EPSILON, now + thumpDur);

    thump.connect(thumpGain);
    thumpGain.connect(panner);

    const scuffDur = 0.065;
    const scuff = this.createNoiseSource(ctx, noiseBuffer);
    const scuffFilter = ctx.createBiquadFilter();
    scuffFilter.type = 'bandpass';
    scuffFilter.frequency.setValueAtTime(680, now);
    scuffFilter.Q.setValueAtTime(1.1, now);

    const scuffGain = ctx.createGain();
    scuffGain.gain.setValueAtTime(EPSILON, now);
    scuffGain.gain.linearRampToValueAtTime(heavy ? 0.18 : 0.13, now + 0.005);
    scuffGain.gain.exponentialRampToValueAtTime(EPSILON, now + scuffDur);

    scuff.connect(scuffFilter);
    scuffFilter.connect(scuffGain);
    scuffGain.connect(panner);

    const sources: AudioScheduledSourceNode[] = [thump, scuff];
    const nodes: AudioNode[] = [thump, thumpGain, scuff, scuffFilter, scuffGain, panner];

    if (heavy) {
      const gearStart = now + 0.024;
      const gearDur = 0.035;
      const gear = this.createNoiseSource(ctx, noiseBuffer);
      const gearFilter = ctx.createBiquadFilter();
      gearFilter.type = 'bandpass';
      gearFilter.frequency.setValueAtTime(2300, gearStart);
      gearFilter.Q.setValueAtTime(3.0, gearStart);

      const gearGain = ctx.createGain();
      gearGain.gain.setValueAtTime(EPSILON, gearStart);
      gearGain.gain.linearRampToValueAtTime(0.048, gearStart + 0.004);
      gearGain.gain.exponentialRampToValueAtTime(EPSILON, gearStart + gearDur);

      gear.connect(gearFilter);
      gearFilter.connect(gearGain);
      gearGain.connect(panner);

      sources.push(gear);
      nodes.push(gear, gearFilter, gearGain);
      gear.start(gearStart, this.randomNoiseOffset(gearDur), gearDur + 0.01);
    }

    this.registerVoice(sources, nodes);

    thump.start(now);
    thump.stop(now + thumpDur + 0.01);
    scuff.start(now, this.randomNoiseOffset(scuffDur), scuffDur + 0.01);
  }

  /**
   * Procedural CS tear gas canister pop + sustained pressurized gas hiss.
   */
  public playGasHiss(pos: Vec3, radius: number): void {
    if (!isFiniteVec3(pos) || !Number.isFinite(radius) || radius <= 0) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, Math.max(radius * 3, 18));

    // Canister valve pop
    const popDur = 0.06;
    const pop = ctx.createOscillator();
    pop.type = 'sine';
    pop.frequency.setValueAtTime(220, now);
    pop.frequency.exponentialRampToValueAtTime(85, now + popDur);

    const popGain = ctx.createGain();
    popGain.gain.setValueAtTime(EPSILON, now);
    popGain.gain.linearRampToValueAtTime(0.26, now + 0.004);
    popGain.gain.exponentialRampToValueAtTime(EPSILON, now + popDur);

    pop.connect(popGain);
    popGain.connect(panner);

    // Valve burst
    const burstDur = 0.055;
    const burst = this.createNoiseSource(ctx, noiseBuffer);
    const burstFilter = ctx.createBiquadFilter();
    burstFilter.type = 'bandpass';
    burstFilter.frequency.setValueAtTime(1400, now);
    burstFilter.Q.setValueAtTime(1.4, now);

    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(EPSILON, now);
    burstGain.gain.linearRampToValueAtTime(0.22, now + 0.005);
    burstGain.gain.exponentialRampToValueAtTime(EPSILON, now + burstDur);

    burst.connect(burstFilter);
    burstFilter.connect(burstGain);
    burstGain.connect(panner);

    // Sustained pressurized gas hiss
    const hissDur = 2.1;
    const hiss = this.createNoiseSource(ctx, noiseBuffer);
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.setValueAtTime(2600, now);
    hissFilter.frequency.exponentialRampToValueAtTime(1700, now + hissDur);
    hissFilter.Q.setValueAtTime(1.2, now);

    const hissGain = ctx.createGain();
    hissGain.gain.setValueAtTime(EPSILON, now);
    hissGain.gain.linearRampToValueAtTime(0.24, now + 0.04);
    hissGain.gain.exponentialRampToValueAtTime(EPSILON, now + hissDur);

    hiss.connect(hissFilter);
    hissFilter.connect(hissGain);
    hissGain.connect(panner);

    this.registerVoice(
      [pop, burst, hiss],
      [pop, popGain, burst, burstFilter, burstGain, hiss, hissFilter, hissGain, panner],
    );

    pop.start(now);
    pop.stop(now + popDur + 0.01);
    burst.start(now, this.randomNoiseOffset(burstDur), burstDur + 0.01);
    hiss.start(now, this.randomNoiseOffset(hissDur), hissDur + 0.01);
  }

  /**
   * Procedural two-burst dry cough (CS gas / pepper exposure).
   */
  public playCough(pos: Vec3): void {
    if (!isFiniteVec3(pos)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, 14);

    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [panner];
    const bursts: [number, number, number][] = [
      [0, 0.22, 0.14],
      [0.145, 0.18, 0.11],
    ];

    for (const [offset, airPeak, glottalPeak] of bursts) {
      const t0 = now + offset;
      const dur = 0.11;

      const air = this.createNoiseSource(ctx, noiseBuffer);
      const airFilter = ctx.createBiquadFilter();
      airFilter.type = 'bandpass';
      airFilter.frequency.setValueAtTime(950, t0);
      airFilter.Q.setValueAtTime(2.2, t0);

      const airGain = ctx.createGain();
      airGain.gain.setValueAtTime(EPSILON, t0);
      airGain.gain.linearRampToValueAtTime(airPeak, t0 + 0.015);
      airGain.gain.exponentialRampToValueAtTime(EPSILON, t0 + dur);

      air.connect(airFilter);
      airFilter.connect(airGain);
      airGain.connect(panner);

      const glottal = ctx.createOscillator();
      glottal.type = 'sawtooth';
      glottal.frequency.setValueAtTime(145, t0);
      glottal.frequency.exponentialRampToValueAtTime(92, t0 + dur);

      const glottalFilter = ctx.createBiquadFilter();
      glottalFilter.type = 'bandpass';
      glottalFilter.frequency.setValueAtTime(640, t0);
      glottalFilter.Q.setValueAtTime(3.5, t0);

      const glottalGain = ctx.createGain();
      glottalGain.gain.setValueAtTime(EPSILON, t0);
      glottalGain.gain.linearRampToValueAtTime(glottalPeak, t0 + 0.012);
      glottalGain.gain.exponentialRampToValueAtTime(EPSILON, t0 + dur);

      glottal.connect(glottalFilter);
      glottalFilter.connect(glottalGain);
      glottalGain.connect(panner);

      sources.push(air, glottal);
      nodes.push(air, airFilter, airGain, glottal, glottalFilter, glottalGain);

      air.start(t0, this.randomNoiseOffset(dur), dur + 0.01);
      glottal.start(t0);
      glottal.stop(t0 + dur + 0.01);
    }

    this.registerVoice(sources, nodes);
  }

  /**
   * Procedural tactical warning shout / radio-squelch burst:
   * brief radio squelch click + formant-filtered two-syllable command cadence + tail click.
   */
  public playWarningCall(pos: Vec3): void {
    if (!isFiniteVec3(pos)) return;
    const ready = this.getReadyContext();
    if (!ready) return;

    const speech = this.resolveEnglishSpeech();
    if (speech) {
      this.cancelAllyRadio();
      try {
        speech.synth.cancel();
      } catch {
        // Ignore speechSynthesis cancel errors.
      }
      const lines = [
        'Police! Drop the weapon!',
        'Police! Hands up!',
        'Drop the gun! Get on the ground!',
        'SWAT! Hands up now!',
      ];
      const utter = new SpeechSynthesisUtterance(lines[Math.floor(Math.random() * lines.length)]!);
      utter.voice = speech.voice;
      utter.lang = 'en-US';
      utter.pitch = 0.82;
      utter.rate = 1.22;
      utter.volume = 0.85;
      try {
        speech.synth.speak(utter);
        return;
      } catch {
        // Fallback to procedural warning call below.
      }
    }

    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, 25);

    // Leading radio squelch click
    const leadDur = 0.032;
    const leadSquelch = this.createNoiseSource(ctx, noiseBuffer);
    const leadFilter = ctx.createBiquadFilter();
    leadFilter.type = 'bandpass';
    leadFilter.frequency.setValueAtTime(2400, now);
    leadFilter.Q.value = 3.0;

    const leadGain = ctx.createGain();
    leadGain.gain.setValueAtTime(EPSILON, now);
    leadGain.gain.linearRampToValueAtTime(0.18, now + 0.003);
    leadGain.gain.exponentialRampToValueAtTime(EPSILON, now + leadDur);

    leadSquelch.connect(leadFilter);
    leadFilter.connect(leadGain);
    leadGain.connect(panner);

    // Formant-filtered two-syllable command cadence
    const voiceStart = now + 0.038;
    const voiceDur = 0.30;
    const voiceEnd = voiceStart + voiceDur;

    const voiceOsc = ctx.createOscillator();
    voiceOsc.type = 'sawtooth';
    voiceOsc.frequency.setValueAtTime(155, voiceStart);
    voiceOsc.frequency.linearRampToValueAtTime(188, voiceStart + 0.09);
    voiceOsc.frequency.setValueAtTime(170, voiceStart + 0.14);
    voiceOsc.frequency.linearRampToValueAtTime(132, voiceEnd);

    const formant1 = ctx.createBiquadFilter();
    formant1.type = 'bandpass';
    formant1.frequency.setValueAtTime(720, voiceStart);
    formant1.Q.value = 4.5;

    const formant2 = ctx.createBiquadFilter();
    formant2.type = 'bandpass';
    formant2.frequency.setValueAtTime(1650, voiceStart);
    formant2.Q.value = 5.5;

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(EPSILON, voiceStart);
    // Syllable 1
    voiceGain.gain.linearRampToValueAtTime(0.24, voiceStart + 0.02);
    voiceGain.gain.linearRampToValueAtTime(0.03, voiceStart + 0.12);
    // Syllable 2
    voiceGain.gain.linearRampToValueAtTime(0.22, voiceStart + 0.16);
    voiceGain.gain.exponentialRampToValueAtTime(EPSILON, voiceEnd);

    voiceOsc.connect(formant1);
    voiceOsc.connect(formant2);
    formant1.connect(voiceGain);
    formant2.connect(voiceGain);
    voiceGain.connect(panner);

    // Trailing radio squelch click
    const tailStart = voiceEnd + 0.015;
    const tailDur = 0.028;
    const tailSquelch = this.createNoiseSource(ctx, noiseBuffer);
    const tailFilter = ctx.createBiquadFilter();
    tailFilter.type = 'bandpass';
    tailFilter.frequency.setValueAtTime(2100, tailStart);
    tailFilter.Q.value = 3.2;

    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(EPSILON, tailStart);
    tailGain.gain.linearRampToValueAtTime(0.14, tailStart + 0.003);
    tailGain.gain.exponentialRampToValueAtTime(EPSILON, tailStart + tailDur);

    tailSquelch.connect(tailFilter);
    tailFilter.connect(tailGain);
    tailGain.connect(panner);

    this.registerVoice(
      [leadSquelch, voiceOsc, tailSquelch],
      [
        leadSquelch,
        leadFilter,
        leadGain,
        voiceOsc,
        formant1,
        formant2,
        voiceGain,
        tailSquelch,
        tailFilter,
        tailGain,
        panner,
      ],
    );

    leadSquelch.start(now, this.randomNoiseOffset(leadDur), leadDur + 0.005);
    voiceOsc.start(voiceStart);
    voiceOsc.stop(voiceEnd + 0.01);
    tailSquelch.start(tailStart, this.randomNoiseOffset(tailDur), tailDur + 0.005);
  }

  /**
   * 容疑者拘束・民間人確保時の無線報告 SE（非空間、頭内無線）。
   * 英語ボイスが利用可能なら無線ノイズ付きで報告し、無ければ帯域制限フォルマント合成を鳴らす。
   */
  public playRadioReport(kind: 'suspect' | 'civilian' = 'suspect'): void {
    const ready = this.getReadyContext();
    if (!ready) return;

    const lines =
      kind === 'civilian'
        ? ['TOC, civilian secure.', 'Entry team to TOC, hostage is safe.']
        : ['TOC, suspect in custody.', 'Entry team to TOC, suspect restrained.'];
    const line = lines[Math.floor(Math.random() * lines.length)]!;
    if (this.speakEnglishRadio(ready, line, 0.92, 1.15, 0.58)) return;

    this.playRadioTransmission(ready, 4, 142, 0.52);
  }

  /**
   * 仲間隊員の無線ボイス（ノイズあり英語無線エフェクト付き）。
   * speechSynthesis に英語ボイスがあれば発話し、無ければ帯域制限プロシージャルチャッターを鳴らす。
   */
  public playAllyRadio(allyId: string, text: string): void {
    const ready = this.getReadyContext();
    if (!ready) return;

    const { pitch, rate, baseHz } = radioVoiceProfile(allyId);
    if (this.speakEnglishRadio(ready, text, pitch, rate, 0.65)) return;

    const syllables = clamp(Math.round(text.split(/\s+/).length), 3, 5);
    this.playRadioTransmission(ready, syllables, baseHz, 0.14 * syllables + 0.16);
  }

  /**
   * Triggers or extends flashbang ear-ringing:
   * - Drops `masterLowpass.frequency` and `masterGain.gain`, recovering over `durationSec`.
   * - Plays a decaying ~4500Hz tinnitus sine routed directly to `ctx.destination`
   *   (bypassing `masterLowpass`) with safe peak gain (`<= 0.14 * intensity`).
   */
  public triggerEarRinging(intensity: number, durationSec: number): void {
    if (this.disposed) return;
    if (
      !Number.isFinite(intensity) ||
      !Number.isFinite(durationSec) ||
      intensity <= 0 ||
      durationSec <= 0
    ) {
      return;
    }

    const clampedIntensity = clamp(intensity, 0, 1);

    let nextIntensity = clampedIntensity;
    let nextDuration = durationSec;

    if (this.ringingDuration > 0 && this.ringingElapsed < this.ringingDuration) {
      const remainingDuration = this.ringingDuration - this.ringingElapsed;
      const progress = this.ringingElapsed / this.ringingDuration;
      const currentEffective = this.ringingIntensity * (1 - progress);
      nextIntensity = Math.max(currentEffective, clampedIntensity);
      nextDuration = Math.max(remainingDuration, durationSec);
    }

    this.ringingElapsed = 0;
    this.ringingDuration = nextDuration;
    this.ringingIntensity = nextIntensity;

    if (this.ctx && this.unlocked && this.ctx.state === 'running') {
      this.startTinnitus(this.ctx);
      this.applyEarRingingParams();
    }
  }

  /**
   * Idempotently disposes all gesture listeners, active audio nodes, tinnitus oscillator,
   * and closes the underlying AudioContext.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unlocked = false;

    this.detachUnlockListeners();

    this.ringingElapsed = 0;
    this.ringingDuration = 0;
    this.ringingIntensity = 0;
    this.stopTinnitus();
    this.cancelAllyRadio();

    // Stop and disconnect all active procedural voices
    for (const cleanup of Array.from(this.activeCleanups)) {
      cleanup();
    }
    this.activeCleanups.clear();

    if (this.masterLowpass) {
      try {
        this.masterLowpass.disconnect();
      } catch {
        // Ignore disconnect errors on teardown.
      }
      this.masterLowpass = null;
    }

    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {
        // Ignore disconnect errors on teardown.
      }
      this.masterGain = null;
    }

    this.noiseBuffer = null;

    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      if (ctx.state !== 'closed') {
        try {
          const closeResult = ctx.close();
          if (closeResult && typeof closeResult.catch === 'function') {
            closeResult.catch(() => {
              // Ignore close promise rejections.
            });
          }
        } catch {
          // Ignore synchronous close errors.
        }
      }
    }
  }

  // ---------- Internal helpers ----------

  private playFirearmShot(ready: ReadyAudioContext, pos: Vec3, radius: number): void {
    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const heavy = clamp((radius - 25) / 15, 0, 1);
    const panner = this.createPanner(ctx, pos, radius);

    // Sharp transient crack
    const crackDur = 0.045 + heavy * 0.025;
    const crack = this.createNoiseSource(ctx, noiseBuffer);
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'highpass';
    crackFilter.frequency.setValueAtTime(1200 - heavy * 300, now);

    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(EPSILON, now);
    crackGain.gain.linearRampToValueAtTime(0.55 + heavy * 0.2, now + 0.0015);
    crackGain.gain.exponentialRampToValueAtTime(EPSILON, now + crackDur);

    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(panner);

    // Low punch oscillator
    const punchDur = 0.07 + heavy * 0.03;
    const punch = ctx.createOscillator();
    punch.type = 'triangle';
    punch.frequency.setValueAtTime(195 - heavy * 35, now);
    punch.frequency.exponentialRampToValueAtTime(48, now + punchDur);

    const punchGain = ctx.createGain();
    punchGain.gain.setValueAtTime(EPSILON, now);
    punchGain.gain.linearRampToValueAtTime(0.5 + heavy * 0.15, now + 0.002);
    punchGain.gain.exponentialRampToValueAtTime(EPSILON, now + punchDur);

    punch.connect(punchGain);
    punchGain.connect(panner);

    // Decaying filtered noise tail
    const tailDur = 0.18 + heavy * 0.14;
    const tail = this.createNoiseSource(ctx, noiseBuffer);
    const tailFilter = ctx.createBiquadFilter();
    tailFilter.type = 'lowpass';
    tailFilter.frequency.setValueAtTime(1650 - heavy * 350, now);
    tailFilter.frequency.exponentialRampToValueAtTime(280, now + tailDur);

    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(EPSILON, now);
    tailGain.gain.linearRampToValueAtTime(0.28 + heavy * 0.12, now + 0.005);
    tailGain.gain.exponentialRampToValueAtTime(EPSILON, now + tailDur);

    tail.connect(tailFilter);
    tailFilter.connect(tailGain);
    tailGain.connect(panner);

    this.registerVoice(
      [crack, punch, tail],
      [
        crack,
        crackFilter,
        crackGain,
        punch,
        punchGain,
        tail,
        tailFilter,
        tailGain,
        panner,
      ],
    );

    crack.start(now, this.randomNoiseOffset(crackDur), crackDur + 0.01);
    punch.start(now);
    punch.stop(now + punchDur + 0.01);
    tail.start(now, this.randomNoiseOffset(tailDur), tailDur + 0.01);
  }

  private playPneumaticShot(ready: ReadyAudioContext, pos: Vec3, radius: number): void {
    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, radius);

    // Air-burst pop
    const popDur = 0.075;
    const pop = this.createNoiseSource(ctx, noiseBuffer);
    const popFilter = ctx.createBiquadFilter();
    popFilter.type = 'bandpass';
    popFilter.frequency.setValueAtTime(680, now);
    popFilter.Q.value = 1.8;

    const popGain = ctx.createGain();
    popGain.gain.setValueAtTime(EPSILON, now);
    popGain.gain.linearRampToValueAtTime(0.36, now + 0.003);
    popGain.gain.exponentialRampToValueAtTime(EPSILON, now + popDur);

    pop.connect(popFilter);
    popFilter.connect(popGain);
    popGain.connect(panner);

    // Pneumatic thump
    const thumpDur = 0.065;
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(220, now);
    thump.frequency.exponentialRampToValueAtTime(75, now + thumpDur);

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(EPSILON, now);
    thumpGain.gain.linearRampToValueAtTime(0.32, now + 0.003);
    thumpGain.gain.exponentialRampToValueAtTime(EPSILON, now + thumpDur);

    thump.connect(thumpGain);
    thumpGain.connect(panner);

    this.registerVoice([pop, thump], [pop, popFilter, popGain, thump, thumpGain, panner]);

    pop.start(now, this.randomNoiseOffset(popDur), popDur + 0.01);
    thump.start(now);
    thump.stop(now + thumpDur + 0.01);
  }

  private playTaserZap(ready: ReadyAudioContext, pos: Vec3, radius: number): void {
    const { ctx, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, pos, Math.max(radius, 4));
    const duration = 0.14;

    // Electric arc buzz (FM sawtooth)
    const arc = ctx.createOscillator();
    arc.type = 'sawtooth';
    arc.frequency.setValueAtTime(140, now);

    const mod = ctx.createOscillator();
    mod.type = 'square';
    mod.frequency.setValueAtTime(55, now);

    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(95, now);

    mod.connect(modGain);
    modGain.connect(arc.frequency);

    const arcFilter = ctx.createBiquadFilter();
    arcFilter.type = 'highpass';
    arcFilter.frequency.setValueAtTime(950, now);

    const arcGain = ctx.createGain();
    arcGain.gain.setValueAtTime(EPSILON, now);
    arcGain.gain.linearRampToValueAtTime(0.22, now + 0.005);
    arcGain.gain.exponentialRampToValueAtTime(EPSILON, now + duration);

    arc.connect(arcFilter);
    arcFilter.connect(arcGain);
    arcGain.connect(panner);

    // High-frequency spark crackle
    const spark = this.createNoiseSource(ctx, noiseBuffer);
    const sparkFilter = ctx.createBiquadFilter();
    sparkFilter.type = 'bandpass';
    sparkFilter.frequency.setValueAtTime(3400, now);
    sparkFilter.Q.value = 2.4;

    const sparkGain = ctx.createGain();
    sparkGain.gain.setValueAtTime(EPSILON, now);
    sparkGain.gain.linearRampToValueAtTime(0.18, now + 0.004);
    sparkGain.gain.exponentialRampToValueAtTime(EPSILON, now + duration * 0.9);

    spark.connect(sparkFilter);
    sparkFilter.connect(sparkGain);
    sparkGain.connect(panner);

    this.registerVoice(
      [arc, mod, spark],
      [arc, mod, modGain, arcFilter, arcGain, spark, sparkFilter, sparkGain, panner],
    );

    arc.start(now);
    arc.stop(now + duration + 0.01);
    mod.start(now);
    mod.stop(now + duration + 0.01);
    spark.start(now, this.randomNoiseOffset(duration), duration + 0.01);
  }

  private attachUnlockListeners(): void {
    if (this.listenersAttached) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }
    for (const ev of UNLOCK_EVENTS) {
      window.addEventListener(ev, this.handleGestureUnlock, true);
    }
    this.listenersAttached = true;
  }

  private detachUnlockListeners(): void {
    if (!this.listenersAttached) return;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      for (const ev of UNLOCK_EVENTS) {
        window.removeEventListener(ev, this.handleGestureUnlock, true);
      }
    }
    this.listenersAttached = false;
  }

  private resolveAudioContextCtor(): AudioContextCtor | null {
    if (typeof window === 'undefined') return null;
    const win = window as WindowWithWebkitAudio;
    return win.AudioContext ?? win.webkitAudioContext ?? null;
  }

  private onContextRunning(): void {
    this.unlocked = true;
    this.detachUnlockListeners();
    if (this.ctx && this.ringingDuration > 0 && this.ringingElapsed < this.ringingDuration) {
      if (!this.tinnitusOsc) {
        this.startTinnitus(this.ctx);
      }
      this.applyEarRingingParams();
    }
  }

  private getReadyContext(): ReadyAudioContext | null {
    if (this.disposed || !this.unlocked) return null;
    if (!this.ctx || !this.masterLowpass || !this.noiseBuffer) return null;
    if (this.ctx.state !== 'running') return null;
    return {
      ctx: this.ctx,
      masterLowpass: this.masterLowpass,
      noiseBuffer: this.noiseBuffer,
    };
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_BUFFER_SEC));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private createNoiseSource(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    return src;
  }

  private randomNoiseOffset(duration: number): number {
    const maxOffset = Math.max(0, NOISE_BUFFER_SEC - duration - 0.05);
    return Math.random() * maxOffset;
  }

  private createPanner(ctx: AudioContext, pos: Vec3, radius: number): PannerNode {
    const panner = ctx.createPanner();
    try {
      panner.panningModel = 'HRTF';
    } catch {
      panner.panningModel = 'equalpower';
    }
    panner.distanceModel = 'inverse';

    const safeRadius = clamp(radius, 1, 10000);
    panner.refDistance = clamp(safeRadius * 0.14, 0.7, 6.0);
    panner.maxDistance = Math.max(safeRadius * 1.5, 6.0);
    panner.rolloffFactor = 1.2;

    if (panner.positionX && panner.positionY && panner.positionZ) {
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;
    } else {
      const legacy = panner as unknown as LegacyPannerNode;
      legacy.setPosition?.(pos.x, pos.y, pos.z);
    }

    if (this.masterLowpass) {
      panner.connect(this.masterLowpass);
    }
    return panner;
  }

  private applyListenerToContext(ctx: AudioContext): void {
    const listener = ctx.listener;
    if (!listener) return;

    const p = this.listenerPos;
    const f = this.listenerForward;
    const u = this.listenerUp;

    if (
      listener.positionX &&
      listener.positionY &&
      listener.positionZ &&
      listener.forwardX &&
      listener.forwardY &&
      listener.forwardZ &&
      listener.upX &&
      listener.upY &&
      listener.upZ
    ) {
      listener.positionX.value = p.x;
      listener.positionY.value = p.y;
      listener.positionZ.value = p.z;
      listener.forwardX.value = f.x;
      listener.forwardY.value = f.y;
      listener.forwardZ.value = f.z;
      listener.upX.value = u.x;
      listener.upY.value = u.y;
      listener.upZ.value = u.z;
    } else {
      const legacy = listener as unknown as LegacyAudioListener;
      legacy.setPosition?.(p.x, p.y, p.z);
      legacy.setOrientation?.(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  private registerVoice(sources: AudioScheduledSourceNode[], nodes: AudioNode[]): void {
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.activeCleanups.delete(cleanup);
      for (const src of sources) {
        src.onended = null;
        try {
          src.stop();
        } catch {
          // Source may have already finished naturally.
        }
      }
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {
          // Ignore disconnect errors.
        }
      }
    };

    this.activeCleanups.add(cleanup);

    let remaining = sources.length;
    if (remaining === 0) {
      cleanup();
      return;
    }

    for (const src of sources) {
      src.onended = (): void => {
        remaining -= 1;
        if (remaining <= 0) {
          cleanup();
        }
      };
    }
  }

  private startTinnitus(ctx: AudioContext): void {
    this.stopTinnitus();

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = TINNITUS_FREQ_HZ;

    const gain = ctx.createGain();
    gain.gain.value = MAX_TINNITUS_GAIN * this.ringingIntensity;

    osc.connect(gain);
    // Bypass masterLowpass so high-frequency ringing remains audible while world SFX are muffled.
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);

    this.tinnitusOsc = osc;
    this.tinnitusGain = gain;
  }

  private stopTinnitus(): void {
    if (this.tinnitusOsc) {
      try {
        this.tinnitusOsc.stop();
      } catch {
        // Ignore if already stopped.
      }
      try {
        this.tinnitusOsc.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
      this.tinnitusOsc = null;
    }

    if (this.tinnitusGain) {
      try {
        this.tinnitusGain.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
      this.tinnitusGain = null;
    }
  }

  private applyEarRingingParams(): void {
    if (this.ringingDuration <= 0) return;

    const progress = clamp(this.ringingElapsed / this.ringingDuration, 0, 1);
    const remaining = (1 - progress) * (1 - progress);

    if (this.masterLowpass) {
      const minCutoff = 600 - 250 * this.ringingIntensity; // 350..600 Hz
      const muffleFactor = remaining * Math.sqrt(this.ringingIntensity);
      const logFreq =
        Math.log(NOMINAL_LOWPASS_HZ) * (1 - muffleFactor) +
        Math.log(minCutoff) * muffleFactor;
      this.masterLowpass.frequency.value = Math.exp(logFreq);
    }

    if (this.masterGain) {
      const dipAmount = (0.6 + 0.15 * this.ringingIntensity) * this.ringingIntensity * remaining;
      this.masterGain.gain.value = clamp(NOMINAL_MASTER_GAIN - dipAmount, 0.25, NOMINAL_MASTER_GAIN);
    }

    if (this.tinnitusGain) {
      this.tinnitusGain.gain.value = MAX_TINNITUS_GAIN * this.ringingIntensity * remaining;
    }
  }

  private restoreMasterBus(): void {
    if (this.masterLowpass) {
      this.masterLowpass.frequency.value = NOMINAL_LOWPASS_HZ;
    }
    if (this.masterGain) {
      this.masterGain.gain.value = NOMINAL_MASTER_GAIN;
    }
  }

  private cancelAllyRadio(): void {
    this.radioSeq++;
    if (this.stopAllyRadioEffect) {
      this.stopAllyRadioEffect();
      this.stopAllyRadioEffect = null;
    }
  }

  private resolveEnglishSpeech(): { synth: SpeechSynthesis; voice: SpeechSynthesisVoice } | null {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return null;
    const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
    const voice =
      voices.find((v) => v.lang.toLowerCase().startsWith('en-us')) ??
      voices.find((v) => v.lang.toLowerCase().startsWith('en'));
    return voice ? { synth, voice } : null;
  }

  private speakEnglishRadio(
    ready: ReadyAudioContext,
    text: string,
    pitch: number,
    rate: number,
    volume: number,
  ): boolean {
    const speech = this.resolveEnglishSpeech();
    if (!speech) return false;
    const { synth, voice: enVoice } = speech;

    this.cancelAllyRadio();
    const seq = ++this.radioSeq;
    const stopNoise = this.startRadioCarrierNoise(ready);
    this.playRadioSquelch(ready, true);

    let finished = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const finish = (playTail: boolean): void => {
      if (finished) return;
      finished = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      stopNoise();
      if (this.stopAllyRadioEffect === cleanup) {
        this.stopAllyRadioEffect = null;
      }
      if (playTail && !this.disposed && this.radioSeq === seq) {
        const tailReady = this.getReadyContext();
        if (tailReady) this.playRadioSquelch(tailReady, false);
      }
    };
    const cleanup = (): void => {
      finish(false);
      try {
        synth.cancel();
      } catch {
        // Ignore speechSynthesis cancel errors.
      }
    };
    this.stopAllyRadioEffect = cleanup;

    const utter = new SpeechSynthesisUtterance(text);
    utter.voice = enVoice;
    utter.lang = 'en-US';
    utter.volume = volume;
    utter.pitch = pitch;
    utter.rate = rate;
    utter.onend = () => finish(true);
    utter.onerror = () => finish(false);
    timerId = setTimeout(() => finish(true), 4500);

    try {
      synth.speak(utter);
      return true;
    } catch {
      finish(false);
      return false;
    }
  }

  private playRadioSquelch(ready: ReadyAudioContext, opening: boolean): void {
    const { ctx, masterLowpass, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const noiseDur = opening ? 0.042 : 0.036;
    const noise = this.createNoiseSource(ctx, noiseBuffer);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(opening ? 2500 : 2100, now);
    bp.Q.value = 2.6;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(EPSILON, now);
    ng.gain.linearRampToValueAtTime(0.14, now + 0.004);
    ng.gain.exponentialRampToValueAtTime(EPSILON, now + noiseDur);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(masterLowpass);

    const beepDur = opening ? 0.025 : 0.048;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    if (opening) {
      osc.frequency.setValueAtTime(1850, now);
      osc.frequency.exponentialRampToValueAtTime(1350, now + beepDur);
    } else {
      osc.frequency.setValueAtTime(1050, now);
    }
    const og = ctx.createGain();
    og.gain.setValueAtTime(EPSILON, now);
    og.gain.linearRampToValueAtTime(opening ? 0.07 : 0.09, now + 0.003);
    og.gain.exponentialRampToValueAtTime(EPSILON, now + beepDur);
    osc.connect(og);
    og.connect(masterLowpass);

    this.registerVoice([noise, osc], [noise, bp, ng, osc, og]);
    noise.start(now, this.randomNoiseOffset(noiseDur), noiseDur + 0.005);
    osc.start(now);
    osc.stop(now + beepDur + 0.008);
  }

  private startRadioCarrierNoise(ready: ReadyAudioContext): () => void {
    const { ctx, masterLowpass, noiseBuffer } = ready;
    const now = ctx.currentTime;
    const src = this.createNoiseSource(ctx, noiseBuffer);
    src.loop = true;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(450, now);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.028, now);

    src.connect(hp);
    hp.connect(lp);
    lp.connect(gain);
    gain.connect(masterLowpass);

    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      this.activeCleanups.delete(stop);
      try {
        src.stop();
      } catch {
        // Ignore if already stopped.
      }
      for (const n of [src, hp, lp, gain]) {
        try {
          n.disconnect();
        } catch {
          // Ignore disconnect errors.
        }
      }
    };
    this.activeCleanups.add(stop);
    src.start(now, this.randomNoiseOffset(0.5));
    return stop;
  }

  private playRadioTransmission(
    ready: ReadyAudioContext,
    syllables: number,
    baseHz: number,
    bodySec: number,
  ): void {
    const { ctx, masterLowpass, noiseBuffer } = ready;
    const now = ctx.currentTime;

    this.playRadioSquelch(ready, true);

    const voiceStart = now + 0.05;
    const voiceEnd = voiceStart + bodySec;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(baseHz, voiceStart);
    const step = bodySec / syllables;
    for (let i = 0; i < syllables; i++) {
      const t = voiceStart + i * step;
      const pitchMul = 0.92 + ((i * 37) % 10) * 0.022;
      osc.frequency.linearRampToValueAtTime(baseHz * pitchMul, t + step * 0.5);
    }

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(350, voiceStart);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, voiceStart);

    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.setValueAtTime(680, voiceStart);
    f1.Q.value = 3.8;

    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.setValueAtTime(1550, voiceStart);
    f2.Q.value = 4.5;

    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(65);
    for (let i = 0; i < curve.length; i++) {
      const x = (i * 2) / (curve.length - 1) - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;

    const vg = ctx.createGain();
    vg.gain.setValueAtTime(EPSILON, voiceStart);
    for (let i = 0; i < syllables; i++) {
      const t = voiceStart + i * step;
      vg.gain.linearRampToValueAtTime(0.11, t + step * 0.2);
      vg.gain.linearRampToValueAtTime(0.02, t + step * 0.85);
    }
    vg.gain.exponentialRampToValueAtTime(EPSILON, voiceEnd);

    // Subtle carrier static during speech
    const carrier = this.createNoiseSource(ctx, noiseBuffer);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.022, voiceStart);

    osc.connect(f1);
    osc.connect(f2);
    f1.connect(vg);
    f2.connect(vg);
    vg.connect(shaper);
    carrier.connect(cg);
    cg.connect(hp);
    shaper.connect(hp);
    hp.connect(lp);
    lp.connect(masterLowpass);

    const tailOsc = ctx.createOscillator();
    tailOsc.type = 'sine';
    const tailStart = voiceEnd + 0.015;
    const tailDur = 0.048;
    tailOsc.frequency.setValueAtTime(1050, tailStart);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(EPSILON, tailStart);
    tg.gain.linearRampToValueAtTime(0.09, tailStart + 0.003);
    tg.gain.exponentialRampToValueAtTime(EPSILON, tailStart + tailDur);
    tailOsc.connect(tg);
    tg.connect(masterLowpass);

    this.registerVoice(
      [osc, carrier, tailOsc],
      [osc, f1, f2, vg, shaper, carrier, cg, hp, lp, tailOsc, tg],
    );

    osc.start(voiceStart);
    osc.stop(voiceEnd + 0.01);
    carrier.start(voiceStart, this.randomNoiseOffset(bodySec), bodySec + 0.01);
    tailOsc.start(tailStart);
    tailOsc.stop(tailStart + tailDur + 0.008);
  }
}
