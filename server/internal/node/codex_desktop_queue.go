package node

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/rpc"
)

// A message for a Codex App chat that is running a turn waits on the node and is delivered once, when the turn ends.
//
// The App's bus has only one way in for a follower: thread-follower-start-turn. The owning window passes it on as a
// turn/start, which Codex steers into the running turn (start_or_steer_turn), and the App then runs the same message
// again as a new turn when the running one ends: the agent got it twice (a reply mid-turn, then the whole question
// again). So nothing is started in a running turn here. The message waits until the turn ends and then goes in as a turn
// of its own, all that waited for the thread together, in the order sent. The send answers `queued`, as a runtime's
// steer behind a running turn does (#8097).
//
// A turn the node started counts as running from the request until the App writes it down (codexDesktopStartGrace),
// so a second message right after the first waits too, rather than being steered into the turn the first started.
// What waits lives in this process: a node that stops before the turn ends drops it. session.info exposes the
// receipts still known in this process; an absent receipt is unknown, never evidence that a message still waits.

var (
	// codexDesktopHoldPoll: how often a waiting message looks whether its thread's turn ended.
	codexDesktopHoldPoll = time.Second
	// codexDesktopHoldMax: how long a message waits for a turn to end before it fails without delivery.
	codexDesktopHoldMax = 12 * time.Hour
	// codexDesktopStartGrace: how long a turn the node started counts as running while the App has written nothing of it.
	codexDesktopStartGrace = 20 * time.Second
)

type codexDesktopMessage struct {
	text       string
	paths      []string // the pictures, saved on this computer
	sendID     codexDesktopSendID
	acceptedAt time.Time
}

type codexDesktopSendID struct{ session, message string }
type codexDesktopSendKey struct{}

// These receipts describe input delivery, not model execution. No message content or raw transport errors are
// exposed. They survive link reconnections in this process, but are deliberately not restored as a pending queue.
type codexDesktopSendState struct {
	ClientMsgID string    `json:"client_msg_id"`
	State       string    `json:"state"`
	At          time.Time `json:"at"`
	Code        string    `json:"code,omitempty"`
	Delivered   string    `json:"delivered,omitempty"`
	EchoLine    string    `json:"echo_line,omitempty"`
	echo        *echoRecord
}

type codexDesktopQueueSnapshot struct {
	Version  int                     `json:"version"`
	Messages []codexDesktopSendState `json:"messages"`
}

func (q *codexDesktopThreads) note(id codexDesktopSendID, state, code, delivered string) {
	if id.session == "" || id.message == "" {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.states == nil {
		q.states = make(map[codexDesktopSendID]codexDesktopSendState)
	}
	if previous, known := q.states[id]; known && (previous.State != "queued" || state == "queued") {
		return // a replay cannot rewrite a terminal receipt, nor renew the original queue acceptance time
	}
	q.states[id] = codexDesktopSendState{ClientMsgID: id.message, State: state, At: time.Now().UTC(), Code: code, Delivered: delivered, echo: q.states[id].echo}
	q.pruneStates(id.session)
}

// pruneStates bounds terminal receipts per session without ever expiring a message that is actually held.
// The caller holds q.mu. Older missing receipts must be checked against the transcript, not resent automatically.
func (q *codexDesktopThreads) pruneStates(session string) {
	var terminal []codexDesktopSendID
	for id, r := range q.states {
		if r.State == "queued" {
			continue
		}
		if time.Since(r.At) > 24*time.Hour {
			delete(q.states, id)
			continue
		}
		if id.session == session {
			terminal = append(terminal, id)
		}
	}
	sort.Slice(terminal, func(i, j int) bool { return q.states[terminal[i]].At.Before(q.states[terminal[j]].At) })
	for len(terminal) > 200 {
		delete(q.states, terminal[0])
		terminal = terminal[1:]
	}
}

func (q *codexDesktopThreads) snapshot(session string) codexDesktopQueueSnapshot {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.pruneStates(session)
	out := codexDesktopQueueSnapshot{Version: 1, Messages: []codexDesktopSendState{}}
	for id, r := range q.states {
		if id.session == session {
			out.Messages = append(out.Messages, r)
		}
	}
	sort.Slice(out.Messages, func(i, j int) bool { return out.Messages[i].At.Before(out.Messages[j].At) })
	return out
}

// reply preserves queued on replay (sentLog only remembers errors), also after its ten-minute dedupe expires.
// A terminal queue receipt is never a new attempt. In particular, an unknown outcome must not be sent again.
func (q *codexDesktopThreads) reply(id codexDesktopSendID) (map[string]any, error, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	r, ok := q.states[id]
	if ok && r.State != "queued" && time.Since(r.At) > 24*time.Hour {
		delete(q.states, id)
		ok = false
	}
	if !ok {
		return nil, nil, false
	}
	switch r.State {
	case "failed", "cancelled":
		return nil, refusal(r.Code, "The queued message was not delivered", map[string]any{"queue_state": r}), true
	case "unknown":
		return nil, &rpc.Error{Code: "codex_queue_delivery_unknown", Message: "The queued message may have been delivered; check its transcript before sending again", Data: []byte(`{"delivered":"unknown"}`)}, true
	}
	return map[string]any{"ok": true, "queued": r.State == "queued", "queue_state": r}, nil, true
}

// codexDesktopThread is the node's side of one App thread: what waits for its turn to end, and the last turn it started.
type codexDesktopThread struct {
	send      sync.Mutex // one decision and start at a time for the thread
	src       codexSource
	held      []codexDesktopMessage
	waiting   bool      // a goroutine delivers held once the turn ends
	startedAt time.Time // the last turn the node started here
	startMark string    // the thread's turn state when it did
}

type codexDesktopThreads struct {
	mu     sync.Mutex
	m      map[string]*codexDesktopThread
	states map[codexDesktopSendID]codexDesktopSendState
}

var codexDesktopQueue codexDesktopThreads

func (q *codexDesktopThreads) thread(src codexSource) *codexDesktopThread {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.m == nil {
		q.m = map[string]*codexDesktopThread{}
	}
	key := src.home + "\x00" + src.thread
	t := q.m[key]
	if t == nil {
		t = &codexDesktopThread{src: src}
		q.m[key] = t
	}
	return t
}

type sendQueuedKey struct{}

// withSendQueued lets a send say the message only waits behind the running turn (the session.send answer's `queued`).
func withSendQueued(ctx context.Context) (context.Context, *bool) {
	q := new(bool)
	return context.WithValue(ctx, sendQueuedKey{}, q), q
}

func markSendQueued(ctx context.Context) {
	if q, ok := ctx.Value(sendQueuedKey{}).(*bool); ok {
		*q = true
	}
}

// sendOrHoldCodexDesktop starts a turn with m in src's thread, or holds m until the turn running there ends.
func (n *Node) sendOrHoldCodexDesktop(ctx context.Context, src codexSource, m codexDesktopMessage) error {
	m.sendID, _ = ctx.Value(codexDesktopSendKey{}).(codexDesktopSendID)
	t := codexDesktopQueue.thread(src)
	t.send.Lock()
	defer t.send.Unlock()
	t.src = src // the same lock the delivery loop holds, including after a rollout path changes
	if _, err, known := codexDesktopQueue.reply(m.sendID); known {
		return err // concurrent retries may both have passed the outer receipt check
	}
	if err := ctx.Err(); err != nil {
		state, code := "cancelled", "codex_queue_cancelled"
		if errors.Is(err, context.DeadlineExceeded) {
			state, code = "failed", "codex_queue_timeout"
		}
		codexDesktopQueue.note(m.sendID, state, code, deliveredNone)
		return refusal(code, "The send ended before queue acceptance", nil)
	}
	working, mark := n.codexDesktopTurnState(src)
	if len(t.held) > 0 || working || t.recentlyStarted(mark) {
		m.acceptedAt = time.Now().UTC()
		n.echoes.holdDesktop(m.sendID)
		t.held = append(t.held, m)
		codexDesktopQueue.note(m.sendID, "queued", "", "")
		if !t.waiting {
			t.waiting = true
			go n.deliverHeldCodexDesktop(t)
		}
		markSendQueued(ctx)
		return nil
	}
	return t.start(ctx, n, []codexDesktopMessage{m}, mark)
}

// recentlyStarted: the node started a turn here a moment ago and the App has written nothing since.
func (t *codexDesktopThread) recentlyStarted(mark string) bool {
	return !t.startedAt.IsZero() && time.Since(t.startedAt) < codexDesktopStartGrace && mark == t.startMark
}

// start runs one turn with msgs; t.send is held.
func (t *codexDesktopThread) start(ctx context.Context, n *Node, msgs []codexDesktopMessage, mark string) error {
	err := n.startCodexDesktopTurn(ctx, t.src, codexDesktopInput(msgs))
	var re *rpc.Error
	if err == nil || !errors.As(err, &re) || deliveredOf(re) != deliveredNone { // it may have started
		t.startedAt, t.startMark = time.Now(), mark
	}
	return err
}

func codexDesktopInput(msgs []codexDesktopMessage) []map[string]any {
	var texts []string
	var paths []string
	for _, m := range msgs {
		if m.text != "" {
			texts = append(texts, m.text)
		}
		paths = append(paths, m.paths...)
	}
	input := []map[string]any{}
	if len(texts) > 0 {
		input = append(input, map[string]any{"type": "text", "text": strings.Join(texts, "\n\n"), "text_elements": []any{}})
	}
	for _, p := range paths {
		input = append(input, map[string]any{"type": "localImage", "path": p})
	}
	return input
}

// deliverHeldCodexDesktop waits for t's turn to end, then starts one turn with everything held: once, never steered.
func (n *Node) deliverHeldCodexDesktop(t *codexDesktopThread) {
	deadline := time.Now().Add(codexDesktopHoldMax)
	tick := time.NewTicker(codexDesktopHoldPoll)
	defer tick.Stop()
	for range tick.C {
		t.send.Lock()
		working, mark := n.codexDesktopTurnState(t.src)
		if working || t.recentlyStarted(mark) {
			if time.Now().Before(deadline) {
				t.send.Unlock()
				continue
			}
			log.Printf("codex app %s: %d held message(s) dropped: its turn ran past %v", t.src.thread, len(t.held), codexDesktopHoldMax)
			for _, m := range t.held {
				codexDesktopQueue.note(m.sendID, "failed", "codex_queue_timeout", deliveredNone)
				n.forgetHeldCodexEcho(m.sendID)
			}
			t.held, t.waiting = nil, false
			t.send.Unlock()
			return
		}
		msgs := t.held
		t.held, t.waiting = nil, false
		if len(msgs) > 0 {
			ctx := context.WithValue(context.Background(), codexDesktopDispatchKey{}, func() { n.prepareHeldCodexEcho(msgs) })
			err := t.start(ctx, n, msgs, mark)
			if err != nil {
				log.Printf("codex app %s: %d held message(s) not delivered after its turn: %v", t.src.thread, len(msgs), err)
			}
			n.finishHeldCodexDesktop(msgs, err)
		}
		t.send.Unlock()
		return
	}
}

func (n *Node) finishHeldCodexDesktop(msgs []codexDesktopMessage, err error) {
	state, code, delivered := "delivered", "", ""
	if err != nil {
		state, code, delivered = "unknown", "codex_queue_delivery_unknown", deliveredUnknown
		var re *rpc.Error
		if errors.As(err, &re) && deliveredOf(re) == deliveredNone {
			state, code, delivered = "failed", re.Code, deliveredNone
			if errors.Is(err, context.Canceled) || re.Code == "codex_queue_cancelled" {
				state, code = "cancelled", "codex_queue_cancelled"
			}
		}
	}
	for _, m := range msgs {
		codexDesktopQueue.note(m.sendID, state, code, delivered)
		if delivered == deliveredNone {
			n.forgetHeldCodexEcho(m.sendID)
		}
	}
}

func (n *Node) forgetHeldCodexEcho(id codexDesktopSendID) {
	if _, known := n.echoes.record(id.session, id.message); known {
		n.echoes.forget(id.session, id.message)
	}
}

// codexDesktopTurnState: whether the App runs a turn in src's thread now, and a mark that changes whenever the App
// writes to its turns (the rollout's size, or the history database's last turn). Not working when neither can be read.
func (n *Node) codexDesktopTurnState(src codexSource) (bool, string) {
	if s := withoutGoneRollout(src, nil); s.path != "" {
		status := n.codexDesktopTurn(s.path)
		size := int64(-1)
		if v, ok := codexTurnMarks.Load(s.path); ok {
			size = v.(codexTurnMark).size
		}
		return status == proto.StatusWorking, fmt.Sprintf("rollout:%d", size)
	}
	id, status, ok := codexHistoryLastTurn(src)
	if !ok {
		return false, ""
	}
	return status == "inProgress", "history:" + id + ":" + status
}

// codexHistoryLastTurn reads the last turn of src's thread in the App's history database (chats whose rollout the App
// deleted, codex_apphistory.go): its id and status ("inProgress" while it runs).
var codexHistoryLastTurn = func(src codexSource) (id, status string, ok bool) {
	db := codexHistoryDBPath(src.home)
	sqlite, err := exec.LookPath("sqlite3")
	if db == "" || err != nil || !validID(src.thread) {
		return "", "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	q := fmt.Sprintf("SELECT turn_id, status FROM thread_turns WHERE thread_id = '%s' ORDER BY rollout_ordinal DESC LIMIT 1", src.thread)
	out, err := exec.CommandContext(ctx, sqlite, "-readonly", "-bail", "-noheader", "-list", "-separator", "\x1f", "-cmd", ".timeout 2000", codexDBTarget(db), q).Output()
	if err != nil {
		return "", "", false
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "\x1f", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], parts[1], true
}
