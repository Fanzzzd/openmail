/** corpus-check: offline diagnostics on a read-only mailbox snapshot. */

import {
  Failed,
  fail,
  jsonFlag,
  rawJsonText,
  optionalInt,
  optionalString,
  printRaw,
} from "./common.js";
import {
  CorpusCheckError,
  corpusCheck,
  createCorpusRunKeyFile,
  formatCorpusReport,
} from "@openmail/core/node";
import { Command, Flag } from "effect/cli";
import { Console, Effect, Option } from "effect";

const corpusFailure = (error: unknown) =>
  new Failed({
    message: error instanceof CorpusCheckError ? error.message : "Corpus check failed",
  });

/** @internal */
export const corpus = Command.make(
  "corpus-check",
  {
    db: Flag.String("db").pipe(Flag.withDescription("Path to a mailbox cache copy")),
    limit: optionalInt("limit", "Check the newest N cached messages; default all"),
    explain: optionalString(
      "explain",
      "Explain one message using its hash from a previous corpus report",
    ),
    runKey: optionalString("run-key", "Private 0600 run key file; required with --explain"),
    explainReady: Flag.Boolean("explain-ready").pipe(
      Flag.withDescription("Save a private run key file and print its path to stderr"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  Effect.fn(function* ({ db, limit, explain: explainHash, runKey, explainReady, json }) {
    if (Option.isSome(explainHash)) {
      if (Option.isNone(runKey))
        return yield* fail("Explain requires --run-key from the previous scan");
      if (explainReady) return yield* fail("Explain cannot be combined with --explain-ready");
      if (Option.isSome(limit)) return yield* fail("Explain cannot be combined with --limit");
      const report = yield* Effect.tryPromise({
        try: (signal) =>
          corpusCheck({ db, explain: explainHash.value, runKeyFile: runKey.value, signal }),
        catch: corpusFailure,
      });
      return yield* printRaw(report, json, rawJsonText);
    }
    const runKeyFile =
      Option.getOrUndefined(runKey) ??
      (explainReady
        ? yield* Effect.try({ try: createCorpusRunKeyFile, catch: corpusFailure })
        : undefined);
    const report = yield* Effect.tryPromise({
      try: (signal) =>
        corpusCheck({
          db,
          ...(Option.isSome(limit) ? { limit: limit.value } : {}),
          ...(runKeyFile ? { runKeyFile } : {}),
          signal,
        }),
      catch: corpusFailure,
    });
    if (explainReady && runKeyFile) yield* Console.error(`Run key file: ${runKeyFile}`);
    return yield* printRaw(report, json, formatCorpusReport);
  }),
).pipe(
  Command.withDescription("Run offline, content-free diagnostics on a read-only mailbox snapshot"),
);
