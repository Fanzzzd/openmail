import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream, Fiber } from "effect";
import { databaseLayer } from "./platform/node/db.js";
import { DEFAULT_PREFS } from "./domain.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Store } from "./services.js";
import { Mailbox } from "./mailbox.js";
import { TestMailbox } from "./platform/node/testing.js";
import { SqlClient } from "effect/sql";
{
  it.effect(
    "channel, Labs, gesture choices and toolbar ordering survive reopening a temporary database",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-" });
        const file = path.join(directory, "mail.db");
        const layer = () => StoreLive.pipe(Layer.provide(databaseLayer(file)));
        yield* Effect.gen(function* () {
          const store = yield* Store;
          assert.deepStrictEqual(yield* store.prefs, DEFAULT_PREFS);
          yield* store.setPrefs({
            updateChannel: "latest",
            labs: { markdown: false, calendarDetection: false },
            swipeActions: {
              leftShort: "none",
              leftLong: "star",
              rightShort: "snooze",
              rightLong: "read",
            },
            toolbarActions: ["star", "reply", "archive"],
          });
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const store = yield* Store,
            prefs = yield* store.prefs;
          assert.strictEqual(prefs.updateChannel, "latest");
          assert.deepStrictEqual(prefs.labs, { markdown: false, calendarDetection: false });
          assert.strictEqual(prefs.swipeActions.rightShort, "snooze");
          assert.deepStrictEqual(prefs.toolbarActions, ["star", "reply", "archive"]);
        }).pipe(Effect.provide(layer()));
      }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
}

{
  it.effect(
    "preferences retain known elements and fields when future versions leave unknown settings",
    () =>
      Effect.gen(function* () {
        const store = yield* Store,
          sql = yield* SqlClient.SqlClient;
        for (const [key, value] of Object.entries({
          toolbarActions: ["star", "future-action", "archive"],
          labs: { markdown: false, futureLab: true },
          swipeActions: { leftShort: "star", leftLong: "future-action", futureGesture: "trash" },
        })) {
          yield* sql`INSERT INTO prefs(key,value_json) VALUES(${key},${JSON.stringify(value)})`;
        }
        const prefs = yield* store.prefs;
        assert.deepStrictEqual(prefs.toolbarActions, ["star", "archive"]);
        assert.deepStrictEqual(prefs.labs, { ...DEFAULT_PREFS.labs, markdown: false });
        assert.deepStrictEqual(prefs.swipeActions, {
          ...DEFAULT_PREFS.swipeActions,
          leftShort: "star",
        });
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );
}

{
  const layer = StoreLive.pipe(Layer.provideMerge(MemoryPlatform()));

  it.effect(
    "layout and automatic download preferences default safely and persist independently",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        assert.strictEqual((yield* store.prefs).toolbarVisible, true);
        assert.strictEqual((yield* store.prefs).readingPaneVisible, true);
        assert.strictEqual((yield* store.prefs).updateAutoDownload, true);
        yield* store.setPrefs({
          toolbarVisible: false,
          readingPaneVisible: false,
          updateAutoDownload: false,
        });
        assert.strictEqual((yield* store.prefs).toolbarVisible, false);
        assert.strictEqual((yield* store.prefs).readingPaneVisible, false);
        assert.strictEqual((yield* store.prefs).updateAutoDownload, false);
        assert.strictEqual((yield* store.prefs).readingPanePosition, "right");
        yield* store.setPrefs({ readingPanePosition: "bottom" });
        assert.strictEqual((yield* store.prefs).readingPaneVisible, false);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "update preference events preserve ready state while actual channel and token changes reset it",
    () =>
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const listener = yield* mailbox.events.pipe(
          Stream.filter((event) => event._tag === "UpdateSettingsChanged"),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* mailbox.setPrefs({ updateAutoDownload: false });
        yield* mailbox.setPrefs({ updateChannel: "stable" });
        yield* mailbox.setPrefs({ updateChannel: "latest" });
        yield* mailbox.setUpdateToken("fixture-token");
        const events = yield* Fiber.join(listener);
        assert.deepStrictEqual(
          Array.from(events).map((event) => event.resetState),
          [false, false, true, true],
        );
      }).pipe(Effect.scoped, Effect.provide(TestMailbox())),
  );
}
