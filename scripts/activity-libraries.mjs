import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

export const activityLibraries = {
  d3: {
    aliases: /\bd3(?:\.js)?\b/i,
    summary: 'Data scales, axes, shapes, SVG selections and geographic projections.',
    notes: 'Provide the SVG in the activity markup. Load data from JavaScript constants.',
  },
  three: {
    aliases: /\b(?:three[. -]?js|3js|3d)\b/i,
    summary: 'Interactive 3D geometry and WebGL rendering.',
    notes: 'WebGLRenderer requires WebGL 2. Handle an unavailable GPU context. Use procedural geometry and colors for offline use.',
  },
};

export function libraryNamesInBrief(brief) {
  return Object.keys(activityLibraries).filter(name => activityLibraries[name].aliases.test(brief));
}

export function validateLibraries(names) {
  if (!Array.isArray(names) || new Set(names).size !== names.length ||
      names.some(name => typeof name !== 'string' || !Object.hasOwn(activityLibraries, name))) {
    throw new Error('Expected a list of unique supported activity libraries: ' + Object.keys(activityLibraries).join(', '));
  }
}

// Models often copy the catalog's version into the name ("three@0.187.0").
export function normalizeLibraryNames(names) {
  return Array.isArray(names)
    ? names.map(name => typeof name === 'string' ? name.trim().replace(/(?<=.)@[^@]*$/, '') : name)
    : names;
}

export function libraryVersion(name) {
  return Object.hasOwn(activityLibraries, name) ? manifest.devDependencies[name] : undefined;
}

export function libraryCatalog() {
  return Object.entries(activityLibraries).map(([name, entry]) =>
    `${name} (version ${libraryVersion(name)}): ${entry.summary}`).join('\n');
}

export async function libraryReferences(names) {
  validateLibraries(names);
  return (await Promise.all(names.map(async name => {
    const example = await readFile(new URL(`activity-library-examples/${name}.js`, import.meta.url), 'utf8');
    return `${name} (version ${libraryVersion(name)})\n${activityLibraries[name].notes}\nExample:\n${example.trim()}`;
  }))).join('\n\n');
}

export async function bundleActivity({ filename, source, libraries }) {
  validateLibraries(libraries);
  const resolveDir = fileURLToPath(root);
  const { outputFiles } = await build({
    entryPoints: [filename], bundle: true, format: 'iife', platform: 'browser',
    write: false, minify: true, legalComments: 'inline', logLevel: 'silent',
    plugins: [{
      name: 'activity-libraries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.kind === 'entry-point') return { path: filename, namespace: 'activity-source' };
          if (args.namespace !== 'activity-source') return;
          if (args.kind !== 'import-statement' || !libraries.includes(args.path)) {
            return { errors: [{ text: `Activity import "${args.path}" is unavailable. Use a static import from a declared library.` }] };
          }
          return builder.resolve(args.path, { kind: args.kind, resolveDir });
        });
        builder.onLoad({ filter: /.*/, namespace: 'activity-source' }, () => ({
          contents: source, loader: filename.endsWith('.ts') ? 'ts' : 'js', resolveDir,
        }));
      },
    }],
  });
  return outputFiles[0].text;
}
