import { describe, expect, it } from 'vitest';
import {
  BREACH_COUNTDOWN,
  CONTACT,
  ENTRY_COORD_POOLS,
  FLANK,
  cellSetLine,
  pickRadio,
  roomClearLine,
} from '../../src/ai/radioLines';

const COORD_JA = /スタック|配置|カウント|3.*2.*1|ブリーチ|突入|Red|Blue/i;
const COORD_EN = /stack|breach|3.*2.*1|entry|go/i;
const FLANK_JA = /回り込|裏取り|挟撃|ピンサー|別ルート|正面|釘付け/i;
const FLANK_EN = /flank|pincer|pin|behind/i;

describe('SWAT 4 radio variants', () => {
  it('every entry-coordination variant matches the simultaneous-entry radio checks', () => {
    for (const pool of ENTRY_COORD_POOLS) {
      expect(pool.length).toBeGreaterThanOrEqual(2);
      for (const [ja, en] of pool) {
        expect(ja).toMatch(COORD_JA);
        expect(en).toMatch(COORD_EN);
        expect(ja.includes('クリア')).toBe(false);
      }
    }
  });

  it('keeps one countdown so every team hears the same count', () => {
    expect(BREACH_COUNTDOWN[0]).toContain('3、2、1、ブリーチ');
    expect(BREACH_COUNTDOWN[1]).toMatch(COORD_EN);
    expect(BREACH_COUNTDOWN[0].includes('クリア')).toBe(false);
  });

  it('every flank variant names the pin and the move around', () => {
    for (const [ja, en] of FLANK) {
      expect(ja).toMatch(FLANK_JA);
      expect(en).toMatch(FLANK_EN);
    }
    const [ja, en] = cellSetLine('Red', '北ドア', 'north door');
    expect(ja).toMatch(COORD_JA);
    expect(en).toMatch(COORD_EN);
    expect(ja.includes('クリア')).toBe(false);
    expect(ja).toContain('Red');
    expect(en).toContain('north door');
  });

  it('keeps the room name in a clear report', () => {
    const [ja, en] = roomClearLine('キッチン', false);
    expect(ja).toContain('キッチン');
    expect(en.length).toBeGreaterThan(0);
    const [exitJa] = roomClearLine('キッチン', true);
    expect(exitJa).toContain('キッチン');
    expect(exitJa).toMatch(/別のドア|未確認の出口|別扉/);
  });

  it('does not repeat the previous line from the same pool', () => {
    let prev = '';
    for (let i = 0; i < 24; i++) {
      const [ja] = pickRadio(CONTACT);
      expect(ja).not.toBe(prev);
      prev = ja;
    }
  });
});
