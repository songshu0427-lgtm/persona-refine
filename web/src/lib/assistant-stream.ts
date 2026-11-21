// Persona main-chat live text belongs to a runtime turn and message, not to the latest mounted bubble.
import type { Item } from "./types";

export interface DeltaIdentity {
  turn_id?: string;
  item_id?: string;
  turn_done?: boolean;
}

const isPrompt = (i: Item) => !i.queued && !i.tool_use_id && ((i.role === "user" && (i.kind === "text" || i.kind === "image")) || i.wake);
const latestUser = (latest: Item[]) => latest.findLast(isPrompt);
const owns = (user: Item | undefined, turn: string) => user && (user.turn_id === turn || user.id.startsWith(`history:${turn}:`));

/** Keep an early frame buffered until its own user item arrives; never attach it to a different turn's question. */
export function assistantStreamText(text: string, turn: string, latest: Item[]): string {
  return turn && !owns(latestUser(latest), turn) ? "" : text;
}

/** True means publish/clear the live slot; false leaves its newer contents alone. No text-based deduplication. */
export function assistantStream() {
  let turn = "", item = "", prompt = "", scoped = false;
  const retired = new Set<string>(), messages = new Set<string>();
  const retire = (id: string) => {
    if (!id) return;
    retired.add(id);
    if (retired.size > 128) retired.delete(retired.values().next().value!);
  };
  const landed = (latest: Item[], id: string, owner: string) => latest.some((i) => {
    if (i.role !== "assistant" || i.kind !== "text") return false;
    const root = i.id.split("#")[0];
    return root === id || root === `history:${owner}:${id}`;
  });
  return {
    items(latest: Item[], batch: Item[]): boolean {
      const user = latestUser(latest);
      let clear = false;
      if (user && user.id !== prompt) {
        if ((prompt || turn) && (!scoped || latest.some((i) => isPrompt(i) && owns(i, turn))) && !owns(user, turn)) {
          retire(turn);
          item = "";
          messages.clear();
          clear = true;
        }
        // A new delta can precede the user item in HTTP/watch. That item's arrival must not erase it.
        if (!turn || clear) turn = user.turn_id ?? "";
        prompt = user.id;
      }
      if (item && landed(latest, item, turn)) {
        messages.add(item);
        clear = true;
      }
      return clear || (!scoped && batch.some((i) => i.role === "assistant" && i.kind === "text"));
    },
    delta(_text: string, identity: DeltaIdentity | undefined, latest: Item[]): boolean {
      const owner = identity?.turn_id;
      if (!owner) return true; // older runtimes keep their text-only contract, with the user boundary above
      scoped = true;
      if (retired.has(owner)) return false;
      const user = latestUser(latest);
      if (owner !== turn && owner !== user?.turn_id && latest.some((i) => i.turn_id === owner)) return false;
      if (identity.turn_done) { retire(owner); return owner === turn; }
      const next = identity.item_id ?? "";
      if (owner === turn && next && messages.has(next)) return false;
      // A replay already in history is not a new message, even when a different live message is on screen.
      if (next && landed(latest, next, owner)) return false;
      if (owner !== turn) {
        retire(turn);
        turn = owner;
        item = "";
        messages.clear();
      }
      if (next && item && next !== item) messages.add(item);
      if (next) item = next;
      return true;
    },
  };
}
