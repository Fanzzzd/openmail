import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { contactEmail } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Terms for using the OpenMail app and website.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        These terms apply to the OpenMail app, its command line tool and MCP server, and this
        website. By using them you agree to these terms.
      </p>

      <h2>The software</h2>
      <p>
        OpenMail is provided free of charge. It runs on your device and connects to the mail
        accounts and services you set up. How it handles your data is described in the{" "}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>Your accounts</h2>
      <ul>
        <li>
          You are responsible for the accounts you add to OpenMail and for keeping access to your
          Mac secure.
        </li>
        <li>Only add accounts that you own or are authorized to use.</li>
        <li>
          Your use of Gmail, Outlook, your IMAP provider and Anthropic remains subject to their own
          terms. You are responsible for any charges from those services, including Anthropic API
          usage billed to your key.
        </li>
        <li>
          Do not use OpenMail to send spam or to break the law or the terms of your mail provider.
        </li>
      </ul>

      <h2>AI and agents</h2>
      <p>
        AI output can be wrong. Review summaries, suggestions and drafts before you rely on them.
        OpenMail requires your confirmation before sending any message an assistant or MCP client
        drafted, and you are responsible for what you send.
      </p>

      <h2>No warranty</h2>
      <p>
        OpenMail is provided “as is” and “as available”, without warranty of any kind, express or
        implied, including warranties of merchantability, fitness for a particular purpose and
        non-infringement. We do not guarantee that it will be free of errors, that it will not lose
        or alter data, or that it will keep working with any mail provider. Keep your own backups of
        anything important.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the extent permitted by law, we are not liable for any indirect, incidental, special or
        consequential damages, or for any loss of data, messages, profits or business, arising from
        your use of OpenMail or this website.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. The effective date at the top of this page shows when they last
        changed. Continuing to use OpenMail after a change means you accept the new terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>
    </LegalPage>
  );
}
