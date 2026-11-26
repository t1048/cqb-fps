import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import { pickEnglishVoice, radioVoiceProfile } from '../../src/core/Audio';
import { AudioBridge, type AudioBridgeSink } from '../../src/core/AudioBridge';
import {
  SwatTeam,
  RADIO_STAGGER_SEC,
  describePortalDirection,
  type SwatTeamDeps,
} from '../../src/modes/SwatTeam';
import { Door, type DoorSystem } from '../../src/world/Door';
import type { Collider } from '../../src/world/WorldBuilder';
import type { DoorConfig, RoomDef } from '../../src/core/types';
import type { WeaponSystem } from '../../src/weapons/WeaponSystem';
import type { Flashbang } from '../../src/weapons/Flashbang';
import type { Subtitle } from '../../src/ui/Subtitle';

function createSink(): AudioBridgeSink {
  return {
    playFootstep: vi.fn(),
    playDoorCreak: vi.fn(),
    playBreach: vi.fn(),
    playGunshot: vi.fn(),
    playFlashbang: vi.fn(),
    playC2Beep: vi.fn(),
    playC2Blast: vi.fn(),
    playSwatFootstep: vi.fn(),
    playGasHiss: vi.fn(),
    playCough: vi.fn(),
    playWarningCall: vi.fn(),
    playRadioReport: vi.fn(),
    playAllyRadio: vi.fn(),
    triggerEarRinging: vi.fn(),
    updateListener: vi.fn(),
  };
}

const DOOR_CFG: DoorConfig = {
  width: 1.0,
  height: 2.2,
  thickness: 0.06,
  openSpeed: 180,
  interactRange: 2.2,
  peekAngle: 35,
  kickAngle: 100,
  noise: { slowRadius: 6, fastRadius: 12, breachRadius: 20 },
};

describe('F12 — Tactical Radio Chatter & Stack/C2/Gas Audio', () => {
  it('pickEnglishVoice prefers a male English voice over the default female en-US voice', () => {
    const chrome = [
      { name: 'Google US English', lang: 'en-US' },
      { name: 'Google UK English Female', lang: 'en-GB' },
      { name: 'Google UK English Male', lang: 'en-GB' },
      { name: 'Google 日本語', lang: 'ja-JP' },
    ];
    expect(pickEnglishVoice(chrome)?.name).toBe('Google UK English Male');

    const windows = [
      { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
      { name: 'Microsoft David - English (United States)', lang: 'en-US' },
      { name: 'Google UK English Male', lang: 'en-GB' },
    ];
    expect(pickEnglishVoice(windows)?.name).toBe('Microsoft David - English (United States)');

    expect(pickEnglishVoice([{ name: 'Google US English', lang: 'en-US' }])?.name).toBe('Google US English');
    expect(pickEnglishVoice([{ name: 'Google 日本語', lang: 'ja-JP' }])).toBeUndefined();
  });

  it('radioVoiceProfile differentiates cells/SWAT IDs within safe Web Speech bounds and preserves legacy allies', () => {
    expect(radioVoiceProfile('ally_miller')).toEqual({ pitch: 0.85, rate: 1.15, baseHz: 128 });
    expect(radioVoiceProfile('ally_cole')).toEqual({ pitch: 1.05, rate: 1.2, baseHz: 162 });

    const red = radioVoiceProfile('swat_1');
    const blue = radioVoiceProfile('swat_3');
    const gold = radioVoiceProfile('swat_5');
    const green = radioVoiceProfile('swat_7');

    const pitches = new Set([red.pitch, blue.pitch, gold.pitch, green.pitch]);
    expect(pitches.size).toBe(4);

    for (const p of [red, blue, gold, green, radioVoiceProfile('Red-1'), radioVoiceProfile('Blue-2')]) {
      expect(p.pitch).toBeGreaterThanOrEqual(0.75);
      expect(p.pitch).toBeLessThanOrEqual(1.3);
      expect(p.rate).toBeGreaterThanOrEqual(0.95);
      expect(p.rate).toBeLessThanOrEqual(1.35);
    }
  });

  it('AudioBridge routes swatFootstep, gasDetonated, and playerCough cleanly, drops invalid inputs, and unsubscribes on dispose', () => {
    const bus = createGameEventBus();
    const sink = createSink();
    const bridge = new AudioBridge(
      bus,
      sink,
      { getEyePosition: (out = new THREE.Vector3()) => out.set(0, 1.6, 0) },
      [],
    );

    bus.emit('swatFootstep', { pos: { x: 1, y: 0, z: 2 }, heavy: true });
    bus.emit('gasDetonated', { pos: { x: 3, y: 0.5, z: -1 }, radius: 4.2 });
    bus.emit('playerCough', { pos: { x: 0, y: 1.2, z: 0 } });

    expect(sink.playSwatFootstep).toHaveBeenCalledWith({ x: 1, y: 0, z: 2 }, true);
    expect(sink.playGasHiss).toHaveBeenCalledWith({ x: 3, y: 0.5, z: -1 }, 4.2);
    expect(sink.playCough).toHaveBeenCalledWith({ x: 0, y: 1.2, z: 0 });

    // Non-finite coords / non-positive radius dropped
    bus.emit('swatFootstep', { pos: { x: Number.NaN, y: 0, z: 0 }, heavy: false });
    bus.emit('gasDetonated', { pos: { x: 1, y: 0, z: 0 }, radius: 0 });
    expect(sink.playSwatFootstep).toHaveBeenCalledTimes(1);
    expect(sink.playGasHiss).toHaveBeenCalledTimes(1);

    // After dispose, no further calls
    bridge.dispose();
    bus.emit('swatFootstep', { pos: { x: 1, y: 0, z: 2 }, heavy: false });
    bus.emit('playerCough', { pos: { x: 0, y: 1.2, z: 0 } });
    expect(sink.playSwatFootstep).toHaveBeenCalledTimes(1);
    expect(sink.playCough).toHaveBeenCalledTimes(1);
  });

  it('SwatTeam.onNoise ignores source === ally and emits swatFootstep while moving', () => {
    const bus = createGameEventBus();
    const footsteps: { pos: { x: number; y: number; z: number }; heavy: boolean }[] = [];
    bus.on('swatFootstep', (e) => footsteps.push(e));

    const playerPos = new THREE.Vector3(30, 0, 30);
    const deps: SwatTeamDeps = {
      spawns: [{ x: 0, y: 0, z: 5 }],
      count: 2,
      player: {
        alive: true,
        isCrouching: false,
        yawRad: 0,
        position: playerPos,
        getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
        takeDamage: () => 100,
      },
      colliders: [{ kind: 'floor', aabb: { min: { x: -40, y: -0.1, z: -40 }, max: { x: 40, y: 0, z: 40 } } }],
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [] } as unknown as DoorSystem,
      bounds: { width: 50, depth: 50 },
      stairs: [],
      rooms: [{ id: 'r1', name: 'リビング', x: 0, z: 0, width: 8, depth: 8, floorY: 0 }],
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    };
    const team = new SwatTeam(deps);
    team.beginAssault();

    const h = team.hunters[0]!;
    h.state = 'sweep';
    h.huntTarget = null;

    // Ally-sourced noise > 3.2m away must NOT trigger hunt
    bus.emit('noise', { pos: { x: 0, y: 1, z: -1 }, radius: 20, kind: 'footstep', source: 'ally' });
    expect(h.state).toBe('sweep');
    expect(h.huntTarget).toBeNull();

    // Advance simulation so hunters walk and emit swatFootstep
    for (let i = 0; i < 40; i++) team.update(0.05);
    expect(footsteps.length).toBeGreaterThan(0);

    team.dispose();
  });

  it('staggers rapid multi-cell tactical radio exchanges by >= 1.2s and formats portal directions', () => {
    expect(RADIO_STAGGER_SEC).toBeGreaterThanOrEqual(1.2);
    expect(describePortalDirection({ x: 0, y: 0, z: -8 }, { x: 0, y: 0, z: 0 })).toEqual({ ja: '北ドア', en: 'north door' });
    expect(describePortalDirection({ x: 0, y: 0, z: 8 }, { x: 0, y: 0, z: 0 })).toEqual({ ja: '南ドア', en: 'south door' });
    expect(describePortalDirection({ x: 8, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toEqual({ ja: '東ドア', en: 'east door' });
    expect(describePortalDirection({ x: -8, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toEqual({ ja: '西ドア', en: 'west door' });

    const bus = createGameEventBus();
    let simTime = 0;
    const radioLog: { t: number; text: string }[] = [];
    bus.on('allyRadio', (e) => radioLog.push({ t: simTime, text: e.text }));

    const doorNorth = new Door({ id: 'door_n', x: 0, z: -5, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const doorSouth = new Door({ id: 'door_s', x: 0, z: 5, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, bus);
    const colliders: Collider[] = [
      { kind: 'floor', aabb: { min: { x: -30, y: -0.1, z: -30 }, max: { x: 30, y: 0, z: 30 } } },
    ];
    const rooms: RoomDef[] = [{ id: 'r1', name: 'リビング', x: 0, z: 0, width: 10, depth: 10, floorY: 0 }];
    const playerPos = new THREE.Vector3(50, 0, 50);

    const team = new SwatTeam({
      spawns: [{ x: 0, y: 0, z: 10 }],
      count: 4,
      player: {
        alive: true,
        isCrouching: false,
        yawRad: 0,
        position: playerPos,
        getEyePosition: (out = new THREE.Vector3()) => out.set(playerPos.x, playerPos.y + 1.6, playerPos.z),
        takeDamage: () => 100,
      },
      colliders,
      bus,
      weapons: { addTarget: vi.fn(), removeTarget: vi.fn() } as unknown as WeaponSystem,
      doors: { doors: [doorNorth, doorSouth] } as unknown as DoorSystem,
      bounds: { width: 40, depth: 40 },
      stairs: [],
      rooms,
      windows: [],
      flashbang: { gravity: 9.8, throwFrom: vi.fn() } as unknown as Flashbang,
      subtitle: { show: vi.fn() } as unknown as Subtitle,
      civilians: () => [],
    });

    team.beginAssault();
    for (const h of team.hunters) {
      const slot = h.stackSlot!;
      h.body.setPosition(slot.x, slot.z, slot.y);
    }

    for (let i = 0; i < 70; i++) {
      simTime += 0.05;
      team.update(0.05);
    }

    expect(radioLog.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < radioLog.length; i++) {
      expect(radioLog[i]!.t - radioLog[i - 1]!.t).toBeGreaterThanOrEqual(1.2);
    }

    team.dispose();
    doorNorth.dispose();
    doorSouth.dispose();
  });
});
