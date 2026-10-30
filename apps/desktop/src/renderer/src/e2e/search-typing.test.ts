import { afterEach, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import { Effect } from "effect";
import type { ThreadQuery } from "../../../shared/api";
import { SEARCH_TYPING_DELAY_MS } from "../state/threads";
import { eventually, flow, incoming, row, wait } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

/**
 * Typing ran a search for every key, and none stopped when the next key replaced it. The main
 * process ran each to the end, one after another: typing "meeting" on a 20k-message database
 * started 7 searches, blocked the main process for up to 10.7 s and showed the final rows 17 s
 * after the last key. Each Threads search here takes `slowMs`, so a replaced one is still running.
 */
async function typing(keys: readonly string[], gapMs: number, slowMs = 400) {
  const log = {
    started: [] as string[],
    finished: [] as string[],
    interrupted: [] as string[],
    serverStarted: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
  };
  let release = (): void => undefined;
  const mounted = {
    promise: new Promise<void>((done) => {
      release = done;
    }),
    resolve: () => release(),
  };
  const answer = (query: ThreadQuery) =>
    Effect.promise(() => mounted.promise).pipe(
      Effect.flatMap(() => {
        if (!current) throw new Error("flow not ready");
        return current.m.reading.threads(query);
      }),
    );
  current = await flow({
    messages: [
      incoming("memo", { subject: "Memo for Monday", date: Date.now() - 1000 }),
      incoming("meeting", { subject: "Meeting notes", date: Date.now() - 2000 }),
      incoming("lunch", { subject: "Lunch on Friday", date: Date.now() - 3000 }),
    ],
    handlers: {
      SearchServer: ({ query }) =>
        Effect.sync(() => {
          log.serverStarted.push(query.search ?? "");
          return { threads: [], truncated: false, errors: [] };
        }),
      Threads: ({ query }) => {
        const search = query.search;
        if (search === undefined || query.messageIds) return answer(query);
        return Effect.suspend(() => {
          log.started.push(search);
          log.inFlight++;
          log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
          return Effect.sleep(slowMs).pipe(
            Effect.andThen(answer(query)),
            Effect.tap(() => Effect.sync(() => log.finished.push(search))),
            Effect.onInterrupt(() => Effect.sync(() => log.interrupted.push(search))),
            Effect.ensuring(Effect.sync(() => log.inFlight--)),
          );
        });
      },
    },
  });
  mounted.resolve();
  const h = current;
  await eventually(() => expect(row(h.id("lunch"))).toBeTruthy());
  const field = screen.getByLabelText("Search mail");
  field.focus();
  for (const value of keys) {
    fireEvent.change(field, { target: { value } });
    await wait(gapMs);
  }
  await eventually(() => {
    expect(row(h.id("meeting"))).toBeTruthy();
    expect(() => row(h.id("memo"))).toThrow();
    expect(() => row(h.id("lunch"))).toThrow();
    expect(log.inFlight).toBe(0);
  });
  return log;
}

it("each key stops the search before it, so one search runs and only the last one lands", async () => {
  // Keys slower than the typing delay: each search starts, and the next key interrupts it.
  const log = await typing(["m", "me", "mee", "meet"], SEARCH_TYPING_DELAY_MS + 150);
  // A one-letter word waits for a second letter.
  expect(log.started).toEqual(["me*", "mee*", "meet*"]);
  expect(log.interrupted).toEqual(["me*", "mee*"]);
  expect(log.finished).toEqual(["meet*"]);
  expect(log.maxInFlight).toBe(1);
  // Nothing more starts once the list shows the last search.
  await wait(500);
  expect(log.started).toHaveLength(3);
});

it("keys within the typing delay send only the last search", async () => {
  const log = await typing(["m", "me", "mee", "meet"], 20);
  expect(log.started).toEqual(["meet*"]);
  expect(log.finished).toEqual(["meet*"]);
  expect(log.interrupted).toEqual([]);
  await wait(500);
  expect(log.serverStarted).toEqual(["meet"]);
});

it("a search typed again shows its kept rows at once and reads them again only after a change", async () => {
  const log = await typing(["me", "mee", "meet"], SEARCH_TYPING_DELAY_MS + 600, 0);
  expect(log.finished).toEqual(["me*", "mee*", "meet*"]);
  const h = current;
  if (!h) throw new Error("no flow");
  const field = screen.getByLabelText("Search mail");
  // Back to "me": its rows come from the kept list, with no request.
  fireEvent.change(field, { target: { value: "me" } });
  await eventually(() => expect(row(h.id("memo"))).toBeTruthy());
  await wait(SEARCH_TYPING_DELAY_MS + 300);
  expect(log.started).toEqual(["me*", "mee*", "meet*"]);
});

it("local rows remain when the server-only request fails for every provider", async () => {
  current = await flow({
    messages: [
      incoming("meeting", { subject: "Meeting notes" }),
      incoming("lunch", { subject: "Lunch on Friday" }),
    ],
    handlers: {
      SearchServer: () =>
        Effect.succeed({
          threads: [],
          truncated: false,
          errors: [{ accountId: "gmail:me@gmail.com", message: "offline" }],
        }),
    },
  });
  const h = current;
  await eventually(() => expect(row(h.id("lunch"))).toBeTruthy());
  const field = screen.getByLabelText("Search mail");
  field.focus();
  fireEvent.change(field, { target: { value: "meet" } });
  await eventually(() => {
    expect(row(h.id("meeting"))).toBeTruthy();
    expect(() => row(h.id("lunch"))).toThrow();
  });
  await eventually(() => expect(h.requests.some((r) => r.tag === "SearchServer")).toBe(true));
  await wait(500);
  expect(row(h.id("meeting"))).toBeTruthy();
  expect(() => row(h.id("lunch"))).toThrow();
  expect(
    h.requests.filter(
      (r) => r.tag === "Threads" && JSON.stringify(r.payload).includes('"search":"meet*"'),
    ),
  ).toHaveLength(1);
  // No provider hits: no follow-up search for their live rows.
  expect(
    h.requests.filter(
      (r) => r.tag === "Threads" && JSON.stringify(r.payload).includes("messageIds"),
    ),
  ).toEqual([]);
});

it("unfinished input never starts a mailbox count while waiting for a searchable word", async () => {
  current = await flow({ messages: [incoming("one"), incoming("two")] });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  await wait(200);
  const start = h.requests.length;
  const field = screen.getByLabelText("Search mail");
  field.focus();
  for (const value of ["i", "is:", "is:u"]) {
    fireEvent.change(field, { target: { value } });
    await wait(50);
  }
  await wait(500);
  expect(h.requests.slice(start).filter((request) => request.tag === "ThreadCount")).toEqual([]);
  expect(row(h.id("one"))).toBeTruthy();
});
