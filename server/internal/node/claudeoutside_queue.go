package node

import (
	"context"
	"fmt"
	"log"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

var (
	outsideQueuePoll       = 150 * time.Millisecond
	outsideQueueHoldMax    = 12 * time.Hour
	outsideQueueStartGrace = 2 * time.Second
)

type outsideQueuedMsg struct {
	id          string
	clientMsgID string
	text        string
}

type outsideSessionQueue struct {
	mu        sync.Mutex
	held      []outsideQueuedMsg
	draining  bool
	sending   bool
	stopping  bool
	startedAt time.Time
	startRev  int64
}

func (q *outsideSessionQueue) recentlyStartedLocked(rev int64) bool {
	if q.startedAt.IsZero() {
		return false
	}
	if rev > q.startRev || time.Since(q.startedAt) >= outsideQueueStartGrace {
		q.startedAt = time.Time{}
		q.startRev = 0
		return false
	}
	return true
}

type outsideQueueRegistry struct {
	mu       sync.Mutex
	sessions map[string]*outsideSessionQueue
}

func (r *outsideQueueRegistry) get(id string) *outsideSessionQueue {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sessions == nil {
		r.sessions = map[string]*outsideSessionQueue{}
	}
	q := r.sessions[id]
	if q == nil {
		q = &outsideSessionQueue{}
		r.sessions[id] = q
	}
	return q
}

func (r *outsideQueueRegistry) lookup(id string) *outsideSessionQueue {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sessions == nil {
		return nil
	}
	return r.sessions[id]
}

func combineOutsideQueued(native, held []string) []string {
	if len(native) == 0 && len(held) == 0 {
		return nil
	}
	out := make([]string, 0, len(native)+len(held))
	out = append(out, native...)
	out = append(out, held...)
	return out
}

func (n *Node) outsideQueuedTexts(id string) []string {
	q := n.outsideQueues.lookup(id)
	if q == nil {
		return nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.held) == 0 {
		return nil
	}
	out := make([]string, len(q.held))
	for i, m := range q.held {
		out[i] = m.text
	}
	return out
}

func (n *Node) outsideQueueLen(id string) int {
	q := n.outsideQueues.lookup(id)
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.held)
}

func (n *Node) outsideQueueWorking(id string, rev int64) bool {
	q := n.outsideQueues.lookup(id)
	if q == nil {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.held) > 0 || q.sending || q.recentlyStartedLocked(rev)
}

func (n *Node) noteOutsideTurnStarted(id string, rev int64) {
	q := n.outsideQueues.get(id)
	q.mu.Lock()
	q.startedAt = time.Now()
	q.startRev = rev
	q.mu.Unlock()
}

func (n *Node) shouldHoldOutsideOwnerSend(cEff claudeProc, id string, rev int64) bool {
	if cEff.Status == "busy" || cEff.Status == "waiting" {
		return true
	}
	return n.outsideQueueWorking(id, rev)
}

func (n *Node) enqueueOutsideOwner(ctx context.Context, id, text string) {
	clientMsgID, _ := ctx.Value(sendTraceKey{}).(string)
	q := n.outsideQueues.get(id)
	q.mu.Lock()
	q.held = append(q.held, outsideQueuedMsg{
		id:          newUUID(),
		clientMsgID: clientMsgID,
		text:        text,
	})
	startDrain := !q.draining
	if startDrain {
		q.draining = true
	}
	q.mu.Unlock()
	markSendQueued(ctx)
	n.notifySessions()
	if startDrain {
		go n.drainOutsideQueue(id, q)
	}
}

func (n *Node) ensureOutsideDrain(id string, q *outsideSessionQueue) {
	q.mu.Lock()
	start := len(q.held) > 0 && !q.draining
	if start {
		q.draining = true
	}
	q.mu.Unlock()
	if start {
		go n.drainOutsideQueue(id, q)
	}
}

func (n *Node) drainOutsideQueue(id string, q *outsideSessionQueue) {
	deadline := time.Now().Add(outsideQueueHoldMax)
	ticker := time.NewTicker(outsideQueuePoll)
	defer ticker.Stop()
	for {
		c, ok := n.outsideClaude(id)
		if !ok {
			n.dropOutsideQueue(id, q)
			return
		}
		path := n.transcriptPath(id)
		rev := fileSizeOrZero(path)
		effStatus := n.effectiveOutsideStatus(c, path, rev)

		q.mu.Lock()
		if len(q.held) == 0 {
			q.draining = false
			q.mu.Unlock()
			return
		}
		if time.Now().After(deadline) {
			dropped := q.held
			q.held = nil
			q.draining = false
			q.mu.Unlock()
			for _, m := range dropped {
				if m.clientMsgID != "" {
					n.echoes.forget(id, m.clientMsgID)
				}
			}
			n.notifySessions()
			return
		}
		if q.stopping || q.sending || effStatus == "busy" || effStatus == "waiting" || q.recentlyStartedLocked(rev) {
			q.mu.Unlock()
			<-ticker.C
			continue
		}
		next := q.held[0]
		q.held = slices.Clone(q.held[1:])
		q.sending = true
		q.mu.Unlock()

		if next.clientMsgID != "" {
			n.echoes.prepareDispatched(id, []string{next.clientMsgID}, next.text)
		}
		n.notifySessions()

		cIdle := c
		cIdle.Status = "idle"
		sent, why := n.ccPluginSend(context.Background(), cIdle, id, next.text)
		usedPeer := false
		if !sent && why == relayStopped {
			sent = n.peerFallbackOwnerSend(context.Background(), cIdle, id, next.text, rev)
			usedPeer = sent
		}

		q.mu.Lock()
		q.sending = false
		if sent {
			q.startedAt = time.Now()
			q.startRev = rev
			done := len(q.held) == 0
			if done {
				q.draining = false
			}
			q.mu.Unlock()
			if usedPeer {
				log.Printf("send %s: drained queued owner message through peer inbox (plugin stop-latched)", id)
			} else {
				log.Printf("send %s: drained queued owner message through Persona's plugin", id)
			}
			n.notifySessions()
			if done {
				return
			}
			<-ticker.C
			continue
		}
		if why == relayUnavailable {
			// Plugin was reconnecting before picking up the poll; keep the message at the front of the queue.
			q.held = append([]outsideQueuedMsg{next}, q.held...)
			q.mu.Unlock()
			n.notifySessions()
			<-ticker.C
			continue
		}
		done := len(q.held) == 0
		if done {
			q.draining = false
		}
		q.mu.Unlock()
		if next.clientMsgID != "" {
			n.echoes.forget(id, next.clientMsgID)
		}
		n.notifySessions()
		if done {
			return
		}
	}
}

func (n *Node) dropOutsideQueue(id string, q *outsideSessionQueue) {
	q.mu.Lock()
	dropped := q.held
	q.held = nil
	q.draining = false
	q.sending = false
	q.stopping = false
	q.mu.Unlock()
	for _, m := range dropped {
		if m.clientMsgID != "" {
			n.echoes.forget(id, m.clientMsgID)
		}
	}
	if len(dropped) > 0 {
		n.notifySessions()
	}
}

func (n *Node) pauseOutsideQueueForStop(id string) bool {
	q := n.outsideQueues.lookup(id)
	if q == nil {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.held) == 0 {
		return false
	}
	q.stopping = true
	return true
}

func (n *Node) resumeOutsideQueueAfterStop(id string) {
	q := n.outsideQueues.lookup(id)
	if q == nil {
		return
	}
	q.mu.Lock()
	q.stopping = false
	q.mu.Unlock()
}

func (n *Node) commitOutsideQueueStop(id string) []string {
	q := n.outsideQueues.lookup(id)
	if q == nil {
		return nil
	}
	q.mu.Lock()
	taken := q.held
	q.held = nil
	q.stopping = false
	q.startedAt = time.Time{}
	q.startRev = 0
	q.mu.Unlock()
	if len(taken) == 0 {
		return nil
	}
	out := make([]string, len(taken))
	for i, m := range taken {
		out[i] = m.text
		if m.clientMsgID != "" {
			n.echoes.forget(id, m.clientMsgID)
		}
	}
	n.notifySessions()
	return out
}

func (n *Node) outsideNativeQueued(c claudeProc, id string) []string {
	path := n.transcriptPath(id)
	if path == "" {
		return nil
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil
	}
	eff := n.effectiveOutsideStatus(c, path, st.Size())
	if eff != "busy" && eff != "waiting" {
		return nil
	}
	return slices.Clone(n.metaNow(path, st).queue)
}

func (n *Node) editOutsideQueue(_ context.Context, id string, keep []int) (handled bool, queue []string, err error) {
	if _, live := n.agent(id); live {
		return false, nil, nil
	}
	c, ok := n.outsideClaude(id)
	if ok && outsidePane(c) != "" {
		return false, nil, nil
	}
	if !ok && n.outsideQueueLen(id) == 0 {
		return false, nil, nil
	}
	var native []string
	if ok {
		native = n.outsideNativeQueued(c, id)
	}
	q := n.outsideQueues.get(id)
	q.mu.Lock()
	nNative := len(native)
	total := nNative + len(q.held)
	if total == 0 {
		q.mu.Unlock()
		return true, nil, refusal("nothing_queued", "队列中没有可修改的消息了", nil)
	}
	seen := make(map[int]bool, len(keep))
	for _, k := range keep {
		if k < 0 || k >= total || seen[k] {
			q.mu.Unlock()
			return true, nil, refusal("queue_changed", "排队消息刚刚发生了变化，请刷新后再试", nil)
		}
		seen[k] = true
	}
	if nNative > 0 {
		if len(keep) < nNative {
			q.mu.Unlock()
			return true, nil, refusal("queue_locked_in_app", "这条消息已在桌面端 Claude 内部队列中，暂不支持撤回或编辑；点击「立即发送」可中止当前回复并立刻发送", nil)
		}
		for i := 0; i < nNative; i++ {
			if keep[i] != i {
				q.mu.Unlock()
				return true, nil, refusal("queue_locked_in_app", "这条消息已在桌面端 Claude 内部队列中，暂不支持撤回或调整顺序；点击「立即发送」可立刻发送", nil)
			}
		}
	}
	nextHeld := make([]outsideQueuedMsg, 0, max(0, len(keep)-nNative))
	keptHeld := make(map[int]bool, len(keep))
	for _, k := range keep[nNative:] {
		idx := k - nNative
		keptHeld[idx] = true
		nextHeld = append(nextHeld, q.held[idx])
	}
	var dropped []outsideQueuedMsg
	for i, m := range q.held {
		if !keptHeld[i] {
			dropped = append(dropped, m)
		}
	}
	q.held = nextHeld
	texts := make([]string, len(q.held))
	for i, m := range q.held {
		texts[i] = m.text
	}
	q.mu.Unlock()

	for _, m := range dropped {
		if m.clientMsgID != "" {
			n.echoes.forget(id, m.clientMsgID)
		}
	}
	n.notifySessions()
	return true, combineOutsideQueued(native, texts), nil
}

func (n *Node) sendOutsideQueuedNow(ctx context.Context, id string) (handled bool, err error) {
	if _, live := n.agent(id); live {
		return false, nil
	}
	c, ok := n.outsideClaude(id)
	if !ok {
		if n.outsideQueueLen(id) > 0 {
			return true, refusal("session_stopped", "会话已不在运行", nil)
		}
		return false, nil
	}
	if outsidePane(c) != "" {
		return false, nil
	}
	native := n.outsideNativeQueued(c, id)
	q := n.outsideQueues.get(id)
	q.mu.Lock()
	if q.sending {
		q.mu.Unlock()
		return true, refusal("agent_busy", "上一条排队消息正在发送，请稍候", nil)
	}
	msgs := q.held
	if len(msgs) == 0 && len(native) == 0 {
		q.mu.Unlock()
		return true, refusal("nothing_queued", "队列中没有待发送的消息了", nil)
	}
	q.held = nil
	q.sending = true
	q.mu.Unlock()

	restore := func() {
		q.mu.Lock()
		q.sending = false
		if len(msgs) > 0 {
			q.held = append(msgs, q.held...)
		}
		q.mu.Unlock()
		n.ensureOutsideDrain(id, q)
		n.notifySessions()
	}

	if len(msgs) == 0 {
		// Native desktop queue item only: aborting the running turn makes Claude Code dequeue and run it immediately.
		picked, err := n.ccPluginAbortAndSend(ctx, c, id, nil)
		q.mu.Lock()
		q.sending = false
		q.mu.Unlock()
		if err != nil {
			return true, err
		}
		if !picked {
			return true, refusal(peerUnsupported, "当前会话未启用支持立即发送的 Persona 插件", nil)
		}
		n.notifySessions()
		return true, nil
	}

	parts := make([]string, len(msgs))
	var ids []string
	for i, m := range msgs {
		parts[i] = m.text
		if m.clientMsgID != "" {
			ids = append(ids, m.clientMsgID)
		}
	}
	joined := strings.Join(parts, "\n")
	if len(ids) > 0 {
		n.echoes.prepareDispatched(id, ids, joined)
	}

	if n.ccPlugins.session(id, c.pid) != nil {
		if n.ccPerms.hasOpen(id, c.pid) {
			_ = n.outsidePermInterrupt(ctx, id, c.pid)
			n.ccPlugins.clearAborted(id, c.pid)
		}
		picked, sendErr := n.ccPluginAbortAndSend(ctx, c, id, &joined)
		if sendErr != nil {
			if !picked {
				restore()
			} else {
				q.mu.Lock()
				q.sending = false
				q.mu.Unlock()
				n.notifySessions()
			}
			return true, sendErr
		}
		rev := fileSizeOrZero(n.transcriptPath(id))
		q.mu.Lock()
		q.sending = false
		q.startedAt = time.Now()
		q.startRev = rev
		q.mu.Unlock()
		n.ensureOutsideDrain(id, q)
		n.notifySessions()
		return true, nil
	}

	p, has := peerOf(c)
	if !has {
		restore()
		return true, refusal(peerUnsupported, peerNoInboxMsg, nil)
	}
	p.fromMode = n.peerAttest(ctx, c, id)
	if err := peerSendAt(ctx, p, id, joined, peerNow); err != nil {
		restore()
		var pe *errPeer
		if asPeer(err, &pe) {
			return true, refusal(pe.code, pe.msg, map[string]any{"pid": c.pid})
		}
		return true, uncertain(fmt.Errorf("立即发送失败：%w", err))
	}
	q.mu.Lock()
	q.sending = false
	q.mu.Unlock()
	n.ensureOutsideDrain(id, q)
	n.notifySessions()
	return true, nil
}
