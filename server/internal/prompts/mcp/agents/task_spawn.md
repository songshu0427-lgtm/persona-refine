Start a separate coding Agent only to hand a genuinely separate part of your current supervised task (or a context handoff) to a new session on your current computer and directory; never hand over all of your assignment, do routine or single-command work yourself, and prefer bounded in-session subagents for helper lookups. The child joins the SAME to-do with the SAME supervisor and works in your directory with your permissions, reporting to your supervisor rather than to you: leave the files it changes alone, and do not poll it, read its transcript or wait for it. Depth limit is 1 (already-spawned sessions and a task leader's workers cannot call `task_spawn`), at most one spawned session may work concurrently on a to-do, and at most two spawned sessions are allowed per to-do. Use this instead of a runtime's standalone new-conversation tool (for example Codex create_thread). Title and prompt must describe work within the existing assignment; ask your supervisor for an unrelated task. The server chooses the task, parent, launcher and permission from your verified assignment, never from arguments. Unknown permission stays read-only. The result names the child session, to-do and supervisor. Do not retry a start with an uncertain result.

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "description": "Short title for this part of the existing task"
    },
    "prompt": {
      "type": "string",
      "description": "Self-contained assignment within the current task; include what evidence to return"
    }
  },
  "required": ["title", "prompt"],
  "additionalProperties": false
}
```
