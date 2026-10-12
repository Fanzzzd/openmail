/** Sample Downloads rows for screenshots of an unpackaged build (OPENMAIL_DEMO_DOWNLOADS=1); nothing is written. */
import type { DownloadItem } from "../../shared/downloads";

export const demoDownloads = (packaged: boolean, env: NodeJS.ProcessEnv) =>
  !packaged && env.OPENMAIL_DEMO_DOWNLOADS === "1";

const at = Date.UTC(2026, 9, 12, 9);
export const DEMO_DOWNLOADS: readonly DownloadItem[] = [
  {
    id: "demo-1",
    filename: "Q3 board deck.pdf",
    size: 8_400_000,
    received: 3_150_000,
    status: "writing",
    blocked: false,
    startedAt: at,
  },
  {
    id: "demo-2",
    filename: "site-photos.zip",
    size: 0,
    received: 0,
    status: "fetching",
    blocked: false,
    startedAt: at,
  },
  {
    id: "demo-3",
    filename: "Invoice 2026-104.pdf",
    size: 182_000,
    received: 182_000,
    status: "done",
    blocked: false,
    startedAt: at,
  },
  {
    id: "demo-4",
    filename: "install.command",
    size: 2_100,
    received: 2_100,
    status: "done",
    blocked: true,
    startedAt: at,
  },
  {
    id: "demo-5",
    filename: "budget.xlsx",
    size: 54_000,
    received: 0,
    status: "failed",
    failure: "fetch",
    blocked: false,
    startedAt: at,
  },
  {
    id: "demo-6",
    filename: "contract-signed.docx",
    size: 96_000,
    received: 96_000,
    status: "done",
    failure: "missing",
    blocked: false,
    startedAt: at,
  },
];
