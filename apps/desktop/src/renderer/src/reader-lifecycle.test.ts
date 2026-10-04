import { expect, it } from "vitest";
import { act, createElement, useEffect, useState } from "react";
import { parseHTML } from "linkedom";
import { prepareQuoteHistory } from "@openmail/core/schema";
import { type Message } from "../../shared/api";
import { readerThreadKey, useReaderMessages } from "./reader-selection";
import { useBodyQuotes } from "./components/body-quotes";
import { testDom } from "./test-dom";
const message = (id: string, threadId = "shared"): Message => ({
  id,
  threadId,
  accountId: "gmail:one",
  subject: id,
  date: 1,
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  replyTo: [],
  labels: [],
  bodyText: "Body",
  bodyHtml: "",
  snippet: "",
  attachments: [],
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
});

it("a pending new representative keeps the mounted reader and its find/expansion state", () => {
  const dom = testDom();
  const older = message("old");
  const newer = message("new");
  let changeFind: ((query: string) => void) | undefined;
  let changeExpansion: ((open: boolean) => void) | undefined;
  let snapshot = { query: "", open: true };
  let loadedIds: string[] = [];
  function View() {
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(true);
    useEffect(() => {
      changeFind = setQuery;
      changeExpansion = setOpen;
      snapshot = { query, open };
    }, [query, open]);
    return null;
  }
  function Reader({ row, loaded }: { row: Message; loaded: Message[] | undefined }) {
    const key = readerThreadKey(row);
    const messages = useReaderMessages(key, loaded);
    useEffect(() => {
      loadedIds = messages?.map((message) => message.id) ?? [];
    }, [messages]);
    return messages ? createElement(View, { key }) : null;
  }
  try {
    dom.render(createElement(Reader, { row: older, loaded: [older] }));
    if (!changeFind || !changeExpansion) throw new Error("Missing reader setters");
    dom.render(createElement(Reader, { row: older, loaded: [older] }));
    // The DOM harness batches changes through React's real act lifecycle.
    act(() => {
      changeFind?.("needle");
      changeExpansion?.(false);
    });
    dom.render(createElement(Reader, { row: newer, loaded: undefined }));
    expect(loadedIds).toEqual(["old"]);
    expect(snapshot).toEqual({ query: "needle", open: false });
    dom.render(createElement(Reader, { row: newer, loaded: [older, newer] }));
    expect(loadedIds).toEqual(["old", "new"]);
    expect(snapshot).toEqual({ query: "needle", open: false });
    dom.render(createElement(Reader, { row: message("other", "other-thread"), loaded: undefined }));
    expect(loadedIds).toEqual([]);
    dom.render(
      createElement(Reader, {
        row: message("other", "other-thread"),
        loaded: [message("other", "other-thread")],
      }),
    );
    expect(snapshot).toEqual({ query: "", open: true });
  } finally {
    dom.dispose();
  }
});

it("find navigation and quote toggles never rerun quote detection for the same document/history", () => {
  const dom = testDom();
  const old = "An original message with enough content for detecting quoted history.";
  const document = parseHTML(`<html><body><blockquote>${old}</blockquote></body></html>`).document;
  const history = prepareQuoteHistory([old]);
  const quote = document.querySelector("blockquote");
  if (!quote) throw new Error("Missing quote");
  let reads = 0;
  Object.defineProperty(quote, "textContent", {
    get: () => {
      reads++;
      return old;
    },
  });
  let detected: HTMLElement[] | undefined;
  function Frame({ index, expanded }: { index: number; expanded: boolean }) {
    const quotes = useBodyQuotes(document, history);
    useEffect(() => {
      detected = quotes;
    }, [quotes]);
    return createElement("span", null, `${index}:${expanded}`);
  }
  try {
    dom.render(createElement(Frame, { index: 0, expanded: false }));
    expect(detected).toEqual([quote]);
    expect(reads).toBe(1);
    for (let index = 1; index <= 10; index++)
      dom.render(createElement(Frame, { index, expanded: index % 2 === 0 }));
    expect(reads).toBe(1);
  } finally {
    dom.dispose();
  }
});

it("a vanished message clears cached reader content even in the same conversation", () => {
  const dom = testDom();
  let ids: string[] = [];
  function Reader({ missing }: { missing: boolean }) {
    const messages = useReaderMessages(
      "same-thread",
      missing ? undefined : [message("old")],
      missing,
    );
    useEffect(() => {
      ids = messages?.map((m) => m.id) ?? [];
    }, [messages]);
    return null;
  }
  try {
    dom.render(createElement(Reader, { missing: false }));
    expect(ids).toEqual(["old"]);
    dom.render(createElement(Reader, { missing: true }));
    expect(ids).toEqual([]);
    dom.render(createElement(Reader, { missing: true }));
    expect(ids).toEqual([]);
  } finally {
    dom.dispose();
  }
});
