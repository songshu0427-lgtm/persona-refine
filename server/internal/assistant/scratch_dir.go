package assistant

import (
	"context"
	"path"
	"strings"
	"time"

	"github.com/nwverse/persona/server/internal/compat"
	"github.com/nwverse/persona/server/internal/proto"
)

const (
	scratchRelDir = ".persona/scratch"
	scratchNote   = "# Scratch Workspace\n\nTemporary non-repository working directory managed by Persona. Keep scratch artifacts inside this folder rather than the user's home directory.\n"
)

func cleanSlashPath(p string) string {
	p = strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
	if p == "" {
		return ""
	}
	if len(p) >= 2 && p[1] == ':' {
		drive := strings.ToLower(p[:2])
		rest := path.Clean("/" + strings.TrimLeft(p[2:], "/"))
		if rest == "/" {
			return drive + "/"
		}
		return drive + rest
	}
	return path.Clean(p)
}

// isBareHomeCwd reports whether cwd is omitted/empty, a bare tilde (~ or ~/), or resolves directly to m's home root
// (either Home or HomeReal). Non-repository tasks and bare-home placements redirect into ~/.persona/scratch/<id> so
// Agent sessions never clutter the user's top-level home directory.
func isBareHomeCwd(cwd string, m Device) bool {
	raw := strings.TrimSpace(cwd)
	if raw == "" || raw == "~" || raw == "~/" || raw == `~\` {
		return true
	}
	expanded := cleanSlashPath(proto.ExpandHome(raw, m.Home))
	if expanded == "" || expanded == "." {
		return true
	}
	for _, home := range []string{m.Home, m.HomeReal} {
		h := cleanSlashPath(home)
		if h != "" && h != "/" && strings.EqualFold(expanded, h) {
			return true
		}
	}
	return false
}

// scratchDirFor returns the hidden scratch directory for sub on m (~/.persona/scratch/<sub>, or <DataDir>/scratch/<sub>
// when PERSONA_HOME moved the state directory elsewhere).
func scratchDirFor(m Device, sub string) string {
	sub = strings.Trim(cleanSlashPath(sub), "/")
	if sub == "" || sub == "." {
		sub = "work_" + randomHex(8)
	}
	homeClean := cleanSlashPath(m.Home)
	if data := strings.TrimSpace(m.DataDir); data != "" {
		dataClean := cleanSlashPath(data)
		if dataClean != "" && dataClean != "/" && !strings.EqualFold(dataClean, homeClean) {
			if strings.Contains(data, "\\") {
				return strings.TrimRight(data, `\/`) + `\scratch\` + strings.ReplaceAll(sub, "/", `\`)
			}
			return path.Join(dataClean, "scratch", sub)
		}
	}
	if home := strings.TrimSpace(m.Home); home != "" {
		if strings.Contains(home, "\\") {
			return strings.TrimRight(home, `\/`) + `\.persona\scratch\` + strings.ReplaceAll(sub, "/", `\`)
		}
		return path.Join(homeClean, scratchRelDir, sub)
	}
	return path.Join("/tmp", scratchRelDir, sub)
}

// scratchSubpath returns the subpath inside ~/.persona/scratch (for example "todo_abc123") when cwd is inside m's
// scratch directory, or ("", false) otherwise.
func scratchSubpath(cwd string, m Device) (string, bool) {
	p := cleanSlashPath(proto.ExpandHome(cwd, m.Home))
	if p == "" {
		return "", false
	}
	prefixes := make([]string, 0, 6)
	for _, home := range []string{m.Home, m.HomeReal} {
		if h := cleanSlashPath(home); h != "" && h != "/" {
			prefixes = append(prefixes, path.Join(h, scratchRelDir))
			if compat.StateDir != "" && compat.StateDir != ".persona" {
				prefixes = append(prefixes, path.Join(h, compat.StateDir, "scratch"))
			}
		}
	}
	if data := cleanSlashPath(m.DataDir); data != "" && data != "/" {
		prefixes = append(prefixes, path.Join(data, "scratch"))
	}
	prefixes = append(prefixes, path.Join("/tmp", scratchRelDir))
	lower := strings.ToLower(p)
	for _, pref := range prefixes {
		lp := strings.ToLower(pref)
		if lower == lp {
			return "", true
		}
		if strings.HasPrefix(lower, lp+"/") {
			sub := strings.Trim(p[len(pref)+1:], "/")
			if sub != "" && !strings.Contains(sub, "..") {
				return sub, true
			}
		}
	}
	return "", false
}

func isScratchDir(cwd string, m Device) bool {
	_, ok := scratchSubpath(cwd, m)
	return ok
}

// ensureScratchDir ensures cwd exists on m before session.start runs. Updated nodes also MkdirAll inside checkStart,
// while assistant.guest_prepare works on both current and older nodes by creating stateRoot/scratch/<sub> on disk.
func (s *Service) ensureScratchDir(ctx context.Context, m Device, cwd string) (string, error) {
	sub, ok := scratchSubpath(cwd, m)
	if !ok || sub == "" {
		return cwd, nil
	}
	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var prepared struct {
		Cwd string `json:"cwd"`
	}
	rel := path.Join(scratchRelDir, sub)
	if err := s.call(pctx, m.ID, DeviceAssistantGuestPrepare, map[string]any{"dir": rel, "claude_md": scratchNote}, &prepared); err == nil && prepared.Cwd != "" && isScratchDir(prepared.Cwd, m) {
		return prepared.Cwd, nil
	}
	return cwd, nil
}
