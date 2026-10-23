// An oxlint JS plugin: renderer features use the shared form controls in
// apps/desktop/src/renderer/src/ui/ instead of native or hand-built ones, so every checkbox,
// switch, pop-up button and number field looks and behaves the same. See docs/testing.md.

/** Native input types that have a wrapper in ui/, and the wrapper to use instead. */
const INPUT_TYPES = new Map([
  ["checkbox", "Checkbox from ui/Checkbox, or SettingsSwitchRow or Switch for an on/off setting"],
  ["radio", "RadioGroup with Radio, RadioCard or RadioTile from ui/Radio"],
  ["number", "NumberField from ui/NumberField"],
  ["range", "a slider wrapper in ui/ (add ui/Slider.tsx on Base UI Slider first)"],
  ["color", "ColorWell from ui/ColorWell"],
  ["date", "DateInput from ui/DateInput"],
  ["time", "DateInput from ui/DateInput"],
  ["datetime-local", "DateInput from ui/DateInput"],
  ["month", "DateInput from ui/DateInput"],
  ["week", "DateInput from ui/DateInput"],
]);

/** Base UI control primitives that only ui/ may import, and the wrapper to use instead. */
const PRIMITIVES = new Map([
  ["checkbox", "Checkbox from ui/Checkbox"],
  ["checkbox-group", "Checkbox from ui/Checkbox"],
  ["switch", "Switch or SettingsSwitchRow from ui/Switch and ui/SettingsRows"],
  ["select", "Select from ui/Select"],
  ["radio", "RadioGroup with Radio, RadioCard or RadioTile from ui/Radio"],
  ["radio-group", "RadioGroup from ui/Radio"],
  ["slider", "a slider wrapper in ui/ (add ui/Slider.tsx first)"],
  ["number-field", "NumberField from ui/NumberField"],
]);

const RENDERER = "apps/desktop/src/renderer/src/";
const EXEMPT = /\bui-ok\b(?::\s*(.*))?/;

/** True for renderer source outside ui/ and outside tests. */
export function inScope(filename) {
  const path = filename.replaceAll("\\", "/");
  const at = path.indexOf(RENDERER);
  if (at < 0) return false;
  const rest = path.slice(at + RENDERER.length);
  return !rest.startsWith("ui/") && !/\.test\.[cm]?[jt]sx?$/.test(rest);
}

const rule = {
  meta: {
    type: "problem",
    docs: { description: "Use the shared form controls in renderer ui/." },
    messages: {
      control: "Use {{wrapper}} instead of {{what}}. Exempt a line with `// ui-ok: <reason>`.",
      reason: "`ui-ok` needs a reason: `// ui-ok: <why this control cannot use the wrapper>`.",
    },
    schema: [],
  },
  create(context) {
    if (!inScope(context.filename)) return {};
    const comments = context.sourceCode.getAllComments();
    const report = (node, wrapper, what) => {
      const line = node.loc.start.line;
      const exemption = comments
        .filter((comment) => comment.loc.start.line === line || comment.loc.end.line === line)
        .map((comment) => EXEMPT.exec(comment.value))
        .find(Boolean);
      if (exemption) {
        if (!exemption[1]?.trim()) context.report({ node, messageId: "reason" });
        return;
      }
      context.report({ node, messageId: "control", data: { wrapper, what } });
    };
    return {
      ImportDeclaration(node) {
        const match = /^@base-ui(?:-components)?\/react\/([\w-]+)$/.exec(node.source.value);
        const wrapper = match && PRIMITIVES.get(match[1]);
        if (wrapper) report(node, wrapper, `a direct import of ${node.source.value}`);
      },
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        if (node.name.name === "select") {
          report(node, "Select from ui/Select", "a native <select>");
          return;
        }
        if (node.name.name !== "input") return;
        const type = node.attributes.find(
          (attribute) => attribute.type === "JSXAttribute" && attribute.name.name === "type",
        );
        const value = type?.value?.type === "Literal" ? type.value.value : undefined;
        const wrapper = typeof value === "string" && INPUT_TYPES.get(value);
        if (wrapper) report(node, wrapper, `<input type="${value}">`);
      },
    };
  },
};

export default {
  meta: { name: "openmail-ui" },
  rules: { "raw-controls": rule },
};
