package node

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexHistoryRevisionDoesNotClaimAnEarlierInputAsEcho(t *testing.T) {
	n, home := testNode(t)
	p := filepath.Join(home, "fixture.jsonl")
	n.paths[appChat] = p
	at := time.Now().Add(-time.Second)
	write := func(user, answer string) {
		t.Helper()
		payload := codexHistorySnapshot{Type: "persona_history_snapshot", TurnID: "turn", Status: "inProgress", Items: []codexHistorySnapshotItem{
			{At: at, Order: 0, Item: codexRolloutItem("userMessage", []byte(userItem(user, "repeat this")[1]))},
			{At: at, Order: 1, Item: codexRolloutItem("agentMessage", []byte(answerItem("a", answer)[1]))},
		}}
		b, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": payload})
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write(append(b, '\n')); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
	}
	write("old-user", "Initial")
	before := n.echoBase(appChat)
	if err := n.sendEchoed(appChat, "new-send", "repeat this", 0, before, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	record, _ := n.echoes.record(appChat, "new-send")
	// The persisted record must protect the same boundary after a reconnect, too.
	b, _ := json.Marshal(record)
	var restored echoRecord
	if err := json.Unmarshal(b, &restored); err != nil {
		t.Fatal(err)
	}
	n.echoes = echoLog{}
	n.restoreEchoes([]echoRecord{restored})
	write("old-user", "Updated progress")
	f, err := n.file(appChat)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := f.Refresh()
	if err != nil {
		t.Fatal(err)
	}
	n.echoed(appChat, f, fresh)
	if got, _ := n.echoes.record(appChat, "new-send"); got.Line != "" {
		t.Fatalf("an old input revision was mistaken for the new send: %s", got.Line)
	}
	write("new-user", "Real echo")
	fresh, err = f.Refresh()
	if err != nil {
		t.Fatal(err)
	}
	got := n.echoed(appChat, f, fresh)
	if len(got) == 0 || got[0].ClientMsgID != "new-send" {
		t.Fatalf("real echo not matched: %+v", got)
	}
}
