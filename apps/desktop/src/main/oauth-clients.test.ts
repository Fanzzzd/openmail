import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { describeBuiltInClients, readBuiltInClients } from "../../oauth-clients";

const out = fileURLToPath(new URL("../../out/", import.meta.url));
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

it("env vars win over the local file per provider; a Google id needs its secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "openmail-clients-"));
  try {
    const file = join(dir, "clients.json");
    writeFileSync(
      file,
      JSON.stringify({
        google: { clientId: "file-g", clientSecret: "file-s" },
        microsoft: { clientId: "file-ms" },
      }),
    );
    const mixed = readBuiltInClients({ OPENMAIL_MICROSOFT_CLIENT_ID: "env-ms" }, file);
    expect(mixed).toEqual({
      clients: {
        google: { clientId: "file-g", clientSecret: "file-s" },
        microsoft: { clientId: "env-ms" },
      },
      origin: { google: "file", microsoft: "env" },
    });
    expect(describeBuiltInClients(mixed)).toBe(
      "Built-in OAuth clients: Google from oauth-clients.local.json, Microsoft from env vars.",
    );
    expect(readBuiltInClients({ OPENMAIL_GOOGLE_CLIENT_ID: "env-g" }, file).clients.google).toEqual(
      { clientId: "file-g", clientSecret: "file-s" },
    );
    const none = readBuiltInClients({}, join(dir, "missing.json"));
    expect(none).toEqual({ clients: {}, origin: {} });
    expect(describeBuiltInClients(none)).toBe(
      "Built-in OAuth clients: Google from none, Microsoft from none.",
    );
    writeFileSync(file, "[]");
    expect(() => readBuiltInClients({}, file)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Reads the production build, as security.test.ts does. Run `pnpm build` first.
const { clients } = readBuiltInClients();
const values = [
  clients.google?.clientId,
  clients.google?.clientSecret,
  clients.microsoft?.clientId,
].filter((value): value is string => Boolean(value));

it.skipIf(values.length === 0)(
  "built-in client values are compiled into the main process only",
  () => {
    const main = filesUnder(join(out, "main")).map((file) => readFileSync(file, "utf8"));
    for (const value of values) expect(main.some((text) => text.includes(value))).toBe(true);
    for (const file of [
      ...filesUnder(join(out, "renderer")),
      ...filesUnder(join(out, "preload")),
    ]) {
      const text = readFileSync(file, "latin1");
      for (const value of values) expect(text.includes(value), file).toBe(false);
    }
  },
);
