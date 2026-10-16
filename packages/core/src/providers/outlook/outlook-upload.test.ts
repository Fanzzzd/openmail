import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import { Clock, Effect, Fiber, Layer, Option, Predicate, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  attachmentSizesProblem,
  OUTLOOK_ATTACHMENT_THRESHOLD,
  OUTLOOK_MESSAGE_LIMIT,
} from "../../mime/attachment-policy.js";
import type {
  OutgoingAttachment,
  OutgoingMessage,
  SendPreparationState,
} from "../../domain/changes.js";
import { makeOutlook } from "./outlook.js";
import { makeOutlookClient } from "./client.js";
import {
  attachmentRange,
  makeAttachmentUpload,
  OUTLOOK_UPLOAD_LIMIT,
  UPLOAD_BLOCK_SIZE,
  UPLOAD_CHUNK_SIZE,
} from "./upload.js";
import { Buffer, type ByteCodec, type ByteEncoding } from "../../platform/bytes.js";
import { draftCreation } from "../../platform/node/draft-create-fixture.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { account as buildAccount, incoming } from "../../platform/node/testing.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { MailboxLive } from "../../mailbox/mailbox-live.js";
import { StoreLive } from "../../store/store.js";
import {
  Providers,
  type DraftPush,
  type ProviderAdapter,
  type SendPreparation,
} from "../adapter.js";
import { Secrets } from "../../platform/auth.js";
import { Store } from "../../store/service.js";
import { scaledMs } from "../../../test-support/test-time.js";

const account = buildAccount("outlook");
const options = {
  secrets: { [account.id]: "refresh-token" },
  config: { microsoft: { clientId: "client" } },
};
const small: OutgoingAttachment = {
  filename: "small.txt",
  mimeType: "text/plain",
  content: "aGk=",
};
const file = (
  size = OUTLOOK_ATTACHMENT_THRESHOLD + 17,
  filename = "large.bin",
): OutgoingAttachment => ({
  filename,
  mimeType: "application/octet-stream",
  content:
    "A".repeat(Math.ceil(size / 3) * 4 - (size % 3 ? 3 - (size % 3) : 0)) +
    "=".repeat(size % 3 ? 3 - (size % 3) : 0),
});
const message = (attachments: readonly OutgoingAttachment[]): OutgoingMessage => ({
  to: [{ name: "", address: "recipient@example.test" }],
  cc: [],
  bcc: [],
  subject: "Upload",
  text: "Message text",
  attachments,
});
const Fields = Schema.Struct({
  internetMessageId: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        contentType: Schema.String,
        contentBytes: Schema.String,
      }),
    ),
  ),
});
const AttachmentItem = Schema.Struct({
  AttachmentItem: Schema.Struct({
    name: Schema.String,
    size: Schema.Number,
    attachmentType: Schema.Literal("file"),
  }),
});
type Session = { id: string; name: string; size: number; offset: number; expired: boolean };

/** Fake Graph and preauthenticated Outlook endpoints. Calls retain metadata, never payload bytes. */
type GraphFlags = {
  failure?: "none" | "before" | "after" | "last" | "expire" | "reject";
  failAfterAttachments?: number;
  loseCreate?: boolean;
  loseSend?: boolean;
  /** The server accepts the send and never answers. */
  stallSend?: boolean;
  sendNotReceived?: boolean;
  hidden?: boolean;
  raw?: string;
  uppercase?: boolean;
  expiredError?: boolean;
  createNotReceived?: boolean;
  webSent?: boolean;
  sentLag?: number;
  sentLookupFailure?: boolean;
  oldDraft?: { id: string; messageId: string };
  chunkDelay?: number;
  expires?: string;
  version?: number;
};
function graph(files: readonly OutgoingAttachment[], input: GraphFlags = {}) {
  const flags = { ...input, version: input.version ?? 1, failure: input.failure ?? "none" };
  const calls: {
    method: string;
    path: string;
    select: string | null;
    filter: string | null;
  }[] = [];
  const ranges: { start: number; end: number; size: number }[] = [];
  const attachments: { id: string; file: OutgoingAttachment }[] = [];
  const sessions = new Map<string, Session>();
  let identity = "";
  let created = 0;
  let sent = 0;
  let sessionCount = 0;
  let sentLookups = 0;

  const progress = (offset: number) =>
    flags.uppercase
      ? { NextExpectedRanges: [String(offset)] }
      : { nextExpectedRanges: [String(offset)] };
  const metadata = () => ({
    id: "draft",
    changeKey: `v${flags.version}`,
    lastModifiedDateTime: new Date(flags.version * 1000).toISOString(),
    internetMessageId: identity,
    isDraft: sent === 0,
  });
  const client = HttpClient.make((request, url) =>
    Effect.sleep(
      url.hostname === "outlook.office.com" && request.method === "PUT"
        ? (flags.chunkDelay ?? 0)
        : 0,
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const path = url.pathname.replace(/^\/v1\.0/, "");
          calls.push({
            method: request.method,
            path,
            select: url.searchParams.get("$select"),
            filter: url.searchParams.get("$filter"),
          });
          const respond = (json?: unknown, status = 200) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(json === undefined ? null : JSON.stringify(json), { status }),
            );
          const body: unknown =
            request.body._tag === "Uint8Array" &&
            request.body.contentType.startsWith("application/json")
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : undefined;
          if (url.hostname === "outlook.office.com") {
            assert.strictEqual(request.headers.authorization, undefined);
            const session = sessions.get(path);
            if (request.method === "DELETE") {
              if (session) session.expired = true;
              return respond(undefined, session ? 204 : 404);
            }
            if (!session || session.expired) return respond(undefined, 404);
            if (request.method === "GET") return respond(progress(session.offset));
            assert.strictEqual(request.method, "PUT");
            assert.strictEqual(request.body._tag, "Uint8Array");
            if (request.body._tag !== "Uint8Array") throw new Error("Missing chunk");
            assert.strictEqual(request.body.contentType, "application/octet-stream");
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers["content-range"] ?? "");
            if (!range) throw new Error("Missing range");
            const start = Number(range[1]),
              end = Number(range[2]),
              size = Number(range[3]);
            ranges.push({ start, end, size });
            assert.strictEqual(start, session.offset);
            assert.strictEqual(size, session.size);
            assert.strictEqual(end - start + 1, request.body.body.length);
            assert.strictEqual(request.headers["content-length"], String(request.body.body.length));
            assert.isAtMost(request.body.body.length, UPLOAD_CHUNK_SIZE);
            if (end + 1 !== size)
              assert.strictEqual(request.body.body.length % UPLOAD_BLOCK_SIZE, 0);
            assert.isTrue(request.body.body.every((byte) => byte === 0));
            if (flags.expiredError) {
              flags.expiredError = false;
              session.expired = true;
              return respond({ error: { code: "ErrorAttachmentSessionExpired" } }, 400);
            }
            const fail =
              attachments.length >= (flags.failAfterAttachments ?? 0) ? flags.failure : "none";
            if (fail === "reject") return respond(undefined, 400);
            if (fail === "before" || fail === "expire") {
              flags.failure = "none";
              if (fail === "expire") session.expired = true;
              return respond(undefined, fail === "expire" ? 404 : 503);
            }
            session.offset = end + 1;
            if (session.offset === size) {
              const source = files.find((part) => part.filename === session.name);
              if (!source) throw new Error("Unknown file");
              attachments.push({ id: `a${attachments.length}`, file: source });
              flags.version++;
              session.expired = true;
              if (fail === "last") {
                flags.failure = "none";
                return respond(undefined, 503);
              }
              return respond(undefined, 201);
            }
            if (fail === "after") {
              flags.failure = "none";
              return respond(undefined, 503);
            }
            return respond(progress(session.offset));
          }
          if (request.method === "POST" && path === "/me/messages") {
            if (flags.createNotReceived) {
              flags.createNotReceived = false;
              return respond(undefined, 503);
            }
            created++;
            attachments.length = 0;
            const fields = Schema.decodeUnknownSync(Fields)(body);
            identity = fields.internetMessageId ?? "";
            for (const part of fields.attachments ?? [])
              attachments.push({
                id: `a${attachments.length}`,
                file: {
                  filename: part.name,
                  mimeType: part.contentType,
                  content: part.contentBytes,
                },
              });
            return flags.loseCreate ? respond(undefined, 503) : respond(metadata(), 201);
          }
          if (request.method === "POST" && path.endsWith("/createUploadSession")) {
            const { AttachmentItem: item } = Schema.decodeUnknownSync(AttachmentItem)(body);
            const sessionPath = `/upload/${++sessionCount}`;
            sessions.set(sessionPath, {
              id: "draft",
              name: item.name,
              size: item.size,
              offset: 0,
              expired: false,
            });
            return respond(
              {
                uploadUrl: `https://outlook.office.com${sessionPath}?authtoken=private`,
                expirationDateTime: flags.expires ?? "2099-01-01T00:00:00Z",
                nextExpectedRanges: ["0-"],
              },
              201,
            );
          }
          if (request.method === "POST" && path === "/me/messages/draft/attachments") {
            const part = Schema.decodeUnknownSync(
              Schema.Struct({
                name: Schema.String,
                contentType: Schema.String,
                contentBytes: Schema.String,
              }),
            )(body);
            attachments.push({
              id: `a${attachments.length}`,
              file: { filename: part.name, mimeType: part.contentType, content: part.contentBytes },
            });
            flags.version++;
            return respond({}, 201);
          }
          if (request.method === "GET" && path === "/me/messages/draft/attachments") {
            assert.isTrue(url.searchParams.has("$select"));
            return respond({
              value: attachments.map((part) => ({
                id: part.id,
                name: part.file.filename,
                contentType: part.file.mimeType,
                isInline: !!part.file.contentId,
                size: Math.ceil(Buffer.byteLength(part.file.content, "base64") * 1.05),
                contentId: part.file.contentId,
              })),
            });
          }
          if (request.method === "GET" && /\/attachments\/[^/]+\/\$value$/.test(path)) {
            const part = attachments.find((candidate) =>
              path.endsWith(`/attachments/${candidate.id}/$value`),
            );
            if (!part) return respond(undefined, 404);
            const bytes = Buffer.from(part.file.content, "base64");
            let offset = 0;
            const stream = new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset >= bytes.length) {
                  controller.close();
                  return;
                }
                controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
                offset += 64 * 1024;
              },
            });
            return HttpClientResponse.fromWeb(request, new Response(stream));
          }
          if (request.method === "DELETE" && /\/attachments\/[^/]+$/.test(path)) {
            const index = attachments.findIndex((candidate) =>
              path.endsWith(`/attachments/${candidate.id}`),
            );
            if (index >= 0) attachments.splice(index, 1);
            return respond(undefined, 204);
          }
          if (request.method === "GET" && path === "/me/mailFolders/drafts/messages") {
            if (
              flags.oldDraft &&
              (url.searchParams.get("$filter") ?? "").includes(
                `internetMessageId eq '${flags.oldDraft.messageId}'`,
              )
            )
              return respond({ value: [{ id: flags.oldDraft.id }] });
            if (identity)
              assert.include(
                url.searchParams.get("$filter") ?? "",
                `internetMessageId eq '${identity}'`,
              );
            return respond({ value: created && !sent && !flags.hidden ? [{ id: "draft" }] : [] });
          }
          if (request.method === "GET" && path === "/me/mailFolders/sentitems/messages") {
            sentLookups++;
            if (flags.sentLookupFailure) return respond(undefined, 403);
            return respond({
              value:
                (sent || flags.webSent) && sentLookups > (flags.sentLag ?? 0)
                  ? [{ id: "sent" }]
                  : [],
            });
          }
          if (
            request.method === "DELETE" &&
            flags.oldDraft &&
            path === `/me/messages/${flags.oldDraft.id}`
          ) {
            flags.oldDraft = undefined;
            return respond(undefined, 204);
          }
          if (request.method === "PATCH" && path === "/me/messages/draft") {
            flags.version++;
            return respond(metadata());
          }
          if (request.method === "GET" && path === "/me/messages/draft") return respond(metadata());
          if (request.method === "GET" && path === "/me/messages/draft/$value")
            return HttpClientResponse.fromWeb(request, new Response(flags.raw ?? ""));
          if (request.method === "POST" && path === "/me/messages/draft/send") {
            if (flags.sendNotReceived) return respond(undefined, 503);
            sent++;
            if (flags.stallSend) return null;
            return respond(undefined, flags.loseSend ? 503 : 202);
          }
          if (request.method === "DELETE" && path === "/me/messages/draft") {
            created = 0;
            attachments.length = 0;
            return respond(undefined, 204);
          }
          return respond(undefined, 404);
        }),
      ),
      Effect.flatMap((response) => (response ? Effect.succeed(response) : Effect.never)),
    ),
  );
  return {
    layer: Layer.succeed(HttpClient.HttpClient, client),
    calls,
    ranges,
    attachments,
    get created() {
      return created;
    },
    get sent() {
      return sent;
    },
    get sessionCount() {
      return sessionCount;
    },
    get sentLookups() {
      return sentLookups;
    },
    get identity() {
      return identity;
    },
    flags,
  };
}
function setup(size?: number, flags: GraphFlags = {}) {
  const large = file(size);
  return { large, server: graph([large], flags), outgoing: message([large]) };
}
const run = <A, E>(
  server: ReturnType<typeof graph>,
  work: (adapter: ProviderAdapter) => Effect.Effect<A, E>,
) =>
  makeOutlook.pipe(
    Effect.flatMap(work),
    Effect.provide(Layer.mergeAll(server.layer, MemoryPlatform(options))),
  );
const runRecovery = <A, E>(
  server: ReturnType<typeof graph>,
  work: (adapter: ProviderAdapter) => Effect.Effect<A, E>,
) =>
  run(server, (adapter) =>
    Effect.gen(function* () {
      const sending = yield* work(adapter).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      return yield* Fiber.join(sending);
    }),
  );

function journal(initial?: SendPreparationState) {
  let state = initial ? Option.some(initial) : Option.none<SendPreparationState>();
  const preparation: SendPreparation = {
    load: Effect.sync(() => state),
    save: (next) =>
      Effect.sync(() => {
        state = next ? Option.some(next) : Option.none();
      }),
  };
  return preparation;
}

it.effect("10 MB upload uses 320 KiB multiples, a short last chunk and no bearer token", () =>
  Effect.gen(function* () {
    const { large, server } = setup(10 * 1024 * 1024);
    yield* run(server, (adapter) => adapter.send(account, message([large]), Option.none()));
    assert.deepStrictEqual(server.ranges, [
      { start: 0, end: UPLOAD_CHUNK_SIZE - 1, size: 10 * 1024 * 1024 },
      { start: UPLOAD_CHUNK_SIZE, end: 2 * UPLOAD_CHUNK_SIZE - 1, size: 10 * 1024 * 1024 },
      { start: 2 * UPLOAD_CHUNK_SIZE, end: 3 * UPLOAD_CHUNK_SIZE - 1, size: 10 * 1024 * 1024 },
      { start: 3 * UPLOAD_CHUNK_SIZE, end: 10 * 1024 * 1024 - 1, size: 10 * 1024 * 1024 },
    ]);
    assert.strictEqual(server.sent, 1);
    assert.isFalse(server.calls.some((call) => call.path.endsWith("sendMail")));
  }),
);

for (const failure of ["before", "after", "last", "expire"] as const)
  it.effect(
    `chunk ${failure} failure resumes from server state without duplicate attachments`,
    () =>
      Effect.gen(function* () {
        const { large, server } = setup();
        server.flags.failure = failure;
        yield* run(server, (adapter) => adapter.send(account, message([large]), Option.none()));
        assert.strictEqual(server.sent, 1);
        assert.strictEqual(server.attachments.length, 1);
        assert.strictEqual(server.sessionCount, failure === "expire" ? 2 : 1);
        assert.strictEqual(
          server.ranges[1]?.start,
          failure === "after" || failure === "last" ? UPLOAD_CHUNK_SIZE : 0,
        );
        if (failure !== "expire")
          assert.isTrue(
            server.calls.some((call) => call.method === "GET" && call.path.startsWith("/upload/")),
          );
      }),
  );

it.effect("mixed attachments upload small files inline and large files by session", () =>
  Effect.gen(function* () {
    const { large, server } = setup();
    yield* run(server, (adapter) => adapter.send(account, message([small, large]), Option.none()));
    assert.deepStrictEqual(
      server.attachments.map((part) => part.file.filename),
      [small.filename, large.filename],
    );
    assert.strictEqual(server.sessionCount, 1);
  }),
);

it.effect("Outlook progress and resume accept PascalCase byte-range fields", () =>
  Effect.gen(function* () {
    const { large, server } = setup();
    server.flags.uppercase = true;
    server.flags.failure = "after";
    yield* run(server, (adapter) => adapter.send(account, message([large]), Option.none()));
    assert.strictEqual(server.ranges[1]?.start, UPLOAD_CHUNK_SIZE);
    assert.strictEqual(server.sent, 1);
  }),
);

it.effect("small files that exceed one Graph request are attached individually", () =>
  Effect.gen(function* () {
    const parts = [file(2 * 1024 * 1024, "a.bin"), file(2 * 1024 * 1024, "b.bin")];
    const server = graph(parts);
    yield* run(server, (adapter) => adapter.send(account, message(parts), Option.none()));
    assert.strictEqual(server.sessionCount, 0);
    assert.strictEqual(server.attachments.length, 2);
    assert.strictEqual(server.sent, 1);
  }),
);

it.effect("an uncertain create is adopted by exact identity on a fresh adapter", () =>
  Effect.gen(function* () {
    const { large, server } = setup();
    const preparation = journal();
    server.flags.loseCreate = true;
    yield* run(server, (adapter) =>
      adapter.send(account, message([large]), Option.none(), preparation).pipe(Effect.flip),
    );
    assert.strictEqual(Option.getOrThrow(yield* preparation.load).phase, "creating");
    yield* run(server, (adapter) =>
      adapter.send(account, message([large]), Option.none(), preparation),
    );
    assert.strictEqual(server.created, 1);
    assert.strictEqual(server.sent, 1);
  }),
);

it.effect(
  "a crash after upload and before send adopts the persisted draft without another upload",
  () =>
    Effect.gen(function* () {
      const { large, server } = setup();
      const services = StoreLive.pipe(
        Layer.provideMerge(Layer.mergeAll(MemoryPlatform(options), server.layer)),
      );
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const prep: SendPreparation = {
          load: store.sendPreparationState("local"),
          save: (state) => store.setSendPreparationState("local", state),
        };
        yield* makeOutlook.pipe(
          Effect.flatMap((adapter) =>
            adapter.send(account, message([large]), Option.none(), {
              ...prep,
              save: (state) =>
                state?.phase === "sending" ? Effect.die("simulated crash") : prep.save(state),
            }),
          ),
          Effect.exit,
        );
        assert.strictEqual(Option.getOrThrow(yield* prep.load).phase, "preparing");
        assert.strictEqual(server.sent, 0);
        yield* makeOutlook.pipe(
          Effect.flatMap((adapter) => adapter.send(account, message([large]), Option.none(), prep)),
        );
        assert.strictEqual(server.created, 1);
        assert.strictEqual(server.sessionCount, 1);
        assert.strictEqual(server.sent, 1);
      }).pipe(Effect.provide(services));
    }),
);

it.effect("a send with a lost response confirms Sent and never repeats the submission", () =>
  Effect.gen(function* () {
    const { large, server } = setup();
    const preparation = journal();
    server.flags.loseSend = true;
    yield* run(server, (adapter) =>
      adapter.send(account, message([large]), Option.none(), preparation),
    );
    yield* run(server, (adapter) =>
      adapter.send(account, message([large]), Option.none(), preparation),
    );
    assert.strictEqual(server.sent, 1);
    assert.strictEqual(server.created, 1);
  }),
);

for (const delivered of [true, false])
  it.effect(
    `a stalled large-attachment send is submitted once and ${delivered ? "confirmed" : "left SendUncertain"} by exact Message-ID`,
    () =>
      Effect.gen(function* () {
        // A Sent copy that never appears: every lookup misses.
        const { large, server } = setup(undefined, {
          stallSend: true,
          ...(delivered ? {} : { sentLag: Number.MAX_SAFE_INTEGER }),
        });
        const preparation = journal();
        const exit = yield* run(server, (adapter) =>
          Effect.gen(function* () {
            const sending = yield* adapter
              .send(account, message([large]), Option.none(), preparation)
              .pipe(Effect.forkChild);
            for (let step = 0; step < 300 && !sending.pollUnsafe(); step++)
              yield* TestClock.adjust("1 second");
            return sending.pollUnsafe();
          }),
        );
        if (delivered) assert.strictEqual(exit?._tag, "Success");
        else {
          assert.strictEqual(exit?._tag, "Failure");
          if (exit?._tag === "Failure")
            assert.isTrue(
              exit.cause.reasons.some(
                (reason) =>
                  reason._tag === "Fail" && Predicate.isTagged(reason.error, "SendUncertain"),
              ),
            );
        }
        assert.strictEqual(server.sent, 1);
        assert.strictEqual(
          server.calls.filter((call) => call.method === "POST" && call.path.endsWith("/send"))
            .length,
          1,
        );
        assert.strictEqual(server.sessionCount, 1);
        const lookups = server.calls.filter(
          (call) => call.path === "/me/mailFolders/sentitems/messages",
        );
        assert.isAbove(lookups.length, 0);
        for (const lookup of lookups)
          assert.strictEqual(lookup.filter, `internetMessageId eq '${server.identity}'`);
      }),
  );

it.effect("a missing exact draft is recreated without deleting an unrelated draft", () =>
  Effect.gen(function* () {
    const { large, server } = setup();
    const preparation = journal();
    server.flags.loseCreate = true;
    yield* runRecovery(server, (adapter) =>
      adapter.send(account, message([large]), Option.none(), preparation).pipe(Effect.flip),
    );
    server.flags.hidden = true;
    server.flags.loseCreate = false;
    yield* runRecovery(server, (adapter) =>
      adapter.send(account, message([large]), Option.none(), preparation),
    );
    assert.strictEqual(server.created, 2);
    assert.strictEqual(server.sent, 1);
    assert.isFalse(server.calls.some((call) => call.method === "DELETE"));
  }),
);

it.effect("an upload rejected during draft save keeps its ID and retries the same draft", () =>
  Effect.gen(function* () {
    const { large, server } = setup();
    server.flags.failure = "reject";
    yield* run(server, (adapter) =>
      Effect.gen(function* () {
        const push: DraftPush = {
          creation: draftCreation(),
          remote: null,
          message: message([small, large]),
          original: Option.none(),
          replaceAttachments: true,
        };
        const first = yield* adapter.saveDraft(account, push);
        assert.strictEqual(first.messageId, "draft");
        assert.strictEqual(first.saveError?._tag, "PermanentError");
        server.flags.failure = "none";
        const next = yield* adapter.saveDraft(account, { ...push, remote: first });
        assert.strictEqual(next.saveError, undefined);
        yield* adapter.saveDraft(account, { ...push, remote: next, replaceAttachments: false });
        assert.strictEqual(server.created, 1);
        assert.deepStrictEqual(
          server.attachments.map((part) => part.file.filename),
          [small.filename, large.filename],
        );
      }),
    );
  }),
);

it.effect(
  "re-saving unchanged large attachments preserves them even when reconciliation is requested",
  () =>
    Effect.gen(function* () {
      const { large, server } = setup();
      yield* run(server, (adapter) =>
        Effect.gen(function* () {
          const push: DraftPush = {
            creation: draftCreation(),
            remote: null,
            message: message([large]),
            original: Option.none(),
            replaceAttachments: true,
          };
          const remote = yield* adapter.saveDraft(account, push);
          yield* adapter.saveDraft(account, {
            ...push,
            remote,
            message: { ...push.message, text: "Edited" },
          });
          assert.strictEqual(server.sessionCount, 1);
          assert.strictEqual(server.attachments.length, 1);
          assert.isFalse(server.calls.some((call) => call.method === "DELETE"));
        }),
      );
    }),
);

it.effect(
  "opening a saved Graph draft and saving edited text does not upload unchanged files",
  () =>
    Effect.gen(function* () {
      const { large, server } = setup();
      server.flags.raw = [
        "From: me@outlook.com",
        "To: recipient@example.test",
        "Subject: Upload",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="upload-test"',
        "",
        "--upload-test",
        "Content-Type: text/plain",
        "",
        "Message text",
        "--upload-test",
        "Content-Type: application/octet-stream",
        'Content-Disposition: attachment; filename="large.bin"',
        "Content-Transfer-Encoding: base64",
        "",
        large.content,
        "--upload-test--",
        "",
      ].join("\r\n");
      const services = Layer.mergeAll(
        StoreLive,
        Layer.effect(
          Providers,
          makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter }))),
        ),
      ).pipe(Layer.provideMerge(Layer.mergeAll(MemoryPlatform(options), server.layer)));
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const providers = yield* Providers;
        const secrets = yield* Secrets;
        const mailbox = yield* Mailbox;
        const saved = yield* store.upsertAccount("outlook", account.email);
        yield* secrets.set(saved.id, "refresh-token");
        yield* providers.get("outlook").saveDraft(saved, {
          creation: draftCreation(),
          remote: null,
          message: message([large]),
          original: Option.none(),
          replaceAttachments: true,
        });
        yield* store.upsertMessage(saved.id, {
          ...incoming("draft", { threadId: "conversation" }),
          labels: ["DRAFT"],
          attachments: [
            {
              filename: large.filename,
              mimeType: large.mimeType,
              size: Buffer.byteLength(large.content, "base64"),
            },
          ],
        });
        const opened = yield* mailbox.compose.openDraft(`${saved.id}/draft`);
        assert.strictEqual(opened.message.attachments.length, 1);
        const again = yield* mailbox.compose.saveDraft({
          id: opened.id,
          accountId: saved.id,
          message: { ...opened.message, text: "Edited message text" },
        });
        assert.strictEqual(again.syncError, null);
        assert.strictEqual(server.sessionCount, 1);
        assert.strictEqual(server.created, 1);
        assert.strictEqual(server.calls.filter((call) => call.method === "PATCH").length, 1);
      }).pipe(
        Effect.provide(
          MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
            Layer.provideMerge(services),
          ),
        ),
      );
    }),
);

it.effect(
  "upload failure cleans only the exact temporary draft when no durable journal is supplied",
  () =>
    Effect.gen(function* () {
      const { large, server } = setup();
      server.flags.failure = "reject";
      yield* run(server, (adapter) =>
        adapter.send(account, message([large]), Option.none()).pipe(Effect.flip),
      );
      assert.strictEqual(
        server.calls.filter(
          (call) => call.method === "DELETE" && call.path === "/me/messages/draft",
        ).length,
        1,
      );
      assert.strictEqual(
        server.calls.filter((call) => call.method === "DELETE" && call.path.startsWith("/upload/"))
          .length,
        1,
      );
      assert.strictEqual(server.sent, 0);
    }),
);

it.effect("size errors reject before Graph requests, including large message/rfc822 parts", () =>
  Effect.gen(function* () {
    const server = graph([]);
    for (const outgoing of [
      message([file(OUTLOOK_MESSAGE_LIMIT)]),
      message([{ ...file(), mimeType: "message/rfc822" }]),
      { ...message([]), text: "界".repeat(2 * 1024 * 1024) },
    ]) {
      const error = yield* run(server, (adapter) =>
        adapter.send(account, outgoing, Option.none()).pipe(Effect.flip),
      );
      assert.strictEqual(error._tag, "PermanentError");
    }
    assert.strictEqual(server.calls.length, 0);
    assert.strictEqual(
      attachmentSizesProblem("outlook", [
        { filename: "large.bin", mimeType: "application/octet-stream", size: 10 * 1024 * 1024 },
      ]),
      undefined,
    );
    assert.deepStrictEqual(
      attachmentSizesProblem("outlook", [
        {
          filename: "large.bin",
          mimeType: "application/octet-stream",
          size: OUTLOOK_MESSAGE_LIMIT,
        },
      ]),
      { kind: "outlookSize" },
    );
  }),
);

it("base64 slices preserve bytes at unaligned ranges and final padding", () => {
  const content = Buffer.from([1, 2, 3, 4, 5, 6, 7]).toString("base64");
  assert.deepStrictEqual([...attachmentRange(content, 1, 5)], [2, 3, 4, 5, 6]);
  assert.deepStrictEqual([...attachmentRange(content, 6, 1)], [7]);
});

it.effect(
  "100 MB upload decodes only one bounded chunk at a time",
  () =>
    Effect.gen(function* () {
      const { large, server } = setup(100 * 1024 * 1024);
      const originalFrom = Buffer.from.bind(Buffer);
      let largestDecode = 0;
      const measuredFrom: ByteCodec["from"] = (
        value: string | Uint8Array | readonly number[],
        encoding?: ByteEncoding,
      ) => {
        if (typeof value === "string") {
          if (encoding === "base64")
            largestDecode = Math.max(largestDecode, Buffer.byteLength(value, "base64"));
          return originalFrom(value, encoding);
        }
        return originalFrom(value);
      };
      const decoding = vi.spyOn(Buffer, "from").mockImplementation(measuredFrom);
      yield* makeOutlookClient.pipe(
        Effect.flatMap(makeAttachmentUpload),
        Effect.flatMap((upload) => upload(account.id, "draft", large, () => Effect.succeed(false))),
        Effect.provide(Layer.mergeAll(MemoryPlatform(options), server.layer)),
        Effect.ensuring(Effect.sync(() => decoding.mockRestore())),
      );
      assert.isAtMost(largestDecode, UPLOAD_CHUNK_SIZE);
      assert.isAbove(largestDecode, 0);
      assert.strictEqual(server.ranges.length, Math.ceil((100 * 1024 * 1024) / UPLOAD_CHUNK_SIZE));
      assert.strictEqual(server.sessionCount, 1);
    }),
  { timeout: scaledMs(30_000) },
);

it.effect("discarding a send preparation queues exact Message-ID cleanup", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const saved = yield* store.upsertAccount("outlook", account.email);
    yield* store.putDraft({ id: "local", accountId: saved.id, message: message([]) });
    yield* store.setSendPreparationState("local", {
      phase: "preparing",
      messageId: "<temporary@outlook.com>",
      draftId: "temporary",
    });
    yield* store.deleteDraft("local");
    assert.isTrue(Option.isNone(yield* store.sendPreparationState("local")));
    const cleanup = yield* store.listPendingOps;
    assert.deepStrictEqual(
      cleanup.map((op) => op.op),
      [
        {
          kind: "deleteDraft",
          remote: { draftId: null, messageId: null, rfcMessageId: "<temporary@outlook.com>" },
        },
      ],
    );
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform(options))))),
);

for (const phase of ["creating", "preparing"] as const)
  it.effect(`restart with a missing ${phase} draft recreates it with the same Message-ID`, () =>
    Effect.gen(function* () {
      const { server, outgoing } = setup();
      const messageId = "<restart@outlook.com>";
      const preparation = journal(
        phase === "creating" ? { phase, messageId } : { phase, messageId, draftId: "deleted" },
      );
      yield* runRecovery(server, (adapter) =>
        adapter.send(account, outgoing, Option.none(), preparation),
      );
      assert.strictEqual(server.created, 1);
      assert.strictEqual(server.sent, 1);
      assert.strictEqual(Option.getOrThrow(yield* preparation.load).messageId, messageId);
    }),
  );

it.effect("a create that never reached Graph recovers on a fresh adapter", () =>
  Effect.gen(function* () {
    const { server, outgoing } = setup(undefined, { createNotReceived: true });
    const preparation = journal();
    yield* runRecovery(server, (adapter) =>
      adapter.send(account, outgoing, Option.none(), preparation).pipe(Effect.flip),
    );
    const identity = Option.getOrThrow(yield* preparation.load).messageId;
    assert.strictEqual(server.created, 0);
    yield* runRecovery(server, (adapter) =>
      adapter.send(account, outgoing, Option.none(), preparation),
    );
    assert.strictEqual(server.created, 1);
    assert.strictEqual(server.sent, 1);
    assert.strictEqual(Option.getOrThrow(yield* preparation.load).messageId, identity);
  }),
);

it.effect("a crash after journaling but before the create POST can recover", () =>
  Effect.gen(function* () {
    const { server, outgoing } = setup();
    const preparation = journal();
    yield* runRecovery(server, (adapter) =>
      adapter
        .send(account, outgoing, Option.none(), {
          ...preparation,
          save: (state) =>
            preparation.save(state).pipe(Effect.andThen(Effect.die("crash before POST"))),
        })
        .pipe(Effect.exit),
    );
    assert.strictEqual(server.created, 0);
    const identity = Option.getOrThrow(yield* preparation.load).messageId;
    yield* runRecovery(server, (adapter) =>
      adapter.send(account, outgoing, Option.none(), preparation),
    );
    assert.strictEqual(server.created, 1);
    assert.strictEqual(server.sent, 1);
    assert.strictEqual(Option.getOrThrow(yield* preparation.load).messageId, identity);
  }),
);

it.effect(
  "a half-built draft sent on the web is confirmed instead of recreated after restart",
  () =>
    Effect.gen(function* () {
      const { server, outgoing } = setup(undefined, { webSent: true });
      const preparation = journal({
        phase: "preparing",
        messageId: "<web-sent@outlook.com>",
        draftId: "gone",
      });
      yield* run(server, (adapter) => adapter.send(account, outgoing, Option.none(), preparation));
      assert.strictEqual(server.created, 0);
      assert.strictEqual(server.sent, 0);
      assert.strictEqual(server.calls.filter((call) => call.method === "POST").length, 0);
    }),
);

it.effect("lost final PUT 201 plus a failed progress GET leaves one attachment and one send", () =>
  Effect.gen(function* () {
    const { server, outgoing } = setup(undefined, { failure: "last" });
    yield* run(server, (adapter) => adapter.send(account, outgoing, Option.none()));
    assert.strictEqual(server.sessionCount, 1);
    assert.strictEqual(server.attachments.length, 1);
    assert.strictEqual(server.sent, 1);
    assert.isTrue(
      server.calls.some((call) => call.method === "GET" && call.path.startsWith("/upload/")),
    );
  }),
);

it.effect("a past expiration timestamp still attempts PUT when the server session is valid", () =>
  Effect.gen(function* () {
    const { server, outgoing } = setup(undefined, { expires: "1970-01-01T00:00:00Z" });
    yield* run(server, (adapter) => adapter.send(account, outgoing, Option.none()));
    assert.strictEqual(server.sessionCount, 1);
    assert.strictEqual(server.sent, 1);
  }),
);

it.effect("an expired-session error cancels the old URL and restarts", () =>
  Effect.gen(function* () {
    const { server, outgoing } = setup(undefined, { expiredError: true });
    yield* run(server, (adapter) => adapter.send(account, outgoing, Option.none()));
    assert.strictEqual(server.sessionCount, 2);
    assert.strictEqual(server.sent, 1);
    assert.isTrue(
      server.calls.some((call) => call.method === "DELETE" && call.path === "/upload/1"),
    );
  }),
);

it.effect("a slow chunk can take longer than thirty seconds", () =>
  Effect.gen(function* () {
    const { server, outgoing } = setup(undefined, { chunkDelay: 40000 });
    yield* run(server, (adapter) =>
      Effect.gen(function* () {
        const upload = yield* adapter.send(account, outgoing, Option.none()).pipe(Effect.forkChild);
        for (let tick = 0; tick < 6; tick++) yield* TestClock.adjust("40 seconds");
        yield* Fiber.join(upload);
      }),
    );
    assert.strictEqual(server.sessionCount, 1);
    assert.strictEqual(server.sent, 1);
  }),
);

it.effect("SendUncertain survives an adapter restart without automatic resubmission", () =>
  Effect.gen(function* () {
    const { server, outgoing } = setup(undefined, { sendNotReceived: true });
    const preparation = journal();
    for (let attempt = 0; attempt < 2; attempt++) {
      yield* run(server, (adapter) =>
        Effect.gen(function* () {
          const sending = yield* adapter
            .send(account, outgoing, Option.none(), preparation)
            .pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust("35 seconds");
          const result = yield* Fiber.join(sending);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "SendUncertain");
        }),
      );
    }
    assert.strictEqual(
      server.calls.filter((call) => call.method === "POST" && call.path.endsWith("/send")).length,
      1,
    );
    assert.strictEqual(Option.getOrThrow(yield* preparation.load).phase, "sending");
  }),
);

it.effect("identical filenames and MIME casing still preserve both attachments after expiry", () =>
  Effect.gen(function* () {
    const first = file(undefined, "same.bin");
    const parts = [first, { ...first, mimeType: first.mimeType.toUpperCase() }];
    const server = graph(parts, { failure: "expire", failAfterAttachments: 1 });
    yield* run(server, (adapter) => adapter.send(account, message(parts), Option.none()));
    assert.strictEqual(server.attachments.length, 2);
    assert.strictEqual(server.sessionCount, 3);
    assert.strictEqual(server.sent, 1);
  }),
);

it.effect("a lagging Sent lookup confirms a just-sent web draft without recreating it", () =>
  Effect.gen(function* () {
    const { server, outgoing } = setup(undefined, { webSent: true, sentLag: 2 });
    const preparation = journal({
      phase: "preparing",
      messageId: "<web-sent@outlook.com>",
      draftId: "gone",
    });
    yield* run(server, (adapter) =>
      Effect.gen(function* () {
        const sending = yield* adapter
          .send(account, outgoing, Option.none(), preparation)
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(sending);
      }),
    );
    assert.strictEqual(server.sentLookups, 3);
    assert.strictEqual(server.created, 0);
    assert.strictEqual(server.sent, 0);
  }),
);

it.effect("a failed Sent probe never recreates the missing draft", () =>
  Effect.gen(function* () {
    const { server, outgoing } = setup(undefined, { sentLookupFailure: true });
    const preparation = journal({
      phase: "preparing",
      messageId: "<probe-failed@outlook.com>",
      draftId: "gone",
    });
    const error = yield* runRecovery(server, (adapter) =>
      adapter.send(account, outgoing, Option.none(), preparation).pipe(Effect.flip),
    );
    assert.strictEqual(error._tag, "ProviderError");
    assert.strictEqual(server.created, 0);
    assert.strictEqual(server.calls.filter((call) => call.method === "POST").length, 0);
    assert.strictEqual(
      Option.getOrThrow(yield* preparation.load).messageId,
      "<probe-failed@outlook.com>",
    );
  }),
);

const mailboxLayer = (server: ReturnType<typeof graph>) =>
  MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        StoreLive,
        Layer.effect(
          Providers,
          makeOutlook.pipe(Effect.map((adapter) => ({ get: () => adapter }))),
        ),
      ).pipe(Layer.provideMerge(Layer.mergeAll(MemoryPlatform(options), server.layer))),
    ),
  );

for (const queued of [false, true])
  it.effect(
    `confirmResend clears a persisted sending phase and really sends again (${queued ? "undo queue" : "direct"})`,
    () => {
      const { server, outgoing } = setup(undefined, {
        oldDraft: { id: "old-ready", messageId: "<uncertain@outlook.com>" },
      });
      return Effect.gen(function* () {
        const store = yield* Store;
        const secrets = yield* Secrets;
        const mailbox = yield* Mailbox;
        const saved = yield* store.upsertAccount("outlook", account.email);
        yield* secrets.set(saved.id, "refresh-token");
        yield* store.putDraft({ id: "resend", accountId: saved.id, message: outgoing });
        yield* store.setSendUncertain("resend", true);
        yield* store.setSendPreparationState("resend", {
          phase: "sending",
          messageId: "<uncertain@outlook.com>",
          draftId: "unknown",
        });
        if (queued) {
          yield* mailbox.outbox.queueUndoSend(
            { id: "resend", accountId: saved.id, message: outgoing },
            (yield* Clock.currentTimeMillis) + 5000,
            { confirmResend: true },
          );
          assert.isTrue(Option.isNone(yield* store.sendPreparationState("resend")));
          assert.deepStrictEqual(
            (yield* store.listPendingOps)
              .filter((op) => op.op.kind === "deleteDraft")
              .map((op) => op.op),
            [
              {
                kind: "deleteDraft",
                remote: { draftId: null, messageId: null, rfcMessageId: "<uncertain@outlook.com>" },
              },
            ],
          );
          yield* TestClock.adjust("6 seconds");
        } else
          yield* mailbox.organize.perform(
            {
              kind: "send",
              accountId: saved.id,
              draftId: "resend",
              message: outgoing,
              confirmResend: true,
            },
            { kind: "user", surface: "app" },
          );
        assert.strictEqual(server.sent, 1);
        assert.strictEqual(server.flags.oldDraft, undefined);
        assert.strictEqual(
          server.calls.filter(
            (call) => call.method === "DELETE" && call.path === "/me/messages/old-ready",
          ).length,
          1,
        );
        assert.isTrue(Option.isNone(yield* store.sendPreparationState("resend")));
      }).pipe(Effect.provide(mailboxLayer(server)));
    },
  );

it.effect("an oversized body and attachment combination fails before the undo window", () => {
  const { server, outgoing } = setup(10 * 1024 * 1024);
  return Effect.gen(function* () {
    const store = yield* Store;
    const mailbox = yield* Mailbox;
    const saved = yield* store.upsertAccount("outlook", account.email);
    const error = yield* mailbox.outbox
      .queueUndoSend(
        {
          id: "too-large",
          accountId: saved.id,
          message: { ...outgoing, text: "a".repeat(12 * 1024 * 1024) },
        },
        (yield* Clock.currentTimeMillis) + 5000,
      )
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "InvalidInput");
    assert.include(error.message, "25 MB");
    assert.deepStrictEqual(yield* mailbox.outbox.queuedSends, []);
    assert.strictEqual(server.calls.length, 0);
  }).pipe(Effect.provide(mailboxLayer(server)));
});

it.effect(
  "verified hashes skip repeated downloads and invalidate after a remote version change",
  () =>
    Effect.gen(function* () {
      const { server, outgoing } = setup();
      yield* run(server, (adapter) =>
        Effect.gen(function* () {
          const push: DraftPush = {
            creation: draftCreation(),
            remote: null,
            message: outgoing,
            original: Option.none(),
            replaceAttachments: true,
          };
          const first = yield* adapter.saveDraft(account, push);
          const second = yield* adapter.saveDraft(account, { ...push, remote: first });
          const third = yield* adapter.saveDraft(account, { ...push, remote: second });
          const downloads = () =>
            server.calls.filter((call) => call.path.endsWith("/$value")).length;
          assert.strictEqual(downloads(), 1);
          server.flags.version++;
          yield* adapter.saveDraft(account, {
            ...push,
            remote: { draftId: third.draftId, messageId: third.messageId },
          });
          assert.strictEqual(downloads(), 2);
          assert.strictEqual(server.sessionCount, 1);
        }),
      );
    }),
);

it.effect(
  "Graph's per-file upload maximum is checked before creating a session",
  () =>
    Effect.gen(function* () {
      const server = graph([]);
      const tooLarge = file(OUTLOOK_UPLOAD_LIMIT + 1);
      const error = yield* makeOutlookClient.pipe(
        Effect.flatMap(makeAttachmentUpload),
        Effect.flatMap((upload) =>
          upload(account.id, "draft", tooLarge, () => Effect.succeed(false)),
        ),
        Effect.flip,
        Effect.provide(Layer.mergeAll(MemoryPlatform(options), server.layer)),
      );
      assert.strictEqual(error._tag, "PermanentError");
      assert.strictEqual(server.calls.length, 0);
    }),
  { timeout: scaledMs(30_000) },
);
