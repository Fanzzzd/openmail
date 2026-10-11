import Link from "next/link";
import { appName, contactEmail } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-fd-border text-sm text-fd-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6">
        <span>{appName}</span>
        <Link href="/docs" className="hover:text-fd-foreground">
          Docs
        </Link>
        <Link href="/privacy" className="hover:text-fd-foreground">
          Privacy
        </Link>
        <Link href="/terms" className="hover:text-fd-foreground">
          Terms
        </Link>
        <a href={`mailto:${contactEmail}`} className="hover:text-fd-foreground">
          {contactEmail}
        </a>
      </div>
    </footer>
  );
}
