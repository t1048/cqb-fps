import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import type { Vec3 } from '../core/types';
import { raycastColliders } from '../world/ColliderIndex';
import type { Collider } from '../world/WorldBuilder';

export const LASER_MAX_DIST = 18;
export const FLASHLIGHT_MAX_DIST = 10;
export const LASER_RADIUS = 0.0045;
export const LASER_DOT_RADIUS = 0.028;
export const CONE_UNIT_END_RADIUS = 0.2;
const UNIT_Z = new THREE.Vector3(0, 0, 1);

/**
 * 隊員 1 名分のタクティカルレーザー・着弾ドット・フラッシュライト光芒（F11）。
 * 動的ライト（PointLight / SpotLight）は一切追加せず、加算合成の MeshBasicMaterial のみで描画する。
 */
export class TacticalOptics {
  readonly group = new THREE.Group();
  readonly laserMesh: THREE.Mesh;
  readonly dotMesh: THREE.Mesh;
  readonly coneMesh: THREE.Mesh;
  private readonly dirVec = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();

  constructor() {
    this.group.name = 'tacticalOptics';
    this.group.visible = false;

    const laserGeo = new THREE.CylinderGeometry(LASER_RADIUS, LASER_RADIUS, 1, 6, 1, true);
    laserGeo.translate(0, 0.5, 0);
    laserGeo.rotateX(Math.PI / 2);
    const laserMat = new THREE.MeshBasicMaterial({
      color: 0xff2222,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.laserMesh = new THREE.Mesh(laserGeo, laserMat);
    this.laserMesh.frustumCulled = false;

    const dotGeo = new THREE.SphereGeometry(LASER_DOT_RADIUS, 6, 6);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xff4433,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.dotMesh = new THREE.Mesh(dotGeo, dotMat);
    this.dotMesh.frustumCulled = false;

    const coneGeo = new THREE.CylinderGeometry(CONE_UNIT_END_RADIUS, 0.008, 1, 12, 1, true);
    coneGeo.translate(0, 0.5, 0);
    coneGeo.rotateX(Math.PI / 2);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xdceeff,
      transparent: true,
      opacity: 0.065,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.coneMesh = new THREE.Mesh(coneGeo, coneMat);
    this.coneMesh.frustumCulled = false;

    this.group.add(this.laserMesh, this.dotMesh, this.coneMesh);
  }

  update(origin: Vec3, dir: Vec3, colliders: readonly Collider[]): void {
    const hitDist = raycastColliders(colliders, origin, dir, LASER_MAX_DIST);
    this.dirVec.set(dir.x, dir.y, dir.z);
    if (this.dirVec.lengthSq() < 1e-8) {
      this.hide();
      return;
    }
    this.dirVec.normalize();
    this.quat.setFromUnitVectors(UNIT_Z, this.dirVec);

    this.group.visible = true;
    this.laserMesh.visible = true;
    this.laserMesh.position.set(origin.x, origin.y, origin.z);
    this.laserMesh.quaternion.copy(this.quat);
    this.laserMesh.scale.set(1, 1, Math.max(0.02, hitDist));

    const hitWall = hitDist < LASER_MAX_DIST - 0.05;
    this.dotMesh.visible = hitWall;
    if (hitWall) {
      const d = Math.max(0, hitDist - 0.015);
      this.dotMesh.position.set(
        origin.x + this.dirVec.x * d,
        origin.y + this.dirVec.y * d,
        origin.z + this.dirVec.z * d,
      );
    }

    const coneLen = Math.min(hitDist, FLASHLIGHT_MAX_DIST);
    this.coneMesh.visible = coneLen > 0.08;
    if (this.coneMesh.visible) {
      this.coneMesh.position.set(origin.x, origin.y, origin.z);
      this.coneMesh.quaternion.copy(this.quat);
      this.coneMesh.scale.set(coneLen, coneLen, coneLen);
    }
  }

  hide(): void {
    this.group.visible = false;
    this.laserMesh.visible = false;
    this.dotMesh.visible = false;
    this.coneMesh.visible = false;
  }

  dispose(): void {
    this.group.removeFromParent();
    disposeObject(this.group);
  }
}
