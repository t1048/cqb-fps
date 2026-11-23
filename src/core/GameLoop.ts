/** requestAnimationFrame ベースのゲームループ。delta は最大 0.05s にクランプ。 */
/** delta はクランプ後、rawDelta は実測の経過秒。 */
export type UpdateFn = (delta: number, rawDelta: number) => void;

export class GameLoop {
  private rafId: number | null = null;
  private last = 0;
  private running = false;

  constructor(
    private readonly update: UpdateFn,
    private readonly render: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  destroy(): void {
    this.stop();
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const raw = (now - this.last) / 1000;
    const delta = Math.min(raw, 0.05);
    this.last = now;
    this.update(delta, raw);
    this.render();
    this.rafId = requestAnimationFrame(this.tick);
  };
}
