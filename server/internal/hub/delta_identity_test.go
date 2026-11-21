package hub

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestCodexDeltaIdentityForwardAndReplay(t *testing.T) {
	h := benchSubscribersHub(t, 1)
	m := newMachine(h, MachineConfig{ID: "m1"})
	var follower *client
	for c := range h.clients {
		if c.subs[[2]string{"m1", "s1"}] {
			follower = c
		}
	}
	check := func(c *client, text, item string, done bool) {
		t.Helper()
		select {
		case b := <-c.out:
			var got map[string]any
			_ = json.Unmarshal(b, &got)
			if got["text"] != text || got["turn_id"] != "t1" || (item != "" && got["item_id"] != item) || (got["turn_done"] == true) != done {
				t.Fatalf("identity lost: %s", b)
			}
		default:
			t.Fatal("missing replay/reset")
		}
	}
	for _, tc := range []struct {
		text, item string
		done       bool
	}{{"", "", false}, {"live", "a1", false}, {"", "a1", true}} {
		b, _ := json.Marshal(map[string]any{"session_id": "s1", "text": tc.text, "turn_id": "t1", "item_id": tc.item, "turn_done": tc.done})
		m.onEvent("session.delta", b)
		check(follower, tc.text, tc.item, tc.done)
		rejoined := &client{out: make(chan []byte, 1)}
		h.sendLiveText(rejoined, "m1", "s1")
		check(rejoined, tc.text, tc.item, tc.done)
	}
}

func TestCodexDeltaIdentityDisconnectPreservesEvidence(t *testing.T) {
	for _, done := range []bool{false, true} {
		c := &client{out: make(chan []byte, 2), subs: map[[2]string]bool{{"m1", "s1"}: true}}
		h := &Hub{clients: map[*client]struct{}{c: {}}}
		h.forwardLiveText(deltaPush{Type: "delta", MachineID: "m1", SessionID: "s1", Text: "live", TurnID: "t1", ItemID: "a1", TurnDone: done})
		<-c.out
		h.forgetLiveText("m1")
		var got deltaPush
		_ = json.Unmarshal(<-c.out, &got)
		if got.Text != "" || got.TurnID != "t1" || got.ItemID != "a1" || got.TurnDone != done {
			t.Fatalf("disconnect changed evidence: %+v", got)
		}
		h.sendLiveText(c, "m1", "s1")
		if len(c.out) != 0 {
			t.Fatal("disconnected stream replayed")
		}
	}
}

func TestCodexDeltaIdentityTerminalCacheBound(t *testing.T) {
	h := &Hub{}
	h.rememberDeltaLocked(deltaPush{Type: "delta", MachineID: "m1", SessionID: "active", TurnID: "active", Text: "still live"})
	for i := 0; i < 300; i++ {
		h.rememberDeltaLocked(deltaPush{Type: "delta", MachineID: "m1", SessionID: fmt.Sprint(i), TurnID: "done", TurnDone: true})
	}
	if len(h.deltas) > 257 {
		t.Fatalf("unbounded terminal cache: %d", len(h.deltas))
	}
	if h.deltas[[2]string{"m1", "active"}].Text != "still live" {
		t.Fatal("live text was evicted")
	}
	if !h.deltas[[2]string{"m1", "299"}].TurnDone {
		t.Fatal("latest terminal evidence was evicted")
	}
}
