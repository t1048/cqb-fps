# AGENTS.md

## Project

SWAT 4 テイストのブラウザ完結型 3D CQB タクティカル FPS。SWAT モードと容疑者（籠城 vs SWAT）モードの 2 モードを備え、シード決定論的ランダムマップ生成・突入前交渉・部隊指示 / 敵 SWAT AI・交戦規定（RoE）・停電 / 配電盤 / 暗視装置・XP 進行度 / 装備解放・日英バイリンガル UI を提供する。

- **公開先 URL**: `https://t1048.github.io/cqb-fps/`
- **リポジトリ構成**: 単一 SPA（モノレポではない。`public/` に JSON データと `.webp` テクスチャを配置）

## Stack (do not introduce alternatives)

- **ランタイム**: Three.js `^0.187.0`（唯一の `dependencies`）
- **言語**: TypeScript `^7.0.2`（`tsconfig.json`: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `noFallthroughCasesInSwitch: true`, `target: "ES2022"`, `include: ["src"]`）
- **ビルド**: Vite `^8.3.8`（`vite.config.ts`: `base: './'`, `rolldownOptions` で `three` / `world-gen` にチャンク分割）
- **テスト**: Vitest `^5.1.1`（`vitest.config.ts` / `vitest.e2e.config.ts`、いずれも `environment: 'node'`）
- **UI / スタイリング**: Vanilla DOM（`document.createElement`）＋各 UI モジュール内の `<style>` テンプレート文字列注入。外部 `.css` ファイルは無し
- **無いもの（勝手に追加しない）**: React / Vue 等の UI フレームワーク、Tailwind / CSS Modules / Sass、ESLint、Prettier、Husky、Playwright / Cypress 等の実ブラウザ E2E ツール

## Commands

- `npm run dev` — Vite 開発サーバー起動
- `npm run build` — 型チェック＋本番ビルド（`tsc --noEmit && vite build`）
- `npm run preview` — ビルド結果のローカルプレビュー
- `npm test` — ユニットテスト実行（`vitest run`、`tests/unit/**/*.test.ts`）
- `npm run test:e2e` — Node 環境 E2E シミュレーションテスト実行（`vitest run -c vitest.e2e.config.ts`、`tests/e2e/**/*.test.ts`）
- **CI 実行順（PR）**: `npm ci` → `npx tsc --noEmit` → `npm test` → `npm run test:e2e`
- **`lint` / `format` スクリプトは無い。勝手に追加・捏造しない**

## Layout

- `index.html` — エントリ HTML（`/src/main.ts` をロード、最小リセット CSS のみ）
- `src/main.ts` — `App` クラス・ブート処理・共有レンダラ / オーディオ管理・HMR 破棄
- `src/core/` — `DataLoader.ts`（JSON 読み込みとスキーマ / 相互参照検証）、`EventBus.ts` / `events.ts`、`GameLoop.ts`、`InputManager.ts`、`Audio.ts`、`PostFX.ts`、`Settings.ts`、`i18n.ts`、`types.ts`
- `src/world/` — `WorldBuilder.ts`、`Door.ts`、`DoorTraps.ts`、`BreakerPanel.ts`、`Flashlights.ts`、`Materials.ts`、`Motif.ts`、`StaticBatcher.ts`、`generator/`（`ModularGenerator.ts`, `AircraftGenerator.ts`, `HouseGenerator.ts`, `Rng.ts` 等）
- `src/ai/` — `EntityManager.ts`、`Suspect.ts`、`Civilian.ts`、`Squad.ts`、`squad/`、`Perception.ts`、`Morale.ts`、`Ambush.ts`、`HostageShield.ts`、`HostageThreat.ts`、`SuspectAlert.ts`、`ScoutIntel.ts`
- `src/modes/` — `SuspectMode.ts`、`SuspectAllies.ts`、`SwatTeam.ts`、`swat/`、`PreAssaultNegotiation.ts`、`Fortify.ts`、`HostageGrab.ts`
- `src/player/` — `PlayerController.ts`、`Interaction.ts`、`Arrest.ts`、`PlayerDoorWork.ts`、`Optiwand.ts`、`NightVision.ts`、`ViewModel.ts`、`WarningCall.ts`、`Medkit.ts`
- `src/weapons/` — `WeaponSystem.ts`、`Flashbang.ts`、`TearGas.ts`
- `src/rules/` — `Mission.ts`、`RoE.ts`、`ScoreBoard.ts`、`SuspectScore.ts`、`Progression.ts`、`Power.ts`、`MissionRoster.ts`、`siegeFatigue.ts`、`wounds.ts`
- `src/ui/` — `TitleScreen.ts`、`BriefingScreen.ts`、`NegotiationPhase.ts`、`Hud.ts`、`Minimap.ts`、`CommandMenu.ts`、`PauseMenu.ts`、`ResultScreen.ts`、`firstRun.ts`、`shareLinks.ts` 等
- `public/data/` — `stages.json`、`weapons.json`、`ai_profiles.json`、`squad.json`、`perception.json`、`player.json`、`doors.json`、`roe.json`、`siege.json`、`generators/*.json`
- `public/textures/` — `.webp` テクスチャ群
- `tests/unit/`・`tests/e2e/` — Vitest ユニットテスト・決定的 E2E テスト（`tests/e2e/helpers/setupDeterministic.ts`）
- `docs/design/` — 機能設計メモ（`scripts/` ディレクトリは無し）

## Quirks / things an agent will get wrong without this

- **進行度・解放システム（README 未記載・コード wins）**: `src/rules/Progression.ts` により Lv.1 初期状態では容疑者モード・中 / 大マップ・一部武器 / 装備がロックされる。通常起動時は 3D 背景の `TitleScreen` が開き、`?seed=<数値>` 付き共有 URL のみタイトルと解放判定をスキップして直接マップ生成する。`?unlockAll=1`（または `true`）で全要素を即時解放できる。
- **README と実装の差分（コード wins）**: README の `public/data/` 一覧に無い `public/data/siege.json` を `DataLoader.loadAll()` が必須読み込みする。また README は容疑者モード武器を「改造フルオート拳銃のみ」としているが、実装では進行度に応じ `machine_pistol` / `suspect_smg` / `suspect_shotgun` / `suspect_ar`・ベスト・仲間方針を選択でき、停電 / 配電盤（`Power.ts` / `BreakerPanel.ts`）と暗視装置（`NightVision.ts`）も実装済み。
- **`localStorage` キー接頭辞（すべて `cqb.`）**: `cqb.settings.v1`（設定・言語）、`cqb.progression.v1`（XP・解放・ロードアウト）、`cqb.tour.negotiation.v1` / `cqb.tour.squad.v1`（初回ツアー既読）。**キー名や構造を破壊的に変更しない**。プライベートモード対策の try-catch + メモリフォールバックを維持する。
- **乱数の使い分け**: マップ生成は `src/world/generator/Rng.ts`（mulberry32）でシード決定論的。AI・戦闘・交渉等は `Math.random()` を使用し、`npm run test:e2e` は `tests/e2e/helpers/setupDeterministic.ts` の `beforeEach` で `seedRandom(0x5eed)` により固定している。
- **共有レンダラとリトライ破棄**: `src/main.ts` が `WebGLRenderer`・PMREM 環境マップ・`TextureLibrary`・`AudioEngine` をモジュール共有し、リトライ時は `App.destroy()` → `new App(...)` で再生成する。**`sharedRenderer.shadowMap.autoUpdate = false` は GTAOPass によるシャドウ二重描画防止のため変更しない**。
- **コンソールデバッグフック**: `src/main.ts` が `window.__cqbRetry(mapId?, seed?, mode?)` と `window.__cqbTitle()` を公開している。本番コードへの無関係なデバッグ通信は無い（`fetch` は `DataLoader.ts` の `public/data/` 取得のみ）。
- **`tsconfig.json` の対象範囲**: `include: ["src"]` のため `tsc --noEmit` は `tests/` を型チェックしない。テストの検証は `npm test` / `npm run test:e2e` で行う。

## Deploy / CI

- **PR CI（`.github/workflows/ci.yml`）**: `pull_request` トリガー、Node 20、`npm ci` → `npx tsc --noEmit` → `npm test` → `npm run test:e2e`。
- **本番デプロイ（`.github/workflows/deploy.yml`）**: `main` への push および `workflow_dispatch` で起動。`build` ジョブで `npm ci` → `npm test` → `npm run test:e2e` → `npm run build` を実行し、`./dist` を GitHub Pages（`https://t1048.github.io/cqb-fps/`）へデプロイ。
- **相対パス設定**: `vite.config.ts` の `base: './'` と `DataLoader.ts` の `import.meta.env.BASE_URL` によりサブパス `/cqb-fps/` で動作する。**絶対パス `/data/...` をハードコードしない**。

## Conventions

- **クラス設計**: ゲームシステム・UI・エンティティは TypeScript クラスで構成し、破棄時は `destroy()` / `dispose()` でイベント購読・DOM・Three.js リソース（`disposeObject`）を解放する。
- **イベント・状態管理**: 外部状態管理ライブラリは使わず、ゲーム内イベントは型付き `EventBus`（`src/core/EventBus.ts` / `events.ts`）、設定と進行度はモジュールシングルトン＋`subscribe*` リスナー（`Settings.ts`, `Progression.ts`）で管理する。
- **UI とスタイル**: 各画面クラス（`Hud.ts`, `TitleScreen.ts` 等）が独自の `<style>` を `document.head` に注入し DOM を組み立てる。日英テキストは `src/core/i18n.ts` の `t(ja, en)` を通す。
- **データ駆動**: 数値パラメータはコードに直書きせず `public/data/*.json` に置き、`DataLoader.ts` でバリデーションする。

## Cursor Cloud specific instructions

- 追加サービス（DB / バックエンド API 等）不要の静的 SPA。
- **ローカル起動最短手順**: `npm install`（または `npm ci`）→ `npm run dev`。テストは `npm test` / `npm run test:e2e`。
- **クリーン状態の作り方**: ブラウザの DevTools で `localStorage` の `cqb.*` キーを削除する。解放済み状態の確認には URL に `?unlockAll=1` を付ける。
