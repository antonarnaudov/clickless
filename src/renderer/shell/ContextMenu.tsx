import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { cx } from '../common/util';

export type MenuItem =
  | { sep: true }
  | { sep?: false; label: string; icon?: LucideIcon; onSelect?: () => void; danger?: boolean; children?: MenuItem[]; hint?: string };

type Open = (at: { clientX: number; clientY: number }, items: MenuItem[]) => void;

const MenuCtx = createContext<Open>(() => undefined);
export const useContextMenu = () => useContext(MenuCtx);

/**
 * Menus are drawn inside the shell, which sits behind the page views — so they are clamped to
 * the sidebar's bounds (anything over the page area would be hidden under the native view).
 */
export function ContextMenuHost({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = useCallback<Open>((at, items) => setMenu({ x: at.clientX, y: at.clientY, items }), []);
  return (
    <MenuCtx.Provider value={open}>
      {children}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </MenuCtx.Provider>
  );
}

function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hl, setHl] = useState(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sb = document.querySelector('.sidebar')?.getBoundingClientRect();
    const maxRight = sb && x <= sb.right ? sb.right - 4 : window.innerWidth - 6;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: Math.max(6, Math.min(x, maxRight - w)),
      top: Math.max(6, Math.min(y, window.innerHeight - h - 6)),
    });
  }, [x, y, expanded]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const flat = flatItems(items, expanded);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHl((h) => nextIdx(flat, h, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHl((h) => nextIdx(flat, h, -1));
      } else if (e.key === 'Enter' && hl >= 0) {
        const it = flat[hl];
        if (it && !it.sep) select(it);
      }
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
    };
  });

  const select = (it: Exclude<MenuItem, { sep: true }>) => {
    if (it.children) {
      setExpanded((e) => (e === it.label ? null : it.label));
      return;
    }
    onClose();
    it.onSelect?.();
  };

  const flat = flatItems(items, expanded);
  return (
    <div ref={ref} className="ctx" style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {flat.map((it, i) =>
        it.sep ? (
          <div key={`s${i}`} className="sep" />
        ) : (
          <button
            key={`${it.label}${i}`}
            role="menuitem"
            className={cx('mi', it.danger && 'danger', hl === i && 'hl', it.nested && 'nest')}
            onMouseEnter={() => setHl(i)}
            onClick={() => select(it)}
          >
            {it.icon && <it.icon size={14} strokeWidth={1.9} />}
            <span className="truncate">{it.label}</span>
            {it.children && <ChevronRight className="sub" size={13} style={{ transform: expanded === it.label ? 'rotate(90deg)' : undefined, transition: 'transform 140ms' }} />}
            {it.hint && <span className="sub kbd">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

type FlatItem = { sep: true } | (Exclude<MenuItem, { sep: true }> & { nested?: boolean });

function flatItems(items: MenuItem[], expanded: string | null): FlatItem[] {
  const out: FlatItem[] = [];
  for (const it of items) {
    out.push(it);
    if (!it.sep && it.children && expanded === it.label) for (const c of it.children) out.push(c.sep ? c : { ...c, nested: true });
  }
  return out;
}

function nextIdx(flat: FlatItem[], from: number, dir: 1 | -1): number {
  let i = from;
  for (let n = 0; n < flat.length; n++) {
    i = (i + dir + flat.length) % flat.length;
    if (!flat[i].sep) return i;
  }
  return from;
}
