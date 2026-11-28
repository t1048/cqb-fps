# 撃ち合いの間・ベストの重さ・籠城の消耗・救急キット 設計書

- 作成日: 2026-11-28
- 区分: C（文書）。本書は設計だけを扱い、`src/`・`public/` は変更しない。製造は §8 の順序で WP1〜WP4（WP3 は 3a・3b の 2 依頼）に分ける。
- 起点: ディレクターのプレイでの指摘。「撃たれて約 0.4 秒で倒れる」「ベストに損がないので選ばない自由がない」。
- 前提（現行方針）: 実装後はテストを書かず回さず、「開けること」（`npm run build` = `tsc --noEmit && vite build` が終了 0）だけを確かめる。審査は実装したモデルとは別のモデルが 1 回、コードを読んで行う。動作はディレクターのプレイで確かめる。既存テストは消さない。
- 依頼書に書く区分: WP1〜WP4 はすべて **A（遊ぶ人に影響する製品コード）**。

## 設計の柱

1. **死ぬのは運ではなくミスのせい。** 不意に撃たれても 1 秒以内に遮蔽へ戻れば生き残れる。死ぬのは、待ち構えた敵の前へ出たときと、撃たれた後も身を晒し続けたとき。
2. **準備の選択が戦い方を変える。** ベストあり＝正面で耐える型（重く、遅く、うるさい）。ベストなし＝罠と奇襲の型（速く、静か）。
3. **籠城の時間が両陣営を削る。** 消耗した側は狙いが乱れ、反応が遅れる。回復するには、相手に何かを渡す必要がある。

---

## 0. 調査した現行契約（実装前に必ず読み直すこと）

行番号は目安。実装時は関数名で探す。リーン新方式（`leanProgress`・`lean.outSec/returnSec`）と胸狙い（`EngageBehavior.ts`）は作業ツリーに既にある前提で、WP1〜WP4 はその上に積む。

### 0.1 被弾（プレイヤー）

| 項目 | 現行 | 根拠 |
|---|---|---|
| 被弾の入口 | `PlayerController.takeDamage(amount, hitY)` | `src/player/PlayerController.ts:133-151` |
| 頭部判定 | `hitY >= 目線 - wounds.headBand(0.28)` で ×`headMultiplier`(3.6)。両モード共通 | `src/rules/wounds.ts:18-25`、`public/data/player.json` の `wounds` |
| ベスト | 胴体だけ、`armorAbsorb`（耐久残量に比例して `absorb` 0.6 → `minAbsorb` 0.35）の割合を耐久で肩代わり。頭は対象外 | `PlayerController.ts:91-109,140-147` |
| ベストの装着 | `equipArmor(points)`。既存より耐久が高いときだけ更新。SWAT は `main.ts:269` で `swatIssue`(50)、容疑者は交渉で `suspectVest`(50) | `src/main.ts:269,553` |
| 移動速度 | `speeds[mode] × speedMultiplier × externalMoveScale × woundSpeedMul` | `PlayerController.ts:232` |
| 足音 | `footstep.radius[mode]` の `noise` イベント（AI が聞く） | `PlayerController.ts:240-248` |
| リーン | 現行は `lean.lerpSpeed`(12) の指数補間。**新方式は作業ツリーに入っている（済）**: `lerpSpeed` を廃止し、`lean.outSec` = 0.38（中央→最大）・`lean.returnSec` = 0.30（最大→中央）の一定速度の進捗（`leanProgress`）＋smoothstep（反対側への切り替えは中央を通る）。WP2 はこれの上に作る | `PlayerController.ts:259-268`（変更後の位置は実装時に読み直す） |
| 視点の揺れ | 負傷時だけ `applyCamera` でカメラを揺らす（**射撃方向は yaw/pitch のままで、揺れは見た目だけ**） | `PlayerController.ts:476-490`、`WeaponSystem.ts:284-293` |
| HUD | `HP n  防弾 m`（`armor > 0` のときだけ「防弾」を出す） | `src/ui/Hud.ts:597-604` |

### 0.2 敵の射撃

| 項目 | 現行 | 根拠 |
|---|---|---|
| 発砲 | `EngageBehavior.fire(threat, known)`。拡散は `baseSpreadDeg × spreadMul` の円錐で一様 | `src/ai/EngageBehavior.ts:1219-1300` |
| 狙い点 | `findNearestVisibleThreat` の `threat.point`。**未コミットの変更で「胸（目線 −0.6 m）が見えれば胸、目だけ見えるときだけ目」**にしてある。この変更は作業ツリーに既にある前提（WP1 では触らない） | `EngageBehavior.ts:279-320`（作業ツリーの差分） |
| 待ち伏せ（preAim） | `armPreAim(shots, spreadMul)` → 次の `enter()` で即射撃。最初の `firstBurstShots` 発は拡散 ×`firstBurstSpreadMul`(0.40〜0.55) | `EngageBehavior.ts:934-975`、`Suspect.ts:1274-1276` |
| `fireAt` の呼び手 | `Suspect.ts:1180`（視認脅威）・`Suspect.ts:1322`（脅威なし）、`SwatHunter.ts:1093`、`swatTacticsCoordinator.ts:1024`（制圧射撃、脅威なし）、`swatObstacles.ts:89`（バリケード） | — |
| `update` の呼び手 | Suspect は FSM の ENGAGE の `update`（`Suspect.ts:225`）、SwatHunter は `SwatHunter.ts:982`。**`fireAt` は `update` を通らずに呼ばれることがある** | — |
| 敵 SWAT の値 | `BASE_SWAT_COMBAT`（TS の定数。`fireInterval` 0.2、`shotDamage` 13、`baseSpreadDeg` 3.2、`shotsPerPeek` 4、入室時の即射 3 発） | `src/ai/SwatProfile.ts:8-31`、`SwatHunter.ts:286-300` |
| 盾持ち | `BASE_SHIELD_COMBAT`（0.32 / 9 / 2.6°） | `SwatProfile.ts:53-67` |
| 容疑者 AI の値 | `ai_profiles.json` の `combat`。臆病な強盗 0.45 / 14 / 5.5°、強硬なリーダー 0.3 / 18 / 3.6°、武装した過激派 0.36 / 16 / 4.2° | `public/data/ai_profiles.json` |
| 味方隊員（SWAT モード） | `Squad.ts:480` でも `EngageBehavior` を使う（容疑者を撃つ側） | — |

### 0.3 反応時間・士気・拡散の書き換え（容疑者 AI）

- 視認から CONFRONTATION までの時間は `Perception.ts:201` の `need = profile.reactionTime × (警戒時の倍率)`。待ち伏せ中は `ambushReactionSec` と小さい方（`Perception.ts:209`）。
- 拡散は `Suspect.syncGasCombatParams()` が `combat.baseSpreadDeg = baseSpreadDeg + ガス補正` に毎回書き戻す（`Suspect.ts:384-388`）。武器改造は `baseSpreadDeg` を倍率で変える（`Suspect.ts:497-502`）。
- 士気は `Suspect.adjustMorale(delta)`（`Suspect.ts:491-495`、`managed` のときだけ効く）。

### 0.4 交渉

- 容疑者モード: `buildSuspectNegotiation`（`src/modes/PreAssaultNegotiation.ts:39-490`）。忍耐 100、6 ターン。選択肢 6 個（時間稼ぎ・人質と交換 ×3・鼓舞・脅迫）。人質の交換は `trade()` が共通処理（人質 −1、仲間の士気 −10、忍耐 +dp）。
- **既存の不一致**: 防弾チョッキの説明文が「耐久 70」だが、実際の値は `player.json` の `suspectVest` = 50。WP2 で説明文を設定値から作るように直す。
- SWAT モード: `buildSwatNegotiation`（同 `:510-904`）。緊張 45・信頼 10。「信頼構築（食料・水を差し入れ）」は何度でも選べ、緊張 −15・信頼 +20・犯人の士気 +4。
- 交渉画面の数字キーは `Digit1〜9`（`NegotiationPhase.ts:493`）。容疑者モードの選択肢は本設計で 8 個になり、9 以内に収まる。
- 容疑者モードの流れ: 交渉 → `startMission()`（籠城の準備時間が始まる）→ 準備時間が尽きると `SuspectMode.ts:344` で `team.beginAssault()`（突入）。

### 0.5 入力

- キーの割り当ては `src/core/InputManager.ts:29-57` の `DEFAULT_ACTION_MAP`（利用者が変えられる設定画面はない）。使用中のキーは `DEFAULT_ACTION_MAP` と `main.ts` の直接判定（Escape・P）、`Minimap.ts`（M）を参照。
- **空いていて、ゲーム内で使うキーと衝突しないもの: `KeyH`**。WP4 の救急キットに使う。
- `ItemKind` の `'medkit'`（`types.ts:87`）はマップに置く物の種類で、本設計の救急キット（所持数）とは別物。触らない。

---

## 1. 数値の根拠（WP1・WP2 の目標の計算）

### 1.1 計算の模型

- プレイヤーの当たり判定（しゃがみは立ちと同じ横幅の計算）: 幅 0.6 m（`radius` 0.3）× 高さ 1.75 m（足元 0〜目線 1.6 + 頭 0.15）の箱。狙い点は胸（目線 −0.6 m = 1.0 m）。狙い点から見て、上 +0.75 m・下 −1.0 m・左右 ±0.3 m に当たれば命中、上 +0.32 m 以上は頭部（`headBand` 0.28 により、目線 1.6 − 0.28 = 1.32 m 以上）。
- 距離 d での散布: 円錐（半角 s）の中で一様 → 弾着は半径 R = d·tan(s) の円内でほぼ一様。
- 横幅 a = 0.3 m の帯に入る確率（円の半径 R > a のとき）:
  `P(hit) = (2/π) × ( asin(a/R) + (a/R)·√(1 − (a/R)²) )`、R ≤ a なら 1。
- 時間は「**自分に向けた最初の弾が撃たれた時刻**」を 0 とする（理由は §1.4 と未決 U1）。敵は間隔 `fireInterval` で撃ち続ける（`shotsPerPeek` で遮蔽に戻る効果は入れない＝実際より厳しい側の見積り）。
- 確認は手計算と同じ模型のモンテカルロ（各条件 40,000 回）。表は推定で、プレイヤーの動き・リーンは入れていない。

### 1.2 現状（胸狙い・収束なし）

SWAT（4 m、R = 4·tan 3.2° = 0.22 m < 0.3 m）は毎発ほぼ命中する。1.0 秒で 5 発 × 13 = 65 → **残り HP 35**。強硬なリーダー（4 m）は 4 発 × 18 = 72 → **残り HP 28**。胸狙いだけでは目標の 40 に届かない。

### 1.3 収束あり（WP1 の規則。横方向だけ広がる）

収束の倍率 `mulH(t) = 1 + (3.0 − 1) × max(0, 1 − t / 1.0)`。縦は広げない（`verticalShare` = 0。理由は §1.5）。

手計算（4 m、SWAT）:

| 発 | t (s) | mulH | 横の半径 R (m) | P(命中) |
|---|---|---|---|---|
| 1 | 0.0 | 3.0 | 0.67 | 0.55 |
| 2 | 0.2 | 2.6 | 0.58 | 0.63 |
| 3 | 0.4 | 2.2 | 0.49 | 0.72 |
| 4 | 0.6 | 1.8 | 0.40 | 0.85 |
| 5 | 0.8 | 1.4 | 0.31 | 0.99 |

期待命中 3.74 発 × 13 = 49 → **残り HP 約 51**。縦の半径は 0.22 m のままで、頭部（+0.32 m）にも足元の外（−1.0 m）にも届かないので、頭部による即死は起きない。

強硬なリーダー（4 m、0.3 秒間隔）: t = 0, 0.3, 0.6, 0.9 で P = 0.49, 0.61, 0.78, 1.00 → 期待 2.87 発 × 18 = 52 → **残り HP 約 48**。

モンテカルロ（1.0 秒間さらされたときの平均残り HP / HP 40 以上の割合 / 死亡率。ベストなし、連射の打ち切りなし）:

| 敵 | 3 m | 5 m | 8 m |
|---|---|---|---|
| 敵 SWAT | 43 / 48% / 0% | 59 / 92% / 0% | 64 / 86% / 2% |
| 強硬なリーダー | 39 / 53% / 0% | 56 / 89% / 0% | 60 / 74% / 8% |
| 武装した過激派 | 64 / 100% / 0% | 74 / 95% / 0% | 77 / 91% / 1% |
| 臆病な強盗 | 72 / 100% / 0% | 75 / 88% / 1% | 81 / 91% / 2% |

- **結論（単独の射手を想定した見積り。複数の敵が同時に撃てばその分減る。保証しない。最終の合否はプレイで決める）: 4 m 以上なら、ベストなしでも 1.0 秒で遮蔽に戻れば平均で HP 40% 以上が残る見込み。** 3 m の至近では SWAT・リーダーが平均 39〜43 で「概ね 40%」。実際は `shotsPerPeek`（SWAT の入室時は 3 発）で連射が切れるので、これより残る。
- 8 m の死亡 2〜8% は基本の拡散が頭部に届く距離だから（現状と同じ。変えない）。

### 1.4 「最初の命中から 1.0 秒」では目標を満たせない（数学的な限界）

敵 SWAT は 0.2 秒間隔で、最初の命中から 1.0 秒に 5 発撃つ。収束後に最初の命中が来れば 5 発 × 13 = 65 で、どんな拡散でも残り HP は 35 にしかならない。そこで時刻 0 は「自分に向けた初弾が撃たれた時刻」と解釈した（U1）。

### 1.5 縦にも広げると、運で死ぬ

円で ×3.0 に広げると、至近で弾が頭部に散る。強硬なリーダーの 3〜5 m で 1.0 秒以内の死亡が 21〜23%（収束なしでは 0%）になり、柱 (1) に反する。広げるのは横だけにし、縦の割合を `verticalShare`（0 = 横だけ、1 = 円）として JSON に出す。既定は 0（U2）。

### 1.6 ミスをしたとき（待ち構えた敵・晒し続け）

4 m、平均残り HP / 死亡率。「収束済み」は preAim 中の敵、または 1.2 秒以内に同じ敵の前へ出直したとき。

| さらした時間 | 敵 SWAT（収束から） | 敵 SWAT（収束済み） | リーダー（収束から） | リーダー（収束済み） |
|---|---|---|---|---|
| 1.0 s | 51 / 0% | 35 / 0% | 48 / 0% | 28 / 0% |
| 1.5 s | 13 / 21% | 0 / 100% | 30 / 0% | 10 / 0% |
| 2.0 s | 1 / 91% | 0 / 100% | 4 / 69% | 0 / 100% |

preAim はこれに `firstBurstSpreadMul`(0.4〜0.55) が掛かり頭部も狙える精度になる。**「待ち構えた敵の前に出る」「撃たれても出続ける」が死ぬ理由になる。**

### 1.7 ベストの差（WP2）

4 m、収束あり、撃たれ始めからの時間。平均残り HP / 死亡率。

| さらした時間 | 敵 | ベストなし | 耐久 50 | 耐久 80 |
|---|---|---|---|---|
| 1.0 s | 敵 SWAT | 51 / 0% | 78 / 0% | 79 / 0% |
| 2.0 s | 敵 SWAT | 1 / 91% | 36 / 0% | 45 / 0% |
| 3.0 s | 敵 SWAT | 0 / 100% | 0 / 99% | 5 / 63% |
| 2.0 s | リーダー | 4 / 69% | 42 / 0% | 49 / 0% |
| 3.0 s | リーダー | 0 / 100% | 3 / 69% | 16 / 23% |

- ベストは「2 秒の撃ち合いを生き延びる」力を与える（ベストなしの死亡 69〜91% → 0%）。耐久 80 は 3 秒の撃ち合いで差が出る（死亡 99% → 63%）。これが「正面で耐える型」。
- 代わりに容疑者ベストは、走り 2.95 → 2.60 m/s、足音の半径 12 → 15 m（静音・しゃがみ 3 → 3.75 m）、リーンの出 0.38 → 0.475 秒・戻り 0.30 → 0.375 秒。遮蔽へ 1 m 戻る時間は 0.34 → 0.38 秒。罠と奇襲がしにくくなる。

---

## 2. WP1 撃ち合いの「間」（照準の収束）

### 2.1 目的

敵が同じ標的へ撃ち始めた直後は弾が横に散り、約 1.0 秒で締まる。不意の遭遇で 1.0 秒以内に遮蔽へ戻れば、ベストなしでも HP が概ね 40% 以上残る見込み（単独の射手を想定した見積り。複数の敵が同時に撃てばその分減る。保証しない。最終の合否はプレイで決める。§1.3）。待ち構えていた敵（preAim）は最初から締まっている。

### 2.2 触るファイルと関数（9 ファイル）

| # | ファイル | 関数・箇所 | 変更 |
|---|---|---|---|
| 1 | `src/ai/EngageBehavior.ts` | `findNearestVisibleThreat` | 作業ツリーの胸狙いは既にある前提（変更しない） |
| 〃 | 〃 | `EngageOptions`、`EngageBehavior` のフィールド、`armPreAim`/`enter`/`exit`、新規 `tickAim(dt, visibleTargetId)`、`fire` | 収束の状態と、楕円の散布 |
| 2 | `src/ai/Suspect.ts` | コンストラクタ（`new EngageBehavior` の `opts`）、`update` | `aimSettle` を渡す。毎フレーム 1 回 `tickAim` を呼ぶ |
| 3 | `src/modes/swat/SwatHunter.ts` | コンストラクタ（`opts`）、`update` | `this.team.aimSettle` を `opts` に入れる。毎フレーム `tickAim` |
| 4 | `src/modes/swat/swatTypes.ts` | `SwatTeamHost`（`SwatTeamDeps` が別の型なら同名で足す） | `readonly aimSettle?: AimSettleParams` を足す |
| 5 | `src/modes/SwatTeam.ts` | getter | `get aimSettle()` が `this.d.aimSettle` を返す |
| 6 | `src/main.ts` | `new SwatTeam({...})` | `aimSettle: data.swatAimSettle` を渡す |
| 7 | `src/core/types.ts` | `AimSettleParams`（新規）、`CombatParams.aimSettle?`、`GameData.swatAimSettle` | 型 |
| 8 | `src/core/DataLoader.ts` | `readCombat`、新規 `readAimSettle`・`validateSwatAimSettle`・`DataLoader.loadSwatAimSettle`、`loadAll` | 検証と読み込み |
| 9 | `public/data/ai_profiles.json` | 容疑者 3 プロファイルの `combat.aimSettle`、最上位 `swatAimSettle` | 値 |

味方隊員（`Squad.ts`）には渡さない（`aimSettle` なし＝現状どおり）。

### 2.3 データ

`public/data/ai_profiles.json`:

```jsonc
// profiles[] の type="suspect" の 3 件（nervous_robber / hardcore_leader / armed_militant）の combat に追加
"aimSettle": { "startMul": 3.0, "settleSec": 1.0, "resetSec": 1.2, "verticalShare": 0.0 }

// 最上位（"profiles"・"suspectAlert" と並べる）に追加。敵 SWAT（ライフル・盾持ちの両方）に使う
"swatAimSettle": { "startMul": 3.0, "settleSec": 1.0, "resetSec": 1.2, "verticalShare": 0.0 }
```

`src/core/types.ts`:

```ts
/** 照準の収束（ai_profiles.json の combat.aimSettle / swatAimSettle）。時間 s、倍率は無次元。 */
export interface AimSettleParams {
  /** 標的へ撃ち始めた瞬間の横方向の拡散倍率（>= 1） */
  startMul: number;
  /** 倍率が 1.0 まで縮むまでの時間（撃ち始めから。線形） */
  settleSec: number;
  /** 標的を連続でこの秒数見失ったら収束をリセット */
  resetSec: number;
  /** 縦方向にも広げる割合（0 = 横だけ、1 = 円で広げる） */
  verticalShare: number;
}
// CombatParams に追加
  aimSettle?: AimSettleParams;
// GameData に追加
  swatAimSettle: AimSettleParams;
```

`src/core/DataLoader.ts`:

- `export const DEFAULT_AIM_SETTLE: AimSettleParams = { startMul: 3.0, settleSec: 1.0, resetSec: 1.2, verticalShare: 0.0 }`。
- `readAimSettle(r, o, path)`: 値が無ければ `DEFAULT_AIM_SETTLE` の写し。範囲は `startMul` 1〜6、`settleSec` 0.1〜5、`resetSec` 0.1〜10、`verticalShare` 0〜1（`r.numOr`）。
- `readCombat`: 容疑者の `combat` は `aimSettle` が無くても既定値を入れる（容疑者は必ず収束あり）。
- `validateSwatAimSettle(raw, source = 'ai_profiles')`: `validateSuspectAlert`（`:2119`）と同じ形で、最上位の `swatAimSettle` を読む。`DataLoader.loadSwatAimSettle()` は `loadCachedStatic('ai_profiles.json', validateSwatAimSettle)`。`loadAll` の `Promise.all` に足し、`GameData` に入れる。

### 2.4 振る舞いの規則

EngageBehavior に持たせる状態: `settle: AimSettleParams | null`（`opts.aimSettle`）、`settleTargetId: string | null`、`settleElapsed`（秒）、`settleUnseen`（秒）、`preAimPending: boolean`。

1. **`tickAim(dt, visibleTargetId)`**（公開）: 持ち主（Suspect / SwatHunter）が**毎フレーム 1 回**、射撃の処理より前に呼ぶ。`EngageBehavior.update` の中では呼ばない（二重に進めないため）。
   - `settle` が null、または `settleTargetId` が null なら何もしない。
   - `visibleTargetId === settleTargetId` なら `settleUnseen = 0`、違えば `settleUnseen += dt`。
   - `settleUnseen >= resetSec` なら `settleTargetId = null`（リセット）して終わる。
   - それ以外は `settleElapsed += dt`（見えていない間も、リセット前なら収束は進む。隠れて 1.2 秒以内に同じ場所から出直すと、締まった弾を浴びる）。
2. **`fire` の倍率**: 標的の鍵は `threat?.id`。
   - `settle` が null、`threat` が null（制圧射撃・最後の把握位置への射撃）、または `!threat.isPlayer`（NPC 同士・バリケード射撃）なら `mulH = mulV = 1`（現状どおり）。状態は変えない。収束は `threat.isPlayer` の標的にだけ使う。
   - `threat.id !== settleTargetId` なら新しい標的: `settleTargetId = threat.id`、`settleUnseen = 0`、`settleElapsed = preAimPending ? settleSec : 0`、`preAimPending = false`。
   - 標的が同じでも `preAimPending` なら `settleElapsed = max(settleElapsed, settleSec)`、`preAimPending = false`。
   - `mulH = 1 + (startMul − 1) × max(0, 1 − settleElapsed / settleSec)`、`mulV = 1 + (mulH − 1) × verticalShare`。
3. **楕円の散布**: 角度の抽選は現状の式のまま、半角 = `baseSpreadDeg × spreadMul(preAim の初弾)` で `angle`・`around` を引く。方向は、射線 `shotDir` に直交する「水平の右」`right = normalize(shotDir × (0,1,0))`（`|shotDir.y| > 0.99` のときは `(1,0,0)`）と「上」`up = right × shotDir` を明示して作る:
   `dir = normalize( shotDir + right × (tan(angle)·cos(around)·mulH) + up × (tan(angle)·sin(around)·mulV) )`。
   現行の `quat.setFromUnitVectors` は傾いた射線で横軸が回るため使わない（`mulH = mulV = 1` のときは現行と同じ分布になる）。
4. **preAim**: `enter()` の `if (preAimShots > 0)` の中、`spreadBurstLeft` を立てる箇所でだけ `preAimPending = true`（`armPreAim` 自体は変えない）。`exit()` で `preAimPending = false`。初弾の `firstBurstSpreadMul` は今までどおり掛かる（収束済み × 0.4〜0.55）。
5. `onHit`（敵が撃たれた）では収束は変えない。
6. 標的は 1 人だけ覚える。味方隊員 → プレイヤーと標的を替えると、プレイヤーへの弾はまた広がりから始まる。
7. NPC 同士の撃ち合い・バリケード射撃には収束を使わない（従来どおり。2. の `threat.isPlayer`。U8）。

Suspect / SwatHunter:

- Suspect: コンストラクタで `opts = { aimSettle: this.combat?.aimSettle }` を渡す。`update` の中で、視認脅威（`visibleThreat`）を決めた後・`fsm.update(dt)` の前に `this.engage?.tickAim(dt, this.visibleThreat?.id ?? null)`（`visibleThreat` の更新順は実装者が `Suspect.ts:1020-1036` で確かめ、その後に置く）。
- SwatHunter: 既存の `opts` に `aimSettle` を足す（盾持ちも同じ値）。`update` の毎フレームで `this.engage.tickAim(dt, this.sees ? (this.threat?.id ?? null) : null)`。

### 2.5 境界条件

| 条件 | 振る舞い |
|---|---|
| 撃ち始めの瞬間（t = 0） | `mulH = startMul`（3.0） |
| `settleElapsed >= settleSec` | `mulH = 1.0`（それ以上は縮まない） |
| ちょうど 1.2 秒見失う | `>=` でリセット |
| `startMul = 1` | 収束なしと同じ（現状どおり） |
| `verticalShare = 1` | 決定事項の文字どおりの円の拡散 |
| `fireAt` が `update` を通らずに呼ばれる | `tickAim` は持ち主が毎フレーム呼ぶので時間は進む |
| 持ち主が `tickAim` を呼ばない（味方隊員） | `settle` が null なので現状どおり |
| ガス・武器改造・消耗（WP3）で `baseSpreadDeg` が変わる | 収束の倍率はその上に掛かる |
| 頭しか見えない（狙い点が目） | 倍率は同じ。縦は広がらないので、覗いた頭へは基本の精度で飛ぶ（覗きは今までどおり危ない） |

### 2.6 壊してはいけない契約

- `findNearestVisibleThreat` の戻り値の形（`point`）。既存テスト（`tests/` 内の EngageBehavior・待ち伏せ関連）は実行しないが、消さない。
- `mulH = mulV = 1` のとき、散布の分布が現行と同じであること（審査で式を見る）。

### 2.7 ディレクターがプレイで確かめる点

1. 不意に撃たれてすぐ遮蔽に戻ると、HP が半分前後残る（「一瞬で倒れる」が無くなったか。単独の射手の見積りで、複数の敵なら減る。合否はこのプレイで決める）。
2. 撃たれた後に出続ける・同じ場所から 1 秒以内に覗き直すと、倒される（ミスが罰になるか）。
3. 入口を待ち構えた容疑者の前に無警戒で出ると、ほぼ即座に倒される。

---

## 3. WP2 ベストの重さ

### 3.1 目的

ベストに重さの代償を付け、選ばない自由を作る。容疑者ベストは重く（遅い・うるさい・リーンが遅い）、耐久 80。SWAT 支給は軽く（移動 ×0.95 だけ）、耐久 50 のまま。

### 3.2 触るファイルと関数（7 ファイル）

| # | ファイル | 関数・箇所 | 変更 |
|---|---|---|---|
| 1 | `public/data/player.json` | `armor` | `suspectVest` 50 → 80、`weight` を追加 |
| 2 | `src/core/types.ts` | `ArmorKind`・`ArmorWeight`（新規）、`ArmorConfig.weight` | 型 |
| 3 | `src/core/DataLoader.ts` | `DEFAULT_ARMOR`、`readArmor` | 既定値と検証 |
| 4 | `src/player/PlayerController.ts` | `equipArmor`、新規 `armorKind`・`armorWeight` の getter、`update`（速度・足音・リーン） | 重さの効果 |
| 5 | `src/main.ts` | `:269`、`:553-554` | 種類を付けて装着、`hasArmor`、`vestSpec` |
| 6 | `src/modes/PreAssaultNegotiation.ts` | `SuspectNegotiationContext`、「人質と交換: 防弾チョッキ」 | 説明文を設定値から作る、損を書く |
| 7 | `src/ui/Hud.ts` | HP 表示（`:597-604`） | 装着中の印（破損も表示） |

### 3.3 データ

`public/data/player.json` の `armor`:

```jsonc
"armor": {
  "absorb": 0.6,
  "minAbsorb": 0.35,
  "swatIssue": 50,
  "suspectVest": 80,
  "weight": {
    "swatIssue":   { "speedMul": 0.95, "footstepRadiusMul": 1.0,  "leanSpeedMul": 1.0 },
    "suspectVest": { "speedMul": 0.88, "footstepRadiusMul": 1.25, "leanSpeedMul": 0.8 }
  }
}
```

`src/core/types.ts`:

```ts
export type ArmorKind = 'swatIssue' | 'suspectVest';
/** ベストの重さの代償（装着中ずっと効く。耐久が尽きても脱げない） */
export interface ArmorWeight {
  /** 移動速度の倍率 (0..1] */
  speedMul: number;
  /** 足音の noise 半径の倍率 (>= 1) */
  footstepRadiusMul: number;
  /** リーンの速さの倍率 (0..1]。lean.outSec・lean.returnSec をこの値で割る（0.8 → 時間 1.25 倍） */
  leanSpeedMul: number;
}
// ArmorConfig に追加
  weight: Record<ArmorKind, ArmorWeight>;
```

`src/core/DataLoader.ts`:

- `DEFAULT_ARMOR` の `suspectVest` を 80 にし、`weight` に上の値を入れる。
- `readArmor`: `weight` が無ければ既定値。`weight.swatIssue`・`weight.suspectVest` は片方だけでも可（無い方は既定値）。範囲は `speedMul` 0.3〜1、`footstepRadiusMul` 1〜3、`leanSpeedMul` 0.2〜1。

### 3.4 振る舞いの規則

PlayerController:

1. `equipArmor(points: number, kind: ArmorKind = 'swatIssue')`: 既にベストを着ていれば（`armorKind !== null`）何もしない。`points > 0` なら `armor = armorMax = points`、`armorKind = kind`。
2. `get armorKind(): ArmorKind | null`（公開・読み取りのみ）。`get armorWeight(): ArmorWeight`（未装着なら `{1, 1, 1}`）。
3. **重さは装着中ずっと効く**（耐久が 0 になっても。未決 U9）。
4. 速度: `speeds[mode] × speedMultiplier × externalMoveScale × woundSpeedMul × armorWeight.speedMul`（WP3 で消耗、WP4 で救急キットの上限が加わる）。
5. 足音: `radius = footstep.radius[mode] × armorWeight.footstepRadiusMul`。足音の間隔は変えない。
6. リーン（新方式は作業ツリーに入っている）: 出の時間 = `lean.outSec ÷ armorWeight.leanSpeedMul`、戻りの時間 = `lean.returnSec ÷ armorWeight.leanSpeedMul`（容疑者ベスト 0.8 → 0.475 秒・0.375 秒）。一定速度の進捗＋smoothstep、反対側への切り替えは中央を通る、という新方式の規則はそのまま使い、時間だけを差し替える。最大量（`maxOffset`）は変えない。壁による押し戻し（`leanClearance`）は今までどおり即時。`leanSpeedMul = 1` なら新方式と同じ。

main.ts:

- `:269` → `this.player.equipArmor(playerCfg.armor.swatIssue, 'swatIssue')`。
- `:553` → `giveArmor: () => this.player.equipArmor(playerCfg.armor.suspectVest, 'suspectVest')`。
- `:554` → `hasArmor: () => this.player.armorKind !== null`。
- 新規 `vestSpec: () => ({ durability: playerCfg.armor.suspectVest, absorbPct: Math.round(playerCfg.armor.absorb * 100), ...playerCfg.armor.weight.suspectVest })`。

PreAssaultNegotiation（容疑者モード「人質と交換: 防弾チョッキ」）:

- `SuspectNegotiationContext` に `vestSpec(): { durability: number; absorbPct: number; speedMul: number; footstepRadiusMul: number; leanSpeedMul: number }` を足す。
- 説明文を設定値から作る。例:「被弾ダメージの 60% を肩代わり（耐久 80）。重いので移動 −12%・足音が 25% 遠くまで届き・リーンが遅くなる。人質を手放すので盾が減り、仲間も動揺する」。
- `effects.cost` に `hostageCost()` に加えて `移動 −12%` と `足音 +25%・リーン遅く` を出す（％は `(1 − speedMul) × 100` などから丸めて作る）。

Hud:

- `armorKind !== null` のとき: `armor > 0` → `HP n  防弾 m`、`armor = 0` → `HP n  防弾 破損`。容疑者ベストのときは後ろに `（重）` を付ける。未装着は `HP n`。
- 再描画のキー（`lastHp`）に `armorKind` と破損の状態を含める（WP4 で `medkit` の数も足す）。

### 3.5 境界条件

| 条件 | 振る舞い |
|---|---|
| 交渉でベストを 2 回選ぶ | 既存の `disabledReason`（`hasArmor`）で選べない |
| ベストの耐久が 0 | 肩代わり 0、重さは残る、HUD は「破損」 |
| 負傷の速度低下（SWAT モード）と重ねる | 掛け算（SWAT 支給 ×0.95 × 負傷 ×0.75 など） |
| しゃがみ・静音 | 各モードの速度・足音の半径に同じ倍率 |
| `footstepRadiusMul = 1` | 足音は現状どおり |
| リーン中にベストを着る（交渉は開始前なので通常は起きない） | 次の出・戻りから新しい時間を使う。途中の進捗は保つ |

### 3.6 ディレクターがプレイで確かめる点

1. 容疑者モードでベストを着ると、走りが少し遅く、リーンが重く感じる。着ないと軽く速い。
2. ベストを着ていると、静音で歩いても SWAT に気づかれやすい（気づかれる距離が延びた感覚があるか）。
3. ベストを着ていると、正面の撃ち合いで 2 秒ほど持ちこたえられる。HUD に「防弾」と、壊れたら「破損」が出る。

---

## 4. WP3 籠城の消耗

### 4.1 目的

籠城開始から数時間（6 時間目）が経った設定で、「消耗」0〜100 を始め 55 にする。消耗は、容疑者モードではプレイヤーと仲間の容疑者に、SWAT モードでは容疑者 AI に効く。回復（→15）には、相手に有利を渡す取引が要る。

WP3 は大きいので 2 依頼に分ける。**3a = 消耗の値と効果（交渉は触らない。常に 55）**、**3b = 交渉の選択肢と偵察**。

### 4.2 共通の値（3a で作る）

新規ファイル `public/data/siege.json`:

```jsonc
{
  "startFatigue": 55,        // 消耗の開始値（交渉で差し入れを受けなければ、このまま突入）
  "supplyFatigue": 15,       // 水・食料の差し入れを受けた後の値
  "startHour": 6,            // 交渉画面に出す「籠城 N 時間目」
  "player": {                // プレイヤー（容疑者モードだけ）
    "tiers": [50, 75],       // この値以上で段階 1 / 段階 2
    "swayDeg": [0.10, 0.22], // 段階別のカメラの揺れ（度）
    "spreadAddDeg": [0.4, 0.9], // 段階別の射撃拡散の加算（度）
    "reloadMul": [1.15, 1.3],   // 段階別の装填時間の倍率
    "speedMul": [1.0, 0.92]     // 段階別の移動速度の倍率
  },
  "ai": {                    // 容疑者 AI（両モード）。正規化値 n = 消耗 / 100
    "spreadMulPerNorm": 0.3,     // 拡散 ×(1 + 0.3 × n)
    "reactionAddSecAt100": 0.27, // 反応時間 + 0.27 × n 秒（55 で約 +0.15 秒、15 で約 +0.04 秒）
    "moralePenaltyAt100": 20     // 突入開始時に士気 −20 × n（55 で −11、15 で −3）
  }
}
```

段階 0（消耗 < 50）の効果は「なし」（揺れ 0・加算 0・倍率 1）。

型（`src/core/types.ts`）:

```ts
export interface SiegePlayerFatigue {
  tiers: [number, number];
  swayDeg: [number, number];
  spreadAddDeg: [number, number];
  reloadMul: [number, number];
  speedMul: [number, number];
}
export interface SiegeAiFatigue { spreadMulPerNorm: number; reactionAddSecAt100: number; moralePenaltyAt100: number; }
export interface SiegeConfig {
  startFatigue: number;
  supplyFatigue: number;
  startHour: number;
  player: SiegePlayerFatigue;
  ai: SiegeAiFatigue;
}
// GameData に追加
  siege: SiegeConfig;
```

検証（`src/core/DataLoader.ts`、新規 `DEFAULT_SIEGE`・`validateSiege`・`DataLoader.loadSiege()`、`loadAll` に足す）:

| キー | 範囲・条件 |
|---|---|
| `startFatigue`・`supplyFatigue` | 0〜100。`supplyFatigue <= startFatigue` でなければ `fail` |
| `startHour` | 整数 1〜72 |
| `player.tiers` | 各 0〜100、`tiers[0] <= tiers[1]` |
| `player.swayDeg` | 0〜5 |
| `player.spreadAddDeg` | 0〜10 |
| `player.reloadMul` | 1〜3 |
| `player.speedMul` | 0.3〜1 |
| `ai.spreadMulPerNorm` | 0〜2 |
| `ai.reactionAddSecAt100` | 0〜2 |
| `ai.moralePenaltyAt100` | 0〜100 |

`siege.json` は**必須ファイル**（無ければ `DataError`。`DEFAULT_SIEGE` への 404 フォールバックはしない）。キーの欠落だけ `DEFAULT_SIEGE`（上の値）で補う。

### 4.3 WP3a 消耗の値と効果

#### 触るファイルと関数（10 ファイル）

| # | ファイル | 関数・箇所 | 変更 |
|---|---|---|---|
| 1 | `public/data/siege.json` | 新規 | §4.2 の値 |
| 2 | `src/core/types.ts` | `Siege*`、`GameData.siege` | 型 |
| 3 | `src/core/DataLoader.ts` | `DEFAULT_SIEGE`・`validateSiege`・`loadSiege`・`loadAll` | 検証と読み込み |
| 4 | `src/rules/siegeFatigue.ts` | 新規。純関数 `fatigueTier`・`playerFatigueEffects`・`aiFatigueEffects` | 計算 |
| 5 | `src/player/PlayerController.ts` | 新規 `setFatigueEffects`、`update`（速度）、`applyCamera`（揺れ）、getter `fatigueSpreadAdd`・`reloadTimeMul` | プレイヤーへの効果 |
| 6 | `src/weapons/WeaponSystem.ts` | `startReload`、`computeSpread` | 装填の倍率・拡散の加算 |
| 7 | `src/ai/Suspect.ts` | 新規 `applyFatigue`、`syncGasCombatParams`、新規 getter `fatigueReactionAddSec`、`ambushReactionSec` | AI への効果 |
| 8 | `src/ai/Perception.ts` | `:201-209` | 反応時間に加算 |
| 9 | `src/main.ts` | フィールド `siegeFatigue`、`startMission` | 籠城開始時に適用（容疑者モードの士気だけ突入開始時） |
| 10 | `src/modes/SuspectMode.ts` | `beginAssault` を呼ぶ箇所（`:344`） | 突入開始の瞬間に士気ペナルティを適用 |

#### `src/rules/siegeFatigue.ts`（新規）

```ts
export type FatigueTier = 0 | 1 | 2;
export function fatigueTier(v: number, tiers: readonly [number, number]): FatigueTier; // v >= tiers[1] → 2、v >= tiers[0] → 1、他 0
export interface PlayerFatigueEffects { swayDeg: number; spreadAddDeg: number; reloadMul: number; speedMul: number; }
export function playerFatigueEffects(v: number, cfg: SiegePlayerFatigue): PlayerFatigueEffects; // 段階 0 は {0, 0, 1, 1}
export interface AiFatigueEffects { spreadMul: number; reactionAddSec: number; moraleDelta: number; }
export function aiFatigueEffects(v: number, cfg: SiegeAiFatigue): AiFatigueEffects;
// n = clamp(v, 0, 100) / 100。spreadMul = 1 + spreadMulPerNorm × n、reactionAddSec = reactionAddSecAt100 × n、moraleDelta = −moralePenaltyAt100 × n
```

数値の例（既定値）:

| 消耗 | プレイヤー（段階） | 揺れ | 拡散加算 | 装填（機関拳銃 2.0 s） | 移動 | AI 拡散 | AI 反応 | AI 士気 |
|---|---|---|---|---|---|---|---|---|
| 15 | 0 | 0 | 0 | 2.0 s | ×1.0 | ×1.045 | +0.04 s | −3 |
| 55 | 1 | 0.10° | +0.4° | 2.3 s | ×1.0 | ×1.165 | +0.15 s | −11 |
| 75 以上 | 2 | 0.22° | +0.9° | 2.6 s | ×0.92 | ×1.225 以上 | +0.20 s 以上 | −15 以上 |

#### 振る舞いの規則

PlayerController:

1. `setFatigueEffects(e: PlayerFatigueEffects)`: 値を保存するだけ。既定は `{0, 0, 1, 1}`（SWAT モードではずっとこのまま）。
2. 速度: WP2 の式にさらに `× fatigue.speedMul`。
3. `applyCamera`: 揺れの振幅 = `(負傷の swayDeg、負傷なしなら 0) + fatigue.swayDeg`。振幅 > 0 なら既存の揺れの式（位相の進み方は負傷 Lv があればその速さ、なければ Lv1 の速さ `×5`）で揺らす。**揺れは見た目だけ**（現行と同じ）。実際に当たりにくくするのは次の拡散加算。
4. `get fatigueSpreadAdd(): number`、`get reloadTimeMul(): number`。

WeaponSystem:

5. `startReload`: `reloadLeft = reloadTotal = w.reloadTime × (player.reloadTimeMul ?? 1)`。一人称のモーションは `reloadProgress`（比）で動くので伸びに追従する。
6. `computeSpread`: 既存の和に `+ (player.fatigueSpreadAdd ?? 0)`。

Suspect:

7. `applyFatigue(e: AiFatigueEffects)`: `fatigueSpreadMul = e.spreadMul`、`fatigueReactionAddSec = e.reactionAddSec` を保存して `syncGasCombatParams()` を呼ぶ（士気は触らない）。別に `applyFatigueMorale(delta)`: **1 体につき最初の 1 回だけ**（`fatigueMoraleApplied` の印）`adjustMorale(delta)`。
8. `syncGasCombatParams`: `combat.baseSpreadDeg = baseSpreadDeg × fatigueSpreadMul + k × GAS_MAX_SPREAD_PENALTY`（武器改造の倍率は `baseSpreadDeg` に入っているので、そのまま重なる）。
9. `get fatigueReactionAddSec(): number`（既定 0）。`ambushReactionSec` は `(preAimReactionSec ?? reactionTime) + fatigueReactionAddSec`。

Perception:

10. `:201` → `need = (s.profile.reactionTime + s.fatigueReactionAddSec) × (alert ? 倍率 : 1)`。`:209` の待ち伏せは 9. で加算済みの値を使う。

main.ts:

11. フィールド `private siegeFatigue: number`（コンストラクタで `data.siege.startFatigue`）。3a では変えない（3b で交渉が書き換える）。
12. `startMission()` の中、`beginSwatMission()` の前で 1 回だけ適用する:
    - 容疑者モード: `player.setFatigueEffects(playerFatigueEffects(v, siege.player))`、全 `entities.suspects`（仲間の容疑者）に `applyFatigue(aiFatigueEffects(v, siege.ai))`。**士気ペナルティは突入開始の瞬間**: `SuspectMode` の `beginAssault`（`:344`）の直後に、全仲間へ `applyFatigueMorale(moraleDelta)`（main が渡す関数を `SuspectMode` が呼ぶ）。
    - SWAT モード: `startMission()` で全 `entities.suspects` に `applyFatigue(...)` と `applyFatigueMorale(...)`。プレイヤーには適用しない。
13. 突入の後に生まれる容疑者がいれば、生成時に同じ値で `applyFatigue`（容疑者モードでは `applyFatigueMorale` も）する（実装者が `EntityManager` の追加の経路を確かめる。無ければ何もしない）。

#### 境界条件

| 条件 | 振る舞い |
|---|---|
| 消耗 = 50・75 ちょうど | 段階 1・段階 2（`>=`） |
| 交渉を経ずに開始（交渉画面がない経路） | 開始値 55 のまま適用 |
| 消耗は籠城中に変わるか | 変わらない（突入の前に 1 回決まる。未決 U5） |
| 負傷（SWAT モード）と消耗の揺れ | SWAT モードのプレイヤーは消耗 0 扱いなので重ならない |
| 投降・拘束済みの容疑者 | `adjustMorale` は `managed` のときだけ効く（既存の作り） |

#### ディレクターがプレイで確かめる点（3a）

1. 容疑者モードで、照準がわずかに揺れ、装填が少し長い（消耗 55 の「疲れ」が感じられるか。強すぎないか）。
2. SWAT モードで、容疑者の反応が少し鈍い（見つかってから撃たれるまでの間）。

### 4.4 WP3b 交渉の選択肢と偵察

#### 触るファイルと関数（6 ファイル）

| # | ファイル | 関数・箇所 | 変更 |
|---|---|---|---|
| 1 | `src/modes/PreAssaultNegotiation.ts` | `SuspectNegotiationContext`、`buildSuspectNegotiation`（選択肢・`intro`・`meters`）、`SwatNegotiationContext`、`buildSwatNegotiation`（信頼構築・`meters`） | 新しい選択肢と表示 |
| 2 | `src/main.ts` | 両モードの交渉の `ctx` 実装 | `fatigue`/`setFatigue`/`siegeHour`/`markScouted` |
| 3 | `src/modes/SwatTeam.ts` | 新規 `setScouted`・`breachIntel`・`clearBreachIntel`、`beginAssault`、`markRoomAt`/`markCleared`/`onContact` | 偵察情報の作成と消去 |
| 4 | `src/modes/swat/swatEntryCoordinator.ts` | `beginAssault`（`:163-188`） | 偵察した部屋に近い入口を最初のセルへ |
| 5 | `src/modes/swat/SwatHunter.ts` | `updateSweep`（`:1410`） | 入室後に偵察した部屋へ向かう |
| 6 | `src/modes/swat/swatTypes.ts` | SwatHunter・入口調整が参照する host の型 | `breachIntel` を読めるようにする（既に読めるなら変更しない） |

#### 交渉の ctx（追加）

```ts
// SuspectNegotiationContext に追加
  /** 現在の消耗（0..100） */
  fatigue(): number;
  setFatigue(v: number): void;
  /** 差し入れの後の値（siege.supplyFatigue） */
  supplyFatigue(): number;
  /** 籠城 N 時間目（siege.startHour） */
  siegeHour(): number;
  /** 差し入れに乗じて偵察された（突入時に SWAT がプレイヤーの部屋を知る） */
  markScouted(): void;
// SwatNegotiationContext に追加
  fatigue(): number;
  setFatigue(v: number): void;
  supplyFatigue(): number;
  siegeHour(): number;
```

main.ts の実装: `fatigue/setFatigue` は WP3a の `this.siegeFatigue` を読み書きする（0〜100 に丸める）。`markScouted` は `this.swatTeam?.setScouted(true)`。

#### 容疑者モード: 新しい選択肢「水・食料を要求」

| 項目 | 内容 |
|---|---|
| 位置 | 「時間稼ぎ」の次（2 番目） |
| icon / label | `💧` / `水・食料を要求`（英語 `Demand Food & Water`） |
| desc | 「何時間も飲まず食わずだ。差し入れで消耗が回復し、仲間も落ち着く。ただし差し入れに偵察機材を仕込まれ、突入時に SWAT にあなたの居場所を知られる」 |
| `effects.gain` | `消耗 ${現在}→${supplyFatigue}`、`忍耐 +5` |
| `effects.cost` | `偵察される（突入時、SWAT があなたのいる部屋を把握）` |
| 成功率 | なし（確実） |
| `disabledReason` | 1 回使ったら `差し入れはもう受け取った`（状態は `buildSuspectNegotiation` 内のローカル変数。ctx には足さない） |
| `run` | `setFatigue(supplyFatigue())`、`markScouted()`、`spend(+5)`（ターン −1）、`gains.push('水・食料')`。台詞: あなた「水と食い物をよこせ。話はそれからだ」→ 交渉人「……いいだろう。玄関前に置く」→ `消耗が ${v} に回復した` (good) → `（差し入れの袋に何か仕込まれていないか……）` (bad) |

表示:

- `meters` に「消耗（籠城 N 時間目）」を足す。`value` = 消耗、`max` 100、色は段階 0 = `#5cd67d`、段階 1 = `#f2c14e`、段階 2 = `#ff5555`、`text` = `${消耗}`、`hint` = 「50 以上で照準が揺れ装填が遅い、75 以上で足も鈍る。あなたと仲間に効く」。
- `intro` の状況の行に `籠城 ${siegeHour()} 時間目 / 消耗 ${fatigue()}` を足す。

#### SWAT モード: 「信頼構築（食料・水を差し入れ）」の効果を足す

- `run`: 既存の処理に加え、`fatigue() > supplyFatigue()` なら `setFatigue(supplyFatigue())`。
- `effects.cost`: 既存の `犯人の士気 +4` に加え、`fatigue() > supplyFatigue()` のときだけ `犯人の消耗 ${現在}→${supplyFatigue}（手強くなる）`。
- `desc` に「犯人は休息と食事で消耗が回復し、狙いと反応が戻る」を足す。結果の行（info）にも消耗の回復を書く。
- `meters` に「犯人の消耗（籠城 N 時間目）」を足す（未決 U11）。
- 2 回目以降の信頼構築は、消耗の効果なし（既に 15）。緊張・信頼・士気は今までどおり。

#### 偵察（容疑者モードの敵 SWAT）

SwatTeam:

1. `setScouted(on: boolean)`: 印を保存するだけ。
2. `beginAssault()`: `started` を立てた直後、`entry.beginAssault()` の**前**に、印が立っていれば `indoorRoomAt(player.position.x, z, y)` を引く。部屋があれば `breachIntel = { roomId, x: room.x, y: room.floorY ?? player.position.y, z: room.z, name }` を作る。部屋が無い（屋外など）なら作らない。作ったら無線で知らせる（`radio`、字幕）: 「差し入れのカメラで確認した。犯人は〈部屋名〉だ」。**プレイヤーが偵察の代償を受けたことを知るための表示**。
3. `get breachIntel()`。消す条件: その部屋が `markRoomAt`/`markCleared` で確認済みになったとき、または `onContact`（実際に見つけた）とき。
4. 偵察の対象は**突入の瞬間にプレイヤーがいる部屋**（交渉の時点ではない。準備時間の間も監視されている設定。未決 U7）。

swatEntryCoordinator.beginAssault:

5. `reachable` を作った後、`host.breachIntel` があれば、入口の `inside` から偵察した点までの距離（XZ の距離 + 3 × 高さの差）で**安定ソート**してから `assignCellPortals` に渡す。最初のセル（Red）が偵察した部屋に近い入口を取る。他の処理は変えない。
6. 生存 1 名で即突入の経路（`:191-203`）でも同じ並びを使う。

SwatHunter.updateSweep:

7. **偵察はリーダーだけ hunt する。** 先頭で、`team.breachIntel` があり、この隊員がリーダーでまだ使っていなければ（`intelUsed` の印）、`intelUsed = true`、`huntTarget = { x, y, z }`、`setState('hunt')` して戻る。突入の隊列（stacking・entering）中は `sweep` ではないので、入室が済んでから向かう。
8. フォロワー（増援を含む）は独自に hunt せず、リーダーに追従する（既存の動き）。

#### 境界条件

| 条件 | 振る舞い |
|---|---|
| 差し入れを受けず突入 | 偵察なし、消耗 55 |
| 偵察あり・突入時にプレイヤーが屋外や部屋の外 | 情報なし（無線も出ない） |
| 偵察した部屋からプレイヤーが動いた | SWAT はまず偵察した部屋へ向かう。その後は通常の捜索 |
| 交渉が決裂（忍耐 0）で即突入 | 既に受けた差し入れの効果（消耗 15・偵察）は残る |
| 忍耐 +5 で 100 を超える | `spend` の `clamp` で 100 まで |
| 容疑者モードの選択肢の数 | 8 個（数字キー 1〜8） |

#### ディレクターがプレイで確かめる点（3b）

1. 容疑者モードで水・食料を受けると、突入時に SWAT が自分の部屋の近くの入口から来て、まっすぐ自分の部屋へ来る（無線で知らされる）。
2. 受けないと照準の揺れが残るが、SWAT は探しながら来る。どちらを選ぶか迷えるか。
3. SWAT モードで差し入れをすると、犯人の反応が速く・狙いが正確になったと感じるか。

---

## 5. WP4 救急キット（容疑者モードだけ）

### 5.1 目的

容疑者モードの交渉で、人質 1 人と引き換えに救急キットを 1 個得る。H を 2.0 秒押し続けると HP +45（最大 HP まで）。使っている間は撃てず、歩きの速さになる。被弾しても止まらない。

### 5.2 触るファイルと関数（10 ファイル）

| # | ファイル | 関数・箇所 | 変更 |
|---|---|---|---|
| 1 | `src/core/InputManager.ts` | `Action`、`DEFAULT_ACTION_MAP` | `useMedkit: ['KeyH']` |
| 2 | `public/data/player.json` | 新規 `medkit` | 値 |
| 3 | `src/core/types.ts` | `MedkitConfig`、`PlayerConfig.medkit` | 型 |
| 4 | `src/core/DataLoader.ts` | `DEFAULT_MEDKIT`・`readMedkit`、`validatePlayerConfig` | 検証 |
| 5 | `src/player/PlayerController.ts` | 新規 `heal(amount)`、`moveModeCap` | 回復と歩きの上限 |
| 6 | `src/player/Medkit.ts` | 新規 `MedkitUse` | 長押しの処理 |
| 7 | `src/weapons/WeaponSystem.ts` | `fireBlocked`、新規 `healBlock` | 使用中は撃てない |
| 8 | `src/main.ts` | 容疑者モードで `MedkitUse` を作る、`update` の順序、交渉の `ctx` | つなぎ込み |
| 9 | `src/modes/PreAssaultNegotiation.ts` | `SuspectNegotiationContext`、新しい選択肢 | 交換 |
| 10 | `src/ui/Hud.ts` | 新規 `medkitProvider`、HP の行 | 所持数 |

操作説明（`BriefingScreen.ts`）は 10 ファイルに収めるため今回は触らない。キーは交渉の説明文と HUD に出す（未決 U12）。

### 5.3 データ

`public/data/player.json`:

```jsonc
"medkit": { "holdSec": 2.0, "heal": 45, "tradeCount": 1 }
```

```ts
/** 救急キット（容疑者モードだけ）。時間 s、回復量は HP */
export interface MedkitConfig {
  /** 押し続ける時間 */
  holdSec: number;
  /** 回復量（最大 HP まで） */
  heal: number;
  /** 交渉で 1 回に得る個数 */
  tradeCount: number;
}
// PlayerConfig に追加
  medkit: MedkitConfig;
```

検証: 無ければ既定値。`holdSec` 0.2〜10、`heal` 1〜200、`tradeCount` 整数 1〜5。

### 5.4 振る舞いの規則

`MedkitUse`（`src/player/Medkit.ts`）。依存: `player`、`input`、`weapons`、`cfg: MedkitConfig`、`isHoldingHostage: () => boolean`（実体は `hostageGrab.holding`）、`showGauge(label, ratio)`（`SuspectMode.showGauge`）、`subtitle`。

状態: `count`（初期 0）、`progress`（秒）、`needRelease: boolean`。

1. `add(n)`: `count += n`。`get count`。`get using`（`progress > 0`）。
2. `update(dt)` は毎フレーム、**`player.update` と `weapons.update` より前**に呼ぶ（移動の上限と射撃の禁止を同じフレームで効かせるため）。
3. 開始の条件（すべて満たすとき、押している間 `progress += dt`）: `input.isDown('useMedkit')`、`!needRelease`、`count > 0`、`player.alive`、`player.hp < player.maxHp`、`!weapons.isReloading`、`!isHoldingHostage()`。
   - 押した瞬間に `hp >= maxHp` なら、字幕「怪我はしていない」を 1 回出す（押し直すまで出さない）。`count = 0` なら字幕「救急キットを持っていない」。
4. 使用中（`progress > 0`）: `weapons.healBlock = true`、`player.moveModeCap = 'quiet'`（走りは静音の速さに落とす。しゃがみはしゃがみのまま。足音も静音の半径）、`showGauge('救急処置中...', progress / holdSec)`。
5. 被弾しても止まらない（`takeDamage` は `MedkitUse` を見ない）。
6. 取り消し（`progress = 0`、消費なし、HP は回復しない、禁止と上限を解く）になる場合: 途中で離す／3. の開始条件のどれかが偽になる（死亡・リロード開始・人質の拘束など）／**使用中に slot1〜4・投擲・interact・breach・optiwand のどれかが押された**。いずれも `MedkitUse` の中で完結する。
7. `progress >= holdSec` → 完了: `player.heal(cfg.heal)`、`count -= 1`、`progress = 0`、`needRelease = true`、禁止と上限を解く。字幕「HP +45」。
8. `needRelease` はキーを離したフレームで false に戻る（押しっぱなしで 2 個目を続けて使わない）。

PlayerController:

10. `heal(amount)`: `alive` のときだけ `hp = min(maxHp, hp + amount)`。負傷レベル（SWAT モードだけの仕組み）は下げない。
11. `moveModeCap: 'quiet' | null`: `update` でモードを決めた後、`moveModeCap === 'quiet'` かつ `mode === 'run'` なら `mode = 'quiet'`。

WeaponSystem:

12. `healBlock = false`（公開）。`fireBlocked` = `suppressFire || externalFireBlock || healBlock`。オプティワンドの `externalFireBlock` とは別の旗にする（互いに上書きしない）。

交渉（容疑者モード「人質と交換: 救急キット」）:

| 項目 | 内容 |
|---|---|
| 位置 | 「人質と交換: 弾薬」の次 |
| icon / label | `⛑` / `人質と交換: 救急キット`（英語 `Trade Hostage: Medkit`） |
| desc | 「救急キット 1 個（H を 2 秒押し続けて HP +45。使っている間は撃てず、歩きになる）。人質を手放すので盾が減り、仲間も動揺する」 |
| `effects` | gain `救急キット ×1`・`忍耐 +5`、cost `hostageCost()` |
| `disabledReason` | `needHostage()` → 1 回受け取ったら `救急キットはもう受け取った`（状態は `buildSuspectNegotiation` 内のローカル変数） |
| `run` | `trade('救急キット', () => ctx.giveMedkit(tradeCount), +5, 交渉人「……医療品なら渡そう。人質が先だ」)` |

- ctx に `giveMedkit(n: number): void` を足す。main.ts は `this.medkit?.add(n)`。
- SWAT モードには入れない（`MedkitUse` を作らない。`useMedkit` を押しても何も起きない）。

Hud:

13. `medkitProvider: (() => number) | null`（`toolLabel` と同じ作り）。main.ts が容疑者モードで `() => medkit.count` を入れる。
14. HP の行の後ろに、`count > 0` のとき `  救急 ×n [H]`。再描画のキーに `armorKind` と `count` を含める。

### 5.5 境界条件

| 条件 | 振る舞い |
|---|---|
| HP 99 で使う | 100 まで（+1） |
| 使用中に HP が 0 | 取り消し、消費なし |
| 使用中に撃たれる | 止まらない |
| 使用中の持ち替え・投擲（slot1〜4・投擲・interact・breach・optiwand の押下） | 取り消し（HP は回復しない、消費なし） |
| リロード中に押す | 始まらない（押し続けていれば、リロードが終わった次のフレームから始まる） |
| 人質を拘束中 | 始まらない（両手がふさがっている） |
| 準備時間（突入前） | 使える |
| ポーズ・交渉画面 | `update` が呼ばれないので進まない |
| 押したまま 2 個目 | 1 個使った後は離すまで始まらない |

### 5.6 ディレクターがプレイで確かめる点

1. 交渉で救急キットを受け取ると、HUD に「救急 ×1 [H]」が出る。
2. H を 2 秒押し続けるとゲージが満ちて HP が 45 戻る。途中で離すと戻らず、キットも減らない。
3. 使っている間は撃てず、歩きになる。物陰で使うか、撃たれながら使うかの判断になるか。

---

## 6. 交渉の選択肢の損と得（本設計の後）

### 6.1 容疑者モード（プレイヤー＝立てこもり犯）

| # | 選択肢 | 得 | 損 | 変更 |
|---|---|---|---|---|
| 1 | 時間稼ぎ | 準備時間 +25 秒、仲間の士気 +4 | 忍耐 −12（失敗で −30）、繰り返すほど失敗しやすい | なし |
| 2 | **水・食料を要求** | 消耗 55 → 15（あなたと仲間の照準・装填・反応が戻る）、忍耐 +5 | **突入時に SWAT があなたのいる部屋を知る**（近い入口から、まっすぐ来る）、1 ターン | WP3b 新規 |
| 3 | 人質と交換: 防弾チョッキ | 耐久 80、被弾の 60% を肩代わり、忍耐 +8 | 人質 −1、仲間の士気 −10、**移動 −12%・足音 +25%・リーンが遅い**（脱げない） | WP2 で損を追加 |
| 4 | 人質と交換: 弾薬 | 予備マガジン +2、忍耐 +5 | 人質 −1、仲間の士気 −10 | なし |
| 5 | **人質と交換: 救急キット** | 救急キット 1 個（HP +45）、忍耐 +5 | 人質 −1、仲間の士気 −10、使う 2 秒は撃てない | WP4 新規 |
| 6 | 人質と交換: 時間 | 準備時間 +40 秒、忍耐 +15 | 人質 −1、仲間の士気 −10 | なし |
| 7 | 強気の要求で仲間を鼓舞 | 仲間の士気 +22 / +14 / +8 | 忍耐 −10（失敗で −20）、効果が薄れる | なし |
| 8 | 脅迫して包囲を緩めさせる | 突入班 −1 名 | 忍耐 −25（失敗で −45） | なし |
| — | 何も受け取らない（ベストなし） | 速く静か（罠と奇襲の型） | 被弾に弱い、消耗 55 のまま | — |

### 6.2 SWAT モード（プレイヤー＝隊長・交渉人）

| 選択肢 | 得 | 損 | 変更 |
|---|---|---|---|
| 信頼構築（食料・水を差し入れ） | 緊張 −15、信頼 +20（他の交渉が成功しやすい） | 犯人の士気 +4、**犯人の消耗 55 → 15（狙いと反応が戻る）** | WP3b で損を追加 |
| 人質の解放を要求 | 人質 1 名救出 | 緊張 +5・信頼 −10（失敗で緊張 +15・信頼 −5） | なし |
| 投降を説得 | 犯人 1 名投降 | 緊張 +10（失敗で信頼 −5 も） | なし |
| 内部の様子を聞き出す | 犯人の人数・居場所 | 緊張 +5（失敗で +10・信頼 −5） | なし |
| 最後通告（威圧） | 全犯人の士気 −15 | 緊張 +30、信頼 −10、警戒度の予測が上がる | なし |
| — | 差し入れをしない | 犯人は消耗 55 のまま（反応 +0.15 秒、拡散 ×1.165、士気 −11） | 信頼が上がらず、解放・説得が難しい | — |

---

## 7. 依頼書に入れる共通事項

- 区分 A。テストは書かない・回さない。`npm run build` が終了 0 になることだけを確かめる。
- 1 依頼 = 1 WP（WP3 は 3a と 3b を別依頼）。本書の該当章だけを読ませる（§0 と該当の章）。
- 数値は本書の JSON の値をそのまま使う。変えたいときは実装者が勝手に変えず、質問する。
- 審査（別モデル 1 回）は、該当の章の「振る舞いの規則」と「境界条件」の表を 1 行ずつコードで確かめる。差し戻しは、遊ぶ人に見える不具合・データの消失・仕様違反だけ。

## 8. 製造の順序とファイルの持ち分

全 WP が `src/core/types.ts`・`src/core/DataLoader.ts` を触るので、**並行させず、同じブランチで順に**作る。コミットは、このシリーズの最後にまとめて行う（ディレクターの承認後）。

| 順 | 依頼 | 変更ファイル数 | 前提 | 主に触るファイル |
|---|---|---|---|---|
| 1 | WP1 撃ち合いの間 | 9 | なし（胸狙い・リーン新方式は作業ツリーに既にある） | EngageBehavior、Suspect、SwatHunter、swatTypes、SwatTeam、main、types、DataLoader、ai_profiles.json |
| 2 | WP2 ベストの重さ | 7 | WP1（リーン新方式は作業ツリーに入っている） | player.json、types、DataLoader、PlayerController、main、PreAssaultNegotiation、Hud |
| 3 | WP3a 消耗の値と効果 | 10 | WP2（PlayerController の速度の式を重ねる） | siege.json、types、DataLoader、siegeFatigue（新規）、PlayerController、WeaponSystem、Suspect、Perception、main、SuspectMode |
| 4 | WP3b 交渉と偵察 | 6 | WP3a | PreAssaultNegotiation、main、SwatTeam、swatEntryCoordinator、SwatHunter、swatTypes |
| 5 | WP4 救急キット | 10 | WP3b（交渉の選択肢の並び） | InputManager、player.json、types、DataLoader、PlayerController、Medkit（新規）、WeaponSystem、main、PreAssaultNegotiation、Hud |

ディレクターのプレイ確認は、WP1、WP2、WP3（3a＋3b）、WP4 の 4 回。WP1 と WP2 はまとめて 1 回にしてもよい（ベストの差は WP1 の後でないと意味が出ない）。

---

## 9. 未決事項（PL の確認が要るもの）

| ID | 内容 | 本書での扱い | 確認してほしいこと |
|---|---|---|---|
| U1 | 目標「被弾開始から 1.0 秒」の時刻 0 | 「自分に向けた初弾が撃たれた時刻」とした。最初の命中からでは敵 SWAT が収束後に 5 発 65 を当て、どの拡散でも残り HP 35 になる（§1.4） | この解釈でよいか |
| U2 | 拡散 ×3.0 を横だけに広げる | `verticalShare` = 0 を既定（円だと至近で頭部に散り、1 秒以内の死亡が 21〜23%。§1.5） | 横だけでよいか |
| U3 | プレイヤーの「照準の揺れ」 | 現行の揺れはカメラだけ。当たりにくくするため拡散加算（0.4 / 0.9 度）を足した | 足してよいか。値はプレイで調整 |
| U4 | 容疑者 AI の拡散 ×1.165 の効き目 | CQB の距離では差はほとんど出ない（推定）。体感は主に反応 +0.15 秒と士気 −11 | 弱ければ `spreadMulPerNorm` を上げるか、プレイで判断 |
| U5 | 消耗が籠城中に変わるか、「N 時間目」が進むか | 変わらない。突入の前に 1 回決まる。N は `startHour`（6）で固定 | 時間とともに消耗が増える仕組みは今回入れない、でよいか |
| U6 | 敵 SWAT の待ち構え | 敵 SWAT には preAim の経路が無い。入口を見張っている隊員も、撃ち始めは広がる | 敵 SWAT のホールド中を収束済みにするかは今回入れない、でよいか |
| U7 | 偵察で知られる「居場所」 | 突入の瞬間にプレイヤーがいる部屋（差し入れの機材で監視され続ける設定）。部屋の外なら情報なし | この解釈でよいか |
| U8 | 収束の対象 | **PL 決定**: `threat.isPlayer` の標的にだけ使う。NPC 同士・バリケード射撃は収束なし（従来どおり）。味方隊員（Squad）の射撃にも効かない | なし |
| U9 | ベストは脱げない | 耐久が 0 になっても重さが残る | よいか |
| U10 | 防弾チョッキの説明文の「耐久 70」 | 現行の値（50）と食い違っていた。WP2 で設定値（80）から作る | なし（修正の報告） |
| U11 | SWAT モードの交渉画面に「犯人の消耗」を出す | 決定事項は容疑者モードの表示だけだが、取引の損が見えるように SWAT モードにも出した | よいか |
| U12 | 救急キットの操作説明 | WP4 を 10 ファイルに収めるため `BriefingScreen` は触らない。キーは交渉の説明文と HUD で知らせる | 後で 1 行足すか |
| U13 | 救急キットの細則 | リロード中・人質を拘束中は始まらない、押したまま 2 個目は続けない、と決めた | よいか |
| U15 | WP2 のリーンは新方式に依存する | **PL 決定**: 新方式（`outSec` 0.38 / `returnSec` 0.30）は作業ツリーに入っている（済）。WP2 は時間を `÷ leanSpeedMul` にする。名前が本書と違えば WP2 の依頼書で合わせる | なし |
| U14 | 計算の確かさ | **PL 決定**: §1 は単独の射手を想定した見積り。複数の敵が同時に撃てばその分減る（保証しない）。最終の合否はプレイで決める | なし |

### PL 決定（2026-11-28 設計審査）

- U5 士気の時点: 容疑者モードの士気ペナルティは突入開始の瞬間（`SuspectMode` の `beginAssault`）。SWAT モードは `startMission`（§4.3）。
- 採用の細目は各章（§2.4・§3.4・§4.2・§4.4・§5.4）に反映済み。
- 順序: コミットはシリーズの最後にまとめて（ディレクター承認後）。
