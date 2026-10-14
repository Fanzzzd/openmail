import { afterEach, expect, it } from "vitest";
import { screen } from "@testing-library/react/pure";
import { clickButton, eventually, flow, key, row } from "./harness";
import { expectComposeTabOrder } from "./compose-tab-check";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

it("Tab goes from Subject to the body, and the editor controls follow the body", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  clickButton("New message");
  await eventually(() => expect(screen.getByRole("textbox", { name: "Subject" })).toBeTruthy());
  expectComposeTabOrder(key);
});
