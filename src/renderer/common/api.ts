import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Command, QueryMap, QueryName, ShellEvent } from '../../shared/ipc';
import type { AskState, ChatState, UIState } from '../../shared/types';
import { share } from './util';

/** Fire-and-forget command. Errors are logged, never thrown into React. */
export function cmd(command: Command): Promise<any> {
  return window.clickless.cmd(command).catch((err: unknown) => {
    console.error('[clickless] command failed', command.type, err);
    return undefined;
  });
}

export function query<K extends QueryName>(name: K, args: QueryMap[K]['args']): Promise<QueryMap[K]['result']> {
  return window.clickless.query(name, args);
}

function createStore<T>(subscribe: (set: (v: T) => void) => void) {
  let value: T | null = null;
  let started = false;
  const listeners = new Set<() => void>();
  const set = (v: T) => {
    const next = value === null ? v : share(value, v);
    if (next === value) return;
    value = next;
    listeners.forEach((l) => l());
  };
  return {
    subscribe(l: () => void) {
      if (!started) {
        started = true;
        subscribe(set);
      }
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get: () => value,
  };
}

const uiStore = createStore<UIState>((set) => {
  window.clickless.onState(set);
  query('state', {}).then(set, () => undefined);
});

const chatStore = createStore<ChatState>((set) => {
  window.clickless.onChat(set);
  query('chatState', {}).then(set, () => undefined);
});

/** The whole UI state. Unchanged sub-objects keep their identity between pushes. */
export function useUIState(): UIState | null {
  return useSyncExternalStore(uiStore.subscribe, uiStore.get);
}

export function useChat(): ChatState | null {
  return useSyncExternalStore(chatStore.subscribe, chatStore.get);
}

export function useAsk(askId: string | null): AskState | null {
  const [ask, setAsk] = useState<AskState | null>(null);
  useEffect(() => {
    if (!askId) return;
    let alive = true;
    const off = window.clickless.onAsk((a) => {
      if (a.id === askId && alive) setAsk((prev) => (prev ? share(prev, a) : a));
    });
    query('askState', { askId }).then((a) => {
      if (alive && a) setAsk((prev) => prev ?? a);
    });
    return () => {
      alive = false;
      off();
    };
  }, [askId]);
  return ask;
}

export function useShellEvents(cb: (e: ShellEvent) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => window.clickless.onEvent((e) => ref.current(e)), []);
}
