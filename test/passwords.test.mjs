// Tests for src/main/passwords: encrypted storage, save/update/never, CSV import and export.
// A fake keychain stands in for safeStorage. Synthetic logins only.
//   node --test test/passwords.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clickless-pw-'));
let m;
before(async () => {
  const out = path.join(tmp, 'pw.cjs');
  await build({ entryPoints: [path.join(root, 'src/main/passwords.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  m = createRequire(import.meta.url)(out);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// a stand-in keychain: reversible, but nothing readable on disk
const crypter = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString() };

test('saves encrypted, fills by exact origin, updates and never', () => {
  const file = path.join(tmp, 'a.json');
  const st = new m.PasswordStore(file, crypter);
  assert.equal(st.check('https://app.example.com', 'ada', 'pw-1'), 'new');
  const l = st.upsert({ origin: 'https://app.example.com', username: 'ada', password: 'Very-Secret-1' });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('Very-Secret-1'), 'plaintext on disk');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.equal(st.check('https://app.example.com', 'ada', 'Very-Secret-1'), 'same');
  assert.equal(st.check('https://app.example.com', 'ada', 'Other-2'), 'update');
  assert.equal(st.forOrigin('https://example.com').length, 0, 'other origins never match');
  assert.equal(st.reveal(l.id).password, 'Very-Secret-1');
  assert.ok(!('secret' in st.list()[0]) && !('password' in st.list()[0]), 'lists never carry passwords');
  st.setNever('https://bank.example', true);
  assert.equal(st.check('https://bank.example', 'x', 'y'), 'never');
  const again = new m.PasswordStore(file, crypter);
  assert.equal(again.count(), 1);
  assert.deepEqual(again.neverList(), ['https://bank.example']);
});

test('imports Chrome and Safari CSV exports; export round-trips', () => {
  const st = new m.PasswordStore(path.join(tmp, 'b.json'), crypter);
  const chrome = 'name,url,username,password,note\nexample.com,https://example.com/login,ada,"p,a""ss",\nbad,not a url,x,y,\nempty,https://empty.example,,,\n';
  const safari = 'Title,URL,Username,Password,Notes,OTPAuth\nShop,https://shop.example/,ada@example.com,Shop-pass-9,,\n';
  assert.deepEqual(st.importCsv(chrome), { added: 1, updated: 0, skipped: 2 });
  assert.deepEqual(st.importCsv(safari), { added: 1, updated: 0, skipped: 0 });
  assert.deepEqual(st.importCsv(chrome), { added: 0, updated: 0, skipped: 3 }, 'a second import adds nothing');
  const l = st.forOrigin('https://example.com')[0];
  assert.equal(st.reveal(l.id).password, 'p,a"ss');
  const csv = st.exportCsv();
  const back = new m.PasswordStore(path.join(tmp, 'c.json'), crypter);
  assert.deepEqual(back.importCsv(csv), { added: 2, updated: 0, skipped: 0 });
  assert.throws(() => st.importCsv('a,b\n1,2\n'), /no url and password/);
});
