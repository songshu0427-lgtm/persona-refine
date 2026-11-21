package node

import (
	"slices"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

// This fences replayed starts, not history: retired completions/deltas are also
// rejected by their mismatch with the current identity regardless of age.
const codexStreamRememberTurns = 64

// acceptStreamEvent rejects known retired turns/items before they can change
// busy/recovery state or the live text. notifyMu serializes notifications. Older
// app-servers with absent IDs retain their existing behavior without invented IDs.
func (c *codexConn) acceptStreamEvent(method, turn, item, kind string) bool {
	c.p.mu.Lock()
	current := c.p.partialIdentity
	c.p.mu.Unlock()
	if current.TurnID == "" {
		current.TurnID = c.turn()
	}
	if method == "turn/started" {
		if turn != "" && slices.Contains(c.streamTurns, turn) {
			return false
		}
		if turn != "" {
			if len(c.streamTurns) == codexStreamRememberTurns {
				copy(c.streamTurns, c.streamTurns[1:])
				c.streamTurns[len(c.streamTurns)-1] = turn
			} else {
				c.streamTurns = append(c.streamTurns, turn)
			}
		}
		c.streamItems, c.streamItemDone = nil, false
		return true
	}
	if turn != "" && current.TurnID != "" && turn != current.TurnID {
		return false
	}
	if (method == "item/started" || method == "item/completed") && kind != "agentMessage" {
		return true // background tools and manual compaction may finish after a turn
	}
	if current.TurnDone {
		return false
	}
	if kind != "agentMessage" && method != "item/agentMessage/delta" {
		return true
	}
	if method == "item/started" {
		if item != "" && c.streamItems[item] {
			return false
		}
		if c.streamItems == nil {
			c.streamItems = map[string]bool{}
		}
		if item != "" {
			c.streamItems[item] = true
		}
		c.streamItemDone = false
		return true
	}
	if item != "" && current.ItemID != "" && item != current.ItemID {
		return false
	}
	if c.streamItemDone {
		return false
	}
	if method == "item/completed" {
		c.streamItemDone = true
	}
	return true
}

func (c *codexConn) streamIdentity(turn, item string) proto.StreamIdentity {
	c.p.mu.Lock()
	identity := c.p.partialIdentity
	c.p.mu.Unlock()
	identity.TurnID = firstNonEmpty(turn, identity.TurnID, c.turn())
	identity.ItemID = firstNonEmpty(item, identity.ItemID)
	return identity
}

// codexPartial changes text and identity atomically with respect to timer sends.
// reset/final sends are explicit, even for empty text; a final replaces the
// partial buffer too, so neither a trailing timer nor reconnect revives its draft.
func (n *Node) codexPartial(p *assistantProc, identity proto.StreamIdentity, text string, appendText bool) {
	n.deltaMu.Lock()
	defer n.deltaMu.Unlock()
	p.mu.Lock()
	if appendText {
		p.partialIdentity = identity
		p.partial.WriteString(text)
		text = n.partialGrewLocked(p)
	} else {
		p.partial.Reset()
		p.partial.WriteString(text)
		p.partialIdentity = identity
		p.deltaSent = text
		p.lastDelta = time.Time{}
	}
	identity = p.partialIdentity
	p.lastActive = time.Now()
	p.mu.Unlock()
	if !appendText || text != "" {
		n.notifyDelta(p.id, text, identity)
	}
}

func (n *Node) replayCodexPartial(p *assistantProc) {
	n.deltaMu.Lock()
	defer n.deltaMu.Unlock()
	p.mu.Lock()
	text, identity := p.partial.String(), p.partialIdentity
	busy := p.busy
	p.mu.Unlock()
	if busy || identity.TurnDone {
		n.notifyDelta(p.id, text, identity)
	}
}

// A recovery finishing after an exit may run after the process was replaced.
// Only Codex uses this identity-bearing clear; other runtimes keep their contract.
func (n *Node) clearCodexPartial(p *assistantProc) {
	n.deltaMu.Lock()
	defer n.deltaMu.Unlock()
	n.mu.Lock()
	current := n.procs[p.id]
	n.mu.Unlock()
	p.mu.Lock()
	p.partial.Reset()
	p.deltaSent = ""
	identity := p.partialIdentity
	p.mu.Unlock()
	if current == nil || current == p {
		n.notifyDelta(p.id, "", identity)
	}
}
