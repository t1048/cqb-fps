import { CUFF_SEC, type RestrainTarget } from '../../ai/restrain';
import { RESTRAIN_DONE, RESTRAIN_FAKE, RESTRAIN_GO, pickRadio } from '../../ai/radioLines';
import type { SwatHunter } from './SwatHunter';
import {
  RESTRAIN_FAKE_AT_MIN,
  RESTRAIN_FAKE_AT_SPAN,
  RESTRAIN_MAX_DIST,
  RESTRAIN_REACH,
  type SwatTeamDeps,
} from './swatTypes';

export interface SwatRestraintHost {
  readonly d: SwatTeamDeps;
  readonly hunters: readonly SwatHunter[];
  radio(h: SwatHunter | undefined, text: string, voice: string, force?: boolean): void;
  queueRadio(h: SwatHunter | undefined, text: string, voice: string): void;
}

export interface RestrainJob {
  target: RestrainTarget;
  cuffer: SwatHunter;
  cover: SwatHunter | null;
  /** 手錠をかけた秒数（拘束役が接触距離内にいるあいだ進む） */
  progress: number;
  /** 偽装投降の反撃が起きる進行秒。null = 本物の投降（接触時に一度だけ抽選） */
  fakeAt: number | null;
  rolled: boolean;
}

/**
 * 投降した味方容疑者の拘束（容疑者モード）。
 * 1 人が手錠をかけに行き（約 3.5 秒・対象に正対して無防備）、相方が見張る。この間 SWAT の注意は割れる。
 * 偽装投降の味方は、拘束役が接触して手錠をかけ始めると不意に撃つことがある。
 */
export class SwatRestraint {
  private readonly jobs = new Map<string, RestrainJob>();
  private assignCd = 0;
  /** 統計・テスト用 */
  cuffed = 0;
  betrayed = 0;

  constructor(private readonly host: SwatRestraintHost) {}

  jobFor(targetId: string): RestrainJob | undefined {
    return this.jobs.get(targetId);
  }

  get activeJobs(): number {
    return this.jobs.size;
  }

  /** 拘束に関わっている隊員か（拘束役 / 援護役） */
  involves(h: SwatHunter): boolean {
    for (const j of this.jobs.values()) if (j.cuffer === h || j.cover === h) return true;
    return false;
  }

  update(dt: number): void {
    const provider = this.host.d.restrainables;
    if (!provider && this.jobs.size === 0) return;
    const targets = provider?.() ?? [];
    this.cleanup(dt);
    this.assignCd -= dt;
    if (this.assignCd <= 0) {
      this.assignCd = 0.5;
      this.assign(targets);
    }
    this.progress(dt);
  }

  private release(job: RestrainJob): void {
    for (const h of [job.cuffer, job.cover]) {
      if (h && h.alive && h.state === 'restrain') h.endRestrain();
    }
    this.jobs.delete(job.target.id);
  }

  private cleanup(dt: number): void {
    for (const job of [...this.jobs.values()]) {
      const t = job.target;
      if (!t.alive || !t.surrendered) {
        this.release(job);
        continue;
      }
      // 拘束役が倒れた・交戦に移った・諦めた: 手錠は中断（進行は少し巻き戻す）
      if (!job.cuffer.alive || job.cuffer.state !== 'restrain') {
        job.progress = Math.max(0, job.progress - dt * 2);
        this.release(job);
        continue;
      }
      if (job.cover && (!job.cover.alive || job.cover.state !== 'restrain')) job.cover = null;
    }
  }

  private assign(targets: readonly RestrainTarget[]): void {
    const hs = this.host.hunters;
    // 誰かが交戦中の間は拘束を始めない（まず脅威を片付ける）
    if (hs.some((h) => h.alive && (h.state === 'engage' || h.state === 'rush'))) return;
    for (const t of targets) {
      if (!t.surrendered || this.jobs.has(t.id)) continue;
      const free = hs.filter(
        (h) => h.alive && (h.state === 'sweep' || h.state === 'hunt') && !this.involves(h),
      );
      if (free.length === 0) return;
      const score = (h: SwatHunter): number =>
        Math.hypot(h.body.px - t.px, h.body.pz - t.pz) + Math.abs(h.body.footY - t.footY) * 8 + (h.shielded ? 12 : 0);
      free.sort((a, b) => score(a) - score(b));
      const cuffer = free[0]!;
      if (score(cuffer) > RESTRAIN_MAX_DIST) continue;
      // 援護役: 同じ組の相方を優先し、いなければ最寄りの手の空いた隊員
      const mates = free.filter((h) => h !== cuffer && cuffer.cell.includes(h));
      const cover = mates[0] ?? free.find((h) => h !== cuffer) ?? null;
      const job: RestrainJob = { target: t, cuffer, cover, progress: 0, fakeAt: null, rolled: false };
      this.jobs.set(t.id, job);
      cuffer.beginRestrain(t, 'cuff');
      cover?.beginRestrain(t, 'cover');
      const [ja, en] = pickRadio(RESTRAIN_GO);
      this.host.radio(cuffer, ja, en, true);
    }
  }

  private progress(dt: number): void {
    for (const job of [...this.jobs.values()]) {
      const c = job.cuffer;
      const t = job.target;
      const near =
        Math.abs(c.body.footY - t.footY) < 0.75 && Math.hypot(c.body.px - t.px, c.body.pz - t.pz) <= RESTRAIN_REACH;
      if (!near) continue;
      if (!job.rolled) {
        job.rolled = true;
        // 偽装投降: 手錠をかけ始めた瞬間に一度だけ抽選。進行の途中で不意に撃つ
        if (Math.random() < t.fakeChance) job.fakeAt = CUFF_SEC * (RESTRAIN_FAKE_AT_MIN + Math.random() * RESTRAIN_FAKE_AT_SPAN);
      }
      job.progress += dt;
      if (job.fakeAt !== null && job.progress >= job.fakeAt) {
        const ok = t.betray({ x: c.body.px, y: c.body.footY, z: c.body.pz });
        this.betrayed += ok ? 1 : 0;
        this.release(job);
        if (ok) {
          const [ja, en] = pickRadio(RESTRAIN_FAKE);
          this.host.radio(c, ja, en, true);
          // 至近距離で撃たれた: 拘束役・援護役は即座に交戦へ
          for (const h of [job.cuffer, job.cover]) {
            if (h && h.alive) h.engageFrom({ x: t.px, y: t.footY, z: t.pz });
          }
        }
        continue;
      }
      if (job.progress >= CUFF_SEC) {
        if (t.cuff()) {
          this.cuffed++;
          const [ja, en] = pickRadio(RESTRAIN_DONE);
          this.host.queueRadio(c, ja, en);
        }
        this.release(job);
      }
    }
  }
}
