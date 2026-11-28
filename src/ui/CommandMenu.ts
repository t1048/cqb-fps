import * as THREE from 'three';
import type { OrderMenuEvent } from '../core/InputManager';
import type { RoomDef, SquadConfig, SquadElement, SquadOrder, Vec3 } from '../core/types';
import type { PlayerController } from '../player/PlayerController';
import type { Door, DoorSystem } from '../world/Door';
import type { Collider } from '../world/WorldBuilder';
import type { StairMark } from '../world/Walk';
import { raycastColliders, someColliderAlongSegment } from '../world/ColliderIndex';
import { hasLineOfSight } from '../weapons/Flashbang';
import { blockedAt } from '../ai/EngageBehavior';
import type { EntityManager } from '../ai/EntityManager';
import { SuspectState } from '../core/events';
import { getLocale, t, tElementLabel, tRoomName } from '../core/i18n';

export interface GroundTarget {
  x: number;
  y: number;
  z: number;
  dist: number;
  yawRad: number;
}

export interface RestrainTarget {
  id: string;
  kind: 'suspect' | 'civilian' | 'evidence';
  label: string;
  x: number;
  y: number;
  z: number;
}

export interface AreaClearTarget {
  room: RoomDef;
  entryX: number;
  entryY: number;
  entryZ: number;
  intoX: number;
  intoZ: number;
  axisX: number;
  axisZ: number;
  width: number;
  door: Door | null;
}

/** 照準した階段（階段クリアの対象）。up = いまの階から上る（false は下る）。 */
export interface StairTarget {
  stair: StairMark;
  up: boolean;
  /** 照準点までの距離（m） */
  dist: number;
}

export interface OrderContext {
  element: SquadElement;
  door: Door | null;
  areaTarget: AreaClearTarget | null;
  /** 照準した階段（閉じたドア・確保対象を見ているときは null） */
  stairTarget?: StairTarget | null;
  groundPoint: GroundTarget | null;
  restrainTarget: RestrainTarget | null;
  aimDir: { x: number; z: number };
}

export interface ActiveMarker {
  key: SquadElement;
  x: number;
  y: number;
  z: number;
  yawRad: number;
  label: string;
}

/** メニューが参照する分隊の装備状況（残数が 0 の手榴弾系の項目を無効化する） */
export interface MenuGearProvider {
  gear(): { flash: number; gas: number };
  /** そのドアのブービートラップを発見済み（未解除）か */
  trapKnown(doorId: string): boolean;
  /** 進行度により CS ガスが未解放か */
  gasLocked?: boolean;
  /** 進行度によりオプティワンド（ミラー確認）が未解放か */
  optiwandLocked?: boolean;
  /** 進行度により C2 爆破ブリーチが未解放か */
  c2Locked?: boolean;
}

interface MenuItem {
  order: SquadOrder | null;
  label: string;
  enabled: boolean;
}

const ELEMENT_COLORS: Record<SquadElement, number> = {
  gold: 0xf2c14e,
  alpha: 0x56c8d8,
  bravo: 0x6be08b,
};

const ELEMENT_CSS: Record<SquadElement, string> = {
  gold: '#f2c14e',
  alpha: '#56c8d8',
  bravo: '#6be08b',
};

const NON_GROUND_COLLIDER = (c: Collider): boolean =>
  c.kind !== 'floor' && c.kind !== 'stair' && c.kind !== 'ceiling';

const CONTEXT_CACHE_MS = 50;

const STYLE = `
.cqb-cmd{position:fixed;left:calc(50% + 26px);top:50%;transform:translateY(-50%);min-width:270px;max-width:340px;
  background:rgba(10,16,24,.92);border:1px solid #486b8a;border-radius:6px;padding:10px 12px;
  color:#e8f0f8;font:13px/1.4 sans-serif;z-index:90;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.55)}
.cqb-cmd-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding-bottom:6px;
  margin-bottom:6px;border-bottom:1px solid #2b4156}
.cqb-cmd-el{font:bold 12px monospace;padding:2px 7px;border-radius:3px;background:#1a2838;border:1px solid currentColor}
.cqb-cmd-ctx{font-size:11px;color:#9bb6d0;margin-bottom:6px}
.cqb-cmd-row{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;margin:2px 0}
.cqb-cmd-row.active{background:#2d4a66;color:#fff}
.cqb-cmd-row.disabled{opacity:.4}
.cqb-cmd-foot{margin-top:6px;padding-top:5px;border-top:1px solid #243648;font-size:11px;color:#8ba4bc}
`;

function rayBoxDist(ray: THREE.Ray, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, tmpBox: THREE.Box3, tmpHit: THREE.Vector3): number | null {
  tmpBox.min.set(minX, minY, minZ);
  tmpBox.max.set(maxX, maxY, maxZ);
  const hit = ray.intersectBox(tmpBox, tmpHit);
  return hit ? hit.distanceTo(ray.origin) : null;
}

const groundRayDir: Vec3 = { x: 0, y: -1, z: 0 };

/**
 * 視線レイが最初に当たる歩行面（floor / stair コライダの上面）を返す。壁・遮蔽物・ドア板より奥は除外。
 * 無限 y=0 平面は使わないため、階段穴越しに下階・地下の床面を指せる。上面は見下ろすときだけ当たる。
 */
export function raycastGround(
  colliders: readonly Collider[],
  eye: Vec3,
  dir: Vec3,
  maxDist: number,
  _ray?: THREE.Ray,
  _tmpBox?: THREE.Box3,
  _tmpHit?: THREE.Vector3,
): { t: number; y: number } | null {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-9) return null;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;
  if (dy >= -1e-4) return null;
  groundRayDir.x = dx;
  groundRayDir.y = dy;
  groundRayDir.z = dz;
  const wallT = raycastColliders(colliders, eye, groundRayDir, maxDist, NON_GROUND_COLLIDER);
  let bestT = Infinity;
  let bestY = 0;
  someColliderAlongSegment(colliders, eye.x, eye.z, eye.x + dx * wallT, eye.z + dz * wallT, (c) => {
    if (c.kind !== 'floor' && c.kind !== 'stair') return false;
    const a = c.aabb;
    if (eye.y <= a.max.y) return false;
    const tPlane = (a.max.y - eye.y) / dy;
    if (tPlane > 0.6 && tPlane <= wallT && tPlane < bestT) {
      const hx = eye.x + dx * tPlane;
      const hz = eye.z + dz * tPlane;
      if (hx >= a.min.x && hx <= a.max.x && hz >= a.min.z && hz <= a.max.z) {
        bestT = tPlane;
        bestY = a.max.y;
      }
    }
    return false;
  });
  return Number.isFinite(bestT) ? { t: bestT, y: bestY } : null;
}

/**
 * 部隊指揮メニューUI・照準コンテキスト判定・3D床面戦術マーカー管理。
 * 右クリック保持で展開し、既定の選択は中央の「キャンセル」（動かさず離せば何も実行しない）。
 * マウス上下・ホイールで上下の項目を選び、離す/左クリックで決定。
 * 上: 準備・索敵（近い順に流れの最初）／下: 突入、その下に待機・追従。
 */
export class CommandMenu {
  readonly root = new THREE.Group();
  private readonly styleEl = document.createElement('style');
  private readonly menuEl = document.createElement('div');
  private readonly titleEl = document.createElement('strong');
  private readonly elBadge = document.createElement('span');
  private readonly ctxEl = document.createElement('div');
  private readonly listEl = document.createElement('div');
  private readonly footEl = document.createElement('div');

  private readonly previewMesh: THREE.Group;
  private readonly activeMeshes = new Map<SquadElement, THREE.Group>();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];

  private items: MenuItem[] = [];
  private gearProvider: MenuGearProvider | null = null;
  private featureLocks: { gasLocked?: boolean; optiwandLocked?: boolean; c2Locked?: boolean } = {};
  private offsetPx = 0;
  private selectedIdx = 0;
  private open = false;
  private openContext: OrderContext | null = null;
  private disposed = false;

  private ctxCache: OrderContext | null = null;
  private ctxCacheAt = -Infinity;
  private ctxEyeX = NaN;
  private ctxEyeY = NaN;
  private ctxEyeZ = NaN;
  private ctxYaw = NaN;
  private ctxPitch = NaN;
  private ctxLocale = '';
  private ctxWorldStamp = NaN;

  private readonly eye = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly tmpBox = new THREE.Box3();
  private readonly tmpHit = new THREE.Vector3();

  constructor(
    private readonly cfg: SquadConfig,
    private readonly player: PlayerController,
    private readonly doors: DoorSystem,
    private readonly colliders: readonly Collider[],
    private readonly entities: EntityManager,
    private readonly rooms: readonly RoomDef[],
    private readonly stairs: readonly StairMark[] = [],
  ) {
    this.root.name = 'squad-markers';
    this.styleEl.textContent = STYLE;
    document.head.appendChild(this.styleEl);

    this.menuEl.className = 'cqb-cmd';
    this.menuEl.hidden = true;
    const head = document.createElement('div');
    head.className = 'cqb-cmd-head';
    this.titleEl.textContent = t('部隊指揮', 'SQUAD COMMAND');
    this.elBadge.className = 'cqb-cmd-el';
    head.append(this.titleEl, this.elBadge);

    this.ctxEl.className = 'cqb-cmd-ctx';
    this.footEl.className = 'cqb-cmd-foot';
    this.footEl.textContent = t(
      '[マウス上下/ホイール] 選択   [右離し / 左クリック] 実行   [T] チーム切替   [中クリック] 中止',
      '[Mouse Up/Down/Wheel] Select   [Release RMB / LMB] Execute   [T] Switch Team   [MMB] Cancel',
    );
    this.menuEl.append(head, this.ctxEl, this.listEl, this.footEl);
    document.body.appendChild(this.menuEl);

    this.previewMesh = this.createMarkerGroup(0xffffff, 0.55);
    this.previewMesh.visible = false;
    this.root.add(this.previewMesh);
    for (const el of ['gold', 'alpha', 'bravo'] as const) {
      const m = this.createMarkerGroup(ELEMENT_COLORS[el], 0.85);
      m.visible = false;
      this.activeMeshes.set(el, m);
      this.root.add(m);
    }
  }

  private createMarkerGroup(color: number, opacity: number): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mats.push(mat);
    const ringGeo = new THREE.RingGeometry(0.24, 0.34, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.geos.push(ringGeo);
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.position.y = 0.03;

    const arrowGeo = new THREE.ConeGeometry(0.11, 0.22, 3);
    arrowGeo.rotateX(-Math.PI / 2);
    this.geos.push(arrowGeo);
    const arrow = new THREE.Mesh(arrowGeo, mat);
    arrow.position.set(0, 0.04, -0.44);

    g.add(ring, arrow);
    return g;
  }

  /** ドア角度・施錠および拘束対象数の軽量スタンプ（50ms キャッシュ中に状態変化があれば即失効させる） */
  private computeWorldStamp(): number {
    let stamp = 0;
    const doors = this.doors.doors;
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i]!;
      stamp += Math.round(d.angle) * 13 + (d.locked ? 7 : 0);
    }
    for (const s of this.entities.suspects.values()) {
      if (s.state === SuspectState.SURRENDER) stamp += 101;
      if (s.hasUncollectedEvidence) stamp += 307;
    }
    for (const c of this.entities.civilians.values()) {
      if (c.canSecure) stamp += 613;
    }
    return stamp;
  }

  resolveContext(element: SquadElement): OrderContext {
    this.player.getEyePosition(this.eye);
    const yaw = this.player.yawRad;
    const pitch = this.player.pitchRad;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const locale = getLocale();
    const stamp = this.computeWorldStamp();

    if (
      !this.open &&
      this.ctxCache !== null &&
      now - this.ctxCacheAt < CONTEXT_CACHE_MS &&
      this.ctxCache.element === element &&
      this.ctxLocale === locale &&
      this.ctxWorldStamp === stamp &&
      Math.abs(this.eye.x - this.ctxEyeX) < 1e-3 &&
      Math.abs(this.eye.y - this.ctxEyeY) < 1e-3 &&
      Math.abs(this.eye.z - this.ctxEyeZ) < 1e-3 &&
      Math.abs(yaw - this.ctxYaw) < 1e-4 &&
      Math.abs(pitch - this.ctxPitch) < 1e-4
    ) {
      return this.ctxCache;
    }

    const cp = Math.cos(pitch);
    this.dir.set(
      -Math.sin(yaw) * cp,
      Math.sin(pitch),
      -Math.cos(yaw) * cp,
    ).normalize();

    const playerRoom = this.findRoomAt(this.player.position.x, this.player.position.z, this.player.position.y);
    const wallT = this.computeWallDistance(14);
    const aimedDoor = this.doors.aimed(10);
    let door: Door | null = null;
    let areaTarget: AreaClearTarget | null = null;
    if (aimedDoor && aimedDoor.angle < this.cfg.doorOpenAngle) {
      door = aimedDoor;
    } else {
      if (aimedDoor) areaTarget = this.buildDoorAreaTarget(aimedDoor, playerRoom);
      if (!areaTarget) areaTarget = this.findAreaTarget(wallT, playerRoom);
    }

    const restrainTarget = this.findRestrainTarget();
    const groundPoint = this.findGroundPoint();
    const stairTarget = door || restrainTarget ? null : this.findStairTarget();

    const ctx: OrderContext = {
      element,
      door,
      areaTarget,
      stairTarget,
      groundPoint,
      restrainTarget,
      aimDir: { x: -Math.sin(yaw), z: -Math.cos(yaw) },
    };
    this.ctxCache = ctx;
    this.ctxCacheAt = now;
    this.ctxEyeX = this.eye.x;
    this.ctxEyeY = this.eye.y;
    this.ctxEyeZ = this.eye.z;
    this.ctxYaw = yaw;
    this.ctxPitch = pitch;
    this.ctxLocale = locale;
    this.ctxWorldStamp = stamp;
    return ctx;
  }

  private findRoomAt(x: number, z: number, y: number): RoomDef | null {
    return (
      this.rooms.find(
        (r) =>
          Math.abs((r.floorY ?? 0) - y) < 0.6 &&
          Math.abs(x - r.x) <= r.width / 2 &&
          Math.abs(z - r.z) <= r.depth / 2,
      ) ?? null
    );
  }

  private computeWallDistance(maxDist: number): number {
    return raycastColliders(this.colliders, this.eye, this.dir, maxDist, NON_GROUND_COLLIDER);
  }

  private buildDoorAreaTarget(door: Door, playerRoom: RoomDef | null): AreaClearTarget | null {
    const approach =
      (this.player.position.x - door.centerX) * door.normalX + (this.player.position.z - door.centerZ) * door.normalZ >= 0
        ? 1
        : -1;
    const intoX = -approach * door.normalX;
    const intoZ = -approach * door.normalZ;
    const room = this.findRoomAt(door.centerX + intoX * 0.75, door.centerZ + intoZ * 0.75, door.sillY);
    if (!room || room.outdoor || room === playerRoom) return null;
    return {
      room,
      entryX: door.centerX,
      entryY: door.sillY,
      entryZ: door.centerZ,
      intoX,
      intoZ,
      axisX: door.axisX,
      axisZ: door.axisZ,
      width: door.width,
      door,
    };
  }

  private findAreaTarget(wallT: number, playerRoom: RoomDef | null): AreaClearTarget | null {
    let bestDoorT = Infinity;
    let bestDoorTarget: AreaClearTarget | null = null;
    for (const door of this.doors.doors) {
      if (door.angle < this.cfg.doorOpenAngle) continue;
      if (Math.abs(this.player.position.y - door.sillY) >= 0.75) continue;
      const denom = this.dir.x * door.normalX + this.dir.z * door.normalZ;
      if (Math.abs(denom) < 1e-5) continue;
      const t =
        ((door.centerX - this.eye.x) * door.normalX + (door.centerZ - this.eye.z) * door.normalZ) / denom;
      if (t <= 0.35 || t >= wallT || t > 12 || t >= bestDoorT) continue;
      const hx = this.eye.x + this.dir.x * t;
      const hy = this.eye.y + this.dir.y * t;
      const hz = this.eye.z + this.dir.z * t;
      const along = Math.abs((hx - door.centerX) * door.axisX + (hz - door.centerZ) * door.axisZ);
      if (along > door.width / 2 + 0.12) continue;
      if (hy < door.sillY - 0.1 || hy > door.sillY + door.height + 0.1) continue;
      const target = this.buildDoorAreaTarget(door, playerRoom);
      if (!target) continue;
      if (this.dir.x * target.intoX + this.dir.z * target.intoZ <= 0.15) continue;
      bestDoorT = t;
      bestDoorTarget = target;
    }
    if (bestDoorTarget) return bestDoorTarget;

    this.ray.origin.copy(this.eye);
    this.ray.direction.copy(this.dir);
    const candidates: { room: RoomDef; tEnter: number }[] = [];
    for (const r of this.rooms) {
      if (r.outdoor || r === playerRoom) continue;
      const floorY = r.floorY ?? 0;
      if (Math.abs(floorY - this.player.position.y) >= 0.75) continue;
      const tEnter = rayBoxDist(
        this.ray,
        r.x - r.width / 2,
        floorY,
        r.z - r.depth / 2,
        r.x + r.width / 2,
        floorY + 2.8,
        r.z + r.depth / 2,
        this.tmpBox,
        this.tmpHit,
      );
      if (tEnter !== null && tEnter > 0.35 && tEnter < wallT && tEnter <= 12) {
        candidates.push({ room: r, tEnter });
      }
    }
    candidates.sort((a, b) => a.tEnter - b.tEnter);

    const checkR = this.cfg.bodyRadius;
    for (const { room: r, tEnter } of candidates) {
      const floorY = r.floorY ?? 0;
      const hx = this.eye.x + this.dir.x * tEnter;
      const hz = this.eye.z + this.dir.z * tEnter;
      const xMin = r.x - r.width / 2;
      const xMax = r.x + r.width / 2;
      const zMin = r.z - r.depth / 2;
      const zMax = r.z + r.depth / 2;

      const edges = [
        { d: Math.abs(hx - xMin), bx: xMin, bz: hz, intoX: 1, intoZ: 0, axisX: 0, axisZ: 1 },
        { d: Math.abs(hx - xMax), bx: xMax, bz: hz, intoX: -1, intoZ: 0, axisX: 0, axisZ: 1 },
        { d: Math.abs(hz - zMin), bx: hx, bz: zMin, intoX: 0, intoZ: 1, axisX: 1, axisZ: 0 },
        { d: Math.abs(hz - zMax), bx: hx, bz: zMax, intoX: 0, intoZ: -1, axisX: 1, axisZ: 0 },
      ];
      edges.sort((a, b) => a.d - b.d);
      const edge = edges[0]!;

      const passableAt = (x: number, z: number): boolean =>
        !blockedAt(this.colliders, x, z, checkR, floorY);
      const passageClear = (bx: number, bz: number): boolean =>
        passableAt(bx, bz) &&
        passableAt(bx - edge.intoX * 0.45, bz - edge.intoZ * 0.45) &&
        passableAt(bx + edge.intoX * 0.45, bz + edge.intoZ * 0.45);

      let anchorX = edge.bx;
      let anchorZ = edge.bz;
      if (!passageClear(anchorX, anchorZ)) {
        let found = false;
        for (const step of [0.2, 0.4, 0.6, 0.8, 1.0]) {
          for (const sign of [1, -1]) {
            const cx = edge.bx + edge.axisX * step * sign;
            const cz = edge.bz + edge.axisZ * step * sign;
            if (cx < xMin - 1e-6 || cx > xMax + 1e-6 || cz < zMin - 1e-6 || cz > zMax + 1e-6) continue;
            if (passageClear(cx, cz)) {
              anchorX = cx;
              anchorZ = cz;
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (!found) continue;
      }

      for (const d of this.doors.doors) {
        if (d.angle < this.cfg.doorOpenAngle || Math.abs(d.sillY - floorY) >= 0.75) continue;
        if (Math.hypot(d.centerX - anchorX, d.centerZ - anchorZ) > 1.2) continue;
        const dt = this.buildDoorAreaTarget(d, playerRoom);
        if (dt && dt.room === r) return dt;
      }

      let minOff = 0;
      let maxOff = 0;
      for (let off = -0.2; off >= -0.8 - 1e-6; off -= 0.2) {
        if (passageClear(anchorX + edge.axisX * off, anchorZ + edge.axisZ * off)) minOff = off;
        else break;
      }
      for (let off = 0.2; off <= 0.8 + 1e-6; off += 0.2) {
        if (passageClear(anchorX + edge.axisX * off, anchorZ + edge.axisZ * off)) maxOff = off;
        else break;
      }
      const midOff = (minOff + maxOff) / 2;
      const span = maxOff - minOff + 0.4;
      return {
        room: r,
        entryX: anchorX + edge.axisX * midOff,
        entryY: floorY,
        entryZ: anchorZ + edge.axisZ * midOff,
        intoX: edge.intoX,
        intoZ: edge.intoZ,
        axisX: edge.axisX,
        axisZ: edge.axisZ,
        width: Math.min(2.0, Math.max(1.0, span)),
        door: null,
      };
    }

    return null;
  }

  /**
   * 視線の先にある階段（いまの階に昇降口がある階段）を探す。段の中心線・出口の踊り場の点のどれかが
   * 視線のすぐ近く（距離に応じて 0.55m〜）にあり、目から見通せるものを選ぶ。
   */
  findStairTarget(): StairTarget | null {
    if (this.stairs.length === 0) return null;
    const py = this.player.position.y;
    let best: StairTarget | null = null;
    let bestScore = Infinity;
    const p: Vec3 = { x: 0, y: 0, z: 0 };
    for (const s of this.stairs) {
      let up: boolean;
      if (Math.abs(py - s.baseY) < 0.75) up = true;
      else if (Math.abs(py - s.topY) < 0.75) up = false;
      else continue;
      const entry = up ? s.approachLow : s.approachHigh;
      if (Math.hypot(entry.x - this.player.position.x, entry.z - this.player.position.z) > 12) continue;
      const exit = up ? s.approachHigh : s.approachLow;
      const exitY = up ? s.topY : s.baseY;
      const entryY = up ? s.baseY : s.topY;
      // 進入点 → 段の中心線 → 出口の先（踊り場）を 0.4〜0.6m 刻みで見る
      const SAMPLES = 10;
      for (let i = 0; i <= SAMPLES + 2; i++) {
        if (i <= SAMPLES) {
          const u = i / SAMPLES;
          p.x = entry.x + (exit.x - entry.x) * u;
          p.z = entry.z + (exit.z - entry.z) * u;
          p.y = entryY + (exitY - entryY) * u + 0.45;
        } else {
          const k = i - SAMPLES;
          const dx = exit.x - entry.x;
          const dz = exit.z - entry.z;
          const len = Math.hypot(dx, dz) || 1;
          p.x = exit.x + (dx / len) * 0.7 * k;
          p.z = exit.z + (dz / len) * 0.7 * k;
          p.y = exitY + 0.9;
        }
        const vx = p.x - this.eye.x;
        const vy = p.y - this.eye.y;
        const vz = p.z - this.eye.z;
        const tAlong = vx * this.dir.x + vy * this.dir.y + vz * this.dir.z;
        if (tAlong < 0.4 || tAlong > 14) continue;
        const ex = vx - this.dir.x * tAlong;
        const ey = vy - this.dir.y * tAlong;
        const ez = vz - this.dir.z * tAlong;
        const perp = Math.hypot(ex, ey, ez);
        const tol = 0.55 + tAlong * 0.05;
        if (perp > tol) continue;
        const score = perp / tol + tAlong * 0.01;
        if (score >= bestScore) continue;
        if (!hasLineOfSight(this.colliders, this.eye, p)) continue;
        bestScore = score;
        best = { stair: s, up, dist: tAlong };
      }
    }
    return best;
  }

  private findRestrainTarget(): RestrainTarget | null {
    let best: RestrainTarget | null = null;
    let bestDist = 12;
    const fx = this.dir.x;
    const fy = this.dir.y;
    const fz = this.dir.z;

    const testPoint = (px: number, py: number, pz: number): number | null => {
      const vx = px - this.eye.x;
      const vy = py - this.eye.y;
      const vz = pz - this.eye.z;
      const t = vx * fx + vy * fy + vz * fz;
      if (t < 0.4 || t > bestDist) return null;
      const dx = this.eye.x + fx * t - px;
      const dy = this.eye.y + fy * t - py;
      const dz = this.eye.z + fz * t - pz;
      if (dx * dx + dy * dy + dz * dz > 0.55 * 0.55) return null;
      if (!hasLineOfSight(this.colliders, this.eye, { x: px, y: py, z: pz })) return null;
      return t;
    };

    for (const s of this.entities.suspects.values()) {
      if (s.state === SuspectState.SURRENDER) {
        const c = s.body.chestPos();
        const d = testPoint(c.x, c.y, c.z);
        if (d !== null) {
          bestDist = d;
          best = {
            id: s.id,
            kind: 'suspect',
            label: t('投降した容疑者', 'Surrendered Suspect'),
            x: s.body.px,
            y: s.body.footY,
            z: s.body.pz,
          };
        }
      }
      if (s.hasUncollectedEvidence) {
        const wp = s.body.getDroppedWeaponPos();
        if (wp) {
          const d = testPoint(wp.x, wp.y + 0.08, wp.z);
          if (d !== null) {
            bestDist = d;
            best = {
              id: s.id,
              kind: 'evidence',
              label: t('証拠品', 'Evidence'),
              x: wp.x,
              y: s.body.footY,
              z: wp.z,
            };
          }
        }
      }
    }

    for (const c of this.entities.civilians.values()) {
      if (!c.canSecure) continue;
      const ch = c.body.chestPos();
      const d = testPoint(ch.x, ch.y, ch.z);
      if (d !== null) {
        bestDist = d;
        best = {
          id: c.id,
          kind: 'civilian',
          label: t('人質・民間人', 'Hostage / Civilian'),
          x: c.body.px,
          y: c.body.footY,
          z: c.body.pz,
        };
      }
    }

    return best;
  }

  private findGroundPoint(): GroundTarget | null {
    const hit = raycastGround(this.colliders, this.eye, this.dir, 18, this.ray, this.tmpBox, this.tmpHit);
    if (!hit) return null;
    const bestT = hit.t;
    const bestY = hit.y;

    let gx = this.eye.x + this.dir.x * bestT;
    let gz = this.eye.z + this.dir.z * bestT;
    if (blockedAt(this.colliders, gx, gz, this.cfg.bodyRadius, bestY)) {
      const stepBack = 0.42;
      const bx = gx - this.dir.x * stepBack;
      const bz = gz - this.dir.z * stepBack;
      if (blockedAt(this.colliders, bx, bz, this.cfg.bodyRadius, bestY)) return null;
      gx = bx;
      gz = bz;
    }

    return { x: gx, y: bestY, z: gz, dist: bestT, yawRad: this.player.yawRad };
  }

  /** 分隊の装備状況の参照元を設定する（SWAT モードの SquadSystem が設定）。 */
  setGearProvider(p: MenuGearProvider | null): void {
    this.gearProvider = p;
  }

  /** 進行度に応じたロック状態（CSガス・オプティワンド・C2）を設定する。 */
  setFeatureLocks(locks: { gasLocked?: boolean; optiwandLocked?: boolean; c2Locked?: boolean }): void {
    this.featureLocks = { ...locks };
  }

  private buildMenuItems(ctx: OrderContext): MenuItem[] {
    // 流れの順に追加し、区分で画面上の配置を決める
    type Zone = 'prep' | 'entry' | 'general';
    const flow: { item: MenuItem; zone: Zone }[] = [];
    const add = (zone: Zone, order: SquadOrder, label: string, enabled = true) => {
      flow.push({ item: { order, label, enabled }, zone });
    };
    const gear = this.gearProvider?.gear() ?? null;
    const gasLocked = this.featureLocks.gasLocked === true || this.gearProvider?.gasLocked === true;
    const optiwandLocked = this.featureLocks.optiwandLocked === true || this.gearProvider?.optiwandLocked === true;
    const c2Locked = this.featureLocks.c2Locked === true || this.gearProvider?.c2Locked === true;
    const flashOk = gear === null || gear.flash > 0;
    const gasOk = !gasLocked && (gear === null || gear.gas > 0);
    const flashLabel = (base: string): string =>
      gear ? `${base} ${t(`[残 ${gear.flash}]`, `[${gear.flash} left]`)}` : base;
    const gasLabel = (base: string): string =>
      gasLocked
        ? `🔒 ${base} ${t('(SWAT Lv.2)', '(SWAT Lv.2)')}`
        : gear
          ? `${base} ${t(`[残 ${gear.gas}]`, `[${gear.gas} left]`)}`
          : base;
    const moveLabel = (g: { dist: number }): string =>
      t(`指定位置へ移動・警戒 (${g.dist.toFixed(1)}m)`, `Move & Cover (${g.dist.toFixed(1)}m)`);
    const overwatchLabel = t('現在位置から照準方向をロック', 'Cover Aimed Direction');

    if (ctx.restrainTarget) {
      add(
        'prep',
        'restrain',
        t(`対象を確保（${ctx.restrainTarget.label}）`, `Secure Target (${ctx.restrainTarget.label})`),
        true,
      );
    } else if (ctx.door) {
      add('prep', 'stack', t('スタックアップ（扉脇で待機）', 'Stack Up (Hold by Door)'), true);
      add(
        'prep',
        'mirror',
        optiwandLocked
          ? `🔒 ${t('ミラー確認（SWAT Lv.2 で解放）', 'Mirror Under Door (SWAT Lv.2)')}`
          : t('ミラー確認（ドア下を隊員が確認・約4秒）', 'Mirror Under Door (Ally Wand, ~4s)'),
        !optiwandLocked,
      );
      add('prep', 'check', t('ドアチェック（施錠・トラップ確認）', 'Check Door (Lock & Trap)'), true);
      if (ctx.door.locked) {
        add('prep', 'lockpick', t('キーピック解錠（静かに解錠・約3秒）', 'Lockpick Door (Quiet, ~3s)'), true);
      }
      if (this.gearProvider?.trapKnown(ctx.door.id)) {
        add('prep', 'disarm', t('トラップ解除（扉を少し開いてワイヤー切断）', 'Disarm Trap (Crack Door & Cut Wire)'), true);
      }
      add('prep', 'pieDoor', t('扉開放・外から警戒', 'Open & Hold (Cover from Outside)'), !ctx.door.locked);
      add(
        'entry',
        'clear',
        ctx.door.locked
          ? t('オープン＆クリア（蹴破り突入）', 'Open & Clear (Kick Breach)')
          : t('オープン＆クリア（2名突入制圧）', 'Open & Clear (2-Man Entry)'),
        true,
      );
      add('entry', 'flashClear', flashLabel(t('フラッシュ＆クリア（閃光→突入）', 'Flash & Clear (Flashbang + Entry)')), flashOk);
      add('entry', 'gasClear', gasLabel(t('ガス＆クリア（催涙ガス→突入）', 'Gas & Clear (CS Gas + Entry)')), gasOk);
      if (!c2Locked) {
        add('entry', 'c2Clear', t('C2＆クリア（爆破ブリーチ突入）', 'C2 & Clear (Explosive Breach)'), true);
      }
      add('entry', 'breachClear', t('ブリーチ＆クリア（蹴破り強行突入）', 'Breach & Clear (Kick Entry)'), true);
    } else if (ctx.stairTarget) {
      const up = ctx.stairTarget.up;
      add('prep', 'stack', t('スタックアップ（階段口で待機）', 'Stack Up (Hold at Stairs)'), true);
      if (ctx.groundPoint) add('prep', 'move', moveLabel(ctx.groundPoint), true);
      add('prep', 'overwatch', overwatchLabel, true);
      add(
        'entry',
        'stairClear',
        up
          ? t('階段クリア（上階口へ照準・縦列で上る）', 'Clear Stairs (Cover Top, File Up)')
          : t('階段クリア（下階口へ照準・縦列で下りる）', 'Clear Stairs (Cover Bottom, File Down)'),
        true,
      );
      add(
        'entry',
        'stairFlashClear',
        flashLabel(
          up
            ? t('フラッシュ＆階段クリア（上階口へ閃光→上る）', 'Flash & Clear Stairs (Bang Top, Move Up)')
            : t('フラッシュ＆階段クリア（下階口へ閃光→下りる）', 'Flash & Clear Stairs (Bang Bottom, Move Down)'),
        ),
        flashOk,
      );
    } else if (ctx.areaTarget) {
      add('prep', 'stack', t('スタックアップ（入口脇で待機）', 'Stack Up (Hold by Entry)'), true);
      if (ctx.groundPoint) add('prep', 'move', moveLabel(ctx.groundPoint), true);
      add('prep', 'overwatch', overwatchLabel, true);
      add('entry', 'clear', t('突入＆クリア（2名突入制圧）', 'Breach & Clear (2-Man Entry)'), true);
      add('entry', 'flashClear', flashLabel(t('フラッシュ＆クリア（閃光→突入）', 'Flash & Clear (Flashbang + Entry)')), flashOk);
      add('entry', 'gasClear', gasLabel(t('ガス＆クリア（催涙ガス→突入）', 'Gas & Clear (CS Gas + Entry)')), gasOk);
    } else if (ctx.groundPoint) {
      add('prep', 'move', moveLabel(ctx.groundPoint), true);
      add('prep', 'overwatch', overwatchLabel, true);
    } else {
      add('prep', 'overwatch', overwatchLabel, true);
    }

    add('general', 'hold', t('現在位置で待機・周囲警戒', 'Hold Position & Cover'), true);
    add('general', 'follow', t('追従・隊形復帰', 'Fall In / Follow'), true);
    const cancel: MenuItem = { order: null, label: t('キャンセル', 'Cancel'), enabled: true };
    const of = (z: Zone): MenuItem[] => flow.filter((f) => f.zone === z).map((f) => f.item);
    // 上: 準備（流れの最初がキャンセルのすぐ上 = 逆順）／キャンセル／下: 突入 → 待機・追従
    return [...of('prep').reverse(), cancel, ...of('entry'), ...of('general')];
  }

  private refreshHeader(element: SquadElement, ctx: OrderContext): void {
    this.titleEl.textContent = t('部隊指揮', 'SQUAD COMMAND');
    this.footEl.textContent = t(
      '[マウス上下/ホイール] 選択   [右離し / 左クリック] 実行   [T] チーム切替   [中クリック] 中止',
      '[Mouse Up/Down/Wheel] Select   [Release RMB / LMB] Execute   [T] Switch Team   [MMB] Cancel',
    );
    this.elBadge.textContent = `[T] ${tElementLabel(element, this.cfg.elementLabels[element])}`;
    this.elBadge.style.color = ELEMENT_CSS[element];
    if (ctx.restrainTarget) {
      this.ctxEl.textContent = t(`照準対象: ${ctx.restrainTarget.label}`, `Target: ${ctx.restrainTarget.label}`);
    } else if (ctx.door) {
      this.ctxEl.textContent = t(
        `照準対象: ドア${ctx.door.locked ? ' [施錠]' : ` (${ctx.door.stage})`}`,
        `Target: Door${ctx.door.locked ? ' [Locked]' : ` (${ctx.door.stage})`}`,
      );
    } else if (ctx.stairTarget) {
      this.ctxEl.textContent = ctx.stairTarget.up
        ? t('照準対象: 階段（上り・上階口が死角）', 'Target: Stairs (Up — top is a blind spot)')
        : t('照準対象: 階段（下り・下階口が死角）', 'Target: Stairs (Down — bottom is a blind spot)');
    } else if (ctx.areaTarget) {
      const roomLabel = tRoomName(ctx.areaTarget.room.name);
      this.ctxEl.textContent = t(
        `照準対象: ${roomLabel}${ctx.areaTarget.door ? '（開放ドア）' : '（別エリア）'}`,
        `Target: ${roomLabel}${ctx.areaTarget.door ? ' (Open Door)' : ' (Adjacent Area)'}`,
      );
    } else if (ctx.groundPoint) {
      this.ctxEl.textContent = t(
        `照準対象: 移動地点 (${ctx.groundPoint.dist.toFixed(1)}m)`,
        `Target: Waypoint (${ctx.groundPoint.dist.toFixed(1)}m)`,
      );
    } else {
      this.ctxEl.textContent = t('照準対象: なし（全隊共通コマンド）', 'Target: None (General Commands)');
    }
  }

  private renderRows(): void {
    this.listEl.textContent = '';
    this.items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'cqb-cmd-row' + (i === this.selectedIdx ? ' active' : '') + (item.enabled ? '' : ' disabled');
      const lbl = document.createElement('span');
      lbl.textContent = item.label;
      row.append(lbl);
      this.listEl.appendChild(row);
    });
  }

  handleMenuEvent(
    event: OrderMenuEvent,
    value: number,
    element: SquadElement,
    onExecute: (order: SquadOrder, ctx: OrderContext) => void,
  ): void {
    if (this.disposed) return;

    if (event === 'open') {
      this.ctxCache = null;
      const ctx = this.resolveContext(element);
      this.openContext = ctx;
      this.items = this.buildMenuItems(ctx);
      this.selectedIdx = Math.max(0, this.items.findIndex((it) => it.order === null));
      this.offsetPx = this.selectedIdx * 28;
      this.open = true;
      this.refreshHeader(element, ctx);
      this.renderRows();
      this.menuEl.hidden = false;
      this.updatePreview(ctx);
      return;
    }

    if (!this.open || !this.openContext) return;

    if (event === 'cancel') {
      this.close();
      return;
    }

    if (event === 'confirm') {
      const item = this.items[this.selectedIdx];
      const ctx = { ...this.openContext, element };
      this.close();
      if (item && item.order && item.enabled) onExecute(item.order, ctx);
      return;
    }

    if (event === 'move' || event === 'wheel') {
      const step = event === 'wheel' ? Math.sign(value) * 28 : value;
      const maxOff = Math.max(0, (this.items.length - 1) * 28);
      this.offsetPx = Math.max(0, Math.min(maxOff, this.offsetPx + step));
      const nextIdx = Math.round(this.offsetPx / 28);
      if (nextIdx !== this.selectedIdx) {
        this.selectedIdx = nextIdx;
        this.renderRows();
      }
    }
  }

  syncElementBadge(element: SquadElement): void {
    if (!this.open || !this.openContext) return;
    this.openContext.element = element;
    this.refreshHeader(element, this.openContext);
    this.updatePreview(this.openContext);
  }

  private updatePreview(ctx: OrderContext): void {
    if (!this.open || !ctx.groundPoint || ctx.door || ctx.areaTarget || ctx.stairTarget || ctx.restrainTarget) {
      this.previewMesh.visible = false;
      return;
    }
    const g = ctx.groundPoint;
    this.previewMesh.visible = true;
    this.previewMesh.position.set(g.x, g.y, g.z);
    this.previewMesh.rotation.y = g.yawRad;
    this.previewMesh.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshBasicMaterial) {
        o.material.color.setHex(ELEMENT_COLORS[ctx.element]);
      }
    });
  }

  updateActiveMarkers(markers: readonly ActiveMarker[]): void {
    if (this.disposed) return;
    const activeSet = new Set<SquadElement>();
    for (const m of markers) {
      activeSet.add(m.key);
      const grp = this.activeMeshes.get(m.key);
      if (grp) {
        grp.visible = true;
        grp.position.set(m.x, m.y, m.z);
        grp.rotation.y = m.yawRad;
      }
    }
    for (const [k, grp] of this.activeMeshes) {
      if (!activeSet.has(k)) grp.visible = false;
    }
  }

  close(): void {
    this.open = false;
    this.openContext = null;
    this.menuEl.hidden = true;
    this.previewMesh.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
    this.menuEl.remove();
    this.styleEl.remove();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geos.length = 0;
    this.mats.length = 0;
    this.root.removeFromParent();
  }
}
