/** Isolated Electron main check. Never starts the mail app or opens its database. */
import { app } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { NodeSystem } from "@openmail/core";
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
    process.stdout.write(
      `Electron ${process.versions.electron}: sqlite-vec 0.1.9, migration 8, 384/512 tables and KNN passed\n`,
    );
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    status = 1;
  } finally {
    rmSync(profile, { recursive: true, force: true });
    app.exit(status);
  }
});
