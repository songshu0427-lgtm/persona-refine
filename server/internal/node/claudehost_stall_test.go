package node

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

func TestDesktopHostStallPromotesBusyToBlockedUntilAnswered(t *testing.T) {
	n, f, home := herdrNode(t)
	noPaneEnv(t)
	p := bgTranscript(t, home, home, sidA, "launch local preview")
	inbox := newFakeInbox(t, p)
	f.reply("session.snapshot", snapshot(nil, nil, nil, nil))
	writeOutsideClaude(t, home, sidA, "claude-desktop-3p", "busy", inbox, nil)

	appendLine := func(line string) {
		t.Helper()
		fh, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		defer fh.Close()
		if _, err := fh.WriteString(line + "\n"); err != nil {
			t.Fatal(err)
		}
		n.mu.Lock()
		delete(n.metas, p)
		n.mu.Unlock()
	}

	recent := time.Now().Add(-2 * time.Second).UTC().Format(time.RFC3339Nano)
	appendLine(fmt.Sprintf(`{"type":"assistant","uuid":"u-recent","timestamp":%q,"entrypoint":"claude-desktop-3p","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_recent","name":"mcp__Claude_Browser__preview_start","input":{"name":"demo-web"}}]}}`, recent))
	if s := byID(listSessions(t, n))[sidA]; s.Status != proto.StatusWorking || s.AttentionReason != "" {
		t.Fatalf("fresh preview_start should stay working: status=%s attention=%q", s.Status, s.AttentionReason)
	}
	appendLine(fmt.Sprintf(`{"type":"user","uuid":"u-recent-res","timestamp":%q,"entrypoint":"claude-desktop-3p","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_recent","content":"started"}]}}`, recent))

	stalled := time.Now().Add(-12 * time.Second).UTC().Format(time.RFC3339Nano)
	// Emit preview_start alongside update_plan where update_plan finishes immediately and preview_start remains open.
	appendLine(fmt.Sprintf(`{"type":"assistant","uuid":"u-stall","timestamp":%q,"entrypoint":"claude-desktop-3p","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_preview","name":"mcp__Claude_Browser__preview_start","input":{"name":"demo-web"}},{"type":"tool_use","id":"toolu_plan","name":"mcp__ccd_turn__update_plan","input":{"advance":true}}]}}`, stalled))
	appendLine(fmt.Sprintf(`{"type":"user","uuid":"u-plan-res","timestamp":%q,"entrypoint":"claude-desktop-3p","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_plan","content":"ok"}]}}`, stalled))

	s := byID(listSessions(t, n))[sidA]
	wantReason := "等待电脑端确认：启动预览服务 (demo-web)"
	if s.Status != proto.StatusBlocked || s.AttentionReason != wantReason {
		t.Fatalf("stalled preview_start: status=%s attention=%q, want blocked %q", s.Status, s.AttentionReason, wantReason)
	}
	if s.Capabilities == nil || !s.Capabilities.Send || !s.Capabilities.Interrupt {
		t.Fatalf("stalled desktop session must remain sendable and interruptible: %+v", s.Capabilities)
	}

	// Non-desktop CLI sessions do not run Electron host confirmation cards.
	writeOutsideClaude(t, home, sidA, "cli", "busy", inbox, nil)
	if cli := byID(listSessions(t, n))[sidA]; cli.Status != proto.StatusWorking || cli.AttentionReason != "" {
		t.Fatalf("cli session should stay working: status=%s attention=%q", cli.Status, cli.AttentionReason)
	}
	writeOutsideClaude(t, home, sidA, "claude-desktop-3p", "busy", inbox, nil)

	// A large (>8 KB) tool_result skipped by quickLine still closes the open preview_start call.
	big := strings.Repeat("x", 10*1024)
	doneAt := time.Now().UTC().Format(time.RFC3339Nano)
	appendLine(fmt.Sprintf(`{"type":"user","uuid":"u-preview-res","timestamp":%q,"entrypoint":"claude-desktop-3p","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_preview","content":%q}]}}`, doneAt, big))
	if after := byID(listSessions(t, n))[sidA]; after.Status != proto.StatusWorking || after.AttentionReason != "" {
		t.Fatalf("answered preview_start should return to working: status=%s attention=%q", after.Status, after.AttentionReason)
	}

	// Read-only browser tools (e.g. preview_screenshot) never mark the session blocked even if slow.
	appendLine(fmt.Sprintf(`{"type":"assistant","uuid":"u-shot","timestamp":%q,"entrypoint":"claude-desktop-3p","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_shot","name":"mcp__Claude_Browser__preview_screenshot","input":{"serverId":"srv1"}}]}}`, stalled))
	if ro := byID(listSessions(t, n))[sidA]; ro.Status != proto.StatusWorking || ro.AttentionReason != "" {
		t.Fatalf("read-only preview_screenshot should stay working: status=%s attention=%q", ro.Status, ro.AttentionReason)
	}
}
