# Datasets

Static data that is too large to inline in a view, or that several views share, is a dataset. A dataset is published once as a pack, identified by a hash of its content, and a view names the packs it can use by hash. The view does not depend on where a pack is hosted, so the same `view.html` can load its data from the site, from any mirror, or from a file the learner provides.

## Folders

Each dataset has a folder `src/datasets/<id>/` with a `dataset.yml`:

```yaml
title: Africa
kind: country-map            # views declare which kind a slot accepts
source: Map geometry from Natural Earth, limited to Africa
sourceUrl: https://www.naturalearthdata.com/
license: Public domain
licenseUrl: https://www.naturalearthdata.com/about/terms-of-use/
notice: …                    # optional longer attribution
meta: { mapName: map of Africa }   # optional data for the view, read as pack.meta
derive: derive.mjs           # or a files/ directory
```

A stored dataset keeps its files under `files/`. A derived dataset exports `default async ({ dataset, files }) => Map<path, Uint8Array>` from `derive.mjs`, where `files(id)` returns another dataset's files. `africa-countries` derives from `world-countries` this way. Datasets of one kind share a file layout, so a view reads any of them the same way.

## Packs

The build writes every dataset used by a view to `dist/datasets/<id>.<hash16>.vzpk`:

```
"VZPK" | u32 little-endian index length | UTF-8 JSON index | entry bytes
```

The index holds the dataset's fields and `entries: { path: { offset, length, type, sha256 } }`, with offsets relative to the end of the index. Entries are sorted, so a pack is deterministic. The dataset hash is the SHA-256 of the index bytes. Because the index lists each entry's SHA-256, that one hash pins every byte. The runtime checks the index against the hash the view declares, and each entry when it reads it.

Entries are read lazily, one byte range each. Opening a pack reads its first 64 KiB, which holds the header and usually the whole index. Each entry is one further request. A learner who plays 30 clips from the 44 MB Vietnamese pack downloads its index, `clips.json` and 30 clips. An entry is read and verified whole, so split data into entries along the lines a view reads it.

## Delivery

For each option of each slot, the build gives the view:

- the hash,
- the dataset's title and credits,
- its sources: the site-relative URL, plus an absolute one when `VIZINT_PUBLIC_ORIGIN` is set.

Small packs are also inlined into `view.html`, smallest first, up to `VIZINT_INLINE_BUDGET` bytes per view (default 1 MiB). An inlined pack is decoded only when it is selected, but it is downloaded with the page.

The runtime looks for a pack in this order:

1. the inline copy,
2. each source URL,
3. a `needs-file` error.

`slot.loadFile(file)` opens a pack file the learner provides. It accepts only a file whose hash matches one of the slot's options. Offering a download of the pack and a file input is all a future "use this offline" flow needs.

Set `VIZINT_PUBLIC_ORIGIN` for production builds. Without it, a copied `view.html` can only use inline packs and files the learner provides.

## Serving

Views run with an opaque origin and read packs in ranges. The pack host must therefore:

- send `Access-Control-Allow-Origin: *`,
- allow and answer `Range` requests with `206` and `Content-Range`,
- answer `OPTIONS` preflights.

`scripts/serve.mjs` does this for `/datasets/`. Packs are immutable and can be cached forever. A server that ignores `Range` still works for entries within the first 4 MiB of a pack. For entries further in, the reader fails with `no-range` rather than download the whole pack.

## Slots

A view declares which datasets it can show in `view.yml`. See `doc/view-folders.md`. Every option must exist and have the slot's kind. `content.mjs` receives the options of each slot, so learning targets can be derived from the data the view shows. `world-map` creates one fact per country across all of its maps, so practice on the Africa map counts toward the same facts.
