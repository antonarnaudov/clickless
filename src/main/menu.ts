// App menu and keyboard shortcuts (they work while focus is inside a web page too).

import { Menu, app, type MenuItemConstructorOptions } from 'electron';
import type { Command } from '../shared/ipc';
import type { Clickless } from './browser';

export function buildMenu(b: Clickless, run: (c: Command) => Promise<unknown>) {
  const cmd = (c: Command) => () => {
    run(c).catch((err) => console.error('[menu]', err));
  };
  const isMac = process.platform === 'darwin';
  const tabIndex: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? 'Last Tab' : `Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: cmd({ type: 'tabs.activateIndex', index: i }),
  }));
  const spaceIndex: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Space ${i + 1}`,
    accelerator: `Control+${i + 1}`,
    click: () => {
      const s = b.state.spaces[i];
      if (s) b.activateSpace(s.id);
    },
  }));

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Clickless',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd({ type: 'ui.overlay', overlay: { kind: 'settings' } }) },
              { label: 'Connect an Agent…', click: cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'agents' } }) },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab…', accelerator: 'CmdOrCtrl+T', click: cmd({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'new-tab' } }) },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => run({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'navigate', tabId: b.activeTabId() ?? undefined, initial: b.activeTab()?.internal ? '' : b.activeTab()?.url } }) },
        { label: 'Ask AI…', accelerator: 'CmdOrCtrl+J', click: cmd({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'ask' } }) },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: cmd({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'commands' } }) },
        { type: 'separator' },
        { label: 'New Space…', accelerator: 'CmdOrCtrl+Shift+N', click: cmd({ type: 'ui.overlay', overlay: { kind: 'space' } }) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: cmd({ type: 'tab.reopenClosed' }) },
        { label: 'Duplicate Tab', click: () => b.activeTabId() && run({ type: 'tab.duplicate', tabId: b.activeTabId()! }) },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (b.uiState().overlay) return run({ type: 'ui.overlay', overlay: null });
            const id = b.activeTabId();
            if (id) return run({ type: 'tab.close', tabId: id });
          },
        },
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'quit' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => (b.find({ query: '' }), b.shell.webContents.focus(), b.event({ type: 'find-open' })) },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => b.find({ next: true }) },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => b.find({ back: true }) },
        { type: 'separator' },
        { label: 'Copy URL', accelerator: 'CmdOrCtrl+Shift+C', click: cmd({ type: 'ui.copyUrl' }) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+S', click: () => run({ type: 'ui.sidebar', visible: !b.state.sidebar.visible }) },
        { label: 'Toggle Agent Panel', accelerator: 'CmdOrCtrl+E', click: () => run({ type: 'ui.panel', open: !b.state.panel.open }) },
        {
          label: 'Split View with Next Tab',
          accelerator: 'CmdOrCtrl+Shift+=',
          click: () => {
            const order = b.sidebarOrder().filter((t) => !t.favorite);
            const a = b.activeTabId();
            const i = order.findIndex((t) => t.id === a);
            const other = order[(i + 1) % order.length];
            if (a && other && other.id !== a) run({ type: 'ui.split', tabIds: b.uiState().split ? null : [a, other.id] });
          },
        },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: cmd({ type: 'tab.reload' }) },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: cmd({ type: 'tab.reload', hard: true }) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd({ type: 'ui.zoom', delta: 1 }) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, click: cmd({ type: 'ui.zoom', delta: 1 }) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd({ type: 'ui.zoom', delta: -1 }) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: cmd({ type: 'ui.zoom', delta: 0 }) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: isMac ? 'Alt+Command+I' : 'Control+Shift+I', click: cmd({ type: 'ui.devtools' }) },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: cmd({ type: 'tab.back' }) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: cmd({ type: 'tab.forward' }) },
        { label: 'Back', accelerator: 'CmdOrCtrl+Left', visible: false, click: cmd({ type: 'tab.back' }) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+Right', visible: false, click: cmd({ type: 'tab.forward' }) },
        { type: 'separator' },
        { label: 'Show All History', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: cmd({ type: 'ui.history' }) },
        {
          label: 'Recently Closed',
          enabled: b.recentlyClosed().length > 0,
          submenu: b.recentlyClosed().slice(0, 12).map((c) => ({ label: (c.title || c.url).slice(0, 60), click: cmd({ type: 'tab.reopenClosed', closedId: c.id }) })),
        },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Control+Tab', click: cmd({ type: 'tabs.cycle', dir: 1 }) },
        { label: 'Previous Tab', accelerator: 'Control+Shift+Tab', click: cmd({ type: 'tabs.cycle', dir: -1 }) },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Alt+Down', visible: false, click: cmd({ type: 'tabs.cycle', dir: 1 }) },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Alt+Up', visible: false, click: cmd({ type: 'tabs.cycle', dir: -1 }) },
        {
          label: 'Pin / Unpin Tab',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            const t = b.activeTab();
            if (t) run({ type: 'tab.update', tabId: t.id, patch: { pinned: !t.pinned } });
          },
        },
        { label: 'Organize Tabs with AI', accelerator: 'CmdOrCtrl+Shift+O', click: cmd({ type: 'organize.start' }) },
        { label: 'Clear Today', click: cmd({ type: 'tabs.clearToday' }) },
        { type: 'separator' },
        ...tabIndex,
        { type: 'separator' },
        { label: 'Next Space', accelerator: 'CmdOrCtrl+Alt+Right', click: cmd({ type: 'space.cycle', dir: 1 }) },
        { label: 'Previous Space', accelerator: 'CmdOrCtrl+Alt+Left', click: cmd({ type: 'space.cycle', dir: -1 }) },
        ...spaceIndex,
      ],
    },
    {
      label: 'Agent',
      submenu: [
        { label: 'Open Agent Panel', accelerator: 'CmdOrCtrl+Shift+E', click: () => run({ type: 'ui.panel', open: true }) },
        { label: 'Stop Agent', accelerator: 'CmdOrCtrl+.', click: cmd({ type: 'agent.stop' }) },
        { label: 'Pause / Resume All Agents', accelerator: 'CmdOrCtrl+Shift+.', click: () => run({ type: 'agent.pause', paused: !b.uiState().agent.paused }) },
        { type: 'separator' },
        { label: 'Connect Claude Code, Cursor, local LLMs…', click: cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'agents' } }) },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Clickless on GitHub', click: () => b.openExternal('https://github.com/antonarnaudov/clickless') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  void app;
}
