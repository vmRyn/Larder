import { lazy, Suspense, useEffect, useState } from 'react';
import { api, session as loadSession, type Favorite, type Session } from './api';
import { formatBytes } from './format';
import { Dialog } from './components/Dialog';
import { ContextMenu, menuItems } from './components/ContextMenu';
import { Icon } from './components/Icons';
import { NavRail, Presence } from './motion';
import { Activity, Users } from './screens/People';
import { Health } from './screens/Health';
import { About } from './screens/About';
import { Explorer } from './screens/Explorer';
import { Shared } from './screens/Shared';
import { Login } from './screens/Login';
import { Setup } from './screens/Setup';

const TerminalPane = lazy(() => import('./screens/Terminal').then((mod) => ({ default: mod.TerminalPane })));

type Page = 'files' | 'users' | 'activity' | 'shared' | 'health' | 'about' | 'terminal';

function useNarrow() {
  const [narrow, setNarrow] = useState(window.matchMedia('(max-width: 959px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 959px)');
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [page, setPage] = useState<Page>('files');
  const [rootId, setRootId] = useState('');
  const [path, setPath] = useState('');
  const [trash, setTrash] = useState(false);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [menu, setMenu] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [placeMenu, setPlaceMenu] = useState<null | { x: number; y: number; root: string; path: string; unpin: boolean }>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const narrow = useNarrow();
  const [light, setLight] = useState(() => localStorage.getItem('larder:theme') === 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    localStorage.setItem('larder:theme', light ? 'light' : 'dark');
  }, [light]);

  useEffect(() => {
    const block = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, .xterm')) return;
      event.preventDefault();
    };
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  async function refresh() {
    const next = await loadSession();
    setSession(next);
    if (next.state === 'ready') {
      const stored = localStorage.getItem(`larder:last:${next.user.username}`) ?? '';
      const splitAt = stored.indexOf('|');
      const storedRoot = splitAt === -1 ? '' : stored.slice(0, splitAt);
      const storedPath = splitAt === -1 ? '' : stored.slice(splitAt + 1);
      const stillVisible = next.roots.some((item) => item.id === rootId);
      if (!stillVisible) {
        const initial = next.roots.find((item) => item.id === storedRoot) ?? next.roots[0];
        setRootId(initial?.id ?? '');
        setPath(initial && initial.id === storedRoot ? storedPath : '');
      }
      const pins = await api<{ favorites: Favorite[] }>('/api/favorites');
      setFavorites(pins.favorites);
    }
  }

  useEffect(() => {
    void refresh();
    // The first session chooses the opening folder. Later refreshes keep the folder the person is in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (session?.state === 'ready' && rootId) {
      localStorage.setItem(`larder:last:${session.user.username}`, `${rootId}|${path}`);
      const recentKey = `larder:recent:${session.user.username}`;
      const recent = JSON.parse(localStorage.getItem(recentKey) ?? '[]') as { root: string; path: string }[];
      const next = [{ root: rootId, path }, ...recent.filter((item) => !(item.root === rootId && item.path === path))].slice(0, 8);
      localStorage.setItem(recentKey, JSON.stringify(next));
    }
  }, [session, rootId, path]);

  if (!session) return <p className="p-6 text-muted">Loading…</p>;
  if (session.state === 'setup') return <Setup onDone={() => void refresh()} />;
  if (session.state === 'login') return <Login onDone={() => void refresh()} />;

  const ready = session;
  const root = ready.roots.find((item) => item.id === rootId) ?? ready.roots[0];
  const recent = JSON.parse(localStorage.getItem(`larder:recent:${ready.user.username}`) ?? '[]') as { root: string; path: string }[];

  function openPlace(id: string, nextPath: string) {
    setRootId(id);
    setPath(nextPath);
    setTrash(false);
    setPage('files');
    setSidebar(false);
  }

  async function toggleFavorite(placeRoot: string, folderPath: string) {
    const pinned = favorites.some((item) => item.root === placeRoot && item.path === folderPath);
    await api('/api/favorites', { method: 'PUT', body: JSON.stringify({ root: placeRoot, path: folderPath, pinned: !pinned }) });
    const pins = await api<{ favorites: Favorite[] }>('/api/favorites');
    setFavorites(pins.favorites);
  }

  async function pin(folderPath = path) {
    if (!root) return;
    await toggleFavorite(root.id, folderPath);
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordError('');
    try {
      await api('/api/password', { method: 'POST', body: JSON.stringify({ current: currentPassword, next: nextPassword }) });
      setCurrentPassword('');
      setNextPassword('');
      setPasswordOpen(false);
    } catch (reason) {
      setPasswordError(reason instanceof Error ? reason.message : 'Could not change the password.');
    }
  }

  const sidebarBody = (
    <aside className="flex h-full w-[248px] flex-col border-r border-split bg-page">
      <NavRail className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {ready.roots.map((item) => {
          const used = item.freeBytes != null && item.totalBytes ? Math.min(1, Math.max(0, (item.totalBytes - item.freeBytes) / item.totalBytes)) : null;
          const low = item.freeBytes != null && item.totalBytes != null && item.totalBytes > 0 && item.freeBytes / item.totalBytes < 0.1;
          return (
            <button
              key={item.id}
              className="nav-item"
              data-active={page === 'files' && !trash && item.id === root?.id}
              type="button"
              onClick={() => openPlace(item.id, '')}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setPlaceMenu({ x: event.clientX, y: event.clientY, root: item.id, path: '', unpin: false });
              }}
            >
              <Icon name={item.id.startsWith('home:') || item.name === 'Home' ? 'home' : 'drive'} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.name}</span>
                {used != null && (
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-line">
                    <span className="block h-full" style={{ width: `${used * 100}%`, background: low ? 'var(--color-danger)' : 'var(--color-accent)' }} />
                  </span>
                )}
                {item.freeBytes != null && (
                  <span className="mt-0.5 block text-[11px] text-muted">
                    {formatBytes(item.freeBytes)} free{item.totalBytes != null ? ` of ${formatBytes(item.totalBytes)}` : ''}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        {ready.roots.length === 0 && <p className="px-2 py-3 text-muted">{ready.user.admin ? 'Add a folder to the config file.' : 'No folders have been shared with you.'}</p>}
        <p className="mt-3 px-2 py-1 text-xs text-muted">Favorites</p>
        {favorites.map((item) => (
          <button
            key={`${item.root}:${item.path}`}
            className="nav-item"
            type="button"
            onClick={() => openPlace(item.root, item.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setPlaceMenu({ x: event.clientX, y: event.clientY, root: item.root, path: item.path, unpin: true });
            }}
          >
            <Icon name="pin" size={16} />
            <span className="truncate">{item.path || ready.roots.find((rootItem) => rootItem.id === item.root)?.name}</span>
          </button>
        ))}
        <p className="mt-3 px-2 py-1 text-xs text-muted">Recent</p>
        {recent.map((item) => (
          <button
            key={`${item.root}:${item.path}`}
            className="nav-item"
            type="button"
            onClick={() => openPlace(item.root, item.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setPlaceMenu({ x: event.clientX, y: event.clientY, root: item.root, path: item.path, unpin: false });
            }}
          >
            <Icon name="recent" size={16} />
            <span className="truncate">{item.path || ready.roots.find((rootItem) => rootItem.id === item.root)?.name}</span>
          </button>
        ))}
      </NavRail>
      <NavRail className="px-2 py-2">
        {root && root.access === 'edit' && (
          <button className="nav-item" data-active={page === 'files' && trash} type="button" onClick={() => { setTrash(true); setPage('files'); setSidebar(false); }}>
            <Icon name="trash" />
            <span>Trash</span>
          </button>
        )}
        <button className="nav-item" data-active={page === 'shared'} type="button" onClick={() => { setPage('shared'); setSidebar(false); }}>
          <Icon name="link" />
          <span>Shared</span>
        </button>
        {ready.user.admin && (
          <>
            <button className="nav-item" data-active={page === 'users'} type="button" onClick={() => { setPage('users'); setSidebar(false); }}>
              <Icon name="users" />
              <span>Users</span>
            </button>
            <button className="nav-item" data-active={page === 'activity'} type="button" onClick={() => { setPage('activity'); setSidebar(false); }}>
              <Icon name="activity" />
              <span>Activity</span>
            </button>
            <button className="nav-item" data-active={page === 'health'} type="button" onClick={() => { setPage('health'); setSidebar(false); }}>
              <Icon name="info" />
              <span>Health</span>
            </button>
            <button className="nav-item" data-active={page === 'terminal'} type="button" onClick={() => { setPage('terminal'); setSidebar(false); }}>
              <Icon name="terminal" />
              <span>Terminal</span>
            </button>
          </>
        )}
        <button className="nav-item" data-active={page === 'about'} type="button" onClick={() => { setPage('about'); setSidebar(false); }}>
          <Icon name="info" />
          <span>About</span>
        </button>
      </NavRail>
    </aside>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 items-center gap-3 border-b border-split px-3">
        {narrow && (
          <button className="btn" type="button" onClick={() => setSidebar(true)}>
            Places
          </button>
        )}
        <div className="font-[560]">Larder</div>
        <div className="min-w-0 flex-1 truncate text-muted">
          {page === 'files' ? root?.name : page === 'users' ? 'Users' : page === 'shared' ? 'Shared' : page === 'health' ? 'Health' : page === 'about' ? 'About' : page === 'terminal' ? 'Terminal' : 'Activity'}
        </div>
        <button
          className="theme-switch"
          type="button"
          data-mode={light ? 'light' : 'dark'}
          aria-pressed={light}
          aria-label={light ? 'Switch to dark mode' : 'Switch to light mode'}
          onClick={() => setLight((value) => !value)}
        >
          <span className="theme-switch-thumb" />
          <span className="theme-switch-icon">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle cx="8" cy="8" r="2.6" fill="currentColor" />
              <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" />
              </g>
            </svg>
          </span>
          <span className="theme-switch-icon">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path fill="currentColor" d="M8.7 1.5a5.7 5.7 0 1 0 5.8 8.5A4.7 4.7 0 1 1 8.7 1.5z" />
            </svg>
          </span>
        </button>
        <div className="relative">
          <button className="btn" type="button" onClick={() => setMenu((open) => !open)}>
            {ready.user.displayName}
          </button>
          <Presence open={menu} className="pop pop-end absolute right-0 z-30 mt-1 w-44 rounded-control border border-split bg-surface p-1 shadow-[var(--shadow-pop)]">
            <button className="nav-item" type="button" onClick={() => { setMenu(false); setPasswordOpen(true); }}>
              Change password
            </button>
            <button className="nav-item" type="button" onClick={() => void api('/api/logout', { method: 'POST' }).then(() => setSession({ state: 'login' }))}>
              Log out
            </button>
          </Presence>
        </div>
      </header>
      {ready.warnings.length > 0 && (
        <p className="border-b border-line px-3 py-2 text-muted">
          Missing folders: {ready.warnings.map((warning) => `${warning.name} (${warning.path})`).join(', ')}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        {!narrow && sidebarBody}
        {narrow && sidebar && (
          <div className="fixed inset-0 z-30 flex" onMouseDown={() => setSidebar(false)}>
            <div onMouseDown={(event) => event.stopPropagation()}>{sidebarBody}</div>
          </div>
        )}
        <div key={page} className="page-enter flex min-h-0 min-w-0 flex-1 flex-col">
        {page === 'files' && root && (
          <Explorer
            rootId={root.id}
            rootName={root.name}
            path={path}
            setPath={(next) => {
              setTrash(false);
              setPath(next);
            }}
            canEdit={root.access === 'edit'}
            places={ready.roots}
            favorites={favorites}
            onFavorites={(folderPath) => void pin(folderPath)}
            trash={trash}
            setTrash={setTrash}
            admin={ready.user.admin}
            onOpen={(id, nextPath) => {
              setRootId(id);
              setPath(nextPath);
              setTrash(false);
              setPage('files');
            }}
          />
        )}
        {page === 'files' && !root && <p className="p-6 text-muted">{ready.user.admin ? 'Add a folder to the config file.' : 'No folders have been shared with you.'}</p>}
        {page === 'users' && <Users you={ready.user.username} onChanged={() => void refresh()} />}
        {page === 'activity' && <Activity />}
        {page === 'health' && <Health />}
        {page === 'about' && <About />}
        {page === 'terminal' && (
          <Suspense fallback={<p className="p-6 text-muted">Loading…</p>}>
            <TerminalPane rootId={trash ? '' : rootId} path={trash ? '' : path} />
          </Suspense>
        )}
        {page === 'shared' && (
          <Shared
            roots={ready.roots}
            admin={ready.user.admin}
            onOpen={(id, nextPath) => {
              setRootId(id);
              setPath(nextPath);
              setTrash(false);
              setPage('files');
            }}
          />
        )}
        </div>
      </div>
      <ContextMenu
        open={placeMenu != null}
        x={placeMenu?.x ?? 0}
        y={placeMenu?.y ?? 0}
        onClose={() => setPlaceMenu(null)}
        items={
          placeMenu
            ? menuItems([
                [{ icon: 'open', label: 'Open', onSelect: () => openPlace(placeMenu.root, placeMenu.path) }],
                [placeMenu.unpin ? { icon: 'pin', label: 'Unpin', onSelect: () => void toggleFavorite(placeMenu.root, placeMenu.path) } : null],
              ])
            : []
        }
      />
      <Dialog title="Change password" open={passwordOpen} onClose={() => setPasswordOpen(false)}>
          <form className="space-y-3" onSubmit={(event) => void changePassword(event)}>
            <input className="field" type="password" placeholder="Current password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            <input className="field" type="password" placeholder="New password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} />
            <p className="text-sm text-muted">Other browsers signed in as you will be signed out.</p>
            {passwordError && <p key={passwordError} className="notice text-danger">{passwordError}</p>}
            <button className="btn btn-primary" type="submit">
              Save
            </button>
          </form>
      </Dialog>
    </div>
  );
}
