import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, FileText, MousePointerClick, Plug, RotateCcw, Search, Sparkles, Square, Wand2, X, CircleX } from 'lucide-react';
import type { ChatItem, UIState } from '../../shared/types';
import { cmd, useChat } from '../common/api';
import { linkFromEvent, renderMarkdown } from '../common/markdown';
import { cx, formatMs } from '../common/util';

const EXAMPLES = [
  { icon: FileText, text: 'Summarize this page in 5 bullets' },
  { icon: Search, text: 'Find the cheapest direct flight from Berlin to London next Friday' },
  { icon: MousePointerClick, text: 'Fill this form with my details and stop before submitting' },
  { icon: Wand2, text: 'Organize my tabs into folders' },
];

export const AgentPanel = memo(function AgentPanel({ state, focusSignal }: { state: UIState; focusSignal: number }) {
  const chat = useChat();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = chat?.running ?? false;

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusSignal]);

  // Keep scrolled to the bottom while new content streams in, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const autosize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  };
  useLayoutEffect(autosize, [text]);

  const send = (t = text) => {
    const v = t.trim();
    if (!v || running) return;
    stick.current = true;
    cmd({ type: 'agent.send', text: v });
    setText('');
  };

  const groups = useMemo(() => groupItems(chat?.items ?? []), [chat?.items]);
  const noProvider = chat ? chat.providerLabel === null : false;
  const live = state.agent.clients.filter((c) => Date.now() - c.lastSeenAt < 5 * 60_000);

  return (
    <div className="panel-card">
      <div className="panel-head">
        <Sparkles size={15} style={{ color: 'var(--accent)' }} />
        <span className="ttl">Agent</span>
        <span style={{ flex: 1 }} />
        {chat?.providerLabel && (
          <button className="chip truncate" title="Change model" onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'ai' } })}>
            {chat.providerLabel}
          </button>
        )}
        <button className="icon-btn sm" title="New conversation" disabled={!chat?.items.length || running} onClick={() => cmd({ type: 'agent.reset' })}>
          <RotateCcw size={13} />
        </button>
        <button className="icon-btn sm" title="Close (⌘E)" onClick={() => cmd({ type: 'ui.panel', open: false })}>
          <X size={14} />
        </button>
      </div>

      <div
        className="panel-body scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        onClick={(e) => {
          const url = linkFromEvent(e);
          if (url) cmd({ type: 'tab.new', url });
        }}
      >
        {!groups.length ? (
          <div className="panel-empty">
            <h3>What should I do on the web for you?</h3>
            <p>I can read this page, click, type, search and work across tabs. You can watch every step and take over any time.</p>
            {noProvider ? (
              <button className="cta" style={{ textAlign: 'left' }} onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'ai' } })}>
                <Sparkles size={15} />
                <span>
                  <b>Connect a model to start.</b> Anthropic, OpenAI, OpenRouter, Ollama, LM Studio — or your local Claude Code login.
                </span>
              </button>
            ) : (
              <div className="examples">
                {EXAMPLES.map((ex) => (
                  <button key={ex.text} className="example" onClick={() => send(ex.text)}>
                    <ex.icon size={14} />
                    <span>{ex.text}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="ext-agents">
              {live.length ? (
                <>
                  <span className="live" /> Also driving Clickless: {live.map((c) => c.name).join(', ')}
                </>
              ) : (
                <>
                  <Plug size={12} /> Prefer Claude Code, Cursor or a local LLM?
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--accent-text)', padding: '0 4px' }} onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'agents' } })}>
                    Connect an agent
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          groups.map((g) => (g.kind === 'steps' ? <Steps key={g.items[0].id} items={g.items} /> : <Item key={g.item.id} item={g.item} />))
        )}
      </div>

      <div className="composer">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={noProvider ? 'Connect a model in Settings → AI' : running ? 'Working… Esc to stop' : 'Ask or tell the agent what to do'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
            if (e.key === 'Escape') {
              if (running) cmd({ type: 'agent.stop' });
              else cmd({ type: 'ui.focusPage' });
            }
          }}
        />
        <div className="bar">
          <span className="hint">{running && chat ? `Step ${chat.steps} of ${chat.maxSteps}` : 'Uses the current tab · ⇧↩ new line'}</span>
          {running ? (
            <button className="send stop" title="Stop (Esc)" onClick={() => cmd({ type: 'agent.stop' })}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button className="send" title="Send (↩)" disabled={!text.trim() || noProvider} onClick={() => send()}>
              <ArrowUp size={15} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

type Group = { kind: 'steps'; items: Extract<ChatItem, { kind: 'tool' }>[] } | { kind: 'one'; item: ChatItem };

function groupItems(items: ChatItem[]): Group[] {
  const out: Group[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === 'tool') {
      if (last?.kind === 'steps') last.items.push(it);
      else out.push({ kind: 'steps', items: [it] });
    } else out.push({ kind: 'one', item: it });
  }
  return out;
}

const Item = memo(function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg-user">{item.text}</div>;
    case 'assistant':
      return <Assistant text={item.text} streaming={!!item.streaming} />;
    case 'error':
      return <div className="msg-error">{item.text}</div>;
    case 'notice':
      return <div className="msg-notice">{item.text}</div>;
    default:
      return null;
  }
});

function Assistant({ text, streaming }: { text: string; streaming: boolean }) {
  const html = useMemo(() => renderMarkdown(text || (streaming ? ' ' : '')), [text, streaming]);
  return (
    <div className={cx('msg-assistant', streaming && 'streaming')}>
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

const Steps = memo(function Steps({ items }: { items: Extract<ChatItem, { kind: 'tool' }>[] }) {
  return (
    <div className="steps">
      {items.map((s) => (
        <Step key={s.id} step={s} />
      ))}
    </div>
  );
});

const Step = memo(function Step({ step }: { step: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(step.status === 'error');
  const has = !!(step.result || step.image);
  return (
    <div className="step">
      <button className="step-row" onClick={() => has && setOpen((o) => !o)} title={step.summary}>
        <span className={cx('st', step.status)}>
          {step.status === 'running' ? <span className="spinner" /> : step.status === 'done' ? <Check size={12} strokeWidth={3} /> : <CircleX size={13} strokeWidth={2.2} />}
        </span>
        <span className="nm">{step.name}</span>
        <span className="sm truncate">{step.summary}</span>
        {step.ms !== undefined && <span className="ms">{formatMs(step.ms)}</span>}
      </button>
      {open && has && (
        <div className="step-detail">
          {step.result && <pre>{step.result}</pre>}
          {step.image && <img src={step.image} alt="Screenshot the tool returned" />}
        </div>
      )}
    </div>
  );
});

