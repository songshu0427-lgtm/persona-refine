package node

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/rpc"
)

func desktopUserLine(id string, at time.Time, text string) string {
	b, _ := json.Marshal(map[string]any{"type": "event_msg", "timestamp": at, "payload": map[string]any{
		"type": "item_completed", "item": codexRolloutItem("userMessage", []byte(userItem(id, text)[1])),
	}})
	return string(b)
}

func desktopEchoItems(t *testing.T, n *Node, id string) []proto.Item {
	t.Helper()
	f, err := n.file(id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Refresh(); err != nil {
		t.Fatal(err)
	}
	items, _, _ := f.After(0, 2000)
	return n.echoed(id, f, items)
}

func desktopEchoSend(t *testing.T, n *Node, id, msg, text string) {
	t.Helper()
	res, err := request(t, n, "session.send", map[string]any{"session_id": id, "client_msg_id": msg, "text": text})
	if err != nil || res["queued"] != true {
		t.Fatalf("enqueue: %v, %v", res, err)
	}
}

func TestCodexDesktopEchoLongWaitMergedAndRestored(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	desktopEchoSend(t, n, id, "batch-a", "alpha")
	desktopEchoSend(t, n, id, "batch-b", "beta")
	n.echoes.mu.Lock()
	for _, r := range n.echoes.recs[id] {
		r.SentAt = time.Now().Add(-3 * time.Hour)
	}
	n.echoes.mu.Unlock()
	// Identical desktop input written while the phone's messages still wait is not their echo.
	write(desktopUserLine("old-combined", time.Now(), "alpha\n\nbeta"), turnComplete)
	if got := oneTurn(t, bus); got != "alpha\n\nbeta" {
		t.Fatal(got)
	}
	waitFor(t, "batch dispatched", func() bool { return desktopQueueMessage(t, n, id, "batch-a")["state"] == "delivered" })
	var saved []echoRecord
	for _, mid := range []string{"batch-a", "batch-b"} {
		r, ok := n.echoes.record(id, mid)
		if !ok {
			t.Fatalf("missing echo record %s", mid)
		}
		if r.Desktop == nil || r.Desktop.DispatchAt.IsZero() || len(r.Desktop.Group) != 2 || time.Since(r.SentAt) < 2*time.Hour {
			t.Fatalf("missing real dispatch boundary distinct from acceptance: %+v", r)
		}
		saved = append(saved, r)
	}
	write(desktopUserLine("actual-combined", time.Now(), "alpha\n\nbeta"))
	items := desktopEchoItems(t, n, id)
	for _, mid := range []string{"batch-a", "batch-b"} {
		r, _ := n.echoes.record(id, mid)
		if r.Line != "actual-combined" {
			t.Fatalf("long-held member %s did not match the real batch: %+v", mid, r)
		}
		if got := desktopQueueMessage(t, n, id, mid); got["echo_line"] != "actual-combined" {
			t.Fatalf("missing exact receipt proof: %v", got)
		}
	}
	if got := tagsOf(items)["actual-combined#0"]; got != "batch-a" {
		t.Fatalf("single legacy tag must consistently use the first member: %s", got)
	}
	// Replay the dispatch-only opaque records, as the hub returns them after a fresh Node connection.
	b, err := json.Marshal(saved)
	if err != nil {
		t.Fatal(err)
	}
	var restored []echoRecord
	if err = json.Unmarshal(b, &restored); err != nil {
		t.Fatal(err)
	}
	other := remoteTestNode(t)
	src, _ := n.codexSource(id)
	otherID := other.registerCodex(src.home, src.thread, src.path)
	other.restoreEchoes(restored)
	desktopEchoItems(t, other, otherID)
	// A fresh process has no live queue receipts. Persisted batch proof still supplies line associations, not queued.
	codexDesktopQueue.mu.Lock()
	delete(codexDesktopQueue.states, codexDesktopSendID{id, "batch-a"})
	delete(codexDesktopQueue.states, codexDesktopSendID{id, "batch-b"})
	codexDesktopQueue.mu.Unlock()
	for _, mid := range []string{"batch-a", "batch-b"} {
		if r, _ := other.echoes.record(otherID, mid); r.Line != "actual-combined" {
			t.Fatalf("restored group matched incorrectly: %+v", r)
		}
		if got := desktopQueueMessage(t, other, otherID, mid); got["state"] != "unknown" || got["echo_line"] != "actual-combined" {
			t.Fatalf("cold receipt invented a queue or lost proof: %v", got)
		}
	}
	if got := other.echoes.match(id, echoInTranscript, items); len(got) != 0 {
		t.Fatalf("repeat poll matched twice: %+v", got)
	}
}

func TestCodexDesktopEchoHeldDoesNotClaimAnotherInput(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	desktopEchoSend(t, n, id, "still-held", "identical words")
	write(desktopUserLine("desktop-input", time.Now(), "identical words"))
	desktopEchoItems(t, n, id)
	if r, _ := n.echoes.record(id, "still-held"); r.Line != "" {
		t.Fatalf("undispatched input claimed somebody else's line: %+v", r)
	}
	noTurn(t, bus, 20*time.Millisecond)
	write(turnComplete)
	oneTurn(t, bus)
}

func TestCodexDesktopEchoMergedRequiresFullText(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	first := strings.Repeat("same prefix ", 2600) // longer than a transcript page's user-text limit
	desktopEchoSend(t, n, id, "full-a", first)
	desktopEchoSend(t, n, id, "full-b", "different ending")
	write(turnComplete)
	oneTurn(t, bus)
	waitFor(t, "batch dispatched", func() bool { return desktopQueueMessage(t, n, id, "full-a")["state"] == "delivered" })
	write(desktopUserLine("prefix-only", time.Now(), first))
	desktopEchoItems(t, n, id)
	for _, mid := range []string{"full-a", "full-b"} {
		if r, _ := n.echoes.record(id, mid); r.Line != "" {
			t.Fatalf("prefix claimed a batch member: %+v", r)
		}
	}
	write(desktopUserLine("full-combined", time.Now(), first+"\n\ndifferent ending"))
	desktopEchoItems(t, n, id)
	for _, mid := range []string{"full-a", "full-b"} {
		if r, _ := n.echoes.record(id, mid); r.Line != "full-combined" {
			t.Fatalf("full batch missing: %+v", r)
		}
	}
}

func TestCodexDesktopEchoBeforeExcludesReplayAndStaleRestore(t *testing.T) {
	var l echoLog
	at := time.Now()
	d := &codexDesktopEcho{DispatchAt: at, Group: []string{"a", "b"}, TextHash: desktopEchoHash("one\n\ntwo")}
	for _, mid := range d.Group {
		l.expect(echoRecord{SessionID: "s", ClientMsgID: mid, SentAt: at.Add(-3 * time.Hour), AfterSeq: 3, Before: []string{"history:old:user"}, In: echoInTranscript, Desktop: d})
	}
	items := []proto.Item{{ID: "history:old:user#0", Seq: 10, TS: at, Role: "user", Kind: proto.KindText, Text: "one\n\ntwo"}}
	if got := l.match("s", echoInTranscript, items); len(got) != 0 {
		t.Fatalf("old identical revision claimed group: %+v", got)
	}
	// An old queued notification and a dispatch-only duplicate cannot revert the new boundary or the found line.
	for _, mid := range d.Group {
		l.expect(echoRecord{SessionID: "s", ClientMsgID: mid, SentAt: at, Desktop: &codexDesktopEcho{Group: []string{mid}}})
	}
	items[0].ID, items[0].Seq = "history:new:user#0", 11
	if got := l.match("s", echoInTranscript, items); len(got) != 2 {
		t.Fatalf("new group not matched: %+v", got)
	}
	for _, mid := range d.Group {
		l.expect(echoRecord{SessionID: "s", ClientMsgID: mid, SentAt: at, Desktop: d})
		if r, _ := l.record("s", mid); r.Line != "history:new:user" || r.AfterSeq != 3 {
			t.Fatalf("restore regressed proof/boundary: %+v", r)
		}
	}
}

func TestCodexDesktopEchoPendingIsNotPersistedAndFullDigestIsLiteral(t *testing.T) {
	var wire bytes.Buffer
	n := &Node{peer: rpc.New("fixture", &wire)}
	r := echoRecord{SessionID: "s", ClientMsgID: "a", SentAt: time.Now(), Desktop: &codexDesktopEcho{Group: []string{"a"}}}
	n.notifyEcho(r)
	if wire.Len() != 0 {
		t.Fatal("undispatched receipt can race and overwrite a later dispatch in the hub")
	}
	r.Desktop = &codexDesktopEcho{DispatchAt: time.Now().UTC(), Group: []string{"a", "b"}, TextHash: desktopEchoHash("literal\n…（已截断 marker")}
	n.notifyEcho(r)
	if !strings.Contains(wire.String(), `"desktop"`) || !strings.Contains(wire.String(), `"dispatch_at"`) {
		t.Fatalf("dispatch proof was not persisted: %s", wire.String())
	}
	items := []proto.Item{{Role: "user", Kind: proto.KindText, Text: "literal"}}
	if r.Desktop.fits(items) {
		t.Fatal("a literal truncation marker shortened the expected full text")
	}
	items[0].Text = "literal\n…（已截断 marker"
	if !r.Desktop.fits(items) {
		t.Fatal("literal full text did not match")
	}
	items[0].FullSize = 1000
	if r.Desktop.fits(items) {
		t.Fatal("a clipped item claimed full batch evidence")
	}
}

func TestCodexDesktopEchoImageOnlyBatchRequiresWholeImageCount(t *testing.T) {
	d := &codexDesktopEcho{DispatchAt: time.Now(), Group: []string{"a", "b"}, TextHash: desktopEchoHash(""), Images: 2}
	items := []proto.Item{{Role: "user", Kind: proto.KindImage}}
	if d.fits(items) {
		t.Fatal("one image cannot match a two-image batch")
	}
	items = append(items, proto.Item{Role: "user", Kind: proto.KindImage})
	if !d.fits(items) {
		t.Fatal("complete image-only batch did not match")
	}
}

func TestCodexDesktopEchoCanonicalInputFromActualBus(t *testing.T) {
	for _, tc := range []struct {
		name, text string
		images     bool
	}{
		{"context", "<context>reference data</context>\nreview this", false},
		{"attached-text", "inspect\n<attached_images>\n/tmp/example.png\n</attached_images>", false},
		{"local-images-and-context", "<context>reference data</context>\ninspect", true},
		{"only-images", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n, id, bus, write := desktopQueueFixture(t)
			params := map[string]any{"session_id": id, "client_msg_id": "canonical-a", "text": tc.text}
			if tc.images {
				params["images"] = []proto.Image{{Mime: "image/png", Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax7HAAAAABJRU5ErkJggg=="}}
			}
			if res, err := request(t, n, "session.send", params); err != nil || res["queued"] != true {
				t.Fatalf("send = %v, %v", res, err)
			}
			params["client_msg_id"] = "canonical-b"
			if _, err := request(t, n, "session.send", params); err != nil {
				t.Fatal(err)
			}
			write(turnComplete)
			var sent map[string]any
			select {
			case sent = <-bus.turns:
			case <-time.After(5 * time.Second):
				t.Fatal("no bus request")
			}
			input := sent["turnStart"].(map[string]any)["request"].(map[string]any)["input"]
			raw, _ := json.Marshal(map[string]any{"type": "userMessage", "id": "canonical-user", "content": input})
			line, _ := json.Marshal(map[string]any{"type": "event_msg", "timestamp": time.Now(), "payload": map[string]any{"type": "item_completed", "item": codexRolloutItem("userMessage", raw)}})
			write(string(line))
			desktopEchoItems(t, n, id)
			for _, mid := range []string{"canonical-a", "canonical-b"} {
				if r, _ := n.echoes.record(id, mid); r.Line != "canonical-user" {
					t.Fatalf("actual native input not matched: %+v", r)
				}
			}
		})
	}
}

func TestCodexDesktopEchoIdenticalBatchesKeepTheirOwnLines(t *testing.T) {
	n, id, bus, write := desktopQueueFixture(t)
	for round := 0; round < 2; round++ {
		if round > 0 {
			write(turnStarted)
		}
		ids := []string{fmt.Sprintf("batch-%d-a", round), fmt.Sprintf("batch-%d-b", round)}
		for _, mid := range ids {
			desktopEchoSend(t, n, id, mid, "again")
		}
		write(turnComplete)
		if got := oneTurn(t, bus); got != "again\n\nagain" {
			t.Fatal(got)
		}
		line := fmt.Sprintf("actual-%d", round)
		write(desktopUserLine(line, time.Now(), "again\n\nagain"))
		desktopEchoItems(t, n, id)
		for _, mid := range ids {
			if r, _ := n.echoes.record(id, mid); r.Line != line {
				t.Fatalf("same-text batch confused: %+v", r)
			}
		}
	}
	if r, _ := n.echoes.record(id, "batch-0-b"); r.Line != "actual-0" {
		t.Fatalf("old batch moved: %+v", r)
	}
}

func TestCodexDesktopEchoAboveParserCapStillRequiresExactTail(t *testing.T) {
	for _, history := range []bool{false, true} {
		t.Run(fmt.Sprintf("history-%t", history), func(t *testing.T) {
			n, id, bus, write := desktopQueueFixture(t)
			body := strings.Repeat("large input ", 100000) // >1 MiB: native parser cap, not just a light page
			desktopEchoSend(t, n, id, "oversize-a", body)
			desktopEchoSend(t, n, id, "oversize-b", "exact final tail")
			write(turnComplete)
			if got := oneTurn(t, bus); got != body+"\n\nexact final tail" {
				t.Fatal("the bus input was changed")
			}
			line := func(mid, text string) string {
				if !history {
					return desktopUserLine(mid, time.Now(), text)
				}
				b, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": codexHistorySnapshot{Type: "persona_history_snapshot", TurnID: "oversize-turn", Status: "inProgress", Items: []codexHistorySnapshotItem{{At: time.Now(), Order: 0, Item: codexRolloutItem("userMessage", []byte(userItem(mid, text)[1]))}}}})
				return string(b)
			}
			write(line("wrong-tail", body+"\n\nwrong final tail"))
			desktopEchoItems(t, n, id)
			for _, mid := range []string{"oversize-a", "oversize-b"} {
				if r, _ := n.echoes.record(id, mid); r.Line != "" {
					t.Fatalf("clipped prefix swallowed %s", mid)
				}
			}
			write(line("exact-tail", body+"\n\nexact final tail"))
			desktopEchoItems(t, n, id)
			want := "exact-tail"
			if history {
				want = "history:oversize-turn:exact-tail"
			}
			for _, mid := range []string{"oversize-a", "oversize-b"} {
				if r, _ := n.echoes.record(id, mid); r.Line != want {
					t.Fatalf("full oversized member not matched: id=%s line=%q", mid, r.Line)
				}
			}
		})
	}
}
