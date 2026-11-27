import type { GameEventBus } from '../core/events';
import { SuspectState } from '../core/events';
import { t } from '../core/i18n';
import type { Vec3 } from '../core/types';
import type { Suspect } from '../ai/Suspect';
import type { Interaction } from '../player/Interaction';
import type { Subtitle } from '../ui/Subtitle';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Collider } from '../world/WorldBuilder';

/** F 長押しで拘束された味方の手錠を外すまでの秒数・届く距離(m) */
export const FREE_ALLY_HOLD_SEC = 3.0;
export const FREE_ALLY_RANGE = 1.9;
/** 隊員がダウンしたとき、その音が届く範囲(m)内の味方の士気が上がる量 */
export const ALLY_DOWN_EARSHOT = 26;
export const ALLY_DOWN_MORALE = 14;
/** プレイヤーが近くに見えている味方の士気が上がる速さ(/秒)・その距離(m)・上限（初期士気 + この値） */
export const ALLY_NEAR_PLAYER_RANGE = 12;
export const ALLY_NEAR_PLAYER_MORALE_PER_SEC = 1.4;
export const ALLY_MORALE_CEIL = 18;
/** 味方が SWAT の位置を知らせる: 視認距離(m)・最短間隔(s)・判定周期(s) */
export const ALLY_CALLOUT_RANGE = 16;
export const ALLY_CALLOUT_COOLDOWN = 14;
const TICK_SEC = 0.5;

/** プレイヤーの最小インターフェース */
export interface AllyDirectorPlayer {
  readonly alive: boolean;
  readonly yawRad: number;
  readonly position: Vec3;
  getEyePosition(): Vec3;
}

export interface AllyDirectorTeam {
  readonly hunters: readonly { alive: boolean; body: { px: number; pz: number; footY: number; chestPos(): Vec3 } }[];
  onOfficerDown(cb: (pos: Vec3, byPlayer: boolean) => void): () => void;
}

export interface AllyDirectorDeps {
  suspects: () => Iterable<Suspect>;
  player: AllyDirectorPlayer;
  interaction: Interaction;
  subtitle: Pick<Subtitle, 'show'>;
  bus: GameEventBus;
  team: AllyDirectorTeam;
  colliders: readonly Collider[];
  showGauge(label: string, ratio: number): void;
}

/**
 * 容疑者モードの味方 NPC との関わり（逆転の手段）:
 *  - 拘束された味方を F 長押し（約 3 秒）で解放 → 士気を落としたまま遮蔽から戦線に復帰
 *  - プレイヤーが隊員を倒すと、銃声の届く範囲の味方の士気が上がる（投降しにくくなる）。プレイヤーが近くに見えている味方も同様
 *  - 味方が SWAT を見つけたら、方向を字幕で知らせる（回数制限付き）
 */
export class SuspectAllyDirector {
  private readonly unsubs: (() => void)[] = [];
  private tick = 0;
  private calloutCd = 4;
  private freeDone = false;

  constructor(private readonly d: AllyDirectorDeps) {
    this.unsubs.push(
      d.interaction.register<Suspect>({
        id: 'freeAlly',
        priority: 280,
        resolve: () => this.findRestrained(),
        label: (a) =>
          a.isRestrained
            ? t('F 長押し: 仲間の手錠を外す（3 秒）', 'Hold F: Free Your Accomplice (3s)')
            : '',
        onPress: () => {
          this.freeDone = false;
        },
        onHold: (a, _dt, sec) => {
          if (this.freeDone) return;
          d.showGauge(t('仲間の手錠を外している...', 'Freeing your accomplice...'), sec / FREE_ALLY_HOLD_SEC);
          if (sec < FREE_ALLY_HOLD_SEC) return;
          this.freeDone = true;
          if (!a.freeFromRestraint()) return;
          const p = d.player.position;
          // 手錠の金属音は近くの隊員に聞こえる
          d.bus.emit('noise', { pos: { x: p.x, y: p.y + 1, z: p.z }, radius: 7, kind: 'door', source: 'player' });
          d.subtitle.show(
            t('仲間「助かった！ 遮蔽から援護する！」— 拘束を解いた', 'Accomplice: "Thanks! I\'ll cover from cover!" — Freed'),
            2.2,
          );
        },
        onRelease: () => {
          this.freeDone = false;
        },
      }),
      d.team.onOfficerDown((pos) => this.onOfficerDown(pos)),
    );
  }

  /** 照準の先（近距離）にいる拘束済みの味方 */
  private findRestrained(): Suspect | null {
    const p = this.d.player;
    if (!p.alive) return null;
    let best: Suspect | null = null;
    let bestD = FREE_ALLY_RANGE;
    for (const s of this.d.suspects()) {
      if (!s.friendly || !s.isRestrained) continue;
      if (Math.abs(s.body.footY - p.position.y) > 0.9) continue;
      const dist = Math.hypot(s.body.px - p.position.x, s.body.pz - p.position.z);
      if (dist < bestD) {
        bestD = dist;
        best = s;
      }
    }
    return best;
  }

  /** 隊員がダウン: 銃声が届く範囲の戦意のある味方の士気が上がる */
  private onOfficerDown(pos: Vec3): void {
    for (const s of this.d.suspects()) {
      if (!s.friendly || !s.alive) continue;
      if (Math.hypot(s.body.px - pos.x, s.body.pz - pos.z) > ALLY_DOWN_EARSHOT) continue;
      s.adjustMorale(ALLY_DOWN_MORALE);
    }
  }

  update(rawDt: number): void {
    const dt = Math.min(rawDt, 0.05);
    this.calloutCd = Math.max(0, this.calloutCd - dt);
    this.tick -= dt;
    if (this.tick > 0) return;
    this.tick = TICK_SEC;
    const p = this.d.player;
    if (!p.alive) return;
    const eye = p.getEyePosition();
    for (const s of this.d.suspects()) {
      if (!s.friendly || !s.alive || s.state === SuspectState.SURRENDER || s.state === SuspectState.ARRESTED) continue;
      const chest = s.body.chestPos();
      // プレイヤーが近くで見えている味方は踏みとどまる（投降しにくくなる）
      if (
        Math.abs(s.body.footY - p.position.y) < 1.2 &&
        Math.hypot(s.body.px - p.position.x, s.body.pz - p.position.z) <= ALLY_NEAR_PLAYER_RANGE &&
        s.morale.value < s.profile.initialMorale + ALLY_MORALE_CEIL &&
        hasLineOfSight(this.d.colliders, eye, chest)
      ) {
        s.adjustMorale(ALLY_NEAR_PLAYER_MORALE_PER_SEC * TICK_SEC);
      }
    }
    if (this.calloutCd <= 0) this.maybeCallout(eye);
  }

  /** 味方が見ている SWAT の位置を、プレイヤー視点の方向で知らせる。プレイヤー自身に見えている隊員は言わない */
  private maybeCallout(eye: Vec3): void {
    const p = this.d.player;
    for (const s of this.d.suspects()) {
      if (!s.friendly || !s.alive || s.state === SuspectState.SURRENDER || s.state === SuspectState.ARRESTED) continue;
      if (s.isFlashed) continue;
      const from = s.body.chestPos();
      for (const h of this.d.team.hunters) {
        if (!h.alive) continue;
        if (Math.abs(h.body.footY - s.body.footY) > 1.2) continue;
        const dist = Math.hypot(h.body.px - s.body.px, h.body.pz - s.body.pz);
        if (dist > ALLY_CALLOUT_RANGE) continue;
        const chest = h.body.chestPos();
        if (!hasLineOfSight(this.d.colliders, from, chest)) continue;
        if (hasLineOfSight(this.d.colliders, eye, chest)) continue; // プレイヤーにも見えている
        const dx = h.body.px - p.position.x;
        const dz = h.body.pz - p.position.z;
        const dir = relativeDirection(p.yawRad, dx, dz);
        const m = Math.round(Math.hypot(dx, dz));
        this.calloutCd = ALLY_CALLOUT_COOLDOWN;
        this.d.subtitle.show(
          t(`仲間「${dir.ja}に SWAT！ 約 ${m}m だ！」`, `Accomplice: "SWAT ${dir.en}! About ${m}m!"`),
          2.2,
        );
        return;
      }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }
}

/** プレイヤーの向き（yaw）から見た (dx,dz) の方向語 */
export function relativeDirection(yawRad: number, dx: number, dz: number): { ja: string; en: string } {
  const fx = -Math.sin(yawRad);
  const fz = -Math.cos(yawRad);
  const front = fx * dx + fz * dz;
  // 右 = 前方を時計回りに 90°（x 右 / z 手前の座標系: (-fz, fx)）
  const right = -fz * dx + fx * dz;
  const a = Math.atan2(right, front);
  const deg = (a * 180) / Math.PI;
  if (Math.abs(deg) <= 40) return { ja: '正面', en: 'ahead' };
  if (Math.abs(deg) >= 140) return { ja: '背後', en: 'behind you' };
  return deg > 0 ? { ja: '右', en: 'on your right' } : { ja: '左', en: 'on your left' };
}
