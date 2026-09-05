#!/bin/sh
# Clean User Install acceptance against an already-published exact release tag.
set -eu

tag=${1:-}
if [ -z "$tag" ]; then
  echo "usage: $0 vX.Y.Z" >&2
  exit 2
fi
case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "error: invalid release tag: $tag" >&2; exit 2 ;;
esac

version=${tag#v}
release_url="https://github.com/SlncTrZ/SlncTrZ-MCP/releases/download/$tag"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/slnctrz-release-e2e.XXXXXX")
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT HUP INT TERM

home="$tmp_dir/home"
workspace="$tmp_dir/workspace"
mkdir -p "$home" "$workspace"

# Isolate all user defaults from the runner account.
HOME="$home" SLNCTRZ_RELEASE_URL="$release_url"   sh "$(dirname "$0")/install.sh"   --mode user   --port 43123   --path "$workspace"

binary="$home/.local/share/slnctrz-mcp/versions/$version/slnctrz-mcp"
state="$home/.slnctrz-mcp"

test -x "$binary"
test -f "$state/installation.json"
test -f "$state/secrets/owner-passphrase"
test "$("$binary" --version)" = "$version"

HOME="$home" SLNCTRZ_STATE_ROOT="$state" "$binary" status --json >"$tmp_dir/status.json"
HOME="$home" SLNCTRZ_STATE_ROOT="$state" "$binary" doctor --json >"$tmp_dir/doctor.json"

# User mode is not auto-started; gateway_unreachable is permitted as WARN. No FAIL is allowed.
if grep -q '"level":"FAIL"' "$tmp_dir/doctor.json"; then
  cat "$tmp_dir/doctor.json" >&2
  echo "error: clean User Install doctor reported FAIL" >&2
  exit 4
fi

HOME="$home" SLNCTRZ_STATE_ROOT="$state" "$binary" uninstall --yes
test ! -e "$home/.local/share/slnctrz-mcp"
test -d "$state"
test -d "$home/.config/slnctrz-mcp"

printf '%s\n'   "clean_user_install=pass"   "tag=$tag"   "version=$version"   "redirect_class=GitHub release asset exact-tag HTTPS"   "default_uninstall_preserved_state=pass"
