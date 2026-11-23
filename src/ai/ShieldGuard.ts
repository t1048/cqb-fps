import type { Vec3 } from '../core/types';

/** 盾が守る下端（立ち姿勢での足元からの高さ m）。これより低い位置（脛・足）は撃たれる */
export const SHIELD_BOTTOM = 0.42;
/** 盾が守る正面の扇（片側 °）。側面・背後からは普通に撃てる */
export const SHIELD_HALF_ARC_DEG = 65;
const COS_ARC = Math.cos((SHIELD_HALF_ARC_DEG * Math.PI) / 180);
const STAND_H = 1.75;

export interface ShieldBearer {
  readonly hasShield: boolean;
  readonly px: number;
  readonly pz: number;
  readonly footY: number;
  readonly height: number;
  readonly yawRad: number;
  readonly isDown: boolean;
}

/**
 * from から撃たれた弾が hit で盾に当たって止まるか。
 * 盾は体の正面 ±SHIELD_HALF_ARC_DEG、脛より上（頭まで）を覆う。足元（脛・足）と側面・背後は無防備。
 */
export function shieldBlocks(b: ShieldBearer, from: Vec3, hit: Vec3): boolean {
  if (!b.hasShield || b.isDown) return false;
  const bottom = SHIELD_BOTTOM * Math.min(1, b.height / STAND_H);
  if (hit.y - b.footY <= bottom) return false;
  const sx = from.x - b.px;
  const sz = from.z - b.pz;
  const l = Math.hypot(sx, sz);
  if (l < 1e-3) return false;
  const fx = -Math.sin(b.yawRad);
  const fz = -Math.cos(b.yawRad);
  return (fx * sx + fz * sz) / l >= COS_ARC;
}
