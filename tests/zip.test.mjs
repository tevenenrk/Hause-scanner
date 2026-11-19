import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip, crc32 } from '../src/zip.js';

test('crc32 zgodne ze wzorcem', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('makeZip tworzy poprawne archiwum (sprawdzane przez python zipfile)', () => {
  const zip = makeZip([
    { name: 'README_dla_AI.md', data: '# Zażółć gęślą jaźń' },
    { name: 'kamery/01_salon.jpg', data: new Uint8Array([255, 216, 255, 0, 1, 2, 3]) },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const file = join(dir, 'a.zip');
  writeFileSync(file, zip);
  const out = execFileSync('python3', ['-I', '-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print('|'.join(z.namelist())); print(z.read('README_dla_AI.md').decode())`, file]).toString();
  assert.ok(out.includes('README_dla_AI.md|kamery/01_salon.jpg'));
  assert.ok(out.includes('Zażółć gęślą jaźń'));
});
