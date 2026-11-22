import type { RoeConfig, ScoreKind } from '../core/types';

export interface ScoreEntry {
  kind: ScoreKind;
  targetId: string;
  points: number;
  label: string;
  /** ミッション開始からの経過秒 */
  time: number;
}

/** スコア集計。項目・配点は roe.json。 */
export class ScoreBoard {
  readonly entries: ScoreEntry[] = [];
  private readonly counts = new Map<ScoreKind, number>();
  total = 0;
  maxPossibleScore: number;

  constructor(private readonly cfg: RoeConfig, maxPossibleScore = 0) {
    this.maxPossibleScore = Math.max(0, maxPossibleScore);
  }

  setMaxPossibleScore(score: number): void {
    this.maxPossibleScore = Math.max(0, score);
  }

  add(kind: ScoreKind, targetId: string, time: number): ScoreEntry {
    const points = this.cfg.points[kind];
    const entry: ScoreEntry = { kind, targetId, points, label: this.cfg.labels[kind], time };
    this.entries.push(entry);
    this.total += points;
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    return entry;
  }

  count(kind: ScoreKind): number {
    return this.counts.get(kind) ?? 0;
  }

  get violations(): number {
    return this.entries.filter((e) => e.points < 0).length;
  }

  get rank(): string {
    for (const r of this.cfg.ranks) {
      const threshold =
        this.maxPossibleScore > 0 && r.minRatio !== undefined
          ? this.maxPossibleScore * r.minRatio
          : r.minScore;
      if (this.total >= threshold) return r.label;
    }
    return this.cfg.ranks[this.cfg.ranks.length - 1]?.label ?? '-';
  }
}
