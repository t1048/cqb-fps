import { t } from '../core/i18n';
import type { InputManager } from '../core/InputManager';
import type { MedkitConfig } from '../core/types';
import type { Subtitle } from '../ui/Subtitle';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { PlayerController } from './PlayerController';

/** 使用中に押すと取り消しになる操作（持ち替え・投擲・interact・breach・オプティワンド） */
const CANCEL_ACTIONS = ['slot1', 'slot2', 'slot3', 'slot4', 'interact', 'breach'] as const;

export interface MedkitDeps {
  player: PlayerController;
  input: InputManager;
  weapons: WeaponSystem;
  cfg: MedkitConfig;
  /** 人質を拘束中か（両手がふさがる） */
  isHoldingHostage: () => boolean;
  /** 投擲物を構えているか（構えたままだと左クリックが投擲になるため） */
  isThrowableEquipped: () => boolean;
  showGauge: (label: string, ratio: number) => void;
  subtitle: Subtitle;
}

/**
 * 救急キット（容疑者モードだけ）。H を押し続けて holdSec 秒で HP を回復する。
 * 使用中は射撃不可（weapons.healBlock）・走れない（player.moveModeCap）。被弾しても止まらない。
 * 毎フレーム、player.update / weapons.update より前に update(dt) を呼ぶこと。
 */
export class MedkitUse {
  private kits = 0;
  private progressSec = 0;
  /** 1 個使い終えた／取り消した後、キーを離すまで始まらない */
  private needRelease = false;

  constructor(private readonly d: MedkitDeps) {}

  add(n: number): void {
    this.kits += n;
  }

  get count(): number {
    return this.kits;
  }

  get using(): boolean {
    return this.progressSec > 0;
  }

  update(dt: number): void {
    const d = this.d;
    const down = d.input.isDown('useMedkit');
    if (!down) {
      this.needRelease = false;
      this.cancel();
      return;
    }

    // 使用中の持ち替え・投擲・interact・breach・オプティワンドは取り消し（キーを離すまで再開しない）
    if (this.using && (CANCEL_ACTIONS.some((a) => d.input.wasPressed(a)) || d.input.wasMousePressed(1))) {
      this.cancel();
      this.needRelease = true;
      return;
    }

    const alive = d.player.alive;
    const hurt = d.player.hp < d.player.maxHp;
    const canStart =
      !this.needRelease &&
      this.kits > 0 &&
      alive &&
      hurt &&
      !d.weapons.isReloading &&
      !d.isHoldingHostage() &&
      !d.isThrowableEquipped();
    if (!canStart) {
      this.cancel();
      // 押した瞬間だけ理由を伝える（押し直すまで出さない）
      if (alive && !this.needRelease && d.input.wasPressed('useMedkit')) {
        if (this.kits <= 0) d.subtitle.show(t('救急キットを持っていない', 'No medkit'), 1.4);
        else if (!hurt) d.subtitle.show(t('怪我はしていない', 'Not injured'), 1.4);
      }
      return;
    }

    this.progressSec += dt;
    if (this.progressSec >= d.cfg.holdSec) {
      const before = d.player.hp;
      d.player.heal(d.cfg.heal);
      const gained = Math.round(d.player.hp - before);
      this.kits -= 1;
      this.cancel();
      this.needRelease = true;
      d.subtitle.show(t(`HP +${gained}`, `HP +${gained}`), 1.4);
      return;
    }
    d.weapons.healBlock = true;
    d.player.moveModeCap = 'quiet';
    d.showGauge(t('救急処置中...', 'Applying medkit...'), this.progressSec / d.cfg.holdSec);
  }

  /** 進行を捨てて、射撃禁止と移動の上限を解く（消費なし・回復なし） */
  private cancel(): void {
    if (this.progressSec === 0 && !this.d.weapons.healBlock && this.d.player.moveModeCap === null) return;
    this.progressSec = 0;
    this.d.weapons.healBlock = false;
    this.d.player.moveModeCap = null;
  }
}
