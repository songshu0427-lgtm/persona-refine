import { t } from "../i18n";
import { backgroundWaiting, byAttention, stateOf } from "./format";
import { hubWaits } from "./work";
import type { AgentState, Machine, Session } from "./types";
import { byTime } from "./times";
import { stateName } from "./state-labels";

export type AgentGrouping = "repo" | "space" | "state" | "machine" | "todo";
export type SidebarGrouping = "state" | "repo";

export const SIDEBAR_GROUPINGS: { key: SidebarGrouping; label: string; short: string }[] = [
  { key: "state", label: t("lib-agent-groups.by_state"), short: t("lib-agent-groups.seg_state") },
  { key: "repo", label: t("lib-agent-groups.by_repo"), short: t("lib-agent-groups.seg_repo") },
];

export function sidebarGrouping(value: string | null): SidebarGrouping {
  if (value === "repo" || value === "machine" || value === "space") return "repo";
  return "state";
}

// Legacy 5-grouping metadata kept for low-level tree helpers.
export const AGENT_GROUPINGS: { key: AgentGrouping; label: string; short: string }[] = [
  { key: "todo", label: t("lib-agent-groups.by_todo"), short: t("lib-agent-groups.seg_todo") },
  { key: "machine", label: t("lib-agent-groups.by_machine"), short: t("lib-agent-groups.seg_machine") },
  { key: "repo", label: t("lib-agent-groups.by_repo"), short: t("lib-agent-groups.seg_repo") },
  { key: "space", label: t("lib-agent-groups.by_project"), short: t("lib-agent-groups.seg_project") },
  { key: "state", label: t("lib-agent-groups.by_state"), short: t("lib-agent-groups.seg_state") },
];

// the grouping this browser chose last (persona.agentGrouping, #1836); urgency-first by state until it chooses
export function agentGrouping(value: string | null): AgentGrouping {
  return AGENT_GROUPINGS.find((g) => g.key === value)?.key ?? "state";
}

const TASK_WORKTREE_RE = /[/\\]\.herdr[/\\]worktrees[/\\].*[/\\]task-todo-/;

export function isTaskWorktreePath(cwd: string | undefined): boolean {
  return Boolean(cwd && TASK_WORKTREE_RE.test(cwd));
}

export function dispatchedSessionKeys(todos: readonly { origin?: string; plan_id?: string; supervision?: unknown; agents?: readonly { machine_id: string; session_id: string }[] }[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const td of todos) {
    if (!(td.origin || td.plan_id || td.supervision) || !td.agents?.length) continue;
    for (const a of td.agents) {
      if (a.machine_id && a.session_id) out.add(`${a.machine_id}/${a.session_id}`);
      if (a.session_id) out.add(a.session_id);
    }
  }
  return out;
}

export function isDispatchedSession(s: Session, dispatchedKeys?: ReadonlySet<string>): boolean {
  if (dispatchedKeys?.has(`${s.machine_id}/${s.session_id}`) || dispatchedKeys?.has(s.session_id)) return true;
  return isTaskWorktreePath(s.cwd);
}

const CATALOG_WORKSPACE_HOSTS = new Set(["herdr", "herdr-core", "botmux", "orca", "paseo"]);

/** Native folder / desktop project sessions (Claude Desktop, Codex App, CLI history) stay inside their project folder
 *  in By repo even when stopped; workspace-catalog hosts keep their own workspace pin rules (`hasWorkspacePin`). */
export function isRepoOfflineRetained(s: Session, onlineMachineIds: ReadonlySet<string>): boolean {
  if (s.archived || !onlineMachineIds.has(s.machine_id)) return false;
  return !CATALOG_WORKSPACE_HOSTS.has(s.space_kind || s.host || sessionHost(s));
}

const REPO_ATTENTION_RANK: Record<AgentState, number> = {
  needs_you: 0,
  working: 1,
  unread: 2,
  idle: 3,
  unknown: 3,
  offline: 3,
};

/** Project-folder ordering in By repo: active attention states lead, while settled (idle/offline) sessions sort by
 *  latest activity so Claude Desktop and Codex App project histories merge chronologically. */
export function byRepoActivity(a: Session, b: Session): number {
  const ra = REPO_ATTENTION_RANK[stateOf(a)] ?? 3;
  const rb = REPO_ATTENTION_RANK[stateOf(b)] ?? 3;
  if (ra !== rb) return ra - rb;
  return byTime(b.updated_at, a.updated_at) || a.session_id.localeCompare(b.session_id) || a.machine_id.localeCompare(b.machine_id);
}

// the host kinds a pane ref may be prefixed with (keep in step with Kinds in server/internal/host/host.go); herdr's ids go bare and may hold a colon
const HOST_KINDS = ["orca", "herdr-core", "tern", "botmux"];

/** The host tool a pane belongs to, from its ref (`botmux:…`, `orca:…`, `tern:…`; anything else is herdr's); "" for none. */
export function paneHost(pane: string | undefined): string {
  if (!pane) return "";
  const kind = pane.slice(0, pane.indexOf(":"));
  return HOST_KINDS.includes(kind) ? kind : "herdr";
}

/** The host tool a session lives in, from its pane ref; "" for none. */
export function sessionHost(s: Session): string {
  return paneHost(s.pane_id);
}

/** Where an agent was opened (#2526): "feishu" for a botmux session (a Feishu group's topic), "terminal" for a pane of a
 *  terminal engine (herdr, the Herdr App's, Orca's and Tern's terminals), "desktop" for a desktop app's own chat (a
 *  Codex App thread, an Orca native chat, a Paseo agent); undefined for the rest (other runtimes, history no host
 *  lists), which carry no mark. */
export type SessionSource = "feishu" | "terminal" | "desktop";

export function sessionSource(s: Session): SessionSource | undefined {
  if (s.space_kind === "codex_app" || s.space_kind === "claude_desktop" || s.host === "paseo" || s.host === "cindy" || (s.source_kind === "runtime" && s.source_instance_id === "orca")) return "desktop";
  const host = sessionHost(s);
  if (host === "botmux") return "feishu";
  return host ? "terminal" : undefined;
}

/** A source's name: its mark's tooltip and what a screen reader says for it. */
export function sourceName(source: SessionSource): string {
  return t(`lib-agent-groups.source_${source}`);
}

/** The hosts a list's sessions run in, so a row names its host only when there is more than one. */
export function hostsOf(sessions: Session[]): Set<string> {
  return new Set(sessions.map(sessionHost).filter(Boolean));
}

export interface AgentMutes {
  spaces: string[];
  sessions: string[];
  allowed?: string[];
}

export interface AgentGroup {
  key: string;
  name: string;
  sessions: Session[];
  state?: AgentState;
  /** Its agents only wait on background commands (#6045): drawn with the waiting mark. */
  waiting?: boolean;
  folded?: boolean;
  initialLimit?: number;
  todoId?: string;
  todoStatus?: string;
  /** What the group is and why its agents are in it, for a name that does not say it alone (a tooltip). */
  hint?: string;
}

export function splitAgentSessions(all: Session[], machines: Machine[], keepOffline?: (s: Session) => boolean, keepRecent?: (s: Session) => boolean) {
  const online = new Set(machines.filter((m) => m.online).map((m) => m.id));
  const agents = all.filter((s) => !s.assistant);
  const live = agents.filter((s) => (stateOf(s) !== "offline" && online.has(s.machine_id)) || keepOffline?.(s));
  const listed = new Set(live);
  const sortedOffline = agents
    .filter((s) => !listed.has(s))
    .sort((a, b) => byTime(b.updated_at, a.updated_at) || a.machine_id.localeCompare(b.machine_id) || a.session_id.localeCompare(b.session_id));
  const recent = keepRecent
    ? sortedOffline.filter((s, idx) => idx < 40 || keepRecent(s))
    : sortedOffline.slice(0, 40);
  return { live, recent };
}

export interface Space {
  key: string;
  machineId: string;
  name: string;
  sessions: Session[];
}

/** Live agents by herdr space, in herdr's order (machine, workspace, tab); agents outside any space are `loose`. The
 * sidebar keeps that order: rows that jump around as agents change state are hard to click. */
export function buildSpaces(live: Session[], machines: Machine[]): { spaces: Space[]; loose: Session[] } {
  const map = new Map<string, Space>();
  const loose: Session[] = [];
  for (const s of live) {
    if (!s.space_id) {
      loose.push(s);
      continue;
    }
    const key = `${s.machine_id}/${s.space_id}`;
    if (!map.has(key)) map.set(key, { key, machineId: s.machine_id, name: s.space_name || s.space_id, sessions: [] });
    map.get(key)!.sessions.push(s);
  }
  const order = (m: string) => machines.findIndex((x) => x.id === m);
  const bySlot = (a: Session, b: Session) => (a.slot_index ?? 0) - (b.slot_index ?? 0) || a.session_id.localeCompare(b.session_id);
  const spaces = [...map.values()].map((sp) => ({ ...sp, index: sp.sessions[0]?.space_index ?? 0, sessions: sp.sessions.sort(bySlot) }));
  spaces.sort((a, b) => order(a.machineId) - order(b.machineId) || a.index - b.index || a.name.localeCompare(b.name));
  return { spaces: spaces.map(({ index: _index, ...sp }) => sp), loose: loose.sort(byAttention) };
}

export function isWaiting(s: Session): boolean {
  const waiting = typeof s.waiting === "boolean" ? s.waiting
    : Boolean(s.loop || s.background?.length || s.subagents?.some((a) => a.running) || s.workflows?.some((w) => w.running) || hubWaits(s.work));
  return ["idle", "unknown"].includes(stateOf(s)) && waiting;
}

const NO_MUTES: AgentMutes = { spaces: [], sessions: [] };

/** Awaiting Reply (#5096, docs/protocol/agent-states.md): seen, but it stopped on a question to the user nobody has answered yet
 *  (`awaits_reply`), and not muted. Such an agent is not quiet: it never folds into Idle Spaces. */
export function awaitsReply(s: Session, mutes: AgentMutes = NO_MUTES): boolean {
  return stateOf(s) === "idle" && Boolean(s.awaits_reply) && !isMuted(s, mutes);
}

/** Just finished (#9751, docs/protocol/agent-states.md): seen as far as its state goes, but the hub's triage found its turn
 *  done before anybody looked, less than three hours ago (`work.just_finished`), and not muted. Such an agent is not
 *  quiet: it never folds into Idle Spaces. */
export function justFinished(s: Session, mutes: AgentMutes = NO_MUTES): boolean {
  return stateOf(s) === "idle" && Boolean(s.work?.just_finished) && !isMuted(s, mutes);
}

/** What an Awaiting Reply agent asks: what the triage says it waits for (blocked on the user), else the question its last reply
 *  put to the user; "" when neither says. */
export function replyAsk(s: Session): string {
  const w = s.work;
  if (w?.phase === "blocked" && w.on === "user" && w.line?.trim()) return w.line.trim();
  return s.asks?.trim() ?? "";
}

/** Nothing to look at: seen (or unknown), not waiting on the hub or itself, not waiting for the user's reply, and not
 *  just finished. */
export function isQuiet(s: Session, mutes: AgentMutes = NO_MUTES): boolean {
  return ["idle", "unknown"].includes(stateOf(s)) && !isWaiting(s) && !awaitsReply(s, mutes) && !justFinished(s, mutes);
}

function isMuted(s: Session, mutes: AgentMutes): boolean {
  const key = `${s.machine_id}/${s.session_id}`;
  if (mutes.sessions.includes(key)) return true;
  if (mutes.allowed?.includes(key)) return false;
  return Boolean(s.space_name && mutes.spaces.includes(`${s.machine_id}/${s.space_name}`));
}

function byDate(a: Session, b: Session): number {
  const date = (s: Session) => (stateOf(s) === "working" ? s.state_since || s.updated_at : s.updated_at) ?? "";
  return byTime(date(b), date(a)) || a.session_id.localeCompare(b.session_id) || a.machine_id.localeCompare(b.machine_id);
}

// Urgency + source hierarchy: 需要你 → 进行中 → 派出任务 (Persona-dispatched tasks, unfolded with cap) → 最近 (manual
// chats, unfolded with cap) → 已屏蔽 (folded).
export function buildAgentGroups(all: Session[], machines: Machine[], _grouping: "state", mutes: AgentMutes = { spaces: [], sessions: [] }, offlineRecent: Session[] = [], dispatchedKeys?: ReadonlySet<string>): AgentGroup[] {
  const { live } = splitAgentSessions(all, machines);
  const groups: AgentGroup[] = [
    { key: "state:needs", name: stateName("needs_you"), state: "needs_you", sessions: [] },
    { key: "state:working", name: t("sidebar.in_progress"), state: "working", sessions: [] },
    { key: "state:dispatched-tasks", name: t("sidebar.dispatched_done"), state: "idle", sessions: [], initialLimit: 5 },
    { key: "state:recent", name: t("sidebar.recent_chats"), sessions: [], initialLimit: 8 },
    { key: "state:muted", name: t("lib-agent-groups.state_muted"), sessions: [], folded: true },
  ];
  for (const s of live) {
    const state = stateOf(s);
    const waiting = isWaiting(s);
    const dispatched = isDispatchedSession(s, dispatchedKeys);
    const index = state === "needs_you" || awaitsReply(s, mutes) ? 0
      : isMuted(s, mutes) && (state === "working" || state === "unread" || waiting) ? 4
      : state === "working" || backgroundWaiting(s) || waiting ? 1
      : dispatched ? 2
      : 3;
    groups[index].sessions.push(s);
  }
  for (const s of offlineRecent) {
    groups[isDispatchedSession(s, dispatchedKeys) ? 2 : 3].sessions.push(s);
  }
  return groups.filter((g) => g.sessions.length).map((g) => ({
    ...g,
    sessions: g.key === "state:recent" ? g.sessions.sort(byAttention) : g.sessions.sort(byDate),
  }));
}
