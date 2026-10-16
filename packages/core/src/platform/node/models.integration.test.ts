import { modelFiles } from "./model-downloads.js";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { makeNodeModels } from "./embeddings-node.js";
import { scaledMs } from "../../../test-support/test-time.js";

const root = fileURLToPath(new URL("../../../spikes/media/models/", import.meta.url));
const optedIn = process.env.OPENMAIL_TEST_MODELS === "1";
const present =
  existsSync(join(root, "Xenova/multilingual-e5-small/onnx/model_quantized.onnx")) &&
  existsSync(join(root, "Xenova/mobileclip_s0/onnx/vision_model.onnx"));
function crc(data: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function png(width: number, height: number) {
  const chunk = (name: string, bytes: Buffer) => {
    const type = Buffer.from(name);
    const out = Buffer.alloc(bytes.length + 12);
    out.writeUInt32BE(bytes.length);
    type.copy(out, 4);
    bytes.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([type, bytes])), bytes.length + 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 220);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const norm = (vector: readonly number[]) =>
  Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
const dot = (a: readonly number[], b: readonly number[]) =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

it.skipIf(!optedIn || !present)(
  "opt-in real local models: E5 pooling/prefixes, MobileCLIP77 and whole plus tall tiles",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "openmail-real-models-"));
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const models = yield* makeNodeModels(dir, root, {
            prepare: (path, _download, progress, options) =>
              modelFiles(path, false, progress, options),
          });
          assert.strictEqual((yield* models.status).kind, "disabled");
          yield* models.ensure(true);
          const flight = yield* models.embedder.text(
            "The airline ticket confirms a flight from Singapore to Shanghai. Bring your passport and boarding pass.",
            "passage",
          );
          const code = yield* models.embedder.text(
            "The TypeScript program indexes images locally and stores vectors in SQLite.",
            "passage",
          );
          const query = yield* models.embedder.text(
            "从新加坡飞往上海的航班，需要护照和登机牌",
            "query",
          );
          assert.strictEqual(flight.length, 384);
          assert.ok(Math.abs(norm(flight) - 1) < 1e-4);
          assert.ok(dot(query, flight) > dot(query, code));
          const clip = yield* models.images.query("airline ticket");
          assert.strictEqual(clip.length, 512);
          assert.ok(Math.abs(norm(clip) - 1) < 1e-4);
          const images = yield* models.images.image(png(80, 2300));
          assert.strictEqual(images.length, 4);
          assert.strictEqual(images[0]?.region.box.height, 2300);
          assert.deepStrictEqual(
            images.slice(1).map((image) => image.region.tile.y),
            [0, 896, 1792],
          );
          assert.ok(
            images.every(
              (image) => image.vector.length === 512 && Math.abs(norm(image.vector) - 1) < 1e-4,
            ),
          );
          yield* models.stop();
          assert.strictEqual((yield* models.status).kind, "disabled");
        }).pipe(Effect.scoped),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  scaledMs(60_000),
);
