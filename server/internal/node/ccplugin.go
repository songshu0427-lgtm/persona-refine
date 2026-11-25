package node

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

// Persona's Claude Code plugin (integrations/claude-code-plugin; docs/integrations/claude-integration.md "Owner input
// through the Persona plugin"). A claude outside Persona's terminals — Claude's desktop app, a terminal no engine runs,
// a background session — has no pane to type into, and its peer inbox tells the model that what comes through it is
// another session's, never the person's approval. The plugin, loaded in such a claude, asks this node for messages
// and session-scoped model / effort overrides over the node socket while the session lives: messages go in with
// $.prompt.submit({asUser: true}), and model / effort overrides rewrite main-loop turn.step calls without touching
// global settings files.
//
// Only the owner's own messages go that way (session.send's owner_input, which the devices manager sets for a message
// typed in the owner's app, devices.go ownerInputParams), and only to a session at rest: one that works or waits on a
// dialog gets it through the inbox as before (it queues there, or answers its question), and so does everyone else's
// message. When the plugin does not take the message in time or says it did not submit it, it goes through the inbox
// too, and session.send says which way it went (delivered_as, relay_reason).
//
// The wire is HTTP/1.1 on the node socket (serveCCPluginHTTP), since a plugin's only local transport is $.http.fetch over
// a Unix socket: POST /claude-plugin/v1/poll and /ack, JSON both ways (the plugin's README.md). The node answers only
// the claude process that has the session open: the socket's other end, as the system names it (ccPluginPeerPID), must
// be the pid of that session's sessions/<pid>.json. No other process of the user, and no other session, can take a
// session's messages; and nothing that comes in on the socket ever becomes a message, which only session.send makes.

// ccPluginProtocol is the plugin protocol this node speaks (claude-plugin.status).
const ccPluginProtocol = 1

// ccPluginPrefix leads the plugin's endpoints.
const ccPluginPrefix = "/claude-plugin/v1/"

const (
	// ccPluginPollMost bounds how long a poll is held: under the 30 s after which Claude Code's fetch gives up.
	ccPluginPollMost = 25 * time.Second
	// ccPluginOtherRetry is how long a claude whose session the node does not deliver to this way (one in an engine's
	// pane, the assistant's own, an SDK's) waits before it asks again.
	ccPluginOtherRetry = 5 * time.Minute
	// ccPluginStrangerRetry is how long a caller the node does not take for the session it names waits: a claude that
	// has not written its sessions/<pid>.json yet asks again soon.
	ccPluginStrangerRetry = 15 * time.Second
	// ccPluginBodyMost bounds a request's body, and ccPluginRequestMost the whole request with its headers.
	ccPluginBodyMost    = 64 << 10
	ccPluginRequestMost = 256 << 10
	// ccPluginStale is how long after its last poll a plugin still counts: an idle one polls again at once, a busy
	// session's plugin keeps polling too (the node, not the plugin, tells whether the session rests).
	ccPluginStale = 90 * time.Second
	// ccPluginQueuedTTL bounds how long pre-queued session settings wait for a newly opened desktop session to poll.
	ccPluginQueuedTTL = 2 * time.Minute
)

var (
	// ccPluginPickupWait is how long a message waits for the session's plugin to take it: an idle plugin's next poll
	// comes within moments of the last one ending.
	ccPluginPickupWait = 3 * time.Second
	// ccPluginSubmitWait is the deadline the plugin gets: it submits nothing later than this after it was handed over.
	ccPluginSubmitWait = 5 * time.Second
	// ccPluginConfirmWait is how long the node looks for the prompt in the transcript, past ccPluginSubmitWait: only a
	// message the plugin can no longer submit goes through the inbox instead.
	ccPluginConfirmWait = 10 * time.Second
)

// What session.send says about how a message for the owner went in (delivered_as), and why it went through the inbox
// (relay_reason). Only messages that carried owner_input to a claude outside Persona's terminals have them.
const (
	deliveredUserInput = "user_input" // the plugin submitted it as the person's words
	deliveredRelayed   = "relayed"    // through the session's peer inbox, as another session's message

	relayNoPlugin    = "no_plugin"          // no plugin polls from this session's claude
	relayBusy        = "busy"               // the session works or waits on a dialog: the inbox queues the message there
	relayUnavailable = "plugin_unavailable" // the plugin did not take it in time
	relayRefused     = "plugin_refused"     // the plugin took it and did not submit it
	relayStopped     = "plugin_stopped"     // internal: Claude Code's host Stop latch dropped the plugin prompt
	relayUnconfirmed = "plugin_unconfirmed" // taken, and nothing showed it went in before its deadline
)

// ccPluginMessage is one message handed to a plugin, as the poll answers it.
type ccPluginMessage struct {
	ID         string `json:"id"`
	Text       string `json:"text"`
	DeadlineMS int64  `json:"deadline_ms"`
}

// ccPluginSettings is a session-only model / effort override handed to a plugin on /poll.
type ccPluginSettings struct {
	ID     string `json:"id"`
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
}

// ccPluginInterrupt asks the plugin to abort the running main-loop turn via $.turn.abort.
type ccPluginInterrupt struct {
	ID         string `json:"id"`
	DeadlineMS int64  `json:"deadline_ms"`
}

type ccPluginQueuedSettings struct {
	settings ccPluginSettings
	at       time.Time
}

// ccPluginDelivery is what a woken poll returns to the plugin.
type ccPluginDelivery struct {
	Messages  []ccPluginMessage  `json:"messages"`
	Settings  *ccPluginSettings  `json:"settings,omitempty"`
	Interrupt *ccPluginInterrupt `json:"interrupt,omitempty"`
}

// ccPluginAck is what the plugin said became of a message, settings update or interrupt.
type ccPluginAck struct {
	Submitted bool
	Reason    string
	Detail    string
}

type ccPluginCaps struct {
	settings         bool
	busyInput        bool
	interrupt        bool
	permissionBridge bool
}

// ccPluginSession is a session whose plugin polls this node.
type ccPluginSession struct {
	pid             int
	version, engine string
	caps            ccPluginCaps
	seen            time.Time
	// abortedRev is the transcript byte size when an owner interrupt (or `no_turn` ack) settled the turn while
	// `sessions/<pid>.json` remained `"busy"` / `"waiting"`; -1 when not overridden.
	abortedRev int64
	// poll is the waiting poll's hand-off, nil while none waits; done ends it early (a newer poll).
	poll chan ccPluginDelivery
	done chan struct{}
	acks map[string]chan ccPluginAck // items handed over and not settled, by id
}

// ccPluginRegistry is every session whose plugin polled this node since it started; its zero value is ready.
type ccPluginRegistry struct {
	mu       sync.Mutex
	sessions map[string]*ccPluginSession
	queued   map[string]ccPluginQueuedSettings
}

// polled records a poll from session id's claude pid and makes it the session's waiting poll; the poll it replaces
// (the same session's, still waiting) is ended. When settings were pre-queued for id and the plugin supports settings,
// polled returns them immediately without leaving a waiting channel.
func (r *ccPluginRegistry) polled(id string, pid int, version, engine string, caps ccPluginCaps) (poll chan ccPluginDelivery, done chan struct{}, immediate *ccPluginSettings, capabilitiesChanged bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sessions == nil {
		r.sessions = map[string]*ccPluginSession{}
	}
	now := time.Now()
	for other, o := range r.sessions {
		if o.poll == nil && len(o.acks) == 0 && now.Sub(o.seen) > ccPluginStale {
			delete(r.sessions, other) // its claude exited or moved on; a live one polls again and is back
		}
	}
	for qid, q := range r.queued {
		if now.Sub(q.at) > ccPluginQueuedTTL {
			delete(r.queued, qid)
		}
	}
	s := r.sessions[id]
	isNew := false
	if s == nil || s.pid != pid {
		s = &ccPluginSession{pid: pid, abortedRev: -1, acks: map[string]chan ccPluginAck{}}
		r.sessions[id] = s
		isNew = true
	}
	if s.done != nil {
		close(s.done)
		s.poll, s.done = nil, nil
	}
	if isNew || s.caps != caps {
		capabilitiesChanged = true
	}
	s.version, s.engine, s.caps, s.seen = version, engine, caps, now
	if caps.settings {
		if q, ok := r.queued[id]; ok {
			delete(r.queued, id)
			cp := q.settings
			return nil, nil, &cp, capabilitiesChanged
		}
	}
	s.poll, s.done = make(chan ccPluginDelivery, 1), make(chan struct{})
	return s.poll, s.done, nil, capabilitiesChanged
}

// pollEnded takes poll off session id when it is still the waiting one; ok false when a delivery was handed to it (or
// a newer poll replaced it), which the caller then reads from it.
func (r *ccPluginRegistry) pollEnded(id string, poll chan ccPluginDelivery) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	if s == nil || s.poll != poll {
		return false
	}
	s.poll, s.done = nil, nil
	s.seen = time.Now()
	return true
}

// session is session id's plugin while it polls from claude pid (a poll waits, or the last one ended a moment ago);
// nil for none.
func (r *ccPluginRegistry) session(id string, pid int) *ccPluginSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s := r.sessions[id]; s != nil && s.pid == pid && (s.poll != nil || time.Since(s.seen) < ccPluginStale) {
		return s
	}
	return nil
}

// settingsCapable reports whether session id's polling plugin supports session-scoped model/effort updates.
func (r *ccPluginRegistry) settingsCapable(id string, pid int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	return s != nil && s.pid == pid && s.caps.settings && (s.poll != nil || time.Since(s.seen) < ccPluginStale)
}

// busyInputCapable reports whether session id's polling plugin supports queueing owner messages while a turn runs.
func (r *ccPluginRegistry) busyInputCapable(id string, pid int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	return s != nil && s.pid == pid && s.caps.busyInput && (s.poll != nil || time.Since(s.seen) < ccPluginStale)
}

// interruptCapable reports whether session id's polling plugin supports aborting the running turn via $.turn.abort.
func (r *ccPluginRegistry) interruptCapable(id string, pid int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	return s != nil && s.pid == pid && s.caps.interrupt && (s.poll != nil || time.Since(s.seen) < ccPluginStale)
}

// permissionBridgeCapable reports whether session id's polling plugin bridges PermissionRequest dialogs via hooks.json.
func (r *ccPluginRegistry) permissionBridgeCapable(id string, pid int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	return s != nil && s.pid == pid && s.caps.permissionBridge && (s.poll != nil || time.Since(s.seen) < ccPluginStale)
}

// markAborted records the transcript byte size at which session id's turn was aborted so a stale `"busy"` / `"waiting"`
// status in `sessions/<pid>.json` reads as `"idle"` until a new user prompt starts another turn.
func (r *ccPluginRegistry) markAborted(id string, pid int, rev int64) {
	if rev < 0 {
		rev = 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sessions == nil {
		r.sessions = map[string]*ccPluginSession{}
	}
	s := r.sessions[id]
	if s == nil || s.pid != pid {
		s = &ccPluginSession{pid: pid, abortedRev: rev, seen: time.Now(), acks: map[string]chan ccPluginAck{}}
		r.sessions[id] = s
		return
	}
	s.abortedRev = rev
}

func (r *ccPluginRegistry) clearAborted(id string, pid int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s := r.sessions[id]; s != nil && s.pid == pid {
		s.abortedRev = -1
	}
}

func (r *ccPluginRegistry) abortedRev(id string, pid int) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s := r.sessions[id]; s != nil && s.pid == pid {
		return s.abortedRev
	}
	return -1
}

// queueSettings stores desired model/effort settings for session id so the next settings-capable poll receives them
// immediately (or wakes a currently waiting poll right away).
func (r *ccPluginRegistry) queueSettings(id, model, effort string) {
	if id == "" || (model == "" && effort == "") {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.queued == nil {
		r.queued = map[string]ccPluginQueuedSettings{}
	}
	prev := r.queued[id].settings
	if model == "" {
		model = prev.Model
	}
	if effort == "" {
		effort = prev.Effort
	}
	upd := ccPluginSettings{
		ID:     strings.ReplaceAll(newUUID(), "-", ""),
		Model:  model,
		Effort: effort,
	}
	if s := r.sessions[id]; s != nil && s.caps.settings && s.poll != nil {
		s.poll <- ccPluginDelivery{Messages: []ccPluginMessage{}, Settings: &upd}
		s.poll, s.done = nil, nil
		delete(r.queued, id)
		return
	}
	r.queued[id] = ccPluginQueuedSettings{settings: upd, at: time.Now()}
}

// moveQueuedSettings moves pre-queued settings from oldID to newID when Claude Desktop continues a resting session
// under a new transcript UUID.
func (r *ccPluginRegistry) moveQueuedSettings(oldID, newID string) {
	if oldID == "" || newID == "" || oldID == newID {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	q, ok := r.queued[oldID]
	if !ok {
		return
	}
	delete(r.queued, oldID)
	if r.queued == nil {
		r.queued = map[string]ccPluginQueuedSettings{}
	}
	r.queued[newID] = q
}

// expect makes room for the plugin's word on item mid, before it is handed over.
func (r *ccPluginRegistry) expect(id, mid string) chan ccPluginAck {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch := make(chan ccPluginAck, 1)
	if s := r.sessions[id]; s != nil {
		s.acks[mid] = ch
	}
	return ch
}

// settle forgets item mid.
func (r *ccPluginRegistry) settle(id, mid string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s := r.sessions[id]; s != nil {
		delete(s.acks, mid)
	}
}

// acked passes the plugin's word on item mid on, false for an item the node is not waiting on.
func (r *ccPluginRegistry) acked(id string, pid int, mid string, a ccPluginAck) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	if s == nil || s.pid != pid {
		return false
	}
	ch, ok := s.acks[mid]
	if !ok {
		return false
	}
	select {
	case ch <- a:
	default:
	}
	return true
}

// handOver gives d to session id's waiting poll from claude pid, waiting up to wait for one; false when none took it.
func (r *ccPluginRegistry) handOver(ctx context.Context, id string, pid int, d ccPluginDelivery, wait time.Duration) bool {
	if d.Messages == nil {
		d.Messages = []ccPluginMessage{}
	}
	deadline := time.Now().Add(wait)
	for {
		r.mu.Lock()
		s := r.sessions[id]
		if s != nil && s.pid == pid && s.poll != nil {
			s.poll <- d // room for one, and only handed over once: the poll is taken off below
			s.poll, s.done = nil, nil
			r.mu.Unlock()
			return true
		}
		r.mu.Unlock()
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// ccPluginServes: the node hands the owner's messages to the plugin in claude c, a claude outside Persona's terminals
// (a variable so the live test can serve the stream-json claude it starts, which an SDK's entrypoint names).
var ccPluginServes = func(n *Node, c claudeProc) bool { return n.outsideSource(c) != "" }

// ccPluginStatus is one session in claude-plugin.status.
type ccPluginStatus struct {
	SessionID     string    `json:"session_id"`
	PID           int       `json:"pid"`
	PluginVersion string    `json:"plugin_version"`
	EngineVersion string    `json:"engine_version"`
	Polling       bool      `json:"polling"`
	SeenAt        time.Time `json:"seen_at"`
}

// status lists the sessions whose plugin polled, those whose claude still runs (live: by session, its pid).
func (r *ccPluginRegistry) status(live map[string]int) []ccPluginStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []ccPluginStatus{}
	for id, s := range r.sessions {
		if live[id] != s.pid {
			delete(r.sessions, id) // its claude exited, or went on in another session (a /clear polls under the new id)
			continue
		}
		out = append(out, ccPluginStatus{SessionID: id, PID: s.pid, PluginVersion: s.version, EngineVersion: s.engine,
			Polling: s.poll != nil, SeenAt: s.seen.UTC()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SessionID < out[j].SessionID })
	return out
}

// ccPluginInput: session id, open in claude pid, has the plugin (its session row's capabilities.plugin_input).
func (n *Node) ccPluginInput(id string, pid int) bool {
	return n.ccPlugins.session(id, pid) != nil
}

// ccPluginSettingsCapable: session id, open in claude pid, has a polling plugin that supports session-scoped
// model / effort switching.
func (n *Node) ccPluginSettingsCapable(id string, pid int) bool {
	return n.ccPlugins.settingsCapable(id, pid)
}

// queueCCPluginSettings queues session-scoped model / effort overrides for session id (e.g. a newly seeded or resting
// desktop session whose claude process has not polled yet).
func (n *Node) queueCCPluginSettings(id, model, effort string) {
	n.ccPlugins.queueSettings(id, model, effort)
}

// ccPluginSetSettings sends a session-scoped model / effort switch to a live outside Claude session via Persona's
// plugin, or queues it for a resting Claude Desktop session that will open in the app on next send.
func (n *Node) ccPluginSetSettings(ctx context.Context, id, model, effort string) (handled bool, err error) {
	if c, ok := n.outsideClaude(id); ok && outsidePane(c) == "" {
		if !n.ccPlugins.settingsCapable(id, c.pid) {
			return false, nil
		}
		upd := ccPluginSettings{
			ID:     strings.ReplaceAll(newUUID(), "-", ""),
			Model:  model,
			Effort: effort,
		}
		acks := n.ccPlugins.expect(id, upd.ID)
		defer n.ccPlugins.settle(id, upd.ID)
		if !n.ccPlugins.handOver(ctx, id, c.pid, ccPluginDelivery{Messages: []ccPluginMessage{}, Settings: &upd}, ccPluginPickupWait) {
			// Poll is momentarily reconnecting: queue it for the next poll rather than dropping the user's pick.
			n.ccPlugins.queueSettings(id, model, effort)
			return true, nil
		}
		timer := time.NewTimer(ccPluginSubmitWait)
		defer timer.Stop()
		select {
		case a := <-acks:
			if !a.Submitted {
				return true, fmt.Errorf("claude plugin rejected settings (%s)", a.Reason)
			}
			return true, nil
		case <-timer.C:
			return true, nil
		case <-ctx.Done():
			return true, ctx.Err()
		}
	}
	if claudeDesktopOpens && readClaudeDesktopIndex(n.home).about[id].local != "" && n.desktopPluginReady() {
		n.ccPlugins.queueSettings(id, model, effort)
		return true, nil
	}
	return false, nil
}

// desktopPluginReady reports whether Persona's current Claude plugin is installed so a resting Claude Desktop session
// will receive queued settings once opened.
func (n *Node) desktopPluginReady() bool {
	st := n.claudePluginStatus()
	return st != nil && st.Version != "" && st.Version == st.Bundled
}

// ccPluginStatusNow is claude-plugin.status's answer.
func (n *Node) ccPluginStatusNow() map[string]any {
	live := map[string]int{}
	for _, c := range n.liveClaudes() {
		live[c.SessionID] = c.pid
	}
	return map[string]any{"protocol": ccPluginProtocol, "sessions": n.ccPlugins.status(live)}
}

// isHTTPRequestLine: the socket's first line is an HTTP request's (the plugin's), not a JSON request.
func isHTTPRequestLine(line []byte) bool {
	return bytes.HasPrefix(line, []byte("POST /")) || bytes.HasPrefix(line, []byte("GET /"))
}

// serveCCPluginHTTP answers one HTTP request on the node socket: the plugin's. first is the request's start, already
// read; rest the connection's reader after it.
func (n *Node) serveCCPluginHTTP(ctx context.Context, c net.Conn, first []byte, rest *bufio.Reader) {
	// A request is small: its line, a few headers and a body of at most ccPluginBodyMost. What is past this bound is
	// never read, so no caller makes the node keep more.
	br := bufio.NewReader(io.LimitReader(io.MultiReader(bytes.NewReader(first), rest), ccPluginRequestMost))
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, ccPluginBodyMost+1))
	if err != nil || len(body) > ccPluginBodyMost {
		writeCCPluginHTTP(c, http.StatusRequestEntityTooLarge, map[string]any{"error": "too_large"})
		return
	}
	// The plugin going away (its session ended, a reload) ends a poll it left waiting.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		_, _ = br.ReadByte()
		cancel()
	}()
	status, out := n.ccPluginRequest(ctx, c, req.Method, req.URL.Path, body)
	writeCCPluginHTTP(c, status, out)
}

// ccPluginRequest is one of the plugin's requests, answered with a status and a JSON body.
func (n *Node) ccPluginRequest(ctx context.Context, c net.Conn, method, path string, body []byte) (int, any) {
	what, ok := strings.CutPrefix(path, ccPluginPrefix)
	if !ok || method != http.MethodPost || (what != "poll" && what != "ack" && what != "permission") {
		return http.StatusNotFound, map[string]any{"error": "unknown"}
	}
	if what == "permission" {
		return n.ccPluginPermission(ctx, c, body)
	}
	var in struct {
		SessionID     string   `json:"session_id"`
		PluginVersion string   `json:"plugin_version"`
		EngineVersion string   `json:"engine_version"`
		Capabilities  []string `json:"capabilities"`
		WaitMS        int64    `json:"wait_ms"`
		ID            string   `json:"id"`
		Submitted     bool     `json:"submitted"`
		Reason        string   `json:"reason"`
		Detail        string   `json:"detail"`
	}
	if json.Unmarshal(body, &in) != nil || !validID(in.SessionID) {
		return http.StatusBadRequest, map[string]any{"error": "invalid"}
	}
	pid, err := ccPluginPeerPID(c)
	if err != nil || pid <= 0 {
		// A system that does not say who is at the other end: nothing is handed to anyone.
		return http.StatusForbidden, map[string]any{"error": "peer_unknown", "retry_ms": ccPluginOtherRetry.Milliseconds()}
	}
	claude, ok := n.liveClaudeOf(pid)
	if !ok || claude.SessionID != in.SessionID {
		return http.StatusForbidden, map[string]any{"error": "not_this_session", "retry_ms": ccPluginStrangerRetry.Milliseconds()}
	}
	if what == "ack" {
		n.ccPlugins.acked(in.SessionID, pid, in.ID, ccPluginAck{
			Submitted: in.Submitted,
			Reason:    clipReason(in.Reason),
			Detail:    clipDetail(in.Detail),
		})
		return http.StatusOK, map[string]any{"ok": true}
	}
	if !ccPluginServes(n, claude) {
		// A pane's claude takes typing, and the assistant's or an SDK's is driven by its own host: none of them gets
		// messages this way.
		return http.StatusOK, map[string]any{"messages": []ccPluginMessage{}, "retry_ms": ccPluginOtherRetry.Milliseconds()}
	}
	wait := time.Duration(in.WaitMS) * time.Millisecond
	if wait <= 0 || wait > ccPluginPollMost {
		wait = ccPluginPollMost
	}
	caps := ccPluginCaps{
		settings:         slices.Contains(in.Capabilities, "settings"),
		busyInput:        slices.Contains(in.Capabilities, "busy_input"),
		interrupt:        slices.Contains(in.Capabilities, "interrupt"),
		permissionBridge: slices.Contains(in.Capabilities, "permission_bridge"),
	}
	poll, done, immediate, changed := n.ccPlugins.polled(in.SessionID, pid, clipReason(in.PluginVersion), clipReason(in.EngineVersion), caps)
	if changed {
		n.notifySessions()
	}
	if immediate != nil {
		return http.StatusOK, ccPluginDelivery{Messages: []ccPluginMessage{}, Settings: immediate}
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case d := <-poll:
		return http.StatusOK, d
	case <-done:
	case <-t.C:
	case <-ctx.Done():
	}
	if !n.ccPlugins.pollEnded(in.SessionID, poll) {
		select {
		case d := <-poll: // handed over as the poll ended
			return http.StatusOK, d
		default:
		}
	}
	return http.StatusOK, ccPluginDelivery{Messages: []ccPluginMessage{}}
}

// clipReason keeps a short word from the plugin (a version, a reason) short.
func clipReason(s string) string {
	if len(s) > 64 {
		return s[:64]
	}
	return s
}

// clipDetail bounds an optional diagnostic string from the plugin (e.g. PromptSubmitResult.drop).
func clipDetail(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(s, "\r", " "), "\n", " "))
	if len(s) > 200 {
		return s[:200]
	}
	return s
}

// writeCCPluginHTTP writes one HTTP response with a JSON body and closes the exchange.
func writeCCPluginHTTP(c net.Conn, status int, body any) {
	b, _ := json.Marshal(body)
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = fmt.Fprintf(c, "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		status, http.StatusText(status), len(b), b)
}

// liveClaudeOf is the running claude whose process is pid.
func (n *Node) liveClaudeOf(pid int) (claudeProc, bool) {
	for _, c := range n.liveClaudes() {
		if c.pid == pid {
			return c, true
		}
	}
	return claudeProc{}, false
}

// ownerInputExact: params carry the owner mark exactly as the devices manager writes it, "owner_input": true, and no
// other key that encoding/json would also read as it (OWNER_INPUT, Owner_Input…: its field match ignores case). The
// devices manager strips every such key a caller sent (devices/owner_input.go); this keeps a node from honouring a
// variant that reached it some other way (#9607).
func ownerInputExact(params json.RawMessage) bool {
	decoder := json.NewDecoder(bytes.NewReader(params))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return false
	}
	owner := false
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		var value json.RawMessage
		if err != nil || !ok || decoder.Decode(&value) != nil {
			return false
		}
		if strings.EqualFold(key, "owner_input") {
			if owner || key != "owner_input" || string(value) != "true" {
				return false
			}
			owner = true
		}
	}
	if _, err := decoder.Token(); err != nil {
		return false
	}
	_, err := decoder.Token()
	return owner && err == io.EOF
}

// ownerDelivery is where the send says how the owner's message went in (a tmux pane, the plugin or the inbox), for
// session.send's answer.
type ownerDelivery struct{ as, reason string }

type ownerDeliveryKey struct{}

// withOwnerDelivery marks a send as the owner's own message (owner_input): an outside Claude's tmux pane takes it as
// terminal input; without a pane, sendOutside may hand it to the plugin.
func withOwnerDelivery(ctx context.Context) (context.Context, *ownerDelivery) {
	d := new(ownerDelivery)
	return context.WithValue(ctx, ownerDeliveryKey{}, d), d
}

// ownerDeliveryOf is the send's ownerDelivery, nil for a message that is not the owner's own.
func ownerDeliveryOf(ctx context.Context) *ownerDelivery {
	d, _ := ctx.Value(ownerDeliveryKey{}).(*ownerDelivery)
	return d
}

// effectiveOutsideStatus returns c.Status unless a recent plugin abort settled the turn while `sessions/<pid>.json`
// stayed stuck at `"busy"` / `"waiting"` without any new user prompt arriving in the transcript.
func (n *Node) effectiveOutsideStatus(c claudeProc, transcriptPath string, rev int64) string {
	if c.Status != "busy" && c.Status != "waiting" {
		n.ccPlugins.clearAborted(c.SessionID, c.pid)
		return c.Status
	}
	aborted := n.ccPlugins.abortedRev(c.SessionID, c.pid)
	if aborted < 0 {
		return c.Status
	}
	if transcriptPath == "" {
		transcriptPath = n.transcriptPath(c.SessionID)
	}
	if rev <= 0 && transcriptPath != "" {
		rev = fileSizeOrZero(transcriptPath)
	}
	if rev > aborted && transcriptHasNewTurnSince(transcriptPath, aborted) {
		n.ccPlugins.clearAborted(c.SessionID, c.pid)
		return c.Status
	}
	return "idle"
}

func transcriptHasNewTurnSince(path string, offset int64) bool {
	if path == "" || offset < 0 {
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
		var row struct {
			Type        string          `json:"type"`
			Operation   string          `json:"operation"`
			IsSidechain bool            `json:"isSidechain"`
			Message     json.RawMessage `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &row) != nil || row.IsSidechain {
			continue
		}
		if row.Type == "queue-operation" && row.Operation == "enqueue" {
			return true
		}
		if row.Type == "user" && isUserPromptMessage(row.Message) {
			return true
		}
	}
	return false
}

func isUserPromptMessage(raw json.RawMessage) bool {
	var m struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &m) != nil || len(m.Content) == 0 {
		return false
	}
	trimmed := bytes.TrimLeft(m.Content, " \t\r\n")
	if len(trimmed) == 0 {
		return false
	}
	if trimmed[0] == '"' {
		return true
	}
	var blocks []struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(trimmed, &blocks) != nil || len(blocks) == 0 {
		return false
	}
	for _, b := range blocks {
		if b.Type != "tool_result" {
			return true
		}
	}
	return false
}

// ccPluginSend hands text, the owner's own message, to the plugin in claude c, which has session id open. true when the
// session took it as the person's input: the transcript shows the prompt (or its queue entry), or the plugin said it
// submitted it. false with why it did not, nothing submitted.
func (n *Node) ccPluginSend(ctx context.Context, c claudeProc, id, text string) (bool, string) {
	if n.ccPlugins.session(id, c.pid) == nil {
		return false, relayNoPlugin
	}
	switch {
	case claudeBgStatus[c.Status] == proto.StatusIdle:
	case (c.Status == "busy" || c.Status == "waiting") && n.ccPlugins.busyInputCapable(id, c.pid):
	default:
		return false, relayBusy // behind a dialog on a 0.1.0 plugin that awaits turn completion on submit
	}
	path := n.transcriptPath(id)
	var offset int64
	if st, err := os.Stat(path); err == nil {
		offset = st.Size()
	}
	m := ccPluginMessage{ID: strings.ReplaceAll(newUUID(), "-", ""), Text: text, DeadlineMS: time.Now().Add(ccPluginSubmitWait).UnixMilli()}
	acks := n.ccPlugins.expect(id, m.ID)
	defer n.ccPlugins.settle(id, m.ID)
	if !n.ccPlugins.handOver(ctx, id, c.pid, ccPluginDelivery{Messages: []ccPluginMessage{m}}, ccPluginPickupWait) {
		return false, relayUnavailable
	}
	needle := ccPluginNeedle(text)
	deadline := time.Now().Add(ccPluginConfirmWait)
	submitted := false
	for {
		if path == "" {
			path = n.transcriptPath(id)
		}
		if path != "" && ccPluginSeen(path, offset, needle) {
			n.ccPlugins.clearAborted(id, c.pid)
			return true, ""
		}
		if submitted && (c.Status == "busy" || c.Status == "waiting") {
			n.ccPlugins.clearAborted(id, c.pid)
			return true, "" // queued via $.prompt.submit while a turn runs; ack confirmed acceptance
		}
		if time.Now().After(deadline) {
			if submitted {
				n.ccPlugins.clearAborted(id, c.pid)
				return true, "" // its turn started with it (the plugin's submit resolves then); the line is late
			}
			log.Printf("send %s: the plugin took it and nothing showed it went in within %s", id, ccPluginConfirmWait)
			return false, relayUnconfirmed
		}
		select {
		case a := <-acks:
			if !a.Submitted {
				if a.Detail != "" {
					log.Printf("send %s: the plugin did not submit it (%s: %s)", id, a.Reason, a.Detail)
				} else {
					log.Printf("send %s: the plugin did not submit it (%s)", id, a.Reason)
				}
				if n.isPluginStopLatchDrop(path, a) {
					return false, relayStopped
				}
				return false, relayRefused
			}
			submitted = true
		case <-ctx.Done():
			return false, relayUnconfirmed
		case <-time.After(150 * time.Millisecond):
		}
	}
}

// ccPluginAbortAndSend powers "Send now" for outside Claude sessions: when a turn is running it hands both an interrupt
// and (when text != nil) the queued prompt in a single poll delivery so register.ts aborts the running turn and submits
// the queued prompt immediately without marking the session idle. When text == nil it aborts the running turn without
// markAborted so Claude Code's own native prompt queue runs next. pickedUp reports whether the plugin received the poll.
func (n *Node) ccPluginAbortAndSend(ctx context.Context, c claudeProc, id string, text *string) (pickedUp bool, err error) {
	if n.ccPlugins.session(id, c.pid) == nil {
		return false, refusal(peerUnsupported, "Persona 插件未连接，无法立即发送", nil)
	}
	path := n.transcriptPath(id)
	offset := fileSizeOrZero(path)
	eff := n.effectiveOutsideStatus(c, path, offset)
	busy := eff == "busy" || eff == "waiting"
	if busy && !n.ccPlugins.interruptCapable(id, c.pid) {
		return false, refusal(peerUnsupported, "当前会话的 Persona 插件版本不支持立即打断并发送", nil)
	}
	if text == nil {
		if !busy {
			return true, nil
		}
		req := ccPluginInterrupt{
			ID:         strings.ReplaceAll(newUUID(), "-", ""),
			DeadlineMS: time.Now().Add(ccPluginSubmitWait).UnixMilli(),
		}
		acks := n.ccPlugins.expect(id, req.ID)
		defer n.ccPlugins.settle(id, req.ID)
		if !n.ccPlugins.handOver(ctx, id, c.pid, ccPluginDelivery{Messages: []ccPluginMessage{}, Interrupt: &req}, ccPluginPickupWait) {
			return false, uncertain(fmt.Errorf("Persona 插件未能在 %s 内接收立即发送指令", ccPluginPickupWait))
		}
		select {
		case <-acks:
			n.ccPlugins.clearAborted(id, c.pid)
			return true, nil
		case <-ctx.Done():
			return true, ctx.Err()
		case <-time.After(ccPluginSubmitWait):
			return true, uncertain(fmt.Errorf("Persona 插件立即发送等待确认超时"))
		}
	}
	if !busy {
		cIdle := c
		cIdle.Status = "idle"
		ok, why := n.ccPluginSend(ctx, cIdle, id, *text)
		if !ok {
			if why == relayStopped && n.peerFallbackOwnerSend(ctx, cIdle, id, *text, offset) {
				return true, nil
			}
			return why != relayUnavailable && why != relayNoPlugin, uncertain(fmt.Errorf("Persona 插件未能提交这条消息（%s），请稍后重试", why))
		}
		return true, nil
	}
	req := ccPluginInterrupt{
		ID:         strings.ReplaceAll(newUUID(), "-", ""),
		DeadlineMS: time.Now().Add(ccPluginSubmitWait).UnixMilli(),
	}
	m := ccPluginMessage{
		ID:         strings.ReplaceAll(newUUID(), "-", ""),
		Text:       *text,
		DeadlineMS: time.Now().Add(ccPluginSubmitWait).UnixMilli(),
	}
	intAcks := n.ccPlugins.expect(id, req.ID)
	msgAcks := n.ccPlugins.expect(id, m.ID)
	defer n.ccPlugins.settle(id, req.ID)
	defer n.ccPlugins.settle(id, m.ID)
	if !n.ccPlugins.handOver(ctx, id, c.pid, ccPluginDelivery{Messages: []ccPluginMessage{m}, Interrupt: &req}, ccPluginPickupWait) {
		return false, uncertain(fmt.Errorf("Persona 插件未能在 %s 内接收立即发送指令", ccPluginPickupWait))
	}
	needle := ccPluginNeedle(*text)
	deadline := time.Now().Add(ccPluginConfirmWait)
	submitted := false
	for {
		if path == "" {
			path = n.transcriptPath(id)
		}
		if path != "" && ccPluginSeen(path, offset, needle) {
			n.ccPlugins.clearAborted(id, c.pid)
			return true, nil
		}
		if time.Now().After(deadline) {
			if submitted {
				n.ccPlugins.clearAborted(id, c.pid)
				return true, nil
			}
			return true, uncertain(fmt.Errorf("Persona 插件已接收立即发送指令，但尚未确认写入会话"))
		}
		select {
		case <-intAcks:
		case a := <-msgAcks:
			if !a.Submitted {
				if n.isPluginStopLatchDrop(path, a) && n.peerFallbackOwnerSend(ctx, c, id, *text, offset) {
					n.ccPlugins.clearAborted(id, c.pid)
					return true, nil
				}
				return true, uncertain(fmt.Errorf("Persona 插件未能提交排队消息（%s）", a.Reason))
			}
			submitted = true
		case <-ctx.Done():
			return true, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// ccPluginInterrupt asks Persona's plugin in claude c to abort the running main-loop turn via $.turn.abort.
// When an interrupt-capable plugin is connected to session id, handled is always true so interruptOutside never falls
// back to the peer inbox (which would wake an idle session if `sessions/<pid>.json` had a stale `"busy"` status).
func (n *Node) ccPluginInterrupt(ctx context.Context, c claudeProc, id string) (handled bool, err error) {
	if !n.ccPlugins.interruptCapable(id, c.pid) {
		return false, nil
	}
	if c.Status != "busy" && c.Status != "waiting" {
		n.ccPlugins.clearAborted(id, c.pid)
		return true, nil
	}
	tpath := n.transcriptPath(id)
	if n.effectiveOutsideStatus(c, tpath, fileSizeOrZero(tpath)) == "idle" {
		return true, nil
	}
	req := ccPluginInterrupt{
		ID:         strings.ReplaceAll(newUUID(), "-", ""),
		DeadlineMS: time.Now().Add(ccPluginSubmitWait).UnixMilli(),
	}
	acks := n.ccPlugins.expect(id, req.ID)
	defer n.ccPlugins.settle(id, req.ID)
	if !n.ccPlugins.handOver(ctx, id, c.pid, ccPluginDelivery{Messages: []ccPluginMessage{}, Interrupt: &req}, ccPluginPickupWait) {
		return true, uncertain(fmt.Errorf("Persona 插件未能在 %s 内接收停止指令", ccPluginPickupWait))
	}
	deadline := time.Now().Add(ccPluginSubmitWait)
	for {
		if now, ok := n.outsideClaude(id); !ok || (now.Status != "busy" && now.Status != "waiting") {
			n.ccPlugins.clearAborted(id, c.pid)
			n.notifySessions()
			log.Printf("interrupt %s: claude %d settled after Persona's plugin took the stop", id, c.pid)
			return true, nil
		}
		if time.Now().After(deadline) {
			return true, uncertain(fmt.Errorf("Persona 插件停止指令等待确认超时"))
		}
		select {
		case a := <-acks:
			if a.Submitted || a.Reason == "no_turn" {
				n.ccPlugins.markAborted(id, c.pid, fileSizeOrZero(n.transcriptPath(id)))
				n.notifySessions()
				if a.Submitted {
					log.Printf("interrupt %s: claude %d aborted its turn through Persona's plugin", id, c.pid)
				} else {
					log.Printf("interrupt %s: claude %d plugin reported no active turn; marking stale %s status idle", id, c.pid, c.Status)
				}
				return true, nil
			}
			log.Printf("interrupt %s: the plugin did not abort (%s)", id, a.Reason)
			return true, uncertain(fmt.Errorf("Persona 插件未能停止当前轮次（%s）", a.Reason))
		case <-ctx.Done():
			return true, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// ccPluginNeedle is the first words of text: at most 40 runes, to the end of its first line.
func ccPluginNeedle(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	r := []rune(strings.TrimSpace(line))
	if len(r) > 40 {
		r = r[:40]
	}
	return string(r)
}

// ccPluginSeen: a line past offset is the plugin's prompt with needle in it (a user line Persona's plugin submitted as
// the person's words), or the queue entry Claude Code writes when it takes it.
func ccPluginSeen(path string, offset int64, needle string) bool {
	if needle == "" {
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
	br := bufio.NewReaderSize(f, 64<<10)
	for {
		l, err := peerLine(br)
		if ccPluginLineSeen(l, needle) {
			return true
		}
		if err != nil {
			return false
		}
	}
}

// ccPluginName is the plugin's name, as Claude Code writes it in a prompt's origin.
const ccPluginName = "persona"

// ccPluginLineSeen: l is the plugin's prompt with needle, or a queue entry whose text has it.
func ccPluginLineSeen(l []byte, needle string) bool {
	if !bytes.Contains(l, []byte(`"queue-operation"`)) && !bytes.Contains(l, []byte(`"plugin"`)) {
		return false
	}
	var e struct {
		Type      string `json:"type"`
		Operation string `json:"operation"`
		Content   string `json:"content"`
		Message   struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		Origin *struct {
			Kind   string `json:"kind"`
			Name   string `json:"name"`
			AsUser bool   `json:"asUser"`
		} `json:"origin"`
	}
	if json.Unmarshal(l, &e) != nil {
		return false
	}
	switch {
	case e.Type == "queue-operation":
		return e.Operation == "enqueue" && strings.Contains(e.Content, needle)
	case e.Type == "user" && e.Origin != nil && e.Origin.Kind == "plugin" && e.Origin.Name == ccPluginName && e.Origin.AsUser:
		var said string
		_ = json.Unmarshal(e.Message.Content, &said)
		return strings.Contains(said, needle)
	}
	return false
}

// isPluginStopLatchDrop reports whether a non-submitted plugin ack represents Claude Code's host Stop latch
// ("the session was stopped and nobody has sent input since"), where plugin prompts are dropped until the host
// receives direct input. Only this case may fall back to the peer inbox; hook refusals never fall back.
func (n *Node) isPluginStopLatchDrop(transcriptPath string, a ccPluginAck) bool {
	if a.Reason == "stopped" {
		return true
	}
	if a.Reason != "dropped" {
		return false
	}
	if a.Detail != "" {
		return isStopLatchDropText(a.Detail)
	}
	// Legacy <= 0.4.1 plugin acks omit `detail`: fall back only when the session's transcript confirms an open
	// host-side `[Request interrupted by user]` with no direct host prompt since.
	return transcriptHasOpenHostStop(transcriptPath)
}

func isStopLatchDropText(s string) bool {
	low := strings.ToLower(s)
	return strings.Contains(low, "session was stopped") && strings.Contains(low, "sent input since")
}

// transcriptHasOpenHostStop scans backward from the tail of path for the latest direct host user row (ignoring tool
// results, local commands, peer inbox turns, and plugin turns) and returns true when it is Claude Code's user-interrupt
// marker. Peer inbox turns do not clear Claude Code's host Stop latch, so skipping peer/plugin origins preserves
// detection across consecutive fallback sends until a direct host prompt lands.
func transcriptHasOpenHostStop(path string) bool {
	if path == "" {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return false
	}
	const chunkSize int64 = 512 << 10
	const scanMax int64 = 16 << 20
	end := st.Size()
	limit := max(int64(0), end-scanMax)
	var carry []byte
	for end > limit {
		start := max(limit, end-chunkSize)
		buf := make([]byte, end-start)
		if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
			return false
		}
		if len(carry) > 0 {
			buf = append(buf, carry...)
			carry = nil
		}
		lines := bytes.Split(buf, []byte{'\n'})
		firstIdx := 0
		if start > limit {
			carry = append([]byte(nil), lines[0]...)
			firstIdx = 1
		}
		for i := len(lines) - 1; i >= firstIdx; i-- {
			line := bytes.TrimSpace(lines[i])
			if len(line) == 0 || !bytes.Contains(line, []byte(`"user"`)) {
				continue
			}
			var row struct {
				Type        string `json:"type"`
				IsSidechain bool   `json:"isSidechain"`
				IsMeta      bool   `json:"isMeta"`
				Origin      *struct {
					Kind string `json:"kind"`
				} `json:"origin"`
				Message json.RawMessage `json:"message"`
			}
			if json.Unmarshal(line, &row) != nil || row.Type != "user" || row.IsSidechain || row.IsMeta {
				continue
			}
			if row.Origin != nil && row.Origin.Kind != "" && row.Origin.Kind != "user" && row.Origin.Kind != "human" {
				continue
			}
			switch classifyDirectHostUserRow(row.Message) {
			case 1:
				return true
			case -1:
				return false
			}
		}
		end = start
	}
	return false
}

// classifyDirectHostUserRow returns 1 for a host-side user interrupt line, -1 for a genuine direct host prompt, and 0
// for synthetic / tool-result-only / local-command rows to skip.
func classifyDirectHostUserRow(raw json.RawMessage) int {
	var m struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &m) != nil || len(m.Content) == 0 {
		return 0
	}
	trimmed := bytes.TrimLeft(m.Content, " \t\r\n")
	if len(trimmed) == 0 {
		return 0
	}
	isInterruptText := func(s string) bool {
		t := strings.TrimSpace(s)
		return t == "[Request interrupted by user]" || t == "[Request interrupted by user for tool use]"
	}
	isSyntheticText := func(s string) bool {
		t := strings.TrimSpace(s)
		return t == "" ||
			strings.HasPrefix(t, "<local-command-caveat>") ||
			strings.HasPrefix(t, "<command-name>") ||
			strings.HasPrefix(t, "<local-command-stdout>") ||
			strings.HasPrefix(t, "<task-notification>")
	}
	if trimmed[0] == '"' {
		var s string
		if json.Unmarshal(trimmed, &s) != nil {
			return 0
		}
		if isInterruptText(s) {
			return 1
		}
		if isSyntheticText(s) {
			return 0
		}
		return -1
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(trimmed, &blocks) != nil || len(blocks) == 0 {
		return 0
	}
	sawInterrupt := false
	sawRealPrompt := false
	for _, b := range blocks {
		if b.Type == "tool_result" {
			continue
		}
		if b.Type == "text" {
			if isInterruptText(b.Text) {
				sawInterrupt = true
				continue
			}
			if isSyntheticText(b.Text) {
				continue
			}
			sawRealPrompt = true
			continue
		}
		sawRealPrompt = true
	}
	if sawRealPrompt {
		return -1
	}
	if sawInterrupt {
		return 1
	}
	return 0
}

// peerFallbackOwnerSend sends an owner message through Claude Code's peer inbox when Persona's plugin hit Claude
// Code's host Stop latch. It attests owner provenance so bypassPermissions sessions accept it without holding.
func (n *Node) peerFallbackOwnerSend(ctx context.Context, c claudeProc, id, text string, offset int64) bool {
	p, has := peerOf(c)
	if !has {
		return false
	}
	if ownerDeliveryOf(ctx) == nil {
		ctx, _ = withOwnerDelivery(ctx)
	}
	p.fromMode = n.peerAttest(ctx, c, id)
	if err := peerSendAt(ctx, p, id, text, peerNext); err != nil {
		var pe *errPeer
		if asPeer(err, &pe) {
			log.Printf("send %s: peer inbox fallback refused by claude %d: %v", id, c.pid, err)
			return false
		}
	}
	if peerTaken(ctx, func() string { return n.transcriptPath(id) }, offset, text, peerConfirmWait) {
		n.ccPlugins.clearAborted(id, c.pid)
		return true
	}
	log.Printf("send %s: peer inbox fallback to claude %d was not confirmed within %s", id, c.pid, peerConfirmWait)
	return false
}
