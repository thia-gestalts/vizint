# Local view generation

Run from the repo root after installing Node dependencies. Start Ollama with
`qwen3.5:4b` and/or `qwen3.5:9b` available. The runner uses local Chrome, or
the executable specified in `CHROME_PATH`. Set `VIZINT_OLLAMA_URL` to override
`http://localhost:11434`.

```sh
mise run gen "Show how changing the mass affects a spring's oscillation"
mise run views:eval-control
mise run views:eval --fixture bezier --model qwen3.5:4b --repair
mise run views:eval
```

Use `mise run gen --brief /path/to/brief.txt` for a prompt saved in a file.

The control runs the checked-in Bézier view without Ollama. The default
benchmark runs Bézier and spring–mass on both Qwen models, sequentially.
Repeat `--model` to compare other installed models. `--repair` allows one
additional generation using the first failure's diagnostic. A case that
still fails exits nonzero after the report is written.
First attempts use a 4,096-token context. Repairs use 8,192 tokens to fit
the original draft, diagnostic, and replacement.

Open the printed `index.html` to compare passes, timings, screenshots, and
diagnostics. Each run lives under the gitignored `.view-generation/` folder
with requests, responses, draft files, and JSON results. The report displays
the share of Ollama's loaded model bytes in VRAM when available. Use
`ollama ps` to confirm CPU/GPU placement on the 8 GB NVIDIA card.

Drafts use the site's sandboxed activity frame in a fresh offline browser
context. Custom briefs get script and browser smoke checks. Benchmark fixtures
also assert numeric results and interactions. Review a draft's code, visuals,
and teaching content before copying it into `src/views/<slug>/`. Add learning
metadata and run `mise run views:check` and `mise run build` before publishing.
