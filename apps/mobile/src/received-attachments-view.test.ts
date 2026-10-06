// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ReceivedAttachments } from "./received-attachments-view";

vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { _: ({ message }: { message: string }) => message } }),
}));
vi.mock("react-native", () => ({
  Text: "span",
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
afterEach(() => vi.unstubAllGlobals());
it("shows the unavailable PDF notice once for a message with multiple PDFs and opens each attachment", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const onOpen = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(ReceivedAttachments, {
          attachments: [
            { filename: "one.pdf", mimeType: "application/pdf", size: 1 },
            { filename: "two.pdf", mimeType: "application/pdf", size: 1 },
          ],
          busy: false,
          onOpen,
        }),
      ),
    );
    expect(container.querySelectorAll("span")).toHaveLength(1);
    expect(container.querySelector("span")?.textContent).toBe(
      "PDF text extraction is unavailable on mobile.",
    );
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    await act(async () => {
      buttons[0]?.click();
      buttons[1]?.click();
    });
    expect(onOpen.mock.calls).toEqual([[0], [1]]);
    await act(async () =>
      root.render(
        createElement(ReceivedAttachments, {
          attachments: [{ filename: "photo.png", mimeType: "image/png", size: 1 }],
          busy: false,
          onOpen,
        }),
      ),
    );
    expect(container.querySelector("span")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
