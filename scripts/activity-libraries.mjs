import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  katex: {
    aliases: /\b(?:katex|la?tex|formulas?|equations?)\b/i,
    summary: 'Typeset LaTeX math notation.',
    notes: 'Render into an element from the activity markup with katex.render. Re-render to show live values. Its stylesheet and fonts are included automatically.',
    styles: 'katex/dist/katex.min.css',
  },
};

// Libraries checked-in views may use beyond those offered to generation.
export const viewLibraries = {
  ...activityLibraries,
  'ts-fsrs': { summary: 'Spaced-repetition scheduling with FSRS.' },
};

/** The runtime every view may import as `vizint`, bundled like a library. */
export const runtimeEntry = fileURLToPath(new URL('src/runtime/index.js', root));

export function libraryNamesInBrief(brief) {
  return Object.keys(activityLibraries).filter(name => activityLibraries[name].aliases.test(brief));
}

export function validateLibraries(names, registry = activityLibraries) {
  if (!Array.isArray(names) || new Set(names).size !== names.length ||
      names.some(name => typeof name !== 'string' || !Object.hasOwn(registry, name))) {
    throw new Error('Expected a list of unique supported activity libraries: ' + Object.keys(registry).join(', '));
  }
}

// Models often copy the catalog's version into the name ("three@0.187.0").
export function normalizeLibraryNames(names) {
  return Array.isArray(names)
    ? names.map(name => typeof name === 'string' ? name.trim().replace(/(?<=.)@[^@]*$/, '') : name)
    : names;
}

export function libraryVersion(name) {
  return Object.hasOwn(viewLibraries, name) ? manifest.devDependencies[name] : undefined;
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

// Frames load nothing over the network, so each library stylesheet inlines its
// WOFF2 fonts and drops the WOFF and TrueType fallbacks.
export async function libraryStyles(names = []) {
  validateLibraries(names, viewLibraries);
  return (await Promise.all(names.filter(name => viewLibraries[name].styles).map(async name => {
    const file = fileURLToPath(new URL(`node_modules/${viewLibraries[name].styles}`, root));
    const folder = pathToFileURL(dirname(file) + '/');
    const css = await readFile(file, 'utf8');
    const fonts = new Map();
    for (const [, path] of css.matchAll(/url\(([^)]+\.woff2)\)/g)) {
      fonts.set(path, (await readFile(new URL(path, folder))).toString('base64'));
    }
    return css.replace(/url\(([^)]+\.woff2)\) format\("woff2"\)(?:,url\([^)]+\) format\("[^"]+"\))*/g,
      (_, path) => `url(data:font/woff2;base64,${fonts.get(path)}) format("woff2")`);
  }))).join('\n');
}

/**
 * Bundles an activity into one script. It may import the `vizint` runtime, its
 * declared libraries, and modules inside its own folder, nothing else.
 */
export async function bundleActivity({ filename, source, libraries = [] }) {
  validateLibraries(libraries, viewLibraries);
  const resolveDir = fileURLToPath(root);
  const folder = dirname(filename) + sep;
  const { outputFiles } = await build({
    entryPoints: [filename], bundle: true, format: 'iife', platform: 'browser',
    write: false, minify: true, legalComments: 'inline', logLevel: 'silent',
    plugins: [{
      name: 'activity-libraries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.kind === 'entry-point') return { path: filename, namespace: 'activity-source' };
          if (args.pluginData === 'library') return;
          if (args.namespace !== 'activity-source' && !args.importer.startsWith(folder)) return;
          const shown = args.importer.startsWith(folder) ? relative(folder, args.importer) : 'The activity';
          if (args.path === 'vizint') return { path: runtimeEntry };
          if (args.path.startsWith('.')) {
            if (!resolve(args.resolveDir, args.path).startsWith(folder)) {
              return { errors: [{ text: `${shown} imports "${args.path}" from outside its view folder.` }] };
            }
            return;
          }
          if (args.kind !== 'import-statement' || !libraries.includes(args.path)) {
            return { errors: [{ text: `Activity import "${args.path}" is unavailable. Use a static import from a declared library.` }] };
          }
          return builder.resolve(args.path, { kind: args.kind, resolveDir, pluginData: 'library' });
        });
        builder.onLoad({ filter: /.*/, namespace: 'activity-source' }, () => ({
          contents: source, loader: filename.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(filename),
        }));
      },
    }],
  });
  return outputFiles[0].text;
}
