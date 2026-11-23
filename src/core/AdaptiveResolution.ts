import type * as THREE from 'three';

/** 解像度倍率の上限（高 DPI でも 1.5 まで。2 倍は描画ピクセル数が 1.8 倍に増える割に見た目の差が小さい）。 */
const MAX_RATIO = 1.5;
export const MIN_RATIO = 0.6;
const STEP = 0.15;
/** この FPS を下回り続けたら解像度を下げる。 */
const LOW_FPS = 48;
/** この FPS 以上が続いたら上げてみる（垂直同期 60Hz でも満たせるよう 60 未満に置く）。 */
const HIGH_FPS = 57;
const WINDOW_SEC = 1.5;

/**
 * フレーム時間を見て renderer の pixelRatio を自動調整する（動的解像度）。
 * GPU が弱い環境（ノート PC 内蔵 GPU・高 DPI 画面）でフレームレートを優先する。
 * 上げた直後に再び落ちた倍率は「上限」として記憶し、行ったり来たりを防ぐ。
 */
export class AdaptiveResolution {
  private ratio: number;
  private ceiling: number;
  private acc = 0;
  private frames = 0;
  private lastRaise = -Infinity;
  private clock = 0;
  /** 直前に下げたときの FPS。下げても改善しなければ GPU 律速ではない（CPU 律速）ので画質を戻して止める。 */
  private fpsBeforeDrop = 0;
  private ratioBeforeDrop = 0;
  private frozen = false;
  /** 倍率が変わったとき（ポストプロセスのバッファ追従用） */
  onChange: ((ratio: number) => void) | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.ceiling = Math.min(window.devicePixelRatio || 1, MAX_RATIO);
    this.ratio = this.ceiling;
    renderer.setPixelRatio(this.ratio);
  }

  get pixelRatio(): number {
    return this.ratio;
  }

  /** 実時間の dt（クランプ前）を毎フレーム渡す。active=false の間は計測しない（メニュー表示中など）。 */
  sample(rawDt: number, active: boolean): void {
    if (!active || rawDt <= 0 || rawDt > 0.5) return; // タブ復帰などの外れ値は除外
    this.clock += rawDt;
    this.acc += rawDt;
    this.frames++;
    if (this.acc < WINDOW_SEC) return;
    const fps = this.frames / this.acc;
    this.acc = 0;
    this.frames = 0;
    if (this.frozen) return;
    if (this.fpsBeforeDrop > 0) {
      const before = this.fpsBeforeDrop;
      this.fpsBeforeDrop = 0;
      if (fps < LOW_FPS && fps < before * 1.08) {
        this.ceiling = Math.max(this.ceiling, this.ratioBeforeDrop);
        this.set(this.ratioBeforeDrop);
        this.frozen = true;
        return;
      }
    }
    if (fps < LOW_FPS && this.ratio > MIN_RATIO) {
      this.fpsBeforeDrop = fps;
      this.ratioBeforeDrop = this.ratio;
      // 上げた直後の低下ならその倍率は無理と判断して上限を下げる
      if (this.clock - this.lastRaise < WINDOW_SEC * 2.5) this.ceiling = Math.max(MIN_RATIO, this.ratio - STEP);
      this.set(this.ratio - (fps < LOW_FPS * 0.6 ? STEP * 2 : STEP));
    } else if (fps >= HIGH_FPS && this.ratio < this.ceiling) {
      this.set(this.ratio + STEP);
      this.lastRaise = this.clock;
    }
  }

  private set(r: number): void {
    const next = Math.round(Math.min(this.ceiling, Math.max(MIN_RATIO, r)) * 100) / 100;
    if (next === this.ratio) return;
    this.ratio = next;
    this.renderer.setPixelRatio(next);
    this.onChange?.(next);
  }
}
