import { assert, it } from "@effect/vitest";
import { Effect, Logger, References } from "effect";
import type { Actor } from "../domain/command.js";
import { ProviderError } from "../domain/errors.js";
import { logCodeOf } from "../domain/diagnostic-log.js";
import { keychainLocked } from "../providers/reauth.js";
import type { ProviderAdapter } from "../providers/adapter.js";
import type { Secrets } from "../platform/auth.js";
import { TestMailbox } from "../platform/node/testing.js";
import { Mailbox } from "./mailbox.js";

const user: Actor = { kind: "user", surface: "app" };

/** Runs `body` on a fresh mailbox and returns the diagnostics codes it logged. */
function removal(
  adapter: Partial<ProviderAdapter>,
  secretMethods: Partial<Secrets["Service"]>,
  body: Effect.Effect<void, unknown, Mailbox>,
) {
  const codes: string[] = [];
  const logger = Logger.make((options) => {
    const code = logCodeOf(options.fiber.getRef(References.CurrentLogAnnotations));
    if (code) codes.push(code);
  });
  return body.pipe(
    Effect.provide(
      TestMailbox.withAdapter((base) => ({ ...base, ...adapter }), {
        options: { backgroundFlush: false, imapIdle: false },
        platformOptions: { secretMethods },
      }),
    ),
    Effect.provide(Logger.layer([logger])),
    Effect.as(codes),
  );
}

it.effect("removal revokes the grant while the token is still stored, then deletes it", () => {
  const order: string[] = [];
  let removed: string | undefined;
  return removal(
    {
      revokeGrant: (id) =>
        Effect.sync(() => {
          order.push(`revoke ${id}`);
        }),
    },
    {
      remove: (key) =>
        Effect.sync(() => {
          order.push(`remove ${key}`);
          removed = key;
        }),
    },
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      const outcome = yield* mailbox.organize.perform(
        { kind: "removeAccount", accountId: account.id },
        user,
      );
      assert.deepStrictEqual(outcome, { status: "applied" });
      assert.deepStrictEqual(order, [`revoke ${account.id}`, `remove ${account.id}`]);
      assert.strictEqual(removed, account.id);
      assert.deepStrictEqual(yield* mailbox.accounts, []);
    }),
  ).pipe(Effect.map((codes) => assert.deepStrictEqual(codes, [])));
});

it.effect("a failed revocation is logged with a code and does not block removal", () =>
  removal(
    { revokeGrant: () => Effect.fail(new ProviderError({ message: "Google is down" })) },
    {},
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      const outcome = yield* mailbox.organize.perform(
        { kind: "removeAccount", accountId: account.id },
        user,
      );
      assert.deepStrictEqual(outcome, { status: "applied" });
      assert.deepStrictEqual(yield* mailbox.accounts, []);
      const [entry] = yield* mailbox.audit(5);
      assert.strictEqual(entry?.action, "removeAccount");
    }),
  ).pipe(Effect.map((codes) => assert.deepStrictEqual(codes, ["token-revoke-failed"]))),
);

it.effect("a keychain that refuses deletion still removes the account, audits it and warns", () =>
  removal(
    {},
    { remove: () => Effect.fail(keychainLocked()) },
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      const outcome = yield* mailbox.organize.perform(
        { kind: "removeAccount", accountId: account.id },
        user,
      );
      assert.deepStrictEqual(outcome, { status: "applied", warning: "keychain-item-left" });
      assert.deepStrictEqual(yield* mailbox.accounts, []);
      const [entry] = yield* mailbox.audit(5);
      assert.strictEqual(entry?.action, "removeAccount");
    }),
  ).pipe(Effect.map((codes) => assert.deepStrictEqual(codes, ["keychain-remove-failed"]))),
);
