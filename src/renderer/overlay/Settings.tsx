import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Copy, Eye, EyeOff, KeyRound, Laptop, LayoutGrid, Moon, Plug, RefreshCw, Search, ShieldCheck, Sparkles, Sun, Trash2, X, type LucideIcon } from 'lucide-react';
import type { Command, DeepPartial, QueryMap } from '../../shared/ipc';
import { PROVIDER_PRESETS, SEARCH_ENGINES, type ProviderPreset } from '../../shared/settings';
import type { ImportReport, ImportSource, OverlayState, ProviderConfig, Settings as SettingsT, UIState } from '../../shared/types';
import { cmd, query } from '../common/api';
import { copyText, cx, debounce, letterColor, timeAgo } from '../common/util';

type Section = NonNullable<Extract<OverlayState, { kind: 'settings' }>['section']>;

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: LayoutGrid },
  { id: 'ai', label: 'AI models', icon: Sparkles },
  { id: 'agents', label: 'Agents & API', icon: Plug },
  { id: 'search', label: 'AI search', icon: Search },
  { id: 'tabs', label: 'Tabs', icon: Laptop },
  { id: 'backup', label: 'Backup', icon: ShieldCheck },
];

const update = (patch: DeepPartial<SettingsT>) => cmd({ type: 'settings.update', patch });

export function Settings({ overlay, state }: { overlay: Extract<OverlayState, { kind: 'settings' }>; state: UIState }) {
  const [section, setSection] = useState<Section>(overlay.section ?? 'general');
  useEffect(() => setSection(overlay.section ?? 'general'), [overlay.section]);
  const s = state.settings;
  const current = SECTIONS.find((x) => x.id === section)!;
  return (
    <div className="modal settings" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
      <nav className="s-nav">
        <h2>Settings</h2>
        {SECTIONS.map((x) => (
          <button key={x.id} className={cx(section === x.id && 'on')} onClick={() => setSection(x.id)}>
            <x.icon size={15} strokeWidth={1.9} /> {x.label}
          </button>
        ))}
        <div className="ver">
          Clickless 0.1 · open source
          <br />
          {state.control.running ? `API on :${state.control.port}` : 'API off'}
        </div>
      </nav>
      <div className="s-body">
        <div className="s-head">
          <h3>{current.label}</h3>
          <button className="icon-btn" title="Close (Esc)" onClick={() => cmd({ type: 'ui.overlay', overlay: null })}>
            <X size={16} />
          </button>
        </div>
        <div className="s-content scroll">
          {section === 'general' && <General s={s} />}
          {section === 'ai' && <AI s={s} />}
          {section === 'agents' && <Agents state={state} />}
          {section === 'search' && <SearchSection s={s} />}
          {section === 'tabs' && <Tabs s={s} />}
          {section === 'backup' && <Backup s={s} status={state.backup} />}
        </div>
      </div>
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="s-row">
      <div className="k">
        <b>{title}</b>
        {desc && <span>{desc}</span>}
      </div>
      <div className="v">{children}</div>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string }) {
  return <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string; icon?: LucideIcon }[]; onChange(v: T): void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.v} className={cx(value === o.v && 'on')} onClick={() => onChange(o.v)}>
          {o.icon && <o.icon size={13} />} {o.label}
        </button>
      ))}
    </div>
  );
}

/** Text input that saves after a pause. */
function LazyInput({ value, onSave, placeholder, type = 'text', width, mono }: { value: string; onSave(v: string): void; placeholder?: string; type?: string; width?: number; mono?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const save = useMemo(() => debounce((x: string) => saveRef.current(x), 500), []);
  return (
    <input
      className={cx('field', mono && 'mono')}
      style={width ? { width } : undefined}
      type={type}
      value={v}
      placeholder={placeholder}
      onChange={(e) => {
        setV(e.target.value);
        save(e.target.value);
      }}
      onBlur={() => {
        save.cancel();
        if (v !== value) onSave(v);
      }}
    />
  );
}

// ---------- General ----------

function General({ s }: { s: SettingsT }) {
  return (
    <>
      <div className="s-group">
        <div className="lbl">Appearance</div>
        <Row title="Theme" desc="Follows macOS unless you pick one.">
          <Seg
            value={s.appearance.theme}
            onChange={(theme) => update({ appearance: { theme } })}
            options={[
              { v: 'system', label: 'Auto', icon: Laptop },
              { v: 'light', label: 'Light', icon: Sun },
              { v: 'dark', label: 'Dark', icon: Moon },
            ]}
          />
        </Row>
        <Row title="Address above the page" desc="Show a compact URL bar on top of the page instead of in the sidebar.">
          <Switch label="Address above the page" on={s.appearance.compactUrl} onChange={(compactUrl) => update({ appearance: { compactUrl } })} />
        </Row>
      </div>
      <div className="s-group">
        <div className="lbl">Search</div>
        <Row title="Search engine" desc="Used when you type words instead of an address.">
          <select className="field" style={{ width: 200 }} value={s.searchEngine} onChange={(e) => update({ searchEngine: e.target.value as SettingsT['searchEngine'] })}>
            {Object.entries(SEARCH_ENGINES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </Row>
        {s.searchEngine === 'custom' && (
          <Row title="Custom search URL" desc="%s is replaced by your query.">
            <LazyInput value={s.customSearchURL ?? ''} placeholder="https://example.com/search?q=%s" onSave={(customSearchURL) => update({ customSearchURL })} width={300} mono />
          </Row>
        )}
        <Row title="Search suggestions" desc="Suggests searches while you type in the address bar. What you type is sent to DuckDuckGo; turn it off to keep it on this Mac.">
          <Switch label="Search suggestions" on={s.searchSuggestions} onChange={(searchSuggestions) => update({ searchSuggestions })} />
        </Row>
      </div>
    </>
  );
}

// ---------- AI providers ----------

function AI({ s }: { s: SettingsT }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderPreset | null>(null);
  return (
    <>
      <div className="s-group">
        <div className="lbl">Defaults</div>
        <Row title="Agent model" desc="Drives the agent panel: reads pages, clicks, types.">
          <select className="field" style={{ width: 240 }} value={s.agentProviderId ?? ''} onChange={(e) => update({ agentProviderId: e.target.value || null })}>
            <option value="">— none —</option>
            {s.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} · {p.model}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Search & tidy model" desc="Writes AI search answers and organizes tabs. A fast, cheap model is ideal.">
          <select className="field" style={{ width: 240 }} value={s.askProviderId ?? ''} onChange={(e) => update({ askProviderId: e.target.value || null })}>
            <option value="">Same as agent</option>
            {s.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} · {p.model}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <div className="s-group">
        <div className="lbl">Providers</div>
        <div className="desc">Keys are encrypted with your system keychain and never leave this Mac except to the provider you pick. Local models (Ollama, LM Studio) need no key.</div>
        {s.providers.map((p) => (
          <ProviderCard key={p.id} p={p} editing={editing === p.id} onEdit={() => setEditing(editing === p.id ? null : p.id)} isAgent={s.agentProviderId === p.id} isAsk={s.askProviderId === p.id} />
        ))}
        {draft && <ProviderCard p={{ ...draft, id: '', hasKey: false }} preset={draft} editing onEdit={() => setDraft(null)} isAgent={false} isAsk={false} />}
        {!s.providers.length && !draft && <div className="desc" style={{ marginTop: 4 }}>No providers yet — pick one below.</div>}
      </div>

      <div className="s-group">
        <div className="lbl">Add a provider</div>
        <div className="presets">
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.preset}
              className="preset"
              onClick={() => {
                setEditing(null);
                setDraft(p);
              }}
            >
              <span className="prov-logo" style={{ background: letterColor(p.label), width: 28, height: 28, fontSize: 12 }}>
                {p.label[0]}
              </span>
              <span>
                <b>{p.label}</b>
                <span>{p.help}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function ProviderCard({ p, preset, editing, onEdit, isAgent, isAsk }: { p: ProviderConfig; preset?: ProviderPreset; editing: boolean; onEdit(): void; isAgent: boolean; isAsk: boolean }) {
  const [f, setF] = useState(() => ({ label: p.label, baseURL: p.baseURL ?? '', model: p.model, vision: p.vision, effort: p.effort ?? 'medium', binary: p.binary ?? '' }));
  const [key, setKey] = useState('');
  const [test, setTest] = useState<QueryMap['providerTest']['result'] | 'busy' | null>(null);
  const [models, setModels] = useState<string[] | 'busy' | null>(null);
  const [saving, setSaving] = useState(false);
  const isNew = !p.id;
  const presetInfo = preset ?? PROVIDER_PRESETS.find((x) => x.kind === p.kind && (x.baseURL ?? '') === (p.baseURL ?? '')) ?? PROVIDER_PRESETS.find((x) => x.kind === p.kind);
  const needsKey = p.kind !== 'claude-code' && (presetInfo?.needsKey ?? p.kind === 'anthropic');

  const save = async () => {
    setSaving(true);
    const id = await cmd({
      type: 'provider.upsert',
      provider: {
        id: p.id || undefined,
        kind: p.kind,
        label: f.label.trim() || p.label,
        baseURL: f.baseURL.trim() || undefined,
        model: f.model.trim(),
        vision: f.vision,
        effort: p.kind === 'anthropic' ? f.effort : undefined,
        binary: p.kind === 'claude-code' ? f.binary.trim() || undefined : undefined,
      },
      apiKey: key ? key : undefined,
    });
    setSaving(false);
    setKey('');
    onEdit();
    if (isNew && typeof id === 'string') {
      setTest('busy');
      query('providerTest', { providerId: id }).then(setTest, (e) => setTest({ ok: false, message: String(e) }));
    }
  };

  return (
    <div className={cx('prov', editing && 'editing')}>
      <div className="prov-head">
        <span className="prov-logo" style={{ background: letterColor(p.label) }}>
          {p.kind === 'claude-code' ? <Bot size={16} /> : p.label[0]}
        </span>
        <div className="meta">
          <b>{isNew ? `New ${p.label}` : p.label}</b>
          <span className="truncate mono" style={{ fontSize: 11.5 }}>
            {p.model}
            {p.baseURL ? ` · ${p.baseURL.replace(/^https?:\/\//, '')}` : ''}
          </span>
        </div>
        {isAgent && <span className="tag accent">Agent</span>}
        {isAsk && <span className="tag accent">Search</span>}
        {!isNew &&
          (p.kind === 'claude-code' ? (
            <span className="tag">Local CLI</span>
          ) : p.hasKey ? (
            <span className="tag ok">
              <KeyRound size={10} /> Key saved
            </span>
          ) : needsKey ? (
            <span className="tag warn">No key</span>
          ) : (
            <span className="tag">Local</span>
          ))}
        {!isNew && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setTest('busy');
              query('providerTest', { providerId: p.id }).then(setTest, (e) => setTest({ ok: false, message: String(e) }));
            }}
          >
            {test === 'busy' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : 'Test'}
          </button>
        )}
        <button className="btn btn-soft btn-sm" onClick={onEdit}>
          {editing ? 'Close' : 'Edit'}
        </button>
      </div>
      {test && test !== 'busy' && !editing && (
        <div className={cx('test-result', test.ok ? 'ok' : 'bad')} style={{ padding: '0 14px 10px 58px' }}>
          {test.ok ? '✓ ' : '✕ '}
          {test.message}
        </div>
      )}
      {editing && (
        <div className="prov-edit">
          <label>
            Name
            <input className="field" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          </label>
          {p.kind !== 'claude-code' ? (
            <label>
              <span>Base URL {p.kind === 'anthropic' && <em className="opt">(optional)</em>}</span>
              <input className="field mono" value={f.baseURL} placeholder={p.kind === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:11434/v1'} onChange={(e) => setF({ ...f, baseURL: e.target.value })} />
            </label>
          ) : (
            <label>
              <span>claude binary <em className="opt">(optional)</em></span>
              <input className="field mono" value={f.binary} placeholder="found on PATH" onChange={(e) => setF({ ...f, binary: e.target.value })} />
            </label>
          )}
          <label className={p.kind === 'anthropic' ? '' : 'full'}>
            Model
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="field mono" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
              {!isNew && (
                <button
                  className="btn btn-soft"
                  style={{ height: 32 }}
                  onClick={() => {
                    setModels('busy');
                    query('providerModels', { providerId: p.id }).then(
                      (m) => setModels(m),
                      () => setModels([]),
                    );
                  }}
                >
                  {models === 'busy' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <RefreshCw size={13} />} List
                </button>
              )}
            </div>
            {Array.isArray(models) && (
              <div className="models">
                {models.length ? (
                  models.slice(0, 40).map((m) => (
                    <button key={m} className={cx(m === f.model && 'on')} onClick={() => setF({ ...f, model: m })}>
                      {m}
                    </button>
                  ))
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--ink-3)', fontWeight: 450 }}>No models returned.</span>
                )}
              </div>
            )}
          </label>
          {p.kind === 'anthropic' && (
            <label>
              Effort
              <select className="field" value={f.effort} onChange={(e) => setF({ ...f, effort: e.target.value as (typeof EFFORTS)[number] })}>
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
          )}
          {p.kind !== 'claude-code' && (
            <label className="full">
              <span>API key {!needsKey && <em className="opt">(usually not needed)</em>}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="field mono" type="password" autoComplete="off" value={key} placeholder={p.hasKey ? '•••••••••••• saved — type to replace' : 'Paste key'} onChange={(e) => setKey(e.target.value)} />
                {p.hasKey && (
                  <button className="btn btn-danger" style={{ height: 32 }} onClick={() => cmd({ type: 'provider.upsert', provider: { ...stripProvider(p) }, apiKey: null })}>
                    Remove key
                  </button>
                )}
              </div>
            </label>
          )}
          <div className="s-row full" style={{ gridColumn: '1 / -1', minHeight: 0, padding: 0, border: 0 }}>
            <div className="k">
              <b style={{ fontSize: 12 }}>Sees screenshots</b>
              <span>Turn on for vision models; the agent then gets page images when text isn’t enough.</span>
            </div>
            <div className="v">
              <Switch label="Vision" on={f.vision} onChange={(vision) => setF({ ...f, vision })} />
            </div>
          </div>
          {presetInfo && <div className="help">{presetInfo.help}</div>}
          <div className="acts">
            <button className="btn btn-primary" disabled={!f.model.trim() || saving} onClick={save}>
              {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Check size={13} />} {isNew ? 'Add provider' : 'Save'}
            </button>
            <button className="btn btn-ghost" onClick={onEdit}>
              Cancel
            </button>
            <span style={{ flex: 1 }} />
            {!isNew && (
              <button className="btn btn-danger" onClick={() => cmd({ type: 'provider.remove', providerId: p.id })}>
                <Trash2 size={13} /> Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function stripProvider(p: ProviderConfig) {
  const { hasKey: _h, ...rest } = p;
  return rest;
}

// ---------- Agents & API ----------

function Agents({ state }: { state: UIState }) {
  const s = state.settings;
  const c = state.control;
  const [secrets, setSecrets] = useState<QueryMap['controlSecrets']['result'] | null>(null);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const load = () => query('controlSecrets', {}).then(setSecrets, () => setSecrets(null));
  useEffect(() => {
    if (c.running) load();
  }, [c.running, c.port]);
  const copy = async (k: string, text: string) => {
    if (await copyText(text)) {
      setCopied(k);
      setTimeout(() => setCopied((x) => (x === k ? null : x)), 1400);
    }
  };
  const clients = [...state.agent.clients].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const snippets: { k: string; title: string; text?: string }[] = [
    { k: 'claude', title: 'Claude Code — run once in a terminal', text: secrets?.claudeCodeCommand },
    { k: 'mcp', title: 'Any MCP client (Claude Desktop, Cursor, Codex, Windsurf…)', text: secrets?.mcpJson },
    { k: 'cli', title: 'Shell agents & scripts — the clickless CLI', text: secrets?.cliExample },
    { k: 'http', title: 'HTTP — local LLMs, Python, n8n, anything', text: secrets?.curlExample },
  ];
  return (
    <>
      <div className="s-group">
        <div className="desc" style={{ fontSize: 13 }}>
          Any agent can drive Clickless — Claude Code, Cursor, Codex, a Python script with a local model. They connect to a local API on this Mac and act in your real, signed-in browser while you watch. Only programs holding the token below can connect.
        </div>
        <div className={cx('status-line', !c.running && 'bad')}>
          <span className="live" />
          {c.running ? (
            <span>
              Control API running at <b className="mono">{c.url}</b> · MCP at <b className="mono">{c.mcpUrl}</b>
            </span>
          ) : (
            <span>{c.error ? `Control API failed: ${c.error}` : 'Control API is off.'}</span>
          )}
        </div>
        <Row title="Allow agents to connect" desc="Local HTTP + MCP server on 127.0.0.1 only.">
          <Switch label="Allow agents" on={s.control.enabled} onChange={(enabled) => update({ control: { enabled } })} />
        </Row>
        <Row title="Port">
          <LazyInput value={String(s.control.port)} width={100} mono onSave={(v) => Number(v) > 0 && update({ control: { port: Number(v) } })} />
        </Row>
        <Row title="Access token" desc={`Also written to ${c.discoveryFile} for the CLI.`}>
          <div className="token" style={{ width: 300 }}>
            <span className="truncate">{secrets ? (reveal ? secrets.token : `${secrets.token.slice(0, 5)}${'•'.repeat(20)}`) : '—'}</span>
            <button className="icon-btn sm" title={reveal ? 'Hide' : 'Reveal'} onClick={() => setReveal((r) => !r)}>
              {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button className="icon-btn sm" title="Copy token" disabled={!secrets} onClick={() => secrets && copy('token', secrets.token)}>
              {copied === 'token' ? <Check size={13} style={{ color: 'var(--ok)' }} /> : <Copy size={13} />}
            </button>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            title="Disconnects every agent using the old token"
            onClick={async () => {
              await cmd({ type: 'control.regenerateToken' });
              load();
            }}
          >
            <RefreshCw size={12} /> New
          </button>
        </Row>
      </div>

      <div className="s-group">
        <div className="lbl">Connect</div>
        {snippets.map((sn) => (
          <div key={sn.k} className="snippet">
            <div className="sh">
              <span>{sn.title}</span>
              <button className="btn btn-ghost btn-sm" disabled={!sn.text} onClick={() => sn.text && copy(sn.k, sn.text)}>
                {copied === sn.k ? (
                  <>
                    <Check size={12} style={{ color: 'var(--ok)' }} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={12} /> Copy
                  </>
                )}
              </button>
            </div>
            <pre>{sn.text ?? (c.running ? 'Loading…' : 'Turn the control API on to get this.')}</pre>
          </div>
        ))}
      </div>

      {clients.length > 0 && (
        <div className="s-group">
          <div className="lbl">Seen recently</div>
          <div className="clients">
            {clients.map((cl) => (
              <span key={cl.name} className={cx('tag', Date.now() - cl.lastSeenAt < 5 * 60_000 && 'ok')}>
                {cl.name} · {cl.calls} calls · {timeAgo(cl.lastSeenAt)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="s-group">
        <div className="lbl">Agent behaviour</div>
        <Row title="Show the agent cursor" desc="Animated pointer and highlights in the page, so you can follow every step.">
          <Switch label="Agent cursor" on={s.agent.showCursor} onChange={(showCursor) => update({ agent: { showCursor } })} />
        </Row>
        <Row title="Cursor speed" desc={s.agent.cursorMs === 0 ? 'Instant' : `${s.agent.cursorMs} ms per move — slower is easier to follow, faster finishes sooner.`}>
          <input type="range" min={0} max={600} step={20} value={s.agent.cursorMs} onChange={(e) => update({ agent: { cursorMs: Number(e.target.value) } })} />
        </Row>
        <Row title="Confirm dialogs the agent triggers" desc="What happens to confirm() and prompt() popups during agent actions.">
          <Seg
            value={s.agent.dialogs}
            onChange={(dialogs) => update({ agent: { dialogs } })}
            options={[
              { v: 'accept', label: 'Accept' },
              { v: 'dismiss', label: 'Dismiss' },
            ]}
          />
        </Row>
        <Row title="Max steps per task" desc="The built-in agent stops after this many tool calls.">
          <LazyInput value={String(s.agent.maxSteps)} width={80} mono onSave={(v) => Number(v) > 0 && update({ agent: { maxSteps: Number(v) } })} />
        </Row>
      </div>

      <div className="s-group">
        <div className="lbl">Advanced</div>
        <Row
          title="Chrome DevTools Protocol port"
          desc="For Playwright, browser-use, Stagehand or Puppeteer (connectOverCDP). Restart required. Any program on this Mac can control the browser through it — no token."
        >
          {s.control.cdpPort !== null && <LazyInput value={String(s.control.cdpPort)} width={90} mono onSave={(v) => Number(v) > 0 && update({ control: { cdpPort: Number(v) } })} />}
          <Switch label="CDP port" on={s.control.cdpPort !== null} onChange={(on) => update({ control: { cdpPort: on ? 9222 : null } })} />
        </Row>
      </div>
    </>
  );
}

// ---------- AI search ----------

function SearchSection({ s }: { s: SettingsT }) {
  return (
    <div className="s-group">
      <div className="desc" style={{ fontSize: 13 }}>
        AI search runs the query in a hidden tab, reads the top results in parallel and writes an answer with sources. No search API key needed.
      </div>
      <Row title="Search with" desc="Where results come from.">
        <select className="field" style={{ width: 200 }} value={s.askBackend} onChange={(e) => update({ askBackend: e.target.value as SettingsT['askBackend'] })}>
          <option value="duckduckgo">DuckDuckGo</option>
          <option value="google">Google</option>
          <option value="bing">Bing</option>
          <option value="brave">Brave Search</option>
          <option value="searxng">SearXNG (self-hosted)</option>
        </select>
      </Row>
      {s.askBackend === 'searxng' && (
        <Row title="SearXNG URL">
          <LazyInput value={s.searxngURL ?? ''} placeholder="http://localhost:8888" onSave={(searxngURL) => update({ searxngURL })} width={260} mono />
        </Row>
      )}
      <Row title="Pages to read" desc={`Reads the top ${s.askReadPages} results before answering. More is thorough, fewer is faster.`}>
        <input type="range" min={1} max={10} value={s.askReadPages} onChange={(e) => update({ askReadPages: Number(e.target.value) })} />
        <span className="mono" style={{ width: 18, textAlign: 'right' }}>
          {s.askReadPages}
        </span>
      </Row>
    </div>
  );
}

// ---------- Tabs ----------

function Tabs({ s }: { s: SettingsT }) {
  return (
    <div className="s-group">
      <Row title="Archive Today tabs after" desc="Unpinned tabs you haven’t touched move to the archive (find them again in ⌘T). Pinned tabs and favourites stay.">
        <select className="field" style={{ width: 160 }} value={s.tabs.archiveAfterHours} onChange={(e) => update({ tabs: { archiveAfterHours: Number(e.target.value) } })}>
          <option value={0}>Never</option>
          <option value={6}>6 hours</option>
          <option value={12}>12 hours</option>
          <option value={24}>24 hours</option>
          <option value={168}>7 days</option>
          <option value={720}>30 days</option>
        </select>
      </Row>
      <Row title="Put background tabs to sleep after" desc="Frees memory; the tab reloads when you open it.">
        <select className="field" style={{ width: 160 }} value={s.tabs.sleepAfterMinutes} onChange={(e) => update({ tabs: { sleepAfterMinutes: Number(e.target.value) } })}>
          <option value={0}>Never</option>
          <option value={15}>15 minutes</option>
          <option value={30}>30 minutes</option>
          <option value={60}>1 hour</option>
          <option value={240}>4 hours</option>
        </select>
      </Row>
      <ImportRow />
    </div>
  );
}

function ImportRow() {
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    query('importSources', {}).then(setSources, () => setSources([]));
  }, []);
  const found = sources.filter((x) => x.available);
  const run = async (src: ImportSource) => {
    setBusy(src.id);
    setResult(null);
    try {
      const r = (await window.clickless.cmd({ type: 'import.run', source: src.id })) as ImportReport;
      const parts = r.spaces.map((x) => `${x.name}${x.created ? ' (new)' : ''}: ${x.tabs} tabs, ${x.folders} folders`);
      if (r.favorites) parts.push(`${r.favorites} favorites`);
      if (r.skipped) parts.push(`${r.skipped} already here`);
      setResult(`${r.source} → ${parts.join(' · ')}`);
    } catch (err) {
      setResult(`${src.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Row
      title="Import from another browser"
      desc={
        result ??
        'Spaces, pinned tabs, folders, favourites, bookmarks and open tabs. Run it again any time; tabs you already have are skipped. Passwords and logins stay where they are.'
      }
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {found.length === 0 && <span className="mono">No other browsers found</span>}
        {found.map((x) => (
          <button key={x.id} className="btn btn-soft btn-sm" disabled={!!busy} onClick={() => run(x)}>
            {busy === x.id ? 'Importing…' : x.name}
          </button>
        ))}
      </div>
    </Row>
  );
}

// ---------- Backup ----------

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function Backup({ s, status }: { s: SettingsT; status: UIState['backup'] }) {
  const b = s.backup;
  const kind = b.target?.kind ?? 'off';
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pass, setPass] = useState('');
  const [editPass, setEditPass] = useState(false);
  const [repo, setRepo] = useState(b.target?.kind === 'github' ? b.target.repo : '');
  const [token, setToken] = useState('');
  const [githubOpen, setGithubOpen] = useState(false);
  const [restore, setRestore] = useState<null | 'file' | 'target'>(null);
  const [restorePass, setRestorePass] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setRepo(b.target?.kind === 'github' ? b.target.repo : ''), [b.target]);
  const call = async (c: Command, ok?: (r: any) => string) => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await window.clickless.cmd(c);
      if (ok) setMsg({ ok: true, text: ok(r) });
      return r;
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const chooseFolder = async () => {
    const folder = (await call({ type: 'backup.chooseFolder' })) as string | null | undefined;
    if (folder) await call({ type: 'backup.configure', target: { kind: 'folder', folder } }, () => 'Backups will go to that folder.');
  };
  const showGithub = kind === 'github' || githubOpen;
  const where = b.target?.kind === 'folder' ? b.target.folder.split('/').pop() : b.target?.kind === 'github' ? b.target.repo : '';
  return (
    <>
      <div className="s-group">
        <div className="lbl">Encrypted backups</div>
        <div className="desc">
          Off unless you turn it on: your tabs and settings stay on this Mac. When it’s on, Clickless encrypts the backup here with your passphrase before it’s written anywhere, so the folder or repository only ever holds scrambled data.
        </div>
        <Row title="Passphrase" desc={`At least 10 characters. Keep it somewhere safe: without it nobody, you included, can open a backup.`}>
          {status.hasPassphrase && !editPass ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="mono">
                <Check size={13} /> Set
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditPass(true)}>
                Change
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="field" type="password" style={{ width: 200 }} value={pass} placeholder="New passphrase" autoComplete="new-password" onChange={(e) => setPass(e.target.value)} />
              <button
                className="btn btn-soft btn-sm"
                disabled={pass.length < 10 || busy}
                onClick={async () => {
                  const r = await call({ type: 'backup.configure', passphrase: pass }, () => 'Passphrase saved in your keychain.');
                  if (r) {
                    setPass('');
                    setEditPass(false);
                  }
                }}
              >
                Save
              </button>
            </div>
          )}
        </Row>
        <Row title="Back up to" desc="A folder (iCloud Drive, Google Drive, Dropbox, OneDrive’s Personal Vault, a Cryptomator vault, a USB drive) or a private GitHub repository.">
          <Seg
            value={showGithub ? 'github' : kind}
            onChange={(v) => {
              setMsg(null);
              if (v === 'off') {
                setGithubOpen(false);
                call({ type: 'backup.configure', target: null }, () => 'Backups are off.');
              } else if (v === 'folder') {
                setGithubOpen(false);
                chooseFolder();
              } else setGithubOpen(true);
            }}
            options={[
              { v: 'off', label: 'Off' },
              { v: 'folder', label: 'Folder' },
              { v: 'github', label: 'Private GitHub repo' },
            ]}
          />
        </Row>
        {kind === 'folder' && !githubOpen && b.target?.kind === 'folder' && (
          <Row title="Folder" desc={`Keeps the newest ${b.keep} backups there.`}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="mono" title={b.target.folder} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl' }}>
                {b.target.folder}
              </span>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={chooseFolder}>
                Change…
              </button>
            </div>
          </Row>
        )}
        {showGithub && (
          <>
            <Row title="Repository" desc="Create a private repository for it first. Public repositories are refused.">
              <input className="field mono" style={{ width: 260 }} value={repo} placeholder="you/clickless-backup" onChange={(e) => setRepo(e.target.value)} />
            </Row>
            <Row
              title="Access token"
              desc={
                <>
                  A fine-grained token for that one repository with <b>Contents: read and write</b>, from GitHub → Settings → Developer settings → Fine-grained tokens. Kept in your keychain.
                </>
              }
            >
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="field mono" type="password" style={{ width: 200 }} value={token} placeholder={status.hasGithubToken ? 'Saved' : 'github_pat_…'} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
                <button
                  className="btn btn-soft btn-sm"
                  disabled={!repo || (!token && !status.hasGithubToken) || busy}
                  onClick={async () => {
                    const r = await call({ type: 'backup.configure', target: { kind: 'github', repo }, githubToken: token || undefined }, () => `Connected: ${repo} is private and writable.`);
                    if (r) {
                      setToken('');
                      setGithubOpen(false);
                    }
                  }}
                >
                  Save & check
                </button>
              </div>
            </Row>
          </>
        )}
        <Row title="Automatically" desc="Runs in the background while Clickless is open.">
          <select className="field" style={{ width: 160 }} value={b.schedule} disabled={!b.target} onChange={(e) => call({ type: 'backup.configure', schedule: e.target.value as SettingsT['backup']['schedule'] })}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="manual">Only when I ask</option>
          </select>
        </Row>
        <Row
          title="Last backup"
          desc={
            b.lastError ? (
              <span style={{ color: 'var(--danger)' }}>{b.lastError}</span>
            ) : b.lastAt ? (
              `${timeAgo(b.lastAt)}${b.lastWhere ? ` · ${b.lastWhere.split('/').pop()}` : ''}`
            ) : (
              'None yet.'
            )
          }
        >
          <button
            className="btn btn-primary btn-sm"
            disabled={!b.target || !status.hasPassphrase || status.running || busy}
            onClick={() => call({ type: 'backup.run' }, (r) => `Encrypted backup saved (${Math.max(1, Math.round((r?.bytes ?? 0) / 1024))} KB).`)}
          >
            {status.running ? 'Backing up…' : 'Back up now'}
          </button>
        </Row>
        <Row title="Restore" desc="Bring a backup onto this Mac, for example after setting up a new one.">
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRestore('file')}>
              From a file…
            </button>
            {b.target && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRestore('target')}>
                Latest from {where}
              </button>
            )}
          </div>
        </Row>
        {restore && (
          <div className="s-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
            <div className="k">
              <b>Replace this Mac’s spaces, tabs and settings with the backup?</b>
              <span>Your current ones are kept as a safety copy (state.before-restore.json in the app’s data folder). Clickless restarts when it’s done.</span>
            </div>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <input
                className="field"
                type="password"
                style={{ width: 220 }}
                value={restorePass}
                placeholder={status.hasPassphrase ? 'Passphrase (if different)' : 'Passphrase of the backup'}
                onChange={(e) => setRestorePass(e.target.value)}
              />
              <button className="btn btn-ghost btn-sm" onClick={() => setRestore(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={busy || (!status.hasPassphrase && restorePass.length < 10)}
                onClick={() => call({ type: 'backup.restore', from: restore, passphrase: restorePass || undefined })}
              >
                Restore
              </button>
            </div>
          </div>
        )}
        {msg && (
          <div className="desc" style={{ color: msg.ok ? undefined : 'var(--danger)' }}>
            {msg.text}
          </div>
        )}
        <div className="desc">Included: spaces, tabs, folders, favourites, archive, history and settings. Never included: passwords, logins, cookies or API keys.</div>
      </div>
    </>
  );
}
