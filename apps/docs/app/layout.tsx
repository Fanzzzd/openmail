import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/footer";
import { Provider } from "@/components/provider";
import { appName, siteDescription, siteUrl, socialMetadata } from "@/lib/site";
import "./global.css";

// Google Search Console: set NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION to the token from the
// HTML tag method; Next renders it as <meta name="google-site-verification">.
const googleSiteVerification = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION?.trim();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: appName, template: `%s | ${appName}` },
  description: siteDescription,
  applicationName: appName,
  ...socialMetadata({ title: appName, description: siteDescription, path: "/" }),
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
