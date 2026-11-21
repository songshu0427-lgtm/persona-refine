import { expect, it } from "vitest";
import { assistantStream, assistantStreamText } from "./assistant-stream";
import type { Item } from "./types";
const user = (n: number): Item => ({ id: `u${n}`, seq: n * 10, role: "user", kind: "text", text: "Question", turn_id: `turn-${n}` });
it("fences a replay that beat the first HTTP page, but keeps a newer delta ahead of that page", () => {
  const old = assistantStream();
  expect(old.delta("Previous", { turn_id: "turn-1", item_id: "a1" }, [])).toBe(true);
  expect(old.items([user(1), user(2)], [user(1), user(2)])).toBe(true);
  expect(old.delta("Previous", { turn_id: "turn-1", item_id: "a1" }, [user(1), user(2)])).toBe(false);
  const next = assistantStream();
  expect(next.delta("Already new", { turn_id: "turn-2", item_id: "a2" }, [])).toBe(true);
  expect(next.items([user(1)], [user(1)])).toBe(false);
  expect(next.items([user(1), user(2)], [user(2)])).toBe(false);
});
it("does not mistake another assistant item for its turn's user boundary", () => {
  const live = assistantStream(), first = [user(1)];
  live.items(first, first);
  live.delta("Third", { turn_id: "turn-3", item_id: "a3-new" }, first);
  const partial: Item[] = [...first, { id: "a3-old#0", seq: 31, turn_id: "turn-3", role: "assistant", kind: "text", text: "Earlier in third" }];
  expect(live.items(partial, partial.slice(1))).toBe(false);
  const lagging = [first[0], user(2), partial[1]];
  expect(live.items(lagging, [user(2)])).toBe(false);
  expect(live.delta("Third extended", { turn_id: "turn-3", item_id: "a3-new" }, lagging)).toBe(true);
  expect(live.items([first[0], user(2), user(3), partial[1]], [user(3)])).toBe(false);
});
it("never attaches scoped text to a legacy or absent question, but recognizes an exact generated-history owner", () => {
  expect(assistantStreamText("Current", "turn-2", [])).toBe("");
  expect(assistantStreamText("Current", "turn-2", [{ ...user(1), turn_id: undefined }])).toBe("");
  expect(assistantStreamText("Current", "turn-2", [{ ...user(2), id: "history:turn-2:u2#0", turn_id: undefined }])).toBe("Current");
  expect(assistantStreamText("Legacy", "", [user(1)])).toBe("Legacy");
});
