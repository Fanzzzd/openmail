import { readFileSync, readdirSync } from "node:fs";
import { parse } from "postcss";

/** Inspect the CSS shipped by the preceding build, including Tailwind utility tokens. */
export function builtStyles() {
  const assets = new URL("../../../out/renderer/assets/", import.meta.url);
  const files = readdirSync(assets).filter((file) => file.endsWith(".css"));
  if (!files.length) throw new Error("Run pnpm build before testing the shipped CSS");
  return parse(files.map((file) => readFileSync(new URL(file, assets), "utf8")).join("\n"));
}
