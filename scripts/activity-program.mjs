import ts from 'typescript';

const options = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [],
};

export function activityProgram(filename, source) {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (file, ...args) => file === filename
    ? ts.createSourceFile(file, source, options.target)
    : getSourceFile(file, ...args);
  // Each activity runs in its own frame with its own global scope.
  return ts.createProgram([filename], options, host);
}
