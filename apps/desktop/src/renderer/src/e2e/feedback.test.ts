import axe from "axe-core";
import { act, fireEvent, screen } from "@testing-library/react/pure";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { advance, eventually, flow } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await current?.dispose();
  current = undefined;
});

const checkbox = () =>
  screen.getByRole("checkbox", { name: "Attach the redacted diagnostics shown below" });
const continueButton = () => screen.getByRole("button", { name: "Continue to draft" });

it("the crash report says when diagnostics fail, retries them, and can continue without them", async () => {
  let calls = 0;
  current = await flow({
    handlers: {
      CrashReportPending: () => Effect.succeed(true),
      FeedbackAddress: () => Effect.succeed("feedback@example.com"),
      Diagnostics: () =>
        ++calls === 1 ? Effect.die(new Error("not ready")) : Effect.succeed('{"event":"snapshot"}'),
    },
  });
  await eventually(() =>
    expect(screen.getByText(/^Couldn't load diagnostics\./).closest('[role="alert"]')).toBeTruthy(),
  );
  expect(screen.getByRole("alertdialog", { name: "OpenMail stopped unexpectedly" })).toBeTruthy();
  expect(checkbox()).toHaveProperty("disabled", true);
  // Continuing without the attachment stays possible.
  expect(continueButton()).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await eventually(() =>
    expect(screen.getByLabelText("Diagnostics preview").textContent).toContain("snapshot"),
  );
  expect(checkbox()).toHaveProperty("disabled", false);
  expect(calls).toBe(2);
});

it("diagnostics that never answer time out instead of loading forever", async () => {
  const h = (current = await flow({
    handlers: {
      FeedbackAddress: () => Effect.succeed("feedback@example.com"),
      Diagnostics: () => Effect.never,
    },
  }));
  await eventually(() => expect(screen.getByRole("heading", { level: 1 })).toBeTruthy());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await h.event({ _tag: "Command", command: "feedback" });
  await eventually(() =>
    expect(screen.getByLabelText("Diagnostics preview").textContent).toBe("Loading diagnostics…"),
  );
  await advance(10_000);
  await eventually(() =>
    expect(screen.getByText(/^Couldn't load diagnostics\./).closest('[role="alert"]')).toBeTruthy(),
  );
  expect(continueButton()).toHaveProperty("disabled", false);
});

it("without a feedback address, the diagnostics can be copied for a GitHub issue", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const opened: string[] = [];
  const h = (current = await flow({
    handlers: {
      FeedbackAddress: () => Effect.succeed(""),
      Diagnostics: () => Effect.succeed('{"event":"snapshot"}'),
      OpenMailLink: ({ url }) => Effect.sync(() => void opened.push(url)),
    },
  }));
  await eventually(() => expect(screen.getByRole("heading", { level: 1 })).toBeTruthy());
  await h.event({ _tag: "Command", command: "feedback" });
  await eventually(() =>
    expect(screen.getByLabelText("Diagnostics preview").textContent).toContain("snapshot"),
  );
  // The draft needs an address; copying does not.
  expect(continueButton()).toHaveProperty("disabled", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
  await eventually(() => expect(writeText).toHaveBeenCalledWith('{"event":"snapshot"}'));
  await eventually(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  // Copied goes back to the button's label, so a second copy confirms again.
  await advance(2_000);
  await eventually(() =>
    expect(screen.getByRole("button", { name: "Copy diagnostics" })).toBeTruthy(),
  );
  vi.useRealTimers();
  // A clipboard that refuses says so in the dialog.
  writeText.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
  await eventually(() =>
    expect(screen.getByText("Couldn't copy diagnostics").getAttribute("role")).toBe("alert"),
  );
  expect(screen.getByRole("button", { name: "Copy diagnostics" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open GitHub issues" }));
  await eventually(() => expect(opened).toEqual(["https://github.com/Fanzzzd/openmail/issues"]));
});

it("the diagnostics preview scrolls from the keyboard", async () => {
  current = await flow({
    handlers: {
      CrashReportPending: () => Effect.succeed(true),
      FeedbackAddress: () => Effect.succeed("feedback@example.com"),
      Diagnostics: () =>
        Effect.succeed(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n")),
    },
  });
  await eventually(() =>
    expect(screen.getByLabelText("Diagnostics preview").textContent).toContain("line 79"),
  );
  const preview = screen.getByLabelText("Diagnostics preview");
  // jsdom has no layout: give the preview the overflow it has in the app (max-h-48, 80 lines).
  preview.style.overflowY = "auto";
  Object.defineProperty(preview, "clientHeight", { configurable: true, value: 192 });
  Object.defineProperty(preview, "scrollHeight", { configurable: true, value: 1200 });
  const box = (top: number, bottom: number) =>
    DOMRect.fromRect({ x: 0, y: top, width: 400, height: bottom - top });
  vi.spyOn(preview, "getBoundingClientRect").mockReturnValue(box(0, 192));
  // The text runs past the preview's bottom edge.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [box(0, 1200)],
  });
  let result: axe.AxeResults | undefined;
  try {
    await act(async () => {
      result = await axe.run(preview, {
        runOnly: { type: "rule", values: ["scrollable-region-focusable"] },
      });
    });
  } finally {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  }
  // The rule applied to the preview, and passed.
  expect(result?.passes.map((issue) => issue.id)).toEqual(["scrollable-region-focusable"]);
  expect(result?.violations.map((issue) => issue.id)).toEqual([]);
});
