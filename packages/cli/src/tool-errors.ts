import { MailToolError } from "@openmail/core";
/**
 * Arguments that fail the tool's input schema, as MCP and `openmail tool` both report them:
 * code invalid_input with a hint the model or person can act on.
 */
export const invalidArguments = (tool: string, problem: string): MailToolError =>
  new MailToolError({
    code: "invalid_input",
    message: `The arguments for ${tool} do not match its input schema: ${problem}`,
    hint: "Fix the arguments as described and call the tool again.",
  });
