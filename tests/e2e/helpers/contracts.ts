/**
 * Narrow TypeScript interface contracts for M2/M3 features documented in PROJECT.md § Interface Contracts.
 * Allows E2E tests to dynamically load not-yet-created M3 modules and invoke upcoming contract methods
 * on real SUT instances without syntax/transform failures or SUT mocking.
 */

import type * as THREE from 'three';
import type { GameEventBus, GameEvents } from '../../../src/core/events';
import type { Vec3 } from '../../../src/core/types';
import type { Collider } from '../../../src/world/WorldBuilder';
import type { Door } from '../../../src/world/Door';
import type { Fortify } from '../../../src/modes/Fortify';
import type { SwatTeam, SwatTeamDeps } from '../../../src/modes/SwatTeam';
import type { HumanoidBody } from '../../../src/ai/HumanoidBody';
import type { BriefingScreenOptions } from '../../../src/ui/BriefingScreen';
import type { FlashOverlay } from '../../../src/ui/FlashOverlay';

// ---------- Upcoming GameEvents (M2 / M3) ----------

export interface UpcomingGameEvents {
  c2Beep: { pos: Vec3; urgent: boolean };
  c2Detonated: { doorId: string; pos: Vec3; dir: Vec3; radius: number };
  gasDetonated: { pos: Vec3; radius: number };
  playerCough: { pos: Vec3 };
  swatFootstep: { pos: Vec3; heavy: boolean };
}

export type AllGameEvents = GameEvents & UpcomingGameEvents;

type RawBus = {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void): () => void;
};

export function emitContractEvent<K extends keyof AllGameEvents>(
  bus: GameEventBus,
  event: K,
  payload: AllGameEvents[K],
): void {
  (bus as unknown as RawBus).emit(event as string, payload);
}

export function onContractEvent<K extends keyof AllGameEvents>(
  bus: GameEventBus,
  event: K,
  handler: (payload: AllGameEvents[K]) => void,
): () => void {
  return (bus as unknown as RawBus).on(event as string, handler as (p: unknown) => void);
}

// ---------- M2 Contracts (F6–F9) ----------

export type DoorWithExplosive = Omit<Door, 'breachExplosive'> & {
  breachExplosive?: (fromX: number, fromZ: number) => boolean;
};

export interface BarricadeInfo {
  id: string;
  center: Vec3;
  normal: Vec3;
  floorY: number;
  hp: number;
  boarded: boolean;
}

export interface BarricadeHooks {
  listBoarded(): BarricadeInfo[];
}

export type FortifyWithBarricades = Omit<Fortify, 'listBoarded'> & {
  listBoarded?: () => BarricadeInfo[];
};

export type SwatTeamWithM2M3 = Omit<SwatTeam, 'attachBarricades'> & {
  attachBarricades?: (hooks: BarricadeHooks) => void;
};

// ---------- M3 Contracts (F10–F13) ----------

export interface ColliderIndexContract {
  raycastColliders?: (colliders: readonly Collider[], origin: Vec3, dir: Vec3, maxDist: number) => number;
}

export type HumanoidBodyWithMuzzle = Omit<HumanoidBody, 'getMuzzlePose'> & {
  getMuzzlePose?: (outOrigin: Vec3, outDir: Vec3) => boolean;
};

export type BriefingOptionsWithM3 = BriefingScreenOptions;

export type SwatTeamDepsWithM3 = Omit<SwatTeamDeps, 'flashOverlay' | 'tearGas'> & {
  flashOverlay?: FlashOverlay;
  tearGas?: TearGasInstance;
};

export interface TearGasCloudInfo {
  pos: Vec3;
  radius: number;
  remaining: number;
}

export interface TearGasInstance {
  readonly root?: THREE.Group;
  throwFrom(origin: Vec3, velocity: Vec3, thrower: string, fuseSec?: number): void;
  update(dt: number): void;
  sampleDensity?(pos: Vec3): number;
  densityAt?(pos: Vec3): number;
  isInsideCloud?(pos: Vec3): boolean;
  readonly activeClouds?: readonly TearGasCloudInfo[];
  dispose(): void;
}

export interface TearGasModule {
  TearGas?: new (...args: unknown[]) => TearGasInstance;
  default?: new (...args: unknown[]) => TearGasInstance;
}

export interface TearGasEffectInstance {
  readonly amount?: number;
  readonly level?: number;
  update(dt: number, exposure?: number): void;
  dispose(): void;
}

export interface TearGasEffectModule {
  TearGasEffect?: new (...args: unknown[]) => TearGasEffectInstance;
  default?: new (...args: unknown[]) => TearGasEffectInstance;
}

function isModuleNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT' || code === 'MODULE_NOT_FOUND') {
    return true;
  }
  const msg = typeof e.message === 'string' ? e.message : '';
  return /Cannot find module|Cannot find package|Failed to resolve import|Failed to load url|Does the file exist/i.test(
    msg,
  );
}

/**
 * Dynamically imports a module that may not exist yet in concurrent milestones (M3).
 * Returns `undefined` ONLY when the module file is missing; syntax and runtime errors
 * inside existing modules are rethrown so real bugs are never masked.
 */
export async function loadOptionalModule<T>(relativeFromHelpers: string): Promise<T | undefined> {
  try {
    return (await import(/* @vite-ignore */ relativeFromHelpers)) as T;
  } catch (err) {
    if (isModuleNotFoundError(err)) return undefined;
    throw err;
  }
}
