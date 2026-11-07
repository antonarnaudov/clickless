import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { SPACE_COLORS } from '../../shared/settings';
import type { OverlayState, UIState } from '../../shared/types';
import { cmd } from '../common/api';
import { cx } from '../common/util';

const EMOJIS = [
  '🛠️', '💼', '🚀', '🧪', '🔭', '📚', '✍️', '🎨', '🎧', '🎮',
  '🌿', '🏡', '✈️', '🍳', '💪', '🧘', '💸', '📈', '🛒', '🎓',
  '🐙', '🦊', '🐝', '🌊', '🔥', '⚡️', '🌙', '☀️', '🍀', '🪐',
  '💡', '🧠', '🤖', '🔒', '📦', '🗂️', '📰', '🎬', '❤️', '✨',
];

export function SpaceEditor({ overlay, state }: { overlay: Extract<OverlayState, { kind: 'space' }>; state: UIState }) {
  const existing = overlay.spaceId ? state.spaces.find((s) => s.id === overlay.spaceId) : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? EMOJIS[(state.spaces.length * 7) % EMOJIS.length]);
  const [color, setColor] = useState(existing?.color ?? SPACE_COLORS[state.spaces.length % SPACE_COLORS.length]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const save = async () => {
    const n = name.trim() || 'Space';
    if (existing) await cmd({ type: 'space.update', spaceId: existing.id, patch: { name: n, icon, color } });
    else await cmd({ type: 'space.create', name: n, icon, color });
    cmd({ type: 'ui.overlay', overlay: null });
  };

  return (
    <div className="modal space-ed" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={existing ? 'Edit space' : 'New space'}>
      <div className="space-preview grain" style={{ ['--pick' as string]: color }}>
        <span className="big">{icon}</span>
        <span className="nm">{name.trim() || (existing ? existing.name : 'New space')}</span>
      </div>
      <div className="space-body">
        <label>
          Name
          <input
            ref={inputRef}
            className="field"
            value={name}
            placeholder="Work, Personal, Research…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
            }}
          />
        </label>
        <label>
          Icon
          <div className="emojis">
            {EMOJIS.map((e) => (
              <button key={e} className={cx(icon === e && 'on')} onClick={() => setIcon(e)}>
                {e}
              </button>
            ))}
          </div>
        </label>
        <label>
          Colour
          <div className="swatches">
            {SPACE_COLORS.map((c) => (
              <button key={c} className={cx(color === c && 'on')} style={{ background: c, color: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Custom colour" />
          </div>
        </label>
      </div>
      <div className="space-foot">
        {existing && state.spaces.length > 1 && (
          <button className="btn btn-danger" onClick={() => cmd({ type: 'space.delete', spaceId: existing.id })}>
            <Trash2 size={13} /> Delete
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={() => cmd({ type: 'ui.overlay', overlay: null })}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save}>
          {existing ? 'Save' : 'Create space'}
        </button>
      </div>
    </div>
  );
}
