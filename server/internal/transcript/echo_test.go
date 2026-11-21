package transcript

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestFullForEchoDoesNotChangePageOrFullLimits(t *testing.T) {
	for _, kind := range []string{"native", "persona_history_snapshot", "persona_history_append"} {
		t.Run(kind, func(t *testing.T) {
			body := strings.Repeat("exact user input ", 80000) + "distinct end"
			item := map[string]any{"type": "UserMessage", "id": "u", "content": []any{map[string]any{"type": "text", "text": body}}}
			payload := map[string]any{"type": "item_completed", "item": item}
			if kind != "native" {
				payload = map[string]any{"type": kind, "turn_id": "t", "status": "inProgress", "items": []any{map[string]any{"order": 0, "item": item}}}
			}
			line, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": payload})
			path := filepath.Join(t.TempDir(), "echo.jsonl")
			if err := os.WriteFile(path, append(line, '\n'), 0600); err != nil {
				t.Fatal(err)
			}
			f := NewFile(path)
			if _, err := f.Refresh(); err != nil {
				t.Fatal(err)
			}
			before, _, _ := f.Page(0, 10)
			if len(before) != 1 || before[0].FullSize == 0 || len(before[0].Text) >= len(body) {
				t.Fatal("ordinary page cap changed")
			}
			normal, err := f.Full(before[0].ID)
			if err != nil || len(normal.Text) >= len(body) {
				t.Fatalf("ordinary Full parser limit changed: %v", err)
			}
			full, err := f.FullForEcho(before[0].ID)
			if err != nil || full.Text != body || full.FullSize != 0 || full.ID != before[0].ID || full.Seq != before[0].Seq {
				t.Fatalf("uncapped echo read failed: size=%d, err=%v", len(full.Text), err)
			}
			after, _, _ := f.Page(0, 10)
			if !reflect.DeepEqual(before, after) || f.Meta().echoFullText {
				t.Fatal("temporary echo read changed resident state")
			}
			if _, err := f.FullForEcho("missing"); err == nil {
				t.Fatal("invented missing user item")
			}
		})
	}
}

func TestParseLineForEchoOnlyUncapsCodexUserInput(t *testing.T) {
	body := strings.Repeat("exact text ", 100000)
	for _, kind := range []string{"UserMessage", "AgentMessage"} {
		line, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "item_completed", "item": map[string]any{
			"type": kind, "id": "item", "content": []any{map[string]any{"type": "text", "text": body}},
		}}})
		got := ParseLineForEcho(1, line)
		if len(got) != 1 {
			t.Fatalf("projection count = %d", len(got))
		}
		if (got[0].Text == strings.TrimSpace(body)) != (kind == "UserMessage") {
			t.Fatalf("uncapping escaped user-only scope for %s", kind)
		}
	}
}
