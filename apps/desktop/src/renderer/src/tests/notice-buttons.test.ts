import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { expect, it } from "vitest";
import { DraftConflictNotice } from "../features/compose/components/DraftConflictNotice";
import { DraftSyncRecovery } from "../features/compose/components/DraftSyncRecovery";

/** Notices with actions. Each button needs a visible shape and a 44 px touch target. */
const NOTICES = [
  "../features/compose/components/DraftConflictNotice.tsx",
  "../features/compose/components/DraftSyncRecovery.tsx",
  "../features/compose/components/BodyNotices.tsx",
  "../features/sync-status/FailedOpNotice.tsx",
  "../features/updates/UpdateNotice.tsx",
];

/** Each `<button …>` opening tag in a file, braces balanced so `=>` does not end it. */
function buttonTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<button\b/g)) {
    let depth = 0;
    let end = match.index;
    while (end < source.length) {
      const char = source[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
      end++;
    }
    tags.push(source.slice(match.index, end));
  }
  return tags;
}

it("every button in a notice has a style class", () => {
  for (const file of NOTICES) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const tag of buttonTags(source)) expect(tag, file).toMatch(/className=/);
  }
});

it("draft notices render push buttons with a touch-size minimum", () => {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const noop = () => undefined;
  const render = (element: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(I18nProvider, { i18n }, element));
  const markups = [
    render(createElement(DraftConflictNotice, { onRestore: noop, onDismiss: noop })),
    render(
      createElement(DraftSyncRecovery, {
        draft: { syncError: "x", syncRetrying: false, localOnly: false },
        busy: false,
        onRecover: noop,
      }),
    ),
    render(
      createElement(DraftSyncRecovery, {
        draft: { localOnly: true },
        busy: false,
        onRecover: noop,
      }),
    ),
  ];
  for (const markup of markups) {
    const buttons = [...markup.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toContain("coarse:min-h-11");
  }
});
