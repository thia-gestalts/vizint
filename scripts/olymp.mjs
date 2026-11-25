// Extract the verified runtime into the independently deployable application.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const archive = fileURLToPath(new URL('../vendor/thia-olymp-1.1.0.tgz', import.meta.url));
const checksum = '4266f2c8533f31e2b440879b96615abfefd3fc850ad85e3234c58dbc8b443c14';
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== checksum)
  throw Error('Olymp SDK checksum mismatch');
const output = fileURLToPath(new URL('../dist/olymp/', import.meta.url));
mkdirSync(output, { recursive: true });
execFileSync('tar', ['-xzf', archive, '-C', output, '--strip-components=2', 'package/web'], { stdio: 'inherit' });
