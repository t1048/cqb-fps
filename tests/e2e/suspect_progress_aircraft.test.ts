import { afterAll, describe, it } from 'vitest';
import { CASES, HOLD_SEC, checkSuspectProgress, type RunResult } from './helpers/suspectProgress';

const TPL = 'air_force_one' as const;
const ONLY = process.env.PROGRESS_ONLY ?? '';

/** random_air_force_one（air_force_one.json）: 大統領専用機・最大 3 デッキ・タラップ突入。 */
describe(`Suspect mode progress — ${TPL}`, () => {
  const done: RunResult[] = [];
  afterAll(() => {
    if (done.length === 0) return;
    const ts = done.map((r) => r.seeSec ?? HOLD_SEC).sort((a, b) => a - b);
    const avg = ts.reduce((a, b) => a + b, 0) / ts.length;
    console.log(
      `[progress-summary] ${TPL}: n=${ts.length} time-to-contact avg=${avg.toFixed(1)}s median=${ts[Math.floor(ts.length / 2)]!.toFixed(1)}s max=${ts[ts.length - 1]!.toFixed(1)}s`,
    );
  });
  for (const seed of CASES[TPL]) {
    if (ONLY && ONLY !== `${TPL}:${seed}`) continue;
    it(`seed ${seed}: breaches locked doors, keeps clearing, reaches the player`, () => {
      done.push(checkSuspectProgress(TPL, seed));
    }, 180000);
  }
});
