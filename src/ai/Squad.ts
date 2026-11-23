import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import { CivilianState, SuspectState } from '../core/events';
import type { InputManager } from '../core/InputManager';
import type { AllyDef, ArrestConfig, RoomDef, SquadConfig, SquadElement, SquadOrder, Vec3 } from '../core/types';
import type { PlayerController } from '../player/PlayerController';
import type { HitTarget, WeaponSystem } from '../weapons/WeaponSystem';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Collider } from '../world/WorldBuilder';
import { legacyZeroFallbackOf, nextFootY, probeGround, type StairMark } from '../world/Walk';
import type { TextureLibrary } from '../world/Materials';
import type { Door, DoorSystem } from '../world/Door';
import { AIDebugLabel } from '../ui/AIDebugLabel';
import { CommandMenu, type ActiveMarker, type OrderContext } from '../ui/CommandMenu';
import type { FloorPlanAllyState, FloorPlanWaypoint } from '../ui/Minimap';
import {
  distToSegment,
  pathSegmentClear,
  pickBestStair,
  SQUAD_GOAL_TOLERANCE,
  squadRoute,
  STAIR_FLOOR_MATCH,
  stairEntry,
  stairExit,
  stairExitReached,
  stairFloorY,
  stairRunTarget,
  reachableRouteLength,
  type StairChoice,
} from './SquadRoute';
import { blockedAt, resolveOverlap, stepToward, type XZ } from './EngageBehavior';
import { layoutStackSlots } from './stackSlots';
import { shieldBlocks } from './ShieldGuard';
import { HumanoidBody } from './HumanoidBody';
import { segmentHitsAABB } from './HostageShield';
import type { EntityManager } from './EntityManager';

export {
  SQUAD_GOAL_TOLERANCE,
  stairEntry,
  stairExit,
  stairFloorY,
  stairExitReached,
  reachableRouteLength,
  pickBestStair,
  stairRunTarget,
  type StairChoice,
};

const MAX_DT = 0.05;
/** 追従隊列の列間隔（m） */
const FOLLOW_ROW_GAP = 0.9;

/** 隊員番号 → チーム（前半 ALPHA / 後半 BRAVO）と表示用コールサイン */
export function assignElement(index: number, total: number): { elementKey: 'alpha' | 'bravo'; callsign: string } {
  const alphaSize = Math.ceil(total / 2);
  const isAlpha = index < alphaSize;
  const n = isAlpha ? index + 1 : index - alphaSize + 1;
  const team = isAlpha ? 'ALPHA' : 'BRAVO';
  const teamSize = isAlpha ? alphaSize : total - alphaSize;
  return { elementKey: isAlpha ? 'alpha' : 'bravo', callsign: teamSize > 1 ? `${team}-${n}` : team };
}
/** 視認セル（クリアリング範囲）を全件判定し直す周期（秒）。セル数×視点数の視線判定になるため短すぎると大型マップで CPU を食い尽くす */
const COVERAGE_PERIOD = 0.25;
/** 階段候補の到達判定（経路探索）をやり直す間隔（s） */
const STAIR_PICK_INTERVAL = 1.0;
/** タイムアウトしたドアを一時的に通行不能扱いする時間（s） */
const SKIPPED_DOOR_TTL = 4.0;

export interface Cell extends XZ {
  y: number;
  room: RoomDef;
  seen: boolean;
  visible: boolean;
}

type TacticalPhase =
  | 'follow'
  | 'hold'
  | 'move'
  | 'overwatch'
  | 'stacking'
  | 'door_prep'
  | 'flash_wait'
  | 'entering'
  | 'sweeping'
  | 'restraining'
  | 'secured';

interface EntryPortal {
  id: string;
  centerX: number;
  centerZ: number;
  sillY: number;
  intoX: number;
  intoZ: number;
  axisX: number;
  axisZ: number;
  width: number;
  door: Door | null;
}

interface AllyUnit extends HitTarget {
  name: string;
  /** 無線・HUD 表示用（例: ALPHA-1） */
  callsign: string;
  elementKey: 'alpha' | 'bravo';
  index: number;
  roleIndex: number;
  groupSize: number;
  body: HumanoidBody;
  order: SquadOrder;
  phase: TacticalPhase;
  holdPos: { x: number; y: number; z: number } | null;
  moveTarget: { x: number; y: number; z: number; yawRad: number } | null;
  watchYaw: number;
  approach: number;
  door: Door | null;
  entryPortal: EntryPortal | null;
  stackPos: XZ | null;
  podPos: XZ | null;
  podLook: Vec3 | null;
  targetRoom: RoomDef | null;
  entryDelay: number;
  phaseTimer: number;
  doorWait: number;
  flashed: boolean;
  path: XZ[];
  pathGoal: XZ | null;
  retry: number;
  entered: boolean;
  sweepCell: Cell | null;
  vantage: XZ | null;
  skipped: Set<Cell>;
  sweepElapsed: number;
  assignment: string | null;
  restrainTargetId: string | null;
  holdTime: number;
  fireCd: number;
  warnCd: number;
  hp: number;
  maxHp: number;
  down: boolean;
  engaging: boolean;
  holdingFire: boolean;
  progress: string;
  stalled: number;
  stuckStage: 0 | 1 | 2;
  anchor: XZ;
  doorOpenTimer: number;
  doorOpenTargetId: string | null;
  skippedDoors: Map<string, number>;
  stackWaitTimer: number;
  /** 昇降中の階段（退出点に着くまで同じ階段を進み続ける） */
  activeStair: { id: string; up: boolean } | null;
  /** 階段選択のキャッシュ（経路探索を毎フレーム回さない） */
  stairPick: { up: boolean; floorY: number; id: string; timer: number } | null;
  label: AIDebugLabel;
}

interface ThrownFlash {
  start: THREE.Vector3;
  end: THREE.Vector3;
  elapsed: number;
  flightSec: number;
  fuseSec: number;
  detonated: boolean;
  mesh: THREE.Mesh;
}

export interface SquadRosterEntry {
  id: string;
  name: string;
  callsign: string;
  hp: number;
  maxHp: number;
  down: boolean;
  orderLabel: string;
  statusText: string;
  selected: boolean;
}

/**
 * CQB 分隊AI + 隊長指揮システム。
 * - 指示系統: GOLD(全員) / ALPHA(Miller) / BRAVO(Cole)
 * - 扉クリア: スタック → 開放/蹴破り → (実体投擲フラッシュ) → 時間差交互突入(PoD確保) → 死角クリア → 相互援護拘束・証拠回収
 * - 扉前スタックは人数ぶん別の位置を取る（2人までは左右、3人目以降は後方の縦列）
 * - 指定位置移動(move)・射線ロック(overwatch)・対象確保(restrain)・残務自動掃討
 */
export class SquadSystem {
  readonly coverage: Cell[] = [];
  private sampleTimer = 0;
  /** 視認セル判定の巡回位置（毎フレーム一部ずつ処理する） */
  private coverageCursor = 0;
  private doorStages = '';
  private ack = '';
  private ackLeft = 0;
  private selectedElement: SquadElement = 'gold';
  private postClearActive = false;
  private postClearAnnounced = false;

  readonly root = new THREE.Group();
  private readonly allies: AllyUnit[] = [];
  private readonly provoked = new Set<string>();
  private readonly announcedRooms = new Set<string>();
  private readonly announcedStacks = new Set<string>();
  private readonly unsubs: (() => void)[] = [];
  private readonly menu: CommandMenu;

  private readonly thrownFlashes: ThrownFlash[] = [];
  private readonly flashGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.13, 10);
  private readonly flashMat = new THREE.MeshStandardMaterial({ color: 0x3b4d6b, roughness: 0.55 });
  private readonly burstMesh: THREE.Mesh;
  private burstLife = 0;
  private disposed = false;

  constructor(
    defs: readonly AllyDef[],
    private readonly cfg: SquadConfig,
    private readonly player: PlayerController,
    private readonly input: InputManager,
    private readonly colliders: readonly Collider[],
    private readonly bounds: { width: number; depth: number },
    private readonly stairs: readonly StairMark[],
    private readonly doors: DoorSystem,
    private readonly entities: EntityManager,
    private readonly bus: GameEventBus,
    textures: TextureLibrary,
    private readonly weapons: WeaponSystem,
    private readonly flash: { range: number; blindSec: number },
    private readonly rooms: readonly RoomDef[],
    private readonly arrestCfg: ArrestConfig,
  ) {
    for (const room of this.rooms) {
      if (room.outdoor) continue;
      const y = room.floorY ?? 0;
      for (let x = room.x - room.width / 2 + 0.25; x < room.x + room.width / 2; x += 0.5) {
        for (let z = room.z - room.depth / 2 + 0.25; z < room.z + room.depth / 2; z += 0.5) {
          if (!blockedAt(this.colliders, x, z, 0.04, y)) {
            this.coverage.push({ x, z, y, room, seen: false, visible: false });
          }
        }
      }
    }

    this.root.name = 'squad';
    this.menu = new CommandMenu(cfg, player, doors, colliders, entities, rooms);
    this.root.add(this.menu.root);

    this.input.onOrderMenu = (event, value) => {
      this.menu.handleMenuEvent(event, value, this.selectedElement, (order, ctx) => {
        this.executeOrder(order, ctx);
      });
    };
    this.unsubs.push(() => {
      this.input.onOrderMenu = undefined;
    });

    defs.forEach((def, index) => {
      const body = new HumanoidBody(def.x, def.z, def.yaw ?? 0, 0x8ea878, true, {
        role: 'ally',
        footY: def.y ?? 0,
        textures,
        // 先頭の隊員（ポイントマン）は防弾盾 + ハンドガン: 盾越しに撃つ。足元・側面・背後以外の被弾は盾が止める
        shield: index === 0 && defs.length >= 2,
      });
      body.setReadyPose('low');
      const label = new AIDebugLabel();
      // 隊員を前半 ALPHA / 後半 BRAVO の 2 チームに均等分割（4 名なら 2+2、3 名なら 2+1）
      const { elementKey, callsign } = assignElement(index, defs.length);
      const ally: AllyUnit = {
        id: def.id,
        name: def.name,
        callsign,
        elementKey,
        index,
        roleIndex: index,
        groupSize: defs.length,
        body,
        order: 'follow',
        phase: 'follow',
        holdPos: null,
        moveTarget: null,
        watchYaw: (def.yaw ?? 0) * (Math.PI / 180),
        approach: 1,
        door: null,
        entryPortal: null,
        stackPos: null,
        podPos: null,
        podLook: null,
        targetRoom: null,
        entryDelay: 0,
        phaseTimer: 0,
        doorWait: 0,
        flashed: false,
        path: [],
        pathGoal: null,
        retry: 0,
        entered: false,
        sweepCell: null,
        vantage: null,
        skipped: new Set(),
        sweepElapsed: 0,
        assignment: null,
        restrainTargetId: null,
        holdTime: 0,
        fireCd: 0.35 + index * 0.15,
        warnCd: 0,
        hp: 100,
        maxHp: 100,
        down: false,
        engaging: false,
        holdingFire: false,
        progress: '追従中',
        stalled: 0,
        stuckStage: 0,
        anchor: { x: body.px, z: body.pz },
        doorOpenTimer: 0,
        doorOpenTargetId: null,
        skippedDoors: new Map(),
        stackWaitTimer: 0,
        activeStair: null,
        stairPick: null,
        label,
        getAABB: () => body.getAABB(),
        shieldBlocks: (from, hit) => shieldBlocks(body, from, hit),
      };
      this.allies.push(ally);
      this.root.add(body.group, label.sprite);
      this.weapons.addTarget(ally);
    });

    const burstGeo = new THREE.SphereGeometry(0.45, 10, 8);
    const burstMat = new THREE.MeshBasicMaterial({ color: 0xfff8dc, transparent: true, opacity: 0.9, depthWrite: false });
    this.burstMesh = new THREE.Mesh(burstGeo, burstMat);
    this.burstMesh.visible = false;
    this.root.add(this.burstMesh);

    this.unsubs.push(
      bus.on('entityHit', (e) => this.onHit(e.targetId, e.damage, e.nonlethal === true)),
      bus.on('suspectFired', (e) => this.provoked.add(e.id)),
    );
  }

  get count(): number {
    return this.allies.length;
  }

  get currentElement(): SquadElement {
    return this.selectedElement;
  }

  get elementLabel(): string {
    return this.cfg.elementLabels[this.selectedElement];
  }

  /** 交渉等を含め、指定点へ視線が通り威圧距離内にいる生存隊員数（チーム数値優位計算用）。 */
  countAlliesCovering(point: Vec3, maxDist = 10): number {
    let n = 0;
    const eye = new THREE.Vector3();
    for (const a of this.allies) {
      if (a.down) continue;
      a.body.eye(eye);
      const d = Math.hypot(point.x - eye.x, point.z - eye.z);
      if (d <= maxDist && Math.abs(point.y - eye.y) < 2.2 && hasLineOfSight(this.colliders, eye, point)) {
        n++;
      }
    }
    return n;
  }

  /** 視線が通る生存隊員の情報一覧（敵AI知覚・射撃ターゲット用）。 */
  getLivingAllies(): readonly { id: string; px: number; pz: number; footY: number; height: number; getEye(): Vec3; getChest(): Vec3; getAABB(): ReturnType<HumanoidBody['getAABB']>; shieldBlocks(from: Vec3, hit: Vec3): boolean }[] {
    return this.allies
      .filter((a) => !a.down)
      .map((a) => ({
        id: a.id,
        px: a.body.px,
        pz: a.body.pz,
        footY: a.body.footY,
        height: a.body.height,
        getEye: () => a.body.eye(new THREE.Vector3()),
        getChest: () => a.body.chestPos(),
        getAABB: () => a.body.getAABB(),
        shieldBlocks: (from, hit) => shieldBlocks(a.body, from, hit),
      }));
  }

  getRoster(): SquadRosterEntry[] {
    return this.allies.map((a) => ({
      id: a.id,
      name: a.name,
      callsign: a.callsign,
      hp: Math.max(0, Math.round(a.hp)),
      maxHp: a.maxHp,
      down: a.down,
      orderLabel: this.cfg.orderLabels[a.order],
      statusText: this.stateText(a),
      selected: this.selectedElement === 'gold' || this.selectedElement === a.elementKey,
    }));
  }

  getMinimapAllies(): FloorPlanAllyState[] {
    return this.allies.map((a) => ({
      name: a.name,
      x: a.body.px,
      z: a.body.pz,
      y: a.body.footY,
      yawRad: a.body.yawRad,
      down: a.down,
    }));
  }

  getMinimapWaypoints(): FloorPlanWaypoint[] {
    const out: FloorPlanWaypoint[] = [];
    for (const a of this.allies) {
      if (a.down || a.order !== 'move' || !a.moveTarget) continue;
      out.push({
        label: a.callsign.slice(0, 1),
        x: a.moveTarget.x,
        z: a.moveTarget.z,
        y: a.moveTarget.y,
        color: a.elementKey === 'alpha' ? '#56c8d8' : '#6be08b',
      });
    }
    return out;
  }

  hudText(): string {
    const look = this.aimedAlly();
    const lookLine = look ? `照準隊員: ${look.callsign} ${look.name} / ${this.stateText(look)}` : '';
    return [lookLine, this.ackLeft > 0 ? this.ack : ''].filter(Boolean).join('\n');
  }

  /** 全脅威制圧後に呼び出し、残っている投降容疑者・民間人・証拠武器を隊員が自律確保する。 */
  setPostClearActive(active: boolean): void {
    if (this.disposed) return;
    this.postClearActive = active;
    if (!active) return;
    const living = this.allies.filter((a) => !a.down);
    if (living.length === 0) return;
    if (!this.postClearAnnounced) {
      this.postClearAnnounced = true;
      this.emitRadio(
        living[0]!,
        '全脅威制圧。残余の拘束・人質確保・証拠品押収を実施する！',
        'All threats neutralized. Securing remaining targets and evidence.',
      );
    }
  }

  beginPostClearSweep(): void {
    this.setPostClearActive(true);
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);

    this.handleShortcuts();
    this.updateCoverage(dt);
    this.updateThrownFlashes(dt);
    this.updateMarkers();

    this.ackLeft = Math.max(0, this.ackLeft - dt);
    if (this.burstLife > 0) {
      this.burstLife -= dt;
      const mat = this.burstMesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, this.burstLife / 0.35);
      this.burstMesh.scale.setScalar(1 + (1 - Math.max(0, this.burstLife / 0.35)) * 1.4);
      this.burstMesh.visible = this.burstLife > 0;
    }

    for (const ally of this.allies) {
      ally.body.tick(dt);
      ally.fireCd = Math.max(0, ally.fireCd - dt);
      ally.warnCd = Math.max(0, ally.warnCd - dt);
      ally.doorWait = Math.max(0, ally.doorWait - dt);
      for (const [doorId, left] of ally.skippedDoors) {
        if (left - dt <= 0) ally.skippedDoors.delete(doorId);
        else ally.skippedDoors.set(doorId, left - dt);
      }
      if (!ally.down) {
        if (this.postClearActive && this.isIdleForPostSweep(ally)) {
          this.assignPostClearTask(ally);
        }
        this.tryEngage(ally, dt);
        if (!ally.engaging) this.tryWarn(ally);
        this.updateAllyTactics(ally, dt);
        this.applySeparation(ally, dt);
      }
      const c = ally.body.chestPos();
      ally.label.sprite.position.set(c.x, ally.body.footY + ally.body.height + 0.28, c.z);
      const distance = this.player.position.distanceTo(ally.body.group.position);
      const labelWidth = Math.min(0.78, Math.max(0.32, distance * 0.085));
      ally.label.sprite.scale.set(labelWidth, labelWidth / 4, 1);
      ally.label.set(`${ally.name} ${this.stateText(ally)}`, ally.down ? '#888888' : '#9fd0ff');
    }
  }

  private handleShortcuts(): void {
    if (!this.input.isPointerLocked || this.input.suppressSquadShortcuts || !this.player.alive) return;

    if (this.input.wasPressed('cycleElement')) {
      // 隊員がいないチームは飛ばす（隊員 1 名なら GOLD ⇔ ALPHA のみ）
      const order: SquadElement[] = ['gold', 'alpha', 'bravo'].filter(
        (el) => el === 'gold' || this.allies.some((a) => a.elementKey === el),
      ) as SquadElement[];
      const next = order[(order.indexOf(this.selectedElement) + 1) % order.length]!;
      this.selectedElement = next;
      const members = this.allies.filter((a) => next === 'gold' || a.elementKey === next).map((a) => a.name);
      this.ack = `指揮対象: ${this.cfg.elementLabels[next]}（${members.join('・')}）`;
      this.ackLeft = 1.2;
      this.menu.syncElementBadge(next);
    }

    if (this.input.isOrderMenuOpen) return;

    if (this.input.wasPressed('regroup')) {
      const ctx = this.menu.resolveContext(this.selectedElement);
      this.executeOrder('follow', ctx);
      return;
    }

    if (this.input.wasPressed('quickOrder')) {
      const ctx = this.menu.resolveContext(this.selectedElement);
      this.executeOrder(this.pickQuickOrder(ctx), ctx);
    }
  }

  /** Z キーで発令される指示を状況から決定する（実行と HUD 表示で共通）。 */
  private pickQuickOrder(ctx: OrderContext): SquadOrder {
    if (ctx.restrainTarget) return 'restrain';
    if (ctx.door) {
      const targets = this.activeTargets(ctx.element);
      const alreadyStacked =
        targets.length > 0 &&
        targets.every(
          (a) =>
            a.order === 'stack' &&
            a.door === ctx.door &&
            a.stackPos !== null &&
            Math.hypot(a.body.px - a.stackPos.x, a.body.pz - a.stackPos.z) <= 0.65,
        );
      if (alreadyStacked) return ctx.door.locked ? 'breachClear' : 'clear';
      return 'stack';
    }
    if (ctx.areaTarget) return 'clear';
    if (ctx.groundPoint) return 'move';
    return 'hold';
  }

  private quickHintCache = '';
  private quickHintTimer = 0;

  /** 画面下部に出す「Z : 〜〜」の文言。指示不可の状況では空文字。 */
  quickOrderHint(dt: number): string {
    this.quickHintTimer -= dt;
    if (this.quickHintTimer > 0) return this.quickHintCache;
    this.quickHintTimer = 0.1;
    if (this.disposed || this.activeTargets(this.selectedElement).length === 0) {
      this.quickHintCache = '';
    } else {
      const order = this.pickQuickOrder(this.menu.resolveContext(this.selectedElement));
      this.quickHintCache = `Z : ${this.cfg.orderLabels[order]}`;
    }
    return this.quickHintCache;
  }

  private updateCoverage(dt: number): void {
    this.sampleTimer -= dt;
    if (this.sampleTimer <= 0) {
      this.sampleTimer += 0.1;
      const stages = this.doors.doors.map((d) => d.stage).join(',');
      if (stages !== this.doorStages) {
        for (const ally of this.allies) ally.skipped.clear();
        this.doorStages = stages;
      }
    }
    // 全セルの視線判定は大型マップで 1 回数十〜百 ms かかるため、まとめて行わず
    // COVERAGE_PERIOD 秒で一巡するよう毎フレーム dt に比例した分だけ処理する（スパイク防止）
    const total = this.coverage.length;
    if (total === 0) return;
    const chunk = Math.min(total, Math.ceil((total * Math.min(dt, MAX_DT)) / COVERAGE_PERIOD));
    const eye = this.player.getEyePosition();
    const observers = this.allies
      .filter((a) => !a.down)
      .map((a) => ({
        feet: a.body.footY,
        eye: a.body.eye(new THREE.Vector3()),
        dir: a.body.gaze(new THREE.Vector3()),
      }));
    for (let n = 0; n < chunk; n++) {
      if (this.coverageCursor >= total) this.coverageCursor = 0;
      const cell = this.coverage[this.coverageCursor++]!;
      const target = { x: cell.x, y: cell.y + 0.35, z: cell.z };
      cell.visible =
        Math.abs(this.player.position.y - cell.y) < 0.7 &&
        this.player.inCameraView(target) &&
        hasLineOfSight(this.colliders, eye, target);
      if (!cell.visible) {
        cell.visible = observers.some((a) => {
          if (Math.abs(a.feet - cell.y) > 0.7) return false;
          const dx = cell.x - a.eye.x;
          const dz = cell.z - a.eye.z;
          const hDist = Math.hypot(dx, dz);
          const fLen = Math.hypot(a.dir.x, a.dir.z) || 1;
          if (hDist > 0.2 && (dx * a.dir.x + dz * a.dir.z) < hDist * fLen * 0.45) return false;
          return hasLineOfSight(this.colliders, a.eye, target);
        });
      }
      cell.seen ||= cell.visible;
    }
  }

  private updateMarkers(): void {
    const markers: ActiveMarker[] = [];
    for (const a of this.allies) {
      if (a.down) continue;
      if (a.order === 'move' && a.moveTarget) {
        markers.push({
          key: a.elementKey,
          x: a.moveTarget.x,
          y: a.moveTarget.y,
          z: a.moveTarget.z,
          yawRad: a.moveTarget.yawRad,
          label: a.callsign,
        });
      }
    }
    this.menu.updateActiveMarkers(markers);
  }

  private activeTargets(element: SquadElement): AllyUnit[] {
    return this.allies.filter((a) => !a.down && (element === 'gold' || a.elementKey === element));
  }

  private executeOrder(order: SquadOrder, ctx: OrderContext): void {
    const targets = this.activeTargets(ctx.element);
    if (targets.length === 0) {
      this.ack = '指示可能な生存隊員がいません';
      this.ackLeft = 1.4;
      return;
    }

    const names = targets.map((a) => a.name).join('・');
    this.ack = `${names}：${this.cfg.orderLabels[order]}、了解`;
    this.ackLeft = 1.5;

    const isDoorOrder = order === 'stack' || order === 'clear' || order === 'flashClear' || order === 'breachClear' || order === 'pieDoor';
    let portal: EntryPortal | null = null;
    let targetRoom: RoomDef | null = null;
    if (isDoorOrder) {
      if (ctx.door) {
        const approach = this.approachSign(ctx.door);
        portal = {
          id: ctx.door.id,
          centerX: ctx.door.centerX,
          centerZ: ctx.door.centerZ,
          sillY: ctx.door.sillY,
          intoX: -approach * ctx.door.normalX,
          intoZ: -approach * ctx.door.normalZ,
          axisX: ctx.door.axisX,
          axisZ: ctx.door.axisZ,
          width: ctx.door.width,
          door: ctx.door,
        };
        targetRoom = this.findRoomAcrossDoor(ctx.door, approach);
      } else if (ctx.areaTarget) {
        const a = ctx.areaTarget;
        portal = {
          id: a.door ? a.door.id : `area:${a.room.id}`,
          centerX: a.entryX,
          centerZ: a.entryZ,
          sillY: a.entryY,
          intoX: a.intoX,
          intoZ: a.intoZ,
          axisX: a.axisX,
          axisZ: a.axisZ,
          width: a.width,
          door: a.door,
        };
        targetRoom = a.room;
      }
    }

    if (isDoorOrder && portal) {
      const slots = this.computeStackSlots(portal, targets.length);
      const room = targetRoom;
      if (room) this.announcedRooms.delete(`${room.id}:${portal.id}`);
      this.announcedStacks.delete(portal.id);

      // スタック位置へ近い順に役割を割り当て（#1がポイントマン、#2がウィングマン）
      // 同じ入口で既にスタック中の場合は役割・立ち位置を維持（再指示で並び順が入れ替わらないように）
      const keepRoles =
        order !== 'stack' &&
        targets.every((u) => u.order === 'stack' && u.entryPortal?.id === portal.id && u.groupSize === targets.length);
      const sorted = [...targets].sort((a, b) =>
        keepRoles
          ? a.roleIndex - b.roleIndex
          : Math.hypot(a.body.px - portal.centerX, a.body.pz - portal.centerZ) - Math.hypot(b.body.px - portal.centerX, b.body.pz - portal.centerZ),
      );
      const pods = room ? this.computeDominationPoints(portal, room, sorted.length) : [];

      sorted.forEach((ally, roleIdx) => {
        this.resetUnitForOrder(ally, order);
        ally.roleIndex = roleIdx;
        ally.groupSize = sorted.length;
        ally.entryPortal = portal;
        ally.door = portal.door;
        ally.targetRoom = room;
        // 枠が足りないときは先頭と重ねず、扉から離した位置に置く（重なると personalSpace で整列が終わらない）
        ally.stackPos = slots[roleIdx] ?? {
          x: portal.centerX - portal.intoX * (1.15 + roleIdx * 0.9),
          z: portal.centerZ - portal.intoZ * (1.15 + roleIdx * 0.9),
        };
        ally.podPos = pods[roleIdx]?.pos ?? null;
        ally.podLook = pods[roleIdx]?.look ?? null;
        ally.entryDelay = roleIdx * this.cfg.staggerSec;

        const alreadyNearDoor =
          Math.abs(ally.body.footY - portal.sillY) < 0.65 &&
          Math.hypot(ally.body.px - ally.stackPos.x, ally.body.pz - ally.stackPos.z) <= 1.25;

        if (order !== 'stack' && alreadyNearDoor && sorted.every((u) => Math.hypot(u.body.px - (slots[sorted.indexOf(u)]?.x ?? portal.centerX), u.body.pz - (slots[sorted.indexOf(u)]?.z ?? portal.centerZ)) <= 1.25)) {
          ally.phase = 'door_prep';
          ally.progress = roleIdx === 0 ? (portal.door && portal.door.angle < this.cfg.doorOpenAngle ? 'ドア開放準備' : '突入準備') : '突入待機';
        } else {
          ally.phase = 'stacking';
          ally.progress = 'スタック位置へ移動';
        }
      });

      const lead = sorted[0]!;
      const alreadyOpen = !portal.door || portal.door.angle >= this.cfg.doorOpenAngle;
      const radioMap: Record<string, [string, string]> = {
        stack: [alreadyOpen ? '了解、入口脇へスタックする' : '了解、ドア脇へスタックする', 'Roger, stacking up on the entry.'],
        clear: [alreadyOpen ? '了解、突入しクリアする！' : '了解、ドアを開放し突入する！', alreadyOpen ? 'Copy, moving in and clearing!' : 'Copy, opening and clearing.'],
        flashClear: ['了解、閃光弾で突入する！', 'Copy, bang and clear!'],
        breachClear: ['了解、ブリーチ突入する！', 'Copy, breaching and clearing!'],
        pieDoor: ['了解、ドアを開けて外から警戒する', 'Roger, pieing the door.'],
      };
      const [jaText, enText] = radioMap[order] ?? ['了解', 'Roger that.'];
      this.emitRadio(lead, jaText, enText);
      return;
    }

    if (order === 'move' && ctx.groundPoint) {
      const g = ctx.groundPoint;
      const slots = this.computeMoveSlots(g.x, g.z, g.y, g.yawRad, targets.length);
      targets.forEach((ally, idx) => {
        this.resetUnitForOrder(ally, 'move');
        ally.roleIndex = idx;
        ally.groupSize = targets.length;
        const pos = slots[idx] ?? { x: g.x, z: g.z };
        ally.moveTarget = { x: pos.x, y: g.y, z: pos.z, yawRad: g.yawRad };
        ally.watchYaw = g.yawRad + (targets.length > 1 ? (idx % 2 === 0 ? -0.25 : 0.25) : 0);
        ally.phase = 'move';
        ally.progress = '指定位置へ移動中';
      });
      this.emitRadio(targets[0]!, '了解、指定地点へ移動し警戒する', 'Copy, moving to position.');
      return;
    }

    if (order === 'overwatch') {
      targets.forEach((ally, idx) => {
        this.resetUnitForOrder(ally, 'overwatch');
        ally.roleIndex = idx;
        ally.groupSize = targets.length;
        ally.holdPos = { x: ally.body.px, y: ally.body.footY, z: ally.body.pz };
        ally.watchYaw = this.player.yawRad;
        ally.phase = 'overwatch';
        ally.progress = '射線ロック中';
      });
      this.emitRadio(targets[0]!, '了解、この射線をロックする', 'Roger, holding security.');
      return;
    }

    if (order === 'restrain') {
      const targetId = ctx.restrainTarget?.id ?? this.findNearestActionableId(targets[0]!.body.px, targets[0]!.body.pz, targets[0]!.body.footY);
      targets.forEach((ally, idx) => {
        this.resetUnitForOrder(ally, 'restrain');
        ally.roleIndex = idx;
        ally.groupSize = targets.length;
        ally.restrainTargetId = targetId;
        ally.phase = 'restraining';
        ally.progress = idx === 0 ? '確保へ移動中' : '確保を援護中';
      });
      this.emitRadio(
        targets[0]!,
        targetId ? '了解、対象を確保する' : '了解、周囲の確保対象を確認する',
        targetId ? 'Copy, moving to restrain.' : 'Roger, checking area for restraints.',
      );
      return;
    }

    if (order === 'hold') {
      targets.forEach((ally, idx) => {
        this.resetUnitForOrder(ally, 'hold');
        ally.roleIndex = idx;
        ally.groupSize = targets.length;
        ally.holdPos = { x: ally.body.px, y: ally.body.footY, z: ally.body.pz };
        ally.watchYaw = ally.body.yawRad;
        ally.phase = 'hold';
        ally.progress = '現在地で警戒待機';
      });
      this.emitRadio(targets[0]!, '了解、ここで待機する', 'Copy, holding position.');
      return;
    }

    // follow
    targets.forEach((ally, idx) => {
      this.resetUnitForOrder(ally, 'follow');
      ally.roleIndex = idx;
      ally.groupSize = targets.length;
      ally.phase = 'follow';
      ally.progress = '追従中';
    });
    this.emitRadio(targets[0]!, '了解、隊列に戻る', 'Roger, falling in.');
  }

  private resetUnitForOrder(ally: AllyUnit, order: SquadOrder): void {
    ally.order = order;
    ally.pathGoal = null;
    ally.path.length = 0;
    ally.stalled = 0;
    ally.stuckStage = 0;
    ally.anchor = { x: ally.body.px, z: ally.body.pz };
    ally.doorOpenTimer = 0;
    ally.doorOpenTargetId = null;
    ally.skippedDoors.clear();
    ally.stackWaitTimer = 0;
    ally.assignment = null;
    ally.restrainTargetId = null;
    ally.holdTime = 0;
    ally.entered = false;
    ally.sweepCell = null;
    ally.vantage = null;
    ally.skipped.clear();
    ally.sweepElapsed = 0;
    ally.flashed = false;
    ally.phaseTimer = 0;
    ally.door = null;
    ally.entryPortal = null;
    ally.stackPos = null;
    ally.podPos = null;
    ally.podLook = null;
    ally.targetRoom = null;
    ally.holdPos = null;
    ally.moveTarget = null;
  }

  private emitRadio(ally: AllyUnit, text: string, voiceText?: string): void {
    this.bus.emit('allyRadio', { allyId: ally.id, name: `${ally.callsign} ${ally.name}`, text, voiceText });
  }

  private stateText(ally: AllyUnit): string {
    if (ally.down) return '負傷';
    if (ally.holdingFire) return '射線待ち';
    if (ally.engaging) return '交戦中';
    return ally.progress;
  }

  private updateAllyTactics(ally: AllyUnit, dt: number): void {
    const body = ally.body;
    const isCombatReady = ally.phase !== 'follow' || ally.engaging;
    body.setReadyPose(isCombatReady ? 'high' : 'low');

    switch (ally.phase) {
      case 'follow': {
        const goal = this.computeFollowGoal(ally);
        const dist = Math.hypot(goal.x - body.px, goal.z - body.pz);
        if (dist <= this.cfg.arriveDistance && Math.abs(goal.y - body.footY) < 0.4) {
          ally.stalled = 0;
          ally.stuckStage = 0;
          ally.anchor = { x: body.px, z: body.pz };
          ally.progress = '隊列待機';
          if (!ally.engaging) {
            const lookDist = 4;
            const sideAngle = this.player.yawRad + (ally.index % 2 === 0 ? 0.35 : -0.35);
            body.aimAt(
              body.px - Math.sin(sideAngle) * lookDist,
              body.footY + 1.45,
              body.pz - Math.cos(sideAngle) * lookDist,
              dt,
              Math.PI * 1.6 * dt,
            );
          }
        } else {
          this.navigateTo(ally, goal.x, goal.z, goal.y, dt, true, true);
          ally.progress = '追従中';
        }
        return;
      }

      case 'hold': {
        ally.progress = '現在地警戒';
        if (!ally.engaging) {
          const lx = body.px - Math.sin(ally.watchYaw) * 4;
          const lz = body.pz - Math.cos(ally.watchYaw) * 4;
          body.aimAt(lx, body.footY + 1.42, lz, dt, Math.PI * 1.4 * dt);
        }
        return;
      }

      case 'overwatch': {
        ally.progress = '射線ロック中';
        if (!ally.engaging) {
          const lx = body.px - Math.sin(ally.watchYaw) * 6;
          const lz = body.pz - Math.cos(ally.watchYaw) * 6;
          body.aimAt(lx, body.footY + 1.42, lz, dt, Math.PI * 2 * dt);
        }
        return;
      }

      case 'move': {
        const mt = ally.moveTarget;
        if (!mt) {
          ally.phase = 'hold';
          return;
        }
        const arrived =
          Math.hypot(mt.x - body.px, mt.z - body.pz) <= this.cfg.arriveDistance &&
          Math.abs(mt.y - body.footY) < 0.4;
        if (!arrived) {
          ally.progress = '指定位置へ移動中';
          this.navigateTo(ally, mt.x, mt.z, mt.y, dt, true, true);
        } else {
          ally.progress = '指定位置で警戒中';
          if (!ally.engaging) {
            const lx = body.px - Math.sin(ally.watchYaw) * 5;
            const lz = body.pz - Math.cos(ally.watchYaw) * 5;
            body.aimAt(lx, body.footY + 1.42, lz, dt, Math.PI * 1.6 * dt);
          }
        }
        return;
      }

      case 'stacking': {
        const portal = ally.entryPortal;
        const slot = ally.stackPos;
        if (!portal || !slot) {
          ally.phase = 'hold';
          return;
        }
        const d = Math.hypot(slot.x - body.px, slot.z - body.pz);
        const sameFloor = Math.abs(body.footY - portal.sillY) < 0.4;
        if (!sameFloor || d > 0.34) {
          ally.stackWaitTimer = 0;
          ally.progress = 'スタック位置へ移動';
          // 対象ポータルの扉は開けず、道中にある未施錠の途中ドアのみ開放して進む
          this.navigateTo(ally, slot.x, slot.z, portal.sillY, dt, true, true, portal.door?.id ?? null);
          return;
        }
        if (!ally.engaging) {
          body.aimAt(portal.centerX, portal.sillY + 1.38, portal.centerZ, dt, Math.PI * 2 * dt);
        }
        const mates = this.allies.filter((u) => !u.down && u.entryPortal?.id === portal.id && u.order === ally.order);
        const allStacked = mates.every(
          (u) => u.stackPos !== null && Math.abs(u.body.footY - portal.sillY) < 0.4 && Math.hypot(u.body.px - u.stackPos.x, u.body.pz - u.stackPos.z) <= 0.42,
        );
        if (!allStacked) {
          ally.stackWaitTimer += dt;
          if (ally.order !== 'stack' && ally.stackWaitTimer >= this.cfg.stackWaitTimeoutSec) {
            ally.phase = 'door_prep';
            ally.phaseTimer = 0;
            ally.stackWaitTimer = 0;
            return;
          }
          ally.progress = '味方整列待ち';
          return;
        }
        ally.stackWaitTimer = 0;
        if (ally.order === 'stack') {
          ally.progress = 'スタック完了';
          if (!this.announcedStacks.has(portal.id)) {
            this.announcedStacks.add(portal.id);
            this.emitRadio(ally, 'スタック完了、突入準備よし！', 'Stacked up, ready to make entry.');
          }
          return;
        }
        ally.phase = 'door_prep';
        ally.phaseTimer = 0;
        return;
      }

      case 'door_prep': {
        const portal = ally.entryPortal;
        if (!portal) {
          ally.phase = 'hold';
          return;
        }
        const door = portal.door;
        const isDoorLead =
          ally.roleIndex === 0 ||
          !this.allies.some(
            (u) => !u.down && u.entryPortal?.id === portal.id && u.phase === 'door_prep' && u.roleIndex < ally.roleIndex,
          );
        if (!ally.engaging) {
          body.aimAt(portal.centerX, portal.sillY + 1.38, portal.centerZ, dt, Math.PI * 2 * dt);
        }
        if (door) {
          if (ally.order === 'pieDoor' && door.locked) {
            ally.progress = '施錠のため開けません';
            if (isDoorLead) {
              this.emitRadio(ally, 'ドアが施錠されている！ブリーチ指示を！', 'Door is locked, awaiting breach order!');
            }
            ally.phase = 'hold';
            ally.watchYaw = ally.body.yawRad;
            return;
          }

          if (isDoorLead && !door.isMoving && door.angle < this.cfg.doorOpenAngle) {
            if (ally.order === 'breachClear' || door.locked) {
              door.breach(body.px, body.pz, 'swat');
            } else {
              door.command(door.maxAngle, ally.order !== 'pieDoor', body.px, body.pz);
            }
          }

          if (door.angle < this.cfg.doorOpenAngle) {
            ally.progress = door.locked ? 'ブリーチ準備' : 'ドア開放中';
            return;
          }

          if (ally.order === 'pieDoor') {
            ally.progress = 'ドア外から警戒中';
            if (!ally.engaging) {
              const lookSide = ally.roleIndex === 0 ? -0.9 : 0.9;
              body.aimAt(
                portal.centerX + portal.intoX * 2.8 + portal.axisX * lookSide,
                portal.sillY + 1.35,
                portal.centerZ + portal.intoZ * 2.8 + portal.axisZ * lookSide,
                dt,
                Math.PI * 2 * dt,
              );
            }
            return;
          }
        }

        if (ally.order === 'flashClear' && !ally.flashed) {
          const thrower =
            this.allies.find(
              (u) => !u.down && u.entryPortal?.id === portal.id && u.order === 'flashClear' && (u.groupSize > 1 ? u.roleIndex === 1 : u.roleIndex === 0),
            ) ?? ally;
          this.throwFlashbangIntoRoom(thrower, portal);
          for (const u of this.allies) {
            if (!u.down && u.entryPortal?.id === portal.id && u.order === 'flashClear') {
              u.flashed = true;
              u.phase = 'flash_wait';
              u.phaseTimer = this.cfg.flashDelay + 0.08;
              u.progress = '閃光弾投擲・退避';
            }
          }
          return;
        }

        ally.phase = 'entering';
        ally.phaseTimer = 0;
        if (isDoorLead) {
          this.emitRadio(
            ally,
            ally.order === 'breachClear' ? 'ブリーチ！突入する！' : '突入、クリアする！',
            ally.order === 'breachClear' ? 'Breaching, moving in!' : 'Moving in, clearing room!',
          );
        }
        return;
      }

      case 'flash_wait': {
        const portal = ally.entryPortal;
        if (portal && !ally.engaging) {
          body.aimAt(portal.centerX, portal.sillY + 1.38, portal.centerZ, dt, Math.PI * 2 * dt);
        }
        ally.phaseTimer -= dt;
        ally.progress = '閃光起爆待ち';
        if (ally.phaseTimer <= 0) {
          ally.phase = 'entering';
          ally.phaseTimer = 0;
          if (ally.roleIndex === 0) this.emitRadio(ally, 'フラッシュ炸裂！突入！', 'Flash out, go, go, go!');
        }
        return;
      }

      case 'entering': {
        const portal = ally.entryPortal;
        if (!portal) {
          ally.phase = 'hold';
          return;
        }
        if (ally.entryDelay > 0) {
          ally.entryDelay -= dt;
          ally.progress = '2番手突入待ち';
          if (!ally.engaging) {
            body.aimAt(portal.centerX, portal.sillY + 1.38, portal.centerZ, dt, Math.PI * 2 * dt);
          }
          return;
        }

        ally.phaseTimer += dt;
        const beyond =
          (body.px - portal.centerX) * portal.intoX + (body.pz - portal.centerZ) * portal.intoZ;
        if (beyond > 0.35) ally.entered = true;

        const intoX = portal.intoX;
        const intoZ = portal.intoZ;
        const dest = ally.entered ? (ally.podPos ?? { x: portal.centerX + intoX * 1.4, z: portal.centerZ + intoZ * 1.4 }) : { x: portal.centerX + intoX * 0.72, z: portal.centerZ + intoZ * 0.72 };

        const d = Math.hypot(dest.x - body.px, dest.z - body.pz);
        if (d > 0.28 && ally.phaseTimer < 5.5 && ally.stalled < 2.4) {
          ally.progress = '室内に突入展開';
          this.navigateTo(ally, dest.x, dest.z, portal.sillY, dt, false, false);
          if (!ally.engaging) {
            const look = ally.podLook ?? {
              x: dest.x + intoX * 1.5,
              y: portal.sillY + 1.38,
              z: dest.z + intoZ * 1.5,
            };
            body.aimAt(look.x, look.y, look.z, dt, Math.PI * 2.2 * dt);
          }
          return;
        }

        ally.phase = 'sweeping';
        ally.sweepElapsed = 0;
        ally.stalled = 0;
        return;
      }

      case 'sweeping': {
        this.updateSweeping(ally, dt);
        return;
      }

      case 'restraining': {
        this.updateRestraining(ally, dt);
        return;
      }

      case 'secured': {
        ally.progress = '室確保・警戒中';
        if (!ally.engaging && ally.podLook) {
          body.aimAt(ally.podLook.x, ally.podLook.y, ally.podLook.z, dt, Math.PI * 1.4 * dt);
        }
        return;
      }
    }
  }

  private updateSweeping(ally: AllyUnit, dt: number): void {
    const portal = ally.entryPortal;
    const room = ally.targetRoom;
    const body = ally.body;
    if (!portal || !room) {
      ally.phase = 'secured';
      return;
    }

    ally.sweepElapsed += dt;

    // 1. 室内に投降済み容疑者・保護可能な民間人・落ちた武器がいれば、確保を優先
    const task = this.findRoomRestrainTask(room, portal.sillY);
    if (task) {
      const mateBusy = this.allies.some((a) => a !== ally && !a.down && a.assignment === task.id);
      if (!mateBusy || ally.assignment === task.id) {
        this.performRestrainTask(ally, task, dt);
        return;
      } else {
        // 相棒が拘束中は後方から銃を向けて援護カバー
        ally.progress = '拘束援護カバー';
        if (!ally.engaging) {
          body.aimAt(task.x, portal.sillY + 1.32, task.z, dt, Math.PI * 2 * dt);
        }
        return;
      }
    }
    ally.assignment = null;
    ally.holdTime = 0;

    // 2. 見落とし死角のクリアリング（2名いる場合は #1 のみが探索し #2 は PoD で扉・奥をカバー）
    const isSearcher = ally.roleIndex === 0 || ally.groupSize === 1;
    if (!isSearcher) {
      ally.progress = '支配点で援護警戒';
      if (!ally.engaging && ally.podLook) {
        body.aimAt(ally.podLook.x, ally.podLook.y, ally.podLook.z, dt, Math.PI * 1.6 * dt);
      }
      const mate = this.allies.find((a) => !a.down && a !== ally && a.targetRoom === room);
      if (!mate || mate.phase === 'secured' || ally.sweepElapsed > 7.5) {
        this.enterSecured(ally, room, portal);
      }
      return;
    }

    if (ally.sweepCell && (ally.sweepCell.seen || ally.stalled >= 2.2)) {
      if (ally.stalled >= 2.2) ally.skipped.add(ally.sweepCell);
      ally.sweepCell = null;
      ally.vantage = null;
      ally.stalled = 0;
    }

    if (!ally.sweepCell) {
      let best: Cell | null = null;
      let bestDist = Infinity;
      for (const c of this.coverage) {
        if (c.room !== room || c.seen || ally.skipped.has(c)) continue;
        const d = Math.hypot(c.x - body.px, c.z - body.pz);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (!best || ally.sweepElapsed > 7.5) {
        this.enterSecured(ally, room, portal);
        return;
      }
      ally.sweepCell = best;
      ally.vantage = this.findVantageForCell(ally, room, best);
      if (!ally.vantage) {
        ally.skipped.add(best);
        ally.sweepCell = null;
        return;
      }
    }

    const targetCell = ally.sweepCell;
    const eye = body.eye(new THREE.Vector3());
    if (hasLineOfSight(this.colliders, eye, { x: targetCell.x, y: targetCell.y + 0.35, z: targetCell.z })) {
      ally.progress = '死角クリア中';
      // 重要: 床(0.18m)ではなく常に胸〜目線高(1.38m)を向く！
      if (!ally.engaging) {
        body.aimAt(targetCell.x, targetCell.y + 1.38, targetCell.z, dt, Math.PI * 2.4 * dt);
      }
      return;
    }

    if (ally.vantage) {
      ally.progress = '遮蔽裏へ展開中';
      const d = Math.hypot(ally.vantage.x - body.px, ally.vantage.z - body.pz);
      if (d <= 0.25) {
        ally.skipped.add(targetCell);
        ally.sweepCell = null;
        ally.vantage = null;
      } else {
        this.navigateTo(ally, ally.vantage.x, ally.vantage.z, portal.sillY, dt, false, false);
        if (!ally.engaging) {
          body.aimAt(targetCell.x, targetCell.y + 1.38, targetCell.z, dt, Math.PI * 1.8 * dt);
        }
      }
    }
  }

  private enterSecured(ally: AllyUnit, room: RoomDef, portal: EntryPortal): void {
    ally.phase = 'secured';
    ally.sweepCell = null;
    ally.vantage = null;
    const adjacent = (x: number, z: number, y: number) =>
      Math.abs(y - (room.floorY ?? 0)) < 0.5 &&
      Math.abs(x - room.x) <= room.width / 2 + 0.35 &&
      Math.abs(z - room.z) <= room.depth / 2 + 0.35;
    const exits = this.doors.doors.filter((d) => d !== portal.door && adjacent(d.centerX, d.centerZ, d.sillY));
    if (exits.length > 0) {
      const targetExit = exits[ally.roleIndex % exits.length]!;
      ally.podLook = { x: targetExit.centerX, y: targetExit.sillY + 1.38, z: targetExit.centerZ };
    }
    const key = `${room.id}:${portal.id}`;
    if (!this.announcedRooms.has(key)) {
      this.announcedRooms.add(key);
      const extra = exits.length > 0 ? `（別扉${exits.length}か所あり）` : '';
      this.emitRadio(ally, `${room.name}、クリア！${extra}`, 'Room clear!');
    }
  }

  private updateRestraining(ally: AllyUnit, dt: number): void {
    const task = this.resolveRestrainTaskById(ally.restrainTargetId, ally.body.px, ally.body.pz, ally.body.footY);
    if (!task) {
      ally.assignment = null;
      ally.holdTime = 0;
      ally.phase = 'hold';
      ally.holdPos = { x: ally.body.px, y: ally.body.footY, z: ally.body.pz };
      ally.watchYaw = ally.body.yawRad;
      ally.progress = '確保完了・待機';
      return;
    }

    const mate = this.allies.find((a) => a !== ally && !a.down && a.order === 'restrain' && a.restrainTargetId === ally.restrainTargetId);
    if (mate && ally.roleIndex > mate.roleIndex) {
      // 2番手は周囲カバー位置で待機し対象周辺を警戒
      const dx = ally.body.px - task.x;
      const dz = ally.body.pz - task.z;
      const dist = Math.hypot(dx, dz) || 1;
      if (dist > 2.8) {
        const cx = task.x + (dx / dist) * 2.1;
        const cz = task.z + (dz / dist) * 2.1;
        this.navigateTo(ally, cx, cz, task.y, dt, true, true);
      }
      ally.progress = '確保を援護カバー中';
      if (!ally.engaging) ally.body.aimAt(task.x, task.y + 1.35, task.z, dt, Math.PI * 2 * dt);
      return;
    }

    this.performRestrainTask(ally, task, dt);
  }

  private performRestrainTask(
    ally: AllyUnit,
    task: { id: string; kind: 'suspect' | 'civilian' | 'evidence'; x: number; y: number; z: number },
    dt: number,
  ): void {
    const range =
      task.kind === 'suspect'
        ? this.arrestCfg.range
        : task.kind === 'civilian'
          ? this.arrestCfg.civilianRange
          : this.arrestCfg.evidenceRange;
    const holdNeed =
      task.kind === 'suspect'
        ? this.arrestCfg.holdSec
        : task.kind === 'civilian'
          ? this.arrestCfg.civilianHoldSec
          : this.arrestCfg.evidenceHoldSec;

    let goalX = task.x;
    let goalZ = task.z;
    if (task.kind === 'evidence' && blockedAt(this.colliders, goalX, goalZ, this.cfg.bodyRadius, task.y)) {
      const s = this.entities.suspects.get(task.id);
      if (s && !blockedAt(this.colliders, s.body.px, s.body.pz, this.cfg.bodyRadius, s.body.footY)) {
        goalX = s.body.px;
        goalZ = s.body.pz;
      }
    }

    const reach = Math.max(range * 0.95, 2.1);
    const d = Math.hypot(task.x - ally.body.px, task.z - ally.body.pz);
    const sameFloor = Math.abs(task.y - ally.body.footY) < 0.55;
    const stuckNear = sameFloor && d <= 3.0 && ally.stalled >= 1.4;
    if (!sameFloor || (d > reach && !stuckNear)) {
      ally.assignment = task.id;
      ally.holdTime = 0;
      ally.progress = task.kind === 'suspect' ? '逮捕へ接近中' : task.kind === 'civilian' ? '保護へ接近中' : '証拠回収へ接近中';
      this.navigateTo(ally, goalX, goalZ, task.y, dt, true, true);
      return;
    }

    ally.assignment = task.id;
    ally.progress = task.kind === 'suspect' ? '容疑者を拘束中' : task.kind === 'civilian' ? '民間人を保護中' : '証拠武器を回収中';
    ally.body.aimAt(task.x, task.y + 0.9, task.z, dt, Math.PI * 3 * dt);
    ally.holdTime += dt;
    if (ally.holdTime < holdNeed) return;

    if (task.kind === 'suspect') {
      const s = this.entities.suspects.get(task.id);
      if (s && s.arrest()) {
        if (s.hasUncollectedEvidence) {
          const wp = s.body.getDroppedWeaponPos()!;
          s.collectEvidence();
          this.bus.emit('evidence', { targetId: s.id, pos: wp });
        }
        this.bus.emit('arrest', { targetId: s.id, evidenceCollected: s.evidenceCollected });
        this.emitRadio(ally, '容疑者を拘束、武器を押収した！', 'Suspect restrained, weapon secured.');
      }
    } else if (task.kind === 'civilian') {
      const c = this.entities.civilians.get(task.id);
      if (c && c.secure()) {
        this.emitRadio(ally, '民間人を安全に確保した！', 'Civilian is safe and secure.');
      }
    } else {
      const s = this.entities.suspects.get(task.id);
      const wp = s?.body.getDroppedWeaponPos();
      if (s && wp && s.hasUncollectedEvidence) {
        s.collectEvidence();
        this.bus.emit('evidence', { targetId: s.id, pos: wp });
        this.emitRadio(ally, '証拠の武器を回収した', 'Evidence secured.');
      }
    }
    ally.assignment = null;
    ally.restrainTargetId = null;
    ally.holdTime = 0;
  }

  private isIdleForPostSweep(ally: AllyUnit): boolean {
    if (this.postClearActive) {
      return ally.phase !== 'restraining';
    }
    return (
      ally.phase === 'follow' ||
      ally.phase === 'secured' ||
      ally.phase === 'hold'
    );
  }

  private assignPostClearTask(ally: AllyUnit): void {
    const id = this.findNearestActionableId(ally.body.px, ally.body.pz, ally.body.footY, true);
    if (!id) return;
    const alreadyTaken = this.allies.some((a) => a !== ally && !a.down && a.phase === 'restraining' && a.restrainTargetId === id);
    if (alreadyTaken) return;
    ally.order = 'restrain';
    ally.phase = 'restraining';
    ally.restrainTargetId = id;
    ally.roleIndex = 0;
    ally.groupSize = 1;
    ally.pathGoal = null;
    ally.path.length = 0;
  }

  private findRoomRestrainTask(
    room: RoomDef,
    floorY: number,
  ): { id: string; kind: 'suspect' | 'civilian' | 'evidence'; x: number; y: number; z: number } | null {
    const inRoom = (px: number, pz: number, py: number) =>
      Math.abs(py - floorY) < 0.6 && Math.abs(px - room.x) <= room.width / 2 && Math.abs(pz - room.z) <= room.depth / 2;

    for (const s of this.entities.suspects.values()) {
      if (s.state === SuspectState.SURRENDER && s.readyForArrest && inRoom(s.body.px, s.body.pz, s.body.footY)) {
        return { id: s.id, kind: 'suspect', x: s.body.px, y: s.body.footY, z: s.body.pz };
      }
    }
    for (const c of this.entities.civilians.values()) {
      if (!c.alive || c.state === CivilianState.SECURED || c.state === CivilianState.SHIELDED) continue;
      if (inRoom(c.body.px, c.body.pz, c.body.footY)) {
        if (c.state === CivilianState.IDLE || c.state === CivilianState.PANIC) c.onWarned();
        if (c.canSecure) return { id: c.id, kind: 'civilian', x: c.body.px, y: c.body.footY, z: c.body.pz };
      }
    }
    for (const s of this.entities.suspects.values()) {
      if (s.hasUncollectedEvidence) {
        const wp = s.body.getDroppedWeaponPos();
        if (wp && inRoom(wp.x, wp.z, s.body.footY)) {
          return { id: s.id, kind: 'evidence', x: wp.x, y: s.body.footY, z: wp.z };
        }
      }
    }
    return null;
  }

  private findNearestActionableId(px: number, pz: number, py: number, includeIdleCivilians = false): string | null {
    let bestId: string | null = null;
    let bestScore = Infinity;
    const score = (x: number, y: number, z: number) => Math.hypot(x - px, z - pz) + Math.abs(y - py) * 3;

    for (const s of this.entities.suspects.values()) {
      if (s.state === SuspectState.SURRENDER && s.readyForArrest) {
        const sc = score(s.body.px, s.body.footY, s.body.pz);
        if (sc < bestScore) {
          bestScore = sc;
          bestId = s.id;
        }
      } else if (s.hasUncollectedEvidence) {
        const wp = s.body.getDroppedWeaponPos()!;
        const sc = score(wp.x, s.body.footY, wp.z);
        if (sc < bestScore) {
          bestScore = sc;
          bestId = s.id;
        }
      }
    }
    for (const c of this.entities.civilians.values()) {
      if (!c.canSecure) continue;
      if (!includeIdleCivilians && c.state !== CivilianState.COMPLY && !this.postClearActive) continue;
      const sc = score(c.body.px, c.body.footY, c.body.pz);
      if (sc < bestScore) {
        bestScore = sc;
        bestId = c.id;
      }
    }
    return bestId;
  }

  private resolveRestrainTaskById(
    id: string | null,
    px: number,
    pz: number,
    py: number,
  ): { id: string; kind: 'suspect' | 'civilian' | 'evidence'; x: number; y: number; z: number } | null {
    const check = (cid: string): { id: string; kind: 'suspect' | 'civilian' | 'evidence'; x: number; y: number; z: number } | null => {
      const s = this.entities.suspects.get(cid);
      if (s) {
        if (s.state === SuspectState.SURRENDER && s.readyForArrest) {
          return { id: s.id, kind: 'suspect', x: s.body.px, y: s.body.footY, z: s.body.pz };
        }
        if (s.hasUncollectedEvidence) {
          const wp = s.body.getDroppedWeaponPos();
          if (wp) return { id: s.id, kind: 'evidence', x: wp.x, y: s.body.footY, z: wp.z };
        }
      }
      const c = this.entities.civilians.get(cid);
      if (c && c.canSecure) {
        return { id: c.id, kind: 'civilian', x: c.body.px, y: c.body.footY, z: c.body.pz };
      }
      return null;
    };

    if (id) {
      const hit = check(id);
      if (hit) return hit;
    }
    const nextId = this.findNearestActionableId(px, pz, py, this.postClearActive);
    return nextId ? check(nextId) : null;
  }

  private isStandable(x: number, z: number, y: number): boolean {
    if (blockedAt(this.colliders, x, z, this.cfg.bodyRadius, y)) return false;
    const legacy = legacyZeroFallbackOf(this.colliders);
    return legacy || probeGround(this.colliders, x, z, y, this.cfg.bodyRadius, false) !== null;
  }

  private passableUnlockedDoors(ally?: AllyUnit, excludeDoorId: string | null = null): Set<Collider> {
    const set = new Set<Collider>();
    for (const d of this.doors.doors) {
      if (d.id === excludeDoorId) continue;
      if (ally?.skippedDoors.has(d.id)) continue;
      if ((!d.locked || this.postClearActive) && d.angle < this.cfg.doorOpenAngle) {
        for (const c of d.colliders) set.add(c);
      }
    }
    return set;
  }

  /** 予定経路の直近セグメント上（近接）にある未開放ドアを優先選択する。 */
  private pickDoorOnPath(ally: AllyUnit, routeDest: XZ, excludeDoorId: string | null): Door | null {
    const body = ally.body;
    const pts: XZ[] = [{ x: body.px, z: body.pz }];
    if (ally.path.length > 0) {
      const limit = Math.min(ally.path.length, 3);
      for (let i = 0; i < limit; i++) pts.push(ally.path[i]!);
    } else {
      pts.push(routeDest);
    }

    let best: Door | null = null;
    let bestSegDist = 0.85;
    let bestAllyDist = Infinity;
    for (const door of this.doors.doors) {
      if (door.id === excludeDoorId) continue;
      if (ally.skippedDoors.has(door.id)) continue;
      if ((door.locked && !this.postClearActive) || door.angle >= this.cfg.doorOpenAngle) continue;
      if (Math.abs(door.sillY - body.footY) > 0.65) continue;
      const allyDist = Math.hypot(body.px - door.centerX, body.pz - door.centerZ);
      if (allyDist >= 1.35) continue;

      let segDist = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distToSegment(door.centerX, door.centerZ, pts[i]!, pts[i + 1]!);
        if (d < segDist) segDist = d;
      }
      if (segDist > bestSegDist) continue;
      if (segDist < bestSegDist - 0.05 || (Math.abs(segDist - bestSegDist) <= 0.05 && allyDist < bestAllyDist)) {
        best = door;
        bestSegDist = segDist;
        bestAllyDist = allyDist;
      }
    }
    return best;
  }

  /** Stage2 停滞復帰: めり込み脱出、それでも抜けない場合は視線・経路が通る近傍の支持面付き自由点へ退避する。 */
  private recoverStuckAlly(ally: AllyUnit, goal: XZ, passable?: ReadonlySet<Collider>): void {
    const body = ally.body;
    const r = this.cfg.bodyRadius;
    if (resolveOverlap(body, this.colliders, r)) {
      ally.stalled = 0;
      ally.stuckStage = 0;
      ally.anchor = { x: body.px, z: body.pz };
      return;
    }
    const feet = body.footY;
    const origin: XZ = { x: body.px, z: body.pz };
    const legacy = legacyZeroFallbackOf(this.colliders);
    let best: XZ | null = null;
    let bestScore = Infinity;
    for (const dist of [0.35, 0.55, 0.8]) {
      for (let i = 0; i < 12; i++) {
        const ang = (i * Math.PI * 2) / 12;
        const nx = body.px + Math.cos(ang) * dist;
        const nz = body.pz + Math.sin(ang) * dist;
        if (!this.isStandable(nx, nz, feet)) continue;
        if (!pathSegmentClear(this.colliders, origin, { x: nx, z: nz }, r, feet, passable)) continue;
        const score = Math.hypot(nx - goal.x, nz - goal.z) + dist * 0.4;
        if (score < bestScore) {
          bestScore = score;
          best = { x: nx, z: nz };
        }
      }
      if (best) break;
    }
    if (best) {
      const support = probeGround(this.colliders, best.x, best.z, feet, r, legacy) ?? feet;
      body.setPosition(best.x, best.z, nextFootY(feet, support, 0.25));
    }
    ally.stalled = 0;
    ally.stuckStage = 0;
    ally.anchor = { x: body.px, z: body.pz };
  }

  private navigateTo(
    ally: AllyUnit,
    goalX: number,
    goalZ: number,
    destY: number,
    dt: number,
    allowOpenUnlockedDoors: boolean,
    faceTravel: boolean,
    excludeDoorId: string | null = null,
  ): void {
    const body = ally.body;
    let routeDest: XZ = { x: goalX, z: goalZ };
    let onStairRun = false;
    const sameFloor = Math.abs(destY - body.footY) <= 0.75;
    const passable = allowOpenUnlockedDoors ? this.passableUnlockedDoors(ally, excludeDoorId) : undefined;

    const arriveTol = Math.max(this.cfg.arriveDistance, 0.25);
    const atGoal = !ally.activeStair && sameFloor && Math.hypot(routeDest.x - body.px, routeDest.z - body.pz) <= arriveTol;
    if (atGoal || Math.hypot(body.px - ally.anchor.x, body.pz - ally.anchor.z) >= 0.1) {
      ally.anchor = { x: body.px, z: body.pz };
      ally.stalled = 0;
      ally.stuckStage = 0;
    } else {
      ally.stalled += dt;
      if (ally.stalled >= this.cfg.stuckResetSec && ally.stuckStage < 1) {
        ally.stuckStage = 1;
        ally.pathGoal = null;
        ally.path.length = 0;
        ally.stairPick = null;
        resolveOverlap(body, this.colliders, this.cfg.bodyRadius);
      } else if (ally.stalled >= this.cfg.stuckRecoverSec && ally.stuckStage < 2) {
        ally.stuckStage = 2;
        ally.activeStair = null;
        ally.stairPick = null;
        ally.pathGoal = null;
        ally.path.length = 0;
        this.recoverStuckAlly(ally, { x: goalX, z: goalZ }, passable);
      }
    }

    // 昇降中: 退出点に着くまで同じ階段を進む（停滞が続いたときだけやめる）
    if (ally.activeStair) {
      const act = ally.activeStair;
      const s = this.stairs.find((m) => m.id === act.id);
      if (!s || stairExitReached(s, act.up, body.px, body.pz, body.footY, this.cfg.stairExitRadius)) {
        ally.activeStair = null;
      } else if (ally.stalled >= this.cfg.stairStallResetSec) {
        ally.activeStair = null;
        ally.stairPick = null;
        ally.stalled = 0;
        ally.stuckStage = 0;
        ally.anchor = { x: body.px, z: body.pz };
      } else {
        onStairRun = true;
        routeDest = stairRunTarget(s, act.up, body.px, body.pz);
      }
    }

    if (!onStairRun && !sameFloor && this.stairs.length > 0) {
      const up = destY > body.footY;
      const stair = this.chooseStair(ally, up, dt, allowOpenUnlockedDoors, excludeDoorId, { x: goalX, z: goalZ, y: destY });
      const entry = stairEntry(stair, up);
      const onFlight =
        (up ? body.footY > stair.baseY + 0.35 : body.footY < stair.topY - 0.35) &&
        distToSegment(body.px, body.pz, stair.approachLow, stair.approachHigh) <= 1.0;
      const entryClear =
        Math.hypot(body.px - entry.x, body.pz - entry.z) <= this.cfg.stairArrive &&
        pathSegmentClear(this.colliders, { x: body.px, z: body.pz }, entry, this.cfg.bodyRadius, body.footY, passable);
      if (entryClear || onFlight) {
        ally.activeStair = { id: stair.id, up };
        ally.stairPick = null;
        onStairRun = true;
        routeDest = stairRunTarget(stair, up, body.px, body.pz);
      } else {
        routeDest = entry;
      }
    }

    if (onStairRun) {
      if (!ally.engaging && faceTravel) body.faceToward(routeDest.x, routeDest.z, Math.PI * 1.8 * dt);
      stepToward(body, this.colliders, routeDest.x, routeDest.z, this.cfg.moveSpeed * dt, this.cfg.bodyRadius);
      return;
    }

    ally.retry -= dt;
    if (
      !ally.pathGoal ||
      Math.hypot(ally.pathGoal.x - routeDest.x, ally.pathGoal.z - routeDest.z) > 0.25 ||
      (!ally.path.length && ally.retry <= 0)
    ) {
      ally.path = squadRoute(
        { x: body.px, z: body.pz },
        routeDest,
        body.footY,
        this.colliders,
        this.bounds,
        this.cfg.bodyRadius,
        passable,
      );
      ally.pathGoal = routeDest;
      ally.retry = 0.7;
    }

    if (allowOpenUnlockedDoors) {
      const door = this.pickDoorOnPath(ally, routeDest, excludeDoorId);
      if (door) {
        if (door.locked && this.postClearActive) door.locked = false;
        if (!door.isMoving) door.command(door.maxAngle, false, body.px, body.pz);
        if (ally.doorOpenTargetId === door.id) {
          ally.doorOpenTimer += dt;
        } else {
          ally.doorOpenTargetId = door.id;
          ally.doorOpenTimer = dt;
        }
        if (ally.doorOpenTimer >= this.cfg.doorOpenTimeoutSec) {
          ally.skippedDoors.set(door.id, SKIPPED_DOOR_TTL);
          ally.doorOpenTargetId = null;
          ally.doorOpenTimer = 0;
          ally.doorWait = 0;
          ally.pathGoal = null;
          ally.path.length = 0;
        } else {
          ally.doorWait = 0.15;
          return;
        }
      } else if (ally.doorOpenTargetId !== null) {
        ally.doorOpenTargetId = null;
        ally.doorOpenTimer = 0;
        ally.doorWait = 0;
      }
    }

    if (ally.doorWait > 0) return;

    const next = ally.path[0] ?? routeDest;
    const dNext = Math.hypot(next.x - body.px, next.z - body.pz);
    if (dNext < 0.08) {
      if (ally.path.length > 0) ally.path.shift();
      return;
    }

    if (!ally.engaging && faceTravel) {
      body.aimAt(next.x, body.footY + 1.4, next.z, dt, Math.PI * 2 * dt);
    }
    const before = dNext;
    stepToward(body, this.colliders, next.x, next.z, this.cfg.moveSpeed * dt, this.cfg.bodyRadius);
    const remaining = Math.hypot(next.x - body.px, next.z - body.pz);
    if (remaining < 0.14 && ally.path.length > 0) {
      ally.path.shift();
    } else if (before - remaining < 0.001 && ally.stalled > 0.8) {
      ally.path.length = 0;
      ally.pathGoal = null;
    }
  }

  private computeFollowGoal(ally: AllyUnit): { x: number; y: number; z: number } {
    const p = this.player.position;
    const yaw = this.player.yawRad;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    // 2 列縦隊: 偶数番は左・奇数番は右、2 名ごとに 1 列後ろへ（3 名以上でも追従位置が重ならない）
    const side = ally.index % 2 === 0 ? -1 : 1;
    const row = Math.floor(ally.index / 2);
    const back = this.cfg.followDistance + row * FOLLOW_ROW_GAP;

    const candidates: XZ[] = [
      {
        x: p.x - fx * back + rx * this.cfg.followLateral * side,
        z: p.z - fz * back + rz * this.cfg.followLateral * side,
      },
      {
        x: p.x - fx * (this.cfg.followDistance + ally.index * 0.85),
        z: p.z - fz * (this.cfg.followDistance + ally.index * 0.85),
      },
      {
        x: p.x + rx * this.cfg.followLateral * side,
        z: p.z + rz * this.cfg.followLateral * side,
      },
      { x: p.x - fx * 0.9, z: p.z - fz * 0.9 },
      { x: p.x - fx * 0.5, z: p.z - fz * 0.5 },
    ];
    for (const c of candidates) {
      if (this.isStandable(c.x, c.z, p.y)) {
        return { x: c.x, y: p.y, z: c.z };
      }
    }
    return { x: p.x, y: p.y, z: p.z };
  }

  private computeMoveSlots(x: number, z: number, y: number, yawRad: number, count: number): XZ[] {
    if (count <= 1) return [{ x, z }];
    const rx = Math.cos(yawRad);
    const rz = -Math.sin(yawRad);
    const fx = -Math.sin(yawRad);
    const fz = -Math.cos(yawRad);
    // 指定点を先頭に横 2 名 × 後方へ列を重ねる。立てない枠は後方・中央へずらし、最後は重ならない後方列に置く
    const out: XZ[] = [];
    const taken = (c: XZ): boolean => out.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 0.6);
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const back = row * 0.85;
      const cands: XZ[] = [
        { x: x - fx * back + rx * 0.48 * side, z: z - fz * back + rz * 0.48 * side },
        { x: x - fx * (back + 0.4) + rx * 0.3 * side, z: z - fz * (back + 0.4) + rz * 0.3 * side },
        { x: x - fx * (back + 0.78), z: z - fz * (back + 0.78) },
        { x: x - fx * back, z: z - fz * back },
      ];
      const pick = cands.find((c) => !taken(c) && this.isStandable(c.x, c.z, y));
      out.push(pick ?? { x: x - fx * (0.78 * (i + 1)), z: z - fz * (0.78 * (i + 1)) });
    }
    return out;
  }

  private computeStackSlots(portal: EntryPortal, count: number): XZ[] {
    return layoutStackSlots(portal, count, this.cfg.stackOffset, this.cfg.personalSpace, (x, z) =>
      this.isStandable(x, z, portal.sillY),
    );
  }

  private computeDominationPoints(
    portal: EntryPortal,
    room: RoomDef,
    count: number,
  ): { pos: XZ; look: Vec3 }[] {
    const intoX = portal.intoX;
    const intoZ = portal.intoZ;
    const latX = portal.axisX;
    const latZ = portal.axisZ;
    const thresh: XZ = { x: portal.centerX + intoX * 0.65, z: portal.centerZ + intoZ * 0.65 };
    const passable = this.passableUnlockedDoors();

    const chosen: XZ[] = [];
    const CORNER_PAIRS: [number, number][] = [
      [this.cfg.dominationDepth, this.cfg.dominationLateral],
      [1.7, 1.55],
      [1.4, 1.15],
      [1.1, 0.85],
      [0.85, 0.45],
    ];
    // 3・4 番手: 1・2 番手のコーナーより扉寄り・内側の壁沿い（入口に固まらず、射線も被らない位置）
    const INNER_PAIRS: [number, number][] = [
      [this.cfg.dominationDepth * 0.55, this.cfg.dominationLateral * 0.45],
      [1.6, 0.6],
      [1.25, 0.95],
      [2.1, 0.3],
      [1.0, 0.5],
    ];
    const pickCorner = (side: -1 | 1, pairs: readonly [number, number][] = CORNER_PAIRS): { pos: XZ; look: Vec3 } | null => {
      for (const [d, l] of pairs) {
        const px = portal.centerX + intoX * d + latX * (side * l);
        const pz = portal.centerZ + intoZ * d + latZ * (side * l);
        if (chosen.some((c) => Math.hypot(c.x - px, c.z - pz) < 0.75)) continue;
        if (
          Math.abs(px - room.x) > room.width / 2 - 0.36 ||
          Math.abs(pz - room.z) > room.depth / 2 - 0.36
        ) {
          continue;
        }
        if (!this.isStandable(px, pz, portal.sillY)) continue;
        if (
          pathSegmentClear(this.colliders, thresh, { x: px, z: pz }, this.cfg.bodyRadius, portal.sillY, passable) ||
          squadRoute(thresh, { x: px, z: pz }, portal.sillY, this.colliders, this.bounds, this.cfg.bodyRadius, passable).length > 0
        ) {
          chosen.push({ x: px, z: pz });
          return {
            pos: { x: px, z: pz },
            look: {
              x: px + intoX * 1.6 + latX * (side * 0.8),
              y: portal.sillY + 1.38,
              z: pz + intoZ * 1.6 + latZ * (side * 0.8),
            },
          };
        }
      }
      return null;
    };

    const pickFallbackPos = (cands: readonly XZ[], lastResort: XZ): XZ => {
      for (const c of cands) {
        if (this.isStandable(c.x, c.z, portal.sillY)) return c;
      }
      return lastResort;
    };

    const left = pickCorner(-1);
    const right = pickCorner(1);
    const roomCenter: XZ = { x: room.x, z: room.z };
    const safeThresh = pickFallbackPos([thresh, roomCenter], thresh);
    if (count <= 1) {
      return [left ?? right ?? { pos: safeThresh, look: { x: room.x, y: portal.sillY + 1.38, z: room.z } }];
    }
    const p1 = left ?? right ?? { pos: safeThresh, look: { x: room.x, y: portal.sillY + 1.38, z: room.z } };
    const deepThresh: XZ = { x: thresh.x + intoX * 0.7, z: thresh.z + intoZ * 0.7 };
    const p2Fallback = pickFallbackPos([deepThresh, roomCenter, safeThresh], safeThresh);
    const p2 = right ?? left ?? { pos: p2Fallback, look: { x: room.x, y: portal.sillY + 1.38, z: room.z } };
    const out = [p1, p2];
    // 3 名以上: 残りは左右交互に内側の壁沿いへ。取れなければ扉正面の奥へ間隔を空けて並べる
    for (let i = 2; i < count; i++) {
      const side: -1 | 1 = i % 2 === 0 ? -1 : 1;
      const inner = pickCorner(side, INNER_PAIRS) ?? pickCorner(side === -1 ? 1 : -1, INNER_PAIRS);
      if (inner) {
        out.push(inner);
        continue;
      }
      const depth = 1.4 + (i - 1) * 0.75;
      const fb = pickFallbackPos(
        [{ x: portal.centerX + intoX * depth, z: portal.centerZ + intoZ * depth }, roomCenter],
        safeThresh,
      );
      out.push({ pos: fb, look: { x: room.x, y: portal.sillY + 1.38, z: room.z } });
    }
    return out;
  }

  private findRoomAcrossDoor(door: Door, approach: number): RoomDef | null {
    const x = door.centerX - door.normalX * approach * 0.75;
    const z = door.centerZ - door.normalZ * approach * 0.75;
    return (
      this.rooms.find(
        (r) =>
          Math.abs((r.floorY ?? 0) - door.sillY) < 0.45 &&
          Math.abs(x - r.x) <= r.width / 2 &&
          Math.abs(z - r.z) <= r.depth / 2,
      ) ?? null
    );
  }

  private findVantageForCell(ally: AllyUnit, room: RoomDef, cell: Cell): XZ | null {
    const candidates = this.coverage.filter(
      (c) =>
        c.room === room &&
        !blockedAt(this.colliders, c.x, c.z, this.cfg.bodyRadius, c.y) &&
        hasLineOfSight(this.colliders, { x: c.x, y: c.y + 1.55, z: c.z }, { x: cell.x, y: cell.y + 0.35, z: cell.z }),
    );
    candidates.sort((a, b) => Math.hypot(a.x - ally.body.px, a.z - ally.body.pz) - Math.hypot(b.x - ally.body.px, b.z - ally.body.pz));
    const nearby = candidates.slice(0, 8);
    const unknown = this.coverage.filter((c) => c.room === room && !c.seen);
    const ranked = nearby
      .map((c) => ({
        c,
        gain: unknown.reduce(
          (n, u) => n + Number(hasLineOfSight(this.colliders, { x: c.x, y: c.y + 1.55, z: c.z }, { x: u.x, y: u.y + 0.35, z: u.z })),
          0,
        ),
      }))
      .sort((a, b) => b.gain - a.gain);

    for (const { c } of ranked) {
      const path = squadRoute({ x: ally.body.px, z: ally.body.pz }, c, cell.y, this.colliders, this.bounds, this.cfg.bodyRadius);
      const end = path.at(-1);
      if (end && Math.hypot(end.x - c.x, end.z - c.z) < 0.35) return c;
    }
    return null;
  }

  private throwFlashbangIntoRoom(thrower: AllyUnit, portal: EntryPortal): void {
    const intoX = portal.intoX;
    const intoZ = portal.intoZ;
    const start = thrower.body.eye(new THREE.Vector3());
    start.x += intoX * 0.25;
    start.z += intoZ * 0.25;

    let landX = portal.centerX + intoX * 1.4;
    let landZ = portal.centerZ + intoZ * 1.4;
    const doorMid = { x: portal.centerX + intoX * 0.35, y: portal.sillY + 1.15, z: portal.centerZ + intoZ * 0.35 };
    for (const d of [2.5, 1.9, 1.4, 1.0]) {
      const tx = portal.centerX + intoX * d;
      const tz = portal.centerZ + intoZ * d;
      if (
        !blockedAt(this.colliders, tx, tz, 0.2, portal.sillY) &&
        hasLineOfSight(this.colliders, doorMid, { x: tx, y: portal.sillY + 0.3, z: tz })
      ) {
        landX = tx;
        landZ = tz;
        break;
      }
    }

    const end = new THREE.Vector3(landX, portal.sillY + 0.08, landZ);
    const mesh = new THREE.Mesh(this.flashGeo, this.flashMat);
    mesh.position.copy(start);
    this.root.add(mesh);

    const fuseSec = Math.max(0.35, this.cfg.flashDelay);
    this.thrownFlashes.push({
      start,
      end,
      elapsed: 0,
      flightSec: fuseSec * 0.78,
      fuseSec,
      detonated: false,
      mesh,
    });
  }

  private updateThrownFlashes(dt: number): void {
    for (let i = this.thrownFlashes.length - 1; i >= 0; i--) {
      const f = this.thrownFlashes[i]!;
      f.elapsed += dt;
      const t = Math.min(1, f.elapsed / f.flightSec);
      f.mesh.position.lerpVectors(f.start, f.end, t);
      f.mesh.position.y += Math.sin(t * Math.PI) * 0.55;
      f.mesh.rotation.x += dt * 10;
      f.mesh.rotation.z += dt * 7;

      if (f.elapsed >= f.fuseSec && !f.detonated) {
        f.detonated = true;
        const pos: Vec3 = { x: f.end.x, y: f.end.y + 0.2, z: f.end.z };
        this.bus.emit('flashDetonated', { pos, radius: this.flash.range, blindSec: this.flash.blindSec });
        this.bus.emit('noise', { pos, radius: 18, kind: 'flash' });
        this.burstMesh.position.set(pos.x, pos.y, pos.z);
        this.burstMesh.visible = true;
        this.burstLife = 0.35;
        this.root.remove(f.mesh);
        this.thrownFlashes.splice(i, 1);
      }
    }
  }

  private applySeparation(ally: AllyUnit, dt: number): void {
    // 階段昇降中は横方向への押し出しで側壁・手すりへ衝突するのを防ぐため無効化
    if (ally.activeStair !== null) return;
    const body = ally.body;
    // 隊員同士の密集・重なり回避
    for (const other of this.allies) {
      if (other === ally || other.down || other.activeStair !== null || Math.abs(other.body.footY - body.footY) > 0.6) continue;
      const dx = body.px - other.body.px;
      const dz = body.pz - other.body.pz;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4 && d < this.cfg.personalSpace) {
        const push = Math.min(this.cfg.moveSpeed * dt * 0.6, (this.cfg.personalSpace - d) * 0.5);
        stepToward(body, this.colliders, body.px + (dx / d) * push, body.pz + (dz / d) * push, push, this.cfg.bodyRadius);
      }
    }

    // 待機・追従中にプレイヤーの射線前方に立っていたら自動で横へ避ける
    if (ally.phase === 'follow' || ally.phase === 'hold' || ally.phase === 'secured') {
      if (Math.abs(this.player.position.y - body.footY) > 0.6) return;
      const p = this.player.position;
      const fx = -Math.sin(this.player.yawRad);
      const fz = -Math.cos(this.player.yawRad);
      const rx = Math.cos(this.player.yawRad);
      const rz = -Math.sin(this.player.yawRad);
      const vx = body.px - p.x;
      const vz = body.pz - p.z;
      const forwardDist = vx * fx + vz * fz;
      const lateralDist = vx * rx + vz * rz;
      if (forwardDist > 0.4 && forwardDist < 2.2 && Math.abs(lateralDist) < 0.45) {
        const side = lateralDist >= 0 ? 1 : -1;
        const step = this.cfg.moveSpeed * dt * 0.7;
        stepToward(body, this.colliders, body.px + rx * side * step, body.pz + rz * side * step, step, this.cfg.bodyRadius);
      }
    }
  }

  /**
   * 現在階で使う階段を選ぶ（B1→1F→2F は 1 階ずつ）。到達判定は squadRoute を使うため一定間隔でだけ再計算する。
   * 現在階に接続する階段が無い場合は、従来どおり進入点が最も近い階段へ向かう。
   */
  private chooseStair(
    ally: AllyUnit,
    up: boolean,
    dt: number,
    allowOpenUnlockedDoors: boolean,
    excludeDoorId: string | null,
    dest: { x: number; z: number; y: number },
  ): StairMark {
    const body = ally.body;
    const cache = ally.stairPick;
    if (cache) cache.timer -= dt;
    if (cache && cache.up === up && Math.abs(cache.floorY - body.footY) <= STAIR_FLOOR_MATCH && cache.timer > 0) {
      const hit = this.stairs.find((m) => m.id === cache.id);
      if (hit) return hit;
    }
    const passable = allowOpenUnlockedDoors ? this.passableUnlockedDoors(ally, excludeDoorId) : undefined;
    const choice = pickBestStair(
      this.stairs,
      { x: body.px, z: body.pz, footY: body.footY },
      up,
      this.colliders,
      this.bounds,
      this.cfg.bodyRadius,
      passable,
      dest,
    );
    let stair: StairMark;
    if (choice) {
      stair = choice.stair;
    } else {
      stair = this.stairs[0]!;
      let bestD = Infinity;
      for (const m of this.stairs) {
        const e = stairEntry(m, up);
        const d = Math.hypot(body.px - e.x, body.pz - e.z);
        if (d < bestD) {
          bestD = d;
          stair = m;
        }
      }
    }
    ally.stairPick = { up, floorY: body.footY, id: stair.id, timer: STAIR_PICK_INTERVAL };
    return stair;
  }

  private approachSign(door: Door): number {
    const dx = this.player.position.x - door.centerX;
    const dz = this.player.position.z - door.centerZ;
    return dx * door.normalX + dz * door.normalZ >= 0 ? 1 : -1;
  }

  private aimedAlly(): AllyUnit | null {
    const eye = this.player.getEyePosition();
    const cp = Math.cos(this.player.pitchRad);
    const dir = new THREE.Vector3(-Math.sin(this.player.yawRad) * cp, Math.sin(this.player.pitchRad), -Math.cos(this.player.yawRad) * cp);
    let best: AllyUnit | null = null;
    let bestT = 12;
    for (const ally of this.allies) {
      const c = ally.body.chestPos();
      const vx = c.x - eye.x;
      const vy = c.y - eye.y;
      const vz = c.z - eye.z;
      const t = vx * dir.x + vy * dir.y + vz * dir.z;
      if (t < 0.4 || t > bestT) continue;
      const dx = eye.x + dir.x * t - c.x;
      const dy = eye.y + dir.y * t - c.y;
      const dz = eye.z + dir.z * t - c.z;
      if (dx * dx + dy * dy + dz * dz < 0.45 * 0.45) {
        best = ally;
        bestT = t;
      }
    }
    return best;
  }

  private tryWarn(ally: AllyUnit): void {
    if (ally.warnCd > 0) return;
    const from = ally.body.chestPos();
    for (const s of this.entities.suspects.values()) {
      if (!s.alive || !this.cfg.warnStates.includes(s.state) || this.provoked.has(s.id)) continue;
      const c = s.body.chestPos();
      if (Math.hypot(c.x - from.x, c.z - from.z) > this.cfg.engageRange) continue;
      if (!hasLineOfSight(this.colliders, from, c)) continue;
      const pEye = this.player.getEyePosition();
      const playerCovering =
        this.player.alive &&
        Math.hypot(c.x - pEye.x, c.z - pEye.z) <= 10 &&
        hasLineOfSight(this.colliders, pEye, c)
          ? 1
          : 0;
      const totalCovering = this.countAlliesCovering(c, 10) + playerCovering;
      const pressure = 1 + this.cfg.presenceBonusPerAlly * Math.max(0, totalCovering - 1);
      s.onWarned({ x: ally.body.px, y: from.y, z: ally.body.pz }, pressure);
      ally.warnCd = this.cfg.warningInterval;
      ally.body.faceToward(s.body.px, s.body.pz);
      return;
    }
  }

  private tryEngage(ally: AllyUnit, dt: number): void {
    ally.engaging = false;
    ally.holdingFire = false;
    const from = ally.body.chestPos();
    let best: { id: string; x: number; z: number; pos: Vec3 } | null = null;
    let bestD = this.cfg.engageRange;
    for (const s of this.entities.suspects.values()) {
      if (!s.alive) continue;
      if (s.state === SuspectState.SURRENDER || s.state === SuspectState.ARRESTED || s.state === SuspectState.DOWN) continue;
      if (s.state === SuspectState.NEGOTIATION) continue;
      const hostile = this.cfg.hostileStates.includes(s.state) || this.provoked.has(s.id);
      if (!hostile) continue;
      const c = s.body.chestPos();
      const d = Math.hypot(c.x - from.x, c.z - from.z);
      if (d > bestD || !hasLineOfSight(this.colliders, from, c)) continue;
      bestD = d;
      best = { id: s.id, x: s.body.px, z: s.body.pz, pos: c };
    }
    if (!best) return;
    ally.engaging = true;
    ally.body.setReadyPose('high');
    ally.body.aimAt(best.pos.x, best.pos.y, best.pos.z, dt);
    ally.holdingFire = this.lineBlockedByPerson(ally, from, best.pos, best.id);
    if (ally.holdingFire || ally.fireCd > 0) return;
    const bearing = Math.atan2(from.x - best.x, from.z - best.z);
    if (Math.cos(bearing - ally.body.yawRad) < Math.cos(Math.PI / 15)) return;
    const pistol = ally.body.hasShield;
    ally.fireCd = this.cfg.fireInterval * (pistol ? 1.3 : 1);
    ally.body.showMuzzleFlash(0.06);
    const pos = ally.body.chestPos();
    this.bus.emit('entityHit', { targetId: best.id, shooter: ally.id, damage: pistol ? Math.round(this.cfg.damage * 0.6) : this.cfg.damage, pos: best.pos, weaponId: pistol ? 'pistol' : 'rifle' });
    this.bus.emit('shotFired', { shooter: ally.id, pos });
    this.bus.emit('noise', { pos, radius: 30, kind: 'gunshot' });
  }

  private lineBlockedByPerson(ally: AllyUnit, from: Vec3, to: Vec3, targetId: string): boolean {
    if (segmentHitsAABB(this.player.getBodyBounds(), from, to)) return true;
    for (const other of this.allies) {
      if (other !== ally && !other.down && segmentHitsAABB(other.body.getAABB(), from, to)) return true;
    }
    for (const c of this.entities.civilians.values()) {
      if (c.alive && segmentHitsAABB(c.body.getAABB(), from, to)) return true;
    }
    for (const s of this.entities.suspects.values()) {
      if (s.id !== targetId && s.alive && segmentHitsAABB(s.body.getAABB(), from, to)) return true;
    }
    return false;
  }

  private onHit(id: string, damage: number, nonlethal: boolean): void {
    const ally = this.allies.find((a) => a.id === id);
    if (!ally || ally.down) return;
    if (nonlethal) {
      ally.body.setFlash(true);
      return;
    }
    ally.hp = Math.max(0, ally.hp - damage);
    ally.body.setFlash(true);
    if (ally.hp <= 0) {
      ally.down = true;
      ally.body.setPose('down');
      ally.body.removeGun();
      this.emitRadio(ally, `${ally.name}が負傷ダウン！`, `${ally.name} is down!`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.menu.dispose();
    for (const f of this.thrownFlashes) this.root.remove(f.mesh);
    this.thrownFlashes.length = 0;
    this.flashGeo.dispose();
    this.flashMat.dispose();
    for (const ally of this.allies) {
      this.weapons.removeTarget(ally);
      ally.label.dispose();
      ally.body.dispose();
    }
    this.allies.length = 0;
    this.burstMesh.geometry.dispose();
    const mat = this.burstMesh.material;
    if (mat instanceof THREE.Material) mat.dispose();
    this.root.removeFromParent();
  }
}
