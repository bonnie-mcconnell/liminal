import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

const inputSchema = z.object({
  expression: z
    .string()
    .min(1)
    .describe(
      "A mathematical expression. Supports +, -, *, /, **, %, parentheses, " +
        "and: abs, sqrt, floor, ceil, round, min, max, log, log2, log10, sin, cos, tan. " +
        "Constants: pi, e. Examples: '(3 + 4) * 2', 'sqrt(144)', 'max(3, 7, 2)'",
    ),
});

const outputSchema = z.object({
  result: z.number(),
  expression: z.string(),
});

/**
 * Evaluates math expressions via a recursive-descent parser - no eval().
 *
 * eval() is not acceptable here: the model controls the input and could
 * inject arbitrary code. The parser implements this grammar (low to high
 * precedence):
 *
 *   expr     = additive
 *   additive = multiplicative (('+' | '-') multiplicative)*
 *   mult     = unary (('*' | '/' | '%') unary)*
 *   unary    = '-' unary | power
 *   power    = primary ('**' unary)?          (right-associative)
 *   primary  = number | name '(' args ')' | '(' expr ')'
 */
export const calculatorTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "calculator",
  description:
    "Evaluates a mathematical expression and returns the numeric result. " +
    "Use for arithmetic, percentages, and basic math functions. " +
    "Not for string manipulation or logical operations.",
  inputSchema,
  outputSchema,
  execute: ({ expression }) => Promise.resolve({ result: parseExpression(expression), expression }),
  summarize: ({ expression }) => expression,
  policy: {
    cache: { strategy: "content-hash", ttlMs: 24 * 60 * 60 * 1000, vary: [], maxEntries: 512 },
    retry: {
      maxAttempts: 1,
      backoff: "none",
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitterMs: 0,
      shouldRetry: () => false,
    },
    timeoutMs: 1_000,
  },
};

const ALLOWED_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
};

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): number {
    const result = this.parseAdditive();
    this.skipWhitespace();
    if (this.pos < this.src.length) {
      throw new SyntaxError(
        `Unexpected character at position ${String(this.pos)}: "${this.src[this.pos] ?? "EOF"}"`,
      );
    }
    return result;
  }

  private parseAdditive(): number {
    let left = this.parseMultiplicative();
    this.skipWhitespace();
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch !== "+" && ch !== "-") break;
      this.pos++;
      const right = this.parseMultiplicative();
      left = ch === "+" ? left + right : left - right;
      this.skipWhitespace();
    }
    return left;
  }

  private parseMultiplicative(): number {
    let left = this.parseUnary();
    this.skipWhitespace();
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch !== "*" && ch !== "/" && ch !== "%") break;
      if (ch === "*" && this.src[this.pos + 1] === "*") break;
      this.pos++;
      const right = this.parseUnary();
      if (ch === "*") left = left * right;
      else if (ch === "/") {
        if (right === 0) throw new RangeError("Division by zero");
        left = left / right;
      } else {
        left = left % right;
      }
      this.skipWhitespace();
    }
    return left;
  }

  private parseUnary(): number {
    this.skipWhitespace();
    if (this.src[this.pos] === "-") {
      this.pos++;
      return -this.parsePower();
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    this.skipWhitespace();
    if (this.src.slice(this.pos, this.pos + 2) === "**") {
      this.pos += 2;
      return Math.pow(base, this.parseUnary());
    }
    return base;
  }

  private parsePrimary(): number {
    this.skipWhitespace();

    if (this.src[this.pos] === "(") {
      this.pos++;
      const value = this.parseAdditive();
      this.skipWhitespace();
      if (this.src[this.pos] !== ")") throw new SyntaxError('Expected ")"');
      this.pos++;
      return value;
    }

    // -? is dead here - parseUnary() consumes any leading minus before we arrive.
    const numMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (numMatch !== null) {
      this.pos += numMatch[0].length;
      return parseFloat(numMatch[0]);
    }

    const nameMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(this.src.slice(this.pos));
    if (nameMatch !== null) {
      const name = nameMatch[0];
      this.pos += name.length;
      this.skipWhitespace();

      if (this.src[this.pos] === "(") {
        this.pos++;
        const args: number[] = [];
        if (this.src[this.pos] !== ")") {
          args.push(this.parseAdditive());
          this.skipWhitespace();
          while (this.src[this.pos] === ",") {
            this.pos++;
            args.push(this.parseAdditive());
            this.skipWhitespace();
          }
        }
        if (this.src[this.pos] !== ")") throw new SyntaxError('Expected ")"');
        this.pos++;

        const fn = ALLOWED_FUNCTIONS[name];
        if (fn === undefined) {
          throw new ReferenceError(
            `Unknown function "${name}". Allowed: ${Object.keys(ALLOWED_FUNCTIONS).join(", ")}`,
          );
        }
        return fn(...args);
      }

      if (name === "pi" || name === "PI") return Math.PI;
      if (name === "e" || name === "E") return Math.E;
      if (name === "Infinity") return Infinity;

      throw new ReferenceError(`Unknown identifier "${name}"`);
    }

    throw new SyntaxError(
      `Unexpected token at position ${String(this.pos)}: "${this.src[this.pos] ?? "EOF"}"`,
    );
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos] ?? "")) {
      this.pos++;
    }
  }
}

function parseExpression(expr: string): number {
  try {
    return new Parser(expr.trim()).parse();
  } catch (err) {
    throw new Error(
      `Cannot evaluate "${expr}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
