import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { onHit, isAllyHeadHit } from '../../src/ai/squad/squadCombat';
import type { AllyUnit, SquadContext } from '../../src/ai/squad/squadTypes';
import {
  DEFAULT_AMBUSH,
  validateAIProfiles,
  validatePlayerConfig,
  validateRoe,
  validateSquad,
} from '../../src/core/DataLoader';
import { createGameEventBus } from '../../src/core/events';
import type { InputManager } from '../../src/core/InputManager';
import type { MapData } from '../../src/core/types';
import { PlayerController } from '../../src/player/PlayerController';
import { RoE } from '../../src/rules/RoE';
import { ScoreBoard } from '../../src/rules/ScoreBoard';
import { applyHeadMultiplier, isHeadHit, woundLevelOf } from '../../src/rules/wounds';

const dataDir = path.resolve(__dirname, '../../public/data');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf-8'));
const playerCfg = validatePlayerConfig(read('player.json'));
const roeCfg = validateRoe(read('roe.json'));
const squadCfg = validateSquad(read('squad.json'));

function makePlayer(woundsEnabled = true) {
  const bus = createGameEventBus();
  const events: { level: number }[] = [];
  bus.on('playerWound', (e) => events.push(e));
  const input = {
    consumeMouseDelta: () => ({ x: 0, y: 0 }),
    isDown: () => false,
    wasPressed: () => false,
  } as unknown as InputManager;
  const map = { playerSpawn: { x: 0, y: 0, z: 0, yaw: 0 } } as unknown as MapData;
  const p = new PlayerController(new THREE.PerspectiveCamera(), input, [], playerCfg, bus, map);
  p.woundsEnabled = woundsEnabled;
  return { p, bus, events };
}

describe('wounds ヘルパ', () => {
  it('頭部命中は目線から headBand 以内の高さ', () => {
    expect(isHeadHit(1.55, 1.6, 0.28)).toBe(true);
    expect(isHeadHit(1.2, 1.6, 0.28)).toBe(false);
    expect(isHeadHit(undefined, 1.6, 0.28)).toBe(false);
    expect(applyHeadMultiplier(14, true, 3.6)).toBeCloseTo(50.4);
    expect(applyHeadMultiplier(14, false, 2.5)).toBe(14);
  });

  it('負傷レベル: 50% 未満で Lv1、25% 未満で Lv2', () => {
    const w = playerCfg.wounds;
    expect(woundLevelOf(100, 100, w)).toBe(0);
    expect(woundLevelOf(50, 100, w)).toBe(0);
    expect(woundLevelOf(49, 100, w)).toBe(1);
    expect(woundLevelOf(24, 100, w)).toBe(2);
    expect(woundLevelOf(0, 100, w)).toBe(0);
  });
});

describe('プレイヤー: 頭部被弾倍率と負傷', () => {
  it('頭部命中は wounds.headMultiplier（×3.6）、胴体は等倍', () => {
    const { p } = makePlayer();
    const eyeY = p.getEyePosition().y;
    expect(p.takeDamage(14, eyeY - 0.05)).toBeCloseTo(100 - 50.4);
    expect(p.lastHitHead).toBe(true);
    const { p: p2 } = makePlayer();
    expect(p2.takeDamage(14, 0.9)).toBeCloseTo(86);
    expect(p2.lastHitHead).toBe(false);
  });

  it('最弱の容疑者弾(14)でも頭部 2 発でダウンする', () => {
    const { p } = makePlayer();
    const y = p.getEyePosition().y;
    p.takeDamage(14, y);
    expect(p.alive).toBe(true);
    p.takeDamage(14, y);
    expect(p.hp).toBeLessThanOrEqual(0);
    expect(p.alive).toBe(false);
  });

  it('頭部は防弾チョッキで軽減されない', () => {
    const { p } = makePlayer();
    p.armor = 50;
    p.takeDamage(10, p.getEyePosition().y);
    expect(p.armor).toBe(50);
    expect(p.hp).toBeCloseTo(100 - 10 * 3.6);
    p.takeDamage(10, 0.8);
    expect(p.armor).toBeLessThan(50);
  });

  it('負傷レベルが上がるたび playerWound を発行し、速度低下・照準拡散が増える', () => {
    const { p, events } = makePlayer();
    expect(p.woundSpeedMul).toBe(1);
    p.takeDamage(55, 0.9);
    expect(p.woundLevel).toBe(1);
    expect(p.woundSpeedMul).toBeCloseTo(0.75);
    expect(p.woundSpreadAdd).toBeGreaterThan(0);
    p.takeDamage(25, 0.9);
    expect(p.woundLevel).toBe(2);
    expect(p.woundSpeedMul).toBeLessThan(0.75);
    expect(p.woundSpreadAdd).toBeGreaterThan(playerCfg.wounds.spreadAddDeg[0]);
    expect(events.map((e) => e.level)).toEqual([1, 2]);
  });

  it('woundsEnabled=false（容疑者モード）では倍率も負傷効果も無い', () => {
    const { p, events } = makePlayer(false);
    p.takeDamage(14, p.getEyePosition().y);
    expect(p.hp).toBeCloseTo(86);
    p.takeDamage(60, 0.9);
    expect(p.woundLevel).toBe(0);
    expect(p.woundSpeedMul).toBe(1);
    expect(events).toHaveLength(0);
  });
});

describe('隊員: 頭部被弾と負傷', () => {
  function makeAlly(): AllyUnit {
    return {
      id: 'ally_1',
      name: 'Miller',
      hp: 100,
      maxHp: 100,
      wounded: false,
      down: false,
      shielded: false,
      engageActive: false,
      flinchLeft: 0,
      blindLeft: 0,
      rushTimer: 0,
      combat: { moveSpeed: 2.4, flinchSec: 0.2 },
      body: {
        footY: 0,
        height: 1.8,
        setFlash: vi.fn(),
        setShake: vi.fn(),
        setPose: vi.fn(),
        removeGun: vi.fn(),
      },
      optics: { hide: vi.fn() },
      engage: { exit: vi.fn(), onHit: vi.fn() },
    } as unknown as AllyUnit;
  }

  function makeCtx(ally: AllyUnit) {
    const bus = createGameEventBus();
    const downs: string[] = [];
    bus.on('allyDown', (e) => downs.push(e.allyId));
    const ctx = { allies: [ally], cfg: squadCfg, bus, emitRadio: vi.fn() } as unknown as SquadContext;
    return { ctx, downs };
  }

  it('身長の 82% 以上への命中は頭部', () => {
    const a = makeAlly();
    expect(isAllyHeadHit(a, 1.6)).toBe(true);
    expect(isAllyHeadHit(a, 1.2)).toBe(false);
    expect(isAllyHeadHit(a, undefined)).toBe(false);
  });

  it('頭部被弾は倍率ダメージ、胴体は等倍', () => {
    const head = makeAlly();
    onHit(makeCtx(head).ctx, head.id, 14, false, 1.65, 'suspect_1');
    expect(head.hp).toBeCloseTo(100 - 14 * squadCfg.wounds.headMultiplier);
    const body = makeAlly();
    onHit(makeCtx(body).ctx, body.id, 14, false, 1.0, 'suspect_1');
    expect(body.hp).toBeCloseTo(86);
  });

  it('HP が閾値を割ると負傷として移動速度が落ちる（一度だけ）', () => {
    const a = makeAlly();
    const { ctx } = makeCtx(a);
    onHit(ctx, a.id, 60, false, 1.0, 'suspect_1');
    expect(a.wounded).toBe(true);
    expect(a.combat.moveSpeed).toBeCloseTo(2.4 * squadCfg.wounds.speedMul);
    onHit(ctx, a.id, 5, false, 1.0, 'suspect_1');
    expect(a.combat.moveSpeed).toBeCloseTo(2.4 * squadCfg.wounds.speedMul);
  });

  it('戦闘不能になると allyDown を発行し、その後は撃たれてもダウンのまま', () => {
    const a = makeAlly();
    const { ctx, downs } = makeCtx(a);
    onHit(ctx, a.id, 200, false, 1.0, 'suspect_1');
    expect(a.down).toBe(true);
    expect(downs).toEqual(['ally_1']);
    onHit(ctx, a.id, 10, false, 1.0, 'suspect_1');
    expect(downs).toHaveLength(1);
  });
});

describe('RoE / スコア: 不用意な突入のペナルティ', () => {
  it('roe.json に allyDown / playerInjury の減点がある', () => {
    expect(roeCfg.points.allyDown).toBeLessThan(0);
    expect(roeCfg.points.playerInjury).toBeLessThan(0);
  });

  it('隊員のダウン・プレイヤー負傷レベル上昇がそれぞれ減点され、ランクに響く', () => {
    const bus = createGameEventBus();
    const roe = new RoE(roeCfg, bus);
    const entries: string[] = [];
    roe.onEntry = (e) => entries.push(e.kind);
    bus.emit('allyDown', { allyId: 'ally_1' });
    bus.emit('allyDown', { allyId: 'ally_1' }); // 同一対象は 1 回だけ
    bus.emit('allyDown', { allyId: 'ally_2' });
    bus.emit('playerWound', { level: 1 });
    bus.emit('playerWound', { level: 2 });
    expect(entries.filter((k) => k === 'allyDown')).toHaveLength(2);
    expect(entries.filter((k) => k === 'playerInjury')).toHaveLength(2);
    const expected = 2 * roeCfg.points.allyDown + 2 * roeCfg.points.playerInjury;
    expect(roe.board.total).toBe(expected);
    roe.dispose();

    const clean = new ScoreBoard(roeCfg, 300);
    clean.add('arrest', 's1', 0);
    clean.add('arrest', 's2', 1);
    clean.add('arrest', 's3', 2);
    clean.add('evidence', 's1', 3);
    const rankClean = clean.rank;
    const careless = new ScoreBoard(roeCfg, 300);
    careless.add('arrest', 's1', 0);
    careless.add('arrest', 's2', 1);
    careless.add('arrest', 's3', 2);
    careless.add('evidence', 's1', 3);
    for (let i = 0; i < 3; i++) careless.add('allyDown', `a${i}`, 5);
    expect(careless.total).toBeLessThan(clean.total);
    const order = ['S', 'A', 'B', 'C', 'D'];
    expect(order.indexOf(careless.rank)).toBeGreaterThanOrEqual(order.indexOf(rankClean));
  });

  it('旧 roe.json（新項目なし）でも既定値で読める', () => {
    const old = read('roe.json');
    delete old.points.allyDown;
    delete old.points.playerInjury;
    delete old.labels.allyDown;
    delete old.labels.playerInjury;
    const cfg = validateRoe(old);
    expect(cfg.points.allyDown).toBeLessThan(0);
    expect(cfg.labels.playerInjury.length).toBeGreaterThan(0);
  });
});

describe('データ検証: ambush / wounds / mirror', () => {
  it('ai_profiles.json の suspect に ambush があり、民間人には無い', () => {
    const profiles = validateAIProfiles(read('ai_profiles.json'));
    for (const p of profiles) {
      if (p.type === 'suspect') {
        expect(p.ambush).toBeDefined();
        expect(p.ambush!.preAimReactionSec).toBeLessThan(p.reactionTime);
        expect(p.ambush!.firstBurstSpreadMul).toBeLessThan(1);
      } else {
        expect(p.ambush).toBeUndefined();
      }
    }
  });

  it('ambush 省略時は既定値、範囲外は拒否', () => {
    const raw = read('ai_profiles.json');
    delete raw.profiles[0].ambush;
    expect(validateAIProfiles(raw)[0]!.ambush).toEqual(DEFAULT_AMBUSH);
    const bad = read('ai_profiles.json');
    bad.profiles[0].ambush.chance = 2;
    expect(() => validateAIProfiles(bad)).toThrow();
    const bad2 = read('ai_profiles.json');
    bad2.profiles[0].ambush.firstBurstSpreadMul = 0;
    expect(() => validateAIProfiles(bad2)).toThrow();
  });

  it('wounds の不整合（lv2 > lv1）は拒否', () => {
    const bad = read('player.json');
    bad.wounds.lv2Below = 0.9;
    expect(() => validatePlayerConfig(bad)).toThrow();
    expect(playerCfg.wounds.headMultiplier).toBeCloseTo(3.6);
  });

  it('squad.json の orderLabels.mirror が必須', () => {
    const bad = read('squad.json');
    delete bad.orderLabels.mirror;
    expect(() => validateSquad(bad)).toThrow();
  });
});
