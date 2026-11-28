import type { InputManager } from '../core/InputManager';

/**
 * 1 つのインタラクト対象種別（交渉 / 証拠回収 / 民間人保護 / 逮捕 / ドア など）。
 * priority が大きいほど優先（交渉 400 > 証拠回収 320 > 民間人保護 310 > 逮捕 300 > ドア 200）。
 * 警告コールは Space キー専用として独立しているため、Interaction には登録しない。
 */
export interface InteractProvider<T> {
  readonly id: string;
  readonly priority: number;
  /** 今フレーム対象があれば返す。無ければ null（次の優先度へ）。 */
  resolve(): T | null;
  /** HUD 用の短い説明（任意） */
  label?(target: T): string;
  /** F を押した瞬間（フレーム内 1 回） */
  onPress?(target: T): void;
  /** F 押下中、毎フレーム。heldSec = 押し続けた秒数（長押しゲージ用） */
  onHold?(target: T, dt: number, heldSec: number): void;
  /** F を離した時、または対象が変わって保持が中断された時 */
  onRelease?(target: T, heldSec: number): void;
  /** ホイール段階入力。steps は ±1 以上の整数（正 = 奥へ回転 = deltaY 正方向） */
  onWheel?(target: T, steps: number): void;
}

interface Entry {
  id: string;
  priority: number;
  resolve(): unknown;
  label(target: unknown): string;
  press(target: unknown): void;
  hold(target: unknown, dt: number, heldSec: number): void;
  release(target: unknown, heldSec: number): void;
  wheel(target: unknown, steps: number): void;
}

export interface InteractTargetInfo {
  providerId: string;
  label: string;
}

const MAX_DT = 0.05;

/**
 * F キー（interact）とホイールの一元窓口。各機能は provider を登録するだけで、F を直接読まない。
 * 毎フレーム、優先度の高い順に resolve() を呼び、最初に対象を返した provider 1 つだけが入力を受け取る。
 */
export class Interaction {
  private readonly entries: Entry[] = [];
  private current: { entry: Entry; target: unknown } | null = null;
  private held: { entry: Entry; target: unknown; sec: number } | null = null;
  private pressedId: string | null = null;
  private wheelAccum = 0;
  private disposed = false;

  constructor(
    private readonly input: InputManager,
    private readonly wheelStepThreshold: number,
  ) {}

  /** provider を登録。戻り値は解除関数。 */
  register<T>(p: InteractProvider<T>): () => void {
    const entry: Entry = {
      id: p.id,
      priority: p.priority,
      resolve: () => p.resolve(),
      label: (t) => p.label?.(t as T) ?? '',
      press: (t) => p.onPress?.(t as T),
      hold: (t, dt, s) => p.onHold?.(t as T, dt, s),
      release: (t, s) => p.onRelease?.(t as T, s),
      wheel: (t, n) => p.onWheel?.(t as T, n),
    };
    this.entries.push(entry);
    this.entries.sort((a, b) => b.priority - a.priority);
    return () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    };
  }

  /** 現在の対象（最優先 provider）。update 後に有効。無ければ null。 */
  getInteractTarget(): InteractTargetInfo | null {
    if (!this.current) return null;
    return { providerId: this.current.entry.id, label: this.current.entry.label(this.current.target) };
  }

  /** F 長押し中の provider ID と保持秒数。長押し中でなければ null。 */
  get activeHold(): { providerId: string; sec: number } | null {
    if (!this.held) return null;
    return { providerId: this.held.entry.id, sec: this.held.sec };
  }

  /** 今フレームで F を押した瞬間の provider ID。無ければ null。 */
  get pressedProviderId(): string | null {
    return this.pressedId;
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    this.pressedId = null;

    this.current = null;
    for (const e of this.entries) {
      const t = e.resolve();
      if (t !== null) {
        this.current = { entry: e, target: t };
        break;
      }
    }

    // ホイール（ポインタロック中のみ。累積して閾値ごとに 1 段階）
    const w = this.input.consumeWheel();
    if (this.input.isPointerLocked && this.current) {
      this.wheelAccum += w;
      const steps = Math.trunc(this.wheelAccum / this.wheelStepThreshold);
      if (steps !== 0) {
        this.wheelAccum -= steps * this.wheelStepThreshold;
        this.current.entry.wheel(this.current.target, steps);
      }
    } else {
      this.wheelAccum = 0;
    }

    // F（押下 → 保持 → 解放）
    const down = this.input.isDown('interact');
    if (
      this.held &&
      (!down || !this.current || this.current.entry !== this.held.entry || this.current.target !== this.held.target)
    ) {
      this.held.entry.release(this.held.target, this.held.sec);
      this.held = null;
    }
    if (this.held && down) {
      this.held.sec += dt;
      this.held.entry.hold(this.held.target, dt, this.held.sec);
    }
    if (!this.held && this.input.isPointerLocked && this.input.wasPressed('interact') && this.current) {
      this.pressedId = this.current.entry.id;
      this.current.entry.press(this.current.target);
      this.held = { entry: this.current.entry, target: this.current.target, sec: 0 };
    }
  }

  dispose(): void {
    this.disposed = true;
    this.entries.length = 0;
    this.current = null;
    this.held = null;
  }
}
