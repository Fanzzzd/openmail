import { Effect } from "effect";

/** Entry code reaches draft.ts and its HTML cleaner only here, so they load on first compose. */
export const loadDrafts = Effect.promise(() => import("./draft"));
