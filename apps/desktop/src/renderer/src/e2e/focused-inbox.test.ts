import { afterEach, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import { flow, eventually, incoming, row, clickButton, key } from "./harness";
let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});
const rows = () =>
  [...document.querySelectorAll("[data-id]")]
    .map((element) => element.getAttribute("data-id") ?? "")
    .toSorted((left, right) => left.localeCompare(right));

it.each([false, true])(
  "category lists include Outlook and exhaust Inbox (mixed Gmail=%s)",
  async (mixed) => {
    current = await flow({
      provider: "outlook",
      prefs: { threadGrouping: false },
      messages: [
        incoming("focused", { labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"] }),
        incoming("other", { labels: ["INBOX", "UNREAD", "CATEGORY_OTHER"] }),
        incoming("unknown"),
      ],
    });
    const h = current;
    let gmailPrimary: string | undefined;
    let gmailSocial: string | undefined;
    if (mixed) {
      const account = await h.run(h.m.connect({ provider: "gmail" }));
      await h.run(h.m.sync(account.id));
      gmailPrimary = `${account.id}/gmail-primary`;
      gmailSocial = `${account.id}/gmail-social`;
      await h.run(
        h.store.upsertMessage(
          account.id,
          incoming("gmail-primary", { labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"] }),
        ),
      );
      await h.run(
        h.store.upsertMessage(
          account.id,
          incoming("gmail-social", { labels: ["INBOX", "UNREAD", "CATEGORY_SOCIAL"] }),
        ),
      );
      await h.run(h.m.setPrefs({ threadGrouping: false }));
    }
    const allInbox = (await h.run(h.store.listThreads({ mailbox: "inbox", flat: true })))
      .map((message) => message.id)
      .toSorted((left, right) => left.localeCompare(right));
    const seen: string[] = [];
    const buckets = mixed
      ? ["Primary", "Other", "Social", "Promotions", "Updates", "Forums"]
      : ["Focused", "Other"];
    for (const label of buckets) {
      const button = await screen.findByRole("button", {
        name: new RegExp(`^${label}(?: ?[0-9]+)?$`),
      });
      fireEvent.click(button);
      const expected =
        label === "Focused" || label === "Primary"
          ? [h.id("focused"), h.id("unknown"), ...(gmailPrimary ? [gmailPrimary] : [])].toSorted(
              (left, right) => left.localeCompare(right),
            )
          : label === "Other"
            ? [h.id("other")]
            : label === "Social" && gmailSocial
              ? [gmailSocial]
              : [];
      await eventually(() => expect(rows()).toEqual(expected));
      seen.push(...rows());
      const request = h.requests.filter((entry) => entry.tag === "Threads").at(-1);
      expect(request).toBeDefined();
    }
    expect(seen.toSorted((left, right) => left.localeCompare(right))).toEqual(allInbox);
    expect(new Set(seen).size).toBe(allInbox.length);
  },
);

it("classification moves all Inbox messages in the conversation and Undo restores each one", async () => {
  const date = Date.now();
  current = await flow({
    provider: "outlook",
    messages: [
      incoming("one", {
        threadId: "conversation",
        labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
        date,
      }),
      incoming("two", {
        threadId: "conversation",
        labels: ["INBOX", "UNREAD", "CATEGORY_OTHER"],
        date: date - 1,
      }),
      incoming("old", { threadId: "conversation", labels: ["INBOX", "UNREAD"], date: 1 }),
      incoming("sent", {
        threadId: "conversation",
        labels: ["SENT", "CATEGORY_PERSONAL"],
        isUnread: false,
        date: date - 2,
      }),
    ],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await screen.findByRole("article", { name: /^Selected message/ });
  clickButton("Focused/Other");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Other" }));
  await eventually(async () => {
    for (const id of ["one", "two", "old"])
      expect((await h.run(h.store.getMessage(h.id(id)))).labels).toContain("CATEGORY_OTHER");
  });
  expect((await h.run(h.store.getMessage(h.id("sent")))).labels).toEqual([
    "SENT",
    "CATEGORY_PERSONAL",
  ]);
  key("z", { metaKey: true });
  await eventually(async () => {
    expect((await h.run(h.store.getMessage(h.id("one")))).labels).toContain("CATEGORY_PERSONAL");
    expect((await h.run(h.store.getMessage(h.id("two")))).labels).toContain("CATEGORY_OTHER");
    expect((await h.run(h.store.getMessage(h.id("old")))).labels).toContain("CATEGORY_PERSONAL");
  });
});
