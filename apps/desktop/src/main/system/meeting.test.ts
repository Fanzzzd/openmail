import { expect, it, vi } from "vitest";
import { Effect } from "effect";
vi.mock("electron", () => ({
  app: { isPackaged: false },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
}));
import { shell } from "electron";
import { openMeeting } from "./meeting";

it("opens an allowed meeting in the system browser and rejects forged renderer URLs", async () => {
  vi.mocked(shell).openExternal.mockClear();
  const url = "https://meet.google.com/abc-defg-hij";
  await Effect.runPromise(openMeeting(url));
  expect(vi.mocked(shell).openExternal.mock.calls).toEqual([[url]]);
  for (const unsafe of [
    "https://evil.test/j/1",
    "https://user@zoom.us/j/123",
    "http://zoom.us/j/123",
    "https://zoom.us.evil.test/j/123",
  ]) {
    const result = await Effect.runPromise(openMeeting(unsafe).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
  }
  expect(vi.mocked(shell).openExternal.mock.calls).toHaveLength(1);
});
