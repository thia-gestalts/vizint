# View folders

Add each activity under `src/views/<slug>/` with `activity.html`, `activity.css`, `activity.js`, and `view.yml`. The folder name becomes the published slug. Keep shared code outside this directory.

A manifest requires `title`, `intro`, `type` (`engagement` or `attempt`), and `frameHeight`. Add learning links to satisfy graph validation. Use `activity` to retain a stable activity ID when it differs from the slug, and `order` to control homepage placement. Unordered views follow ordered views. Slugs break ties.

Define learning records under `learning.records` or an exercise's `records`. Reference topics by name, facts and skills by key, questions by UUID, and views by activity ID. Put data-derived learning in a colocated `content.mjs` default export and declare `learningModule: content.mjs` in the manifest.

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

Run `npm run check:views` to validate manifests, learning links, and activity scripts.
