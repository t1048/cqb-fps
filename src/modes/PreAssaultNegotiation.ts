import type { Civilian } from '../ai/Civilian';
import type { Suspect } from '../ai/Suspect';
import { SuspectState } from '../core/events';
import { t, tRoomName } from '../core/i18n';
import type { SuspectAlertConfig } from '../core/types';
import { negotiationAlertBaseline, type NegotiationAlertInfo } from '../ai/SuspectAlert';
import type { NegotiationLine, NegotiationOption, NegotiationScenario } from '../ui/NegotiationPhase';

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
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
  giveArmor(points: number): void;
  hasArmor(): boolean;
  giveMagazines(n: number): void;
  /** 突入班を 1 名下げさせる。成功で true */
  withdrawSwat(): boolean;
  swatCount(): number;
  /** 仲間の容疑者 NPC（士気が上がると投降しにくく、粘り強く戦う） */
  allies(): Suspect[];
}

/**
 * 時間稼ぎ・人質交換（防弾チョッキ / 弾薬 / 時間）・脅迫。
 * SWAT 側の「忍耐」が 0 になると交渉決裂で即突入。人質を手放すほど盾が減るトレードオフ。
 */
export function buildSuspectNegotiation(ctx: SuspectNegotiationContext): NegotiationScenario {
  let patience = 100;
  let turns = 6;
  let broken = false;
  let stallCount = 0;
  const released: string[] = [];
  const gains: string[] = [];
  let rallyCount = 0;
  const activeAllies = (): Suspect[] =>
    ctx.allies().filter((s) => s.alive && s.state !== SuspectState.SURRENDER && s.state !== SuspectState.ARRESTED);
  const teamMorale = (): number => {
    const a = activeAllies();
    return a.length === 0 ? 0 : a.reduce((sum, s) => sum + s.morale.value, 0) / a.length;
  };
  const shiftMorale = (d: number): void => {
    for (const s of activeAllies()) s.adjustMorale(d);
  };

  const spend = (dp: number): void => {
    turns--;
    patience = clamp(patience + dp, 0, 100);
    if (patience <= 0 && !broken) {
      broken = true;
      ctx.breakdown();
    }
  };
  const breakdownLines = (): NegotiationLine[] =>
    broken
      ? [
          {
            text: t(
              '交渉人「……交渉は終わりだ。突入班、配置につけ」 — 交渉決裂。SWAT がまもなく突入する！',
              'Negotiator: "...Negotiations are over. Entry team, move into position." — Talks broke down. SWAT is breaching soon!',
            ),
            tone: 'bad',
            critical: true,
          },
        ]
      : [];
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
      icon: '🦺',
      label: t('人質と交換: 防弾チョッキ', 'Trade Hostage: Body Armor'),
      desc: t(
        '被弾ダメージの 60% を肩代わり（耐久 70）。人質を手放すので盾が減り、仲間も動揺する',
        'Absorbs 60% of incoming damage (70 durability). Costs a hostage and shakes crew morale.',
      ),
      effects: () => ({
        gain: [t('防弾チョッキ', 'Body Armor'), t('忍耐 +8', 'Patience +8')],
        cost: hostageCost(),
      }),
      disabledReason: () =>
        needHostage() ?? (ctx.hasArmor() ? t('すでに防弾チョッキを受け取った', 'Already received body armor') : null),
      run: () =>
        trade(
          t('防弾チョッキ', 'Body Armor'),
          () => ctx.giveArmor(70),
          +8,
          t(
            '交渉人「……いいだろう。玄関前に置く。人質を先に出せ」',
            'Negotiator: "...Fine. Leaving it by the front door. Send the hostage out first."',
          ),
        ),
    },
    {
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
      icon: '📣',
      label: t('強気の要求で仲間を鼓舞', 'Rally Crew with Bold Demands'),
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
      icon: '☠',
      label: t('脅迫して包囲を緩めさせる', 'Threaten to Pull Back Perimeter'),
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
          `状況: 人質 ${ctx.hostages().length} 名 / 突入班 SWAT ${ctx.swatCount()} 名 / 突入まで ${Math.round(ctx.prepSec())} 秒`,
          `Status: ${ctx.hostages().length} Hostages / ${ctx.swatCount()} SWAT / ${Math.round(ctx.prepSec())}s to breach`,
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
    isOver: () => broken,
    options,
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
}

/**
 * 信頼構築（差し入れ）・人質解放要求・投降説得・情報収集・最後通告。
 * 犯人側の「緊張」が 100 に達すると人質が 1 名殺害され、交渉は決裂する。
 */
export function buildSwatNegotiation(ctx: SwatNegotiationContext): NegotiationScenario {
  let tension = 45;
  let trust = 10;
  let turns = 6;
  let broken = false;
  let ultimatums = 0;
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
  const releaseChance = (): number => clamp(0.25 + trust / 100 - tension / 220, 0.08, 0.92);
  const persuadeTarget = (): Suspect | undefined => active().sort((a, b) => a.morale.value - b.morale.value)[0];
  const persuadeChance = (target: Suspect): number => clamp(0.12 + trust / 140 + (60 - target.morale.value) / 200, 0.05, 0.8);
  const intelChance = (): number => clamp(0.45 + trust / 200 - tension / 300, 0.15, 0.95);

  const options: NegotiationOption[] = [
    {
      icon: '🥪',
      label: t('信頼構築（食料・水を差し入れ）', 'Build Trust (Send Food & Water)'),
      desc: t(
        '場を落ち着かせて信頼を築く。信頼は他の交渉の成功率を上げる。ただし犯人は休息で士気が少し回復する',
        'De-escalate and build trust, boosting odds on other options. Suspects recover a little morale.',
      ),
      effects: () => ({
        gain: [t('緊張 -15', 'Tension -15'), t('信頼 +20', 'Trust +20')],
        cost: [t('犯人の士気 +4', 'Suspect Morale +4')],
      }),
      disabledReason: () => null,
      run: () => {
        for (const s of active()) s.adjustMorale(4);
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
          ...spend(-15, +20),
        ];
      },
    },
    {
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
      icon: '👂',
      label: t('内部の様子を聞き出す', 'Gather Interior Intel'),
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
      icon: '⚡',
      label: t('最後通告（威圧）', 'Ultimatum (Intimidate)'),
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
        text: t(`状況: 人質 ${ctx.hostages().length} 名`, `Status: ${ctx.hostages().length} Hostages`),
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
        label: t('信頼', 'Trust'),
        value: trust,
        max: 100,
        color: '#7ce2f0',
        hint: t('高いほど解放・投降・情報が成功しやすい', 'Higher trust improves release, surrender & intel odds'),
      },
      ...(ctx.alertCfg
        ? [
            {
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
        hint: t('救出できれば加点', 'Bonus points for each hostage rescued'),
      },
    ],
    turnsLeft: () => (broken ? 0 : turns),
    isOver: () => broken,
    options,
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
