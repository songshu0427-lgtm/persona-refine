package node

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

func TestRuntimeUsageWindows(t *testing.T) {
	n := &Node{home: t.TempDir(), dir: t.TempDir(), runtimes: newRuntimeRegistry()}
	h := n.runtimes.add(nil)
	h.ready = true
	h.hello.Runtime = "antigravity-desktop"
	host := &RuntimeHost{reg: n.runtimes, node: n}
	now := time.Now().UTC().Truncate(time.Second)
	resets := now.Add(5 * time.Hour)
	account := func(used float64) proto.UsageAccount {
		return proto.UsageAccount{
			Provider: "agy", Name: "Antigravity", SampledAt: now.Add(-time.Minute),
			Windows: []proto.UsageWindow{
				{Label: "7d", WindowMinutes: 10080, UsedPercent: 75, Model: "Gemini Models"},
				{Label: "5h", WindowMinutes: 300, UsedPercent: used, ResetsAt: &resets, Model: "Gemini Models"},
			},
		}
	}
	push := func(value any) {
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		host.event(h, "usage.windows", body)
	}

	push(account(125))
	snap := n.usageSnapshot(false)
	if !snap.Enabled || len(snap.Accounts) != 1 {
		t.Fatalf("runtime account missing: %+v", snap)
	}
	got := snap.Accounts[0]
	if got.Provider != "agy" || got.Name != "Antigravity" || len(got.Windows) != 2 {
		t.Fatalf("runtime account: %+v", got)
	}
	if got.Windows[0].Label != "5h" || got.Windows[0].UsedPercent != 100 || got.Windows[1].Label != "7d" {
		t.Errorf("normalized windows: %+v", got.Windows)
	}

	// Reconnected runtime replaces its own source rather than duplicating.
	reconnected := n.runtimes.add(nil)
	reconnected.ready = true
	reconnected.hello.Runtime = "antigravity-desktop"
	body, _ := json.Marshal(account(40))
	host.event(reconnected, "usage.windows", body)
	if snap = n.usageSnapshot(false); len(snap.Accounts) != 1 || snap.Accounts[0].Windows[0].UsedPercent != 40 {
		t.Fatalf("reconnect duplicated or did not replace the source: %+v", snap.Accounts)
	}

	// Daemon reports are ignored (neither overwrite nor clear).
	daemon := n.runtimes.add(nil)
	daemon.ready = true
	daemon.daemon = "remote"
	daemon.hello.Runtime = "antigravity-desktop"
	body, _ = json.Marshal(account(90))
	host.event(daemon, "usage.windows", body)
	if snap = n.usageSnapshot(false); len(snap.Accounts) != 1 || snap.Accounts[0].Windows[0].UsedPercent != 40 {
		t.Fatalf("daemon report replaced local account: %+v", snap.Accounts)
	}
	body, _ = json.Marshal(proto.UsageAccount{Provider: "agy", Name: "Antigravity", SampledAt: now, Windows: []proto.UsageWindow{}})
	host.event(daemon, "usage.windows", body)
	if snap = n.usageSnapshot(false); len(snap.Accounts) != 1 || snap.Accounts[0].Windows[0].UsedPercent != 40 {
		t.Fatalf("daemon empty report cleared local account: %+v", snap.Accounts)
	}

	// Invalid and malformed payloads preserve the existing good sample.
	for _, invalid := range []proto.UsageAccount{
		{Provider: "", Name: "Antigravity", SampledAt: now, Windows: account(90).Windows},
		{Provider: "agy", Name: "Antigravity", SampledAt: now.Add(-4 * 24 * time.Hour), Windows: account(90).Windows},
		{Provider: "agy", Name: "Antigravity", SampledAt: now.Add(time.Hour), Windows: account(90).Windows},
		{Provider: "agy", Name: "Antigravity", SampledAt: now, Windows: []proto.UsageWindow{{Label: "5h", UsedPercent: 90}}},
		{Provider: "agy", Name: "Antigravity", SampledAt: now, Windows: nil},
	} {
		push(invalid)
		if snap = n.usageSnapshot(false); len(snap.Accounts) != 1 || snap.Accounts[0].Windows[0].UsedPercent != 40 {
			t.Fatalf("invalid report replaced good sample: %+v", snap.Accounts)
		}
	}
	host.event(h, "usage.windows", json.RawMessage(`{"provider":`))
	missing, _ := json.Marshal(map[string]any{"provider": "agy", "name": "Antigravity", "sampled_at": now.Format(time.RFC3339)})
	host.event(h, "usage.windows", missing)
	for _, window := range []map[string]any{
		{"window_minutes": 300},
		{"window_minutes": 300, "used_percent": nil},
	} {
		malformed, _ := json.Marshal(map[string]any{
			"provider": "agy", "name": "Antigravity", "sampled_at": now.Format(time.RFC3339),
			"windows": []any{window},
		})
		host.event(h, "usage.windows", malformed)
	}
	if snap = n.usageSnapshot(false); len(snap.Accounts) != 1 || snap.Accounts[0].Windows[0].UsedPercent != 40 {
		t.Fatalf("malformed payloads altered good sample: %+v", snap.Accounts)
	}

	// An explicit empty windows list clears the runtime's entry.
	push(proto.UsageAccount{Provider: "agy", Name: "Antigravity", SampledAt: now, Windows: []proto.UsageWindow{}})
	if snap = n.usageSnapshot(false); len(snap.Accounts) != 0 {
		t.Fatalf("empty windows did not clear sample: %+v", snap.Accounts)
	}

	// Off switch prevents storing samples.
	n.setUsageWindows(false)
	push(account(25))
	if snap = n.usageSnapshot(false); snap.Enabled || len(snap.Accounts) != 0 {
		t.Fatalf("off switch stored sample: %+v", snap)
	}
}
