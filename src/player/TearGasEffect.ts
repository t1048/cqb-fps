import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import { t } from '../core/i18n';
import type { Vec3 } from '../core/types';
import type { Subtitle } from '../ui/Subtitle';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { PlayerController } from './PlayerController';

const BUILD_PER_SEC = 55;
const DECAY_PER_SEC = 18;
const MAX_SPREAD_PENALTY = 7.5;
const MAX_SLOWDOWN = 0.42;
const COUGH_THRESHOLD = 0.3;
const COUGH_NOISE_RADIUS = 16;

export interface GasSampler {
  exposureAt(pos: Vec3): number;
}

/**
 * 容疑者モード: CS 催涙ガスによる行動阻害エフェクト。
 * - 独自の DOM オーバーレイ（黄緑ティント + backdrop-filter: blur）を使用し、
 *   PepperEffect が管理する canvas.style.filter を一切上書きしない。
 * - WeaponSystem.update() の後に更新し、extraSpread は +=、speedMultiplier は *= で合成する。
 * - 一定濃度以上で周期的に咳き込み、playerCough + noise(kind:'voice', source:'player') を発する。
 */
export class TearGasEffect {
  private level = 0;
  private readonly el = document.createElement('div');
  private readonly eye = new THREE.Vector3();
  private coughCd = 0;
  private shown = -1;
  private warned = false;
  private disposed = false;

  constructor(
    private readonly player: Pick<PlayerController, 'alive' | 'position' | 'speedMultiplier' | 'addViewKick' | 'getEyePosition'>,
    private readonly weapons: Pick<WeaponSystem, 'extraSpread'>,
    private readonly gas: GasSampler,
    private readonly subtitle: Pick<Subtitle, 'show'>,
    private readonly bus: GameEventBus,
  ) {
    this.el.style.cssText =
      'position:fixed;inset:0;z-index:4;pointer-events:none;opacity:0;' +
      'background:radial-gradient(ellipse at center, rgba(175,195,70,.16) 0%, rgba(130,155,45,.45) 55%, rgba(75,95,25,.82) 100%)';
    document.body.appendChild(this.el);
  }

  get amount(): number {
    return this.level;
  }

  get overlayElement(): HTMLDivElement {
    return this.el;
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, 0.05);
    if (!this.player.alive) {
      this.level = 0;
      this.warned = false;
      this.coughCd = 0;
      this.syncOverlay(0);
      return;
    }

    this.player.getEyePosition(this.eye);
    const density = this.gas.exposureAt({ x: this.eye.x, y: this.eye.y, z: this.eye.z });
    if (density > 0) {
      if (!this.warned && this.level < 8) {
        this.warned = true;
        this.subtitle.show(t('催涙ガスだ！ この部屋から離れろ！', 'Tear gas! Get out of this room!'), 1.8);
      }
      this.level = Math.min(100, this.level + BUILD_PER_SEC * density * dt);
    } else {
      this.level = Math.max(0, this.level - DECAY_PER_SEC * dt);
      if (this.level <= 0) this.warned = false;
    }

    const k = this.level / 100;
    if (k > 0) {
      this.weapons.extraSpread += k * MAX_SPREAD_PENALTY;
      this.player.speedMultiplier *= 1 - MAX_SLOWDOWN * k;
      this.player.addViewKick(
        (Math.random() - 0.5) * 0.008 * k,
        (Math.random() - 0.5) * 0.012 * k,
      );
      this.coughCd -= dt;
      if (k > COUGH_THRESHOLD && this.coughCd <= 0) {
        this.coughCd = 2.6 + Math.random() * 1.4;
        const p = this.player.position;
        const pos: Vec3 = { x: p.x, y: p.y + 1.2, z: p.z };
        this.bus.emit('playerCough', { pos });
        this.bus.emit('noise', { pos, radius: COUGH_NOISE_RADIUS, kind: 'voice', source: 'player' });
        this.subtitle.show(t('ゲホッ、ゴホッ…！ 催涙ガスで息ができない！', "*Cough, hack*...! Can't breathe in this gas!"), 1.2);
        this.player.addViewKick(0.022 * k, (Math.random() - 0.5) * 0.035);
      }
    }

    this.syncOverlay(k);
  }

  private syncOverlay(k: number): void {
    const step = Math.round(k * 40);
    if (step === this.shown) return;
    this.shown = step;
    this.el.style.opacity = String(Math.min(0.88, k * 1.05));
    const blur = step > 0 ? `blur(${(k * 4.5).toFixed(1)}px)` : '';
    this.el.style.backdropFilter = blur;
    (this.el.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = blur;
  }

  clear(): void {
    this.level = 0;
    this.coughCd = 0;
    this.warned = false;
    this.syncOverlay(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.el.remove();
  }
}
