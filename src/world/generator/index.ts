import type { GeneratedMapRaw, GeneratorTemplate } from '../../core/types';
import { generateHouse } from './HouseGenerator';
import { generateModularMap } from './ModularGenerator';
import { normalizeSeed } from './Rng';

export { normalizeSeed, randomSeed } from './Rng';
export type { GeneratedMapRaw } from '../../core/types';
export { FallbackInfeasibleError, verifyFallbackFeasibility } from './ModularGenerator';

/**
 * 生成テンプレートの type に応じて間取りを生成する（結果は MapData 互換の生オブジェクト。呼び出し側で validateMap する）。
 * seed は有限数値なら何でもよく、冒頭で uint32 に正規化する（出力 seed も正規化後の値）。
 * type "modular" は doors.json の扉リーフ高 doorLeafHeight（>= 2.05m）が必須。
 * 新しい建物タイプ（ガソリンスタンド等）はここに分岐を追加する。
 */
export function generateMap(template: GeneratorTemplate, seed: number, mapId: string, doorLeafHeight?: number): GeneratedMapRaw {
  const normSeed = normalizeSeed(seed);
  switch (template.type) {
    case 'house':
      return generateHouse(template, normSeed, mapId);
    case 'modular':
      if (doorLeafHeight === undefined) {
        throw new Error(`[generator:${template.id}] type "modular" の生成には doors.json の扉高 (doorLeafHeight) が必要です`);
      }
      return generateModularMap(template, normSeed, mapId, doorLeafHeight);
  }
}
