import { AuthError, FeatureScopeMissing } from "@openmail/core/portable";
import { Effect, Option } from "effect";
import { afterEach, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import { eventually, flow, incoming, row } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

const remoteHtml = '<p>Hi</p><img src="https://images.example.org/hero.png" alt="Hero">';
const signed = { dmarc: "pass", spf: "pass", dkim: "pass" } as const;
const sender = { name: "FAN Zhendi", address: "fan.zhendi@example.com" };
/** The CSP a message frame carries says whether remote images may load. */
const remote = (frame: HTMLIFrameElement) => frame.srcdoc.includes("img-src data: cid: https:");
const frames = () => [...document.querySelectorAll<HTMLIFrameElement>("iframe[title='Message']")];
const frameOf = (id: string) => {
  const frame = document.querySelector<HTMLIFrameElement>(
    `[data-message-id="${id}"] iframe[title='Message']`,
  );
  if (!frame) throw new Error(`Missing frame for ${id}`);
  return frame;
};
const notices = () => [...document.querySelectorAll("[data-images-notice]")];

/** Two messages in one thread, the newer one listed. */
function conversation(
  first: Parameters<typeof incoming>[1] = {},
  second: Parameters<typeof incoming>[1] = {},
) {
  return [
    incoming("m1", { threadId: "t", from: sender, date: Date.now() - 2000, ...first }),
    incoming("m2", { threadId: "t", from: sender, date: Date.now() - 1000, ...second }),
  ];
}
async function openThread(h: Awaited<ReturnType<typeof flow>>, id: string) {
  await eventually(() => expect(row(h.id(id))).toBeTruthy());
  fireEvent.click(row(h.id(id)));
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
  );
}

it("shows one compact notice per conversation, on the first open message with remote images", async () => {
  current = await flow({
    messages: conversation({ bodyHtml: remoteHtml }, { bodyHtml: remoteHtml, security: signed }),
  });
  const h = current;
  await openThread(h, "m2");
  // Expand the older message too.
  fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
  await eventually(() => expect(frames()).toHaveLength(2));
  await eventually(() => expect(notices()).toHaveLength(1));
  const notice = notices()[0];
  expect(notice?.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe(h.id("m1"));
  expect(notice?.textContent).toContain("Load images");
  // The first sender is not authenticated, so the notice offers no permanent allow.
  expect(notice?.textContent).not.toContain("Always from this sender");
  expect(frames().every((frame) => !remote(frame))).toBe(true);
});

it("shows embedded cid images without a remote image notice", async () => {
  current = await flow({
    messages: [
      incoming("m1", {
        bodyHtml: '<img src="cid:logo" alt="Logo">',
        attachments: [{ filename: "logo.png", mimeType: "image/png", size: 3 }],
      }),
    ],
  });
  const h = current;
  h.server.raw.set(
    "m1",
    new TextEncoder().encode(
      [
        "From: alice@example.com",
        "MIME-Version: 1.0",
        'Content-Type: multipart/related; boundary="b"',
        "",
        "--b",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<img src="cid:logo" alt="Logo">',
        "--b",
        "Content-Type: image/png",
        "Content-Disposition: inline; filename=logo.png",
        "Content-ID: <logo>",
        "Content-Transfer-Encoding: base64",
        "",
        "AQID",
        "--b--",
        "",
      ].join("\r\n"),
    ),
  );
  await openThread(h, "m1");
  await eventually(() =>
    expect(frameOf(h.id("m1")).srcdoc).toContain("data:image/png;base64,AQID"),
  );
  expect(notices()).toHaveLength(0);
  expect(remote(frameOf(h.id("m1")))).toBe(false);
});

it("Load images covers only the messages on screen at the click", async () => {
  current = await flow({
    messages: conversation({ bodyHtml: remoteHtml }, { bodyHtml: remoteHtml }),
  });
  const h = current;
  await openThread(h, "m2");
  fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
  await eventually(() => expect(frames()).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Load images" }));
  await eventually(() => expect(frames().every(remote)).toBe(true));
  expect(notices()).toHaveLength(0);
  // A reply threaded in later still asks.
  h.server.messages.set(
    "m3",
    incoming("m3", { threadId: "t", from: sender, date: Date.now(), bodyHtml: remoteHtml }),
  );
  await h.event({ _tag: "NativeAction", action: "sync", triggeredByAccelerator: false });
  await eventually(() =>
    expect(document.querySelector(`[data-message-id="${h.id("m3")}"]`)).not.toBeNull(),
  );
  const collapsed = document.querySelector<HTMLButtonElement>(
    `button[data-message-id="${h.id("m3")}"]`,
  );
  if (collapsed) fireEvent.click(collapsed);
  await eventually(() =>
    expect(notices()[0]?.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe(
      h.id("m3"),
    ),
  );
  expect(remote(frameOf(h.id("m3")))).toBe(false);
});

it("Load images in single-message mode leaves sibling messages blocked", async () => {
  current = await flow({
    prefs: { threadGrouping: false },
    messages: conversation({ bodyHtml: remoteHtml }, { bodyHtml: remoteHtml }),
  });
  const h = current;
  await openThread(h, "m1");
  fireEvent.click(screen.getByRole("button", { name: "Load images" }));
  await eventually(() => expect(remote(frameOf(h.id("m1")))).toBe(true));
  fireEvent.click(row(h.id("m2")));
  await eventually(() => expect(frames().map((frame) => remote(frame))).toEqual([false]));
  expect(document.querySelector(`[data-message-id="${h.id("m2")}"] iframe`)).not.toBeNull();
  expect(notices()).toHaveLength(1);
});

it("offers Always from this sender for an authenticated sender", async () => {
  current = await flow({
    messages: [incoming("m1", { from: sender, bodyHtml: remoteHtml, security: signed })],
  });
  await openThread(current, "m1");
  await eventually(() =>
    expect(screen.getByRole("button", { name: "Always from this sender" })).toBeTruthy(),
  );
});

it("keeps remote images blocked until prefs load, then follows the loading default", async () => {
  current = await flow({
    holdPrefs: true,
    prefs: { remoteImages: "always" },
    messages: [incoming("m1", { bodyHtml: remoteHtml })],
  });
  const h = current;
  await openThread(h, "m1");
  await eventually(() => expect(frames()).toHaveLength(1));
  expect(remote(frameOf(h.id("m1")))).toBe(false);
  expect(screen.getByRole("button", { name: "Load images" })).toBeTruthy();
  await h.releasePrefs();
  await eventually(() => expect(remote(frameOf(h.id("m1")))).toBe(true));
  expect(notices()).toHaveLength(0);
});

it("loads remote images for authenticated known senders when set to people I know", async () => {
  current = await flow({
    prefs: { remoteImages: "known" },
    messages: [
      incoming("m1", { from: sender, bodyHtml: remoteHtml, security: signed }),
      incoming("m2", {
        from: { name: "Stranger", address: "stranger@example.com" },
        bodyHtml: remoteHtml,
      }),
    ],
  });
  const h = current;
  await h.run(h.store.rememberMailedAddresses(h.account.id, [sender.address]));
  await openThread(h, "m1");
  await eventually(() => expect(remote(frameOf(h.id("m1")))).toBe(true));
  expect(notices()).toHaveLength(0);
  fireEvent.click(row(h.id("m2")));
  await eventually(() => expect(remote(frameOf(h.id("m2")))).toBe(false));
});

it("stacks the message header in narrow containers without breaking names inside words", async () => {
  const address = "fan.zhendi.with.a.long.address@example.com";
  current = await flow({
    messages: [
      incoming("m1", {
        from: { name: "FAN Zhendi", address },
        security: { dmarc: "fail", spf: "fail", dkim: "fail" },
      }),
    ],
  });
  await openThread(current, "m1");
  const article = screen.getByRole("article", { name: /^Selected message/ });
  expect(article.innerHTML).not.toContain("break-all");
  expect(article.className).toContain("@container/message");
  const name = article.querySelector("[data-sender-name]");
  expect(name?.className).toContain("break-words");
  expect(name?.className).toContain("line-clamp-2");
  expect(name?.getAttribute("title")).toContain("FAN Zhendi");
  const nameRow = name?.closest(".flex-col");
  expect(nameRow?.className).toContain("@min-[520px]/message:flex-row");
  // Below 420 px the date takes its own line so the address keeps the width.
  const date = article.querySelector("[data-message-date]");
  expect(date?.className).toContain("@max-[420px]/message:basis-full");
  expect(date?.parentElement?.className).toContain("@max-[420px]/message:flex-wrap");
  const shown = article.querySelector("[data-sender-address]");
  expect(shown?.className).toContain("truncate");
  expect(shown?.getAttribute("title")).toBe(address);
  // The DMARC warning sits on its own line, outside the name row.
  const warning = screen.getByText("Sender authentication failed (DMARC)");
  expect(warning.className).toContain("block");
  expect(nameRow?.contains(warning)).toBe(false);
});

it("moves Expand all and Collapse all into the thread menu below 520 px", async () => {
  // Without the toolbar, the thread's commands sit in the reader's own menu.
  current = await flow({
    prefs: { toolbarVisible: false },
    messages: conversation({ subject: "Quarterly report" }, { subject: "Quarterly report" }),
  });
  await openThread(current, "m2");
  const scroller = document.querySelector('[role="document"]');
  expect(scroller?.className).toContain("@container/thread");
  // Long subjects take fewer lines in a narrow reader.
  const subject = screen.getByRole("heading", { level: 2, name: "Quarterly report" });
  expect(subject.className).toContain("text-[20px]");
  expect(subject.className).toContain("@min-[520px]/thread:text-[24px]");
  const inline = screen.getByRole("button", { name: "Expand all" });
  expect(inline.parentElement?.className).toContain("hidden");
  expect(inline.parentElement?.className).toContain("@min-[520px]/thread:flex");
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(await screen.findByRole("menuitem", { name: /^Expand all/ })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: /^Collapse all/ })).toBeTruthy();
});

const attendee = (line: string) => `ATTENDEE;${line}`;
function invitation(
  method = "REQUEST",
  attendees = [attendee("PARTSTAT=NEEDS-ACTION:mailto:me@gmail.com")],
) {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    "UID:invite",
    "SEQUENCE:0",
    "DTSTART:20261005T090000",
    "DTEND:20261005T100000",
    "SUMMARY:Planning",
    "ORGANIZER;CN=Organizer:mailto:organizer@example.com",
    ...attendees,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  return new TextEncoder().encode(
    `From: organizer@example.com\r\nTo: me@gmail.com\r\nMIME-Version: 1.0\r\nContent-Type: text/calendar; method=${method}\r\n\r\n${ics}`,
  );
}
/** One invitation in the inbox, its raw source on the server. */
async function inviteFlow(raw = invitation()) {
  current = await flow({
    messages: [
      incoming("m1", {
        subject: "Planning",
        attachments: [{ filename: "invite.ics", mimeType: "text/calendar", size: 100 }],
        hasCalendar: true,
      }),
    ],
  });
  current.server.raw.set("m1", raw);
  return current;
}

it("says Calendar access is off instead of asking to sign in again", async () => {
  const h = await inviteFlow();
  await h.run(h.m.accounts.setServiceEnabled(h.account.id, "calendar", false));
  await openThread(h, "m1");
  await eventually(() => expect(screen.getByText(/Calendar access is off/)).toBeTruthy());
  expect(screen.getByRole("button", { name: "Turn it on in Settings" })).toBeTruthy();
  const reader = screen.getByRole("article", { name: /^Selected message/ });
  expect(reader.textContent).not.toContain("Sign in again");
  expect(reader.textContent).not.toContain("Your overlapping events");
});

it("keeps invitation times whole per side and response buttons a wrapping row", async () => {
  const h = await inviteFlow();
  await openThread(h, "m1");
  const accept = await screen.findByRole("button", { name: "Accept" });
  const reader = screen.getByRole("article", { name: /^Selected message/ });
  const sides = reader.querySelectorAll("span.inline-block");
  expect(sides).toHaveLength(2);
  expect(sides[0]?.textContent).toMatch(/→$/);
  expect(accept.className).toContain("min-w-24");
  expect(accept.className).not.toContain("break-all");
  expect(accept.parentElement?.className).toContain("flex-wrap");
});

it("asks for calendar consent, not a new sign-in, when the provider refuses calendar access", async () => {
  const h = await inviteFlow();
  // Legacy accounts have no recorded grants and count as granted until the provider answers 403.
  h.server.featureFailure = new FeatureScopeMissing({
    accountId: h.account.id,
    feature: "calendar",
    message: "403",
  });
  await openThread(h, "m1");
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ }).textContent).toContain(
      "Calendar access isn't granted for this account.",
    ),
  );
  const reader = screen.getByRole("article", { name: /^Selected message/ });
  expect(reader.textContent).not.toContain("Couldn't load your calendar");
  expect(reader.textContent).not.toContain("Sign in again");
  expect(screen.getByRole("button", { name: "Connect calendar" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
});

it("lists a reply's attendees with their status and optional flag in one message each", async () => {
  const h = await inviteFlow(
    invitation("REPLY", [
      attendee("CN=Ann;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:ann@example.com"),
      attendee("PARTSTAT=DECLINED:mailto:bo@example.com"),
    ]),
  );
  await openThread(h, "m1");
  await eventually(() =>
    expect(screen.getByRole("article", { name: /^Selected message/ }).textContent).toContain(
      "Attendees: Ann <ann@example.com> (optional, Accepted) and bo@example.com (Declined)",
    ),
  );
});

it("asks to sign in again only when the provider rejects the sign-in", async () => {
  const h = await inviteFlow();
  // The fake answers every calendar call with this failure; a rejected token is an AuthError.
  Object.assign(h.server, { featureFailure: new AuthError({ message: "401" }) });
  await openThread(h, "m1");
  await eventually(() =>
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: "Connect calendar" })).toBeNull();
});

it("keeps the search field on one line and shows the scope as an icon at every width", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const field = screen.getByRole("combobox", { name: "Search mail" });
  fireEvent.change(field, { target: { value: 'subject:"openmail 测试 邀请" ' } });
  await eventually(() => expect(screen.getByRole("button", { name: /^Modify / })).toBeTruthy());
  const chips = screen.getByRole("combobox", { name: "Search mail" }).parentElement;
  expect(chips?.className).not.toContain("flex-wrap");
  expect(chips?.className).toContain("h-7");
  expect(chips?.className).toContain("overflow-x-auto");
  expect(field.getAttribute("placeholder")).toBeNull();
  expect(screen.getByRole("button", { name: /^Modify / }).className).toContain("truncate");
  expect(field.closest("[class*='@container/search']")).not.toBeNull();
  // The scope names itself as a scope, so it never reads as the folder in the list title.
  const scope = screen.getByRole("combobox", { name: "Search scope: All Mail" });
  expect(scope.className).toContain("shrink-0");
  expect(scope.querySelector("svg")).not.toBeNull();
  expect(scope.innerHTML).toContain("sr-only");
  expect(scope.innerHTML).not.toContain("@max-[340px]/search:sr-only");
});

it("opens an older message whose attachment matched the search", async () => {
  const pdf = [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 10 }];
  current = await flow({
    messages: [
      incoming("m1", {
        threadId: "t",
        date: Date.now() - 4000,
        bodyText: "First",
        attachments: pdf,
      }),
      incoming("m2", {
        threadId: "t",
        date: Date.now() - 3000,
        bodyText: "Second",
        attachments: pdf,
      }),
      incoming("m3", { threadId: "t", date: Date.now() - 2000, bodyText: "Third" }),
      incoming("m4", { threadId: "t", date: Date.now() - 1000, bodyText: "Fourth" }),
    ],
  });
  const h = current;
  // Finish both attachments' text extraction the way the media worker does.
  await h.run(
    Effect.gen(function* () {
      for (;;) {
        const job = yield* h.store.media.claim("test", 0, true);
        if (Option.isNone(job)) break;
        const id = job.value.message_id;
        yield* h.store.media.complete(
          job.value,
          id === h.id("m1") || id === h.id("m2")
            ? [
                {
                  messageId: id,
                  text: id === h.id("m1") ? "total amount" : "amount due",
                  source: {
                    kind: "attachment",
                    index: 0,
                    name: "invoice.pdf",
                    mimeType: "application/pdf",
                  },
                  page: 1,
                  region: null,
                  pipelineVersion: "test",
                  visionRevision: null,
                },
              ]
            : [],
          null,
        );
      }
      while (!(yield* h.store.backfillWordIndex(500)).ready) yield* Effect.void;
    }),
  );
  const article = (id: string) => document.querySelector(`article[data-message-id="${h.id(id)}"]`);
  await openThread(h, "m4");
  expect(["m1", "m2", "m3"].map(article)).toEqual([null, null, null]);
  fireEvent.change(screen.getByRole("combobox", { name: "Search mail" }), {
    target: { value: "amount" },
  });
  await eventually(() => expect(document.querySelector("[data-id] mark")).not.toBeNull());
  const result = document.querySelector("[data-id] mark")?.closest<HTMLElement>("[data-id]");
  if (!result) throw new Error("Missing search result");
  fireEvent.click(result);
  // Both attachment matches open with their snippets, whichever the row stands for.
  await eventually(() => expect(article("m1")?.textContent).toContain("total amount"));
  await eventually(() => expect(article("m2")?.textContent).toContain("amount due"));
  expect(article("m3")).toBeNull();
});
