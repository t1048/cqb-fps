import type { Vec3, WindowDef } from '../core/types';
import type { StairMark } from '../world/Walk';

/**
 * 容疑者モードの SWAT が「撃たれた場所」から学ぶ記憶（ホットスポット）。
 * ドアの隙間・半開きのドア・階段室・室内の窓口など、チームが目視していない位置から隊員が撃たれたとき、
 * 射手の推定位置と、その射線が通った開口（portal）を全隊で共有し、次に近づくときは裸でのぞかない。
 * 純粋関数とデータ構造のみ（描画・時間は持たない）。実行は swat/swatHotSpots.ts。
 */

export type HotPortalKind = 'door' | 'window' | 'stair';

export interface HotPortal {
  kind: HotPortalKind;
  /** door / stair の id（window は null） */
  id: string | null;
  /** 開口の中心（階段は射手側の端点） */
  pos: Vec3;
  /** 開口が半開きのドアか（ピーク角） */
  partial: boolean;
}

export interface HotSpot {
  id: number;
  /** 射手の推定位置（誤差あり） */
  pos: Vec3;
  portal: HotPortal | null;
  /** この地点から撃たれた回数 / そのうち倒された人数 */
  hits: number;
  downs: number;
  /** 最後に報告された時刻（チーム時計） */
  at: number;
  /** 対策を実施した回数・次に対策してよい時刻 */
  treated: number;
  readyAt: number;
  /** 疑わしいだけの開口（撃たれてはいない。半開きドアなど） */
  suspicion: boolean;
}

export const HOT_SPOT_MERGE_DIST = 2.4;
export const HOT_SPOT_TTL_SEC = 150;
export const HOT_SPOT_MAX = 8;

export class HotSpotMemory {
  readonly spots: HotSpot[] = [];
  private nextId = 1;

  /** 報告を記録する。近い報告・同じ開口は同一の地点に統合し、被弾数を加算する */
  record(pos: Vec3, portal: HotPortal | null, now: number, downed: boolean, suspicion = false): HotSpot {
    let spot =
      this.spots.find(
        (s) =>
          (portal?.id && s.portal?.id === portal.id && s.portal.kind === portal.kind && Math.abs(s.pos.y - pos.y) < 1.5) ||
          (Math.hypot(s.pos.x - pos.x, s.pos.z - pos.z) < HOT_SPOT_MERGE_DIST && Math.abs(s.pos.y - pos.y) < 1.5),
      ) ?? null;
    if (!spot) {
      spot = {
        id: this.nextId++,
        pos: { ...pos },
        portal,
        hits: 0,
        downs: 0,
        at: now,
        treated: 0,
        readyAt: 0,
        suspicion,
      };
      this.spots.push(spot);
      if (this.spots.length > HOT_SPOT_MAX) {
        this.spots.sort((a, b) => b.at - a.at);
        this.spots.length = HOT_SPOT_MAX;
      }
    }
    if (!suspicion) {
      spot.suspicion = false;
      spot.hits++;
      if (downed) spot.downs++;
      // 位置は新しい報告ほど信用して寄せる
      spot.pos = { x: (spot.pos.x + pos.x) / 2, y: pos.y, z: (spot.pos.z + pos.z) / 2 };
      if (portal) spot.portal = portal;
    }
    spot.at = now;
    return spot;
  }

  /** 期限切れを捨てる */
  prune(now: number): void {
    for (let i = this.spots.length - 1; i >= 0; i--) {
      if (now - this.spots[i]!.at > HOT_SPOT_TTL_SEC) this.spots.splice(i, 1);
    }
  }

  active(now: number): HotSpot[] {
    return this.spots.filter((s) => now - s.at <= HOT_SPOT_TTL_SEC);
  }

  /** 点が地点の開口（無ければ射手位置）に近いか */
  near(p: Vec3, maxDist: number, now: number): HotSpot | null {
    let best: HotSpot | null = null;
    let bestD = maxDist;
    for (const s of this.active(now)) {
      const ref = s.portal?.pos ?? s.pos;
      if (Math.abs(ref.y - p.y) > 1.6) continue;
      const d = Math.hypot(ref.x - p.x, ref.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
}

// ---------- 開口の特定 ----------

export interface DoorLike {
  id: string;
  centerX: number;
  centerZ: number;
  sillY: number;
  angle: number;
  maxAngle: number;
  locked: boolean;
  width?: number;
}

/** 点 p から線分 a-b までの水平距離と、線分上の位置(0..1) */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const vx = bx - ax;
  const vz = bz - az;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)) : 0;
  return { d: Math.hypot(px - (ax + vx * t), pz - (az + vz * t)), t };
}

const PORTAL_LINE_TOL = 0.95;

/**
 * 射手 → 被弾した隊員の射線が通った開口を特定する。
 * 開いている（隙間のある）ドア、窓（室内の窓口を含む）、別階から撃たれたなら階段。射手に最も近い開口を採る。
 */
export function findShotPortal(
  shooter: Vec3,
  victim: Vec3,
  doors: readonly DoorLike[],
  windows: readonly WindowDef[],
  stairs: readonly StairMark[],
): HotPortal | null {
  /** 射線上に見つかった開口。t = 射手からの位置(0..1) */
  const found: { portal: HotPortal; t: number }[] = [];
  // 階が違う → 階段（射線は階段室を通っている）
  if (Math.abs(shooter.y - victim.y) > 1.2) {
    let bestStair: { s: StairMark; d: number } | null = null;
    for (const s of stairs) {
      const lowFloor = Math.abs(s.baseY - Math.min(shooter.y, victim.y)) < 1.2;
      const highFloor = Math.abs(s.topY - Math.max(shooter.y, victim.y)) < 1.2;
      if (!lowFloor || !highFloor) continue;
      const a = segDist(shooter.x, shooter.z, s.approachLow.x, s.approachLow.z, s.approachHigh.x, s.approachHigh.z).d;
      const b = segDist(victim.x, victim.z, s.approachLow.x, s.approachLow.z, s.approachHigh.x, s.approachHigh.z).d;
      const d = Math.min(a, b);
      if (d < 3.2 && (!bestStair || d < bestStair.d)) bestStair = { s, d };
    }
    if (bestStair) {
      const shooterHigh = shooter.y > victim.y;
      const end = shooterHigh ? bestStair.s.approachHigh : bestStair.s.approachLow;
      return {
        kind: 'stair',
        id: bestStair.s.id,
        pos: { x: end.x, y: shooterHigh ? bestStair.s.topY : bestStair.s.baseY, z: end.z },
        partial: false,
      };
    }
  }
  for (const door of doors) {
    if (door.locked || door.angle < 3) continue;
    if (Math.abs(door.sillY - shooter.y) > 1.0 && Math.abs(door.sillY - victim.y) > 1.0) continue;
    const { d, t } = segDist(door.centerX, door.centerZ, shooter.x, shooter.z, victim.x, victim.z);
    if (d > PORTAL_LINE_TOL || t <= 0.02 || t >= 0.98) continue;
    found.push({
      portal: {
        kind: 'door',
        id: door.id,
        pos: { x: door.centerX, y: door.sillY, z: door.centerZ },
        partial: door.angle < door.maxAngle * 0.6,
      },
      t,
    });
  }
  for (const w of windows) {
    if (Math.abs((w.y ?? 0) - shooter.y) > 1.2 && Math.abs((w.y ?? 0) - victim.y) > 1.2) continue;
    const { d, t } = segDist(w.x, w.z, shooter.x, shooter.z, victim.x, victim.z);
    if (d > Math.max(PORTAL_LINE_TOL, w.width / 2) || t <= 0.02 || t >= 0.98) continue;
    found.push({ portal: { kind: 'window', id: null, pos: { x: w.x, y: w.y ?? 0, z: w.z }, partial: false }, t });
  }
  found.sort((a, b) => a.t - b.t);
  return found[0]?.portal ?? null;
}

// ---------- 対策の選択 ----------

export type HotTactic = 'flash' | 'gas' | 'suppress' | 'shield' | 'slice' | 'pincer';

export interface HotTacticContext {
  kind: HotPortalKind | 'none';
  pressure: number;
  flashAvailable: boolean;
  gasAvailable: boolean;
  hasShield: boolean;
  hasAltRoute: boolean;
  hits: number;
  downs: number;
  /** この地点への対策実施済み回数 */
  treated: number;
  /** 疑わしいだけ（撃たれてはいない） */
  suspicion: boolean;
}

/**
 * 地点に近づくときの対策を、優先度の高い順に返す（先頭が第一候補、使えないものは含めない）。
 * 圧力・資源（閃光/ガス/盾持ちの有無）・被害・同じ手の繰り返しで決まる。
 * - 階段: まず閃光を階段室へ。無ければ盾持ち先頭で上る
 * - 疑わしいだけの開口: 軽い対策（パイ切り先行照準 / 閃光は圧力が高いときだけ）
 * - 繰り返し被害: ガス・挟撃など重い手を優先
 */
export function chooseHotTactics(c: HotTacticContext): HotTactic[] {
  const score: [HotTactic, number][] = [];
  const heavy = (c.hits >= 2 ? 1 : 0) + (c.downs >= 1 ? 1.5 : 0) + c.treated * 0.8;
  if (c.flashAvailable) {
    let s = 4.5 + c.pressure * 2 + (c.kind === 'stair' ? 2.5 : 0) + (c.suspicion ? -3 + c.pressure * 3 : 0);
    if (c.treated > 0) s -= 1;
    score.push(['flash', s]);
  }
  if (c.gasAvailable && c.kind !== 'stair' && !c.suspicion) {
    score.push(['gas', 2 + heavy * 1.6 + c.pressure - (c.pressure < 0.25 && c.downs === 0 ? 2 : 0)]);
  }
  if (!c.suspicion) score.push(['suppress', 2.8 + c.pressure * 3]);
  if (c.hasShield) score.push(['shield', 4 - c.pressure + (c.kind === 'stair' ? 1.5 : 0) + (c.suspicion ? 0.5 : 0)]);
  if (c.hasAltRoute && !c.suspicion && c.kind !== 'stair') score.push(['pincer', 2.2 + heavy * 1.3]);
  score.push(['slice', 2.6 + (c.suspicion ? 1.5 : 0)]);
  // 同点は定義順（安定ソート）
  return score.sort((a, b) => b[1] - a[1]).map(([t]) => t);
}
