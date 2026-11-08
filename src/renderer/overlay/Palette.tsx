import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowRight, Code, Columns2, Command as CommandIcon, Copy, CornerDownLeft, Eraser, FileText, FolderPlus, Globe, History, Layers, PanelLeft, Pause, Pin, Play, RotateCcw, Search, Settings, Sparkles, Star, Wand2, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react';
import type { OverlayState, Suggestion, UIState } from '../../shared/types';
import { cmd, query } from '../common/api';
import { Favicon } from '../common/Favicon';
import { buildSidebar, cx, debounce, hostOf } from '../common/util';

type PaletteOverlay = Extract<OverlayState, { kind: 'palette' }>;
type Mode = PaletteOverlay['mode'];

interface CommandDef {
  id: string;
  label: string;
  icon: LucideIcon;
  hint?: string;
  keywords?: string;
  when?: (s: UIState) => boolean;
  run: (s: UIState) => void | Promise<unknown>;
}

const close = () => cmd({ type: 'ui.overlay', overlay: null });
const activeTab = (s: UIState) => s.tabs.find((t) => t.id === s.activeTabId) ?? null;

export const COMMANDS: CommandDef[] = [
  {
    id: 'ask-page',
    label: 'Summarize this page with the agent',
    icon: FileText,
    keywords: 'ai summary tldr',
    run: async () => {
      await cmd({ type: 'ui.panel', open: true });
      await cmd({ type: 'agent.send', text: 'Summarize this page in 5 bullets.' });
    },
  },
  { id: 'organize', label: 'Tidy tabs with AI', icon: Wand2, keywords: 'organize group folders clean', run: (s) => cmd({ type: 'organize.start', spaceId: s.activeSpaceId }) },
  { id: 'toggle-panel', label: 'Toggle agent panel', icon: Sparkles, hint: '⌘E', keywords: 'ai chat assistant', run: (s) => cmd({ type: 'ui.panel', open: !s.panel.open }) },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', icon: PanelLeft, hint: '⌘S', run: (s) => cmd({ type: 'ui.sidebar', visible: !s.sidebar.visible }) },
  {
    id: 'split',
    label: 'Split view with next tab',
    icon: Columns2,
    keywords: 'side by side',
    when: (s) => !s.split && !!s.activeTabId,
    run: (s) => {
      const flat = buildSidebar(s).flat;
      const i = flat.findIndex((t) => t.id === s.activeTabId);
      const other = flat[(i + 1) % flat.length];
      if (other && other.id !== s.activeTabId) return cmd({ type: 'ui.split', tabIds: [s.activeTabId!, other.id] });
    },
  },
  { id: 'unsplit', label: 'Close split view', icon: Columns2, when: (s) => !!s.split, run: () => cmd({ type: 'ui.split', tabIds: null }) },
  { id: 'history', label: 'Show history', icon: History, keywords: 'visited browsing', hint: '⌘Y', run: () => cmd({ type: 'ui.history' }) },
  { id: 'reopen', label: 'Reopen closed tab', icon: RotateCcw, keywords: 'undo close restore', hint: '⇧⌘T', run: () => cmd({ type: 'tab.reopenClosed' }) },
  { id: 'new-space', label: 'New space…', icon: Layers, keywords: 'workspace profile', run: () => cmd({ type: 'ui.overlay', overlay: { kind: 'space' } }) },
  { id: 'new-folder', label: 'New folder', icon: FolderPlus, run: (s) => cmd({ type: 'folder.create', spaceId: s.activeSpaceId, pinned: true }) },
  {
    id: 'pin',
    label: 'Pin / unpin current tab',
    icon: Pin,
    hint: '⌘D',
    when: (s) => !!activeTab(s) && !activeTab(s)!.favorite,
    run: (s) => cmd({ type: 'tab.update', tabId: s.activeTabId!, patch: { pinned: !activeTab(s)!.pinned } }),
  },
  { id: 'favorite', label: 'Add current tab to Favorites', icon: Star, when: (s) => !!activeTab(s) && !activeTab(s)!.favorite, run: (s) => cmd({ type: 'tab.update', tabId: s.activeTabId!, patch: { favorite: true } }) },
  { id: 'clear-today', label: 'Clear Today tabs', icon: Eraser, keywords: 'archive close all', run: (s) => cmd({ type: 'tabs.clearToday', spaceId: s.activeSpaceId }) },
  { id: 'reopen', label: 'Reopen closed tab', icon: RotateCcw, hint: '⇧⌘T', run: () => cmd({ type: 'tab.reopenClosed' }) },
  { id: 'copy-url', label: 'Copy URL', icon: Copy, hint: '⇧⌘C', when: (s) => !!s.activeTabId, run: () => cmd({ type: 'ui.copyUrl' }) },
  { id: 'pause', label: 'Pause all agents', icon: Pause, keywords: 'stop agent control', when: (s) => !s.agent.paused, run: () => cmd({ type: 'agent.pause', paused: true }) },
  { id: 'resume', label: 'Resume agents', icon: Play, when: (s) => s.agent.paused, run: () => cmd({ type: 'agent.pause', paused: false }) },
  { id: 'zoom-in', label: 'Zoom in', icon: ZoomIn, hint: '⌘+', run: () => cmd({ type: 'ui.zoom', delta: 1 }) },
  { id: 'zoom-out', label: 'Zoom out', icon: ZoomOut, hint: '⌘−', run: () => cmd({ type: 'ui.zoom', delta: -1 }) },
  { id: 'zoom-reset', label: 'Actual size', icon: Search, hint: '⌘0', run: () => cmd({ type: 'ui.zoom', delta: 0 }) },
  { id: 'devtools', label: 'Developer tools', icon: Code, hint: '⌥⌘I', keywords: 'inspect console', run: () => cmd({ type: 'ui.devtools' }) },
  { id: 'settings', label: 'Settings', icon: Settings, hint: '⌘,', keywords: 'preferences', run: () => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'general' } }) },
  { id: 'connect-agent', label: 'Connect an external agent (MCP)', icon: CommandIcon, keywords: 'claude code cursor mcp api token', run: () => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'agents' } }) },
  { id: 'ai-settings', label: 'Choose AI model', icon: Sparkles, keywords: 'provider anthropic openai ollama key', run: () => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'ai' } }) },
];

const KEEPS_OVERLAY = new Set(['new-space', 'settings', 'connect-agent', 'ai-settings', 'organize']);

type Row =
  | { type: 'suggestion'; s: Suggestion }
  | { type: 'command'; c: CommandDef }
  | { type: 'raw'; mode: Mode; input: string };

const PLACEHOLDER: Record<Mode, string> = {
  'new-tab': 'Search, enter a URL, or ask…',
  navigate: 'Enter a URL or search',
  ask: 'Ask anything — Clickless searches, reads and answers',
  commands: 'Type a command',
};

export function Palette({ overlay, state }: { overlay: PaletteOverlay; state: UIState }) {
  const [mode, setMode] = useState<Mode>(overlay.mode);
  const prevMode = useRef<Mode>(overlay.mode === 'ask' ? 'new-tab' : overlay.mode);
  const [input, setInput] = useState(overlay.initial ?? '');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Re-open with another mode while visible.
  useEffect(() => {
    setMode(overlay.mode);
    setInput(overlay.initial ?? '');
    setSel(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [overlay.mode, overlay.initial, overlay.tabId]);

  const fetchSuggest = useMemo(
    () =>
      debounce((q: string) => {
        query('suggest', { input: q, limit: 8 }).then(
          (r) => setSuggestions(r ?? []),
          () => setSuggestions([]),
        );
      }, 50),
    [],
  );

  useEffect(() => {
    if (mode === 'commands') return;
    if (mode === 'navigate' && input === (overlay.initial ?? '')) {
      setSuggestions([]);
      return;
    }
    fetchSuggest(input);
  }, [input, mode]);

  const rows: Row[] = useMemo(() => {
    if (mode === 'commands') {
      const q = input.replace(/^>\s*/, '').toLowerCase();
      return COMMANDS.filter((c) => (!c.when || c.when(state)) && (!q || `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(q))).map((c) => ({ type: 'command', c }));
    }
    const q = input.trim();
    if (mode === 'ask') {
      if (q) return [{ type: 'raw', mode: 'ask', input: q }];
      const page = COMMANDS.find((c) => c.id === 'ask-page')!;
      return state.activeTabId ? [{ type: 'command', c: page }] : [];
    }
    const out: Row[] = [];
    const hasExact = suggestions.some((s) => s.kind === 'url' || s.kind === 'search');
    if (q && !hasExact) out.push({ type: 'raw', mode, input: q });
    for (const s of suggestions) out.push({ type: 'suggestion', s });
    if (q && !suggestions.some((s) => s.kind === 'ask')) out.push({ type: 'suggestion', s: { kind: 'ask', title: q, subtitle: 'Ask AI' } });
    // A few matching commands too.
    const lq = q.toLowerCase();
    if (lq.length >= 3) for (const c of COMMANDS) if ((!c.when || c.when(state)) && `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(lq)) out.push({ type: 'command', c });
    return out.slice(0, 10);
  }, [mode, input, suggestions, state]);

  useEffect(() => setSel(0), [rows.length, mode]);
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const openUrl = async (urlOrInput: string) => {
    if (mode === 'navigate') await cmd({ type: 'tab.navigate', tabId: overlay.tabId, input: urlOrInput });
    else await cmd({ type: 'tab.new', url: urlOrInput });
  };

  const run = async (row: Row | undefined) => {
    if (!row) {
      const q = input.trim();
      if (!q) return;
      if (mode === 'ask') await cmd({ type: 'ask.start', query: q });
      else await openUrl(q);
      close();
      return;
    }
    if (row.type === 'command') {
      await row.c.run(state);
      if (!KEEPS_OVERLAY.has(row.c.id)) close();
      return;
    }
    if (row.type === 'raw') {
      if (row.mode === 'ask') await cmd({ type: 'ask.start', query: row.input });
      else await openUrl(row.input);
      close();
      return;
    }
    const s = row.s;
    switch (s.kind) {
      case 'tab':
        if (s.tabId) await cmd({ type: 'tab.activate', tabId: s.tabId });
        break;
      case 'archived':
        if (s.archivedId) await cmd({ type: 'tab.restoreArchived', archivedId: s.archivedId });
        break;
      case 'ask':
        await cmd({ type: 'ask.start', query: s.title || input });
        break;
      case 'command': {
        const c = COMMANDS.find((x) => x.id === s.command);
        if (c) {
          await c.run(state);
          if (KEEPS_OVERLAY.has(c.id)) return;
        }
        break;
      }
      default:
        await openUrl(s.url ?? s.title);
    }
    close();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        // ⌘↩ always asks AI.
        const q = input.trim();
        if (q) cmd({ type: 'ask.start', query: q }).then(close);
        return;
      }
      run(rows[sel]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (mode === 'ask') setMode(prevMode.current);
      else {
        prevMode.current = mode;
        setMode('ask');
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Backspace' && !input && mode !== overlay.mode) {
      setMode(overlay.mode === 'ask' ? 'new-tab' : overlay.mode);
    }
  };

  const onChange = (v: string) => {
    if (mode !== 'commands' && v.startsWith('>')) {
      prevMode.current = mode;
      setMode('commands');
      setInput(v.slice(1));
      return;
    }
    setInput(v);
  };

  const Lead = mode === 'ask' ? Sparkles : mode === 'commands' ? CommandIcon : Search;

  return (
    <div className={cx('palette', mode === 'ask' && 'ask')} onMouseDown={(e) => e.stopPropagation()}>
      <div className="p-input">
        <Lead className="lead" size={19} strokeWidth={2} />
        <input ref={inputRef} value={input} placeholder={PLACEHOLDER[mode]} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} spellCheck={false} autoFocus />
        <button
          className={cx('mode-chip', mode === 'ask' && 'on')}
          onClick={() => {
            if (mode === 'ask') setMode(prevMode.current);
            else {
              prevMode.current = mode;
              setMode('ask');
            }
            inputRef.current?.focus();
          }}
        >
          <Sparkles size={12} /> Ask AI <span className="kbd">Tab</span>
        </button>
      </div>
      {rows.length > 0 && (
        <div className="p-list scroll" ref={listRef}>
          {rows.map((r, i) => (
            <PaletteRow key={i} row={r} selected={i === sel} onHover={() => setSel(i)} onClick={() => run(r)} navigate={mode === 'navigate'} />
          ))}
        </div>
      )}
      {mode === 'commands' && rows.length === 0 && <div className="p-empty">No matching commands</div>}
      <div className="p-foot">
        <span>
          <span className="kbd">↑↓</span> select
        </span>
        <span>
          <span className="kbd">↩</span> open
        </span>
        <span>
          <span className="kbd">⌘↩</span> ask AI
        </span>
        <span>
          <span className="kbd">&gt;</span> commands
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <span className="kbd">esc</span>
        </span>
      </div>
    </div>
  );
}

function PaletteRow({ row, selected, onHover, onClick, navigate }: { row: Row; selected: boolean; onHover(): void; onClick(): void; navigate: boolean }) {
  let icon: React.ReactNode;
  let title = '';
  let sub = '';
  let hint = '';
  let accent = false;
  if (row.type === 'command') {
    icon = <row.c.icon size={14} />;
    title = row.c.label;
    hint = row.c.hint ?? 'Run';
  } else if (row.type === 'raw') {
    if (row.mode === 'ask') {
      icon = <Sparkles size={14} />;
      accent = true;
      title = row.input;
      sub = 'Search the web and answer';
      hint = 'Ask';
    } else {
      const looksUrl = /^[\w-]+(\.[\w-]+)+(\/|$)|^\w+:\/\//.test(row.input) && !row.input.includes(' ');
      icon = looksUrl ? <Globe size={14} /> : <Search size={14} />;
      title = row.input;
      sub = looksUrl ? '' : 'Search the web';
      hint = navigate ? 'Go' : 'Open';
    }
  } else {
    const s = row.s;
    title = s.title;
    sub = s.subtitle ?? (s.url ? hostOf(s.url) : '');
    switch (s.kind) {
      case 'tab':
        icon = <Favicon src={s.favicon} url={s.url} title={s.title} />;
        hint = 'Switch to tab';
        sub = s.url ? hostOf(s.url) : sub;
        break;
      case 'history':
        icon = s.favicon ? <Favicon src={s.favicon} url={s.url} title={s.title} /> : <History size={14} />;
        hint = navigate ? 'Go' : 'Open';
        sub = s.url ? hostOf(s.url) : sub;
        break;
      case 'archived':
        icon = <Archive size={14} />;
        hint = 'Restore';
        break;
      case 'url':
        icon = <Globe size={14} />;
        hint = navigate ? 'Go' : 'Open';
        break;
      case 'search':
        icon = <Search size={14} />;
        hint = 'Search';
        break;
      case 'ask':
        icon = <Sparkles size={14} />;
        accent = true;
        hint = 'Ask';
        sub = sub || 'Ask AI';
        break;
      case 'command':
        icon = <CommandIcon size={14} />;
        hint = 'Run';
        break;
    }
  }
  return (
    <button className={cx('p-row', selected && 'sel')} onMouseMove={onHover} onClick={onClick}>
      <span className={cx('ic', accent && 'accent')}>{icon}</span>
      <span className="tx">
        <span className="tt truncate">{title}</span>
        {sub && <span className="st truncate">{sub}</span>}
      </span>
      <span className="hint">
        {selected ? (
          <>
            {hint} <CornerDownLeft size={12} />
          </>
        ) : row.type === 'suggestion' && row.s.kind === 'tab' ? (
          <ArrowRight size={12} />
        ) : null}
      </span>
    </button>
  );
}
