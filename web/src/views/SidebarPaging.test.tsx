// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { connect, reset, savePins } from "../lib/store";
import { cycleGrouping } from "../lib/sidebar-api";
import { SESSIONS_AGENTS_ONLY_FEATURE, runtimeAgents, runtimeSessions } from "../lib/runtime-list";
import { filterAgentList, getAgentListFilters, resetAgentListFilters } from "../lib/agent-list-filters";
import type { AgentPins } from "../lib/pins";
import type { Session } from "../lib/types";
import { Sidebar } from "./Sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor() { FakeSocket.all.push(this); }
  send() {}
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  push(msg: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}
const row = (id: string): Session => ({ machine_id: "computer", session_id: id, title: id, cwd: "/code/demo", status: "working", state: "working", updated_at: "2026-01-01T00:00:00Z", space_id: "project", space_name: "Demo project" });
const first = { ...row("First page agent"), cwd: "/home/demo/.persona/health-bin" }, tail = row("Beyond first page");
const assistant: Session = { ...row("Persona conversation"), assistant: true, state: "needs_you" };
const health: Session = { ...row("Health conversation"), space: "health", state: "needs_you" };
const healthDir = { ...health, session_id: "health-dir", title: "Legacy private directory", space: undefined, cwd: "/home/demo/.persona/health/notes" };
const managerHealthDir = { ...health, session_id: "manager-health-dir", title: "Legacy manager private directory", space: undefined, cwd: "C:\\Users\\demo\\.jarvis\\health-m-0b0b0b\\notes" };
const emptyPins: AgentPins = { sessions: [], spaces: [] };
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
let host: HTMLDivElement, root: Root;
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const grouping = () => host.querySelector('[role="radiogroup"][aria-label="Agent 分组"]');
const chosen = () => grouping()?.querySelector('[aria-checked="true"]')?.textContent;
const pagedList = () => host.querySelector("[data-paged-sessions]");
const completeReads = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url]) => (url as string).endsWith("/api/v1/sessions") || (url as string).includes("summary=0"));

async function render(paged: boolean, pins = emptyPins, saved?: string, agentsOnly = paged) {
  if (saved) localStorage.setItem("persona.agentGrouping", saved);
  let moved = false;
  const movedRow = { ...first, assistant: true };
  const fetch = vi.fn((input: string) => {
    const url = new URL(input, "http://hub.example.com");
    if (url.pathname.endsWith("/sessions") && !url.pathname.includes("/agents/")) {
      const q = url.searchParams;
      const scoped = q.get("agents_only") === "1";
      const firstPage = scoped ? [first] : [first, assistant, health, healthDir, managerHealthDir];
      const total = firstPage.length + 1 - (scoped && moved ? 1 : 0);
      if (q.has("counts")) return json({ total, state: scoped ? { working: total } : { working: 2, needs_you: total - 2 }, machine: { computer: total }, group: {}, project: {}, revision: moved ? "r2" : "r1" });
      if (q.has("since")) return json({
        sessions: moved && !scoped ? [movedRow] : [],
        remove: moved && scoped ? [JSON.stringify([first.machine_id, first.session_id])] : [],
        has_more: false,
        revision: moved ? "r2" : "r1",
        total,
      });
      // The complete fallback's pages (#3759): every row, in two frozen pages; the bounded list's summary pages.
      if (url.searchParams.get("summary") === "0" && !url.searchParams.has("session_id")) {
        return url.searchParams.get("cursor") === "next"
          ? json({ sessions: [tail], remove: [], has_more: false, revision: "r1", total })
          : json({ sessions: firstPage, remove: [], has_more: true, next_cursor: "next", revision: "r1", total });
      }
      if (url.search) return json({ sessions: firstPage, remove: [], has_more: true, next_cursor: "next", revision: "r1", total });
      return json({ sessions: [...firstPage, tail] });
    }
    if (url.pathname.endsWith("/pins")) return json(pins);
    if (url.pathname.endsWith("/machines")) return json({ machines: [{ id: "computer", name: "Demo computer", online: true }] });
    if (url.pathname.endsWith("/todos")) return json({ todos: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetch);
  act(() => {
    connect();
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    socket.push({ type: "hello", features: paged ? ["sessions_list", "sessions_lookup", "sessions_todo", ...(agentsOnly ? [SESSIONS_AGENTS_ONLY_FEATURE] : [])] : [] });
  });
  await flush();
  act(() => root.render(<Sidebar route={{ name: "home" }} onSearch={() => {}} onNewAgent={() => {}} />));
  await flush();
  return { fetch, moveToAssistant: () => { moved = true; FakeSocket.all.at(-1)!.push({ type: "sessions_list", revision: "r2" }); } };
}

beforeEach(() => {
  localStorage.clear();
  reset();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  history.replaceState(null, "", "/");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); reset(); resetAgentListFilters(); vi.unstubAllGlobals();
});

for (const paged of [false, true]) {
  describe(`sidebar with paging ${paged ? "supported" : "unavailable"}`, () => {
    it("keeps session pins beyond the first page in their own section", async () => {
      await render(paged, { sessions: ["computer/Beyond first page"], spaces: [] }, "todo");
      expect(grouping()).not.toBeNull();
      expect(host.textContent).toContain("置顶");
      expect(host.textContent).toContain(tail.title);
      expect(host.querySelectorAll('a[href*="Beyond%20first%20page"]')).toHaveLength(1);
    });
    it("keeps pinned workspaces", async () => {
      await render(paged, { sessions: [], spaces: ["computer/Demo project"] }, "todo");
      expect(grouping()).not.toBeNull();
      expect(host.textContent).toContain(tail.title);
    });
    it.each([
      ["machine", "仓库"],
      ["space", "仓库"],
      ["repo", "仓库"],
      ["state", "状态"],
      ["todo", "状态"],
    ] as const)("normalizes saved %s grouping to %s in the persistent 2-tab bar", async (saved, expectedTab) => {
      const { fetch } = await render(paged, emptyPins, saved);
      expect(chosen()).toBe(expectedTab);
      expect(localStorage.getItem("persona.agentGrouping")).toBe(saved);
      expect(Boolean(pagedList())).toBe(false);
      expect(completeReads(fetch).length > 0).toBe(true);
      expect(host.textContent).toContain(tail.title);
    });
    it("opens on 状态 by default with the persistent 2-tab grouping bar", async () => {
      const { fetch } = await render(paged);
      expect(chosen()).toBe("状态");
      expect(Boolean(pagedList())).toBe(false);
      expect(completeReads(fetch).length > 0).toBe(true);
    });
  });
}

it("reacts to pins saved while mounted, keeping the 2-tab bar unchanged", async () => {
  await render(true, emptyPins, "state");
  expect(chosen()).toBe("状态");
  await act(async () => savePins({ sessions: ["computer/Beyond first page"], spaces: [] }));
  await flush();
  expect(chosen()).toBe("状态");
  expect(host.textContent).toContain("置顶");
  expect(host.textContent).toContain(tail.title);
  await act(async () => savePins(emptyPins));
  await flush();
  expect(chosen()).toBe("状态");
});

it("honors the grouping shortcut to toggle between 状态 and 仓库", async () => {
  await render(true, emptyPins, "state");
  act(() => { cycleGrouping(); });
  await flush();
  expect(localStorage.getItem("persona.agentGrouping")).toBe("repo");
  expect(chosen()).toBe("仓库");
  act(() => { cycleGrouping(); });
  await flush();
  expect(localStorage.getItem("persona.agentGrouping")).toBe("state");
  expect(chosen()).toBe("状态");
});

it("has no search field of its own: ⌘K's words appear as a search chip whose × takes them off (#6589)", async () => {
  await render(true, emptyPins, "state");
  expect(host.querySelector("[data-sidebar-agents] input")).toBeNull();
  act(() => filterAgentList("review"));
  await flush();
  const chip = host.querySelector('[data-sidebar-agents] [data-chip="query"]')!;
  expect(chip.textContent).toContain("review");
  await act(async () => chip.querySelector<HTMLButtonElement>("button[aria-label]")!.click());
  await flush();
  expect(getAgentListFilters().query).toBe("");
  expect(host.querySelector('[data-chip="query"]')).toBeNull();
});

it("scopes sidebar pages, counts and deltas while keeping the shared session list complete", async () => {
  const { fetch, moveToAssistant } = await render(true, emptyPins, "todo");
  expect(runtimeAgents.getSnapshot().rows.map((s) => s.title)).toEqual([first.title]);
  expect(runtimeAgents.getSnapshot().total).toBe(2);
  expect(runtimeAgents.getSnapshot().counts?.state).toEqual({ working: 2 });
  expect(runtimeSessions.getSnapshot().rows).toContainEqual(assistant);
  expect(runtimeSessions.getSnapshot().rows).toContainEqual(health);

  await act(async () => moveToAssistant());
  await flush();
  const requests = fetch.mock.calls.map(([input]) => new URL(input, "http://hub.example.com").searchParams);
  const scoped = requests.filter((q) => q.get("agents_only") === "1");
  expect(scoped.some((q) => q.get("since") === "r1")).toBe(true);
  expect(scoped.some((q) => q.get("counts") === "1")).toBe(true);
  expect(runtimeAgents.getSnapshot().rows).not.toContainEqual(first);
  expect(runtimeAgents.getSnapshot().total).toBe(1);
  expect(runtimeAgents.getSnapshot().counts?.state).toEqual({ working: 1 });
  expect(runtimeSessions.getSnapshot().rows).toContainEqual({ ...first, assistant: true });
});

it("uses the complete Agents list when the hub supports paging without the Agents filter", async () => {
  const { fetch } = await render(true, emptyPins, "todo", false);
  expect(grouping()).not.toBeNull();
  expect(host.textContent).toContain(tail.title);
  expect(host.textContent).toContain(first.title);
  expect(host.textContent).not.toContain(assistant.title);
  expect(host.textContent).not.toContain(health.title);
  expect(host.textContent).not.toContain(healthDir.title);
  expect(host.textContent).not.toContain(managerHealthDir.title);
  expect(fetch.mock.calls.some(([input]) => input.includes("agents_only"))).toBe(false);
});
