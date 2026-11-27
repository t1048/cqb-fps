import * as THREE from 'three';
import { t, tElementLabel, tOrderLabel } from '../../core/i18n';
import type { RoomDef, SquadConfig, SquadElement, SquadOrder } from '../../core/types';
import type { ActiveMarker, OrderContext } from '../../ui/CommandMenu';
import type { EntryMode } from '../cqbEntry';
import {
  ACK_FOLLOW,
  ACK_HOLD,
  ACK_MOVE,
  ACK_OVERWATCH,
  ACK_RESTRAIN,
  ACK_RESTRAIN_SEARCH,
  MODE_DYNAMIC,
  MODE_SLOW,
  doorAck,
  pickRadio,
} from '../radioLines';
import { SWAT_RADIO_STAGGER_SEC } from '../SwatProfile';
import {
  activeTargets,
  type AllyUnit,
  type EntryPortal,
  type SquadContext,
  type SquadRosterEntry,
} from './squadTypes';
import { approachSign, computeMoveSlots } from './squadMovement';
import { assignPortalGroup, findRoomAcrossDoor } from './squadEntry';
import { applyScoutPreAim, doorKnowledge, startCheck, startDisarm, startMirror } from './squadScout';
import { findNearestActionableId } from './squadClearing';

const ORDER_I18N_KEY: Record<SquadOrder, string> = {
  follow: 'follow',
  hold: 'hold',
  move: 'move',
  overwatch: 'overwatch',
  stack: 'stack',
  clear: 'open_clear',
  flashClear: 'flash_clear',
  gasClear: 'gas_clear',
  c2Clear: 'c2_clear',
  breachClear: 'breach_clear',
  pieDoor: 'open_hold',
  restrain: 'restrain',
  mirror: 'mirror',
  check: 'check',
  disarm: 'disarm',
};

export function orderLabelText(cfg: SquadConfig, order: SquadOrder): string {
  return tOrderLabel(ORDER_I18N_KEY[order] ?? order, cfg.orderLabels[order]);
}

export function elementLabelText(cfg: SquadConfig, el: SquadElement): string {
  if (el === 'alpha') return t(cfg.elementLabels[el], 'ALPHA');
  if (el === 'bravo') return t(cfg.elementLabels[el], 'BRAVO');
  return tElementLabel(el, cfg.elementLabels[el]);
}

export function toggleEntryMode(ctx: SquadContext): EntryMode {
  ctx.entryMode = ctx.entryMode === 'dynamic' ? 'stealth' : 'dynamic';
  const isStealth = ctx.entryMode === 'stealth';
  ctx.ack = isStealth
    ? t('突入モード: ステルス（半開き・パイ切り・慎重進入）', 'Entry Mode: Stealth (Peek, Pie & Deliberate)')
    : t('突入モード: ダイナミック（強行突入）', 'Entry Mode: Dynamic (Forced Entry)');
  ctx.ackLeft = 2.0;
  const lead = ctx.allies.find((a) => !a.down);
  if (lead) {
    const [ja, en] = pickRadio(isStealth ? MODE_SLOW : MODE_DYNAMIC);
    ctx.emitRadio(lead, ja, en);
  }
  return ctx.entryMode;
}

export function handleShortcuts(ctx: SquadContext): void {
  if (!ctx.input.isPointerLocked || ctx.input.suppressSquadShortcuts || !ctx.player.alive) return;

  if (ctx.input.wasPressed('toggleEntryMode')) {
    toggleEntryMode(ctx);
  }

  if (ctx.input.wasPressed('cycleElement')) {
    // 隊員がいないチームは飛ばす（隊員 1 名なら GOLD ⇔ ALPHA のみ）
    const order: SquadElement[] = ['gold', 'alpha', 'bravo'].filter(
      (el) => el === 'gold' || ctx.allies.some((a) => a.elementKey === el),
    ) as SquadElement[];
    const next = order[(order.indexOf(ctx.selectedElement) + 1) % order.length]!;
    ctx.selectedElement = next;
    const members = ctx.allies.filter((a) => next === 'gold' || a.elementKey === next).map((a) => a.name);
    const label = elementLabelText(ctx.cfg, next);
    ctx.ack = t(`指揮対象: ${label}（${members.join('・')}）`, `Commanding: ${label} (${members.join(', ')})`);
    ctx.ackLeft = 1.2;
    ctx.menu.syncElementBadge(next);
  }

  if (ctx.input.isOrderMenuOpen) return;

  if (ctx.input.wasPressed('regroup')) {
    const orderCtx = ctx.menu.resolveContext(ctx.selectedElement);
    executeOrder(ctx, 'follow', orderCtx);
    return;
  }

  if (ctx.input.wasPressed('quickOrder')) {
    const orderCtx = ctx.menu.resolveContext(ctx.selectedElement);
    const info = quickOrderInfo(ctx, orderCtx);
    if (info.busy) {
      ctx.ack =
        info.busy === 'check'
          ? t('ドアチェック中…', 'Checking the door...')
          : info.busy === 'disarm'
            ? t('トラップ解除中…', 'Disarming the trap...')
            : t('突入中', 'Entry in progress');
      ctx.ackLeft = 1.2;
      return;
    }
    executeOrder(ctx, info.order, orderCtx);
  }
}

/** Z（ドア文脈）の段階: スタック → チェック → オープン&クリア */
export type ZStage = 'stack' | 'check' | 'entry';

/** 偵察結果に基づく推奨の突入方法（あくまでヒント。自動では発令しない） */
export type EntryRecommend = 'clear' | 'flashClear' | 'gasClear';

export interface QuickOrderInfo {
  order: SquadOrder;
  /** ドア文脈のときの段階（それ以外は null） */
  stage: ZStage | null;
  /** ドア/エリア対象の向こう側を把握しているか（対象がドア/エリアでなければ null） */
  scouted: boolean | null;
  /** 既知の脅威（武装容疑者）数 */
  threats: number;
  /** 既知の民間人数 */
  civilians: number;
  /** 確認済みのときの推奨（未確認は null） */
  recommend: EntryRecommend | null;
  /** 作業中（チェック/解除/突入シーケンス）。Z を押しても何も発令しない */
  busy: 'check' | 'disarm' | 'entry' | null;
  /** チェックまたは気付きでトラップ発見済み（未解除） */
  trapKnown: boolean;
  /** ドアチェック済み */
  checked: boolean;
}

/** 既知の脅威・民間人から推奨を決める。容疑者のみ→ガス / 容疑者+民間人→閃光 / 空→プレーン。 */
export function recommendEntry(threats: number, civilians: number): EntryRecommend {
  if (threats > 0) return civilians > 0 ? 'flashClear' : 'gasClear';
  return 'clear';
}

const ENTRY_ORDERS: readonly SquadOrder[] = ['clear', 'flashClear', 'gasClear', 'c2Clear', 'breachClear', 'pieDoor'];
const ENTRY_PHASES: readonly string[] = [
  'door_prep',
  'pieing',
  'c2_plant',
  'c2_standoff',
  'flash_wait',
  'gas_wait',
  'entering',
];

/**
 * Z キーで発令される指示とその根拠を状況から決定する（実行と HUD 表示で共通）。
 * ドアに対する Z は 3 段階（押すたびに次へ）:
 *  1. スタック: 扉脇に整列（突入しない）
 *  2. チェック: 先頭の隊員がドア際でしゃがみ、施錠とブービートラップを確認（約 1.7 秒）
 *  3. オープン&クリア: 閃光・ガスを使わない素の突入（施錠なら蹴破り）。確認済みのトラップは解除してから開ける
 * 閃光/ガス/C2 は右クリックメニューで選ぶ。ミラー確認も右クリックメニューのみ。
 * 偵察済み（オプティワンド・ミラー・開口越しの視線）なら推奨を返す（ヒント表示のみ）。
 */
export function quickOrderInfo(ctx: SquadContext, orderCtx: OrderContext): QuickOrderInfo {
  const none: QuickOrderInfo = {
    order: 'hold',
    stage: null,
    scouted: null,
    threats: 0,
    civilians: 0,
    recommend: null,
    busy: null,
    trapKnown: false,
    checked: false,
  };
  if (orderCtx.restrainTarget) return { ...none, order: 'restrain' };
  if (orderCtx.door) {
    const door = orderCtx.door;
    const targets = activeTargets(ctx, orderCtx.element);
    const k = doorKnowledge(ctx, door);
    const contacts = k.room ? ctx.intel.contactsIn(k.room.id) : [];
    const civilians = k.scouted ? contacts.filter((c) => c.kind === 'civilian').length : 0;
    const threats = k.threats.length;
    const recommend = k.scouted ? recommendEntry(threats, civilians) : null;
    const trapKnown = ctx.traps?.isDiscovered(door.id) === true;
    const checked = ctx.doorChecks.has(door.id);
    const base = { scouted: k.scouted, threats, civilians, recommend, trapKnown, checked };
    const atDoor = targets.filter((a) => a.door === door || a.entryPortal?.door === door);
    if (atDoor.some((a) => a.checkLeft > 0)) {
      return { ...base, order: 'check', stage: 'check', busy: 'check' };
    }
    if (atDoor.some((a) => a.disarmLeft > 0 || a.disarmStarted)) {
      return { ...base, order: 'disarm', stage: 'entry', busy: 'disarm' };
    }
    if (atDoor.some((a) => ENTRY_ORDERS.includes(a.order) && ENTRY_PHASES.includes(a.phase))) {
      return { ...base, order: 'clear', stage: 'entry', busy: 'entry' };
    }
    const entryOrder: SquadOrder = door.locked ? 'breachClear' : 'clear';
    // すでに開いているドアは段階を飛ばして突入できる
    if (door.angle >= ctx.cfg.doorOpenAngle) return { ...base, order: 'clear', stage: 'entry', busy: null };
    const stacked = atDoor.some((a) => a.order === 'stack');
    if (!stacked) return { ...base, order: 'stack', stage: 'stack', busy: null };
    if (!checked) return { ...base, order: 'check', stage: 'check', busy: null };
    return { ...base, order: entryOrder, stage: 'entry', busy: null };
  }
  if (orderCtx.areaTarget) {
    const room = orderCtx.areaTarget.room;
    const scouted = ctx.intel.isScouted(room.id);
    const threats = ctx.intel.threatsIn(room.id).length;
    const civilians = scouted ? ctx.intel.contactsIn(room.id).filter((c) => c.kind === 'civilian').length : 0;
    return {
      ...none,
      order: 'clear',
      scouted,
      threats,
      civilians,
      recommend: scouted ? recommendEntry(threats, civilians) : null,
    };
  }
  if (orderCtx.groundPoint) return { ...none, order: 'move' };
  return none;
}

/** Z キーで発令される指示（後方互換。根拠が要るときは quickOrderInfo）。 */
export function pickQuickOrder(ctx: SquadContext, orderCtx: OrderContext): SquadOrder {
  return quickOrderInfo(ctx, orderCtx).order;
}

function recommendText(ctx: SquadContext, info: QuickOrderInfo): string {
  if (!info.recommend) return '';
  const label = orderLabelText(ctx.cfg, info.recommend === 'gasClear' ? 'gasClear' : info.recommend);
  const out =
    (info.recommend === 'gasClear' && ctx.gasLeft <= 0) || (info.recommend === 'flashClear' && ctx.flashesLeft <= 0);
  const who =
    info.threats > 0
      ? info.civilians > 0
        ? t(`敵${info.threats}・民間人${info.civilians}`, `${info.threats} hostile, ${info.civilians} civ`)
        : t(`敵${info.threats}`, `${info.threats} hostile`)
      : t('空', 'empty');
  return `  ${t('推奨', 'Rec')}: ${label}（${who}${out ? t('・在庫なし', ' · out of stock') : ''}）`;
}

/** 画面下部に出す「Z : 〜〜」の文言。指示不可の状況では空文字。 */
export function quickOrderHint(ctx: SquadContext, dt: number): string {
  ctx.quickHintTimer -= dt;
  if (ctx.quickHintTimer > 0) return ctx.quickHintCache;
  ctx.quickHintTimer = 0.1;
  if (ctx.disposed || activeTargets(ctx, ctx.selectedElement).length === 0) {
    ctx.quickHintCache = '';
  } else {
    const info = quickOrderInfo(ctx, ctx.menu.resolveContext(ctx.selectedElement));
    let text: string;
    if (info.busy === 'check') text = t('チェック中…', 'Checking door...');
    else if (info.busy === 'disarm') text = t('トラップ解除中…', 'Disarming trap...');
    else if (info.busy === 'entry') text = t('突入中', 'Entering');
    else if (info.stage === 'stack') text = `Z : ${t('スタック＆ドアチェック', 'Stack Up & Check Door')}${t('（次: オープン&クリア）', ' (next: open & clear)')}`;
    else if (info.stage === 'check') text = `Z : ${t('ドアチェック（罠・施錠）', 'Check Door (Trap & Lock)')}`;
    else if (info.stage === 'entry') {
      const trap = info.trapKnown ? t('（罠発見: 解除してから開ける）', ' (trap found: disarm first)') : '';
      text = `Z : ${orderLabelText(ctx.cfg, info.order)}${trap}`;
    } else {
      text = `Z : ${orderLabelText(ctx.cfg, info.order)}`;
    }
    ctx.quickHintCache = text + (info.busy ? '' : recommendText(ctx, info));
  }
  return ctx.quickHintCache;
}

export function updateMarkers(ctx: SquadContext): void {
  const markers: ActiveMarker[] = [];
  for (const a of ctx.allies) {
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
  ctx.menu.updateActiveMarkers(markers);
}

function isLeadAtStackPos(lead: AllyUnit, portal: EntryPortal): boolean {
  return (
    lead.stackPos !== null &&
    Math.abs(lead.body.footY - portal.sillY) < 0.4 &&
    Math.hypot(lead.body.px - lead.stackPos.x, lead.body.pz - lead.stackPos.z) <= 0.34
  );
}

export function executeOrder(ctx: SquadContext, requested: SquadOrder, orderCtx: OrderContext): void {
  // 閉じた未チェックのドアへのスタック指示は、同時にドアチェック（罠・施錠）も行う（指示の手数を減らしテンポを保つ）。
  // check は全員スタック → 先頭がチェックなので、スタック位置に着いた時点でそのままチェックが始まる。
  const order: SquadOrder =
    requested === 'stack' &&
    orderCtx.door &&
    orderCtx.door.angle < ctx.cfg.doorOpenAngle &&
    !ctx.doorChecks.has(orderCtx.door.id)
      ? 'check'
      : requested;
  const targets = activeTargets(ctx, orderCtx.element);
  if (targets.length === 0) {
    ctx.ack = t('指示可能な生存隊員がいません', 'No living officers available');
    ctx.ackLeft = 1.4;
    return;
  }
  // 閃光弾・CS ガスはミッション全体で有限（squad.json の inventory）
  if (order === 'flashClear' && ctx.flashesLeft <= 0) {
    ctx.ack = t('閃光弾が残っていません', 'Out of flashbangs');
    ctx.ackLeft = 1.8;
    return;
  }
  if (order === 'gasClear' && ctx.gasLeft <= 0) {
    ctx.ack = t('CS ガスが残っていません', 'Out of CS gas');
    ctx.ackLeft = 1.8;
    return;
  }

  const namesJa = targets.map((a) => a.name).join('・');
  const namesEn = targets.map((a) => a.name).join(', ');
  const label = orderLabelText(ctx.cfg, order);
  ctx.ack = t(`${namesJa}：${label}、了解`, `${namesEn}: ${label}, copy`);
  ctx.ackLeft = 1.5;

  const isDoorOrder =
    order === 'stack' ||
    order === 'clear' ||
    order === 'flashClear' ||
    order === 'breachClear' ||
    order === 'c2Clear' ||
    order === 'gasClear' ||
    order === 'pieDoor' ||
    order === 'mirror' ||
    order === 'check' ||
    order === 'disarm';
  let portal: EntryPortal | null = null;
  let targetRoom: RoomDef | null = null;
  if (isDoorOrder) {
    if (orderCtx.door) {
      const approach = approachSign(ctx, orderCtx.door);
      portal = {
        id: orderCtx.door.id,
        centerX: orderCtx.door.centerX,
        centerZ: orderCtx.door.centerZ,
        sillY: orderCtx.door.sillY,
        intoX: -approach * orderCtx.door.normalX,
        intoZ: -approach * orderCtx.door.normalZ,
        axisX: orderCtx.door.axisX,
        axisZ: orderCtx.door.axisZ,
        width: orderCtx.door.width,
        door: orderCtx.door,
      };
      targetRoom = findRoomAcrossDoor(ctx, orderCtx.door, approach);
    } else if (orderCtx.areaTarget) {
      const a = orderCtx.areaTarget;
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

  if (order === 'mirror') {
    if (!portal || !orderCtx.door) {
      ctx.ack = t('ミラー確認はドアを見て実行します', 'Look at a door to mirror it');
      ctx.ackLeft = 1.4;
      return;
    }
    // 全員がスタックし、先頭の 1 名が数秒静止してドア下をミラー確認する（右クリックメニューから選んだときだけ）
    const lead = assignPortalGroup(ctx, targets, portal, targetRoom, 'stack');
    startMirror(ctx, lead);
    if (isLeadAtStackPos(lead, portal)) lead.mirrorStarted = true;
    const [jaText, enText] = pickRadio(doorAck('mirror', false));
    ctx.emitRadio(lead, jaText, enText);
    return;
  }

  if (order === 'check' || order === 'disarm') {
    if (!portal || !orderCtx.door) {
      ctx.ack = t('ドアを見て実行します', 'Look at a door to do this');
      ctx.ackLeft = 1.4;
      return;
    }
    if (order === 'check' && orderCtx.door.angle >= ctx.cfg.doorOpenAngle) {
      ctx.ack = t('ドアはすでに開いています', 'The door is already open');
      ctx.ackLeft = 1.4;
      return;
    }
    if (order === 'disarm' && ctx.traps?.isDiscovered(orderCtx.door.id) !== true) {
      ctx.ack = t('解除できる確認済みのトラップがありません', 'No known trap to disarm');
      ctx.ackLeft = 1.6;
      return;
    }
    // 全員がスタックし、先頭の 1 名がドア際でしゃがんで作業する（突入はしない）
    const lead = assignPortalGroup(ctx, targets, portal, targetRoom, 'stack');
    const alreadyAtDoor = isLeadAtStackPos(lead, portal);
    if (order === 'check') {
      startCheck(ctx, lead);
      if (alreadyAtDoor) lead.checkStarted = true;
    } else {
      startDisarm(ctx, lead);
      if (alreadyAtDoor) lead.disarmStarted = true;
    }
    const [jaText, enText] = pickRadio(doorAck(order, false));
    ctx.emitRadio(lead, jaText, enText);
    return;
  }

  if (isDoorOrder && portal) {
    const lead = assignPortalGroup(ctx, targets, portal, targetRoom, order);
    if (order !== 'stack' && order !== 'pieDoor') applyScoutPreAim(ctx, targets, portal, targetRoom);
    const alreadyOpen = !portal.door || portal.door.angle >= ctx.cfg.doorOpenAngle;
    const [jaText, enText] = pickRadio(doorAck(order, alreadyOpen));
    ctx.emitRadio(lead, jaText, enText);
    return;
  }

  if (order === 'move' && orderCtx.groundPoint) {
    const g = orderCtx.groundPoint;
    const slots = computeMoveSlots(ctx, g.x, g.z, g.y, g.yawRad, targets.length);
    targets.forEach((ally, idx) => {
      resetUnitForOrder(ally, 'move');
      ally.roleIndex = idx;
      ally.groupSize = targets.length;
      const pos = slots[idx] ?? { x: g.x, z: g.z };
      ally.moveTarget = { x: pos.x, y: g.y, z: pos.z, yawRad: g.yawRad };
      ally.watchYaw = g.yawRad + (targets.length > 1 ? (idx % 2 === 0 ? -0.25 : 0.25) : 0);
      ally.phase = 'move';
      ally.progress = t('指定位置へ移動中', 'Moving to Position');
    });
    const [moveJa, moveEn] = pickRadio(ACK_MOVE);
    ctx.emitRadio(targets[0]!, moveJa, moveEn);
    return;
  }

  if (order === 'overwatch') {
    targets.forEach((ally, idx) => {
      resetUnitForOrder(ally, 'overwatch');
      ally.roleIndex = idx;
      ally.groupSize = targets.length;
      ally.holdPos = { x: ally.body.px, y: ally.body.footY, z: ally.body.pz };
      ally.watchYaw = ctx.player.yawRad;
      ally.phase = 'overwatch';
      ally.progress = t('射線ロック中', 'Holding Security');
    });
    const [watchJa, watchEn] = pickRadio(ACK_OVERWATCH);
    ctx.emitRadio(targets[0]!, watchJa, watchEn);
    return;
  }

  if (order === 'restrain') {
    const targetId =
      orderCtx.restrainTarget?.id ??
      findNearestActionableId(ctx, targets[0]!.body.px, targets[0]!.body.pz, targets[0]!.body.footY);
    targets.forEach((ally, idx) => {
      resetUnitForOrder(ally, 'restrain');
      ally.roleIndex = idx;
      ally.groupSize = targets.length;
      ally.restrainTargetId = targetId;
      ally.phase = 'restraining';
      ally.progress = idx === 0 ? t('確保へ移動中', 'Moving to Secure') : t('確保を援護中', 'Covering Restraint');
    });
    const [cuffJa, cuffEn] = pickRadio(targetId ? ACK_RESTRAIN : ACK_RESTRAIN_SEARCH);
    ctx.emitRadio(targets[0]!, cuffJa, cuffEn);
    return;
  }

  if (order === 'hold') {
    targets.forEach((ally, idx) => {
      resetUnitForOrder(ally, 'hold');
      ally.roleIndex = idx;
      ally.groupSize = targets.length;
      ally.holdPos = { x: ally.body.px, y: ally.body.footY, z: ally.body.pz };
      ally.watchYaw = ally.body.yawRad;
      ally.phase = 'hold';
      ally.progress = t('現在地で警戒待機', 'Holding Position');
    });
    const [holdJa, holdEn] = pickRadio(ACK_HOLD);
    ctx.emitRadio(targets[0]!, holdJa, holdEn);
    return;
  }

  // follow
  targets.forEach((ally, idx) => {
    resetUnitForOrder(ally, 'follow');
    ally.roleIndex = idx;
    ally.groupSize = targets.length;
    ally.phase = 'follow';
    ally.progress = t('追従中', 'Following');
  });
  const [followJa, followEn] = pickRadio(ACK_FOLLOW);
  ctx.emitRadio(targets[0]!, followJa, followEn);
}

export function resetUnitForOrder(ally: AllyUnit, order: SquadOrder): void {
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
  ally.gassed = false;
  ally.phaseTimer = 0;
  ally.door = null;
  ally.entryPortal = null;
  ally.stackPos = null;
  ally.podPos = null;
  ally.podLook = null;
  ally.targetRoom = null;
  ally.holdPos = null;
  ally.moveTarget = null;
  ally.rushTimer = 0;
  ally.rushTarget = null;
  ally.pincerTarget = null;
  ally.pincerTimer = 0;
  ally.c2Timer = 0;
  ally.c2BeepTimer = 0;
  ally.c2Standoff = null;
  ally.c2IsLead = false;
  ally.settled = false;
  ally.entryPlan = null;
  ally.slotIndex = -1;
  ally.entryWp = 0;
  ally.entryStartT = -1;
  ally.entryCrossT = -1;
  ally.entryGateWait = 0;
  ally.entryThreatLook = null;
  ally.lookKey = '';
  ally.lookKeyT = 0;
  ally.followGoal = null;
  ally.idleLook = null;
  ally.dodge = null;
  ally.securedLookSet = false;
  ally.podReturnT = 0;
  ally.coverHold = null;
  ally.holdingFireSec = 0;
  ally.stepOutPos = null;
  ally.pieSteps = [];
  ally.pieIdx = 0;
  ally.pieHold = 0;
  ally.pieElapsed = 0;
  ally.peekHold = 0;
  ally.peekDone = false;
  ally.stealthEntry = false;
  ally.sweepRetryCd = 0;
  ally.mirrorLeft = 0;
  ally.mirrorStarted = false;
  ally.checkLeft = 0;
  ally.checkStarted = false;
  ally.disarmLeft = 0;
  ally.disarmStarted = false;
  ally.body.setPose('stand');
  ally.body.setLean(0);
}

export function emitRadioNow(ctx: SquadContext, ally: AllyUnit, text: string, voiceText?: string): void {
  ctx.radioSpeakGap = SWAT_RADIO_STAGGER_SEC;
  ctx.bus.emit('allyRadio', { allyId: ally.id, name: `${ally.callsign} ${ally.name}`, text, voiceText });
}

export function emitRadio(ctx: SquadContext, ally: AllyUnit, text: string, voiceText?: string): void {
  if (ctx.radioSpeakGap <= 0 && ctx.radioQueue.length === 0) {
    emitRadioNow(ctx, ally, text, voiceText);
  } else if (ctx.radioQueue.length < 4) {
    ctx.radioQueue.push({ ally, text, voiceText });
  }
}

export function stateText(ally: AllyUnit): string {
  if (ally.down) return t('負傷', 'Down');
  if (ally.blindLeft > 0) return t('閃光被弾', 'Flashed');
  if (ally.rushTimer > 0) return t('突撃制圧中', 'Rushing');
  if (ally.holdingFire) return t('射線待ち', 'Holding Fire');
  if (ally.engaging) return t('交戦中', 'Engaging');
  return ally.progress;
}

export function getRoster(ctx: SquadContext): SquadRosterEntry[] {
  return ctx.allies.map((a) => ({
    id: a.id,
    name: a.name,
    callsign: a.callsign,
    hp: Math.max(0, Math.round(a.hp)),
    maxHp: a.maxHp,
    down: a.down,
    orderLabel: orderLabelText(ctx.cfg, a.order),
    statusText: stateText(a),
    selected: ctx.selectedElement === 'gold' || ctx.selectedElement === a.elementKey,
  }));
}

const aimEyeTmp = new THREE.Vector3();
const aimChestTmp = { x: 0, y: 0, z: 0 };

export function aimedAlly(ctx: SquadContext): AllyUnit | null {
  if (ctx.allies.length === 0) return null;
  const eye = ctx.player.getEyePosition(aimEyeTmp);
  const cp = Math.cos(ctx.player.pitchRad);
  const dirX = -Math.sin(ctx.player.yawRad) * cp;
  const dirY = Math.sin(ctx.player.pitchRad);
  const dirZ = -Math.cos(ctx.player.yawRad) * cp;
  let best: AllyUnit | null = null;
  let bestT = 12;
  for (let i = 0; i < ctx.allies.length; i++) {
    const ally = ctx.allies[i]!;
    const c = ally.body.chestPos(aimChestTmp);
    const vx = c.x - eye.x;
    const vy = c.y - eye.y;
    const vz = c.z - eye.z;
    const tDist = vx * dirX + vy * dirY + vz * dirZ;
    if (tDist < 0.4 || tDist > bestT) continue;
    const dx = eye.x + dirX * tDist - c.x;
    const dy = eye.y + dirY * tDist - c.y;
    const dz = eye.z + dirZ * tDist - c.z;
    if (dx * dx + dy * dy + dz * dz < 0.45 * 0.45) {
      best = ally;
      bestT = tDist;
    }
  }
  return best;
}

export function hudText(ctx: SquadContext): string {
  const look = aimedAlly(ctx);
  const hasAck = ctx.ackLeft > 0 && ctx.ack.length > 0;
  if (!look && !hasAck) return '';
  const lookLine = look
    ? t(
        `照準隊員: ${look.callsign} ${look.name} / ${stateText(look)}`,
        `Aimed: ${look.callsign} ${look.name} / ${stateText(look)}`,
      )
    : '';
  if (lookLine && hasAck) return `${lookLine}\n${ctx.ack}`;
  return lookLine || ctx.ack;
}
