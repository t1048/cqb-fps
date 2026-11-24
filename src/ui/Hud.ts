import type * as THREE from 'three';
import type { InputManager } from '../core/InputManager';
import type { GameEventBus } from '../core/events';
import type { Interaction } from '../player/Interaction';
import type { PlayerController } from '../player/PlayerController';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { Flashbang } from '../weapons/Flashbang';
import type { Mission } from '../rules/Mission';
import type { SquadSystem } from '../ai/Squad';

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
.cqb-hud .dmg-vig{position:fixed;inset:0;pointer-events:none;opacity:0;box-shadow:inset 0 0 90px rgba(220,25,25,0.85)}
.cqb-hud .dmg-dir{position:absolute;left:50%;top:50%;width:140px;height:140px;margin:-70px 0 0 -70px;pointer-events:none;opacity:0}
.cqb-hud .dmg-dir::before{content:'';position:absolute;left:50%;top:0;width:36px;height:8px;margin-left:-18px;background:#ff3b3b;border-radius:4px;box-shadow:0 0 8px #f00}
.cqb-hud .panel{position:absolute;padding:7px 11px;background:rgba(10,16,24,.72);border:1px solid rgba(110,145,180,.35);border-radius:5px}
.cqb-hud .ammo{right:16px;bottom:16px;font:bold 22px/1.2 monospace;text-align:right;min-width:110px}
.cqb-hud .ammo small{display:block;font:12px sans-serif;opacity:.82;margin-top:2px}
.cqb-hud .bottom-left{position:absolute;left:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;max-width:410px}
.cqb-hud .roster{padding:8px 10px;background:rgba(10,16,24,.76);border:1px solid rgba(110,145,180,.38);border-radius:5px}
.cqb-hud .roster-head{display:flex;justify-content:space-between;align-items:center;font:bold 11px monospace;color:#8eb0d0;margin-bottom:5px;gap:10px}
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
  private readonly objPanelEl = document.createElement('div');
  private readonly objBadgeEl = document.createElement('span');
  private readonly objNowEl = document.createElement('div');
  private readonly objListEl = document.createElement('div');
  private readonly objSubHintEl = document.createElement('div');
  private readonly hpTextEl = document.createElement('span');
  private readonly hpFillEl = document.createElement('div');
  private readonly stanceEl = document.createElement('span');
  private readonly rosterEl = document.createElement('div');
  private readonly rosterElLabel = document.createElement('span');
  private readonly rosterListEl = document.createElement('div');
  private readonly rosterLookEl = document.createElement('div');
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
  private lastHp = -1;
  private lastInteractKey = '';
  private lastMissionKey = '';
  private lastObjectivesKey = '';
  private lastRosterKey = '';
  private lastGap = -1;
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
    motif?: { label: string; color: string },
  ) {
    this.styleEl.textContent = STYLE;
    this.root.className = 'cqb-hud';

    for (let i = 0; i < 4; i++) {
      const t = document.createElement('div');
      t.className = 'tick';
      this.ticks.push(t);
      this.root.appendChild(t);
    }
    const dot = document.createElement('div');
    dot.className = 'dot';
    this.hitEl.className = 'hit';
    this.dmgVigEl.className = 'dmg-vig';
    this.dmgDirEl.className = 'dmg-dir';
    this.ammoEl.className = 'panel ammo';

    const bottomLeft = document.createElement('div');
    bottomLeft.className = 'bottom-left';

    this.rosterEl.className = 'roster';
    const rHead = document.createElement('div');
    rHead.className = 'roster-head';
    const rTitle = document.createElement('span');
    rTitle.textContent = 'SQUAD [右クリック指示 / Z簡易 / X集合]';
    this.rosterElLabel.className = 'roster-el';
    rHead.append(rTitle, this.rosterElLabel);
    this.rosterLookEl.className = 'squad-hint';
    this.rosterLookEl.style.display = 'none';
    this.rosterEl.append(rHead, this.rosterListEl, this.rosterLookEl);

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
      chip.textContent = motif.label === '民家' ? '民家' : `施設 ${motif.label}`;
      chip.style.color = motif.color;
      chip.style.borderColor = motif.color;
      this.topRightSlot.appendChild(chip);
    }
    this.objPanelEl.className = 'obj-panel';
    const oHead = document.createElement('div');
    oHead.className = 'obj-head';
    const oTitle = document.createElement('span');
    oTitle.textContent = '作戦目標 / OBJECTIVES';
    this.objBadgeEl.className = 'obj-badge';
    oHead.append(oTitle, this.objBadgeEl);
    this.objNowEl.className = 'obj-now';
    this.objListEl.className = 'obj-list';
    this.objSubHintEl.className = 'obj-subhint';
    this.objSubHintEl.style.display = 'none';
    this.objPanelEl.append(oHead, this.objNowEl, this.objListEl, this.objSubHintEl);
    this.topRightSlot.appendChild(this.objPanelEl);

    this.radioEl.className = 'radio';
    this.promptEl.className = 'panel prompt';
    this.promptEl.textContent =
      'クリックで開始 — WASD移動 / Shift静音 / C屈み / Q,Eリーン / 左クリック射撃 / 右クリック部隊指揮 / Zクイック指示 / X集合 / Space警告 / F開閉・拘束 / 1-4装備';
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

    this.root.append(
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
        line.textContent = `【${e.name}】${e.text}`;
        this.radioEl.appendChild(line);
        this.radioEntries.push({ el: line, ttl: RADIO_LINE_SEC });
        while (this.radioEntries.length > 3) {
          this.radioEntries.shift()?.el.remove();
        }
      }),
    );
    this.update(0);
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
    const ammoText = fb?.equipped
      ? `${fb.weapon.name}|${fb.remaining}/${fb.weapon.magazineSize}`
      : w.isReloading
        ? `${w.weapon.name}|RELOADING`
        : reserve !== null
          ? `${w.weapon.name}  予備 ${reserve}|${w.ammoInMagazine}/${w.weapon.magazineSize}`
          : `${w.weapon.name}|${w.ammoInMagazine}/${w.weapon.magazineSize}`;
    if (ammoText !== this.lastAmmoText) {
      this.lastAmmoText = ammoText;
      const [name, val] = ammoText.split('|');
      this.ammoEl.textContent = '';
      this.ammoEl.append(val ?? '');
      const small = document.createElement('small');
      small.textContent = name ?? '';
      this.ammoEl.appendChild(small);
    }

    // プレイヤーHP & 姿勢
    const hp = Math.round(this.player.hp);
    const armor = Math.round(this.player.armor);
    if (hp * 1000 + armor !== this.lastHp) {
      this.lastHp = hp * 1000 + armor;
      const pct = Math.max(0, Math.min(100, (hp / Math.max(1, this.player.maxHp)) * 100));
      this.hpTextEl.textContent = armor > 0 ? `HP ${hp}  防弾 ${armor}` : `HP ${hp}`;
      this.hpFillEl.style.width = `${pct}%`;
      this.hpFillEl.style.background = pct > 55 ? '#5cd67d' : pct > 25 ? '#f2c14e' : '#ff5555';
    }
    const stance = this.player.isCrouching ? 'CROUCH' : 'STAND';
    const mode = this.player.moveMode === 'quiet' ? 'QUIET' : this.player.moveMode === 'run' ? 'RUN' : 'CROUCH-WALK';
    const statusText = `${stance} / ${mode}`;
    if (statusText !== this.lastStatusText) {
      this.lastStatusText = statusText;
      this.stanceEl.textContent = statusText;
    }

    // 分隊ロスター
    if (this.squad) {
      const roster = this.squad.getRoster();
      const lookText = this.squad.hudText();
      const key =
        this.squad.elementLabel +
        '|' +
        lookText +
        '|' +
        roster.map((r) => `${r.id}:${r.hp}:${r.down}:${r.selected}:${r.orderLabel}:${r.statusText}`).join(';');
      if (key !== this.lastRosterKey) {
        this.lastRosterKey = key;
        this.rosterElLabel.textContent = `[T] ${this.squad.elementLabel}`;
        this.rosterListEl.textContent = '';
        for (const r of roster) {
          const row = document.createElement('div');
          row.className = 'ally-row' + (r.selected ? ' selected' : '') + (r.down ? ' down' : '');
          const name = document.createElement('span');
          name.className = 'ally-name';
          name.textContent = `${r.callsign} ${r.name}`;
          const bar = document.createElement('div');
          bar.className = 'ally-hp';
          const fill = document.createElement('div');
          fill.className = 'ally-hp-fill';
          const pct = Math.max(0, Math.min(100, (r.hp / Math.max(1, r.maxHp)) * 100));
          fill.style.width = `${pct}%`;
          fill.style.background = pct > 55 ? '#5cd67d' : pct > 25 ? '#f2c14e' : '#ff5555';
          bar.appendChild(fill);
          const stat = document.createElement('span');
          stat.className = 'ally-stat';
          stat.textContent = `${r.orderLabel} · ${r.statusText}`;
          row.append(name, bar, stat);
          this.rosterListEl.appendChild(row);
        }
        if (lookText) {
          this.rosterLookEl.textContent = lookText;
          this.rosterLookEl.style.display = 'block';
        } else {
          this.rosterLookEl.style.display = 'none';
        }
      }
      this.rosterEl.style.display = roster.length > 0 ? 'block' : 'none';
    } else {
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
    this.leanL.style.visibility = lean < -LEAN_DISPLAY_THRESHOLD ? 'visible' : 'hidden';
    this.leanR.style.visibility = lean > LEAN_DISPLAY_THRESHOLD ? 'visible' : 'hidden';

    // ヒットマーカー
    this.hitTimer = Math.max(0, this.hitTimer - dt);
    this.hitEl.style.opacity = String(this.hitTimer / HIT_MARKER_SEC);

    // 被弾ビネット＆方向インジケーター
    if (this.dmgTimer > 0) {
      this.dmgTimer = Math.max(0, this.dmgTimer - dt);
      const a = this.dmgTimer / DAMAGE_FLASH_SEC;
      this.dmgVigEl.style.opacity = String(a);
      if (this.dmgFrom) {
        const dx = this.dmgFrom.x - this.player.position.x;
        const dz = this.dmgFrom.z - this.player.position.z;
        const worldAngle = Math.atan2(dx, dz);
        const rel = -(worldAngle + this.player.yawRad) + Math.PI;
        this.dmgDirEl.style.opacity = String(a);
        this.dmgDirEl.style.transform = `rotate(${rel}rad)`;
      }
    } else {
      this.dmgVigEl.style.opacity = '0';
      this.dmgDirEl.style.opacity = '0';
    }

    this.promptEl.style.display = this.input.isPointerLocked || !this.player.alive ? 'none' : 'block';

    // インタラクト対象プロンプト
    const target =
      this.input.isPointerLocked && !this.input.isOrderMenuOpen && this.player.alive
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
      this.squad && this.input.isPointerLocked && !this.input.isOrderMenuOpen && !this.input.suppressSquadShortcuts && this.player.alive
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
        missionHint = '隊長行動不能 — 作戦中止...';
        missionTone = 'red';
      } else if (st.phase === 'completing') {
        missionHint = `ALL CLEAR — 本部へ作戦完了を報告中... (${st.countdownSec.toFixed(1)}s)`;
        missionTone = 'green';
      } else if (st.phase === 'post_clear') {
        const parts: string[] = [];
        if (st.remainingCivilians > 0) parts.push(`民間人保護 ${st.remainingCivilians}`);
        if (st.remainingEvidence > 0) parts.push(`証拠回収 ${st.remainingEvidence}`);
        missionHint = `全脅威制圧完了 — 隊員が現場確保を実施中（残: ${parts.join(' / ')}） [Enter で完了報告]`;
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
      if (this.lastObjectivesKey !== 'hidden') {
        this.lastObjectivesKey = 'hidden';
        this.objPanelEl.style.display = 'none';
      }
      return;
    }

    let badge = '交戦・制圧中';
    let badgeBg = 'rgba(86,200,216,.16)';
    let badgeFg = '#8be4f2';
    let nowText = '';
    let nowColor = '#f2c14e';

    if (st.phase === 'failing') {
      badge = '作戦中止';
      badgeBg = 'rgba(255,90,90,.24)';
      badgeFg = '#ffb8b8';
      nowText = '✖ 隊長行動不能 — 作戦中止';
      nowColor = '#ff6b6b';
    } else if (st.phase === 'completing') {
      badge = '完了報告';
      badgeBg = 'rgba(92,214,125,.2)';
      badgeFg = '#b9ffd0';
      nowText = `✓ 全目標完了 — 本部へ報告中 (${st.countdownSec.toFixed(1)}s)`;
      nowColor = '#5cd67d';
    } else if (st.activeSuspects > 0) {
      badge = '交戦・制圧中';
      nowText = `▶ 武装容疑者を制圧せよ（残 ${st.activeSuspects}名）`;
      nowColor = '#f2c14e';
    } else if (st.surrenderedSuspects > 0) {
      badge = '要拘束あり';
      badgeBg = 'rgba(242,193,78,.22)';
      badgeFg = '#ffe08a';
      nowText = `▶ 投降した容疑者を拘束せよ [F長押し]（残 ${st.surrenderedSuspects}名）`;
      nowColor = '#f2c14e';
    } else if (st.remainingCivilians > 0) {
      badge = '現場確保中';
      badgeBg = 'rgba(86,200,216,.2)';
      badgeFg = '#a5f0ff';
      nowText = `▶ 人質・民間人を確保せよ [F長押し]（残 ${st.remainingCivilians}名）`;
      nowColor = '#56c8d8';
    } else if (st.remainingEvidence > 0) {
      badge = '現場確保中';
      badgeBg = 'rgba(86,200,216,.2)';
      badgeFg = '#a5f0ff';
      nowText = `▶ 証拠品（銃器）を押収せよ [F長押し]（残 ${st.remainingEvidence}点）`;
      nowColor = '#56c8d8';
    }

    const subHint = st.phase === 'post_clear' ? '[Enter / Backspace] 現時点で完了報告して終了' : '';
    const key = [
      st.phase,
      st.neutralizedSuspects,
      st.totalSuspects,
      st.surrenderedSuspects,
      st.activeSuspects,
      st.securedCivilians,
      st.totalCivilians,
      st.deadCivilians,
      st.collectedEvidence,
      st.totalEvidence,
      st.droppedEvidence,
      st.phase === 'completing' ? st.countdownSec.toFixed(1) : '',
      subHint,
    ].join('|');

    if (key === this.lastObjectivesKey) return;
    this.lastObjectivesKey = key;

    this.objPanelEl.style.display = 'block';
    this.objBadgeEl.textContent = badge;
    this.objBadgeEl.style.background = badgeBg;
    this.objBadgeEl.style.color = badgeFg;
    this.objNowEl.textContent = nowText;
    this.objNowEl.style.borderLeftColor = nowColor;

    this.objListEl.textContent = '';
    const addRow = (label: string, valText: string, done: boolean, tagText?: string, tagRed = false) => {
      const row = document.createElement('div');
      row.className = 'obj-row' + (done ? ' done' : '');
      const left = document.createElement('span');
      left.className = 'obj-lbl';
      const mark = document.createElement('span');
      mark.className = 'obj-mark';
      mark.textContent = done ? '✓' : '□';
      const name = document.createElement('span');
      name.textContent = label;
      left.append(mark, name);

      const right = document.createElement('span');
      right.className = 'obj-val';
      right.textContent = valText;
      if (tagText) {
        const tag = document.createElement('span');
        tag.className = 'obj-tag' + (tagRed ? ' red' : '');
        tag.textContent = tagText;
        right.appendChild(tag);
      }
      row.append(left, right);
      this.objListEl.appendChild(row);
    };

    const suspectsDone = st.allSuspectsNeutralized;
    addRow(
      '容疑者制圧',
      `${st.neutralizedSuspects} / ${st.totalSuspects}`,
      suspectsDone,
      st.surrenderedSuspects > 0 ? `要拘束 ${st.surrenderedSuspects}` : undefined,
    );

    if (st.totalCivilians > 0 || st.deadCivilians > 0) {
      addRow(
        '人質確保',
        `${st.securedCivilians} / ${st.totalCivilians}`,
        st.remainingCivilians === 0,
        st.deadCivilians > 0 ? `犠牲 ${st.deadCivilians}` : undefined,
        true,
      );
    }

    const evDone = st.activeSuspects === 0 && st.droppedEvidence === 0 && st.totalEvidence > 0;
    addRow(
      '証拠品押収',
      `${st.collectedEvidence} / ${st.totalEvidence}`,
      evDone,
      st.droppedEvidence > 0 ? `未回収 ${st.droppedEvidence}` : undefined,
    );

    if (subHint) {
      this.objSubHintEl.textContent = subHint;
      this.objSubHintEl.style.display = 'block';
    } else {
      this.objSubHintEl.style.display = 'none';
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const r of this.radioEntries) r.el.remove();
    this.radioEntries.length = 0;
    this.root.remove();
    this.styleEl.remove();
  }
}
