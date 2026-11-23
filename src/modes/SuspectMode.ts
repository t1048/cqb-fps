import type { EntityManager } from '../ai/EntityManager';
import type { GameEventBus } from '../core/events';
import type { InputManager } from '../core/InputManager';
import type { EntityDef, MapData, PlayerSpawn, RoomDef, WeaponDef } from '../core/types';
import type { PlayerController } from '../player/PlayerController';
import type { Interaction } from '../player/Interaction';
import type { Subtitle } from '../ui/Subtitle';
import type { Door, DoorSystem } from '../world/Door';
import type { SwatSpawn, SwatTeam } from './SwatTeam';

/** ゲームモード: swat = 通常（SWAT 隊長として突入）、suspect = 容疑者として籠城し SWAT と戦う */
export type GameMode = 'swat' | 'suspect';

export function parseGameMode(v: string | null | undefined): GameMode {
  return v === 'suspect' ? 'suspect' : 'swat';
}

/** 容疑者モードのルール定数 */
export const SUSPECT_MODE = {
  /** SWAT 突入までの準備時間（秒）。交渉で増減する */
  prepSec: 30,
  /** 突入後、籠城成功までの時間（秒） */
  holdSec: 240,
  /** SWAT 隊員数 */
  swatCount: 4,
} as const;

/** 屋内床面積この㎡あたり味方容疑者 NPC を 1 人（四捨五入）。 */
export const SUSPECT_ALLY_SQ_M = 160;
/** 大マップでも SWAT 4 名を人数だけで圧倒しない上限。 */
export const SUSPECT_ALLY_MAX = 6;

/** outdoor を除く部屋の床面積合計（㎡）。重なる階層も足す。 */
export function indoorFloorArea(rooms: readonly RoomDef[]): number {
  let area = 0;
  for (const r of rooms) if (!r.outdoor) area += r.width * r.depth;
  return area;
}

/**
 * 容疑者モードで残す味方 NPC 数。
 * npc = clamp(round(屋内床面積 / 160), 1, min(6, 配置数 - 1))。
 * 配置が 1 人以下なら 0（その枠はプレイヤーが使う）。
 * 例: 事務所 ≈464㎡→3、L字邸宅 ≈486㎡→3、倉庫 ≈657㎡→4、二階建て ≈365㎡→2。
 */
export function suspectAllyCount(placedSuspects: number, indoorSqMeters: number): number {
  if (placedSuspects <= 1) return 0;
  const scaled = Math.max(1, Math.round(indoorSqMeters / SUSPECT_ALLY_SQ_M));
  return Math.min(scaled, SUSPECT_ALLY_MAX, placedSuspects - 1);
}

export interface SuspectModeSetup {
  map: MapData;
  swatSpawns: SwatSpawn[];
}

/**
 * 通常ステージを容疑者モード用に変換する。
 * - プレイヤーは容疑者の配置位置のいずれかから開始（突入地点から遠いほど選ばれやすい）
 * - 残りの容疑者は屋内面積に応じた人数だけ味方 NPC として残す
 * - 本来の突入地点・隊員配置が SWAT の進入地点になる
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
  const kept = keepSuspectAllies(suspects, playerSuspectId, spawn, suspectAllyCount(suspects.length, indoorFloorArea(map.rooms)));
  const keptIds = new Set(kept.map((s) => s.id));
  const civilians = map.entities.filter((e) => e.type === 'civilian').length;
  const allyLine = kept.length > 0 ? `仲間の容疑者 ${kept.length} 名が同じ建物にいる。` : '';
  const summary =
    'あなたは立てこもり犯だ。' +
    allyLine +
    `まもなく SWAT ${SUSPECT_MODE.swatCount} 名が入口から突入してくる。` +
    `突入から ${Math.round(SUSPECT_MODE.holdSec / 60)} 分間持ちこたえるか、SWAT を全員無力化せよ。` +
    '武器は弾数の少ない改造フルオート拳銃のみ。突入前の交渉で時間を稼いだり、人質と防弾チョッキ・弾薬を交換できる。' +
    'ドアを施錠（F 長押し）し、人質を盾に連れ回せ（民間人の前で F 長押し）。民間人が射線上にいる間、SWAT は発砲できない。';
  return {
    map: {
      ...map,
      playerSpawn: spawn,
      entities: map.entities.filter((e) => e.type !== 'suspect' || keptIds.has(e.id)),
      allies: [],
      briefing: {
        estimatedHostages: { min: civilians, max: civilians },
        estimatedSuspects: { min: SUSPECT_MODE.swatCount, max: SUSPECT_MODE.swatCount },
        summary,
      },
    },
    swatSpawns,
  };
}

/** プレイヤー枠を除き、開始位置に近い容疑者から allyN 人を残す。 */
function keepSuspectAllies(
  suspects: readonly EntityDef[],
  playerSuspectId: string | null,
  spawn: PlayerSpawn,
  allyN: number,
): EntityDef[] {
  if (allyN <= 0) return [];
  return suspects
    .filter((s) => s.id !== playerSuspectId)
    .sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z))
    .slice(0, allyN);
}

/** 容疑者が使える武器（faction='suspect' の改造拳銃のみ。非致死性装備・SWAT 装備は無し） */
export function suspectWeapons(defs: readonly WeaponDef[]): WeaponDef[] {
  const own = defs.filter((w) => w.faction === 'suspect');
  return own.length > 0 ? own : defs.filter((w) => w.category === 'primary');
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
  private elapsed = 0;
  private assaultAt: number = SUSPECT_MODE.prepSec;
  private ended = false;
  private endingIn = -1;
  private outcome: SuspectOutcome | null = null;
  private readonly entries: { time: number; label: string; points: number }[] = [];
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
        label: (d) =>
          d.locked
            ? 'ドア: 施錠中（F 長押しで解錠）'
            : d.angle > 1 || d.targetAngle > 1
              ? 'ドア: F 開閉 / ホイール 段階'
              : 'ドア: F 開閉 / F 長押しで施錠',
        onPress: () => {
          this.lockDone = false;
        },
        onHold: (d, _dt, sec) => {
          if (this.lockDone || sec < TAP_SEC) return;
          const closed = d.angle <= 1 && d.targetAngle <= 1;
          if (!closed && !d.locked) return; // 開いているドアは施錠できない（タップ扱い）
          this.showGauge(d.locked ? '解錠中...' : '施錠中...', (sec - TAP_SEC) / (LOCK_HOLD_SEC - TAP_SEC));
          if (sec >= LOCK_HOLD_SEC) {
            this.lockDone = true;
            d.locked = !d.locked;
            this.subtitle.show(d.locked ? 'ドアを施錠した（SWAT はブリーチが必要）' : 'ドアの施錠を解除した', 1.6);
          }
        },
        onRelease: (d, sec) => {
          if (!this.lockDone && sec < TAP_SEC && !d.locked) {
            d.toggle(true, this.player.position.x, this.player.position.z);
          }
          this.lockDone = false;
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
        if (c && !c.alive && !this.entries.some((x) => x.label === `民間人殺害 (${e.targetId})`)) {
          this.entries.push({ time: this.elapsed, label: `民間人殺害 (${e.targetId})`, points: -400 });
        }
      }),
    );
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
        this.subtitle.show('SWAT が突入を開始した！', 2.5);
      }
    } else if (this.player.alive && this.input.isDown('warningCall')) {
      // Space 長押し: 両手を上げて投降
      this.surrenderHold += dt;
      this.showGauge('両手を上げて投降...', this.surrenderHold / SURRENDER_HOLD_SEC);
      if (this.surrenderHold >= SURRENDER_HOLD_SEC) {
        this.subtitle.show('容疑者「わかった、投降する！撃つな！」', 2.0);
        this.conclude('arrested', 1.2);
      }
    } else {
      this.surrenderHold = 0;
    }
    this.flushGauge();

    if (!this.player.alive) this.conclude('killed', 1.4);
    else if (this.team.hasStarted && this.team.aliveCount === 0) this.conclude('repelled', 2.0);
    else if (this.team.hasStarted && this.holdLeft <= 0) {
      this.subtitle.show('SWAT「撤退だ！包囲を維持しろ！」', 2.0);
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
        repelled: 'SWAT 撃退！',
        survived: '籠城成功 — SWAT が撤退していく',
        killed: '制圧された...',
        arrested: '投降 — 拘束される...',
      };
      text = labels[this.outcome ?? 'killed'];
    } else if (!this.team.hasStarted) {
      text = `SWAT 突入まで ${fmt(this.assaultAt - this.elapsed)}　|　F 長押しでドア施錠 / Space で準備完了`;
    } else {
      text = `籠城 残り ${fmt(this.holdLeft)}　|　SWAT 残り ${this.team.aliveCount}/${this.team.total}`;
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
    if (kills > 0) entries.push({ time: this.elapsed, label: `SWAT 無力化 ×${kills}`, points: kills * 500 });
    entries.push({ time: this.elapsed, label: `生存時間 ${fmt(survived)}`, points: Math.round(survived * 2) });
    const bonus: Record<SuspectOutcome, number> = { repelled: 1500, survived: 1000, killed: 0, arrested: 200 };
    if (bonus[o] > 0) entries.push({ time: this.elapsed, label: o === 'repelled' ? '撃退ボーナス' : o === 'survived' ? '籠城成功ボーナス' : '投降（生存）', points: bonus[o] });
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
      repelled: '突入した SWAT を全員無力化した。',
      survived: `${fmt(SUSPECT_MODE.holdSec)} 間の籠城に成功し、SWAT は撤退した。`,
      killed: 'SWAT に制圧された。施錠ドア・遮蔽物・静音移動・民間人を活用しよう。',
      arrested: '投降して身柄を拘束された。',
    };
    const report: ResultReport = {
      title: titles[o][0],
      titleColor: titles[o][1],
      subtitle: subs[o],
      subtitleGood: !failed,
      scoreText: `総合スコア ${total}`,
      rankText: o === 'killed' ? 'FAILED' : `RANK ${rank}`,
      rankColor: o === 'killed' ? '#ff6b6b' : '#ffd24d',
      stats: [
        ['生存時間（突入後）', fmt(survived)],
        ['SWAT 無力化', `${kills} / ${this.team.total}`],
        ['発砲数', String(this.shotsFired)],
        ['被弾数', String(this.hitsTaken)],
        ['残り HP', String(Math.round(this.player.hp))],
        ['民間人死亡', String(deadCivs)],
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
