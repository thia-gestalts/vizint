import { readFileSync } from 'node:fs';

// Topic and artifact identity from thia-gestalts core.md, pinned to Unicode 16.0.0.
// JavaScript has no full case folding, so the C and F mappings come from the vendored table.
const folding = new Map();
const table = readFileSync(new URL('../vendor/unicode/CaseFolding-16.0.0.txt', import.meta.url), 'utf8');
for (const line of table.split('\n')) {
  const [code, status, mapping] = line.split('#')[0].split(';').map(field => field.trim());
  if (status === 'C' || status === 'F') {
    folding.set(Number.parseInt(code, 16), String.fromCodePoint(...mapping.split(' ').map(hex => Number.parseInt(hex, 16))));
  }
}

// Unicode 16.0.0 White_Space property.
const whiteSpace = new RegExp('[' + [[0x09, 0x0d], [0x20], [0x85], [0xa0], [0x1680], [0x2000, 0x200a], [0x2028, 0x2029],
  [0x202f], [0x205f], [0x3000]].map(([from, to = from]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('') + ']+', 'gu');

export function nameId(name) {
  if (typeof name !== 'string' || !name.isWellFormed()) throw new Error('Expected a well-formed name');
  const normalized = name.normalize('NFC').replace(whiteSpace, ' ').replace(/^ | $/g, '');
  if (!normalized) throw new Error('A normalized name must be nonempty');
  let folded = '';
  for (const character of normalized) folded += folding.get(character.codePointAt(0)) ?? character;
  return 'name:' + Buffer.from(folded.normalize('NFC')).toString('hex');
}
