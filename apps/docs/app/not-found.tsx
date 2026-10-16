import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { Metadata } from "next";
import Link from "next/link";
import { baseOptions } from "@/lib/layout.shared";

export const metadata: Metadata = { title: "Page not found" };

/** Next renders this outside the (home) group, so it wraps itself in the same layout. */
export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-fd-muted-foreground">404</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Page not found</h1>
        <p className="mt-4 max-w-md text-fd-muted-foreground">
          This page does not exist or has moved. Use the search box in the header to find what you
          need.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/docs"
            className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
          >
            Read the docs
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-fd-border px-4 py-2 text-sm font-medium"
          >
            Go to the home page
          </Link>
        </div>
      </main>
    </HomeLayout>
  );
}
