import type { Civilian } from '../ai/Civilian';
import type { Suspect } from '../ai/Suspect';
import { SuspectState } from '../core/events';
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
    broken ? [{ text: '交渉人「……交渉は終わりだ。突入班、配置につけ」 — 交渉決裂。SWAT がまもなく突入する！', tone: 'bad' }] : [];
  /** 忍耐が dp 下がると決裂するときの警告 */
  const patienceWarn = (dp: number): string | undefined =>
    patience + dp <= 0 ? `交渉人の忍耐が尽きて交渉決裂（即突入）になる` : undefined;
  const hostageCost = (): string[] => ['人質 -1', ...(activeAllies().length > 0 ? ['仲間の士気 -10'] : [])];
  const stallChance = (): number => clamp(patience / 110 - stallCount * 0.15, 0.1, 0.9);
  const rallyChance = (): number => clamp(0.55 + patience / 250, 0.4, 0.9);
  const rallyGain = (): number => [22, 14, 8][rallyCount] ?? 8;
  const threatChance = (): number => clamp(0.35 + ctx.hostages().length * 0.05, 0, 1);
  const needHostage = (): string | null => (ctx.hostages().length === 0 ? '交換できる人質がいない' : null);
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
      { text: `あなた「人質を 1 人解放する。代わりに${gain}をよこせ」`, tone: 'me' },
      { text: theirLine, tone: 'them' },
      { text: `人質 1 名を解放 → ${gain}を入手（残りの人質 ${ctx.hostages().length} 名）`, tone: 'good' },
      ...(hasAllies ? [{ text: '仲間「おい、切り札を手放してどうする……」 — 仲間の士気 -10', tone: 'bad' as const }] : []),
      ...breakdownLines(),
    ];
  };

  const options: NegotiationOption[] = [
    {
      icon: '⏳',
      label: '時間稼ぎ',
      desc: '車やヘリを要求して引き延ばす。稼いだ時間で仲間が窓を塞ぎ・武器を改造し・トラップを作る。繰り返すほど見抜かれやすい',
      chance: stallChance,
      effects: () => ({ gain: ['準備時間 +25秒', '仲間の士気 +4'], cost: ['忍耐 -12'], fail: ['忍耐 -30'], warn: patienceWarn(-30) }),
      disabledReason: () => null,
      run: () => {
        const chance = stallChance();
        stallCount++;
        const lines: NegotiationLine[] = [
          { text: `あなた「${pick(['逃走用の車を用意しろ。満タンでだ', '弁護士とテレビ局を呼べ', 'ヘリを屋上に回せ、話はそれからだ'])}」`, tone: 'me' },
        ];
        if (Math.random() < chance) {
          ctx.addPrep(25);
          spend(-12);
          shiftMorale(4);
          lines.push({ text: '交渉人「……わかった、手配に時間がかかる。少し待ってくれ」', tone: 'them' });
          lines.push({
            text: `時間稼ぎ成功: 突入まで ${Math.round(ctx.prepSec())} 秒${activeAllies().length > 0 ? '（その間に仲間が窓の補強・武器の改造・トラップ作りを進める）' : ''}`,
            tone: 'good',
          });
        } else {
          spend(-30);
          lines.push({ text: '交渉人「時間稼ぎなのはわかっている。いい加減にしろ」', tone: 'them' });
          lines.push({ text: '見抜かれた: 交渉人の忍耐が大きく低下', tone: 'bad' });
        }
        return [...lines, ...breakdownLines()];
      },
    },
    {
      icon: '🦺',
      label: '人質と交換: 防弾チョッキ',
      desc: '被弾ダメージの 60% を肩代わり（耐久 70）。人質を手放すので盾が減り、仲間も動揺する',
      effects: () => ({ gain: ['防弾チョッキ', '忍耐 +8'], cost: hostageCost() }),
      disabledReason: () => needHostage() ?? (ctx.hasArmor() ? 'すでに防弾チョッキを受け取った' : null),
      run: () => trade('防弾チョッキ', () => ctx.giveArmor(70), +8, '交渉人「……いいだろう。玄関前に置く。人質を先に出せ」'),
    },
    {
      icon: '🔫',
      label: '人質と交換: 弾薬',
      desc: '予備マガジン 2 本を受け取る。人質を手放すので盾が減り、仲間も動揺する',
      effects: () => ({ gain: ['予備マガジン +2', '忍耐 +5'], cost: hostageCost() }),
      disabledReason: needHostage,
      run: () => trade('予備マガジン 2 本', () => ctx.giveMagazines(2), +5, '交渉人「弾を渡すのは本意じゃないが……人質の安全が優先だ」'),
    },
    {
      icon: '⏱',
      label: '人質と交換: 時間',
      desc: '人質を解放する代わりに突入を待たせる（確実に時間を稼げる）',
      effects: () => ({ gain: ['準備時間 +40秒', '忍耐 +15'], cost: hostageCost() }),
      disabledReason: needHostage,
      run: () => trade('準備時間 +40 秒', () => ctx.addPrep(40), +15, '交渉人「誠意は受け取った。こちらも待とう」'),
    },
    {
      icon: '📣',
      label: '強気の要求で仲間を鼓舞',
      desc: '通話を仲間に聞かせて奮い立たせる。士気が高い仲間は投降しにくく粘り強く戦う。繰り返すほど効果は薄れる',
      chance: rallyChance,
      effects: () => ({
        gain: [`仲間の士気 +${rallyGain()}`],
        cost: ['忍耐 -10'],
        fail: [`仲間の士気 +${Math.round(rallyGain() / 3)} のみ`, '忍耐 -20'],
        warn: patienceWarn(-20),
      }),
      disabledReason: () => (activeAllies().length === 0 ? '鼓舞する仲間がいない' : rallyCount >= 3 ? '仲間はもう十分に奮い立っている' : null),
      run: () => {
        const gain = rallyGain();
        rallyCount++;
        const lines: NegotiationLine[] = [
          { text: `あなた「${pick(['俺たちは本気だ。全員で最後までやる', '仲間の家族と話をさせろ。それまで一歩も引かない', '聞こえたか、お前ら！ 警察は手出しできねえ！'])}」`, tone: 'me' },
        ];
        if (Math.random() < rallyChance()) {
          shiftMorale(gain);
          spend(-10);
          gains.push('仲間の士気↑');
          lines.push({ text: '交渉人「……落ち着いてくれ。誰の家族だ？ 連絡を取ってみる」', tone: 'them' });
          lines.push({ text: `仲間「よし……やってやる！」 — 仲間の士気 +${gain}（平均 ${Math.round(teamMorale())}）`, tone: 'good' });
        } else {
          shiftMorale(Math.round(gain / 3));
          spend(-20);
          lines.push({ text: '交渉人「虚勢を張っても状況は変わらない」', tone: 'them' });
          lines.push({ text: `仲間の士気 +${Math.round(gain / 3)} / 交渉人の忍耐が大きく低下`, tone: 'bad' });
        }
        return [...lines, ...breakdownLines()];
      },
    },
    {
      icon: '☠',
      label: '脅迫して包囲を緩めさせる',
      desc: '人質の命を盾に突入班を下げさせる。人質が多いほど成功しやすい',
      chance: threatChance,
      effects: () => ({ gain: ['突入班 SWAT -1名'], cost: ['忍耐 -25'], fail: ['忍耐 -45'], warn: patienceWarn(-45) }),
      disabledReason: () => (ctx.hostages().length === 0 ? '人質がいないと脅せない' : ctx.swatCount() <= 3 ? 'これ以上は下げさせられない' : null),
      run: () => {
        const lines: NegotiationLine[] = [{ text: 'あなた「建物の周りの連中を下げろ。さもないと人質がどうなるか分かってるな」', tone: 'me' }];
        if (Math.random() < threatChance() && ctx.withdrawSwat()) {
          spend(-25);
          lines.push({ text: '交渉人「……落ち着け。一部を下げる」', tone: 'them' });
          lines.push({ text: `突入班が 1 名減った（SWAT ${ctx.swatCount()} 名）`, tone: 'good' });
          gains.push('SWAT -1 名');
        } else {
          spend(-45);
          lines.push({ text: '交渉人「脅しには屈しない」', tone: 'them' });
          lines.push({ text: '脅迫失敗: 交渉人の忍耐が激減', tone: 'bad' });
        }
        return [...lines, ...breakdownLines()];
      },
    },
  ];

  return {
    title: '立てこもり — SWAT 交渉人との通話',
    subtitle:
      '突入前に SWAT の交渉人と取引できる。時間を稼げば仲間が窓を塞ぎ・武器を改造し・トラップを作る。強気の要求は仲間の士気を上げる。人質を差し出せば装備は得られるが、仲間は動揺し、盾も減る（盾にしても SWAT はペッパーボールで崩してくる）。交渉人の忍耐が尽きると即突入される。',
    intro: [
      { text: '交渉人「こちらは警察だ。建物は完全に包囲されている。まずは話をしよう」', tone: 'them' },
      { text: `状況: 人質 ${ctx.hostages().length} 名 / 突入班 SWAT ${ctx.swatCount()} 名 / 突入まで ${Math.round(ctx.prepSec())} 秒`, tone: 'info' },
    ],
    meters: () => [
      { label: '交渉人の忍耐', value: patience, max: 100, color: patience > 50 ? '#5cd67d' : patience > 25 ? '#f2c14e' : '#ff5555', hint: '0 になると交渉決裂 → 即突入' },
      { label: '突入までの準備時間', value: ctx.prepSec(), max: 180, color: '#ffd24d', text: `${Math.round(ctx.prepSec())} 秒`, hint: '長いほど籠城の準備が進む' },
      { label: '人質', value: ctx.hostages().length, max: Math.max(1, ctx.hostages().length + released.length), color: '#f2a65a', text: `${ctx.hostages().length} 名`, hint: '交換・脅迫の材料（盾にもなる）' },
      ...(ctx.allies().length > 0
        ? [{ label: '仲間の士気', value: teamMorale(), max: 100, color: teamMorale() >= 60 ? '#5cd67d' : teamMorale() >= 35 ? '#f2c14e' : '#ff5555', text: `${Math.round(teamMorale())}（${activeAllies().length} 名）`, hint: '高いほど投降しにくく粘り強い' }]
        : []),
    ],
    turnsLeft: () => (broken ? 0 : turns),
    isOver: () => broken,
    options,
    finishLabel: '交渉を打ち切って籠城開始',
    summary: () => [
      broken ? '交渉は決裂した。' : '交渉は終了した。',
      `獲得: ${gains.length > 0 ? gains.join(' / ') : 'なし'}`,
      `解放した人質: ${released.length} 名 / 突入まで ${Math.round(ctx.prepSec())} 秒`,
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
  const results: string[] = [];

  const active = (): Suspect[] => ctx.suspects().filter((s) => s.alive && s.state !== SuspectState.SURRENDER && s.state !== SuspectState.ARRESTED);
  const spend = (dTension: number, dTrust: number): NegotiationLine[] => {
    turns--;
    tension = clamp(tension + dTension, 0, 100);
    trust = clamp(trust + dTrust, 0, 100);
    if (tension >= 100 && !broken) {
      broken = true;
      const h = ctx.hostages()[0];
      if (h) {
        ctx.executeHostage(h);
        results.push('人質 1 名が殺害された');
        return [
          { text: '犯人「もう我慢ならねえ！」 — 銃声が響いた', tone: 'them' },
          { text: '交渉決裂: 人質 1 名が殺害された。直ちに突入せよ', tone: 'bad' },
        ];
      }
      return [{ text: '交渉決裂: 犯人が通話を切った', tone: 'bad' }];
    }
    return [];
  };

  /** 緊張が dt 上がると人質が殺害されるときの警告 */
  const tensionWarn = (dt: number): string | undefined =>
    tension + dt >= 100 ? (ctx.hostages().length > 0 ? '緊張が限界を超えて人質が殺害される！' : '緊張が限界を超えて交渉決裂') : undefined;
  const releaseChance = (): number => clamp(0.25 + trust / 100 - tension / 220, 0.08, 0.92);
  const persuadeTarget = (): Suspect | undefined => active().sort((a, b) => a.morale.value - b.morale.value)[0];
  const persuadeChance = (t: Suspect): number => clamp(0.12 + trust / 140 + (60 - t.morale.value) / 200, 0.05, 0.8);
  const intelChance = (): number => clamp(0.45 + trust / 200 - tension / 300, 0.15, 0.95);

  const options: NegotiationOption[] = [
    {
      icon: '🥪',
      label: '信頼構築（食料・水を差し入れ）',
      desc: '場を落ち着かせて信頼を築く。信頼は他の交渉の成功率を上げる。ただし犯人は休息で士気が少し回復する',
      effects: () => ({ gain: ['緊張 -15', '信頼 +20'], cost: ['犯人の士気 +4'] }),
      disabledReason: () => null,
      run: () => {
        for (const s of active()) s.adjustMorale(4);
        return [
          { text: 'あなた「食料と水を玄関前に置く。誰も傷つけないでくれ」', tone: 'me' },
          { text: '犯人「……わかった。変な真似はするなよ」', tone: 'them' },
          { text: '緊張 -15 / 信頼 +20（犯人の士気 +4）', tone: 'info' },
          ...spend(-15, +20),
        ];
      },
    },
    {
      icon: '🧍',
      label: '人質の解放を要求',
      desc: '解放された人質は保護として加点。信頼が高く緊張が低いほど成功しやすい',
      chance: releaseChance,
      effects: () => ({ gain: ['人質 1名 救出'], cost: ['緊張 +5', '信頼 -10'], fail: ['緊張 +15', '信頼 -5'], warn: tensionWarn(15) }),
      disabledReason: () => (ctx.hostages().length === 0 ? '解放を求める人質がいない' : null),
      run: () => {
        const chance = releaseChance();
        const lines: NegotiationLine[] = [{ text: 'あなた「誠意を見せてくれ。せめて 1 人、人質を解放してほしい」', tone: 'me' }];
        if (Math.random() < chance) {
          const h = ctx.hostages()[0]!;
          ctx.releaseHostage(h);
          results.push('人質 1 名を解放');
          lines.push({ text: '犯人「……1 人だけだ。出ていけ」', tone: 'them' });
          lines.push({ text: `人質 1 名が建物から退避した（残り ${ctx.hostages().length} 名）`, tone: 'good' });
          return [...lines, ...spend(+5, -10)];
        }
        lines.push({ text: '犯人「調子に乗るな。人質は渡さねえ」', tone: 'them' });
        lines.push({ text: '要求は拒否された（緊張 +15）', tone: 'bad' });
        return [...lines, ...spend(+15, -5)];
      },
    },
    {
      icon: '🏳',
      label: '投降を説得',
      desc: '最も弱気な犯人がその場で投降する（突入後に拘束が必要）。信頼が高く、犯人の士気が低いほど成功しやすい',
      chance: () => {
        const t = persuadeTarget();
        return t ? persuadeChance(t) : 0;
      },
      effects: () => ({ gain: ['犯人 1名 投降'], cost: ['緊張 +10'], fail: ['緊張 +10', '信頼 -5'], warn: tensionWarn(10) }),
      disabledReason: () => (active().length === 0 ? '説得できる犯人がいない' : null),
      run: () => {
        const target = persuadeTarget()!;
        const chance = persuadeChance(target);
        const lines: NegotiationLine[] = [{ text: 'あなた「今ならまだやり直せる。武器を置いて出てきてくれ」', tone: 'me' }];
        if (Math.random() < chance && target.forceSurrender()) {
          results.push('犯人 1 名が投降');
          lines.push({ text: '犯人の一人「……もう嫌だ。俺は降りる」', tone: 'them' });
          lines.push({ text: `犯人 1 名が投降した（${ctx.roomName(target)}で拘束待ち）`, tone: 'good' });
          return [...lines, ...spend(+10, 0)];
        }
        lines.push({ text: '犯人「説教は聞き飽きた」', tone: 'them' });
        lines.push({ text: '説得は失敗した（緊張 +10 / 信頼 -5）', tone: 'bad' });
        return [...lines, ...spend(+10, -5)];
      },
    },
    {
      icon: '👂',
      label: '内部の様子を聞き出す',
      desc: '会話の背後の声から、抵抗を続ける犯人の人数と居場所を探る',
      chance: intelChance,
      effects: () => ({ gain: ['犯人の人数・居場所'], cost: ['緊張 +5'], fail: ['緊張 +10', '信頼 -5'], warn: tensionWarn(10) }),
      disabledReason: () => null,
      run: () => {
        const chance = intelChance();
        const lines: NegotiationLine[] = [{ text: 'あなた「みんな無事か？ そっちには何人いるんだ？」', tone: 'me' }];
        if (Math.random() < chance) {
          const list = active();
          const rooms = [...new Set(list.map((s) => ctx.roomName(s)))];
          results.push('内部情報を入手');
          lines.push({ text: '犯人「余計な詮索はするな……おい、窓から離れろ！」 — 背後の声を聞き取った', tone: 'them' });
          lines.push({ text: `情報: 抵抗を続ける犯人 ${list.length} 名。気配がある場所 — ${rooms.join('、') || '不明'}`, tone: 'good' });
          return [...lines, ...spend(+5, 0)];
        }
        lines.push({ text: '犯人「何を探ってやがる」', tone: 'them' });
        lines.push({ text: '情報は得られなかった（緊張 +10）', tone: 'bad' });
        return [...lines, ...spend(+10, -5)];
      },
    },
    {
      icon: '⚡',
      label: '最後通告（威圧）',
      desc: '全犯人を動揺させ、突入時に投降しやすくする。緊張が大きく上がるので使いどころに注意',
      effects: () => ({ gain: ['全犯人の士気 -15'], cost: ['緊張 +30', '信頼 -10'], warn: tensionWarn(30) }),
      disabledReason: () => null,
      run: () => {
        for (const s of active()) s.adjustMorale(-15);
        results.push('最後通告で犯人の士気低下');
        return [
          { text: 'あなた「建物は完全に包囲した。10 分以内に出てこなければ突入する」', tone: 'me' },
          { text: '犯人「脅しやがって……！」 — 動揺が伝わってくる', tone: 'them' },
          { text: '犯人の士気 -15 / 緊張 +30', tone: 'info' },
          ...spend(+30, -10),
        ];
      },
    },
  ];

  return {
    title: '突入前交渉 — 立てこもり犯との通話',
    subtitle:
      '突入前に電話で犯人と交渉できる。信頼を築けば人質の解放や投降を引き出せ、威圧すれば突入時に降伏させやすくなる。犯人の緊張が限界を超えると人質が殺害される。',
    intro: [
      { text: '犯人「誰だ！ 近づいたら人質を撃つぞ！」', tone: 'them' },
      { text: `状況: 人質 ${ctx.hostages().length} 名`, tone: 'info' },
    ],
    meters: () => [
      { label: '犯人の緊張', value: tension, max: 100, color: tension < 50 ? '#5cd67d' : tension < 80 ? '#f2c14e' : '#ff5555', hint: '100 で人質が殺害され交渉決裂' },
      { label: '信頼', value: trust, max: 100, color: '#7ce2f0', hint: '高いほど解放・投降・情報が成功しやすい' },
      { label: '人質', value: ctx.hostages().length, max: Math.max(1, ctx.hostages().length), color: '#f2a65a', text: `${ctx.hostages().length} 名`, hint: '救出できれば加点' },
    ],
    turnsLeft: () => (broken ? 0 : turns),
    isOver: () => broken,
    options,
    finishLabel: '交渉を終えて突入開始',
    summary: () => [broken ? '交渉は決裂した。' : '交渉は終了した。', `結果: ${results.length > 0 ? results.join(' / ') : '特になし'}`],
  };
}
