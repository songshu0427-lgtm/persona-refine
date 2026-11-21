// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { OutboxEntry } from "../../lib/outbox";
vi.mock("../../lib/codex-queue", async (actual) => ({ ...await actual<typeof import("../../lib/codex-queue")>(), refreshCodexQueue: vi.fn(async () => new Map()) }));
import { refreshCodexQueue } from "../../lib/codex-queue";
import { useQueuedMessages } from "./useQueuedMessages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const entries: OutboxEntry[] = [{ id: "queued", text: "Fixture", images: [], at: 1, state: "sent", queued: true, queueReceipt: { state: "queued" } }];
function Probe({ online, messages = entries }: { online: boolean; messages?: OutboxEntry[] }) { useQueuedMessages("m", "s", messages, online); return null; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(refreshCodexQueue).mockClear(); });

it("checks immediately on mount/reconnect/foreground, shares a timer, and stops on echo or unmount", async () => {
  vi.useFakeTimers();
  const root = createRoot(document.createElement("div"));
  const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  try {
    await act(async () => root.render(<Probe online />));
    await act(async () => vi.dynamicImportSettled());
    expect(refreshCodexQueue).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(5000));
    await act(async () => vi.dynamicImportSettled());
    expect(refreshCodexQueue).toHaveBeenCalledTimes(2);
    visible.mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTime(5000));
    expect(refreshCodexQueue).toHaveBeenCalledTimes(2);
    visible.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.dynamicImportSettled());
    expect(refreshCodexQueue).toHaveBeenCalledTimes(3);
    await act(async () => root.render(<Probe online={false} />));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(refreshCodexQueue).toHaveBeenCalledTimes(3);
    await act(async () => root.render(<Probe online />));
    await act(async () => vi.dynamicImportSettled());
    expect(refreshCodexQueue).toHaveBeenCalledTimes(4);
    await act(async () => root.render(<Probe online messages={entries.map(e => ({ ...e, queueReceipt: { state: "delivered", echoLine: "fixture#0" } }))} />));
    await act(async () => vi.advanceTimersByTime(5000));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(refreshCodexQueue).toHaveBeenCalledTimes(4);
    await act(async () => root.render(<Probe online messages={[]} />));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(refreshCodexQueue).toHaveBeenCalledTimes(4);
  } finally { await act(async () => root.unmount()); }
});
