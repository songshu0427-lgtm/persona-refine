package node

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nwverse/persona/server/internal/transcript"
)

// A snapshot is one complete JSONL record, so a concurrent reader never observes half a
// revision. Only the last written turn and newer turns are queried; unchanged snapshots
// append nothing. The immutable prefix, the file lock and the mark/rebuild contract stay
// the same as the completed-only exporter. TRAE retains its separate projection contract.
type codexHistorySnapshot struct {
	Type     string                     `json:"type"`
	TurnID   string                     `json:"turn_id"`
	Status   string                     `json:"status"`
	Duration int64                      `json:"duration_ms"`
	Error    json.RawMessage            `json:"error,omitempty"`
	HasWork  bool                       `json:"has_work,omitempty"`
	Items    []codexHistorySnapshotItem `json:"items"`
}

type codexHistorySnapshotItem struct {
	At    time.Time      `json:"at"`
	Order int            `json:"order"`
	Item  map[string]any `json:"item"`
}

func writeCodexHistorySnapshots(ctx context.Context, db string, t codexAppThread, path string, mark codexHistoryMark, grow bool) (res codexHistoryWrite, err error) {
	res.turn = -1
	if !validID(t.ID) {
		return res, fmt.Errorf("bad thread id")
	}
	sqlite, err := exec.LookPath("sqlite3")
	if err != nil {
		return res, err
	}
	cte, err := codexHistoryTurnsSQL(filepath.Dir(db), t)
	if err != nil {
		return res, err
	}
	from := int64(-1)
	where := "t.history_ordinal >= -1"
	if grow {
		from = mark.Turn
		where = fmt.Sprintf("t.history_ordinal >= %d", from)
		for ordinal := range mark.Unsettled {
			where += fmt.Sprintf(" OR t.history_ordinal = %d", ordinal)
		}
		res = codexHistoryWrite{turn: mark.Turn, turnID: mark.TurnID, status: mark.Status, snapshot: mark.Snapshot, unsettled: maps.Clone(mark.Unsettled), itemIDs: mark.ItemIDs, fileOrder: mark.FileOrder, rows: mark.Rows}
	}
	oneLine := func(col string) string {
		return `REPLACE(REPLACE(COALESCE(` + col + `, ''), char(10), ' '), char(13), ' ')`
	}
	query := cte + `SELECT t.history_ordinal, t.turn_id, t.status, COALESCE(t.duration_ms, -1), ` + oneLine("t.error_json") + `, COALESCE(i.created_at_ms, 0), COALESCE(i.item_type, ''), COALESCE(i.rollout_ordinal, 0), ` + oneLine("i.item_json") + ` FROM history t LEFT JOIN thread_items i ON i.thread_id = t.thread_id AND i.turn_id = t.turn_id WHERE ` + where + ` ORDER BY t.history_ordinal, i.rollout_ordinal`
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, sqlite, "-readonly", "-bail", "-noheader", "-list", "-separator", "\x1f", "-cmd", ".timeout 2000", codexDBTarget(db), query)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return res, err
	}
	stage, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return res, err
	}
	defer stage.Close()
	defer os.Remove(stage.Name())
	if err := cmd.Start(); err != nil {
		return res, err
	}
	w := bufio.NewWriter(stage)
	line := func(at time.Time, typ string, payload any) error {
		return json.NewEncoder(w).Encode(map[string]any{"timestamp": at.UTC().Format(time.RFC3339Nano), "type": typ, "payload": payload})
	}
	meta := grow
	var cur *codexHistorySnapshot
	var ordinal int64
	sourceStatus := ""
	at := time.UnixMilli(t.UpdatedAtMs)
	checked := map[int64]bool{}
	foundMark := !grow
	flush := func(hasNext bool) error {
		if cur == nil {
			return nil
		}
		if hasNext && cur.Status == "inProgress" {
			cur.Status = "interrupted"
		}
		rows := make([]string, 0, len(cur.Items))
		for _, row := range cur.Items {
			b, _ := json.Marshal(row)
			h := sha256.Sum256(b)
			rows = append(rows, hex.EncodeToString(h[:]))
			if row.Item["type"] != "UserMessage" {
				cur.HasWork = true
			}
		}
		b, _ := json.Marshal(cur)
		h := sha256.Sum256(b)
		digest := hex.EncodeToString(h[:])
		var prior map[string][]string
		if grow && ordinal == mark.Turn {
			prior = mark.FileOrder
		}
		fileOrder := codexHistoryFileOrder(cur, prior)
		if grow && ordinal < mark.Turn {
			checked[ordinal] = true
			if mark.Unsettled[ordinal] != digest {
				return errCodexHistoryChanged
			}
			return nil
		}
		if res.unsettled == nil {
			res.unsettled = map[int64]string{}
		}
		if hasNext && sourceStatus == "inProgress" {
			res.unsettled[ordinal] = digest
		}
		ids := res.itemIDs
		if !(grow && ordinal == mark.Turn && digest == mark.Snapshot) {
			raw, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": cur})
			items := transcript.ParseLine(1, raw, &transcript.Meta{})
			ids = make([]string, 0, len(items))
			present := map[string]bool{}
			for _, item := range items {
				ids = append(ids, item.ID)
				present[item.ID] = true
			}
			if grow && ordinal == mark.Turn {
				for _, id := range mark.ItemIDs {
					if !present[id] {
						return errCodexHistoryChanged
					}
				}
			}
			if !meta {
				originator := "Codex Desktop"
				if t.Paginated && t.Source != "vscode" {
					originator = "Codex"
				}
				started := at
				if len(cur.Items) > 0 {
					started = cur.Items[0].At
				}
				if err := line(started, "session_meta", map[string]any{"id": t.ID, "cwd": t.Cwd, "originator": originator, "source": t.Source}); err != nil {
					return err
				}
				meta = true
			}
			published := *cur
			if grow && ordinal == mark.Turn && mark.Status == "inProgress" && len(mark.Rows) > 0 && len(rows) >= len(mark.Rows) && slices.Equal(rows[:len(mark.Rows)], mark.Rows) {
				published.Type = "persona_history_append"
				published.Items = cur.Items[len(mark.Rows):]
			}
			if err := line(at, "event_msg", &published); err != nil {
				return err
			}
		}
		res.turn, res.turnID, res.status, res.snapshot, res.itemIDs = ordinal, cur.TurnID, sourceStatus, digest, ids
		res.fileOrder = fileOrder
		res.rows = rows
		return nil
	}
	r := bufio.NewReaderSize(stdout, 1<<20)
	for {
		row, readErr := r.ReadBytes('\n')
		if len(row) > 0 {
			parts := strings.SplitN(strings.TrimSuffix(string(row), "\n"), "\x1f", 9)
			if len(parts) != 9 {
				err = fmt.Errorf("invalid Codex history row")
				break
			}
			n, parseErr := strconv.ParseInt(parts[0], 10, 64)
			if parseErr != nil {
				err = parseErr
				break
			}
			if cur == nil || n != ordinal {
				if grow && n == mark.Turn {
					foundMark = true
					if parts[1] != mark.TurnID || (mark.Status != "inProgress" && parts[2] != mark.Status) {
						err = errCodexHistoryChanged
						break
					}
				}
				if err = flush(true); err != nil {
					break
				}
				duration, _ := strconv.ParseInt(parts[3], 10, 64)
				cur = &codexHistorySnapshot{Type: "persona_history_snapshot", TurnID: parts[1], Status: parts[2], Duration: duration}
				if json.Valid([]byte(parts[4])) {
					cur.Error = json.RawMessage(parts[4])
				}
				ordinal, sourceStatus = n, parts[2]
			}
			if ms, _ := strconv.ParseInt(parts[5], 10, 64); ms > 0 {
				at = time.UnixMilli(ms)
			}
			if item := codexHistoryItem(parts[6], []byte(parts[8]), true); item != nil {
				order, _ := strconv.Atoi(parts[7])
				cur.Items = append(cur.Items, codexHistorySnapshotItem{At: at, Order: order, Item: item})
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				err = readErr
			}
			break
		}
	}
	if err != nil {
		cancel()
	}
	waitErr := cmd.Wait()
	if err != nil {
		return res, err
	}
	if waitErr != nil {
		return res, fmt.Errorf("%v: %s", waitErr, strings.TrimSpace(stderr.String()))
	}
	if !foundMark {
		return res, errCodexHistoryChanged
	}
	if err = flush(false); err != nil {
		return res, err
	}
	for ordinal := range mark.Unsettled {
		if grow && !checked[ordinal] {
			return res, errCodexHistoryChanged
		}
	}
	if err = w.Flush(); err != nil {
		return res, err
	}
	if !grow {
		if res.turn < 0 && !t.Paginated {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return res, err
			}
			return res, nil
		}
		if !meta {
			if err = line(at, "session_meta", map[string]any{"id": t.ID, "cwd": t.Cwd}); err != nil {
				return res, err
			}
			if err = w.Flush(); err != nil {
				return res, err
			}
		}
		if err = stage.Close(); err != nil {
			return res, err
		}
		return res, os.Rename(stage.Name(), path)
	}
	if _, err = stage.Seek(0, io.SeekStart); err != nil {
		return res, err
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return res, err
	}
	_, err = io.Copy(file, stage)
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	return res, err
}

// A file-change row may grow while it runs. Keep already displayed file slots and
// append newly reported paths; sorting the whole set again would change tool IDs.
func codexHistoryFileOrder(s *codexHistorySnapshot, prior map[string][]string) map[string][]string {
	orders := map[string][]string{}
	for _, row := range s.Items {
		if row.Item["type"] != "FileChange" {
			continue
		}
		id, _ := row.Item["id"].(string)
		changes, _ := row.Item["changes"].(map[string]map[string]string)
		paths := slices.Clone(prior[id])
		var added []string
		for path := range changes {
			if !slices.Contains(paths, path) {
				added = append(added, path)
			}
		}
		sort.Strings(added)
		paths = append(paths, added...)
		row.Item["persona_file_order"], orders[id] = paths, paths
	}
	return orders
}
