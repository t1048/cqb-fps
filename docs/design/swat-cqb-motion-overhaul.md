# SWAT隊員の挙動改善：ジタバタ解消・CQB突入導線・スタック順序固定

対象：SWATモード（味方分隊 `src/ai/Squad.ts`）と容疑者モード（敵SWAT `src/modes/SwatTeam.ts`）

## 0. 症状と根本原因

| 症状 | 主因 |
|---|---|
| 立っているだけで足踏み・小刻みに動く | `applySeparation` / `separate()` が毎フレーム押し出し → arrive半径から外れて歩いて戻る → また押される。`setPosition` の押し出し量が `travel` に加算され歩行アニメが出る |
| 向きがパタパタ変わる | `faceToward` が胴体ひねり `torso.rotation.y` を毎回スナップ。`aimAt` の 0.65rad 境界で頭ヨーが不連続。フォロー時の「停止→プレイヤー方向／移動→進行方向」がヒステリシス無しで切替。`scanAround` が ±86° を 2.2rad/s で振る |
| 歩く/止まるの点滅 | arrive 判定にヒステリシス無し。加減速無しの等速移動（瞬時に最高速・瞬時停止） |
| フォロー中に周回する | 隊形目標をプレイヤー／リーダーの**体ヨー**から毎フレーム算出（振り向くだけで目標が横に1.5〜2.4m跳ぶ） |
| 部屋中央へ直進 | Squad: 全員がまず同じ敷居点 `center+into*0.72` → PoD（ドアから2.2m奥＝中央寄り）へ斜め直進。SwatTeam: 解放と同時に全員 `sweep`、最寄りカバーセル（ドア正面）へ直進。PoD/順序の概念が無い |
| 突入時に位置が入れ替わる | Squad: 役割をドア中心からの距離で貪欲割当（交差を生む）、スタック待ちタイムアウトが**個人単位**で早着者から勝手に突入。SwatTeam: スタック枠がセル順で左右交互（Red-1左・Red-2右・Blue-1左後…）、解放時に全員同時 `sweep`、2人セルのフォロワー目標がリーダー位置＝ドア前を横切る、Blue-1 が Red-2 と競争 |
| ドア外から覗いただけで部屋が「クリア」→Uターン | (SwatTeam) `scanCoverage` がドア外からの視認でもセルを seen にし、部屋がクリア扱い→次のセルへ方向転換 |

## 1. 設計原則

1. **サイド固定（Side-locked）**：スタックで左にいた者は左へ、右にいた者は右へ入る。経路が交差しない＝入れ替わりが物理的に起きない。
   - 先頭(各サイドrank0)は**ボタンフック**：敷居を越えたら入口壁に沿って自サイドのコーナーへ。
   - 後続(各サイドrank1+)は同サイドの**内側PoD**（入口壁から少し奥、ドア軸寄り）へ。
2. **突入順＝スタック順**：順番 k の隊員は「k-1 が敷居を越えた」かつ「k-1 の開始から stagger 秒経過」で発進（フェイルセーフ 2.5s）。
3. **確定した役割は突入完了まで凍結**：再計算しない。
4. **到着した者は動かない**：固定位置フェーズでは分離力を無効化。到着/再始動にヒステリシス。
5. **移動・旋回は連続**：速度に加減速、胴体ひねりと頭は平滑化、視線ターゲットは最短保持時間付き。

## 2. 共有モジュール `src/ai/cqbEntry.ts`（新規・純関数）

```ts
export interface CqbPortal { center: Vec3; into: {x:number;z:number}; axis: {x:number;z:number}; width: number; }
export interface CqbRoom { x:number; z:number; width:number; depth:number; /* 既存 RoomDef から変換 */ }
export interface EntryPlan {
  side: -1 | 1;            // axis 方向の符号。スタック枠の lateral 符号と同じ
  rank: number;            // サイド内の順位 (0=先頭)
  order: number;           // 全体の突入順 (0..n-1)
  waypoints: Vec3[];       // [敷居点, (先頭のみ)壁沿い点, PoD]
  pod: Vec3;
  look: Vec3;              // PoD で保持する視線点
}
export function assignStackSlots(positions: Vec3[], slots: StackSlot[]): number[];  // 返り値: members[i] → slot index
export function planEntry(portal, room, slots: StackSlot[], opts: { isStandable(p):boolean; reachable(a,b):boolean }): EntryPlan[]; // slot index 順
```

### 2.1 assignStackSlots
- n ≤ 6 なので全順列（≤720）で **総移動距離の二乗和最小** を選ぶ。同点時は index 安定。
- 追加ペナルティ：ドア開口（`|lateral| < width/2` かつ外側0.3m以内）を横切る割当に +4。

### 2.2 突入順
- `layoutStackSlots` の枠に対し、各枠の side = sign(lateral)（0なら左扱い）、rank = 同サイド内で「ドアからの後退距離」昇順。
- order = rank 昇順、同 rank 内は slot index 昇順（= L0, R0, L1, R1 …）。単一サイドしか取れない場合は自然に一列縦隊になる。

### 2.3 経路・PoD（部屋座標：u = axis方向 lateral, v = into方向 depth, ドア中心原点）
- 部屋の入口壁からの有効半幅 `halfL = (side側の壁までの距離) - 0.65`（部屋矩形から算出、上限 4.0）。
- **敷居点**：`v=0.55, u=side*min(0.18, width*0.2)`（全員共通ではなく自サイド寄り）。
- **rank0（ボタンフック）**：壁沿い点 `v=0.75, u=side*min(halfL*0.6, 1.4)` → PoD `v=0.9, u=side*halfL`（入口壁沿いのコーナー）。look = 対角の奥コーナー方向（`v=depth-0.6, u=-side*halfL*0.6`）。
- **rank1**：PoD `v=1.7, u=side*min(halfL*0.5, 1.2)`。look = 奥壁の自サイド側（`v=depth-0.5, u=side*halfL*0.5`）。
- **rank2+**：PoD `v=1.0+0.6*rank, u=side*0.6`、look = 正面奥。
- 各点は `isStandable` と `reachable(前点, 点)` を満たすまで `u` を 0.8 倍、`v` を ±0.2 で縮退（最大6回）。全滅なら Squad 既存 `computeDominationPoints` の結果をフォールバックとして渡せるよう `fallbackPods?: Vec3[]` オプションを受ける。
- 部屋が狭い（halfL < 0.5）場合は rank0 も壁沿い点を省略。

## 3. 動きの平滑化（共通の考え方、各ファイルで実装）

### 3.1 HumanoidBody（`src/ai/HumanoidBody.ts`）
- `faceToward`: 胴ひねりをスナップせず `torsoTarget` に保存し、`tick` で `1-exp(-8dt)` ブレンド。
- 同一フレーム内の複数 `faceToward` 呼び出しで旋回量が累積しないよう、フレーム毎の旋回予算（`5*lastDt` を tick でリセット）を消費する。
- `aimAt`: 頭ヨーを連続関数に：`headYaw = clamp(neck, -0.5, 0.5)`、`|neck|>0.5` で体を回す（境界不連続を排除）。
- `setPosition(x,z,y, countTravel=true)`：押し出し用に `countTravel=false` を追加（歩行アニメを出さない）。
- 歩行ストライドの入力にデッドゾーン：1tick の travel < 0.004 は 0 扱い。

### 3.2 加減速（呼び出し側）
- 各ユニットに `vel {x,z}` を持たせ、目標速度 `vDes = dir * speed * min(1, distToGoal/0.6)`（最終目標接近時のみ減速）、`vel += clamp(vDes - vel, accel*dt)`（accel 9 m/s²、停止時 12 m/s²）。実移動は既存 `stepToward` に `|vel|*dt` を渡す形でよい（衝突処理は既存流用）。
- Squad は `navigateTo`、SwatTeam は `SuspectNavigator.step` で実装。

### 3.3 ヒステリシス
- arrive：停止は `d < r`、再始動は `d > r + 0.35`。ユニットに `settled` フラグ。
- 視線ターゲット切替（進行方向⇔警戒方向、エンゲージの block 状態等）は最短保持 0.4s。
- `scanAround`: 振幅 ±0.9rad、速度 0.9rad/s、**静止 0.6s 以上のときのみ**。

### 3.4 分離力
- 固定位置フェーズ（stacking 到着済み / door_prep / entering / PoD保持 / secured / hold）では重なりが 0.42m 未満のときだけ、**下位順位側のみ**を押す。それ以外は従来の 0.5倍の強さ。押し出しは `countTravel=false`。
- Squad の「プレイヤー射線から退く」回避は 0.6s 保持＋退避位置を記憶（退避中はフォロー目標をその位置に置き換える）。

## 4. Squad.ts（SWATモード）の変更

1. `assignPortalGroup`：距離ソートを `assignStackSlots` に置換。**同ポータルで既にスタック中の役割があれば常に保持**（`order==='stack'` の再発行や直接 clear でも）。PoD/経路は `planEntry` から。`entryOrder` を保存。
2. スタック待ちタイムアウトを**グループ単位**に（最初の到着からではなく、グループ全員の待ち開始から `stackWaitTimeoutSec`）。door_prep への遷移はグループ一斉。
3. `entering`：`entryDelay` 方式を §1-2 のゲートに置換。経路は `waypoints` を順に（各点 arrive 0.3、最終点で停止）。歩行中の視線：敷居点まではドア内の自サイド反対側コーナー（=最初に脅威が見える方向）、以降は `look`。タイムアウト 6s/スタール 2.4s は維持し、タイムアウト時もその場で `sweeping` ではなく可能なら PoD 保持へ。
4. `sweeping`：roleIndex0 以外は PoD 保持（静止・分離無効）。roleIndex0 の捜索 vantage は「部屋中央」ではなく**未視認セルに最も近い壁沿い点**を優先（既存 `findVantageForCell` のスコアに中央からの距離ボーナス）。
5. `secured`：位置は PoD 固定。`podLook` の付け替えは 1 回だけ、0.6s かけて回す（faceToward 予算で自然に回る）。
6. `follow`：隊形の基準向きは**プレイヤー移動方向の低域通過**（速度 > 0.6 m/s の時のみ更新、時定数 0.8s）。目標点も時定数 0.3s で低域通過。ヒステリシス：start 0.9 / stop 0.4。停止中の視線はプレイヤー向き±0.35 固定（再計算しない）。
7. 突入タイミング：C2 起爆後の一斉 `entering` も同じ順序ゲートを使う。

## 5. SwatTeam.ts（容疑者モード）の変更

1. **スタック枠割当**：`beginAssault` でバケット内メンバーを `assignStackSlots`（現在位置ベース）で枠に割当。セル内の2人が同サイドに並ぶよう、可能なら Red=左、Blue=右（2ドア時はドア別）に寄せるペナルティ（同セルが別サイド +2）。
2. 新 `HunterState 'entry'`：`releaseStackedEntry` で非ブリーチャーを `sweep` ではなく `entry` に。ブリーチ扉は `onBreach` 後に同バケット全員を `entry` へ（ブリーチャーは order 0 に繰り上げ）。各ハンターに `entryPlan`, `entryWp`, `entryHold` を保持。
   - 順序ゲート §1-2（stagger 0.45s）。
   - 経路 waypoints を `SuspectNavigator.step` で（`canOpenDoors=false`、arrive 0.3）。
   - PoD 到着後 1.0s 静止して `look` 方向を保持、その間 look の ±50° 扇・8m 内のセルを seen にマーク → `sweep`。
   - `entry` 中にプレイヤーを視認したら既存どおり `engage`（中断可）。被弾・接触の中断ロジックも既存と同様に扱う。
   - `multiDoorEntry.test.ts` の「`state !== 'stack'`」期待は満たされる。
3. **ドア外からの視認でクリア扱いしない**：`scanCoverage` は観測者が対象セルと同じ屋内部屋にいる（または敷居0.6m以内）場合のみ seen にする。
4. **ゴール再選択の抑制**：`goalCell` が歩行中に seen になっても、選択後 1.5s 未満、または残距離 < 2.0m なら維持。
5. **フォロワー隊形**：リーダーの体ヨーではなく、リーダーの**移動方向の低域通過**（速度>0.5m/s時のみ更新）を基準に。2人セルでもリーダー位置ではなくリーダー後方 1.1m・自サイド 0.5m を目標（壁で塞がる場合のみ後方真後ろ）。ヒステリシス：start `> 2.4+slot*0.6` / stop `< 1.4+slot*0.4`。リーダー移動中は `scanAround` しない（進行方向+自サイド側 0.6rad を見る）。
6. `sweepUnclearedRoom` はフォロワーには適用しない（リーダーが部屋内にいる限り隊形維持。リーダー不在/ダウン時のみ適用）。
7. `routePhase` にヒステリシス：approach→cross は `<1.15`、cross→approach は `>1.8` の時のみ。往復時に `nav.reset()` しない。
8. `separate()`：§3.4 に従う（`stack` で ready、`entry` 中は重なり <0.42 のみ、下位順位を押す、`countTravel=false`）。

## 6. テスト（必須）

新規 `tests/unit/cqbEntry.test.ts`
- `assignStackSlots`：左から来た2人が右の枠へ交差しない／4人で総距離最小。
- `planEntry`：side 固定（全 waypoint の u 符号が side と一致または 0 近傍）、PoD が部屋内かつ rank0 が入口壁から 1.2m 以内、order が L0,R0,L1,R1。

新規 `tests/unit/squadEntryMotion.test.ts`（`squadParity.test.ts` のハーネス流用）
- stack→clear で **突入順（敷居越えフレーム）が entryOrder と一致**。
- 各隊員の軌跡の lateral(u) 符号が突入中に反転しない（入れ替わり無し）。
- スタック到着後〜door_prep まで、各隊員の位置変化合計 < 0.05m（足踏み無し）。
- 向きのジッター：PoD保持中 2s で `yawRad` の変化方向の符号反転回数 ≤ 2。
- follow でプレイヤーがその場で 180° 振り向いても隊員の目標移動が 0.6m 未満/0.3s。

新規 `tests/unit/swatEntryMotion.test.ts`（`multiDoorEntry.test.ts` のハーネス流用）
- 1ドア4人：解放後 `entry` に入り、敷居越え順序が order と一致、lateral 符号反転無し。
- 各人が PoD 付近（0.5m 以内）に到達し 1.0s 静止。
- ドア外スタック中は部屋がクリア扱いにならない。
- 停止中フォロワーの yaw 符号反転回数が少ない。

既存：`npm test`、`npx tsc --noEmit`、`npx vitest run -c vitest.e2e.config.ts` が全て通ること。既存テストが仕様変更で落ちる場合は、意図を保ったまま最小限の修正に留め、理由を報告する。
