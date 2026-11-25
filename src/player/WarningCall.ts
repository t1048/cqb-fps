import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import { t } from '../core/i18n';
import type { InputManager } from '../core/InputManager';
import type { WarningConfig } from '../core/types';
import type { Subtitle } from '../ui/Subtitle';
import type { PlayerController } from './PlayerController';

const MAX_DT = 0.05;

/**
 * 警告コール。Space キー（warningCall アクション）専用で独立発動する。
 * warningCall（視線方向付き）・noise(voice)・字幕を発行。
 */
export class WarningCall {
  private cooldown = 0;
  private readonly eye = new THREE.Vector3();
  private disposed = false;

  constructor(
    private readonly cfg: WarningConfig,
    private readonly player: PlayerController,
    private readonly bus: GameEventBus,
    private readonly subtitle: Subtitle,
    private readonly input: InputManager,
  ) {}

  private call(): void {
    if (this.disposed || this.cooldown > 0) return;
    this.cooldown = this.cfg.cooldown;
    const p = this.player;
    p.getEyePosition(this.eye);
    // 水平な視線方向（警告の有効範囲は水平コーン判定）
    const dx = -Math.sin(p.yawRad);
    const dz = -Math.cos(p.yawRad);
    const pos = { x: this.eye.x, y: this.eye.y, z: this.eye.z };
    this.bus.emit('warningCall', { pos, dir: { x: dx, y: 0, z: dz } });
    this.bus.emit('noise', { pos, radius: this.cfg.noiseRadius, kind: 'voice' });
    this.subtitle.show(t(this.cfg.text, 'Police! Drop your weapon!'), this.cfg.subtitleSec);
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    this.cooldown = Math.max(0, this.cooldown - Math.min(rawDt, MAX_DT));
    if (
      this.input.isPointerLocked &&
      this.player.alive &&
      !this.input.isOrderMenuOpen &&
      !this.input.suppressSquadShortcuts &&
      this.input.wasPressed('warningCall')
    ) {
      this.call();
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
