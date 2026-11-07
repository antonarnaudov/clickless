import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, BookOpen, Check, CircleAlert, CornerDownRight, Globe, PenLine, RotateCcw, Search, Sparkles, Square } from 'lucide-react';
import type { AskSource, AskTurn } from '../../shared/types';
import { cmd, useAsk } from '../common/api';
import { Favicon } from '../common/Favicon';
import { linkFromEvent, renderCited } from '../common/markdown';
import { cx, formatMs, hostOf } from '../common/util';

export function Ask({ askId }: { askId: string | null }) {
  const ask = useAsk(askId);
  const [q, setQ] = useState('');
  const [tip, setTip] = useState<{ src: AskSource; x: number; y: number } | null>(null);
  const [hl, setHl] = useState<{ turn: number; n: number } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const last = ask?.turns[ask.turns.length - 1];
  const running = !!last && ['searching', 'reading', 'answering'].includes(last.status);

  useEffect(() => {
    if (ask?.turns[0]) document.title = ask.turns[0].query;
  }, [ask?.turns[0]?.query]);

  // Follow the newest turn as it appears.
  const turnCount = ask?.turns.length ?? 0;
  useEffect(() => {
    if (turnCount > 1) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [turnCount]);

  const send = (text = q) => {
    const v = text.trim();
    if (!v || !askId || running) return;
    cmd({ type: 'ask.followup', askId, query: v });
    setQ('');
  };

  if (!askId) return <div className="ask">Missing search id.</div>;

  return (
    <div className="ask">
      <div className="page-bg" />
      <div className="ask-top">
        <span className="mark">
          <Sparkles size={12} strokeWidth={2.4} />
        </span>
        <span>Clickless Search</span>
        <span style={{ flex: 1 }} />
        {ask?.providerLabel ? <span className="chip">{ask.providerLabel}</span> : ask && <button className="chip" onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'ai' } })}>Connect a model for answers</button>}
      </div>

      {!ask && (
        <div className="skeleton">
          <i style={{ width: '60%', height: 30 }} />
          <i style={{ width: '30%' }} />
          <i />
          <i style={{ width: '90%' }} />
        </div>
      )}

      {ask?.turns.map((t, i) => (
        <div key={i} ref={i === ask.turns.length - 1 ? endRef : undefined} style={{ scrollMarginTop: 20 }}>
          <Turn
            turn={t}
            index={i}
            hl={hl?.turn === i ? hl.n : null}
            noModel={!ask.providerLabel}
            onRetry={() => askId && cmd({ type: 'ask.followup', askId, query: t.query })}
            onCite={(src, el) => {
              if (!src) return setTip(null);
              const r = el.getBoundingClientRect();
              setTip({ src, x: Math.min(window.innerWidth - 316, Math.max(8, r.left - 140)), y: r.bottom + 8 > window.innerHeight - 140 ? r.top - 130 : r.bottom + 8 });
            }}
            onHl={(n) => setHl(n === null ? null : { turn: i, n })}
          />
        </div>
      ))}

      {ask && !running && ask.related.length > 0 && (
        <div className="ask-related">
          <h4>Related</h4>
          {ask.related.map((r) => (
            <button key={r} onClick={() => send(r)}>
              <CornerDownRight size={15} />
              <span style={{ flex: 1 }}>{r}</span>
              <ArrowRight size={14} style={{ color: 'var(--ink-4)' }} />
            </button>
          ))}
        </div>
      )}

      {tip && (
        <div className="cite-tip" style={{ left: tip.x, top: tip.y }}>
          <div className="h">
            <Favicon src={tip.src.favicon} url={tip.src.url} title={tip.src.title} size={14} />
            {hostOf(tip.src.url)} · {tip.src.n}
          </div>
          <b>{tip.src.title}</b>
          {tip.src.snippet && <p>{tip.src.snippet}</p>}
        </div>
      )}

      <div className="follow">
        <Sparkles size={18} style={{ color: 'var(--accent)', flex: 'none' }} />
        <input
          value={q}
          placeholder={running ? 'Working on it…' : 'Ask a follow-up'}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
            if (e.key === 'Escape' && running && askId) cmd({ type: 'ask.stop', askId });
          }}
        />
        {running ? (
          <button className="go stop" title="Stop" onClick={() => askId && cmd({ type: 'ask.stop', askId })}>
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button className="go" title="Ask" disabled={!q.trim()} onClick={() => send()}>
            <ArrowUp size={17} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}

const STEPS: { key: 'searching' | 'reading' | 'answering'; label: (t: AskTurn) => string; icon: typeof Search }[] = [
  { key: 'searching', label: () => 'Searching the web', icon: Search },
  { key: 'reading', label: (t) => (t.sources.length ? `Reading ${t.sources.filter((s) => s.read).length || t.sources.length} pages` : 'Reading pages'), icon: BookOpen },
  { key: 'answering', label: () => 'Writing the answer', icon: PenLine },
];

const Turn = memo(function Turn({
  turn,
  index,
  hl,
  noModel,
  onRetry,
  onCite,
  onHl,
}: {
  turn: AskTurn;
  index: number;
  hl: number | null;
  noModel: boolean;
  onRetry(): void;
  onCite(src: AskSource | null, el: HTMLElement): void;
  onHl(n: number | null): void;
}) {
  const [showAll, setShowAll] = useState(false);
  const order = ['searching', 'reading', 'answering', 'done'];
  const at = order.indexOf(turn.status === 'error' || turn.status === 'stopped' ? 'done' : turn.status);
  const html = useMemo(() => renderCited(turn.answer, turn.sources.length), [turn.answer, turn.sources.length]);
  const streaming = turn.status === 'answering';
  const visible = showAll ? turn.sources : turn.sources.slice(0, turn.sources.length > 4 ? 3 : 4);
  const bySrc = (n: number) => turn.sources.find((s) => s.n === n);

  return (
    <section className="turn" style={{ animationDelay: `${index ? 0 : 60}ms` }}>
      <h1>{turn.query}</h1>

      {turn.status !== 'done' && turn.status !== 'error' && turn.status !== 'stopped' ? (
        <div className="progress">
          {STEPS.map((s, i) => {
            const st = i < at ? 'done' : i === at ? 'now' : 'wait';
            return (
              <span key={s.key} className={cx('p', st)}>
                {st === 'done' ? <Check size={13} strokeWidth={2.6} /> : st === 'now' ? <span className="spinner" /> : <s.icon size={13} />}
                {s.label(turn)}
              </span>
            );
          })}
        </div>
      ) : null}

      {turn.sources.length > 0 && (
        <div className="sources">
          {visible.map((s, i) => (
            <a
              key={s.n}
              className={cx('src', !s.read && 'unread', hl === s.n && 'hl')}
              style={{ animationDelay: `${i * 50}ms` }}
              title={s.url}
              onClick={(e) => {
                e.preventDefault();
                cmd({ type: 'tab.new', url: s.url });
              }}
            >
              <span className="t">{s.title}</span>
              <span className="h">
                <Favicon src={s.favicon} url={s.url} title={s.title} size={14} />
                <span className="truncate">{hostOf(s.url)}</span>
                <span className="n">{s.n}</span>
              </span>
            </a>
          ))}
          {!showAll && turn.sources.length > 4 && (
            <button className="src more" onClick={() => setShowAll(true)}>
              <span style={{ display: 'flex' }}>
                {turn.sources.slice(3, 7).map((s) => (
                  <span key={s.n} style={{ marginLeft: -4 }}>
                    <Favicon src={s.favicon} url={s.url} title={s.title} size={16} />
                  </span>
                ))}
              </span>
              +{turn.sources.length - 3} sources
            </button>
          )}
        </div>
      )}

      {turn.status === 'error' ? (
        <div className="turn-error">
          <CircleAlert size={17} style={{ flex: 'none', marginTop: 2 }} />
          <div style={{ flex: 1 }}>
            {turn.error ?? 'Something went wrong.'}
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-soft btn-sm" onClick={onRetry}>
                <RotateCcw size={12} /> Try again
              </button>
            </div>
          </div>
        </div>
      ) : turn.answer ? (
        <div
          className={cx('answer md', streaming && 'streaming')}
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            const url = linkFromEvent(e);
            if (url) return cmd({ type: 'tab.new', url });
            const c = (e.target as HTMLElement).closest('[data-cite]') as HTMLElement | null;
            if (c) {
              const s = bySrc(Number(c.dataset.cite));
              if (s) cmd({ type: 'tab.new', url: s.url });
            }
          }}
          onMouseOver={(e) => {
            const c = (e.target as HTMLElement).closest('[data-cite]') as HTMLElement | null;
            if (c) {
              const n = Number(c.dataset.cite);
              const s = bySrc(n);
              if (s) {
                onCite(s, c);
                onHl(n);
              }
            }
          }}
          onMouseOut={(e) => {
            const c = (e.target as HTMLElement).closest('[data-cite]');
            if (c) {
              onCite(null, c as HTMLElement);
              onHl(null);
            }
          }}
        />
      ) : turn.status === 'answering' || turn.status === 'reading' ? (
        <div className="skeleton">
          <i style={{ width: '94%' }} />
          <i style={{ width: '88%' }} />
          <i style={{ width: '72%' }} />
        </div>
      ) : turn.status === 'done' && noModel ? (
        <div className="turn-meta" style={{ marginTop: 0, color: 'var(--ink-3)', fontSize: 13 }}>
          <Globe size={14} /> Showing sources only — connect a model in Settings → AI to get written answers.
        </div>
      ) : null}

      {(turn.status === 'done' || turn.status === 'stopped') && (
        <div className="turn-meta">
          {turn.status === 'stopped' ? 'Stopped' : `Answered${turn.ms ? ` in ${formatMs(turn.ms)}` : ''}`} · {turn.sources.length} sources
        </div>
      )}
    </section>
  );
});

