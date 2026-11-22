import type { NegotiationChoiceDef, NegotiationConfig } from '../core/types';
import type { SessionView } from '../ai/Negotiation';

const MAX_LOG = 6;

/**
 * 交渉 UI（説得・要求確認・威圧などの選択肢）。選択肢は negotiation.json の choices から生成。
 * キー（choices[].key）/ボタンクリックで onChoose、cancelKey で onCancel。
 * keydown リスナーは open() で登録し close()/dispose() で必ず解除（二重登録しない）。
 * ポインタロックのまま操作できるよう、Escape ではなく専用キーを使う。
 */
export class NegotiationUI {
  private readonly root = document.createElement('div');
  private readonly hint = document.createElement('div');
  private readonly title = document.createElement('div');
  private readonly timerFill = document.createElement('div');
  private readonly moraleFill = document.createElement('div');
  private readonly status = document.createElement('div');
  private readonly log = document.createElement('div');
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly btnHandlers: [HTMLButtonElement, () => void][] = [];
  private readonly lines: string[] = [];
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private isOpen = false;
  onChoose: ((id: string) => void) | null = null;
  onCancel: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly cfg: NegotiationConfig,
  ) {
    this.hint.style.cssText =
      'position:fixed;left:50%;top:72%;transform:translateX(-50%);padding:4px 12px;background:rgba(0,0,0,.55);color:#9cf;font:14px sans-serif;border-radius:4px;pointer-events:none;display:none;z-index:6';
    this.root.style.cssText =
      'position:fixed;left:16px;bottom:16px;width:340px;padding:10px 12px;background:rgba(10,16,28,.82);border:1px solid #4a6fa5;color:#fff;font:14px sans-serif;border-radius:6px;display:none;z-index:7';
    this.title.style.cssText = 'font-weight:bold;margin-bottom:6px;color:#9cf';
    const bar = (fill: HTMLElement, color: string): HTMLElement => {
      const b = document.createElement('div');
      b.style.cssText = 'height:6px;background:#222;margin:2px 0 6px';
      fill.style.cssText = `height:100%;width:100%;background:${color}`;
      b.appendChild(fill);
      return b;
    };
    const mk = (t: string): HTMLElement => {
      const d = document.createElement('div');
      d.style.cssText = 'font-size:11px;color:#aab';
      d.textContent = t;
      return d;
    };
    this.status.style.cssText = 'font-size:12px;color:#cdd;margin-bottom:6px';
    this.log.style.cssText = 'min-height:64px;margin-bottom:6px;font-size:13px;line-height:1.35';
    this.root.append(this.title, mk('残り時間'), bar(this.timerFill, '#e8a23a'), mk('容疑者の動揺（低いほど投降に近い）'), bar(this.moraleFill, '#c0504d'), this.status, this.log);
    for (const c of cfg.choices) this.root.appendChild(this.makeButton(c));
    const cancel = document.createElement('div');
    cancel.style.cssText = 'margin-top:6px;font-size:11px;color:#99a';
    cancel.textContent = `${keyLabel(cfg.cancelKey)}: 無線切断`;
    this.root.appendChild(cancel);
    parent.append(this.hint, this.root);
  }

  private makeButton(c: NegotiationChoiceDef): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.cssText =
      'display:block;width:100%;margin:3px 0;padding:5px 8px;text-align:left;background:#1d2a44;color:#fff;border:1px solid #4a6fa5;border-radius:4px;font:14px sans-serif;cursor:pointer';
    b.textContent = `[${keyLabel(c.key)}] ${c.label}`;
    const h = (): void => this.onChoose?.(c.id);
    b.addEventListener('click', h);
    this.btnHandlers.push([b, h]);
    this.buttons.set(c.id, b);
    return b;
  }

  /** 待機中のヒント（交渉可否・操作案内）。空文字で非表示。 */
  setHint(text: string): void {
    if (this.disposed) return;
    this.hint.textContent = text;
    this.hint.style.display = text && !this.isOpen ? 'block' : 'none';
  }

  open(title: string): void {
    if (this.disposed) return;
    this.clearHide();
    this.closeKeys();
    this.isOpen = true;
    this.hint.style.display = 'none';
    this.lines.length = 0;
    this.renderLog();
    this.title.textContent = title;
    this.root.style.display = 'block';
    const keys = new Map(this.cfg.choices.map((c) => [c.key, c.id]));
    this.keyHandler = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      if (e.code === this.cfg.cancelKey) {
        e.preventDefault();
        this.onCancel?.();
        return;
      }
      const id = keys.get(e.code);
      if (id) {
        e.preventDefault();
        this.onChoose?.(id);
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  pushLine(text: string): void {
    if (this.disposed || !text) return;
    this.lines.push(text);
    while (this.lines.length > MAX_LOG) this.lines.shift();
    this.renderLog();
  }

  update(v: SessionView): void {
    if (this.disposed || !this.isOpen) return;
    this.timerFill.style.width = `${Math.max(0, Math.min(1, v.remainingSec / v.totalSec)) * 100}%`;
    this.moraleFill.style.width = `${Math.max(0, Math.min(100, v.morale))}%`;
    this.status.textContent = `信頼 ${v.trust}/${v.trustMax}　失敗 ${v.fails}/${v.maxFails}${v.hostage ? '　【人質あり】' : ''}`;
    for (const b of this.buttons.values()) {
      b.disabled = v.cooldownSec > 0;
      b.style.opacity = v.cooldownSec > 0 ? '0.5' : '1';
    }
  }

  /** 結果を表示し、holdSec 後に閉じる。キー入力は即解除。 */
  finish(message: string, holdSec: number): void {
    if (this.disposed) return;
    this.closeKeys();
    this.pushLine(message);
    for (const b of this.buttons.values()) {
      b.disabled = true;
      b.style.opacity = '0.4';
    }
    this.clearHide();
    this.hideTimer = setTimeout(() => this.close(), holdSec * 1000);
  }

  close(): void {
    this.clearHide();
    this.closeKeys();
    this.isOpen = false;
    this.root.style.display = 'none';
  }

  private renderLog(): void {
    this.log.textContent = '';
    for (const l of this.lines) {
      const d = document.createElement('div');
      d.textContent = l;
      this.log.appendChild(d);
    }
  }

  private clearHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private closeKeys(): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    for (const [b, h] of this.btnHandlers) b.removeEventListener('click', h);
    this.btnHandlers.length = 0;
    this.buttons.clear();
    this.onChoose = null;
    this.onCancel = null;
    this.root.remove();
    this.hint.remove();
  }
}

function keyLabel(code: string): string {
  return code.replace(/^Key/, '').replace(/^Digit/, '');
}
