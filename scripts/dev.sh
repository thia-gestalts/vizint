#!/usr/bin/env bash
# Build Vizint, then serve the site and the evaluation dashboard (with its MCP endpoint) together.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_PORT="${PORT:-8000}"
ADMIN_PORT="${ADMIN_PORT:-8765}"
OLLAMA_URL="${VIZINT_OLLAMA_URL:-http://localhost:11434}"
export OLYMP_ORIGIN="${OLYMP_ORIGIN:-https://gestalter.koljasam.com}"

[ -d node_modules ] && [ node_modules -nt package-lock.json ] || npm ci
npm run build

pids=()
cleanup() { trap - EXIT INT TERM; kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

PORT="$APP_PORT" node scripts/serve.mjs > >(sed -u 's/^/[app]   /') 2>&1 &
pids+=($!)
uv run --project scripts/eval-admin --locked python scripts/eval-admin/admin.py --port "$ADMIN_PORT" \
  > >(sed -u 's/^/[admin] /') 2>&1 &
pids+=($!)

up() { curl -fs -o /dev/null --max-time 1 "$1"; }
for _ in $(seq 60); do up "http://127.0.0.1:$APP_PORT/" && up "http://127.0.0.1:$ADMIN_PORT/" && break; sleep 0.5; done

mcp="http://127.0.0.1:$ADMIN_PORT/mcp"
if up "$OLLAMA_URL/api/tags"; then ollama="running at $OLLAMA_URL"; else ollama="NOT reachable at $OLLAMA_URL (start it: ollama serve)"; fi
cat <<EOF

  Vizint          http://127.0.0.1:$APP_PORT   (sync via $OLYMP_ORIGIN)
  Eval dashboard  http://127.0.0.1:$ADMIN_PORT
  MCP endpoint    $mcp
  Ollama          $ollama

  Agents with the vizint-eval MCP (run from this folder):
    claude --mcp-config '{"mcpServers":{"vizint-eval":{"type":"http","url":"$mcp"}}}'
    codex -c 'mcp_servers.vizint-eval.url="$mcp"'
  Or register once:
    claude mcp add --transport http vizint-eval $mcp
    codex mcp add vizint-eval --url $mcp

  Other tasks: mise tasks   ·   Ctrl-C stops everything

EOF
wait -n "${pids[@]}"
