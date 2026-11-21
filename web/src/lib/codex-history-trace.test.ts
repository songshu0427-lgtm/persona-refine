import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatLines, mergeItems, segments } from "./turns";
import type { Item } from "./types";
import { codexSnapshot } from "./testdata/codex-snapshot";

// Optional isolated Node watch-pipe trace; the normal suite always runs the same assertions on the built-in fixture.
const path = process.env.PERSONA_CODEX_HISTORY_TRACE;
const trace: { initial: Item[]; pushes: Item[]; final: Item[] } = path ? JSON.parse(readFileSync(path, "utf8")) : {
  initial: codexSnapshot(10), pushes: [...codexSnapshot(11, "updated"), ...codexSnapshot(12, "final")], final: codexSnapshot(12, "final"),
};

describe(path ? "isolated Node watch trace → Web" : "built-in Codex watch trace → Web", () => {
  it("merges initial plus incremental snapshots into the final page with identical IDs, values and order", () => {
    expect(trace.initial.length).toBeGreaterThan(0);
    expect(trace.pushes.length).toBeGreaterThan(0);
    let page = mergeItems([], trace.initial);
    const revisions = new Map<number, Item[]>();
    for (const item of trace.pushes) revisions.set(item.seq, [...(revisions.get(item.seq) ?? []), item]);
    for (const batch of revisions.values()) {
      page = mergeItems(page, batch);
      expect(new Set(page.map((i) => i.id)).size).toBe(page.length);
    }
    expect(page).toEqual(trace.final);
    for (let replay = 0; replay < 3; replay++) page = mergeItems(page, trace.final);
    expect(page).toEqual(trace.final);
    expect(mergeItems(page, trace.initial)).toEqual(trace.final);
    expect(segments(page)).toEqual(segments(trace.final));
    expect(chatLines(page)).toEqual(chatLines(trace.final));
  });
});
