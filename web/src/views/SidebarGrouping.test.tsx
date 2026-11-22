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
import { onOpenNewAgent, type NewAgentPreset } from "../lib/new-agent";
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

  it("仓库 view merges Claude Desktop + Codex App project history, expands side sessions, flattens single workspaces, and opens native New Agent with project preset", async () => {
    localStorage.setItem("persona.agentGrouping", "repo");
    const devbox: Machine = { id: "devbox", name: "ARM DevBox", online: true };
    const parent: Session = {
      machine_id: "mac",
      session_id: "p-main",
      title: "meta-rsi (test)",
      cwd: "/Users/demo/code/business-meta/notes",
      space_kind: "claude_desktop",
      space_id: "codex-project:/Users/demo/code/business-meta",
      status: "idle",
      state: "idle",
      updated_at: "2026-11-22T08:00:00Z",
    };
    const sideLive: Session = {
      machine_id: "mac",
      session_id: "p-side-1",
      title: "英文rsi",
      cwd: "/Users/demo/code/business-meta",
      space_kind: "claude_desktop",
      space_id: "codex-project:/Users/demo/code/business-meta",
      folded_under: "p-main",
      folded_as: "side",
      status: "idle",
      state: "idle",
      updated_at: "2026-11-22T08:10:00Z",
    };
    const nestedSubdirOffline: Session = {
      machine_id: "mac",
      session_id: "p-sub",
      title: "结构化解析新事项",
      cwd: "/Users/demo/code/business-meta/exp/subrepo",
      repo_root: "/Users/demo/code/business-meta/exp/subrepo",
      space_kind: "claude_desktop",
      status: "offline",
      state: "offline",
      updated_at: "2026-11-21T08:00:00Z",
    };
    const codexThread: Session = {
      machine_id: "mac",
      session_id: "p-codex",
      title: "Codex 同项目分析",
      cwd: "/Users/demo/code/business-meta",
      space_kind: "codex_app",
      status: "offline",
      state: "offline",
      updated_at: "2026-11-21T12:00:00Z",
    };
    const smokeManual: Session = {
      machine_id: "devbox",
      session_id: "s-smoke",
      title: "执行测试",
      cwd: "/home/demo/agent-smoke",
      space_kind: "herdr",
      space_id: "ws-smoke",
      space_name: "agent-smoke",
      started_by_persona: true,
      status: "idle",
      state: "idle",
      updated_at: "2026-11-22T09:00:00Z",
    };
    const openedPresets: NewAgentPreset[] = [];
    const offPreset = onOpenNewAgent((p) => openedPresets.push(p));
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const path = new URL(url, "http://hub").pathname;
      if (path === "/api/v1/todos") return json({ todos: [] });
      if (path === "/api/v1/machines") return json({ machines: [mac, devbox] });
      if (path === "/api/v1/sessions") return json({ sessions: [parent, sideLive, nestedSubdirOffline, codexThread, smokeManual], total: 5, has_more: false, revision: "r1" });
      if (path === "/api/v1/workspaces") return json({
        workspaces: [{ machine_id: "devbox", source: "herdr", workspace_id: "ws-smoke", title: "agent-smoke", cwd: "/home/demo/agent-smoke", available: true }],
      });
      return json({});
    }));
    await refresh();
    await render();
    await flush();

    // 1. Offline desktop sessions + nested subdirectory + side session are all shown inside `business-meta`
    const text = agentsBlock().textContent ?? "";
    expect(text).toContain("business-meta");
    expect(text).toContain("meta-rsi (test)");
    expect(text).toContain("英文rsi");
    expect(text).toContain("Codex 同项目分析");
    expect(text).toContain("结构化解析新事项");
    expect(text).not.toContain("最近（未运行）");

    // 2. Single same-named catalog workspace (`agent-smoke`) renders no duplicate nested header and no `派出` badge
    expect(agentsBlock().querySelector('[data-persona-dispatched]')).toBeNull();
    const smokeButtons = [...agentsBlock().querySelectorAll("button")].filter((b) => b.textContent?.trim() === "agent-smoke");
    expect(smokeButtons).toHaveLength(1);

    // 3. Clicking `+` on `business-meta` opens New Agent pre-filled with mac + project cwd + claude-desktop launcher
    const addBusinessMeta = agentsBlock().querySelector<HTMLButtonElement>('button[aria-label="新建 Agent · business-meta"]');
    expect(addBusinessMeta).not.toBeNull();
    act(() => addBusinessMeta!.click());
    expect(openedPresets).toEqual([{ machineId: "mac", cwd: "/Users/demo/code/business-meta", launcher: "claude-desktop" }]);
    offPreset();
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
