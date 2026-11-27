import * as THREE from 'three';
import type { DecalKind, SurfacePalette } from './Motif';

/** 異方性フィルタリング段数。デバイス上限でクランプされるため固定値で安全。 */
const TEX_ANISO = 8;

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
  | 'glass'
  | 'marble'
  | 'linoleum'
  | 'panel'
  | 'siding'
  | 'corrugated'
  | 'ceiling'
  | 'linen'
  | 'tatami';

/** モチーフで塗り分ける建築用テクスチャ。武器・制服の wood / metal / fabric は含めない。 */
const THEMED: ReadonlySet<TextureName> = new Set([
  'plaster', 'concrete', 'tile', 'carpet', 'brick', 'doorWood', 'doorFrame', 'frostedGlass', 'glass',
  'marble', 'linoleum', 'panel', 'siding', 'corrugated', 'ceiling', 'linen', 'tatami',
]);

const EXTRA: ReadonlySet<TextureName> = new Set(['marble', 'linoleum', 'panel', 'siding', 'corrugated', 'ceiling', 'linen', 'tatami']);

const WEBP_PLAIN: ReadonlySet<TextureName> = new Set(['faceA', 'faceB', 'fabric', 'concrete', 'wood', 'plaster']);

const KNOWN_MATERIALS: ReadonlySet<string> = new Set<TextureName>([
  'camo', 'fabric', 'metal', 'wood', 'tile', 'carpet', 'plaster', 'concrete', 'brick', 'skin', 'glass',
  'marble', 'linoleum', 'panel', 'siding', 'corrugated', 'ceiling', 'linen', 'tatami',
]);

/** デコード済み webp 画像のモジュールスコープキャッシュ。再生成・モチーフ切替時の再取得・再デコードを防ぐ。 */
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadCachedImage(url: string): Promise<HTMLImageElement | null> {
  const hit = imageCache.get(url);
  if (hit) return hit;
  if (typeof Image === 'undefined') {
    const empty = Promise.resolve(null);
    imageCache.set(url, empty);
    return empty;
  }
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

export function hexCss(n: number): string {
  return `#${(n >>> 0).toString(16).padStart(6, '0')}`;
}

function rgba(n: number, a: number): string {
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Canvas で作る共有テクスチャ。userData.shared を立て、disposeObject では解放しない。
 * シーン破棄の最後に dispose() する。
 */
export class TextureLibrary {
  private readonly textures = new Map<string, THREE.CanvasTexture>();
  private readonly derived = new Map<string, { bump: THREE.CanvasTexture; rough: THREE.CanvasTexture }>();
  private disposed = false;
  /** 建築面の塗り。武器・制服テクスチャには影響しない。 */
  palette: SurfacePalette | null = null;
  /** 扉の框・鏡板・枠の乗算色。未設定なら Door 側の既定色。 */
  doorTint?: { stile: number; panel: number; frame: number };

  /** マップ生成後、最初の get より前に呼ぶ。 */
  bindPalette(palette: SurfacePalette | null): void {
    this.palette = palette;
    this.doorTint = palette
      ? { stile: palette.doorA, panel: palette.doorB, frame: palette.frame }
      : undefined;
  }

  get(name: TextureName): THREE.CanvasTexture {
    const themed = this.palette !== null && THEMED.has(name);
    const key = themed ? `${this.palette!.id}:${name}` : name;
    const hit = this.textures.get(key);
    if (hit) return hit;
    const canvas = document.createElement('canvas');
    const garment = name === 'ally' || name === 'suspect' || name === 'civilian';
    canvas.width = 512;
    canvas.height = garment ? 384 : 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context を取得できません');
    paint(name, ctx, canvas.width, canvas.height, themed ? this.palette : null);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = TEX_ANISO;
    tex.userData.shared = true;
    // themed 時も実写 webp の肌理を multiply で重ねる（民家の落ち着いた質感を全モチーフへ）。
    // ロード前は手続き塗りが表示されるため破綻しない。
    const webp = themed ? themedWebpName(name, this.palette) : null;
    if (webp) {
      const url = import.meta.env.BASE_URL + 'textures/' + webp + '.webp';
      void loadCachedImage(url).then((image) => {
        if (!image || this.disposed) return;
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.45;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        ctx.restore();
        tex.needsUpdate = true;
        const d = this.derived.get(tex.uuid);
        if (d) d.bump.needsUpdate = true;
      });
    } else if (!themed && (garment || WEBP_PLAIN.has(name))) {
      const url = import.meta.env.BASE_URL + 'textures/' + name + '.webp';
      void loadCachedImage(url).then((image) => {
        if (!image || this.disposed) return;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        tex.needsUpdate = true;
        const d = this.derived.get(tex.uuid);
        if (d) d.bump.needsUpdate = true;
      });
    }
    this.textures.set(key, tex);
    return tex;
  }

  /** 壁・床に貼るデカール。クランプ。モチーフごとに 1 枚を共有する。 */
  getDecal(kind: DecalKind): THREE.CanvasTexture {
    const id = this.palette?.id ?? 'residence';
    const key = `decal:${id}:${kind}`;
    const hit = this.textures.get(key);
    if (hit) return hit;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context を取得できません');
    paintDecal(kind, ctx, canvas.width, canvas.height, this.palette);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = TEX_ANISO;
    tex.userData.shared = true;
    this.textures.set(key, tex);
    return tex;
  }

  /** マップ名からテクスチャ。未知の名前は plaster。 */
  byMaterial(name: string | undefined, fallback: TextureName): THREE.CanvasTexture {
    const key = name !== undefined && KNOWN_MATERIALS.has(name) ? (name as TextureName) : fallback;
    return this.get(key);
  }

  /** 同一 canvas から bump / roughness 共用の線形テクスチャを 1 枚だけ派生させる。キャッシュし userData.shared で共有扱いにする。 */
  getDerivedMaps(source: THREE.CanvasTexture): { bumpMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
    const hit = this.derived.get(source.uuid);
    if (hit) return { bumpMap: hit.bump, roughnessMap: hit.rough };
    const canvas = source.image as HTMLCanvasElement;
    const make = (): THREE.CanvasTexture => {
      const t = new THREE.CanvasTexture(canvas);
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = TEX_ANISO;
      t.userData.shared = true;
      return t;
    };
    const linear = make();
    const entry = { bump: linear, rough: linear };
    this.derived.set(source.uuid, entry);
    return { bumpMap: entry.bump, roughnessMap: entry.rough };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tex of this.textures.values()) tex.dispose();
    this.textures.clear();
    for (const d of this.derived.values()) d.bump.dispose();
    this.derived.clear();
  }
}

function paint(name: TextureName, ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette | null): void {
  if (pal && paintThemed(name, ctx, w, h, pal)) return;
  if (!pal && EXTRA.has(name)) {
    paintThemed(name, ctx, w, h, NEUTRAL_PALETTE);
    return;
  }
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
  // 建築外壁（航空機胴体等）で RepeatWrapping されるため、上下左右の境界が完全につながるシームレス塗りにする
  ctx.fillStyle = '#a4abb2';
  ctx.fillRect(0, 0, w, h);

  // 0..1 で同じ値に戻る対称・低コントラストの水平シマー（境界の不連続を防ぐ）
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(255,255,255,0.03)');
  g.addColorStop(0.25, 'rgba(0,0,0,0.025)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.03)');
  g.addColorStop(0.75, 'rgba(0,0,0,0.025)');
  g.addColorStop(1, 'rgba(255,255,255,0.03)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // h の約数周期（32px）の穏やかなブラッシュ帯（モアレ・境界ズレを避ける）
  const band = Math.max(16, Math.round(h / 16));
  for (let y = 0; y < h; y += band) {
    ctx.fillStyle = (y / band) % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(20,28,36,0.03)';
    ctx.fillRect(0, y, w, band / 2);
  }

  // 外板パネルの繊細な目地（タイル境界 0 と中央 w/2, h/2 に揃えてシームレス化）
  const px = Math.round(w / 2);
  const py = Math.round(h / 2);
  ctx.fillStyle = 'rgba(20,28,36,0.11)';
  ctx.fillRect(0, 0, w, 1);
  ctx.fillRect(0, py, w, 1);
  ctx.fillRect(0, 0, 1, h);
  ctx.fillRect(px, 0, 1, h);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(0, 1, w, 1);
  ctx.fillRect(0, py + 1, w, 1);
  ctx.fillRect(1, 0, 1, h);
  ctx.fillRect(px + 1, 0, 1, h);

  speckle(ctx, w, h, 48, 0xd8e0e8, 0.05);
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

const NEUTRAL_PALETTE: SurfacePalette = {
  id: 'neutral',
  wall: 0xd5d0c6, wallAlt: 0xc4bfb4, grout: 0xa8a298,
  tileA: 0xe6e1d4, tileB: 0xc9c3b4, carpetA: 0x6a3a3a, carpetB: 0x4a2828,
  woodA: 0x8d6238, woodB: 0x5c3b20, metalA: 0xb0b6bb, metalB: 0x5c6368,
  marbleA: 0xe8e4dc, marbleVein: 0xb0a898, brickA: 0xa35242, brickB: 0x8a4034, mortar: 0x6d5a52,
  ceiling: 0xd5d0c6, ceilingLine: 0xb8b2a6, linenA: 0xd8d2c4, linenB: 0xb8b0a0,
  accent: 0x8a7048, concrete: 0x6a6e72, doorA: 0x7c5536, doorB: 0x69462b, frame: 0x3d2a1c,
  wallStyle: 'plaster', ceilingStyle: 'acoustic', signText: 'SITE',
};

function mixHex(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return (r << 16) | (g << 8) | bl;
}

/** themed 時に実写肌理として重ねる webp 名。無い面は null。 */
function themedWebpName(name: TextureName, pal: SurfacePalette | null): string | null {
  if (name === 'plaster') return 'plaster';
  if (name === 'concrete') return 'concrete';
  if (name === 'panel') return pal?.wallStyle === 'wood' ? 'wood' : 'plaster';
  if (name === 'ceiling') return 'plaster';
  return null;
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, n: number, color: number, alpha: number): void {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rgba(i % 2 === 0 ? color : 0x000000, alpha * (0.35 + (i % 5) * 0.12));
    ctx.fillRect((i * 17) % w, (i * 29) % h, 1 + (i % 3), 1 + (i % 2));
  }
}

/** モチーフ色で建築テクスチャを塗る。対象外の名前は false。 */
function paintThemed(name: TextureName, ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): boolean {
  if (name === 'panel') return paintPanel(ctx, w, h, pal), true;
  if (name === 'plaster') return fillMottle(ctx, w, h, pal.wall, pal.wallAlt), true;
  if (name === 'concrete') return paintConcrete(ctx, w, h, pal), true;
  if (name === 'tile') return paintTilePalette(ctx, w, h, pal.tileA, pal.tileB, pal.grout), true;
  if (name === 'linoleum') return paintLinoleum(ctx, w, h, pal), true;
  if (name === 'carpet') return paintCarpet(ctx, w, h, pal), true;
  if (name === 'tatami') return paintTatami(ctx, w, h), true;
  if (name === 'marble') return paintMarble(ctx, w, h, pal), true;
  if (name === 'brick') return paintBrickPalette(ctx, w, h, pal), true;
  if (name === 'siding') return paintSiding(ctx, w, h, pal), true;
  if (name === 'corrugated') return paintCorrugated(ctx, w, h, pal), true;
  if (name === 'ceiling') return paintCeiling(ctx, w, h, pal), true;
  if (name === 'linen') return paintLinen(ctx, w, h, pal), true;
  if (name === 'doorWood' || name === 'doorFrame') return paintDoorGray(ctx, w, h), true;
  if (name === 'glass' || name === 'frostedGlass') return paintGlassPalette(ctx, w, h, pal, name === 'frostedGlass'), true;
  return false;
}

function fillMottle(ctx: CanvasRenderingContext2D, w: number, h: number, base: number, alt: number): void {
  ctx.fillStyle = hexCss(base);
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = rgba(i % 3 === 0 ? alt : base, 0.18);
    ctx.fillRect((i * 13) % w, (i * 19) % h, 4 + (i % 6), 3);
  }
  speckle(ctx, w, h, 40, alt, 0.15);
}

function paintPanel(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  if (pal.wallStyle === 'clinical') {
    ctx.fillStyle = hexCss(pal.wall);
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = rgba(pal.grout, 0.35);
    ctx.lineWidth = 2;
    for (let y = 0; y <= h; y += 128) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (let x = 0; x <= w; x += 172) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    speckle(ctx, w, h, 30, pal.accent, 0.08);
    return;
  }
  if (pal.wallStyle === 'wood') {
    ctx.fillStyle = hexCss(pal.woodB);
    ctx.fillRect(0, 0, w, h);
    const boards = 7;
    const bw = w / boards;
    for (let i = 0; i < boards; i++) {
      ctx.fillStyle = hexCss(i % 2 === 0 ? pal.woodA : pal.woodB);
      ctx.fillRect(i * bw + 1, 0, bw - 2, h);
      ctx.fillStyle = rgba(0x000000, 0.12);
      ctx.fillRect(i * bw, 0, 2, h);
    }
    return;
  }
  if (pal.wallStyle === 'stone') {
    paintBrickPalette(ctx, w, h, { ...pal, brickA: pal.marbleA, brickB: pal.wallAlt, mortar: pal.grout });
    return;
  }
  if (pal.wallStyle === 'metal') {
    paintCorrugated(ctx, w, h, pal);
    return;
  }
  fillMottle(ctx, w, h, pal.wall, pal.wallAlt);
}

function paintTilePalette(ctx: CanvasRenderingContext2D, w: number, h: number, a: number, b: number, grout: number): void {
  ctx.fillStyle = hexCss(grout);
  ctx.fillRect(0, 0, w, h);
  const n = 4;
  const tw = w / n;
  const th = h / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const stain = (x * 3 + y * 5) % 7 === 0;
      // grout との輝度差を抑えるためタイル色を目地へ少し寄せる
      ctx.fillStyle = hexCss(mixHex(stain ? b : (x + y) % 2 === 0 ? a : b, grout, 0.15));
      ctx.fillRect(x * tw + 2, y * th + 2, tw - 4, th - 4);
      if (stain) {
        ctx.fillStyle = rgba(0x000000, 0.05);
        ctx.beginPath();
        ctx.ellipse(x * tw + tw * 0.5, y * th + th * 0.55, tw * 0.22, th * 0.12, 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function paintLinoleum(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  ctx.fillStyle = hexCss(pal.tileA);
  ctx.fillRect(0, 0, w, h);
  speckle(ctx, w, h, 120, pal.tileB, 0.15);
}

function paintCarpet(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  ctx.fillStyle = hexCss(pal.carpetA);
  ctx.fillRect(0, 0, w, h);
  // 2px 行縞と縁取りはモアレ源のため廃止し、大まかな濃淡まだら＋微細 speckle のみにする
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = rgba(pal.carpetB, 0.08);
    ctx.beginPath();
    ctx.ellipse((i * 97) % w, (i * 61) % h, 48 + (i % 4) * 18, 32 + (i % 3) * 14, i * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
  speckle(ctx, w, h, 120, pal.linenA, 0.1);
}

/** い草の目と布縁。民家の座敷・寝室用。 */
function paintTatami(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#6f934c';
  ctx.fillRect(0, 0, w, h);
  // 縦ラインは周期を広げ輝度差 10% 以内に緩和。布縁・帯はタイリングで反復するため削除
  for (let x = 0; x < w; x += 12) {
    ctx.fillStyle = x % 24 === 0 ? 'rgba(40,62,24,0.10)' : 'rgba(210,230,160,0.07)';
    ctx.fillRect(x, 0, 2, h);
  }
  for (let y = 0; y < h; y += 128) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, y, w, 2);
  }
}

function paintMarble(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  ctx.fillStyle = hexCss(pal.marbleA);
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = rgba(pal.marbleVein, 0.55);
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo((i * 40) % w, 0);
    ctx.bezierCurveTo(w * 0.3, h * (0.2 + i * 0.08), w * 0.7, h * (0.5 - i * 0.05), w, (h * (0.15 * i)) % h);
    ctx.stroke();
  }
  speckle(ctx, w, h, 20, pal.marbleVein, 0.08);
}

function paintBrickPalette(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  ctx.fillStyle = hexCss(pal.mortar);
  ctx.fillRect(0, 0, w, h);
  const bh = 36;
  const bw = 80;
  for (let y = 0; y < h; y += bh) {
    const off = Math.round(y / bh) % 2 === 0 ? 0 : bw / 2;
    for (let x = -bw; x < w; x += bw) {
      ctx.fillStyle = hexCss((x + y) % 160 === 0 ? pal.brickB : pal.brickA);
      ctx.fillRect(x + off + 1, y + 1, bw - 3, bh - 3);
    }
  }
}

function paintSiding(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  ctx.fillStyle = hexCss(pal.woodB);
  ctx.fillRect(0, 0, w, h);
  const row = 28;
  for (let y = 0; y < h; y += row) {
    ctx.fillStyle = hexCss(y % (row * 2) === 0 ? pal.woodA : pal.woodB);
    ctx.fillRect(0, y, w, row - 3);
    ctx.fillStyle = rgba(0x000000, 0.12);
    ctx.fillRect(0, y + row - 3, w, 3);
  }
}

function paintCorrugated(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  ctx.fillStyle = hexCss(pal.metalB);
  ctx.fillRect(0, 0, w, h);
  const rib = 20;
  for (let x = 0; x < w; x += rib) {
    // リブの明暗差を輝度差 20% 以内に抑える（全面切替にしない）
    ctx.fillStyle = rgba(pal.metalA, 0.35);
    ctx.fillRect(x, 0, rib / 2, h);
  }
  speckle(ctx, w, h, 25, 0x402010, 0.12);
}

function paintConcrete(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  fillMottle(ctx, w, h, pal.concrete, pal.metalB);
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = rgba(0x000000, 0.12);
    ctx.beginPath();
    ctx.arc((i * 37) % w, (i * 53) % h, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintCeiling(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  ctx.fillStyle = hexCss(pal.ceiling);
  ctx.fillRect(0, 0, w, h);
  if (pal.ceilingStyle === 'wood') {
    paintSiding(ctx, w, h, pal);
    return;
  }
  if (pal.ceilingStyle === 'exposed') {
    ctx.fillStyle = hexCss(pal.ceiling);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = hexCss(pal.metalB);
    for (let x = 16; x < w; x += 84) ctx.fillRect(x, 0, 16, h);
    ctx.fillStyle = rgba(pal.accent, 0.25);
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const n = pal.ceilingStyle === 'coffer' ? 2 : pal.ceilingStyle === 'tile' ? 4 : 3;
  const tw = w / n;
  const th = h / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = hexCss((x + y) % 2 === 0 ? pal.ceiling : mixHex(pal.ceiling, 0x000000, 0.06));
      const inset = pal.ceilingStyle === 'coffer' ? 8 : 2;
      ctx.fillRect(x * tw + inset, y * th + inset, tw - inset * 2, th - inset * 2);
      ctx.strokeStyle = hexCss(pal.ceilingLine);
      ctx.strokeRect(x * tw + 0.5, y * th + 0.5, tw - 1, th - 1);
    }
  }
}

function paintLinen(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette): void {
  ctx.fillStyle = hexCss(pal.linenA);
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = rgba(pal.linenB, 0.35);
  ctx.lineWidth = 1;
  for (let y = 0; y < h; y += 12) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = rgba(pal.accent, 0.08);
    ctx.fillRect((i * 23) % w, (i * 41) % h, 10, 3);
  }
}

/** 扉はグレースケールの木目にして、Door 側の乗算色でモチーフ色にする。 */
function paintDoorGray(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#b4b4b4';
  ctx.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += 16) {
    ctx.fillStyle = x % 32 === 0 ? 'rgba(40,40,40,0.12)' : 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, 0, 3, h);
  }
  // Door の BoxGeometry は面ごとに UV 0..1 のため框・鏡板はタイリングされず維持する
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 10;
  ctx.strokeRect(16, 16, w - 32, h * 0.38);
  ctx.strokeRect(16, h * 0.5, w - 32, h * 0.38);
}

function paintGlassPalette(ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette, frosted: boolean): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, rgba(pal.wall, frosted ? 0.72 : 0.45));
  g.addColorStop(1, rgba(pal.accent, frosted ? 0.55 : 0.28));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  if (frosted) speckle(ctx, w, h, 80, 0xffffff, 0.12);
}

function paintDecal(kind: DecalKind, ctx: CanvasRenderingContext2D, w: number, h: number, pal: SurfacePalette | null): void {
  const accent = pal?.accent ?? 0xc4a060;
  const sign = pal?.signText ?? 'SITE';
  ctx.clearRect(0, 0, w, h);
  if (kind === 'blood') {
    ctx.fillStyle = 'rgba(120,16,16,0.82)';
    ctx.beginPath();
    ctx.ellipse(w * 0.48, h * 0.52, w * 0.28, h * 0.18, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(90,8,8,0.7)';
    ctx.beginPath();
    ctx.ellipse(w * 0.62, h * 0.4, w * 0.12, h * 0.1, -0.6, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (kind === 'dirt') {
    ctx.fillStyle = 'rgba(70,52,32,0.55)';
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.ellipse((40 + i * 27) % w, (30 + i * 33) % h, 18 + (i % 4) * 6, 10 + (i % 3) * 4, i, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (kind === 'scuff') {
    ctx.strokeStyle = 'rgba(20,20,20,0.45)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(20, 40 + i * 36);
      ctx.bezierCurveTo(w * 0.4, 20 + i * 30, w * 0.6, 80 + i * 20, w - 16, 50 + i * 28);
      ctx.stroke();
    }
    return;
  }
  if (kind === 'hazard' || kind === 'stripe') {
    const stripe = kind === 'hazard' ? 22 : 28;
    for (let x = -h; x < w + h; x += stripe) {
      ctx.fillStyle = (Math.floor(x / stripe) % 2 === 0) ? '#c8982a' : '#2a2a28';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + h * 0.45, 0);
      ctx.lineTo(x + h * 0.45 + h, h);
      ctx.lineTo(x + h, h);
      ctx.fill();
    }
    return;
  }
  if (kind === 'medcross') {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(w * 0.18, h * 0.18, w * 0.64, h * 0.64);
    ctx.fillStyle = hexCss(accent);
    ctx.fillRect(w * 0.4, h * 0.26, w * 0.2, h * 0.48);
    ctx.fillRect(w * 0.26, h * 0.4, w * 0.48, h * 0.2);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 4;
    ctx.strokeRect(w * 0.18, h * 0.18, w * 0.64, h * 0.64);
    return;
  }
  if (kind === 'vault') {
    ctx.strokeStyle = hexCss(accent);
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 4;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(w / 2 + Math.cos(a) * w * 0.26, h / 2 + Math.sin(a) * h * 0.26);
      ctx.lineTo(w / 2 + Math.cos(a) * w * 0.36, h / 2 + Math.sin(a) * h * 0.36);
      ctx.stroke();
    }
    ctx.fillStyle = hexCss(accent);
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VAULT', w / 2, h / 2);
    return;
  }
  if (kind === 'graffiti') {
    ctx.strokeStyle = rgba(accent, 0.55);
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(24, h * 0.65);
    ctx.quadraticCurveTo(w * 0.3, h * 0.2, w * 0.55, h * 0.55);
    ctx.quadraticCurveTo(w * 0.75, h * 0.85, w - 20, h * 0.35);
    ctx.stroke();
    ctx.fillStyle = rgba(accent, 0.5);
    ctx.font = 'bold 42px sans-serif';
    ctx.fillText(sign.slice(0, 4), 28, h * 0.45);
    return;
  }
  // poster / sign
  ctx.fillStyle = 'rgba(232,226,214,0.88)';
  ctx.fillRect(18, 16, w - 36, h - 32);
  ctx.fillStyle = hexCss(accent);
  ctx.fillRect(18, 16, w - 36, 18);
  ctx.fillStyle = '#1a1a1a';
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(sign, w / 2, h * 0.48);
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#444';
  const sub =
    pal?.id === 'hospital'
      ? 'EMERGENCY'
      : pal?.id === 'bank'
        ? 'RESTRICTED'
        : pal?.id === 'embassy'
          ? 'DIPLOMATIC'
          : pal?.id === 'japanese_house' || pal?.id === 'residence'
            ? ''
            : 'AUTHORIZED';
  if (sub) ctx.fillText(sub, w / 2, h * 0.68);
}
