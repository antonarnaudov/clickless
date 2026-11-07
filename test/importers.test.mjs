// Tests for src/main/importers: Arc's sidebar file and Chromium's bookmarks + SNSS session log,
// built from synthetic fixtures (no real browser data is read).
//   node --test test/importers.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clickless-import-'));
let m;

before(async () => {
  const out = path.join(tmp, 'importers.cjs');
  await build({ entryPoints: [path.join(root, 'src/main/importers.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  m = createRequire(import.meta.url)(out);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- SNSS writer (the subset Chromium's session service uses) ----
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([i32(b.length), pad(b)]); };
const str16 = (s) => Buffer.concat([i32(s.length), pad(Buffer.from(s, 'utf16le'))]);
const cmd = (id, payload) => { const h = Buffer.alloc(3); h.writeUInt16LE(payload.length + 1); h[2] = id; return Buffer.concat([h, payload]); };
const nav = (tab, idx, url, title) => { const body = Buffer.concat([i32(tab), i32(idx), str(url), str16(title)]); return cmd(6, Buffer.concat([i32(body.length), body])); };

function writeSession(dir, cmds) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Session_1'), Buffer.concat([Buffer.from('SNSS'), i32(3), ...cmds]));
}

test('SNSS: open tabs in window order, current navigation, closed tabs dropped', () => {
  const dir = path.join(tmp, 'Sessions');
  writeSession(dir, [
    cmd(0, Buffer.concat([i32(1), i32(10)])), // window 1, tab 10
    cmd(0, Buffer.concat([i32(1), i32(11)])),
    cmd(0, Buffer.concat([i32(1), i32(12)])),
    cmd(2, Buffer.concat([i32(10), i32(1)])), // tab 10 at index 1
    cmd(2, Buffer.concat([i32(11), i32(0)])),
    cmd(2, Buffer.concat([i32(12), i32(2)])),
    nav(10, 0, 'https://a.example/', 'A first'),
    nav(10, 1, 'https://a.example/next', 'A — next page ✓'),
    cmd(7, Buffer.concat([i32(10), i32(1)])),
    nav(11, 0, 'https://b.example/', 'B'),
    nav(12, 0, 'https://closed.example/', 'Closed'),
    cmd(16, i32(12)), // tab 12 closed
    nav(13, 0, 'chrome://settings/', 'Settings'), // internal page: skipped
  ]);
  const tabs = m.readSessionTabs(dir);
  assert.deepEqual(tabs.map((t) => t.url), ['https://b.example/', 'https://a.example/next']);
  assert.equal(tabs[1].title, 'A — next page ✓');
});

test('Chromium profile: bookmark bar folders, other bookmarks, open tabs in a pinned folder', () => {
  const prof = path.join(tmp, 'Default');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(
    path.join(prof, 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: { children: [
          { type: 'url', name: 'GitHub', url: 'https://github.com/' },
          { type: 'folder', name: 'Work', children: [{ type: 'url', name: 'Docs', url: 'https://docs.example/' }, { type: 'folder', name: 'Deep', children: [{ type: 'url', name: 'X', url: 'https://x.example/' }] }] },
        ] },
        other: { children: [{ type: 'url', name: 'Later', url: 'https://later.example/' }] },
      },
    }),
  );
  writeSession(path.join(prof, 'Sessions'), [nav(1, 0, 'https://open.example/', 'Open one')]);
  const plan = m.readChromium('Comet', prof, '☄️');
  const sp = plan.spaces[0];
  assert.equal(sp.name, 'Comet');
  assert.deepEqual(sp.today, []);
  assert.equal(sp.pinned[0].kind, 'folder');
  assert.equal(sp.pinned[0].name, 'Open tabs');
  assert.equal(sp.pinned[0].children[0].url, 'https://open.example/');
  assert.deepEqual(sp.pinned.map((n) => n.name ?? n.title), ['Open tabs', 'GitHub', 'Work', 'Other bookmarks']);
  assert.deepEqual(m.countPlan(plan), { tabs: 5, folders: 4 });
});

test('Arc: spaces with pinned, folders, split views, Today and favourites', () => {
  const tab = (id, url, title, parent) => [id, { id, title: null, parentID: parent, childrenIds: [], data: { tab: { savedURL: url, savedTitle: title } } }];
  const items = [
    ['pin1', { id: 'pin1', childrenIds: ['t1', 'f1', 'sv1', 'e1'], data: { itemContainer: { containerType: { spaceItems: { _0: 'sp1' } } } } }],
    tab('t1', 'https://one.example/', 'One', 'pin1'),
    ['f1', { id: 'f1', title: 'Tools', childrenIds: ['t2', 'f2'], data: { list: {} } }],
    tab('t2', 'https://two.example/', 'Two', 'f1'),
    ['f2', { id: 'f2', title: 'Nested', childrenIds: ['t3'], data: { list: {} } }],
    tab('t3', 'https://three.example/', 'Three', 'f2'),
    ['sv1', { id: 'sv1', childrenIds: ['t4', 't5'], data: { splitView: {} } }],
    tab('t4', 'https://left.example/', 'Left', 'sv1'),
    tab('t5', 'https://right.example/', 'Right', 'sv1'),
    ['e1', { id: 'e1', title: 'Easel', childrenIds: [], data: { easel: {} } }],
    ['un1', { id: 'un1', childrenIds: ['t6'], data: { itemContainer: {} } }],
    tab('t6', 'https://today.example/', 'Today', 'un1'),
    ['fav', { id: 'fav', childrenIds: ['t7'], data: { itemContainer: { containerType: { topApps: {} } } } }],
    tab('t7', 'https://fav.example/', 'Fav', 'fav'),
  ].flat();
  const file = path.join(tmp, 'StorableSidebar.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      sidebar: { containers: [{ global: {} }, {
        spaces: ['sp1', { id: 'sp1', title: 'Work Space', customInfo: { iconType: { emoji_v2: '🪐' } }, containerIDs: ['pinned', 'pin1', 'unpinned', 'un1'] }],
        items,
        topAppsContainerIDs: [{ default: true }, 'fav'],
      }] },
    }),
  );
  const plan = m.readArc(file);
  assert.equal(plan.spaces.length, 1);
  const sp = plan.spaces[0];
  assert.equal(sp.name, 'Work Space');
  assert.equal(sp.icon, '🪐');
  assert.deepEqual(sp.favorites.map((t) => t.url), ['https://fav.example/']);
  assert.deepEqual(sp.today.map((t) => t.url), ['https://today.example/']);
  // tab, folder, then the split view's two tabs inline; the easel is dropped
  assert.deepEqual(sp.pinned.map((n) => n.kind === 'tab' ? n.url : n.name), ['https://one.example/', 'Tools', 'https://left.example/', 'https://right.example/']);
  assert.equal(sp.pinned[1].children[1].name, 'Nested');
});
