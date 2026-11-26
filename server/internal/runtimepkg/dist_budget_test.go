package runtimepkg

import (
	"os"
	"testing"
)

// TestDistBudget bounds what personad, persona-node and persona-manager embed of the runtime packages: every file
// Generate writes from integrations/. Measured 161,129 B on 2026-11-17 for the DSH, pi, Antigravity and Paseo runtimes
// and the Claude Code plugin (#9799); raised for main's later Antigravity / runtime-sdk updates and the Claude Code
// plugin's session model/effort overrides, mid-turn owner input queueing, owner turn interrupts, bypass preview pre-start,
// and remote permission bridge (173,207 B on 2026-11-20), plus the Antigravity Desktop bridge, model switching,
// image support, subagent hierarchy folding, ConversationService lifecycle (#16012), and incremental transcript
// caching (#12250) (189,479 B on 2026-11-26, with ~2,500 B of headroom). Raise it only for code a runtime needs,
// never to embed the packages raw again.
func TestDistBudget(t *testing.T) {
	const budget = 192_000
	_, out := generateIntegrations(t)
	entries, err := os.ReadDir(out)
	if err != nil {
		t.Fatal(err)
	}
	size := int64(0)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().IsRegular() {
			size += info.Size()
		}
	}
	if size > budget {
		t.Fatalf("generated runtime packages are %d bytes, over the budget of %d", size, budget)
	}
	t.Logf("generated runtime packages: %d bytes (budget %d)", size, budget)
}
