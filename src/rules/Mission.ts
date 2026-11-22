import type { EntityManager } from '../ai/EntityManager';
import type { InputManager } from '../core/InputManager';
import { CivilianState, SuspectState } from '../core/events';

export type MissionPhase = 'active' | 'post_clear' | 'completing' | 'failing' | 'ended';

export interface MissionStatus {
  phase: MissionPhase;
  allSuspectsNeutralized: boolean;
  totalSuspects: number;
  neutralizedSuspects: number;
  surrenderedSuspects: number;
  activeSuspects: number;
  totalCivilians: number;
  securedCivilians: number;
  remainingCivilians: number;
  deadCivilians: number;
  totalEvidence: number;
  collectedEvidence: number;
  droppedEvidence: number;
  remainingEvidence: number;
  countdownSec: number;
  failed: boolean;
}

const COMPLETE_DELAY_SEC = 2.0;
const MANUAL_COMPLETE_DELAY_SEC = 0.6;
const FAIL_DELAY_SEC = 1.2;
const MAX_DT = 0.05;

/**
 * 全ステージ統一のミッション進行管理。
 * - プレイヤー行動不能時: 1.2 秒のダウン演出後に失敗リザルトへ遷移。
 * - 全脅威(非投降容疑者)制圧後: 隊員の自律確保フェーズ (onPostClear(true)) を開始し、
 *   未拘束投降者・未確保民間人・未回収証拠品がすべて 0 になると
 *   共通の 2.0 秒完了カウントダウンを経て ResultScreen へ遷移（残務中 Enter / Backspace で 0.6 秒遷移）。
 */
export class Mission {
  ended = false;
  private onEnd: ((failed: boolean) => void) | null;
  private onPostClear: ((active: boolean) => void) | null;
  private postClearTriggered = false;
  private _status: MissionStatus = {
    phase: 'active',
    allSuspectsNeutralized: false,
    totalSuspects: 0,
    neutralizedSuspects: 0,
    surrenderedSuspects: 0,
    activeSuspects: 0,
    totalCivilians: 0,
    securedCivilians: 0,
    remainingCivilians: 0,
    deadCivilians: 0,
    totalEvidence: 0,
    collectedEvidence: 0,
    droppedEvidence: 0,
    remainingEvidence: 0,
    countdownSec: 0,
    failed: false,
  };

  constructor(
    private readonly entities: EntityManager,
    onEnd: (failed: boolean) => void,
    private readonly input?: InputManager,
    private readonly isPlayerAlive?: () => boolean,
    onPostClear?: (active: boolean) => void,
  ) {
    this.onEnd = onEnd;
    this.onPostClear = onPostClear ?? null;
  }

  get status(): MissionStatus {
    return this._status;
  }

  update(rawDt = 0.016): void {
    if (this.ended || this.entities.suspects.size === 0) return;
    const dt = Math.min(rawDt, MAX_DT);

    let totalSuspects = 0;
    let neutralizedSuspects = 0;
    let surrenderedSuspects = 0;
    let activeSuspects = 0;
    let collectedEvidence = 0;
    let droppedEvidence = 0;
    for (const s of this.entities.suspects.values()) {
      totalSuspects++;
      if (s.state === SuspectState.ARRESTED || s.state === SuspectState.DOWN) {
        neutralizedSuspects++;
      } else if (s.state === SuspectState.SURRENDER) {
        surrenderedSuspects++;
      } else {
        activeSuspects++;
      }
      if (s.evidenceCollected) {
        collectedEvidence++;
      } else if (s.hasUncollectedEvidence) {
        droppedEvidence++;
      }
    }

    let totalCivilians = 0;
    let securedCivilians = 0;
    let remainingCivilians = 0;
    let deadCivilians = 0;
    for (const c of this.entities.civilians.values()) {
      if (!c.alive) {
        deadCivilians++;
      } else if (c.state === CivilianState.SECURED) {
        totalCivilians++;
        securedCivilians++;
      } else {
        totalCivilians++;
        remainingCivilians++;
      }
    }

    const totalEvidence = collectedEvidence + droppedEvidence + activeSuspects;
    const allSuspectsNeutralized = totalSuspects > 0 && neutralizedSuspects === totalSuspects;
    const remainingEvidence = allSuspectsNeutralized ? droppedEvidence : Math.max(0, totalEvidence - collectedEvidence);

    this._status.allSuspectsNeutralized = allSuspectsNeutralized;
    this._status.totalSuspects = totalSuspects;
    this._status.neutralizedSuspects = neutralizedSuspects;
    this._status.surrenderedSuspects = surrenderedSuspects;
    this._status.activeSuspects = activeSuspects;
    this._status.totalCivilians = totalCivilians;
    this._status.securedCivilians = securedCivilians;
    this._status.remainingCivilians = remainingCivilians;
    this._status.deadCivilians = deadCivilians;
    this._status.totalEvidence = totalEvidence;
    this._status.collectedEvidence = collectedEvidence;
    this._status.droppedEvidence = droppedEvidence;
    this._status.remainingEvidence = remainingEvidence;

    if (this.isPlayerAlive && !this.isPlayerAlive()) {
      if (this._status.phase !== 'failing') {
        this._status.phase = 'failing';
        this._status.failed = true;
        this._status.countdownSec = FAIL_DELAY_SEC;
      } else {
        this._status.countdownSec = Math.max(0, this._status.countdownSec - dt);
      }
      if (this._status.countdownSec <= 0) {
        this.finish(true);
      }
      return;
    }

    if (this._status.phase === 'completing') {
      this._status.countdownSec = Math.max(0, this._status.countdownSec - dt);
      if (this._status.countdownSec <= 0) {
        this.finish(false);
      }
      return;
    }

    if (totalSuspects > 0 && activeSuspects === 0) {
      if (!this.postClearTriggered) {
        this.postClearTriggered = true;
        this.onPostClear?.(true);
      }
    } else if (this.postClearTriggered) {
      this.postClearTriggered = false;
      this.onPostClear?.(false);
    }

    if (!allSuspectsNeutralized) {
      this._status.phase = 'active';
      return;
    }

    if (remainingCivilians === 0 && droppedEvidence === 0) {
      this._status.phase = 'completing';
      this._status.countdownSec = COMPLETE_DELAY_SEC;
      return;
    }

    this._status.phase = 'post_clear';
    if (this.input?.wasPressed('endMission')) {
      this._status.phase = 'completing';
      this._status.countdownSec = MANUAL_COMPLETE_DELAY_SEC;
    }
  }

  private finish(failed: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this._status.phase = 'ended';
    this._status.failed = failed;
    this.onEnd?.(failed);
  }

  dispose(): void {
    this.onEnd = null;
    this.onPostClear = null;
  }
}
