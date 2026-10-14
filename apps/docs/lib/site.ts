import type { Metadata } from "next";

export const appName = "OpenMail";
export const repoUrl = "https://github.com/Fanzzzd/openmail";
export const contactEmail = "klausfanzd@gmail.com";
export const legalEffectiveDate = "October 11, 2026";

/** Production origin. Open Graph, the sitemap and robots.txt need absolute URLs. */
export const siteUrl = "https://openmail-docs.vercel.app";
export const siteDescription =
  "OpenMail is a local-first mail client for macOS. It works with Gmail, personal Outlook accounts and IMAP, and keeps your mail on your Mac.";

/** 1200x630 crop of docs/media/hero.png. */
const ogImage = {
  url: "/media/og.png",
  width: 1200,
  height: 630,
  alt: "OpenMail inbox with a conversation open",
};

/**
 * Open Graph and Twitter card tags for one page. Next replaces a parent's openGraph
 * object instead of merging it, so every page with its own title sets all fields.
 */
export function socialMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Pick<Metadata, "alternates" | "openGraph" | "twitter"> {
  return {
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: appName,
      locale: "en_US",
      title,
      description,
      url: path,
      images: [ogImage],
    },
    twitter: { card: "summary_large_image", title, description, images: [ogImage] },
  };
}
