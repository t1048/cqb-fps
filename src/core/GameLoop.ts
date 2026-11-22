/** requestAnimationFrame ベースのゲームループ。delta は最大 0.05s にクランプ。 */
export type UpdateFn = (delta: number) => void;

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
    const delta = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.update(delta);
    this.render();
    this.rafId = requestAnimationFrame(this.tick);
  };
}
