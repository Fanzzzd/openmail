// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { MobileDatabaseState, MobileRecoveryReport } from "@openmail/core/portable";
import { MailboxProvider } from "./mailbox";

const native = vi.hoisted(() => {
  const state: { value: MobileDatabaseState } = { value: { kind: "corrupt" } };
  return {
    state,
    os: "ios",
    rebuild: vi.fn<() => Promise<MobileRecoveryReport>>(),
    acknowledge: vi.fn(),
    mailbox: vi.fn(),
  };
});
const translations = vi.hoisted(() => ({
  i18n: {
    _: ({ message, values }: { message: string; values?: Record<string, string | number> }) =>
      message.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? `{${key}}`)),
  },
}));
vi.mock("@lingui/react", () => ({ useLingui: () => translations }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  ActivityIndicator: () => null,
  Text: "span",
  View: "div",
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
vi.mock("./controls", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({
      label,
      onPress,
      disabled,
    }: {
      label: string;
      onPress: () => void;
      disabled: boolean;
    }) => createElement("button", { onClick: onPress, disabled }, label),
  };
});
vi.mock("./platform", async () => {
  const { TestMailbox } = await import("@openmail/core/testing/node");
  return {
    mobileMailboxLayer: (inspection?: MobileDatabaseState) => {
      native.mailbox(inspection);
      return TestMailbox({}, { backgroundFlush: false, imapIdle: false, localDraftQueue: true });
    },
  };
});
vi.mock("./platform/database-recovery", async () => {
  const { MobileDatabaseRecovery, MobileRecoveryError } = await import("@openmail/core/portable");
  const { Effect, Layer, ManagedRuntime } = await import("effect");
  const runtime = ManagedRuntime.make(
    Layer.succeed(MobileDatabaseRecovery, {
      inspect: () => Effect.sync(() => native.state.value),
      open: () => Effect.die(new Error("unused")),
      rebuild: Effect.tryPromise({
        try: () => native.rebuild(),
        catch: () =>
          new MobileRecoveryError({ reason: "unavailable", message: "Storage unavailable" }),
      }),
      acknowledge: Effect.sync(() => {
        native.acknowledge();
        native.state.value = { kind: "healthy" };
      }),
    }),
  );
  return { databaseRecoveryRuntime: () => runtime };
});
afterEach(() => {
  native.os = "ios";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function render(state: MobileDatabaseState) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.state.value = state;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(MailboxProvider, null, createElement("p", null, "mailbox-ready"))),
  );
  return { container, unmount: () => act(async () => root.unmount()) };
}
const report = {
  backup: "mail.db.corrupt-original",
  fresh: "mail.db.recovery-new",
  copied: 4,
  skipped: 1,
};

it("requires the user's recovery action and acknowledgment before opening a corrupt mailbox", async () => {
  native.rebuild.mockResolvedValue(report);
  const view = await render({ kind: "corrupt" });
  try {
    expect(view.container.textContent).toContain("The local database could not be verified");
    expect(native.mailbox).not.toHaveBeenCalled();
    expect(native.rebuild).not.toHaveBeenCalled();
    expect(view.container.querySelector("button")?.textContent).toBe("Rebuild local database");
    await act(async () => view.container.querySelector("button")?.click());
    expect(native.rebuild).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain("The local database was recovered");
    expect(native.mailbox).not.toHaveBeenCalled();
    await act(async () => view.container.querySelector("button")?.click());
    await vi.waitFor(async () => {
      await act(
        async () =>
          new Promise((resolve) => {
            setTimeout(resolve, 0);
          }),
      );
      expect(view.container.textContent).toBe("mailbox-ready");
    });
    expect(native.acknowledge).toHaveBeenCalledOnce();
    expect(native.mailbox).toHaveBeenCalledWith({ kind: "healthy" });
  } finally {
    await view.unmount();
  }
});

it("keeps the interrupted recovery screen and offers retry when storage recovery fails", async () => {
  native.rebuild.mockRejectedValue(new Error("Disk full"));
  const view = await render({ kind: "interrupted" });
  try {
    expect(view.container.textContent).toContain(
      "Database recovery was interrupted. Try recovery again.",
    );
    await act(async () => view.container.querySelector("button")?.click());
    expect(view.container.textContent).toContain("Could not rebuild the local database");
    expect(view.container.querySelector("button")?.disabled).toBe(false);
    expect(native.mailbox).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it("shows a persisted recovery report after restart without repeating the rebuild", async () => {
  const view = await render({ kind: "recovered", report });
  try {
    expect(view.container.textContent).toContain("The local database was recovered");
    expect(view.container.querySelector("button")?.textContent).toBe("Continue");
    expect(view.container.textContent).not.toContain(report.backup);
    expect(view.container.textContent).not.toContain("Original database:");
    expect(native.rebuild).not.toHaveBeenCalled();
    expect(native.mailbox).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it("keeps the preserved filename in the Android recovery report", async () => {
  native.os = "android";
  const view = await render({ kind: "recovered", report });
  try {
    expect(view.container.textContent).toContain(report.backup);
  } finally {
    await view.unmount();
  }
});

it("returns to the rebuild screen when a rejected replacement invalidates the interrupted marker", async () => {
  native.rebuild.mockImplementation(async () => {
    native.state.value = { kind: "corrupt" };
    throw new Error("Invalid replacement");
  });
  const view = await render({ kind: "interrupted" });
  try {
    await act(async () => view.container.querySelector("button")?.click());
    expect(view.container.textContent).not.toContain("Database recovery was interrupted.");
    expect(view.container.textContent).toContain(
      "Local drafts and queued changes are kept when readable.",
    );
    expect(view.container.querySelector("button")?.textContent).toBe("Rebuild local database");
  } finally {
    await view.unmount();
  }
});
