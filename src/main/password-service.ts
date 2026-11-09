// Saved passwords for the user's browser (never in an agent's own browser): offers to save after a
// sign-in, fills on request from a sign-in form, and backs Settings → Passwords.

import { dialog, ipcMain, safeStorage, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import type { Clickless } from './browser';
import { PasswordStore, originOf, type SavedLogin } from './passwords';
import { dataDir } from './store';

export class PasswordService {
  readonly store: PasswordStore;

  constructor(private b: Clickless) {
    this.store = new PasswordStore(path.join(dataDir(), 'passwords.json'), safeStorage);
    ipcMain.handle(IPC.pwQuery, (e, p: { origin?: string }) => this.query(e, p));
    ipcMain.handle(IPC.pwFill, (e, p: { origin?: string; id?: string }) => this.fill(e, p));
    ipcMain.on(IPC.pwSubmit, (e, p: { origin?: string; username?: string; password?: string }) => this.submitted(e, p));
  }

  /** The tab and origin a message comes from, if it's a page of the user's own browser. */
  private sender(e: IpcMainEvent | IpcMainInvokeEvent, claimed?: string): { tabId: string; origin: string } | null {
    const tabId = this.b.tabIdOf(e.sender);
    const frameUrl = e.senderFrame?.url ?? '';
    const origin = originOf(frameUrl);
    if (!tabId || !origin || origin !== claimed) return null;
    return { tabId, origin };
  }

  private query(e: IpcMainInvokeEvent, p: { origin?: string }) {
    const s = this.sender(e, p.origin);
    if (!s || !this.b.state.settings.passwords.autofill || this.b.agentActiveOn(s.tabId)) return [];
    return this.store.forOrigin(s.origin).map((l) => ({ id: l.id, username: l.username }));
  }

  private fill(e: IpcMainInvokeEvent, p: { origin?: string; id?: string }) {
    const s = this.sender(e, p.origin);
    // agents never get a password filled for them
    if (!s || !p.id || !this.b.state.settings.passwords.autofill || this.b.agentActiveOn(s.tabId)) return null;
    const l = this.store.reveal(p.id);
    if (!l || l.origin !== s.origin) return null;
    this.store.markUsed(p.id);
    return { username: l.username, password: l.password };
  }

  private submitted(e: IpcMainEvent, p: { origin?: string; username?: string; password?: string }) {
    const s = this.sender(e, p.origin);
    if (!s || !p.password || !this.b.state.settings.passwords.offer || this.b.agentActiveOn(s.tabId)) return;
    const username = String(p.username ?? '').slice(0, 200);
    const password = String(p.password).slice(0, 500);
    const state = this.store.check(s.origin, username, password);
    if (state === 'never') return;
    if (state === 'same') {
      const l = this.store.forOrigin(s.origin).find((x) => x.username === username);
      if (l) this.store.markUsed(l.id);
      return;
    }
    const host = new URL(s.origin).host;
    this.b
      .ask({
        kind: 'info',
        tabId: s.tabId,
        title: state === 'update' ? `Update the saved password for ${username || host}?` : `Save your password for ${host}?`,
        detail: `${username ? `${username} · ` : ''}kept on this Mac, encrypted with your keychain`,
        actions: [
          { label: state === 'update' ? 'Update' : 'Save', value: 'save' },
          { label: 'Never for this site', value: 'never' },
          { label: 'Not now', value: 'no' },
        ],
      })
      .then((v) => {
        if (v === 'save') this.store.upsert({ origin: s.origin, username, password });
        if (v === 'never') this.store.setNever(s.origin, true);
        this.b.pushState();
      });
  }

  // ----- Settings → Passwords -----

  list(query?: string): SavedLogin[] {
    return this.store.list(query);
  }

  /** Asks the user (Touch ID where there is one) before a password is shown, copied or exported. */
  private async confirm(reason: string): Promise<boolean> {
    try {
      if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
        await systemPreferences.promptTouchID(reason);
        return true;
      }
    } catch {
      return false;
    }
    const r = await dialog.showMessageBox({ type: 'warning', message: `Clickless wants to ${reason}.`, buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1 });
    return r.response === 0;
  }

  async reveal(id: string): Promise<string | null> {
    const l = this.store.reveal(id);
    if (!l) return null;
    if (!(await this.confirm(`show your saved password for ${new URL(l.origin).host}`))) return null;
    return l.password;
  }

  upsert(p: { id?: string; origin: string; username: string; password?: string }) {
    const origin = originOf(p.origin);
    if (!origin) throw new Error('Enter the site as an address, e.g. https://example.com');
    return this.store.upsert({ ...p, origin });
  }

  remove(id: string) {
    this.store.remove(id);
  }

  async importCsv(): Promise<{ added: number; updated: number; skipped: number; file: string } | null> {
    const r = await dialog.showOpenDialog({ title: 'Import passwords (CSV exported from Chrome, Comet, Arc, Edge, Safari or Firefox)', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const res = this.store.importCsv(fs.readFileSync(r.filePaths[0], 'utf8'));
    return { ...res, file: r.filePaths[0] };
  }

  async exportCsv(): Promise<string | null> {
    if (!(await this.confirm('export all your saved passwords to a file'))) return null;
    const r = await dialog.showSaveDialog({ title: 'Export passwords', defaultPath: 'Clickless passwords.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, this.store.exportCsv(), { mode: 0o600 });
    return r.filePath;
  }
}
