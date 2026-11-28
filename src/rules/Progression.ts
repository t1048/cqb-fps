import type { MotifId } from '../core/types';

/** ゲームモード（SWAT / 容疑者） */
export type GameMode = 'swat' | 'suspect';

/** ステージ ID */
export type StageId = 'random_small' | 'random_house' | 'random_embassy';

/** ミッション評価ランク */
export type RankGrade = 'S' | 'A' | 'B' | 'C' | 'D';

/** SWAT プライマリ武器 ID（weapons.json と対応） */
export type SwatPrimaryWeaponId = 'rifle' | 'smg' | 'suppressed_rifle' | 'shotgun';
export const SWAT_PRIMARY_WEAPON_IDS: readonly SwatPrimaryWeaponId[] = [
  'rifle',
  'smg',
  'suppressed_rifle',
  'shotgun',
] as const;

/** 容疑者プライマリ武器 ID（weapons.json と対応） */
export type SuspectPrimaryWeaponId = 'machine_pistol' | 'suspect_smg' | 'suspect_shotgun' | 'suspect_ar';
export const SUSPECT_PRIMARY_WEAPON_IDS: readonly SuspectPrimaryWeaponId[] = [
  'machine_pistol',
  'suspect_smg',
  'suspect_shotgun',
  'suspect_ar',
] as const;

/** SWAT ベスト種別 */
export type SwatVestTier = 'light' | 'standard' | 'heavy';
export const SWAT_VEST_TIERS: readonly SwatVestTier[] = ['light', 'standard', 'heavy'] as const;

/** 容疑者ベスト種別 */
export type SuspectVestTier = 'none' | 'light' | 'standard' | 'heavy';
export const SUSPECT_VEST_TIERS: readonly SuspectVestTier[] = ['none', 'light', 'standard', 'heavy'] as const;

/** SWAT 分隊員 1 名ごとの武器種別 */
export type SquadMemberWeaponId = 'rifle' | 'smg' | 'suppressed_rifle' | 'shotgun' | 'pepperball' | 'shield';
export const SQUAD_MEMBER_WEAPON_IDS: readonly SquadMemberWeaponId[] = [
  'rifle',
  'smg',
  'suppressed_rifle',
  'shotgun',
  'pepperball',
  'shield',
] as const;

/** 容疑者 NPC 仲間の方針 */
export type SuspectAllyPolicy = 'balanced' | 'aggressive' | 'fortify';
export const SUSPECT_ALLY_POLICIES: readonly SuspectAllyPolicy[] = ['balanced', 'aggressive', 'fortify'] as const;

/** SWAT 側交渉カード ID */
export type SwatNegotiationCardId = 'trust' | 'release_hostage' | 'persuade_surrender' | 'intel' | 'ultimatum';

/** 容疑者側交渉カード ID */
export type SuspectNegotiationCardId =
  | 'stall'
  | 'supplies'
  | 'trade_ammo'
  | 'trade_medkit'
  | 'trade_time'
  | 'trade_vest'
  | 'rally'
  | 'threaten';

/** 容疑者モードの補強・罠アンロック状態（FortifyDeps と接続） */
export interface FortifyUnlocks {
  /** Lv.1: ドア施錠 */
  doorLock: boolean;
  /** Lv.2: 窓バリケード */
  windowBarricade: boolean;
  /** Lv.3: ドア・ブービートラップ */
  doorTrap: boolean;
  /** Lv.4: ドアなし開口（アーチ）の完全板バリケード */
  archPlankBarricade: boolean;
  /** Lv.5: 一方通行バリケード（容疑者側のみ通過可、SWAT は破壊/ブリーチ必須） */
  archOneWayBarricade: boolean;
}

/** SWAT 分隊員 1 名分の装備設定 */
export interface SquadMemberLoadout {
  weapon: SquadMemberWeaponId;
  vest: SwatVestTier;
  /** この隊員が携行するフラッシュバン数（Lv.4 以降で個別変更可） */
  flashbangs: number;
  /** この隊員が携行する CS ガス弾数（Lv.4 以降で個別変更可） */
  gas: number;
}

/** SWAT モードのプレイヤー＋分隊ロードアウト */
export interface SwatLoadout {
  primaryWeapon: SwatPrimaryWeaponId;
  vest: SwatVestTier;
  squad: [SquadMemberLoadout, SquadMemberLoadout, SquadMemberLoadout, SquadMemberLoadout];
}

/** 容疑者モードのプレイヤー＋仲間方針ロードアウト */
export interface SuspectLoadout {
  primaryWeapon: SuspectPrimaryWeaponId;
  vest: SuspectVestTier;
  allyPolicy: SuspectAllyPolicy;
}

export interface PlayerLoadouts {
  swat: SwatLoadout;
  suspect: SuspectLoadout;
}

export interface ModeProgress {
  xp: number;
  level: number;
  clears: number;
  attempts: number;
  bestRank: RankGrade | null;
}

export interface ProgressionState {
  version: 1;
  /** サンドボックス設定: true で全要素を即時解放 */
  unlockAll: boolean;
  swat: ModeProgress;
  suspect: ModeProgress;
  loadouts: PlayerLoadouts;
}

export interface UnlockEntry {
  id: string;
  mode: GameMode;
  level: number;
  labelJa: string;
  labelEn: string;
}

export interface SwatUnlocks {
  level: number;
  suspectMode: boolean;
  stages: Record<StageId, boolean>;
  /** Lv.1 のみ ['residence', 'japanese_house']、Lv.2+ は undefined（全モチーフ解放） */
  allowedSmallMotifs: readonly MotifId[] | undefined;
  stealthEntry: boolean;
  weapons: Record<SwatPrimaryWeaponId, boolean>;
  vests: Record<SwatVestTier, boolean>;
  teargas: boolean;
  optiwand: boolean;
  c2Breach: boolean;
  shieldMember: boolean;
  squadLoadoutCustom: boolean;
  squadGadgetCustom: boolean;
  negotiationCards: Record<SwatNegotiationCardId, boolean>;
}

export interface SuspectUnlocks {
  level: number;
  stages: Record<StageId, boolean>;
  /** Lv.1 のみ ['residence', 'japanese_house']、Lv.2+ は undefined（全モチーフ解放） */
  allowedSmallMotifs: readonly MotifId[] | undefined;
  weapons: Record<SuspectPrimaryWeaponId, boolean>;
  vests: Record<SuspectVestTier, boolean>;
  allyPolicyCustom: boolean;
  fortify: FortifyUnlocks;
  negotiationCards: Record<SuspectNegotiationCardId, boolean>;
}

export interface MissionResultInput {
  mode: GameMode;
  cleared: boolean;
  rank: RankGrade | string;
  score: number;
  stageId?: string;
}

export interface ProgressionReward {
  mode: GameMode;
  xpGained: number;
  prevLevel: number;
  newLevel: number;
  leveledUp: boolean;
  prevXp: number;
  newXp: number;
  nextLevelXp: number | null;
  unlockedItems: UnlockEntry[];
}

export const PROGRESSION_STORAGE_KEY = 'cqb.progression.v1';
export const MAX_PROGRESSION_LEVEL = 5;

/** Lv.1〜Lv.5 に必要な累積 XP。Lv.2 = 100（SWAT 初回クリアで必ず到達） */
export const LEVEL_XP_THRESHOLDS = [0, 100, 260, 480, 760] as const;

/** Lv.1 の小マップで許可されるモチーフ */
export const LV1_SMALL_MOTIFS: readonly MotifId[] = ['residence', 'japanese_house'] as const;

const RANK_ORDER: Record<RankGrade, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 };
const CLEAR_RANK_BONUS_XP: Record<RankGrade, number> = { S: 80, A: 55, B: 35, C: 20, D: 10 };
const STAGE_CLEAR_BONUS_XP: Record<string, number> = {
  random_small: 0,
  random_house: 30,
  random_embassy: 60,
};

/** 各モード・レベルで新たに解放される項目のマスター一覧 */
export const UNLOCK_ROADMAP: readonly UnlockEntry[] = [
  // SWAT Lv.2
  { id: 'mode:suspect', mode: 'swat', level: 2, labelJa: '容疑者モード解放', labelEn: 'Suspect Mode Unlocked' },
  { id: 'motifs:small_all', mode: 'swat', level: 2, labelJa: '小マップ全モチーフ解放', labelEn: 'All Small Map Motifs' },
  { id: 'weapon:smg', mode: 'swat', level: 2, labelJa: '短機関銃 (SMG)', labelEn: 'Submachine Gun (SMG)' },
  { id: 'vest:light', mode: 'swat', level: 2, labelJa: '軽量ベスト', labelEn: 'Light Vest' },
  { id: 'gadget:teargas', mode: 'swat', level: 2, labelJa: 'CS ガス弾', labelEn: 'CS Tear Gas' },
  { id: 'gadget:optiwand', mode: 'swat', level: 2, labelJa: 'オプティワンド', labelEn: 'Optiwand' },
  { id: 'neg:intel', mode: 'swat', level: 2, labelJa: '交渉カード: 内部の様子を聞き出す', labelEn: 'Negotiation: Gather Intel' },

  // SWAT Lv.3
  { id: 'stage:random_house', mode: 'swat', level: 3, labelJa: '中規模マップ解放', labelEn: 'Medium Map Unlocked' },
  { id: 'entry:stealth', mode: 'swat', level: 3, labelJa: 'ステルス突入モード', labelEn: 'Stealth Entry Mode' },
  { id: 'breach:c2', mode: 'swat', level: 3, labelJa: 'C2 爆破ブリーチング', labelEn: 'C2 Explosive Breaching' },
  { id: 'weapon:suppressed_rifle', mode: 'swat', level: 3, labelJa: '消音カービン', labelEn: 'Suppressed Carbine' },
  { id: 'squad:shield', mode: 'swat', level: 3, labelJa: '盾持ち隊員 & 分隊装備カスタム', labelEn: 'Shield Member & Squad Loadout' },
  { id: 'neg:ultimatum', mode: 'swat', level: 3, labelJa: '交渉カード: 最後通告', labelEn: 'Negotiation: Ultimatum' },

  // SWAT Lv.4
  { id: 'weapon:shotgun', mode: 'swat', level: 4, labelJa: 'ショットガン', labelEn: 'Tactical Shotgun' },
  { id: 'vest:heavy', mode: 'swat', level: 4, labelJa: '重装ベスト', labelEn: 'Heavy Vest' },
  { id: 'squad:gadgets', mode: 'swat', level: 4, labelJa: '分隊ガジェット個別カスタム', labelEn: 'Full Squad Gadget Customization' },

  // SWAT Lv.5
  { id: 'stage:random_embassy', mode: 'swat', level: 5, labelJa: '大規模マップ解放', labelEn: 'Large Map Unlocked' },

  // Suspect Lv.2
  { id: 'motifs:small_all', mode: 'suspect', level: 2, labelJa: '小マップ全モチーフ解放', labelEn: 'All Small Map Motifs' },
  { id: 'fortify:window', mode: 'suspect', level: 2, labelJa: '窓バリケード', labelEn: 'Window Barricade' },
  { id: 'weapon:suspect_smg', mode: 'suspect', level: 2, labelJa: '密輸 SMG', labelEn: 'Smuggled SMG' },
  { id: 'vest:light_standard', mode: 'suspect', level: 2, labelJa: 'ベスト選択（軽量・標準）', labelEn: 'Vest Selection (Light / Standard)' },
  { id: 'neg:trade_vest', mode: 'suspect', level: 2, labelJa: '交渉カード: 防弾チョッキ交換', labelEn: 'Negotiation: Trade Body Armor' },
  { id: 'neg:rally', mode: 'suspect', level: 2, labelJa: '交渉カード: 仲間を鼓舞', labelEn: 'Negotiation: Rally Crew' },

  // Suspect Lv.3
  { id: 'stage:random_house', mode: 'suspect', level: 3, labelJa: '中規模マップ解放', labelEn: 'Medium Map Unlocked' },
  { id: 'fortify:trap', mode: 'suspect', level: 3, labelJa: 'ドア・ブービートラップ', labelEn: 'Door Booby Trap' },
  { id: 'weapon:suspect_shotgun', mode: 'suspect', level: 3, labelJa: 'ソードオフ・ショットガン', labelEn: 'Sawed-off Shotgun' },
  { id: 'ally:policy', mode: 'suspect', level: 3, labelJa: '仲間の方針選択（標準/攻撃/籠城）', labelEn: 'Ally Policy (Balanced/Aggressive/Fortify)' },
  { id: 'neg:threaten', mode: 'suspect', level: 3, labelJa: '交渉カード: 包囲を脅迫', labelEn: 'Negotiation: Threaten Perimeter' },

  // Suspect Lv.4
  { id: 'fortify:arch_plank', mode: 'suspect', level: 4, labelJa: 'アーチ完全板バリケード', labelEn: 'Arch Full-Plank Barricade' },
  { id: 'weapon:suspect_ar', mode: 'suspect', level: 4, labelJa: '軍用アサルトライフル', labelEn: 'Military Assault Rifle' },
  { id: 'vest:heavy', mode: 'suspect', level: 4, labelJa: '重装ベスト', labelEn: 'Heavy Vest' },

  // Suspect Lv.5
  { id: 'stage:random_embassy', mode: 'suspect', level: 5, labelJa: '大規模マップ解放', labelEn: 'Large Map Unlocked' },
  { id: 'fortify:arch_oneway', mode: 'suspect', level: 5, labelJa: '一方通行バリケード', labelEn: 'One-Way Barricade' },
] as const;

export function normalizeRank(rank: string): RankGrade {
  if (rank === 'S' || rank === 'A' || rank === 'B' || rank === 'C' || rank === 'D') return rank;
  return 'D';
}

export function levelForXp(xp: number): number {
  const safe = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;
  let lv = 1;
  for (let i = 1; i < LEVEL_XP_THRESHOLDS.length; i++) {
    if (safe >= LEVEL_XP_THRESHOLDS[i]!) lv = i + 1;
  }
  return Math.min(MAX_PROGRESSION_LEVEL, lv);
}

export function xpForNextLevel(level: number): number | null {
  if (level >= MAX_PROGRESSION_LEVEL) return null;
  return LEVEL_XP_THRESHOLDS[Math.max(1, Math.min(MAX_PROGRESSION_LEVEL - 1, level))] ?? null;
}

export function xpProgressInLevel(xp: number): {
  level: number;
  current: number;
  required: number;
  ratio: number;
  isMax: boolean;
} {
  const safe = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;
  const level = levelForXp(safe);
  if (level >= MAX_PROGRESSION_LEVEL) {
    return { level, current: 1, required: 1, ratio: 1, isMax: true };
  }
  const floor = LEVEL_XP_THRESHOLDS[level - 1] ?? 0;
  const next = LEVEL_XP_THRESHOLDS[level] ?? floor + 100;
  const required = Math.max(1, next - floor);
  const current = Math.max(0, safe - floor);
  return { level, current, required, ratio: Math.min(1, current / required), isMax: false };
}

export function calculateMissionXp(input: MissionResultInput): number {
  const rank = normalizeRank(input.rank);
  const safeScore = Number.isFinite(input.score) ? input.score : 0;
  if (input.cleared) {
    const base = 100;
    const rankBonus = CLEAR_RANK_BONUS_XP[rank];
    const stageBonus = input.stageId ? (STAGE_CLEAR_BONUS_XP[input.stageId] ?? 0) : 0;
    return base + rankBonus + stageBonus;
  }
  // 失敗時でも少しずつ経験値が入る（詰み防止）
  const participation = 25;
  const progressBonus = safeScore > 0 ? Math.min(20, Math.floor(safeScore / 25)) : 0;
  return participation + progressBonus;
}

export function createDefaultSquadMemberLoadout(): SquadMemberLoadout {
  return { weapon: 'rifle', vest: 'standard', flashbangs: 1, gas: 0 };
}

export function createDefaultSwatLoadout(): SwatLoadout {
  return {
    primaryWeapon: 'rifle',
    vest: 'standard',
    squad: [
      createDefaultSquadMemberLoadout(),
      createDefaultSquadMemberLoadout(),
      createDefaultSquadMemberLoadout(),
      createDefaultSquadMemberLoadout(),
    ],
  };
}

export function createDefaultSuspectLoadout(): SuspectLoadout {
  return {
    primaryWeapon: 'machine_pistol',
    vest: 'none',
    allyPolicy: 'balanced',
  };
}

function createDefaultModeProgress(): ModeProgress {
  return { xp: 0, level: 1, clears: 0, attempts: 0, bestRank: null };
}

export function createDefaultProgression(): ProgressionState {
  return {
    version: 1,
    unlockAll: false,
    swat: createDefaultModeProgress(),
    suspect: createDefaultModeProgress(),
    loadouts: {
      swat: createDefaultSwatLoadout(),
      suspect: createDefaultSuspectLoadout(),
    },
  };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

function sanitizeModeProgress(raw: unknown): ModeProgress {
  const def = createDefaultModeProgress();
  if (!raw || typeof raw !== 'object') return def;
  const o = raw as Record<string, unknown>;
  const xp = clampInt(o.xp, 0, 1_000_000, 0);
  const level = levelForXp(xp);
  const clears = clampInt(o.clears, 0, 1_000_000, 0);
  const attempts = Math.max(clears, clampInt(o.attempts, 0, 1_000_000, 0));
  const bestRank: RankGrade | null =
    o.bestRank === 'S' || o.bestRank === 'A' || o.bestRank === 'B' || o.bestRank === 'C' || o.bestRank === 'D'
      ? o.bestRank
      : null;
  return { xp, level, clears, attempts, bestRank };
}

function sanitizeSquadMember(raw: unknown): SquadMemberLoadout {
  const def = createDefaultSquadMemberLoadout();
  if (!raw || typeof raw !== 'object') return def;
  const o = raw as Record<string, unknown>;
  const weapon = (SQUAD_MEMBER_WEAPON_IDS as readonly string[]).includes(String(o.weapon))
    ? (o.weapon as SquadMemberWeaponId)
    : def.weapon;
  const vest = (SWAT_VEST_TIERS as readonly string[]).includes(String(o.vest))
    ? (o.vest as SwatVestTier)
    : def.vest;
  const flashbangs = clampInt(o.flashbangs, 0, 4, def.flashbangs);
  const gas = clampInt(o.gas, 0, 4, def.gas);
  return { weapon, vest, flashbangs, gas };
}

function sanitizeSwatLoadout(raw: unknown): SwatLoadout {
  const def = createDefaultSwatLoadout();
  if (!raw || typeof raw !== 'object') return def;
  const o = raw as Record<string, unknown>;
  const primaryWeapon = (SWAT_PRIMARY_WEAPON_IDS as readonly string[]).includes(String(o.primaryWeapon))
    ? (o.primaryWeapon as SwatPrimaryWeaponId)
    : def.primaryWeapon;
  const vest = (SWAT_VEST_TIERS as readonly string[]).includes(String(o.vest))
    ? (o.vest as SwatVestTier)
    : def.vest;
  const rawSquad = Array.isArray(o.squad) ? o.squad : [];
  const squad: SwatLoadout['squad'] = [
    sanitizeSquadMember(rawSquad[0]),
    sanitizeSquadMember(rawSquad[1]),
    sanitizeSquadMember(rawSquad[2]),
    sanitizeSquadMember(rawSquad[3]),
  ];
  return { primaryWeapon, vest, squad };
}

function sanitizeSuspectLoadout(raw: unknown): SuspectLoadout {
  const def = createDefaultSuspectLoadout();
  if (!raw || typeof raw !== 'object') return def;
  const o = raw as Record<string, unknown>;
  const primaryWeapon = (SUSPECT_PRIMARY_WEAPON_IDS as readonly string[]).includes(String(o.primaryWeapon))
    ? (o.primaryWeapon as SuspectPrimaryWeaponId)
    : def.primaryWeapon;
  const vest = (SUSPECT_VEST_TIERS as readonly string[]).includes(String(o.vest))
    ? (o.vest as SuspectVestTier)
    : def.vest;
  const allyPolicy = (SUSPECT_ALLY_POLICIES as readonly string[]).includes(String(o.allyPolicy))
    ? (o.allyPolicy as SuspectAllyPolicy)
    : def.allyPolicy;
  return { primaryWeapon, vest, allyPolicy };
}

function sanitizeProgression(raw: unknown): ProgressionState {
  const def = createDefaultProgression();
  if (!raw || typeof raw !== 'object') return def;
  const o = raw as Record<string, unknown>;
  const loadoutsRaw = o.loadouts && typeof o.loadouts === 'object' ? (o.loadouts as Record<string, unknown>) : {};
  return {
    version: 1,
    unlockAll: typeof o.unlockAll === 'boolean' ? o.unlockAll : false,
    swat: sanitizeModeProgress(o.swat),
    suspect: sanitizeModeProgress(o.suspect),
    loadouts: {
      swat: sanitizeSwatLoadout(loadoutsRaw.swat),
      suspect: sanitizeSuspectLoadout(loadoutsRaw.suspect),
    },
  };
}

export type ProgressionListener = (state: Readonly<ProgressionState>, prev: Readonly<ProgressionState>) => void;

let current: ProgressionState | null = null;
const listeners = new Set<ProgressionListener>();

function hasBrowserStorage(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
  } catch {
    return false;
  }
}

function checkUrlUnlockAllFlag(): boolean {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('unlockAll') === '1' || params.get('unlockAll') === 'true';
  } catch {
    return false;
  }
}

function loadFromStorage(): ProgressionState {
  const defaults = createDefaultProgression();
  try {
    if (!hasBrowserStorage()) return defaults;
    const raw = window.localStorage.getItem(PROGRESSION_STORAGE_KEY);
    if (!raw) {
      if (checkUrlUnlockAllFlag()) defaults.unlockAll = true;
      return defaults;
    }
    const parsed = sanitizeProgression(JSON.parse(raw));
    if (checkUrlUnlockAllFlag()) parsed.unlockAll = true;
    return parsed;
  } catch {
    return defaults;
  }
}

function saveToStorage(state: ProgressionState): void {
  try {
    if (!hasBrowserStorage()) return;
    window.localStorage.setItem(PROGRESSION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // プライベートモードや容量制限時はメモリ保持のみ
  }
}

function cloneState(s: ProgressionState): ProgressionState {
  return {
    version: 1,
    unlockAll: s.unlockAll,
    swat: { ...s.swat },
    suspect: { ...s.suspect },
    loadouts: {
      swat: {
        primaryWeapon: s.loadouts.swat.primaryWeapon,
        vest: s.loadouts.swat.vest,
        squad: [
          { ...s.loadouts.swat.squad[0] },
          { ...s.loadouts.swat.squad[1] },
          { ...s.loadouts.swat.squad[2] },
          { ...s.loadouts.swat.squad[3] },
        ],
      },
      suspect: { ...s.loadouts.suspect },
    },
  };
}

function commit(next: ProgressionState, prev: ProgressionState): Readonly<ProgressionState> {
  current = next;
  saveToStorage(next);
  for (const fn of listeners) fn(next, prev);
  return next;
}

export function getProgression(): Readonly<ProgressionState> {
  if (!current) current = loadFromStorage();
  return current;
}

export function isUnlockAll(state: Readonly<ProgressionState> = getProgression()): boolean {
  return state.unlockAll;
}

export function setUnlockAll(enabled: boolean): Readonly<ProgressionState> {
  const prev = cloneState(getProgression() as ProgressionState);
  const next = cloneState(prev);
  next.unlockAll = Boolean(enabled);
  return commit(next, prev);
}

export function resetProgression(): Readonly<ProgressionState> {
  const prev = cloneState(getProgression() as ProgressionState);
  const next = createDefaultProgression();
  return commit(next, prev);
}

export function getUnlocksForLevel(mode: GameMode, level: number): UnlockEntry[] {
  return UNLOCK_ROADMAP.filter((u) => u.mode === mode && u.level === level);
}

export function getNextUnlockPreview(
  mode: GameMode,
  state: Readonly<ProgressionState> = getProgression(),
): UnlockEntry[] {
  const effLv = state.unlockAll ? MAX_PROGRESSION_LEVEL : state[mode].level;
  if (effLv >= MAX_PROGRESSION_LEVEL) return [];
  return getUnlocksForLevel(mode, effLv + 1);
}

export function recordMissionResult(input: MissionResultInput): ProgressionReward {
  const prev = cloneState(getProgression() as ProgressionState);
  const next = cloneState(prev);
  const prog = next[input.mode];
  const prevXp = prog.xp;
  const prevLevel = prog.level;
  const xpGained = calculateMissionXp(input);
  const rank = normalizeRank(input.rank);

  prog.attempts += 1;
  if (input.cleared) {
    prog.clears += 1;
    if (!prog.bestRank || RANK_ORDER[rank] > RANK_ORDER[prog.bestRank]) {
      prog.bestRank = rank;
    }
  }
  prog.xp = prevXp + xpGained;
  prog.level = levelForXp(prog.xp);

  const unlockedItems: UnlockEntry[] = [];
  if (prog.level > prevLevel) {
    for (let lv = prevLevel + 1; lv <= prog.level; lv++) {
      unlockedItems.push(...getUnlocksForLevel(input.mode, lv));
    }
  }

  commit(next, prev);

  return {
    mode: input.mode,
    xpGained,
    prevLevel,
    newLevel: prog.level,
    leveledUp: prog.level > prevLevel,
    prevXp,
    newXp: prog.xp,
    nextLevelXp: xpForNextLevel(prog.level),
    unlockedItems,
  };
}

export function updateSwatLoadout(patch: Partial<SwatLoadout>): Readonly<ProgressionState> {
  const prev = cloneState(getProgression() as ProgressionState);
  const next = cloneState(prev);
  next.loadouts.swat = sanitizeSwatLoadout({ ...next.loadouts.swat, ...patch });
  return commit(next, prev);
}

export function updateSquadMemberLoadout(
  index: number,
  patch: Partial<SquadMemberLoadout>,
): Readonly<ProgressionState> {
  if (index < 0 || index >= 4 || !Number.isInteger(index)) return getProgression();
  const prev = cloneState(getProgression() as ProgressionState);
  const next = cloneState(prev);
  const merged = { ...next.loadouts.swat.squad[index]!, ...patch };
  next.loadouts.swat.squad[index] = sanitizeSquadMember(merged);
  return commit(next, prev);
}

export function updateSuspectLoadout(patch: Partial<SuspectLoadout>): Readonly<ProgressionState> {
  const prev = cloneState(getProgression() as ProgressionState);
  const next = cloneState(prev);
  next.loadouts.suspect = sanitizeSuspectLoadout({ ...next.loadouts.suspect, ...patch });
  return commit(next, prev);
}

export function isSuspectModeUnlocked(state: Readonly<ProgressionState> = getProgression()): boolean {
  return state.unlockAll || state.swat.level >= 2;
}

export function getStageUnlockLevel(stageId: string): number {
  if (stageId === 'random_house') return 3;
  if (stageId === 'random_embassy') return 5;
  return 1;
}

export function isStageUnlocked(
  mode: GameMode,
  stageId: string,
  state: Readonly<ProgressionState> = getProgression(),
): boolean {
  if (state.unlockAll) return true;
  return state[mode].level >= getStageUnlockLevel(stageId);
}

export function getAllowedMotifsForStage(
  mode: GameMode,
  stageId: string,
  state: Readonly<ProgressionState> = getProgression(),
): readonly MotifId[] | undefined {
  if (state.unlockAll) return undefined;
  if (stageId === 'random_small' && state[mode].level < 2) {
    return LV1_SMALL_MOTIFS;
  }
  return undefined;
}

export function getSwatUnlocks(state: Readonly<ProgressionState> = getProgression()): SwatUnlocks {
  const lv = state.unlockAll ? MAX_PROGRESSION_LEVEL : state.swat.level;
  return {
    level: lv,
    suspectMode: lv >= 2,
    stages: {
      random_small: true,
      random_house: lv >= 3,
      random_embassy: lv >= 5,
    },
    allowedSmallMotifs: lv >= 2 ? undefined : LV1_SMALL_MOTIFS,
    stealthEntry: lv >= 3,
    weapons: {
      rifle: true,
      smg: lv >= 2,
      suppressed_rifle: lv >= 3,
      shotgun: lv >= 4,
    },
    vests: {
      standard: true,
      light: lv >= 2,
      heavy: lv >= 4,
    },
    teargas: lv >= 2,
    optiwand: lv >= 2,
    c2Breach: lv >= 3,
    shieldMember: lv >= 3,
    squadLoadoutCustom: lv >= 3,
    squadGadgetCustom: lv >= 4,
    negotiationCards: {
      trust: true,
      release_hostage: true,
      persuade_surrender: true,
      intel: lv >= 2,
      ultimatum: lv >= 3,
    },
  };
}

export function getSuspectUnlocks(state: Readonly<ProgressionState> = getProgression()): SuspectUnlocks {
  const lv = state.unlockAll ? MAX_PROGRESSION_LEVEL : state.suspect.level;
  return {
    level: lv,
    stages: {
      random_small: true,
      random_house: lv >= 3,
      random_embassy: lv >= 5,
    },
    allowedSmallMotifs: lv >= 2 ? undefined : LV1_SMALL_MOTIFS,
    weapons: {
      machine_pistol: true,
      suspect_smg: lv >= 2,
      suspect_shotgun: lv >= 3,
      suspect_ar: lv >= 4,
    },
    vests: {
      none: true,
      light: lv >= 2,
      standard: lv >= 2,
      heavy: lv >= 4,
    },
    allyPolicyCustom: lv >= 3,
    fortify: {
      doorLock: true,
      windowBarricade: lv >= 2,
      doorTrap: lv >= 3,
      archPlankBarricade: lv >= 4,
      archOneWayBarricade: lv >= 5,
    },
    negotiationCards: {
      stall: true,
      supplies: true,
      trade_ammo: true,
      trade_medkit: true,
      trade_time: true,
      trade_vest: lv >= 2,
      rally: lv >= 2,
      threaten: lv >= 3,
    },
  };
}

/** 現在のアンロック状態に合わせて未解放装備を安全な既定値へ丸めた SWAT ロードアウトを返す。 */
export function getEffectiveSwatLoadout(state: Readonly<ProgressionState> = getProgression()): SwatLoadout {
  const u = getSwatUnlocks(state);
  const raw = state.loadouts.swat;
  const primaryWeapon: SwatPrimaryWeaponId = u.weapons[raw.primaryWeapon] ? raw.primaryWeapon : 'rifle';
  const vest: SwatVestTier = u.vests[raw.vest] ? raw.vest : 'standard';

  const squad = raw.squad.map((m): SquadMemberLoadout => {
    if (!u.squadLoadoutCustom) {
      return {
        weapon: 'rifle',
        vest: 'standard',
        flashbangs: 1,
        gas: u.teargas ? 1 : 0,
      };
    }
    let weapon: SquadMemberWeaponId = m.weapon;
    if (weapon === 'shield' && !u.shieldMember) weapon = 'rifle';
    else if (weapon === 'smg' && !u.weapons.smg) weapon = 'rifle';
    else if (weapon === 'suppressed_rifle' && !u.weapons.suppressed_rifle) weapon = 'rifle';
    else if (weapon === 'shotgun' && !u.weapons.shotgun) weapon = 'rifle';

    const mVest: SwatVestTier = u.vests[m.vest] ? m.vest : 'standard';
    const flashbangs = u.squadGadgetCustom ? m.flashbangs : 1;
    const gas = u.squadGadgetCustom ? (u.teargas ? m.gas : 0) : u.teargas ? 1 : 0;
    return { weapon, vest: mVest, flashbangs, gas };
  }) as SwatLoadout['squad'];

  return { primaryWeapon, vest, squad };
}

/** 現在のアンロック状態に合わせて未解放装備を安全な既定値へ丸めた容疑者ロードアウトを返す。 */
export function getEffectiveSuspectLoadout(state: Readonly<ProgressionState> = getProgression()): SuspectLoadout {
  const u = getSuspectUnlocks(state);
  const raw = state.loadouts.suspect;
  const primaryWeapon: SuspectPrimaryWeaponId = u.weapons[raw.primaryWeapon] ? raw.primaryWeapon : 'machine_pistol';
  const vest: SuspectVestTier = u.vests[raw.vest] ? raw.vest : 'none';
  const allyPolicy: SuspectAllyPolicy = u.allyPolicyCustom ? raw.allyPolicy : 'balanced';
  return { primaryWeapon, vest, allyPolicy };
}

export function subscribeProgression(fn: ProgressionListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** テスト用: 内部キャッシュをクリアしてストレージから再読込させる */
export function _resetProgressionCacheForTest(): void {
  current = null;
  listeners.clear();
}

/** 便利なファサードオブジェクト */
export const Progression = {
  get: getProgression,
  isUnlockAll,
  setUnlockAll,
  reset: resetProgression,
  recordMissionResult,
  updateSwatLoadout,
  updateSquadMemberLoadout,
  updateSuspectLoadout,
  getSwatUnlocks,
  getSuspectUnlocks,
  getEffectiveSwatLoadout,
  getEffectiveSuspectLoadout,
  getAllowedMotifsForStage,
  isStageUnlocked,
  getStageUnlockLevel,
  isSuspectModeUnlocked,
  getUnlocksForLevel,
  getNextUnlockPreview,
  subscribe: subscribeProgression,
};
