import { afterEach, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react/pure";
import { act } from "react";
import { BASE_SCOPES, OPTIONAL_SCOPES } from "@openmail/core/schema";
import { flow, eventually } from "./harness";
let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

it("service hint opens the account section, incremental Connect updates the grant, and Turn off persists", async () => {
  current = await flow();
  const h = current;
  await h.run(h.store.setGrantedScopes(h.account.id, BASE_SCOPES.gmail));
  await act(async () => {
    window.dispatchEvent(new CustomEvent("openmail:optional-services", { detail: h.account.id }));
  });
  await eventually(() =>
    expect(screen.getByRole("heading", { name: "Optional services" })).toBeTruthy(),
  );
  const heading = screen.getByRole("heading", { name: "Optional services" });
  const section = heading.parentElement;
  if (!section) throw new Error("Missing service section");
  await eventually(() => expect(within(section).getAllByText("Not granted")).toHaveLength(3));
  const contactsRow = within(section).getByText("Contacts").parentElement;
  if (!contactsRow) throw new Error("Missing contacts row");
  h.server.grantedScopes = [...BASE_SCOPES.gmail, ...OPTIONAL_SCOPES.gmail.contacts];
  fireEvent.click(within(contactsRow).getByRole("button", { name: "Connect" }));
  await eventually(() => expect(within(contactsRow).getByText("Granted")).toBeTruthy());
  expect(h.server.connects.at(-1)?.provider).toBe("gmail");
  expect(h.server.connects.at(-1)).toMatchObject({
    feature: "contacts",
    loginHint: h.account.email,
  });
  fireEvent.click(within(contactsRow).getByRole("checkbox", { name: "Turn off" }));
  await eventually(() => expect(within(contactsRow).getByText("Turned off")).toBeTruthy());
  expect(await h.run(h.store.disabledServices(h.account.id))).toEqual(["contacts"]);
  expect(h.requests.some((request) => request.tag === "SetServiceEnabled")).toBe(true);
});
