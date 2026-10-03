import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { request } from "node:https";

const transport = vi.hoisted(() => ({
  status: 302,
  end: vi.fn(),
  addresses: [{ address: "127.0.0.1", family: 4 }],
}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(() => Promise.resolve(transport.addresses)) }));
vi.mock("node:https", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    request: vi.fn(
      (
        _url: unknown,
        _options: unknown,
        callback: (response: { statusCode: number; destroy: () => void }) => void,
      ) => {
        const req = Object.assign(new EventEmitter(), { end: transport.end, destroy: vi.fn() });
        queueMicrotask(() => {
          callback({ statusCode: transport.status, destroy: vi.fn() });
          req.emit("close");
        });
        return req;
      },
    ),
  };
});
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  transport.status = 302;
});
it("rejects private DNS answers and non-HTTPS without sending a request", async () => {
  const { postUnsubscribe } = await import("./unsubscribe.js");
  transport.addresses = [{ address: "127.0.0.1", family: 4 }];
  for (const url of [
    "https://example.com/remove",
    "http://example.com/remove",
    "https://u:p@example.com/remove",
    "https://example.com:8443/remove",
  ])
    expect(await Effect.runPromise(postUnsubscribe(url).pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
    });
  expect(request).not.toHaveBeenCalled();
});
it("pins the public address and sends only an RFC 8058 POST; redirects are not followed", async () => {
  const { postUnsubscribe } = await import("./unsubscribe.js");
  transport.addresses = [{ address: "93.184.216.34", family: 4 }];
  const result = await Effect.runPromise(
    postUnsubscribe("https://list.example/remove?id=123").pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  expect(request).toHaveBeenCalledOnce();
  const options: unknown = vi.mocked(request).mock.calls[0]?.[1];
  expect(options).toMatchObject({
    method: "POST",
    hostname: "93.184.216.34",
    servername: "list.example",
    headers: { Host: "list.example", "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (typeof options === "object" && options !== null && "headers" in options) {
    expect(options.headers).not.toHaveProperty("Cookie");
    expect(options.headers).not.toHaveProperty("Authorization");
  }
  expect(transport.end).toHaveBeenCalledWith("List-Unsubscribe=One-Click");
  transport.status = 204;
  expect(
    await Effect.runPromise(postUnsubscribe("https://list.example/remove").pipe(Effect.result)),
  ).toMatchObject({ _tag: "Success" });
});
