package node

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These are local journal fixtures, not a Codex database or a live session.
func quickHistoryFixture(t *testing.T, status, text string, outputBytes int) []byte {
	t.Helper()
	at := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	toolStatus := "completed"
	if status == "inProgress" {
		toolStatus = status
	}
	s := codexHistorySnapshot{Type: "persona_history_snapshot", TurnID: "fixture-turn", Status: status, Duration: 2000,
		Items: []codexHistorySnapshotItem{
			{At: at, Order: 0, Item: map[string]any{"type": "UserMessage", "id": "fixture-user", "content": []any{map[string]any{"type": "text", "text": "Inspect the fixture"}}}},
			{At: at.Add(time.Second), Order: 1, Item: map[string]any{"type": "AgentMessage", "id": "fixture-agent", "content": []any{map[string]any{"type": "text", "text": text}}}},
			{At: at.Add(2 * time.Second), Order: 2, Item: map[string]any{"type": "CommandExecution", "id": "fixture-tool", "command": []string{"pwd"}, "status": toolStatus, "aggregated_output": strings.Repeat("x", outputBytes)}},
		}}
	if status == "failed" {
		s.Error = json.RawMessage(`{"message":"fixture failure"}`)
	}
	b, err := json.Marshal(map[string]any{"type": "event_msg", "timestamp": at.Add(2 * time.Second), "payload": s})
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

func writeQuickHistoryFixture(t *testing.T, path string, records ...[]byte) os.FileInfo {
	t.Helper()
	b := []byte(`{"type":"session_meta","payload":{"id":"fixture","cwd":"/fixture","originator":"Codex Desktop"}}` + "\n")
	for _, record := range records {
		b = append(b, record...)
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func assertQuickHistoryState(t *testing.T, m quickMeta, status, text string) {
	t.Helper()
	wantOpen := status == "inProgress"
	if !m.codex || m.turnOpen != wantOpen || m.turnClosed == wantOpen {
		t.Errorf("%s: codex=%v open=%v closed=%v", status, m.codex, m.turnOpen, m.turnClosed)
	}
	wantError := ""
	if status == "failed" {
		wantError = "fixture failure"
	}
	if m.turnErr.text != wantError || m.turnErr.afterWork != (status == "failed") {
		t.Errorf("%s: error=%+v, want %q", status, m.turnErr, wantError)
	}
	if m.lastText != text {
		t.Errorf("%s: last text=%q, want %q", status, m.lastText, text)
	}
	wantTools := 0
	if wantOpen {
		wantTools = 1
	}
	if len(m.openTools) != wantTools {
		t.Errorf("%s: open tools=%d, want %d", status, len(m.openTools), wantTools)
	}
}

func TestCodexHistoryQuickMetaLargeSnapshot(t *testing.T) {
	for _, status := range []string{"completed", "failed", "inProgress"} {
		t.Run(status, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "history.jsonl")
			prior := quickHistoryFixture(t, "failed", "Old answer", 10)
			prev := readQuickMeta(path, writeQuickHistoryFixture(t, path, prior))
			latest := quickHistoryFixture(t, status, "Latest answer", 2*quickTail)
			st := writeQuickHistoryFixture(t, path, prior, latest)
			for name, m := range map[string]quickMeta{
				"cold": readQuickMeta(path, st), "warm": readQuickMetaSince(path, st, prev),
			} {
				t.Run(name, func(t *testing.T) { assertQuickHistoryState(t, m, status, "Latest answer") })
			}
		})
	}
}

func TestCodexHistoryQuickMetaRawToolInput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	// A real JSON argument, not escaped output text, can contain Claude's type marker.
	record := bytes.Replace(quickHistoryFixture(t, "failed", "Latest answer", 2*quickTail),
		[]byte(`"type":"CommandExecution"`),
		[]byte(`"type":"McpToolCall","server":"fixture","tool":"inspect","arguments":{"type":"user"}`), 1)
	m := readQuickMeta(path, writeQuickHistoryFixture(t, path, record))
	assertQuickHistoryState(t, m, "failed", "Latest answer")
}

func quickHistoryAppendFixture(t *testing.T, status, text string) []byte {
	t.Helper()
	at := time.Date(2026, 11, 21, 10, 0, 3, 0, time.UTC)
	s := codexHistorySnapshot{Type: "persona_history_append", TurnID: "fixture-turn", Status: status, Duration: 3000, HasWork: true}
	if text != "" {
		s.Items = []codexHistorySnapshotItem{{At: at, Order: 3, Item: map[string]any{"type": "AgentMessage", "id": "append-agent", "content": []any{map[string]any{"type": "text", "text": text}}}}}
	}
	if status == "failed" {
		s.Error = json.RawMessage(`{"message":"fixture failure"}`)
	}
	b, err := json.Marshal(map[string]any{"type": "event_msg", "timestamp": at, "payload": s})
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

func TestCodexHistoryQuickMetaAppendTail(t *testing.T) {
	for _, status := range []string{"completed", "failed", "inProgress"} {
		t.Run(status, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "history.jsonl")
			base := quickHistoryFixture(t, "inProgress", "Base answer", 2*quickTail)
			prev := readQuickMeta(path, writeQuickHistoryFixture(t, path, base))
			delta := quickHistoryAppendFixture(t, "inProgress", "Appended answer")
			end := quickHistoryAppendFixture(t, status, "") // terminal uses the envelope timestamp
			st := writeQuickHistoryFixture(t, path, base, delta, end)
			for name, m := range map[string]quickMeta{
				"cold": readQuickMeta(path, st), "warm": readQuickMetaSince(path, st, prev),
			} {
				t.Run(name, func(t *testing.T) {
					assertQuickHistoryState(t, m, status, "Appended answer")
					if m.lastPromptAt.IsZero() || !m.contentAt.Equal(time.Date(2026, 11, 21, 10, 0, 3, 0, time.UTC)) {
						t.Errorf("append lost prompt or envelope time: prompt=%v content=%v", m.lastPromptAt, m.contentAt)
					}
				})
			}
		})
	}
}

func TestCodexHistoryQuickMetaAppendUncommitted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	base := quickHistoryFixture(t, "inProgress", "Base answer", 2*quickTail)
	delta := quickHistoryAppendFixture(t, "inProgress", "Appended answer")
	end := quickHistoryAppendFixture(t, "completed", "")
	for _, n := range []int{len(end) / 2, len(end) - 1} {
		st := writeQuickHistoryFixture(t, path, base, delta, end[:n])
		assertQuickHistoryState(t, readQuickMeta(path, st), "inProgress", "Appended answer")
	}
}

func TestCodexHistoryQuickMetaUncommittedSnapshot(t *testing.T) {
	for _, status := range []string{"completed", "failed"} {
		for _, cut := range []string{"mid-record", "missing-newline"} {
			t.Run(status+"/"+cut, func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "history.jsonl")
				running := quickHistoryFixture(t, "inProgress", "Still working", 2*quickTail)
				prev := readQuickMeta(path, writeQuickHistoryFixture(t, path, running))
				final := quickHistoryFixture(t, status, "Finished", 2*quickTail)
				n := len(final) - 1
				if cut == "mid-record" {
					n /= 2
				}
				st := writeQuickHistoryFixture(t, path, running, final[:n])
				for name, m := range map[string]quickMeta{
					"cold": readQuickMeta(path, st), "warm": readQuickMetaSince(path, st, prev),
				} {
					t.Run(name, func(t *testing.T) { assertQuickHistoryState(t, m, "inProgress", "Still working") })
				}
				st = writeQuickHistoryFixture(t, path, running, final)
				assertQuickHistoryState(t, readQuickMetaSince(path, st, prev), status, "Finished")
			})
		}
	}
}

func TestCodexHistoryQuickMetaTruncatedDuringRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	final := quickHistoryFixture(t, "completed", "Finished", 2*quickTail)
	st := writeQuickHistoryFixture(t, path, final)
	// Supply the stat from before the concurrent truncation, as a list read can.
	if err := os.Truncate(path, st.Size()-100); err != nil {
		t.Fatal(err)
	}
	m := readQuickMeta(path, st)
	if !m.turnOpen || m.turnClosed || m.turnErr.text != "" {
		t.Fatalf("short read fabricated a terminal state: open=%v closed=%v error=%+v", m.turnOpen, m.turnClosed, m.turnErr)
	}
}

func TestCodexHistoryQuickMetaChangedCachedCompletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	final := quickHistoryFixture(t, "completed", "Finished", 2*quickTail)
	prev := readQuickMeta(path, writeQuickHistoryFixture(t, path, final))
	prev.readAt = time.Now()
	st := writeQuickHistoryFixture(t, path, final, quickHistoryFixture(t, "inProgress", "Next turn", 10)[:100])
	n := &Node{metas: map[string]quickMeta{path: prev}}
	m := n.meta(path, st) // cached by metaMinInterval: no background scan or service
	if !m.turnOpen || m.turnClosed || m.turnErr.text != "" {
		t.Fatalf("changed journal reused a cached completion: open=%v closed=%v error=%+v", m.turnOpen, m.turnClosed, m.turnErr)
	}
}

type quickHistoryReadProbe struct {
	io.ReaderAt
	first int64
	bytes int
}

func (r *quickHistoryReadProbe) ReadAt(p []byte, off int64) (int, error) {
	r.first = min(r.first, off)
	r.bytes += len(p)
	return r.ReaderAt.ReadAt(p, off)
}

func TestCodexHistoryQuickMetaReadsOnlyLatestRecord(t *testing.T) {
	old := bytes.Repeat([]byte("old record\n"), quickTail)
	latest := quickHistoryFixture(t, "completed", "Finished", 2*quickTail)
	partial := quickHistoryFixture(t, "inProgress", "Uncommitted", 2*quickTail)
	partial = partial[:len(partial)/2]
	data := bytes.Join([][]byte{old, latest, partial}, nil)
	r := &quickHistoryReadProbe{ReaderAt: bytes.NewReader(data), first: int64(len(data))}
	line, at, err := quickHistoryTail(r, int64(len(data)))
	if err != nil || at != int64(len(old)) || !bytes.Equal(line, latest) {
		t.Fatalf("wrong committed record: offset=%d, error=%v", at, err)
	}
	if r.first < int64(len(old)-quickTail) || r.bytes > 2*(len(latest)+len(partial)+quickTail) {
		t.Fatalf("read beyond the latest record and partial append: first=%d bytes=%d", r.first, r.bytes)
	}
}
