import type { Item } from "../types";

/** Synthetic Node projection: one revision per physical seq, source ordinal in the numeric block suffix. */
export function codexSnapshot(seq: number, phase: "live" | "updated" | "final" | "interrupted" = "live"): Item[] {
  const item = (source: string, block: number, fields: Omit<Item, "id" | "seq">): Item => ({ id: `history:fixture-turn:${source}#${block}`, seq, ...fields });
  const items = [
    item("user", 0, { role: "user", kind: "text", text: "Check the export", client_msg_id: "fixture-send" }),
    item("agent", 1_000_000, { role: "assistant", kind: "text", text: phase === "live" ? "Checking." : "Checking the encoder." }),
    item("tool", 2_000_000, { role: "assistant", kind: "tool_use", tool_use_id: "fixture-tool", tool_name: "Bash", tool_input: { command: "pwd" } }),
    item("tool", 2_000_001, { role: "user", kind: "tool_result", tool_use_id: "fixture-tool", text: "/project", outcome: { status: "completed", exit_code: 0 } }),
  ];
  if (phase !== "live") items.push(item("next", 10_000_000, { role: "assistant", kind: "text", text: "The tool returned." }));
  if (phase === "final") items.push({ id: "history:fixture-turn:end#9000000000000", seq, role: "system", kind: "turn_duration", turn_duration: { duration_ms: 5000 } } as unknown as Item);
  // i18n-ignore: matches the existing transcript interruption notice.
  if (phase === "interrupted") items.push(item("end", 9_000_000_000_000, { role: "system", kind: "notice", text: "用户中断" }));
  return items;
}
