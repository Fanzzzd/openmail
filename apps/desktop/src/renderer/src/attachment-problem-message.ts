import type { AttachmentProblem } from "@openmail/core/schema";

type AttachmentMessages = {
  gmailSize: string;
  gmailBlocked: (filename: string) => string;
  outlookSize: string;
};
/** Both renderers keep their catalog origins while sharing error dispatch. */
export function attachmentProblemMessage(
  problem: AttachmentProblem,
  messages: AttachmentMessages,
): string {
  switch (problem.kind) {
    case "gmailSize":
      return messages.gmailSize;
    case "gmailBlocked":
      return messages.gmailBlocked(problem.filename);
    case "outlookSize":
      return messages.outlookSize;
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}
