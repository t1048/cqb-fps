import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 静的メッシュのドローコール削減。
 *
 * root 配下の（skip されない）不透明メッシュを、root ローカル座標へ焼き込んで
 * 「マテリアルの見た目シグネチャ × 空間セル」ごとに 1 メッシュへ統合する。
 * マテリアルの color は頂点カラーへ移すため、色違いだけのメッシュも同じバッチにまとまる。
 * セル分割は統合後もフラスタムカリングが効くようにするため。
 *
 * 前提: 統合対象のメッシュは以後 transform / material を変更しないこと。
 */
export interface BatchOptions {
  /** true を返したオブジェクトはその子孫ごと統合対象外（動くドア板など）。 */
  skip?: (obj: THREE.Object3D) => boolean;
  /** 空間セルの一辺（m）。0 以下でセル分割しない。 */
  cellSize?: number;
}

type Std = THREE.MeshStandardMaterial;

const WHITE = new THREE.Color(1, 1, 1);

function signature(m: Std): string {
  return [
    m.type,
    m.map?.uuid ?? '-',
    m.normalMap?.uuid ?? '-',
    m.roughness.toFixed(3),
    m.metalness.toFixed(3),
    m.side,
    m.emissive?.getHexString() ?? '-',
    m.emissiveIntensity,
    m.flatShading ? 1 : 0,
  ].join('|');
}

function batchable(mesh: THREE.Mesh): mesh is THREE.Mesh<THREE.BufferGeometry, Std> {
  if ((mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return false;
  const m = mesh.material;
  if (Array.isArray(m)) return false;
  if (!(m instanceof THREE.MeshStandardMaterial) && !(m instanceof THREE.MeshBasicMaterial)) return false;
  if (m.transparent || m.opacity < 1 || m.alphaTest > 0 || m.vertexColors) return false;
  if (mesh.geometry.morphAttributes.position) return false;
  if (!mesh.visible) return false;
  return mesh.geometry.attributes.position !== undefined && mesh.geometry.attributes.normal !== undefined;
}

function signatureOf(m: THREE.Material): string {
  if (m instanceof THREE.MeshBasicMaterial) return ['basic', m.map?.uuid ?? '-', m.side].join('|');
  return signature(m as Std);
}

/** root ローカル空間へ焼き込み、position/normal/uv/color だけを持つ index 付きジオメトリにする。 */
function bake(mesh: THREE.Mesh, toRoot: THREE.Matrix4, color: THREE.Color): THREE.BufferGeometry {
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.attributes.position!.clone());
  g.setAttribute('normal', src.attributes.normal!.clone());
  const count = src.attributes.position!.count;
  g.setAttribute(
    'uv',
    src.attributes.uv ? src.attributes.uv.clone() : new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2),
  );
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  let index: number[] | ArrayLike<number>;
  if (src.index) index = src.index.array;
  else index = Array.from({ length: count }, (_, i) => i);
  const idx = Array.from(index);
  // 鏡像変換（行列式 < 0）は巻き順が反転するので戻す
  if (toRoot.determinant() < 0) {
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const t = idx[i + 1]!;
      idx[i + 1] = idx[i + 2]!;
      idx[i + 2] = t;
    }
  }
  g.setIndex(idx);
  // drawRange / groups を持つものは対象外にしているので全範囲を焼き込む
  g.applyMatrix4(toRoot);
  return g;
}

/**
 * root 配下の静的メッシュを統合する。元メッシュは取り除き、ジオメトリを破棄する
 * （元マテリアルは統合済みメッシュの所有にはならないので、呼び出し側の管理のまま残る）。
 * 戻り値は追加した統合メッシュ数と、取り除いた元メッシュ数。
 */
export function batchStaticMeshes(root: THREE.Object3D, opts: BatchOptions = {}): { batches: number; removed: number } {
  const cell = opts.cellSize ?? 0;
  root.updateWorldMatrix(true, true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<string, { material: THREE.Material; meshes: THREE.Mesh[] }>();
  const center = new THREE.Vector3();

  const visit = (obj: THREE.Object3D): void => {
    if (obj !== root && opts.skip?.(obj)) return;
    if (!obj.visible) return;
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && batchable(mesh)) {
      const material = mesh.material as THREE.Material;
      let key = signatureOf(material);
      if (cell > 0) {
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        center.copy(mesh.geometry.boundingSphere!.center).applyMatrix4(mesh.matrixWorld).applyMatrix4(rootInv);
        key += `@${Math.floor(center.x / cell)},${Math.floor(center.y / cell)},${Math.floor(center.z / cell)}`;
      }
      let gr = groups.get(key);
      if (!gr) groups.set(key, (gr = { material, meshes: [] }));
      gr.meshes.push(mesh);
    }
    for (const c of obj.children) visit(c);
  };
  visit(root);

  let batches = 0;
  let removed = 0;
  const removedGeos = new Set<THREE.BufferGeometry>();
  const removedMats = new Set<THREE.Material>();
  const mats = new Map<string, THREE.Material>();
  const toRoot = new THREE.Matrix4();
  for (const [key, gr] of groups) {
    if (gr.meshes.length < 2) continue;
    const geos: THREE.BufferGeometry[] = [];
    for (const mesh of gr.meshes) {
      toRoot.multiplyMatrices(rootInv, mesh.matrixWorld);
      const c = (mesh.material as THREE.MeshStandardMaterial).color ?? WHITE;
      geos.push(bake(mesh, toRoot, c));
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const sig = key.split('@')[0]!;
    let mat = mats.get(sig);
    if (!mat) {
      mat = gr.material.clone();
      (mat as THREE.MeshStandardMaterial).color.set(0xffffff);
      mat.vertexColors = true;
      mats.set(sig, mat);
    }
    const out = new THREE.Mesh(merged, mat);
    out.name = 'static-batch';
    out.matrixAutoUpdate = false;
    root.add(out);
    batches++;
    for (const mesh of gr.meshes) {
      // 子を持つメッシュ（照明ハウジング等）は子を残すため、空の Group に置き換える
      if (mesh.children.length > 0) {
        const holder = new THREE.Group();
        holder.position.copy(mesh.position);
        holder.quaternion.copy(mesh.quaternion);
        holder.scale.copy(mesh.scale);
        mesh.parent?.add(holder);
        for (const ch of [...mesh.children]) holder.add(ch);
      }
      mesh.removeFromParent();
      removedGeos.add(mesh.geometry);
      removedMats.add(mesh.material as THREE.Material);
      removed++;
    }
  }
  // 残ったメッシュが共有していないものだけ解放する（テクスチャは統合マテリアルが引き続き使うので触らない）
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    removedGeos.delete(m.geometry);
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => removedMats.delete(x));
    else removedMats.delete(mat);
  });
  for (const g of removedGeos) g.dispose();
  for (const m of removedMats) m.dispose();
  return { batches, removed };
}
