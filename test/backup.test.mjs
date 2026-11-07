// Tests for src/main/backup: encryption round trip, wrong passphrase / tampering, scrubbing,
// folder rotation and the GitHub target (against a fake API; nothing leaves the machine).
//   node --test test/backup.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clickless-backup-'));
let m;

before(async () => {
  const out = path.join(tmp, 'backup.cjs');
  await build({ entryPoints: [path.join(root, 'src/main/backup.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  m = createRequire(import.meta.url)(out);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PASS = 'correct horse battery';
const payload = () => ({
  app: 'clickless',
  createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  appVersion: '0.1.0',
  state: { version: 1, spaces: [{ id: 's1', name: 'Personal' }], tabs: [{ id: 't1', url: 'https://example.com/', title: 'Example' }], settings: { providers: [{ id: 'p1', kind: 'anthropic', apiKey: 'sk-should-not-be-here' }] } },
  history: [{ url: 'https://example.org/', title: 'Org', visitCount: 2, lastVisitAt: 1 }],
});

test('encrypts and decrypts; nothing readable in the file', async () => {
  const text = await m.encryptBackup(payload(), PASS);
  assert.ok(!text.includes('example.com') && !text.includes('Personal'), 'plaintext leaked into the backup file');
  const env = JSON.parse(text);
  assert.equal(env.format, 'clickless-backup');
  assert.equal(env.cipher, 'aes-256-gcm');
  const back = await m.decryptBackup(text, PASS);
  assert.deepEqual(back, payload());
});

test('wrong passphrase, tampered data and tampered header are refused', async () => {
  const text = await m.encryptBackup(payload(), PASS);
  await assert.rejects(m.decryptBackup(text, 'wrong passphrase!'), /Wrong passphrase/);
  const env = JSON.parse(text);
  const flipped = Buffer.from(env.data, 'base64');
  flipped[5] ^= 1;
  await assert.rejects(m.decryptBackup(JSON.stringify({ ...env, data: flipped.toString('base64') }), PASS), /Wrong passphrase|damaged/);
  await assert.rejects(m.decryptBackup(JSON.stringify({ ...env, createdAt: '2020-01-01T00:00:00.000Z' }), PASS), /Wrong passphrase|damaged/);
  await assert.rejects(m.decryptBackup(JSON.stringify({ ...env, kdf: { ...env.kdf, N: 2 ** 30 } }), PASS), /unusual/);
  await assert.rejects(m.decryptBackup('not json', PASS), /not a Clickless backup/);
});

test('short passphrases are refused; secrets are scrubbed', async () => {
  await assert.rejects(m.encryptBackup(payload(), 'short'), /at least 10/);
  const s = m.scrubState(payload().state);
  assert.equal(s.settings.providers[0].apiKey, undefined);
  assert.equal(s.settings.providers[0].kind, 'anthropic');
});

test('folder target: writes dated files, keeps the newest N, ignores other files', () => {
  const dir = path.join(tmp, 'drive');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
  for (let i = 0; i < 5; i++) m.writeToFolder(dir, `backup ${i}`, Date.UTC(2026, 0, 1 + i, 9), 3);
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.filter((f) => f.endsWith('.clickless-backup')).length, 3);
  assert.ok(files.includes('notes.txt'));
  assert.equal(fs.readFileSync(m.latestInFolder(dir), 'utf8'), 'backup 4');
  assert.throws(() => m.writeToFolder(path.join(tmp, 'missing'), 'x', Date.now()), /isn’t there/);
  assert.throws(() => m.writeToFolder('relative/dir', 'x', Date.now()), /Choose a folder/);
});

function fakeGithub({ isPrivate = true, push = true } = {}) {
  const files = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    assert.equal(init.headers.authorization, 'Bearer tok');
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/repos/me/backups') return json(200, { private: isPrivate, permissions: { push } });
    const m2 = /^\/repos\/me\/backups\/contents\/(.+)$/.exec(u.pathname);
    if (m2) {
      const f = files.get(m2[1]);
      if ((init.method ?? 'GET') === 'GET') {
        if (!f) return json(404, {});
        if (init.headers.accept === 'application/vnd.github.raw+json') return new Response(Buffer.from(f.content, 'base64').toString('utf8'), { status: 200 });
        return json(200, { sha: f.sha });
      }
      const body = JSON.parse(init.body);
      if (f && body.sha !== f.sha) return json(409, {});
      files.set(m2[1], { content: body.content, sha: `sha${files.size + 1}-${Date.now()}` });
      return json(f ? 200 : 201, {});
    }
    return json(404, {});
  };
  return { fetchImpl, files, calls };
}

test('GitHub target: refuses public repos and read-only tokens', async () => {
  await assert.rejects(m.writeToGithub('me/backups', 'tok', 'x', Date.now(), fakeGithub({ isPrivate: false }).fetchImpl), /public/);
  await assert.rejects(m.writeToGithub('me/backups', 'tok', 'x', Date.now(), fakeGithub({ push: false }).fetchImpl), /can’t write/);
  await assert.rejects(m.checkGithubRepo('not a repo', 'tok', fakeGithub().fetchImpl), /owner\/name/);
});

test('GitHub target: creates, then updates the same file; reads it back', async () => {
  const gh = fakeGithub();
  await m.writeToGithub('me/backups', 'tok', 'first', Date.now(), gh.fetchImpl);
  await m.writeToGithub('me/backups', 'tok', 'second', Date.now(), gh.fetchImpl);
  assert.equal(gh.files.size, 1);
  assert.equal(await m.readFromGithub('me/backups', 'tok', gh.fetchImpl), 'second');
  assert.ok(gh.calls.filter((c) => c.startsWith('PUT')).length === 2);
});
