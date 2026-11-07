import { useEffect, useMemo, useState } from 'react';
import { Check, Globe, Sparkles, Wand2, X } from 'lucide-react';
import type { OrganizeProposal, OverlayState, UIState } from '../../shared/types';
import { cmd } from '../common/api';
import { Favicon } from '../common/Favicon';

type OrganizeOverlay = Extract<OverlayState, { kind: 'organize' }>;

export function Organizer({ overlay, state }: { overlay: OrganizeOverlay; state: UIState }) {
  const [draft, setDraft] = useState<OrganizeProposal | null>(overlay.proposal);
  const [closeSel, setCloseSel] = useState<Set<string>>(new Set(overlay.proposal?.close ?? []));
  const [renameSel, setRenameSel] = useState<Set<string>>(new Set(overlay.proposal?.renames.map((r) => r.tabId) ?? []));
  useEffect(() => {
    setDraft(overlay.proposal);
    setCloseSel(new Set(overlay.proposal?.close ?? []));
    setRenameSel(new Set(overlay.proposal?.renames.map((r) => r.tabId) ?? []));
  }, [overlay.proposal]);
  const tabs = useMemo(() => new Map(state.tabs.map((t) => [t.id, t])), [state.tabs]);
  const space = state.spaces.find((s) => s.id === overlay.spaceId);
  const close = () => cmd({ type: 'ui.overlay', overlay: null });

  const apply = () => {
    if (!draft) return;
    cmd({
      type: 'organize.apply',
      proposal: {
        ...draft,
        groups: draft.groups.filter((g) => g.tabIds.length),
        close: draft.close.filter((id) => closeSel.has(id)),
        renames: draft.renames.filter((r) => renameSel.has(r.tabId)),
      },
    });
  };

  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    fn(n);
  };

  const moved = draft?.groups.reduce((n, g) => n + g.tabIds.length, 0) ?? 0;

  return (
    <div className="modal organize" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Tidy tabs">
      <div className="o-head">
        <h3>
          <Wand2 size={20} style={{ color: 'var(--accent)' }} /> Tidy {space ? `${space.icon} ${space.name}` : 'tabs'}
        </h3>
        <p>{overlay.loading ? 'Reading your open tabs…' : overlay.error ? 'Something went wrong.' : `${moved} tabs into ${draft?.groups.length ?? 0} folders. Rename or drop anything before applying.`}</p>
      </div>
      <div className="o-body scroll">
        {overlay.loading && (
          <>
            {[0, 1, 2].map((i) => (
              <div key={i} className="o-group" style={{ animationDelay: `${i * 80}ms` }}>
                <div className="shimmer" style={{ width: '40%', height: 18, margin: '6px 6px 10px' }} />
                <div className="shimmer" style={{ marginBottom: 4 }} />
                <div className="shimmer" style={{ width: '80%' }} />
              </div>
            ))}
          </>
        )}
        {overlay.error && <div className="msg-error" style={{ padding: 12, borderRadius: 10, background: 'var(--danger-soft)', color: 'var(--danger)' }}>{overlay.error}</div>}
        {draft &&
          draft.groups.map((g, gi) => (
            <div key={gi} className="o-group" style={{ animationDelay: `${gi * 60}ms` }}>
              <div className="gh">
                <span className="em">{g.emoji ?? '📁'}</span>
                <input
                  value={g.name}
                  onChange={(e) => setDraft({ ...draft, groups: draft.groups.map((x, i) => (i === gi ? { ...x, name: e.target.value } : x)) })}
                  aria-label="Folder name"
                />
                <span className="n">{g.tabIds.length}</span>
              </div>
              {g.tabIds.map((id) => {
                const t = tabs.get(id);
                if (!t) return null;
                return (
                  <div key={id} className="o-tab">
                    <Favicon src={t.favicon} url={t.url} title={t.title} />
                    <span className="truncate" style={{ flex: 1 }}>
                      {closeSel.has(id) ? <s>{t.title}</s> : renameSel.has(id) ? (draft.renames.find((r) => r.tabId === id)?.title ?? t.title) : t.title}
                    </span>
                    <button
                      className="icon-btn sm"
                      title="Leave this tab where it is"
                      onClick={() => setDraft({ ...draft, groups: draft.groups.map((x, i) => (i === gi ? { ...x, tabIds: x.tabIds.filter((y) => y !== id) } : x)) })}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        {draft && draft.close.length > 0 && (
          <div className="o-group">
            <div className="gh">
              <span className="em">🧹</span>
              <b style={{ flex: 1, padding: '3px 4px', fontSize: 13.5 }}>Close duplicates</b>
            </div>
            {draft.close.map((id) => {
              const t = tabs.get(id);
              if (!t) return null;
              return (
                <label key={id} className="o-check">
                  <input type="checkbox" checked={closeSel.has(id)} onChange={() => toggle(closeSel, id, setCloseSel)} />
                  <Favicon src={t.favicon} url={t.url} title={t.title} />
                  <span className="truncate">{closeSel.has(id) ? <s>{t.title}</s> : t.title}</span>
                </label>
              );
            })}
          </div>
        )}
        {draft && draft.renames.length > 0 && (
          <div className="o-group">
            <div className="gh">
              <span className="em">✏️</span>
              <b style={{ flex: 1, padding: '3px 4px', fontSize: 13.5 }}>Cleaner titles</b>
            </div>
            {draft.renames.map((r) => {
              const t = tabs.get(r.tabId);
              if (!t) return null;
              return (
                <label key={r.tabId} className="o-check">
                  <input type="checkbox" checked={renameSel.has(r.tabId)} onChange={() => toggle(renameSel, r.tabId, setRenameSel)} />
                  <span className="truncate" style={{ color: 'var(--ink-3)', maxWidth: '45%' }}>
                    {t.title}
                  </span>
                  <span style={{ color: 'var(--ink-4)' }}>→</span>
                  <span className="truncate" style={{ fontWeight: 560 }}>
                    {r.title}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      <div className="o-foot">
        <span className="src">
          {draft?.source === 'ai' ? (
            <>
              <Sparkles size={12} /> Grouped by AI
            </>
          ) : draft ? (
            <>
              <Globe size={12} /> Grouped by site — connect a model for smarter groups
            </>
          ) : null}
        </span>
        <button className="btn btn-ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!draft || overlay.loading} onClick={apply}>
          <Check size={13} /> Apply
        </button>
      </div>
    </div>
  );
}
