import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { warmAuth } from './auth.js';
import { initRuntime, runtime } from './config.js';
import { createApp } from './routes.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'larder-api-'));
const root = path.join(dir, 'documents');
const media = path.join(dir, 'media');
const homes = path.join(dir, 'homes');
await fs.mkdir(root);
await fs.mkdir(media);
await fs.mkdir(homes);
await fs.writeFile(path.join(root, 'notes.txt'), 'hello larder');
process.env.LARDER_CONFIG = path.join(dir, 'larder.config.json');
await fs.writeFile(
  process.env.LARDER_CONFIG,
  JSON.stringify({
    host: '127.0.0.1',
    port: 9,
    sessionSecret: 'a'.repeat(32),
    maxUploadBytes: 1024 * 1024,
    homes: { enabled: true, path: homes },
    roots: [
      { id: 'documents', name: 'Documents', path: root },
      { id: 'media', name: 'Media', path: media },
    ],
    users: [],
  }),
);
await initRuntime();
await warmAuth();
const app = createApp();

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function json(body: unknown, cookie?: string): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-larder-request': '1' };
  if (cookie) headers.cookie = cookie;
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

test('accounts, files, trash, and grants', async () => {
  const setup = await app.request('/api/session');
  assert.equal((await setup.json()).state, 'setup');

  const created = await app.request('/api/setup', json({ username: 'ryan', password: 'correct-horse' }));
  assert.equal(created.status, 200);
  const cookie = created.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const session = await app.request('/api/session', { headers: { cookie: cookie! } });
  const ready = (await session.json()) as { state: string; roots: { id: string; name: string }[] };
  assert.equal(ready.state, 'ready');
  assert.ok(ready.roots.some((item) => item.id === 'documents'));

  const listed = await app.request('/api/list?root=documents&path=', { headers: { cookie: cookie! } });
  const listing = (await listed.json()) as { entries: { name: string }[] };
  assert.ok(listing.entries.some((entry) => entry.name === 'notes.txt'));

  const outside = await app.request('/api/list?root=documents&path=' + encodeURIComponent('../media'), { headers: { cookie: cookie! } });
  assert.equal(outside.status, 400);

  const made = await app.request('/api/mkdir', json({ root: 'documents', path: '', name: 'projects' }, cookie));
  assert.equal(made.status, 200);

  const file = await app.request('/api/create-file', json({ root: 'documents', path: 'projects', name: 'plan.txt' }, cookie));
  assert.equal(file.status, 200);

  const removed = await app.request('/api/delete', json({ root: 'documents', paths: ['notes.txt'] }, cookie));
  assert.equal(removed.status, 200);
  const trash = await app.request('/api/trash?root=documents', { headers: { cookie: cookie! } });
  const trashed = (await trash.json()) as { items: { id: string; name: string }[] };
  assert.equal(trashed.items[0]?.name, 'notes.txt');
  const restored = await app.request('/api/trash/restore', json({ root: 'documents', id: trashed.items[0]!.id }, cookie));
  assert.equal(restored.status, 200);

  const found = await app.request('/api/search?root=documents&path=&q=plan', { headers: { cookie: cookie! } });
  const results = (await found.json()) as { results: { path: string }[] };
  assert.equal(results.results[0]?.path, 'projects/plan.txt');

  const guest = await app.request(
    '/api/users',
    json({ username: 'guest', password: 'another-secret', admin: false, home: true, grants: { documents: 'view', media: 'edit' } }, cookie),
  );
  assert.equal(guest.status, 200);
  const people = await app.request('/api/users', { headers: { cookie: cookie! } });
  assert.equal(people.status, 200);
  const peopleBody = (await people.json()) as { users: Array<{ username: string; sessions: number; homeBytes: number | null; grants: Record<string, string> }> };
  const guestRow = peopleBody.users.find((user) => user.username === 'guest');
  assert.equal(guestRow?.grants.documents, 'view');
  assert.equal(guestRow?.grants.media, 'edit');
  assert.equal(typeof guestRow?.sessions, 'number');
  assert.equal(typeof guestRow?.homeBytes, 'number');

  await app.request('/api/logout', json({}, cookie));
  const loggedIn = await app.request('/api/login', json({ username: 'guest', password: 'another-secret' }));
  const guestCookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
  const denied = await app.request('/api/mkdir', json({ root: 'documents', path: '', name: 'nope' }, guestCookie));
  assert.equal(denied.status, 403);
  const allowed = await app.request('/api/mkdir', json({ root: 'media', path: '', name: 'clips' }, guestCookie));
  assert.equal(allowed.status, 200);
  const home = await app.request('/api/list?root=' + encodeURIComponent('home:guest') + '&path=', { headers: { cookie: guestCookie! } });
  assert.equal(home.status, 200);
  const otherHome = await app.request('/api/list?root=' + encodeURIComponent('home:ryan') + '&path=', { headers: { cookie: guestCookie! } });
  assert.equal(otherHome.status, 404);
});

test('resume uploads, cross-root copy, and share links', async () => {
  const loggedIn = await app.request('/api/login', json({ username: 'ryan', password: 'correct-horse' }));
  const cookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const started = await app.request('/api/uploads', json({ root: 'documents', path: '', name: 'big.bin', size: 8 }, cookie));
  assert.equal(started.status, 200);
  const upload = (await started.json()) as { id: string; offset: number };
  assert.equal(upload.offset, 0);
  const part = await app.request(`/api/uploads/${upload.id}`, {
    method: 'PUT',
    headers: { cookie, 'x-larder-request': '1', 'x-larder-offset': '0' },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  assert.equal(part.status, 200);
  const again = await app.request('/api/uploads', json({ root: 'documents', path: '', name: 'big.bin', size: 8, id: upload.id }, cookie));
  assert.equal(((await again.json()) as { offset: number }).offset, 4);
  const rest = await app.request(`/api/uploads/${upload.id}`, {
    method: 'PUT',
    headers: { cookie, 'x-larder-request': '1', 'x-larder-offset': '4' },
    body: new Uint8Array([5, 6, 7, 8]),
  });
  assert.equal(rest.status, 200);
  const early = await app.request(`/api/uploads/${upload.id}`, {
    method: 'PUT',
    headers: { cookie, 'x-larder-request': '1', 'x-larder-offset': '0' },
    body: new Uint8Array([9]),
  });
  assert.equal(early.status, 409);
  const done = await app.request(`/api/uploads/${upload.id}/finish`, json({}, cookie));
  assert.equal(done.status, 200);
  const downloaded = new Uint8Array(await (await app.request('/api/download?root=documents&path=big.bin', { headers: { cookie } })).arrayBuffer());
  assert.deepEqual([...downloaded], [1, 2, 3, 4, 5, 6, 7, 8]);

  const copied = await app.request('/api/copy', json({ root: 'documents', paths: ['notes.txt'], to: '', toRoot: 'media' }, cookie));
  assert.equal(copied.status, 200);
  const inMedia = await app.request('/api/download?root=media&path=notes.txt', { headers: { cookie } });
  assert.equal(await inMedia.text(), 'hello larder');
  const moved = await app.request('/api/move', json({ root: 'media', paths: ['notes.txt'], to: 'projects', toRoot: 'documents' }, cookie));
  assert.equal(moved.status, 200);
  const movedFile = await app.request('/api/download?root=documents&path=projects/notes.txt', { headers: { cookie } });
  assert.equal(await movedFile.text(), 'hello larder');
  const gone = await app.request('/api/download?root=media&path=notes.txt', { headers: { cookie } });
  assert.equal(gone.status, 404);

  const shared = await app.request('/api/shares', json({ root: 'documents', path: 'notes.txt', password: 'secret', days: 1 }, cookie));
  assert.equal(shared.status, 200);
  const link = (await shared.json()) as { id: string };
  const locked = await app.request(`/s/${link.id}`);
  const lockedHtml = await locked.text();
  assert.match(lockedHtml, /password/i);
  assert.doesNotMatch(lockedHtml, /hello larder/);
  const wrong = await app.request(`/s/${link.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=nope',
  });
  assert.equal(wrong.status, 401);
  const right = await app.request(`/s/${link.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=secret',
  });
  const unlocked = await right.text();
  assert.match(unlocked, /Download/);
  assert.match(unlocked, /hello larder/);
  const shareCookie = right.headers.get('set-cookie')?.split(';')[0];
  assert.equal(await (await app.request(`/s/${link.id}/file`, { headers: { cookie: shareCookie! } })).text(), 'hello larder');

  await fs.writeFile(path.join(root, 'projects', 'plan.txt'), 'plan body');
  const open = await app.request('/api/shares', json({ root: 'documents', path: 'projects/plan.txt' }, cookie));
  const openLink = (await open.json()) as { id: string };
  const direct = await app.request(`/s/${openLink.id}`);
  assert.equal(direct.status, 200);
  const directHtml = await direct.text();
  assert.match(directHtml, /Download/);
  assert.match(directHtml, /plan body/);
  assert.equal(await (await app.request(`/s/${openLink.id}/file`)).text(), 'plan body');

  const guestIn = await app.request('/api/login', json({ username: 'guest', password: 'another-secret' }));
  const guestCookie = guestIn.headers.get('set-cookie')?.split(';')[0];
  assert.equal((await app.request('/api/copy', json({ root: 'documents', paths: ['notes.txt'], to: '', toRoot: 'media' }, guestCookie))).status, 403);
  assert.equal((await app.request('/api/move', json({ root: 'media', paths: ['clips'], to: '', toRoot: 'documents' }, guestCookie))).status, 403);
  assert.equal((await app.request(`/api/shares/${link.id}`, { method: 'DELETE', headers: { cookie: guestCookie!, 'x-larder-request': '1' } })).status, 404);

  assert.equal((await app.request(`/api/shares/${link.id}`, { method: 'DELETE', headers: { cookie: cookie!, 'x-larder-request': '1' } })).status, 200);
  const revoked = await app.request(`/s/${link.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=secret',
  });
  assert.equal(revoked.status, 404);

  const expiring = (await (await app.request('/api/shares', json({ root: 'documents', path: 'notes.txt', days: 1 }, cookie))).json()) as { id: string };
  const storePath = path.join(runtime().dataDir, 'shares.json');
  const store = JSON.parse(await fs.readFile(storePath, 'utf8')) as { shares: { id: string; expires: number | null }[] };
  const row = store.shares.find((item) => item.id === expiring.id);
  assert.ok(row);
  row.expires = Date.now() - 1000;
  await fs.writeFile(storePath, JSON.stringify(store));
  assert.equal((await app.request(`/s/${expiring.id}`)).status, 404);

  const zipped = await app.request('/api/zip', json({ root: 'documents', paths: ['projects'], save: true }, cookie));
  assert.equal(zipped.status, 200);
  const zipPath = ((await zipped.json()) as { path: string }).path;
  assert.equal(zipPath, 'projects.zip');
  const zipBytes = await fs.readFile(path.join(root, 'projects.zip'));
  assert.equal(zipBytes.subarray(0, 2).toString(), 'PK');
  const folderShare = await app.request('/api/shares', json({ root: 'documents', path: 'projects' }, cookie));
  assert.equal(folderShare.status, 200);
  const folderLink = (await folderShare.json()) as { id: string; name: string; zip: boolean };
  assert.equal(folderLink.zip, true);
  assert.equal(folderLink.name, 'projects.zip');
  const folderPage = await (await app.request(`/s/${folderLink.id}`)).text();
  assert.match(folderPage, /plan\.txt/);
  assert.match(folderPage, /notes\.txt/);
  const sharedZip = Buffer.from(await (await app.request(`/s/${folderLink.id}/file`)).arrayBuffer());
  assert.equal(sharedZip.subarray(0, 2).toString(), 'PK');
  const fileShare = await app.request('/api/shares', json({ root: 'documents', path: 'projects.zip' }, cookie));
  const fileLink = (await fileShare.json()) as { id: string; zip: boolean };
  assert.equal(fileLink.zip, false);
  const zipPage = await (await app.request(`/s/${fileLink.id}`)).text();
  assert.match(zipPage, /plan\.txt/);
  assert.match(zipPage, /data-kind="text"/);
  const zipEntry = await app.request(`/s/${fileLink.id}/entry?name=${encodeURIComponent('projects/plan.txt')}`);
  assert.equal(zipEntry.status, 200);
  assert.match(zipEntry.headers.get('content-type') ?? '', /text\/plain/);
  assert.equal(await zipEntry.text(), 'plan body');
  const folderEntry = await app.request(`/s/${folderLink.id}/entry?name=${encodeURIComponent('projects/plan.txt')}`);
  assert.equal(await folderEntry.text(), 'plan body');
  assert.equal((await app.request(`/s/${fileLink.id}/entry?name=${encodeURIComponent('../notes.txt')}`)).status, 404);
  const lockedZip = (await (await app.request('/api/shares', json({ root: 'documents', path: 'projects.zip', password: 'secret' }, cookie))).json()) as { id: string };
  const blocked = await app.request(`/s/${lockedZip.id}/entry?name=${encodeURIComponent('projects/plan.txt')}`);
  assert.equal(blocked.status, 401);
  assert.doesNotMatch(await blocked.text(), /plan body/);
  const sharedFile = Buffer.from(await (await app.request(`/s/${fileLink.id}/file`)).arrayBuffer());
  assert.equal(sharedFile.subarray(0, 2).toString(), 'PK');
  await fs.writeFile(path.join(root, 'note.html'), '<script>alert(1)</script>');
  const htmlShare = (await (await app.request('/api/shares', json({ root: 'documents', path: 'note.html' }, cookie))).json()) as { id: string };
  const htmlPage = await (await app.request(`/s/${htmlShare.id}`)).text();
  assert.match(htmlPage, /&lt;script&gt;/);
  assert.doesNotMatch(htmlPage, /<script>alert/);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await fs.writeFile(path.join(root, 'dot.png'), png);
  await fs.writeFile(path.join(root, 'sample.pdf'), '%PDF-1.4\n');
  const picture = (await (await app.request('/api/shares', json({ root: 'documents', path: 'dot.png' }, cookie))).json()) as { id: string };
  assert.match(await (await app.request(`/s/${picture.id}`)).text(), new RegExp(`/s/${picture.id}/preview`));
  const picturePreview = await app.request(`/s/${picture.id}/preview`);
  assert.equal(picturePreview.headers.get('content-type'), 'image/png');
  assert.match(picturePreview.headers.get('content-disposition') ?? '', /inline/);
  const lockedPic = (await (await app.request('/api/shares', json({ root: 'documents', path: 'dot.png', password: 'secret' }, cookie))).json()) as { id: string };
  const hidden = await app.request(`/s/${lockedPic.id}/preview`);
  assert.equal(hidden.status, 401);
  assert.match(hidden.headers.get('content-type') ?? '', /text\/html/);
  const pdf = (await (await app.request('/api/shares', json({ root: 'documents', path: 'sample.pdf' }, cookie))).json()) as { id: string };
  assert.match(await (await app.request(`/s/${pdf.id}`)).text(), /iframe/);
  const pdfPreview = await app.request(`/s/${pdf.id}/preview`);
  assert.match(pdfPreview.headers.get('content-type') ?? '', /application\/pdf/);
  const binShare = (await (await app.request('/api/shares', json({ root: 'documents', path: 'big.bin' }, cookie))).json()) as { id: string };
  const binPage = await (await app.request(`/s/${binShare.id}`)).text();
  assert.match(binPage, /Download/);
  assert.doesNotMatch(binPage, /class="preview"|class="sheet"|class="files"/);
  assert.equal((await app.request(`/s/${binShare.id}/preview`)).status, 404);
  await fs.mkdir(path.join(root, 'album'));
  await fs.writeFile(path.join(root, 'album', 'cover.png'), png);
  await fs.writeFile(path.join(root, 'album', 'readme.txt'), 'hello from the zip');
  const albumZip = await app.request('/api/zip', json({ root: 'documents', paths: ['album'], save: true }, cookie));
  assert.equal(((await albumZip.json()) as { path: string }).path, 'album.zip');
  const albumShare = (await (await app.request('/api/shares', json({ root: 'documents', path: 'album.zip' }, cookie))).json()) as { id: string };
  const albumPage = await (await app.request(`/s/${albumShare.id}`)).text();
  assert.match(albumPage, /data-kind="image"/);
  assert.match(albumPage, /data-kind="text"/);
  assert.match(albumPage, new RegExp(`/s/${albumShare.id}/entry\\?name=album%2Fcover\\.png`));
  const albumPic = await app.request(`/s/${albumShare.id}/entry?name=${encodeURIComponent('album/cover.png')}`);
  assert.equal(albumPic.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await albumPic.arrayBuffer()).subarray(0, 8).toString('hex'), png.subarray(0, 8).toString('hex'));
  const albumNote = await app.request(`/s/${albumShare.id}/entry?name=${encodeURIComponent('album/readme.txt')}`);
  assert.equal(await albumNote.text(), 'hello from the zip');
  const guestZip = await app.request('/api/zip', json({ root: 'documents', paths: ['projects'], save: true }, guestCookie));
  assert.equal(guestZip.status, 403);
});

test('share edits, filtered search, invites, sessions, and health', async () => {
  const loggedIn = await app.request('/api/login', json({ username: 'ryan', password: 'correct-horse' }));
  const cookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('missing session');
  const made = await app.request('/api/shares', json({ root: 'documents', path: 'notes.txt', note: 'photos from Saturday', days: 7 }, cookie));
  assert.equal(made.status, 200);
  const share = (await made.json()) as { id: string; note: string };
  assert.equal(share.note, 'photos from Saturday');
  assert.match(await (await app.request(`/s/${share.id}`)).text(), /photos from Saturday/);
  const listed = (await (await app.request('/api/shares', { headers: { cookie } })).json()) as { shares: { id: string; opens: number; note: string }[] };
  assert.ok((listed.shares.find((item) => item.id === share.id)?.opens ?? 0) >= 1);
  const patched = await app.request(`/api/shares/${share.id}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json', 'x-larder-request': '1' },
    body: JSON.stringify({ note: 'updated note', days: null }),
  });
  assert.equal(patched.status, 200);
  assert.equal(((await patched.json()) as { note: string; expires: number | null }).expires, null);
  const qr = await app.request(`/api/shares/${share.id}/qr`, { headers: { cookie } });
  assert.match(qr.headers.get('content-type') ?? '', /svg/);
  assert.match(await qr.text(), /<svg/);
  const album = (await (await app.request('/api/shares', json({ root: 'documents', path: 'album.zip' }, cookie))).json()) as { id: string };
  const saved = await app.request(`/s/${album.id}/entry?name=${encodeURIComponent('album/cover.png')}&download=1`);
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal((await app.request('/api/search?root=documents&path=&q=', { headers: { cookie } })).status, 400);
  const images = (await (await app.request('/api/search?root=documents&path=&q=&type=image', { headers: { cookie } })).json()) as { results: { path: string }[] };
  assert.ok(images.results.some((item) => item.path === 'dot.png' || item.path.endsWith('/cover.png')));
  const invite = (await (await app.request('/api/invites', json({ grants: { documents: 'view' }, admin: false, home: false, days: 7, note: 'welcome' }, cookie))).json()) as { id: string };
  assert.match(await (await app.request(`/join/${invite.id}`)).text(), /welcome/);
  const joined = await app.request(`/join/${invite.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=ada&password=correct-horse-2&displayName=Ada',
  });
  assert.equal(joined.status, 302);
  assert.equal((await app.request(`/join/${invite.id}`)).status, 404);
  const adaCookie = joined.headers.get('set-cookie')?.split(';')[0];
  if (!adaCookie) throw new Error('missing invite session');
  const sessions = (await (await app.request('/api/users/ada/sessions', { headers: { cookie } })).json()) as { sessions: { id: string }[] };
  assert.ok(sessions.sessions.length >= 1);
  const signedOut = await app.request(`/api/users/ada/sessions/${sessions.sessions[0]!.id}`, {
    method: 'DELETE',
    headers: { cookie, 'x-larder-request': '1' },
  });
  assert.equal(signedOut.status, 200);
  const adaSession = (await (await app.request('/api/session', { headers: { cookie: adaCookie } })).json()) as { state: string };
  assert.equal(adaSession.state, 'login');
  const health = (await (await app.request('/api/health', { headers: { cookie } })).json()) as {
    shares: number;
    clam: string;
    uploads: { count: number };
    host: { memory: { usedBytes: number; totalBytes: number }; cpu: number | null; network: { rxBytesPerSec: number | null; txBytesPerSec: number | null } };
    roots: { low: boolean }[];
  };
  assert.equal(typeof health.shares, 'number');
  assert.ok(health.clam === 'installed' || health.clam === 'missing');
  assert.equal(typeof health.uploads.count, 'number');
  assert.ok(health.host.memory.totalBytes > 0);
  assert.ok(health.host.memory.usedBytes >= 0 && health.host.memory.usedBytes <= health.host.memory.totalBytes);
  assert.equal(typeof health.host.cpu, 'number');
  assert.equal(typeof health.host.network.rxBytesPerSec, 'number');
  assert.equal(typeof health.host.network.txBytesPerSec, 'number');
  assert.equal(typeof health.roots?.[0]?.low, 'boolean');
  const pending = (await (await app.request('/api/invites', json({ grants: { documents: 'view' }, admin: false, home: false, days: 7, note: 'later' }, cookie))).json()) as { id: string };
  const listedInvites = (await (await app.request('/api/invites', { headers: { cookie } })).json()) as { invites: { id: string; note: string }[] };
  assert.equal(listedInvites.invites.some((item) => item.id === pending.id && item.note === 'later'), true);
  assert.equal((await app.request(`/api/invites/${pending.id}`, { method: 'DELETE', headers: { cookie, 'x-larder-request': '1' } })).status, 200);
  const afterRevoke = (await (await app.request('/api/invites', { headers: { cookie } })).json()) as { invites: { id: string }[] };
  assert.equal(afterRevoke.invites.some((item) => item.id === pending.id), false);
  const mine = (await (await app.request('/api/users/ryan/sessions', { headers: { cookie } })).json()) as { sessions: { id: string; current: boolean }[] };
  assert.equal(mine.sessions.some((item) => item.current && item.id === cookie.slice('larder_session='.length)), true);
  const everywhere = (await (await app.request('/api/search?all=1&q=notes', { headers: { cookie } })).json()) as { results: { path: string; root: string }[] };
  assert.ok(everywhere.results.some((item) => item.path === 'notes.txt' && item.root === 'documents'));
  const activity = (await (await app.request('/api/activity?limit=2', { headers: { cookie } })).json()) as { entries: unknown[]; total: number };
  assert.ok(activity.total >= activity.entries.length);
  assert.ok(activity.entries.length <= 2);
  const docs = runtime().config.roots.find((item) => item.id === 'documents')?.path;
  assert.ok(docs);
  const oldTrash = path.join(docs, '.larder-trash');
  await fs.mkdir(oldTrash, { recursive: true });
  await fs.writeFile(path.join(oldTrash, 'olditem'), 'gone');
  await fs.writeFile(
    path.join(oldTrash, 'olditem.json'),
    JSON.stringify({ id: 'olditem', name: 'old.txt', originalPath: 'old.txt', deletedBy: 'ryan', deletedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), kind: 'file' }),
  );
  assert.equal((await app.request('/api/trash/policy', { method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'x-larder-request': '1' }, body: JSON.stringify({ days: 1 }) })).status, 200);
  const aged = (await (await app.request('/api/trash?root=documents', { headers: { cookie } })).json()) as { items: { name: string }[]; trashDays: number | null };
  assert.equal(aged.items.some((item) => item.name === 'old.txt'), false);
  assert.equal(aged.trashDays, 1);
  assert.equal((await app.request('/api/trash/policy', { method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'x-larder-request': '1' }, body: JSON.stringify({ days: null }) })).status, 200);
  const named = await app.request('/api/shares', json({ root: 'documents', path: 'notes.txt', address: 'saturday' }, cookie));
  assert.equal(named.status, 200);
  assert.match(await (await app.request('/s/saturday')).text(), /notes\.txt/);
  assert.equal((await app.request('/api/shares', json({ root: 'documents', path: 'notes.txt', address: 'a' }, cookie))).status, 400);
  assert.equal((await app.request('/api/shares', json({ root: 'documents', path: 'notes.txt', address: 'saturday' }, cookie))).status, 409);
  const about = (await (await app.request('/api/about', { headers: { cookie } })).json()) as { version: string };
  assert.match(about.version, /^\d+\.\d+\.\d+/);
  assert.equal((await app.request('/api/duration?root=documents&path=notes.txt', { headers: { cookie } })).status, 404);
  const grouped = await app.request('/api/groups', json({ name: 'Readers', grants: { documents: 'view' } }, cookie));
  assert.equal(grouped.status, 200);
  const readers = (await grouped.json()) as { id: string };
  assert.equal(readers.id, 'readers');
  assert.equal((await app.request('/api/users/guest', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json', 'x-larder-request': '1' }, body: JSON.stringify({ grants: {}, groups: [readers.id] }) })).status, 200);
  const guestIn = await app.request('/api/login', json({ username: 'guest', password: 'another-secret' }));
  const guestCookie = guestIn.headers.get('set-cookie')?.split(';')[0];
  if (!guestCookie) throw new Error('missing guest session');
  assert.equal((await app.request('/api/list?root=documents&path=', { headers: { cookie: guestCookie } })).status, 200);
  assert.equal((await app.request('/api/list?root=media&path=', { headers: { cookie: guestCookie } })).status, 404);
  assert.equal((await app.request(`/api/groups/${readers.id}`, { method: 'DELETE', headers: { cookie, 'x-larder-request': '1' } })).status, 200);
  assert.equal((await app.request('/api/list?root=documents&path=', { headers: { cookie: guestCookie } })).status, 404);
  assert.equal((await app.request('/api/users/guest', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json', 'x-larder-request': '1' }, body: JSON.stringify({ grants: { documents: 'view', media: 'edit' }, groups: [] }) })).status, 200);
  assert.equal((await app.request('/api/health', { headers: { cookie: guestCookie } })).status, 403);
  const otherLogin = await app.request('/api/login', json({ username: 'ryan', password: 'correct-horse' }));
  const otherCookie = otherLogin.headers.get('set-cookie')?.split(';')[0];
  if (!otherCookie) throw new Error('missing second session');
  const changed = await app.request('/api/password', json({ current: 'correct-horse', next: 'correct-horse-next' }, cookie));
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(changed.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
  const fresh = changed.headers.get('set-cookie')?.split(';')[0];
  if (!fresh) throw new Error('missing renewed session');
  assert.notEqual(fresh, cookie);
  assert.equal(((await (await app.request('/api/session', { headers: { cookie } })).json()) as { state: string }).state, 'login');
  assert.equal(((await (await app.request('/api/session', { headers: { cookie: otherCookie } })).json()) as { state: string }).state, 'login');
  assert.equal(((await (await app.request('/api/session', { headers: { cookie: fresh } })).json()) as { state: string }).state, 'ready');
  assert.equal((await app.request('/api/password', json({ current: 'correct-horse-next', next: 'correct-horse' }, fresh))).status, 200);
});
