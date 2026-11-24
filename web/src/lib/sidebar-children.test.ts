import { describe, expect, it } from "vitest";
import { sidebarSessionChildren } from "./side-sessions";
import type { Session } from "./types";

const row = (id: string, extra: Partial<Session> = {}): Session => ({ machine_id: "mac", session_id: id, title: id, cwd: "/code", status: "idle", state: "idle", ...extra });

describe("sidebar children", () => {
  it("nests side sessions and subagents once, including legacy parents and descendants", () => {
    const parent = row("parent");
    const side = row("side", { folded_under: "parent", folded_as: "side" });
    const legacy = row("legacy", { parent_agent_id: "parent" });
    const child = row("child", { folded_under: "parent", is_subagent: true });
    const grandchild = row("grandchild", { parent_agent_id: "side" });
    const result = sidebarSessionChildren([parent, side, legacy, grandchild], [parent, side, legacy, child, grandchild]);
    expect(result.roots).toEqual([parent]);
    expect(result.children.get("mac/parent")?.map((s) => s.session_id).sort()).toEqual(["child", "grandchild", "legacy", "side"]);
  });

  it("keeps orphans, other machines and cycles visible and omits archived children", () => {
    const parent = row("parent");
    const side = row("side", { parent_agent_id: "parent" });
    expect(sidebarSessionChildren([side], [parent, side]).roots).toEqual([side]);
    const other = row("other", { machine_id: "remote", parent_agent_id: "parent" });
    const a = row("a", { parent_agent_id: "b" });
    const b = row("b", { parent_agent_id: "a" });
    const archived = row("archived", { parent_agent_id: "parent", archived: true });
    const result = sidebarSessionChildren([parent, other, a, b], [parent, other, a, b, archived]);
    expect(result.roots).toEqual([parent, other, a, b]);
    expect(result.children.size).toBe(0);
  });
});
