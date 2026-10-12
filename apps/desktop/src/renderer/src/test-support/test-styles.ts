import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Color from "colorjs.io";
import { AtRule, parse, type Node, type Root, type Rule } from "postcss";
import { desktopRoot } from "./paths";

/** Inspect the CSS shipped by the preceding build, including Tailwind utility tokens. */
export function builtStyles() {
  const assets = join(desktopRoot, "out/renderer/assets");
  const files = readdirSync(assets).filter((file) => file.endsWith(".css"));
  if (!files.length) throw new Error("Run pnpm build before testing the shipped CSS");
  return parse(files.map((file) => readFileSync(join(assets, file), "utf8")).join("\n"));
}

type Theme = "light" | "dark";
type Paint = "color" | "background-color";

const escapeClass = (name: string) => `.${name.replace(/[^\w-]/g, (c) => `\\${c}`)}`;
const inDarkMedia = (node: Node) => {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent instanceof AtRule && parent.name === "media" && parent.params.includes("dark"))
      return true;
  return false;
};
const inSupports = (node: Node) => {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent instanceof AtRule && parent.name === "supports") return true;
  return false;
};

/**
 * Reads the colors that utility classes paint in the shipped CSS. Only plain and `dark:` classes
 * count, the way an element looks at rest, and the `@supports` color-mix forms are skipped for
 * their hex fallbacks.
 */
export function builtPalette(css: Root = builtStyles()) {
  const rules = new Map<string, Rule>();
  const all: Rule[] = [];
  const base = new Map<string, string>();
  const dark = new Map<string, string>();
  css.walkRules((rule) => {
    all.push(rule);
    if (!inSupports(rule) && !rules.has(rule.selector)) rules.set(rule.selector, rule);
    if (rule.selector !== ":root" && !rule.selector.includes(":host")) return;
    const target = inDarkMedia(rule) ? dark : base;
    rule.walkDecls(/^--/, (decl) => {
      target.set(decl.prop, decl.value);
    });
  });
  const resolve = (value: string, theme: Theme): Color => {
    const variable = value.match(/^var\((--[\w-]+)\)$/)?.[1];
    if (!variable) return new Color(value);
    const next = (theme === "dark" ? dark.get(variable) : undefined) ?? base.get(variable);
    if (!next) throw new Error(`Missing built variable ${variable}`);
    return resolve(next, theme);
  };
  /** The color an element's own classes paint for `paint`, if any. */
  const own = (element: Element, paint: Paint, theme: Theme): Color | undefined => {
    const classes = [...element.classList];
    const candidates =
      theme === "dark"
        ? [...classes.filter((name) => name.startsWith("dark:")), ...classes]
        : classes.filter((name) => !name.includes(":"));
    for (const name of candidates) {
      const rule = rules.get(escapeClass(name));
      let value: string | undefined;
      rule?.walkDecls(paint, (decl) => {
        value = decl.value;
      });
      if (value) return resolve(value, theme);
    }
    return undefined;
  };
  /** Text color, inherited from the nearest element that sets one. */
  const text = (element: Element, theme: Theme) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = own(node, "color", theme);
      if (color) return color;
    }
    return resolve("var(--a11y-text)", theme);
  };
  /** The background under an element: its translucent layers composited down to an opaque one. */
  const background = (element: Element, theme: Theme) => {
    const layers: Color[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = own(node, "background-color", theme);
      if (!color) continue;
      layers.push(color);
      if (color.alpha.valueOf() >= 1) break;
    }
    return layers.reduceRight(
      (below, top) => {
        const alpha = top.alpha.valueOf();
        const [r1, g1, b1] = top.to("srgb").coords;
        const [r2, g2, b2] = below.to("srgb").coords;
        const mix = (a: number | null, b: number | null) =>
          (a ?? 0) * alpha + (b ?? 0) * (1 - alpha);
        return new Color("srgb", [mix(r1, r2), mix(g1, g2), mix(b1, b2)]);
      },
      resolve("var(--a11y-surface)", theme),
    );
  };
  return {
    /** WCAG 2.1 contrast of an element's text against what is painted under it. */
    contrast: (element: Element, theme: Theme) =>
      text(element, theme).contrast(background(element, theme), "WCAG21"),
    /** The built declarations of one utility class and its variants, as `prop: value` strings. */
    declarations: (name: string) => {
      const found: string[] = [];
      for (const rule of all)
        if (rule.selector.startsWith(escapeClass(name)))
          rule.walkDecls((decl) => {
            found.push(`${decl.prop}: ${decl.value}`);
          });
      return found;
    },
  };
}
