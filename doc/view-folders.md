# View folders

Add each activity under `src/views/<slug>/` with `activity.html`, `activity.css`, `activity.js`, and `view.yml`. The folder name becomes the published slug. Keep shared code outside this directory.

A manifest requires `title`, `intro`, `type` (`engagement` or `attempt`), and `frameHeight`. Add learning links to satisfy graph validation. Use `activity` to retain a stable activity ID when it differs from the slug, and `order` to control homepage placement. Unordered views follow ordered views. Slugs break ties.

Define learning records under `learning.records` or an exercise's `records`. Reference topics by name, facts and skills by key, questions by UUID, and views by activity ID. Put data-derived learning in a colocated `content.mjs` default export and declare `learningModule: content.mjs` in the manifest.

Run `npm run check:views` to validate manifests, learning links, and activity scripts.
