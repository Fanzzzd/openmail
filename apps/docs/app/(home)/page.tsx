import Link from "next/link";
import type { ReactNode } from "react";

const features: { title: string; href: string; body: ReactNode }[] = [
  {
    title: "Accounts",
    href: "/docs/accounts",
    body: "Gmail, personal Outlook accounts (outlook.com, hotmail.com, live.com), iCloud, Yahoo, QQ, 163, Fastmail and any IMAP/SMTP server. Work and school Microsoft 365 accounts are not supported.",
  },
  {
    title: "Sync and organize",
    href: "/docs",
    body: "Incremental sync, an offline change queue, undo history that survives a restart, snooze, labels and nested folders, Gmail categories, server filters and auto-replies.",
  },
  {
    title: "Compose",
    href: "/docs",
    body: "Drafts sync with the server. Write in rich text, plain text or Markdown. Undo send for up to 30 seconds, templates, named signatures, send-as addresses and contact completion.",
  },
  {
    title: "Read and search",
    href: "/docs",
    body: "Conversation and single-message views. Local full-text search with boolean, phrase, date and size operators, plus optional server search. Optional on-device OCR, PDF text and semantic search.",
  },
  {
    title: "Keyboard first",
    href: "/docs/keyboard-shortcuts",
    body: "Three shortcut sets: Mimestream, Gmail and Apple Mail. Spaces group accounts, and the interface is available in ten languages.",
  },
  {
    title: "AI, off by default",
    href: "/docs/ai",
    body: "With your own Anthropic API key and per-account permission: summaries, a mail assistant, rewrite and translate in compose, and inbox triage suggestions.",
  },
  {
    title: "CLI and MCP",
    href: "/docs/cli-and-mcp",
    body: "A command line tool and an MCP server read the same local database. MCP is read-only by default. Write tools only create proposals, and sending always needs your confirmation in the app.",
  },
  {
    title: "Safe reading",
    href: "/docs/security",
    body: "Message HTML renders in a sandbox with scripts disabled. You choose when remote images load, and known trackers are blocked in every setting.",
  },
];

const shots: { src: string; alt: string }[] = [
  {
    src: "/media/search.webp",
    alt: "Search results for has:attachment with the matching message open",
  },
  {
    src: "/media/settings.webp",
    alt: "Settings, AI Access: connect Claude Code, Codex and Claude, read-only by default",
  },
  { src: "/media/compose.webp", alt: "Composer with rich text and Write with AI" },
  { src: "/media/dark.webp", alt: "Dark mode with an HTML newsletter open" },
];

const REPO = "https://github.com/Fanzzzd/openmail";

const approval: { title: string; body: string }[] = [
  {
    title: "Per-account consent.",
    body: "An agent sees an account only after you turn on Allow AI to read this account for it. OpenMail checks this on every tool call.",
  },
  {
    title: "Read-only by default.",
    body: "MCP tools read and search mail. The permission to change mail starts at Read only, which makes every write tool refuse.",
  },
  {
    title: "Proposals.",
    body: "With Ask me first, modify_threads, snooze_threads and draft_message create proposals. Each one waits in AI suggestions until you approve or reject it.",
  },
  {
    title: "No agent sends mail.",
    body: "A drafted message opens in the composer, and you send it yourself.",
  },
];

const products = ["OpenMail", "Mimestream", "Spark", "Thunderbird", "Apple Mail"] as const;
const comparison: { label: string; cells: readonly [string, string, string, string, string] }[] = [
  { label: "Source", cells: ["Open (MIT)", "Closed", "Closed", "Open (MPL 2.0)", "Closed"] },
  {
    label: "Price",
    cells: ["Free", "Paid subscription", "Free, with paid plans", "Free", "Included with macOS"],
  },
  {
    label: "Platforms",
    cells: [
      "macOS (mobile in development)",
      "macOS",
      "macOS, iOS, Android, Windows",
      "Windows, macOS, Linux, Android",
      "macOS, iOS, iPadOS",
    ],
  },
  {
    label: "Gmail",
    cells: ["Yes (Gmail API)", "Yes (Gmail API)", "Yes", "Yes (IMAP)", "Yes (IMAP)"],
  },
  { label: "Personal Outlook", cells: ["Yes (Microsoft Graph)", "No", "Yes", "Yes", "Yes"] },
  { label: "Other IMAP", cells: ["Yes", "No", "Yes", "Yes", "Yes"] },
  {
    label: "Mail path through a vendor's server",
    cells: ["No", "No", "Yes, for some features", "No", "No"],
  },
  { label: "Maturity", cells: ["Early testing", "Mature", "Mature", "Mature", "Mature"] },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="border-b border-fd-border bg-gradient-to-b from-fd-secondary/60 to-fd-background">
        <div className="mx-auto flex max-w-5xl flex-col items-center px-6 py-20 text-center">
          <img src="/logo.svg" alt="OpenMail app icon" width={96} height={96} className="mb-6" />
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Your mail on your Mac, readable by the agents you allow
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-fd-muted-foreground">
            OpenMail keeps your mail in a SQLite database on your Mac. The app, a CLI and an MCP
            server all use that one database. AI agents such as Claude Code and Codex can read the
            accounts you allow. When an agent wants to change your mail, OpenMail turns the change
            into a proposal, and nothing happens until you approve it in the app.
          </p>
          <p className="mt-3 max-w-2xl text-fd-muted-foreground">
            It syncs Gmail, personal Outlook and IMAP accounts and talks directly to your mail
            provider. There is no OpenMail server and no telemetry.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <a
              href={REPO}
              className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700"
            >
              Star on GitHub
            </a>
            <Link
              href="/docs"
              className="rounded-lg border border-fd-border px-5 py-2.5 font-medium hover:bg-fd-accent"
            >
              Read the docs
            </Link>
            <Link
              href="/privacy"
              className="rounded-lg border border-fd-border px-5 py-2.5 font-medium hover:bg-fd-accent"
            >
              Privacy policy
            </Link>
          </div>
          <p className="mt-6 text-sm text-fd-muted-foreground">
            OpenMail is in early testing. There is no public download yet.
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pt-12">
        <img
          src="/media/hero.webp"
          alt="OpenMail inbox with a conversation open"
          width={1440}
          height={900}
          className="w-full rounded-xl border border-fd-border shadow-lg"
        />
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {shots.map((shot) => (
            <img
              key={shot.src}
              src={shot.src}
              alt={shot.alt}
              width={1440}
              height={900}
              loading="lazy"
              className="w-full rounded-lg border border-fd-border"
            />
          ))}
        </div>
        <p className="mt-3 text-center text-sm text-fd-muted-foreground">
          Screenshots use fake demo mail.
        </p>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pt-16">
        <h2 className="text-2xl font-semibold">AI agents, with your approval</h2>
        <p className="mt-3 max-w-3xl text-fd-muted-foreground">
          Here Claude Code asked over MCP to archive three newsletters. OpenMail listed the request
          under AI suggestions with the agent's reason. The newsletters left the inbox only after
          Approve.
        </p>
        <img
          src="/media/approval-flow.webp"
          alt="An agent proposes archiving three newsletters; the user approves it in OpenMail"
          width={1200}
          height={750}
          className="mt-6 w-full rounded-xl border border-fd-border shadow-lg"
        />
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {approval.map((item) => (
            <li key={item.title} className="text-fd-muted-foreground">
              <strong className="text-fd-foreground">{item.title}</strong> {item.body}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-fd-muted-foreground">
          The{" "}
          <Link href="/docs/cli-and-mcp" className="underline">
            CLI and MCP
          </Link>{" "}
          page lists every tool and the approval rules.
        </p>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 py-16">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <Link
              key={feature.title}
              href={feature.href}
              className="rounded-xl border border-fd-border bg-fd-card p-5 transition-colors hover:border-blue-600/50"
            >
              <h2 className="mb-2 font-semibold">{feature.title}</h2>
              <p className="text-sm text-fd-muted-foreground">{feature.body}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-16">
        <h2 className="text-2xl font-semibold">How it compares</h2>
        <div className="mt-6 overflow-x-auto rounded-xl border border-fd-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-fd-secondary/60">
              <tr>
                <th scope="col" className="p-3">
                  <span className="sr-only">Feature</span>
                </th>
                {products.map((product) => (
                  <th key={product} scope="col" className="p-3 font-semibold">
                    {product}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr key={row.label} className="border-t border-fd-border">
                  <th scope="row" className="p-3 font-medium">
                    {row.label}
                  </th>
                  {row.cells.map((cell, index) => (
                    <td
                      key={products[index]}
                      className={index === 0 ? "p-3 font-medium" : "p-3 text-fd-muted-foreground"}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-fd-muted-foreground">
          OpenMail is younger than all of these and has rough edges. The table reflects the
          products' public pages as of October 2026. If a cell is wrong, please{" "}
          <a href={`${REPO}/issues`} className="underline">
            open an issue
          </a>
          .
        </p>
      </section>

      <section className="border-t border-fd-border bg-fd-secondary/40">
        <div className="mx-auto flex max-w-5xl flex-col items-center px-6 py-14 text-center">
          <h2 className="text-2xl font-semibold">Built in the open</h2>
          <p className="mt-3 max-w-2xl text-fd-muted-foreground">
            OpenMail is MIT-licensed. The source, issues and releases are on GitHub. Star the
            repository to follow releases, and open an issue when something breaks.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a
              href={REPO}
              className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700"
            >
              Star Fanzzzd/openmail on GitHub
            </a>
            <a
              href={`${REPO}/issues`}
              className="rounded-lg border border-fd-border px-5 py-2.5 font-medium hover:bg-fd-accent"
            >
              Report an issue
            </a>
          </div>
        </div>
      </section>

      <section className="border-t border-fd-border">
        <div className="mx-auto grid max-w-5xl gap-10 px-6 py-16 md:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold">Where your data lives</h2>
            <p className="mt-3 text-fd-muted-foreground">
              Mail, attachments and the search index stay in a database on your Mac. Sign-in tokens,
              IMAP passwords and API keys go into the macOS Keychain.
            </p>
          </div>
          <ul className="space-y-3 text-fd-muted-foreground">
            <li>
              <strong className="text-fd-foreground">Your mail provider.</strong> Google, Microsoft
              or your IMAP/SMTP server, using the permissions you approve on their sign-in page.
            </li>
            <li>
              <strong className="text-fd-foreground">Anthropic, only if you turn on AI.</strong>{" "}
              Message text for the accounts you allow, sent with your own API key.
            </li>
            <li>
              <strong className="text-fd-foreground">Nothing else by default.</strong> Optional
              features that reach other servers are listed in the{" "}
              <Link href="/privacy" className="underline">
                privacy policy
              </Link>
              .
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
