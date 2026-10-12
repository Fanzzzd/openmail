import { expect, it } from "vitest";
import {
  appHref,
  composeHref,
  mailHref,
  parseAppHref,
  parseSearch,
  stringifySearch,
  threadHref,
} from "./routes";

const id = "gmail:me@gmail.com/one two";

it("builds and parses each route", () => {
  const view = {
    space: "work",
    mailbox: "sent" as const,
    accountId: "gmail:me@gmail.com",
    label: { id: "INBOX/Sub folder", accountId: "imap:me@example.com" },
  };
  const href = mailHref(view, { q: "from:alice ", scope: "folder", thread: id, dialog: "help" });
  expect(href).toBe(
    "/mail/work/sent?account=gmail%3Ame%40gmail.com&label=imap%3Ame%40example.com%2FINBOX%2FSub+folder&q=from%3Aalice+&scope=folder&thread=gmail%3Ame%40gmail.com%2Fone+two&dialog=help",
  );
  expect(parseAppHref(href)).toEqual({
    kind: "mail",
    view,
    state: { q: "from:alice ", scope: "folder", thread: id, dialog: "help" },
  });
  expect(parseAppHref(threadHref(id, true))).toEqual({
    kind: "thread",
    threadId: id,
    single: true,
  });
  expect(threadHref(id)).toBe("/thread/gmail%3Ame%40gmail.com%2Fone%20two");
  expect(parseAppHref(composeHref("draft:1"))).toEqual({ kind: "compose", draftId: "draft:1" });
  for (const href of [
    mailHref({ space: "all", mailbox: "inbox" }),
    threadHref(id),
    composeHref("d"),
  ]) {
    const route = parseAppHref(href);
    expect(route && appHref(route)).toBe(href);
  }
});

it("reads a bare label as a category", () => {
  expect(parseAppHref("/mail/all/inbox?label=CATEGORY_SOCIAL")).toMatchObject({
    view: { space: "all", mailbox: "inbox", label: { id: "CATEGORY_SOCIAL" } },
  });
});

it("drops invalid search params and keeps the rest", () => {
  expect(
    parseAppHref("/mail/all/inbox?scope=everywhere&dialog=root&thread=&q=hi&message=m"),
  ).toEqual({
    kind: "mail",
    view: { space: "all", mailbox: "inbox" },
    state: { q: "hi", message: "m" },
  });
  expect(parseAppHref("/mail/all/inbox?label=%2F")).toMatchObject({
    view: { space: "all", mailbox: "inbox" },
  });
  expect(parseAppHref("/thread/x?single=yes")).toEqual({
    kind: "thread",
    threadId: "x",
    single: false,
  });
});

it("keeps every search value a string", () => {
  expect(parseSearch("?thread=123&q=true&q=second")).toEqual({ thread: "123", q: "true" });
  expect(stringifySearch({ a: "", b: undefined, c: "1" })).toBe("?c=1");
  expect(stringifySearch({})).toBe("");
});

it("rejects hrefs that leave the app's routes", () => {
  for (const href of [
    "https://example.com/mail/all/inbox",
    "//example.com/mail/all/inbox",
    "javascript:alert(1)",
    "app://app/index.html#/mail/all/inbox",
    "mail/all/inbox",
    "/mail/all/nowhere",
    "/mail/all",
    "/mail/all/inbox/extra",
    "/mail//inbox",
    "/thread/",
    "/thread/a/b",
    "/thread/%E0%A4%A",
    "/thread/a%0Ab",
    "/thread/x#y",
    "/\\example.com",
    "/settings",
    `/thread/${"x".repeat(9000)}`,
  ])
    expect(parseAppHref(href), href).toBeNull();
});
