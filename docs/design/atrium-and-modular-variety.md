# 吹き抜け足場改善＆モジュラー建築バリエーション強化 設計書

- 作成日: 2026-11-24
- 区分: C（文書）。本書は設計のみで、`src/`・`public/` は変更しない。後続実装は §3 の WP-1〜WP-3 に分割し、ファイル持ち分は重複しない。
- 起点: ディレクター実プレイでの 2 要望 — (1) 吹き抜け 2F ギャラリーが狭く、開き戸の前に手すりが建つ。(2) モジュラー建築の特徴的バリエーションを増やしたい。
- 前提（プロジェクト現行方針）: 実装後はテストを回さず「開けること」（`npm run build` = `tsc --noEmit && vite build` が終了 0、パースエラーなし）だけを確認し、別モデルがレビュー 1 回、動作確認はディレクターのプレイで行う。既存テストは削除せず、本書では「壊してはいけない契約」として §0.4 に明記する。

## 0. 調査した現行契約（実装前に必ず再読すること）

### 0.1 生成パイプライン

`src/world/generator/index.ts` の `generateMap` が正本。モジュラー系は `generateModularMap`（`GraphPlanner.planStoriesAndGraph` → `SpatialSolver.solveSpatialLayout` → `ModularGenerator.compileLayout` → `SiteTransform` の 8 変換）の後に `dressWithMotif`（`Motif.ts`、部屋名・材質）と `applyMotifScenes`（`MotifScenes.ts`、モチーフ小道具・ホール・トイレ・吹き抜け）を掛ける。吹き抜けは生成器本体ではなく、この最後段の後処理である。乱数はマップシードから独立したストリーム（`MotifScenes.ts:551`、`seed ^ 0x51e11e`）で、間取りの再現性には影響しない。

### 0.2 テンプレート検証の硬い制約（`src/core/DataLoader.ts`）

| # | 制約 | 根拠 |
|---|---|---|
| V-1 | `modules` は 1〜32 件、ID 一意 | `DataLoader.ts:975-976` |
| V-2 | `doubleHeightChance > 0` は `roofStyle === 'stackable'` かつ `category !== 'entry'` のときだけ | `DataLoader.ts:910-912`、`types.ts:403-404` |
| V-3 | 屋内モジュールの短辺最小 >= `max(1.6, 2*wallThickness + 0.9)` = 全テンプレートで 1.6m、長辺最小 >= `doorPassMin = door.width + wallThickness + 2*door.margin`（compact 1.82 / house 1.93 / embassy 2.06m） | `DataLoader.ts:897,749,922-927` |
| V-4 | `subRooms` は最大 6 件・ID 一意、屋外モジュールは不可。各 `minSide` >= `max(1.6, doorPassMin)`（同上: compact 1.82 / house 1.93 / embassy 2.06m）、`shareWeight` は 0.15〜1.0 | `DataLoader.ts:929-951`、`types.ts:372-385` |
| V-5 | `spawnWeight > 0` は `entry`・屋外モジュール不可 | `DataLoader.ts:916-918` |
| V-6 | 1F に置ける屋内 `entry` が必須。多層プロファイルでは全階に置ける `stair_core` と、非 1F 階ごとに一般屋内室（`stair_core`・`corridor` 以外）が必須 | `DataLoader.ts:980-995` |
| V-7 | `fallbackModuleId` は `stackable`・屋内・非 `private`・`subRooms` なし・1F 配置可でなければならない（現行は全テンプレート `storage`。変更禁止） | `DataLoader.ts:997-1002` |
| V-8 | テンプレート検証の最後に `verifyFallbackFeasibility(tpl, doorLeafHeight)` を 실행し、重み > 0 の全 `storyProfiles` で決定論的最小構成＋人物同時配置＋変換後コンパイルが成立しなければ `DataError`（`FallbackInfeasibleError`） | `DataLoader.ts:659`、`ModularGenerator.ts:1403-1421` |
| V-9 | `ModuleCategory` は閉じた 10 種のみ: `entry / stair_core / corridor / living_hub / garage / courtyard / wing_private / study_office / basement_utility / terrace`。新カテゴリは追加できない（`types.ts`・`DataLoader`・`Motif.categoryWeight` の同時改修になるため本設計の範囲外） | `types.ts:334-344` |
| V-10 | 家具 `count` は整数 1<=min<=max<=16、`furnitureGap`・`wallClearance` の範囲内。家具 `id` はそのまま `BoxDef.prop` になる（`Placement.ts:74`） | `types.ts:351-354` |

### 0.3 フォールバックと選出の仕組み（壊すと全マップが落ちる）

- `buildSafeMinimalModularLayout`（`ModularGenerator.ts:880-`）は `entry → ハブ（corridor、無ければ fallback）→ ハブ北辺に [西ウイング: fallback × nW][stair_core][東ウイング: 必須モジュール＋fallback × nE]` を並べる決定論的構成。**`minCount > 0` の 1F モジュールは東ウイングの必須列に全数入る**（`requiredEast`、`ModularGenerator.ts:928-937`）ため、`minCount` を増やすと最小構成が横に伸び、`maxFootprint`・`MAX_PLANNED_MODULES = 32`（`GraphPlanner.ts:33`）・人物格子配置のどれかで不成立になりやすい。
- 通常選出も同じ上限で動く。`GraphPlanner.planStoriesAndGraph` は (1) entry 1 個、(2) 階段コア、(3) `minCount` 分、(4) 非 1F 階の一般屋内室 1 室保証、(5) 1F を `target1FArea` まで重み抽選で充填、(6) 2F があれば `doubleHeightChance` 抽選、(7) 2F を `upperFloorRatio × S_1F` まで充填、(8) B1 を `basementRatio` まで充填、の順（`GraphPlanner.ts:280-358`）。
- `withMotifBias`（`Motif.ts:852-864`）は計画用複製だけ `weight × categoryWeight[category]` と `storyProfiles` 重みを偏らせる。**寸法・個数・家具寸法は変えない**し、検証と最終フォールバックは元テンプレートで走る。つまり新モジュールは「元テンプレートの素の重みでもフォールバックが通る」ことが前提で、モチーフ偏重は上乗せにすぎない。
- シード決定性: 乱数はすべて引数シード由来の `Rng` のみ（`Math.random`・時刻禁止）。選出・配置の乱数消費順を変える変更は同一シードの間取りを変えるが、それ自体は契約違反ではない。ただし乱数消費を「条件分岐の内側で増減させる」変更は再現性を読みにくくするため、§2.5 のスコアリング変更では乱数呼び出し回数を変えないことを必須とする。

### 0.4 既存テストが固定している観測可能な契約

| テスト | 本設計に関わる契約 |
|---|---|
| `tests/unit/scenery.test.ts:79-95` | 2 階建てマップ（シード 0〜120 のいずれか）で `prop === 'rail'` の手すりが 1 本以上あり、階段があり、ホール系の部屋名があること。→ §1 の厳格化で吹き抜け自体が消えると落ちる。候補を 1 室で諦めない設計（§1.4 手順 B）が必須 |
| `tests/unit/scenery.test.ts:39-77` | モチーフ代表プロップ（`hbed`/`piano`/`teller`/`desk`/`shelf`/`bed`）と `toilet` が残り、プロップがスポーン 1.4m 以内に被らないこと |
| `tests/unit/motif.test.ts:74-109` | `withMotifBias` が寸法・家具を変えず重みだけ変えること、同一テンプレートからモチーフ違いのマップが生成できること |
| `tests/unit/motif.test.ts:111-155` | `house` は畳・木・座敷/寝室の部屋名と `bed` を、`plain` はモチーフ小道具を持たないこと |

注: 現行方針では後続 WP でこれらを実行しない。ただし WP の差分レビューでは「この表の契約を静的に壊していないか」をチェック項目にする。

## 1. §1 吹き抜け（アトリウム）改善設計 — 対象: `src/world/MotifScenes.ts`

### 1.1 現行 `carveOneAtrium` の解剖（`MotifScenes.ts:444-535`）

1. 1F 候補（`carveAtrium:436-442`）: 屋内・非階段・非コア・`floorY` が -0.4〜1.2・面積 >= 14 の部屋を、ホール優先→面積降順に試し、最初に成功した 1 件で終了する（吹き抜けは最大 1 箇所）。
2. 上階候補: `floorY > hallY + 2` の屋内室とホール矩形の重なり `o` を取り、両辺 >= 3.2m のものだけ `hole = inset(o, 0.9)` し、両辺 >= 1.6m を残して**面積最大の 1 室だけ**を選ぶ（`:450-458`）。
3. `keep`（切り抜かない矩形）: 階段（幅 +0.5、奥行 `steps*run + 0.5`）、上階と同階の既存 `covers`、上階エンティティ ±0.45m の 3 種だけ（`:462-478`）。
4. `voids = subtractRects(hole, keep)` のうち両辺 >= 1.35m の断片すべてを切り抜き対象にする（`:479`）。
5. 床: 上面が上階床 ±0.35m で `hole` と重なる `floors` を `subtractRects(base, voids)` で分割し、0.18m 未満の端材を捨てる（`:482-502`）。
6. 手すり: **`voids` ではなく元の `hole` の 4 辺**に、外側 0.05m・厚さ 0.08m・高さ 1.05m の `prop: 'rail'` を置く。上階室矩形の内側（±0.05m）にあるものだけ残し、`blocked(covers, box, map, 0)` を通ったものだけ追加する。1 本も置けなければ床を確定せず `false` を返す（原子性は保たれている。`:504-534`）。

### 1.2 欠陥（ディレクター指摘の裏付け）

| # | 欠陥 | 仕組み |
|---|---|---|
| F-1 | ギャラリー幅が約 0.9m しかない | `inset(o, 0.9)` 固定。しかも 0.9m は「重なり矩形の縁から」で、上階室の壁からの距離は部屋のずれ次第でさらに狭くなりうる |
| F-2 | 開き戸の目の前に手すりが建つ | `keep` に `map.doors` が無い。手すり側の `blocked` 判定も、扉との距離を「手すり中心と扉中心の距離 < 1.1m」で見るため（`MotifScenes.ts:148-152`）、長い手すりでは端部付近の扉を検出できない。扉の葉は単扉で最大 1.3m（各テンプレート `door.width` 1.2〜1.3m）振れるので、0.9m の通路では葉が手すりに当たる |
| F-3 | 穴と手すりの対応がずれる | 床は `voids`（`keep` で削れた不整形）で切り、手すりは元の `hole` 矩形に置く。`keep` が食い込んだ辺では「床が残っているのに手すりがある」逆に「断片の内側の縁に手すりが無い」が起きる |
| F-4 | 開口が大きすぎる/小さすぎるの制御がない | 上限は上階室との重なり次第。下限 1.6m では腰窓程度の穴でも吹き抜け扱いになる |
| F-5 | 失敗条件が緩い | 手すりが 1 本でも置ければ床を切り抜く（`:532`）。3 辺が素通しでも成立してしまう |

補足: `blocked` 本体（`:140-162`）は同階の `covers`・扉中心距離・スポーン 1.7m・味方 0.9m・エンティティ 0.7m を見る汎用判定で、小道具配置用である。手すり配置では「矩形同士の重なり」で見るべき場面に中心距離を使っているのが F-2 の一因。

### 1.3 設計定数（`MotifScenes.ts` 内の名前付き定数にする）

| 定数 | 値 | 根拠 |
|---|---|---|
| `ATRIUM_GALLERY_TARGET` | 1.8m | 目標ギャラリー幅。単扉の葉 1.3m（embassy）+ 振れ余白 0.4m（`swingClearance` 最大）+ 人の肩幅余裕。両開きは葉が半分（`Door.ts:143`）なので単扉が支配的 |
| `ATRIUM_GALLERY_MIN` | 1.65m | 絶対下限。これ未満しか取れない部屋は吹き抜けを作らない。葉 1.3m + 余白 0.35m（house_compact の `swingClearance`）が根拠で、既存の扉前 `keepOut`（`ModularGenerator.ts:466-470`: 葉幅 + `swingClearance`）とも整合する |
| `ATRIUM_HOLE_MIN_SIDE` | 2.4m | これ未満の開口は「吹き抜け」と呼ばない（現行 1.6m から引き上げ。F-4） |
| `ATRIUM_MAX_AREA_RATIO` | 0.40 | 開口面積の上限 = 上階室面積の 40%。残り 60% がギャラリー+居室として残る |
| `ATRIUM_VOID_MIN_SIDE` | 2.0m | 実際に切り抜く主開口の最小辺（現行の断片フィルタ 1.35m から引き上げ。小断片は切り抜かない） |
| `ATRIUM_DOOR_CLEAR` | 葉幅 + 0.45m | 扉 1 枚ごとの進入路クリアランス（§1.4 手順 D の式）。0.45 = `swingClearance` 最大 0.4 + 壁厚半分相当の余裕 |
| `ATRIUM_SNAP` | 0.25m | 縮小・移動の刻み。全テンプレートの `snap` が 0.25 のため座標の端数が出ない |

「部屋が狭い場合は無理に作らない」判定は §1.4 手順 B・C で定数から機械的に決まる。新たな部屋面積の下限は設けない（定数の合成で十分に決まるため）。

### 1.4 新アルゴリズム（`carveOneAtrium` の置き換え仕様）

処理順は現行の呼び出し関係（`carveAtrium` が 1F 候補を順に試す）を維持し、`carveOneAtrium` の内部だけを以下の手順に置き換える。乱数は使わない（現行どおり決定的。候補の走査順は面積降順で安定させる）。

**手順 A: 上階候補の列挙（現行から拡張）**
- 現行どおり `upper = floorY > hallY + 2` の屋内・非階段・非コア室を集めるが、**1 室で決めず全室を候補として保持**する。各室について重なり `o = overlap(hallRect, rectOf(r))` を求め、`o` の両辺が `2*ATRIUM_GALLERY_MIN + ATRIUM_HOLE_MIN_SIDE`（= 5.7m）未満ならその室を除外する。
- 候補が無ければ `false`（現行どおり）。

**手順 B: ギャラリー幅を満たす開口候補の生成**
- 各候補室について、`g = ATRIUM_GALLERY_TARGET` から `ATRIUM_SNAP` 刻みで `ATRIUM_GALLERY_MIN` まで下げながら `hole = inset(o, g)` を作り、最初に「両辺 >= `ATRIUM_HOLE_MIN_SIDE`」を満たしたものをその室の開口候補とする。満たさなければその室は不採用。
- ここでいうギャラリー幅は「開口縁から、上階室の壁（= 重なり矩形のうち上階室側の縁）までの距離」として 4 辺すべてで測る。重なり矩形の縁がホール側の壁である辺では、ホール壁際の天井切り欠き（§1.6）と競合しないよう、その辺のギャラリーは測らなくてよい（開口がホール壁に接する辺は落下面が壁になるため）。実装では「`o` の辺と上階室矩形の辺が一致する辺」だけをギャラリー判定の対象にする。

**手順 C: 開口面積の上限と主開口の選定**
- `holeArea > ATRIUM_MAX_AREA_RATIO * 上階室面積` の場合は、開口の中心を保ったまま両辺を `ATRIUM_SNAP` 刻みで対称に縮小し、比率以下になるまで繰り返す。縮小の過程でどちらかの辺が `ATRIUM_HOLE_MIN_SIDE` を割ったらその室は不採用。
- 手順 D の `keep` を差し引いた後（手順 E）、残った矩形のうち**面積最大の 1 つだけを主開口 `void` として切り抜く**（現行の「全断片を切る」から変更。F-3 の根本対策で、手すりを 1 矩形の 4 辺に限定できる）。主開口の両辺が `ATRIUM_VOID_MIN_SIDE` 未満なら不採用とし、**次の候補室・次の 1F 候補へ進む**（現行の `carveAtrium` の外側ループがそのまま受け持つ）。

**手順 D: `keep` の拡張（扉・階段・家具・エンティティ・スポーン）**
現行の 3 種に加え、同階（`sameFloor(d.y ?? 0, upY)`）の全扉について次を `keep` に追加する。扉の開く向きは `GeneratedMapRaw` に保存されない（実行時に `Door` が決める）ため、**両側とも**保守的に空ける。

```
leaf   = d.double ? (d.width ?? 1.2) / 2 : (d.width ?? 1.2)   // Door.ts:143 と同じ葉幅
reach  = leaf + 0.45                                          // ATRIUM_DOOR_CLEAR
along  = (d.width ?? 1.2) / 2 + 0.30                          // 扉中心から壁沿いの半幅（枠+肩幅）
// 壁が X 方向（yaw が 0/180 系: 扉面が X 軸方向、types.ts:43）:
doorKeep = { x0: d.x - along, x1: d.x + along, z0: d.z - reach, z1: d.z + reach }
// 壁が Z 方向（yaw が 90/270 系）: x と z を入れ替える
doorKeep = { x0: d.x - reach, x1: d.x + reach, z0: d.z - along, z1: d.z + along }
```

- 追加分: `map.playerSpawn`（同階なら ±1.0m の正方形）、`map.allies`（同階なら ±0.9m、`MotifScenes.ts:155-157` の既存半径と同値）。
- 維持分: 階段（現行の式どおり幅 +0.5・奥行 `steps*run + 0.5`、`:464-472`）、同階 `covers` の `xzOf`、エンティティは ±0.45m から **±0.6m** に拡大（人体半径 0.3m『`GraphPlanner.ts:38`』+ 余白）。
- `keep` は開口候補と重なるものだけが意味を持つ（`subtractRects` が内部でクリップする）ので、全扉を無条件に入れてよい。

**手順 E: 主開口の確定**
- `voids = subtractRects(hole, keep)` から両辺 >= `ATRIUM_VOID_MIN_SIDE` のものを残し、面積最大を `void` とする（手順 C）。同点の場合は `x0`→`z0` 昇順（`subtractRects` の決定的な出力順『`Layout.ts:134`』をそのまま使う）。

**手順 F: 床の切り抜き（現行を主開口 1 つに限定）**
- 現行 `:482-502` と同じく、上面が上階床 ±0.35m で `hole` と重なる床だけを対象に `subtractRects(base, [void])` で分割し、0.18m 未満の端材を捨てたものを `next` とする。**この時点ではまだ `floors` を差し替えない**（手順 H で手すりと一緒に確定する。原子性の維持）。

**手順 G: 手すりの配置（§1.5）**

**手順 H: 確定条件**
- §1.5 の必須手すり区間の被覆率が 100%（通行ギャップとして明示した区間を除く）でなければ、床も手すりも一切変更せず `false` を返し、次の候補へ進む（F-5 の対策。現行の「1 本あれば確定」より厳しくする）。
- 成立したら現行どおり `floors.splice(0, floors.length, ...next)` し、手すりを `covers` へ追加して `true`。

### 1.5 手すりを実開口に沿わせる手順

主開口 `void` の 4 辺それぞれについて:

1. **辺の分類**: 辺の外側（開口の反対側）に上階の床が残っている辺を「必須辺」とする。外側が上階室の外（壁・室外）の辺は、落下先が開口ではないため手すり不要とし、対象から外す。判定は「辺を外側へ 0.3m ずらした帯が、切り抜き後の床矩形（手順 F の `next` のうち上面が上階床のもの）のいずれかと重なるか」で行う。
2. **通行ギャップの差し引き**: 必須辺の区間から、次と重なる区間を引く（辺方向の 1 次元区間演算。既存の区間引き算は `Layout.ts` の `subtractRects` を薄く使うか、辺ごとに `[lo, hi]` の配列で引く）。
   - 扉の `doorKeep`（手順 D）が辺と交わる区間 + 前後 0.1m — ただし `doorKeep` は `keep` として床も残るため、その区間はそもそも開口が途切れる位置と一致するはずで、手すりを置くと扉前を塞ぐ。ここを開けるのが「ドアを塞がない」要件の実装になる。
   - 階段の `keep` が辺と交わる区間（階段の乗降口。床が残り段差なく歩ける）。
   - 家具 `covers` の `keep` が交わる区間は**ギャップにしない**（家具自体が転落防止の実体になるため。ただし家具の高さが 0.9m 未満の場合は必須辺として残す）。
3. **区間の実体化**: 残った各区間について、辺の外側 0.05m・厚さ 0.08m・高さ 1.05m（現行踏襲）の `prop: 'rail'` の箱を作る。区間長 0.5m 未満の端材は作らない（隣接区間と角で吸収する。角では直交する辺の手すりと 0.08m 重ねて隙間を塞ぐ）。
4. **衝突検査（中心距離ではなく矩形重なり）**: 作った箱の `xzOf` が、同階の既存 `covers`・上階室矩形の外と重ならないことを `rectsOverlap` で確認する。現行の `blocked(..., 0)` は使わない（F-2）。重なる箱はその区間を不成立とし、手順 H の被覆率に響かせる（勝手に短くしない）。
5. 描画は既存の `Scenery.ts` の `rail` ビルダー（支柱+上下レール、『`Scenery.ts:333-346`』）がそのまま使える。寸法の契約（幅=辺方向の長さ、奥行=0.08）も現行どおりで変更不要。

### 1.6 コライダ・スラブ・天井との整合

| 対象 | 仕組み | 本設計での扱い |
|---|---|---|
| 手すりの当たり | `covers` の箱は `WorldBuilder.buildBoxes(..., 'cover', ...)` でコライダ化される。`rail` も同じ経路 | 変更なし。手すり高さ 1.05m の箱がそのまま壁として効く |
| 切り抜いた床 | `map.floors` は `buildBoxes(map.floors, 'floor', ...)`（`WorldBuilder.ts:117`）で床コライダ+描画になる。MotifScenes は配列を差し替えるだけ | 変更なし。手順 F の端材 0.18m 規則を維持し、歩行面の欠けを作らない |
| 1F ホールの天井 | `WorldBuilder.buildFloorAndCeiling` の `ceilingCutouts`（`WorldBuilder.ts:314-338`）が「直上の床スラブ・上階屋内室・天井を貫通する階段」を天井から差し引く。吹き抜け部は上階スラブが無いため天井も開く | 変更なし。ただし上階室矩形そのものが切り欠き対象なので、開口がホール壁に接する辺（手順 B でギャラリーを測らない辺）では天井の開き方が不均一になりうる。これを理由に `WorldBuilder` は触らない（WP の持ち分外。気になる場合は申し送り） |
| 生成器側の吹き抜けとの二重管理 | 生成器の `doubleHeight` 室は 1F 側に 2 層分の `ceilingY` を持ち（`ModularGenerator.ts:560`）、その直上には 2F 室が置かれない（`SpatialSolver.ts:472` の `S1F` から除外）。したがって MotifScenes の上階候補と重ならず、自然に競合しない | 変更なし。§2 の `doubleHeightChance` 引き上げと本節は別の吹き抜け経路として併存させる（片方は生成器の室単位、もう片方は後処理の床開口） |
| 落下 | 歩行は床コライダの有無で決まる。主開口以外の小断片を切らない（手順 C）ことで「手すりの無い小穴」を作らない | 本設計の要点 |

### 1.7 実装時の不変条件チェック（レビュー用）

- [ ] `ATRIUM_GALLERY_MIN` 未満のギャラリーで吹き抜けが成立していない（4 辺のうち上階室の壁に接する辺すべて）。
- [ ] 同階の全扉の `doorKeep` が `keep` に入り、手すりがどの扉の `doorKeep` とも重なっていない。
- [ ] 切り抜かれるのは主開口 1 矩形だけ。手すりはその必須辺の（通行ギャップを除く）全区間を覆う。
- [ ] 不成立時に `floors`・`covers` が一切変わらない（手順 H の原子性）。
- [ ] 乱数を消費しない。同じ入力マップに対して決定的。
- [ ] `scenery.test.ts:79-95` の観測契約（2 階建てで手すりあり）を静的に壊していない: 候補室・1F 候補を順に試すため、1 室の不採用で全体を諦めない。

## 2. §2 モジュラー建築バリエーション強化設計

### 2.1 共通ルール（全テンプレート共通・安全性の要）

| # | ルール | 理由 |
|---|---|---|
| R-1 | 新モジュールはすべて `minCount: 0`。バリエーションは `weight` と `maxCount` で広げる | §0.3。`minCount` はフォールバック必須列と通常選出の必須枠を直接太らせる |
| R-2 | `fallbackModuleId` は `storage` のまま。新モジュールをフォールバックにしない | V-7（`subRooms` なし等の条件を新モジュールで満たし続ける保証が要らない） |
| R-3 | カテゴリは既存 10 種のみ。新モジュールの「特徴」は `id`・寸法・`roofStyle`・`doubleHeightChance`・`subRooms`・家具・`allowedLevels` の組み合わせで表現する | V-9 |
| R-4 | `doubleHeightChance > 0` は `stackable`・非 `entry` のモジュールだけに付ける。2F 専用モジュール（`allowedLevels: [1]`）には付けない（1F インスタンスが無いと抽選対象にならない。`GraphPlanner.ts:336-342` は 1F のみ走査） | V-2 と選出仕様 |
| R-5 | 新モジュールの寸法は短辺最小 >= 3.5m を目安にする（下限 1.6m は検証上の話で、CQB の回遊には狭い）。`subRooms` を持つ親は櫛形分割『`SpatialSolver.ts:1290-1355`』が収まる寸法にする（親の片辺 >= ハブの `minSide` + 他の子の最大 `minSide`、もう片辺 >= 他の子の `minSide` 合計） | 配置不成立は `RetryGeneration` で作り直しになるだけで落ちはしないが、出現率が下がる |
| R-6 | `subRooms` の `minSide` はテンプレートごとの下限（compact 1.82 / house 1.93 / embassy 2.06m）に対し、snap 0.25 に切り上げて **compact・house は 2.0m 以上、embassy は 2.25m 以上**を最低ラインとし、実用上は下記の各定義どおり 3.75m 以上にする | V-4 |
| R-7 | 家具 `id` は原則として既存の家具 ID の再利用にする。新規 ID は箱として描かれる（`buildScenery` が `null` を返し `WorldBuilder` が箱描画する）ため壊れはしないが、見た目の特徴は §2.4 のプロップ追加とセットで初めて出る | `Placement.ts:74`、`Scenery.ts:436-447` |
| R-8 | `allowedEdges` はカテゴリ対（無向）で最大重みの 1 件だけが有効（`GraphPlanner.ts:122-146`、『後勝ちではなく重み最大』）。既存対に別スタイルで追加しても併存しない。新モジュールが既存カテゴリを使う限り既存の辺がそのまま効くので、**辺の追加は「今まで存在しなかったカテゴリ対」にだけ**行う | 二重定義による意図せぬスタイル上書きの防止 |
| R-9 | `storyProfiles`・`stairCore`・`site`・`door`・`window` の数値は本設計では変更しない（階数分布と扉寸法は §1 の定数の根拠であり、変更すると再検証が要る） | 影響範囲の限定 |
| R-10 | 新モジュールの `id` は `Motif.ts` の `roleOf`（`Motif.ts:729-741`）が意図した役割に分類される名前を選ぶ。具体策は §2.2 の各モジュール定義（「役割」欄）と §2.3 のとおりとし、`Motif.ts` の正規表現は原則変更しない | 部屋名・床材・モチーフ小道具は役割経由で決まるため |

### 2.2 テンプレート別の追加モジュール

凡例: 「接続」は `allowedEdges` の観点（カテゴリ対）。既存対で賄える場合は「既存対で接続可」と明記する。各テンプレートの現行モジュール数は compact 11 件 / house 16 件 / embassy 18 件で、上限 32 件（V-1）まで余裕がある。

#### 2.2.1 `house_compact.json`（小規模住宅）: +3 件 → 14 件

現状の弱点: 中庭カテゴリが無く（`courtyard` モジュール自体が無い）、2F の特徴がバルコニー 1 種だけ。地下は `cellar` のみ。

| ID | 定義 |
|---|---|
| `living_atrium` 吹き抜けリビング | `category: living_hub`, `allowedLevels: [0]`, `minCount: 0, maxCount: 1, weight: 1.6`, `width 9.5〜12.0, depth 8.5〜11.0`, `roofStyle: stackable`, `doubleHeightChance: 0.35`, `spawnWeight: 3`, `floorMaterial: wood`。家具: `sofa`(2.2×0.9)・`low_table`・`tv_board`（既存 ID 流用）。`subRooms`: `living`（shareWeight 0.62, minSide 4.5, arch, spawnWeight 3）+ `kitchen`（0.38, minSide 4.0, arch, spawnWeight 2）— 既存 `ldk` の子構成を踏襲し、親を大きくした分だけ吹き抜け抽選を高くした版。接続: `living_hub` の既存対（corridor・study_office・wing_private・terrace）で接続可。役割: `living` を含むため `roleOf` は `social` |
| `inner_court` 内包中庭 | `category: courtyard`, `allowedLevels: [0]`, `outdoor: true`, `minCount: 0, maxCount: 1, weight: 1.2`, `width 5.5〜8.0, depth 5.5〜8.0`, `roofStyle: open_sky`, `doubleHeightChance: 0`, `spawnWeight: 0`（V-5）。家具: `planter`(0.7)・`bench`（既存 ID 流用。どちらも現行は箱描画、§2.4 で `planter` を詳細化）。接続: **新規対の追加が要る** — `corridor→courtyard (exterior_door, weight 2.0)` と `living_hub→courtyard (exterior_door, weight 2.0)` を `circulation.allowedEdges` に追加（house・embassy と同じスタイル・重みの付け方）。`forbiddenEdges` には触らない。役割: `court` を含むため `outdoor` |
| `vault_cellar` 地下保管庫 | `category: basement_utility`, `allowedLevels: [-1]`, `minCount: 0, maxCount: 1, weight: 1.6`, `width 5.0〜7.0, depth 5.0〜7.0`, `roofStyle: stackable`, `spawnWeight: 1.8`, `floorMaterial: concrete`。家具: `crates`・`safe`（既存 ID 流用）。接続: `basement_utility` の既存対で接続可。役割: `vault` を含むため `secure`（既存 `cellar` も `cellar` の語で `secure` になるため、差別化は役割ではなく「より小さな奥室+金庫家具」で行う） |

併せて行う既存値の微調整（このファイル内のみ）: `ldk.doubleHeightChance` を 0.15 → 0.22 に上げる（R-4 を満たす既存モジュール。吹き抜け住宅の出現率を上げる）。これ以外の既存モジュールの寸法・個数は変えない。

#### 2.2.2 `house.json`（大型邸宅）: +3 件 → 19 件

現状の弱点: 2F は寝室+テラスのみで「回廊」らしい室がなく、地下は倉庫系 2 種のみ。中庭・テラスは既にある。

| ID | 定義 |
|---|---|
| `gallery_hall` 2F ギャラリー回廊 | `category: corridor`, `allowedLevels: [1]`, `minCount: 0, maxCount: 2, weight: 1.4`, `width 3.5〜4.5, depth 8.0〜13.0`, `roofStyle: stackable`, `doubleHeightChance: 0`, `spawnWeight: 0.35`, 家具: `console`・`bench`。狙い: 細長い 2F 廊下がウイング間をつなぎ、§1 の吹き抜け開口の周囲を回る回廊になりやすい形にする。2F 配置は 1F の `stackable` 室の上にしか置けない（`SpatialSolver.ts:498-500`）ため、出現は 1F 構成に従属する（それでよい）。接続: `corridor` の既存対で接続可。役割: `hall` を含むため `circ` |
| `penthouse_suite` ペントハウス | `category: wing_private`, `allowedLevels: [1]`, `minCount: 0, maxCount: 1, weight: 1.3`, `width 8.0〜10.5, depth 7.0〜9.0`, `roofStyle: stackable`, `spawnWeight: 2.6`, `floorMaterial: carpet`。`subRooms`: `bed`（0.65, minSide 4.5, door, spawnWeight 2.6）+ `ensuite`（0.35, minSide 3.75, private: true, door, spawnWeight 0.6）— 既存 `master_suite` の子構成を 2F 専用にした版。接続: `wing_private` の既存対（terrace への `exterior_door` 含む）で、隣接テラスと組になりやすい。役割: `suite` を含むため `private` |
| `garage_cellar` 地下ガレージ・作業庫 | `category: basement_utility`, `allowedLevels: [-1]`, `minCount: 0, maxCount: 1, weight: 1.5`, `width 7.0〜9.5, depth 6.0〜8.5`, `roofStyle: stackable`, `spawnWeight: 1.6`, `floorMaterial: concrete`。家具: `tool_shelf`・`crates`。狙い: 地下に「車庫的な広さの作業空間」を作り、地下=狭い倉庫の単調さを崩す。`category` を `garage` にしないのは、`garage` の既存辺（`forbiddenEdges` の `garage-wing_private` 等）と `any_exterior` 前提（地下では外周露出の検査『`SpatialSolver.ts:731-737`』を通らない）を避けるため。接続: `basement_utility` の既存対で接続可。役割: `garage` を含むため `service` |

併せて行う既存値の微調整: `dining.doubleHeightChance` を 0 → 0.18、`ldk` を 0.2 → 0.28 に上げる（どちらも `stackable`・非 `entry`・1F 配置あり で R-4 を満たす）。

#### 2.2.3 `embassy.json`（大使館）: +3 件 → 21 件

現状の弱点: 1F のホール系は充実しているが、吹き抜け抽選は `reception_hall` の 0.2 のみ。2F は執務・VIP の繰り返しで、地下は保管庫+機械室のみ。

| ID | 定義 |
|---|---|
| `reception_atrium` 吹き抜けレセプション | `category: living_hub`, `allowedLevels: [0]`, `minCount: 0, maxCount: 1, weight: 1.4`, `width 12.0〜16.0, depth 10.0〜14.0`, `roofStyle: stackable`, `doubleHeightChance: 0.40`, `spawnWeight: 4`, `floorMaterial: wood`。家具: `banquet_table`・`podium`（既存 ID 流用）。`subRooms`: `reception`（0.6, minSide 5.0, arch, spawnWeight 4）+ `waiting`（0.4, minSide 4.0, arch, spawnWeight 2、家具 `waiting_bench`）。狙い: 生成器側の吹き抜け（天井高 2 層）を持つ大ホールで、§1 の後処理吹き抜けとは別経路の「見上げられる大空間」を出す。接続: `living_hub` の既存対で接続可。役割: `reception` を含むため `social` |
| `link_corridor` ガラス連絡回廊 | `category: corridor`, `allowedLevels: [0, 1]`, `minCount: 0, maxCount: 2, weight: 1.5`, `width 4.0〜5.5, depth 9.0〜15.0`, `roofStyle: stackable`, `doubleHeightChance: 0`, `spawnWeight: 0.4`, `floorMaterial: tile`。家具: `pillar_display`・`waiting_bench`（既存 ID 流用）。狙い: 既存 `grand_hall`（幅 4.75〜6.25 の大廊下）より細長く、ウイング間リンクとして L 字・コの字の継ぎ目になりやすい形。ガラス感は材質ではなく既存の室内窓口（`window.interiorChance` は既存で 0.55 ある）とモチーフの `panel` 内装で表現する（新カテゴリや新テクスチャは作らない）。接続: `corridor` の既存対で接続可。役割: `corridor` を含むため `circ` |
| `archive_cellar` 地下公文書庫 | `category: basement_utility`, `allowedLevels: [-1]`, `minCount: 0, maxCount: 2, weight: 1.8`, `width 6.0〜8.5, depth 6.0〜8.5`, `roofStyle: stackable`, `spawnWeight: 1.8`, `floorMaterial: concrete`。家具: `file_cabinet`・`safe`（既存 ID 流用）。狙い: 既存 `vault`（金庫）と別に「書庫の列が並ぶ地下」を作る。接続: `basement_utility` の既存対で接続可。役割: `archive` を含むため `secure` |

併せて行う既存値の微調整: `reception_hall.doubleHeightChance` は据え置く（新 `reception_atrium` と役目が重なるため上げない。出現の振り分けは `weight` 1.4 対 2.0 で行う）。

### 2.3 モチーフ連携（`Motif.ts`・`MotifScenes.ts`・`Scenery.ts`）

**カテゴリ重み（`Motif.ts` の `categoryWeight`）**: 新モジュールのカテゴリはすべて既存の重み対象（`living_hub / corridor / courtyard / wing_private / basement_utility`）に収まるため、`categoryWeight` の値変更は不要で、モチーフごとの偏りが自動で効く。例: 病院は `basement_utility: 1.25`・`corridor: 1.2`（地下と回廊が増える）、クラブハウスは `courtyard: 1.25`・`terrace: 1.3`（中庭とテラスが増える）、倉庫は `basement_utility: 1.5`（地下庫が増える）。`withMotifBias` はフォールバック対象外（§0.3）なので、この偏りで最小構成が壊れることはない。

**部屋の役割と名前（`roleOf`）**: 新 ID は §2.2 のとおり、既存の正規表現で意図した役割に入るよう命名した。実装時に `Motif.ts` を変更する必要はない。ただし次の 2 点はレビューで確認する。

- `living_atrium`・`reception_atrium` は `pickHall`（`MotifScenes.ts:322-349`）の加点対象（`ldk|hall|lobby|reception|living|genkan` を含む）になるため、モチーフのホール名（メインホール等）と床材替え・列柱・梁と吊り灯の対象になりうる。これは意図どおり（大空間の演出を既存の仕組みで受ける）。
- `gallery_hall`（2F）は `pickHall` の対象外（1F のみ走査）で、ホール演出は受けない。2F ギャラリーの演出は §1 の手すりと、§2.4 のプロップ追加で担保する。

**空間演出プロップ（`MotifScenes.ts` の `ROOM_PROPS` と `Scenery.ts`）**: §2.4 のとおり WP-1 で扱う。WP-2 の家具 ID は既存 ID の流用に限定したため、WP-2 単独でも（箱描画の範囲で）動作は完結する。

### 2.4 空間演出の追加（WP-1 の範囲）

`Scenery.ts` の `SCENERY_PROPS`（`Scenery.ts:11-16`）に無く、現行は箱で描かれている家具 ID のうち、新モジュールで多用するものを詳細メッシュ化する。追加は次の 3 件に限定する（ビルダーは既存部品の組み合わせで作り、新テクスチャは作らない）。

| prop | 使う場所 | 描画の要点（既存ビルダーの流用元） |
|---|---|---|
| `planter` | 中庭・テラス・アプローチ（既存でも使用中） | `container` の箱体+上部に緑の円柱/箱を載せる簡易植栽。モチーフの葉色は使わず `linen`/`wood` 系で受ける |
| `island` | `house` のキッチン子室（既存 `ldk.subRooms.kitchen` で使用中） | `counter` ビルダーの別名登録でよい（`BUILDERS` に `island: counter` を足すだけ） |
| `banquet_table` | 大使館 `reception_hall`・新 `reception_atrium` | `table` ビルダーの別名登録（`banquet_table: table`）。長い天板は寸法がそのまま効く |

あわせて `MotifScenes.ts` の `ROOM_PROPS` に、新モジュールの部屋で不足するモチーフ小道具を役割経由で 1〜2 件足すことを許可する（例: `office` の `work` にある `partition` を大ホールの島として置く等）。ただし `placeSpec` の上限管理（`MotifScenes.ts:570` の `limit` 表）に無い prop は既定上限 2 になるため、追加する prop は `limit` 表にも明記する。

### 2.5 `GraphPlanner` / `SpatialSolver` の扱い（WP-3・任意）

現行の 1F 配置スコアは `bbox 面積 × (1 + 0.3*乱数) / (1 + 0.1*接触長)`（`SpatialSolver.ts:607-614`）で、外接矩形が小さい=詰まった長方形を好む。これが「単調な長方形」の一因。

WP-3 では次だけを行う（行わなくても WP-1・WP-2 は完結する。統合時に余裕が無ければ WP-3 は落としてよい）。

- 候補スコアに「既配置室と 2 方向（直交する 2 辺）で接する候補への割引」を足す: 接触辺の軸が 2 種類ある候補はスコアを 0.85 倍する。L 字の凹みに嵌る配置が選ばれやすくなり、輪郭に段差が残る。
- 乱数の呼び出し回数・候補列挙順・`validCandidate` の受理条件は一切変えない（§0.3 の決定性と、面積比・包含チェックへの無影響を保つ）。
- `doubleHeight` の抽選（`GraphPlanner.ts:336-342`）には触らない。出現率は §2.2 の `doubleHeightChance` 値で調整する（済み）。

やってはいけないこと: `pickStoryProfile` の降格、試行回数の変更、フォールバック構成器への干渉、乱数ストリームの分岐追加。これらは V-8 と決定性の契約に直結する。

## 3. §3 並列実装 WP 分割（ファイル重複ゼロ）

| WP | 内容 | 変更ファイル | 変更禁止（読むだけ） |
|---|---|---|---|
| WP-1: 吹き抜け足場改善+空間演出 | §1 の `carveOneAtrium` 置き換え、§2.4 のプロップ 3 件と `ROOM_PROPS` 微追加 | `src/world/MotifScenes.ts`, `src/world/Scenery.ts` | `Motif.ts`, `public/data/generators/*.json`, `generator/*`, `WorldBuilder.ts`, `Door.ts`, `types.ts` |
| WP-2: モジュラーテンプレート+モチーフ連携 | §2.2 の新モジュール 9 件・既存値微調整・`house_compact` への中庭辺 2 件追加 | `public/data/generators/house_compact.json`, `public/data/generators/house.json`, `public/data/generators/embassy.json`, `src/world/Motif.ts`（原則変更なし。やむを得ない場合のみ `roleOf` の語彙追加に限定） | `MotifScenes.ts`, `Scenery.ts`, `generator/*`, `DataLoader.ts` |
| WP-3（任意）: 輪郭バリエーション補助 | §2.5 のスコア割引のみ | `src/world/generator/SpatialSolver.ts` | `GraphPlanner.ts`（読むだけ）, `ModularGenerator.ts`, テンプレート JSON |

WP 間の共有契約（全 WP が守る。レビューはこの表で照合する）:

| # | 契約 |
|---|---|
| S-1 | `GeneratedMapRaw`・`DoorDef`・`BoxDef`・`RoomDef` の型と意味を変えない。`MotifScenes` は生成済みの壁・扉・スポーンを動かさない（現行冒頭コメント『`MotifScenes.ts:7-11`』の原則） |
| S-2 | 家具・小道具の `prop` ID 語彙は WP-1（`Scenery.ts` の `SCENERY_PROPS`/`BUILDERS`）が持ち、WP-2 は既存 ID のみを使う。WP-2 単独でも箱描画で成立し、WP-1 が入ると見た目が詳細化される（順序依存なし） |
| S-3 | `ModuleCategory`・`fallbackModuleId`・`storyProfiles`・扉寸法にはどの WP も触らない（V-7〜V-9、§1 の定数の根拠を保つ） |
| S-4 | 乱数の消費順を変える変更は WP-3 のスコア割引のみ（乱数呼び出し回数は不変）。WP-1 は乱数を追加しない |
| S-5 | 各 WP の完了条件は `npm run build` の終了 0 のみ。テストは実行しない（現行方針）。差分レビューは別モデルが 1 回行い、§0.4 と §1.7 と本表を照合する |

実装順序の目安: WP-1 と WP-2 は独立に並列可。WP-3 は任意で最後。統合後にディレクターへ遊べる状態（起動コマンド）と §4 の確認点を渡す。

## 4. §4 受け入れ基準（ディレクターのプレイで確認）

自動テストではなく、実プレイで次を確認する（1 件でも崩れたら該当 WP に差し戻す）。

| # | 確認点 | 合格の目安 |
|---|---|---|
| AC-1 | 2F ギャラリーを歩く | 吹き抜け周囲を一周でき、幅に窮屈さがない（壁際から手すりまで大人がすれ違える感覚）。狭くて作られていない場合は無理に穴が開いていない |
| AC-2 | 吹き抜けに面した扉を開ける | どの扉も全開でき、葉が手すりに当たらず、扉の目の前に手すりが立っていない。開けた扉の先に落下穴が直結していない |
| AC-3 | 手すりと落下 | 開口の縁を一周見て、手すりの切れ目は階段・扉前の通行部だけ。手すりの無い縁から落ちる場所がない。1F から見上げて天井の開き方が破綻していない |
| AC-4 | 建物のバリエーション | 同じテンプレートで数回生成し、吹き抜け大ホール・中庭・2F 回廊/ペントハウス・地下庫など、形の違う建物が混ざって出る。毎回同じ長方形にならない |
| AC-5 | 立体戦闘の面白さ | ギャラリーから 1F ホールを見下ろす射線と、1F から見上げる死角が両方できている。中庭・連絡回廊が回り込みルートとして機能する |

補足（プレイ前の機械確認）: 起動は `npm run dev`（開発）または `npm run build` 後のプレビュー。ビルドが通らない状態ではプレイ確認に進まない。

## 付録 A. 実装者チェックリスト（WP-2 の JSON 編集用）

- [ ] 新モジュール全件が `minCount: 0` で、`modules` 総数が 32 件以下（compact 14 / house 19 / embassy 21）。
- [ ] `doubleHeightChance > 0` は `stackable` かつ非 `entry` かつ 1F 配置ありのモジュールだけ。
- [ ] `subRooms` を持つのは屋内・非 `private` の親だけ。各 `minSide` が当該テンプレートの下限（compact・house 2.0m / embassy 2.25m）以上で、親寸法に櫛形分割が収まる。
- [ ] 屋外モジュールは `spawnWeight: 0`・`allowedLevels` に -1 を含まない。`terrace` は `[1]` のみ。
- [ ] `allowedEdges` の追加は新規カテゴリ対（`house_compact` の中庭 2 件）だけ。`forbiddenEdges` と重なる対を追加していない。
- [ ] 家具 ID はすべて既存 ID。家具の `count` は 1〜16 の整数範囲。
- [ ] `fallbackModuleId`・`storyProfiles`・`door`・`window`・`stairCore`・`site` を変更していない。
- [ ] ロード時に `DataError` が出ないこと（= `verifyFallbackFeasibility` を含む検証通過）を、ゲーム起動または `npm run build` 後の画面で確認できる状態にする。
