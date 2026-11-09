// One-time upgrades of saved data between versions. No Electron imports, so they can be tested.

import type { Folder } from '../shared/types';

interface WithFolders {
  folders: Folder[];
  migrated?: string[];
}

/**
 * 0.1 imported nested folders as one level named "Parent / Child". Turn them back into real
 * sub-folders (creating a missing parent), once.
 */
export function nestFlattenedFolders(st: WithFolders): number {
  st.migrated ??= [];
  if (st.migrated.includes('nested-folders')) return 0;
  st.migrated.push('nested-folders');
  const pathOf = (f: Folder): string => {
    const p = f.parentId ? st.folders.find((x) => x.id === f.parentId) : undefined;
    return p ? `${pathOf(p)} / ${f.name}` : f.name;
  };
  let n = 0;
  const flat = st.folders.filter((f) => !f.parentId && f.name.includes(' / ')).sort((a, b) => a.name.split(' / ').length - b.name.split(' / ').length);
  const ensure = (path: string, like: Folder): Folder => {
    const hit = st.folders.find((x) => x.spaceId === like.spaceId && x.pinned === like.pinned && pathOf(x) === path);
    if (hit) return hit;
    const parts = path.split(' / ');
    const parent = parts.length > 1 ? ensure(parts.slice(0, -1).join(' / '), like) : undefined;
    const f: Folder = { id: `f${Date.now().toString(36)}m${n}`, spaceId: like.spaceId, name: parts[parts.length - 1], collapsed: true, pinned: like.pinned, order: like.order - 0.0001, parentId: parent?.id };
    st.folders.push(f);
    return f;
  };
  for (const f of flat) {
    const parts = f.name.split(' / ');
    const parent = ensure(parts.slice(0, -1).join(' / '), f);
    if (parent.id === f.id) continue;
    f.parentId = parent.id;
    f.name = parts[parts.length - 1];
    n++;
  }
  return n;
}

