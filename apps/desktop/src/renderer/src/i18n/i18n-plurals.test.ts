import { expect, it } from "vitest";
import { catalogI18n } from "../test-support/catalog-i18n";

const DELETED =
  "{count, plural, one {Permanently deleted # message} other {Permanently deleted # messages}}";
const EVERY_DAY = "{interval, plural, one {Every # day} other {Every # days}}";

async function render(locale: string, source: string, values: Record<string, number | string>) {
  const { i18n, catalog } = await catalogI18n(locale);
  const id = Object.entries(catalog).find(([, message]) => message.message === source)?.[0];
  if (!id) throw new Error(`Missing ${source}`);
  return i18n._(id, values);
}

it("counted notices pick the singular in English", async () => {
  expect(await render("en", DELETED, { count: 1 })).toBe("Permanently deleted 1 message");
  expect(await render("en", DELETED, { count: 3 })).toBe("Permanently deleted 3 messages");
  expect(await render("en", EVERY_DAY, { interval: 1 })).toBe("Every 1 day");
});

it("counted notices use each plural form in Russian and Czech", async () => {
  for (const locale of ["ru", "cs"]) {
    const forms = await Promise.all([1, 3, 5].map((count) => render(locale, DELETED, { count })));
    expect(forms[0]).toContain("1");
    // one, few and many differ: the noun after the count changes.
    expect(new Set(forms.map((form) => form.replace(/\d+/, "#"))).size).toBe(3);
  }
});

const HEADER_WINDOW =
  "{0, plural, one {# day} other {# days}}, {1, plural, one {up to # message} other {up to # messages}}";

it("the sync health window counts days and messages with plurals", async () => {
  expect(await render("en", HEADER_WINDOW, { 0: 1, 1: 1 })).toBe("1 day, up to 1 message");
  expect(await render("en", HEADER_WINDOW, { 0: 30, 1: 500 })).toBe("30 days, up to 500 messages");
  expect(await render("ru", HEADER_WINDOW, { 0: 31, 1: 21 })).toBe("31 день, до 21 сообщения");
  expect(await render("ru", HEADER_WINDOW, { 0: 30, 1: 500 })).toBe("30 дней, до 500 сообщений");
  expect(await render("cs", HEADER_WINDOW, { 0: 3, 1: 1 })).toBe("3 dny, nejvýše 1 zpráva");
});

const COUNTED = [
  ["{0, plural, one {# selected (loaded)} other {# selected (loaded)}}", "0"],
  ["{0, plural, one {# selected} other {# selected}}", "0"],
  ["{0, plural, one {# more not loaded} other {# more not loaded}}", "0"],
  ["{unreadCount, plural, one {# unread} other {# unread}}", "unreadCount"],
  ["{count, plural, one {Server preview: # message} other {Server preview: # messages}}", "count"],
  ["{count, plural, one {Local preview: # message} other {Local preview: # messages}}", "count"],
] as const;

// These counts were plain `{count}` placeholders, so Russian and Czech nouns after them could
// not agree, and Japanese read "{0} more not loaded" as "{0} or more".
it("selection, unread and preview counts use each plural form", async () => {
  expect(await render("en", COUNTED[4][0], { count: 1 })).toBe("Server preview: 1 message");
  expect(await render("en", COUNTED[2][0], { 0: 3 })).toBe("3 more not loaded");
  for (const [source, name] of COUNTED)
    for (const locale of ["ru", "cs"]) {
      const forms = await Promise.all(
        [1, 3, 5].map((count) => render(locale, source, { [name]: count })),
      );
      expect(new Set(forms.map((form) => form.replace(/\d+/, "#"))).size, source).toBe(3);
    }
  expect(await render("ja", COUNTED[2][0], { 0: 3 })).toBe(
    "あと3件のメッセージが読み込まれていません",
  );
  expect(await render("ru", COUNTED[2][0], { 0: 21 })).toBe("Ещё 21 сообщение не загружено");
  expect(await render("ru", COUNTED[2][0], { 0: 1_000 })).toMatch(
    /^Ещё 1\s000 сообщений не загружено$/,
  );
});

// French and Russian read "More messages not loaded" as "no more messages loaded".
it("the not-loaded notice says older messages exist, with a note for translators", async () => {
  const { catalog } = await catalogI18n("fr");
  const entry = Object.values(catalog).find(
    (message) => message.message === "More messages not loaded",
  );
  expect(entry?.comments?.join(" ")).toContain("Older messages exist on the server");
  expect(entry?.translation).toBe("D’autres messages ne sont pas chargés");
  expect(await render("ru", "More messages not loaded", {})).toBe("Загружены не все сообщения");
  // 未読み込み reads as 未読 (unread) plus み; the notice must not start with it.
  expect(await render("ja", "More messages not loaded", {})).toBe(
    "読み込まれていないメッセージがあります",
  );
});

const OVERVIEW =
  "{accountCount, plural, one {# account} other {# accounts}}, {total, plural, one {# unread} other {# unread}}";
const INDEXING =
  "{0, plural, one {# completed} other {# completed}} · {1, plural, one {# queued} other {# queued}} · {2, plural, one {# running} other {# running}} · {3, plural, one {# failed} other {# failed}}";
const EMBEDDING =
  "{0, plural, one {# embedded} other {# embedded}} · {1, plural, one {# queued} other {# queued}} · {2, plural, one {# running} other {# running}} · {3, plural, one {# failed} other {# failed}}";
const RECOVERED =
  "{copied, plural, one {Recovered # local record.} other {Recovered # local records.}} {skipped, plural, one {Skipped # unreadable item.} other {Skipped # unreadable items.}} Original database: {backup}";

// The unread total, the indexing counters and the recovery notice interpolated a formatted
// number into one form, so French read "1 non lus" and "5 terminé ... 5 a échoué".
it("the overview, indexing and recovery counts agree with their numbers", async () => {
  expect(await render("en", OVERVIEW, { accountCount: 2, total: 1 })).toBe("2 accounts, 1 unread");
  expect(await render("fr", OVERVIEW, { accountCount: 1, total: 1 })).toBe("1 compte, 1 non lue");
  expect(await render("fr", OVERVIEW, { accountCount: 3, total: 5 })).toBe("3 comptes, 5 non lues");
  expect(await render("fr", INDEXING, { 0: 1, 1: 1, 2: 1, 3: 1 })).toBe(
    "1 terminé · 1 en file d’attente · 1 en cours d’exécution · 1 a échoué",
  );
  expect(await render("fr", INDEXING, { 0: 5, 1: 5, 2: 5, 3: 5 })).toBe(
    "5 terminés · 5 en file d’attente · 5 en cours d’exécution · 5 ont échoué",
  );
  expect(await render("fr", EMBEDDING, { 0: 5, 1: 0, 2: 1, 3: 2 })).toBe(
    "5 intégrés · 0 en file d’attente · 1 en cours d’exécution · 2 ont échoué",
  );
  const recovered = { copied: 1, skipped: 1, backup: "b" };
  expect(await render("en", RECOVERED, recovered)).toBe(
    "Recovered 1 local record. Skipped 1 unreadable item. Original database: b",
  );
  expect(await render("fr", RECOVERED, { ...recovered, copied: 4, skipped: 2 })).toBe(
    "4 enregistrements locaux récupérés. 2 éléments illisibles ignorés. Base de données d’origine : b",
  );
  for (const source of [OVERVIEW, INDEXING, EMBEDDING, RECOVERED])
    for (const locale of ["ru", "cs"]) {
      const forms = await Promise.all(
        [1, 3, 5].map((n) =>
          render(locale, source, {
            accountCount: 1,
            total: n,
            copied: n,
            skipped: 1,
            backup: "b",
            0: n,
            1: 1,
            2: 1,
            3: 1,
          }),
        ),
      );
      expect(new Set(forms).size, `${locale} ${source}`).toBeGreaterThan(1);
    }
  expect(await render("ja", OVERVIEW, { accountCount: 2, total: 3 })).toBe(
    "2個のアカウント、未開封3件",
  );
});
