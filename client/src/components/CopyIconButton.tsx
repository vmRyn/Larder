import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';

export function CopyIconButton({ value, label = 'Copy link' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      className={`copy-btn icon-btn grid size-8 shrink-0 place-items-center rounded-control ${copied ? 'is-copied bg-select' : 'bg-hover'}`}
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <span className="copy-btn-icon">
        <Icon name="copy" size={16} />
      </span>
      <span className="copy-btn-check" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M3.2 8.2 6.4 11.4 12.8 4.6" />
        </svg>
      </span>
    </button>
  );
}
