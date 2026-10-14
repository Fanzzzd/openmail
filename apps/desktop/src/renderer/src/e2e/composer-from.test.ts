import { PermanentError, type SendAs } from "@openmail/core/portable";
import { afterEach, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import { clickButton, eventually, flow, incoming, key, row, wait } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

type Flow = Awaited<ReturnType<typeof flow>>;
const suggestions = (h: Flow) => h.requests.filter((request) => request.tag === "SuggestSender");
const from = () => screen.getByRole("combobox", { name: "From" });
/** Longer than the composer's 300 ms wait before it asks for a better From. */
const settle = () => wait(600);
function edit(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
}
const alias = (accountId: string): SendAs => ({
  accountId,
  address: "alias@example.com",
  name: "Alias",
  isDefault: false,
  signature: "",
});
async function withAlias(h: Flow) {
  h.server.aliases = [alias(h.account.id)];
  await h.run(h.m.sync.sync());
}
const draft = { to: [{ name: "", address: "alice@example.com" }], subject: "Reopened", text: "" };

it("From suggestions run for a fresh compose", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  clickButton("New message");
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  edit("To", "alice@example.com");
  await eventually(() => expect(suggestions(h)).toHaveLength(1));
});

for (const synced of [true, false])
  it(`From suggestions leave a reopened draft's From alone (synced: ${String(synced)})`, async () => {
    current = await flow({
      storedDraft: {
        message: { ...draft, cc: [], bcc: [], attachments: [] },
        failPush: synced ? undefined : new PermanentError({ message: "Raw provider details" }),
      },
    });
    const h = current;
    await eventually(() =>
      expect(screen.getByRole("textbox", { name: "Subject" })).toHaveProperty("value", "Reopened"),
    );
    if (!h.composeId) throw new Error("Missing stored draft");
    expect((await h.run(h.m.compose.openDraft(h.composeId))).synced).toBe(synced);
    await settle();
    expect(suggestions(h)).toHaveLength(0);
  });

for (const preference of ["received", "default"] as const)
  it(`Reply From ${preference} wins over best-From suggestions`, async () => {
    current = await flow({
      prefs: { replyFrom: preference },
      messages: [incoming("one", { to: [{ name: "", address: "alias@example.com" }] })],
    });
    const h = current;
    await withAlias(h);
    await eventually(() => expect(row(h.id("one"))).toBeTruthy());
    fireEvent.click(row(h.id("one")));
    await eventually(() =>
      expect(screen.getByRole("article", { name: /^Selected message/ })).toBeTruthy(),
    );
    key("r", { metaKey: true });
    await eventually(() =>
      expect(from().textContent).toContain(
        preference === "received" ? "alias@example.com" : h.account.email,
      ),
    );
    await settle();
    expect(suggestions(h)).toHaveLength(0);
    expect(from().textContent).toContain(
      preference === "received" ? "alias@example.com" : h.account.email,
    );
  });

it("best-From still changes the verified sender for new mail", async () => {
  current = await flow({
    messages: [
      incoming("one"),
      incoming("sent", {
        from: { name: "Alias", address: "alias@example.com" },
        to: [{ name: "Alice", address: "alice@example.com" }],
        labels: ["SENT"],
        isUnread: false,
      }),
    ],
  });
  const h = current;
  await withAlias(h);
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  clickButton("New message");
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  expect(from().textContent).toContain(h.account.email);
  edit("To", "alice@example.com");
  await eventually(() => expect(from().textContent).toContain("alias@example.com"));
});

it("Try again sends current edits in one recovery request without first switching to local-only", async () => {
  current = await flow({
    storedDraft: {
      message: { ...draft, cc: [], bcc: [], attachments: [] },
      failPush: new PermanentError({ message: "Raw provider details" }),
    },
  });
  const h = current;
  await eventually(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
  edit("Subject", "Current edits");
  clickButton("Try again");
  await eventually(() =>
    expect(h.requests.filter((request) => request.tag === "RecoverDraft")).toHaveLength(1),
  );
  const [recovery] = h.requests.filter((request) => request.tag === "RecoverDraft");
  expect(recovery?.payload).toMatchObject({
    action: "retry",
    draft: { message: { subject: "Current edits" } },
  });
  expect(document.body.textContent).not.toContain("Raw provider details");
  await eventually(() => expect(h.server.drafts.size).toBe(1));
});
