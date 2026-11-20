package node

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"time"

	"github.com/nwverse/persona/server/internal/transcript"
)

// claudeHostStallWait is how long an unanswered Claude Desktop host-MCP call may stay open with status "busy" before
// the session is shown as waiting on a desktop confirmation card. Host MCP tools run inside the Electron host after
// Claude Code CLI has already cleared PreToolUse, so sessions/<pid>.json remains "busy" while the desktop confirmation
// card waits for a click.
var claudeHostStallWait = 8 * time.Second

// desktopHostStallReason reports why a busy Claude Desktop session is stalled on an unanswered host-MCP confirmation
// card, or "" when no open call looks like one.
func desktopHostStallReason(open []transcript.ToolCall, now time.Time) string {
	for i := len(open) - 1; i >= 0; i-- {
		call := open[i]
		if call.At.IsZero() || now.Sub(call.At) < claudeHostStallWait {
			continue
		}
		if label := desktopHostConfirmLabel(call.Name, call.Input); label != "" {
			return "等待电脑端确认：" + label
		}
	}
	return ""
}

func desktopHostConfirmLabel(name string, input json.RawMessage) string {
	var in map[string]any
	_ = json.Unmarshal(input, &in)
	str := func(k string) string {
		v, _ := in[k].(string)
		return strings.TrimSpace(v)
	}
	short := func(s string) string {
		r := []rune(strings.Join(strings.Fields(s), " "))
		if len(r) > 40 {
			return string(r[:40]) + "…"
		}
		return string(r)
	}
	withArg := func(prefix, arg string) string {
		if arg = short(arg); arg != "" {
			return prefix + " (" + arg + ")"
		}
		return prefix
	}

	switch name {
	case "mcp__Claude_Browser__preview_start":
		return withArg("启动预览服务", str("name"))
	case "mcp__ccd_directory__request_directory":
		if p := str("path"); p != "" {
			return withArg("授权访问目录", filepath.Base(p))
		}
		return "选择并授权目录"
	case "mcp__ccd_directory__change_directory":
		if p := str("path"); p != "" {
			return withArg("切换工作目录", filepath.Base(p))
		}
		return "切换工作目录"
	case "mcp__ccd_host__open_in_editor":
		if p := str("path"); p != "" {
			return withArg("在编辑器中打开文件", filepath.Base(p))
		}
		return "在编辑器中打开文件"
	case "mcp__ccd_host__reveal_path":
		if p := str("path"); p != "" {
			return withArg("在访达中显示路径", filepath.Base(p))
		}
		return "在访达中显示路径"
	case "mcp__ccd_host__request_keep_awake":
		return "保持电脑唤醒"
	case "mcp__ccd_host__clean_up_worktrees":
		return "清理旧工作树"
	case "mcp__ccd_host__discard_kept_worktree":
		return "丢弃保留的工作树"
	case "mcp__terminal__open_terminal_tab":
		return withArg("打开终端标签页", str("title"))
	case "mcp__terminal__run_in_terminal":
		return withArg("在终端运行命令", str("title"))
	case "mcp__ccd_session__start_session":
		return withArg("新建会话", str("title"))
	case "mcp__ccd_session_mgmt__archive_session":
		return "归档会话"
	case "mcp__ccd_session_mgmt__clear_session":
		return "清空会话"
	case "mcp__ccd_session_mgmt__delete_session":
		return "删除会话"
	case "mcp__ccd_session_mgmt__set_remote_control":
		return "切换远程控制"
	case "mcp__ccd_session_mgmt__set_session_effort":
		return "修改会话思考强度"
	case "mcp__ccd_session_mgmt__set_session_fast_mode":
		return "切换极速模式"
	case "mcp__ccd_session_mgmt__set_session_model":
		return "切换会话模型"
	case "mcp__ccd_session_mgmt__set_session_output_style":
		return "切换输出风格"
	case "mcp__ccd_session_mgmt__set_session_permission_mode":
		return "切换权限模式"
	case "mcp__ccd_session_mgmt__set_session_title":
		return "重命名会话"
	case "mcp__ccd_session_mgmt__stop_session":
		return "停止其他会话"
	case "mcp__ccd_session_mgmt__unarchive_session":
		return "恢复归档会话"
	case "mcp__ccd_pr__bind_pr", "mcp__ccd_pr__set_auto_merge", "mcp__ccd_pr__set_monitor", "mcp__ccd_pr__unbind_pr":
		return "确认 PR 操作"
	case "mcp__ccd_settings__set_setting":
		return withArg("修改客户端设置", str("key"))
	case "mcp__ccd_sidebar__delete_group", "mcp__ccd_sidebar__delete_section",
		"mcp__ccd_sidebar__rename_group", "mcp__ccd_sidebar__rename_section",
		"mcp__ccd_sidebar__move_sessions", "mcp__ccd_sidebar__mark_completed",
		"mcp__ccd_sidebar__set_pinned", "mcp__ccd_sidebar__set_unread":
		return "确认侧边栏操作"
	case "DesignSync":
		switch str("method") {
		case "create_project", "finalize_plan":
			return "确认设计系统同步"
		}
	}
	return ""
}
