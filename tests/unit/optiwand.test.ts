import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePlayerConfig } from '../../src/core/DataLoader';
import type { OptiwandConfig } from '../../src/core/types';
import {
  WandSpotter,
  computeDoorPose,
  computeFreePose,
  contactCallout,
  doorEligible,
  pointInWandView,
  rollNotices,
  type WandContactSource,
  type WandDoor,
} from '../../src/player/optiwandGeometry';
import { scanMirrorContacts } from '../../src/ai/squad/squadScout';
import { ScoutIntel } from '../../src/ai/ScoutIntel';
import type { Collider } from '../../src/world/WorldBuilder';

const playerJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/player.json'), 'utf-8'));
const cfg: OptiwandConfig = validatePlayerConfig(playerJson).optiwand;
const DEG = Math.PI / 180;

function wall(minX: number, minZ: number, maxX: number, maxZ: number): Collider {
  return { kind: 'wall', aabb: { min: { x: minX, y: 0, z: minZ }, max: { x: maxX, y: 3, z: maxZ } } };
}

/** 法線 +Z（手前=+Z 側、向こう側=-Z 側）の幅 0.9m のドア。 */
function makeDoor(over: Partial<WandDoor> = {}): WandDoor {
  return {
    id: 'door_a',
    centerX: 0,
    centerZ: -2,
    normalX: 0,
    normalZ: 1,
    axisX: 1,
    axisZ: 0,
    width: 0.9,
    sillY: 0,
    angle: 0,
    peekAngle: 20,
    ...over,
  };
}

describe('optiwand data', () => {
  it('player.json の optiwand を検証して読み込める', () => {
    expect(cfg.deploySec).toBeCloseTo(0.4);
    expect(cfg.reach).toBeCloseTo(0.6);
    expect(cfg.yawLimitDeg).toBe(80);
    expect(cfg.doorCamHeight[0]).toBeGreaterThanOrEqual(0.05);
    expect(cfg.doorCamHeight[1]).toBeLessThanOrEqual(0.15);
    expect(cfg.renderSize).toEqual([320, 240]);
  });

  it('不正な optiwand 設定を拒否する', () => {
    expect(() => validatePlayerConfig({ ...playerJson, optiwand: { ...playerJson.optiwand, doorCamHeight: [0.3, 0.1] } })).toThrow();
    expect(() => validatePlayerConfig({ ...playerJson, optiwand: { ...playerJson.optiwand, fovDeg: 5 } })).toThrow();
  });
});

describe('optiwand: ドア下カメラの配置', () => {
  it('向こう側のドア面から数 cm 先・床上 0.05〜0.15m に置き、向こう側を向く', () => {
    const door = makeDoor();
    const pose = computeDoorPose(door, { x: 0.1, z: -1.0 }, cfg, 0.04, 0, 0);
    expect(pose.mode).toBe('door');
    // プレイヤーは +Z 側 → 向こう側は -Z
    expect(pose.z).toBeLessThan(door.centerZ);
    expect(door.centerZ - pose.z).toBeGreaterThan(0.04 / 2);
    expect(door.centerZ - pose.z).toBeLessThan(0.2);
    expect(pose.y).toBeGreaterThanOrEqual(0.05);
    expect(pose.y).toBeLessThanOrEqual(0.15);
    expect(pose.x).toBeCloseTo(0.1, 5);
    // yaw 0 は -Z 向き
    expect(Math.cos(pose.yaw)).toBeGreaterThan(0.99);
    expect(pose.farZ).toBe(-1);
  });

  it('プレイヤーが反対側にいればカメラも反対側（+Z）へ回る', () => {
    const door = makeDoor();
    const pose = computeDoorPose(door, { x: 0, z: -3.2 }, cfg, 0.04, 0, 0);
    expect(pose.z).toBeGreaterThan(door.centerZ);
    expect(Math.abs(pose.yaw)).toBeCloseTo(Math.PI, 5);
  });

  it('首振りは ±80°、ピッチも設定範囲にクランプされる', () => {
    const door = makeDoor();
    const left = computeDoorPose(door, { x: 0, z: -1 }, cfg, 0.04, 170 * DEG, 0);
    expect(left.yaw).toBeCloseTo(80 * DEG, 5);
    const right = computeDoorPose(door, { x: 0, z: -1 }, cfg, 0.04, -170 * DEG, 0);
    expect(right.yaw).toBeCloseTo(-80 * DEG, 5);
    expect(computeDoorPose(door, { x: 0, z: -1 }, cfg, 0.04, 0, 80 * DEG).pitch).toBeCloseTo(cfg.pitchLimitDeg[1] * DEG, 5);
    expect(computeDoorPose(door, { x: 0, z: -1 }, cfg, 0.04, 0, -80 * DEG).pitch).toBeCloseTo(cfg.pitchLimitDeg[0] * DEG, 5);
  });

  it('横位置はドア幅の端から離す', () => {
    const door = makeDoor();
    const pose = computeDoorPose(door, { x: 5, z: -1 }, cfg, 0.04, 0, 0);
    expect(Math.abs(pose.x - door.centerX)).toBeLessThanOrEqual(door.width / 2 - 0.15 + 1e-9);
  });

  it('少し開いている（ピーク）ときは開き角に応じて奥へ送る', () => {
    const closed = computeDoorPose(makeDoor({ angle: 0 }), { x: 0, z: -1 }, cfg, 0.04, 0, 0);
    const ajar = computeDoorPose(makeDoor({ angle: 20 }), { x: 0, z: -1 }, cfg, 0.04, 0, 0);
    expect(ajar.z).toBeLessThan(closed.z);
  });

  it('距離内で、ほぼ閉じているドアだけが対象', () => {
    const door = makeDoor();
    expect(doorEligible(door, { x: 0, z: -0.8 }, cfg)).toBe(true);
    expect(doorEligible(door, { x: 0, z: 3 }, cfg)).toBe(false);
    expect(doorEligible(makeDoor({ angle: 60 }), { x: 0, z: -0.8 }, cfg)).toBe(false);
    expect(doorEligible(makeDoor({ angle: 18 }), { x: 0, z: -0.8 }, cfg)).toBe(true);
  });
});

describe('optiwand: 通常時の先端位置', () => {
  it('目線から前方 reach(0.6m) の位置に出す（リーン込みの目線を基準）', () => {
    const eye = { x: 1, y: 1.6, z: 1 };
    const pose = computeFreePose(eye, 0, 0, [], cfg);
    expect(pose.mode).toBe('free');
    expect(pose.z).toBeCloseTo(1 - cfg.reach, 5);
    expect(pose.x).toBeCloseTo(1, 5);
    // 右リーンした目線（x が右へずれる）をそのまま使うので、角越しに先端が出る
    const leaned = computeFreePose({ x: 1.5, y: 1.6, z: 1 }, 0, 0, [], cfg);
    expect(leaned.x).toBeCloseTo(1.5, 5);
  });

  it('壁を貫通しない（手前 wallClearance で止まる）', () => {
    const eye = { x: 0, y: 1.6, z: 0 };
    const wallAhead = wall(-2, -0.5, 2, -0.3);
    const pose = computeFreePose(eye, 0, 0, [wallAhead], cfg);
    expect(pose.z).toBeGreaterThan(-0.3); // 壁面の手前
    expect(pose.z).toBeCloseTo(-(0.3 - cfg.wallClearance), 3);
  });

  it('壁に密着していても目線位置より後ろへは下がらない（最小突出）', () => {
    const pose = computeFreePose({ x: 0, y: 1.6, z: 0 }, 0, 0, [wall(-2, -0.05, 2, 0.1)], cfg);
    expect(pose.z).toBeLessThanOrEqual(0);
    expect(pose.z).toBeGreaterThan(-0.1);
  });

  it('首振りしても回転軸はワンド先端に留まり、ロッドごと横の壁へ振り回さない', () => {
    const eye = { x: 0, y: 1.6, z: 0 };
    const base = computeFreePose(eye, 0, 0, [], cfg, 0, 0);
    const pannedLeft = computeFreePose(eye, 0, 0, [], cfg, 70 * DEG, 15 * DEG);
    const pannedRight = computeFreePose(eye, 0, 0, [], cfg, -70 * DEG, -10 * DEG);
    // 先端位置はロッド方向 (yaw=0) の先に固定され、カメラ向きだけが先端を軸に回転する
    expect(pannedLeft.x).toBeCloseTo(base.x, 5);
    expect(pannedLeft.y).toBeCloseTo(base.y, 5);
    expect(pannedLeft.z).toBeCloseTo(base.z, 5);
    expect(pannedRight.x).toBeCloseTo(base.x, 5);
    expect(pannedRight.y).toBeCloseTo(base.y, 5);
    expect(pannedRight.z).toBeCloseTo(base.z, 5);
    expect(pannedLeft.yaw).toBeCloseTo(70 * DEG, 5);
    expect(pannedLeft.pitch).toBeCloseTo(15 * DEG, 5);
    expect(pannedRight.yaw).toBeCloseTo(-70 * DEG, 5);
  });

  it('横の壁すれすれに伸ばしても wallClearance 分の離隔を保つ', () => {
    const eye = { x: 0, y: 1.6, z: 0 };
    // 右側 x = 0.02 に沿う壁（目線は壁の外）
    const sideWall = wall(0.02, -2, 0.2, 2);
    const pose = computeFreePose(eye, 0, 0, [sideWall], cfg, -60 * DEG, 0);
    expect(pose.x).toBeLessThanOrEqual(0.02 - cfg.wallClearance + 1e-5);
  });
});

describe('optiwand: スポット', () => {
  const pose = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 };
  const suspect = (id: string, x: number, z: number): WandContactSource => ({
    id,
    kind: 'suspect',
    armed: true,
    chest: { x, y: 1.2, z },
    eye: { x, y: 1.55, z },
  });

  it('視錐台内の判定（前方/後方/左右）', () => {
    expect(pointInWandView(pose, 78, 4 / 3, { x: 0, y: 1.2, z: -4 }).inView).toBe(true);
    expect(pointInWandView(pose, 78, 4 / 3, { x: 0, y: 1.2, z: 4 }).inView).toBe(false);
    expect(pointInWandView(pose, 78, 4 / 3, { x: 10, y: 1.2, z: -2 }).inView).toBe(false);
    // 右へ向けると右の点が入る
    expect(pointInWandView({ ...pose, yaw: -90 * DEG }, 78, 4 / 3, { x: 4, y: 1.6, z: 0 }).inView).toBe(true);
  });

  it('0.3 秒以上見え続けて初めて「発見」になる', () => {
    const sp = new WandSpotter();
    const src = [suspect('s1', 0, -4)];
    expect(sp.update(0.1, pose, cfg, 4 / 3, src, []).fresh).toHaveLength(0);
    expect(sp.update(0.1, pose, cfg, 4 / 3, src, []).fresh).toHaveLength(0);
    const r = sp.update(0.15, pose, cfg, 4 / 3, src, []);
    expect(r.fresh.map((c) => c.id)).toEqual(['s1']);
    // 同じ対象は再度 fresh にならないが visible には残る
    const again = sp.update(0.1, pose, cfg, 4 / 3, src, []);
    expect(again.fresh).toHaveLength(0);
    expect(again.visible).toHaveLength(1);
    expect(sp.hasSpotted('s1')).toBe(true);
  });

  it('壁で視線が遮られる対象・視野外の対象は発見されない', () => {
    const sp = new WandSpotter();
    const blocked = [suspect('s_wall', 0, -4)];
    const walls = [wall(-1, -2.1, 1, -1.9)];
    for (let i = 0; i < 10; i++) {
      expect(sp.update(0.1, pose, cfg, 4 / 3, blocked, walls).fresh).toHaveLength(0);
    }
    const behind = [suspect('s_back', 0, 4)];
    for (let i = 0; i < 10; i++) expect(sp.update(0.1, pose, cfg, 4 / 3, behind, []).fresh).toHaveLength(0);
    const far = [suspect('s_far', 0, -(cfg.viewRange + 5))];
    for (let i = 0; i < 10; i++) expect(sp.update(0.1, pose, cfg, 4 / 3, far, []).fresh).toHaveLength(0);
  });

  it('一瞬の見切れでは蓄積が即リセットされない（減衰）', () => {
    const sp = new WandSpotter();
    const src = [suspect('s1', 0, -4)];
    sp.update(0.25, pose, cfg, 4 / 3, src, []);
    sp.update(0.05, pose, cfg, 4 / 3, [], []); // 見えない 0.05s（-0.1 減衰 → 0.15 残る）
    const r = sp.update(0.2, pose, cfg, 4 / 3, src, []);
    expect(r.fresh).toHaveLength(1);
  });
});

describe('optiwand: 気付かれ判定', () => {
  const tip = { x: 0, y: 1.6, z: 0 };
  // yawRad 0 の容疑者は -Z 向き。先端が -Z 側 2m にあれば正面。
  const facing = { id: 'a', x: 0, y: 0, z: 2, eyeY: 1.5, yawRad: 0 };

  it('正面を向く近い容疑者は確率で気付く / 背を向けていれば気付かない', () => {
    expect(rollNotices(1, tip, [facing], cfg, false, [], () => 0)).toEqual(['a']);
    expect(rollNotices(1, tip, [{ ...facing, yawRad: Math.PI }], cfg, false, [], () => 0)).toEqual([]);
  });

  it('距離外・壁越しは気付かない', () => {
    expect(rollNotices(1, tip, [{ ...facing, z: cfg.noticeRange + 2 }], cfg, false, [], () => 0)).toEqual([]);
    expect(rollNotices(1, tip, [facing], cfg, false, [wall(-1, 0.9, 1, 1.1)], () => 0)).toEqual([]);
  });

  it('ドア下では気付かれにくい（確率が noticeUnderDoorMul 倍）', () => {
    const r = cfg.noticePerSec * (cfg.noticeUnderDoorMul + 1) * 0.5; // 通常 p と ドア下 p の間
    expect(rollNotices(1, tip, [facing], cfg, false, [], () => r)).toEqual(['a']);
    expect(rollNotices(1, tip, [facing], cfg, true, [], () => r)).toEqual([]);
  });
});

describe('optiwand: 呼び出し文言と偵察情報', () => {
  it('接触数に応じた呼び出し文', () => {
    expect(contactCallout(1, 0, 1)).toEqual(['接触2名: 武装容疑者1、民間人1', '2 contacts: 1 armed suspect, 1 civilian']);
    expect(contactCallout(0, 0, 0)[0]).toBe('接触なし');
    expect(contactCallout(2, 1, 0, { ja: 'ミラー確認: ', en: 'Mirror: ' })[0]).toContain('ミラー確認: 接触3名');
  });

  it('ScoutIntel: 接触報告で部屋が確認済みになり、武装容疑者だけが脅威として返る', () => {
    const intel = new ScoutIntel();
    expect(intel.isScouted('r1')).toBe(false);
    intel.reportContact('r1', { id: 's1', kind: 'suspect', armed: true, x: 1, y: 0, z: 2, time: 0 });
    intel.reportContact('r1', { id: 'c1', kind: 'civilian', armed: false, x: 2, y: 0, z: 2, time: 0 });
    expect(intel.isScouted('r1')).toBe(true);
    expect(intel.threatsIn('r1').map((c) => c.id)).toEqual(['s1']);
    expect(intel.contactsIn('r1')).toHaveLength(2);
    intel.prune((c) => c.id !== 's1');
    expect(intel.threatsIn('r1')).toHaveLength(0);
    intel.markScouted('r2');
    expect(intel.isScouted('r2')).toBe(true);
    expect(intel.threatsIn('r2')).toEqual([]);
  });
});

describe('ミラー確認（隊員）', () => {
  const mirrorCfg = { durationSec: 4, missChance: 0.35, centerBandM: 1.1, halfFovDeg: 55, range: 12 };
  const base = {
    doorCenter: { x: 0, z: -2 },
    far: { x: 0, z: -1 },
    sillY: 0,
    cfg: mirrorCfg,
    colliders: [] as Collider[],
  };
  const cand = (id: string, x: number, z: number) => ({ id, kind: 'suspect' as const, armed: true, chest: { x, y: 1.2, z } });

  it('視線中心線の近くの接触は必ず拾う', () => {
    const r = scanMirrorContacts({ ...base, candidates: [cand('mid', 0.4, -6)], rand: () => 0 });
    expect(r.seen.map((c) => c.id)).toEqual(['mid']);
    expect(r.missed).toHaveLength(0);
  });

  it('中心線から離れた接触は missChance で見落とす（乱数次第）', () => {
    const off = cand('off', 3.0, -6);
    const missed = scanMirrorContacts({ ...base, candidates: [off], rand: () => 0.1 });
    expect(missed.missed.map((c) => c.id)).toEqual(['off']);
    const seen = scanMirrorContacts({ ...base, candidates: [off], rand: () => 0.9 });
    expect(seen.seen.map((c) => c.id)).toEqual(['off']);
  });

  it('視野外（後方・横すぎる）・射程外・壁越しは対象外', () => {
    const r = scanMirrorContacts({
      ...base,
      candidates: [cand('behind', 0, 2), cand('side', 6, -2.5), cand('far', 0, -30)],
      rand: () => 0.9,
    });
    expect(r.seen).toHaveLength(0);
    expect(r.missed).toHaveLength(0);
    const blocked = scanMirrorContacts({
      ...base,
      colliders: [wall(-3, -4.1, 3, -3.9)],
      candidates: [cand('hidden', 0, -6)],
      rand: () => 0.9,
    });
    expect(blocked.seen).toHaveLength(0);
  });
});

describe('fisheyeInverse（映像内マーカーの位置合わせ）', () => {
  it('シェーダの歪み q = p(1+0.24|p|²) を逆算する', async () => {
    const { fisheyeInverse } = await import('../../src/player/Optiwand');
    for (const [x, y] of [[0, 0], [0.4, -0.2], [-0.7, 0.5]] as const) {
      const p = fisheyeInverse(x, y);
      const k = 1 + 0.24 * (p.x * p.x + p.y * p.y);
      expect(p.x * k).toBeCloseTo(x, 4);
      expect(p.y * k).toBeCloseTo(y, 4);
    }
  });
});
