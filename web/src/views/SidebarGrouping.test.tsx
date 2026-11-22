// @vitest-environment jsdom
// The Agents block's grouping (#2812) against the store: By to-do waits for the first GET /todos instead of drawing every
// agent under No to-do and moving it, and a hub without todos hides To-dos and shows By machine while keeping the choice.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// jsdom has no matchMedia (the sidebar's modules read it when they load) and no ResizeObserver (its highlight)
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { t } from "../i18n";
import { filterAgentList, resetAgentListFilters } from "../lib/agent-list-filters";
import { refresh, reset } from "../lib/store";
import type { Todo } from "../lib/todos";
import type { Machine, Session } from "../lib/types";
import { Icon, type IconName } from "../ui/icons";
import { Sidebar } from "./Sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const mac: Machine = { id: "mac", name: "工作电脑", online: true };
const agent: Session = { machine_id: "mac", session_id: "s1", title: "改发布脚本", cwd: "/code/weather", status: "working", state: "working" };
const todo: Todo = { id: "td1", title: "天气 App 发 1.3 版", created_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:00Z", agents: [{ machine_id: "mac", session_id: "s1", linked_at: "2026-11-05T00:00:00Z" }] };

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
/** fetch for a hub with `mac` and its one agent; GET /todos answers with `todos`. */
const hub = (todos: () => Promise<Response>) =>
  vi.fn((url: string) => {
    if (url.endsWith("/api/v1/todos")) return todos();
    if (url.endsWith("/api/v1/sessions")) return json({ sessions: [agent] });
    if (url.endsWith("/api/v1/machines")) return json({ machines: [mac] });
    return json({});
  });

let host: HTMLDivElement;
let root: Root;
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};
const grouping = () => host.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Agent 分组"]');
const segments = () => [...(grouping()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
const checked = () => segments().find((b) => b.getAttribute("aria-checked") === "true")?.getAttribute("aria-label");
// the Agents block's body: the segments, the quick filter and the groups (the personal agents' Loading... is elsewhere)
const agentsBlock = () => host.querySelector<HTMLElement>("[data-sidebar-agents]")!;
const render = async () => {
  act(() => root.render(<Sidebar route={{ name: "home" }} onSearch={() => {}} onNewAgent={() => {}} />));
  await flush();
};

beforeEach(() => {
  localStorage.clear();
  reset();
  resetAgentListFilters();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  history.replaceState(null, "", "/");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  reset();
  resetAgentListFilters();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("persistent 2-tab grouping (状态 | 仓库) and dispatched tasks", () => {
  it("renders 状态 | 仓库 persistently and shows supervised/worktree dispatched tasks in 派出任务 with 派出 badge", async () => {
    const dispatchedWorker: Session = {
      machine_id: "mac",
      session_id: "s-dispatched",
      title: "修复 Persona 的 Codex 实例问题",
      cwd: "/Users/demo/.herdr/worktrees/persona/task-todo-39102cb2935e49da",
      status: "idle",
      state: "idle",
      started_by_persona: false,
      updated_at: "2026-11-22T09:10:00Z",
    };
    const manualChat: Session = {
      machine_id: "mac",
      session_id: "s-manual",
      title: "本地日常调试会话",
      cwd: "/Users/demo/code/weather",
      status: "idle",
      state: "idle",
      updated_at: "2026-11-22T09:05:00Z",
    };
    const supervisedTodo: Todo = {
      ...todo,
      id: "todo_39102cb2935e49da",
      supervision: { mode: "auto" } as never,
      agents: [{ machine_id: "mac", session_id: "s-dispatched", linked_at: "2026-11-22T09:00:00Z" }],
    };
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/api/v1/todos")) return json({ todos: [supervisedTodo] });
      if (url.endsWith("/api/v1/sessions")) return json({ sessions: [agent, dispatchedWorker, manualChat] });
      if (url.endsWith("/api/v1/machines")) return json({ machines: [mac] });
      return json({});
    }));
    await refresh();
    await render();
    expect(segments().map((b) => b.textContent)).toEqual(["状态", "仓库"]);
    expect(checked()).toBe("按状态");
    expect(agentsBlock().textContent).toContain("进行中");
    expect(agentsBlock().textContent).toContain("派出任务");
    expect(agentsBlock().textContent).toContain("修复 Persona 的 Codex 实例问题");
    expect(agentsBlock().textContent).toContain("最近");
    expect(agentsBlock().textContent).toContain("本地日常调试会话");
    expect(agentsBlock().querySelector('[data-persona-dispatched]')?.textContent).toBe("派出");
  });

  it("migrates legacy machine/space preferences to 仓库 and todo to 状态", async () => {
    localStorage.setItem("persona.agentGrouping", "machine");
    vi.stubGlobal("fetch", hub(() => json({ todos: [todo] })));
    await refresh();
    await render();
    expect(checked()).toBe("按仓库");
    expect(agentsBlock().textContent).not.toContain("加载中…");
  });
});

describe("group controls in every Agents view", () => {
  it.each(["state", "repo"])("opens and folds all levels in %s without folding the block", async (mode) => {
    localStorage.setItem("persona.agentGrouping", mode);
    vi.stubGlobal("fetch", hub(() => json({ todos: [todo] })));
    await refresh();
    await render();
    const action = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    const disclosures = () => [...agentsBlock().querySelectorAll<HTMLButtonElement>("[data-sidebar-group-heading] button[aria-expanded]")].filter((b) => !b.closest("[data-sidebar-agents-controls]"));
    expect(disclosures().length).toBeGreaterThan(0);
    expect(host.querySelectorAll("[data-sidebar-agents-controls] [data-testid=agents-fold-all]")).toHaveLength(1);
    await act(async () => { action("全部折叠").click(); await Promise.resolve(); });
    expect(disclosures().every((b) => b.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(grouping()?.closest("[inert]") ?? null).toBeNull();
    await flush();
    await act(async () => { action("全部展开").click(); await Promise.resolve(); });
    expect(disclosures().every((b) => b.getAttribute("aria-expanded") === "true")).toBe(true);
    await flush();
    const first = disclosures()[0]!;
    await act(async () => { action("全部折叠").click(); await Promise.resolve(); });
    await flush();
    await act(async () => { first.click(); await Promise.resolve(); });
    await flush();
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(action("全部折叠")).not.toBeNull();
    await act(async () => { action("全部折叠").click(); await Promise.resolve(); });
    expect(first.getAttribute("aria-expanded")).toBe("false");
  });
});

// Collapse all / Expand all act on the list under the controls only (#6447): the grouping tabs, the quick filters and
// the title row's Filter (#6589: the list has no search field of its own) stay on screen while every group folds to its
// heading; the chat-list view has no groups to fold to, so it has no button (a first fix folded the whole block there,
// the controls with it).
describe("the fold-all button keeps the Agents controls", () => {
  /** On screen: not inside an inert box or a closed Collapse (0fr), the two ways the sidebar folds. */
  const onScreen = (el: Element | null | undefined) => {
    for (let e: Element | null = el ?? null; e; e = e.parentElement) {
      if (e.hasAttribute("inert") || (e as HTMLElement).style?.gridTemplateRows === "0fr") return false;
    }
    return Boolean(el);
  };
  const controls = () => ({
    tabs: onScreen(grouping()),
    filters: onScreen(agentsBlock().querySelector(`[role="radiogroup"][aria-label="${t("sidebar.quick_filters")}"]`)),
    filter: onScreen(agentsBlock().querySelector("[data-sidebar-agents-controls] [data-testid=agent-filter-button]")),
  });
  const everyControl = { tabs: true, filters: true, filter: true };
  /** The agent's title, wherever the grouping draws it. */
  const agentShown = () => {
    const walk = document.createTreeWalker(agentsBlock(), NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.includes(agent.title!) && onScreen(n.parentElement)) return true;
    return false;
  };
  const headings = () => [...agentsBlock().querySelectorAll<HTMLButtonElement>("[data-sidebar-group-heading] button[aria-expanded]")]
    .filter((b) => !b.closest("[data-sidebar-agents-controls]") && onScreen(b));
  const foldAll = () => host.querySelector<HTMLButtonElement>("[data-sidebar-agents-controls] [data-testid=agents-fold-all]");
  /** The glyph an icon draws, and the one the button shows: corners in (Collapse all) or out (Expand all). */
  const glyph = (name: IconName) => renderToStaticMarkup(<Icon name={name} />).match(/ d="([^"]+)"/)?.[1];
  const shows = () => foldAll()?.querySelector("path")?.getAttribute("d");
  const press = async () => {
    await act(async () => { foldAll()!.click(); await Promise.resolve(); });
    await flush();
  };

  it.each(["state", "repo"])("folds %s to its group headings and opens it again, the controls staying", async (mode) => {
    localStorage.setItem("persona.agentGrouping", mode);
    const expectedControls = mode === "state" ? { tabs: true, filters: false, filter: true } : everyControl;
    vi.stubGlobal("fetch", hub(() => json({ todos: [todo] })));
    await refresh();
    await render();
    expect(controls()).toEqual(expectedControls);
    expect(agentShown()).toBe(true);
    expect(foldAll()!.getAttribute("aria-label")).toBe("全部折叠");
    expect(shows()).toBe(glyph("foldToggle"));

    await press();
    expect(controls()).toEqual(expectedControls);
    expect(headings().length).toBeGreaterThan(0);
    expect(headings().every((b) => b.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(agentShown()).toBe(false);
    expect(foldAll()!.getAttribute("aria-label")).toBe("全部展开");
    expect(shows()).toBe(glyph("unfoldToggle"));

    await press();
    expect(controls()).toEqual(expectedControls);
    expect(headings().every((b) => b.getAttribute("aria-expanded") === "true")).toBe(true);
    expect(agentShown()).toBe(true);
    expect(shows()).toBe(glyph("foldToggle"));
  });

  it("has no button in the chat-list view, whose rows stay under the controls", async () => {
    localStorage.setItem("persona.agentGrouping", "repo");
    localStorage.setItem("persona.agentChatList", "1");
    vi.stubGlobal("fetch", hub(() => json({ todos: [todo] })));
    await refresh();
    await render();
    expect(host.querySelector("[data-testid=agent-chatlist-section]")).not.toBeNull();
    expect(foldAll()).toBeNull();
    expect(controls()).toEqual(everyControl);
    expect(agentShown()).toBe(true);
  });
});

describe("a hub without todos (GET /todos 404)", () => {
  it("opens on 状态 cleanly with the 2-tab bar and omits legacy groupings from the list menu", async () => {
    vi.stubGlobal("fetch", hub(() => json({ error: "not found" }, 404)));
    await refresh();
    await render();
    expect(segments().map((b) => b.textContent)).toEqual(["状态", "仓库"]);
    expect(checked()).toBe("按状态");
    expect(agentsBlock().textContent).toContain("进行中");
    expect(agentsBlock().textContent).toContain("改发布脚本");
    expect(agentsBlock().textContent).not.toContain("加载中…");
    expect(localStorage.getItem("persona.agentGrouping")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Agent 列表选项"]')!.click());
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((el) => el.textContent);
    expect(labels).toEqual(["按状态", "按仓库"]);
  });
});

describe("relative-time Agents filters", () => {
  it("expires a session as the since window passes", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-11-15T12:00:00Z");
    vi.setSystemTime(start);
    const aging = { ...agent, updated_at: new Date(start.getTime() - 24 * 60 * 60 * 1000 + 30_000).toISOString() };
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/api/v1/todos")) return json({ todos: [todo] });
      if (url.endsWith("/api/v1/sessions")) return json({ sessions: [aging] });
      if (url.endsWith("/api/v1/machines")) return json({ machines: [mac] });
      return json({});
    }));
    filterAgentList("since:24h");
    await refresh();
    await render();
    expect(agentsBlock().textContent).toContain(agent.title);
    expect(agentsBlock().textContent).not.toContain(t("sidebar.no_match"));

    await act(async () => { vi.advanceTimersByTime(61_000); await Promise.resolve(); });
    await flush();
    expect(agentsBlock().textContent).not.toContain(agent.title);
    expect(agentsBlock().textContent).toContain(t("sidebar.no_match"));
  });
});
