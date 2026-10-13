import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { Account } from "../../domain/account.js";
import type { MailCodecPort, MimeMessage } from "../mail-codec.js";
import { fakeServer, makeFakeProvider } from "./fake-provider.js";

it("fake MIME fallback captures the injected codec without providing NodeRuntime at call time", async () => {
  const server = fakeServer("me@example.com");
  const raw = new Uint8Array([1]);
  server.raw.set("message", raw);
  const bytes = new Uint8Array([65, 66]);
  const parse = vi.fn((_raw: Uint8Array): Promise<MimeMessage> =>
    Promise.resolve({
      html: false,
      headers: new Map(),
      attachments: [
        {
          filename: "file.bin",
          contentType: "application/octet-stream",
          content: bytes,
          size: bytes.length,
          related: false,
          headers: new Map(),
        },
      ],
    }),
  );
  const codec: MailCodecPort = {
    parse,
    build: () => Effect.die(new Error("No MIME build in this fixture")),
  };
  const provider = makeFakeProvider(server, { codec });
  const account: Account = {
    id: "gmail:me@example.com",
    provider: "gmail",
    email: "me@example.com",
    createdAt: 0,
    needsReauth: false,
    lastSyncedAt: null,
    lastSyncError: null,
    profileId: null,
  };
  const found = await Effect.runPromise(
    provider.fetchAttachment(account, "message", { index: 0, filename: "file.bin", occurrence: 0 }),
  );
  expect(found).toEqual(bytes);
  expect(parse).toHaveBeenCalledWith(raw, { skipImageLinks: true });
});
