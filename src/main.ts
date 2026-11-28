import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { AdaptiveResolution } from './core/AdaptiveResolution';
import { PostFX } from './core/PostFX';
import { GameLoop } from './core/GameLoop';
import { InputManager } from './core/InputManager';
import { disposeObject } from './core/dispose';
import { DataLoader } from './core/DataLoader';
import type { AIProfile, AimSettleParams, DoorConfig, MapData, PerceptionConfig, PlayerConfig, RoeConfig, SiegeConfig, SquadConfig, StageEntry, SuspectAlertConfig, Vec3, WeaponDef } from './core/types';
import { CivilianState, SuspectState, createGameEventBus, type GameEventBus } from './core/events';
import type { Civilian } from './ai/Civilian';
import { AudioEngine } from './core/Audio';
import { AudioBridge } from './core/AudioBridge';
import { PlayerController } from './player/PlayerController';
import { Interaction } from './player/Interaction';
import { WeaponSystem } from './weapons/WeaponSystem';
import { Flashbang, hasLineOfSight } from './weapons/Flashbang';
import { TearGas } from './weapons/TearGas';
import { FlashOverlay } from './ui/FlashOverlay';
import { Subtitle } from './ui/Subtitle';
import { Arrest } from './player/Arrest';
import { PlayerDoorWork } from './player/PlayerDoorWork';
import { WarningCall } from './player/WarningCall';
import { EntityManager } from './ai/EntityManager';
import { Hud } from './ui/Hud';
import { Minimap } from './ui/Minimap';
import { BriefingScreen } from './ui/BriefingScreen';
import { NegotiationPhase } from './ui/NegotiationPhase';
import { SquadTour } from './ui/SquadTour';
import { isFirstRun, markSeen } from './ui/firstRun';
import { buildSuspectNegotiation, buildSwatNegotiation } from './modes/PreAssaultNegotiation';
import { HostageGrab } from './modes/HostageGrab';
import { Fortify } from './modes/Fortify';
import { PepperEffect } from './player/PepperEffect';
import { TearGasEffect } from './player/TearGasEffect';
import { ResultScreen, ScoreHud } from './ui/ResultScreen';
import { RoE } from './rules/RoE';
import { Mission } from './rules/Mission';
import { aiFatigueEffects, fatigueTier, playerFatigueEffects } from './rules/siegeFatigue';
import { WorldBuilder, type Collider } from './world/WorldBuilder';
import { DoorSystem } from './world/Door';
import { normalizeSeed, randomSeed } from './world/generator/Rng';
import { TextureLibrary } from './world/Materials';
import { motifById } from './world/Motif';
import { ViewModel } from './player/ViewModel';
import { PlayerAvatar } from './player/PlayerAvatar';
import { Optiwand } from './player/Optiwand';
import { MedkitUse } from './player/Medkit';
import { ScoutIntel } from './ai/ScoutIntel';
import { SuspectAlert, type NegotiationAlertInfo } from './ai/SuspectAlert';
import { HostageThreat } from './ai/HostageThreat';
import { DoorTrapSystem, rigCount, type BlastVictim } from './world/DoorTraps';
import { SquadSystem, scaleInventory, type Cell } from './ai/Squad';
import { SwatTeam } from './modes/SwatTeam';
import { applyMissionRoster } from './rules/MissionRoster';
import { PauseMenu } from './ui/PauseMenu';
import type { SeedShareInfo } from './ui/shareLinks';
import { TitleScreen } from './ui/TitleScreen';
import { getSettings, subscribeSettings } from './core/Settings';
import { t, tRoomName } from './core/i18n';
import {
  SuspectMission,
  parseGameMode,
  prepareSuspectMode,
  suspectWeapons,
  swatWeapons,
  type GameMode,
  type ResultReport,
} from './modes/SuspectMode';
import { SuspectAllyDirector } from './modes/SuspectAllies';
import type { SuspectLoadout } from './modes/SuspectLoadout';

type AppPhase = 'briefing' | 'negotiation' | 'playing' | 'paused' | 'ended';

const EMPTY_COVERAGE: readonly Cell[] = [];
/** ミニマップの敵赤点: 最後に確認してから濃いまま残す秒数 */
const ENEMY_DOT_HOLD_SEC = 2.5;
/** ミニマップの敵赤点: 保持後にフェードアウトする秒数 */
const ENEMY_DOT_FADE_SEC = 1.5;

let sharedRenderer: THREE.WebGLRenderer | null = null;
let sharedEnvTex: THREE.Texture | null = null;
let sharedTextures: TextureLibrary | null = null;
let sharedAudio: AudioEngine | null = null;

function acquireSharedRenderer(container: HTMLElement): {
  renderer: THREE.WebGLRenderer;
  envTex: THREE.Texture;
} {
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // 室内の明暗差を潰さないトーンマップ + 近傍照明の柔らかい影
    sharedRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    sharedRenderer.shadowMap.type = THREE.PCFShadowMap;
    // GTAOPass 内の法線描画パスでシャドウマップが二重レンダリングされるのを防ぐ
    sharedRenderer.shadowMap.autoUpdate = false;
  }
  if (sharedRenderer.domElement.parentElement !== container) {
    container.appendChild(sharedRenderer.domElement);
  }
  if (!sharedEnvTex) {
    // 軽量プロシージャル環境マップ（IBL）をセッション中 1 回だけ生成して PBR の金属・石材に立体感を与える
    const pmrem = new THREE.PMREMGenerator(sharedRenderer);
    const roomEnv = new RoomEnvironment();
    sharedEnvTex = pmrem.fromScene(roomEnv, 0.04).texture;
    sharedEnvTex.userData.shared = true;
    roomEnv.dispose();
    pmrem.dispose();
  }
  return { renderer: sharedRenderer, envTex: sharedEnvTex };
}

function acquireSharedTextures(): TextureLibrary {
  if (!sharedTextures) {
    sharedTextures = new TextureLibrary();
  }
  return sharedTextures;
}

function acquireSharedAudio(): AudioEngine {
  if (!sharedAudio || sharedAudio.isDisposed) {
    sharedAudio = new AudioEngine();
  }
  return sharedAudio;
}

/** 1 回の起動で生成した全リソースをまとめて破棄できるアプリ。リトライ = destroy → 再 create。 */
class App {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly resolution: AdaptiveResolution;
  private readonly postfx: PostFX;
  private lastDpr = window.devicePixelRatio || 1;
  private lastSwatChildren = 0;
  private lastFortifyChildren = 0;
  private lastSquadChildren = 0;
  private lastReloadP = -1;
  private readonly replyProjScratch = new THREE.Vector3();
  private readonly replyEyeScratch = new THREE.Vector3();
  private readonly minimapEyeScratch = new THREE.Vector3();
  private readonly enemySightings = new Map<string, { x: number; y: number; z: number; t: number }>();
  private readonly scene = new THREE.Scene();
  private readonly equipmentScene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly input: InputManager;
  private readonly loop: GameLoop;
  private readonly world: WorldBuilder;
  private readonly bus: GameEventBus = createGameEventBus();
  private readonly audio: AudioEngine;
  private readonly audioBridge: AudioBridge;
  private readonly player: PlayerController;
  private readonly interaction: Interaction;
  private readonly doors: DoorSystem;
  private readonly weapons: WeaponSystem;
  private readonly flashOverlay: FlashOverlay;
  private readonly flashbang: Flashbang;
  private readonly subtitle: Subtitle;
  private pendingReply = '';
  private readonly warningCall: WarningCall | null = null;
  private readonly arrest: Arrest | null = null;
  private readonly doorWork: PlayerDoorWork | null = null;
  private readonly entities: EntityManager;
  private readonly hud: Hud;
  private readonly minimap: Minimap;
  private briefingScreen: BriefingScreen;
  private negotiationPhase: NegotiationPhase;
  /** 交渉画面を作り直す（言語切替時。交渉開始前のみ） */
  private makeNegotiation!: () => NegotiationPhase;
  /** ブリーフィング画面を作り直す（言語切替時。マップは再生成しない） */
  private makeBriefing!: () => BriefingScreen;
  private readonly pauseMenu: PauseMenu;
  private readonly unsubSettings: () => void;
  private wasLockedDuringPlay = false;
  /** 初回のみ: Z キーで仲間に指示するツアー（SWAT モード） */
  private squadTour: SquadTour | null = null;
  private readonly hostageGrab: HostageGrab | null = null;
  /** 救急キット（容疑者モードだけ） */
  private readonly medkit: MedkitUse | null = null;
  private readonly fortify: Fortify | null = null;
  private readonly pepper: PepperEffect | null = null;
  private readonly tearGas: TearGas;
  private readonly tearGasEffect: TearGasEffect | null = null;
  private readonly roe: RoE;
  private readonly mission: Mission | null = null;
  private readonly scoreHud: ScoreHud | null = null;
  private readonly swatTeam: SwatTeam | null = null;
  private readonly suspectMission: SuspectMission | null = null;
  private readonly allyDirector: SuspectAllyDirector | null = null;
  private readonly mode: GameMode;
  private readonly resultScreen: ResultScreen;
  private readonly textures: TextureLibrary;
  private readonly envTex: THREE.Texture;
  private readonly viewModel: ViewModel;
  private readonly avatar: PlayerAvatar;
  private readonly squad: SquadSystem;
  /** オプティワンド（SWAT モードのみ）。偵察情報は隊と共有する */
  private readonly optiwand: Optiwand | null = null;
  private readonly scoutIntel = new ScoutIntel();
  /** SWAT モード: ドアのブービートラップ / 容疑者の警戒度 / 人質処刑の脅迫 */
  private readonly doorTraps: DoorTrapSystem | null = null;
  private readonly suspectAlert: SuspectAlert | null = null;
  private readonly hostageThreat: HostageThreat | null = null;
  private readonly squadCfg: SquadConfig;
  /** 交渉の結果（突入時の警戒度ベースラインと緊張）。交渉 UI が更新する */
  private negotiationBaseline = 0;
  /** 籠城の消耗（0..100）と設定。突入の前に 1 回決まり、籠城中は変わらない（交渉が書き換えるのは WP3b） */
  private readonly siegeCfg: SiegeConfig;
  private siegeFatigue: number;
  private negotiationInfo: NegotiationAlertInfo = { tension: 0, trust: 0, ultimatums: 0, broken: false };
  private readonly mapId: string;
  private phase: AppPhase = 'briefing';

  constructor(
    container: HTMLElement,
    map: MapData,
    playerCfg: PlayerConfig,
    doorCfg: DoorConfig,
    weaponDefs: WeaponDef[],
    aiProfiles: AIProfile[],
    roeCfg: RoeConfig,
    perceptionCfg: PerceptionConfig,
    stages: readonly StageEntry[],
    squadCfg: SquadConfig,
    suspectAlertCfg: SuspectAlertConfig,
    swatAimSettle: AimSettleParams,
    siegeCfg: SiegeConfig,
    onSelectStage: (stageId: string) => void,
    onRetry: () => void,
    onRegenerate: (seed?: number) => void,
    mode: GameMode,
    onBackToTitle: () => void,
  ) {
    this.mode = mode;
    this.siegeCfg = siegeCfg;
    this.siegeFatigue = siegeCfg.startFatigue;
    this.squadCfg = squadCfg;
    const suspect = mode === 'suspect';
    map = applyMissionRoster(map);
    let swatSpawns: { x: number; y: number; z: number }[] = [];
    let swatCount = 0;
    let loadout: SuspectLoadout | null = null;
    if (suspect) {
      const setup = prepareSuspectMode(map);
      map = setup.map;
      swatSpawns = setup.swatSpawns;
      swatCount = setup.swatCount;
      loadout = setup.loadout;
    }
    this.mapId = map.id;
    const initialSettings = getSettings();
    const shared = acquireSharedRenderer(container);
    this.renderer = shared.renderer;
    this.envTex = shared.envTex;
    this.resolution = new AdaptiveResolution(this.renderer, initialSettings.aoEnabled);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.autoClear = true;
    this.renderer.shadowMap.enabled = initialSettings.shadowsEnabled;

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 160);
    // モチーフがあれば空・霧・露出を施設ごとに変える。未設定は従来の夕暮れ。
    const motif = map.motif ? motifById(map.motif) : null;
    const visual = motif?.id === 'residence' ? null : motif;
    const atm = visual?.atmosphere;
    this.scene.background = new THREE.Color(atm?.background ?? 0x3a4656);
    this.scene.fog = new THREE.Fog(atm?.fog ?? 0x3a4656, atm?.fogNear ?? 30, atm?.fogFar ?? 100);
    this.renderer.toneMappingExposure = atm?.exposure ?? 1.15;
    this.textures = acquireSharedTextures();
    this.textures.bindPalette(visual ? visual.palette : null);
    this.world = new WorldBuilder(map, this.textures);
    this.scene.add(this.world.root);
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.35;
    this.postfx = new PostFX(this.renderer, this.scene, this.camera);
    this.postfx.setAO(this.resolution.aoActive);
    this.resolution.onChange = (r, aoAllowed) => {
      this.postfx.setPixelRatio(r);
      this.postfx.setAO(aoAllowed);
    };

    this.input = new InputManager(this.renderer.domElement);
    this.input.allowAutoPointerLock = false;
    this.player = new PlayerController(this.camera, this.input, this.world.colliders, playerCfg, this.bus, map);
    // 負傷モデル（被弾で速度低下・照準乱れ）は SWAT モードのみ。頭部倍率と防弾チョッキの式は両モード共通
    this.player.woundsEnabled = !suspect;
    // SWAT 隊員は標準装備として防弾チョッキを着用。容疑者は交渉（人質交換）で入手する
    if (!suspect) this.player.equipArmor(playerCfg.armor.swatIssue, 'swatIssue');
    this.audio = acquireSharedAudio();
    this.audio.stopAll();
    this.audio.setMasterVolume(initialSettings.masterVolume);
    this.audio.setMuted(initialSettings.muted);
    this.audioBridge = new AudioBridge(this.bus, this.audio, this.player, this.world.colliders, playerCfg.arrest.radioReportChance ?? 0.38);
    this.audioBridge.updateListener(this.camera);
    this.interaction = new Interaction(this.input, doorCfg.wheelStepThreshold);
    this.doors = new DoorSystem(
      map,
      doorCfg,
      this.world.colliders,
      this.bus,
      this.player,
      playerCfg.radius,
      this.interaction,
      this.input,
      this.textures,
      suspect ? 'suspect' : 'swat',
    );
    this.scene.add(this.doors.root);
    this.weapons = new WeaponSystem(this.player, this.input, this.world.colliders, suspect ? suspectWeapons(weaponDefs, loadout?.reserveMagazines) : swatWeapons(weaponDefs), this.bus);
    this.roe = new RoE(roeCfg, this.bus); // EntityManager より先に entityHit を購読する
    this.flashOverlay = new FlashOverlay(document.body);
    this.tearGas = new TearGas(this.world.colliders, this.bus, map.ceilingHeight, map.rooms);
    this.scene.add(this.tearGas.root);
    this.flashbang = new Flashbang(this.player, this.input, this.world.colliders, weaponDefs, this.bus, this.weapons, this.flashOverlay, map.ceilingHeight, this.tearGas);
    this.scene.add(this.flashbang.root);
    this.entities = new EntityManager(
      map.entities,
      aiProfiles,
      this.weapons,
      this.world.colliders,
      playerCfg.warning,
      this.bus,
      map.rooms,
      { cfg: perceptionCfg, player: this.player },
      this.textures,
      { doors: this.doors, bounds: map.floor, stairs: this.world.stairs },
      suspect,
      this.tearGas,
    );
    this.roe.attach(this.entities);
    this.scene.add(this.entities.root);
    if (!suspect) {
      this.doorTraps = new DoorTrapSystem({
        doors: this.doors,
        bus: this.bus,
        colliders: this.world.colliders,
        cfg: squadCfg.doorTrap,
        swatPositions: () => this.swatSidePositions(),
        suspectPositions: () => this.suspectPositions(),
        victims: () => this.trapVictims(),
      });
      this.scene.add(this.doorTraps.root);
    }
    const flashDef = weaponDefs.find((w) => w.id === 'flashbang');
    this.squad = new SquadSystem(
      map.allies,
      squadCfg,
      this.player,
      this.input,
      this.world.colliders,
      map.floor,
      this.world.stairs,
      this.doors,
      this.entities,
      this.bus,
      this.textures,
      this.weapons,
      { range: flashDef?.range ?? 8, blindSec: flashDef?.throwable?.blindMaxSec ?? 2 },
      map.rooms,
      playerCfg.arrest,
      { flashbang: this.flashbang, tearGas: this.tearGas, intel: this.scoutIntel, traps: this.doorTraps },
    );
    this.entities.attachSquad(this.squad, squadCfg.presenceBonusPerAlly);
    {
      // 隊員が増えた分、プレイヤーの携行数も比例して増やす（4 人編成が基準）
      const pf = scaleInventory({ flashbang: this.flashbang.remaining, gas: 0 }, map.allies.length).flashbang;
      this.flashbang.setCount(pf);
      this.flashbang.setGasCount(scaleInventory({ flashbang: 0, gas: this.flashbang.remainingGas }, map.allies.length).gas);
    }
    this.scene.add(this.squad.root);
    this.viewModel = new ViewModel(this.textures);
    this.viewModel.resize(this.camera.aspect);
    this.bus.on('shotFired', ({ shooter }) => {
      if (shooter === 'player') this.viewModel.kick();
    });
    this.equipmentScene.add(
      this.viewModel.root,
      new THREE.HemisphereLight(0xfff0dc, 0x5a6270, 3.0),
    );
    const equipmentLight = new THREE.DirectionalLight(0xfff1d6, 2.6);
    equipmentLight.position.set(-1, 2, 1);
    this.equipmentScene.add(equipmentLight);
    this.avatar = new PlayerAvatar(this.textures);
    this.scene.add(this.avatar.root);
    this.subtitle = new Subtitle(document.body);
    if (!suspect) {
      // オプティワンド（プレイヤー）・ミラー確認（隊員）で見つけた容疑者もミニマップに一時表示
      this.scoutIntel.onContact = (c) => {
        if (c.kind === 'suspect') this.recordEnemySighting(c.id, c.x, c.y, c.z);
      };
      this.optiwand = new Optiwand({
        player: this.player,
        input: this.input,
        colliders: this.world.colliders,
        cfg: playerCfg.optiwand,
        doorThickness: doorCfg.thickness,
        doors: this.doors,
        entities: this.entities,
        rooms: map.rooms,
        intel: this.scoutIntel,
        bus: this.bus,
        subtitle: this.subtitle,
        weapons: this.weapons,
        host: document.body,
        hideDuringRender: [this.avatar.root],
      });
    }
    this.bus.on('suspectStateChanged', ({ id, from, to }) => {
      const reply =
        from === 'SURRENDER' && to === 'ENGAGE'
          ? t('隙を見せたな！', 'Got an opening!')
          : to === 'HESITATE'
            ? t('待ってくれ……', 'Wait, hold on...')
            : to === 'SURRENDER'
              ? t('わかった、手を上げる！', 'Okay, hands up!')
              : '';
      const suspect = this.entities.suspects.get(id);
      if (!reply || !suspect) return;
      const chest = suspect.body.chestPos();
      const screen = this.replyProjScratch.set(chest.x, chest.y, chest.z).project(this.camera);
      if (Math.max(Math.abs(screen.x), Math.abs(screen.y), Math.abs(screen.z)) <= 1 &&
          hasLineOfSight(this.world.colliders, this.player.getEyePosition(this.replyEyeScratch), chest)) {
        this.pendingReply = t(`容疑者「${reply}」`, `Suspect: "${reply}"`);
      }
    });
    if (!suspect) {
      this.warningCall = new WarningCall(playerCfg.warning, this.player, this.bus, this.subtitle, this.input);
      this.arrest = new Arrest(playerCfg.arrest, this.player, this.entities, this.bus, this.interaction);
      if (this.doorTraps) {
        this.doorWork = new PlayerDoorWork({
          player: this.player,
          input: this.input,
          interaction: this.interaction,
          doors: this.doors,
          traps: this.doorTraps,
          entities: this.entities,
          bus: this.bus,
          subtitle: this.subtitle,
          root: this.scene,
          check: squadCfg.doorCheck,
          trap: squadCfg.doorTrap,
        });
      }
      // 容疑者側の警戒度（閃光弾・銃声・ブリーチ等で上がる）と、高警戒時の人質処刑の脅迫
      this.suspectAlert = new SuspectAlert(
        suspectAlertCfg,
        () => this.entities.suspects.values(),
        this.bus,
        this.negotiationBaseline,
      );
      this.entities.attachAlert(this.suspectAlert);
      this.hostageThreat = new HostageThreat({
        cfg: suspectAlertCfg,
        alert: this.suspectAlert,
        suspects: () => this.entities.suspects.values(),
        civilians: () => this.entities.civilians.values(),
        rooms: map.rooms,
        officers: () => this.swatSidePositions(),
        bus: this.bus,
        say: (text, sec) => this.subtitle.show(text, sec),
        execute: (civilianId, suspectId) => this.executeHostage(civilianId, suspectId),
        tensionHigh: () => this.negotiationInfo.tension >= suspectAlertCfg.execution.tensionMin,
      });
    }
    const releaseHostage = (c: Civilian): void => {
      if (c.evacuate()) this.weapons.removeTarget(c);
    };
    const hostages = (): Civilian[] =>
      [...this.entities.civilians.values()].filter((c) => c.alive && !c.evacuated && !c.shieldedBy && c.state !== CivilianState.SECURED);
    if (suspect) {
      this.flashbang.setCount(0); // 容疑者は閃光弾・CS ガスを持たない
      this.flashbang.setGasCount(0);
      // 容疑者モード: 部隊指揮メニュー（Tab / 右クリック）を無効化
      this.input.orderMenuEnabled = false;
      this.input.onOrderMenu = undefined;
      this.swatTeam = new SwatTeam({
        spawns: swatSpawns,
        count: swatCount,
        player: this.player,
        colliders: this.world.colliders,
        bus: this.bus,
        weapons: this.weapons,
        doors: this.doors,
        bounds: map.floor,
        stairs: this.world.stairs,
        rooms: map.rooms,
        windows: map.windows,
        flashbang: this.flashbang,
        tearGas: this.tearGas,
        flashOverlay: this.flashOverlay,
        subtitle: this.subtitle,
        civilians: () => this.entities.civilians.values(),
        textures: this.textures,
        suspects: () => this.entities.armedSuspectTargets(),
        restrainables: () => this.entities.restrainTargets(),
        shieldActive: () => this.hostageGrab?.shieldEffective ?? true,
        onPepper: (target) => {
          if (target === 'hostage' && this.hostageGrab?.holding) this.hostageGrab.onHostagePeppered();
          else this.pepper?.hit();
        },
        aimSettle: swatAimSettle,
      });
      this.entities.attachHostileTargets(() => this.swatTeam?.livingTargets() ?? []);
      this.scene.add(this.swatTeam.root);
      this.suspectMission = new SuspectMission(
        this.swatTeam,
        this.player,
        this.entities,
        this.doors,
        this.input,
        this.subtitle,
        this.bus,
        this.interaction,
        (report, failed) => this.endMission(failed, report),
        // 突入開始の瞬間に、仲間の容疑者へ消耗による士気ペナルティを 1 回だけ適用する
        () => this.applySiegeMorale(),
      );
      const sm = this.suspectMission;
      this.allyDirector = new SuspectAllyDirector({
        suspects: () => this.entities.suspects.values(),
        player: this.player,
        interaction: this.interaction,
        subtitle: this.subtitle,
        bus: this.bus,
        team: this.swatTeam,
        colliders: this.world.colliders,
        showGauge: (label, ratio) => sm.showGauge(label, ratio),
      });
      this.hostageGrab = new HostageGrab(
        this.player,
        this.entities,
        this.world.colliders,
        this.subtitle,
        this.weapons,
        this.interaction,
        (label, ratio) => sm.showGauge(label, ratio),
        () => this.doors.aimed(2.6) !== null,
        this.bus,
      );
      this.medkit = new MedkitUse({
        player: this.player,
        input: this.input,
        weapons: this.weapons,
        cfg: playerCfg.medkit,
        isHoldingHostage: () => this.hostageGrab?.holding != null,
        isThrowableEquipped: () => this.flashbang.equipped,
        showGauge: (label, ratio) => sm.showGauge(label, ratio),
        subtitle: this.subtitle,
      });
      if (loadout && loadout.medkits > 0) this.medkit.add(loadout.medkits);
      this.pepper = new PepperEffect(this.player, this.weapons, this.subtitle, this.renderer.domElement);
      this.tearGasEffect = new TearGasEffect(this.player, this.weapons, this.tearGas, this.subtitle, this.bus);
      this.fortify = new Fortify({
        windows: map.windows,
        colliders: this.world.colliders as Collider[],
        scene: this.scene,
        textures: this.textures,
        player: this.player,
        input: this.input,
        interaction: this.interaction,
        doors: this.doors,
        subtitle: this.subtitle,
        bus: this.bus,
        weapons: this.weapons,
        allies: () => this.entities.suspects.values(),
        civilians: () => this.entities.civilians.values(),
        entry: swatSpawns[0] ?? { x: 0, y: 0, z: 0 },
        isPrep: () => sm.preparing,
        showGauge: (label, ratio) => sm.showGauge(label, ratio),
        loadout: loadout ?? undefined,
        onCivilianKilled: (c) => sm.addEntry(t(`民間人殺害・トラップ (${c.id})`, `Civilian Killed by Trap (${c.id})`), -400),
      });
      sm.attachFortify(this.fortify);
      this.swatTeam.attachTraps(this.fortify);
      this.swatTeam.attachBarricades(this.fortify);
      this.fortify.attachReceiver(this.swatTeam);
      const team = this.swatTeam;
      this.makeNegotiation = () => new NegotiationPhase(
        document.body,
        buildSuspectNegotiation({
          hostages,
          releaseHostage,
          addPrep: (sec) => sm.addPrep(sec),
          breakdown: () => sm.breakdown(),
          prepSec: () => sm.prepLeft,
          giveArmor: () => this.player.equipArmor(playerCfg.armor.suspectVest, 'suspectVest'),
          hasArmor: () => this.player.armorKind !== null,
          vestSpec: () => ({
            durability: playerCfg.armor.suspectVest,
            absorbPct: Math.round(playerCfg.armor.absorb * 100),
            ...playerCfg.armor.weight.suspectVest,
          }),
          giveMagazines: (n) => this.weapons.addReserveMagazines(n),
          giveMedkit: (n) => this.medkit?.add(n),
          medkitSpec: () => ({ ...playerCfg.medkit }),
          withdrawSwat: () => team.withdraw(),
          allies: () => [...this.entities.suspects.values()],
          swatCount: () => team.total,
          fatigue: () => this.siegeFatigue,
          setFatigue: (v) => {
            this.siegeFatigue = Math.max(0, Math.min(100, v));
          },
          supplyFatigue: () => this.siegeCfg.supplyFatigue,
          siegeHour: () => this.siegeCfg.startHour,
          fatigueTier: () => fatigueTier(this.siegeFatigue, this.siegeCfg.player.tiers),
          markScouted: () => team.setScouted(true),
        }),
        () => this.startMission(),
      );
      this.negotiationPhase = this.makeNegotiation();
    } else {
      this.makeNegotiation = () => new NegotiationPhase(
        document.body,
        buildSwatNegotiation({
          suspects: () => [...this.entities.suspects.values()],
          hostages,
          releaseHostage,
          executeHostage: (c) => {
            if (c.damage(9999)) this.weapons.removeTarget(c);
          },
          alertCfg: suspectAlertCfg,
          onOutcome: (info, baseline) => {
            this.negotiationInfo = info;
            this.negotiationBaseline = baseline;
          },
          fatigue: () => this.siegeFatigue,
          setFatigue: (v) => {
            this.siegeFatigue = Math.max(0, Math.min(100, v));
          },
          supplyFatigue: () => this.siegeCfg.supplyFatigue,
          siegeHour: () => this.siegeCfg.startHour,
          fatigueTier: () => fatigueTier(this.siegeFatigue, this.siegeCfg.player.tiers),
          roomName: (s) => {
            const raw =
              map.rooms.find(
                (r) =>
                  Math.abs((r.floorY ?? 0) - s.body.footY) < 0.75 &&
                  Math.abs(s.body.px - r.x) <= r.width / 2 &&
                  Math.abs(s.body.pz - r.z) <= r.depth / 2,
              )?.name ?? '不明な区画';
            return tRoomName(raw);
          },
        }),
        () => this.startMission(),
      );
      this.negotiationPhase = this.makeNegotiation();
      this.mission = new Mission(
        this.entities,
        (failed) => this.endMission(failed),
        this.input,
        () => this.player.alive,
        (active) => this.squad.setPostClearActive(active),
      );
    }
    this.hud = new Hud(
      document.body,
      this.player,
      this.weapons,
      this.input,
      this.camera,
      this.bus,
      this.flashbang,
      this.interaction,
      this.mission ?? undefined,
      suspect ? undefined : this.squad,
      motif ? { id: motif.id, label: motif.label, color: motif.accentCss } : undefined,
    );
    if (this.medkit) {
      const kit = this.medkit;
      this.hud.medkitProvider = () => kit.count;
    }
    if (this.optiwand) {
      const wand = this.optiwand;
      this.hud.toolLabel = () => wand.toolLabel();
    }
    if (this.suspectAlert) {
      const al = this.suspectAlert;
      const th = this.hostageThreat;
      this.hud.alertProvider = () => ({ value: al.value, tier: al.tier, threat: th?.isActive === true });
    }
    this.minimap = new Minimap(
      document.body,
      map,
      this.player,
      this.doors,
      suspect ? EMPTY_COVERAGE : this.squad.coverage,
      suspect ? undefined : () => this.squad.getMinimapAllies(),
      suspect ? undefined : () => this.squad.getMinimapWaypoints(),
      suspect ? undefined : () => this.minimapContacts(),
      suspect ? undefined : () => this.minimapPulses(),
      suspect ? undefined : () => this.minimapVisibleEnemies(),
    );
    this.minimap.setVisible(false);

    const seedShareInfo: SeedShareInfo | undefined =
      map.seed !== undefined
        ? { stage: map.id, seed: map.seed, mode }
        : undefined;

    this.pauseMenu = new PauseMenu(document.body, {
      onResume: () => this.resumeGame(),
      onRetry: () => onRetry(),
      onBackToBriefing: () => onRetry(),
      onBackToTitle,
      seedInfo: seedShareInfo,
    });

    this.makeBriefing = () =>
      new BriefingScreen(document.body, map, {
        onStart: () => this.openNegotiation(),
        onRegenerate,
        mode,
        onBackToTitle,
        onOpenSettings: () => this.pauseMenu.open('settings'),
        seedShareInfo,
      });
    this.briefingScreen = this.makeBriefing();
    this.briefingScreen.show();
    if (isFirstRun('negotiation')) this.negotiationPhase.showFirstTimeTip(() => markSeen('negotiation'));
    if (!suspect && map.allies.length > 0 && isFirstRun('squad')) {
      this.squadTour = new SquadTour(document.body, () => markSeen('squad'));
    }
    if (!suspect) this.scoreHud = new ScoreHud(this.hud.topRightSlot, this.roe);
    this.resultScreen = new ResultScreen(document.body, this.roe, onRetry, {
      stages,
      currentStageId: map.id,
      onSelectStage,
      seedShareInfo,
      onBackToTitle,
    });

    this.unsubSettings = subscribeSettings((s, prev) => {
      this.audio.setMasterVolume(s.masterVolume);
      this.audio.setMuted(s.muted);
      if (s.aoEnabled !== prev.aoEnabled) {
        this.resolution.reset(undefined, s.aoEnabled);
        this.postfx.setAO(this.resolution.aoActive);
      }
      if (s.shadowsEnabled !== prev.shadowsEnabled) {
        this.renderer.shadowMap.enabled = s.shadowsEnabled;
        this.renderer.shadowMap.needsUpdate = true;
        this.markMaterialsShadowUpdate();
        this.resolution.reset(undefined, s.aoEnabled);
      }
      if (s.language !== prev.language) {
        // 言語切替でマップを作り直さない。文言を焼き込んだ画面だけ作り直す
        if (this.phase === 'briefing') this.relocalizeBriefing();
        this.hud.refreshLocale();
      }
    });

    this.input.onPointerLockChange = (locked) => {
      if (this.phase === 'playing') {
        if (locked) {
          this.wasLockedDuringPlay = true;
        } else if (this.wasLockedDuringPlay) {
          this.pauseGame();
        }
      }
    };
    window.addEventListener('keydown', this.onGlobalKeyDown);
    window.addEventListener('resize', this.onResize);
    Object.defineProperty(window, '__cqbDebug', {
      configurable: true,
      get: () => this.getDebugInfo(),
    });
    if (import.meta.env.DEV) {
      // 開発時のみ: 描画せずにシミュレーションを進める（AI 挙動の自動検証用）
      (window as unknown as { __cqbStep?: (sec: number) => void }).__cqbStep = (sec: number) => {
        for (let t = 0; t < sec; t += 1 / 30) this.update(1 / 30);
      };
      (window as unknown as { __cqbApp?: unknown }).__cqbApp = this;
    }

    this.applyShadowFlags(this.scene);
    this.lastSwatChildren = this.swatTeam?.root.children.length ?? 0;
    this.lastFortifyChildren = this.fortify?.root.children.length ?? 0;
    this.lastSquadChildren = this.squad.root.children.length;
    this.world.lights.snap(this.camera.position);
    this.loop = new GameLoop(
      (dt, raw) => {
        this.resolution.sample(raw, this.phase === 'playing');
        this.update(dt);
      },
      () => this.render(),
    );
    this.loop.start();
  }

  /** ブリーフィング → 突入前交渉 */
  /** ブリーフィング中の言語切替: ブリーフィングと（まだ始まっていない）交渉画面だけを作り直す */
  private relocalizeBriefing(): void {
    this.briefingScreen.dispose();
    this.negotiationPhase.dispose();
    this.negotiationPhase = this.makeNegotiation();
    if (isFirstRun('negotiation')) this.negotiationPhase.showFirstTimeTip(() => markSeen('negotiation'));
    this.briefingScreen = this.makeBriefing();
    this.briefingScreen.show();
  }

  private openNegotiation(): void {
    if (this.phase !== 'briefing') return;
    this.pauseMenu.hide();
    this.phase = 'negotiation';
    this.audio.unlock();
    this.briefingScreen.hide();
    this.negotiationPhase.show();
  }

  /**
   * 籠城の消耗の効果を適用する（startMission で 1 回）。
   * 容疑者モード: プレイヤーと仲間の容疑者の両方に効く（士気は突入開始の瞬間に別途 applySiegeMorale）。
   * SWAT モード: 容疑者 AI だけに効く（拡散・反応時間・士気。プレイヤーは常に消耗 0 扱い）。
   */
  private applySiegeFatigue(): void {
    const v = this.siegeFatigue;
    const ai = aiFatigueEffects(v, this.siegeCfg.ai);
    if (this.mode === 'suspect') {
      this.player.setFatigueEffects(playerFatigueEffects(v, this.siegeCfg.player));
      for (const s of this.entities.suspects.values()) s.applyFatigue(ai);
    } else {
      for (const s of this.entities.suspects.values()) {
        s.applyFatigue(ai);
        s.applyFatigueMorale(ai.moraleDelta);
      }
    }
  }

  /** 容疑者モードの突入開始の瞬間: 仲間の容疑者へ消耗による士気ペナルティ（1 体 1 回） */
  private applySiegeMorale(): void {
    const { moraleDelta } = aiFatigueEffects(this.siegeFatigue, this.siegeCfg.ai);
    for (const s of this.entities.suspects.values()) s.applyFatigueMorale(moraleDelta);
  }

  private startMission(): void {
    if (this.phase !== 'briefing' && this.phase !== 'negotiation') return;
    this.pauseMenu.hide();
    this.phase = 'playing';
    this.wasLockedDuringPlay = false;
    this.input.allowAutoPointerLock = true;
    this.hud.setPaused(false);
    this.audio.unlock();
    this.briefingScreen.hide();
    this.negotiationPhase.hide();
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.minimap.setVisible(true);
    this.suspectMission?.setVisible(true);
    this.fortify?.setVisible(true);
    this.squadTour?.setVisible(true);
    this.applySiegeFatigue();
    this.beginSwatMission();
    try {
      void Promise.resolve(this.renderer.domElement.requestPointerLock()).catch(() => {
        // ポインタロックが拒否された場合は通常の画面クリック待機にフォールバック
      });
    } catch {
      // ポインタロックが拒否された場合は通常の画面クリック待機にフォールバック
    }
  }

  private pauseGame(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.input.allowAutoPointerLock = false;
    this.hud.setPaused(true);
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch {
        // ignore
      }
    }
    this.pauseMenu.open('pause');
  }

  private resumeGame(): void {
    if (this.phase !== 'paused') return;
    this.pauseMenu.hide();
    this.phase = 'playing';
    this.wasLockedDuringPlay = false;
    this.input.allowAutoPointerLock = true;
    this.hud.setPaused(false);
    try {
      void Promise.resolve(this.renderer.domElement.requestPointerLock()).catch(() => {
        // fallback to click-to-lock
      });
    } catch {
      // fallback to click-to-lock
    }
  }

  private onGlobalKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (e.code === 'Escape') {
      if (this.pauseMenu.isOpen && this.pauseMenu.currentMode === 'settings') {
        e.preventDefault();
        this.pauseMenu.hide();
      } else if (this.phase === 'paused') {
        e.preventDefault();
        this.resumeGame();
      } else if (this.phase === 'playing') {
        e.preventDefault();
        this.pauseGame();
      }
    } else if (e.code === 'KeyP') {
      if (this.phase === 'playing') {
        e.preventDefault();
        this.pauseGame();
      } else if (this.phase === 'paused') {
        e.preventDefault();
        this.resumeGame();
      }
    }
  };

  /** プレイ中の誤操作（Ctrl+W 等）によるタブ閉じ・離脱を確認する */
  private onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (this.phase !== 'playing' && this.phase !== 'paused') return;
    e.preventDefault();
    e.returnValue = '';
  };

  private endMission(failed = false, report?: ResultReport): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.input.allowAutoPointerLock = false;
    this.pauseMenu.hide();
    this.hud.setPaused(false);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.briefingScreen.hide();
    this.minimap.setVisible(false);
    this.optiwand?.setEquipped(false);
    this.suspectMission?.setVisible(false);
    this.fortify?.setVisible(false);
    // 途中まで見たツアーは既読扱い（毎回出ると煩わしいため）
    this.squadTour?.finish();
    this.squadTour = null;
    if (document.pointerLockElement) document.exitPointerLock();
    this.resultScreen.show(failed, report);
  }

  private update(dt: number): void {
    if (this.phase === 'briefing' || this.phase === 'negotiation' || this.phase === 'paused') {
      this.input.consumeWheel();
      this.input.consumeMouseDelta();
      this.input.endFrame();
      return;
    }
    if (this.phase === 'ended') {
      this.audio.update(dt);
      this.subtitle.update(dt);
      this.input.endFrame();
      return;
    }
    this.roe.update(dt);
    this.medkit?.update(dt); // player / weapons より前（移動の上限と射撃禁止を同フレームで効かせる）
    this.player.update(dt);
    this.audioBridge.updateListener(this.camera);
    this.audio.update(dt);
    this.interaction.update(dt);
    this.doors.update(dt);
    this.world.update(dt, this.camera.position);
    this.optiwand?.update(dt); // フラッシュバンより先（構え切替・射撃抑止の優先順を保つ）
    this.flashbang.update(dt);
    this.tearGas.update(dt);
    this.weapons.update(dt);
    this.entities.update(dt);
    this.suspectAlert?.update(dt);
    this.hostageThreat?.update(dt);
    this.doorTraps?.update(dt);
    if (this.swatTeam) this.swatTeam.update(dt);
    else this.squad.update(dt);
    this.hostageGrab?.update(dt);
    this.allyDirector?.update(dt);
    this.pepper?.update(dt);
    this.tearGasEffect?.update(dt);
    this.fortify?.update(dt);
    const viewStyle = this.flashbang.equipped ? this.flashbang.weapon.id : this.weapons.weapon.id;
    this.viewModel.setStyle(viewStyle);
    this.viewModel.root.visible = !this.optiwand?.equipped;
    const reloadP = this.flashbang.equipped ? null : this.weapons.reloadProgress;
    this.viewModel.update(dt, this.player.isMoving, reloadP, this.weapons.reloadFromEmpty);
    this.playReloadCues(reloadP);
    this.syncDynamicShadows();
    this.avatar.update(this.player);
    this.arrest?.update(dt);
    this.doorWork?.update(dt);
    this.warningCall?.update(dt);
    this.subtitle.update(dt);
    this.hud.update(dt);
    if (this.pendingReply) {
      this.subtitle.show(this.pendingReply, 1.8);
      this.pendingReply = '';
    }
    this.minimap.update(dt);
    this.mission?.update(dt);
    this.suspectMission?.update(dt);
    if (this.squadTour) {
      this.squadTour.update(dt, this.input.wasPressed('quickOrder') && !this.input.isOrderMenuOpen);
      if (this.squadTour.done) this.squadTour = null;
    }
    this.input.endFrame();
  }

  /** リロード進捗の節目で機械音を鳴らす。 */
  private playReloadCues(p: number | null): void {
    const prev = this.lastReloadP;
    this.lastReloadP = p ?? -1;
    if (p === null) return;
    const crossed = (at: number): boolean => prev < at && p >= at;
    if (this.viewModel.hasMagazine) {
      if (crossed(0.2)) this.audio.playReload('out');
      if (crossed(0.66)) this.audio.playReload('in');
      if (this.weapons.reloadFromEmpty && crossed(0.78)) this.audio.playReload('rack');
    } else if (crossed(0.3) || crossed(0.7)) {
      this.audio.playReload('click');
    }
  }

  /** 増援・C2・バリケードなど動的に追加されたルート配下のみ、子要素数が増えたときだけ影フラグを適用する。 */
  private syncDynamicShadows(): void {
    if (this.swatTeam) {
      const n = this.swatTeam.root.children.length;
      if (n !== this.lastSwatChildren) {
        if (n > this.lastSwatChildren) this.applyShadowFlags(this.swatTeam.root);
        this.lastSwatChildren = n;
      }
    }
    if (this.fortify) {
      const n = this.fortify.root.children.length;
      if (n !== this.lastFortifyChildren) {
        if (n > this.lastFortifyChildren) this.applyShadowFlags(this.fortify.root);
        this.lastFortifyChildren = n;
      }
    }
    const squadN = this.squad.root.children.length;
    if (squadN !== this.lastSquadChildren) {
      if (squadN > this.lastSquadChildren) this.applyShadowFlags(this.squad.root);
      this.lastSquadChildren = squadN;
    }
  }

  /** 不透明メッシュに影の投影/受けを設定する（noShadow 指定メッシュは投影せず受けのみ）。 */
  private applyShadowFlags(root: THREE.Object3D = this.scene): void {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.shadowSet) return;
      if (m.userData.noShadow) {
        m.castShadow = false;
        m.receiveShadow = true;
        m.userData.shadowSet = true;
        return;
      }
      m.userData.shadowSet = true;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const opaque = mats.every((x) => !x.transparent && !(x instanceof THREE.MeshBasicMaterial));
      m.receiveShadow = opaque;
      m.castShadow = opaque;
    });
  }

  /** 影設定の途中切替時に USE_SHADOWMAP のシェーダ再選択を強制する。 */
  private markMaterialsShadowUpdate(): void {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.material) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat && !(mat instanceof THREE.MeshBasicMaterial)) {
          mat.needsUpdate = true;
        }
      }
    });
  }

  private render(): void {
    const inWorld = this.phase === 'playing' || this.phase === 'paused';
    this.renderer.autoClear = true;
    if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    if (inWorld) this.postfx.render();
    else this.renderer.render(this.scene, this.camera);
    if (inWorld) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.equipmentScene, this.viewModel.camera);
      this.optiwand?.render(this.renderer, this.scene);
    }
  }

  /**
   * SWAT モードの突入開始: 交渉の結果から容疑者の警戒度ベースラインを確定し、ドアのブービートラップを仕掛ける。
   * 一度だけ実行する（再開では呼ばれない）。
   */
  private swatMissionBegun = false;
  private beginSwatMission(): void {
    if (this.swatMissionBegun || !this.suspectAlert || !this.doorTraps) return;
    this.swatMissionBegun = true;
    this.suspectAlert.setBaseline(this.negotiationBaseline);
    const n = rigCount(this.squadCfg.doorTrap, this.negotiationBaseline);
    const p = this.player.position;
    this.doorTraps.rig(n, { x: p.x, y: p.y, z: p.z });
  }

  /** SWAT 側（プレイヤー + 生存隊員）の位置。ドアトラップの起爆判定・人質救出の到達判定に使う。 */
  private *swatSidePositions(): Generator<{ x: number; z: number; footY: number }> {
    const p = this.player.position;
    if (this.player.alive) yield { x: p.x, z: p.z, footY: p.y };
    for (const a of this.squad.allies) {
      if (!a.down) yield { x: a.body.px, z: a.body.pz, footY: a.body.footY };
    }
  }

  private *suspectPositions(): Generator<{ x: number; z: number; footY: number }> {
    for (const s of this.entities.suspects.values()) {
      if (s.alive) yield { x: s.body.px, z: s.body.pz, footY: s.body.footY };
    }
  }

  /** ブービートラップの爆風を受ける者（プレイヤー・隊員・民間人・容疑者）。 */
  private *trapVictims(): Generator<BlastVictim> {
    if (this.player.alive) {
      yield {
        chest: () => {
          const e = this.player.getEyePosition(this.replyEyeScratch);
          return { x: e.x, y: e.y - 0.4, z: e.z };
        },
        hurt: (dmg, from) => {
          const hp = this.player.takeDamage(dmg);
          this.bus.emit('playerHit', { shooter: 'trap', damage: dmg, from, hp });
          this.player.addViewKick(0.06, (Math.random() - 0.5) * 0.08);
          this.subtitle.show(t('ブービートラップの爆風を受けた！', 'Caught in a booby trap blast!'), 1.8);
        },
      };
    }
    yield* this.squad.trapVictims();
    for (const c of this.entities.civilians.values()) {
      if (!c.alive || c.evacuated) continue;
      yield {
        chest: () => {
          const ch = c.body.chestPos();
          return { x: ch.x, y: ch.y, z: ch.z };
        },
        hurt: (dmg) => {
          if (c.damage(dmg)) this.weapons.removeTarget(c);
        },
      };
    }
    for (const s of this.entities.suspects.values()) {
      if (!s.alive) continue;
      yield {
        chest: () => {
          const ch = s.body.chestPos();
          return { x: ch.x, y: ch.y, z: ch.z };
        },
        hurt: (dmg, from) => {
          if (s.takeHit(dmg, from)) this.weapons.removeTarget(s);
        },
      };
    }
  }

  /** 人質処刑（容疑者が人質を撃つ）。銃声を鳴らす。スコアは通常の人質死亡と同じ（保護加点を失う）。 */
  private executeHostage(civilianId: string, suspectId: string): void {
    const civ = this.entities.civilians.get(civilianId);
    const s = this.entities.suspects.get(suspectId);
    if (!civ) return;
    const chest = civ.body.chestPos();
    const pos: Vec3 = { x: chest.x, y: chest.y, z: chest.z };
    if (civ.damage(9999)) this.weapons.removeTarget(civ);
    this.bus.emit('shotFired', { shooter: suspectId, pos });
    this.bus.emit('noise', { pos, radius: 45, kind: 'gunshot', source: 'suspect' });
    s?.body.showMuzzleFlash(0.08);
  }

  /** ミニマップ用: 人質処刑の脅迫中に人質の位置で脈打つ警告 */
  private minimapPulses(): { x: number; y: number; z: number; progress: number }[] {
    const p = this.hostageThreat?.pulse();
    return p ? [p] : [];
  }

  /** ミニマップの敵赤点: 発見から一定時間で消える（最後の確認位置に残り、徐々に薄くなる） */
  private recordEnemySighting(id: string, x: number, y: number, z: number): void {
    const now = performance.now() / 1000;
    const rec = this.enemySightings.get(id);
    if (rec) {
      rec.x = x;
      rec.y = y;
      rec.z = z;
      rec.t = now;
    } else {
      this.enemySightings.set(id, { x, y, z, t: now });
    }
  }

  /**
   * ミニマップ用: プレイヤー・隊員の視界、オプティワンド/ミラーで確認した容疑者（赤点表示）。
   * 見えている間は現在位置を追従し、見失うと最後の確認位置で ENEMY_DOT_HOLD_SEC 保持後にフェードして消える。
   */
  private minimapVisibleEnemies(): { x: number; y: number; z: number; alpha: number }[] {
    const eye = this.player.getEyePosition(this.minimapEyeScratch);
    for (const s of this.entities.suspects.values()) {
      if (!s.alive || s.state === SuspectState.ARRESTED) {
        this.enemySightings.delete(s.id);
        continue;
      }
      const chest = s.body.chestPos();
      const seenByPlayer =
        Math.hypot(chest.x - eye.x, chest.z - eye.z) <= 40 &&
        this.player.inCameraView(chest) &&
        hasLineOfSight(this.world.colliders, eye, chest);
      if (seenByPlayer || this.squad.allySeesPoint(chest)) {
        this.recordEnemySighting(s.id, s.body.px, s.body.footY, s.body.pz);
      }
    }
    const now = performance.now() / 1000;
    const out: { x: number; y: number; z: number; alpha: number }[] = [];
    for (const [id, rec] of this.enemySightings) {
      const age = now - rec.t;
      if (age >= ENEMY_DOT_HOLD_SEC + ENEMY_DOT_FADE_SEC) {
        this.enemySightings.delete(id);
        continue;
      }
      const alpha = age <= ENEMY_DOT_HOLD_SEC ? 1 : 1 - (age - ENEMY_DOT_HOLD_SEC) / ENEMY_DOT_FADE_SEC;
      out.push({ x: rec.x, y: rec.y, z: rec.z, alpha });
    }
    return out;
  }

  /** ミニマップ用: 偵察で確認した接触（武装容疑者・民間人・非武装） */
  private minimapContacts(): { x: number; y: number; z: number; kind: 'threat' | 'civilian' | 'unarmed' }[] {
    const out: { x: number; y: number; z: number; kind: 'threat' | 'civilian' | 'unarmed' }[] = [];
    for (const c of this.scoutIntel.all()) {
      // 容疑者は時間で消える赤点（minimapVisibleEnemies）で表示するため、ここでは民間人のみ
      if (c.kind !== 'civilian') continue;
      out.push({ x: c.x, y: c.y, z: c.z, kind: 'civilian' });
    }
    return out;
  }

  private onResize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    if (Math.abs(dpr - this.lastDpr) > 0.01) {
      this.lastDpr = dpr;
      this.resolution.reset(undefined, getSettings().aoEnabled);
    }
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.viewModel.resize(this.camera.aspect);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.postfx.setSize(window.innerWidth, window.innerHeight);
  };

  getDebugInfo(): {
    mapId: string;
    mode: GameMode;
    phase: AppPhase;
    swat?: { id: string; state: string; hp: number; x: number; z: number; y: number }[];
    memory: { geometries: number; textures: number };
    programs: number;
  } {
    return {
      mapId: this.mapId,
      mode: this.mode,
      phase: this.phase,
      swat: this.swatTeam?.hunters.map((h) => ({ id: h.id, state: h.state, hp: h.hp, x: h.body.px, z: h.body.pz, y: h.body.footY })),
      memory: {
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
      },
      programs: this.renderer.info.programs?.length ?? 0,
    };
  }

  destroy(): void {
    delete (window as unknown as { __cqbDebug?: unknown }).__cqbDebug;
    delete (window as unknown as { __cqbStep?: unknown }).__cqbStep;
    delete (window as unknown as { __cqbApp?: unknown }).__cqbApp;
    this.loop.destroy();
    this.unsubSettings();
    window.removeEventListener('keydown', this.onGlobalKeyDown);
    this.pauseMenu.dispose();
    this.briefingScreen.dispose();
    this.squadTour?.dispose();
    this.minimap.dispose();
    this.resultScreen.dispose();
    this.scoreHud?.dispose();
    this.mission?.dispose();
    this.suspectMission?.dispose();
    this.allyDirector?.dispose();
    this.swatTeam?.dispose();
    this.roe.dispose();
    this.hostageGrab?.dispose();
    this.fortify?.dispose();
    this.suspectAlert?.dispose();
    this.doorTraps?.dispose();
    this.pepper?.dispose();
    this.tearGasEffect?.dispose();
    this.tearGas.dispose();
    this.negotiationPhase.dispose();
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.hud.dispose();
    this.optiwand?.dispose();
    this.flashbang.dispose();
    this.flashOverlay.dispose();
    this.squad.dispose();
    this.viewModel.dispose();
    this.avatar.dispose();
    this.entities.dispose();
    this.arrest?.dispose();
    this.doorWork?.dispose();
    this.warningCall?.dispose();
    this.subtitle.dispose();
    this.weapons.dispose();
    this.doors.dispose();
    this.interaction.dispose();
    this.player.dispose();
    this.input.dispose();
    this.audioBridge.dispose();
    this.audio.stopAll();
    this.bus.clear();
    window.removeEventListener('resize', this.onResize);
    this.world.dispose();
    this.scene.environment = null;
    disposeObject(this.equipmentScene);
    disposeObject(this.scene);
    this.postfx.dispose();
    this.renderer.setRenderTarget(null);
    this.renderer.autoClear = true;
  }
}

let app: App | null = null;
let title: TitleScreen | null = null;
let errorEl: HTMLElement | null = null;
let startToken = 0;
let currentMapId: string | null = null;
let currentSeed: number | undefined;
let currentMode: GameMode = 'swat';
let stagesPromise: Promise<StageEntry[]> | null = null;

function ensureStages(): Promise<StageEntry[]> {
  if (!stagesPromise) {
    stagesPromise = DataLoader.loadStages().catch((err: unknown) => {
      stagesPromise = null;
      throw err;
    });
  }
  return stagesPromise;
}

function showError(err: unknown): void {
  errorEl?.remove();
  errorEl = document.createElement('pre');
  errorEl.style.cssText =
    'position:fixed;inset:0 auto auto 0;margin:0;padding:12px;background:#400;color:#fff;font:14px monospace;white-space:pre-wrap;z-index:30';
  errorEl.textContent = err instanceof Error ? err.message : String(err);
  document.body.appendChild(errorEl);
}

/** URL の mode を現在のモードに合わせる（再読み込みしてもタイトルで同じモードが選ばれている） */
function syncModeToUrl(mode: GameMode): void {
  const url = new URL(window.location.href);
  if (mode === 'suspect') url.searchParams.set('mode', 'suspect');
  else url.searchParams.delete('mode');
  url.searchParams.delete('waves'); // 廃止した増援ウェーブのパラメータ
  window.history.replaceState(null, '', url);
}

/**
 * タイトル画面。モードとマップの広さを選んで「出動」した時点で初めてマップを生成する。
 * ゲーム中のアプリは破棄してから表示する（WebGL レンダラは共有）。
 */
function showTitle(): void {
  ++startToken; // 進行中の生成は破棄
  app?.destroy();
  app = null;
  errorEl?.remove();
  errorEl = null;
  if (title) return;
  const shared = acquireSharedRenderer(document.body);
  title = new TitleScreen(document.body, {
    renderer: shared.renderer,
    envTex: shared.envTex,
    audio: acquireSharedAudio(),
    stages: ensureStages(),
    initialMode: currentMode,
    initialStageId: currentMapId,
    onStart: (mode, stageId) => {
      syncModeToUrl(mode);
      start(stageId, randomSeed(), mode);
    },
  });
  ensureStages().catch((err: unknown) => {
    console.error(err);
    showError(err);
  });
}

function closeTitle(): void {
  title?.dispose();
  title = null;
}

function start(mapId?: string, seed?: number, mode?: GameMode): void {
  if (mode !== undefined) currentMode = mode;
  const runMode = currentMode;
  app?.destroy();
  app = null;
  errorEl?.remove();
  errorEl = null;
  const token = ++startToken;
  void (async () => {
    try {
      const loadedStages = await ensureStages();
      if (token !== startToken) return; // 再 start された場合は破棄
      const firstStage = loadedStages[0];
      if (!firstStage) throw new Error('ステージ一覧が空です');
      const requestedId = mapId !== undefined ? mapId : (currentMapId ?? firstStage.id);
      // 存在しない ID（廃止した固定ステージの URL など）は先頭ステージにフォールバック
      const stage = loadedStages.find((s) => s.id === requestedId) ?? firstStage;
      const targetId = stage.id;
      if (targetId !== requestedId) console.warn(`[data] ステージ "${requestedId}" は存在しないため "${stage.id}" を使用します`);
      // シード: 明示シード > リトライ（同ステージ・mapId 省略）は前回シード > 新規シード
      const useSeed =
        seed !== undefined
          ? normalizeSeed(seed)
          : mapId === undefined && targetId === currentMapId && currentSeed !== undefined
            ? currentSeed
            : randomSeed();
      const data = await DataLoader.loadAll(stage, useSeed);
      if (token !== startToken) return; // 再 start された場合は破棄
      currentMapId = targetId;
      currentSeed = useSeed;
      console.info('[data] loaded', data.map.id, `seed=${useSeed}`, `weapons=${data.weapons.length}`, `profiles=${data.aiProfiles.length}`, `allies=${data.map.allies.length}`, `stairs=${data.map.stairs.length}`, `floors=${data.map.floors.length}`);
      closeTitle(); // 共有レンダラをゲームへ明け渡す
      app = new App(
        document.body,
        data.map,
        data.player,
        data.doors,
        data.weapons,
        data.aiProfiles,
        data.roe,
        data.perception,
        loadedStages,
        data.squad,
        data.suspectAlert,
        data.swatAimSettle,
        data.siege,
        (nextStageId) => start(nextStageId),
        () => start(),
        (nextSeed) => start(targetId, nextSeed ?? randomSeed()),
        runMode,
        () => showTitle(),
      );
    } catch (err: unknown) {
      console.error(err);
      if (token === startToken) {
        title?.cancelLoading();
        showError(err);
      }
    }
  })();
}

// 共有 URL（?stage=random_house&seed=12345&mode=suspect）はタイトルを飛ばしてそのマップを直接生成する。
// それ以外はタイトル画面から始め、モードと広さが決まるまでマップは生成しない。
{
  const params = new URLSearchParams(window.location.search);
  const qStage = params.get('stage') ?? undefined;
  const qSeedRaw = params.get('seed');
  const qSeed = qSeedRaw !== null && /^\d+$/.test(qSeedRaw) ? Number(qSeedRaw) : undefined;
  currentMode = parseGameMode(params.get('mode'));
  if (qStage !== undefined) currentMapId = qStage;
  if (qSeed !== undefined) start(qStage, qSeed, currentMode);
  else showTitle();
}

// リトライ・ステージ切替検証用: コンソールから `__cqbRetry()` / `__cqbRetry('random_small')` / `__cqbRetry('random_house', 12345)` で destroy→再生成。HMR 時は破棄のみ。
(window as unknown as { __cqbRetry: (mapId?: string, seed?: number, mode?: GameMode) => void }).__cqbRetry = (
  mapId?: string,
  seed?: number,
  mode?: GameMode,
) => {
  closeTitle();
  start(mapId, seed, mode);
};
(window as unknown as { __cqbTitle: () => void }).__cqbTitle = () => showTitle();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    ++startToken;
    errorEl?.remove();
    errorEl = null;
    closeTitle();
    app?.destroy();
    app = null;
    sharedAudio?.dispose();
    sharedAudio = null;
    sharedTextures?.dispose();
    sharedTextures = null;
    sharedEnvTex?.dispose();
    sharedEnvTex = null;
    sharedRenderer?.dispose();
    sharedRenderer?.domElement.remove();
    sharedRenderer = null;
    delete (window as unknown as { __cqbDebug?: unknown }).__cqbDebug;
  });
}
