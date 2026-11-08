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
import { BackupService } from './backup-service';
import { AgentProfiles } from './agent-profiles';
import { session } from 'electron';

const VERSION = app.getVersion();
app.setName(APP_NAME);
if (process.env.CLICKLESS_USER_DATA) app.setPath('userData', path.resolve(process.env.CLICKLESS_USER_DATA));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

registerSchemes();
/** Set when this process is an agent's own browser (started by the main Clickless). */
const AGENT = process.env.CLICKLESS_AGENT_PROFILE ? { id: process.env.CLICKLESS_AGENT_PROFILE, name: process.env.CLICKLESS_AGENT_NAME || process.env.CLICKLESS_AGENT_PROFILE } : null;
const state = loadState();
if (AGENT && !state.tabs.length && state.spaces.length === 2 && state.spaces[0].id === 's1' && state.spaces[1].id === 's2') {
  // an agent's first start: one space named after it, no Personal/Work
  state.spaces = [{ id: 's1', name: AGENT.name, icon: '🤖', color: '#10a592' }];
  state.activeSpaceId = 's1';
}
if (state.settings.control.cdpPort) app.commandLine.appendSwitch('remote-debugging-port', String(state.settings.control.cdpPort));
nativeTheme.themeSource = state.settings.appearance.theme;
// Dev/test copies keep drawing while hidden behind other windows, so captures and replayed input work.
if (process.env.CLICKLESS_DEBUG) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}

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
    debugShellMouse: (steps) => browser.debugShellMouse(steps as any),
    debugShellEval: (code) => browser.debugShellEval(code),
    debugMenu: (acc) => browser.debugMenu(acc),
    agentRoute: browser.agentProfiles
      ? {
          access: (client) => browser.agentProfiles!.access(client),
          forward: (client, name, args, signal) => browser.agentProfiles!.forward(client, name, args, signal),
          requestTabs: (client, args, signal) => browser.agentProfiles!.requestTabs(client, args, signal),
        }
      : undefined,
    appAction: async (body) => {
      if (body.action === 'focus') return browser.bringToFront();
      if (body.action === 'quit') return void setTimeout(() => app.quit(), 50);
      if (body.action === 'open') {
        const ids: string[] = [];
        for (const [i, u] of (body.urls ?? []).entries()) ids.push((await browser.openTab(u, { background: i > 0 })).id);
        return { ids };
      }
      return { ok: false };
    },
    importSources: () => listSources(),
    importFrom: (source) => browser.importFrom(source),
    backupStatus: () => {
      const c = browser.state.settings.backup;
      return { ...browser.backups?.status(), target: c.target, schedule: c.schedule, lastAt: c.lastAt, lastWhere: c.lastWhere, lastError: c.lastError };
    },
    backupNow: () => browser.backups!.run(),
    trackAbort: () => browser.trackAbort(),
    untrackAbort: (ac) => browser.untrackAbort(ac),
  });
  try {
    const port = await srv.start(process.env.CLICKLESS_PORT !== undefined ? Number(process.env.CLICKLESS_PORT) || 0 : s.port);
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
  // In the installed app the CLI sits outside the archive (asarUnpack) and runs on the app's own
  // runtime, so nobody needs Node installed.
  const cli = path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'dist', 'cli', 'clickless.js');
  const run = app.isPackaged ? `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${cli}"` : `node "${cli}"`;
  const stdio = app.isPackaged ? { command: process.execPath, args: [cli, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } } : { command: 'node', args: [cli, 'mcp'] };
  return {
    token,
    mcpUrl,
    httpUrl: url,
    claudeCodeCommand: `claude mcp add --scope user --transport http clickless ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    mcpJson: JSON.stringify(
      {
        mcpServers: {
          'clickless': { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } },
          'clickless-stdio': stdio,
        },
      },
      null,
      2,
    ),
    curlExample: `curl -s ${url}/v1/act -H "Authorization: Bearer ${token}" -d '{"script":"goto news.ycombinator.com"}'`,
    cliExample: `${run} act 'goto news.ycombinator.com; click "new"'`,
    stdio,
  };
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'icon.png'));
  browser = new Clickless(state, discoveryFile());
  if (AGENT) {
    browser.profile = { kind: 'agent', id: AGENT.id, name: AGENT.name };
    if (process.platform === 'darwin') app.dock?.setBadge('Agent');
  } else {
    browser.backups = new BackupService(browser);
    browser.agentProfiles = new AgentProfiles(browser);
  }
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
  let menuTimer: ReturnType<typeof setTimeout> | null = null;
  browser.onMenuChange = () => {
    if (menuTimer) clearTimeout(menuTimer);
    menuTimer = setTimeout(() => buildMenu(browser, runCommand), 300);
  };
  browser.createWindow();
  if (AGENT) browser.win.setTitle(`${AGENT.name} — its own Clickless profile`);
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
