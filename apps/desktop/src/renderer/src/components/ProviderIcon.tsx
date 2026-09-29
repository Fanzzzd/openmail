import GmailIcon from "~icons/logos/google-gmail";
import FastmailIcon from "~icons/selfhst/fastmail";
import ICloudIcon from "~icons/selfhst/icloud";
import OutlookIcon from "~icons/selfhst/microsoft-outlook";
import YahooIcon from "~icons/selfhst/yahoo";
import QQIcon from "~icons/thesvg-color/qq";
import { Mail } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

export type ProviderIconName =
  | "gmail"
  | "outlook"
  | "icloud"
  | "yahoo"
  | "qq"
  | "163"
  | "fastmail"
  | "imap";

type Svg = ComponentType<SVGProps<SVGSVGElement>>;

// Brand marks from Iconify packages; sources and licenses in docs/design/icons.md.
const ICONS = new Map<string, { icon: Svg; label: string }>([
  ["gmail", { icon: GmailIcon, label: "Gmail" }],
  ["outlook", { icon: OutlookIcon, label: "Outlook" }],
  ["icloud", { icon: ICloudIcon, label: "iCloud" }],
  ["yahoo", { icon: YahooIcon, label: "Yahoo" }],
  ["qq", { icon: QQIcon, label: "QQ 邮箱" }],
  ["fastmail", { icon: FastmailIcon, label: "Fastmail" }],
]);

/** NetEase has no mark in any open icon set; its app icon is a red square with "163". */
function NetEase({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <title>163 邮箱</title>
      <rect width="24" height="24" rx="5.5" fill="#D8262E" />
      <text
        x="12"
        y="15.6"
        textAnchor="middle"
        fontSize="9.5"
        fontWeight="700"
        fontFamily="-apple-system, system-ui, sans-serif"
        fill="#fff"
      >
        163
      </text>
    </svg>
  );
}

export function ProviderIcon({
  provider,
  className = "size-4 shrink-0",
}: {
  // Also takes a raw IMAP preset id (a plain string in core, e.g. "custom");
  // anything unknown gets a generic envelope.
  provider: ProviderIconName | (string & {});
  className?: string;
}) {
  if (provider === "163") return <NetEase className={className} />;
  const entry = ICONS.get(provider);
  if (!entry) return <Mail className={`${className} text-neutral-500`} aria-label="IMAP" />;
  const Icon = entry.icon;
  return <Icon className={className} aria-label={entry.label} />;
}
