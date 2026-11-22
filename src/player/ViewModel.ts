import * as THREE from 'three';
import type { TextureLibrary } from '../world/Materials';

const MAX_DT = 0.05;

/** 一人称装備専用のカメラとモデル。装備 ID で部品構成を切り替える。 */
export class ViewModel {
  readonly root = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.02, 4);
  private readonly holder = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private style = '';
  private bob = 0;
  private disposed = false;

  constructor(private readonly textures: TextureLibrary) {
    this.root.name = 'viewmodel';
    this.root.add(this.holder);
    this.rebuild('rifle');
  }

  setStyle(style: string): void {
    if (style === this.style) return;
    this.rebuild(style);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(rawDt: number, moving: boolean): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    this.bob += dt * (moving ? 8 : 2);
    const amp = moving ? 0.007 : 0.002;
    const sway = Math.sin(this.bob) * amp;
    const bobY = Math.cos(this.bob * 2) * amp;
    const hipOffset = 0.145 * Math.min(1, this.camera.aspect);
    this.holder.position.set(hipOffset + sway, -0.165 + bobY, -0.43);
    this.holder.rotation.set(0.03, -0.04, -0.02);
  }

  private rebuild(style: string): void {
    this.style = style;
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) {
      if (m instanceof THREE.MeshStandardMaterial) m.map = null;
      m.dispose();
    }
    this.geos.length = 0;
    this.mats.length = 0;
    this.holder.clear();
    if (style === 'radio') this.buildRadio();
    else if (style === 'flashbang') this.buildFlash();
    else if (style === 'taser') this.buildTaser();
    else if (style === 'pepperball') this.buildPepper();
    else if (style === 'smg') this.buildGun(0.28, 0.16);
    else this.buildGun(0.46, 0.22);
  }

  private metal(color = 0x565f68): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ map: this.textures.get('metal'), color, roughness: 0.48, metalness: 0.15 });
    this.mats.push(m);
    return m;
  }

  private wood(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ map: this.textures.get('wood'), color: 0x6b4424, roughness: 0.75 });
    this.mats.push(m);
    return m;
  }

  private add(geo: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): void {
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    this.holder.add(mesh);
  }

  private buildGun(barrel: number, stock: number): void {
    const metal = this.metal();
    const dark = this.metal(0x394149);
    this.add(new THREE.BoxGeometry(0.065, 0.075, 0.21), metal, 0, 0, -0.075);
    const foreEnd = barrel - 0.16;
    this.add(new THREE.BoxGeometry(0.052, 0.052, foreEnd), dark, 0, 0, -0.14 - foreEnd / 2);
    this.add(new THREE.CylinderGeometry(0.011, 0.011, 0.12, 12).rotateX(Math.PI / 2), metal, 0, 0, -barrel + 0.04);
    this.add(new THREE.BoxGeometry(0.06, 0.065, stock), this.wood(), 0, -0.01, stock / 2 + 0.02);
    this.add(new THREE.BoxGeometry(0.037, 0.10, 0.055), dark, 0, -0.07, -0.095);
    this.add(new THREE.BoxGeometry(0.022, 0.035, 0.055), dark, 0, 0.05, -0.08);
    this.add(new THREE.BoxGeometry(0.05, 0.095, 0.055), metal, 0, -0.065, 0.012);
    this.buildHand(0.015, -0.08, 0.026);
  }

  private buildHand(x: number, y: number, z: number): void {
    const glove = this.glove();
    const sleeve = new THREE.MeshStandardMaterial({
      color: 0x465044, map: this.textures.get('fabric'), roughness: 0.92,
    });
    this.mats.push(sleeve);
    const forearm = new THREE.BoxGeometry(0.084, 0.251, 0.08);
    forearm.rotateX(1.18).rotateY(0.35);
    this.add(forearm, sleeve, x + 0.048, y - 0.045, z + 0.137);
    const palm = new THREE.BoxGeometry(0.068, 0.089, 0.098);
    this.add(palm, glove, x + 0.014, y, z);
    const thumb = new THREE.BoxGeometry(0.024, 0.053, 0.024).rotateZ(-0.83);
    this.add(thumb, glove, x + 0.004, y + 0.031, z - 0.021);
    for (let finger = 0; finger < 4; finger++) {
      const joint = new THREE.BoxGeometry(0.016, 0.039, 0.017).rotateZ(1.2);
      this.add(joint, glove, x - 0.012, y + 0.025 - finger * 0.016, z - 0.023);
    }
  }

  private glove(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ map: this.textures.get('fabric'), color: 0x383e42, roughness: 0.7 });
    this.mats.push(m);
    return m;
  }

  private buildFlash(): void {
    this.add(new THREE.CylinderGeometry(0.043, 0.043, 0.13, 12), this.metal(0x6882a6), 0, -0.02, -0.16);
    this.add(new THREE.BoxGeometry(0.045, 0.024, 0.045), this.metal(0xb0b8c0), 0, 0.05, -0.16);
    this.buildHand(0.036, -0.075, -0.135);
  }

  private buildTaser(): void {
    this.add(new THREE.BoxGeometry(0.06, 0.1, 0.16), this.metal(0x404952), 0, -0.02, -0.16);
    const accent = this.metal(0xd0d0d0);
    this.add(new THREE.BoxGeometry(0.01, 0.02, 0.08), accent, -0.015, 0.021, -0.24);
    this.add(new THREE.BoxGeometry(0.01, 0.02, 0.08), accent, 0.015, 0.021, -0.24);
    this.add(new THREE.BoxGeometry(0.055, 0.095, 0.06), this.metal(), 0, -0.075, -0.10);
    this.buildHand(0.016, -0.09, -0.084);
  }

  private buildPepper(): void {
    this.add(new THREE.BoxGeometry(0.07, 0.08, 0.28), this.metal(0x4f6250), 0, 0, -0.2);
    this.add(new THREE.CylinderGeometry(0.029, 0.031, 0.13, 12).rotateX(Math.PI / 2), this.metal(0x454c4d), 0, 0, -0.06);
    this.add(new THREE.BoxGeometry(0.055, 0.09, 0.06), this.metal(), 0, -0.05, -0.10);
    this.buildHand(0.016, -0.08, -0.084);
  }

  private buildRadio(): void {
    this.add(new THREE.BoxGeometry(0.1, 0.16, 0.04), this.metal(0x3b4a40), 0, -0.02, -0.18);
    this.add(new THREE.BoxGeometry(0.012, 0.18, 0.012), this.metal(0xaaaaaa), 0.03, 0.1, -0.18);
    const display = new THREE.MeshBasicMaterial({ color: 0x668b63 });
    this.mats.push(display);
    this.add(new THREE.BoxGeometry(0.061, 0.027, 0.004), display, 0, 0.016, -0.159);
    this.buildHand(0.03, -0.08, -0.143);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) {
      if (m instanceof THREE.MeshStandardMaterial) m.map = null;
      m.dispose();
    }
    this.root.removeFromParent();
  }
}
