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

export function activityProgram(filename, source, libraries = []) {
  const settings = libraries.length ? {
    ...options, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  } : options;
  const host = ts.createCompilerHost(settings);
  if (libraries.length) {
    const anchor = fileURLToPath(new URL('../package.json', import.meta.url));
    host.resolveModuleNames = (imports, containingFile) => imports.map(name => {
      if (containingFile === filename && !libraries.includes(name)) return undefined;
      const directoryAnchor = containingFile === filename ? anchor : containingFile;
      return ts.resolveModuleName(name, directoryAnchor, settings, host).resolvedModule;
    });
  }
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (file, ...args) => file === filename
    ? ts.createSourceFile(file, source, options.target)
    : getSourceFile(file, ...args);
  // Each activity runs in its own frame with its own global scope.
  return ts.createProgram([filename], settings, host);
}
