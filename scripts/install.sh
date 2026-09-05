#!/bin/sh
# Public Git Bash / POSIX bootstrap for SlncTrZ-MCP supported standalone targets.
set -eu

DEFAULT_RELEASE_URL="https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download"
RELEASE_URL=${SLNCTRZ_RELEASE_URL:-$DEFAULT_RELEASE_URL}

case "$RELEASE_URL" in
  https://*) ;;
  *)
    echo "error: SLNCTRZ_RELEASE_URL must be HTTPS" >&2
    exit 2
    ;;
esac

for command in curl sha256sum mktemp grep uname; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "error: required command not found: $command" >&2
    exit 2
  fi
done

os=$(uname -s)
arch=$(uname -m)
case "$os:$arch" in
  Linux:x86_64|Linux:amd64)
    target="linux-x64"
    file_name="slnctrz-mcp"
    windows_bootstrap=false
    ;;
  MINGW*:x86_64|MINGW*:amd64|MSYS*:x86_64|MSYS*:amd64|CYGWIN*:x86_64|CYGWIN*:amd64)
    target="win32-x64"
    file_name="slnctrz-mcp.exe"
    windows_bootstrap=true
    if ! command -v cygpath >/dev/null 2>&1; then
      echo "error: Git Bash/MSYS cygpath is required for Windows installation" >&2
      exit 2
    fi
    ;;
  *)
    echo "error: this installer does not support $os/$arch; public targets are linux-x64 and win32-x64" >&2
    exit 2
    ;;
esac

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/slnctrz-install.XXXXXX")
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

binary="$tmp_dir/$file_name"
checksums="$tmp_dir/SHA256SUMS"
expected="$tmp_dir/SHA256SUMS.expected"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "$RELEASE_URL/SHA256SUMS" --output "$checksums"

if ! grep -E "^[0-9a-f]{64}  $file_name$" "$checksums" >"$expected"; then
  echo "error: this release does not provide a verified $target artifact ($file_name)" >&2
  echo "error: use a release that advertises $target support or follow the source/developer instructions" >&2
  exit 3
fi

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "$RELEASE_URL/$file_name" --output "$binary"

(
  cd "$tmp_dir"
  sha256sum --check "$(basename "$expected")"
)

if [ "$windows_bootstrap" = false ]; then
  chmod 0755 "$binary"
fi

convert_windows_path() {
  value=$1
  case "$value" in
    [A-Za-z]:\\*|[A-Za-z]:/*)
      printf '%s\n' "$value"
      ;;
    /*)
      cygpath -w "$value"
      ;;
    *)
      echo "error: Windows setup paths must be absolute: $value" >&2
      exit 2
      ;;
  esac
}

mode_set=false
port_set=false
path_set=false
authority_set=false
public_url_set=false
listen_host_set=false
install_root_set=false
state_root_set=false
config_root_set=false

while [ "$#" -gt 0 ]; do
  option=$1
  shift
  case "$option" in
    --mode)
      [ "$#" -gt 0 ] || { echo "error: missing --mode value" >&2; exit 2; }
      mode=$1; mode_set=true; shift
      ;;
    --port)
      [ "$#" -gt 0 ] || { echo "error: missing --port value" >&2; exit 2; }
      port=$1; port_set=true; shift
      ;;
    --path)
      [ "$#" -gt 0 ] || { echo "error: missing --path value" >&2; exit 2; }
      setup_path=$1; path_set=true; shift
      ;;
    --authority)
      [ "$#" -gt 0 ] || { echo "error: missing --authority value" >&2; exit 2; }
      authority=$1; authority_set=true; shift
      ;;
    --public-url)
      [ "$#" -gt 0 ] || { echo "error: missing --public-url value" >&2; exit 2; }
      public_url=$1; public_url_set=true; shift
      ;;
    --listen-host)
      [ "$#" -gt 0 ] || { echo "error: missing --listen-host value" >&2; exit 2; }
      listen_host=$1; listen_host_set=true; shift
      ;;
    --install-root)
      [ "$#" -gt 0 ] || { echo "error: missing --install-root value" >&2; exit 2; }
      install_root=$1; install_root_set=true; shift
      ;;
    --state-root)
      [ "$#" -gt 0 ] || { echo "error: missing --state-root value" >&2; exit 2; }
      state_root=$1; state_root_set=true; shift
      ;;
    --config-root)
      [ "$#" -gt 0 ] || { echo "error: missing --config-root value" >&2; exit 2; }
      config_root=$1; config_root_set=true; shift
      ;;
    --manifest)
      echo "error: bootstrap owns --manifest so setup stays pinned to the verified release" >&2
      exit 2
      ;;
    *)
      echo "error: unsupported installer argument: $option" >&2
      exit 2
      ;;
  esac
done

if [ "$windows_bootstrap" = true ]; then
  if [ "$mode_set" = true ] && [ "$mode" = system ]; then
    echo "error: Windows System Install is not supported yet; use --mode user" >&2
    exit 2
  fi
  if [ "$path_set" = true ]; then setup_path=$(convert_windows_path "$setup_path"); fi
  if [ "$install_root_set" = true ]; then install_root=$(convert_windows_path "$install_root"); fi
  if [ "$state_root_set" = true ]; then state_root=$(convert_windows_path "$state_root"); fi
  if [ "$config_root_set" = true ]; then config_root=$(convert_windows_path "$config_root"); fi
fi

set --
if [ "$mode_set" = true ]; then set -- "$@" --mode "$mode"; fi
if [ "$port_set" = true ]; then set -- "$@" --port "$port"; fi
if [ "$path_set" = true ]; then set -- "$@" --path "$setup_path"; fi
if [ "$authority_set" = true ]; then set -- "$@" --authority "$authority"; fi
if [ "$public_url_set" = true ]; then set -- "$@" --public-url "$public_url"; fi
if [ "$listen_host_set" = true ]; then set -- "$@" --listen-host "$listen_host"; fi
if [ "$install_root_set" = true ]; then set -- "$@" --install-root "$install_root"; fi
if [ "$state_root_set" = true ]; then set -- "$@" --state-root "$state_root"; fi
if [ "$config_root_set" = true ]; then set -- "$@" --config-root "$config_root"; fi

# Pin setup to the same exact release location used for the checksum and bootstrap artifact.
exec "$binary" setup --manifest "$RELEASE_URL/manifest.json" "$@"
