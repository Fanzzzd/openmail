// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createElement as h, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";

import { Checkbox } from "./Checkbox";
import { NumberField } from "./NumberField";
import { Radio, RadioCard, RadioGroup } from "./Radio";
import { SettingsGroup, SettingsSwitchRow } from "./SettingsRows";
import { Switch } from "./Switch";
import { ToggleButtons } from "./ToggleButtons";

afterEach(cleanup);

async function serious() {
  let ids: string[] = [];
  await act(async () => {
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    ids = result.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id);
  });
  return ids;
}

function Box({ initial = false, mixed = false }: { initial?: boolean; mixed?: boolean }) {
  const [checked, setChecked] = useState(initial);
  const [indeterminate, setIndeterminate] = useState(mixed);
  return h(
    "form",
    { "aria-label": "Form" },
    h(Checkbox, {
      label: "Archive",
      name: "archive",
      value: "yes",
      checked,
      indeterminate,
      onCheckedChange: (next) => {
        setIndeterminate(false);
        setChecked(next);
      },
    }),
  );
}

it("Checkbox: the label toggles it, Space toggles it, and a form submits its value", async () => {
  const user = userEvent.setup();
  render(h(Box));
  const box = screen.getByRole("checkbox", { name: "Archive" });
  expect(box.getAttribute("aria-checked")).toBe("false");
  await user.click(screen.getByText("Archive"));
  expect(box.getAttribute("aria-checked")).toBe("true");
  const form = screen.getByRole("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Missing form");
  expect(new FormData(form).get("archive")).toBe("yes");
  box.focus();
  await user.keyboard(" ");
  expect(box.getAttribute("aria-checked")).toBe("false");
  expect(new FormData(form).get("archive")).toBeNull();
  expect(await serious()).toEqual([]);
});

it("Checkbox: mixed reads as aria-checked=mixed, draws a dash, and a click checks it", async () => {
  const user = userEvent.setup();
  render(h(Box, { mixed: true }));
  const box = screen.getByRole("checkbox", { name: "Archive" });
  expect(box.getAttribute("aria-checked")).toBe("mixed");
  expect(box.hasAttribute("data-indeterminate")).toBe(true);
  expect(box.querySelector("rect")).toBeTruthy();
  await user.click(box);
  expect(box.getAttribute("aria-checked")).toBe("true");
  expect(box.hasAttribute("data-indeterminate")).toBe(false);
});

it("Checkbox: disabled ignores clicks and reports the event with modifier keys", async () => {
  const seen: { checked: boolean; shift: boolean }[] = [];
  const { rerender } = render(
    h(Checkbox, {
      "aria-label": "Select a.pdf",
      checked: false,
      disabled: true,
      onCheckedChange: (checked, event) =>
        seen.push({ checked, shift: event instanceof MouseEvent && event.shiftKey }),
    }),
  );
  const box = screen.getByRole("checkbox", { name: "Select a.pdf" });
  fireEvent.click(box);
  expect(seen).toEqual([]);
  expect(box.getAttribute("aria-disabled")).toBe("true");
  rerender(
    h(Checkbox, {
      "aria-label": "Select a.pdf",
      checked: false,
      onCheckedChange: (checked, event) =>
        seen.push({ checked, shift: event instanceof MouseEvent && event.shiftKey }),
    }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.pdf" }), { shiftKey: true });
  expect(seen).toEqual([{ checked: true, shift: true }]);
});

it("SettingsSwitchRow: a switch named by its label, described by its hint; the label toggles it", async () => {
  const user = userEvent.setup();
  function Row() {
    const [on, setOn] = useState(true);
    return h(
      SettingsGroup,
      null,
      h(SettingsSwitchRow, {
        label: "Show toolbar",
        hint: "Above the message list.",
        checked: on,
        onCheckedChange: setOn,
      }),
    );
  }
  render(h(Row));
  const toggle = screen.getByRole("switch", { name: "Show toolbar" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  const described = (toggle.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");
  expect(described).toContain("Above the message list.");
  await user.click(screen.getByText("Show toolbar"));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  toggle.focus();
  await user.keyboard(" ");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(await serious()).toEqual([]);
});

it("Switch: disabled stays put", () => {
  const changes: boolean[] = [];
  render(
    h(Switch, {
      "aria-label": "Pause indexing",
      checked: false,
      disabled: true,
      onCheckedChange: (next) => changes.push(next),
    }),
  );
  fireEvent.click(screen.getByRole("switch", { name: "Pause indexing" }));
  expect(changes).toEqual([]);
});

it("RadioGroup: arrow keys move the choice; cards and plain radios are named and described", async () => {
  const user = userEvent.setup();
  function Group() {
    const [value, setValue] = useState<"ask" | "known" | "always">("ask");
    return h(
      "div",
      null,
      h(RadioGroup<"ask" | "known" | "always">, {
        "aria-label": "Remote images",
        value,
        onValueChange: setValue,
        children: [
          h(RadioCard, {
            key: "ask",
            value: "ask",
            label: "Ask each time",
            hint: "Nothing loads until you choose.",
          }),
          h(RadioCard, { key: "known", value: "known", label: "From people I know" }),
          h(Radio, { key: "always", value: "always", label: "Always" }),
        ],
      }),
      h("output", null, value),
    );
  }
  render(h(Group));
  const ask = screen.getByRole("radio", { name: "Ask each time" });
  expect(ask.getAttribute("aria-checked")).toBe("true");
  expect(document.getElementById(ask.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Nothing loads until you choose.",
  );
  ask.focus();
  await user.keyboard("{ArrowDown}");
  expect(
    screen.getByRole("radio", { name: "From people I know" }).getAttribute("aria-checked"),
  ).toBe("true");
  await user.click(screen.getByText("Always"));
  expect(screen.getByRole("status").textContent).toBe("always");
  expect(await serious()).toEqual([]);
});

it("NumberField: the label focuses it, arrows and the stepper step within bounds, typing reports numbers", async () => {
  const user = userEvent.setup();
  const values: (number | null)[] = [];
  function Field() {
    const [value, setValue] = useState<number | null>(2);
    return h(
      "div",
      null,
      h("label", { htmlFor: "interval" }, "Interval"),
      h(NumberField, {
        id: "interval",
        min: 1,
        max: 3,
        value,
        onValueChange: (next) => {
          values.push(next);
          setValue(next);
        },
      }),
    );
  }
  render(h(Field));
  const input = screen.getByLabelText("Interval");
  if (!(input instanceof HTMLInputElement)) throw new Error("Interval is not an input");
  expect(input.value).toBe("2");
  await user.click(screen.getByText("Interval"));
  expect(document.activeElement).toBe(input);
  await user.keyboard("{ArrowUp}{ArrowUp}");
  expect(input.value).toBe("3");
  fireEvent.change(input, { target: { value: "" } });
  expect(values.at(-1)).toBeNull();
  fireEvent.change(input, { target: { value: "12" } });
  expect(values.at(-1)).toBe(12);
  // The stepper is for the pointer; the field keeps the keyboard.
  const stepper = document.querySelectorAll("button");
  expect(stepper).toHaveLength(2);
  for (const button of stepper) expect(button.tabIndex).toBe(-1);
  expect(await serious()).toEqual([]);
});

it("ToggleButtons: any number can be on, each reports aria-pressed, order follows the options", async () => {
  const user = userEvent.setup();
  function Days() {
    const [value, setValue] = useState<("MO" | "TU" | "WE")[]>(["WE"]);
    return h(
      "div",
      null,
      h(ToggleButtons<"MO" | "TU" | "WE">, {
        "aria-label": "Repeat on",
        options: [
          { value: "MO", label: "Mon" },
          { value: "TU", label: "Tue" },
          { value: "WE", label: "Wed" },
        ],
        value,
        onValueChange: setValue,
      }),
      h("output", null, value.join(",")),
    );
  }
  render(h(Days));
  expect(screen.getByRole("button", { name: "Wed" }).getAttribute("aria-pressed")).toBe("true");
  await user.click(screen.getByRole("button", { name: "Mon" }));
  expect(screen.getByRole("status").textContent).toBe("MO,WE");
  screen.getByRole("button", { name: "Mon" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Tue" }));
  await user.keyboard(" ");
  expect(screen.getByRole("status").textContent).toBe("MO,TU,WE");
  expect(await serious()).toEqual([]);
});
