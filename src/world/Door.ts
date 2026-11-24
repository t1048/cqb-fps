import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import { disposeObject } from '../core/dispose';
import { batchStaticMeshes } from './StaticBatcher';
import type { DoorConfig, DoorDef, MapData } from '../core/types';
import type { InputManager } from '../core/InputManager';
import type { PlayerController } from '../player/PlayerController';
import type { Interaction } from '../player/Interaction';
import type { AABB, Collider } from './WorldBuilder';
import type { TextureLibrary } from './Materials';

const DEG2RAD = Math.PI / 180;
const MAX_DT = 0.05;
const EPS = 0.01; // 度
/** 同じドアへの連続蹴りを 1 回と数える間隔（秒）。AI が毎フレーム呼んでも 1 蹴りにまとめる。 */
const SWAT_KICK_GAP_SEC = 0.48;
/** 失敗した蹴りで扉が跳ねる角度（度）。その後、元の角度へ戻る。 */
const SWAT_KICK_BUMP_DEG = 14;

/**
 * SWAT の蹴破りに必要な回数。ドア id の FNV-1a で 2 か 3 に固定する（再読込でも変わらない）。
 * 容疑者の開閉・施錠には使わない。
 */
export function swatBreachKicks(doorId: string): 2 | 3 {
  let h = 2166136261;
  for (let i = 0; i < doorId.length; i++) {
    h ^= doorId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) & 1 ? 3 : 2;
}
const DEFAULT_WIDTH = 1.2;
const DEFAULT_FRAME_THICKNESS = 0.055;
const DEFAULT_FRAME_DEPTH = 0.3;
const DEFAULT_CASING_WIDTH = 0.075;
const DEFAULT_CASING_DEPTH = 0.018;
const DEFAULT_HANDLE_HEIGHT = 0.98;
const DOUBLE_CENTER_GAP = 0.004;
const TRANSOM_MIN_GAP = 0.04;

const COLORS = {
  leafStile: 0xd8c3aa,
  leafPanel: 0xbfa68a,
  frame: 0xc2b2a0,
  hardware: 0xc8b078,
  kickPlate: 0xb2b8be,
  hinge: 0x8e949a,
  transomGlass: 0xd8eaf2,
} as const;

export type DoorStage = 'closed' | 'peek' | 'open';

export interface DoorRayHit {
  distance: number;
  /** ヒンジからの扉板に沿った距離(m) */
  along: number;
  /** 自由端（レバーハンドル付近）の高速操作ゾーン内か */
  inKnobZone: boolean;
}

interface DoorMaterials {
  stile: THREE.MeshStandardMaterial;
  recess: THREE.MeshStandardMaterial;
  frame: THREE.MeshStandardMaterial;
  hardware: THREE.MeshStandardMaterial;
  kickPlate: THREE.MeshStandardMaterial;
  hinge: THREE.MeshStandardMaterial;
}

/**
 * 段階開閉ドア（単開き・両開き対応）。
 * 建築的なドア枠（ジャム・上枠・ケーシング・自動欄間）と框組（かまちぐみ）扉板＋レバーハンドルを持つ。
 * 衝突/射線/視界は「扉板を細かく分割した AABB 列」を共有 colliders に登録し、角度変化のたびに更新する
 * （＝プレイヤー移動・リーン・射撃・AI 視線がそのまま扉に遮られる。ピーク隙間は素通し。枠にはコライダを付けない）。
 * 開く向きはプレイヤーと反対側（閉状態から開く瞬間に決定）。両開き時は左右2枚の扉が同期して観音開きする。
 */
export class Door {
  readonly id: string;
  readonly root = new THREE.Group();
  readonly width: number;
  readonly height: number;
  readonly maxAngle: number;
  readonly peekAngle: number;
  readonly double: boolean;
  locked: boolean;
  /** 現在角度 / 目標角度（度） */
  angle = 0;
  targetAngle = 0;
  /** +1 / -1: 扉板が法線 n 側 / 反対側へ振れる */
  private swingSign = 1;
  private speedMul = 1;
  /** SWAT がこのドアを蹴った回数。必要回数に達した蹴りだけ解錠して全開にする。 */
  private swatKicks = 0;
  private swatKickCooldown = 0;
  /** 失敗蹴り: out = 少し開く、back = 元の角度へ戻す */
  private kickRecoil: 'out' | 'back' | null = null;
  private kickRecoilReturn = 0;
  private readonly hinge = new THREE.Vector2(); // 左（単開き）ヒンジ XZ
  private readonly rightHinge = new THREE.Vector2(); // 両開き時の右ヒンジ XZ
  private readonly u = new THREE.Vector2(); // 扉に沿った単位ベクトル（閉状態）
  private readonly n = new THREE.Vector2(); // 扉面の法線
  readonly sillY: number;
  private readonly openingHeight: number;
  private readonly yawRad: number;
  private readonly cx: number;
  private readonly cz: number;
  private readonly leafWidth: number;
  private readonly leafSegCount: number;
  private readonly totalSegCount: number;
  private readonly segHalf: number;
  readonly colliders: Collider[] = [];
  private readonly tmp: AABB[] = [];
  private readonly frameGroup = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly rightPivot: THREE.Group | null;
  private disposed = false;

  constructor(
    def: DoorDef,
    private readonly cfg: DoorConfig,
    storyClearance: number,
    private readonly bus: GameEventBus,
    private readonly textures?: TextureLibrary,
  ) {
    this.id = def.id;
    this.locked = def.locked;
    this.width = def.width ?? DEFAULT_WIDTH;
    this.double = def.double === true;
    this.maxAngle = def.maxAngle;
    this.peekAngle = Math.min(cfg.peekAngle, def.maxAngle);
    this.sillY = def.y ?? 0;
    this.openingHeight = Math.max(0.5, storyClearance);
    this.height = Math.min(cfg.height, this.openingHeight);
    this.yawRad = def.yaw * DEG2RAD;
    this.cx = def.x;
    this.cz = def.z;
    // yaw 0 = X 方向（WorldBuilder の Box 回転と同じ規約: local x → (cos, -sin)）
    this.u.set(Math.cos(this.yawRad), -Math.sin(this.yawRad));
    this.n.set(Math.sin(this.yawRad), Math.cos(this.yawRad));
    this.hinge.set(def.x - (this.u.x * this.width) / 2, def.z - (this.u.y * this.width) / 2);
    this.rightHinge.set(def.x + (this.u.x * this.width) / 2, def.z + (this.u.y * this.width) / 2);

    this.leafWidth = this.double ? Math.max(0.2, this.width / 2 - DOUBLE_CENTER_GAP) : this.width;
    this.leafSegCount = Math.max(1, Math.ceil(this.leafWidth / cfg.segmentLength));
    this.segHalf = this.leafWidth / this.leafSegCount / 2;
    this.totalSegCount = this.double ? this.leafSegCount * 2 : this.leafSegCount;
    this.rightPivot = this.double ? new THREE.Group() : null;

    // 板は蝶番から leafWidth 以内しか動かないので、蝶番中心の正方形を空間索引用の可動範囲とする
    const reach = this.leafWidth + 0.25;
    const hinges = this.double ? [this.hinge, this.rightHinge] : [this.hinge];
    const sweep = {
      minX: Math.min(...hinges.map((h) => h.x)) - reach,
      minZ: Math.min(...hinges.map((h) => h.y)) - reach,
      maxX: Math.max(...hinges.map((h) => h.x)) + reach,
      maxZ: Math.max(...hinges.map((h) => h.y)) + reach,
    };
    for (let i = 0; i < this.totalSegCount; i++) {
      this.colliders.push({
        kind: 'door',
        aabb: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        sweep,
      });
      this.tmp.push({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } });
    }
    this.buildMesh();
    // 扉板の部材（框・モール・金物）はピボットごとに 1〜数ドローへ統合する
    batchStaticMeshes(this.pivot);
    if (this.rightPivot) batchStaticMeshes(this.rightPivot);
    this.computeBoxes(0, this.colliders.map((c) => c.aabb));
    this.applyMesh();
  }

  get stage(): DoorStage {
    if (this.angle < EPS) return 'closed';
    return this.angle < (this.peekAngle + this.maxAngle) / 2 ? 'peek' : 'open';
  }

  get isMoving(): boolean {
    return Math.abs(this.targetAngle - this.angle) > EPS;
  }

  private createMaterials(): DoorMaterials {
    const woodTex = this.textures?.get('doorWood');
    const frameTex = this.textures?.get('doorFrame');
    return {
      stile: new THREE.MeshStandardMaterial({
        color: woodTex ? COLORS.leafStile : 0x765032,
        roughness: 0.68,
        metalness: 0.04,
        ...(woodTex ? { map: woodTex } : {}),
      }),
      recess: new THREE.MeshStandardMaterial({
        color: woodTex ? COLORS.leafPanel : 0x5f3e25,
        roughness: 0.74,
        metalness: 0.03,
        ...(woodTex ? { map: woodTex } : {}),
      }),
      frame: new THREE.MeshStandardMaterial({
        color: frameTex ? COLORS.frame : 0x3d2a1c,
        roughness: 0.72,
        metalness: 0.05,
        ...(frameTex ? { map: frameTex } : {}),
      }),
      hardware: new THREE.MeshStandardMaterial({
        color: COLORS.hardware,
        roughness: 0.26,
        metalness: 0.82,
      }),
      kickPlate: new THREE.MeshStandardMaterial({
        color: COLORS.kickPlate,
        roughness: 0.34,
        metalness: 0.74,
      }),
      hinge: new THREE.MeshStandardMaterial({
        color: COLORS.hinge,
        roughness: 0.38,
        metalness: 0.78,
      }),
    };
  }

  private buildMesh(): void {
    const mats = this.createMaterials();
    this.root.name = `door:${this.id}`;

    // 1. 静的ドア枠・ケーシング・自動欄間（コライダなし）
    this.buildFrame(mats);
    this.frameGroup.position.set(this.cx, this.sillY, this.cz);
    this.frameGroup.rotation.y = this.yawRad;
    this.frameGroup.name = 'door-frame';
    this.root.add(this.frameGroup);

    // 2. 左（または単開き）リーフ
    this.buildLeaf(this.pivot, this.leafWidth, 1, mats, this.double);
    this.pivot.position.set(this.hinge.x, this.sillY, this.hinge.y);
    this.pivot.name = this.double ? 'door-pivot-left' : 'door-pivot';
    this.root.add(this.pivot);

    // 3. 両開き時の右リーフ
    if (this.rightPivot) {
      this.buildLeaf(this.rightPivot, this.leafWidth, -1, mats, false);
      this.rightPivot.position.set(this.rightHinge.x, this.sillY, this.rightHinge.y);
      this.rightPivot.name = 'door-pivot-right';
      this.root.add(this.rightPivot);
    }
  }

  /** 静的ドア枠（縦枠ジャム・上枠ヘッダー・戸当たり・表裏ケーシング・自動欄間）を構築する。 */
  private buildFrame(mats: DoorMaterials): void {
    const frameTh = this.cfg.frameThickness ?? DEFAULT_FRAME_THICKNESS;
    const frameDepth = this.cfg.frameDepth ?? DEFAULT_FRAME_DEPTH;
    const casingW = this.cfg.casingWidth ?? DEFAULT_CASING_WIDTH;
    const casingD = this.cfg.casingDepth ?? DEFAULT_CASING_DEPTH;
    const halfW = this.width / 2;
    const jambInset = 0.014;
    const openH = this.openingHeight;
    const leafH = this.height;

    const addBox = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, name: string): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.name = name;
      this.frameGroup.add(m);
    };

    // 左右縦枠（ジャム）
    const jambX = halfW + frameTh / 2 - jambInset;
    for (const side of [-1, 1]) {
      addBox(frameTh, openH, frameDepth, side * jambX, openH / 2, 0, mats.frame, 'door-jamb');
      // 戸当たりストリップ（内側の段差）
      addBox(0.012, leafH, 0.022, side * (halfW - jambInset - 0.006), leafH / 2, 0, mats.frame, 'door-stop');
    }

    // 上枠（ヘッダー）
    const transomGap = openH - leafH;
    const headerH = transomGap > TRANSOM_MIN_GAP ? Math.min(frameTh, transomGap * 0.45) : frameTh;
    addBox(this.width + frameTh * 1.2, headerH, frameDepth, 0, leafH + headerH / 2, 0, mats.frame, 'door-header');

    // 表裏ケーシング（額縁モールディング）
    const casingZ = frameDepth / 2 + casingD / 2 - 0.002;
    const casingVertH = openH + casingW;
    const casingX = halfW + casingW / 2 - jambInset;
    const casingTopW = this.width + casingW * 2 - jambInset * 2;
    for (const side of [-1, 1]) {
      addBox(casingW, casingVertH, casingD, -casingX, casingVertH / 2, side * casingZ, mats.frame, 'door-casing-left');
      addBox(casingW, casingVertH, casingD, casingX, casingVertH / 2, side * casingZ, mats.frame, 'door-casing-right');
      addBox(casingTopW, casingW, casingD, 0, openH + casingW / 2, side * casingZ, mats.frame, 'door-casing-top');
    }

    // 自動欄間（トランサム）: 開口高と扉高の差が > 0.04m の場合に上枠〜開口上端を綺麗に塞ぐ
    if (transomGap > TRANSOM_MIN_GAP) {
      const topBarH = Math.min(0.045, transomGap * 0.28);
      const glassBottom = leafH + headerH;
      const glassTop = openH - topBarH;
      const glassH = glassTop - glassBottom;
      const innerW = Math.max(0.08, this.width - jambInset * 2);

      // 欄間上枠
      addBox(this.width, topBarH, frameDepth * 0.92, 0, openH - topBarH / 2, 0, mats.frame, 'door-transom-top');

      if (glassH > 0.02) {
        const glassY = (glassBottom + glassTop) / 2;
        const glassTex = this.textures?.get('frostedGlass');
        const glassMat = new THREE.MeshStandardMaterial({
          color: COLORS.transomGlass,
          roughness: 0.32,
          metalness: 0.08,
          transparent: true,
          opacity: 0.62,
          ...(glassTex ? { map: glassTex } : {}),
        });
        // すりガラス調パネル
        addBox(innerW, glassH, 0.018, 0, glassY, 0, glassMat, 'door-transom-glass');
        // 上下の細い押縁（グレージングビード）
        const beadH = Math.min(0.018, glassH * 0.2);
        addBox(innerW, beadH, 0.042, 0, glassBottom + beadH / 2, 0, mats.frame, 'door-transom-bead');
        addBox(innerW, beadH, 0.042, 0, glassTop - beadH / 2, 0, mats.frame, 'door-transom-bead');
        // 両開きまたは幅広開口には中央方立（マリオン）を配置
        if (this.double || this.width >= 1.35) {
          addBox(0.036, glassH, 0.056, 0, glassY, 0, mats.frame, 'door-transom-mullion');
        }
      } else {
        // 隙間がごく狭い場合は木製幕板で密閉
        const fillH = Math.max(0.01, openH - glassBottom);
        addBox(innerW, fillH, frameDepth * 0.85, 0, glassBottom + fillH / 2, 0, mats.frame, 'door-transom-filler');
      }
    }
  }

  /**
   * リアルな框組（かまちぐみ）扉板1枚を構築する。
   * dirSign = +1 はローカル +X 方向へ延びる左/単開き扉、-1 はローカル -X 方向へ延びる右扉。
   */
  private buildLeaf(
    targetPivot: THREE.Group,
    leafW: number,
    dirSign: 1 | -1,
    mats: DoorMaterials,
    includeAstragal: boolean,
  ): void {
    const th = this.cfg.thickness;
    const hingeClearance = 0.014;
    const latchClearance = this.double ? 0.002 : 0.014;
    const panelStart = hingeClearance;
    const panelEnd = Math.max(panelStart + 0.12, leafW - latchClearance);
    const panelW = panelEnd - panelStart;
    const panelCx = dirSign * ((panelStart + panelEnd) / 2);

    const floorGap = 0.006;
    const topGap = 0.006;
    const leafH = Math.max(0.4, this.height - floorGap - topGap);
    const leafCy = floorGap + leafH / 2;

    const addBox = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, name: string): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.name = name;
      targetPivot.add(m);
    };

    // 1. 凹んだ本体板（鏡板ベース）
    const coreTh = th * 0.66;
    addBox(panelW, leafH, coreTh, panelCx, leafCy, 0, mats.recess, 'door-panel-core');

    // 2. 框組（左右縦框・上桟・中桟・下桟）
    const stileW = Math.min(0.105, panelW * 0.2);
    const topRailH = Math.min(0.12, leafH * 0.1);
    const bottomRailH = Math.min(0.19, leafH * 0.14);
    const midRailH = Math.min(0.135, leafH * 0.1);
    const handleY = Math.min(leafH - topRailH - 0.12, Math.max(bottomRailH + 0.12, this.cfg.handleHeight ?? DEFAULT_HANDLE_HEIGHT));
    const midRailY = handleY;
    const innerW = Math.max(0.04, panelW - stileW * 2);

    // 左右縦框
    addBox(stileW, leafH, th, dirSign * (panelStart + stileW / 2), leafCy, 0, mats.stile, 'door-stile-hinge');
    addBox(stileW, leafH, th, dirSign * (panelEnd - stileW / 2), leafCy, 0, mats.stile, 'door-stile-latch');
    // 上桟・中桟・下桟
    addBox(innerW, topRailH, th, panelCx, floorGap + leafH - topRailH / 2, 0, mats.stile, 'door-rail-top');
    addBox(innerW, midRailH, th, panelCx, midRailY, 0, mats.stile, 'door-rail-mid');
    addBox(innerW, bottomRailH, th, panelCx, floorGap + bottomRailH / 2, 0, mats.stile, 'door-rail-bottom');

    // 3. 上下鏡板の立体装飾パネル（段差のある額縁表現）
    const addRecessedDecor = (bayBottom: number, bayTop: number, tag: string): void => {
      const bayH = bayTop - bayBottom;
      if (bayH < 0.14 || innerW < 0.12) return;
      const inset = Math.min(0.032, innerW * 0.12, bayH * 0.12);
      const decW = innerW - inset * 2;
      const decH = bayH - inset * 2;
      const decY = (bayBottom + bayTop) / 2;
      // 浮き上がった鏡板中央面
      addBox(decW, decH, th * 0.84, panelCx, decY, 0, mats.stile, `door-decor-${tag}`);
      // 鏡板周囲の細いモールディング枠（表裏）
      const moldW = 0.016;
      const moldD = 0.008;
      for (const side of [-1, 1]) {
        const mz = side * (coreTh / 2 + moldD / 2);
        addBox(innerW, moldW, moldD, panelCx, bayTop - moldW / 2, mz, mats.stile, `door-mold-${tag}`);
        addBox(innerW, moldW, moldD, panelCx, bayBottom + moldW / 2, mz, mats.stile, `door-mold-${tag}`);
        addBox(moldW, bayH, moldD, panelCx - innerW / 2 + moldW / 2, decY, mz, mats.stile, `door-mold-${tag}`);
        addBox(moldW, bayH, moldD, panelCx + innerW / 2 - moldW / 2, decY, mz, mats.stile, `door-mold-${tag}`);
      }
    };
    addRecessedDecor(midRailY + midRailH / 2, floorGap + leafH - topRailH, 'upper');
    addRecessedDecor(floorGap + bottomRailH, midRailY - midRailH / 2, 'lower');

    // 4. 下部金属キックプレート
    const kickH = Math.min(0.13, bottomRailH * 0.72);
    const kickW = Math.max(0.08, panelW - 0.04);
    addBox(kickW, kickH, th + 0.004, panelCx, floorGap + kickH / 2 + 0.012, 0, mats.kickPlate, 'door-kickplate');

    // 5. ヒンジ側円柱丁番（3点）
    const hingeGeo = new THREE.CylinderGeometry(0.011, 0.011, 0.088, 8);
    const hingeYs = [floorGap + 0.24, leafCy, floorGap + leafH - 0.24];
    for (const hy of hingeYs) {
      const hinge = new THREE.Mesh(hingeGeo, mats.hinge);
      hinge.position.set(dirSign * 0.006, hy, 0);
      hinge.name = 'door-hinge';
      targetPivot.add(hinge);
    }

    // 6. レバーハンドル＆縦長座金（エスカッション）＋鍵穴シリンダー（両面）
    const handleX = dirSign * (panelEnd - Math.min(0.056, stileW * 0.54));
    const plateGeo = new THREE.BoxGeometry(0.04, 0.165, 0.008);
    const spindleGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.044, 10);
    const cylinderGeo = new THREE.CylinderGeometry(0.011, 0.011, 0.012, 10);
    const leverGeo = new THREE.BoxGeometry(0.112, 0.019, 0.015);
    const collarGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.014, 10);

    for (const side of [-1, 1]) {
      // 縦長座金
      const plate = new THREE.Mesh(plateGeo, mats.hardware);
      plate.position.set(handleX, handleY - 0.018, side * (th / 2 + 0.004));
      plate.name = 'door-escutcheon';
      targetPivot.add(plate);

      // 鍵穴シリンダー
      const lockCyl = new THREE.Mesh(cylinderGeo, mats.hinge);
      lockCyl.rotation.x = Math.PI / 2;
      lockCyl.position.set(handleX, handleY - 0.058, side * (th / 2 + 0.008));
      lockCyl.name = 'door-lock-cylinder';
      targetPivot.add(lockCyl);

      // 回転台座カラー
      const collar = new THREE.Mesh(collarGeo, mats.hardware);
      collar.rotation.x = Math.PI / 2;
      collar.position.set(handleX, handleY, side * (th / 2 + 0.011));
      collar.name = 'door-handle-collar';
      targetPivot.add(collar);

      // 円柱軸（スピンドル）
      const spindle = new THREE.Mesh(spindleGeo, mats.hardware);
      spindle.rotation.x = Math.PI / 2;
      spindle.position.set(handleX, handleY, side * (th / 2 + 0.025));
      spindle.name = 'door-handle-spindle';
      targetPivot.add(spindle);

      // 横向き L 字レバーハンドル（ヒンジ方向へ伸びる）
      const lever = new THREE.Mesh(leverGeo, mats.hardware);
      lever.position.set(handleX - dirSign * 0.048, handleY, side * (th / 2 + 0.046));
      lever.name = 'door-lever-handle';
      targetPivot.add(lever);
    }

    // 7. 両開きドアの中央合わせ目当て縁（アストラガル）
    if (includeAstragal) {
      addBox(0.024, leafH, th + 0.008, dirSign * (leafW + 0.002), leafCy, 0, mats.frame, 'door-astragal');
    }
  }

  private applyMesh(): void {
    const aRad = this.angle * DEG2RAD;
    this.pivot.rotation.y = this.yawRad - this.swingSign * aRad;
    if (this.rightPivot) {
      this.rightPivot.rotation.y = this.yawRad + this.swingSign * aRad;
    }
  }

  /** 指定角度での扉板分割 AABB を out へ書き込む（両開き時は左右両リーフ分）。 */
  private computeBoxes(angleDeg: number, out: AABB[]): void {
    const a = angleDeg * DEG2RAD;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    const th2 = this.cfg.thickness / 2;

    // 左（単開き）リーフ: d = +u cos a + s n sin a（隣接セグメント間に浮動小数点の隙間が出ないよう微小に重ねる）
    const segPad = this.segHalf + 1e-4;
    const ldx = this.u.x * cosA + this.swingSign * this.n.x * sinA;
    const ldz = this.u.y * cosA + this.swingSign * this.n.y * sinA;
    const lhx = segPad * Math.abs(ldx) + th2 * Math.abs(ldz);
    const lhz = segPad * Math.abs(ldz) + th2 * Math.abs(ldx);
    for (let i = 0; i < this.leafSegCount; i++) {
      const t = (i + 0.5) * this.segHalf * 2;
      const cx = this.hinge.x + ldx * t;
      const cz = this.hinge.y + ldz * t;
      const b = out[i];
      b.min.x = cx - lhx;
      b.max.x = cx + lhx;
      b.min.z = cz - lhz;
      b.max.z = cz + lhz;
      b.min.y = this.sillY;
      b.max.y = this.sillY + this.height;
    }

    // 両開き時の右リーフ: d = -u cos a + s n sin a
    if (this.double) {
      const rdx = -this.u.x * cosA + this.swingSign * this.n.x * sinA;
      const rdz = -this.u.y * cosA + this.swingSign * this.n.y * sinA;
      const rhx = segPad * Math.abs(rdx) + th2 * Math.abs(rdz);
      const rhz = segPad * Math.abs(rdz) + th2 * Math.abs(rdx);
      for (let i = 0; i < this.leafSegCount; i++) {
        const t = (i + 0.5) * this.segHalf * 2;
        const cx = this.rightHinge.x + rdx * t;
        const cz = this.rightHinge.y + rdz * t;
        const b = out[this.leafSegCount + i];
        b.min.x = cx - rhx;
        b.max.x = cx + rhx;
        b.min.z = cz - rhz;
        b.max.z = cz + rhz;
        b.min.y = this.sillY;
        b.max.y = this.sillY + this.height;
      }
    }
  }

  /** 開口の中心から見たプレイヤー側（+1 = 法線 n 側）。 */
  private sideOf(px: number, pz: number): number {
    return (px - this.cx) * this.n.x + (pz - this.cz) * this.n.y >= 0 ? 1 : -1;
  }

  /**
   * 目標角度を設定（施錠中は false）。閉状態から開く時は、プレイヤーの反対側へ振る。
   * fast = ドアノブ操作（速い・音が大きい）。
   */
  command(targetDeg: number, fast: boolean, playerX: number, playerZ: number): boolean {
    if (this.disposed || this.locked) return false;
    const target = Math.max(0, Math.min(this.maxAngle, targetDeg));
    if (Math.abs(target - this.targetAngle) < EPS && !this.isMoving) return false;
    if (this.angle < EPS && target > EPS) {
      this.swingSign = -this.sideOf(playerX, playerZ);
      this.applyMesh();
    }
    this.targetAngle = target;
    this.speedMul = fast ? this.cfg.knobSpeedMultiplier : 1;
    this.bus.emit('noise', {
      pos: { x: this.cx, y: this.sillY + 1, z: this.cz },
      radius: fast ? this.cfg.noise.fastRadius : this.cfg.noise.slowRadius,
      kind: 'door',
    });
    return true;
  }

  /**
   * ブリーチング（蹴破り）。全開済みは不可。
   * faction 'swat'（SWAT モードのプレイヤーと、両モードの AI SWAT）は同じドアに swatBreachKicks 回必要。
   * 足りない蹴りは音と扉の跳ね返りだけで、施錠・閉じた状態を維持する。
   * faction 'suspect' は 1 回で開く（容疑者の施錠・開閉は command / locked 代入のまま）。
   * 成功時だけ解錠して全開し、doorBreached を発行する。noise(kind:'breach') は毎蹴り。
   */
  breach(playerX: number, playerZ: number, faction: 'swat' | 'suspect' = 'swat'): boolean {
    if (this.disposed) return false;
    if (this.stage === 'open' && !this.isMoving) return false;
    if (faction === 'swat') {
      if (this.swatKickCooldown > 0) return false;
      this.swatKickCooldown = SWAT_KICK_GAP_SEC;
      this.swatKicks += 1;
      this.emitBreachNoise();
      if (this.swatKicks < swatBreachKicks(this.id)) {
        this.beginKickRecoil(playerX, playerZ);
        return false;
      }
    }
    return this.finishBreach(playerX, playerZ, faction !== 'swat');
  }

  /**
   * C2 爆破ブリーチ: 蹴り回数を無視して即座に解錠・高速全開（speedMultiplier >= 8）し、doorBreached を発行する。
   * 既に全開・停止済み、または破棄済みの場合は false。
   */
  breachExplosive(fromX: number, fromZ: number): boolean {
    if (this.disposed) return false;
    if (this.stage === 'open' && !this.isMoving) return false;
    if (!this.locked && this.targetAngle >= this.maxAngle - 1) return false;
    return this.finishBreach(fromX, fromZ, false, Math.max(8, this.cfg.breach.speedMultiplier));
  }

  private emitBreachNoise(): { x: number; y: number; z: number } {
    const pos = { x: this.cx, y: this.sillY + 1, z: this.cz };
    this.bus.emit('noise', { pos, radius: this.cfg.breach.noiseRadius, kind: 'breach' });
    return pos;
  }

  /** 蹴ったがまだ開かない。扉を少し弾いて閉じた位置へ戻す。 */
  private beginKickRecoil(playerX: number, playerZ: number): void {
    if (this.angle < EPS) {
      this.swingSign = -this.sideOf(playerX, playerZ);
      this.applyMesh();
    }
    this.kickRecoilReturn = this.angle < EPS ? 0 : this.targetAngle;
    this.kickRecoil = 'out';
    this.targetAngle = Math.min(this.maxAngle, this.angle + SWAT_KICK_BUMP_DEG);
    this.speedMul = this.cfg.breach.speedMultiplier;
  }

  /** 必要回数に達した蹴りまたは C2 爆破。施錠を外して全開にする。 */
  private finishBreach(
    playerX: number,
    playerZ: number,
    emitNoise: boolean,
    speedMul = this.cfg.breach.speedMultiplier,
  ): boolean {
    if (this.angle < EPS) {
      this.swingSign = -this.sideOf(playerX, playerZ);
      this.applyMesh();
    }
    this.kickRecoil = null;
    this.swatKicks = 0;
    this.swatKickCooldown = 0;
    this.locked = false;
    this.targetAngle = this.maxAngle;
    this.speedMul = speedMul;
    const pos = emitNoise ? this.emitBreachNoise() : { x: this.cx, y: this.sillY + 1, z: this.cz };
    const dir = { x: this.n.x * this.swingSign, y: 0, z: this.n.y * this.swingSign };
    this.bus.emit('doorBreached', { doorId: this.id, pos, radius: this.cfg.breach.effectRadius, dir });
    return true;
  }

  /** F: 閉→全開 / 開いている(または開き中)→閉。 */
  toggle(fast: boolean, playerX: number, playerZ: number): boolean {
    const closing = this.angle > EPS || this.targetAngle > EPS;
    return this.command(closing ? 0 : this.maxAngle, fast, playerX, playerZ);
  }

  /** ホイール: dir > 0 = 開く方向へ 1 段階（閉→ピーク→全開）、dir < 0 = 閉じる方向へ 1 段階。 */
  stepStage(dir: number, fast: boolean, playerX: number, playerZ: number): boolean {
    const stages = [0, this.peekAngle, this.maxAngle];
    const t = this.targetAngle;
    let next: number | undefined;
    if (dir > 0) next = stages.find((s) => s > t + EPS);
    else next = [...stages].reverse().find((s) => s < t - EPS);
    if (next === undefined) return false;
    return this.command(next, fast, playerX, playerZ);
  }

  /**
   * 角度を目標へ dt 基準で進める。進んだ先で円(プレイヤー)と重なるなら動かさず停止する（挟まない）。
   */
  update(rawDt: number, playerX: number, playerZ: number, playerRadius: number, playerY = 0): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    if (this.swatKickCooldown > 0) this.swatKickCooldown = Math.max(0, this.swatKickCooldown - dt);
    if (this.kickRecoil === 'out' && !this.isMoving) {
      this.kickRecoil = 'back';
      this.targetAngle = this.kickRecoilReturn;
      this.speedMul = this.cfg.breach.speedMultiplier;
    } else if (this.kickRecoil === 'back' && !this.isMoving) {
      this.kickRecoil = null;
      this.speedMul = 1;
    }
    if (!this.isMoving) return;
    const step = this.cfg.swingSpeed * this.speedMul * dt;
    const diff = this.targetAngle - this.angle;
    const next = Math.abs(diff) <= step ? this.targetAngle : this.angle + Math.sign(diff) * step;
    this.computeBoxes(next, this.tmp);
    const sameFloor = playerY >= this.sillY - 0.25 && playerY <= this.sillY + this.height;
    if (sameFloor && this.overlapsCircle(this.tmp, playerX, playerZ, playerRadius)) {
      this.targetAngle = this.angle; // 挟みそうなので停止
      return;
    }
    this.angle = next;
    for (let i = 0; i < this.totalSegCount; i++) {
      const s = this.tmp[i];
      const d = this.colliders[i].aabb;
      d.min.x = s.min.x;
      d.min.z = s.min.z;
      d.max.x = s.max.x;
      d.max.z = s.max.z;
    }
    this.applyMesh();
  }

  private overlapsCircle(boxes: AABB[], px: number, pz: number, r: number): boolean {
    const rr = (r - 1e-3) * (r - 1e-3);
    for (const a of boxes) {
      const cx = Math.max(a.min.x, Math.min(px, a.max.x));
      const cz = Math.max(a.min.z, Math.min(pz, a.max.z));
      const ox = px - cx;
      const oz = pz - cz;
      if (ox * ox + oz * oz < rr) return true;
    }
    return false;
  }

  /** レイと扉板（現在角度）の最近交点。maxDist 超過/ミスは null。 */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): DoorRayHit | null {
    let best = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < this.totalSegCount; i++) {
      const a = this.colliders[i].aabb;
      let t0 = 0;
      let t1 = maxDist;
      const axes: [number, number, number, number][] = [
        [origin.x, dir.x, a.min.x, a.max.x],
        [origin.y, dir.y, a.min.y, a.max.y],
        [origin.z, dir.z, a.min.z, a.max.z],
      ];
      let hit = true;
      for (const [o, d, mn, mx] of axes) {
        if (Math.abs(d) < 1e-9) {
          if (o < mn || o > mx) {
            hit = false;
            break;
          }
        } else {
          let ta = (mn - o) / d;
          let tb = (mx - o) / d;
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) {
            hit = false;
            break;
          }
        }
      }
      if (hit && t0 < best) {
        best = t0;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null;
    const localIdx = this.double && bestIdx >= this.leafSegCount ? bestIdx - this.leafSegCount : bestIdx;
    const along = (localIdx + 0.5) * this.segHalf * 2;
    return { distance: best, along, inKnobZone: along >= this.leafWidth - this.cfg.knobZone };
  }

  get centerX(): number {
    return this.cx;
  }
  get centerZ(): number {
    return this.cz;
  }
  /** 閉状態でヒンジからノブへ向かう水平単位ベクトル */
  get axisX(): number {
    return this.u.x;
  }
  get axisZ(): number {
    return this.u.y;
  }
  /** 扉面の法線（yaw 0 なら +Z） */
  get normalX(): number {
    return this.n.x;
  }
  get normalZ(): number {
    return this.n.y;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeObject(this.root);
  }
}

interface DoorTarget {
  door: Door;
  fast: boolean;
}

/**
 * マップの全ドアを生成・更新し、Interaction にドア操作（F=開閉トグル / ホイール=段階）を登録する。
 * ドア扉板の AABB は渡された共有 colliders に追加される（dispose で除去）。
 */
export class DoorSystem {
  readonly root = new THREE.Group();
  readonly doors: Door[] = [];
  private readonly unregister: () => void;
  private readonly eye = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private disposed = false;

  constructor(
    map: MapData,
    private readonly cfg: DoorConfig,
    private readonly colliders: Collider[],
    bus: GameEventBus,
    private readonly player: PlayerController,
    private readonly playerRadius: number,
    interaction: Interaction,
    private readonly input: InputManager,
    private readonly textures?: TextureLibrary,
    /** プレイヤーの蹴り。SWAT は複数回、容疑者は 1 回。AI は Door.breach を直接 'swat' で呼ぶ。 */
    private readonly playerFaction: 'swat' | 'suspect' = 'swat',
  ) {
    this.root.name = 'doors';
    const clearance = map.storyHeight ?? map.ceilingHeight;
    for (const def of map.doors) {
      const openingHeight = resolveDoorOpeningHeight(def, map, clearance);
      const door = new Door(def, cfg, openingHeight, bus, this.textures);
      this.doors.push(door);
      this.root.add(door.root);
      for (const c of door.colliders) colliders.push(c);
    }
    // 動かないドア枠は全ドア分をまとめて統合（扉板のピボット配下は除外）
    batchStaticMeshes(this.root, { skip: (o) => o.name.startsWith('door-pivot'), cellSize: 16 });
    this.unregister = interaction.register<DoorTarget>({
      id: 'door',
      priority: 200,
      resolve: () => this.resolveTarget(),
      label: (t) =>
        t.door.locked ? 'ドア: 施錠 (G 蹴破り)' : `ドア(${t.door.stage}): F 開閉 / ホイール 段階${t.fast ? ' [ノブ]' : ''}`,
      onPress: (t) => t.door.toggle(t.fast, this.player.position.x, this.player.position.z),
      // ホイール上(deltaY<0)=開く方向 / 下(deltaY>0)=閉じる方向
      onWheel: (t, steps) => {
        const n = Math.min(Math.abs(steps), 2);
        for (let i = 0; i < n; i++) {
          t.door.stepStage(steps < 0 ? 1 : -1, t.fast, this.player.position.x, this.player.position.z);
        }
      },
    });
  }

  getDoor(id: string): Door | undefined {
    return this.doors.find((d) => d.id === id);
  }

  private resolveTarget(range = this.cfg.interactRange): DoorTarget | null {
    const p = this.player;
    p.getEyePosition(this.eye);
    const cp = Math.cos(p.pitchRad);
    this.dir.set(-Math.sin(p.yawRad) * cp, Math.sin(p.pitchRad), -Math.cos(p.yawRad) * cp);

    // 視線が現在の扉板に当たる最近の扉だけ。自由端（両開きは中央合わせ目）付近ならノブ操作。開口の空きは対象にしない。
    let best: DoorTarget | null = null;
    let bestDist = Infinity;
    for (const door of this.doors) {
      const hit = door.raycast(this.eye, this.dir, range);
      if (hit && hit.distance < bestDist) {
        bestDist = hit.distance;
        best = { door, fast: hit.inKnobZone };
      }
    }
    return best;
  }

  /** プレイヤーが見ている扉。仲間のスタック先や指揮対象に使う。 */
  aimed(orderRange = 6): Door | null {
    const target = this.resolveTarget(orderRange);
    if (!target) return null;
    const ray = new THREE.Ray(this.eye, this.dir);
    const hit = new THREE.Vector3();
    const box = new THREE.Box3();
    const distance = target.door.raycast(this.eye, this.dir, orderRange)!.distance;
    for (const collider of this.colliders) {
      if (collider.kind === 'door') continue;
      const { min, max } = collider.aabb;
      box.min.set(min.x, min.y, min.z);
      box.max.set(max.x, max.y, max.z);
      if (ray.intersectBox(box, hit) && hit.distanceTo(this.eye) < distance - 0.01) return null;
    }
    return target.door;
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    const { x, z } = this.player.position;
    if (this.input.isPointerLocked && this.input.wasPressed('breach')) {
      // 蹴破りはドアに照準が合っている時のみ（F の Interaction 優先度とは独立）
      const t = this.resolveTarget();
      if (t) t.door.breach(x, z, this.playerFaction);
    }
    for (const d of this.doors) d.update(dt, x, z, this.playerRadius, this.player.position.y);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregister();
    for (const d of this.doors) {
      for (const c of d.colliders) {
        const i = this.colliders.indexOf(c);
        if (i >= 0) this.colliders.splice(i, 1);
      }
      d.dispose();
    }
    this.doors.length = 0;
    disposeObject(this.root);
  }
}

/**
 * ドア直上の垂れ壁（lintel）の底面高から実際の開口高を算出する。
 * モジュラー生成マップでは storyHeight（有効階高）より低い位置に垂れ壁が配置されるため、
 * 垂れ壁下端を上限とすることで枠・ケーシング・欄間が垂れ壁や天井スラブを貫通するのを防ぐ。
 */
function resolveDoorOpeningHeight(def: DoorDef, map: MapData, fallbackClearance: number): number {
  const sillY = def.y ?? 0;
  let openingH = fallbackClearance;
  for (const w of map.walls) {
    const wy = w.y ?? 0;
    const relY = wy - sillY;
    if (relY <= 0.5 || relY >= openingH) continue;
    const halfW = w.width / 2 + 0.02;
    const halfD = w.depth / 2 + 0.02;
    if (Math.abs(def.x - w.x) <= halfW && Math.abs(def.z - w.z) <= halfD) {
      openingH = relY;
    }
  }
  return openingH;
}
