import * as THREE from 'three';
import { t, tElementLabel, tOrderLabel } from '../../core/i18n';
import type { Door } from '../../world/Door';
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
import { applyScoutPreAim, doorKnowledge, startMirror } from './squadScout';
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
    executeOrder(ctx, info.order, orderCtx, info.mirrorFirst);
  }
}

export interface QuickOrderInfo {
  order: SquadOrder;
  /** ドア/エリア対象の向こう側を把握しているか（対象がドア/エリアでなければ null） */
  scouted: boolean | null;
  /** 既知の脅威数 */
  threats: number;
  /** 未確認のドアなので、まずミラー確認をしてから結果に応じて自動突入する（order は 'mirror'） */
  mirrorFirst: boolean;
  /** すでにミラー確認中（もう一度 Z で確認を打ち切り、素の突入に移る） */
  mirroring: boolean;
}

/** 突入系の指示を、偵察結果に基づいて選ぶ。 */
function entryOrderFor(ctx: SquadContext, known: { scouted: boolean; threats: number }, locked: boolean): SquadOrder {
  if (locked) return 'breachClear';
  if (!known.scouted || known.threats === 0) return 'clear';
  if (ctx.flashesLeft > 0) return 'flashClear';
  if (ctx.gasLeft > 0) return 'gasClear';
  return 'clear';
}

/**
 * Z キーで発令される指示とその根拠を状況から決定する（実行と HUD 表示で共通）。Z は常に 1 回押すだけ。
 * - 未確認のドア: 隊員がミラー確認（約 4 秒静止）→ 結果に応じて閃光/ガス/静かな clear へ自動移行
 * - 確認済み（オプティワンド・ミラー・開口越しの視線）: 即突入。脅威ありなら閃光/ガス＋既知位置へ pre-aim、空なら静かな clear
 * - ミラー確認中にもう一度 Z: 確認を打ち切って素の clear（閃光なし・危険）
 */
export function quickOrderInfo(ctx: SquadContext, orderCtx: OrderContext): QuickOrderInfo {
  const none = { scouted: null, threats: 0, mirrorFirst: false, mirroring: false } as const;
  if (orderCtx.restrainTarget) return { ...none, order: 'restrain' };
  if (orderCtx.door) {
    const door = orderCtx.door;
    const targets = activeTargets(ctx, orderCtx.element);
    const mirroring = targets.some((a) => a.mirrorLeft > 0 && a.door === door);
    const k = doorKnowledge(ctx, door);
    const threats = k.threats.length;
    if (mirroring) {
      return { order: door.locked ? 'breachClear' : 'clear', scouted: false, threats: 0, mirrorFirst: false, mirroring: true };
    }
    if (k.scouted) {
      return { order: entryOrderFor(ctx, { scouted: true, threats }, door.locked), scouted: true, threats, mirrorFirst: false, mirroring: false };
    }
    return { order: 'mirror', scouted: false, threats: 0, mirrorFirst: true, mirroring: false };
  }
  if (orderCtx.areaTarget) {
    const room = orderCtx.areaTarget.room;
    const scouted = ctx.intel.isScouted(room.id);
    const threats = ctx.intel.threatsIn(room.id).length;
    return {
      order: scouted && threats > 0 ? entryOrderFor(ctx, { scouted, threats }, false) : 'clear',
      scouted,
      threats,
      mirrorFirst: false,
      mirroring: false,
    };
  }
  if (orderCtx.groundPoint) return { ...none, order: 'move' };
  return { ...none, order: 'hold' };
}

/** ミラー確認が終わった後、結果（ScoutIntel）に応じた突入を自動で発令する。 */
export function finishMirrorEntry(ctx: SquadContext, door: Door, element: SquadElement): void {
  const k = doorKnowledge(ctx, door);
  const order = entryOrderFor(ctx, { scouted: k.scouted, threats: k.threats.length }, door.locked);
  executeOrder(ctx, order, {
    element,
    door,
    areaTarget: null,
    groundPoint: null,
    restrainTarget: null,
    aimDir: { x: -door.normalX, z: -door.normalZ },
  });
}

/** Z キーで発令される指示（後方互換。根拠が要るときは quickOrderInfo）。 */
export function pickQuickOrder(ctx: SquadContext, orderCtx: OrderContext): SquadOrder {
  return quickOrderInfo(ctx, orderCtx).order;
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
    let note = '';
    if (info.mirroring) note = t('（確認を打ち切り・危険）', ' (skip mirror, risky)');
    else if (info.mirrorFirst) note = t('→確認後に突入', ' → then entry');
    else if (info.scouted === true) {
      note = info.threats > 0 ? t(`（確認済・敵${info.threats}）`, ` (scouted, ${info.threats} hostile)`) : t('（確認済・空）', ' (scouted, empty)');
    }
    ctx.quickHintCache = `Z : ${orderLabelText(ctx.cfg, info.order)}${note}`;
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

export function executeOrder(ctx: SquadContext, order: SquadOrder, orderCtx: OrderContext, mirrorThenEntry = false): void {
  const targets = activeTargets(ctx, orderCtx.element);
  if (targets.length === 0) {
    ctx.ack = t('指示可能な生存隊員がいません', 'No living officers available');
    ctx.ackLeft = 1.4;
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
    order === 'mirror';
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
    // 全員がスタックし、先頭の 1 名が数秒静止してドア下をミラー確認する
    const lead = assignPortalGroup(ctx, targets, portal, targetRoom, 'stack');
    startMirror(ctx, lead, mirrorThenEntry ? { element: orderCtx.element } : null);
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
  ally.flashRetryCd = 0;
  ally.sweepRetryCd = 0;
  ally.mirrorLeft = 0;
  ally.mirrorStarted = false;
  ally.mirrorThen = null;
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
