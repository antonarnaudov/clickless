import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Cookie, Copy, Download, Eye, EyeOff, FolderOpen, Globe, History, KeyRound, Laptop, LayoutGrid, Lock, Moon, Palette, Pencil, Plug, Plus, RefreshCw, Search, Shield, ShieldCheck, Sparkles, Sun, Trash2, Users, X, type LucideIcon } from 'lucide-react';
import type { Command, DeepPartial, QueryMap } from '../../shared/ipc';
import { PROVIDER_PRESETS, SEARCH_ENGINES, SPACE_COLORS, type ProviderPreset } from '../../shared/settings';
import type { ImportReport, ImportSource, OverlayState, ProviderConfig, Settings as SettingsT, UIState } from '../../shared/types';
import { cmd, query } from '../common/api';
import { BrandIcon, PROVIDER_BRAND, providerBrand } from '../common/BrandIcon';
import { Favicon } from '../common/Favicon';
import { agentClient } from '../../shared/agents';
import { copyText, cx, debounce, timeAgo } from '../common/util';

type Section = NonNullable<Extract<OverlayState, { kind: 'settings' }>['section']>;

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: LayoutGrid },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'tabs', label: 'Tabs', icon: Laptop },
  { id: 'profiles', label: 'Profiles', icon: Users },
  { id: 'passwords', label: 'Passwords', icon: KeyRound },
  { id: 'privacy', label: 'Privacy & data', icon: Lock },
  { id: 'ai', label: 'AI models', icon: Sparkles },
  { id: 'agents', label: 'Agents & API', icon: Plug },
  { id: 'search', label: 'AI search', icon: Search },
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
          Clickless 0.2 · open source
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
          {section === 'general' && <General s={s} state={state} />}
          {section === 'appearance' && <Appearance s={s} state={state} />}
          {section === 'profiles' && <Profiles state={state} />}
          {section === 'passwords' && <Passwords s={s} />}
          {section === 'privacy' && <Privacy s={s} />}
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

function General({ s, state }: { s: SettingsT; state: UIState }) {
  return (
    <>
      <div className="s-group">
        <div className="lbl">Browser</div>
        <Row title="Default browser" desc={state.isDefaultBrowser ? 'Links you open in other apps open in Clickless.' : 'Links from other apps open in another browser.'}>
          {state.isDefaultBrowser ? (
            <span className="tag ok">
              <Check size={12} /> Default
            </span>
          ) : (
            <button className="btn btn-soft btn-sm" onClick={() => cmd({ type: 'app.makeDefaultBrowser' })}>
              Make Clickless the default
            </button>
          )}
        </Row>
        <Row title="On start" desc="Your pinned tabs, folders and favourites are always kept.">
          <Seg
            value={s.startup}
            onChange={(startup) => update({ startup })}
            options={[
              { v: 'restore', label: 'Continue where I left off' },
              { v: 'newtab', label: 'Open a new tab' },
            ]}
          />
        </Row>
        <Row title="Check spelling while typing">
          <Switch label="Spellcheck" on={s.spellcheck} onChange={(spellcheck) => update({ spellcheck })} />
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
      </div>
      <div className="s-group">
        <div className="lbl">Downloads</div>
        <Row title="Save files to" desc={s.downloads.folder ?? 'Downloads'}>
          <button className="btn btn-ghost btn-sm" onClick={() => cmd({ type: 'downloads.chooseFolder' })}>
            <FolderOpen size={13} /> Change…
          </button>
          {s.downloads.folder && (
            <button className="btn btn-ghost btn-sm" onClick={() => update({ downloads: { folder: null } })}>
              Use Downloads
            </button>
          )}
        </Row>
        <Row title="Ask where to save each file">
          <Switch label="Ask where to save" on={s.downloads.ask} onChange={(ask) => update({ downloads: { ask } })} />
        </Row>
      </div>
    </>
  );
}

// ---------- Appearance ----------

function Appearance({ s, state }: { s: SettingsT; state: UIState }) {
  const a = s.appearance;
  return (
    <>
      <div className="s-group">
        <div className="lbl">Theme</div>
        <Row title="Mode" desc="Follows macOS unless you pick one.">
          <Seg
            value={a.theme}
            onChange={(theme) => update({ appearance: { theme } })}
            options={[
              { v: 'system', label: 'Auto', icon: Laptop },
              { v: 'light', label: 'Light', icon: Sun },
              { v: 'dark', label: 'Dark', icon: Moon },
            ]}
          />
        </Row>
        <Row title="Colour strength" desc="How much the space colour tints the window.">
          <Seg
            value={a.tint}
            onChange={(tint) => update({ appearance: { tint } })}
            options={[
              { v: 'subtle', label: 'Subtle' },
              { v: 'standard', label: 'Standard' },
              { v: 'vivid', label: 'Vivid' },
            ]}
          />
        </Row>
      </div>
      <div className="s-group">
        <div className="lbl">Space colours</div>
        <div className="desc">Each space tints the window with its own colour. Double-click a space’s name in the sidebar to change its icon.</div>
        {state.spaces.map((sp) => (
          <Row key={sp.id} title={`${sp.icon}  ${sp.name}`}>
            <div className="swatches">
              {SPACE_COLORS.map((c) => (
                <button key={c} className={cx('swatch', sp.color.toLowerCase() === c.toLowerCase() && 'on')} style={{ background: c }} title={c} onClick={() => cmd({ type: 'space.update', spaceId: sp.id, patch: { color: c } })} />
              ))}
              <label className="swatch custom" title="Pick any colour" style={{ background: SPACE_COLORS.includes(sp.color) ? undefined : sp.color }}>
                <input type="color" value={sp.color} onChange={(e) => cmd({ type: 'space.update', spaceId: sp.id, patch: { color: e.target.value } })} />
              </label>
            </div>
          </Row>
        ))}
      </div>
      <div className="s-group">
        <div className="lbl">Layout</div>
        <Row title="Address above the page" desc="Show the address and back/forward above the page instead of in the sidebar.">
          <Switch label="Address above the page" on={a.compactUrl} onChange={(compactUrl) => update({ appearance: { compactUrl } })} />
        </Row>
        <Row title="Sidebar size">
          <Seg
            value={a.sidebarSize}
            onChange={(sidebarSize) => update({ appearance: { sidebarSize } })}
            options={[
              { v: 'compact', label: 'Compact' },
              { v: 'standard', label: 'Standard' },
              { v: 'large', label: 'Large' },
            ]}
          />
        </Row>
        <Row title="Page zoom" desc="For pages you haven’t zoomed yourself (⌘+ / ⌘−). Applies to tabs as they open.">
          <select className="field" style={{ width: 120 }} value={a.pageZoom} onChange={(e) => update({ appearance: { pageZoom: Number(e.target.value) } })}>
            {[75, 80, 90, 100, 110, 125, 150].map((z) => (
              <option key={z} value={z}>
                {z}%
              </option>
            ))}
          </select>
        </Row>
      </div>
    </>
  );
}

// ---------- Profiles ----------

function Profiles({ state }: { state: UIState }) {
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const profiles = state.profiles.length ? state.profiles : [{ id: 'default', name: 'Personal', color: '#5f7f75' }];
  const spacesOf = (id: string) => state.spaces.filter((sp) => (sp.profileId ?? 'default') === id);
  return (
    <>
      <div className="s-group">
        <div className="lbl">Your profiles</div>
        <div className="desc">A profile keeps its own cookies, logins and site data. Give a space its own profile to be signed in to different accounts in each space (say, work and personal).</div>
        {profiles.map((p) => (
          <div key={p.id} className="s-row">
            <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="pdot" style={{ background: p.color }} />
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <LazyInput value={p.name} width={180} onSave={(v) => v.trim() && cmd({ type: 'profile.update', profileId: p.id, name: v })} />
                <span>{spacesOf(p.id).map((sp) => `${sp.icon} ${sp.name}`).join(' · ') || 'No spaces use it yet'}</span>
              </span>
            </div>
            <div className="v">
              {p.id === 'default' ? (
                <span className="tag">Default</span>
              ) : deleting === p.id ? (
                <button className="btn btn-danger btn-sm" onClick={() => (setDeleting(null), cmd({ type: 'profile.delete', profileId: p.id }))}>
                  Delete it and its logins?
                </button>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => setDeleting(p.id)}>
                  <Trash2 size={13} /> Delete
                </button>
              )}
            </div>
          </div>
        ))}
        <Row title="New profile">
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="field" style={{ width: 180 }} value={name} placeholder="e.g. Work" onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-soft btn-sm" disabled={!name.trim()} onClick={() => (cmd({ type: 'profile.create', name }), setName(''))}>
              <Plus size={13} /> Add
            </button>
          </div>
        </Row>
      </div>
      <div className="s-group">
        <div className="lbl">Which profile each space uses</div>
        {state.spaces.map((sp) => (
          <Row key={sp.id} title={`${sp.icon}  ${sp.name}`}>
            <select className="field" style={{ width: 200 }} value={sp.profileId ?? 'default'} onChange={(e) => cmd({ type: 'space.profile', spaceId: sp.id, profileId: e.target.value === 'default' ? null : e.target.value })}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Row>
        ))}
        <div className="desc">Favourites always use the default profile. Open pages reload when their space changes profile.</div>
      </div>
      <AgentProfilesGroup state={state} />
    </>
  );
}

// ---------- Passwords ----------

function Passwords({ s }: { s: SettingsT }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<QueryMap['passwords']['result']>([]);
  const [never, setNever] = useState<string[]>([]);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState({ origin: '', username: '', password: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => {
    query('passwords', { query: q }).then(setList, () => setList([]));
    query('passwordsNever', {}).then(setNever, () => setNever([]));
  };
  useEffect(load, [q]);
  const run = async (c: Command, ok?: (r: any) => string | null) => {
    setMsg(null);
    try {
      const r = await window.clickless.cmd(c);
      const t = ok?.(r);
      if (t) setMsg({ ok: true, text: t });
      load();
      return r;
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
      return undefined;
    }
  };
  const host = (o: string) => o.replace(/^https?:\/\//, '');
  const startEdit = (id: string | 'new', l?: { origin: string; username: string }) => {
    setEditing(id);
    setForm({ origin: l?.origin ?? '', username: l?.username ?? '', password: '' });
  };
  return (
    <>
      <div className="s-group">
        <div className="desc">Kept on this Mac only, each one encrypted with your keychain. Agents never see them, and their own browsers have none. Showing or exporting a password asks for Touch ID (or your confirmation).</div>
        <Row title="Offer to save passwords" desc="After you sign in to a site.">
          <Switch label="Offer to save" on={s.passwords.offer} onChange={(offer) => update({ passwords: { offer } })} />
        </Row>
        <Row title="Offer saved logins in sign-in forms" desc="Pick one from the list under the field; nothing is filled without you.">
          <Switch label="Autofill" on={s.passwords.autofill} onChange={(autofill) => update({ passwords: { autofill } })} />
        </Row>
      </div>
      <div className="s-group">
        <div className="lbl">Saved passwords · {list.length}</div>
        <div style={{ display: 'flex', gap: 6, margin: '6px 0 8px' }}>
          <input className="field" style={{ flex: 1 }} value={q} placeholder="Search sites and usernames" onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-soft btn-sm" onClick={() => startEdit('new')}>
            <Plus size={13} /> Add
          </button>
          <button className="btn btn-ghost btn-sm" title="From a CSV exported by Chrome, Comet, Arc, Edge, Safari or Firefox" onClick={() => run({ type: 'passwords.import' }, (r) => (r ? `Imported ${r.added} new, updated ${r.updated}, skipped ${r.skipped}. You can delete ${r.file.split('/').pop()} now.` : null))}>
            Import…
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => run({ type: 'passwords.export' }, (r) => (r ? `Exported to ${r}. It isn’t encrypted: delete it when you’re done.` : null))}>
            Export…
          </button>
        </div>
        {editing === 'new' && <PasswordForm form={form} setForm={setForm} onCancel={() => setEditing(null)} onSave={() => run({ type: 'passwords.upsert', ...form }, () => 'Saved.').then((r) => r && setEditing(null))} />}
        {list.map((l) => (
          <div key={l.id} className="pw-row">
            <Favicon url={l.origin} title={host(l.origin)} />
            <span className="site truncate" title={l.origin}>
              {host(l.origin)}
            </span>
            <span className="user truncate">{l.username || '—'}</span>
            <span className="secret mono">{shown[l.id] ?? '••••••••'}</span>
            <span className="acts">
              <button
                className="icon-btn sm"
                title={shown[l.id] ? 'Hide' : 'Show password'}
                onClick={async () => {
                  if (shown[l.id]) return setShown(({ [l.id]: _x, ...rest }) => rest);
                  const pw = (await window.clickless.cmd({ type: 'passwords.reveal', id: l.id }).catch(() => null)) as string | null;
                  if (pw !== null) setShown((x) => ({ ...x, [l.id]: pw }));
                }}
              >
                {shown[l.id] ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button
                className="icon-btn sm"
                title="Copy password"
                onClick={async () => {
                  const pw = shown[l.id] ?? ((await window.clickless.cmd({ type: 'passwords.reveal', id: l.id }).catch(() => null)) as string | null);
                  if (pw !== null && (await copyText(pw))) setMsg({ ok: true, text: `Copied the password for ${host(l.origin)}.` });
                }}
              >
                <Copy size={13} />
              </button>
              <button className="icon-btn sm" title="Edit" onClick={() => startEdit(l.id, l)}>
                <Pencil size={13} />
              </button>
              <button className="icon-btn sm" title="Delete" onClick={() => run({ type: 'passwords.remove', id: l.id })}>
                <Trash2 size={13} />
              </button>
            </span>
            {editing === l.id && (
              <div style={{ gridColumn: '1 / -1' }}>
                <PasswordForm form={form} setForm={setForm} editingExisting onCancel={() => setEditing(null)} onSave={() => run({ type: 'passwords.upsert', id: l.id, origin: form.origin, username: form.username, password: form.password || undefined }, () => 'Saved.').then((r) => r && setEditing(null))} />
              </div>
            )}
          </div>
        ))}
        {!list.length && <div className="desc">{q ? 'No saved passwords match.' : 'No saved passwords yet. Sign in to a site and Clickless offers to save it, or import them from another browser.'}</div>}
        {msg && <div className="desc" style={{ color: msg.ok ? undefined : 'var(--danger)' }}>{msg.text}</div>}
      </div>
      {never.length > 0 && (
        <div className="s-group">
          <div className="lbl">Never saved for</div>
          {never.map((o) => (
            <Row key={o} title={host(o)}>
              <button className="btn btn-ghost btn-sm" onClick={() => run({ type: 'passwords.never', origin: o, never: false })}>
                Remove
              </button>
            </Row>
          ))}
        </div>
      )}
    </>
  );
}

function PasswordForm({ form, setForm, onSave, onCancel, editingExisting }: { form: { origin: string; username: string; password: string }; setForm(f: { origin: string; username: string; password: string }): void; onSave(): void; onCancel(): void; editingExisting?: boolean }) {
  return (
    <div className="pw-form">
      <input className="field" placeholder="https://example.com" value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })} />
      <input className="field" placeholder="Username or email" value={form.username} autoComplete="off" onChange={(e) => setForm({ ...form, username: e.target.value })} />
      <input className="field" type="password" placeholder={editingExisting ? 'New password (leave empty to keep)' : 'Password'} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      <button className="btn btn-ghost btn-sm" onClick={onCancel}>
        Cancel
      </button>
      <button className="btn btn-primary btn-sm" disabled={!form.origin || (!editingExisting && !form.password)} onClick={onSave}>
        Save
      </button>
    </div>
  );
}

// ---------- Privacy & data ----------

function Privacy({ s }: { s: SettingsT }) {
  const [sites, setSites] = useState<QueryMap['siteData']['result'] | null>(null);
  const [siteQ, setSiteQ] = useState('');
  const [perms, setPerms] = useState<QueryMap['permissions']['result']>([]);
  const [searches, setSearches] = useState<QueryMap['searchHistory']['result']>([]);
  const [what, setWhat] = useState({ history: true, searches: true, cookies: false, cache: true, downloads: false, permissions: false });
  const [range, setRange] = useState(3_600_000);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const load = () => {
    query('siteData', {}).then(setSites, () => setSites([]));
    query('permissions', {}).then(setPerms, () => setPerms([]));
    query('searchHistory', { limit: 12 }).then(setSearches, () => setSearches([]));
  };
  useEffect(load, []);
  const shownSites = (sites ?? []).filter((x) => !siteQ || x.domain.includes(siteQ.toLowerCase()));
  const label: Record<string, string> = { media: 'Camera / microphone', geolocation: 'Location', notifications: 'Notifications', 'clipboard-read': 'Clipboard', 'display-capture': 'Screen sharing', midi: 'MIDI', hid: 'HID devices', serial: 'Serial ports', usb: 'USB devices', 'storage-access': 'Cookies across sites', 'idle-detection': 'Idle detection' };
  return (
    <>
      <div className="s-group">
        <div className="lbl">Privacy</div>
        <Row title="Ask sites not to sell or share your data" desc="Sends Global Privacy Control (and Do Not Track) with every request.">
          <Switch label="Global Privacy Control" on={s.privacy.gpc} onChange={(gpc) => update({ privacy: { gpc } })} />
        </Row>
        <Row title="Search suggestions" desc="Suggests searches while you type in the address bar. What you type is sent to DuckDuckGo; turn it off to keep it on this Mac.">
          <Switch label="Search suggestions" on={s.searchSuggestions} onChange={(searchSuggestions) => update({ searchSuggestions })} />
        </Row>
      </div>

      <div className="s-group">
        <div className="lbl">History</div>
        <Row title="Browsing history" desc="Every site you’ve visited, by day; search it or remove single entries.">
          <button className="btn btn-ghost btn-sm" onClick={() => cmd({ type: 'ui.history' }).then(() => cmd({ type: 'ui.overlay', overlay: null }))}>
            <History size={13} /> Open History
          </button>
        </Row>
        <Row title="Search history" desc={searches.length ? searches.slice(0, 5).map((x) => `“${x.query}”`).join(' · ') : 'No searches yet.'}>
          <button className="btn btn-ghost btn-sm" disabled={!searches.length} onClick={() => cmd({ type: 'data.clear', searches: true }).then(load)}>
            Clear searches
          </button>
        </Row>
      </div>

      <div className="s-group">
        <div className="lbl">Clear browsing data</div>
        <div className="clear-grid">
          {(
            [
              ['history', 'History'],
              ['searches', 'Search history'],
              ['cookies', 'Cookies and site data (signs you out)'],
              ['cache', 'Cached images and files'],
              ['downloads', 'Download list'],
              ['permissions', 'Site permissions'],
            ] as const
          ).map(([k, l]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={what[k]} onChange={(e) => setWhat({ ...what, [k]: e.target.checked })} /> {l}
            </label>
          ))}
        </div>
        <Row title="History from" desc="Cookies, site data and cache are always cleared completely.">
          <select className="field" style={{ width: 160 }} value={range} onChange={(e) => setRange(Number(e.target.value))}>
            <option value={3_600_000}>The last hour</option>
            <option value={86_400_000}>The last 24 hours</option>
            <option value={7 * 86_400_000}>The last 7 days</option>
            <option value={28 * 86_400_000}>The last 4 weeks</option>
            <option value={0}>All time</option>
          </select>
          {confirm ? (
            <button
              className="btn btn-danger btn-sm"
              onClick={async () => {
                setConfirm(false);
                await cmd({ type: 'data.clear', ...what, since: range ? Date.now() - range : undefined });
                setDone('Cleared.');
                load();
              }}
            >
              Clear now?
            </button>
          ) : (
            <button className="btn btn-soft btn-sm" disabled={!Object.values(what).some(Boolean)} onClick={() => (setDone(null), setConfirm(true))}>
              Clear…
            </button>
          )}
        </Row>
        {done && <div className="desc">{done}</div>}
      </div>

      <div className="s-group">
        <div className="lbl">Cookies and site data · {sites?.length ?? '…'} sites</div>
        <input className="field" style={{ width: '100%', margin: '4px 0 6px' }} value={siteQ} placeholder="Search sites" onChange={(e) => setSiteQ(e.target.value)} />
        <div className="site-list scroll">
          {shownSites.slice(0, 200).map((x) => (
            <div key={x.domain} className="site-row">
              <Favicon url={`https://${x.domain}`} title={x.domain} />
              <span className="truncate">{x.domain}</span>
              <span className="muted">{x.cookies} cookie{x.cookies === 1 ? '' : 's'}</span>
              <button className="icon-btn sm" title={`Remove ${x.domain}'s cookies and data (signs you out there)`} onClick={() => cmd({ type: 'siteData.remove', domain: x.domain }).then(load)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {sites && !shownSites.length && <div className="desc">No sites{siteQ ? ' match' : ' have stored data'}.</div>}
        </div>
      </div>

      <div className="s-group">
        <div className="lbl">Site permissions</div>
        {perms.map((p) => (
          <Row key={`${p.origin} ${p.permission}`} title={p.origin.replace(/^https?:\/\//, '')} desc={`${label[p.permission] ?? p.permission}: ${p.value === 'allow' ? 'allowed' : 'blocked'}`}>
            <button className="btn btn-ghost btn-sm" onClick={() => cmd({ type: 'permissions.reset', origin: p.origin, permission: p.permission }).then(load)}>
              Reset
            </button>
          </Row>
        ))}
        {!perms.length && <div className="desc">No site has asked for anything yet. When one asks (camera, location, notifications…), your answer shows up here.</div>}
      </div>
    </>
  );
}

// ---------- Tabs: duplicates ----------

function Duplicates() {
  const [groups, setGroups] = useState<QueryMap['duplicates']['result'] | null>(null);
  const load = () => query('duplicates', {}).then(setGroups, () => setGroups([]));
  useEffect(() => {
    load();
  }, []);
  const extra = (groups ?? []).reduce((n, g) => n + g.tabs.length - 1, 0);
  const remove = async (ids: string[]) => {
    for (const id of ids) await cmd({ type: 'tab.delete', tabId: id });
    load();
  };
  return (
    <div className="s-group">
      <div className="lbl">Duplicate tabs · {groups ? `${extra} extra cop${extra === 1 ? 'y' : 'ies'}` : '…'}</div>
      <div className="desc">The same page open or saved in more than one place. The first one listed is kept; removed copies can be brought back with ⇧⌘T.</div>
      {(groups ?? []).slice(0, 60).map((g) => (
        <div key={g.url} className="dup-row">
          <Favicon url={g.url} title={g.title} />
          <span className="truncate" title={g.url}>
            <b>{g.title || g.url}</b>
            <span className="muted"> · {g.tabs.map((t) => t.where).join('  ·  ')}</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => remove(g.tabs.slice(1).map((t) => t.id))}>
            Keep one
          </button>
        </div>
      ))}
      {groups && groups.length > 1 && (
        <Row title={`Remove all ${extra} extra copies`}>
          <button className="btn btn-danger btn-sm" onClick={() => remove(groups.flatMap((g) => g.tabs.slice(1).map((t) => t.id)))}>
            Keep one of each
          </button>
        </Row>
      )}
      {groups && !groups.length && <div className="desc">No duplicates.</div>}
    </div>
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
        {[
          { title: 'On this Mac', desc: 'Free and private: nothing leaves your Mac (Claude Code uses your own Claude login).', keys: ['claude-code', 'ollama', 'lmstudio'] },
          { title: 'Cloud', desc: 'Bring your own API key.', keys: PROVIDER_PRESETS.map((p) => p.preset).filter((k) => !['claude-code', 'ollama', 'lmstudio'].includes(k)) },
        ].map((g) => (
          <div key={g.title} className="preset-group">
            <div className="pg-head">
              <b>{g.title}</b>
              <span>{g.desc}</span>
            </div>
            <div className="presets">
              {g.keys
                .map((k) => PROVIDER_PRESETS.find((p) => p.preset === k))
                .filter((p): p is ProviderPreset => !!p)
                .map((p) => (
                  <button
                    key={p.preset}
                    className="preset"
                    onClick={() => {
                      setEditing(null);
                      setDraft(p);
                    }}
                  >
                    <BrandIcon name={PROVIDER_BRAND[p.preset] ?? 'custom'} />
                    <span>
                      <b>{p.label}</b>
                      <span>{p.help}</span>
                    </span>
                  </button>
                ))}
            </div>
          </div>
        ))}
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
        <BrandIcon name={preset ? (PROVIDER_BRAND[preset.preset] ?? 'custom') : providerBrand(p)} size={18} tile={32} />
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
  const live = new Set(clients.filter((cl) => Date.now() - cl.lastSeenAt < 30 * 60_000).map((cl) => agentClient(cl.name).id));
  const snippets = secrets ? agentSnippets(secrets) : [];
  const [pick, setPick] = useState('claude-code');
  const sel = snippets.find((x) => x.id === pick) ?? snippets[0];
  return (
    <>
      <div className="s-group">
        <div className="desc" style={{ fontSize: 13 }}>
          Any agent can drive Clickless — Claude Code, Codex, Gemini CLI, Cursor, a Python script with a local model. Agents that connect over MCP get their own browser profile and window, so your tabs and logins stay yours; your own scripts use your browser. Everything stays on this Mac, and only programs holding the token below can connect.
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
      </div>

      <div className="s-group">
        <div className="lbl">Connect an agent</div>
        <div className="desc">Pick yours: the setup below has this Mac's address and token filled in.</div>
        <div className="agent-tiles">
          {AGENT_TILES.map((t) => (
            <button key={t.id} className={cx('agent-tile', pick === t.id && 'on')} onClick={() => setPick(t.id)} title={t.name}>
              <BrandIcon name={t.brand} size={20} tile={36} />
              <span className="truncate">{t.name}</span>
              {live.has(t.id as any) && <span className="live-dot" title="Connected recently" />}
            </button>
          ))}
        </div>
        {sel ? (
          <div className="snippet">
            <div className="sh">
              <span>
                <b>{sel.name}</b> · {sel.where}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => copy(sel.id, sel.text)}>
                {copied === sel.id ? (
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
            <pre>{sel.text}</pre>
            {sel.note && <div className="snippet-note">{sel.note}</div>}
          </div>
        ) : (
          <div className="snippet">
            <pre>{c.running ? 'Loading…' : 'Turn the control API on to get this.'}</pre>
          </div>
        )}
      </div>

      {clients.length > 0 && (
        <div className="s-group">
          <div className="lbl">Connected agents</div>
          <div className="client-list">
            {clients.map((cl) => {
              const k = agentClient(cl.name);
              const on = Date.now() - cl.lastSeenAt < 5 * 60_000;
              return (
                <div key={cl.name} className="client-row">
                  <BrandIcon name={k.brand ?? k.id} size={16} tile={28} />
                  <b>{k.id === 'mcp' ? cl.name : k.name}</b>
                  <span className="mono truncate">{k.id === 'mcp' || k.name === cl.name ? '' : cl.name}</span>
                  <span className="when">
                    {cl.calls} calls · {timeAgo(cl.lastSeenAt)}
                  </span>
                  <span className={cx('live-dot', !on && 'off')} title={on ? 'Active in the last 5 minutes' : 'Idle'} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="s-group">
        <div className="lbl">Agent profiles</div>
        <Row title="Agents work in their own browser" desc="Each agent that connects gets its own profile and window; it asks before seeing your tabs.">
          <button className="btn btn-ghost btn-sm" onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'settings', section: 'profiles' } })}>
            Manage in Profiles
          </button>
        </Row>
      </div>

      <div className="s-group">
        <div className="lbl">Access</div>
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
    <>
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
    <Duplicates />
    </>
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

// ---------- agent setup snippets ----------

const AGENT_TILES: { id: string; name: string; brand: string }[] = [
  { id: 'claude-code', name: 'Claude Code', brand: 'claude-code' },
  { id: 'codex', name: 'Codex', brand: 'codex' },
  { id: 'gemini-cli', name: 'Gemini CLI', brand: 'gemini-cli' },
  { id: 'cursor', name: 'Cursor', brand: 'cursor' },
  { id: 'claude-desktop', name: 'Claude Desktop', brand: 'claude' },
  { id: 'vscode', name: 'VS Code', brand: 'copilot' },
  { id: 'windsurf', name: 'Windsurf', brand: 'windsurf' },
  { id: 'mcp', name: 'Other MCP', brand: 'mcp' },
  { id: 'http', name: 'HTTP API', brand: 'http' },
  { id: 'cli', name: 'Shell & scripts', brand: 'cli' },
];

function agentSnippets(sec: QueryMap['controlSecrets']['result']) {
  const auth = { Authorization: `Bearer ${sec.token}` };
  const j = (o: unknown) => JSON.stringify(o, null, 2);
  const st = sec.stdio;
  const toml = [
    '[mcp_servers.clickless]',
    `command = ${JSON.stringify(st.command)}`,
    `args = [${st.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    ...(st.env ? [`env = { ${Object.entries(st.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }`] : []),
  ].join('\n');
  const bridge = 'Starts the Clickless bridge, which finds the browser and its token on this Mac by itself.';
  return [
    { id: 'claude-code', name: 'Claude Code', where: 'run once in a terminal', text: sec.claudeCodeCommand },
    { id: 'codex', name: 'Codex', where: 'add to ~/.codex/config.toml', text: toml, note: bridge },
    { id: 'gemini-cli', name: 'Gemini CLI', where: 'add to ~/.gemini/settings.json', text: j({ mcpServers: { clickless: { httpUrl: sec.mcpUrl, headers: auth } } }) },
    { id: 'cursor', name: 'Cursor', where: 'add to ~/.cursor/mcp.json', text: j({ mcpServers: { clickless: { url: sec.mcpUrl, headers: auth } } }) },
    { id: 'claude-desktop', name: 'Claude Desktop', where: 'add to ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude', text: j({ mcpServers: { clickless: st } }), note: bridge },
    { id: 'vscode', name: 'VS Code (Copilot agent mode)', where: 'add to .vscode/mcp.json, or “MCP: Open User Configuration”', text: j({ servers: { clickless: { type: 'http', url: sec.mcpUrl, headers: auth } } }) },
    { id: 'windsurf', name: 'Windsurf', where: 'add to ~/.codeium/windsurf/mcp_config.json', text: j({ mcpServers: { clickless: { serverUrl: sec.mcpUrl, headers: auth } } }) },
    { id: 'mcp', name: 'Any MCP client', where: 'Streamable HTTP, or the stdio bridge for clients without HTTP', text: sec.mcpJson },
    { id: 'http', name: 'HTTP API', where: 'local models, Python, n8n — anything that speaks HTTP', text: sec.curlExample },
    { id: 'cli', name: 'Shell & scripts', where: 'the clickless CLI', text: sec.cliExample },
  ] as { id: string; name: string; where: string; text: string; note?: string }[];
}

// ---------- agent profiles ----------

function AgentProfilesGroup({ state }: { state: UIState }) {
  const a = state.settings.agents;
  const [resetting, setResetting] = useState<string | null>(null);
  if (state.profile.kind === 'agent') return null;
  return (
    <div className="s-group">
      <div className="lbl">Agent profiles</div>
      <div className="desc">
        Agents that connect over MCP get their own browser: a separate profile and window with their own cookies, logins and tabs. Your tabs, accounts and history stay private; an agent can ask for specific tabs and you choose what to share.
      </div>
      <Row title="When an agent connects" desc="Your own scripts (HTTP, the clickless CLI) always use your browser.">
        <Seg
          value={a.defaultAccess}
          onChange={(access) => cmd({ type: 'agents.defaultAccess', access })}
          options={[
            { v: 'own', label: 'Its own profile' },
            { v: 'shared', label: 'My profile' },
          ]}
        />
      </Row>
      {state.agentProfiles.map((p) => {
        const info = agentClient(p.id);
        return (
          <div key={p.id} className="s-row agent-prof">
            <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <BrandIcon name={info.brand ?? info.id} size={16} tile={30} />
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <b>{p.name}</b>
                <span>
                  {p.access === 'shared' ? 'Uses your browser' : p.running ? `Own window open · ${p.tabs ?? 0} tab${p.tabs === 1 ? '' : 's'}` : 'Own profile · not running'}
                  {p.lastUsedAt ? ` · ${timeAgo(p.lastUsedAt)}` : ''}
                </span>
              </span>
            </div>
            <div className="v" style={{ gap: 6 }}>
              <Seg
                value={p.access}
                onChange={(access) => cmd({ type: 'agents.access', clientId: p.id, access })}
                options={[
                  { v: 'own', label: 'Own' },
                  { v: 'shared', label: 'Mine' },
                ]}
              />
              {p.access === 'own' && (
                <button className="btn btn-ghost btn-sm" onClick={() => cmd({ type: 'agents.show', clientId: p.id })}>
                  Show window
                </button>
              )}
              {resetting === p.id ? (
                <button className="btn btn-danger btn-sm" onClick={() => (setResetting(null), cmd({ type: 'agents.reset', clientId: p.id }))}>
                  Delete its profile?
                </button>
              ) : (
                <button className="btn btn-ghost btn-sm" title="Close its window and delete its cookies, logins and tabs" onClick={() => setResetting(p.id)}>
                  Reset
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
