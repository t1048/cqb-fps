import * as THREE from 'three';
import type { OrderMenuEvent } from '../core/InputManager';
import type { RoomDef, SquadConfig, SquadElement, SquadOrder, Vec3 } from '../core/types';
import type { PlayerController } from '../player/PlayerController';
import type { Door, DoorSystem } from '../world/Door';
import type { Collider } from '../world/WorldBuilder';
import { hasLineOfSight } from '../weapons/Flashbang';
import { blockedAt } from '../ai/EngageBehavior';
import type { EntityManager } from '../ai/EntityManager';
import { SuspectState } from '../core/events';

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

export interface OrderContext {
  element: SquadElement;
  door: Door | null;
  areaTarget: AreaClearTarget | null;
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

interface MenuItem {
  num: number;
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
.cqb-cmd-num{font:bold 11px monospace;min-width:18px;text-align:center;color:#7ce2f0;
  background:rgba(255,255,255,.08);border-radius:3px;padding:1px 3px}
.cqb-cmd-foot{margin-top:6px;padding-top:5px;border-top:1px solid #243648;font-size:11px;color:#8ba4bc}
`;

function rayBoxDist(ray: THREE.Ray, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, tmpBox: THREE.Box3, tmpHit: THREE.Vector3): number | null {
  tmpBox.min.set(minX, minY, minZ);
  tmpBox.max.set(maxX, maxY, maxZ);
  const hit = ray.intersectBox(tmpBox, tmpHit);
  return hit ? hit.distanceTo(ray.origin) : null;
}

/**
 * 視線レイが最初に当たる歩行面（floor / stair コライダの上面）を返す。壁・遮蔽物・ドア板より奥は除外。
 * 無限 y=0 平面は使わないため、階段穴越しに下階・地下の床面を指せる。上面は見下ろすときだけ当たる。
 */
export function raycastGround(
  colliders: readonly Collider[],
  eye: Vec3,
  dir: Vec3,
  maxDist: number,
  ray: THREE.Ray = new THREE.Ray(),
  tmpBox: THREE.Box3 = new THREE.Box3(),
  tmpHit: THREE.Vector3 = new THREE.Vector3(),
): { t: number; y: number } | null {
  ray.origin.set(eye.x, eye.y, eye.z);
  ray.direction.set(dir.x, dir.y, dir.z);
  let wallT = maxDist;
  for (const c of colliders) {
    if (c.kind === 'floor' || c.kind === 'stair' || c.kind === 'ceiling') continue;
    const a = c.aabb;
    const d = rayBoxDist(ray, a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z, tmpBox, tmpHit);
    if (d !== null && d < wallT) wallT = d;
  }
  let bestT = Infinity;
  let bestY = 0;
  if (dir.y >= -1e-4) return null;
  for (const c of colliders) {
    if (c.kind !== 'floor' && c.kind !== 'stair') continue;
    const a = c.aabb;
    if (eye.y <= a.max.y) continue;
    const tPlane = (a.max.y - eye.y) / dir.y;
    if (tPlane > 0.6 && tPlane <= wallT && tPlane < bestT) {
      const hx = eye.x + dir.x * tPlane;
      const hz = eye.z + dir.z * tPlane;
      if (hx >= a.min.x && hx <= a.max.x && hz >= a.min.z && hz <= a.max.z) {
        bestT = tPlane;
        bestY = a.max.y;
      }
    }
  }
  return Number.isFinite(bestT) ? { t: bestT, y: bestY } : null;
}

/**
 * 部隊指揮メニューUI・照準コンテキスト判定・3D床面戦術マーカー管理。
 * Tab / 中クリック保持で展開し、マウス上下・ホイールで項目選択、離す/左クリック/数字キーで決定。
 */
export class CommandMenu {
  readonly root = new THREE.Group();
  private readonly styleEl = document.createElement('style');
  private readonly menuEl = document.createElement('div');
  private readonly elBadge = document.createElement('span');
  private readonly ctxEl = document.createElement('div');
  private readonly listEl = document.createElement('div');
  private readonly footEl = document.createElement('div');

  private readonly previewMesh: THREE.Group;
  private readonly activeMeshes = new Map<SquadElement, THREE.Group>();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];

  private items: MenuItem[] = [];
  private offsetPx = 0;
  private selectedIdx = 0;
  private open = false;
  private openContext: OrderContext | null = null;
  private disposed = false;

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
  ) {
    this.root.name = 'squad-markers';
    this.styleEl.textContent = STYLE;
    document.head.appendChild(this.styleEl);

    this.menuEl.className = 'cqb-cmd';
    this.menuEl.hidden = true;
    const head = document.createElement('div');
    head.className = 'cqb-cmd-head';
    const title = document.createElement('strong');
    title.textContent = '部隊指揮';
    this.elBadge.className = 'cqb-cmd-el';
    head.append(title, this.elBadge);

    this.ctxEl.className = 'cqb-cmd-ctx';
    this.footEl.className = 'cqb-cmd-foot';
    this.footEl.textContent = '[1-9 / 左クリック / 右離し] 実行   [T] チーム切替   [中クリック] 中止';
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

  resolveContext(element: SquadElement): OrderContext {
    this.player.getEyePosition(this.eye);
    const cp = Math.cos(this.player.pitchRad);
    this.dir.set(
      -Math.sin(this.player.yawRad) * cp,
      Math.sin(this.player.pitchRad),
      -Math.cos(this.player.yawRad) * cp,
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

    return {
      element,
      door,
      areaTarget,
      groundPoint,
      restrainTarget,
      aimDir: { x: -Math.sin(this.player.yawRad), z: -Math.cos(this.player.yawRad) },
    };
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
    this.ray.origin.copy(this.eye);
    this.ray.direction.copy(this.dir);
    let wallT = maxDist;
    for (const c of this.colliders) {
      if (c.kind === 'floor' || c.kind === 'stair' || c.kind === 'ceiling') continue;
      const a = c.aabb;
      const d = rayBoxDist(this.ray, a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z, this.tmpBox, this.tmpHit);
      if (d !== null && d < wallT) wallT = d;
    }
    return wallT;
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
          best = { id: s.id, kind: 'suspect', label: '投降した容疑者', x: s.body.px, y: s.body.footY, z: s.body.pz };
        }
      }
      if (s.hasUncollectedEvidence) {
        const wp = s.body.getDroppedWeaponPos();
        if (wp) {
          const d = testPoint(wp.x, wp.y + 0.08, wp.z);
          if (d !== null) {
            bestDist = d;
            best = { id: s.id, kind: 'evidence', label: '証拠品', x: wp.x, y: s.body.footY, z: wp.z };
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
        best = { id: c.id, kind: 'civilian', label: '人質・民間人', x: c.body.px, y: c.body.footY, z: c.body.pz };
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

  private buildMenuItems(ctx: OrderContext): MenuItem[] {
    const out: MenuItem[] = [];
    let nextNum = 1;
    const add = (order: SquadOrder | null, label: string, enabled = true) => {
      out.push({ num: order === null ? 0 : nextNum++, order, label, enabled });
    };

    if (ctx.restrainTarget) {
      add('restrain', `対象を確保（${ctx.restrainTarget.label}）`, true);
    } else if (ctx.door) {
      add('stack', 'スタックアップ（扉脇で待機）', true);
      add('clear', ctx.door.locked ? 'オープン＆クリア（蹴破り突入）' : 'オープン＆クリア（2名突入制圧）', true);
      add('flashClear', 'フラッシュ＆クリア（閃光→突入）', true);
      add('gasClear', 'ガス＆クリア（催涙ガス→突入）', true);
      add('c2Clear', 'C2＆クリア（爆破ブリーチ突入）', true);
      add('breachClear', 'ブリーチ＆クリア（強行突入）', true);
      add('pieDoor', '扉開放・外から警戒', !ctx.door.locked);
    } else if (ctx.areaTarget) {
      add('clear', '突入＆クリア（2名突入制圧）', true);
      add('flashClear', 'フラッシュ＆クリア（閃光→突入）', true);
      add('gasClear', 'ガス＆クリア（催涙ガス→突入）', true);
      add('stack', 'スタックアップ（入口脇で待機）', true);
      if (ctx.groundPoint) {
        add('move', `指定位置へ移動・警戒 (${ctx.groundPoint.dist.toFixed(1)}m)`, true);
      }
      add('overwatch', '現在位置から照準方向をロック', true);
    } else if (ctx.groundPoint) {
      add('move', `指定位置へ移動・警戒 (${ctx.groundPoint.dist.toFixed(1)}m)`, true);
      add('overwatch', '現在位置から照準方向をロック', true);
    } else {
      add('overwatch', '現在位置から照準方向をロック', true);
    }

    add('hold', '現在位置で待機・周囲警戒', true);
    add('follow', '追従・隊形復帰', true);
    add(null, 'キャンセル', true);
    return out;
  }

  private refreshHeader(element: SquadElement, ctx: OrderContext): void {
    this.elBadge.textContent = `[T] ${this.cfg.elementLabels[element]}`;
    this.elBadge.style.color = ELEMENT_CSS[element];
    if (ctx.restrainTarget) {
      this.ctxEl.textContent = `照準対象: ${ctx.restrainTarget.label}`;
    } else if (ctx.door) {
      this.ctxEl.textContent = `照準対象: ドア${ctx.door.locked ? ' [施錠]' : ` (${ctx.door.stage})`}`;
    } else if (ctx.areaTarget) {
      this.ctxEl.textContent = `照準対象: ${ctx.areaTarget.room.name}${ctx.areaTarget.door ? '（開放ドア）' : '（別エリア）'}`;
    } else if (ctx.groundPoint) {
      this.ctxEl.textContent = `照準対象: 移動地点 (${ctx.groundPoint.dist.toFixed(1)}m)`;
    } else {
      this.ctxEl.textContent = '照準対象: なし（全隊共通コマンド）';
    }
  }

  private renderRows(): void {
    this.listEl.textContent = '';
    this.items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'cqb-cmd-row' + (i === this.selectedIdx ? ' active' : '') + (item.enabled ? '' : ' disabled');
      const num = document.createElement('span');
      num.className = 'cqb-cmd-num';
      num.textContent = item.order === null ? 'ESC' : String(item.num);
      const lbl = document.createElement('span');
      lbl.textContent = item.label;
      row.append(num, lbl);
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
      const ctx = this.resolveContext(element);
      this.openContext = ctx;
      this.items = this.buildMenuItems(ctx);
      this.selectedIdx = 0;
      this.offsetPx = 0;
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

    if (event === 'select') {
      const item = this.items.find((it) => it.num === value);
      const ctx = { ...this.openContext, element };
      this.close();
      if (item && item.order && item.enabled) onExecute(item.order, ctx);
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
    if (!this.open || !ctx.groundPoint || ctx.door || ctx.areaTarget || ctx.restrainTarget) {
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
