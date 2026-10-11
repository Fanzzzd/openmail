import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/footer";
import { Provider } from "@/components/provider";
import { appName } from "@/lib/site";
import "./global.css";

// Google Search Console: set NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION to the token from the
// HTML tag method; Next renders it as <meta name="google-site-verification">.
const googleSiteVerification = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION?.trim();

export const metadata: Metadata = {
  title: { default: appName, template: `%s | ${appName}` },
  description:
    "OpenMail is a local-first mail client for macOS. It works with Gmail, personal Outlook accounts and IMAP, and keeps your mail on your Mac.",
  applicationName: appName,
  ...(googleSiteVerification ? { verification: { google: googleSiteVerification } } : {}),
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>
          {children}
          <SiteFooter />
        </Provider>
      </body>
    </html>
  );
}
