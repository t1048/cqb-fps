import type { GameEventBus } from '../core/events';
import { CivilianState, SuspectState } from '../core/events';
import { t } from '../core/i18n';
import type { RoomDef, SuspectAlertConfig, Vec3 } from '../core/types';
import type { SuspectAlert } from './SuspectAlert';

/**
 * 人質処刑の脅迫（SWAT モードのドラマ要素）。
 *
 * 警戒度が execute 段階（既定 90）以上のまま sustainSec 続き、かつ交渉の緊張が高い（または閃光弾を repeatedFlashes 回以上使った）とき、
 * 容疑者が「近づいたら人質を殺す！」と脅迫を始め、countdownSec 後に人質を 1 名処刑する。
 * 阻止できる: (1) 隊員（プレイヤー含む）が人質のいる部屋に到達する (2) 警告コールで容疑者が従う (3) 警戒度が cancelBelow を下回る
 * (4) 容疑者の投降・無力化 / 人質の確保。イベント 1 回（成立・阻止どちらでも）ごとに cooldownSec は次の脅迫が起こらない。
 */

export interface ThreatSuspectLike {
  readonly id: string;
  readonly alive: boolean;
  readonly state: SuspectState;
  readonly body: { px: number; pz: number; footY: number };
  /** 警告コールを受けた回数 */
  readonly warnCount: number;
  /** 人質を保持している/掴みに行っている */
  readonly isHoldingHostage: boolean;
  /** 警告コールに従って投降させる（成功で true） */
  forceSurrender(): boolean;
}

export interface ThreatCivilianLike {
  readonly id: string;
  readonly alive: boolean;
  readonly evacuated: boolean;
  readonly state: CivilianState;
  readonly body: { px: number; pz: number; footY: number };
}

export interface ThreatDeps {
  cfg: SuspectAlertConfig;
  alert: Pick<SuspectAlert, 'value' | 'executeSustainSec' | 'flashCount'>;
  suspects(): Iterable<ThreatSuspectLike>;
  civilians(): Iterable<ThreatCivilianLike>;
  rooms: readonly RoomDef[];
  /** プレイヤーと生存隊員の位置 */
  officers(): Iterable<{ x: number; z: number; footY: number }>;
  bus: GameEventBus;
  /** 字幕を出す */
  say(text: string, sec: number): void;
  /** 人質を処刑する（死亡処理・銃声は呼び出し側） */
  execute(civilianId: string, suspectId: string): void;
  /** 交渉の緊張が高いままか */
  tensionHigh(): boolean;
  rand?: () => number;
}

export interface ThreatPulse {
  x: number;
  y: number;
  z: number;
  /** 0（開始）〜1（処刑直前） */
  progress: number;
}

type Active = {
  suspectId: string;
  civilianId: string;
  roomId: string | null;
  left: number;
  warnSeen: number;
};

export const HOSTAGE_THREAT_LINES_JA = [
  '近づいたら人質を殺す！',
  'こっちに来るな！ 人質がどうなってもいいのか！',
  '一歩でも入ってみろ、こいつを撃つぞ！',
] as const;
export const HOSTAGE_THREAT_LINES_EN = [
  "Come any closer and I kill the hostage!",
  "Stay back! Do you want her dead?!",
  "One more step in here and I shoot!",
] as const;

export class HostageThreat {
  private active: Active | null = null;
  /** 次の脅迫まで残り秒（開始直後は 0） */
  private cooldown = 0;
  /** 開始から経過した脅迫イベントの回数 */
  eventCount = 0;
  executedCount = 0;
  preventedCount = 0;

  constructor(private readonly d: ThreatDeps) {}

  get isActive(): boolean {
    return this.active !== null;
  }

  get cooldownLeft(): number {
    return this.cooldown;
  }

  get countdownLeft(): number {
    return this.active?.left ?? 0;
  }

  /** ミニマップのパルス表示用。脅迫中のみ人質の位置を返す。 */
  pulse(): ThreatPulse | null {
    const a = this.active;
    if (!a) return null;
    const civ = this.findCivilian(a.civilianId);
    if (!civ) return null;
    return {
      x: civ.body.px,
      y: civ.body.footY,
      z: civ.body.pz,
      progress: 1 - a.left / this.d.cfg.execution.countdownSec,
    };
  }

  update(dt: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    const a = this.active;
    if (!a) {
      this.tryStart();
      return;
    }
    this.tickActive(a, dt);
  }

  private findSuspect(id: string): ThreatSuspectLike | null {
    for (const s of this.d.suspects()) if (s.id === id) return s;
    return null;
  }

  private findCivilian(id: string): ThreatCivilianLike | null {
    for (const c of this.d.civilians()) if (c.id === id) return c;
    return null;
  }

  private roomOf(x: number, z: number, y: number): RoomDef | null {
    let best: RoomDef | null = null;
    let bestArea = Infinity;
    for (const r of this.d.rooms) {
      if (Math.abs((r.floorY ?? 0) - y) > 1.25) continue;
      if (Math.abs(x - r.x) > r.width / 2 || Math.abs(z - r.z) > r.depth / 2) continue;
      const area = r.width * r.depth;
      if (area < bestArea) {
        bestArea = area;
        best = r;
      }
    }
    return best;
  }

  private tryStart(): void {
    if (this.cooldown > 0) return;
    const ex = this.d.cfg.execution;
    const al = this.d.alert;
    if (al.value < this.d.cfg.tiers.execute || al.executeSustainSec < ex.sustainSec) return;
    if (!this.d.tensionHigh() && al.flashCount < ex.repeatedFlashes) return;

    let bestS: ThreatSuspectLike | null = null;
    let bestC: ThreatCivilianLike | null = null;
    let bestScore = Infinity;
    for (const s of this.d.suspects()) {
      if (!s.alive || s.state === SuspectState.SURRENDER || s.state === SuspectState.ARRESTED || s.state === SuspectState.DOWN) continue;
      for (const c of this.d.civilians()) {
        if (!c.alive || c.evacuated || c.state === CivilianState.SECURED) continue;
        if (Math.abs(c.body.footY - s.body.footY) > 1.5) continue;
        const dist = Math.hypot(c.body.px - s.body.px, c.body.pz - s.body.pz);
        if (dist > 9) continue;
        // 人質を掴んでいる容疑者を最優先
        const score = dist - (s.isHoldingHostage ? 100 : 0);
        if (score < bestScore) {
          bestScore = score;
          bestS = s;
          bestC = c;
        }
      }
    }
    if (!bestS || !bestC) return;
    const room = this.roomOf(bestC.body.px, bestC.body.pz, bestC.body.footY);
    this.active = {
      suspectId: bestS.id,
      civilianId: bestC.id,
      roomId: room?.id ?? null,
      left: ex.countdownSec,
      warnSeen: bestS.warnCount,
    };
    this.eventCount++;
    const rand = this.d.rand ?? Math.random;
    const i = Math.floor(rand() * HOSTAGE_THREAT_LINES_JA.length) % HOSTAGE_THREAT_LINES_JA.length;
    this.d.say(
      t(`容疑者「${HOSTAGE_THREAT_LINES_JA[i]}」`, `Suspect: "${HOSTAGE_THREAT_LINES_EN[i]}"`),
      3.2,
    );
    this.d.bus.emit('hostageThreat', {
      phase: 'start',
      suspectId: bestS.id,
      civilianId: bestC.id,
      roomId: room?.id ?? null,
      pos: { x: bestS.body.px, y: bestS.body.footY + 1.2, z: bestS.body.pz },
      countdownSec: ex.countdownSec,
    });
  }

  private end(a: Active, phase: 'prevented' | 'executed', reason?: 'reached' | 'complied' | 'calmed' | 'resolved'): void {
    const s = this.findSuspect(a.suspectId);
    this.active = null;
    this.cooldown = this.d.cfg.execution.cooldownSec;
    if (phase === 'executed') this.executedCount++;
    else this.preventedCount++;
    const pos: Vec3 = s ? { x: s.body.px, y: s.body.footY + 1.2, z: s.body.pz } : { x: 0, y: 0, z: 0 };
    this.d.bus.emit('hostageThreat', {
      phase,
      suspectId: a.suspectId,
      civilianId: a.civilianId,
      roomId: a.roomId,
      pos,
      countdownSec: Math.max(0, a.left),
      reason,
    });
  }

  private tickActive(a: Active, dt: number): void {
    const s = this.findSuspect(a.suspectId);
    const c = this.findCivilian(a.civilianId);
    if (!s || !c || !c.alive || c.evacuated || c.state === CivilianState.SECURED) {
      this.d.say(t('人質は無事に確保された', 'The hostage has been secured'), 2.4);
      this.end(a, 'prevented', 'resolved');
      return;
    }
    if (!s.alive || s.state === SuspectState.SURRENDER || s.state === SuspectState.ARRESTED || s.state === SuspectState.DOWN) {
      this.d.say(t('脅迫していた容疑者を制圧した', 'The threatening suspect has been neutralized'), 2.4);
      this.end(a, 'prevented', s.alive ? 'complied' : 'resolved');
      return;
    }
    // (1) 隊員が人質のいる部屋に到達した
    const room = a.roomId ? (this.d.rooms.find((r) => r.id === a.roomId) ?? null) : null;
    for (const o of this.d.officers()) {
      const inRoom = room
        ? Math.abs((room.floorY ?? 0) - o.footY) <= 1.25 &&
          Math.abs(o.x - room.x) <= room.width / 2 &&
          Math.abs(o.z - room.z) <= room.depth / 2
        : Math.hypot(o.x - c.body.px, o.z - c.body.pz) < 3 && Math.abs(o.footY - c.body.footY) <= 1.25;
      if (inRoom) {
        this.d.say(t('間に合った — 脅迫は失敗した', 'We got there in time — the threat is defused'), 2.6);
        this.end(a, 'prevented', 'reached');
        return;
      }
    }
    // (2) 警告コール: 一定確率で容疑者が従う
    if (s.warnCount > a.warnSeen) {
      a.warnSeen = s.warnCount;
      const rand = this.d.rand ?? Math.random;
      if (rand() < this.d.cfg.execution.warnComplyChance && s.forceSurrender()) {
        this.d.say(t('容疑者「わかった、撃たないでくれ！」', 'Suspect: "Okay, okay, don\'t shoot!"'), 2.6);
        this.end(a, 'prevented', 'complied');
        return;
      }
      this.d.say(t('容疑者「黙れ！ 近づくな！」', 'Suspect: "Shut up! Stay back!"'), 1.8);
    }
    // (3) 警戒度が下がった（落ち着きを取り戻した）
    if (this.d.alert.value < this.d.cfg.execution.cancelBelow) {
      this.d.say(t('容疑者は落ち着きを取り戻したようだ', 'The suspect seems to have calmed down'), 2.4);
      this.end(a, 'prevented', 'calmed');
      return;
    }
    a.left -= dt;
    if (a.left <= 0) {
      this.d.execute(a.civilianId, a.suspectId);
      this.d.say(t('銃声 — 人質が殺害された', 'A gunshot — the hostage was executed'), 3);
      this.end(a, 'executed');
    }
  }
}
