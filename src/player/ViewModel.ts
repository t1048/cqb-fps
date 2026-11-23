import * as THREE from 'three';
import type { TextureLibrary } from '../world/Materials';

const MAX_DT = 0.05;

/** 一人称装備専用のカメラとモデル。装備 ID で部品構成を切り替える。 */
export class ViewModel {
  readonly root = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.02, 4);
  private readonly holder = new THREE.Group();
  /** 銃本体（リロード時に傾ける） */
  private readonly gun = new THREE.Group();
  /** 弾倉（抜いて差し替える）。弾倉のない装備では空のまま */
  private readonly mag = new THREE.Group();
  /** 左手（リロード時だけ弾倉を持って現れる）。mag の子なので弾倉に追従する */
  private readonly offHand = new THREE.Group();
  private readonly magRest = new THREE.Vector3();
  private hasMag = false;
  /** 抜き差し方向（弾倉の向き。拳銃はグリップ角に合わせる） */
  private readonly magAxis = new THREE.Vector3(0, -1, 0);
  private parent: THREE.Object3D = this.gun;
  private kickZ = 0;
  private kickPitch = 0;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private style = '';
  get hasMagazine(): boolean {
    return this.hasMag;
  }
  private bob = 0;
  private disposed = false;

  constructor(private readonly textures: TextureLibrary) {
    this.root.name = 'viewmodel';
    this.root.add(this.holder);
    this.holder.add(this.gun);
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

  /** 発射時の小さな跳ね上がり（視点の反動とは別に、銃そのものを後退・上向きに）。 */
  kick(strength = 1): void {
    this.kickZ = Math.min(0.05, this.kickZ + 0.018 * strength);
    this.kickPitch = Math.min(0.12, this.kickPitch + 0.035 * strength);
  }

  /**
   * @param reload リロード進捗 0..1（リロード中でなければ null）
   * @param emptyReload 弾切れからのリロード（最後にチャージングハンドルを引く）
   */
  update(rawDt: number, moving: boolean, reload: number | null = null, emptyReload = false): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    const reloading = reload !== null;
    this.bob += dt * (moving ? 8 : 2) * (reloading ? 0.5 : 1);
    const amp = (moving ? 0.007 : 0.002) * (reloading ? 0.5 : 1);
    const sway = Math.sin(this.bob) * amp;
    const bobY = Math.cos(this.bob * 2) * amp;
    const hipOffset = 0.145 * Math.min(1, this.camera.aspect);
    const decay = Math.exp(-dt * 18);
    this.kickZ *= decay;
    this.kickPitch *= decay;
    this.holder.position.set(hipOffset + sway, -0.165 + bobY, -0.43 + this.kickZ);
    this.holder.rotation.set(0.03 + this.kickPitch, -0.04, -0.02);
    this.animateReload(reload ?? -1, emptyReload);
  }

  /** p<0 で通常姿勢。タイムラインは装備の reloadTime に比例して伸縮する。 */
  private animateReload(p: number, empty: boolean): void {
    const g = this.gun;
    g.position.set(0, 0, 0);
    g.rotation.set(0, 0, 0);
    this.offHand.visible = false;
    if (this.hasMag) {
      this.mag.position.copy(this.magRest);
      this.mag.rotation.set(0, 0, 0);
      this.mag.visible = true;
      this.offHand.position.set(0, 0, 0);
    }
    if (p < 0) return;

    // 構え崩し → 保持 → 戻し
    const tilt = smooth(p / 0.16) * (1 - smooth((p - 0.84) / 0.16));
    // 弾倉を叩き込んだ瞬間の揺れ
    const seat = this.hasMag ? bump(p, 0.66, 0.07) : 0;
    // 空からのリロード: 最後にチャージングハンドル（手前に引いて離す）
    const rack = empty ? bump(p, 0.8, 0.06) : 0;

    if (!this.hasMag) {
      // 弾倉の無い装備: 下ろして手元で装填する所作
      const dip = smooth(p / 0.2) * (1 - smooth((p - 0.75) / 0.25));
      g.position.set(-0.02 * dip, -0.09 * dip, 0.03 * dip);
      g.rotation.set(-0.55 * dip, 0.25 * dip, 0.35 * dip + Math.sin(p * Math.PI * 6) * 0.03 * dip);
      return;
    }

    // 銃を画面中央寄りへ持ち上げ、右に傾けてマガジンウェルを左手側（画面内）へ向ける
    g.position.set(-0.05 * tilt, 0.05 * tilt + seat * 0.012, -0.05 * tilt + rack * 0.035);
    g.rotation.set(0.1 * tilt + seat * 0.05 + rack * 0.08, 0.38 * tilt, -0.6 * tilt - seat * 0.04);

    const out = this.mag.position;
    if (p < 0.2) {
      // 保持（ほんの少し緩める）
      out.addScaledVector(this.magAxis, smooth(p / 0.2) * 0.012);
    } else if (p < 0.4) {
      // 古い弾倉が落ちる
      const t = (p - 0.2) / 0.2;
      out.addScaledVector(this.magAxis, 0.012 + t * t * 0.4);
      this.mag.rotation.x = t * 0.5;
      this.mag.visible = t < 0.9;
    } else if (p < 0.66) {
      // 左手が新しい弾倉を下から持ってきて差し込む
      const t = smooth((p - 0.4) / 0.26);
      const lift = 1 - t;
      out.addScaledVector(this.magAxis, 0.012 + lift * 0.24);
      out.x -= lift * 0.12;
      out.z += lift * 0.08;
      this.mag.rotation.set(-0.35 * lift, 0, 0.4 * lift);
      this.offHand.visible = true;
    } else {
      // 装着完了 → 左手が離れる
      const t = smooth((p - 0.68) / 0.2);
      this.offHand.visible = t < 1;
      this.offHand.position.set(-0.08 * t, -0.22 * t, 0.12 * t);
    }
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
    this.gun.clear();
    this.mag.clear();
    this.offHand.clear();
    this.hasMag = false;
    this.parent = this.gun;
    if (style === 'radio') this.buildRadio();
    else if (style === 'flashbang') this.buildFlash();
    else if (style === 'taser') this.buildTaser();
    else if (style === 'pepperball') this.buildPepper();
    else if (style === 'smg') this.buildGun(0.28, 0.16);
    else if (style === 'machine_pistol') this.buildPistol();
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
    this.parent.add(mesh);
  }

  /** 弾倉グループを作る。(x,y,z) は弾倉上端（マガジンウェル位置）。build 内で弾倉部品を足す。 */
  private withMag(x: number, y: number, z: number, axisTiltX: number, build: () => void): void {
    this.hasMag = true;
    this.magRest.set(x, y, z);
    this.magAxis.set(0, -Math.cos(axisTiltX), -Math.sin(axisTiltX));
    this.mag.position.copy(this.magRest);
    this.gun.add(this.mag);
    this.parent = this.mag;
    build();
    this.parent = this.offHand;
    this.mag.add(this.offHand);
    this.buildOffHand();
    this.parent = this.gun;
  }

  /** 左手: 弾倉の下側を握る。手首から先と袖。 */
  private buildOffHand(): void {
    const glove = this.glove();
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x465044, map: this.textures.get('fabric'), roughness: 0.92 });
    this.mats.push(sleeve);
    const palmY = -0.1;
    this.add(new THREE.BoxGeometry(0.07, 0.05, 0.085), glove, -0.012, palmY, 0.004);
    for (let f = 0; f < 4; f++) {
      this.add(new THREE.BoxGeometry(0.014, 0.05, 0.016).rotateZ(-0.25), glove, 0.03, palmY + 0.03, -0.03 + f * 0.019);
    }
    this.add(new THREE.BoxGeometry(0.02, 0.05, 0.02).rotateZ(0.5), glove, -0.04, palmY + 0.03, -0.02);
    const forearm = new THREE.BoxGeometry(0.08, 0.26, 0.078);
    forearm.rotateX(0.9).rotateZ(0.7);
    this.add(forearm, sleeve, -0.09, palmY - 0.1, 0.08);
  }

  private buildGun(barrel: number, stock: number): void {
    const metal = this.metal();
    const dark = this.metal(0x394149);
    this.add(new THREE.BoxGeometry(0.065, 0.075, 0.21), metal, 0, 0, -0.075);
    const foreEnd = barrel - 0.16;
    this.add(new THREE.BoxGeometry(0.052, 0.052, foreEnd), dark, 0, 0, -0.14 - foreEnd / 2);
    this.add(new THREE.CylinderGeometry(0.011, 0.011, 0.12, 12).rotateX(Math.PI / 2), metal, 0, 0, -barrel + 0.04);
    this.add(new THREE.BoxGeometry(0.06, 0.065, stock), this.wood(), 0, -0.01, stock / 2 + 0.02);
    this.withMag(0, -0.025, -0.095, 0.12, () => {
      this.add(new THREE.BoxGeometry(0.037, 0.10, 0.055).rotateX(0.12), dark, 0, -0.045, -0.006);
      this.add(new THREE.BoxGeometry(0.041, 0.012, 0.06), this.metal(0x2a2f34), 0, -0.095, -0.012);
    });
    this.add(new THREE.BoxGeometry(0.022, 0.035, 0.055), dark, 0, 0.05, -0.08);
    this.add(new THREE.BoxGeometry(0.05, 0.095, 0.055), metal, 0, -0.065, 0.012);
    this.buildHand(0.015, -0.08, 0.026);
  }

  /** 改造フルオート拳銃: 短いスライド＋延長マガジン（ストックなし） */
  private buildPistol(): void {
    const slide = this.metal(0x2e3338);
    const frame = this.metal(0x45403a);
    this.add(new THREE.BoxGeometry(0.042, 0.045, 0.19), slide, 0, 0.012, -0.19);
    this.add(new THREE.BoxGeometry(0.038, 0.03, 0.16), frame, 0, -0.022, -0.18);
    this.add(new THREE.CylinderGeometry(0.014, 0.014, 0.06, 10).rotateX(Math.PI / 2), slide, 0, 0.012, -0.31);
    this.add(new THREE.BoxGeometry(0.036, 0.11, 0.05).rotateX(-0.25), frame, 0, -0.08, -0.12);
    this.withMag(0, -0.05, -0.14, -0.2, () => {
      this.add(new THREE.BoxGeometry(0.03, 0.16, 0.035).rotateX(-0.2), this.metal(0x1d2024), 0, -0.08, 0.015);
    });
    this.buildHand(0.012, -0.085, -0.11);
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

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** center 付近で 0→1→0 になる短いパルス。 */
function bump(p: number, center: number, width: number): number {
  const d = Math.abs(p - center) / width;
  return d >= 1 ? 0 : Math.sin((1 - d) * Math.PI * 0.5) ** 2;
}
