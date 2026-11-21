package transcript

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

// Persona's database projection journals complete revisions of its current turn.
// One physical line is one atomic revision; existing rollout formats do not use it.
// IDs retain the source item identity and a stable ordering slot, so every client can
// merge a revision with the same ID-based merge it uses for overlapping history pages.
func parseCodexHistory(seq int, at time.Time, raw json.RawMessage, meta *Meta) []proto.Item {
	var s struct {
		Type     string          `json:"type"`
		TurnID   string          `json:"turn_id"`
		Status   string          `json:"status"`
		Duration int64           `json:"duration_ms"`
		Error    json.RawMessage `json:"error"`
		HasWork  bool            `json:"has_work"`
		Items    []struct {
			At    time.Time       `json:"at"`
			Order int             `json:"order"`
			Item  json.RawMessage `json:"item"`
		} `json:"items"`
	}
	if json.Unmarshal(raw, &s) != nil || s.TurnID == "" {
		return nil
	}
	appendOnly := s.Type == "persona_history_append"
	if !appendOnly && meta.historyTurn == s.TurnID {
		meta.Turns, meta.Compactions = meta.historyTurns, meta.historyCompactions
	} else if !appendOnly {
		meta.historyTurn = s.TurnID
		meta.historyTurns, meta.historyCompactions = meta.Turns, meta.Compactions
	}
	if !appendOnly {
		meta.codexPending, meta.codexPendingIDs, meta.OpenTools = nil, nil, nil
	}
	event := func(at time.Time, payload any) []proto.Item {
		b, _ := json.Marshal(map[string]any{"type": "event_msg", "timestamp": at, "payload": payload})
		return ParseLine(seq, b, meta)
	}
	if len(s.Items) > 0 {
		at = s.Items[0].At
	}
	if !appendOnly {
		event(at, map[string]any{"type": "task_started", "turn_id": s.TurnID})
	}
	var out []proto.Item
	for _, row := range s.Items {
		if len(row.Item) == 0 {
			continue
		}
		at = row.At
		var status struct {
			Status string `json:"status"`
		}
		_ = json.Unmarshal(row.Item, &status)
		typ := "item_completed"
		if status.Status == "inProgress" {
			typ = "persona_item_running"
		}
		items := event(at, map[string]any{"type": typ, "item": row.Item})
		for i := range items {
			if items[i].ToolUseID == "" && (items[i].Role == "user" || items[i].Role == "assistant") {
				items[i].TurnID = s.TurnID // also available when a cold page starts at an append
			}
			// Reserve independent slots for a tool's call, result and images: completing
			// a tool does not renumber any following item in the same snapshot.
			root, suffix, _ := strings.Cut(items[i].ID, "#")
			part, _ := strconv.Atoi(suffix)
			items[i].ID = fmt.Sprintf("history:%s:%s#%d", s.TurnID, root, row.Order*1_000_000+part)
			if items[i].Role == "user" && items[i].Kind == proto.KindText && items[i].ToolUseID == "" {
				meta.codexUserID = items[i].ID
			}
		}
		out = append(out, items...)
	}
	meta.codexWorked(out)
	if s.HasWork {
		meta.turnWorked = true
	}
	if s.Status == "completed" || s.Status == "failed" || s.Status == "interrupted" {
		typ := "task_complete"
		if s.Status == "interrupted" {
			typ = "turn_aborted"
		}
		errJSON := s.Error
		if s.Status == "failed" && (len(errJSON) == 0 || string(errJSON) == "null") {
			errJSON = json.RawMessage(`{"message":"The turn failed."}`)
		}
		end := event(at, map[string]any{"type": typ, "turn_id": s.TurnID, "duration_ms": s.Duration, "error": errJSON})
		for i := range end {
			end[i].TurnID = s.TurnID
			end[i].ID = fmt.Sprintf("history:%s:end#%d", s.TurnID, 9_000_000_000_000+i)
		}
		out = append(out, end...)
	}
	meta.historySnapshot, meta.historySeq = s.TurnID, seq
	meta.historyAppend = appendOnly
	return out
}

// The current revision replaces the previous one in the reader's cache as well as
// in its outgoing batch. Historical pages must never resurrect an earlier revision.
func trackCodexHistory(t *branchTree, meta *Meta, kept, sent *[]proto.Item) {
	id, seq := meta.historySnapshot, meta.historySeq
	meta.historySnapshot = ""
	if id == "" {
		return
	}
	if t.historySnapshots == nil {
		t.historySnapshots = map[string]historySpan{}
	}
	old := t.historySnapshots[id]
	if meta.historyAppend {
		if old.start == 0 {
			old.start = seq
		}
		old.end = seq
		t.historySnapshots[id] = old
		return
	}
	if old.start > 0 {
		for _, list := range []*[]proto.Item{kept, sent} {
			if list != nil {
				// Revisions replace the active tail. Do not scan an entire warm, long
				// conversation each time the current turn changes.
				lo := sort.Search(len(*list), func(i int) bool { return (*list)[i].Seq >= old.start })
				hi := sort.Search(len(*list), func(i int) bool { return (*list)[i].Seq > old.end })
				*list = slices.Delete(*list, lo, hi)
			}
		}
	}
	t.historySnapshots[id] = historySpan{seq, seq}
}

type historySpan struct{ start, end int }

// EchoBoundary atomically captures the transport cursor and input identities that a
// revision of the current history turn can replay. Native append-only files need no
// exclusion list. It reads only the active turn already in the bounded item cache.
func (f *File) EchoBoundary() (int, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tree == nil {
		return f.lines, nil
	}
	span := f.tree.historySnapshots[f.meta.historyTurn]
	if span.start == 0 {
		return f.lines, nil
	}
	var ids []string
	start := sort.Search(len(f.items), func(i int) bool { return f.items[i].Seq >= span.start })
	for _, it := range f.items[start:] {
		if it.Seq > span.end {
			break
		}
		if it.Role != "user" || it.ToolUseID != "" || (it.Kind != proto.KindText && it.Kind != proto.KindImage) {
			continue
		}
		stem, _, _ := strings.Cut(it.ID, "#")
		if !slices.Contains(ids, stem) {
			ids = append(ids, stem)
		}
	}
	return f.lines, ids
}

func olderCodexHistory(older []proto.Item, pre, current *branchTree) []proto.Item {
	if len(pre.historySnapshots) == 0 {
		return older
	}
	if current.historySnapshots == nil {
		current.historySnapshots = map[string]historySpan{}
	}
	var stale []historySpan
	for id, span := range pre.historySnapshots {
		if current.historySnapshots[id].start > span.start {
			stale = append(stale, span)
		} else {
			current.historySnapshots[id] = span
		}
	}
	return slices.DeleteFunc(older, func(it proto.Item) bool {
		for _, span := range stale {
			if it.Seq >= span.start && it.Seq <= span.end {
				return true
			}
		}
		return false
	})
}
