/** スカウト（オプティワンド/ミラー）で確認した接触 1 件。 */
export interface ScoutContact {
  id: string;
  kind: 'suspect' | 'civilian';
  /** 武装している（敵対可能な）容疑者か。投降・無力化済みの容疑者や民間人は false */
  armed: boolean;
  x: number;
  y: number;
  z: number;
  /** 最終確認時刻（秒） */
  time: number;
}

export interface RoomIntel {
  roomId: string;
  /** 確認済み（接触を見た、または一定時間カメラで見渡した） */
  scouted: boolean;
  source: 'player' | 'ally';
  contacts: Map<string, ScoutContact>;
}

/**
 * 部屋ごとの偵察情報。プレイヤーのオプティワンドと隊員のミラー確認が書き込み、
 * 隊（Squad）が Z クイック指示の判断・突入時の pre-aim・ミニマップ表示に読む。
 */
export class ScoutIntel {
  private readonly rooms = new Map<string, RoomIntel>();
  /** 変更のたびに増える（キャッシュ無効化用） */
  version = 0;

  private ensure(roomId: string, source: 'player' | 'ally'): RoomIntel {
    let r = this.rooms.get(roomId);
    if (!r) {
      r = { roomId, scouted: false, source, contacts: new Map() };
      this.rooms.set(roomId, r);
    }
    return r;
  }

  markScouted(roomId: string, source: 'player' | 'ally' = 'player'): void {
    const r = this.ensure(roomId, source);
    if (!r.scouted) this.version++;
    r.scouted = true;
  }

  /** 接触を報告する（既知の ID は位置・武装状態を更新）。部屋は確認済みになる。 */
  reportContact(roomId: string, contact: ScoutContact, source: 'player' | 'ally' = 'player'): void {
    const r = this.ensure(roomId, source);
    r.scouted = true;
    r.contacts.set(contact.id, { ...contact });
    this.version++;
  }

  isScouted(roomId: string | null | undefined): boolean {
    return !!roomId && this.rooms.get(roomId)?.scouted === true;
  }

  getRoom(roomId: string): RoomIntel | undefined {
    return this.rooms.get(roomId);
  }

  /** 部屋内の既知の脅威（武装容疑者）。 */
  threatsIn(roomId: string | null | undefined): ScoutContact[] {
    if (!roomId) return [];
    const r = this.rooms.get(roomId);
    if (!r) return [];
    return [...r.contacts.values()].filter((c) => c.kind === 'suspect' && c.armed);
  }

  contactsIn(roomId: string | null | undefined): ScoutContact[] {
    if (!roomId) return [];
    const r = this.rooms.get(roomId);
    return r ? [...r.contacts.values()] : [];
  }

  all(): ScoutContact[] {
    const out: ScoutContact[] = [];
    for (const r of this.rooms.values()) for (const c of r.contacts.values()) out.push(c);
    return out;
  }

  /** keep が false を返した接触を破棄する（制圧済み・消えた対象の掃除）。 */
  prune(keep: (c: ScoutContact) => boolean): void {
    for (const r of this.rooms.values()) {
      for (const [id, c] of r.contacts) {
        if (!keep(c)) {
          r.contacts.delete(id);
          this.version++;
        }
      }
    }
  }

  clear(): void {
    this.rooms.clear();
    this.version++;
  }
}
