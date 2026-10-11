import type { ReactNode } from "react";
import { legalEffectiveDate } from "@/lib/site";

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <article className="prose">
        <h1>{title}</h1>
        <p className="text-fd-muted-foreground">Effective date: {legalEffectiveDate}</p>
        {children}
      </article>
    </main>
  );
}
