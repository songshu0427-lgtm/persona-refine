package node

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const agyDesktopRuntimeID = "antigravity-desktop"

// Desktop supervision is independent of the agy CLI. The companion only attaches to an existing desktop daemon;
// it validates the private descriptors itself and never launches the app or its language server.
var agyDesktopAvailable = func() bool {
	return agyDesktopAvailableAt(runtime.GOOS, userHome())
}

func agyDesktopAvailableAt(goos, home string) bool {
	return goos == "darwin" && dirExists(filepath.Join(home, ".gemini", "antigravity", "daemon"))
}

func (rh *RuntimeHost) setAgyDesktopBridge(on bool) {
	rh.agyDesktop.set(rh.ctx, on, rh.agyDesktopBridgeLoop)
}

var agyDesktopBridgeCommand = func(ctx context.Context, rh *RuntimeHost) (*exec.Cmd, error) {
	dir, err := rh.installAgyPackage()
	if err != nil {
		return nil, err
	}
	// Unlike the CLI's conversation database reader, the desktop bridge does not need node:sqlite.
	js, err := pickJSRuntime(ctx, agyJSCandidates(), nil)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(js.Path, filepath.Join(dir, "antigravity", "desktop.mjs"),
		"--socket", rh.path, "--parent-stdin")
	cmd.Env = js.env(append(os.Environ(), "PERSONA_RUNTIME_SOCKET="+rh.path))
	cmd.Dir = dir
	return cmd, nil
}

func (rh *RuntimeHost) agyDesktopBridgeLoop(ctx context.Context, done chan struct{}) {
	defer close(done)
	wait := agyBridgeRestartMin
	loggedMissingJS := false
	for ctx.Err() == nil {
		if !agyDesktopAvailable() || rh.agyCompanionConnected(agyDesktopRuntimeID) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(agyBridgeProbeEvery):
			}
			continue
		}
		started := time.Now()
		err := rh.runAgyDesktopBridge(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > agyBridgeSteady {
			wait = agyBridgeRestartMin
		}
		if err != nil {
			if strings.Contains(err.Error(), "Node.js") {
				if !loggedMissingJS {
					loggedMissingJS = true
					rh.logger.Printf("%s runtime: %v", agyDesktopRuntimeID, err)
				}
			} else {
				rh.logger.Printf("%s runtime: %v (again in %s)", agyDesktopRuntimeID, err, wait)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, agyBridgeRestartMax)
	}
}

func (rh *RuntimeHost) runAgyDesktopBridge(ctx context.Context) error {
	cmd, err := agyDesktopBridgeCommand(ctx, rh)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Package installation and Node probing may take time; an external bridge can connect while they run.
	if rh.agyCompanionConnected(agyDesktopRuntimeID) {
		return nil
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	defer stdin.Close()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	rh.logger.Printf("%s runtime: running (pid %d)", agyDesktopRuntimeID, cmd.Process.Pid)
	logged := make(chan struct{})
	go func() {
		defer close(logged)
		logLines(out, func(line string) {
			rh.logger.Printf("%s runtime: %s", agyDesktopRuntimeID, line)
		})
	}()
	exited := make(chan error, 1)
	go func() {
		<-logged
		exited <- cmd.Wait()
	}()
	select {
	case err := <-exited:
		return err
	case <-ctx.Done():
		// EOF is also delivered if the node dies. Never signal a process group or any daemon descriptor's PID:
		// only the bridge belongs to us, not the desktop app or its language server.
		_ = stdin.Close()
		select {
		case <-exited:
		case <-time.After(agyBridgeStopWait):
			_ = cmd.Process.Kill()
			_ = out.Close()
			<-exited
		}
		return ctx.Err()
	}
}
