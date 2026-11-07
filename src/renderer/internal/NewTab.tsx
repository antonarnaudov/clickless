import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, History, Search, Sparkles } from 'lucide-react';
import type { HistoryEntry, Suggestion, UIState } from '../../shared/types';
import { cmd, query } from '../common/api';
import { Favicon } from '../common/Favicon';
import { cx, debounce, hostOf, timeAgo } from '../common/util';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function NewTab({ state }: { state: UIState | null }) {
  const [input, setInput] = useState('');
  const [ask, setAsk] = useState(false);
  const [sugg, setSugg] = useState<Suggestion[]>([]);
  const [sel, setSel] = useState(-1);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'New Tab';
    ref.current?.focus();
    query('history', { limit: 8 }).then((h) => setHistory(h ?? []), () => undefined);
  }, []);

  const fetch = useMemo(
    () =>
      debounce((q: string) => {
        if (!q.trim()) return setSugg([]);
        query('suggest', { input: q, limit: 6 }).then(
          (r) => setSugg((r ?? []).filter((s) => s.kind !== 'tab' && s.kind !== 'archived' && s.kind !== 'command').slice(0, 6)),
          () => setSugg([]),
        );
      }, 60),
    [],
  );
  useEffect(() => {
    if (!ask) fetch(input);
    else setSugg([]);
    setSel(-1);
  }, [input, ask]);

  const go = (q: string, asAsk = ask) => {
    const v = q.trim();
    if (!v) return;
    if (asAsk) cmd({ type: 'ask.start', query: v, tabId: state?.activeTabId ?? undefined });
    else cmd({ type: 'tab.navigate', input: v });
  };

  const pick = (s: Suggestion) => {
    if (s.kind === 'ask') go(s.title, true);
    else go(s.url ?? s.title, false);
  };

  const favorites = (state?.tabs ?? []).filter((t) => t.favorite).sort((a, b) => a.order - b.order).slice(0, 8);
  const space = state?.spaces.find((s) => s.id === state.activeSpaceId);

  return (
    <div className="nt">
      <div className="page-bg" />
      <h1 className="nt-greet">{greeting()}</h1>
      <p className="nt-sub">{space ? `${space.icon}  ${space.name}` : 'Search the web, open a site, or ask.'}</p>

      <div className="nt-box">
        <div className={cx('nt-input', ask && 'ask')}>
          {ask ? <Sparkles className="lead" size={20} /> : <Search className="lead" size={20} />}
          <input
            ref={ref}
            value={input}
            placeholder={ask ? 'Ask anything — answers come with sources' : 'Search or enter address'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault();
                setAsk((a) => !a);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((i) => Math.min(sugg.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((i) => Math.max(-1, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (sel >= 0 && sugg[sel]) pick(sugg[sel]);
                else go(input, ask || e.metaKey || e.ctrlKey);
              } else if (e.key === 'Escape') {
                setSugg([]);
              }
            }}
            spellCheck={false}
          />
          <button className={cx('nt-mode', ask && 'on')} onClick={() => (input.trim() && !ask ? go(input, true) : setAsk((a) => !a))} title="Tab to switch">
            <Sparkles size={14} /> Ask
          </button>
        </div>
        {sugg.length > 0 && (
          <div className="nt-sugg">
            {sugg.map((s, i) => (
              <button key={i} className={cx(i === sel && 'sel')} onMouseEnter={() => setSel(i)} onClick={() => pick(s)}>
                {s.kind === 'ask' ? <Sparkles size={15} style={{ color: 'var(--accent)' }} /> : s.kind === 'history' ? <History size={15} style={{ color: 'var(--ink-3)' }} /> : s.kind === 'url' ? <Globe size={15} style={{ color: 'var(--ink-3)' }} /> : <Search size={15} style={{ color: 'var(--ink-3)' }} />}
                <span className="truncate" style={{ flex: 1 }}>
                  {s.title}
                </span>
                <span className="st truncate" style={{ maxWidth: '40%' }}>
                  {s.kind === 'ask' ? 'Ask AI' : s.subtitle ?? (s.url ? hostOf(s.url) : '')}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {favorites.length > 0 && (
        <div className="nt-favs">
          {favorites.map((t) => (
            <button key={t.id} className="nt-fav" onClick={() => cmd({ type: 'tab.navigate', input: t.url })} title={t.url}>
              <span className="tile">
                <Favicon src={t.favicon} url={t.url} title={t.title} size={26} />
              </span>
              <span className="t truncate">{t.title.split(/[—–|·-]/)[0].trim() || hostOf(t.url)}</span>
            </button>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="nt-recent">
          <h4>Recently visited</h4>
          <div className="grid">
            {history.slice(0, 8).map((h) => (
              <button key={h.url} onClick={() => cmd({ type: 'tab.navigate', input: h.url })} title={h.url}>
                <Favicon src={h.favicon} url={h.url} title={h.title} />
                <span className="truncate" style={{ flex: 1 }}>
                  {h.title || hostOf(h.url)}
                </span>
                <span className="h">{timeAgo(h.lastVisitAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="nt-foot">
        <span>
          <span className="kbd">Tab</span> ask AI
        </span>
        <span>
          <span className="kbd">⌘E</span> give the agent a task
        </span>
        <span>
          <span className="kbd">⌘T</span> command bar
        </span>
      </div>
    </div>
  );
}
