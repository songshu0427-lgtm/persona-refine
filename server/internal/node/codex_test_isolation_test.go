package node

import "testing"

func TestCodexDefaultTestHarnessDoesNotDiscoverInstalledCLI(t *testing.T) {
	// Do not run this against the old harness: testing the guard must never invoke
	// installed-app discovery merely to demonstrate that it used to be reachable.
	if cli, err := codexAppCLI(); cli != "" || err == nil {
		t.Fatalf("test harness permits installed CLI discovery: %q, %v", cli, err)
	}
}
