// Desktop Codex queues are independent of session work/interrupt and of the HTTP send receipt.
import { api, credentialOwner, getToken, sessionPath } from "./api";
import { managerHeaderFor } from "./manager-choice";
import { getState } from "./store";
import { outboxKey, updateQueueReceipt, type OutboxCheck, type OutboxEntry } from "./outbox";
import { t } from "../i18n";

type QueueState = NonNullable<OutboxEntry["queueReceipt"]>["state"];
interface QueueMessage { client_msg_id: string; state: QueueState; at: string; delivered?: string; echo_line?: string }
interface QueueInfo { codex_desktop_queue?: { version?: number; messages?: QueueMessage[] } }
const checks = new Map<string, Promise<Map<string, OutboxCheck>>>();
export const needsQueueCheck = (e: OutboxEntry) => !e.queueReceipt?.echoLine && (e.queueReceipt?.state === "queued" || e.queueReceipt?.state === "unknown" || e.queueReceipt?.state === "delivered");
const terminal = (state?: QueueState) => state === "delivered" || state === "failed" || state === "cancelled";

/** Queue-only reasons and their catalog stay off the cold first screen. */
export function queueReason(e: Pick<OutboxEntry, "code">): string | undefined {
  if (e.code === "codex_queue_cancelled") return t("chat-codexqueue.cancelled");
  if (e.code === "codex_queue_failed") return t("chat-codexqueue.failed");
  if (e.code === "codex_queue_unknown") return t("chat-codexqueue.unknown");
}

/** Preserve RFC3339Nano ordering; Date.parse discards the sub-millisecond revision. */
function stamp(at?: string): string | undefined {
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return;
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(at);
  return m ? `${m[1]}.${(m[2] ?? "").padEnd(9, "0")}Z` : undefined;
}

export function queueReceiptPatch(entry: OutboxEntry, receipt?: QueueMessage): Partial<OutboxEntry> | undefined {
  // Persisted echo proof can arrive with an older dispatch timestamp and unknown state after a Node restart.
  // Enrich identity independently; never regress a known terminal state on the strength of that recovery record.
  const echoLine = typeof receipt?.echo_line === "string" && receipt.echo_line ? receipt.echo_line : entry.queueReceipt?.echoLine;
  const proof = echoLine && echoLine !== entry.queueReceipt?.echoLine ? { queueReceipt: { ...entry.queueReceipt!, echoLine } } : undefined;
  if (terminal(entry.queueReceipt?.state) && !(entry.queueReceipt?.state === "delivered" && receipt?.state === "delivered")) return proof;
  const at = stamp(receipt?.at), old = stamp(entry.queueReceipt?.at);
  if (at && old && at < old) return proof;
  const state = at && receipt && ["queued", "delivered", "failed", "cancelled", "unknown"].includes(receipt.state) ? receipt.state : "unknown";
  // Without a definite non-delivery outcome, never offer a new-id retry.
  const definite = (state === "failed" || state === "cancelled") && receipt?.delivered === "none";
  const resolved = state === "failed" || state === "cancelled" ? definite ? state : "unknown" : state;
  if (entry.queueReceipt?.state === resolved && entry.queueReceipt.at === (at ?? old) && entry.queueReceipt.echoLine === echoLine) return;
  const waiting = resolved === "queued" || resolved === "delivered";
  const code = waiting ? undefined : resolved === "unknown" ? "codex_queue_unknown" : resolved === "cancelled" ? "codex_queue_cancelled" : "codex_queue_failed";
  return {
    queueReceipt: { state: resolved, at: at ?? old, echoLine }, queued: resolved === "queued",
    state: waiting ? "sent" : "failed", inDoubt: resolved === "unknown", newId: definite,
    code, error: queueReason({ code }), clearable: undefined,
  };
}

/** One read for all local queued messages. No model requests, resend, queue cancellation or session-state guessing. */
export function refreshCodexQueue(mid: string, sid: string): Promise<Map<string, OutboxCheck>> {
  const key = outboxKey(mid, sid), path = sessionPath(mid, sid);
  const token = getToken(), owner = credentialOwner(), manager = managerHeaderFor(path);
  const checkKey = JSON.stringify([key, owner, manager]);
  const running = checks.get(checkKey);
  if (running) return running;
  const entries = (getState().outbox[key] ?? []).filter(needsQueueCheck);
  if (!entries.length) return Promise.resolve(new Map());
  const current = () => token === getToken() && owner === credentialOwner() && manager === managerHeaderFor(path);
  const run = (async () => {
    const results = new Map<string, OutboxCheck>();
    let info: QueueInfo = {};
    try { info = await api<QueueInfo>(`${path}/info`, { token, tokenOwner: owner, isAuthContextCurrent: current }); }
    catch { /* Connection loss cannot prove the in-memory queue still exists. Keep the message, mark it uncertain. */ }
    if (!current()) return results;
    const queue = info?.codex_desktop_queue;
    const receipts = queue?.version === 1 && Array.isArray(queue.messages) ? queue.messages : [];
    for (const entry of entries) {
      if ((getState().outbox[key] ?? []).find((e) => e.id === entry.id) !== entry) continue;
      const receipt = receipts.find((r) => r?.client_msg_id === entry.id);
      const patch = queueReceiptPatch(entry, receipt);
      if (patch) updateQueueReceipt(mid, sid, entry, patch);
      const state = patch?.queueReceipt?.state ?? entry.queueReceipt?.state;
      results.set(entry.id, state === "failed" || state === "cancelled" ? "not_applied" : state === "delivered" ? "applied" : "unknown");
    }
    return results;
  })();
  checks.set(checkKey, run);
  void run.finally(() => { if (checks.get(checkKey) === run) checks.delete(checkKey); });
  return run;
}
