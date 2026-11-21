package node

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/screen"
)

// Remote permission cards for Claude sessions outside Persona's terminals (Claude Desktop, external CLI) running
// Persona's Claude Code plugin (`hooks/hooks.json` `PermissionRequest` -> `persona-node hook --persona-plugin-permission`
// -> `POST /claude-plugin/v1/permission`).
//
// Each open permission request is held across repeated 25 s long-polls, surfaced alongside `outsideAskCards` on
// `codex.interactions` with `clp_` ids, and answered from mobile / web / Feishu via `codex.answer`. If the user answers
// on the computer or interrupts the turn, the node detects `sessions/<pid>.json` leaving `"waiting"` or transcript
// advancement (or receives an explicit `cancel: true`) and retires both the remote card and the waiting hook at once.

const outsidePermPrefix = "clp_"

var (
	ccPluginPermGrace     = 5 * time.Second
	ccPluginPermWatchStep = 250 * time.Millisecond
)

type ccPluginPermInput struct {
	SessionID      string          `json:"session_id"`
	RequestID      string          `json:"request_id"`
	AgentID        string          `json:"agent_id"`
	ToolName       string          `json:"tool_name"`
	ToolInput      json.RawMessage `json:"tool_input"`
	Cwd            string          `json:"cwd"`
	TranscriptPath string          `json:"transcript_path"`
	PermissionMode string          `json:"permission_mode"`
	WaitMS         int64           `json:"wait_ms"`
	Cancel         bool            `json:"cancel"`
}

type ccPluginPermEntry struct {
	sessionID        string
	pid              int
	requestID        string
	ix               proto.Interaction
	transcriptPath   string
	transcriptOffset int64
	sawWaiting       bool
	lastSeen         time.Time
	decided          bool
	reply            map[string]any
	replyCh          chan map[string]any
	doneCh           chan struct{}
}

type ccPluginPermRegistry struct {
	mu    sync.Mutex
	items map[string]*ccPluginPermEntry // card id (clp_...) -> entry
}

func outsidePermCardID(sessionID, requestID string) string {
	return outsidePermPrefix + shortHash(sessionID+"\x00"+requestID)
}

func validPermRequestID(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func (r *ccPluginPermRegistry) pruneLocked(now time.Time, live map[string]int) (expired bool) {
	for id, e := range r.items {
		if live != nil && live[e.sessionID] != e.pid {
			if e.doneCh != nil {
				close(e.doneCh)
				e.replyCh, e.doneCh = nil, nil
			}
			delete(r.items, id)
			if !e.decided {
				expired = true
			}
			continue
		}
		if e.replyCh == nil && now.Sub(e.lastSeen) > ccPluginPermGrace {
			delete(r.items, id)
			if !e.decided {
				expired = true
			}
		}
	}
	return expired
}

func (r *ccPluginPermRegistry) polled(
	sessionID string,
	pid int,
	requestID string,
	ix proto.Interaction,
	transcriptPath string,
	transcriptOffset int64,
	waiting bool,
) (replyCh chan map[string]any, doneCh chan struct{}, immediate map[string]any, added bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.items == nil {
		r.items = map[string]*ccPluginPermEntry{}
	}
	now := time.Now()
	r.pruneLocked(now, nil)
	id := ix.ID
	e := r.items[id]
	if e != nil && e.pid == pid && e.decided {
		out := e.reply
		delete(r.items, id)
		return nil, nil, out, false
	}
	if e == nil || e.pid != pid {
		e = &ccPluginPermEntry{
			sessionID:        sessionID,
			pid:              pid,
			requestID:        requestID,
			ix:               ix,
			transcriptPath:   transcriptPath,
			transcriptOffset: transcriptOffset,
			sawWaiting:       waiting,
		}
		r.items[id] = e
		added = true
	} else if waiting {
		e.sawWaiting = true
	}
	if e.doneCh != nil {
		close(e.doneCh)
		e.replyCh, e.doneCh = nil, nil
	}
	e.lastSeen = now
	e.replyCh = make(chan map[string]any, 1)
	e.doneCh = make(chan struct{})
	return e.replyCh, e.doneCh, nil, added
}

func (r *ccPluginPermRegistry) pollEnded(id string, replyCh chan map[string]any) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.items[id]
	if e == nil {
		select {
		case out := <-replyCh:
			return out
		default:
			return nil
		}
	}
	if e.replyCh != replyCh {
		select {
		case out := <-replyCh:
			return out
		default:
			return nil
		}
	}
	e.replyCh, e.doneCh = nil, nil
	e.lastSeen = time.Now()
	if e.decided {
		out := e.reply
		delete(r.items, id)
		return out
	}
	return nil
}

func (r *ccPluginPermRegistry) cancel(sessionID string, pid int, requestID string) (removedOpen bool) {
	id := outsidePermCardID(sessionID, requestID)
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.items[id]
	if e == nil || e.pid != pid {
		return false
	}
	if e.doneCh != nil {
		close(e.doneCh)
		e.replyCh, e.doneCh = nil, nil
	}
	wasOpen := !e.decided
	delete(r.items, id)
	return wasOpen
}

func (r *ccPluginPermRegistry) lookup(sessionID string, pid int, id string) (proto.Interaction, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	e := r.items[id]
	if e == nil || e.sessionID != sessionID || e.pid != pid || e.decided {
		return proto.Interaction{}, false
	}
	if e.replyCh == nil && now.Sub(e.lastSeen) > ccPluginPermGrace {
		delete(r.items, id)
		return proto.Interaction{}, false
	}
	return e.ix, true
}

func (r *ccPluginPermRegistry) decide(sessionID string, pid int, id string, reply map[string]any) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	e := r.items[id]
	if e == nil || e.sessionID != sessionID || e.pid != pid || e.decided {
		return false
	}
	if e.replyCh == nil && now.Sub(e.lastSeen) > ccPluginPermGrace {
		delete(r.items, id)
		return false
	}
	e.decided = true
	e.reply = reply
	e.lastSeen = now
	if e.replyCh != nil {
		e.replyCh <- reply
		e.replyCh, e.doneCh = nil, nil
		delete(r.items, id)
	}
	return true
}

func (r *ccPluginPermRegistry) observeStatus(id string, pid int, status string) (sawWaiting bool, tpath string, toffset int64, open bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.items[id]
	if e == nil || e.pid != pid || e.decided {
		return false, "", 0, false
	}
	if status == "waiting" {
		e.sawWaiting = true
	}
	return e.sawWaiting, e.transcriptPath, e.transcriptOffset, true
}

func (r *ccPluginPermRegistry) cards(live map[string]int, now time.Time) (out []proto.Interaction, expired bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	expired = r.pruneLocked(now, live)
	for _, e := range r.items {
		if e.decided {
			continue
		}
		out = append(out, e.ix)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, expired
}

func (r *ccPluginPermRegistry) attentionReason(sessionID string, pid int, now time.Time) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var latest *ccPluginPermEntry
	for _, e := range r.items {
		if e.sessionID != sessionID || e.pid != pid || e.decided {
			continue
		}
		if e.replyCh == nil && now.Sub(e.lastSeen) > ccPluginPermGrace {
			continue
		}
		if latest == nil || !e.ix.CreatedAt.Before(latest.ix.CreatedAt) {
			latest = e
		}
	}
	if latest == nil {
		return ""
	}
	if latest.ix.Kind == proto.IxPlan {
		return "等待确认计划"
	}
	if s := strings.TrimSpace(latest.ix.Summary); s != "" {
		return "等待确认：" + s
	}
	return "等待确认：" + latest.ix.ToolName
}

// liveClaudeAncestorOf finds the nearest live claude process at pid or among its ancestors (lineage): direct plugin
// requests arrive from claude itself, while `hooks/hooks.json` command hooks connect from a child hook process.
func (n *Node) liveClaudeAncestorOf(pid int) (claudeProc, bool) {
	claudes := n.liveClaudes()
	byPID := make(map[int]claudeProc, len(claudes))
	for _, c := range claudes {
		byPID[c.pid] = c
	}
	for _, anc := range lineage(pid, parentPID) {
		if c, ok := byPID[anc]; ok {
			return c, true
		}
	}
	return claudeProc{}, false
}

// permSettledOnComputer reports whether a permission prompt was already resolved (or ended) on the computer while a
// `PermissionRequest` command hook is still waiting (#3563): either the owning claude process exited / switched
// sessions, left `"waiting"` after entering it, returned to idle/shell, or appended a main-chain `tool_result` /
// `assistant` row to its transcript.
func (n *Node) permSettledOnComputer(sessionID string, claudePID int, cardID string) bool {
	cur, live := n.liveClaudeOf(claudePID)
	if !live || cur.SessionID != sessionID {
		return true
	}
	sawWaiting, tpath, toffset, open := n.ccPerms.observeStatus(cardID, claudePID, cur.Status)
	if !open {
		return false
	}
	if cur.Status == "waiting" {
		return false
	}
	if sawWaiting || cur.Status == "idle" || cur.Status == "shell" {
		return true
	}
	return transcriptMovedPastPerm(tpath, toffset)
}

func transcriptMovedPastPerm(path string, offset int64) bool {
	if path == "" || offset < 0 {
		return false
	}
	st, err := os.Stat(path)
	if err != nil || st.Size() <= offset {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return false
	}
	sc := bufio.NewScanner(io.LimitReader(f, 512<<10))
	sc.Buffer(make([]byte, 0, 16<<10), 512<<10)
	for sc.Scan() {
		line := sc.Bytes()
		var row struct {
			Type        string          `json:"type"`
			IsSidechain bool            `json:"isSidechain"`
			Message     json.RawMessage `json:"message"`
		}
		if json.Unmarshal(line, &row) != nil || row.IsSidechain {
			continue
		}
		if row.Type == "assistant" {
			return true
		}
		if row.Type == "user" && bytes.Contains(row.Message, []byte(`"tool_result"`)) {
			return true
		}
	}
	return false
}

func fileSizeOrZero(path string) int64 {
	if path == "" {
		return 0
	}
	if st, err := os.Stat(path); err == nil {
		return st.Size()
	}
	return 0
}

func (n *Node) ccPluginPermission(ctx context.Context, c net.Conn, body []byte) (int, any) {
	var in ccPluginPermInput
	if json.Unmarshal(body, &in) != nil || !validID(in.SessionID) || !validPermRequestID(in.RequestID) {
		return http.StatusBadRequest, map[string]any{"error": "invalid"}
	}
	peerPID, err := ccPluginPeerPID(c)
	if err != nil || peerPID <= 0 {
		return http.StatusForbidden, map[string]any{"error": "peer_unknown", "retry_ms": ccPluginOtherRetry.Milliseconds()}
	}
	claude, ok := n.liveClaudeAncestorOf(peerPID)
	if !ok || claude.SessionID != in.SessionID {
		return http.StatusForbidden, map[string]any{"error": "not_this_session", "retry_ms": ccPluginStrangerRetry.Milliseconds()}
	}
	if in.Cancel {
		if n.ccPerms.cancel(in.SessionID, claude.pid, in.RequestID) {
			n.notifySessions()
			go n.syncCodexCards(context.Background())
		}
		return http.StatusOK, map[string]any{"ok": true}
	}
	if !ccPluginServes(n, claude) || outsidePane(claude) != "" {
		return http.StatusOK, map[string]any{"status": "passthrough"}
	}
	toolName := strings.TrimSpace(in.ToolName)
	if toolName == "" || len(toolName) > 256 || toolName == askTool ||
		toolName == proto.SecretRunTool || toolName == proto.SecretHandoffTool {
		return http.StatusOK, map[string]any{"status": "passthrough"}
	}
	in.ToolName = toolName
	ix := n.buildOutsidePermCard(claude, in)
	tpath := cmp.Or(n.transcriptPath(in.SessionID), strings.TrimSpace(in.TranscriptPath))
	replyCh, doneCh, immediate, added := n.ccPerms.polled(
		in.SessionID,
		claude.pid,
		in.RequestID,
		ix,
		tpath,
		fileSizeOrZero(tpath),
		claude.Status == "waiting",
	)
	if added {
		n.notifySessions()
		go n.syncCodexCards(context.Background())
	}
	if immediate != nil {
		return http.StatusOK, immediate
	}
	if !added && n.permSettledOnComputer(in.SessionID, claude.pid, ix.ID) {
		if n.ccPerms.cancel(in.SessionID, claude.pid, in.RequestID) {
			n.notifySessions()
			go n.syncCodexCards(context.Background())
		}
		return http.StatusOK, map[string]any{"status": "passthrough"}
	}
	wait := time.Duration(in.WaitMS) * time.Millisecond
	if wait <= 0 || wait > ccPluginPollMost {
		wait = ccPluginPollMost
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	watch := time.NewTicker(ccPluginPermWatchStep)
	defer watch.Stop()
	for {
		select {
		case reply := <-replyCh:
			return http.StatusOK, reply
		case <-doneCh:
			goto done
		case <-t.C:
			goto done
		case <-ctx.Done():
			goto done
		case <-watch.C:
			if n.permSettledOnComputer(in.SessionID, claude.pid, ix.ID) {
				if n.ccPerms.cancel(in.SessionID, claude.pid, in.RequestID) {
					n.notifySessions()
					go n.syncCodexCards(context.Background())
				}
				return http.StatusOK, map[string]any{"status": "passthrough"}
			}
		}
	}
done:
	if reply := n.ccPerms.pollEnded(ix.ID, replyCh); reply != nil {
		return http.StatusOK, reply
	}
	return http.StatusOK, map[string]any{"status": "pending"}
}

func (n *Node) buildOutsidePermCard(c claudeProc, in ccPluginPermInput) proto.Interaction {
	now := time.Now().UTC()
	cwd := strings.TrimSpace(in.Cwd)
	if cwd == "" {
		cwd = c.Cwd
	}
	ix := proto.Interaction{
		ID:        outsidePermCardID(in.SessionID, in.RequestID),
		SessionID: in.SessionID,
		Agent:     "claude",
		AgentID:   clipReason(in.AgentID),
		ToolName:  in.ToolName,
		ToolInput: in.ToolInput,
		Cwd:       cwd,
		CreatedAt: now,
		ExpiresAt: now.Add(24 * time.Hour),
	}
	if in.ToolName == "ExitPlanMode" {
		var p struct {
			Plan string `json:"plan"`
		}
		_ = json.Unmarshal(in.ToolInput, &p)
		ix.Kind = proto.IxPlan
		ix.Plan = p.Plan
		ix.PlanThen = n.planThen(in.SessionID)
	} else {
		ix.Kind = proto.IxPermission
		ix.Summary = toolSummary(in.ToolName, in.ToolInput)
		ix.AlwaysLabel = "本会话都允许 " + in.ToolName
	}
	if p := n.transcriptPath(in.SessionID); p != "" {
		if st, err := os.Stat(p); err == nil {
			m := n.meta(p, st)
			ix.SessionTitle = m.title
			if ix.Cwd == "" {
				ix.Cwd = m.cwd
			}
		}
	}
	if ix.SessionTitle == "" && c.NameSource != "derived" {
		ix.SessionTitle = c.Name
	}
	if ix.SessionTitle == "" && ix.Cwd != "" {
		ix.SessionTitle = filepath.Base(ix.Cwd)
	}
	return ix
}

func (n *Node) outsidePermCards() []proto.Interaction {
	live := map[string]int{}
	for _, c := range n.liveClaudes() {
		if n.outsideSource(c) != "" && outsidePane(c) == "" {
			live[c.SessionID] = c.pid
		}
	}
	cards, expired := n.ccPerms.cards(live, time.Now())
	if expired {
		n.notifySessions()
	}
	return cards
}

func (n *Node) outsidePermAnswer(_ context.Context, session, id string, r proto.Resolution) error {
	if r.Cancel {
		return fmt.Errorf("question cancellation is unavailable for permission prompts")
	}
	c, live := n.outsideClaude(session)
	if r.Dismiss {
		n.cx.dismiss(session, id)
		if live {
			if n.ccPerms.decide(session, c.pid, id, map[string]any{"status": "passthrough"}) {
				n.notifySessions()
			}
		}
		return nil
	}
	if !live {
		return refusal(screen.PromptChanged, outsidePermGone, nil)
	}
	ix, ok := n.ccPerms.lookup(session, c.pid, id)
	if !ok {
		return refusal(screen.PromptChanged, outsidePermGone, nil)
	}
	var decision map[string]any
	switch ix.Kind {
	case proto.IxPlan:
		if r.Approve == nil {
			return fmt.Errorf("missing plan decision")
		}
		if !*r.Approve {
			msg := "用户在手机上打回了这个计划。"
			if strings.TrimSpace(r.Feedback) != "" {
				msg += "修改意见：" + r.Feedback
			}
			decision = map[string]any{"behavior": "deny", "message": msg}
		} else {
			mode := cmp.Or(proto.PlanAfterMode(ix.PlanThen), r.Mode, proto.ModeBypass)
			var input map[string]any
			_ = json.Unmarshal(ix.ToolInput, &input)
			decision = map[string]any{
				"behavior":     "allow",
				"updatedInput": input,
				"updatedPermissions": []any{map[string]any{
					"type": "setMode", "mode": mode, "destination": "session",
				}},
			}
		}
	default:
		if r.Allow == nil {
			return fmt.Errorf("missing permission decision")
		}
		if !*r.Allow {
			msg := strings.TrimSpace(r.Message)
			if msg == "" {
				msg = "用户在手机上拒绝了这次调用。"
			}
			decision = map[string]any{"behavior": "deny", "message": msg}
		} else {
			var input map[string]any
			_ = json.Unmarshal(ix.ToolInput, &input)
			decision = map[string]any{"behavior": "allow"}
			if input != nil {
				decision["updatedInput"] = input
			}
			if r.Always {
				decision["updatedPermissions"] = []any{map[string]any{
					"type":        "addRules",
					"rules":       []any{map[string]any{"toolName": ix.ToolName}},
					"behavior":    "allow",
					"destination": "session",
				}}
			}
		}
	}
	if !n.ccPerms.decide(session, c.pid, id, map[string]any{"status": "decided", "decision": decision}) {
		return refusal(screen.PromptChanged, outsidePermGone, nil)
	}
	n.cx.hold(session, id)
	n.notifySessions()
	go n.syncCodexCards(context.Background())
	return nil
}

const outsidePermGone = "Claude 已经不在等这次确认了（可能在电脑上处理过了，或者这一轮已结束），这次没有重复提交。"
