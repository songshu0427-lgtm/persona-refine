//go:build !windows

package node

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/nodeproto"
	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/screen"
)

func TestOutsideClaudePermissionBridgeAllowDenyPlanAndCancel(t *testing.T) {
	n, f, home := herdrNode(t)
	noPaneEnv(t)
	f.reply("session.snapshot", snapshot(nil, nil, nil, nil))
	p := bgTranscript(t, home, home, sidA, "run project checks")
	inbox := newFakeInbox(t, p)
	writeOutsideClaude(t, home, sidA, "claude-desktop-3p", "waiting", inbox, nil)
	client := pluginSocket(t, n)

	// 1. Standard tool permission with short poll ('pending') -> reconnect -> mobile Allow + Always.
	status, first := pluginPost(t, client, "permission", map[string]any{
		"session_id":      sidA,
		"request_id":      "req_bash_1",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "npm test"},
		"cwd":             home,
		"permission_mode": "default",
		"wait_ms":         30,
	})
	if status != 200 || first["status"] != "pending" {
		t.Fatalf("first poll: status=%d body=%+v", status, first)
	}

	cards := n.outsidePermCards()
	if len(cards) != 1 || cards[0].Kind != proto.IxPermission || cards[0].ToolName != "Bash" ||
		!strings.HasPrefix(cards[0].ID, outsidePermPrefix) || cards[0].AlwaysLabel != "本会话都允许 Bash" {
		t.Fatalf("expected open permission card, got %+v", cards)
	}
	cardID := cards[0].ID

	row := byID(listSessions(t, n))[sidA]
	if row.Status != proto.StatusBlocked || row.Capabilities == nil || !row.Capabilities.Approve ||
		!strings.HasPrefix(row.AttentionReason, "等待确认：") {
		t.Fatalf("session row while permission open: %+v caps=%+v", row, row.Capabilities)
	}

	// Answer from mobile right inside the reconnect gap before the second poll arrives!
	allow := true
	if _, err := request(t, n, "codex.answer", map[string]any{
		"session_id": sidA,
		"id":         cardID,
		"resolution": proto.Resolution{Allow: &allow, Always: true},
	}); err != nil {
		t.Fatalf("codex.answer allow: %v", err)
	}

	status, second := pluginPost(t, client, "permission", map[string]any{
		"session_id":      sidA,
		"request_id":      "req_bash_1",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "npm test"},
		"cwd":             home,
		"permission_mode": "default",
		"wait_ms":         1000,
	})
	if status != 200 || second["status"] != "decided" {
		t.Fatalf("second poll after mobile allow: status=%d body=%+v", status, second)
	}
	dec, _ := second["decision"].(map[string]any)
	if dec["behavior"] != "allow" || dec["updatedPermissions"] == nil {
		t.Fatalf("unexpected allow decision payload: %+v", dec)
	}
	if left := n.outsidePermCards(); len(left) != 0 {
		t.Fatalf("decided card should be removed, got %+v", left)
	}

	// 2. ExitPlanMode approval while a long-poll is actively waiting.
	type pollRes struct {
		status int
		body   map[string]any
	}
	planDone := make(chan pollRes, 1)
	go func() {
		st, out := pluginPost(t, client, "permission", map[string]any{
			"session_id":      sidA,
			"request_id":      "req_plan_1",
			"tool_name":       "ExitPlanMode",
			"tool_input":      map[string]any{"plan": "1. Build\n2. Test"},
			"cwd":             home,
			"permission_mode": "plan",
			"wait_ms":         5000,
		})
		planDone <- pollRes{st, out}
	}()

	var planCard proto.Interaction
	waitFor(t, "plan permission card", func() bool {
		if cs := n.outsidePermCards(); len(cs) == 1 {
			planCard = cs[0]
			return true
		}
		return false
	})
	if planCard.Kind != proto.IxPlan || planCard.Plan != "1. Build\n2. Test" {
		t.Fatalf("expected plan card, got %+v", planCard)
	}
	if s := byID(listSessions(t, n))[sidA]; s.AttentionReason != "等待确认计划" {
		t.Fatalf("plan attention reason=%q, want 等待确认计划", s.AttentionReason)
	}
	approve := true
	if _, err := request(t, n, "codex.answer", map[string]any{
		"session_id": sidA,
		"id":         planCard.ID,
		"resolution": proto.Resolution{Approve: &approve, Mode: proto.ModeBypass},
	}); err != nil {
		t.Fatalf("codex.answer plan approve: %v", err)
	}
	gotPlan := <-planDone
	if gotPlan.status != 200 || gotPlan.body["status"] != "decided" {
		t.Fatalf("plan poll result: %+v", gotPlan)
	}

	// 3. Cancel from computer removes card and causes late mobile answer to return PromptChanged.
	_, _ = pluginPost(t, client, "permission", map[string]any{
		"session_id": sidA,
		"request_id": "req_cancel_1",
		"tool_name":  "Edit",
		"tool_input": map[string]any{"file_path": "/tmp/a.go"},
		"wait_ms":    20,
	})
	cancelCards := n.outsidePermCards()
	if len(cancelCards) != 1 {
		t.Fatalf("expected cancel test card, got %+v", cancelCards)
	}
	_, _ = pluginPost(t, client, "permission", map[string]any{
		"session_id": sidA,
		"request_id": "req_cancel_1",
		"cancel":     true,
	})
	if len(n.outsidePermCards()) != 0 {
		t.Fatalf("cancelled card should be gone")
	}
	deny := false
	if _, err := request(t, n, "codex.answer", map[string]any{
		"session_id": sidA,
		"id":         cancelCards[0].ID,
		"resolution": proto.Resolution{Allow: &deny},
	}); refusalCode(err) != screen.PromptChanged {
		t.Fatalf("expected PromptChanged after computer cancel, got %v", err)
	}

	// 4. Outside tmux session passes through so tmux screen reader handles its dialog without duplicate cards.
	writeOutsideClaude(t, home, sidA, "cli", "waiting", inbox, map[string]any{"tmux": "orc:@1.%1"})
	st, pass := pluginPost(t, client, "permission", map[string]any{
		"session_id": sidA,
		"request_id": "req_tmux_1",
		"tool_name":  "Bash",
		"tool_input": map[string]any{"command": "ls"},
		"wait_ms":    100,
	})
	if st != 200 || pass["status"] != "passthrough" {
		t.Fatalf("tmux outside session should passthrough, got status=%d body=%+v", st, pass)
	}
}

func TestStalledDesktopHostMCPAllowsRemoteInterruptAndSteer(t *testing.T) {
	n, f, home := herdrNode(t)
	noPaneEnv(t)
	f.reply("session.snapshot", snapshot(nil, nil, nil, nil))
	p := bgTranscript(t, home, home, sidA, "open preview")
	stalled := time.Now().Add(-15 * time.Second).UTC().Format(time.RFC3339Nano)
	appendLines(t, p, fmt.Sprintf(`{"type":"assistant","uuid":"u-stall","timestamp":%q,"entrypoint":"claude-desktop-3p","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_prev","name":"mcp__Claude_Browser__preview_start","input":{"name":"demo-web"}}]}}`, stalled))

	inbox := newFakeInbox(t, p)
	writeOutsideClaude(t, home, sidA, "claude-desktop-3p", "busy", inbox, nil)
	client := pluginSocket(t, n)

	// Start a plugin poll loop advertising busy_input + interrupt and acknowledging both.
	ctx, cancel := context.WithCancel(context.Background())
	loopDone := make(chan struct{})
	t.Cleanup(func() { cancel(); <-loopDone })
	interrupted := make(chan string, 1)
	queuedMsg := make(chan string, 1)
	postCtx := func(what string, body map[string]any) (int, map[string]any, bool) {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://persona/claude-plugin/v1/"+what, strings.NewReader(string(b)))
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			return 0, nil, false
		}
		defer res.Body.Close()
		out := map[string]any{}
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out, true
	}
	go func() {
		defer close(loopDone)
		for ctx.Err() == nil {
			st, out, ok := postCtx("poll", map[string]any{
				"session_id":     sidA,
				"plugin_version": "0.4.0",
				"engine_version": "2.1.326",
				"capabilities":   []string{"settings", "busy_input", "interrupt", "permission_bridge"},
				"wait_ms":        500,
			})
			if !ok || st != 200 {
				return
			}
			if rawInt, ok := out["interrupt"].(map[string]any); ok && rawInt["id"] != nil {
				id, _ := rawInt["id"].(string)
				_, _, _ = postCtx("ack", map[string]any{"session_id": sidA, "id": id, "submitted": true})
				select {
				case interrupted <- id:
				default:
				}
			}
			if msgs, ok := out["messages"].([]any); ok {
				for _, m := range msgs {
					rec, _ := m.(map[string]any)
					id, _ := rec["id"].(string)
					txt, _ := rec["text"].(string)
					raw, _ := json.Marshal(txt)
					appendLines(t, p, fmt.Sprintf(`{"type":"queue-operation","operation":"enqueue","content":%s}`, raw))
					_, _, _ = postCtx("ack", map[string]any{"session_id": sidA, "id": id, "submitted": true})
					select {
					case queuedMsg <- txt:
					default:
					}
				}
			}
		}
	}()

	// Wait until the plugin has registered its capabilities on /poll.
	waitFor(t, "plugin capabilities on session row", func() bool {
		s := byID(listSessions(t, n))[sidA]
		return s.Capabilities != nil && s.Capabilities.PluginInput && s.Capabilities.Interrupt
	})
	if s := byID(listSessions(t, n))[sidA]; s.Status != proto.StatusBlocked || s.AttentionReason != "等待电脑端确认：启动预览服务 (demo-web)" {
		t.Fatalf("expected stalled desktop status blocked, got status=%s attention=%q", s.Status, s.AttentionReason)
	}

	// Owner can steer via busy_input and interrupt the stalled host-MCP turn from phone!
	if _, err := request(t, n, "session.send", map[string]any{
		"session_id":  sidA,
		"text":        "不用开预览服务了，直接发静态文件路径就行",
		"owner_input": true,
	}); err != nil {
		t.Fatalf("session.send while stalled on host MCP: %v", err)
	}
	select {
	case got := <-queuedMsg:
		if got != "不用开预览服务了，直接发静态文件路径就行" {
			t.Fatalf("unexpected queued text: %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for busy_input delivery")
	}

	if _, err := request(t, n, nodeproto.OwnerInterrupt, map[string]any{
		"session_id": sidA,
	}); err != nil {
		t.Fatalf("OwnerInterrupt while stalled on host MCP: %v", err)
	}
	select {
	case <-interrupted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for plugin interrupt")
	}
}
