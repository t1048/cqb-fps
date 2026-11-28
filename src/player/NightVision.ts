import * as THREE from 'three';
import type { PostFX } from '../core/PostFX';

/** 跳ね上げ式マウントの上げ下げにかかる時間（秒） */
const FLIP_SEC = 0.35;
/** 暗闇 / 明るい場所での増幅率（オートゲイン） */
const GAIN_DARK = 7;
const GAIN_LIT = 1.3;

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
 * SWAT の暗視装置（白色蛍光）。N で跳ね上げ / 装着。
 * - 画面: PostFX の増幅（オートゲイン・粒状ノイズ）＋ ブラウン管のような角丸の視野の外側を黒く塞ぐマスク
 * - IR イルミネーター: 装着中だけ目の前を弱く照らす（暗視装置にしか見えない光の想定）
 * - 白飛び: 容疑者のライトに正面から照らされると、画面が一瞬白く飛ぶ
 */
export class NightVision {
  private on = false;
  private amount = 0;
  private time = 0;
  private bloom = 0;
  private readonly ir: THREE.PointLight;
  private readonly mask: HTMLCanvasElement;
  private maskW = 0;
  private maskH = 0;
  private readonly fwd = new THREE.Vector3();
  private readonly tint = new THREE.Color(0xcfe4ff);
  private readonly tmpColor = new THREE.Color();

  constructor(private readonly o: NightVisionOptions) {
    this.ir = new THREE.PointLight(0xffffff, 0, 12, 2);
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
   * dark = 停電中か、glare = 容疑者のライトによる白飛び（0..1）。
   * 毎フレーム呼ぶ（プレイ中以外は amount を 0 に戻すため呼ばなくてよい）。
   */
  update(dt: number, dark: boolean, glare: number): void {
    this.time += dt;
    const target = this.on ? 1 : 0;
    const step = dt / FLIP_SEC;
    this.amount = target > this.amount ? Math.min(target, this.amount + step) : Math.max(target, this.amount - step);
    // 白飛びはすぐ上がり、ゆっくり戻る（増幅管の保護回路が効くまでの残像）
    this.bloom = glare > this.bloom ? glare : Math.max(glare, this.bloom - dt * 1.6);
    const gain = dark ? GAIN_DARK : GAIN_LIT;
    this.o.postfx.setNightVision(this.amount, gain, this.amount > 0 ? this.bloom : 0, this.time);
    if (this.amount > 0) this.drawMask();
    this.mask.style.opacity = String(this.amount);
    // IR イルミネーターは目の少し前に
    const cam = this.o.camera;
    cam.getWorldPosition(this.ir.position);
    cam.getWorldDirection(this.fwd);
    this.ir.position.addScaledVector(this.fwd, -0.3);
    this.ir.intensity = dark ? 0.9 * this.amount : 0;
    for (const e of this.o.equipmentLights) {
      // 装着中は手元の装備も増幅映像の色に、停電中で裸眼なら暗く
      const k = dark ? 0.22 + 0.78 * this.amount : 1;
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
    this.mask.style.opacity = '0';
    this.ir.intensity = 0;
    this.o.postfx.setNightVision(0, GAIN_DARK, 0, this.time);
  }

  dispose(): void {
    this.ir.removeFromParent();
    this.mask.remove();
    this.o.postfx.setNightVision(0, GAIN_DARK, 0, 0);
  }
}
