import { t } from '../../core/i18n';
import type { Vec3 } from '../../core/types';
import { hasLineOfSight } from '../../weapons/Flashbang';
import type { Door } from '../../world/Door';
import type { BarricadeHooks } from '../Fortify';
import { findObstructingBarricade } from './swatHelpers';
import type { SwatHunter } from './SwatHunter';
import {
  TRAP_SPOT_CHANCE,
  TRAP_SPOT_CHANCE_WARY,
  TRAP_SPOT_DIST,
  TRAP_TRIGGER_DIST,
  type SwatTeamDeps,
  type TrapHooks,
} from './swatTypes';

export interface SwatObstaclesHost {
  readonly d: SwatTeamDeps;
  readonly hunters: readonly SwatHunter[];
  readonly started: boolean;
  readonly lastSighting: Vec3 | null;
  doorById(id: string): Door | null;
  civilianInLine(from: Vec3, to: Vec3): boolean;
  coveredByHostage(x: number, z: number): boolean;
  canPlayerHear(pos: Vec3, range: number): boolean;
  firstAlive(): SwatHunter | undefined;
  radio(h: SwatHunter | undefined, text: string, voice: string, force?: boolean): void;
  onBlastKill(h: SwatHunter): void;
}

/** 窓バリケード破壊（F9）・ブービートラップ検知/解除/爆発を担当するコーディネータ */
export class SwatObstacles {
  private barricades: BarricadeHooks | null = null;
  private barricadeRadioCd = 0;
  private traps: TrapHooks | null = null;
  /** 解除のために一時施錠したドア → 元の施錠状態 */
  private readonly heldDoors = new Map<string, { wasLocked: boolean; by: SwatHunter | null }>();
  private readonly detonateScratch: string[] = [];
  private readonly chestScratch: Vec3 = { x: 0, y: 0, z: 0 };
  private trapsSeen = 0;
  trapsDisarmed = 0;
  trapKills = 0;

  constructor(private readonly host: SwatObstaclesHost) {}

  tickTimers(dt: number): void {
    this.barricadeRadioCd = Math.max(0, this.barricadeRadioCd - dt);
  }

  // ---------- 窓バリケード破壊（F9） ----------

  attachBarricades(hooks: BarricadeHooks): void {
    this.barricades = hooks;
  }

  /**
   * 目標との射線を遮る板張り窓を検出し、安全な場合に 3 発バーストで撃ち抜く。
   * EngageBehavior.fireAt に CombatThreat.point = b.center を渡すことで STAND_CHEST 加算を防ぎ窓中心へ命中させる。
   */
  tryShootBarricade(h: SwatHunter, dt: number): boolean {
    if (!this.barricades) return false;
    h.barricadeCd = Math.max(0, h.barricadeCd - dt);
    if (h.barricadeCd > 0) return false;
    if (h.sees || h.pepperThreat || h.blindLeft > 0) return false;
    if (h.engage.ammoLeft <= 6 || h.engage.label === 'reload' || h.engage.label === 'toCover') return false;
    const refTarget =
      h.known ??
      h.huntTarget ??
      this.host.lastSighting ??
      (h.goalCell ? { x: h.goalCell.x, y: h.goalCell.y, z: h.goalCell.z } : null);
    if (!refTarget) return false;
    const boarded = this.barricades.listBoarded();
    if (boarded.length === 0) {
      h.barricadeCd = 0.25;
      return false;
    }
    const eye: Vec3 = { x: h.body.px, y: h.body.footY + 1.55, z: h.body.pz };
    const hit = findObstructingBarricade(eye, h.body.footY, refTarget, boarded, this.host.d.colliders);
    if (!hit) {
      h.barricadeBurst = 0;
      h.barricadeCd = 0.25;
      return false;
    }
    if (this.host.civilianInLine(eye, hit.nearFace) || this.host.coveredByHostage(h.body.px, h.body.pz)) return false;

    const b = hit.barricade;
    h.body.faceToward(b.center.x, b.center.z);
    h.engage.fireAt({ id: b.id, x: b.center.x, z: b.center.z, point: b.center, isPlayer: false }, null);
    if (h.barricadeBurst <= 0) h.barricadeBurst = 3;
    h.barricadeBurst--;
    h.barricadeCd = h.barricadeBurst > 0 ? Math.max(0.22, h.combat.fireInterval) : 1.1;
    if (this.barricadeRadioCd <= 0) {
      this.barricadeRadioCd = 12;
      this.host.radio(h, '窓にバリケードだ！ 撃ち抜いて射線を開く！', 'Window is boarded! Shooting it out!');
    }
    return true;
  }

  // ---------- ブービートラップ ----------

  attachTraps(traps: TrapHooks): void {
    this.traps = traps;
  }

  /** C2 爆破前にドアのトラップを安全に無力化する */
  disarmTrappedDoorOnC2(door: Door): void {
    if (this.traps?.isTrapped(door.id)) {
      this.traps.disarm(door.id);
      if (this.host.canPlayerHear({ x: door.centerX, y: door.sillY, z: door.centerZ }, 14)) {
        this.host.d.subtitle.show(
          t('C2の爆風でドアのブービートラップが吹き飛んだ！', 'The C2 blast destroyed the door booby trap!'),
          2.0,
        );
      }
    }
  }

  /** 解除のために押さえているドア（ブリーチ対象から外す） */
  trapHeld(door: Door): boolean {
    return this.heldDoors.has(door.id);
  }

  trapStillThere(door: Door): boolean {
    return !!this.traps?.isTrapped(door.id);
  }

  /** 隊員の近くの閉じた仕掛けドアに気付くか判定。気付けば解除を始める */
  checkTraps(h: SwatHunter): void {
    const traps = this.traps;
    if (!traps || !this.host.started || h.blindLeft > 0) return;
    for (const id of traps.trappedDoorIds()) {
      const door = this.host.doorById(id);
      if (!door || door.angle > 2) continue;
      if (Math.abs(door.sillY - h.body.footY) > 0.75) continue;
      if (Math.hypot(door.centerX - h.body.px, door.centerZ - h.body.pz) > TRAP_SPOT_DIST) continue;
      const held = this.heldDoors.get(id);
      if (held) {
        if (held.by && held.by.alive && held.by.state === 'disarm') continue;
        held.by = h; // 前任者が解除を中断した: 引き継ぐ
        h.beginDisarm(door);
        return;
      }
      if (h.checkedTraps.has(id)) continue;
      h.checkedTraps.add(id);
      if (Math.random() >= (this.trapsSeen > 0 ? TRAP_SPOT_CHANCE_WARY : TRAP_SPOT_CHANCE)) continue;
      this.trapsSeen++;
      this.heldDoors.set(id, { wasLocked: door.locked, by: h });
      door.locked = true; // 解除が終わるまで誰も開けない
      h.beginDisarm(door);
      this.host.radio(h, 'ワイヤーだ！ ドアにブービートラップ！ 解除する、時間をくれ。', 'Tripwire! Door is rigged, stand by.', true);
      if (this.host.canPlayerHear({ x: door.centerX, y: door.sillY, z: door.centerZ }, 10)) {
        this.host.d.subtitle.show(
          t('SWAT「トラップだ…慎重にいけ」— 解除に手間取っている', 'SWAT: "It\'s a trap... take it slow" — busy disarming it'),
          2.0,
        );
      }
      return;
    }
  }

  abandonDisarm(door: Door): void {
    const held = this.heldDoors.get(door.id);
    if (held) held.by = null;
  }

  finishDisarm(h: SwatHunter, door: Door, success: boolean): void {
    const held = this.heldDoors.get(door.id);
    this.heldDoors.delete(door.id);
    door.locked = held?.wasLocked ?? false;
    if (success) {
      this.trapsDisarmed++;
      this.traps?.disarm(door.id);
      this.host.radio(h, 'トラップ解除完了。前進する。', 'Trap disarmed, moving.', true);
    } else {
      this.host.radio(h, 'しまった、解除に失敗——！', 'Oh no—', true);
      this.traps?.detonate(door.id);
    }
  }

  /** 毎フレーム: SWAT の近くで仕掛けドアが開いたら起爆 */
  watchTraps(): void {
    const traps = this.traps;
    if (!traps || !this.host.started) return;
    this.detonateScratch.length = 0;
    for (const id of traps.trappedDoorIds()) {
      const door = this.host.doorById(id);
      if (!door || door.angle <= 2 || this.heldDoors.has(id)) continue;
      let near = false;
      for (let i = 0; i < this.host.hunters.length; i++) {
        const h = this.host.hunters[i]!;
        if (
          h.alive &&
          Math.abs(h.body.footY - door.sillY) < 0.9 &&
          Math.hypot(h.body.px - door.centerX, h.body.pz - door.centerZ) < TRAP_TRIGGER_DIST
        ) {
          near = true;
          break;
        }
      }
      if (near) this.detonateScratch.push(id);
    }
    for (let i = 0; i < this.detonateScratch.length; i++) {
      traps.detonate(this.detonateScratch[i]!);
    }
  }

  /** トラップの爆発に巻き込まれた隊員の被害 */
  applyBlast(pos: Vec3, radius: number): void {
    let downed = 0;
    for (const h of this.host.hunters) {
      if (!h.alive) continue;
      const c = h.body.chestPos(this.chestScratch);
      const dist = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
      if (dist < radius && hasLineOfSight(this.host.d.colliders, pos, c)) {
        const dmg = Math.round(95 * (1 - 0.6 * (dist / radius)));
        if (h.takeHit(dmg, pos)) {
          this.trapKills++;
          downed++;
          this.host.onBlastKill(h);
        }
      } else if (dist < radius * 2.2) {
        h.onFlashed(2.2 * (1 - dist / (radius * 2.2)));
      }
    }
    const speaker = this.host.firstAlive();
    if (speaker) {
      this.host.radio(
        speaker,
        downed > 0 ? '爆発物だ！ 負傷者多数！ ドアに気を付けろ！' : '爆発！ ブービートラップだ、全員ドアを警戒しろ！',
        downed > 0 ? 'IED! Officers down! Watch the doors!' : 'IED! Booby trap! Watch the doors!',
        true,
      );
    }
    this.trapsSeen++; // 以後は警戒してトラップに気付きやすい
  }
}
