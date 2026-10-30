import type { InvalidInput } from "../../domain/errors.js";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { type ThreadSummary, ThreadQuery } from "../../domain/message.js";
import { PlatformCrypto } from "../crypto.js";
import { makeComposeStore } from "../../store/store-compose.js";
import { makeQueryStore } from "../../store/store-query.js";
import { makeThreadsStore } from "../../store/store-threads.js";
import { makeWordIndexStore } from "../../store/store-word-index.js";
import { HtmlText } from "../html-text.js";
import { NodeRuntime } from "./runtime.js";

// IO boundary: Electron's utility process adds parentPort to Node's process object.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The utility process transport is injected by Electron; its messages are schema-decoded below.
const utility = (
  process as typeof process & {
    parentPort?: {
      postMessage(value: unknown, ports: readonly unknown[]): void;
      on(event: "message", listener: (event: { data: unknown }) => void): void;
    };
  }
).parentPort;
const send = (value: unknown) => {
  if (utility) utility.postMessage(value, []);
  else if (process.send) process.send(value);
};
const file = Schema.decodeUnknownSync(Schema.String)(process.argv[2]);
// No migrations, writes, provider APIs or access-lock acquisition here. The main connection owns
// the schema and WAL. This connection sees committed data, and releases its snapshot per statement.
const runtime = ManagedRuntime.make(
  SqliteClient.layer({ filename: file, readonly: true, busyTimeout: "200 millis" }).pipe(
    Layer.provideMerge(NodeRuntime),
  ),
);
const store = await runtime.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA query_only=ON`;
    yield* sql`PRAGMA cache_size=-8192`;
    const query = makeQueryStore({ sql });
    return makeThreadsStore({
      sql,
      compose: makeComposeStore(sql, yield* PlatformCrypto),
      wordIndex: makeWordIndexStore(sql),
      hasLabel: query.hasLabel,
      textFilter: query.textFilter,
      listFilter: query.listFilter,
      listSource: query.listSource,
      searchDrivenList: query.searchDrivenList,
      planTextPage: query.planTextPage,
      // Already off the Electron main thread. The fallback computes only the first visible rows.
      htmlText: yield* HtmlText,
    });
  }),
);
const Request = Schema.Struct({
  kind: Schema.Literals(["threads", "count"]),
  query: ThreadQuery,
});
const answer = async (input: unknown) => {
  const request = Schema.decodeUnknownSync(Request)(
    typeof input === "string" ? JSON.parse(input) : input,
  );
  const effect: Effect.Effect<number | ThreadSummary[], InvalidInput> =
    request.kind === "count" ? store.countThreads(request.query) : store.listThreads(request.query);
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return { kind: request.kind, value: exit.value };
  const cause = Cause.squash(exit.cause);
  return cause !== null &&
    typeof cause === "object" &&
    "_tag" in cause &&
    cause._tag === "InvalidInput" &&
    "message" in cause
    ? { kind: "invalid", message: String(cause.message) }
    : { kind: "error" };
};
// Every request gets one reply, so a failure never leaves the caller waiting or kills the worker.
const receive = (input: unknown) => {
  answer(input).then(send, () => send({ kind: "error" }));
};
if (utility) utility.on("message", (event) => receive(event.data));
else process.on("message", receive);
send({ kind: "ready" });
