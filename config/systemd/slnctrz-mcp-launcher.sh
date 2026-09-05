#!/bin/sh
set -eu

install_root=${SLNCTRZ_INSTALL_ROOT:-/opt/slnctrz-mcp}
activation="$install_root/current.json"

if [ -n "${SLNCTRZ_CONFIG_FILE:-}" ]; then
  if [ ! -f "$SLNCTRZ_CONFIG_FILE" ] || [ -L "$SLNCTRZ_CONFIG_FILE" ]; then
    echo "slnctrz-mcp launcher: configured environment file is missing or unsafe" >&2
    exit 70
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) ;;
      SLNCTRZ_HOST=*) SLNCTRZ_HOST=${line#*=}; export SLNCTRZ_HOST ;;
      SLNCTRZ_PORT=*) SLNCTRZ_PORT=${line#*=}; export SLNCTRZ_PORT ;;
      SLNCTRZ_PUBLIC_URL=*) SLNCTRZ_PUBLIC_URL=${line#*=}; export SLNCTRZ_PUBLIC_URL ;;
      SLNCTRZ_OWNER_WEB_ENABLED=*) SLNCTRZ_OWNER_WEB_ENABLED=${line#*=}; export SLNCTRZ_OWNER_WEB_ENABLED ;;
      SLNCTRZ_MAX_DYNAMIC_CLIENTS=*) SLNCTRZ_MAX_DYNAMIC_CLIENTS=${line#*=}; export SLNCTRZ_MAX_DYNAMIC_CLIENTS ;;
      SLNCTRZ_CONTROL_HOST=*) SLNCTRZ_CONTROL_HOST=${line#*=}; export SLNCTRZ_CONTROL_HOST ;;
      SLNCTRZ_CONTROL_PORT=*) SLNCTRZ_CONTROL_PORT=${line#*=}; export SLNCTRZ_CONTROL_PORT ;;
      SLNCTRZ_TELEMETRY_ENABLED=*) SLNCTRZ_TELEMETRY_ENABLED=${line#*=}; export SLNCTRZ_TELEMETRY_ENABLED ;;
      SLNCTRZ_ALLOWED_HOSTS=*) SLNCTRZ_ALLOWED_HOSTS=${line#*=}; export SLNCTRZ_ALLOWED_HOSTS ;;
      SLNCTRZ_ALLOWED_ORIGINS=*) SLNCTRZ_ALLOWED_ORIGINS=${line#*=}; export SLNCTRZ_ALLOWED_ORIGINS ;;
      SLNCTRZ_STATE_ROOT=*) SLNCTRZ_STATE_ROOT=${line#*=}; export SLNCTRZ_STATE_ROOT ;;
      SLNCTRZ_POLICY_FILE=*) SLNCTRZ_POLICY_FILE=${line#*=}; export SLNCTRZ_POLICY_FILE ;;
      *) echo "slnctrz-mcp launcher: unsupported config key" >&2; exit 70 ;;
    esac
  done < "$SLNCTRZ_CONFIG_FILE"
fi

if [ ! -f "$activation" ] || [ -L "$activation" ]; then
  echo "slnctrz-mcp launcher: current.json is missing or unsafe" >&2
  exit 70
fi

record=$(cat "$activation")
version=$(printf '%s\n' "$record" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
file_name=$(printf '%s\n' "$record" | sed -n 's/.*"fileName":"\([^"]*\)".*/\1/p')

if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)([-+][0-9A-Za-z.+-]+)?$'; then
  echo "slnctrz-mcp launcher: activation version is invalid" >&2
  exit 70
fi
if ! printf '%s\n' "$file_name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'; then
  echo "slnctrz-mcp launcher: activation filename is invalid" >&2
  exit 70
fi

executable="$install_root/versions/$version/$file_name"
if [ ! -f "$executable" ] || [ -L "$executable" ] || [ ! -x "$executable" ]; then
  echo "slnctrz-mcp launcher: active standalone executable is missing or unsafe" >&2
  exit 70
fi

exec "$executable" "$@"
