package node

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

// Only temporary homes, pipe peers and canned app-server replies are used here.
func codexStreamIdentityFixture(t *testing.T) (*Node, *assistantProc, *codexConn, <-chan hubPush) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	n := codexTestNode(t)
	n.dir = t.TempDir()
	n.codices = newCodexRegistry()
	n.codices.scan = func() []codexProcess { return nil }
	p, c, _ := newFakeCodex(t, n, t.TempDir())
	p.id, c.threadID, p.busy = testThread, testThread, true
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	n.paths[p.id] = path
	all, pw := hubPushes(n)
	t.Cleanup(func() { _ = pw.Close() })
	return n, p, c, all
}

func streamEvent(c *codexConn, method, params string) {
	c.notification(method, json.RawMessage(params))
}

func streamDelta(t *testing.T, all <-chan hubPush) map[string]any {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-all:
			if event.Event == "session.delta" {
				var got map[string]any
				if err := json.Unmarshal(event.Params, &got); err != nil {
					t.Fatal(err)
				}
				return got
			}
		case <-deadline:
			t.Fatal("missing stream delta")
			return nil
		}
	}
}

func requireStreamDelta(t *testing.T, all <-chan hubPush, text, turn, item string, done bool) {
	t.Helper()
	got := streamDelta(t, all)
	if got["text"] != text || got["turn_id"] != turn || (item != "" && got["item_id"] != item) ||
		(item == "" && got["item_id"] != nil) || (got["turn_done"] == true) != done {
		t.Fatalf("delta %+v, want text=%q turn=%q item=%q done=%v", got, text, turn, item, done)
	}
}

func TestCodexStreamIdentityResetsAndRejectsStaleEvents(t *testing.T) {
	n, p, c, all := codexStreamIdentityFixture(t)
	streamEvent(c, "turn/started", `{"turn":{"id":"t1"}}`)
	requireStreamDelta(t, all, "", "t1", "", false)
	streamEvent(c, "item/started", `{"turnId":"t1","item":{"type":"agentMessage","id":"a1"}}`)
	requireStreamDelta(t, all, "", "t1", "a1", false)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a1","delta":"old"}`)
	requireStreamDelta(t, all, "old", "t1", "a1", false)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a1","delta":" pending"}`)
	streamEvent(c, "turn/started", `{"turn":{"id":"t2"}}`)
	requireStreamDelta(t, all, "", "t2", "", false)
	streamEvent(c, "item/started", `{"turnId":"t2","item":{"type":"agentMessage","id":"a2"}}`)
	requireStreamDelta(t, all, "", "t2", "a2", false)
	streamEvent(c, "turn/completed", `{"turn":{"id":"t1","status":"completed"}}`)
	streamEvent(c, "turn/started", `{"turn":{"id":"t1"}}`)
	streamEvent(c, "item/started", `{"turnId":"t1","item":{"type":"agentMessage","id":"old-item"}}`)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a1","delta":"late"}`)
	streamEvent(c, "item/completed", `{"turnId":"t1","item":{"type":"agentMessage","id":"a1","text":"late final"}}`)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t2","itemId":"a2","delta":"new"}`)
	n.flushPartial(p)
	requireStreamDelta(t, all, "new", "t2", "a2", false)
	if c.turn() != "t2" || !p.busy || p.partial.String() != "new" {
		t.Fatalf("stale events changed active turn: %q busy=%v text=%q", c.turn(), p.busy, p.partial.String())
	}
}

func TestCodexStreamIdentityItemCompletionTimerAndReconnect(t *testing.T) {
	n, p, c, all := codexStreamIdentityFixture(t)
	streamEvent(c, "turn/started", `{"turn":{"id":"t1"}}`)
	requireStreamDelta(t, all, "", "t1", "", false)
	streamEvent(c, "item/started", `{"turnId":"t1","item":{"type":"agentMessage","id":"a1"}}`)
	requireStreamDelta(t, all, "", "t1", "a1", false)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a1","delta":"draft"}`)
	requireStreamDelta(t, all, "draft", "t1", "a1", false)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a1","delta":" pending"}`)
	streamEvent(c, "item/completed", `{"turnId":"t1","item":{"type":"agentMessage","id":"a1","text":"final"}}`)
	requireStreamDelta(t, all, "final", "t1", "a1", false)
	if more := liveTexts(t, all, 1, 2*deltaEvery); len(more) != 0 {
		t.Fatalf("timer revived draft after final: %+v", more)
	}
	n.resumeAssistants([]*assistantProc{p})
	requireStreamDelta(t, all, "final", "t1", "a1", false)
	streamEvent(c, "item/started", `{"turnId":"t1","item":{"type":"agentMessage","id":"a2"}}`)
	requireStreamDelta(t, all, "", "t1", "a2", false)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a1","delta":"late"}`)
	streamEvent(c, "item/started", `{"turnId":"t1","item":{"type":"agentMessage","id":"a1"}}`)
	streamEvent(c, "item/completed", `{"turnId":"t1","item":{"type":"agentMessage","id":"a1","text":"late final"}}`)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a2","delta":"new"}`)
	n.flushPartial(p)
	requireStreamDelta(t, all, "new", "t1", "a2", false)
	streamEvent(c, "turn/completed", `{"turn":{"id":"t1","status":"completed"}}`)
	requireStreamDelta(t, all, "", "t1", "a2", true)
	n.resumeAssistants([]*assistantProc{p})
	requireStreamDelta(t, all, "", "t1", "a2", true)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a2","delta":"after end"}`)
	n.flushPartial(p)
	if more := liveTexts(t, all, 1, 2*deltaEvery); len(more) != 0 {
		t.Fatalf("ended stream revived: %+v", more)
	}
}

func TestCodexStreamIdentityTimerKeepsTextAndIDsTogether(t *testing.T) {
	_, _, c, all := codexStreamIdentityFixture(t)
	streamEvent(c, "turn/started", `{"turn":{"id":"t1"}}`)
	requireStreamDelta(t, all, "", "t1", "", false)
	streamEvent(c, "item/started", `{"turnId":"t1","item":{"type":"agentMessage","id":"a1"}}`)
	requireStreamDelta(t, all, "", "t1", "a1", false)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a1","delta":"first"}`)
	requireStreamDelta(t, all, "first", "t1", "a1", false)
	streamEvent(c, "item/agentMessage/delta", `{"turnId":"t1","itemId":"a1","delta":" rest"}`)
	requireStreamDelta(t, all, "first rest", "t1", "a1", false)
}

func TestCodexStreamIdentityLeavesLegacyDeltaUnchanged(t *testing.T) {
	n, _, _, all := codexStreamIdentityFixture(t)
	n.emitDelta(testThread, "legacy")
	got := streamDelta(t, all)
	if len(got) != 2 || got["session_id"] != testThread || got["text"] != "legacy" {
		t.Fatalf("legacy delta changed: %+v", got)
	}
}

func TestCodexStreamIdentityInterruptedAndFailedAreTerminal(t *testing.T) {
	for _, status := range []string{"interrupted", "failed"} {
		t.Run(status, func(t *testing.T) {
			_, p, c, all := codexStreamIdentityFixture(t)
			streamEvent(c, "turn/started", `{"turn":{"id":"t1"}}`)
			requireStreamDelta(t, all, "", "t1", "", false)
			// A user-action error never invokes model recovery or another process.
			streamEvent(c, "turn/completed", `{"turn":{"id":"t1","status":"`+status+`","error":{"message":"synthetic invalid request","codexErrorInfo":"badRequest"}}}`)
			requireStreamDelta(t, all, "", "t1", "", true)
			p.mu.Lock()
			busy := p.busy
			p.mu.Unlock()
			if busy {
				t.Fatal("terminal turn remained busy")
			}
		})
	}
}

func TestCodexStreamIdentityExitBelongsToItsProcess(t *testing.T) {
	for _, replaced := range []bool{false, true} {
		t.Run(map[bool]string{false: "current", true: "replaced"}[replaced], func(t *testing.T) {
			n, p, c, all := codexStreamIdentityFixture(t)
			streamEvent(c, "turn/started", `{"turn":{"id":"old"}}`)
			requireStreamDelta(t, all, "", "old", "", false)
			n.procs[p.id] = p
			if replaced {
				n.procs[p.id] = &assistantProc{id: p.id, agent: "codex", busy: true}
				n.codexPartial(n.procs[p.id], proto.StreamIdentity{TurnID: "new", ItemID: "answer"}, "new live", false)
				requireStreamDelta(t, all, "new live", "new", "answer", false)
			}
			n.finishCodexExit(p, c.key)
			if replaced {
				n.finishAssistantRecoveryOnExit(p, &assistantTurnRecovery{})
				if more := liveTexts(t, all, 1, 2*deltaEvery); len(more) != 0 {
					t.Fatalf("old exit cleared replacement: %+v", more)
				}
			} else {
				requireStreamDelta(t, all, "", "old", "", false)
			}
		})
	}
}

func TestCodexStreamIdentityMemoryBoundAndToolCompatibility(t *testing.T) {
	_, p, c, _ := codexStreamIdentityFixture(t)
	for i := 0; i < 1000; i++ {
		if !c.acceptStreamEvent("turn/started", string(rune(i+100)), "", "") {
			t.Fatal("new turn rejected")
		}
	}
	if len(c.streamTurns) > 64 {
		t.Fatalf("retained %d past turns", len(c.streamTurns))
	}
	p.partialIdentity = proto.StreamIdentity{TurnID: "done", TurnDone: true}
	if !c.acceptStreamEvent("item/completed", "", "compact", "contextCompaction") {
		t.Fatal("manual compaction after a turn was dropped")
	}
}
