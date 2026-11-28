package assistant

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/prompts"
	"github.com/nwverse/persona/server/internal/proto"
)

func enableRouterModeForTest(t *testing.T, s *Service) {
	t.Helper()
	on := true
	s.routerOverride = &on
	oldDelay := routerNoticeDelay
	routerNoticeDelay = 20 * time.Millisecond
	t.Cleanup(func() {
		routerNoticeDelay = oldDelay
		s.routerOverride = nil
	})
}

func TestRouterModeToolsPromptAndSupervisionDisabled(t *testing.T) {
	ctx := context.Background()
	s, _ := newQuietService(t)
	enableRouterModeForTest(t, s)

	// 1. Heavy plan/review/supervision tools are absent, while core dispatch and standalone personal todo tools remain.
	tools := s.Tools(ctx)
	have := map[string]bool{}
	for _, tl := range tools {
		have[tl.Name] = true
	}
	for _, want := range []string{"agents_list", "agent_read", "agent_send", "agent_start", "agent_interrupt", "todo_list", "todo_create", "todo_complete", "ask_user", "notify_user", "schedule_followup", "kb_search"} {
		if !have[want] {
			t.Fatalf("router mode missing essential tool %q", want)
		}
	}
	for _, forbidden := range []string{"task_plan", "task_review", "task_scope", "agent_supervise", "supervision_finish", "concern_report", "direction_name", "leader_progress"} {
		if have[forbidden] {
			t.Fatalf("router mode exposed excluded tool %q", forbidden)
		}
	}

	// 2. Direct calls to excluded plan/review tools (e.g. from resumed chat memory) are refused cleanly.
	for _, name := range []string{"task_plan", "task_review", "agent_supervise"} {
		res := s.Tool(ctx, ToolCall{MachineID: "server", SessionID: "conv1", Name: name, Arguments: json.RawMessage(`{}`)})
		if !res.IsError || !strings.Contains(res.Content[0].Text, "Router mode") {
			t.Fatalf("Tool(%q) = %+v, want router-mode refusal", name, res)
		}
	}

	// 3. Compact Router prompt (< 5 KB) replaces monolithic CLAUDE.md and omits task_plan/task_review workflows.
	md := s.claudeMD(ctx, "server", false)
	if len(md) > 5000 {
		t.Fatalf("router prompt too large: %d bytes", len(md))
	}
	if !strings.Contains(md, "Persona Router") || !strings.Contains(md, "agent_send") {
		t.Fatalf("router prompt missing core identity/dispatch rules: %q", md)
	}
	if strings.Contains(md, "task_plan") || strings.Contains(md, "task_review") {
		t.Fatalf("router prompt still mentions task_plan or task_review")
	}

	// 4. Supervision policy and background supervisor are disabled.
	p := map[string]any{}
	if err := s.putSupervisionInstructions(ctx, "server", "conv1", p); err != nil {
		t.Fatal(err)
	}
	if got, _ := p["supervision_instructions"].(string); got != "" {
		t.Fatalf("supervision_instructions = %q, want empty in router mode", got)
	}
	if s.backgroundOn(s.settings(ctx)) {
		t.Fatal("backgroundOn = true in router mode, want false")
	}
}

func TestRouterSnapshotStripsTodosPlansAndApprovals(t *testing.T) {
	in := prompts.Snapshot{
		Machines:         []prompts.SnapshotMachine{{ID: "mac-local", Name: "Mac", Online: true}},
		Working:          []prompts.SnapshotAgent{{Label: "Desktop Chat", Machine: "Mac", Session: "agy-1"}},
		Tasks:            []prompts.SnapshotTask{{ID: "t1", Title: "Old task"}},
		OpenTodos:        []prompts.SnapshotOpenTodo{{ID: "t1", Title: "Old todo"}},
		OpenTodosTotal:   5,
		OpenTodosLoaded:  true,
		Plans:            []prompts.SnapshotPlan{{ID: "p1", Titles: []string{"Plan A"}, Tasks: 1}},
		PlansTotal:       1,
		Asked:            []prompts.SnapshotAsked{{TodoID: "t1", Question: "Q?"}},
		Unaccepted:       []prompts.SnapshotAccept{{Title: "Verify"}},
		UnacceptedTotal:  1,
		Approvals:        []prompts.SnapshotApproval{{ID: "a1", Title: "Deploy"}},
		FollowingEnabled: true,
		Following:        []prompts.SnapshotFollowing{{Title: "Inbox item"}},
		FollowingTotal:   1,
	}
	out := routerSnapshot(in)
	if len(out.Machines) != 1 || len(out.Working) != 1 || len(out.OpenTodos) != 1 || out.OpenTodosTotal != 5 || !out.OpenTodosLoaded {
		t.Fatalf("routerSnapshot dropped live machines/agents or personal todos: %+v", out)
	}
	if len(out.Tasks) != 0 ||
		len(out.Plans) != 0 || out.PlansTotal != 0 || len(out.Asked) != 0 ||
		len(out.Unaccepted) != 0 || out.UnacceptedTotal != 0 || len(out.Approvals) != 0 ||
		out.FollowingEnabled || len(out.Following) != 0 || out.FollowingTotal != 0 {
		t.Fatalf("routerSnapshot retained task/plan/review state: %+v", out)
	}
}

func TestRouterModeAgentSendAutoReportsDesktopCompletionWithoutTodo(t *testing.T) {
	ctx := context.Background()
	s, f := newQuietService(t)
	enableRouterModeForTest(t, s)

	desktop := proto.Session{
		SessionID:    "agy-desktop-1",
		MachineID:    "box",
		Title:        "Top1000 Review",
		Agent:        "antigravity-desktop",
		SourceKind:   proto.SourceRuntime,
		Status:       proto.StatusIdle,
		State:        proto.StateIdle,
		UpdatedAt:    time.Now().Add(-time.Minute),
		Capabilities: &proto.SessionCapabilities{Read: true, Send: true},
	}
	f.setSessions("box", desktop)
	f.items = []proto.Item{
		{Role: "user", Kind: "text", Text: "帮我检查一下报错"},
		{Role: "assistant", Kind: "text", Text: "已经定位并修好，测试全绿。"},
	}

	// Main chat sends directly to Mac Desktop session (even if a legacy `task` arg were passed, no todo is created).
	out, err := s.runTool(ctx, "server", "conv1", "agent_send", json.RawMessage(`{
		"machine":"box",
		"session_id":"agy-desktop-1",
		"text":"帮我检查一下报错",
		"task":{"title":"Should be ignored"}
	}`))
	if err != nil {
		t.Fatalf("agent_send failed: %v", err)
	}
	if !strings.Contains(out, "watching for completion") {
		t.Fatalf("agent_send output = %q, want watching note", out)
	}
	s.todos.mu.RLock()
	todoCount := len(s.todos.todos)
	s.todos.mu.RUnlock()
	if todoCount != 0 {
		t.Fatalf("router mode agent_send created %d todo(s), want 0", todoCount)
	}

	// Desktop session transitions idle -> working -> idle (unread).
	working := desktop
	working.Status = proto.StatusWorking
	working.State = proto.StateWorking
	f.setSessions("box", working)
	s.SessionsChanged(ctx, DeviceSessions{MachineID: "box", Sessions: []proto.Session{working}})

	done := desktop
	done.Status = proto.StatusIdle
	done.State = proto.StateUnread
	done.UpdatedAt = time.Now()
	f.setSessions("box", done)
	s.SessionsChanged(ctx, DeviceSessions{MachineID: "box", Sessions: []proto.Session{done}})

	// Wait for debounced router wake-up notice to arrive in main conversation conv1.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if list := f.notices(); len(list) > 0 {
			got := list[len(list)-1]
			if !strings.Contains(got, "[Agent 进展]") || !strings.Contains(got, "Top1000 Review") || !strings.Contains(got, "已经定位并修好") {
				t.Fatalf("unexpected router wake-up text: %q", got)
			}
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("timed out waiting for router completion wake-up in main conversation")
}

func TestRouterModeAgentSendAutoReportsNeedsYou(t *testing.T) {
	ctx := context.Background()
	s, f := newQuietService(t)
	enableRouterModeForTest(t, s)

	herdr := proto.Session{
		SessionID:    "claude-herdr-1",
		MachineID:    "box",
		Title:        "DevBox Build",
		Agent:        "claude",
		Status:       proto.StatusWorking,
		State:        proto.StateWorking,
		UpdatedAt:    time.Now(),
		Capabilities: &proto.SessionCapabilities{Read: true, Send: true},
	}
	f.setSessions("box", herdr)
	if _, err := s.runTool(ctx, "server", "conv1", "agent_send", json.RawMessage(`{"machine":"box","session_id":"claude-herdr-1","text":"继续跑发布"}`)); err != nil {
		t.Fatalf("agent_send failed: %v", err)
	}

	needs := herdr
	needs.Status = proto.StatusBlocked
	needs.State = proto.StateNeedsYou
	f.setSessions("box", needs)
	s.SessionsChanged(ctx, DeviceSessions{MachineID: "box", Sessions: []proto.Session{needs}})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if list := f.notices(); len(list) > 0 {
			got := list[len(list)-1]
			if !strings.Contains(got, "[Agent 进展]") || !strings.Contains(got, "正在等待你确认/回复") {
				t.Fatalf("unexpected needs-you wake-up text: %q", got)
			}
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("timed out waiting for router needs-you wake-up in main conversation")
}
