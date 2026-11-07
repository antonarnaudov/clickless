// Encrypted backups — optional, off by default. What makes Clickless yours (spaces, tabs, folders,
// favourites, archive, history, settings) is encrypted on this machine with the user's passphrase
// (scrypt → AES-256-GCM) and only then written to the place they chose: a folder (iCloud Drive,
// Google Drive, Dropbox, OneDrive Personal Vault, a Cryptomator vault, a USB drive) or a private
// GitHub repository. Never included: passwords, logins, cookies, API keys, the control token.
// No Electron imports here, so it can be tested on its own.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BackupTarget } from '../shared/types';

export const BACKUP_EXT = '.clickless-backup';
export const MIN_PASSPHRASE = 10;
const GITHUB_PATH = `clickless${BACKUP_EXT}`;
const KDF = { name: 'scrypt' as const, N: 2 ** 17, r: 8, p: 1 };

export interface BackupPayload {
  app: 'clickless';
  createdAt: number;
  appVersion: string;
  /** The persisted browser state (state.json), secrets removed. */
  state: unknown;
  /** history.json */
  history: unknown[];
}

interface Envelope {
  format: 'clickless-backup';
  v: 1;
  createdAt: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(passphrase: string, salt: Buffer, k: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(passphrase.normalize('NFKC'), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * k.N * k.r + 32 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function encryptBackup(payload: BackupPayload, passphrase: string): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`The backup passphrase needs at least ${MIN_PASSPHRASE} characters.`);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(passphrase, salt, KDF);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const header = { format: 'clickless-backup' as const, v: 1 as const, createdAt: new Date(payload.createdAt).toISOString(), kdf: { ...KDF, salt: salt.toString('base64') }, cipher: 'aes-256-gcm' as const };
  // the readable header is authenticated too: changing it breaks decryption
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const data = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(payload)))), cipher.final()]);
  const env: Envelope = { ...header, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  return JSON.stringify(env);
}

export async function decryptBackup(text: string, passphrase: string): Promise<BackupPayload> {
  let env: Envelope;
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error('This is not a Clickless backup file.');
  }
  if (env?.format !== 'clickless-backup' || env.v !== 1 || env.cipher !== 'aes-256-gcm' || env.kdf?.name !== 'scrypt') throw new Error('This is not a Clickless backup file (or it was made by a newer version).');
  const { N, r, p } = env.kdf;
  if (!(N >= 2 ** 14 && N <= 2 ** 20 && r >= 1 && r <= 16 && p >= 1 && p <= 4)) throw new Error('The backup has unusual encryption settings; refusing to open it.');
  const key = await deriveKey(passphrase, Buffer.from(env.kdf.salt, 'base64'), { N, r, p });
  const header = { format: env.format, v: env.v, createdAt: env.createdAt, kdf: env.kdf, cipher: env.cipher };
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAAD(Buffer.from(JSON.stringify(header)));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]);
    const payload = JSON.parse(zlib.gunzipSync(plain).toString('utf8')) as BackupPayload;
    if (payload?.app !== 'clickless' || !payload.state) throw new Error('empty');
    return payload;
  } catch {
    throw new Error('Wrong passphrase, or the backup file is damaged.');
  }
}

/** Removes anything secret from the persisted state before it goes into a backup. */
export function scrubState<T>(state: T): T {
  const s = JSON.parse(JSON.stringify(state ?? {}));
  for (const p of s?.settings?.providers ?? []) {
    delete p.apiKey;
    delete p.key;
    delete p.token;
  }
  return s;
}

// ---------------------------------------------------------------------------
// destinations
// ---------------------------------------------------------------------------

const stamp = (t: number) => {
  const d = new Date(t);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};
const isBackupFile = (f: string) => /^Clickless backup \d{4}-\d\d-\d\d \d{6}\.clickless-backup$/.test(f);

export function writeToFolder(folder: string, text: string, createdAt: number, keep = 10): string {
  if (!folder || !path.isAbsolute(folder)) throw new Error('Choose a folder for backups first.');
  if (!fs.existsSync(folder)) throw new Error(`The backup folder isn’t there: ${folder}`);
  const file = path.join(folder, `Clickless backup ${stamp(createdAt)}${BACKUP_EXT}`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  // keep the newest `keep` backups; never touch other files
  const ours = fs.readdirSync(folder).filter(isBackupFile).sort().reverse();
  for (const old of ours.slice(Math.max(1, keep))) fs.rmSync(path.join(folder, old), { force: true });
  return file;
}

export function latestInFolder(folder: string): string | null {
  try {
    const f = fs.readdirSync(folder).filter(isBackupFile).sort().pop();
    return f ? path.join(folder, f) : null;
  } catch {
    return null;
  }
}

type Fetch = typeof fetch;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

async function gh(fetchImpl: Fetch, token: string, url: string, init: RequestInit = {}) {
  const res = await fetchImpl(`https://api.github.com${url}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'Clickless', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  return res;
}

/** Throws unless `repo` exists, is private, and the token can write to it. */
export async function checkGithubRepo(repo: string, token: string, fetchImpl: Fetch = fetch): Promise<void> {
  if (!REPO_RE.test(repo)) throw new Error('Write the repository as owner/name.');
  if (!token) throw new Error('Add a GitHub token for the backup repository.');
  const r = await gh(fetchImpl, token, `/repos/${repo}`);
  if (r.status === 404) throw new Error(`Can’t see ${repo}: check the name and that the token has access to it.`);
  if (r.status === 401) throw new Error('GitHub refused the token (expired or revoked?).');
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${repo}.`);
  const j = (await r.json()) as { private?: boolean; permissions?: { push?: boolean } };
  if (j.private !== true) throw new Error(`${repo} is public. Clickless only backs up to a private repository.`);
  if (j.permissions && j.permissions.push === false) throw new Error(`The token can’t write to ${repo} (it needs Contents: read and write).`);
}

export async function writeToGithub(repo: string, token: string, text: string, createdAt: number, fetchImpl: Fetch = fetch): Promise<string> {
  await checkGithubRepo(repo, token, fetchImpl);
  const url = `/repos/${repo}/contents/${GITHUB_PATH}`;
  const cur = await gh(fetchImpl, token, url);
  const sha = cur.ok ? ((await cur.json()) as { sha?: string }).sha : undefined;
  const put = await gh(fetchImpl, token, url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: `Clickless backup ${stamp(createdAt)}`, content: Buffer.from(text, 'utf8').toString('base64'), ...(sha ? { sha } : {}) }),
  });
  if (!put.ok) throw new Error(`GitHub didn’t take the backup (${put.status}).`);
  return `github.com/${repo}/${GITHUB_PATH}`;
}

export async function readFromGithub(repo: string, token: string, fetchImpl: Fetch = fetch): Promise<string> {
  await checkGithubRepo(repo, token, fetchImpl);
  const r = await gh(fetchImpl, token, `/repos/${repo}/contents/${GITHUB_PATH}`, { headers: { accept: 'application/vnd.github.raw+json' } });
  if (r.status === 404) throw new Error(`There’s no backup in ${repo} yet.`);
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  return await r.text();
}

export function describeTarget(t: BackupTarget | null): string {
  if (!t) return 'off';
  return t.kind === 'folder' ? t.folder : `github.com/${t.repo} (private)`;
}
