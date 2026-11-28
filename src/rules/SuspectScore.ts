/** 容疑者モードのスコア集計および S/A/B/C/D ランク算出。 */

export type SuspectRankGrade = 'S' | 'A' | 'B' | 'C' | 'D';

export type SuspectScoreKind =
  | 'swatNeutralized'
  | 'trapHit'
  | 'hostageUnharmed'
  | 'survivalBonus'
  | 'siegeVictory'
  | 'hostageKilled';

export interface SuspectScoreEntry {
  kind: SuspectScoreKind;
  targetId: string;
  points: number;
  label: string;
  /** ミッション開始からの経過秒 */
  time: number;
}

export interface SuspectScoreInput {
  /** 突入班を撃退して籠城に勝利したか */
  victory: boolean;
  /** 無力化した SWAT 隊員数 */
  swatNeutralized: number;
  /** 出動した SWAT 隊員の総数 */
  totalSwat: number;
  /** 生存時間（秒） */
  survivalSec: number;
  /** 無傷のまま残った人質数 */
  hostagesUnharmed: number;
  /** 初期人質数 */
  totalHostages: number;
  /** 死亡した人質数（省略時 0） */
  hostagesKilled?: number;
  /** ブービートラップ命中回数 */
  trapHits: number;
}

export interface SuspectScoreSummary {
  total: number;
  maxPossibleScore: number;
  rank: SuspectRankGrade;
  entries: SuspectScoreEntry[];
  swatNeutralized: number;
  survivalSec: number;
  hostagesUnharmed: number;
  trapHits: number;
  victory: boolean;
}

export const SUSPECT_SCORE_POINTS = {
  swatNeutralized: 60,
  trapHit: 40,
  hostageUnharmed: 35,
  /** 5 秒生存ごとに +1 点（上限 60 点 = 300 秒） */
  survivalPer5Sec: 1,
  survivalMax: 60,
  siegeVictory: 150,
  hostageKilled: -80,
} as const;

export const SUSPECT_SCORE_LABELS: Record<SuspectScoreKind, { ja: string; en: string }> = {
  swatNeutralized: { ja: 'SWAT 隊員を無力化', en: 'SWAT Officer Neutralized' },
  trapHit: { ja: 'トラップ命中', en: 'Booby Trap Hit' },
  hostageUnharmed: { ja: '人質を無傷で保持', en: 'Hostage Unharmed' },
  survivalBonus: { ja: '籠城生存ボーナス', en: 'Siege Survival Bonus' },
  siegeVictory: { ja: 'SWAT 撃退（籠城成功）', en: 'SWAT Repelled (Siege Victory)' },
  hostageKilled: { ja: '人質が死亡', en: 'Hostage Killed' },
};

/** 生存時間ボーナスを計算（5秒につき +1、最大 60 点）。 */
export function calcSurvivalBonus(survivalSec: number): number {
  const sec = Number.isFinite(survivalSec) ? Math.max(0, survivalSec) : 0;
  return Math.min(
    SUSPECT_SCORE_POINTS.survivalMax,
    Math.floor(sec / 5) * SUSPECT_SCORE_POINTS.survivalPer5Sec,
  );
}

/** 獲得スコアと基準最大スコアから S/A/B/C/D ランクを決定。 */
export function calcSuspectRank(total: number, maxPossibleScore: number, victory: boolean): SuspectRankGrade {
  const denom = Math.max(1, maxPossibleScore);
  const ratio = total / denom;
  if (victory && ratio >= 0.8) return 'S';
  if (ratio >= 0.6) return 'A';
  if (ratio >= 0.4) return 'B';
  if (ratio >= 0.2) return 'C';
  return 'D';
}

/** 容疑者モードの結果からスコア内訳とランクを一括算出する純粋関数。 */
export function computeSuspectScore(input: SuspectScoreInput): SuspectScoreSummary {
  const swatNeutralized = Math.max(0, Math.floor(input.swatNeutralized));
  const totalSwat = Math.max(swatNeutralized, Math.floor(input.totalSwat));
  const survivalSec = Number.isFinite(input.survivalSec) ? Math.max(0, input.survivalSec) : 0;
  const hostagesUnharmed = Math.max(0, Math.floor(input.hostagesUnharmed));
  const totalHostages = Math.max(hostagesUnharmed, Math.floor(input.totalHostages));
  const hostagesKilled = Math.max(0, Math.floor(input.hostagesKilled ?? 0));
  const trapHits = Math.max(0, Math.floor(input.trapHits));

  const entries: SuspectScoreEntry[] = [];
  let total = 0;

  if (input.victory) {
    const pts = SUSPECT_SCORE_POINTS.siegeVictory;
    entries.push({
      kind: 'siegeVictory',
      targetId: 'siege',
      points: pts,
      label: SUSPECT_SCORE_LABELS.siegeVictory.ja,
      time: survivalSec,
    });
    total += pts;
  }

  for (let i = 0; i < swatNeutralized; i++) {
    const pts = SUSPECT_SCORE_POINTS.swatNeutralized;
    entries.push({
      kind: 'swatNeutralized',
      targetId: `swat-${i + 1}`,
      points: pts,
      label: SUSPECT_SCORE_LABELS.swatNeutralized.ja,
      time: survivalSec,
    });
    total += pts;
  }

  for (let i = 0; i < trapHits; i++) {
    const pts = SUSPECT_SCORE_POINTS.trapHit;
    entries.push({
      kind: 'trapHit',
      targetId: `trap-${i + 1}`,
      points: pts,
      label: SUSPECT_SCORE_LABELS.trapHit.ja,
      time: survivalSec,
    });
    total += pts;
  }

  for (let i = 0; i < hostagesUnharmed; i++) {
    const pts = SUSPECT_SCORE_POINTS.hostageUnharmed;
    entries.push({
      kind: 'hostageUnharmed',
      targetId: `hostage-${i + 1}`,
      points: pts,
      label: SUSPECT_SCORE_LABELS.hostageUnharmed.ja,
      time: survivalSec,
    });
    total += pts;
  }

  const survivalPts = calcSurvivalBonus(survivalSec);
  if (survivalPts > 0) {
    entries.push({
      kind: 'survivalBonus',
      targetId: 'survival',
      points: survivalPts,
      label: SUSPECT_SCORE_LABELS.survivalBonus.ja,
      time: survivalSec,
    });
    total += survivalPts;
  }

  for (let i = 0; i < hostagesKilled; i++) {
    const pts = SUSPECT_SCORE_POINTS.hostageKilled;
    entries.push({
      kind: 'hostageKilled',
      targetId: `hostage-killed-${i + 1}`,
      points: pts,
      label: SUSPECT_SCORE_LABELS.hostageKilled.ja,
      time: survivalSec,
    });
    total += pts;
  }

  const maxPossibleScore = Math.max(
    200,
    Math.max(1, totalSwat) * SUSPECT_SCORE_POINTS.swatNeutralized +
      totalHostages * SUSPECT_SCORE_POINTS.hostageUnharmed +
      SUSPECT_SCORE_POINTS.siegeVictory +
      30,
  );
  const rank = calcSuspectRank(total, maxPossibleScore, input.victory);

  return {
    total,
    maxPossibleScore,
    rank,
    entries,
    swatNeutralized,
    survivalSec,
    hostagesUnharmed,
    trapHits,
    victory: input.victory,
  };
}

/** リアルタイムにイベントを蓄積する容疑者モード用スコアボード。 */
export class SuspectScoreBoard {
  readonly entries: SuspectScoreEntry[] = [];
  private readonly counts = new Map<SuspectScoreKind, number>();
  total = 0;
  maxPossibleScore: number;
  victory = false;

  constructor(totalSwat = 4, totalHostages = 2) {
    this.maxPossibleScore = Math.max(
      200,
      Math.max(1, totalSwat) * SUSPECT_SCORE_POINTS.swatNeutralized +
        Math.max(0, totalHostages) * SUSPECT_SCORE_POINTS.hostageUnharmed +
        SUSPECT_SCORE_POINTS.siegeVictory +
        30,
    );
  }

  add(kind: Exclude<SuspectScoreKind, 'survivalBonus'>, targetId: string, time: number): SuspectScoreEntry {
    const points = SUSPECT_SCORE_POINTS[kind];
    if (kind === 'siegeVictory') this.victory = true;
    const entry: SuspectScoreEntry = {
      kind,
      targetId,
      points,
      label: SUSPECT_SCORE_LABELS[kind].ja,
      time,
    };
    this.entries.push(entry);
    this.total += points;
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    return entry;
  }

  addSurvivalBonus(survivalSec: number): SuspectScoreEntry | null {
    const pts = calcSurvivalBonus(survivalSec);
    if (pts <= 0) return null;
    const entry: SuspectScoreEntry = {
      kind: 'survivalBonus',
      targetId: 'survival',
      points: pts,
      label: SUSPECT_SCORE_LABELS.survivalBonus.ja,
      time: survivalSec,
    };
    this.entries.push(entry);
    this.total += pts;
    this.counts.set('survivalBonus', (this.counts.get('survivalBonus') ?? 0) + 1);
    return entry;
  }

  count(kind: SuspectScoreKind): number {
    return this.counts.get(kind) ?? 0;
  }

  get rank(): SuspectRankGrade {
    return calcSuspectRank(this.total, this.maxPossibleScore, this.victory);
  }
}
