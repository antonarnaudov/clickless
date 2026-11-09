// Tests for src/main/migrations: turning 0.1's flattened "Parent / Child" folders into real nesting.
//   node --test test/migrations.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clickless-migr-'));
let m;
before(async () => {
  const out = path.join(tmp, 'm.cjs');
  await build({ entryPoints: [path.join(root, 'src/main/migrations.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  m = createRequire(import.meta.url)(out);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const F = (id, name, extra = {}) => ({ id, spaceId: 's1', name, collapsed: true, pinned: true, order: 1, ...extra });

test('flattened folders become sub-folders; a missing parent is created; runs once', () => {
  const st = { folders: [F('a', 'Work'), F('b', 'Work / Docs'), F('c', 'Work / Docs / API'), F('d', 'Home / Recipes'), F('e', 'Plain'), F('x', 'Work / Docs', { pinned: false })] };
  const n = m.nestFlattenedFolders(st);
  const by = (id) => st.folders.find((f) => f.id === id);
  assert.equal(by('b').name, 'Docs');
  assert.equal(by('b').parentId, 'a');
  assert.equal(by('c').name, 'API');
  assert.equal(by('c').parentId, 'b');
  const home = st.folders.find((f) => f.name === 'Home' && !f.parentId);
  assert.ok(home, 'missing parent created');
  assert.equal(by('d').parentId, home.id);
  assert.equal(by('e').parentId, undefined);
  // the Today copy nests under a Today "Work", not the pinned one
  const todayWork = st.folders.find((f) => f.id === by('x').parentId);
  assert.equal(todayWork.pinned, false);
  assert.equal(n, 4);
  assert.equal(m.nestFlattenedFolders(st), 0, 'second run does nothing');
});
