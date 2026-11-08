import { useMemo, useState } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
import { agentClient } from '../../shared/agents';
import type { OverlayState, UIState } from '../../shared/types';
import { cmd } from '../common/api';
import { BrandIcon } from '../common/BrandIcon';
import { Favicon } from '../common/Favicon';
import { cx, hostOf } from '../common/util';

/** An agent working in its own profile asks for some of your tabs. Nothing is shared until you pick. */
export function ShareTabs({ overlay, state }: { overlay: Extract<OverlayState, { kind: 'share-tabs' }>; state: UIState }) {
  const tabs = useMemo(() => state.tabs.filter((t) => /^https?:/.test(t.url)), [state.tabs]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(overlay.preselect));
  const info = agentClient(overlay.clientId);
  const bySpace = state.spaces
    .map((s) => ({ space: s, tabs: tabs.filter((t) => !t.favorite && t.spaceId === s.id).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order) }))
    .filter((g) => g.tabs.length);
  const favs = tabs.filter((t) => t.favorite);
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const answer = (ids: string[] | null) => cmd({ type: 'agents.share', requestId: overlay.requestId, tabIds: ids });
  const groups = [...(favs.length ? [{ key: 'fav', label: 'Favourites', tabs: favs }] : []), ...bySpace.map((g) => ({ key: g.space.id, label: `${g.space.icon} ${g.space.name}`, tabs: g.tabs }))];
  return (
    <div className="modal share" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`${overlay.clientName} asks for tabs`}>
      <div className="share-head">
        <BrandIcon name={info.brand ?? info.id} size={22} tile={40} />
        <div>
          <h3>{overlay.clientName} asks to see some of your tabs</h3>
          {overlay.reason && <p className="reason">“{overlay.reason}”</p>}
        </div>
      </div>
      <div className="share-note">
        <ShieldCheck size={14} /> It works in its own browser profile. Only the tabs you tick are copied into its window, as plain pages: it isn’t signed in as you.
      </div>
      <div className="share-list scroll">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="share-group">{g.label}</div>
            {g.tabs.map((t) => (
              <button key={t.id} className={cx('share-row', picked.has(t.id) && 'on')} onClick={() => toggle(t.id)}>
                <span className="box">{picked.has(t.id) && <Check size={12} strokeWidth={2.6} />}</span>
                <Favicon src={t.favicon} url={t.url} title={t.title} />
                <span className="title truncate">{t.title || t.url}</span>
                <span className="host truncate">{hostOf(t.url)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="share-foot">
        <button className="btn btn-ghost" onClick={() => answer(null)}>
          Don’t share
        </button>
        <button className="btn btn-primary" disabled={!picked.size} onClick={() => answer([...picked])}>
          Share {picked.size || ''} tab{picked.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}
