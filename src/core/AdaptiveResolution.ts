import type * as THREE from 'three';

/** 解像度倍率の上限（高 DPI でも 1.5 まで。2 倍は描画ピクセル数が 1.8 倍に増える割に見た目の差が小さい）。 */
const MAX_RATIO = 1.5;
export const MIN_RATIO = 0.6;
const STEP = 0.15;
/** この FPS を下回り続けたら負荷を下げる。 */
const LOW_FPS = 48;
/** この FPS 以上が続いたら上げてみる（垂直同期 60Hz でも満たせるよう 60 未満に置く）。 */
const HIGH_FPS = 57;
const WINDOW_SEC = 1.5;

/**
 * フレーム時間を見て GTAO の有効/無効と renderer の pixelRatio を自動調整する（動的解像度）。
 * GPU が弱い環境（ノート PC 内蔵 GPU・高 DPI 画面）でフレームレートを優先する。
 * 等倍 (1.0) 以下へ解像度を落として画面がぼやける前にまず AO を切り、
 * AO 切断後も 2 回連続で改善しなかった場合のみ CPU 律速と判断して画質を戻して固定する。
 */
export class AdaptiveResolution {
  private ratio: number;
  private ceiling: number;
  private acc = 0;
  private frames = 0;
  private lastRaise = -Infinity;
  private lastAoRaise = -Infinity;
  private aoDropClock = -Infinity;
  private clock = 0;
  /** 直前に下げたときの FPS。AO 切断後に 2 回連続で改善しなければ CPU 律速と判断して止める。 */
  private fpsBeforeDrop = 0;
  private ratioBeforeDrop = 0;
  private ratioBeforeStreak = 0;
  private nonImprovingDrops = 0;
  private highFpsStreak = 0;
  private frozen = false;
  private userAo: boolean;
  private aoAllowed: boolean;
  private aoCeilingLocked = false;
  /** 倍率または AO 許可状態が変わったとき（ポストプロセスのバッファ・AO 追従用） */
  onChange: ((ratio: number, aoAllowed: boolean) => void) | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    userAoEnabled = true,
  ) {
    this.userAo = userAoEnabled;
    this.aoAllowed = userAoEnabled;
    this.ceiling = Math.min(window.devicePixelRatio || 1, MAX_RATIO);
    this.ratio = Math.round(Math.min(this.ceiling, Math.max(MIN_RATIO, this.ceiling)) * 100) / 100;
    renderer.setPixelRatio(this.ratio);
  }

  get pixelRatio(): number {
    return this.ratio;
  }

  /** ユーザー設定と動的負荷制御の両方を満たす実効 AO 有効状態。 */
  get aoActive(): boolean {
    return this.userAo && this.aoAllowed;
  }

  /** 設定変更（AO / 影）や DPI 変化を伴うリサイズ時に計測状態と上限を再初期化する。 */
  reset(newCeiling?: number, userAoEnabled?: boolean): void {
    if (userAoEnabled !== undefined) {
      this.userAo = userAoEnabled;
    }
    this.ceiling =
      newCeiling !== undefined
        ? Math.min(Math.max(MIN_RATIO, newCeiling), MAX_RATIO)
        : Math.min(window.devicePixelRatio || 1, MAX_RATIO);
    this.acc = 0;
    this.frames = 0;
    this.fpsBeforeDrop = 0;
    this.ratioBeforeDrop = 0;
    this.ratioBeforeStreak = 0;
    this.nonImprovingDrops = 0;
    this.highFpsStreak = 0;
    this.frozen = false;
    this.aoCeilingLocked = false;
    this.aoAllowed = this.userAo;
    this.lastRaise = -Infinity;
    this.lastAoRaise = -Infinity;
    this.aoDropClock = -Infinity;
    const next = Math.round(Math.min(this.ceiling, Math.max(MIN_RATIO, this.ceiling)) * 100) / 100;
    this.ratio = next;
    this.renderer.setPixelRatio(next);
    this.onChange?.(next, this.aoActive);
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
      if (!this.aoActive && fps < LOW_FPS && fps < before * 1.08) {
        this.nonImprovingDrops++;
        if (this.nonImprovingDrops >= 2) {
          const restore = this.ratioBeforeStreak > 0 ? this.ratioBeforeStreak : this.ratioBeforeDrop;
          this.ceiling = Math.max(this.ceiling, restore);
          this.set(restore);
          this.frozen = true;
          return;
        }
      } else {
        this.nonImprovingDrops = 0;
        this.ratioBeforeStreak = 0;
      }
    }

    if (fps < LOW_FPS) {
      this.highFpsStreak = 0;
      // 1.0 倍以下へ落としてぼやけさせる前に、まず重い GTAO パスを切る
      if (this.aoActive && this.ratio <= 1.0 + 1e-4) {
        if (this.clock - this.lastAoRaise < WINDOW_SEC * 3) {
          this.aoCeilingLocked = true;
        }
        this.aoAllowed = false;
        this.aoDropClock = this.clock;
        this.nonImprovingDrops = 0;
        this.ratioBeforeStreak = 0;
        this.onChange?.(this.ratio, this.aoActive);
        return;
      }
      if (this.ratio > MIN_RATIO) {
        if (this.nonImprovingDrops === 0 && !this.aoActive) {
          this.ratioBeforeStreak = this.ratio;
        }
        this.fpsBeforeDrop = fps;
        this.ratioBeforeDrop = this.ratio;
        // 上げた直後の低下ならその倍率は無理と判断して上限を下げる
        if (this.clock - this.lastRaise < WINDOW_SEC * 2.5) {
          this.ceiling = Math.max(MIN_RATIO, this.ratio - STEP);
        }
        const drop = fps < LOW_FPS * 0.6 ? STEP * 2 : STEP;
        // AO がまだ有効な高 DPI 領域ではまず 1.0 に着地させ、次ウィンドウで AO 切断を判定する
        const target = this.aoActive && this.ratio > 1.0 ? Math.max(1.0, this.ratio - drop) : this.ratio - drop;
        this.set(target);
      }
    } else if (fps >= HIGH_FPS) {
      this.highFpsStreak++;
      this.nonImprovingDrops = 0;
      this.ratioBeforeStreak = 0;
      const baseTarget = Math.min(1.0, this.ceiling);
      if (this.ratio < baseTarget - 1e-4) {
        this.set(Math.min(baseTarget, this.ratio + STEP));
        this.lastRaise = this.clock;
      } else if (
        this.userAo &&
        !this.aoAllowed &&
        !this.aoCeilingLocked &&
        this.highFpsStreak >= 2 &&
        this.clock - this.aoDropClock >= WINDOW_SEC * 3
      ) {
        this.aoAllowed = true;
        this.lastAoRaise = this.clock;
        this.highFpsStreak = 0;
        this.onChange?.(this.ratio, this.aoActive);
      } else if (this.ratio < this.ceiling - 1e-4) {
        this.set(this.ratio + STEP);
        this.lastRaise = this.clock;
      }
    } else {
      this.highFpsStreak = 0;
    }
  }

  private set(r: number): void {
    const next = Math.round(Math.min(this.ceiling, Math.max(MIN_RATIO, r)) * 100) / 100;
    if (next === this.ratio) return;
    this.ratio = next;
    this.renderer.setPixelRatio(next);
    this.onChange?.(next, this.aoActive);
  }
}
