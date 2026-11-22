import * as THREE from 'three';
import type { PlayerController } from './PlayerController';
import type { TextureLibrary } from '../world/Materials';

/** 見下ろしたときに見える自分の脚とベスト。カメラより下だけ。 */
export class PlayerAvatar {
  readonly root = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private disposed = false;

  constructor(textures: TextureLibrary) {
    const cloth = new THREE.MeshStandardMaterial({ map: textures.get('camo'), color: 0x314232, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ map: textures.get('fabric'), color: 0x1a2218, roughness: 0.8 });
    const vest = new THREE.MeshStandardMaterial({ map: textures.get('fabric'), color: 0x243028, roughness: 0.75 });
    this.mats.push(cloth, dark, vest);
    const leg = new THREE.BoxGeometry(0.14, 0.7, 0.16);
    const boot = new THREE.BoxGeometry(0.15, 0.1, 0.22);
    this.geos.push(leg, boot, new THREE.BoxGeometry(0.4, 0.42, 0.22), new THREE.BoxGeometry(0.36, 0.28, 0.12));
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      this.root.add(m);
    };
    add(leg, dark, -0.1, 0.4, 0);
    add(leg, dark, 0.1, 0.4, 0);
    add(boot, dark, -0.1, 0.05, 0.02);
    add(boot, dark, 0.1, 0.05, 0.02);
    add(this.geos[2]!, cloth, 0, 0.95, 0);
    add(this.geos[3]!, vest, 0, 1.05, 0.06);
    this.root.name = 'player-body';
  }

  update(player: PlayerController): void {
    if (this.disposed) return;
    this.root.position.set(player.position.x, player.position.y, player.position.z);
    this.root.rotation.set(0, player.yawRad, 0);
    const s = player.isCrouching ? 0.72 : 1;
    this.root.scale.set(1, s, 1);
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
