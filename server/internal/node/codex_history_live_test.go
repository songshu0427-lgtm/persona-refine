package node

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/transcript"
)

// The fixture is an App-only database; no model or desktop connection is used.
func TestCodexHistoryLiveBeforeTurnCompletes(t *testing.T) {
	n := remoteTestNode(t)
	home, project := n.codexHome(), t.TempDir()
	writeCodexApp(t, home, project, codexAppSchema+codexAppRow(appChat, "", project, "Live history", time.Now(), 0))
	turn := historyTurn{thread: appChat, id: "live-turn", status: "inProgress", ordinal: 0, items: [][2]string{
		userItem("live-user", "check the export"), answerItem("live-agent", "Checking."),
		{"commandExecution", `{"id":"live-tool","command":"pwd","status":"completed","aggregatedOutput":"/project","exitCode":0}`},
	}}
	writeCodexHistory(t, home, []historyTurn{turn})
	id, _ := readChat(t, n, appChat)
	f, err := n.file(id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Refresh(); err != nil {
		t.Fatal(err)
	}
	first, _, _ := f.Page(0, 80)
	if len(first) != 4 || !f.Meta().TurnOpen || f.Meta().TurnClosed {
		t.Fatalf("running history: %s; open=%v closed=%v", historyText(first), f.Meta().TurnOpen, f.Meta().TurnClosed)
	}
	ids := map[string]bool{}
	for _, it := range first {
		ids[it.ID] = true
	}
	turn.items[1] = answerItem("live-agent", "Checking the encoder.")
	turn.items = append(turn.items, answerItem("live-next", "The tool returned."))
	writeCodexHistory(t, home, []historyTurn{turn})
	if _, err := n.file(id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Refresh(); err != nil {
		t.Fatal(err)
	}
	assert := func(want int) []proto.Item {
		t.Helper()
		page, _, _ := f.Page(0, 80)
		seen := map[string]bool{}
		for _, it := range page {
			if seen[it.ID] {
				t.Fatalf("duplicate %s", it.ID)
			}
			seen[it.ID] = true
		}
		for id := range ids {
			if !seen[id] {
				t.Fatalf("lost stable ID %s", id)
			}
		}
		if len(page) != want || !strings.Contains(historyText(page), "Checking the encoder.") {
			t.Fatalf("page: %s", historyText(page))
		}
		return page
	}
	assert(5)
	if _, err := n.file(id); err != nil {
		t.Fatal(err)
	}
	if fresh, err := f.Refresh(); err != nil || len(fresh) != 0 {
		t.Fatalf("repeated poll: %v %v", fresh, err)
	}
	turn.status = "completed"
	writeCodexHistory(t, home, []historyTurn{turn})
	if _, err := n.file(id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Refresh(); err != nil {
		t.Fatal(err)
	}
	assert(6)
	if f.Meta().TurnOpen || !f.Meta().TurnClosed {
		t.Fatal("missing real completion")
	}
}

func TestCodexHistoryFileChangeGrowthKeepsPublishedSlots(t *testing.T) {
	n := remoteTestNode(t)
	home, project := n.codexHome(), t.TempDir()
	writeCodexApp(t, home, project, codexAppSchema+codexAppRow(appChat, "", project, "File changes", time.Now(), 0))
	turn := historyTurn{thread: appChat, id: "files", ordinal: 0, status: "inProgress", items: [][2]string{
		userItem("u", "apply changes"),
		{"fileChange", `{"id":"edit","status":"inProgress","changes":[{"path":"/z","kind":{"type":"update"},"diff":"first"}]}`},
	}}
	writeCodexHistory(t, home, []historyTurn{turn})
	id, _ := readChat(t, n, appChat)
	f, _ := n.file(id)
	first, _, span := f.Page(0, 80)
	if len(first) != 2 {
		t.Fatal(first)
	}
	turn.items[1][1] = `{"id":"edit","status":"completed","changes":[{"path":"/a","kind":{"type":"update"},"diff":"new"},{"path":"/z","kind":{"type":"update"},"diff":"first"}]}`
	writeCodexHistory(t, home, []historyTurn{turn})
	n.file(id)
	if _, err := f.Refresh(); err != nil {
		t.Fatal(err)
	}
	page, _, after := f.Page(0, 80)
	if span.History != after.History || len(page) != 5 || page[1].ID != first[1].ID || page[1].ToolUseID != first[1].ToolUseID {
		t.Fatalf("file growth reset published work: %+v -> %+v", first, page)
	}
}

func TestCodexHistoryLiveDoesNotRewriteCompletedPrefix(t *testing.T) {
	n := remoteTestNode(t)
	home, project := n.codexHome(), t.TempDir()
	writeCodexApp(t, home, project, codexAppSchema+codexAppRow(appChat, "", project, "Long history", time.Now(), 0))
	var turns []historyTurn
	for i := 0; i < 200; i++ {
		turns = append(turns, historyTurn{thread: appChat, id: fmt.Sprintf("t%d", i), ordinal: i, status: "completed", items: [][2]string{userItem(fmt.Sprintf("u%d", i), strings.Repeat("prefix", 200))}})
	}
	turns = append(turns, historyTurn{thread: appChat, id: "live", ordinal: 200, status: "inProgress", items: [][2]string{userItem("live-user", "current"), answerItem("a", "First")}})
	writeCodexHistory(t, home, turns)
	id, _ := readChat(t, n, appChat)
	p := n.transcriptPath(id)
	before, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	st := statOf(t, p)
	turns[200].items[1] = answerItem("a", "Second")
	writeCodexHistory(t, home, turns)
	if err := n.refreshCodexAppHistory(id); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(st, statOf(t, p)) || !bytes.HasPrefix(after, before) || len(after)-len(before) > 2048 {
		t.Fatalf("long prefix rewritten: %d -> %d", len(before), len(after))
	}
	st = statOf(t, p)
	for i := 0; i < 3; i++ {
		if err := n.refreshCodexAppHistory(id); err != nil {
			t.Fatal(err)
		}
	}
	if next := statOf(t, p); next.Size() != st.Size() || !next.ModTime().Equal(st.ModTime()) {
		t.Fatal("unchanged polls wrote history")
	}
	t.Logf("completed prefix %d bytes untouched; current-turn update appended %d bytes", len(before), len(after)-len(before))
}

func TestCodexHistoryAppendOnlyGrowthDoesNotCopyActiveWork(t *testing.T) {
	n := remoteTestNode(t)
	home, project := n.codexHome(), t.TempDir()
	writeCodexApp(t, home, project, codexAppSchema+codexAppRow(appChat, "", project, "Long running turn", time.Now(), 0))
	turn := historyTurn{thread: appChat, id: "active", ordinal: 0, status: "inProgress", items: [][2]string{userItem("u", "inspect"), answerItem("a", strings.Repeat("recorded output ", 10000))}}
	writeCodexHistory(t, home, []historyTurn{turn})
	id, _ := readChat(t, n, appChat)
	f, err := n.file(id)
	if err != nil {
		t.Fatal(err)
	}
	page, _, _ := f.Page(0, 80)
	oldUserID := page[0].ID
	before := statOf(t, f.Where()).Size()
	turn.items = append(turn.items, answerItem("next", "Next result"))
	writeCodexHistory(t, home, []historyTurn{turn})
	n.file(id)
	fresh, err := f.Refresh()
	if err != nil {
		t.Fatal(err)
	}
	if len(fresh) != 1 || fresh[0].Text != "Next result" {
		t.Fatalf("append replayed old work: %+v", fresh)
	}
	if grew := statOf(t, f.Where()).Size() - before; grew > 1024 {
		t.Fatalf("append copied active work: %d", grew)
	}
	_, excluded := f.EchoBoundary()
	if !slices.Contains(excluded, strings.Split(oldUserID, "#")[0]) {
		t.Fatal("append lost replayable input boundary")
	}
	turn.status = "completed"
	writeCodexHistory(t, home, []historyTurn{turn})
	n.file(id)
	fresh, err = f.Refresh()
	if err != nil || len(fresh) != 1 || fresh[0].TurnDuration == nil || fresh[0].TS.IsZero() {
		t.Fatalf("completion: %+v %v", fresh, err)
	}
	if f.Meta().Turns != 1 || !f.Meta().TurnClosed {
		t.Fatal("append changed turn metadata")
	}
	cold := transcript.NewFile(f.Where())
	if _, err := cold.Refresh(); err != nil {
		t.Fatal(err)
	}
	all, _, _ := cold.Page(0, 80)
	if len(all) != 4 || all[0].ID != oldUserID {
		t.Fatalf("cold append replay: %d items", len(all))
	}
}

// An isolated continuation DB, an old rollout that still exists, and the same pipe RPC
// subscriber used by watch tests exercise the actual database -> projection -> push path.
func TestCodexHistoryLivePaginatedWatchAndReconnect(t *testing.T) {
	n := remoteTestNode(t)
	home := n.codexHome()
	turns := []historyTurn{{thread: remoteRaw, id: "prefix", ordinal: 0, status: "completed", items: [][2]string{userItem("prefix-user", "retained prefix")}}}
	id := paginatedCodex(t, n, home, remoteRaw, turns)
	src, _ := n.codexSource(id)
	oldBytes, err := os.ReadFile(src.path)
	if err != nil {
		t.Fatal(err)
	}
	segment := strings.TrimSuffix(src.path, ".jsonl") + "_" + remoteOther + ".jsonl"
	header := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"history_base":{"thread_id":%q,"end_ordinal_exclusive":1}}}`+"\n", remoteRaw, remoteRaw)
	if err := os.WriteFile(segment, []byte(header), 0600); err != nil {
		t.Fatal(err)
	}
	writeCodexApp(t, home, home, fmt.Sprintf("UPDATE threads SET rollout_path = '%s'", segment))
	invalidateCodexPaginated(home)
	f, err := n.file(id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Refresh(); err != nil {
		t.Fatal(err)
	}
	if f.Where() == src.path {
		t.Fatal("selected old rollout")
	}
	hub := withHub(t, n)
	if err := n.watch(id, f.LastSeq()); err != nil {
		t.Fatal(err)
	}
	defer n.unwatch(id)
	turn := historyTurn{thread: remoteOther, id: "active", ordinal: 10, status: "inProgress", items: [][2]string{
		userItem("active-user", "inspect the encoder"), answerItem("active-agent", "Inspecting."),
		{"commandExecution", `{"id":"active-command","command":"pwd","status":"inProgress"}`},
	}}
	turns = append(turns, turn)
	writeCodexHistory(t, home, turns)
	waitFor(t, "unfinished items pushed", func() bool { return strings.Contains(historyText(hub.got()), "Inspecting.") })
	if !f.Meta().TurnOpen || f.Meta().TurnClosed {
		t.Fatal("unfinished watch falsely completed")
	}
	first, _, before := f.Page(0, 80)
	if !slices.ContainsFunc(first, func(it proto.Item) bool { return it.Kind == proto.KindToolUse }) {
		t.Fatal("running tool missing")
	}
	turn.items[1] = answerItem("active-agent", "The encoder is ready.")
	turn.items[2] = [2]string{"commandExecution", `{"id":"active-command","command":"pwd","status":"failed","aggregatedOutput":"fixture failure","exitCode":1}`}
	turns[1] = turn
	writeCodexHistory(t, home, turns)
	waitFor(t, "item revision pushed", func() bool { return strings.Contains(historyText(hub.got()), "The encoder is ready.") })
	turn.status, turn.errJSON = "failed", `{"message":"fixture turn failed"}`
	turns[1] = turn
	writeCodexHistory(t, home, turns)
	// Refresh commits reader metadata before the pipe peer receives session.items.
	// Assert the subscriber's terminal, not merely the writer's local completion.
	waitFor(t, "real terminal pushed", func() bool {
		return slices.ContainsFunc(hub.got(), func(it proto.Item) bool {
			return strings.HasPrefix(it.ID, "history:active:end#")
		})
	})
	page, _, final := f.Page(0, 80)
	if final.History != before.History {
		t.Fatal("ordinary revisions reset history")
	}
	if f.Meta().TurnError != "fixture turn failed" || len(f.Meta().OpenTools) != 0 {
		t.Fatal("failed terminal metadata missing")
	}
	merged := map[string]proto.Item{}
	for _, it := range first {
		merged[it.ID] = it
	}
	for _, it := range hub.got() {
		merged[it.ID] = it
	}
	if len(merged) != len(page) {
		t.Fatalf("subscriber duplicated: %d / %d", len(merged), len(page))
	}
	for _, it := range page {
		if merged[it.ID].Text != it.Text {
			t.Fatalf("subscriber missed %s", it.ID)
		}
	}
	// Reconnect from the revision before completion: the same IDs update, never another turn.
	n.unwatch(id)
	if err := n.watch(id, before.To); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "reconnect catchup", func() bool { spans := hub.spans(); return len(spans) > 0 && spans[len(spans)-1].toSeq == final.To })
	cold := transcript.NewFile(f.Where())
	if _, err := cold.Refresh(); err != nil {
		t.Fatal(err)
	}
	coldPage, _, _ := cold.Page(0, 80)
	want, _ := json.Marshal(page)
	got, _ := json.Marshal(coldPage)
	if string(want) != string(got) {
		t.Fatal("cold subscriber differs from live subscriber")
	}
	if raw, _ := os.ReadFile(src.path); string(raw) != string(oldBytes) {
		t.Fatal("old rollout was modified")
	}
	if trace := os.Getenv("PERSONA_CODEX_HISTORY_TRACE"); trace != "" {
		b, err := json.MarshalIndent(map[string]any{"initial": first, "pushes": hub.got(), "final": page}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(trace, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("in-progress DB -> watched session.items verified; initial seq=%d final seq=%d stable items=%d", before.To, final.To, len(page))
}
