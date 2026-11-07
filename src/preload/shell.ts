// Preload for the shell (window chrome) and the overlay layer. Exposes `window.clickless`.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ClicklessAPI } from '../shared/ipc';

const surfaceArg = process.argv.find((a) => a.startsWith('--clickless-surface='));
const surface = (surfaceArg?.split('=')[1] ?? 'shell') as ClicklessAPI['surface'];
const platform = process.platform as ClicklessAPI['platform'];

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ClicklessAPI = {
  surface,
  platform,
  cmd: (command) => ipcRenderer.invoke(IPC.cmd, command),
  query: (name, args) => ipcRenderer.invoke(IPC.query, name, args),
  onState: (cb) => subscribe(IPC.state, cb),
  onChat: (cb) => subscribe(IPC.chat, cb),
  onAsk: (cb) => subscribe(IPC.ask, cb),
  onEvent: (cb) => subscribe(IPC.event, cb),
};

contextBridge.exposeInMainWorld('clickless', api);
