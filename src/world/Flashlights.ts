import * as THREE from 'three';
import { SuspectState } from '../core/events';
import type { Vec3 } from '../core/types';
import type { DarknessView } from '../ai/Perception';
import type { Suspect } from '../ai/Suspect';
import { hasLineOfSight } from '../weapons/Flashbang';
import { raycastColliders } from './ColliderIndex';
import type { Collider } from './WorldBuilder';

/** 暗闇での素の視認距離の倍率（目が慣れても 5m 前後しか見分けられない） */
export const DARK_RANGE_MUL = 0.3;
/** 容疑者のライトの円錐（半角）と届く距離 */
export const BEAM_HALF_DEG = 24;
export const BEAM_RANGE = 16;
/** 光芒コーンメッシュの最大長（m） */
export const BEAM_LEN = BEAM_RANGE * 0.55;
/** 実際に照らす SpotLight の数（固定。ライト数が変わるとシェーダが作り直しになる） */
const POOL_SIZE = 2;
const SHADOW_MAP = 512;
const DEG2RAD = Math.PI / 180;

export interface GlareInfo {
  /** 0..1 の照射強度 */
  intensity: number;
  /** 最も強い光源の画面 UV 座標（0..1, 0..1） */
  uvX: number;
  uvY: number;
}

/** 点灯中のライトの状態 */
interface NpcLight {
  readonly suspect: Suspect;
  readonly holder: THREE.Group;
  readonly beam: THREE.Mesh;
  readonly lens: THREE.Mesh;
  lit: boolean;
  /** レンズが壁にめり込んでいるか */
  blocked: boolean;
  /** 正面レイの障害物までの距離（m） */
  hitDist: number;
  /** 異変に気付いてから点けるまでの手間取り（秒） */
  fumble: number;
  noticed: boolean;
}

export interface FlashlightOptions {
  scene: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  colliders: readonly Collider[];
  suspects: () => Iterable<Suspect>;
  /** プレイヤーもライトを持つか（容疑者モード） */
  playerLight: boolean;
}

const OFF_STATES = new Set<SuspectState>([SuspectState.SURRENDER, SuspectState.ARRESTED, SuspectState.DOWN]);
const NOTICE_STATES = new Set<SuspectState>([
  SuspectState.ALERT,
  SuspectState.CONFRONTATION,
  SuspectState.HESITATE,
  SuspectState.ENGAGE,
  SuspectState.HOSTAGE_SHIELD,
  SuspectState.NEGOTIATION,
]);

function configureSpotShadow(s: THREE.SpotLight, far: number): void {
  s.castShadow = true;
  s.shadow.autoUpdate = false;
  s.shadow.needsUpdate = false;
  s.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  s.shadow.bias = -0.001;
  s.shadow.normalBias = 0.03;
  s.shadow.camera.near = 0.15;
  s.shadow.camera.far = far;
}

/**
 * 停電中のライト（フラッシュライト）。
 * - 容疑者 NPC: 異変に気付くと（または暗闇に慣れていれば最初から）ライトを点ける。点けると円錐の中は遠くまで見えるが、
 *   光の筋とレンズの光で居場所がバレ、SWAT の暗視装置にハローとオートゲート減光を起こす。
 * - プレイヤー（容疑者モード）: V で点灯 / 消灯。
 * 光の筋は加算合成の円錐メッシュ（壁・ドア手前でクリップ）、実際に周囲を照らすのはカメラに近い POOL_SIZE 本だけ（影付き SpotLight）。
 */
export class FlashlightSystem implements DarknessView {
  dark = false;
  /** 突入前に停電し、容疑者が暗闇に慣れている（最初からライトを点けて待ち構える） */
  adapted = false;
  readonly rangeMul = DARK_RANGE_MUL;
  private readonly lights = new Map<string, NpcLight>();
  private readonly pool: THREE.SpotLight[] = [];
  private readonly playerSpot: THREE.SpotLight | null = null;
  private playerOn = false;
  private readonly beamGeo: THREE.ConeGeometry;
  private readonly lensGeo: THREE.SphereGeometry;
  private readonly beamMat: THREE.MeshBasicMaterial;
  private readonly lensMat: THREE.MeshBasicMaterial;
  private readonly cosHalf = Math.cos(BEAM_HALF_DEG * DEG2RAD);
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly eyeTmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly lensTmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly chestTmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dirTmp: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(private readonly o: FlashlightOptions) {
    this.beamGeo = new THREE.ConeGeometry(Math.tan(BEAM_HALF_DEG * DEG2RAD) * BEAM_LEN, BEAM_LEN, 20, 1, true);
    // 頂点をレンズ位置に、-Z（体の前）へ伸ばす
    this.beamGeo.translate(0, -BEAM_LEN / 2, 0);
    this.beamGeo.rotateX(Math.PI / 2);
    this.lensGeo = new THREE.SphereGeometry(0.035, 10, 8);
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff1d2,
      transparent: true,
      opacity: 0.07,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = new THREE.SpotLight(0xfff1d2, 0, BEAM_RANGE, BEAM_HALF_DEG * DEG2RAD, 0.5, 1.6);
      s.name = 'flashlight-pool';
      configureSpotShadow(s, BEAM_RANGE);
      o.scene.add(s, s.target);
      this.pool.push(s);
    }
    if (o.playerLight) {
      const s = new THREE.SpotLight(0xfff4dc, 0, 24, 0.42, 0.45, 1.5);
      s.name = 'player-flashlight';
      configureSpotShadow(s, 24);
      o.scene.add(s, s.target);
      this.playerSpot = s;
    }
  }

  get playerLightOn(): boolean {
    return this.playerOn;
  }

  /** プレイヤーのライト（容疑者モード）。持っていなければ何もしない */
  togglePlayer(): boolean {
    if (!this.playerSpot) return false;
    this.playerOn = !this.playerOn;
    return this.playerOn;
  }

  beamOf(suspectId: string): { cosHalf: number; range: number } | null {
    const l = this.lights.get(suspectId);
    return l?.lit ? { cosHalf: this.cosHalf, range: BEAM_RANGE } : null;
  }

  /** いまライトを点けている容疑者の数（HUD・テスト用） */
  get litCount(): number {
    let n = 0;
    for (const l of this.lights.values()) if (l.lit) n++;
    return n;
  }

  private ensure(s: Suspect): NpcLight {
    let l = this.lights.get(s.id);
    if (l) return l;
    const holder = new THREE.Group();
    holder.position.set(0.16, 1.24, -0.42);
    const beam = new THREE.Mesh(this.beamGeo, this.beamMat);
    const lens = new THREE.Mesh(this.lensGeo, this.lensMat);
    beam.raycast = () => {};
    lens.raycast = () => {};
    beam.userData.noShadow = true;
    lens.userData.noShadow = true;
    beam.castShadow = lens.castShadow = false;
    holder.add(beam, lens);
    holder.visible = false;
    s.body.group.add(holder);
    l = {
      suspect: s,
      holder,
      beam,
      lens,
      lit: false,
      blocked: false,
      hitDist: BEAM_RANGE,
      fumble: 0.5 + Math.random() * 0.9,
      noticed: false,
    };
    this.lights.set(s.id, l);
    return l;
  }

  update(dt: number): void {
    const cam = this.o.camera;
    const camPos = cam.getWorldPosition(this.tmpA);
    const lit: NpcLight[] = [];
    for (const s of this.o.suspects()) {
      const l = this.ensure(s);
      if (!s.alive || OFF_STATES.has(s.state) || !this.dark) {
        l.lit = false;
      } else {
        if (NOTICE_STATES.has(s.state)) l.noticed = true;
        if (this.adapted || l.noticed) {
          l.fumble -= dt;
          if (l.fumble <= 0) l.lit = true;
        }
      }
      l.holder.visible = l.lit;
      if (l.lit) {
        s.body.group.updateMatrixWorld();
        const lensPos = l.lens.getWorldPosition(this.tmpB);
        // 胸中心からレンズまでの間に壁があれば、レンズが壁にめり込んでいるので描画・照射を止める
        this.chestTmp.x = s.body.px;
        this.chestTmp.y = s.body.footY + 1.24;
        this.chestTmp.z = s.body.pz;
        const clx = lensPos.x - this.chestTmp.x;
        const cly = lensPos.y - this.chestTmp.y;
        const clz = lensPos.z - this.chestTmp.z;
        const clLen = Math.hypot(clx, cly, clz);
        let blocked = false;
        if (clLen > 0.02) {
          this.dirTmp.x = clx / clLen;
          this.dirTmp.y = cly / clLen;
          this.dirTmp.z = clz / clLen;
          const chestHit = raycastColliders(this.o.colliders, this.chestTmp, this.dirTmp, clLen);
          if (chestHit < clLen - 0.02) blocked = true;
        }
        l.blocked = blocked;
        if (blocked) {
          l.hitDist = 0;
          l.beam.visible = false;
          l.lens.visible = false;
        } else {
          l.lens.visible = true;
          l.holder.getWorldDirection(this.fwd).multiplyScalar(-1); // holder の -Z が前
          this.lensTmp.x = lensPos.x;
          this.lensTmp.y = lensPos.y;
          this.lensTmp.z = lensPos.z;
          this.dirTmp.x = this.fwd.x;
          this.dirTmp.y = this.fwd.y;
          this.dirTmp.z = this.fwd.z;
          const wallDist = raycastColliders(this.o.colliders, this.lensTmp, this.dirTmp, BEAM_RANGE);
          l.hitDist = wallDist;
          const coneLen = Math.min(BEAM_LEN, Math.max(0, wallDist - 0.02));
          if (coneLen < 0.05) {
            l.beam.visible = false;
          } else {
            l.beam.visible = true;
            l.beam.scale.setScalar(coneLen / BEAM_LEN);
          }
          lit.push(l);
        }
      }
    }
    // 実際に照らすのはカメラに近いライトだけ
    lit.sort(
      (a, b) =>
        Math.hypot(a.suspect.body.px - camPos.x, a.suspect.body.pz - camPos.z) -
        Math.hypot(b.suspect.body.px - camPos.x, b.suspect.body.pz - camPos.z),
    );
    for (let i = 0; i < this.pool.length; i++) {
      const spot = this.pool[i]!;
      const l = lit[i];
      if (!l) {
        spot.intensity = 0;
        spot.shadow.needsUpdate = false;
        continue;
      }
      l.lens.getWorldPosition(spot.position);
      l.holder.getWorldDirection(this.fwd).multiplyScalar(-1); // holder の -Z が前
      spot.target.position.copy(spot.position).addScaledVector(this.fwd, 5);
      spot.target.updateMatrixWorld();
      spot.distance = Math.min(BEAM_RANGE, Math.max(1.2, l.hitDist + 0.6));
      spot.intensity = 26;
      spot.shadow.needsUpdate = true;
    }
    if (this.playerSpot) {
      const s = this.playerSpot;
      if (this.playerOn) {
        cam.getWorldDirection(this.fwd);
        // 壁に密着した際に光源が壁裏へめり込まないよう前方レイで手前にクランプ
        this.eyeTmp.x = camPos.x;
        this.eyeTmp.y = camPos.y;
        this.eyeTmp.z = camPos.z;
        this.dirTmp.x = this.fwd.x;
        this.dirTmp.y = this.fwd.y;
        this.dirTmp.z = this.fwd.z;
        const frontHit = raycastColliders(this.o.colliders, this.eyeTmp, this.dirTmp, 0.25);
        const fwdOffset = Math.max(0, Math.min(0.2, frontHit - 0.08));
        // 銃の右下あたりから照らす
        s.position.copy(camPos).addScaledVector(this.fwd, fwdOffset);
        s.position.y -= 0.12;
        s.target.position.copy(camPos).addScaledVector(this.fwd, 6);
        s.target.updateMatrixWorld();
        this.lensTmp.x = s.position.x;
        this.lensTmp.y = s.position.y;
        this.lensTmp.z = s.position.z;
        const playerHit = raycastColliders(this.o.colliders, this.lensTmp, this.dirTmp, 24);
        s.distance = Math.min(24, Math.max(1.5, playerHit + 0.8));
        s.intensity = 20;
        s.shadow.needsUpdate = true;
      } else {
        s.intensity = 0;
        s.shadow.needsUpdate = false;
      }
    }
  }

  /**
   * 暗視装置のグレア情報（強度 0..1 と最も強い光源の画面 UV 座標）。
   * eye = プレイヤーの目、viewDir = カメラの向き（単位ベクトル）。
   */
  glareInfo(eye: Vec3, viewDir: Vec3, camera: THREE.Camera = this.o.camera): GlareInfo {
    let best = 0;
    let hasBest = false;
    const cosView = Math.cos(45 * DEG2RAD);
    const cosAim = Math.cos(20 * DEG2RAD);
    for (const l of this.lights.values()) {
      if (!l.lit || l.blocked) continue;
      const lens = l.lens.getWorldPosition(this.tmpB);
      const dx = eye.x - lens.x;
      const dy = eye.y - lens.y;
      const dz = eye.z - lens.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.05 || d > BEAM_RANGE) continue;
      l.holder.getWorldDirection(this.fwd).multiplyScalar(-1);
      const aim = (this.fwd.x * dx + this.fwd.y * dy + this.fwd.z * dz) / d;
      if (aim < cosAim) continue;
      const view = -(viewDir.x * dx + viewDir.y * dy + viewDir.z * dz) / d;
      if (view < cosView) continue;
      this.lensTmp.x = lens.x;
      this.lensTmp.y = lens.y;
      this.lensTmp.z = lens.z;
      this.eyeTmp.x = eye.x;
      this.eyeTmp.y = eye.y;
      this.eyeTmp.z = eye.z;
      if (!hasLineOfSight(this.o.colliders, this.lensTmp, this.eyeTmp)) continue;
      const g = ((aim - cosAim) / (1 - cosAim)) * ((view - cosView) / (1 - cosView)) * (1 - d / BEAM_RANGE);
      if (g > best) {
        best = g;
        hasBest = true;
        this.tmpC.copy(lens);
      }
    }
    if (!hasBest) return { intensity: 0, uvX: 0.5, uvY: 0.5 };
    this.tmpC.project(camera);
    const uvX = Math.max(0, Math.min(1, (this.tmpC.x + 1) * 0.5));
    const uvY = Math.max(0, Math.min(1, (this.tmpC.y + 1) * 0.5));
    return { intensity: Math.min(1, best * 1.8), uvX, uvY };
  }

  /**
   * 暗視装置のグレア強度（0..1）: 点灯中のライトが目の方を向き、かつ視界に入っているほど強い。
   */
  glareAt(eye: Vec3, viewDir: Vec3): number {
    return this.glareInfo(eye, viewDir).intensity;
  }

  /**
   * プレイヤーのライトが point を照らしているか（0..1）。容疑者モードで SWAT の暗視装置を眩ませる判定に使う。
   */
  playerBeamOn(eye: Vec3, viewDir: Vec3, point: Vec3, maxDist = 12): number {
    if (!this.playerOn) return 0;
    const dx = point.x - eye.x;
    const dy = point.y - eye.y;
    const dz = point.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.05 || d > maxDist) return 0;
    const cos = (viewDir.x * dx + viewDir.y * dy + viewDir.z * dz) / d;
    const cosHalf = Math.cos(14 * DEG2RAD);
    if (cos < cosHalf) return 0;
    if (!hasLineOfSight(this.o.colliders, eye, point)) return 0;
    return ((cos - cosHalf) / (1 - cosHalf)) * (1 - d / maxDist);
  }

  dispose(): void {
    for (const l of this.lights.values()) l.holder.removeFromParent();
    this.lights.clear();
    for (const s of this.pool) {
      s.removeFromParent();
      s.target.removeFromParent();
    }
    if (this.playerSpot) {
      this.playerSpot.removeFromParent();
      this.playerSpot.target.removeFromParent();
    }
    this.beamGeo.dispose();
    this.lensGeo.dispose();
    this.beamMat.dispose();
    this.lensMat.dispose();
  }
}
