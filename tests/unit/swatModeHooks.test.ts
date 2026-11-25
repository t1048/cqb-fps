import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus, SuspectState } from '../../src/core/events';
import { DataError, SQUAD_ORDERS, validateSquad } from '../../src/core/DataLoader';
import type { AIProfile, EntityDef, RoomDef, SquadOrder, Vec3, WarningConfig } from '../../src/core/types';
import { EntityManager, type GasField } from '../../src/ai/EntityManager';
import { Morale, MoraleSystem, type MoraleActor } from '../../src/ai/Morale';
import { Suspect } from '../../src/ai/Suspect';
import { Civilian } from '../../src/ai/Civilian';
import { BASE_SWAT_COMBAT } from '../../src/ai/SwatProfile';
import { CommandMenu } from '../../src/ui/CommandMenu';
import type { Collider } from '../../src/world/WorldBuilder';
import type { WeaponSystem, HitTarget } from '../../src/weapons/WeaponSystem';
import type { PlayerController } from '../../src/player/PlayerController';
import type { Door, DoorSystem } from '../../src/world/Door';

// ---------- Lightweight Node DOM / Window Stub ----------

interface StubElement {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  style: Record<string, string>;
  children: StubElement[];
  parent: StubElement | null;
  width: number;
  height: number;
  append: (...nodes: StubElement[]) => void;
  appendChild: (node: StubElement) => StubElement;
  remove: () => void;
  getContext: (kind: string) => Record<string, unknown> | null;
}

function makeStubElement(tagName: string): StubElement {
  const el: StubElement = {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    hidden: false,
    style: {},
    children: [],
    parent: null,
    width: 128,
    height: 32,
    append(...nodes: StubElement[]) {
      for (const n of nodes) el.appendChild(n);
    },
    appendChild(node: StubElement) {
      node.parent = el;
      el.children.push(node);
      return node;
    },
    remove() {
      if (!el.parent) return;
      const idx = el.parent.children.indexOf(el);
      if (idx >= 0) el.parent.children.splice(idx, 1);
      el.parent = null;
    },
    getContext(kind: string) {
      if (kind !== '2d') return null;
      return {
        clearRect() {},
        fillRect() {},
        fillText() {},
        strokeRect() {},
        beginPath() {},
        roundRect() {},
        fill() {},
        measureText: (t: string) => ({ width: t.length * 8 }),
        font: '',
        fillStyle: '',
        textAlign: '',
        textBaseline: '',
      };
    },
  };
  return el;
}

function collectText(el: StubElement): string[] {
  const out: string[] = [];
  if (el.textContent) out.push(el.textContent);
  for (const ch of el.children) out.push(...collectText(ch));
  return out;
}

let origDocument: unknown;
let origWindow: unknown;

function installStubDom(): { head: StubElement; body: StubElement } {
  origDocument = (globalThis as Record<string, unknown>).document;
  origWindow = (globalThis as Record<string, unknown>).window;
  const head = makeStubElement('head');
  const body = makeStubElement('body');
  (globalThis as Record<string, unknown>).document = {
    head,
    body,
    createElement: (tag: string) => makeStubElement(tag),
  };
  (globalThis as Record<string, unknown>).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { head, body };
}

function restoreStubDom(): void {
  if (origDocument === undefined) delete (globalThis as Record<string, unknown>).document;
  else (globalThis as Record<string, unknown>).document = origDocument;
  if (origWindow === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = origWindow;
}

// ---------- Fixtures ----------

function makeSuspectProfile(overrides?: Partial<AIProfile>): AIProfile {
  return {
    id: 'test_suspect',
    role: 'suspect',
    initialMorale: 75,
    moraleRecovery: 2.0,
    reactionTime: 0.25,
    thresholds: { hesitateBelow: 40, surrenderBelow: 20 },
    modifiers: {
      warningCall: 15,
      flashbang: 30,
      nonlethalHit: 25,
      breach: 20,
      isolation: 10,
    },
    fakeSurrenderChance: 0,
    combat: {
      decisionSec: 0.4,
      alertCalmSec: 8,
      hesitateFireSec: 4,
      hesitateRetreatDist: 1.5,
      moveSpeed: 2.4,
      fireInterval: 0.35,
      shotsPerPeek: 3,
      magazineSize: 15,
      reloadSec: 2.0,
      coverSearchRange: 6,
      coverDistance: 1.5,
      peekSecMax: 1.2,
      flinchSec: 0.4,
      engageRange: 16,
      shotDamage: 12,
      gunshotNoiseRadius: 30,
      baseSpreadDeg: 3.0,
    },
    ...overrides,
  };
}

function makeCivilianProfile(): AIProfile {
  return {
    id: 'test_civilian',
    role: 'civilian',
    initialMorale: 20,
    moraleRecovery: 0,
    reactionTime: 0.4,
    thresholds: { hesitateBelow: 30, surrenderBelow: 25 },
    modifiers: { warningCall: 20, flashbang: 30, nonlethalHit: 20, breach: 20, isolation: 10 },
    fakeSurrenderChance: 0,
  };
}

function makeWall(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Collider {
  return {
    aabb: {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    },
    kind: 'wall',
  };
}

function makeMockWeapons(): { weapons: WeaponSystem; added: HitTarget[]; removed: HitTarget[] } {
  const added: HitTarget[] = [];
  const removed: HitTarget[] = [];
  const weapons = {
    addTarget: vi.fn((t: HitTarget) => added.push(t)),
    removeTarget: vi.fn((t: HitTarget) => removed.push(t)),
  } as unknown as WeaponSystem;
  return { weapons, added, removed };
}

const DEFAULT_WARNING: WarningConfig = { range: 12, coneDeg: 60, cooldown: 2, noiseRadius: 15 };

// ---------- Tests ----------

describe('M2 SWAT-Mode Target Hooks & Schema', () => {
  beforeEach(() => {
    installStubDom();
  });

  afterEach(() => {
    restoreStubDom();
    vi.restoreAllMocks();
  });

  describe('Suspect CS tear gas exposure hooks (nonlethal)', () => {
    it('builds exposure, emits cough voice noise, degrades spread/speed, drains morale, and restores cleanly outside gas without reducing HP', () => {
      const bus = createGameEventBus();
      const noises: { kind: string; source?: string; radius: number }[] = [];
      bus.on('noise', (e) => noises.push({ kind: e.kind, source: e.source, radius: e.radius }));

      const profile = makeSuspectProfile({ initialMorale: 85, moraleRecovery: 3.0 });
      const def: EntityDef = { id: 's1', type: 'suspect', x: 0, z: 0, hp: 100, profile: profile.id };
      const suspect = new Suspect(def, profile, bus, null);

      const baseSpeed = suspect.currentMoveSpeed;
      const baseSpread = suspect.currentSpreadDeg;
      const initialMorale = suspect.morale.value;

      // Expose to full-density CS gas for 2.0s (40 frames at 0.05s)
      for (let i = 0; i < 40; i++) {
        suspect.update(0.05, { density: 1.0, origin: { x: 0, y: 1.2, z: -1 } });
      }

      // Nonlethal invariant: HP must NEVER drop
      expect(suspect.hp).toBe(100);
      expect(suspect.alive).toBe(true);

      // Gas exposure built up, coughing triggered, cough noise emitted
      expect(suspect.gasExposure).toBeGreaterThan(80);
      expect(suspect.isCoughing).toBe(true);
      expect(noises.some((n) => n.kind === 'voice' && n.source === 'suspect')).toBe(true);

      // Spread penalty & movement speed reduction applied
      expect(suspect.currentSpreadDeg).toBeGreaterThan(baseSpread + 5);
      expect(suspect.currentMoveSpeed).toBeLessThan(baseSpeed * 0.7);

      // Morale drained (and recovery paused while exposed)
      expect(suspect.morale.value).toBeLessThan(initialMorale - 15);

      // Upgrade weapon while gassed, then clear gas and verify baseSpreadDeg reflects upgrade accurately
      suspect.upgradeWeapon(1.2, 0.5);
      for (let i = 0; i < 160; i++) {
        suspect.update(0.05, { density: 0, origin: null });
      }

      expect(suspect.gasExposure).toBe(0);
      expect(suspect.isCoughing).toBe(false);
      expect(suspect.currentMoveSpeed).toBeCloseTo(baseSpeed, 5);
      expect(suspect.currentSpreadDeg).toBeCloseTo(baseSpread * 0.5, 5);
      expect(suspect.hp).toBe(100);

      suspect.dispose();
    });

    it('flushes a barricaded suspect away from gas cloud and drives prolonged exposure to SURRENDER without lethal harm', () => {
      const bus = createGameEventBus();
      const rooms: RoomDef[] = [
        { id: 'r1', name: 'Gas Room', x: 0, z: 0, width: 6, depth: 6, floorY: 0 },
        { id: 'r2', name: 'Safe Room', x: 8, z: 0, width: 6, depth: 6, floorY: 0 },
      ];
      const profile = makeSuspectProfile({ initialMorale: 55 });
      const def: EntityDef = { id: 's_flush', type: 'suspect', x: 0, z: 0, hp: 100, profile: profile.id };
      const mockPlayer = {
        position: new THREE.Vector3(20, 0, 20),
        yawRad: 0,
        pitchRad: 0,
        alive: true,
        getEyePosition: () => new THREE.Vector3(20, 1.6, 20),
        takeDamage: () => 100,
        getBodyBounds: () => ({ min: { x: 19.7, y: 0, z: 19.7 }, max: { x: 20.3, y: 1.75, z: 20.3 } }),
      };
      const suspect = new Suspect(def, profile, bus, {
        player: mockPlayer,
        colliders: [],
        playerDamage: () => {},
        rooms,
        bounds: { width: 30, depth: 30 },
      });

      const startX = suspect.body.px;
      // Gas cloud centered at (-1, 1.2, 0), safe room at (+8, 0, 0)
      for (let i = 0; i < 30; i++) {
        suspect.update(0.05, { density: 0.9, origin: { x: -1, y: 1.2, z: 0 } });
      }

      // Suspect moved away from gas toward safe room (+X) and left BARRICADED
      expect(suspect.body.px).toBeGreaterThan(startX + 0.5);
      expect(suspect.state).not.toBe(SuspectState.BARRICADED);
      expect(suspect.hp).toBe(100);

      // Continued prolonged exposure drops morale below surrenderBelow -> SURRENDER, still 100 HP
      for (let i = 0; i < 80; i++) {
        suspect.update(0.05, { density: 1.0, origin: { x: suspect.body.px, y: 1.2, z: suspect.body.pz } });
      }
      expect(suspect.state).toBe(SuspectState.SURRENDER);
      expect(suspect.hp).toBe(100);
      expect(suspect.alive).toBe(true);

      suspect.dispose();
    });

    it('wires EntityManager.setTearGas into Suspect.update with gradient/fallback origin and never harms civilians', () => {
      const bus = createGameEventBus();
      const { weapons } = makeMockWeapons();
      const sProfile = makeSuspectProfile({ initialMorale: 80 });
      const cProfile = makeCivilianProfile();
      const defs: EntityDef[] = [
        { id: 's_in', type: 'suspect', x: 1.5, z: 0, hp: 100, profile: sProfile.id },
        { id: 's_out', type: 'suspect', x: 12, z: 0, hp: 100, profile: sProfile.id },
        { id: 'c_in', type: 'civilian', x: 0.5, z: 0, hp: 50, profile: cProfile.id },
      ];
      const em = new EntityManager(defs, [sProfile, cProfile], weapons, [], DEFAULT_WARNING, bus);

      // Radial gas field centered at (0, 1.2, 0) with radius 4.2m
      const gasField: GasField = {
        exposureAt(pos: THREE.Vector3): number {
          const d = Math.hypot(pos.x, pos.z);
          if (d > 4.2) return 0;
          return Math.max(0, 1 - 0.55 * (d / 4.2));
        },
      };
      em.setTearGas(gasField);
      bus.emit('gasDetonated', { pos: { x: 0, y: 1.2, z: 0 }, radius: 4.2 });

      for (let i = 0; i < 30; i++) {
        em.update(0.05);
      }

      const sIn = em.suspects.get('s_in')!;
      const sOut = em.suspects.get('s_out')!;
      const cIn = em.civilians.get('c_in')!;

      expect(sIn.gasExposure).toBeGreaterThan(20);
      expect(sIn.morale.value).toBeLessThan(80);
      expect(sIn.hp).toBe(100);
      // Suspect moved away from origin (0,0) in +X direction via finite-difference gradient
      expect(sIn.body.px).toBeGreaterThan(1.5);

      // Out-of-cloud suspect unaffected
      expect(sOut.gasExposure).toBe(0);
      expect(sOut.morale.value).toBe(80);

      // Civilian completely unharmed
      expect(cIn.alive).toBe(true);
      expect(cIn.hp).toBe(50);

      em.dispose();
    });

    it('evaluates surrender cleanly after endNegotiation(abort) when CS gas drained morale to 0 during NEGOTIATION', () => {
      const bus = createGameEventBus();
      const profile = makeSuspectProfile({
        initialMorale: 30,
        thresholds: { hesitateBelow: 40, surrenderBelow: 20 },
      });
      const def: EntityDef = { id: 's_nego_gas', type: 'suspect', x: 0, z: 0, hp: 100, profile: profile.id };
      const suspect = new Suspect(def, profile, bus, null);

      const started = suspect.beginNegotiation({ x: 0, y: 0, z: 3 }, [SuspectState.BARRICADED]);
      expect(started).toBe(true);
      expect(suspect.state).toBe(SuspectState.NEGOTIATION);

      // Drain morale all the way to 0 under CS gas while in NEGOTIATION
      for (let i = 0; i < 60; i++) {
        suspect.update(0.1, { density: 1.0, origin: { x: 0, y: 1.2, z: -1 } });
      }
      expect(suspect.morale.value).toBe(0);
      expect(suspect.hp).toBe(100);

      // Aborting negotiation must evaluate surrender instead of staying stuck in BARRICADED/ALERT at morale = 0
      suspect.endNegotiation('abort', 0);
      expect(suspect.state).toBe(SuspectState.SURRENDER);
      expect(suspect.hp).toBe(100);
      expect(suspect.alive).toBe(true);

      // Additional updates under continuous CS gas keep suspect surrendered and unharmed
      suspect.update(0.05, { density: 1.0, origin: { x: 0, y: 1.2, z: -1 } });
      expect(suspect.state).toBe(SuspectState.SURRENDER);
      expect(suspect.hp).toBe(100);

      suspect.dispose();
    });
  });

  describe('MoraleSystem c2Detonated listener', () => {
    it('shocks and stuns in-range forward actors with LOS while ignoring out-of-range, behind-door, occluded, and DOWN/ARRESTED actors', () => {
      const bus = createGameEventBus();
      const profile = makeSuspectProfile({ initialMorale: 80 });
      const makeActor = (id: string, x: number, z: number, state: SuspectState): MoraleActor & { flashedSec: number } => {
        const actor = {
          id,
          state,
          morale: new Morale(profile),
          body: { chestPos: (): Vec3 => ({ x, y: 1.2, z }), px: x, pz: z, footY: 0 },
          flashedSec: 0,
          onFlashed(sec: number) {
            actor.flashedSec = Math.max(actor.flashedSec, sec);
          },
        };
        return actor;
      };

      const inCone = makeActor('in_cone', 0, -2.0, SuspectState.BARRICADED);
      const outRange = makeActor('out_range', 0, -8.0, SuspectState.BARRICADED);
      const behindDoor = makeActor('behind', 0, 2.0, SuspectState.BARRICADED);
      const occluded = makeActor('occluded', 3.0, -2.0, SuspectState.BARRICADED);
      const downActor = makeActor('down', 0, -1.5, SuspectState.DOWN);
      const arrestedActor = makeActor('arrested', 0, -1.5, SuspectState.ARRESTED);

      // Wall between origin (0, 1, -0.25) and occluded (3, 1.2, -2)
      const wall = makeWall(1.4, 0, -3.5, 1.6, 3.0, 0.5);
      const ms = new MoraleSystem(
        bus,
        () => [inCone, outRange, behindDoor, occluded, downActor, arrestedActor],
        [wall],
        [],
      );

      bus.emit('c2Detonated', {
        doorId: 'door_1',
        pos: { x: 0, y: 1.0, z: 0 },
        dir: { x: 0, y: 0, z: -1 },
        radius: 4.5,
      });

      expect(inCone.morale.value).toBeLessThan(80);
      expect(inCone.flashedSec).toBeGreaterThan(0);

      expect(outRange.morale.value).toBe(80);
      expect(outRange.flashedSec).toBe(0);

      expect(behindDoor.morale.value).toBe(80);
      expect(behindDoor.flashedSec).toBe(0);

      expect(occluded.morale.value).toBe(80);
      expect(occluded.flashedSec).toBe(0);

      expect(downActor.morale.value).toBe(80);
      expect(downActor.flashedSec).toBe(0);

      expect(arrestedActor.morale.value).toBe(80);
      expect(arrestedActor.flashedSec).toBe(0);

      ms.dispose();
    });

    it('rejects NaN/non-finite radius, pos, dir, and zero horizontal dir without mutating morale or blindLeft', () => {
      const bus = createGameEventBus();
      const profile = makeSuspectProfile({ initialMorale: 80 });
      const suspect = new Suspect(
        { id: 's_guard', type: 'suspect', x: 0, z: -1.0, hp: 100, profile: profile.id },
        profile,
        bus,
        null,
      );
      const ms = new MoraleSystem(bus, () => [suspect], [], []);

      const badPayloads = [
        { doorId: 'd1', pos: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, radius: Number.NaN },
        { doorId: 'd2', pos: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, radius: Number.POSITIVE_INFINITY },
        { doorId: 'd3', pos: { x: Number.NaN, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, radius: 4.5 },
        { doorId: 'd4', pos: { x: 0, y: Number.NaN, z: 0 }, dir: { x: 0, y: 0, z: -1 }, radius: 4.5 },
        { doorId: 'd5', pos: { x: 0, y: 1, z: Number.NaN }, dir: { x: 0, y: 0, z: -1 }, radius: 4.5 },
        { doorId: 'd6', pos: { x: 0, y: 1, z: 0 }, dir: { x: Number.NaN, y: 0, z: -1 }, radius: 4.5 },
        { doorId: 'd7', pos: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: Number.NaN }, radius: 4.5 },
        { doorId: 'd8', pos: { x: 0, y: 1, z: -1.0 }, dir: { x: 0, y: 1, z: 0 }, radius: 4.5 },
      ];

      for (const payload of badPayloads) {
        bus.emit('c2Detonated', payload);
      }

      // Defense-in-depth direct calls with NaN/non-finite inputs
      expect(suspect.morale.apply('breach', Number.NaN)).toBe(0);
      expect(suspect.morale.apply('breach', Number.POSITIVE_INFINITY)).toBe(0);
      suspect.onFlashed(Number.NaN);
      suspect.onFlashed(Number.POSITIVE_INFINITY);
      suspect.onFlashed(-2);

      expect(Number.isFinite(suspect.morale.value)).toBe(true);
      expect(suspect.morale.value).toBe(80);
      expect(suspect.isFlashed).toBe(false);
      // Verify normal flash still works afterwards (blindLeft not poisoned with NaN)
      suspect.onFlashed(1.5);
      expect(suspect.isFlashed).toBe(true);

      ms.dispose();
      suspect.dispose();
    });
  });

  describe('EntityManager.applyC2Blast', () => {
    it('damages, stuns, and shocks hostile/barricaded suspects in cone while guaranteeing zero lethal damage to civilians and SURRENDER/ARRESTED suspects', () => {
      const bus = createGameEventBus();
      const { weapons, removed } = makeMockWeapons();
      const sProfile = makeSuspectProfile({ initialMorale: 85 });
      const cProfile = makeCivilianProfile();

      const defs: EntityDef[] = [
        { id: 's_hostile', type: 'suspect', x: 0, z: -1.5, hp: 100, profile: sProfile.id },
        { id: 's_low_hp', type: 'suspect', x: 0.2, z: -1.0, hp: 20, profile: sProfile.id },
        { id: 's_surrender', type: 'suspect', x: -0.3, z: -1.4, hp: 100, profile: sProfile.id },
        { id: 's_arrested', type: 'suspect', x: 0.3, z: -1.4, hp: 100, profile: sProfile.id },
        { id: 's_outside_cone', type: 'suspect', x: 3.5, z: -0.3, hp: 100, profile: sProfile.id },
        { id: 's_behind', type: 'suspect', x: 0, z: 1.8, hp: 100, profile: sProfile.id },
        { id: 's_occluded', type: 'suspect', x: -2.5, z: -2.0, hp: 100, profile: sProfile.id },
        { id: 'civ_in_cone', type: 'civilian', x: 0, z: -1.2, hp: 50, profile: cProfile.id },
      ];

      // Wall blocking LOS to s_occluded (-2.5, -2.0)
      const wall = makeWall(-1.6, 0, -3.5, -1.4, 3.0, 0.5);
      const em = new EntityManager(defs, [sProfile, cProfile], weapons, [wall], DEFAULT_WARNING, bus);

      // Put s_surrender into SURRENDER and s_arrested into ARRESTED
      const sSurrender = em.suspects.get('s_surrender')!;
      sSurrender.forceSurrender();
      const sArrested = em.suspects.get('s_arrested')!;
      sArrested.forceSurrender();
      for (let i = 0; i < 20; i++) sArrested.update(0.05);
      expect(sArrested.arrest()).toBe(true);
      expect(sArrested.state).toBe(SuspectState.ARRESTED);

      const res = em.applyC2Blast({ x: 0, y: 1.0, z: 0 }, { x: 0, y: 0, z: -1 }, 4.5, 70, 45, 'ally_1');

      const sHostile = em.suspects.get('s_hostile')!;
      const sLowHp = em.suspects.get('s_low_hp')!;
      const sOutside = em.suspects.get('s_outside_cone')!;
      const sBehind = em.suspects.get('s_behind')!;
      const sOccluded = em.suspects.get('s_occluded')!;
      const civ = em.civilians.get('civ_in_cone')!;

      // Active suspects in cone: damaged, stunned, morale dropped; low-HP suspect killed & removed from weapons
      expect(res.damagedIds).toContain('s_hostile');
      expect(res.stunnedIds).toContain('s_hostile');
      expect(sHostile.hp).toBeLessThan(100);
      expect(sHostile.morale.value).toBeLessThan(85);
      expect(sHostile.isFlashed).toBe(true);

      expect(res.killedIds).toContain('s_low_hp');
      expect(sLowHp.alive).toBe(false);
      expect(removed).toContain(sLowHp);

      // ROE safety invariants: zero lethal damage to SURRENDER, ARRESTED, and civilians
      expect(sSurrender.hp).toBe(100);
      expect(sSurrender.alive).toBe(true);
      expect(sSurrender.state).toBe(SuspectState.SURRENDER);
      expect(res.damagedIds).not.toContain('s_surrender');

      expect(sArrested.hp).toBe(100);
      expect(sArrested.alive).toBe(true);
      expect(sArrested.state).toBe(SuspectState.ARRESTED);
      expect(res.damagedIds).not.toContain('s_arrested');

      expect(civ.hp).toBe(50);
      expect(civ.alive).toBe(true);

      // Out of cone / behind door / occluded: zero damage
      expect(sOutside.hp).toBe(100);
      expect(sBehind.hp).toBe(100);
      expect(sOccluded.hp).toBe(100);

      em.dispose();
    });

    it('rejects NaN/non-finite parameters, non-positive halfAngleDeg, negative maxDamage, and zero horizontal blastDir without mutating HP, morale, or blindLeft', () => {
      const bus = createGameEventBus();
      const { weapons } = makeMockWeapons();
      const sProfile = makeSuspectProfile({ initialMorale: 85 });
      const defs: EntityDef[] = [
        { id: 's_front', type: 'suspect', x: 0, z: -1.5, hp: 100, profile: sProfile.id },
        { id: 's_behind', type: 'suspect', x: 0, z: 1.5, hp: 100, profile: sProfile.id },
        { id: 's_at_door', type: 'suspect', x: 0, z: 0, hp: 100, profile: sProfile.id },
      ];
      const em = new EntityManager(defs, [sProfile], weapons, [], DEFAULT_WARNING, bus);

      const cases: Parameters<EntityManager['applyC2Blast']>[] = [
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, Number.NaN, 70, 45, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, Number.POSITIVE_INFINITY, 70, 45, 'c2'],
        [{ x: Number.NaN, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 4.5, 70, 45, 'c2'],
        [{ x: 0, y: Number.NaN, z: 0 }, { x: 0, y: 0, z: -1 }, 4.5, 70, 45, 'c2'],
        [{ x: 0, y: 1, z: Number.NaN }, { x: 0, y: 0, z: -1 }, 4.5, 70, 45, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: Number.NaN, y: 0, z: -1 }, 4.5, 70, 45, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: Number.NaN }, 4.5, 70, 45, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 4.5, Number.NaN, 45, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 4.5, 0, 45, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 4.5, -70, 45, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 4.5, 70, Number.NaN, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 4.5, 70, -10, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, 4.5, 120, 45, 'c2'],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 4.5, 70, 45, 'c2'],
      ];

      for (const args of cases) {
        const res = em.applyC2Blast(...args);
        expect(res).toEqual({ damagedIds: [], stunnedIds: [], killedIds: [] });
      }

      for (const s of em.suspects.values()) {
        expect(s.hp).toBe(100);
        expect(s.alive).toBe(true);
        expect(Number.isFinite(s.morale.value)).toBe(true);
        expect(s.morale.value).toBe(85);
        expect(s.isFlashed).toBe(false);
        // Verify blindLeft was not poisoned with NaN
        s.onFlashed(1.0);
        expect(s.isFlashed).toBe(true);
      }

      em.dispose();
    });
  });

  describe('Suspect.takeNonlethalHit (pepperball) including HOSTAGE_SHIELD', () => {
    it('applies morale drop and flinch with zero HP loss and cleanly releases hostage during HOSTAGE_SHIELD', () => {
      const bus = createGameEventBus();
      const shieldEvents: { suspectId: string; active: boolean }[] = [];
      bus.on('hostageShield', (e) => shieldEvents.push({ suspectId: e.suspectId, active: e.active }));

      const sProfile = makeSuspectProfile({
        initialMorale: 55,
        thresholds: { hesitateBelow: 40, surrenderBelow: 20 },
        shield: {
          moraleBelow: 70,
          triggerChance: 1.0,
          grabRange: 4.0,
          releaseBelow: 10,
          hostageOffset: 0.55,
          moveSpeed: 1.4,
          aimShiftDeg: 10,
          escapeDist: 10,
        },
      });
      const cProfile = makeCivilianProfile();
      const rooms: RoomDef[] = [{ id: 'r1', name: 'Room 1', x: 0, z: 0, width: 10, depth: 10, floorY: 0 }];
      const civ = new Civilian({ id: 'civ_1', type: 'civilian', x: 0.6, z: 0, hp: 50, profile: cProfile.id }, cProfile, bus, []);
      const mockPlayer = {
        position: new THREE.Vector3(0, 0, 4),
        yawRad: 0,
        pitchRad: 0,
        alive: true,
        getEyePosition: () => new THREE.Vector3(0, 1.6, 4),
        takeDamage: () => 100,
        getBodyBounds: () => ({ min: { x: -0.3, y: 0, z: 3.7 }, max: { x: 0.3, y: 1.75, z: 4.3 } }),
      };

      const suspect = new Suspect(
        { id: 's_shield', type: 'suspect', x: 0, z: 0, hp: 100, profile: sProfile.id },
        sProfile,
        bus,
        {
          player: mockPlayer,
          colliders: [],
          civilians: () => [civ],
          playerDamage: () => {},
          rooms,
        },
      );

      // Force suspect to see player and enter HOSTAGE_SHIELD
      suspect.onSpotted({ x: 0, y: 0, z: 4 });
      for (let i = 0; i < 40 && suspect.state !== SuspectState.HOSTAGE_SHIELD; i++) {
        suspect.update(0.05);
      }
      expect(suspect.state).toBe(SuspectState.HOSTAGE_SHIELD);
      expect(civ.shieldedBy).toBe('s_shield');
      expect(shieldEvents.some((e) => e.suspectId === 's_shield' && e.active === true)).toBe(true);

      const moraleBefore = suspect.morale.value;
      // Hit with friendly SWAT pepperball (nonlethal)
      suspect.takeNonlethalHit({ x: 0, y: 0, z: 4 }, 1.0);

      expect(suspect.hp).toBe(100);
      expect(suspect.morale.value).toBeLessThan(moraleBefore);
      // Released hostage cleanly and exited HOSTAGE_SHIELD
      expect(suspect.state).not.toBe(SuspectState.HOSTAGE_SHIELD);
      expect(civ.shieldedBy).toBeNull();
      expect(civ.alive).toBe(true);
      expect(civ.hp).toBe(50);
      expect(shieldEvents.some((e) => e.suspectId === 's_shield' && e.active === false)).toBe(true);

      suspect.dispose();
      civ.dispose();
    });
  });

  describe('DataLoader.validateSquad & public/data/squad.json', () => {
    const squadJsonPath = path.resolve(process.cwd(), 'public/data/squad.json');

    it('validates public/data/squad.json with c2Clear/gasClear labels and aligned SwatProfile combat defaults', () => {
      const raw = JSON.parse(fs.readFileSync(squadJsonPath, 'utf-8'));
      const cfg = validateSquad(raw);

      expect(SQUAD_ORDERS).toContain('c2Clear');
      expect(SQUAD_ORDERS).toContain('gasClear');
      expect(cfg.orderLabels.c2Clear.length).toBeGreaterThan(0);
      expect(cfg.orderLabels.gasClear.length).toBeGreaterThan(0);

      // Aligned with BASE_SWAT_COMBAT SSOT
      expect(cfg.moveSpeed).toBe(BASE_SWAT_COMBAT.moveSpeed);
      expect(cfg.engageRange).toBe(BASE_SWAT_COMBAT.engageRange);
      expect(cfg.fireInterval).toBe(BASE_SWAT_COMBAT.fireInterval);
      expect(cfg.damage).toBe(BASE_SWAT_COMBAT.shotDamage);
    });

    it('rejects squad config missing orderLabels.c2Clear or orderLabels.gasClear', () => {
      const raw = JSON.parse(fs.readFileSync(squadJsonPath, 'utf-8'));

      const missingC2 = structuredClone(raw);
      delete missingC2.orderLabels.c2Clear;
      expect(() => validateSquad(missingC2)).toThrow(DataError);

      const missingGas = structuredClone(raw);
      delete missingGas.orderLabels.gasClear;
      expect(() => validateSquad(missingGas)).toThrow(DataError);
    });
  });

  describe('CommandMenu door & area context entries for c2Clear and gasClear', () => {
    const squadJsonPath = path.resolve(process.cwd(), 'public/data/squad.json');

    function makeMockPlayer(x: number, z: number, yawRad = 0): PlayerController {
      const pos = new THREE.Vector3(x, 0, z);
      return {
        position: pos,
        yawRad,
        pitchRad: 0,
        getEyePosition: (out = new THREE.Vector3()) => out.set(pos.x, pos.y + 1.6, pos.z),
      } as unknown as PlayerController;
    }

    function makeMockDoor(opts: { locked: boolean; angle: number }): Door {
      return {
        id: 'door_1',
        centerX: 0,
        centerZ: -2,
        sillY: 0,
        normalX: 0,
        normalZ: 1,
        axisX: 1,
        axisZ: 0,
        width: 1.0,
        angle: opts.angle,
        locked: opts.locked,
        stage: opts.angle > 5 ? 'open' : 'closed',
      } as unknown as Door;
    }

    it('renders and executes both gasClear and c2Clear in door context (locked & unlocked) with [1-9] footer hint', () => {
      const cfg = validateSquad(JSON.parse(fs.readFileSync(squadJsonPath, 'utf-8')));
      const rooms: RoomDef[] = [
        { id: 'hall', name: 'Hall', x: 0, z: 0, width: 6, depth: 4, floorY: 0 },
        { id: 'target', name: 'Target Room', x: 0, z: -5, width: 6, depth: 6, floorY: 0 },
      ];
      const emptyEntities = { suspects: new Map(), civilians: new Map() } as unknown as EntityManager;

      for (const locked of [false, true]) {
        const door = makeMockDoor({ locked, angle: 0 });
        const doors = { aimed: () => door, doors: [door] } as unknown as DoorSystem;
        const menu = new CommandMenu(cfg, makeMockPlayer(0, 0, 0), doors, [], emptyEntities, rooms);

        const executed: SquadOrder[] = [];
        const onExecute = (order: SquadOrder) => executed.push(order);

        menu.handleMenuEvent('open', 0, 'gold', onExecute);
        const body = (globalThis as unknown as { document: { body: StubElement } }).document.body;
        const texts = collectText(body);

        expect(texts.some((t) => t.includes('[1-9'))).toBe(true);
        expect(texts.some((t) => t.includes('ガス＆クリア'))).toBe(true);
        expect(texts.some((t) => t.includes('C2＆クリア'))).toBe(true);

        // In door context: 1=stack, 2=clear, 3=flashClear, 4=gasClear, 5=c2Clear
        menu.handleMenuEvent('select', 4, 'gold', onExecute);
        expect(executed).toEqual(['gasClear']);

        menu.handleMenuEvent('open', 0, 'gold', onExecute);
        menu.handleMenuEvent('select', 5, 'gold', onExecute);
        expect(executed).toEqual(['gasClear', 'c2Clear']);

        menu.dispose();
      }
    });

    it('renders and executes gasClear (and omits door-only c2Clear) in area context', () => {
      const cfg = validateSquad(JSON.parse(fs.readFileSync(squadJsonPath, 'utf-8')));
      const rooms: RoomDef[] = [
        { id: 'hall', name: 'Hall', x: 0, z: 0, width: 6, depth: 4, floorY: 0 },
        { id: 'target', name: 'Target Room', x: 0, z: -5, width: 6, depth: 6, floorY: 0 },
      ];
      // Wide-open door (angle >= doorOpenAngle) resolves as areaTarget rather than door
      const openDoor = makeMockDoor({ locked: false, angle: 90 });
      const doors = { aimed: () => openDoor, doors: [openDoor] } as unknown as DoorSystem;
      const emptyEntities = { suspects: new Map(), civilians: new Map() } as unknown as EntityManager;
      const menu = new CommandMenu(cfg, makeMockPlayer(0, 0, 0), doors, [], emptyEntities, rooms);

      const executed: SquadOrder[] = [];
      const onExecute = (order: SquadOrder) => executed.push(order);

      menu.handleMenuEvent('open', 0, 'gold', onExecute);
      const body = (globalThis as unknown as { document: { body: StubElement } }).document.body;
      const texts = collectText(body);

      expect(texts.some((t) => t.includes('ガス＆クリア'))).toBe(true);
      expect(texts.some((t) => t.includes('C2＆クリア'))).toBe(false);

      // In area context: 1=clear, 2=flashClear, 3=gasClear
      menu.handleMenuEvent('select', 3, 'gold', onExecute);
      expect(executed).toEqual(['gasClear']);

      menu.dispose();
    });

    it('keeps hotkeys strictly within 1..9 (never emitting 10) and preserves restrain & follow when restrainTarget and door are both active', () => {
      const cfg = validateSquad(JSON.parse(fs.readFileSync(squadJsonPath, 'utf-8')));
      const rooms: RoomDef[] = [
        { id: 'hall', name: 'Hall', x: 0, z: 0, width: 6, depth: 4, floorY: 0 },
        { id: 'target', name: 'Target Room', x: 0, z: -5, width: 6, depth: 6, floorY: 0 },
      ];
      const closedDoor = makeMockDoor({ locked: false, angle: 0 });
      const doors = { aimed: () => closedDoor, doors: [closedDoor] } as unknown as DoorSystem;

      // Surrendered suspect positioned in front of the closed door along the player's aim ray
      const bus = createGameEventBus();
      const sProfile = makeSuspectProfile({ initialMorale: 50 });
      const surrendered = new Suspect(
        { id: 's_front', type: 'suspect', x: 0, z: -1.2, hp: 100, profile: sProfile.id },
        sProfile,
        bus,
        null,
      );
      surrendered.forceSurrender();
      const entities = {
        suspects: new Map([[surrendered.id, surrendered]]),
        civilians: new Map(),
      } as unknown as EntityManager;

      const menu = new CommandMenu(cfg, makeMockPlayer(0, 0, 0), doors, [], entities, rooms);

      // Verify both restrainTarget and door are genuinely active simultaneously
      const ctx = menu.resolveContext('gold');
      expect(ctx.restrainTarget).not.toBeNull();
      expect(ctx.door).toBe(closedDoor);

      const executed: SquadOrder[] = [];
      const onExecute = (order: SquadOrder) => executed.push(order);

      menu.handleMenuEvent('open', 0, 'gold', onExecute);

      const body = (globalThis as unknown as { document: { body: StubElement } }).document.body;
      const findRows = (el: StubElement): StubElement[] => {
        const rows: StubElement[] = [];
        if (el.className.split(' ').includes('cqb-cmd-row')) rows.push(el);
        for (const ch of el.children) rows.push(...findRows(ch));
        return rows;
      };
      const rows = findRows(body);
      const numberedRows = rows
        .map((r) => ({ numText: r.children[0]?.textContent ?? '', label: r.children[1]?.textContent ?? '' }))
        .filter((r) => r.numText !== 'ESC');

      expect(numberedRows.length).toBeLessThanOrEqual(9);
      const nums = numberedRows.map((r) => Number(r.numText));
      expect(nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 9)).toBe(true);
      expect(new Set(nums).size).toBe(nums.length);
      expect(numberedRows.some((r) => r.numText === '10')).toBe(false);

      const restrainRow = numberedRows.find((r) => r.label.includes('対象を確保'));
      const followRow = numberedRows.find((r) => r.label.includes('追従'));
      expect(restrainRow).toBeDefined();
      expect(followRow).toBeDefined();

      // Verify both restrain and follow are selectable via their 1..9 hotkeys
      menu.handleMenuEvent('select', Number(restrainRow!.numText), 'gold', onExecute);
      menu.handleMenuEvent('open', 0, 'gold', onExecute);
      menu.handleMenuEvent('select', Number(followRow!.numText), 'gold', onExecute);
      expect(executed).toEqual(['restrain', 'follow']);

      menu.dispose();
      surrendered.dispose();
    });
  });
});
