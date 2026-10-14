import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { appName, contactEmail, socialMetadata } from "@/lib/site";

const description =
  "What data OpenMail handles, where it is stored, and which servers the app contacts.";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description,
  ...socialMetadata({ title: `Privacy Policy | ${appName}`, description, path: "/privacy" }),
};

const googleScopes: { scope: string; when: string; why: string }[] = [
  {
    scope: "https://www.googleapis.com/auth/gmail.modify",
    when: "Every Gmail account",
    why: "Read and sync your messages, labels and drafts. Apply the changes you make in the app: mark read, star, label, archive, move to Trash, save drafts. Read your send-as addresses and signatures.",
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.send",
    when: "Every Gmail account",
    why: "Send the messages you write and confirm in the app.",
  },
  {
    scope: "https://www.googleapis.com/auth/contacts.readonly",
    when: "Only if you connect Contacts",
    why: "Suggest addresses from your saved Google contacts while you write.",
  },
  {
    scope: "https://www.googleapis.com/auth/contacts.other.readonly",
    when: "Only if you connect Contacts",
    why: "Suggest addresses from Google's “Other contacts” list while you write.",
  },
  {
    scope: "https://www.googleapis.com/auth/calendar.events",
    when: "Only if you connect Calendar",
    why: "Find the calendar event for an invitation you received, record your accept, tentative or decline answer, and show conflicting events.",
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.settings.basic",
    when: "Only if you connect Gmail settings",
    why: "Create, edit and delete Gmail filters and change your vacation auto-reply when you ask the app to.",
  },
  {
    scope: "https://mail.google.com/",
    when: "Only when you first permanently delete mail or empty Trash",
    why: "Permanently delete messages. The gmail.modify scope cannot do this.",
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        OpenMail is a mail client that runs on your Mac. This policy explains what data the app
        handles, where it is stored, and which servers it contacts. It also covers this website.
      </p>

      <h2>Summary</h2>
      <ul>
        <li>Your mail, attachments and search index are stored only on your device.</li>
        <li>Refresh tokens and passwords are stored only in the macOS Keychain.</li>
        <li>
          There is no OpenMail server. The developer never receives your mail, contacts, calendar
          data or credentials.
        </li>
        <li>OpenMail has no analytics, telemetry, crash reporting or advertising.</li>
        <li>
          The app talks to your mail provider, and to other services only for features you turn on.
          Every one is listed below.
        </li>
      </ul>

      <h2>Who we are</h2>
      <p>
        OpenMail is developed by an independent developer, referred to here as “we”. You can reach
        us at <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>

      <h2>Data stored on your device</h2>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Where it is stored</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              Messages, attachments, labels and folders, drafts, cached contacts, the search index,
              on-device OCR and semantic index, AI summaries and suggestions, settings
            </td>
            <td>
              A database and files in <code>~/Library/Application Support/openmail</code> on your
              Mac
            </td>
          </tr>
          <tr>
            <td>
              OAuth refresh tokens, IMAP and SMTP passwords, your Anthropic API key, and the GitHub
              access token used for updates if you save one
            </td>
            <td>The macOS Keychain</td>
          </tr>
          <tr>
            <td>The OAuth client ID and secret, if you register your own client</td>
            <td>
              <code>config.json</code> in the same folder, readable only by your user account
            </td>
          </tr>
          <tr>
            <td>A diagnostics log</td>
            <td>
              The same folder. It holds fixed fields only: time, provider, HTTP method, endpoint
              template, status code, failure category and a hashed account ID. It contains no
              message content, addresses, full URLs or tokens. It is never uploaded. The Feedback
              window lets you attach it to an email that you send yourself.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Refresh tokens are never written to the database or to logs. OpenMail does not turn on
        Electron's crash reporter.
      </p>

      <h2>Servers the app contacts</h2>
      <p>OpenMail connects only to the following, and only for the purposes listed.</p>
      <ul>
        <li>
          <strong>Google</strong>, for Gmail accounts: <code>accounts.google.com</code> and{" "}
          <code>oauth2.googleapis.com</code> for sign-in, <code>gmail.googleapis.com</code> for
          mail, and, if you connect them, <code>www.googleapis.com</code> for Calendar and{" "}
          <code>people.googleapis.com</code> for Contacts. Contact photos load from{" "}
          <code>googleusercontent.com</code> when you have connected Contacts and photo display is
          on.
        </li>
        <li>
          <strong>Microsoft</strong>, for Outlook accounts: <code>login.microsoftonline.com</code>{" "}
          for sign-in and <code>graph.microsoft.com</code> for mail, and, if you connect them,
          contacts and calendar.
        </li>
        <li>
          <strong>Your IMAP and SMTP servers</strong>, for IMAP accounts, always over TLS.
        </li>
        <li>
          <strong>Anthropic</strong> (<code>api.anthropic.com</code>), only if you save an API key
          and allow an account to use AI. See <a href="#ai-features">AI features</a>.
        </li>
        <li>
          <strong>Senders' servers.</strong> Remote images in a message load from the sender's
          servers, which can see when you open the message and your IP address. By default images
          load and known tracking pixels are blocked. You can choose to load images only from people
          you know, or to ask each time. If you confirm a one-click unsubscribe, OpenMail sends one
          HTTPS request to the address the sender published for that purpose.
        </li>
        <li>
          <strong>Hugging Face</strong> (<code>huggingface.co</code>), only if you turn on on-device
          models in indexing settings. OpenMail downloads model files from there. No mail data is
          sent. Indexing then runs on your Mac.
        </li>
        <li>
          <strong>GitHub</strong> (<code>api.github.com</code>, <code>github.com</code> and GitHub's
          release file hosts), only in Developer ID signed builds. OpenMail checks for and downloads
          new versions there from the public repository, without a GitHub account or token. No mail
          data is sent.
        </li>
      </ul>
      <p>
        These requests, like any network request, reveal your IP address to the server receiving
        them. Links you click in a message open in your web browser.
      </p>
      <p>
        If you connect an MCP client, such as Claude Desktop, to the OpenMail MCP server, that
        client can read mail from the accounts you allowed for AI. What the client does with it is
        governed by that client and its provider. The MCP server is read-only by default and cannot
        send mail.
      </p>
      <p>
        If you turn on remote access, OpenMail on your Mac serves your mail to browsers on your own
        devices. The data goes from your Mac to those devices over your Tailscale network, encrypted
        end to end by WireGuard. It does not pass through OpenMail servers. Tailscale's coordination
        server sees which of your devices connect, but not your mail. Remote access is off by
        default and never uses Tailscale Funnel, so it is not reachable from the public internet.
      </p>

      <h2 id="ai-features">AI features</h2>
      <p>
        AI features are off by default. To use them you provide your own Anthropic API key and turn
        on “Allow AI to read this account” for each account. When you then use a feature, or turn on
        automatic summaries or triage suggestions for that account, OpenMail sends your question and
        the relevant message text, subjects, and sender and recipient addresses from your Mac
        directly to Anthropic using your key. It does not send message HTML, images, attachment
        files, or text extracted from images and PDFs. Anthropic processes that data under its own
        terms and privacy policy. We never receive it.
      </p>
      <p>
        Turning off an account's AI permission deletes the AI results stored for it on your Mac.
      </p>

      <h2>Google user data</h2>
      <p>
        When you add a Gmail account, Google asks you to grant OpenMail access. OpenMail requests
        the following scopes. Optional scopes are requested only when you turn on the feature that
        needs them.
      </p>
      <table>
        <thead>
          <tr>
            <th>Scope</th>
            <th>When requested</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {googleScopes.map((item) => (
            <tr key={item.scope}>
              <td>
                <code>{item.scope}</code>
              </td>
              <td>{item.when}</td>
              <td>{item.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        OpenMail's use and transfer to any other app of information received from Google APIs will
        adhere to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. In particular:
      </p>
      <ul>
        <li>
          OpenMail uses Google user data only to provide the mail, contacts and calendar features
          you see in the app.
        </li>
        <li>
          Google user data stays on your device. It is transferred to a third party only when you
          ask for it: to Anthropic when you use an AI feature on an account you allowed, or to an
          MCP client you connected yourself.
        </li>
        <li>
          OpenMail does not use Google user data for advertising, does not sell it, and does not use
          it to build user profiles.
        </li>
        <li>
          OpenMail does not use Google user data to develop, improve or train generalized AI or
          machine learning models.
        </li>
        <li>No person working on OpenMail reads your Google user data. We do not receive it.</li>
      </ul>

      <h2>Microsoft account data</h2>
      <p>
        For Outlook accounts OpenMail requests <code>Mail.ReadWrite</code>, <code>Mail.Send</code>,{" "}
        <code>User.Read</code>, <code>offline_access</code> and{" "}
        <code>MailboxSettings.ReadWrite</code>, and optionally <code>Contacts.Read</code>,{" "}
        <code>People.Read</code> and <code>Calendars.ReadWrite</code>. The same rules apply: the
        data stays on your device and is used only for the features you use.
      </p>

      <h2>Sharing and sale</h2>
      <p>
        We do not sell, rent or share your data. We do not receive it in the first place, so we have
        nothing to share.
      </p>

      <h2>Retention and deletion</h2>
      <ul>
        <li>Data stays on your Mac until you delete it.</li>
        <li>
          Removing an account in Settings deletes its local mail, attachments and Keychain entry.
          Mail on your provider's server is not affected.
        </li>
        <li>
          To revoke OpenMail's access at the provider, use{" "}
          <a href="https://myaccount.google.com/permissions">Google account permissions</a> or{" "}
          <a href="https://account.live.com/consent/Manage">Microsoft account consent</a>.
        </li>
        <li>
          To remove everything, delete the app, the folder{" "}
          <code>~/Library/Application Support/openmail</code>, and the OpenMail entries in Keychain
          Access.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Connections to mail providers and AI services use TLS. Credentials are kept in the macOS
        Keychain. Message HTML is displayed in a sandbox without scripts. Details are in the{" "}
        <Link href="/docs/security">security model</Link>.
      </p>

      <h2>Children</h2>
      <p>OpenMail is not directed to children under 13.</p>

      <h2>This website</h2>
      <p>
        This website is a static site. It sets no cookies and runs no analytics. Your browser's
        local storage remembers your light or dark theme choice. The hosting provider, Vercel,
        processes requests to serve the site and may keep server logs, including IP addresses, for
        operation and security.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes, we will update this page and its effective date. If OpenMail starts
        handling data in a new way, the policy will say so before the app does it.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy: <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>
    </LegalPage>
  );
}
