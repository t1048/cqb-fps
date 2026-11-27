import * as THREE from 'three';
import type { EntityManager } from '../ai/EntityManager';
import type { Suspect } from '../ai/Suspect';
import { type ScoutContact, ScoutIntel } from '../ai/ScoutIntel';
import { SuspectState, type GameEventBus } from '../core/events';
import type { InputManager } from '../core/InputManager';
import { t } from '../core/i18n';
import type { OptiwandConfig, RoomDef } from '../core/types';
import type { Subtitle } from '../ui/Subtitle';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { Door, DoorSystem } from '../world/Door';
import type { Collider } from '../world/WorldBuilder';
import {
  FreeLook,
  WandSpotter,
  chooseWandViewMode,
  computeDoorPose,
  computeFreePose,
  contactCalloutText,
  doorEligible,
  rollNotices,
  type NoticeCandidate,
  type WandContactSource,
  type WandPose,
} from './optiwandGeometry';
import type { PlayerController } from './PlayerController';

const DEG2RAD = Math.PI / 180;
/** 発見の呼び出しをまとめる待ち時間（同時に見えた接触を 1 回で読み上げる） */
const CALLOUT_BATCH_SEC = 0.45;
/** 同じ容疑者に連続で気付かれる判定を行わないクールダウン */
const NOTICE_COOLDOWN_SEC = 4;
/** ドア下カメラを保持できる最大距離の余裕（m） */
const DOOR_HOLD_SLACK = 0.9;

const FRAME_CSS = `
.cqb-wand{position:fixed;display:none;z-index:6;pointer-events:none;box-sizing:border-box;border:2px solid rgba(160,255,190,.55);border-radius:6px;box-shadow:0 0 0 2px rgba(0,0,0,.6),0 6px 22px rgba(0,0,0,.6),inset 0 0 28px rgba(0,0,0,.55);overflow:hidden}
.cqb-wand .lbl{position:absolute;left:8px;top:5px;font:bold 11px monospace;letter-spacing:.12em;color:#9dffb8;text-shadow:0 0 4px #000}
.cqb-wand .rec{position:absolute;right:8px;top:5px;font:bold 11px monospace;color:#ff6a6a;text-shadow:0 0 4px #000}
.cqb-wand .hint{position:absolute;left:8px;bottom:5px;font:11px monospace;color:rgba(200,255,215,.85);text-shadow:0 0 4px #000}
.cqb-wand .dep{position:absolute;inset:0;background:#000;transition:opacity .1s}
.cqb-wand-hint{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);display:none;z-index:5;pointer-events:none;max-width:min(560px,44vw);padding:5px 12px;border-radius:4px;background:rgba(8,18,12,.74);border:1px solid rgba(160,255,190,.4);color:#c9ffd8;font:bold 13px/1.45 sans-serif;text-align:center}
`;
/** 前方（角越し）カメラのピッチ上下限（度） */
const FREE_PITCH_LIMIT_DEG = 60;

const VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** 魚眼歪み・色収差・粒状ノイズ・ビネット・走査線・緑がかった色調で「ファイバースコープ映像」に見せる。 */
const FRAG = `
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float time;
uniform float gain;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  vec2 q = p * (1.0 + 0.24 * r2);
  vec2 uv = q * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 c;
  c.r = texture2D(tDiffuse, uv + p * 0.004).r;
  c.g = texture2D(tDiffuse, uv).g;
  c.b = texture2D(tDiffuse, uv - p * 0.004).b;
  c *= gain;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, 0.6) * vec3(0.86, 1.06, 0.9);
  float g = hash(uv * vec2(320.0, 240.0) + fract(time) * 17.0);
  c += (g - 0.5) * 0.10;
  c *= 0.93 + 0.07 * sin(uv.y * 240.0 * 3.14159);
  c *= 1.0 - smoothstep(0.55, 1.25, length(p));
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** RoomDef 内の点か（床高さ ±0.75m、水平は矩形内）。 */
export function roomAtPoint(rooms: readonly RoomDef[], x: number, z: number, y: number): RoomDef | null {
  for (const r of rooms) {
    if (Math.abs((r.floorY ?? 0) - y) > 0.75) continue;
    if (Math.abs(x - r.x) <= r.width / 2 && Math.abs(z - r.z) <= r.depth / 2) return r;
  }
  return null;
}

export interface OptiwandDeps {
  player: PlayerController;
  input: InputManager;
  colliders: readonly Collider[];
  cfg: OptiwandConfig;
  /** ドア板の厚み(m)（doors.json thickness） */
  doorThickness: number;
  doors: DoorSystem;
  entities: EntityManager;
  rooms: readonly RoomDef[];
  intel: ScoutIntel;
  bus: GameEventBus;
  subtitle: Subtitle;
  weapons: WeaponSystem;
  host: HTMLElement;
  /** 先端カメラの描画時だけ非表示にするオブジェクト（プレイヤーの体など） */
  hideDuringRender?: THREE.Object3D[];
}

/**
 * オプティワンド（細い先端カメラ）。ホイール押し込み（中クリック）またはキー 4 で構える。
 * 構えただけではカメラ映像（PiP）は出ない。左クリックを押している間だけ先端を伸ばして映像を表示し、離すと収納する。
 * 伸ばしている間は移動・視点（マウスはカメラの首振り）・しゃがみ切替を固定する。
 * - しゃがみ + ドアの前（狙って約 1.5m 以内）で伸ばすと、先端がドアの向こう側の床すれすれへ回り込む。
 * - それ以外（立ち・ドア以外）は目線（リーン込み）から前方 reach の位置（壁で止まる）に先端を出し、角越しに覗ける。
 *   向きは伸ばし始めた時点のプレイヤーの向きで、マウスで首振りする。
 * - 映った容疑者・民間人は ScoutIntel に登録し、部屋を「確認済み」にして隊と共有する。
 * - 気付かれる確率あり（正面を向く容疑者が近いとき）。
 * 描画は低解像度の RenderTarget に先端カメラでシーンを描き、魚眼/ノイズのシェーダで画面隅へ合成する。
 */
export class Optiwand {
  readonly camera: THREE.PerspectiveCamera;
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quadMat: THREE.ShaderMaterial;
  private readonly quadGeo: THREE.PlaneGeometry;
  private readonly frame = document.createElement('div');
  private readonly styleEl = document.createElement('style');
  private readonly depEl = document.createElement('div');
  private readonly hintEl = document.createElement('div');
  private readonly spotter = new WandSpotter();
  private readonly eyeTmp = new THREE.Vector3();
  private readonly eyeScratch = new THREE.Vector3();
  private readonly vpTmp = new THREE.Vector4();
  private readonly scTmp = new THREE.Vector4();
  private readonly sizeTmp = new THREE.Vector2();

  private readonly freeLook: FreeLook;
  private readonly hudHint = document.createElement('div');

  private equippedFlag = false;
  private deployT = 0;
  /** 左クリック長押しでカメラを伸ばしている間 true */
  private viewingFlag = false;
  /** 伸ばし始めてからの経過（映像のフェードイン用） */
  private extendT = 0;
  private lockedDoor: Door | null = null;
  private yawOff = 0;
  private pitch = 5 * DEG2RAD;
  private pose: WandPose | null = null;
  private time = 0;
  private readonly dwell = new Map<string, number>();
  private readonly noticeCd = new Map<string, number>();
  private batch: { armed: number; unarmed: number; civilians: number; timer: number; roomId: string | null } | null = null;
  private disposed = false;

  constructor(private readonly d: OptiwandDeps) {
    const [rw, rh] = d.cfg.renderSize;
    this.camera = new THREE.PerspectiveCamera(d.cfg.fovDeg, rw / rh, 0.03, 60);
    this.camera.rotation.order = 'YXZ';
    this.freeLook = new FreeLook(
      d.cfg.yawLimitDeg * DEG2RAD,
      -FREE_PITCH_LIMIT_DEG * DEG2RAD,
      FREE_PITCH_LIMIT_DEG * DEG2RAD,
    );
    // 低照度のドア下映像でバンディングしないよう半精度浮動小数（トーンマップは合成パスで掛ける）
    this.rt = new THREE.WebGLRenderTarget(rw, rh, { depthBuffer: true, samples: 0, type: THREE.HalfFloatType });
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;
    this.rt.texture.generateMipmaps = false;
    this.quadMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { tDiffuse: { value: this.rt.texture }, time: { value: 0 }, gain: { value: 1.25 } },
      depthTest: false,
      depthWrite: false,
    });
    this.quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quadScene.add(new THREE.Mesh(this.quadGeo, this.quadMat));

    this.styleEl.textContent = FRAME_CSS;
    document.head.appendChild(this.styleEl);
    this.frame.className = 'cqb-wand';
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = 'OPTIWAND';
    const rec = document.createElement('div');
    rec.className = 'rec';
    rec.textContent = '● REC';
    this.hintEl.className = 'hint';
    this.depEl.className = 'dep';
    this.frame.append(lbl, rec, this.hintEl, this.depEl);
    d.host.appendChild(this.frame);
    this.hudHint.className = 'cqb-wand-hint';
    d.host.appendChild(this.hudHint);
  }

  get equipped(): boolean {
    return this.equippedFlag;
  }

  /** 左クリック長押しでカメラを伸ばしている（映像表示中・移動/視点固定）か */
  get viewing(): boolean {
    return this.equippedFlag && this.viewingFlag;
  }

  /** 伸ばし切って映像が出ているか */
  get active(): boolean {
    return this.viewing && this.extendT >= this.d.cfg.deploySec;
  }

  /** ドア下カメラモードか（視点固定・移動不可） */
  get underDoor(): boolean {
    return this.viewing && this.lockedDoor !== null;
  }

  get currentPose(): WandPose | null {
    return this.pose;
  }

  toolLabel(): string | null {
    return this.equippedFlag ? t('オプティワンド', 'Optiwand') : null;
  }

  setEquipped(on: boolean): void {
    if (on === this.equippedFlag) return;
    this.equippedFlag = on;
    this.d.weapons.externalFireBlock = on;
    if (on) {
      this.deployT = 0;
      this.pitch = 5 * DEG2RAD;
      this.yawOff = 0;
      this.spotter.reset();
      this.dwell.clear();
      this.d.subtitle.show(t('オプティワンド展開', 'Optiwand deployed'), 0.9);
    } else {
      this.stopView();
      this.batch = null;
      this.hudHint.style.display = 'none';
    }
  }

  private releaseDoor(): void {
    this.lockedDoor = null;
    this.d.player.lookSink = null;
  }

  /** 左クリック長押し開始: ドア下（しゃがみ + ドア前）か前方（角越し）かを決めて先端を伸ばす。 */
  private startView(eye: THREE.Vector3): void {
    const { player, cfg } = this.d;
    const aimed = this.d.doors.aimed(cfg.doorRange + 0.3) ?? this.doorInFront(eye);
    const mode = chooseWandViewMode(player.isCrouching, aimed, eye, cfg);
    this.viewingFlag = true;
    this.extendT = 0;
    this.spotter.reset();
    this.dwell.clear();
    player.stanceLocked = true;
    if (mode === 'door' && aimed) {
      this.lockedDoor = aimed;
      this.yawOff = 0;
      this.pitch = 6 * DEG2RAD;
      player.lookSink = (dx, dy) => {
        this.yawOff -= dx;
        this.pitch -= dy;
        const lim = cfg.yawLimitDeg * DEG2RAD;
        this.yawOff = Math.max(-lim, Math.min(lim, this.yawOff));
        this.pitch = Math.max(cfg.pitchLimitDeg[0] * DEG2RAD, Math.min(cfg.pitchLimitDeg[1] * DEG2RAD, this.pitch));
      };
      this.d.subtitle.show(t('ドア下カメラ: マウスで首振り', 'Under-door cam: mouse to pan'), 1.4);
    } else {
      this.lockedDoor = null;
      this.freeLook.start(player.yawRad, player.pitchRad);
      player.lookSink = (dx, dy) => this.freeLook.pan(dx, dy);
    }
  }

  /**
   * 照準がドアの合わせ目・枠に外れていても、目の前（正面・戸幅内・doorRange 以内）の閉じたドアを対象にする。
   * 両開きドアの中央など、狙いにくい位置でもドア下を覗けるようにする。
   */
  private doorInFront(eye: THREE.Vector3): Door | null {
    const { player, cfg } = this.d;
    const fx = -Math.sin(player.yawRad);
    const fz = -Math.cos(player.yawRad);
    let best: Door | null = null;
    let bestD = Infinity;
    for (const door of this.d.doors.doors) {
      if (!doorEligible(door, eye, cfg)) continue;
      const rx = door.centerX - eye.x;
      const rz = door.centerZ - eye.z;
      const depth = Math.abs(rx * door.normalX + rz * door.normalZ); // ドア面までの距離
      const lateral = Math.abs(rx * door.axisX + rz * door.axisZ); // 戸幅方向のずれ
      if (depth > cfg.doorRange || lateral > door.width * 0.5) continue;
      // 正面を向いていること（ドア中心方向と、ドア面に対して 60° 以内）
      const dist = Math.hypot(rx, rz) || 1;
      if ((fx * rx + fz * rz) / dist < 0.5 || Math.abs(fx * door.normalX + fz * door.normalZ) < 0.5) continue;
      if (depth < bestD) {
        bestD = depth;
        best = door;
      }
    }
    return best;
  }

  /** 伸ばしていたカメラを収納し、移動・視点・しゃがみ切替を元に戻す。 */
  private stopView(): void {
    this.viewingFlag = false;
    this.releaseDoor();
    this.pose = null;
    this.frame.style.display = 'none';
    this.d.player.externalMoveScale = 1;
    this.d.player.stanceLocked = false;
  }

  update(rawDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, 0.05);
    const { input, player, cfg } = this.d;
    this.time += dt;
    if (!player.alive) {
      if (this.equippedFlag) this.setEquipped(false);
      return;
    }
    if (!input.isOrderMenuOpen) {
      if (input.wasPressed('slot4') || input.wasMousePressed(1)) this.setEquipped(!this.equippedFlag);
      else if (
        this.equippedFlag &&
        (input.wasPressed('slot1') || input.wasPressed('slot2') || input.wasPressed('slot3'))
      ) {
        this.setEquipped(false);
      }
    }
    for (const [id, left] of this.noticeCd) {
      if (left - dt <= 0) this.noticeCd.delete(id);
      else this.noticeCd.set(id, left - dt);
    }
    if (!this.equippedFlag) return;

    this.deployT = Math.min(cfg.deploySec, this.deployT + dt);
    const eye = player.getEyePosition(this.eyeTmp);

    // 左クリック長押しの間だけカメラを伸ばす（構え切り替えの展開が終わってから）
    const wantView = input.isPointerLocked && input.isMouseDown(0) && !input.isOrderMenuOpen;
    if (this.viewingFlag && !wantView) this.stopView();
    else if (!this.viewingFlag && wantView && this.deployT >= cfg.deploySec) this.startView(eye);

    if (!this.viewingFlag) {
      this.updateHint(false);
      return;
    }

    // ドア下カメラが使えなくなったら（ドアが開いた・離れた）収納する
    if (this.lockedDoor) {
      const door = this.lockedDoor;
      const dist = Math.hypot(eye.x - door.centerX, eye.z - door.centerZ);
      if (!doorEligible(door, eye, cfg) || dist > cfg.doorRange + door.width * 0.5 + DOOR_HOLD_SLACK) {
        this.stopView();
        this.updateHint(false);
        return;
      }
    }
    this.extendT = Math.min(cfg.deploySec, this.extendT + dt);

    this.pose = this.lockedDoor
      ? computeDoorPose(this.lockedDoor, eye, cfg, this.d.doorThickness, this.yawOff, this.pitch)
      : computeFreePose(eye, this.freeLook.yaw, this.freeLook.pitch, this.d.colliders, cfg);
    player.externalMoveScale = 0;

    const p = this.pose;
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.rotation.set(p.pitch, p.yaw, 0);
    this.camera.updateMatrixWorld(true);

    this.hintEl.textContent = this.lockedDoor
      ? t('マウス: 首振り / 離す: 収納', 'Mouse: Pan / Release: Retract')
      : t('マウス: 首振り / 離す: 収納（Q/E: リーン）', 'Mouse: Pan / Release: Retract (Q/E: Lean)');
    this.depEl.style.opacity = String(1 - this.extendT / Math.max(0.001, cfg.deploySec));
    this.updateHint(true);

    if (!this.active) return;
    this.updateSpotting(dt, p);
    this.updateNotices(dt, p);
    this.updateBatch(dt);
  }

  /** 画面下部の操作ヒント（構え中のみ）。 */
  private updateHint(viewing: boolean): void {
    if (!this.equippedFlag) {
      this.hudHint.style.display = 'none';
      return;
    }
    this.hudHint.textContent = viewing
      ? t('ワンド展開中: マウスで首振り / 左クリックを離すと収納', 'Wand out: mouse to pan / release LMB to retract')
      : t(
          '左クリック長押し: カメラ / しゃがみ+ドア前: ドア下 / 中クリック・4: 武器に戻す',
          'Hold LMB: camera / Crouch at door: under-door / MMB or 4: switch back',
        );
    this.hudHint.style.display = 'block';
  }

  private collectSources(): WandContactSource[] {
    const out: WandContactSource[] = [];
    const chest = { x: 0, y: 0, z: 0 };
    for (const [id, s] of this.d.entities.suspects) {
      if (s.friendly || s.state === SuspectState.DOWN || s.state === SuspectState.ARRESTED) continue;
      const c = s.body.chestPos(chest);
      const e = s.body.eye(this.eyeScratch);
      out.push({
        id,
        kind: 'suspect',
        armed: s.state !== SuspectState.SURRENDER,
        chest: { x: c.x, y: c.y, z: c.z },
        eye: { x: e.x, y: e.y, z: e.z },
      });
    }
    for (const [id, c] of this.d.entities.civilians) {
      if (!c.alive || c.evacuated) continue;
      const ch = c.body.chestPos(chest);
      const e = c.body.eye(this.eyeScratch);
      out.push({
        id,
        kind: 'civilian',
        armed: false,
        chest: { x: ch.x, y: ch.y, z: ch.z },
        eye: { x: e.x, y: e.y, z: e.z },
      });
    }
    return out;
  }

  private toContact(c: WandContactSource): ScoutContact {
    return { id: c.id, kind: c.kind, armed: c.armed, x: c.chest.x, y: c.chest.y - 1.2, z: c.chest.z, time: this.time };
  }

  private updateSpotting(dt: number, pose: WandPose): void {
    const { cfg, intel, rooms, colliders } = this.d;
    const aspect = this.camera.aspect;
    const { visible, fresh } = this.spotter.update(dt, pose, cfg, aspect, this.collectSources(), colliders);

    // 一度「発見」した対象は、見えている間は位置・武装状態を更新し続ける
    for (const c of visible) {
      if (!this.spotter.hasSpotted(c.id)) continue;
      const room = roomAtPoint(rooms, c.chest.x, c.chest.z, c.chest.y - 1.2);
      if (room) intel.reportContact(room.id, this.toContact(c), 'player');
    }
    for (const c of fresh) {
      const room = roomAtPoint(rooms, c.chest.x, c.chest.z, c.chest.y - 1.2);
      if (room) intel.reportContact(room.id, this.toContact(c), 'player');
      if (!this.batch) this.batch = { armed: 0, unarmed: 0, civilians: 0, timer: CALLOUT_BATCH_SEC, roomId: room?.id ?? null };
      if (c.kind === 'civilian') this.batch.civilians++;
      else if (c.armed) this.batch.armed++;
      else this.batch.unarmed++;
    }

    // 部屋の滞在（人物が映らなくても、しばらく見渡せば「確認済み・空」になる）
    const fx = pose.mode === 'door' ? pose.farX : -Math.sin(pose.yaw);
    const fz = pose.mode === 'door' ? pose.farZ : -Math.cos(pose.yaw);
    const view = roomAtPoint(rooms, pose.x + fx * 1.0, pose.z + fz * 1.0, this.d.player.position.y + (pose.mode === 'door' ? 0 : 0));
    const viewRoom = view ?? roomAtPoint(rooms, pose.x, pose.z, this.d.player.position.y);
    if (viewRoom && !intel.isScouted(viewRoom.id)) {
      const total = (this.dwell.get(viewRoom.id) ?? 0) + dt;
      this.dwell.set(viewRoom.id, total);
      if (total >= cfg.scoutDwellSec) {
        intel.markScouted(viewRoom.id, 'player');
        if (!this.batch && intel.contactsIn(viewRoom.id).length === 0) {
          this.batch = { armed: 0, unarmed: 0, civilians: 0, timer: 0.05, roomId: viewRoom.id };
        }
      }
    }
  }

  private updateNotices(dt: number, pose: WandPose): void {
    const cands: NoticeCandidate[] = [];
    const sus = new Map<string, Suspect>();
    for (const [id, s] of this.d.entities.suspects) {
      if (s.friendly || !s.canPerceive || this.noticeCd.has(id)) continue;
      cands.push({ id, x: s.body.px, y: s.body.footY, z: s.body.pz, eyeY: s.body.footY + 1.5, yawRad: s.body.yawRad });
      sus.set(id, s);
    }
    if (cands.length === 0) return;
    const hits = rollNotices(dt, pose, cands, this.d.cfg, pose.mode === 'door', this.d.colliders);
    for (const id of hits) {
      const s = sus.get(id);
      if (!s) continue;
      this.noticeCd.set(id, NOTICE_COOLDOWN_SEC);
      s.onHeardNoise({ x: pose.x, y: this.d.player.position.y, z: pose.z }, 'door', 'player');
      this.d.subtitle.show(t('ワンドに気付かれた！', 'Wand compromised!'), 1.6);
    }
  }

  private updateBatch(dt: number): void {
    const b = this.batch;
    if (!b) return;
    b.timer -= dt;
    if (b.timer > 0) return;
    this.batch = null;
    const text = contactCalloutText(b.armed, b.unarmed, b.civilians, t);
    this.d.subtitle.show(text, 3.2);
    this.d.bus.emit('scoutReport', {
      roomId: b.roomId,
      suspects: b.armed + b.unarmed,
      armed: b.armed,
      civilians: b.civilians,
      source: 'player',
    });
  }

  /** メイン描画後に PiP を描く。非展開時は何もしない（低コスト）。 */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    if (this.disposed || !this.equippedFlag || !this.viewingFlag || !this.pose) return;
    const hide = this.d.hideDuringRender ?? [];
    const prevVis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;

    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.setRenderTarget(this.rt);
    renderer.autoClear = true;
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prevRT);
    hide.forEach((o, i) => (o.visible = prevVis[i]!));

    renderer.getSize(this.sizeTmp);
    const w = Math.min(360, Math.round(this.sizeTmp.x * this.d.cfg.viewWidthRatio));
    const h = Math.round((w * this.rt.height) / this.rt.width);
    // 左上のミニマップ・右上の目標パネルと重ならないよう上端中央に置く
    const left = Math.max(16, Math.round((this.sizeTmp.x - w) / 2));
    const top = 16;
    this.frame.style.display = 'block';
    this.frame.style.left = `${left}px`;
    this.frame.style.top = `${top}px`;
    this.frame.style.width = `${w}px`;
    this.frame.style.height = `${h}px`;

    renderer.getViewport(this.vpTmp);
    renderer.getScissor(this.scTmp);
    const prevScissorTest = renderer.getScissorTest();
    const y = this.sizeTmp.y - top - h;
    renderer.setViewport(left, y, w, h);
    renderer.setScissor(left, y, w, h);
    renderer.setScissorTest(true);
    renderer.autoClear = false;
    this.quadMat.uniforms.time!.value = this.time;
    renderer.render(this.quadScene, this.quadCam);
    renderer.setScissorTest(prevScissorTest);
    renderer.setViewport(this.vpTmp);
    renderer.setScissor(this.scTmp);
    renderer.autoClear = prevAuto;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseDoor();
    this.d.player.externalMoveScale = 1;
    this.d.player.stanceLocked = false;
    this.d.weapons.externalFireBlock = false;
    this.rt.dispose();
    this.quadMat.dispose();
    this.quadGeo.dispose();
    this.frame.remove();
    this.hudHint.remove();
    this.styleEl.remove();
    this.spotter.reset();
    this.dwell.clear();
    this.noticeCd.clear();
  }
}
