// Per-session listener sets: a chat that goes away leaves no empty set behind, so opening many chats over a page's life
// does not grow the registry the reconnect handler walks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, getSession, getState, listenSession, reset, upsertSession, sessionListenerKeysForTests, type ItemsEvent } from "./store";
import { mergeItems } from "./turns";
import { codexSnapshot } from "./testdata/codex-snapshot";

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** Connects and says hello; returns the socket. */
function online() {
  connect();
  const s = FakeSocket.all[FakeSocket.all.length - 1];
  s.open();
  s.push({ type: "hello", server_version: "v1", event_stream: "s1", event_seq: 1 });
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "hub" });
  vi.stubGlobal("localStorage", { getItem: () => "tok", setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("window", { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: number) => clearTimeout(t) });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 }))));
});

afterEach(() => {
  reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("per-session listeners", () => {
  it("preserves scoped main-chat delta identity, including an empty turn-end frame", () => {
    const socket = online(), receive = vi.fn();
    const off = listenSession("m", "main", { delta: receive });
    const identity = { turn_id: "turn-2", item_id: "reply-2" };
    socket.push({ type: "delta", machine_id: "m", session_id: "main", text: "Current", ...identity });
    expect(receive).toHaveBeenLastCalledWith("Current", expect.objectContaining(identity));
    socket.push({ type: "delta", machine_id: "m", session_id: "main", text: "", ...identity, turn_done: true });
    expect(receive).toHaveBeenLastCalledWith("", expect.objectContaining({ ...identity, turn_done: true }));
    off();
  });
  it("delivers mutable Codex snapshot batches before completion and merges final/reconnected copies once", () => {
    const socket = online();
    let page = codexSnapshot(1), reconnects = 0;
    const off = listenSession("m", "snapshot", { items: (event) => { page = mergeItems(page, event.items); }, reconnected: () => reconnects++ });
    const push = (seq: number, phase: Parameters<typeof codexSnapshot>[1]) => socket.push({ type: "items", machine_id: "m", session_id: "snapshot", items: codexSnapshot(seq, phase), from_seq: seq - 1, to_seq: seq });
    push(2, "updated");
    expect(page).toHaveLength(5);
    expect(page[1].text).toBe("Checking the encoder.");
    push(3, "final"); push(3, "final");
    expect(page).toHaveLength(6);
    socket.push({ type: "hello", server_version: "v1", event_stream: "s1", event_seq: 3 });
    push(3, "final");
    expect(page).toEqual(codexSnapshot(3, "final"));
    expect(reconnects).toBe(1);
    off();
  });
  it("leaves no key behind for a session once its last listener goes", () => {
    const before = sessionListenerKeysForTests();
    for (let i = 0; i < 100; i++) listenSession("m", `s${i}`, {})();
    expect(sessionListenerKeysForTests()).toBe(before);
  });

  it("keeps the key while another listener is left, and that one still hears items, deltas and reconnects", () => {
    const s = online();
    const before = sessionListenerKeysForTests();
    const items: ItemsEvent[] = [], deltas: string[] = [];
    let reconnects = 0, gone = 0;
    const offGone = listenSession("m", "kept", { items: () => gone++, delta: () => gone++, reconnected: () => gone++ });
    const offLive = listenSession("m", "kept", {
      items: (e) => items.push(e),
      delta: (t) => deltas.push(t),
      reconnected: () => reconnects++,
    });
    offGone();
    expect(sessionListenerKeysForTests()).toBe(before + 1);

    s.push({ type: "items", machine_id: "m", session_id: "kept", items: [] });
    s.push({ type: "delta", machine_id: "m", session_id: "kept", text: "hi" });
    s.push({ type: "hello", server_version: "v1", event_stream: "s1", event_seq: 3 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ machine_id: "m", session_id: "kept" });
    expect(deltas).toEqual(["hi"]);
    expect(reconnects).toBe(1);
    expect(gone).toBe(0);

    offLive();
    expect(sessionListenerKeysForTests()).toBe(before);
  });

  it("hands the hub's revs event to each open session's listener, and to no other (#1179)", () => {
    const s = online();
    const got: number[] = [], other: number[] = [];
    const off = listenSession("m", "open", { rev: (r) => got.push(r) });
    const offOther = listenSession("m2", "open", { rev: (r) => other.push(r) });
    s.push({ type: "revs", machine_id: "m", revs: { open: 120, closed: 80 } });
    s.push({ type: "revs", machine_id: "m", revs: { open: "not a rev" } });
    s.push({ type: "revs", machine_id: "m" });
    expect(got).toEqual([120]);
    expect(other).toEqual([]);
    off();
    offOther();
  });

  it("a session listened to again after its key went hears its items", () => {
    const s = online();
    listenSession("m", "again", {})();
    const got: ItemsEvent[] = [];
    const off = listenSession("m", "again", { items: (e) => got.push(e) });
    s.push({ type: "items", machine_id: "m", session_id: "again", items: [] });
    expect(got).toHaveLength(1);
    off();
    // a second call of an unsubscribe already done changes nothing
    off();
    s.push({ type: "items", machine_id: "m", session_id: "again", items: [] });
    expect(got).toHaveLength(1);
  });
});

it("a conversation_deleted event drops its subscription and fences later session/item frames", () => {
  const socket = online();
  const row = { machine_id: "m", session_id: "deleted-chat", assistant: true, status: "idle", title: "Private chat", cwd: "" };
  upsertSession(row);
  const receive = vi.fn();
  const off = listenSession("m", "deleted-chat", { items: receive, delta: receive, reconnected: receive });
  const before = sessionListenerKeysForTests();
  socket.push({ type: "conversation_deleted", machine_id: "m", session_id: "deleted-chat" });
  expect(sessionListenerKeysForTests()).toBe(before - 1);
  socket.push({ type: "session", session: row });
  socket.push({ type: "sessions", machine_id: "m", sessions: [row] });
  socket.push({ type: "sessions_delta", machine_id: "m", upsert: [row] });
  socket.push({ type: "items", machine_id: "m", session_id: "deleted-chat", items: [] });
  socket.push({ type: "delta", machine_id: "m", session_id: "deleted-chat", text: "late" });
  expect(receive).not.toHaveBeenCalled();
  expect(getState().sessions.m).toEqual([]);
  expect(getSession("m", "deleted-chat")).toMatchObject({ deleted: true, title: "", capabilities: {} });
  off();
});
