import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSettingsCacheForTest,
  getSettings,
  resetSettings,
  subscribeSettings,
  updateSettings,
} from '../../src/core/Settings';
import { getLocale, setLocale, t, tMotifLabel, tOrderLabel, tRoeLabel, tRoomName, tStageName, tWeaponName } from '../../src/core/i18n';
import { buildSeedShareUrl, KOFI_URL } from '../../src/ui/shareLinks';

function installMockStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
  (globalThis as unknown as { window?: unknown }).window = {
    localStorage: mockLocalStorage,
    location: { origin: 'https://t1048.github.io', pathname: '/cqb-fps/' },
  };
  return store;
}

describe('GameSettings (localStorage persistence)', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installMockStorage();
    _resetSettingsCacheForTest();
  });

  afterEach(() => {
    _resetSettingsCacheForTest();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('loads defaults and persists updates to localStorage', () => {
    const initial = getSettings();
    expect(initial.mouseSensitivity).toBe(1.0);
    expect(initial.masterVolume).toBe(1.0);
    expect(initial.muted).toBe(false);
    expect(initial.aoEnabled).toBe(true);
    expect(initial.shadowsEnabled).toBe(true);

    updateSettings({
      mouseSensitivity: 1.75,
      invertY: true,
      masterVolume: 0.45,
      muted: true,
      aoEnabled: false,
      shadowsEnabled: false,
      language: 'en',
    });

    // Reload from storage cache-free
    _resetSettingsCacheForTest();
    const reloaded = getSettings();
    expect(reloaded).toEqual({
      mouseSensitivity: 1.75,
      invertY: true,
      masterVolume: 0.45,
      muted: true,
      aoEnabled: false,
      shadowsEnabled: false,
      language: 'en',
    });
    expect(store.size).toBe(1);
  });

  it('clamps out-of-range values and tolerates corrupted JSON', () => {
    updateSettings({ mouseSensitivity: 99, masterVolume: -5 });
    expect(getSettings().mouseSensitivity).toBe(3.0);
    expect(getSettings().masterVolume).toBe(0);

    store.set('cqb.settings.v1', '{broken json');
    _resetSettingsCacheForTest();
    expect(getSettings().mouseSensitivity).toBe(1.0);
  });

  it('notifies subscribers and preserves language on reset', () => {
    let calls = 0;
    const unsub = subscribeSettings(() => {
      calls++;
    });
    updateSettings({ language: 'en', mouseSensitivity: 2.2, aoEnabled: false });
    expect(calls).toBe(1);

    resetSettings();
    expect(calls).toBe(2);
    expect(getSettings().mouseSensitivity).toBe(1.0);
    expect(getSettings().aoEnabled).toBe(true);
    expect(getSettings().language).toBe('en');
    unsub();
  });
});

describe('i18n & shareLinks', () => {
  beforeEach(() => {
    installMockStorage();
    _resetSettingsCacheForTest();
  });

  afterEach(() => {
    _resetSettingsCacheForTest();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('switches between Japanese and English dictionaries', () => {
    setLocale('ja');
    expect(getLocale()).toBe('ja');
    expect(t('設定', 'Settings')).toBe('設定');
    expect(tWeaponName('carbine', 'カービン')).toBe('カービン');
    expect(tRoomName('玄関ホール')).toBe('玄関ホール');

    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('設定', 'Settings')).toBe('Settings');
    expect(tWeaponName('carbine', 'カービン')).toBe('Carbine');
    expect(tWeaponName('auto_pistol', '改造フルオート拳銃（改）')).toBe('Modded Auto Pistol (Mod)');
    expect(tStageName('random_house', '標準')).toBe('Standard');
    expect(tMotifLabel('hospital', '病院')).toBe('Clinic / Hospital');
    expect(tOrderLabel('flash_clear', 'フラッシュ＆クリア')).toBe('Flash & Clear');
    expect(tRoeLabel('arrest', '逮捕')).toBe('Suspect Arrested');
    expect(tRoomName('玄関ホール')).toBe('Entry Hall');
    expect(tRoomName('渡り廊下')).toBe('Skybridge Hallway');
    expect(tRoomName('2F寝室 2')).toBe('2F Bedroom 2');
  });

  it('builds shareable seed URLs and exports the Ko-fi URL', () => {
    expect(KOFI_URL).toBe('https://ko-fi.com/t1048');
    expect(
      buildSeedShareUrl({ stage: 'random_house', seed: 12345, mode: 'swat' }),
    ).toBe('https://t1048.github.io/cqb-fps/?stage=random_house&seed=12345');
    expect(
      buildSeedShareUrl({ stage: 'random_embassy', seed: 999, mode: 'suspect' }),
    ).toBe('https://t1048.github.io/cqb-fps/?stage=random_embassy&seed=999&mode=suspect');
  });
});
