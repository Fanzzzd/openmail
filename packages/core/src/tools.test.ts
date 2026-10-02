import { assert, it } from "@effect/vitest";

import { Effect, Layer, Stream } from "effect";
import type { Tool } from "effect/ai";

import type { Actor, Command, Outcome, ThreadQuery } from "./domain.js";
import { Mailbox } from "./mailbox.js";
import { AgentIdentity, MailToolkit, MailToolkitLayer } from "./tools.js";

type Service = Mailbox["Service"];

const notUsed = (name: string) => Effect.die(`Mailbox.${name} is not used in this test`);

function stubMailbox(overrides: Partial<Service>): Layer.Layer<Mailbox> {
  const base: Service = {
    setAccountSettings: () => Effect.die("unused"),
    moveAccount: () => Effect.die("unused"),
    checkUpdates: () => Effect.die("unused"),
    rememberNotificationActions: () => Effect.die("unused"),
    notificationActions: () => Effect.die("unused"),
    permanentlyDelete: () => notUsed("permanentlyDelete"),
    emptyFolder: () => notUsed("emptyFolder"),
    markFolderRead: () => notUsed("markFolderRead"),
    resetFavorites: () => notUsed("resetFavorites"),
    updateTokenConfigured: Effect.die("unused"),
    setUpdateToken: () => Effect.die("unused"),
    startUpdates: () => Effect.die("unused"),
    cacheWindows: Effect.die("unused"),
    setCacheWindow: () => Effect.die("unused"),
    backfillState: Effect.die("unused"),
    pauseBackfill: () => Effect.die("unused"),
    fetchOlder: () => Effect.die("unused"),
    accounts: notUsed("accounts"),
    invitations: () => notUsed("invitations"),
    respondInvite: () => notUsed("respondInvite"),
    contactSync: notUsed("contactSync"),
    refreshContacts: () => notUsed("refreshContacts"),
    searchServer: () => notUsed("searchServer"),
    changeLabel: () => notUsed("changeLabel"),
    setLabelPreference: () => notUsed("setLabelPreference"),
    setOrganization: () => notUsed("setOrganization"),
    snooze: () => notUsed("snooze"),
    wakeSnoozed: () => notUsed("wakeSnoozed"),
    filters: () => notUsed("filters"),
    previewFilter: () => notUsed("previewFilter"),
    createFilter: () => notUsed("createFilter"),
    deleteFilter: () => notUsed("deleteFilter"),
    vacation: () => notUsed("vacation"),
    setVacation: () => notUsed("setVacation"),
    syncSendAs: () => notUsed("syncSendAs"),
    labelPreferences: notUsed("labelPreferences"),
    organization: notUsed("organization"),
    sendAs: notUsed("sendAs"),

    connect: () => notUsed("connect"),
    reauth: () => notUsed("reauth"),
    clientSetup: notUsed("clientSetup"),
    setClient: () => notUsed("setClient"),
    threads: () => notUsed("threads"),
    readerThread: () => Effect.die("unused"),
    thread: () => notUsed("thread"),
    threadForModel: () => notUsed("threadForModel"),
    rawMessage: () => notUsed("rawMessage"),
    rawMessageBytes: () => notUsed("rawMessageBytes"),
    messageWebUrl: () => notUsed("messageWebUrl"),
    knownSenders: () => notUsed("knownSenders"),
    attachment: () => notUsed("attachment"),
    inlineImages: () => notUsed("inlineImages"),
    imageSenders: notUsed("imageSenders"),
    setImageSender: () => notUsed("setImageSender"),
    labels: () => notUsed("labels"),
    unreadCounts: notUsed("unreadCounts"),
    unreadByLabel: () => notUsed("unreadByLabel"),
    profiles: notUsed("profiles"),
    takeNotifications: notUsed("takeNotifications"),
    createProfile: () => notUsed("createProfile"),
    updateProfile: () => notUsed("updateProfile"),
    deleteProfile: () => notUsed("deleteProfile"),
    assignProfile: () => notUsed("assignProfile"),
    markUnreadFrom: () => Effect.die("not used"),
    modifyWithUndo: () => Effect.die("not used"),
    threadCount: () => Effect.die("not used"),
    undoBatch: () => Effect.die("not used"),
    perform: () => notUsed("perform"),
    decideProposal: () => notUsed("decideProposal"),
    proposals: notUsed("proposals"),
    audit: () => notUsed("audit"),
    agentWriteMode: notUsed("agentWriteMode"),
    setAgentWriteMode: () => notUsed("setAgentWriteMode"),
    composeAttachments: () => Effect.die("unused"),
    sendAgain: () => Effect.die("unused"),
    pendingSendCount: Effect.succeed(0),
    openDraft: () => notUsed("openDraft"),
    saveDraft: () => notUsed("saveDraft"),
    discardDraft: () => notUsed("discardDraft"),
    indexingProgress: notUsed("indexingProgress"),
    setModelsEnabled: () => notUsed("setModelsEnabled"),
    setIndexingPaused: () => notUsed("setIndexingPaused"),
    derivedChunks: () => notUsed("derivedChunks"),
    mediaImage: () => notUsed("mediaImage"),
    prefs: notUsed("prefs"),
    setPrefs: () => notUsed("setPrefs"),
    signatures: notUsed("signatures"),
    setSignature: () => notUsed("setSignature"),
    templates: notUsed("templates"),
    saveTemplate: () => notUsed("saveTemplate"),
    deleteTemplate: () => notUsed("deleteTemplate"),
    suggestContacts: () => notUsed("suggestContacts"),
    hiddenContacts: notUsed("hiddenContacts"),
    setContactHidden: () => notUsed("setContactHidden"),
    sync: () => notUsed("sync"),
    pollInbox: () => notUsed("pollInbox"),
    syncState: notUsed("syncState"),
    events: Stream.empty,
  };
  return Layer.succeed(Mailbox, { ...base, ...overrides });
}

/** A Mailbox whose perform records its calls and answers with `outcome`. */
function recordingMailbox(outcome: Outcome) {
  const calls: { command: Command; actor: Actor }[] = [];
  const layer = stubMailbox({
    perform: (command, actor) =>
      Effect.sync(() => {
        calls.push({ command, actor });
        return outcome;
      }),
  });
  return { calls, layer };
}

function run<A, E>(
  effect: Effect.Effect<A, E, Mailbox | AgentIdentity | Effect.Services<typeof MailToolkit>>,
  mailbox: Layer.Layer<Mailbox>,
): Effect.Effect<A, E> {
  const handlers = MailToolkitLayer.pipe(
    Layer.provide(mailbox),
    Layer.provide(AgentIdentity.fixed("mcp", "claude-code")),
  );
  return effect.pipe(
    Effect.provide(Layer.mergeAll(handlers, mailbox, AgentIdentity.fixed("mcp", "claude-code"))),
  );
}

type Tools = typeof MailToolkit.tools;

const call = <N extends keyof Tools>(name: N, params: Tool.ParametersEncoded<Tools[N]>) =>
  Effect.gen(function* () {
    const toolkit = yield* MailToolkit;
    const stream = yield* toolkit.handle(name, params);
    const last = yield* Stream.runLast(stream);
    assert.ok(last._tag === "Some", "the tool produced a result");
    return last.value;
  });

it.effect("modify_threads performs one modify command as the calling agent", () =>
  Effect.gen(function* () {
    const { calls, layer } = recordingMailbox({ status: "proposed", proposalId: 7 });
    const result = yield* run(
      call("modify_threads", {
        thread_ids: ["m1", "m2"],
        action: "unread",
        rationale: "Both need a reply this week.",
      }),
      layer,
    );

    assert.strictEqual(result.isFailure, false);
    assert.deepStrictEqual(calls, [
      {
        command: { kind: "modify", threads: ["m1", "m2"], op: { kind: "read", value: false } },
        actor: {
          kind: "agent",
          surface: "mcp",
          name: "claude-code",
          rationale: "Both need a reply this week.",
        },
      },
    ]);
    assert.match(JSON.stringify(result.encodedResult), /proposal 7/);
  }),
);

it.effect("modify_threads maps every action to its op", () =>
  Effect.gen(function* () {
    const cases = [
      ["archive", { kind: "archive" }],
      ["inbox", { kind: "inbox" }],
      ["trash", { kind: "trash" }],
      ["spam", { kind: "spam" }],
      ["read", { kind: "read", value: true }],
      ["star", { kind: "star", value: true }],
      ["unstar", { kind: "star", value: false }],
      ["important", { kind: "important", value: true }],
      ["unimportant", { kind: "important", value: false }],
      ["label", { kind: "label", labelId: "Label_1", value: true }],
      ["unlabel", { kind: "label", labelId: "Label_1", value: false }],
    ] as const;
    for (const [action, op] of cases) {
      const { calls, layer } = recordingMailbox({ status: "applied" });
      yield* run(
        call("modify_threads", { thread_ids: ["m1"], action, label_id: "Label_1", rationale: "r" }),
        layer,
      );
      assert.deepStrictEqual(calls[0]?.command, { kind: "modify", threads: ["m1"], op }, action);
    }
  }),
);

it.effect("modify_threads label without label_id fails before perform", () =>
  Effect.gen(function* () {
    const { calls, layer } = recordingMailbox({ status: "applied" });
    const result = yield* run(
      call("modify_threads", { thread_ids: ["m1"], action: "label", rationale: "r" }),
      layer,
    );
    assert.strictEqual(result.isFailure, true);
    assert.strictEqual(calls.length, 0);
  }),
);

it.effect("a denied modify tells the model where the person can allow it", () =>
  Effect.gen(function* () {
    const { layer } = recordingMailbox({
      status: "denied",
      reason: "Changing mail is turned off.",
    });
    const result = yield* run(
      call("modify_threads", { thread_ids: ["m1"], action: "archive", rationale: "r" }),
      layer,
    );
    assert.match(JSON.stringify(result.encodedResult), /Settings > AI 权限/);
  }),
);

it.effect("draft_message only ever performs a draft command as the agent", () =>
  Effect.gen(function* () {
    const { calls, layer } = recordingMailbox({ status: "proposed", proposalId: 3 });
    const result = yield* run(
      call("draft_message", {
        account_id: "gmail:me@example.com",
        to: ["Alice <alice@example.com>", "bob@example.com"],
        subject: "Re: 报价",
        body: "收到，周五前回复。",
        reply_to_message_id: "m9",
        rationale: "Alice asked for a date.",
      }),
      layer,
    );

    assert.strictEqual(result.isFailure, false);
    assert.strictEqual(calls.length, 1);
    const only = calls[0];
    assert.ok(only);
    assert.deepStrictEqual(only.actor, {
      kind: "agent",
      surface: "mcp",
      name: "claude-code",
      rationale: "Alice asked for a date.",
    });
    assert.deepStrictEqual(only.command, {
      kind: "draft",
      accountId: "gmail:me@example.com",
      message: {
        to: [
          { name: "Alice", address: "alice@example.com" },
          { name: "", address: "bob@example.com" },
        ],
        cc: [],
        bcc: [],
        subject: "Re: 报价",
        text: "收到，周五前回复。",
        attachments: [],
        mode: "reply",
        inReplyTo: "m9",
      },
    });
    assert.match(JSON.stringify(result.encodedResult), /Nothing has been sent/);
  }),
);

it.effect("draft_message rejects a bad address without performing", () =>
  Effect.gen(function* () {
    const { calls, layer } = recordingMailbox({ status: "proposed", proposalId: 1 });
    const result = yield* run(
      call("draft_message", {
        account_id: "gmail:me@example.com",
        to: ["not an address"],
        subject: "s",
        body: "b",
        rationale: "r",
      }),
      layer,
    );
    assert.strictEqual(result.isFailure, true);
    assert.strictEqual(calls.length, 0);
  }),
);

it.effect("list_threads narrows to a profile and pages with next_before", () =>
  Effect.gen(function* () {
    const queries: ThreadQuery[] = [];
    const thread = (date: number) => ({
      id: `m${date}`,
      accountId: "gmail:a@example.com",
      threadId: `t${date}`,
      subject: "s",
      from: { name: "", address: "x@example.com" },
      date,
      snippet: "",
      labels: [],
      isUnread: false,
      isStarred: false,
      hasAttachments: false,
      threadCount: 1,
      participants: [],
    });
    const account = (id: string, profileId: string | null) => ({
      id,
      provider: "gmail" as const,
      email: id,
      createdAt: 0,
      lastSyncedAt: null,
      lastSyncError: null,
      profileId,
      needsReauth: false,
    });
    const layer = stubMailbox({
      accounts: Effect.succeed([
        account("gmail:a@example.com", "work"),
        account("gmail:b@example.com", null),
      ]),
      threads: (q) =>
        Effect.sync(() => {
          queries.push(q);
          return [thread(20), thread(10)];
        }),
    });
    const result = yield* run(call("list_threads", { profile_id: "work", limit: 2 }), layer);

    assert.deepStrictEqual(queries, [
      { mailbox: "inbox", accountIds: ["gmail:a@example.com"], limit: 2 },
    ]);
    assert.match(JSON.stringify(result.encodedResult), /"next_before":10/);
  }),
);

it.effect("search returns local matched chunks and provenance without image bytes", () => {
  const row = {
    id: "a/m",
    accountId: "a",
    threadId: "t",
    subject: "Mail",
    from: { name: "", address: "a@example.com" },
    date: 1,
    snippet: "",
    labels: [],
    isUnread: false,
    isStarred: false,
    hasAttachments: true,
    threadCount: 1,
    participants: [],
    derivedMatches: [
      {
        messageId: "a/m",
        text: "boarding gate",
        source: { kind: "attachment", index: 0, name: "ticket.pdf", mimeType: "application/pdf" },
        page: 2,
        region: null,
        pipelineVersion: "media-1",
        visionRevision: null,
      },
    ],
  } satisfies import("./domain.js").ThreadSummary;
  return Effect.gen(function* () {
    const result = yield* run(
      call("search", { query: "in:attachment boarding" }),
      stubMailbox({
        threads: (query) => {
          assert.strictEqual(query.search, "in:attachment boarding");
          return Effect.succeed([row]);
        },
      }),
    );
    assert.strictEqual(result.isFailure, false);
    assert.deepStrictEqual(result.result, { threads: [row] });
    const encoded = JSON.stringify(result.result);
    assert.ok(!encoded.includes("base64"));
    assert.ok(!encoded.includes('"data"'));
  });
});

it("MCP exposes no permanent deletion or whole-folder destruction", () => {
  assert.isFalse(Object.keys(MailToolkit.tools).some((name) => /permanent|empty/i.test(name)));
});
