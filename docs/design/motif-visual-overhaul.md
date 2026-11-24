# エリアモチーフのビジュアル改善 設計書

- 作成日: 2026-11-24
- 対象: `hospital`, `clubhouse`, `bank`, `office`, `warehouse`, `house`, `plain`（全 7 モチーフ）
- 目的: **ちらつきの根本解消・目に優しい落ち着いた色調と高い視認性・建築としてのリアリティ向上**
- 区分: C（文書）。本書の後は WP-1〜WP-3 を並列実装する。各 WP のファイル持ち分は §3 の表が正本であり、重複はない。

## 1. 課題一覧と根本原因

### 観点 A: ちらつき（モアレ・ジャギー・時間的チラツキ）

| # | 現象 | 根本原因（コード裏付け） | 対応 WP |
|---|---|---|---|
| A-1 | 壁・床の縁がギラつく | `PostFX.ts:49` の `EffectComposer` がデフォルト RenderTarget（`samples: 0`）で、`main.ts:143` の `WebGLRenderer({ antialias: true })` が composer 経由では無効化される。MSAA が事実上 OFF | WP-2 |
| A-2 | 壁面全体がザラつき・時間的にチラつく | `PostFX.ts:56-57` の `GTAOPass` が `scale: 1.25, samples: 12` に対し denoise が `rings: 2, samples: 12` で弱く、AO の粒状ノイズが残る。`blendIntensity: 1` でそのまま 100% 合成 | WP-2 |
| A-3 | 移動・視点回転で床・壁・扉が激しくモアレる | `Materials.ts` の手続きテクスチャが 256px / 2m タイリング（`WorldBuilder.ts:40,60-74` の `TEXTURE_TILE_METERS = 2` + `alignBoxTexture`）なのに、1〜3px 周期の高周波パターンを持つ。該当: `paintCarpet`（2px 行縞, L491-504）、`paintTatami`（3px 縦縞, L507-528）、`paintCorrugated`（10px リブ, L572-587）、`paintSiding`（14px 行, L560-570）、`paintLinen`（4px 横線, L632-647）、`paintDoorGray`（5px 縦縞, L650-661）、`paintTilePalette` の 4x4 市松（L454-473）、`paintCeiling` の 3x3/4x4 市松（L602-630） | WP-1 |
| A-4 | 壁の中段・床全面に不自然な縞が反復する | `paintPanel` のアクセント帯（L417-420, L435-437, L448-452）、`paintLinoleum` の中央十字＋下端帯（L479-488）、`paintCarpet` の縁取り（L500-503）、`paintTatami` の布縁（L518-527）、`paintCorrugated` の `y=28` 横線（L580-585）が、2m 周期タイリングで壁・床のどこにでも出る構造線になっている | WP-1 |
| A-5 | 部屋移動時に照明がパッと切り替わる | `RoomLightPool.ts:18,62-99` は切替をフェード（`FADE_PER_SEC = 5`）するが、`select()` が `RESELECT_SEC = 0.2` ごとに最近傍 8 灯を無条件で入れ替え、境界付近でスロットが頻繁に付け替わる。ヒステリシスなし | WP-2 |

### 観点 B: 目の疲れ（白飛び・眩しさ・暗さ）

| # | 現象 | 根本原因（コード裏付け） | 対応 WP |
|---|---|---|---|
| B-1 | hospital・office が白飛びして眩しい | `Motif.ts:112-125,367-387`。hospital は壁 `0xf4f7f6`・天井 `0xfbfefd`・大理石 `0xf3f7f6` とほぼ純白に `roomIntensity: 15`・`exposure: 1.22`。office も壁 `0xe7eaee`・天井 `0xf4f6f8` に `roomIntensity: 13.5`・`exposure: 1.16`。sRGB 0.95 以上の面に強照明＋高露出の三重苦 | WP-1 |
| B-2 | clubhouse が暗く赤茶一色で見にくい | `Motif.ts:200-213`。`hemiIntensity: 0.32`・`roomIntensity: 8.5`・`exposure: 0.98` と全モチーフ最低クラス。天井 `0x4a3024`・壁 `0x6b3e28` で暗部の諧調が潰れる | WP-1 |
| B-3 | 天井の照明板が眩しい | `WorldBuilder.ts:534-537` の diffuser が `MeshBasicMaterial`（素通しの発光色）で、常に `tints[0]` の明るい色。部屋ごとの tint にも追従していない | WP-1 |
| B-4 | 周辺減光が暗部をさらに潰す | `PostFX.ts:12,38-40` の vignette `strength: 0.38` が強め。暗い clubhouse・warehouse の四隅が潰れる | WP-2 |
| B-5 | PBR が平板で目が休まらない | `scene.environment` が未設定（`src` 全体に `scene.environment` への代入なし）。`WorldBuilder.ts:145-161` の `material()` は `roughness`・`metalness` の数値だけで、`bumpMap`・`roughnessMap` がなく全表面が完全フラット。金属・石材がのっぺり見える | WP-1（質感）+ WP-2（IBL） |

### 観点 C: 視認性（キャラクターの読み取りやすさ）

| # | 現象 | 根本原因（コード裏付け） | 対応 WP |
|---|---|---|---|
| C-1 | 背景がうるさく敵・民間人が埋もれる | 高コントラストの市松・縞（A-3）が背景全面にある。SWAT 4 / Ready or Not 系の「彩度を抑えた中間調の背景＋人物シルエットのコントラスト」という関係になっていない | WP-1 |
| C-2 | 派手なデカールが視線を奪う | `Decals.ts:7,44-56` で最大 72 枚、`chance(0.8)`＋`chance(0.72)` と高確率で、黄黒斜線・看板・ポスター・落書きが部屋ごとに貼られる。原色（`#f0c020` 等）が多い（`Materials.ts:707-780`） | WP-3 |
| C-3 | 床にポスター・看板が斜め貼りされる | `Decals.ts:62-84` の `addFloorDecal` が `pickKind` で種別フィルタ無し。`poster`・`sign`・`vault`・`medcross` が床に回転して貼られる | WP-3 |
| C-4 | 壁デカールが空中に浮く・貫通する | `Decals.ts:86-116` の `addWallDecal` が部屋矩形からの決め打ち配置で、壁の実在・窓・ドア開口を確認しない（`addFacadeSign` のみ `map.walls` を見る）。`inset: 0.08` の面に壁が無いこともある | WP-3 |

### 観点 D: リアリティ（建築としての説得力）

| # | 現象 | 根本原因（コード裏付け） | 対応 WP |
|---|---|---|---|
| D-1 | 既存の高品質テクスチャが使われていない | `public/textures/` に `plaster.webp`・`concrete.webp`・`wood.webp`・`fabric.webp` があるのに、`Materials.ts:69,86-94` は `themed`（モチーフあり）時に `paintThemed` へ早期 return し、webp 重ねをスキップする。モチーフあり＝全マップの大半で低品質な 256px 矩形塗りになる | WP-1 |
| D-2 | おもちゃ感のある色・造形 | `Scenery.ts` 全体に素色の白（`0xf7fffb` 系リネン・陶器が 10 箇所以上）、真鍮 `0xf0d78c`、ピアノ黒鍵 `0x1a1a1a` など、建築調度品として彩度・明度の Natura 感がない。`lamp` の `emissiveIntensity: 0.85`（L421-422）も強すぎる | WP-3 |
| D-3 | 幅木・腰壁・目地がテクスチャ任せ | D-1 と同根。`paintPanel` の `wallStyle`（clinical／wood／stone／metal）や `paintCeiling` の `ceilingStyle` は発想自体は良いが、構造線がタイリング破綻している（A-4）。構造はジオメトリ、肌理はテクスチャに分離されていない | WP-1 |
| D-4 | 部屋ごとの照明色のバラつきが不自然 | `WorldBuilder.ts:513,528-531` で `roomLights` を `idx % length` で順番に振るため、隣室どうしで白熱灯／昼光色が交互になり、施設の照明計画として不自然 | WP-1 |

## 2. ビジュアル方針

SWAT 4 / Ready or Not 系の「落ち着いた建築リアリズム」を目標とする。具体的な数値レンジは以下を全 WP 共通の物差しにする。

- **大面積の面（壁・床・天井）は低〜中彩度**: HSL 彩度 35% 以下。純白・純黒を使わない（sRGB 各チャネル `0x10`〜`0xEC` に収める）。
- **明度のレンジ**: 壁面の平均的な明るさは sRGB で `#909090`〜`#C8C8C8` 相当（L\* 60〜80）。`0xf4f7f6` のような 0.95 以上の面を広面積に使わない。暗いモチーフの床・天井も `#3A3A3A`（L\* 25）より明るくし、暗部の諧調を残す。
- **背景と人物のコントラスト**: 背景は低コントラスト（隣接面の輝度差 15% 以内、微細ノイズの輝度差 12% 以内）に抑え、人物（暗い容疑者・明るい民間人双方）のシルエットが読めるようにする。背景側から騒がしくしない。
- **光は「施設の照明計画」として統一**: 1 モチーフの室內光は色温度を 2 系統以内に絞り、隣室で交互に変わらない（D-4 の是正）。`roomLights` 配列は「暖色系・寒色系」の 2 色＋予備 1 色まで。
- **質感は「肌理はテクスチャ、構造はジオメトリ」**: 幅木・腰壁・目地・タイルグリッドの構造線はタイリング破綻しないものだけテクスチャに残し、位置が意味を持つ線（幅木・アクセント帯・布縁）はジオメトリか削除に寄せる。

## 3. WP 分割とファイル持ち分・インターフェース契約

| WP | 担当 | 変更ファイル | 変更禁止（読むだけ） |
|---|---|---|---|
| WP-1（テクスチャ・質感・モチーフパレット・ライティング刷新） | テクスチャ設計・パレット・atmosphere・室内灯ハウジング | `src/world/Materials.ts`（`paintDecal` 関数のみ除く）、`src/world/Motif.ts`、`src/world/WorldBuilder.ts`、`src/world/StaticBatcher.ts`（署名追加時のみ） | `Decals.ts`、`Scenery.ts`、`PostFX.ts`、`RoomLightPool.ts`、`main.ts`、`Door.ts` |
| WP-2（レンダリング品質・MSAA・GTAO・IBL・照明スムーズ化） | 描画パイプライン・環境光・プール動特性 | `src/core/PostFX.ts`、`src/world/RoomLightPool.ts`、`src/main.ts` | `Materials.ts`、`Motif.ts`、`WorldBuilder.ts`、`Decals.ts`、`Scenery.ts` |
| WP-3（デカール・小道具のリアリティ＆ノイズ低減） | デカール配置・デカール画・小道具色 | `src/world/Decals.ts`、`src/world/Scenery.ts`、`src/world/Materials.ts`（`paintDecal` 関数のみ） | `Motif.ts`、`WorldBuilder.ts`、`PostFX.ts`、`RoomLightPool.ts`、`main.ts` |

`Materials.ts` は WP-1 と WP-3 で共有するため、関数単位で分離する（§3.1 契約 C8）。

### 3.1 インターフェース契約（全 WP 厳守。破ったら統合時に壊れる）

- **C1 `TextureName`（`Materials.ts:4-27`）**: WP-1 のみ追加可。既存 22 値の削除・改名は禁止（`Motif.ts`・`WorldBuilder.ts`・`Props.ts`・`Door.ts`・tests が参照）。
- **C2 共有型の不変**: `SurfacePalette`・`DecalKind`・`MotifAtmosphere`・`MotifDef`（`Motif.ts`）、`LightSpot`（`RoomLightPool.ts`）の既存フィールドの削除・改名・意味変更は禁止。追加は optional フィールドのみ。特に `DecalKind` の 10 値は WP-3 が消費するため改名禁止、`LightSpot` の 6 フィールドは `WorldBuilder.ts:511-531` が生成するため不変。
- **C3 `Motif.ts` は WP-1 の所有**: WP-2・WP-3 は編集禁止。IBL 強度など WP-2 の調整値は `PostFX.ts`・`main.ts` 内の定数で持ち、モチーフ別に振る場合も `motif.id` をキーにした WP-2 側のテーブルに閉じる。
- **C4 `TextureLibrary` の公開契約は不変**: `get`・`getDecal`・`byMaterial`・`dispose`・`bindPalette`・`palette`・`doorTint` のシグネチャと、コンストラクタ引数なしを維持（`main.ts:161`・tests が `new` している）。`doorWood`・`doorFrame` はグレースケール基調＋`doorTint` 乗算（`Door.ts:188-200`）の仕組みを維持する。
- **C5 `StaticBatcher` の署名変更は WP-1 のみ**: `signature()`（`StaticBatcher.ts:25-37`）に `bumpMap`・`roughnessMap` の uuid を追加する場合は WP-1 が行い、追加前後で既存マテリアルの結合結果が変わらないこと（uuid 欠如時は従来通り）。
- **C6 `RoomLightPool` の公開シグネチャ不変**: `update`・`snap`・コンストラクタ・`ROOM_LIGHT_SLOTS`・`LightSpot` を維持（`WorldBuilder.ts:105,124,540` が利用）。動特性（定数・選択ロジック）の変更は WP-2 の自由。
- **C7 `map.walls`・`map.windows`・`map.doors` の型は変えない**: WP-3 の壁沿い配置は `BoxDef`・`WindowDef`・`DoorDef`（`types.ts:20-85`）の既存フィールドだけで行う。
- **C8 `Materials.ts` の関数分離**: WP-1 は `paintDecal`（L672-780）に触れない。WP-3 は `paintDecal` のみ編集可で、他関数・`get`・`getDecal` 本体に触れない。異方性は WP-1 が頂部定数 `TEX_ANISO` を追加し `get`・`getDecal` 両方で使う（WP-3 はこの定数に触れない）。

## 4. WP-1 詳細: テクスチャ・質感・モチーフパレット・ライティング刷新

### 4.1 手続きテクスチャの設計原則（全 paint 関数共通）

- **解像度 512×512**: `TextureLibrary.get`（`Materials.ts:75`）の `canvas.width/height` を 256→512 に上げる（garment 系 512×384 は据え置き）。タイリング周期 `TEXTURE_TILE_METERS = 2` は変えない（`WorldBuilder.ts` の UV 計算に影響させない）。
- **最小フィーチャ周期 8px 以上**（512px/2m 換算で約 3.1cm 未満の構造を作らない）。1〜3px 周期の行縞・縦縞・市松の高コントラスト反復は禁止。微細ノイズは 1〜2px の `speckle` に限り、ベース色との輝度差 12% 以内・alpha 0.15 以下。
- **タイリング境界をまたぐ構造線の禁止**: 帯・縁・十字・縁取りなど「位置が意味を持つ線」をテクスチャ内に描かない。タイル目地・板の継ぎ目のように全面反復が正しい線だけ残す。
- **異方性フィルタリング**: 頂部に `const TEX_ANISO = 8;` を追加し、`get`（L84）・`getDecal`（L115）の `tex.anisotropy = 4` を置き換える。three.js はデバイス上限でクランプするため固定値で安全。ミップマップは既定（生成 ON）のまま。
- **`bumpMap`・`roughnessMap` の導入**: 新規キャンバスは作らず、同一カラーキャンバスから `new THREE.CanvasTexture(canvas)` を派生させる（輝度が凹凸・ラフネス変調になる）。`WorldBuilder.material()`（`WorldBuilder.ts:145-161`）で `bumpMap` に設定し `bumpScale: 0.02`、`roughnessMap` に設定した上で既存 `roughness` 値を 0.05 下げる（掛け合わせで暗くなりすぎないよう）。`metalness` は環境マップ（WP-2）が来る前提で現行値を維持し、0.35〜0.6 の範囲に収める（契約: WP-2 の IBL との整合）。
- **`StaticBatcher` 対応**: `signature()`（`StaticBatcher.ts:25-37`）のキーに `m.bumpMap?.uuid`・`m.roughnessMap?.uuid` を追加する。`bake()`（L56-89）は uv を保持しているため変更不要。既存マテリアル（bump なし）の結合結果が変わらないことを目視＋テストで確認する。

### 4.2 既存 `.webp` の活用（D-1 の是正）

- `themed` 時も `plaster`・`concrete`・`wood`・`fabric` は `public/textures/*.webp` を下地に使う。手順: ①現行の `paintThemed` 相当でパレット色を不透明に塗る → ②非同期ロード完了後に `drawImage` で webp を `globalAlpha 0.35`・`globalCompositeOperation = 'multiply'` で重ね、`tex.needsUpdate = true`（現行 L86-94 の仕組みを `themed` 時にも適用する。分岐条件 `!themed` を外し、キーに palette id が入るためキャッシュ衝突はない）。
- ロード前は①の塗りが表示されるため一瞬のちらつきは出ない。再現性への影響なし（静的アセットでシード不使用）。
- `tatami`・`tile`・`marble`・`brick`・`linen` 等 webp が無いものはプロシージャルのみで §4.1 の原則に従う。

### 4.3 paint 関数ごとの改造指定

| 関数 | 現状の問題 | 改造内容 |
|---|---|---|
| `paintCarpet` | 2px 行縞＋縁取りの全面反復 | 行縞を廃止し `speckle`（120 粒、alpha 0.1）＋64px 以上の大まかな濃淡まだらに。`strokeRect` の縁取りを削除 |
| `paintTatami` | 3px 縦縞＋布縁が 2m 周期で反復 | 縦ライン周期を 6px・輝度差 10% 以内に緩和。上下左右の布縁・帯（L518-527）を削除。横の継ぎ目は 64px ごとに 1px・alpha 0.1 のみ |
| `paintCorrugated` | `y=28` のアクセント横線が反復 | 横線（L580-585）を削除。リブ 10px は維持（約 8cm で実寸相当）し、明暗差を現行のフル切替から輝度差 20% 以内に |
| `paintSiding` | 行境界の黒線がやや強い | 境界線 alpha 0.18→0.12。行 14px（約 11cm）は実寸相当のため維持 |
| `paintLinen` | 4px 横線＋アクセント飛び | 横線周期を 6px・alpha 低減。アクセント色の飛び（L643-646）は alpha 0.15→0.08 |
| `paintDoorGray` | 5px 縦縞＋白線の框 | 周期 8px・輝度差 12% 以内に。白線の框・鏡板（L657-660）は `Door.ts` の UV を確認し、扉板全体に 0..1 マッピングなら維持可、枠等でタイリングされるなら削除。確認結果をコードコメントに残す |
| `paintTilePalette` | 4x4 市松の高コントラスト | 50cm 角（4x4/2m）は実寸相当のため維持。grout とタイルの輝度差を 15% 以内に。汚れ楕円は alpha 0.08→0.05 |
| `paintCeiling` | 市松の壁色混ぜがうるさい | 代替色に `pal.wall` を使わず `ceiling` の 6% 濃色を使う。`coffer` の inset 構造は低周波のため維持。`exposed` の梁 8px/42px は維持 |
| `paintPanel` clinical | 下端アクセント帯＋壁Alt 帯が反復 | L417-420 の帯 2 本を削除。グリッド線（64/86px）は alpha 0.55→0.35 で維持 |
| `paintPanel` wood | `h*0.62` のアクセント線が壁中段に反復 | L435-437 の横線を削除。板 7 分割（約 36cm）は維持 |
| `paintPanel` default | 下端帯＋アクセント線 | L448-452 の 2 本を削除し `fillMottle` のみにする |
| `paintLinoleum` | 中央十字＋下端帯 | L479-488 の十字・帯を削除し `speckle`（180→120 粒、alpha 0.15）のみにする |
| `paintMarble` | 白の縁取りが反復 | `strokeRect`（L541-542）を削除。鉱脈ベジェは低周波のため維持 |
| `paintConcrete` | 打ち継ぎ目の `strokeRect` が 2m グリッドに見える | L591-593 の縁取りを削除。ピンホール 8 個は alpha 0.2→0.12 で維持 |
| `paintBrickPalette` | 概ね実寸（40x18px ≒ 15x7cm） | 維持。mortar との輝度差が 25% を超えるモチーフのみ mortar を寄せる（§4.4 の値で担保済み） |
| `paintGlassPalette` | 低周波グラデーション | 維持。frosted の `speckle` は alpha 0.2→0.12 |

### 4.4 モチーフ別パレット・atmosphere 推奨値

方針: 白飛び組（hospital・office・bank・plain）は明度を L\* 70〜80 に落とし露出・照明を下げる。暗い組（clubhouse・warehouse・house）は底上げし諧調を残す。`roomLights` は 2 系統以内に整理する（D-4 是正）。下表の値に更新する（記載のないフィールドは現行維持。部屋名・材質名マッピング・`categoryWeight` は変更禁止＝`motif.test.ts` の契約）。

| Motif | wall / wallAlt / ceiling | exposure / roomIntensity / hemi | roomLights（整理後） | 備考 |
|---|---|---|---|---|
| hospital | `0xdde4e0` / `0xb9d2c7` / `0xe8ecea` | 1.22→**1.06** / 15→**10.5** / 0.72→0.6 | `[0xe9fff6, 0xd4f1ff, 0xe9fff6, 0xd4f1ff]`（寒色系に統一） | tileA/B・marbleA も `-0x0d0d0d` 目安で一段落とす |
| office | `0xd3d8de` / `0xb3bdc8` / `0xe4e8ec` | 1.16→**1.05** / 13.5→**10.5** / 維持 0.58 | `[0xf4f7ff, 0xe8f0ff, 0xf4f7ff, 0xe8f0ff]`（昼光色に統一） | carpetA/B は現行維持（床は暗めで良い） |
| bank | `0xd8d4cc` / `0xbdb9b0` / `0xe9e6de` | 1.12→**1.05** / 12→**10.5** / 維持 0.48 | `[0xfff4e0, 0xe6eef8, 0xfff4e0, 0xe6eef8]`（電球＋昼光の 2 系統） | marbleA `0xf3f1ea`→`0xe2ded4`、vein 維持 |
| clubhouse | `0x7a4a30` / `0x8a5f3c` / `0x5c4030` | 0.98→**1.02** / 8.5→**10** / 0.32→**0.45** | 現行 4 色→`[0xffb060, 0xffc888, 0xffb060, 0xffc888]`（暖色系に統一） | woodA/B も +8% 明るく。暗部の諧調確保 |
| warehouse | wall 維持 / ceiling `0x5c6266` | 1.05→**1.03** / 7.5→**9** / 0.4→**0.5** | `[0xffc090, 0xe8d8c0, 0xffc090]`（3 灯→現行 3 色を維持、順序のみ整理） | 天井を一段明るくし暗部の潰れを防ぐ |
| house | `0xddd2bd` / `0xc9b99c` / 維持 | 1.08→**1.05** / 6.5→**9** / 維持 0.5 | 現行 4 色→`[0xffd9a8, 0xffe6c4, 0xffd9a8, 0xffe6c4]`（暖色系に統一） | 畳・木の暖色と統一し落ち着かせる |
| plain | wall 維持 / ceiling 維持 | 1.15→**1.05** / 11→**10** / 維持 0.5 | 現行 5 色→`[0xffd9a8, 0xffe6c4, 0xe6eef8]`（3 色に整理） | モチーフ導入前の基準見た目のため控えめに |

`sunColor`・`sunIntensity`・`fog`・`background` は現行維持（屋外の見え方を変えない）。

### 4.5 室内灯ハウジング・diffuser の是正（B-3）

- `WorldBuilder.ts:532-537`: diffuser を部屋ごとの tint に追従させる（`tints[0]` 固定→`tints[idx % length]`）。`MeshBasicMaterial` のまま色だけ変えると依然眩しいため、色に `0.82` を乗じた値を使い、発光板の白飛びを抑える。
- `RoomLightPool`（WP-2 の所有）には触れない。`buildLights` 全体は WP-1 の範囲であることを WP-2 へ通知する（契約 C6）。
- 幅木ジオメトリ（任意の拡張。必須ではない）: 壁下部に高さ 0.09m の trim メッシュを追加する場合は、壁色より 8〜12% 暗い単色 `MeshStandardMaterial`（マップなし）、Collider なし、`batchStaticMeshes` の対象として統合されることを確認する。やる場合は `buildBoxes` の wall 分岐に限定し、当たり・UV・再現性に影響させない。

## 5. WP-2 詳細: レンダリング品質・MSAA・GTAO・IBL・照明スムーズ化

### 5.1 EffectComposer での MSAA（A-1 の是正）

- `PostFX.ts:49` の `new EffectComposer(renderer)` を、WebGL2 MSAA 対応 RenderTarget 付きに変える:
  ```ts
  const pr = renderer.getPixelRatio();
  const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, {
    samples: renderer.capabilities.isWebGL2 ? 4 : 0,
    type: THREE.HalfFloatType,
  });
  this.composer = new EffectComposer(renderer, rt);
  ```
- `setSize`・`setPixelRatio` の後も `samples` が維持されること（three r187 の `EffectComposer.setSize` は既存ターゲットをリサイズし `samples` を保持するが、実装時に `composer.renderTarget1.samples` が 4 のままか asserts で確認する）。
- WebGL1 フォールバック（`isWebGL2 === false`）では `samples: 0` とし、従来通り動作する。`antialias: true`（`main.ts:143`）は canvas 直接描画時のみ有効のため維持（削除しない）。
- GTAOPass は独自 G バッファを持つため本変更の影響を受けない。`AdaptiveResolution` で解像度が下がっても MSAA は維持する（エッジ品質を保つのが目的）。

### 5.2 GTAO のちらつき防止パラメータ（A-2 の是正）

- `updateGtaoMaterial`（`PostFX.ts:56`）: `{ radius: 0.55→0.45, distanceExponent: 1.4（維持）, thickness: 1.2（維持）, scale: 1.25→1.0, samples: 12→8, distanceFallOff: 1（維持）, screenSpaceRadius: false（維持） }`
- `updatePdMaterial`（L57）: `{ lumaPhi: 10（維持）, depthPhi: 2（維持）, normalPhi: 3（維持）, radius: 6（維持）, rings: 2→3, samples: 12→8 }` — デノイズを強化し、AO 本体のサンプルを減らして粒状ノイズと負荷を同時に下げる。
- `blendIntensity`（L55）: `1→0.85`。AO を少し弱め、隅の黒つぶれと粒立ちを抑える。
- 低負荷時の `setAO(false)`（`main.ts:166-169` 経由）の仕組みは維持する。変更前後で同一シーンの静止画＋移動時のちらつきを目視比較する（プレイ確認が正式検査のため、WP-2 内では開けること＋エラーなしまで）。

### 5.3 軽量プロシージャル環境マップ IBL（B-5 の是正）

- `main.ts` の `WorldBuilder` 生成後（`main.ts:163` 付近）に 1 回だけ実行する:
  ```ts
  const pmrem = new THREE.PMREMGenerator(this.renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  this.scene.environment = envTex;
  this.scene.environmentIntensity = 0.35;
  pmrem.dispose();
  ```
  `RoomEnvironment` は `three/examples/jsm/environments/RoomEnvironment.js` から import（three 0.187 に同梱済み）。
- `environmentIntensity` は 0.25〜0.45 の範囲で調整可。モチーフ別に振る場合は WP-2 所有の `main.ts`・`PostFX.ts` 内の `Record<MotifId, number>` 定数で行い、`Motif.ts` には持ち込まない（契約 C3）。
- `dispose` 時（`App` 破棄パス）に `scene.environment` のテクスチャを dispose する（`disposeObject` の対象外のため明示的に）。
- 注意: IBL 適用後は金属・石材の見え方が変わるため、WP-1 の `metalness`（0.35〜0.6）との整合を統合時にディレクターのプレイで確認する（受け入れ基準 §7-2）。

### 5.4 RoomLightPool の切替ちらつき抑制（A-5 の是正）

- `RESELECT_SEC`（`RoomLightPool.ts:18`）: `0.2→0.5`。選択頻度を下げ、境界付近のバタつきを減らす。
- ヒステリシスの導入: `select()` で前回の `wanted` 集合と比較し、差分が 1 灯以下かつ `nearest` が同一なら入れ替えない。差分がある場合も、入れ替わり候補スポットのスコア差が 1.5m 未満なら現状維持とする。
- `FADE_PER_SEC`（L20）: `5→3`。フェードをゆっくりにし、切替時の明滅感を抑える（`update` の w 増減ロジック自体は変えない）。
- `snap()`（L111-120）の即時点灯は維持（マップロード直後の真っ暗を防ぐ）。
- 契約 C6 の通り `LightSpot` のフィールド・公開シグネチャは不変。`buildLights`（`WorldBuilder.ts:491-541`）には触れない。

### 5.5 周辺減光の緩和（B-4 の是正）

- `VignetteShader` の `strength`（`PostFX.ts:12`）: `0.38→0.28`。暗いモチーフの四隅の潰れを軽減する。

## 6. WP-3 詳細: デカール・小道具のリアリティ＆ノイズ低減

### 6.1 床用・壁用デカールの種別分離（C-3 の是正）

- `Decals.ts` に用途テーブルを追加する（`Motif.ts` は WP-1 の所有のため持ち込まない。契約 C2/C7）:
  ```ts
  const FLOOR_KINDS: ReadonlySet<DecalKind> = new Set(['blood', 'dirt', 'scuff', 'hazard', 'stripe']);
  const WALL_KINDS: ReadonlySet<DecalKind> = new Set(['poster', 'graffiti', 'sign', 'vault', 'medcross', 'stripe', 'hazard', 'scuff']);
  ```
- `addFloorDecal`: `motif.decals` と `FLOOR_KINDS` の積集合から `pickKind` する。空集合のモチーフでは床デカールを置かない（`house` の `['dirt','scuff']` は両方床用で問題なし。`plain` は `WorldBuilder.ts:113` の null ガードでデカール処理自体がスキップされるため対象外）。
- `addWallDecal`: `motif.decals` と `WALL_KINDS` の積集合から選ぶ。空集合なら壁デカールを置かない。

### 6.2 枚数・サイズ・不透明度の抑制（C-2 の是正）

- `MAX_DECALS`（`Decals.ts:7`）: `72→36`。
- 配置確率: 床 `chance(0.8)→chance(0.45)`、壁 `chance(0.72)→chance(0.5)`（L46, L50）。
- サイズ縮小: 床は幅 `0.55〜1.45→0.4〜0.9`、奥行 `0.28〜1.15→0.25〜0.7`。壁 wide 系は幅 `0.9〜1.5→0.7〜1.1`（L71, L95-96 の式を調整）。
- `matOf`（L26-40）のマテリアルに `opacity` を追加する: 床用 0.8、壁用 0.92（`transparent: true` は維持、`depthWrite: false`・`polygonOffset` も維持）。床の血・汚れは薄く、壁の看板はやや残す。

### 6.3 実際の壁に沿った配置と開口回避（C-4 の是正）

- `addWallDecal` を部屋矩形の決め打ちから、以下の手順に変える:
  1. 対象面（side 0..3）に対応する `map.walls` の BoxDef を探す（`addFacadeSign` L122-137 と同様の最近傍探索を一般化）。面の平面から ±0.35m 以内、配置中心の水平 ±(w/2 + 0.4) 以内に収まり、高さ `y±h/2` と重なる壁がある場合のみ配置。
  2. `map.windows`・`map.doors` との重なり検査: 配置中心の水平 ±(w/2 + 0.35) 以内に窓・ドアがあり、かつ垂直範囲（窓: sill〜sill+height、ドア: 0〜2.1m）がデカールと重なる場合はスキップ（再抽選は最大 2 回、それでも不可ならその部屋は壁デカールなし）。
  3. 配置位置は壁面から `inset 0.06`（現行 0.08→0.06）で壁に寄せる。
- 壁が見つからない面が出た side は配置しない（空中浮き防止。再抽選で別 side を試してよい）。
- `addFloorDecal` は部屋中央寄りの現行ロジックを維持する（床に壁は要らない）が、スポーン地点から 1.5m 以内には置かない（ブリーフィング直後の視界ノイズを避ける）。
- `Rng` の消費は `addMotifDecals` 関数内で完結させ、呼び順序を決定的に保つ（seed→配置の再現性は維持。間取り・座標・扉・スポーンには一切触れない）。
- `addFacadeSign`（L119-153）は現行維持（既に `map.walls` ベースで正しい）。

### 6.4 デカール画の落ち着いた色調（WP-3 が `paintDecal` のみ編集。契約 C8）

- `hazard`・`stripe` の黄 `#f0c020`→`#c8982a`（くすんだ黄土）、黒 `#1a1a1a`→`#2a2a28`。
- `graffiti` の線・文字 alpha 0.9/0.75→0.55/0.5。
- `poster`・`sign` の紙地 `rgba(245,240,230,0.94)`→`rgba(232,226,214,0.88)`。
- `medcross`・`vault` はアクセント色を使うため現行維持（WP-1 のパレット変更で自動的に落ち着く）。

### 6.5 Scenery の色調整（D-2 の是正）

- 原則: 乗算色が `0xf0f0f0` より明るい箇所のみを 10〜18% 暗くする。`0xffffff`（テクスチャの素色を活かす箇所）は変更しない。
- 具体値（`Scenery.ts`）:

| 箇所 | 現行 | 変更後 |
|---|---|---|
| `hbed` リネン L57・`linenMat` L112・`stretcher` パッド L98 の白 | `0xf7fffb` / `0xe7f4ef` | `0xdfe4de` / `0xcfd8d2` |
| `hbed` レール L58 | `0x8fd0c2` | `0x6fa89c` |
| `curtain` 布 L128 | `0xe7f6f1` | `0xd3dcd6` |
| `medcab` 本体 L136・陶器類（`toilet` L306-310、`sink` L315-317、`stall` L326、`bathtub` L369） | `0xf4f7f8` / `0xf7f7f5` / `0xf4f7f8` | `0xdde2e2` / `0xdfe0da` / `0xd8dcd8` |
| `medcab` 十字 L138 | `0x2f9e6b` | `0x2a7a52` |
| `bar` 木 L148-149・真鍮 L150 | `0xfff6ea` / `0xffffff` / `0xf0d78c` | `0xe8dcc4` / `0xefe4cc` / `0xc8a860` |
| `piano` 鍵盤 L79・黒鍵 L80・木 L78 | `0xfffdf8` / `0x1a1a1a` / `0xf3e6d4` | `0xe8e4da` / `0x2e2e30` / `0xdcc9a8` |
| `teller` 金属 L189・ガラス L190 は維持（大理石マップ頼み） | — | 変更なし |
| `lamp` 真鍮 L418・ガラス L419・emissive L421-422 | `0xf0d78c` / `0xfff4d2` / 0.85 | `0xc8a860` / `0xf2e2c0` / **0.6** |
| `fridge` L361 | `0xe6eaee` | `0xd0d4d8` |
| `sofa` 座面 L172-173（linen 白） | `0xffffff` | `0xd0ccc2`（布マップ `cloth` 本体は維持） |
| `partition` パネル L261 | `0xf4f7fb` | `0xdde2e8` |
| `counter` 天板 L378 | `0xd7c4a2` | `0xc9b48e` |
| `wardrobe` 扉 L354-355 | `0xc4a574` | `0xb08d5e` |

- `mat()` の都度マテリアル生成は `StaticBatcher` が不透明分を統合するため対象外とする（将来的なキャッシュ化は申し送り。ドローコールは増やさない）。
- 小道具の寸法・`BoxDef`・`prop` 名は一切変えない（当たり・`scenery.test.ts` の契約）。

## 7. パフォーマンス・互換性制約

- **当たり（Collider）**: WP-1〜WP-3 いずれも `Collider`・`boxToAABB`・`colliders` 配列に触れない。WP-3 のデカール・小道具は見た目のみ（現行通りコライダなし）。幅木ジオメトリ（任意）も Collider なし。
- **生成マップの再現性**: 間取り・座標・扉・スポーン・階層は不変。`dressWithMotif` の部屋名・マテリアル名マッピング、`withMotifBias` の重みは変えない。`Rng` ストリームの消費順序は各関数内で決定的に保つ（配置アルゴリズム変更でデカールの見た目は変わるが、seed→配置の対応は決定的）。
- **既存テスト**: `tests/unit/motif.test.ts`（材質名 `brick`・`panel`・`tatami`・`wood`・`siding`・`plaster`、部屋名、重み）と `tests/unit/scenery.test.ts`（signature props、スポーン覆い禁止）を壊さない。材質名の付け替えは禁止、変えるのは画の内容と数値のみ。
- **ドローコール・GPU 負荷**: デカール総数は 72→36 枚に減る。追加テクスチャは bump/roughness の派生（同一 canvas、UV 共有）のみ。MSAA `samples: 4`＋GTAO 軽量化（samples 12→8、rings 2→3）で収支させる。`StaticBatcher` のセル（`STATIC_BATCH_CELL = 16`）・結合条件は変えない。`AdaptiveResolution`・`setAO` の仕組みは維持する。

## 8. 受け入れ基準（ディレクターがプレイして確認する観点）

| # | 確認観点 | 合否の目安 |
|---|---|---|
| 1 | 全 7 モチーフで壁・床を注視しながら 1 周移動してもちらつきを感じない | エッジのギラつき・床面のモアレ・時間的チラツキがないこと |
| 2 | hospital・office が眩しくなく、clubhouse で敵シルエットが判別できる | 白飛び・黒つぶれがなく、暗い部屋でも人物の輪郭が読めること |
| 3 | 床にポスター・看板がなく、壁デカールが浮いていない | 床は血・汚れ・擦れ・危険帯のみ。壁デカールに空中浮き・貫通がないこと |
| 4 | 既存の遊びが壊れていない | 当たり・スポーン・扉・クリア条件が従来通りで、テストが通ること |
| 5 | 動作が重くなっていない | 体感フレームレートが現行と同等以上で、解像度低下の頻度が増えていないこと |

## 9. 設計検証チェックリスト（本書の自己点検）

- [x] WP-1〜WP-3 のファイル持ち分に重複がない（`Materials.ts` は `paintDecal` のみ WP-3、他は WP-1。契約 C8）
- [x] 共有型の変更は追加・緩和のみで、削除・改名がない（契約 C1・C2・C4・C6・C7）
- [x] `Motif.ts` の編集は WP-1 のみ（契約 C3）。WP-2 の調整値は WP-2 所有ファイル内の定数
- [x] 各課題 A-1〜D-4 に対応する WP と具体値（数値・関数・行番号）がある
- [x] 全 7 モチーフのパレット・atmosphere 推奨値が表にある（§4.4）
- [x] テクスチャ原則に具体値がある（512px・8px・輝度差・alpha・TEX_ANISO=8・bumpScale 0.02）
- [x] MSAA・GTAO・IBL・プール動特性に具体値がある（samples 4・scale 1.0・rings 3・env 0.35・RESELECT 0.5・FADE 3）
- [x] デカール分離・枚数・配置手順・開口回避に具体値がある（36 枚・FLOOR/WALL_KINDS・±0.35m・再抽選 2 回）
- [x] Scenery の色変更が列挙され、寸法・prop 名の不変が明記されている
- [x] 受け入れ基準がプレイ確認の観点で 5 項目ある
