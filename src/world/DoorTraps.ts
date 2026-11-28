import * as THREE from 'three';
import type { GameEventBus } from '../core/events';
import { disposeObject } from '../core/dispose';
import type { DoorTrapConfig, Vec3 } from '../core/types';
import { hasLineOfSight } from '../weapons/Flashbang';
import type { Collider } from './WorldBuilder';
import type { Door, DoorSystem } from './Door';

/**
 * SWAT モードのドア・ブービートラップ。容疑者が突入前に一部のドアへ仕掛けておく。
 * - 設置数は 0〜maxCount。交渉の警戒度ベースラインが高い（決裂・威圧）と増える（rigCount）
 * - SWAT 側（プレイヤー/隊員）の誰かがドアの近くで、未解除のまま開く（開く・蹴破る）と起爆
 * - 「ドアチェック」で発見（discover）→ 解除（disarm）できる。C2 の爆風は安全に破壊する（destroy）
 * 容疑者モードの Fortify とは独立（Fortify の API は変更せず、見た目の方針だけ揃えている）。
 */

export interface BlastVictim {
  chest(): Vec3;
  hurt(damage: number, from: Vec3): void;
}

/** 罠解除時にワイヤーを露出させるため扉をそっと開ける安全角度（度） */
export const SAFE_DISARM_PEEK_DEG = 12;
/** 発見済みかつ解除作業中に起爆しない最大角度（度） */
export const SAFE_DISARM_MAX_DEG = 18;

/** 爆風: LOS が通る犠牲者に距離減衰ダメージ。返り値は被害を受けた数。 */
export function applyTrapBlast(
  colliders: readonly Collider[],
  center: Vec3,
  radius: number,
  maxDamage: number,
  victims: Iterable<BlastVictim>,
): number {
  let hurt = 0;
  for (const v of victims) {
    const c = v.chest();
    const dist = Math.hypot(c.x - center.x, c.y - center.y, c.z - center.z);
    if (dist >= radius) continue;
    if (!hasLineOfSight(colliders, center, c)) continue;
    const dmg = Math.round(maxDamage * (1 - 0.6 * (dist / radius)));
    if (dmg <= 0) continue;
    v.hurt(dmg, center);
    hurt++;
  }
  return hurt;
}

/** 設置数: 基礎確率で 1 個、警戒度ベースラインが閾値以上なら追加（上限 maxCount）。 */
export function rigCount(cfg: DoorTrapConfig, baselineAlert: number, rand: () => number = Math.random): number {
  let n = rand() < cfg.baseChance ? 1 : 0;
  if (baselineAlert >= cfg.alertBonusAt) n += cfg.alertBonus;
  // 交渉が大きくこじれた場合は最低 1 個は仕掛けられている
  if (baselineAlert >= cfg.alertBonusAt + 15) n = Math.max(n, 1);
  return Math.max(0, Math.min(cfg.maxCount, n));
}

interface RiggedTrap {
  doorId: string;
  mesh: THREE.Group;
  discovered: boolean;
}

export interface DoorTrapDeps {
  doors: DoorSystem;
  bus: GameEventBus;
  colliders: readonly Collider[];
  cfg: DoorTrapConfig;
  /** SWAT 側（プレイヤー + 生存隊員）の位置 */
  swatPositions(): Iterable<{ x: number; z: number; footY: number }>;
  /** 容疑者の位置（自分たちで開けても起爆しない） */
  suspectPositions(): Iterable<{ x: number; z: number; footY: number }>;
  /** 爆風の被害者（プレイヤー・隊員・民間人・容疑者） */
  victims(): Iterable<BlastVictim>;
}

export class DoorTrapSystem {
  readonly root = new THREE.Group();
  private readonly traps = new Map<string, RiggedTrap>();
  /** 安全ピークでワイヤー切断中のドア ID（発見済みかつ角度 <= SAFE_DISARM_MAX_DEG なら起爆しない） */
  private readonly disarming = new Set<string>();
  private readonly fx: { mesh: THREE.Mesh; t: number }[] = [];
  private readonly boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly ledGeo = new THREE.SphereGeometry(1, 8, 6);
  private readonly bodyMat = new THREE.MeshStandardMaterial({ color: 0x3a3a2a, roughness: 0.7 });
  private readonly ledMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
  private readonly wireMat = new THREE.MeshBasicMaterial({ color: 0xff4433 });
  private disposed = false;
  /** 起爆した回数・解除した回数（成績・テスト用） */
  detonated = 0;
  disarmed = 0;

  constructor(private readonly d: DoorTrapDeps) {
    this.root.name = 'doorTraps';
  }

  get count(): number {
    return this.traps.size;
  }

  riggedIds(): string[] {
    return [...this.traps.keys()];
  }

  isRigged(doorId: string): boolean {
    return this.traps.has(doorId);
  }

  isDiscovered(doorId: string): boolean {
    return this.traps.get(doorId)?.discovered === true;
  }

  /** チェック/気付きで発見済みにする。仕掛けが無ければ false。 */
  discover(doorId: string): boolean {
    const t = this.traps.get(doorId);
    if (!t) return false;
    t.discovered = true;
    return true;
  }

  /** 安全ピークによるワイヤー切断作業を開始する（発見済みトラップのみ有効）。 */
  beginDisarm(doorId: string): boolean {
    const t = this.traps.get(doorId);
    if (!t || !t.discovered) return false;
    this.disarming.add(doorId);
    return true;
  }

  /** ワイヤー切断作業を終了（中断/完了）する。 */
  endDisarm(doorId: string): void {
    this.disarming.delete(doorId);
  }

  isDisarming(doorId: string): boolean {
    return this.disarming.has(doorId);
  }

  /** ミッション開始時: 条件を満たすドアに count 個を無作為に仕掛ける。返り値は仕掛けたドア ID。 */
  rig(count: number, start: Vec3, rand: () => number = Math.random): string[] {
    const cfg = this.d.cfg;
    const cand = this.d.doors.doors.filter((door) => {
      if (door.angle > 1 || door.targetAngle > 1) return false;
      if (this.traps.has(door.id)) return false;
      return Math.hypot(door.centerX - start.x, door.centerZ - start.z) >= cfg.minStartDist || Math.abs(door.sillY - start.y) > 1.2;
    });
    const out: string[] = [];
    for (let i = 0; i < count && cand.length > 0; i++) {
      const idx = Math.min(cand.length - 1, Math.floor(rand() * cand.length));
      const door = cand.splice(idx, 1)[0]!;
      this.place(door);
      out.push(door.id);
    }
    return out;
  }

  /** テスト・外部から特定のドアに仕掛ける */
  place(door: Door): void {
    if (this.traps.has(door.id)) return;
    const g = new THREE.Group();
    // 両面に小さな爆薬と赤 LED（凝視すれば気付ける）
    for (const side of [1, -1]) {
      const box = new THREE.Mesh(this.boxGeo, this.bodyMat);
      box.scale.set(0.15, 0.1, 0.05);
      box.position.set(0.32 * door.width * 0.5, 0, side * 0.09);
      box.userData.noShadow = true;
      box.castShadow = false;
      const led = new THREE.Mesh(this.ledGeo, this.ledMat);
      led.scale.setScalar(0.013);
      led.position.set(0.32 * door.width * 0.5 + 0.05, 0.035, side * 0.12);
      led.userData.noShadow = true;
      led.castShadow = false;
      // 扉をわずかに開いた隙間から見える赤いトリップワイヤー
      const wire = new THREE.Mesh(this.boxGeo, this.wireMat);
      wire.scale.set(door.width * 0.42, 0.006, 0.006);
      wire.position.set(0.18 * door.width * 0.5, -0.02, side * 0.075);
      wire.userData.noShadow = true;
      wire.castShadow = false;
      g.add(box, led, wire);
    }
    g.position.set(door.centerX, door.sillY + 0.95, door.centerZ);
    g.rotation.y = Math.atan2(door.normalX, door.normalZ);
    this.root.add(g);
    this.traps.set(door.id, { doorId: door.id, mesh: g, discovered: false });
  }

  private remove(doorId: string): boolean {
    const t = this.traps.get(doorId);
    this.disarming.delete(doorId);
    if (!t) return false;
    this.traps.delete(doorId);
    this.root.remove(t.mesh);
    return true;
  }

  /** 解除成功（隊員の作業）。 */
  disarm(doorId: string): boolean {
    const ok = this.remove(doorId);
    if (ok) this.disarmed++;
    return ok;
  }

  /** C2 の爆風などで安全に無力化する。 */
  destroy(doorId: string): boolean {
    return this.remove(doorId);
  }

  /** 起爆: 爆風・騒音・警戒度イベント。ドアが閉じていれば吹き飛ばして開ける。 */
  detonate(doorId: string): boolean {
    const door = this.d.doors.getDoor(doorId);
    if (!this.remove(doorId) || !door) return false;
    this.detonated++;
    const cfg = this.d.cfg;
    const pos: Vec3 = { x: door.centerX, y: door.sillY, z: door.centerZ };
    const center: Vec3 = { x: pos.x, y: pos.y + 1, z: pos.z };
    if (door.angle < 1) {
      door.locked = false;
      let px = door.centerX + door.normalX;
      let pz = door.centerZ + door.normalZ;
      for (const p of this.d.swatPositions()) {
        px = p.x;
        pz = p.z;
        break;
      }
      door.command(door.maxAngle, true, px, pz);
    }
    const mesh = new THREE.Mesh(
      this.ledGeo,
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    mesh.position.set(center.x, center.y, center.z);
    mesh.scale.setScalar(0.2);
    this.root.add(mesh);
    this.fx.push({ mesh, t: 0 });
    // SWAT 側（隊員）が起こした音: 容疑者は聞きつける（source 'ally' = SWAT 側の騒音）
    this.d.bus.emit('noise', { pos, radius: 45, kind: 'breach', source: 'ally' });
    this.d.bus.emit('doorTrapDetonated', { doorId, pos: center });
    applyTrapBlast(this.d.colliders, center, cfg.blastRadius, cfg.blastDamage, this.d.victims());
    return true;
  }

  update(dt: number): void {
    if (this.disposed) return;
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i]!;
      f.t += dt;
      const k = Math.min(1, f.t / 0.35);
      f.mesh.scale.setScalar(0.2 + k * (this.d.cfg.blastRadius * 0.6));
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
      if (k >= 1) {
        this.root.remove(f.mesh);
        (f.mesh.material as THREE.Material).dispose();
        this.fx.splice(i, 1);
      }
    }
    if (this.traps.size === 0) return;
    const trig = this.d.cfg.triggerDist;
    const toBlow: string[] = [];
    for (const t of this.traps.values()) {
      const door = this.d.doors.getDoor(t.doorId);
      if (!door) continue;
      if (door.angle <= 2 && door.targetAngle <= 2) continue;
      // 発見済みトラップの安全ピーク解除中（ワイヤー切断中）は安全角度以内なら起爆しない
      if (t.discovered && this.disarming.has(t.doorId) && door.angle <= SAFE_DISARM_MAX_DEG && door.targetAngle <= SAFE_DISARM_MAX_DEG) {
        continue;
      }
      let near = false;
      for (const p of this.d.swatPositions()) {
        if (Math.abs(p.footY - door.sillY) < 0.9 && Math.hypot(p.x - door.centerX, p.z - door.centerZ) < trig) {
          near = true;
          break;
        }
      }
      if (!near) continue;
      // 容疑者が自分で開けた場合は起爆しない（仕掛けた本人たちは避ける）
      let suspectNear = false;
      for (const s of this.d.suspectPositions()) {
        if (Math.abs(s.footY - door.sillY) < 0.9 && Math.hypot(s.x - door.centerX, s.z - door.centerZ) < 1.6) {
          suspectNear = true;
          break;
        }
      }
      if (!suspectNear) toBlow.push(t.doorId);
    }
    for (const id of toBlow) this.detonate(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const f of this.fx) (f.mesh.material as THREE.Material).dispose();
    this.fx.length = 0;
    this.traps.clear();
    disposeObject(this.root);
    this.boxGeo.dispose();
    this.ledGeo.dispose();
    this.bodyMat.dispose();
    this.ledMat.dispose();
    this.wireMat.dispose();
  }
}
