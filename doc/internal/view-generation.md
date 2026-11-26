# Local view generation

Run from the repo root after installing Node dependencies. Start Ollama with
`qwen3.5:4b` and/or `qwen3.5:9b` available. The runner uses local Chrome, or
the executable specified in `CHROME_PATH`. Set `VIZINT_OLLAMA_URL` to override
`http://localhost:11434`.

```sh
mise run gen "Show how changing the mass affects a spring's oscillation"
```

Use `mise run gen --brief /path/to/brief.txt` for a prompt saved in a file.

`gen` runs a repair loop by default. It allows three follow-up calls and
120 seconds of repair time. Repairs use the first failing check as feedback
and may edit any activity file when needed. A stalled repair can escalate to
thinking mode. Use `--escalation-model NAME` to try another installed model
for escalation. The runner keeps every attempt and selects the strongest
checked draft. Generation exits nonzero if no attempt passes all available
checks.

Generation accepts `--repair-policy none|once|loop`. The aliases
`--no-repair` and `--repair` choose `none` and the legacy `once` policy.

Start the local dashboard with `mise run views:admin` and open
the URL printed at startup. The default is http://127.0.0.1:8765. If that
port is busy, the dashboard tries 8766 through 8774. Use
`mise run views:admin --port 9001` to require a specific port. If the
dashboard uses a different port, use that port in the evaluator's run link,
the MCP URLs, and the JSON API examples below.
The admin task uses uv to install its locked Python dependencies on first run.
The dashboard groups runs alphabetically by prompt, with newer runs first
within each prompt. Open a run to compare attempts, timings, screenshots, and diagnostics.
Use the admin header to switch between **Evaluate** and **Run history**.
While an evaluation is running, **Active evaluation** opens its progress
page. **Evaluate** has four tools:

- **Compare JavaScript and TypeScript** generates each selected fixture once
  per language with the same model and a 120-second limit per arm. The detail
  page shows paired outcomes for working activities and strict-check passes.
  TypeScript source and bundles are downloadable experiment artifacts.
- **Run fixture evaluation** runs the selected models on one fixture or all
  fixtures. Use **Allow one repair** to include the legacy retry.
- **Check Bézier control** validates a checked-in view and works without Ollama.
- **Replay repair policies** compares once and loop on the same saved first
  attempt. Select source runs in **Evaluate** or launch replay from a run’s
  detail page. The arms run serially in randomized order with 120 seconds each.

The run opens as soon as it is queued. The detail page shows progress,
artifacts, and runner output. You can cancel an active job there. The admin
runs one evaluation at a time to keep the comparisons serial.

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

## Activity libraries

Local generation and the published site can bundle approved npm libraries
into the activity iframe. D3 and Three.js are available today. Mention the
library in the brief to include its tested reference in the prompt, for
example:

```sh
mise run gen "Show a rotating cube with labeled axes. Use Three.js."
```

The generated `activity.js` uses a static package import and `view.yml`
declares the package. Keep both when publishing a generated draft. For a
hand-authored activity, add the same declaration:

```yaml
libraries: [three]
```

The build bundles the imports and inlines the result. An activity with
`libraries` can use the standard host. The bundle supports static imports
from the declared package entry points. Keep assets and data offline, and
handle missing browser capabilities such as WebGL 2 in the activity.

The model can return a library request instead of a draft:

```json
{"libraryRequest":{"package":"three","reason":"The activity needs interactive 3D rendering."}}
```

The CLI, admin attempt page, and run JSON show the requested package,
reason, and availability. If the package is available, the default repair
loop sends back its reference and asks for the full activity within the
existing call and time budget. An unavailable package or incompatible
version ends the run with an explicit dependency result. The runner never
installs packages in response to model output.

### Add a library

1. Pick a browser-compatible npm package whose license permits bundling.
   Pin a version with `npm install --save-dev --save-exact PACKAGE@VERSION`.
   If it ships without type declarations, pin the corresponding compatible
   `@types` package too. Commit `package.json` and `package-lock.json`.
2. Register the npm package name in
   [`scripts/activity-libraries.mjs`](../../scripts/activity-libraries.mjs).
   Add a short description, prompt aliases, and any offline or browser
   requirements. The registry reads the version from `package.json`.
3. Add a small, strictly type-checked JavaScript example at
   `scripts/activity-library-examples/PACKAGE.js`. Show the real static
   import and a minimal working use with no external resources. The model
   gets this code in its prompt when the package is named or requested.
4. Add an offline browser case to
   [`scripts/view-generation.test.mjs`](../../scripts/view-generation.test.mjs).
   Run `node --test scripts/view-generation.test.mjs`,
   `mise run views:check`, and `npm run build`. Try a short real generation
   that names the library and inspect its preview, bundle check, and
   generated `libraries` declaration.

## Query runs from a coding agent

From the repo root, start the dashboard with `mise run views:admin` and leave
it running. Use the MCP endpoint printed at startup if it differs from the
default shown below.

### Codex CLI

In a second terminal at the repo root, register the server and start Codex.

```sh
codex mcp add vizint-eval --url http://127.0.0.1:8765/mcp
codex
```

In the Codex session, enter `/mcp` to check that `vizint-eval` is available.
See the [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
for more configuration options.

### Claude Code

With the dashboard running, register the server from the repo root.

```sh
claude mcp add --transport http vizint-eval http://127.0.0.1:8765/mcp
```

In either agent, ask “Find the last five failed runs using model qwen3.5:4b. Inspect their
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
