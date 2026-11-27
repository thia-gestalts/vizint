import ts from 'typescript';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../src/runtime/index.js', import.meta.url));
// Packages that only provide types, so a view may import types from them.
const typeOnly = ['geojson'];

const options = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
};

// The same imports the bundler allows: the runtime, declared libraries, and
// modules inside the view's own folder.
function resolver(filename, libraries, settings, host) {
  const anchor = fileURLToPath(new URL('../package.json', import.meta.url));
  const folder = dirname(filename) + sep;
  return (imports, containingFile) => imports.map(name => {
    if (containingFile !== filename && !containingFile.startsWith(folder)) {
      return ts.resolveModuleName(name, containingFile, settings, host).resolvedModule;
    }
    if (name === 'vizint') return { resolvedFileName: runtime, extension: ts.Extension.Js, isExternalLibraryImport: false };
    if (name.startsWith('.')) {
      const resolved = ts.resolveModuleName(name, containingFile, settings, host).resolvedModule;
      return resolved?.resolvedFileName.startsWith(folder) ? resolved : undefined;
    }
    if (!libraries.includes(name) && !typeOnly.includes(name)) return undefined;
    return ts.resolveModuleName(name, anchor, settings, host).resolvedModule;
  });
}

export function activityProgram(filename, source, libraries = []) {
  const settings = options;
  const host = ts.createCompilerHost(settings);
  host.resolveModuleNames = resolver(filename, libraries, settings, host);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (file, ...args) => file === filename
    ? ts.createSourceFile(file, source, options.target)
    : getSourceFile(file, ...args);
  // Each activity runs in its own frame with its own global scope.
  return ts.createProgram([filename], settings, host);
}

/** A language service over one in-memory activity file, for code fixes. */
export function activityLanguageService(filename, source, libraries = []) {
  const settings = options;
  let text = source;
  let version = 0;
  const base = ts.createCompilerHost(settings);
  const host = {
    getCompilationSettings: () => settings,
    getScriptFileNames: () => [filename],
    getScriptVersion: file => file === filename ? String(version) : '0',
    getScriptSnapshot: file => {
      if (file === filename) return ts.ScriptSnapshot.fromString(text);
      const content = ts.sys.readFile(file);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => base.getCurrentDirectory(),
    getDefaultLibFileName: value => ts.getDefaultLibFilePath(value),
    fileExists: file => file === filename || ts.sys.fileExists(file),
    readFile: file => file === filename ? text : ts.sys.readFile(file),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  host.resolveModuleNames = resolver(filename, libraries, settings, base);
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return {
    service,
    get text() { return text; },
    update(next) { text = next; version++; },
    errors: () => [...service.getSyntacticDiagnostics(filename), ...service.getSemanticDiagnostics(filename)]
      .filter(item => item.category === ts.DiagnosticCategory.Error),
  };
}
