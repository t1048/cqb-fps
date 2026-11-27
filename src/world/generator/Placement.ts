import type { BoxDef, EntityDef, FurnitureDef } from '../../core/types';
import type { Rng } from './Rng';
import { EPS, LAYER_Y_TOLERANCE, MAX_FURNITURE_TRIES, inset, rectsOverlap, round3, type Rect } from './Layout';

/** 1 階層分の衝突情報。 */
interface PlacementLayer {
  readonly coverRects: Rect[];
  readonly keepOut: Rect[];
}

/**
 * 家具・人物配置の衝突管理（配置済み家具 + ドア可動域などの立入禁止域）。
 * 階層（床高さ floorY）ごとに独立して管理し、別階層の家具・keepOut が XZ で重なっても干渉しない。
 * floorY を省略した呼び出しはコンストラクタの defaultFloorY（既定 0）の階層を使う（既存の平屋生成と同一の挙動）。
 */
export class PlacementGrid {
  /** 全階層の配置済み家具（出力用）。floorY が 0 以外なら BoxDef.y = floorY */
  readonly covers: BoxDef[] = [];
  private readonly layers = new Map<string, PlacementLayer>();

  constructor(private readonly defaultFloorY = 0) {}

  private layer(floorY: number): PlacementLayer {
    const key = round3(floorY).toFixed(3);
    let l = this.layers.get(key);
    if (!l) {
      l = { coverRects: [], keepOut: [] };
      this.layers.set(key, l);
    }
    return l;
  }

  addKeepOut(r: Rect, floorY: number = this.defaultFloorY): void {
    this.layer(floorY).keepOut.push(r);
  }

  /** 指定した矩形・回転 BoxDef をそのまま配置する（航空機の座席列など）。 */
  placeBox(rect: Rect, box: BoxDef, floorY: number = this.defaultFloorY, gap = 0): boolean {
    const layer = this.layer(floorY);
    if (this.blocked(layer, rect, gap)) return false;
    layer.coverRects.push(rect);
    const out: BoxDef = { ...box };
    if (floorY !== 0) out.y = round3(floorY);
    this.covers.push(out);
    return true;
  }

  private blocked(layer: PlacementLayer, r: Rect, gap: number): boolean {
    for (const k of layer.keepOut) if (rectsOverlap(r, k)) return true;
    for (const c of layer.coverRects) {
      if (rectsOverlap(r, { x0: c.x0 - gap, z0: c.z0 - gap, x1: c.x1 + gap, z1: c.z1 + gap })) return true;
    }
    return false;
  }

  /**
   * 1 個の家具を部屋内に配置する（最大 tries 回試行）。成功で true。
   * @param interior 壁厚を除いた部屋の内寸
   * @param floorY 配置する階層の床高さ(m)
   */
  placeFurniture(
    rng: Rng,
    f: Omit<FurnitureDef, 'count'>,
    interior: Rect,
    gap: number,
    wallClearance: number,
    tries = MAX_FURNITURE_TRIES,
    floorY: number = this.defaultFloorY,
  ): boolean {
    const layer = this.layer(floorY);
    for (let i = 0; i < tries; i++) {
      const r = this.candidate(rng, f, interior, wallClearance);
      if (!r) continue;
      if (r.x0 < interior.x0 - EPS || r.x1 > interior.x1 + EPS || r.z0 < interior.z0 - EPS || r.z1 > interior.z1 + EPS) continue;
      if (this.blocked(layer, r, gap)) continue;
      layer.coverRects.push(r);
      const box: BoxDef = {
        x: round3((r.x0 + r.x1) / 2),
        z: round3((r.z0 + r.z1) / 2),
        width: round3(r.x1 - r.x0),
        depth: round3(r.z1 - r.z0),
        height: f.height,
      };
      if (floorY !== 0) box.y = round3(floorY);
      if (f.id) box.prop = f.id;
      this.covers.push(box);
      return true;
    }
    return false;
  }

  private candidate(rng: Rng, f: Omit<FurnitureDef, 'count'>, it: Rect, wallClearance: number): Rect | null {
    const w = f.width;
    const d = f.depth;
    if (f.place === 'center') {
      const swap = rng.chance(0.5);
      const fw = swap ? d : w;
      const fd = swap ? w : d;
      const area = inset(it, wallClearance);
      if (area.x1 - area.x0 < fw || area.z1 - area.z0 < fd) return null;
      const cx = rng.range(area.x0 + fw / 2, area.x1 - fw / 2);
      const cz = rng.range(area.z0 + fd / 2, area.z1 - fd / 2);
      return { x0: cx - fw / 2, z0: cz - fd / 2, x1: cx + fw / 2, z1: cz + fd / 2 };
    }
    // wall / corner: 背面を壁に付け、width を壁沿いに向ける
    const side = rng.int(0, 3);
    const alongX = side < 2; // 0: z0 側の壁, 1: z1 側の壁, 2: x0 側, 3: x1 側
    const len = alongX ? it.x1 - it.x0 : it.z1 - it.z0;
    if (len < w) return null;
    const lo = (alongX ? it.x0 : it.z0) + w / 2;
    const hi = (alongX ? it.x1 : it.z1) - w / 2;
    const along = f.place === 'corner' ? (rng.chance(0.5) ? lo : hi) : rng.range(lo, hi);
    switch (side) {
      case 0:
        return { x0: along - w / 2, x1: along + w / 2, z0: it.z0, z1: it.z0 + d };
      case 1:
        return { x0: along - w / 2, x1: along + w / 2, z0: it.z1 - d, z1: it.z1 };
      case 2:
        return { x0: it.x0, x1: it.x0 + d, z0: along - w / 2, z1: along + w / 2 };
      default:
        return { x0: it.x1 - d, x1: it.x1, z0: along - w / 2, z1: along + w / 2 };
    }
  }

  /**
   * 半径 r の人物が立てる位置か（同じ階層の家具・立入禁止域・既存人物と非干渉）。
   * 既存人物は足元高さ (y ?? 0) が floorY から LAYER_Y_TOLERANCE 未満のものだけを比べる。
   */
  canStand(
    x: number,
    z: number,
    r: number,
    entities: readonly EntityDef[],
    minEntityDist: number,
    floorY: number = this.defaultFloorY,
  ): boolean {
    const box: Rect = { x0: x - r, z0: z - r, x1: x + r, z1: z + r };
    if (this.blocked(this.layer(floorY), box, 0)) return false;
    for (const e of entities) {
      if (Math.abs((e.y ?? 0) - floorY) >= LAYER_Y_TOLERANCE) continue;
      if (Math.hypot(e.x - x, e.z - z) < minEntityDist) return false;
    }
    return true;
  }
}
