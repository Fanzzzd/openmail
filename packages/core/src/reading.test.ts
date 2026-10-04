import { afterEach, assert, beforeEach, describe, it, vi } from "@effect/vitest";

import {
  imagesAllowed,
  imageSenderKey,
  markReadAfter,
  orderThread,
  shouldLoadRemote,
  splitRawMessage,
} from "./reading.js";

describe("markReadAfter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks right away at 0 and never when manual", () => {
    const marked: string[] = [];
    markReadAfter(0, () => marked.push("now"));
    markReadAfter("manual", () => marked.push("manual"));
    vi.advanceTimersByTime(60_000);
    assert.deepStrictEqual(marked, ["now"]);
  });

  it("waits the delay, and moving on before it cancels", () => {
    const marked: string[] = [];
    markReadAfter(3, () => marked.push("a"));
    const cancel = markReadAfter(3, () => marked.push("b"));
    vi.advanceTimersByTime(2_999);
    assert.deepStrictEqual(marked, []);
    cancel();
    vi.advanceTimersByTime(1);
    assert.deepStrictEqual(marked, ["a"]);
  });
});

describe("shouldLoadRemote", () => {
  const signed = { from: { address: "Friend@Example.org" }, security: { dmarc: "pass" as const } };
  const forged = { from: { address: "friend@example.org" }, security: { dmarc: "fail" as const } };
  const unchecked = { from: { address: "friend@example.org" } };
  const prefs = { remoteImages: "ask" as const, imageSenders: [], knownSender: false };

  it("asks by default, even for known senders", () => {
    assert.isFalse(shouldLoadRemote(signed, { ...prefs, knownSender: true }));
  });

  it("loads for authenticated known senders only", () => {
    const known = { ...prefs, remoteImages: "known" as const, knownSender: true };
    assert.isTrue(shouldLoadRemote(signed, known));
    assert.isFalse(shouldLoadRemote(forged, known));
    assert.isFalse(shouldLoadRemote(unchecked, known));
    assert.isFalse(shouldLoadRemote(signed, { ...known, knownSender: false }));
  });

  it("loads for an authenticated allowlist entry in any mode", () => {
    const listed = { ...prefs, imageSenders: ["example.org"] };
    assert.isTrue(shouldLoadRemote(signed, listed));
    assert.isFalse(shouldLoadRemote(forged, listed));
  });

  it("always loads when set to always", () => {
    assert.isTrue(shouldLoadRemote(forged, { ...prefs, remoteImages: "always" }));
  });
});

describe("imagesAllowed", () => {
  const list = ["news@shop.com", "example.org", "@Brand.CO"];

  it("matches whole addresses exactly", () => {
    assert.isTrue(imagesAllowed("News@Shop.com", list));
    assert.isFalse(imagesAllowed("other@shop.com", list));
  });

  it("matches a domain and its subdomains, not look-alikes", () => {
    assert.isTrue(imagesAllowed("a@example.org", list));
    assert.isTrue(imagesAllowed("a@mail.example.org", list));
    assert.isTrue(imagesAllowed("a@brand.co", list));
    assert.isFalse(imagesAllowed("a@badexample.org", list));
    assert.isFalse(imagesAllowed("", list));
  });

  it("normalizes entries", () => {
    assert.strictEqual(imageSenderKey("  @Shop.COM "), "shop.com");
    assert.strictEqual(imageSenderKey("News@Shop.com"), "news@shop.com");
  });
});

describe("orderThread", () => {
  it("sorts oldest or newest first without changing the input", () => {
    const input = [{ date: 2 }, { date: 1 }, { date: 3 }];
    assert.deepStrictEqual(
      orderThread(input, "oldest").map((m) => m.date),
      [1, 2, 3],
    );
    assert.deepStrictEqual(
      orderThread(input, "newest").map((m) => m.date),
      [3, 2, 1],
    );
    assert.deepStrictEqual(
      input.map((m) => m.date),
      [2, 1, 3],
    );
  });
});

describe("splitRawMessage", () => {
  it("splits at the first empty line, CRLF or LF", () => {
    assert.deepStrictEqual(splitRawMessage("Subject: a\r\n b\r\nFrom: x\r\n\r\nbody\r\n\r\nmore"), {
      headers: "Subject: a\r\n b\r\nFrom: x",
      body: "body\r\n\r\nmore",
    });
    assert.deepStrictEqual(splitRawMessage("Subject: a\n\nbody"), {
      headers: "Subject: a",
      body: "body",
    });
    assert.deepStrictEqual(splitRawMessage("Subject: only"), {
      headers: "Subject: only",
      body: "",
    });
  });
});
