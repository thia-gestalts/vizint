# Vizint implementation

## Run locally

Use Node.js 20 or later and Python 3. Run these commands from the project root.

```sh
npm run build
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

The build requires no dependency install, network access or sibling checkout. Serve `dist/` on a static host with directory indexes and HTTPS, or use localhost for development.

| URL | Interaction that records an observation |
| --- | --- |
| http://localhost:8000/ | Browse the two entries. |
| http://localhost:8000/bezier/ | Drag a control point or focus it and press an arrow key. The first actual movement per page load records an engagement with **Bézier Curves**. Moving the parameter slider only changes the construction. |
| http://localhost:8000/rounding/ | Choose an answer. The page records an attempt against **Round to the nearest tenth** with score `1` if correct or `0` if incorrect. **Next question** starts another item once the attempt is saved. |

The explorer adapts the de Casteljau construction from the Gestalts Vizint example. Rounding generates original multiple-choice items based on the nearest-tenth exercise model in the Gestalts math-drills deck.

## Inspect the two observations

Use a fresh browser profile or private window to get an empty database. Move a Bézier control point once, then answer one rounding question. Wait until each page confirms its save. Reload either page and open the browser console in the top-level page context.

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

The Olymp integration session will add optional sign-in, whole-base encrypted replication, account isolation, and desktop verification. Test interrupted sync and attachment availability there.
