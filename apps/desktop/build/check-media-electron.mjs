import { desktopInferenceProcess } from "../src/main/app/inference.ts";
import { modelFiles } from "../../../packages/core/dist/platform/node/model-downloads.js";
/** Isolated Electron main check. Never starts the mail app or opens its database. */
import { app } from "electron";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { fileURLToPath } from "node:url";
import { NodeSystem, makeNodeModels } from "@openmail/core";
import { pdfText } from "../../../packages/core/dist/platform/node/pdf-text.js";
import { databaseLayer } from "../../../packages/core/dist/platform/node/db.js";

const profile = mkdtempSync(join(tmpdir(), "openmail-media-electron-"));
app.setName("OpenMailMediaCheck");
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.once("ready", async () => {
  let status = 0;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [version] = yield* sql`SELECT vec_version() AS version`;
        assert.equal(version.version, "v0.1.9");
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE name IN ('derived_text_vectors','derived_image_vectors')`;
        assert.equal(tables.length, 2);
        const text = new Uint8Array(new Float32Array(384).buffer);
        const image = new Uint8Array(new Float32Array(512).buffer);
        yield* sql`INSERT INTO derived_text_vectors(rowid,embedding) VALUES(${1n},${text})`;
        yield* sql`INSERT INTO derived_image_vectors(rowid,embedding) VALUES(${1n},${image})`;
        const hits =
          yield* sql`SELECT rowid FROM derived_text_vectors WHERE embedding MATCH ${text} AND k=1`;
        assert.equal(hits.length, 1);
      }).pipe(
        Effect.provide(databaseLayer(join(profile, "mail.db")).pipe(Layer.provide(NodeSystem))),
      ),
    );
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [];
    for (const [index, object] of objects.entries()) {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += "xref\n0 4\n0000000000 65535 f \n";
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const pages = await Effect.runPromise(pdfText(new TextEncoder().encode(pdf)));
    assert.equal(pages.length, 1);
    const modelsRoot = fileURLToPath(new URL("../../../spikes/media/models/", import.meta.url));
    if (
      process.env.OPENMAIL_TEST_MODELS === "1" &&
      existsSync(join(modelsRoot, "Xenova/mobileclip_s0/onnx/vision_model.onnx"))
    ) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const models = yield* makeNodeModels(profile, modelsRoot, {
            launch: desktopInferenceProcess,
            prepare: (path, _download, progress, options) =>
              modelFiles(path, false, progress, options),
          });
          yield* models.ensure(true);
          assert.equal(
            (yield* models.embedder.text("Synthetic airport boarding pass", "passage")).length,
            384,
          );
          assert.equal((yield* models.images.query("airline ticket")).length, 512);
          process.stdout.write(
            "Electron: real offline ONNX utilityProcess E5 384 and MobileCLIP 512 passed\n",
          );
        }).pipe(Effect.provide(NodeSystem), Effect.scoped),
      );
    }
    process.stdout.write(
      `Electron ${process.versions.electron}: sqlite-vec 0.1.9, migrations 8/9, 384/512 tables, KNN and bounded PDF worker passed\n`,
    );
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    status = 1;
  } finally {
    rmSync(profile, { recursive: true, force: true });
    app.exit(status);
  }
});
