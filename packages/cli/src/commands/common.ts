/** Pieces every command shares: the CLI actor, failures and output. */

import type { Actor } from "@openmail/core";
import { Console, Data, Effect, Runtime } from "effect";
import { Flag } from "effect/cli";

export const CLI: Actor = { kind: "user", surface: "cli" };

/** A failure already explained to the person on stderr; exits with code 1. */
export class Failed extends Data.TaggedError("Failed")<{ readonly message: string }> {
  readonly [Runtime.errorReported] = false;
}

export const fail = (message: string) => Effect.fail(new Failed({ message }));

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON"),
  Flag.withDefault(false),
);

const jsonText = (data: unknown) => JSON.stringify(data, null, 2);
export const print = <A>(data: A, asJson: boolean, human: (data: A) => string = jsonText) =>
  Console.log(asJson ? jsonText(data) : human(data));

export const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);
export const optionalInt = (name: string, description: string) =>
  Flag.Int(name).pipe(Flag.withDescription(description), Flag.optional);
