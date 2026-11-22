import * as THREE from 'three';

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) {
      if (value.userData.shared === true) continue;
      value.dispose();
    }
  }
  material.dispose();
}

/** Object3D 配下の geometry / material / texture を再帰的に解放し、親から取り除く。 */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) {
      if (Array.isArray(mat)) mat.forEach(disposeMaterial);
      else disposeMaterial(mat);
    }
  });
  root.removeFromParent();
}
