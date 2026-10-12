import { Schema } from "effect";

/** What the main process asks a window's renderer to draw in React. Text is localized there. */
export const TextMenu = Schema.Struct({
  /** Window coordinates of the right-click, in CSS pixels. */
  x: Schema.Number,
  y: Schema.Number,
  misspelledWord: Schema.String,
  suggestions: Schema.Array(Schema.String),
  spellcheck: Schema.Boolean,
  canCut: Schema.Boolean,
  canCopy: Schema.Boolean,
  canPaste: Schema.Boolean,
  /** The compose body on macOS, where the system Writing Tools menu is available. */
  writingTools: Schema.Boolean,
});
export type TextMenu = typeof TextMenu.Type;

export const UpdateCheckResult = Schema.Struct({
  status: Schema.Literals(["disabled", "upToDate", "available", "error"]),
  version: Schema.optionalKey(Schema.String),
});
export type UpdateCheckResult = typeof UpdateCheckResult.Type;

export const WindowUiEvent = Schema.Union([
  Schema.TaggedStruct("TextMenu", { menu: TextMenu }),
  /** Quit, close or reload with sends still in the undo window. Answer with AnswerPrompt. */
  Schema.TaggedStruct("QuitPrompt", { id: Schema.String }),
  /** Answer "shown" once painted and "accept" when dismissed. */
  Schema.TaggedStruct("UpdateResult", { id: Schema.String, result: UpdateCheckResult }),
  /** The native fallback took over this prompt; stop showing it. */
  Schema.TaggedStruct("PromptDone", { id: Schema.String }),
]);
export type WindowUiEvent = typeof WindowUiEvent.Type;

export const TextMenuCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("replace"), word: Schema.String }),
  Schema.Struct({
    kind: Schema.Literals([
      "learn",
      "toggleSpellcheck",
      "cut",
      "copy",
      "paste",
      "selectAll",
      "writingTools",
      "dismiss",
    ]),
  }),
]);
export type TextMenuCommand = typeof TextMenuCommand.Type;

export const PromptAnswer = Schema.Literals(["shown", "accept", "cancel"]);
export type PromptAnswer = typeof PromptAnswer.Type;
