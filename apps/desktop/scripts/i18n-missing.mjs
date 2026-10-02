import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatter } from "@lingui/format-po";

const po = formatter();
const identifiers = (text) =>
  [
    ...new Set([
      ...Array.from(text.matchAll(/\{([A-Za-z_]\w*|\d+)(?=[},])/g), (match) => match[1]),
      ...Array.from(text.matchAll(/<\/?\d+>/g), (match) => match[0]),
    ]),
  ]
    .toSorted((a, b) => a.localeCompare(b))
    .join("|");

/** Report raw missing/fuzzy translations and lost ICU arguments without language fallback. */
export function catalogProblems(source, target) {
  return Object.entries(source).flatMap(([id, message]) => {
    if (message.obsolete) return [];
    const translated = target[id];
    if (
      !translated?.translation?.trim() ||
      translated.obsolete ||
      translated.extra?.flags?.includes("fuzzy")
    ) {
      return [{ message: message.message, reason: "missing msgstr" }];
    }
    if (identifiers(message.message) !== identifiers(translated.translation)) {
      return [{ message: message.message, reason: "ICU arguments or markup differ" }];
    }
    return [];
  });
}

export async function checkCatalogs(root, output = (line) => process.stdout.write(`${line}\n`)) {
  const readCatalog = async (locale) => {
    const file = new URL(`${locale}/messages.po`, root);
    return po.parse(await readFile(file, "utf8"), {
      locale,
      sourceLocale: "en",
      filename: fileURLToPath(file),
    });
  };
  const source = await readCatalog("en");
  let failures = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const catalog = await readCatalog(entry.name);
    const problems = catalogProblems(source, catalog);
    failures += problems.length;
    output(`${entry.name}: ${problems.length} missing or invalid translations`);
    for (const problem of problems)
      output(`  ${problem.reason}: ${JSON.stringify(problem.message)}`);
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2]
    ? pathToFileURL(`${process.argv[2].replace(/\/$/, "")}/`)
    : new URL("../src/renderer/src/locales/", import.meta.url);
  const failures = await checkCatalogs(root);
  if (failures) process.exitCode = 1;
}
