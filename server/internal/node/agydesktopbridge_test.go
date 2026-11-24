package node

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/osproc"
)

func TestAgyDesktopAvailable(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".gemini", "antigravity", "daemon")
	if agyDesktopAvailableAt("darwin", home) {
		t.Fatal("available without a daemon directory")
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if agyDesktopAvailableAt("darwin", home) {
		t.Fatal("accepted a regular file as a daemon directory")
	}
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, goos := range []string{"darwin", "linux", "windows"} {
		if got := agyDesktopAvailableAt(goos, home); got != (goos == "darwin") {
			t.Errorf("available on %s = %v", goos, got)
		}
	}
}

// All supervised commands in these tests are inert shell fixtures, never an installed runtime or desktop app.
func fakeAgyDesktopBridge(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell script fixture")
	}
	marks := filepath.Join(t.TempDir(), "starts")
	oldAvailable, oldCmd, oldFind := agyDesktopAvailable, agyDesktopBridgeCommand, findAgyExecutable
	oldMin, oldMax, oldProbe, oldStop := agyBridgeRestartMin, agyBridgeRestartMax, agyBridgeProbeEvery, agyBridgeStopWait
	t.Cleanup(func() {
		agyDesktopAvailable, agyDesktopBridgeCommand, findAgyExecutable = oldAvailable, oldCmd, oldFind
		agyBridgeRestartMin, agyBridgeRestartMax, agyBridgeProbeEvery, agyBridgeStopWait = oldMin, oldMax, oldProbe, oldStop
	})
	agyBridgeRestartMin, agyBridgeRestartMax = 10*time.Millisecond, 30*time.Millisecond
	agyBridgeProbeEvery, agyBridgeStopWait = 10*time.Millisecond, 100*time.Millisecond
	agyDesktopAvailable = func() bool { return true }
	findAgyExecutable = func() string { return "" }
	agyDesktopBridgeCommand = func(context.Context, *RuntimeHost) (*exec.Cmd, error) {
		return exec.Command("/bin/sh", "-c", `printf 'started\n' >> "$1"; while IFS= read -r line; do :; done; printf 'stopped\n' >> "$1"`, "bridge", marks), nil
	}
	return marks
}

func TestAgyDesktopBridgeAutoCompanionsWithoutCLI(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("enabled=%v", enabled), func(t *testing.T) {
			marks := fakeAgyDesktopBridge(t)
			// Unix socket paths must be short on macOS.
			dir, err := os.MkdirTemp("/tmp", "agy-desktop-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(dir) })
			rh := NewRuntimeHost("test", filepath.Join(dir, "runtime.sock"))
			rh.logger = log.New(io.Discard, "", 0)
			if enabled {
				rh.EnableAutoCompanions()
			}
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(func() {
				cancel()
				rh.setAgyBridge(false)
				rh.setAgyDesktopBridge(false)
			})
			if err := rh.Listen(ctx); err != nil {
				t.Fatal(err)
			}
			if !enabled {
				if rh.agy.cancel != nil || rh.agyDesktop.cancel != nil || len(starts(marks)) != 0 {
					t.Fatal("test host enabled automatic companions without opt-in")
				}
				return
			}
			waitFor(t, "desktop companion started without CLI", func() bool { return len(starts(marks)) == 1 })
			// Listen's cancellation stops the bridge even without an explicit set(false).
			cancel()
			select {
			case <-rh.agyDesktop.done:
			case <-time.After(5 * time.Second):
				t.Fatal("desktop supervisor did not stop on host cancellation")
			}
			if got := starts(marks); len(got) != 2 || got[1] != "stopped" {
				t.Fatalf("desktop did not shut down through stdin EOF: %v", got)
			}
		})
	}
}

func TestAgyDesktopBridgeYieldsSeparatelyToExternalRuntime(t *testing.T) {
	marks := fakeAgyDesktopBridge(t)
	var probes atomic.Int32
	agyDesktopAvailable = func() bool { probes.Add(1); return true }
	cliMarks := filepath.Join(t.TempDir(), "cli-starts")
	oldCLI := agyBridgeCommand
	t.Cleanup(func() { agyBridgeCommand = oldCLI })
	findAgyExecutable = func() string { return "/fake/agy" }
	agyBridgeCommand = func(context.Context, *RuntimeHost, string) (*exec.Cmd, error) {
		return exec.Command("/bin/sh", "-c", `trap 'printf "stopped\n" >> "$1"; exit 0' TERM; printf 'started\n' >> "$1"; while :; do sleep 0.02; done`, "cli", cliMarks), nil
	}
	n, hub := runtimeNode(t)
	assistantHub(hub)
	hello := assistantRuntimeHello()
	hello["runtime"], hello["agent"], hello["launcher"] = agyDesktopRuntimeID, "agy", "agy-desktop"
	ext := dialRuntime(t, n, hello)
	rh := n.runtimeHost
	rh.setAgyBridge(true)
	rh.setAgyDesktopBridge(true)
	defer rh.setAgyBridge(false)
	defer rh.setAgyDesktopBridge(false)
	waitFor(t, "desktop probes while external runtime connected", func() bool { return probes.Load() >= 2 })
	waitFor(t, "CLI starts independently of external desktop", func() bool { return len(starts(cliMarks)) == 1 })
	if got := starts(marks); len(got) != 0 {
		t.Fatalf("duplicated external desktop runtime: %v", got)
	}
	_ = ext.conn.Close()
	waitFor(t, "desktop starts beside CLI after external leaves", func() bool { return len(starts(marks)) == 1 })
	rh.setAgyDesktopBridge(false)
	if got := starts(marks); len(got) != 2 || got[1] != "stopped" {
		t.Fatalf("desktop was not stopped: %v", got)
	}
	if got := starts(cliMarks); len(got) != 1 {
		t.Fatalf("stopping desktop affected CLI: %v", got)
	}
	rh.setAgyBridge(false)
	if got := starts(cliMarks); len(got) != 2 || got[1] != "stopped" {
		t.Fatalf("CLI was not stopped: %v", got)
	}
}

func TestAgyDesktopBridgeExternalRuntimeDuringPreparation(t *testing.T) {
	marks := fakeAgyDesktopBridge(t)
	command := agyDesktopBridgeCommand
	preparing, resume := make(chan struct{}), make(chan struct{})
	agyDesktopBridgeCommand = func(ctx context.Context, rh *RuntimeHost) (*exec.Cmd, error) {
		close(preparing)
		select {
		case <-resume:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return command(ctx, rh)
	}
	n, hub := runtimeNode(t)
	assistantHub(hub)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- n.runtimeHost.runAgyDesktopBridge(ctx) }()
	select {
	case <-preparing:
	case <-time.After(5 * time.Second):
		t.Fatal("desktop command preparation did not start")
	}
	hello := assistantRuntimeHello()
	hello["runtime"], hello["agent"], hello["launcher"] = agyDesktopRuntimeID, "agy", "agy-desktop"
	dialRuntime(t, n, hello)
	close(resume)
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bridge started despite external runtime connecting during preparation")
	}
	if got := starts(marks); len(got) != 0 {
		t.Fatalf("duplicated external desktop runtime: %v", got)
	}
}

func TestAgyDesktopBridgeRestartsOnExit(t *testing.T) {
	marks := fakeAgyDesktopBridge(t)
	agyDesktopBridgeCommand = func(context.Context, *RuntimeHost) (*exec.Cmd, error) {
		return exec.Command("/bin/sh", "-c", `printf 'started\n' >> "$1"; exit 1`, "bridge", marks), nil
	}
	n, _ := runtimeNode(t)
	rh := n.runtimeHost
	rh.setAgyDesktopBridge(true)
	defer rh.setAgyDesktopBridge(false)
	waitFor(t, "desktop bridge restarts after exit", func() bool { return len(starts(marks)) >= 3 })
	rh.setAgyDesktopBridge(false)
	select {
	case <-rh.agyDesktop.done:
	default:
		t.Fatal("stop returned before supervisor exited")
	}
}

func TestAgyDesktopBridgeCancellationKillsOnlyBridge(t *testing.T) {
	marks := fakeAgyDesktopBridge(t)
	childPath := filepath.Join(t.TempDir(), "child")
	agyDesktopBridgeCommand = func(context.Context, *RuntimeHost) (*exec.Cmd, error) {
		// A fake app in the bridge's process group must survive even when the bridge ignores stdin EOF.
		cmd := exec.Command("/bin/sh", "-c", `/bin/sleep 300 </dev/null >/dev/null 2>&1 & child=$!; printf '%s\n' "$child" > "$2"; printf 'started\n' >> "$1"; wait "$child"`, "bridge", marks, childPath)
		cmd.SysProcAttr = osproc.GroupAttr()
		return cmd, nil
	}
	n, _ := runtimeNode(t)
	rh := n.runtimeHost
	rh.setAgyDesktopBridge(true)
	defer rh.setAgyDesktopBridge(false)
	defer func() {
		if ids := starts(childPath); len(ids) == 1 {
			pid, _ := strconv.Atoi(ids[0])
			if pid > 0 {
				_ = osproc.Kill(pid)
			}
		}
	}()
	waitFor(t, "uncooperative bridge starts", func() bool { return len(starts(marks)) == 1 })
	ids := starts(childPath)
	if len(ids) != 1 {
		t.Fatalf("missing fake app PID: %v", ids)
	}
	pid, err := strconv.Atoi(ids[0])
	if err != nil || pid <= 0 {
		t.Fatalf("bad fake app PID: %v", ids)
	}
	rh.setAgyDesktopBridge(false)
	if !osproc.Alive(pid) {
		t.Fatal("desktop bridge cancellation killed the fake app")
	}
}
