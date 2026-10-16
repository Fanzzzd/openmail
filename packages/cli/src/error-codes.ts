/**
 * Every `code` the CLI's own failures print with --json. `openmail tool` also passes on the
 * MCP tool codes. The docs page lists these, and a docs test checks the list.
 */
export const CLI_ERROR_CODES = [
  "usage",
  "failed",
  "data_folder",
  "not_found",
  "not_configured",
  "auth_failed",
  "provider_unavailable",
  "canceled",
  "invalid_input",
  "busy",
  "internal",
  "app_only",
  "not_readable",
] as const;
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];
