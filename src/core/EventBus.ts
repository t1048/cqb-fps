/** 型付き EventBus。Events は `{ イベント名: ペイロード型 }` のマップ。 */
export type Handler<T> = (payload: T) => void;

export class EventBus<Events extends object> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  /** 購読。戻り値の関数で解除できる。 */
  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(type, handler);
  }

  off<K extends keyof Events>(type: K, handler: Handler<Events[K]>): void {
    const set = this.handlers.get(type);
    if (!set) return;
    set.delete(handler as Handler<never>);
    if (set.size === 0) this.handlers.delete(type);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    // emit 中の on/off に影響されないようコピーして走査
    for (const h of [...set]) {
      (h as Handler<Events[K]>)(payload);
    }
  }

  /** type 指定でそのイベントの全購読、省略で全イベントの全購読を解除。 */
  clear(type?: keyof Events): void {
    if (type === undefined) this.handlers.clear();
    else this.handlers.delete(type);
  }
}
