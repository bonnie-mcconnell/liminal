/** @type {import("eslint").Linter.Config} */
module.exports = {
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "./tsconfig.test.json",
    tsconfigRootDir: __dirname,
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/strict-type-checked",
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    "no-console": ["warn", { allow: ["error"] }],
  },
  ignorePatterns: ["dist/", "vitest.config.ts"],
  overrides: [
    {
      // The demo script uses console.log intentionally - it is a CLI tool.
      files: ["examples/**/*.ts", "benchmarks/**/*.ts"],
      rules: { "no-console": "off" },
    },
    {
      // Test files use patterns that are valid in test context but flagged by
      // strict production rules: non-null assertions on known-good fixture data,
      // async stubs without await, arrow shorthands returning void, and inline
      // import() for type-level assertions.
      files: ["tests/**/*.ts"],
      rules: {
        "@typescript-eslint/no-non-null-assertion": "off",
        "@typescript-eslint/require-await": "off",
        "@typescript-eslint/no-confusing-void-expression": "off",
        "@typescript-eslint/consistent-type-imports": "off",
        "@typescript-eslint/no-unnecessary-condition": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/restrict-template-expressions": "off",
      },
    },
  ],
};
