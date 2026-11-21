// Synthetic component-only fixture. No app connection, user session or model is opened.
import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { initI18n } from "../src/i18n";
import type { OutboxEntry } from "../src/lib/outbox";

await initI18n(new URLSearchParams(location.search).get("lang") ?? "en");
const { OutboxBubbles } = await import("../src/views/chat/OutboxBubbles");
const base = { text: "", images: [], at: 1, state: "sent" } as OutboxEntry;
const entries: OutboxEntry[] = [
  { ...base, id: "queued", text: "Please check the export next.", queued: true },
  { ...base, id: "accepted", text: "Keep the saved draft." },
  { ...base, id: "failed", text: "Review the updated section.", state: "failed", code: "codex_queue_failed", newId: true },
  { ...base, id: "cancelled", text: "A cancelled follow-up.", state: "failed", code: "codex_queue_cancelled", newId: true },
  { ...base, id: "unknown", text: "A request after reconnection.", state: "failed", code: "codex_queue_unknown", inDoubt: true },
  { ...base, id: "photo-queued", imageCount: 1, queued: true },
  { ...base, id: "photo-failed", imageCount: 1, state: "failed", code: "codex_queue_failed", newId: true },
];
createRoot(document.getElementById("root")!).render(<main className="mx-auto flex max-w-xl flex-col gap-6 p-4"><OutboxBubbles mid="fixture" sid="outbox" entries={entries} /></main>);
