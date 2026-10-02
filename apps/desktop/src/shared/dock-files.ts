import { Schema } from "effect";

export const DockFileReason = Schema.Literals([
  "tooMany",
  "notFile",
  "tooLarge",
  "changed",
  "unreadable",
]);
export type DockFileReason = typeof DockFileReason.Type;
