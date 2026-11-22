import * as THREE from 'three';
import { CivilianState, type GameEventBus } from './events';
import type { Vec3 } from './types';
import type { AudioEngine } from './Audio';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Collider } from '../world/WorldBuilder';

export type AudioBridgeSink = Pick<
  AudioEngine,
  | 'playFootstep'
  | 'playDoorCreak'
  | 'playBreach'
  | 'playGunshot'
  | 'playFlashbang'
  | 'playWarningCall'
  | 'playRadioReport'
  | 'playAllyRadio'
  | 'triggerEarRinging'
  | 'updateListener'
>;

export interface EyePositionProvider {
  getEyePosition(out?: THREE.Vector3): THREE.Vector3;
}

const FLASH_TARGET_Y_OFFSET = 0.1;
const MIN_EAR_RINGING_SEC = 0.5;
const EAR_RINGING_FALLOFF = 0.75;
const RADIO_REPORT_COOLDOWN_SEC = 3.0;

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * EventBus-to-AudioEngine bridge:
 * - Routes `noise` events (`footstep`, `door`, `breach`, `gunshot`, `flash`) to spatial SEs.
 * - Routes `warningCall` to `playWarningCall` (ignoring `noise{kind:'voice'}` to prevent double-triggering).
 * - Routes `flashDetonated` to `triggerEarRinging` using player eye distance + line-of-sight check.
 * - Syncs Three.js camera pose to Web Audio listener without per-frame allocations.
 */
export class AudioBridge {
  private readonly unsubs: Array<() => void> = [];
  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly flashTarget: Vec3 = { x: 0, y: 0, z: 0 };
  private lastRadioReportSec = -Infinity;
  private disposed = false;

  constructor(
    bus: GameEventBus,
    private readonly audio: AudioBridgeSink,
    private readonly player: EyePositionProvider,
    private readonly colliders: readonly Collider[],
    private readonly radioReportChance = 0.38,
  ) {
    this.unsubs.push(
      bus.on('noise', ({ pos, radius, kind }) => {
        if (this.disposed) return;
        switch (kind) {
          case 'footstep':
            this.audio.playFootstep(pos, radius);
            break;
          case 'door':
            this.audio.playDoorCreak(pos, radius);
            break;
          case 'breach':
            this.audio.playBreach(pos, radius);
            break;
          case 'gunshot':
            this.audio.playGunshot(pos, radius);
            break;
          case 'flash':
            this.audio.playFlashbang(pos, radius);
            break;
          case 'voice':
            // Handled via `warningCall` subscription to avoid double-triggering.
            break;
        }
      }),
    );

    this.unsubs.push(
      bus.on('warningCall', ({ pos }) => {
        if (this.disposed) return;
        this.audio.playWarningCall(pos);
      }),
    );

    this.unsubs.push(
      bus.on('flashDetonated', ({ pos, radius, blindSec }) => {
        if (this.disposed) return;
        if (!Number.isFinite(radius) || radius <= 0) return;
        if (!Number.isFinite(blindSec) || blindSec <= 0) return;
        if (!isFiniteVec3(pos)) return;

        this.player.getEyePosition(this.eye);
        if (!isFiniteVec3(this.eye)) return;

        const d = Math.hypot(
          pos.x - this.eye.x,
          pos.y - this.eye.y,
          pos.z - this.eye.z,
        );
        if (!Number.isFinite(d) || d > radius) return;

        this.flashTarget.x = pos.x;
        this.flashTarget.y = pos.y + FLASH_TARGET_Y_OFFSET;
        this.flashTarget.z = pos.z;

        if (!hasLineOfSight(this.colliders, this.eye, this.flashTarget)) return;

        const intensity = Math.max(0, Math.min(1, 1 - EAR_RINGING_FALLOFF * (d / radius)));
        if (intensity <= 0) return;
        const durationSec = Math.max(MIN_EAR_RINGING_SEC, blindSec * intensity);
        this.audio.triggerEarRinging(intensity, durationSec);
      }),
    );

    const maybeReportCapture = (kind: 'suspect' | 'civilian'): void => {
      if (this.disposed) return;
      const nowSec = typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000;
      if (nowSec - this.lastRadioReportSec < RADIO_REPORT_COOLDOWN_SEC) return;
      if (Math.random() >= this.radioReportChance) return;
      this.lastRadioReportSec = nowSec;
      this.audio.playRadioReport(kind);
    };

    this.unsubs.push(
      bus.on('arrest', () => maybeReportCapture('suspect')),
      bus.on('civilianStateChanged', ({ to }) => {
        if (to === CivilianState.SECURED) maybeReportCapture('civilian');
      }),
      bus.on('allyRadio', ({ allyId, text, voiceText }) => {
        if (this.disposed) return;
        this.audio.playAllyRadio(allyId, voiceText ?? text);
      }),
    );
  }

  /** Updates the 3D AudioListener pose from a Three.js camera using scratch vectors. */
  updateListener(camera: THREE.Camera): void {
    if (this.disposed) return;
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.audio.updateListener(camera.position, this.forward, this.up);
  }

  /** Idempotently unsubscribes all EventBus listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs.length = 0;
  }
}
