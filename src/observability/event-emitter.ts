/**
 * Minimal synchronous typed event emitter.
 *
 * Avoids Node's `EventEmitter` deliberately - that class carries wildcard
 * listeners, error events, and domain integration that add complexity without
 * benefit here. This is ~40 lines, works in any JS runtime, and is fully typed.
 *
 * Listeners are called synchronously in registration order. For async work,
 * use `queueMicrotask(() => emitter.emit(event))` at the call site.
 */
export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  /** Registers a listener. Returns an idempotent unsubscribe function. */
  on(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Emits an event to all listeners in registration order.
   * A throwing listener aborts emission for subsequent listeners -
   * wrap in try/catch if that must not happen.
   */
  emit(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Returns the number of currently registered listeners. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}
