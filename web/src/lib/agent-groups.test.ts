import { describe, expect, it } from "vitest";
import { agentGrouping, type AgentMutes, awaitsReply, buildAgentGroups, dispatchedSessionKeys, hostsOf, isDispatchedSession, isQuiet, justFinished, replyAsk, sessionHost, sidebarGrouping, splitAgentSessions } from "./agent-groups";
import { byAttention } from "./format";
import type { AgentState, Machine, Session } from "./types";

const machines: Machine[] = [
  { id: "machine-b", name: "电脑 B", online: true },
  { id: "machine-a", name: "电脑 A", online: true },
  { id: "machine-off", name: "离线电脑", online: false },
];
const date = (hour: number) => `2026-01-01T${String(hour).padStart(2, "0")}:00:00Z`;
const session = (id: string, state: AgentState, patch: Partial<Session> = {}): Session => ({
  machine_id: "machine-a", session_id: id, title: id, cwd: "/tmp/project", status: state, state, updated_at: date(1), ...patch,
});
const ids = (sessions: Session[]) => sessions.map((s) => s.session_id);
const mutes: AgentMutes = { spaces: ["machine-a/项目"], sessions: ["machine-a/muted-working", "machine-a/muted-needs", "machine-a/muted-idle", "machine-a/muted-waiting"], allowed: ["machine-a/allowed"] };

describe("Agent 分组偏好", () => {
  it("没选过的默认按紧急度（state），选过的保持原样，并兼容未知的偏好", () => {
    expect(agentGrouping(null)).toBe("state");
    expect(agentGrouping("invalid")).toBe("state");
    for (const value of ["repo", "space", "state", "machine", "todo"]) expect(agentGrouping(value)).toBe(value);
    expect(sidebarGrouping(null)).toBe("state");
    expect(sidebarGrouping("todo")).toBe("state");
    expect(sidebarGrouping("state")).toBe("state");
    expect(sidebarGrouping("repo")).toBe("repo");
    expect(sidebarGrouping("machine")).toBe("repo");
    expect(sidebarGrouping("space")).toBe("repo");
  });
});

describe("状态视图分组（需要你 → 进行中 → 派出任务 → 最近 → 已屏蔽）", () => {
  it("固定顺序：需要你 → 进行中 → 派出任务（默认展开并识别督办/worktree 任务）→ 最近（手动会话 100% 保留）→ 已屏蔽（折叠）", () => {
    const dispatchedKeys = dispatchedSessionKeys([
      { id: "td-supervised", supervision: { mode: "auto" }, agents: [{ machine_id: "machine-a", session_id: "todo-worker" }] } as never,
      { id: "td-manual", agents: [{ machine_id: "machine-a", session_id: "manual-linked" }] } as never,
    ]);
    const all = [
      session("manual-idle", "idle"),
      session("manual-linked", "idle"),
      session("persona-done", "idle", { started_by_persona: true }),
      session("todo-worker", "idle", { updated_at: date(4) }),
      session("worktree-worker", "idle", { cwd: "/Users/demo/.herdr/worktrees/persona/task-todo-39102cb2935e49da", updated_at: date(5) }),
      session("persona-unread", "unread", { started_by_persona: true }),
      session("persona-working", "working", { started_by_persona: true }),
      session("persona-needs", "needs_you", { started_by_persona: true }),
      session("manual-working", "working"),
      session("manual-unread", "unread"),
      session("waiting", "unknown", { loop: { kind: "cron" } }),
      session("unknown", "unknown"),
      session("muted-working", "working"),
    ];
    const offline = [
      session("manual-offline", "offline", { updated_at: date(2) }),
      session("persona-offline", "offline", { started_by_persona: true, updated_at: date(3) }),
    ];
    expect(isDispatchedSession(all[3], dispatchedKeys)).toBe(true);
    expect(isDispatchedSession(all[4], dispatchedKeys)).toBe(true);
    expect(isDispatchedSession(all[1], dispatchedKeys)).toBe(false);
    const groups = buildAgentGroups(all, machines, "state", mutes, offline, dispatchedKeys);
    expect(groups.map((g) => g.name)).toEqual(["需要你", "进行中", "派出任务", "最近", "已屏蔽"]);
    expect(ids(groups[0].sessions)).toEqual(["persona-needs"]);
    expect(ids(groups[1].sessions)).toEqual(["manual-working", "persona-working", "waiting"]);
    expect(ids(groups[2].sessions)).toEqual(["worktree-worker", "todo-worker", "persona-offline", "persona-done", "persona-unread"]);
    expect(groups[2].initialLimit).toBe(5);
    expect(ids(groups[3].sessions)).toEqual(["manual-unread", "manual-idle", "manual-linked", "unknown", "manual-offline"]);
    expect(groups[3].initialLimit).toBe(8);
    expect(groups.slice(0, 4).every((g) => !g.folded)).toBe(true);
    expect(groups[4].folded).toBe(true);
  });

  it("splitAgentSessions 在超过 40 条离线会话时仍完整保留已派出的离线任务", () => {
    const manualOff = Array.from({ length: 45 }, (_, i) =>
      session(`m-${i}`, "offline", { updated_at: `2026-01-02T00:${String(59 - i).padStart(2, "0")}:00Z` }),
    );
    const oldDispatched = session("dispatched-old", "offline", {
      cwd: "/Users/demo/.herdr/worktrees/persona/task-todo-abc123",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const { recent } = splitAgentSessions([...manualOff, oldDispatched], machines, undefined, (s) => isDispatchedSession(s));
    expect(recent).toHaveLength(41);
    expect(ids(recent)).toContain("dispatched-old");
  });

  it("屏蔽的需要你仍排第一，普通手动已看归入最近而不进入已屏蔽", () => {
    const groups = buildAgentGroups([session("muted-needs", "needs_you"), session("muted-idle", "idle"), session("muted-working", "working"),
      session("muted-waiting", "idle", { background: [{ id: "task", kind: "shell" }] })], machines, "state", mutes);
    expect(groups.map((g) => g.name)).toEqual(["需要你", "最近", "已屏蔽"]);
    expect(ids(groups[0].sessions)).toEqual(["muted-needs"]);
    expect(ids(groups[1].sessions)).toEqual(["muted-idle"]);
    expect(ids(groups[2].sessions)).toEqual(["muted-waiting", "muted-working"]);
  });

  it("项目屏蔽按机器和名称生效，并支持 Agent 单独重新开启通知", () => {
    const all = [session("space-muted", "unread", { space_name: "项目" }), session("allowed", "unread", { space_name: "项目" }),
      session("other-machine", "unread", { machine_id: "machine-b", space_name: "项目" }), session("explicit-muted", "unread", { space_name: "项目" })];
    const groups = buildAgentGroups(all, machines, "state", { ...mutes, sessions: ["machine-a/explicit-muted"], allowed: [...mutes.allowed!, "machine-a/explicit-muted"] });
    expect(ids(groups[0].sessions)).toEqual(["allowed", "other-machine"]);
    expect(ids(groups[1].sessions)).toEqual(["explicit-muted", "space-muted"]);
  });

  it("空闲但有 loop、后台工作、运行中子 Agent 的会话归为待唤醒", () => {
    const all = [session("loop", "idle", { loop: { kind: "loop" } }), session("background", "unknown", { background: [{ id: "task", kind: "shell" }] }),
      session("subagent", "idle", { subagents: [{ id: "child", session_id: "child", running: true }] }),
      session("done", "idle", { background: [], subagents: [{ id: "child", session_id: "child", running: false }] })];
    expect(all.map((s) => isQuiet(s))).toEqual([false, false, false, true]);
    const groups = buildAgentGroups(all, machines, "state");
    expect(ids(groups[0].sessions)).toEqual(["background", "loop", "subagent"]);
    expect(ids(groups[1].sessions)).toEqual(["done"]);
  });

  it("按时间降序，同时间按 ID，工作中使用启动时间且可回退更新时间", () => {
    const all = [session("a", "working", { state_since: date(2), updated_at: date(8) }), session("b", "working", { state_since: date(3), updated_at: date(4) }),
      session("c", "working", { updated_at: date(3) }), session("old", "working", { updated_at: undefined })];
    expect(ids(buildAgentGroups(all, machines, "state")[0].sessions)).toEqual(["b", "c", "a", "old"]);
    expect(ids(buildAgentGroups(all.map((s) => ({ ...s, updated_at: s.state_since ? date(20) : s.updated_at })), machines, "state")[0].sessions)).toEqual(["b", "c", "a", "old"]);
    expect(ids(all.slice().sort(byAttention))).toEqual(["b", "c", "a", "old"]);
  });

  it("只显示非空状态组", () => {
    expect(buildAgentGroups([], machines, "state")).toEqual([]);
    expect(buildAgentGroups([session("working", "working")], machines, "state").map((g) => g.name)).toEqual(["进行中"]);
  });
});

describe("所有分组共用 live 与最近的边界", () => {
  it("助手不混入 Agents，离线或未知机器的会话只进入最近", () => {
    const all = [session("live", "unknown"), session("assistant", "working", { assistant: true }), session("offline", "offline"),
      session("machine-offline", "working", { machine_id: "machine-off" }), session("unknown-machine", "working", { machine_id: "unknown" })];
    const lists = splitAgentSessions(all, machines);
    expect(ids(lists.live)).toEqual(["live"]);
    expect(ids(lists.recent)).toEqual(["offline", "machine-offline", "unknown-machine"]);
    expect(ids(buildAgentGroups(all, machines, "state").flatMap((g) => g.sessions))).toEqual(["live"]);
  });

  it("最近按更新时间倒序并限制 40 条，不修改输入数据", () => {
    const all = Array.from({ length: 50 }, (_, i) => session(String(i).padStart(2, "0"), "offline", { updated_at: date(i % 24) }));
    const before = ids(all);
    const { recent } = splitAgentSessions(all, machines);
    expect(recent).toHaveLength(40);
    expect(recent[0].updated_at).toBe(date(23));
    expect(ids(all)).toEqual(before);
  });
});

describe("sessionHost", () => {
  it("names the host from the pane ref; a bare id is herdr's", () => {
    const s = (pane_id?: string) => ({ machine_id: "m", session_id: "s", status: "idle", pane_id }) as never;
    expect(sessionHost(s("w1:p2"))).toBe("herdr");
    expect(sessionHost(s("orca:t1:l2"))).toBe("orca");
    expect(sessionHost(s("p2"))).toBe("herdr");
    expect(sessionHost(s("botmux:abc"))).toBe("botmux");
    expect(sessionHost(s("tern:42"))).toBe("tern");
    expect(sessionHost(s())).toBe("");
    expect([...hostsOf([s("p1"), s("botmux:a"), s("botmux:b"), s()])].sort()).toEqual(["botmux", "herdr"]);
    expect([...hostsOf([s("p1"), s("tern:7"), s("tern:8")])].sort()).toEqual(["herdr", "tern"]);
  });
});

describe("待你回复（#5096）", () => {
  const asking = (id: string, patch: Partial<Session> = {}) => session(id, "idle", { awaits_reply: true, asks: "要不要推到 beta？", ...patch });

  it("已看 + awaits_reply、没屏蔽才算；完成未看、屏蔽的、没标的都不算", () => {
    expect(awaitsReply(asking("a"))).toBe(true);
    expect(awaitsReply(asking("a"), mutes)).toBe(true);
    expect(awaitsReply(session("u", "unread", { awaits_reply: true }))).toBe(false);
    expect(awaitsReply(asking("muted-idle"), mutes)).toBe(false);
    expect(awaitsReply(asking("in-space", { space_name: "项目" }), mutes)).toBe(false);
    expect(awaitsReply(session("plain", "idle"))).toBe(false);
  });

  it("不算安静（不收进空闲的空间），屏蔽的照旧算安静", () => {
    expect(isQuiet(asking("a"))).toBe(false);
    expect(isQuiet(session("plain", "idle"))).toBe(true);
    expect(isQuiet(asking("muted-idle"), mutes)).toBe(true);
  });

  it("按紧急度：待你回复与需要你一并置顶，屏蔽的待你回复归入最近", () => {
    const all = [session("idle", "idle"), asking("reply"), session("working", "working"), session("unread", "unread"), session("needs", "needs_you"),
      session("waiting", "unknown", { loop: { kind: "cron" } }), session("muted-working", "working"), asking("muted-idle")];
    const groups = buildAgentGroups(all, machines, "state", mutes);
    expect(groups.map((g) => g.name)).toEqual(["需要你", "进行中", "最近", "已屏蔽"]);
    expect(ids(groups[0].sessions)).toEqual(["needs", "reply"]);
    expect(groups[0].folded).toBeFalsy();
    expect(ids(groups[2].sessions)).toEqual(["unread", "muted-idle", "idle"]);
  });

  it("组内排序（byAttention）：待你回复在完成未看之后、工作中之前", () => {
    const all = [session("idle", "idle"), session("working", "working"), asking("reply"), session("unread", "unread"), session("needs", "needs_you")];
    expect(ids(all.sort(byAttention))).toEqual(["needs", "unread", "reply", "working", "idle"]);
  });

  it("问的那句：分诊说在等你（blocked·user）时用它的 line，否则用 asks", () => {
    expect(replyAsk(asking("a"))).toBe("要不要推到 beta？");
    expect(replyAsk(asking("a", { work: { phase: "blocked", on: "user", line: "等你定 A 还是 B" } }))).toBe("等你定 A 还是 B");
    expect(replyAsk(asking("a", { work: { phase: "blocked", on: "external", line: "在等 CI" } }))).toBe("要不要推到 beta？");
    expect(replyAsk(session("plain", "idle"))).toBe("");
  });
});

describe("Just finished (#9751)", () => {
  const finished = (id: string, patch: Partial<Session> = {}) => session(id, "idle", { work: { phase: "done", line: "Merged", just_finished: true }, ...patch });

  it("is a seen agent the hub marks just finished, unless muted", () => {
    expect(justFinished(finished("a"))).toBe(true);
    expect(justFinished(finished("a"), mutes)).toBe(true);
    expect(justFinished(session("u", "unread", { work: { phase: "done", just_finished: true } }))).toBe(false);
    expect(justFinished(finished("muted-idle"), mutes)).toBe(false);
    expect(justFinished(finished("in-space", { space_name: "项目" }), mutes)).toBe(false);
    expect(justFinished(session("done", "idle", { work: { phase: "done", line: "Merged" } }))).toBe(false);
  });

  it("is not quiet, so it never folds into Idle spaces; a muted one still is", () => {
    expect(isQuiet(finished("a"))).toBe(false);
    expect(isQuiet(finished("muted-idle"), mutes)).toBe(true);
  });

  it("By status: manual just-finished leads 最近, active/waiting join 进行中", () => {
    const all = [session("idle", "idle"), finished("done"), session("working", "working"), session("sleeping", "working", { background_waiting: true }),
      session("waiting", "unknown", { loop: { kind: "cron" } }), finished("muted-idle"), session("muted-working", "working")];
    const groups = buildAgentGroups(all, machines, "state", mutes);
    expect(groups.map((g) => [g.key, ids(g.sessions)])).toEqual([
      ["state:working", ["sleeping", "waiting", "working"]], ["state:recent", ["done", "muted-idle", "idle"]],
      ["state:muted", ["muted-working"]],
    ]);
    expect(groups[1]!.name).toBe("最近");
    expect(groups[1]!.folded).toBeFalsy();
  });

  it("one a /loop wakes again stays in 进行中", () => {
    const groups = buildAgentGroups([finished("loop", { loop: { kind: "cron" } })], machines, "state", { spaces: [], sessions: [] });
    expect(groups.map((g) => g.key)).toEqual(["state:working"]);
  });

  it("ranks after Working and before the seen ones (byAttention)", () => {
    const all = [session("idle", "idle", { updated_at: date(9) }), finished("done"), session("working", "working"), session("unread", "unread")];
    expect(ids(all.sort(byAttention))).toEqual(["unread", "working", "done", "idle"]);
  });
});

describe("waiting in the background (#6045)", () => {
  it("merges cleanly into 进行中 under urgency grouping", () => {
    const all = [session("busy", "working"), session("sleeping", "working", { background_waiting: true }), session("woken", "idle", { loop: { prompt: "check" } as Session["loop"] })];
    const groups = buildAgentGroups(all, machines, "state", { spaces: [], sessions: [] });
    expect(groups.map((g) => [g.key, ids(g.sessions)])).toEqual([["state:working", ["busy", "sleeping", "woken"]]]);
  });
});
