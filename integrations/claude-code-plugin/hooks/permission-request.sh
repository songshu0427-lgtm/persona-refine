#!/bin/sh
# Bridges Claude Code PermissionRequest events outside Persona terminals to the local Persona node.
# Runs as a classic plugin command hook from hooks/hooks.json so Claude Desktop's built-in module guard
# (cc-plugin-sec-default) neither skips classic.* module hooks nor blocks remote mobile/web approvals.

home="${USERPROFILE:-$HOME}"
[ -n "$home" ] || exit 0

case "${PERSONA_HOME:-}" in
  "")
    persona_home="$home/.persona"
    ;;
  "~")
    persona_home="$home"
    ;;
  "~/"* | "~\\"*)
    persona_home="$home/${PERSONA_HOME#?[\\/]}"
    ;;
  /* | \\* | [A-Za-z]:[\\/]*)
    persona_home="$PERSONA_HOME"
    ;;
  *)
    persona_home="$home/$PERSONA_HOME"
    ;;
esac

for candidate in \
  "$persona_home/bin/persona-node" \
  "$persona_home/bin/persona-node.exe" \
  "$persona_home/bin/persona-link" \
  "$persona_home/bin/persona-link.exe" \
  "$persona_home/bin/personad" \
  "$persona_home/bin/personad.exe"
do
  if [ -x "$candidate" ]; then
    exec "$candidate" hook --persona-plugin-permission
  fi
done

for name in persona-node persona-link personad; do
  if bin="$(command -v "$name" 2>/dev/null)" && [ -n "$bin" ]; then
    exec "$bin" hook --persona-plugin-permission
  fi
done

exit 0
