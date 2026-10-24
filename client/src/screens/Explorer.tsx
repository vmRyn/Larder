import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, type Entry, type Favorite, type RootInfo, type TrashItem } from '../api';
import { Dialog } from '../components/Dialog';
import { ContextMenu, menuItems, type ContextIcon, type ContextItem } from '../components/ContextMenu';
import { Icon, iconFor, isAudioName, isImageName, isVideoName, type IconName } from '../components/Icons';
import { ShareActions, type ShareLink } from '../components/ShareActions';
import { Preview } from '../components/Preview';
import { fromDataTransfer } from '../drop';
import { baseName, formatBytes, formatDate, formatDuration, formatStamp, joinPath, parentPath } from '../format';

let internalDrag = false;

type Row = Entry & { path: string; rootId?: string; place?: string };

const CHUNK = 4 * 1024 * 1024;

function folderPaths(paths: string[]): string[] {
  const directories = new Set<string>();
  for (const rel of paths) {
    const parts = rel.split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      directories.add(current);
    }
  }
  return [...directories];
}

function Cmd({ icon, label, onClick, disabled, href }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean; href?: string }) {
  if (href) {
    return (
      <a className="cmd" href={href}>
        <Icon name={icon} size={16} />
        <span>{label}</span>
      </a>
    );
  }
  return (
    <button className="cmd" type="button" disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span>{label}</span>
    </button>
  );
}

export function Explorer({
  rootId,
  rootName,
  path,
  setPath,
  canEdit,
  places,
  favorites,
  onFavorites,
  trash,
  setTrash,
  admin,
  onOpen,
}: {
  rootId: string;
  rootName: string;
  path: string;
  setPath: (path: string) => void;
  canEdit: boolean;
  places: RootInfo[];
  favorites: Favorite[];
  onFavorites: (folderPath?: string) => void;
  trash: boolean;
  setTrash: (trash: boolean) => void;
  admin: boolean;
  onOpen: (rootId: string, path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [trashTotal, setTrashTotal] = useState(0);
  const [trashDays, setTrashDays] = useState<number | null>(null);
  const [search, setSearch] = useState<{ q: string; rows: Row[] } | null>(null);
  const [filter, setFilter] = useState('');
  const [searchText, setSearchText] = useState('');
  const [searchAll, setSearchAll] = useState(false);
  const [searchType, setSearchType] = useState('any');
  const [searchSize, setSearchSize] = useState('any');
  const [searchWhen, setSearchWhen] = useState('any');
  const [hidden, setHidden] = useState(localStorage.getItem('larder:hidden') === '1');
  const [icons, setIcons] = useState(localStorage.getItem('larder:icons') === '1');
  const [sort, setSort] = useState<{ key: 'name' | 'size' | 'mtime' | 'type'; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [banner, setBanner] = useState('');
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(path);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewRoot, setPreviewRoot] = useState(rootId);
  const [upload, setUpload] = useState<{ label: string; ratio: number } | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const [clipboard, setClipboard] = useState<{ mode: 'cut' | 'copy'; paths: string[] } | null>(null);
  const [dialog, setDialog] = useState<
    | null
    | { type: 'folder' | 'file' | 'rename'; value: string }
    | { type: 'delete'; count: number; typed: string; strong: boolean }
    | { type: 'move'; destination: string | null; destRoot: string; nodes: Record<string, Entry[]>; open: string[] }
    | { type: 'conflict'; items: { path: string; id: string; key: string }[] }
    | { type: 'empty'; count: number; typed: string }
    | { type: 'restore'; id: string }
    | { type: 'share'; path: string; name: string; password: string; days: string; note: string; address: string; url: string; error: string; shares: ShareLink[]; folder: boolean; shareRoot: string }
  >(null);
  const [copiedLink, setCopiedLink] = useState('');
  const parentRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const abortUpload = useRef<AbortController | null>(null);
  const history = useRef({ entries: [path], index: 0, quiet: false });
  const rootSeen = useRef(rootId);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [newOpen, setNewOpen] = useState(false);
  const [menu, setMenu] = useState<null | { x: number; y: number; kind: 'row' | 'blank' | 'trash'; path?: string; id?: string }>(null);

  const load = useCallback(async () => {
    if (trash) {
      const data = await api<{ items: TrashItem[]; total?: number; trashDays?: number | null }>(`/api/trash?root=${encodeURIComponent(rootId)}&limit=100`);
      setTrashItems(data.items);
      setTrashTotal(data.total ?? data.items.length);
      setTrashDays(data.trashDays ?? null);
      return;
    }
    const data = await api<{ entries: Entry[] }>(
      `/api/list?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}&sort=${sort.key}&dir=${sort.dir}`,
    );
    setEntries(data.entries);
  }, [trash, rootId, path, sort]);

  useEffect(() => {
    setSelected([]);
    setPreview(null);
    setSearch(null);
    setBanner('');
    void load().catch((reason: Error) => setBanner(reason.message));
  }, [load]);

  useEffect(() => {
    localStorage.setItem('larder:hidden', hidden ? '1' : '0');
  }, [hidden]);

  useEffect(() => {
    localStorage.setItem('larder:icons', icons ? '1' : '0');
  }, [icons]);
  useEffect(() => {
    const saved = localStorage.getItem(`larder:sort:${rootId}|${path}`);
    if (!saved) {
      setSort({ key: 'name', dir: 'asc' });
      return;
    }
    try {
      setSort(JSON.parse(saved) as { key: 'name' | 'size' | 'mtime' | 'type'; dir: 'asc' | 'desc' });
    } catch {
      setSort({ key: 'name', dir: 'asc' });
    }
  }, [rootId, path]);

  const rows: Row[] = useMemo(() => {
    if (search) return search.rows;
    return entries
      .filter((entry) => (hidden || !entry.hidden) && entry.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
      .map((entry) => ({ ...entry, path: joinPath(path, entry.name) }));
  }, [entries, filter, hidden, path, search]);

  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 40, overscan: 16 });
  const pinned = favorites.some((item) => item.root === rootId && item.path === path);
  const one = rows.find((row) => row.path === selected[0]);
  const previewEntry = rows.find((row) => row.path === preview) ?? null;

  function choose(row: Row, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) {
    if (event.shiftKey && anchor) {
      const start = rows.findIndex((item) => item.path === anchor);
      const end = rows.findIndex((item) => item.path === row.path);
      const [from, to] = start < end ? [start, end] : [end, start];
      setSelected(rows.slice(from, to + 1).map((item) => item.path));
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      setSelected((current) => (current.includes(row.path) ? current.filter((item) => item !== row.path) : [...current, row.path]));
    } else setSelected([row.path]);
    setAnchor(row.path);
  }

  function openRow(row: Row) {
    if (row.outside) {
      setBanner('This link points outside the folder Larder is allowed to use.');
      return;
    }
    if (row.kind === 'dir' || row.symlinkTo === 'dir') {
      setSearch(null);
      setTrash(false);
      if (row.rootId && row.rootId !== rootId) onOpen(row.rootId, row.path);
      else setPath(row.path);
      return;
    }
    setPreviewRoot(row.rootId ?? rootId);
    setPreview(row.path);
  }

  async function run(action: () => Promise<void>) {
    try {
      setBanner('');
      await action();
      await load();
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'conflict') setBanner(reason.message);
      else setBanner(reason instanceof Error ? reason.message : 'That action failed.');
    }
  }

  async function uploadItems(items: { file: File; path: string }[], directories: string[], onConflict?: 'replace' | 'keep') {
    for (const directory of [...directories].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const parent = parentPath(directory);
      const name = baseName(directory);
      try {
        await api('/api/mkdir', { method: 'POST', body: JSON.stringify({ root: rootId, path: joinPath(path, parent), name }) });
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.code !== 'conflict') throw reason;
      }
    }
    if (items.length === 0) {
      await load();
      return;
    }
    const controller = new AbortController();
    abortUpload.current = controller;
    const conflicts: { path: string; id: string; key: string }[] = [];
    let activeId = '';
    let activeKey = '';
    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        const key = `larder:up:${rootId}|${path}|${item.path}|${item.file.size}|${item.file.lastModified}`;
        activeKey = key;
        const stored = localStorage.getItem(key) ?? undefined;
        const started = await api<{ id: string; offset: number }>('/api/uploads', {
          method: 'POST',
          body: JSON.stringify({ root: rootId, path, name: item.path, size: item.file.size, id: stored }),
          signal: controller.signal,
        });
        activeId = started.id;
        localStorage.setItem(key, started.id);
        let offset = started.offset;
        setUpload({ label: `${item.path} · ${index + 1} of ${items.length}`, ratio: items.length ? index / items.length : 0 });
        while (offset < item.file.size) {
          if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          const end = Math.min(offset + CHUNK, item.file.size);
          try {
            offset = await putChunk(started.id, item.file.slice(offset, end), offset, controller.signal);
          } catch (reason) {
            if (!(reason instanceof ApiError) || reason.code !== 'conflict') throw reason;
            const status = await api<{ offset: number }>(`/api/uploads/${started.id}`);
            if (status.offset === offset) throw reason;
            offset = status.offset;
          }
          const ratio = (index + offset / item.file.size) / items.length;
          setUpload({ label: `${item.path} · ${index + 1} of ${items.length}`, ratio });
        }
        try {
          await api(`/api/uploads/${started.id}/finish`, {
            method: 'POST',
            body: JSON.stringify({ onConflict }),
            signal: controller.signal,
          });
          localStorage.removeItem(key);
          activeId = '';
        } catch (reason) {
          if (reason instanceof ApiError && reason.code === 'conflict' && !onConflict) {
            conflicts.push({ path: item.path, id: started.id, key });
            activeId = '';
            continue;
          }
          throw reason;
        }
      }
    } catch (reason) {
      setUpload(null);
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        if (activeId) await api(`/api/uploads/${activeId}`, { method: 'DELETE' }).catch(() => undefined);
        if (activeKey) localStorage.removeItem(activeKey);
        return;
      }
      throw reason;
    }
    setUpload(null);
    await load();
    if (conflicts.length > 0) setDialog({ type: 'conflict', items: conflicts });
  }

  async function putChunk(id: string, body: Blob, offset: number, signal: AbortSignal): Promise<number> {
    let attempt = 0;
    while (attempt < 3) {
      try {
        const response = await fetch(`/api/uploads/${id}`, {
          method: 'PUT',
          headers: { 'X-Larder-Request': '1', 'X-Larder-Offset': String(offset) },
          body,
          signal,
        });
        const data = (await response.json()) as { offset?: number; error?: string; code?: string };
        if (response.ok && typeof data.offset === 'number') return data.offset;
        throw new ApiError(data.error ?? 'The upload failed.', data.code ?? 'error', response.status);
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
        if (reason instanceof ApiError && reason.code !== 'conflict') throw reason;
        const status = await api<{ offset: number }>(`/api/uploads/${id}`);
        if (status.offset === offset + body.size) return status.offset;
        if (status.offset !== offset) throw reason instanceof ApiError ? reason : new ApiError('The upload failed.', 'conflict', 409);
        attempt += 1;
        if (attempt >= 3) throw reason instanceof ApiError ? reason : new ApiError('The upload failed.', 'error', 0);
      }
    }
    throw new ApiError('The upload failed.', 'error', 0);
  }

  async function finishConflicts(items: { path: string; id: string; key: string }[], onConflict: 'replace' | 'keep') {
    await run(async () => {
      for (const item of items) {
        await api(`/api/uploads/${item.id}/finish`, { method: 'POST', body: JSON.stringify({ onConflict }) });
        localStorage.removeItem(item.key);
      }
      setDialog(null);
    });
  }

  async function downloadZip(paths: string[]) {
    const response = await fetch('/api/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Larder-Request': '1' },
      body: JSON.stringify({ root: rootId, paths }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? 'Could not build the zip.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = paths.length === 1 ? `${baseName(paths[0] ?? 'folder')}.zip` : 'larder.zip';
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadFile(filePath: string) {
    const link = document.createElement('a');
    link.href = `/api/download?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(filePath)}`;
    link.click();
  }

  async function openMove() {
    const data = await api<{ entries: Entry[] }>(`/api/list?root=${encodeURIComponent(rootId)}&path=`);
    setDialog({
      type: 'move',
      destination: null,
      destRoot: rootId,
      open: [''],
      nodes: { '': data.entries.filter((entry) => (entry.kind === 'dir' || entry.symlinkTo === 'dir') && (hidden || !entry.hidden)) },
    });
  }

  async function openShare(filePath: string, name: string, folder = false, shareRoot = rootId) {
    const data = await api<{ shares: ShareLink[] }>('/api/shares');
    setDialog({
      type: 'share',
      path: filePath,
      name,
      password: '',
      days: '7',
      note: '',
      address: '',
      url: '',
      error: '',
      folder,
      shareRoot,
      shares: data.shares.filter((share) => share.root === shareRoot && share.path === filePath),
    });
  }

  function chooseSort(key: 'name' | 'size' | 'mtime' | 'type') {
    setSort((current) => {
      const next = { key, dir: current.key === key && current.dir === 'asc' ? 'desc' as const : 'asc' as const };
      localStorage.setItem(`larder:sort:${rootId}|${path}`, JSON.stringify(next));
      return next;
    });
  }

  function copyShareLink(url: string) {
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedLink(url);
      window.setTimeout(() => setCopiedLink((current) => (current === url ? '' : current)), 1500);
    });
  }

  async function chooseMoveRoot(id: string) {
    if (dialog?.type !== 'move' || dialog.destRoot === id) return;
    const data = await api<{ entries: Entry[] }>(`/api/list?root=${encodeURIComponent(id)}&path=`);
    setDialog({
      type: 'move',
      destination: null,
      destRoot: id,
      open: [''],
      nodes: { '': data.entries.filter((entry) => (entry.kind === 'dir' || entry.symlinkTo === 'dir') && (hidden || !entry.hidden)) },
    });
  }

  async function toggleMoveFolder(folderPath: string) {
    if (dialog?.type !== 'move') return;
    if (dialog.open.includes(folderPath)) {
      setDialog({
        ...dialog,
        open: dialog.open.filter((item) => item !== folderPath && !(folderPath && item.startsWith(`${folderPath}/`))),
      });
      return;
    }
    if (dialog.nodes[folderPath]) {
      setDialog({ ...dialog, open: [...dialog.open, folderPath] });
      return;
    }
    const data = await api<{ entries: Entry[] }>(`/api/list?root=${encodeURIComponent(dialog.destRoot)}&path=${encodeURIComponent(folderPath)}`);
    const dirs = data.entries.filter((entry) => (entry.kind === 'dir' || entry.symlinkTo === 'dir') && (hidden || !entry.hidden));
    setDialog((current) => {
      if (current?.type !== 'move') return current;
      return {
        ...current,
        open: current.open.includes(folderPath) ? current.open : [...current.open, folderPath],
        nodes: { ...current.nodes, [folderPath]: dirs },
      };
    });
  }

  function moveProblem(destination: string, destRoot: string): string | null {
    if (destRoot !== rootId) return null;
    if (destination === path) return 'These items are already in this folder.';
    for (const item of selected) {
      if (destination === item || destination.startsWith(`${item}/`)) return 'That folder is inside the folder you are moving.';
    }
    return null;
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      if (menu) {
        if (event.key === 'Escape') setMenu(null);
        return;
      }
      if (event.key === 'Escape') {
        setDialog(null);
        setClipboard(null);
        setSelected([]);
      } else if (event.altKey && event.key === 'Enter' && one && !trash) {
        event.preventDefault();
        setPreview(one.path);
      } else if (event.key === 'Backspace') {
        if (path) setPath(parentPath(path));
      } else if (event.key === 'Enter' && one) openRow(one);
      else if (event.key === 'F2' && canEdit && one) setDialog({ type: 'rename', value: one.name });
      else if (event.key === 'Delete' && canEdit && selected.length) void askDelete();
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelected(rows.map((row) => row.path));
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selected.length) {
        setClipboard({ mode: 'copy', paths: selected });
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'x' && canEdit && selected.length) {
        setClipboard({ mode: 'cut', paths: selected });
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v' && canEdit && clipboard) {
        void paste();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = Math.max(0, rows.findIndex((row) => row.path === selected[0]));
        const next = rows[event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1)];
        if (next) setSelected([next.path]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function askDelete() {
    if (selected.length > 1) {
      setDialog({ type: 'delete', count: selected.length, typed: '', strong: true });
      return;
    }
    const row = rows.find((item) => item.path === selected[0]);
    if (row && (row.kind === 'dir' || row.symlinkTo === 'dir')) {
      const listed = await api<{ entries: Entry[] }>(`/api/list?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(row.path)}`);
      setDialog({ type: 'delete', count: 1, typed: '', strong: listed.entries.length > 0 });
      return;
    }
    setDialog({ type: 'delete', count: 1, typed: '', strong: false });
  }

  async function paste() {
    if (!clipboard) return;
    await run(async () => {
      if (clipboard.mode === 'cut') {
        await api('/api/move', { method: 'POST', body: JSON.stringify({ root: rootId, paths: clipboard.paths, to: path }) });
        setClipboard(null);
      } else {
        await api('/api/copy', { method: 'POST', body: JSON.stringify({ root: rootId, paths: clipboard.paths, to: path, onConflict: 'keep' }) });
      }
    });
  }

  useEffect(() => {
    const h = history.current;
    if (rootSeen.current !== rootId) {
      rootSeen.current = rootId;
      h.entries = [path];
      h.index = 0;
      h.quiet = false;
      setNav({ back: false, forward: false });
      return;
    }
    if (h.quiet) {
      h.quiet = false;
      setNav({ back: h.index > 0, forward: h.index < h.entries.length - 1 });
      return;
    }
    if (h.entries[h.index] === path) return;
    h.entries = [...h.entries.slice(0, h.index + 1), path].slice(-40);
    h.index = h.entries.length - 1;
    setNav({ back: h.index > 0, forward: false });
  }, [path, rootId]);

  function travel(delta: number) {
    const h = history.current;
    const next = h.index + delta;
    if (next < 0 || next >= h.entries.length) return;
    h.index = next;
    h.quiet = true;
    setNav({ back: h.index > 0, forward: h.index < h.entries.length - 1 });
    setPath(h.entries[next] ?? '');
  }

  const crumbs = path ? path.split('/') : [];

  function contextMenu() {
    if (!menu) return null;
    const close = () => setMenu(null);
    if (menu.kind === 'trash') {
      const id = menu.id;
      return (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={close}
          items={menuItems([
            [
              canEdit && id
                ? {
                    icon: 'restore',
                    label: 'Restore',
                    onSelect: () => void run(() => api('/api/trash/restore', { method: 'POST', body: JSON.stringify({ root: rootId, id }) }).then(() => undefined)),
                  }
                : null,
            ],
          ])}
        />
      );
    }
    if (menu.kind === 'blank') {
      return (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={close}
          items={menuItems([
            trash
              ? [
                  canEdit && trashItems.length
                    ? {
                        icon: 'trash',
                        label: 'Empty trash',
                        onSelect: () => setDialog({ type: 'empty', count: trashTotal, typed: '' }),
                      }
                    : null,
                ]
              : [
                  canEdit ? { icon: 'folder', label: 'New folder', onSelect: () => setDialog({ type: 'folder', value: '' }) } : null,
                  canEdit ? { icon: 'file', label: 'New file', onSelect: () => setDialog({ type: 'file', value: '' }) } : null,
                  canEdit ? { icon: 'upload', label: 'Upload', onSelect: () => fileInput.current?.click() } : null,
                  canEdit && clipboard ? { icon: 'paste', label: 'Paste', shortcut: 'Ctrl+V', onSelect: () => void paste() } : null,
                  { icon: 'pin', label: pinned ? 'Unpin this folder' : 'Pin this folder', onSelect: () => void onFavorites() },
                ],
          ])}
        />
      );
    }
    const acted = menu.path && selected.includes(menu.path) ? selected : menu.path ? [menu.path] : [];
    const single = acted.length === 1 ? rows.find((row) => row.path === acted[0]) : undefined;
    const isDir = !!single && (single.kind === 'dir' || single.symlinkTo === 'dir');
    const icons: ContextIcon[] | undefined = canEdit
      ? [
          { icon: 'cut', label: 'Cut', disabled: !acted.length, onSelect: () => setClipboard({ mode: 'cut', paths: acted }) },
          { icon: 'copy', label: 'Copy', disabled: !acted.length, onSelect: () => setClipboard({ mode: 'copy', paths: acted }) },
          { icon: 'paste', label: 'Paste', disabled: !clipboard, onSelect: () => void paste() },
          { icon: 'rename', label: 'Rename', disabled: !single, onSelect: () => single && setDialog({ type: 'rename', value: single.name }) },
          { icon: 'trash', label: 'Delete', disabled: !acted.length, onSelect: () => void askDelete() },
        ]
      : undefined;
    const items: (ContextItem | 'sep')[] = menuItems([
      [
        single ? { icon: 'open', label: 'Open', shortcut: 'Enter', onSelect: () => openRow(single) } : null,
        single && !isDir ? { icon: 'download', label: 'Download', onSelect: () => downloadFile(single.path) } : null,
        single ? { icon: 'link', label: 'Share', onSelect: () => void openShare(single.path, single.name, isDir) } : null,
        acted.length > 1 || isDir
          ? {
              icon: 'archive',
              label: 'Download zip',
              onSelect: () => void downloadZip(acted).catch((reason: Error) => setBanner(reason.message)),
            }
          : null,
        canEdit && (isDir || acted.length > 1)
          ? {
              icon: 'archive',
              label: 'Zip',
              onSelect: () => void run(() => api('/api/zip', { method: 'POST', body: JSON.stringify({ root: rootId, paths: acted, save: true }) }).then(() => undefined)),
            }
          : null,
        canEdit && single?.name.toLowerCase().endsWith('.zip')
          ? {
              icon: 'extract',
              label: 'Extract',
              onSelect: () => void run(() => api('/api/extract', { method: 'POST', body: JSON.stringify({ root: rootId, path: single.path }) }).then(() => undefined)),
            }
          : null,
      ],
      [
        single && isDir
          ? {
              icon: 'pin',
              label: favorites.some((item) => item.root === rootId && item.path === single.path) ? 'Unpin' : 'Pin to favorites',
              onSelect: () => void onFavorites(single.path),
            }
          : null,
        canEdit && acted.length
          ? {
              icon: 'copy',
              label: 'Duplicate',
              onSelect: () =>
                void run(() =>
                  api('/api/copy', {
                    method: 'POST',
                    body: JSON.stringify({ root: rootId, paths: acted, to: path, onConflict: 'keep', duplicate: true }),
                  }).then(() => undefined),
                ),
            }
          : null,
        canEdit && acted.length
          ? {
              icon: 'folder',
              label: 'Move',
              onSelect: () => void openMove(),
            }
          : null,
      ],
      [single ? { icon: 'properties', label: 'Properties', shortcut: 'Alt+Enter', onSelect: () => setPreview(single.path) } : null],
    ]);
    return <ContextMenu x={menu.x} y={menu.y} icons={icons} items={items} onClose={close} />;
  }

  function movePlace(destination: string, destRoot: string) {
    const name = places.find((place) => place.id === destRoot)?.name ?? rootName;
    return destination ? `${name} › ${destination.split('/').join(' › ')}` : name;
  }

  function moveTree(folderPath: string, name: string, depth: number): ReactNode {
    if (dialog?.type !== 'move') return null;
    const children = dialog.nodes[folderPath];
    const expanded = dialog.open.includes(folderPath);
    const blocked = dialog.destRoot === rootId && folderPath !== '' && selected.includes(folderPath);
    const chosen = dialog.destination === folderPath;
    return (
      <div key={folderPath || 'root'}>
        <div
          className={`flex items-center rounded-control ${chosen ? 'bg-select' : blocked ? '' : 'hover:bg-hover'} ${blocked ? 'opacity-40' : ''}`}
          style={{ paddingLeft: 4 + depth * 16 }}
        >
          <button
            className="grid size-7 shrink-0 place-items-center text-muted"
            type="button"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            disabled={blocked || (children != null && children.length === 0)}
            onClick={() => void toggleMoveFolder(folderPath)}
          >
            <span className={`inline-block text-xs ${expanded ? 'rotate-90' : ''} ${children != null && children.length === 0 ? 'opacity-0' : ''}`}>›</span>
          </button>
          <button
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left"
            type="button"
            disabled={blocked}
            onClick={() => {
              if (dialog.type !== 'move') return;
              setDialog({ ...dialog, destination: folderPath });
            }}
          >
            <Icon name={folderPath === '' && dialog.destRoot.startsWith('home:') ? 'home' : 'folder'} size={16} />
            <span className="truncate">{name}</span>
          </button>
        </div>
        {expanded &&
          children?.map((dir) => moveTree(joinPath(folderPath, dir.name), dir.name, depth + 1))}
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1"
      onDragOver={(event) => {
        if (internalDrag || !canEdit) return;
        event.preventDefault();
        setDropOver(true);
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(event) => {
        if (internalDrag || !canEdit) return;
        event.preventDefault();
        setDropOver(false);
        void fromDataTransfer(event.dataTransfer).then((dropped) => uploadItems(dropped.files, dropped.directories)).catch((reason: Error) => setBanner(reason.message));
      }}
    >
      <div
        className="flex min-w-0 flex-1 flex-col"
        onPaste={(event) => {
          if (!canEdit) return;
          const target = event.target as HTMLElement | null;
          if (target?.closest('input, textarea')) return;
          const image = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'))?.getAsFile();
          if (!image) return;
          event.preventDefault();
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
          const named = new File([image], `Pasted image ${stamp}.png`, { type: image.type || 'image/png' });
          void uploadItems([{ file: named, path: named.name }], []).catch((reason: Error) => setBanner(reason.message));
        }}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest('[data-row], input, textarea')) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, kind: 'blank' });
        }}
      >
        <div className="flex flex-wrap items-center gap-1 px-2 py-1">
          {canEdit && (
            <div className="relative">
              <Cmd icon="new" label="New" onClick={() => setNewOpen((open) => !open)} />
              {newOpen && (
                <div className="absolute left-0 z-20 mt-1 w-40 rounded-control bg-surface p-1 shadow-lg">
                  <button className="nav-item" type="button" onClick={() => { setNewOpen(false); setDialog({ type: 'folder', value: '' }); }}>
                    <Icon name="folder" size={16} />
                    New folder
                  </button>
                  <button className="nav-item" type="button" onClick={() => { setNewOpen(false); setDialog({ type: 'file', value: '' }); }}>
                    <Icon name="file" size={16} />
                    New file
                  </button>
                </div>
              )}
            </div>
          )}
          {canEdit && <Cmd icon="upload" label="Upload" onClick={() => fileInput.current?.click()} />}
          {canEdit && <Cmd icon="folder" label="Upload folder" onClick={() => folderInput.current?.click()} />}
          <input
            ref={fileInput}
            hidden
            type="file"
            multiple
            onChange={(event) => {
              const picked = [...(event.target.files ?? [])];
              event.target.value = '';
              const files = picked.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
              const directories = folderPaths(files.map((item) => item.path));
              void uploadItems(files, directories).catch((reason: Error) => setBanner(reason.message));
            }}
          />
          <input
            ref={folderInput}
            hidden
            type="file"
            multiple
            // The folder picker is a browser extension of the file input.
            {...{ webkitdirectory: '', directory: '' }}
            onChange={(event) => {
              const picked = [...(event.target.files ?? [])];
              event.target.value = '';
              const files = picked.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
              void uploadItems(files, folderPaths(files.map((item) => item.path))).catch((reason: Error) => setBanner(reason.message));
            }}
          />
          {canEdit && (
            <>
              <Cmd icon="cut" label="Cut" disabled={!selected.length} onClick={() => setClipboard({ mode: 'cut', paths: selected })} />
              <Cmd icon="copy" label="Copy" disabled={!selected.length} onClick={() => setClipboard({ mode: 'copy', paths: selected })} />
              <Cmd icon="paste" label="Paste" disabled={!clipboard} onClick={() => void paste()} />
              <Cmd icon="rename" label="Rename" disabled={!one} onClick={() => one && setDialog({ type: 'rename', value: one.name })} />
              <Cmd icon="trash" label="Delete" disabled={!selected.length} onClick={() => void askDelete()} />
              <Cmd
                icon="copy"
                label="Duplicate"
                disabled={!selected.length}
                onClick={() =>
                  void run(() =>
                    api('/api/copy', {
                      method: 'POST',
                      body: JSON.stringify({ root: rootId, paths: selected, to: path, onConflict: 'keep', duplicate: true }),
                    }).then(() => undefined),
                  )
                }
              />
              <Cmd
                icon="folder"
                label="Move"
                disabled={!selected.length}
                onClick={() => void openMove()}
              />
            </>
          )}
          {selected.length === 1 && one && one.kind !== 'dir' && one.symlinkTo !== 'dir' && (
            <Cmd icon="download" label="Download" href={`/api/download?root=${encodeURIComponent(one.rootId ?? rootId)}&path=${encodeURIComponent(one.path)}`} />
          )}
          {(selected.length > 1 || (one && (one.kind === 'dir' || one.symlinkTo === 'dir'))) && (
            <Cmd icon="archive" label="Download zip" onClick={() => void downloadZip(selected.length ? selected : [path]).catch((reason: Error) => setBanner(reason.message))} />
          )}
          {canEdit && (selected.length > 1 || (one && (one.kind === 'dir' || one.symlinkTo === 'dir'))) && (
            <Cmd
              icon="archive"
              label="Zip"
              onClick={() => void run(() => api('/api/zip', { method: 'POST', body: JSON.stringify({ root: rootId, paths: selected, save: true }) }).then(() => undefined))}
            />
          )}
          {canEdit && one?.name.toLowerCase().endsWith('.zip') && (
            <Cmd icon="extract" label="Extract" onClick={() => void run(() => api('/api/extract', { method: 'POST', body: JSON.stringify({ root: rootId, path: one.path }) }).then(() => undefined))} />
          )}
          <Cmd icon="pin" label={pinned ? 'Unpin' : 'Pin'} onClick={() => void onFavorites()} />
          <button className={`cmd ${hidden ? 'bg-select' : ''}`} type="button" onClick={() => setHidden((value) => !value)}>
            <Icon name="eye" size={16} />
            <span>Hidden</span>
          </button>
          <button className={`cmd ${icons ? 'bg-select' : ''}`} type="button" onClick={() => setIcons((value) => !value)}>
            <Icon name="image" size={16} />
            <span>Icons</span>
          </button>
          {search && <Cmd icon="search" label="Clear search" onClick={() => setSearch(null)} />}
        </div>
        <div className="flex items-center gap-1 px-2 pb-2">
          <button className="cmd px-2" type="button" disabled={!nav.back} onClick={() => travel(-1)} aria-label="Back">
            <Icon name="back" size={16} />
          </button>
          <button className="cmd px-2" type="button" disabled={!nav.forward} onClick={() => travel(1)} aria-label="Forward">
            <Icon name="forward" size={16} />
          </button>
          <button className="cmd px-2" type="button" disabled={!path} onClick={() => setPath(parentPath(path))} aria-label="Up">
            <Icon name="up" size={16} />
          </button>
          {editingPath ? (
            <form
              className="address"
              onSubmit={(event) => {
                event.preventDefault();
                setEditingPath(false);
                setPath(pathDraft.replace(/^\/+|\/+$/g, ''));
              }}
            >
              <input className="w-full bg-transparent font-mono outline-none" value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} onBlur={() => setEditingPath(false)} />
            </form>
          ) : (
            <button
              className="address min-w-0 truncate text-left"
              type="button"
              onClick={() => {
                setPathDraft(path);
                setEditingPath(true);
              }}
            >
              <span>{rootName}</span>
              {crumbs.map((crumb, index) => (
                <span key={crumb + index}>
                  <span className="px-1 text-muted">›</span>
                  <span
                    className="hover:underline"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPath(crumbs.slice(0, index + 1).join('/'));
                    }}
                  >
                    {crumb}
                  </span>
                </span>
              ))}
            </button>
          )}
          <input className="field w-36" placeholder="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} />
          <form
            className="flex flex-wrap items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const params = new URLSearchParams({ root: rootId, path: searchAll ? '' : path, q: searchText, hidden: hidden ? '1' : '0' });
                if (searchAll) params.set('all', '1');
                if (searchType !== 'any') params.set('type', searchType);
                if (searchSize === 'over1') params.set('min', String(1024 * 1024));
                if (searchSize === 'over100') params.set('min', String(100 * 1024 * 1024));
                if (searchSize === 'under1') params.set('max', String(1024 * 1024));
                if (searchWhen !== 'any') {
                  const day = 24 * 60 * 60 * 1000;
                  const span = searchWhen === 'today' ? day : searchWhen === 'week' ? 7 * day : 30 * day;
                  params.set('after', String(Date.now() - span));
                }
                const data = await api<{ results: { path: string; kind: Entry['kind']; symlinkTo?: 'file' | 'dir'; outside?: boolean; size: number | null; mtime: number | null; root?: string; rootName?: string }[] }>(
                  `/api/search?${params.toString()}`,
                );
                const label = [searchText, searchAll ? 'all folders' : '', searchType !== 'any' ? searchType : '', searchSize !== 'any' ? searchSize : '', searchWhen !== 'any' ? searchWhen : ''].filter(Boolean).join(' · ');
                setSearch({
                  q: label || 'these files',
                  rows: data.results.map((result) => ({
                    name: baseName(result.path),
                    path: result.path,
                    rootId: result.root,
                    place: result.rootName,
                    kind: result.kind,
                    symlinkTo: result.symlinkTo,
                    outside: result.outside,
                    size: result.size,
                    mtime: result.mtime,
                    hidden: baseName(result.path).startsWith('.'),
                    mode: null,
                  })),
                });
              });
            }}
          >
            <span className="relative">
              <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2">
                <Icon name="search" size={16} />
              </span>
              <input className="field w-40 pl-8" placeholder="Search" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
            </span>
          <select className="field w-28" value={searchType} aria-label="File type" onChange={(event) => setSearchType(event.target.value)}>
            <option value="any">Any type</option>
            <option value="folder">Folders</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
            <option value="audio">Audio</option>
            <option value="text">Text</option>
            <option value="archive">Archives</option>
          </select>
          <select className="field w-28" value={searchSize} aria-label="Size" onChange={(event) => setSearchSize(event.target.value)}>
            <option value="any">Any size</option>
            <option value="under1">Under 1 MB</option>
            <option value="over1">Over 1 MB</option>
            <option value="over100">Over 100 MB</option>
          </select>
          <select className="field w-28" value={searchWhen} aria-label="Modified" onChange={(event) => setSearchWhen(event.target.value)}>
            <option value="any">Any date</option>
            <option value="today">Today</option>
            <option value="week">Past 7 days</option>
            <option value="month">Past 30 days</option>
          </select>
            <label className="flex items-center gap-1.5 text-sm text-muted">
              <input type="checkbox" checked={searchAll} onChange={(event) => setSearchAll(event.target.checked)} />
              All folders
            </label>
            <button className="btn" type="submit">Search</button>
          </form>
        </div>
        {banner && <p className="border-b border-danger/40 bg-danger/15 px-3 py-2">{banner}</p>}
        {search && (
          <p className="px-3 py-2 text-muted">
            Results for &ldquo;{search.q}&rdquo;. {search.rows.length === 500 ? 'Showing 500. Narrow the name.' : ''}
          </p>
        )}
        {dropOver && <p className="px-3 py-6 text-center text-accent">Drop to upload into {path || rootName}</p>}
        {!icons && (
        <div className="grid grid-cols-[minmax(0,1fr)_72px_120px_64px] border-b border-line px-3 py-1 text-xs text-muted">
          {(['name', 'size', 'mtime', 'type'] as const).map((key) => (
            <button
              key={key}
              className="text-left"
              type="button"
              onClick={() => chooseSort(key)}
            >
              {key === 'mtime' ? 'Modified' : key[0]!.toUpperCase() + key.slice(1)}
              {sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
            </button>
          ))}
        </div>
        )}
        <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
          {trash ? (
            <ul>
              {trashItems.map((item) => (
                <li
                  key={item.id}
                  data-row
                  className="flex items-center justify-between gap-3 border-b border-line px-3 py-2"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenu({ x: event.clientX, y: event.clientY, kind: 'trash', id: item.id });
                  }}
                >
                  <span>
                    <span className="block">{item.name}</span>
                    <span className="font-mono text-xs text-muted">{item.originalPath} · {item.deletedBy}</span>
                  </span>
                  {canEdit && (
                    <button className="btn" type="button" onClick={() => void run(() => api('/api/trash/restore', { method: 'POST', body: JSON.stringify({ root: rootId, id: item.id }) }).then(() => undefined))}>
                      Restore
                    </button>
                  )}
                </li>
              ))}
              {trashItems.length === 0 && <li className="px-3 py-6 text-muted">Trash is empty.</li>}
              {trashItems.length < trashTotal && (
                <li className="px-3 py-2">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      void api<{ items: TrashItem[]; total?: number }>(`/api/trash?root=${encodeURIComponent(rootId)}&offset=${trashItems.length}&limit=100`).then((data) => {
                        setTrashItems((current) => [...current, ...data.items]);
                        if (data.total != null) setTrashTotal(data.total);
                      });
                    }}
                  >
                    Older
                  </button>
                </li>
              )}
            </ul>
          ) : rows.length === 0 ? (
            <p className="px-3 py-6 text-muted">{filter || search ? 'Nothing in this folder matches.' : 'This folder is empty.'}</p>
          ) : icons ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 p-3">
              {rows.map((row) => {
                const active = selected.includes(row.path);
                const picture = (isImageName(row.name) || isVideoName(row.name)) && !row.outside;
                return (
                  <button
                    key={`${row.rootId ?? rootId}|${row.path}`}
                    type="button"
                    data-row
                    className={`flex flex-col gap-2 rounded-control border p-2 text-left ${active ? 'border-accent bg-select' : 'border-line hover:bg-hover'}`}
                    onClick={(event) => choose(row, event)}
                    onDoubleClick={() => openRow(row)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!selected.includes(row.path)) {
                        setSelected([row.path]);
                        setAnchor(row.path);
                      }
                      setMenu({ x: event.clientX, y: event.clientY, kind: 'row', path: row.path });
                    }}
                  >
                    <span className="relative grid aspect-square place-items-center overflow-hidden rounded-control bg-page">
                      <Icon name={iconFor(row.name, row.kind, row.symlinkTo)} size={32} />
                      {picture && (
                        <img
                          alt=""
                          className="absolute inset-0 size-full object-cover"
                          src={`/api/thumb?root=${encodeURIComponent(row.rootId ?? rootId)}&path=${encodeURIComponent(row.path)}`}
                          onError={(event) => event.currentTarget.remove()}
                        />
                      )}
                    </span>
                    <span className="truncate text-sm">{row.name}</span>
                    {(isAudioName(row.name) || isVideoName(row.name)) && !row.outside && <MediaLength root={row.rootId ?? rootId} path={row.path} />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtual) => {
                const row = rows[virtual.index]!;
                const active = selected.includes(row.path);
                return (
                  <div
                    key={`${row.rootId ?? rootId}|${row.path}`}
                    draggable={canEdit}
                    onDragStart={() => {
                      internalDrag = true;
                      const paths = selected.includes(row.path) ? selected : [row.path];
                      setSelected(paths);
                    }}
                    onDragEnd={() => {
                      internalDrag = false;
                    }}
                    onDragOver={(event) => {
                      if ((row.kind === 'dir' || row.symlinkTo === 'dir') && internalDrag) event.preventDefault();
                    }}
                    onDrop={(event) => {
                      if (!internalDrag || (row.kind !== 'dir' && row.symlinkTo !== 'dir')) return;
                      event.preventDefault();
                      event.stopPropagation();
                      const paths = selected.includes(row.path) ? selected.filter((item) => item !== row.path) : selected;
                      internalDrag = false;
                      void run(() => api('/api/move', { method: 'POST', body: JSON.stringify({ root: rootId, paths, to: row.path }) }).then(() => undefined));
                    }}
                    onClick={(event) => choose(row, event)}
                    onDoubleClick={() => openRow(row)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!selected.includes(row.path)) {
                        setSelected([row.path]);
                        setAnchor(row.path);
                      }
                      setMenu({ x: event.clientX, y: event.clientY, kind: 'row', path: row.path });
                    }}
                    data-row
                    className={`absolute right-0 left-0 grid h-10 grid-cols-[minmax(0,1fr)_72px_120px_64px] items-center px-3 ${active ? 'bg-select' : 'hover:bg-hover'}`}
                    style={{ top: virtual.start }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="relative grid size-5 place-items-center">
                        <Icon name={iconFor(row.name, row.kind, row.symlinkTo)} />
                        {row.kind === 'symlink' && (
                          <span className="absolute -right-1.5 -bottom-1.5">
                            <Icon name="link" size={12} />
                          </span>
                        )}
                        {(isImageName(row.name) || isVideoName(row.name)) && !row.outside && (
                          <img
                            alt=""
                            className="absolute inset-0 size-5 object-cover"
                            src={`/api/thumb?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(row.path)}`}
                            onError={(event) => event.currentTarget.remove()}
                          />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-baseline gap-1">
                          <span className="truncate">{row.name}</span>
                          {(isAudioName(row.name) || isVideoName(row.name)) && !row.outside && <MediaLength root={row.rootId ?? rootId} path={row.path} inline />}
                        </span>
                        {search && <span className="block truncate font-mono text-xs text-muted">{row.place ? `${row.place} / ${row.path}` : row.path}</span>}
                      </span>
                    </span>
                    <span className="font-mono text-xs text-muted">{formatBytes(row.size)}</span>
                    <span className="font-mono text-xs text-muted" title={row.mtime ? new Date(row.mtime).toISOString() : ''}>
                      {formatDate(row.mtime)}
                    </span>
                    <span className="font-mono text-xs text-muted">{row.kind === 'dir' || row.symlinkTo === 'dir' ? 'Folder' : row.name.includes('.') ? row.name.split('.').pop() : ''}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {one && !trash && (
          <div className="flex items-center gap-3 border-t border-line px-3 py-2 font-mono text-xs text-muted">
            <span>{one.kind}</span>
            <span>{formatBytes(one.size)}</span>
            <span>{formatDate(one.mtime)}</span>
            <span>{one.mode}</span>
            <button className="btn" type="button" onClick={() => { setPreviewRoot(one.rootId ?? rootId); setPreview(one.path); }}>
              Info
            </button>
            <button className="btn" type="button" onClick={() => void openShare(one.path, one.name, one.kind === 'dir' || one.symlinkTo === 'dir', one.rootId ?? rootId)}>
              Share
            </button>
          </div>
        )}
        {upload && (
          <div className="border-t border-line px-3 py-2">
            <div className="mb-1 flex justify-between text-xs">
              <span>{upload.label}</span>
              <button className="icon-btn" type="button" onClick={() => abortUpload.current?.abort()}>
                Cancel
              </button>
            </div>
            <div className="h-1 bg-line">
              <div className="h-1 bg-accent" style={{ width: `${Math.round(upload.ratio * 100)}%` }} />
            </div>
          </div>
        )}
        {trash && canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
            {admin ? (
              <label className="flex items-center gap-2 text-sm text-muted">
                Keep trash
                <select
                  className="field w-44"
                  value={trashDays ?? ''}
                  onChange={(event) => {
                    const days = event.target.value ? Number(event.target.value) : null;
                    void api('/api/trash/policy', { method: 'PUT', body: JSON.stringify({ days }) }).then(() => void load());
                  }}
                >
                  <option value="">Until emptied</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </select>
              </label>
            ) : (
              trashDays != null && <span className="text-sm text-muted">Items older than {trashDays} days are removed.</span>
            )}
            {trashItems.length > 0 && (
              <button className="btn" type="button" onClick={() => setDialog({ type: 'empty', count: trashTotal, typed: '' })}>
                Empty trash
              </button>
            )}
          </div>
        )}
      </div>
      {contextMenu()}
      {preview && (
        <div className="fixed inset-0 z-20 bg-page md:static md:inset-auto">
          <Preview
            root={previewRoot}
            path={preview}
            entry={previewEntry}
            canEdit={canEdit}
            onClose={() => setPreview(null)}
            onSaved={() => void load()}
          />
        </div>
      )}
      {dialog?.type === 'folder' || dialog?.type === 'file' || dialog?.type === 'rename' ? (
        <Dialog title={dialog.type === 'rename' ? 'Rename' : dialog.type === 'folder' ? 'New folder' : 'New file'} onClose={() => setDialog(null)}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const value = dialog.value.trim();
              void run(async () => {
                if (dialog.type === 'rename' && one) {
                  await api('/api/rename', { method: 'POST', body: JSON.stringify({ root: rootId, path: one.path, name: value }) });
                } else if (dialog.type === 'folder') {
                  await api('/api/mkdir', { method: 'POST', body: JSON.stringify({ root: rootId, path, name: value }) });
                } else {
                  await api('/api/create-file', { method: 'POST', body: JSON.stringify({ root: rootId, path, name: value }) });
                }
                setDialog(null);
              });
            }}
          >
            <input className="field" value={dialog.value} onChange={(event) => setDialog({ ...dialog, value: event.target.value })} />
            <button className="btn btn-primary" type="submit">
              {dialog.type === 'rename' ? 'Save' : 'Create'}
            </button>
          </form>
        </Dialog>
      ) : null}
      {dialog?.type === 'delete' && (
        <Dialog title={dialog.count === 1 ? 'Delete 1 item' : `Delete ${dialog.count} items`} onClose={() => setDialog(null)}>
          <p className="mb-3 text-muted">They can be restored from Trash.</p>
          {dialog.strong && (
            <input className="field mb-3" placeholder={`Type ${dialog.count}`} value={dialog.typed} onChange={(event) => setDialog({ ...dialog, typed: event.target.value })} />
          )}
          <button
            className="btn btn-danger"
            type="button"
            disabled={dialog.strong && dialog.typed !== String(dialog.count)}
            onClick={() =>
              void run(async () => {
                await api('/api/delete', { method: 'POST', body: JSON.stringify({ root: rootId, paths: selected }) });
                setDialog(null);
                setSelected([]);
              })
            }
          >
            Delete
          </button>
        </Dialog>
      )}
      {dialog?.type === 'empty' && (
        <Dialog title="Empty trash" onClose={() => setDialog(null)}>
          <p className="mb-3">This permanently deletes {dialog.count} items.</p>
          <input className="field mb-3" placeholder={`Type ${dialog.count}`} value={dialog.typed} onChange={(event) => setDialog({ ...dialog, typed: event.target.value })} />
          <button
            className="btn btn-danger"
            type="button"
            disabled={dialog.typed !== String(dialog.count)}
            onClick={() =>
              void run(async () => {
                await api('/api/trash/empty', { method: 'POST', body: JSON.stringify({ root: rootId }) });
                setDialog(null);
              })
            }
          >
            Empty trash
          </button>
        </Dialog>
      )}
      {dialog?.type === 'move' && (
        <Dialog title="Move or copy" wide onClose={() => setDialog(null)}>
          <p className="mb-3 truncate text-sm text-muted">{selected.length === 1 ? baseName(selected[0] ?? '') : `${selected.length} items`}</p>
          {places.filter((place) => place.access === 'edit').length > 1 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {places
                .filter((place) => place.access === 'edit')
                .map((place) => (
                  <button key={place.id} className={dialog.destRoot === place.id ? 'btn btn-primary' : 'btn'} type="button" onClick={() => void chooseMoveRoot(place.id)}>
                    {place.name}
                  </button>
                ))}
            </div>
          )}
          <div className="max-h-72 overflow-auto rounded-control border border-split bg-page p-1">
            {moveTree('', places.find((place) => place.id === dialog.destRoot)?.name ?? rootName, 0)}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-xs text-muted">
              {dialog.destination == null
                ? 'Choose a folder.'
                : (moveProblem(dialog.destination, dialog.destRoot) ?? `To ${movePlace(dialog.destination, dialog.destRoot)}`)}
            </p>
            <div className="flex shrink-0 gap-2">
              <button className="btn" type="button" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={dialog.destination == null || moveProblem(dialog.destination, dialog.destRoot) != null}
                onClick={() =>
                  void run(async () => {
                    if (dialog.destination == null) return;
                    await api('/api/copy', {
                      method: 'POST',
                      body: JSON.stringify({ root: rootId, paths: selected, to: dialog.destination, toRoot: dialog.destRoot }),
                    });
                    setDialog(null);
                  })
                }
              >
                Copy
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={dialog.destination == null || moveProblem(dialog.destination, dialog.destRoot) != null}
                onClick={() =>
                  void run(async () => {
                    if (dialog.destination == null) return;
                    await api('/api/move', {
                      method: 'POST',
                      body: JSON.stringify({ root: rootId, paths: selected, to: dialog.destination, toRoot: dialog.destRoot }),
                    });
                    setDialog(null);
                  })
                }
              >
                Move
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {dialog?.type === 'conflict' && (
        <Dialog title="Some names are already here" onClose={() => setDialog(null)}>
          <ul className="mb-3 max-h-40 overflow-auto font-mono text-xs">
            {dialog.items.map((item) => (
              <li key={item.path}>{item.path}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button className="btn" type="button" onClick={() => void finishConflicts(dialog.items, 'replace')}>
              Replace
            </button>
            <button className="btn" type="button" onClick={() => void finishConflicts(dialog.items, 'keep')}>
              Keep both
            </button>
          </div>
        </Dialog>
      )}
      {dialog?.type === 'share' && (
        <Dialog title={`Share ${dialog.name}`} wide onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-3">
            {dialog.folder && <p className="text-sm text-muted">The link downloads a zip of this folder.</p>}
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Address</span>
              <input className="field" placeholder="Optional, such as saturday" maxLength={32} value={dialog.address} onChange={(event) => setDialog({ ...dialog, address: event.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Note</span>
              <input className="field" placeholder="Optional" maxLength={200} value={dialog.note} onChange={(event) => setDialog({ ...dialog, note: event.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Password</span>
              <input className="field" type="password" autoComplete="new-password" placeholder="Optional" value={dialog.password} onChange={(event) => setDialog({ ...dialog, password: event.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Expires</span>
              <select className="field" value={dialog.days} onChange={(event) => setDialog({ ...dialog, days: event.target.value })}>
                <option value="">Never</option>
                <option value="1">1 day</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
              </select>
            </label>
            {dialog.error && <p className="text-sm text-danger">{dialog.error}</p>}
            {dialog.url && (
              <div>
                <span className="mb-1 block text-sm text-muted">Link</span>
                <div className="flex items-center gap-2">
                  <input className="field" readOnly value={dialog.url} onFocus={(event) => event.currentTarget.select()} />
                  <button
                    className={`icon-btn grid size-8 shrink-0 place-items-center rounded-control ${copiedLink === dialog.url ? 'bg-select' : 'bg-hover'}`}
                    type="button"
                    aria-label={copiedLink === dialog.url ? 'Copied' : 'Copy link'}
                    title={copiedLink === dialog.url ? 'Copied' : 'Copy link'}
                    onClick={() => copyShareLink(dialog.url)}
                  >
                    <Icon name="copy" size={16} />
                  </button>
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn" type="button" onClick={() => setDialog(null)}>Close</button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() =>
                  void (async () => {
                    try {
                      const created = await api<ShareLink>('/api/shares', {
                        method: 'POST',
                        body: JSON.stringify({
                          root: dialog.shareRoot,
                          path: dialog.path,
                          password: dialog.password,
                          days: dialog.days ? Number(dialog.days) : null,
                          note: dialog.note,
                          address: dialog.address,
                        }),
                      });
                      setDialog({
                        ...dialog,
                        url: `${window.location.origin}/s/${created.id}`,
                        error: '',
                        password: '',
                        shares: [created, ...dialog.shares.filter((share) => share.id !== created.id)],
                      });
                    } catch (reason) {
                      setDialog({ ...dialog, error: reason instanceof Error ? reason.message : 'Could not create the link.' });
                    }
                  })()
                }
              >
                Create link
              </button>
            </div>
            {dialog.shares.length > 0 && (
              <ul className="flex flex-col gap-2 border-t border-line pt-3">
                {dialog.shares.map((share) => (
                  <li key={share.id}>
                    <ShareActions
                      share={share}
                      onChange={(next) => {
                        if (dialog.type !== 'share') return;
                        setDialog({ ...dialog, shares: dialog.shares.map((item) => (item.id === next.id ? next : item)) });
                      }}
                      onRevoke={() => {
                        void api(`/api/shares/${share.id}`, { method: 'DELETE' }).then(() => {
                          if (dialog.type !== 'share') return;
                          setDialog({ ...dialog, shares: dialog.shares.filter((item) => item.id !== share.id) });
                        });
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}

function MediaLength({ root, path, inline = false }: { root: string; path: string; inline?: boolean }) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    let stop = false;
    void api<{ seconds: number }>(`/api/duration?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
      .then((data) => {
        if (!stop) setLabel(formatDuration(data.seconds));
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [root, path]);
  if (!label) return null;
  if (inline) return <span className="shrink-0 font-mono text-xs text-muted">· {label}</span>;
  return <span className="font-mono text-xs text-muted">{label}</span>;
}
