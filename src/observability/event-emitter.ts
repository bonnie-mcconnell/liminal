/**
 * Minimal synchronous typed event emitter.
 *
 * Deliberately avoids Node's `EventEmitter` - that class carries significant
 * API surface (wildcard listeners, error events, domain integration) that
 * adds complexity without benefit here. This implementation is ~40 lines,
 * works in any JavaScript runtime, and is fully typed.
 *
 * **Synchronous by design.** Listeners are called synchronously in
 * registration order. A listener that throws will propagate the error to the
 * caller of `emit`, which in the executor is always caught by the surrounding
 * try/catch. If you need async listeners, wrap emission in a microtask:
 * `queueMicrotask(() => emitter.emit(event))`.
 *
 * @example
 * ```ts
 * const emitter = new EventEmitter<ToolEvent>();
 *
 * const off = emitter.on((event) => {
 *   if (event.type === "succeeded") {
 *     console.log(`${event.toolName} finished in ${event.durationMs}ms`);
 *   }
 * });
 *
 * // Later, when cleanup is needed:
 * off();
 * ```
 */
export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  /**
   * Registers a listener. Returns an unsubscribe function.
   *
   * The returned function is idempotent - calling it multiple times is safe.
   */
  on(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Emits an event to all registered listeners in registration order.
   *
   * Listeners are called synchronously. A listener that throws will abort
   * emission for subsequent listeners - callers should wrap `emit` in
   * try/catch if listener errors must not interrupt execution flow.
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
