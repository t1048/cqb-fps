import * as THREE from 'three';
import { isEn, t, tRoomName } from '../../core/i18n';
import type { RoomDef, Vec3 } from '../../core/types';
import { segmentHitsAABB } from '../../ai/HostageShield';
import { blockedAtFiltered } from '../../ai/SquadRoute';
import type { FriendlyPos } from '../../ai/cqbEntry';
import type { EntryPortal } from '../../ai/SwatTactics';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { Door } from '../../world/Door';
import type { SwatHunter } from './SwatHunter';
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
  type CoverCell,
  type SwatTeamDeps,
} from './swatTypes';

export interface SwatCoverageHost {
  readonly d: SwatTeamDeps;
  readonly rooms: readonly RoomDef[];
  readonly hunters: readonly SwatHunter[];
  readonly radioCd: number;
  portals(): EntryPortal[];
  doorById(id: string): Door | null;
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
  private coverCd = 0;
  private droneCd = 0;
  private readonly ray = new THREE.Ray();
  private readonly box = new THREE.Box3();
  private readonly hit = new THREE.Vector3();

  constructor(private readonly host: SwatCoverageHost) {}

  tickTimers(dt: number): void {
    this.droneCd = Math.max(0, this.droneCd - dt);
  }

  tickCoverage(dt: number, started: boolean): void {
    this.coverCd -= dt;
    if (started && this.coverCd <= 0) {
      this.coverCd = COVER_TICK;
      for (const h of this.host.hunters) {
        if (h.alive && h.state !== 'staging' && h.blindLeft <= 0) this.scanCoverage(h);
      }
    }
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
    for (const r of this.host.rooms) {
      const fy = r.floorY ?? 0;
      const nx = Math.max(1, Math.round((r.width - 0.8) / COVER_CELL));
      const nz = Math.max(1, Math.round((r.depth - 0.8) / COVER_CELL));
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const x = r.x - r.width / 2 + 0.4 + ((i + 0.5) * (r.width - 0.8)) / nx;
          const z = r.z - r.depth / 2 + 0.4 + ((j + 0.5) * (r.depth - 0.8)) / nz;
          if (blockedAtFiltered(this.host.d.colliders, x, z, 0.3, fy)) continue;
          const zone = this.indoorRoomAt(x, z, fy)?.id ?? r.id;
          out.push({ x, y: fy, z, room: r.id, seen: false, bad: false, zone });
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

    const cells = this.coverCells();
    const eye = { x: h.body.px, y: h.body.footY + 1.5, z: h.body.pz };
    const fx = -Math.sin(h.body.yawRad);
    const fz = -Math.cos(h.body.yawRad);
    const cosHalf = Math.cos((COVER_FOV_DEG / 2) * DEG2RAD);
    const touched = new Set<string>();
    for (const c of cells) {
      if (c.seen || Math.abs(c.y - h.body.footY) > 0.9) continue;
      if (c.room !== allowedRoom && (c.zone ?? c.room) !== allowedRoom) continue;
      const dx = c.x - eye.x;
      const dz = c.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d > COVER_RANGE) continue;
      if (d > COVER_NEAR && (dx * fx + dz * fz) / d < cosHalf) continue;
      if (d > 0.6 && !hasLineOfSight(this.host.d.colliders, eye, { x: c.x, y: c.y + 1.0, z: c.z })) continue;
      c.seen = true;
      touched.add(c.room);
    }
    for (const id of touched) this.checkRoomClear(id, h);
  }

  /** PoD 保持中に look 方向の ±50° 扇・8m 内の同室セルを seen にマークする（§5-2） */
  markEntryLookSector(h: SwatHunter, look: Vec3): void {
    const here = this.indoorRoomAt(h.body.px, h.body.pz, h.body.footY);
    if (!here) return;
    const eye = { x: h.body.px, y: h.body.footY + 1.5, z: h.body.pz };
    const lx = look.x - eye.x;
    const lz = look.z - eye.z;
    const ll = Math.hypot(lx, lz);
    if (ll < 1e-4) return;
    const fx = lx / ll;
    const fz = lz / ll;
    const cosHalf = Math.cos(ENTRY_LOOK_HALF_DEG * DEG2RAD);
    const touched = new Set<string>();
    for (const c of this.coverCells()) {
      if (c.seen || Math.abs(c.y - h.body.footY) > 0.9) continue;
      if (c.room !== here.id && (c.zone ?? c.room) !== here.id) continue;
      const dx = c.x - eye.x;
      const dz = c.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d > ENTRY_LOOK_RANGE) continue;
      if (d > 0.6 && (dx * fx + dz * fz) / d < cosHalf) continue;
      if (d > 0.6 && !hasLineOfSight(this.host.d.colliders, eye, { x: c.x, y: c.y + 1.0, z: c.z })) continue;
      c.seen = true;
      touched.add(c.room);
    }
    for (const id of touched) this.checkRoomClear(id, h);
  }

  /** 部屋の全マスを確認し終えたら「クリア」を無線で報告する */
  checkRoomClear(roomId: string, by: SwatHunter): void {
    if (this.cleared.has(roomId)) return;
    const mine = this.coverCells().filter((c) => c.room === roomId);
    if (mine.some((c) => !c.seen && !c.bad)) return;
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
   * 全マスをクリアしたら再捜索（ドローンの熱源探知で大まかな位置を共有）。
   */
  pickCell(h: SwatHunter): CoverCell | null {
    let cell = this.nearestCell(h);
    if (cell) return cell;
    // 全区画クリア: 再捜索
    for (const c of this.coverCells()) c.seen = false;
    this.cleared.clear();
    if (this.coverCells().every((c) => c.bad)) for (const c of this.coverCells()) c.bad = false;
    if (this.droneCd <= 0) {
      this.droneCd = 30;
      const p = this.host.d.player.position;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 4;
      const guess = { x: p.x + Math.cos(a) * rr, y: p.y, z: p.z + Math.sin(a) * rr };
      this.host.radio(
        h,
        '全区画クリア、容疑者なし。ドローンが熱源を探知、その付近を再捜索する。',
        'No suspect. Drone has a heat signature, moving.',
        true,
      );
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

  nearestCell(h: SwatHunter): CoverCell | null {
    const confine = this.unclearedIndoorRoom(h)?.id ?? null;
    const taken: CoverCell[] = [];
    for (const x of this.host.hunters) if (x !== h && x.alive && x.goalCell) taken.push(x.goalCell);
    let best: CoverCell | null = null;
    let bestScore = Infinity;
    for (const c of this.coverCells()) {
      if (c.seen || c.bad) continue;
      if (confine && c.room !== confine) continue;
      let score = Math.hypot(c.x - h.body.px, c.z - h.body.pz) + Math.abs(c.y - h.body.footY) * 6;
      if (h.goalRoom === c.room) score -= 3; // 今いる部屋を先に塗りつぶす
      for (const tCell of taken) if (Math.hypot(tCell.x - c.x, tCell.z - c.z) < 4 && Math.abs(tCell.y - c.y) < 0.9) score += 20;
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
      this.host.radio(by, `${r.name}、クリア。`, isEn() ? `${tRoomName(r.name)}, clear.` : 'Room clear.');
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
    const cells = this.coverCells().filter((c) => c.room === room.id);
    if (cells.length === 0 || cells.every((c) => c.seen || c.bad)) return null;
    return room;
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
      const a = c.body.getAABB();
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
      if (segmentHitsAABB(other.body.getAABB(), from, to)) return true;
    }
    return false;
  }

  /** 指定隊員以外の生存 SWAT 隊員の位置一覧（ローレディ判定用） */
  otherHunterPositions(exclude: SwatHunter): FriendlyPos[] {
    const out: FriendlyPos[] = [];
    for (const other of this.host.hunters) {
      if (other === exclude || !other.alive) continue;
      out.push({ x: other.body.px, y: other.body.footY, z: other.body.pz });
    }
    return out;
  }
}
