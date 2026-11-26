import { build } from 'esbuild';
import { Script } from 'node:vm';
import ts from 'typescript';
import { entries } from '../src/catalog.mjs';
import { readFileSync } from 'node:fs';
import { buildLearningGraph } from './learning-graph.mjs';
import { readActivityScript } from './activity-script.mjs';

buildLearningGraph(entries, JSON.parse(readFileSync(new URL('../vendor/thia-gestalts/common/v2.json', import.meta.url))));

const options = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [],
};

const diagnostics = [];
for (const entry of entries) {
  if (entry.customHost) {
    const { outputFiles } = await build({
      entryPoints: [`src/views/${entry.slug}/activity.js`], bundle: true, format: 'iife', write: false,
    });
    new Script(outputFiles[0].text);
    continue;
  }
  const { parts, source } = await readActivityScript(entry);
  const filename = parts.at(-1).file;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (file, ...args) => file === filename
    ? ts.createSourceFile(file, source, options.target)
    : getSourceFile(file, ...args);
  // Each activity runs in its own frame with its own global scope.
  const program = ts.createProgram([filename], options, host);
  if (program.getSyntacticDiagnostics().length === 0) {
    try {
      new Script(source, { filename });
    } catch (error) {
      console.error(`${entry.slug} view must run as a classic script. ${error.message}`);
      process.exitCode = 1;
    }
  }

  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.file?.fileName !== filename || diagnostic.start === undefined || parts.length === 1) {
      diagnostics.push(diagnostic);
      continue;
    }
    const [shared, activity] = parts;
    const activityStart = shared.source.length + 1;
    const inShared = diagnostic.start < activityStart;
    const part = inShared ? shared : activity;
    diagnostics.push({
      ...diagnostic,
      file: ts.createSourceFile(part.file, part.source, options.target),
      start: inShared ? diagnostic.start : diagnostic.start - activityStart,
    });
  }
}

if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(ts.sortAndDeduplicateDiagnostics(diagnostics), {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
}

if (!process.exitCode) console.log(`Checked ${entries.length} view scripts.`);
