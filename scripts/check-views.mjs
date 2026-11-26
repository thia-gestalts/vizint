import { activityProgram } from './activity-program.mjs';
import { bundleActivity } from './activity-libraries.mjs';
import { build } from 'esbuild';
import { Script } from 'node:vm';
import ts from 'typescript';
import { entries } from '../src/catalog.mjs';
import { readFileSync } from 'node:fs';
import { buildLearningGraph } from './learning-graph.mjs';
import { readActivityScript } from './activity-script.mjs';

buildLearningGraph(entries, JSON.parse(readFileSync(new URL('../vendor/thia-gestalts/common/v2.json', import.meta.url))));

const diagnostics = [];
for (const entry of entries) {
  if (entry.customHost && !entry.libraries?.length) {
    const { outputFiles } = await build({
      entryPoints: [`src/views/${entry.slug}/activity.js`], bundle: true, format: 'iife', write: false,
    });
    new Script(outputFiles[0].text);
    continue;
  }
  const { parts, source } = await readActivityScript(entry);
  const filename = parts.at(-1).file;
  const program = activityProgram(filename, source, entry.libraries);
  if (program.getSyntacticDiagnostics().length === 0) {
    try {
      const code = entry.libraries?.length
        ? await bundleActivity({ filename, source, libraries: entry.libraries })
        : source;
      new Script(code, { filename });
    } catch (error) {
      console.error(`${entry.slug} activity script could not be loaded. ${error.message}`);
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
      file: ts.createSourceFile(part.file, part.source, program.getCompilerOptions().target),
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
