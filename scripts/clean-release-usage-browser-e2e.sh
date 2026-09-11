#!/bin/sh
# Browser acceptance against the exact public prerelease candidate.
set -eu

tag=${1:-}
case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: $0 vX.Y.Z" >&2; exit 2 ;;
esac
version=${tag#v}
release_url="https://github.com/SlncTrZ/SlncTrZ-MCP/releases/download/$tag"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/slnctrz-usage-browser-e2e.XXXXXX")
gateway_pid=""
cleanup() {
  if [ -n "$gateway_pid" ]; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

home="$tmp_dir/home"
workspace="$tmp_dir/workspace"
port=43124
mkdir -p "$home" "$workspace"

HOME="$home" SLNCTRZ_RELEASE_URL="$release_url" \
  sh "$(dirname "$0")/install.sh" --mode user --port "$port" --path "$workspace"

binary="$home/.local/share/slnctrz-mcp/versions/$version/slnctrz-mcp"
launcher="$home/.local/share/slnctrz-mcp/slnctrz-mcp-launcher"
state="$home/.slnctrz-mcp"
passphrase_file="$state/secrets/owner-passphrase"

test -x "$binary"
test -x "$launcher"
test -f "$passphrase_file"

HOME="$home" "$launcher" >"$tmp_dir/gateway.log" 2>&1 &
gateway_pid=$!

ready=0
for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    cat "$tmp_dir/gateway.log" >&2
    echo "error: installed gateway exited before browser acceptance" >&2
    exit 4
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  cat "$tmp_dir/gateway.log" >&2
  echo "error: installed gateway did not become healthy" >&2
  exit 4
fi

# Seed reviewed numeric/classification telemetry only, so the browser exercises non-empty tool and
# savings states without persisting any synthetic prompt/tool/file payload content.
SLNCTRZ_USAGE_DB="$state/usage.sqlite3" node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.SLNCTRZ_USAGE_DB);
const now = new Date().toISOString();
db.prepare(`INSERT INTO usage_events (
  timestamp, workspace_id, request_kind, tool_id, input_bytes, output_bytes,
  estimated_input_tokens, estimated_output_tokens, duration_ms, estimator_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(now, "browser-e2e", "tools_call", "core.read", 400, 8000, 100, 2000, 8, "utf8-bytes-v1");
db.prepare(`INSERT OR REPLACE INTO harness_usage_contexts (
  context_key, timestamp, workspace_id, potential_eager_bytes, disclosed_bytes,
  potential_eager_tokens, disclosed_tokens, estimator_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .run("browser-e2e", now, "browser-e2e", 40000, 12000, 10000, 3000, "utf8-bytes-v1");
db.close();
NODE

node "$(dirname "$0")/usage-browser-e2e.mjs" "http://127.0.0.1:$port" "$passphrase_file"

kill "$gateway_pid"
wait "$gateway_pid" || true
gateway_pid=""

HOME="$home" SLNCTRZ_STATE_ROOT="$state" "$binary" doctor --json >"$tmp_dir/doctor.json"
if grep -q '"level":"FAIL"' "$tmp_dir/doctor.json"; then
  cat "$tmp_dir/doctor.json" >&2
  echo "error: browser acceptance doctor reported FAIL" >&2
  exit 5
fi

HOME="$home" SLNCTRZ_STATE_ROOT="$state" "$binary" uninstall --yes

test -d "$state"
printf '%s\n' \
  "usage_browser_acceptance=pass" \
  "tag=$tag" \
  "version=$version" \
  "installed_artifact=public GitHub exact-tag release" \
  "owner_session=pass" \
  "usage_ranges=24h,7d,30d,all" \
  "custom_price=pass" \
  "usage_privacy_fixture=numeric-metadata-only"
