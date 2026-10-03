import { Schema } from "effect";
import { OutgoingAttachment } from "@openmail/core/schema";

export const NativePicker = Schema.Literals(["photos", "continuity"]);
export type NativePicker = typeof NativePicker.Type;
export const NativePickerLabels = Schema.Struct({
  title: Schema.String,
  instruction: Schema.String,
  cancel: Schema.String,
});
export type NativePickerLabels = typeof NativePickerLabels.Type;
export const NativePickerResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    files: Schema.Array(OutgoingAttachment),
    skipped: Schema.Literal(0),
  }),
  Schema.Struct({
    status: Schema.Literal("tooLarge"),
    files: Schema.Array(OutgoingAttachment),
    skipped: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(16)),
  }),
]);
export type NativePickerResult = typeof NativePickerResult.Type;
export const GrammarIssue = Schema.Struct({
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.Int.check(Schema.isGreaterThan(0)),
  description: Schema.String,
  suggestions: Schema.Array(Schema.String),
});
export type GrammarIssue = typeof GrammarIssue.Type;
export const GrammarText = Schema.String.check(Schema.isMaxLength(100_000));
export function validateGrammarIssues(text: string, issues: readonly GrammarIssue[]) {
  if (
    issues.length > 256 ||
    issues.some(
      (issue) =>
        issue.start >= issue.end || issue.end > text.length || issue.suggestions.length > 16,
    )
  )
    throw new Error("Invalid grammar result");
  return issues;
}
