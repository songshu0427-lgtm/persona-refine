// Messages another page sent for this conversation (lib/outbox.ts): sending ones like the composer's own bubbles,
// sent ones as plain bubbles until the transcript has them, failed ones with why and "Retry" / "Delete" ("Clear and send" when the
// computer's input box holds text it can clear), uncertain ones with their reason (waiting for approval on the computer, when
// the computer said so) and read-only "Check" instead. A failed one's message menu ends in "Delete" too (#4626).
import { Suspense } from "react";
import { entryReason, outboxMessage, type OutboxEntry } from "../../lib/outbox";
import { lazyPage } from "../../lib/lazy-page";
import { UserBubble } from "./SegmentView";
import { t } from "../../i18n";

const OutboxFailure = lazyPage(() => import("./OutboxFailure").then((m) => m.OutboxFailure));

/** Receipt is not execution: keep this line with the message until its transcript copy arrives. */
export function DeliveryStatus({ queued }: { queued?: boolean }) {
  return <div role="status" className="text-right text-submeta text-ink-3">{t(queued ? "chat-outboxbubbles.queued" : "chat-outboxbubbles.awaiting_echo")}</div>;
}

export function OutboxBubbles({ mid, sid, entries, canRetry = true }: { mid: string; sid: string; entries: OutboxEntry[]; canRetry?: boolean }) {
  if (!entries.length) return null;
  return (
    <>
      {entries.map((e) => (
        <div key={e.id} data-outbox={e.id} className="flex flex-col gap-1.5">
          {e.state === "failed" ? <Suspense fallback={<>
            <UserBubble msg={outboxMessage(e)} mid={mid} sid={sid} sendState="failed" />
            <div role={e.inDoubt ? "status" : "alert"} className="text-right text-submeta text-ink-3">{e.inDoubt ? entryReason(e) : t("chat-outboxbubbles.failed", { error: entryReason(e) })}</div>
          </>}><OutboxFailure mid={mid} sid={sid} e={e} canRetry={canRetry} /></Suspense> : <>
            <UserBubble msg={outboxMessage(e)} mid={mid} sid={sid} pending={e.state === "sending"} sendState={e.state} />
            {e.state === "sent" && <DeliveryStatus queued={e.queued} />}
          </>}
        </div>
      ))}
    </>
  );
}
