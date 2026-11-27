/** モジュール間で共有する純粋な型定義（import 無し・循環参照防止）。 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ---------- Map ----------

export interface PlayerSpawn {
  x: number;
  y: number;
  z: number;
  /** 度数。0 = -Z 方向を向く */
  yaw: number;
}

/** XZ 平面上の中心座標 + 寸法の直方体（床からの設置を想定）。 */
export interface BoxDef {
  x: number;
  z: number;
  width: number; // X 方向
  height: number; // Y 方向
  depth: number; // Z 方向
  /** 度数。省略時 0 */
  yaw?: number;
  /** 底面の高さ(m)。省略時 0（上階の壁・家具） */
  y?: number;
  /** 生成テクスチャ名（concrete / plaster / wood / tile / carpet / fabric / brick / metal）。省略時は種別の既定 */
  material?: string;
  /** 遮蔽物を読める小道具として描くときの種類（bed, piano など）。省略時は箱のまま */
  prop?: string;
}

export type WallDef = BoxDef;
export type CoverDef = BoxDef;

export interface DoorDef {
  id: string;
  x: number;
  z: number;
  /** 度数。0 = ドア面が X 軸方向（壁が X 方向に延びる）、90 = Z 方向 */
  yaw: number;
  locked: boolean;
  /** 全開角度（度） */
  maxAngle: number;
  /** ドア幅(m)。省略時 1.2 */
  width?: number;
  /** 敷居の高さ(m)。省略時 0 */
  y?: number;
  /** true = 両開きドア（観音開き）。省略時 false */
  double?: boolean;
}

/** 階段。yaw 0 は -Z 方向へ上る。段の寸法は JSON、段コライダはワールド生成時に展開する。 */
export interface StairDef {
  id: string;
  x: number;
  z: number;
  yaw: number;
  width: number;
  steps: number;
  /** 1段の高さ(m)。歩行の段差上限以下であること */
  rise: number;
  /** 1段の奥行(m) */
  run: number;
  /** 最下段の床高さ。省略時 0 */
  y?: number;
}

/** 窓（壁の開口に合わせた枠とガラス。当たりは壁側で切る） */
export interface WindowDef {
  x: number;
  z: number;
  yaw: number;
  width: number;
  height: number;
  /** 床からの腰壁高さ(m) */
  sill: number;
  /** 取り付け高さの基準。省略時 0 */
  y?: number;
  /** 室内の窓口（部屋どうしの仕切り壁の素通し開口。ガラスなし・カウンター付き） */
  interior?: boolean;
}

export type ItemKind = 'rifle' | 'evidence' | 'radio' | 'flashbang' | 'medkit';

/** 床に置ける小道具。回収ゲームプレイとは独立した見た目と配置。 */
export interface ItemDef {
  id: string;
  kind: ItemKind;
  x: number;
  z: number;
  y?: number;
  yaw?: number;
}

/** 突入班の仲間。AI・装備の数値は squad.json。 */
export interface AllyDef {
  id: string;
  name: string;
  x: number;
  z: number;
  y?: number;
  yaw?: number;
}

export type EntityType = 'suspect' | 'civilian';

export type MapEntityType = EntityType;

export interface EntityDef {
  id: string;
  type: MapEntityType;
  /** ai_profiles.json の id */
  profile?: string;
  hp?: number;
  x: number;
  z: number;
  /** 足元の高さ(m)。省略時 0 */
  y?: number;
  /** 度数。省略時 0 */
  yaw?: number;
}

export interface RoomDef {
  id: string;
  name: string;
  /** 中心座標 */
  x: number;
  z: number;
  width: number;
  depth: number;
  /** この部屋の床高さ(m)。省略時 0。上下階が XZ で重なるときの区別 */
  floorY?: number;
  /** true = 屋外区画（前庭・アプローチ・中庭）。屋内天井と室内クリアリング対象から除外 */
  outdoor?: boolean;
  /** 部屋個別の天井高さ(m)。平屋ウイング等で map.ceilingHeight と異なる場合に使用 */
  ceilingY?: number;
}

export interface BriefingRange {
  min: number;
  max: number;
}

export interface BriefingDef {
  /** 状況概要（任意） */
  summary?: string;
  /** 推定容疑者数（例: { min: 2, max: 4 }） */
  estimatedSuspects: BriefingRange;
  /** 推定人質・民間人数 */
  estimatedHostages: BriefingRange;
}

/** ランダム生成マップの施設モチーフ。シードから一意に決まり、見た目と部屋の出方を変える。 */
export const MOTIF_IDS = ['hospital', 'clubhouse', 'bank', 'office', 'warehouse', 'embassy', 'residence', 'japanese_house'] as const;
export type MotifId = (typeof MOTIF_IDS)[number];

export interface MapData {
  id: string;
  name: string;
  /** 施設モチーフ（ランダム生成時）。residence と省略時は漆喰・木の民家パレット */
  motif?: MotifId;
  /** 突入前ブリーフィング情報（任意） */
  briefing?: BriefingDef;
  /** 壁高さの既定値 / 建物全体の天井高(m) */
  ceilingHeight: number;
  /** 1フロアのドア高さ上限(m)。省略時は ceilingHeight（平屋と同じ） */
  storyHeight?: number;
  /** 床（XZ 平面、原点中心） */
  floor: { width: number; depth: number };
  playerSpawn: PlayerSpawn;
  walls: WallDef[];
  doors: DoorDef[];
  covers: CoverDef[];
  entities: EntityDef[];
  rooms: RoomDef[];
  /** 歩ける床スラブ（上面が支持面）。無ければ地面 y=0 のみ */
  floors: BoxDef[];
  stairs: StairDef[];
  windows: WindowDef[];
  items: ItemDef[];
  allies: AllyDef[];
  /** プロシージャル生成マップのシード */
  seed?: number;
}

export interface StageEntry {
  id: string;
  name: string;
  description?: string;
  /** 選択 UI に大きく出す規模ラベル（例: 小 / 中 / 大） */
  size?: string;
  /** 選択 UI に出す一行の特徴 */
  tagline?: string;
  /** generators/{generator}.json のテンプレートからシードでランダム生成する */
  generator: string;
}

export interface StagesData {
  stages: StageEntry[];
}

// ---------- Procedural map generator ----------

export interface NumRange {
  min: number;
  max: number;
}

export type FurniturePlace = 'wall' | 'corner' | 'center';

/** 部屋に置く家具（＝遮蔽物 cover）。寸法は「壁沿い方向 = width、奥行 = depth」。 */
export interface FurnitureDef {
  id: string;
  width: number;
  depth: number;
  height: number;
  place: FurniturePlace;
  /** 配置を試みる確率 0〜1 */
  chance: number;
  /** 配置個数（省略時 1） */
  count?: NumRange;
}

/** 部屋が生成される区画。side = 廊下沿い / back = 奥の横長区画 / nested = 他の部屋の奥（部屋経由で入る） */
export type RoomSlot = 'side' | 'back' | 'nested';
export type RoomPrefer = 'largest' | 'smallest' | 'front' | 'back' | 'any';

export interface RoomTypeDef {
  id: string;
  name: string;
  slots: RoomSlot[];
  minCount: number;
  maxCount: number;
  /** 必須数を満たした後のランダム割当の重み */
  weight: number;
  minArea: number;
  maxArea: number;
  /** 短辺の最小長(m) */
  minSide: number;
  prefer: RoomPrefer;
  /** true = 追加の連絡ドアを作らない（浴室・トイレ等） */
  private: boolean;
  /** 容疑者・民間人の配置されやすさ（0 で配置しない） */
  spawnWeight: number;
  furniture: FurnitureDef[];
}

/** 玄関ポーチ・玄関・廊下など、間取り骨格側で生成される特殊区画の表示名と家具。 */
export interface SpecialAreaDef {
  name: string;
  spawnWeight: number;
  furniture: FurnitureDef[];
}

export type HouseLayoutId =
  | 'center_I'
  | 'center_T'
  | 'wing_L'
  | 'stepped_villa'
  | 'courtyard_U'
  | 'embassy_compound';

export interface HouseGeneratorTemplate {
  type: 'house';
  id: string;
  /** マップ名（ブリーフィングのタイトル） */
  name: string;
  /** 状況概要の候補（ランダムに 1 つ） */
  summaries: string[];
  ceilingHeight: number;
  wallThickness: number;
  /** 寸法の丸め単位(m) */
  snap: number;
  /** 生成失敗時の再試行回数 */
  maxAttempts: number;
  footprint: { width: NumRange; depth: NumRange };
  porchDepth: NumRange;
  layouts: { id: HouseLayoutId; weight: number }[];
  hallway: { width: NumRange; minLength: number };
  sideZone: { minWidth: number; maxWidth: number; roomDepth: NumRange };
  backZone: { depth: NumRange; roomCount: NumRange; minRoomWidth: number };
  genkan: { chance: number; depth: NumRange; archChance: number };
  nested: { chance: number; minInnerWidth: number; minOuterWidth: number };
  door: {
    width: number;
    maxAngle: number;
    /** ドア開口と壁の交点との最小距離(m) */
    margin: number;
    lockedChance: number;
    maxLocked: number;
    /** 隣接する部屋同士に追加の連絡ドアを作る確率 */
    extraConnectChance: number;
    /** LDK 等の隣接で、ドアの代わりに開口（アーチ）にする確率 */
    archChance: number;
    archWidth: number;
    /** archChance を適用する部屋タイプの組み合わせ（どちらも含まれる場合） */
    archRoomTypes: string[];
    /** 外壁へ窓を生成する確率（0〜1、省略時 0.55） */
    windowChance?: number;
  };
  furnitureGap: number;
  /** center 配置家具と壁の最小距離（外周の通路確保） */
  wallClearance: number;
  special: { porch: SpecialAreaDef; genkan: SpecialAreaDef; hallway: SpecialAreaDef };
  roomTypes: RoomTypeDef[];
  /** どのタイプにも合わない部屋に使うタイプ id */
  fallbackRoomType: string;
  entities: {
    suspects: NumRange;
    civilians: NumRange;
    suspectProfiles: { profile: string; weight: number; max: number }[];
    civilianProfile: string;
    /** プレイヤー突入地点からの最小距離(m) */
    minSpawnDistance: number;
    /** 民間人を容疑者と同室（人質）に置く確率 */
    hostagePairChance: number;
    clearance: number;
    /** ブリーフィングの推定人数の誤差（±） */
    briefingUncertainty: number;
  };
}

// ---------- Modular generator template (docs/design/modular-map-generator.md §2.3) ----------

/** 階層。-1 = B1、0 = 1F、1 = 2F。floorY(level) = level * storyRise */
export type StoryLevel = -1 | 0 | 1;
/** 格子単位。0.25 / 0.5 のみ（2 進浮動小数点と round3 の双方で丸め誤差ゼロ） */
export type ModularSnap = 0.25 | 0.5;

export type ModuleCategory =
  | 'entry' // 玄関・風除室・保安検査ロビー
  | 'stair_core' // 階段コア（上下階接続シャフト＋踊り場）
  | 'corridor' // 廊下・ホール・2F 吹き抜け回廊
  | 'living_hub' // LDK・大リビング・レセプションホール
  | 'garage' // ビルトインガレージ・搬入車庫
  | 'courtyard' // 中庭・前庭コート（outdoor: true）
  | 'wing_private' // 寝室ウィング・VIP スイート・水回りコア
  | 'study_office' // 書斎・執務室・会議室・通信/警備室
  | 'basement_utility' // 地下倉庫・機械室・地下シェルター/保管庫
  | 'terrace'; // 2F ルーフバルコニー（outdoor: true）

export type RoofStyle = 'stackable' | 'flat_roof_only' | 'double_height' | 'open_sky';
export type ExteriorRequirement = 'front_approach' | 'any_exterior' | 'interior_ok';
export type OrthogonalRotation = 0 | 90 | 180 | 270;
export type ModularEdgeStyle = 'door' | 'arch' | 'exterior_door';

export interface ModularFurnitureDef extends Omit<FurnitureDef, 'count'> {
  /** JSON 必須: 整数 1 <= min <= max <= 16（暗黙既定値なし） */
  count: NumRange;
}

export interface StoryProfileDef {
  id: string;
  /** >= 0（全要素中 1 つ以上 > 0 必須） */
  weight: number;
  /** 昇順・重複なし・0(1F) 必須: [0], [0,1], [-1,0], [-1,0,1] */
  levels: StoryLevel[];
  /** 階高(m): storyRise - slabThickness >= 2.40 かつ max(8, ceil(storyRise / targetRise)) <= 32 */
  storyRise: number;
  /** levels に 1 を含むとき必須（0.20 <= min <= max <= 0.90） */
  upperFloorRatio?: NumRange;
  /** levels に 1 を含むとき必須（0..1） */
  roofTerraceChance?: number;
  /** levels に -1 を含むとき必須（0.15 <= min <= max <= 0.85） */
  basementRatio?: NumRange;
}

export interface SubRoomSpec {
  id: string;
  name: string;
  /** 0.15〜1.0 */
  shareWeight: number;
  /** >= max(1.6, door.width + wallThickness + 2 * door.margin) */
  minSide: number;
  /** true = 最終 RoomDef の非窓開口次数が厳密に 1 */
  private: boolean;
  connectStyle: 'door' | 'arch';
  spawnWeight: number;
  floorMaterial?: string;
  furniture: ModularFurnitureDef[];
}

export interface ArchitecturalModuleDef {
  id: string;
  name: string;
  category: ModuleCategory;
  /** 1 要素以上・重複なし */
  allowedLevels: StoryLevel[];
  /** 整数 0..8 */
  minCount: number;
  /** 整数 1..12（minCount <= maxCount） */
  maxCount: number;
  /** >= 0 */
  weight: number;
  width: NumRange;
  depth: NumRange;
  exteriorRequirement: ExteriorRequirement;
  roofStyle: RoofStyle;
  /** 0..1（roofStyle === 'stackable' かつ category !== 'entry' 以外は 0 必須） */
  doubleHeightChance: number;
  /** JSON 省略時は false に正規化 */
  outdoor: boolean;
  /** JSON 省略時は false に正規化 */
  private: boolean;
  /** category === 'entry' または outdoor === true は 0 必須 */
  spawnWeight: number;
  floorMaterial?: string;
  furniture: ModularFurnitureDef[];
  /** JSON 省略時は [] に正規化（最大 6 件） */
  subRooms: SubRoomSpec[];
}

export interface AdjacencyRuleDef {
  from: ModuleCategory;
  to: ModuleCategory;
  style: ModularEdgeStyle;
  weight: number;
}

export interface CirculationRulesDef {
  /** 1..128 件 */
  allowedEdges: AdjacencyRuleDef[];
  /** 0..128 件（allowedEdges と無向で重複すると DataError） */
  forbiddenEdges: [ModuleCategory, ModuleCategory][];
  /** 整数 0..8 */
  loopCount1F: NumRange;
  /** 整数 0..6 */
  loopCountOther: NumRange;
  extraDoorChance: number;
  secondaryExteriorDoorChance: number;
  /** 整数 1..8 */
  maxExteriorDoors: number;
}

export interface SiteTransformDef {
  /** 1..4 件・重複なし */
  rotationsAllowed: OrthogonalRotation[];
  mirrorAllowed: boolean;
  /** >= 3.5m */
  approachDepth: NumRange;
  /** >= 1.5m */
  perimeterMargin: number;
  /** >= 1.0m（敷地前端からの退避距離） */
  spawnSetback: number;
  /** >= 0.7m */
  allyLateralOffset: number;
  /** >= 0.4m */
  allyBackOffset: number;
  /** >= 1.8m（玄関前の遮蔽物禁止半幅） */
  approachKeepOutHalfWidth: number;
  approachFurniture: ModularFurnitureDef[];
  approachName: string;
}

export interface StairCoreConfigDef {
  /** 0.95〜2.0m */
  flightWidth: number;
  /** 0.15〜0.24m */
  targetRise: number;
  /** 0.24〜0.34m */
  treadRun: number;
  /** >= max(1.35, door.width + wallThickness + 2 * door.margin) */
  landingDepth: number;
  /** >= wallThickness */
  laneGap: number;
  /** >= max(1.10, door.width + 2 * door.margin) */
  hallSideWidth: number;
  /** >= 1.0 */
  keepOutMargin: number;
  /** 整数 1..2 */
  count: NumRange;
}

export interface ModularDoorConfigDef {
  /** >= 0.85m */
  width: number;
  /** 両開きドアの幅(m)。1.2〜4.0 かつ >= width */
  doubleWidth?: number;
  /** 90..130 deg */
  maxAngle: number;
  /** >= 0.15m */
  margin: number;
  /** >= 0.30m */
  swingClearance: number;
  lockedChance: number;
  /** 整数 0..50 */
  maxLocked: number;
  /** >= width */
  archWidth: number;
  /** >= 2.05m かつ全正重みプロファイルで <= storyRise - slabThickness */
  archHeight: number;
  /** >= 0.10m */
  archMargin: number;
  /** >= 0.80m */
  archClearance: number;
}

export interface ModularWindowConfigDef {
  chance: number;
  /** min >= 0.60, max <= 3.60 */
  width: NumRange;
  /** >= 0.40 */
  height: number;
  /** >= 0.20（sill + height <= storyRise - slabThickness - 0.10） */
  sill: number;
  /** >= 0.25 */
  minMargin: number;
  /** >= 0.40m */
  keepOutDepth: number;
  /** 室内窓口（同階の屋内室どうしの仕切り壁に開ける腰壁付きの素通し開口）。隣接室ペアごとの確率。省略時 0 */
  interiorChance?: number;
  /** 室内窓口の幅 */
  interiorWidth?: NumRange;
  /** 室内窓口の腰壁（カウンター）高さ */
  interiorSill?: number;
  /** 室内窓口の開口高さ */
  interiorHeight?: number;
  /** 1 階層あたりの室内窓口の上限 */
  interiorMaxPerLevel?: number;
}

export interface ModularEntitiesDef {
  suspects: NumRange;
  civilians: NumRange;
  suspectProfiles: { profile: string; weight: number; max: number }[];
  civilianProfile: string;
  minSpawnDistance: number;
  hostagePairChance: number;
  clearance: number;
  briefingUncertainty: number;
  minEntitySeparation: number;
}

/** 検証済みモジュラーテンプレート（数値・個数の暗黙既定値なし）。 */
export interface ModularGeneratorTemplate {
  type: 'modular';
  id: string;
  name: string;
  summaries: string[];
  /** 0.10..0.50 */
  wallThickness: number;
  /** 0.08..0.50 */
  slabThickness: number;
  /** 0.95..1.50 */
  parapetHeight: number;
  snap: ModularSnap;
  /** >= 1.50 */
  minCourtGap: number;
  /** 整数 1..200 */
  maxAttempts: number;
  target1FArea: NumRange;
  maxFootprint: { width: number; depth: number };
  /** 1..4 件 */
  storyProfiles: StoryProfileDef[];
  stairCore: StairCoreConfigDef;
  site: SiteTransformDef;
  circulation: CirculationRulesDef;
  door: ModularDoorConfigDef;
  window: ModularWindowConfigDef;
  furnitureGap: number;
  wallClearance: number;
  /** 1..32 件 */
  modules: ArchitecturalModuleDef[];
  fallbackModuleId: string;
  entities: ModularEntitiesDef;
}

/** 生 JSON 上のモジュール（構造フラグ outdoor / private / subRooms のみ省略可）。 */
export type ArchitecturalModuleDefRaw = Omit<ArchitecturalModuleDef, 'outdoor' | 'private' | 'subRooms'> & {
  outdoor?: boolean;
  private?: boolean;
  subRooms?: SubRoomSpec[];
};

/** 生 JSON 上のモジュラーテンプレート（validateGeneratorTemplate が ModularGeneratorTemplate へ正規化する）。 */
export type ModularGeneratorTemplateRaw = Omit<ModularGeneratorTemplate, 'modules'> & {
  modules: ArchitecturalModuleDefRaw[];
};

/** 生成テンプレート（validateGeneratorTemplate の戻り値・generator/index.ts の generateMap の入力）。 */
export type GeneratorTemplate = HouseGeneratorTemplate | ModularGeneratorTemplate;
/** GeneratorTemplate の別名（WP-1 からの互換） */
export type AnyGeneratorTemplate = GeneratorTemplate;

/** 生成器の共通出力（validateMap 互換の生データ）。 */
export interface GeneratedMapRaw {
  id: string;
  name: string;
  /** 施設モチーフ。dressWithMotif がシードから付与する */
  motif?: MotifId;
  seed: number;
  briefing: { summary: string; estimatedSuspects: BriefingRange; estimatedHostages: BriefingRange };
  ceilingHeight: number;
  storyHeight?: number;
  floor: { width: number; depth: number };
  playerSpawn: PlayerSpawn;
  allies: AllyDef[];
  walls: BoxDef[];
  doors: DoorDef[];
  windows: WindowDef[];
  covers: BoxDef[];
  entities: EntityDef[];
  rooms: RoomDef[];
  floors?: BoxDef[];
  stairs?: StairDef[];
  items?: ItemDef[];
}

// ---------- Weapons ----------

export type WeaponCategory = 'primary' | 'nonlethal' | 'throwable';

/** 投擲物(フラッシュバン)パラメータ。weapons.json の category='throwable' に必須。範囲は WeaponDef.range を使用。 */
export interface ThrowableDef {
  /** 投擲初速 m/s */
  throwSpeed: number;
  /** 投擲方向に加える上向き角（度） */
  upwardBiasDeg: number;
  /** 重力加速度 m/s^2 */
  gravity: number;
  /** 反発係数 (0〜1) */
  restitution: number;
  /** 接触時に接線速度へ掛ける保持率 (0〜1) */
  friction: number;
  /** 起爆までの時間 s（投擲時から） */
  fuseTime: number;
  /** 球半径 m（ドアのピーク隙間を通れる程度に小さく） */
  ballRadius: number;
  /** 床で静止とみなす速度 m/s */
  stopSpeed: number;
  /** 至近・正面・遮蔽なし時の白飛び時間 s */
  blindMaxSec: number;
  /** 範囲端での白飛び時間倍率 (0〜1) */
  falloffMin: number;
  /** 背後（視界外）を向いている時の白飛び時間倍率 (0〜1) */
  behindFactor: number;
  /** 白飛び後の残光時間 s（線形減衰） */
  afterglowSec: number;
  /** 残光開始時の不透明度 (0〜1) */
  afterglowOpacity: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  category: WeaponCategory;
  /** 装備スロット (1〜3) */
  slot: number;
  /** 1発のダメージ（非致死は 0 も可） */
  damage: number;
  /** 発/秒 */
  fireRate: number;
  magazineSize: number;
  reloadTime: number;
  range: number;
  /** 腰だめ拡散（度） */
  hipSpread: number;
  /** ADS 時拡散（度） */
  adsSpread: number;
  /** ADS 中の移動速度倍率 (0〜1) */
  adsMoveSpeedMultiplier: number;
  /** 移動時の拡散加算（度）。停止時は加算なし（ストッピング精度） */
  moveSpreadPenalty: number;
  /** 1発ごとの反動（度） */
  recoilPitch: number;
  recoilYawRange: number;
  /** 反動の回復速度（度/秒） */
  recoilRecovery: number;
  /** 命中時の士気低下量（非致死・投擲など。無ければ 0） */
  moraleDamage: number;
  /** 発射音の到達半径(m) */
  noiseRadius: number;
  /** category='throwable' のみ */
  throwable?: ThrowableDef;
  /** 使用陣営。省略時 'swat'（通常モード）。'suspect' は容疑者モード専用 */
  faction?: 'swat' | 'suspect';
  /** 予備マガジン数。指定時は弾数が有限（リロードで予備を消費）。省略時は無限 */
  reserveMagazines?: number;
}

export interface WeaponsData {
  weapons: WeaponDef[];
}

// ---------- AI ----------

export interface MoraleThresholds {
  /** この値未満で SURRENDER */
  surrenderBelow: number;
  /** この値未満で HESITATE（surrenderBelow 以上） */
  hesitateBelow: number;
}

export interface MoraleModifiers {
  /** 警告コールによる士気低下の範囲（正の値=低下量） */
  warningCall: { min: number; max: number };
  flashbang: { min: number; max: number };
  nonlethalHit: { min: number; max: number };
  breach: number;
  /** 同室の他容疑者が逮捕・無力化された時 */
  isolation: number;
}

/** 容疑者の戦闘系パラメータ（ai_profiles.json の profiles[].combat）。距離 m・速度 m/s・時間 s。 */
export interface CombatParams {
  /** CONFRONTATION で士気を再計算し次行動を決めるまでの時間 */
  decisionSec: number;
  /** ALERT で新たな音/視認が無いまま BARRICADED へ戻るまでの時間 */
  alertCalmSec: number;
  /** HESITATE を放置した場合に ENGAGE へ戻るまでの時間 */
  hesitateFireSec: number;
  hesitateRetreatSpeed: number;
  /** HESITATE で後退する最大距離 */
  hesitateRetreatMax: number;
  /** HESITATE の震え振幅（度） */
  hesitateShakeDeg: number;
  /** ENGAGE 時の移動速度 */
  moveSpeed: number;
  /** 射撃間隔 */
  fireInterval: number;
  /** 1 回のピークでの最大発砲数 */
  shotsPerPeek: number;
  magazineSize: number;
  reloadSec: number;
  /** 遮蔽物裏で待機する時間(最小/最大) */
  coverSecMin: number;
  coverSecMax: number;
  /** 1 回のピークの最大時間 */
  peekSecMax: number;
  /** 発砲可能な最大距離 */
  engageRange: number;
  /** 遮蔽物を探す最大距離 */
  coverSearchRange: number;
  /** 遮蔽物の縁からの退避余白 */
  coverMargin: number;
  /** この高さ未満の遮蔽物では屈んで隠れる */
  crouchCoverMaxHeight: number;
  /** 被弾時の怯み時間 */
  flinchSec: number;
  /** 発砲時の noise(kind:gunshot) 半径 */
  gunshotNoiseRadius: number;
  /** 1発のダメージ */
  shotDamage: number;
  /** 射撃時の基本拡散角度（度） */
  baseSpreadDeg: number;
  /** 投降放置時に武器を拾い直して反撃する確率 */
  fakeSurrenderChance?: number;
  /** 偽装投降の放置判定秒数 */
  fakeSurrenderSec?: number;
}

/** 人質盾（HOSTAGE_SHIELD）パラメータ（ai_profiles.json の profiles[].shield）。距離 m・速度 m/s・角度 度・時間 s。 */
export interface ShieldParams {
  /** 発動条件: 士気がこの値未満（=高ストレス）。surrenderBelow 未満は降伏が優先 */
  moraleBelow: number;
  /** 発動条件: 盾にできる民間人までの最大距離 */
  civilianRange: number;
  /** 発動条件: プレイヤー(把握位置)がこの距離以内 */
  playerRange: number;
  /** 脱出路判定: プレイヤーから離れる方向の探索距離 */
  escapeSearch: number;
  /** 脱出路判定: 現在位置よりプレイヤーから最低これだけ遠ざかれる直進路があれば脱出路あり */
  escapeMinGain: number;
  /** 発動判定の間隔 */
  checkIntervalSec: number;
  /** 発動失敗/解除後の再発動禁止時間 */
  retrySec: number;
  /** 民間人を掴むまでの接近の最大時間（超過で中止） */
  grabMaxSec: number;
  /** 掴んだとみなす距離 */
  grabRange: number;
  /** 容疑者→民間人の距離（盾を前面に保持する距離） */
  holdDistance: number;
  /** 盾の中心から容疑者を横にずらす量。頭が盾の脇から出る（安全な射撃角度が存在する） */
  headOffset: number;
  /** 盾がプレイヤー方向へ回り込む最大角速度（度/秒）。小さいほど側面を取りやすい */
  pivotDegPerSec: number;
  /** プレイヤーがこの距離以内なら後退して威嚇する */
  backAwayRange: number;
  backAwaySpeed: number;
  /** 盾を保持している間の民間人の体当たり半径（壁判定） */
  hostageRadius: number;
}

/** 容疑者の部屋間移動・巡回・調査・増援・フランク設定（ai_profiles.json の profiles[].mobility）。 */
export interface MobilityParams {
  /** 未施錠ドアを自動で開けて部屋間移動できるか */
  canOpenDoors: boolean;
  /** 階段を使って上下階へ移動できるか */
  canUseStairs: boolean;
  /** BARRICADED 時に別室へ巡回移動する確率 (0〜1) */
  patrolChance: number;
  /** 巡回開始までの待機時間・最小(秒) */
  patrolIntervalMin: number;
  /** 巡回開始までの待機時間・最大(秒) */
  patrolIntervalMax: number;
  /** 巡回時の移動速度倍率（combat.moveSpeed に対する倍率） */
  patrolSpeedScale: number;
  /** ALERT 時に音源位置へ調査移動する確率 (0〜1) */
  investigateChance: number;
  /** 調査移動を行う最大距離(m) */
  investigateMaxDist: number;
  /** 調査・増援時の移動速度倍率（combat.moveSpeed に対する倍率） */
  investigateSpeedScale: number;
  /** 銃声・ブリーチ音を聴いた際に増援として急行するか */
  reinforceOnGunshot: boolean;
  /** ENGAGE 中に視認喪失がこの秒数以上続いたら追撃・回り込み・再配置へ移行する */
  repositionAfterLostSec: number;
  /** 視認喪失時の再配置で回り込み（フランク）を選ぶ確率 (0〜1) */
  flankChance: number;
  /** 同室に未保護民間人がいる場合に離室を抑制するか */
  guardHostageRoom: boolean;
}

export interface AIProfile {
  id: string;
  name: string;
  type: EntityType;
  /** 初期士気 0〜100 */
  initialMorale: number;
  /** 士気の自然回復（/秒） */
  moraleRecovery: number;
  /** 攻撃性 0〜1（高いほど ENGAGE しやすい） */
  aggression: number;
  /** 反応時間（秒） */
  reactionTime: number;
  /** 聴覚半径の倍率 */
  hearingMultiplier: number;
  thresholds: MoraleThresholds;
  modifiers: MoraleModifiers;
  /** 戦闘系ステート(CONFRONTATION/HESITATE/ENGAGE)パラメータ。type='suspect' では必須 */
  combat?: CombatParams;
  /** 人質盾の設定（無ければ盾にしない） */
  shield?: ShieldParams;
  /** 部屋間移動・巡回・調査・増援・フランク設定。type='suspect' では必須 */
  mobility?: MobilityParams;
  /** 民間人FSMの設定。type='civilian' では必須 */
  civilian?: CivilianParams;
  /** 待ち伏せ（ファタルファネル）設定。type='suspect' で省略時は既定値が補われる */
  ambush?: AmbushParams;
}

/**
 * 待ち伏せ設定（ai_profiles.json の ambush）。BARRICADED/ALERT の容疑者が突入音を聞いたとき、
 * 室内の入口が見渡せる隅/遮蔽へ移動して照準を置き、入ってきた者へ極短の反応時間で初弾を撃つ。
 */
export interface AmbushParams {
  /** 待ち伏せ行動を選ぶ基礎確率 (0〜1)。実確率は aggression で補正される */
  chance: number;
  /** 照準済み（pre-aim）状態で入室者を視認してから撃ち始めるまでの反応時間（秒）。reactionTime の代わりに使う */
  preAimReactionSec: number;
  /** 最初のバースト（firstBurstShots 発）の拡散角に掛ける倍率（<1 で精度向上） */
  firstBurstSpreadMul: number;
  /** 待ち伏せ位置を探す・反応する最大距離(m) */
  maxDist: number;
  /** 待ち伏せを維持する最大秒数（音源が途絶えてからではなく ALERT 突入からの総時間） */
  holdSec: number;
  /** 初弾バーストの発数 */
  firstBurstShots: number;
  /** 照準方向（入口）を中心とした pre-aim 有効角（全角, 度） */
  coneDeg: number;
}

/** 民間人FSM（IDLE→PANIC→COMPLY→SHIELDED→SECURED）パラメータ。type='civilian' で必須。距離 m・速度 m/s・時間 s。 */
export interface CivilianParams {
  /** 銃声の聴取半径 = noise.radius × hearingMultiplier × この値 */
  gunshotHearScale: number;
  /** 壁越し（視線遮蔽）時に聴取半径へ掛ける倍率 */
  occludedScale: number;
  /** PANIC 時に刺激源から逃げる速度 */
  panicFleeSpeed: number;
  /** 逃げる時間（その後うずくまる） */
  panicFleeSec: number;
  /** SECURED 時の体の色 */
  securedTint: number;
}

export interface AIProfilesData {
  profiles: AIProfile[];
}

/** 起動時にロードする全データ。 */
/** プレイヤー移動パラメータ（public/data/player.json）。速度 m/s・半径 m・間隔 s。 */
export type MoveMode = 'run' | 'quiet' | 'crouch';

/** リーンパラメータ（player.json の lean）。距離 m・角度 度・速度 1/s。 */
export interface LeanConfig {
  maxOffset: number;
  maxRollDeg: number;
  lerpSpeed: number;
  /** 壁との最小クリアランス（頭の半径） */
  headRadius: number;
}

/** 警告コール(Space)パラメータ（player.json の warning）。距離 m・角度 度・時間 s。 */
export interface WarningConfig {
  /** 警告が届く最大距離 */
  range: number;
  /** 視線方向を中心とした有効視野角（全角） */
  coneDeg: number;
  /** 再発声までの間隔 */
  cooldown: number;
  /** 字幕の表示時間 */
  subtitleSec: number;
  text: string;
  /** noise(kind:'voice') の半径 */
  noiseRadius: number;
}

/** 逮捕・証拠回収(F長押し)パラメータ（player.json の arrest）。距離 m・角度 度・時間 s。 */
export interface ArrestConfig {
  range: number;
  coneDeg: number;
  /** 拘束ゲージが満ちる長押し時間 */
  holdSec: number;
  /** 証拠（落とした武器）回収が可能な距離 */
  evidenceRange: number;
  evidenceHoldSec: number;
  arrestText: string;
  evidenceText: string;
  /** 民間人保護（COMPLY の民間人へ F 長押し→SECURED） */
  civilianRange: number;
  civilianHoldSec: number;
  civilianText: string;
  /** 容疑者逮捕・民間人保護時に無線報告 SE が鳴る確率 (0..1) */
  radioReportChance?: number;
}

export interface PlayerConfig {
  maxHp: number;
  adsFovDeg: number;
  adsLerpSpeed: number;
  arrest: ArrestConfig;
  warning: WarningConfig;
  radius: number;
  standEyeHeight: number;
  crouchEyeHeight: number;
  eyeHeightLerpSpeed: number;
  mouseSensitivity: number;
  maxPitchDeg: number;
  lean: LeanConfig;
  speeds: Record<MoveMode, number>;
  footstep: {
    interval: Record<MoveMode, number>;
    radius: Record<MoveMode, number>;
  };
  /** 負傷モデル（SWAT モードのみ有効） */
  wounds: WoundsConfig;
  /** オプティワンド（鏡/ファイバースコープ型カメラ） */
  optiwand: OptiwandConfig;
}

/** 負傷モデル（player.json の wounds）。HP 比率・倍率・度は無次元/度。 */
export interface WoundsConfig {
  /** 頭部被弾の与ダメージ倍率 */
  headMultiplier: number;
  /** 目線からこの距離(m)以内の高さへの命中を頭部とみなす */
  headBand: number;
  /** 負傷 Lv1 になる HP 比率（これ未満） */
  lv1Below: number;
  /** 負傷 Lv2（重傷）になる HP 比率（これ未満） */
  lv2Below: number;
  /** 負傷レベル別（Lv1, Lv2）の移動速度倍率 */
  speedMul: [number, number];
  /** 負傷レベル別（Lv1, Lv2）の射撃拡散加算(度) */
  spreadAddDeg: [number, number];
  /** 負傷レベル別（Lv1, Lv2）の視点の揺れ振幅(度) */
  swayDeg: [number, number];
}

/** オプティワンド（player.json の optiwand）。距離 m・角度 度・時間 s。 */
export interface OptiwandConfig {
  /** 展開にかかる時間 */
  deploySec: number;
  /** 通常時に目線から先端までの距離 */
  reach: number;
  /** 壁との最小クリアランス */
  wallClearance: number;
  /** ドアの下に差し込めるドア中心からプレイヤー目線までの距離 */
  doorRange: number;
  /** 床からのカメラ高 (min, max) */
  doorCamHeight: [number, number];
  /** ドア板の向こう側へ出す距離 */
  doorCamPastPlane: number;
  /** ドア下カメラの首振り範囲（±度） */
  yawLimitDeg: number;
  /** ドア下カメラのピッチ範囲 (min, max) 度 */
  pitchLimitDeg: [number, number];
  /** カメラ視野角（垂直, 度） */
  fovDeg: number;
  /** 視認できる最大距離 */
  viewRange: number;
  /** 「発見」と判定するまでの連続視認秒 */
  spotSec: number;
  /** 部屋を「確認済み」にするまでのカメラ滞在秒（人物が映らなくても） */
  scoutDwellSec: number;
  /** 容疑者がワンド先端に気付く距離 */
  noticeRange: number;
  /** 気付かれる確率（/秒、正面を向いている容疑者のみ） */
  noticePerSec: number;
  /** ドア下カメラ使用時の気付かれにくさ倍率 */
  noticeUnderDoorMul: number;
  /** 画面幅に対する PiP の幅比率 */
  viewWidthRatio: number;
  /** PiP のレンダ解像度 (幅, 高さ) */
  renderSize: [number, number];
}

/** ドア共通パラメータ（public/data/doors.json）。角度 度・長さ m・速度 度/秒。 */
export interface DoorConfig {
  /** ピーク（隙間覗き）角度。15〜25 推奨。maxAngle を超えない */
  peekAngle: number;
  thickness: number;
  /** ドア高さ(m)。天井高を超えない */
  height: number;
  /** ドア枠（ジャム・上枠）の厚み(m)。省略時 0.055 */
  frameThickness?: number;
  /** ドア枠の壁厚方向の奥行き(m)。省略時 0.30 */
  frameDepth?: number;
  /** 額縁ケーシングの幅(m)。省略時 0.075 */
  casingWidth?: number;
  /** 額縁ケーシングの壁面からの突出(m)。省略時 0.018 */
  casingDepth?: number;
  /** レバーハンドルの床からの高さ(m)。省略時 0.98 */
  handleHeight?: number;
  /** 衝突用に扉板を分割するセグメント長(m)。小さいほど回転時の近似が正確 */
  segmentLength: number;
  /** 通常の開閉速度 */
  swingSpeed: number;
  /** ドアノブ付近で操作した時の速度倍率 */
  knobSpeedMultiplier: number;
  /** 扉の自由端からこの距離(m)以内を狙って操作するとノブ操作（速い） */
  knobZone: number;
  /** F / ホイール操作の届く距離(m) */
  interactRange: number;
  /** ホイール deltaY 累積がこの値を超えると 1 段階 */
  wheelStepThreshold: number;
  noise: { slowRadius: number; fastRadius: number };
  /** ブリーチング(G): speedMultiplier=swingSpeed 倍率 / noiseRadius=音 / effectRadius=室内動揺の影響半径 */
  breach: { speedMultiplier: number; noiseRadius: number; effectRadius: number };
}

/** 評価項目キー（public/data/roe.json の points / labels と対応） */
export type ScoreKind =
  | 'arrest'
  | 'civilianSecured'
  | 'evidence'
  | 'neutralize'
  | 'fireWithoutWarning'
  | 'fireOnSurrendered'
  | 'civilianHit'
  | 'nonlethalCivilianHit'
  | 'friendlyFire'
  | 'allyDown'
  | 'playerInjury';

export interface RankRule {
  minScore: number;
  /** 最大スコアに対する到達率（例: 0.85 = 85%）。指定時は maxPossibleScore * minRatio を閾値として使用 */
  minRatio?: number;
  label: string;
}

/** 交戦規定・スコア設定（public/data/roe.json） */
export interface RoeConfig {
  points: Record<ScoreKind, number>;
  labels: Record<ScoreKind, string>;
  /** true: 同一 (違反種別, 対象) の違反は 1 回だけ減点 */
  violationOncePerTarget: boolean;
  /** これらの SuspectState に入った容疑者は「敵対行動あり」とみなし、反撃を正当防衛とする */
  hostileStates: string[];
  /** minScore / minRatio 降順。先頭から最初に条件を満たすランクを採用 */
  ranks: RankRule[];
}

/** 知覚パラメータ（public/data/perception.json）。距離 m・角度 度・時間 s。 */
export interface PerceptionConfig {
  hearing: {
    /** 音源との間に遮蔽(壁/閉じたドア)がある時の半径倍率（1=遮蔽無視） */
    occludedMultiplier: number;
    /** 発生源が遮蔽物(ドア板)自身のため遮蔽判定を行わない noise 種別 */
    unoccludedKinds: string[];
    /** noise の種別ごとの半径倍率 */
    kinds: Record<string, number>;
  };
  vision: {
    /** 通常時の視野角（全角） */
    fovDeg: number;
    /** 視認可能な最大距離 */
    range: number;
    /** ALERT 中の視野角（全角、音源方向を向いている） */
    alertFovDeg: number;
    /** 容疑者の目の高さ */
    eyeHeight: number;
    /** 胴体判定点の目からの下げ幅（リーンで頭だけ出ても目の点が見える） */
    bodyPointDrop: number;
    /** しゃがみ中の視認距離倍率 */
    crouchRangeMultiplier: number;
    /** ALERT 中は reactionTime にこの倍率を掛ける（短縮） */
    alertReactionMultiplier: number;
  };
}

export type SquadOrder =
  | 'follow'
  | 'hold'
  | 'move'
  | 'overwatch'
  | 'stack'
  | 'clear'
  | 'flashClear'
  | 'breachClear'
  | 'c2Clear'
  | 'gasClear'
  | 'pieDoor'
  | 'restrain'
  | 'mirror';

export type SquadElement = 'gold' | 'alpha' | 'bravo';

/** 仲間AI（public/data/squad.json）。距離 m・速度 m/s・時間 s。 */
export interface SquadConfig {
  moveSpeed: number;
  followDistance: number;
  followLateral: number;
  stackOffset: number;
  clearDepth: number;
  clearLateral: number;
  staggerSec: number;
  dominationDepth: number;
  dominationLateral: number;
  presenceBonusPerAlly: number;
  personalSpace: number;
  arriveDistance: number;
  engageRange: number;
  fireInterval: number;
  damage: number;
  warningInterval: number;
  flashDelay: number;
  bodyRadius: number;
  eyeHeight: number;
  /** これ未満の開きでは開口を通らない（度） */
  doorOpenAngle: number;
  stairArrive: number;
  /** 停滞がこの秒数続いたら経路を破棄して再探索する（s） */
  stuckResetSec: number;
  /** 停滞がこの秒数続いたらめり込み脱出・近傍自由点復帰を試みる（s） */
  stuckRecoverSec: number;
  /** 階段昇降中に停滞がこの秒数続いたら昇降状態を解除する（s） */
  stairStallResetSec: number;
  /** 階段退出点に到達したとみなす水平距離（m） */
  stairExitRadius: number;
  /** スタック整列待ちの最大待機時間（s）。超過で到着済み隊員が突入開始 */
  stackWaitTimeoutSec: number;
  /** 経路上のドア開放待ちの上限時間（s）。超過でそのドアを一時スキップし再探索 */
  doorOpenTimeoutSec: number;
  /** 発砲してよい SuspectState */
  hostileStates: string[];
  /** 警告コールを出す SuspectState */
  warnStates: string[];
  /** HUD に出す操作説明 */
  hint: string;
  /** ミラー確認（隊員がドア下からオプティワンドで確認）の設定 */
  mirror: MirrorConfig;
  /** 隊員の負傷モデル */
  wounds: AllyWoundsConfig;
  orderLabels: Record<SquadOrder, string>;
  elementLabels: Record<SquadElement, string>;
}

/** 隊員の負傷モデル（squad.json の wounds）。 */
export interface AllyWoundsConfig {
  /** 頭部被弾（身長の 82% 以上）のダメージ倍率 */
  headMultiplier: number;
  /** HP がこの比率未満で「負傷」扱い */
  woundBelow: number;
  /** 負傷時の移動速度倍率 */
  speedMul: number;
}

/** 隊員のミラー確認（squad.json の mirror）。 */
export interface MirrorConfig {
  /** 確認にかかる秒数（隊員は静止） */
  durationSec: number;
  /** 視線中心線から離れた接触を見落とす確率 */
  missChance: number;
  /** 「視線中心線の近く」とみなす横距離(m) */
  centerBandM: number;
  /** ミラーの有効半視野角(度) */
  halfFovDeg: number;
  /** 確認できる最大距離(m) */
  range: number;
}

export interface GameData {
  perception: PerceptionConfig;
  roe: RoeConfig;
  player: PlayerConfig;
  doors: DoorConfig;
  map: MapData;
  weapons: WeaponDef[];
  aiProfiles: AIProfile[];
  squad: SquadConfig;
}
