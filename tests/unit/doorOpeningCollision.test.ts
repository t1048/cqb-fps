import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createGameEventBus } from '../../src/core/events';
import { Door, type DoorConfig } from '../../src/world/Door';
import { hasLineOfSight, hasThrowLineOfSight } from '../../src/weapons/Flashbang';
import { pointInWandView } from '../../src/player/optiwandGeometry';

const DOOR_CFG: DoorConfig = {
  thickness: 0.05,
  height: 2.1,
  peekAngle: 22,
  swingSpeed: 90,
  knobSpeedMultiplier: 2,
  segmentLength: 0.35,
  interactRange: 2.2,
  breach: { speedMultiplier: 6, noiseRadius: 18, effectRadius: 5 },
  noise: { slowRadius: 5, fastRadius: 10 },
};

/** プレイヤー（衝突判定の外）を遠くに置いてドアを dt 刻みで進める */
function step(door: Door, sec: number): void {
  for (let t = 0; t < sec; t += 0.02) door.update(0.02, 50, 50, 0.3, 0);
}

describe('ドアの開き動作中は扉板が投擲物をすり抜けさせる', () => {
  it('開いている途中は投擲物の射線が扉板を素通りし（視線は遮る）、開き切ったら当たり判定が戻る', () => {
    const door = new Door({ id: 'd', x: 0, z: 0, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, createGameEventBus());
    // 閉状態: 開口を横切る線は扉板に遮られる
    const a = { x: 0.1, y: 1, z: 1 };
    const b = { x: 0.1, y: 1, z: -1 };
    expect(hasLineOfSight(door.colliders, a, b)).toBe(false);

    // z>0 側から開ける → 扉板は -z 側（室内）へ振れる
    door.command(90, false, 0, 1);
    step(door, 0.3);
    expect(door.isMoving).toBe(true);
    expect(door.throwablePassThrough).toBe(true);
    // 途中（約 27°）の扉板は開口の大半を塞いでいる: 投擲物は素通り、視線・操作レイは遮られる
    const p = { x: 0.3, y: 1, z: 0.5 };
    const q = { x: 0.3, y: 1, z: -1.5 };
    expect(hasThrowLineOfSight(door.colliders, p, q)).toBe(true);
    expect(hasLineOfSight(door.colliders, p, q)).toBe(false);
    expect(door.raycast(new THREE.Vector3(0.3, 1, 0.5), new THREE.Vector3(0, 0, -1), 3)).not.toBeNull();

    step(door, 1.5);
    expect(door.isMoving).toBe(false);
    expect(door.throwablePassThrough).toBe(false);
    // 開き切った扉板（ヒンジ側 x=-0.6 から -z 方向へ伸びる）は投擲物も再び遮る
    expect(hasThrowLineOfSight(door.colliders, { x: -1, y: 1, z: -0.5 }, { x: 0, y: 1, z: -0.5 })).toBe(false);
  });

  it('閉める動作中は投擲物も当たる', () => {
    const door = new Door({ id: 'd2', x: 0, z: 0, yaw: 0, maxAngle: 90, locked: false }, DOOR_CFG, 2.8, createGameEventBus());
    door.command(90, false, 0, 1);
    step(door, 1.5);
    door.command(0, false, 0, 1);
    step(door, 0.3);
    expect(door.isMoving).toBe(true);
    expect(door.throwablePassThrough).toBe(false);
  });

  it('蹴り失敗の跳ね返りではすり抜けない', () => {
    const door = new Door({ id: 'kick-d', x: 0, z: 0, yaw: 0, maxAngle: 90, locked: true }, DOOR_CFG, 2.8, createGameEventBus());
    door.breach(0, 1, 'swat');
    step(door, 0.05);
    expect(door.throwablePassThrough).toBe(false);
  });
});

describe('ワンド視錐台', () => {
  it('前方の床は視錐台内、背後は視錐台外', () => {
    const cam = { x: 0, y: 0.1, z: 0, yaw: 0, pitch: 0 };
    expect(pointInWandView(cam, 70, 4 / 3, { x: 0, y: 0.35, z: -2 }).inView).toBe(true);
    expect(pointInWandView(cam, 70, 4 / 3, { x: 0, y: 0.35, z: 2 }).inView).toBe(false);
  });
});
