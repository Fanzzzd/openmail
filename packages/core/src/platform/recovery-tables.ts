import { MIGRATIONS, splitStatements } from "../db/db.js";

/** User state from every migration. Cache/FTS/vector tables are intentionally rebuilt. */
export const RECOVERY_TABLES = [
  "profiles",
  "accounts",
  "ai_accounts",
  "ai_config",
  "agent_policies",
  "proposals",
  "drafts",
  "pending_ops",
  "failed_ops",
  "prefs",
  "signatures",
  "named_signatures",
  "signature_defaults",
  "undo_batches",
  "templates",
  "hidden_contacts",
  "image_senders",
  "label_preferences",
  "account_organization",
  "thread_reminders",
  "snoozed_messages",
  "send_as",
  "cache_windows",
  "account_oauth_scopes",
  "account_optional_services",
  "filter_restorations",
  "invite_responses",
  "audit_log",
] as const;

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

type PragmaRow = Readonly<Record<string, unknown>>;

/** Source columns that still exist in the replacement schema, in source order. */
export function sharedRecoveryColumns(
  sourceColumns: readonly PragmaRow[],
  targetColumns: readonly PragmaRow[],
): string[] {
  const target = new Set(targetColumns.map((column) => column.name));
  return sourceColumns.flatMap((column) =>
    typeof column.name === "string" && target.has(column.name) ? [column.name] : [],
  );
}

/** Readable rows can survive an unreadable optional parent: the nullable reference is cleared. */
export function optionalParentChecks(
  targetColumns: readonly PragmaRow[],
  foreignKeys: readonly PragmaRow[],
): { column: string; query: string }[] {
  const nullable = new Set(
    targetColumns
      .filter((column) => column.notnull === 0 && column.pk === 0)
      .map((column) => column.name),
  );
  return foreignKeys.flatMap((fk) =>
    typeof fk.from === "string" &&
    typeof fk.table === "string" &&
    typeof fk.to === "string" &&
    nullable.has(fk.from)
      ? [
          {
            column: fk.from,
            query: `SELECT 1 FROM ${quoteIdentifier(fk.table)} WHERE ${quoteIdentifier(fk.to)}=?`,
          },
        ]
      : [],
  );
}

export function recoveryInsert(table: string, columns: readonly string[]): string {
  const projection = columns.map(quoteIdentifier).join(",");
  return `INSERT INTO ${quoteIdentifier(table)} (${projection}) VALUES (${columns.map(() => "?").join(",")})`;
}

/** Recovery copies user rows after migrating the empty target. Apply data
 * migrations missed by those rows, using the source version rather than the target. */
export function recoveryDataMigrations(sourceVersion: number): readonly string[] {
  return sourceVersion < 39
    ? splitStatements(MIGRATIONS[38] ?? "").filter((statement) =>
        statement.startsWith("UPDATE account_organization "),
      )
    : [];
}
