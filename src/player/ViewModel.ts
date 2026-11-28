import * as THREE from 'three';
import type { TextureLibrary } from '../world/Materials';

const MAX_DT = 0.05;

export interface OptiwandViewState {
  /** 先端の伸縮進捗 0..1 */
  extend: number;
  /** ドア下カメラモード中か */
  underDoor: boolean;
  /** 先端カメラの左右首振り角（rad） */
  panYaw: number;
  /** 先端カメラの上下角（rad） */
  panPitch: number;
}

/** インタラクト時の左手アニメーション種別 */
export type InteractAnimKind = 'heal' | 'lock' | 'trap' | 'barricade' | 'restrain' | 'surrender' | 'doorTap';

/** 一人称装備専用のカメラとモデル。装備 ID で部品構成を切り替える。 */
export class ViewModel {
  readonly root = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.02, 4);
  private readonly holder = new THREE.Group();
  /** 銃本体（リロード時に傾ける） */
  private readonly gun = new THREE.Group();
  /** 弾倉（抜いて差し替える）。弾倉のない装備では空のまま */
  private readonly mag = new THREE.Group();
  /** 左手（リロード時だけ弾倉を持って現れる）。mag の子なので弾倉に追従する */
  private readonly offHand = new THREE.Group();
  /** インタラクト時の左手アニメーション用グループ（武器切替の影響を受けない） */
  private readonly interactGroup = new THREE.Group();
  private readonly interactMedkit = new THREE.Group();
  private readonly interactTool = new THREE.Group();
  private readonly interactGeos: THREE.BufferGeometry[] = [];
  private readonly interactMats: THREE.Material[] = [];
  private interactBlend = 0;
  private interactPhase = 0;
  private lastInteractKind: InteractAnimKind = 'lock';
  private interactPulseLeft = 0;
  private interactPulseKind: InteractAnimKind = 'doorTap';
  /** ドア蹴りアニメーション用の右脚＋コンバットブーツ */
  private readonly kickGroup = new THREE.Group();
  private readonly kickGeos: THREE.BufferGeometry[] = [];
  private readonly kickMats: THREE.Material[] = [];
  private doorKickActive = false;
  private doorKickT = 0;
  private doorKickDuration = 0.65;
  /** オプティワンドの伸縮ロッド部 */
  private readonly wandShaft = new THREE.Group();
  /** オプティワンドの先端カメラヘッド（首振り追従） */
  private readonly wandHead = new THREE.Group();
  private wandScreenMat: THREE.MeshBasicMaterial | null = null;
  private wandLedMat: THREE.MeshBasicMaterial | null = null;
  private readonly magRest = new THREE.Vector3();
  private hasMag = false;
  /** 抜き差し方向（弾倉の向き。拳銃はグリップ角に合わせる） */
  private readonly magAxis = new THREE.Vector3(0, -1, 0);
  private parent: THREE.Object3D = this.gun;
  private kickZ = 0;
  private kickPitch = 0;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private style = '';
  get hasMagazine(): boolean {
    return this.hasMag;
  }
  private bob = 0;
  private disposed = false;

  constructor(private readonly textures: TextureLibrary) {
    this.root.name = 'viewmodel';
    this.root.add(this.holder, this.interactGroup, this.kickGroup);
    this.holder.add(this.gun);
    this.buildInteractHand();
    this.interactGroup.visible = false;
    this.buildKickLeg();
    this.kickGroup.visible = false;
    this.rebuild('rifle');
  }

  /** ドア開閉タップなど単発インタラクトの短い手アニメーションを発火する。 */
  triggerInteractPulse(kind: InteractAnimKind, durationSec = 0.32): void {
    this.interactPulseKind = kind;
    this.interactPulseLeft = Math.max(this.interactPulseLeft, durationSec);
  }

  /** ドアを蹴る一人称の足アニメーションを再生する。 */
  triggerDoorKick(durationSec = 0.65): void {
    this.doorKickDuration = Math.max(0.2, durationSec);
    this.doorKickT = 0;
    this.doorKickActive = true;
  }

  setStyle(style: string): void {
    if (style === this.style) return;
    this.rebuild(style);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 発射時の小さな跳ね上がり（視点の反動とは別に、銃そのものを後退・上向きに）。 */
  kick(strength = 1): void {
    this.kickZ = Math.min(0.05, this.kickZ + 0.018 * strength);
    this.kickPitch = Math.min(0.12, this.kickPitch + 0.035 * strength);
  }

  /**
   * @param reload リロード進捗 0..1（リロード中でなければ null）
   * @param emptyReload 弾切れからのリロード（最後にチャージングハンドルを引く）
   * @param wand オプティワンド構え中の伸縮・首振り状態
   * @param interact 実行中のインタラクト種別（施錠・罠解除・回復・拘束など）
   */
  update(
    rawDt: number,
    moving: boolean,
    reload: number | null = null,
    emptyReload = false,
    wand: OptiwandViewState | null = null,
    interact: InteractAnimKind | null = null,
  ): void {
    if (this.disposed) return;
    const dt = Math.min(rawDt, MAX_DT);
    const reloading = reload !== null;
    this.bob += dt * (moving ? 8 : 2) * (reloading ? 0.5 : 1);
    const amp = (moving ? 0.007 : 0.002) * (reloading ? 0.5 : 1);
    const sway = Math.sin(this.bob) * amp;
    const bobY = Math.cos(this.bob * 2) * amp;
    const hipOffset = 0.145 * Math.min(1, this.camera.aspect);
    const decay = Math.exp(-dt * 18);
    this.kickZ *= decay;
    this.kickPitch *= decay;
    this.holder.position.set(hipOffset + sway, -0.165 + bobY, -0.43 + this.kickZ);
    this.holder.rotation.set(0.03 + this.kickPitch, -0.04, -0.02);
    this.animateReload(reload ?? -1, emptyReload);
    if (this.style === 'optiwand') this.animateOptiwand(wand);
    this.animateInteract(dt, interact);
    this.animateDoorKick(dt);
  }

  private animateDoorKick(dt: number): void {
    if (!this.doorKickActive) {
      this.kickGroup.visible = false;
      return;
    }
    this.doorKickT += dt;
    if (this.doorKickT >= this.doorKickDuration) {
      this.doorKickActive = false;
      this.kickGroup.visible = false;
      return;
    }
    const p = this.doorKickT / this.doorKickDuration;
    this.kickGroup.visible = true;

    let x = 0.05;
    let y = -0.62;
    let z = -0.18;
    let rx = 0.55;
    let ry = 0.06;
    let rz = -0.06;
    let sway = 0;

    if (p < 0.2) {
      // 溜め: 膝を引き上げる
      const k = smooth(p / 0.2);
      x = 0.07 - k * 0.02;
      y = -0.62 + k * 0.34;
      z = -0.18 - k * 0.08;
      rx = 0.45 + k * 0.3;
      sway = k * 0.6;
    } else if (p < 0.34) {
      // 蹴り出し: ブーツ底を正面のドアへ一気に突き出す（p≈0.31 で着弾）
      const k = smooth((p - 0.2) / 0.14);
      x = 0.05 - k * 0.04;
      y = -0.28 + k * 0.11;
      z = -0.26 - k * 0.32;
      rx = 0.75 + k * 0.58;
      ry = 0.06 - k * 0.08;
      rz = -0.06 - k * 0.06;
      sway = 0.6 + k * 0.4;
    } else if (p < 0.5) {
      // 衝撃の反動でわずかに跳ね返る
      const k = smooth((p - 0.34) / 0.16);
      x = 0.01 + k * 0.02;
      y = -0.17 - k * 0.03;
      z = -0.58 + k * 0.07;
      rx = 1.33 - k * 0.12;
      ry = -0.02 + k * 0.04;
      rz = -0.12 + k * 0.04;
      sway = 1 - k * 0.25;
    } else {
      // 引き戻し: 足を下ろして体勢を戻す
      const k = smooth((p - 0.5) / 0.5);
      x = 0.03 + k * 0.05;
      y = -0.20 - k * 0.45;
      z = -0.51 + k * 0.35;
      rx = 1.21 - k * 0.8;
      ry = 0.02;
      rz = -0.08 + k * 0.06;
      sway = (1 - k) * 0.75;
    }

    this.kickGroup.position.set(x, y, z);
    this.kickGroup.rotation.set(rx, ry, rz);

    // 蹴りの反動に合わせて右手の装備もバランスを取るようにわずかに引く
    this.holder.position.x += 0.04 * sway;
    this.holder.position.y -= 0.045 * sway;
    this.holder.position.z += 0.035 * sway;
    this.holder.rotation.x += 0.08 * sway;
    this.holder.rotation.z -= 0.12 * sway;
  }

  private animateInteract(dt: number, interact: InteractAnimKind | null): void {
    if (this.interactPulseLeft > 0) this.interactPulseLeft = Math.max(0, this.interactPulseLeft - dt);
    const activeKind = interact ?? (this.interactPulseLeft > 0 ? this.interactPulseKind : null);
    if (activeKind) {
      this.lastInteractKind = activeKind;
      this.interactBlend = Math.min(1, this.interactBlend + dt * 11);
      this.interactPhase += dt;
    } else {
      this.interactBlend = Math.max(0, this.interactBlend - dt * 9);
      if (this.interactBlend === 0) this.interactPhase = 0;
    }

    const b = smooth(this.interactBlend);
    if (b <= 0.002) {
      this.interactGroup.visible = false;
      return;
    }

    const kind = this.lastInteractKind;
    const t = this.interactPhase;
    this.interactGroup.visible = true;
    this.interactMedkit.visible = kind === 'heal';
    this.interactTool.visible = kind === 'lock' || kind === 'trap';

    // 作業中は右手の武器を少し下げて避ける
    const dipMul = kind === 'heal' || kind === 'surrender' ? 1.5 : kind === 'doorTap' ? 0.35 : 1;
    this.holder.position.x += 0.045 * b * dipMul;
    this.holder.position.y -= 0.075 * b * dipMul;
    this.holder.rotation.x -= 0.22 * b * dipMul;
    this.holder.rotation.z -= 0.12 * b * dipMul;

    // 画面左下（待機）→ 作業位置へ補間
    const restX = -0.32;
    const restY = -0.34;
    const restZ = -0.22;
    let tx = -0.05;
    let ty = -0.10;
    let tz = -0.38;
    let rx = -0.12;
    let ry = 0.22;
    let rz = -0.18;

    if (kind === 'heal') {
      // 救急キットを手前に掲げて包帯を巻くような円弧動作
      tx = -0.01 + Math.sin(t * 5.2) * 0.032;
      ty = -0.105 + Math.cos(t * 5.2) * 0.022;
      tz = -0.34 + Math.sin(t * 2.6) * 0.015;
      rx = 0.18 + Math.sin(t * 5.2) * 0.12;
      ry = 0.38 + Math.cos(t * 5.2) * 0.14;
      rz = -0.22 + Math.sin(t * 5.2) * 0.25;
    } else if (kind === 'lock') {
      // 施錠・解錠・ドアチェック: 手首をひねる動作
      tx = -0.04 + Math.sin(t * 4.5) * 0.012;
      ty = -0.095 + Math.cos(t * 4.5) * 0.008;
      tz = -0.40 - Math.sin(t * 4.5) * 0.014;
      rx = -0.18;
      ry = 0.18;
      rz = -0.15 + Math.sin(t * 7.5) * 0.48;
    } else if (kind === 'trap') {
      // 罠解除・トラップ設置・C2 設置: 細かな精密作業
      tx = -0.03 + Math.sin(t * 8.5) * 0.018;
      ty = -0.105 + Math.sin(t * 6.0) * 0.014;
      tz = -0.39 + Math.cos(t * 7.0) * 0.012;
      rx = -0.25 + Math.sin(t * 6.0) * 0.08;
      ry = 0.14 + Math.cos(t * 8.5) * 0.16;
      rz = -0.1 + Math.sin(t * 9.0) * 0.18;
    } else if (kind === 'barricade') {
      // 窓の板張り・外し: リズミカルに押し当てる・打ち付ける動作
      const beat = Math.sin(t * 8.0);
      tx = -0.045;
      ty = -0.08 + beat * 0.028;
      tz = -0.36 - Math.max(0, beat) * 0.065;
      rx = -0.15 - Math.max(0, beat) * 0.22;
      ry = 0.15;
      rz = -0.25;
    } else if (kind === 'restrain') {
      // 逮捕・保護・証拠回収・仲間解放・人質確保: 手前で締め上げるスイープ動作
      tx = -0.03 + Math.sin(t * 5.5) * 0.04;
      ty = -0.12 + Math.cos(t * 5.5) * 0.016;
      tz = -0.37 - Math.abs(Math.sin(t * 2.75)) * 0.035;
      rx = -0.32 + Math.sin(t * 5.5) * 0.12;
      ry = 0.28 + Math.sin(t * 5.5) * 0.22;
      rz = -0.3 + Math.cos(t * 5.5) * 0.24;
    } else if (kind === 'surrender') {
      // 投降: 左手を高く上げる
      tx = -0.14;
      ty = 0.02 + Math.sin(t * 3.0) * 0.01;
      tz = -0.34;
      rx = 0.45;
      ry = 0.15;
      rz = 0.25;
    } else if (kind === 'doorTap') {
      // ドア開閉タップ: ドアノブ高さへ低めに伸ばして軽くひねる
      const reach = Math.sin(Math.min(1, t / 0.32) * Math.PI);
      tx = -0.07 + reach * 0.015;
      ty = -0.205 - reach * 0.015;
      tz = -0.32 - reach * 0.05;
      rx = -0.28 - reach * 0.08;
      ry = 0.24;
      rz = -0.35 + reach * 0.45;
    }

    this.interactGroup.position.set(
      restX + (tx - restX) * b,
      restY + (ty - restY) * b,
      restZ + (tz - restZ) * b,
    );
    this.interactGroup.rotation.set(rx * b, ry * b, rz * b);
  }

  private animateOptiwand(wand: OptiwandViewState | null): void {
    const ext = wand ? smooth(wand.extend) : 0;
    const active = ext > 0.05;
    this.wandShaft.position.set(0, -0.004, -0.195 - ext * 0.22);
    if (wand) {
      this.wandHead.rotation.set(wand.panPitch * 0.45 * ext, wand.panYaw * 0.55 * ext, 0);
    } else {
      this.wandHead.rotation.set(0, 0, 0);
    }
    if (wand?.underDoor) {
      this.gun.position.set(-0.02 * ext, -0.065 * ext, -0.08 * ext);
      this.gun.rotation.set(-0.34 * ext, 0.06 * ext, 0.05 * ext);
    } else {
      this.gun.position.set(-0.015 * ext, 0.015 * ext, -0.09 * ext);
      this.gun.rotation.set(0.04 * ext, 0.04 * ext, 0);
    }
    if (this.wandScreenMat) this.wandScreenMat.color.setHex(active ? 0x4fa86c : 0x1f3d28);
    if (this.wandLedMat) this.wandLedMat.color.setHex(active ? 0xff4444 : 0x38d868);
  }

  /** p<0 で通常姿勢。タイムラインは装備の reloadTime に比例して伸縮する。 */
  private animateReload(p: number, empty: boolean): void {
    const g = this.gun;
    g.position.set(0, 0, 0);
    g.rotation.set(0, 0, 0);
    this.offHand.visible = false;
    if (this.hasMag) {
      this.mag.position.copy(this.magRest);
      this.mag.rotation.set(0, 0, 0);
      this.mag.visible = true;
      this.offHand.position.set(0, 0, 0);
    }
    if (p < 0) return;

    // 構え崩し → 保持 → 戻し
    const tilt = smooth(p / 0.16) * (1 - smooth((p - 0.84) / 0.16));
    // 弾倉を叩き込んだ瞬間の揺れ
    const seat = this.hasMag ? bump(p, 0.66, 0.07) : 0;
    // 空からのリロード: 最後にチャージングハンドル（手前に引いて離す）
    const rack = empty ? bump(p, 0.8, 0.06) : 0;

    if (!this.hasMag) {
      // 弾倉の無い装備: 下ろして手元で装填する所作
      const dip = smooth(p / 0.2) * (1 - smooth((p - 0.75) / 0.25));
      g.position.set(-0.02 * dip, -0.09 * dip, 0.03 * dip);
      g.rotation.set(-0.55 * dip, 0.25 * dip, 0.35 * dip + Math.sin(p * Math.PI * 6) * 0.03 * dip);
      return;
    }

    // 銃を画面中央寄りへ持ち上げ、右に傾けてマガジンウェルを左手側（画面内）へ向ける
    g.position.set(-0.05 * tilt, 0.05 * tilt + seat * 0.012, -0.05 * tilt + rack * 0.035);
    g.rotation.set(0.1 * tilt + seat * 0.05 + rack * 0.08, 0.38 * tilt, -0.6 * tilt - seat * 0.04);

    const out = this.mag.position;
    if (p < 0.2) {
      // 保持（ほんの少し緩める）
      out.addScaledVector(this.magAxis, smooth(p / 0.2) * 0.012);
    } else if (p < 0.4) {
      // 古い弾倉が落ちる
      const t = (p - 0.2) / 0.2;
      out.addScaledVector(this.magAxis, 0.012 + t * t * 0.4);
      this.mag.rotation.x = t * 0.5;
      this.mag.visible = t < 0.9;
    } else if (p < 0.66) {
      // 左手が新しい弾倉を下から持ってきて差し込む
      const t = smooth((p - 0.4) / 0.26);
      const lift = 1 - t;
      out.addScaledVector(this.magAxis, 0.012 + lift * 0.24);
      out.x -= lift * 0.12;
      out.z += lift * 0.08;
      this.mag.rotation.set(-0.35 * lift, 0, 0.4 * lift);
      this.offHand.visible = true;
    } else {
      // 装着完了 → 左手が離れる
      const t = smooth((p - 0.68) / 0.2);
      this.offHand.visible = t < 1;
      this.offHand.position.set(-0.08 * t, -0.22 * t, 0.12 * t);
    }
  }

  private rebuild(style: string): void {
    this.style = style;
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) {
      if (m instanceof THREE.MeshStandardMaterial) m.map = null;
      m.dispose();
    }
    this.geos.length = 0;
    this.mats.length = 0;
    this.gun.clear();
    this.mag.clear();
    this.offHand.clear();
    this.wandShaft.clear();
    this.wandHead.clear();
    this.wandScreenMat = null;
    this.wandLedMat = null;
    this.hasMag = false;
    this.parent = this.gun;
    if (style === 'optiwand') this.buildOptiwand();
    else if (style === 'radio') this.buildRadio();
    else if (style === 'flashbang') this.buildFlash();
    else if (style === 'teargas') this.buildGas();
    else if (style === 'taser') this.buildTaser();
    else if (style === 'pepperball') this.buildPepper();
    else if (style === 'smg' || style === 'suspect_smg') this.buildGun(0.28, 0.16);
    else if (style === 'suppressed_rifle') this.buildSuppressedGun();
    else if (style === 'shotgun') this.buildShotgun(false);
    else if (style === 'suspect_shotgun') this.buildShotgun(true);
    else if (style === 'suspect_ar') this.buildSuspectAr();
    else if (style === 'machine_pistol') this.buildPistol();
    else this.buildGun(0.46, 0.22);
  }

  private metal(color = 0x565f68): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ map: this.textures.get('metal'), color, roughness: 0.48, metalness: 0.15 });
    this.mats.push(m);
    return m;
  }

  private wood(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ map: this.textures.get('wood'), color: 0x6b4424, roughness: 0.75 });
    this.mats.push(m);
    return m;
  }

  private add(geo: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): void {
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    this.parent.add(mesh);
  }

  /** 弾倉グループを作る。(x,y,z) は弾倉上端（マガジンウェル位置）。build 内で弾倉部品を足す。 */
  private withMag(x: number, y: number, z: number, axisTiltX: number, build: () => void): void {
    this.hasMag = true;
    this.magRest.set(x, y, z);
    this.magAxis.set(0, -Math.cos(axisTiltX), -Math.sin(axisTiltX));
    this.mag.position.copy(this.magRest);
    this.gun.add(this.mag);
    this.parent = this.mag;
    build();
    this.parent = this.offHand;
    this.mag.add(this.offHand);
    this.buildOffHand();
    this.parent = this.gun;
  }

  /** 左手: 弾倉の下側を握る。手首から先と袖。 */
  private buildOffHand(): void {
    const glove = this.glove();
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x465044, map: this.textures.get('fabric'), roughness: 0.92 });
    this.mats.push(sleeve);
    const palmY = -0.1;
    this.add(new THREE.BoxGeometry(0.07, 0.05, 0.085), glove, -0.012, palmY, 0.004);
    for (let f = 0; f < 4; f++) {
      this.add(new THREE.BoxGeometry(0.014, 0.05, 0.016).rotateZ(-0.25), glove, 0.03, palmY + 0.03, -0.03 + f * 0.019);
    }
    this.add(new THREE.BoxGeometry(0.02, 0.05, 0.02).rotateZ(0.5), glove, -0.04, palmY + 0.03, -0.02);
    const forearm = new THREE.BoxGeometry(0.08, 0.26, 0.078);
    forearm.rotateX(0.9).rotateZ(0.7);
    this.add(forearm, sleeve, -0.09, palmY - 0.1, 0.08);
  }

  private buildGun(barrel: number, stock: number): void {
    const metal = this.metal();
    const dark = this.metal(0x394149);
    this.add(new THREE.BoxGeometry(0.065, 0.075, 0.21), metal, 0, 0, -0.075);
    const foreEnd = barrel - 0.16;
    this.add(new THREE.BoxGeometry(0.052, 0.052, foreEnd), dark, 0, 0, -0.14 - foreEnd / 2);
    this.add(new THREE.CylinderGeometry(0.011, 0.011, 0.12, 12).rotateX(Math.PI / 2), metal, 0, 0, -barrel + 0.04);
    this.add(new THREE.BoxGeometry(0.06, 0.065, stock), this.wood(), 0, -0.01, stock / 2 + 0.02);
    this.withMag(0, -0.025, -0.095, 0.12, () => {
      this.add(new THREE.BoxGeometry(0.037, 0.10, 0.055).rotateX(0.12), dark, 0, -0.045, -0.006);
      this.add(new THREE.BoxGeometry(0.041, 0.012, 0.06), this.metal(0x2a2f34), 0, -0.095, -0.012);
    });
    this.add(new THREE.BoxGeometry(0.022, 0.035, 0.055), dark, 0, 0.05, -0.08);
    this.add(new THREE.BoxGeometry(0.05, 0.095, 0.055), metal, 0, -0.065, 0.012);
    this.buildHand(0.015, -0.08, 0.026);
  }

  /** 消音カービン: 通常カービン＋銃口サプレッサー */
  private buildSuppressedGun(): void {
    this.buildGun(0.42, 0.22);
    const supp = this.metal(0x252a30);
    this.add(new THREE.CylinderGeometry(0.019, 0.019, 0.17, 14).rotateX(Math.PI / 2), supp, 0, 0, -0.52);
  }

  /** ショットガン（sawedOff=true で容疑者用ソードオフ） */
  private buildShotgun(sawedOff: boolean): void {
    const metal = this.metal(sawedOff ? 0x3b3f44 : 0x454e57);
    const dark = this.metal(0x282d33);
    const woodMat = this.wood();
    const barrelLen = sawedOff ? 0.34 : 0.56;
    this.add(new THREE.BoxGeometry(0.062, 0.07, 0.19), metal, 0, 0, -0.07);
    if (sawedOff) {
      // 二連バレル＋切り詰め木製ストック
      this.add(new THREE.CylinderGeometry(0.014, 0.014, barrelLen, 12).rotateX(Math.PI / 2), metal, -0.015, 0.012, -0.14 - barrelLen / 2);
      this.add(new THREE.CylinderGeometry(0.014, 0.014, barrelLen, 12).rotateX(Math.PI / 2), metal, 0.015, 0.012, -0.14 - barrelLen / 2);
      this.add(new THREE.BoxGeometry(0.056, 0.044, 0.15), woodMat, 0, -0.018, -0.22);
      this.add(new THREE.BoxGeometry(0.052, 0.085, 0.11).rotateX(-0.35), woodMat, 0, -0.055, 0.055);
    } else {
      // タクティカル・ポンプアクション（銃身＋チューブ弾倉＋フォアエンド）
      this.add(new THREE.CylinderGeometry(0.015, 0.015, barrelLen, 12).rotateX(Math.PI / 2), metal, 0, 0.015, -0.14 - barrelLen / 2);
      this.add(new THREE.CylinderGeometry(0.013, 0.013, barrelLen * 0.85, 12).rotateX(Math.PI / 2), dark, 0, -0.015, -0.14 - barrelLen * 0.42);
      this.add(new THREE.BoxGeometry(0.058, 0.048, 0.18), dark, 0, -0.018, -0.34);
      this.add(new THREE.BoxGeometry(0.058, 0.068, 0.22), dark, 0, -0.012, 0.13);
    }
    this.add(new THREE.BoxGeometry(0.046, 0.09, 0.052), dark, 0, -0.062, 0.01);
    this.buildHand(0.015, -0.078, 0.024);
  }

  /** 軍用アサルトライフル（容疑者 Lv.4 用） */
  private buildSuspectAr(): void {
    const steel = this.metal(0x343a40);
    const dark = this.metal(0x23272b);
    const woodMat = this.wood();
    this.add(new THREE.BoxGeometry(0.064, 0.074, 0.22), steel, 0, 0, -0.075);
    this.add(new THREE.BoxGeometry(0.054, 0.056, 0.24), woodMat, 0, -0.004, -0.27);
    this.add(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 12).rotateX(Math.PI / 2), steel, 0, 0.004, -0.46);
    this.add(new THREE.BoxGeometry(0.058, 0.066, 0.23), woodMat, 0, -0.014, 0.135);
    this.withMag(0, -0.028, -0.11, 0.22, () => {
      this.add(new THREE.BoxGeometry(0.036, 0.13, 0.058).rotateX(0.22), dark, 0, -0.06, -0.012);
    });
    this.add(new THREE.BoxGeometry(0.046, 0.095, 0.05), woodMat, 0, -0.065, 0.012);
    this.buildHand(0.015, -0.08, 0.026);
  }

  /** 改造フルオート拳銃: 短いスライド＋延長マガジン（ストックなし） */
  private buildPistol(): void {
    const slide = this.metal(0x2e3338);
    const frame = this.metal(0x45403a);
    this.add(new THREE.BoxGeometry(0.042, 0.045, 0.19), slide, 0, 0.012, -0.19);
    this.add(new THREE.BoxGeometry(0.038, 0.03, 0.16), frame, 0, -0.022, -0.18);
    this.add(new THREE.CylinderGeometry(0.014, 0.014, 0.06, 10).rotateX(Math.PI / 2), slide, 0, 0.012, -0.31);
    this.add(new THREE.BoxGeometry(0.036, 0.11, 0.05).rotateX(-0.25), frame, 0, -0.08, -0.12);
    this.withMag(0, -0.05, -0.14, -0.2, () => {
      this.add(new THREE.BoxGeometry(0.03, 0.16, 0.035).rotateX(-0.2), this.metal(0x1d2024), 0, -0.08, 0.015);
    });
    this.buildHand(0.012, -0.085, -0.11);
  }

  private buildHand(x: number, y: number, z: number): void {
    const glove = this.glove();
    const sleeve = new THREE.MeshStandardMaterial({
      color: 0x465044, map: this.textures.get('fabric'), roughness: 0.92,
    });
    this.mats.push(sleeve);
    const forearm = new THREE.BoxGeometry(0.084, 0.251, 0.08);
    forearm.rotateX(1.18).rotateY(0.35);
    this.add(forearm, sleeve, x + 0.048, y - 0.045, z + 0.137);
    const palm = new THREE.BoxGeometry(0.068, 0.089, 0.098);
    this.add(palm, glove, x + 0.014, y, z);
    const thumb = new THREE.BoxGeometry(0.024, 0.053, 0.024).rotateZ(-0.83);
    this.add(thumb, glove, x + 0.004, y + 0.031, z - 0.021);
    for (let finger = 0; finger < 4; finger++) {
      const joint = new THREE.BoxGeometry(0.016, 0.039, 0.017).rotateZ(1.2);
      this.add(joint, glove, x - 0.012, y + 0.025 - finger * 0.016, z - 0.023);
    }
  }

  private glove(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ map: this.textures.get('fabric'), color: 0x383e42, roughness: 0.7 });
    this.mats.push(m);
    return m;
  }

  private buildFlash(): void {
    this.add(new THREE.CylinderGeometry(0.043, 0.043, 0.13, 12), this.metal(0x6882a6), 0, -0.02, -0.16);
    this.add(new THREE.BoxGeometry(0.045, 0.024, 0.045), this.metal(0xb0b8c0), 0, 0.05, -0.16);
    this.buildHand(0.036, -0.075, -0.135);
  }

  /** CS ガス弾: フラッシュバンより細長いオリーブ色の缶に黄色い帯とピン */
  private buildGas(): void {
    this.add(new THREE.CylinderGeometry(0.034, 0.034, 0.17, 12), this.metal(0x56653f), 0, -0.02, -0.16);
    this.add(new THREE.CylinderGeometry(0.0355, 0.0355, 0.022, 12), this.metal(0xd9b72b), 0, 0.01, -0.16);
    this.add(new THREE.CylinderGeometry(0.02, 0.026, 0.03, 10), this.metal(0x2c3328), 0, 0.078, -0.16);
    this.add(new THREE.TorusGeometry(0.016, 0.003, 6, 12).rotateX(Math.PI / 2), this.metal(0xc4c8cc), 0.03, 0.09, -0.16);
    this.buildHand(0.036, -0.075, -0.135);
  }

  private buildTaser(): void {
    this.add(new THREE.BoxGeometry(0.06, 0.1, 0.16), this.metal(0x404952), 0, -0.02, -0.16);
    const accent = this.metal(0xd0d0d0);
    this.add(new THREE.BoxGeometry(0.01, 0.02, 0.08), accent, -0.015, 0.021, -0.24);
    this.add(new THREE.BoxGeometry(0.01, 0.02, 0.08), accent, 0.015, 0.021, -0.24);
    this.add(new THREE.BoxGeometry(0.055, 0.095, 0.06), this.metal(), 0, -0.075, -0.10);
    this.buildHand(0.016, -0.09, -0.084);
  }

  private buildPepper(): void {
    this.add(new THREE.BoxGeometry(0.07, 0.08, 0.28), this.metal(0x4f6250), 0, 0, -0.2);
    this.add(new THREE.CylinderGeometry(0.029, 0.031, 0.13, 12).rotateX(Math.PI / 2), this.metal(0x454c4d), 0, 0, -0.06);
    this.add(new THREE.BoxGeometry(0.055, 0.09, 0.06), this.metal(), 0, -0.05, -0.10);
    this.buildHand(0.016, -0.08, -0.084);
  }

  private buildRadio(): void {
    this.add(new THREE.BoxGeometry(0.1, 0.16, 0.04), this.metal(0x3b4a40), 0, -0.02, -0.18);
    this.add(new THREE.BoxGeometry(0.012, 0.18, 0.012), this.metal(0xaaaaaa), 0.03, 0.1, -0.18);
    const display = new THREE.MeshBasicMaterial({ color: 0x668b63 });
    this.mats.push(display);
    this.add(new THREE.BoxGeometry(0.061, 0.027, 0.004), display, 0, 0.016, -0.159);
    this.buildHand(0.03, -0.08, -0.143);
  }

  /** オプティワンド: ピストルグリップ本体＋小型モニター＋伸縮ロッド＋首振り先端カメラ */
  private buildOptiwand(): void {
    const bodyMat = this.metal(0x323b38);
    const trimMat = this.metal(0x4a535c);
    const gripMat = this.metal(0x252a2e);
    const darkMat = this.metal(0x1e2326);
    const ferruleMat = this.metal(0x7c8690);

    // ピストルグリップ＋バッテリー底部
    this.add(new THREE.BoxGeometry(0.044, 0.115, 0.052).rotateX(-0.18), gripMat, 0, -0.072, -0.08);
    this.add(new THREE.BoxGeometry(0.048, 0.018, 0.056), darkMat, 0, -0.128, -0.072);

    // コントロール本体＋上面レール＋左側面首振りダイヤル
    this.add(new THREE.BoxGeometry(0.064, 0.054, 0.125), bodyMat, 0, -0.005, -0.11);
    this.add(new THREE.BoxGeometry(0.052, 0.012, 0.11), trimMat, 0, 0.024, -0.112);
    this.add(new THREE.CylinderGeometry(0.012, 0.012, 0.014, 10).rotateZ(Math.PI / 2), ferruleMat, -0.035, -0.005, -0.105);

    // 背面ステータス LED（待機=緑、展開中=赤）
    this.wandLedMat = new THREE.MeshBasicMaterial({ color: 0x38d868 });
    this.mats.push(this.wandLedMat);
    this.add(new THREE.BoxGeometry(0.008, 0.008, 0.005), this.wandLedMat, 0.024, 0.016, -0.046);

    // 傾斜モニター＋遮光フード＋液晶面
    this.add(new THREE.BoxGeometry(0.102, 0.074, 0.018).rotateX(-0.22), darkMat, 0, 0.056, -0.088);
    this.add(new THREE.BoxGeometry(0.104, 0.008, 0.026).rotateX(-0.22), darkMat, 0, 0.092, -0.082);
    this.add(new THREE.BoxGeometry(0.007, 0.072, 0.024).rotateX(-0.22), darkMat, -0.048, 0.056, -0.082);
    this.add(new THREE.BoxGeometry(0.007, 0.072, 0.024).rotateX(-0.22), darkMat, 0.048, 0.056, -0.082);
    this.wandScreenMat = new THREE.MeshBasicMaterial({ color: 0x1f3d28 });
    this.mats.push(this.wandScreenMat);
    this.add(new THREE.BoxGeometry(0.086, 0.058, 0.004).rotateX(-0.22), this.wandScreenMat, 0, 0.056, -0.079);

    // 本体前部のロッド受けカラー
    this.add(new THREE.CylinderGeometry(0.019, 0.021, 0.038, 12).rotateX(Math.PI / 2), trimMat, 0, -0.004, -0.185);

    // 伸縮ロッド部（wandShaft）
    this.wandShaft.position.set(0, -0.004, -0.195);
    this.wandShaft.rotation.set(0, 0, 0);
    this.gun.add(this.wandShaft);
    this.parent = this.wandShaft;
    this.add(new THREE.CylinderGeometry(0.012, 0.013, 0.24, 12).rotateX(Math.PI / 2), gripMat, 0, 0, -0.12);
    this.add(new THREE.CylinderGeometry(0.015, 0.015, 0.016, 12).rotateX(Math.PI / 2), ferruleMat, 0, 0, -0.235);
    this.add(new THREE.CylinderGeometry(0.0085, 0.0095, 0.2, 12).rotateX(Math.PI / 2), trimMat, 0, 0, -0.33);

    // 首振り先端カメラヘッド（wandHead）
    this.wandHead.position.set(0, 0, -0.435);
    this.wandHead.rotation.order = 'YXZ';
    this.wandHead.rotation.set(0, 0, 0);
    this.wandShaft.add(this.wandHead);
    this.parent = this.wandHead;
    this.add(new THREE.CylinderGeometry(0.009, 0.009, 0.032, 10).rotateX(Math.PI / 2), darkMat, 0, 0, -0.01);
    this.add(new THREE.BoxGeometry(0.028, 0.024, 0.034), bodyMat, 0, 0, -0.036);
    this.add(new THREE.CylinderGeometry(0.011, 0.012, 0.014, 12).rotateX(Math.PI / 2), darkMat, 0, 0, -0.055);
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x1a5c54, roughness: 0.08, metalness: 0.75 });
    const irMat = new THREE.MeshBasicMaterial({ color: 0x88ffaa });
    this.mats.push(lensMat, irMat);
    this.add(new THREE.CylinderGeometry(0.0085, 0.0085, 0.004, 12).rotateX(Math.PI / 2), lensMat, 0, 0, -0.061);
    this.add(new THREE.CylinderGeometry(0.0028, 0.0028, 0.004, 8).rotateX(Math.PI / 2), irMat, 0.01, 0.006, -0.053);

    this.parent = this.gun;
    this.buildHand(0.016, -0.088, -0.068);
  }

  /** インタラクト用の左手＋前腕と、回復・解除などの小型プロップを構築する。 */
  private buildInteractHand(): void {
    const addPart = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      this.interactGeos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
    };
    const glove = new THREE.MeshStandardMaterial({ map: this.textures.get('fabric'), color: 0x383e42, roughness: 0.7 });
    const sleeve = new THREE.MeshStandardMaterial({ map: this.textures.get('fabric'), color: 0x465044, roughness: 0.92 });
    const pouchMat = new THREE.MeshStandardMaterial({ map: this.textures.get('fabric'), color: 0xe6e8e4, roughness: 0.78 });
    const crossMat = new THREE.MeshBasicMaterial({ color: 0xcc2c2c });
    const toolMat = new THREE.MeshStandardMaterial({ map: this.textures.get('metal'), color: 0x626c75, roughness: 0.42, metalness: 0.25 });
    const toolGripMat = new THREE.MeshStandardMaterial({ map: this.textures.get('metal'), color: 0x262c30, roughness: 0.65, metalness: 0.1 });
    this.interactMats.push(glove, sleeve, pouchMat, crossMat, toolMat, toolGripMat);

    // 左手のひら・指・親指・前腕
    addPart(this.interactGroup, new THREE.BoxGeometry(0.068, 0.044, 0.088), glove, 0, 0, 0);
    for (let f = 0; f < 4; f++) {
      addPart(
        this.interactGroup,
        new THREE.BoxGeometry(0.014, 0.018, 0.056).rotateX(-0.22),
        glove,
        -0.024 + f * 0.016,
        -0.004,
        -0.062,
      );
    }
    addPart(this.interactGroup, new THREE.BoxGeometry(0.02, 0.022, 0.048).rotateY(-0.45), glove, 0.04, 0.002, -0.024);
    const forearm = new THREE.BoxGeometry(0.078, 0.074, 0.28);
    forearm.rotateX(0.28).rotateY(-0.26);
    addPart(this.interactGroup, forearm, sleeve, -0.055, -0.055, 0.155);

    // 救急キット（回復中のみ表示）
    this.interactGroup.add(this.interactMedkit);
    addPart(this.interactMedkit, new THREE.BoxGeometry(0.115, 0.082, 0.044), pouchMat, 0.03, 0.048, -0.028);
    addPart(this.interactMedkit, new THREE.BoxGeometry(0.044, 0.014, 0.004), crossMat, 0.03, 0.048, -0.005);
    addPart(this.interactMedkit, new THREE.BoxGeometry(0.014, 0.044, 0.004), crossMat, 0.03, 0.048, -0.005);
    this.interactMedkit.visible = false;

    // マルチツール（施錠・解錠・罠解除中のみ表示）
    this.interactGroup.add(this.interactTool);
    addPart(this.interactTool, new THREE.BoxGeometry(0.018, 0.022, 0.064), toolGripMat, 0.014, 0.006, -0.052);
    addPart(this.interactTool, new THREE.BoxGeometry(0.007, 0.009, 0.054).rotateY(0.14), toolMat, 0.009, 0.006, -0.104);
    addPart(this.interactTool, new THREE.BoxGeometry(0.007, 0.009, 0.054).rotateY(-0.14), toolMat, 0.019, 0.006, -0.104);
    this.interactTool.visible = false;
  }

  /** ドア蹴り用の右脚（すね＋膝当て＋コンバットブーツ＋靴底）を構築する。 */
  private buildKickLeg(): void {
    const addPart = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      this.kickGeos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      this.kickGroup.add(m);
    };
    const trouser = new THREE.MeshStandardMaterial({ map: this.textures.get('fabric'), color: 0x2b362d, roughness: 0.9 });
    const pad = new THREE.MeshStandardMaterial({ map: this.textures.get('fabric'), color: 0x1c2124, roughness: 0.72 });
    const boot = new THREE.MeshStandardMaterial({ map: this.textures.get('fabric'), color: 0x1a1d20, roughness: 0.62 });
    const sole = new THREE.MeshStandardMaterial({ map: this.textures.get('metal'), color: 0x111315, roughness: 0.85, metalness: 0.08 });
    this.kickMats.push(trouser, pad, boot, sole);

    // すね〜ズボン（ローカル +Y が上、前傾時に足先が -Z へ突き出る）
    addPart(new THREE.BoxGeometry(0.115, 0.34, 0.125), trouser, 0, -0.14, 0);
    // 膝・すね当てパッド
    addPart(new THREE.BoxGeometry(0.122, 0.13, 0.028), pad, 0, -0.24, -0.068);
    // ブーツ足首〜甲
    addPart(new THREE.BoxGeometry(0.108, 0.12, 0.128), boot, 0, 0.06, -0.006);
    addPart(new THREE.BoxGeometry(0.114, 0.078, 0.23), boot, 0, 0.12, -0.055);
    // 厚手の靴底（蹴り出し時に正面から見える）
    addPart(new THREE.BoxGeometry(0.124, 0.028, 0.245), sole, 0, 0.165, -0.058);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) {
      if (m instanceof THREE.MeshStandardMaterial) m.map = null;
      m.dispose();
    }
    for (const g of this.interactGeos) g.dispose();
    for (const m of this.interactMats) {
      if (m instanceof THREE.MeshStandardMaterial) m.map = null;
      m.dispose();
    }
    for (const g of this.kickGeos) g.dispose();
    for (const m of this.kickMats) {
      if (m instanceof THREE.MeshStandardMaterial) m.map = null;
      m.dispose();
    }
    this.root.removeFromParent();
  }
}

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** center 付近で 0→1→0 になる短いパルス。 */
function bump(p: number, center: number, width: number): number {
  const d = Math.abs(p - center) / width;
  return d >= 1 ? 0 : Math.sin((1 - d) * Math.PI * 0.5) ** 2;
}
