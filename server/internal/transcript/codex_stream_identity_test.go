package transcript

import (
	"encoding/json"
	"testing"

	"github.com/nwverse/persona/server/internal/proto"
)

func TestCodexStreamIdentityTranscriptItems(t *testing.T) {
	for _, history := range []bool{false, true} {
		meta := &Meta{}
		var items []proto.Item
		if history {
			items = ParseLine(1, []byte(`{"type":"event_msg","payload":{"type":"persona_history_snapshot","turn_id":"t1","status":"completed","duration_ms":12,"items":[{"order":0,"item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"question"}]}},{"order":1,"item":{"type":"AgentMessage","id":"a1","content":[{"type":"text","text":"answer"}]}}]}}`), meta)
		} else {
			for i, payload := range []string{
				`{"type":"task_started","turn_id":"t1"}`,
				`{"type":"item_completed","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"question"}]}}`,
				`{"type":"item_completed","item":{"type":"AgentMessage","id":"a1","content":[{"type":"text","text":"answer"}]}}`,
				`{"type":"task_complete","turn_id":"t1","duration_ms":12}`,
			} {
				items = append(items, ParseLine(i+1, []byte(`{"type":"event_msg","payload":`+payload+`}`), meta)...)
			}
		}
		if len(items) != 3 {
			t.Fatalf("history=%v items=%+v", history, items)
		}
		for _, item := range items {
			b, _ := json.Marshal(item)
			var wire map[string]any
			_ = json.Unmarshal(b, &wire)
			if wire["turn_id"] != "t1" {
				t.Fatalf("history=%v missing turn identity: %s", history, b)
			}
		}
	}
	meta := &Meta{}
	ParseLine(1, []byte(`{"type":"event_msg","payload":{"type":"task_started","turn_id":"aborted"}}`), meta)
	items := ParseLine(2, []byte(`{"type":"event_msg","payload":{"type":"turn_aborted"}}`), meta)
	b, _ := json.Marshal(items)
	var wire []map[string]any
	_ = json.Unmarshal(b, &wire)
	if len(wire) != 1 || wire[0]["turn_id"] != "aborted" {
		t.Fatalf("aborted identity: %s", b)
	}
}

func TestCodexStreamIdentityColdAppend(t *testing.T) {
	items := ParseLine(9, []byte(`{"type":"event_msg","payload":{"type":"persona_history_append","turn_id":"t2","status":"inProgress","items":[{"order":1,"item":{"type":"AgentMessage","id":"a2","content":[{"type":"text","text":"current"}]}}]}}`), &Meta{})
	if len(items) != 1 || items[0].TurnID != "t2" || items[0].ID != "history:t2:a2#1000000" {
		t.Fatalf("cold append lost source identity: %+v", items)
	}
}
