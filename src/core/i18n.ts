import { getSettings, subscribeSettings, updateSettings, type Locale } from './Settings';

export type { Locale };

export function getLocale(): Locale {
  return getSettings().language;
}

export function isEn(): boolean {
  return getLocale() === 'en';
}

export function setLocale(locale: Locale): void {
  updateSettings({ language: locale });
}

export function onLocaleChange(fn: (locale: Locale) => void): () => void {
  return subscribeSettings((next, prev) => {
    if (next.language !== prev.language) fn(next.language);
  });
}

/** 現在の言語に応じて日本語・英語を切り替える軽量ヘルパー */
export function t(ja: string, en: string): string {
  return getLocale() === 'en' ? en : ja;
}

const STAGE_EN: Record<string, { name: string; size: string; tagline: string; description: string }> = {
  random_small: {
    name: 'Compact',
    size: 'Small',
    tagline: 'Houses, small shops & offices · 1-2F',
    description: 'A compact building — usually a family home, sometimes a small clubhouse, office, warehouse or clinic. Short sightlines, quick to clear.',
  },
  random_house: {
    name: 'Standard',
    size: 'Medium',
    tagline: 'Mansions, offices, bank branches, hospitals · up to 3F',
    description: 'A mid-size building with courtyards — a mansion, office, bank branch, hospital, clubhouse or warehouse. Multiple breach points and linked floors.',
  },
  random_embassy: {
    name: 'Large',
    size: 'Large',
    tagline: 'Embassies, bank HQs, hospitals, presidential jet and more',
    description: 'A large facility — embassy, bank headquarters, hospital, office tower or warehouse compound — or a hijacked presidential jumbo jet parked on the apron (up to 3 decks, airstair breach).',
  },
};

export function tStageName(id: string, fallback: string): string {
  if (!isEn()) return fallback;
  return STAGE_EN[id]?.name ?? fallback;
}

export function tStageSize(id: string, fallback: string): string {
  if (!isEn()) return fallback;
  if (STAGE_EN[id]?.size) return STAGE_EN[id].size;
  if (fallback === '小') return 'Small';
  if (fallback === '中') return 'Medium';
  if (fallback === '大') return 'Large';
  return fallback;
}

export function tStageTagline(id: string, fallback: string): string {
  if (!isEn()) return fallback;
  return STAGE_EN[id]?.tagline ?? fallback;
}

export function tStageDesc(id: string, fallback: string): string {
  if (!isEn()) return fallback;
  return STAGE_EN[id]?.description ?? fallback;
}

const WEAPON_EN: Record<string, string> = {
  rifle: 'Carbine',
  carbine: 'Carbine',
  smg: 'SMG',
  suppressed_rifle: 'Suppressed Carbine',
  shotgun: 'Tactical Shotgun',
  pepperball: 'Pepperball Gun',
  taser: 'Taser',
  machine_pistol: 'Modded Auto Pistol',
  auto_pistol: 'Modded Auto Pistol',
  suspect_smg: 'Smuggled SMG',
  suspect_shotgun: 'Sawed-off Shotgun',
  suspect_ar: 'Military Assault Rifle',
  flashbang: 'Flashbang',
  teargas: 'CS Gas Canister',
};

export function tWeaponName(id: string, fallback: string): string {
  if (!isEn()) return fallback;
  const modded = fallback.includes('（改）');
  const base = WEAPON_EN[id] ?? fallback.replace('（改）', '');
  return modded ? `${base} (Mod)` : base;
}

const MOTIF_EN: Record<string, { label: string; summaries: [string, string] }> = {
  residence: {
    label: 'Residence',
    summaries: [
      'Armed suspects barricaded inside a suburban residence. Hostages reported on premises.',
      'Reports of gunfire inside a private home. Clear all rooms and secure any civilians.',
    ],
  },
  japanese_house: {
    label: 'Japanese House',
    summaries: [
      'Armed suspects holed up inside a traditional Japanese residence. Watch narrow sliding doors.',
      'Disturbance escalated into a standoff in a wooden house. Clear systematically.',
    ],
  },
  hospital: {
    label: 'Clinic / Hospital',
    summaries: [
      'Armed suspects inside a medical clinic. Staff and patients may still be trapped inside.',
      'Emergency call from a local hospital wing. Avoid collateral damage in tight wards.',
    ],
  },
  clubhouse: {
    label: 'Clubhouse',
    summaries: [
      'Armed gang members occupying a nightclub venue. Low visibility and multiple flank routes.',
      'Standoff inside a private lounge. Watch upper balconies and bar alcoves.',
    ],
  },
  bank: {
    label: 'Bank Branch',
    summaries: [
      'Botched bank robbery turned hostage standoff. Secure the lobby and vault corridors.',
      'Armed robbers trapped inside a local bank branch. Expect fortified choke points.',
    ],
  },
  office: {
    label: 'Office Suite',
    summaries: [
      'Active threat inside a corporate office floor. Clear cubicles, meeting rooms, and corridors.',
      'Armed intruders barricaded in an office building. Watch long hallway sightlines.',
    ],
  },
  warehouse: {
    label: 'Warehouse',
    summaries: [
      'Armed suspects operating out of an industrial warehouse. Expect heavy cover and ambushes.',
      'Illegal arms cache reported in a logistics depot. Clear loading bays and storage rooms.',
    ],
  },
  embassy: {
    label: 'Embassy / Estate',
    summaries: [
      'Armed militants breached a diplomatic compound. High-value civilians must be protected.',
      'Two-story estate under siege. Coordinate entry across multiple wings and stairwells.',
    ],
  },
  air_force_one: {
    label: 'Presidential Jet',
    summaries: [
      'Armed suspects have hijacked the parked presidential jet. Breach via the airstairs, clear the narrow cabin aisles and compartments, and rescue all passengers.',
      'Hostage standoff aboard the presidential jumbo jet. Watch the upper-deck cockpit and lower cargo hold while securing the executive offices and press cabin.',
    ],
  },
};

export function tMotifLabel(id: string, fallback: string): string {
  if (!isEn()) return fallback;
  return MOTIF_EN[id]?.label ?? fallback;
}

export function tMotifSummary(id: string | undefined, fallback: string, seed = 0): string {
  if (!isEn()) return fallback;
  if (id && MOTIF_EN[id]) {
    const arr = MOTIF_EN[id].summaries;
    return arr[Math.abs(seed) % arr.length];
  }
  return 'Armed suspects barricaded inside the facility. Neutralize threats, rescue hostages, and secure evidence.';
}

const ORDER_EN: Record<string, string> = {
  follow: 'Fall In',
  hold: 'Hold Position',
  move: 'Move Here',
  overwatch: 'Cover Area',
  stack: 'Stack Up',
  open_clear: 'Open & Clear',
  flash_clear: 'Flash & Clear',
  gas_clear: 'Gas & Clear',
  c2_clear: 'C2 & Clear',
  breach_clear: 'Breach & Clear',
  open_hold: 'Open & Hold',
  restrain: 'Restrain / Secure',
  mirror: 'Mirror Under Door',
  check: 'Check Door',
  disarm: 'Disarm Trap',
  stair_clear: 'Clear Stairs',
  stair_flash_clear: 'Flash & Clear Stairs',
};

export function tOrderLabel(order: string, fallback: string): string {
  if (!isEn()) return fallback;
  return ORDER_EN[order] ?? fallback;
}

export function tElementLabel(el: string, fallback: string): string {
  if (!isEn()) return fallback;
  if (el === 'gold') return 'GOLD (ALL)';
  if (el === 'red') return 'RED';
  if (el === 'blue') return 'BLUE';
  return fallback;
}

const ROE_EN: Record<string, string> = {
  arrest: 'Suspect Arrested',
  civilian: 'Civilian Secured',
  evidence: 'Evidence Collected',
  neutralize: 'Suspect Neutralized',
  unauthorizedForce: 'Unauthorized Use of Force',
  unwarnedForce: 'Unwarned Lethal Force',
  shotSurrendered: 'Shot Surrendered Suspect',
  hitCivilian: 'Civilian Injured',
  killedCivilian: 'Civilian Killed',
  friendlyFire: 'Friendly Fire',
  allyDown: 'Officer Down',
  playerInjury: 'Player Wounded',
  civilianGassed: 'Civilian Gassed',
  swatNeutralized: 'SWAT Officer Neutralized',
  trapHit: 'Booby Trap Hit',
  hostageUnharmed: 'Hostage Unharmed',
  survivalBonus: 'Siege Survival Bonus',
  siegeVictory: 'SWAT Repelled (Siege Victory)',
  hostageKilled: 'Hostage Killed',
};

export function tRoeLabel(key: string, fallback: string): string {
  if (!isEn()) return fallback;
  return ROE_EN[key] ?? fallback;
}

const ROOM_NAME_EN: Record<string, string> = {
  // Common / outdoor
  '屋外ポーチ': 'Front Porch',
  '玄関前アプローチ': 'Front Approach',
  '裏庭テラス': 'Back Terrace',
  '前庭中庭': 'Front Courtyard',
  '正面車寄せ': 'Front Driveway',
  'エントランスホール': 'Entrance Hall',
  '西ウイング廊下': 'West Wing Hallway',
  '東ウイング廊下': 'East Wing Hallway',
  '不明な区画': 'Unknown Area',
  // Residence
  '玄関': 'Entryway',
  '玄関ホール': 'Entry Hall',
  '廊下': 'Hallway',
  '2F廊下': '2F Hallway',
  'リビング': 'Living Room',
  'ダイニング': 'Dining Room',
  'キッチン': 'Kitchen',
  '寝室': 'Bedroom',
  '主寝室': 'Master Bedroom',
  '子供部屋': 'Kids Room',
  '書斎': 'Study',
  '浴室': 'Bathroom',
  'トイレ': 'Restroom',
  '洗面所': 'Washroom',
  '脱衣所': 'Dressing Room',
  '納戸': 'Storage Closet',
  '物置': 'Storage Room',
  'ガレージ': 'Garage',
  'ベランダ': 'Balcony',
  '中庭': 'Courtyard',
  // Japanese house
  '土間': 'Genkan',
  '縁側': 'Engawa',
  '居間': 'Living Room',
  '座敷': 'Tatami Room',
  '和室': 'Japanese Room',
  '台所': 'Kitchen',
  '茶の間': 'Tea Room',
  '仏間': 'Altar Room',
  '押入れ': 'Closet',
  'お手洗い': 'Restroom',
  '風呂場': 'Bath',
  // Hospital
  '受付ロビー': 'Reception Lobby',
  '待合ホール': 'Waiting Hall',
  '病棟廊下': 'Ward Corridor',
  '診察室': 'Exam Room',
  '病室': 'Patient Room',
  'ナースステーション': 'Nurse Station',
  '処置室': 'Treatment Room',
  '薬局': 'Pharmacy',
  '検査室': 'Lab Room',
  'スタッフ控室': 'Staff Lounge',
  '医療倉庫': 'Medical Supply',
  '化粧室': 'Restroom',
  // Clubhouse
  'メインフロア': 'Main Floor',
  'ラウンジ': 'Lounge',
  'バーカウンター': 'Bar Area',
  'VIPルーム': 'VIP Room',
  'VIPラウンジ': 'VIP Lounge',
  'バックヤード': 'Backstage',
  'DJブース': 'DJ Booth',
  '控室': 'Green Room',
  '事務所': 'Manager Office',
  '酒庫': 'Liquor Storage',
  // Bank
  '銀行ロビー': 'Bank Lobby',
  '窓口ホール': 'Teller Hall',
  '金庫室': 'Vault',
  '金庫前室': 'Vault Vestibule',
  '支店長室': 'Manager Office',
  '応接室': 'Meeting Room',
  '事務室': 'Back Office',
  '警備室': 'Security Room',
  '休憩室': 'Break Room',
  '書類庫': 'Archive Room',
  // Office
  'ロビー': 'Lobby',
  'オフィス': 'Open Office',
  '執務室': 'Workspace',
  '会議室': 'Conference Room',
  '大会議室': 'Boardroom',
  '社長室': 'Executive Office',
  'サーバールーム': 'Server Room',
  '給湯室': 'Pantry',
  '資料室': 'File Room',
  '印刷室': 'Copy Room',
  // Warehouse
  '荷捌き場': 'Loading Bay',
  'メイン倉庫': 'Main Warehouse',
  '保管庫': 'Storage Bay',
  '資材置場': 'Material Yard',
  '管理室': 'Control Room',
  '現場事務所': 'Site Office',
  '作業場': 'Workshop',
  '梱包室': 'Packing Room',
  '機械室': 'Machinery Room',
  '更衣室': 'Locker Room',
  // Embassy
  '大広間': 'Grand Hall',
  'レセプションホール': 'Reception Hall',
  '大使室': 'Ambassador Office',
  '執務室A': 'Office A',
  '執務室B': 'Office B',
  '通信室': 'Comms Room',
  '護衛控室': 'Guard Room',
  '食堂': 'Dining Hall',
  '厨房': 'Kitchen',
  '図書室': 'Library',
  '客室': 'Guest Suite',
  // Presidential Jet (Air Force One)
  '大統領私室': 'Presidential Stateroom',
  '大統領執務室': 'Presidential Office',
  '専用化粧室': 'Private Lavatory',
  '医務室': 'Medical Suite',
  '前方ギャレー': 'Forward Galley',
  '上級スタッフ室': 'Senior Staff Room',
  '首席補佐官室': 'Chief of Staff Office',
  '会議兼食堂': 'Conference / Dining Room',
  '来賓席': 'Guest Cabin',
  'シークレットサービス詰所': 'Secret Service Post',
  '武器保管庫': 'Armory',
  '報道席': 'Press Cabin',
  '後方ギャレー': 'Aft Galley',
  '後部収納庫': 'Aft Stowage',
  '操縦室': 'Cockpit',
  '通信センター': 'Communications Center',
  '乗員休憩室': 'Crew Rest',
  '機上指揮所': 'Airborne Command Room',
  '機内通路': 'Cabin Aisle',
  '上部デッキ通路': 'Upper Deck Aisle',
  '上部デッキ階段': 'Upper Deck Stairs',
  '上部デッキ階段ホール': 'Upper Stair Landing',
  '下部デッキ階段': 'Lower Deck Stairs',
  '下部デッキ階段口': 'Lower Stair Landing',
  '下部デッキ通路': 'Lower Deck Passage',
  '貨物室': 'Cargo Hold',
  '電子機器室': 'Avionics Bay',
  '手荷物室': 'Baggage Hold',
  '駐機場エプロン': 'Apron',
  '前方タラップ上': 'Forward Airstair Top',
  '後方タラップ上': 'Aft Airstair Top',
};

export function tRoomName(name: string): string {
  if (!isEn()) return name;
  if (ROOM_NAME_EN[name]) return ROOM_NAME_EN[name];
  // パターン変換: 渡り廊下 / 2F〇〇 / 〇〇1 など
  let s = name;
  if (s.startsWith('渡り')) {
    const rest = s.slice(2);
    return `Skybridge ${ROOM_NAME_EN[rest] ?? rest}`;
  }
  const floorPrefix = /^(2F|1F|B1)\s*/.exec(s);
  if (floorPrefix) {
    const rest = s.slice(floorPrefix[0].length);
    const numSuffix = /(\d+)$/.exec(rest);
    if (numSuffix) {
      const base = rest.slice(0, -numSuffix[0].length).trim();
      if (ROOM_NAME_EN[base]) return `${floorPrefix[1]} ${ROOM_NAME_EN[base]} ${numSuffix[1]}`;
    }
    if (ROOM_NAME_EN[rest]) return `${floorPrefix[1]} ${ROOM_NAME_EN[rest]}`;
  }
  const numSuffix = /\s*(\d+)$/.exec(s);
  if (numSuffix) {
    const base = s.slice(0, -numSuffix[0].length).trim();
    if (ROOM_NAME_EN[base]) return `${ROOM_NAME_EN[base]} ${numSuffix[1]}`;
  }
  return name;
}
