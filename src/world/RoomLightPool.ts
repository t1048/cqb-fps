import * as THREE from 'three';

export interface LightSpot {
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
  distance: number;
  decay: number;
  /** 屋外の照明（建物の電源が落ちても消えない。投光器・街灯の想定） */
  outdoor?: boolean;
}

/**
 * 同時に有効な PointLight の数。three.js の前方レンダリングでは全ライトが全フラグメントで評価されるため、
 * 室数ぶん（大型マップで 30 超）置くと GPU 負荷が室数に比例して増える。数は固定（シェーダ再コンパイル回避）。
 */
export const ROOM_LIGHT_SLOTS = 8;
const RESELECT_SEC = 0.5;
const SHADOW_MAP = 512;
/** キューブ影 6 面描画の更新周期（秒, ~18Hz）。静的シーンで毎フレーム 6 面描き直さない。 */
const SHADOW_REFRESH_SEC = 1 / 18;
const FADE_PER_SEC = 3;
/** 切替境界での明滅を防ぐヒステリシス閾値（m）。 */
const HYSTERESIS_METERS = 1.5;
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
  /** 最寄りの照明（影付きスロットへ回す） */
  private nearest: LightSpot | null = null;
  private lastShadowSpot: LightSpot | null = null;
  private shadowTimer = 0;
  /** 屋内照明の明るさの倍率（停電で 0）。フェードで切り替える */
  private indoorTarget = 1;
  private indoorScale = 1;

  constructor(
    private readonly spots: readonly LightSpot[],
    parent: THREE.Object3D,
  ) {
    const n = Math.min(ROOM_LIGHT_SLOTS, Math.max(1, spots.length));
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, 1);
      light.name = 'room-light';
      if (i === 0) {
        // 先頭スロットだけ影を落とす（キューブ影 6 面描画なので 1 灯に限定し、手動スロットル更新）
        light.castShadow = true;
        light.shadow.autoUpdate = false;
        light.shadow.needsUpdate = false;
        light.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
        light.shadow.bias = -0.004;
        light.shadow.normalBias = 0.03;
        light.shadow.radius = 3;
        light.shadow.camera.near = 0.15;
      }
      parent.add(light);
      this.slots.push({ light, spot: null, w: 0 });
    }
  }

  /** 建物の電源。off で屋内照明だけを素早く落とす（屋外の照明は残す） */
  setIndoorPower(on: boolean, instant = false): void {
    this.indoorTarget = on ? 1 : 0;
    if (instant) this.indoorScale = this.indoorTarget;
  }

  get indoorPower(): number {
    return this.indoorScale;
  }

  private scaleOf(spot: LightSpot): number {
    return spot.outdoor ? 1 : this.indoorScale;
  }

  update(dt: number, eye: { x: number; y: number; z: number }): void {
    // 停電は一瞬で落ち（瞬き 1 回ぶん）、復旧は少しかけて点く
    const k = this.indoorTarget < this.indoorScale ? 14 : 2.5;
    this.indoorScale += (this.indoorTarget - this.indoorScale) * Math.min(1, dt * k);
    if (Math.abs(this.indoorTarget - this.indoorScale) < 0.002) this.indoorScale = this.indoorTarget;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = RESELECT_SEC;
      this.select(eye);
    }
    const shadow = this.slots[0]!;
    const near = this.nearest;
    // 影スロットが最寄り以外を照らしていたらフェードアウトさせて空ける
    const shadowBusyElse = shadow.spot !== null && shadow.spot !== near;
    for (const s of this.slots) {
      if (s === shadow && shadowBusyElse) {
        s.w = Math.max(0, s.w - dt * FADE_PER_SEC);
        if (s.w === 0) s.spot = null;
      } else if (s.spot && !this.wanted.has(s.spot)) {
        s.w = Math.max(0, s.w - dt * FADE_PER_SEC);
        if (s.w === 0) s.spot = null;
      } else if (s.spot) {
        s.w = Math.min(1, s.w + dt * FADE_PER_SEC);
      }
    }
    // 影スロットが空いたら最寄り照明を移す（通常スロットの明るさを引き継ぐので切替は見えない）
    if (near && shadow.spot === null) {
      const holder = this.slots.find((s) => s.spot === near);
      this.assign(shadow, near, holder ? holder.w : 0);
      if (holder) {
        holder.spot = null;
        holder.w = 0;
      }
    }
    // 空きスロットへ未割当の希望照明を入れる
    for (const spot of this.wanted) {
      if (this.slots.some((s) => s.spot === spot)) continue;
      const free = this.slots.find((s) => s.spot === null && (s !== shadow || spot === near));
      if (!free) break;
      this.assign(free, spot, 0);
    }
    for (const s of this.slots) s.light.intensity = s.spot ? s.spot.intensity * s.w * this.scaleOf(s.spot) : 0;

    if (shadow.light.castShadow) {
      if (shadow.spot !== null && shadow.light.intensity > 0.01) {
        this.shadowTimer -= dt;
        if (shadow.spot !== this.lastShadowSpot || this.shadowTimer <= 0) {
          this.lastShadowSpot = shadow.spot;
          this.shadowTimer = SHADOW_REFRESH_SEC;
          shadow.light.shadow.needsUpdate = true;
        }
      } else {
        this.lastShadowSpot = null;
        this.shadowTimer = 0;
        shadow.light.shadow.needsUpdate = false;
      }
    }
  }

  private assign(s: Slot, spot: LightSpot, w: number): void {
    s.spot = spot;
    s.w = w;
    s.light.color.setHex(spot.color);
    s.light.distance = spot.distance;
    s.light.decay = spot.decay;
    s.light.position.set(spot.x, spot.y, spot.z);
    if (s.light.castShadow) s.light.shadow.camera.far = Math.max(1, spot.distance);
  }

  /** 初回など、フェード無しで即座に近傍照明を点ける。 */
  snap(eye: { x: number; y: number; z: number }): void {
    this.select(eye);
    for (const s of this.slots) s.spot = null;
    this.update(0, eye);
    for (const s of this.slots) {
      s.w = 1;
      s.light.intensity = s.spot ? s.spot.intensity * this.scaleOf(s.spot) : 0;
    }
    const s0 = this.slots[0];
    if (s0 && s0.light.castShadow && s0.spot !== null && s0.light.intensity > 0.01) {
      this.lastShadowSpot = s0.spot;
      this.shadowTimer = SHADOW_REFRESH_SEC;
      s0.light.shadow.needsUpdate = true;
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
    const candidateNearest = scored[0]?.spot ?? null;
    if (this.wanted.size > 0) {
      const candidateSet = new Set<LightSpot>();
      for (let i = 0; i < n && i < scored.length; i++) candidateSet.add(scored[i]!.spot);
      const added = scored.slice(0, n).filter((x) => !this.wanted.has(x.spot));
      // 差分が 1 灯以下かつ最寄り照明が同一なら現状維持
      if (added.length <= 1 && candidateNearest === this.nearest) return;

      const scoreOf = new Map(scored.map((x) => [x.spot, x.d]));
      const removedScores = [...this.wanted]
        .filter((s) => !candidateSet.has(s))
        .map((s) => scoreOf.get(s) ?? Infinity);
      const maxDiff =
        added.length > 0 && removedScores.length > 0
          ? Math.max(...removedScores) - Math.min(...added.map((x) => x.d))
          : 0;
      const keepWanted = added.length === 0 || maxDiff < HYSTERESIS_METERS;
      const nearestDiff =
        this.nearest !== null && scored[0]
          ? (scoreOf.get(this.nearest) ?? Infinity) - scored[0].d
          : Infinity;
      const keepNearest = candidateNearest === this.nearest || nearestDiff < HYSTERESIS_METERS;

      if (!keepNearest) this.nearest = candidateNearest;
      if (!keepWanted) {
        this.wanted.clear();
        for (const s of candidateSet) this.wanted.add(s);
      }
      return;
    }

    this.wanted.clear();
    this.nearest = candidateNearest;
    for (let i = 0; i < n && i < scored.length; i++) this.wanted.add(scored[i]!.spot);
  }
}
