import { Schema } from "effect";

/** Public update states never contain release URLs, credentials or updater errors. */
export const UpdateState = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["disabled", "checking", "upToDate", "error"]) }),
  Schema.Struct({
    status: Schema.Literals(["available", "downloading", "downloaded"]),
    version: Schema.String,
  }),
]);
export type UpdateState = typeof UpdateState.Type;
