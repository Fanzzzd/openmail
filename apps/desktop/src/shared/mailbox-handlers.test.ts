import { LockTimeoutError, SqlError } from "effect/sql/SqlError";
import { Effect, Exit } from "effect";
import type { Mailbox } from "@openmail/core/portable";
import { expect, it } from "vitest";
import { mailboxHandlers } from "./mailbox-handlers";

const handlersFor = (sync: Effect.Effect<never>) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stub with the two sync members the handlers use
  const m = {
    sync: { resetConnectivity: () => Effect.void, sync: () => sync },
  } as unknown as Mailbox["Service"];
  return mailboxHandlers(m);
};

const lockTimeout = new SqlError({
  reason: new LockTimeoutError({ cause: new Error("database is locked") }),
});

for (const name of ["Sync", "NetworkChanged"] as const)
  it(`${name} leaves a held write lock to the next timer sync and does not swallow another defect`, async () => {
    const held = handlersFor(Effect.die(lockTimeout))[name];
    await Effect.runPromise(held());
    const bug = new Error("provider bug");
    const crashed = await Effect.runPromiseExit(handlersFor(Effect.die(bug))[name]());
    expect(Exit.isFailure(crashed)).toBe(true);
    expect(Exit.isFailure(crashed) && String(crashed.cause)).toContain("provider bug");
  });
