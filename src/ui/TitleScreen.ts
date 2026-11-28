import * as THREE from 'three';
import { HumanoidBody } from '../ai/HumanoidBody';
import type { AudioEngine } from '../core/Audio';
import type { StageEntry, Vec3 } from '../core/types';
import { getLocale, setLocale, onLocaleChange, t, tStageSize, tStageTagline } from '../core/i18n';
import { getSettings, subscribeSettings, updateSettings } from '../core/Settings';
import { TitleAudio } from './TitleAudio';
import type { GameMode } from '../modes/SuspectMode';
import { disposeObject } from '../core/dispose';
import { KOFI_URL } from './shareLinks';

/**
 * タイトル画面。
 * 夜の市街地で、パトカーと SWAT 装甲車を盾にした隊員と、建物の入口で人質を盾にした容疑者が撃ち合う
 * 軽量な 3D シーンを背景に描き、モードとマップの広さを選んでから初めてランダムマップを生成する。
 * マップ生成（重い）はここでは一切行わない。
 */

export interface TitleScreenOptions {
  renderer: THREE.WebGLRenderer;
  envTex: THREE.Texture | null;
  audio: AudioEngine | null;
  /** ステージ一覧の読み込み（失敗時はタイトル上の「再試行」から呼び直す） */
  loadStages: () => Promise<readonly StageEntry[]>;
  initialMode: GameMode;
  initialStageId: string | null;
  /** モード・広さが決まった。ここからマップ生成が始まる */
  onStart: (mode: GameMode, stageId: string) => void;
}

const STYLE_ID = 'title-screen-style';
const CSS = `
.tts-root{position:fixed;inset:0;z-index:15;color:#e9f0f8;font:15px/1.5 'Hiragino Sans','Yu Gothic UI','Segoe UI',system-ui,sans-serif;pointer-events:none;user-select:none}
.tts-root *{box-sizing:border-box}
.tts-vignette{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,rgba(0,0,0,0) 40%,rgba(0,0,0,.62) 100%),linear-gradient(180deg,rgba(0,0,0,.55) 0%,rgba(0,0,0,0) 26%,rgba(0,0,0,0) 52%,rgba(2,5,10,.86) 100%)}
.tts-strobe{position:absolute;inset:0;mix-blend-mode:screen;opacity:.0;transition:opacity .06s linear}
.tts-top{position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;align-items:flex-start;padding:16px 20px;pointer-events:auto}
.tts-live{display:inline-flex;align-items:center;gap:8px;font:bold 12px monospace;letter-spacing:.18em;color:#ffd7d7;background:rgba(160,16,24,.78);padding:4px 10px;border-radius:3px}
.tts-live i{width:8px;height:8px;border-radius:50%;background:#ff3b3b;box-shadow:0 0 8px #ff3b3b;animation:tts-blink 1s steps(2) infinite}
@keyframes tts-blink{50%{opacity:.15}}
.tts-sound-hint{animation:tts-pulse 1.6s ease-in-out infinite;border-color:#ffd24d!important;color:#ffe9a8!important}
@keyframes tts-pulse{50%{box-shadow:0 0 14px rgba(255,210,77,.55)}}
.tts-topbtns{display:flex;gap:8px}
.tts-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:6px;background:rgba(18,28,40,.72);border:1px solid rgba(120,160,200,.35);color:#dce6f2;font:bold 12px sans-serif;cursor:pointer;text-decoration:none;backdrop-filter:blur(4px)}
.tts-btn:hover{background:rgba(36,54,76,.9);border-color:#7fb4ec}
.tts-hero{position:absolute;left:0;right:0;top:6vh;text-align:center;pointer-events:none}
.tts-kicker{font:bold 13px monospace;letter-spacing:.5em;color:#9fd4ff;text-shadow:0 0 12px rgba(80,160,255,.7);margin-bottom:6px}
.tts-title{font:900 clamp(40px,7.2vw,92px)/0.92 'Impact','Arial Black','Segoe UI',sans-serif;letter-spacing:.06em;color:#f4f7fb;text-shadow:0 0 2px #fff,0 4px 0 #0c1420,0 0 34px rgba(255,60,60,.45),0 0 70px rgba(60,120,255,.35);margin:0}
.tts-title span{color:#ffd24d}
.tts-sub{margin-top:10px;font:bold clamp(12px,1.6vw,17px) sans-serif;letter-spacing:.32em;color:#c9d6e4;text-shadow:0 2px 6px #000}
.tts-panel{position:absolute;left:50%;bottom:50px;transform:translateX(-50%);width:min(980px,calc(100vw - 32px));pointer-events:auto;display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr) auto;gap:14px;align-items:stretch;padding:14px;border-radius:12px;background:rgba(8,13,20,.74);border:1px solid rgba(90,120,160,.35);box-shadow:0 18px 50px rgba(0,0,0,.6);backdrop-filter:blur(6px)}
.tts-step{display:flex;flex-direction:column;gap:6px;min-width:0}
.tts-step-title{font:bold 12px sans-serif;letter-spacing:.14em;color:#9fb2c6}
.tts-step-title b{display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;margin-right:6px;border-radius:50%;background:#f2c14e;color:#0a121a;font-size:11px}
.tts-choices{display:grid;gap:6px;flex:1}
.tts-choice{text-align:left;padding:9px 11px;border-radius:8px;background:rgba(25,37,52,.85);border:2px solid #34495f;color:#dce6f2;cursor:pointer;font:13px/1.35 sans-serif;display:flex;flex-direction:column;gap:2px;transition:background .12s,border-color .12s,transform .12s;min-width:0}
.tts-choice:hover,.tts-choice:focus-visible{background:#213248;border-color:#7fb4ec;outline:none;transform:translateY(-1px)}
.tts-choice[aria-pressed="true"]{border-color:var(--c);background:color-mix(in srgb,var(--c) 18%,#111a26);box-shadow:0 0 0 1px color-mix(in srgb,var(--c) 40%,transparent) inset,0 0 18px color-mix(in srgb,var(--c) 30%,transparent)}
.tts-choice-name{font:bold 15px sans-serif;color:#f4f8fc;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tts-choice-desc{font-size:11.5px;color:#9fb2c6;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.tts-size{font:900 26px/1 sans-serif}
.tts-start{align-self:stretch;min-width:170px;padding:0 26px;font:900 18px sans-serif;letter-spacing:.08em;color:#0a121a;background:linear-gradient(180deg,#ffe07a,#f2b630);border:none;border-radius:10px;cursor:pointer;box-shadow:0 0 22px rgba(242,193,78,.45);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.tts-start small{font:bold 11px monospace;letter-spacing:.12em;opacity:.7}
.tts-start:hover{filter:brightness(1.08)}
.tts-start:disabled{cursor:wait;filter:grayscale(.6) brightness(.8)}
.tts-ticker{position:absolute;left:0;right:0;bottom:0;height:34px;display:flex;align-items:center;overflow:hidden;background:linear-gradient(90deg,rgba(150,10,18,.92),rgba(110,8,14,.86));border-top:2px solid #ff4b4b;pointer-events:none}
.tts-ticker-tag{flex:none;position:relative;z-index:1;height:100%;display:flex;align-items:center;padding:0 14px;font:900 13px sans-serif;letter-spacing:.12em;color:#fff;background:#1a0306}
.tts-ticker-track{white-space:nowrap;font:bold 13px sans-serif;color:#ffe9e9;letter-spacing:.06em;animation:tts-scroll 38s linear infinite;padding-left:100%}
@keyframes tts-scroll{to{transform:translateX(-100%)}}
.tts-loading{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:rgba(4,7,12,.55);pointer-events:auto}
.tts-loading.on{display:flex}
.tts-loading-text{font:bold 18px sans-serif;letter-spacing:.18em;color:#f2f6fb;text-shadow:0 2px 8px #000}
.tts-spinner{width:44px;height:44px;border-radius:50%;border:4px solid rgba(255,255,255,.18);border-top-color:#ffd24d;animation:tts-spin .8s linear infinite}
@keyframes tts-spin{to{transform:rotate(360deg)}}
@media (max-width:820px){.tts-panel{grid-template-columns:1fr;bottom:44px;gap:10px;padding:10px;max-height:calc(100vh - 220px);overflow:auto}.tts-start{min-height:52px}.tts-hero{top:64px}.tts-kicker{display:none}.tts-sub{letter-spacing:.12em;padding:0 12px}.tts-choice-desc{display:none}.tts-choices{gap:6px}.tts-top{padding:10px 12px}.tts-live{font-size:10px;letter-spacing:.08em}.tts-btn{padding:5px 9px;font-size:11px}.tts-kofi{display:none}}
`;

// ---------------------------------------------------------------------------
// 3D シーンの部品
// ---------------------------------------------------------------------------

interface Shooter {
  body: HumanoidBody;
  side: 'swat' | 'suspect';
  /** 次のバースト開始までの秒数 */
  wait: number;
  /** バースト中の残弾 */
  burst: number;
  shotGap: number;
  /** 撃たない時の遮蔽姿勢 / 撃つ時の露出 */
  coverLean: number;
  fireLean: number;
  exposed: number;
  homeX: number;
  homeZ: number;
  fireX: number;
  fireZ: number;
  pose: 'stand' | 'kneel' | 'crouch';
  firePose: 'stand' | 'crouch';
  aim: THREE.Vector3;
}

interface Tracer {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  dir: THREE.Vector3;
  dist: number;
  travelled: number;
  live: boolean;
  hit: 'metal' | 'wall' | 'glass' | 'none';
}

interface Smoke {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  grow: number;
  live: boolean;
}

interface StrobeLight {
  light: THREE.PointLight;
  lens: THREE.MeshBasicMaterial;
  color: 'red' | 'blue';
  phase: number;
  rate: number;
}

const SPARK_MAX = 360;
const TRACER_SPEED = 140;
const TRACER_LEN = 2.4;

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

class StandoffScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 220);
  private readonly shooters: Shooter[] = [];
  private readonly tracers: Tracer[] = [];
  private readonly smokes: Smoke[] = [];
  private readonly strobes: StrobeLight[] = [];
  private readonly muzzleLights: THREE.PointLight[] = [];
  private readonly flashSprites: { sprite: THREE.Sprite; life: number }[] = [];
  private flashIdx = 0;
  private muzzleLightIdx = 0;
  private readonly sparkPos = new Float32Array(SPARK_MAX * 3);
  private readonly sparkCol = new Float32Array(SPARK_MAX * 3);
  private readonly sparkVel = new Float32Array(SPARK_MAX * 3);
  private readonly sparkLife = new Float32Array(SPARK_MAX);
  private sparkCursor = 0;
  private readonly sparkGeo = new THREE.BufferGeometry();
  private suspect!: HumanoidBody;
  private hostage!: HumanoidBody;
  private hostageShake = 0;
  private readonly windows: { mat: THREE.MeshStandardMaterial; base: number; flicker: number }[] = [];
  private readonly searchLight: THREE.SpotLight;
  private readonly searchCone: THREE.Mesh;
  private readonly searchTarget = new THREE.Object3D();
  private time = 0;
  private shake = 0;
  private readonly camBase = new THREE.Vector3(0.2, 2.5, 10.5);
  private readonly camLook = new THREE.Vector3(0, 0.55, -16);
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpO: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmpD: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly smokeTex: THREE.CanvasTexture;
  private readonly textures: THREE.Texture[] = [];
  /** 1 フレーム内の「ストロボの強さ」(-1=青 .. +1=赤)。UI の色かぶり演出に使う */
  strobeTint = 0;
  /** 直近の発砲で画面がわずかに明るくなる量 */
  flashPulse = 0;
  onShot: ((pos: Vec3) => void) | null = null;

  constructor(envTex: THREE.Texture | null) {
    const s = this.scene;
    s.background = new THREE.Color(0x070b14);
    s.fog = new THREE.FogExp2(0x0a1220, 0.028);
    if (envTex) {
      s.environment = envTex;
      s.environmentIntensity = 0.18;
    }

    // 環境光: 月明かり + 街の照り返し
    s.add(new THREE.HemisphereLight(0x3a5478, 0x0c0a08, 0.55));
    const moon = new THREE.DirectionalLight(0x9db8e8, 0.55);
    moon.position.set(-14, 22, 10);
    moon.target.position.set(0, 0, -6);
    moon.castShadow = true;
    moon.shadow.mapSize.set(1024, 1024);
    const sc = moon.shadow.camera;
    sc.left = -18;
    sc.right = 18;
    sc.top = 18;
    sc.bottom = -18;
    sc.near = 1;
    sc.far = 60;
    moon.shadow.bias = -0.0006;
    s.add(moon, moon.target);

    this.smokeTex = canvasTexture(128, 128, (ctx) => {
      const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
      g.addColorStop(0, 'rgba(200,205,215,0.55)');
      g.addColorStop(0.5, 'rgba(160,168,180,0.22)');
      g.addColorStop(1, 'rgba(120,128,140,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    });
    this.textures.push(this.smokeTex);

    this.buildStreet();
    this.buildBuilding();
    this.buildVehicles();
    this.buildPeople();

    // 装甲車ルーフのサーチライトを入口へ向ける
    this.searchLight = new THREE.SpotLight(0xfff3d8, 120, 40, 0.2, 0.55, 1.6);
    this.searchLight.position.set(-5.0, 3.35, -4.6);
    this.searchTarget.position.set(0.2, 1.6, -15);
    s.add(this.searchTarget);
    this.searchLight.target = this.searchTarget;
    this.searchLight.castShadow = true;
    this.searchLight.shadow.mapSize.set(512, 512);
    s.add(this.searchLight);
    const coneGeo = new THREE.ConeGeometry(1.6, 12, 24, 1, true);
    coneGeo.translate(0, -6, 0);
    coneGeo.rotateX(-Math.PI / 2);
    this.searchCone = new THREE.Mesh(
      coneGeo,
      new THREE.MeshBasicMaterial({
        color: 0xfff1cc,
        transparent: true,
        opacity: 0.05,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    this.searchCone.position.copy(this.searchLight.position);
    s.add(this.searchCone);

    // 発砲時の閃光（常に同数のライトを置いておき、強さだけ変える = シェーダの再コンパイルを避ける）
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffc070, 0, 9, 2);
      s.add(l);
      this.muzzleLights.push(l);
    }

    // 銃口の閃光（ビルボード）
    const flashTex = canvasTexture(64, 64, (ctx) => {
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,235,1)');
      g.addColorStop(0.25, 'rgba(255,214,120,0.9)');
      g.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const r = i % 2 === 0 ? 32 : 11;
        ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
      }
      ctx.fill();
    });
    this.textures.push(flashTex);
    for (let i = 0; i < 6; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      sprite.visible = false;
      s.add(sprite);
      this.flashSprites.push({ sprite, life: 0 });
    }

    // 曳光弾
    const tracerGeo = new THREE.BoxGeometry(0.05, 0.05, 1);
    tracerGeo.translate(0, 0, -0.5);
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd890, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    for (let i = 0; i < 28; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      s.add(mesh);
      this.tracers.push({ mesh, from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, travelled: 0, live: false, hit: 'none' });
    }

    // 火花
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3));
    for (let i = 0; i < SPARK_MAX; i++) this.sparkPos[i * 3 + 1] = -100;
    const sparks = new THREE.Points(
      this.sparkGeo,
      new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    sparks.frustumCulled = false;
    s.add(sparks);

    // 煙
    for (let i = 0; i < 26; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, depthWrite: false, opacity: 0, color: 0x9aa4b4 }));
      sprite.visible = false;
      s.add(sprite);
      this.smokes.push({ sprite, vel: new THREE.Vector3(), life: 0, maxLife: 1, grow: 1, live: false });
    }
    // 最初から立ちこめている煙（発煙弾の名残）
    for (let i = 0; i < 9; i++) {
      this.spawnSmoke(this.tmpA.set(rand(-6, 6), rand(0.3, 1.6), rand(-13, -7)), rand(2.2, 3.6), rand(6, 14), 0.22, rand(0, 0.6));
    }

    s.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m.material as THREE.Material).transparent) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
  }

  // ---------- 建物・道路 ----------

  private buildStreet(): void {
    const s = this.scene;
    const asphaltTex = canvasTexture(512, 512, (ctx) => {
      ctx.fillStyle = '#1b1d21';
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 9000; i++) {
        const v = 20 + Math.random() * 30;
        ctx.fillStyle = `rgba(${v},${v},${v + 4},${Math.random() * 0.5})`;
        ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
      }
      // 水たまり（濡れた路面の映り込み用にわずかに暗く）
      for (let i = 0; i < 10; i++) {
        const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 60);
        g.addColorStop(0, 'rgba(8,10,14,.6)');
        g.addColorStop(1, 'rgba(8,10,14,0)');
        ctx.save();
        ctx.translate(Math.random() * 512, Math.random() * 512);
        ctx.scale(1.8, 0.7);
        ctx.fillStyle = g;
        ctx.fillRect(-60, -60, 120, 120);
        ctx.restore();
      }
    });
    asphaltTex.wrapS = asphaltTex.wrapT = THREE.RepeatWrapping;
    asphaltTex.repeat.set(6, 6);
    this.textures.push(asphaltTex);
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 70),
      new THREE.MeshStandardMaterial({ map: asphaltTex, color: 0x8a8e96, roughness: 0.38, metalness: 0.15 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, -6);
    s.add(road);

    // センターライン
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xc9a640, roughness: 0.6 });
    for (let i = -10; i <= 10; i++) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.01, 0.14), lineMat);
      l.position.set(i * 4, 0.006, -6.5);
      s.add(l);
    }
    // 歩道と縁石
    const walk = new THREE.Mesh(new THREE.BoxGeometry(80, 0.16, 4.2), new THREE.MeshStandardMaterial({ color: 0x4a4c50, roughness: 0.85 }));
    walk.position.set(0, 0.08, -13.9);
    s.add(walk);

    // 街灯
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.6, metalness: 0.6 });
    for (const x of [-11, 12]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 8), poleMat);
      pole.position.set(x, 3, -12.6);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.1), poleMat);
      arm.position.set(x + (x < 0 ? 0.65 : -0.65), 5.95, -12.6);
      const lamp = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.12, 0.25),
        new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffb866, emissiveIntensity: 3 }),
      );
      lamp.position.set(x + (x < 0 ? 1.2 : -1.2), 5.88, -12.6);
      const light = new THREE.PointLight(0xffb56b, 28, 16, 1.8);
      light.position.set(x + (x < 0 ? 1.2 : -1.2), 5.6, -12.4);
      s.add(pole, arm, lamp, light);
    }

    // 規制線のバリケード（木馬）
    const stripeTex = canvasTexture(256, 32, (ctx) => {
      for (let i = 0; i < 16; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#e8e2d8' : '#c4241c';
        ctx.beginPath();
        ctx.moveTo(i * 20 - 10, 32);
        ctx.lineTo(i * 20 + 10, 0);
        ctx.lineTo(i * 20 + 30, 0);
        ctx.lineTo(i * 20 + 10, 32);
        ctx.fill();
      }
    });
    this.textures.push(stripeTex);
    const boardMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.7 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x5a4a38, roughness: 0.9 });
    const horse = (x: number, z: number, yaw: number): void => {
      const g = new THREE.Group();
      const board = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.26, 0.05), boardMat);
      board.position.y = 0.9;
      g.add(board);
      for (const sx of [-0.9, 0.9]) {
        for (const sz of [-0.22, 0.22]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.06), legMat);
          leg.position.set(sx, 0.48, sz * 0.6);
          leg.rotation.x = sz > 0 ? -0.22 : 0.22;
          g.add(leg);
        }
      }
      g.position.set(x, 0, z);
      g.rotation.y = yaw;
      s.add(g);
    };
    horse(-9.5, -1.0, 0.3);
    horse(8.8, -0.6, -0.4);
  }

  private buildBuilding(): void {
    const s = this.scene;
    const facadeTex = canvasTexture(512, 512, (ctx) => {
      ctx.fillStyle = '#6c5f55';
      ctx.fillRect(0, 0, 512, 512);
      // レンガ目地
      for (let y = 0; y < 512; y += 16) {
        const off = (y / 16) % 2 === 0 ? 0 : 16;
        for (let x = -32; x < 512; x += 32) {
          const v = 90 + Math.random() * 40;
          ctx.fillStyle = `rgb(${v + 20},${v - 4},${v - 18})`;
          ctx.fillRect(x + off + 1, y + 1, 30, 14);
        }
      }
    });
    facadeTex.wrapS = facadeTex.wrapT = THREE.RepeatWrapping;
    facadeTex.repeat.set(5, 3);
    this.textures.push(facadeTex);
    const wallMat = new THREE.MeshStandardMaterial({ map: facadeTex, color: 0x9a8c82, roughness: 0.9 });
    const W = 22;
    const H = 11;
    const front = -16;
    const bldg = new THREE.Mesh(new THREE.BoxGeometry(W, H, 10), wallMat);
    bldg.position.set(0, H / 2, front - 5);
    s.add(bldg);
    // 両隣の建物（シルエット）
    const nbMat = new THREE.MeshStandardMaterial({ color: 0x252a33, roughness: 0.95 });
    for (const [x, w, h] of [[-19, 14, 16], [19, 14, 13], [-33, 14, 22], [32, 12, 19]] as const) {
      const nb = new THREE.Mesh(new THREE.BoxGeometry(w, h, 12), nbMat);
      nb.position.set(x, h / 2, front - 6.5);
      s.add(nb);
      // まばらな窓明かり
      for (let r = 0; r < Math.floor(h / 3.2); r++) {
        for (let c = 0; c < Math.floor(w / 2.6); c++) {
          if (Math.random() < 0.72) continue;
          const win = new THREE.Mesh(
            new THREE.PlaneGeometry(1.1, 1.3),
            new THREE.MeshStandardMaterial({ color: 0x000000, emissive: Math.random() < 0.5 ? 0xffc98a : 0x9fc4ff, emissiveIntensity: rand(0.3, 0.9) }),
          );
          win.position.set(x - w / 2 + 1.4 + c * 2.6, 2.4 + r * 3.2, front - 0.48);
          s.add(win);
        }
      }
    }

    // 窓（上階）。人質事件らしく、明かりの点いた窓とブラインドの降りた窓が混在する
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.7 });
    for (let floor = 0; floor < 2; floor++) {
      for (let c = 0; c < 6; c++) {
        const x = -8.75 + c * 3.5;
        const y = 5.0 + floor * 3.3;
        const frame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 2.1, 0.2), frameMat);
        frame.position.set(x, y, front + 0.02);
        const lit = Math.random() < 0.55;
        const glassMat = new THREE.MeshStandardMaterial({
          color: 0x10141a,
          emissive: lit ? 0xffb870 : 0x1c2838,
          emissiveIntensity: lit ? 1.1 : 0.4,
          roughness: 0.15,
          metalness: 0.3,
        });
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 1.85), glassMat);
        glass.position.set(x, y, front + 0.13);
        const sill = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.35), frameMat);
        sill.position.set(x, y - 1.1, front + 0.15);
        s.add(frame, glass, sill);
        this.windows.push({ mat: glassMat, base: glassMat.emissiveIntensity, flicker: lit && Math.random() < 0.3 ? rand(4, 11) : 0 });
      }
    }
    // 1 階のショーウィンドウ
    for (const x of [-6.5, 6.5]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(5.2, 2.6, 0.22), frameMat);
      frame.position.set(x, 1.75, front + 0.02);
      const glassMat = new THREE.MeshStandardMaterial({ color: 0x0b0f14, emissive: 0x6d8aa8, emissiveIntensity: 0.35, roughness: 0.08, metalness: 0.6 });
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 2.3), glassMat);
      glass.position.set(x, 1.75, front + 0.14);
      s.add(frame, glass);
      this.windows.push({ mat: glassMat, base: 0.35, flicker: 0 });
    }

    // 入口: 庇・看板・開いた扉と室内の灯り
    const awning = new THREE.Mesh(new THREE.BoxGeometry(5, 0.22, 1.6), new THREE.MeshStandardMaterial({ color: 0x1e2c3c, roughness: 0.6 }));
    awning.position.set(0, 3.6, front + 0.8);
    s.add(awning);
    const signTex = canvasTexture(512, 96, (ctx) => {
      ctx.fillStyle = '#0d1520';
      ctx.fillRect(0, 0, 512, 96);
      ctx.strokeStyle = '#c8a24a';
      ctx.lineWidth = 4;
      ctx.strokeRect(6, 6, 500, 84);
      ctx.fillStyle = '#e8cf8a';
      ctx.font = 'bold 50px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('MERIDIAN TRUST', 256, 50);
    });
    this.textures.push(signTex);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 0.86),
      new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.55 }),
    );
    sign.position.set(0, 4.15, front + 0.14);
    s.add(sign);
    const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.1, 0.3), frameMat);
    doorFrame.position.set(0, 1.55, front);
    s.add(doorFrame);
    const interior = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 2.85),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffb36a, emissiveIntensity: 0.85 }),
    );
    interior.position.set(0, 1.44, front + 0.16);
    s.add(interior);
    const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(1.05, 2.75, 0.06), new THREE.MeshStandardMaterial({ color: 0x40311f, roughness: 0.6 }));
    doorLeaf.position.set(-1.45, 1.47, front + 0.65);
    doorLeaf.rotation.y = -1.15;
    s.add(doorLeaf);
    const doorLight = new THREE.PointLight(0xffa860, 14, 7, 1.6);
    doorLight.position.set(0, 2.2, front + 0.9);
    s.add(doorLight);
    // 入口前のステップ
    const step = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.16, 1.4), new THREE.MeshStandardMaterial({ color: 0x5c5e62, roughness: 0.8 }));
    step.position.set(0, 0.24, front + 0.9);
    s.add(step);
    // 屋上の縁
    const parapet = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x3b3430, roughness: 0.9 }));
    parapet.position.set(0, H + 0.25, front + 0.1);
    s.add(parapet);
  }

  // ---------- 車両 ----------

  private addLightBar(parent: THREE.Object3D, x: number, y: number, z: number, width: number): void {
    const bar = new THREE.Group();
    bar.position.set(x, y, z);
    const base = new THREE.Mesh(new THREE.BoxGeometry(width, 0.09, 0.28), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.5 }));
    bar.add(base);
    for (const [side, color] of [[-1, 'red'], [1, 'blue']] as const) {
      const lensMat = new THREE.MeshBasicMaterial({ color: color === 'red' ? 0xff2020 : 0x2a5cff, transparent: true, opacity: 0.95, fog: false });
      const lens = new THREE.Mesh(new THREE.BoxGeometry(width * 0.44, 0.12, 0.24), lensMat);
      lens.position.set((side * width) / 4, 0.09, 0);
      bar.add(lens);
      const light = new THREE.PointLight(color === 'red' ? 0xff1a1a : 0x2850ff, 0, 18, 1.5);
      light.position.set((side * width) / 4, 0.25, 0);
      bar.add(light);
      this.strobes.push({ light, lens: lensMat, color, phase: Math.random() * 10, rate: rand(5.5, 7.5) });
    }
    parent.add(bar);
  }

  private wheel(parent: THREE.Object3D, x: number, z: number, r: number, w: number): void {
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), new THREE.MeshStandardMaterial({ color: 0x0f0f10, roughness: 0.9 }));
    tire.rotation.x = Math.PI / 2; // 車体は x が前後なので、車軸は z（横）方向
    tire.position.set(x, r, z);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 12), new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.35, metalness: 0.8 }));
    hub.rotation.x = Math.PI / 2;
    hub.position.copy(tire.position);
    parent.add(tire, hub);
  }

  private buildPoliceCar(x: number, z: number, yaw: number): THREE.Group {
    const g = new THREE.Group();
    const doorTex = canvasTexture(256, 128, (ctx) => {
      ctx.fillStyle = '#f2f3f5';
      ctx.fillRect(0, 0, 256, 128);
      ctx.fillStyle = '#10151d';
      ctx.font = 'bold 46px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('POLICE', 128, 66);
    });
    this.textures.push(doorTex);
    const white = new THREE.MeshStandardMaterial({ color: 0xf0f1f3, roughness: 0.32, metalness: 0.4 });
    const black = new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.3, metalness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0a0e14, roughness: 0.05, metalness: 0.9 });
    const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.35, metalness: 0.35 });
    // 車体（x が前後方向）: 下半分は黒、ドアは白（白黒パトカー）
    const lower = new THREE.Mesh(new THREE.BoxGeometry(4.7, 0.55, 1.82), black);
    lower.position.y = 0.55;
    const mid = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.32, 1.84), white);
    mid.position.y = 0.98;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.52, 1.64), glass);
    cabin.position.set(-0.2, 1.38, 0);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.06, 1.6), white);
    roof.position.set(-0.25, 1.66, 0);
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.58), doorMat);
      panel.position.set(-0.1, 0.83, side * 0.925);
      if (side < 0) panel.rotation.y = Math.PI;
      g.add(panel);
    }
    g.add(lower, mid, cabin, roof);
    for (const wx of [-1.45, 1.45]) for (const wz of [-0.86, 0.86]) this.wheel(g, wx, wz, 0.36, 0.26);
    // ヘッドライト
    const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 2.4 });
    for (const wz of [-0.62, 0.62]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.34), head);
      h.position.set(2.36, 0.86, wz);
      g.add(h);
    }
    const beam = new THREE.SpotLight(0xfff1d6, 30, 26, 0.45, 0.6, 1.5);
    beam.position.set(2.4, 0.9, 0);
    const beamTarget = new THREE.Object3D();
    beamTarget.position.set(10, 0, 0);
    g.add(beam, beamTarget);
    beam.target = beamTarget;
    this.addLightBar(g, -0.25, 1.73, 0, 1.25);
    // 開け放した運転席ドア（隊員の盾）
    const openDoor = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.95, 0.07), white);
    openDoor.position.set(0.55, 0.95, 1.25);
    openDoor.rotation.y = -0.85;
    g.add(openDoor);
    g.scale.set(1, 0.9, 1);
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    this.scene.add(g);
    return g;
  }

  private buildArmoredTruck(x: number, z: number, yaw: number): THREE.Group {
    const g = new THREE.Group();
    const sideTex = canvasTexture(512, 192, (ctx) => {
      ctx.fillStyle = '#1a2230';
      ctx.fillRect(0, 0, 512, 192);
      ctx.fillStyle = '#e8edf3';
      ctx.font = '900 112px Impact, Arial Black, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('SWAT', 256, 92);
      ctx.fillStyle = '#c8a24a';
      ctx.fillRect(40, 160, 432, 8);
    });
    this.textures.push(sideTex);
    const body = new THREE.MeshStandardMaterial({ color: 0x1b2331, roughness: 0.55, metalness: 0.45 });
    const sideMat = new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.55, metalness: 0.45 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x06080c, roughness: 0.05, metalness: 0.9 });
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.5, 2.5), new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.8 }));
    chassis.position.y = 0.75;
    const hull = new THREE.Mesh(new THREE.BoxGeometry(4.3, 1.9, 2.5), body);
    hull.position.set(-0.9, 1.95, 0);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.05, 2.4), body);
    hood.position.set(2.15, 1.5, 0);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.95, 2.4), body);
    cab.position.set(1.7, 2.4, 0);
    const wind = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 2.0), glass);
    wind.position.set(2.31, 2.45, 0);
    wind.rotation.z = -0.22;
    g.add(chassis, hull, hood, cab, wind);
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.27), sideMat);
      panel.position.set(-0.9, 2.0, side * 1.255);
      if (side < 0) panel.rotation.y = Math.PI;
      g.add(panel);
      // 銃眼付きの小窓
      const port = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.02), glass);
      port.position.set(1.6, 2.5, side * 1.21);
      g.add(port);
    }
    // バンパー・ラム
    const ram = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.42, 2.6), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.5, metalness: 0.7 }));
    ram.position.set(3.15, 0.85, 0);
    g.add(ram);
    for (const wx of [-2.0, 1.9]) for (const wz of [-1.12, 1.12]) this.wheel(g, wx, wz, 0.55, 0.42);
    const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 2.6 });
    for (const wz of [-0.9, 0.9]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.3), head);
      h.position.set(3.11, 1.5, wz);
      g.add(h);
    }
    this.addLightBar(g, 1.7, 2.92, 0, 1.6);
    // ルーフのサーチライト本体
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.36, 16), new THREE.MeshStandardMaterial({ color: 0x222, emissive: 0xfff2d0, emissiveIntensity: 1.2 }));
    lamp.rotation.z = Math.PI / 2;
    lamp.position.set(-0.4, 3.12, 0.5);
    g.add(lamp);
    // 後部の開いたドア
    const rear = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.7, 1.15), body);
    rear.position.set(-3.35, 1.95, 1.6);
    rear.rotation.y = 0.9;
    g.add(rear);
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    this.scene.add(g);
    return g;
  }

  private buildVehicles(): void {
    // 手前の左右に装甲車とパトカーを斜めに止め、中央は入口までの射線を空けておく
    this.buildArmoredTruck(-5.3, -4.6, 0.42);
    this.buildPoliceCar(4.9, -4.2, Math.PI - 0.45);
    // 奥のパトカー（シルエットと回転灯で奥行きを出す）
    this.buildPoliceCar(10.5, -9.6, Math.PI - 0.15);
    this.buildPoliceCar(-11.5, -10.2, 0.25);
  }

  // ---------- 人物 ----------

  private addShooter(
    x: number,
    z: number,
    fireX: number,
    fireZ: number,
    opts: { shield?: boolean; pose: 'stand' | 'kneel' | 'crouch'; firePose: 'stand' | 'crouch'; coverLean?: number; fireLean?: number },
  ): void {
    const body = new HumanoidBody(x, z, 180, 0x2a3440, true, { role: 'ally', shield: opts.shield });
    body.setReadyPose('high');
    body.setPose(opts.pose);
    body.faceToward(0, -15, Math.PI * 2);
    this.scene.add(body.group);
    this.shooters.push({
      body,
      side: 'swat',
      wait: rand(0.3, 2.5),
      burst: 0,
      shotGap: 0,
      coverLean: opts.coverLean ?? 0,
      fireLean: opts.fireLean ?? 0,
      exposed: 0,
      homeX: x,
      homeZ: z,
      fireX,
      fireZ,
      pose: opts.pose,
      firePose: opts.firePose,
      aim: new THREE.Vector3(0, 1.5, -15),
    });
  }

  private buildPeople(): void {
    // SWAT: 装甲車の前後・パトカーのドアの陰から交互に身を乗り出して撃つ
    // 装甲車の陰（左）: 盾持ちが鼻先から、2 人目が後ろから身を乗り出す
    this.addShooter(-2.2, -2.2, -1.75, -2.5, { shield: true, pose: 'crouch', firePose: 'stand', fireLean: 0.5 });
    this.addShooter(-3.4, -1.7, -3.1, -2.0, { pose: 'kneel', firePose: 'stand', coverLean: 0.1, fireLean: 0.7 });
    this.addShooter(-7.7, -2.6, -8.0, -3.0, { pose: 'kneel', firePose: 'crouch', coverLean: -0.2, fireLean: -0.9 });
    // パトカーの陰（右）: ボンネット越し・開いたドアの陰から撃つ
    this.addShooter(2.6, -2.4, 2.25, -2.6, { pose: 'kneel', firePose: 'crouch', fireLean: -0.9 });
    this.addShooter(4.6, -2.3, 4.6, -2.3, { pose: 'crouch', firePose: 'stand', fireLean: -0.2 });
    this.addShooter(7.0, -2.9, 7.3, -3.2, { pose: 'kneel', firePose: 'crouch', fireLean: 0.8 });

    // 容疑者と人質（入口のステップ上）。容疑者はカメラから見て人質の左後ろ。
    // カメラ向きなので容疑者の右手（銃）は画面左側＝人質の外側になる
    const footY = 0.32;
    this.hostage = new HumanoidBody(0.05, -14.45, 0, 0xc4ccd8, false, { role: 'civilian', footY });
    this.hostage.setRestrained(true);
    this.hostage.faceToward(0, 0, Math.PI * 2);
    this.scene.add(this.hostage.group);
    this.suspect = new HumanoidBody(-0.4, -14.9, 0, 0x5a2626, true, { role: 'suspect', footY });
    this.suspect.setReadyPose('high');
    this.suspect.faceToward(0, 0, Math.PI * 2);
    this.scene.add(this.suspect.group);
    this.shooters.push({
      body: this.suspect,
      side: 'suspect',
      wait: 1.2,
      burst: 0,
      shotGap: 0,
      coverLean: 0.55,
      fireLean: 0.95,
      exposed: 0,
      homeX: -0.4,
      homeZ: -14.9,
      fireX: -0.55,
      fireZ: -14.9,
      pose: 'stand',
      firePose: 'stand',
      aim: new THREE.Vector3(0, 1.4, -2),
    });
  }

  // ---------- 効果 ----------

  private spawnSmoke(pos: THREE.Vector3, size: number, life: number, opacity: number, rise: number): void {
    const s = this.smokes.find((m) => !m.live);
    if (!s) return;
    s.live = true;
    s.life = 0;
    s.maxLife = life;
    s.grow = size * 0.6;
    s.sprite.position.copy(pos);
    s.sprite.scale.setScalar(size);
    s.sprite.visible = true;
    (s.sprite.material as THREE.SpriteMaterial).opacity = opacity;
    s.sprite.userData.opacity = opacity;
    s.vel.set(rand(-0.25, 0.25) + 0.18, rise, rand(-0.12, 0.12));
  }

  private spawnSparks(pos: THREE.Vector3, normal: THREE.Vector3, n: number, hot: boolean): void {
    for (let k = 0; k < n; k++) {
      const i = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % SPARK_MAX;
      this.sparkPos[i * 3] = pos.x;
      this.sparkPos[i * 3 + 1] = pos.y;
      this.sparkPos[i * 3 + 2] = pos.z;
      const sp = rand(1.5, hot ? 6.5 : 3.5);
      this.sparkVel[i * 3] = normal.x * sp + rand(-2, 2);
      this.sparkVel[i * 3 + 1] = normal.y * sp + rand(0, 3);
      this.sparkVel[i * 3 + 2] = normal.z * sp + rand(-2, 2);
      this.sparkLife[i] = rand(0.25, hot ? 0.7 : 0.45);
    }
  }

  private muzzleFlash(pos: THREE.Vector3, strength: number): void {
    const l = this.muzzleLights[this.muzzleLightIdx]!;
    this.muzzleLightIdx = (this.muzzleLightIdx + 1) % this.muzzleLights.length;
    l.position.copy(pos);
    l.intensity = 22 * strength;
    const f = this.flashSprites[this.flashIdx]!;
    this.flashIdx = (this.flashIdx + 1) % this.flashSprites.length;
    f.life = 0.06;
    f.sprite.visible = true;
    f.sprite.position.copy(pos);
    f.sprite.scale.setScalar(0.55 * strength + Math.random() * 0.25);
    f.sprite.material.rotation = Math.random() * Math.PI;
  }

  private fire(sh: Shooter): void {
    const b = sh.body;
    b.showMuzzleFlash(0.05);
    const origin = this.tmpA;
    if (b.getMuzzlePose(this.tmpO, this.tmpD)) {
      origin.set(this.tmpO.x, this.tmpO.y, this.tmpO.z);
    } else {
      const c = b.chestPos(this.tmpO);
      origin.set(c.x, c.y + 0.12, c.z);
      this.tmpB.subVectors(sh.aim, origin).normalize();
      origin.addScaledVector(this.tmpB, 0.6);
    }
    // 着弾点: SWAT は人質を避けて入口の枠・壁へ制圧射撃、容疑者は車両へ乱射
    const target = this.tmpB;
    let hit: Tracer['hit'];
    if (sh.side === 'swat') {
      const r = Math.random();
      if (r < 0.5) {
        target.set((Math.random() < 0.5 ? -1 : 1) * rand(1.25, 2.4), rand(0.6, 3.2), -15.85);
        hit = 'wall';
      } else if (r < 0.75) {
        target.set(rand(-1.0, 1.4), rand(2.95, 3.5), -15.85);
        hit = 'wall';
      } else {
        target.set(rand(-9, 9), rand(4, 9), -15.9);
        hit = 'glass';
      }
    } else {
      const vehicles: [number, number, number][] = [
        [-4.6, 1.8, -3.6],
        [-5.6, 1.4, -4.0],
        [4.4, 1.0, -3.2],
      ];
      const v = vehicles[Math.floor(Math.random() * vehicles.length)]!;
      target.set(v[0] + rand(-1.8, 1.8), v[1] + rand(-0.5, 0.9), v[2] + rand(-0.4, 0.4));
      hit = 'metal';
    }
    const tr = this.tracers.find((x) => !x.live);
    if (tr) {
      tr.live = true;
      tr.from.copy(origin);
      tr.dir.subVectors(target, origin);
      tr.dist = tr.dir.length();
      tr.dir.divideScalar(tr.dist);
      tr.travelled = 0;
      tr.hit = hit;
      tr.mesh.visible = true;
      tr.mesh.position.copy(origin);
      tr.mesh.lookAt(target);
      tr.mesh.scale.set(1, 1, 0.01);
    }
    this.muzzleFlash(origin, sh.side === 'suspect' ? 1.2 : 0.9);
    if (Math.random() < 0.35) this.spawnSmoke(origin, 0.5, 1.6, 0.18, 0.35);
    const camDist = origin.distanceTo(this.camera.position);
    this.shake = Math.min(1, this.shake + 0.5 / Math.max(2, camDist * 0.4));
    this.flashPulse = Math.min(1, this.flashPulse + 0.35);
    if (sh.side === 'suspect') {
      // 人質がもがく
      this.hostageShake = 0.7;
    }
    this.onShot?.({ x: origin.x, y: origin.y, z: origin.z });
  }

  private impact(tr: Tracer): void {
    const p = this.tmpA.copy(tr.from).addScaledVector(tr.dir, tr.dist);
    const n = this.tmpB.copy(tr.dir).multiplyScalar(-1);
    if (tr.hit === 'wall') {
      n.set(0, 0.3, 1);
      this.spawnSparks(p, n, 7, false);
      if (Math.random() < 0.5) this.spawnSmoke(p.setZ(p.z + 0.2), 0.45, 1.2, 0.3, 0.2);
    } else if (tr.hit === 'glass') {
      n.set(0, -0.2, 1);
      this.spawnSparks(p, n, 5, false);
      const w = this.windows[Math.floor(Math.random() * this.windows.length)];
      if (w) w.flicker = Math.max(w.flicker, 9);
    } else if (tr.hit === 'metal') {
      this.spawnSparks(p, n.setY(Math.abs(n.y) + 0.5), 12, true);
    }
  }

  private portrait = false;

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.portrait = aspect < 1;
    // 縦長画面では少し引いて全体を収める
    this.camera.fov = aspect < 1 ? 58 : 33;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const tm = this.time;

    // 撃ち合い
    for (const sh of this.shooters) {
      if (sh.burst > 0) {
        sh.exposed = Math.min(1, sh.exposed + dt * 4);
        sh.shotGap -= dt;
        if (sh.exposed > 0.8 && sh.shotGap <= 0) {
          this.fire(sh);
          sh.burst--;
          sh.shotGap = sh.side === 'suspect' ? rand(0.07, 0.11) : rand(0.16, 0.42);
          if (sh.burst === 0) sh.wait = sh.side === 'suspect' ? rand(1.4, 3.2) : rand(1.0, 4.5);
        }
      } else {
        sh.exposed = Math.max(0, sh.exposed - dt * 2.5);
        sh.wait -= dt;
        if (sh.wait <= 0) {
          sh.burst = sh.side === 'suspect' ? Math.floor(rand(3, 8)) : Math.floor(rand(1, 4));
          sh.shotGap = 0.15;
        }
      }
      const e = sh.exposed;
      const b = sh.body;
      if (sh.side === 'swat') {
        b.setPose(e > 0.5 ? sh.firePose : sh.pose);
        b.setPosition(THREE.MathUtils.lerp(sh.homeX, sh.fireX, e), THREE.MathUtils.lerp(sh.homeZ, sh.fireZ, e), undefined, false);
        sh.aim.set(Math.sin(tm * 0.7 + sh.homeX) * 0.8, 1.5, -15);
      } else {
        // 人質の肩越しに身を乗り出して撃つ
        b.setPosition(THREE.MathUtils.lerp(sh.homeX, sh.fireX, e), sh.homeZ, undefined, false);
        sh.aim.set(Math.sin(tm * 0.9) * 6 - 1, 1.2, -2.5);
      }
      b.setLean(THREE.MathUtils.lerp(sh.coverLean, sh.fireLean, e));
      b.aimAt(sh.aim.x, sh.aim.y, sh.aim.z, dt, Math.PI);
      b.tick(dt);
    }
    // 人質: 震え・もがき
    this.hostageShake = Math.max(0, this.hostageShake - dt * 0.9);
    const shakeAmt = 0.03 + this.hostageShake * 0.12;
    this.hostage.setShake(Math.sin(tm * 23) * shakeAmt);
    this.hostage.setLean(Math.sin(tm * 1.7) * 0.25 + this.hostageShake * Math.sin(tm * 9) * 0.5);
    this.hostage.aimAt(Math.sin(tm * 0.6) * 3, 1.6, 0, dt);
    this.hostage.tick(dt);

    // 曳光弾
    for (const tr of this.tracers) {
      if (!tr.live) continue;
      tr.travelled += TRACER_SPEED * dt;
      if (tr.travelled >= tr.dist) {
        tr.live = false;
        tr.mesh.visible = false;
        this.impact(tr);
        continue;
      }
      const head = Math.min(tr.travelled, tr.dist);
      const len = Math.min(TRACER_LEN, head);
      tr.mesh.position.copy(tr.from).addScaledVector(tr.dir, head - len);
      tr.mesh.scale.set(1, 1, Math.max(0.01, len));
    }

    // 火花
    for (let i = 0; i < SPARK_MAX; i++) {
      const life = this.sparkLife[i]!;
      if (life <= 0) {
        this.sparkCol[i * 3] = this.sparkCol[i * 3 + 1] = this.sparkCol[i * 3 + 2] = 0;
        continue;
      }
      this.sparkLife[i] = life - dt;
      this.sparkVel[i * 3 + 1]! -= 9.8 * dt;
      this.sparkPos[i * 3]! += this.sparkVel[i * 3]! * dt;
      this.sparkPos[i * 3 + 1]! += this.sparkVel[i * 3 + 1]! * dt;
      this.sparkPos[i * 3 + 2]! += this.sparkVel[i * 3 + 2]! * dt;
      if (this.sparkPos[i * 3 + 1]! < 0.02) {
        this.sparkPos[i * 3 + 1] = 0.02;
        this.sparkVel[i * 3 + 1] = -this.sparkVel[i * 3 + 1]! * 0.3;
      }
      const k = Math.min(1, life * 2.5);
      this.sparkCol[i * 3] = 1.0 * k;
      this.sparkCol[i * 3 + 1] = 0.62 * k * k;
      this.sparkCol[i * 3 + 2] = 0.22 * k * k * k;
    }
    (this.sparkGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.sparkGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    // 煙
    for (const s of this.smokes) {
      if (!s.live) continue;
      s.life += dt;
      const k = s.life / s.maxLife;
      if (k >= 1) {
        s.live = false;
        s.sprite.visible = false;
        // 立ちこめる煙は循環させる
        if (s.maxLife > 5) this.spawnSmoke(this.tmpA.set(rand(-7, 7), rand(0.3, 1.2), rand(-13, -6)), rand(2.2, 3.6), rand(8, 14), 0.22, rand(0.05, 0.4));
        continue;
      }
      s.sprite.position.addScaledVector(s.vel, dt);
      s.sprite.scale.addScalar(s.grow * dt);
      const fadeIn = Math.min(1, k * 6);
      (s.sprite.material as THREE.SpriteMaterial).opacity = (s.sprite.userData.opacity as number) * fadeIn * (1 - k);
    }

    // 回転灯
    let tint = 0;
    for (const st of this.strobes) {
      const ph = (tm * st.rate + st.phase) % 4;
      // 2 回点滅して休む
      const on = (ph < 0.35 || (ph > 0.6 && ph < 0.95)) ? 1 : 0;
      st.light.intensity = on * 26;
      st.lens.opacity = on ? 1 : 0.25;
      tint += on * (st.color === 'red' ? 1 : -1);
    }
    this.strobeTint = THREE.MathUtils.clamp(tint / 4, -1, 1);

    for (const l of this.muzzleLights) l.intensity *= Math.exp(-dt * 38);
    for (const f of this.flashSprites) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) f.sprite.visible = false;
    }

    // 窓のちらつき（被弾・停電）
    for (const w of this.windows) {
      if (w.flicker > 0) {
        w.flicker = Math.max(0, w.flicker - dt * 3);
        w.mat.emissiveIntensity = w.base * (Math.random() < 0.5 ? 0.2 : 1.3);
      } else {
        w.mat.emissiveIntensity = w.base;
      }
    }

    // サーチライトは入口付近をゆっくり探る
    this.searchTarget.position.set(0.2 + Math.sin(tm * 0.35) * 1.6, 1.6 + Math.sin(tm * 0.53) * 0.5, -15);
    this.searchCone.lookAt(this.searchTarget.position);
    (this.searchCone.material as THREE.MeshBasicMaterial).opacity = 0.045 + Math.sin(tm * 7) * 0.005;

    // カメラ: 車両の陰から覗くような低いアングルで、ゆっくり横移動＋手ぶれ
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.flashPulse = Math.max(0, this.flashPulse - dt * 6);
    const sway = Math.sin(tm * 0.07) * 1.1;
    const sk = this.shake * 0.035;
    this.camera.position.set(
      this.camBase.x + sway + Math.sin(tm * 1.3) * 0.04 + rand(-sk, sk),
      this.camBase.y + Math.sin(tm * 0.9) * 0.05 + rand(-sk, sk),
      this.camBase.z + Math.cos(tm * 0.05) * 0.8,
    );
    // 縦長画面では下半分を操作パネルが覆うので、現場を画面上側へ寄せる
    this.camera.lookAt(this.camLook.x + sway * 0.2, this.portrait ? -2.6 : this.camLook.y, this.camLook.z);
  }

  dispose(): void {
    for (const sh of this.shooters) sh.body.dispose();
    this.hostage.dispose();
    for (const tex of this.textures) tex.dispose();
    this.scene.environment = null;
    disposeObject(this.scene);
  }
}

// ---------------------------------------------------------------------------
// 画面（DOM + 描画ループ）
// ---------------------------------------------------------------------------

const MODE_COLORS: Record<GameMode, string> = { swat: '#56c8d8', suspect: '#ff7b7b' };
const SIZE_COLOR = '#f2c14e';

export class TitleScreen {
  private readonly root = document.createElement('div');
  private readonly strobeEl = document.createElement('div');
  private readonly modeGrid = document.createElement('div');
  private readonly sizeGrid = document.createElement('div');
  private readonly startBtn = document.createElement('button');
  private readonly loadingEl = document.createElement('div');
  private readonly loadingText = document.createElement('div');
  private readonly tickerTrack = document.createElement('div');
  private readonly staticTexts: (() => void)[] = [];
  private readonly sceneView: StandoffScene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly audio: AudioEngine | null;
  private stages: readonly StageEntry[] = [];
  private stagesError: string | null = null;
  private mode: GameMode;
  private stageId: string | null;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private loading = false;
  private lastShotSound = 0;
  private soundStartedAt = -Infinity;
  private readonly unsubLocale: () => void;
  private readonly unsubSound: () => void;
  private readonly titleAudio = new TitleAudio();
  private readonly prevShadowEnabled: boolean;
  private readonly prevAutoUpdate: boolean;

  constructor(parent: HTMLElement, private readonly opts: TitleScreenOptions) {
    this.renderer = opts.renderer;
    this.audio = opts.audio;
    this.mode = opts.initialMode;
    this.stageId = opts.initialStageId;

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // 3D
    this.sceneView = new StandoffScene(opts.envTex);
    this.prevShadowEnabled = this.renderer.shadowMap.enabled;
    this.prevAutoUpdate = this.renderer.shadowMap.autoUpdate;
    const settings = getSettings();
    this.renderer.shadowMap.enabled = settings.shadowsEnabled;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.setRenderTarget(null);
    this.renderer.autoClear = true;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.domElement.style.display = 'block';
    this.onResize();
    window.addEventListener('resize', this.onResize);
    if (this.audio) {
      this.audio.setMasterVolume(settings.masterVolume);
      this.audio.setMuted(settings.muted);
      this.sceneView.onShot = (p) => this.playShot(p);
    }

    // DOM
    this.root.className = 'tts-root';
    const vignette = document.createElement('div');
    vignette.className = 'tts-vignette';
    this.strobeEl.className = 'tts-strobe';
    this.root.append(this.strobeEl, vignette);

    const top = document.createElement('div');
    top.className = 'tts-top';
    const live = document.createElement('div');
    live.className = 'tts-live';
    live.appendChild(document.createElement('i'));
    const liveText = document.createElement('span');
    live.appendChild(liveText);
    const topBtns = document.createElement('div');
    topBtns.className = 'tts-topbtns';
    const kofi = document.createElement('a');
    kofi.className = 'tts-btn tts-kofi';
    kofi.href = KOFI_URL;
    kofi.target = '_blank';
    kofi.rel = 'noopener noreferrer';
    const langBtn = document.createElement('button');
    langBtn.type = 'button';
    langBtn.className = 'tts-btn';
    langBtn.addEventListener('click', () => setLocale(getLocale() === 'en' ? 'ja' : 'en'));
    // サウンド: 自動再生制限のため最初は「クリックで音声 ON」と促し、鳴り始めたらミュート切替になる
    const soundBtn = document.createElement('button');
    soundBtn.type = 'button';
    soundBtn.className = 'tts-btn';
    soundBtn.dataset.action = 'sound';
    const renderSound = (): void => {
      const muted = getSettings().muted;
      if (!this.titleAudio.started) {
        soundBtn.textContent = t('🔈 クリックでサウンド ON', '🔈 Click for Sound');
        soundBtn.classList.add('tts-sound-hint');
      } else {
        soundBtn.textContent = muted ? t('🔇 ミュート中', '🔇 Muted') : t('🔊 サウンド', '🔊 Sound');
        soundBtn.classList.remove('tts-sound-hint');
      }
    };
    soundBtn.addEventListener('click', () => {
      // このクリック自体で鳴り始めた場合はミュートにしない。以降はミュート切替
      if (performance.now() - this.soundStartedAt < 600) return;
      updateSettings({ muted: !getSettings().muted });
    });
    this.titleAudio.onStarted = () => {
      this.soundStartedAt = performance.now();
      this.audio?.unlock();
      renderSound();
    };
    this.unsubSound = subscribeSettings((next, prev) => {
      if (next.muted !== prev.muted || next.language !== prev.language) renderSound();
      if (this.audio) {
        this.audio.setMuted(next.muted);
        this.audio.setMasterVolume(next.masterVolume);
      }
    });
    this.staticTexts.push(renderSound);
    topBtns.append(soundBtn, kofi, langBtn);
    top.append(live, topBtns);

    const hero = document.createElement('div');
    hero.className = 'tts-hero';
    const kicker = document.createElement('div');
    kicker.className = 'tts-kicker';
    const title = document.createElement('h1');
    title.className = 'tts-title';
    title.innerHTML = 'CQB <span>TACTICAL</span>';
    const sub = document.createElement('div');
    sub.className = 'tts-sub';
    hero.append(kicker, title, sub);

    const panel = document.createElement('div');
    panel.className = 'tts-panel';
    const modeStep = document.createElement('div');
    modeStep.className = 'tts-step';
    const modeTitle = document.createElement('div');
    modeTitle.className = 'tts-step-title';
    this.modeGrid.className = 'tts-choices';
    modeStep.append(modeTitle, this.modeGrid);
    const sizeStep = document.createElement('div');
    sizeStep.className = 'tts-step';
    const sizeTitle = document.createElement('div');
    sizeTitle.className = 'tts-step-title';
    this.sizeGrid.className = 'tts-choices';
    this.sizeGrid.style.gridTemplateColumns = 'repeat(3,minmax(0,1fr))';
    sizeStep.append(sizeTitle, this.sizeGrid);
    this.startBtn.type = 'button';
    this.startBtn.className = 'tts-start';
    this.startBtn.addEventListener('click', this.handleStart);
    panel.append(modeStep, sizeStep, this.startBtn);

    const ticker = document.createElement('div');
    ticker.className = 'tts-ticker';
    const tag = document.createElement('div');
    tag.className = 'tts-ticker-tag';
    this.tickerTrack.className = 'tts-ticker-track';
    ticker.append(tag, this.tickerTrack);

    this.loadingEl.className = 'tts-loading';
    const spinner = document.createElement('div');
    spinner.className = 'tts-spinner';
    this.loadingText.className = 'tts-loading-text';
    this.loadingEl.append(spinner, this.loadingText);

    this.root.append(top, hero, panel, ticker, this.loadingEl);
    parent.appendChild(this.root);

    const renderTexts = (): void => {
      liveText.textContent = t('LIVE — 立てこもり事件', 'LIVE — HOSTAGE STANDOFF');
      kofi.textContent = t('☕ Ko-fi で応援', '☕ Support on Ko-fi');
      langBtn.textContent = getLocale() === 'en' ? '🌐 日本語' : '🌐 English';
      kicker.textContent = t('近接戦闘 戦術シミュレーション', 'CLOSE QUARTERS BATTLE SIMULATOR');
      sub.textContent = t('人質を盾にした籠城犯を制圧せよ ― あるいは、籠城せよ', 'BREACH. CLEAR. SECURE. — OR HOLD THE LINE.');
      modeTitle.innerHTML = '';
      const b1 = document.createElement('b');
      b1.textContent = '1';
      modeTitle.append(b1, document.createTextNode(t('モード', 'MODE')));
      sizeTitle.innerHTML = '';
      const b2 = document.createElement('b');
      b2.textContent = '2';
      sizeTitle.append(b2, document.createTextNode(t('マップの広さ（選んだあとにランダム生成）', 'MAP SIZE (generated after you start)')));
      tag.textContent = t('速報', 'BREAKING');
      this.tickerTrack.textContent = t(
        '市内の金融機関で武装した男が人質をとって立てこもり　■　SWAT 部隊と装甲車が現場に到着、周辺道路を封鎖　■　容疑者は入口付近で人質を盾に発砲を続けている模様　■　警察は交渉による解決を模索しつつ突入の準備を進めている　■　付近の住民は屋内に退避してください',
        'Armed suspect holding hostages inside a downtown bank   ■   SWAT team and armored vehicle on scene, streets cordoned off   ■   Suspect reportedly firing from the entrance using a hostage as a shield   ■   Negotiators on standby as tactical units prepare to breach   ■   Residents are advised to stay indoors',
      );
      this.loadingText.textContent = t('マップ生成中…', 'GENERATING MAP…');
      this.renderModes();
      this.renderSizes();
      this.renderStartLabel();
      for (const f of this.staticTexts) if (f !== renderTexts) f();
    };
    this.staticTexts.push(renderTexts);
    renderTexts();
    this.unsubLocale = onLocaleChange(() => {
      if (!this.disposed) renderTexts();
    });

    this.loadStages();

    window.addEventListener('keydown', this.onKeyDown);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private loadStages(): void {
    this.stagesError = null;
    this.renderSizes();
    void this.opts.loadStages().then(
      (stages) => {
        if (this.disposed) return;
        this.stages = stages;
        if (!this.stageId || !stages.some((s) => s.id === this.stageId)) {
          // 既定は「中」。無ければ先頭
          this.stageId = (stages.find((s) => s.id === 'random_house') ?? stages[0])?.id ?? null;
        }
        this.renderSizes();
        this.renderStartLabel();
      },
      (err: unknown) => {
        if (this.disposed) return;
        console.error(err);
        this.stagesError = err instanceof Error ? err.message : String(err);
        this.renderSizes();
      },
    );
  }

  private renderModes(): void {
    this.modeGrid.innerHTML = '';
    const items: [GameMode, string, string][] = [
      ['swat', t('🛡 SWAT（突入側）', '🛡 SWAT (Assault)'), t('隊長として部隊を指揮し、人質を救出して容疑者を制圧', 'Lead your squad, rescue hostages, neutralize threats')],
      ['suspect', t('🔒 容疑者（籠城側）', '🔒 Suspect (Defend)'), t('立てこもり犯として突入してくる SWAT をしのぐ', 'Hold out against an incoming SWAT raid')],
    ];
    for (const [m, name, desc] of items) {
      this.modeGrid.appendChild(
        this.choice(m === this.mode, MODE_COLORS[m], name, desc, () => {
          this.mode = m;
          this.renderModes();
          this.renderStartLabel();
        }, (b) => (b.dataset.mode = m)),
      );
    }
  }

  private renderSizes(): void {
    this.sizeGrid.innerHTML = '';
    if (this.stages.length === 0) {
      this.sizeGrid.style.gridTemplateColumns = '1fr';
      const wait = document.createElement('div');
      wait.className = 'tts-choice-desc';
      if (this.stagesError === null) {
        wait.textContent = t('読み込み中…', 'Loading…');
        this.sizeGrid.appendChild(wait);
        return;
      }
      wait.textContent = t('マップ一覧を読み込めませんでした。通信状態を確認して再試行してください。', 'Could not load the map list. Check your connection and retry.');
      wait.style.color = '#ffb4b4';
      wait.title = this.stagesError;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'tts-btn';
      retry.dataset.action = 'retry-stages';
      retry.style.justifySelf = 'start';
      retry.textContent = t('↻ 再試行', '↻ Retry');
      retry.addEventListener('click', () => {
        if (!this.disposed) this.loadStages();
      });
      this.sizeGrid.append(wait, retry);
      return;
    }
    this.sizeGrid.style.gridTemplateColumns = `repeat(${Math.min(this.stages.length, 3)},minmax(0,1fr))`;
    for (const st of this.stages) {
      const active = st.id === this.stageId;
      const btn = this.choice(active, SIZE_COLOR, '', tStageTagline(st.id, st.tagline ?? st.description ?? ''), () => {
        this.stageId = st.id;
        this.renderSizes();
      }, (b) => (b.dataset.stageId = st.id));
      const head = btn.querySelector('.tts-choice-name');
      if (head) {
        head.textContent = '';
        const sz = document.createElement('span');
        sz.className = 'tts-size';
        sz.textContent = st.size ? tStageSize(st.id, st.size) : st.name;
        sz.style.color = active ? SIZE_COLOR : '#cfe0f0';
        head.appendChild(sz);
      }
      this.sizeGrid.appendChild(btn);
    }
  }

  private renderStartLabel(): void {
    this.startBtn.innerHTML = '';
    const main = document.createElement('span');
    main.textContent = this.mode === 'suspect' ? t('籠城開始', 'HOLD OUT') : t('出動', 'DEPLOY');
    const hint = document.createElement('small');
    hint.textContent = 'ENTER';
    this.startBtn.append(main, hint);
    this.startBtn.style.background =
      this.mode === 'suspect' ? 'linear-gradient(180deg,#ff9a9a,#e85858)' : 'linear-gradient(180deg,#ffe07a,#f2b630)';
    this.startBtn.disabled = this.loading || this.stages.length === 0;
  }

  private choice(
    active: boolean,
    color: string,
    name: string,
    desc: string,
    onSelect: () => void,
    decorate: (b: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tts-choice';
    b.style.setProperty('--c', color);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    const head = document.createElement('div');
    head.className = 'tts-choice-name';
    head.textContent = name;
    const d = document.createElement('div');
    d.className = 'tts-choice-desc';
    d.textContent = desc;
    b.append(head, d);
    decorate(b);
    b.addEventListener('click', () => {
      if (this.disposed || this.loading) return;
      this.audio?.unlock();
      onSelect();
    });
    b.addEventListener('dblclick', () => {
      if (this.disposed || this.loading) return;
      this.handleStart();
    });
    return b;
  }

  private playShot(p: Vec3): void {
    if (!this.audio?.isUnlocked) return;
    const now = performance.now();
    if (now - this.lastShotSound < 45) return;
    this.lastShotSound = now;
    this.audio.playGunshot(p, 60);
  }

  private readonly handleStart = (): void => {
    if (this.disposed || this.loading || !this.stageId) return;
    this.audio?.unlock();
    this.loading = true;
    this.loadingEl.classList.add('on');
    this.renderStartLabel();
    const mode = this.mode;
    const stageId = this.stageId;
    // 「生成中」を一度描画してから重いマップ生成に入る
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!this.disposed) this.opts.onStart(mode, stageId);
      }),
    );
  };

  /** 生成に失敗したときなど、選択画面へ戻す */
  cancelLoading(): void {
    this.loading = false;
    this.loadingEl.classList.remove('on');
    this.renderStartLabel();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || e.repeat) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      this.handleStart();
    }
  };

  private readonly onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.sceneView.setAspect(w / Math.max(1, h));
  };

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    this.sceneView.update(dt);
    if (this.audio) {
      const cam = this.sceneView.camera;
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      this.audio.updateListener(cam.position, fwd, cam.up);
      this.audio.update(dt);
    }
    const tint = this.sceneView.strobeTint;
    const pulse = this.sceneView.flashPulse;
    const a = Math.min(0.22, Math.abs(tint) * 0.14 + pulse * 0.06);
    this.strobeEl.style.opacity = String(a);
    this.strobeEl.style.background =
      pulse > Math.abs(tint) * 0.5
        ? 'radial-gradient(ellipse at 50% 55%,rgba(255,200,120,.9),rgba(255,200,120,0) 70%)'
        : tint > 0
          ? 'radial-gradient(ellipse at 20% 60%,rgba(255,30,30,.9),rgba(255,30,30,0) 65%)'
          : 'radial-gradient(ellipse at 80% 60%,rgba(40,90,255,.9),rgba(40,90,255,0) 65%)';
    this.renderer.render(this.sceneView.scene, this.sceneView.camera);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    this.unsubLocale();
    this.unsubSound();
    this.titleAudio.dispose();
    this.sceneView.onShot = null;
    this.sceneView.dispose();
    this.renderer.shadowMap.enabled = this.prevShadowEnabled;
    this.renderer.shadowMap.autoUpdate = this.prevAutoUpdate;
    this.root.remove();
  }
}
