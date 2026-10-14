import { Effect, Exit } from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { afterEach, expect, it } from "vitest";
import { MailRpcs } from "../../../shared/rpc";
import { ElectronProtocol } from "../state/rpc";
import { eventually, flow, incoming, row } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

/** One call from the renderer, on its own short-lived client like `submitAiKey`. */
const call = <A, E>(
  f: (
    client: RpcClient.FromGroup<typeof MailRpcs, RpcClientError.RpcClientError>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    RpcClient.make(MailRpcs).pipe(
      Effect.flatMap(f),
      Effect.provide(ElectronProtocol),
      Effect.scoped,
    ),
  );

it("a handler that dies or is interrupted fails only its own call; live updates keep arriving", async () => {
  current = await flow({
    handlers: {
      Diagnostics: () => Effect.die(new Error("handler bug")),
      FeedbackAddress: () => Effect.interrupt,
    },
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());

  const died = await call((client) => client.Diagnostics({ crashOnly: false }));
  expect(Exit.isFailure(died)).toBe(true);
  expect(JSON.stringify(died)).not.toContain("handler bug");
  const interrupted = await call((client) => client.FeedbackAddress());
  expect(Exit.isFailure(interrupted)).toBe(true);
  // No defect frame for the whole client: that would fail every call in flight, Events included.
  expect(h.responses.filter((response) => response._tag === "Defect")).toEqual([]);

  // Other calls still answer.
  const accounts = await call((client) => client.Accounts());
  expect(Exit.isSuccess(accounts)).toBe(true);

  // A sync the main process runs on its own reaches the window only through Events.
  h.server.messages.set("arrival", incoming("arrival", { date: Date.now() }));
  await h.run(h.m.sync.sync());
  await eventually(() => expect(row(h.id("arrival")).textContent).toContain("Flow arrival"));
});
