// Clickless — the browser you share with your agents.

import { app, nativeTheme } from 'electron';
import path from 'node:path';
import { APP_NAME } from '../shared/settings';
import { Clickless, PARTITION } from './browser';
import { createAI } from './ai';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';
import { handleScheme, registerSchemes } from './protocol';
import { ControlServer } from './server';
import { discoveryFile, flushState, loadState, writeDiscovery } from './store';
import { createTools } from './tools';
import { listSources } from './importers';
import { session } from 'electron';

const VERSION = app.getVersion();
app.setName(APP_NAME);
if (process.env.CLICKLESS_USER_DATA) app.setPath('userData', path.resolve(process.env.CLICKLESS_USER_DATA));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

registerSchemes();
const state = loadState();
if (state.settings.control.cdpPort) app.commandLine.appendSwitch('remote-debugging-port', String(state.settings.control.cdpPort));
nativeTheme.themeSource = state.settings.appearance.theme;

let browser: Clickless;
let runCmd: ((c: any) => Promise<unknown>) | null = null;
let server: ControlServer | null = null;

async function startControl() {
  const s = browser.state.settings.control;
  if (server) await server.stop();
  server = null;
  browser.control = { ...browser.control, running: false, port: null, url: null, mcpUrl: null };
  writeDiscovery(null);
  if (!s.enabled) return browser.pushState();
  const srv = new ControlServer({
    browser,
    tools,
    ai: () => browser.ai ?? null,
    token: () => browser.secrets.controlToken(),
    version: VERSION,
    noteClient: (n) => browser.noteClient(n),
    debugCapture: () => browser.debugCapture(),
    debugCommand: (c) => (runCmd ? runCmd(c) : Promise.resolve(null)),
    importSources: () => listSources(),
    importFrom: (source) => browser.importFrom(source),
    trackAbort: () => browser.trackAbort(),
    untrackAbort: (ac) => browser.untrackAbort(ac),
  });
  try {
    const port = await srv.start(s.port);
    server = srv;
    const url = `http://127.0.0.1:${port}`;
    browser.control = { ...browser.control, running: true, port, url, mcpUrl: `${url}/mcp`, error: undefined };
    writeDiscovery({
      name: 'clickless',
      version: VERSION,
      pid: process.pid,
      port,
      url,
      mcpUrl: `${url}/mcp`,
      token: browser.secrets.controlToken(),
      launch: app.isPackaged ? { command: process.execPath, args: [] } : { command: process.execPath, args: [app.getAppPath()] },
      startedAt: new Date().toISOString(),
    });
  } catch (err) {
    browser.control = { ...browser.control, running: false, error: (err as Error).message };
  }
  browser.pushState();
}

const tools = createTools(() => browser?.ai ?? null);

function controlSecrets() {
  const token = browser.secrets.controlToken();
  const url = browser.control.url ?? `http://127.0.0.1:${browser.state.settings.control.port}`;
  const mcpUrl = `${url}/mcp`;
  const cli = path.join(app.getAppPath(), 'dist', 'cli', 'clickless.js');
  return {
    token,
    mcpUrl,
    httpUrl: url,
    claudeCodeCommand: `claude mcp add --scope user --transport http clickless ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    mcpJson: JSON.stringify(
      {
        mcpServers: {
          'clickless': { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } },
          'clickless-stdio': { command: 'node', args: [cli, 'mcp'] },
        },
      },
      null,
      2,
    ),
    curlExample: `curl -s ${url}/v1/act -H "Authorization: Bearer ${token}" -d '{"script":"goto news.ycombinator.com"}'`,
    cliExample: `node "${cli}" act 'goto news.ycombinator.com; click "new"'`,
  };
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'icon.png'));
  browser = new Clickless(state, discoveryFile());
  const ses = session.fromPartition(PARTITION);
  handleScheme(ses, path.join(app.getAppPath(), 'dist', 'renderer'), process.env.CLICKLESS_DEV_URL);

  browser.ai = createAI({
    browser,
    tools,
    settings: () => browser.state.settings,
    getSecret: (id) => browser.secrets.get(`provider.${id}`),
    control: () => (browser.control.mcpUrl ? { mcpUrl: browser.control.mcpUrl, token: browser.secrets.controlToken() } : null),
    emitChat: (c) => browser.emitChat(c),
    emitAsk: (a) => browser.emitAsk(a),
    openAskPage: (id, tabId) => browser.openAskPage(id, tabId),
  });

  const { runCommand } = registerIpc({
    browser,
    restartControl: startControl,
    controlSecrets,
    regenerateToken: () => {
      browser.secrets.controlToken(true);
      startControl();
      browser.event({ type: 'toast', text: 'New token created. Reconnect your agents.', tone: 'info' });
    },
  });
  runCmd = runCommand as any;
  buildMenu(browser, runCommand);
  browser.createWindow();
  await startControl();
});

app.on('second-instance', () => {
  if (!browser?.win) return;
  if (browser.win.isMinimized()) browser.win.restore();
  browser.win.focus();
});

app.on('before-quit', () => {
  flushState();
  browser?.history.flush();
  writeDiscovery(null);
});

app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (err) => console.error('[clickless] uncaught', err));
process.on('unhandledRejection', (err) => console.error('[clickless] unhandled', err));
