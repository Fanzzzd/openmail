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
    body: "Three shortcut sets: Mimestream, Gmail and Apple Mail. Profiles group accounts, and the interface is available in ten languages.",
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
    body: "Message HTML renders in a sandbox with scripts disabled. Remote images stay blocked until you allow them, and known trackers are blocked.",
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="border-b border-fd-border bg-gradient-to-b from-fd-secondary/60 to-fd-background">
        <div className="mx-auto flex max-w-5xl flex-col items-center px-6 py-20 text-center">
          <img src="/logo.svg" alt="OpenMail app icon" width={96} height={96} className="mb-6" />
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            A local-first mail client for macOS
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-fd-muted-foreground">
            OpenMail syncs Gmail, personal Outlook and IMAP accounts into a database on your Mac.
            The app talks directly to your mail provider. There is no OpenMail server and no
            telemetry.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/docs"
              className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700"
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
