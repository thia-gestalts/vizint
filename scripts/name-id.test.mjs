import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nameId } from '../src/name-id.mjs';

// Cases from thia-gestalts examples/v1/identity.json.
test('equal names derive the same identity', () => {
  const equal = [
    ['name:62c3a97a69657220637572766573', 'B\u00e9zier Curves', '\tBE\u0301ZIER\u00a0  CURVES\n'],
    ['name:637572766520736b65746368626f6f6b', 'Curve Sketchbook', 'CURVE\u202fSKETCHBOOK'],
    ['name:73747261737365', 'Stra\u00dfe', 'STRASSE'],
    ['name:c7b0', '\u01f0', 'J\u030c'],
  ];
  for (const [id, ...names] of equal) {
    for (const name of names) assert.equal(nameId(name), id, JSON.stringify(name));
  }
});

test('distinct names keep distinct identities', () => {
  assert.equal(nameId('A-B'), 'name:612d62');
  assert.equal(nameId('A B'), 'name:612062');
  assert.equal(nameId('\u00e9'), 'name:c3a9');
  assert.equal(nameId('e'), 'name:65');
  assert.equal(nameId('\u0130'), 'name:69cc87');
  assert.equal(nameId('I'), 'name:69');
});

test('empty and malformed names are rejected', () => {
  assert.throws(() => nameId(''), /nonempty/);
  assert.throws(() => nameId(' \u3000\n'), /nonempty/);
  assert.throws(() => nameId('a\ud800'), /well-formed/);
});
