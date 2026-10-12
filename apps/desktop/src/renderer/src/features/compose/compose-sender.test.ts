import { Deferred, Effect } from "effect";
import { DEFAULT_PREFS, type Prefs, type SendAs } from "@openmail/core/schema";
import { expect, it, vi } from "vitest";
import type { Account } from "../../../../shared/api";
import { resolveComposeSender } from "./compose-sender";

const account: Account = {
  id: "gmail:me@example.com",
  provider: "gmail",
  email: "me@example.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};
const alias: SendAs = {
  accountId: account.id,
  address: "alias@example.com",
  name: "Alias",
  isDefault: false,
  signature: "",
};

for (const first of ["prefs", "aliases"] as const) {
  it(`cold-start compose waits for ${first === "prefs" ? "aliases" : "preferences"} rather than using a fallback From`, async () => {
    const prefs = await Effect.runPromise(Deferred.make<Prefs>());
    const aliases = await Effect.runPromise(Deferred.make<readonly SendAs[]>());
    const opened = vi.fn();
    const result = Effect.runPromise(
      resolveComposeSender({
        accounts: [account],
        view: {},
        scope: undefined,
        prefs: Deferred.await(prefs),
        aliases: Deferred.await(aliases),
      }).pipe(Effect.tap((sender) => Effect.sync(() => opened(sender)))),
    );
    const fixed = {
      ...DEFAULT_PREFS,
      defaultFrom: { accountId: account.id, address: alias.address },
    };
    await Effect.runPromise(
      first === "prefs" ? Deferred.succeed(prefs, fixed) : Deferred.succeed(aliases, [alias]),
    );
    await Promise.resolve();
    expect(opened).not.toHaveBeenCalled();
    await Effect.runPromise(
      first === "prefs" ? Deferred.succeed(aliases, [alias]) : Deferred.succeed(prefs, fixed),
    );
    expect(await result).toEqual({
      accountId: account.id,
      address: alias.address,
      name: alias.name,
    });
    expect(opened).toHaveBeenCalledOnce();
  });
}

it("a settings failure does not silently choose the first account", async () => {
  const opened = vi.fn();
  const result = Effect.runPromise(
    resolveComposeSender({
      accounts: [account],
      view: {},
      scope: undefined,
      prefs: Effect.fail(new Error("Settings unavailable")),
      aliases: Effect.succeed([alias]),
    }).pipe(Effect.tap((sender) => Effect.sync(() => opened(sender)))),
  );
  await expect(result).rejects.toThrow("Settings unavailable");
  expect(opened).not.toHaveBeenCalled();
});
