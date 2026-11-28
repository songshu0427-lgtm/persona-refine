package assistant

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nwverse/persona/server/internal/prompts"
	"github.com/nwverse/persona/server/internal/proto"
)

// routerNoticeTool marks a lightweight Router-mode completion/attention trigger delivered back into the
// dispatching assistant conversation (Collie-style auto-report without todos, plan cards, or review state machines).
const routerNoticeTool = "router_notice"

// routerNoticeDelay debounces brief idle blips between tool calls before waking the router conversation.
var routerNoticeDelay = 3 * time.Second

// routerWatchTTL bounds how long a single agent dispatch watch stays active without completing.
var routerWatchTTL = 6 * time.Hour

// routerExcludedTools are the heavy plan-card, task-review, direction, and supervision tools hidden in Router mode.
// Personal todo tools (todo_list/get/create/update/complete/reopen/delete) intentionally remain available for
// standalone human todos (e.g., Feishu scanning), strictly decoupled from agent_send/agent_start execution.
var routerExcludedTools = map[string]bool{
	"supervision_finish":        true,
	"agent_supervise":           true,
	"ask_escalate":              true,
	"task_plan":                 true,
	"task_plan_withdraw":        true,
	"task_review":               true,
	"task_scope":                true,
	"task_decided":              true,
	"task_start_screen":         true,
	"task_start_keys":           true,
	"task_retry":                true,
	"todo_repositories_get":     true,
	"todo_repositories_set":     true,
	"todo_repository_links_set": true,
	"todo_repository_links_add": true,
	"concern_report":            true,
	"direction_name":            true,
	"leader_progress":           true,
}

type routerWatch struct {
	targetConv       string
	machineID        string
	machineName      string
	sessionID        string
	label            string
	dispatchedAt     time.Time
	initialUpdatedAt time.Time
	sawWorking       bool
	pendingState     string
	pendingTimer     *time.Timer
}

type routerBook struct {
	mu      sync.Mutex
	watches map[string]*routerWatch // keyed by canonicalMachine + "\x00" + sessionID
}

// routerMode reports whether lightweight Collie-style Router mode is active (no todos, plan cards, or task review;
// direct agent_send/agent_start with automatic completion/attention wake-up back into the main chat).
func (s *Service) routerMode() bool {
	if s.routerOverride != nil {
		return *s.routerOverride
	}
	v := strings.TrimSpace(strings.ToLower(os.Getenv("PERSONA_ROUTER_MODE")))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func routerFilterTools(tools []proto.Tool) []proto.Tool {
	out := make([]proto.Tool, 0, len(tools))
	for _, t := range tools {
		if !routerExcludedTools[t.Name] {
			out = append(out, t)
		}
	}
	return out
}

// routerSnapshot strips agent-task, plan-card, task-review, approval, and inbox-following sections from the live
// snapshot while keeping personal OpenTodos, machines, live agents, chats, calendar, and reminders.
func routerSnapshot(snap prompts.Snapshot) prompts.Snapshot {
	snap.Tasks = nil
	snap.Plans, snap.PlansTotal = nil, 0
	snap.Asked = nil
	snap.Unaccepted, snap.UnacceptedTotal = nil, 0
	snap.Approvals = nil
	snap.FollowingEnabled, snap.Following, snap.FollowingTotal = false, nil, 0
	return snap
}

func routerAgentLabel(c proto.Session, fallbackCwd string) string {
	if c.Title != "" {
		return c.Title
	}
	if lbl := agentLabel(c); lbl != "" {
		return lbl
	}
	if fallbackCwd != "" {
		return filepath.Base(fallbackCwd)
	}
	return short(c.SessionID)
}

func (s *Service) routerWatchKey(machineID, sessionID string) string {
	if s.devs != nil {
		machineID = s.devs.Canonical(machineID)
	}
	return machineID + "\x00" + sessionID
}

// routerWatchAgent registers a lightweight watch on an agent dispatched via agent_send or agent_start in Router mode.
// When that agent finishes its turn or needs user attention, the dispatching conversation is woken automatically.
func (s *Service) routerWatchAgent(ctx context.Context, self, machineID, machineName, sessionID, label string, initialUpdatedAt time.Time, initiallyWorking bool) {
	if !s.routerMode() || sessionID == "" {
		return
	}
	target := self
	if target == "" {
		target = s.settings(ctx).Main
	}
	if target == "" {
		return
	}
	canonical := machineID
	if s.devs != nil {
		canonical = s.devs.Canonical(machineID)
	}
	key := canonical + "\x00" + sessionID
	b := &s.router
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.watches == nil {
		b.watches = map[string]*routerWatch{}
	}
	if old := b.watches[key]; old != nil && old.pendingTimer != nil {
		old.pendingTimer.Stop()
	}
	b.watches[key] = &routerWatch{
		targetConv:       target,
		machineID:        canonical,
		machineName:      cmp.Or(machineName, canonical),
		sessionID:        sessionID,
		label:            cmp.Or(label, short(sessionID)),
		dispatchedAt:     time.Now(),
		initialUpdatedAt: initialUpdatedAt,
		sawWorking:       initiallyWorking,
	}
}

// routerSessionsChanged inspects live session updates from any connected machine (Mac desktop apps, devbox/merlin
// herdr, etc.) and triggers a debounced wake-up notice when a watched agent completes or blocks.
func (s *Service) routerSessionsChanged(d DeviceSessions) {
	if !s.routerMode() {
		return
	}
	machine := d.MachineID
	if s.devs != nil {
		machine = s.devs.Canonical(machine)
	}
	byID := make(map[string]proto.Session, len(d.Sessions))
	for _, c := range d.Sessions {
		byID[c.SessionID] = c
	}
	now := time.Now()
	b := &s.router
	b.mu.Lock()
	defer b.mu.Unlock()
	for key, w := range b.watches {
		if now.Sub(w.dispatchedAt) > routerWatchTTL {
			if w.pendingTimer != nil {
				w.pendingTimer.Stop()
			}
			delete(b.watches, key)
			continue
		}
		if w.machineID != machine {
			continue
		}
		c, present := byID[w.sessionID]
		if !present {
			if w.sawWorking {
				s.armRouterWatchLocked(key, w, "stopped")
			}
			continue
		}
		if c.Title != "" {
			w.label = c.Title
		}
		if c.Status == proto.StatusWorking || c.Starting {
			w.sawWorking = true
			if w.pendingTimer != nil {
				w.pendingTimer.Stop()
				w.pendingTimer = nil
			}
			w.pendingState = ""
			continue
		}
		state := ""
		switch {
		case c.State == proto.StateNeedsYou || c.Status == proto.StatusBlocked:
			state = "needs"
		case c.TurnError != "" || c.Status == proto.StatusInterrupted:
			state = "error"
		case c.Status == proto.StatusOffline && w.sawWorking:
			state = "stopped"
		case (w.sawWorking || (!c.UpdatedAt.IsZero() && c.UpdatedAt.After(w.initialUpdatedAt))) &&
			(c.State == proto.StateUnread || c.State == proto.StateIdle || c.Status == proto.StatusDone || c.Status == proto.StatusIdle):
			state = "done"
		}
		if state != "" {
			s.armRouterWatchLocked(key, w, state)
		}
	}
}

func (s *Service) armRouterWatchLocked(key string, w *routerWatch, state string) {
	if w.pendingState == state && w.pendingTimer != nil {
		return
	}
	if w.pendingTimer != nil {
		w.pendingTimer.Stop()
	}
	w.pendingState = state
	delay := routerNoticeDelay
	w.pendingTimer = time.AfterFunc(delay, func() {
		s.fireRouterWatch(key, state)
	})
}

func (s *Service) fireRouterWatch(key, state string) {
	b := &s.router
	b.mu.Lock()
	w := b.watches[key]
	if w == nil || w.pendingState != state {
		b.mu.Unlock()
		return
	}
	snapshot := *w
	w.pendingTimer = nil
	delete(b.watches, key)
	b.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cfg := s.settings(ctx)
	target := snapshot.targetConv
	machine := cfg.MachineID
	if target == cfg.Main {
		machine = cfg.mainRouteMachine()
	}
	if target == "" {
		target = cfg.Main
		machine = cfg.mainRouteMachine()
	}
	if target == "" || machine == "" {
		s.logf("router watch %s: no target conversation", short(snapshot.sessionID))
		return
	}

	excerpt := ""
	rctx, rcancel := context.WithTimeout(ctx, 12*time.Second)
	if txt, err := s.toolAgentRead(rctx, snapshot.machineID, snapshot.sessionID, 2); err == nil {
		excerpt = clipRouterExcerpt(strings.TrimSpace(txt), 1400)
	}
	rcancel()

	stateLabel := map[string]string{
		"done":    "已完成当前轮次",
		"needs":   "正在等待你确认/回复",
		"error":   "执行出错或中断",
		"stopped": "已停止",
	}[state]
	if stateLabel == "" {
		stateLabel = state
	}

	var body strings.Builder
	fmt.Fprintf(&body, "[Agent 进展] %s（%s，session_id: `%s`）%s。", snapshot.label, snapshot.machineName, snapshot.sessionID, stateLabel)
	if excerpt != "" {
		body.WriteString("\n\n最近对话摘录：\n")
		body.WriteString(excerpt)
	}
	body.WriteString("\n\n请用不超过 3 行向用户总结核心结论，并在需要时给出 2–3 个明确下一步选项（如需更多细节可再调 `agent_read`）。不要给这次派活建待办、不要出计划卡。")

	msg := relayMsg{
		From:      snapshot.sessionID,
		FromTitle: snapshot.label,
		Tool:      routerNoticeTool,
		Text:      body.String(),
		At:        time.Now().UTC(),
		State:     state,
	}
	c, ok := s.session(ctx, machine, target)
	if !ok || c.Status == proto.StatusWorking || c.Starting || s.relayWaits(target, msg) {
		if s.queueRelay(target, msg) > 0 {
			s.publish(ctx)
			if ok && c.Status != proto.StatusWorking && !c.Starting {
				s.drainRelays(machine, []proto.Session{c})
			}
		}
		return
	}
	if err := s.deliverRelay(ctx, machine, target, msg); err != nil {
		s.logf("router watch %s: deliver failed: %v; queued", short(snapshot.sessionID), err)
		if s.queueRelay(target, msg) > 0 {
			s.publish(ctx)
		}
	}
}

func clipRouterExcerpt(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	// Keep the tail (most recent reply) at a valid UTF-8 boundary.
	start := len(s) - maxBytes
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return "…\n" + s[start:]
}
