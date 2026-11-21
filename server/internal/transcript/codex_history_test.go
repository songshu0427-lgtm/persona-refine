package transcript

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/nwverse/persona/server/internal/proto"
)

func historySnapshotLine(t *testing.T, turn, status, text, toolStatus string) []byte {
	t.Helper()
	rows := []any{
		map[string]any{"order": 0, "at": "2026-11-01T10:00:00Z", "item": map[string]any{"type": "UserMessage", "id": "u-" + turn, "content": []any{map[string]any{"type": "text", "text": "Inspect " + turn}}}},
		map[string]any{"order": 1, "at": "2026-11-01T10:00:01Z", "item": map[string]any{"type": "AgentMessage", "id": "a-" + turn, "content": []any{map[string]any{"type": "text", "text": text}}, "phase": "commentary"}},
		map[string]any{"order": 2, "at": "2026-11-01T10:00:02Z", "item": map[string]any{"type": "CommandExecution", "id": "c-" + turn, "command": []string{"pwd"}, "status": toolStatus, "aggregated_output": "result", "duration": map[string]int{"secs": 2, "nanos": 0}}},
	}
	b, err := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "persona_history_snapshot", "turn_id": turn, "status": status, "duration_ms": 3000, "items": rows}})
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

func appendHistoryBytes(t *testing.T, path string, b []byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(b); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCodexHistorySnapshotAtomicRevisionAndMetadata(t *testing.T) {
	p := filepath.Join(t.TempDir(), "history.jsonl")
	appendHistoryBytes(t, p, historySnapshotLine(t, "t", "inProgress", "Working", "inProgress"))
	f := NewFile(p)
	first, err := f.Refresh()
	if err != nil || len(first) != 3 {
		t.Fatalf("first = %+v, %v", first, err)
	}
	if m := f.Meta(); m.Turns != 1 || !m.TurnOpen || len(m.OpenTools) != 1 {
		t.Fatalf("running metadata: %+v", m)
	}
	for _, it := range first {
		if it.Kind == proto.KindToolResult {
			t.Fatal("invented running tool result")
		}
	}
	second := historySnapshotLine(t, "t", "completed", "Finished", "completed")
	appendHistoryBytes(t, p, second[:len(second)/2])
	if got, err := f.Refresh(); err != nil || len(got) != 0 {
		t.Fatalf("partial snapshot escaped: %+v %v", got, err)
	}
	if got, _, _ := f.Page(0, 80); !reflect.DeepEqual(first, got) {
		t.Fatal("partial revision lost displayed items")
	}
	appendHistoryBytes(t, p, second[len(second)/2:])
	got, err := f.Refresh()
	if err != nil || len(got) != 5 {
		t.Fatalf("completion = %+v %v", got, err)
	}
	for i := range first {
		if first[i].ID != got[i].ID {
			t.Fatalf("unstable ID: %s / %s", first[i].ID, got[i].ID)
		}
	}
	if got[3].Outcome == nil || got[3].Outcome.DurationMS == nil || *got[3].Outcome.DurationMS != 2000 {
		t.Fatal("tool duration lost")
	}
	if got[4].TurnDuration.UserItemID != got[0].ID {
		t.Fatal("turn duration does not name stable user ID")
	}
	if m := f.Meta(); m.Turns != 1 || m.TurnOpen || !m.TurnClosed || len(m.OpenTools) != 0 {
		t.Fatalf("completion metadata: %+v", m)
	}
	page, _, _ := f.Page(0, 80)
	if !reflect.DeepEqual(page, got) {
		t.Fatalf("stale cached revision: %+v", page)
	}
	cold := NewFile(p)
	if _, err := cold.Refresh(); err != nil {
		t.Fatal(err)
	}
	reloaded, _, _ := cold.Page(0, 80)
	if !reflect.DeepEqual(reloaded, got) {
		t.Fatal("cold replay differs")
	}
	idx, err := cold.UserInputs(context.Background())
	if err != nil || idx.Total != 1 {
		t.Fatalf("revisions became extra user inputs: %+v %v", idx, err)
	}
}

func TestCodexHistorySnapshotWindowsDoNotResurrectOlderRevisions(t *testing.T) {
	defer func(old int64) { windowBytes = old }(windowBytes)
	windowBytes = 512
	p := filepath.Join(t.TempDir(), "history.jsonl")
	appendHistoryBytes(t, p, []byte(`{"type":"session_meta","payload":{"id":"fixture"}}`+"\n"))
	appendHistoryBytes(t, p, historySnapshotLine(t, "prefix", "completed", "Retained", "completed"))
	for i := 0; i < 8; i++ {
		appendHistoryBytes(t, p, historySnapshotLine(t, "current", "inProgress", strings.Repeat("x", 900)+" old", "inProgress"))
	}
	appendHistoryBytes(t, p, historySnapshotLine(t, "current", "completed", "Latest", "failed"))
	f := NewFile(p)
	if _, err := f.Refresh(); err != nil {
		t.Fatal(err)
	}
	if f.base == 0 {
		t.Fatal("fixture did not open a cold window")
	}
	// Direct item lookup must work before any page/index call has warmed old windows.
	old, err := f.Full("history:prefix:a-prefix#1000000")
	if err != nil || old.Text != "Retained" {
		t.Fatalf("cold full lookup: %+v %v", old, err)
	}
	idx, err := f.UserInputs(context.Background())
	if err != nil || idx.Total != 2 {
		t.Fatalf("window input index: %+v %v", idx, err)
	}
	all, more, _ := f.Page(0, 1000)
	if more || len(all) != 10 {
		t.Fatalf("window replay retained stale revisions: %d, more=%v", len(all), more)
	}
	seen := map[string]bool{}
	for _, it := range all {
		if seen[it.ID] || strings.Contains(it.Text, " old") {
			t.Fatalf("stale or duplicate: %+v", it)
		}
		seen[it.ID] = true
	}
	full, err := f.Full(all[6].ID)
	if err != nil || full.Text != "Latest" {
		t.Fatalf("full item: %+v %v", full, err)
	}
}

func TestCodexHistoryFileChangeKeepsPartsAtCompletion(t *testing.T) {
	line := func(status string) []byte {
		b, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]any{
			"type": "persona_history_snapshot", "turn_id": "files", "status": "inProgress",
			"items": []any{map[string]any{"order": 1, "item": map[string]any{"id": "edit", "type": "FileChange", "status": status,
				"changes": map[string]any{"/a": map[string]string{"type": "update"}, "/b": map[string]string{"type": "update"}}}}},
		}})
		return b
	}
	m := Meta{}
	running := ParseLine(1, line("inProgress"), &m)
	completed := ParseLine(2, line("completed"), &m)
	if len(running) != 2 || len(completed) != 4 {
		t.Fatalf("items = %d / %d", len(running), len(completed))
	}
	if running[0].ID != completed[0].ID || running[1].ID != completed[2].ID {
		t.Fatalf("file call identity changed: %+v / %+v", running, completed)
	}
}
