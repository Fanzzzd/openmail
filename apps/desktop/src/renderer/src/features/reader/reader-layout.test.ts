// @vitest-environment jsdom
import { beforeAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement as h, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { Effect } from "effect";
import {
  AuthError,
  DEFAULT_PREFS,
  FeatureScopeMissing,
  type CalendarInvite,
  type Message,
  type Prefs,
} from "@openmail/core/schema";

const fixture = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  frames: [] as { html: string; remote: boolean }[],
}));
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    useAtomValue: (atom: unknown) => {
      const value = typeof atom === "string" ? (fixture.values.get(atom) ?? []) : {};
      return AsyncResult.isAsyncResult(value) ? value : AsyncResult.success(value);
    },
    // Mocked queries and mutations are strings; local UI atoms keep their real state.
    useAtom: (atom: unknown) =>
      Atom.isAtom(atom) && Atom.isWritable(atom)
        ? actual.useAtom(atom)
        : [AsyncResult.initial(), vi.fn()],
    useAtomSet: () => vi.fn(),
  };
});
vi.mock("../../state/queries", () => ({
  prefsAtom: "prefs",
  accountsAtom: "accounts",
  knownSendersAtom: () => "known",
  imageSendersAtom: "imageSenders",
  inlineImagesAtom: (id: string) => `inline:${id}`,
  threadAtom: () => "thread",
  contactPhotoAtom: () => "photo",
  appleContactsStatusAtom: "apple-status",
  appleContactIdentifierAtom: () => "apple-id",
  invitationsAtom: () => "invitations",
  calendarEventsAtom: () => "calendarEvents",
  detectedEventsAtom: () => "detectedEvents",
  labelsAtom: () => "labels",
  suggestionsAtom: () => "suggestions",
}));
vi.mock("../../state/threads", () => ({ listQueryAtom: "listQuery" }));
vi.mock("../../state/mutations", () => ({
  setImageSenderAtom: "setImageSender",
  setPrefsAtom: "setPrefs",
  respondInviteAtom: "respondInvite",
  reauthAtom: () => "reauth",
  createCalendarEventAtom: "createCalendarEvent",
}));
vi.mock("../../state/rpc", () => ({
  MailClient: { query: (tag: string) => tag, mutation: (tag: string) => tag },
}));
vi.mock("../../state/mail", () => ({
  useRunMail: () => Effect.runSync,
  withMail: () => Effect.void,
  modifyMessages: () => Effect.void,
  markUnreadFrom: () => Effect.void,
  openMessageWindow: () => Effect.void,
  openThreadWindow: () => Effect.void,
  printThread: () => Effect.void,
}));
vi.mock("./frame/EmailFrame", () => ({
  EmailFrame: (props: { html: string; remote: boolean }) => {
    fixture.frames.push({ html: props.html, remote: props.remote });
    return null;
  },
}));
vi.mock("../../app/LazyDialogs", () => ({
  InviteBanner: () => null,
  RawMessageDialog: () => null,
}));
vi.mock("../ai/AiPanel", () => ({ ThreadSummary: () => null }));
vi.mock("../ai/TriageChip", () => ({ TriageChip: () => null }));
vi.mock("./attachments/Attachments", () => ({
  Attachments: ({
    message,
    matches,
  }: {
    message: Message;
    matches: readonly { snippet: string }[];
  }) =>
    h(
      "div",
      { "data-attachment-message": message.id },
      matches.map((match) => match.snippet).join(" "),
    ),
}));
vi.mock("../../ui/Menu", () => ({
  DropdownMenu: ({ trigger, children }: { trigger: ReactNode; children: ReactNode }) =>
    h("div", null, trigger, h("div", { role: "menu" }, children)),
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) =>
    h("button", { type: "button", role: "menuitem", onClick }, children),
  MenuSeparator: () => null,
}));
import { ThreadView } from "./Reader";
import { InviteBanner } from "../calendar/InviteBanner";
import { SearchField } from "../search/SearchField";
import { loadMessageBody } from "./body/MessageBodyShell";

// The reader body is a lazy chunk; load it so renders below are synchronous.
beforeAll(() => loadMessageBody());

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
const localized = (node: ReactNode) => h(I18nProvider, { i18n }, node);
const message = (id: string, patch: Partial<Message> = {}): Message => ({
  id,
  threadId: "thread",
  accountId: "gmail:me",
  subject: "Quarterly report",
  date: Number(id.replace(/\D/g, "")) || 1,
  from: { name: "FAN Zhendi", address: "fan.zhendi@example.com" },
  to: [{ name: "Me", address: "me@example.com" }],
  cc: [],
  replyTo: [],
  labels: ["INBOX"],
  bodyText: "",
  bodyHtml: "<p>Hello</p>",
  snippet: "Hello",
  attachments: [],
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
  ...patch,
});
const remoteHtml = '<p>Hi</p><img src="https://images.example.org/hero.png" alt="Hero">';
const signed = { dmarc: "pass", spf: "pass", dkim: "pass" } as const;
const threadView = (messages: Message[], selectedId: string, single: boolean) =>
  localized(h(ThreadView, { messages, selectedId, single, notify: vi.fn() }));
const thread = (messages: Message[], selectedId = messages.at(-1)?.id ?? "") =>
  render(
    localized(
      h(ThreadView, {
        messages,
        selectedId,
        single: false,
        notify: vi.fn(),
      }),
    ),
  );
const setPrefs = (patch: Partial<Prefs>) =>
  fixture.values.set("prefs", { ...DEFAULT_PREFS, ...patch });

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  fixture.values.clear();
  fixture.frames.length = 0;
  // These tests cover the blocked-image notice, which only the ask mode shows by default.
  setPrefs({ remoteImages: "ask", remoteImagesChosen: true });
  fixture.values.set("accounts", [{ id: "gmail:me", provider: "gmail", email: "me@example.com" }]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows embedded cid images without a remote image notice", () => {
  fixture.values.set("inline:m1", { logo: "data:image/png;base64,AQID" });
  const view = thread([message("m1", { bodyHtml: '<img src="cid:logo" alt="Logo">' })]);
  expect(view.container.querySelector("[data-images-notice]")).toBeNull();
  expect(fixture.frames.at(-1)?.html).toContain("data:image/png;base64,AQID");
  expect(fixture.frames.at(-1)?.remote).toBe(false);
});

it("shows one compact notice per conversation, on the first open message with remote images", () => {
  const view = thread(
    [
      message("m1", { bodyHtml: remoteHtml }),
      message("m2", { bodyHtml: remoteHtml, security: signed }),
    ],
    "m1",
  );
  expect(view.container.querySelectorAll("article")).toHaveLength(2);
  const notices = view.container.querySelectorAll("[data-images-notice]");
  expect(notices).toHaveLength(1);
  expect(notices[0]?.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("m1");
  expect(notices[0]?.textContent).toContain("Load images");
  // The first sender is not authenticated, so the notice offers no permanent allow.
  expect(notices[0]?.textContent).not.toContain("Always from this sender");
  expect(fixture.frames.every((frame) => !frame.remote)).toBe(true);
});

it("Load images covers only the messages on screen at the click", () => {
  const first = message("m1", { threadId: "loaded", bodyHtml: remoteHtml });
  const second = message("m2", { threadId: "loaded", bodyHtml: remoteHtml });
  const view = render(threadView([first, second], "m1", false));
  act(() => screen.getByRole("button", { name: "Load images" }).click());
  expect(view.container.querySelector("[data-images-notice]")).toBeNull();
  expect(fixture.frames.slice(-2).every((frame) => frame.remote)).toBe(true);
  // A reply threaded in later still asks.
  const later = message("m3", { threadId: "loaded", bodyHtml: remoteHtml });
  view.rerender(threadView([first, second, later], "m1", false));
  const row = view.container.querySelector<HTMLButtonElement>('button[data-message-id="m3"]');
  act(() => row?.click());
  const notice = view.container.querySelector("[data-images-notice]");
  expect(notice?.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("m3");
});

it("Load images in single-message mode leaves sibling messages blocked", () => {
  const first = message("m1", { threadId: "single", bodyHtml: remoteHtml });
  const second = message("m2", { threadId: "single", bodyHtml: remoteHtml });
  const view = render(threadView([first, second], "m1", true));
  act(() => screen.getByRole("button", { name: "Load images" }).click());
  expect(fixture.frames.at(-1)?.remote).toBe(true);
  view.rerender(threadView([first, second], "m2", true));
  expect(fixture.frames.at(-1)?.remote).toBe(false);
  expect(view.container.querySelector("[data-images-notice]")).not.toBeNull();
});

it("offers Always from this sender for an authenticated sender", () => {
  thread([message("m1", { bodyHtml: remoteHtml, security: signed })]);
  expect(screen.getByRole("button", { name: "Always from this sender" })).toBeTruthy();
});

it("keeps remote images blocked until prefs load, then follows the loading default", () => {
  for (const pending of [AsyncResult.initial(), AsyncResult.fail(new Error("offline"))]) {
    fixture.values.set("prefs", pending);
    thread([message("m1", { bodyHtml: remoteHtml })]);
    expect(fixture.frames.at(-1)?.remote).toBe(false);
    expect(screen.getByRole("button", { name: "Load images" })).toBeTruthy();
    cleanup();
  }
  setPrefs({});
  const view = thread([message("m1", { bodyHtml: remoteHtml })]);
  expect(view.container.querySelector("[data-images-notice]")).toBeNull();
  expect(fixture.frames.at(-1)?.remote).toBe(true);
});

it("loads remote images for authenticated known senders when set to people I know", () => {
  setPrefs({ remoteImages: "known" });
  fixture.values.set("known", ["fan.zhendi@example.com"]);
  const view = thread([message("m1", { bodyHtml: remoteHtml, security: signed })]);
  expect(view.container.querySelector("[data-images-notice]")).toBeNull();
  expect(fixture.frames.at(-1)?.remote).toBe(true);
  cleanup();
  thread([message("m2", { bodyHtml: remoteHtml })]);
  expect(fixture.frames.at(-1)?.remote).toBe(false);
});

it("stacks the message header in narrow containers without breaking names inside words", () => {
  const view = thread([
    message("m1", {
      security: { dmarc: "fail", spf: "fail", dkim: "fail" },
      from: { name: "FAN Zhendi", address: "fan.zhendi.with.a.long.address@example.com" },
    }),
  ]);
  expect(view.container.innerHTML).not.toContain("break-all");
  const article = view.container.querySelector("article");
  expect(article?.className).toContain("@container/message");
  const name = view.container.querySelector("[data-sender-name]");
  expect(name?.className).toContain("break-words");
  expect(name?.className).toContain("line-clamp-2");
  expect(name?.getAttribute("title")).toContain("FAN Zhendi");
  const row = name?.closest(".flex-col");
  expect(row?.className).toContain("@min-[520px]/message:flex-row");
  // Below 420 px the date takes its own line so the address keeps the width.
  const date = view.container.querySelector("[data-message-date]");
  expect(date?.className).toContain("@max-[420px]/message:basis-full");
  expect(date?.parentElement?.className).toContain("@max-[420px]/message:flex-wrap");
  const address = view.container.querySelector("[data-sender-address]");
  expect(address?.className).toContain("truncate");
  expect(address?.getAttribute("title")).toBe("fan.zhendi.with.a.long.address@example.com");
  // The DMARC warning sits on its own line, outside the name row.
  const warning = screen.getByText("Sender authentication failed (DMARC)");
  expect(warning.className).toContain("block");
  expect(row?.contains(warning)).toBe(false);
});

it("moves Expand all and Collapse all into the thread menu below 520 px", () => {
  const view = thread([message("m1"), message("m2")]);
  const scroller = view.container.querySelector('[role="document"]');
  expect(scroller?.className).toContain("@container/thread");
  // Long subjects take fewer lines in a narrow reader.
  const subject = screen.getByRole("heading", { level: 2, name: "Quarterly report" });
  expect(subject.className).toContain("text-[20px]");
  expect(subject.className).toContain("@min-[520px]/thread:text-[24px]");
  const inline = screen.getAllByRole("button", { name: "Expand all" });
  expect(inline[0]?.parentElement?.className).toContain("hidden");
  expect(inline[0]?.parentElement?.className).toContain("@min-[520px]/thread:flex");
  expect(screen.getByRole("menuitem", { name: "Expand all" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Collapse all" })).toBeTruthy();
});

const invite: CalendarInvite = {
  key: "invite",
  uid: "invite",
  sequence: 0,
  method: "REQUEST",
  cancelled: false,
  title: "Planning",
  start: { kind: "floating", value: "2026-10-05T09:00:00" },
  end: { kind: "floating", value: "2026-10-05T10:00:00" },
  location: "",
  organizer: { name: "Organizer", address: "organizer@example.com" },
  attendees: [{ name: "Me", address: "me@example.com", status: "NEEDS-ACTION", optional: false }],
  recurrence: [],
  recurrenceId: null,
  organizerMismatch: false,
};

it("says Calendar access is off instead of asking to sign in again", () => {
  fixture.values.set("invitations", [invite]);
  fixture.values.set("OptionalServices", [{ service: "calendar", state: "turnedOff" }]);
  const view = render(
    localized(h(InviteBanner, { message: message("m1", { hasCalendar: true }) })),
  );
  expect(screen.getByText(/Calendar access is off/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Turn it on in Settings" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("Sign in again");
  expect(view.container.textContent).not.toContain("Your overlapping events");
});

it("keeps invitation times whole per side and response buttons a wrapping row", () => {
  fixture.values.set("invitations", [invite]);
  fixture.values.set("OptionalServices", [{ service: "calendar", state: "granted" }]);
  const view = render(
    localized(h(InviteBanner, { message: message("m1", { hasCalendar: true }) })),
  );
  const sides = view.container.querySelectorAll("span.inline-block");
  expect(sides).toHaveLength(2);
  expect(sides[0]?.textContent).toMatch(/→$/);
  const accept = screen.getByRole("button", { name: "Accept" });
  expect(accept.className).toContain("min-w-24");
  expect(accept.className).not.toContain("break-all");
  expect(accept.parentElement?.className).toContain("flex-wrap");
});

it("asks for calendar consent, not a new sign-in, when the provider refuses calendar access", () => {
  fixture.values.set("invitations", [invite]);
  // Legacy accounts have no recorded grants and count as granted until the provider answers 403.
  fixture.values.set("OptionalServices", [{ service: "calendar", state: "granted" }]);
  fixture.values.set(
    "calendarEvents",
    AsyncResult.fail(
      new FeatureScopeMissing({ accountId: "gmail:me", feature: "calendar", message: "403" }),
    ),
  );
  const view = render(
    localized(h(InviteBanner, { message: message("m1", { hasCalendar: true }) })),
  );
  expect(view.container.textContent).toContain("Calendar access isn't granted for this account.");
  expect(view.container.textContent).not.toContain("Could not load your calendar");
  expect(view.container.textContent).not.toContain("Sign in again");
  expect(screen.getByRole("button", { name: "Connect Calendar" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
});

it("asks to sign in again only when the provider rejects the sign-in", () => {
  fixture.values.set("invitations", [invite]);
  fixture.values.set("OptionalServices", [{ service: "calendar", state: "granted" }]);
  fixture.values.set("calendarEvents", AsyncResult.fail(new AuthError({ message: "401" })));
  render(localized(h(InviteBanner, { message: message("m1", { hasCalendar: true }) })));
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect Calendar" })).toBeNull();
});

it("keeps the search field on one line and folds the scope into an icon when narrow", () => {
  const view = render(
    localized(
      h(SearchField, {
        value: 'subject:"openmail 测试 邀请" ',
        onChange: vi.fn(),
        inputRef: { current: null },
      }),
    ),
  );
  const field = screen.getByRole("combobox", { name: "Search mail" });
  const chips = field.parentElement;
  expect(chips?.className).not.toContain("flex-wrap");
  expect(chips?.className).toContain("h-7");
  expect(chips?.className).toContain("overflow-hidden");
  expect(field.getAttribute("placeholder")).toBeNull();
  expect(screen.getByRole("button", { name: /^Modify / }).className).toContain("truncate");
  expect(view.container.firstElementChild?.className).toContain("@container/search");
  const scope = screen.getByRole("combobox", { name: "Search scope" });
  expect(scope.className).toContain("shrink-0");
  expect(scope.querySelector("svg")).not.toBeNull();
  expect(scope.innerHTML).toContain("@max-[340px]/search:sr-only");
});

it("opens an older message whose attachment matched the search", () => {
  const messages = [
    message("m1", {
      attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 10 }],
      hasAttachments: true,
    }),
    message("m2"),
    message("m3"),
  ];
  const base = { messages, selectedId: "m3", single: false, notify: vi.fn() };
  const { rerender } = render(localized(h(ThreadView, base)));
  expect(document.querySelector('[data-attachment-message="m1"]')).toBeNull();
  rerender(
    localized(
      h(ThreadView, {
        messages,
        selectedId: "m3",
        single: false,
        notify: vi.fn(),
        searchMatches: [
          {
            source: "attachment",
            messageId: "m1",
            attachmentName: "invoice.pdf",
            attachmentIndex: 0,
            snippet: "total amount",
            highlights: [{ start: 6, end: 12 }],
          },
        ],
      }),
    ),
  );
  expect(document.querySelector('[data-attachment-message="m1"]')?.textContent).toContain(
    "total amount",
  );
});
