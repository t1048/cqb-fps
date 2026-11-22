import * as THREE from 'three';
import type { InputManager } from '../core/InputManager';
import type { GameEventBus, NegotiationResult } from '../core/events';
import type { NegotiationConfig } from '../core/types';
import type { EntityManager } from '../ai/EntityManager';
import { judgeContact, NegotiationSession, type ContactInfo } from '../ai/Negotiation';
import type { Subtitle } from '../ui/Subtitle';
import type { NegotiationUI } from '../ui/NegotiationUI';
import type { Collider } from '../world/WorldBuilder';
import type { Flashbang } from '../weapons/Flashbang';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { Interaction } from './Interaction';
import type { PlayerController } from './PlayerController';

const MAX_DT = 0.05;
const NEGOTIATE_PRIORITY = 400; // 逮捕300 > ドア200 より上（無線装備中のみ有効。警告コールは Space キー独立）

/**
 * 交渉無線（キー `3` でトグル、1/2/4 で解除）。装備中は射撃を抑止し、
 * ドア/遮蔽物越し or 人質盾の容疑者へ向いて F で交渉を開始する（Interaction provider 'negotiate'）。
 * 交渉中は NegotiationSession を進行し、無線解除・距離超過・切断キーで中断する。
 */
export class NegotiationRadio {
  private equipped = false;
  private session: NegotiationSession | null = null;
  private candidate: ContactInfo | null = null;
  private readonly unregister: () => void;
  private readonly eye = new THREE.Vector3();
  private disposed = false;

  constructor(
    private readonly cfg: NegotiationConfig,
    private readonly player: PlayerController,
    private readonly input: InputManager,
    private readonly colliders: readonly Collider[],
    private readonly entities: EntityManager,
    private readonly bus: GameEventBus,
    private readonly subtitle: Subtitle,
    private readonly ui: NegotiationUI,
    private readonly weapons: WeaponSystem,
    private readonly flashbang: Flashbang,
    interaction: Interaction,
  ) {
    this.unregister = interaction.register<ContactInfo>({
      id: 'negotiate',
      priority: NEGOTIATE_PRIORITY,
      resolve: () => (this.equipped && !this.session ? this.candidate : null),
      label: (t) => (t.kind === 'shield' ? this.cfg.text.hintShield : this.cfg.text.hintReady),
      onPress: (t) => this.start(t),
    });
    ui.onChoose = (id) => this.choose(id);
    ui.onCancel = () => this.cancel();
  }

  get isEquipped(): boolean {
    return this.equipped;
  }

  get negotiating(): boolean {
    return this.session !== null;
  }

  /** flashbang.update の後・weapons.update の前に呼ぶ（射撃抑止の整合のため）。 */
  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    if (!this.input.isOrderMenuOpen) {
      if (this.input.wasPressed('slot3')) this.equipped = !this.equipped;
      else if (this.input.wasPressed('slot1') || this.input.wasPressed('slot2') || this.input.wasPressed('slot4')) {
        this.equipped = false;
      }
    }
    this.weapons.suppressFire = this.equipped || this.flashbang.equipped;
    this.input.suppressSquadShortcuts = this.session !== null;

    this.player.getEyePosition(this.eye);
    if (this.session) this.updateSession(dt);
    this.candidate = null;
    if (this.equipped && !this.session) {
      let best: ContactInfo | null = null;
      for (const s of this.entities.suspects.values()) {
        const c = judgeContact(this.cfg, this.colliders, this.eye, this.player.yawRad, s);
        if (c && (!best || c.dist < best.dist)) best = c;
      }
      this.candidate = best;
    }
    const hint = !this.equipped || this.session || this.candidate !== null ? '' : this.cfg.text.hintIdle;
    this.ui.setHint(hint);
  }

  private start(c: ContactInfo): void {
    if (this.session) return;
    const p = this.player.position;
    if (!c.suspect.beginNegotiation({ x: p.x, y: p.y, z: p.z }, this.cfg.allowedStates)) {
      this.subtitle.show(this.cfg.text.locked, 1.5);
      return;
    }
    this.session = new NegotiationSession(this.cfg, c.suspect, this.bus);
    this.ui.open(c.kind === 'shield' ? '交渉（人質あり）' : c.kind === 'door' ? '交渉（ドア越し）' : '交渉（遮蔽物越し）');
    this.ui.update(this.session.view());
  }

  private choose(id: string): void {
    const s = this.session;
    if (!s || s.result) return;
    const choice = this.cfg.choices.find((c) => c.id === id);
    if (!choice) return;
    const out = s.choose(id);
    if (!out) return;
    this.subtitle.show(choice.playerLine, 2);
    this.ui.pushLine(`あなた: ${choice.playerLine}`);
    for (const l of out.lines) this.ui.pushLine(`容疑者: ${l}`);
    if (out.ended) this.conclude(s, out.ended);
    else this.ui.update(s.view());
  }

  private cancel(): void {
    const s = this.session;
    if (!s || s.result) return;
    s.abort();
    this.conclude(s, 'abort');
  }

  private updateSession(dt: number): void {
    const s = this.session;
    if (!s) return;
    if (s.result) return; // 結果表示待ち（session は conclude で解放済みのはず）
    const sus = s.suspect;
    const p = this.player.position;
    sus.updateNegotiationTarget({ x: p.x, y: p.y, z: p.z });
    const d = Math.hypot(sus.body.px - p.x, sus.body.pz - p.z);
    if (!this.equipped || d > this.cfg.range * this.cfg.abortRangeMultiplier) {
      this.cancel();
      return;
    }
    const r = s.update(dt);
    if (r) this.conclude(s, r);
    else this.ui.update(s.view());
  }

  private conclude(s: NegotiationSession, result: NegotiationResult): void {
    this.session = null;
    const t = this.cfg.text;
    const msg: Record<NegotiationResult, string> = {
      surrender: t.surrender,
      release: t.release,
      fire: t.fire,
      worsen: t.worsen,
      abort: t.cancel,
      interrupted: t.interrupted,
    };
    this.ui.update(s.view());
    this.ui.finish(msg[result], this.cfg.resultHoldSec);
    this.subtitle.show(msg[result], this.cfg.resultHoldSec);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregister();
    this.session = null;
    this.ui.onChoose = null;
    this.ui.onCancel = null;
    this.weapons.suppressFire = false;
    this.input.suppressSquadShortcuts = false;
  }
}
