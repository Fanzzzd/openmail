import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";

const message = { to: [], cc: [], bcc: [], subject: "s", text: "t", attachments: [] };

it.effect("a draft's write nonce survives until the next confirmed remote", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("outlook", "me@outlook.com");
    yield* store.setDraftWriteNonce("missing", "ignored");
    yield* store.putDraft({ id: "d", accountId: account.id, message });
    const remote = { draftId: "r", messageId: "r", changeKey: "v1", lastWrittenAt: 1 };
    yield* store.setDraftRemote("d", remote, null);
    yield* store.setDraftWriteNonce("d", "n1");
    const pending = Option.getOrThrow(yield* store.getDraft("d")).remote;
    assert.deepStrictEqual(pending, { ...remote, writeNonce: "n1" });
    yield* store.setDraftRemote("d", { ...remote, changeKey: "v2" }, null);
    const confirmed = Option.getOrThrow(yield* store.getDraft("d")).remote;
    assert.isUndefined(confirmed?.writeNonce);
    assert.strictEqual(confirmed?.changeKey, "v2");
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);
