# View folders

Add each activity under `src/views/<slug>/` with `activity.html`, `activity.css`, `activity.js`, and `view.yml`. The folder name becomes the published slug. Keep shared code outside this directory.

## Standalone views

A view is one self-contained HTML file. The build publishes it as `<slug>/view.html`, and the site embeds exactly that file. A view does all of its own learning logic: it generates questions, grades answers, schedules practice and shows feedback. It must work when opened on its own, in any iframe, or as a copied file. A host can listen to it, but a view never waits for one.

`activity.js` may import:

- the `vizint` runtime,
- the packages declared in `libraries` (`d3`, `three`, `katex`, `ts-fsrs`),
- modules inside its own folder, such as `./scheduler.mjs` or `./projection.ts`.

The build bundles these into the page. `npm run check:views` type-checks the activity and everything it imports.

## The `vizint` runtime

```js
import { attempt, engage, history, historyReady, slot, datasetPicker, state, target } from 'vizint';
```

- `engage()` records one engagement per page load. Call it on the learner's first meaningful interaction.
- `attempt({ score, targets?, activity? })` records a graded attempt with a score from 0 to 1. Without `targets` it uses the view's defaults: the assessed targets and topics of its single exercise. `activity` refines the activity ID, for example `world-map/find-on-world-map`.
- `target(kind, keyOrName)` looks up a target the view declares: facts and skills by key, topics by name. Views never build IDs themselves.
- `history()` returns this view's past events, oldest first. It starts with whatever a host supplied and always includes the view's own observations. `await historyReady()` waits briefly for a host's history before the first exercise is scheduled. It returns at once when there is no host.
- `state.get(key)` and `state.set(key, value)` keep small preferences. They are stored in `localStorage` where the view may use it, in memory otherwise, and in the host when one is present.
- `reportHeight(element, measure?)` lets a host size the frame to the content.

When a view is embedded, the runtime posts `hello`, `observation`, `state` and `height` messages to its parent, and accepts `history` from it. The site host (`src/shared/host.mjs`) is the same for every view. It stores observations whose targets the view declares, replies with history and stored state, and never grades.

## Manifest

A manifest requires `title`, `intro`, `type` (`engagement` or `attempt`), and `frameHeight`. Add learning links to satisfy graph validation. Use `activity` to retain a stable activity ID when it differs from the slug, and `order` to control homepage placement. Unordered views follow ordered views. Slugs break ties. `media: true` allows audio and video from blob URLs.

Define learning records under `learning.records` or an exercise's `records`. Reference topics by name, facts and skills by key, questions by UUID, and views by activity ID. Put data-derived learning in a colocated `content.mjs` default export and declare `learningModule: content.mjs` in the manifest. The module receives `(app, { datasets })`, with the datasets of each slot, so learning targets can come from the same data the view shows. An exercise in `content.mjs` may name `dataset: { slot, id }`, so that its page link opens the view on that dataset.

A view may report events for any record it declares or links. An attempt view needs at least one exercise that assesses something.

## Datasets

Heavy static data lives in datasets, not in views. See `doc/datasets.md`. A view declares slots, each a choice between datasets of one kind:

```yaml
datasets:
  map:
    kind: country-map
    label: Map
    options: [world-countries, africa-countries]
```

The first option is the default. In the view, `slot('map')` loads the selected dataset and calls `onChange` listeners when the learner picks another one. `datasetPicker('map')` returns the standard selector, which also shows the dataset's source and license. A URL fragment such as `view.html#map=africa-countries` selects a dataset directly.

Topic IDs follow the Gestalt identity algorithm through `nameId` in `src/name-id.mjs`, so a topic named in vizint matches the same name in other Thia apps. Content modules use it rather than deriving IDs themselves.

## Topic links

Say how topics relate where the relation is motivated, rather than in a global taxonomy. A view can assert links in `learning.topicLinks`:

```yaml
topicLinks:
  - subject: {kind: topic, name: mean squared error}
    relation: within
    object: {kind: topic, name: statistics}
```

`within` points from a narrower topic to a broader one. A topic can sit within several broader topics, and cycles are tolerated. `related` is symmetric. These are vizint's assertions, so other apps and learners can add or disagree with them.

A topic that deserves its own page, such as one that gathers several views, gets a folder at `src/topics/<slug>/topic.yml`. The folder declares the topic record and its outgoing links:

```yaml
name: Statistics
intro: Ways to describe data and measure how well a model fits it.
links:
  - relation: within
    target: {kind: topic, name: mathematics}
```

Topic pages list broader, narrower and related topics, and also the views reached through narrower topics.

## Checks

- `npm run check:views` validates manifests, learning links, and activity scripts.
- `npm run check:standalone` builds the site. It then checks that every `view.html` runs without a host and that a copied view works offline on its inline data. It also checks that the site host stores only declared targets.
