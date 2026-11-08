// Shared state for dragging a tab (from the sidebar) or a split pane (by its grip) over the page
// area. The Viewport computes the drop zone under the pointer; whoever ends the drag runs it.

import { useSyncExternalStore } from 'react';
import type { Command } from '../../shared/ipc';

export type DragItem = { kind: 'tab'; tabId: string } | { kind: 'pane'; tabId: string };

export interface DropZone {
  /** What happens on drop. */
  action: Command;
  /** Where to draw the highlight, in window coordinates. */
  rect: { x: number; y: number; width: number; height: number };
  label: string;
}

export interface SplitDrag {
  item: DragItem;
  x: number;
  y: number;
  zone: DropZone | null;
}

let cur: SplitDrag | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const splitDrag = {
  get: () => cur,
  start(item: DragItem, x: number, y: number) {
    cur = { item, x, y, zone: null };
    emit();
  },
  move(x: number, y: number) {
    if (!cur || (cur.x === x && cur.y === y)) return;
    cur = { ...cur, x, y };
    emit();
  },
  setZone(zone: DropZone | null) {
    if (!cur || JSON.stringify(cur.zone) === JSON.stringify(zone)) return;
    cur = { ...cur, zone };
    emit();
  },
  /** Ends the drag and returns the drop action, if the pointer was over a zone. */
  end(): Command | null {
    const action = cur?.zone?.action ?? null;
    cur = null;
    emit();
    return action;
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useSplitDrag(): SplitDrag | null {
  return useSyncExternalStore(splitDrag.subscribe, splitDrag.get, splitDrag.get);
}
