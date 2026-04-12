import { describe, it, expect } from "vitest";
import { EventEmitter } from "../../src/observability/event-emitter.js";

type TestEvent = { type: "a"; value: number } | { type: "b"; label: string };

describe("EventEmitter", () => {
  describe("on / emit", () => {
    it("calls a registered listener with the emitted event", () => {
      const emitter = new EventEmitter<TestEvent>();
      const received: TestEvent[] = [];
      emitter.on((e) => received.push(e));

      emitter.emit({ type: "a", value: 42 });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ type: "a", value: 42 });
    });

    it("calls multiple listeners in registration order", () => {
      const emitter = new EventEmitter<TestEvent>();
      const order: number[] = [];
      emitter.on(() => order.push(1));
      emitter.on(() => order.push(2));
      emitter.on(() => order.push(3));

      emitter.emit({ type: "b", label: "x" });

      expect(order).toEqual([1, 2, 3]);
    });

    it("delivers every emitted event to all listeners", () => {
      const emitter = new EventEmitter<TestEvent>();
      const received: TestEvent[] = [];
      emitter.on((e) => received.push(e));

      emitter.emit({ type: "a", value: 1 });
      emitter.emit({ type: "b", label: "hello" });
      emitter.emit({ type: "a", value: 2 });

      expect(received).toHaveLength(3);
      expect(received.map((e) => e.type)).toEqual(["a", "b", "a"]);
    });

    it("does nothing when there are no listeners", () => {
      const emitter = new EventEmitter<TestEvent>();
      expect(() => emitter.emit({ type: "a", value: 1 })).not.toThrow();
    });
  });

  describe("unsubscribe", () => {
    it("stops delivering events after the returned off() is called", () => {
      const emitter = new EventEmitter<TestEvent>();
      const received: TestEvent[] = [];
      const off = emitter.on((e) => received.push(e));

      emitter.emit({ type: "a", value: 1 });
      off();
      emitter.emit({ type: "a", value: 2 });

      expect(received).toHaveLength(1);
    });

    it("is idempotent - calling off() multiple times does not throw", () => {
      const emitter = new EventEmitter<TestEvent>();
      const off = emitter.on(() => {});
      expect(() => {
        off();
        off();
        off();
      }).not.toThrow();
    });

    it("removing one listener does not affect others", () => {
      const emitter = new EventEmitter<TestEvent>();
      const a: number[] = [];
      const b: number[] = [];
      const offA = emitter.on((e) => {
        if (e.type === "a") a.push(e.value);
      });
      emitter.on((e) => {
        if (e.type === "a") b.push(e.value);
      });

      offA();
      emitter.emit({ type: "a", value: 99 });

      expect(a).toHaveLength(0);
      expect(b).toEqual([99]);
    });
  });

  describe("listenerCount", () => {
    it("reflects the current number of registered listeners", () => {
      const emitter = new EventEmitter<TestEvent>();
      expect(emitter.listenerCount).toBe(0);

      const off1 = emitter.on(() => {});
      expect(emitter.listenerCount).toBe(1);

      const off2 = emitter.on(() => {});
      expect(emitter.listenerCount).toBe(2);

      off1();
      expect(emitter.listenerCount).toBe(1);

      off2();
      expect(emitter.listenerCount).toBe(0);
    });
  });

  describe("error isolation", () => {
    it("a throwing listener propagates the error to the emit caller", () => {
      const emitter = new EventEmitter<TestEvent>();
      emitter.on(() => {
        throw new Error("oops");
      });
      expect(() => emitter.emit({ type: "a", value: 1 })).toThrow("oops");
    });

    it("a throwing listener prevents subsequent listeners from running in the same emit call", () => {
      // This documents the known behaviour - callers that need isolation must
      // wrap emit in try/catch (as ToolExecutor does).
      const emitter = new EventEmitter<TestEvent>();
      const reached: number[] = [];
      emitter.on(() => {
        throw new Error("first throws");
      });
      emitter.on(() => reached.push(2));

      try {
        emitter.emit({ type: "a", value: 1 });
      } catch {
        /* expected */
      }

      // Second listener was NOT reached because the first threw.
      expect(reached).toHaveLength(0);
    });
  });

  describe("type narrowing", () => {
    it("allows discriminating on event.type inside a listener", () => {
      const emitter = new EventEmitter<TestEvent>();
      const values: number[] = [];

      emitter.on((event) => {
        if (event.type === "a") values.push(event.value);
      });

      emitter.emit({ type: "a", value: 7 });
      emitter.emit({ type: "b", label: "ignored" });
      emitter.emit({ type: "a", value: 13 });

      expect(values).toEqual([7, 13]);
    });
  });
});
