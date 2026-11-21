package transcript

import (
	"fmt"
	"maps"

	"github.com/nwverse/persona/server/internal/proto"
)

// ParseLineForEcho is a temporary, uncapped Codex user-input projection for exact echo comparison. It does not
// populate a File cache or change normal ParseLine limits, and assistant/tool content remains capped as usual.
func ParseLineForEcho(seq int, line []byte) []proto.Item {
	return ParseLine(seq, line, &Meta{echoFullText: true})
}

func (m *Meta) codexUserClip(text string) string {
	if m.echoFullText {
		return text
	}
	return clip(text)
}

// FullForEcho mirrors Full's indexed reread, but only for a user text item can it bypass the native parser text
// cap. The returned copy is for exact matching, never inserted into the page cache or sent to the client.
func (f *File) FullForEcho(id string) (proto.Item, error) {
	f.mu.Lock()
	it, found := f.item(id)
	if !found {
		it, found = f.findOlder(id)
	}
	ref, cut := f.cut[it.Seq]
	scratch := Meta{Sidechain: f.meta.Sidechain, Codex: f.meta.Codex,
		agentCalls: maps.Clone(f.meta.agentCalls), taskCalls: maps.Clone(f.meta.taskCalls), echoFullText: true}
	f.mu.Unlock()
	if !found {
		return it, fmt.Errorf("no item %s", id)
	}
	if it.Role != "user" || it.Kind != proto.KindText || it.ToolUseID != "" {
		return f.Full(id)
	}
	if !cut {
		return it, nil
	}
	full, ok := f.reparse(it.Seq, ref, &scratch)[id]
	if !ok {
		return it, fmt.Errorf("item %s: line %d of the transcript changed, reload the chat", id, it.Seq)
	}
	it.Text, it.FullSize = full.Text, 0
	return it, nil
}
