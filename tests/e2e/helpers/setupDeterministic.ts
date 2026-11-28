import { afterEach, beforeEach, vi } from 'vitest';
import { seedRandom } from './seededRandom';

/**
 * e2e は AI の判断・命中のばらつきに Math.random を使うため、テストごとに同じ種で固定して
 * 実行ごとに結果が揺れないようにする（CI で偶発的に落ちない）。個別に別の種が要るテストは
 * その中で seedRandom を呼び直せばよい。
 */
beforeEach(() => {
  seedRandom(0x5eed);
});

afterEach(() => {
  vi.restoreAllMocks();
});
