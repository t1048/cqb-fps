import type {
  AdjacencyRuleDef,
  ArchitecturalModuleDef,
  ModularEdgeStyle,
  ModularGeneratorTemplate,
  ModuleCategory,
  StoryLevel,
  StoryProfileDef,
} from '../../core/types';
import { EPS } from './Layout';
import type { Rng } from './Rng';

/**
 * 動線グラフ計画（docs/design/modular-map-generator.md §3.1 planStoriesAndGraph / §3.2-1）。
 * - 階層プロファイル選択、階層別モジュール選出（非 1F 階の一般屋内室 >= 1 を保証）
 * - front_approach → entry → 1F 各モジュール（多層時は stair_core 経由で 2F / B1 部分木）の根付き全域木
 * - 目標閉路予算（閉路辺そのものは幾何配置後に SpatialSolver が自然接触ペアから確定する）
 * 幾何は扱わない（階段コアの外形寸法だけは配置前に決まるため、ここで算出して計画に載せる）。
 */

/** 通常試行の作り直し要求。generateModularMap（WP-3）が捕まえて次の試行へ進む。 */
export class RetryGeneration extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RetryGeneration';
  }
}

/** 屋外アプローチ擬似ノード（ModuleCategory 外。allowed / forbidden 照合の対象外）。 */
export const FRONT_APPROACH_ID = 'front_approach';

/** 選出モジュール数の上限（§6.1: M <= 32）。 */
export const MAX_PLANNED_MODULES = 32;

/** 足元から頭上までの掃引円柱の高さ(m)（§2.2 MIN_HEADROOM）。 */
const HEAD_CLEARANCE = 2.05;
/** 移動体の水平半径(m)（§2.2 BODY_RADIUS）。 */
const BODY_RADIUS = 0.3;

export type PlannedEdgeStyle = ModularEdgeStyle | 'stair';

export interface PlannedModule {
  /** インスタンス ID（例 `bedroom_1F_0`、階段コアは `core0_2F`） */
  id: string;
  def: ArchitecturalModuleDef;
  level: StoryLevel;
  category: ModuleCategory;
  /** 屋内の stackable で 2F が載らない 2 層吹き抜け（S_1F から外す） */
  doubleHeight: boolean;
  /** 落とせない（entry・階段コア・minCount 分・非 1F 階の一般屋内室） */
  required: boolean;
  /** 階段コアのとき 0..1（同じ番号は全階で同一矩形） */
  coreIndex?: number;
  /** 木の親（1F の entry は FRONT_APPROACH_ID） */
  parentId: string;
  /** 親との接続様式（上階・下階の階段コア根は 'stair'） */
  parentStyle: PlannedEdgeStyle;
}

export interface PlannedEdge {
  a: string;
  b: string;
  style: PlannedEdgeStyle;
}

/** 階段コアの局所幾何（外形矩形の北西隅 (0,0) からの相対座標・正準系: 南 +Z がアプローチ）。 */
export interface StairCoreGeometry {
  outerW: number;
  outerD: number;
  steps: number;
  rise: number;
  run: number;
  flightLen: number;
  flightWidth: number;
  /** 有効踊り場奥行の下限 ceil(landingDepth)（落下防止壁を差し引いた各踊り場の奥行はこれ以上） */
  landingDepth: number;
  /** 壁厚（階段穴の落下防止壁の厚さ） */
  wallThickness: number;
  /** 掃引頭上後退量 δ_hole（snap 切り上げ） */
  deltaHole: number;
  /** 西レーン（1F→2F。2F が無ければ脇通路） */
  laneW: [number, number];
  /** 中央仕切り */
  laneMid: [number, number];
  /** 東レーン（B1→1F。B1 が無ければ脇通路） */
  laneE: [number, number];
  innerZ0: number;
  innerZ1: number;
  zF0: number;
  zF1: number;
  hasUpper: boolean;
  hasBasement: boolean;
}

export interface BuildingGraphPlan {
  profile: StoryProfileDef;
  levels: StoryLevel[];
  /** 木の付け順（親が必ず先）。階層 0 → 1 → -1 の順 */
  modules: PlannedModule[];
  rootId: string;
  /** front_approach→entry と階段縦リンクを含む全域木辺 */
  treeEdges: PlannedEdge[];
  loopBudget1F: number;
  loopBudgetOther: number;
  /** 多層時のみ。全コア共通 */
  stairCore: StairCoreGeometry | null;
  coreCount: number;
}

const LEVEL_LABEL: Record<StoryLevel, string> = { [-1]: 'B1', 0: '1F', 1: '2F' };

export function levelLabel(level: StoryLevel): string {
  return LEVEL_LABEL[level];
}

/** ModuleCategory 無向対の正規化キー（§3.2-1）。 */
export function categoryPairKey(a: ModuleCategory, b: ModuleCategory): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/** 動線規則の照合表（forbiddenEdges が allowedEdges に絶対優先）。 */
export class CirculationRules {
  private readonly allowed = new Map<string, AdjacencyRuleDef>();
  private readonly forbidden = new Set<string>();

  constructor(tpl: ModularGeneratorTemplate) {
    for (const [a, b] of tpl.circulation.forbiddenEdges) this.forbidden.add(categoryPairKey(a, b));
    for (const e of tpl.circulation.allowedEdges) {
      const key = categoryPairKey(e.from, e.to);
      const prev = this.allowed.get(key);
      if (!prev || e.weight > prev.weight) this.allowed.set(key, e);
    }
  }

  isForbidden(a: ModuleCategory, b: ModuleCategory): boolean {
    return this.forbidden.has(categoryPairKey(a, b));
  }

  /** 接続可能な規則（禁止・未定義・重み 0 は null） */
  rule(a: ModuleCategory, b: ModuleCategory): AdjacencyRuleDef | null {
    const key = categoryPairKey(a, b);
    if (this.forbidden.has(key)) return null;
    const r = this.allowed.get(key);
    return r && r.weight > 0 ? r : null;
  }
}

const ceilTo = (v: number, s: number): number => Math.ceil(v / s - 1e-9) * s;

/** 扉・アーチ前の可動域 keepOut の半幅に足す余白(m)（§3.2-1）。階段穴の落下防止壁と開口の間の余白にも使う */
export const OPENING_SIDE_PAD = 0.3;

/**
 * 階段段数 max(8, ceil(storyRise / targetRise))（§3.2-3）。DataLoader.modularStairSteps と同一式
 * （DataLoader → generator/index → ModularGenerator → GraphPlanner の循環 import を避けるため複製。上限 32 は DataLoader が拒否済み）。
 */
export function stairStepCount(storyRise: number, targetRise: number): number {
  return Math.max(8, Math.ceil(storyRise / targetRise - 1e-9));
}

/** 折返し 2 レーン階段コアの寸法（§3.2-3）。単層プロファイルでは null。 */
export function computeStairCoreGeometry(tpl: ModularGeneratorTemplate, profile: StoryProfileDef): StairCoreGeometry | null {
  if (profile.levels.length < 2) return null;
  const sc = tpl.stairCore;
  const s = tpl.snap;
  const t = tpl.wallThickness;
  const hasUpper = profile.levels.includes(1);
  const hasBasement = profile.levels.includes(-1);
  const steps = stairStepCount(profile.storyRise, sc.targetRise);
  const rise = profile.storyRise / steps;
  const run = sc.treadRun;
  const flightLen = steps * run;
  const clearance = profile.storyRise - tpl.slabThickness;
  let kMin = steps;
  for (let k = 1; k <= steps; k++) {
    if (k * rise + HEAD_CLEARANCE > clearance - EPS) {
      kMin = k;
      break;
    }
  }
  const deltaHead = Math.max(0, 2 * BODY_RADIUS - (kMin - 1) * run);
  const deltaHole = ceilTo(deltaHead, s);
  // 落下防止壁が張り出す踊り場帯（2F 穴の南辺 = 南帯、1F 穴の北辺 = 北帯）だけ奥行を足し、壁（厚さ t）を差し引いても
  // landingDepth 以上残し、かつ壁の外側（doorBlocked = 壁 + OPENING_SIDE_PAD）の残りの辺にも扉を置けるようにする（BL-01）
  const ld = ceilTo(sc.landingDepth, s);
  const guardExtra = Math.max(t, t / 2 + OPENING_SIDE_PAD);
  const ldN = hasBasement ? ceilTo(sc.landingDepth + guardExtra, s) : ld;
  const ldS = hasUpper ? ceilTo(sc.landingDepth + guardExtra, s) : ld;
  const wW = hasUpper ? sc.flightWidth : sc.hallSideWidth;
  const wE = hasBasement ? sc.flightWidth : sc.hallSideWidth;
  const innerW = wW + sc.laneGap + wE;
  const outerW = ceilTo(innerW + t, s);
  const gapEff = sc.laneGap + (outerW - t - innerW);
  const flightSnap = ceilTo(flightLen, s);
  const innerD = ldN + ldS + 2 * deltaHole + flightSnap;
  const outerD = ceilTo(innerD + t, s);
  const ix0 = t / 2;
  const iz0 = t / 2;
  const zF0 = iz0 + ldN + deltaHole;
  const zF1 = zF0 + flightSnap;
  return {
    outerW,
    outerD,
    steps,
    rise,
    run,
    flightLen,
    flightWidth: sc.flightWidth,
    landingDepth: ld,
    wallThickness: t,
    deltaHole,
    laneW: [ix0, ix0 + wW],
    laneMid: [ix0 + wW, ix0 + wW + gapEff],
    laneE: [ix0 + wW + gapEff, outerW - t / 2],
    innerZ0: iz0,
    innerZ1: outerD - t / 2,
    zF0,
    zF1,
    hasUpper,
    hasBasement,
  };
}

/** 重み > 0 のプロファイルから 1 つ選ぶ（試行ループの前に 1 回。以後降格しない）。 */
export function pickStoryProfile(tpl: ModularGeneratorTemplate, rng: Rng): StoryProfileDef {
  const p = rng.weighted(tpl.storyProfiles, (sp) => sp.weight);
  if (!p) throw new Error(`template "${tpl.id}": 重み > 0 の storyProfiles がありません`);
  return p;
}

const isGeneralIndoor = (d: ArchitecturalModuleDef): boolean =>
  !d.outdoor && d.category !== 'stair_core' && d.category !== 'corridor' && d.category !== 'entry';

/** モジュールを置ける階か（屋外は B1 不可、terrace は 2F のみ、entry は 1F のみ）。 */
function levelAllowed(d: ArchitecturalModuleDef, level: StoryLevel): boolean {
  if (!d.allowedLevels.includes(level)) return false;
  if (d.outdoor && level === -1) return false;
  if (d.category === 'terrace' && level !== 1) return false;
  if (d.category === 'entry' && level !== 0) return false;
  return true;
}

const midArea = (d: ArchitecturalModuleDef): number => ((d.width.min + d.width.max) / 2) * ((d.depth.min + d.depth.max) / 2);

/**
 * 階層別モジュール選出・根付き全域木・閉路予算を決める。
 * 規則上どこにも付けられない任意モジュールは落とし、必須モジュールが付けられなければ RetryGeneration。
 */
export function planStoriesAndGraph(tpl: ModularGeneratorTemplate, profile: StoryProfileDef, rng: Rng): BuildingGraphPlan {
  const levels = [...profile.levels];
  const multi = levels.length > 1;
  const hasUpper = levels.includes(1);
  const hasBasement = levels.includes(-1);
  const core = computeStairCoreGeometry(tpl, profile);
  const rules = new CirculationRules(tpl);

  interface Inst {
    def: ArchitecturalModuleDef;
    level: StoryLevel;
    required: boolean;
    doubleHeight: boolean;
    coreIndex?: number;
  }
  const insts: Inst[] = [];
  const defCount = new Map<string, number>();
  const countOf = (d: ArchitecturalModuleDef): number => defCount.get(d.id) ?? 0;
  const add = (def: ArchitecturalModuleDef, level: StoryLevel, required: boolean, coreIndex?: number): Inst => {
    const inst: Inst = { def, level, required, doubleHeight: false };
    if (coreIndex !== undefined) inst.coreIndex = coreIndex;
    insts.push(inst);
    if (coreIndex === undefined) defCount.set(def.id, countOf(def) + 1);
    return inst;
  };
  const nonCoreCount = (): number => insts.filter((i) => i.coreIndex === undefined).length;
  const pickDef = (cands: ArchitecturalModuleDef[]): ArchitecturalModuleDef | undefined => {
    const positive = cands.filter((d) => d.weight > 0);
    return positive.length > 0 ? rng.weighted(positive, (d) => d.weight) : rng.pick(cands);
  };

  // 1) entry（1F の根、正確に 1 個）
  const entryDef = pickDef(tpl.modules.filter((d) => d.category === 'entry' && !d.outdoor && levelAllowed(d, 0)));
  if (!entryDef) throw new Error(`template "${tpl.id}": 1F に置ける屋内 entry モジュールがありません`);
  add(entryDef, 0, true);

  // 2) 階段コア（多層時。コア k は全階に同一矩形のインスタンスを持つ）
  let coreCount = 0;
  if (multi) {
    const coreDef = pickDef(
      tpl.modules.filter((d) => d.category === 'stair_core' && !d.outdoor && levels.every((lv) => d.allowedLevels.includes(lv))),
    );
    if (!coreDef) throw new Error(`template "${tpl.id}": プロファイル "${profile.id}" の全階に置ける stair_core がありません`);
    coreCount = rng.intInRange(tpl.stairCore.count);
    for (let k = 0; k < coreCount; k++) for (const lv of levels) add(coreDef, lv, true, k);
  }

  // 3) minCount 分（必須）
  for (const d of tpl.modules) {
    if (d.category === 'entry' || d.category === 'stair_core') continue;
    const avail = levels.filter((lv) => levelAllowed(d, lv));
    if (avail.length === 0) continue;
    for (let i = 0; i < d.minCount && nonCoreCount() < MAX_PLANNED_MODULES; i++) {
      const lv = rng.pick(avail);
      if (lv !== undefined) add(d, lv, true);
    }
  }

  // 4) 非 1F 階の一般屋内室（stair_core・corridor 以外）を最低 1 室（§3.2-2）
  for (const lv of levels) {
    if (lv === 0) continue;
    if (insts.some((i) => i.level === lv && isGeneralIndoor(i.def))) continue;
    const cands = tpl.modules.filter((d) => isGeneralIndoor(d) && levelAllowed(d, lv) && countOf(d) < d.maxCount);
    const d = pickDef(cands.length > 0 ? cands : tpl.modules.filter((m) => isGeneralIndoor(m) && levelAllowed(m, lv)));
    if (!d) throw new Error(`template "${tpl.id}": 階層 ${lv} に置ける一般屋内モジュールがありません`);
    add(d, lv, true);
  }

  const estArea = (i: Inst): number => (i.coreIndex !== undefined && core ? core.outerW * core.outerD : midArea(i.def));
  const indoorArea = (lv: StoryLevel, pred: (i: Inst) => boolean = () => true): number =>
    insts.filter((i) => i.level === lv && !i.def.outdoor && pred(i)).reduce((a, i) => a + estArea(i), 0);

  /** 面積目標まで重み付きで追加（任意モジュール）。 */
  const fill = (lv: StoryLevel, target: number, eligible: (d: ArchitecturalModuleDef) => boolean): void => {
    let area = indoorArea(lv);
    while (area < target && nonCoreCount() < MAX_PLANNED_MODULES) {
      const cands = tpl.modules.filter((d) => d.weight > 0 && levelAllowed(d, lv) && eligible(d) && countOf(d) < d.maxCount);
      const d = rng.weighted(cands, (m) => m.weight);
      if (!d) break;
      add(d, lv, false);
      if (!d.outdoor) area += midArea(d);
    }
  };

  // 5) 1F を目標面積まで
  fill(0, rng.inRange(tpl.target1FArea), (d) => d.category !== 'entry' && d.category !== 'stair_core' && d.category !== 'terrace');

  // 6) 吹き抜け（2F があるときだけ意味を持つ）
  if (hasUpper) {
    for (const i of insts) {
      if (i.level !== 0 || i.coreIndex !== undefined || i.def.roofStyle !== 'stackable' || i.def.category === 'entry') continue;
      if (i.def.doubleHeightChance > 0 && rng.chance(i.def.doubleHeightChance)) i.doubleHeight = true;
    }
  }

  // 7) 2F（upperFloorRatio × S_1F 見積り）とルーフテラス
  if (hasUpper && profile.upperFloorRatio) {
    const s1f = indoorArea(0, (i) => (i.def.roofStyle === 'stackable' || i.coreIndex !== undefined) && !i.doubleHeight);
    fill(1, rng.inRange(profile.upperFloorRatio) * s1f, (d) => !d.outdoor && d.category !== 'stair_core' && d.category !== 'entry');
    const chance = profile.roofTerraceChance ?? 0;
    if (chance > 0 && rng.chance(chance) && nonCoreCount() < MAX_PLANNED_MODULES) {
      const t = pickDef(tpl.modules.filter((d) => d.category === 'terrace' && d.outdoor && levelAllowed(d, 1) && countOf(d) < d.maxCount));
      if (t) add(t, 1, false);
    }
  }

  // 8) B1（basementRatio × I_1F 見積り）
  if (hasBasement && profile.basementRatio) {
    fill(-1, rng.inRange(profile.basementRatio) * indoorArea(0), (d) => !d.outdoor && d.category !== 'stair_core' && d.category !== 'entry');
  }

  // ---- インスタンス ID
  const levelSeq = new Map<string, number>();
  const idOf = new Map<Inst, string>();
  for (const i of insts) {
    let id: string;
    if (i.coreIndex !== undefined) id = `core${i.coreIndex}_${levelLabel(i.level)}`;
    else {
      const key = `${i.def.id}_${levelLabel(i.level)}`;
      const n = levelSeq.get(key) ?? 0;
      levelSeq.set(key, n + 1);
      id = `${key}_${n}`;
    }
    idOf.set(i, id);
  }

  // ---- 根付き全域木（階ごと）
  const ordered: PlannedModule[] = [];
  const treeEdges: PlannedEdge[] = [];
  const toPlanned = (i: Inst, parentId: string, parentStyle: PlannedEdgeStyle): PlannedModule => {
    const pm: PlannedModule = {
      id: idOf.get(i) as string,
      def: i.def,
      level: i.level,
      category: i.def.category,
      doubleHeight: i.doubleHeight,
      required: i.required,
      parentId,
      parentStyle,
    };
    if (i.coreIndex !== undefined) pm.coreIndex = i.coreIndex;
    return pm;
  };

  const entryInst = insts[0] as Inst;
  const rootId = idOf.get(entryInst) as string;
  const levelOrder: StoryLevel[] = [0, 1, -1].filter((lv) => levels.includes(lv as StoryLevel)) as StoryLevel[];

  for (const lv of levelOrder) {
    const inTree: PlannedModule[] = [];
    const pending = insts.filter((i) => i.level === lv);
    const take = (i: Inst, parentId: string, style: PlannedEdgeStyle): void => {
      const pm = toPlanned(i, parentId, style);
      ordered.push(pm);
      inTree.push(pm);
      treeEdges.push({ a: parentId, b: pm.id, style });
      pending.splice(pending.indexOf(i), 1);
    };
    if (lv === 0) {
      take(entryInst, FRONT_APPROACH_ID, 'exterior_door');
    } else {
      // 上階・下階の根 = 各コアのインスタンス（1F の同じコアと階段で結ぶ）
      for (const i of insts.filter((x) => x.level === lv && x.coreIndex !== undefined)) {
        take(i, `core${i.coreIndex}_${levelLabel(0)}`, 'stair');
      }
      // 各コアに先に 1 つずつ子を付ける（2 コア時に片方のコアがその階で行き止まりにならないように）
      for (const root of rng.shuffle([...inTree])) {
        const cands: { child: Inst; style: ModularEdgeStyle; weight: number }[] = [];
        for (const c of pending) {
          const r = rules.rule(root.category, c.def.category);
          if (!r || (r.style === 'exterior_door' && !c.def.outdoor && !root.def.outdoor)) continue;
          cands.push({ child: c, style: r.style, weight: r.weight });
        }
        const pick = rng.weighted(cands, (x) => x.weight);
        if (pick) take(pick.child, root.id, pick.style);
      }
    }
    rng.shuffle(pending);
    while (pending.length > 0) {
      const pairs: { child: Inst; parent: PlannedModule; style: ModularEdgeStyle; weight: number }[] = [];
      for (const c of pending) {
        for (const p of inTree) {
          if (p.def.private) continue; // private は葉に限定
          // 屋外（中庭・テラス）は屋内室の親にしない。屋内室どうしが屋外を経由しないと行き来できない
          // （隣家に入るような）間取りを作らないため、屋外モジュールは屋内側の葉にする
          if (p.def.outdoor && !c.def.outdoor) continue;
          const r = rules.rule(p.category, c.def.category);
          if (!r) continue;
          // exterior_door は屋外モジュール（中庭・テラス）との辺に限る
          if (r.style === 'exterior_door' && !c.def.outdoor && !p.def.outdoor) continue;
          pairs.push({ child: c, parent: p, style: r.style, weight: r.weight });
        }
      }
      const pick = rng.weighted(pairs, (x) => x.weight);
      if (!pick) {
        const req = pending.find((i) => i.required);
        if (req) throw new RetryGeneration(`${levelLabel(lv)}: 必須モジュール "${req.def.id}" を動線規則で接続できません`);
        pending.length = 0; // 任意モジュールは落とす
        break;
      }
      take(pick.child, pick.parent.id, pick.style);
    }
  }

  return {
    profile,
    levels,
    modules: ordered,
    rootId,
    treeEdges,
    loopBudget1F: rng.intInRange(tpl.circulation.loopCount1F),
    loopBudgetOther: rng.intInRange(tpl.circulation.loopCountOther),
    stairCore: core,
    coreCount,
  };
}
