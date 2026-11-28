import type * as THREE from 'three';
import type { InputManager } from '../core/InputManager';
import type { GameEventBus } from '../core/events';
import type { Interaction } from '../player/Interaction';
import type { PlayerController } from '../player/PlayerController';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { Flashbang } from '../weapons/Flashbang';
import type { Mission } from '../rules/Mission';
import type { SquadSystem } from '../ai/Squad';
import { getLocale, isEn, t, tMotifLabel, tWeaponName } from '../core/i18n';

const MAX_DT = 0.05;
const HIT_MARKER_SEC = 0.2;
const DAMAGE_FLASH_SEC = 0.45;
const RADIO_LINE_SEC = 4.5;
const LEAN_DISPLAY_THRESHOLD = 0.15;
const DEG2RAD = Math.PI / 180;
const MIN_CROSSHAIR_GAP_PX = 3;

const STYLE = `
.cqb-hud{position:fixed;inset:0;pointer-events:none;font:13px/1.35 sans-serif;color:#e8edf2;z-index:5;user-select:none}
.cqb-hud .tick{position:absolute;background:#7CFF7C;box-shadow:0 0 2px #000}
.cqb-hud .dot{position:absolute;left:50%;top:50%;width:2px;height:2px;margin:-1px;background:#7CFF7C}
.cqb-hud .hit{position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px;opacity:0;
  background:linear-gradient(45deg,transparent 45%,#fff 45%,#fff 55%,transparent 55%),linear-gradient(-45deg,transparent 45%,#fff 45%,#fff 55%,transparent 55%)}
.cqb-hud .wound-vig{position:fixed;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 38%,rgba(140,10,10,.55) 100%)}
.cqb-hud .dmg-vig{position:fixed;inset:0;pointer-events:none;opacity:0;box-shadow:inset 0 0 90px rgba(220,25,25,0.85)}
.cqb-hud .dmg-dir{position:absolute;left:50%;top:50%;width:140px;height:140px;margin:-70px 0 0 -70px;pointer-events:none;opacity:0}
.cqb-hud .dmg-dir::before{content:'';position:absolute;left:50%;top:0;width:36px;height:8px;margin-left:-18px;background:#ff3b3b;border-radius:4px;box-shadow:0 0 8px #f00}
.cqb-hud .panel{position:absolute;padding:7px 11px;background:rgba(10,16,24,.72);border:1px solid rgba(110,145,180,.35);border-radius:5px}
.cqb-hud .ammo{right:16px;bottom:16px;font:bold 22px/1.2 monospace;text-align:right;min-width:110px}
.cqb-hud .ammo small{display:block;font:12px sans-serif;opacity:.82;margin-top:2px}
.cqb-hud .bottom-left{position:absolute;left:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;max-width:410px}
.cqb-hud .roster{padding:8px 10px;background:rgba(10,16,24,.76);border:1px solid rgba(110,145,180,.38);border-radius:5px}
.cqb-hud .roster-head{display:flex;justify-content:space-between;align-items:center;font:bold 11px monospace;color:#8eb0d0;margin-bottom:5px;gap:10px}
.cqb-hud .roster-badges{display:flex;align-items:center;gap:6px;white-space:nowrap}
.cqb-hud .roster-mode{padding:1px 5px;border-radius:3px;font-size:10px;border:1px solid transparent}
.cqb-hud .roster-mode.dynamic{background:rgba(242,193,78,.18);border-color:rgba(242,193,78,.5);color:#ffd978}
.cqb-hud .roster-mode.stealth{background:rgba(86,200,216,.18);border-color:rgba(86,200,216,.5);color:#8be4f2}
.cqb-hud .roster-el{color:#f2c14e}
.cqb-hud .ally-row{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:3px;font-size:12px;margin-top:2px;border-left:3px solid transparent}
.cqb-hud .ally-row.selected{background:rgba(86,200,216,.14);border-left-color:#56c8d8}
.cqb-hud .ally-row.down{opacity:.5}
.cqb-hud .ally-name{font-weight:bold;min-width:86px;color:#dce8f5}
.cqb-hud .ally-hp{width:46px;height:5px;background:#1e2936;border-radius:2px;overflow:hidden}
.cqb-hud .ally-hp-fill{height:100%;background:#5cd67d}
.cqb-hud .ally-stat{color:#a8c0d8;font-size:11px;margin-left:auto;white-space:nowrap}
.cqb-hud .player-bar{display:flex;align-items:center;gap:12px;padding:7px 11px;background:rgba(10,16,24,.76);border:1px solid rgba(110,145,180,.38);border-radius:5px;font-family:monospace}
.cqb-hud .hp-wrap{display:flex;align-items:center;gap:7px}
.cqb-hud .hp-track{width:96px;height:8px;background:#1d2732;border-radius:3px;overflow:hidden}
.cqb-hud .hp-fill{height:100%;background:#5cd67d;transition:width 0.08s}
.cqb-hud .radio{position:absolute;right:16px;bottom:84px;max-width:340px;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.cqb-hud .radio-line{padding:4px 9px;background:rgba(10,18,28,.8);border-right:3px solid #56c8d8;border-radius:3px;font-size:12px;color:#dff2ff}
.cqb-hud .prompt{left:50%;top:60%;transform:translateX(-50%);font-size:14px;background:rgba(0,0,0,.68);max-width:90vw;text-align:center}
.cqb-hud .quick-order{left:50%;bottom:16px;transform:translateX(-50%);font:bold 15px monospace;color:#ffe9a8;background:rgba(10,16,24,.78);display:none;white-space:nowrap}
.cqb-hud .interact{left:50%;top:66%;transform:translateX(-50%);font-size:14px;background:rgba(0,0,0,.62);display:none}
.cqb-hud .mission-hint{left:50%;top:16px;transform:translateX(-50%);font-size:14px;font-weight:bold;padding:8px 16px;display:none;max-width:calc(100vw - 580px);text-align:center}
.cqb-hud .lean{position:absolute;top:50%;font-size:22px;opacity:.9}
.cqb-hud .squad-gear{font-size:11px;color:#c9d6e3;margin-top:4px;border-top:1px solid rgba(110,145,180,.2);padding-top:4px;letter-spacing:.02em}
.cqb-hud .squad-gear b{color:#f2c14e}
.cqb-hud .squad-gear .out{color:#ff7b7b}
.cqb-hud .alert-wrap{margin-top:4px;font-size:10px;color:#9fb3c8}
.cqb-hud .alert-track{height:4px;margin-top:2px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden}
.cqb-hud .alert-fill{height:100%;width:0;border-radius:2px;transition:width .25s,background .25s}
.cqb-hud .squad-hint{font-size:11px;color:#93adc8;margin-top:4px;border-top:1px solid rgba(110,145,180,.2);padding-top:4px}
.cqb-hud .top-right{position:absolute;top:12px;right:16px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;width:276px;pointer-events:none}
.cqb-hud .obj-panel{width:100%;box-sizing:border-box;padding:9px 11px;background:rgba(10,16,24,.84);border:1px solid rgba(110,145,180,.42);border-radius:6px;display:none}
.cqb-hud .obj-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font:bold 11px monospace;color:#8eb0d0;margin-bottom:6px;letter-spacing:.04em}
.cqb-hud .obj-badge{padding:1px 6px;border-radius:3px;background:rgba(86,200,216,.16);color:#8be4f2;font-size:10px}
.cqb-hud .obj-now{padding:6px 8px;border-radius:4px;background:rgba(28,46,66,.88);border-left:3px solid #f2c14e;color:#fff4d2;font:bold 12px/1.35 sans-serif;margin-bottom:7px}
.cqb-hud .obj-list{display:flex;flex-direction:column;gap:4px}
.cqb-hud .obj-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:#dce7f3}
.cqb-hud .obj-row.done{color:#8be5a2}
.cqb-hud .obj-lbl{display:flex;align-items:center;gap:6px}
.cqb-hud .obj-mark{font:bold 12px monospace;width:13px;text-align:center}
.cqb-hud .obj-val{font:bold 12px monospace;white-space:nowrap}
.cqb-hud .obj-tag{font:bold 10px sans-serif;margin-left:5px;padding:1px 5px;border-radius:3px;background:rgba(242,193,78,.2);color:#ffd978}
.cqb-hud .obj-tag.red{background:rgba(255,90,90,.24);color:#ffb0b0}
.cqb-hud .obj-subhint{margin-top:6px;padding-top:5px;border-top:1px solid rgba(110,145,180,.22);font-size:11px;color:#9cc2df;text-align:right}
.cqb-hud .motif-chip{align-self:flex-end;font:bold 12px sans-serif;letter-spacing:.12em;padding:4px 10px}
`;

interface RadioEntry {
  el: HTMLDivElement;
  ttl: number;
}

interface RosterRowRefs {
  row: HTMLDivElement;
  name: HTMLSpanElement;
  fill: HTMLDivElement;
  stat: HTMLSpanElement;
  lastCls: string;
  lastName: string;
  lastPct: number;
  lastColor: string;
  lastStat: string;
}

interface ObjectiveRowRefs {
  row: HTMLDivElement;
  mark: HTMLSpanElement;
  name: HTMLSpanElement;
  val: HTMLSpanElement;
  tag: HTMLSpanElement;
  visible: boolean;
  lastCls: string;
  lastMark: string;
  lastName: string;
  lastVal: string;
  lastTag: string;
  lastTagCls: string;
}

function createObjectiveRow(parent: HTMLElement): ObjectiveRowRefs {
  const row = document.createElement('div');
  row.className = 'obj-row';
  const left = document.createElement('span');
  left.className = 'obj-lbl';
  const mark = document.createElement('span');
  mark.className = 'obj-mark';
  const name = document.createElement('span');
  left.append(mark, name);

  const right = document.createElement('span');
  right.className = 'obj-val';
  const val = document.createElement('span');
  const tag = document.createElement('span');
  tag.className = 'obj-tag';
  tag.style.display = 'none';
  right.append(val, tag);

  row.append(left, right);
  parent.appendChild(row);
  return {
    row,
    mark,
    name,
    val,
    tag,
    visible: true,
    lastCls: 'obj-row',
    lastMark: '',
    lastName: '',
    lastVal: '',
    lastTag: '',
    lastTagCls: 'obj-tag',
  };
}

function syncObjectiveRow(
  ref: ObjectiveRowRefs,
  visible: boolean,
  label: string,
  valText: string,
  done: boolean,
  tagText = '',
  tagRed = false,
): void {
  if (visible !== ref.visible) {
    ref.visible = visible;
    ref.row.style.display = visible ? '' : 'none';
  }
  if (!visible) return;
  const cls = done ? 'obj-row done' : 'obj-row';
  if (cls !== ref.lastCls) {
    ref.lastCls = cls;
    ref.row.className = cls;
  }
  const mark = done ? '✓' : '□';
  if (mark !== ref.lastMark) {
    ref.lastMark = mark;
    ref.mark.textContent = mark;
  }
  if (label !== ref.lastName) {
    ref.lastName = label;
    ref.name.textContent = label;
  }
  if (valText !== ref.lastVal) {
    ref.lastVal = valText;
    ref.val.textContent = valText;
  }
  if (tagText !== ref.lastTag) {
    if ((tagText.length > 0) !== (ref.lastTag.length > 0)) {
      ref.tag.style.display = tagText ? '' : 'none';
    }
    ref.lastTag = tagText;
    if (tagText) ref.tag.textContent = tagText;
  }
  if (tagText) {
    const tagCls = tagRed ? 'obj-tag red' : 'obj-tag';
    if (tagCls !== ref.lastTagCls) {
      ref.lastTagCls = tagCls;
      ref.tag.className = tagCls;
    }
  }
}

/**
 * 戦術HUD: 動的照準（移動・射撃時拡散表現付）、右上任務タスク＋スコア、プレイヤーHP・姿勢、
 * 隊員ロスター＆HP・指示状況、被弾方向インジケーター＆ビネット、隊員無線ログ、統一ミッション進行バナー。
 */
export class Hud {
  readonly topRightSlot = document.createElement('div');
  private readonly root = document.createElement('div');
  private readonly styleEl = document.createElement('style');
  private readonly ticks: HTMLDivElement[] = [];
  private readonly hitEl = document.createElement('div');
  private readonly dmgVigEl = document.createElement('div');
  private readonly dmgDirEl = document.createElement('div');
  private readonly ammoEl = document.createElement('div');
  private readonly ammoValEl = document.createElement('span');
  private readonly ammoNameEl = document.createElement('small');
  private readonly objPanelEl = document.createElement('div');
  private readonly objTitleEl = document.createElement('span');
  private readonly objBadgeEl = document.createElement('span');
  private readonly objNowEl = document.createElement('div');
  private readonly objListEl = document.createElement('div');
  private readonly objSubHintEl = document.createElement('div');
  private readonly objSuspectRow: ObjectiveRowRefs;
  private readonly objCivilianRow: ObjectiveRowRefs;
  private readonly objEvidenceRow: ObjectiveRowRefs;
  private readonly woundVigEl = document.createElement('div');
  private woundClock = 0;
  /** 手持ち装備の名前を差し替える外部ソース（オプティワンド展開中は name を返す） */
  toolLabel: (() => string | null) | null = null;
  /** 救急キットの所持数（容疑者モードだけ main が設定） */
  medkitProvider: (() => number) | null = null;
  /** 容疑者の警戒度（SWAT モードのみ）。value 0〜100、tier 0〜4、threat=人質処刑の脅迫中 */
  alertProvider: (() => { value: number; tier: number; threat: boolean } | null) | null = null;
  private readonly gearEl = document.createElement('div');
  private readonly alertWrapEl = document.createElement('div');
  private readonly alertLabelEl = document.createElement('div');
  private readonly alertFillEl = document.createElement('div');
  private lastGearKey = '';
  private lastAlertKey = '';
  private readonly hpTextEl = document.createElement('span');
  private readonly hpFillEl = document.createElement('div');
  private readonly stanceEl = document.createElement('span');
  private readonly rosterEl = document.createElement('div');
  private readonly rosterTitleEl = document.createElement('span');
  private readonly rosterModeEl = document.createElement('span');
  private readonly rosterElLabel = document.createElement('span');
  private readonly rosterListEl = document.createElement('div');
  private readonly rosterLookEl = document.createElement('div');
  private readonly rosterRows: RosterRowRefs[] = [];
  private readonly motifChipEl: HTMLDivElement | null = null;
  private readonly motifInfo?: { id?: string; label: string; color: string };
  private readonly radioEl = document.createElement('div');
  private readonly promptEl = document.createElement('div');
  private readonly interactEl = document.createElement('div');
  private readonly quickOrderEl = document.createElement('div');
  private lastQuickHint = '';
  private readonly missionHintEl = document.createElement('div');
  private readonly leanL = document.createElement('div');
  private readonly leanR = document.createElement('div');
  private readonly unsubs: (() => void)[] = [];
  private readonly radioEntries: RadioEntry[] = [];

  private hitTimer = 0;
  private dmgTimer = 0;
  private dmgFrom: { x: number; z: number } | null = null;
  private displaySpreadDeg = 0;
  private lastAmmoText = '';
  private lastStatusText = '';
  private lastHp = '';
  private lastInteractKey = '';
  private lastMissionKey = '';
  private lastObjectivesKey = '';
  private lastObjVisible = false;
  private lastObjBadge = '';
  private lastObjBadgeBg = '';
  private lastObjBadgeFg = '';
  private lastObjNow = '';
  private lastObjNowColor = '';
  private lastObjSubHint = '';
  private lastRosterVisible: boolean | null = null;
  private lastEntryMode = '';
  private lastElementLabel = '';
  private lastLookText = '';
  private lastLeanL = false;
  private lastLeanR = false;
  private lastHitOpacity = 0;
  private dmgActive = false;
  private lastPromptVisible: boolean | null = null;
  private lastGap = -1;
  private paused = false;
  private disposed = false;

  constructor(
    container: HTMLElement,
    private readonly player: PlayerController,
    private readonly weapons: WeaponSystem,
    private readonly input: InputManager,
    private readonly camera: THREE.PerspectiveCamera,
    bus: GameEventBus,
    private readonly flashbang?: Flashbang,
    private readonly interaction?: Interaction,
    private readonly mission?: Mission,
    private readonly squad?: SquadSystem,
    motif?: { id?: string; label: string; color: string },
  ) {
    this.motifInfo = motif;
    this.styleEl.textContent = STYLE;
    this.root.className = 'cqb-hud';

    for (let i = 0; i < 4; i++) {
      const tick = document.createElement('div');
      tick.className = 'tick';
      this.ticks.push(tick);
      this.root.appendChild(tick);
    }
    const dot = document.createElement('div');
    dot.className = 'dot';
    this.hitEl.className = 'hit';
    this.dmgVigEl.className = 'dmg-vig';
    this.woundVigEl.className = 'wound-vig';
    this.dmgDirEl.className = 'dmg-dir';
    this.ammoEl.className = 'panel ammo';
    this.ammoEl.append(this.ammoValEl, this.ammoNameEl);

    const bottomLeft = document.createElement('div');
    bottomLeft.className = 'bottom-left';

    this.rosterEl.className = 'roster';
    const rHead = document.createElement('div');
    rHead.className = 'roster-head';
    const rBadges = document.createElement('span');
    rBadges.className = 'roster-badges';
    this.rosterModeEl.className = 'roster-mode dynamic';
    this.rosterModeEl.textContent = '[Tab] DYNAMIC';
    this.lastEntryMode = 'dynamic';
    this.rosterElLabel.className = 'roster-el';
    rBadges.append(this.rosterModeEl, this.rosterElLabel);
    rHead.append(this.rosterTitleEl, rBadges);
    this.rosterLookEl.className = 'squad-hint';
    this.rosterLookEl.style.display = 'none';
    this.gearEl.className = 'squad-gear';
    this.gearEl.style.display = 'none';
    this.alertWrapEl.className = 'alert-wrap';
    this.alertWrapEl.style.display = 'none';
    const alertTrack = document.createElement('div');
    alertTrack.className = 'alert-track';
    this.alertFillEl.className = 'alert-fill';
    alertTrack.appendChild(this.alertFillEl);
    this.alertWrapEl.append(this.alertLabelEl, alertTrack);
    this.rosterEl.append(rHead, this.rosterListEl, this.rosterLookEl, this.gearEl, this.alertWrapEl);

    const playerBar = document.createElement('div');
    playerBar.className = 'player-bar';
    const hpWrap = document.createElement('div');
    hpWrap.className = 'hp-wrap';
    const hpTrack = document.createElement('div');
    hpTrack.className = 'hp-track';
    this.hpFillEl.className = 'hp-fill';
    hpTrack.appendChild(this.hpFillEl);
    this.hpTextEl.style.fontWeight = 'bold';
    hpWrap.append(this.hpTextEl, hpTrack);
    playerBar.append(hpWrap, this.stanceEl);
    bottomLeft.append(this.rosterEl, playerBar);

    this.topRightSlot.className = 'top-right';
    if (motif) {
      const chip = document.createElement('div');
      chip.className = 'panel motif-chip';
      chip.style.color = motif.color;
      chip.style.borderColor = motif.color;
      this.motifChipEl = chip;
      this.topRightSlot.appendChild(chip);
    }
    this.objPanelEl.className = 'obj-panel';
    const oHead = document.createElement('div');
    oHead.className = 'obj-head';
    this.objBadgeEl.className = 'obj-badge';
    oHead.append(this.objTitleEl, this.objBadgeEl);
    this.objNowEl.className = 'obj-now';
    this.objListEl.className = 'obj-list';
    this.objSuspectRow = createObjectiveRow(this.objListEl);
    this.objCivilianRow = createObjectiveRow(this.objListEl);
    this.objEvidenceRow = createObjectiveRow(this.objListEl);
    this.objSubHintEl.className = 'obj-subhint';
    this.objSubHintEl.style.display = 'none';
    this.objPanelEl.append(oHead, this.objNowEl, this.objListEl, this.objSubHintEl);
    this.topRightSlot.appendChild(this.objPanelEl);

    this.radioEl.className = 'radio';
    this.promptEl.className = 'panel prompt';
    this.interactEl.className = 'panel interact';
    this.quickOrderEl.className = 'panel quick-order';
    this.missionHintEl.className = 'panel mission-hint';
    this.leanL.className = 'lean';
    this.leanL.style.left = '24px';
    this.leanL.textContent = '◀';
    this.leanR.className = 'lean';
    this.leanR.style.right = '24px';
    this.leanR.textContent = '▶';
    this.leanL.style.visibility = this.leanR.style.visibility = 'hidden';

    this.applyStaticLabels();

    this.root.append(
      this.woundVigEl,
      this.dmgVigEl,
      this.dmgDirEl,
      dot,
      this.hitEl,
      this.topRightSlot,
      this.ammoEl,
      bottomLeft,
      this.radioEl,
      this.promptEl,
      this.interactEl,
      this.quickOrderEl,
      this.missionHintEl,
      this.leanL,
      this.leanR,
    );
    document.head.appendChild(this.styleEl);
    container.appendChild(this.root);

    this.unsubs.push(
      bus.on('entityHit', (e) => {
        if (e.shooter === 'player') this.hitTimer = HIT_MARKER_SEC;
      }),
      bus.on('playerHit', (e) => {
        this.dmgTimer = DAMAGE_FLASH_SEC;
        this.dmgFrom = { x: e.from.x, z: e.from.z };
      }),
      bus.on('allyRadio', (e) => {
        const line = document.createElement('div');
        line.className = 'radio-line';
        const msg = isEn() && e.voiceText ? e.voiceText : e.text;
        line.textContent = isEn() ? `[${e.name}] ${msg}` : `【${e.name}】${msg}`;
        this.radioEl.appendChild(line);
        this.radioEntries.push({ el: line, ttl: RADIO_LINE_SEC });
        while (this.radioEntries.length > 3) {
          this.radioEntries.shift()?.el.remove();
        }
      }),
    );
    this.update(0);
  }

  private applyStaticLabels(): void {
    this.rosterTitleEl.textContent = t(
      'SQUAD [右クリック指示 / Z簡易 / X集合 / 中クリック・4ワンド]',
      'SQUAD [RMB Order / Z Quick / X Fall In / MMB·4 Wand]',
    );
    this.objTitleEl.textContent = t('作戦目標 / OBJECTIVES', 'OBJECTIVES');
    this.promptEl.textContent = t(
      'クリックで開始 — WASD移動 / Shift静音 / C屈み(切替) / Q,Eリーン / 左クリック射撃 / 右クリック部隊指揮 / Zクイック指示 / X集合 / Space警告 / F開閉・拘束 / 1-4・中クリック装備 / ESCポーズ',
      'Click to Lock Mouse — WASD Move / Shift Walk / C Crouch (Toggle) / Q,E Lean / LMB Fire / RMB Squad Menu / Z Quick Order / X Fall In / Space Shout / F Interact / 1-4 / MMB Gear / ESC Pause',
    );
    if (this.motifChipEl && this.motifInfo) {
      const m = this.motifInfo;
      const isHouse = m.id === 'residence' || m.id === 'japanese_house';
      this.motifChipEl.textContent = isEn()
        ? tMotifLabel(m.id ?? '', m.label)
        : isHouse
          ? m.label
          : `施設 ${m.label}`;
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused && this.lastPromptVisible !== false) {
      this.lastPromptVisible = false;
      this.promptEl.style.display = 'none';
    }
  }

  refreshLocale(): void {
    if (this.disposed) return;
    this.applyStaticLabels();
    this.lastAmmoText = '';
    this.lastHp = '';
    this.lastMissionKey = '';
    this.lastObjectivesKey = '';
    this.lastElementLabel = '';
    this.lastLookText = '';
    this.update(0);
  }

  private ensureRosterRow(idx: number): RosterRowRefs {
    let ref = this.rosterRows[idx];
    if (ref) return ref;
    const row = document.createElement('div');
    row.className = 'ally-row';
    const name = document.createElement('span');
    name.className = 'ally-name';
    const bar = document.createElement('div');
    bar.className = 'ally-hp';
    const fill = document.createElement('div');
    fill.className = 'ally-hp-fill';
    bar.appendChild(fill);
    const stat = document.createElement('span');
    stat.className = 'ally-stat';
    row.append(name, bar, stat);
    this.rosterListEl.appendChild(row);
    ref = {
      row,
      name,
      fill,
      stat,
      lastCls: 'ally-row',
      lastName: '',
      lastPct: -1,
      lastColor: '',
      lastStat: '',
    };
    this.rosterRows.push(ref);
    return ref;
  }

  /** 分隊の閃光弾・ガスの残数と、容疑者の警戒度（SWAT モード）を更新する。 */
  private updateGearAndAlert(): void {
    const gear = this.squad?.getGear();
    if (gear) {
      const key = `${getLocale()}|${gear.flash}|${gear.gas}`;
      if (key !== this.lastGearKey) {
        this.lastGearKey = key;
        const part = (label: string, n: number, max: number): string =>
          `${label} <b class="${n <= 0 ? 'out' : ''}">${n}</b>/${max}`;
        this.gearEl.innerHTML = `${part(t('閃光', 'Flash'), gear.flash, gear.flashMax)}　${part(t('ガス', 'Gas'), gear.gas, gear.gasMax)}`;
        this.gearEl.style.display = 'block';
      }
    }
    const al = this.alertProvider?.() ?? null;
    if (!al) {
      if (this.lastAlertKey !== '') {
        this.lastAlertKey = '';
        this.alertWrapEl.style.display = 'none';
      }
      return;
    }
    const pct = Math.round(al.value);
    const key = `${getLocale()}|${pct}|${al.tier}|${al.threat ? 1 : 0}`;
    if (key === this.lastAlertKey) return;
    this.lastAlertKey = key;
    const tierLabel = ['', t('警戒', 'Wary'), t('臨戦', 'Ready'), t('危険', 'Danger'), t('極限', 'Critical')][al.tier] ?? '';
    this.alertLabelEl.textContent = `${t('容疑者の警戒', 'Suspect Alert')} ${pct}${tierLabel ? ` · ${tierLabel}` : ''}${al.threat ? ` · ${t('人質が危険', 'HOSTAGE AT RISK')}` : ''}`;
    this.alertFillEl.style.width = `${pct}%`;
    this.alertFillEl.style.background = al.tier >= 4 ? '#ff4d4d' : al.tier >= 3 ? '#ff8a45' : al.tier >= 2 ? '#f2c14e' : al.tier >= 1 ? '#c8d76a' : '#5cd67d';
    this.alertWrapEl.style.display = 'block';
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    const w = this.weapons;

    // 照準: 拡散(度)を滑らかに補間し画面ピクセルに換算してティックを開閉
    const spreadBlend = rawDt <= 0 ? 1 : 1 - Math.exp(-18 * dt);
    this.displaySpreadDeg += (w.spreadDeg - this.displaySpreadDeg) * spreadBlend;
    const halfH = window.innerHeight / 2;
    const tanHalfFov = Math.tan((this.camera.fov * DEG2RAD) / 2);
    const gap = Math.round(Math.max(MIN_CROSSHAIR_GAP_PX, (Math.tan(this.displaySpreadDeg * DEG2RAD) / tanHalfFov) * halfH));
    if (gap !== this.lastGap) {
      this.lastGap = gap;
      const len = 8;
      const th = 2;
      const set = (el: HTMLDivElement, l: string, t: string, wd: number, ht: number) => {
        el.style.left = l;
        el.style.top = t;
        el.style.width = `${wd}px`;
        el.style.height = `${ht}px`;
      };
      set(this.ticks[0]!, `calc(50% - ${th / 2}px)`, `calc(50% - ${gap + len}px)`, th, len);
      set(this.ticks[1]!, `calc(50% - ${th / 2}px)`, `calc(50% + ${gap}px)`, th, len);
      set(this.ticks[2]!, `calc(50% - ${gap + len}px)`, `calc(50% - ${th / 2}px)`, len, th);
      set(this.ticks[3]!, `calc(50% + ${gap}px)`, `calc(50% - ${th / 2}px)`, len, th);
    }

    // 弾数・武器・装備
    const fb = this.flashbang;
    const reserve = w.reserveAmmo;
    const tool = this.toolLabel?.() ?? null;
    const wName = fb?.equipped
      ? tWeaponName(fb.weapon.id, fb.weapon.name)
      : tWeaponName(w.weapon.id, w.weapon.name);
    const ammoText = tool
      ? `${tool}|—`
      : fb?.equipped
      ? `${wName}|${fb.remaining}/${fb.weapon.magazineSize}`
      : w.isReloading
        ? `${wName}|RELOADING`
        : reserve !== null
          ? `${wName}  ${t('予備', 'RES')} ${reserve}|${w.ammoInMagazine}/${w.weapon.magazineSize}`
          : `${wName}|${w.ammoInMagazine}/${w.weapon.magazineSize}`;
    if (ammoText !== this.lastAmmoText) {
      this.lastAmmoText = ammoText;
      const [name, val] = ammoText.split('|');
      this.ammoValEl.textContent = val ?? '';
      this.ammoNameEl.textContent = name ?? '';
    }

    // プレイヤーHP & 姿勢
    const hp = Math.round(this.player.hp);
    const armor = Math.round(this.player.armor);
    const armorKind = this.player.armorKind;
    const medkits = this.medkitProvider?.() ?? 0;
    const hpKey = `${hp}|${armor}|${armorKind ?? ''}|${medkits}`;
    if (hpKey !== this.lastHp) {
      this.lastHp = hpKey;
      const pct = Math.max(0, Math.min(100, (hp / Math.max(1, this.player.maxHp)) * 100));
      const heavy = armorKind === 'suspectVest' ? t('（重）', ' (Heavy)') : '';
      const hpText =
        armorKind === null
          ? `HP ${hp}`
          : armor > 0
            ? `HP ${hp}  ${t('防弾', 'ARM')} ${armor}${heavy}`
            : `HP ${hp}  ${t('防弾', 'ARM')} ${t('破損', 'BROKEN')}${heavy}`;
      this.hpTextEl.textContent = medkits > 0 ? `${hpText}  ${t('救急', 'MEDKIT')} ×${medkits} [H]` : hpText;
      this.hpFillEl.style.width = `${pct}%`;
      this.hpFillEl.style.background = pct > 55 ? '#5cd67d' : pct > 25 ? '#f2c14e' : '#ff5555';
    }
    const stance = this.player.isCrouching ? 'CROUCH [C]' : 'STAND [C]';
    const mode = this.player.moveMode === 'quiet' ? 'QUIET' : this.player.moveMode === 'run' ? 'RUN' : 'CROUCH-WALK';
    const statusText = `${stance} / ${mode}`;
    if (statusText !== this.lastStatusText) {
      this.lastStatusText = statusText;
      this.stanceEl.textContent = statusText;
    }

    // 分隊ロスター（永続 DOM 行をインプレース更新）
    if (this.squad) {
      const roster = this.squad.getRoster();
      const showRoster = roster.length > 0;
      if (showRoster !== this.lastRosterVisible) {
        this.lastRosterVisible = showRoster;
        this.rosterEl.style.display = showRoster ? 'block' : 'none';
      }
      if (showRoster) {
        const entryMode = this.squad.getEntryMode();
        if (entryMode !== this.lastEntryMode) {
          this.lastEntryMode = entryMode;
          this.rosterModeEl.textContent = entryMode === 'stealth' ? '[Tab] STEALTH' : '[Tab] DYNAMIC';
          this.rosterModeEl.className = `roster-mode ${entryMode}`;
        }
        const elLbl = `[T] ${this.squad.elementLabel}`;
        if (elLbl !== this.lastElementLabel) {
          this.lastElementLabel = elLbl;
          this.rosterElLabel.textContent = elLbl;
        }
        while (this.rosterRows.length > roster.length) {
          this.rosterRows.pop()?.row.remove();
        }
        for (let i = 0; i < roster.length; i++) {
          const r = roster[i]!;
          const ref = this.ensureRosterRow(i);
          const cls = 'ally-row' + (r.selected ? ' selected' : '') + (r.down ? ' down' : '');
          if (cls !== ref.lastCls) {
            ref.lastCls = cls;
            ref.row.className = cls;
          }
          const nameText = `${r.callsign} ${r.name}`;
          if (nameText !== ref.lastName) {
            ref.lastName = nameText;
            ref.name.textContent = nameText;
          }
          const pct = Math.round(Math.max(0, Math.min(100, (r.hp / Math.max(1, r.maxHp)) * 100)));
          if (pct !== ref.lastPct) {
            ref.lastPct = pct;
            ref.fill.style.width = `${pct}%`;
            const color = pct > 55 ? '#5cd67d' : pct > 25 ? '#f2c14e' : '#ff5555';
            if (color !== ref.lastColor) {
              ref.lastColor = color;
              ref.fill.style.background = color;
            }
          }
          const statText = `${r.orderLabel} · ${r.statusText}`;
          if (statText !== ref.lastStat) {
            ref.lastStat = statText;
            ref.stat.textContent = statText;
          }
        }
        this.updateGearAndAlert();
        const lookText = this.squad.hudText();
        if (lookText !== this.lastLookText) {
          if ((lookText.length > 0) !== (this.lastLookText.length > 0)) {
            this.rosterLookEl.style.display = lookText ? 'block' : 'none';
          }
          this.lastLookText = lookText;
          if (lookText) this.rosterLookEl.textContent = lookText;
        }
      }
    } else if (this.lastRosterVisible !== false) {
      this.lastRosterVisible = false;
      this.rosterEl.style.display = 'none';
    }

    // 無線ログTTL
    for (let i = this.radioEntries.length - 1; i >= 0; i--) {
      const entry = this.radioEntries[i]!;
      entry.ttl -= dt;
      if (entry.ttl < 0.6) entry.el.style.opacity = String(Math.max(0, entry.ttl / 0.6));
      if (entry.ttl <= 0) {
        entry.el.remove();
        this.radioEntries.splice(i, 1);
      }
    }

    // リーン
    const lean = this.player.leanAmount;
    const showLeanL = lean < -LEAN_DISPLAY_THRESHOLD;
    if (showLeanL !== this.lastLeanL) {
      this.lastLeanL = showLeanL;
      this.leanL.style.visibility = showLeanL ? 'visible' : 'hidden';
    }
    const showLeanR = lean > LEAN_DISPLAY_THRESHOLD;
    if (showLeanR !== this.lastLeanR) {
      this.lastLeanR = showLeanR;
      this.leanR.style.visibility = showLeanR ? 'visible' : 'hidden';
    }

    // ヒットマーカー
    if (this.hitTimer > 0 || this.lastHitOpacity !== 0) {
      this.hitTimer = Math.max(0, this.hitTimer - dt);
      const hitOp = this.hitTimer / HIT_MARKER_SEC;
      if (hitOp !== this.lastHitOpacity) {
        this.lastHitOpacity = hitOp;
        this.hitEl.style.opacity = String(hitOp);
      }
    }

    // 負傷ビネット（HP 低下で赤い周辺、重傷では心拍に合わせて脈動）
    const wl = this.player.woundLevel;
    if (wl > 0) {
      this.woundClock += dt * (wl === 2 ? 7.5 : 3.2);
      const beat = wl === 2 ? Math.max(0, Math.sin(this.woundClock)) ** 3 : 0.5 + 0.5 * Math.sin(this.woundClock);
      this.woundVigEl.style.opacity = String(wl === 2 ? 0.55 + 0.45 * beat : 0.25 + 0.15 * beat);
    } else if (this.woundVigEl.style.opacity !== '0') {
      this.woundVigEl.style.opacity = '0';
    }

    // 被弾ビネット＆方向インジケーター
    if (this.dmgTimer > 0) {
      this.dmgActive = true;
      this.dmgTimer = Math.max(0, this.dmgTimer - dt);
      const a = String(this.dmgTimer / DAMAGE_FLASH_SEC);
      this.dmgVigEl.style.opacity = a;
      if (this.dmgFrom) {
        const dx = this.dmgFrom.x - this.player.position.x;
        const dz = this.dmgFrom.z - this.player.position.z;
        const worldAngle = Math.atan2(dx, dz);
        const rel = -(worldAngle + this.player.yawRad) + Math.PI;
        this.dmgDirEl.style.opacity = a;
        this.dmgDirEl.style.transform = `rotate(${rel}rad)`;
      }
      if (this.dmgTimer <= 0) {
        this.dmgActive = false;
        this.dmgVigEl.style.opacity = '0';
        this.dmgDirEl.style.opacity = '0';
      }
    } else if (this.dmgActive) {
      this.dmgActive = false;
      this.dmgVigEl.style.opacity = '0';
      this.dmgDirEl.style.opacity = '0';
    }

    const showPrompt = !(this.paused || this.input.isPointerLocked || !this.player.alive);
    if (showPrompt !== this.lastPromptVisible) {
      this.lastPromptVisible = showPrompt;
      this.promptEl.style.display = showPrompt ? 'block' : 'none';
    }

    // インタラクト対象プロンプト
    const target =
      !this.paused && this.input.isPointerLocked && !this.input.isOrderMenuOpen && this.player.alive
        ? (this.interaction?.getInteractTarget() ?? null)
        : null;
    const interactKey = target && target.label ? `${target.providerId}:${target.label}` : '';
    if (interactKey !== this.lastInteractKey) {
      this.lastInteractKey = interactKey;
      if (target && target.label) {
        this.interactEl.textContent = target.label;
        this.interactEl.style.display = 'block';
      } else {
        this.interactEl.style.display = 'none';
      }
    }

    // Zクイック指示ヒント（画面下部）
    const quickHint =
      !this.paused && this.squad && this.input.isPointerLocked && !this.input.isOrderMenuOpen && !this.input.suppressSquadShortcuts && this.player.alive
        ? this.squad.quickOrderHint(dt)
        : '';
    if (quickHint !== this.lastQuickHint) {
      this.lastQuickHint = quickHint;
      this.quickOrderEl.textContent = quickHint;
      this.quickOrderEl.style.display = quickHint ? 'block' : 'none';
    }

    // ミッション完了/失敗の統一バナー
    let missionHint = '';
    let missionTone = 'teal';
    if (this.mission && !this.mission.ended) {
      const st = this.mission.status;
      if (st.phase === 'failing') {
        missionHint = t('隊長行動不能 — 作戦中止...', 'TEAM LEADER DOWN — MISSION ABORTED...');
        missionTone = 'red';
      } else if (st.phase === 'completing') {
        missionHint = t(
          `ALL CLEAR — 本部へ作戦完了を報告中... (${st.countdownSec.toFixed(1)}s)`,
          `ALL CLEAR — Reporting mission complete to TOC... (${st.countdownSec.toFixed(1)}s)`,
        );
        missionTone = 'green';
      } else if (st.phase === 'post_clear') {
        const parts: string[] = [];
        if (st.remainingCivilians > 0) parts.push(t(`民間人保護 ${st.remainingCivilians}`, `Civilians ${st.remainingCivilians}`));
        if (st.remainingEvidence > 0) parts.push(t(`証拠回収 ${st.remainingEvidence}`, `Evidence ${st.remainingEvidence}`));
        missionHint = t(
          `全脅威制圧完了 — 隊員が現場確保を実施中（残: ${parts.join(' / ')}） [Enter で完了報告]`,
          `ALL THREATS NEUTRALIZED — Securing scene (${parts.join(' / ')}) [Enter to Complete]`,
        );
        missionTone = 'teal';
      }
    }
    const missionKey = `${missionTone}:${missionHint}`;
    if (missionKey !== this.lastMissionKey) {
      this.lastMissionKey = missionKey;
      if (missionHint) {
        this.missionHintEl.textContent = missionHint;
        this.missionHintEl.style.display = 'block';
        if (missionTone === 'red') {
          this.missionHintEl.style.background = 'rgba(72,16,16,.88)';
          this.missionHintEl.style.borderColor = '#ff6b6b';
          this.missionHintEl.style.color = '#ffd6d6';
        } else if (missionTone === 'green') {
          this.missionHintEl.style.background = 'rgba(16,56,34,.88)';
          this.missionHintEl.style.borderColor = '#5cd67d';
          this.missionHintEl.style.color = '#d9ffe6';
        } else {
          this.missionHintEl.style.background = 'rgba(16,38,44,.86)';
          this.missionHintEl.style.borderColor = '#56c8d8';
          this.missionHintEl.style.color = '#d2f6ff';
        }
      } else {
        this.missionHintEl.style.display = 'none';
      }
    }
    this.updateObjectives();
  }

  private updateObjectives(): void {
    const st = this.mission?.status;
    if (!st || st.totalSuspects === 0 || st.phase === 'ended') {
      if (this.lastObjVisible) {
        this.lastObjVisible = false;
        this.lastObjectivesKey = 'hidden';
        this.objPanelEl.style.display = 'none';
      }
      return;
    }

    const countdownStr = st.phase === 'completing' ? st.countdownSec.toFixed(1) : '';
    const key = `${getLocale()}|${st.phase}|${st.neutralizedSuspects}|${st.totalSuspects}|${st.surrenderedSuspects}|${st.activeSuspects}|${st.securedCivilians}|${st.totalCivilians}|${st.deadCivilians}|${st.collectedEvidence}|${st.totalEvidence}|${st.droppedEvidence}|${countdownStr}`;
    if (key === this.lastObjectivesKey) return;
    this.lastObjectivesKey = key;

    if (!this.lastObjVisible) {
      this.lastObjVisible = true;
      this.objPanelEl.style.display = 'block';
    }

    let badge = t('交戦・制圧中', 'IN PROGRESS');
    let badgeBg = 'rgba(86,200,216,.16)';
    let badgeFg = '#8be4f2';
    let nowText = '';
    let nowColor = '#f2c14e';

    if (st.phase === 'failing') {
      badge = t('作戦中止', 'ABORTED');
      badgeBg = 'rgba(255,90,90,.24)';
      badgeFg = '#ffb8b8';
      nowText = t('✖ 隊長行動不能 — 作戦中止', '✖ Team Leader Down — Aborting');
      nowColor = '#ff6b6b';
    } else if (st.phase === 'completing') {
      badge = t('完了報告', 'COMPLETING');
      badgeBg = 'rgba(92,214,125,.2)';
      badgeFg = '#b9ffd0';
      nowText = t(
        `✓ 全目標完了 — 本部へ報告中 (${countdownStr}s)`,
        `✓ All Objectives Complete — Reporting (${countdownStr}s)`,
      );
      nowColor = '#5cd67d';
    } else if (st.activeSuspects > 0) {
      badge = t('交戦・制圧中', 'ENGAGING');
      nowText = t(
        `▶ 武装容疑者を制圧せよ（残 ${st.activeSuspects}名）`,
        `▶ Neutralize armed suspects (${st.activeSuspects} left)`,
      );
      nowColor = '#f2c14e';
    } else if (st.surrenderedSuspects > 0) {
      badge = t('要拘束あり', 'RESTRAIN');
      badgeBg = 'rgba(242,193,78,.22)';
      badgeFg = '#ffe08a';
      nowText = t(
        `▶ 投降した容疑者を拘束せよ [F長押し]（残 ${st.surrenderedSuspects}名）`,
        `▶ Restrain surrendered suspects [Hold F] (${st.surrenderedSuspects} left)`,
      );
      nowColor = '#f2c14e';
    } else if (st.remainingCivilians > 0) {
      badge = t('現場確保中', 'SECURING');
      badgeBg = 'rgba(86,200,216,.2)';
      badgeFg = '#a5f0ff';
      nowText = t(
        `▶ 人質・民間人を確保せよ [F長押し]（残 ${st.remainingCivilians}名）`,
        `▶ Secure hostages / civilians [Hold F] (${st.remainingCivilians} left)`,
      );
      nowColor = '#56c8d8';
    } else if (st.remainingEvidence > 0) {
      badge = t('現場確保中', 'SECURING');
      badgeBg = 'rgba(86,200,216,.2)';
      badgeFg = '#a5f0ff';
      nowText = t(
        `▶ 証拠品（銃器）を押収せよ [F長押し]（残 ${st.remainingEvidence}点）`,
        `▶ Collect dropped weapons [Hold F] (${st.remainingEvidence} left)`,
      );
      nowColor = '#56c8d8';
    }

    if (badge !== this.lastObjBadge) {
      this.lastObjBadge = badge;
      this.objBadgeEl.textContent = badge;
    }
    if (badgeBg !== this.lastObjBadgeBg) {
      this.lastObjBadgeBg = badgeBg;
      this.objBadgeEl.style.background = badgeBg;
    }
    if (badgeFg !== this.lastObjBadgeFg) {
      this.lastObjBadgeFg = badgeFg;
      this.objBadgeEl.style.color = badgeFg;
    }
    if (nowText !== this.lastObjNow) {
      this.lastObjNow = nowText;
      this.objNowEl.textContent = nowText;
    }
    if (nowColor !== this.lastObjNowColor) {
      this.lastObjNowColor = nowColor;
      this.objNowEl.style.borderLeftColor = nowColor;
    }

    syncObjectiveRow(
      this.objSuspectRow,
      true,
      t('容疑者制圧', 'Neutralize Suspects'),
      `${st.neutralizedSuspects} / ${st.totalSuspects}`,
      st.allSuspectsNeutralized,
      st.surrenderedSuspects > 0 ? t(`要拘束 ${st.surrenderedSuspects}`, `Cuff ${st.surrenderedSuspects}`) : '',
    );

    const showCiv = st.totalCivilians > 0 || st.deadCivilians > 0;
    syncObjectiveRow(
      this.objCivilianRow,
      showCiv,
      t('人質確保', 'Secure Civilians'),
      `${st.securedCivilians} / ${st.totalCivilians}`,
      st.remainingCivilians === 0,
      st.deadCivilians > 0 ? t(`犠牲 ${st.deadCivilians}`, `KIA ${st.deadCivilians}`) : '',
      true,
    );

    const evDone = st.activeSuspects === 0 && st.droppedEvidence === 0 && st.totalEvidence > 0;
    syncObjectiveRow(
      this.objEvidenceRow,
      true,
      t('証拠品押収', 'Collect Evidence'),
      `${st.collectedEvidence} / ${st.totalEvidence}`,
      evDone,
      st.droppedEvidence > 0 ? t(`未回収 ${st.droppedEvidence}`, `Left ${st.droppedEvidence}`) : '',
    );

    const subHint =
      st.phase === 'post_clear'
        ? t('[Enter / Backspace] 現時点で完了報告して終了', '[Enter / Backspace] Report & Finish Now')
        : '';
    if (subHint !== this.lastObjSubHint) {
      if ((subHint.length > 0) !== (this.lastObjSubHint.length > 0)) {
        this.objSubHintEl.style.display = subHint ? 'block' : 'none';
      }
      this.lastObjSubHint = subHint;
      if (subHint) this.objSubHintEl.textContent = subHint;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const r of this.radioEntries) r.el.remove();
    this.radioEntries.length = 0;
    this.rosterRows.length = 0;
    this.root.remove();
    this.styleEl.remove();
  }
}
