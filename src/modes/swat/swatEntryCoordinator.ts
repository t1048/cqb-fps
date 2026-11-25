import type { RoomDef, Vec3 } from '../../core/types';
import { blockedAtFiltered, pathSegmentClear, reachableRouteLength } from '../../ai/SquadRoute';
import { layoutStackSlots } from '../../ai/stackSlots';
import {
  computeEntryOrder,
  cqbPortalFromStackSlotPortal,
  cqbRoomFromRoomDef,
  planEntry,
  type EntryMode,
} from '../../ai/cqbEntry';
import {
  assignCellPortals,
  buildStackSlotPortal,
  entryRouteDest,
  filterReachableExteriorEntries,
  isIndoorPoint,
  listExteriorEntries,
  type EntryPortal,
  type EntryReach,
  type EntryRoute,
} from '../../ai/SwatTactics';
import type { Door } from '../../world/Door';
import type { Collider } from '../../world/WorldBuilder';
import { assignSwatStackSlots, describePortalDirection } from './swatHelpers';
import type { SwatHunter } from './SwatHunter';
import {
  ENTRY_COUNTDOWN_SEC,
  ENTRY_DOOR_OPEN_WAIT,
  ENTRY_WALK_RADIUS,
  PIE_TIMEOUT_SEC,
  RADIO_STAGGER_SEC,
  ROUTE_CACHE_MAX,
  ROUTE_CACHE_TTL,
  STACK_OFFSET,
  STACK_PERSONAL_SPACE,
  STACK_TIMEOUT_SEC,
  type EntryGroup,
  type SwatTeamDeps,
} from './swatTypes';

export interface SwatEntryHost {
  readonly d: SwatTeamDeps;
  readonly rooms: readonly RoomDef[];
  readonly hunters: readonly SwatHunter[];
  readonly currentPressure: number;
  readonly radioSpeakGap: number;
  readonly radioQueueLength: number;
  doorById(id: string): Door | null;
  indoorRoomAt(x: number, z: number, y: number): RoomDef | null;
  isDoorBeingBreached(doorId: string, exclude?: SwatHunter): boolean;
  radio(h: SwatHunter | undefined, text: string, voice: string, force?: boolean): void;
  queueRadio(h: SwatHunter | undefined, text: string, voice: string): void;
  trimRadioQueueToOne(): void;
}

/** 多方向同時突入（F6）・ポータル経路・スタック制御・パイ切り/CQB 突入グループを担当するコーディネータ */
export class SwatEntryCoordinator {
  private entryCache: EntryPortal[] | null = null;
  /** 屋外位置（2m 格子）から歩ける外壁入口。経路探索を毎フレーム回さない */
  private routeClock = 0;
  private readonly portalReachCache: { key: string; at: number; scored: EntryReach[] }[] = [];
  /** 多方向同時突入（F6）の状態 */
  private entryPhase: 'idle' | 'stacking' | 'countdown' | 'entered' = 'idle';
  private entryStackElapsed = 0;
  private entryCountdown = 0;
  private readonly reportedStackCells = new Set<number>();
  private readonly entryGroups: EntryGroup[] = [];
  private entryStyleOverride: EntryMode | null = null;

  constructor(private readonly host: SwatEntryHost) {}

  get clock(): number {
    return this.routeClock;
  }

  tickClock(dt: number): void {
    this.routeClock += dt;
  }

  /**
   * 屋外なら到達できる入口ドア経由、屋内なら目標そのもの。
   * attack は担当ドアに縛られず、目標へ最も早く着く入口を選ぶ。
   */
  routeFrom(
    x: number,
    z: number,
    y: number,
    goal: Vec3,
    preferPortalId?: string | null,
    mode: 'hold' | 'attack' = 'hold',
    blacklist?: { has(id: string): boolean },
    prevPhase?: EntryRoute['phase'] | null,
    prevEntryId?: string | null,
  ): EntryRoute {
    const from = { x, y, z };
    if (isIndoorPoint(this.host.d.rooms, x, z, y) || !isIndoorPoint(this.host.d.rooms, goal.x, goal.z, goal.y)) {
      return entryRouteDest(this.host.d.rooms, this.portals(), from, goal, preferPortalId, { prevPhase, prevEntryId });
    }
    let reachable = this.reachablePortalLengths(from);
    if (blacklist) reachable = reachable.filter((r) => !blacklist.has(r.id));
    return entryRouteDest(this.host.d.rooms, this.portals(), from, goal, preferPortalId, {
      reachable,
      mode,
      prevPhase,
      prevEntryId,
    });
  }

  /** ブラックリストを除いて、今の入口以外に歩ける外壁入口があるか */
  hasAlternateEntry(from: Vec3, exceptId: string, blacklist?: { has(id: string): boolean }): boolean {
    const scored = this.reachablePortalLengths(from);
    return scored.some((s) => s.id !== exceptId && !blacklist?.has(s.id));
  }

  /** 現在地から屋外側まで歩ける入口と経路長。位置を 2m で量子化して短時間キャッシュする。 */
  reachablePortalLengths(from: Vec3): EntryReach[] {
    const key = `${Math.round(from.x / 2)}:${Math.round(from.z / 2)}:${Math.round(from.y)}`;
    const hit = this.portalReachCache.find((c) => c.key === key);
    if (hit && this.routeClock - hit.at < ROUTE_CACHE_TTL) return hit.scored;
    const scored: EntryReach[] = [];
    for (const e of this.portals()) {
      if (Math.abs(e.sillY - from.y) >= 1.1) continue;
      const length = reachableRouteLength(
        { x: from.x, z: from.z },
        { x: e.outside.x, z: e.outside.z },
        from.y,
        this.host.d.colliders,
        this.host.d.bounds,
        ENTRY_WALK_RADIUS,
      );
      if (length === null) continue;
      scored.push({ id: e.id, length });
    }
    const entry = { key, at: this.routeClock, scored };
    const idx = this.portalReachCache.findIndex((c) => c.key === key);
    if (idx >= 0) this.portalReachCache[idx] = entry;
    else this.portalReachCache.push(entry);
    if (this.portalReachCache.length > ROUTE_CACHE_MAX) this.portalReachCache.shift();
    return scored;
  }

  portals(): EntryPortal[] {
    if (!this.entryCache) {
      this.entryCache = listExteriorEntries(
        this.host.d.rooms,
        this.host.d.doors.doors.map((door) => ({
          id: door.id,
          centerX: door.centerX,
          centerZ: door.centerZ,
          normalX: door.normalX,
          normalZ: door.normalZ,
          sillY: door.sillY,
        })),
      );
    }
    return this.entryCache;
  }

  /** 突入開始（F6: 複数の地上外壁ドアがあればセルごとに分散してスタック→カウントダウン同時突入） */
  beginAssault(): void {
    const living = this.host.hunters.filter((h) => h.alive);
    const anchor = living[0];
    if (!anchor || isIndoorPoint(this.host.d.rooms, anchor.body.px, anchor.body.pz, anchor.body.footY)) {
      this.entryPhase = 'entered';
      for (const h of living) h.setState('sweep');
      this.host.radio(anchor, '全隊、突入開始。容疑者は武装している、注意しろ。', 'All teams, go go go. Suspect is armed.');
      return;
    }

    const reachable = filterReachableExteriorEntries(
      this.portals(),
      { x: anchor.body.px, y: anchor.body.footY, z: anchor.body.pz },
      this.host.d.colliders,
      this.host.d.bounds,
    );
    if (reachable.length === 0) {
      this.entryPhase = 'entered';
      for (const h of living) h.setState('sweep');
      this.host.radio(anchor, '全隊、突入開始。容疑者は武装している、注意しろ。', 'All teams, go go go. Suspect is armed.');
      return;
    }

    // 生存セルごとにグループ化し、到達可能な外壁ドアを分散割り当てする
    const cellGroups = new Map<number, SwatHunter[]>();
    for (const h of living) {
      let grp = cellGroups.get(h.cellIndex);
      if (!grp) {
        grp = [];
        cellGroups.set(h.cellIndex, grp);
      }
      grp.push(h);
    }
    const orderedCells = [...cellGroups.entries()].sort((a, b) => a[0] - b[0]);
    const assignedPortals = assignCellPortals(orderedCells.length, reachable);

    // 単独隊員（1 名のみ）では同時突入の同期対象がいないため、スタック待機を省いて即座に突入する
    if (living.length <= 1) {
      const portal = assignedPortals[0] ?? null;
      for (const h of living) {
        h.assignedPortal = portal;
        h.stackSlot = null;
        h.stackReady = false;
        h.setState('sweep');
      }
      this.entryPhase = 'entered';
      this.host.radio(anchor, '全隊、突入開始。容疑者は武装している、注意しろ。', 'All teams, go go go. Suspect is armed.', true);
      return;
    }

    // 同じドアを共有するセル（house_compact など単一入口マップ）は合算して重ならないスタック位置を算出
    const byPortal = new Map<string, { portal: EntryPortal; members: SwatHunter[] }>();
    orderedCells.forEach(([, members], idx) => {
      const portal = assignedPortals[idx]!;
      let bucket = byPortal.get(portal.id);
      if (!bucket) {
        bucket = { portal, members: [] };
        byPortal.set(portal.id, bucket);
      }
      for (const m of members) bucket.members.push(m);
    });

    this.entryGroups.length = 0;
    for (const { portal, members } of byPortal.values()) {
      const door = this.host.doorById(portal.id);
      const standable = (x: number, z: number): boolean => !blockedAtFiltered(this.host.d.colliders, x, z, 0.3, portal.sillY);
      const sp = door ? buildStackSlotPortal(portal, door) : null;
      const cqb = sp ? cqbPortalFromStackSlotPortal(sp, portal.sillY) : null;
      const slots = sp
        ? layoutStackSlots(sp, members.length, STACK_OFFSET, STACK_PERSONAL_SPACE, standable)
        : [];
      const ranks = cqb && slots.length > 0 ? computeEntryOrder(cqb, slots) : [];
      const assignment = assignSwatStackSlots(
        members.map((m) => ({ x: m.body.px, z: m.body.pz })),
        members.map((m) => m.cellIndex),
        slots,
        cqb,
      );
      const room = this.host.indoorRoomAt(portal.inside.x, portal.inside.z, portal.sillY);
      const group: EntryGroup = {
        portal,
        cqb,
        room,
        slots,
        members: [...members],
        ranks,
        plans: null,
        phase: 'stacking',
        entryStyle: 'dynamic',
        breacher: null,
        pieHunter: null,
        clock: 0,
      };
      members.forEach((h, idx) => {
        const slotIdx = assignment[idx] ?? -1;
        const slot = slotIdx >= 0 ? slots[slotIdx] : undefined;
        const rankInfo = slotIdx >= 0 ? ranks[slotIdx] : undefined;
        h.assignedPortal = portal;
        h.stackSlot = slot ? { x: slot.x, y: portal.sillY, z: slot.z } : { ...portal.outside };
        h.stackReady = false;
        h.entryGroup = group;
        h.slotIndex = slotIdx;
        h.entryOrder = rankInfo ? rankInfo.order : members.length + idx;
        h.entryPlan = null;
        h.entryWp = 0;
        h.entryHold = 0;
        h.entryStartAt = null;
        h.entryCrossed = false;
        h.formSide = rankInfo ? rankInfo.side : h.cellIndex % 2 === 0 ? -1 : 1;
        h.setState('stack');
      });
      this.entryGroups.push(group);
    }

    this.entryPhase = 'stacking';
    this.entryStackElapsed = 0;
    this.entryCountdown = 0;
    this.reportedStackCells.clear();
    if (reachable.length >= 2 && orderedCells.length >= 2) {
      this.host.radio(anchor, '全班、各入口へ展開してスタックしろ。', 'All teams, split to assigned entries and stack up.', true);
    } else {
      this.host.radio(anchor, '全班、正面ドア前にスタックしろ。', 'All teams, stack up on the front entry.', true);
    }
  }

  /** 突入スタイル（dynamic = 強行突入, stealth = 半開き・パイ切り慎重突入） */
  getEntryStyle(): EntryMode {
    if (this.entryStyleOverride) return this.entryStyleOverride;
    return this.host.currentPressure < 0.55 && this.hasLivingCivilians() ? 'stealth' : 'dynamic';
  }

  /** 突入スタイルを明示指定する（null で圧力・人質状況に応じた自動選択へ戻す） */
  setEntryStyleOverride(mode: EntryMode | null): void {
    this.entryStyleOverride = mode;
  }

  private hasLivingCivilians(): boolean {
    for (const c of this.host.d.civilians()) {
      if (c.alive) return true;
    }
    return false;
  }

  shouldUseStealthForDoor(door: Door | null, group: EntryGroup): boolean {
    if (!door || door.locked || !group.cqb || !group.room) return false;
    if (this.entryStyleOverride === 'stealth') return true;
    if (this.entryStyleOverride === 'dynamic') return false;
    return door.angle < 45 && this.host.currentPressure < 0.55 && this.hasLivingCivilians();
  }

  /** 多方向同時突入（F6）のスタック完了待ち・カウントダウン進行 */
  updateEntryCoordination(dt: number): void {
    if (this.entryPhase !== 'stacking' && this.entryPhase !== 'countdown') return;
    const stacking = this.host.hunters.filter((h) => h.alive && h.state === 'stack');
    if (stacking.length === 0) {
      this.entryPhase = 'entered';
      return;
    }
    if (this.entryPhase === 'stacking') {
      this.entryStackElapsed += dt;
      // セルごとのスタック完了を無線報告
      const cellMap = new Map<number, SwatHunter[]>();
      for (const h of stacking) {
        let list = cellMap.get(h.cellIndex);
        if (!list) {
          list = [];
          cellMap.set(h.cellIndex, list);
        }
        list.push(h);
      }
      const mapCenter: Vec3 = this.host.rooms.length > 0
        ? {
            x: this.host.rooms.reduce((s, r) => s + r.x, 0) / this.host.rooms.length,
            y: 0,
            z: this.host.rooms.reduce((s, r) => s + r.z, 0) / this.host.rooms.length,
          }
        : { x: 0, y: 0, z: 0 };
      for (const [cellIdx, members] of cellMap) {
        if (this.reportedStackCells.has(cellIdx)) continue;
        if (members.every((m) => m.stackReady)) {
          this.reportedStackCells.add(cellIdx);
          const lead = members[0]!;
          const portalPos = lead.assignedPortal?.outside ?? { x: lead.body.px, y: lead.body.footY, z: lead.body.pz };
          const dir = describePortalDirection(portalPos, mapCenter);
          this.host.queueRadio(
            lead,
            `${lead.cellName}班、${dir.ja}配置完了。`,
            `${lead.cellName} team, set on ${dir.en}.`,
          );
        }
      }
      const allReady = stacking.every((h) => h.stackReady);
      if (allReady || this.entryStackElapsed >= STACK_TIMEOUT_SEC) {
        this.entryPhase = 'countdown';
        this.host.trimRadioQueueToOne();
        this.host.queueRadio(stacking[0], '全班配置完了。3、2、1、ブリーチ！', 'All teams set. 3, 2, 1, breach!');
        this.entryCountdown = Math.min(
          3.1,
          Math.max(ENTRY_COUNTDOWN_SEC, this.host.radioSpeakGap + this.host.radioQueueLength * RADIO_STAGGER_SEC + 0.15),
        );
      }
      return;
    }
    this.entryCountdown -= dt;
    if (this.entryCountdown <= 0) this.releaseStackedEntry();
  }

  /** カウントダウン完了: 施錠ドアはブリーチ開始、ステルス条件なら先頭員がパイ切り、それ以外は全員 'entry' へ移行する（§5-2） */
  releaseStackedEntry(): void {
    this.entryPhase = 'entered';
    const handled = new Set<SwatHunter>();
    for (const group of this.entryGroups) {
      const stacked = group.members.filter((h) => h.alive && h.state === 'stack');
      for (const h of stacked) handled.add(h);
      if (stacked.length === 0) {
        group.phase = 'done';
        continue;
      }
      const door = this.host.doorById(group.portal.id);
      if (door?.locked) {
        group.entryStyle = 'dynamic';
        const order = stacked
          .slice()
          .sort((a, b) => (a.leader ? 1 : 0) - (b.leader ? 1 : 0) || a.entryOrder - b.entryOrder);
        let breacher: SwatHunter | null = null;
        for (const cand of order) {
          if (!this.host.isDoorBeingBreached(door.id, cand) && cand.tryBeginBreach(group.portal.inside, door.id)) {
            breacher = cand;
            break;
          }
        }
        if (breacher) {
          group.phase = 'breach';
          group.breacher = breacher;
          group.clock = 0;
          for (const h of stacked) {
            if (h !== breacher) h.setState('entry');
          }
          continue;
        }
      }
      if (this.shouldUseStealthForDoor(door, group)) {
        const lead = stacked.slice().sort((a, b) => a.entryOrder - b.entryOrder)[0]!;
        group.entryStyle = 'stealth';
        group.phase = 'pie';
        group.pieHunter = lead;
        group.clock = 0;
        lead.beginPie(group, door!);
        // 後続隊員はスタック待機で後方・側方警戒を維持する
        continue;
      }
      group.entryStyle = 'dynamic';
      for (const h of stacked) h.setState('entry');
      this.beginGroupEntry(group, null);
    }
    // グループ外の残存スタック隊員がいれば従来どおり sweep へ
    for (const h of this.host.hunters) {
      if (h.alive && h.state === 'stack' && !handled.has(h)) h.setState('sweep');
    }
  }

  /** バケット全員の CQB 突入を開始する。breacher が指定された場合は order 0 に繰り上げる（§5-2）。 */
  beginGroupEntry(group: EntryGroup, breacher: SwatHunter | null): void {
    group.phase = 'entering';
    group.pieHunter = null;
    group.clock = 0;
    group.plans = null;
    if (breacher && breacher.alive) {
      const oldOrder = breacher.entryOrder;
      for (const m of group.members) {
        if (m === breacher) m.entryOrder = 0;
        else if (m.entryOrder < oldOrder) m.entryOrder += 1;
      }
      breacher.setState('entry');
    }
    for (const m of group.members) {
      if (!m.alive) continue;
      if (m.state === 'stack' || m.state === 'pie') m.setState('entry');
      if (m.state === 'entry') {
        m.entryPlan = null;
        m.entryWp = 0;
        m.entryHold = 0;
        m.entryStartAt = null;
        m.entryCrossed = false;
        m.resetHeading();
      }
    }
    const door = this.host.doorById(group.portal.id);
    if (door && !door.locked && door.angle < 55 && !door.isMoving) {
      door.command(door.maxAngle, group.entryStyle !== 'stealth', group.portal.outside.x, group.portal.outside.z);
    }
  }

  /** ブリーチ完了したドアに対応する突入グループを突入開始させる */
  onDoorBreached(by: SwatHunter, doorId: string): void {
    const grp = this.entryGroups.find((g) => g.portal.id === doorId && g.phase === 'breach');
    if (grp) this.beginGroupEntry(grp, by);
  }

  /** 各突入グループの扉開放待ち・突入計画生成・パイ切り／ブリーチ後続監視 */
  updateEntryGroups(dt: number): void {
    for (const group of this.entryGroups) {
      if (group.phase === 'done' || group.phase === 'stacking') continue;
      group.clock += dt;
      if (group.phase === 'pie') {
        const p = group.pieHunter;
        if (!p || !p.alive || p.state !== 'pie' || p.pieDone || group.clock >= PIE_TIMEOUT_SEC) {
          group.pieHunter = null;
          const remaining = group.members.filter((h) => h.alive && (h.state === 'stack' || h.state === 'pie'));
          if (remaining.length > 0) {
            for (const h of remaining) h.setState('entry');
            this.beginGroupEntry(group, null);
          } else {
            group.phase = 'done';
          }
        }
        continue;
      }
      if (group.phase === 'breach') {
        const b = group.breacher;
        if (!b || !b.alive || b.state !== 'breach') {
          const door = this.host.doorById(group.portal.id);
          if (!door || !door.locked) {
            this.beginGroupEntry(group, null);
          } else {
            const waiting = group.members
              .filter((h) => h.alive && h.state === 'entry')
              .sort((a, b2) => a.entryOrder - b2.entryOrder);
            let nextBreacher: SwatHunter | null = null;
            for (const cand of waiting) {
              if (!this.host.isDoorBeingBreached(door.id, cand) && cand.tryBeginBreach(group.portal.inside, door.id)) {
                nextBreacher = cand;
                break;
              }
            }
            if (nextBreacher) {
              group.breacher = nextBreacher;
            } else {
              group.phase = 'done';
              for (const h of waiting) h.setState('sweep');
            }
          }
        }
        continue;
      }
      // phase === 'entering'
      const entering = group.members.filter((h) => h.alive && h.state === 'entry');
      if (entering.length === 0) {
        group.phase = 'done';
        continue;
      }
      const door = this.host.doorById(group.portal.id);
      if (door && !door.locked && door.angle < 55) {
        if (!door.isMoving) {
          door.command(door.maxAngle, group.entryStyle !== 'stealth', group.portal.outside.x, group.portal.outside.z);
        }
        if (group.clock < ENTRY_DOOR_OPEN_WAIT) continue;
      }
      if (!group.plans) {
        if (group.cqb && group.room && group.slots.length > 0) {
          const passable = door && !door.locked ? new Set<Collider>(door.colliders) : undefined;
          group.plans = planEntry(group.cqb, cqbRoomFromRoomDef(group.room), group.slots, {
            isStandable: (p) => !blockedAtFiltered(this.host.d.colliders, p.x, p.z, 0.3, p.y, passable),
            reachable: (a, b) => pathSegmentClear(this.host.d.colliders, a, b, 0.25, group.portal.sillY, passable),
          });
          for (const m of group.members) {
            m.entryPlan = m.slotIndex >= 0 ? (group.plans[m.slotIndex] ?? null) : null;
          }
        } else {
          group.phase = 'done';
          for (const h of entering) h.setState('sweep');
        }
      }
    }
  }

  /** スタック・パイ切り中に接敵・被弾・ラッシュが発生した場合は即座に待機を解除して交戦へ合流させる */
  abortStacking(): void {
    const wasStacking = this.entryPhase === 'stacking' || this.entryPhase === 'countdown';
    if (wasStacking) this.entryPhase = 'entered';
    for (const g of this.entryGroups) {
      if (g.phase === 'stacking' || g.phase === 'pie') {
        g.phase = 'done';
        g.pieHunter = null;
        for (const m of g.members) {
          if (m.alive && (m.state === 'stack' || m.state === 'pie')) m.setState('sweep');
        }
      } else if (wasStacking) {
        g.phase = 'done';
      }
    }
    if (wasStacking) {
      for (const h of this.host.hunters) {
        if (h.alive && h.state === 'stack') h.setState('sweep');
      }
    }
  }

  dispose(): void {
    this.entryGroups.length = 0;
  }
}
