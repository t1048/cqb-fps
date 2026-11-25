import * as THREE from 'three';
import type { ItemDef, ItemKind, WindowDef } from '../core/types';
import type { TextureLibrary } from './Materials';

const DEG = Math.PI / 180;

type PropMaterial = 'metal' | 'wood' | 'fabric' | 'plastic';

function mat(
  tex: TextureLibrary,
  name: PropMaterial,
  color: number,
  pool?: Map<string, THREE.MeshStandardMaterial>,
): THREE.MeshStandardMaterial {
  const key = `prop:${name}:${color}`;
  const hit = pool?.get(key);
  if (hit) return hit;
  if (name === 'plastic') {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.8,
      metalness: 0.02,
    });
    pool?.set(key, m);
    return m;
  }
  const map = tex.get(name) as THREE.CanvasTexture | undefined;
  const themed = tex.palette !== null;
  const isMetal = name === 'metal';
  const baseRoughness = themed ? (isMetal ? 0.42 : 0.84) : isMetal ? 0.4 : 0.86;
  const derived = map && tex.getDerivedMaps ? tex.getDerivedMaps(map) : null;
  const m = new THREE.MeshStandardMaterial({
    ...(map ? { map } : {}),
    color,
    roughness: derived ? Math.max(0.05, baseRoughness - 0.05) : baseRoughness,
    metalness: themed ? (isMetal ? 0.48 : 0.02) : isMetal ? 0.35 : 0.02,
    ...(derived ? { bumpMap: derived.bumpMap, bumpScale: 0.02, roughnessMap: derived.roughnessMap } : {}),
  });
  pool?.set(key, m);
  return m;
}

function box(
  parent: THREE.Object3D,
  tex: TextureLibrary,
  size: [number, number, number],
  pos: [number, number, number],
  kind: PropMaterial,
  color: number,
  pool?: Map<string, THREE.MeshStandardMaterial>,
): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat(tex, kind, color, pool));
  mesh.position.set(pos[0], pos[1], pos[2]);
  parent.add(mesh);
}

/** マップ JSON のアイテムを部品分けメッシュにする。 */
export function buildItem(
  def: ItemDef,
  tex: TextureLibrary,
  pool?: Map<string, THREE.MeshStandardMaterial>,
): THREE.Group {
  const g = new THREE.Group();
  g.name = `item:${def.id}`;
  g.position.set(def.x, def.y ?? 0, def.z);
  g.rotation.y = (def.yaw ?? 0) * DEG;
  buildKind(def.kind, g, tex, pool);
  return g;
}

function buildKind(
  kind: ItemKind,
  g: THREE.Group,
  tex: TextureLibrary,
  pool?: Map<string, THREE.MeshStandardMaterial>,
): void {
  if (kind === 'rifle') {
    // 横倒しに置くので突出部も天板より上に収まる。
    const rifle = new THREE.Group();
    rifle.position.y = 0.032;
    rifle.rotation.z = Math.PI / 2;
    g.add(rifle);
    box(rifle, tex, [0.064, 0.072, 0.22], [0, 0, 0], 'metal', 0x555b62, pool);
    box(rifle, tex, [0.05, 0.052, 0.21], [0, 0, -0.18], 'metal', 0x3a3e43, pool);
    box(rifle, tex, [0.022, 0.022, 0.12], [0, 0, -0.325], 'metal', 0x454b50, pool);
    box(rifle, tex, [0.06, 0.07, 0.19], [0, -0.011, 0.195], 'wood', 0x986945, pool);
    box(rifle, tex, [0.036, 0.10, 0.055], [0, -0.066, -0.02], 'metal', 0x30343a, pool);
    return;
  }
  if (kind === 'evidence') {
    box(g, tex, [0.28, 0.04, 0.36], [0, 0.02, 0], 'plastic', 0xd8d0b0, pool);
    box(g, tex, [0.22, 0.004, 0.02], [0, 0.041, -0.08], 'plastic', 0x8a1e1e, pool);
    return;
  }
  if (kind === 'radio') {
    box(g, tex, [0.12, 0.18, 0.05], [0, 0.09, 0], 'plastic', 0x1c2420, pool);
    box(g, tex, [0.012, 0.22, 0.012], [0.04, 0.22, 0], 'metal', 0x888888, pool);
    box(g, tex, [0.06, 0.03, 0.008], [0, 0.12, 0.028], 'plastic', 0x60946a, pool);
    return;
  }
  if (kind === 'flashbang') {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.13, 12), mat(tex, 'metal', 0x6882a6, pool));
    mesh.position.y = 0.065;
    g.add(mesh);
    box(g, tex, [0.045, 0.024, 0.045], [0, 0.139, 0], 'metal', 0xb0b8c0, pool);
    return;
  }
  box(g, tex, [0.22, 0.08, 0.14], [0, 0.04, 0], 'plastic', 0xa62424, pool);
  box(g, tex, [0.105, 0.004, 0.027], [0, 0.0815, 0], 'plastic', 0xf2f2f2, pool);
  for (const side of [-1, 1]) {
    box(g, tex, [0.027, 0.004, 0.034], [0, 0.0815, side * 0.0305], 'plastic', 0xf2f2f2, pool);
  }
}

function windowFrameMat(
  tex: TextureLibrary,
  pool?: Map<string, THREE.MeshStandardMaterial>,
): THREE.MeshStandardMaterial {
  if (!tex.palette) return mat(tex, 'wood', 0x4a3424, pool);
  const frameColor = tex.doorTint?.frame ?? 0xffffff;
  const key = `win:frame:${frameColor}`;
  const hit = pool?.get(key);
  if (hit) return hit;
  const map = tex.get('doorFrame') as THREE.CanvasTexture | undefined;
  const derived = map && tex.getDerivedMaps ? tex.getDerivedMaps(map) : null;
  const m = new THREE.MeshStandardMaterial({
    ...(map ? { map } : {}),
    color: frameColor,
    roughness: derived ? 0.79 : 0.84,
    metalness: 0.02,
    ...(derived ? { bumpMap: derived.bumpMap, bumpScale: 0.02, roughnessMap: derived.roughnessMap } : {}),
  });
  pool?.set(key, m);
  return m;
}

function windowGlassMat(
  tex: TextureLibrary,
  pool?: Map<string, THREE.MeshStandardMaterial>,
): THREE.MeshStandardMaterial {
  const key = 'win:glass';
  const hit = pool?.get(key);
  if (hit) return hit;
  const map = tex.get('glass') as THREE.CanvasTexture | undefined;
  const m = new THREE.MeshStandardMaterial({
    ...(map ? { map } : {}),
    color: 0xc5e4f5,
    transparent: true,
    opacity: 0.35,
    roughness: 0.05,
    metalness: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  pool?.set(key, m);
  return m;
}

/** 窓枠とガラス（室内の窓口はカウンター板のみ）。当たり判定は持たない（開口は壁 JSON 側）。 */
export function buildWindow(
  def: WindowDef,
  tex: TextureLibrary,
  pool?: Map<string, THREE.MeshStandardMaterial>,
): THREE.Group {
  const g = new THREE.Group();
  g.name = 'window';
  const y = (def.y ?? 0) + def.sill + def.height / 2;
  g.position.set(def.x, y, def.z);
  g.rotation.y = def.yaw * DEG;
  const frame = windowFrameMat(tex, pool);
  const t = Math.min(0.06, def.width / 3, def.height / 3);
  const bar = (w: number, h: number, x: number, yy: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), frame);
    m.position.set(x, yy, 0);
    g.add(m);
  };
  bar(def.width, t, 0, (def.height - t) / 2);
  bar(def.width, t, 0, -(def.height - t) / 2);
  bar(t, def.height - 2 * t, -(def.width - t) / 2, 0);
  bar(t, def.height - 2 * t, (def.width - t) / 2, 0);
  if (def.interior) {
    // 室内の窓口: ガラス・中桟なし。腰壁の上にカウンター板を渡す（見た目のみ、当たりは腰壁側）
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(def.width + 0.08, 0.04, 0.46), mat(tex, 'wood', 0x8a6a48, pool));
    shelf.position.set(0, -def.height / 2 + 0.02, 0);
    g.add(shelf);
    return g;
  }
  bar(t * 0.6, def.height - 2 * t, 0, 0);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(def.width - 2 * t, def.height - 2 * t), windowGlassMat(tex, pool));
  g.add(glass);
  return g;
}
