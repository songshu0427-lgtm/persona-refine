package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

const spawnedTodoMost = 2 // active spawned sessions allowed on one supervised to-do

// taskSpawn keeps a separate coding session on its caller's task. Unlike a leader's task_plan, it creates no task,
// role or supervision level. The node supplies the caller; none of those identities come from tool arguments.
func (s *Service) taskSpawn(ctx context.Context, machine, session string, args json.RawMessage) (string, error) {
	var a struct {
		Title  string `json:"title"`
		Prompt string `json:"prompt"`
	}
	dec := json.NewDecoder(bytes.NewReader(args))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&a); err != nil {
		return "", fmt.Errorf("task_spawn arguments: %w", err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return "", errors.New("task_spawn expects one JSON object")
	}
	a.Title, a.Prompt = strings.TrimSpace(a.Title), strings.TrimSpace(a.Prompt)
	if a.Title == "" || a.Prompt == "" {
		return "", errors.New("task_spawn requires title and prompt; nothing was started")
	}
	machine = s.canonical(machine)
	t, _, err := s.spawnCaller(ctx, machine, session)
	if err != nil {
		return "", err
	}
	parent, ok := s.session(ctx, machine, session)
	if !ok || parent.Assistant || parent.Cwd == "" || parent.Launcher == "" {
		return "", errors.New("Persona cannot verify this Agent's directory and launcher; ask your supervisor, nothing was started")
	}
	if err := s.spawnGate(ctx, t, parent.Cwd); err != nil {
		return "", err
	}
	// Unknown permission is read-only, never the owner's writable default. Codex does not expose PermissionMode, so
	// the persisted assignment supplies it when this is that assignment's original Agent.
	mode := parent.PermissionMode
	var assignment *PlanTask
	if p, i, err := s.currentPlanAssignment(ctx, t); err == nil && p.Tasks[i].Machine == machine {
		assignment = &p.Tasks[i]
	}
	if mode == "" {
		mode = "plan"
		if assignment != nil && assignment.Permission != "" {
			mode = assignment.Permission
		}
	}
	child := PlanTask{TodoID: t.ID, Title: a.Title, Prompt: a.Prompt, Machine: machine, Cwd: parent.Cwd,
		Launcher: parent.Launcher, Model: s.taskSpawnModel(ctx, parent, assignment), Effort: parent.Effort,
		Permission: mode, Readonly: mode == "plan", preservePermission: true, spawnedChild: true}
	// A caller disconnecting must not abandon a start before its ownership is recorded.
	startCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Minute)
	defer cancel()
	mid, sid, err := s.startTaskAgent(startCtx, &child, false)
	// This path is not wrapped by runPlanTaskStart, so release the gate's claim itself once the child is linked or the
	// start has failed for good (by then the ledger carries the linked agent, or nothing runs).
	if child.admissionRelease != nil {
		defer child.admissionRelease()
	}
	if err != nil {
		return "", fmt.Errorf("task_spawn: %w; do not retry an uncertain start, ask your supervisor", err)
	}
	current, _, callerErr := s.spawnCaller(startCtx, machine, session)
	if callerErr != nil || current.ID != t.ID {
		err = errors.New("the caller's task changed or closed during the start")
	} else {
		err = s.linkTodoAgentWithSource(startCtx, t.ID, mid, sid, a.Title, child.Cwd, "", "", sourceSpawned, machine+"/"+session)
	}
	if err != nil {
		stopCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer stop()
		stopErr := s.call(stopCtx, mid, deviceSessionStop, map[string]any{"session_id": sid}, nil)
		return "", fmt.Errorf("child %s/%s was not linked: %w; stop result: %v; tell your supervisor", mid, sid, err, stopErr)
	}
	t, ok = s.ensureSupervisor(startCtx, t.ID)
	if !ok {
		return "", fmt.Errorf("child %s/%s was linked, but the task closed or lost its supervisor; tell your supervisor", mid, sid)
	}
	out, _ := json.Marshal(map[string]string{"machine_id": mid, "session_id": sid, "todo_id": t.ID,
		"supervisor": t.Supervision.Supervisor, "parent": machine + "/" + session})
	return string(out), nil
}

// taskSpawnModel uses the original assignment's model only while its Agent remains on the assignment's launcher;
// an empty assignment launcher means the start default. Every other caller keeps the parent's model unchanged (#10557).
func (s *Service) taskSpawnModel(ctx context.Context, parent proto.Session, assignment *PlanTask) string {
	if assignment != nil && assignment.Model != "" && s.startLauncher(ctx, assignment.Launcher) == parent.Launcher {
		return assignment.Model
	}
	return parent.Model
}

func (s *Service) spawnTask(ctx context.Context, machine, session string) (Todo, bool) {
	t, ok := s.taskOf(ctx, machine, session)
	return t, session != "" && ok && !t.Cancelled() && t.Supervision != nil && t.Supervision.Supervisor != ""
}

// spawnCaller verifies that machine/session is a top-level assigned Agent ("manual" or "leader") on an open supervised
// task. Already-spawned children (depth limit 1), a task leader's leaf workers, and review/space links are refused.
func (s *Service) spawnCaller(ctx context.Context, machine, session string) (Todo, TodoAgent, error) {
	t, ok := s.spawnTask(ctx, machine, session)
	if !ok {
		return Todo{}, TodoAgent{}, errors.New("task_spawn requires an active Agent on an open supervised task; ask your supervisor to assign one")
	}
	for _, agent := range t.Agents {
		if agent.MachineID == machine && agent.SessionID == session && agent.active() {
			switch agent.Source {
			case "manual", sourceLeader:
				return t, agent, nil
			case sourceSpawned:
				return Todo{}, TodoAgent{}, errors.New("task_spawn is not available in an already-spawned session (depth limit 1): finish your assigned part here and report to your supervisor, or use bounded in-session subagents; nothing was started")
			case sourceWorker:
				return Todo{}, TodoAgent{}, errors.New("task_spawn is not available to a task leader's worker: do this work yourself (bounded in-session subagents are fine) or report to your leader via report_to_supervisor; nothing was started")
			default:
				return Todo{}, TodoAgent{}, errors.New("task_spawn requires the task's directly assigned Agent; ask your supervisor to assign one")
			}
		}
	}
	return Todo{}, TodoAgent{}, errors.New("task_spawn requires an active Agent on an open supervised task; ask your supervisor to assign one")
}

// spawnGate enforces per-todo spawned session count and prevents concurrent active spawned children in the same checkout.
func (s *Service) spawnGate(ctx context.Context, t Todo, cwd string) error {
	spawned := 0
	for _, agent := range t.Agents {
		if !agent.active() || agent.Source != sourceSpawned {
			continue
		}
		spawned++
		if live, ok := s.session(ctx, agent.MachineID, agent.SessionID); ok && !live.Archived &&
			(live.Status == proto.StatusWorking || live.Status == proto.StatusBlocked) {
			return fmt.Errorf("task_spawn refused: spawned session %s/%s is already working in %s on task %s; leave its files alone and finish your part without spawning concurrently",
				agent.MachineID, agent.SessionID, cwd, t.ID)
		}
	}
	if spawned >= spawnedTodoMost {
		return fmt.Errorf("task_spawn limit reached (%d spawned sessions on task %s): finish the remaining part yourself or ask your supervisor to plan workers with a task leader; nothing was started",
			spawnedTodoMost, t.ID)
	}
	return nil
}

func (s *Service) spawnTools(ctx context.Context, machine, session string) []proto.Tool {
	machine = s.canonical(machine)
	t, _, err := s.spawnCaller(ctx, machine, session)
	if err != nil {
		return nil
	}
	cwd := ""
	if parent, ok := s.session(ctx, machine, session); ok {
		cwd = parent.Cwd
	}
	if s.spawnGate(ctx, t, cwd) != nil {
		return nil
	}
	return toolsNamed([]string{"task_spawn"})
}
