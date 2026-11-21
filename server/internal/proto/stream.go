package proto

// StreamIdentity ties optional Codex live text to its authoritative transcript.
// An empty text is a reset, not completion; only TurnDone closes the turn.
// Runtimes without this evidence omit all three fields.
type StreamIdentity struct {
	TurnID   string `json:"turn_id,omitempty"`
	ItemID   string `json:"item_id,omitempty"`
	TurnDone bool   `json:"turn_done,omitempty"`
}
