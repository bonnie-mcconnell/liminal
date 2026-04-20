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

  it("rejects Windows UNC paths on Windows (\\\\server\\share\\file)", async () => {
    // On Windows, UNC paths (\\server\share\file) are absolute - path.isAbsolute()
    // returns true for them, so our fix catches them. On Linux, backslashes have
    // no special meaning and the same string is treated as a relative path, which
    // resolves inside cwd and fails at the filesystem level (file not found).
    // Either way, the path cannot be used to escape the sandbox.
    if (process.platform === "win32") {
      await expect(read("\\\\server\\share\\secret.txt")).rejects.toThrow(/Absolute paths/);
    } else {
      // On Linux: resolves inside cwd, no file with that name exists
      await expect(read("\\\\server\\share\\secret.txt")).rejects.toThrow(
        /not found|inaccessible|traversal|Absolute/,
      );
    }
  });

  it("does not corrupt base64 output when the file is truncated", async () => {
    // Appending the truncation marker to a base64-encoded payload corrupts it -
    // the marker bytes get interpreted as base64 data during decoding.
    // When encoding is base64, the content must be a valid base64 string.
    const result = await read(".test-tmp-file-reader/big.txt", {
      maxBytes: 50,
      encoding: "base64",
    });
    expect(result.truncated).toBe(true);
    // The content must be decodable as pure base64 - no truncation marker appended.
    expect(() => Buffer.from(result.content, "base64")).not.toThrow();
    // And it must not contain the marker string
    expect(result.content).not.toContain("[... file truncated");
    // The decoded length must match the requested byte limit
    expect(Buffer.from(result.content, "base64").length).toBe(50);
  });

  describe("retry policy", () => {
    const retry = fileReaderTool.policy?.retry;

    it("retries on EMFILE (too many open files)", () => {
      expect(retry?.shouldRetry(new Error("EMFILE: too many open files"), 1)).toBe(true);
    });

    it("retries on EAGAIN (resource temporarily unavailable)", () => {
      expect(retry?.shouldRetry(new Error("EAGAIN: resource temporarily unavailable"), 1)).toBe(
        true,
      );
    });

    it("does not retry on ENOENT or other errors", () => {
      expect(retry?.shouldRetry(new Error("ENOENT: no such file or directory"), 1)).toBe(false);
    });
  });

  describe("AbortSignal", () => {
    it("throws when the signal is already aborted before any I/O", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        fileReaderTool.execute(
          { path: "README.md", encoding: "utf-8", maxBytes: 100_000 },
          controller.signal,
        ),
      ).rejects.toThrow();
    });

    it("succeeds with a non-aborted signal", async () => {
      const controller = new AbortController();
      const result = await fileReaderTool.execute(
        { path: "README.md", encoding: "utf-8", maxBytes: 100_000 },
        controller.signal,
      );
      expect(result.truncated).toBe(false);
      expect(typeof result.content).toBe("string");
    });
  });
});
