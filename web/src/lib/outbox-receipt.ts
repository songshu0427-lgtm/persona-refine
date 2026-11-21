// Read-only operation receipt decoding is needed only after Check receives an answer.
import { ApiError, sessionPath } from "./api";
import { t } from "../i18n";
import { failureText, outboxEntry, type DeliveryReply, type OutboxCheck, type OutboxEntry } from "./outbox";
import { toast } from "../ui/atoms";
import { refreshCodexQueue } from "./codex-queue";

/** Read only while visible; reconnect mounts a fresh watcher and reads immediately. */
export function watchQueuedMessages(mid: string, sid: string): () => void {
  const check = () => {
    if (document.visibilityState !== "hidden") void refreshCodexQueue(mid, sid);
  };
  check();
  const timer = setInterval(check, 5000);
  document.addEventListener("visibilitychange", check);
  return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); };
}

/** Delivery explanations load only after acceptance; they never change the send's outcome. */
export function showDeliveryNotice(reply: DeliveryReply & { waits_on_computer?: boolean }) {
  if (reply.waits_on_computer) toast(t("lib-outbox.waits_on_computer"), "info");
  if (reply.delivered_as !== "relayed") return;
  switch (reply.relay_reason) {
    case "busy": toast(t("lib-outbox.relayed_busy"), "info"); break;
    case "plugin_unavailable":
    case "plugin_refused":
    case "plugin_unconfirmed": toast(t("lib-outbox.relayed_plugin"), "info"); break;
  }
}

export interface ClientOperation {
  id?: string;
  kind?: string;
  target?: { path?: string };
  state?: string;
  result?: { status?: number; body?: string };
}

function operationFailure(op: ClientOperation): Pick<OutboxEntry, "error" | "code"> {
  const saved = op.result;
  if (saved?.body && typeof saved.status === "number") {
    try {
      const bytes = Uint8Array.from(atob(saved.body), (c) => c.charCodeAt(0));
      const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const message = typeof body.error === "string" && body.error ? body.error : `HTTP ${saved.status}`;
      const err = new ApiError(saved.status, message, body);
      return { error: failureText(err), code: err.code };
    } catch { /* Fall back to the receipt's authoritative failure state. */ }
  }
  return { error: t("lib-outbox.delivery_failed"), code: undefined };
}

export function receiptOutcome(op: ClientOperation, mid: string, sid: string, id: string): { result: OutboxCheck; patch?: Partial<OutboxEntry> } {
  // Go stores the decoded URL path. Never decode it again: literal percent escapes are valid session IDs.
  const decoded = `/api/v1/sessions/${mid}/${sid}/messages`, encoded = `/api/v1${sessionPath(mid, sid)}/messages`;
  if (op.id?.toLowerCase() !== id.toLowerCase() || op.kind !== "message" || (op.target?.path !== decoded && op.target?.path !== encoded)) return { result: "unknown" };
  if (op.state === "done") return { result: "applied", patch: { state: "sent", acceptedAt: Date.now(), error: undefined, code: undefined, clearable: undefined, newId: undefined, inDoubt: undefined } };
  if (op.state === "failed") return { result: "not_applied", patch: { inDoubt: false, newId: true, ...operationFailure(op) } };
  return { result: "unknown" };
}

/** Recovery-only reconciliation; the caller owns immediate request dispatch, single-flight and its identity guard. */
export async function checkReceipt(mid: string, sid: string, id: string, request: Promise<ClientOperation | undefined> | undefined,
  current: () => boolean, rechecks: () => Iterable<() => void>, apply: (patch: Partial<OutboxEntry>) => void): Promise<OutboxCheck> {
  const reread = () => {
    if (!current()) return;
    // Snapshot the current registrations: a replacement view receives a read begun before navigation.
    for (const recheck of [...rechecks()]) {
      try { recheck(); } catch { /* A closed view must not prevent the other views from refreshing. */ }
    }
  };
  if (!current()) return "stale";
  if (!request) {
    reread();
    if (!current()) return "stale";
    const results = await refreshCodexQueue(mid, sid);
    return results.get(id) ?? (outboxEntry(mid, sid, id) ? "unknown" : "stale");
  }
  const op = await request;
  if (!current()) return "stale";
  // Missing receipts, including 404s, prove nothing; the ordinary transcript refresh may still find an echo.
  const { result, patch } = op ? receiptOutcome(op, mid, sid, id) : { result: "unknown" as const };
  reread();
  if (patch) {
    if (!current()) return "stale";
    apply(patch);
  }
  return result;
}
