import * as THREE from 'three';
import { t, tRoomName } from '../../core/i18n';
import { RESCAN, pickRadio, roomClearLine } from '../../ai/radioLines';
import type { RoomDef, Vec3 } from '../../core/types';
import { segmentHitsAABB } from '../../ai/HostageShield';
import { blockedAtFiltered } from '../../ai/SquadRoute';
import type { FriendlyPos } from '../../ai/cqbEntry';
import type { EntryPortal } from '../../ai/SwatTactics';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { Door } from '../../world/Door';
import type { AABB } from '../../world/WorldBuilder';
import type { SwatHunter } from './SwatHunter';
import type { RoutePlan } from './swatRoutePlanner';
import {
  COVER_CELL,
  COVER_FOV_DEG,
  COVER_NEAR,
  COVER_RANGE,
  COVER_TICK,
  DEG2RAD,
  ENTRY_LOOK_HALF_DEG,
  ENTRY_LOOK_RANGE,
  HOSTAGE_COVER_DEG,
  STALL_BUSY_CAP_SEC,
  STALL_LEVEL_SEC,
  type CoverCell,
  type SwatTeamDeps,
} from './swatTypes';

export interface SwatCoverageHost {
  readonly d: SwatTeamDeps;
  readonly rooms: readonly RoomDef[];
  readonly hunters: readonly SwatHunter[];
  readonly radioCd: number;
  readonly lastSightingAge: number;
  portals(): EntryPortal[];
  doorById(id: string): Door | null;
  planRoute(from: Vec3, goal: Vec3, skip?: ReadonlySet<string>): RoutePlan;
  radio(h: SwatHunter | undefined, text: string, voice: string, force?: boolean): void;
}

/** 部屋の掃討・カバレッジセル管理・射線判定を担当するコーディネータ */
export class SwatCoverage {
  private readonly cleared = new Set<string>();
  /** 一度掃討し終えた部屋。再捜索でマスを戻しても、再び「未クリアなので隣室へ出ない」にはしない */
  private readonly sweptRooms = new Set<string>();
  /** pickCell 中に hunt へ切り替えたい隊員（sweep 更新中の再入を避けるため次フレームで遷移） */
  private readonly pendingHunt = new Set<SwatHunter>();
  private cells: CoverCell[] | null = null;
  private readonly cellsByRoom = new Map<string, CoverCell[]>();
  private readonly cellsByZone = new Map<string, CoverCell[]>();
  private readonly touchedRooms = new Set<string>();
  private readonly takenScratch: CoverCell[] = [];
  private readonly otherPosPool: FriendlyPos[] = [];
  private readonly otherPosOut: FriendlyPos[] = [];
  private readonly aabbScratch: AABB = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  private readonly eyeTmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly cellPtTmp: Vec3 = { x: 0, y: 0, z: 0 };
  private scanBudget = 2;
  private scanCursor = 0;
  private rescanCd = 0;
  private readonly ray = new THREE.Ray();
  private readonly box = new THREE.Box3();
  private readonly hit = new THREE.Vector3();

  constructor(private readonly host: SwatCoverageHost) {}

  tickTimers(dt: number): void {
    this.rescanCd = Math.max(0, this.rescanCd - dt);
  }

  private stallSig = -1;
  private stallSec = 0;

  tickCoverage(dt: number, started: boolean): void {
    if (!started) return;
    this.watchStall(dt);
    const hunters = this.host.hunters;
    const n = hunters.length;
    if (n === 0) return;
    this.scanBudget = Math.min(n, this.scanBudget + (dt * n) / COVER_TICK);
    const toVisit = Math.min(n, Math.floor(this.scanBudget));
    if (toVisit <= 0) return;
    let scanned = 0;
    let visited = 0;
    while (visited < toVisit && scanned < 2) {
      if (this.scanCursor >= n) this.scanCursor = 0;
      const h = hunters[this.scanCursor++]!;
      visited++;
      if (h.alive && h.state !== 'staging' && h.blindLeft <= 0) {
        this.scanCoverage(h);
        scanned++;
      }
    }
    this.scanBudget -= visited;
  }

  /** 掃討の進捗（確認済みマス数・クリア済み部屋数・全マス数）。テスト・停滞監視用 */
  progress(): { seen: number; cleared: number; total: number; rooms: number } {
    const cells = this.coverCells();
    let seen = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i]!.seen) seen++;
    return { seen, cleared: this.cleared.size, total: cells.length, rooms: this.sweptRooms.size };
  }

  flushPendingHunt(): void {
    for (const h of this.pendingHunt) {
      if (h.alive && h.state === 'sweep' && h.huntTarget) h.setState('hunt');
    }
    this.pendingHunt.clear();
  }

  /** 屋内を格子に区切る（初回のみ）。壁・家具で塞がれたマスは除く */
  coverCells(): CoverCell[] {
    if (this.cells) return this.cells;
    const out: CoverCell[] = [];
    this.cellsByRoom.clear();
    this.cellsByZone.clear();
    for (const r of this.host.rooms) {
      const fy = r.floorY ?? 0;
      const nx = Math.max(1, Math.round((r.width - 0.8) / COVER_CELL));
      const nz = Math.max(1, Math.round((r.depth - 0.8) / COVER_CELL));
      let roomBucket = this.cellsByRoom.get(r.id);
      if (!roomBucket) {
        roomBucket = [];
        this.cellsByRoom.set(r.id, roomBucket);
      }
      let roomZoneBucket = this.cellsByZone.get(r.id);
      if (!roomZoneBucket) {
        roomZoneBucket = [];
        this.cellsByZone.set(r.id, roomZoneBucket);
      }
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const x = r.x - r.width / 2 + 0.4 + ((i + 0.5) * (r.width - 0.8)) / nx;
          const z = r.z - r.depth / 2 + 0.4 + ((j + 0.5) * (r.depth - 0.8)) / nz;
          if (blockedAtFiltered(this.host.d.colliders, x, z, 0.3, fy)) continue;
          const zone = this.indoorRoomAt(x, z, fy)?.id ?? r.id;
          const cell: CoverCell = { x, y: fy, z, room: r.id, seen: false, bad: false, zone };
          out.push(cell);
          roomBucket.push(cell);
          roomZoneBucket.push(cell);
          if (zone !== r.id) {
            let zb = this.cellsByZone.get(zone);
            if (!zb) {
              zb = [];
              this.cellsByZone.set(zone, zb);
            }
            zb.push(cell);
          }
        }
      }
    }
    this.cells = out;
    return out;
  }

  /**
   * 隊員の視界（視野角・距離・遮蔽）に入ったマスを確認済みにする。
   * §5-3: 観測者が対象セルと同じ屋内部屋にいる（または敷居 0.6m 以内、スタック待機外）場合のみ seen にする。
   */
  scanCoverage(h: SwatHunter): void {
    const here = this.indoorRoomAt(h.body.px, h.body.pz, h.body.footY);
    let nearSillRoom: string | null = null;
    if (!here && h.state !== 'stack') {
      for (const p of this.host.portals()) {
        if (Math.abs(p.sillY - h.body.footY) > 0.75) continue;
        const door = this.host.doorById(p.id);
        const cx = door ? door.centerX : (p.outside.x + p.inside.x) / 2;
        const cz = door ? door.centerZ : (p.outside.z + p.inside.z) / 2;
        if (Math.hypot(h.body.px - cx, h.body.pz - cz) <= 0.6) {
          nearSillRoom = this.indoorRoomAt(p.inside.x, p.inside.z, p.sillY)?.id ?? null;
          break;
        }
      }
    }
    const allowedRoom = here?.id ?? nearSillRoom;
    if (!allowedRoom) return;

    this.coverCells();
    const roomCells = this.cellsByZone.get(allowedRoom);
    if (!roomCells || roomCells.length === 0) return;

    const eye = this.eyeTmp;
    eye.x = h.body.px;
    eye.y = h.body.footY + 1.5;
    eye.z = h.body.pz;
    const fx = -Math.sin(h.body.yawRad);
    const fz = -Math.cos(h.body.yawRad);
    const cosHalf = Math.cos((COVER_FOV_DEG / 2) * DEG2RAD);
    this.touchedRooms.clear();
    const cellPt = this.cellPtTmp;
    for (let i = 0; i < roomCells.length; i++) {
      const c = roomCells[i]!;
      if (c.seen || Math.abs(c.y - h.body.footY) > 0.9) continue;
      const dx = c.x - eye.x;
      const dz = c.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d > COVER_RANGE) continue;
      if (d > COVER_NEAR && (dx * fx + dz * fz) / d < cosHalf) continue;
      if (d > 0.6) {
        cellPt.x = c.x;
        cellPt.y = c.y + 1.0;
        cellPt.z = c.z;
        if (!hasLineOfSight(this.host.d.colliders, eye, cellPt)) continue;
      }
      c.seen = true;
      this.touchedRooms.add(c.room);
    }
    for (const id of this.touchedRooms) this.checkRoomClear(id, h);
  }

  /** PoD 保持中に look 方向の ±50° 扇・8m 内の同室セルを seen にマークする（§5-2） */
  markEntryLookSector(h: SwatHunter, look: Vec3): void {
    const here = this.indoorRoomAt(h.body.px, h.body.pz, h.body.footY);
    if (!here) return;
    this.coverCells();
    const roomCells = this.cellsByZone.get(here.id);
    if (!roomCells || roomCells.length === 0) return;

    const eye = this.eyeTmp;
    eye.x = h.body.px;
    eye.y = h.body.footY + 1.5;
    eye.z = h.body.pz;
    const lx = look.x - eye.x;
    const lz = look.z - eye.z;
    const ll = Math.hypot(lx, lz);
    if (ll < 1e-4) return;
    const fx = lx / ll;
    const fz = lz / ll;
    const cosHalf = Math.cos(ENTRY_LOOK_HALF_DEG * DEG2RAD);
    this.touchedRooms.clear();
    const cellPt = this.cellPtTmp;
    for (let i = 0; i < roomCells.length; i++) {
      const c = roomCells[i]!;
      if (c.seen || Math.abs(c.y - h.body.footY) > 0.9) continue;
      const dx = c.x - eye.x;
      const dz = c.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d > ENTRY_LOOK_RANGE) continue;
      if (d > 0.6 && (dx * fx + dz * fz) / d < cosHalf) continue;
      if (d > 0.6) {
        cellPt.x = c.x;
        cellPt.y = c.y + 1.0;
        cellPt.z = c.z;
        if (!hasLineOfSight(this.host.d.colliders, eye, cellPt)) continue;
      }
      c.seen = true;
      this.touchedRooms.add(c.room);
    }
    for (const id of this.touchedRooms) this.checkRoomClear(id, h);
  }

  /** 部屋の全マスを確認し終えたら「クリア」を無線で報告する */
  checkRoomClear(roomId: string, by: SwatHunter): void {
    if (this.cleared.has(roomId)) return;
    this.coverCells();
    const mine = this.cellsByRoom.get(roomId);
    if (!mine) return;
    for (let i = 0; i < mine.length; i++) {
      const c = mine[i]!;
      if (!c.seen && !c.bad) return;
    }
    const r = this.host.rooms.find((x) => x.id === roomId);
    if (r) this.markCleared(r, by);
  }

  markSeenAround(x: number, z: number, y: number, radius: number): void {
    for (const c of this.coverCells()) {
      if (Math.abs(c.y - y) < 0.9 && Math.hypot(c.x - x, c.z - z) <= radius) c.seen = true;
    }
  }

  markBad(c: CoverCell): void {
    c.bad = true;
  }

  /**
   * 次に向かう未クリアのマス。最寄りを優先し、他の隊員の目標とは離れた場所を選んで手分けする。
   * 全マスをクリアしたら再捜索（大まかな位置を共有して再捜索）。
   */
  pickCell(h: SwatHunter): CoverCell | null {
    let cell = this.nearestCell(h);
    if (cell) return cell;
    // 全区画クリア: 再捜索
    const allCells = this.coverCells();
    for (let i = 0; i < allCells.length; i++) allCells[i]!.seen = false;
    this.cleared.clear();
    if (allCells.every((c) => c.bad)) for (let i = 0; i < allCells.length; i++) allCells[i]!.bad = false;
    if (this.rescanCd <= 0) {
      this.rescanCd = 30;
      const p = this.host.d.player.position;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 4;
      const guess = { x: p.x + Math.cos(a) * rr, y: p.y, z: p.z + Math.sin(a) * rr };
      const [scanJa, scanEn] = pickRadio(RESCAN);
      this.host.radio(h, scanJa, scanEn, true);
      for (const x of this.host.hunters) {
        if (
          !x.alive ||
          x.state === 'engage' ||
          x.state === 'rush' ||
          x.state === 'breach' ||
          x.state === 'pie' ||
          x.state === 'entry' ||
          x.state === 'stack' ||
          x.state === 'disarm' ||
          x.state === 'restrain' ||
          x.state === 'staging' ||
          (x.leader && x.leader.alive)
        ) continue;
        x.huntTarget = { ...guess };
        if (x !== h) x.setState('hunt');
      }
      if (!h.leader || !h.leader.alive) {
        h.huntTarget = { ...guess };
        this.pendingHunt.add(h);
      }
    }
    cell = this.nearestCell(h);
    return cell;
  }

  /** 未クリアの屋内にいるとき、その部屋の次の未確認マス。 */
  nextClearCell(h: SwatHunter): CoverCell | null {
    if (!this.unclearedIndoorRoom(h)) return null;
    return this.nearestCell(h);
  }

  /** セル c の近傍（同階・約3.5m）に確認済みマスがあるか */
  private bordersSeen(c: CoverCell): boolean {
    const pool = this.cellsByRoom.get(c.room) ?? [];
    for (let i = 0; i < pool.length; i++) {
      const o = pool[i]!;
      if (o.seen && Math.hypot(o.x - c.x, o.z - c.z) < 3.5) return true;
    }
    // 部屋をまたぐ隣接（ドア越し）も、どこかの確認済み他室マスが近ければ縁とみなす
    for (const o of this.coverCells()) {
      if (o.seen && o.room !== c.room && Math.abs(o.y - c.y) < 0.9 && Math.hypot(o.x - c.x, o.z - c.z) < 3.5) return true;
    }
    return false;
  }

  /**
   * 停滞監視: クリア済みマス数が一定時間増えず、交戦中でもないなら、
   * 立ち止まっている掃討役の目標を引き直して前進させる（bad マスも復活）。
   */
  private pursuitSec = 0;

  /**
   * 追撃監視: 交戦も目撃も 15 秒以上途絶えたら、掃討役を（大まかな位置の推定で）
   * プレイヤー付近へ向かわせる。奥へ逃げても SWAT が止まらないようにする。
   */
  private watchPursuit(dt: number): void {
    const hs = this.host.hunters;
    let busy = false;
    for (const x of hs) {
      if (x.alive && (x.state === 'engage' || x.state === 'rush')) busy = true;
    }
    if (busy || this.host.lastSightingAge < 15) {
      this.pursuitSec = 0;
      return;
    }
    this.pursuitSec += dt;
    if (this.pursuitSec < 3) return;
    this.pursuitSec = -12; // 次の更新まで 15 秒空ける
    const p = this.host.d.player.position;
    for (const x of hs) {
      if (!x.alive || x.state !== 'sweep' || x.leader) continue;
      const room = this.indoorRoomAt(x.body.px, x.body.pz, x.body.footY);
      if (room) this.sweptRooms.add(room.id); // 部屋に閉じ込められず次へ進ませる
      const a = Math.random() * Math.PI * 2;
      const rr = 2 + Math.random() * 4;
      x.huntTarget = { x: p.x + Math.cos(a) * rr, y: p.y, z: p.z + Math.sin(a) * rr };
      x.setState('hunt');
    }
  }

  /** 停滞監視の累計無進捗秒とエスカレーション段階（0=未発動） */
  private stallLevel = 0;

  /**
   * 停滞監視（最後の安全網）。掃討の進捗（確認済みマス・クリア部屋・解錠ドア数）が止まり、誰も交戦/ブリーチ中でないなら
   * 段階的に強めていく: ①目標の引き直し（再計画） ②未確認マスへの最寄り施錠ドアをブリーチ
   * ③大まかな位置への再捜索 ④プレイヤー位置へ直接押し込み。進捗が出たら段階を戻す。
   */
  private watchStall(dt: number): void {
    this.watchPursuit(dt);
    const cells = this.coverCells();
    let seen = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i]!.seen) seen++;
    let unlocked = 0;
    for (const door of this.host.d.doors.doors) if (!door.locked) unlocked++;
    const sig = seen + this.cleared.size * 1000 + unlocked * 100000;
    if (sig !== this.stallSig) {
      this.stallSig = sig;
      this.stallSec = 0;
      this.stallLevel = 0;
      return;
    }
    for (const x of this.host.hunters) {
      if (!x.alive) continue;
      // 交戦・ブリーチ・突入手順の最中は進行中とみなす（それぞれ固有のタイムアウトを持つ）
      if (x.state === 'engage' || x.state === 'rush' || x.state === 'breach' || x.state === 'disarm' || x.state === 'restrain' || x.state === 'stack' || x.state === 'pie' || x.state === 'entry') {
        this.stallSec = Math.min(this.stallSec, STALL_BUSY_CAP_SEC);
        return;
      }
    }
    this.stallSec += dt;
    const next = STALL_LEVEL_SEC[Math.min(this.stallLevel, STALL_LEVEL_SEC.length - 1)]!;
    if (this.stallSec < next) return;
    this.stallLevel = Math.min(this.stallLevel + 1, STALL_LEVEL_SEC.length);
    if (this.stallLevel >= STALL_LEVEL_SEC.length) this.stallSec = STALL_LEVEL_SEC[STALL_LEVEL_SEC.length - 2]!; // 最終段階は繰り返す
    this.escalateStall(this.stallLevel);
  }

  /** 無進捗が続いたときの段階的な打開策 */
  escalateStall(level: number): void {
    const hs = this.host.hunters.filter((x) => x.alive && x.state !== 'staging');
    const free = hs.filter((x) => !x.leader && (x.state === 'sweep' || x.state === 'hunt'));
    if (free.length === 0) return;
    const cells = this.coverCells();
    if (level === 1) {
      for (let i = 0; i < cells.length; i++) cells[i]!.bad = false;
      for (const x of hs) x.resetPlanning();
      return;
    }
    if (level === 2) {
      // 未確認マスのうち近いものへ、施錠ドアが塞いでいれば最初のドアをブリーチする
      const pool = cells.filter((c) => !c.seen);
      for (const x of free) {
        const here = { x: x.body.px, y: x.body.footY, z: x.body.pz };
        const ranked = pool
          .map((c) => ({ c, d: Math.hypot(c.x - here.x, c.z - here.z) + Math.abs(c.y - here.y) * 6 }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 8);
        for (const { c } of ranked) {
          const plan = this.host.planRoute(here, { x: c.x, y: c.y, z: c.z });
          if (plan.reachable) {
            x.goalCell = c;
            x.goalTime = 0;
            break;
          }
          if (plan.door && x.tryBeginBreach({ x: c.x, y: c.y, z: c.z }, plan.door.id)) return;
        }
      }
      return;
    }
    const p = this.host.d.player.position;
    if (level === 3) {
      const [scanJa, scanEn] = pickRadio(RESCAN);
      this.host.radio(free[0], scanJa, scanEn, true);
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 3;
      const guess = { x: p.x + Math.cos(a) * rr, y: p.y, z: p.z + Math.sin(a) * rr };
      for (const x of free) {
        x.resetPlanning();
        x.huntTarget = { ...guess };
        x.setState('hunt');
      }
      return;
    }
    // level >= 4: 直接押し込み（真の位置へ向かう。施錠ドアが邪魔ならブリーチする）
    for (const x of free) {
      x.resetPlanning();
      x.huntTarget = { x: p.x, y: p.y, z: p.z };
      x.huntingFlank = false;
      x.setState('hunt');
    }
  }

  nearestCell(h: SwatHunter): CoverCell | null {
    const confine = this.unclearedIndoorRoom(h)?.id ?? null;
    this.coverCells();
    const pool = confine ? (this.cellsByRoom.get(confine) ?? []) : this.coverCells();
    const taken = this.takenScratch;
    taken.length = 0;
    for (const x of this.host.hunters) if (x !== h && x.alive && x.goalCell) taken.push(x.goalCell);
    let best: CoverCell | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      if (c.seen || c.bad) continue;
      let score = Math.hypot(c.x - h.body.px, c.z - h.body.pz) + Math.abs(c.y - h.body.footY) * 6;
      if (h.goalRoom === c.room) score -= 3; // 今いる部屋を先に塗りつぶす
      // クリア済みエリアの縁（確認済みマスに隣接）を優先し、クリア範囲を連続的に広げる
      if (this.bordersSeen(c)) score -= 5;
      for (let j = 0; j < taken.length; j++) {
        const tCell = taken[j]!;
        if (Math.hypot(tCell.x - c.x, tCell.z - c.z) < 4 && Math.abs(tCell.y - c.y) < 0.9) score += 20;
      }
      score += Math.random() * 1.2;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) h.goalRoom = best.room;
    return best;
  }

  markCleared(r: RoomDef, by: SwatHunter): void {
    this.sweptRooms.add(r.id);
    if (this.cleared.has(r.id)) return;
    this.cleared.add(r.id);
    if (this.host.radioCd <= 0 && Math.random() < 0.45) {
      const [clearJa, clearEn] = roomClearLine(r.name, false);
      this.host.radio(by, clearJa, clearEn);
    }
  }

  /** 追跡の到達地点周辺は確認済みとみなす */
  markRoomAt(x: number, z: number, y: number): void {
    this.markSeenAround(x, z, y, 2.5);
  }

  roomAt(x: number, z: number, y: number): RoomDef | null {
    return (
      this.host.rooms.find(
        (r) => Math.abs((r.floorY ?? 0) - y) < 0.75 && Math.abs(x - r.x) <= r.width / 2 && Math.abs(z - r.z) <= r.depth / 2,
      ) ?? null
    );
  }

  /** 重なる場合は小さい屋内部屋を優先する。屋外区画は返さない。 */
  indoorRoomAt(x: number, z: number, y: number): RoomDef | null {
    let best: RoomDef | null = null;
    let bestArea = Infinity;
    for (const r of this.host.rooms) {
      if (r.outdoor) continue;
      if (Math.abs((r.floorY ?? 0) - y) > 0.75) continue;
      if (Math.abs(x - r.x) > r.width / 2 || Math.abs(z - r.z) > r.depth / 2) continue;
      const area = r.width * r.depth;
      if (area < bestArea) {
        bestArea = area;
        best = r;
      }
    }
    return best;
  }

  /** 立っている場所が屋内で、未確認マスが残っていればその部屋。屋外と掃討済みは null。 */
  unclearedIndoorRoom(h: SwatHunter): RoomDef | null {
    const room = this.indoorRoomAt(h.body.px, h.body.pz, h.body.footY);
    if (!room || this.cleared.has(room.id) || this.sweptRooms.has(room.id)) return null;
    this.coverCells();
    const cells = this.cellsByRoom.get(room.id);
    if (!cells || cells.length === 0) return null;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!c.seen && !c.bad) return room;
    }
    return null;
  }

  /** ハンターと目標が同じ屋内部屋にいるか。 */
  sameIndoorRoom(x: number, z: number, y: number, goal: Vec3): boolean {
    const here = this.indoorRoomAt(x, z, y);
    if (!here) return false;
    return this.indoorRoomAt(goal.x, goal.z, goal.y)?.id === here.id;
  }

  roomName(pos: Vec3): string {
    const r = this.roomAt(pos.x, pos.z, pos.y);
    return r ? tRoomName(r.name) : t('前方', 'ahead');
  }

  /** 人質を抱えていて盾が有効（暴れて崩れていない） */
  hostageShieldUp(): boolean {
    return this.playerHoldsHostage() && (this.host.d.shieldActive?.() ?? true);
  }

  playerHoldsHostage(): boolean {
    for (const c of this.host.d.civilians()) if (c.alive && c.shieldedBy === 'player') return true;
    return false;
  }

  /**
   * プレイヤーが人質を盾にしており、(x,z) がプレイヤー正面 ±HOSTAGE_COVER_DEG にある。
   * 人質の体は視界を開けるため前方の横にずらしてあるので、盾の扇は体の位置ではなく向いている正面で測る。
   */
  coveredByHostage(x: number, z: number): boolean {
    let holding = false;
    for (const c of this.host.d.civilians()) {
      if (c.alive && c.shieldedBy === 'player') {
        holding = true;
        break;
      }
    }
    if (!holding) return false;
    if (this.host.d.shieldActive && !this.host.d.shieldActive()) return false; // 人質が暴れて盾が崩れている
    const p = this.host.d.player.position;
    const yaw = this.host.d.player.yawRad;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const tx = x - p.x;
    const tz = z - p.z;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-3) return true;
    return (fx * tx + fz * tz) / tl >= Math.cos(HOSTAGE_COVER_DEG * DEG2RAD);
  }

  /** from→to の射線上に生存民間人の体がある */
  civilianInLine(from: Vec3, to: Vec3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    this.ray.origin.set(from.x, from.y, from.z);
    this.ray.direction.set(dx / len, dy / len, dz / len);
    for (const c of this.host.d.civilians()) {
      if (!c.alive) continue;
      const a = c.body.getAABB(this.aabbScratch);
      this.box.min.set(a.min.x - 0.05, a.min.y, a.min.z - 0.05);
      this.box.max.set(a.max.x + 0.05, a.max.y, a.max.z + 0.05);
      if (this.ray.intersectBox(this.box, this.hit) && this.hit.distanceTo(this.ray.origin) < len - 0.2) return true;
    }
    return false;
  }

  /** from→to の射線上に他の生存 SWAT 隊員の体がある */
  friendlyInLine(shooter: SwatHunter, from: Vec3, to: Vec3): boolean {
    for (const other of this.host.hunters) {
      if (other === shooter || !other.alive) continue;
      if (segmentHitsAABB(other.body.getAABB(this.aabbScratch), from, to)) return true;
    }
    return false;
  }

  /** 指定隊員以外の生存 SWAT 隊員の位置一覧（ローレディ判定用） */
  otherHunterPositions(exclude: SwatHunter): FriendlyPos[] {
    let count = 0;
    for (let i = 0; i < this.host.hunters.length; i++) {
      const other = this.host.hunters[i]!;
      if (other === exclude || !other.alive) continue;
      let slot = this.otherPosPool[count];
      if (!slot) {
        slot = { x: 0, y: 0, z: 0 };
        this.otherPosPool.push(slot);
      }
      slot.x = other.body.px;
      slot.y = other.body.footY;
      slot.z = other.body.pz;
      this.otherPosOut[count++] = slot;
    }
    this.otherPosOut.length = count;
    return this.otherPosOut;
  }
}
