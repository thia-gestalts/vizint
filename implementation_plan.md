# Vizint implementation

## Run locally

Use Node.js 20 or later and tar for the build. Use a current browser with the Olymp v1 browser APIs. Run these commands from the project root.

```sh
npm run build
npm start
```

The build requires no dependency install, network access or sibling checkout. The local host serves `dist/` on port 8000 and proxies `/v1/` to `OLYMP_ORIGIN` (default `http://127.0.0.1:8787`). In production, serve the static files over HTTPS and proxy `/v1/` at the same origin.

| URL | Interaction that records an observation |
| --- | --- |
| http://localhost:8000/ | Browse the two entries. |
| http://localhost:8000/bezier/ | Drag a control point or focus it and press an arrow key. The first actual movement per page load records an engagement with **Bézier Curves**. Moving the parameter slider only changes the construction. |
| http://localhost:8000/rounding/ | Choose an answer. The page records an attempt against **Round to the nearest tenth** with score `1` if correct or `0` if incorrect. **Next question** starts another item once the attempt is saved. |

The explorer adapts the de Casteljau construction from the Gestalts Vizint example. Rounding generates original multiple-choice items based on the nearest-tenth exercise model in the Gestalts math-drills deck.

## Inspect the two observations

For the signed-out storage check, use a fresh browser profile or private window to get an empty database. Move a Bézier control point once, then answer one rounding question. Wait until each page confirms its save. Reload either page and open the browser console in the top-level page context.

```js
const { readRecords } = await import('/storage.mjs')
const records = await readRecords()
console.table(records.filter(({ kind }) => kind === 'learning-event'))
console.log(JSON.stringify(records, null, 2))
```

Expect two learning events and two target records. The engagement omits `score`. The attempt includes its observed score. Match each event's target to a stored record by `kind` and `id`. The same records are visible in the browser's IndexedDB inspector under `vizint-learner` → `records`. Keep the same browser profile and origin when checking reloads.

Save the JSON array printed above as `records.json`. With Python's `jsonschema` 4.18 or later installed, validate the export offline.

```sh
python3 scripts/validate_records.py records.json
```

The validator registers the seven vendored Draft 2020-12 schemas by their declared IDs and checks every event target resolves. The pin records thia-gestalts commit `527c6982b508f9a6f873fdc47d5e2700dcfdad66` and a SHA-256 digest for each schema.

## Storage and integration

The activity documents run in sandboxed, opaque-origin iframes. The host accepts interaction messages only from its own frame. The host owns the activity and target identities, issues and grades rounding questions, and commits the event and its target in one IndexedDB transaction. A failed save retains the same observation ID for retry.

The local site uses the provisional `example.thia.vizint` namespace under the schemas' reserved example domain. Confirm the publisher namespace for integration and retain published target identities once assigned.

## Olymp integration checkpoint · 2026-11-25

Sign in or create an account on the index or either activity page. Guest activity stays in the original `vizint-learner` database and becomes visible again on sign-out. A signed-in activity writes its target and event in one account-scoped IndexedDB commit through Olymp. The trusted host starts replication on each page. The opaque-origin activity frame only receives its activity messages. Vizint retains unrendered records and authenticated attachment chunks locally.

Tested vizint `90f5cf48d7b79a79e166f6274910c6d1d4c48906`, Olymp `35fbb66e284caa1e93c56ad6863b2c233b81fe6a`, and desktop `d037aabf5d701dee1305a7fcd61b05f36ff0a84a`. The independent build verified vendored Olymp 1.1.0 SHA-256 `4266f2c8533f31e2b440879b96615abfefd3fc850ad85e3234c58dbc8b443c14`.

```sh
npm run build
# From thia-olymp after building both clients and the service
xvfb-run -a node tests/products.mjs
```

The acceptance test signed in through the forms, disconnected Chromium, answered the real rounding iframe, reconnected and dropped the successful publication reply. The open desktop practice view displayed the skill once at the event's original time. The return trip interrupted an image download after one of four chunks. Vizint retained its earlier confirmation. After a browser process restart, it fetched exactly three remaining chunks and read the complete note and its 936,914 image bytes offline. Its manifest and revision 3 confirmation matched the restarted desktop. Signing out restored the guest records.

The Olymp plan records the packaged-launcher command for this host. The test disconnected an already loaded activity. A cold launch of the static site without a network or cached app shell, production HTTPS hosting and visual review remain unverified.
