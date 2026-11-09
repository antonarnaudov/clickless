// Saved passwords inside pages (isolated world): offers your saved logins when you focus a sign-in
// field, fills the one you pick, and tells the browser when you sign in so it can offer to save.
// The password itself only comes from the main process after you pick a login, and never while an
// agent is acting in the tab. Agents' own browsers have no password store, so nothing shows there.

import { ipcRenderer } from 'electron';
import { IPC } from '../../shared/ipc';

export const AUTOFILL_ID = 'clickless-autofill';

type Login = { id: string; username: string };

const isPassword = (el: unknown): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'password';
const visible = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};
const textish = (el: unknown): el is HTMLInputElement => el instanceof HTMLInputElement && ['text', 'email', 'tel', ''].includes(el.type);

function scopeOf(el: Element): ParentNode {
  return el.closest('form') ?? (el.getRootNode() as Document | ShadowRoot) ?? document;
}

/** The username field that goes with a password field: the last text/email field before it. */
function usernameField(pw: HTMLInputElement): HTMLInputElement | null {
  const all = Array.from(scopeOf(pw).querySelectorAll('input')) as HTMLInputElement[];
  const before = all.slice(0, all.indexOf(pw)).filter((i) => textish(i) && visible(i));
  const named = before.filter((i) => /user|email|login|account|phone|identifier/i.test(`${i.autocomplete} ${i.name} ${i.id} ${i.type}`));
  return named[named.length - 1] ?? before[before.length - 1] ?? null;
}

function passwordIn(scope: ParentNode): HTMLInputElement | null {
  return (Array.from(scope.querySelectorAll('input[type=password]')) as HTMLInputElement[]).find((p) => p.value && visible(p)) ?? null;
}

// ---------- offer to save after a sign-in ----------

let lastSent = '';
function signedIn(pw: HTMLInputElement) {
  const password = pw.value;
  if (!password) return;
  const username = usernameField(pw)?.value.trim() ?? '';
  const key = `${username}\u0000${password}`;
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.send(IPC.pwSubmit, { origin: location.origin, username, password });
}

// ---------- filling ----------

let logins: Login[] | null = null;
let asking: Promise<Login[]> | null = null;
function loginsHere(): Promise<Login[]> {
  if (logins) return Promise.resolve(logins);
  asking ??= ipcRenderer
    .invoke(IPC.pwQuery, { origin: location.origin })
    .then((l: Login[]) => (logins = Array.isArray(l) ? l : []))
    .catch(() => (logins = []));
  return asking;
}

/** Sets a field the way typing would (frameworks see the change). */
function setValue(el: HTMLInputElement, v: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  el.focus();
  set ? set.call(el, v) : (el.value = v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function fill(id: string, field: HTMLInputElement) {
  const r = (await ipcRenderer.invoke(IPC.pwFill, { origin: location.origin, id }).catch(() => null)) as { username: string; password: string } | null;
  if (!r) return;
  const pw = isPassword(field) ? field : ((Array.from(scopeOf(field).querySelectorAll('input[type=password]')) as HTMLInputElement[]).find(visible) ?? null);
  const user = pw ? usernameField(pw) : textish(field) ? field : null;
  if (user && r.username) setValue(user, r.username);
  if (pw) setValue(pw, r.password);
  lastSent = `${r.username}\u0000${r.password}`; // already saved: no "save?" prompt for it
  hide();
}

// ---------- the little menu under the field ----------

let host: HTMLDivElement | null = null;
let root: ShadowRoot | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function hide() {
  host?.remove();
  host = null;
  root = null;
}

function show(field: HTMLInputElement, list: Login[]) {
  hide();
  const r = field.getBoundingClientRect();
  host = document.createElement('div');
  host.id = AUTOFILL_ID;
  host.style.cssText = `position:fixed;z-index:2147483647;left:${Math.round(r.left)}px;top:${Math.round(r.bottom + 4)}px;min-width:${Math.max(220, Math.round(r.width))}px`;
  root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .m{font:13px/1.3 -apple-system,system-ui,sans-serif;background:#fff;color:#16181d;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06);padding:4px;overflow:hidden}
    @media (prefers-color-scheme:dark){.m{background:#1d2320;color:#eef3ef;box-shadow:0 8px 30px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)}}
    .h{padding:6px 8px 4px;font-size:11px;opacity:.6}
    button{all:unset;display:flex;gap:8px;align-items:center;width:calc(100% - 16px);padding:7px 8px;border-radius:7px;cursor:default}
    button:hover,button:focus{background:rgba(16,165,146,.14)}
    .k{width:14px;height:14px;flex:none;opacity:.7}
  </style><div class="m"><div class="h">Saved logins · Clickless</div></div>`;
  const m = root.querySelector('.m')!;
  for (const l of list.slice(0, 6)) {
    const b = document.createElement('button');
    b.innerHTML = `<svg class="k" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14 9l2 2"/></svg>`;
    b.append(l.username || '(no username)');
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => fill(l.id, field));
    m.appendChild(b);
  }
  document.documentElement.appendChild(host);
}

export function startAutofill() {
  document.addEventListener(
    'submit',
    (e) => {
      const pw = passwordIn(e.target as HTMLFormElement);
      if (pw) signedIn(pw);
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const t = (e.target as Element | null)?.closest?.('button, input[type=submit], [role=button]');
      if (!t || t.closest(`#${AUTOFILL_ID}`)) return;
      const pw = passwordIn(scopeOf(t));
      if (pw) setTimeout(() => signedIn(pw), 0);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && isPassword(e.target)) signedIn(e.target);
      if (e.key === 'Escape') hide();
    },
    true,
  );
  document.addEventListener(
    'focusin',
    async (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || !e.isTrusted) return;
      const wantsLogin = isPassword(el) || (textish(el) && !!scopeOf(el).querySelector('input[type=password]'));
      if (!wantsLogin) return;
      const list = await loginsHere();
      if (list.length && document.activeElement === el) show(el, list);
    },
    true,
  );
  document.addEventListener(
    'focusout',
    () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 180);
    },
    true,
  );
  addEventListener('scroll', hide, true);
}
