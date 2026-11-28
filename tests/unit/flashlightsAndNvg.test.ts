import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SuspectState } from '../../src/core/events';
import type { PostFX } from '../../src/core/PostFX';
import type { Suspect } from '../../src/ai/Suspect';
import { GAIN_AUTOGATE, GAIN_DARK, NightVision } from '../../src/player/NightVision';
import { BEAM_LEN, FlashlightSystem } from '../../src/world/Flashlights';
import { RoomLightPool, type LightSpot } from '../../src/world/RoomLightPool';
import { WorldBuilder, type Collider } from '../../src/world/WorldBuilder';

function wallCollider(minX: number, maxX: number, minZ: number, maxZ: number, maxY = 3): Collider {
  return {
    kind: 'wall',
    aabb: {
      min: { x: minX, y: 0, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    },
  };
}

function makeSuspect(id: string, x: number, z: number, yawRad = 0): Suspect {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = yawRad;
  group.updateMatrixWorld(true);
  return {
    id,
    alive: true,
    state: SuspectState.ALERT,
    body: {
      group,
      px: x,
      pz: z,
      footY: 0,
      yawRad,
    },
  } as unknown as Suspect;
}

describe('停電時のライティング設定', () => {
  it('停電時の環境光・太陽光倍率が十分低く設定されている', () => {
    expect(WorldBuilder.DARK_AMBIENT).toBeLessThanOrEqual(0.04);
    expect(WorldBuilder.DARK_SUN).toBeLessThanOrEqual(0.3);
  });

  it('RoomLightPool は停電時に屋内スポットを外し、影付きスロット 0 を屋外照明へ割り当てる', () => {
    const parent = new THREE.Group();
    const spots: LightSpot[] = [
      { x: 0, y: 2.6, z: 0, color: 0xffe6c4, intensity: 10, distance: 12, decay: 1.7 },
      { x: 6, y: 4.8, z: 0, color: 0xc8d8f0, intensity: 4.5, distance: 10, decay: 1.4, outdoor: true },
    ];
    const pool = new RoomLightPool(spots, parent);
    pool.snap({ x: 0, y: 1.6, z: 0 });
    const shadowLight = parent.children[0] as THREE.PointLight;
    expect(shadowLight.castShadow).toBe(true);
    // 通電時は最寄りの屋内照明 (x=0) が影付きスロット 0 に入る
    expect(shadowLight.position.x).toBeCloseTo(0);

    // 停電後は屋内照明が外れ、影付きスロット 0 が屋外照明 (x=6) へ移る
    pool.setIndoorPower(false, true);
    for (let i = 0; i < 20; i++) pool.update(0.1, { x: 0, y: 1.6, z: 0 });
    expect(shadowLight.position.x).toBeCloseTo(6);
    expect(shadowLight.intensity).toBeGreaterThan(0);
  });
});

describe('FlashlightSystem: 壁貫通防止とシャドウマップ', () => {
  it('壁が正面にあると光芒コーンが壁手前でクリップされ、SpotLight は影付き・点灯時のみ更新される', () => {
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    cam.position.set(0, 1.6, 5);
    cam.lookAt(0, 1.6, 0);
    cam.updateMatrixWorld(true);

    // 容疑者は (0, 0, 0) で -Z 方向を向く。レンズは (0.16, 1.24, -0.42)。
    // z = -2.42 に壁を置く（レンズからちょうど 2.0m 前方）
    const suspect = makeSuspect('s1', 0, 0, 0);
    scene.add(suspect.body.group);
    const colliders: Collider[] = [wallCollider(-4, 4, -2.62, -2.42)];

    const fl = new FlashlightSystem({
      scene,
      camera: cam,
      colliders,
      suspects: () => [suspect],
      playerLight: true,
    });

    const poolSpots = scene.children.filter((o): o is THREE.SpotLight => o instanceof THREE.SpotLight && o.name === 'flashlight-pool');
    const playerSpot = scene.children.find((o): o is THREE.SpotLight => o instanceof THREE.SpotLight && o.name === 'player-flashlight')!;
    expect(poolSpots.length).toBeGreaterThan(0);
    for (const s of [...poolSpots, playerSpot]) {
      expect(s.castShadow).toBe(true);
      expect(s.shadow.autoUpdate).toBe(false);
    }

    // 消灯時は影更新フラグが false
    fl.dark = false;
    fl.update(0.016);
    expect(poolSpots[0]!.intensity).toBe(0);
    expect(poolSpots[0]!.shadow.needsUpdate).toBe(false);
    expect(playerSpot.shadow.needsUpdate).toBe(false);

    // 停電＋点灯させる
    fl.dark = true;
    fl.adapted = true;
    fl.update(2.0);
    expect(fl.litCount).toBe(1);

    const holder = suspect.body.group.children[0]!;
    const beam = holder.children[0] as THREE.Mesh;
    expect(beam.visible).toBe(true);
    // レンズから 2.0m 先の壁に合わせてコーンが短縮されている（8.8m 貫通しない）
    expect(beam.scale.x).toBeCloseTo((2.0 - 0.02) / BEAM_LEN, 2);
    expect(poolSpots[0]!.intensity).toBeGreaterThan(0);
    expect(poolSpots[0]!.shadow.needsUpdate).toBe(true);
    expect(poolSpots[0]!.distance).toBeLessThan(3.0);

    // プレイヤーライトを壁際で点けたとき、光源が壁裏へ突き抜けない
    cam.position.set(0, 1.6, -2.35);
    cam.lookAt(0, 1.6, -5);
    cam.updateMatrixWorld(true);
    fl.togglePlayer();
    fl.update(0.016);
    expect(playerSpot.intensity).toBeGreaterThan(0);
    expect(playerSpot.shadow.needsUpdate).toBe(true);
    expect(playerSpot.position.z).toBeGreaterThanOrEqual(-2.42);

    fl.dispose();
  });

  it('レンズ自体が壁にめり込む距離では光芒もレンズも非表示になる', () => {
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    const suspect = makeSuspect('s1', 0, 0, 0);
    scene.add(suspect.body.group);
    // 胸 (z=0) とレンズ (z=-0.42) の間にある壁
    const colliders: Collider[] = [wallCollider(-4, 4, -0.3, -0.2)];

    const fl = new FlashlightSystem({
      scene,
      camera: cam,
      colliders,
      suspects: () => [suspect],
      playerLight: false,
    });
    fl.dark = true;
    fl.adapted = true;
    fl.update(2.0);

    const holder = suspect.body.group.children[0]!;
    const beam = holder.children[0] as THREE.Mesh;
    const lens = holder.children[1] as THREE.Mesh;
    expect(beam.visible).toBe(false);
    expect(lens.visible).toBe(false);

    fl.dispose();
  });

  it('glareInfo は視線が通るときスクリーン UV と強度を返し、壁に遮られると 0 を返す', () => {
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    cam.position.set(0, 1.24, -4);
    cam.lookAt(0, 1.24, 0);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const suspect = makeSuspect('s1', 0, 0, 0);
    scene.add(suspect.body.group);
    const colliders: Collider[] = [];
    const fl = new FlashlightSystem({
      scene,
      camera: cam,
      colliders,
      suspects: () => [suspect],
      playerLight: false,
    });
    fl.dark = true;
    fl.adapted = true;
    fl.update(2.0);

    const dir = cam.getWorldDirection(new THREE.Vector3());
    const info = fl.glareInfo({ x: 0, y: 1.24, z: -4 }, { x: dir.x, y: dir.y, z: dir.z }, cam);
    expect(info.intensity).toBeGreaterThan(0.5);
    expect(info.uvX).toBeGreaterThan(0.4);
    expect(info.uvX).toBeLessThan(0.6);
    expect(info.uvY).toBeGreaterThan(0.4);
    expect(info.uvY).toBeLessThan(0.6);

    // 間に壁を置くとグレアは 0
    colliders.push(wallCollider(-4, 4, -2.2, -2.0));
    const blocked = fl.glareInfo({ x: 0, y: 1.24, z: -4 }, { x: dir.x, y: dir.y, z: dir.z }, cam);
    expect(blocked.intensity).toBe(0);

    fl.dispose();
  });
});

describe('NightVision: 現代的オートゲートと局所ハロー', () => {
  it('光を浴び続けるとオートゲートでゲインが下がり、瞬間フレアは短時間で収束する', () => {
    // 最小の DOM シム（Node 環境でも動くように）
    const fakeCanvas = {
      style: { cssText: '', opacity: '0' },
      width: 0,
      height: 0,
      getContext: () => null,
      remove: vi.fn(),
    };
    const origDoc = globalThis.document;
    const origWin = globalThis.window;
    globalThis.document = { createElement: () => fakeCanvas } as unknown as Document;
    globalThis.window = { innerWidth: 1280, innerHeight: 720 } as unknown as Window & typeof globalThis;

    try {
      const calls: number[][] = [];
      const postfx = {
        setNightVision: (...args: number[]) => calls.push(args),
      } as unknown as PostFX;
      const scene = new THREE.Scene();
      const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
      const host = { appendChild: vi.fn() } as unknown as HTMLElement;

      const nv = new NightVision({
        postfx,
        scene,
        camera: cam,
        host,
        equipmentLights: [],
      });
      nv.setOn(true);
      // 装着完了まで進める（暗闇・グレアなし）
      for (let i = 0; i < 10; i++) nv.update(0.05, true, { intensity: 0, uvX: 0.5, uvY: 0.5 });
      expect(nv.level).toBe(1);
      expect(nv.effectiveGain).toBeCloseTo(GAIN_DARK, 1);

      // 急に強い光を浴びた直後: 瞬間フレアが立ち上がる
      nv.update(0.016, true, { intensity: 1.0, uvX: 0.35, uvY: 0.6 });
      const initialFlare = nv.flareLevel;
      expect(initialFlare).toBeGreaterThan(0.5);

      // 0.35 秒後（継続照射中）: 瞬間フレアは収束し、オートゲートでゲインが下がっている
      for (let i = 0; i < 22; i++) nv.update(0.016, true, { intensity: 1.0, uvX: 0.35, uvY: 0.6 });
      expect(nv.flareLevel).toBeLessThan(0.05);
      expect(nv.effectiveGain).toBeLessThan((GAIN_DARK + GAIN_AUTOGATE) / 2);
      expect(nv.effectiveGain).toBeGreaterThanOrEqual(GAIN_AUTOGATE - 0.01);

      // PostFX に局所ハロー位置 (0.35, 0.6) が渡されている
      const last = calls[calls.length - 1]!;
      expect(last[5]).toBeCloseTo(0.35, 2);
      expect(last[6]).toBeCloseTo(0.6, 2);

      nv.dispose();
    } finally {
      globalThis.document = origDoc;
      globalThis.window = origWin;
    }
  });
});
