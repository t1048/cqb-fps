/** ステート定義。enter/update/exit はすべて任意。 */
export interface StateHandlers<S extends string> {
  enter?(from: S | null): void;
  update?(dt: number): void;
  exit?(to: S): void;
}

/**
 * 汎用ステートマシン（enter/update/exit）。
 * 遷移は transition() で即時実行。同一ステートへの遷移は無視。onChange は enter 後に呼ばれる。
 */
export class StateMachine<S extends string> {
  private current: S;
  private elapsed = 0;

  constructor(
    private readonly states: Readonly<Record<S, StateHandlers<S>>>,
    initial: S,
    private readonly onChange?: (from: S | null, to: S) => void,
  ) {
    this.current = initial;
    this.states[initial].enter?.(null);
    this.onChange?.(null, initial);
  }

  get state(): S {
    return this.current;
  }

  /** 現ステートに入ってからの経過秒 */
  get timeInState(): number {
    return this.elapsed;
  }

  transition(to: S): boolean {
    if (to === this.current) return false;
    const from = this.current;
    this.states[from].exit?.(to);
    this.current = to;
    this.elapsed = 0;
    this.states[to].enter?.(from);
    this.onChange?.(from, to);
    return true;
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.states[this.current].update?.(dt);
  }
}
