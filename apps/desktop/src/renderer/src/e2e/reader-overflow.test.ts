import { afterEach, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react/pure";
import { eventually, flow, incoming, row } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

const LONG = `https://example.com/${"a".repeat(400)} ${"-".repeat(300)}`;

it("plain-text mail wraps long tokens and the thread never stays scrolled sideways", async () => {
  current = await flow({ messages: [incoming("one", { bodyText: LONG })] });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(document.querySelector("[data-reader-text] pre")?.textContent).toContain("example.com"),
  );
  const pane = document.querySelector<HTMLElement>("[data-reader-text]");
  if (!pane) throw new Error("Missing reader pane");
  // The pane hides sideways overflow, so a URL or rule line must wrap to stay readable.
  const pre = pane.querySelector("pre");
  expect(pre?.textContent).toContain("-".repeat(300));
  expect(pre?.className).toContain("wrap-anywhere");
  expect(pane.className).toContain("overflow-x-hidden");
  // scrollIntoView (find hits, selection jumps) can scroll a hidden axis; the pane scrolls back.
  let left = 0;
  Object.defineProperty(pane, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (value: number) => (left = value),
  });
  left = 40;
  fireEvent.scroll(pane);
  expect(left).toBe(0);
});
