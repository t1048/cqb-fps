import { sampleGround } from '../world/Walk';
import type { Collider } from '../world/WorldBuilder';
import * as THREE from 'three';
import type { AABB } from '../world/WorldBuilder';
import type { TextureLibrary } from '../world/Materials';

export type Pose = 'stand' | 'crouch' | 'kneel' | 'down';
export type HumanoidRole = 'suspect' | 'civilian' | 'ally';

export interface HumanoidOptions {
  role?: HumanoidRole;
  footY?: number;
  textures?: TextureLibrary;
  /** 防弾盾 + ハンドガン（盾は脛より上の正面を覆う。足元は無防備） */
  shield?: boolean;
}

const STAND_H = 1.75;
const KNEEL_DROP = 0.52;
const KNEEL_H = STAND_H - KNEEL_DROP;
const CROUCH_H = 1.15;
const BODY_W = 0.46;
const BODY_D = 0.28;

/**
 * 頭・胴・四肢・装備を組み合わせた人型。姿勢で高さ・AABB が変わる。
 * テクスチャは共有ライブラリ（shared）を参照し、ここでは破棄しない。
 */
export class HumanoidBody {
  readonly group = new THREE.Group();
  private readonly legs: { hip: THREE.Group; knee: THREE.Group; ankle: THREE.Group; side: number }[] = [];
  private readonly arms: { shoulder: THREE.Group; elbow: THREE.Group; side: number }[] = [];
  ground: readonly Collider[] = [];
  private feet = [new THREE.Vector3(), new THREE.Vector3()];
  private feetReady = false;
  private swing = -1;
  private stepTime = 0;
  private readonly stepStart = new THREE.Vector3();
  private readonly stepEnd = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly previous = new THREE.Vector3();
  private readonly releaseStart = new THREE.Vector3();
  private releaseRoll = 0;
  private poseTime = 0;
  private fallStart = 0;
  private readonly headPivot = new THREE.Group();
  private shake = 0;
  private lastDt = 1 / 60;
  private readonly torso = new THREE.Group();
  private phase = 0;
  private travel = 0;
  private stride = 0;
  private drop = 0;
  private kneeling = 0;
  private readonly rig = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly cloth: THREE.MeshStandardMaterial;
  private readonly skin: THREE.MeshStandardMaterial;
  private readonly gun: THREE.Group | null;
  private readonly muzzle: THREE.Mesh;
  private gunShown: boolean;
  private muzzleLeft = 0;
  private pose: Pose = 'stand';
  private readyPose: 'low' | 'high' = 'low';
  private aimPitch = 0;
  private baseColor: number;
  private restrained = false;
  private restrainBlend = 0;
  private readonly cuffs = new THREE.Group();
  footY: number;
  /** 防弾盾を構えている（盾越しにハンドガンを撃つ） */
  readonly hasShield: boolean;
  private readonly shieldMesh: THREE.Group | null = null;

  constructor(
    private x: number,
    private z: number,
    yawDeg: number,
    color: number,
    armed: boolean,
    options: HumanoidOptions = {},
  ) {
    this.baseColor = color;
    this.hasShield = options.shield === true;
    this.footY = options.footY ?? 0;
    const role = options.role ?? (armed ? 'suspect' : 'civilian');
    const tex = options.textures;
    this.cloth = this.makeMat(undefined, 'fabric', role === 'ally' ? 0x506070 : color, 0.92);
    this.skin = this.makeMat(undefined, 'skin', 0xbd8d68, 0.86);
    const trim = this.makeMat(undefined, 'fabric', 0x333938, 0.9);
    const pants = this.makeMat(undefined, 'fabric', role === 'civilian' ? 0x4d6072 : 0x48504d, 0.94);
    const cube = this.geo(new THREE.BoxGeometry());
    const box = (parent: THREE.Object3D, material: THREE.Material, x: number, y: number, z: number,
      width: number, height: number, depth: number) => {
      this.part(cube, material, parent, x, y, z).scale.set(width, height, depth);
    };
    const joint = (parent: THREE.Group, x: number, y: number, z: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      parent.add(pivot);
      return pivot;
    };
    box(this.rig, pants, 0, 0.82, 0, 0.34, 0.17, 0.23);
    box(this.rig, this.cloth, 0, 1.13, 0, 0.38, 0.48, 0.24);
    box(this.rig, trim, 0, 0.916, 0, 0.39, 0.045, 0.246);
    if (role === 'ally') {
      box(this.rig, trim, 0, 1.16, 0, 0.394, 0.32, 0.268);
      for (const x of [-0.092, 0, 0.092]) box(this.rig, pants, x, 1.085, -0.144, 0.077, 0.112, 0.043);
    }
    box(this.rig, this.skin, 0, 1.395, 0, 0.114, 0.074, 0.11);
    this.rig.add(this.headPivot);
    this.headPivot.position.y = 1.45;
    box(this.headPivot, this.skin, 0, 0.109, 0, 0.205, 0.258, 0.193);
    box(this.headPivot, trim, 0, 0.229, 0.003, 0.215, 0.057, 0.202);
    if (armed) box(this.headPivot, trim, 0, 0.245, -0.01, 0.236, 0.1, 0.233);
    for (const side of [-1, 1]) {
      box(this.headPivot, trim, side * 0.047, 0.125, -0.099, 0.022, 0.012, 0.008);
      const hip = joint(this.rig, side * 0.096, 0.82, 0);
      const knee = joint(hip, 0, -0.38, 0);
      const ankle = joint(knee, 0, -0.36, 0);
      box(hip, pants, 0, -0.19, 0, 0.155, 0.38, 0.171);
      box(knee, pants, 0, -0.18, 0, 0.135, 0.36, 0.144);
      box(ankle, trim, 0, -0.006, -0.032, 0.145, 0.11, 0.218);
      this.legs.push({ hip, knee, ankle, side });
      const shoulder = joint(this.rig, side * 0.238, 1.317, 0);
      const elbow = joint(shoulder, 0, -0.234, 0);
      box(shoulder, this.cloth, 0, -0.117, 0, 0.119, 0.234, 0.137);
      box(elbow, this.cloth, 0, -0.096, 0, 0.102, 0.192, 0.116);
      box(elbow, role === 'ally' ? trim : this.skin, 0, -0.217, 0, 0.092, 0.085, 0.095);
      this.arms.push({ shoulder, elbow, side });
    }
    this.gunShown = armed;
    if (armed) {
      this.gun = new THREE.Group();
      const gunMat = this.makeMat(tex, 'metal', 0x22262a, 0.45);
      const wood = this.makeMat(tex, 'wood', 0x6b4424, 0.7);
      if (this.hasShield) {
        // ハンドガン（盾の裏で構える短い銃）
        this.part(this.geo(new THREE.BoxGeometry(0.035, 0.045, 0.2)), gunMat, this.gun, 0, 0.02, -0.06);
        this.part(this.geo(new THREE.BoxGeometry(0.03, 0.09, 0.045)), gunMat, this.gun, 0, -0.04, 0.03);
      } else {
        this.part(this.geo(new THREE.BoxGeometry(0.04, 0.05, 0.42)), gunMat, this.gun, 0, 0.02, -0.12);
        this.part(this.geo(new THREE.BoxGeometry(0.035, 0.08, 0.14)), wood, this.gun, 0, -0.02, 0.08);
        this.part(this.geo(new THREE.BoxGeometry(0.03, 0.1, 0.04)), gunMat, this.gun, 0, -0.06, 0.02);
        this.part(this.geo(new THREE.BoxGeometry(0.02, 0.03, 0.08)), gunMat, this.gun, 0, 0.05, -0.22);
      }
      this.rig.add(this.gun);
    } else {
      this.gun = null;
    }
    const muzzleMat = new THREE.MeshBasicMaterial({ color: 0xffdd55 });
    this.mats.push(muzzleMat);
    this.muzzle = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.08, 0.08, 0.08)), muzzleMat);
    this.muzzle.visible = false;
    this.muzzle.position.set(0, 0.02, this.hasShield ? -0.17 : -0.36);
    this.gun?.add(this.muzzle);

    if (this.hasShield) {
      const g = new THREE.Group();
      const plate = this.makeMat(tex, 'metal', 0x1c2430, 0.4);
      const edge = this.makeMat(tex, 'metal', 0x3a4250, 0.5);
      const glass = new THREE.MeshStandardMaterial({ color: 0x6f8fa8, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.55 });
      this.mats.push(glass);
      // 腰〜顔の下まで（上半身を守る）。窓付きの防弾盾
      const top = 1.6;
      const bottom = 0.75;
      this.part(this.geo(new THREE.BoxGeometry(0.5, top - bottom, 0.045)), plate, g, 0, (top + bottom) / 2, 0);
      this.part(this.geo(new THREE.BoxGeometry(0.54, 0.04, 0.06)), edge, g, 0, top, 0);
      this.part(this.geo(new THREE.BoxGeometry(0.54, 0.04, 0.06)), edge, g, 0, bottom, 0);
      for (const sx of [-1, 1]) this.part(this.geo(new THREE.BoxGeometry(0.04, top - bottom, 0.06)), edge, g, sx * 0.25, (top + bottom) / 2, 0);
      this.part(this.geo(new THREE.BoxGeometry(0.32, 0.1, 0.05)), glass, g, 0, 1.46, 0.004);
      g.position.set(0, 0, -0.5);
      this.rig.add(g);
      this.shieldMesh = g;
    }

    for (const child of [...this.rig.children]) {
      if (!this.legs.some(leg => leg.hip === child) && child !== this.gun) this.torso.add(child);
    }
    const cuffMat = this.makeMat(tex, 'metal', 0xd0d6dc, 0.3);
    for (const side of [-1, 1]) {
      this.part(this.geo(new THREE.BoxGeometry(0.055, 0.045, 0.065)), cuffMat, this.cuffs, side * 0.055, 0, 0);
    }
    this.part(this.geo(new THREE.BoxGeometry(0.06, 0.02, 0.025)), cuffMat, this.cuffs, 0, 0, 0.01);
    this.cuffs.position.set(0, 0.94, 0.18);
    this.cuffs.visible = false;
    this.torso.add(this.cuffs);
    this.rig.add(this.torso);
    this.group.add(this.rig);
    this.group.position.set(x, this.footY, z);
    this.group.rotation.y = (yawDeg * Math.PI) / 180;
    this.setPose('stand');
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.push(g);
    return g;
  }

  private makeMat(tex: TextureLibrary | undefined, name: 'camo' | 'fabric' | 'metal' | 'wood' | 'skin', color: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness: name === 'metal' ? 0.45 : 0.02,
      ...(tex ? { map: tex.get(name) } : {}),
    });
    this.mats.push(m);
    return m;
  }

  private part(geo: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    parent.add(mesh);
    return mesh;
  }

  get height(): number {
    if (this.pose === 'stand') return STAND_H;
    if (this.pose === 'crouch') return CROUCH_H;
    return this.pose === 'kneel' ? KNEEL_H : 0.35;
  }

  setPose(pose: Pose): void {
    if (this.pose === pose && pose !== 'stand') return;
    this.poseTime = 0;
    this.fallStart = this.rig.position.y;
    this.pose = pose;
    this.cloth.color.setHex(pose === 'down' ? 0x444444 : this.baseColor);
    if (this.shieldMesh) this.shieldMesh.visible = pose !== 'down';
    this.placeWeapon();
  }

  private placeWeapon(): void {
    if (!this.gun) return;
    const armed = this.pose === 'stand' || this.pose === 'crouch';
    this.gun.visible = this.gunShown;
    if (!this.gunShown) return;
    if (armed) {
      this.rig.add(this.gun);
      this.gun.position.set(0.125, 1.18, -0.215);
      this.gun.rotation.set(0, 0, 0);
    } else {
      this.group.attach(this.gun);
      this.releaseStart.copy(this.gun.position);
      this.releaseRoll = this.gun.rotation.z;
    }
  }

  removeGun(): void {
    this.gunShown = false;
    if (this.gun) this.gun.visible = false;
  }

  setRestrained(on: boolean): void {
    this.restrained = on;
    this.cuffs.visible = on;
  }

  setPosition(x: number, z: number, y?: number): void {
    this.travel += Math.hypot(x - this.x, z - this.z);
    this.x = x;
    this.z = z;
    if (y !== undefined) this.footY = y;
    this.group.position.set(x, this.footY, z);
  }

  setFlash(on: boolean): void {
    this.cloth.emissive.setHex(on ? 0xffffff : 0x000000);
    this.cloth.emissiveIntensity = on ? 0.6 : 0;
  }

  setShake(rollRad: number): void {
    this.shake = rollRad;
  }

  showMuzzleFlash(sec: number): void {
    if (!this.gun || !this.gunShown) return;
    this.muzzle.visible = true;
    this.muzzleLeft = sec;
  }

  tick(dt: number): void {
    dt = Math.min(dt, 0.05);
    this.lastDt = dt;
    this.headPivot.rotation.x *= Math.exp(-2*dt);
    this.headPivot.rotation.y *= Math.exp(-2*dt);
    this.poseTime += dt;
    const blend = 1 - Math.exp(-10 * dt);
    const walking = this.pose === 'stand' || this.pose === 'crouch';
    const distance = walking ? Math.min(this.travel, 0.22) : 0;
    this.travel = 0;
    this.phase += distance * 6.6;
    this.stride += (Math.min(1, distance / Math.max(0.001, dt * 1.7)) - this.stride) * blend;
    this.kneeling += ((this.pose === 'kneel' ? THREE.MathUtils.smoothstep(this.poseTime, 0.1, 0.4) : 0) - this.kneeling) * blend;
    const targetDrop = this.pose === 'kneel' ? KNEEL_DROP * THREE.MathUtils.smoothstep(this.poseTime, 0.38, 0.72) : this.pose === 'crouch' ? STAND_H - CROUCH_H : 0;
    this.drop += (targetDrop - this.drop) * blend;
    if (this.pose !== 'down') {
      const pelvisY = 0.798 - this.drop - 0.018 * this.stride * Math.cos(this.phase * 2);
      this.rig.position.y = pelvisY - 0.82;
      this.rig.rotation.x = 0;
      const yaw = this.group.rotation.y;
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      const dx = this.feetReady ? this.x - this.previous.x : 0;
      const dz = this.feetReady ? this.z - this.previous.z : 0;
      let largest = 0.035;
      let candidate = -1;
      for (const [i, leg] of this.legs.entries()) {
        const lateral = leg.side * 0.104;
        const stagger = leg.side * 0.032 + this.kneeling * (leg.side > 0 ? 0.19 : 0.05);
        this.target.set(this.x + cos*lateral + sin*stagger, this.footY, this.z - sin*lateral + cos*stagger);
        const foot = this.feet[i]!;
        if (!this.feetReady) foot.copy(this.target);
        const error = Math.hypot(foot.x-this.target.x, foot.z-this.target.z);
        if (error > largest) {
          largest = error;
          candidate = i;
          if (this.swing < 0) this.stepEnd.copy(this.target).addScaledVector(
            this.target.set(dx,0,dz), Math.min(12,0.08 / Math.max(dt,0.001)));
        }
      }
      this.previous.set(this.x, this.footY, this.z);
      this.feetReady = true;
      if (this.swing < 0 && candidate >= 0) {
        this.swing = candidate;
        this.stepTime = 0;
        this.stepStart.copy(this.feet[candidate]!);
        this.stepEnd.y = this.ground.length ? sampleGround(this.ground,this.stepEnd.x,this.stepEnd.z,this.footY,0.045) : this.footY;
      }
      if (this.swing >= 0) {
        this.stepTime = Math.min(1,this.stepTime + dt / (0.19 - 0.055 * this.stride));
        const foot = this.feet[this.swing]!;
        foot.lerpVectors(this.stepStart,this.stepEnd,THREE.MathUtils.smoothstep(this.stepTime,0,1));
        foot.y += Math.sin(Math.PI*this.stepTime) * (0.035 + 0.045*this.stride);
        if (this.stepTime >= 1) this.swing = -1;
      }
      for (const [i,{ hip, knee, ankle, side }] of this.legs.entries()) {
        const foot = this.feet[i]!;
        const fx = foot.x-this.x, fz = foot.z-this.z;
        const lateral = fx*cos-fz*sin-hip.position.x;
        const z = fx*sin+fz*cos;
        const staggerDrop = this.pose === 'kneel' ? side * 0.07 * Math.sin(Math.PI*this.kneeling) : 0;
        hip.position.y = 0.82 + staggerDrop;
        const y = pelvisY + staggerDrop - (foot.y-this.footY+0.061);
        hip.rotation.order = 'ZXY';
        hip.rotation.z = Math.atan2(lateral,y);
        const vertical = Math.hypot(y,lateral);
        // Two-link IK keeps the supporting boot on the floor while the hips descend.
        const reach = Math.min(0.7399, Math.hypot(vertical, z));
        const thighAngle = Math.atan2(-z, vertical) +
          Math.acos(THREE.MathUtils.clamp((0.38 ** 2 + reach ** 2 - 0.36 ** 2) / (2 * 0.38 * reach), -1, 1));
        hip.rotation.x = thighAngle;
        knee.rotation.x = -Math.acos(THREE.MathUtils.clamp((reach ** 2 - 0.38 ** 2 - 0.36 ** 2) / (2 * 0.38 * 0.36), -1, 1));
        ankle.rotation.x = -hip.rotation.x - knee.rotation.x;
      }
      this.restrainBlend += ((this.restrained ? 1 : 0) - this.restrainBlend) * blend;
      for (const { shoulder, elbow, side } of this.arms) {
        const carry = this.gunShown && this.pose !== 'kneel' ? 1 : 0;
        const high = this.readyPose === 'high' ? 1 : 0;
        const carryShoulder = carry * (0.28 + high * 0.28 + this.aimPitch * 0.45);
        const carryElbow = carry * (0.82 + high * 0.34);
        const baseShoulderX = carryShoulder + (1 - carry) * side * Math.cos(this.phase) * this.stride * 0.44 + this.kneeling * 0.76;
        const baseShoulderZ = side * this.kneeling * 0.65;
        const baseElbowX = 0.13 + carryElbow + this.kneeling * 1.53;
        shoulder.rotation.x = THREE.MathUtils.lerp(baseShoulderX, -0.45, this.restrainBlend);
        shoulder.rotation.z = THREE.MathUtils.lerp(baseShoulderZ, -side * 0.12, this.restrainBlend);
        elbow.rotation.x = THREE.MathUtils.lerp(baseElbowX, -0.32, this.restrainBlend);
        elbow.rotation.z = THREE.MathUtils.lerp(0, -side * 0.72, this.restrainBlend);
      }
    } else {
      const t = THREE.MathUtils.smoothstep(this.poseTime, 0, 0.55);
      this.rig.rotation.x = -Math.PI / 2 * t;
      this.rig.position.y = THREE.MathUtils.lerp(this.fallStart,0.25,t);
      this.rig.position.z = -0.55*t;
      for (const leg of this.legs) leg.knee.rotation.x += (-0.85-leg.knee.rotation.x)*blend;
    }
    this.torso.rotation.z = this.shake * 0.18;
    this.torso.rotation.y *= Math.exp(-8*dt);
    if (this.gunShown && this.gun && this.gun.parent === this.rig) {
      const targetGunY = this.readyPose === 'high' ? 1.24 : 1.13;
      const targetGunZ = this.readyPose === 'high' ? -0.23 : -0.21;
      const targetPitch = this.readyPose === 'high' ? this.aimPitch * 0.65 : -0.28;
      this.gun.position.y += (targetGunY - this.gun.position.y) * blend;
      this.gun.position.z += (targetGunZ - this.gun.position.z) * blend;
      this.gun.rotation.x += (targetPitch - this.gun.rotation.x) * blend;
    }
    if (this.gunShown && this.gun && this.gun.parent === this.group) {
      const t = THREE.MathUtils.smoothstep(this.poseTime,0.05,0.42);
      this.gun.position.lerpVectors(this.releaseStart,this.target.set(0.32,0.06,0.15),t);
      this.gun.rotation.z = THREE.MathUtils.lerp(this.releaseRoll,1.2,t);
    }
    if (this.muzzleLeft <= 0) return;
    this.muzzleLeft -= dt;
    if (this.muzzleLeft <= 0) this.muzzle.visible = false;
  }

  setTint(hex: number): void {
    this.baseColor = hex;
    if (this.pose !== 'down') this.cloth.color.setHex(hex);
  }

  getDroppedWeaponPos(): { x: number; y: number; z: number } | null {
    if (!this.gun || !this.gun.visible || this.pose === 'stand' || this.pose === 'crouch') return null;
    const v = new THREE.Vector3();
    this.gun.getWorldPosition(v);
    return { x: v.x, y: v.y, z: v.z };
  }

  getAABB(): AABB {
    const hw = BODY_W / 2;
    const hd = BODY_D / 2;
    const top = this.footY + (this.pose === 'down' ? 0.45 : this.height);
    return {
      min: { x: this.x - hw, y: this.footY, z: this.z - hd },
      max: { x: this.x + hw, y: top, z: this.z + hd },
    };
  }

  chestPos(): { x: number; y: number; z: number } {
    return { x: this.x, y: this.footY + Math.min(this.height * 0.72, 1.25), z: this.z };
  }

  get yawRad(): number {
    return this.group.rotation.y;
  }

  gaze(out: THREE.Vector3): THREE.Vector3 {
    return this.headPivot.getWorldDirection(out).negate();
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    return this.headPivot.localToWorld(out.set(0,0.125,-0.1));
  }

  setReadyPose(mode: 'low' | 'high'): void {
    this.readyPose = mode;
  }

  /** 指定ワールド座標へ体・頭・銃口を滑らかに向ける（胸・目線高さの戦術エイム用）。 */
  aimAt(x: number, y: number, z: number, dt: number, maxTurn = Infinity): void {
    const dx = x - this.x;
    const dz = z - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return;
    const bearing = Math.atan2(this.x - x, this.z - z);
    const delta = bearing - this.yawRad;
    const neck = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(neck) > 0.65) this.faceToward(x, z, maxTurn);
    const blend = 1 - Math.exp(-10 * Math.min(dt, 0.05));
    const headYaw = Math.abs(neck) > 0.65 ? Math.sign(neck) * 0.35 : neck;
    this.headPivot.rotation.y += (THREE.MathUtils.clamp(headYaw, -0.75, 0.75) - this.headPivot.rotation.y) * blend;
    const rawPitch = Math.atan2(y - (this.footY + 1.55), dist);
    const pitch = THREE.MathUtils.clamp(rawPitch, -0.45, 0.45);
    this.headPivot.rotation.x += (pitch - this.headPivot.rotation.x) * blend;
    this.aimPitch += (pitch - this.aimPitch) * blend;
  }

  lookAtFloor(x: number, y: number, z: number, dt: number): void {
    this.aimAt(x, y, z, dt);
  }

  faceToward(x: number, z: number, maxTurn = Infinity): void {
    const dx = x - this.x;
    const dz = z - this.z;
    if (Math.hypot(dx, dz) < 1e-4) return;
    const delta = Math.atan2(-dx, -dz) - this.group.rotation.y;
    const shortest = Math.atan2(Math.sin(delta), Math.cos(delta));
    const limit = Math.min(maxTurn, 5 * this.lastDt);
    this.group.rotation.y += THREE.MathUtils.clamp(shortest, -limit, limit);
    this.torso.rotation.y = THREE.MathUtils.clamp(shortest, -0.26, 0.26);
  }

  get isDown(): boolean {
    return this.pose === 'down';
  }

  get px(): number {
    return this.x;
  }
  get pz(): number {
    return this.z;
  }

  dispose(): void {
    for (const m of this.mats) {
      if (m instanceof THREE.MeshStandardMaterial) m.map = null;
      m.dispose();
    }
    for (const g of this.geos) g.dispose();
    this.mats.length = 0;
    this.geos.length = 0;
  }
}
