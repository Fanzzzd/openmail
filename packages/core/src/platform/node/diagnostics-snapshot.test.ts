import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { MIGRATIONS } from "../../db/migrations.js";
import { KEYCHAIN_LOCKED_MESSAGE } from "../../domain/errors.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { Store } from "../../store/service.js";
import { SYNC_FAILURE_TEXT } from "../../sync/sync-failure.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalDiagnostics, diagnosticSnapshot } from "./diagnostics.js";
import { fakeServer, TestMailbox } from "./testing.js";

const PRIVATE = [
  "me@gmail.com",
  "me@outlook.com",
  "gmail:",
  "outlook:",
  "Quarterly secret",
  "alice@private.example",
  "Bearer",
  "/Users/alice",
];

it.effect("the snapshot carries build, schema and per-account state as counts and enums", () =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const gmail = yield* mailbox.accounts.connect({ provider: "gmail" });
    const outlook = yield* mailbox.accounts.connect({ provider: "outlook" });
    yield* store.setSyncError(gmail.id, `${gmail.id}: ${SYNC_FAILURE_TEXT.network}`);
    yield* store.setSyncError(outlook.id, KEYCHAIN_LOCKED_MESSAGE);
    yield* store.enqueueOp(gmail.id, "m1", { kind: "archive" });
    yield* store.enqueueOp(gmail.id, "m2", { kind: "archive" });
    yield* sql`UPDATE pending_ops SET attempts=2, last_error='alice@private.example rejected', retry_at=9e15 WHERE provider_id='m2'`;
    const state = yield* mailbox.app.diagnosticsState;
    const snapshot = diagnosticSnapshot(
      {
        appVersion: "0.4.1",
        build: "be1a3887abcd",
        packaged: true,
        platform: "darwin",
        osVersion: "26.1",
        arch: "arm64",
        electronVersion: "39.2.0",
        nodeVersion: "22.20.0",
      },
      state,
      1,
    );
    assert.deepStrictEqual(snapshot, {
      at: 1,
      event: "snapshot",
      appVersion: "0.4.1",
      build: "be1a3887abcd",
      packaged: true,
      platform: "darwin",
      osVersion: "26.1",
      arch: "arm64",
      electronVersion: "39.2.0",
      nodeVersion: "22.20.0",
      schemaVersion: MIGRATIONS.length,
      supportedSchemaVersion: MIGRATIONS.length,
      providers: { gmail: 1, outlook: 1, imap: 0 },
      accounts: [
        {
          index: 0,
          provider: "gmail",
          state: "sync-failed",
          syncFailure: "network",
          lastSyncAgeSeconds: snapshot.accounts[0]?.lastSyncAgeSeconds ?? null,
          pendingOps: 2,
          retryingOps: 1,
          failedOps: 1,
          queuedSends: 0,
        },
        {
          index: 1,
          provider: "outlook",
          state: "keychain-locked",
          lastSyncAgeSeconds: snapshot.accounts[1]?.lastSyncAgeSeconds ?? null,
          pendingOps: 0,
          retryingOps: 0,
          failedOps: 0,
          queuedSends: 0,
        },
      ],
    });
    const text = JSON.stringify(snapshot);
    for (const piece of PRIVATE) assert.notInclude(text, piece);
  }).pipe(
    Effect.provide(
      // withAdapter's layer also exposes the SqlClient the test seeds with.
      TestMailbox.withAdapter((base) => base, {
        servers: { gmail: fakeServer("me@gmail.com"), outlook: fakeServer("me@outlook.com") },
      }),
    ),
  ),
);

it("the snapshot drops free text, addresses and unknown fields from tampered input", () => {
  const snapshot = diagnosticSnapshot(
    {
      appVersion: "0.4.1 alice@private.example",
      build: "/Users/alice/openmail",
      packaged: "yes",
      platform: "Quarterly secret",
      osVersion: "Bearer ya29.token",
      arch: "arm64",
      electronVersion: "alice@private.example",
      nodeVersion: "22.20.0",
      email: "alice@private.example",
    },
    {
      schemaVersion: "alice@private.example",
      accounts: [
        {
          index: 0,
          provider: "gmail",
          state: "ok",
          lastSyncAgeSeconds: 10,
          pendingOps: 0,
          retryingOps: 0,
          failedOps: 0,
          queuedSends: 0,
          email: "alice@private.example",
          lastSyncError: "Quarterly secret",
        },
        { index: 1, provider: "gmail", state: "alice@private.example" },
        "alice@private.example",
      ],
    },
    1,
  );
  assert.deepStrictEqual(snapshot.accounts, [
    {
      index: 0,
      provider: "gmail",
      state: "ok",
      lastSyncAgeSeconds: 10,
      pendingOps: 0,
      retryingOps: 0,
      failedOps: 0,
      queuedSends: 0,
    },
  ]);
  assert.strictEqual(snapshot.schemaVersion, undefined);
  assert.strictEqual(snapshot.nodeVersion, "22.20.0");
  const text = JSON.stringify(snapshot);
  for (const piece of PRIVATE) assert.notInclude(text, piece);
  assert.notInclude(text, "yes");
});

it("a snapshot without mailbox state still reports the build", () => {
  const snapshot = diagnosticSnapshot({ appVersion: "0.4.1" }, undefined, 1);
  assert.strictEqual(snapshot.appVersion, "0.4.1");
  assert.deepStrictEqual(snapshot.accounts, []);
  assert.deepStrictEqual(snapshot.providers, { gmail: 0, outlook: 0, imap: 0 });
});

it("each startup record names the app version, and only a plain version string", () => {
  const dir = mkdtempSync(join(tmpdir(), "openmail-snapshot-"));
  try {
    createLocalDiagnostics(dir, { now: () => 1 }).begin("0.4.1");
    createLocalDiagnostics(dir, { now: () => 2 }).begin("0.4.1 alice@private.example");
    const preview = createLocalDiagnostics(dir).preview();
    assert.include(preview, '{"at":1,"event":"startup","appVersion":"0.4.1"}');
    assert.include(preview, '{"at":2,"event":"startup"}');
    assert.notInclude(preview, "alice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
