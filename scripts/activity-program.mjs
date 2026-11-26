import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const options = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [],
};

function settingsFor(libraries) {
  return libraries.length ? {
    ...options, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  } : options;
}

function resolver(filename, libraries, settings, host) {
  const anchor = fileURLToPath(new URL('../package.json', import.meta.url));
  return (imports, containingFile) => imports.map(name => {
    if (containingFile === filename && !libraries.includes(name)) return undefined;
    const directoryAnchor = containingFile === filename ? anchor : containingFile;
    return ts.resolveModuleName(name, directoryAnchor, settings, host).resolvedModule;
  });
}

export function activityProgram(filename, source, libraries = []) {
  const settings = settingsFor(libraries);
  const host = ts.createCompilerHost(settings);
  if (libraries.length) host.resolveModuleNames = resolver(filename, libraries, settings, host);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (file, ...args) => file === filename
    ? ts.createSourceFile(file, source, options.target)
    : getSourceFile(file, ...args);
  // Each activity runs in its own frame with its own global scope.
  return ts.createProgram([filename], settings, host);
}

/** A language service over one in-memory activity file, for code fixes. */
export function activityLanguageService(filename, source, libraries = []) {
  const settings = settingsFor(libraries);
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
  if (libraries.length) host.resolveModuleNames = resolver(filename, libraries, settings, base);
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return {
    service,
    get text() { return text; },
    update(next) { text = next; version++; },
    errors: () => [...service.getSyntacticDiagnostics(filename), ...service.getSemanticDiagnostics(filename)]
      .filter(item => item.category === ts.DiagnosticCategory.Error),
  };
}
