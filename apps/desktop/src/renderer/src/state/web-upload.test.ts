import { afterEach, expect, it, vi } from "vitest";
import { uploadAttachments } from "./web-upload";

const reply = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(body, { status }))),
  );
const upload = () => uploadAttachments([new File(["hi"], "a.txt")], "acct", []);

afterEach(() => {
  vi.unstubAllGlobals();
});

it("accepts the Mac's decoded files", async () => {
  const file = { filename: "a.txt", mimeType: "text/plain", content: "aGk=" };
  reply(200, { files: [file] });
  expect(await upload()).toEqual({ ok: true, files: [file] });
});

it("reports the Gmail block with its filename", async () => {
  reply(400, { error: "gmailBlocked", filename: "a.exe" });
  expect(await upload()).toEqual({ ok: false, error: "gmailBlocked", filename: "a.exe" });
});

it("treats a reply of the wrong shape as a failed upload", async () => {
  reply(200, { files: [{ filename: 1 }] });
  expect(await upload()).toEqual({ ok: false, error: "failed" });
  reply(413, "Payload too large");
  expect(await upload()).toEqual({ ok: false, error: "tooLarge" });
});
