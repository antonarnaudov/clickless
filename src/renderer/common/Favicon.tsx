import { memo, useState } from 'react';
import { Globe, Sparkles } from 'lucide-react';
import { hostOf, letterColor } from './util';

export const Favicon = memo(function Favicon({ src, url, size = 16, title }: { src?: string; url?: string; size?: number; title?: string }) {
  const [failed, setFailed] = useState(false);
  const host = hostOf(url);
  const style = { width: size, height: size };
  if (url?.startsWith('clickless://ask')) return <Sparkles className="fav" style={{ ...style, color: 'var(--accent)' }} strokeWidth={2} />;
  if (url?.startsWith('clickless://')) return <Globe className="fav" style={{ ...style, color: 'var(--ink-3)' }} strokeWidth={1.8} />;
  if (src && !failed) return <img className="fav" style={style} src={src} alt="" draggable={false} onError={() => setFailed(true)} />;
  const letter = (title || host || '?').replace(/^www\./, '').trim()[0] ?? '?';
  return (
    <span className="fav-letter" style={{ ...style, background: letterColor(host || title || '?'), fontSize: Math.round(size * 0.6) }}>
      {letter}
    </span>
  );
});
