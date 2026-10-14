/** Pieces every command shares: the CLI actor, failures and output. */

import type { Actor } from "@openmail/core";
import { Console, Data, Effect, Runtime } from "effect";
import { Flag } from "effect/cli";

export const CLI: Actor = { kind: "user", surface: "cli" };

/**
 * A failure the top level reports: `error: message` (and `hint: …` when there is one) on stderr,
 * and with --json the object `{message, code, hint}` on stdout. Exits with code 1.
 */
export class Failed extends Data.TaggedError("Failed")<{
  readonly message: string;
  /** Stable for scripts. Defaults to "failed". */
  readonly code?: string;
  /** The next step; printed on stderr after the message. */
  readonly hint?: string;
  /** stdout already holds the --json answer, such as a tool's own result or error object. */
  readonly printed?: boolean;
}> {
  readonly [Runtime.errorReported] = false;
}

export const fail = (
  message: string,
  extra: { readonly code?: string; readonly hint?: string; readonly printed?: boolean } = {},
) => Effect.fail(new Failed({ message, ...extra }));

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON"),
  Flag.withDefault(false),
);

/**
 * `accountId` → `account_id`, as in MCP results. Only identifier-shaped keys change, so
 * data used as keys (ids, addresses, header names) keeps its spelling.
 */
const snakeKey = (key: string) =>
  /^[a-z][A-Za-z0-9]*$/.test(key) ? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : key;
const snakeKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(snakeKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [snakeKey(key), snakeKeys(item)]),
        )
      : value;
/** JSON with snake_case keys at any depth. toJSON runs first, so dates stay strings. */
export const jsonText = (data: unknown) =>
  JSON.stringify(data === undefined ? data : snakeKeys(JSON.parse(JSON.stringify(data))), null, 2);
export const rawJsonText = (data: unknown) => JSON.stringify(data, null, 2);
export const print = <A>(data: A, asJson: boolean, human: (data: A) => string = jsonText) =>
  Console.log(asJson ? jsonText(data) : human(data));
/** For JSON whose keys are a format of their own, such as JSON Schema. */
export const printRaw = <A>(data: A, asJson: boolean, human: (data: A) => string) =>
  Console.log(asJson ? rawJsonText(data) : human(data));

export const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);
export const optionalInt = (name: string, description: string) =>
  Flag.Int(name).pipe(Flag.withDescription(description), Flag.optional);

/** Where the person changes Changes by AI apps. The CLI only shows it. */
export const WRITE_MODE_SETTING = "Settings → AI Access";
