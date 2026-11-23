import * as THREE from 'three';
import type { GameEventBus, NoiseKind, NoiseSource } from '../core/events';
import type { PerceptionConfig, Vec3 } from '../core/types';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Collider } from '../world/WorldBuilder';
import type { AllyTarget } from './EngageBehavior';
import type { Suspect } from './Suspect';

/** 知覚が参照するプレイヤー情報（リーン込みの目の位置・足元位置・しゃがみ） */
export interface PerceptionTarget {
  getEyePosition(out?: THREE.Vector3): THREE.Vector3;
  readonly position: THREE.Vector3;
  readonly isCrouching: boolean;
  readonly alive?: boolean;
}

const DEG2RAD = Math.PI / 180;
/** 足音の聴覚レイ基準オフセット（足元 → 胴の高さ。設計書 §2.2 NOISE_FOOTSTEP_OFFSET） */
const NOISE_FOOTSTEP_OFFSET = 1.2;
/** 床上閃光弾の聴覚レイ基準オフセット（床スラブ上面との自己交差回避。設計書 §2.2 NOISE_FLASH_OFFSET） */
const NOISE_FLASH_OFFSET = 0.25;

/**
 * 音源種別ごとの聴覚レイ始点の高さ（設計書 §3.2(6)）。
 * - footstep: 足元座標で発火するため +1.2m（胴の高さ）
 * - flash: 床上の弾体座標で発火するため +0.25m（床スラブ上面との自己交差回避）
 * - gunshot / voice / door / breach 等: 目・胸・ノブ高で発火するため pos.y をそのまま使う
 * 地下（y < 0）の音源を 1F 床へ切り上げない（旧 Math.max(pos.y, 0) は廃止）。
 */
export function noiseRayOriginY(pos: Vec3, kind: string): number {
  if (kind === 'footstep') return pos.y + NOISE_FOOTSTEP_OFFSET;
  if (kind === 'flash') return pos.y + NOISE_FLASH_OFFSET;
  return pos.y;
}

/**
 * 容疑者の知覚（プレイヤー＋生存隊員の双方を検知）。
 * 聴覚: noise を購読し、半径×profile.hearingMultiplier×種別倍率 内なら ALERT（遮蔽は occludedMultiplier）。
 * 視覚: 視野角・距離・遮蔽レイキャスト(壁/遮蔽物/ドア板の共有 colliders)で目と胴の2点を判定し、
 *       reactionTime 秒継続して見えたら CONFRONTATION。リーンは目の位置に反映される。
 */
export class Perception {
  private readonly unsubs: (() => void)[] = [];
  private readonly seen = new Map<string, number>();
  private readonly eye = new THREE.Vector3();
  private alliesProvider?: () => readonly AllyTarget[];
  private disposed = false;

  constructor(
    private readonly cfg: PerceptionConfig,
    private readonly suspects: () => Iterable<Suspect>,
    private readonly colliders: readonly Collider[],
    private readonly player: PerceptionTarget,
    bus: GameEventBus,
    /** 容疑者モードの味方 NPC。プレイヤーの姿と足音では警戒しない */
    private readonly ignorePlayer = false,
  ) {
    this.unsubs.push(bus.on('noise', (e) => this.onNoise(e.pos, e.radius, e.kind, e.source)));
  }

  attachAllies(allies: () => readonly AllyTarget[]): void {
    this.alliesProvider = allies;
  }

  private anySuspectOpeningDoor(): boolean {
    for (const s of this.suspects()) {
      if (s.isOpeningDoor) return true;
    }
    return false;
  }

  private onNoise(pos: Vec3, radius: number, kind: NoiseKind, source?: NoiseSource): void {
    // 容疑者自身がドアを開閉した音による他容疑者の無限 ALERT 連鎖を防止
    if (kind === 'door' && (source === 'suspect' || this.anySuspectOpeningDoor())) return;
    if (this.ignorePlayer && source === 'player') return;
    const h = this.cfg.hearing;
    const kindMul = h.kinds[kind] ?? 1;
    const checkWalls = !h.unoccludedKinds.includes(kind);
    const from = { x: pos.x, y: noiseRayOriginY(pos, kind), z: pos.z };
    for (const s of this.suspects()) {
      const canAlert = s.canPerceive;
      const canEngage = s.canUpdateKnownFromNoise && source !== 'suspect';
      if (!canAlert && !canEngage) continue;
      const dist = Math.hypot(s.body.px - pos.x, s.body.footY - pos.y, s.body.pz - pos.z);
      let r = radius * s.profile.hearingMultiplier * kindMul;
      if (dist > r) continue;
      if (checkWalls && h.occludedMultiplier < 1 && !hasLineOfSight(this.colliders, from, s.body.chestPos())) {
        r *= h.occludedMultiplier;
        if (dist > r) continue;
      }
      if (canAlert) {
        s.onHeardNoise(pos, kind, source);
      } else if (canEngage) {
        s.onEngageNoise(pos, kind);
      }
    }
  }

  /** 視覚判定（毎フレーム）。プレイヤーと味方隊員の最寄り視認対象を検知。 */
  update(dt: number): void {
    const v = this.cfg.vision;
    this.player.getEyePosition(this.eye);
    const eye = { x: this.eye.x, y: this.eye.y, z: this.eye.z };
    const body = { x: this.player.position.x, y: eye.y - v.bodyPointDrop, z: this.player.position.z };
    const playerRange = v.range * (this.player.isCrouching ? v.crouchRangeMultiplier : 1);
    const allies = this.alliesProvider?.() ?? [];

    for (const s of this.suspects()) {
      if (!s.canPerceive) {
        this.seen.delete(s.id);
        continue;
      }
      const alert = s.state === 'ALERT';
      const cosHalf = Math.cos(((alert ? v.alertFovDeg : v.fovDeg) / 2) * DEG2RAD);
      const sx = s.body.px;
      const sz = s.body.pz;
      const origin = { x: sx, y: s.body.footY + v.eyeHeight, z: sz };
      const fx = -Math.sin(s.body.yawRad);
      const fz = -Math.cos(s.body.yawRad);

      const checkPts = (pts: Vec3[], range: number): boolean =>
        pts.some((p) => {
          const dx = p.x - sx;
          const dz = p.z - sz;
          const d = Math.hypot(dx, dz);
          if (d > range) return false;
          if (d > 0.01 && (dx * fx + dz * fz) / d < cosHalf) return false;
          return hasLineOfSight(this.colliders, origin, p);
        });

      let spottedAt: Vec3 | null = null;
      let bestDist = Infinity;

      if (!this.ignorePlayer && this.player.alive !== false && checkPts([eye, body], playerRange)) {
        bestDist = Math.hypot(eye.x - sx, eye.z - sz);
        spottedAt = { x: eye.x, y: this.player.position.y, z: eye.z };
      }
      for (const a of allies) {
        const d = Math.hypot(a.px - sx, a.pz - sz);
        if (d < bestDist && checkPts([a.getEye(), a.getChest()], v.range)) {
          bestDist = d;
          spottedAt = { x: a.px, y: a.footY, z: a.pz };
        }
      }

      const t = this.seen.get(s.id) ?? 0;
      if (!spottedAt) {
        this.seen.set(s.id, Math.max(0, t - dt));
        continue;
      }
      const need = s.profile.reactionTime * (alert ? v.alertReactionMultiplier : 1);
      const nt = t + dt;
      this.seen.set(s.id, nt);
      if (nt >= need) {
        s.onSpotted(spottedAt);
        this.seen.delete(s.id);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.seen.clear();
  }
}
