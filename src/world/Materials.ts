import * as THREE from 'three';

export type TextureName =
  | 'camo'
  | 'fabric'
  | 'metal'
  | 'wood'
  | 'doorWood'
  | 'doorFrame'
  | 'frostedGlass'
  | 'tile'
  | 'carpet'
  | 'plaster'
  | 'concrete'
  | 'brick'
  | 'faceA' | 'faceB' | 'ally' | 'suspect' | 'civilian'
  | 'skin'
  | 'glass';

/**
 * Canvas で作る共有テクスチャ。userData.shared を立て、disposeObject では解放しない。
 * シーン破棄の最後に dispose() する。
 */
export class TextureLibrary {
  private readonly textures = new Map<string, THREE.CanvasTexture>();
  private disposed = false;

  get(name: TextureName): THREE.CanvasTexture {
    const hit = this.textures.get(name);
    if (hit) return hit;
    const canvas = document.createElement('canvas');
    const garment = name === 'ally' || name === 'suspect' || name === 'civilian';
    canvas.width = garment ? 512 : 256;
    canvas.height = garment ? 384 : 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context を取得できません');
    paint(name, ctx, canvas.width, canvas.height);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.userData.shared = true;
    if (garment || ['faceA', 'faceB', 'fabric', 'concrete', 'wood', 'plaster'].includes(name)) {
      const image = new Image();
      image.onload = () => {
        if (this.disposed) return;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        tex.needsUpdate = true;
      };
      image.src = import.meta.env.BASE_URL + 'textures/' + name + '.webp';
    }
    this.textures.set(name, tex);
    return tex;
  }

  /** マップ名からテクスチャ。未知の名前は plaster。 */
  byMaterial(name: string | undefined, fallback: TextureName): THREE.CanvasTexture {
    const known: TextureName[] = ['camo', 'fabric', 'metal', 'wood', 'tile', 'carpet', 'plaster', 'concrete', 'brick', 'skin', 'glass'];
    const key = known.find((n) => n === name) ?? fallback;
    return this.get(key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tex of this.textures.values()) tex.dispose();
    this.textures.clear();
  }
}

function paint(name: TextureName, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (name === 'camo') return paintCamo(ctx, w, h);
  if (name === 'fabric') return paintFabric(ctx, w, h, '#3d4a38', '#2a3328');
  if (name === 'metal') return paintMetal(ctx, w, h);
  if (name === 'wood') return paintWood(ctx, w, h);
  if (name === 'doorWood') return paintDoorWood(ctx, w, h);
  if (name === 'doorFrame') return paintDoorFrame(ctx, w, h);
  if (name === 'frostedGlass') return paintFrostedGlass(ctx, w, h);
  if (name === 'tile') return paintTile(ctx, w, h);
  if (name === 'carpet') return paintFabric(ctx, w, h, '#6a3a3a', '#4a2828');
  if (name === 'plaster') return paintPlaster(ctx, w, h, '#c8c0b0');
  if (name === 'concrete') return paintPlaster(ctx, w, h, '#6a6e72');
  if (name === 'brick') return paintBrick(ctx, w, h);
  if (name === 'faceA' || name === 'faceB' || name === 'skin') return paintSkin(ctx, w, h);
  paintGlass(ctx, w, h);
}

function paintCamo(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#3e4a34';
  ctx.fillRect(0, 0, w, h);
  const blobs = ['#2a3324', '#5a6240', '#1e261c', '#6b5a3a'];
  for (let i = 0; i < 28; i++) {
    ctx.fillStyle = blobs[i % blobs.length] ?? '#333';
    const x = (i * 37) % w;
    const y = (i * 53) % h;
    ctx.beginPath();
    ctx.ellipse(x, y, 10 + (i % 5) * 4, 8 + (i % 3) * 3, i, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintFabric(ctx: CanvasRenderingContext2D, w: number, h: number, a: string, b: string): void {
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 2) {
    ctx.fillStyle = y % 4 === 0 ? b : a;
    ctx.fillRect(0, y, w, 1);
  }
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.03 + (i % 5) * 0.01})`;
    ctx.fillRect((i * 17) % w, (i * 29) % h, 2, 2);
  }
}

function paintMetal(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#8d9398');
  g.addColorStop(0.4, '#5c6368');
  g.addColorStop(0.7, '#b0b6bb');
  g.addColorStop(1, '#3e4448');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  for (let y = 8; y < h; y += 10) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function paintWood(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#7a5230';
  ctx.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 7) {
    ctx.fillStyle = y % 14 === 0 ? '#5c3b20' : '#8d6238';
    ctx.fillRect(0, y, w, 3);
    ctx.fillStyle = 'rgba(40,20,8,0.25)';
    ctx.beginPath();
    ctx.moveTo(0, y + 2);
    ctx.bezierCurveTo(w * 0.3, y + 6, w * 0.6, y - 2, w, y + 3);
    ctx.stroke();
  }
}

function paintTile(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#d7d2c6';
  ctx.fillRect(0, 0, w, h);
  const n = 4;
  const tw = w / n;
  const th = h / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#e6e1d4' : '#c9c3b4';
      ctx.fillRect(x * tw + 1, y * th + 1, tw - 2, th - 2);
    }
  }
}

function paintPlaster(ctx: CanvasRenderingContext2D, w: number, h: number, base: string): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 80; i++) {
    const shade = 20 + (i % 15);
    ctx.fillStyle = `rgba(${shade},${shade},${shade},0.08)`;
    ctx.fillRect((i * 13) % w, (i * 19) % h, 3 + (i % 4), 2);
  }
}

function paintBrick(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#6d5a52';
  ctx.fillRect(0, 0, w, h);
  const bh = 16;
  const bw = 32;
  for (let y = 0; y < h; y += bh) {
    const off = (y / bh) % 2 === 0 ? 0 : bw / 2;
    for (let x = -bw; x < w; x += bw) {
      ctx.fillStyle = (x + y) % 64 === 0 ? '#8a4034' : '#a35242';
      ctx.fillRect(x + off + 1, y + 1, bw - 2, bh - 2);
    }
  }
}

function paintSkin(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createRadialGradient(w * 0.4, h * 0.35, 8, w / 2, h / 2, w * 0.6);
  g.addColorStop(0, '#e0b08a');
  g.addColorStop(1, '#a56b45');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function paintGlass(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, 'rgba(170,210,230,0.55)');
  g.addColorStop(0.5, 'rgba(220,240,255,0.25)');
  g.addColorStop(1, 'rgba(80,120,150,0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** ドア扉板用の縦木目＋微細グレイン＋うっすらした塗装感のテクスチャ。 */
function paintDoorWood(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const base = ctx.createLinearGradient(0, 0, w, 0);
  base.addColorStop(0, '#6e4b2f');
  base.addColorStop(0.35, '#7c5536');
  base.addColorStop(0.7, '#69462b');
  base.addColorStop(1, '#755033');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // 縦木目の濃淡バンド
  for (let x = 0; x < w; x += 5) {
    const tone = (x * 13) % 3;
    ctx.fillStyle = tone === 0 ? 'rgba(42,24,10,0.22)' : tone === 1 ? 'rgba(148,108,68,0.14)' : 'rgba(56,34,16,0.12)';
    ctx.fillRect(x, 0, 2 + (x % 3), h);
  }

  // 緩やかにうねる縦繊維ライン
  ctx.lineWidth = 1;
  for (let x = 3; x < w; x += 7) {
    ctx.strokeStyle = x % 14 === 0 ? 'rgba(34,18,7,0.30)' : 'rgba(162,120,76,0.16)';
    const sway = ((x * 17) % 7) - 3;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + sway, h * 0.33, x - sway, h * 0.67, x + sway * 0.5, h);
    ctx.stroke();
  }

  // 微細な木肌グレイン
  for (let i = 0; i < 160; i++) {
    const gx = (i * 29) % w;
    const gy = (i * 47) % h;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(28,15,6,0.16)' : 'rgba(195,155,112,0.09)';
    ctx.fillRect(gx, gy, 1, 6 + (i % 10));
  }

  // うっすらとした塗装・クリアコートの光沢感
  const sheen = ctx.createLinearGradient(0, 0, w, h);
  sheen.addColorStop(0, 'rgba(255,244,230,0.06)');
  sheen.addColorStop(0.5, 'rgba(255,244,230,0.0)');
  sheen.addColorStop(1, 'rgba(20,12,6,0.08)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, w, h);
}

/** ドア枠・ケーシング用のダーク塗装ウッドテクスチャ。 */
function paintDoorFrame(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#3d2a1c';
  ctx.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += 6) {
    ctx.fillStyle = x % 12 === 0 ? 'rgba(22,14,8,0.28)' : 'rgba(92,66,44,0.14)';
    ctx.fillRect(x, 0, 2, h);
  }
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = 'rgba(255,240,220,0.04)';
    ctx.fillRect((i * 19) % w, (i * 37) % h, 1, 8 + (i % 8));
  }
}

/** 欄間用のすりガラス風半透明テクスチャ。 */
function paintFrostedGlass(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, 'rgba(218,232,240,0.72)');
  g.addColorStop(0.5, 'rgba(196,214,226,0.62)');
  g.addColorStop(1, 'rgba(168,192,208,0.74)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // すりガラスの細かな曇り粒子
  for (let i = 0; i < 240; i++) {
    const x = (i * 31) % w;
    const y = (i * 53) % h;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(120,145,165,0.10)';
    ctx.fillRect(x, y, 2 + (i % 3), 2 + ((i * 3) % 3));
  }
  // 淡い斜めハイライト
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(w * 0.15, h);
  ctx.lineTo(w * 0.55, 0);
  ctx.stroke();
}
