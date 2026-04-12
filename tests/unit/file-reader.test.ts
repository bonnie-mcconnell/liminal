import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileReaderTool } from "../../src/tools/file-reader.js";

const TMP = join(process.cwd(), ".test-tmp-file-reader");

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await writeFile(join(TMP, "hello.txt"), "Hello, world!");
  await writeFile(join(TMP, "big.txt"), "x".repeat(200));
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

async function read(path: string, opts: { maxBytes?: number; encoding?: "utf-8" | "base64" } = {}) {
  return fileReaderTool.execute({
    path,
    encoding: opts.encoding ?? "utf-8",
    maxBytes: opts.maxBytes ?? 100_000,
  });
}

describe("fileReaderTool", () => {
  it("reads the full contents of a file", async () => {
    const result = await read(".test-tmp-file-reader/hello.txt");
    expect(result.content).toBe("Hello, world!");
    expect(result.truncated).toBe(false);
    expect(result.sizeBytes).toBe(13);
  });

  it("truncates files that exceed maxBytes and sets truncated: true", async () => {
    const result = await read(".test-tmp-file-reader/big.txt", { maxBytes: 50 });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("[... file truncated");
    expect(result.content.slice(0, 50)).toBe("x".repeat(50));
  });

  it("rejects absolute paths", async () => {
    await expect(read("/etc/passwd")).rejects.toThrow(/Absolute paths/);
  });

  it("rejects directory traversal via ../", async () => {
    await expect(read("../../etc/passwd")).rejects.toThrow(/traversal/);
  });

  it("rejects a path that escapes cwd after normalization", async () => {
    await expect(read(".test-tmp-file-reader/../../secret")).rejects.toThrow(/traversal/);
  });

  it("throws when the file does not exist", async () => {
    await expect(read(".test-tmp-file-reader/nonexistent.txt")).rejects.toThrow(
      /not found|inaccessible/,
    );
  });

  it("reads a file as base64 when encoding is 'base64'", async () => {
    const result = await read(".test-tmp-file-reader/hello.txt", { encoding: "base64" });
    expect(result.encoding).toBe("base64");
    expect(Buffer.from(result.content, "base64").toString("utf-8")).toBe("Hello, world!");
    expect(result.truncated).toBe(false);
  });

  it("rejects a directory path", async () => {
    await expect(read(".test-tmp-file-reader")).rejects.toThrow(/not a file/);
  });
});
