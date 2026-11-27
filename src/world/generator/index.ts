import type { GeneratedMapRaw, GeneratorTemplate, MotifId } from '../../core/types';
import { dressWithMotif } from '../Motif';
import { applyMotifScenes } from '../MotifScenes';
import { generateAircraft } from './AircraftGenerator';
import { generateHouse } from './HouseGenerator';
import { generateModularMap } from './ModularGenerator';
import { normalizeSeed } from './Rng';

export { normalizeSeed, randomSeed } from './Rng';
export type { GeneratedMapRaw } from '../../core/types';
export { FallbackInfeasibleError, verifyFallbackFeasibility } from './ModularGenerator';
export { pickStageVariant } from './StageVariant';

/**
 * 生成テンプレートの type に応じて間取りを生成する（結果は MapData 互換の生オブジェクト。呼び出し側で validateMap する）。
 * seed は有限数値なら何でもよく、冒頭で uint32 に正規化する（出力 seed も正規化後の値）。
 * type "modular" / "aircraft" は doors.json の扉リーフ高 doorLeafHeight（>= 2.05m）が必須。
 * 新しい建物タイプ（ガソリンスタンド等）はここに分岐を追加する。
 */
export function generateMap(
  template: GeneratorTemplate,
  seed: number,
  mapId: string,
  doorLeafHeight?: number,
  motifId?: MotifId,
): GeneratedMapRaw {
  const normSeed = normalizeSeed(seed);
  if (template.type === 'aircraft') {
    if (doorLeafHeight === undefined) {
      throw new Error(`[generator:${template.id}] type "aircraft" の生成には doors.json の扉高 (doorLeafHeight) が必要です`);
    }
    return generateAircraft(template, normSeed, mapId, doorLeafHeight);
  }
  const raw = (() => {
    switch (template.type) {
      case 'house':
        return generateHouse(template, normSeed, mapId);
      case 'modular':
        if (doorLeafHeight === undefined) {
          throw new Error(`[generator:${template.id}] type "modular" の生成には doors.json の扉高 (doorLeafHeight) が必要です`);
        }
        return generateModularMap(template, normSeed, mapId, doorLeafHeight, motifId);
    }
  })();
  // 座標・扉・スポーンは生成器のまま。見た目のモチーフと、後付けの小道具・吹き抜けを足す。
  return applyMotifScenes(dressWithMotif(raw, normSeed, motifId));
}
