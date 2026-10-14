import { Schema } from "effect";

/** Localized by the renderer's Lingui catalog, reused by native menus and notifications. */
export const DesktopLabels = Schema.Struct({
  menuLabels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  checkUpdates: Schema.String,
  updatesDisabled: Schema.String,
  updatesCurrent: Schema.String,
  updatesAvailable: Schema.String,
  updatesFailed: Schema.String,
  ok: Schema.String,
  read: Schema.String,
  actionMenu: Schema.String,
  settings: Schema.String,
  newWindow: Schema.String,
  compose: Schema.String,
  attachFiles: Schema.String,
  helpMenu: Schema.optionalKey(Schema.String),
  help: Schema.String,
  archive: Schema.String,
  trash: Schema.String,
  noUnread: Schema.String,
  showInbox: Schema.String,
  allAccounts: Schema.String,
  file: Schema.String,
  edit: Schema.String,
  undo: Schema.String,
  undoSend: Schema.String,
  quitPending: Schema.String,
  quitPendingDetail: Schema.String,
  quit: Schema.String,
  cancel: Schema.String,
  selectAll: Schema.String,
  window: Schema.String,
  feedback: Schema.String,
  /** Help menu item that opens the docs site. */
  docs: Schema.String,
  /** The digest title per plural category of `locale`, with # for the count. */
  newMessages: Schema.Record(Schema.String, Schema.String),
  locale: Schema.String,
});
export type DesktopLabels = typeof DesktopLabels.Type;

/**
 * Turns one ICU plural message into a template per plural category, so main can pick the
 * right form without Lingui. `format` renders a count with the catalog's message; the
 * count's formatted digits become #. Categories with no whole-number count are skipped.
 */
export function pluralTemplates(
  locale: string,
  format: (count: number) => string,
  number: (count: number) => string,
): Record<string, string> {
  const rules = new Intl.PluralRules(locale);
  const templates: Record<string, string> = {};
  for (const category of rules.resolvedOptions().pluralCategories) {
    // 2 before 0 and 1, so "other" in English is not built from a zero sample.
    const sample = [2, 1, 0, ...Array.from({ length: 200 }, (_, i) => i + 3)].find(
      (n) => rules.select(n) === category,
    );
    if (sample === undefined) continue;
    templates[category] = format(sample).replace(number(sample), "#");
  }
  return templates;
}

/** The digest title for `count`, from the templates pluralTemplates built. */
export function pluralText(locale: string, templates: Record<string, string>, count: number) {
  const template = templates[new Intl.PluralRules(locale).select(count)] ?? templates.other ?? "#";
  return template.replace("#", new Intl.NumberFormat(locale).format(count));
}
