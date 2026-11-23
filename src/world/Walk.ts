import type { MapData } from '../core/types';
import type { Collider } from './WorldBuilder';
import { collidersNear } from './ColliderIndex';

/** これ以下の段差は水平衝突を無視して乗り上げる（m）。階段の rise はこの値以下。 */
export const STEP_HEIGHT = 0.45;
/** 直下に通常支持が無いとき、微小めり込みからの復帰として許す上方向の上限（m）。 */
const SINK_RECOVERY = 0.5;

export interface StairMark {
  id: string;
  /** 最下段の中心（XZ）と上面高 */
  lowX: number;
  lowZ: number;
  lowY: number;
  /** 最上段の中心（XZ）と上面高 */
  highX: number;
  highZ: number;
  highY: number;
  /** 下階の床高（= StairDef.y ?? 0） */
  baseY: number;
  /** 上階の床高（= 最上段の上面高） */
  topY: number;
  /** 下端の手前 0.45m（下階床上の進入/退出点） */
  approachLow: { x: number; z: number };
  /** 上端の奥 0.45m（上階床上の進入/退出点） */
  approachHigh: { x: number; z: number };
}

/**
 * 旧固定マップ（`floors` が空かつ地下室なし）か。真のとき無支持の (x,z) は従来どおり地面 y=0 とみなす。
 * それ以外（モジュラー・`floors` 付き・B1 付き）は無支持を `null`（支持なし）として扱う。
 */
export function isLegacyGroundMap(map: Pick<MapData, 'floors' | 'rooms'>): boolean {
  return map.floors.length === 0 && !map.rooms.some((r) => (r.floorY ?? 0) < 0);
}

/** WorldBuilder がコライダ配列ごとに登録する接地方針（同じ配列インスタンスを全システムが共有する）。 */
const groundPolicy = new WeakMap<readonly Collider[], boolean>();

/** コライダ配列に「旧マップ互換の y=0 フォールバックを使うか」を登録する。 */
export function registerGroundPolicy(colliders: readonly Collider[], legacyZeroFallback: boolean): void {
  groundPolicy.set(colliders, legacyZeroFallback);
}

/** 登録済みの接地方針。未登録の配列は従来互換（y=0 フォールバック）として扱う。 */
export function legacyZeroFallbackOf(colliders: readonly Collider[]): boolean {
  return groundPolicy.get(colliders) ?? true;
}

/**
 * (x,z,radius) と交差する実 floor / stair 上面のうち、feetY + STEP_HEIGHT 以下で最も高い面。
 * 通常支持が無く feetY + 0.50 以下の面がある場合は微小めり込み復帰としてその面を返す。
 * 何も無い場合: legacyZeroFallback なら 0、そうでなければ null（支持なし）。
 */
export function probeGround(
  colliders: readonly Collider[],
  x: number,
  z: number,
  feetY: number,
  radius: number,
  legacyZeroFallback: boolean = legacyZeroFallbackOf(colliders),
): number | null {
  let best = -Infinity;
  let recover = -Infinity;
  const limit = feetY + STEP_HEIGHT + 0.02;
  const recoverLimit = feetY + SINK_RECOVERY;
  const r2 = radius * radius;
  for (const c of collidersNear(colliders, x - radius, z - radius, x + radius, z + radius)) {
    if (c.kind !== 'floor' && c.kind !== 'stair') continue;
    const a = c.aabb;
    if (a.max.y > recoverLimit) continue;
    const cx = Math.max(a.min.x, Math.min(x, a.max.x));
    const cz = Math.max(a.min.z, Math.min(z, a.max.z));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz > r2) continue;
    if (a.max.y <= limit) {
      if (a.max.y > best) best = a.max.y;
    } else if (a.max.y > recover) {
      recover = a.max.y;
    }
  }
  if (legacyZeroFallback) {
    // 旧固定マップは従来どおり「地面 y=0 より下には落ちない」（旧 sampleGround と同一の結果）
    return Math.max(best, 0);
  }
  if (best > -Infinity) return best;
  if (recover > -Infinity) return recover;
  return null;
}

/**
 * probeGround の数値ラッパー（足 IK 等の既存呼び出し互換）。支持なしは fallbackY ?? feetY。
 */
export function sampleGround(
  colliders: readonly Collider[],
  x: number,
  z: number,
  feetY: number,
  radius: number,
  fallbackY?: number,
): number {
  return probeGround(colliders, x, z, feetY, radius) ?? fallbackY ?? feetY;
}

/** 段差は即乗せ、下りは maxDrop までに制限して穴へ落ちる。 */
export function nextFootY(current: number, support: number, maxDrop: number): number {
  if (support + 0.02 >= current) return support;
  return Math.max(support, current - maxDrop);
}
