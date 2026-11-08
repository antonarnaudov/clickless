import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Search, Trash2, X } from 'lucide-react';
import type { HistoryEntry } from '../../shared/types';
import { cmd, query } from '../common/api';
import { Favicon } from '../common/Favicon';
import { cx, debounce, hostOf, timeAgo } from '../common/util';

type Closed = { id: string; url: string; title: string; favicon?: string; closedAt: number };

const DAY = 86_400_000;
const startOfDay = (t: number) => new Date(new Date(t).toDateString()).getTime();

function dayLabel(t: number) {
  const today = startOfDay(Date.now());
  const d = startOfDay(t);
  if (d === today) return 'Today';
  if (d === today - DAY) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** clickless://history — every site you've been to, searchable, deletable; and recently closed tabs. */
export function HistoryPage() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [closed, setClosed] = useState<Closed[]>([]);
  const [clearing, setClearing] = useState(false);

  const load = useMemo(
    () =>
      debounce((text: string) => {
        query('history', { query: text, limit: 2000 }).then((h) => setItems(text ? (h ?? []) : (h ?? []).sort((a, b) => b.lastVisitAt - a.lastVisitAt)), () => setItems([]));
      }, 80),
    [],
  );
  const loadClosed = () => query('recentlyClosed', {}).then((c) => setClosed(c ?? []), () => setClosed([]));

  useEffect(() => {
    document.title = 'History';
    load('');
    loadClosed();
    const f = () => (load(q), loadClosed());
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, []);
  useEffect(() => load(q), [q]);

  const groups = useMemo(() => {
    if (q) return [{ label: `${items.length} result${items.length === 1 ? '' : 's'}`, items }];
    const out: { label: string; items: HistoryEntry[] }[] = [];
    for (const e of items) {
      const label = dayLabel(e.lastVisitAt);
      if (out[out.length - 1]?.label !== label) out.push({ label, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [items, q]);

  const open = (url: string, e: React.MouseEvent) => cmd(e.metaKey || e.ctrlKey || e.button === 1 ? { type: 'tab.new', url, background: true } : { type: 'tab.new', url });
  const remove = async (urls: string[]) => {
    await cmd({ type: 'history.delete', urls });
    setItems((list) => list.filter((x) => !urls.includes(x.url)));
  };
  const clear = async (since?: number) => {
    await cmd({ type: 'history.clear', since });
    setClearing(false);
    load(q);
  };

  return (
    <div className="page-bg">
      <div className="hist">
        <header className="hist-top">
          <h1>History</h1>
          <div className="hist-search">
            <Search size={15} />
            <input autoFocus value={q} placeholder="Search history" onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button className="icon-btn sm" title="Clear search" onClick={() => setQ('')}>
                <X size={13} />
              </button>
            )}
          </div>
          <div className="hist-clear">
            {clearing ? (
              <>
                <span>Clear:</span>
                <button className="btn btn-ghost btn-sm" onClick={() => clear(Date.now() - 3_600_000)}>
                  Last hour
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => clear(startOfDay(Date.now()))}>
                  Today
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => clear()}>
                  All history
                </button>
                <button className="icon-btn sm" title="Cancel" onClick={() => setClearing(false)}>
                  <X size={13} />
                </button>
              </>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setClearing(true)}>
                <Trash2 size={13} /> Clear history…
              </button>
            )}
          </div>
        </header>

        {!q && closed.length > 0 && (
          <section className="hist-day">
            <h2>Recently closed</h2>
            {closed.slice(0, 10).map((c) => (
              <div key={c.id} className="hist-row" role="button" onClick={() => cmd({ type: 'tab.reopenClosed', closedId: c.id }).then(loadClosed)}>
                <span className="when">{timeAgo(c.closedAt)}</span>
                <Favicon src={c.favicon} url={c.url} title={c.title} />
                <span className="title truncate">{c.title || c.url}</span>
                <span className="host truncate">{hostOf(c.url)}</span>
                <span className="hist-act" title="Reopen with its back/forward history">
                  <RotateCcw size={13} /> Reopen
                </span>
              </div>
            ))}
          </section>
        )}

        {groups.map((g) => (
          <section key={g.label} className="hist-day">
            <h2>{g.label}</h2>
            {g.items.map((e) => (
              <div key={e.url} className={cx('hist-row')} role="button" title={e.url} onClick={(ev) => open(e.url, ev)} onAuxClick={(ev) => ev.button === 1 && open(e.url, ev)}>
                <span className="when">{time(e.lastVisitAt)}</span>
                <Favicon src={e.favicon} url={e.url} title={e.title} />
                <span className="title truncate">{e.title || e.url}</span>
                <span className="host truncate">
                  {hostOf(e.url)}
                  {e.visitCount > 1 ? ` · ${e.visitCount} visits` : ''}
                </span>
                <button
                  className="icon-btn sm"
                  title="Remove from history"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    remove([e.url]);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </section>
        ))}
        {!items.length && <p className="hist-empty">{q ? 'Nothing in your history matches that.' : 'No history yet.'}</p>}
      </div>
    </div>
  );
}
