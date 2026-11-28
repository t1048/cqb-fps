import * as THREE from 'three';
import { t } from '../core/i18n';
import type { DoorDef, RoomDef, Vec3, WindowDef } from '../core/types';
import type { Interaction } from '../player/Interaction';
import type { PowerActor, PowerGrid } from '../rules/Power';
import type { Collider } from './WorldBuilder';

/** 配電盤の取り付け位置（壁の室内側の面）。normal は室内向き */
export interface PanelPlacement {
  x: number;
  y: number;
  z: number;
  /** 室内向きの法線（XZ） */
  nx: number;
  nz: number;
  room: RoomDef;
}

export interface PanelLayout {
  rooms: readonly RoomDef[];
  doors: readonly DoorDef[];
  windows: readonly WindowDef[];
  colliders: readonly Collider[];
}

/** 取り付け高さ（床から、箱の中心） */
const MOUNT_Y = 1.45;
/** 名前から「設備がありそうな部屋」を優先する */
const UTILITY_HINTS = ['倉庫', '物置', '納戸', '機械', '設備', '電気', 'ユーティリティ', '洗面', '脱衣', 'ランドリー', '台所', 'キッチン', '玄関', '廊下', 'ガレージ', 'バックヤード', '事務', 'utility', 'storage', 'kitchen', 'hall', 'garage'];

const inside = (c: Collider, x: number, y: number, z: number): boolean =>
  x >= c.aabb.min.x && x <= c.aabb.max.x && y >= c.aabb.min.y && y <= c.aabb.max.y && z >= c.aabb.min.z && z <= c.aabb.max.z;

const solidAt = (cols: readonly Collider[], x: number, y: number, z: number): boolean =>
  cols.some((c) => (c.kind === 'wall' || c.kind === 'cover') && inside(c, x, y, z));

const wallAt = (cols: readonly Collider[], x: number, y: number, z: number): boolean =>
  cols.some((c) => c.kind === 'wall' && inside(c, x, y, z));

/** 32bit の簡易ハッシュ（同じマップなら同じ場所に置くため） */
const hashOf = (str: string): number => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * 配電盤を置く壁を探す。屋内の 1 階（最も低い階）で、名前が設備らしい部屋を優先し、
 * 部屋の 4 辺の壁のうちドア・窓から離れた位置を、コライダで実際に壁があることを確かめて選ぶ。
 * 置けなければ null。
 */
export function findPanelPlacement(layout: PanelLayout, seed = 0): PanelPlacement | null {
  const indoor = layout.rooms.filter((r) => !r.outdoor && r.width >= 1.6 && r.depth >= 1.6);
  if (indoor.length === 0) return null;
  const lowest = Math.min(...indoor.map((r) => r.floorY ?? 0));
  const ground = indoor.filter((r) => Math.abs((r.floorY ?? 0) - lowest) < 0.5);
  const score = (r: RoomDef): number => {
    const name = r.name.toLowerCase();
    const hint = UTILITY_HINTS.findIndex((h) => name.includes(h.toLowerCase()));
    // 設備らしい名前ほど優先。同点はマップごとに決まった順でばらす
    return (hint >= 0 ? 100 - hint : 0) + ((hashOf(`${r.id}:${seed}`) % 1000) / 1000) * 10;
  };
  const rooms = [...ground].sort((a, b) => score(b) - score(a));
  for (const room of rooms) {
    const p = placeInRoom(layout, room);
    if (p) return p;
  }
  return null;
}

function placeInRoom(layout: PanelLayout, room: RoomDef): PanelPlacement | null {
  const floorY = room.floorY ?? 0;
  const y = floorY + MOUNT_Y;
  const hx = room.width / 2;
  const hz = room.depth / 2;
  // 西・東・北・南の壁（法線は室内向き）
  const sides = [
    { ax: -1, az: 0, half: hz },
    { ax: 1, az: 0, half: hz },
    { ax: 0, az: -1, half: hx },
    { ax: 0, az: 1, half: hx },
  ];
  const offsets = [0, 0.3, -0.3, 0.6, -0.6];
  for (const side of sides) {
    for (const o of offsets) {
      const along = o * Math.max(0, side.half - 0.6);
      // 壁の公称位置（部屋矩形の辺）と、その辺に沿った座標
      const wx = side.ax !== 0 ? room.x + side.ax * hx : room.x + along;
      const wz = side.az !== 0 ? room.z + side.az * hz : room.z + along;
      if (layout.doors.some((d) => Math.hypot(d.x - wx, d.z - wz) < (d.width ?? 1.2) / 2 + 0.8)) continue;
      if (layout.windows.some((w) => Math.hypot(w.x - wx, w.z - wz) < w.width / 2 + 0.5)) continue;
      // 室内側から壁へ向かって進み、最初に壁へ入る位置を面とする
      const nx = -side.ax;
      const nz = -side.az;
      const startX = wx + nx * 0.8;
      const startZ = wz + nz * 0.8;
      if (solidAt(layout.colliders, startX, y, startZ)) continue;
      let face: { x: number; z: number } | null = null;
      for (let d = 0; d <= 1.2; d += 0.02) {
        const px = startX - nx * d;
        const pz = startZ - nz * d;
        if (solidAt(layout.colliders, px, y, pz)) {
          if (wallAt(layout.colliders, px, y, pz)) face = { x: px + nx * 0.02, z: pz + nz * 0.02 };
          break;
        }
      }
      if (!face) continue;
      // 箱の両端も壁に付いているか（角や開口にかからない）
      const tx = -nz;
      const tz = nx;
      const ok = [-0.3, 0.3].every((k) => wallAt(layout.colliders, face!.x + tx * k - nx * 0.05, y, face!.z + tz * k - nz * 0.05));
      if (!ok) continue;
      return { x: face.x, y, z: face.z, nx, nz, room };
    }
  }
  return null;
}

/**
 * 配電盤の見た目（金属の箱・扉・メインブレーカーのレバー・状態ランプ）。
 * ランプは通電で緑、遮断で赤（暗闇でも見つけやすい発光色）。
 */
export class BreakerPanelMesh {
  readonly root = new THREE.Group();
  private readonly lever: THREE.Mesh;
  private readonly lampMat: THREE.MeshBasicMaterial;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];

  constructor(readonly at: PanelPlacement) {
    const metal = new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.55, metalness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.7, metalness: 0.2 });
    const warn = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.6 });
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x3cff6e });
    this.mats.push(metal, dark, warn, this.lampMat);
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
      const g = new THREE.BoxGeometry(w, h, d);
      this.geos.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, y, z);
      this.root.add(m);
      return m;
    };
    // ローカル座標: +Z が室内向き
    box(0.46, 0.62, 0.1, metal, 0, 0, 0.05);
    box(0.4, 0.04, 0.012, warn, 0, 0.25, 0.106); // 黄色の警告ラベル
    box(0.3, 0.3, 0.014, dark, 0, -0.04, 0.106); // ブレーカー列の窓
    for (let i = 0; i < 5; i++) box(0.035, 0.07, 0.02, metal, -0.11 + i * 0.055, 0.02, 0.118);
    this.lever = box(0.05, 0.09, 0.03, dark, 0.0, -0.12, 0.125);
    box(0.03, 0.03, 0.012, this.lampMat, 0.17, 0.25, 0.115);
    this.root.position.set(at.x, at.y, at.z);
    this.root.rotation.y = Math.atan2(at.nx, at.nz);
    this.root.name = 'breaker-panel';
  }

  setOn(on: boolean): void {
    this.lampMat.color.setHex(on ? 0x3cff6e : 0xff3b3b);
    this.lever.position.y = on ? -0.1 : -0.15;
  }

  /** パネル正面の少し手前（インタラクトの基準点） */
  frontPoint(dist = 0.1): { x: number; y: number; z: number } {
    return { x: this.at.x + this.at.nx * dist, y: this.at.y, z: this.at.z + this.at.nz * dist };
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}

/** 配電盤のブレーカーを落とす / 上げるのにかかる時間（秒） */
export const BREAKER_HOLD_SEC = 1.1;
/** 操作できる距離（目から） */
const REACH = 1.9;

export interface BreakerControlOptions {
  mesh: BreakerPanelMesh;
  interaction: Interaction;
  /** 目の位置と視線（単位ベクトル） */
  eye(): Vec3;
  viewDir(): Vec3;
  power: PowerGrid;
  actor: PowerActor;
  /** 長押しのゲージ（容疑者モードのゲージ表示。無ければラベルに % を出す） */
  showGauge?(label: string, ratio: number): void;
  /** 切り替えた直後（効果音・字幕など） */
  onFlip?(on: boolean): void;
}

/** 配電盤のインタラクト（F 長押しでメインブレーカーを切り替える）。 */
export class BreakerControl {
  private readonly unreg: () => void;
  private held = 0;
  private flipped = false;

  constructor(private readonly o: BreakerControlOptions) {
    o.mesh.setOn(o.power.breaker);
    this.unreg = o.interaction.register<BreakerPanelMesh>({
      id: 'breaker',
      // ドア（200）より優先、人質・拘束（300 以上）より下
      priority: 250,
      resolve: () => (this.inReach() ? o.mesh : null),
      label: () => {
        const p = o.power;
        const verb = p.breaker ? t('ブレーカーを落とす', 'cut the main breaker') : t('ブレーカーを上げる', 'restore the main breaker');
        const note = !p.utility
          ? t('（外部から電気が止められている）', ' (power is cut from outside)')
          : '';
        if (this.held > 0) return t(`${verb}… ${Math.round((this.held / BREAKER_HOLD_SEC) * 100)}%`, `${verb}... ${Math.round((this.held / BREAKER_HOLD_SEC) * 100)}%`);
        return t(`F 長押し: 配電盤の${verb}${note}`, `Hold F: ${verb}${note}`);
      },
      onHold: (_m, _dt, sec) => {
        // 1 回の長押しで切り替えるのは 1 回だけ（離すまで次は受け付けない）
        if (this.flipped) return;
        this.held = sec;
        o.showGauge?.(o.power.breaker ? t('ブレーカーを落としている...', 'Cutting the breaker...') : t('ブレーカーを上げている...', 'Restoring the breaker...'), sec / BREAKER_HOLD_SEC);
        if (sec >= BREAKER_HOLD_SEC) {
          this.flipped = true;
          this.held = 0;
          const on = !o.power.breaker;
          o.power.setBreaker(on, o.actor);
          o.mesh.setOn(on);
          o.onFlip?.(on);
        }
      },
      onRelease: () => {
        this.held = 0;
        this.flipped = false;
      },
    });
  }

  private inReach(): boolean {
    const e = this.o.eye();
    const p = this.o.mesh.frontPoint(0.05);
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const dz = p.z - e.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > REACH || d < 0.05) return false;
    // 正面側から、パネルの方を見ているときだけ
    const front = (e.x - p.x) * this.o.mesh.at.nx + (e.z - p.z) * this.o.mesh.at.nz;
    if (front < 0.1) return false;
    const v = this.o.viewDir();
    return (v.x * dx + v.y * dy + v.z * dz) / d > 0.86;
  }

  dispose(): void {
    this.unreg();
  }
}
