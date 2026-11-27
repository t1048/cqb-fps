import type { Cell } from '../ai/Squad';
import type { BoxDef, MapData } from '../core/types';
import type { PlayerController } from '../player/PlayerController';
import type { DoorStage, DoorSystem } from '../world/Door';
import { getLocale, t, tRoomName } from '../core/i18n';

const DEG2RAD = Math.PI / 180;
const MAX_DT = 0.05;
const DEFAULT_DOOR_WIDTH = 1.2;
const MINIMAP_SIZE = 180;
/** 左上ミニマップ（非拡大時）に表示する自機周辺の範囲（m、一辺） */
const LOCAL_VIEW_SPAN_M = 20;
/** 自機周辺表示用の静的レイヤ（マップ全体を拡大描画）の一辺上限（デバイス px） */
const LOCAL_STATIC_MAX_PX = 4096;
/** 部屋 floorY を同一階とみなす許容差(m)（ブリーフィングの旧タブ生成と同値） */
const FLOOR_GROUP_TOLERANCE = 1.5;
/** 階切替のヒステリシス幅(m)。隣接階の中点を この半分だけ越えるまで現在階を保持する */
const FLOOR_SWITCH_HYSTERESIS = 0.3;

export interface ActiveFloor {
  /** スナップ後の床高さ（floorLevels のいずれか） */
  floorY: number;
  /** 表示名（B1 / 1F / 2F …） */
  label: string;
}

/** マップの部屋 floorY から離散階層を昇順で抽出（許容差内は同一階）。 */
export function collectFloorLevels(map: MapData): number[] {
  const levels: number[] = [];
  for (const r of map.rooms) {
    const fy = Math.round((r.floorY ?? 0) * 10) / 10;
    if (!levels.some((v) => Math.abs(v - fy) < FLOOR_GROUP_TOLERANCE)) levels.push(fy);
  }
  levels.sort((a, b) => a - b);
  return levels;
}

function nearestFloorIndex(y: number, floorLevels: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < floorLevels.length; i++) {
    if (Math.abs(floorLevels[i] - y) < Math.abs(floorLevels[best] - y)) best = i;
  }
  return best;
}

/** 階の表示名: y=0 に最も近い階を 1F とし、下へ B1, B2…、上へ 2F, 3F…。 */
export function floorLabelAt(index: number, floorLevels: readonly number[]): string {
  const ground = nearestFloorIndex(0, floorLevels);
  return index < ground ? `B${ground - index}` : `${index - ground + 1}F`;
}

/**
 * 高さ y を離散階層へスナップする（設計書 §3.1 resolveActiveFloor）。
 * prevFloorY を渡すと、最近傍階が変わっても |y - 新階| + ヒステリシス < |y - 旧階| になるまで旧階を保持し、
 * 階段の中点付近で表示が往復しない。描画の floorY と表示名に同じ戻り値を使うこと。
 * floorLevels は昇順・空でないこと（空のときは y をそのまま返し label は空文字）。
 */
export function resolveActiveFloor(y: number, floorLevels: readonly number[], prevFloorY?: number): ActiveFloor {
  if (floorLevels.length === 0) return { floorY: y, label: '' };
  let idx = nearestFloorIndex(y, floorLevels);
  if (prevFloorY !== undefined) {
    const prevIdx = nearestFloorIndex(prevFloorY, floorLevels);
    if (
      prevIdx !== idx &&
      Math.abs(floorLevels[prevIdx] - prevFloorY) < 1e-6 &&
      Math.abs(y - floorLevels[idx]) + FLOOR_SWITCH_HYSTERESIS >= Math.abs(y - floorLevels[prevIdx])
    ) {
      idx = prevIdx;
    }
  }
  return { floorY: floorLevels[idx], label: floorLabelAt(idx, floorLevels) };
}

export interface FloorPlanDoorState {
  id: string;
  angle: number;
  maxAngle: number;
  stage: DoorStage;
  locked: boolean;
}

export interface FloorPlanPlayerState {
  x: number;
  z: number;
  /** PlayerController.yawRad（0 = -Z 方向、forward = (-sin(yaw), -cos(yaw))） */
  yawRad: number;
}

export interface FloorPlanAllyState {
  name: string;
  x: number;
  z: number;
  y: number;
  yawRad: number;
  down: boolean;
}

export interface FloorPlanWaypoint {
  label: string;
  x: number;
  z: number;
  y: number;
  color: string;
}

/** オプティワンド等で確認した接触（最後に確認した位置）。threat=武装容疑者, civilian=民間人, unarmed=無力化済み/投降 */
export interface FloorPlanContact {
  x: number;
  y: number;
  z: number;
  kind: 'threat' | 'civilian' | 'unarmed';
}

/** プレイヤー・隊員の視界やオプティワンド等で確認した敵（赤点で表示、時間で消える） */
export interface FloorPlanEnemy {
  x: number;
  y: number;
  z: number;
  /** 0〜1。見失ってから時間が経つほど薄くなる（省略時 1） */
  alpha?: number;
}

/** 人質処刑の脅迫中に人質の位置で脈打つ警告（progress 0〜1 でカウントダウン） */
export interface FloorPlanPulse {
  x: number;
  y: number;
  z: number;
  progress: number;
}

export interface DrawFloorPlanOptions {
  coverage?: readonly Cell[];
  /** 論理描画幅(px)。省略時は canvas.width */
  width?: number;
  /** 論理描画高(px)。省略時は canvas.height */
  height?: number;
  /** 外周余白(px) */
  padding?: number;
  /** 部屋名ラベルを表示するか（既定 true） */
  showRoomLabels?: boolean;
  /** ウェイポイント名・隊員頭文字のラベルを表示するか（既定 true） */
  showMarkerLabels?: boolean;
  /** 侵入地点(playerSpawn)マーカーを表示するか（ブリーフィング向け、既定 false） */
  showSpawn?: boolean;
  /** リアルタイムのプレイヤー位置・向き（ミニマップ向け） */
  player?: FloorPlanPlayerState;
  /** リアルタイムの隊員位置・向き */
  allies?: readonly FloorPlanAllyState[];
  /** 指示された移動・警戒ポイント */
  waypoints?: readonly FloorPlanWaypoint[];
  /** スカウト（オプティワンド/ミラー）で確認した接触マーカー */
  contacts?: readonly FloorPlanContact[];
  /** 警告パルス（人質処刑の脅迫）。time は点滅用の秒 */
  pulses?: readonly FloorPlanPulse[];
  /** 現在視界内の敵（赤点） */
  enemies?: readonly FloorPlanEnemy[];
  time?: number;
  /** ドア ID → リアルタイム開閉状態（省略時は静的定義から closed/locked を描画） */
  doors?: ReadonlyMap<string, FloorPlanDoorState>;
  /** コンパクト表示（ミニマップ用） */
  compact?: boolean;
  /** 指定時はこの床高さの部屋・壁・ドアだけ描く */
  floorY?: number;
  /** 背景色（省略時は透明クリア） */
  background?: string;
}

const ROOM_TINTS = [
  'rgba(58, 82, 108, 0.24)',
  'rgba(46, 68, 92, 0.24)',
  'rgba(66, 90, 114, 0.24)',
  'rgba(52, 76, 98, 0.24)',
] as const;

interface Bounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface PlanTransform {
  cw: number;
  ch: number;
  scale: number;
  toX: (wx: number) => number;
  toY: (wz: number) => number;
}

const mapBoundsCache = new WeakMap<MapData, Bounds2D>();

function boxNearFloor(box: BoxDef, floorY: number | undefined): boolean {
  if (floorY === undefined) return true;
  const base = box.y ?? 0;
  const mid = base + box.height * 0.5;
  return Math.abs(mid - (floorY + 1.25)) < 1.65;
}

function expandBoxBounds(bounds: Bounds2D, box: BoxDef): void {
  const rad = (box.yaw ?? 0) * DEG2RAD;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const hx = (box.width * c + box.depth * s) / 2;
  const hz = (box.width * s + box.depth * c) / 2;
  if (box.x - hx < bounds.minX) bounds.minX = box.x - hx;
  if (box.x + hx > bounds.maxX) bounds.maxX = box.x + hx;
  if (box.z - hz < bounds.minZ) bounds.minZ = box.z - hz;
  if (box.z + hz > bounds.maxZ) bounds.maxZ = box.z + hz;
}

function computeMapBounds(map: MapData): Bounds2D {
  const cached = mapBoundsCache.get(map);
  if (cached) return cached;
  const bounds: Bounds2D = {
    minX: -map.floor.width / 2,
    maxX: map.floor.width / 2,
    minZ: -map.floor.depth / 2,
    maxZ: map.floor.depth / 2,
  };
  for (const w of map.walls) expandBoxBounds(bounds, w);
  for (const c of map.covers) expandBoxBounds(bounds, c);
  for (const r of map.rooms) {
    if (r.x - r.width / 2 < bounds.minX) bounds.minX = r.x - r.width / 2;
    if (r.x + r.width / 2 > bounds.maxX) bounds.maxX = r.x + r.width / 2;
    if (r.z - r.depth / 2 < bounds.minZ) bounds.minZ = r.z - r.depth / 2;
    if (r.z + r.depth / 2 > bounds.maxZ) bounds.maxZ = r.z + r.depth / 2;
  }
  mapBoundsCache.set(map, bounds);
  return bounds;
}

function computePlanTransform(map: MapData, cw: number, ch: number, pad: number): PlanTransform {
  const bounds = computeMapBounds(map);
  const worldW = Math.max(0.1, bounds.maxX - bounds.minX);
  const worldD = Math.max(0.1, bounds.maxZ - bounds.minZ);
  const availW = Math.max(1, cw - pad * 2);
  const availH = Math.max(1, ch - pad * 2);
  const scale = Math.min(availW / worldW, availH / worldD);
  const offsetX = (cw - worldW * scale) / 2;
  const offsetY = (ch - worldD * scale) / 2;
  return {
    cw,
    ch,
    scale,
    toX: (wx: number): number => offsetX + (wx - bounds.minX) * scale,
    toY: (wz: number): number => offsetY + (wz - bounds.minZ) * scale,
  };
}

/** 自機中心のローカル表示用の座標変換（scale 固定、(cx, cz) をビュー中央へ置く）。 */
function computeCenteredTransform(cw: number, ch: number, scale: number, cx: number, cz: number): PlanTransform {
  return {
    cw,
    ch,
    scale,
    toX: (wx: number): number => cw / 2 + (wx - cx) * scale,
    toY: (wz: number): number => ch / 2 + (wz - cz) * scale,
  };
}

/** マップ全体を指定 scale で描くための静的レイヤ用座標変換（左上に pad の余白）。 */
function computeFullScaleTransform(map: MapData, scale: number, pad: number): PlanTransform {
  const bounds = computeMapBounds(map);
  const cw = Math.ceil(Math.max(0.1, bounds.maxX - bounds.minX) * scale + pad * 2);
  const ch = Math.ceil(Math.max(0.1, bounds.maxZ - bounds.minZ) * scale + pad * 2);
  return {
    cw,
    ch,
    scale,
    toX: (wx: number): number => pad + (wx - bounds.minX) * scale,
    toY: (wz: number): number => pad + (wz - bounds.minZ) * scale,
  };
}

function drawRotatedBox(
  ctx: CanvasRenderingContext2D,
  box: BoxDef,
  toX: (wx: number) => number,
  toY: (wz: number) => number,
  scale: number,
  fill: string,
  stroke?: string,
): void {
  const cx = toX(box.x);
  const cy = toY(box.z);
  const w = Math.max(1.5, box.width * scale);
  const h = Math.max(1.5, box.depth * scale);
  ctx.save();
  ctx.translate(cx, cy);
  if (box.yaw) ctx.rotate(-box.yaw * DEG2RAD);
  ctx.fillStyle = fill;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

/** 静的な間取りレイヤ（背景・2m グリッド・部屋・遮蔽物・階段・壁・静的部屋名ラベル）を描画する。 */
function drawStaticFloorPlan(
  ctx: CanvasRenderingContext2D,
  map: MapData,
  xf: PlanTransform,
  options: DrawFloorPlanOptions,
): void {
  const { cw, ch, scale, toX, toY } = xf;
  const compact = options.compact ?? false;
  const showRoomLabels = options.showRoomLabels ?? true;

  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, cw, ch);
  } else {
    ctx.clearRect(0, 0, cw, ch);
  }

  // 床ベース
  const fx = toX(-map.floor.width / 2);
  const fy = toY(-map.floor.depth / 2);
  const fw = map.floor.width * scale;
  const fh = map.floor.depth * scale;
  ctx.fillStyle = '#141c26';
  ctx.fillRect(fx, fy, fw, fh);

  // 薄い戦術グリッド（2m 間隔）
  ctx.save();
  ctx.beginPath();
  ctx.rect(fx, fy, fw, fh);
  ctx.clip();
  ctx.strokeStyle = 'rgba(120, 155, 195, 0.08)';
  ctx.lineWidth = 1;
  const gridStep = 2;
  const startX = Math.ceil(-map.floor.width / 2 / gridStep) * gridStep;
  const startZ = Math.ceil(-map.floor.depth / 2 / gridStep) * gridStep;
  ctx.beginPath();
  for (let gx = startX; gx < map.floor.width / 2; gx += gridStep) {
    const px = toX(gx);
    ctx.moveTo(px, fy);
    ctx.lineTo(px, fy + fh);
  }
  for (let gz = startZ; gz < map.floor.depth / 2; gz += gridStep) {
    const py = toY(gz);
    ctx.moveTo(fx, py);
    ctx.lineTo(fx + fw, py);
  }
  ctx.stroke();
  ctx.restore();

  // 部屋（屋内外を明確に区別）
  map.rooms.forEach((room, idx) => {
    if (options.floorY !== undefined && Math.abs((room.floorY ?? 0) - options.floorY) > 1.3) return;
    const rx = toX(room.x - room.width / 2);
    const ry = toY(room.z - room.depth / 2);
    const rw = room.width * scale;
    const rh = room.depth * scale;
    ctx.fillStyle = room.outdoor ? 'rgba(42, 66, 56, 0.20)' : (ROOM_TINTS[idx % ROOM_TINTS.length] ?? ROOM_TINTS[0]);
    ctx.fillRect(rx, ry, rw, rh);
    ctx.save();
    if (room.outdoor) ctx.setLineDash([3, 3]);
    ctx.strokeStyle = room.outdoor ? 'rgba(110, 165, 130, 0.22)' : 'rgba(130, 165, 200, 0.16)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.restore();
  });

  // 遮蔽物
  for (const cover of map.covers) {
    if (!boxNearFloor(cover, options.floorY)) continue;
    drawRotatedBox(ctx, cover, toX, toY, scale, 'rgba(150, 118, 86, 0.72)', 'rgba(205, 174, 138, 0.55)');
  }

  // 階段
  for (const stair of map.stairs) {
    const lowY = stair.y ?? 0;
    const highY = lowY + stair.steps * stair.rise;
    if (options.floorY !== undefined && (options.floorY < lowY - 1.4 || options.floorY > highY + 1.4)) continue;
    const total = stair.steps * stair.run;
    const yawRad = stair.yaw * DEG2RAD;
    ctx.save();
    ctx.translate(toX(stair.x), toY(stair.z));
    ctx.rotate(-yawRad);
    const sw = stair.width * scale;
    const sd = total * scale;
    ctx.fillStyle = 'rgba(130, 100, 68, 0.35)';
    ctx.fillRect(-sw / 2, -sd / 2, sw, sd);
    ctx.strokeStyle = 'rgba(218, 184, 140, 0.72)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-sw / 2, -sd / 2, sw, sd);
    ctx.beginPath();
    const treadCount = Math.min(stair.steps, 12);
    for (let i = 1; i < treadCount; i++) {
      const y = -sd / 2 + (sd * i) / treadCount;
      ctx.moveTo(-sw / 2, y);
      ctx.lineTo(sw / 2, y);
    }
    // 上り方向 (-Zローカル = canvas上方向) 矢印
    ctx.moveTo(0, sd * 0.25);
    ctx.lineTo(0, -sd * 0.25);
    ctx.moveTo(-sw * 0.22, -sd * 0.12);
    ctx.lineTo(0, -sd * 0.25);
    ctx.lineTo(sw * 0.22, -sd * 0.12);
    ctx.stroke();
    ctx.restore();
  }

  // 壁
  for (const wall of map.walls) {
    if (!boxNearFloor(wall, options.floorY)) continue;
    drawRotatedBox(ctx, wall, toX, toY, scale, '#9db2c8');
  }

  // 部屋名ラベル（壁や遮蔽の上から読みやすく描画。階層一致のみ）
  if (showRoomLabels) {
    ctx.save();
    ctx.font = compact ? '600 9px sans-serif' : '600 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const room of map.rooms) {
      if (options.floorY !== undefined && Math.abs((room.floorY ?? 0) - options.floorY) > 1.3) continue;
      const cx = toX(room.x);
      const cy = toY(room.z);
      const label = tRoomName(room.name);
      ctx.fillStyle = 'rgba(8, 12, 18, 0.65)';
      ctx.fillText(label, cx + 1, cy + 1);
      ctx.fillStyle = compact ? 'rgba(210, 228, 245, 0.78)' : 'rgba(224, 238, 252, 0.92)';
      ctx.fillText(label, cx, cy);
    }
    ctx.restore();
  }

  // 侵入地点マーカー（ブリーフィング用）
  if (options.showSpawn) {
    const sx = toX(map.playerSpawn.x);
    const sy = toY(map.playerSpawn.z);
    const yawRad = -map.playerSpawn.yaw * DEG2RAD;
    const fxDir = -Math.sin(yawRad);
    const fzDir = -Math.cos(yawRad);
    const heading = Math.atan2(fzDir, fxDir);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(heading);
    ctx.fillStyle = '#56c8d8';
    ctx.strokeStyle = '#0c1520';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, -5.5);
    ctx.lineTo(-3.5, 0);
    ctx.lineTo(-6, 5.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (!compact) {
      ctx.save();
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#7ce2f0';
      ctx.fillText(t('突入地点', 'Entry Point'), sx, sy + 9);
      ctx.restore();
    }
  }
}

/** 動的な間取りレイヤ（制圧セル・ドア・ウェイポイント・隊員・プレイヤー視界コーン＆矢印・方位）を描画する。 */
function drawDynamicFloorPlan(
  ctx: CanvasRenderingContext2D,
  map: MapData,
  xf: PlanTransform,
  options: DrawFloorPlanOptions,
): void {
  const { cw, scale, toX, toY } = xf;
  const compact = options.compact ?? false;
  const showMarkerLabels = options.showMarkerLabels ?? true;

  // 視認済み制圧セル
  if (options.coverage && options.coverage.length > 0) {
    const fy = options.floorY ?? 0;
    const halfCell = scale * 0.25;
    const fullCell = scale * 0.5;
    for (let i = 0; i < options.coverage.length; i++) {
      const cell = options.coverage[i]!;
      if (!cell.seen || Math.abs(cell.y - fy) > 0.6) continue;
      ctx.fillStyle = cell.visible ? 'rgba(89,215,163,0.48)' : 'rgba(89,215,163,0.20)';
      ctx.fillRect(toX(cell.x) - halfCell, toY(cell.z) - halfCell, fullCell, fullCell);
    }
  }

  // ドア（開閉段階・施錠状態を色と角度で表現）
  for (const d of map.doors) {
    if (options.floorY !== undefined && Math.abs((d.y ?? 0) - options.floorY) > 1.4) continue;
    const width = d.width ?? DEFAULT_DOOR_WIDTH;
    const yawRad = d.yaw * DEG2RAD;
    const ux = Math.cos(yawRad);
    const uz = -Math.sin(yawRad);
    const hx = d.x - (ux * width) / 2;
    const hz = d.z - (uz * width) / 2;
    const ex = d.x + (ux * width) / 2;
    const ez = d.z + (uz * width) / 2;

    const live = options.doors?.get(d.id);
    const locked = live ? live.locked : d.locked;
    const stage: DoorStage = live ? live.stage : 'closed';
    const angleDeg = live ? live.angle : 0;

    const phx = toX(hx);
    const phy = toY(hz);
    const pex = toX(ex);
    const pey = toY(ez);

    // 開口部の薄いガイド線
    ctx.save();
    ctx.strokeStyle = 'rgba(180, 205, 230, 0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(phx, phy);
    ctx.lineTo(pex, pey);
    ctx.stroke();
    ctx.restore();

    const color = locked
      ? '#e05252'
      : stage === 'open'
        ? '#5cd67d'
        : stage === 'peek'
          ? '#56c8d8'
          : '#d89b3c';

    // ドア板（ヒンジ起点で angleDeg 分回転。両開きは両端ヒンジから長さ width/2 の2枚）
    const baseCanvasAngle = Math.atan2(pey - phy, pex - phx);
    const openAngleRad = angleDeg * DEG2RAD;

    if (d.double) {
      const halfLeafLen = Math.max(3, width * 0.5 * scale);
      const leftAngle = baseCanvasAngle - openAngleRad;
      const rightBaseAngle = baseCanvasAngle + Math.PI;
      const rightAngle = rightBaseAngle + openAngleRad;

      if (angleDeg > 1) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(phx, phy, halfLeafLen, leftAngle, baseCanvasAngle, false);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(pex, pey, halfLeafLen, rightBaseAngle, rightAngle, false);
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = compact ? 2.4 : 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(phx, phy);
      ctx.lineTo(phx + Math.cos(leftAngle) * halfLeafLen, phy + Math.sin(leftAngle) * halfLeafLen);
      ctx.moveTo(pex, pey);
      ctx.lineTo(pex + Math.cos(rightAngle) * halfLeafLen, pey + Math.sin(rightAngle) * halfLeafLen);
      ctx.stroke();

      // 両端ヒンジ点
      ctx.fillStyle = '#dce8f5';
      const hingeR = compact ? 1.4 : 2.1;
      ctx.beginPath();
      ctx.arc(phx, phy, hingeR, 0, Math.PI * 2);
      ctx.arc(pex, pey, hingeR, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const leafLen = Math.max(4, width * scale);
      const leafAngle = baseCanvasAngle - openAngleRad;

      if (angleDeg > 1) {
        // 開閉軌跡の薄い円弧
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(phx, phy, leafLen, leafAngle, baseCanvasAngle, false);
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = compact ? 2.4 : 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(phx, phy);
      ctx.lineTo(phx + Math.cos(leafAngle) * leafLen, phy + Math.sin(leafAngle) * leafLen);
      ctx.stroke();

      // ヒンジ点
      ctx.fillStyle = '#dce8f5';
      ctx.beginPath();
      ctx.arc(phx, phy, compact ? 1.4 : 2.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // 施錠マーカー
    if (locked) {
      const mx = (phx + pex) / 2;
      const my = (phy + pey) / 2;
      const r = compact ? 2.4 : 3.6;
      ctx.fillStyle = '#e05252';
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.fill();
      if (!compact) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 指定位置・警戒ウェイポイント
  if (options.waypoints) {
    for (const wp of options.waypoints) {
      if (options.floorY !== undefined && Math.abs(wp.y - options.floorY) > 1.4) continue;
      const wx = toX(wp.x);
      const wy = toY(wp.z);
      ctx.save();
      ctx.strokeStyle = wp.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(wx, wy, compact ? 4.5 : 6, 0, Math.PI * 2);
      ctx.stroke();
      if (!showMarkerLabels) {
        ctx.restore();
        continue;
      }
      ctx.fillStyle = wp.color;
      ctx.font = compact ? 'bold 8px sans-serif' : 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(wp.label, wx, wy - 5);
      ctx.restore();
    }
  }

  // スカウトした接触（赤=武装容疑者の最終確認位置 / 黄=民間人）
  if (options.contacts) {
    for (const c of options.contacts) {
      if (options.floorY !== undefined && Math.abs(c.y - options.floorY) > 1.4) continue;
      const cx = toX(c.x);
      const cy = toY(c.z);
      const r = compact ? 3.6 : 5;
      ctx.save();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#09121a';
      ctx.fillStyle = c.kind === 'threat' ? '#ff4d4d' : c.kind === 'civilian' ? '#ffd24a' : '#9aa6b2';
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy + r * 0.8);
      ctx.lineTo(cx - r, cy + r * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // 人質処刑の脅迫: 人質の部屋で赤い輪が脈打つ（カウントダウンが進むほど速く）
  if (options.pulses) {
    const time = options.time ?? 0;
    for (const p of options.pulses) {
      if (options.floorY !== undefined && Math.abs(p.y - options.floorY) > 1.4) continue;
      const px = toX(p.x);
      const py = toY(p.z);
      const speed = 1.4 + p.progress * 3.2;
      const k = (time * speed) % 1;
      const r0 = compact ? 5 : 7;
      ctx.save();
      ctx.strokeStyle = `rgba(255,60,60,${(1 - k) * 0.95})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, r0 + k * (compact ? 14 : 22), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ff3b3b';
      ctx.beginPath();
      ctx.arc(px, py, compact ? 3 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // 視界内の敵（赤点）
  if (options.enemies) {
    const r = compact ? 3.4 : 4.5;
    for (const e of options.enemies) {
      if (options.floorY !== undefined && Math.abs(e.y - options.floorY) > 1.4) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, e.alpha ?? 1));
      ctx.fillStyle = '#ff3b3b';
      ctx.strokeStyle = '#09121a';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(toX(e.x), toY(e.z), r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // 隊員マーカー
  if (options.allies) {
    for (const ally of options.allies) {
      if (options.floorY !== undefined && Math.abs(ally.y - options.floorY) > 1.4) continue;
      const ax = toX(ally.x);
      const ay = toY(ally.z);
      const fxDir = -Math.sin(ally.yawRad);
      const fzDir = -Math.cos(ally.yawRad);
      const heading = Math.atan2(fzDir, fxDir);
      ctx.save();
      if (!ally.down) {
        // 隊員の視界コーン（緑）
        const aConeLen = Math.max(10, 1.8 * scale);
        const aConeHalf = 32 * DEG2RAD;
        const aGrad = ctx.createRadialGradient(ax, ay, 1.5, ax, ay, aConeLen);
        aGrad.addColorStop(0, 'rgba(92, 220, 120, 0.36)');
        aGrad.addColorStop(1, 'rgba(92, 220, 120, 0.02)');
        ctx.fillStyle = aGrad;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.arc(ax, ay, aConeLen, heading - aConeHalf, heading + aConeHalf);
        ctx.closePath();
        ctx.fill();
      }
      // 隊員マーカー（緑点、ダウン時は灰色）
      ctx.fillStyle = ally.down ? '#6e7680' : '#4fdc78';
      ctx.strokeStyle = '#09121a';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(ax, ay, compact ? 3.4 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      if (!showMarkerLabels) continue;

      ctx.save();
      ctx.font = compact ? 'bold 8px sans-serif' : 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = ally.down ? '#8a94a0' : '#9cf0b4';
      ctx.fillText(ally.name.slice(0, 1), ax, ay + 5);
      ctx.restore();
    }
  }

  // プレイヤー位置＋視界コーン（ミニマップ用）
  if (options.player) {
    const px = toX(options.player.x);
    const py = toY(options.player.z);
    const fxDir = -Math.sin(options.player.yawRad);
    const fzDir = -Math.cos(options.player.yawRad);
    const heading = Math.atan2(fzDir, fxDir);
    const coneLen = Math.max(14, 2.4 * scale);
    const coneHalf = 32 * DEG2RAD;

    ctx.save();
    // 視界コーン
    const grad = ctx.createRadialGradient(px, py, 2, px, py, coneLen);
    grad.addColorStop(0, 'rgba(86, 200, 216, 0.42)');
    grad.addColorStop(1, 'rgba(86, 200, 216, 0.02)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, coneLen, heading - coneHalf, heading + coneHalf);
    ctx.closePath();
    ctx.fill();

    // プレイヤー向き矢印
    ctx.translate(px, py);
    ctx.rotate(heading);
    ctx.fillStyle = '#7ce2f0';
    ctx.strokeStyle = '#09121a';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(6.5, 0);
    ctx.lineTo(-4.5, -4);
    ctx.lineTo(-2.5, 0);
    ctx.lineTo(-4.5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 北（-Z）方位インジケータ
  ctx.save();
  ctx.font = compact ? 'bold 9px monospace' : 'bold 11px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(180, 205, 230, 0.7)';
  ctx.fillText('N ▲', cw - 6, 4);
  ctx.restore();
}

/**
 * 2D 間取り図レンダラー（ブリーフィング画面・ゲーム内ミニマップで共有）。
 * 座標規約: +X が右、-Z が上（北上固定）、アスペクト比維持で中央配置。
 * 戦術的制約: 未発見の容疑者・民間人は描画しない。
 */
export function drawFloorPlan(
  ctx: CanvasRenderingContext2D,
  map: MapData,
  options: DrawFloorPlanOptions = {},
): void {
  const cw = options.width ?? ctx.canvas.width;
  const ch = options.height ?? ctx.canvas.height;
  const compact = options.compact ?? false;
  const pad = options.padding ?? (compact ? 12 : 24);
  const xf = computePlanTransform(map, cw, ch, pad);
  drawStaticFloorPlan(ctx, map, xf, options);
  drawDynamicFloorPlan(ctx, map, xf, options);
}

/**
 * 画面左上のリアルタイム戦術ミニマップ。
 * プレイヤー位置・向き、ドアの開閉/施錠状態、隊員（緑点＋視界）、プレイヤー・隊員・オプティワンドで確認した敵（赤点、一定時間で消える）を表示する。
 * プレイ中は M キーで「左上ミニマップ（自機周辺のみ・名前ラベルなし）」⇔「画面一杯の半透明全体マップ（ラベルあり）」を切替。
 */
/** ミニマップの再描画間隔（秒）。約 15 Hz */
const REDRAW_INTERVAL = 1 / 15;

export class Minimap {
  private readonly root = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private staticCanvas: HTMLCanvasElement | null = null;
  private staticCtx: CanvasRenderingContext2D | null = null;
  private staticKey = '';
  private staticXf: PlanTransform | null = null;
  private staticDpr = 1;
  private readonly doorStates = new Map<string, FloorPlanDoorState>();
  private readonly playerState: FloorPlanPlayerState = { x: 0, z: 0, yawRad: 0 };
  private currentDpr = 1;
  private active = false;
  private expanded = false;
  private viewW = MINIMAP_SIZE;
  private viewH = MINIMAP_SIZE;
  private readonly keyHint: HTMLElement;
  private disposed = false;
  private floorTitle: HTMLElement | null = null;
  private lastFloorTitle = '';
  private lastHintText = '';
  private readonly floorLevels: number[];
  private activeFloorY: number | undefined;
  private redrawIn = 0;

  constructor(
    parent: HTMLElement,
    private readonly map: MapData,
    private readonly player: PlayerController,
    private readonly doors: DoorSystem,
    private readonly coverage: readonly Cell[],
    private readonly getAllies?: () => readonly FloorPlanAllyState[],
    private readonly getWaypoints?: () => readonly FloorPlanWaypoint[],
    private readonly getContacts?: () => readonly FloorPlanContact[],
    private readonly getPulses?: () => readonly FloorPlanPulse[],
    private readonly getEnemies?: () => readonly FloorPlanEnemy[],
  ) {
    this.floorLevels = collectFloorLevels(map);

    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font:600 10px monospace;letter-spacing:0.06em;color:rgba(188,214,240,0.85)';
    const title = document.createElement('span');
    const initTitle = t('間取り', 'FLOOR PLAN');
    title.textContent = initTitle;
    this.lastFloorTitle = initTitle;
    this.floorTitle = title;
    const key = document.createElement('span');
    key.textContent = '[M]';
    key.style.color = 'rgba(140,175,210,0.75)';
    this.keyHint = key;
    header.append(title, key);

    this.ctx = this.canvas.getContext('2d');

    this.root.append(header, this.canvas);
    this.applyLayout();
    parent.appendChild(this.root);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);
  }

  /** ミニマップ / 全画面の見た目とキャンバス解像度を現在のモードに合わせる */
  private applyLayout(): void {
    const display = this.active ? 'block' : 'none';
    const dpr = this.expanded
      ? Math.min(window.devicePixelRatio || 1, 1.25)
      : Math.min(window.devicePixelRatio || 1, 2);
    this.currentDpr = dpr;
    if (this.expanded) {
      const header = 22;
      const margin = 24;
      this.viewW = Math.max(200, Math.floor(window.innerWidth - margin * 2 - 16));
      this.viewH = Math.max(200, Math.floor(window.innerHeight - margin * 2 - 16 - header));
      this.root.style.cssText =
        `position:fixed;inset:${margin}px;z-index:6;pointer-events:none;background:rgba(6,10,16,0.35);border:1px solid rgba(120,155,195,0.4);border-radius:8px;padding:8px;box-sizing:border-box;display:${display}`;
      this.canvas.style.opacity = '0.72';
      const hint = t('[M] ミニマップに戻す', '[M] Minimap');
      this.keyHint.textContent = hint;
      this.lastHintText = hint;
    } else {
      this.viewW = MINIMAP_SIZE;
      this.viewH = MINIMAP_SIZE;
      this.root.style.cssText =
        `position:fixed;top:12px;left:12px;z-index:5;pointer-events:none;background:rgba(10,14,20,0.78);border:1px solid rgba(120,155,195,0.45);border-radius:6px;padding:6px;box-shadow:0 2px 10px rgba(0,0,0,0.45);display:${display}`;
      this.canvas.style.opacity = '1';
      const hint = t('[M] 拡大', '[M] Expand');
      this.keyHint.textContent = hint;
      this.lastHintText = hint;
    }
    this.canvas.width = Math.round(this.viewW * dpr);
    this.canvas.height = Math.round(this.viewH * dpr);
    this.canvas.style.display = 'block';
    this.canvas.style.width = `${this.viewW}px`;
    this.canvas.style.height = `${this.viewH}px`;
    this.canvas.style.borderRadius = '3px';
    this.staticKey = '';
  }

  private onResize = (): void => {
    if (this.disposed || !this.expanded) return;
    this.applyLayout();
    if (this.active) this.render();
  };

  /** App のフェーズ制御用（briefing / ended では false、playing で true）。 */
  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.active = visible;
    this.syncDisplay();
    if (this.active) this.render();
  }

  private syncDisplay(): void {
    this.root.style.display = this.active ? 'block' : 'none';
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || !this.active || e.repeat) return;
    if (e.code === 'KeyM') {
      this.expanded = !this.expanded;
      this.applyLayout();
      this.render();
    }
  };

  update(rawDt: number): void {
    if (this.disposed || !this.active) return;
    // 間取り全体の再描画は重い（大型マップで数百の壁・部屋）ため、毎フレームではなく一定間隔で描く
    this.redrawIn -= Math.min(rawDt, MAX_DT);
    if (this.redrawIn > 0) return;
    this.redrawIn = REDRAW_INTERVAL;
    this.render();
  }

  /** 左上ミニマップの縮尺（px/m）。自機周辺 LOCAL_VIEW_SPAN_M 四方を表示する */
  private localScale(): number {
    return Math.min(this.viewW, this.viewH) / LOCAL_VIEW_SPAN_M;
  }

  /**
   * 静的レイヤ（間取り）をオフスクリーンに描いてキャッシュする。
   * 拡大時はビューに全体をフィット、非拡大時はマップ全体を固定縮尺で描き、描画時に自機周辺を切り出す。
   */
  private ensureStaticLayer(floorY: number): PlanTransform {
    const pad = this.expanded ? 24 : 10;
    const key = `${floorY}|${this.viewW}|${this.viewH}|${this.expanded ? 1 : 0}|${getLocale()}`;
    if (key === this.staticKey && this.staticXf) return this.staticXf;

    const xf = this.expanded
      ? computePlanTransform(this.map, this.viewW, this.viewH, pad)
      : computeFullScaleTransform(this.map, this.localScale(), pad);
    this.staticXf = xf;
    this.staticCanvas ??= document.createElement('canvas');
    this.staticCtx ??= this.staticCanvas.getContext('2d');
    const sdpr = this.expanded
      ? this.currentDpr
      : Math.min(this.currentDpr, LOCAL_STATIC_MAX_PX / Math.max(xf.cw, xf.ch));
    this.staticDpr = sdpr;
    this.staticCanvas.width = Math.max(1, Math.round(xf.cw * sdpr));
    this.staticCanvas.height = Math.max(1, Math.round(xf.ch * sdpr));
    if (this.staticCtx) {
      this.staticCtx.save();
      this.staticCtx.setTransform(sdpr, 0, 0, sdpr, 0, 0);
      drawStaticFloorPlan(this.staticCtx, this.map, xf, {
        width: xf.cw,
        height: xf.ch,
        padding: pad,
        showRoomLabels: this.expanded,
        showSpawn: false,
        compact: !this.expanded,
        floorY,
      });
      this.staticCtx.restore();
      this.staticKey = key;
    }
    return xf;
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const d of this.doors.doors) {
      let st = this.doorStates.get(d.id);
      if (!st) {
        st = {
          id: d.id,
          angle: d.angle,
          maxAngle: d.maxAngle,
          stage: d.stage,
          locked: d.locked,
        };
        this.doorStates.set(d.id, st);
      } else {
        st.angle = d.angle;
        st.maxAngle = d.maxAngle;
        st.stage = d.stage;
        st.locked = d.locked;
      }
    }
    const floor = resolveActiveFloor(this.player.position.y, this.floorLevels, this.activeFloorY);
    this.activeFloorY = floor.floorY;
    const staticXf = this.ensureStaticLayer(floor.floorY);
    const pad = this.expanded ? 24 : 10;
    this.playerState.x = this.player.position.x;
    this.playerState.z = this.player.position.z;
    this.playerState.yawRad = this.player.yawRad;
    // 非拡大時は自機を中心に据えた変換で動的レイヤを描く
    const xf = this.expanded
      ? staticXf
      : computeCenteredTransform(this.viewW, this.viewH, this.localScale(), this.playerState.x, this.playerState.z);

    ctx.save();
    ctx.setTransform(this.currentDpr, 0, 0, this.currentDpr, 0, 0);
    if (this.staticCanvas && this.staticCtx && typeof ctx.drawImage === 'function') {
      ctx.clearRect(0, 0, this.viewW, this.viewH);
      if (this.expanded) {
        ctx.drawImage(this.staticCanvas, 0, 0, this.viewW, this.viewH);
      } else {
        // 静的レイヤから自機周辺のビュー分だけを切り出す（範囲外はクリップして描画位置を補正）
        const sd = this.staticDpr;
        let sx = (staticXf.toX(this.playerState.x) - this.viewW / 2) * sd;
        let sy = (staticXf.toY(this.playerState.z) - this.viewH / 2) * sd;
        let sw = this.viewW * sd;
        let sh = this.viewH * sd;
        let dx = 0;
        let dy = 0;
        const k = 1 / sd;
        if (sx < 0) { dx = -sx * k; sw += sx; sx = 0; }
        if (sy < 0) { dy = -sy * k; sh += sy; sy = 0; }
        sw = Math.min(sw, this.staticCanvas.width - sx);
        sh = Math.min(sh, this.staticCanvas.height - sy);
        if (sw > 0 && sh > 0) {
          ctx.drawImage(this.staticCanvas, sx, sy, sw, sh, dx, dy, sw * k, sh * k);
        }
      }
    } else {
      drawStaticFloorPlan(ctx, this.map, xf, {
        width: this.viewW,
        height: this.viewH,
        padding: pad,
        showRoomLabels: this.expanded,
        showSpawn: false,
        compact: !this.expanded,
        floorY: floor.floorY,
      });
    }
    drawDynamicFloorPlan(ctx, this.map, xf, {
      width: this.viewW,
      height: this.viewH,
      padding: pad,
      showMarkerLabels: this.expanded,
      compact: !this.expanded,
      coverage: this.coverage,
      doors: this.doorStates,
      floorY: floor.floorY,
      allies: this.getAllies?.(),
      waypoints: this.getWaypoints?.(),
      contacts: this.getContacts?.(),
      pulses: this.getPulses?.(),
      enemies: this.getEnemies?.(),
      time: performance.now() / 1000,
      player: this.playerState,
    });
    ctx.restore();

    if (this.floorTitle) {
      const base = t('間取り', 'FLOOR PLAN');
      const titleText = this.floorLevels.length > 1 ? `${base} ${floor.label}` : base;
      if (titleText !== this.lastFloorTitle) {
        this.lastFloorTitle = titleText;
        this.floorTitle.textContent = titleText;
      }
    }
    const hint = this.expanded ? t('[M] ミニマップに戻す', '[M] Minimap') : t('[M] 拡大', '[M] Expand');
    if (hint !== this.lastHintText) {
      this.lastHintText = hint;
      this.keyHint.textContent = hint;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    this.doorStates.clear();
    this.staticKey = '';
    this.staticXf = null;
    if (this.staticCanvas) {
      this.staticCanvas.width = 0;
      this.staticCanvas.height = 0;
      this.staticCanvas = null;
      this.staticCtx = null;
    }
    this.root.remove();
  }
}
