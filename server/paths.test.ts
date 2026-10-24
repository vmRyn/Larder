import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { isInside, safeSegments, safeZipEntryName } from './paths.js';

test('relative paths stay inside a folder', () => {
  assert.deepEqual(safeSegments('photos/2024/a.jpg'), ['photos', '2024', 'a.jpg']);
  assert.deepEqual(safeSegments(''), []);
  assert.throws(() => safeSegments('../etc/passwd'));
  assert.throws(() => safeSegments('photos/../../etc/passwd'));
  assert.throws(() => safeSegments('/etc/passwd'));
  assert.throws(() => safeSegments('photos\\secret'));
  assert.equal(safeZipEntryName('album/cover.jpg'), 'album/cover.jpg');
  assert.equal(safeZipEntryName('../evil.txt'), null);
  assert.equal(safeZipEntryName('/tmp/evil.txt'), null);
  assert.equal(safeZipEntryName('C:/Windows/evil.txt'), null);
  const root = path.resolve('demo/documents');
  assert.equal(isInside(root, path.join(root, 'notes.txt')), true);
  assert.equal(isInside(root, path.resolve(root, '../media')), false);
});

function zipWith(name: string, data: Buffer): Buffer {
  const entry = Buffer.from(name);
  const crc = zlib.crc32(data);
  const u16 = (n: number) => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(n);
    return buf;
  };
  const u32 = (n: number) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(n >>> 0);
    return buf;
  };
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(entry.length), u16(0), entry, data,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(entry.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), entry,
  ]);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

test('extract refuses a zip that leaves the folder', async () => {
  const { initRuntime } = await import('./config.js');
  const { extractZip } = await import('./zip.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'larder-zip-'));
  const root = path.join(dir, 'root');
  await fs.mkdir(root);
  process.env.LARDER_CONFIG = path.join(dir, 'larder.config.json');
  await fs.writeFile(
    process.env.LARDER_CONFIG,
    JSON.stringify({
      host: '127.0.0.1',
      port: 0,
      sessionSecret: 'test-secret',
      maxUploadBytes: 1000,
      homes: { enabled: false, path: '' },
      roots: [{ id: 'documents', name: 'Documents', path: root }],
      users: [],
    }),
  );
  await initRuntime();
  await fs.writeFile(path.join(root, 'bad.zip'), zipWith('../escaped.txt', Buffer.from('no')));
  await assert.rejects(() => extractZip(root, 'bad.zip', 1000));
  await assert.rejects(() => fs.access(path.join(dir, 'escaped.txt')));
  await fs.writeFile(path.join(root, 'ok.zip'), zipWith('hello.txt', Buffer.from('yes')));
  const folder = await extractZip(root, 'ok.zip', 1000);
  const text = await fs.readFile(path.join(root, folder, 'hello.txt'), 'utf8');
  assert.equal(text, 'yes');
});
