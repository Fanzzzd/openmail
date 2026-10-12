import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { Mailbox } from "./mailbox.js";
import { TestMailbox } from "./platform/node/testing.js";
import { DEFAULT_REMOTE_ACCESS } from "./remote-access.js";

it.effect("remote access is off by default and keeps a normalized allowlist", () =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    assert.deepStrictEqual(yield* mailbox.remoteAccess, DEFAULT_REMOTE_ACCESS);
    assert.strictEqual(DEFAULT_REMOTE_ACCESS.enabled, false);
    const saved = yield* mailbox.setRemoteAccess({
      ...DEFAULT_REMOTE_ACCESS,
      enabled: true,
      service: " SVC:OpenMail ",
      allowlist: [" owner@github ", "OWNER@github", "friend@example.com"],
    });
    assert.deepStrictEqual(saved.allowlist, ["owner@github", "friend@example.com"]);
    assert.strictEqual(saved.service, "svc:openmail");
    assert.deepStrictEqual(yield* mailbox.remoteAccess, saved);
  }).pipe(Effect.scoped, Effect.provide(TestMailbox())),
);

it.effect("remote access rejects malformed logins and service names", () =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    for (const input of [
      { ...DEFAULT_REMOTE_ACCESS, allowlist: ["not a login"] },
      { ...DEFAULT_REMOTE_ACCESS, allowlist: ["a@b\nX-Header: 1"] },
      { ...DEFAULT_REMOTE_ACCESS, service: "openmail" },
      { ...DEFAULT_REMOTE_ACCESS, service: "svc:-openmail" },
    ]) {
      const result = yield* Effect.result(mailbox.setRemoteAccess(input));
      assert.strictEqual(result._tag, "Failure");
    }
    assert.deepStrictEqual(yield* mailbox.remoteAccess, DEFAULT_REMOTE_ACCESS);
  }).pipe(Effect.scoped, Effect.provide(TestMailbox())),
);
