import { describe, expect, it } from "vitest";
import { needsQueueCheck, queueReceiptPatch } from "./codex-queue";
import type { OutboxEntry } from "./outbox";

const entry: OutboxEntry = { id: "send", text: "Fixture", images: [], at: 1, state: "sent", queued: true, queueReceipt: { state: "queued", at: "2026-11-21T10:00:00.000000002Z" } };

describe("desktop queue receipts", () => {
  it("compares nanoseconds and ignores an older receipt", () => {
    expect(queueReceiptPatch(entry, { client_msg_id: "send", state: "failed", delivered: "none", at: "2026-11-21T10:00:00.000000001Z" })).toBeUndefined();
    expect(queueReceiptPatch(entry, { client_msg_id: "send", state: "delivered", at: "2026-11-21T10:00:00.000000003Z" })).toMatchObject({ state: "sent", queued: false, queueReceipt: { state: "delivered" } });
  });
  it.each(["delivered", "failed", "cancelled"] as const)("never regresses %s to queued or unknown", (state) => {
    const done = { ...entry, queued: false, queueReceipt: { state, at: entry.queueReceipt!.at } };
    expect(queueReceiptPatch(done)).toBeUndefined();
    expect(queueReceiptPatch(done, { client_msg_id: "send", state: "queued", at: "2026-11-21T11:00:00Z" })).toBeUndefined();
    expect(needsQueueCheck(done)).toBe(state === "delivered");
  });
  it("needs proof of non-delivery before offering Retry", () => {
    expect(queueReceiptPatch(entry, { client_msg_id: "send", state: "failed", at: "2026-11-21T11:00:00Z", delivered: "unknown" })).toMatchObject({ state: "failed", inDoubt: true, newId: false, code: "codex_queue_unknown" });
  });
  it("continues checking delivered until a stable echo line arrives, even if the receipt time stays the same", () => {
    const delivered = { ...entry, queued: false, queueReceipt: { state: "delivered" as const, at: entry.queueReceipt!.at } };
    expect(needsQueueCheck(delivered)).toBe(true);
    const patch = queueReceiptPatch(delivered, { client_msg_id: "send", state: "delivered", at: entry.queueReceipt!.at!, echo_line: "history:batch:user" });
    expect(patch?.queueReceipt?.echoLine).toBe("history:batch:user");
    expect(needsQueueCheck({ ...delivered, ...patch })).toBe(false);
  });
  it("accepts persisted echo proof after Node restart without regressing a newer delivered receipt", () => {
    const delivered = { ...entry, queued: false, queueReceipt: { state: "delivered" as const, at: "2026-11-21T11:00:00Z" } };
    const patch = queueReceiptPatch(delivered, { client_msg_id: "send", state: "unknown", at: "2026-11-21T10:00:00Z", echo_line: "history:batch:user" });
    expect(patch?.queueReceipt).toEqual({ state: "delivered", at: "2026-11-21T11:00:00Z", echoLine: "history:batch:user" });
    expect(patch).not.toHaveProperty("state");
  });
  it("does not inspect Claude or other runtimes' unrelated queues", () => {
    expect(needsQueueCheck({ ...entry, queueReceipt: undefined })).toBe(false);
  });
  it("marks missing/invalid status uncertain without changing the original time or text", () => {
    expect(queueReceiptPatch(entry)).toMatchObject({ state: "failed", queued: false, inDoubt: true, newId: false });
    expect(queueReceiptPatch(entry, { client_msg_id: "send", state: "failed", delivered: "none", at: "invalid" })).toMatchObject({ queueReceipt: { state: "unknown", at: entry.queueReceipt!.at } });
    expect(queueReceiptPatch(entry)).not.toHaveProperty("text");
    expect(queueReceiptPatch(entry)).not.toHaveProperty("at");
  });
});
