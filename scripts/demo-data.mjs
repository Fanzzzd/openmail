// Seeds a demo OpenMail data directory with fake accounts and mail, for screenshots and
// manual testing. Every address uses example.com, example.org or example.net.
// It also turns on "Ask me first" for agents and adds one pending MCP proposal to approve.
//
//   pnpm build
//   node scripts/demo-data.mjs /tmp/openmail-demo        # or OPENMAIL_DEMO_HOME=/tmp/openmail-demo
//   OPENMAIL_HOME=/tmp/openmail-demo node packages/cli/dist/cli.js list --json
//
// The script refuses the real data directory and any directory that already has a mail.db,
// unless --force is given (the real directory is refused even then).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const force = args.includes("--force");
const target = args.find((arg) => !arg.startsWith("--")) ?? process.env.OPENMAIL_DEMO_HOME;
if (!target) {
  console.error("Usage: node scripts/demo-data.mjs <directory> [--force]");
  process.exit(2);
}
const home = resolve(target);
const real = [
  join(homedir(), "Library", "Application Support", "openmail"),
  join(homedir(), "Library", "Application Support", "OpenMail"),
].map((path) => path.toLowerCase());
if (real.includes(home.toLowerCase())) {
  console.error(`Refusing to write demo data into the real data directory: ${home}`);
  process.exit(2);
}
const database = join(home, "mail.db");
if (existsSync(database)) {
  if (!force) {
    console.error(`${database} exists. Pass --force to replace it.`);
    process.exit(2);
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(database + suffix, { force: true });
}
mkdirSync(home, { recursive: true });

const testing = join(root, "packages/core/dist/platform/node/testing.js");
if (!existsSync(testing)) {
  console.error("packages/core/dist is missing. Run `pnpm build` first.");
  process.exit(2);
}
const coreRequire = createRequire(join(root, "packages/core/package.json"));
const { Effect, Layer } = await import(pathToFileURL(coreRequire.resolve("effect")).href);
const { Store, TestMailbox } = await import(pathToFileURL(testing).href);
const { Mailbox } = await import(pathToFileURL(join(root, "packages/core/dist/common.js")).href);

const now = Date.now();
const minutes = (n) => now - n * 60_000;
const hours = (n) => minutes(n * 60);
const days = (n) => hours(n * 24);

const me = { name: "Alex Rivera", address: "alex@example.com" };
const work = { name: "Alex Rivera", address: "alex.rivera@example.org" };
const people = {
  priya: { name: "Priya Shah", address: "priya@example.org" },
  marco: { name: "Marco Bellini", address: "marco@example.org" },
  jordan: { name: "Jordan Lee", address: "jordan.lee@example.com" },
  sam: { name: "Sam Okafor", address: "sam@example.net" },
  mia: { name: "Mia Chen", address: "mia.chen@example.com" },
};

const html = (paragraphs) =>
  `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">${paragraphs
    .map((p) => `<p>${p}</p>`)
    .join("")}</div>`;
const text = (paragraphs) => paragraphs.join("\n\n").replace(/<[^>]+>/g, "");

let counter = 0;
/** One message; `body` is a list of paragraphs, rendered as both text and HTML. */
function message(fields) {
  const id = `demo-${++counter}`;
  const body = fields.body ?? [];
  return {
    providerId: fields.providerId ?? id,
    threadId: fields.threadId ?? `thread-${id}`,
    subject: fields.subject,
    from: fields.from,
    to: fields.to ?? [me],
    cc: fields.cc ?? [],
    date: fields.date,
    snippet: text(body).replace(/\s+/g, " ").slice(0, 140),
    bodyText: fields.bodyText ?? text(body),
    bodyHtml: fields.bodyHtml ?? html(body),
    rfcMessageId: `<${id}@mail.example.com>`,
    security: { dmarc: "pass", spf: "pass", dkim: "pass", ...fields.security },
    labels: [
      ...(fields.labels ?? ["INBOX"]),
      ...(fields.isUnread ? ["UNREAD"] : []),
      ...(fields.isStarred ? ["STARRED"] : []),
    ],
    attachments: fields.attachments ?? [],
    hasCalendar: fields.hasCalendar ?? false,
    isUnread: fields.isUnread ?? false,
    isStarred: fields.isStarred ?? false,
  };
}

const newsletter = (title, intro, items, footer) =>
  `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;font-family:-apple-system,Helvetica,Arial,sans-serif"><tr><td align="center" style="padding:24px"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px"><tr><td style="padding:28px 32px;border-bottom:1px solid #e6e8eb"><div style="font-size:22px;font-weight:700;color:#1d2433">${title}</div><div style="margin-top:8px;font-size:15px;color:#4a5263">${intro}</div></td></tr>${items
    .map(
      ([heading, copy]) =>
        `<tr><td style="padding:20px 32px;border-bottom:1px solid #f0f1f3"><div style="font-size:16px;font-weight:600;color:#1d2433">${heading}</div><div style="margin-top:6px;font-size:14px;line-height:1.55;color:#4a5263">${copy}</div></td></tr>`,
    )
    .join(
      "",
    )}<tr><td style="padding:20px 32px;font-size:12px;color:#8a91a0">${footer}</td></tr></table></td></tr></table>`;

const gmail = [
  // The work thread: four messages, the newest unread.
  message({
    threadId: "launch",
    subject: "Q4 launch plan: final review",
    from: people.priya,
    to: [me, people.marco],
    date: days(2),
    body: [
      "Hi both,",
      "I put the launch plan in the shared folder. The open items are the pricing page copy, the press list and who covers support during launch week.",
      "Can we settle these by Thursday?",
      "Priya",
    ],
    attachments: [{ filename: "Q4-launch-plan.pdf", mimeType: "application/pdf", size: 482_133 }],
  }),
  message({
    threadId: "launch",
    subject: "Re: Q4 launch plan: final review",
    from: people.marco,
    to: [people.priya, me],
    date: days(1),
    body: [
      "Pricing copy is done, I left two options in the doc.",
      "For support, I can take Monday to Wednesday if someone covers the rest of the week.",
      "Marco",
    ],
  }),
  message({
    threadId: "launch",
    subject: "Re: Q4 launch plan: final review",
    from: me,
    to: [people.priya, people.marco],
    labels: ["SENT"],
    date: hours(20),
    body: [
      "I'll cover Thursday and Friday. I prefer option B for the pricing copy, it's shorter.",
      "Press list: I added six contacts from last year. Priya, can you check the embargo date?",
      "Alex",
    ],
  }),
  message({
    threadId: "launch",
    subject: "Re: Q4 launch plan: final review",
    from: people.priya,
    to: [me, people.marco],
    date: minutes(35),
    isUnread: true,
    isStarred: true,
    body: [
      "Thanks both. Option B it is, and the embargo lifts on the 21st at 9:00 PT.",
      "I'll send the final plan to the team tomorrow morning. One last thing: can one of you draft the launch-day email to existing customers?",
      "Priya",
    ],
  }),
  message({
    subject: "Invitation: Design review @ Thu 10:00 – 11:00",
    from: people.jordan,
    date: hours(3),
    isUnread: true,
    hasCalendar: true,
    labels: ["INBOX", "Label_projects"],
    body: [
      "Jordan Lee has invited you to <b>Design review</b>.",
      "Thursday, 10:00 – 11:00<br>Room 4B and video call",
      "We'll walk through the new onboarding screens and the settings layout. Please bring feedback on the empty states.",
    ],
    attachments: [{ filename: "invite.ics", mimeType: "text/calendar", size: 2_214 }],
  }),
  message({
    subject: "Your receipt from Northwind Books",
    from: { name: "Northwind Books", address: "receipts@northwind.example.com" },
    date: hours(6),
    labels: ["INBOX", "CATEGORY_UPDATES", "Label_receipts"],
    bodyHtml: newsletter(
      "Thanks for your order",
      "Order #NW-20418 · Paid with card ending 4242",
      [
        ["Designing Data-Intensive Applications", "Paperback · 1 × $42.00"],
        ["The Pragmatic Programmer", "Hardcover · 1 × $39.50"],
        ["Total", "$81.50 including tax. Ships in 2 business days."],
      ],
      "Northwind Books · 100 Example Street · Springfield",
    ),
    body: ["Order #NW-20418. Total $81.50. Ships in 2 business days."],
  }),
  message({
    providerId: "newsletter-rust",
    subject: "This week in Rust: async closures, faster builds",
    from: { name: "Rust Weekly", address: "newsletter@rustweekly.example.net" },
    date: hours(9),
    isUnread: true,
    labels: ["INBOX", "CATEGORY_UPDATES", "Label_newsletters"],
    bodyHtml: newsletter(
      "This Week in Rust",
      "Issue 612 · Hand-picked updates from the community",
      [
        [
          "Async closures are stable",
          "The release notes walk through the new syntax and the migration lint.",
        ],
        [
          "Incremental builds, 30% faster",
          "A write-up on the new query cache and how to measure it locally.",
        ],
        ["Jobs", "Twelve new openings this week, eight of them remote."],
      ],
      "You are receiving this because you subscribed at rustweekly.example.net. Unsubscribe any time.",
    ),
    body: ["Issue 612: async closures are stable, incremental builds 30% faster, twelve new jobs."],
  }),
  message({
    providerId: "newsletter-frontend",
    subject: "Frontend Digest #218: container queries in practice",
    from: { name: "Frontend Digest", address: "digest@frontend.example.net" },
    date: days(6),
    labels: ["INBOX", "CATEGORY_UPDATES", "Label_newsletters"],
    bodyHtml: newsletter(
      "Frontend Digest",
      "Issue 218 · Five links worth your time",
      [
        ["Container queries in practice", "Three layouts rebuilt without media queries."],
        ["Smaller bundles", "How one team cut 40 KB by dropping a date library."],
      ],
      "You subscribed at frontend.example.net. Unsubscribe any time.",
    ),
    body: ["Issue 218: container queries in practice, smaller bundles."],
  }),
  message({
    providerId: "newsletter-product",
    subject: "Product Notes: what we shipped in September",
    from: { name: "Product Notes", address: "notes@product.example.org" },
    date: days(8),
    labels: ["INBOX", "CATEGORY_UPDATES", "Label_newsletters"],
    bodyHtml: newsletter(
      "Product Notes",
      "September roundup",
      [
        ["Offline mode", "Edits made offline now sync when you reconnect."],
        ["Shared views", "Send a saved filter to a teammate with one link."],
      ],
      "Product Notes · Unsubscribe",
    ),
    body: ["September roundup: offline mode, shared views."],
  }),
  message({
    subject: "Weekend hike?",
    from: people.sam,
    date: hours(14),
    isUnread: true,
    body: [
      "Hey Alex,",
      "Weather looks good for Saturday. Want to do the ridge trail? Start at 8, back by 2.",
      "Sam",
    ],
  }),
  message({
    subject: "Photos from the offsite",
    from: people.mia,
    date: hours(28),
    labels: ["INBOX", "Label_projects"],
    body: ["Here are the photos from last week. The group one came out great.", "Mia"],
    attachments: [
      { filename: "offsite-group.jpg", mimeType: "image/jpeg", size: 2_311_204 },
      { filename: "offsite-dinner.jpg", mimeType: "image/jpeg", size: 1_908_555 },
    ],
  }),
  message({
    subject: "Your monthly statement is ready",
    from: { name: "Example Bank", address: "statements@bank.example.com" },
    date: hours(51),
    labels: ["INBOX", "CATEGORY_UPDATES"],
    body: [
      "Your September statement is ready to view in online banking.",
      "This message does not contain account details. Sign in to see your statement.",
    ],
  }),
  message({
    subject: "Autumn sale: 30% off everything this weekend",
    from: { name: "Fieldnotes Outfitters", address: "hello@fieldnotes.example.com" },
    date: hours(56),
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    bodyHtml: newsletter(
      "Autumn sale",
      "30% off everything, Friday to Sunday.",
      [
        ["Rain shells", "Lightweight, packable and now 30% off."],
        ["Trail runners", "Our most popular pair is back in all sizes."],
      ],
      "Fieldnotes Outfitters · Unsubscribe",
    ),
    body: ["30% off everything, Friday to Sunday."],
  }),
  message({
    subject: "Re: Apartment lease renewal",
    from: { name: "Oakridge Property", address: "leasing@oakridge.example.com" },
    date: days(3),
    isStarred: true,
    body: [
      "Hi Alex,",
      "Your lease ends on November 30. The renewal form is attached. Please sign and return it by November 15.",
      "Best regards,<br>Oakridge Property Management",
    ],
    attachments: [
      { filename: "lease-renewal-2027.pdf", mimeType: "application/pdf", size: 188_420 },
    ],
  }),
  message({
    subject: "[openmail-demo/app] Fix search ranking for quoted phrases (#482)",
    from: { name: "Jordan Lee", address: "notifications@git.example.com" },
    date: hours(77),
    labels: ["INBOX", "CATEGORY_UPDATES"],
    body: [
      "<b>jordan-lee</b> requested your review on this pull request.",
      "Quoted phrases now rank above loose matches. Adds tests for phrase and prefix queries.",
    ],
  }),
  message({
    subject: "Dinner on Friday",
    from: people.mia,
    date: days(4),
    body: ["Table for four at 7:30 is booked. See you there!", "Mia"],
  }),
  message({
    subject: "Flight confirmation: SFO → JFK, Nov 3",
    from: { name: "Example Air", address: "booking@air.example.com" },
    date: days(5),
    labels: ["INBOX", "Label_travel"],
    body: [
      "Confirmation code: QX7P2L",
      "Sun, Nov 3 · Depart SFO 07:15 · Arrive JFK 15:52 · Seat 14A",
    ],
  }),
];

const imap = [
  message({
    providerId: "1:101:INBOX",
    subject: "Board meeting notes and next steps",
    from: { name: "Elena Novak", address: "elena@example.org" },
    to: [work],
    date: hours(4),
    isUnread: true,
    body: [
      "Notes from today are attached. Two action items for you: the hiring plan and the Q1 budget draft.",
      "Elena",
    ],
    attachments: [
      {
        filename: "board-notes.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 64_210,
      },
    ],
  }),
  message({
    providerId: "1:102:INBOX",
    subject: "Volunteer schedule for the book fair",
    from: { name: "Community Library", address: "events@library.example.org" },
    to: [work],
    date: days(1),
    body: [
      "Thanks for signing up! You're on the Saturday 10:00 – 13:00 shift at the welcome desk.",
    ],
  }),
  message({
    providerId: "1:103:INBOX",
    subject: "Your domain renews in 30 days",
    from: { name: "Example Domains", address: "billing@domains.example.net" },
    to: [work],
    date: days(3),
    body: ["example.org renews automatically on November 12 for $12.00."],
  }),
];

const labels = [
  { id: "Label_projects", name: "Projects", color: "#4a86e8" },
  { id: "Label_receipts", name: "Receipts", color: "#16a766" },
  { id: "Label_newsletters", name: "Newsletters", color: "#a479e2" },
  { id: "Label_travel", name: "Travel", color: "#f691b2" },
];

const program = Effect.gen(function* () {
  const store = yield* Store;
  const google = yield* store.upsertAccount("gmail", me.address);
  yield* store.replaceLabels(google.id, labels);
  for (const m of gmail) yield* store.upsertMessage(google.id, m);
  // AI stays off by default in the app; the demo account opts in so the AI screens have content.
  yield* store.ai.setAccount({
    accountId: google.id,
    allowed: true,
    autoSummaries: false,
    autoTriage: true,
  });
  const other = yield* store.upsertAccount("imap", work.address);
  for (const m of imap) yield* store.upsertMessage(other.id, m);
  // An agent proposal waiting for approval, made the way the MCP modify_threads tool makes it:
  // with "Ask me first" on, an MCP agent's change becomes a proposal instead of running.
  const mailbox = yield* Mailbox;
  yield* mailbox.setAgentWriteMode("propose");
  yield* mailbox.organize.perform(
    {
      kind: "modify",
      threads: ["newsletter-rust", "newsletter-frontend", "newsletter-product"].map(
        (id) => `${google.id}/${id}`,
      ),
      op: { kind: "archive" },
    },
    {
      kind: "agent",
      surface: "mcp",
      name: "claude-code",
      rationale:
        "These three are newsletters. Archiving takes them out of the inbox and keeps them in All Mail.",
    },
  );
  yield* store.checkpoint;
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(TestMailbox({}, { backgroundFlush: false }, {}, Layer.empty, { database })),
    Effect.scoped,
  ),
);

// Screenshot-friendly preferences: English, no first-run prompts, nothing marked read by a glance.
const db = new DatabaseSync(database);
const pref = db.prepare(
  "INSERT INTO prefs(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
);
pref.run("language", '"en"');
pref.run("markReadDelay", '"manual"');
pref.run("defaultProfilesPrompted", "true");
pref.run("remoteImages", JSON.stringify("always"));
db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
const count = db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n;
db.close();
console.log(`Seeded ${String(count)} messages in 2 accounts at ${home}`);
