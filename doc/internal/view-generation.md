# Local view generation

Run from the repo root after installing Node dependencies. Start Ollama with
`qwen3.5:4b` and/or `qwen3.5:9b` available. The runner uses local Chrome, or
the executable specified in `CHROME_PATH`. Set `VIZINT_OLLAMA_URL` to override
`http://localhost:11434`.

```sh
mise run gen "Show how changing the mass affects a spring's oscillation"
mise run views:eval-control
mise run views:eval --fixture bezier --model qwen3.5:4b --repair
mise run views:eval --fixture roc-auc --model qwen3.5:9b --repair
mise run views:eval
```

Use `mise run gen --brief /path/to/brief.txt` for a prompt saved in a file.

The control runs the checked-in Bézier view without Ollama. The default
benchmark runs Bézier, spring–mass, and ROC-AUC on both Qwen models,
sequentially. Repeat `--model` to compare other installed models.

`gen` retries once by default. Use `--no-repair` for a first-pass-only run
or `--repair` to enable retries in the benchmark. A truncated response
triggers a fresh, compact generation. A validation failure triggers a
JavaScript-only repair that preserves HTML and CSS. First attempts use
4,096 context and 3,000 output tokens. Retries use 8,192 context and
4,500 output tokens. A case that still fails exits nonzero after the
results are saved. The first draft and preview remain available.

Start the local dashboard with `mise run views:admin` and open
the URL printed at startup. The default is http://127.0.0.1:8765. If that
port is busy, the dashboard tries 8766 through 8774. Use
`mise run views:admin --port 9001` to require a specific port. If the
dashboard uses a different port, use that port in the evaluator's run link,
the Claude Code MCP URL, and the JSON API examples below.
The admin task uses uv to install its locked Python dependencies on first run.
Use the dashboard to compare attempts, timings, screenshots, and diagnostics.
Each run lives under the gitignored `.view-generation/` folder
with requests, responses, draft files, and JSON results. Use `run.json`
to compare the Git commit, working-tree dirty flag, runner fingerprint,
runtime versions, prompts, and retry settings. A dirty run's fingerprint
identifies the runner and fixture contents used at the time.
Per-attempt results record the strategy, failure stage, token
budget and usage, and syntax, type, and browser outcomes. The dashboard displays
the share of Ollama's loaded model bytes in VRAM when available. Use
`ollama ps` to confirm CPU/GPU placement on the 8 GB NVIDIA card.

Drafts use the site's sandboxed activity frame in a fresh offline browser
context. Custom briefs get script and browser smoke checks. Benchmark fixtures
also assert numeric results and interactions. Review a draft's code, visuals,
and teaching content before copying it into `src/views/<slug>/`. Add learning
metadata and run `mise run views:check` and `mise run build` before publishing.

## Query runs from a coding agent

With the dashboard running, register its MCP server from the repo in Claude Code.

```sh
claude mcp add --transport http vizint-eval http://127.0.0.1:8765/mcp
```

Ask “Find the last five failed runs using model qwen3.5:4b. Inspect their
attempts and supporting artifacts, then explain what went wrong and cite the
run IDs.” The tools are `list_runs`, `get_run`, and `read_attempt_artifact`.

The equivalent run search over JSON is:

```sh
curl -G http://127.0.0.1:8765/api/runs \
  --data-urlencode 'model=qwen3.5:4b' \
  --data 'status=failed' --data 'limit=5'
```

Open each returned `api_url` for settings, diagnostics, and artifact URLs.
A failed run has at least one matching fixture whose final attempt failed.
Each run folder appears once, even if several fixtures failed.
