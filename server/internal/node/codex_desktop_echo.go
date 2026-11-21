package node

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/transcript"
)

// Desktop is opaque session.echo data, not an Item or hub protocol change. A held input cannot match anything.
// DispatchAt starts its matching window only when the owner has been found and the batch is about to be written.
// Every member carries the full batch's digest and IDs so a reconnect never falls back to matching its own prefix.
type codexDesktopEcho struct {
	DispatchAt time.Time `json:"dispatch_at,omitempty"`
	Group      []string  `json:"group"`
	TextHash   string    `json:"text_sha256,omitempty"`
	Images     int       `json:"images,omitempty"`
}

type codexDesktopDispatchKey struct{}

func (r *echoRecord) matchAt() time.Time {
	if r.Desktop != nil {
		return r.Desktop.DispatchAt
	}
	return r.SentAt
}

func desktopEchoHash(text string) string {
	h := sha256.Sum256([]byte(strings.Join(strings.Fields(text), "")))
	return hex.EncodeToString(h[:])
}

// Use exactly the reader's native-input projection: it removes ambient/context envelopes and renders local images
// as attached_images text. Hashing the raw composer text or just counting image items would miss those real echoes.
// This is pure parsing of our own input, with no file reads, invented transcript items, or changes to the bus payload.
func desktopEchoInputProof(msgs []codexDesktopMessage) (string, int) {
	raw, _ := json.Marshal(map[string]any{"id": "desktop-input", "content": codexDesktopInput(msgs)})
	line, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]any{
		"type": "item_completed", "item": codexRolloutItem("userMessage", raw),
	}})
	items := transcript.ParseLineForEcho(1, line)
	var text strings.Builder
	images := 0
	for _, it := range items {
		if it.Role != "user" || it.ToolUseID != "" {
			continue
		}
		if it.Kind == proto.KindText {
			text.WriteString(it.Text)
		} else if it.Kind == proto.KindImage {
			images++
		}
	}
	return desktopEchoHash(text.String()), images
}

func (d *codexDesktopEcho) fits(items []proto.Item) bool {
	if d.DispatchAt.IsZero() || d.TextHash == "" {
		return false
	}
	var text strings.Builder
	images := 0
	for _, it := range items {
		if it.Role != "user" || it.ToolUseID != "" {
			continue
		}
		switch it.Kind {
		case proto.KindText:
			if it.FullSize > 0 {
				return false
			} // never use a clipped prefix as evidence for a whole batch
			text.WriteString(it.Text)
		case proto.KindImage:
			images++
		}
	}
	return images == d.Images && desktopEchoHash(text.String()) == d.TextHash
}

// Only the pending desktop batches need full-text evidence. Hydrate their candidate user text transiently, without
// enlarging the items published to clients or rereading unrelated tool output on every watch tick.
func (l *echoLog) desktopFullItems(id string, f *transcript.File, items []proto.Item) ([]proto.Item, bool) {
	l.mu.Lock()
	needed := false
	for _, r := range l.recs[id] {
		if r.Desktop != nil && r.Line == "" && time.Since(r.matchAt()) <= echoWithin {
			needed = true
			break
		}
	}
	l.mu.Unlock()
	if !needed {
		return items, true
	}
	for i, it := range items {
		if it.Role == "user" && it.Kind == proto.KindText && it.FullSize > 0 && it.ToolUseID == "" {
			full, err := f.FullForEcho(it.ID)
			if err != nil || full.FullSize > 0 {
				return items, false
			}
			items[i] = full
		}
	}
	return items, true
}

func (l *echoLog) holdDesktop(id codexDesktopSendID) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, r := range l.recs[id.session] {
		if r.ClientMsgID == id.message {
			r.Desktop = &codexDesktopEcho{Group: []string{id.message}}
			r.Line = ""
		}
	}
}

// prepareHeldCodexEcho runs immediately before the bus start request, not when the message is enqueued. It keeps
// acceptance time for diagnostics, replaces the match boundary with a fresh one, and publishes the dispatched group.
func (n *Node) prepareHeldCodexEcho(msgs []codexDesktopMessage) {
	groups := map[string][]codexDesktopMessage{}
	for _, m := range msgs {
		if m.sendID.session != "" && m.sendID.message != "" {
			groups[m.sendID.session] = append(groups[m.sendID.session], m)
		}
	}
	digest, images := desktopEchoInputProof(msgs)
	for id, group := range groups {
		boundary := n.echoBase(id)
		d := &codexDesktopEcho{DispatchAt: time.Now().UTC(), TextHash: digest, Images: images}
		for _, m := range group {
			d.Group = append(d.Group, m.sendID.message)
		}
		for _, r := range n.echoes.dispatchDesktop(id, group, d, boundary) {
			n.notifyEcho(r)
		}
	}
}

func (l *echoLog) dispatchDesktop(id string, msgs []codexDesktopMessage, d *codexDesktopEcho, boundary echoAfter) []echoRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.recs == nil {
		l.recs = map[string][]*echoRecord{}
	}
	var out []echoRecord
	for _, m := range msgs {
		var r *echoRecord
		for _, old := range l.recs[id] {
			if old.ClientMsgID == m.sendID.message {
				r = old
				break
			}
		}
		if r == nil {
			r = &echoRecord{SessionID: id, ClientMsgID: m.sendID.message, Text: m.text, Images: len(m.paths), SentAt: m.acceptedAt}
			r.clip()
			l.recs[id] = append(l.recs[id], r)
		}
		r.Desktop = d
		r.AfterSeq, r.In, r.Before = boundary.seq, boundary.in, slices.Clone(boundary.before)
		r.Line, r.scanned = "", 0
		out = append(out, *r)
	}
	if len(l.recs[id]) > echoPerSession {
		l.recs[id] = l.recs[id][len(l.recs[id])-echoPerSession:]
	}
	return out
}

// tieDesktopGroup runs under the echoLog lock. Missing members (the bounded log evicted one) can be reported from
// the same exact batch proof without making up another transcript item. The hub persists a record for every member.
func tieDesktopGroup(recs []*echoRecord, matched *echoRecord, line, in string) []echoRecord {
	var found []echoRecord
	for _, mid := range matched.Desktop.Group {
		member := *matched
		member.ClientMsgID, member.Line, member.In = mid, line, in
		for _, r := range recs {
			if r.ClientMsgID == mid && r.Desktop != nil && r.Desktop.DispatchAt.Equal(matched.Desktop.DispatchAt) &&
				r.Desktop.TextHash == matched.Desktop.TextHash && slices.Equal(r.Desktop.Group, matched.Desktop.Group) {
				r.Line, r.In = line, in
				member = *r
				break
			}
		}
		found = append(found, member)
	}
	return found
}

// Merge a newer dispatch record, but never let an old pending record or a repeated notification undo a match.
func mergeDesktopEcho(old *echoRecord, incoming echoRecord) bool {
	if incoming.Desktop == nil {
		return false
	}
	if old.Desktop == nil || incoming.Desktop.DispatchAt.After(old.Desktop.DispatchAt) {
		*old = incoming
		return true
	}
	if incoming.Desktop.DispatchAt.Before(old.Desktop.DispatchAt) {
		return true
	}
	return false
}

func (q *codexDesktopThreads) rememberEcho(r echoRecord) {
	if r.Desktop == nil || r.Desktop.DispatchAt.IsZero() {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	id := codexDesktopSendID{r.SessionID, r.ClientMsgID}
	state, ok := q.states[id]
	if !ok {
		return
	}
	if state.echo != nil && (state.echo.Line != "" || state.echo.Desktop.DispatchAt.After(r.Desktop.DispatchAt)) {
		return
	}
	state.echo = &r
	q.states[id] = state
}

func (l *echoLog) desktopRecords(id string) []echoRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []echoRecord
	for _, r := range l.recs[id] {
		if r.Desktop != nil && !r.Desktop.DispatchAt.IsZero() {
			out = append(out, *r)
		}
	}
	return out
}

// Same-process connections take the worker's latest records, and new processes take the hub's opaque echoes.
// Neither path rebuilds or dispatches a queue. Only an actual matching user item supplies EchoLine; the client
// must see that stable line in its own transcript before it removes any member's placeholder.
func (n *Node) codexDesktopQueueSnapshot(id string) codexDesktopQueueSnapshot {
	for _, state := range codexDesktopQueue.snapshot(id).Messages {
		if state.echo != nil {
			n.echoes.expect(*state.echo)
		}
	}
	if len(n.echoes.desktopRecords(id)) > 0 {
		if f, err := n.file(id); err == nil {
			n.echoed(id, f, nil)
		}
	}
	out := codexDesktopQueue.snapshot(id)
	byID := map[string]int{}
	for i, r := range out.Messages {
		byID[r.ClientMsgID] = i
	}
	for _, r := range n.echoes.desktopRecords(id) {
		for _, mid := range r.Desktop.Group {
			i, ok := byID[mid]
			if !ok {
				i = len(out.Messages)
				byID[mid] = i
				out.Messages = append(out.Messages, codexDesktopSendState{ClientMsgID: mid, State: "unknown", At: r.Desktop.DispatchAt, Code: "codex_queue_delivery_unknown", Delivered: deliveredUnknown})
			}
			if out.Messages[i].Delivered != deliveredNone && r.foundIn(echoInTranscript) {
				out.Messages[i].EchoLine = r.Line
			}
		}
	}
	sort.Slice(out.Messages, func(i, j int) bool { return out.Messages[i].At.Before(out.Messages[j].At) })
	return out
}
