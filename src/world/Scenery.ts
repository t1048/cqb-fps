import * as THREE from 'three';
import type { BoxDef } from '../core/types';
import type { TextureName } from './Materials';

const DEG = Math.PI / 180;

/** WorldBuilder が破棄するマテリアルを返す。opacity < 1 はガラス。 */
export type SceneMat = (name: TextureName, color: number, opacity?: number) => THREE.Material;

/** 箱ではなく部品メッシュで描く小道具。 */
export const SCENERY_PROPS: ReadonlySet<string> = new Set([
  'bed', 'hbed', 'piano', 'stretcher', 'ivstand', 'curtain', 'medcab', 'bar', 'sofa', 'table', 'low_table',
  'teller', 'vault', 'bench', 'column', 'desk', 'chair', 'partition', 'shelf', 'metal_rack', 'tool_shelf',
  'pallet', 'container', 'crates', 'toilet', 'sink', 'stall', 'rail', 'wardrobe', 'fridge', 'bathtub',
  'counter', 'tv_board', 'lamp', 'engawa', 'post', 'planter', 'island', 'banquet_table', 'dining_table', 'conf_table',
]);

type Builder = (g: THREE.Group, def: BoxDef, mat: SceneMat) => void;

function box(g: THREE.Group, material: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): void {
  if (w < 0.008 || h < 0.008 || d < 0.008) return;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  g.add(mesh);
}

function cyl(g: THREE.Group, material: THREE.Material, r: number, h: number, x: number, y: number, z: number, axis: 'y' | 'x' | 'z' = 'y'): void {
  if (r < 0.004 || h < 0.008) return;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), material);
  mesh.position.set(x, y, z);
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  g.add(mesh);
}

function bed(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xffffff);
  const linen = mat('linen', 0xffffff);
  const blanket = mat('linen', 0xa06048);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) box(g, wood, 0.07, h * 0.34, 0.07, x * w * 0.42, h * 0.17, z * d * 0.38);
  }
  box(g, wood, w * 0.88, 0.06, d * 0.8, 0, h * 0.36, 0);
  box(g, linen, w * 0.8, h * 0.24, d * 0.7, 0, h * 0.5, d * 0.02);
  box(g, blanket, w * 0.8, h * 0.1, d * 0.38, 0, h * 0.6, d * 0.16);
  box(g, wood, w * 0.94, h * 1.05, 0.07, 0, h * 0.55, -d * 0.44);
  box(g, wood, w * 0.9, h * 0.28, 0.05, 0, h * 0.48, d * 0.42);
  box(g, linen, w * 0.26, h * 0.14, d * 0.18, -w * 0.16, h * 0.66, -d * 0.22);
  box(g, linen, w * 0.26, h * 0.14, d * 0.18, w * 0.16, h * 0.66, -d * 0.22);
}

/** 病棟用。金属フレーム、キャスター、サイドレール、白い寝台。 */
function hbed(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const metal = mat('metal', 0xd5dee6);
  const linen = mat('linen', 0xdfe4de);
  const rail = mat('metal', 0x6fa89c);
  box(g, metal, w * 0.86, 0.05, d * 0.78, 0, h * 0.42, 0);
  box(g, linen, w * 0.78, h * 0.18, d * 0.68, 0, h * 0.52, d * 0.02);
  box(g, linen, w * 0.72, h * 0.16, d * 0.22, 0, h * 0.66, -d * 0.18);
  box(g, metal, w * 0.84, h * 0.55, 0.04, 0, h * 0.72, -d * 0.4);
  box(g, rail, w * 0.5, 0.035, 0.03, 0, h * 0.7, d * 0.36);
  box(g, rail, w * 0.5, 0.035, 0.03, 0, h * 0.7, -d * 0.22);
  for (const x of [-1, 1]) {
    box(g, metal, 0.035, h * 0.28, 0.035, x * w * 0.38, h * 0.7, d * 0.36);
    box(g, metal, 0.035, h * 0.28, 0.035, x * w * 0.38, h * 0.7, -d * 0.22);
    for (const z of [-1, 1]) {
      cyl(g, metal, 0.055, 0.04, x * w * 0.36, 0.06, z * d * 0.32, 'x');
      box(g, metal, 0.04, h * 0.36, 0.04, x * w * 0.36, h * 0.2, z * d * 0.32);
    }
  }
}

function piano(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const body = mat('wood', 0xffffff);
  const wood = mat('wood', 0xdcc9a8);
  const keys = mat('plaster', 0xe8e4da);
  const black = mat('metal', 0x2e2e30);
  const brass = mat('metal', 0xe6c56b);
  box(g, body, w * 0.96, h * 0.9, d * 0.58, 0, h * 0.48, -d * 0.14);
  box(g, wood, w, h * 0.045, d * 0.66, 0, h * 0.94, -d * 0.1);
  box(g, keys, w * 0.78, h * 0.045, d * 0.32, 0, h * 0.46, d * 0.28);
  box(g, wood, w * 0.82, h * 0.07, d * 0.08, 0, h * 0.52, d * 0.12);
  for (let i = -4; i <= 4; i++) {
    if (Math.abs(i) === 2) continue;
    box(g, black, w * 0.028, h * 0.03, d * 0.14, i * w * 0.078, h * 0.5, d * 0.22);
  }
  box(g, wood, w * 0.5, h * 0.2, 0.025, 0, h * 0.7, d * 0.14);
  for (const x of [-0.12, 0, 0.12]) box(g, brass, 0.028, 0.012, 0.07, x, h * 0.08, d * 0.18);
  box(g, body, w * 0.88, h * 0.05, d * 0.5, 0, h * 0.04, -d * 0.1);
}

function stretcher(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const metal = mat('metal', 0xffffff);
  const pad = mat('linen', 0xcfd8d2);
  box(g, metal, w * 0.92, 0.04, d * 0.12, 0, h * 0.55, -d * 0.38);
  box(g, metal, w * 0.92, 0.04, d * 0.12, 0, h * 0.55, d * 0.38);
  box(g, pad, w * 0.78, h * 0.16, d * 0.7, 0, h * 0.66, 0);
  box(g, linenMat(mat), w * 0.7, 0.02, d * 0.22, 0, h * 0.76, -d * 0.12);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      cyl(g, metal, 0.06, 0.05, x * w * 0.38, 0.08, z * d * 0.36, 'x');
      box(g, metal, 0.04, h * 0.48, 0.04, x * w * 0.38, h * 0.28, z * d * 0.36);
    }
  }
}

function linenMat(mat: SceneMat): THREE.Material {
  return mat('linen', 0xdfe4de);
}

function ivstand(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { height: h } = def;
  const metal = mat('metal', 0xd5dde4);
  const bag = mat('linen', 0xdff5ea);
  cyl(g, metal, 0.18, 0.04, 0, 0.03, 0);
  cyl(g, metal, 0.025, h * 0.86, 0, h * 0.46, 0);
  box(g, metal, 0.36, 0.02, 0.02, 0, h * 0.9, 0);
  box(g, bag, 0.12, 0.18, 0.04, 0.12, h * 0.72, 0);
}

function curtain(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const metal = mat('metal', 0xc5ccd2);
  const cloth = mat('linen', 0xd3dcd6);
  box(g, metal, w, 0.04, d, 0, h - 0.03, 0);
  box(g, cloth, w * 0.46, h * 0.86, d * 0.7, -w * 0.24, h * 0.44, 0);
  box(g, cloth, w * 0.46, h * 0.86, d * 0.7, w * 0.24, h * 0.44, 0);
}

function medcab(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const body = mat('metal', 0xdde2e2);
  const glass = mat('glass', 0xd5eee8, 0.45);
  const cross = mat('linen', 0x2a7a52);
  box(g, body, w, h * 0.92, d * 0.86, 0, h * 0.48, -d * 0.04);
  box(g, glass, w * 0.38, h * 0.62, 0.02, -w * 0.22, h * 0.52, d * 0.42);
  box(g, glass, w * 0.38, h * 0.62, 0.02, w * 0.22, h * 0.52, d * 0.42);
  box(g, cross, w * 0.08, h * 0.28, 0.025, 0, h * 0.55, d * 0.44);
  box(g, cross, w * 0.22, h * 0.08, 0.025, 0, h * 0.55, d * 0.44);
}

function bar(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xe8dcc4);
  const front = mat('wood', 0xffffff);
  const metal = mat('metal', 0xc8a860);
  box(g, front, w, h * 0.7, d * 0.82, 0, h * 0.35, 0);
  box(g, wood, w * 1.04, h * 0.1, d * 1.05, 0, h * 0.74, 0.02);
  cyl(g, metal, 0.035, w * 0.86, 0, h * 0.28, d * 0.46, 'x');
  for (const x of [-0.28, -0.1, 0.1, 0.28]) {
    const bottle = mat('glass', 0xd8f5c8, 0.72);
    cyl(g, bottle, 0.045, h * 0.28, x * w, h * 0.96, -d * 0.08);
  }
}

function sofa(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const cloth = mat('fabric', 0xffffff);
  const seat = mat('linen', 0xd0ccc2);
  const leg = mat('wood', 0x4a3428);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) box(g, leg, 0.06, h * 0.16, 0.06, x * w * 0.42, h * 0.08, z * d * 0.36);
  }
  box(g, cloth, w * 0.92, h * 0.28, d * 0.84, 0, h * 0.32, d * 0.02);
  box(g, cloth, w * 0.96, h * 0.48, d * 0.18, 0, h * 0.66, -d * 0.38);
  box(g, cloth, d * 0.18, h * 0.42, d * 0.62, -w * 0.44, h * 0.5, d * 0.02);
  box(g, cloth, d * 0.18, h * 0.42, d * 0.62, w * 0.44, h * 0.5, d * 0.02);
  box(g, seat, w * 0.36, h * 0.1, d * 0.42, -w * 0.18, h * 0.5, d * 0.06);
  box(g, seat, w * 0.36, h * 0.1, d * 0.42, w * 0.18, h * 0.5, d * 0.06);
}

function table(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xffffff);
  box(g, wood, w, Math.min(0.06, h * 0.14), d, 0, h - 0.03, 0);
  const leg = Math.max(0.04, Math.min(w, d) * 0.08);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      box(g, wood, leg, h - 0.06, leg, x * (w / 2 - leg), (h - 0.06) / 2, z * (d / 2 - leg));
    }
  }
}

function teller(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const stone = mat('marble', 0xffffff);
  const metal = mat('metal', 0xd8dee6);
  const glass = mat('glass', 0xd5e4f0, 0.38);
  const slot = mat('metal', 0x2a3038);
  box(g, stone, w, h * 0.58, d * 0.9, 0, h * 0.29, 0);
  box(g, stone, w * 1.02, 0.06, d, 0, h * 0.62, 0);
  box(g, slot, w * 0.34, 0.045, d * 0.16, 0, h * 0.55, d * 0.4);
  box(g, metal, 0.045, h * 0.78, 0.045, -w * 0.38, h * 0.98, d * 0.02);
  box(g, metal, 0.045, h * 0.78, 0.045, w * 0.38, h * 0.98, d * 0.02);
  box(g, glass, w * 0.7, h * 0.62, 0.02, 0, h * 1.02, d * 0.02);
  box(g, metal, w * 0.76, 0.04, 0.05, 0, h * 1.34, d * 0.02);
}

function vault(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const metal = mat('metal', 0xc5ccd4);
  const dark = mat('metal', 0x6e7680);
  box(g, dark, w, h, d * 0.35, 0, h / 2, -d * 0.2);
  box(g, metal, w * 0.78, h * 0.82, d * 0.7, 0, h * 0.48, d * 0.05);
  cyl(g, dark, Math.min(w, h) * 0.16, d * 0.2, 0, h * 0.48, d * 0.42, 'z');
  for (const y of [0.3, 0.5, 0.7]) {
    cyl(g, dark, 0.035, d * 0.12, w * 0.28, h * y, d * 0.4, 'z');
  }
}

function bench(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xffffff);
  const metal = mat('metal', 0xb7bdc4);
  box(g, wood, w, h * 0.12, d * 0.9, 0, h * 0.48, 0);
  box(g, wood, w, h * 0.42, d * 0.12, 0, h * 0.72, -d * 0.38);
  for (const x of [-w * 0.38, w * 0.38]) {
    box(g, metal, 0.05, h * 0.46, 0.05, x, h * 0.23, 0);
  }
}

function column(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const stone = mat('marble', 0xffffff);
  const r = Math.min(w, d) * 0.42;
  box(g, stone, w, h * 0.08, d, 0, h * 0.04, 0);
  box(g, stone, w * 1.05, h * 0.07, d * 1.05, 0, h * 0.94, 0);
  cyl(g, stone, r, h * 0.78, 0, h * 0.48, 0);
}

function desk(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xffffff);
  const screen = mat('metal', 0x243040);
  box(g, wood, w, 0.05, d, 0, h - 0.03, 0);
  box(g, wood, w * 0.28, h - 0.08, d * 0.86, -w * 0.32, (h - 0.08) / 2, 0);
  box(g, wood, 0.05, h - 0.08, d * 0.8, w * 0.4, (h - 0.08) / 2, 0);
  box(g, screen, w * 0.22, h * 0.32, 0.03, w * 0.12, h + h * 0.14, -d * 0.12);
  box(g, mat('metal', 0x9aa3ad), 0.04, h * 0.08, 0.04, w * 0.12, h + 0.01, -d * 0.12);
}

function chair(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xffffff);
  const cloth = mat('fabric', 0xffffff);
  box(g, cloth, w * 0.86, 0.06, d * 0.86, 0, h * 0.48, 0);
  box(g, cloth, w * 0.84, h * 0.42, 0.05, 0, h * 0.74, -d * 0.4);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      box(g, wood, 0.04, h * 0.46, 0.04, x * w * 0.38, h * 0.23, z * d * 0.38);
    }
  }
}

function partition(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const panel = mat('panel', 0xdde2e8);
  const metal = mat('metal', 0x5d6b7a);
  const cap = mat('metal', 0x2f6f9f);
  const footD = Math.max(d, 0.1);
  box(g, metal, 0.08, h * 0.14, footD, -w * 0.42, h * 0.07, 0);
  box(g, metal, 0.08, h * 0.14, footD, w * 0.42, h * 0.07, 0);
  box(g, metal, 0.04, h * 0.78, 0.04, -w * 0.46, h * 0.48, 0);
  box(g, metal, 0.04, h * 0.78, 0.04, w * 0.46, h * 0.48, 0);
  box(g, panel, w * 0.86, h * 0.58, Math.max(d * 0.7, 0.03), 0, h * 0.48, 0);
  box(g, cap, w * 0.96, 0.045, Math.max(d, 0.06), 0, h * 0.84, 0);
}

function shelf(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const metal = mat('metal', 0xffffff);
  box(g, metal, 0.05, h, d * 0.9, -w * 0.46, h / 2, 0);
  box(g, metal, 0.05, h, d * 0.9, w * 0.46, h / 2, 0);
  for (let i = 1; i <= 4; i++) {
    box(g, metal, w * 0.92, 0.03, d * 0.86, 0, h * (i / 5), 0);
  }
  box(g, mat('wood', 0xc4a574), w * 0.28, h * 0.12, d * 0.5, -w * 0.12, h * 0.28, 0);
}

function pallet(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xd7b07a);
  for (const z of [-d * 0.32, 0, d * 0.32]) box(g, wood, w, h * 0.35, d * 0.12, 0, h * 0.2, z);
  for (const x of [-w * 0.32, 0, w * 0.32]) box(g, wood, w * 0.1, h * 0.45, d * 0.9, x, h * 0.62, 0);
}

function container(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const metal = mat('corrugated', 0xffffff);
  const dark = mat('metal', 0x3d4450);
  box(g, metal, w * 0.92, h * 0.88, d * 0.92, 0, h * 0.48, 0);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) box(g, dark, 0.07, h * 0.96, 0.07, x * w * 0.46, h * 0.48, z * d * 0.46);
  }
  for (const y of [0.28, 0.5, 0.72]) box(g, dark, w * 0.9, 0.025, 0.02, 0, h * y, d * 0.48);
  box(g, dark, 0.025, h * 0.62, 0.02, 0, h * 0.48, d * 0.49);
  box(g, dark, w * 0.16, 0.05, 0.03, w * 0.22, h * 0.48, d * 0.49);
}

function toilet(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const ceramic = mat('plaster', 0xdfe0da);
  box(g, ceramic, w * 0.7, h * 0.42, d * 0.55, 0, h * 0.28, -d * 0.08);
  cyl(g, ceramic, Math.min(w, d) * 0.28, h * 0.16, 0, h * 0.52, d * 0.05);
  box(g, ceramic, w * 0.62, h * 0.08, d * 0.48, 0, h * 0.62, d * 0.02);
  box(g, ceramic, w * 0.55, h * 0.32, d * 0.22, 0, h * 0.78, -d * 0.32);
}

function sink(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const ceramic = mat('plaster', 0xdfe0da);
  const metal = mat('metal', 0xd5dbe2);
  box(g, ceramic, w * 0.28, h * 0.7, d * 0.28, 0, h * 0.35, 0);
  box(g, ceramic, w * 0.9, h * 0.16, d * 0.7, 0, h * 0.74, 0);
  box(g, ceramic, w * 0.55, h * 0.08, d * 0.35, 0, h * 0.84, d * 0.05);
  cyl(g, metal, 0.015, h * 0.22, 0, h * 0.95, -d * 0.05);
  box(g, metal, 0.08, 0.02, 0.04, 0, h * 0.95, d * 0.02);
}

function stall(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const panel = mat('plaster', 0xd8dcd8);
  const metal = mat('metal', 0x8e9894);
  box(g, panel, w, h * 0.78, d, 0, h * 0.52, 0);
  box(g, metal, w, 0.04, d * 1.2, 0, h * 0.92, 0);
  box(g, metal, 0.04, h * 0.9, d * 1.15, -w * 0.48, h * 0.48, 0);
}

function rail(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const metal = mat('metal', 0xd5dbe3);
  const alongX = w >= d;
  const length = alongX ? w : d;
  const thick = Math.max(alongX ? d : w, 0.04);
  box(g, metal, alongX ? length : thick, 0.04, alongX ? thick : length, 0, h - 0.03, 0);
  box(g, metal, alongX ? length : thick * 0.6, 0.025, alongX ? thick * 0.6 : length, 0, h * 0.48, 0);
  const posts = Math.max(2, Math.round(length / 0.75));
  for (let i = 0; i < posts; i++) {
    const t = posts === 1 ? 0 : -length / 2 + (length * i) / (posts - 1);
    box(g, metal, 0.035, h, 0.035, alongX ? t : 0, h / 2, alongX ? 0 : t);
  }
}

function wardrobe(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xffffff);
  const door = mat('wood', 0xb08d5e);
  box(g, wood, w, h, d * 0.86, 0, h / 2, -d * 0.04);
  box(g, mat('wood', 0x5c4030), w, 0.04, d * 0.2, 0, h * 0.96, d * 0.4);
  box(g, door, w * 0.46, h * 0.82, 0.04, -w * 0.24, h * 0.48, d * 0.44);
  box(g, door, w * 0.46, h * 0.82, 0.04, w * 0.24, h * 0.48, d * 0.44);
  box(g, mat('wood', 0x3d2a1c), 0.03, h * 0.82, 0.02, 0, h * 0.48, d * 0.47);
}

function fridge(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const metal = mat('metal', 0xd0d4d8);
  box(g, metal, w, h * 0.62, d, 0, h * 0.68, 0);
  box(g, metal, w, h * 0.32, d, 0, h * 0.16, 0);
  box(g, mat('metal', 0x9aa3ad), w * 0.08, 0.28, 0.03, w * 0.36, h * 0.62, d * 0.5);
}

function bathtub(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const ceramic = mat('plaster', 0xd8dcd8);
  box(g, ceramic, w, h * 0.7, d, 0, h * 0.35, 0);
  box(g, mat('glass', 0xd5e8ee, 0.35), w * 0.7, h * 0.18, d * 0.55, 0, h * 0.62, 0);
  cyl(g, mat('metal', 0xd5dbe2), 0.02, h * 0.28, -w * 0.28, h * 0.85, -d * 0.2);
}

function counter(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xffffff);
  const top = mat('wood', 0xc9b48e);
  const metal = mat('metal', 0xd5dbe2);
  box(g, wood, w * 0.96, h * 0.72, d * 0.9, 0, h * 0.36, 0);
  box(g, mat('wood', 0x5c4030), 0.02, h * 0.62, 0.02, 0, h * 0.34, d * 0.42);
  box(g, top, w, h * 0.08, d, 0, h * 0.76, 0);
  box(g, mat('plaster', 0xe8e4dc), w * 0.28, 0.04, d * 0.42, w * 0.22, h * 0.78, 0);
  box(g, mat('metal', 0x8a9094), w * 0.16, 0.03, d * 0.22, w * 0.22, h * 0.8, 0);
  cyl(g, metal, 0.015, h * 0.22, w * 0.22, h * 0.92, -d * 0.12);
  box(g, wood, w, h * 0.18, 0.04, 0, h * 0.88, -d * 0.48);
}

function planter(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0x8a6f52);
  const darkWood = mat('wood', 0x5c4632);
  const soil = mat('wood', 0x4a3828);
  const foliage = mat('linen', 0x5f7d4f);
  const foliageDark = mat('linen', 0x49663e);
  box(g, wood, w * 0.92, h * 0.52, d * 0.92, 0, h * 0.26, 0);
  box(g, darkWood, w, h * 0.1, d, 0, h * 0.55, 0);
  box(g, soil, w * 0.82, h * 0.06, d * 0.82, 0, h * 0.62, 0);
  cyl(g, foliageDark, Math.min(w, d) * 0.16, h * 0.34, 0, h * 0.78, 0);
  box(g, foliage, w * 0.52, h * 0.3, d * 0.52, -w * 0.12, h * 0.82, -d * 0.08);
  box(g, foliageDark, w * 0.42, h * 0.24, d * 0.42, w * 0.16, h * 0.78, d * 0.14);
  box(g, foliage, w * 0.3, h * 0.2, d * 0.3, w * 0.05, h * 0.92, -d * 0.16);
}

function engawa(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xffffff);
  const dark = mat('wood', 0x5c4030);
  const slats = 5;
  for (let i = 0; i < slats; i++) {
    const z = -d * 0.42 + (d * 0.84 * i) / (slats - 1);
    box(g, i % 2 === 0 ? wood : dark, w * 0.96, h * 0.28, d * 0.12, 0, h * 0.72, z);
  }
  for (const x of [-w * 0.32, 0, w * 0.32]) box(g, dark, w * 0.08, h * 0.55, d * 0.9, x, h * 0.28, 0);
}

function post(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { width: w, height: h, depth: d } = def;
  const wood = mat('wood', 0xffffff);
  box(g, wood, w * 0.72, h, d * 0.72, 0, h / 2, 0);
  box(g, mat('wood', 0x5c4030), w, h * 0.06, d, 0, h * 0.96, 0);
  box(g, mat('wood', 0x5c4030), w, h * 0.05, d, 0, h * 0.08, 0);
}

function lamp(g: THREE.Group, def: BoxDef, mat: SceneMat): void {
  const { height: h } = def;
  const metal = mat('metal', 0xc8a860);
  const glass = mat('glass', 0xf2e2c0, 0.9);
  if (glass instanceof THREE.MeshStandardMaterial) {
    glass.emissive = new THREE.Color(0xffd98a);
    glass.emissiveIntensity = 0.6;
  }
  cyl(g, metal, 0.015, h * 0.42, 0, h * 0.76, 0);
  cyl(g, metal, 0.1, 0.025, 0, h * 0.54, 0);
  cyl(g, glass, 0.16, h * 0.28, 0, h * 0.36, 0);
  cyl(g, metal, 0.17, 0.03, 0, h * 0.2, 0);
}

const BUILDERS: Record<string, Builder> = {
  bed, hbed, piano, stretcher, ivstand, curtain, medcab, bar, sofa, table, low_table: table, teller, vault, bench,
  column, desk, chair, partition, shelf, metal_rack: shelf, tool_shelf: shelf, pallet, container, crates: container,
  toilet, sink, stall, rail, wardrobe, fridge, bathtub, counter, tv_board: desk, lamp, engawa, post,
  planter, island: counter, banquet_table: table, dining_table: table, conf_table: table,
};

/** 小道具メッシュ。未知の prop は null（呼び出し側が箱のまま描く）。原点は足元中心。 */
export function buildScenery(def: BoxDef, mat: SceneMat): THREE.Group | null {
  const kind = def.prop;
  const build = kind ? BUILDERS[kind] : undefined;
  if (!build) return null;
  const g = new THREE.Group();
  g.name = `prop:${kind}`;
  build(g, def, mat);
  g.position.set(def.x, def.y ?? 0, def.z);
  g.rotation.y = (def.yaw ?? 0) * DEG;
  return g;
}
