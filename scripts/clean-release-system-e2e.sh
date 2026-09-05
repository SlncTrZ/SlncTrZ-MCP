#!/bin/sh
# Destructive clean-host System Install acceptance. Run only on a disposable Linux systemd host.
set -eu

if [ "${SLNCTRZ_E2E_ALLOW_SYSTEM:-}" != "1" ]; then
  echo "refusing: set SLNCTRZ_E2E_ALLOW_SYSTEM=1 on a disposable clean Linux systemd host" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "refusing: System Install E2E must run as root" >&2
  exit 2
fi
if [ -e /opt/slnctrz-mcp ] || [ -e /var/lib/slnctrz-mcp ] || [ -e /etc/slnctrz-mcp ]; then
  echo "refusing: existing SlncTrZ managed roots detected" >&2
  exit 2
fi

tag=${1:-}
case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: $0 vX.Y.Z" >&2; exit 2 ;;
esac
version=${tag#v}
release_url="https://github.com/SlncTrZ/SlncTrZ-MCP/releases/download/$tag"
workspace="/var/tmp/slnctrz-system-e2e-workspace"
port=43124

cleanup_workspace() { rm -rf "$workspace"; }
trap cleanup_workspace EXIT HUP INT TERM
mkdir -p "$workspace"
chmod 0755 "$workspace"

SLNCTRZ_RELEASE_URL="$release_url"   sh "$(dirname "$0")/install.sh"   --mode system   --port "$port"   --path "$workspace"

binary="/opt/slnctrz-mcp/versions/$version/slnctrz-mcp"
test -x "$binary"
systemctl is-active --quiet slnctrz-mcp.service
curl --fail --silent "http://127.0.0.1:$port/healthz" >/dev/null
SLNCTRZ_STATE_ROOT=/var/lib/slnctrz-mcp "$binary" status --json
SLNCTRZ_STATE_ROOT=/var/lib/slnctrz-mcp "$binary" doctor --json |
  tee /tmp/slnctrz-system-doctor.json
if grep -q '"level":"FAIL"' /tmp/slnctrz-system-doctor.json; then
  echo "error: System Install doctor reported FAIL" >&2
  exit 4
fi

# Default uninstall must remove program/service but preserve customer config/state.
SLNCTRZ_STATE_ROOT=/var/lib/slnctrz-mcp "$binary" uninstall --yes
test ! -e /opt/slnctrz-mcp
test -d /var/lib/slnctrz-mcp
test -d /etc/slnctrz-mcp
! systemctl is-active --quiet slnctrz-mcp.service

printf '%s\n'   "clean_system_install=pass"   "tag=$tag"   "version=$version"   "default_uninstall_preserved_state=pass"
