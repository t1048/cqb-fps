import { EventBus } from './EventBus';
import type { Vec3 } from './types';

export type NoiseKind = 'footstep' | 'gunshot' | 'door' | 'breach' | 'flash' | 'voice';
export type NoiseSource = 'player' | 'ally' | 'suspect';

/** 発生源の識別子。'player' または entity id */
export type ActorId = string;

export enum SuspectState {
  BARRICADED = 'BARRICADED',
  ALERT = 'ALERT',
  CONFRONTATION = 'CONFRONTATION',
  HESITATE = 'HESITATE',
  SURRENDER = 'SURRENDER',
  ENGAGE = 'ENGAGE',
  HOSTAGE_SHIELD = 'HOSTAGE_SHIELD',
  NEGOTIATION = 'NEGOTIATION',
  ARRESTED = 'ARRESTED',
  DOWN = 'DOWN',
}

/** 民間人ステート（MVP_SPEC §3） */
export enum CivilianState {
  IDLE = 'IDLE',
  PANIC = 'PANIC',
  COMPLY = 'COMPLY',
  SHIELDED = 'SHIELDED',
  SECURED = 'SECURED',
}

export type NegotiationResult = 'surrender' | 'release' | 'fire' | 'worsen' | 'abort' | 'interrupted';

export type RoeViolationKind =
  | 'fireWithoutWarning'
  | 'fireOnSurrendered'
  | 'civilianHit'
  | 'nonlethalCivilianHit'
  | 'friendlyFire';

export interface GameEvents {
  noise: { pos: Vec3; radius: number; kind: NoiseKind; source?: NoiseSource };
  warningCall: { pos: Vec3; dir: Vec3 };
  /** radius = 効果半径(m)。視線判定は受け手側（Flashbang.hasLineOfSight 利用可）。blindSec = 最大白飛び時間 */
  flashDetonated: { pos: Vec3; radius: number; blindSec: number };
  /** radius = 室内近距離の影響半径、dir = 部屋の内側方向（水平単位ベクトル）。士気-20 は T3 が消費 */
  doorBreached: { doorId: string; pos: Vec3; radius: number; dir: Vec3 };
  shotFired: { shooter: ActorId; pos: Vec3 };
  /** 容疑者の発砲（T3-3 追加）。warned=発砲時点で警告コールを受けていたか（false=警告前発砲） */
  suspectFired: { id: string; pos: Vec3; warned: boolean };
  entityHit: {
    targetId: ActorId;
    shooter: ActorId;
    damage: number;
    pos: Vec3;
    weaponId?: string;
    /** 非致死性装備(category=nonlethal)の命中（T3-7 追加）。damage=0 で、士気低下＋怯みのみ適用する */
    nonlethal?: boolean;
    /** 非致死性装備の士気低下倍率（weapons.json moraleDamage / 50、T3-8 反映） */
    moraleScale?: number;
  };
  /** 民間人の状態変化（T2-4 追加） */
  civilianStateChanged: { id: string; from: CivilianState; to: CivilianState };
  /** 人質盾の開始/解除（T3-4 追加）。active=true: 容疑者が民間人を保持した。T3-6 が民間人 SHIELDED 遷移に使う */
  hostageShield: { suspectId: string; civilianId: string; active: boolean };
  suspectStateChanged: {
    id: string;
    from: SuspectState;
    to: SuspectState;
    morale: number;
  };
  /** 証拠（落とした武器）回収（T2-5 追加） */
  evidence: { targetId: string; pos: Vec3 };
  arrest: { targetId: string; evidenceCollected: boolean };
  /** 交渉の進行（T3-5 追加）。end の result: surrender/release=解決、fire=発砲、worsen=悪化、abort/interrupted=中断 */
  negotiation: {
    suspectId: string;
    phase: 'start' | 'choice' | 'end';
    choiceId?: string;
    success?: boolean;
    result?: NegotiationResult;
    morale: number;
  };
  roeViolation: { kind: RoeViolationKind; targetId?: string; points: number };
  /** プレイヤー被弾（敵弾ヒット） */
  playerHit: { shooter: ActorId; damage: number; from: Vec3; hp: number };
  /** 隊員の無線コール・状態報告 */
  allyRadio: { allyId: string; name: string; text: string; voiceText?: string };
}

export type GameEventBus = EventBus<GameEvents>;

export function createGameEventBus(): GameEventBus {
  return new EventBus<GameEvents>();
}
