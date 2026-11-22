import type {
  DoorDef,
  EntityDef,
  FurnitureDef,
  GeneratedMapRaw,
  HouseGeneratorTemplate,
  HouseLayoutId,
  RoomSlot,
  RoomTypeDef,
  WindowDef,
} from '../../core/types';
import { Rng } from './Rng';
import { PlacementGrid } from './Placement';
import {
  EPS,
  buildWalls,
  inset,
  pickOpeningCenter,
  rectArea,
  rectD,
  rectW,
  round3,
  sharedEdge,
  type Opening,
  type Rect,
} from './Layout';

type AreaKind = 'outdoor' | 'genkan' | 'hall' | 'room';

interface GenRoom {
  id: string;
  name: string;
  kind: AreaKind;
  outdoor: boolean;
  rect: Rect;
  slot?: RoomSlot;
  front: boolean;
  back: boolean;
  parent?: GenRoom;
  type?: RoomTypeDef;
  spawnWeight: number;
  furniture: readonly FurnitureDef[];
}

interface PlacedOpening extends Opening {
  a: GenRoom;
  b?: GenRoom;
  isDoor: boolean;
  exterior: boolean;
  locked: boolean;
}

class RetryGeneration extends Error {}

/** 生成器の共通出力型は src/core/types.ts が正本（既存の import 元互換のため再エクスポート） */
export type { GeneratedMapRaw };

export function generateHouse(tpl: HouseGeneratorTemplate, seed: number, mapId: string): GeneratedMapRaw {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < tpl.maxAttempts; attempt++) {
    const rng = new Rng((seed + Math.imul(attempt, 0x9e3779b1)) >>> 0);
    try {
      return new HouseBuilder(tpl, rng, seed, mapId).build();
    } catch (err) {
      if (!(err instanceof RetryGeneration)) throw err;
      lastError = err;
    }
  }
  throw new Error(
    `[generator:${tpl.id}] seed=${seed}: ${tpl.maxAttempts} 回の試行で有効な間取りを生成できませんでした (${lastError instanceof Error ? lastError.message : String(lastError)})`,
  );
}

class HouseBuilder {
  private readonly t: number;
  private readonly storyH: number;
  private readonly rooms: GenRoom[] = [];
  private readonly openings: PlacedOpening[] = [];
  private readonly grid = new PlacementGrid();
  private readonly idCounts = new Map<string, number>();

  constructor(
    private readonly tpl: HouseGeneratorTemplate,
    private readonly rng: Rng,
    private readonly seed: number,
    private readonly mapId: string,
  ) {
    this.t = tpl.wallThickness;
    this.storyH = round3(Math.min(2.4, tpl.ceilingHeight - 0.35));
  }

  private snap(v: number): number {
    return round3(Math.round(v / this.tpl.snap) * this.tpl.snap);
  }

  private fail(reason: string): never {
    throw new RetryGeneration(reason);
  }

  build(): GeneratedMapRaw {
    const tpl = this.tpl;
    const rng = this.rng;

    const W = this.snap(rng.inRange(tpl.footprint.width) / 2) * 2;
    const D = this.snap(rng.inRange(tpl.footprint.depth));
    const P = this.snap(rng.inRange(tpl.porchDepth));
    const lotPadX = 3.0;
    const lotBack = 2.5;
    const totalLotW = round3(W + lotPadX * 2);
    const totalLotD = round3(D + P + lotBack);
    const zFront = this.snap(totalLotD / 2 - P);
    const zBackExt = round3(zFront - D);
    const xL = -W / 2;
    const xR = W / 2;
    const layout: HouseLayoutId = rng.weighted(tpl.layouts, (l) => l.weight)?.id ?? 'wing_L';

    let spawnDoor: PlacedOpening | undefined;
    let frontYard!: GenRoom;

    if (layout === 'embassy_compound') {
      ({ spawnDoor, frontYard } = this.buildEmbassyCompound(xL, xR, zBackExt, zFront, P));
    } else if (layout === 'courtyard_U') {
      ({ spawnDoor, frontYard } = this.buildCourtyardU(xL, xR, zBackExt, zFront, P));
    } else if (layout === 'wing_L') {
      ({ spawnDoor, frontYard } = this.buildWingL(xL, xR, zBackExt, zFront, P));
    } else if (layout === 'stepped_villa') {
      ({ spawnDoor, frontYard } = this.buildSteppedVilla(xL, xR, zBackExt, zFront, P));
    } else {
      ({ spawnDoor, frontYard } = this.buildLegacyCenter(layout, xL, xR, zBackExt, zFront, P));
    }

    if (!spawnDoor) this.fail('玄関ドアがありません');

    // ---- 屋外スタート地点（建物の外のアプローチ上） ----
    const approachDist = Math.max(frontYard.rect.z0 + 2.5 - spawnDoor.c, Math.min(P - 1.1, 5.2));
    const spawn = {
      x: round3(Math.max(frontYard.rect.x0 + 2.0, Math.min(frontYard.rect.x1 - 2.0, spawnDoor.center))),
      y: 0,
      z: round3(Math.min(frontYard.rect.z1 - 1.1, Math.max(frontYard.rect.z0 + 2.5, spawnDoor.c + approachDist))),
      yaw: 0,
    };
    // 玄関ドア〜屋外スポーン・仲間地点を遮蔽物から保護
    this.grid.addKeepOut({
      x0: spawn.x - 2.2,
      x1: spawn.x + 2.2,
      z0: Math.min(spawnDoor.c - 0.4, frontYard.rect.z0 - 0.2),
      z1: spawn.z + 1.3,
    });

    // ---- 全屋内部屋への到達性を BFS 検証 ----
    this.verifyReachability();

    // ---- 施錠 ----
    let locked = 0;
    for (const o of rng.shuffle(this.openings.filter((o) => o.isDoor && !o.exterior && !o.window))) {
      if (locked >= tpl.door.maxLocked) break;
      if (rng.chance(tpl.door.lockedChance)) {
        o.locked = true;
        locked++;
      }
    }

    // ---- 外窓の自動配置 ----
    const windows = this.placeExteriorWindows();

    // ---- 壁・ドア ----
    const indoorRooms = this.rooms.filter((r) => !r.outdoor);
    const walls = buildWalls(
      indoorRooms.map((r) => r.rect),
      this.openings,
      this.t,
      tpl.ceilingHeight,
    );
    const doors: DoorDef[] = [];
    const doorIds = new Set<string>();
    for (const o of this.openings) {
      if (o.window) {
        this.grid.addKeepOut(
          o.axis === 'x'
            ? { x0: o.center - o.width / 2 - 0.2, x1: o.center + o.width / 2 + 0.2, z0: o.c - 0.55, z1: o.c + 0.55 }
            : { x0: o.c - 0.55, x1: o.c + 0.55, z0: o.center - o.width / 2 - 0.2, z1: o.center + o.width / 2 + 0.2 },
        );
        continue;
      }
      const reach = o.isDoor ? o.width + 0.35 : 1.0;
      const half = o.width / 2 + 0.3;
      this.grid.addKeepOut(
        o.axis === 'x'
          ? { x0: o.center - half, x1: o.center + half, z0: o.c - reach, z1: o.c + reach }
          : { x0: o.c - reach, x1: o.c + reach, z0: o.center - half, z1: o.center + half },
      );
      if (!o.isDoor || !o.b) continue;
      let id = `door_${o.a.id}_${o.b.id}`;
      for (let k = 2; doorIds.has(id); k++) id = `door_${o.a.id}_${o.b.id}_${k}`;
      doorIds.add(id);
      doors.push({
        id,
        x: o.axis === 'x' ? o.center : o.c,
        z: o.axis === 'x' ? o.c : o.center,
        yaw: o.axis === 'x' ? 0 : 90,
        locked: o.locked,
        maxAngle: tpl.door.maxAngle,
        width: o.width,
      });
    }

    // ---- 家具 ----
    for (const r of this.rooms) {
      const margin = r.outdoor ? 0.35 : this.t / 2 + 0.04;
      const interior = inset(r.rect, margin);
      if (interior.x1 <= interior.x0 || interior.z1 <= interior.z0) continue;
      for (const f of r.furniture) {
        if (!rng.chance(f.chance)) continue;
        const n = f.count ? rng.intInRange(f.count) : 1;
        for (let k = 0; k < n; k++) this.grid.placeFurniture(rng, f, interior, tpl.furnitureGap, tpl.wallClearance);
      }
    }

    // ---- 人物 ----
    const entities = this.placeEntities(spawn);
    const suspects = entities.filter((e) => e.type === 'suspect').length;
    const civilians = entities.length - suspects;
    if (suspects < tpl.entities.suspects.min) this.fail('容疑者を配置できません');

    const u = tpl.entities.briefingUncertainty;
    const est = (n: number): { min: number; max: number } => ({
      min: Math.max(0, n - rng.int(0, u)),
      max: n + rng.int(0, u),
    });

    return {
      id: this.mapId,
      name: tpl.name,
      seed: this.seed,
      briefing: {
        summary: rng.pick(tpl.summaries) ?? '',
        estimatedSuspects: est(suspects),
        estimatedHostages: est(civilians),
      },
      ceilingHeight: tpl.ceilingHeight,
      storyHeight: this.storyH,
      floor: { width: totalLotW, depth: totalLotD },
      playerSpawn: spawn,
      allies: [
        { id: 'ally_miller', name: 'Miller', x: round3(Math.max(frontYard.rect.x0 + 0.6, spawn.x - 1.15)), z: round3(Math.min(frontYard.rect.z1 - 0.5, spawn.z + 0.55)) },
        { id: 'ally_cole', name: 'Cole', x: round3(Math.min(frontYard.rect.x1 - 0.6, spawn.x + 1.15)), z: round3(Math.min(frontYard.rect.z1 - 0.5, spawn.z + 0.55)) },
      ],
      walls,
      doors,
      windows,
      covers: this.grid.covers,
      entities,
      rooms: this.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        x: round3((r.rect.x0 + r.rect.x1) / 2),
        z: round3((r.rect.z0 + r.rect.z1) / 2),
        width: round3(rectW(r.rect)),
        depth: round3(rectD(r.rect)),
        ...(r.outdoor ? { outdoor: true } : {}),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Layout 1: L字型ウイング建築
  // ---------------------------------------------------------------------------
  private buildWingL(xL: number, xR: number, zBackExt: number, zFront: number, P: number): { spawnDoor?: PlacedOpening; frontYard: GenRoom } {
    const tpl = this.tpl;
    const rng = this.rng;
    const hw = this.snap(rng.inRange(tpl.hallway.width));
    const W = xR - xL;
    const D = zFront - zBackExt;
    const leftProjects = rng.chance(0.5);

    const wingRatio = rng.range(0.32, 0.44);
    const wingW = this.snap(W * wingRatio);
    const hx0 = leftProjects ? round3(xL + wingW) : round3(xR - wingW - hw);
    const hx1 = round3(hx0 + hw);
    if (hx0 < xL + tpl.sideZone.minWidth - EPS || hx1 > xR - tpl.sideZone.minWidth + EPS) {
      this.fail('L字廊下幅が不足しています');
    }

    const maxCutFront = Math.max(2.6, Math.min(D * 0.36, D - tpl.hallway.minLength - tpl.backZone.depth.min - 0.4));
    const minCutFront = Math.min(maxCutFront, Math.max(2.4, D * 0.24));
    const zMidFront = this.snap(zFront - rng.range(minCutFront, maxCutFront));
    const maxZBack = round3(zMidFront - tpl.hallway.minLength);
    const minBackD = Math.min(tpl.backZone.depth.min, Math.max(2.8, maxZBack - zBackExt));
    const maxBackD = Math.max(minBackD, Math.min(tpl.backZone.depth.max, maxZBack - zBackExt));
    const zBack = this.snap(zBackExt + rng.range(minBackD, maxBackD));
    if (zMidFront - zBack < tpl.hallway.minLength - EPS) this.fail('L字廊下が短すぎます');

    // 屋外前庭（アプローチ）＋切り欠きポーチ
    const frontYard = this.addOutdoor('porch', tpl.special.porch.name, {
      x0: xL - 1.5,
      z0: zFront,
      x1: xR + 1.5,
      z1: round3(zFront + P),
    }, tpl.special.porch.furniture);
    const cutoutOutdoor = this.addOutdoor('courtyard_front', '屋外ポーチ', {
      x0: leftProjects ? hx0 : xL,
      z0: zMidFront,
      x1: leftProjects ? xR : hx1,
      z1: zFront,
    }, []);

    let hallZ1 = zMidFront;
    let genkan: GenRoom | undefined;
    if (rng.chance(tpl.genkan.chance)) {
      const gd = this.snap(rng.inRange(tpl.genkan.depth));
      if (zMidFront - gd - zBack >= tpl.hallway.minLength) {
        hallZ1 = round3(zMidFront - gd);
        genkan = this.addRoom('genkan', tpl.special.genkan.name, 'genkan', { x0: hx0, z0: hallZ1, x1: hx1, z1: zMidFront }, {
          front: true,
          back: false,
          spawnWeight: tpl.special.genkan.spawnWeight,
          furniture: tpl.special.genkan.furniture,
        });
      }
    }
    const hall = this.addRoom('hallway', tpl.special.hallway.name, 'hall', { x0: hx0, z0: zBack, x1: hx1, z1: hallZ1 }, {
      front: !genkan,
      back: false,
      spawnWeight: tpl.special.hallway.spawnWeight,
      furniture: tpl.special.hallway.furniture,
    });

    const normalRooms: GenRoom[] = [];
    // 張り出しウイング側 (zBack .. zFront)
    const projX0 = leftProjects ? xL : hx1;
    const projX1 = leftProjects ? hx0 : xR;
    normalRooms.push(...this.splitZoneRooms(projX0, projX1, zBack, zFront, leftProjects ? hx0 : hx1, true, false));
    // 凹み側 (zBack .. zMidFront)
    const recX0 = leftProjects ? hx1 : xL;
    const recX1 = leftProjects ? xR : hx0;
    normalRooms.push(...this.splitZoneRooms(recX0, recX1, zBack, zMidFront, leftProjects ? hx1 : hx0, true, false));

    // 奥区画 (xL .. xR, zBackExt .. zBack)
    const backRooms = this.splitBackRooms(xL, xR, zBackExt, zBack, hx0, hx1);
    normalRooms.push(...backRooms);

    this.assignTypes(normalRooms);

    const doorW = tpl.door.width;
    const entryRoom = genkan ?? hall;
    const spawnDoor = this.connect(cutoutOutdoor, entryRoom, true, doorW, true);
    if (!spawnDoor) this.fail('正面玄関を配置できません');

    if (genkan) {
      const arch = rng.chance(tpl.genkan.archChance);
      if (!this.connect(genkan, hall, !arch, arch ? this.archWidthFor(genkan, hall) : doorW)) {
        this.fail('玄関→廊下を接続できません');
      }
    }

    const wingHubs = genkan ? [hall, genkan] : [hall];
    this.connectWingRooms(normalRooms, wingHubs, doorW);

    this.connectBackRooms(backRooms, hall);
    // 張り出しウイング前端の勝手口/サブ入口
    const frontProjRoom = normalRooms.find((r) => r.front && Math.abs(r.rect.z1 - zFront) < EPS && !r.type?.private);
    if (frontProjRoom) this.connect(frontYard, frontProjRoom, true, doorW, true);

    this.addExtraConnections();
    return { spawnDoor, frontYard };
  }

  // ---------------------------------------------------------------------------
  // Layout 2: 凹凸・非対称ステップ邸宅 (stepped_villa)
  // ---------------------------------------------------------------------------
  private buildSteppedVilla(xL: number, xR: number, zBackExt: number, zFront: number, P: number): { spawnDoor?: PlacedOpening; frontYard: GenRoom } {
    const tpl = this.tpl;
    const rng = this.rng;
    const hw = this.snap(rng.inRange(tpl.hallway.width));
    const W = xR - xL;
    const D = zFront - zBackExt;
    const leftFront = rng.chance(0.5);

    const hx0 = this.snap(rng.range(xL + Math.max(tpl.sideZone.minWidth, W * 0.28), xR - hw - Math.max(tpl.sideZone.minWidth, W * 0.28)));
    const hx1 = round3(hx0 + hw);

    const minStepFront = Math.max(2.4, D * 0.2);
    const maxStepFront = Math.max(minStepFront, Math.min(D * 0.3, D - tpl.hallway.minLength - 4.8));
    const zStepFront = this.snap(zFront - rng.range(minStepFront, maxStepFront));
    const availAfterFront = zStepFront - zBackExt;
    const minStepBack = Math.max(1.8, D * 0.12);
    const maxStepBack = Math.max(minStepBack, Math.min(D * 0.22, availAfterFront - tpl.hallway.minLength - 2.6));
    const zStepBack = this.snap(zBackExt + rng.range(minStepBack, maxStepBack));
    const maxBackZone = round3(zStepFront - tpl.hallway.minLength);
    const minBackZoneD = Math.min(tpl.backZone.depth.min, Math.max(2.6, maxBackZone - zStepBack));
    const maxBackZoneD = Math.max(minBackZoneD, Math.min(tpl.backZone.depth.max, maxBackZone - zStepBack));
    const zBackZone = this.snap(zStepBack + rng.range(minBackZoneD, maxBackZoneD));
    if (zStepFront - zBackZone < tpl.hallway.minLength - EPS) this.fail('ステップ邸宅の廊下が短すぎます');

    const frontYard = this.addOutdoor('porch', tpl.special.porch.name, {
      x0: xL - 1.5,
      z0: zFront,
      x1: xR + 1.5,
      z1: round3(zFront + P),
    }, tpl.special.porch.furniture);
    const entryCourt = this.addOutdoor('entry_court', '玄関前アプローチ', {
      x0: leftFront ? hx0 : xL,
      z0: zStepFront,
      x1: leftFront ? xR : hx1,
      z1: zFront,
    }, []);
    this.addOutdoor('rear_terrace', '裏庭テラス', {
      x0: leftFront ? xL : hx1,
      z0: zBackExt,
      x1: leftFront ? hx0 : xR,
      z1: zStepBack,
    }, []);

    let hallZ1 = zStepFront;
    let genkan: GenRoom | undefined;
    if (rng.chance(0.75)) {
      const gd = this.snap(rng.inRange(tpl.genkan.depth));
      if (zStepFront - gd - zBackZone >= tpl.hallway.minLength) {
        hallZ1 = round3(zStepFront - gd);
        genkan = this.addRoom('genkan', tpl.special.genkan.name, 'genkan', { x0: hx0, z0: hallZ1, x1: hx1, z1: zStepFront }, {
          front: true,
          back: false,
          spawnWeight: tpl.special.genkan.spawnWeight,
          furniture: tpl.special.genkan.furniture,
        });
      }
    }
    const hall = this.addRoom('hallway', tpl.special.hallway.name, 'hall', { x0: hx0, z0: zBackZone, x1: hx1, z1: hallZ1 }, {
      front: !genkan,
      back: false,
      spawnWeight: tpl.special.hallway.spawnWeight,
      furniture: tpl.special.hallway.furniture,
    });

    const normalRooms: GenRoom[] = [];
    // 前方張り出しウイング
    const fX0 = leftFront ? xL : hx1;
    const fX1 = leftFront ? hx0 : xR;
    normalRooms.push(...this.splitZoneRooms(fX0, fX1, zBackZone, zFront, leftFront ? hx0 : hx1, true, false));
    // 後方張り出しウイング
    const bX0 = leftFront ? hx1 : xL;
    const bX1 = leftFront ? xR : hx0;
    normalRooms.push(...this.splitZoneRooms(bX0, bX1, zBackZone, zStepFront, leftFront ? hx1 : hx0, true, false));

    // 奥区画 (後方張り出し側＋中央)
    const backSpanX0 = leftFront ? hx0 : xL;
    const backSpanX1 = leftFront ? xR : hx1;
    const backRooms = this.splitBackRooms(backSpanX0, backSpanX1, zBackExt, zBackZone, hx0, hx1);
    normalRooms.push(...backRooms);

    this.assignTypes(normalRooms);

    const doorW = tpl.door.width;
    const spawnDoor = this.connect(entryCourt, genkan ?? hall, true, doorW, true);
    if (!spawnDoor) this.fail('ステップ邸宅の正面玄関を配置できません');

    if (genkan) {
      const arch = rng.chance(tpl.genkan.archChance);
      if (!this.connect(genkan, hall, !arch, arch ? this.archWidthFor(genkan, hall) : doorW)) this.fail('玄関→廊下を接続できません');
    }

    const wingHubs = genkan ? [hall, genkan] : [hall];
    this.connectWingRooms(normalRooms, wingHubs, doorW);

    this.connectBackRooms(backRooms, hall);

    // サブ侵入口（前方張り出しウイング正面＋裏庭側ドア）
    const wingFront = normalRooms.find((r) => Math.abs(r.rect.z1 - zFront) < EPS && !r.type?.private);
    if (wingFront) this.connect(frontYard, wingFront, true, doorW, true);

    this.addExtraConnections();
    return { spawnDoor, frontYard };
  }

  // ---------------------------------------------------------------------------
  // Layout 3: コの字・正面中庭囲み建築 (courtyard_U)
  // ---------------------------------------------------------------------------
  private buildCourtyardU(xL: number, xR: number, zBackExt: number, zFront: number, P: number): { spawnDoor?: PlacedOpening; frontYard: GenRoom } {
    const tpl = this.tpl;
    const rng = this.rng;
    const hw = this.snap(rng.inRange(tpl.hallway.width));
    const W = xR - xL;
    const D = zFront - zBackExt;

    const wingW = this.snap(rng.range(Math.max(tpl.sideZone.minWidth + hw, W * 0.28), W * 0.34));
    const cx0 = round3(xL + wingW);
    const cx1 = round3(xR - wingW);
    if (cx1 - cx0 < 4.0) this.fail('中庭幅が狭すぎます');

    const zCourtBack = this.snap(zFront - rng.range(D * 0.32, D * 0.44));
    const zBackHall = round3(zCourtBack - hw);
    if (zBackHall - zBackExt < 3.4) this.fail('奥棟の奥行が不足しています');

    const frontYard = this.addOutdoor('porch', tpl.special.porch.name, {
      x0: xL - 1.5,
      z0: zFront,
      x1: xR + 1.5,
      z1: round3(zFront + P),
    }, tpl.special.porch.furniture);
    const courtyard = this.addOutdoor('front_courtyard', '前庭中庭', {
      x0: cx0,
      z0: zCourtBack,
      x1: cx1,
      z1: zFront,
    }, []);

    // U字回廊（西廊下・中央横断廊下・東廊下）
    const hallW = this.addRoom('hall_west', '西ウイング廊下', 'hall', { x0: round3(cx0 - hw), z0: zBackHall, x1: cx0, z1: zFront - 2.8 }, {
      front: false, back: false, spawnWeight: tpl.special.hallway.spawnWeight, furniture: tpl.special.hallway.furniture,
    });
    const hallC = this.addRoom('hall_center', 'エントランスホール', 'hall', { x0: cx0, z0: zBackHall, x1: cx1, z1: zCourtBack }, {
      front: true, back: false, spawnWeight: tpl.special.hallway.spawnWeight * 1.2, furniture: tpl.special.hallway.furniture,
    });
    const hallE = this.addRoom('hall_east', '東ウイング廊下', 'hall', { x0: cx1, z0: zBackHall, x1: round3(cx1 + hw), z1: zFront - 2.8 }, {
      front: false, back: false, spawnWeight: tpl.special.hallway.spawnWeight, furniture: tpl.special.hallway.furniture,
    });

    const normalRooms: GenRoom[] = [];
    // 西ウイング部屋群（廊下西側＋前端部屋）
    normalRooms.push(...this.splitZoneRooms(xL, round3(cx0 - hw), zBackHall, zFront, round3(cx0 - hw), true, false));
    normalRooms.push(this.addRoom('room', '', 'room', { x0: round3(cx0 - hw), z0: round3(zFront - 2.8), x1: cx0, z1: zFront }, { front: true, back: false, slot: 'side' }));
    // 東ウイング部屋群（廊下東側＋前端部屋）
    normalRooms.push(...this.splitZoneRooms(round3(cx1 + hw), xR, zBackHall, zFront, round3(cx1 + hw), true, false));
    normalRooms.push(this.addRoom('room', '', 'room', { x0: cx1, z0: round3(zFront - 2.8), x1: round3(cx1 + hw), z1: zFront }, { front: true, back: false, slot: 'side' }));
    // 奥棟（xL .. xR, zBackExt .. zBackHall）
    const backRooms = this.splitBackRooms(xL, xR, zBackExt, zBackHall, cx0, cx1);
    normalRooms.push(...backRooms);

    this.assignTypes(normalRooms);

    const doorW = tpl.door.width;
    // 回廊同士を広いアーチで連結
    if (!this.connect(hallW, hallC, false, round3(hw - this.t - 0.04))) this.fail('西廊下接続失敗');
    if (!this.connect(hallE, hallC, false, round3(hw - this.t - 0.04))) this.fail('東廊下接続失敗');

    const spawnDoor = this.connect(courtyard, hallC, true, Math.min(1.4, doorW + 0.2), true);
    if (!spawnDoor) this.fail('中庭正面入口を配置できません');

    // 両ウイングからのサブ入口
    this.connectWingRooms(normalRooms, [hallW, hallE, hallC], doorW);

    for (const br of backRooms) {
      const ok =
        this.connect(hallC, br, true, doorW) ||
        this.connect(hallW, br, true, doorW) ||
        this.connect(hallE, br, true, doorW);
      if (!ok) {
        // 隣り合う奥部屋経由で連結
        const idx = backRooms.indexOf(br);
        const leftN = idx > 0 ? backRooms[idx - 1] : undefined;
        const rightN = idx + 1 < backRooms.length ? backRooms[idx + 1] : undefined;
        if (!(leftN && this.connect(leftN, br, true, doorW)) && !(rightN && this.connect(rightN, br, true, doorW))) {
          this.fail('奥棟部屋を接続できません');
        }
      }
    }

    // ウイング正面扉（中庭・前庭側）
    for (const r of normalRooms.filter((x) => Math.abs(x.rect.z1 - zFront) < EPS && !x.type?.private).slice(0, 2)) {
      this.connect(frontYard, r, true, doorW, true);
    }

    this.addExtraConnections();
    return { spawnDoor, frontYard };
  }

  // ---------------------------------------------------------------------------
  // Layout 4: 大使館コンパウンド (embassy_compound)
  // ---------------------------------------------------------------------------
  private buildEmbassyCompound(xL: number, xR: number, zBackExt: number, zFront: number, P: number): { spawnDoor?: PlacedOpening; frontYard: GenRoom } {
    const tpl = this.tpl;
    const rng = this.rng;
    const hw = this.snap(rng.inRange(tpl.hallway.width));
    const W = xR - xL;
    const D = zFront - zBackExt;

    const maxCourtW = Math.max(7.4, W - 2 * (hw + Math.max(tpl.sideZone.minWidth, 5.2)));
    const minCourtW = Math.min(maxCourtW, Math.max(7.4, W * 0.3));
    const courtW = this.snap(rng.range(minCourtW, maxCourtW));
    const cx0 = round3(-courtW / 2);
    const cx1 = round3(courtW / 2);

    const zRecessFront = this.snap(zFront - rng.range(4.8, Math.min(7.0, D * 0.23)));
    const zLobbyBack = this.snap(zRecessFront - rng.range(3.2, 4.4));
    const zCourtBack = this.snap(zLobbyBack - rng.range(6.8, Math.min(10.5, D * 0.32)));
    const zNorthHallBack = round3(zCourtBack - hw);
    if (zNorthHallBack - zBackExt < 4.5) this.fail('大使館北棟の奥行が不足しています');

    // 屋外前庭ロータリー + 凹型正面アプローチ + 中央吹き抜け中庭
    const frontYard = this.addOutdoor('porch', tpl.special.porch.name, {
      x0: xL - 2.0,
      z0: zFront,
      x1: xR + 2.0,
      z1: round3(zFront + P),
    }, tpl.special.porch.furniture);
    const frontPortico = this.addOutdoor('portico', '正面車寄せ', {
      x0: round3(cx0 - hw),
      z0: zRecessFront,
      x1: round3(cx1 + hw),
      z1: zFront,
    }, []);
    const innerCourt = this.addOutdoor('atrium', '中央中庭', {
      x0: cx0,
      z0: zCourtBack,
      x1: cx1,
      z1: zLobbyBack,
    }, []);

    // O字回廊（正面ロビー＋西廊下＋東廊下＋北廊下）
    const lobby = this.addRoom('lobby', '正面エントランスロビー', 'hall', {
      x0: round3(cx0 - hw),
      z0: zLobbyBack,
      x1: round3(cx1 + hw),
      z1: zRecessFront,
    }, { front: true, back: false, spawnWeight: tpl.special.hallway.spawnWeight * 1.4, furniture: tpl.special.hallway.furniture });

    const westHall = this.addRoom('west_hall', '西棟廊下', 'hall', {
      x0: round3(cx0 - hw),
      z0: zNorthHallBack,
      x1: cx0,
      z1: zLobbyBack,
    }, { front: false, back: false, spawnWeight: tpl.special.hallway.spawnWeight, furniture: tpl.special.hallway.furniture });

    const eastHall = this.addRoom('east_hall', '東棟廊下', 'hall', {
      x0: cx1,
      z0: zNorthHallBack,
      x1: round3(cx1 + hw),
      z1: zLobbyBack,
    }, { front: false, back: false, spawnWeight: tpl.special.hallway.spawnWeight, furniture: tpl.special.hallway.furniture });

    const northHall = this.addRoom('north_hall', '北棟大廊下', 'hall', {
      x0: cx0,
      z0: zNorthHallBack,
      x1: cx1,
      z1: zCourtBack,
    }, { front: false, back: false, spawnWeight: tpl.special.hallway.spawnWeight, furniture: tpl.special.hallway.furniture });

    const normalRooms: GenRoom[] = [];
    // 西ウイング (xL .. cx0 - hw, zNorthHallBack .. zFront)
    normalRooms.push(...this.splitZoneRooms(xL, round3(cx0 - hw), zNorthHallBack, zFront, round3(cx0 - hw), true, false));
    // 東ウイング (cx1 + hw .. xR, zNorthHallBack .. zFront)
    normalRooms.push(...this.splitZoneRooms(round3(cx1 + hw), xR, zNorthHallBack, zFront, round3(cx1 + hw), true, false));
    // 北棟（外交エリア: xL .. xR, zBackExt .. zNorthHallBack）
    const northRooms = this.splitBackRooms(xL, xR, zBackExt, zNorthHallBack, cx0, cx1);
    normalRooms.push(...northRooms);

    this.assignTypes(normalRooms);

    const doorW = tpl.door.width;
    const archW = round3(Math.max(1.4, hw - this.t - 0.04));
    if (!this.connect(lobby, westHall, false, archW)) this.fail('ロビー→西廊下接続失敗');
    if (!this.connect(lobby, eastHall, false, archW)) this.fail('ロビー→東廊下接続失敗');
    if (!this.connect(westHall, northHall, false, archW)) this.fail('西廊下→北廊下接続失敗');
    if (!this.connect(eastHall, northHall, false, archW)) this.fail('東廊下→北廊下接続失敗');

    const spawnDoor = this.connect(frontPortico, lobby, true, Math.min(1.5, doorW + 0.3), true);
    if (!spawnDoor) this.fail('大使館正面玄関を配置できません');

    // 中庭へのガラスドア
    this.connect(lobby, innerCourt, true, doorW, false);
    this.connect(northHall, innerCourt, true, doorW, false);

    // 各ウイング部屋を廊下・隣接室経由で接続
    this.connectWingRooms(normalRooms, [westHall, eastHall, lobby], doorW);

    // 北棟の接続
    for (const nr of northRooms) {
      const ok =
        this.connect(northHall, nr, true, doorW) ||
        this.connect(westHall, nr, true, doorW) ||
        this.connect(eastHall, nr, true, doorW);
      if (!ok) {
        const idx = northRooms.indexOf(nr);
        const prev = idx > 0 ? northRooms[idx - 1] : undefined;
        const next = idx + 1 < northRooms.length ? northRooms[idx + 1] : undefined;
        if (!(prev && this.connect(prev, nr, true, doorW)) && !(next && this.connect(next, nr, true, doorW))) {
          this.fail('北棟部屋を接続できません');
        }
      }
    }

    // 東西ウイング前面のサブ汎用入口（突入ルート選択肢）
    const westFront = normalRooms.find((r) => Math.abs(r.rect.z1 - zFront) < EPS && r.rect.x1 <= cx0 && !r.type?.private);
    if (westFront) this.connect(frontYard, westFront, true, doorW, true);
    const eastFront = normalRooms.find((r) => Math.abs(r.rect.z1 - zFront) < EPS && r.rect.x0 >= cx1 && !r.type?.private);
    if (eastFront) this.connect(frontYard, eastFront, true, doorW, true);

    this.addExtraConnections();
    return { spawnDoor, frontYard };
  }

  // ---------------------------------------------------------------------------
  // Legacy center_I / center_T fallback (outdoor start)
  // ---------------------------------------------------------------------------
  private buildLegacyCenter(layout: 'center_I' | 'center_T', xL: number, xR: number, zBackExt: number, zFront: number, P: number): { spawnDoor?: PlacedOpening; frontYard: GenRoom } {
    const tpl = this.tpl;
    const rng = this.rng;
    const hw = this.snap(rng.inRange(tpl.hallway.width));
    const { minWidth: sideMin, maxWidth: sideMax } = tpl.sideZone;
    const hLo = Math.max(xL + sideMin, xR - hw - sideMax);
    const hHi = Math.min(xR - sideMin - hw, xL + sideMax);
    if (hLo > hHi + EPS) this.fail('廊下を置ける幅がありません');
    const hx0 = this.snap(rng.range(hLo, hHi));
    const hx1 = round3(hx0 + hw);
    let zBack = zBackExt;
    if (layout === 'center_T') zBack = this.snap(zBackExt + rng.inRange(tpl.backZone.depth));
    if (zFront - zBack < tpl.hallway.minLength) this.fail('廊下が短すぎます');

    const frontYard = this.addOutdoor('porch', tpl.special.porch.name, { x0: xL - 1.5, z0: zFront, x1: xR + 1.5, z1: round3(zFront + P) }, tpl.special.porch.furniture);
    let hallZ1 = zFront;
    let genkan: GenRoom | undefined;
    if (rng.chance(tpl.genkan.chance)) {
      const gd = this.snap(rng.inRange(tpl.genkan.depth));
      if (zFront - gd - zBack >= tpl.hallway.minLength) {
        hallZ1 = round3(zFront - gd);
        genkan = this.addRoom('genkan', tpl.special.genkan.name, 'genkan', { x0: hx0, z0: hallZ1, x1: hx1, z1: zFront }, {
          front: true, back: false, spawnWeight: tpl.special.genkan.spawnWeight, furniture: tpl.special.genkan.furniture,
        });
      }
    }
    const hall = this.addRoom('hallway', tpl.special.hallway.name, 'hall', { x0: hx0, z0: zBack, x1: hx1, z1: hallZ1 }, {
      front: !genkan, back: Math.abs(zBack - zBackExt) < EPS, spawnWeight: tpl.special.hallway.spawnWeight, furniture: tpl.special.hallway.furniture,
    });

    const normalRooms: GenRoom[] = [
      ...this.splitZoneRooms(xL, hx0, zBack, zFront, hx0, true, false),
      ...this.splitZoneRooms(hx1, xR, zBack, zFront, hx1, true, false),
    ];
    const backRooms = layout === 'center_T' ? this.splitBackRooms(xL, xR, zBackExt, zBack, hx0, hx1) : [];
    normalRooms.push(...backRooms);

    this.assignTypes(normalRooms);

    const doorW = tpl.door.width;
    const spawnDoor = this.connect(frontYard, genkan ?? hall, true, doorW, true);
    if (!spawnDoor) this.fail('玄関ドアを置けません');
    if (genkan) {
      const arch = rng.chance(tpl.genkan.archChance);
      if (!this.connect(genkan, hall, !arch, arch ? this.archWidthFor(genkan, hall) : doorW)) this.fail('玄関→廊下接続失敗');
    }
    for (const r of normalRooms) {
      if (r.slot === 'back') continue;
      if (r.slot === 'nested') {
        if (!r.parent || !this.connect(r.parent, r, true, doorW)) this.fail('奥の部屋接続失敗');
        continue;
      }
      if (!this.connect(hall, r, true, doorW) && !(genkan && this.connect(genkan, r, true, doorW))) {
        this.fail(`${r.name} に入口を置けません`);
      }
    }
    this.connectBackRooms(backRooms, hall);
    this.addExtraConnections();
    return { spawnDoor, frontYard };
  }

  // ---------------------------------------------------------------------------
  // Shared zone/connection/window helpers
  // ---------------------------------------------------------------------------

  private splitZoneRooms(
    zx0: number,
    zx1: number,
    z0: number,
    z1: number,
    nearX: number,
    allowFrontFlag: boolean,
    isBack: boolean,
  ): GenRoom[] {
    const out: GenRoom[] = [];
    const n = this.tpl.nested;
    for (const [rz0, rz1] of this.splitDepth(z0, z1, this.tpl.sideZone.roomDepth)) {
      const rect: Rect = { x0: zx0, z0: rz0, x1: zx1, z1: rz1 };
      const front = allowFrontFlag && Math.abs(rz1 - z1) < EPS;
      const width = zx1 - zx0;
      if (this.rng.chance(n.chance) && width >= n.minInnerWidth + n.minOuterWidth) {
        const innerW = this.snap(this.rng.range(n.minInnerWidth, width - n.minOuterWidth));
        const split = nearX === zx1 ? round3(zx1 - innerW) : round3(zx0 + innerW);
        const innerRect: Rect = nearX === zx1 ? { ...rect, x0: split } : { ...rect, x1: split };
        const outerRect: Rect = nearX === zx1 ? { ...rect, x1: split } : { ...rect, x0: split };
        const inner = this.addRoom('room', '', 'room', innerRect, { front, back: isBack, slot: 'side' });
        const outer = this.addRoom('room', '', 'room', outerRect, { front, back: isBack, slot: 'nested', parent: inner });
        out.push(inner, outer);
      } else {
        out.push(this.addRoom('room', '', 'room', rect, { front, back: isBack, slot: 'side' }));
      }
    }
    return out;
  }

  private splitBackRooms(xL: number, xR: number, z0: number, z1: number, hx0: number, hx1: number): GenRoom[] {
    const out: GenRoom[] = [];
    const count = this.rng.intInRange(this.tpl.backZone.roomCount);
    const minW = this.tpl.backZone.minRoomWidth;
    const minDoorEdge = this.tpl.door.width + this.t + this.tpl.door.margin * 2 + 0.15;
    const cuts: number[] = [];
    for (let k = 1; k < count; k++) {
      for (let tryN = 0; tryN < 24; tryN++) {
        const x = this.snap(this.rng.range(xL + minW, xR - minW));
        if (x > hx0 - minDoorEdge && x < hx1 + minDoorEdge) continue;
        if (cuts.some((c) => Math.abs(c - x) < minW)) continue;
        cuts.push(x);
        break;
      }
    }
    cuts.sort((a, b) => a - b);
    const xs = [xL, ...cuts, xR];
    for (let i = 0; i + 1 < xs.length; i++) {
      out.push(
        this.addRoom('room', '', 'room', { x0: xs[i] as number, z0, x1: xs[i + 1] as number, z1 }, {
          front: false,
          back: true,
          slot: 'back',
        }),
      );
    }
    return out;
  }

  private connectWingRooms(wingRooms: GenRoom[], hubs: readonly GenRoom[], doorW: number): void {
    const sideRooms = wingRooms.filter((r) => r.slot !== 'back' && r.slot !== 'nested');
    const attached = new Set<GenRoom>();
    for (const r of sideRooms) {
      for (const hub of hubs) {
        if (this.connect(hub, r, true, doorW)) {
          attached.add(r);
          break;
        }
      }
    }
    // フロント張出室など廊下と直接辺を共有できない室は同ウイングの接続済み隣接室経由で接続
    let progress = true;
    while (progress) {
      progress = false;
      for (const r of sideRooms) {
        if (attached.has(r)) continue;
        for (const neighbor of sideRooms) {
          if (!attached.has(neighbor)) continue;
          if (this.connect(neighbor, r, true, doorW)) {
            attached.add(r);
            progress = true;
            break;
          }
        }
      }
    }
    for (const r of sideRooms) {
      if (!attached.has(r)) this.fail(`${r.name || 'ウイング室'} に入口を作れません`);
    }
    for (const r of wingRooms) {
      if (r.slot !== 'nested') continue;
      if (!r.parent || !this.connect(r.parent, r, true, doorW)) {
        this.fail('奥の部屋を接続できません');
      }
    }
  }

  private connectBackRooms(backRooms: GenRoom[], hall: GenRoom): void {
    if (backRooms.length === 0) return;
    const doorW = this.tpl.door.width;
    const head = backRooms.find((r) => sharedEdge(r.rect, hall.rect));
    if (!head) this.fail('廊下の突き当たりに部屋がありません');
    const archHead = this.isArchPair(head, hall) && this.rng.chance(this.tpl.door.archChance);
    if (!this.connect(hall, head, !archHead, archHead ? this.archWidthFor(hall, head) : doorW)) {
      this.fail('奥区画の入口を置けません');
    }
    for (let i = 0; i + 1 < backRooms.length; i++) {
      const a = backRooms[i] as GenRoom;
      const b = backRooms[i + 1] as GenRoom;
      const arch = this.isArchPair(a, b) && this.rng.chance(this.tpl.door.archChance);
      if (!this.connect(a, b, !arch, arch ? this.archWidthFor(a, b) : doorW)) {
        this.fail('奥区画の部屋同士を接続できません');
      }
    }
  }

  private addExtraConnections(): void {
    const normal = this.rooms.filter((r) => r.kind === 'room');
    for (let i = 0; i < normal.length; i++) {
      for (let j = i + 1; j < normal.length; j++) {
        const a = normal[i] as GenRoom;
        const b = normal[j] as GenRoom;
        if (a.type?.private || b.type?.private || this.connected(a, b)) continue;
        if (!this.rng.chance(this.tpl.door.extraConnectChance)) continue;
        this.connect(a, b, true, this.tpl.door.width);
      }
    }
  }

  private verifyReachability(): void {
    const visited = new Set<GenRoom>();
    const queue: GenRoom[] = [];
    for (const r of this.rooms) {
      if (r.outdoor) {
        visited.add(r);
        queue.push(r);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]!;
      for (const o of this.openings) {
        if (o.window || !o.b) continue;
        if (o.a === cur && !visited.has(o.b)) {
          visited.add(o.b);
          queue.push(o.b);
        } else if (o.b === cur && !visited.has(o.a)) {
          visited.add(o.a);
          queue.push(o.a);
        }
      }
    }
    for (const r of this.rooms) {
      if (!r.outdoor && !visited.has(r)) {
        this.fail(`到達不能な部屋があります: ${r.name || r.id}`);
      }
    }
  }

  private placeExteriorWindows(): WindowDef[] {
    const winChance = this.tpl.door.windowChance ?? 0.55;
    if (winChance <= 0) return [];
    const windows: WindowDef[] = [];
    const indoor = this.rooms.filter((r) => !r.outdoor);
    const indoorRects = indoor.map((r) => r.rect);

    for (const r of indoor) {
      if (r.kind === 'hall' || r.type?.private) continue;
      if (!this.rng.chance(winChance)) continue;

      const edges: { axis: 'x' | 'z'; c: number; lo: number; hi: number }[] = [
        { axis: 'x', c: r.rect.z0, lo: r.rect.x0, hi: r.rect.x1 },
        { axis: 'x', c: r.rect.z1, lo: r.rect.x0, hi: r.rect.x1 },
        { axis: 'z', c: r.rect.x0, lo: r.rect.z0, hi: r.rect.z1 },
        { axis: 'z', c: r.rect.x1, lo: r.rect.z0, hi: r.rect.z1 },
      ];

      for (const e of this.rng.shuffle(edges)) {
        // 他室と共有する部分は除外し、完全に屋外へ面する単一セグメントだけを探す
        const overlapsIndoor = indoor.some((other) => {
          if (other === r) return false;
          const sh = sharedEdge(r.rect, other.rect);
          return sh !== null && sh.axis === e.axis && Math.abs(sh.c - e.c) < EPS;
        });
        if (overlapsIndoor) continue;

        const wWidth = Math.min(1.4, round3((e.hi - e.lo) * 0.45));
        if (wWidth < 0.85) continue;
        const center = pickOpeningCenter(this.rng, e, wWidth, 0.35, this.t, indoorRects, this.openings, this.tpl.snap);
        if (center === null) continue;

        const sill = 1.05;
        const height = Math.min(1.1, this.tpl.ceilingHeight - sill - 0.35);
        if (height < 0.5) continue;

        this.openings.push({
          axis: e.axis,
          c: e.c,
          center,
          width: wWidth,
          a: r,
          isDoor: false,
          exterior: true,
          locked: false,
          window: { sill, height },
        });
        windows.push({
          x: e.axis === 'x' ? center : e.c,
          z: e.axis === 'x' ? e.c : center,
          yaw: e.axis === 'x' ? 0 : 90,
          width: wWidth,
          height,
          sill,
        });
        break;
      }
    }
    return windows;
  }

  private addOutdoor(idBase: string, name: string, rect: Rect, furniture: readonly FurnitureDef[]): GenRoom {
    const room: GenRoom = {
      id: idBase,
      name,
      kind: 'outdoor',
      outdoor: true,
      rect,
      front: false,
      back: false,
      spawnWeight: 0,
      furniture,
    };
    this.rooms.push(room);
    return room;
  }

  private addRoom(
    idBase: string,
    name: string,
    kind: AreaKind,
    rect: Rect,
    opts: { front: boolean; back: boolean; slot?: RoomSlot; parent?: GenRoom; spawnWeight?: number; furniture?: readonly FurnitureDef[] },
  ): GenRoom {
    const room: GenRoom = {
      id: idBase,
      name,
      kind,
      outdoor: false,
      rect,
      front: opts.front,
      back: opts.back,
      spawnWeight: opts.spawnWeight ?? 0,
      furniture: opts.furniture ?? [],
    };
    if (opts.slot) room.slot = opts.slot;
    if (opts.parent) room.parent = opts.parent;
    this.rooms.push(room);
    return room;
  }

  private splitDepth(z0: number, z1: number, range: { min: number; max: number }): [number, number][] {
    const out: [number, number][] = [];
    let z = z1;
    while (z - z0 > EPS) {
      const remaining = z - z0;
      let d: number;
      if (remaining <= range.max + EPS) {
        d = remaining;
      } else if (remaining < range.min * 2) {
        d = this.snap(remaining / 2);
      } else {
        d = this.snap(this.rng.range(range.min, Math.min(range.max, remaining - range.min)));
      }
      const next = round3(Math.max(z0, z - d));
      out.push([next, z]);
      z = next;
    }
    return out;
  }

  private assignTypes(rooms: GenRoom[]): void {
    const tpl = this.tpl;
    const counts = new Map<string, number>();
    const fits = (t: RoomTypeDef, r: GenRoom): boolean => {
      if (!r.slot || !t.slots.includes(r.slot)) return false;
      const area = rectArea(r.rect);
      const minSide = Math.min(rectW(r.rect), rectD(r.rect));
      return area >= t.minArea - EPS && area <= t.maxArea + EPS && minSide >= t.minSide - EPS;
    };
    const score = (t: RoomTypeDef, r: GenRoom): number => {
      const area = rectArea(r.rect);
      const jitter = this.rng.next() * 0.01;
      switch (t.prefer) {
        case 'largest':
          return area + jitter;
        case 'smallest':
          return -area + jitter;
        case 'front':
          return (r.front ? 1000 : 0) + area * 0.01 + jitter;
        case 'back':
          return (r.back ? 1000 : 0) + area * 0.01 + jitter;
        default:
          return jitter;
      }
    };
    const apply = (t: RoomTypeDef, r: GenRoom): void => {
      r.type = t;
      counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
    };
    for (const t of tpl.roomTypes) {
      for (let k = 0; k < t.minCount; k++) {
        let best: GenRoom | undefined;
        let bestScore = -Infinity;
        for (const r of rooms) {
          if (r.type || !fits(t, r)) continue;
          const s = score(t, r);
          if (s > bestScore) {
            bestScore = s;
            best = r;
          }
        }
        if (!best) this.fail(`必須の部屋タイプ「${t.name}」を割り当てられません`);
        apply(t, best);
      }
    }
    const fallback = tpl.roomTypes.find((t) => t.id === tpl.fallbackRoomType);
    for (const r of this.rng.shuffle(rooms.filter((x) => !x.type))) {
      const cands = tpl.roomTypes.filter((t) => (counts.get(t.id) ?? 0) < t.maxCount && fits(t, r));
      const t = this.rng.weighted(cands, (c) => c.weight) ?? fallback;
      if (!t) this.fail('部屋タイプを割り当てられません');
      apply(t, r);
    }
    const totals = new Map<string, number>();
    for (const r of rooms) if (r.type) totals.set(r.type.id, (totals.get(r.type.id) ?? 0) + 1);
    for (const r of rooms) {
      const t = r.type;
      if (!t) continue;
      const n = (this.idCounts.get(t.id) ?? 0) + 1;
      this.idCounts.set(t.id, n);
      const multi = (totals.get(t.id) ?? 0) > 1;
      r.id = multi ? `${t.id}_${n}` : t.id;
      r.name = multi ? `${t.name}${n}` : t.name;
      r.spawnWeight = t.spawnWeight;
      r.furniture = t.furniture;
    }
  }

  private isArchPair(a: GenRoom, b: GenRoom): boolean {
    const ids = this.tpl.door.archRoomTypes;
    const ok = (r: GenRoom): boolean => r.kind === 'hall' || (r.type !== undefined && ids.includes(r.type.id));
    return ok(a) && ok(b) && (a.kind !== 'hall' || b.kind !== 'hall');
  }

  private archWidthFor(a: GenRoom, b: GenRoom): number {
    const e = sharedEdge(a.rect, b.rect);
    if (!e) return this.tpl.door.archWidth;
    const maxW = e.hi - e.lo - this.t - 0.04;
    return round3(Math.max(this.tpl.door.width, Math.min(this.tpl.door.archWidth, maxW)));
  }

  private connected(a: GenRoom, b: GenRoom): boolean {
    return this.openings.some((o) => (o.a === a && o.b === b) || (o.a === b && o.b === a));
  }

  private connect(a: GenRoom, b: GenRoom, isDoor: boolean, width: number, exterior = false): PlacedOpening | undefined {
    const edge = sharedEdge(a.rect, b.rect);
    if (!edge) return undefined;
    const margin = isDoor ? this.tpl.door.margin : 0;
    const indoorRects = this.rooms.filter((r) => !r.outdoor).map((r) => r.rect);
    const center = pickOpeningCenter(
      this.rng,
      edge,
      width,
      margin,
      this.t,
      indoorRects,
      this.openings,
      this.tpl.snap,
    );
    if (center === null) return undefined;
    const placed: PlacedOpening = {
      axis: edge.axis,
      c: edge.c,
      center,
      width,
      lintelY: this.storyH,
      a,
      b,
      isDoor,
      exterior,
      locked: false,
    };
    this.openings.push(placed);
    return placed;
  }

  private placeEntities(spawn: { x: number; z: number }): EntityDef[] {
    const tpl = this.tpl;
    const ec = tpl.entities;
    const rng = this.rng;
    const entities: EntityDef[] = [];
    const occupancy = new Map<GenRoom, number>();
    const r = ec.clearance;
    const candidates = this.rooms.filter((x) => !x.outdoor && x.spawnWeight > 0);

    const tryPlaceIn = (room: GenRoom, near?: { x: number; z: number; min: number; max: number }): { x: number; z: number } | null => {
      const it = inset(room.rect, this.t / 2 + r + 0.05);
      if (it.x1 <= it.x0 || it.z1 <= it.z0) return null;
      for (let i = 0; i < 40; i++) {
        let x: number;
        let z: number;
        if (near) {
          const ang = rng.range(0, Math.PI * 2);
          const dist = rng.range(near.min, near.max);
          x = near.x + Math.cos(ang) * dist;
          z = near.z + Math.sin(ang) * dist;
          if (x < it.x0 || x > it.x1 || z < it.z0 || z > it.z1) continue;
        } else {
          x = rng.range(it.x0, it.x1);
          z = rng.range(it.z0, it.z1);
        }
        if (Math.hypot(x - spawn.x, z - spawn.z) < ec.minSpawnDistance) continue;
        if (!this.grid.canStand(x, z, r, entities, 1.0)) continue;
        return { x: round3(x), z: round3(z) };
      }
      return null;
    };
    const pickRoom = (exclude: Set<GenRoom>): GenRoom | undefined =>
      rng.weighted(
        candidates.filter((c) => !exclude.has(c)),
        (c) => c.spawnWeight / (1 + (occupancy.get(c) ?? 0)),
      );
    const yawToward = (from: { x: number; z: number }, room: GenRoom): number => {
      let best: { x: number; z: number } | null = null;
      let bestD = Infinity;
      for (const o of this.openings) {
        if (o.window || (o.a !== room && o.b !== room)) continue;
        const p = o.axis === 'x' ? { x: o.center, z: o.c } : { x: o.c, z: o.center };
        const d = Math.hypot(p.x - from.x, p.z - from.z);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (!best) return rng.range(0, 360);
      const yaw = (Math.atan2(-(best.x - from.x), -(best.z - from.z)) * 180) / Math.PI;
      return round3(yaw + rng.range(-15, 15));
    };

    const suspectRooms: { room: GenRoom; pos: { x: number; z: number } }[] = [];
    const profileCounts = new Map<string, number>();
    const nSuspects = rng.intInRange(ec.suspects);
    for (let i = 0; i < nSuspects; i++) {
      const tried = new Set<GenRoom>();
      for (let k = 0; k < candidates.length; k++) {
        const room = pickRoom(tried);
        if (!room) break;
        tried.add(room);
        const pos = tryPlaceIn(room);
        if (!pos) continue;
        const prof = rng.weighted(
          ec.suspectProfiles.filter((p) => (profileCounts.get(p.profile) ?? 0) < p.max),
          (p) => p.weight,
        );
        if (!prof) break;
        profileCounts.set(prof.profile, (profileCounts.get(prof.profile) ?? 0) + 1);
        entities.push({
          id: `suspect_${entities.filter((e) => e.type === 'suspect').length + 1}`,
          type: 'suspect',
          profile: prof.profile,
          ...pos,
          yaw: yawToward(pos, room),
        });
        occupancy.set(room, (occupancy.get(room) ?? 0) + 1);
        suspectRooms.push({ room, pos });
        break;
      }
    }

    const nCivilians = rng.intInRange(ec.civilians);
    for (let i = 0; i < nCivilians; i++) {
      let placed: { x: number; z: number } | null = null;
      let placedRoom: GenRoom | undefined;
      if (suspectRooms.length > 0 && rng.chance(ec.hostagePairChance)) {
        const s = rng.pick(suspectRooms);
        if (s) {
          placed = tryPlaceIn(s.room, { x: s.pos.x, z: s.pos.z, min: 1.2, max: 2.6 });
          placedRoom = s.room;
        }
      }
      if (!placed) {
        const tried = new Set<GenRoom>();
        for (let k = 0; k < candidates.length && !placed; k++) {
          const room = pickRoom(tried);
          if (!room) break;
          tried.add(room);
          placed = tryPlaceIn(room);
          placedRoom = room;
        }
      }
      if (!placed || !placedRoom) continue;
      entities.push({
        id: `civilian_${entities.filter((e) => e.type === 'civilian').length + 1}`,
        type: 'civilian',
        profile: ec.civilianProfile,
        ...placed,
        yaw: round3(rng.range(0, 360)),
      });
      occupancy.set(placedRoom, (occupancy.get(placedRoom) ?? 0) + 1);
    }
    return entities;
  }
}
