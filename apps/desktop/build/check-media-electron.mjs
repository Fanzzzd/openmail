/** Isolated Electron main check. Never starts the mail app or opens its database. */
import { app } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { NodeSystem } from "@openmail/core";
import { pdfText } from "../../../packages/core/dist/pdf-text.js";
import { databaseLayer } from "../../../packages/core/dist/db.js";

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
    process.stdout.write(
      `Electron ${process.versions.electron}: sqlite-vec 0.1.9, migration 8, 384/512 tables, KNN and bounded PDF worker passed\n`,
    );
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    status = 1;
  } finally {
    rmSync(profile, { recursive: true, force: true });
    app.exit(status);
  }
});
