import { describe, it, expect } from "vitest";
import { calculatorTool } from "../../src/tools/calculator.js";

async function calc(expression: string): Promise<number> {
  const result = await calculatorTool.execute({ expression });
  return result.result;
}

describe("calculatorTool", () => {
  describe("arithmetic", () => {
    it("adds integers", async () => expect(await calc("2 + 3")).toBe(5));
    it("subtracts", async () => expect(await calc("10 - 4")).toBe(6));
    it("multiplies", async () => expect(await calc("6 * 7")).toBe(42));
    it("divides", async () => expect(await calc("15 / 4")).toBe(3.75));
    it("handles modulo", async () => expect(await calc("17 % 5")).toBe(2));
    it("handles exponentiation", async () => expect(await calc("2 ** 10")).toBe(1024));
    it("respects operator precedence: * before +", async () =>
      expect(await calc("2 + 3 * 4")).toBe(14));
    it("respects parentheses", async () => expect(await calc("(2 + 3) * 4")).toBe(20));
    it("handles unary negation", async () => expect(await calc("-5 + 3")).toBe(-2));
    it("handles floating point", async () => expect(await calc("0.1 + 0.2")).toBeCloseTo(0.3));
  });

  describe("math functions", () => {
    it("sqrt", async () => expect(await calc("sqrt(144)")).toBe(12));
    it("abs of negative", async () => expect(await calc("abs(-7)")).toBe(7));
    it("floor", async () => expect(await calc("floor(3.9)")).toBe(3));
    it("ceil", async () => expect(await calc("ceil(3.1)")).toBe(4));
    it("round", async () => expect(await calc("round(3.5)")).toBe(4));
    it("min with multiple args", async () => expect(await calc("min(5, 3, 8, 1)")).toBe(1));
    it("max with multiple args", async () => expect(await calc("max(5, 3, 8, 1)")).toBe(8));
    it("log (natural)", async () => expect(await calc("log(1)")).toBe(0));
  });

  describe("trigonometry and logarithms", () => {
    it("sin(0) = 0", async () => expect(await calc("sin(0)")).toBe(0));
    it("cos(0) = 1", async () => expect(await calc("cos(0)")).toBe(1));
    it("tan(0) = 0", async () => expect(await calc("tan(0)")).toBe(0));
    it("log2(8) = 3", async () => expect(await calc("log2(8)")).toBe(3));
    it("log10(100) = 2", async () => expect(await calc("log10(100)")).toBe(2));
  });

  describe("named constants", () => {
    it("pi", async () => expect(await calc("pi")).toBeCloseTo(Math.PI));
    it("e", async () => expect(await calc("e")).toBeCloseTo(Math.E));
  });

  describe("scientific notation and special values", () => {
    it("parses integer scientific notation: 1e3 = 1000", async () =>
      expect(await calc("1e3")).toBe(1000));
    it("parses negative exponent: 2.5e-2 = 0.025", async () =>
      expect(await calc("2.5e-2")).toBeCloseTo(0.025));
    it("Infinity constant", async () => expect(await calc("Infinity")).toBe(Infinity));
  });

  describe("complex expressions", () => {
    it("nested function calls", async () => expect(await calc("sqrt(max(4, 9, 16))")).toBe(4));
    it("right-associative exponentiation: 2**2**3 = 2^(2^3) = 256", async () =>
      expect(await calc("2 ** 2 ** 3")).toBe(256));
    it("expression with extra whitespace", async () =>
      expect(await calc("  ( 3 + 4 )  *  2  ")).toBe(14));
  });

  describe("error cases", () => {
    it("throws on division by zero", async () => {
      await expect(calc("1 / 0")).rejects.toThrow("Division by zero");
    });

    it("throws on unknown function", async () => {
      await expect(calc("evil(1)")).rejects.toThrow(/Unknown function/);
    });

    it("throws on malformed expression", async () => {
      await expect(calc("2 +")).rejects.toThrow();
    });

    it("throws on unmatched parenthesis", async () => {
      await expect(calc("(2 + 3")).rejects.toThrow();
    });

    it("does NOT evaluate arbitrary JavaScript (security)", async () => {
      // The parser accepts only the declared grammar - identifiers that are
      // not in ALLOWED_FUNCTIONS or named constants are rejected immediately.
      await expect(calc("process.exit(0)")).rejects.toThrow();
      await expect(calc("require('fs')")).rejects.toThrow();
    });
  });

  describe("summarize hook", () => {
    it("returns the expression string directly", () => {
      // summarize is used by renderTrace to label the call in the execution tree.
      expect(calculatorTool.summarize?.({ expression: "sqrt(144)" })).toBe("sqrt(144)");
    });
  });
});
