import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type Entry } from '../api';
import { baseName, formatBytes, formatStamp } from '../format';
import { CsvTable, MarkdownView } from '../rich';
import { Highlight, isCodeName } from '../highlight';

export function Preview({
  root,
  path,
  entry,
  canEdit,
  onClose,
  onSaved,
}: {
  root: string;
  path: string;
  entry: Entry | null;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const name = baseName(path);
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const textLike = ['txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'css', 'xml', 'yml', 'yaml', 'ini', 'conf', 'log', 'sh', 'py', 'go', 'rs', 'toml', 'csv', 'c', 'cpp', 'h', 'html', 'htm'].includes(ext);
  const image = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(ext);
  const code = isCodeName(name);
  const video = ['mp4', 'webm', 'ogv'].includes(ext);
  const audio = ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext);
  const pdf = ext === 'pdf';
  const query = `/api/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
  const [text, setText] = useState('');
  const [draft, setDraft] = useState('');
  const [mtime, setMtime] = useState<number | null>(entry?.mtime ?? null);
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(false);
  const [stick, setStick] = useState(true);
  const [hash, setHash] = useState('');
  const [hashing, setHashing] = useState(false);
  const [sizeLabel, setSizeLabel] = useState('');
  const [sizing, setSizing] = useState(false);
  const view = useRef<HTMLPreElement>(null);
  const [editing, setEditing] = useState(false);
  const tooBig = textLike && (entry?.size ?? 0) > 1024 * 1024;
  const editable = canEdit && textLike && (entry?.size ?? 0) <= 256 * 1024 && !follow;

  useEffect(() => {
    if (!textLike || tooBig || follow) return;
    let stop = false;
    setError('');
    setEditing(false);
    fetch(query)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          throw new Error(body.error ?? 'Could not open this file.');
        }
        return response.text();
      })
      .then((value) => {
        if (stop) return;
        setText(value);
        setDraft(value);
      })
      .catch((reason: Error) => {
        if (!stop) setError(reason.message);
      });
    return () => {
      stop = true;
    };
  }, [query, textLike, tooBig, follow]);

  useEffect(() => {
    if (!follow || !textLike) return;
    let stop = false;
    let offset = entry?.size ?? -1;
    const tick = async () => {
      try {
        const data = await api<{ text: string; size: number; offset: number; reset: boolean }>(
          `/api/follow?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&offset=${offset}`,
        );
        if (stop) return;
        setText((current) => {
          const next = offset < 0 || data.reset ? data.text : current + data.text;
          return next.length > 1024 * 1024 ? next.slice(-1024 * 1024) : next;
        });
        offset = data.size;
      } catch (reason) {
        if (!stop) setError(reason instanceof Error ? reason.message : 'Follow stopped.');
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [follow, textLike, root, path, entry?.size]);

  useEffect(() => {
    if (stick && view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [text, stick]);

  async function save() {
    try {
      const saved = await api<{ mtime: number }>('/api/content', {
        method: 'PUT',
        body: JSON.stringify({ root, path, text: draft, mtime }),
      });
      setText(draft);
      setMtime(saved.mtime);
      setError('');
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save.');
    }
  }

  async function checksum() {
    setHashing(true);
    setError('');
    try {
      const data = await api<{ sha256: string }>(`/api/checksum?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      setHash(data.sha256);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not hash this file.');
    } finally {
      setHashing(false);
    }
  }

  async function calculate() {
    setSizing(true);
    setError('');
    try {
      const data = await api<{ bytes: number; files: number }>(`/api/size?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      setSizeLabel(`${formatBytes(data.bytes)} · ${data.files.toLocaleString('en-GB')} files`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not calculate the size.');
    } finally {
      setSizing(false);
    }
  }

  const isDir = entry?.kind === 'dir' || entry?.symlinkTo === 'dir';

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-surface md:w-[420px]">
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <div className="truncate">{name}</div>
          <div className="font-mono text-xs text-muted">{entry?.mode ?? ''}</div>
        </div>
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="space-y-2 border-b border-line px-3 py-2 text-xs text-muted">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-ink">{path || name}</span>
          <button
            className="btn"
            type="button"
            onClick={() => void navigator.clipboard.writeText(path)}
          >
            Copy path
          </button>
        </div>
        <div>{formatStamp(mtime)}{entry?.size != null ? ` · ${formatBytes(entry.size)}` : ''}</div>
        {isDir && (
          <button className="btn" type="button" onClick={() => void calculate()} disabled={sizing}>
            {sizing ? 'Calculating…' : 'Calculate size'}
          </button>
        )}
        {sizeLabel && <div className="font-mono text-ink">{sizeLabel}</div>}
        {!isDir && (
          <button className="btn" type="button" onClick={() => void checksum()} disabled={hashing}>
            {hashing ? 'Hashing…' : 'SHA-256'}
          </button>
        )}
        {hash && (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-all font-mono text-ink">{hash}</span>
            <button className="btn" type="button" onClick={() => void navigator.clipboard.writeText(hash)}>
              Copy
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error && <p className="mb-2 text-danger">{error}</p>}
        {image && <img src={query} alt="" className="max-h-full max-w-full object-contain" />}
        {video && <video src={query} controls className="w-full" />}
        {audio && <audio src={query} controls className="w-full" />}
        {pdf && <iframe title={name} src={query} className="h-[60vh] w-full border-0" sandbox="allow-scripts allow-same-origin" />}
        {textLike && tooBig && <p>This file is over 1 MB. Download it to read the whole thing.</p>}
        {textLike && !tooBig && ext === 'md' && <MarkdownView text={text || draft} />}
        {textLike && !tooBig && ext === 'csv' && <CsvTable text={text || draft} />}
        {textLike && !tooBig && !editable && ext !== 'md' && ext !== 'csv' && (
          <div>
            <label className="mb-2 flex items-center gap-2 text-muted">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
              Follow
            </label>
            {!stick && (
              <button className="btn mb-2" type="button" onClick={() => setStick(true)}>
                Jump to end
              </button>
            )}
            <pre
              ref={view}
              className="max-h-[50vh] overflow-auto font-mono text-xs whitespace-pre-wrap"
              onScroll={(event) => {
                const el = event.currentTarget;
                setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
              }}
            >
              {code ? <Highlight text={text} ext={ext} /> : text}
            </pre>
          </div>
        )}
        {editable && code && !editing && (
          <div>
            <button className="btn mb-2" type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <pre className="max-h-[50vh] overflow-auto font-mono text-xs whitespace-pre-wrap">
              <Highlight text={draft || text} ext={ext} />
            </pre>
          </div>
        )}
        {editable && (!code || editing) && (
          <div className="flex h-full flex-col gap-2">
            <textarea className="field min-h-64 flex-1 py-2 font-mono text-xs" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <button className="btn btn-primary self-start" type="button" onClick={() => void save()} disabled={draft === text}>
              Save
            </button>
          </div>
        )}
        {!image && !video && !audio && !pdf && !textLike && <p>This file can be downloaded, not previewed.</p>}
      </div>
    </aside>
  );
}
