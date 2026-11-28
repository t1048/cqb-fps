/**
 * 建物の電源。2 系統の直列で、両方が入っているときだけ屋内の照明が点く。
 * - utility: 外部からの供給（電力会社・SWAT が交渉で止める / 戻す）。屋内からは操作できない
 * - breaker: 屋内の配電盤のメインブレーカー（容疑者・SWAT のどちらも、その場で落とす / 上げる）
 *
 * 外部から止められた電気は、配電盤のブレーカーを上げても戻らない。
 */
export type PowerCause = 'negotiation' | 'breach' | 'panel' | 'restore';
export type PowerActor = 'swat' | 'suspect';

export interface PowerChange {
  on: boolean;
  cause: PowerCause;
  by: PowerActor;
}

export class PowerGrid {
  private utilityOn = true;
  private breakerOn = true;
  /** 突入前（交渉中）に電気を止められ、犯人が暗闇に慣れたか（突入時、最初からライトを点けて待ち構える） */
  adapted = false;
  private readonly listeners: ((c: PowerChange) => void)[] = [];

  get on(): boolean {
    return this.utilityOn && this.breakerOn;
  }

  get utility(): boolean {
    return this.utilityOn;
  }

  get breaker(): boolean {
    return this.breakerOn;
  }

  onChange(fn: (c: PowerChange) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** 外部の供給を切り替える（SWAT 側だけ） */
  setUtility(on: boolean, cause: PowerCause): void {
    if (this.utilityOn === on) return;
    const before = this.on;
    this.utilityOn = on;
    this.emit(before, cause, 'swat');
  }

  /** 配電盤のブレーカーを切り替える。切り替えたら true */
  setBreaker(on: boolean, by: PowerActor): boolean {
    if (this.breakerOn === on) return false;
    const before = this.on;
    this.breakerOn = on;
    this.emit(before, 'panel', by);
    return true;
  }

  private emit(before: boolean, cause: PowerCause, by: PowerActor): void {
    if (before === this.on) return;
    const c: PowerChange = { on: this.on, cause, by };
    for (const fn of [...this.listeners]) fn(c);
  }
}
