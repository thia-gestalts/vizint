# Authoring check: page closes during startup

Most checkout authoring checks fail at the startup stage. The failure has
nothing to do with the view being checked.

```
page.setContent: Target page, context or browser has been closed
Call log:
  - setting frame content, waiting until "load"
```

## Evidence

- `authoring_failures` (last 60 days) ranks this pattern first. It covers 6 of
  10 revisions with diagnostics, across 5 unrelated views: `bezier`,
  `forgetting-curve`, `half-life-regression`, `mse`, `squared-errors`. Type,
  bundle and syntax checks pass in every one of them.
- It reproduces by running `scripts/authoring-check.mjs` on a copy of the
  `bezier` check folder. The run fails after about 2 s, so the 30 s check
  deadline (the `context.close()` timer in `checkBrowser`,
  `scripts/view-draft-check.mjs`) is not what closes the page.
- It still fails with an empty view script.
- Narrowing the page content with system Chrome 158.0.8127.88 and
  playwright-core 1.65.1:
  - `setContent('<p>hi</p>')`: ok
  - the `activityFrame` document, set directly: ok
  - `<iframe sandbox="allow-scripts" srcdoc="<p>hi</p>">`: page closes
  - the `activityFrame` document inside the sandboxed srcdoc iframe: page closes

## Likely cause

The page closes when a sandboxed `srcdoc` iframe loads under this Chrome and
Playwright combination. The view contents don't matter. I did not test whether
`sandbox` alone, `srcdoc` alone, the Chrome version or the Playwright version
triggers it.

## Impact

Checkout authoring pass rates are meaningless until this is fixed: 0 of 8
checked revisions passed. The `checkBrowser` startup path is shared, so
generation evals that use `checkDraft` are probably affected too. Check recent
runs for startup failures with this message.

## Next steps

- Test without `sandbox`, with `src` + `data:`/`blob:` instead of `srcdoc`,
  and with Playwright's bundled Chromium instead of `channel: 'chrome'`.
- Once fixed, existing failures don't re-run on their own. The check key
  includes the checker version, so revisions need re-queuing.
