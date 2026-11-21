// Inbox-only handoffs load with InboxDialogs, not with the shared chat outbox.
import { api } from "./api";
import { startConversation } from "./assistant-start";
import { conversationPage } from "./conversation-page";
import { ownerHeaders } from "./manager-choice";
import { adoptConversation, noteSent, sendToMain } from "./outbox";
import { navigate } from "./router";
import { refreshAssistant } from "./store";
import type { AssistantInfo } from "./types";

/** Read the item's own manager, without changing the selected assistant. Navigation and sending keep their order;
 *  a failed lookup/start leaves the page in place, and the shared outbox owns delivery and failure recovery. */
export async function askPersonaOf(owner: string | undefined, text: string): Promise<{ sent: Promise<boolean> }> {
  const headers = ownerHeaders(owner);
  const a = await api<AssistantInfo>("/assistant", { headers });
  if (a.machine_id && a.main) {
    adoptConversation(owner, a.main, a.machine_id);
    return { sent: sendToMain(a.machine_id, a.main, text, owner) };
  }
  const r = await startConversation({ prompt: text, main: true }, headers);
  adoptConversation(owner, r.session.session_id, r.session.machine_id);
  noteSent(r.session.machine_id, r.session.session_id, { text });
  void refreshAssistant().catch(() => {});
  navigate(conversationPage(r.session.session_id, r.session.machine_id, owner));
  return { sent: Promise.resolve(true) };
}
