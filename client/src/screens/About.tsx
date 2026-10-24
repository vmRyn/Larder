import { useEffect, useState } from 'react';
import { api } from '../api';

const shortcuts = [
  ['Enter', 'Open'],
  ['Backspace', 'Up one folder'],
  ['Delete', 'Move to trash'],
  ['F2', 'Rename'],
  ['Alt+Enter', 'Properties'],
  ['Ctrl+A', 'Select all'],
  ['Ctrl+C', 'Copy'],
  ['Ctrl+X', 'Cut'],
  ['Ctrl+V', 'Paste'],
  ['Escape', 'Clear the selection'],
  ['↑ ↓', 'Move the selection'],
];

export function About() {
  const [version, setVersion] = useState('');

  useEffect(() => {
    void api<{ version: string }>('/api/about')
      .then((data) => setVersion(data.version))
      .catch(() => setVersion(''));
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-lg flex-col gap-4">
        <div>
          <h2 className="text-lg">About</h2>
          <p className="mt-1 text-sm text-muted">Larder{version ? ` ${version}` : ''}</p>
        </div>
        <div className="flex flex-col gap-3 text-sm leading-6">
          <p>
            Larder is a file manager for the folders already on this computer. It runs on the machine that holds the files, and you open it in a browser, on that machine or another one on the network. There is no database and no second copy. What you configure is what you see.
          </p>
          <p>
            People sign in with their own account. Each person can look at a folder or change it, and can have a private vault named after them, such as Ryns Vault. Delete moves a file to trash. A link can share one file, or a folder as a zip, without giving someone an account.
          </p>
          <p>A shell stays in SSH. Larder does not open a terminal in the browser.</p>
        </div>
        <p className="text-sm text-muted">Created by Ryan (Ryn).</p>
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-sm text-muted [&::-webkit-details-marker]:hidden">
            Keyboard shortcuts
            <span className="font-mono transition-transform group-open:rotate-90" aria-hidden="true">›</span>
          </summary>
          <ul>
            {shortcuts.map(([keys, label]) => (
              <li key={keys} className="flex items-center justify-between gap-4 border-b border-line py-2 text-sm">
                <span>{label}</span>
                <span className="font-mono text-muted">{keys}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}
