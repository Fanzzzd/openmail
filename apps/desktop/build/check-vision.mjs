/** Node 24: verify the production adapter with the spike's synthetic samples. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Effect } from "effect";
import { desktopVision } from "../src/main/app/vision.ts";

if (process.platform === "darwin") {
  const dir = await mkdtemp(join(tmpdir(), "openmail-vision-check-"));
  try {
    const generator = join(dir, "generate");
    execFileSync("swiftc", [
      "-O",
      fileURLToPath(new URL("../../../spikes/media/GenerateSamples.swift", import.meta.url)),
      "-o",
      generator,
    ]);
    execFileSync(generator, [dir]);
    const vision = await desktopVision(
      fileURLToPath(new URL("../out/native/vision", import.meta.url)),
    );
    assert.equal(vision.available, true);
    const invalid = await Effect.runPromise(Effect.result(vision.recognize(new Uint8Array([0]))));
    assert.equal(invalid._tag, "Failure");
    const result = await Effect.runPromise(vision.recognize(await readFile(join(dir, "long.png"))));
    assert.equal(result.lines.length, 113);
    const boxes = new Set();
    for (const line of result.lines) {
      const { box, tile, imageWidth, imageHeight } = line.region;
      assert.equal(imageWidth, 900);
      assert.equal(imageHeight, 5200);
      assert.ok(tile.height <= 1024);
      assert.ok(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= imageWidth &&
          box.y + box.height <= imageHeight,
      );
      assert.ok(!boxes.has(line.text));
      boxes.add(line.text);
    }
    process.stdout.write(
      `Vision revision ${result.revision}: 113 unique lines; tall-image tiles and original coordinates passed\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
