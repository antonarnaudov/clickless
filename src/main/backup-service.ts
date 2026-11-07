// Runs encrypted backups for the app: on demand, daily/weekly in the background, and restores.
// The passphrase and the GitHub token live in the OS keychain-backed secret store; the UI only
// learns whether they're set. See backup.ts for the format and what's included.

import { app, dialog } from 'electron';
import fs from 'node:fs';
import type { BackupTarget, Settings } from '../shared/types';
import type { Clickless } from './browser';
import {
  BACKUP_EXT,
  MIN_PASSPHRASE,
  checkGithubRepo,
  decryptBackup,
  describeTarget,
  encryptBackup,
  latestInFolder,
  readFromGithub,
  scrubState,
  writeToFolder,
  writeToGithub,
  type BackupPayload,
} from './backup';
import { flushState, replaceData, type PersistedState } from './store';

const PASS = 'backup.passphrase';
const TOKEN = 'backup.githubToken';
const DAY = 86_400_000;

export interface BackupResult {
  where: string;
  at: number;
  bytes: number;
}

export class BackupService {
  running = false;

  constructor(private b: Clickless) {
    // first check two minutes after start, then every 15 minutes
    setTimeout(() => this.maybeAuto(), 120_000).unref?.();
    setInterval(() => this.maybeAuto(), 15 * 60_000).unref?.();
  }

  status() {
    return { hasPassphrase: this.b.secrets.has(PASS), hasGithubToken: this.b.secrets.has(TOKEN), running: this.running };
  }

  private get cfg(): Settings['backup'] {
    return this.b.state.settings.backup;
  }

  private patch(p: Partial<Settings['backup']>) {
    this.b.state.settings = { ...this.b.state.settings, backup: { ...this.cfg, ...p } };
    this.b.save();
    this.b.pushState();
  }

  async configure(c: { target?: BackupTarget | null; schedule?: Settings['backup']['schedule']; keep?: number; passphrase?: string | null; githubToken?: string | null }) {
    if (c.passphrase !== undefined) {
      if (c.passphrase !== null && c.passphrase.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters for the passphrase.`);
      this.b.secrets.set(PASS, c.passphrase);
    }
    if (c.githubToken !== undefined) this.b.secrets.set(TOKEN, c.githubToken?.trim() || null);
    const next: Partial<Settings['backup']> = {};
    if (c.target !== undefined) {
      if (c.target?.kind === 'github') {
        const repo = c.target.repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
        next.target = { kind: 'github', repo };
      } else next.target = c.target;
      next.lastError = null;
    }
    if (c.schedule) next.schedule = c.schedule;
    if (c.keep !== undefined) next.keep = Math.max(1, Math.min(100, Math.round(c.keep)));
    this.patch(next);
    // a GitHub target is checked right away, so mistakes show up now and not at 3 a.m.
    const t = this.cfg.target;
    if (t?.kind === 'github' && (c.target !== undefined || c.githubToken)) {
      try {
        await checkGithubRepo(t.repo, this.b.secrets.get(TOKEN) ?? '');
      } catch (err) {
        this.patch({ lastError: (err as Error).message });
        throw err;
      }
    }
    return this.status();
  }

  async chooseFolder(): Promise<string | null> {
    const r = await dialog.showOpenDialog({ title: 'Choose where Clickless keeps encrypted backups', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Use this folder' });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  }

  private payload(): BackupPayload {
    flushState();
    this.b.history.flush();
    const state = this.b.persistedState();
    return { app: 'clickless', createdAt: Date.now(), appVersion: app.getVersion(), state: scrubState(state), history: this.b.history.all() };
  }

  async run(): Promise<BackupResult> {
    const t = this.cfg.target;
    if (!t) throw new Error('Backups are off. Choose a folder or a private GitHub repository in Settings → Backup.');
    const pass = this.b.secrets.get(PASS);
    if (!pass) throw new Error('Set a backup passphrase first (Settings → Backup).');
    if (this.running) throw new Error('A backup is already running.');
    this.running = true;
    this.b.pushState();
    try {
      const p = this.payload();
      const text = await encryptBackup(p, pass);
      const where = t.kind === 'folder' ? writeToFolder(t.folder, text, p.createdAt, this.cfg.keep) : await writeToGithub(t.repo, this.b.secrets.get(TOKEN) ?? '', text, p.createdAt);
      this.patch({ lastAt: p.createdAt, lastWhere: where, lastError: null });
      return { where, at: p.createdAt, bytes: text.length };
    } catch (err) {
      this.patch({ lastError: (err as Error).message });
      throw err;
    } finally {
      this.running = false;
      this.b.pushState();
    }
  }

  private async maybeAuto() {
    const c = this.cfg;
    if (!c.target || c.schedule === 'manual' || this.running || !this.b.secrets.has(PASS)) return;
    const every = c.schedule === 'weekly' ? 7 * DAY : DAY;
    if (c.lastAt && Date.now() - c.lastAt < every) return;
    // after a failure, wait an hour before trying again
    if (c.lastError && c.lastAt && Date.now() - c.lastAt < every + 3_600_000) return;
    await this.run().catch(() => {});
  }

  /** Decrypts a backup from a file (picked in a dialog when none is given) or the configured target, then replaces this profile's data and relaunches. */
  async restore(c: { from: 'file' | 'target'; file?: string; passphrase?: string }): Promise<{ restored: string }> {
    const pass = c.passphrase || this.b.secrets.get(PASS);
    if (!pass) throw new Error('Enter the passphrase the backup was made with.');
    let text: string;
    let source: string;
    if (c.from === 'file') {
      let file = c.file;
      if (!file) {
        const r = await dialog.showOpenDialog({ title: 'Choose a Clickless backup', properties: ['openFile'], filters: [{ name: 'Clickless backup', extensions: [BACKUP_EXT.slice(1)] }] });
        if (r.canceled || !r.filePaths[0]) throw new Error('No file chosen.');
        file = r.filePaths[0];
      }
      text = fs.readFileSync(file, 'utf8');
      source = file;
    } else {
      const t = this.cfg.target;
      if (!t) throw new Error('Choose where your backups are first.');
      if (t.kind === 'folder') {
        const f = latestInFolder(t.folder);
        if (!f) throw new Error(`No Clickless backups in ${t.folder}.`);
        text = fs.readFileSync(f, 'utf8');
        source = f;
      } else {
        text = await readFromGithub(t.repo, this.b.secrets.get(TOKEN) ?? '');
        source = describeTarget(t);
      }
    }
    const payload = await decryptBackup(text, pass);
    const restored = payload.state as PersistedState;
    if (!restored || (restored as any).version !== 1 || !Array.isArray(restored.spaces)) throw new Error('The backup doesn’t contain a Clickless profile.');
    // keep this machine's backup setup and key flags; everything else comes from the backup
    restored.settings = {
      ...restored.settings,
      backup: { ...this.cfg },
      providers: (restored.settings?.providers ?? []).map((p) => ({ ...p, hasKey: this.b.secrets.has(`provider.${p.id}`) })),
    };
    this.b.secrets.set(PASS, pass);
    replaceData(restored, (payload.history ?? []) as any);
    app.relaunch();
    app.exit(0);
    return { restored: source };
  }
}
