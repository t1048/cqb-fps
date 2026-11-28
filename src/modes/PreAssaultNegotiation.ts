import type { Civilian } from '../ai/Civilian';
import type { Suspect } from '../ai/Suspect';
import { SuspectState } from '../core/events';
import { t, tRoomName } from '../core/i18n';
import type { SuspectAlertConfig } from '../core/types';
import { negotiationAlertBaseline, type NegotiationAlertInfo } from '../ai/SuspectAlert';
import type {
  NegotiationLine,
  NegotiationOption,
  NegotiationPlanItem,
  NegotiationRequirement,
  NegotiationScenario,
} from '../ui/NegotiationPhase';
import type { SuspectNegotiationCardId, SwatNegotiationCardId } from '../rules/Progression';

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

/**
 * 交渉から操作できる建物の電源（rules/Power.ts の PowerGrid を main が包む）。
 * 交渉で止める・戻すのは外部の供給（utility）。屋内の配電盤のブレーカーは突入後に現地で操作する。
 */
export interface NegotiationPowerCtl {
  /** いま屋内の照明が点いているか（外部・ブレーカーの両方が入っている） */
  isOn(): boolean;
  /** 外部の供給が入っているか */
  utilityOn(): boolean;
  cutUtility(): void;
  restoreUtility(): void;
  /** 配電盤のある部屋（表示用） */
  panelRoom(): string | null;
}
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ======================================================================
// 容疑者モード: 自分（立てこもり犯）が SWAT の交渉人と取引する
// ======================================================================

export interface SuspectNegotiationContext {
  /** 交渉材料になる人質（生存・未解放・未拘束） */
  hostages(): Civilian[];
  releaseHostage(c: Civilian): void;
  /** 準備時間（突入までの秒数）を加算 */
  addPrep(sec: number): void;
  /** 交渉決裂: 準備時間を短縮して即突入 */
  breakdown(): void;
  prepSec(): number;
  /** 防弾チョッキを渡す（耐久値は player.json の armor.suspectVest） */
  giveArmor(): void;
  hasArmor(): boolean;
  /** 防弾チョッキの仕様（説明文を設定値から作るため） */
  vestSpec(): { durability: number; absorbPct: number; speedMul: number; footstepRadiusMul: number; leanSpeedMul: number };
  giveMagazines(n: number): void;
  /** 救急キットを n 個渡す（容疑者モードだけ） */
  giveMedkit(n: number): void;
  /** 救急キットの仕様（説明文を設定値から作るため） */
  medkitSpec(): { holdSec: number; heal: number; tradeCount: number };
  /** 突入班を 1 名下げさせる。成功で true */
  withdrawSwat(): boolean;
  swatCount(): number;
  /** 仲間の容疑者 NPC（士気が上がると投降しにくく、粘り強く戦う） */
  allies(): Suspect[];
  /** 現在の消耗（0..100） */
  fatigue(): number;
  setFatigue(v: number): void;
  /** 差し入れの後の値（siege.supplyFatigue） */
  supplyFatigue(): number;
  /** 籠城 N 時間目（siege.startHour） */
  siegeHour(): number;
  /** 消耗の段階（表示の色分け用。siege.player.tiers に従う） */
  fatigueTier(): 0 | 1 | 2;
  /** 差し入れに乗じて偵察された（突入時に SWAT がプレイヤーの部屋を知る） */
  markScouted(): void;
  /** 進行度に応じたカード解放マップ（省略時は全解放） */
  unlockedCards?: Partial<Record<SuspectNegotiationCardId, boolean>>;
  /** 建物の電源（未指定なら電源まわりの選択肢・イベントは出ない） */
  power?: NegotiationPowerCtl;
  /** SWAT が突入と同時に電源を落とす確率（交渉の状況で変わる。突入時に main が判定する） */
  setBreachBlackoutChance?(p: number): void;
}

const FATIGUE_COLORS = ['#5cd67d', '#f2c14e', '#ff5555'] as const;

/**
 * 時間稼ぎ・水食料の要求・人質交換（防弾チョッキ / 弾薬 / 時間）・脅迫。
 * SWAT 側の「忍耐」が 0 になると交渉決裂で即突入。人質を手放すほど盾が減るトレードオフ。
 */
export function buildSuspectNegotiation(ctx: SuspectNegotiationContext): NegotiationScenario {
  let patience = 100;
  const MAX_TURNS = 7;
  let turns = MAX_TURNS;
  let broken = false;
  /** SWAT が交渉の圧力として電源を止めたか（1 回だけ） */
  let swatCutPower = false;
  /** 選択肢の結果のあとに割り込む SWAT 側の出来事（電源遮断など） */
  const events: NegotiationLine[] = [];
  const power = ctx.power;
  let stallCount = 0;
  const released: string[] = [];
  const gains: string[] = [];
  let rallyCount = 0;
  let suppliesReceived = false;
  let medkitReceived = false;
  const activeAllies = (): Suspect[] =>
    ctx.allies().filter((s) => s.alive && s.state !== SuspectState.SURRENDER && s.state !== SuspectState.ARRESTED);
  const teamMorale = (): number => {
    const a = activeAllies();
    return a.length === 0 ? 0 : a.reduce((sum, s) => sum + s.morale.value, 0) / a.length;
  };
  const shiftMorale = (d: number): void => {
    for (const s of activeAllies()) s.adjustMorale(d);
  };

  /** 突入と同時に SWAT が電源を落とす確率: 忍耐が減るほど強硬になる。すでに停電中なら 0 */
  const breachBlackoutChance = (): number =>
    !power || !power.isOn() ? 0 : clamp(0.3 + (100 - patience) / 200, 0.3, 0.8);
  const notifyBlackout = (): void => ctx.setBreachBlackoutChance?.(breachBlackoutChance());
  notifyBlackout();

  const spend = (dp: number): void => {
    turns--;
    patience = clamp(patience + dp, 0, 100);
    if (patience <= 0 && !broken) {
      broken = true;
      ctx.breakdown();
    }
    // 忍耐が半分を切ると、交渉人は電気を止めて圧力をかけてくる（実務のユーティリティ・コントロール）
    if (!broken && power && !swatCutPower && patience < 55 && power.utilityOn()) {
      swatCutPower = true;
      power.cutUtility();
      ctx.setFatigue(ctx.fatigue() + 10);
      events.push(
        {
          text: t(
            '交渉人「話が進まないなら、こちらにも考えがある」 — 建物の電気が止められた',
            'Negotiator: "If we\'re not getting anywhere, we have options too." — The building\'s power was cut.',
          ),
          tone: 'them',
        },
        {
          text: t(
            `停電: 冷房もテレビも止まった。消耗 +10（${Math.round(ctx.fatigue())}）。暗闇では V でライト`,
            `Blackout: AC and TV are dead. Fatigue +10 (${Math.round(ctx.fatigue())}). Press V for your flashlight in the dark.`,
          ),
          tone: 'bad',
        },
      );
    }
    notifyBlackout();
  };
  const breakdownLines = (): NegotiationLine[] => [...events.splice(0), ...(
    broken
      ? [
          {
            text: t(
              '交渉人「……交渉は終わりだ。突入班、配置につけ」 — 交渉決裂。SWAT がまもなく突入する！',
              'Negotiator: "...Negotiations are over. Entry team, move into position." — Talks broke down. SWAT is breaching soon!',
            ),
            tone: 'bad' as const,
            critical: true,
          },
        ]
      : [])];
  /** 忍耐が dp 下がると決裂するときの警告 */
  const patienceWarn = (dp: number): string | undefined =>
    patience + dp <= 0
      ? t(
          '交渉人の忍耐が尽きて交渉決裂（即突入）になる',
          "Negotiator's patience will run out — talks break down (immediate breach)",
        )
      : undefined;
  const hostageCost = (): string[] => [
    t('人質 -1', 'Hostage -1'),
    ...(activeAllies().length > 0 ? [t('仲間の士気 -10', 'Crew Morale -10')] : []),
  ];
  const stallChance = (): number => clamp(patience / 110 - stallCount * 0.15, 0.1, 0.9);
  const rallyChance = (): number => clamp(0.55 + patience / 250, 0.4, 0.9);
  const rallyGain = (): number => [22, 14, 8][rallyCount] ?? 8;
  const threatChance = (): number => clamp(0.35 + ctx.hostages().length * 0.05, 0, 1);
  const needHostage = (): string | null =>
    ctx.hostages().length === 0 ? t('交換できる人質がいない', 'No hostages left to trade') : null;
  const trade = (gain: string, apply: () => void, dp: number, theirLine: string): NegotiationLine[] => {
    const h = ctx.hostages()[0]!;
    ctx.releaseHostage(h);
    released.push(h.id);
    apply();
    gains.push(gain);
    spend(dp);
    const hasAllies = activeAllies().length > 0;
    if (hasAllies) shiftMorale(-10);
    return [
      {
        text: t(
          `あなた「人質を 1 人解放する。代わりに${gain}をよこせ」`,
          `You: "I'll release one hostage. In return, give me ${gain}."`,
        ),
        tone: 'me',
      },
      { text: theirLine, tone: 'them' },
      {
        text: t(
          `人質 1 名を解放 → ${gain}を入手（残りの人質 ${ctx.hostages().length} 名）`,
          `Released 1 hostage → Received ${gain} (${ctx.hostages().length} hostages left)`,
        ),
        tone: 'good',
      },
      ...(hasAllies
        ? [
            {
              text: t(
                '仲間「おい、切り札を手放してどうする……」 — 仲間の士気 -10',
                'Crew: "Hey, why are you giving up our leverage...?" — Crew Morale -10',
              ),
              tone: 'bad' as const,
            },
          ]
        : []),
      ...breakdownLines(),
    ];
  };

  const options: NegotiationOption[] = [
    {
      group: 'time',
      icon: '⏳',
      label: t('時間稼ぎ', 'Stall for Time'),
      desc: t(
        '車やヘリを要求して引き延ばす。稼いだ時間で仲間が窓を塞ぎ・武器を改造し・トラップを作る。繰り返すほど見抜かれやすい',
        'Demand a getaway car or chopper to buy time. Your crew boards windows, mods weapons, and rigs traps. Harder to pull off repeatedly.',
      ),
      chance: stallChance,
      effects: () => ({
        gain: [t('準備時間 +25秒', 'Prep Time +25s'), t('仲間の士気 +4', 'Crew Morale +4')],
        cost: [t('忍耐 -12', 'Patience -12')],
        fail: [t('忍耐 -30', 'Patience -30')],
        warn: patienceWarn(-30),
      }),
      disabledReason: () => null,
      run: () => {
        const chance = stallChance();
        stallCount++;
        const lines: NegotiationLine[] = [
          {
            text: t(
              `あなた「${pick(['逃走用の車を用意しろ。満タンでだ', '弁護士とテレビ局を呼べ', 'ヘリを屋上に回せ、話はそれからだ'])}」`,
              `You: "${pick([
                'Get me a getaway car, full tank.',
                'Bring a lawyer and the press out here.',
                'Put a chopper on the roof, then we talk.',
              ])}"`,
            ),
            tone: 'me',
          },
        ];
        if (Math.random() < chance) {
          ctx.addPrep(25);
          spend(-12);
          shiftMorale(4);
          lines.push({
            text: t(
              '交渉人「……わかった、手配に時間がかかる。少し待ってくれ」',
              'Negotiator: "...Understood, it takes time to arrange. Hold tight."',
            ),
            tone: 'them',
          });
          lines.push({
            text: t(
              `時間稼ぎ成功: 突入まで ${Math.round(ctx.prepSec())} 秒${activeAllies().length > 0 ? '（その間に仲間が窓の補強・武器の改造・トラップ作りを進める）' : ''}`,
              `Stalled successfully: ${Math.round(ctx.prepSec())}s until breach${activeAllies().length > 0 ? ' (crew fortifies windows, mods weapons, and sets traps)' : ''}`,
            ),
            tone: 'good',
          });
        } else {
          spend(-30);
          lines.push({
            text: t(
              '交渉人「時間稼ぎなのはわかっている。いい加減にしろ」',
              'Negotiator: "We know you\'re stalling. Cut the games."',
            ),
            tone: 'them',
          });
          lines.push({
            text: t('見抜かれた: 交渉人の忍耐が大きく低下', "Bluff called: Negotiator's patience dropped sharply"),
            tone: 'bad',
          });
        }
        return [...lines, ...breakdownLines()];
      },
    },
    {
      group: 'time',
      icon: '💧',
      label: t('水・食料を要求', 'Demand Food & Water'),
      desc: t(
        '何時間も飲まず食わずだ。差し入れであなたと仲間の消耗が回復する。ただし差し入れに偵察機材を仕込まれ、突入時に SWAT にあなたの居場所を知られる',
        "You've gone hours without food or water. Supplies restore fatigue for you and your crew, but the delivery is bugged: at breach, SWAT will know which room you're in.",
      ),
      effects: () => ({
        gain: [
          t(`消耗 ${Math.round(ctx.fatigue())}→${Math.round(ctx.supplyFatigue())}`, `Fatigue ${Math.round(ctx.fatigue())}→${Math.round(ctx.supplyFatigue())}`),
          t('忍耐 +5', 'Patience +5'),
        ],
        cost: [
          t(
            '偵察される（突入時、SWAT があなたのいる部屋を把握）',
            'Scouted (at breach, SWAT knows the room you are in)',
          ),
        ],
      }),
      disabledReason: () => (suppliesReceived ? t('差し入れはもう受け取った', 'Supplies already received') : null),
      run: () => {
        suppliesReceived = true;
        ctx.setFatigue(ctx.supplyFatigue());
        ctx.markScouted();
        spend(+5);
        gains.push(t('水・食料', 'Food & Water'));
        const v = Math.round(ctx.fatigue());
        return [
          {
            text: t('あなた「水と食い物をよこせ。話はそれからだ」', 'You: "Food and water. Then we talk."'),
            tone: 'me',
          },
          {
            text: t('交渉人「……いいだろう。玄関前に置く」', 'Negotiator: "...Fine. We\'ll leave it at the front door."'),
            tone: 'them',
          },
          { text: t(`消耗が ${v} に回復した`, `Fatigue recovered to ${v}`), tone: 'good' },
          {
            text: t('（差し入れの袋に何か仕込まれていないか……）', '(Is there something hidden in that bag...?)'),
            tone: 'bad',
          },
          ...breakdownLines(),
        ];
      },
    },
    {
      group: 'time',
      icon: '💡',
      label: t('電気を戻せと要求', 'Demand Power Back'),
      desc: t(
        '止められた電気を戻させる。突入まで明るいままなら暗闇で不利にならないが、交渉人は渋る。屋内の配電盤のブレーカーでは、外から止められた電気は戻らない',
        'Make them turn the power back on. Staying lit means the dark won\'t work against you, but the negotiator resists. Flipping the indoor breaker can\'t undo a cut from outside.',
      ),
      chance: () => clamp(0.25 + patience / 130, 0.15, 0.85),
      effects: () => ({
        gain: [t('電気が戻る', 'Power restored')],
        cost: [t('忍耐 -8', 'Patience -8')],
        fail: [t('忍耐 -18', 'Patience -18')],
        warn: patienceWarn(-18),
      }),
      disabledReason: () =>
        !power ? t('電源は操作できない', 'Power cannot be controlled') : power.utilityOn() ? t('電気は止められていない', 'Power has not been cut') : null,
      run: () => {
        const chance = clamp(0.25 + patience / 130, 0.15, 0.85);
        const lines: NegotiationLine[] = [
          {
            text: t('あなた「電気を戻せ。人質が暑さでぶっ倒れても知らねえぞ」', 'You: "Turn the power back on. If the hostages pass out from the heat, that\'s on you."'),
            tone: 'me',
          },
        ];
        if (Math.random() < chance) {
          power!.restoreUtility();
          spend(-8);
          gains.push(t('電気の復旧', 'Power restored'));
          lines.push(
            { text: t('交渉人「……わかった。人質のためだ」', 'Negotiator: "...Fine. For the hostages\' sake."'), tone: 'them' },
            { text: t('電気が戻った', 'Power is back on'), tone: 'good' },
          );
        } else {
          spend(-18);
          lines.push(
            { text: t('交渉人「電気は、人質を出してからの話だ」', 'Negotiator: "Power comes after you release someone."'), tone: 'them' },
            { text: t('拒否された: 忍耐が低下', 'Refused: Patience dropped'), tone: 'bad' },
          );
        }
        return [...lines, ...breakdownLines()];
      },
    },
    {
      group: 'trade',
      icon: '🦺',
      label: t('人質と交換: 防弾チョッキ', 'Trade Hostage: Body Armor'),
      lockedReason:
        ctx.unlockedCards?.trade_vest === false ? t('容疑者 Lv.2 で解放', 'Unlocks at Suspect Lv.2') : undefined,
      desc: (() => {
        const v = ctx.vestSpec();
        const move = Math.round((1 - v.speedMul) * 100);
        const noise = Math.round((v.footstepRadiusMul - 1) * 100);
        return t(
          `被弾ダメージの ${v.absorbPct}% を肩代わり（耐久 ${v.durability}）。重いので移動 −${move}%・足音が ${noise}% 遠くまで届き・リーンが遅くなる。人質を手放すので盾が減り、仲間も動揺する`,
          `Absorbs ${v.absorbPct}% of incoming damage (${v.durability} durability). Heavy: move -${move}%, footsteps carry ${noise}% farther, slower leaning. Costs a hostage and shakes crew morale.`,
        );
      })(),
      effects: () => {
        const v = ctx.vestSpec();
        return {
          gain: [t('防弾チョッキ', 'Body Armor'), t('忍耐 +8', 'Patience +8')],
          cost: [
            ...hostageCost(),
            t(`移動 −${Math.round((1 - v.speedMul) * 100)}%`, `Move -${Math.round((1 - v.speedMul) * 100)}%`),
            t(
              `足音 +${Math.round((v.footstepRadiusMul - 1) * 100)}%・リーン遅く`,
              `Footsteps +${Math.round((v.footstepRadiusMul - 1) * 100)}%, slower lean`,
            ),
          ],
        };
      },
      disabledReason: () =>
        needHostage() ?? (ctx.hasArmor() ? t('すでに防弾チョッキを受け取った', 'Already received body armor') : null),
      run: () =>
        trade(
          t('防弾チョッキ', 'Body Armor'),
          () => ctx.giveArmor(),
          +8,
          t(
            '交渉人「……いいだろう。玄関前に置く。人質を先に出せ」',
            'Negotiator: "...Fine. Leaving it by the front door. Send the hostage out first."',
          ),
        ),
    },
    {
      group: 'trade',
      icon: '🔫',
      label: t('人質と交換: 弾薬', 'Trade Hostage: Ammo'),
      desc: t(
        '予備マガジン 2 本を受け取る。人質を手放すので盾が減り、仲間も動揺する',
        'Receive 2 spare magazines. Costs a hostage and shakes crew morale.',
      ),
      effects: () => ({
        gain: [t('予備マガジン +2', 'Spare Mags +2'), t('忍耐 +5', 'Patience +5')],
        cost: hostageCost(),
      }),
      disabledReason: needHostage,
      run: () =>
        trade(
          t('予備マガジン 2 本', '2 Spare Magazines'),
          () => ctx.giveMagazines(2),
          +5,
          t(
            '交渉人「弾を渡すのは本意じゃないが……人質の安全が優先だ」',
            'Negotiator: "I hate handing over ammo... but the hostage\'s life comes first."',
          ),
        ),
    },
    {
      group: 'trade',
      icon: '⛑',
      label: t('人質と交換: 救急キット', 'Trade Hostage: Medkit'),
      desc: (() => {
        const m = ctx.medkitSpec();
        return t(
          `救急キット ${m.tradeCount} 個（H を ${m.holdSec} 秒押し続けて HP +${m.heal}。使っている間は撃てず、歩きになる）。人質を手放すので盾が減り、仲間も動揺する`,
          `Receive ${m.tradeCount} medkit(s) (hold H for ${m.holdSec}s to heal ${m.heal} HP; you can't shoot and move at walking speed while using it). Costs a hostage and shakes crew morale.`,
        );
      })(),
      effects: () => {
        const m = ctx.medkitSpec();
        return {
          gain: [t(`救急キット ×${m.tradeCount}`, `Medkit ×${m.tradeCount}`), t('忍耐 +5', 'Patience +5')],
          cost: hostageCost(),
        };
      },
      disabledReason: () =>
        needHostage() ?? (medkitReceived ? t('救急キットはもう受け取った', 'Medkit already received') : null),
      run: () =>
        trade(
          t('救急キット', 'Medkit'),
          () => {
            medkitReceived = true;
            ctx.giveMedkit(ctx.medkitSpec().tradeCount);
          },
          +5,
          t(
            '交渉人「……医療品なら渡そう。人質が先だ」',
            'Negotiator: "...Medical supplies we can do. The hostage comes out first."',
          ),
        ),
    },
    {
      group: 'trade',
      icon: '⏱',
      label: t('人質と交換: 時間', 'Trade Hostage: Time'),
      desc: t(
        '人質を解放する代わりに突入を待たせる（確実に時間を稼げる）',
        'Release a hostage in exchange for delaying the breach (guaranteed time).',
      ),
      effects: () => ({
        gain: [t('準備時間 +40秒', 'Prep Time +40s'), t('忍耐 +15', 'Patience +15')],
        cost: hostageCost(),
      }),
      disabledReason: needHostage,
      run: () =>
        trade(
          t('準備時間 +40 秒', 'Prep Time +40s'),
          () => ctx.addPrep(40),
          +15,
          t(
            '交渉人「誠意は受け取った。こちらも待とう」',
            'Negotiator: "Good faith noted. We\'ll hold off for now."',
          ),
        ),
    },
    {
      group: 'press',
      icon: '📣',
      label: t('強気の要求で仲間を鼓舞', 'Rally Crew with Bold Demands'),
      lockedReason:
        ctx.unlockedCards?.rally === false ? t('容疑者 Lv.2 で解放', 'Unlocks at Suspect Lv.2') : undefined,
      desc: t(
        '通話を仲間に聞かせて奮い立たせる。士気が高い仲間は投降しにくく粘り強く戦う。繰り返すほど効果は薄れる',
        'Let your crew hear you stand firm. High-morale allies resist surrender and fight harder. Diminishing returns.',
      ),
      chance: rallyChance,
      effects: () => ({
        gain: [t(`仲間の士気 +${rallyGain()}`, `Crew Morale +${rallyGain()}`)],
        cost: [t('忍耐 -10', 'Patience -10')],
        fail: [
          t(`仲間の士気 +${Math.round(rallyGain() / 3)} のみ`, `Crew Morale +${Math.round(rallyGain() / 3)} only`),
          t('忍耐 -20', 'Patience -20'),
        ],
        warn: patienceWarn(-20),
      }),
      disabledReason: () =>
        activeAllies().length === 0
          ? t('鼓舞する仲間がいない', 'No active crew to rally')
          : rallyCount >= 3
            ? t('仲間はもう十分に奮い立っている', 'Crew is already fully fired up')
            : null,
      run: () => {
        const gain = rallyGain();
        rallyCount++;
        const lines: NegotiationLine[] = [
          {
            text: t(
              `あなた「${pick(['俺たちは本気だ。全員で最後までやる', '仲間の家族と話をさせろ。それまで一歩も引かない', '聞こえたか、お前ら！ 警察は手出しできねえ！'])}」`,
              `You: "${pick([
                "We're not bluffing. We see this through together!",
                "Let my crew call their families. We don't budge till then!",
                "Hear that, boys?! The cops can't touch us!",
              ])}"`,
            ),
            tone: 'me',
          },
        ];
        if (Math.random() < rallyChance()) {
          shiftMorale(gain);
          spend(-10);
          gains.push(t('仲間の士気↑', 'Crew Morale ↑'));
          lines.push({
            text: t(
              '交渉人「……落ち着いてくれ。誰の家族だ？ 連絡を取ってみる」',
              'Negotiator: "...Calm down. Whose family? Let me try to reach them."',
            ),
            tone: 'them',
          });
          lines.push({
            text: t(
              `仲間「よし……やってやる！」 — 仲間の士気 +${gain}（平均 ${Math.round(teamMorale())}）`,
              `Crew: "Alright... let's do this!" — Crew Morale +${gain} (avg ${Math.round(teamMorale())})`,
            ),
            tone: 'good',
          });
        } else {
          shiftMorale(Math.round(gain / 3));
          spend(-20);
          lines.push({
            text: t(
              '交渉人「虚勢を張っても状況は変わらない」',
              'Negotiator: "Bluster won\'t change your situation."',
            ),
            tone: 'them',
          });
          lines.push({
            text: t(
              `仲間の士気 +${Math.round(gain / 3)} / 交渉人の忍耐が大きく低下`,
              `Crew Morale +${Math.round(gain / 3)} / Negotiator's patience dropped sharply`,
            ),
            tone: 'bad',
          });
        }
        return [...lines, ...breakdownLines()];
      },
    },
    {
      group: 'press',
      icon: '☠',
      label: t('脅迫して包囲を緩めさせる', 'Threaten to Pull Back Perimeter'),
      lockedReason:
        ctx.unlockedCards?.threaten === false ? t('容疑者 Lv.3 で解放', 'Unlocks at Suspect Lv.3') : undefined,
      desc: t(
        '人質の命を盾に突入班を下げさせる。人質が多いほど成功しやすい',
        'Use hostages as leverage to force SWAT to pull back an officer. More hostages improve odds.',
      ),
      chance: threatChance,
      effects: () => ({
        gain: [t('突入班 SWAT -1名', 'SWAT Entry -1')],
        cost: [t('忍耐 -25', 'Patience -25')],
        fail: [t('忍耐 -45', 'Patience -45')],
        warn: patienceWarn(-45),
      }),
      disabledReason: () =>
        ctx.hostages().length === 0
          ? t('人質がいないと脅せない', 'Need hostages to threaten')
          : ctx.swatCount() <= 3
            ? t('これ以上は下げさせられない', 'Cannot pull back any more officers')
            : null,
      run: () => {
        const lines: NegotiationLine[] = [
          {
            text: t(
              'あなた「建物の周りの連中を下げろ。さもないと人質がどうなるか分かってるな」',
              'You: "Pull your guys off the perimeter, or the hostages pay for it."',
            ),
            tone: 'me',
          },
        ];
        if (Math.random() < threatChance() && ctx.withdrawSwat()) {
          spend(-25);
          lines.push({
            text: t('交渉人「……落ち着け。一部を下げる」', 'Negotiator: "...Easy. I\'ll pull some back."'),
            tone: 'them',
          });
          lines.push({
            text: t(
              `突入班が 1 名減った（SWAT ${ctx.swatCount()} 名）`,
              `Entry team reduced by 1 (${ctx.swatCount()} SWAT remaining)`,
            ),
            tone: 'good',
          });
          gains.push(t('SWAT -1 名', 'SWAT -1'));
        } else {
          spend(-45);
          lines.push({
            text: t('交渉人「脅しには屈しない」', 'Negotiator: "We don\'t cave to threats."'),
            tone: 'them',
          });
          lines.push({
            text: t('脅迫失敗: 交渉人の忍耐が激減', "Threat failed: Negotiator's patience plummeted"),
            tone: 'bad',
          });
        }
        return [...lines, ...breakdownLines()];
      },
    },
  ];

  return {
    title: t('立てこもり — SWAT 交渉人との通話', 'Standoff — Call with SWAT Negotiator'),
    subtitle: t(
      '突入前に SWAT の交渉人と取引できる。時間を稼げば仲間が窓を塞ぎ・武器を改造し・トラップを作る。強気の要求は仲間の士気を上げる。人質を差し出せば装備は得られるが、仲間は動揺し、盾も減る（盾にしても SWAT はペッパーボールで崩してくる）。交渉人の忍耐が尽きると即突入される。',
      'Bargain with the SWAT negotiator before the breach. Buying time lets your crew fortify windows, mod weapons, and rig traps. Bold demands raise crew morale. Trading hostages gets gear, but shakes your crew and reduces human shields (SWAT can still break shields with pepperballs). If patience hits 0, SWAT breaches immediately.',
    ),
    intro: [
      {
        text: t(
          '交渉人「こちらは警察だ。建物は完全に包囲されている。まずは話をしよう」',
          'Negotiator: "This is the police. The building is surrounded. Let\'s talk first."',
        ),
        tone: 'them',
      },
      {
        text: t(
          `状況: 籠城 ${ctx.siegeHour()} 時間目 / 消耗 ${Math.round(ctx.fatigue())} / 人質 ${ctx.hostages().length} 名 / 突入班 SWAT ${ctx.swatCount()} 名 / 突入まで ${Math.round(ctx.prepSec())} 秒`,
          `Status: Hour ${ctx.siegeHour()} of siege / Fatigue ${Math.round(ctx.fatigue())} / ${ctx.hostages().length} Hostages / ${ctx.swatCount()} SWAT / ${Math.round(ctx.prepSec())}s to breach`,
        ),
        tone: 'info',
      },
    ],
    meters: () => [
      {
        label: t('交渉人の忍耐', 'Negotiator Patience'),
        value: patience,
        max: 100,
        color: patience > 50 ? '#5cd67d' : patience > 25 ? '#f2c14e' : '#ff5555',
        hint: t('0 になると交渉決裂 → 即突入', 'Hits 0 → Talks break down (immediate breach)'),
      },
      {
        label: t(`消耗（籠城 ${ctx.siegeHour()} 時間目）`, `Fatigue (Hour ${ctx.siegeHour()})`),
        value: ctx.fatigue(),
        max: 100,
        color: FATIGUE_COLORS[ctx.fatigueTier()],
        text: `${Math.round(ctx.fatigue())}`,
        hint: t(
          '50 以上で照準が揺れ装填が遅い、75 以上で足も鈍る。あなたと仲間に効く',
          'From 50: aim sways, reloads slow. From 75: you slow down too. Affects you and your crew.',
        ),
      },
      {
        label: t('突入までの準備時間', 'Prep Time Before Breach'),
        value: ctx.prepSec(),
        max: 180,
        color: '#ffd24d',
        text: t(`${Math.round(ctx.prepSec())} 秒`, `${Math.round(ctx.prepSec())}s`),
        hint: t('長いほど籠城の準備が進む', 'More time to fortify your holdout'),
      },
      {
        label: t('人質', 'Hostages'),
        value: ctx.hostages().length,
        max: Math.max(1, ctx.hostages().length + released.length),
        color: '#f2a65a',
        text: t(`${ctx.hostages().length} 名`, `${ctx.hostages().length}`),
        hint: t('交換・脅迫の材料（盾にもなる）', 'Leverage for trades/threats (and human shields)'),
      },
      ...(ctx.allies().length > 0
        ? [
            {
              label: t('仲間の士気', 'Crew Morale'),
              value: teamMorale(),
              max: 100,
              color: teamMorale() >= 60 ? '#5cd67d' : teamMorale() >= 35 ? '#f2c14e' : '#ff5555',
              text: t(
                `${Math.round(teamMorale())}（${activeAllies().length} 名）`,
                `${Math.round(teamMorale())} (${activeAllies().length})`,
              ),
              hint: t('高いほど投降しにくく粘り強い', 'Higher morale resists surrender'),
            },
          ]
        : []),
    ],
    turnsLeft: () => (broken ? 0 : turns),
    maxTurns: MAX_TURNS,
    isOver: () => broken,
    options,
    groups: [
      { id: 'time', label: t('⏳ 時間と物資', '⏳ TIME & SUPPLIES'), hint: t('人質を手放さずに得る', 'Gain without giving up hostages') },
      { id: 'trade', label: t('🤝 人質と交換', '🤝 HOSTAGE TRADES'), hint: t('確実に得るが盾が減り、仲間が動揺する', 'Guaranteed, but fewer shields and shaken crew') },
      { id: 'press', label: t('☠ 圧力', '☠ PRESSURE'), hint: t('忍耐を大きく削る', 'Burns a lot of patience') },
    ],
    plan: {
      title: t('籠城プラン', 'HOLDOUT PLAN'),
      items: () => {
        const items: NegotiationPlanItem[] = [
          {
            icon: '⏱',
            label: t('突入まで', 'Breach in'),
            value: t(`${Math.round(ctx.prepSec())} 秒`, `${Math.round(ctx.prepSec())}s`),
            tone: 'info',
          },
        ];
        if (power) {
          const room = power.panelRoom();
          items.push(
            power.isOn()
              ? { icon: '💡', label: t('電源', 'Power'), value: t('通電中', 'On'), tone: 'good' }
              : { icon: '🌑', label: t('電源', 'Power'), value: t('停電中（外部から遮断）', 'Off (cut from outside)'), tone: 'bad' },
            {
              icon: '🔌',
              label: t('配電盤', 'Breaker'),
              value: room
                ? t(`${room}。F 長押しでブレーカーを落とす / 上げる`, `${room}. Hold F to flip the main breaker`)
                : t('なし', 'None'),
              tone: 'info',
            },
            power.isOn()
              ? {
                  icon: '⚠',
                  label: t('停電突入', 'Dark breach'),
                  value: t(
                    `SWAT が突入と同時に電源を落とす可能性 ${Math.round(breachBlackoutChance() * 100)}%`,
                    `${Math.round(breachBlackoutChance() * 100)}% chance SWAT kills the power as they breach`,
                  ),
                  tone: 'warn',
                }
              : {
                  icon: '🔦',
                  label: t('暗闇', 'Darkness'),
                  value: t(
                    'V でライト。照らせば見えるが位置がバレる。SWAT の暗視装置を照らすと目が眩む',
                    'V: flashlight. You see, but you give away your position. Shine it at SWAT night vision to dazzle them.',
                  ),
                  tone: 'warn',
                },
          );
        }
        if (suppliesReceived) {
          items.push({ icon: '📡', label: t('偵察', 'Scouted'), value: t('差し入れで居場所を知られている', 'SWAT knows your room'), tone: 'bad' });
        }
        return items;
      },
    },
    finishLabel: t('交渉を打ち切って籠城開始', 'End Call & Start Holdout'),
    summary: () => [
      broken
        ? t('交渉は決裂した。', 'Negotiations broke down.')
        : t('交渉は終了した。', 'Negotiations ended.'),
      t(
        `獲得: ${gains.length > 0 ? gains.join(' / ') : 'なし'}`,
        `Gained: ${gains.length > 0 ? gains.join(' / ') : 'None'}`,
      ),
      t(
        `解放した人質: ${released.length} 名 / 突入まで ${Math.round(ctx.prepSec())} 秒`,
        `Hostages released: ${released.length} / Breach in ${Math.round(ctx.prepSec())}s`,
      ),
    ],
  };
}

// ======================================================================
// SWAT モード: 自分（隊長＝交渉人）が立てこもり犯と交渉する
// ======================================================================

export interface SwatNegotiationContext {
  suspects(): Suspect[];
  hostages(): Civilian[];
  releaseHostage(c: Civilian): void;
  /** 人質が殺害された（交渉失敗） */
  executeHostage(c: Civilian): void;
  roomName(s: Suspect): string;
  /** 警戒度の設定（指定時は「突入時の警戒度予測」を表示し、結果を onOutcome で通知する） */
  alertCfg?: SuspectAlertConfig;
  /** 交渉の状態が変わるたびに呼ばれる（突入時の警戒度ベースラインと緊張など） */
  onOutcome?(info: NegotiationAlertInfo, baseline: number): void;
  /** 犯人の消耗（0..100） */
  fatigue(): number;
  setFatigue(v: number): void;
  supplyFatigue(): number;
  siegeHour(): number;
  /** 消耗の段階（表示の色分け用） */
  fatigueTier(): 0 | 1 | 2;
  /** 進行度に応じたカード解放マップ（省略時は全解放） */
  unlockedCards?: Partial<Record<SwatNegotiationCardId, boolean>>;
  /** 建物の電源（未指定なら電源まわりの選択肢は出ない） */
  power?: NegotiationPowerCtl & {
    /** 突入と同時に停電させるか（突入プランの切替） */
    breachBlackout(): boolean;
    setBreachBlackout(v: boolean): void;
  };
  /** スローフォンの盗聴器。plant は仕掛けた部屋名を返す */
  bug?: { plant(s: Suspect): string; planted(): boolean };
}

/**
 * 行動変化の階段モデル（FBI の BCSM）の 5 段階。信頼の値で段階が決まる。
 * 要求には必要な段階があり、段階を飛ばした要求は成功率が大きく下がる。
 */
export const BCSM_STEPS: readonly { at: number; ja: string; en: string; hintJa: string; hintEn: string }[] = [
  { at: 0, ja: '傾聴', en: 'Listening', hintJa: '相手の話を遮らずに聞く', hintEn: 'Let them talk without interrupting' },
  { at: 15, ja: '共感', en: 'Empathy', hintJa: '気持ちを言葉にして返す。内部の様子を聞ける', hintEn: 'Label their feelings. Interior intel opens up' },
  { at: 35, ja: '信頼関係', en: 'Rapport', hintJa: '人質の解放を頼める', hintEn: 'You can ask for hostage releases' },
  { at: 55, ja: '影響', en: 'Influence', hintJa: '投降という選択肢を示せる', hintEn: 'You can present surrender as an option' },
  { at: 75, ja: '行動変化', en: 'Behavior Change', hintJa: '投降・解放に応じやすい', hintEn: 'Ready to surrender or release' },
];
export const bcsmStage = (trust: number): number => {
  let i = 0;
  for (let k = 0; k < BCSM_STEPS.length; k++) if (trust >= BCSM_STEPS[k]!.at) i = k;
  return i;
};
/** 段階を飛ばした要求の成功率の倍率 */
export const BCSM_SKIP_MUL = 0.4;
/** 傾聴を繰り返したときの信頼の上がり幅 */
const LISTEN_GAINS = [14, 11, 8, 6] as const;

/**
 * 傾聴・信頼構築（差し入れ）・人質解放要求・電気と人質の取引・投降説得・情報収集・
 * スローフォン（盗聴器）・電気を止める・最後通告。
 * 犯人側の「緊張」が 100 に達すると人質が 1 名殺害され、交渉は決裂する。
 */
export function buildSwatNegotiation(ctx: SwatNegotiationContext): NegotiationScenario {
  let tension = 45;
  let trust = 10;
  const MAX_TURNS = 8;
  let turns = MAX_TURNS;
  let broken = false;
  let ultimatums = 0;
  let listens = 0;
  let bugTried = false;
  let bugRoom = '';
  const power = ctx.power;
  const stage = (): number => bcsmStage(trust);
  const stageName = (i: number): string => {
    const st = BCSM_STEPS[i]!;
    return t(st.ja, st.en);
  };
  /** 必要な段階に届いていないと成功率に BCSM_SKIP_MUL が掛かる */
  const gate = (need: number, base: number): number => (stage() >= need ? base : base * BCSM_SKIP_MUL);
  const requireStage = (need: number) => (): NegotiationRequirement => ({
    label: t(`段階「${stageName(need)}」から`, `From "${stageName(need)}"`),
    met: stage() >= need,
    note: t(`まだ早い: 成功率 ×${BCSM_SKIP_MUL}`, `Too early: odds ×${BCSM_SKIP_MUL}`),
  });
  const results: string[] = [];
  const alertInfo = (): NegotiationAlertInfo => ({ tension, trust, ultimatums, broken });
  const alertForecast = (): number => (ctx.alertCfg ? negotiationAlertBaseline(ctx.alertCfg, alertInfo()) : 0);
  const notifyOutcome = (): void => ctx.onOutcome?.(alertInfo(), alertForecast());
  notifyOutcome();

  const active = (): Suspect[] =>
    ctx.suspects().filter((s) => s.alive && s.state !== SuspectState.SURRENDER && s.state !== SuspectState.ARRESTED);
  const spend = (dTension: number, dTrust: number): NegotiationLine[] => {
    turns--;
    tension = clamp(tension + dTension, 0, 100);
    trust = clamp(trust + dTrust, 0, 100);
    if (tension >= 100 && !broken) {
      broken = true;
      notifyOutcome();
      const h = ctx.hostages()[0];
      if (h) {
        ctx.executeHostage(h);
        results.push(t('人質 1 名が殺害された', '1 hostage executed'));
        return [
          {
            text: t('犯人「もう我慢ならねえ！」 — 銃声が響いた', 'Suspect: "I\'ve had enough!" — A gunshot rings out.'),
            tone: 'them',
          },
          {
            text: t(
              '交渉決裂: 人質 1 名が殺害された。直ちに突入せよ',
              'Talks broke down: 1 hostage was executed. Breach immediately!',
            ),
            tone: 'bad',
            critical: true,
          },
        ];
      }
      return [
        {
          text: t('交渉決裂: 犯人が通話を切った', 'Talks broke down: Suspect hung up.'),
          tone: 'bad',
          critical: true,
        },
      ];
    }
    notifyOutcome();
    return [];
  };

  /** 緊張が dt 上がると人質が殺害されるときの警告 */
  const tensionWarn = (dt: number): string | undefined =>
    tension + dt >= 100
      ? ctx.hostages().length > 0
        ? t('緊張が限界を超えて人質が殺害される！', 'Tension will max out — a hostage will be executed!')
        : t('緊張が限界を超えて交渉決裂', 'Tension will max out — talks will break down')
      : undefined;
  const releaseChance = (): number => gate(2, clamp(0.25 + trust / 100 - tension / 220, 0.08, 0.92));
  const powerTradeChance = (): number => gate(1, clamp(0.55 + trust / 150 - tension / 300, 0.2, 0.92));
  const persuadeTarget = (): Suspect | undefined => active().sort((a, b) => a.morale.value - b.morale.value)[0];
  const persuadeChance = (target: Suspect): number =>
    gate(3, clamp(0.12 + trust / 140 + (60 - target.morale.value) / 200, 0.05, 0.8));
  const intelChance = (): number => gate(1, clamp(0.45 + trust / 200 - tension / 300, 0.15, 0.95));
  const bugChance = (): number => gate(1, clamp(0.5 + trust / 200 - tension / 250, 0.15, 0.9));
  const listenGain = (): number => LISTEN_GAINS[Math.min(listens, LISTEN_GAINS.length - 1)]!;

  const options: NegotiationOption[] = [
    {
      group: 'talk',
      icon: '👂',
      label: t('傾聴・共感（アクティブリスニング）', 'Active Listening'),
      desc: t(
        '要求には触れず、相手の気持ちを言葉にして返す。すぐには何も得られないが、緊張を下げて信頼を積み、段階を上げる。繰り返すほど伸びは鈍る',
        'Skip the demands and reflect their feelings back. No immediate gain, but it lowers tension and builds trust to climb the stairway. Diminishing returns.',
      ),
      effects: () => ({
        gain: [t('緊張 -8', 'Tension -8'), t(`信頼 +${listenGain()}`, `Trust +${listenGain()}`)],
      }),
      disabledReason: () => null,
      run: () => {
        const gain = listenGain();
        listens++;
        const before = stage();
        const lines: NegotiationLine[] = [
          {
            text: t(
              `あなた「${pick(['……ずいぶん追い詰められているように聞こえる', '誰もあんたの話を聞いてこなかったんだな', 'こうなるまでに、何があったのか聞かせてくれ'])}」`,
              `You: "${pick([
                'Sounds like you\'re feeling cornered.',
                'Seems like nobody\'s been listening to you.',
                'Tell me what happened that led to this.',
              ])}"`,
            ),
            tone: 'me',
          },
          {
            text: t(
              `犯人「${pick(['……ああ、そうだよ。誰も聞きやしねえ', 'あんたに何がわかる……いや、少しはわかるのか', '……長い話になるぞ'])}」`,
              `Suspect: "${pick(['...Yeah. Nobody ever listens.', 'What do you know... well, maybe you get it.', '...It\'s a long story.'])}"`,
            ),
            tone: 'them',
          },
          { text: t(`緊張 -8 / 信頼 +${gain}`, `Tension -8 / Trust +${gain}`), tone: 'info' },
        ];
        const out = spend(-8, +gain);
        if (stage() > before) {
          lines.push({
            text: t(`段階が「${stageName(stage())}」に上がった`, `Stairway advanced to "${stageName(stage())}"`),
            tone: 'good',
          });
        }
        return [...lines, ...out];
      },
    },
    {
      group: 'talk',
      icon: '🥪',
      label: t('信頼構築（食料・水を差し入れ）', 'Build Trust (Send Food & Water)'),
      desc: t(
        '場を落ち着かせて信頼を築く。信頼は他の交渉の成功率を上げる。ただし犯人は休息で士気が少し回復し、食事で消耗が回復して、狙いと反応が戻る',
        'De-escalate and build trust, boosting odds on other options. Suspects recover a little morale, and rest and food restore their fatigue so their aim and reactions recover.',
      ),
      effects: () => ({
        gain: [t('緊張 -15', 'Tension -15'), t('信頼 +20', 'Trust +20')],
        cost: [
          t('犯人の士気 +4', 'Suspect Morale +4'),
          ...(ctx.fatigue() > ctx.supplyFatigue()
            ? [
                t(
                  `犯人の消耗 ${Math.round(ctx.fatigue())}→${Math.round(ctx.supplyFatigue())}（手強くなる）`,
                  `Suspect Fatigue ${Math.round(ctx.fatigue())}→${Math.round(ctx.supplyFatigue())} (tougher)`,
                ),
              ]
            : []),
        ],
      }),
      disabledReason: () => null,
      run: () => {
        for (const s of active()) s.adjustMorale(4);
        const fatigueBefore = Math.round(ctx.fatigue());
        const recovered = ctx.fatigue() > ctx.supplyFatigue();
        if (recovered) ctx.setFatigue(ctx.supplyFatigue());
        const fatigueAfter = Math.round(ctx.fatigue());
        return [
          {
            text: t(
              'あなた「食料と水を玄関前に置く。誰も傷つけないでくれ」',
              'You: "Leaving food and water by the front door. Don\'t hurt anyone."',
            ),
            tone: 'me',
          },
          {
            text: t('犯人「……わかった。変な真似はするなよ」', 'Suspect: "...Alright. Don\'t try anything funny."'),
            tone: 'them',
          },
          {
            text: t('緊張 -15 / 信頼 +20（犯人の士気 +4）', 'Tension -15 / Trust +20 (Suspect Morale +4)'),
            tone: 'info',
          },
          ...(recovered
            ? [
                {
                  text: t(
                    `犯人の消耗が ${fatigueBefore}→${fatigueAfter} に回復した（狙いと反応が戻る）`,
                    `Suspect fatigue recovered ${fatigueBefore}→${fatigueAfter} (aim and reactions recover)`,
                  ),
                  tone: 'info' as const,
                },
              ]
            : []),
          ...spend(-15, +20),
        ];
      },
    },
    {
      group: 'ask',
      requires: requireStage(2),
      icon: '🧍',
      label: t('人質の解放を要求', 'Demand Hostage Release'),
      desc: t(
        '解放された人質は保護として加点。信頼が高く緊張が低いほど成功しやすい',
        'Released hostages count as secured for bonus points. High trust and low tension improve odds.',
      ),
      chance: releaseChance,
      effects: () => ({
        gain: [t('人質 1名 救出', 'Rescue 1 Hostage')],
        cost: [t('緊張 +5', 'Tension +5'), t('信頼 -10', 'Trust -10')],
        fail: [t('緊張 +15', 'Tension +15'), t('信頼 -5', 'Trust -5')],
        warn: tensionWarn(15),
      }),
      disabledReason: () => (ctx.hostages().length === 0 ? t('解放を求める人質がいない', 'No hostages to release') : null),
      run: () => {
        const chance = releaseChance();
        const lines: NegotiationLine[] = [
          {
            text: t(
              'あなた「誠意を見せてくれ。せめて 1 人、人質を解放してほしい」',
              'You: "Show us good faith. Let at least one hostage walk out."',
            ),
            tone: 'me',
          },
        ];
        if (Math.random() < chance) {
          const h = ctx.hostages()[0]!;
          ctx.releaseHostage(h);
          results.push(t('人質 1 名を解放', '1 hostage released'));
          lines.push({
            text: t('犯人「……1 人だけだ。出ていけ」', 'Suspect: "...Just one. Get out of here."'),
            tone: 'them',
          });
          lines.push({
            text: t(
              `人質 1 名が建物から退避した（残り ${ctx.hostages().length} 名）`,
              `1 hostage evacuated the building (${ctx.hostages().length} remaining)`,
            ),
            tone: 'good',
          });
          return [...lines, ...spend(+5, -10)];
        }
        lines.push({
          text: t('犯人「調子に乗るな。人質は渡さねえ」', 'Suspect: "Don\'t push your luck. Nobody\'s leaving."'),
          tone: 'them',
        });
        lines.push({
          text: t('要求は拒否された（緊張 +15）', 'Demand refused (Tension +15)'),
          tone: 'bad',
        });
        return [...lines, ...spend(+15, -5)];
      },
    },
    {
      group: 'ask',
      requires: requireStage(1),
      icon: '💡',
      label: t('電気の復旧と引き換えに解放', 'Trade Power for a Hostage'),
      desc: t(
        '止めた電気を交換材料にする（見返り型の取引）。相手が欲しいものを渡すので、ふつうの解放要求より通りやすい。成功すると電気は戻る',
        'Use the cut power as a bargaining chip (quid pro quo). Since you give them something they want, it lands easier than a plain release demand. On success the power comes back.',
      ),
      chance: powerTradeChance,
      effects: () => ({
        gain: [t('人質 1名 救出', 'Rescue 1 Hostage'), t('緊張 -10', 'Tension -10'), t('信頼 +5', 'Trust +5')],
        cost: [t('電気が戻る（暗闇の優位を失う）', 'Power returns (lose the dark)')],
        fail: [t('緊張 +10', 'Tension +10')],
        warn: tensionWarn(10),
      }),
      disabledReason: () =>
        !power
          ? t('電源は操作できない', 'Power cannot be controlled')
          : power.utilityOn()
            ? t('先に電気を止める必要がある', 'Cut the power first')
            : ctx.hostages().length === 0
              ? t('解放を求める人質がいない', 'No hostages to release')
              : null,
      run: () => {
        const chance = powerTradeChance();
        const lines: NegotiationLine[] = [
          {
            text: t(
              'あなた「電気を戻してほしいなら、まず 1 人出してくれ。それが条件だ」',
              'You: "You want the power back? Send one person out first. That\'s the deal."',
            ),
            tone: 'me',
          },
        ];
        if (Math.random() < chance) {
          const h = ctx.hostages()[0]!;
          ctx.releaseHostage(h);
          power!.restoreUtility();
          results.push(t('電気と引き換えに人質 1 名を解放', '1 hostage released for power'));
          lines.push(
            { text: t('犯人「……わかった。1 人出す。電気を戻せ」', 'Suspect: "...Fine. One walks. Turn the power on."'), tone: 'them' },
            {
              text: t(
                `人質 1 名が退避し、電気が戻った（残り ${ctx.hostages().length} 名）`,
                `1 hostage evacuated and power restored (${ctx.hostages().length} remaining)`,
              ),
              tone: 'good',
            },
          );
          return [...lines, ...spend(-10, +5)];
        }
        lines.push(
          { text: t('犯人「足元を見やがって……」', 'Suspect: "Don\'t you dare squeeze me..."'), tone: 'them' },
          { text: t('取引は拒否された（緊張 +10）', 'Trade refused (Tension +10)'), tone: 'bad' },
        );
        return [...lines, ...spend(+10, 0)];
      },
    },
    {
      group: 'ask',
      requires: requireStage(3),
      icon: '🏳',
      label: t('投降を説得', 'Persuade to Surrender'),
      desc: t(
        '最も弱気な犯人がその場で投降する（突入後に拘束が必要）。信頼が高く、犯人の士気が低いほど成功しやすい',
        'The lowest-morale suspect surrenders on the spot (still needs cuffing after breach). High trust and low suspect morale help.',
      ),
      chance: () => {
        const target = persuadeTarget();
        return target ? persuadeChance(target) : 0;
      },
      effects: () => ({
        gain: [t('犯人 1名 投降', '1 Suspect Surrenders')],
        cost: [t('緊張 +10', 'Tension +10')],
        fail: [t('緊張 +10', 'Tension +10'), t('信頼 -5', 'Trust -5')],
        warn: tensionWarn(10),
      }),
      disabledReason: () => (active().length === 0 ? t('説得できる犯人がいない', 'No active suspects left') : null),
      run: () => {
        const target = persuadeTarget()!;
        const chance = persuadeChance(target);
        const lines: NegotiationLine[] = [
          {
            text: t(
              'あなた「今ならまだやり直せる。武器を置いて出てきてくれ」',
              'You: "It\'s not too late. Drop your weapon and come out."',
            ),
            tone: 'me',
          },
        ];
        if (Math.random() < chance && target.forceSurrender()) {
          results.push(t('犯人 1 名が投降', '1 suspect surrendered'));
          lines.push({
            text: t('犯人の一人「……もう嫌だ。俺は降りる」', 'A Suspect: "...I can\'t do this anymore. I\'m out."'),
            tone: 'them',
          });
          const room = tRoomName(ctx.roomName(target));
          lines.push({
            text: t(
              `犯人 1 名が投降した（${room}で拘束待ち）`,
              `1 suspect surrendered (awaiting arrest in ${room})`,
            ),
            tone: 'good',
          });
          return [...lines, ...spend(+10, 0)];
        }
        lines.push({
          text: t('犯人「説教は聞き飽きた」', 'Suspect: "Save the lecture."'),
          tone: 'them',
        });
        lines.push({
          text: t('説得は失敗した（緊張 +10 / 信頼 -5）', 'Persuasion failed (Tension +10 / Trust -5)'),
          tone: 'bad',
        });
        return [...lines, ...spend(+10, -5)];
      },
    },
    {
      group: 'ask',
      requires: requireStage(1),
      icon: '🕵',
      label: t('内部の様子を聞き出す', 'Gather Interior Intel'),
      lockedReason:
        ctx.unlockedCards?.intel === false ? t('SWAT Lv.2 で解放', 'Unlocks at SWAT Lv.2') : undefined,
      desc: t(
        '会話の背後の声から、抵抗を続ける犯人の人数と居場所を探る',
        'Listen for background voices to estimate active suspect count and locations.',
      ),
      chance: intelChance,
      effects: () => ({
        gain: [t('犯人の人数・居場所', 'Suspect Count & Rooms')],
        cost: [t('緊張 +5', 'Tension +5')],
        fail: [t('緊張 +10', 'Tension +10'), t('信頼 -5', 'Trust -5')],
        warn: tensionWarn(10),
      }),
      disabledReason: () => null,
      run: () => {
        const chance = intelChance();
        const lines: NegotiationLine[] = [
          {
            text: t(
              'あなた「みんな無事か？ そっちには何人いるんだ？」',
              'You: "Is everyone okay in there? How many of you are there?"',
            ),
            tone: 'me',
          },
        ];
        if (Math.random() < chance) {
          const list = active();
          const rooms = [...new Set(list.map((s) => tRoomName(ctx.roomName(s))))];
          results.push(t('内部情報を入手', 'Interior intel gathered'));
          lines.push({
            text: t(
              '犯人「余計な詮索はするな……おい、窓から離れろ！」 — 背後の声を聞き取った',
              'Suspect: "Stop snooping... Hey, get away from the window!" — Background voices overheard.',
            ),
            tone: 'them',
          });
          lines.push({
            text: t(
              `情報: 抵抗を続ける犯人 ${list.length} 名。気配がある場所 — ${rooms.join('、') || '不明'}`,
              `Intel: ${list.length} active suspects. Movement detected in — ${rooms.join(', ') || 'Unknown'}`,
            ),
            tone: 'good',
          });
          return [...lines, ...spend(+5, 0)];
        }
        lines.push({
          text: t('犯人「何を探ってやがる」', 'Suspect: "What are you fishing for?"'),
          tone: 'them',
        });
        lines.push({
          text: t('情報は得られなかった（緊張 +10）', 'No intel gained (Tension +10)'),
          tone: 'bad',
        });
        return [...lines, ...spend(+10, -5)];
      },
    },
    {
      group: 'press',
      requires: requireStage(1),
      icon: '📞',
      label: t('スローフォンを投げ入れる（盗聴器入り）', 'Deliver a Bugged Throw Phone'),
      desc: t(
        '「この電話で話そう」と専用電話を渡す。中の盗聴器で、突入中もその部屋にいる犯人がミニマップに映る。見つかると信頼を大きく失う',
        '"Let\'s talk on this line." The hidden bug keeps suspects in that room on your minimap during the breach. If they find it, trust takes a big hit.',
      ),
      chance: bugChance,
      effects: () => ({
        gain: [t('盗聴: 突入中、その部屋の犯人を常時表示', 'Bug: suspects in that room stay on the minimap'), t('信頼 +5', 'Trust +5')],
        fail: [t('盗聴器が見つかる', 'Bug discovered'), t('緊張 +20', 'Tension +20'), t('信頼 -15', 'Trust -15')],
        warn: tensionWarn(20),
      }),
      disabledReason: () =>
        !ctx.bug
          ? t('盗聴器は使えない', 'No bug available')
          : bugTried
            ? t('スローフォンはもう渡した', 'Throw phone already delivered')
            : active().length === 0
              ? t('電話を受け取る犯人がいない', 'No suspect to receive it')
              : null,
      run: () => {
        bugTried = true;
        const chance = bugChance();
        const lines: NegotiationLine[] = [
          {
            text: t(
              'あなた「携帯の電池が心配だろう。玄関前に専用の電話を置く。これで話そう」',
              'You: "Your phone battery won\'t last. I\'m leaving a dedicated phone by the door. Let\'s use that."',
            ),
            tone: 'me',
          },
        ];
        const holder = active()[0]!;
        if (Math.random() < chance) {
          bugRoom = ctx.bug!.plant(holder);
          results.push(t(`盗聴器を設置（${bugRoom}）`, `Bug planted (${bugRoom})`));
          lines.push(
            { text: t('犯人「……鳴ったら出てやる」', 'Suspect: "...I\'ll pick up when it rings."'), tone: 'them' },
            {
              text: t(`盗聴器が作動: ${bugRoom}の会話が聞こえる`, `Bug live: you can hear everything in ${bugRoom}`),
              tone: 'good',
            },
          );
          return [...lines, ...spend(0, +5)];
        }
        lines.push(
          { text: t('犯人「なんだこれは……盗聴器じゃねえか！ ふざけやがって！」', 'Suspect: "What\'s this... a bug?! You think I\'m stupid?!"'), tone: 'them' },
          { text: t('盗聴器が見つかった（緊張 +20 / 信頼 -15）', 'Bug discovered (Tension +20 / Trust -15)'), tone: 'bad' },
        );
        return [...lines, ...spend(+20, -15)];
      },
    },
    {
      group: 'press',
      icon: '🔌',
      label: t('電気を止める', 'Cut the Power'),
      desc: t(
        '電力会社に建物の電気を止めさせる。冷房もテレビも止まり、犯人は消耗する。止めた電気は人質解放の交換材料になる。ただし突入まで暗いままだと犯人は暗闇に慣れ、最初からライトを点けて待ち構える',
        'Have the utility kill the building\'s power. No AC, no TV: suspects wear down, and the power becomes a chip to trade for hostages. But if it stays dark until the breach, they adapt and wait with flashlights already on.',
      ),
      effects: () => ({
        gain: [
          t(`犯人の消耗 +15（${Math.round(ctx.fatigue())}→${Math.min(100, Math.round(ctx.fatigue()) + 15)}）`, `Suspect Fatigue +15 (${Math.round(ctx.fatigue())}→${Math.min(100, Math.round(ctx.fatigue()) + 15)})`),
          t('「電気と引き換えに解放」が使える', 'Unlocks "Trade Power for a Hostage"'),
        ],
        cost: [t('緊張 +12', 'Tension +12'), t('信頼 -8', 'Trust -8'), t('暗いまま突入すると犯人はライトで待ち構える', 'Dark until breach: they wait with lights on')],
        warn: tensionWarn(12),
      }),
      disabledReason: () =>
        !power ? t('電源は操作できない', 'Power cannot be controlled') : !power.utilityOn() ? t('電気はもう止めてある', 'Power is already cut') : null,
      run: () => {
        power!.cutUtility();
        const before = Math.round(ctx.fatigue());
        ctx.setFatigue(ctx.fatigue() + 15);
        results.push(t('電気を止めた', 'Power cut'));
        return [
          {
            text: t('あなた（無線）「電力会社へ。建物の電気を止めてくれ」', 'You (radio): "Utility, kill the power to the building."'),
            tone: 'me',
          },
          {
            text: t('犯人「おい、電気が消えたぞ！ 何しやがった！」', 'Suspect: "Hey, the lights went out! What did you do?!"'),
            tone: 'them',
          },
          {
            text: t(
              `停電: 犯人の消耗 ${before}→${Math.round(ctx.fatigue())} / 緊張 +12 / 信頼 -8`,
              `Blackout: Suspect fatigue ${before}→${Math.round(ctx.fatigue())} / Tension +12 / Trust -8`,
            ),
            tone: 'info',
          },
          ...spend(+12, -8),
        ];
      },
    },
    {
      group: 'press',
      icon: '⚡',
      label: t('最後通告（威圧）', 'Ultimatum (Intimidate)'),
      lockedReason:
        ctx.unlockedCards?.ultimatum === false ? t('SWAT Lv.3 で解放', 'Unlocks at SWAT Lv.3') : undefined,
      desc: t(
        '全犯人を動揺させ、突入時に投降しやすくする。緊張が大きく上がるので使いどころに注意',
        'Rattle all suspects so they surrender more easily during breach. Spikes tension sharply — use with care.',
      ),
      effects: () => ({
        gain: [t('全犯人の士気 -15', 'All Suspect Morale -15')],
        cost: [t('緊張 +30', 'Tension +30'), t('信頼 -10', 'Trust -10')],
        warn: tensionWarn(30),
      }),
      disabledReason: () => null,
      run: () => {
        for (const s of active()) s.adjustMorale(-15);
        ultimatums++;
        results.push(t('最後通告で犯人の士気低下', 'Ultimatum lowered suspect morale'));
        return [
          {
            text: t(
              'あなた「建物は完全に包囲した。10 分以内に出てこなければ突入する」',
              'You: "The building is completely surrounded. Come out in 10 minutes or we breach."',
            ),
            tone: 'me',
          },
          {
            text: t(
              '犯人「脅しやがって……！」 — 動揺が伝わってくる',
              'Suspect: "Don\'t threaten me...!" — You hear panic in their voice.',
            ),
            tone: 'them',
          },
          {
            text: t('犯人の士気 -15 / 緊張 +30', 'Suspect Morale -15 / Tension +30'),
            tone: 'info',
          },
          ...spend(+30, -10),
        ];
      },
    },
  ];

  return {
    title: t('突入前交渉 — 立てこもり犯との通話', 'Pre-Assault Negotiation — Call with Suspects'),
    subtitle: t(
      '突入前に電話で犯人と交渉できる。信頼を築けば人質の解放や投降を引き出せ、威圧すれば突入時に降伏させやすくなる。犯人の緊張が限界を超えると人質が殺害される。',
      'Negotiate by phone before breaching. Build trust to free hostages or persuade surrenders, or intimidate to weaken morale. If tension hits 100, a hostage is executed.',
    ),
    intro: [
      {
        text: t(
          '犯人「誰だ！ 近づいたら人質を撃つぞ！」',
          'Suspect: "Who is this?! Come any closer and I shoot the hostages!"',
        ),
        tone: 'them',
      },
      {
        text: t(
          `状況: 籠城 ${ctx.siegeHour()} 時間目 / 犯人の消耗 ${Math.round(ctx.fatigue())} / 人質 ${ctx.hostages().length} 名`,
          `Status: Hour ${ctx.siegeHour()} of siege / Suspect Fatigue ${Math.round(ctx.fatigue())} / ${ctx.hostages().length} Hostages`,
        ),
        tone: 'info',
      },
    ],
    meters: () => [
      {
        label: t('犯人の緊張', 'Suspect Tension'),
        value: tension,
        max: 100,
        color: tension < 50 ? '#5cd67d' : tension < 80 ? '#f2c14e' : '#ff5555',
        hint: t('100 で人質が殺害され交渉決裂', 'At 100: hostage executed & talks break down'),
      },
      {
        label: t(`犯人の消耗（${ctx.siegeHour()} 時間目）`, `Suspect Fatigue (Hour ${ctx.siegeHour()})`),
        value: ctx.fatigue(),
        max: 100,
        color: FATIGUE_COLORS[ctx.fatigueTier()],
        text: `${Math.round(ctx.fatigue())}`,
        compact: true,
        hint: t(
          '高いほど犯人の反応が鈍く狙いが粗い。食料・水の差し入れで回復する（手強くなる）。電気を止めると上がる',
          'Higher fatigue means slower reactions and worse aim. Food & water restore it (making them tougher). Cutting power raises it.',
        ),
      },
      ...(ctx.alertCfg
        ? [
            {
              compact: true,
              label: t('突入時の警戒度予測', 'Forecast Alert at Breach'),
              value: alertForecast(),
              max: 100,
              color: alertForecast() < 30 ? '#5cd67d' : alertForecast() < 50 ? '#f2c14e' : '#ff7a45',
              text: `${alertForecast()}`,
              hint: t(
                '突入時点の容疑者の警戒度の下限。威圧・高い緊張で上がり、信頼構築・低い緊張で下がる。高いと待ち伏せ・人質盾・脅迫が起こりやすい',
                'Starting floor of suspect alert. Intimidation and high tension raise it; trust and calm lower it. High alert means ambushes, human shields and execution threats.',
              ),
            },
          ]
        : []),
      {
        label: t('人質', 'Hostages'),
        value: ctx.hostages().length,
        max: Math.max(1, ctx.hostages().length),
        color: '#f2a65a',
        text: t(`${ctx.hostages().length} 名`, `${ctx.hostages().length}`),
        compact: true,
        hint: t('救出できれば加点', 'Bonus points for each hostage rescued'),
      },
    ],
    ladder: () => {
      const i = stage();
      const cur = BCSM_STEPS[i]!;
      const next = BCSM_STEPS[i + 1];
      return {
        title: t(`信頼 ${Math.round(trust)} — 行動変化の階段`, `Trust ${Math.round(trust)} — Behavioral Change Stairway`),
        steps: BCSM_STEPS.map((st) => ({ label: t(st.ja, st.en), hint: t(st.hintJa, st.hintEn) })),
        index: i,
        progress: next ? clamp((trust - cur.at) / (next.at - cur.at), 0, 1) : 1,
        note: next
          ? t(
              `いま: ${t(cur.hintJa, cur.hintEn)}。次の「${t(next.ja, next.en)}」まで信頼あと ${Math.ceil(next.at - trust)}。段階を飛ばした要求は成功率 ×${BCSM_SKIP_MUL}`,
              `Now: ${cur.hintEn}. ${Math.ceil(next.at - trust)} more trust to "${next.en}". Requests that skip steps: odds ×${BCSM_SKIP_MUL}`,
            )
          : t(cur.hintJa, cur.hintEn),
      };
    },
    turnsLeft: () => (broken ? 0 : turns),
    maxTurns: MAX_TURNS,
    isOver: () => broken,
    options,
    groups: [
      { id: 'talk', label: t('🤝 対話', '🤝 TALK'), hint: t('信頼を積んで段階を上げる', 'Build trust and climb the stairway') },
      { id: 'ask', label: t('🎯 要求', '🎯 ASK'), hint: t('段階が足りないと成功率が下がる', 'Low odds if you skip steps') },
      { id: 'press', label: t('🔧 圧力と仕掛け', '🔧 PRESSURE & TRICKS'), hint: t('緊張が上がる。突入を有利にする', 'Raises tension, sets up the breach') },
    ],
    plan: {
      title: t('突入プラン', 'BREACH PLAN'),
      items: () => {
        const items: NegotiationPlanItem[] = [];
        if (power) {
          const room = power.panelRoom();
          items.push(
            !power.utilityOn()
              ? {
                  icon: '🌑',
                  label: t('電源', 'Power'),
                  value: t('停電中 — 犯人は暗闇に慣れ、ライトを点けて待つ', 'Off — suspects adapt and wait with lights on'),
                  tone: 'warn',
                }
              : power.breachBlackout()
                ? {
                    icon: '🌑',
                    label: t('電源', 'Power'),
                    value: t('突入と同時に停電 — 犯人は不意を突かれる', 'Cut at breach — catches them off guard'),
                    tone: 'good',
                  }
                : { icon: '💡', label: t('電源', 'Power'), value: t('通電したまま突入', 'Breach with lights on'), tone: 'info' },
          );
          if (room) {
            items.push({
              icon: '🔌',
              label: t('配電盤', 'Breaker'),
              value: t(`${room}（犯人も操作できる）`, `${room} (suspects can use it too)`),
              tone: 'info',
            });
          }
        }
        if (ctx.bug) {
          items.push(
            ctx.bug.planted()
              ? { icon: '📞', label: t('盗聴器', 'Bug'), value: t(`${bugRoom}を傍受中`, `Listening in ${bugRoom}`), tone: 'good' }
              : bugTried
                ? { icon: '📞', label: t('盗聴器', 'Bug'), value: t('見つかって壊された', 'Found and destroyed'), tone: 'bad' }
                : { icon: '📞', label: t('盗聴器', 'Bug'), value: t('なし', 'None'), tone: 'info' },
          );
        }
        if (ctx.alertCfg) {
          const f = alertForecast();
          items.push({
            icon: '👁',
            label: t('警戒度', 'Alert'),
            value: t(`突入時 ${f} から`, `Starts at ${f}`),
            tone: f < 30 ? 'good' : f < 50 ? 'warn' : 'bad',
          });
        }
        return items;
      },
      toggles: power
        ? [
            {
              key: 'B',
              code: 'KeyB',
              label: t('突入と同時に停電', 'Cut Power at Breach'),
              effects: () => ({
                gain: [t('暗闇で突入（N: 暗視装置）', 'Breach in the dark (N: night vision)'), t('犯人はライト無しで不意を突かれる', 'Suspects caught without lights')],
                cost: [t('停電で異変に気付く（警戒度 +8）', 'They sense it coming (Alert +8)')],
              }),
              on: () => power.breachBlackout(),
              set: (v) => power.setBreachBlackout(v),
              disabledReason: () =>
                !power.utilityOn() ? t('電気はすでに止めてある', 'Power is already cut') : null,
            },
          ]
        : undefined,
    },
    finishLabel: t('交渉を終えて突入開始', 'End Call & Begin Breach'),
    summary: () => [
      broken
        ? t('交渉は決裂した。', 'Negotiations broke down.')
        : t('交渉は終了した。', 'Negotiations ended.'),
      t(
        `結果: ${results.length > 0 ? results.join(' / ') : '特になし'}`,
        `Outcome: ${results.length > 0 ? results.join(' / ') : 'None'}`,
      ),
      ...(ctx.alertCfg
        ? [
            t(
              `突入時の容疑者の警戒度: ${alertForecast()}（これ未満には下がらない）`,
              `Suspect alert at breach: ${alertForecast()} (will not drop below this)`,
            ),
          ]
        : []),
    ],
  };
}
