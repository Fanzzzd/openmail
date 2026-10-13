import { Effect, Exit } from "effect";
import { expect, it, vi } from "vitest";
import { PermanentError, ProviderError } from "../../domain/errors.js";
import { buildMime } from "./compose.js";
import { openImap, smtpTransport } from "./imap/session.js";
import { nodeMailCodec } from "./mail-codec.js";

// These packages load on first use. A failed load must fail like the operation itself.
const { unavailable } = vi.hoisted(() => ({
  unavailable: () => {
    throw new Error("module unavailable");
  },
}));
vi.mock("imapflow", unavailable);
vi.mock("nodemailer", unavailable);
vi.mock("nodemailer/lib/mail-composer", unavailable);
vi.mock("mailparser", unavailable);

const settings = {
  preset: "custom",
  username: "me@example.com",
  imapHost: "imap.example.com",
  imapPort: 993,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
};

const failure = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (!error) throw new Error("expected a typed failure, got a defect");
  return error.error;
};

it("maps a failed imapflow or nodemailer load to the provider error of a failed connection", async () => {
  const imap = await failure(Effect.scoped(openImap("imap:me@example.com", settings, "secret")));
  expect(imap).toBeInstanceOf(ProviderError);
  expect(imap.message).toContain("imap.example.com:");
  const smtp = await failure(
    Effect.scoped(smtpTransport("imap:me@example.com", settings, "secret")),
  );
  expect(smtp).toBeInstanceOf(ProviderError);
  expect(smtp.message).toContain("smtp.example.com:");
});

it("maps a failed MIME library load to the build and parse errors", async () => {
  const build = await failure(
    buildMime(
      { name: "", address: "me@example.com" },
      { to: [], cc: [], bcc: [], subject: "", text: "", attachments: [] },
    ),
  );
  expect(build).toBeInstanceOf(PermanentError);
  expect(build.message).toMatch(/^Could not build the message: /);
  await expect(nodeMailCodec.parse(new Uint8Array([1]), {})).rejects.toThrow(
    new PermanentError({ message: "Cannot parse MIME message" }),
  );
});
