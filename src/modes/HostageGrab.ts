import * as THREE from 'three';
import type { Civilian } from '../ai/Civilian';
import { blockedAtFiltered } from '../ai/SquadRoute';
import type { EntityManager } from '../ai/EntityManager';
import { CivilianState } from '../core/events';
import type { GameEventBus } from '../core/events';
import { onLocaleChange, t } from '../core/i18n';
import type { Interaction } from '../player/Interaction';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { PlayerController } from '../player/PlayerController';
import type { Subtitle } from '../ui/Subtitle';
import type { Collider } from '../world/WorldBuilder';

/** 拘束できる距離（m）。少し離れていても掴めるよう広めに取る */
const GRAB_RANGE = 2.3;
const GRAB_CONE_COS = Math.cos((70 / 2) * (Math.PI / 180));
/** F 長押しで拘束が完了するまでの秒数（短くして咄嗟に盾にできる） */
const GRAB_HOLD_SEC = 0.4;
/** 人質を抱えている間の移動速度倍率（平常時の中心値。実際は抵抗で不規則に揺らぐ） */
const CARRY_SPEED = 0.85;
/** 抵抗（0〜100）が 100 に達すると人質が振りほどいて逃げる。増え方は緩やかで、盾として長く使える */
const RESIST_PER_SEC = 1.2;
const RESIST_MOVING_PER_SEC = 0.6;
const RESIST_PER_SHOT = 1.5;
const RESIST_PER_PEPPER = 7;
/** 拘束していない民間人の抵抗が毎秒これだけ落ち着く（離せば回復する） */
const RESIST_DECAY_PER_SEC = 4;
/** 振りほどかれた人質を再び掴めるまでの秒数（短めで、すぐ掴み直せる） */
const REGRAB_COOLDOWN = 4;
/**
 * 立ち位置はカメラ基準（リーンで目線が横に動いても画面中央に戻さない）。
 * 頭は目線の高さ（約 1.56m）にあり半幅約 0.11m、肩の張りは約 0.30m。
 * 横偏移をそれより大きく取り、照準の先（画面中央）が体を通らないようにする。
 * 拘束中の人質は武器の標的から外しているので、自分の弾は当たらない。
 */
const HOLD_FORWARD = 0.78;
const HOLD_SIDE = 0.5;
const HOLD_RADIUS = 0.2;
/** 四周が塞がっていても使う。頭の内側が照準から約 24° 外れ、画面中央は開いたまま */
const HOLD_FALLBACK: readonly [forward: number, side: number] = [0.55, 0.36];
/** 優先順。左が壁なら右。いずれも横偏移は頭の半幅より大きい */
const HOLD_SPOTS: readonly (readonly [forward: number, side: number])[] = [
  [HOLD_FORWARD, HOLD_SIDE],
  [0.62, 0.42],
  HOLD_FALLBACK,
  [HOLD_FORWARD, -HOLD_SIDE],
  [0.62, -0.42],
  [0.55, -0.36],
];

const STRUGGLE_LINES: readonly [ja: string, en: string][] = [
  ['人質「離して！」', 'Hostage: "Let me go!"'],
  ['人質「痛い、やめて！」', 'Hostage: "Ow, stop it!"'],
  ['人質が身をよじって暴れている', 'The hostage is thrashing and struggling!'],
  ['人質「助けてくれ！」', 'Hostage: "Somebody help me!"'],
];
const pickLine = (): string => {
  const [ja, en] = STRUGGLE_LINES[Math.floor(Math.random() * STRUGGLE_LINES.length)]!;
  return t(ja, en);
};

/**
 * 容疑者モード: 民間人を人質として拘束し連れ回す（人間の盾）。
 * 抵抗は離している間に下がる（掴み直しやすい）。
 * 人質は抵抗する: 足取りが不規則に鈍り、不定期に暴れて（視点ブレ・盾が外れる）、抵抗が満タンになると振りほどいて逃げる。
 * F 長押しで拘束、拘束中に F で解放。拘束中は移動が遅くなり、人質はカメラの前方左（左が壁なら右）に立たされる。
 * SWAT は射線上に民間人がいると発砲しないため、正面からの撃ち合いを避けられる（側面・背後は無防備）。
 */
export class HostageGrab {
  private held: Civilian | null = null;
  /** 民間人ごとの抵抗値（一度掴まれた人は離しても覚えている） */
  private readonly resist = new Map<string, number>();
  private readonly cooldown = new Map<string, number>();
  private struggleLeft = 0;
  private nextStruggle = 2;
  private phase = Math.random() * 10;
  private readonly el = document.createElement('div');
  private readonly labelEl = document.createElement('div');
  private readonly fill = document.createElement('div');
  private shownResist = -1;
  private readonly unsubShot: () => void;
  private readonly unsubLocale: () => void;
  private readonly eye = new THREE.Vector3();
  private readonly unreg: () => void;

  constructor(
    private readonly player: PlayerController,
    private readonly entities: EntityManager,
    private readonly colliders: readonly Collider[],
    private readonly subtitle: Subtitle,
    private readonly weapons: WeaponSystem,
    interaction: Interaction,
    private readonly onProgress: (label: string, ratio: number) => void,
    /** ドアを狙っている間は F をドア操作に譲る */
    private readonly aimingDoor: () => boolean,
    bus: GameEventBus,
  ) {
    this.el.style.cssText =
      'position:fixed;left:50%;bottom:118px;transform:translateX(-50%);z-index:6;pointer-events:none;width:180px;' +
      'padding:3px 8px;background:rgba(0,0,0,.55);border:1px solid rgba(255,150,120,.6);border-radius:4px;color:#ffd9cc;' +
      'font:bold 11px sans-serif;text-align:center;display:none';
    const track = document.createElement('div');
    track.style.cssText = 'height:5px;margin-top:3px;background:rgba(255,255,255,.18)';
    this.fill.style.cssText = 'height:100%;width:0;background:#ff7b5a';
    track.appendChild(this.fill);
    this.labelEl.textContent = t('人質の抵抗', 'Hostage Resistance');
    this.el.append(this.labelEl, track);
    document.body.appendChild(this.el);
    this.unsubLocale = onLocaleChange(() => {
      this.labelEl.textContent = t('人質の抵抗', 'Hostage Resistance');
    });
    this.unsubShot = bus.on('shotFired', (e) => {
      if (e.shooter === 'player' && this.held) this.addResist(this.held, RESIST_PER_SHOT);
    });
    this.unreg = interaction.register<Civilian>({
      id: 'hostageGrab',
      // ドア操作より優先（人質を抱えている間の F は解放に使う）
      priority: 300,
      resolve: () => (this.held ? (this.aimingDoor() ? null : this.held) : this.findTarget()),
      label: (c) =>
        c === this.held
          ? t('F: 人質を解放', 'F: Release Hostage')
          : t('F 長押し: 人質を拘束して連れ回す', 'Hold F: Take Hostage as Shield'),
      onPress: (c) => {
        if (c === this.held) this.release(t('人質を解放した', 'Hostage released'));
      },
      onHold: (c, _dt, sec) => {
        if (this.held || c === this.held) return;
        this.onProgress(t('人質を拘束中...', 'Grabbing hostage...'), sec / GRAB_HOLD_SEC);
        if (sec >= GRAB_HOLD_SEC) this.grab(c);
      },
    });
  }

  get holding(): Civilian | null {
    return this.held;
  }

  /** 盾が有効か（人質が暴れている最中は SWAT の正面でも盾にならないが、抵抗が 40 未満の軽いもがきなら盾は保たれる） */
  get shieldEffective(): boolean {
    return this.held !== null && (this.struggleLeft <= 0 || (this.resist.get(this.held.id) ?? 0) < 40);
  }

  /** SWAT のペッパーボールが人質に当たった */
  onHostagePeppered(): void {
    if (!this.held) return;
    this.addResist(this.held, RESIST_PER_PEPPER);
    this.struggleLeft = Math.max(this.struggleLeft, 0.6);
    this.subtitle.show(
      t('人質「目が、目がぁっ！」— ペッパーボールで人質が暴れ出した', 'Hostage: "My eyes, my eyes!" — Hostage panics from pepperball'),
      1.4,
    );
  }

  private addResist(c: Civilian, v: number): void {
    this.resist.set(c.id, Math.min(100, (this.resist.get(c.id) ?? 0) + v));
  }

  private findTarget(): Civilian | null {
    if (!this.player.alive) return null;
    const eye = this.player.getEyePosition(this.eye);
    const yaw = this.player.yawRad;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let best: Civilian | null = null;
    let bestD = GRAB_RANGE;
    for (const c of this.entities.civilians.values()) {
      if (!c.canBeShielded || c.evacuated || c.state === CivilianState.SECURED) continue;
      if ((this.cooldown.get(c.id) ?? 0) > 0) continue;
      if (Math.abs(c.body.footY - this.player.position.y) > 0.8) continue;
      const dx = c.body.px - eye.x;
      const dz = c.body.pz - eye.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      if (d > 0.3 && (dx * fx + dz * fz) / d < GRAB_CONE_COS) continue;
      best = c;
      bestD = d;
    }
    return best;
  }

  private grab(c: Civilian): void {
    c.beginShield('player');
    if (c.shieldedBy !== 'player') return;
    this.held = c;
    this.struggleLeft = 0;
    this.nextStruggle = 1.5 + Math.random() * 2;
    this.weapons.removeTarget(c);
    this.subtitle.show(
      t('容疑者「動くな！来い！」— 人質を拘束した', 'Suspect: "Don\'t move! Come here!" — Hostage taken'),
      1.8,
    );
  }

  release(msg?: string): void {
    const c = this.held;
    if (!c) return;
    this.held = null;
    c.endShield();
    if (c.alive) this.weapons.addTarget(c);
    if (msg) this.subtitle.show(msg, 1.4);
  }

  /** WeaponSystem.update の後に呼ぶ（speedMultiplier を上書きするため）。 */
  update(rawDt: number): void {
    const dt = Math.min(rawDt, 0.05);
    for (const [id, t] of this.cooldown) {
      if (t - dt <= 0) this.cooldown.delete(id);
      else this.cooldown.set(id, t - dt);
    }
    // 拘束していない民間人の抵抗は時間とともに下がる
    for (const [id, v] of this.resist) {
      if (this.held?.id === id) continue;
      if (v - RESIST_DECAY_PER_SEC * dt <= 0) this.resist.delete(id);
      else this.resist.set(id, v - RESIST_DECAY_PER_SEC * dt);
    }
    const c = this.held;
    this.renderResist(c ? (this.resist.get(c.id) ?? 0) : -1);
    if (!c) return;
    if (!c.alive || !this.player.alive) {
      this.held = null;
      if (!c.alive) this.subtitle.show(t('人質が死亡した', 'Hostage died'), 1.6);
      else {
        c.endShield();
        this.weapons.addTarget(c);
      }
      return;
    }
    // ---- 抵抗: 抱えている時間・動き回る・発砲・ペッパーで増え、満タンで振りほどかれる
    this.addResist(c, (RESIST_PER_SEC + (this.player.isMoving ? RESIST_MOVING_PER_SEC : 0)) * dt);
    const r = this.resist.get(c.id) ?? 0;
    if (r >= 100) {
      this.breakAway(c);
      return;
    }
    // 不規則な足取り: 2 つの周期の違う揺らぎ + 抵抗で全体が鈍る
    this.phase += dt;
    const wobble = 0.5 * Math.sin(this.phase * 2.3) + 0.5 * Math.sin(this.phase * 0.77 + 1.3);
    let speed = CARRY_SPEED + 0.16 * wobble - r * 0.0015;
    // もがき（暴れる）: 不定期に発生。発生中はほとんど進めず視点がぶれ、盾が外れる
    this.nextStruggle -= dt;
    if (this.struggleLeft <= 0 && this.nextStruggle <= 0) {
      this.struggleLeft = 0.25 + Math.random() * (0.25 + r * 0.004);
      this.nextStruggle = (2.5 + Math.random() * 4) * (1 - r / 200);
      if (Math.random() < 0.35) this.subtitle.show(pickLine(), 1.0);
    }
    if (this.struggleLeft > 0) {
      this.struggleLeft -= dt;
      speed = 0.35;
      const k = 0.5 + r / 200;
      this.player.addViewKick((Math.random() - 0.5) * 0.012 * k, (Math.random() - 0.5) * 0.03 * k);
    }
    this.player.speedMultiplier *= Math.max(0.15, speed);
    const feetY = this.player.position.y;
    this.player.getEyePosition(this.eye);
    const yaw = this.player.yawRad;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // 左 = 前方を反時計回りに 90°（画面左）。正の side が左
    const lx = fz;
    const lz = -fx;
    let x = 0;
    let z = 0;
    let placed = false;
    const jerk = this.struggleLeft > 0 ? 0.35 + 0.15 * Math.sin(this.phase * 31) : 0;
    for (const [f, s0] of HOLD_SPOTS) {
      const s = s0 + Math.sign(s0) * jerk;
      x = this.eye.x + fx * f + lx * s;
      z = this.eye.z + fz * f + lz * s;
      if (!blockedAtFiltered(this.colliders, x, z, HOLD_RADIUS, feetY)) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      const [f, s] = HOLD_FALLBACK;
      x = this.eye.x + fx * f + lx * s;
      z = this.eye.z + fz * f + lz * s;
    }
    c.body.setPosition(x, z, feetY);
    c.body.faceToward(c.body.px + fx, c.body.pz + fz);
  }

  private breakAway(c: Civilian): void {
    this.held = null;
    this.struggleLeft = 0;
    const p = this.player.position;
    c.breakFree(p.x, p.z);
    if (c.alive) this.weapons.addTarget(c);
    this.resist.set(c.id, 35);
    this.cooldown.set(c.id, REGRAB_COOLDOWN);
    this.player.addViewKick(0.03, (Math.random() - 0.5) * 0.08);
    this.subtitle.show(t('人質が拘束を振りほどいて逃げた！', 'The hostage broke free and escaped!'), 1.8);
  }

  private renderResist(r: number): void {
    const v = r < 0 ? -1 : Math.round(r);
    if (v === this.shownResist) return;
    if (v < 0) this.el.style.display = 'none';
    else {
      if (this.shownResist < 0) this.el.style.display = 'block';
      this.fill.style.width = `${v}%`;
    }
    this.shownResist = v;
  }

  dispose(): void {
    this.release();
    this.unreg();
    this.unsubShot();
    this.unsubLocale();
    this.el.remove();
  }
}
