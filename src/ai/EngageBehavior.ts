import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import type { CombatParams, MobilityParams, RoomDef, Vec3 } from '../core/types';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Door, DoorSystem } from '../world/Door';
import type { AABB, Collider } from '../world/WorldBuilder';
import type { HumanoidBody } from './HumanoidBody';
import type { AlertView } from './SuspectAlert';
import { hasFloorSupport, legacyZeroFallbackOf, MAX_DROP_HEIGHT, nextFootY, probeGround, STEP_HEIGHT, type StairMark } from '../world/Walk';
import { collidersNear, raycastColliders } from '../world/ColliderIndex';
import {
  blockedAtFiltered,
  distToSegment,
  pathSegmentClear,
  pickBestStair,
  squadRoute,
  STAIR_FLOOR_MATCH,
  stairEntry,
  stairExitReached,
  stairRunTarget,
} from './SquadRoute';

/** 戦闘系ステートが参照するプレイヤー情報（Perception の PerceptionTarget と構造互換） */
export interface CombatTarget {
  getEyePosition(out?: THREE.Vector3): THREE.Vector3;
  readonly position: THREE.Vector3;
  readonly alive?: boolean;
  getBodyBounds?(): AABB;
}

/** 仲間隊員ターゲット（循環参照防止のため最小 IF） */
export interface AllyTarget {
  readonly id: string;
  readonly px: number;
  readonly pz: number;
  readonly footY: number;
  readonly height: number;
  getEye(): Vec3;
  getChest(): Vec3;
  getAABB(): AABB;
  /** 盾持ち: from から撃たれた弾が hit で盾に止められるか */
  shieldBlocks?(from: Vec3, hit: Vec3): boolean;
}

export interface CombatThreat {
  id: string;
  x: number;
  z: number;
  point: Vec3;
  isPlayer: boolean;
}

/** 人質盾の対象になり得る民間人の最小 IF（Civilian が満たす。循環参照回避） */
export interface ShieldHostage {
  readonly id: string;
  readonly alive: boolean;
  readonly shieldedBy: string | null;
  readonly canBeShielded: boolean;
  readonly body: HumanoidBody;
  beginShield(by: string): void;
  endShield(): void;
}

export interface CombatContext {
  player: CombatTarget;
  colliders: readonly Collider[];
  /** 人質盾の候補（民間人）。未指定なら盾にしない */
  civilians?: () => Iterable<ShieldHostage>;
  /** 生存中の味方隊員（容疑者の知覚・射撃対象） */
  allies?: () => readonly AllyTarget[];
  /** プレイヤーへの実弾命中コールバック */
  playerDamage?: (amount: number, from: Vec3, shooter: string, hitY?: number) => void;
  /** 指定位置へ視線が通る周囲の隊員数（チーム威圧用） */
  countCoveringAllies?: (point: Vec3, maxDist: number) => number;
  /** ドアシステム（未施錠ドア自動開放・経路探索用） */
  doors?: DoorSystem;
  /** マップ床範囲（A* グリッド境界用） */
  bounds?: { width: number; depth: number };
  /** 階段一覧（上下階移動用） */
  stairs?: readonly StairMark[];
  /** 部屋定義（巡回・フランク・人質室防衛・フロア判定用） */
  rooms?: readonly RoomDef[];
  /** true ならプレイヤーを脅威にしない（容疑者モードの味方 NPC。SWAT モードでは未設定） */
  ignorePlayer?: boolean;
  /** 容疑者側の警戒度（SWAT モードのみ）。未設定/null なら従来どおり */
  alert?: () => AlertView | null;
}

export interface XZ {
  x: number;
  z: number;
}

const BODY_RADIUS = 0.3;
const ARRIVE_DIST = 0.08;
const MAX_MOVE_SEC = 4;
const PLAYER_BODY_DROP = 0.6;
const FIRE_DELAY_FACTOR = 0.5;
const MUZZLE_SEC = 0.06;
const STAND_CHEST = 1.25;
const CROUCH_CHEST = 0.85;
const FALLBACK_PLAYER_EYE_Y = 1.6;

/** 円(半径 r)が壁/遮蔽物/ドア板に重なるか（歩行高さ帯のみ） */
export function blockedAt(colliders: readonly Collider[], x: number, z: number, r = BODY_RADIUS, feetY = 0): boolean {
  for (const c of collidersNear(colliders, x - r, z - r, x + r, z + r)) {
    const a = c.aabb;
    if (a.max.y <= feetY + STEP_HEIGHT) continue;
    if (a.min.y >= feetY + 1.6) continue;
    const cx = Math.max(a.min.x, Math.min(x, a.max.x));
    const cz = Math.max(a.min.z, Math.min(z, a.max.z));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

const PUSH_EPS = 1e-4;
const coverScratch: Collider[] = [];
const threatPlayerEyeTmp = new THREE.Vector3();
const threatFromTmp: Vec3 = { x: 0, y: 0, z: 0 };
const threatPtTmp: Vec3 = { x: 0, y: 0, z: 0 };

/** 円(半径 r)と歩行高さ帯の AABB 群の重なりを法線方向へ押し出す（最大 maxPasses パス）。 */
function pushOutCircleAABB(
  colliders: readonly Collider[],
  x: number,
  z: number,
  r: number,
  feetY: number,
  maxPasses: number,
): { x: number; z: number; pushed: boolean } {
  let px = x;
  let pz = z;
  let pushed = false;
  const r2 = r * r;
  const span = r * 4 + 0.5;
  const near = collidersNear(colliders, x - span, z - span, x + span, z + span);
  for (let pass = 0; pass < maxPasses; pass++) {
    let hit = false;
    for (let i = 0; i < near.length; i++) {
      const a = near[i]!.aabb;
      if (a.max.y <= feetY + STEP_HEIGHT) continue;
      if (a.min.y >= feetY + 1.6) continue;
      const cx = Math.max(a.min.x, Math.min(px, a.max.x));
      const cz = Math.max(a.min.z, Math.min(pz, a.max.z));
      const dx = px - cx;
      const dz = pz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2);
        const push = r - d + PUSH_EPS;
        px += (dx / d) * push;
        pz += (dz / d) * push;
      } else {
        const dLeft = px - a.min.x;
        const dRight = a.max.x - px;
        const dBack = pz - a.min.z;
        const dFront = a.max.z - pz;
        const m = Math.min(dLeft, dRight, dBack, dFront);
        if (m === dLeft) px = a.min.x - r - PUSH_EPS;
        else if (m === dRight) px = a.max.x + r + PUSH_EPS;
        else if (m === dBack) pz = a.min.z - r - PUSH_EPS;
        else pz = a.max.z + r + PUSH_EPS;
      }
      hit = true;
      pushed = true;
    }
    if (!hit) break;
  }
  return { x: px, z: pz, pushed };
}

/**
 * 現在位置が壁・遮蔽物・ドア板にめり込んでいる場合、円 vs AABB 法線押し出し（および近傍探索）で
 * 支持面のある自由位置へ脱出させる。実際に補正できたら true。
 */
export function resolveOverlap(
  body: HumanoidBody,
  colliders: readonly Collider[],
  radius = BODY_RADIUS,
  maxPasses = 4,
): boolean {
  body.ground = colliders;
  const feet = body.footY;
  if (!blockedAt(colliders, body.px, body.pz, radius, feet)) return false;
  const legacy = legacyZeroFallbackOf(colliders);
  const canStand = (x: number, z: number): boolean =>
    !blockedAt(colliders, x, z, radius, feet) &&
    (legacy || hasFloorSupport(colliders, x, z, feet, radius, false));
  const res = pushOutCircleAABB(colliders, body.px, body.pz, radius, feet, maxPasses);
  if (res.pushed && Math.hypot(res.x - body.px, res.z - body.pz) <= radius * 3 && canStand(res.x, res.z)) {
    const support = probeGround(colliders, res.x, res.z, feet, radius, legacy) ?? feet;
    body.setPosition(res.x, res.z, nextFootY(feet, support, 0.25));
    return true;
  }
  for (const dist of [0.15, 0.3, 0.45, 0.65, 0.9]) {
    for (let i = 0; i < 12; i++) {
      const ang = (i * Math.PI * 2) / 12;
      const nx = body.px + Math.cos(ang) * dist;
      const nz = body.pz + Math.sin(ang) * dist;
      if (canStand(nx, nz)) {
        const support = probeGround(colliders, nx, nz, feet, radius, legacy) ?? feet;
        body.setPosition(nx, nz, nextFootY(feet, support, 0.25));
        return true;
      }
    }
  }
  return false;
}

/**
 * (x,z) から 1 ステップ移動（円 vs AABB 法線押し出しスライド＋軸分離フォールバック）。実際に動いたら true。
 * 壁に加え、支持面の無い位置（モジュラー敷地外・地下の空隙）へは踏み出さない（旧固定マップは従来どおり）。
 */
export function stepToward(
  body: HumanoidBody,
  colliders: readonly Collider[],
  tx: number,
  tz: number,
  dist: number,
  radius = BODY_RADIUS,
): boolean {
  body.ground = colliders;
  const dx = tx - body.px;
  const dz = tz - body.pz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return false;
  const k = Math.min(1, dist / d);
  const sx = body.px + dx * k;
  const sz = body.pz + dz * k;
  const feet = body.footY;
  const legacy = legacyZeroFallbackOf(colliders);
  const curSupport = probeGround(colliders, body.px, body.pz, feet, radius, legacy);
  const grounded = legacy || (curSupport !== null && feet - curSupport <= MAX_DROP_HEIGHT);
  const canStand = (x: number, z: number): boolean => {
    if (blockedAt(colliders, x, z, radius, feet)) return false;
    if (legacy) return true;
    const g = probeGround(colliders, x, z, feet, radius, false);
    if (g === null) return false;
    return grounded ? feet - g <= MAX_DROP_HEIGHT : true;
  };
  let nx = body.px;
  let nz = body.pz;
  let moved = false;
  if (canStand(sx, sz)) {
    nx = sx;
    nz = sz;
    moved = true;
  } else {
    const pushed = pushOutCircleAABB(colliders, sx, sz, radius, feet, 3);
    if (
      Math.hypot(pushed.x - sx, pushed.z - sz) <= radius * 2.5 &&
      Math.hypot(pushed.x - body.px, pushed.z - body.pz) > 1e-4 &&
      canStand(pushed.x, pushed.z)
    ) {
      nx = pushed.x;
      nz = pushed.z;
      moved = true;
    } else if (canStand(sx, body.pz)) {
      nx = sx;
      nz = body.pz;
      moved = true;
    } else if (canStand(body.px, sz)) {
      nx = body.px;
      nz = sz;
      moved = true;
    }
  }
  if (!moved) return false;
  // canStand 済みなので非 legacy でも支持はある。万一 null なら現在高を保つ（落下させない）
  const support = probeGround(colliders, nx, nz, body.footY, radius, legacy) ?? body.footY;
  body.setPosition(nx, nz, nextFootY(body.footY, support, Math.max(0.12, dist * 3)));
  return true;
}

/** (x,z) の位置からプレイヤーまたは仲間隊員の中で最寄りの視認可能脅威を返す。 */
export function findNearestVisibleThreat(
  ctx: CombatContext,
  x: number,
  z: number,
  eyeY: number,
  range: number,
): CombatThreat | null {
  threatFromTmp.x = x;
  threatFromTmp.y = eyeY;
  threatFromTmp.z = z;
  let best: CombatThreat | null = null;
  let bestD = range;

  if (!ctx.ignorePlayer && ctx.player.alive !== false) {
    const eye = ctx.player.getEyePosition(threatPlayerEyeTmp);
    const pos = ctx.player.position;
    const d = Math.hypot(pos.x - x, pos.z - z);
    if (d <= bestD) {
      threatPtTmp.x = eye.x;
      threatPtTmp.y = eye.y;
      threatPtTmp.z = eye.z;
      if (hasLineOfSight(ctx.colliders, threatFromTmp, threatPtTmp)) {
        bestD = d;
        best = { id: 'player', x: pos.x, z: pos.z, point: { x: eye.x, y: eye.y, z: eye.z }, isPlayer: true };
      } else {
        threatPtTmp.x = pos.x;
        threatPtTmp.y = eye.y - PLAYER_BODY_DROP;
        threatPtTmp.z = pos.z;
        if (hasLineOfSight(ctx.colliders, threatFromTmp, threatPtTmp)) {
          bestD = d;
          best = {
            id: 'player',
            x: pos.x,
            z: pos.z,
            point: { x: pos.x, y: eye.y - PLAYER_BODY_DROP, z: pos.z },
            isPlayer: true,
          };
        }
      }
    }
  }

  if (ctx.allies) {
    const allies = ctx.allies();
    for (let i = 0; i < allies.length; i++) {
      const a = allies[i]!;
      const d = Math.hypot(a.px - x, a.pz - z);
      if (d > bestD) continue;
      const chest = a.getChest();
      if (hasLineOfSight(ctx.colliders, threatFromTmp, chest)) {
        bestD = d;
        best = { id: a.id, x: a.px, z: a.pz, point: { x: chest.x, y: chest.y, z: chest.z }, isPlayer: false };
      }
    }
  }

  return best;
}

/** (x,z) の位置からプレイヤー(目 or 胴)が見えるか。視野角は考慮しない（交戦中）。 */
export function playerVisibleFrom(ctx: CombatContext, x: number, z: number, eyeY: number, range: number): boolean {
  return findNearestVisibleThreat(ctx, x, z, eyeY, range) !== null;
}

/** 脅威点から遮蔽が取れる近傍の遮蔽裏を探す（ALERT 待機用）。 */
export function findAlertCover(
  colliders: readonly Collider[],
  px: number,
  pz: number,
  feetY: number,
  threat: XZ,
  searchRange = 4.5,
): XZ | null {
  let best: XZ | null = null;
  let bestD = Infinity;
  const m = 0.45;
  const pad = Math.max(2, m + 0.5);
  const near = collidersNear(colliders, px - searchRange - pad, pz - searchRange - pad, px + searchRange + pad, pz + searchRange + pad);
  coverScratch.length = 0;
  for (let i = 0; i < near.length; i++) {
    const c = near[i]!;
    if (c.kind !== 'cover') continue;
    const a = c.aabb;
    if (a.min.y > feetY + 1.2 || a.max.y < feetY + 0.35) continue;
    if (
      a.max.x + m < px - searchRange ||
      a.min.x - m > px + searchRange ||
      a.max.z + m < pz - searchRange ||
      a.min.z - m > pz + searchRange
    ) {
      continue;
    }
    coverScratch.push(c);
  }
  const threatEye: Vec3 = { x: threat.x, y: feetY + 1.5, z: threat.z };
  const targetPt: Vec3 = { x: 0, y: feetY + 1.1, z: 0 };
  for (let i = 0; i < coverScratch.length; i++) {
    const a = coverScratch[i]!.aabb;
    const cx = (a.min.x + a.max.x) / 2;
    const cz = (a.min.z + a.max.z) / 2;
    const hx = (a.max.x - a.min.x) / 2;
    const hz = (a.max.z - a.min.z) / 2;
    for (let k = 0; k < 4; k++) {
      const hxPos = k === 0 ? cx + hx + m : k === 1 ? cx - hx - m : cx;
      const hzPos = k === 2 ? cz + hz + m : k === 3 ? cz - hz - m : cz;
      const d = Math.hypot(hxPos - px, hzPos - pz);
      if (d > searchRange || d >= bestD) continue;
      if (blockedAt(colliders, hxPos, hzPos, BODY_RADIUS, feetY)) continue;
      targetPt.x = hxPos;
      targetPt.z = hzPos;
      if (hasLineOfSight(colliders, threatEye, targetPt)) continue;
      bestD = d;
      best = { x: hxPos, z: hzPos };
    }
  }
  return best;
}

type Phase = 'toCover' | 'cover' | 'reload' | 'toPeek' | 'peek' | 'advance' | 'flank';

interface CoverSpot {
  hide: XZ;
  peek: XZ[];
  crouch: boolean;
}

const NAV_DOOR_OPEN_ANGLE = 70;
const NAV_DOOR_OPEN_TIMEOUT = 2.5;
const NAV_SKIPPED_DOOR_TTL = 4.0;
const NAV_REPATH_BASE = 0.9;
const NAV_REPATH_JITTER = 0.5;
const NAV_STAIR_PICK_INTERVAL = 2.5;
/** 階段選択キャッシュを再利用する目的地のずれ許容（m） */
const NAV_STAIR_PICK_DEST_SLACK = 4;
const NAV_STAIR_ARRIVE = 0.85;
const NAV_STAIR_EXIT_RADIUS = 0.48;
const NAV_STAIR_STALL_RESET = 2.0;
const NAV_STUCK_RESET = 1.2;
const NAV_STUCK_ABORT = 3.2;

/**
 * 音源・射撃位置などの 3D 座標から該当フロアの床高(floorY)を推定する。
 * 胸高・ドアノブ高の y 座標による誤った別階判定を防ぐ。
 */
export function resolveFloorY(pos: Vec3, rooms?: readonly RoomDef[], kind?: string): number {
  if (rooms && rooms.length > 0) {
    let bestY: number | null = null;
    let bestDiff = Infinity;
    for (const r of rooms) {
      if (Math.abs(pos.x - r.x) > r.width / 2 + 0.6 || Math.abs(pos.z - r.z) > r.depth / 2 + 0.6) continue;
      const fy = r.floorY ?? 0;
      if (pos.y < fy - 0.35) continue;
      const diff = Math.abs(pos.y - (fy + 0.9));
      if (diff < bestDiff) {
        bestDiff = diff;
        bestY = fy;
      }
    }
    if (bestY !== null) return bestY;
  }
  if (kind === 'gunshot' || kind === 'door' || kind === 'breach' || kind === 'voice' || kind === 'reload') {
    return pos.y - 1.0;
  }
  return pos.y;
}

export interface SuspectNavOptions {
  canOpenDoors: boolean;
  canUseStairs: boolean;
  faceTravel?: boolean;
  arriveDist?: number;
  /**
   * 加減速（opt-in）。指定時は瞬時に最高速にならず、accel(m/s²) で加速・decel(m/s²) で減速する。
   * 最終目標 dest への残距離が slowRadius 未満なら目標速度を比例で落とす（到着前に減速）。
   * 未指定の既存呼び出し（容疑者 AI 等）は従来どおり等速。
   */
  smooth?: { accel?: number; decel?: number; slowRadius?: number };
  /**
   * 到着ヒステリシス（opt-in）。一度 arriveDist 内で 'arrived' を返したら、
   * 同じ目標（0.35m 以内）に対しては arriveDist + restartDist を超えるまで 'arrived' を返し続ける。
   */
  restartDist?: number;
}

export type NavStepResult = 'moving' | 'arrived' | 'blocked';

/** smooth 指定時の既定値（設計 §3.2: accel 9 m/s²・停止 12 m/s²・減速開始 0.6m） */
const NAV_SMOOTH_ACCEL = 9;
const NAV_SMOOTH_DECEL = 12;
const NAV_SMOOTH_SLOW_RADIUS = 0.6;
/** 減速中でも完全に止まらないための目標速度の下限（最高速比） */
const NAV_SMOOTH_MIN_FRAC = 0.25;

/**
 * 容疑者（Suspect / EngageBehavior）共用の部屋間・階段ナビゲータ。
 * SquadRoute の A* 経路探索と階段純粋関数群、EngageBehavior の stepToward / resolveOverlap を組み合わせて
 * 未施錠ドア自動開放・階段昇降・A*再探索クールダウン（0.9〜1.4s + 個体ジッター）を提供する。
 */
export class SuspectNavigator {
  private path: XZ[] = [];
  private pathGoal: XZ | null = null;
  private repathCd = 0;
  private readonly repathInterval: number;
  private activeStair: { id: string; up: boolean } | null = null;
  private stairPick: { up: boolean; floorY: number; id: string; timer: number; destX: number; destZ: number; destY: number } | null = null;
  private doorWait = 0;
  private doorOpenTimer = 0;
  private doorOpenTargetId: string | null = null;
  private readonly skippedDoors = new Map<string, number>();
  private stalled = 0;
  private anchor: XZ;
  private openingDoorNow = false;
  /** smooth 指定時の現在速度(m/s)。reset() では落とさない（状態遷移で急停止しない） */
  private curSpeed = 0;
  /** このフレームに step が呼ばれたか（beginFrame で判定。呼ばれなかったフレームは停止扱い） */
  private steppedThisFrame = false;
  /** restartDist 指定時の到着済み目標（ヒステリシス） */
  private settledAt: XZ | null = null;
  private readonly passableSet = new Set<Collider>();
  private passableDirty = true;
  private readonly doorSegPts: XZ[] = [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ];

  constructor(
    private readonly body: HumanoidBody,
    private readonly ctx: CombatContext,
  ) {
    this.repathInterval = NAV_REPATH_BASE + Math.random() * NAV_REPATH_JITTER;
    this.anchor = { x: body.px, z: body.pz };
  }

  /** 容疑者自身がまさにドア開閉コマンドを実行中か（Perception の無限 ALERT 連鎖抑制用） */
  get isOpeningDoor(): boolean {
    return this.openingDoorNow;
  }

  /** 階段を昇降中か（reset で途中の階段状態を失わないよう呼び出し側が判定に使う） */
  get onStair(): boolean {
    return this.activeStair !== null;
  }

  /** smooth 指定時の現在速度(m/s) */
  get speed(): number {
    return this.curSpeed;
  }

  /**
   * フレーム頭で呼ぶ（smooth を使う呼び出し側のみ）。前フレームに step が呼ばれていなければ
   * その場で止まっていたので速度を 0 に戻す（次の発進は加速から）。
   */
  beginFrame(): void {
    if (!this.steppedThisFrame) this.curSpeed = 0;
    this.steppedThisFrame = false;
  }

  reset(): void {
    this.path.length = 0;
    this.pathGoal = null;
    this.repathCd = 0;
    this.activeStair = null;
    // stairPick は保持する: 階段選択は階段ごとに A* を回す重い処理で、ステート遷移のたびに捨てると
    // 大型マップで数十〜数百 ms のスパイクになる。階・昇降方向の一致とタイマーで鮮度は担保される。
    this.doorWait = 0;
    this.doorOpenTimer = 0;
    this.doorOpenTargetId = null;
    this.stalled = 0;
    this.anchor = { x: this.body.px, z: this.body.pz };
    this.settledAt = null;
  }

  /** smooth 指定時の 1 フレームの移動距離。未指定なら speed*dt（従来どおり） */
  private stepDistance(dest: Vec3, speed: number, dt: number, opts: SuspectNavOptions): number {
    this.steppedThisFrame = true;
    const sm = opts.smooth;
    if (!sm) {
      this.curSpeed = speed;
      return speed * dt;
    }
    const slow = sm.slowRadius ?? NAV_SMOOTH_SLOW_RADIUS;
    const d = Math.hypot(dest.x - this.body.px, dest.z - this.body.pz);
    const frac = slow > 0 ? Math.max(NAV_SMOOTH_MIN_FRAC, Math.min(1, d / slow)) : 1;
    const want = speed * frac;
    const diff = want - this.curSpeed;
    const lim = (diff >= 0 ? sm.accel ?? NAV_SMOOTH_ACCEL : sm.decel ?? NAV_SMOOTH_DECEL) * dt;
    this.curSpeed = Math.max(0, this.curSpeed + Math.max(-lim, Math.min(lim, diff)));
    return this.curSpeed * dt;
  }

  private getPassable(opts: SuspectNavOptions): ReadonlySet<Collider> | undefined {
    if (!opts.canOpenDoors) return undefined;
    const doors = this.ctx.doors?.doors;
    if (!doors) return undefined;
    if (this.passableDirty) {
      this.passableDirty = false;
      this.passableSet.clear();
      for (const d of doors) {
        if (this.skippedDoors.has(d.id)) continue;
        if (!d.locked && d.angle < NAV_DOOR_OPEN_ANGLE) {
          for (const c of d.colliders) this.passableSet.add(c);
        }
      }
    }
    return this.passableSet;
  }

  private pickDoorOnPath(routeDest: XZ): Door | null {
    const doors = this.ctx.doors?.doors;
    if (!doors) return null;
    const pts = this.doorSegPts;
    pts[0]!.x = this.body.px;
    pts[0]!.z = this.body.pz;
    let ptCount = 1;
    if (this.path.length > 0) {
      const limit = Math.min(this.path.length, 3);
      for (let i = 0; i < limit; i++) {
        pts[ptCount]!.x = this.path[i]!.x;
        pts[ptCount]!.z = this.path[i]!.z;
        ptCount++;
      }
    } else {
      pts[1]!.x = routeDest.x;
      pts[1]!.z = routeDest.z;
      ptCount = 2;
    }

    let best: Door | null = null;
    let bestSegDist = 0.85;
    let bestDist = Infinity;
    for (const door of doors) {
      if (this.skippedDoors.has(door.id)) continue;
      if (door.locked || door.angle >= NAV_DOOR_OPEN_ANGLE) continue;
      if (Math.abs(door.sillY - this.body.footY) > 0.65) continue;
      const dist = Math.hypot(this.body.px - door.centerX, this.body.pz - door.centerZ);
      if (dist >= 1.35) continue;
      let segDist = Infinity;
      for (let i = 0; i < ptCount - 1; i++) {
        const d = distToSegment(door.centerX, door.centerZ, pts[i]!, pts[i + 1]!);
        if (d < segDist) segDist = d;
      }
      if (segDist > bestSegDist) continue;
      if (segDist < bestSegDist - 0.05 || (Math.abs(segDist - bestSegDist) <= 0.05 && dist < bestDist)) {
        best = door;
        bestSegDist = segDist;
        bestDist = dist;
      }
    }
    return best;
  }

  private chooseStair(
    up: boolean,
    dt: number,
    opts: SuspectNavOptions,
    dest: Vec3,
  ): StairMark | null {
    const stairs = this.ctx.stairs;
    const bounds = this.ctx.bounds;
    if (!stairs || stairs.length === 0 || !bounds) return null;
    const cache = this.stairPick;
    if (cache) cache.timer -= dt;
    if (
      cache &&
      cache.up === up &&
      cache.timer > 0 &&
      Math.abs(cache.floorY - this.body.footY) <= STAIR_FLOOR_MATCH &&
      Math.abs(cache.destY - dest.y) <= STAIR_FLOOR_MATCH &&
      Math.hypot(cache.destX - dest.x, cache.destZ - dest.z) <= NAV_STAIR_PICK_DEST_SLACK
    ) {
      const hit = stairs.find((m) => m.id === cache.id);
      if (hit) return hit;
    }
    const choice = pickBestStair(
      stairs,
      { x: this.body.px, z: this.body.pz, footY: this.body.footY },
      up,
      this.ctx.colliders,
      bounds,
      BODY_RADIUS,
      this.getPassable(opts),
      dest,
    );
    if (!choice) return null;
    this.stairPick = {
      up,
      floorY: this.body.footY,
      id: choice.stair.id,
      timer: NAV_STAIR_PICK_INTERVAL,
      destX: dest.x,
      destZ: dest.z,
      destY: dest.y,
    };
    return choice.stair;
  }

  /** 目標 dest(Vec3) へ 1 フレーム移動する。 */
  step(dest: Vec3, speed: number, dt: number, opts: SuspectNavOptions): NavStepResult {
    const body = this.body;
    const arriveDist = opts.arriveDist ?? 0.55;
    this.steppedThisFrame = true;
    this.passableDirty = true;
    this.repathCd = Math.max(0, this.repathCd - dt);
    this.doorWait = Math.max(0, this.doorWait - dt);
    for (const [doorId, left] of this.skippedDoors) {
      if (left - dt <= 0) this.skippedDoors.delete(doorId);
      else this.skippedDoors.set(doorId, left - dt);
    }

    const sameFloor = Math.abs(dest.y - body.footY) <= 0.75;
    const distToDest = Math.hypot(dest.x - body.px, dest.z - body.pz);
    if (opts.restartDist !== undefined) {
      const s = this.settledAt;
      if (s && Math.hypot(s.x - dest.x, s.z - dest.z) > 0.35) this.settledAt = null;
      if (sameFloor && this.settledAt && distToDest <= arriveDist + opts.restartDist) {
        this.steppedThisFrame = true;
        this.curSpeed = 0;
        return 'arrived';
      }
      this.settledAt = null;
    }
    if (sameFloor && distToDest <= arriveDist) {
      if (opts.restartDist !== undefined) this.settledAt = { x: dest.x, z: dest.z };
      this.curSpeed = 0;
      return 'arrived';
    }

    // 停滞検知と押し出し復帰
    if (Math.hypot(body.px - this.anchor.x, body.pz - this.anchor.z) >= 0.1) {
      this.anchor = { x: body.px, z: body.pz };
      this.stalled = 0;
    } else {
      this.stalled += dt;
      if (this.stalled >= NAV_STUCK_ABORT) {
        this.activeStair = null;
        this.stairPick = null;
        this.path.length = 0;
        this.pathGoal = null;
        resolveOverlap(body, this.ctx.colliders, BODY_RADIUS);
        this.stalled = 0;
        return 'blocked';
      }
      if (this.stalled >= NAV_STUCK_RESET && this.path.length > 0) {
        resolveOverlap(body, this.ctx.colliders, BODY_RADIUS);
        this.path.length = 0;
        this.pathGoal = null;
        this.stairPick = null;
      }
    }

    let routeDest: XZ = { x: dest.x, z: dest.z };
    let onStairRun = false;

    // 階段昇降中
    if (this.activeStair) {
      const act = this.activeStair;
      const s = this.ctx.stairs?.find((m) => m.id === act.id);
      if (!s || stairExitReached(s, act.up, body.px, body.pz, body.footY, NAV_STAIR_EXIT_RADIUS)) {
        this.activeStair = null;
      } else if (this.stalled >= NAV_STAIR_STALL_RESET) {
        this.activeStair = null;
        this.stairPick = null;
        this.stalled = 0;
        this.anchor = { x: body.px, z: body.pz };
      } else {
        onStairRun = true;
        routeDest = stairRunTarget(s, act.up, body.px, body.pz);
      }
    }

    // 別階目的地なら階段を選択
    if (!onStairRun && !sameFloor) {
      if (!opts.canUseStairs || !this.ctx.stairs || this.ctx.stairs.length === 0) {
        return 'blocked';
      }
      const up = dest.y > body.footY;
      const stair = this.chooseStair(up, dt, opts, dest);
      if (!stair) return 'blocked';
      const entry = stairEntry(stair, up);
      const onFlight =
        (up ? body.footY > stair.baseY + 0.35 : body.footY < stair.topY - 0.35) &&
        distToSegment(body.px, body.pz, stair.approachLow, stair.approachHigh) <= 1.0;
      const entryClear =
        Math.hypot(body.px - entry.x, body.pz - entry.z) <= NAV_STAIR_ARRIVE &&
        pathSegmentClear(
          this.ctx.colliders,
          { x: body.px, z: body.pz },
          entry,
          BODY_RADIUS,
          body.footY,
          this.getPassable(opts),
        );
      if (entryClear || onFlight) {
        this.activeStair = { id: stair.id, up };
        this.stairPick = null;
        onStairRun = true;
        routeDest = stairRunTarget(stair, up, body.px, body.pz);
      } else {
        routeDest = entry;
      }
    }

    if (onStairRun) {
      if (opts.faceTravel) body.faceToward(routeDest.x, routeDest.z, Math.PI * 1.8 * dt);
      stepToward(body, this.ctx.colliders, routeDest.x, routeDest.z, this.stepDistance(dest, speed, dt, opts), BODY_RADIUS);
      return 'moving';
    }

    // 同一階 A* 経路探索（クールダウン付き）
    if (this.ctx.bounds) {
      const goalShifted =
        !this.pathGoal || Math.hypot(this.pathGoal.x - routeDest.x, this.pathGoal.z - routeDest.z) > 0.45;
      if (!this.pathGoal || (this.repathCd <= 0 && (goalShifted || this.path.length === 0))) {
        this.path = squadRoute(
          { x: body.px, z: body.pz },
          routeDest,
          body.footY,
          this.ctx.colliders,
          this.ctx.bounds,
          BODY_RADIUS,
          this.getPassable(opts),
        );
        this.pathGoal = { x: routeDest.x, z: routeDest.z };
        this.repathCd = this.repathInterval;
      }
    }

    // 経路上の未施錠ドア自動開放
    if (opts.canOpenDoors && this.ctx.doors) {
      const door = this.pickDoorOnPath(routeDest);
      if (door) {
        if (!door.isMoving) {
          this.openingDoorNow = true;
          try {
            door.command(door.maxAngle, false, body.px, body.pz);
          } finally {
            this.openingDoorNow = false;
          }
        }
        if (this.doorOpenTargetId === door.id) {
          this.doorOpenTimer += dt;
        } else {
          this.doorOpenTargetId = door.id;
          this.doorOpenTimer = dt;
        }
        if (this.doorOpenTimer >= NAV_DOOR_OPEN_TIMEOUT) {
          this.skippedDoors.set(door.id, NAV_SKIPPED_DOOR_TTL);
          this.doorOpenTargetId = null;
          this.doorOpenTimer = 0;
          this.doorWait = 0;
          this.pathGoal = null;
          this.path.length = 0;
        } else {
          this.doorWait = 0.15;
          return 'moving';
        }
      } else if (this.doorOpenTargetId !== null) {
        this.doorOpenTargetId = null;
        this.doorOpenTimer = 0;
        this.doorWait = 0;
      }
    }

    if (this.doorWait > 0) return 'moving';

    const next = this.path[0] ?? routeDest;
    const dNext = Math.hypot(next.x - body.px, next.z - body.pz);
    if (dNext < 0.1) {
      if (this.path.length > 0) this.path.shift();
      return 'moving';
    }

    if (opts.faceTravel) {
      body.faceToward(next.x, next.z, Math.PI * 2 * dt);
    }
    const moved = stepToward(body, this.ctx.colliders, next.x, next.z, this.stepDistance(dest, speed, dt, opts), BODY_RADIUS);
    const remaining = Math.hypot(next.x - body.px, next.z - body.pz);
    if (remaining < 0.16 && this.path.length > 0) {
      this.path.shift();
    } else if (!moved && this.stalled > 0.7) {
      this.path.length = 0;
      this.pathGoal = null;
    }
    return 'moving';
  }
}

export interface EngageOptions {
  /** true なら enter() 時に遮蔽へ退避せず、視認・射程内ならまず数発撃ち込んでから遮蔽を取る（容疑者モード SWAT 用） */
  immediateFireOnEnter?: boolean;
  /** immediateFireOnEnter で遮蔽へ移る前に撃つ発数（既定: 3） */
  immediateFireShots?: number;
  /** true を返すときは onHit() で beginRetreat() せず現在のフェーズ/前進を維持する */
  skipRetreatOnHit?: () => boolean;
}

/** ENGAGE 中の行動: 遮蔽物へ退避 → 待機/リロード → ピーク位置へ → 発砲 → 退避 …を基本とし、視認喪失時は追撃・回り込み再配置を行う。 */
export class EngageBehavior {
  private phase: Phase = 'cover';
  private ammo: number;
  private timer = 0;
  private shots = 0;
  private fireCd = 0;
  private flinch = 0;
  private moveTime = 0;
  private lostSightSec = 0;
  private repositionGoal: Vec3 | null = null;
  private repositionTimer = 0;
  private burstLimit: number | null = null;
  private spot: CoverSpot | null = null;
  private peekTarget: XZ | null = null;
  /** 待ち伏せ（pre-aim）: 次の enter() で遮蔽へ退避せず即射撃する発数（0=無効） */
  private preAimShots = 0;
  private preAimSpreadMul = 1;
  /** 初弾バーストの残り発数（この間は拡散を preAimSpreadMul 倍にする） */
  private spreadBurstLeft = 0;
  private readonly ray = new THREE.Ray();
  private readonly tmpBox = new THREE.Box3();
  private readonly tmpHit = new THREE.Vector3();
  private readonly shotOrigin = new THREE.Vector3();
  private readonly shotDir = new THREE.Vector3();
  private readonly localRay = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly forwardAxis = new THREE.Vector3(0, 0, -1);

  constructor(
    private readonly p: CombatParams,
    private readonly id: string,
    private readonly body: HumanoidBody,
    private readonly bus: GameEventBus,
    private readonly ctx: CombatContext,
    private readonly hasWarned: () => boolean,
    private readonly mobility: MobilityParams | null = null,
    private readonly nav: SuspectNavigator | null = null,
    private readonly opts: EngageOptions = {},
  ) {
    this.ammo = p.magazineSize;
  }

  get label(): string {
    return this.flinch > 0 ? 'flinch' : this.phase;
  }

  /** 残弾。制圧射撃などの外部発砲側が弾切れを判断するために使う */
  get ammoLeft(): number {
    return this.ammo;
  }

  /**
   * 待ち伏せ用: 次の enter() で、視認・射程内なら遮蔽へ退避せずその場で shots 発まず撃ち込み、
   * その間の拡散角を spreadMul 倍にする（ファタルファネルの初弾）。enter() で一度だけ消費される。
   */
  armPreAim(shots: number, spreadMul: number): void {
    this.preAimShots = Math.max(1, Math.floor(shots));
    this.preAimSpreadMul = spreadMul;
  }

  /** ENGAGE に入った。弾切れなら遮蔽でリロード、そうでなければ遮蔽へ退避→ピーク。 */
  enter(known: Vec3 | null): void {
    const preAimShots = this.preAimShots;
    const preAimMul = this.preAimSpreadMul;
    this.preAimShots = 0;
    this.preAimSpreadMul = 1;
    this.spreadBurstLeft = 0;
    this.lostSightSec = 0;
    this.repositionGoal = null;
    this.repositionTimer = 0;
    this.burstLimit = null;
    this.nav?.reset();
    if ((this.opts.immediateFireOnEnter || preAimShots > 0) && known && this.ammo > 0 && this.inRange(known)) {
      const selfPos = { x: this.body.px, z: this.body.pz };
      const chestY = this.body.footY + STAND_CHEST;
      const visible =
        this.seesFrom(selfPos, known, chestY) ||
        hasLineOfSight(
          this.ctx.colliders,
          { x: known.x, y: known.y + CROUCH_CHEST, z: known.z },
          { x: this.body.px, y: chestY, z: this.body.pz },
        );
      if (visible) {
        this.spot = null;
        this.peekTarget = null;
        this.body.setPose('stand');
        this.body.faceToward(known.x, known.z);
        this.phase = 'peek';
        const want = Math.max(1, preAimShots > 0 ? preAimShots : (this.opts.immediateFireShots ?? 3));
        this.burstLimit = Math.min(want, Math.max(this.p.shotsPerPeek, preAimShots));
        if (preAimShots > 0) {
          this.spreadBurstLeft = this.burstLimit;
          this.preAimSpreadMul = preAimMul;
        }
        this.timer = Math.min(this.p.peekSecMax, this.p.fireInterval * (this.burstLimit + 1));
        this.shots = 0;
        this.fireCd = 0;
        return;
      }
    }
    this.beginRetreat(known);
  }

  exit(): void {
    this.body.setFlash(false);
    this.body.setPose('stand');
    this.flinch = 0;
    this.lostSightSec = 0;
    this.repositionGoal = null;
    this.repositionTimer = 0;
    this.burstLimit = null;
    this.nav?.reset();
  }

  /** 被弾: 怯んで遮蔽物へ退避する（skipRetreatOnHit が true のときは現在の行動を維持）。 */
  onHit(known: Vec3 | null): void {
    this.flinch = this.p.flinchSec;
    if (this.flinch > 0) this.body.setFlash(true);
    this.lostSightSec = 0;
    if (this.opts.skipRetreatOnHit?.()) {
      return;
    }
    this.burstLimit = null;
    this.repositionGoal = null;
    this.nav?.reset();
    this.beginRetreat(known);
  }

  update(dt: number, known: Vec3 | null, sees: boolean, threat: CombatThreat | null = null): void {
    if (this.flinch > 0) {
      this.flinch -= dt;
      if (this.flinch <= 0) this.body.setFlash(false);
      return;
    }

    if (sees) {
      this.lostSightSec = 0;
      // 追撃・回り込み中に脅威を再視認したら即座に射撃姿勢へ
      if (this.phase === 'advance' || this.phase === 'flank') {
        this.repositionGoal = null;
        this.burstLimit = null;
        this.nav?.reset();
        if (this.ammo > 0 && this.inRange(known)) {
          this.phase = 'peek';
          this.timer = this.p.peekSecMax;
          this.shots = 0;
          this.fireCd = this.p.fireInterval * FIRE_DELAY_FACTOR;
        } else {
          this.beginRetreat(known);
        }
      }
    } else {
      this.lostSightSec += dt;
    }

    // 視認喪失が一定時間続いたら同一遮蔽ピーク反復を打ち切り、追撃または回り込み再配置へ
    if (
      !sees &&
      known &&
      this.mobility &&
      this.nav &&
      this.ammo > 0 &&
      this.lostSightSec >= this.mobility.repositionAfterLostSec &&
      (this.phase === 'cover' || this.phase === 'peek' || this.phase === 'toPeek')
    ) {
      this.beginReposition(known);
    }

    if (known && this.phase !== 'advance' && this.phase !== 'flank') {
      this.body.faceToward(known.x, known.z);
    }

    switch (this.phase) {
      case 'toCover':
        if (this.moveTo(this.spot?.hide ?? null, dt)) this.arriveCover();
        break;
      case 'cover':
        this.timer -= dt;
        if (this.ammo <= 0) {
          this.phase = 'reload';
          this.timer = this.p.reloadSec;
        } else if (this.timer <= 0) {
          this.beginPeek(known);
        }
        break;
      case 'reload':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.ammo = this.p.magazineSize;
          this.phase = 'cover';
          this.timer = 0.2;
        }
        break;
      case 'toPeek':
        if (this.moveTo(this.peekTarget, dt)) {
          this.phase = 'peek';
          this.timer = this.p.peekSecMax;
          this.shots = 0;
          this.fireCd = this.p.fireInterval * FIRE_DELAY_FACTOR;
        }
        break;
      case 'peek': {
        this.timer -= dt;
        this.fireCd -= dt;
        if (this.burstLimit !== null && !sees) {
          this.burstLimit = null;
          this.beginRetreat(known);
          break;
        }
        if (sees && this.fireCd <= 0 && this.ammo > 0 && this.inRange(known)) this.fire(threat, known);
        const maxShots = this.burstLimit ?? this.p.shotsPerPeek;
        if (this.shots >= maxShots || this.ammo <= 0 || this.timer <= 0) {
          this.burstLimit = null;
          this.beginRetreat(known);
        }
        break;
      }
      case 'advance':
      case 'flank':
        this.updateReposition(dt, known);
        break;
    }
  }

  private beginReposition(known: Vec3): void {
    const mob = this.mobility;
    if (!mob || !this.nav) return;
    this.nav.reset();
    this.body.setPose('stand');
    this.repositionTimer = 0;

    if (Math.random() < mob.flankChance) {
      const flankPt = this.findFlankTarget(known, mob);
      if (flankPt) {
        this.phase = 'flank';
        this.repositionGoal = flankPt;
        return;
      }
    }
    this.phase = 'advance';
    this.repositionGoal = { x: known.x, y: known.y, z: known.z };
  }

  private updateReposition(dt: number, known: Vec3 | null): void {
    if (!this.repositionGoal || !this.nav || !this.mobility) {
      this.lostSightSec = 0;
      this.beginRetreat(known);
      return;
    }
    this.repositionTimer += dt;
    // advance 中に音イベント等で known が更新されたら追従先を更新
    if (
      this.phase === 'advance' &&
      known &&
      (Math.hypot(known.x - this.repositionGoal.x, known.z - this.repositionGoal.z) > 1.0 ||
        Math.abs(known.y - this.repositionGoal.y) > 0.75)
    ) {
      this.repositionGoal = { x: known.x, y: known.y, z: known.z };
    }
    const res = this.nav.step(this.repositionGoal, this.p.moveSpeed, dt, {
      canOpenDoors: this.mobility.canOpenDoors,
      canUseStairs: this.mobility.canUseStairs,
      faceTravel: true,
      arriveDist: this.phase === 'advance' ? 2.2 : 1.0,
    });
    if (res !== 'moving' || this.repositionTimer >= 10) {
      this.repositionGoal = null;
      this.lostSightSec = 0;
      this.nav.reset();
      this.beginRetreat(known);
    }
  }

  /** 別角度・隣接部屋への回り込み先を探索する。見つからなければ null（呼び出し側で advance へフォールバック）。 */
  private findFlankTarget(known: Vec3, mob: MobilityParams): Vec3 | null {
    const px = this.body.px;
    const pz = this.body.pz;
    const fy = this.body.footY;
    const dx = known.x - px;
    const dz = known.z - pz;
    const baseDist = Math.hypot(dx, dz);
    const baseAng = Math.atan2(dz, dx);

    const candidates: Vec3[] = [];
    // 1. 隣接する別室（同じ階、または canUseStairs なら known の階）
    if (this.ctx.rooms) {
      for (const r of this.ctx.rooms) {
        if (r.outdoor) continue;
        const rfy = r.floorY ?? 0;
        const sameCurFloor = Math.abs(rfy - fy) <= 0.65;
        const sameKnownFloor = Math.abs(rfy - known.y) <= 0.65;
        if (!sameCurFloor && !(mob.canUseStairs && sameKnownFloor)) continue;
        const inCurRoom =
          sameCurFloor && Math.abs(px - r.x) <= r.width / 2 && Math.abs(pz - r.z) <= r.depth / 2;
        if (inCurRoom) continue;
        const distFromSelf = Math.hypot(r.x - px, r.z - pz);
        const distFromKnown = Math.hypot(r.x - known.x, r.z - known.z);
        if (distFromSelf < 2.2 || distFromSelf > 14 || distFromKnown > 14) continue;
        if (!blockedAtFiltered(this.ctx.colliders, r.x, r.z, BODY_RADIUS, rfy)) {
          candidates.push({ x: r.x, y: rfy, z: r.z });
        }
      }
    }

    // 2. 同一階で脅威に対して左右 65°〜105° ずらした別角度地点
    const sideSign = Math.random() < 0.5 ? 1 : -1;
    for (const s of [sideSign, -sideSign]) {
      for (const deg of [75, 105, 55]) {
        const ang = baseAng + s * deg * (Math.PI / 180);
        for (const dist of [Math.min(6.5, Math.max(3.2, baseDist * 0.75)), 4.0]) {
          const cx = px + Math.cos(ang) * dist;
          const cz = pz + Math.sin(ang) * dist;
          if (!blockedAtFiltered(this.ctx.colliders, cx, cz, BODY_RADIUS, fy)) {
            candidates.push({ x: cx, y: fy, z: cz });
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    // 脅威へ近づきすぎず、かつ現在位置から十分離れた候補を選ぶ
    candidates.sort((a, b) => {
      const da = Math.abs(Math.hypot(a.x - known.x, a.z - known.z) - 5.5);
      const db = Math.abs(Math.hypot(b.x - known.x, b.z - known.z) - 5.5);
      return da - db;
    });
    return candidates[0] ?? null;
  }

  private inRange(known: Vec3 | null): boolean {
    if (!known) return false;
    return Math.hypot(known.x - this.body.px, known.z - this.body.pz) <= this.p.engageRange;
  }

  /** 実弾レイキャストを伴う発砲（プレイヤー・隊員双方に被弾判定を行う）。 */
  fireAt(threat: CombatThreat | null, known: Vec3 | null): void {
    this.fire(threat, known);
  }

  private fire(threat: CombatThreat | null, known: Vec3 | null): void {
    this.ammo--;
    this.shots++;
    this.fireCd = this.p.fireInterval;
    this.body.showMuzzleFlash(MUZZLE_SEC);
    const pos = { x: this.body.px, y: this.body.footY + STAND_CHEST, z: this.body.pz };
    this.bus.emit('suspectFired', { id: this.id, pos, warned: this.hasWarned() });
    this.bus.emit('shotFired', { shooter: this.id, pos });
    this.bus.emit('noise', { pos, radius: this.p.gunshotNoiseRadius, kind: 'gunshot', source: 'suspect' });

    const aimTarget = threat?.point ?? (known ? { x: known.x, y: known.y + STAND_CHEST, z: known.z } : null);
    if (!aimTarget || this.p.shotDamage <= 0) return;

    this.shotOrigin.set(pos.x, pos.y, pos.z);
    this.shotDir.set(aimTarget.x - pos.x, aimTarget.y - pos.y, aimTarget.z - pos.z);
    if (this.shotDir.lengthSq() < 1e-6) return;
    this.shotDir.normalize();

    const spreadMul = this.spreadBurstLeft > 0 ? this.preAimSpreadMul : 1;
    if (this.spreadBurstLeft > 0) this.spreadBurstLeft--;
    const spreadRad = this.p.baseSpreadDeg * spreadMul * (Math.PI / 180);
    const angle = Math.acos(1 - Math.random() * (1 - Math.cos(spreadRad)));
    const around = Math.random() * Math.PI * 2;
    this.localRay.set(
      Math.sin(angle) * Math.cos(around),
      Math.sin(angle) * Math.sin(around),
      -Math.cos(angle),
    );
    this.quat.setFromUnitVectors(this.forwardAxis, this.shotDir);
    this.localRay.applyQuaternion(this.quat).normalize();

    this.ray.set(this.shotOrigin, this.localRay);
    let bestT = raycastColliders(this.ctx.colliders, this.shotOrigin, this.localRay, this.p.engageRange);
    let hitKind: 'wall' | 'player' | 'ally' = 'wall';
    let hitAllyId = '';

    if (!this.ctx.ignorePlayer && this.ctx.player.alive !== false && this.ctx.player.getBodyBounds) {
      const d = this.rayDist(this.ctx.player.getBodyBounds());
      if (d !== null && d < bestT) {
        bestT = d;
        hitKind = 'player';
      }
    }

    if (this.ctx.allies) {
      const allies = this.ctx.allies();
      for (let i = 0; i < allies.length; i++) {
        const a = allies[i]!;
        const d = this.rayDist(a.getAABB());
        if (d !== null && d < bestT) {
          if (a.shieldBlocks) {
            this.ray.at(d, this.tmpHit);
            if (a.shieldBlocks(pos, this.tmpHit)) {
              bestT = d;
              hitKind = 'wall';
              hitAllyId = '';
              continue;
            }
          }
          bestT = d;
          hitKind = 'ally';
          hitAllyId = a.id;
        }
      }
    }

    if (hitKind === 'wall' && bestT < this.p.engageRange) {
      this.ray.at(bestT, this.tmpHit);
      this.bus.emit('bulletImpact', { shooter: this.id, pos: { x: this.tmpHit.x, y: this.tmpHit.y, z: this.tmpHit.z }, damage: this.p.shotDamage });
    }
    if (hitKind === 'player') {
      this.ray.at(bestT, this.tmpHit);
      this.ctx.playerDamage?.(this.p.shotDamage, pos, this.id, this.tmpHit.y);
    } else if (hitKind === 'ally' && hitAllyId) {
      this.ray.at(bestT, this.tmpHit);
      this.bus.emit('entityHit', {
        targetId: hitAllyId,
        shooter: this.id,
        damage: this.p.shotDamage,
        pos: { x: this.tmpHit.x, y: this.tmpHit.y, z: this.tmpHit.z },
        weaponId: 'suspect_rifle',
      });
    }
  }

  private rayDist(a: AABB): number | null {
    this.tmpBox.min.set(a.min.x, a.min.y, a.min.z);
    this.tmpBox.max.set(a.max.x, a.max.y, a.max.z);
    const hit = this.ray.intersectBox(this.tmpBox, this.tmpHit);
    return hit ? this.tmpHit.distanceTo(this.ray.origin) : null;
  }

  private beginRetreat(known: Vec3 | null): void {
    this.burstLimit = null;
    this.spot = known ? this.findCover(known) : null;
    this.moveTime = 0;
    if (this.spot) {
      this.phase = 'toCover';
      this.body.setPose('stand');
    } else {
      this.arriveCover();
    }
  }

  private arriveCover(): void {
    this.phase = 'cover';
    this.timer = this.p.coverSecMin + Math.random() * (this.p.coverSecMax - this.p.coverSecMin);
    this.body.setPose(this.spot?.crouch ? 'crouch' : 'stand');
  }

  private beginPeek(known: Vec3 | null): void {
    this.burstLimit = null;
    this.body.setPose('stand');
    this.peekTarget = this.choosePeek(known);
    this.moveTime = 0;
    this.phase = 'toPeek';
  }

  /** 目標へ移動。到達 or 時間切れ/詰まりで true。target=null は即到達。 */
  private moveTo(target: XZ | null, dt: number): boolean {
    if (!target) return true;
    this.moveTime += dt;
    if (Math.hypot(target.x - this.body.px, target.z - this.body.pz) <= ARRIVE_DIST) return true;
    const moved = stepToward(this.body, this.ctx.colliders, target.x, target.z, this.p.moveSpeed * dt);
    return !moved || this.moveTime > MAX_MOVE_SEC;
  }

  /** ピーク位置の選択: 遮蔽の裏で立ち上がる → 左 → 右 の順で、最初に射線が通る点。無ければ裏のまま。 */
  private choosePeek(known: Vec3 | null): XZ | null {
    if (!this.spot) return null;
    if (!known) return this.spot.hide;
    for (const c of this.spot.peek) {
      if (this.seesFrom(c, known, this.body.footY + STAND_CHEST)) return c;
    }
    return this.spot.hide;
  }

  private playerEyeAt(known: Vec3): { x: number; y: number; z: number } {
    return { x: known.x, y: known.y + FALLBACK_PLAYER_EYE_Y, z: known.z };
  }

  private seesFrom(at: XZ, known: Vec3, chestY: number): boolean {
    return hasLineOfSight(this.ctx.colliders, this.playerEyeAt(known), { x: at.x, y: chestY, z: at.z });
  }

  /** 最後に把握したプレイヤー位置から射線が切れる最寄りの遮蔽物の裏を探す。 */
  private findCover(known: Vec3): CoverSpot | null {
    const range = this.p.coverSearchRange;
    if (range <= 0) return null;
    const m = this.p.coverMargin;
    const px = this.body.px;
    const pz = this.body.pz;
    const feetY = this.body.footY;
    const pad = Math.max(2, m + 0.5);
    const near = collidersNear(this.ctx.colliders, px - range - pad, pz - range - pad, px + range + pad, pz + range + pad);
    coverScratch.length = 0;
    for (let i = 0; i < near.length; i++) {
      const c = near[i]!;
      if (c.kind !== 'cover') continue;
      const a = c.aabb;
      if (a.min.y > feetY + 1.2 || a.max.y < feetY + 0.25) continue;
      if (
        a.max.x + m < px - range ||
        a.min.x - m > px + range ||
        a.max.z + m < pz - range ||
        a.min.z - m > pz + range
      ) {
        continue;
      }
      coverScratch.push(c);
    }

    let best: CoverSpot | null = null;
    let bestD = Infinity;
    const candTmp: XZ = { x: 0, z: 0 };
    for (let i = 0; i < coverScratch.length; i++) {
      const a = coverScratch[i]!.aabb;
      const cx = (a.min.x + a.max.x) / 2;
      const cz = (a.min.z + a.max.z) / 2;
      const hx = (a.max.x - a.min.x) / 2;
      const hz = (a.max.z - a.min.z) / 2;
      const crouch = a.max.y - feetY < this.p.crouchCoverMaxHeight;
      const chestY = feetY + (crouch ? CROUCH_CHEST : STAND_CHEST);
      for (let k = 0; k < 8; k++) {
        const xOff = k === 0 || k === 4 || k === 6 ? hx + m : k === 1 || k === 5 || k === 7 ? -(hx + m) : 0;
        const zOff = k === 2 || k === 4 || k === 5 ? hz + m : k === 3 || k === 6 || k === 7 ? -(hz + m) : 0;
        const hxPos = cx + xOff;
        const hzPos = cz + zOff;
        const d = Math.hypot(hxPos - px, hzPos - pz);
        if (d > range || d >= bestD) continue;
        if (blockedAt(this.ctx.colliders, hxPos, hzPos, BODY_RADIUS, feetY)) continue;
        candTmp.x = hxPos;
        candTmp.z = hzPos;
        if (this.seesFrom(candTmp, known, chestY)) continue; // プレイヤーから隠れていない
        if (!this.pathClear(px, pz, hxPos, hzPos)) continue;
        bestD = d;
        const hide: XZ = { x: hxPos, z: hzPos };
        best = { hide, crouch, peek: this.peekCandidates(hide, known, hx, hz, m) };
      }
    }
    return best;
  }

  /** 遮蔽の縁を回り込む左右のピーク候補（隠れ位置→プレイヤー方向に直交）。 */
  private peekCandidates(hide: XZ, known: XZ, hx: number, hz: number, m: number): XZ[] {
    const dx = known.x - hide.x;
    const dz = known.z - hide.z;
    const l = Math.hypot(dx, dz) || 1;
    const lx = -dz / l;
    const lz = dx / l;
    const ext = Math.abs(lx) * hx + Math.abs(lz) * hz + m;
    const out: XZ[] = [hide];
    for (const s of [1, -1]) {
      const p = { x: hide.x + lx * s * ext, z: hide.z + lz * s * ext };
      if (!blockedAt(this.ctx.colliders, p.x, p.z, BODY_RADIUS, this.body.footY)) out.push(p);
    }
    return out;
  }

  /** 直線経路が壁等に遮られないか（半径分の余裕を含めサンプリング）。 */
  private pathClear(x0: number, z0: number, x1: number, z1: number): boolean {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(d / 0.25));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (blockedAt(this.ctx.colliders, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, BODY_RADIUS, this.body.footY)) return false;
    }
    return true;
  }
}
