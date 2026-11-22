import * as THREE from 'three';
import type { ItemDef, ItemKind, WindowDef } from '../core/types';
import type { TextureLibrary } from './Materials';

const DEG = Math.PI / 180;

type PropMaterial = 'metal' | 'wood' | 'fabric' | 'plastic';

function mat(tex: TextureLibrary, name: PropMaterial, color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: name === 'plastic' ? null : tex.get(name),
    color,
    roughness: name === 'metal' ? 0.45 : 0.8,
  });
}

function box(parent: THREE.Object3D, tex: TextureLibrary, size: [number, number, number], pos: [number, number, number], kind: PropMaterial, color: number): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat(tex, kind, color));
  mesh.position.set(pos[0], pos[1], pos[2]);
  parent.add(mesh);
}

/** マップ JSON のアイテムを部品分けメッシュにする。 */
export function buildItem(def: ItemDef, tex: TextureLibrary): THREE.Group {
  const g = new THREE.Group();
  g.name = `item:${def.id}`;
  g.position.set(def.x, def.y ?? 0, def.z);
  g.rotation.y = (def.yaw ?? 0) * DEG;
  buildKind(def.kind, g, tex);
  return g;
}

function buildKind(kind: ItemKind, g: THREE.Group, tex: TextureLibrary): void {
  if (kind === 'rifle') {
    // 横倒しに置くので突出部も天板より上に収まる。
    const rifle = new THREE.Group();
    rifle.position.y = 0.032;
    rifle.rotation.z = Math.PI / 2;
    g.add(rifle);
    box(rifle, tex, [0.064, 0.072, 0.22], [0, 0, 0], 'metal', 0x555b62);
    box(rifle, tex, [0.05, 0.052, 0.21], [0, 0, -0.18], 'metal', 0x3a3e43);
    box(rifle, tex, [0.022, 0.022, 0.12], [0, 0, -0.325], 'metal', 0x454b50);
    box(rifle, tex, [0.06, 0.07, 0.19], [0, -0.011, 0.195], 'wood', 0x986945);
    box(rifle, tex, [0.036, 0.10, 0.055], [0, -0.066, -0.02], 'metal', 0x30343a);
    return;
  }
  if (kind === 'evidence') {
    box(g, tex, [0.28, 0.04, 0.36], [0, 0.02, 0], 'plastic', 0xd8d0b0);
    box(g, tex, [0.22, 0.004, 0.02], [0, 0.041, -0.08], 'plastic', 0x8a1e1e);
    return;
  }
  if (kind === 'radio') {
    box(g, tex, [0.12, 0.18, 0.05], [0, 0.09, 0], 'plastic', 0x1c2420);
    box(g, tex, [0.012, 0.22, 0.012], [0.04, 0.22, 0], 'metal', 0x888888);
    box(g, tex, [0.06, 0.03, 0.008], [0, 0.12, 0.028], 'plastic', 0x60946a);
    return;
  }
  if (kind === 'flashbang') {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.13, 12), mat(tex, 'metal', 0x6882a6));
    mesh.position.y = 0.065;
    g.add(mesh);
    box(g, tex, [0.045, 0.024, 0.045], [0, 0.139, 0], 'metal', 0xb0b8c0);
    return;
  }
  box(g, tex, [0.22, 0.08, 0.14], [0, 0.04, 0], 'plastic', 0xa62424);
  box(g, tex, [0.105, 0.004, 0.027], [0, 0.0815, 0], 'plastic', 0xf2f2f2);
  for (const side of [-1, 1]) {
    box(g, tex, [0.027, 0.004, 0.034], [0, 0.0815, side * 0.0305], 'plastic', 0xf2f2f2);
  }
}

/** 窓枠とガラス。当たり判定は持たない（開口は壁 JSON 側）。 */
export function buildWindow(def: WindowDef, tex: TextureLibrary): THREE.Group {
  const g = new THREE.Group();
  g.name = 'window';
  const y = (def.y ?? 0) + def.sill + def.height / 2;
  g.position.set(def.x, y, def.z);
  g.rotation.y = def.yaw * DEG;
  const frame = mat(tex, 'wood', 0x4a3424);
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
  bar(t * 0.6, def.height - 2 * t, 0, 0);
  const glassMat = new THREE.MeshStandardMaterial({
    map: tex.get('glass'),
    color: 0xc5e4f5,
    transparent: true,
    opacity: 0.35,
    roughness: 0.05,
    metalness: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(def.width - 2 * t, def.height - 2 * t), glassMat);
  g.add(glass);
  return g;
}
