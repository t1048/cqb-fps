import { describe, expect, it } from 'vitest';
import { SuspectState } from '../../src/core/events';
import type { RoomDef } from '../../src/core/types';
import {
  GAS_INTEL_MAX_AGE_SEC,
  GAS_STALEMATE_SEC,
  gasBlockReason,
  type GasDecisionInput,
} from '../../src/ai/squad/squadGas';
import { FLASH_TEAM_COOLDOWN } from '../../src/ai/squad/squadTypes';

const rooms: RoomDef[] = [
  { id: 'bed', name: 'Bedroom', x: 0, z: 0, width: 4, depth: 4 },
  { id: 'yard', name: 'Yard', x: 10, z: 0, width: 6, depth: 6, outdoor: true },
];

function base(over: Partial<GasDecisionInput> = {}): GasDecisionInput {
  return {
    simTime: 100,
    lastTeamContactT: 100 - GAS_STALEMATE_SEC - 0.1,
    intel: { suspectId: 's1', pos: { x: 0.5, y: 0, z: 0.5 }, t: 95 },
    suspectState: SuspectState.BARRICADED,
    throwerPos: { x: -6, y: 0, z: 0 },
    rooms,
    gasDensityAtTarget: 0,
    flashCd: 0,
    ...over,
  };
}

describe('autonomous CS gas decision', () => {
  it('allows gas into a room once the team contact has gone quiet', () => {
    expect(gasBlockReason(base())).toBeNull();
  });

  it('does not throw while the team is still in a firefight / suppressing', () => {
    expect(gasBlockReason(base({ lastTeamContactT: 99 }))).toBe('teamContact');
    // 制圧射撃の時間帯（視認喪失 2.2s）はまだ膠着ではない
    expect(gasBlockReason(base({ lastTeamContactT: 100 - 2.2 }))).toBe('teamContact');
  });

  it('ignores stale intel', () => {
    expect(gasBlockReason(base({ intel: { suspectId: 's1', pos: { x: 0, y: 0, z: 0 }, t: 100 - GAS_INTEL_MAX_AGE_SEC - 1 } }))).toBe('staleIntel');
  });

  it('requires a dug-in suspect (not surrendered / dead / hostage shield)', () => {
    expect(gasBlockReason(base({ suspectState: SuspectState.SURRENDER }))).toBe('notDugIn');
    expect(gasBlockReason(base({ suspectState: SuspectState.HOSTAGE_SHIELD }))).toBe('notDugIn');
    expect(gasBlockReason(base({ suspectState: null }))).toBe('notDugIn');
  });

  it('only gasses indoor rooms, never open / outdoor spots', () => {
    expect(gasBlockReason(base({ intel: { suspectId: 's1', pos: { x: 5, y: 0, z: 5 }, t: 95 } }))).toBe('notInRoom');
    expect(gasBlockReason(base({ intel: { suspectId: 's1', pos: { x: 10, y: 0, z: 0 }, t: 95 } }))).toBe('notInRoom');
  });

  it('does not gas the room the thrower is standing in', () => {
    expect(gasBlockReason(base({ throwerPos: { x: -1, y: 0, z: 0 } }))).toBe('sameRoom');
  });

  it('skips when gas already fills the spot or a flash just went in', () => {
    expect(gasBlockReason(base({ gasDensityAtTarget: 0.5 }))).toBe('gasPresent');
    expect(gasBlockReason(base({ flashCd: FLASH_TEAM_COOLDOWN - 1 }))).toBe('recentFlash');
  });
});
