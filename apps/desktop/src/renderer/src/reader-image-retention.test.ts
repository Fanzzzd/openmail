import { afterAll, expect, it, vi } from "vitest";
import { Duration } from "effect";
import { Atom } from "effect/reactivity";
const calls = vi.hoisted(() => {
  vi.resetModules();
  return { query: vi.fn() };
});
vi.mock("./state/apple-contacts", () => ({ appleContactsStatusAtom: Atom.make(0) }));
vi.mock("./rpc", () => ({
  MailClient: {
    query: (tag: string, payload: unknown, options?: unknown) => {
      calls.query(tag, payload, options);
      return Atom.make(0);
    },
  },
}));
import { inlineImagesAtom, mediaImageAtom, rawMessageAtom } from "./state/queries";
afterAll(() => {
  vi.doUnmock("./rpc");
  vi.doUnmock("./state/apple-contacts");
  vi.resetModules();
});
it("reader images survive short remounts while raw MIME is released", () => {
  inlineImagesAtom("message");
  expect(calls.query).toHaveBeenLastCalledWith(
    "InlineImages",
    { id: "message" },
    { timeToLive: Duration.minutes(2) },
  );
  const chunk = {
    messageId: "message",
    text: "",
    source: { kind: "body" as const, name: "Message text", start: 0, end: 0 },
    page: null,
    region: null,
    pipelineVersion: "test",
    visionRevision: null,
  };
  mediaImageAtom(chunk);
  expect(calls.query).toHaveBeenLastCalledWith(
    "MediaImage",
    { chunk },
    { timeToLive: Duration.minutes(2) },
  );
  rawMessageAtom("message");
  expect(calls.query).toHaveBeenLastCalledWith(
    "RawMessage",
    { id: "message" },
    { timeToLive: Duration.zero },
  );
});
