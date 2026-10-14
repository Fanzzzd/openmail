/** Shared fixtures for the Outlook adapter tests in src/providers/outlook/outlook-*.test.ts. */
import {
  fakeHttp,
  graphFolderRoutes,
  type FakeHttpCall as Call,
  type FakeHttpReply as Reply,
} from "../src/platform/node/fake-http.js";
import { account as buildAccount } from "../src/platform/node/testing.js";
import { Effect, Layer } from "effect";
import type { Account } from "../src/domain/account.js";
import { makeOutlook } from "../src/providers/outlook/outlook.js";
import {
  MemoryPlatform,
  type MemoryPlatformOptions,
} from "../src/platform/node/platform-memory.js";
import { type Change, type ProviderAdapter } from "../src/providers/adapter.js";
import { Secrets } from "../src/platform/auth.js";

export const GRAPH = "https://graph.microsoft.com/v1.0";

/**
 * An HttpClient that answers from `routes`, keyed by "METHOD /path" under
 * GRAPH. Function routes see the full URL (delta pages share a path).
 * Unknown routes answer 404, like a folder the mailbox does not have.
 */

export const account: Account = buildAccount("outlook");

export const platformOptions: MemoryPlatformOptions = {
  secrets: { [account.id]: "refresh-token" },
  config: { microsoft: { clientId: "client" } },
};

export function run<A, E>(
  http: Pick<ReturnType<typeof fakeHttp>, "layer" | "calls">,
  f: (adapter: ProviderAdapter) => Effect.Effect<A, E, Secrets>,
  options: MemoryPlatformOptions = platformOptions,
) {
  return makeOutlook.pipe(
    Effect.flatMap(f),
    Effect.provide(Layer.mergeAll(http.layer, MemoryPlatform(options))),
  );
}

export const raw = {
  id: "AAMk123",
  conversationId: "conv-1",
  webLink: "https://outlook.live.com/mail/0/id/AAMk123",
  subject: "报价确认",
  bodyPreview: "已确认报价",
  body: { contentType: "html", content: "<p>已确认<b>报价</b></p>" },
  from: { emailAddress: { name: "王工", address: "wang@contoso.com" } },
  toRecipients: [{ emailAddress: { name: "Me", address: "me@outlook.com" } }],
  ccRecipients: [],
  receivedDateTime: "2026-09-20T02:30:00Z",
  isRead: false,
  isDraft: false,
  hasAttachments: true,
  flag: { flagStatus: "flagged" },
};

export const WELL_KNOWN = ["inbox", "sentitems", "drafts", "junkemail", "deleteditems"];

/** A mailbox with the well-known folders (no Archive), one custom folder with a child, and Sync Issues. */
export function mailbox(deltas: Record<string, Reply | ((url: URL) => Reply)>) {
  const routes: Record<string, Reply | ((url: URL) => Reply)> = {
    "GET /me/mailFolders": {
      json: {
        value: [
          { id: "id-inbox", displayName: "Inbox", childFolderCount: 0, totalItemCount: 9 },
          { id: "id-c1", displayName: "Clients", childFolderCount: 1, totalItemCount: 3 },
          { id: "id-empty", displayName: "Empty", childFolderCount: 0, totalItemCount: 0 },
          {
            id: "id-syncissues",
            displayName: "Sync Issues",
            childFolderCount: 1,
            totalItemCount: 2,
          },
        ],
      },
    },
    "GET /me/mailFolders/id-c1/childFolders": {
      json: {
        value: [{ id: "id-c2", displayName: "Acme", childFolderCount: 0, totalItemCount: 1 }],
      },
    },
    "GET /me/mailFolders/syncissues": { json: { id: "id-syncissues" } },
    ...graphFolderRoutes(deltas, ["id-c1", "id-c2"]),
  };
  return routes;
}

export const tags = (changes: readonly Change[]) => changes.map((c) => c._tag);

export const draftMessage = {
  to: [{ name: "王工", address: "wang@contoso.com" }],
  cc: [],
  bcc: [],
  subject: "报价",
  text: "草稿",
  attachments: [{ filename: "a.txt", mimeType: "text/plain", content: "aGk=" }],
};

export const paths = (calls: readonly Call[]) =>
  calls.map((c) => `${c.method} ${c.url.pathname.replace("/v1.0", "")}`);

export const chineseOriginal = Buffer.from(
  "From: li@x.com\r\nSubject: =?UTF-8?B?5Y6f6YKu5Lu2?=\r\nContent-Type: text/plain; charset=utf-8\r\n" +
    "Content-Transfer-Encoding: 8bit\r\n\r\n你好，这是原来的邮件。\r\n",
);
