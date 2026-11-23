package assistant

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/nwverse/persona/server/internal/proto"
)

// Project directories expand "~/" to the machine's home, whereas an omitted cwd or a bare home directory (~ / Home /
// HomeReal) redirects into ~/.persona/scratch/<id> so Agent sessions never clutter the user's top-level home folder.
func TestPlaceTaskExpandsProjectAndRedirectsBareHomeToScratch(t *testing.T) {
	ctx := context.Background()
	s := newTestService(t, claudeMDHub(
		Device{ID: "mac", Name: "Mac", Kind: "local", Home: "/Users/example"},
		Device{ID: "box", Name: "Box", Kind: "ssh", Home: "/home/example", HomeReal: "/data00/home/example"},
	))
	for in, want := range map[string]string{
		"~/src/app": "/Users/example/src/app",
		"/srv/app":  "/srv/app",
	} {
		task := PlanTask{Machine: "Mac", Cwd: in, ReservedTodoID: "todo_fixed"}
		if !s.placeTask(ctx, &task) {
			t.Fatalf("placeTask(%q): machine not found", in)
		}
		if task.Machine != "mac" || task.Cwd != want {
			t.Errorf("placeTask(%q) = %s %q, want mac %q", in, task.Machine, task.Cwd, want)
		}
	}
	for _, in := range []string{"", "~", "~/", "/Users/example", "/Users/example/"} {
		task := PlanTask{Machine: "Mac", Cwd: in, ReservedTodoID: "todo_fixed"}
		if !s.placeTask(ctx, &task) {
			t.Fatalf("placeTask(%q): machine not found", in)
		}
		want := "/Users/example/.persona/scratch/todo_fixed"
		if task.Machine != "mac" || task.Cwd != want {
			t.Errorf("placeTask(%q) = %s %q, want mac %q", in, task.Machine, task.Cwd, want)
		}
	}
	for _, in := range []string{"", "~", "/home/example", "/data00/home/example"} {
		task := PlanTask{Machine: "Box", Cwd: in, ReservedTodoID: "todo_link"}
		if !s.placeTask(ctx, &task) {
			t.Fatalf("placeTask(%q): machine not found", in)
		}
		want := "/home/example/.persona/scratch/todo_link"
		if task.Machine != "box" || task.Cwd != want {
			t.Errorf("placeTask(%q) = %s %q, want box %q", in, task.Machine, task.Cwd, want)
		}
	}
	if task := (PlanTask{Machine: "nowhere", Cwd: "~"}); s.placeTask(ctx, &task) {
		t.Error("placeTask placed a task on an unknown machine")
	}
}

func TestTaskPlanAndAgentStartRedirectOmittedAndBareHomeToScratch(t *testing.T) {
	s, f := newQuietService(t)
	s.briefsOptional = true
	f.devices = []Device{{ID: "mac", Name: "Mac", Kind: "local", Online: true, Reachable: true, Home: "/Users/example"}}
	f.sessions["mac"] = nil
	f.launcherList = []proto.Launcher{{Name: "claude", Agent: "claude"}}
	ctx := context.Background()

	// 1. task_plan with omitted cwd and bare "~" cwd starts both sessions under ~/.persona/scratch/<todo_id>.
	planArgs := `{"tasks":[
		{"title":"非仓库调研","prompt":"整理临时调研结果","machine":"mac","readonly":true,"user_requested":true,"why":"无代码仓库"},
		{"title":"误传主目录","prompt":"生成临时对比脚本","machine":"mac","cwd":"~","readonly":true,"user_requested":true,"why":"主目录保护"}
	]}`
	res := s.mcpCall(ctx, "server", "conv1", "task_plan", json.RawMessage(planArgs), true)
	if res.IsError {
		t.Fatalf("task_plan failed: %+v", res.Content)
	}
	waitFor(t, "2 scratch tasks started", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.starts) == 2
	})
	f.mu.Lock()
	starts := append([]map[string]any(nil), f.starts...)
	preparedCount := len(f.guestPrepared)
	f.mu.Unlock()
	for i, st := range starts {
		got, _ := st["cwd"].(string)
		if !strings.HasPrefix(got, "/Users/example/.persona/scratch/todo_") {
			t.Fatalf("task %d cwd = %q, want /Users/example/.persona/scratch/todo_*", i+1, got)
		}
	}
	if preparedCount != 2 {
		t.Fatalf("scratch directories prepared = %d, want 2", preparedCount)
	}

	// 2. agent_start with omitted cwd starts in ~/.persona/scratch/agent_*, while worktree without a repo cwd is refused.
	refused := s.mcpCall(ctx, "server", "conv1", "agent_start", json.RawMessage(`{"machine":"mac","prompt":"branch","worktree":{"branch":"feat/x"}}`), true)
	if !refused.IsError || !strings.Contains(refused.Content[0].Text, "worktree requires a Git repository") {
		t.Fatalf("worktree without repo cwd was not refused: %+v", refused)
	}
	started := s.mcpCall(ctx, "server", "conv1", "agent_start", json.RawMessage(`{"machine":"mac","prompt":"quick scratch check"}`), true)
	if started.IsError {
		t.Fatalf("agent_start without cwd failed: %+v", started.Content)
	}
	f.mu.Lock()
	lastCwd, _ := f.starts[len(f.starts)-1]["cwd"].(string)
	f.mu.Unlock()
	if !strings.HasPrefix(lastCwd, "/Users/example/.persona/scratch/agent_") {
		t.Fatalf("agent_start cwd = %q, want /Users/example/.persona/scratch/agent_*", lastCwd)
	}
}
