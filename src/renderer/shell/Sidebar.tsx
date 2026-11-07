import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Columns2,
  Copy,
  CopyPlus,
  Download,
  Ellipsis,
  Folder as FolderIcon,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Globe,
  Layers,
  Lock,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plug,
  Plus,
  RotateCw,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Star,
  StarOff,
  Trash2,
  Volume2,
  VolumeX,
  Wand2,
  X,
  PanelLeft,
} from 'lucide-react';
import type { Download as DownloadT, Folder, Space, Tab, UIState } from '../../shared/types';
import { cmd } from '../common/api';
import { Favicon } from '../common/Favicon';
import { buildSidebar, cx, displayUrl, formatBytes, hostOf, isSecure, type SidebarModel } from '../common/util';
import { useContextMenu, type MenuItem } from './ContextMenu';

// ---------------------------------------------------------------------------
// Sidebar-local context: stable callbacks shared by every row.

interface SbCtx {
  renamingId: string | null;
  setRenaming(id: string | null): void;
  /** Latest state, read lazily (e.g. when a menu opens) so rows don't re-render on every push. */
  getState(): UIState;
  /** Click on a tab row: plain = activate, ⌘ = toggle selection, ⇧ = select range. */
  onRowClick(tabId: string, e: React.MouseEvent): void;
  getSelection(): Set<string>;
  clearSelection(): void;
}
const Ctx = createContext<SbCtx>(null!);

type Layout = Record<string, string[]>;
const idOf = (key: string) => key.slice(key.indexOf(':') + 1);

function baseLayout(m: SidebarModel): Layout {
  const L: Layout = { fav: m.favorites.map((t) => `tab:${t.id}`), pinned: [], today: [] };
  for (const [key, items] of [
    ['pinned', m.pinned],
    ['today', m.today],
  ] as const) {
    for (const it of items) {
      if (it.kind === 'tab') L[key].push(`tab:${it.tab.id}`);
      else {
        L[key].push(`folder:${it.folder.id}`);
        L[`fold:${it.folder.id}`] = it.folder.collapsed ? [] : it.tabs.map((t) => `tab:${t.id}`);
      }
    }
  }
  return L;
}

function findContainer(L: Layout, id: string): string | null {
  if (id in L) return id;
  for (const k of Object.keys(L)) if (L[k].includes(id)) return k;
  return null;
}

const PRIORITY = ['folderhead:', 'space:', 'tab:', 'fold:', 'folder:'];
const rank = (id: string) => {
  const i = PRIORITY.findIndex((p) => id.startsWith(p));
  return i < 0 ? PRIORITY.length : i;
};

// ---------------------------------------------------------------------------

export const Sidebar = memo(function Sidebar({ state, width, onToast }: { state: UIState; width: number; onToast(t: string): void }) {
  const model = useMemo(() => buildSidebar(state), [state.tabs, state.folders, state.activeSpaceId]);
  const space = state.spaces.find((s) => s.id === state.activeSpaceId);
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const [renamingId, setRenaming] = useState<string | null>(null);
  const tabsById = useMemo(() => new Map(state.tabs.map((t) => [t.id, t])), [state.tabs]);
  const foldersById = useMemo(() => new Map(state.folders.map((f) => [f.id, f])), [state.folders]);

  // ----- drag & drop -----
  const base = useMemo(() => baseLayout(model), [model]);
  const [drag, setDrag] = useState<{ id: string; layout: Layout; into: string | null } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const layout = drag?.layout ?? base;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const collision: CollisionDetection = useCallback(
    (args) => {
      const a = String(args.active.id);
      const isFolder = a.startsWith('folder:');
      const L = dragRef.current?.layout ?? base;
      const hits = pointerWithin(args).filter((c) => {
        const id = String(c.id);
        if (id === a) return false;
        if (isFolder) {
          if (id.startsWith('folderhead:') || id.startsWith('fold:') || id === 'fav' || id.startsWith('space:')) return false;
          if (id.startsWith('tab:') && findContainer(L, id)?.startsWith('fold:')) return false;
        }
        return true;
      });
      hits.sort((x, y) => rank(String(x.id)) - rank(String(y.id)));
      return hits.slice(0, 1);
    },
    [base],
  );

  const onDragStart = (e: DragStartEvent) => setDrag({ id: String(e.active.id), layout: base, into: null });

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const a = String(active.id);
    if (!over) return setDrag({ ...d, into: null });
    const o = String(over.id);
    if (o.startsWith('folderhead:')) {
      if (a.startsWith('tab:') && d.into !== idOf(o)) setDrag({ ...d, into: idOf(o) });
      return;
    }
    if (o.startsWith('space:')) return d.into ? setDrag({ ...d, into: null }) : undefined;
    const L = d.layout;
    const from = findContainer(L, a);
    const to = findContainer(L, o);
    if (!from || !to) return;
    if (a.startsWith('folder:') && (to === 'fav' || to.startsWith('fold:'))) return;
    if (from === to) return d.into ? setDrag({ ...d, into: null }) : undefined;
    const fromItems = L[from].filter((x) => x !== a);
    const toItems = L[to].filter((x) => x !== a);
    const overIndex = o === to ? toItems.length : toItems.indexOf(o);
    const t = active.rect.current.translated;
    const below = t && over.rect ? t.top + t.height / 2 > over.rect.top + over.rect.height / 2 : false;
    const idx = overIndex < 0 ? toItems.length : overIndex + (below ? 1 : 0);
    toItems.splice(idx, 0, a);
    setDrag({ ...d, into: null, layout: { ...L, [from]: fromItems, [to]: toItems } });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const d = dragRef.current;
    setDrag(null);
    if (!d || !over) return;
    const a = String(active.id);
    const o = String(over.id);
    const isTab = a.startsWith('tab:');
    const spaceId = state.activeSpaceId;
    if (isTab && d.into) {
      const f = foldersById.get(d.into);
      if (f) cmd({ type: 'tab.move', tabId: idOf(a), spaceId: f.spaceId, favorite: false, pinned: f.pinned, folderId: f.id, beforeId: null });
      return;
    }
    if (o.startsWith('space:')) {
      if (isTab && idOf(o) !== spaceId) {
        cmd({ type: 'tab.move', tabId: idOf(a), spaceId: idOf(o), favorite: false, pinned: false, folderId: null, beforeId: null });
        const sp = state.spaces.find((s) => s.id === idOf(o));
        if (sp) onToast(`Moved to ${sp.icon} ${sp.name}`);
      }
      return;
    }
    const L = d.layout;
    const c = findContainer(L, a);
    if (!c) return;
    let items = L[c];
    if (findContainer(L, o) === c && o !== a && items.includes(o)) items = arrayMove(items, items.indexOf(a), items.indexOf(o));
    const origC = findContainer(base, a);
    if (origC === c && base[c].join() === items.join()) return;
    const next = items[items.indexOf(a) + 1];
    const beforeId = next ? idOf(next) : null;
    if (!isTab) {
      if (c === 'pinned' || c === 'today') cmd({ type: 'folder.move', folderId: idOf(a), pinned: c === 'pinned', beforeId });
      return;
    }
    const tabId = idOf(a);
    if (c === 'fav') cmd({ type: 'tab.move', tabId, favorite: true, folderId: null, beforeId });
    else if (c === 'pinned' || c === 'today') cmd({ type: 'tab.move', tabId, spaceId, favorite: false, pinned: c === 'pinned', folderId: null, beforeId });
    else if (c.startsWith('fold:')) {
      const f = foldersById.get(idOf(c));
      if (f) cmd({ type: 'tab.move', tabId, spaceId: f.spaceId, favorite: false, pinned: f.pinned, folderId: f.id, beforeId });
    }
  };

  const stateRef = useRef(state);
  stateRef.current = state;
  const getState = useCallback(() => stateRef.current, []);
  // ----- multi-select -----
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selRef = useRef(selected);
  selRef.current = selected;
  const anchor = useRef<string | null>(null);
  const flatRef = useRef(model.flat);
  flatRef.current = model.flat;
  useEffect(() => setSelected(new Set()), [state.activeSpaceId]);
  const onRowClick = useCallback((tabId: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      const n = new Set(selRef.current);
      if (!n.size && stateRef.current.activeTabId) n.add(stateRef.current.activeTabId);
      if (n.has(tabId)) n.delete(tabId);
      else n.add(tabId);
      anchor.current = tabId;
      setSelected(n);
      return;
    }
    if (e.shiftKey) {
      const flat = flatRef.current.map((t) => t.id);
      const from = flat.indexOf(anchor.current ?? stateRef.current.activeTabId ?? tabId);
      const to = flat.indexOf(tabId);
      if (from >= 0 && to >= 0) {
        setSelected(new Set(flat.slice(Math.min(from, to), Math.max(from, to) + 1)));
        return;
      }
    }
    anchor.current = tabId;
    if (selRef.current.size) setSelected(new Set());
    cmd({ type: 'tab.activate', tabId });
  }, []);
  const getSelection = useCallback(() => selRef.current, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const ctx = useMemo(() => ({ renamingId, setRenaming, getState, onRowClick, getSelection, clearSelection }), [renamingId, getState, onRowClick, getSelection, clearSelection]);
  const agentTab = state.agent.active ? state.agent.tabId : null;
  const dragTab = drag && drag.id.startsWith('tab:') ? tabsById.get(idOf(drag.id)) : undefined;
  const dragFolder = drag && drag.id.startsWith('folder:') ? foldersById.get(idOf(drag.id)) : undefined;

  const showUrl = !state.settings.appearance.compactUrl;
  const lights = state.platform === 'darwin' && !state.fullscreen;
  const spaceIdx = state.spaces.findIndex((s) => s.id === state.activeSpaceId);
  const prevIdx = useRef(spaceIdx);
  const dir = spaceIdx >= prevIdx.current ? 1 : -1;
  useEffect(() => {
    prevIdx.current = spaceIdx;
  }, [spaceIdx]);

  return (
    <Ctx.Provider value={ctx}>
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDrag(null)}>
        <div
          className="sidebar-inner"
          style={{ width: width - 12 }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            if (selected.size) setSelected(new Set());
            else cmd({ type: 'ui.focusPage' });
          }}
        >
          <div className={cx('sb-top drag', lights && 'lights')}>
            <button className="icon-btn" title="Hide sidebar (⌘S)" onClick={() => cmd({ type: 'ui.sidebar', visible: false })}>
              <PanelLeft size={16} strokeWidth={1.8} />
            </button>
            <div className="grow" />
            <button className="icon-btn" title="Back (⌘[)" disabled={!active?.canGoBack} onClick={() => cmd({ type: 'tab.back' })}>
              <ArrowLeft size={16} strokeWidth={1.9} />
            </button>
            <button className="icon-btn" title="Forward (⌘])" disabled={!active?.canGoForward} onClick={() => cmd({ type: 'tab.forward' })}>
              <ArrowRight size={16} strokeWidth={1.9} />
            </button>
            <button
              className="icon-btn"
              title={active?.loading ? 'Stop' : 'Reload (⌘R)'}
              disabled={!active}
              onClick={() => cmd({ type: active?.loading ? 'tab.stop' : 'tab.reload' })}
            >
              {active?.loading ? <X size={16} strokeWidth={1.9} /> : <RotateCw size={15} strokeWidth={1.9} />}
            </button>
          </div>

          {showUrl && <UrlField tab={active} />}
          <AskRow open={state.panel.open} />

          <div className="sb-scroll scroll">
            <Favorites ids={layout.fav} tabsById={tabsById} activeId={state.activeTabId} dragging={!!drag} agentTab={agentTab} />

            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.div
                key={state.activeSpaceId}
                custom={dir}
                initial={{ opacity: 0, x: dir * 28 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: dir * -28 }}
                transition={{ type: 'spring', stiffness: 420, damping: 38, mass: 0.7 }}
              >
                {space && <SpaceHead space={space} />}
                <SectionList id="pinned" ids={layout.pinned} layout={layout} tabsById={tabsById} foldersById={foldersById} into={drag?.into ?? null} activeId={state.activeTabId} agentTab={agentTab} selected={selected} />
                <TodayDivider spaceId={state.activeSpaceId} />
                <NewTabRow />
                <SectionList id="today" ids={layout.today} layout={layout} tabsById={tabsById} foldersById={foldersById} into={drag?.into ?? null} activeId={state.activeTabId} agentTab={agentTab} selected={selected} />
                <div style={{ height: 40 }} />
              </motion.div>
            </AnimatePresence>
          </div>

          <AgentCard state={state} />
          <Footer state={state} dragging={!!dragTab} />
        </div>

        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
          {dragTab ? (
            drag && findContainer(layout, drag.id) === 'fav' ? (
              <div className="fav-tile active" style={{ width: 52 }}>
                <Favicon src={dragTab.favicon} url={dragTab.url} title={dragTab.title} size={20} />
              </div>
            ) : (
              <div className="row active" style={{ width: width - 16, boxShadow: 'var(--shadow-pop)' }}>
                <Favicon src={dragTab.favicon} url={dragTab.url} title={dragTab.title} />
                <span className="title truncate">{dragTab.title || hostOf(dragTab.url)}</span>
              </div>
            )
          ) : dragFolder ? (
            <div className="row active folder-head" style={{ width: width - 16, boxShadow: 'var(--shadow-pop)' }}>
              <FolderIcon className="ficon" size={15} strokeWidth={1.8} />
              <span className="title truncate">{dragFolder.name}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </Ctx.Provider>
  );
});

// ---------------------------------------------------------------------------

function UrlField({ tab }: { tab: Tab | null }) {
  const host = tab && !tab.url.startsWith('clickless://newtab') ? (tab.internal ? displayUrl(tab.url) : hostOf(tab.url)) : '';
  const open = () => cmd({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'navigate', initial: tab?.url.startsWith('clickless://newtab') ? '' : tab?.url, tabId: tab?.id } });
  return (
    <div className="urlfield" role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()} title={tab?.url}>
      {tab && isSecure(tab.url) ? <Lock className="lead" size={12} strokeWidth={2.2} /> : <Globe className="lead" size={13} strokeWidth={1.9} />}
      <span className={cx('host truncate', !host && 'empty')}>{host || 'Search or enter address'}</span>
      {tab && !tab.internal && (
        <button
          className="icon-btn sm"
          title="Copy link (⇧⌘C)"
          onClick={(e) => {
            e.stopPropagation();
            cmd({ type: 'ui.copyUrl', tabId: tab.id });
          }}
        >
          <Copy size={13} strokeWidth={1.9} />
        </button>
      )}
    </div>
  );
}

// ----- favourites -----

const Favorites = memo(function Favorites({
  ids,
  tabsById,
  activeId,
  dragging,
  agentTab,
}: {
  ids: string[];
  tabsById: Map<string, Tab>;
  activeId: string | null;
  dragging: boolean;
  agentTab: string | null;
}) {
  const { setNodeRef } = useDroppable({ id: 'fav' });
  return (
    <SortableContext id="fav" items={ids} strategy={rectSortingStrategy}>
      <div ref={setNodeRef} className={cx('favs', !ids.length && 'empty-drop', dragging && 'dragging')}>
        {ids.map((key) => {
          const t = tabsById.get(idOf(key));
          return t ? <FavTile key={key} tab={t} active={t.id === activeId} agentHere={t.id === agentTab} /> : null;
        })}
      </div>
    </SortableContext>
  );
});

const FavTile = memo(function FavTile({ tab, active, agentHere }: { tab: Tab; active: boolean; agentHere: boolean }) {
  const s = useSortable({ id: `tab:${tab.id}` });
  const menu = useTabMenu(tab);
  return (
    <div
      ref={s.setNodeRef}
      {...s.attributes}
      {...s.listeners}
      style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }}
      className={cx('fav-tile', active && 'active', tab.asleep && 'asleep', s.isDragging && 'dragging-ghost')}
      title={`${tab.title}\n${tab.url}`}
      onClick={() => cmd({ type: 'tab.activate', tabId: tab.id })}
      onAuxClick={(e) => e.button === 1 && cmd({ type: 'tab.close', tabId: tab.id })}
      onContextMenu={menu}
    >
      <Favicon src={tab.favicon} url={tab.url} title={tab.title} size={20} />
      {tab.loading && <span className="spinner" />}
      {(tab.audible || agentHere) && <span className="dot" style={agentHere ? { background: 'linear-gradient(var(--magic), var(--warm))', width: 12, borderRadius: 2 } : undefined} />}
    </div>
  );
});

// ----- space header + sections -----

function SpaceHead({ space }: { space: Space }) {
  const openMenu = useContextMenu();
  const items = (): MenuItem[] => [
    { label: 'Edit space…', icon: Pencil, onSelect: () => cmd({ type: 'ui.overlay', overlay: { kind: 'space', spaceId: space.id } }) },
    { label: 'New space…', icon: Plus, onSelect: () => cmd({ type: 'ui.overlay', overlay: { kind: 'space' } }) },
    { label: 'New folder', icon: FolderPlus, onSelect: () => cmd({ type: 'folder.create', spaceId: space.id, pinned: true }) },
    { label: 'Tidy tabs with AI', icon: Wand2, onSelect: () => cmd({ type: 'organize.start', spaceId: space.id }) },
    { sep: true },
    { label: 'Delete space', icon: Trash2, danger: true, onSelect: () => cmd({ type: 'space.delete', spaceId: space.id }) },
  ];
  return (
    <div
      className="space-head"
      onDoubleClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'space', spaceId: space.id } })}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, items());
      }}
    >
      <span className="emoji">{space.icon}</span>
      <span className="name truncate">{space.name}</span>
      <button className="icon-btn sm" title="Space options" onClick={(e) => openMenu(e, items())}>
        <Ellipsis size={15} />
      </button>
    </div>
  );
}

function SectionList({
  id,
  ids,
  layout,
  tabsById,
  foldersById,
  into,
  activeId,
  agentTab,
  selected,
}: {
  id: 'pinned' | 'today';
  ids: string[];
  layout: Layout;
  tabsById: Map<string, Tab>;
  foldersById: Map<string, Folder>;
  into: string | null;
  activeId: string | null;
  agentTab: string | null;
  selected: Set<string>;
}) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <SortableContext id={id} items={ids} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="section">
        {ids.map((key) => {
          if (key.startsWith('folder:')) {
            const f = foldersById.get(idOf(key));
            if (!f) return null;
            let count = 0;
            for (const t of tabsById.values()) if (t.folderId === f.id) count++;
            return <FolderItem key={key} folder={f} kids={layout[`fold:${f.id}`] ?? []} tabsById={tabsById} into={into === f.id} activeId={activeId} agentTab={agentTab} count={count} selected={selected} />;
          }
          const t = tabsById.get(idOf(key));
          return t ? <TabRow key={key} tab={t} active={t.id === activeId} agentHere={t.id === agentTab} selected={selected.has(t.id)} /> : null;
        })}
      </div>
    </SortableContext>
  );
}

function TodayDivider({ spaceId }: { spaceId: string }) {
  return (
    <div className="divider">
      <span className="label">Today</span>
      <span className="line" />
      <span className="acts">
        <button title="Group and clean up tabs with AI" onClick={() => cmd({ type: 'organize.start', spaceId })}>
          <Wand2 size={12} strokeWidth={2} /> Tidy
        </button>
        <button title="Archive all Today tabs" onClick={() => cmd({ type: 'tabs.clearToday', spaceId })}>
          <ChevronRight size={12} strokeWidth={2.2} style={{ transform: 'rotate(90deg)' }} /> Clear
        </button>
      </span>
    </div>
  );
}

/** The way into the AI: always visible, right under the address field. */
function AskRow({ open }: { open: boolean }) {
  return (
    <button
      className={cx('row ask-row', open && 'on')}
      style={{ width: '100%' }}
      title="Ask Clickless a question or give it a task (⌘E)"
      onClick={() => cmd({ type: 'ui.panel', open: !open })}
    >
      <Sparkles size={16} strokeWidth={1.9} />
      <span className="title">Ask Clickless</span>
      <span className="kbd" style={{ marginRight: 4 }}>⌘E</span>
    </button>
  );
}

function NewTabRow() {
  return (
    <button className="row new-tab" style={{ width: '100%' }} onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'new-tab' } })}>
      <Plus size={16} strokeWidth={1.9} />
      <span className="title">New Tab</span>
      <span className="kbd" style={{ marginRight: 4 }}>⌘T</span>
    </button>
  );
}

// ----- tab row -----

function useTabMenu(tab: Tab) {
  const openMenu = useContextMenu();
  const { getState, setRenaming, getSelection, clearSelection } = useContext(Ctx);
  return (e: React.MouseEvent) => {
    e.preventDefault();
    const state = getState();
    const sel = getSelection();
    if (sel.size > 1 && sel.has(tab.id)) {
      const ids = [...sel];
      const n = ids.length;
      const after = (fn: () => void) => () => {
        fn();
        clearSelection();
      };
      openMenu(e, [
        { label: `New folder with ${n} tabs`, icon: FolderPlus, onSelect: after(() => cmd({ type: 'folder.create', spaceId: state.activeSpaceId, pinned: tab.pinned, tabIds: ids })) },
        { label: `Pin ${n} tabs`, icon: Pin, onSelect: after(() => ids.forEach((id) => cmd({ type: 'tab.update', tabId: id, patch: { pinned: true } }))) },
        { label: `Unpin ${n} tabs`, icon: PinOff, onSelect: after(() => ids.forEach((id) => cmd({ type: 'tab.update', tabId: id, patch: { pinned: false } }))) },
        n === 2 ? { label: 'Open side by side', icon: Columns2, onSelect: after(() => cmd({ type: 'ui.split', tabIds: [ids[0], ids[1]] })) } : { sep: true },
        {
          label: `Move ${n} tabs to space`,
          icon: Layers,
          children: state.spaces
            .filter((s) => s.id !== state.activeSpaceId)
            .map((s) => ({ label: `${s.icon}  ${s.name}`, onSelect: after(() => ids.forEach((id) => cmd({ type: 'tab.move', tabId: id, spaceId: s.id, favorite: false, pinned: false, folderId: null, beforeId: null }))) })),
        },
        { sep: true },
        { label: `Close ${n} tabs`, icon: X, danger: true, onSelect: after(() => ids.forEach((id) => cmd({ type: 'tab.close', tabId: id }))) },
      ]);
      return;
    }
    const folders = state.folders.filter((f) => f.spaceId === (tab.favorite ? state.activeSpaceId : tab.spaceId));
    const otherSpaces = state.spaces.filter((s) => s.id !== tab.spaceId || tab.favorite);
    const activeId = state.activeTabId;
    const items: MenuItem[] = [
      tab.favorite
        ? { label: 'Remove from Favorites', icon: StarOff, onSelect: () => cmd({ type: 'tab.update', tabId: tab.id, patch: { favorite: false } }) }
        : { label: 'Add to Favorites', icon: Star, onSelect: () => cmd({ type: 'tab.update', tabId: tab.id, patch: { favorite: true } }) },
      !tab.favorite &&
        (tab.pinned
          ? { label: 'Unpin', icon: PinOff, hint: '⌘D', onSelect: () => cmd({ type: 'tab.update', tabId: tab.id, patch: { pinned: false } }) }
          : { label: 'Pin', icon: Pin, hint: '⌘D', onSelect: () => cmd({ type: 'tab.update', tabId: tab.id, patch: { pinned: true } }) }),
      { label: 'Rename…', icon: Pencil, onSelect: () => setRenaming(tab.id) },
      { label: 'Duplicate', icon: CopyPlus, onSelect: () => cmd({ type: 'tab.duplicate', tabId: tab.id }) },
      { label: 'Copy link', icon: Copy, onSelect: () => cmd({ type: 'ui.copyUrl', tabId: tab.id }) },
      activeId && activeId !== tab.id
        ? { label: 'Open in split view', icon: Columns2, onSelect: () => cmd({ type: 'ui.split', tabIds: [activeId, tab.id] }) }
        : false,
      tab.audible || tab.muted
        ? { label: tab.muted ? 'Unmute' : 'Mute', icon: tab.muted ? Volume2 : VolumeX, onSelect: () => cmd({ type: 'tab.update', tabId: tab.id, patch: { muted: !tab.muted } }) }
        : false,
      { sep: true },
      !tab.favorite && {
        label: 'Add to folder',
        icon: FolderInput,
        children: [
          ...folders.map((f) => ({ label: f.name, icon: FolderIcon, onSelect: () => cmd({ type: 'tab.move', tabId: tab.id, spaceId: f.spaceId, pinned: f.pinned, folderId: f.id, beforeId: null }) })),
          { label: 'New folder', icon: FolderPlus, onSelect: () => cmd({ type: 'folder.create', spaceId: tab.spaceId, pinned: tab.pinned, tabIds: [tab.id] }) },
        ],
      },
      tab.folderId ? { label: 'Remove from folder', icon: FolderOpen, onSelect: () => cmd({ type: 'tab.move', tabId: tab.id, folderId: null, pinned: tab.pinned, beforeId: null }) } : false,
      otherSpaces.length > 0 && {
        label: 'Move to space',
        icon: Layers,
        children: otherSpaces.map((s) => ({ label: `${s.icon}  ${s.name}`, onSelect: () => cmd({ type: 'tab.move', tabId: tab.id, spaceId: s.id, favorite: false, pinned: false, folderId: null, beforeId: null }) })),
      },
      { sep: true },
      { label: 'Close', icon: X, danger: true, hint: '⌘W', onSelect: () => cmd({ type: 'tab.close', tabId: tab.id }) },
    ].filter(Boolean) as MenuItem[];
    openMenu(e, items);
  };
}

const TabRow = memo(function TabRow({ tab, active, agentHere, selected }: { tab: Tab; active: boolean; agentHere: boolean; selected: boolean }) {
  const s = useSortable({ id: `tab:${tab.id}` });
  const { renamingId, setRenaming, onRowClick } = useContext(Ctx);
  const menu = useTabMenu(tab);
  const renaming = renamingId === tab.id;
  return (
    <div
      ref={s.setNodeRef}
      {...s.attributes}
      {...s.listeners}
      role="button"
      style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }}
      className={cx('row', active && 'active', selected && 'selected', tab.asleep && 'asleep', agentHere && 'agent-here', s.isDragging && 'dragging-ghost')}
      title={tab.url}
      aria-selected={selected || active}
      onClick={(e) => !renaming && onRowClick(tab.id, e)}
      onDoubleClick={() => setRenaming(tab.id)}
      onAuxClick={(e) => e.button === 1 && cmd({ type: 'tab.close', tabId: tab.id })}
      onContextMenu={menu}
    >
      {tab.loading ? <span className="spinner" /> : <Favicon src={tab.favicon} url={tab.url} title={tab.title} />}
      {renaming ? (
        <RenameInput
          value={tab.title}
          onDone={(v) => {
            setRenaming(null);
            if (v !== null && v.trim() && v !== tab.title) cmd({ type: 'tab.update', tabId: tab.id, patch: { title: v.trim() } });
          }}
        />
      ) : (
        <span className="title truncate">{tab.title || hostOf(tab.url) || 'New Tab'}</span>
      )}
      <span className="end">
        {(tab.audible || tab.muted) && (
          <button
            className="icon-btn sm audio"
            title={tab.muted ? 'Unmute' : 'Mute'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              cmd({ type: 'tab.update', tabId: tab.id, patch: { muted: !tab.muted } });
            }}
          >
            {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        )}
        <button
          className="icon-btn sm close"
          title="Close tab"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            cmd({ type: 'tab.close', tabId: tab.id });
          }}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </span>
    </div>
  );
});

function RenameInput({ value, onDone }: { value: string; onDone(v: string | null): void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="title-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(v);
        if (e.key === 'Escape') onDone(null);
      }}
      onBlur={() => onDone(v)}
    />
  );
}

// ----- folders -----

const FolderItem = memo(function FolderItem({
  folder,
  kids,
  tabsById,
  into,
  activeId,
  agentTab,
  count,
  selected,
}: {
  folder: Folder;
  kids: string[];
  tabsById: Map<string, Tab>;
  into: boolean;
  activeId: string | null;
  agentTab: string | null;
  count: number;
  selected: Set<string>;
}) {
  const s = useSortable({ id: `folder:${folder.id}` });
  const head = useDroppable({ id: `folderhead:${folder.id}` });
  const kidsDrop = useDroppable({ id: `fold:${folder.id}`, disabled: folder.collapsed });
  const { renamingId, setRenaming } = useContext(Ctx);
  const openMenu = useContextMenu();
  const renaming = renamingId === folder.id;
  const toggle = () => cmd({ type: 'folder.update', folderId: folder.id, patch: { collapsed: !folder.collapsed } });
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMenu(e, [
      { label: 'Rename…', icon: Pencil, onSelect: () => setRenaming(folder.id) },
      { label: folder.collapsed ? 'Expand' : 'Collapse', icon: folder.collapsed ? FolderOpen : FolderIcon, onSelect: toggle },
      { label: folder.pinned ? 'Move to Today' : 'Move to Pinned', icon: folder.pinned ? PinOff : Pin, onSelect: () => cmd({ type: 'folder.move', folderId: folder.id, pinned: !folder.pinned, beforeId: null }) },
      { label: 'New folder', icon: FolderPlus, onSelect: () => cmd({ type: 'folder.create', spaceId: folder.spaceId, pinned: folder.pinned }) },
      { sep: true },
      { label: 'Delete folder, keep tabs', icon: Trash2, onSelect: () => cmd({ type: 'folder.delete', folderId: folder.id }) },
      { label: 'Delete folder and close tabs', icon: Trash2, danger: true, onSelect: () => cmd({ type: 'folder.delete', folderId: folder.id, closeTabs: true }) },
    ]);
  };
  return (
    <div ref={s.setNodeRef} style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }} className={cx(s.isDragging && 'dragging-ghost')}>
      <div
        ref={(el) => {
          head.setNodeRef(el);
          s.setActivatorNodeRef(el);
        }}
        {...s.attributes}
        {...s.listeners}
        className={cx('row folder-head', into && 'drop-into')}
        onClick={() => !renaming && toggle()}
        onDoubleClick={() => setRenaming(folder.id)}
        onContextMenu={menu}
      >
        <ChevronRight className={cx('chev', !folder.collapsed && 'open')} size={12} strokeWidth={2.4} style={{ marginRight: -4 }} />
        {folder.collapsed ? <FolderIcon className="ficon" size={15} strokeWidth={1.8} /> : <FolderOpen className="ficon" size={15} strokeWidth={1.8} />}
        {renaming ? (
          <RenameInput
            value={folder.name}
            onDone={(v) => {
              setRenaming(null);
              if (v !== null && v.trim() && v !== folder.name) cmd({ type: 'folder.update', folderId: folder.id, patch: { name: v.trim() } });
            }}
          />
        ) : (
          <span className="title truncate">{folder.name}</span>
        )}
        {folder.collapsed && count > 0 && <span className="count">{count}</span>}
      </div>
      {!folder.collapsed && (
        <SortableContext id={`fold:${folder.id}`} items={kids} strategy={verticalListSortingStrategy}>
          <div ref={kidsDrop.setNodeRef} className="folder-kids">
            {kids.map((key) => {
              const t = tabsById.get(idOf(key));
              return t ? <TabRow key={key} tab={t} active={t.id === activeId} agentHere={t.id === agentTab} selected={selected.has(t.id)} /> : null;
            })}
          </div>
        </SortableContext>
      )}
    </div>
  );
});

// ----- agent card -----

function AgentCard({ state }: { state: UIState }) {
  const a = state.agent;
  const show = a.active || a.paused;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className={cx('agent-card', a.paused && 'paused')}
          initial={{ opacity: 0, y: 10, height: 0, marginTop: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto', marginTop: 8 }}
          exit={{ opacity: 0, y: 10, height: 0, marginTop: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        >
          <div className="who">
            <span className="pulse-dot" />
            <span className="truncate">{a.paused ? 'Agents paused' : `${a.source ?? 'Agent'} is driving`}</span>
          </div>
          {!a.paused && a.label && <div className="what truncate">{a.label}</div>}
          {a.paused && <div className="what">Tool calls are refused until you resume.</div>}
          <div className="acts">
            {a.paused ? (
              <button className="btn btn-primary btn-sm" onClick={() => cmd({ type: 'agent.pause', paused: false })}>
                <Play size={12} fill="currentColor" /> Resume
              </button>
            ) : (
              <>
                <button className="btn btn-soft btn-sm" onClick={() => cmd({ type: 'agent.pause', paused: true })}>
                  <Pause size={12} fill="currentColor" /> Pause
                </button>
                <button className="btn btn-soft btn-sm" style={{ color: 'var(--danger)' }} onClick={() => cmd({ type: 'agent.stop' })}>
                  <Square size={11} fill="currentColor" /> Stop
                </button>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ----- footer: downloads, spaces, settings -----

function Footer({ state, dragging }: { state: UIState; dragging: boolean }) {
  const [dlOpen, setDlOpen] = useState(false);
  const progressing = state.downloads.filter((d) => d.state === 'progressing');
  const pct = progressing.length ? progressing.reduce((n, d) => n + (d.totalBytes ? d.receivedBytes / d.totalBytes : 0), 0) / progressing.length : 0;
  const live = state.agent.clients.filter((c) => Date.now() - c.lastSeenAt < 5 * 60_000);
  const openMenu = useContextMenu();
  return (
    <div className="sb-foot">
      <button className="icon-btn" title="Settings (⌘,)" onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'general' } })}>
        <SettingsIcon size={16} strokeWidth={1.8} />
      </button>
      {state.downloads.length > 0 && (
        <button className="icon-btn" title="Downloads" style={{ position: 'relative' }} onClick={() => setDlOpen((o) => !o)}>
          <Download size={16} strokeWidth={1.8} />
          {progressing.length > 0 && (
            <svg className="ring" viewBox="0 0 22 22">
              <circle cx="11" cy="11" r="10" fill="none" stroke="var(--line)" strokeWidth="1.6" />
              <circle cx="11" cy="11" r="10" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeDasharray={`${pct * 62.8} 62.8`} strokeLinecap="round" transform="rotate(-90 11 11)" />
            </svg>
          )}
        </button>
      )}
      <div className="spaces">
        {state.spaces.map((s, i) => (
          <SpaceDot
            key={s.id}
            space={s}
            index={i}
            active={s.id === state.activeSpaceId}
            dragging={dragging}
            onMenu={(e) =>
              openMenu(e, [
                { label: 'Edit space…', icon: Pencil, onSelect: () => cmd({ type: 'ui.overlay', overlay: { kind: 'space', spaceId: s.id } }) },
                { sep: true },
                { label: 'Delete space', icon: Trash2, danger: true, onSelect: () => cmd({ type: 'space.delete', spaceId: s.id }) },
              ])
            }
          />
        ))}
      </div>
      {live.length > 0 && (
        <button
          className="icon-btn"
          title={`Connected agents: ${live.map((c) => `${c.name} (${c.calls} calls)`).join(', ')}`}
          style={{ position: 'relative', color: 'var(--ok)' }}
          onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'agents' } })}
        >
          <Plug size={15} strokeWidth={1.9} />
          {live.length > 1 && <span className="badge">{live.length}</span>}
        </button>
      )}
      <button className="icon-btn" title="New space" onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'space' } })}>
        <Plus size={16} strokeWidth={1.9} />
      </button>
      {dlOpen && <Downloads downloads={state.downloads} onClose={() => setDlOpen(false)} />}
    </div>
  );
}

function SpaceDot({ space, index, active, dragging, onMenu }: { space: Space; index: number; active: boolean; dragging: boolean; onMenu(e: React.MouseEvent): void }) {
  const drop = useDroppable({ id: `space:${space.id}` });
  return (
    <button
      ref={drop.setNodeRef}
      className={cx('space-dot', active && 'active', dragging && drop.isOver && 'drop')}
      title={`${space.name}  ⌃${index + 1}`}
      onClick={() => cmd({ type: 'space.activate', spaceId: space.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
    >
      {space.icon}
      {active && <span className="bar" style={{ background: space.color }} />}
    </button>
  );
}

function Downloads({ downloads, onClose }: { downloads: DownloadT[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => window.addEventListener('mousedown', h), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', h);
    };
  }, [onClose]);
  return (
    <div className="pop scroll" ref={ref}>
      <h4>
        Downloads
        <button className="btn btn-ghost btn-sm" onClick={() => cmd({ type: 'download.clear' })}>
          Clear
        </button>
      </h4>
      {[...downloads].reverse().map((d) => (
        <div
          key={d.id}
          className="dl"
          role="button"
          onClick={() => d.state === 'completed' && cmd({ type: 'download.open', id: d.id })}
          title={d.path}
        >
          <span className="n truncate">{d.filename}</span>
          <button
            className="icon-btn sm"
            title="Show in folder"
            onClick={(e) => {
              e.stopPropagation();
              cmd({ type: 'download.reveal', id: d.id });
            }}
          >
            <FolderOpen size={13} />
          </button>
          <span className="m">
            {d.state === 'progressing'
              ? `${formatBytes(d.receivedBytes)} of ${formatBytes(d.totalBytes)}`
              : d.state === 'completed'
                ? formatBytes(d.totalBytes || d.receivedBytes)
                : d.state === 'cancelled'
                  ? 'Cancelled'
                  : 'Failed'}
          </span>
          {d.state === 'progressing' && (
            <div className="bar">
              <i style={{ width: `${d.totalBytes ? (100 * d.receivedBytes) / d.totalBytes : 30}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

