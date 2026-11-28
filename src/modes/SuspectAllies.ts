import type { GameEventBus } from '../core/events';
import { SuspectState } from '../core/events';
import { t } from '../core/i18n';
import type { Vec3 } from '../core/types';
import type { Suspect } from '../ai/Suspect';
import type { Interaction } from '../player/Interaction';
import type { SuspectAllyPolicy } from '../rules/Progression';
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

/** 仲間の方針ごとの行動・士気・作業補正 */
export interface AllyPolicyModifiers {
  /** 開始時に味方全員へ付与する士気補正 */
  initialMoraleDelta: number;
  /** 隊員ダウン時の士気上昇倍率 */
  officerDownMoraleMul: number;
  /** プレイヤー視認中の士気回復倍率 */
  nearPlayerMoraleMul: number;
  /** 士気上限への加算ボーナス */
  moraleCeilBonus: number;
  /** 籠城維持による自律士気回復 (/秒) */
  steadyMoralePerSec: number;
  /** SWAT 発見コールアウト距離倍率 */
  calloutRangeMul: number;
  /** SWAT 発見コールアウト間隔倍率（小さいほど頻繁） */
  calloutCdMul: number;
  /** 手錠解放の所要時間倍率（小さいほど速い） */
  freeHoldMul: number;
  /** 準備作業速度倍率（Fortify 連携用） */
  workRateMul: number;
}

export const ALLY_POLICY_MODIFIERS: Record<SuspectAllyPolicy, Readonly<AllyPolicyModifiers>> = {
  balanced: {
    initialMoraleDelta: 0,
    officerDownMoraleMul: 1.0,
    nearPlayerMoraleMul: 1.0,
    moraleCeilBonus: 0,
    steadyMoralePerSec: 0,
    calloutRangeMul: 1.0,
    calloutCdMul: 1.0,
    freeHoldMul: 1.0,
    workRateMul: 1.0,
  },
  aggressive: {
    initialMoraleDelta: 10,
    officerDownMoraleMul: 1.35,
    nearPlayerMoraleMul: 1.3,
    moraleCeilBonus: 6,
    steadyMoralePerSec: 0,
    calloutRangeMul: 1.25,
    calloutCdMul: 0.75,
    freeHoldMul: 0.85,
    workRateMul: 0.75,
  },
  fortify: {
    initialMoraleDelta: 4,
    officerDownMoraleMul: 0.9,
    nearPlayerMoraleMul: 1.5,
    moraleCeilBonus: 8,
    steadyMoralePerSec: 0.4,
    calloutRangeMul: 1.15,
    calloutCdMul: 0.9,
    freeHoldMul: 1.0,
    workRateMul: 1.45,
  },
};

export function allyPolicyModifiers(policy: SuspectAllyPolicy): Readonly<AllyPolicyModifiers> {
  return ALLY_POLICY_MODIFIERS[policy] ?? ALLY_POLICY_MODIFIERS.balanced;
}

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
  /** 仲間の方針（未指定時は 'balanced'） */
  allyPolicy?: SuspectAllyPolicy;
}

/**
 * 容疑者モードの味方 NPC との関わり（逆転の手段）:
 *  - 拘束された味方を F 長押し（約 3 秒）で解放 → 士気を落としたまま遮蔽から戦線に復帰
 *  - プレイヤーが隊員を倒すと、銃声の届く範囲の味方の士気が上がる（投降しにくくなる）。プレイヤーが近くに見えている味方も同様
 *  - 味方が SWAT を見つけたら、方向を字幕で知らせる（回数制限付き）
 *  - 仲間方針（balanced / aggressive / fortify）に応じて士気・コールアウト・作業速度倍率を変化させる
 */
export class SuspectAllyDirector {
  private readonly unsubs: (() => void)[] = [];
  private readonly policyValue: SuspectAllyPolicy;
  private readonly mods: Readonly<AllyPolicyModifiers>;
  private tick = 0;
  private calloutCd = 4;
  private freeDone = false;

  constructor(private readonly d: AllyDirectorDeps) {
    this.policyValue = d.allyPolicy ?? 'balanced';
    this.mods = allyPolicyModifiers(this.policyValue);
    const freeHoldSec = FREE_ALLY_HOLD_SEC * this.mods.freeHoldMul;

    if (this.mods.initialMoraleDelta !== 0) {
      for (const s of d.suspects()) {
        if (s.friendly && s.alive) s.adjustMorale(this.mods.initialMoraleDelta);
      }
    }

    this.unsubs.push(
      d.interaction.register<Suspect>({
        id: 'freeAlly',
        priority: 280,
        resolve: () => this.findRestrained(),
        label: (a) =>
          a.isRestrained
            ? t(
                `F 長押し: 仲間の手錠を外す（${freeHoldSec.toFixed(1).replace(/\.0$/, '')} 秒）`,
                `Hold F: Free Your Accomplice (${freeHoldSec.toFixed(1).replace(/\.0$/, '')}s)`,
              )
            : '',
        onPress: () => {
          this.freeDone = false;
        },
        onHold: (a, _dt, sec) => {
          if (this.freeDone) return;
          d.showGauge(t('仲間の手錠を外している...', 'Freeing your accomplice...'), sec / freeHoldSec);
          if (sec < freeHoldSec) return;
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

  /** 適用中の仲間方針 */
  get policy(): SuspectAllyPolicy {
    return this.policyValue;
  }

  /** 方針に応じた準備作業速度倍率 */
  get workRateMul(): number {
    return this.mods.workRateMul;
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
    const delta = ALLY_DOWN_MORALE * this.mods.officerDownMoraleMul;
    for (const s of this.d.suspects()) {
      if (!s.friendly || !s.alive) continue;
      if (Math.hypot(s.body.px - pos.x, s.body.pz - pos.z) > ALLY_DOWN_EARSHOT) continue;
      s.adjustMorale(delta);
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
    const ceilAdd = ALLY_MORALE_CEIL + this.mods.moraleCeilBonus;
    for (const s of this.d.suspects()) {
      if (!s.friendly || !s.alive || s.state === SuspectState.SURRENDER || s.state === SuspectState.ARRESTED) continue;
      const ceil = s.profile.initialMorale + ceilAdd;
      if (this.mods.steadyMoralePerSec > 0 && s.morale.value < ceil) {
        s.adjustMorale(this.mods.steadyMoralePerSec * TICK_SEC);
      }
      const chest = s.body.chestPos();
      // プレイヤーが近くで見えている味方は踏みとどまる（投降しにくくなる）
      if (
        Math.abs(s.body.footY - p.position.y) < 1.2 &&
        Math.hypot(s.body.px - p.position.x, s.body.pz - p.position.z) <= ALLY_NEAR_PLAYER_RANGE &&
        s.morale.value < ceil &&
        hasLineOfSight(this.d.colliders, eye, chest)
      ) {
        s.adjustMorale(ALLY_NEAR_PLAYER_MORALE_PER_SEC * this.mods.nearPlayerMoraleMul * TICK_SEC);
      }
    }
    if (this.calloutCd <= 0) this.maybeCallout(eye);
  }

  /** 味方が見ている SWAT の位置を、プレイヤー視点の方向で知らせる。プレイヤー自身に見えている隊員は言わない */
  private maybeCallout(eye: Vec3): void {
    const p = this.d.player;
    const calloutRange = ALLY_CALLOUT_RANGE * this.mods.calloutRangeMul;
    for (const s of this.d.suspects()) {
      if (!s.friendly || !s.alive || s.state === SuspectState.SURRENDER || s.state === SuspectState.ARRESTED) continue;
      if (s.isFlashed) continue;
      const from = s.body.chestPos();
      for (const h of this.d.team.hunters) {
        if (!h.alive) continue;
        if (Math.abs(h.body.footY - s.body.footY) > 1.2) continue;
        const dist = Math.hypot(h.body.px - s.body.px, h.body.pz - s.body.pz);
        if (dist > calloutRange) continue;
        const chest = h.body.chestPos();
        if (!hasLineOfSight(this.d.colliders, from, chest)) continue;
        if (hasLineOfSight(this.d.colliders, eye, chest)) continue; // プレイヤーにも見えている
        const dx = h.body.px - p.position.x;
        const dz = h.body.pz - p.position.z;
        const dir = relativeDirection(p.yawRad, dx, dz);
        const m = Math.round(Math.hypot(dx, dz));
        this.calloutCd = ALLY_CALLOUT_COOLDOWN * this.mods.calloutCdMul;
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
