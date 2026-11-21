// @vitest-environment jsdom
// Persona's main chat, not a native Agent view. Every event and HTTP page is synthetic.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Item, ItemsPage } from "../../lib/types";
import type { ItemsEvent, listenSession } from "../../lib/store";
import type { Transcript } from "./useTranscript";

type Listener = Parameters<typeof listenSession>[2];
type Identity = { turn_id?: string; item_id?: string; turn_done?: boolean };
let listener: Listener;
const user = (n: number): Item => ({ id: `u${n}#0`, seq: n * 10, role: "user", kind: "text", text: `Question ${n}`, turn_id: `turn-${n}` });
const reply = (n: number, text = "Same real words"): Item => ({ id: `a${n}#0`, seq: n * 10 + 1, role: "assistant", kind: "text", text, turn_id: `turn-${n}` });
const identity = (n: number): Identity => ({ turn_id: `turn-${n}`, item_id: `a${n}` });
const first = [user(1), reply(1)];
vi.mock("../../lib/api", async (original) => ({
  ...await original<typeof import("../../lib/api")>(),
  api: vi.fn(async (): Promise<ItemsPage> => ({ items: first, to_seq: 11, has_more: false })),
}));
vi.mock("../../lib/store", async (original) => ({
  ...await original<typeof import("../../lib/store")>(), send: vi.fn(),
  listenSession: (_mid: string, _sid: string, l: Listener) => { listener = l; return () => {}; },
}));
const { useTranscript } = await import("./useTranscript");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tr: Transcript, root: Root, host: HTMLDivElement, sid = 0;
function Probe() {
  tr = useTranscript("fixture-main", `turn-fence-${sid}`, { assistant: true });
  return <div data-stream>{tr.streaming}</div>;
}
beforeEach(async () => {
  vi.useFakeTimers();
  sid++;
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });
const items = (batch: Item[]) => act(() => listener.items!({ items: batch, to_seq: Math.max(...batch.map((i) => i.seq)) } as ItemsEvent));
const delta = async (text: string, id?: Identity) => {
  act(() => listener.delta!(text, id));
  await act(async () => void vi.advanceTimersByTime(500));
};
const shown = (text: string) => { expect(tr.streaming).toBe(text); expect(host.textContent).toBe(text); };

it("main-turn: new question clears old live text before any new character, including a held throttle frame", async () => {
  await delta("Earlier live progress", { turn_id: "turn-1", item_id: "not-landed" });
  act(() => listener.delta!("Earlier pending frame", { turn_id: "turn-1", item_id: "not-landed" }));
  items([user(2)]);
  shown("");
  await act(async () => void vi.advanceTimersByTime(500));
  shown("");
  await delta("Current progress", identity(2));
  shown("Current progress");
  expect(tr.items).toContainEqual(reply(1));
});

it("main-turn: late old snapshots, clears and history cannot replace or clear this turn's progress", async () => {
  items([user(2)]);
  await delta("Current progress", identity(2));
  await delta("Same real words", identity(1));
  shown("Current progress");
  await delta("", { ...identity(1), turn_done: true });
  shown("Current progress");
  items([reply(1)]);
  shown("Current progress");
  await delta("Current progress extended", identity(2));
  shown("Current progress extended");
  items([reply(2, "Current progress extended")]);
  shown("");
  await delta("", { ...identity(2), turn_done: true });
  await delta("Must stay closed", { turn_id: "turn-2", item_id: "late-unknown-item" });
  shown("");
  await delta("Current progress extended", identity(2));
  shown("");
  items([reply(2, "Current progress extended"), user(2)]);
  expect(tr.items.filter((i) => i.id === "a2#0")).toHaveLength(1);
});

it("main-turn: a new round may genuinely say exactly the same words without global text deduplication", async () => {
  await delta("Same real words", identity(1));
  shown(""); // this exact item is already in history
  items([user(2)]);
  await delta("Same real words", identity(2));
  shown("Same real words");
  items([reply(2)]);
  shown("");
  expect(tr.items.filter((i) => i.text === "Same real words")).toHaveLength(2);
});

it("main-turn: delta ahead of its user history survives that history arriving", async () => {
  await delta("Already writing round two", identity(2));
  shown(""); // buffered, never attached under round one's question
  items([user(2)]);
  shown("Already writing round two");
  items([reply(1)]);
  shown("Already writing round two");
});

it("main-turn: lagging history cannot retire newer buffered progress or attach it to the wrong question", async () => {
  await delta("Third round progress", identity(3));
  shown("");
  items([user(2)]); // a read started before the third turn
  shown("");
  items([user(3)]);
  shown("Third round progress");
  await delta("Third round extended", identity(3));
  shown("Third round extended");
});

it("main-turn: tool-result images are not new questions and do not retire this turn", async () => {
  items([user(2)]);
  await delta("Reading the tool output", identity(2));
  items([{ id: "tool-image#2", seq: 22, role: "user", kind: "image", tool_use_id: "tool-1", image: { mime: "image/png", data: "" } }]);
  shown("Reading the tool output");
  await delta("Reading the tool output now", identity(2));
  shown("Reading the tool output now");
});

it("main-turn: consecutive questions fence late preceding turns and explicit completion", async () => {
  items([user(2)]);
  await delta("Second progress", identity(2));
  items([user(3)]);
  shown("");
  await delta("Second progress extended", identity(2));
  shown("");
  await delta("Second progress", identity(3));
  shown("Second progress");
  await delta("", { ...identity(3), turn_done: true });
  shown("");
  await delta("Late after completed", identity(3));
  shown("");
});

it("main-turn: reconnect waits for a scoped replay and history settles it once", async () => {
  items([user(2)]);
  await delta("Current progress", identity(2));
  act(() => listener.reconnected!());
  shown("");
  await delta("Same real words", identity(1));
  shown("");
  await delta("Current progress", identity(2));
  shown("Current progress");
  items([reply(2, "Current progress")]);
  items([...first, user(2), reply(2, "Current progress")]);
  shown("");
  expect(tr.items.map((i) => i.id)).toEqual(["u1#0", "a1#0", "u2#0", "a2#0"]);
});

it("main-turn: an older item of the same turn does not end a newer message", async () => {
  items([user(2)]);
  await delta("After the tool", { turn_id: "turn-2", item_id: "after-tool" });
  items([reply(2, "Before the tool")]);
  shown("After the tool");
  await delta("Before the tool", identity(2));
  shown("After the tool");
  await delta("", identity(2));
  shown("After the tool");
  items([{ ...reply(2, "After the tool"), id: "after-tool#0", seq: 22 }]);
  shown("");
});

it("main-turn: snapshot IDs align by turn and source item, never by shared text", async () => {
  items([user(2)]);
  await delta("Current progress", identity(2));
  items([{ ...reply(2, "Current progress"), id: "history:turn-2:a2#1000000" }]);
  shown("");
  await delta("Current progress", identity(2));
  shown("");
});
