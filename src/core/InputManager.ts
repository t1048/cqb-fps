/** アクション名 → KeyboardEvent.code[] のマップ（JSON化可）。キー割当は HANDOFF「決定事項」準拠。 */
export type Action =
  | 'moveForward'
  | 'moveBackward'
  | 'moveLeft'
  | 'moveRight'
  | 'walk'
  | 'crouch'
  | 'leanLeft'
  | 'leanRight'
  | 'interact'
  | 'warningCall'
  | 'breach'
  | 'c2'
  | 'reload'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'orderMenu'
  | 'toggleEntryMode'
  | 'quickOrder'
  | 'regroup'
  | 'cycleElement'
  | 'useMedkit'
  | 'nightVision'
  | 'flashlight'
  | 'endMission';

export type ActionMap = Record<string, string[]>;

export const DEFAULT_ACTION_MAP: ActionMap = {
  moveForward: ['KeyW'],
  moveBackward: ['KeyS'],
  moveLeft: ['KeyA'],
  moveRight: ['KeyD'],
  walk: ['ShiftLeft', 'ShiftRight'],
  // Ctrl は Ctrl+W 等のブラウザショートカットと衝突する（ページ側で阻止できない）ため割り当てない
  crouch: ['KeyC'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  interact: ['KeyF'],
  warningCall: ['Space'],
  breach: ['KeyG'],
  // C2 爆薬の設置（SWAT モード。ドアを狙って押し続ける）
  c2: ['KeyB'],
  reload: ['KeyR'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  // オプティワンド（鏡/ファイバースコープ）の構え/解除
  slot4: ['Digit4'],
  orderMenu: [],
  toggleEntryMode: ['Tab'],
  quickOrder: ['KeyZ'],
  regroup: ['KeyX'],
  cycleElement: ['KeyT'],
  // 救急キットを使う（容疑者モード。押し続ける）
  useMedkit: ['KeyH'],
  // 暗視装置の装着 / 跳ね上げ（SWAT モード）
  nightVision: ['KeyN'],
  // ライトの点灯 / 消灯（容疑者モード）
  flashlight: ['KeyV'],
  endMission: ['Backspace', 'Enter'],
};

export type OrderMenuEvent = 'open' | 'move' | 'wheel' | 'confirm' | 'cancel';

export class InputManager {
  private readonly down = new Set<string>();
  private readonly pressedFrame = new Set<string>();
  private readonly buttons = new Set<number>();
  /** このフレームで押された瞬間のマウスボタン（endFrame で消える） */
  private readonly pressedButtons = new Set<number>();
  private mouseDX = 0;
  private mouseDY = 0;
  onOrderMenu?: (event: OrderMenuEvent, value: number) => void;
  private choosing = false;
  private choosingTrigger: 'right' | 'tab' | null = null;
  private blockFireUntilRelease = false;
  /** 交渉中など、Z/X/T/Tab の部隊指示ショートカットを一時抑止するフラグ */
  suppressSquadShortcuts = false;
  /** false の間は Tab / 右クリックで部隊指揮メニューを開かない（容疑者モード） */
  orderMenuEnabled = true;
  private contextMenu = (event: Event) => event.preventDefault();

  private cancelGesture(): void {
    if (this.choosing) this.onOrderMenu?.('cancel', 0);
    this.choosing = false;
    this.choosingTrigger = null;
  }

  get isOrderMenuOpen(): boolean {
    return this.choosing;
  }

  private wheel = 0;
  private disposed = false;
  private actionToCodes: Map<string, string[]>;

  constructor(
    private readonly element: HTMLElement,
    actionMap: ActionMap = DEFAULT_ACTION_MAP,
  ) {
    this.actionToCodes = new Map(Object.entries(actionMap));
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    element.addEventListener('contextmenu', this.contextMenu);
    element.addEventListener('click', this.onClick);
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  setActionMap(map: ActionMap): void {
    this.actionToCodes = new Map(Object.entries(map));
  }

  get isPointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  requestPointerLock(): void {
    void this.element.requestPointerLock();
  }

  /** アクションが押されている間 true */
  isDown(action: string): boolean {
    return (this.actionToCodes.get(action) ?? []).some((c) => this.down.has(c));
  }

  /** このフレームで押された瞬間のみ true（endFrame で消える） */
  wasPressed(action: string): boolean {
    return (this.actionToCodes.get(action) ?? []).some((c) => this.pressedFrame.has(c));
  }

  isMouseDown(button: number): boolean {
    if (this.choosing) return false;
    if (button === 0 && this.blockFireUntilRelease) return false;
    return this.buttons.has(button);
  }

  /** このフレームで押された瞬間のみ true（指揮メニュー展開中・ポインタ非ロック中は false） */
  wasMousePressed(button: number): boolean {
    return this.pressedButtons.has(button);
  }

  /** 蓄積されたマウス移動量を取得して 0 に戻す */
  consumeMouseDelta(): { x: number; y: number } {
    const r = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return r;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** フレーム末尾で呼ぶ（wasPressed をクリア） */
  endFrame(): void {
    this.pressedFrame.clear();
    this.pressedButtons.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelGesture();
    this.element.removeEventListener('contextmenu', this.contextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('auxclick', this.onAuxClick);
    window.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('click', this.onClick);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    if (this.isPointerLocked) document.exitPointerLock();
    this.down.clear();
    this.pressedFrame.clear();
    this.pressedButtons.clear();
    this.buttons.clear();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // プレイ中（ポインタロック中）は Ctrl/⌘ との組み合わせによるブラウザ既定動作（保存・ブックマーク等）を抑止する
    if (this.isPointerLocked && (e.ctrlKey || e.metaKey)) e.preventDefault();
    const orderMenuCodes = this.actionToCodes.get('orderMenu') ?? [];
    if (orderMenuCodes.includes(e.code)) {
      if (this.isPointerLocked) e.preventDefault();
      if (!e.repeat && this.isPointerLocked && this.onOrderMenu && this.orderMenuEnabled && !this.choosing && !this.suppressSquadShortcuts) {
        this.choosing = true;
        this.choosingTrigger = 'tab';
        this.mouseDX = this.mouseDY = 0;
        this.onOrderMenu('open', 0);
      }
      this.down.add(e.code);
      return;
    }
    const toggleEntryModeCodes = this.actionToCodes.get('toggleEntryMode') ?? ['Tab'];
    if (this.isPointerLocked && toggleEntryModeCodes.includes(e.code)) {
      e.preventDefault();
    }
    const warningCallCodes = this.actionToCodes.get('warningCall') ?? ['Space'];
    if (this.isPointerLocked && warningCallCodes.includes(e.code)) {
      e.preventDefault();
    }
    if (!e.repeat) this.pressedFrame.add(e.code);
    this.down.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    const orderMenuCodes = this.actionToCodes.get('orderMenu') ?? [];
    if (orderMenuCodes.includes(e.code) && this.choosing && this.choosingTrigger === 'tab') {
      this.choosing = false;
      this.choosingTrigger = null;
      this.onOrderMenu?.(this.isPointerLocked ? 'confirm' : 'cancel', 0);
    }
  };
  private onBlur = (): void => {
    this.cancelGesture();
    this.blockFireUntilRelease = false;
    this.down.clear();
    this.buttons.clear();
  };
  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isPointerLocked) return;
    if (this.choosing) {
      this.onOrderMenu?.('move', e.movementY);
      return;
    }
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };
  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1 && this.isPointerLocked) e.preventDefault();
    if (e.button === 2 && this.isPointerLocked) {
      if (this.onOrderMenu && this.orderMenuEnabled && !this.choosing && !this.suppressSquadShortcuts) {
        this.choosing = true;
        this.choosingTrigger = 'right';
        this.mouseDX = this.mouseDY = 0;
        this.onOrderMenu('open', 0);
      }
    } else if (this.choosing && e.button === 0) {
      this.choosing = false;
      this.choosingTrigger = null;
      this.blockFireUntilRelease = true;
      this.onOrderMenu?.(this.isPointerLocked ? 'confirm' : 'cancel', 0);
    } else if (this.choosing && e.button === 1) {
      this.choosing = false;
      this.choosingTrigger = null;
      this.onOrderMenu?.('cancel', 0);
    } else if (e.button === 1 && this.isPointerLocked) {
      // ホイール押し込み（オプティワンド切替など）。メニューを閉じた押下は含めない
      this.pressedButtons.add(1);
    }
    this.buttons.add(e.button);
  };
  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.blockFireUntilRelease = false;
    if (e.button === 2 && this.choosing && this.choosingTrigger === 'right') {
      this.choosing = false;
      this.choosingTrigger = null;
      this.onOrderMenu?.(this.isPointerLocked ? 'confirm' : 'cancel', 0);
    }
    this.buttons.delete(e.button);
  };
  /** 中ボタンのブラウザ既定動作（オートスクロール・リンクの新規タブ等）をプレイ中は抑止する */
  private onAuxClick = (e: MouseEvent): void => {
    if (e.button === 1 && this.isPointerLocked) e.preventDefault();
  };
  private onWheel = (e: WheelEvent): void => {
    if (this.choosing) {
      this.onOrderMenu?.('wheel', e.deltaY);
      return;
    }
    this.wheel += e.deltaY;
  };
  /** false の間は canvas クリックでの自動ポインタロックを抑止する（ポーズ・ブリーフィング中） */
  allowAutoPointerLock = true;
  /** ポインタロック状態変化コールバック */
  onPointerLockChange: ((locked: boolean) => void) | null = null;

  private onClick = (): void => {
    if (this.allowAutoPointerLock && !this.isPointerLocked) this.requestPointerLock();
  };
  private onLockChange = (): void => {
    const locked = this.isPointerLocked;
    if (!locked) {
      this.cancelGesture();
      this.blockFireUntilRelease = false;
      this.buttons.clear();
      this.mouseDX = 0;
      this.mouseDY = 0;
    }
    this.onPointerLockChange?.(locked);
  };
}
