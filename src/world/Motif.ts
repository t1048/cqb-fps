import type {
  BoxDef,
  GeneratedMapRaw,
  ModularGeneratorTemplate,
  ModuleCategory,
  MotifId,
  RoomDef,
} from '../core/types';
import { MOTIF_IDS } from '../core/types';
import type { TextureName } from './Materials';
import { normalizeSeed } from './generator/Rng';

/** キャンバス塗りと Three.js の色乗算で共有する面の色。数値は 0xRRGGBB。 */
export interface SurfacePalette {
  id: string;
  wall: number;
  wallAlt: number;
  grout: number;
  tileA: number;
  tileB: number;
  carpetA: number;
  carpetB: number;
  woodA: number;
  woodB: number;
  metalA: number;
  metalB: number;
  marbleA: number;
  marbleVein: number;
  brickA: number;
  brickB: number;
  mortar: number;
  ceiling: number;
  ceilingLine: number;
  linenA: number;
  linenB: number;
  accent: number;
  concrete: number;
  doorA: number;
  doorB: number;
  frame: number;
  wallStyle: 'clinical' | 'plaster' | 'wood' | 'stone' | 'metal';
  ceilingStyle: 'acoustic' | 'wood' | 'coffer' | 'exposed' | 'tile';
  signText: string;
}

export type DecalKind =
  | 'blood'
  | 'dirt'
  | 'scuff'
  | 'poster'
  | 'graffiti'
  | 'hazard'
  | 'medcross'
  | 'vault'
  | 'sign'
  | 'stripe';

export type RoomRole = 'wet' | 'service' | 'circ' | 'private' | 'work' | 'outdoor' | 'secure' | 'social' | 'stair';

export interface MotifAtmosphere {
  background: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  roomLights: readonly number[];
  roomIntensity: number;
  exposure: number;
}

export interface MotifDef {
  id: MotifId;
  /** ブリーフィングと HUD に出す日本語名 */
  label: string;
  accentCss: string;
  summaries: readonly string[];
  atmosphere: MotifAtmosphere;
  palette: SurfacePalette;
  /** フルカラーテクスチャは 0xffffff。木・金属は乗算色。 */
  tint: Partial<Record<TextureName, number>>;
  interiorTex: TextureName;
  exteriorTex: TextureName;
  ceilingTex: TextureName;
  roofTex: TextureName;
  groundTex: TextureName;
  stairTex: TextureName;
  floorTex: Record<RoomRole, TextureName>;
  /** 役割別の内壁材（未指定の役割は interiorTex。wet は既定でタイル）。 */
  wallTex?: Partial<Record<RoomRole, TextureName>>;
  /** 地下階（floorY < 0）の内壁材と天井材。未指定は打放しコンクリート。 */
  basementWallTex?: TextureName;
  basementCeilingTex?: TextureName;
  props: { vehicle: TextureName; tall: TextureName; low: TextureName; counter: TextureName; misc: TextureName };
  roomNames: Record<RoomRole, string>;
  decals: readonly DecalKind[];
  /** モジュールカテゴリの重み倍率。1 が現状。必須室は minCount で残る。 */
  categoryWeight: Partial<Record<ModuleCategory, number>>;
  /** storyProfiles[].id の重み倍率 */
  profileWeight: Record<string, number>;
}

const css = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

export const MOTIFS: readonly MotifDef[] = [
  {
    id: 'hospital',
    label: '病院',
    accentCss: css(0x3ecf8e),
    summaries: [
      '市立総合病院に武装グループが立てこもっている。冷たい蛍光灯の病棟廊下を区画ごとに制圧し、病室と薬品庫の人質を確保せよ。',
      '救急外来から侵入した病院事案。処置室のストレッチャーと緑の誘導ラインに注意し、ナースステーションを先に抑えよ。',
    ],
    atmosphere: {
      background: 0x5c6d7a,
      fog: 0x647582,
      fogNear: 26,
      fogFar: 92,
      hemiSky: 0xb8cad4,
      hemiGround: 0x3a464e,
      hemiIntensity: 0.6,
      sunColor: 0xe4eef4,
      sunIntensity: 1.45,
      roomLights: [0xeef3f6, 0xe2ecf2, 0xeef3f6, 0xe2ecf2],
      roomIntensity: 10.5,
      exposure: 1.06,
    },
    palette: {
      id: 'hospital',
      wall: 0xdde4e0,
      wallAlt: 0xb9d2c7,
      grout: 0x9ec8bc,
      tileA: 0xeaf2ef,
      tileB: 0xcce2db,
      carpetA: 0xc5ddd4,
      carpetB: 0xa9c9be,
      woodA: 0xd7e4df,
      woodB: 0xb7cdc4,
      metalA: 0xe7eef1,
      metalB: 0xb7c6ce,
      marbleA: 0xe6eae9,
      marbleVein: 0x8fbfb0,
      brickA: 0xa8b4b0,
      brickB: 0x8e9c98,
      mortar: 0x7a8480,
      ceiling: 0xe8ecea,
      ceilingLine: 0xc5ddd6,
      linenA: 0xf4fffb,
      linenB: 0xd5eee6,
      accent: 0x1fa971,
      concrete: 0x687076,
      doorA: 0xdce4e0,
      doorB: 0xc2d4cc,
      frame: 0x6e8c84,
      wallStyle: 'clinical',
      ceilingStyle: 'acoustic',
      signText: 'WARD',
    },
    tint: { wood: 0xd5e6df, metal: 0xd5e4ea, fabric: 0xe7f4ef },
    interiorTex: 'panel',
    exteriorTex: 'brick',
    ceilingTex: 'ceiling',
    roofTex: 'concrete',
    groundTex: 'concrete',
    stairTex: 'linoleum',
    floorTex: {
      wet: 'tile',
      service: 'linoleum',
      circ: 'linoleum',
      private: 'linoleum',
      work: 'tile',
      outdoor: 'concrete',
      secure: 'tile',
      social: 'tile',
      stair: 'linoleum',
    },
    props: { vehicle: 'metal', tall: 'metal', low: 'linen', counter: 'metal', misc: 'linoleum' },
    roomNames: {
      wet: '処置室',
      service: '器材庫',
      circ: '病棟廊下',
      private: '病室',
      work: 'ナースステーション',
      outdoor: '救急搬入口',
      secure: '薬品庫',
      social: '待合ホール',
      stair: '避難階段',
    },
    decals: ['medcross', 'hazard', 'stripe', 'sign', 'scuff', 'dirt', 'blood'],
    // 階数プロファイルは変えない（同じシードの階層と編成規模を維持する）。室種の比率だけ偏らせる。
    categoryWeight: { living_hub: 0.72, wing_private: 1.45, study_office: 0.9, basement_utility: 1.25, garage: 0.65, corridor: 1.2, courtyard: 0.6, terrace: 0.7 },
    profileWeight: {},
  },
  {
    id: 'clubhouse',
    label: 'クラブハウス',
    accentCss: css(0xe0a050),
    summaries: [
      '会員制クラブハウスが占拠されている。暗いウッドパネルとカーペットのラウンジを、バーカウンターの死角に注意してクリアせよ。',
      '深夜のクラブハウス事案。個室とワインセラー、テラスへの抜け道を先に押さえ、暖かい照明の奥を警戒せよ。',
    ],
    atmosphere: {
      background: 0x2c1814,
      fog: 0x3a221c,
      fogNear: 10,
      fogFar: 48,
      hemiSky: 0xffc090,
      hemiGround: 0x3a2418,
      hemiIntensity: 0.45,
      sunColor: 0xffb080,
      sunIntensity: 1.15,
      roomLights: [0xffb060, 0xffc888, 0xffb060, 0xffc888],
      roomIntensity: 10,
      exposure: 1.02,
    },
    palette: {
      id: 'clubhouse',
      wall: 0x7a4a30,
      wallAlt: 0x8a5f3c,
      grout: 0x4a3020,
      tileA: 0xc4a070,
      tileB: 0x8d6840,
      carpetA: 0x6a2428,
      carpetB: 0x3e1418,
      woodA: 0xb17341,
      woodB: 0x764627,
      metalA: 0xc4a46a,
      metalB: 0x8a7040,
      marbleA: 0xd8c4a4,
      marbleVein: 0x8a6844,
      brickA: 0x8a4034,
      brickB: 0x5c2a24,
      mortar: 0xc8b8a4,
      ceiling: 0x5c4030,
      ceilingLine: 0x2a1a12,
      linenA: 0x8a3038,
      linenB: 0x5c1c24,
      accent: 0xe0a050,
      concrete: 0x6a6058,
      doorA: 0x8a5a32,
      doorB: 0x5c3a22,
      frame: 0x3a2418,
      wallStyle: 'wood',
      ceilingStyle: 'wood',
      signText: 'BAR',
    },
    tint: { wood: 0xc48848, metal: 0xc4a060, fabric: 0xa84848 },
    interiorTex: 'panel',
    exteriorTex: 'siding',
    ceilingTex: 'ceiling',
    roofTex: 'brick',
    groundTex: 'concrete',
    stairTex: 'wood',
    floorTex: {
      wet: 'tile',
      service: 'concrete',
      circ: 'wood',
      private: 'carpet',
      work: 'wood',
      outdoor: 'concrete',
      secure: 'wood',
      social: 'carpet',
      stair: 'wood',
    },
    props: { vehicle: 'metal', tall: 'wood', low: 'linen', counter: 'wood', misc: 'wood' },
    roomNames: {
      wet: 'パウダールーム',
      service: 'バックヤード',
      circ: 'クラブ廊下',
      private: '個室',
      work: '応接室',
      outdoor: 'テラス',
      secure: 'ワインセラー',
      social: 'ラウンジ',
      stair: '主階段',
    },
    decals: ['poster', 'graffiti', 'scuff', 'dirt', 'sign', 'stripe'],
    categoryWeight: { living_hub: 1.55, wing_private: 1.15, study_office: 0.7, basement_utility: 0.75, garage: 0.6, corridor: 1.05, courtyard: 1.25, terrace: 1.3 },
    profileWeight: {},
  },
  {
    id: 'bank',
    label: '銀行',
    accentCss: css(0x8eb4e8),
    summaries: [
      '第一中央銀行の支店が襲撃されている。大理石のロビーと窓口カウンターを越え、地下金庫室の前で展開せよ。',
      '銀行強盗の立てこもり。冷たい照明のホールと金属扉の金庫前室を区別し、窓口裏の事務区画を先に隔離せよ。',
    ],
    atmosphere: {
      background: 0x1a2433,
      fog: 0x243044,
      fogNear: 20,
      fogFar: 88,
      hemiSky: 0xd4dcea,
      hemiGround: 0x2a313c,
      hemiIntensity: 0.48,
      sunColor: 0xf2f5ff,
      sunIntensity: 1.9,
      roomLights: [0xfff4e0, 0xe6eef8, 0xfff4e0, 0xe6eef8],
      roomIntensity: 10.5,
      exposure: 1.05,
    },
    palette: {
      id: 'bank',
      wall: 0xd8d4cc,
      wallAlt: 0xbdb9b0,
      grout: 0x9a9890,
      tileA: 0xeeeae2,
      tileB: 0xd0ccc2,
      carpetA: 0x2c3f62,
      carpetB: 0x1a2844,
      woodA: 0x8d7048,
      woodB: 0x5e4830,
      metalA: 0xc5ccd4,
      metalB: 0x8a949e,
      marbleA: 0xe2ded4,
      marbleVein: 0xb7a48a,
      brickA: 0xc8c4bc,
      brickB: 0xa8a49c,
      mortar: 0xe8e6e0,
      ceiling: 0xe9e6de,
      ceilingLine: 0xc8c2b4,
      linenA: 0xd8d4c8,
      linenB: 0xb7b2a4,
      accent: 0x1a3a72,
      concrete: 0xb7bcc4,
      doorA: 0xdedad2,
      doorB: 0xc2beb4,
      frame: 0x8a929c,
      wallStyle: 'stone',
      ceilingStyle: 'coffer',
      signText: 'VAULT',
    },
    tint: { wood: 0xb09060, metal: 0xc8d0d8, fabric: 0xc8c4b8 },
    interiorTex: 'marble',
    exteriorTex: 'marble',
    ceilingTex: 'ceiling',
    roofTex: 'concrete',
    groundTex: 'concrete',
    stairTex: 'marble',
    floorTex: {
      wet: 'marble',
      service: 'concrete',
      circ: 'marble',
      private: 'carpet',
      work: 'marble',
      outdoor: 'concrete',
      secure: 'concrete',
      social: 'marble',
      stair: 'marble',
    },
    props: { vehicle: 'metal', tall: 'metal', low: 'linen', counter: 'marble', misc: 'wood' },
    roomNames: {
      wet: '化粧室',
      service: '後方事務',
      circ: '銀行ホール',
      private: '役員室',
      work: '窓口',
      outdoor: '正面広場',
      secure: '金庫室',
      social: 'ロビー',
      stair: '主階段',
    },
    decals: ['vault', 'sign', 'stripe', 'scuff', 'dirt', 'hazard'],
    categoryWeight: { living_hub: 1.2, wing_private: 0.65, study_office: 1.55, basement_utility: 1.45, garage: 0.65, corridor: 1.2, courtyard: 0.8, terrace: 0.65 },
    profileWeight: {},
  },
  {
    id: 'office',
    label: 'オフィス',
    accentCss: css(0x7ec8e8),
    summaries: [
      'テナントオフィスが占拠されている。蛍光灯の執務フロアと会議室、サーバ室を順にクリアし、非常階段の上下を警戒せよ。',
      '高層オフィスの立てこもり。カーペットの執務室とガラス越しのミーティング区画を、コピー機とデスクの陰から確認せよ。',
    ],
    atmosphere: {
      background: 0x8ea6ba,
      fog: 0x9eb4c6,
      fogNear: 18,
      fogFar: 78,
      hemiSky: 0xe8eef6,
      hemiGround: 0x6a7684,
      hemiIntensity: 0.58,
      sunColor: 0xfff2e2,
      sunIntensity: 2.05,
      roomLights: [0xf4f7ff, 0xe8f0ff, 0xf4f7ff, 0xe8f0ff],
      roomIntensity: 10.5,
      exposure: 1.05,
    },
    palette: {
      id: 'office',
      wall: 0xd3d8de,
      wallAlt: 0xb3bdc8,
      grout: 0x9aa6b4,
      tileA: 0xe8eef2,
      tileB: 0xc9d3dc,
      carpetA: 0x4a6278,
      carpetB: 0x314556,
      woodA: 0xb08960,
      woodB: 0x7a5a38,
      metalA: 0xd5dbe2,
      metalB: 0xa8b2bc,
      marbleA: 0xe8eaee,
      marbleVein: 0x98a8b8,
      brickA: 0xd0d4da,
      brickB: 0xb0b6be,
      mortar: 0xe8eaee,
      ceiling: 0xe4e8ec,
      ceilingLine: 0xb7c2cc,
      linenA: 0xd5dde6,
      linenB: 0xb7c4d0,
      accent: 0x2f6f9a,
      concrete: 0xc5ccd2,
      doorA: 0xf2f4f6,
      doorB: 0xd5dbe2,
      frame: 0x8aa0b4,
      wallStyle: 'plaster',
      ceilingStyle: 'tile',
      signText: 'OFFICE',
    },
    tint: { wood: 0xc4a070, metal: 0xc8d2dc, fabric: 0xc5d0dc },
    interiorTex: 'panel',
    exteriorTex: 'concrete',
    ceilingTex: 'ceiling',
    roofTex: 'concrete',
    groundTex: 'concrete',
    stairTex: 'tile',
    floorTex: {
      wet: 'tile',
      service: 'concrete',
      circ: 'carpet',
      private: 'carpet',
      work: 'carpet',
      outdoor: 'concrete',
      secure: 'carpet',
      social: 'carpet',
      stair: 'tile',
    },
    props: { vehicle: 'metal', tall: 'metal', low: 'linen', counter: 'wood', misc: 'wood' },
    roomNames: {
      wet: '洗面',
      service: 'サーバ室',
      circ: 'オフィス廊下',
      private: '役員室',
      work: '執務室',
      outdoor: '屋上',
      secure: '資料庫',
      social: 'ミーティング',
      stair: '非常階段',
    },
    decals: ['poster', 'sign', 'scuff', 'dirt', 'stripe', 'graffiti'],
    categoryWeight: { living_hub: 0.8, wing_private: 0.6, study_office: 1.6, basement_utility: 0.9, garage: 0.6, corridor: 1.35, courtyard: 0.7, terrace: 0.85 },
    profileWeight: {},
  },
  {
    id: 'warehouse',
    label: '倉庫',
    accentCss: css(0xe0b43a),
    summaries: [
      '港湾倉庫がアジトになっている。むき出しのコンクリートと危険物の黄黒ラインを目印に、荷捌き場から保管区画へ押し込め。',
      '物流倉庫の立てこもり。高い金属ラックとパレットの陰、ヤード側の開口を先に封鎖してから奥の危険物庫へ進め。',
    ],
    atmosphere: {
      background: 0x6a6258,
      fog: 0x7a7268,
      fogNear: 12,
      fogFar: 55,
      hemiSky: 0xd8d0c4,
      hemiGround: 0x4a4038,
      hemiIntensity: 0.5,
      sunColor: 0xffe0b0,
      sunIntensity: 2.55,
      roomLights: [0xffc090, 0xe8d8c0, 0xffc090],
      roomIntensity: 9,
      exposure: 1.03,
    },
    palette: {
      id: 'warehouse',
      wall: 0x8a9094,
      wallAlt: 0x5c6468,
      grout: 0x3a4044,
      tileA: 0xb7bcc0,
      tileB: 0x8a9094,
      carpetA: 0x6a645c,
      carpetB: 0x4a453e,
      woodA: 0x8a6844,
      woodB: 0x5c4028,
      metalA: 0xb7bcc0,
      metalB: 0x6a7074,
      marbleA: 0xc8ccc8,
      marbleVein: 0x6a7070,
      brickA: 0x8a5848,
      brickB: 0x5c3830,
      mortar: 0xa8a49c,
      ceiling: 0x5c6266,
      ceilingLine: 0x2a3034,
      linenA: 0xc8b89a,
      linenB: 0x8a7860,
      accent: 0xe0b43a,
      concrete: 0x8a8680,
      doorA: 0x9aa0a4,
      doorB: 0x6a7074,
      frame: 0x3e4448,
      wallStyle: 'metal',
      ceilingStyle: 'exposed',
      signText: 'DOCK',
    },
    tint: { wood: 0xa07848, metal: 0xb0b6ba, fabric: 0xc8b898 },
    interiorTex: 'concrete',
    exteriorTex: 'corrugated',
    ceilingTex: 'ceiling',
    roofTex: 'corrugated',
    groundTex: 'concrete',
    stairTex: 'metal',
    floorTex: {
      wet: 'tile',
      service: 'concrete',
      circ: 'concrete',
      private: 'linoleum',
      work: 'concrete',
      outdoor: 'concrete',
      secure: 'concrete',
      social: 'concrete',
      stair: 'metal',
    },
    props: { vehicle: 'metal', tall: 'metal', low: 'wood', counter: 'metal', misc: 'concrete' },
    roomNames: {
      wet: '洗面',
      service: '保管区画',
      circ: '通路',
      private: '休憩室',
      work: '現場事務所',
      outdoor: 'ヤード',
      secure: '危険物庫',
      social: '荷捌き',
      stair: '鉄階段',
    },
    decals: ['hazard', 'stripe', 'dirt', 'scuff', 'sign', 'graffiti', 'blood'],
    categoryWeight: { living_hub: 0.55, wing_private: 0.5, study_office: 0.65, basement_utility: 1.5, garage: 1.55, corridor: 1.1, courtyard: 1.1, terrace: 0.6 },
    profileWeight: {},
  },
  {
    id: 'embassy',
    label: '大使館',
    accentCss: css(0xc8a45c),
    summaries: [
      '在外大使館が武装組織に占拠されている。正面ロータリーから保安検査ロビーと館内大廊下を制圧し、大使執務室と機密保管庫の職員を保護せよ。',
      '大使館複合施設での立てこもり事案。レセプションホールと領事窓口の死角、暗号通信室や上下階を結ぶ館内階段を警戒して進め。',
    ],
    atmosphere: {
      background: 0x465262,
      fog: 0x4f5c6d,
      fogNear: 24,
      fogFar: 92,
      hemiSky: 0xc4cdd8,
      hemiGround: 0x343840,
      hemiIntensity: 0.54,
      sunColor: 0xeadcc8,
      sunIntensity: 1.55,
      roomLights: [0xf5ead6, 0xe4ecf6, 0xf5ead6, 0xe4ecf6],
      roomIntensity: 10.2,
      exposure: 1.04,
    },
    palette: {
      id: 'embassy',
      wall: 0xc6bfb2,
      wallAlt: 0xb0a798,
      grout: 0x948c7e,
      tileA: 0xd2cbc0,
      tileB: 0xbdb5a8,
      carpetA: 0x384358,
      carpetB: 0x4a2c34,
      woodA: 0x78563c,
      woodB: 0x583e2b,
      metalA: 0xb8b2a6,
      metalB: 0x7d786e,
      marbleA: 0xcfc8bc,
      marbleVein: 0x9c9282,
      brickA: 0x9c9589,
      brickB: 0x878075,
      mortar: 0x756f66,
      ceiling: 0xd6d0c6,
      ceilingLine: 0xb2aa9c,
      linenA: 0xc8c0b4,
      linenB: 0xa69d90,
      accent: 0x866b43,
      concrete: 0x6c7075,
      doorA: 0x6e4e36,
      doorB: 0x543b28,
      frame: 0x3e2c1f,
      wallStyle: 'stone',
      ceilingStyle: 'coffer',
      signText: 'EMBASSY',
    },
    tint: { wood: 0x8c6848, metal: 0xc2bcb0, fabric: 0x7a3b42 },
    interiorTex: 'panel',
    exteriorTex: 'brick',
    ceilingTex: 'ceiling',
    roofTex: 'concrete',
    groundTex: 'concrete',
    stairTex: 'marble',
    floorTex: {
      wet: 'tile',
      service: 'concrete',
      circ: 'marble',
      private: 'carpet',
      work: 'carpet',
      outdoor: 'concrete',
      secure: 'concrete',
      social: 'wood',
      stair: 'marble',
    },
    props: { vehicle: 'metal', tall: 'wood', low: 'linen', counter: 'wood', misc: 'wood' },
    roomNames: {
      wet: '化粧室',
      service: '暗号通信室',
      circ: '館内大廊下',
      private: '大使執務室',
      work: '外交会議室',
      outdoor: '正面ロータリー',
      secure: '機密保管庫',
      social: '領事窓口',
      stair: '館内階段',
    },
    decals: ['sign', 'vault', 'stripe', 'scuff', 'dirt'],
    categoryWeight: { living_hub: 1.35, wing_private: 0.85, study_office: 1.5, basement_utility: 1.35, garage: 0.75, corridor: 1.35, courtyard: 1.3, terrace: 0.95 },
    profileWeight: {},
  },
  {
    // 質素な一般住宅（漆喰＋木の床）。部屋名・材質・家具は生成器の自然な構成をそのまま活かす。
    id: 'residence',
    label: '民家',
    accentCss: css(0xc8c0b0),
    summaries: [
      '郊外の民家に立てこもりが起きている。漆喰の壁と木の床の住宅を、玄関から各室へ順にクリアリングせよ。',
      '通報を受けた一般住宅の現場。廊下と階段、リビングや寝室の家具の死角に注意しながら制圧せよ。',
    ],
    atmosphere: {
      background: 0x3a4656,
      fog: 0x3a4656,
      fogNear: 30,
      fogFar: 100,
      hemiSky: 0xb8c6dc,
      hemiGround: 0x2a2620,
      hemiIntensity: 0.5,
      sunColor: 0xffe6c4,
      sunIntensity: 2.4,
      roomLights: [0xffd9a8, 0xffe6c4, 0xe6eef8],
      roomIntensity: 10,
      exposure: 1.05,
    },
    palette: {
      id: 'residence',
      wall: 0xc8c0b0,
      wallAlt: 0xb8b0a0,
      grout: 0xa8a298,
      tileA: 0xd7d2c6,
      tileB: 0xc9c3b4,
      carpetA: 0x6a3a3a,
      carpetB: 0x4a2828,
      woodA: 0x8a6844,
      woodB: 0x7a5230,
      metalA: 0xb0b6bb,
      metalB: 0x5c6368,
      marbleA: 0xe8e4dc,
      marbleVein: 0xb0a898,
      brickA: 0xa35242,
      brickB: 0x8a4034,
      mortar: 0x6d5a52,
      ceiling: 0xd5d0c6,
      ceilingLine: 0xb8b2a6,
      linenA: 0xd8d2c4,
      linenB: 0xb8b0a0,
      accent: 0x8a7048,
      concrete: 0x555c64,
      doorA: 0x7c5536,
      doorB: 0x69462b,
      frame: 0x3d2a1c,
      wallStyle: 'plaster',
      ceilingStyle: 'acoustic',
      signText: '',
    },
    tint: { wood: 0x8a6844, metal: 0xffffff, fabric: 0xffffff },
    interiorTex: 'plaster',
    exteriorTex: 'plaster',
    ceilingTex: 'plaster',
    roofTex: 'concrete',
    groundTex: 'concrete',
    stairTex: 'wood',
    floorTex: {
      wet: 'tile',
      service: 'wood',
      circ: 'wood',
      private: 'wood',
      work: 'wood',
      outdoor: 'concrete',
      secure: 'wood',
      social: 'wood',
      stair: 'wood',
    },
    props: { vehicle: 'metal', tall: 'wood', low: 'wood', counter: 'wood', misc: 'wood' },
    roomNames: {
      wet: '浴室',
      service: 'キッチン',
      circ: '廊下',
      private: '寝室',
      work: '書斎',
      outdoor: '前庭',
      secure: '物置',
      social: 'リビング',
      stair: '階段',
    },
    decals: [],
    categoryWeight: {},
    profileWeight: {},
  },
  {
    id: 'japanese_house',
    label: '和風民家',
    accentCss: css(0xc4783a),
    summaries: [
      '住宅街の和風民家がアジトになっている。漆喰の壁と畳の座敷、縁側の開口を目印に、台所から寝室へ押し込め。',
      '二階建ての和風民家で立てこもり。続き間の座敷と風呂場、木の階段を先に押さえてから奥の納戸へ進め。',
    ],
    atmosphere: {
      background: 0xb7c0c8,
      fog: 0xc8beb0,
      fogNear: 18,
      fogFar: 72,
      hemiSky: 0xb8c6dc,
      hemiGround: 0x2a2620,
      hemiIntensity: 0.5,
      sunColor: 0xffe6c4,
      sunIntensity: 2.2,
      roomLights: [0xffd9a8, 0xffe6c4, 0xffd9a8, 0xffe6c4],
      roomIntensity: 9,
      exposure: 1.05,
    },
    palette: {
      id: 'japanese_house',
      wall: 0xddd2bd,
      wallAlt: 0xc9b99c,
      grout: 0xa89880,
      tileA: 0xd7d2c6,
      tileB: 0xc9c3b4,
      carpetA: 0x6a8f4a,
      carpetB: 0x4f6d36,
      woodA: 0xc4a574,
      woodB: 0x8b5a2b,
      metalA: 0xc8c4bc,
      metalB: 0x6a6460,
      marbleA: 0xe6e0d4,
      marbleVein: 0xb0a898,
      brickA: 0x4a4038,
      brickB: 0x322c28,
      mortar: 0x2a2622,
      ceiling: 0xd5d0c6,
      ceilingLine: 0xb8b2a6,
      linenA: 0xe6dcc8,
      linenB: 0xc4b496,
      accent: 0x6b4a2a,
      concrete: 0x6a6e72,
      doorA: 0x8b5a2b,
      doorB: 0x6e4524,
      frame: 0x3d2a1c,
      wallStyle: 'plaster',
      ceilingStyle: 'wood',
      signText: '和風民家',
    },
    tint: { wood: 0xffffff, metal: 0xc8c0b4, fabric: 0xc4a882 },
    interiorTex: 'plaster',
    exteriorTex: 'siding',
    ceilingTex: 'ceiling',
    roofTex: 'brick',
    groundTex: 'concrete',
    stairTex: 'wood',
    floorTex: {
      wet: 'tile',
      service: 'wood',
      circ: 'wood',
      private: 'tatami',
      work: 'wood',
      outdoor: 'wood',
      secure: 'wood',
      social: 'tatami',
      stair: 'wood',
    },
    props: { vehicle: 'metal', tall: 'wood', low: 'wood', counter: 'wood', misc: 'wood' },
    roomNames: {
      wet: '浴室',
      service: '台所',
      circ: '廊下',
      private: '寝室',
      work: '書斎',
      outdoor: '縁側',
      secure: '納戸',
      social: '座敷',
      stair: '階段',
    },
    decals: ['dirt', 'scuff'],
    categoryWeight: { living_hub: 1.2, wing_private: 1.15, study_office: 0.9, basement_utility: 0.85, garage: 0.8, corridor: 1.05, courtyard: 0.9, terrace: 1.15 },
    profileWeight: {},
  },
  {
    id: 'air_force_one',
    label: '大統領専用機',
    accentCss: css(0x5b8fd6),
    summaries: [
      '駐機中の大統領専用機が武装グループに占拠された。タラップから機内へ突入し、狭い機内通路と各区画を確実にクリアリングして搭乗者を救出せよ。',
      '給油中の大統領専用機がハイジャックされた。上部デッキの操縦室と下部デッキの貨物室にも注意し、執務区画と報道席の人質を確保せよ。',
    ],
    atmosphere: {
      background: 0x47566b,
      fog: 0x52627a,
      fogNear: 30,
      fogFar: 120,
      hemiSky: 0xc8d4e4,
      hemiGround: 0x3a3f46,
      hemiIntensity: 0.55,
      sunColor: 0xffd8b0,
      sunIntensity: 1.9,
      roomLights: [0xfff1dc, 0xf4f0e8, 0xfff1dc, 0xeef2f8],
      roomIntensity: 10,
      exposure: 1.05,
    },
    palette: {
      id: 'air_force_one',
      wall: 0xe2dccd,
      wallAlt: 0xcfc6b3,
      grout: 0xb4ab98,
      tileA: 0xe6e4de,
      tileB: 0xcbc7be,
      carpetA: 0x2c4a7a,
      carpetB: 0x1f3760,
      woodA: 0x9a6b42,
      woodB: 0x6e4a2c,
      metalA: 0xe9edf2,
      metalB: 0xa9b3be,
      marbleA: 0xe4e2dc,
      marbleVein: 0xa8a49c,
      brickA: 0xc8c8cc,
      brickB: 0xa4a8b0,
      mortar: 0xb8bcc2,
      ceiling: 0xe8e5dc,
      ceilingLine: 0xc8c2b4,
      linenA: 0xdfd9cc,
      linenB: 0xbab2a4,
      accent: 0x2b5797,
      concrete: 0x6e737b,
      doorA: 0xdad5c8,
      doorB: 0xc2bcb0,
      frame: 0x6e7782,
      wallStyle: 'plaster',
      ceilingStyle: 'acoustic',
      signText: 'VIP-01',
    },
    tint: { wood: 0x9a6b42, metal: 0xe9edf2, fabric: 0x3d5a8a },
    interiorTex: 'panel',
    exteriorTex: 'metal',
    ceilingTex: 'ceiling',
    roofTex: 'metal',
    groundTex: 'concrete',
    stairTex: 'metal',
    floorTex: {
      wet: 'tile',
      service: 'linoleum',
      circ: 'carpet',
      private: 'carpet',
      work: 'carpet',
      outdoor: 'concrete',
      secure: 'metal',
      social: 'carpet',
      stair: 'carpet',
    },
    props: { vehicle: 'metal', tall: 'metal', low: 'linen', counter: 'wood', misc: 'wood' },
    roomNames: {
      wet: '化粧室',
      service: 'ギャレー',
      circ: '機内通路',
      private: '大統領私室',
      work: '執務室',
      outdoor: '駐機場',
      secure: '武器保管庫',
      social: '会議室',
      stair: '機内階段',
    },
    decals: ['sign', 'stripe', 'scuff', 'dirt'],
    categoryWeight: {},
    profileWeight: {},
  },
];

const BY_ID = new Map<MotifId, MotifDef>(MOTIFS.map((m) => [m.id, m]));
const SEEDED_MOTIFS = MOTIFS.filter((m) => m.id !== 'air_force_one');
export const SEEDED_MOTIF_IDS: readonly MotifId[] = SEEDED_MOTIFS.map((m) => m.id);

export function motifById(id: MotifId): MotifDef {
  return BY_ID.get(id) ?? MOTIFS[0]!;
}

/** 同じシードなら同じモチーフ。生成器の乱数ストリームは消費しない。 */
export function motifFromSeed(seed: number): MotifDef {
  const h = Math.imul(normalizeSeed(seed) ^ 0x9e3779b1, 0x85ebca6b) >>> 0;
  return SEEDED_MOTIFS[h % SEEDED_MOTIFS.length]!;
}

export function roleOf(id: string): RoomRole {
  const s = id.toLowerCase();
  if (s.includes('stair') || s.startsWith('core')) return 'stair';
  if (/(bath|toilet|restroom|ensuite|wash|vanity)/.test(s)) return 'wet';
  if (/(kitchen|garage|motor|storage|closet|utility|plant|crate)/.test(s)) return 'service';
  if (/(vault|cellar|wine|archive|safe)/.test(s)) return 'secure';
  if (/(court|terrace|balcony|approach|porch|yard)/.test(s)) return 'outdoor';
  if (/(reception|ldk|living|dining|banquet|waiting)/.test(s)) return 'social';
  if (/(genkan|hall|lobby|corridor|entry|foyer)/.test(s)) return 'circ';
  if (/(bed|suite|vip|master)/.test(s)) return 'private';
  if (/(study|office|conference|consular|comm|ambassador|exec|secretary|security)/.test(s)) return 'work';
  return 'social';
}

function scaleLabel(mapId: string): string {
  if (mapId.includes('small') || mapId.includes('compact')) return '小';
  if (mapId.includes('embassy')) return '大';
  return '中';
}

function roomAt(rooms: readonly RoomDef[], x: number, z: number, surfaceY: number): RoomDef | undefined {
  let best: RoomDef | undefined;
  let bestArea = Infinity;
  for (const r of rooms) {
    if (Math.abs((r.floorY ?? 0) - surfaceY) > 0.45) continue;
    if (Math.abs(r.x - x) > r.width / 2 + 0.08) continue;
    if (Math.abs(r.z - z) > r.depth / 2 + 0.08) continue;
    const area = r.width * r.depth;
    if (area < bestArea) {
      bestArea = area;
      best = r;
    }
  }
  return best;
}

function indoorBounds(rooms: readonly RoomDef[]): { x0: number; z0: number; x1: number; z1: number } | null {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  let n = 0;
  for (const r of rooms) {
    if (r.outdoor) continue;
    n++;
    x0 = Math.min(x0, r.x - r.width / 2);
    x1 = Math.max(x1, r.x + r.width / 2);
    z0 = Math.min(z0, r.z - r.depth / 2);
    z1 = Math.max(z1, r.z + r.depth / 2);
  }
  return n === 0 ? null : { x0, z0, x1, z1 };
}

function isExteriorWall(w: BoxDef, bounds: { x0: number; z0: number; x1: number; z1: number }): boolean {
  const nearX = Math.min(Math.abs(w.x - w.width / 2 - bounds.x0), Math.abs(w.x + w.width / 2 - bounds.x1)) < 0.42;
  const nearZ = Math.min(Math.abs(w.z - w.depth / 2 - bounds.z0), Math.abs(w.z + w.depth / 2 - bounds.z1)) < 0.42;
  return nearX || nearZ;
}

function coverTex(motif: MotifDef, box: BoxDef, room: RoomDef | undefined): TextureName {
  const h = box.height;
  const long = Math.max(box.width, box.depth);
  const short = Math.min(box.width, box.depth);
  if (h >= 1.2 && long >= 3.2) return motif.props.vehicle;
  if (h >= 1.5 && short <= 0.9) return motif.props.tall;
  if (h <= 0.72 && long >= 1.45 && short >= 0.85) return motif.props.low;
  if (h >= 0.68 && h <= 1.25 && long >= 1.35) return motif.props.counter;
  if (room && roleOf(room.id) === 'secure') return motif.props.tall;
  return motif.props.misc;
}

/**
 * 生成済みマップの座標・扉・スポーンは動かさず、部屋名とマテリアルだけをモチーフへ寄せる。
 * 当たり判定の箱寸法は変えない。
 */
export function dressWithMotif<T extends GeneratedMapRaw>(map: T, seed: number, motifId?: MotifId): T {
  const motif = motifId !== undefined ? motifById(motifId) : motifFromSeed(seed);
  if (motif.id === 'residence') {
    return { ...map, name: `民家（${scaleLabel(map.id)}）`, motif: 'residence' };
  }
  const roles = map.rooms.map((r) => motif.roomNames[roleOf(r.id)]);
  const totals = new Map<string, number>();
  for (const name of roles) totals.set(name, (totals.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const rooms = map.rooms.map((r, i) => {
    const base = roles[i] ?? motif.label;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const multi = (totals.get(base) ?? 0) > 1;
    return { ...r, name: multi ? `${base}${n}` : base };
  });
  const bounds = indoorBounds(rooms);
  const floors = map.floors?.map((f) => {
    const surfaceY = (f.y ?? 0) + f.height;
    const room = roomAt(rooms, f.x, f.z, surfaceY);
    const tex = !room || room.outdoor ? motif.groundTex : motif.floorTex[roleOf(room.id)];
    return { ...f, material: tex };
  });
  const walls = map.walls.map((w) => ({
    ...w,
    material: bounds && isExteriorWall(w, bounds) ? motif.exteriorTex : motif.interiorTex,
  }));
  const covers = map.covers.map((c) => {
    const room = roomAt(rooms, c.x, c.z, c.y ?? 0);
    return { ...c, material: coverTex(motif, c, room) };
  });
  const summary = motif.summaries[normalizeSeed(seed) % motif.summaries.length] ?? motif.summaries[0]!;
  return {
    ...map,
    name: `${motif.label}（${scaleLabel(map.id)}）`,
    motif: motif.id,
    briefing: { ...map.briefing, summary },
    rooms,
    ...(floors !== undefined ? { floors } : {}),
    walls,
    covers,
  };
}

/**
 * フォールバック最小構成の検証に使う元テンプレートは壊さず、計画用の複製だけ重みを偏らせる。
 * 寸法・個数の範囲・家具の寸法は変えない（当たりの契約を維持する）。
 */
export function withMotifBias(tpl: ModularGeneratorTemplate, motif: MotifDef): ModularGeneratorTemplate {
  return {
    ...tpl,
    storyProfiles: tpl.storyProfiles.map((p) => ({
      ...p,
      weight: p.weight * (motif.profileWeight[p.id] ?? 1),
    })),
    modules: tpl.modules.map((m) => ({
      ...m,
      weight: m.weight * (motif.categoryWeight[m.category] ?? 1),
    })),
  };
}

export function isMotifId(value: string): value is MotifId {
  return (MOTIF_IDS as readonly string[]).includes(value);
}
