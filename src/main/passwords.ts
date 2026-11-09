// Saved passwords: kept on this Mac only, each one encrypted with the OS keychain (safeStorage).
// The UI and agents only ever see sites and usernames; a password is decrypted to fill a form the
// user chose a login for, or to show it in Settings after the user confirms (Touch ID when there is
// one). Agents' own browsers have no password store at all.
//
// CSV import/export uses the columns Chrome, Comet, Arc and Edge export (name,url,username,password,note);
// Safari's (Title,URL,Username,Password,Notes) and Firefox's (url,username,password,…) are read too.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SavedLogin {
  id: string;
  /** https://example.com — logins are filled only on exactly this origin. */
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  note?: string;
}

interface StoredLogin extends SavedLogin {
  /** enc:<base64> (keychain-encrypted) or raw:<base64> where no keychain is available. */
  secret: string;
}

interface Vault {
  version: 1;
  logins: StoredLogin[];
  /** Sites the user said "never save" for. */
  never: string[];
}

export interface Crypter {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

/** https://www.example.com/login?x → https://www.example.com (null for anything that isn't http(s)). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    try {
      return /^[\w.-]+\.[a-z]{2,}$/i.test(url.trim()) ? new URL(`https://${url.trim()}`).origin : null;
    } catch {
      return null;
    }
  }
}

export class PasswordStore {
  private vault: Vault;

  constructor(
    private file: string,
    private crypter: Crypter,
  ) {
    this.vault = { version: 1, logins: [], never: [] };
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Vault;
      if (v?.version === 1) this.vault = { version: 1, logins: v.logins ?? [], never: v.never ?? [] };
    } catch {
      /* no passwords yet */
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.vault), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private seal(pw: string): string {
    return this.crypter.isEncryptionAvailable() ? 'enc:' + this.crypter.encryptString(pw).toString('base64') : 'raw:' + Buffer.from(pw, 'utf8').toString('base64');
  }

  private open(secret: string): string {
    if (secret.startsWith('enc:')) return this.crypter.decryptString(Buffer.from(secret.slice(4), 'base64'));
    if (secret.startsWith('raw:')) return Buffer.from(secret.slice(4), 'base64').toString('utf8');
    return '';
  }

  private pub(l: StoredLogin): SavedLogin {
    const { secret: _s, ...rest } = l;
    return rest;
  }

  list(query = ''): SavedLogin[] {
    const q = query.trim().toLowerCase();
    return this.vault.logins
      .filter((l) => !q || l.origin.toLowerCase().includes(q) || l.username.toLowerCase().includes(q))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
      .map((l) => this.pub(l));
  }

  count() {
    return this.vault.logins.length;
  }

  forOrigin(origin: string): SavedLogin[] {
    return this.vault.logins.filter((l) => l.origin === origin).sort((a, b) => b.lastUsedAt - a.lastUsedAt).map((l) => this.pub(l));
  }

  /** The password, for filling a form or showing it after the user confirmed. */
  reveal(id: string): { origin: string; username: string; password: string } | null {
    const l = this.vault.logins.find((x) => x.id === id);
    if (!l) return null;
    return { origin: l.origin, username: l.username, password: this.open(l.secret) };
  }

  markUsed(id: string) {
    const l = this.vault.logins.find((x) => x.id === id);
    if (!l) return;
    l.lastUsedAt = Date.now();
    this.persist();
  }

  /** What saving these would do: nothing new, a new login, or a changed password. */
  check(origin: string, username: string, password: string): 'same' | 'new' | 'update' | 'never' {
    if (this.vault.never.includes(origin)) return 'never';
    const l = this.vault.logins.find((x) => x.origin === origin && x.username === username);
    if (!l) return 'new';
    return this.open(l.secret) === password ? 'same' : 'update';
  }

  upsert(p: { id?: string; origin: string; username: string; password?: string; note?: string }): SavedLogin {
    const now = Date.now();
    let l = p.id ? this.vault.logins.find((x) => x.id === p.id) : this.vault.logins.find((x) => x.origin === p.origin && x.username === p.username);
    if (l) {
      l.origin = p.origin;
      l.username = p.username;
      if (p.password !== undefined) l.secret = this.seal(p.password);
      if (p.note !== undefined) l.note = p.note || undefined;
      l.updatedAt = now;
    } else {
      l = { id: 'pw' + crypto.randomBytes(6).toString('hex'), origin: p.origin, username: p.username, secret: this.seal(p.password ?? ''), createdAt: now, updatedAt: now, lastUsedAt: now, note: p.note || undefined };
      this.vault.logins.push(l);
    }
    this.persist();
    return this.pub(l);
  }

  remove(id: string) {
    this.vault.logins = this.vault.logins.filter((x) => x.id !== id);
    this.persist();
  }

  neverList() {
    return [...this.vault.never].sort();
  }

  setNever(origin: string, never: boolean) {
    this.vault.never = this.vault.never.filter((o) => o !== origin);
    if (never) this.vault.never.push(origin);
    this.persist();
  }

  /** Adds logins from a browser's CSV export. Returns how many were added, updated and skipped. */
  importCsv(text: string): { added: number; updated: number; skipped: number } {
    const rows = parseCsv(text);
    const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
    const cUrl = col('url', 'origin', 'website', 'login_uri', 'login uri');
    const cUser = col('username', 'login', 'email', 'login_username', 'user');
    const cPass = col('password', 'login_password');
    const cNote = col('note', 'notes', 'extra');
    if (cUrl < 0 || cPass < 0) throw new Error('This CSV has no url and password columns (export your passwords from the other browser as CSV).');
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const r of rows) {
      const origin = originOf(r[cUrl] ?? '');
      const password = r[cPass] ?? '';
      if (!origin || !password) {
        skipped++;
        continue;
      }
      const username = cUser >= 0 ? (r[cUser] ?? '') : '';
      const state = this.check(origin, username, password);
      if (state === 'same') {
        skipped++;
        continue;
      }
      if (state === 'update') updated++;
      else added++;
      this.upsertQuiet({ origin, username, password, note: cNote >= 0 ? r[cNote] : undefined });
    }
    this.persist();
    return { added, updated, skipped };
  }

  private upsertQuiet(p: { origin: string; username: string; password: string; note?: string }) {
    const now = Date.now();
    const l = this.vault.logins.find((x) => x.origin === p.origin && x.username === p.username);
    if (l) {
      l.secret = this.seal(p.password);
      l.updatedAt = now;
    } else this.vault.logins.push({ id: 'pw' + crypto.randomBytes(6).toString('hex'), origin: p.origin, username: p.username, secret: this.seal(p.password), createdAt: now, updatedAt: now, lastUsedAt: 0, note: p.note || undefined });
  }

  /** Chrome-compatible CSV of every login (the caller asks the user first). */
  exportCsv(): string {
    const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = ['name,url,username,password,note'];
    for (const l of this.vault.logins) lines.push([new URL(l.origin).host, l.origin, l.username, this.open(l.secret), l.note ?? ''].map(q).join(','));
    return lines.join('\n') + '\n';
  }
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        f += '"';
        i++;
      } else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(f);
      f = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(f);
      f = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else f += ch;
  }
  row.push(f);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}
