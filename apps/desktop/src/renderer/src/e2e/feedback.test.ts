import { fireEvent, screen } from "@testing-library/react/pure";
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
  fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
  await eventually(() => expect(writeText).toHaveBeenCalledWith('{"event":"snapshot"}'));
  await eventually(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Open GitHub issues" }));
  await eventually(() => expect(opened).toEqual(["https://github.com/Fanzzzd/openmail/issues"]));
});
