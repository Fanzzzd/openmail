/** Feedback autosaves stay on this device, including opted-in diagnostics, until Send. */
export const FEEDBACK_DRAFT_PREFIX = "feedback:";
export const isLocalFeedbackDraft = (id: string) => id.startsWith(FEEDBACK_DRAFT_PREFIX);
