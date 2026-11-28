import * as THREE from 'three';
import { getSettings } from '../core/Settings';
import type { InputManager } from '../core/InputManager';
import type { GameEventBus } from '../core/events';
import type { ArmorKind, ArmorWeight, MapData, MoveMode, PlayerConfig, VestSpec, VestTier } from '../core/types';
import type { AABB, Collider } from '../world/WorldBuilder';
import { collidersNear } from '../world/ColliderIndex';
import { legacyZeroFallbackOf, nextFootY, probeGround, STEP_HEIGHT } from '../world/Walk';
import { NO_PLAYER_FATIGUE, type PlayerFatigueEffects } from '../rules/siegeFatigue';
import { applyHeadMultiplier, isHeadHit, woundLevelOf, type WoundLevel } from '../rules/wounds';

const DEG2RAD = Math.PI / 180;
const MAX_DT = 0.05;
const NO_ARMOR_WEIGHT: ArmorWeight = { speedMul: 1, footstepRadiusMul: 1, leanSpeedMul: 1 };

/**
 * 一人称移動: PointerLock 視点、WASD、Shift 静音、C しゃがみ（トグル）、AABB 壁スライディング衝突。
 * 座標は足元基準 (pos.y = 床高さ)。カメラは毎フレーム目線位置へ更新する。
 */
export class PlayerController {
  /** 足元位置（ワールド座標） */
  readonly position = new THREE.Vector3();
  private yaw: number;
  private pitch = 0;
  private eyeHeight: number;
  private crouching = false;
  private mode: MoveMode = 'run';
  private stepTimer = 0;
  private moving = false;
  private leanProgress = 0; // リーン進捗 [-1,1]（右が正）
  private leanOffset = 0; // 現在の横オフセット（右が正, m）
  private readonly eyeWorld = new THREE.Vector3();
  private readonly projScratch = new THREE.Vector3();
  private verticalVelocity = 0;
  /** 直前に有効な支持面の上にいた足元位置（無支持時の安全側復帰先） */
  private readonly lastValidPos = new THREE.Vector3();
  /** true = 旧固定マップ（無支持を地面 y=0 とみなす）。false = 無支持領域への進入を拒否する */
  private readonly legacyGround: boolean;
  private disposed = false;
  private hpValue: number;
  private readonly baseFov: number;
  /** 移動速度倍率（ADS 等で WeaponSystem が設定。1=等倍） */
  speedMultiplier = 1;
  /** 外部要因（オプティワンド展開等）による移動速度倍率。0 で移動不可 */
  externalMoveScale = 1;
  /**
   * 視点操作の横取り先。設定中はマウス移動量を yaw/pitch に反映せずここへ渡す
   * （オプティワンドのドア下カメラ首振り用）。
   */
  lookSink: ((dx: number, dy: number) => void) | null = null;
  /** true の間はしゃがみトグルを受け付けない（オプティワンドのカメラ展開中） */
  stanceLocked = false;
  /** 負傷モデル（HP 比率による速度低下・照準の乱れ）を有効にするか。SWAT モードのみ true */
  woundsEnabled = false;
  /** 頭部被弾倍率（wounds.headMultiplier）を適用するか。両モード共通で true（負傷効果とは独立） */
  headshotsEnabled = true;
  private woundLv: WoundLevel = 0;
  private swayPhase = 0;
  /** 籠城の消耗の効果（容疑者モードだけ main が設定。SWAT モードは常に既定＝効果なし） */
  private fatigue: PlayerFatigueEffects = { ...NO_PLAYER_FATIGUE };
  /** 直近の被弾が頭部だったか（HUD/テスト用） */
  lastHitHead = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly input: InputManager,
    private readonly colliders: readonly Collider[],
    private readonly config: PlayerConfig,
    private readonly bus: GameEventBus,
    map: MapData,
  ) {
    const sp = map.playerSpawn;
    this.position.set(sp.x, sp.y, sp.z);
    this.lastValidPos.copy(this.position);
    this.legacyGround = legacyZeroFallbackOf(colliders);
    this.yaw = -sp.yaw * DEG2RAD; // yaw 0 = -Z
    this.eyeHeight = config.standEyeHeight;
    this.hpValue = config.maxHp;
    this.baseFov = camera.fov;
    this.camera.rotation.order = 'YXZ';
    this.applyCamera();
  }

  get hp(): number {
    return this.hpValue;
  }

  get maxHp(): number {
    return this.config.maxHp;
  }

  get alive(): boolean {
    return this.hpValue > 0;
  }

  /** 防弾チョッキの残り耐久値（0 = 未装着/破損）。肩代わりできる残りダメージ量 */
  armor = 0;
  /** 装着したチョッキの新品時耐久値（肩代わり率の劣化計算用） */
  armorMax = 0;

  /** 防弾チョッキを装着する（既存より耐久が高い場合のみ更新）。 */
  equipArmor(points: number, kind: ArmorKind = 'swatIssue'): void {
    if (this.armorKindValue !== null) return; // すでに着ている（脱げない）
    if (!(points > 0)) return;
    this.armor = points;
    this.armorMax = points;
    this.armorKindValue = kind;
    this.vestSpec = null;
  }

  /**
   * 選択された防弾ベスト（light / standard / heavy / none）を装着する。
   * player.json の armor.vests[mode][tier] から耐久・肩代わり率・重量補正をすべて適用する。
   */
  equipVest(mode: 'swat' | 'suspect', tier: VestTier, force = false): void {
    if (!force && this.armorKindValue !== null) return;
    if (tier === 'none') {
      if (force) {
        this.armor = 0;
        this.armorMax = 0;
        this.armorKindValue = null;
        this.vestSpec = null;
      }
      this.vestTierValue = 'none';
      return;
    }
    const spec =
      mode === 'swat'
        ? this.config.armor.vests?.swat?.[tier]
        : this.config.armor.vests?.suspect?.[tier];
    if (!spec || !(spec.durability > 0)) return;
    this.armor = spec.durability;
    this.armorMax = spec.durability;
    this.armorKindValue = mode === 'swat' ? 'swatIssue' : 'suspectVest';
    this.vestTierValue = tier;
    this.vestSpec = spec;
  }

  private armorKindValue: ArmorKind | null = null;
  private vestTierValue: VestTier | null = null;
  private vestSpec: VestSpec | null = null;

  /** 装着中のベストの種類（未装着は null。耐久が尽きても残る） */
  get armorKind(): ArmorKind | null {
    return this.armorKindValue;
  }

  /** 装着中のベスト段階（equipVest 未使用時は null） */
  get vestTier(): VestTier | null {
    return this.vestTierValue;
  }

  /** 装着中のベストの重さ（未装着は等倍） */
  get armorWeight(): ArmorWeight {
    if (this.vestSpec) {
      return {
        speedMul: this.vestSpec.speedMul,
        footstepRadiusMul: this.vestSpec.footstepRadiusMul,
        leanSpeedMul: this.vestSpec.leanSpeedMul,
      };
    }
    return this.armorKindValue === null ? NO_ARMOR_WEIGHT : this.config.armor.weight[this.armorKindValue];
  }

  /** 移動モードの上限（救急処置中は 'quiet'。走りを静音に落とす）。null = 制限なし */
  moveModeCap: 'quiet' | null = null;

  /** HP を回復する（生存中だけ。最大 HP まで。負傷レベルは下げない） */
  heal(amount: number): void {
    if (!this.alive || !(amount > 0)) return;
    this.hpValue = Math.min(this.config.maxHp, this.hpValue + amount);
  }

  /** 籠城の消耗の効果を保存する（値を持つだけ。適用は各処理が読む） */
  setFatigueEffects(e: PlayerFatigueEffects): void {
    this.fatigue = { ...e };
  }

  /** 消耗による射撃拡散の加算（度） */
  get fatigueSpreadAdd(): number {
    return this.fatigue.spreadAddDeg;
  }

  /** 消耗による装填時間の倍率 */
  get reloadTimeMul(): number {
    return this.fatigue.reloadMul;
  }

  /** 現在の肩代わり率。耐久残量に比例して absorb → minAbsorb へ劣化する */
  get armorAbsorb(): number {
    if (this.armor <= 0) return 0;
    const absorb = this.vestSpec ? this.vestSpec.absorb : this.config.armor.absorb;
    const minAbsorb = this.vestSpec ? this.vestSpec.minAbsorb : this.config.armor.minAbsorb;
    const max = Math.max(this.armorMax, this.armor);
    return minAbsorb + (absorb - minAbsorb) * (this.armor / max);
  }

  /** 現在の負傷レベル（woundsEnabled=false の間は常に 0） */
  get woundLevel(): WoundLevel {
    return this.woundsEnabled ? this.woundLv : 0;
  }

  /** 負傷による移動速度倍率 */
  get woundSpeedMul(): number {
    const lv = this.woundLevel;
    return lv === 0 ? 1 : this.config.wounds.speedMul[lv - 1]!;
  }

  /** 負傷による射撃拡散の加算（度） */
  get woundSpreadAdd(): number {
    const lv = this.woundLevel;
    return lv === 0 ? 0 : this.config.wounds.spreadAddDeg[lv - 1]!;
  }

  /**
   * 被弾。hitY（命中点の高さ）が目線付近なら頭部とみなし wounds.headMultiplier を掛ける（両モード共通）。
   * 胴体への被弾は防弾チョッキが耐久の続く限り armorAbsorb の割合を肩代わりする。
   * 戻り値は残 HP。
   */
  takeDamage(amount: number, hitY?: number): number {
    if (this.disposed || this.hpValue <= 0 || amount <= 0) return this.hpValue;
    const wcfg = this.config.wounds;
    this.lastHitHead = false;
    if (this.headshotsEnabled && isHeadHit(hitY, this.position.y + this.eyeHeight, wcfg.headBand)) {
      this.lastHitHead = true;
      amount = applyHeadMultiplier(amount, true, wcfg.headMultiplier);
    }
    if (this.armor > 0) {
      // 頭部は防弾チョッキの対象外
      if (!this.lastHitHead) {
        const absorbed = Math.min(this.armor, amount * this.armorAbsorb);
        this.armor = Math.max(0, this.armor - absorbed);
        amount -= absorbed;
      }
    }
    this.hpValue = Math.max(0, this.hpValue - amount);
    this.syncWoundLevel();
    return this.hpValue;
  }

  private syncWoundLevel(): void {
    if (!this.woundsEnabled) return;
    const next = woundLevelOf(this.hpValue, this.config.maxHp, this.config.wounds);
    if (next > this.woundLv) {
      this.woundLv = next;
      if (next === 1 || next === 2) this.bus.emit('playerWound', { level: next });
    }
  }

  setFovBlend(adsBlend: number): void {
    const t = Math.max(0, Math.min(1, adsBlend));
    const next = this.baseFov + (this.config.adsFovDeg - this.baseFov) * t;
    if (Math.abs(this.camera.fov - next) > 0.01) {
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
    }
  }

  inCameraView(point: { x: number; y: number; z: number }): boolean {
    const p = this.projScratch.set(point.x, point.y, point.z).project(this.camera);
    return Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) <= 1;
  }

  get isCrouching(): boolean {
    return this.crouching;
  }
  getBodyBounds(): AABB {
    const p = this.position;
    const eye = this.getEyePosition(this.eyeWorld);
    const r = this.config.radius;
    return {
      min: { x: Math.min(p.x, eye.x) - r, y: p.y, z: Math.min(p.z, eye.z) - r },
      max: { x: Math.max(p.x, eye.x) + r, y: eye.y + this.config.lean.headRadius, z: Math.max(p.z, eye.z) + r },
    };
  }
  get moveMode(): MoveMode {
    return this.mode;
  }
  get isMoving(): boolean {
    return this.moving;
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    if (!this.alive) {
      this.input.consumeMouseDelta();
      this.moving = false;
      this.applyCamera();
      return;
    }
    const dt = Math.min(rawDt, MAX_DT);
    const cfg = this.config;

    // 視点
    const md = this.input.consumeMouseDelta();
    const settings = getSettings();
    const sens = cfg.mouseSensitivity * settings.mouseSensitivity;
    const ySign = settings.invertY ? -1 : 1;
    if (this.lookSink) {
      this.lookSink(md.x * sens, md.y * sens * ySign);
    } else {
      this.yaw -= md.x * sens;
      const maxPitch = cfg.maxPitchDeg * DEG2RAD;
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch - md.y * sens * ySign));
    }

    // しゃがみ（C でトグル）。ワンド展開中など姿勢固定中は切り替えない
    if (this.input.wasPressed('crouch') && !this.stanceLocked) this.crouching = !this.crouching;

    // 入力方向（ローカル: x=右, z=前）
    const fwd = (this.input.isDown('moveForward') ? 1 : 0) - (this.input.isDown('moveBackward') ? 1 : 0);
    const right = (this.input.isDown('moveRight') ? 1 : 0) - (this.input.isDown('moveLeft') ? 1 : 0);
    this.mode = this.crouching ? 'crouch' : this.input.isDown('walk') ? 'quiet' : 'run';
    // 救急処置中は走れない（しゃがみはそのまま。足音も静音の半径になる）
    if (this.moveModeCap === 'quiet' && this.mode === 'run') this.mode = 'quiet';

    const armorWeight = this.armorWeight;
    const len = Math.hypot(fwd, right);
    // 外部要因で移動不可（ドア下ワンド展開中など）のときは歩行扱いにせず足音も出さない
    this.moving = len > 0 && this.externalMoveScale > 0;
    if (this.moving) {
      const speed = cfg.speeds[this.mode] * this.speedMultiplier * this.externalMoveScale * this.woundSpeedMul * armorWeight.speedMul * this.fatigue.speedMul;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // forward = (-sin, -cos), right = (cos, -sin)
      const vx = ((right * cos - fwd * sin) / len) * speed;
      const vz = ((-right * sin - fwd * cos) / len) * speed;
      this.moveWithCollision(vx * dt, vz * dt);
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = cfg.footstep.interval[this.mode];
        this.bus.emit('noise', {
          pos: { x: this.position.x, y: this.position.y, z: this.position.z },
          radius: cfg.footstep.radius[this.mode] * armorWeight.footstepRadiusMul,
          kind: 'footstep',
          source: 'player',
        });
      }
    } else {
      this.stepTimer = 0; // 停止後の最初の一歩で即座に音が出る
    }
    this.applyFooting(dt);

    // 目線高さ補間（dt 基準・指数減衰）
    const target = this.crouching ? cfg.crouchEyeHeight : cfg.standEyeHeight;
    this.eyeHeight += (target - this.eyeHeight) * (1 - Math.exp(-cfg.eyeHeightLerpSpeed * dt));
    // リーン（Q=左 / E=右、同時押しは相殺）
    const leanDir = (this.input.isDown('leanRight') ? 1 : 0) - (this.input.isDown('leanLeft') ? 1 : 0);
    // 進捗 p ∈ [-1,1] を一定の速さで動かす。出る向きは 1/outSec、戻る向きは 1/returnSec。
    // 反対側へ切り替えるときは必ず中央（p=0）を通る。
    // ベストの重さ: 出・戻りの時間を leanSpeedMul で割る（0.8 → 時間 1.25 倍）。進捗は保つ
    const outRate = armorWeight.leanSpeedMul / cfg.lean.outSec;
    const retRate = armorWeight.leanSpeedMul / cfg.lean.returnSec;
    let remain = dt;
    const p0 = this.leanProgress;
    if (leanDir === 0 || (p0 !== 0 && Math.sign(p0) !== leanDir)) {
      // 中央へ戻る（目標なし、または反対側から）
      const need = Math.abs(p0) / retRate;
      if (remain >= need) {
        this.leanProgress = 0;
        remain -= need;
      } else {
        this.leanProgress = p0 - Math.sign(p0) * retRate * remain;
        remain = 0;
      }
    }
    if (leanDir !== 0 && remain > 0) {
      this.leanProgress = Math.max(-1, Math.min(1, this.leanProgress + leanDir * outRate * remain));
    }
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    const sgn = Math.sign(this.leanProgress);
    this.leanOffset = sgn * cfg.lean.maxOffset * smooth(Math.abs(this.leanProgress));
    // 壁による制限。制限されたら進捗もそのオフセットに対応する値へ戻す（裏で溜めない）
    if (this.leanOffset !== 0) {
      const lim = this.leanClearance(sgn, Math.abs(this.leanOffset));
      if (Math.abs(this.leanOffset) > lim) {
        this.leanOffset = sgn * lim;
        const ratio = cfg.lean.maxOffset > 0 ? lim / cfg.lean.maxOffset : 0;
        // smoothstep の逆を二分法で求める
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          if (smooth(mid) < ratio) lo = mid;
          else hi = mid;
        }
        this.leanProgress = sgn * lo;
      }
    }
    this.applyCamera();
  }

  /** 視点の向き（ラジアン）。射撃方向の算出用。 */
  get yawRad(): number {
    return this.yaw;
  }
  get pitchRad(): number {
    return this.pitch;
  }

  /** リコイル等による視点の相対回転（ラジアン）。ピッチは上限内にクランプ。 */
  addViewKick(pitchRad: number, yawRad: number): void {
    const maxPitch = this.config.maxPitchDeg * DEG2RAD;
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch + pitchRad));
    this.yaw += yawRad;
  }

  /** リーン込みの目線位置（射撃原点用）。毎回カメラと同じ値を返す。 */
  getEyePosition(out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    return out.set(
      this.position.x + rx * this.leanOffset,
      this.position.y + this.eyeHeight,
      this.position.z + rz * this.leanOffset,
    );
  }

  /** 現在のリーン量（-1=左 〜 1=右、正規化） */
  get leanAmount(): number {
    return this.config.lean.maxOffset > 0 ? this.leanOffset / this.config.lean.maxOffset : 0;
  }

  /**
   * 体の中心(目線高さ)から右方向 dir(±1) へ最大 want[m] まで頭を出せる距離を返す。
   * 壁/遮蔽物の AABB へのレイキャスト(XZ スラブ法)で、頭半径分のクリアランスを確保する。
   */
  private leanClearance(dir: number, want: number): number {
    const eyeY = this.position.y + this.eyeHeight;
    const ox = this.position.x;
    const oz = this.position.z;
    const dx = Math.cos(this.yaw) * dir;
    const dz = -Math.sin(this.yaw) * dir;
    const margin = this.config.lean.headRadius;
    let maxT = want + margin;
    const near = collidersNear(
      this.colliders,
      ox - maxT - 0.1,
      oz - maxT - 0.1,
      ox + maxT + 0.1,
      oz + maxT + 0.1,
    );
    for (let i = 0; i < near.length; i++) {
      const a = near[i]!.aabb;
      if (eyeY < a.min.y || eyeY > a.max.y) continue;
      let t0 = 0;
      let t1 = maxT;
      if (Math.abs(dx) < 1e-9) {
        if (ox < a.min.x || ox > a.max.x) continue;
      } else {
        let ta = (a.min.x - ox) / dx;
        let tb = (a.max.x - ox) / dx;
        if (ta > tb) {
          const tmp = ta;
          ta = tb;
          tb = tmp;
        }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-9) {
        if (oz < a.min.z || oz > a.max.z) continue;
      } else {
        let ta = (a.min.z - oz) / dz;
        let tb = (a.max.z - oz) / dz;
        if (ta > tb) {
          const tmp = ta;
          ta = tb;
          tb = tmp;
        }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (t0 < maxT) maxT = t0;
    }
    return Math.max(0, Math.min(want, maxT - margin));
  }

  /**
   * 位置を変更（サブステップ分割で高速時のすり抜け防止）。円(XZ) vs AABB の押し出しでスライドする。
   * 支持面の無い位置（敷地外・地下の空隙）へは進入せず、X 単独 / Z 単独で支持がある軸だけスライドする。
   */
  private moveWithCollision(dx: number, dz: number): void {
    const r = this.config.radius;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (r * 0.5)));
    const sx = dx / steps;
    const sz = dz / steps;
    const p = this.position;
    for (let i = 0; i < steps; i++) {
      const ox = p.x;
      const oy = p.y;
      const oz = p.z;
      p.x += sx;
      p.z += sz;
      const s1 = probeGround(this.colliders, p.x, p.z, p.y, r, this.legacyGround);
      if (s1 !== null && s1 > p.y) p.y = s1;
      this.resolve(r);
      const s2 = probeGround(this.colliders, p.x, p.z, p.y, r, this.legacyGround);
      if (s2 !== null && s2 > p.y) p.y = s2;
      if (this.legacyGround || this.supported()) continue;
      let ok = false;
      for (const [ax, az] of [
        [sx, 0],
        [0, sz],
      ] as const) {
        if (ax === 0 && az === 0) continue;
        p.x = ox + ax;
        p.y = oy;
        p.z = oz + az;
        const sa1 = probeGround(this.colliders, p.x, p.z, p.y, r, this.legacyGround);
        if (sa1 !== null && sa1 > p.y) p.y = sa1;
        this.resolve(r);
        const sa2 = probeGround(this.colliders, p.x, p.z, p.y, r, this.legacyGround);
        if (sa2 !== null && sa2 > p.y) p.y = sa2;
        if (this.supported()) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        p.x = ox;
        p.y = oy;
        p.z = oz;
      }
    }
  }

  /** 現在の足元 (x,z) に実 floor / stair の支持面があるか。 */
  private supported(): boolean {
    const p = this.position;
    return probeGround(this.colliders, p.x, p.z, p.y, this.config.radius, false) !== null;
  }

  private resolve(r: number): void {
    const p = this.position;
    for (let pass = 0; pass < 3; pass++) {
      let pushed = false;
      const near = collidersNear(this.colliders, p.x - r - 0.4, p.z - r - 0.4, p.x + r + 0.4, p.z + r + 0.4);
      for (let i = 0; i < near.length; i++) {
        const a = near[i]!.aabb;
        // 高さが重ならないコライダは無視（足元〜頭頂）
        if (a.max.y <= p.y + STEP_HEIGHT || a.min.y >= p.y + this.config.standEyeHeight) continue;
        const cx = Math.max(a.min.x, Math.min(p.x, a.max.x));
        const cz = Math.max(a.min.z, Math.min(p.z, a.max.z));
        const ox = p.x - cx;
        const oz = p.z - cz;
        const d2 = ox * ox + oz * oz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          p.x = cx + (ox / d) * r;
          p.z = cz + (oz / d) * r;
        } else {
          // 中心が AABB 内部: 最短の面から押し出す
          const l = p.x - a.min.x;
          const rt = a.max.x - p.x;
          const f = p.z - a.min.z;
          const b = a.max.z - p.z;
          const m = Math.min(l, rt, f, b);
          if (m === l) p.x = a.min.x - r;
          else if (m === rt) p.x = a.max.x + r;
          else if (m === f) p.z = a.min.z - r;
          else p.z = a.max.z + r;
        }
        pushed = true;
      }
      if (!pushed) break;
    }
  }

  /** 段差へ乗せ、支持が無ければ重力で落とす。支持面は floor / stair の上面。 */
  private applyFooting(dt: number): void {
    const p = this.position;
    const probed = probeGround(this.colliders, p.x, p.z, p.y, this.config.radius, this.legacyGround);
    if (probed === null) {
      // 押し出し等で無支持へ出た: 落下を続けず直前の有効支持位置へ戻す
      p.copy(this.lastValidPos);
      this.verticalVelocity = 0;
      return;
    }
    const support = probed;
    if (support + 0.02 >= p.y) {
      p.y = nextFootY(p.y, support, STEP_HEIGHT);
      this.verticalVelocity = 0;
      this.lastValidPos.copy(p);
      return;
    }
    this.verticalVelocity = Math.max(-12, this.verticalVelocity - 22 * dt);
    p.y += this.verticalVelocity * dt;
    if (p.y <= support) {
      p.y = support;
      this.verticalVelocity = 0;
      this.lastValidPos.copy(p);
    }
  }

  private applyCamera(): void {
    this.camera.position.copy(this.getEyePosition(this.eyeWorld));
    const roll = -this.leanAmount * this.config.lean.maxRollDeg * DEG2RAD; // 右リーンで右へ傾く
    const lv = this.woundLevel;
    const ampDeg = (lv > 0 ? this.config.wounds.swayDeg[lv - 1]! : 0) + this.fatigue.swayDeg;
    if (ampDeg > 0) {
      // 負傷・消耗中は視点が呼吸・脈動でふらつく（視点そのものは変えず、カメラのみ揺らす）
      const amp = ampDeg * DEG2RAD;
      this.swayPhase += 0.016 * (lv === 2 ? 9 : 5);
      const sx = Math.sin(this.swayPhase) * amp;
      const sy = Math.sin(this.swayPhase * 0.73 + 1.3) * amp * 0.8;
      this.camera.rotation.set(this.pitch + sx, this.yaw + sy, roll);
      return;
    }
    this.camera.rotation.set(this.pitch, this.yaw, roll);
  }

  dispose(): void {
    this.disposed = true;
  }
}
