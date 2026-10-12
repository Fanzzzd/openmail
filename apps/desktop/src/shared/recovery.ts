/** The recovery window runs before RPC exists, so it has two fixed IPC channels of its own. */
export const RECOVERY_PROMPT_CHANNEL = "openmail:recovery-prompt";
export const RECOVERY_ANSWER_CHANNEL = "openmail:recovery-answer";

/** Localized in the main process from the same Lingui catalog the app uses. */
export interface RecoveryPrompt {
  locale: string;
  tone: "warning" | "info" | "error";
  message: string;
  detail: string;
  buttons: readonly string[];
  defaultId: number;
  cancelId: number;
  /** Index of a button that discards data, drawn in the danger style. */
  destructiveId?: number;
}

/** `answer(-1)` reports that the window has painted; other values are button indexes. */
export interface RecoveryBridge {
  prompt: () => Promise<RecoveryPrompt>;
  answer: (index: number) => void;
}
