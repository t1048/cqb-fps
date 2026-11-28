import type { OptiwandConfig, Vec3 } from '../core/types';
import { hasLineOfSight } from '../weapons/Flashbang';
import { raycastColliders } from '../world/ColliderIndex';
import type { Collider } from '../world/WorldBuilder';

const DEG2RAD = Math.PI / 180;

/** オプティワンドの幾何計算が必要とするドアの最小記述（Door がそのまま満たす）。 */
export interface WandDoor {
  readonly id: string;
  readonly centerX: number;
  readonly centerZ: number;
  readonly normalX: number;
  readonly normalZ: number;
  readonly axisX: number;
  readonly axisZ: number;
  readonly width: number;
  readonly sillY: number;
  readonly angle: number;
  readonly peekAngle: number;
}

export type WandMode = 'free' | 'door';

export interface WandPose {
  mode: WandMode;
  x: number;
  y: number;
  z: number;
  /** カメラ向き（ラジアン。前方 = (-sin yaw, -cos yaw)） */
  yaw: number;
  pitch: number;
  doorId: string | null;
  /** ドア下カメラ時の「向こう側」単位ベクトル（部屋の内側方向） */
  farX: number;
  farZ: number;
}

/** プレイヤー目線が、ドアの下を覗かせられる位置・状態か（距離内・ほぼ閉じている）。 */
export function doorEligible(door: WandDoor, eye: { x: number; z: number }, cfg: OptiwandConfig): boolean {
  const d = Math.hypot(eye.x - door.centerX, eye.z - door.centerZ);
  if (d > cfg.doorRange + door.width * 0.5) return false;
  // 全開（ピークを大きく超える）ドアは隙間ではなく開口なので対象外
  return door.angle <= door.peekAngle * 1.25 + 1;
}

/** ドアの手前側（プレイヤー側）の符号。法線方向に対し eye がどちら側か。 */
export function nearSideSign(door: WandDoor, eye: { x: number; z: number }): 1 | -1 {
  return (eye.x - door.centerX) * door.normalX + (eye.z - door.centerZ) * door.normalZ >= 0 ? 1 : -1;
}

export function yawFacing(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
}

/**
 * ドア下カメラの位置と向き。
 * - 向こう側（プレイヤーと反対側）のドア面から数 cm 先、床から doorCamHeight 付近。
 * - 横位置はプレイヤー目線の射影（ドア幅の端を避ける）。
 * - 首振り: yawOffset(rad) は ±yawLimitDeg、pitch(rad) は pitchLimitDeg にクランプ。
 */
export function computeDoorPose(
  door: WandDoor,
  eye: { x: number; z: number },
  cfg: OptiwandConfig,
  doorThickness: number,
  yawOffset: number,
  pitch: number,
): WandPose {
  const side = nearSideSign(door, eye);
  const farX = -side * door.normalX;
  const farZ = -side * door.normalZ;
  const along = (eye.x - door.centerX) * door.axisX + (eye.z - door.centerZ) * door.axisZ;
  const lim = Math.max(0, door.width / 2 - 0.15);
  const lat = Math.max(-lim, Math.min(lim, along));
  // 少し開いている（ピーク）ときは開いた扉板を避けるため、開き角に応じて奥へ送る
  const ajarExtra = door.angle > 2 ? Math.sin(door.angle * DEG2RAD) * (door.width / 2) + 0.08 : 0;
  const off = doorThickness / 2 + cfg.doorCamPastPlane + ajarExtra;
  const yawLim = cfg.yawLimitDeg * DEG2RAD;
  const yo = Math.max(-yawLim, Math.min(yawLim, yawOffset));
  const pitchClamped = Math.max(cfg.pitchLimitDeg[0] * DEG2RAD, Math.min(cfg.pitchLimitDeg[1] * DEG2RAD, pitch));
  const camY = door.sillY + (cfg.doorCamHeight[0] + cfg.doorCamHeight[1]) / 2;
  return {
    mode: 'door',
    x: door.centerX + door.axisX * lat + farX * off,
    y: camY,
    z: door.centerZ + door.axisZ * lat + farZ * off,
    yaw: yawFacing(farX, farZ) + yo,
    pitch: pitchClamped,
    doorId: door.id,
    farX,
    farZ,
  };
}

/** 先端カメラが側面・上下の壁に近すぎてニアクリップでめり込まないよう、最小離隔 clearance を確保する。 */
function pushTipClearOfColliders(pos: Vec3, eye: Vec3, colliders: readonly Collider[], clearance: number): Vec3 {
  if (clearance <= 0) return pos;
  let { x, y, z } = pos;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const c of colliders) {
      const a = c.aabb;
      // 目線自体がコライダ内部にある異常ケースでは背後へ押し出さない
      if (
        eye.x >= a.min.x && eye.x <= a.max.x &&
        eye.y >= a.min.y && eye.y <= a.max.y &&
        eye.z >= a.min.z && eye.z <= a.max.z
      ) {
        continue;
      }
      if (
        x < a.min.x - clearance || x > a.max.x + clearance ||
        y < a.min.y - clearance || y > a.max.y + clearance ||
        z < a.min.z - clearance || z > a.max.z + clearance
      ) {
        continue;
      }
      const cx = Math.max(a.min.x, Math.min(a.max.x, x));
      const cy = Math.max(a.min.y, Math.min(a.max.y, y));
      const cz = Math.max(a.min.z, Math.min(a.max.z, z));
      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= clearance * clearance) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = clearance - d;
        x += (dx / d) * push;
        y += (dy / d) * push;
        z += (dz / d) * push;
      } else {
        const oxMin = x - a.min.x;
        const oxMax = a.max.x - x;
        const oyMin = y - a.min.y;
        const oyMax = a.max.y - y;
        const ozMin = z - a.min.z;
        const ozMax = a.max.z - z;
        const m = Math.min(oxMin, oxMax, oyMin, oyMax, ozMin, ozMax);
        if (m === oxMin) x = a.min.x - clearance;
        else if (m === oxMax) x = a.max.x + clearance;
        else if (m === oyMin) y = a.min.y - clearance;
        else if (m === oyMax) y = a.max.y + clearance;
        else if (m === ozMin) z = a.min.z - clearance;
        else z = a.max.z + clearance;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return { x, y, z };
}

/**
 * 通常時の先端位置と向き:
 * - 先端位置は目線（リーン込み）からロッド方向 (rodYaw, rodPitch) へ cfg.reach 進めた点。
 *   正面の壁はレイキャストで手前 wallClearance に止め、側面・上下の壁からも wallClearance を確保する。
 * - カメラの向き (lookYaw, lookPitch) は先端を軸に首振りする（ロッド自体は振り回さない）。
 */
export function computeFreePose(
  eye: Vec3,
  rodYaw: number,
  rodPitch: number,
  colliders: readonly Collider[],
  cfg: OptiwandConfig,
  lookYaw: number = rodYaw,
  lookPitch: number = rodPitch,
): WandPose {
  const cpRod = Math.cos(rodPitch);
  const rodDir = { x: -Math.sin(rodYaw) * cpRod, y: Math.sin(rodPitch), z: -Math.cos(rodYaw) * cpRod };
  const hit = raycastColliders(colliders, eye, rodDir, cfg.reach + cfg.wallClearance);
  const dist = Math.max(0.04, Math.min(cfg.reach, hit - cfg.wallClearance));
  const tip = pushTipClearOfColliders(
    {
      x: eye.x + rodDir.x * dist,
      y: eye.y + rodDir.y * dist,
      z: eye.z + rodDir.z * dist,
    },
    eye,
    colliders,
    cfg.wallClearance,
  );
  const cpLook = Math.cos(lookPitch);
  return {
    mode: 'free',
    x: tip.x,
    y: tip.y,
    z: tip.z,
    yaw: lookYaw,
    pitch: lookPitch,
    doorId: null,
    farX: -Math.sin(lookYaw) * cpLook,
    farZ: -Math.cos(lookYaw) * cpLook,
  };
}

export interface ViewHit {
  inView: boolean;
  dist: number;
}

/** カメラ（位置・yaw/pitch・垂直 fov・アスペクト）の視錐台内に点があるか。 */
export function pointInWandView(
  pose: { x: number; y: number; z: number; yaw: number; pitch: number },
  fovYDeg: number,
  aspect: number,
  p: Vec3,
): ViewHit {
  const sy = Math.sin(pose.yaw);
  const cy = Math.cos(pose.yaw);
  const sp = Math.sin(pose.pitch);
  const cp = Math.cos(pose.pitch);
  const fx = -sy * cp;
  const fy = sp;
  const fz = -cy * cp;
  const rx = cy;
  const rz = -sy;
  const ux = sy * sp;
  const uy = cp;
  const uz = cy * sp;
  const dx = p.x - pose.x;
  const dy = p.y - pose.y;
  const dz = p.z - pose.z;
  const z = dx * fx + dy * fy + dz * fz;
  const dist = Math.hypot(dx, dy, dz);
  if (z < 0.05) return { inView: false, dist };
  const x = dx * rx + dz * rz;
  const y = dx * ux + dy * uy + dz * uz;
  const tanV = Math.tan((fovYDeg * DEG2RAD) / 2);
  const tanH = tanV * aspect;
  return { inView: Math.abs(x) <= z * tanH && Math.abs(y) <= z * tanV, dist };
}

/** スポット対象（容疑者・民間人）の最小記述 */
export interface WandContactSource {
  id: string;
  kind: 'suspect' | 'civilian';
  armed: boolean;
  chest: Vec3;
  eye: Vec3;
}

/**
 * 連続視認時間の蓄積と「発見」判定。cfg.spotSec 以上見え続けた接触を fresh に返す。
 * 見えなくなると蓄積は 2 倍速で減衰する（一瞬の見切れで即リセットはしない）。
 */
export class WandSpotter {
  private readonly seenSec = new Map<string, number>();
  private readonly spotted = new Set<string>();

  reset(): void {
    this.seenSec.clear();
    this.spotted.clear();
  }

  hasSpotted(id: string): boolean {
    return this.spotted.has(id);
  }

  /** visible=今フレーム見えている接触, fresh=今フレーム新たに「発見」になった接触 */
  update(
    dt: number,
    pose: { x: number; y: number; z: number; yaw: number; pitch: number },
    cfg: OptiwandConfig,
    aspect: number,
    sources: Iterable<WandContactSource>,
    colliders: readonly Collider[],
  ): { visible: WandContactSource[]; fresh: WandContactSource[] } {
    const visible: WandContactSource[] = [];
    const fresh: WandContactSource[] = [];
    const seenNow = new Set<string>();
    const tip: Vec3 = { x: pose.x, y: pose.y, z: pose.z };
    for (const c of sources) {
      let ok = false;
      for (const pt of [c.chest, c.eye]) {
        const v = pointInWandView(pose, cfg.fovDeg, aspect, pt);
        if (!v.inView || v.dist > cfg.viewRange) continue;
        if (!hasLineOfSight(colliders, tip, pt)) continue;
        ok = true;
        break;
      }
      if (!ok) continue;
      seenNow.add(c.id);
      visible.push(c);
      const t = (this.seenSec.get(c.id) ?? 0) + dt;
      this.seenSec.set(c.id, t);
      if (t >= cfg.spotSec && !this.spotted.has(c.id)) {
        this.spotted.add(c.id);
        fresh.push(c);
      }
    }
    for (const [id, t] of this.seenSec) {
      if (seenNow.has(id)) continue;
      const next = t - dt * 2;
      if (next <= 0) this.seenSec.delete(id);
      else this.seenSec.set(id, next);
    }
    return { visible, fresh };
  }
}

export interface NoticeCandidate {
  id: string;
  x: number;
  y: number;
  z: number;
  /** 視線の高さ */
  eyeY: number;
  /** 向いている方向（HumanoidBody の yawRad: 前方 = (-sin, -cos)） */
  yawRad: number;
}

/**
 * ワンド先端が容疑者に気付かれる判定。noticeRange 以内・おおむね正面（±60°）・視線が通る容疑者ごとに
 * 確率 noticePerSec×dt（ドア下は noticeUnderDoorMul 倍）で気付かれる。
 */
export function rollNotices(
  dt: number,
  tip: Vec3,
  candidates: Iterable<NoticeCandidate>,
  cfg: OptiwandConfig,
  underDoor: boolean,
  colliders: readonly Collider[],
  rand: () => number = Math.random,
): string[] {
  const out: string[] = [];
  const p = cfg.noticePerSec * dt * (underDoor ? cfg.noticeUnderDoorMul : 1);
  if (p <= 0) return out;
  for (const c of candidates) {
    const dx = tip.x - c.x;
    const dz = tip.z - c.z;
    const d = Math.hypot(dx, dz);
    if (d > cfg.noticeRange) continue;
    if (d > 0.05) {
      const cos = (dx * -Math.sin(c.yawRad) + dz * -Math.cos(c.yawRad)) / d;
      if (cos < 0.5) continue;
    }
    if (!hasLineOfSight(colliders, { x: c.x, y: c.eyeY, z: c.z }, tip)) continue;
    if (rand() < p) out.push(c.id);
  }
  return out;
}

/** 呼び出し文言（日本語, 英語）。例: ["接触2名: 武装容疑者1、民間人1", "2 contacts: 1 armed suspect, 1 civilian"] */
export function contactCallout(
  armed: number,
  unarmed: number,
  civilians: number,
  prefix: { ja: string; en: string } = { ja: '', en: '' },
): [ja: string, en: string] {
  const total = armed + unarmed + civilians;
  if (total === 0) return [`${prefix.ja}接触なし`, `${prefix.en}no contacts`];
  const partsJa: string[] = [];
  const partsEn: string[] = [];
  if (armed > 0) {
    partsJa.push(`武装容疑者${armed}`);
    partsEn.push(`${armed} armed suspect${armed > 1 ? 's' : ''}`);
  }
  if (unarmed > 0) {
    partsJa.push(`非武装${unarmed}`);
    partsEn.push(`${unarmed} unarmed`);
  }
  if (civilians > 0) {
    partsJa.push(`民間人${civilians}`);
    partsEn.push(`${civilians} civilian${civilians > 1 ? 's' : ''}`);
  }
  return [
    `${prefix.ja}接触${total}名: ${partsJa.join('、')}`,
    `${prefix.en}${total} contact${total > 1 ? 's' : ''}: ${partsEn.join(', ')}`,
  ];
}

export function contactCalloutText(
  armed: number,
  unarmed: number,
  civilians: number,
  t: (ja: string, en: string) => string,
): string {
  const [ja, en] = contactCallout(armed, unarmed, civilians);
  return t(ja, en);
}

/**
 * 左クリック長押しで展開したときのカメラ種別。
 * しゃがみ姿勢で、狙っているドアが隙間として使える（距離・開度）ときだけドア下、それ以外は前方（角越し）。
 */
export function chooseWandViewMode(
  crouching: boolean,
  aimedDoor: WandDoor | null,
  eye: { x: number; z: number },
  cfg: OptiwandConfig,
): 'door' | 'free' {
  return crouching && aimedDoor !== null && doorEligible(aimedDoor, eye, cfg) ? 'door' : 'free';
}

/** 前方（角越し）カメラの首振り: 展開開始時の向きを基準に、マウス移動量で相対的に振る。 */
export class FreeLook {
  private baseYaw = 0;
  private basePitch = 0;
  private yawOff = 0;
  private pitchOff = 0;

  constructor(
    private readonly yawLimitRad: number,
    private readonly pitchMinRad: number,
    private readonly pitchMaxRad: number,
  ) {}

  /** 展開開始時のプレイヤーの向きを記録して首振りを 0 に戻す */
  start(yaw: number, pitch: number): void {
    this.baseYaw = yaw;
    this.basePitch = pitch;
    this.yawOff = 0;
    this.pitchOff = 0;
  }

  /** dx/dy はマウス移動量（rad 換算済み・右/下が正）。 */
  pan(dx: number, dy: number): void {
    this.yawOff = Math.max(-this.yawLimitRad, Math.min(this.yawLimitRad, this.yawOff - dx));
    const pitch = Math.max(this.pitchMinRad, Math.min(this.pitchMaxRad, this.basePitch + this.pitchOff - dy));
    this.pitchOff = pitch - this.basePitch;
  }

  get yaw(): number {
    return this.baseYaw + this.yawOff;
  }

  get pitch(): number {
    return Math.max(this.pitchMinRad, Math.min(this.pitchMaxRad, this.basePitch + this.pitchOff));
  }

  get yawOffset(): number {
    return this.yawOff;
  }

  get pitchOffset(): number {
    return this.pitchOff;
  }
}
