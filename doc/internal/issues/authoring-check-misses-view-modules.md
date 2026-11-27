# Authoring check: imported view modules are not captured

Views that import their own modules (`./questions.mjs`, `./languages.mjs`,
`./scheduler.mjs`) fail the authoring check at the bundle and type stages. The
modules are fine; they are just not in the checked snapshot.

```
activity.js:2:28: ERROR: Could not resolve "./questions.mjs"
activity.js(2,29): error TS2307: Cannot find module './questions.mjs' or its corresponding type declarations.
```

## Evidence

- `authoring_failures` (last 60 days) reports TS2307 and bundle "Could not
  resolve" clusters for `checkout/rounding` and
  `checkout/minimal-pairs-practice`.
- `src/views/rounding/activity.js` imports `./questions.mjs`.
  `src/views/minimal-pairs-practice/activity.js` imports `./languages.mjs` and
  `./scheduler.mjs`. These files sit in the view folder and work in the site
  build.
- Their check folders under
  `.view-generation/authoring/authoring-checks/<key>/` contain only
  `view.yml`, `activity.{html,css,js}`, `_frame.css` and the optional
  `_shared.js`.

## Cause

`scripts/eval-admin/authoring.py` captures a fixed file list:

- `SOURCE = ("view.yml", "activity.html", "activity.css", "activity.js")`
- `sources()` adds `host.mjs` and `content.mjs` to the revision manifest, but
  not other `.mjs` modules.
- `prepare_check()` copies only `SOURCE` files and the shared script into the
  check folder, so even manifest entries like `content.mjs` never reach the
  checker.

The commit "redesign views to be more portable" (6d541a3) made per-view
modules a normal pattern, and the capture list didn't follow.

## Impact

- Every view that uses its own modules fails its check, whatever its quality.
- Edits to an imported module alone don't change the revision, so they are
  not checked at all.

## Next steps

- Capture every regular file in the view folder that the view can import
  (at least `*.mjs` and `*.js`), both in `sources()` and in
  `prepare_check()`.
- Have `scripts/authoring-check.mjs` resolve relative imports against the
  check folder.
- Add a test with a view that imports a sibling module.
