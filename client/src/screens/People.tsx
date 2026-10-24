import { useEffect, useState } from 'react';
import { api, type Access } from '../api';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icons';
import { formatBytes, formatStamp } from '../format';

type LiveSession = { id: string; created: string; expires: number; current?: boolean };

type Invite = {
  id: string;
  note: string;
  expires: number;
  created: string;
  admin: boolean;
  home: boolean;
  grants: Record<string, Access>;
};

type Account = {
  username: string;
  displayName: string;
  admin: boolean;
  disabled: boolean;
  home: boolean;
  grants: Record<string, Access>;
  groups?: string[];
  sessions: number;
  lastSeen: string | null;
  lastAction: string | null;
  homeBytes: number | null;
  homeFiles: number | null;
};

type Group = {
  id: string;
  name: string;
  grants: Record<string, Access>;
  members: number;
};

type RootInfo = { id: string; name: string };

type Draft = {
  username: string;
  displayName: string;
  password: string;
  confirm: string;
  admin: boolean;
  disabled: boolean;
  home: boolean;
  grants: Record<string, Access | 'none'>;
  groups: string[];
};

type GroupDraft = {
  id: string | null;
  name: string;
  grants: Record<string, Access | 'none'>;
};

const actions: Record<string, string> = {
  login: 'Signed in',
  login_failed: 'Failed sign-in',
  user: 'Account change',
  upload: 'Uploaded a file',
  share: 'Shared a file',
  unshare: 'Revoked a share',
  mkdir: 'Made a folder',
  create: 'Made a file',
  edit: 'Edited a file',
  rename: 'Renamed something',
  move: 'Moved something',
  trash: 'Moved something to trash',
  zip: 'Zipped',
  extract: 'Extracted a zip',
  restore: 'Restored from trash',
  empty_trash: 'Emptied trash',
  terminal: 'Opened a terminal',
};

export function Users({ you, onChanged }: { you: string; onChanged: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [homesEnabled, setHomesEnabled] = useState(false);
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<'new' | Account | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteDraft, setInviteDraft] = useState<Draft | null>(null);
  const [inviteNote, setInviteNote] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [invites, setInvites] = useState<Invite[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);

  async function load() {
    const data = await api<{ users: Account[]; roots: RootInfo[]; homesEnabled: boolean; groups?: Group[] }>('/api/users');
    setAccounts(data.users);
    setRoots(data.roots);
    setHomesEnabled(data.homesEnabled);
    setGroups(data.groups ?? []);
  }

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not load users'));
    void api<{ invites: Invite[] }>('/api/invites')
      .then((data) => setInvites(data.invites))
      .catch(() => setInvites([]));
  }, []);

  const accountName = dialog && dialog !== 'new' ? dialog.username : '';
  useEffect(() => {
    if (!accountName) {
      setSessions([]);
      return;
    }
    void api<{ sessions: LiveSession[] }>(`/api/users/${encodeURIComponent(accountName)}/sessions`)
      .then((data) => setSessions(data.sessions))
      .catch(() => setSessions([]));
  }, [accountName]);

  function openNew() {
    setError('');
    setDraft({
      username: '',
      displayName: '',
      password: '',
      confirm: '',
      admin: false,
      disabled: false,
      home: homesEnabled,
      grants: Object.fromEntries(roots.map((root) => [root.id, 'none' as const])),
      groups: [],
    });
    setDialog('new');
  }

  function openAccount(account: Account) {
    setError('');
    setDraft({
      username: account.username,
      displayName: account.displayName,
      password: '',
      confirm: '',
      admin: account.admin,
      disabled: account.disabled,
      home: account.home,
      grants: Object.fromEntries(roots.map((root) => [root.id, account.grants[root.id] ?? 'none'])),
      groups: account.groups ?? [],
    });
    setDialog(account);
  }

  function close() {
    setDialog(null);
    setDraft(null);
    setError('');
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      if (draft.password && draft.password !== draft.confirm) throw new Error('Those passwords do not match.');
      if (draft.password && draft.password.length < 12) throw new Error('Use at least 12 characters.');
      if (dialog === 'new' && !draft.password) throw new Error('Use at least 12 characters.');
      const grants = Object.fromEntries(Object.entries(draft.grants).filter((entry): entry is [string, Access] => entry[1] !== 'none'));
      if (dialog === 'new') {
        await api('/api/users', {
          method: 'POST',
          body: JSON.stringify({
            username: draft.username.trim(),
            password: draft.password,
            displayName: draft.displayName.trim(),
            admin: draft.admin,
            home: draft.home,
            grants,
            groups: draft.groups,
          }),
        });
        close();
      } else {
        await api(`/api/users/${encodeURIComponent(draft.username)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            displayName: draft.displayName.trim(),
            admin: draft.admin,
            disabled: draft.disabled,
            home: draft.home,
            grants,
            groups: draft.groups,
          }),
        });
        if (draft.password) {
          await api(`/api/users/${encodeURIComponent(draft.username)}/password`, {
            method: 'POST',
            body: JSON.stringify({ password: draft.password }),
          });
        }
        close();
      }
      await load();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const query = filter.trim().toLowerCase();
  const shown = accounts.filter((account) => {
    if (!query) return true;
    return account.username.includes(query) || account.displayName.toLowerCase().includes(query);
  });

  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg">Users</h2>
            <p className="text-sm text-muted">{accounts.length === 1 ? '1 account' : `${accounts.length} accounts`}</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setInviteDraft({
                  username: '',
                  displayName: '',
                  password: '',
                  confirm: '',
                  admin: false,
                  disabled: false,
                  home: homesEnabled,
                  grants: Object.fromEntries(roots.map((root) => [root.id, 'none' as const])),
                  groups: [],
                });
                setInviteNote('');
                setInviteUrl('');
                setError('');
                setInviteOpen(true);
              }}
            >
              Invite
            </button>
            <button type="button" className="btn btn-primary inline-flex items-center gap-2" onClick={openNew}>
              <Icon name="users" size={16} />
              Add user
            </button>
          </div>
        </div>
        {invites.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted">{invites.length === 1 ? '1 invite waiting' : `${invites.length} invites waiting`}</p>
            {invites.map((invite) => {
              const url = `${window.location.origin}/join/${invite.id}`;
              return (
                <div key={invite.id} className="rounded-control border border-split bg-surface px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{invite.note || 'Invite'}</span>
                    {invite.admin && <Badge>Admin</Badge>}
                    {invite.home && <Badge>Private vault</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">Expires {formatStamp(invite.expires)}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">{invite.admin ? <Badge>Every folder</Badge> : <GrantChips grants={invite.grants} roots={roots} />}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={url}>{url}</span>
                    <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(url)}>Copy</button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        void api(`/api/invites/${invite.id}`, { method: 'DELETE' }).then(() => {
                          setInvites((current) => current.filter((item) => item.id !== invite.id));
                        });
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <input className="field max-w-xs" value={filter} placeholder="Filter accounts" onChange={(event) => setFilter(event.target.value)} />
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm text-muted">Groups</h3>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setError('');
                setGroupDraft({
                  id: null,
                  name: '',
                  grants: Object.fromEntries(roots.map((root) => [root.id, 'none' as const])),
                });
              }}
            >
              New group
            </button>
          </div>
          {groups.length === 0 && <p className="text-sm text-muted">No groups yet. A group’s folder access applies to everyone in it.</p>}
          {groups.map((group) => (
            <div key={group.id} className="rounded-control border border-split bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span>{group.name}</span>
                  <span className="ml-2 text-xs text-muted">{group.members === 1 ? '1 person' : `${group.members} people`}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setError('');
                      setGroupDraft({
                        id: group.id,
                        name: group.name,
                        grants: Object.fromEntries(roots.map((root) => [root.id, group.grants[root.id] ?? 'none'])),
                      });
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      void api(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' }).then(() => load());
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <GrantChips grants={group.grants} roots={roots} />
              </div>
            </div>
          ))}
        </div>
        {error && !dialog && !groupDraft && <p key={error} className="notice text-sm text-danger">{error}</p>}
        <div className="flex flex-col gap-2">
          {shown.map((account) => (
            <button key={account.username} type="button" className="surface-hover rounded-control border border-split bg-surface px-4 py-3 text-left hover:bg-hover" onClick={() => openAccount(account)}>
              <div className="flex items-start gap-3">
                <span className={`grid size-10 shrink-0 place-items-center rounded-control text-sm uppercase ${account.disabled ? 'bg-page text-muted' : 'bg-select'}`}>
                  {(account.displayName || account.username).slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`truncate ${account.disabled ? 'text-muted' : ''}`}>{account.displayName || account.username}</span>
                    {account.admin && <Badge>Admin</Badge>}
                    {account.username === you && <Badge>You</Badge>}
                    {account.disabled && <Badge tone="danger">Disabled</Badge>}
                    {account.sessions > 0 ? (
                      <Badge tone="accent">{account.sessions === 1 ? 'Signed in' : `${account.sessions} sessions`}</Badge>
                    ) : (
                      <Badge>Signed out</Badge>
                    )}
                  </div>
                  <p className="truncate text-sm text-muted">{account.username}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {account.admin ? <Badge>Every folder</Badge> : <GrantChips grants={effectiveGrants(account, groups)} roots={roots} />}
                  </div>
                  {(account.groups ?? []).length > 0 && (
                    <p className="mt-1 text-xs text-muted">
                      {(account.groups ?? []).map((id) => groups.find((group) => group.id === id)?.name ?? id).join(', ')}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted">
                    {homeLine(account, homesEnabled)}
                    <span className="px-1.5">·</span>
                    {seenLine(account)}
                  </p>
                </div>
              </div>
            </button>
          ))}
          {shown.length === 0 && <p className="text-sm text-muted">No accounts match that filter.</p>}
        </div>
      </div>

      <Dialog open={!!(dialog && draft)} title={dialog === 'new' ? 'New account' : draft?.displayName || draft?.username || ''} wide onClose={close}>
        {dialog && draft && (
          <div className="flex flex-col gap-3">
            {dialog === 'new' ? (
              <label className="block text-sm">
                <span className="mb-1 block text-muted">Username</span>
                <input className="field" autoFocus value={draft.username} placeholder="a-z, numbers, hyphens" onChange={(event) => setDraft({ ...draft, username: event.target.value })} />
              </label>
            ) : (
              <p className="text-sm text-muted">{draft.username}</p>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Display name</span>
              <input className="field" value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-muted">{dialog === 'new' ? 'Password' : 'New password'}</span>
                <input className="field" type="password" autoComplete="new-password" value={draft.password} placeholder={dialog === 'new' ? 'At least 12 characters' : 'Leave blank to keep'} onChange={(event) => setDraft({ ...draft, password: event.target.value })} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted">Confirm password</span>
                <input className="field" type="password" autoComplete="new-password" value={draft.confirm} onChange={(event) => setDraft({ ...draft, confirm: event.target.value })} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.admin} onChange={(event) => setDraft({ ...draft, admin: event.target.checked })} />
              Admin
              <span className="text-muted">Can change every folder and other accounts.</span>
            </label>
            {dialog !== 'new' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.disabled} disabled={draft.username === you} onChange={(event) => setDraft({ ...draft, disabled: event.target.checked })} />
                Disabled
                <span className="text-muted">They cannot sign in.</span>
              </label>
            )}
            {homesEnabled && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.home} onChange={(event) => setDraft({ ...draft, home: event.target.checked })} />
                {vaultTitle(draft.username)}
                <span className="text-muted">A private folder only this person can open.</span>
              </label>
            )}
            <div className={draft.admin ? 'opacity-50' : ''}>
              <p className="mb-2 text-sm text-muted">{draft.admin ? 'Admins already have every folder.' : 'Folder access'}</p>
              <div className="flex flex-col gap-2">
                {roots.map((root) => (
                  <div key={root.id} className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm">{root.name}</span>
                    <AccessChoice
                      value={draft.grants[root.id] ?? 'none'}
                      disabled={draft.admin}
                      onChange={(value) => setDraft({ ...draft, grants: { ...draft.grants, [root.id]: value } })}
                    />
                  </div>
                ))}
              </div>
              {groups.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-sm text-muted">Groups</p>
                  <p className="mb-2 text-xs text-muted">Group access is added to the folders above. The higher access is used.</p>
                  <div className="flex flex-col gap-2">
                    {groups.map((group) => (
                      <label key={group.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.groups.includes(group.id)}
                          onChange={(event) => {
                            const next = event.target.checked ? [...draft.groups, group.id] : draft.groups.filter((id) => id !== group.id);
                            setDraft({ ...draft, groups: next });
                          }}
                        />
                        {group.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {dialog !== 'new' && (
              <div>
                <p className="mb-2 text-sm text-muted">Signed in</p>
                {sessions.length === 0 && <p className="text-sm text-muted">No open sessions.</p>}
                <div className="flex flex-col gap-2">
                  {sessions.map((session) => (
                    <div key={session.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted">
                        Since {formatStamp(Date.parse(session.created))}
                        {session.current ? ' · This browser' : ''}
                      </span>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          void api(`/api/users/${encodeURIComponent(accountName)}/sessions/${session.id}`, { method: 'DELETE' }).then(() => {
                            if (session.current) {
                              window.location.assign('/');
                              return;
                            }
                            setSessions((current) => current.filter((item) => item.id !== session.id));
                          });
                        }}
                      >
                        Sign out
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {error && <p key={error} className="notice text-sm text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={close}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                {dialog === 'new' ? 'Create account' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </Dialog>
      <Dialog open={!!(inviteOpen && inviteDraft)} title="Invite" wide onClose={() => setInviteOpen(false)}>
        {inviteOpen && inviteDraft && (
          <div className="flex flex-col gap-3">
            {inviteUrl ? (
              <>
                <p className="text-sm text-muted">Send this link. It can be used once.</p>
                <input className="field" readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} />
                <button type="button" className="btn btn-primary self-end" onClick={() => void navigator.clipboard.writeText(inviteUrl)}>Copy link</button>
              </>
            ) : (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted">Note</span>
                  <input className="field" value={inviteNote} placeholder="Optional" maxLength={200} onChange={(event) => setInviteNote(event.target.value)} />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={inviteDraft.admin} onChange={(event) => setInviteDraft({ ...inviteDraft, admin: event.target.checked })} />
                  Admin
                </label>
                {homesEnabled && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={inviteDraft.home} onChange={(event) => setInviteDraft({ ...inviteDraft, home: event.target.checked })} />
                    Private vault
                  </label>
                )}
                <div className={inviteDraft.admin ? 'opacity-50' : ''}>
                  <p className="mb-2 text-sm text-muted">Folder access</p>
                  <div className="flex flex-col gap-2">
                    {roots.map((root) => (
                      <div key={root.id} className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm">{root.name}</span>
                        <AccessChoice
                          value={inviteDraft.grants[root.id] ?? 'none'}
                          disabled={inviteDraft.admin}
                          onChange={(value) => setInviteDraft({ ...inviteDraft, grants: { ...inviteDraft.grants, [root.id]: value } })}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                {error && <p key={error} className="notice text-sm text-danger">{error}</p>}
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn" onClick={() => setInviteOpen(false)}>Cancel</button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      const grants = Object.fromEntries(Object.entries(inviteDraft.grants).filter((entry): entry is [string, Access] => entry[1] !== 'none'));
                      void api<{ id: string }>('/api/invites', {
                        method: 'POST',
                        body: JSON.stringify({ grants, admin: inviteDraft.admin, home: inviteDraft.home, days: 7, note: inviteNote }),
                      })
                        .then((created) => {
                          const invite: Invite = {
                            id: created.id,
                            note: inviteNote.trim(),
                            expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
                            created: new Date().toISOString(),
                            admin: inviteDraft.admin,
                            home: inviteDraft.home,
                            grants,
                          };
                          setInvites((current) => [invite, ...current.filter((item) => item.id !== invite.id)]);
                          setInviteUrl(`${window.location.origin}/join/${created.id}`);
                        })
                        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not create the invite'));
                    }}
                  >
                    Create invite
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </Dialog>
      <Dialog open={!!groupDraft} title={groupDraft?.id ? 'Edit group' : 'New group'} wide onClose={() => setGroupDraft(null)}>
        {groupDraft && (
          <div className="flex flex-col gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Name</span>
              <input className="field" autoFocus value={groupDraft.name} onChange={(event) => setGroupDraft({ ...groupDraft, name: event.target.value })} />
            </label>
            <div className="flex flex-col gap-2">
              {roots.map((root) => (
                <div key={root.id} className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm">{root.name}</span>
                  <AccessChoice
                    value={groupDraft.grants[root.id] ?? 'none'}
                    onChange={(value) => setGroupDraft({ ...groupDraft, grants: { ...groupDraft.grants, [root.id]: value } })}
                  />
                </div>
              ))}
            </div>
            {error && <p key={error} className="notice text-sm text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setGroupDraft(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const grants = Object.fromEntries(Object.entries(groupDraft.grants).filter((entry): entry is [string, Access] => entry[1] !== 'none'));
                  const request = groupDraft.id
                    ? api(`/api/groups/${encodeURIComponent(groupDraft.id)}`, { method: 'PATCH', body: JSON.stringify({ name: groupDraft.name.trim(), grants }) })
                    : api('/api/groups', { method: 'POST', body: JSON.stringify({ name: groupDraft.name.trim(), grants }) });
                  void request
                    .then(() => {
                      setGroupDraft(null);
                      return load();
                    })
                    .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not save the group'));
                }}
              >
                {groupDraft.id ? 'Save' : 'Create group'}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function effectiveGrants(account: Account, groups: Group[]): Record<string, Access> {
  const out: Record<string, Access> = { ...account.grants };
  for (const id of account.groups ?? []) {
    const group = groups.find((item) => item.id === id);
    if (!group) continue;
    for (const [root, access] of Object.entries(group.grants)) {
      if (!out[root] || (access === 'edit' && out[root] === 'view')) out[root] = access;
    }
  }
  return out;
}

function vaultTitle(username: string): string {
  const name = username.trim();
  if (!name) return 'Vault';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}s Vault`;
}

function homeLine(account: Account, homesEnabled: boolean) {
  const title = vaultTitle(account.username);
  if (!homesEnabled || !account.home) return `No ${title}`;
  if (account.homeBytes == null) return `${title} on`;
  const files = account.homeFiles === 1 ? '1 file' : `${account.homeFiles ?? 0} files`;
  return `${title} ${formatBytes(account.homeBytes)} · ${files}`;
}

function seenLine(account: Account) {
  if (!account.lastSeen) return 'No activity yet';
  const what = account.lastAction ? actions[account.lastAction] ?? account.lastAction : 'Last seen';
  return `${what} · ${formatStamp(Date.parse(account.lastSeen))}`;
}

function GrantChips({ grants, roots }: { grants: Record<string, Access>; roots: RootInfo[] }) {
  const chips = roots.flatMap((root) => {
    const access = grants[root.id];
    if (!access) return [];
    return [<Badge key={root.id}>{`${root.name} · ${access === 'edit' ? 'Edit' : 'View'}`}</Badge>];
  });
  if (chips.length === 0) return <span className="text-xs text-muted">No folders</span>;
  return <>{chips}</>;
}

function Badge({ children, tone }: { children: string; tone?: 'accent' | 'danger' }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-ink';
  return <span className={`rounded-control bg-page px-1.5 py-0.5 text-xs ${color}`}>{children}</span>;
}

function AccessChoice({ value, disabled, onChange }: { value: Access | 'none'; disabled?: boolean; onChange: (value: Access | 'none') => void }) {
  const options: { id: Access | 'none'; label: string }[] = [
    { id: 'none', label: 'None' },
    { id: 'view', label: 'View' },
    { id: 'edit', label: 'Edit' },
  ];
  return (
    <div className="flex overflow-hidden rounded-control border border-split">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={disabled}
          className={`surface-hover px-2.5 py-1 text-xs ${value === option.id ? 'bg-accent text-accent-ink' : 'bg-page text-muted hover:bg-hover hover:text-ink'}`}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Activity() {
  const [rows, setRows] = useState<Array<{ t: string; user: string; action: string; root: string; path: string }>>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  function load(offset: number) {
    void api<{ entries: Array<{ t: string; user: string; action: string; root: string; path: string }>; total: number }>(`/api/activity?offset=${offset}&limit=100`)
      .then((data) => {
        const entries = Array.isArray(data.entries) ? data.entries : [];
        setRows((current) => (offset === 0 ? entries : [...current, ...entries]));
        setTotal(data.total ?? entries.length);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not load activity'));
  }
  useEffect(() => {
    load(0);
  }, []);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <h2 className="mb-3 text-lg">Activity</h2>
      {error && <p key={error} className="notice mb-3 text-sm text-danger">{error}</p>}
      <div className="flex flex-col gap-1 font-mono text-xs">
        {rows.map((row, index) => (
          <div key={`${row.t}-${index}`} className="grid grid-cols-[160px_100px_120px_1fr] gap-3 border-b border-line py-1 text-muted">
            <span>{formatStamp(Date.parse(row.t))}</span>
            <span className="text-ink">{row.user}</span>
            <span>{actions[row.action] ?? row.action}</span>
            <span className="truncate">{row.root ? `${row.root}/${row.path}` : ''}</span>
          </div>
        ))}
        {rows.length === 0 && !error && <p>No activity yet.</p>}
      </div>
      {rows.length < total && (
        <button className="btn mt-3" type="button" onClick={() => load(rows.length)}>
          Older
        </button>
      )}
    </div>
  );
}
