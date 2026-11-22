/**
 * JSON の取得失敗・検証失敗を表すエラー。どのファイルのどのパスかを含む。
 * DataLoader（再エクスポート）と生成器（world/generator）の双方が循環 import なしに使えるよう、依存のない独立ファイルに置く。
 */
export class DataError extends Error {
  constructor(
    public readonly source: string,
    public readonly path: string,
    detail: string,
  ) {
    super(`[DataLoader] ${source} @ ${path || '(root)'}: ${detail}`);
    this.name = 'DataError';
  }
}
