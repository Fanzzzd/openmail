import { vi } from "vitest";
import * as fs from "node:fs";
import nodeAssert from "node:assert/strict";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelFiles, type ModelFile } from "./platform/node/model-downloads.js";
import { MODEL_BYTES, MODEL_FILES } from "./model-manifest.js";

vi.mock("node:fs", async (importOriginal) => {
  const module = await importOriginal<typeof import("node:fs")>();
  return { ...module, createReadStream: vi.fn(module.createReadStream) };
});
const bytes = new TextEncoder().encode("synthetic model file");
const manifest: ModelFile = {
  model: "fixture/model",
  revision: "abc",
  file: "config.json",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const fixture = async (run: (dir: string, file: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "openmail-model-download-"));
  const file = join(dir, manifest.model, manifest.file);
  try {
    await mkdir(join(dir, manifest.model), { recursive: true });
    await run(dir, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

it("selected pinned files match the ~226 MB mixed precision bundle", () => {
  assert.ok(MODEL_BYTES > 225_000_000 && MODEL_BYTES < 227_000_000);
  assert.ok(MODEL_FILES.some((file) => file.file === "onnx/vision_model.onnx"));
  assert.ok(!MODEL_FILES.some((file) => file.file.includes("vision_model_quantized")));
  assert.ok(MODEL_FILES.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
});

it("read-only ensure never fetches and a verified file is reused", async () =>
  fixture(async (dir, file) => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      throw new Error("network forbidden");
    };
    const missing = await Effect.runPromise(
      Effect.result(modelFiles(dir, false, () => null, { files: [manifest], fetch })),
    );
    assert.strictEqual(missing._tag, "Failure");
    assert.strictEqual(calls, 0);
    await writeFile(file, bytes);
    await Effect.runPromise(modelFiles(dir, false, () => null, { files: [manifest], fetch }));
    await Effect.runPromise(modelFiles(dir, true, () => null, { files: [manifest], fetch }));
    assert.strictEqual(calls, 0);
  }));

it("resumes a verified range request and publishes the completed file atomically", async () =>
  fixture(async (dir, file) => {
    await writeFile(`${file}.part`, bytes.slice(0, 5));
    const values: number[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      assert.strictEqual(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "https://huggingface.co/fixture/model/resolve/abc/config.json",
      );
      assert.strictEqual(init?.method, "GET");
      assert.strictEqual(new Headers(init?.headers).get("Range"), "bytes=5-");
      assert.strictEqual(init?.body, undefined);
      return new Response(bytes.slice(5), {
        status: 206,
        headers: { "content-range": `bytes 5-${bytes.length - 1}/${bytes.length}` },
      });
    };
    await Effect.runPromise(
      modelFiles(
        dir,
        true,
        (state) => {
          if (state.kind === "downloading") values.push(state.bytes);
        },
        { files: [manifest], fetch },
      ),
    );
    assert.deepStrictEqual(new Uint8Array(await readFile(file)), bytes);
    assert.strictEqual(values[0], 5);
    assert.strictEqual(values.at(-1), bytes.length);
  }));

it("ignores stale partial bytes when the server returns a full 200 response", async () =>
  fixture(async (dir, file) => {
    await writeFile(`${file}.part`, bytes.slice(0, 5));
    const fetch: typeof globalThis.fetch = async () => new Response(bytes);
    await Effect.runPromise(modelFiles(dir, true, () => null, { files: [manifest], fetch }));
    assert.deepStrictEqual(new Uint8Array(await readFile(file)), bytes);
  }));

it("a complete wrong hash is rejected and removed; interruption keeps a resumable prefix", async () =>
  fixture(async (dir, file) => {
    const corrupt: typeof globalThis.fetch = async () => new Response(new Uint8Array(bytes.length));
    const result = await Effect.runPromise(
      Effect.result(modelFiles(dir, true, () => null, { files: [manifest], fetch: corrupt })),
    );
    assert.strictEqual(result._tag, "Failure");
    await nodeAssert.rejects(stat(file));
    await nodeAssert.rejects(stat(`${file}.part`));
    const interrupted: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 5));
          },
          pull(controller) {
            controller.error(new Error("disconnected"));
          },
        }),
      );
    const failed = await Effect.runPromise(
      Effect.result(modelFiles(dir, true, () => null, { files: [manifest], fetch: interrupted })),
    );
    assert.strictEqual(failed._tag, "Failure");
    assert.strictEqual((await stat(`${file}.part`)).size, 5);
  }));

it("verification cache skips file byte reads but notices a modified model", async () =>
  fixture(async (dir, file) => {
    await writeFile(file, bytes);
    const cache = new Map<string, string>();
    const reader = vi.spyOn(fs, "createReadStream");
    try {
      await Effect.runPromise(modelFiles(dir, false, () => null, { files: [manifest], cache }));
      const reads = reader.mock.calls.length;
      assert.strictEqual(reads, 1);
      await Effect.runPromise(modelFiles(dir, false, () => null, { files: [manifest], cache }));
      assert.strictEqual(reader.mock.calls.length, reads);
      await writeFile(file, new Uint8Array(bytes.length));
      const changed = await Effect.runPromise(
        modelFiles(dir, false, () => null, { files: [manifest], cache }).pipe(Effect.result),
      );
      assert.strictEqual(changed._tag, "Failure");
      assert.strictEqual(reader.mock.calls.length, reads + 1);
    } finally {
      reader.mockRestore();
    }
  }));
