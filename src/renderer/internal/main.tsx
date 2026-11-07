import '../mock';
import '../common/base.css';
import './internal.css';
import { createRoot } from 'react-dom/client';
import { useUIState } from '../common/api';
import { useTheme } from '../common/theme';
import { Ask } from './Ask';
import { NewTab } from './NewTab';

/** clickless://newtab, clickless://ask?id=… — or /internal.html?page=ask&id=… in the dev server. */
function route(): { page: string; id: string | null } {
  const params = new URLSearchParams(location.search);
  const m = location.href.match(/^clickless:\/\/([^/?#]+)/);
  const page = m ? m[1] : (params.get('page') ?? 'newtab');
  return { page, id: params.get('id') ?? (page === 'ask' && !m ? 'mock-ask' : null) };
}

function App() {
  const state = useUIState();
  useTheme(state);
  const r = route();
  if (r.page === 'ask') return <Ask askId={r.id} />;
  return <NewTab state={state} />;
}

createRoot(document.getElementById('root')!).render(<App />);
