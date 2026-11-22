import type { EntityManager } from '../ai/EntityManager';
import type { GameEventBus, RoeViolationKind } from '../core/events';
import { CivilianState, SuspectState } from '../core/events';
import type { RoeConfig, ScoreKind } from '../core/types';
import { ScoreBoard, type ScoreEntry } from './ScoreBoard';

const PLAYER_ID = 'player';
const MAX_DT = 0.05;

/**
 * 交戦規定(MVP_SPEC §4)の判定。イベントを購読して ScoreBoard に加点/減点する。
 * 判定は「被弾時点の状態」で行うため、EntityManager より先にイベント購読できるよう
 * EntityManager 生成前に作り、生成後に attach() する（entityHit の購読順 = 登録順）。
 *
 * プレイヤー射撃(entityHit)の判定（容疑者）:
 *  1. SURRENDER / ARRESTED への加害 → fireOnSurrendered
 *  2. 敵対行動済み(発砲 or hostileStates 入り) → 違反なし。この被弾で倒れる(hp<=0)なら neutralize(+10)。被弾前の状態で判定するため購読順に依存
 *  3. 未警告 → fireWithoutWarning
 *  4. 警告済み・非敵対 → 加減点なし
 * 民間人にダメージ → civilianHit。
 */
export class RoE {
  readonly board: ScoreBoard;
  elapsed = 0;
  /** スコア項目が追加された時のコールバック（HUD 表示用） */
  onEntry: ((e: ScoreEntry) => void) | null = null;
  private entities: EntityManager | null = null;
  private readonly hostile = new Set<string>();
  private readonly provoked = new Set<string>();
  private readonly penalized = new Set<string>();
  private readonly harmedCivilians = new Set<string>();
  private readonly unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly cfg: RoeConfig,
    private readonly bus: GameEventBus,
  ) {
    this.board = new ScoreBoard(cfg);
    this.unsubs.push(
      bus.on('shotFired', (e) => {
        if (e.shooter !== PLAYER_ID) {
          this.provoked.delete(e.shooter);
          this.hostile.add(e.shooter);
        }
      }),
      bus.on('suspectStateChanged', (e) => {
        if (!this.cfg.hostileStates.includes(e.to)) return;
        // プレイヤーの先制被弾(takeHit)で ENGAGE になっただけでは正当防衛(hostile)にしない
        if (e.to === SuspectState.ENGAGE && this.provoked.has(e.id)) return;
        this.provoked.delete(e.id);
        this.hostile.add(e.id);
      }),
      bus.on('entityHit', (e) => this.onHit(e.targetId, e.shooter, e.damage, !!e.nonlethal)),
      bus.on('arrest', (e) => this.award('arrest', e.targetId)),
      bus.on('evidence', (e) => this.award('evidence', e.targetId)),
      bus.on('civilianStateChanged', (e) => {
        if (e.to === CivilianState.SECURED && !this.harmedCivilians.has(e.id)) this.award('civilianSecured', e.id);
      }),
    );
  }

  attach(entities: EntityManager): void {
    this.entities = entities;
    const maxScore =
      entities.suspects.size * (this.cfg.points.arrest + this.cfg.points.evidence) +
      entities.civilians.size * this.cfg.points.civilianSecured;
    this.board.setMaxPossibleScore(maxScore);
  }

  update(rawDt: number): void {
    this.elapsed += Math.min(rawDt, MAX_DT);
  }

  private award(kind: ScoreKind, targetId: string): void {
    const entry = this.board.add(kind, targetId, this.elapsed);
    this.onEntry?.(entry);
    if (entry.points < 0) {
      this.bus.emit('roeViolation', { kind: kind as RoeViolationKind, targetId, points: entry.points });
    }
  }

  private violate(kind: RoeViolationKind, targetId: string): void {
    const key = `${kind}:${targetId}`;
    if (this.cfg.violationOncePerTarget && this.penalized.has(key)) return;
    this.penalized.add(key);
    this.award(kind, targetId);
  }

  private onHit(targetId: string, shooter: string, damage: number, nonlethal: boolean): void {
    if (!this.entities) return;
    if (shooter.startsWith('ally_')) {
      const s = this.entities.suspects.get(targetId);
      if (s && this.hostile.has(targetId) && !this.penalized.has(`fireWithoutWarning:${targetId}`) && s.hp - damage <= 0) {
        this.award('neutralize', targetId);
      }
      return;
    }
    if (shooter !== PLAYER_ID) return;
    if (targetId.startsWith('ally_')) {
      this.violate('friendlyFire', targetId);
      return;
    }
    const s = this.entities.suspects.get(targetId);
    if (s) {
      if (s.state === SuspectState.SURRENDER || s.state === SuspectState.ARRESTED) {
        this.violate('fireOnSurrendered', targetId);
        return;
      }
      const wasHostile = this.hostile.has(targetId);
      if (!wasHostile) {
        this.provoked.add(targetId);
        if (!s.warned) this.violate('fireWithoutWarning', targetId);
      }
      if (wasHostile && !this.penalized.has(`fireWithoutWarning:${targetId}`) && s.hp - damage <= 0) {
        this.award('neutralize', targetId);
      }
      return;
    }
    if (this.entities.civilians.has(targetId)) {
      if (nonlethal) {
        this.violate('nonlethalCivilianHit', targetId);
      } else {
        this.harmedCivilians.add(targetId);
        this.violate('civilianHit', targetId);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.onEntry = null;
    this.entities = null;
  }
}
