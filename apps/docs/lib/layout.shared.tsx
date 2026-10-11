import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName } from "./site";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <img src="/logo.svg" alt="" width={24} height={24} />
          <span className="font-semibold">{appName}</span>
        </>
      ),
    },
    links: [
      { text: "Docs", url: "/docs", active: "nested-url" },
      { text: "Privacy", url: "/privacy" },
      { text: "Terms", url: "/terms" },
    ],
  };
}
