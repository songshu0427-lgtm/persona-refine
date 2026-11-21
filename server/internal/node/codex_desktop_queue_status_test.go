package node

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/rpc"
)

func desktopQueueFixture(t *testing.T) (*Node, string, *fakeCodexBus, func(...string)) {
	t.Helper()
	fastCodexDesktopHold(t)
	home, bus := startFakeCodexBus(t, appChat)
	if err := os.WriteFile(filepath.Join(home, ".codex-global-state.json"), []byte(`{"projectless-thread-ids":["`+appChat+`"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	path, write := appRollout(t, `{"type":"session_meta","payload":{"id":"`+appChat+`","originator":"Codex Desktop","source":"vscode"}}`, turnStarted)
	n := remoteTestNode(t)
	id := n.registerCodex(home, appChat, path)
	src, _ := n.codexSource(id)
	t.Cleanup(func() {
		write(turnComplete)
		thread := codexDesktopQueue.thread(src)
		waitFor(t, "queue drained", func() bool {
			thread.send.Lock()
			defer thread.send.Unlock()
			return !thread.waiting
		})
	})
	return n, id, bus, write
}

func desktopQueueMessage(t *testing.T, n *Node, id, msg string) map[string]any {
	t.Helper()
	info, err := request(t, n, "session.info", map[string]any{"session_id": id})
	if err != nil {
		t.Fatal(err)
	}
	queue, ok := info["codex_desktop_queue"].(map[string]any)
	if !ok || queue["version"] != float64(1) {
		t.Fatalf("session.info has no versioned desktop queue status: %v", info)
	}
	for _, v := range queue["messages"].([]any) {
		m := v.(map[string]any)
		if m["client_msg_id"] == msg {
			return m
		}
	}
	return nil
}

func TestCodexDesktopQueueStatusDeliveredAndReplay(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	params := map[string]any{"session_id": id, "client_msg_id": "queue-status-one", "text": "queued input"}
	for i := 0; i < 2; i++ {
		res, err := request(t, n, "session.send", params)
		if err != nil || res["queued"] != true {
			t.Fatalf("send/replay %d = %v, %v; must still say queued", i, res, err)
		}
	}
	if got := desktopQueueMessage(t, n, id, "queue-status-one"); got["state"] != "queued" {
		t.Fatalf("waiting status = %v", got)
	}
	noTurn(t, bus, 30*time.Millisecond)
	write(turnComplete)
	if got := oneTurn(t, bus); got != "queued input" {
		t.Fatal(got)
	}
	waitFor(t, "delivery status", func() bool { return desktopQueueMessage(t, n, id, "queue-status-one")["state"] == "delivered" })
	noTurn(t, bus, 30*time.Millisecond)
}

func TestCodexDesktopQueueStatusTimeoutIsTerminal(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	defer write(turnComplete)
	old := codexDesktopHoldMax
	codexDesktopHoldMax = 25 * time.Millisecond
	t.Cleanup(func() { codexDesktopHoldMax = old })
	_, err := request(t, n, "session.send", map[string]any{"session_id": id, "client_msg_id": "queue-timeout", "text": "never dispatched"})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "queue timeout", func() bool { return desktopQueueMessage(t, n, id, "queue-timeout")["state"] == "failed" })
	got := desktopQueueMessage(t, n, id, "queue-timeout")
	if got["code"] != "codex_queue_timeout" || got["delivered"] != "none" {
		t.Fatalf("timeout = %v", got)
	}
	noTurn(t, bus, 30*time.Millisecond)
}

func TestCodexDesktopQueueStatusAbsentAfterRestartIsNotQueued(t *testing.T) {
	n := remoteTestNode(t)
	home := t.TempDir()
	path, _ := appRollout(t, turnStarted)
	id := n.registerCodex(home, appChat, path)
	if got := desktopQueueMessage(t, n, id, "lost-in-a-previous-process"); got != nil {
		t.Fatalf("a new process invented a pending receipt: %v", got)
	}
}

func TestCodexDesktopQueueCancelledRequestDoesNotQueue(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	defer write(turnComplete)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := requestCtx(t, ctx, n, "session.send", map[string]any{"session_id": id, "client_msg_id": "cancel-before-accept", "text": "cancelled input"})
	if err == nil {
		t.Fatal("cancelled request was accepted")
	}
	noTurn(t, bus, 30*time.Millisecond)
}

func TestCodexDesktopQueueStatusFailedAfterAcceptance(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	_, err := request(t, n, "session.send", map[string]any{"session_id": id, "client_msg_id": "queue-dial-failure", "text": "wait until idle"})
	if err != nil {
		t.Fatal(err)
	}
	if err := bus.closeBus(); err != nil {
		t.Fatal(err)
	}
	write(turnComplete)
	waitFor(t, "failed delivery", func() bool { return desktopQueueMessage(t, n, id, "queue-dial-failure")["state"] == "failed" })
	got := desktopQueueMessage(t, n, id, "queue-dial-failure")
	if got["delivered"] != "none" || got["code"] != "codex_read_only" {
		t.Fatalf("failure = %v", got)
	}
	if _, ok := n.echoes.record(id, "queue-dial-failure"); ok {
		t.Fatal("a definitely unsent message still claims echoes")
	}
	noTurn(t, bus, 30*time.Millisecond)
}

func TestCodexDesktopQueueStatusUnknownNeverRetries(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	bus.mu.Lock()
	bus.dropTurnReply = true
	bus.mu.Unlock()
	params := map[string]any{"session_id": id, "client_msg_id": "queue-unknown", "text": "accepted without an answer"}
	if _, err := request(t, n, "session.send", params); err != nil {
		t.Fatal(err)
	}
	write(turnComplete)
	if got := oneTurn(t, bus); got != "accepted without an answer" {
		t.Fatal(got)
	}
	waitFor(t, "unknown delivery", func() bool { return desktopQueueMessage(t, n, id, "queue-unknown")["state"] == "unknown" })
	got := desktopQueueMessage(t, n, id, "queue-unknown")
	if got["delivered"] != "unknown" || got["code"] != "codex_queue_delivery_unknown" {
		t.Fatalf("unknown = %v", got)
	}
	if _, ok := n.echoes.record(id, "queue-unknown"); !ok {
		t.Fatal("an uncertain message lost its echo")
	}
	for i := 0; i < 3; i++ {
		if _, err := request(t, n, "session.send", params); !maybeDelivered(err) {
			t.Fatalf("uncertain replay returned %v", err)
		}
	}
	noTurn(t, bus, 30*time.Millisecond)
}

func TestCodexDesktopQueueStatusTerminalCannotRegressOnReplay(t *testing.T) {
	for _, state := range []string{"delivered", "failed", "cancelled", "unknown"} {
		t.Run(state, func(t *testing.T) {
			n := remoteTestNode(t)
			key := codexDesktopSendID{t.Name(), "once"}
			codexDesktopQueue.note(key, "queued", "", "")
			codexDesktopQueue.note(key, state, "fixture", deliveredNone)
			original := codexDesktopQueue.snapshot(key.session).Messages[0]
			for i := 0; i < 3; i++ {
				res, err := request(t, n, "session.send", map[string]any{"session_id": key.session, "client_msg_id": key.message, "text": "never dispatched"})
				if state == "delivered" && (err != nil || res["queued"] != false) {
					t.Fatalf("delivered replay = %v, %v", res, err)
				}
				if state != "delivered" && err == nil {
					t.Fatalf("terminal failure became success: %v", res)
				}
				codexDesktopQueue.note(key, "queued", "", "") // even a stale producer cannot regress it
				if got := codexDesktopQueue.snapshot(key.session).Messages[0]; got != original {
					t.Fatalf("terminal changed: %v -> %v", original, got)
				}
			}
		})
	}
}

func TestCodexDesktopQueueStatusConcurrentRetriesAndInterruptedTurn(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	params := map[string]any{"session_id": id, "client_msg_id": "concurrent-queued", "text": "one queued message"}
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := n.handle(ctx, "session.send", mustJSON(params))
			if err == nil && res.(map[string]any)["queued"] != true {
				err = errors.New("retry lost queued state")
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	cancel() // acknowledgement owns the queue now, not the completed HTTP request's context
	if got := desktopQueueMessage(t, n, id, "concurrent-queued"); got["state"] != "queued" {
		t.Fatal(got)
	}
	noTurn(t, bus, 30*time.Millisecond)
	// Ending the old turn by interruption does not cancel the user's separately accepted queued message.
	write(`{"type":"event_msg","payload":{"type":"turn_aborted"}}`)
	if got := oneTurn(t, bus); got != "one queued message" {
		t.Fatal(got)
	}
	waitFor(t, "one delivery", func() bool { return desktopQueueMessage(t, n, id, "concurrent-queued")["state"] == "delivered" })
	noTurn(t, bus, 30*time.Millisecond)
}

func TestCodexDesktopQueueStatusRetentionNeverDropsLivePending(t *testing.T) {
	var q codexDesktopThreads
	pending := codexDesktopSendID{"session", "pending"}
	q.note(pending, "queued", "", "")
	q.mu.Lock()
	r := q.states[pending]
	r.At = time.Now().Add(-25 * time.Hour)
	q.states[pending] = r
	q.mu.Unlock()
	for i := 0; i < 250; i++ {
		q.note(codexDesktopSendID{"session", time.Unix(int64(i), 0).String()}, "delivered", "", "")
	}
	got := q.snapshot("session")
	if len(got.Messages) != 201 {
		t.Fatalf("bounded terminal receipts plus pending = %d", len(got.Messages))
	}
	if reply, err, ok := q.reply(pending); !ok || err != nil || reply["queued"] != true {
		t.Fatalf("pending expired: %v, %v", reply, err)
	}
	if other := q.snapshot("other"); len(other.Messages) != 0 {
		t.Fatalf("cross-session status leak: %v", other)
	}
}

func TestCodexDesktopQueueStatusOutlivesSendDedupeAndReconnect(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	params := map[string]any{"session_id": id, "client_msg_id": "long-queued", "text": "only once"}
	if _, err := request(t, n, "session.send", params); err != nil {
		t.Fatal(err)
	}
	n.sends.mu.Lock()
	n.sends.sent["long-queued"].at = time.Now().Add(-2 * sentTTL)
	n.sends.mu.Unlock()
	// The receipt's age does not expire a message the live queue still holds.
	key := codexDesktopSendID{id, "long-queued"}
	codexDesktopQueue.mu.Lock()
	r := codexDesktopQueue.states[key]
	r.At = time.Now().Add(-13 * time.Hour)
	codexDesktopQueue.states[key] = r
	codexDesktopQueue.mu.Unlock()
	for i := 0; i < 3; i++ {
		res, err := request(t, n, "session.send", params)
		if err != nil || res["queued"] != true {
			t.Fatalf("replay: %v, %v", res, err)
		}
	}
	if got := codexDesktopQueue.snapshot(id); len(got.Messages) != 1 || got.Messages[0].State != "queued" {
		t.Fatalf("snapshot = %v", got)
	}
	// New Node connections share the process queue, while a new process starts with no receipts at all.
	other := remoteTestNode(t)
	src, _ := n.codexSource(id)
	otherID := other.registerCodex(src.home, src.thread, src.path)
	if got := desktopQueueMessage(t, other, otherID, "long-queued"); got["state"] != "queued" {
		t.Fatal(got)
	}
	var restarted codexDesktopThreads
	if got := restarted.snapshot(id); len(got.Messages) != 0 {
		t.Fatalf("restart invented queue: %v", got)
	}
	write(turnComplete)
	if got := oneTurn(t, bus); got != "only once" {
		t.Fatal(got)
	}
	noTurn(t, bus, 30*time.Millisecond)
}

func TestCodexDesktopQueueStatusOutcomeClassification(t *testing.T) {
	for _, tc := range []struct {
		name             string
		err              error
		state, delivered string
	}{
		{"success", nil, "delivered", ""},
		{"refused", refusal("codex_read_only", "fixture", nil), "failed", "none"},
		{"cancelled", refusal("codex_queue_cancelled", "fixture", nil), "cancelled", "none"},
		{"unclassified", errors.New("transport failed"), "unknown", "unknown"},
		{"lost-reply", uncertain(&rpc.Error{Message: "lost reply"}), "unknown", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key := codexDesktopSendID{t.Name(), "message"}
			n := &Node{}
			n.finishHeldCodexDesktop([]codexDesktopMessage{{sendID: key}}, tc.err)
			got := codexDesktopQueue.snapshot(key.session).Messages[0]
			if got.State != tc.state || got.Delivered != tc.delivered {
				t.Fatalf("outcome = %v", got)
			}
		})
	}
}
