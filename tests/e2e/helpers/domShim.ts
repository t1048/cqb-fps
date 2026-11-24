/**
 * Zero-dependency headless DOM / Window / Canvas / SpeechSynthesis shim
 * for running browser-coupled UI and effect modules in Vitest Node environment.
 */

export interface SpokenUtterance {
  text: string;
  lang: string;
  pitch: number;
  rate: number;
  volume: number;
  timestampMs: number;
}

type Listener = (evt: unknown) => void;

export class FakeStyle {
  [key: string]: string;
  cssText = '';
  display = '';
  opacity = '';
  filter = '';
  backdropFilter = '';
  width = '';
  height = '';
  background = '';
  color = '';
}

export class FakeClassList {
  private readonly set = new Set<string>();
  constructor(private readonly el: FakeElement) {}
  add(...tokens: string[]): void {
    for (const t of tokens) if (t) this.set.add(t);
    this.sync();
  }
  remove(...tokens: string[]): void {
    for (const t of tokens) this.set.delete(t);
    this.sync();
  }
  toggle(token: string, force?: boolean): boolean {
    const next = force !== undefined ? force : !this.set.has(token);
    if (next) this.set.add(token);
    else this.set.delete(token);
    this.sync();
    return next;
  }
  contains(token: string): boolean {
    return this.set.has(token);
  }
  syncFromClassName(name: string): void {
    this.set.clear();
    for (const t of name.split(/\s+/).filter(Boolean)) this.set.add(t);
  }
  private sync(): void {
    this.el._classNameRaw = [...this.set].join(' ');
  }
}

function createNoop2DContext() {
  return {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    rect() {},
    fill() {},
    stroke() {},
    fillText() {},
    strokeText() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    setTransform() {},
    resetTransform() {},
    transform() {},
    clip() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    ellipse() {},
    roundRect() {},
    setLineDash() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    measureText(t: string) {
      return { width: t.length * 7 };
    },
  };
}

export class FakeElement {
  readonly tagName: string;
  id = '';
  _classNameRaw = '';
  readonly classList: FakeClassList;
  readonly style = new FakeStyle();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  parentNode: FakeElement | null = null;
  private _ownText = '';
  innerHTML = '';
  type = '';
  value = '';
  checked = false;
  disabled = false;
  width = 300;
  height = 150;
  placeholder = '';
  title = '';
  tabIndex = 0;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList(this);
  }

  get textContent(): string {
    if (this.children.length === 0) return this._ownText;
    let out = this._ownText;
    for (const c of this.children) out += c.textContent;
    return out;
  }
  set textContent(v: string) {
    this._ownText = v == null ? '' : String(v);
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
  }

  get className(): string {
    return this._classNameRaw;
  }
  set className(v: string) {
    this._classNameRaw = v;
    this.classList.syncFromClassName(v);
  }

  appendChild(child: FakeElement): FakeElement {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const n of nodes) {
      if (typeof n === 'string') {
        this._ownText += n;
      } else {
        this.appendChild(n);
      }
    }
  }

  removeChild(child: FakeElement): FakeElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(k: string, v: string): void {
    this.attributes.set(k, String(v));
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = String(v);
  }

  getAttribute(k: string): string | null {
    if (k === 'id') return this.id || null;
    if (k === 'class') return this.className || null;
    return this.attributes.get(k) ?? null;
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(evt: { type: string; [key: string]: unknown }): boolean {
    const set = this.listeners.get(evt.type);
    if (set) {
      for (const fn of [...set]) fn(evt);
    }
    return true;
  }

  click(): void {
    if (this.disabled) return;
    if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      this.checked = !this.checked;
      this.dispatchEvent({ type: 'change', target: this });
    }
    this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
  }

  focus(): void {}
  blur(): void {}

  getContext(_kind: string) {
    return createNoop2DContext();
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width, height: this.height, right: this.width, bottom: this.height };
  }

  /** Depth-first search of descendants matching a predicate. */
  findAll(pred: (el: FakeElement) => boolean, out: FakeElement[] = []): FakeElement[] {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.findAll(pred, out);
    }
    return out;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const sel = selector.trim();
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      return this.findAll((el) => el.id === id);
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.findAll((el) => el.classList.contains(cls));
    }
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const attr = sel.slice(1, -1);
      return this.findAll((el) => el.attributes.has(attr));
    }
    const tag = sel.toUpperCase();
    return this.findAll((el) => el.tagName === tag);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export class FakeSpeechSynthesisUtterance {
  text: string;
  lang = 'en-US';
  pitch = 1;
  rate = 1;
  volume = 1;
  constructor(text = '') {
    this.text = text;
  }
}

export class FakeDocument {
  readonly documentElement = new FakeElement('html');
  readonly head = new FakeElement('head');
  readonly body = new FakeElement('body');
  pointerLockElement: FakeElement | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  getElementById(id: string): FakeElement | null {
    return this.documentElement.findAll((el) => el.id === id)[0] ?? null;
  }

  querySelector(sel: string): FakeElement | null {
    return this.documentElement.querySelector(sel);
  }

  querySelectorAll(sel: string): FakeElement[] {
    return this.documentElement.querySelectorAll(sel);
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(evt: { type: string; [key: string]: unknown }): boolean {
    const set = this.listeners.get(evt.type);
    if (set) {
      for (const fn of [...set]) fn(evt);
    }
    return true;
  }

  exitPointerLock(): void {
    this.pointerLockElement = null;
  }
}

export interface DomShimHandle {
  document: FakeDocument;
  window: Record<string, unknown>;
  speechLog: SpokenUtterance[];
  canvas: HTMLCanvasElement;
  reset(): void;
}

interface SavedGlobals {
  document: unknown;
  window: unknown;
  HTMLElement: unknown;
  HTMLCanvasElement: unknown;
  SpeechSynthesisUtterance: unknown;
  speechSynthesis: unknown;
}

let saved: SavedGlobals | null = null;
let activeShims = 0;

export function installDomShim(urlSearch = ''): DomShimHandle {
  const g = globalThis as Record<string, unknown>;
  if (activeShims === 0 && !saved) {
    saved = {
      document: g.document,
      window: g.window,
      HTMLElement: g.HTMLElement,
      HTMLCanvasElement: g.HTMLCanvasElement,
      SpeechSynthesisUtterance: g.SpeechSynthesisUtterance,
      speechSynthesis: g.speechSynthesis,
    };
  }
  activeShims++;

  const doc = new FakeDocument();
  const speechLog: SpokenUtterance[] = [];
  const winListeners = new Map<string, Set<Listener>>();

  const speechSynthesis = {
    speaking: false,
    pending: false,
    paused: false,
    speak(u: FakeSpeechSynthesisUtterance) {
      speechLog.push({
        text: u.text,
        lang: u.lang,
        pitch: u.pitch,
        rate: u.rate,
        volume: u.volume,
        timestampMs: Date.now(),
      });
    },
    cancel() {},
    getVoices() {
      return [];
    },
  };

  const win: Record<string, unknown> = {
    document: doc,
    location: {
      search: urlSearch,
      href: `http://localhost:5173/${urlSearch}`,
      pathname: '/',
    },
    speechSynthesis,
    SpeechSynthesisUtterance: FakeSpeechSynthesisUtterance,
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    addEventListener(type: string, fn: Listener) {
      let set = winListeners.get(type);
      if (!set) {
        set = new Set();
        winListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(evt: { type: string; [key: string]: unknown }) {
      const set = winListeners.get(evt.type);
      if (set) for (const fn of [...set]) fn(evt);
      return true;
    },
    requestAnimationFrame(cb: (t: number) => void) {
      return setTimeout(() => cb(Date.now()), 16);
    },
    cancelAnimationFrame(id: ReturnType<typeof setTimeout>) {
      clearTimeout(id);
    },
  };

  g.document = doc;
  g.window = win;
  g.HTMLElement = FakeElement;
  g.HTMLCanvasElement = FakeElement;
  g.SpeechSynthesisUtterance = FakeSpeechSynthesisUtterance;
  g.speechSynthesis = speechSynthesis;

  const canvas = doc.createElement('canvas') as unknown as HTMLCanvasElement;
  doc.body.appendChild(canvas as unknown as FakeElement);

  return {
    document: doc,
    window: win,
    speechLog,
    canvas,
    reset() {
      doc.body.children.length = 0;
      doc.head.children.length = 0;
      speechLog.length = 0;
    },
  };
}

export function restoreDomShim(): void {
  if (activeShims <= 0) return;
  activeShims--;
  if (activeShims > 0 || !saved) return;
  const g = globalThis as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  saved = null;
}
