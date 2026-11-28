import * as THREE from 'three';
import { SuspectState } from '../core/events';
import type { Vec3 } from '../core/types';
import type { DarknessView } from '../ai/Perception';
import type { Suspect } from '../ai/Suspect';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Collider } from './WorldBuilder';

/** 暗闇での素の視認距離の倍率（目が慣れても 5m 前後しか見分けられない） */
export const DARK_RANGE_MUL = 0.3;
/** 容疑者のライトの円錐（半角）と届く距離 */
export const BEAM_HALF_DEG = 24;
export const BEAM_RANGE = 16;
/** 実際に照らす SpotLight の数（固定。ライト数が変わるとシェーダが作り直しになる） */
const POOL_SIZE = 2;
const DEG2RAD = Math.PI / 180;

/** 点灯中のライトの状態 */
interface NpcLight {
  readonly suspect: Suspect;
  readonly holder: THREE.Group;
  readonly beam: THREE.Mesh;
  readonly lens: THREE.Mesh;
  lit: boolean;
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

/**
 * 停電中のライト（フラッシュライト）。
 * - 容疑者 NPC: 異変に気付くと（または暗闇に慣れていれば最初から）ライトを点ける。点けると円錐の中は遠くまで見えるが、
 *   光の筋とレンズの光で居場所がバレ、SWAT の暗視装置を白飛びさせる。
 * - プレイヤー（容疑者モード）: V で点灯 / 消灯。
 * 光の筋は加算合成の円錐メッシュ、実際に周囲を照らすのはカメラに近い POOL_SIZE 本だけ（固定数の SpotLight）。
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
  private readonly fwd = new THREE.Vector3();
  private readonly eyeTmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly lensTmp: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(private readonly o: FlashlightOptions) {
    const len = BEAM_RANGE * 0.55;
    this.beamGeo = new THREE.ConeGeometry(Math.tan(BEAM_HALF_DEG * DEG2RAD) * len, len, 20, 1, true);
    // 頂点をレンズ位置に、-Z（体の前）へ伸ばす
    this.beamGeo.translate(0, -len / 2, 0);
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
      o.scene.add(s, s.target);
      this.pool.push(s);
    }
    if (o.playerLight) {
      const s = new THREE.SpotLight(0xfff4dc, 0, 24, 0.42, 0.45, 1.5);
      s.name = 'player-flashlight';
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
    l = { suspect: s, holder, beam, lens, lit: false, fumble: 0.5 + Math.random() * 0.9, noticed: false };
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
      if (l.lit) lit.push(l);
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
        continue;
      }
      l.lens.getWorldPosition(spot.position);
      l.holder.getWorldDirection(this.fwd).multiplyScalar(-1); // holder の -Z が前
      spot.target.position.copy(spot.position).addScaledVector(this.fwd, 5);
      spot.target.updateMatrixWorld();
      spot.intensity = 26;
    }
    if (this.playerSpot) {
      const s = this.playerSpot;
      cam.getWorldDirection(this.fwd);
      // 銃の右下あたりから照らす
      s.position.copy(camPos).addScaledVector(this.fwd, 0.2);
      s.position.y -= 0.12;
      s.target.position.copy(camPos).addScaledVector(this.fwd, 6);
      s.target.updateMatrixWorld();
      s.intensity = this.playerOn ? 20 : 0;
    }
  }

  /**
   * 暗視装置の白飛び（0..1）: 点灯中のライトが目の方を向き、かつ視界に入っているほど強い。
   * eye = プレイヤーの目、viewDir = カメラの向き（単位ベクトル）。
   */
  glareAt(eye: Vec3, viewDir: Vec3): number {
    let best = 0;
    const cosView = Math.cos(45 * DEG2RAD);
    const cosAim = Math.cos(20 * DEG2RAD);
    for (const l of this.lights.values()) {
      if (!l.lit) continue;
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
      best = Math.max(best, g);
    }
    return Math.min(1, best * 1.8);
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
