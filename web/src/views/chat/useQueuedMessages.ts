import { useEffect } from "react";
import type { OutboxEntry } from "../../lib/outbox";

/** Only local desktop queues need a status read. Reconnect/foreground reads immediately; quiet waits share one read. */
export function useQueuedMessages(mid: string, sid: string, entries: OutboxEntry[], online: boolean) {
  const ids = entries.filter((e) => !e.queueReceipt?.echoLine && ["queued", "unknown", "delivered"].includes(e.queueReceipt?.state ?? "")).map((e) => e.id).sort().join("/");
  useEffect(() => {
    if (!ids || !online) return;
    let mounted = true;
    let stop: (() => void) | undefined;
    // The watcher and queue decoder are needed only while this page has an unresolved desktop queue.
    void import("../../lib/outbox-receipt").then(({ watchQueuedMessages }) => {
      if (mounted) stop = watchQueuedMessages(mid, sid);
    });
    return () => { mounted = false; stop?.(); };
  }, [mid, sid, ids, online]);
}
