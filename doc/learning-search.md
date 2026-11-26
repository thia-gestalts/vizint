# Local learning search

The CLI reads the current checkout and prints JSON.

```sh
npm run --silent learning -- search "how do I average squared gaps?" --kind view
npm run --silent learning -- search beizer --lexical
npm run --silent learning -- neighbors view:mean-squared-error --direction out --relation prerequisites
```

Search kinds are `view`, `exercise`, `topic`, `fact`, `skill`, and `question`. Use `--limit` to change the default of 10 results. Use a result's ID for neighbor queries. The `sharedTopic` relation identifies views that share an authored topic. The `within` and `related` relations connect topics to each other, and each such edge names its `source`.

Run Ollama locally and install the default model with `ollama pull embeddinggemma`. If you already have Qwen3 Embedding, set `VIZINT_EMBED_MODEL=qwen3-embedding:0.6b`. The default endpoint is `http://localhost:11434` and `VIZINT_OLLAMA_URL` can override it. Semantic search falls back to lexical results when the model is unavailable. Cached vectors live in `.learning-cache/` and can be regenerated on demand.
