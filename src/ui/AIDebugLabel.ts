import * as THREE from 'three';

/** 頭上に「ID / ステート / 士気」を出すデバッグ用スプライト。 */
export class AIDebugLabel {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private lastText = '';

  constructor() {
    this.canvas.width = 256;
    this.canvas.height = 64;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context を取得できません');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    const mat = new THREE.SpriteMaterial({ map: this.texture, depthWrite: false, transparent: true });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.set(1.4, 0.35, 1);
  }

  set(text: string, color = '#ffffff'): void {
    const key = text + color;
    if (key === this.lastText) return;
    this.lastText = key;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.sprite.removeFromParent();
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}
