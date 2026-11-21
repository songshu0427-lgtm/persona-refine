package hub

import (
	"context"
	"encoding/json"
	"time"
)

// A planned stop (systemctl restart, a deploy, an update: SIGTERM) that the apps should not notice
// (docs/operations/hub-restart.md): before anything is torn down, every app hears hub_restarting — it reconnects at once and
// keeps its screen as it is — and the machines as they are now are handed to the next hub (warm.go). What the stop
// itself causes afterwards (nodes disconnecting, their questions ending) is not broadcast (stopping). The event log
// is handed over last, once nothing more can be broadcast (saveEventLog).

// restartBackIn is what hub_restarting tells the apps to expect: how long a restart takes, roughly (they show nothing
// for a while longer than that).
const restartBackIn = 3 * time.Second

const terminalDeltaCacheMax = 256

// beginStop runs once, when the stop is asked for, before the hub's context ends.
func (h *Hub) beginStop() {
	if h.stopping.Swap(true) {
		return
	}
	b, _ := json.Marshal(map[string]any{"type": "hub_restarting", "back_in_ms": restartBackIn.Milliseconds()})
	h.mu.Lock()
	clients := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		c.queue(b)
		clients = append(clients, c)
	}
	h.mu.Unlock()
	// Let it reach them before the close frame does (stopWebSockets), briefly: a suspended phone never reads it.
	for deadline := time.Now().Add(300 * time.Millisecond); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		pending := false
		for _, c := range clients {
			if len(c.out) > 0 {
				pending = true
				break
			}
		}
		if !pending {
			break
		}
	}
	// The machines as the managers report them, for the next hub process (devices_warm.go); each manager hands its
	// own to its next process apart (internal/devices warm.go). A Store call already under way may finish after the
	// deadline, but the stop caller does not wait for it and no new machine-entries write starts after it.
	h.shutdown.step(h, "machine handover", func(ctx context.Context) error {
		h.saveDevicesWarm(ctx)
		h.saveMachineEntries(ctx) // and what each one has, each machine last seen as of now (machine_entries.go)
		return nil
	})
}

// rememberLiveText keeps a session's message being generated (session.delta: the whole text so far, "" once it is in
// the transcript), for clients that subscribe in the middle of it: one reconnecting after a restart, whose node
// sends the text again when it connects (node: resumeAssistants), sees the answer go on where it was.
func (h *Hub) rememberLiveText(machineID, sessionID, text string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.rememberDeltaLocked(deltaPush{Type: "delta", MachineID: machineID, SessionID: sessionID, Text: text})
}

// Remember and forward in one order relative to subscription replay. Keep an
// identity-bearing reset/end too: an empty text alone does not close a Codex turn.
func (h *Hub) forwardLiveText(p deltaPush) {
	if h.conversationDeleted(p.MachineID, p.SessionID) {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.rememberDeltaLocked(p)
	h.toSubscribersLocked(p.MachineID, p.SessionID, "", p)
}

func (h *Hub) rememberDeltaLocked(p deltaPush) {
	key := [2]string{p.MachineID, p.SessionID}
	if p.Text == "" && p.TurnID == "" && p.ItemID == "" && !p.TurnDone {
		delete(h.deltas, key)
		return
	}
	if h.deltas == nil {
		h.deltas = map[[2]string]deltaPush{}
	}
	if p.TurnDone {
		h.deltaOrder++
		p.cacheOrder = h.deltaOrder
	}
	h.deltas[key] = p
	if p.TurnDone {
		// Only terminal transitions scan this bounded tail, never streaming tokens.
		count, oldest := 0, key
		for k, d := range h.deltas {
			if d.TurnDone {
				count++
				if d.cacheOrder < h.deltas[oldest].cacheOrder {
					oldest = k
				}
			}
		}
		if count > terminalDeltaCacheMax {
			delete(h.deltas, oldest)
		}
	}
}

// sendLiveText follows a subscription's backlog with the session's live text, if a message is being generated. Queued
// under h.mu, as the deltas forwarded to subscribers are (toSubscribersWith): a clear forwarded between the read and the
// queue reached the client before the text it cleared, which then stayed (#1966).
func (h *Hub) sendLiveText(c *client, machineID, sessionID string) {
	if h.conversationDeleted(machineID, sessionID) {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if p, ok := h.deltas[[2]string{machineID, sessionID}]; ok {
		c.sendJSON(p)
	}
}

func (h *Hub) forgetLiveText(machineID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, p := range h.deltas {
		if k[0] == machineID {
			delete(h.deltas, k)
			// Disconnecting neither completes a live turn nor reopens a known end.
			p.Text = ""
			h.toSubscribersLocked(k[0], k[1], "", p)
		}
	}
}
