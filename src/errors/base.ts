/**
 * Base class for all errors thrown or returned by this library.
 *
 * Subclasses carry a machine-readable `code` so callers can switch on it
 * without string-matching the message. The `cause` field (standard on `Error`
 * since ES2022) preserves the original error when wrapping, keeping the full
 * stack trace intact across error boundaries.
 */
export abstract class LiminalError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    // Restores instanceof for subclasses - broken by transpiled super() on built-ins.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
  }
}
