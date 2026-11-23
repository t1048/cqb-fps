import * as THREE from 'three';

export interface LightSpot {
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
  distance: number;
  decay: number;
}

/**
 * 同時に有効な PointLight の数。three.js の前方レンダリングでは全ライトが全フラグメントで評価されるため、
 * 室数ぶん（大型マップで 30 超）置くと GPU 負荷が室数に比例して増える。数は固定（シェーダ再コンパイル回避）。
 */
export const ROOM_LIGHT_SLOTS = 8;
const RESELECT_SEC = 0.2;
const FADE_PER_SEC = 5;
/** 階が違う照明は壁・床越しにしか届かないので距離を割増して優先度を下げる。 */
const VERTICAL_WEIGHT = 3;

interface Slot {
  light: THREE.PointLight;
  spot: LightSpot | null;
  w: number;
}

/** カメラ近傍の部屋照明だけに PointLight を割り当てるプール。切替はフェードで目立たなくする。 */
export class RoomLightPool {
  private readonly slots: Slot[] = [];
  private timer = 0;
  private readonly wanted = new Set<LightSpot>();

  constructor(
    private readonly spots: readonly LightSpot[],
    parent: THREE.Object3D,
  ) {
    const n = Math.min(ROOM_LIGHT_SLOTS, Math.max(1, spots.length));
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, 1);
      light.name = 'room-light';
      parent.add(light);
      this.slots.push({ light, spot: null, w: 0 });
    }
  }

  update(dt: number, eye: { x: number; y: number; z: number }): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = RESELECT_SEC;
      this.select(eye);
    }
    for (const s of this.slots) {
      if (s.spot && !this.wanted.has(s.spot)) {
        s.w = Math.max(0, s.w - dt * FADE_PER_SEC);
        if (s.w === 0) s.spot = null;
      } else if (s.spot) {
        s.w = Math.min(1, s.w + dt * FADE_PER_SEC);
      }
    }
    // 空きスロットへ未割当の希望照明を入れる
    for (const spot of this.wanted) {
      if (this.slots.some((s) => s.spot === spot)) continue;
      const free = this.slots.find((s) => s.spot === null);
      if (!free) break;
      free.spot = spot;
      free.w = 0;
      free.light.color.setHex(spot.color);
      free.light.distance = spot.distance;
      free.light.decay = spot.decay;
      free.light.position.set(spot.x, spot.y, spot.z);
    }
    for (const s of this.slots) s.light.intensity = s.spot ? s.spot.intensity * s.w : 0;
  }

  /** 初回など、フェード無しで即座に近傍照明を点ける。 */
  snap(eye: { x: number; y: number; z: number }): void {
    this.select(eye);
    for (const s of this.slots) s.spot = null;
    this.update(0, eye);
    for (const s of this.slots) {
      s.w = 1;
      s.light.intensity = s.spot ? s.spot.intensity : 0;
    }
    this.timer = RESELECT_SEC;
  }

  private select(eye: { x: number; y: number; z: number }): void {
    const n = this.slots.length;
    const scored = this.spots.map((spot) => {
      const dx = spot.x - eye.x;
      const dz = spot.z - eye.z;
      const dy = (spot.y - eye.y) * VERTICAL_WEIGHT;
      // 照明の届く範囲に対して近いものほど優先
      return { spot, d: Math.hypot(dx, dy, dz) - spot.distance * 0.25 };
    });
    scored.sort((a, b) => a.d - b.d);
    this.wanted.clear();
    for (let i = 0; i < n && i < scored.length; i++) this.wanted.add(scored[i]!.spot);
  }
}
