// Failed-message recovery is loaded on demand; accepted/queued feedback remains on the immediate path.
import { useRef, useState } from "react";
import { checkOutbox, discardOutbox, entryReason, heldOnComputer, missingOutboxImages, outboxMessage, retryOutbox, type OutboxEntry } from "../../lib/outbox";
import { toast } from "../../ui/atoms";
import { UserBubble } from "./SegmentView";
import { t } from "../../i18n";
import { queueReason } from "../../lib/codex-queue";

function deleteFailed(mid: string, sid: string, id: string) {
  const undo = discardOutbox(mid, sid, id);
  if (undo) toast(t("chat-outboxbubbles.deleted"), "ok", { label: t("chat-outboxbubbles.undo"), run: undo });
}

export function OutboxFailure({ mid, sid, e, canRetry }: { mid: string; sid: string; e: OutboxEntry; canRetry: boolean }) {
  canRetry = canRetry && !missingOutboxImages(e);
  const reason = queueReason(e) ?? entryReason(e);
  const [checking, setChecking] = useState(false);
  const checkLock = useRef(false);
  const check = async () => {
    if (checkLock.current) return;
    checkLock.current = true;
    setChecking(true);
    try {
      if (await checkOutbox(mid, sid, e.id) === "unknown") toast(t(heldOnComputer(e) ? "lib-outbox.still_held" : "lib-outbox.still_unknown"), "info");
    } finally { checkLock.current = false; setChecking(false); }
  };
  return <>
    <UserBubble msg={outboxMessage(e)} mid={mid} sid={sid} sendState="failed" onDelete={() => deleteFailed(mid, sid, e.id)} />
    <div role={e.inDoubt ? "status" : "alert"} data-in-doubt={e.inDoubt ? (heldOnComputer(e) ? "held" : "unknown") : undefined} className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 pl-[12%] text-[11.5px]">
      <span className={`min-w-0 ${e.inDoubt ? "text-orange" : "text-red"}`}>{e.inDoubt ? reason : t("chat-outboxbubbles.failed", { error: reason })}</span>
      {canRetry && !e.inDoubt && e.clearable !== undefined && <button type="button" onClick={() => void retryOutbox(mid, sid, e.id, e.clearable)} className="whitespace-nowrap font-medium text-accent-ink hover:underline">{t("chat-outboxbubbles.clear_and_send")}</button>}
      {e.inDoubt ? <button type="button" disabled={checking} aria-busy={checking} onClick={() => void check()} className="whitespace-nowrap font-medium text-accent-ink hover:underline">{t(checking ? "chat-outboxbubbles.checking" : "chat-outboxbubbles.check")}</button>
        : canRetry && <button type="button" onClick={() => void retryOutbox(mid, sid, e.id)} className="whitespace-nowrap font-medium text-accent-ink hover:underline">{t("chat-outboxbubbles.retry")}</button>}
      <button type="button" onClick={() => deleteFailed(mid, sid, e.id)} className="whitespace-nowrap text-ink-3 hover:text-ink-2">{t("chat-outboxbubbles.delete")}</button>
    </div>
  </>;
}
