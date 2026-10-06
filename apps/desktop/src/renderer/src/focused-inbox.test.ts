import { expect, it } from "vitest";
import { focusedSender, focusedSenderMessage } from "./focused-inbox";
import type { Message } from "../../shared/api";
const message = (id: string, address: string, date: number): Message => ({
  id,
  accountId: "outlook:me@example.com",
  threadId: "conversation",
  subject: "Reply chain",
  from: { name: "", address },
  date,
  snippet: "",
  labels: ["INBOX"],
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
  to: [],
  cc: [],
  bodyText: "",
  bodyHtml: "",
  attachments: [],
});
it("override chooses the newest external sender and excludes account emails and aliases", () => {
  const earlier = message("earlier", "alice@example.com", 1);
  const recent = message("recent", "bob@example.com", 2);
  const own = message("own", "ME@example.com", 3);
  const alias = message("alias", "alias@example.com", 4);
  const messages = [alias, recent, earlier, own];
  const addresses = ["me@example.com", "alias@example.com"];
  expect(focusedSenderMessage(messages, addresses)).toBe(recent);
  expect(focusedSenderMessage(messages, addresses, "earlier")).toBe(earlier);
  expect(focusedSenderMessage(messages, addresses, "own")).toBe(recent);
  expect(focusedSenderMessage([own, alias], addresses)).toBeUndefined();
  expect(focusedSender(recent)).toEqual({
    focusedSender: { messageId: "recent", address: "bob@example.com" },
  });
  expect(focusedSender()).toEqual({});
});
