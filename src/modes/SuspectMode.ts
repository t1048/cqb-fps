import type { EntityManager } from '../ai/EntityManager';
import type { GameEventBus } from '../core/events';
import { t } from '../core/i18n';
import type { InputManager } from '../core/InputManager';
import type { MapData, PlayerSpawn, WeaponDef } from '../core/types';
import type { PlayerController } from '../player/PlayerController';
import type { Interaction } from '../player/Interaction';
import type { Subtitle } from '../ui/Subtitle';
import type { Door, DoorSystem } from '../world/Door';
import type { Fortify } from './Fortify';
import type { SwatSpawn, SwatTeam } from './SwatTeam';
import { indoorFloorArea } from '../rules/MissionRoster';
import { suspectLoadout, type SuspectLoadout } from './SuspectLoadout';

/** ゲームモード: swat = 通常（SWAT 隊長として突入）、suspect = 容疑者として籠城し SWAT と戦う */
export type GameMode = 'swat' | 'suspect';

export function parseGameMode(v: string | null | undefined): GameMode {
  return v === 'suspect' ? 'suspect' : 'swat';
}

export function parseReinforcements(v: string | null | undefined): boolean {
  return v === '1' || v === 'true';
}

/** 容疑者モードのルール定数。人数は MissionRoster（両モード共通）が決める。 */
export const SUSPECT_MODE = {
  /** SWAT 突入までの準備時間（秒）。交渉で増減する */
  prepSec: 30,
  /** 突入後、籠城成功までの時間（秒） */
  holdSec: 240,
} as const;

export interface SuspectModeSetup {
  map: MapData;
  swatSpawns: SwatSpawn[];
  /** プレイヤーを含む SWAT 合計。applyMissionRoster 後の allies + 1 */
  swatCount: number;
  /** 建物の規模に応じた持ち込み装備 */
  loadout: SuspectLoadout;
}

/**
 * 通常ステージを容疑者モード用に変換する。
 * 人数は applyMissionRoster 済みのマップをそのまま使う（ここで増やしたり減らしたりしない）。
 * - プレイヤーは容疑者の配置位置のいずれか（突入地点から遠いほど選ばれやすい）。その 1 人は NPC から外す
 * - 残りの容疑者は全員味方 NPC。合計は SWAT モードの容疑者数と一致する
 * - SWAT は突入地点 + 隊員配置。人数は SWAT モードのプレイヤー込み合計と一致する
 * - 民間人はそのまま（人質）。分隊はいない
 */
export function prepareSuspectMode(map: MapData): SuspectModeSetup {
  const suspects = map.entities.filter((e) => e.type === 'suspect');
  const swatSpawns: SwatSpawn[] = [
    { x: map.playerSpawn.x, y: map.playerSpawn.y, z: map.playerSpawn.z },
    ...map.allies.map((a) => ({ x: a.x, y: a.y ?? 0, z: a.z })),
  ];
  const entry = map.playerSpawn;
  // 突入地点から遠い容疑者位置ほど選ばれやすい
  let spawn: PlayerSpawn = { ...entry };
  let playerSuspectId: string | null = null;
  if (suspects.length > 0) {
    const weighted = suspects.map((s) => ({ s, w: 1 + Math.hypot(s.x - entry.x, s.z - entry.z) }));
    const total = weighted.reduce((a, b) => a + b.w, 0);
    let roll = Math.random() * total;
    let pick = weighted[0]!.s;
    for (const { s, w } of weighted) {
      roll -= w;
      if (roll <= 0) {
        pick = s;
        break;
      }
    }
    playerSuspectId = pick.id;
    // 突入地点の方を向く
    const yaw = (Math.atan2(entry.x - pick.x, -(entry.z - pick.z)) * 180) / Math.PI;
    spawn = { x: pick.x, y: pick.y ?? 0, z: pick.z, yaw };
  }
  const kept = suspects.filter((s) => s.id !== playerSuspectId);
  const keptIds = new Set(kept.map((s) => s.id));
  const civilians = map.entities.filter((e) => e.type === 'civilian').length;
  const swatCount = swatSpawns.length;
  const holdMin = Math.round(SUSPECT_MODE.holdSec / 60);
  const loadout = suspectLoadout(indoorFloorArea(map.rooms));
  const medJa = loadout.medkits > 0 ? `・救急キット ${loadout.medkits} 個` : '';
  const medEn = loadout.medkits > 0 ? `, ${loadout.medkits} medkit${loadout.medkits === 1 ? '' : 's'}` : '';
  const summary = t(
    'あなたは立てこもり犯だ。' +
      (kept.length > 0 ? `仲間の容疑者 ${kept.length} 名が同じ建物にいる。` : '') +
      `まもなく SWAT ${swatCount} 名が入口から突入してくる。` +
      `突入から ${holdMin} 分間持ちこたえるか、SWAT を全員無力化せよ。` +
      '武器は改造フルオート拳銃のみ。' +
      `建物の規模に合わせて予備マガジン ${loadout.reserveMagazines} 本・トラップ部材 ${loadout.trapKits} 個${medJa}を持ち込んでいる。` +
      '突入前の交渉で時間を稼いだり、人質と防弾チョッキ・弾薬を交換できる。' +
      'ドアを施錠（F 長押し）、窓を板で塞ぎ（窓の前で F 長押し）、ドアにトラップを仕掛けろ（C でしゃがんだ状態で F 長押し）。時間を稼げば仲間が補強・武器改造を進める。' +
      '人質を盾にもできる（民間人の前で F 長押し）が、人質は暴れて振りほどこうとし、SWAT はペッパーボールで盾ごと崩してくる。',
    'You are a barricaded suspect. ' +
      (kept.length > 0 ? `${kept.length} armed ${kept.length === 1 ? 'accomplice is' : 'accomplices are'} inside the building with you. ` : '') +
      `${swatCount} SWAT officers will breach the entrance soon. ` +
      `Hold out for ${holdMin} minutes after the breach, or neutralize all SWAT officers. ` +
      'Your only weapon is a modded auto pistol. ' +
      `Sized to the building, you brought ${loadout.reserveMagazines} spare magazines, ${loadout.trapKits} trap kits${medEn}. ` +
      'Negotiate before the breach to buy time, or trade hostages for body armor and ammo. ' +
      'Lock doors (Hold F), board up windows (Hold F at a window), and rig door traps (Crouch with C, then Hold F). Buying time lets your accomplices craft traps and upgrade weapons. ' +
      'You can also take a hostage as a human shield (Hold F near a civilian), but they will struggle to break free and SWAT will use pepperballs to disrupt your grip.',
  );
  return {
    map: {
      ...map,
      playerSpawn: spawn,
      entities: map.entities.filter((e) => e.type !== 'suspect' || keptIds.has(e.id)),
      allies: [],
      briefing: {
        estimatedHostages: { min: civilians, max: civilians },
        estimatedSuspects: { min: swatCount, max: swatCount },
        summary,
      },
    },
    swatSpawns,
    swatCount,
    loadout,
  };
}

/** 容疑者が使える武器（faction='suspect' の改造拳銃のみ。非致死性装備・SWAT 装備は無し） */
export function suspectWeapons(defs: readonly WeaponDef[], reserveMagazines?: number): WeaponDef[] {
  const own = defs.filter((w) => w.faction === 'suspect');
  const list = own.length > 0 ? own : defs.filter((w) => w.category === 'primary');
  if (reserveMagazines === undefined) return list;
  // 建物の規模に応じた持ち込み弾薬（有限弾数の武器だけ置き換える）
  return list.map((w) => (w.reserveMagazines !== undefined ? { ...w, reserveMagazines } : w));
}

/** SWAT（通常モード）が使える武器 */
export function swatWeapons(defs: readonly WeaponDef[]): WeaponDef[] {
  return defs.filter((w) => w.faction !== 'suspect');
}

export type SuspectOutcome = 'repelled' | 'survived' | 'killed' | 'arrested';

export interface ResultReport {
  title: string;
  titleColor: string;
  subtitle?: string;
  subtitleGood?: boolean;
  scoreText: string;
  rankText: string;
  rankColor: string;
  stats: [string, string][];
  entries: { time: number; label: string; points: number }[];
}

const HUD_STYLE =
  'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:6;pointer-events:none;padding:8px 18px;' +
  'background:rgba(40,12,12,.82);border:1px solid #d65a5a;border-radius:5px;color:#ffe2e2;font:bold 14px sans-serif;' +
  'text-align:center;text-shadow:0 0 3px #000;max-width:calc(100vw - 32px);box-sizing:border-box';

const GAUGE_STYLE =
  'position:fixed;left:50%;top:calc(50% + 46px);transform:translateX(-50%);z-index:6;pointer-events:none;min-width:200px;' +
  'padding:6px 10px;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.5);border-radius:4px;color:#fff;font:bold 13px sans-serif;text-align:center';
/** F 長押しでドア施錠/解錠するまでの秒数 */
const LOCK_HOLD_SEC = 0.7;
/** Space 長押しで投降するまでの秒数 */
const SURRENDER_HOLD_SEC = 1.5;
/** これ未満で F を離したら通常の開閉 */
const TAP_SEC = 0.35;

function fmt(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 容疑者モードの進行管理: 準備 → SWAT 突入 → 籠城タイマー。
 * 勝利: SWAT 全員無力化 / 制限時間まで生存。敗北: 死亡 / 投降。
 * 操作は既存キーに統合: F タップ = ドア開閉、F 長押し = 閉じたドアの施錠/解錠、
 * Space = 準備中は即突入 / 突入後は長押しで投降（ゲージ表示）。
 */
export class SuspectMission {
  private readonly el = document.createElement('div');
  private readonly gaugeEl = document.createElement('div');
  private readonly gaugeText = document.createElement('div');
  private readonly gaugeFill = document.createElement('div');
  private gaugeShown = -1;
  private surrenderHold = 0;
  private lockDone = false;
  private trapping = false;
  private fortify: Fortify | null = null;
  private elapsed = 0;
  private assaultAt: number = SUSPECT_MODE.prepSec;
  private ended = false;
  private endingIn = -1;
  private outcome: SuspectOutcome | null = null;
  private readonly entries: { time: number; label: string; points: number }[] = [];
  private readonly killedCivIds = new Set<string>();
  private readonly unsubs: (() => void)[] = [];
  private shotsFired = 0;
  private hitsTaken = 0;
  private lastHud = '';

  constructor(
    private readonly team: SwatTeam,
    private readonly player: PlayerController,
    private readonly entities: EntityManager,
    private readonly doors: DoorSystem,
    private readonly input: InputManager,
    private readonly subtitle: Subtitle,
    bus: GameEventBus,
    interaction: Interaction,
    private readonly onEnd: (report: ResultReport, failed: boolean) => void,
    /** 突入開始の直後に 1 回呼ばれる（消耗による士気ペナルティなど） */
    private readonly onAssaultBegin: () => void = () => {},
  ) {
    this.el.style.cssText = HUD_STYLE;
    this.el.style.display = 'none';
    this.gaugeEl.style.cssText = GAUGE_STYLE;
    this.gaugeEl.style.display = 'none';
    const track = document.createElement('div');
    track.style.cssText = 'height:6px;margin-top:4px;background:rgba(255,255,255,.2)';
    this.gaugeFill.style.cssText = 'height:100%;width:0;background:#ff7b7b';
    track.appendChild(this.gaugeFill);
    this.gaugeEl.append(this.gaugeText, track);
    document.body.append(this.el, this.gaugeEl);
    // 容疑者モード専用のドア操作（通常のドア操作より優先）: タップ = 開閉、長押し = 施錠/解錠
    this.unsubs.push(
      interaction.register<Door>({
        id: 'suspectDoor',
        priority: 250,
        resolve: () => (this.player.alive && !this.ended ? this.doors.aimed(2.6) : null),
        label: (d) => {
          const trap = this.fortify?.isTrapped(d.id) ? t(' [トラップ設置済]', ' [Trapped]') : '';
          if (d.locked) {
            return (
              t(
                'ドア: 施錠中（F 長押しで解錠 / C でしゃがんで F 長押しでトラップ）',
                'Door: Locked (Hold F: Unlock / Crouch (C) + Hold F: Trap)',
              ) + trap
            );
          }
          if (d.angle > 1 || d.targetAngle > 1) {
            return t('ドア: F 開閉 / ホイール 段階', 'Door: F Open/Close / Wheel: Peek') + trap;
          }
          return (
            t(
              'ドア: F 開閉 / F 長押しで施錠 / C でしゃがんで F 長押しでトラップ',
              'Door: F Open/Close / Hold F: Lock / Crouch (C) + Hold F: Trap',
            ) + trap
          );
        },
        onPress: () => {
          this.lockDone = false;
          this.trapping = false;
        },
        onHold: (d, _dt, sec) => {
          if (sec < TAP_SEC) return;
          if (this.trapping || (!this.lockDone && this.fortify?.wantsTrap())) {
            // しゃがみ + 長押し: ブービートラップ（施錠とは別操作）
            this.trapping = true;
            this.fortify?.holdTrap(d, sec - TAP_SEC);
            return;
          }
          if (this.lockDone) return;
          const closed = d.angle <= 1 && d.targetAngle <= 1;
          if (!closed && !d.locked) return; // 開いているドアは施錠できない（タップ扱い）
          this.showGauge(
            d.locked ? t('解錠中...', 'Unlocking...') : t('施錠中...', 'Locking...'),
            (sec - TAP_SEC) / (LOCK_HOLD_SEC - TAP_SEC),
          );
          if (sec >= LOCK_HOLD_SEC) {
            this.lockDone = true;
            d.locked = !d.locked;
            this.subtitle.show(
              d.locked
                ? t('ドアを施錠した（SWAT はブリーチが必要）', 'Door locked (SWAT must breach)')
                : t('ドアの施錠を解除した', 'Door unlocked'),
              1.6,
            );
          }
        },
        onRelease: (d, sec) => {
          if (!this.lockDone && !this.trapping && sec < TAP_SEC && !d.locked) {
            d.toggle(true, this.player.position.x, this.player.position.z);
          }
          this.lockDone = false;
          this.trapping = false;
        },
        onWheel: (d, steps) => {
          const n = Math.min(Math.abs(steps), 2);
          for (let i = 0; i < n; i++) d.stepStage(steps < 0 ? 1 : -1, true, this.player.position.x, this.player.position.z);
        },
      }),
    );
    this.unsubs.push(
      bus.on('shotFired', (e) => {
        if (e.shooter === 'player') this.shotsFired++;
      }),
      bus.on('playerHit', () => this.hitsTaken++),
      bus.on('entityHit', (e) => {
        if (e.shooter !== 'player') return;
        const c = this.entities.civilians.get(e.targetId);
        if (c && !c.alive && !this.killedCivIds.has(e.targetId)) {
          this.killedCivIds.add(e.targetId);
          this.entries.push({
            time: this.elapsed,
            label: t(`民間人殺害 (${e.targetId})`, `Civilian Killed (${e.targetId})`),
            points: -400,
          });
        }
      }),
    );
  }

  attachFortify(f: Fortify): void {
    this.fortify = f;
  }

  /** 突入前の準備中か */
  get preparing(): boolean {
    return !this.team.hasStarted && !this.ended;
  }

  /** 結果画面の加減点を追加 */
  addEntry(label: string, points: number): void {
    this.entries.push({ time: this.elapsed, label, points });
  }

  /** 突入までの残り準備時間（秒） */
  get prepLeft(): number {
    return Math.max(0, this.assaultAt - this.elapsed);
  }

  /** 交渉で準備時間を加算 */
  addPrep(sec: number): void {
    if (!this.team.hasStarted) this.assaultAt += sec;
  }

  /** 交渉決裂: 準備時間を短縮 */
  breakdown(): void {
    if (!this.team.hasStarted) this.assaultAt = Math.min(this.assaultAt, this.elapsed + 8);
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? 'block' : 'none';
  }

  update(rawDt: number): void {
    if (this.ended) return;
    const dt = Math.min(rawDt, 0.05);
    this.elapsed += dt;

    if (this.endingIn >= 0) {
      this.endingIn -= dt;
      if (this.endingIn <= 0) this.finish();
      this.renderHud();
      return;
    }

    if (!this.team.hasStarted) {
      // Space: 準備完了 → 即突入
      if (this.input.wasPressed('warningCall') && this.elapsed > 0.5) this.assaultAt = this.elapsed;
      if (this.elapsed >= this.assaultAt) {
        this.team.beginAssault();
        this.onAssaultBegin();
        this.subtitle.show(t('SWAT が突入を開始した！', 'SWAT has initiated the breach!'), 2.5);
      }
    } else if (this.player.alive && this.input.isDown('warningCall')) {
      // Space 長押し: 両手を上げて投降
      this.surrenderHold += dt;
      this.showGauge(t('両手を上げて投降...', 'Surrendering (hands up)...'), this.surrenderHold / SURRENDER_HOLD_SEC);
      if (this.surrenderHold >= SURRENDER_HOLD_SEC) {
        this.subtitle.show(t('容疑者「わかった、投降する！撃つな！」', 'Suspect: "Okay, I surrender! Don\'t shoot!"'), 2.0);
        this.conclude('arrested', 1.2);
      }
    } else {
      this.surrenderHold = 0;
    }
    this.flushGauge();

    if (this.team.hasStarted && this.player.alive) {
      this.team.checkReinforcements(this.holdLeft);
    }

    if (!this.player.alive) this.conclude('killed', 1.4);
    else if (this.team.hasStarted && this.team.aliveCount === 0 && !this.team.hasPendingReinforcements) {
      this.conclude('repelled', 2.0);
    } else if (this.team.hasStarted && this.holdLeft <= 0) {
      this.subtitle.show(t('SWAT「撤退だ！包囲を維持しろ！」', 'SWAT: "Fall back! Maintain the perimeter!"'), 2.0);
      this.conclude('survived', 2.0);
    }
    this.renderHud();
  }

  private get holdLeft(): number {
    return this.assaultAt + SUSPECT_MODE.holdSec - this.elapsed;
  }

  private renderHud(): void {
    let text: string;
    if (this.endingIn >= 0) {
      const labels: Record<SuspectOutcome, string> = {
        repelled: t('SWAT 撃退！', 'SWAT REPELLED!'),
        survived: t('籠城成功 — SWAT が撤退していく', 'STANDOFF WON — SWAT is falling back'),
        killed: t('制圧された...', 'Neutralized...'),
        arrested: t('投降 — 拘束される...', 'Surrendered — Being restrained...'),
      };
      text = labels[this.outcome ?? 'killed'];
    } else if (!this.team.hasStarted) {
      text = t(
        `SWAT 突入まで ${fmt(this.assaultAt - this.elapsed)}　|　F 長押しでドア施錠 / Space で準備完了`,
        `SWAT Breach in ${fmt(this.assaultAt - this.elapsed)}  |  Hold F: Lock Door / Space: Ready`,
      );
    } else {
      const waveSuffix =
        this.team.reinforcementWavesSpawned > 0
          ? t(`　|　増援 第${this.team.reinforcementWavesSpawned}波`, `  |  Reinforcements Wave ${this.team.reinforcementWavesSpawned}`)
          : this.team.hasPendingReinforcements
            ? t('　|　増援あり', '  |  Reinforcements Incoming')
            : '';
      text =
        t(
          `籠城 残り ${fmt(this.holdLeft)}　|　SWAT 残り ${this.team.aliveCount}/${this.team.total}`,
          `Hold Out: ${fmt(this.holdLeft)}  |  SWAT Remaining: ${this.team.aliveCount}/${this.team.total}`,
        ) + waveSuffix;
    }
    if (text !== this.lastHud) {
      this.lastHud = text;
      this.el.textContent = text;
    }
  }

  private gaugeReq = -1;
  private gaugeLabel = '';

  /** 今フレームの長押しゲージを要求（最後の要求を flushGauge で反映） */
  showGauge(label: string, ratio: number): void {
    this.gaugeReq = Math.max(0, Math.min(1, ratio));
    this.gaugeLabel = label;
  }

  private flushGauge(): void {
    const r = this.endingIn >= 0 ? -1 : this.gaugeReq;
    this.gaugeReq = -1;
    if (r < 0) {
      if (this.gaugeShown >= 0) this.gaugeEl.style.display = 'none';
      this.gaugeShown = -1;
      return;
    }
    if (this.gaugeShown < 0) this.gaugeEl.style.display = 'block';
    this.gaugeShown = r;
    this.gaugeText.textContent = this.gaugeLabel;
    this.gaugeFill.style.width = `${Math.round(r * 100)}%`;
  }

  private conclude(o: SuspectOutcome, delay: number): void {
    if (this.endingIn >= 0) return;
    this.outcome = o;
    this.endingIn = delay;
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    const o = this.outcome ?? 'killed';
    const survived = Math.max(0, Math.min(SUSPECT_MODE.holdSec, this.elapsed - this.assaultAt));
    const kills = this.team.kills;
    const entries = [...this.entries];
    if (kills > 0) entries.push({ time: this.elapsed, label: t(`SWAT 無力化 ×${kills}`, `SWAT Neutralized ×${kills}`), points: kills * 500 });
    entries.push({ time: this.elapsed, label: t(`生存時間 ${fmt(survived)}`, `Time Survived ${fmt(survived)}`), points: Math.round(survived * 2) });
    const bonus: Record<SuspectOutcome, number> = { repelled: 1500, survived: 1000, killed: 0, arrested: 200 };
    if (bonus[o] > 0) {
      entries.push({
        time: this.elapsed,
        label:
          o === 'repelled'
            ? t('撃退ボーナス', 'Repel Bonus')
            : o === 'survived'
              ? t('籠城成功ボーナス', 'Standoff Victory Bonus')
              : t('投降（生存）', 'Surrendered (Alive)'),
        points: bonus[o],
      });
    }
    let deadCivs = 0;
    for (const c of this.entities.civilians.values()) if (!c.alive) deadCivs++;
    const total = Math.max(0, entries.reduce((a, e) => a + e.points, 0));
    const failed = o === 'killed' || o === 'arrested';
    const rank = total >= 3600 ? 'S' : total >= 2600 ? 'A' : total >= 1600 ? 'B' : total >= 800 ? 'C' : 'D';
    const titles: Record<SuspectOutcome, [string, string]> = {
      repelled: ['SWAT REPELLED', '#ffd24d'],
      survived: ['STANDOFF WON', '#7ce2f0'],
      killed: ['NEUTRALIZED', '#ff6b6b'],
      arrested: ['ARRESTED', '#ff9f5a'],
    };
    const subs: Record<SuspectOutcome, string> = {
      repelled: t('突入した SWAT を全員無力化した。', 'Neutralized all breaching SWAT officers.'),
      survived: t(
        `${fmt(SUSPECT_MODE.holdSec)} 間の籠城に成功し、SWAT は撤退した。`,
        `Held out for ${fmt(SUSPECT_MODE.holdSec)} and forced SWAT to fall back.`,
      ),
      killed: t(
        'SWAT に制圧された。施錠ドア・遮蔽物・静音移動・民間人を活用しよう。',
        'Neutralized by SWAT. Use locked doors, cover, quiet movement, and hostages.',
      ),
      arrested: t('投降して身柄を拘束された。', 'Surrendered and taken into custody.'),
    };
    const report: ResultReport = {
      title: titles[o][0],
      titleColor: titles[o][1],
      subtitle: subs[o],
      subtitleGood: !failed,
      scoreText: t(`総合スコア ${total}`, `Total Score ${total}`),
      rankText: o === 'killed' ? 'FAILED' : `RANK ${rank}`,
      rankColor: o === 'killed' ? '#ff6b6b' : '#ffd24d',
      stats: [
        [t('生存時間（突入後）', 'Time Survived (Post-Breach)'), fmt(survived)],
        [t('SWAT 無力化', 'SWAT Neutralized'), `${kills} / ${this.team.total}`],
        [t('トラップ（撃破 / 解除された）', 'Traps (Kills / Disarmed)'), `${this.team.trapKills} / ${this.team.trapsDisarmed}`],
        [t('発砲数', 'Shots Fired'), String(this.shotsFired)],
        [t('被弾数', 'Hits Taken'), String(this.hitsTaken)],
        [t('残り HP', 'Remaining HP'), String(Math.round(this.player.hp))],
        [t('民間人死亡', 'Civilians Killed'), String(deadCivs)],
      ],
      entries,
    };
    this.setVisible(false);
    this.gaugeEl.style.display = 'none';
    this.onEnd(report, failed);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.el.remove();
    this.gaugeEl.remove();
  }
}
