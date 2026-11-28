/**
 * NPC の行動選択でよく起きる「同じことを繰り返す」問題を防ぐ小さな道具。
 *
 * - {@link RepeatGuard}: 同じ台詞・同じ合図を、一定時間のうちに言い直さない（連呼の防止）。
 * - {@link AttemptLog}: 同じ行動（同じ扉のブリーチなど）を、成果なく何度も始め直していないかを数える
 *   （割り込み → 再開 → 割り込み… の往復の検知）。
 *
 * どちらも呼び出し側の時計（秒）を受け取るだけで、フレームごとの更新は要らない。
 */

/** キーごとに「最後に許した時刻」を覚え、cooldown 秒以内の再発を断る。 */
export class RepeatGuard {
  private readonly last = new Map<string, number>();

  /** 許すなら記録して true。cooldown 秒以内に同じキーを許していれば false */
  allow(key: string, now: number, cooldownSec: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < cooldownSec) return false;
    this.last.set(key, now);
    if (this.last.size > 256) this.prune(now, cooldownSec);
    return true;
  }

  /** 記録せずに、今なら許されるかだけを見る */
  ready(key: string, now: number, cooldownSec: number): boolean {
    const prev = this.last.get(key);
    return prev === undefined || now - prev >= cooldownSec;
  }

  /** 使ったことを記録する（ready で確かめてから、複数のキーをまとめて記録するとき） */
  mark(key: string, now: number): void {
    this.last.set(key, now);
    if (this.last.size > 256) this.prune(now, 60);
  }

  /** 記録だけを消す（行動が成功して、次は新しく言ってよいとき） */
  forget(key: string): void {
    this.last.delete(key);
  }

  private prune(now: number, keepSec: number): void {
    for (const [k, at] of this.last) if (now - at >= keepSec) this.last.delete(k);
  }
}

/** キーごとに試行の時刻を覚え、直近 windowSec 秒の回数を返す。 */
export class AttemptLog {
  private readonly times = new Map<string, number[]>();

  /** 試行を 1 回記録し、直近 windowSec 秒の試行回数（今回を含む）を返す */
  note(key: string, now: number, windowSec: number): number {
    const list = (this.times.get(key) ?? []).filter((at) => now - at < windowSec);
    list.push(now);
    this.times.set(key, list);
    return list.length;
  }

  /** 行動が成果を出した（扉が開いた等）ので数え直す */
  clear(key: string): void {
    this.times.delete(key);
  }
}

/** 無線の連呼を防ぐ既定値（秒）: 同じ話者が同じ種類の台詞を言い直すまで / 隊の誰かが同じ種類を言い直すまで */
export const RADIO_SAME_SPEAKER_SEC = 12;
export const RADIO_SAME_TEAM_SEC = 4;
