# Local view generation

Run these commands from the repo root after installing Node dependencies.
Start Ollama with `qwen3.5:4b` and/or `qwen3.5:9b` available. An
embedding model such as `embeddinggemma` or `qwen3-embedding` enables
semantic example retrieval. Without one, retrieval falls back to term
overlap. The runner uses local Chrome, or the executable in `CHROME_PATH`.
Set `VIZINT_OLLAMA_URL` to override `http://localhost:11434`. Set
`VIZINT_EMBED_MODEL` to choose the embedding model.

```sh
mise run gen "Show how changing the mass affects a spring's oscillation"
```

Use `mise run gen --brief /path/to/brief.txt` for a prompt saved in a file.
`gen` draws three samples with a retrieved example view and keeps every
draft. It exits nonzero if no sample loads and type-checks. It accepts the
same arm options as an evaluation, for example `--samples 5`,
`--examples none` or `--repair once`.

## How a draft is checked

Each sample goes through the same pipeline:

1. The model replies with four fenced blocks: a JSON header (title, intro,
   libraries), then HTML, CSS and JavaScript. The `json` reply format
   (structured output with escaped code) remains available as an arm option.
2. The typing codemod in
   [`scripts/activity-codemod.mjs`](../../scripts/activity-codemod.mjs)
   rewrites the script without changing what it does at runtime:
   - DOM lookups get JSDoc casts based on the element's tag in the markup.
   - Numbers passed to DOM strings get explicit `String(...)` conversions, and
     string arithmetic gets `Number(...)`.
   - Implicit-any parameters get inferred JSDoc.
   - TypeScript-only syntax is stripped.

   The model's original is kept as `activity.raw.js`.
3. Strict `checkJs`, a syntax check, and a sandboxed offline browser load
   follow. Benchmark fixtures also assert numbers and interactions.

The result is one tier:

| Tier | Meaning |
| --- | --- |
| publishable | Fixture interaction checks and strict types pass. |
| working | Fixture interaction checks pass; type errors remain. |
| starts | The activity loads without errors. Custom briefs top out here, since they have no interaction checks. |
| broken | Anything else. |

A custom-brief draft counts as accepted when it starts and type-checks.
Review a draft's code, visuals and teaching content before copying it into
`src/views/<slug>/`. Add learning metadata, then run `mise run views:check`
and `mise run build` before publishing.

`mise run views:codemod-report` re-checks every saved draft with the current
codemod, without model calls. Use it after changing the codemod.

## Runs, arms and samples

A run tests one hypothesis. It targets benchmark fixtures or one custom
brief, and compares up to four arms. An arm is a generation setup:

| Setting | Values | Default |
| --- | --- | --- |
| `model` | an installed Ollama model, or `checked-in` | |
| `examples` | `none`, `fixed`, `retrieved` | `none` |
| `samples` | 1–5 per target | 3 |
| `temperature` | 0–1.5; sample *k* uses seed *k*·1000 | 0.7 |
| `repair` | `none`, `once`, `loop` | `none` |
| `format` | `fenced`, `json` | `fenced` |

For each fixture, the runner shuffles the arm order and records it. Then it
draws every sample of every arm. `checked-in` runs the repository's own view
for a fixture that has one, as a control. `repair once` sends the best draft
and its diagnostics back once. `repair loop` allows three follow-up calls
within 120 seconds and may escalate to thinking mode.

Example views:

- `fixed` always injects the `squared-errors` view.
- `retrieved` ranks views by term overlap and, when available, embedding
  similarity, over each view's title, intro, topics and `patterns`. A
  fixture's own view is never retrieved.

Only standalone engagement views are candidates. One reference of at most
6,000 characters of HTML and JavaScript goes into the prompt. Tag new views
with `patterns` in `view.yml` so retrieval can match techniques, not only
topics:

```yaml
patterns: [svg-plot, drag-handles, keyboard-handles, range-slider]
```

Write a spec and run it, or let the CLI build one from flags:

```sh
mise run views:eval run --spec spec.json
mise run views:eval eval --model qwen3.5:4b --examples retrieved --samples 3
```

```json
{
  "hypothesis": "A retrieved example raises the working rate for qwen3.5:4b",
  "fixtures": ["classifier-threshold", "roc-auc", "bezier", "spring"],
  "arms": [
    { "model": "qwen3.5:4b", "examples": "none" },
    { "model": "qwen3.5:4b", "examples": "retrieved" }
  ]
}
```

Each run lives under the gitignored `.view-generation/` folder:

- `experiment.json`: the normalized spec, including who started the run.
- `run.json`: provenance, the arm order and the planned samples. Provenance
  covers the Git commit and dirty flag, runner and check fingerprints,
  runtime versions and model digests.
- `results.json`: one row per sample.
- `notes.json`: shared notes.
- One folder per attempt, with the request, response, draft files, preview
  and result.

Draft outcomes are results, not errors. The runner exits nonzero only for
infrastructure failures, or from `gen` when nothing was accepted.

## Dashboard

Start the dashboard with `mise run views:admin` and open the URL printed at
startup. The default is http://127.0.0.1:8765. If that port is busy, it
tries 8766 through 8774. Use `mise run views:admin --port 9001` to require a
port, and use that port in the MCP URL below. The task uses uv to install
its locked Python dependencies on first run.

- **Runs** lists every run, newest first, with its hypothesis, who started
  it (you or a named agent), a per-arm headline and its status. Runs from the
  earlier runner sit under **Legacy runs**, read-only. Their tiers are
  recomputed from the stored checks.
- **New run** sets a hypothesis, the target and up to four arms, and
  estimates the duration. One run executes at a time. **Run again…** on a
  run page prefills this form from that run.
- A run page shows:
  - progress and a scoreboard of arms × fixtures, with tier counts, median
    raw and codemod-fixed type errors, and median time
  - every sample with its preview, check strip and first problem
  - shared notes
  - settings, provenance and the runner output

  A sample page shows each attempt's preview, example view, codemod fixes,
  tokens and diagnostics, with links to its artifacts.

## Agents

The dashboard serves an MCP endpoint at `/mcp`. Agents and humans share the
same runs: a run an agent starts appears in the dashboard as
**Agent · name**, and notes go both ways.

```sh
claude mcp add --transport http vizint-eval http://127.0.0.1:8765/mcp
codex mcp add vizint-eval --url http://127.0.0.1:8765/mcp
```

| Tool | Purpose |
| --- | --- |
| `describe_options` | fixtures, installed models, arm settings, limits, the active run |
| `start_run` | hypothesis, arms, fixtures or brief, and `agent_name` |
| `list_runs`, `get_run` | headlines, scoreboard, samples, notes, provenance |
| `get_sample`, `read_attempt_artifact` | attempts, diagnostics and draft files |
| `add_note`, `cancel_run` | write a conclusion, stop the active run |

For example, ask: “Start a run comparing retrieved and no examples on all
fixtures with qwen3.5:4b. When it finishes, inspect the broken samples and
add a note with your conclusion and the next experiment.”

The JSON API mirrors the tools: `GET /api/options`, `GET /api/runs`,
`GET /api/runs/ID`, `GET /api/runs/ID/samples/ARM/FIXTURE/N`, and the
`POST /api/runs`, `/api/runs/ID/notes` and `/api/runs/ID/cancel`
endpoints, which require `Content-Type: application/json`.

## Activity libraries

Local generation and the published site can bundle approved npm libraries
into the activity iframe. D3 and Three.js are available today. Mention the
library in a custom brief to include its tested reference in the prompt,
for example:

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

For a custom brief, the model can return a library request instead of a
draft:

```json
{"libraryRequest":{"package":"three","reason":"The activity needs interactive 3D rendering."}}
```

The run records the requested package, reason and availability. If the
package is available, the runner sends back its reference and asks for the
full activity. An unavailable package or incompatible version ends the
sample with an explicit dependency result. Benchmark fixtures use plain
JavaScript and do not offer library requests. The runner never installs
packages in response to model output.

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
   Run `node --test scripts/*.test.mjs`, `mise run views:check`, and
   `npm run build`. Try a short real generation that names the library and
   inspect its preview, bundle check, and generated `libraries` declaration.
