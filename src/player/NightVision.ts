import * as THREE from 'three';
import type { PostFX } from '../core/PostFX';
import type { GlareInfo } from '../world/Flashlights';

/** 跳ね上げ式マウントの上げ下げにかかる時間（秒） */
const FLIP_SEC = 0.35;
/** 暗闇 / オートゲート減光時 / 明るい場所での増幅率 */
export const GAIN_DARK = 14;
export const GAIN_AUTOGATE = 4.0;
export const GAIN_LIT = 1.3;

export interface NightVisionOptions {
  postfx: PostFX;
  scene: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  host: HTMLElement;
  /** 一人称装備シーンのライト（装着中は蛍光色に寄せる） */
  equipmentLights: { light: THREE.Light; color: number; intensity: number }[];
  /** 上げ下げの音 */
  click?: () => void;
}

/**
 * SWAT の暗視装置（現代の Gen 3+ 白色蛍光・オートゲート方式）。N で跳ね上げ / 装着。
 * - 画面: PostFX の増幅（オートゲート・粒状ノイズ）＋ ブラウン管のような角丸の視野の外側を黒く塞ぐマスク
 * - IR イルミネーター: 装着中だけ目の前を照らす（暗視装置にしか見えない光の想定）
 * - オートゲート（ABC）: 強い光を浴びると瞬時にゲインを自動低下させて画面全体の白飛びを防ぎ、光源周囲に局所ハローを描く
 */
export class NightVision {
  private on = false;
  private amount = 0;
  private time = 0;
  private bloom = 0;
  private autoGate = 0;
  private flare = 0;
  private prevGlare = 0;
  private glareUvX = 0.5;
  private glareUvY = 0.5;
  private lastGain = GAIN_DARK;
  private readonly ir: THREE.PointLight;
  private readonly mask: HTMLCanvasElement;
  private maskW = 0;
  private maskH = 0;
  private readonly fwd = new THREE.Vector3();
  private readonly tint = new THREE.Color(0xcfe4ff);
  private readonly tmpColor = new THREE.Color();

  constructor(private readonly o: NightVisionOptions) {
    this.ir = new THREE.PointLight(0xffffff, 0, 16, 1.7);
    this.ir.name = 'nvg-ir';
    o.scene.add(this.ir);
    this.mask = document.createElement('canvas');
    this.mask.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:4;opacity:0';
    o.host.appendChild(this.mask);
  }

  get active(): boolean {
    return this.on;
  }

  /** 装着の度合い 0..1（上げ下げのアニメーション込み） */
  get level(): number {
    return this.amount;
  }

  /** 現在の実効増幅ゲイン（テスト・デバッグ用） */
  get effectiveGain(): number {
    return this.lastGain;
  }

  /** 急照射直後の瞬間フレア残量 0..1（テスト・デバッグ用） */
  get flareLevel(): number {
    return this.flare;
  }

  toggle(): boolean {
    this.on = !this.on;
    this.o.click?.();
    return this.on;
  }

  setOn(on: boolean): void {
    if (this.on !== on) this.toggle();
  }

  private drawMask(): void {
    const w = Math.max(1, Math.round(window.innerWidth / 2));
    const h = Math.max(1, Math.round(window.innerHeight / 2));
    if (w === this.maskW && h === this.maskH) return;
    this.maskW = w;
    this.maskH = h;
    this.mask.width = w;
    this.mask.height = h;
    const g = this.mask.getContext('2d');
    if (!g) return;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    // ブラウン管テレビのような視野: 四隅の丸い四角形（辺が少し膨らんだ超楕円）を 1 枚、縁をぼかして抜く
    const a = w * 0.43;
    const b = h * 0.41;
    const n = 3.6;
    const cx = w / 2;
    const cy = h / 2;
    g.globalCompositeOperation = 'destination-out';
    g.filter = `blur(${Math.max(2, Math.round(Math.min(w, h) * 0.025))}px)`;
    g.fillStyle = '#000';
    g.beginPath();
    const steps = 160;
    for (let i = 0; i <= steps; i++) {
      const th = (i / steps) * Math.PI * 2;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const x = cx + a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      const y = cy + b * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
    g.filter = 'none';
    g.globalCompositeOperation = 'source-over';
  }

  /**
   * dark = 停電中か、glare = 容疑者のライトによる照射情報（強度 0..1 と画面 UV）。
   * 毎フレーム呼ぶ（プレイ中以外は amount を 0 に戻すため呼ばなくてよい）。
   */
  update(dt: number, dark: boolean, glare: number | GlareInfo): void {
    this.time += dt;
    const target = this.on ? 1 : 0;
    const step = dt / FLIP_SEC;
    this.amount = target > this.amount ? Math.min(target, this.amount + step) : Math.max(target, this.amount - step);

    const intensity = Math.max(0, Math.min(1, typeof glare === 'number' ? glare : glare.intensity));
    if (typeof glare !== 'number' && intensity > 0.001) {
      this.glareUvX = glare.uvX;
      this.glareUvY = glare.uvY;
    }

    // 局所ハロー: 光源に対して素早く追従し、外れたら滑らかに引く
    const bloomRate = intensity > this.bloom ? 16 : 6;
    this.bloom += (intensity - this.bloom) * Math.min(1, dt * bloomRate);
    if (this.bloom < 0.002 && intensity === 0) this.bloom = 0;

    // オートゲート（ABC）: 強い光を受けると瞬時（〜0.1秒）にゲインを絞り、光が消えると自然に復帰
    const gateRate = intensity > this.autoGate ? 10 : 2.2;
    this.autoGate += (intensity - this.autoGate) * Math.min(1, dt * gateRate);
    if (this.autoGate < 0.002 && intensity === 0) this.autoGate = 0;

    // 瞬間フレア: 暗闇から急に光を浴びた直後の差分にだけ反応し、約0.2秒で収束
    const rise = Math.max(0, intensity - this.prevGlare);
    this.prevGlare = intensity;
    this.flare = Math.min(1, Math.max(0, this.flare - dt * 5.5) + rise * 0.9);

    const gain = dark ? THREE.MathUtils.lerp(GAIN_DARK, GAIN_AUTOGATE, this.autoGate) : GAIN_LIT;
    this.lastGain = gain;
    const active = this.amount > 0;
    this.o.postfx.setNightVision(
      this.amount,
      gain,
      active ? this.bloom : 0,
      this.time,
      active ? this.flare : 0,
      this.glareUvX,
      this.glareUvY,
    );
    if (active) this.drawMask();
    this.mask.style.opacity = String(this.amount);
    // IR イルミネーターは目の少し前に
    const cam = this.o.camera;
    cam.getWorldPosition(this.ir.position);
    cam.getWorldDirection(this.fwd);
    this.ir.position.addScaledVector(this.fwd, -0.3);
    this.ir.intensity = dark ? 1.3 * this.amount : 0;
    for (const e of this.o.equipmentLights) {
      // 装着中は手元の装備も増幅映像の色に、停電中で裸眼ならしっかり暗く
      const k = dark ? 0.08 + 0.92 * this.amount : 1;
      e.light.intensity = e.intensity * k;
      this.tmpColor.setHex(e.color).lerp(this.tint, this.amount);
      e.light.color.copy(this.tmpColor);
    }
  }

  /** 即座に外す（任務終了時。update が止まっても画面に残らないように） */
  forceOff(): void {
    this.on = false;
    this.amount = 0;
    this.bloom = 0;
    this.autoGate = 0;
    this.flare = 0;
    this.prevGlare = 0;
    this.mask.style.opacity = '0';
    this.ir.intensity = 0;
    this.o.postfx.setNightVision(0, GAIN_DARK, 0, this.time, 0, 0.5, 0.5);
  }

  dispose(): void {
    this.ir.removeFromParent();
    this.mask.remove();
    this.o.postfx.setNightVision(0, GAIN_DARK, 0, 0, 0, 0.5, 0.5);
  }
}
